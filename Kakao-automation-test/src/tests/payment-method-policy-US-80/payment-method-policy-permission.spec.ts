import { test, expect } from '@fixtures/base.fixture';
import { allure } from 'allure-playwright';
import { makeStep } from '@utils/step';

/**
 * Quyền truy cập màn 결제수단 정책 (US080). Nguồn TC: input/Test_Cases_US080_EN_v1.md — mỗi dòng Steps N / Expected N map
 * đúng 1 step `Act: Step N` / `Assert: Expected N`. TC lệch UI thật → assert theo UI, ghi "Deviation from TC" trong
 * description (quyết định 28/09). TC_003 (tự duyệt) nằm ở payment-method-policy-approval.spec.ts. Chỉ đọc.
 */
test.describe('[Permission] 결제수단 정책 access', () => {
  test('TC_US080_001 — ADMIN holding SETTLEMENT_CONFIG writable opens the policy list', async ({ page, paymentMethodPolicyListPage: list, policyApi }) => {
    const step = makeStep(page);
    const settlementGroup = page.getByRole('link', { name: '정산 관리' });
    const settlementSubItem = page.getByRole('link', { name: '정산 데이터 다운로드', exact: true });
    let totalRows = 0;
    await allure.description(
      'As ADMIN, open the 정산 관리 menu group and go to 결제수단 정책: the list opens with the register rows and the 정책 추가 ' +
        'button. Deviation from TC (UI gap reported to BA): the 정산 관리 group expands but its sub-list holds only "정산 ' +
        '데이터 다운로드" — 결제수단 정책 is not linked in the sidebar yet — so step 2 opens the screen by its direct URL ' +
        '/commerce/payment-method-policies; the register holds more than the 7 seed rows, so the row count is read from the API.',
    );
    await allure.severity('critical');
    await allure.tags('regression', 'ui', 'permission', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_001');

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN with SETTLEMENT_CONFIG writable; register rows counted via API', async () => {
      totalRows = (await policyApi.list({}, 1000)).body.totalElements;
      await page.goto('/');
    });

    await step('Act: Step 1 — Open the 정산 관리 (Settlement management) menu in the side bar', async () => {
      await settlementGroup.click();
    });

    await step('Assert: Expected 1 — The menu group expands and shows its sub-list', async () => {
      await expect(settlementSubItem, '[Expected 1] 정산 관리 expands and shows its sub-list').toBeVisible();
    });

    await step('Act: Step 2 — Go to 결제수단 정책 (direct URL — the item is not linked in the sidebar)', async () => {
      await list.open();
    });

    await step('Assert: Expected 2 — The list opens with the register rows and the 정책 추가 button at the top', async () => {
      await expect(list.dataRows.first(), '[Expected 2] The table shows policy rows').toBeVisible();
      await expect(list.pagerTotalText, `[Expected 2] The list counts all ${totalRows} register rows`).toHaveText(new RegExp(`^총 ${totalRows}개의 항목 중`));
      await expect(list.addPolicyButton, '[Expected 2] 정책 추가 (Add policy) button is present').toBeVisible();
    });
  });

  test('TC_US080_002 — An account without SETTLEMENT_CONFIG gets 403 and no menu item', async () => {
    await allure.description(
      'Not automated: needs an account that does NOT hold SETTLEMENT_CONFIG — none is available (both test accounts are ' +
        'ADMIN), and the API contract states the SETTLEMENT_CONFIG guard is not built yet (see TC_US080_073).',
    );
    await allure.severity('critical');
    await allure.tags('permission', 'blocked', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_002');
    test.skip(true, 'No account without SETTLEMENT_CONFIG is available; the guard itself is not built yet (OQ-121)');
  });
});
