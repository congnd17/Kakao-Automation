import { test as base } from '@playwright/test';
import { LoginPage } from '@pages/login.page';
import { ContractListPage } from '@pages/contract-list.page';
import { ContractViewPage } from '@pages/contract-view.page';
import { ContractEditPage } from '@pages/contract-edit.page';
import { ContractCreatePage } from '@pages/contract-create.page';
import { UnitOfMeasureListPage } from '@pages/unit-of-measure-list.page';
import { UnitOfMeasureFormPage } from '@pages/unit-of-measure-form.page';
import { PaymentMethodPolicyListPage } from '@pages/payment-method-policy-list.page';
import { PaymentMethodPolicyFormPage } from '@pages/payment-method-policy-form.page';
import { ChangeApprovalQueuePage } from '@pages/change-approval-queue.page';
import { WarehouseListPage } from '@pages/warehouse-list.page';
import { WarehouseFormPage } from '@pages/warehouse-form.page';
import { PaymentMethodPolicyApi, openPaymentMethodPolicyApi } from '@api/payment-method-policy.api';
import { WarehouseApi, openWarehouseApi } from '@api/warehouse.api';
import { WarehouseCleanup } from '@utils/warehouse.data';
import { ContractFeePage } from '@pages/contract-fee.page';
import { ContractHistoryPage } from '@pages/contract-history.page';
import { FeeRateApi, openFeeRateApi } from '@api/fee-rate.api';
import { FeeRateContracts } from '@utils/fee-rate.data';
import { getValidSession, hasCredentials, toSessionCookies, UI_SESSION_BUFFER_MS } from '@utils/auth-token';
import { env } from '@utils/env.config';

type Fixtures = {
  loginPage: LoginPage;
  contractListPage: ContractListPage;
  contractViewPage: ContractViewPage;
  contractEditPage: ContractEditPage;
  contractCreatePage: ContractCreatePage;
  unitOfMeasureListPage: UnitOfMeasureListPage;
  unitOfMeasureFormPage: UnitOfMeasureFormPage;
  paymentMethodPolicyListPage: PaymentMethodPolicyListPage;
  paymentMethodPolicyFormPage: PaymentMethodPolicyFormPage;
  changeApprovalQueuePage: ChangeApprovalQueuePage;
  warehouseListPage: WarehouseListPage;
  warehouseFormPage: WarehouseFormPage;
  warehouseApi: WarehouseApi;
  warehouseCleanup: WarehouseCleanup;
  policyApi: PaymentMethodPolicyApi;
  approverPolicyApi: PaymentMethodPolicyApi;
  contractFeePage: ContractFeePage;
  contractHistoryPage: ContractHistoryPage;
  feeRateApi: FeeRateApi;
  feeRateContracts: FeeRateContracts;
  refreshSessionCookies: void;
  attachFinalScreenshot: void;
};

