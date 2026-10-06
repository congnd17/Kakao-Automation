import { test as base } from '@fixtures/base.fixture';
import { ReceiptReconciliationApi, openReceiptReconciliationApi } from '@api/receipt-reconciliation.api';
import { ReceiptReconciliationListPage } from '@pages/receipt-reconciliation-list.page';
import { ReceiptReconciliationBuildPage } from '@pages/receipt-reconciliation-build.page';

/**
 * Fixture suite US020. Browser + API chạy bằng account gốc (congnd17.fpt) — mọi role như nhau trên hệ thống
 * (permission code INVENTORY_RECONCILIATION chưa cấp, TC [Permission] N/A). Không TC nào đang chạy được tạo nhóm hay khoá
 * kỳ (quyết định 30/09: không khoá tháng trên dev dùng chung); TC có bấm 대사 묶음 생성 tự kiểm số nhóm không đổi.
 */
type ReceiptReconciliationFixtures = {
  reconApi: ReceiptReconciliationApi;
  reconListPage: ReceiptReconciliationListPage;
  reconBuildPage: ReceiptReconciliationBuildPage;
};

export const test = base.extend<ReceiptReconciliationFixtures>({
  reconApi: async ({ playwright }, use) => {
    const { api, dispose } = await openReceiptReconciliationApi(playwright.request);
    await use(api);
    await dispose();
  },

  reconListPage: async ({ page }, use) => {
    await use(new ReceiptReconciliationListPage(page));
  },

  reconBuildPage: async ({ page }, use) => {
    await use(new ReceiptReconciliationBuildPage(page));
  },
});

export { expect } from '@playwright/test';
