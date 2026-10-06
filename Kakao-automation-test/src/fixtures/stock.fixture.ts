import { test as base } from '@fixtures/base.fixture';
import { StockApi, openStockApi } from '@api/stock.api';
import { openWarehouseApi } from '@api/warehouse.api';
import { StockListPage } from '@pages/stock-list.page';
import { AdjustmentDialog, ConversionDialog, IncomingDialog, StockHistoryDialog, WarehouseDetailDialog } from '@pages/stock-dialogs.page';
import { SkuFormPage, SkuMasterListPage, SkuSearchDialog } from '@pages/sku-form.page';
import { StockWorld } from '@utils/stock.data';
import { hasStockDb, stockDb } from '@utils/stock-db';

/**
 * Fixture suite US134 (재고 관리 + SKU master). Browser + API chạy bằng account gốc (congnd17.fpt — "bypass", có mọi
 * quyền; TC [Permission] cần account đúng role → skip). `stockWorld` dựng 1 lần cho cả lần chạy (worker scope, workers = 1):
 * kho automation + 12 SKU demo + tồn kho; teardown dọn hết. TC cần ghi dữ liệu tự tạo SKU riêng qua `stockWorld`.
 */
type StockFixtures = {
  stockApi: StockApi;
  stockListPage: StockListPage;
  incomingDialog: IncomingDialog;
  adjustmentDialog: AdjustmentDialog;
  conversionDialog: ConversionDialog;
  warehouseDetailDialog: WarehouseDetailDialog;
  stockHistoryDialog: StockHistoryDialog;
  skuFormPage: SkuFormPage;
  skuSearchDialog: SkuSearchDialog;
  skuMasterPage: SkuMasterListPage;
  world: StockWorld;
  stockTimeout: void;
};

type StockWorkerFixtures = {
  stockWorld: StockWorld;
};

export const test = base.extend<StockFixtures, StockWorkerFixtures>({
  stockWorld: [
    async ({ playwright }, use) => {
      if (!hasStockDb()) throw new Error('US134 seeds stock buckets through MySQL — set DB_HOST / DB_USER / DB_PASSWORD in .env');
      const stock = await openStockApi(playwright.request);
      const warehouse = await openWarehouseApi(playwright.request);
      const world = new StockWorld(stock.api, warehouse.api);
      try {
        await world.build();
        await use(world);
      } finally {
        await world.dispose();
        await stockDb.close();
        await stock.dispose();
        await warehouse.dispose();
      }
    },
    { scope: 'worker', timeout: 300_000 },
  ],

  /** auto: true — TC US134 chạy 2 lượt KO + EN với ảnh sau mỗi step: 30s mặc định của config không đủ. */
  stockTimeout: [
    async ({}, use, testInfo) => {
      testInfo.setTimeout(Math.max(testInfo.timeout, 180_000));
      await use();
    },
    { auto: true },
  ],

  world: async ({ stockWorld }, use) => {
    await use(stockWorld);
  },

  stockApi: async ({ playwright }, use) => {
    const { api, dispose } = await openStockApi(playwright.request);
    await use(api);
    await dispose();
  },

  stockListPage: async ({ page }, use) => {
    await use(new StockListPage(page));
  },

  incomingDialog: async ({ page }, use) => {
    await use(new IncomingDialog(page));
  },

  adjustmentDialog: async ({ page }, use) => {
    await use(new AdjustmentDialog(page));
  },

  conversionDialog: async ({ page }, use) => {
    await use(new ConversionDialog(page));
  },

  warehouseDetailDialog: async ({ page }, use) => {
    await use(new WarehouseDetailDialog(page));
  },

  stockHistoryDialog: async ({ page }, use) => {
    await use(new StockHistoryDialog(page));
  },

  skuFormPage: async ({ page }, use) => {
    await use(new SkuFormPage(page));
  },

  skuSearchDialog: async ({ page }, use) => {
    await use(new SkuSearchDialog(page));
  },

  skuMasterPage: async ({ page }, use) => {
    await use(new SkuMasterListPage(page));
  },
});

export { expect } from '@playwright/test';