export const test = base.extend<Fixtures>({
  /**
   * auto: true — trước MỌI test đã đăng nhập sẵn (context có cookie `auth_token` từ storageState của setup-auth):
   * token account gốc còn dưới UI_SESSION_BUFFER_MS thì refresh qua Okta (ghi .env) và gắn 3 cookie mới vào context
   * TRƯỚC khi test mở trang — lần chạy dài hơn 60 phút không bị đăng xuất giữa chừng. Test chưa đăng nhập: bỏ qua.
   */
  refreshSessionCookies: [
    async ({ context }, use) => {
      const currentCookie = (await context.cookies()).find((cookie) => cookie.name === 'auth_token');
      if (currentCookie) {
        const tokens = await getValidSession('submitter', UI_SESSION_BUFFER_MS);
        if (tokens.authToken !== currentCookie.value) {
          await context.addCookies(toSessionCookies(tokens, env.baseURL));
        }
      }
      await use();
    },
    { auto: true },
  ],

  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },

  contractListPage: async ({ page }, use) => {
    await use(new ContractListPage(page));
  },

  contractViewPage: async ({ page }, use) => {
    await use(new ContractViewPage(page));
  },

  contractEditPage: async ({ page }, use) => {
    await use(new ContractEditPage(page));
  },

  contractCreatePage: async ({ page }, use) => {
    await use(new ContractCreatePage(page));
  },

  unitOfMeasureListPage: async ({ page }, use) => {
    await use(new UnitOfMeasureListPage(page));
  },

  unitOfMeasureFormPage: async ({ page }, use) => {
    await use(new UnitOfMeasureFormPage(page));
  },

  paymentMethodPolicyListPage: async ({ page }, use) => {
    await use(new PaymentMethodPolicyListPage(page));
  },

  paymentMethodPolicyFormPage: async ({ page }, use) => {
    await use(new PaymentMethodPolicyFormPage(page));
  },

  changeApprovalQueuePage: async ({ page }, use) => {
    await use(new ChangeApprovalQueuePage(page));
  },

  warehouseListPage: async ({ page }, use) => {
    await use(new WarehouseListPage(page));
  },

  warehouseFormPage: async ({ page }, use) => {
    await use(new WarehouseFormPage(page));
  },

  /** Client API register 창고 (account gốc) — dựng dữ liệu ở Arrange, đối chiếu ở Assert. */
  warehouseApi: async ({ playwright }, use) => {
    const { api, dispose } = await openWarehouseApi(playwright.request);
    await use(api);
    await dispose();
  },

  /** Warehouse do test tạo (qua API hoặc UI) — xoá hết ở teardown, kể cả khi test FAIL (môi trường dùng chung). */
  warehouseCleanup: async ({ warehouseApi }, use) => {
    const cleanup = new WarehouseCleanup(warehouseApi);
    await use(cleanup);
    await cleanup.dispose();
  },

  /** Client API (account gốc) cho test UI — dựng/đọc dữ liệu ở Arrange, đối chiếu số liệu, dọn dẹp ở teardown. */
  policyApi: async ({ playwright }, use) => {
    const { api, dispose } = await openPaymentMethodPolicyApi(playwright.request);
    await use(api);
    await dispose();
  },

  /** Client API account duyệt cho test UI — chưa cấu hình APPROVER_* trong .env → test tự skip. */
  approverPolicyApi: async ({ playwright }, use, testInfo) => {
    testInfo.skip(!hasCredentials('approver'), 'Approver account is not configured — set APPROVER_OKTA_REFRESH_TOKEN in .env');
    const { api, dispose } = await openPaymentMethodPolicyApi(playwright.request, 'approver');
    await use(api);
    await dispose();
  },

  contractFeePage: async ({ page }, use) => {
    await use(new ContractFeePage(page));
  },

  contractHistoryPage: async ({ page }, use) => {
    await use(new ContractHistoryPage(page));
  },

  /**
   * US078 chạy bằng account `approver` (dungbd.fpt — account duy nhất có COMMERCE_CONTRACTS, quyết định 28/09). Chưa cấu
   * hình APPROVER_* → test tự skip trước khi tạo dữ liệu.
   */
  feeRateApi: async ({ playwright }, use, testInfo) => {
    testInfo.skip(!hasCredentials('approver'), 'The contract-capable account (APPROVER_*) is not configured in .env');
    const { api, dispose } = await openFeeRateApi(playwright.request, 'approver');
    await use(api);
    await dispose();
  },

  /** Contract automation do test tạo — teardown rút lại mọi đơn còn 승인 대기 (contract không xoá được). */
  feeRateContracts: async ({ feeRateApi }, use) => {
    const contracts = new FeeRateContracts(feeRateApi);
    await use(contracts);
    await contracts.dispose();
  },

  // auto: true — chạy cho MỌI test, attach screenshot trạng thái cuối dù PASS hay FAIL
  attachFinalScreenshot: [
    async ({ page }, use, testInfo) => {
      await use();
      const isPassed = testInfo.status === testInfo.expectedStatus;
      const name = isPassed ? 'final_state' : 'state_at_failure';
      const screenshot = await page.screenshot({ fullPage: true });
      await testInfo.attach(name, { body: screenshot, contentType: 'image/png' });
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
