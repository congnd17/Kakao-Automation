import * as fs from 'fs';
import * as path from 'path';
import { env } from './env.config';

const ENV_PATH = path.resolve(process.cwd(), '.env');
const OKTA_SCOPE = 'openid profile email offline_access';

/**
 * Khoá file cho mỗi bộ key (`okta-refresh.lock` / `okta-refresh-approver.lock`) — dùng CHUNG với
 * scripts/keep-tokens-alive.js. Refresh token Okta chỉ dùng được 1 lần: 2 tiến trình cùng rotate 1 token làm Okta huỷ
 * cả chuỗi (invalid_grant). Lock quá STALE_LOCK_MS coi như tiến trình giữ nó đã chết.
 */
const LOCK_DIR = path.resolve(process.cwd(), 'reports', '.auth');
const LOCK_WAIT_MS = 30_000;
const LOCK_RETRY_MS = 200;
const STALE_LOCK_MS = 60_000;

export async function withRefreshLock<T>(prefix: string, work: () => Promise<T>): Promise<T> {
  const lockFile = path.join(LOCK_DIR, prefix ? `okta-refresh-${prefix.replace(/_$/, '').toLowerCase()}.lock` : 'okta-refresh.lock');
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
      break;
    } catch {
      const age = Date.now() - (fs.statSync(lockFile, { throwIfNoEntry: false })?.mtimeMs ?? 0);
      if (age > STALE_LOCK_MS) {
        fs.rmSync(lockFile, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Okta refresh lock ${lockFile} is still held after ${LOCK_WAIT_MS} ms`);
      // Chờ tiến trình khác rotate xong — backoff của khoá hạ tầng, không phải chờ UI trong test.
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  try {
    return await work();
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}

export interface RefreshedOktaTokens {
  authToken: string;
  authIdToken: string;
  authTokenExpires: string;
  refreshToken: string;
}

/**
 * token_expires lưu dạng epoch millisecond (khớp định dạng cookie thật của app) — hết hạn hoặc
 * còn dưới `bufferMs` thì coi là cần refresh, tránh vừa refresh xong đã hết hạn giữa lúc test chạy.
 */
export function isTokenExpiredOrNear(expiresAtMs: string, bufferMs = 20 * 60_000): boolean {
  const expires = Number(expiresAtMs);
  if (!expires) return true;
  return Date.now() >= expires - bufferMs;
}

/**
 * Gọi thẳng Okta token endpoint bằng refresh_token (Okta Auth JS SDK lưu ở
 * localStorage["okta-token-storage"]) để mint access_token/id_token mới — không cần đăng nhập lại
 * qua UI. Refresh token của Okta xoay vòng (rotating): mỗi lần dùng, token cũ mất hiệu lực và một
 * token mới được cấp — PHẢI lưu lại refresh_token mới ngay, nếu không lần sau sẽ refresh thất bại.
 */
export async function refreshOktaTokens(refreshToken: string): Promise<RefreshedOktaTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: env.oktaClientId,
    scope: OKTA_SCOPE,
  });

  const response = await fetch(`${env.oktaIssuer}/oauth2/v1/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Okta token refresh failed (HTTP ${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    id_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    authToken: data.access_token,
    authIdToken: data.id_token,
    authTokenExpires: String(Date.now() + data.expires_in * 1000),
    refreshToken: data.refresh_token,
  };
}

/**
 * Ghi token mới (kể cả refresh_token đã xoay vòng) trở lại .env để lần chạy sau vẫn dùng được.
 * `prefix` chọn bộ key của account (`''` = account gốc, `APPROVER_` = account duyệt) — mỗi account xoay vòng riêng.
 */
export function persistTokensToEnv(tokens: RefreshedOktaTokens, prefix = ''): void {
  let content = fs.readFileSync(ENV_PATH, 'utf-8');

  const setKey = (key: string, value: string) => {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    content = pattern.test(content) ? content.replace(pattern, line) : `${content.trimEnd()}\n${line}\n`;
  };

  setKey(`${prefix}AUTH_TOKEN`, tokens.authToken);
  setKey(`${prefix}AUTH_ID_TOKEN`, tokens.authIdToken);
  setKey(`${prefix}AUTH_TOKEN_EXPIRES`, tokens.authTokenExpires);
  setKey(`${prefix}OKTA_REFRESH_TOKEN`, tokens.refreshToken);

  fs.writeFileSync(ENV_PATH, content, 'utf-8');
}
