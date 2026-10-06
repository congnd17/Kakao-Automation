import { test as base } from '@playwright/test';
import { ReceiptReconciliationApi, openReceiptReconciliationApi } from '@api/receipt-reconciliation.api';

type ReceiptReconciliationApiFixtures = {
  reconApi: ReceiptReconciliationApi;
  attachApiLog: void;
};

/**
 * Fixture cho test [API] US020 — không mở browser. Bằng chứng cuối test là toàn bộ request/response đã gọi
 * (tương đương screenshot `final_state` ở test UI), đính kèm dù PASS hay FAIL.
 */
export const test = base.extend<ReceiptReconciliationApiFixtures>({
  reconApi: async ({ playwright }, use) => {
    const { api, dispose } = await openReceiptReconciliationApi(playwright.request);
    await use(api);
    await dispose();
  },

  attachApiLog: [
    async ({ reconApi }, use, testInfo) => {
      await use();
      const isPassed = testInfo.status === testInfo.expectedStatus;
      await testInfo.attach(isPassed ? 'final_state' : 'state_at_failure', {
        body: JSON.stringify(reconApi.exchanges, null, 2),
        contentType: 'application/json',
      });
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
