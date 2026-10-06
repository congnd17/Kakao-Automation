import { test } from '@fixtures/stock.fixture';
import { skipTc } from '@utils/tc-meta';
import { PERMISSION_SKIP_REASON, stockTags } from '@utils/stock-spec';

/**
 * US134 — nhóm [Permission] (TC_US134_01–06). Cả 6 TC ở trạng thái BLOCKED trong file TC v18 và cần account đúng role
 * (INVENTORY_OPERATOR có quyền ghi, ADMIN/MANAGER chỉ đọc, account không có permission code). Account automation
 * (congnd17.fpt) là account bypass có mọi quyền → không chứng minh được giới hạn theo role: khai báo đủ metadata + skip.
 */
const TAGS = stockTags('permission');

test.describe('[Permission] Stock management — role-based access', () => {
  test('TC_US134_01 — An INVENTORY_OPERATOR who can write sees all 7 actions left on Stock management', async () => {
    await skipTc('TC_US134_01', 'High', TAGS, 'An INVENTORY_OPERATOR with write access opens 재고 관리 from 물류 관리 and sees the 7 remaining actions; the 3 SKU create buttons and SKU 생성 업로드 are not on this screen.', PERMISSION_SKIP_REASON);
  });

  test('TC_US134_02 — An ADMIN account has read-only access to Stock management', async () => {
    await skipTc('TC_US134_02', 'High', TAGS, 'An ADMIN account holding the stock permission code with the read-only flag can read the list but no write action is offered.', PERMISSION_SKIP_REASON);
  });

  test('TC_US134_03 — A read-only account reads the list and stock history while the 7 write buttons are hidden', async () => {
    await skipTc('TC_US134_03', 'High', TAGS, 'A MANAGER account (read-only flag) can read the stock list and the stock history, while the 7 write buttons on the screen are hidden.', PERMISSION_SKIP_REASON);
  });

  test('TC_US134_04 — An account without the stock permission code cannot see Stock management', async () => {
    await skipTc('TC_US134_04', 'High', TAGS, 'An account without the stock permission code sees no 재고 관리 menu and is refused by the screen and its calls.', PERMISSION_SKIP_REASON);
  });

  test('TC_US134_05 — Stock management and SKU Master Management follow the same permission-based visibility rule', async () => {
    await skipTc('TC_US134_05', 'High', TAGS, 'A writer, a read-only MANAGER and an account with no stock permission code see Stock management and SKU Master Management under the same rule.', PERMISSION_SKIP_REASON);
  });

  test('TC_US134_06 — A read-only account sees product codes as plain text and no SKU create button', async () => {
    await skipTc('TC_US134_06', 'Medium', TAGS, 'A MANAGER account (read-only flag) sees 상품코드 as plain text (no link to the SKU form) and no SKU create button.', PERMISSION_SKIP_REASON);
  });
});
