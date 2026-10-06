import { test as base } from '@playwright/test';
import { PaymentMethodPolicyApi, openPaymentMethodPolicyApi } from '@api/payment-method-policy.api';
import { hasCredentials } from '@utils/auth-token';

type ApiFixtures = {
  paymentMethodPolicyApi: PaymentMethodPolicyApi;
  approverApi: PaymentMethodPolicyApi;
  attachApiLog: void;
};

/**
 * Fixture cho test API — không mở browser. Bằng chứng cuối test là toàn bộ request/response đã gọi
 * (tương đương screenshot `final_state` ở test UI), đính kèm dù PASS hay FAIL.
 */
export const test = base.extend<ApiFixtures>({
  paymentMethodPolicyApi: async ({ playwright }, use) => {
    const { api, dispose } = await openPaymentMethodPolicyApi(playwright.request);
    await use(api);
    await dispose();
  },

  /**
   * Client API của account duyệt (role APPROVER, khác danh tính người nộp) — chỉ khởi tạo khi test khai báo dùng.
   * Chưa cấu hình APPROVER_OKTA_REFRESH_TOKEN / APPROVER_AUTH_TOKEN trong .env → test tự skip, không fail.
   */
  approverApi: async ({ playwright }, use, testInfo) => {
    testInfo.skip(!hasCredentials('approver'), 'Approver account is not configured — set APPROVER_OKTA_REFRESH_TOKEN in .env');
    const { api, dispose } = await openPaymentMethodPolicyApi(playwright.request, 'approver');
    await use(api);
    const isPassed = testInfo.status === testInfo.expectedStatus;
    await testInfo.attach(isPassed ? 'final_state_approver' : 'state_at_failure_approver', {
      body: JSON.stringify(api.exchanges, null, 2),
      contentType: 'application/json',
    });
    await dispose();
  },

  attachApiLog: [
    async ({ paymentMethodPolicyApi }, use, testInfo) => {
      await use();
      const isPassed = testInfo.status === testInfo.expectedStatus;
      const name = isPassed ? 'final_state' : 'state_at_failure';
      await testInfo.attach(name, {
        body: JSON.stringify(paymentMethodPolicyApi.exchanges, null, 2),
        contentType: 'application/json',
      });
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
