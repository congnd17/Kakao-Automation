// Keep-alive refresh token Okta — gọi POST {OKTA_ISSUER}/oauth2/v1/token (grant_type=refresh_token) cho MỌI account có
// refresh_token trong .env (account gốc + APPROVER_*), rotate và ghi token mới về đúng bộ key. Chuỗi refresh token chết
// nếu để lâu không dùng (~1 giờ, quan sát 28/09; 29/09 có chuỗi chết sau ~50 phút) → mặc định chạy mỗi 20 phút
// (đổi bằng KEEP_ALIVE_MINUTES trong .env / biến môi trường) để giữ nó sống giữa các lần chạy test.
//
//   node scripts/keep-tokens-alive.js          → chạy 1 lần (dùng cho Windows Task Scheduler / cron)
//   node scripts/keep-tokens-alive.js --watch  → chạy ngay rồi lặp mỗi KEEP_ALIVE_MINUTES phút tới khi dừng (Ctrl+C)
//
// Dùng CHUNG khoá file với src/utils/okta-refresh.ts (reports/.auth/okta-refresh*.lock): test và keep-alive không bao
// giờ rotate cùng 1 token cùng lúc. Chuỗi đã chết (invalid_grant) thì không tự hồi sinh được — script ghi log, thoát mã 1.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const LOCK_DIR = path.join(ROOT, 'reports', '.auth');
const LOG_FILE = path.join(ROOT, 'reports', 'logs', 'keep-tokens-alive.log');
const LOCK_WAIT_MS = 30_000;
const STALE_LOCK_MS = 60_000;
const ACCOUNTS = [
  { role: 'submitter', prefix: '' },
  { role: 'approver', prefix: 'APPROVER_' },
];

const dotenv = require(path.join(ROOT, 'node_modules', 'dotenv'));
const readEnv = () => dotenv.parse(fs.readFileSync(ENV_PATH, 'utf8'));
function readEnvSafe() {
  try {
    return readEnv();
  } catch {
    return {};
  }
}
const INTERVAL_MS = (Number(process.env.KEEP_ALIVE_MINUTES || readEnvSafe().KEEP_ALIVE_MINUTES) || 20) * 60_000;

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
  console.log(line);
}

function accountName(idToken) {
  try {
    const claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    return (claims.email || claims.preferred_username || claims.sub || '?').split('@')[0];
  } catch {
    return '?';
  }
}

function persist(prefix, tokens) {
  let content = fs.readFileSync(ENV_PATH, 'utf8');
  for (const [key, value] of Object.entries(tokens)) {
    const line = `${prefix}${key}=${value}`;
    const pattern = new RegExp(`^${prefix}${key}=.*$`, 'm');
    content = pattern.test(content) ? content.replace(pattern, line) : `${content.trimEnd()}\n${line}\n`;
  }
  fs.writeFileSync(ENV_PATH, content, 'utf8');
}

async function withLock(prefix, work) {
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
      if (Date.now() > deadline) throw new Error(`lock ${lockFile} still held after ${LOCK_WAIT_MS} ms`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  try {
    return await work();
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}

async function refreshAccount({ role, prefix }) {
  const env = readEnv();
  if (!env[`${prefix}OKTA_REFRESH_TOKEN`]) return { role, status: 'skipped (no refresh token)' };
  return withLock(prefix, async () => {
    const refreshToken = readEnv()[`${prefix}OKTA_REFRESH_TOKEN`];
    const response = await fetch(`${env.OKTA_ISSUER || 'https://kakaoent.okta.com'}/oauth2/v1/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: env.OKTA_CLIENT_ID || '0oas1vvm51SaMtcMF697',
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: 'openid profile email offline_access',
      }).toString(),
    });
    if (!response.ok) return { role, status: `FAILED HTTP ${response.status} ${(await response.text()).slice(0, 160)}`, failed: true };
    const data = await response.json();
    persist(prefix, {
      AUTH_TOKEN: data.access_token,
      AUTH_ID_TOKEN: data.id_token,
      AUTH_TOKEN_EXPIRES: String(Date.now() + data.expires_in * 1000),
      OKTA_REFRESH_TOKEN: data.refresh_token,
    });
    return { role, status: `refreshed (${accountName(data.id_token)}), access token valid ${Math.round(data.expires_in / 60)} min` };
  });
}

async function runOnce() {
  let failed = false;
  for (const account of ACCOUNTS) {
    const result = await refreshAccount(account).catch((error) => ({ role: account.role, status: `FAILED ${error.message}`, failed: true }));
    failed ||= !!result.failed;
    log(`[${result.role}] ${result.status}`);
  }
  return failed;
}

(async () => {
  const failed = await runOnce();
  if (!process.argv.includes('--watch')) process.exit(failed ? 1 : 0);
  log(`watch mode — next refresh every ${INTERVAL_MS / 60_000} min`);
  setInterval(() => void runOnce(), INTERVAL_MS);
})();
