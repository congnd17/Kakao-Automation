import { test as base } from '@playwright/test';
import { WarehouseApi, openWarehouseApi } from '@api/warehouse.api';
import { WarehouseCleanup } from '@utils/warehouse.data';

type WarehouseApiFixtures = {
  warehouseApi: WarehouseApi;
  warehouseCleanup: WarehouseCleanup;
  attachApiLog: void;
};

/**
 * Fixture cho test API register 창고 (US069) — không mở browser. Bằng chứng cuối test là toàn bộ request/response đã gọi
 * (tương đương screenshot `final_state` ở test UI), đính kèm dù PASS hay FAIL. Warehouse test tạo ra bị xoá ở teardown.
 */
export const test = base.extend<WarehouseApiFixtures>({
  warehouseApi: async ({ playwright }, use) => {
    const { api, dispose } = await openWarehouseApi(playwright.request);
    await use(api);
    await dispose();
  },

  warehouseCleanup: async ({ warehouseApi }, use) => {
    const cleanup = new WarehouseCleanup(warehouseApi);
    await use(cleanup);
    await cleanup.dispose();
  },

  attachApiLog: [
    async ({ warehouseApi }, use, testInfo) => {
      await use();
      const isPassed = testInfo.status === testInfo.expectedStatus;
      await testInfo.attach(isPassed ? 'final_state' : 'state_at_failure', {
        body: JSON.stringify(warehouseApi.exchanges, null, 2),
        contentType: 'application/json',
      });
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
