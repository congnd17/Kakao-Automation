import { test as uiBase } from '@fixtures/base.fixture';
import { test as plainBase } from '@playwright/test';
import { openPurchaseOrderApi, PurchaseOrderApi } from '@api/purchase-order.api';
import { openWarehouseApi, WarehouseApi } from '@api/warehouse.api';
import { PurchaseOrderListPage } from '@pages/purchase-order-list.page';
import { PurchaseOrderFormPage } from '@pages/purchase-order-form.page';
import { BaseWarehouse, createBaseWarehouse, PoData } from '@utils/purchase-order.data';
import { getValidSession, hasCredentials, toSessionCookies, UI_SESSION_BUFFER_MS } from '@utils/auth-token';
import { env } from '@utils/env.config';
import type { Page } from '@playwright/test';

/** 공급처 mặc định cho PO do test tạo — 스타쉽엔터테인먼트 (id 1, ACTIVE, có tên ko + en; verify 05/10). */
export const DEFAULT_SUPPLIER_ID = 1;

type PoTestFixtures = {
  poApi: PurchaseOrderApi;
  approverPoApi: PurchaseOrderApi;
  poWarehouseApi: WarehouseApi;
  poData: PoData;
};

type PoWorkerFixtures = {
  /** Kho automation + mapping dùng chung cho mọi test của 1 worker (1 lần chạy). */
  poBase: BaseWarehouse;
};

type PoUiFixtures = {
  poList: PurchaseOrderListPage;
  poForm: PurchaseOrderFormPage;
  /** Browser thứ 2 đăng nhập bằng account APPROVER (khác danh tính) — TC 2 trình duyệt / maker ≠ checker. */
  approverPage: Page;
};

const poBaseFixture = [
  async ({ playwright }: { playwright: { request: Parameters<typeof openPurchaseOrderApi>[0] } }, use: (value: BaseWarehouse) => Promise<void>) => {
    const warehouse = await openWarehouseApi(playwright.request);
    const po = await openPurchaseOrderApi(playwright.request);
    const base = await createBaseWarehouse(warehouse.api, po.api);
    await use(base);
    await warehouse.dispose();
    await po.dispose();
  },
  { scope: 'worker' as const },
] as const;

/** Test UI US105 — browser đăng nhập bằng account gốc (storageState), API phụ dựng / đọc / dọn dữ liệu. */
export const test = uiBase.extend<PoTestFixtures & PoUiFixtures, PoWorkerFixtures>({
  poBase: poBaseFixture as never,

  poApi: async ({ playwright }, use) => {
    const { api, dispose } = await openPurchaseOrderApi(playwright.request);
    await use(api);
    await dispose();
  },

  approverPoApi: async ({ playwright }, use, testInfo) => {
    testInfo.skip(!hasCredentials('approver'), 'The second account (APPROVER_*) is not configured in .env');
    const { api, dispose } = await openPurchaseOrderApi(playwright.request, 'approver');
    await use(api);
    await dispose();
  },

  poWarehouseApi: async ({ playwright }, use) => {
    const { api, dispose } = await openWarehouseApi(playwright.request);
    await use(api);
    await dispose();
  },

  poData: async ({ poApi, playwright, poBase }, use) => {
    const other = hasCredentials('approver') ? await openPurchaseOrderApi(playwright.request, 'approver') : undefined;
    const data = new PoData(poApi, other?.api, poBase, DEFAULT_SUPPLIER_ID);
    await use(data);
    await data.dispose();
    await other?.dispose();
  },

  poList: async ({ page }, use) => {
    await use(new PurchaseOrderListPage(page));
  },

  poForm: async ({ page }, use) => {
    await use(new PurchaseOrderFormPage(page));
  },

  approverPage: async ({ browser }, use, testInfo) => {
    testInfo.skip(!hasCredentials('approver'), 'The second account (APPROVER_*) is not configured in .env');
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await context.addCookies(toSessionCookies(await getValidSession('approver', UI_SESSION_BUFFER_MS), env.baseURL));
    const page = await context.newPage();
    await use(page);
    const isPassed = testInfo.status === testInfo.expectedStatus;
    await testInfo.attach(isPassed ? 'final_state_approver' : 'state_at_failure_approver', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    await context.close();
  },
});

/**
 * Test API US105 — không mở browser. Bằng chứng cuối test là toàn bộ request/response (cả 2 account) đính kèm dạng
 * JSON, dù PASS hay FAIL — tương đương screenshot `final_state` của test UI.
 */
export const apiTest = plainBase.extend<PoTestFixtures & { attachApiLog: void }, PoWorkerFixtures>({
  poBase: poBaseFixture as never,

  poApi: async ({ playwright }, use) => {
    const { api, dispose } = await openPurchaseOrderApi(playwright.request);
    await use(api);
    await dispose();
  },

  approverPoApi: async ({ playwright }, use, testInfo) => {
    testInfo.skip(!hasCredentials('approver'), 'The second account (APPROVER_*) is not configured in .env');
    const { api, dispose } = await openPurchaseOrderApi(playwright.request, 'approver');
    await use(api);
    await dispose();
  },

  poWarehouseApi: async ({ playwright }, use) => {
    const { api, dispose } = await openWarehouseApi(playwright.request);
    await use(api);
    await dispose();
  },

  poData: async ({ poApi, playwright, poBase }, use) => {
    const other = hasCredentials('approver') ? await openPurchaseOrderApi(playwright.request, 'approver') : undefined;
    const data = new PoData(poApi, other?.api, poBase, DEFAULT_SUPPLIER_ID);
    await use(data);
    await data.dispose();
    await other?.dispose();
  },

  attachApiLog: [
    async ({ poApi }, use, testInfo) => {
      await use();
      const isPassed = testInfo.status === testInfo.expectedStatus;
      await testInfo.attach(isPassed ? 'final_state' : 'state_at_failure', {
        body: JSON.stringify(poApi.exchanges, null, 2),
        contentType: 'application/json',
      });
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
