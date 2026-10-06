import { test, Page } from '@playwright/test';
import { AccountRole, getValidSession, hasCredentials, toSessionCookies, UI_SESSION_BUFFER_MS } from './auth-token';
import { env } from './env.config';

/**
 * Đổi account đăng nhập ngay trên tab hiện tại — tương đương "logout rồi login account khác" nhưng KHÔNG bấm
 * logout: Okta logout thu hồi refresh_token của account cũ, lần chạy sau sẽ invalid_grant.
 * Thay 3 cookie phiên, xoá storage của app (tránh sót trạng thái account cũ) rồi reload trang đang mở.
 *
 * Hiện thành 1 sub-step trong report — đặt bên trong `Act: Step N`, không làm step top-level.
 * Test dùng account `approver` phải tự skip từ đầu khi chưa cấu hình:
 * `test.skip(!hasCredentials('approver'), ...)` — tránh skip giữa chừng sau khi đã ghi dữ liệu.
 */
export async function switchAccount(page: Page, role: AccountRole): Promise<void> {
  await test.step(`Switch the browser session to the ${role} account`, async () => {
    if (!hasCredentials(role)) {
      throw new Error(`The ${role} account is not configured in .env — cannot switch the session.`);
    }
    const tokens = await getValidSession(role, UI_SESSION_BUFFER_MS);
    const context = page.context();
    if (page.url().startsWith('http')) {
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
    }
    await context.clearCookies();
    await context.addCookies(toSessionCookies(tokens, env.baseURL));
    if (page.url().startsWith('http')) {
      await page.reload();
    }
  });
}
