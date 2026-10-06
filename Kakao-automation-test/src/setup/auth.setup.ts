import { test as setup } from '@playwright/test';
import { env } from '@utils/env.config';
import { logger } from '@utils/logger';
import { currentSession, hasCredentials, hasRefreshToken, refreshSession, toSessionCookies } from '@utils/auth-token';
import { AUTH_STORAGE_STATE } from './constants';

// Xác nhận qua DevTools > Application > Cookies trên phiên đăng nhập Okta SSO thật:
// phiên hợp lệ cần đủ 3 cookie "auth_token" + "id_token" + "token_expires" trên domain cha ".berriz.in"
// (không phải "access_token" trên hostname con — đó là access token JWT, không phải cookie thật của app).
//
// Có OKTA_REFRESH_TOKEN (lấy từ localStorage["okta-token-storage"] sau khi đăng nhập Okta thật) thì token được
// refresh qua Okta token endpoint, xoay vòng và ghi lại vào .env — trong khoá dùng chung với
// scripts/keep-tokens-alive.js (keep-alive mỗi 50 phút giữ chuỗi refresh token không chết vì để lâu).
setup('Create a logged-in session from the saved auth_token/id_token', async ({ context }) => {
  setup.skip(!hasCredentials('submitter'), 'AUTH_TOKEN or OKTA_REFRESH_TOKEN is not set in .env — skipping session setup.');

  // Luôn refresh khi có refresh_token (không chờ tới ngưỡng sắp hết hạn) — mỗi lần chạy bắt đầu với đủ 60
  // phút, tránh suite hết hạn token giữa chừng khi khởi động lúc token chỉ còn ~20 phút.
  let session = currentSession('submitter');
  if (hasRefreshToken('submitter')) {
    logger.info('Refresh auth_token qua Okta bằng refresh_token đã lưu trước khi chạy suite.');
    session = await refreshSession('submitter');
    logger.info(`Refresh Okta token thành công — hết hạn lúc ${new Date(Number(session.authTokenExpires)).toISOString()}`);
  }

  // Account duyệt (APPROVER_*): refresh luôn ở đầu mỗi lần chạy nếu đã cấu hình — token chết thì fail NGAY tại đây,
  // trước khi test nào kịp ghi dữ liệu (VD submit xong mới switchAccount sang approver thì để lại request treo).
  // Kèm theo: APPROVER_AUTH_ID_TOKEN luôn mới → getAccountDisplayName('approver') đọc đúng tên người duyệt.
  if (hasRefreshToken('approver')) {
    logger.info('Refresh token của account duyệt (APPROVER_*) trước khi chạy suite.');
    const approver = await refreshSession('approver');
    logger.info(`Refresh account duyệt thành công — hết hạn lúc ${new Date(Number(approver.authTokenExpires)).toISOString()}`);
  }

  await context.addCookies(toSessionCookies(session, env.baseURL));
  await context.storageState({ path: AUTH_STORAGE_STATE });
});
