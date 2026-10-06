import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { isTokenExpiredOrNear, refreshOktaTokens, persistTokensToEnv, RefreshedOktaTokens, withRefreshLock } from './okta-refresh';
import { logger } from './logger';

const ENV_PATH = path.resolve(process.cwd(), '.env');

/** `submitter` = account gốc (SETTLEMENT_CONFIG writable); `approver` = account giữ role APPROVER, khác danh tính. */
export type AccountRole = 'submitter' | 'approver';

/** Tiền tố key trong .env theo account — submitter giữ key gốc để các test hiện có không đổi gì. */
const ENV_PREFIX: Record<AccountRole, string> = { submitter: '', approver: 'APPROVER_' };

export type SessionTokens = Omit<RefreshedOktaTokens, 'refreshToken'>;

/** Đệm 20 phút như setup-auth — phiên UI không hết hạn giữa lúc 1 test đang chạy. */
export const UI_SESSION_BUFFER_MS = 20 * 60_000;

/**
 * Đọc lại .env trên đĩa ở MỖI lần gọi, không dùng process.env — worker Playwright kế thừa process.env từ
 * lúc bắt đầu chạy, trong khi setup-auth (và chính hàm này) ghi token đã xoay vòng vào .env sau đó.
 * Dùng process.env ở đây sẽ gửi refresh_token cũ đã mất hiệu lực → invalid_grant.
 */
function readEnvFile(): Record<string, string> {
  return dotenv.parse(fs.readFileSync(ENV_PATH, 'utf-8'));
}

/** Account đã được cấu hình trong .env chưa (có refresh_token hoặc access token). */
export function hasCredentials(role: AccountRole): boolean {
  const fileEnv = readEnvFile();
  const prefix = ENV_PREFIX[role];
  return !!(fileEnv[`${prefix}OKTA_REFRESH_TOKEN`] || fileEnv[`${prefix}AUTH_TOKEN`]);
}

/**
 * Tên account như UI hiển thị (VD `congnd17.fpt` ở header, cột 기안자, banner 회수) — phần trước `@` của email trong
 * id_token hiện có trong .env. Gọi TRONG thân test (sau setup-auth), không gọi lúc nạp file: đổi refresh token sang
 * account khác thì id_token cũ trong .env chỉ được thay khi setup-auth refresh.
 */
export function getAccountDisplayName(role: AccountRole = 'submitter'): string {
  const fileEnv = readEnvFile();
  const prefix = ENV_PREFIX[role];
  const token = fileEnv[`${prefix}AUTH_ID_TOKEN`] || fileEnv[`${prefix}AUTH_TOKEN`];
  if (!token) {
    throw new Error(`.env has no ${prefix}AUTH_ID_TOKEN — refresh the ${role} session first (setup-auth).`);
  }
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8')) as {
    email?: string;
    preferred_username?: string;
    sub?: string;
  };
  const login = claims.email ?? claims.preferred_username ?? claims.sub;
  if (!login) throw new Error(`The ${role} token carries no email/preferred_username/sub claim.`);
  return login.split('@')[0];
}

/**
 * Bộ token còn hạn của account — tự refresh qua Okta khi token còn dưới `bufferMs` và ghi token đã xoay vòng
 * về đúng bộ key của account đó.
 */
export async function getValidSession(role: AccountRole = 'submitter', bufferMs = 2 * 60_000): Promise<SessionTokens> {
  const current = currentSession(role);
  if (!isTokenExpiredOrNear(current.authTokenExpires, bufferMs)) {
    return current;
  }
  const prefix = ENV_PREFIX[role];
  if (!readEnvFile()[`${prefix}OKTA_REFRESH_TOKEN`]) {
    throw new Error(`${prefix}AUTH_TOKEN has expired and .env has no ${prefix}OKTA_REFRESH_TOKEN to refresh it.`);
  }
  logger.info(`Access token của account ${role} đã/sắp hết hạn — tự động refresh qua Okta.`);
  return refreshSession(role);
}

/** Bộ token đang lưu trong .env của account — KHÔNG refresh (dùng cho chế độ chỉ có cookie, không có refresh_token). */
export function currentSession(role: AccountRole): SessionTokens {
  const fileEnv = readEnvFile();
  const prefix = ENV_PREFIX[role];
  return {
    authToken: fileEnv[`${prefix}AUTH_TOKEN`] ?? '',
    authIdToken: fileEnv[`${prefix}AUTH_ID_TOKEN`] ?? '',
    authTokenExpires: fileEnv[`${prefix}AUTH_TOKEN_EXPIRES`] ?? '',
  };
}

/** Account có refresh_token trong .env không — điều kiện để refresh được (khác hasCredentials: chỉ có AUTH_TOKEN là không đủ). */
export function hasRefreshToken(role: AccountRole): boolean {
  return !!readEnvFile()[`${ENV_PREFIX[role]}OKTA_REFRESH_TOKEN`];
}

/**
 * Refresh NGAY qua Okta (không xét hạn còn lại) và ghi token đã xoay vòng về đúng bộ key của account — chạy trong khoá
 * dùng chung với scripts/keep-tokens-alive.js. Nếu trong lúc chờ khoá tiến trình khác đã rotate xong (refresh_token
 * trong .env đã đổi), dùng luôn bộ token mới đó thay vì rotate thêm lần nữa.
 */
export async function refreshSession(role: AccountRole): Promise<SessionTokens> {
  const prefix = ENV_PREFIX[role];
  const tokenBeforeLock = readEnvFile()[`${prefix}OKTA_REFRESH_TOKEN`];
  if (!tokenBeforeLock) {
    throw new Error(`.env has no ${prefix}OKTA_REFRESH_TOKEN to refresh the ${role} account.`);
  }
  return withRefreshLock(prefix, async () => {
    if (readEnvFile()[`${prefix}OKTA_REFRESH_TOKEN`] !== tokenBeforeLock) return currentSession(role);
    const refreshed = await refreshOktaTokens(tokenBeforeLock);
    persistTokensToEnv(refreshed, prefix);
    return refreshed;
  });
}

/**
 * Access token hợp lệ cho header `Authorization: Bearer` của API — tự refresh qua Okta khi token còn dưới
 * `bufferMs`, nên test API không bị giới hạn bởi thời hạn 60 phút của 1 access token.
 */
export async function getValidAccessToken(bufferMs = 2 * 60_000, role: AccountRole = 'submitter'): Promise<string> {
  return (await getValidSession(role, bufferMs)).authToken;
}

/**
 * 3 cookie phiên đăng nhập của app trên domain cha (VD `.berriz.in`) — cùng định dạng src/setup/auth.setup.ts tạo
 * cho account gốc.
 */
export function toSessionCookies(tokens: SessionTokens, baseURL: string) {
  const hostname = new URL(baseURL).hostname;
  const domain = `.${hostname.split('.').slice(-2).join('.')}`;
  const cookie = (name: string, value: string) => ({
    name,
    value,
    domain,
    path: '/',
    secure: true,
    sameSite: 'Strict' as const,
  });
  return [
    cookie('auth_token', tokens.authToken),
    cookie('id_token', tokens.authIdToken),
    cookie('token_expires', tokens.authTokenExpires),
  ];
}
