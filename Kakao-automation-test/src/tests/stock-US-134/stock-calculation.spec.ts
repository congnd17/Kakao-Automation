import { test, expect } from '@fixtures/stock.fixture';
import type { Locator } from '@playwright/test';
import { makeStep } from '@utils/step';
import { skipTc, tcMeta } from '@utils/tc-meta';
import { stx } from '@utils/stock.i18n';
import { WORLD_NOTE, stockTags } from '@utils/stock-spec';
import { stockDb } from '@utils/stock-db';
import type { StockWorld } from '@utils/stock.data';
import type { WarehouseDetailDialog } from '@pages/stock-dialogs.page';
import {
  NUMERIC_COLUMNS,
  StockCalculationPage,
  isNegativeNumber,
  ownPhysicalSku,
  ownGroupName,
  seedIncoming,
  toNumber,
} from '@pages/stock-calculation.page';

/**
 * US134 — nhóm [Stock Quantity Calculation] (TC_US134_71–92). Các cột dựa trên ngăn tồn kho (전체 / 할당 / 가용 / CS / 보류)
 * và quy tắc hiển thị (관리안함 / "-" / định dạng số / không âm) được dựng bằng dữ liệu world hoặc SKU riêng seed qua DB;
 * 입고예정수량 dựng bằng phiếu 입고 chèn DB trên SKU riêng. Cột lấy từ đơn hàng commerce (할당대기재고, 미확보 출고수량,
 * CS 재배송, đơn hoàn tất / hoàn tiền) không tạo được từ admin này → skip kèm lý do.
 */
const TAGS = stockTags('calculation');

const ORDER_DATA_REASON =
  'Needs commerce order data (order lines by status, completed / refunded orders, shipping-wait or CS re-delivery outbound lines) that cannot be created from this admin or seeded in the settlement schema — the order-derived figures come from KakaoEnt BRZ-14801 / the interim mock, so the expected values cannot be built from seeded stock buckets.';

const NOT_MANAGED = stx('label.notManaged', 'ko');

/** Đọc CS재고 관리여부 của dòng đang tick qua dialog 창고별 상세 (chỉ đọc, đóng bằng 취소, bỏ tick lại). */
async function readCsFlag(list: StockCalculationPage, dialog: WarehouseDetailDialog, row: Locator): Promise<string> {
  await list.tick(row, 'to read its CS stock managed flag');
  await list.clickToolbar('btn.warehouseDetail');
  await dialog.waitOpen('ko');
  const flag = stx((await dialog.managedRadio(0, true).isChecked()) ? 'csManaged.MANAGED' : 'csManaged.UNMANAGED', 'ko');
  await dialog.clickCancel();
  await dialog.expectClosed();
  await list.checkbox(row).uncheck();
  return flag;
}

function daeguOrSkip(world: StockWorld): void {
  test.skip(!world.warehouses.DAEGU, world.daeguUnavailableReason ?? 'The CJ Daegu warehouse could not be built on dev.');
}

test.describe('[Stock Quantity Calculation] Stock management — quantity columns', () => {
  test('TC_US134_71 — Total stock is the sum of allocated, available, CS (available) and on-hold stock', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_71',
      'Critical',
      TAGS,
      `DEMO-SKU-0001 @ CJ Incheon Aam shows 전체재고 190, 할당재고 40, 가용재고 120, CS재고(가용재고) 20 left to right; the on-hold bucket (10) is read from the stock table; 40 + 120 + 20 + 10 equals the displayed total; the 전체재고 header tooltip states the formula. ${WORLD_NOTE}`,
    );
    const list = new StockCalculationPage(page);
    const seed = world.row('SKU0001', world.warehouses.CJ);
    const row = list.row(seed.sku.skuCode, seed.warehouse.name);
    let headers: string[] = [];
    let shown: string[] = [];
    let hold = Number.NaN;
    let sum = Number.NaN;
    let tooltip = '';

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; DEMO-SKU-0001 @ CJ Incheon Aam holds allocated 40, available 120, CS 20 and on hold 10', async () => {
      expect(seed.buckets, 'The demo row DEMO-SKU-0001 @ CJ Incheon Aam holds the TC buckets').toMatchObject({ reserved: 40, available: 120, cs: 20, hold: 10 });
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management)', async () => {
      await list.openWorld(world);
    });

    await step('Assert: Expected 1 — The Stock management screen opens and the stock list is displayed', async () => {
      await expect(list.table, '[Expected 1] The stock list table is shown').toBeVisible();
      expect(await list.dataRowCount(), '[Expected 1] The stock list shows rows').toBeGreaterThan(0);
    });

    await step('Act: Step 2 — Find the row for DEMO-SKU-0001 in CJ Incheon Aam', async () => {
      await row.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — The row for DEMO-SKU-0001 in CJ Incheon Aam is found', async () => {
      await expect(row, '[Expected 2] The DEMO-SKU-0001 row in CJ Incheon Aam is listed').toBeVisible();
    });

    await step('Act: Step 3 — Read 전체재고, 할당재고, 가용재고 and CS재고(가용재고) from left to right', async () => {
      headers = await list.headerTexts();
      shown = [];
      for (const column of ['col.totalQuantity', 'col.reservedQuantity', 'col.availableQuantity', 'col.csQuantity'] as const) shown.push(await list.cellText(row, column));
    });

    await step('Assert: Expected 3 — The row displays Total 190, Allocated 40, Available 120 and CS stock (available) 20 from left to right', async () => {
      const order = ['col.totalQuantity', 'col.reservedQuantity', 'col.availableQuantity', 'col.csQuantity'].map((key) => headers.indexOf(stx(key as 'col.totalQuantity', 'ko')));
      expect(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])), '[Expected 3] The 4 columns read 전체재고 → 할당재고 → 가용재고 → CS재고(가용재고) from left to right').toBe(true);
      expect(shown[0], '[Expected 3] 전체재고 (Total stock) is 190').toBe('190');
      expect(shown[1], '[Expected 3] 할당재고 (Allocated stock) is 40').toBe('40');
      expect(shown[2], '[Expected 3] 가용재고 (Available stock) is 120').toBe('120');
      expect(shown[3], '[Expected 3] CS재고(가용재고) (CS stock — available) is 20').toBe('20');
    });

    await step('Act: Step 4 — Obtain the on-hold stock of the same SKU and warehouse from the inventory data source', async () => {
      hold = (await stockDb.stock(seed.sku.skuId, seed.warehouse.id))?.hold_quantity ?? Number.NaN;
    });

    await step('Assert: Expected 4 — The on-hold stock in the inventory data source is 10', async () => {
      expect(hold, '[Expected 4] The stock table holds on-hold stock 10 for DEMO-SKU-0001 @ CJ Incheon Aam').toBe(10);
    });

    await step('Act: Step 5 — Calculate Allocated + Available + CS stock (available) + On hold and compare it with Total stock', async () => {
      sum = toNumber(shown[1]) + toNumber(shown[2]) + toNumber(shown[3]) + hold;
    });

    await step('Assert: Expected 5 — 40 + 120 + 20 + 10 = 190 matches the displayed Total stock', async () => {
      expect(sum, '[Expected 5] Allocated + Available + CS + On hold is 190').toBe(190);
      expect(sum, '[Expected 5] The calculated sum matches the displayed 전체재고').toBe(toNumber(shown[0]));
    });

    await step('Act: Step 6 — Hover over the 전체재고 (Total stock) header and read the tooltip', async () => {
      await list.headerTooltip('col.totalQuantity').hover();
      tooltip = await list.tooltipText('col.totalQuantity');
    });

    await step('Assert: Expected 6 — The tooltip states the Total stock formula', async () => {
      expect(tooltip, '[Expected 6] The 전체재고 tooltip states the formula').toBe('창고에 보관 중인 총 재고 수량입니다. 전체재고 = 할당재고 + 가용재고 + CS재고(가용재고) + 보류재고');
    });
  });

  test('TC_US134_72 — Allocated stock counts only order quantity in Preparing for delivery', async () => {
    await skipTc('TC_US134_72', 'Medium', TAGS, 'Allocated stock of DEMO-SKU-0001 @ CJ Incheon Aam equals the sum of its order lines in 배송준비중 (25 + 15 = 40), excluding a line in another status; the header tooltip reads 배송준비중 상태의 수량입니다.', ORDER_DATA_REASON);
  });

  test('TC_US134_73 — Available stock equals total minus allocated, CS (available) and on-hold stock', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_73',
      'Medium',
      TAGS,
      `가용재고 of DEMO-SKU-0001 @ CJ Incheon Aam (190 − 40 − 20 − 10 = 120) and DEMO-SKU-0008 @ CJ Daegu warehouse (34 − 12 − 8 − 0 = 14) matches the formula worked out from the displayed total / allocated / CS cells and the stored on-hold bucket; the 가용재고 header tooltip states the formula. ${WORLD_NOTE}`,
    );
    daeguOrSkip(world);
    const list = new StockCalculationPage(page);
    const first = world.row('SKU0001', world.warehouses.CJ);
    const second = world.row('SKU0008', world.warehouses.DAEGU ?? undefined);
    const firstRow = list.row(first.sku.skuCode, first.warehouse.name);
    const secondRow = list.row(second.sku.skuCode, second.warehouse.name);
    const reading = { first: '', second: '' };
    const calculated = { first: Number.NaN, second: Number.NaN };
    let tooltip = '';

    const formula = async (row: Locator, skuId: number, warehouseId: number): Promise<number> => {
      const hold = (await stockDb.stock(skuId, warehouseId))?.hold_quantity ?? Number.NaN;
      return toNumber(await list.cellText(row, 'col.totalQuantity')) - toNumber(await list.cellText(row, 'col.reservedQuantity')) - toNumber(await list.cellText(row, 'col.csQuantity')) - hold;
    };

    await step('Arrange: Pre-condition 1–3 — DEMO-SKU-0001 @ CJ Incheon Aam (190 / 40 / 20 / 10) and DEMO-SKU-0008 @ CJ Daegu warehouse (34 / 12 / 8 / 0) exist', async () => {
      expect(first.buckets, 'DEMO-SKU-0001 @ CJ Incheon Aam holds the TC buckets').toMatchObject({ available: 120, reserved: 40, cs: 20, hold: 10 });
      expect(second.buckets, 'DEMO-SKU-0008 @ CJ Daegu warehouse holds the TC buckets').toMatchObject({ available: 14, reserved: 12, cs: 8, hold: 0 });
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management)', async () => {
      await list.openWorld(world);
    });

    await step('Assert: Expected 1 — The Stock management screen opens and the stock list is displayed', async () => {
      await expect(list.table, '[Expected 1] The stock list table is shown').toBeVisible();
      expect(await list.dataRowCount(), '[Expected 1] The stock list shows rows').toBeGreaterThan(0);
    });

    await step('Act: Step 2 — Find DEMO-SKU-0001 in CJ Incheon Aam and read its 가용재고 (Available stock)', async () => {
      reading.first = await list.cellText(firstRow, 'col.availableQuantity');
    });

    await step('Assert: Expected 2 — Available stock for DEMO-SKU-0001 displays 120', async () => {
      expect(reading.first, '[Expected 2] 가용재고 of DEMO-SKU-0001 is 120').toBe('120');
    });

    await step('Act: Step 3 — Calculate 190 − 40 − 20 − 10 and compare it with the displayed Available stock', async () => {
      calculated.first = await formula(firstRow, first.sku.skuId, first.warehouse.id);
    });

    await step('Assert: Expected 3 — The calculated value is 120 and matches the displayed Available stock', async () => {
      expect(calculated.first, '[Expected 3] Total − Allocated − CS − On hold is 120').toBe(120);
      expect(calculated.first, '[Expected 3] The calculated value matches the displayed 가용재고').toBe(toNumber(reading.first));
    });

    await step('Act: Step 4 — Find DEMO-SKU-0008 in CJ Daegu warehouse and read its Available stock', async () => {
      reading.second = await list.cellText(secondRow, 'col.availableQuantity');
    });

    await step('Assert: Expected 4 — Available stock for DEMO-SKU-0008 displays 14', async () => {
      expect(reading.second, '[Expected 4] 가용재고 of DEMO-SKU-0008 is 14').toBe('14');
    });

    await step('Act: Step 5 — Calculate 34 − 12 − 8 − 0 and compare it with the displayed Available stock', async () => {
      calculated.second = await formula(secondRow, second.sku.skuId, second.warehouse.id);
    });

    await step('Assert: Expected 5 — The calculated value is 14 and matches the displayed Available stock', async () => {
      expect(calculated.second, '[Expected 5] Total − Allocated − CS − On hold is 14').toBe(14);
      expect(calculated.second, '[Expected 5] The calculated value matches the displayed 가용재고').toBe(toNumber(reading.second));
    });

    await step('Act: Step 6 — Hover over the 가용재고 (Available stock) header and read the tooltip', async () => {
      await list.headerTooltip('col.availableQuantity').hover();
      tooltip = await list.tooltipText('col.availableQuantity');
    });

    await step('Assert: Expected 6 — The tooltip states the Available stock formula and the delivery-instruction note', async () => {
      expect(tooltip, '[Expected 6] The 가용재고 tooltip states the formula and the note').toBe('가용재고 = 전체재고 - 할당재고 - CS재고(가용재고) - 보류재고 (배송지시는 가용재고가 있는 경우에만 가능합니다.)');
    });
  });

  test('TC_US134_74 — CS stock (CS-usable) is CS stock (available) minus pending CS re-delivery, floored at 0', async () => {
    await skipTc(
      'TC_US134_74',
      'Medium',
      TAGS,
      'CS재고(CS가능수량) = MAX(0, CS재고(가용재고) − pending CS re-delivery outbound) on DEMO-SKU-0001 (20 − 6 = 14), DEMO-SKU-0008 (8 − 5 = 3) and DEMO-SKU-0011 (5 − 8 → 0).',
      `Blocked in the TC file until KakaoEnt BRZ-14805 is on the test environment (until then CS-usable equals CS stock by design — see TC_US134_75). ${ORDER_DATA_REASON}`,
    );
  });

  test('TC_US134_75 — Both CS columns show the same number and the full CS stock can be released before BRZ-14805', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_75',
      'Medium',
      TAGS,
      'On a CS-managed row with 가용재고 120 and CS재고(가용재고) 20 both CS columns show 20; 재고 전환 → CS재고 해제 shows the source quantity 20; releasing 20 saves with 등록되었습니다 and the row then reads CS 0 and available 140. Data: the conversion writes stock, so the row is the suite\'s own physical SKU seeded at the automation CJ Incheon Aam warehouse (not the shared DEMO-SKU-0001 row). Pre-condition 4 (a CS re-delivery outbound of 6 awaiting dispatch) cannot be built — no commerce order can be created from this admin; the interim rule under test (the re-delivery is not subtracted) makes the expected numbers the same without it.',
    );
    const list = new StockCalculationPage(page);
    const warehouse = world.warehouses.CJ;
    const sku = await ownPhysicalSku(world, 'TC075');
    const row = list.row(sku.skuCode, warehouse.name);
    let csCells: string[] = [];
    let source = '';
    let saveStatus = 0;
    let after = { cs: '', available: '' };

    await step('Arrange: Pre-condition 1–4 — A CS-managed physical SKU @ CJ Incheon Aam with 가용재고 120 and CS재고(가용재고) 20', async () => {
      await world.seedStock(sku, warehouse, { available: 120, cs: 20, csManaged: true });
      const stored = await stockDb.stock(sku.skuId, warehouse.id);
      expect(stored?.cs_stock_managed, 'The seeded row is CS-managed').toBe(1);
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management) and read CS재고(가용재고) and CS재고(CS가능수량) of the row', async () => {
      await list.open('ko');
      await list.findSku(sku);
      csCells = [await list.cellText(row, 'col.csQuantity'), await list.cellText(row, 'col.csOrderableQuantity')];
    });

    await step('Assert: Expected 1 — Both CS columns show 20 (the re-delivery is not subtracted until BRZ-14805)', async () => {
      expect(csCells[0], '[Expected 1] CS재고(가용재고) (CS stock — available) shows 20').toBe('20');
      expect(csCells[1], '[Expected 1] CS재고(CS가능수량) (CS stock — CS-usable) shows 20').toBe('20');
    });

    await step('Act: Step 2 — Tick the row, click 재고 전환 (Stock conversion), pick CS재고 해제 and read the (전환 전 구분) 현재수량 cell', async () => {
      await list.tick(row, sku.skuCode);
      await list.clickToolbar('btn.convertStock');
      await dialog.waitOpen('ko');
      await dialog.choosePolicy('RELEASE_CS');
      source = (await dialog.rowValues(0))[3];
    });

    await step('Assert: Expected 2 — The source cell shows 20', async () => {
      expect(source, '[Expected 2] (전환 전 구분) 현재수량 ((Source) current qty) shows 20').toBe('20');
    });

    await step('Act: Step 3 — Type 20 into 전환수량 (Conversion qty) and click 저장 (Save)', async () => {
      await dialog.fillLine(0, { quantity: '20' });
      await list.waitForListReload(async () => {
        saveStatus = await dialog.saveAndWait('/api/v1/stocks/conversions');
      });
    });

    await step('Assert: Expected 3 — The save goes through and shows 등록되었습니다 (Registered.)', async () => {
      expect(saveStatus, '[Expected 3] The conversion call succeeds').toBeLessThan(300);
      await expect(list.lastToast(), '[Expected 3] The toast 등록되었습니다 (Registered.) is shown').toContainText(stx('msg.registered', 'ko'));
    });

    await step('Act: Step 4 — Read CS재고(가용재고) and 가용재고 on the reloaded row', async () => {
      after = { cs: await list.cellText(row, 'col.csQuantity'), available: await list.cellText(row, 'col.availableQuantity') };
    });

    await step('Assert: Expected 4 — CS stock (available) shows 0 and available stock shows 140', async () => {
      expect(after.cs, '[Expected 4] CS재고(가용재고) shows 0').toBe('0');
      expect(after.available, '[Expected 4] 가용재고 shows 140').toBe('140');
    });
  });

  test('TC_US134_76 — Both CS stock columns display Not managed when the CS managed flag is off', async ({ page, world, warehouseDetailDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_76',
      'Medium',
      TAGS,
      `DEMO-SKU-0002 @ CJ Incheon Aam (CS managed flag off) shows 관리안함 in both CS columns and no number; DEMO-SKU-0001 @ CJ Incheon Aam (flag on) shows CS stock 20 and a number in CS-usable. The flag is read in 창고별 상세 (opened read-only and closed with 취소). Not automated: CS-usable = 14 on DEMO-SKU-0001 — it needs a pending CS re-delivery outbound of 6, which no commerce order can produce from this admin (and BRZ-14805 is not deployed, see TC_US134_75); the cell is checked to hold a number only. ${WORLD_NOTE}`,
    );
    const list = new StockCalculationPage(page);
    const unmanaged = world.row('SKU0002', world.warehouses.CJ);
    const managed = world.row('SKU0001', world.warehouses.CJ);
    const unmanagedRow = list.row(unmanaged.sku.skuCode, unmanaged.warehouse.name);
    const managedRow = list.row(managed.sku.skuCode, managed.warehouse.name);
    const read = { flag2: '', cs2: '', usable2: '', flag1: '', cs1: '', usable1: '' };

    await step('Arrange: Pre-condition 1–2 — DEMO-SKU-0002 @ CJ Incheon Aam is not CS-managed; DEMO-SKU-0001 @ CJ Incheon Aam is CS-managed with CS stock 20', async () => {
      expect(unmanaged.buckets.csManaged, 'DEMO-SKU-0002 @ CJ Incheon Aam is not CS-managed').toBe(false);
      expect(managed.buckets, 'DEMO-SKU-0001 @ CJ Incheon Aam is CS-managed with CS stock 20').toMatchObject({ csManaged: true, cs: 20 });
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock Management)', async () => {
      await list.openWorld(world);
    });

    await step('Assert: Expected 1 — The Stock Management screen opens successfully', async () => {
      await expect(list.table, '[Expected 1] The stock list table is shown').toBeVisible();
    });

    await step('Act: Step 2 — Find DEMO-SKU-0002 in CJ Incheon Aam', async () => {
      read.flag2 = await readCsFlag(list, dialog, unmanagedRow);
    });

    await step('Assert: Expected 2 — DEMO-SKU-0002 in CJ Incheon Aam is displayed with CS Managed Flag = Not Managed', async () => {
      await expect(unmanagedRow, '[Expected 2] The DEMO-SKU-0002 row in CJ Incheon Aam is listed').toBeVisible();
      expect(read.flag2, '[Expected 2] Its CS재고 관리여부 is 관리안함 (Not managed)').toBe(stx('csManaged.UNMANAGED', 'ko'));
    });

    await step('Act: Step 3 — Read CS재고(가용재고) (CS stock — available)', async () => {
      read.cs2 = await list.cellText(unmanagedRow, 'col.csQuantity');
    });

    await step('Assert: Expected 3 — Its CS stock (available) column displays 관리안함 (Not managed), not a numeric value', async () => {
      expect(read.cs2, '[Expected 3] CS재고(가용재고) shows 관리안함').toBe(NOT_MANAGED);
    });

    await step('Act: Step 4 — Read CS재고(CS가능수량) (CS stock — CS-usable)', async () => {
      read.usable2 = await list.cellText(unmanagedRow, 'col.csOrderableQuantity');
    });

    await step('Assert: Expected 4 — Its CS stock (CS-usable) column displays 관리안함 (Not managed), not a numeric value', async () => {
      expect(read.usable2, '[Expected 4] CS재고(CS가능수량) shows 관리안함').toBe(NOT_MANAGED);
    });

    await step('Act: Step 5 — Find DEMO-SKU-0001 in CJ Incheon Aam', async () => {
      read.flag1 = await readCsFlag(list, dialog, managedRow);
    });

    await step('Assert: Expected 5 — DEMO-SKU-0001 in CJ Incheon Aam is displayed with CS Managed Flag = Managed', async () => {
      await expect(managedRow, '[Expected 5] The DEMO-SKU-0001 row in CJ Incheon Aam is listed').toBeVisible();
      expect(read.flag1, '[Expected 5] Its CS재고 관리여부 is 관리함 (Managed)').toBe(stx('csManaged.MANAGED', 'ko'));
    });

    await step('Act: Step 6 — Read CS stock (available)', async () => {
      read.cs1 = await list.cellText(managedRow, 'col.csQuantity');
    });

    await step('Assert: Expected 6 — Its CS stock (available) column displays 20', async () => {
      expect(read.cs1, '[Expected 6] CS재고(가용재고) of DEMO-SKU-0001 shows 20').toBe('20');
    });

    await step('Act: Step 7 — Read CS stock (CS-usable)', async () => {
      read.usable1 = await list.cellText(managedRow, 'col.csOrderableQuantity');
    });

    await step('Assert: Expected 7 — Its CS stock (CS-usable) column displays a number (14 needs a pending re-delivery — not automated)', async () => {
      expect(read.usable1, '[Expected 7] CS재고(CS가능수량) of DEMO-SKU-0001 shows a number, not 관리안함').toMatch(/^\d[\d,]*$/);
    });

    await step('Act: Step 8 — Check whether either CS column of DEMO-SKU-0002 displays any numeric value', async () => {
      read.cs2 = await list.cellText(unmanagedRow, 'col.csQuantity');
      read.usable2 = await list.cellText(unmanagedRow, 'col.csOrderableQuantity');
    });

    await step('Assert: Expected 8 — Neither CS column of DEMO-SKU-0002 displays 0, a positive or a negative number; both display only 관리안함', async () => {
      for (const [name, value] of [['CS재고(가용재고)', read.cs2], ['CS재고(CS가능수량)', read.usable2]] as const) {
        expect(value, `[Expected 8] ${name} of DEMO-SKU-0002 holds no digit`).not.toMatch(/\d/);
        expect(value, `[Expected 8] ${name} of DEMO-SKU-0002 shows only 관리안함`).toBe(NOT_MANAGED);
      }
    });
  });

  test('TC_US134_77 — Both CS stock columns show a dash on a row whose warehouse is not a CJ warehouse', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_77',
      'Medium',
      TAGS,
      `On a stock row in the pickup-location warehouse Demo Pickup Point (CS flag off, 가용재고 10) both CS cells show "-" — not 관리안함 and not 0; on DEMO-SKU-0002 @ CJ Incheon Aam (WMS, flag off) both show 관리안함. Data mapping: the TC puts DEMO-SKU-0001 in Demo Pickup Point; the demo world keeps that pickup row on DEMO-SKU-0004 (available 10, flag off) so the shared 12-row world is not changed. ${WORLD_NOTE}`,
    );
    const list = new StockCalculationPage(page);
    const pickup = world.row('SKU0004', world.warehouses.PICKUP);
    const cj = world.row('SKU0002', world.warehouses.CJ);
    const pickupRow = list.row(pickup.sku.skuCode, pickup.warehouse.name);
    const cjRow = list.row(cj.sku.skuCode, cj.warehouse.name);
    let pickupCells: string[] = [];
    let cjCells: string[] = [];

    await step('Arrange: Pre-condition 1–3 — A stock row in Demo Pickup Point (flag off, available 10) and DEMO-SKU-0002 @ CJ Incheon Aam (flag off)', async () => {
      expect(pickup.buckets, 'The pickup-location row holds available 10 with the CS flag off').toMatchObject({ available: 10, csManaged: false });
      expect(cj.buckets.csManaged, 'DEMO-SKU-0002 @ CJ Incheon Aam has the CS flag off').toBe(false);
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management) and find the row in Demo Pickup Point', async () => {
      await list.openWorld(world);
      await pickupRow.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — The row is displayed', async () => {
      await expect(pickupRow, '[Expected 1] The stock row in Demo Pickup Point is listed').toBeVisible();
    });

    await step('Act: Step 2 — Read CS재고(가용재고) and CS재고(CS가능수량)', async () => {
      pickupCells = [await list.cellText(pickupRow, 'col.csQuantity'), await list.cellText(pickupRow, 'col.csOrderableQuantity')];
    });

    await step('Assert: Expected 2 — Both cells show a dash (-), not 관리안함 (Not managed) and not 0', async () => {
      for (const [index, name] of ['CS재고(가용재고)', 'CS재고(CS가능수량)'].entries()) {
        expect(pickupCells[index], `[Expected 2] ${name} shows a dash`).toBe('-');
        expect(pickupCells[index], `[Expected 2] ${name} does not show 관리안함`).not.toBe(NOT_MANAGED);
        expect(pickupCells[index], `[Expected 2] ${name} does not show 0`).not.toBe('0');
      }
    });

    await step('Act: Step 3 — Find DEMO-SKU-0002 in CJ Incheon Aam and read the same 2 cells', async () => {
      cjCells = [await list.cellText(cjRow, 'col.csQuantity'), await list.cellText(cjRow, 'col.csOrderableQuantity')];
    });

    await step('Assert: Expected 3 — Both cells show 관리안함 (Not managed)', async () => {
      expect(cjCells[0], '[Expected 3] CS재고(가용재고) of DEMO-SKU-0002 shows 관리안함').toBe(NOT_MANAGED);
      expect(cjCells[1], '[Expected 3] CS재고(CS가능수량) of DEMO-SKU-0002 shows 관리안함').toBe(NOT_MANAGED);
    });
  });

  test('TC_US134_78 — Stock awaiting allocation sums completed orders and all applicable shipping-wait quantities', async () => {
    await skipTc('TC_US134_78', 'Medium', TAGS, '할당대기재고 of DEMO-SKU-0001 @ CJ Incheon Aam = completed orders 6 + non-pickup delivery waits 4 + pickup waits 3 + production issues 2 = 15; the header tooltip shows the CJ-warehouse and pickup-location branches.', ORDER_DATA_REASON);
  });

  test('TC_US134_79 — Stock awaiting allocation is reduced by refunded cancellations only and never shows a negative value', async () => {
    await skipTc('TC_US134_79', 'High', TAGS, '할당대기재고 = MAX(0, before-cancellation value − refunded cancellation quantity): DEMO-SKU-0001 15 − 5 = 10 (an unrefunded CANCEL claim of 4 is not deducted), DEMO-SKU-0011 1 − 9 → 0.', ORDER_DATA_REASON);
  });

  test('TC_US134_80 — Component SKUs get order quantity × component quantity in stock awaiting allocation when a set SKU order completes', async () => {
    await skipTc('TC_US134_80', 'High', TAGS, 'Completing 3 orders of set SKU DEMO-SKU-0007 raises 할당대기재고 of DEMO-SKU-0001 and DEMO-SKU-0009 by 3 each (the set keeps none); 3 orders of a second set with DEMO-SKU-0001 × 2 raise DEMO-SKU-0001 by another 6.', `Step 1 and 6 complete commerce orders. ${ORDER_DATA_REASON}`);
  });

  test('TC_US134_81 — INSTRUCTED and REQUESTED outbound lines are included in stock awaiting allocation', async () => {
    await skipTc('TC_US134_81', 'Medium', TAGS, 'With one outbound unit in each of CREATED, WAIT, EXPECTED, PENDING, INSTRUCTED and REQUESTED, 할당대기재고 of DEMO-SKU-0001 is 6, and 5 after removing the INSTRUCTED or the REQUESTED line; the hint shows the CJ-warehouse text in Korean and English.', ORDER_DATA_REASON);
  });

  test('TC_US134_82 — A CS re-delivery outbound leaves stock awaiting allocation on a CS-managed row and stays on an unmanaged row', async () => {
    await skipTc('TC_US134_82', 'High', TAGS, 'With completed orders 8 and one CLAIM outbound of 5: the CS-managed DEMO-SKU-0001 row reads 할당대기재고 8 / 주문가능수량 2 / 재고부족수량 0, the unmanaged DEMO-SKU-0002 row reads 13 / 0 / 3.', `Blocked in the TC file until KakaoEnt BRZ-14801 is on the test environment. ${ORDER_DATA_REASON}`);
  });

  test('TC_US134_83 — Orderable quantity equals available minus stock awaiting allocation and never shows a minus number', async () => {
    await skipTc('TC_US134_83', 'Medium', TAGS, '주문가능수량 shows 105 (120 − 15) on DEMO-SKU-0001, 0 on DEMO-SKU-0003 (200 − 250) and 6 (14 − 8) on DEMO-SKU-0008; the hint reads 주문에 사용할 수 있는 수량입니다. 주문가능수량 = 가용재고 - 할당대기재고.', `Every expected value depends on a stock-awaiting-allocation figure (15 / 250 / 8). ${ORDER_DATA_REASON}`);
  });

  test('TC_US134_84 — Expected inbound quantity counts only the requested inbound lines', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_84',
      'Medium',
      TAGS,
      '입고예정수량 of a physical SKU @ CJ Incheon Aam with inbound lines Purchase Order REQUESTED 20, Transfer REQUESTED 20, Assembly REQUESTED 20 and Purchase Order REGISTERED 500 shows 60 (only the 3 requested lines); the header tooltip reads 입고예정으로 등록된 입고예정수량의 총 합계입니다. Data: the row is the suite\'s own physical SKU seeded at the automation CJ Incheon Aam warehouse (stock row seeded via DB, the 4 inbound records inserted into incoming / incoming_item because the screen cannot create ASSEMBLY or REGISTERED inbounds); no purchase order at 발행 exists for it (US105 purchase orders are never created by this suite).',
    );
    const list = new StockCalculationPage(page);
    const warehouse = world.warehouses.CJ;
    const sku = await ownPhysicalSku(world, 'TC084');
    const row = list.row(sku.skuCode, warehouse.name);
    let incoming = '';
    let tooltip = '';

    await step('Arrange: Pre-condition 1–3 — Inbound records PO REQUESTED 20, Transfer REQUESTED 20, Assembly REQUESTED 20 and PO REGISTERED 500 exist; no issued purchase order', async () => {
      await world.seedStock(sku, warehouse, { available: 120, csManaged: true });
      await seedIncoming(sku, warehouse.id, { type: 'PURCHASE_ORDER', status: 'REQUESTED', quantity: 20 });
      await seedIncoming(sku, warehouse.id, { type: 'TRANSFER', status: 'REQUESTED', quantity: 20 });
      await seedIncoming(sku, warehouse.id, { type: 'ASSEMBLY', status: 'REQUESTED', quantity: 20 });
      await seedIncoming(sku, warehouse.id, { type: 'PURCHASE_ORDER', status: 'REGISTERED', quantity: 500 });
      expect((await stockDb.incomingsOfSku(sku.skuId)).length, 'The 4 inbound records exist for the SKU').toBe(4);
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management) and find the row', async () => {
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Assert: Expected 1 — The row is shown', async () => {
      await expect(row, `[Expected 1] The row of ${sku.skuCode} @ CJ Incheon Aam is listed`).toBeVisible();
    });

    await step('Act: Step 2 — Read the 입고예정수량 (Expected inbound quantity) cell', async () => {
      incoming = await list.cellText(row, 'col.incomingQuantity');
    });

    await step('Assert: Expected 2 — The cell shows 60 — only the 3 requested lines are counted (20 + 20 + 20)', async () => {
      expect(incoming, '[Expected 2] 입고예정수량 shows 60 (the REGISTERED 500 is not counted)').toBe('60');
    });

    await step('Act: Step 3 — Hover over the 입고예정수량 (Expected inbound quantity) header', async () => {
      await list.headerTooltip('col.incomingQuantity').hover();
      tooltip = await list.tooltipText('col.incomingQuantity');
    });

    await step('Assert: Expected 3 — The hint shows 입고예정으로 등록된 입고예정수량의 총 합계입니다.', async () => {
      expect(tooltip, '[Expected 3] The 입고예정수량 hint text').toBe('입고예정으로 등록된 입고예정수량의 총 합계입니다.');
    });
  });

  test('TC_US134_85 — Expected inbound quantity adds the quantity still owed on an issued purchase order', async () => {
    await skipTc('TC_US134_85', 'High', TAGS, '입고예정수량 = requested inbound 40 + remaining quantity of an ISSUED purchase order (100 − 30) = 110, then 80 after a further goods receipt of 30.', 'Blocked in the TC file until US105 is built and its expected-inbound figure is wired into the shared inventory aggregation — the ISSUED purchase order and its goods receipts belong to US105 Procurement, which this suite does not drive.');
  });

  test('TC_US134_86 — Expected inbound quantity is the same on Stock management, the US071 mapping screen and Bipacen', async () => {
    await skipTc('TC_US134_86', 'High', TAGS, 'DEMO-SKU-0001 @ CJ Incheon Aam shows 입고예정수량 110 on 재고 관리, on the US071 product-warehouse mapping screen and on the Bipacen 재고 관리 screen.', 'Needs the US105 purchase-order half (blocked until it is wired into the shared aggregation), the US071 screen and the Bipacen admin, which is another system outside this admin.');
  });

  test('TC_US134_87 — Expected inbound and stock shortage quantities after purchase order integration', async () => {
    await skipTc('TC_US134_87', 'Medium', TAGS, 'With an ISSUED purchase order of 100 (received 0), 할당대기재고 150 and 가용재고 100, 입고예정수량 shows 100 and 재고부족수량 0 on 재고 관리 and on Bipacen.', 'Needs the US105 purchase-order integration (not wired into the shared aggregation), a stock-awaiting-allocation figure of 150 from commerce orders and the Bipacen admin (another system).');
  });

  test('TC_US134_88 — Stock shortage quantity follows its formula and has a minimum value of 0', async () => {
    await skipTc('TC_US134_88', 'Medium', TAGS, '재고부족수량 = max(0, 할당대기재고 − (가용재고 + 입고예정수량)): 50 on DEMO-SKU-0003, 0 on DEMO-SKU-0001 (−165 clamped), 0 on DEMO-SKU-0002 (exact boundary); the tooltip shows the 2 lines in Korean and English.', `Every expected value depends on a stock-awaiting-allocation figure (250 / 15 / 150). ${ORDER_DATA_REASON}`);
  });

  test('TC_US134_89 — Unsecured outbound quantity never displays a negative value', async () => {
    await skipTc('TC_US134_89', 'Medium', TAGS, '미확보 출고수량 = max(non-pickup outbound awaiting dispatch − 가용재고, 0): 60 on DEMO-SKU-0003 (260 − 200), 0 on DEMO-SKU-0011 (3 − 5); no cell shows a negative number; the tooltip text in Korean and English.', `The expected values need non-pickup outbound quantities awaiting dispatch (260 / 3). ${ORDER_DATA_REASON}`);
  });

  test('TC_US134_90 — A CS re-delivery outbound is left out of unsecured outbound quantity on a CS-managed row', async () => {
    await skipTc('TC_US134_90', 'Medium', TAGS, 'With normal outbound 12 and a CLAIM outbound of 5 awaiting dispatch and 가용재고 10, the CS-managed DEMO-SKU-0001 row reads 미확보 출고수량 2 and the unmanaged DEMO-SKU-0002 row reads 7.', `Blocked in the TC file until KakaoEnt BRZ-14801 is on the test environment. ${ORDER_DATA_REASON}`);
  });

  test('TC_US134_91 — Numeric cells show a dash when there is no stock record and 0 when the record exists', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_91',
      'High',
      TAGS,
      `DEMO-SKU-0005 (no warehouse, no stock record) shows "-" in all 10 numeric cells; a set SKU with a CS-managed stock record (가용재고 60, every other bucket 0) shows 60 in 가용재고 / 전체재고 / 주문가능수량, 0 in the other 7 cells and never 관리안함. Data mapping: DEMO-SKU-0005 is the world SKU; the TC puts the stock record on DEMO-SKU-0012, which must stay stock-less in the shared world, so the record is placed on the suite's own set SKU (Demo Partner B, DEMO-SKU-0011 × 2 like DEMO-SKU-0012) at the automation CJ Daegu warehouse (CJ Incheon Aam when Daegu cannot be built). The order-derived cells of a fresh SKU are expected to read 0. Both rows are found by searching their SKU codes. ${WORLD_NOTE}`,
    );
    const list = new StockCalculationPage(page);
    const empty = world.sku('SKU0005');
    const warehouse = world.warehouses.DAEGU ?? world.warehouses.CJ;
    const set = await world.createSetSku('TC091', world.partners.B, [{ sku: world.sku('SKU0011'), quantity: 2 }], ownGroupName(world, 'TC091'));
    const emptyRow = list.row(empty.skuCode);
    const stockRow = list.row(set.skuCode, warehouse.name);
    let emptyCells: string[] = [];
    let stockCells: string[] = [];

    await step('Arrange: Pre-condition 1–5 — DEMO-SKU-0005 has no stock record; a set SKU has a CS-managed stock record with 가용재고 60 and every other bucket 0', async () => {
      await world.seedStock(set, warehouse, { available: 60, reserved: 0, cs: 0, hold: 0, csManaged: true });
      expect(await stockDb.stocksOfSku(empty.skuId), 'DEMO-SKU-0005 has no stock record').toHaveLength(0);
      expect((await stockDb.stock(set.skuId, warehouse.id))?.cs_stock_managed, 'The set SKU stock record is CS-managed').toBe(1);
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management)', async () => {
      await list.open('ko');
    });

    await step('Assert: Expected 1 — The Stock management list opens', async () => {
      await expect(list.table, '[Expected 1] The stock list table is shown').toBeVisible();
    });

    await step('Act: Step 2 — Find DEMO-SKU-0005 and review all 10 numeric stock cells', async () => {
      await list.findSku(empty);
      emptyCells = await list.numericTexts(emptyRow);
    });

    await step('Assert: Expected 2 — DEMO-SKU-0005 displays a dash (-) in all 10 numeric stock cells', async () => {
      await expect(emptyRow, '[Expected 2] The DEMO-SKU-0005 row is shown').toBeVisible();
      NUMERIC_COLUMNS.forEach((column, index) => {
        expect(emptyCells[index], `[Expected 2] ${stx(column, 'ko')} of DEMO-SKU-0005 shows a dash`).toBe('-');
      });
    });

    await step('Act: Step 3 — Count the cells that display a dash (-)', async () => {
      await expect(emptyRow, 'The DEMO-SKU-0005 row is still shown').toBeVisible();
    });

    await step('Assert: Expected 3 — The number of cells displaying a dash is 10', async () => {
      expect(emptyCells.filter((text) => text === '-').length, '[Expected 3] 10 cells show a dash').toBe(10);
    });

    await step('Act: Step 4 — Find the set SKU with the stock record and review the same 10 numeric stock cells', async () => {
      await list.findSku(set);
      stockCells = await list.numericTexts(stockRow);
    });

    await step('Assert: Expected 4 — The row shows a number in all 10 cells: available / total / orderable 60, the other 7 cells 0, never 관리안함', async () => {
      await expect(stockRow, '[Expected 4] The set SKU stock row is shown').toBeVisible();
      const sixty = ['col.availableQuantity', 'col.totalQuantity', 'col.orderableQuantity'];
      NUMERIC_COLUMNS.forEach((column, index) => {
        const expected = sixty.includes(column) ? '60' : '0';
        expect(stockCells[index], `[Expected 4] ${stx(column, 'ko')} shows ${expected}`).toBe(expected);
      });
      expect(stockCells[3], '[Expected 4] CS재고(가용재고) does not render 관리안함').not.toBe(NOT_MANAGED);
      expect(stockCells[4], '[Expected 4] CS재고(CS가능수량) does not render 관리안함').not.toBe(NOT_MANAGED);
    });

    await step('Act: Step 5 — Compare the numeric cells of the two rows', async () => {
      await expect(stockRow, 'The stock row is still shown').toBeVisible();
    });

    await step('Assert: Expected 5 — A dash means no stock record, while 0 means the record exists with a zero value', async () => {
      expect(emptyCells.every((text) => text === '-'), '[Expected 5] The row without a stock record shows only dashes').toBe(true);
      expect(stockCells.some((text) => text === '-'), '[Expected 5] The row with a stock record shows no dash').toBe(false);
      expect(stockCells.filter((text) => text === '0').length, '[Expected 5] The row with a stock record shows 0 in its zero-valued cells').toBe(7);
    });
  });

  test('TC_US134_92 — Large numbers use thousand separators, numeric cells are right-aligned and no quantity is negative', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_92',
      'Medium',
      TAGS,
      `A row with 전체재고 1,234,567 shows the value with thousand separators and all 10 numeric cells right-aligned; DEMO-SKU-0003 @ CJ Daegu warehouse shows no negative quantity; no numeric cell of the 12 demo rows holds a negative number ("-" and 관리안함 renders are allowed). Data: the 1,234,567 row is the suite's own physical SKU seeded at the automation CJ Incheon Aam warehouse (available 1,234,567, CS-managed). Not automated: 주문가능수량 = 0 and 재고부족수량 = 50 on DEMO-SKU-0003 — both come from a stock-awaiting-allocation figure of 250 that needs commerce orders (BRZ-14801 / interim mock); the cells are checked to be non-negative only. ${WORLD_NOTE}`,
    );
    const list = new StockCalculationPage(page);
    const sku = await ownPhysicalSku(world, 'TC092');
    const bigRow = list.row(sku.skuCode, world.warehouses.CJ.name);
    const third = world.sku('SKU0003');
    const thirdRow = list.row(third.skuCode, world.warehouses.DAEGU?.name);
    let total = '';
    let alignments: string[] = [];
    let thirdCells: string[] = [];
    const allCells: Array<{ code: string; cells: string[] }> = [];

    await step('Arrange: Pre-condition 1–4 — A stock row with total 1,234,567 exists; DEMO-SKU-0003 exists in CJ Daegu warehouse', async () => {
      await world.seedStock(sku, world.warehouses.CJ, { available: 1_234_567, csManaged: true });
      expect((await stockDb.stock(sku.skuId, world.warehouses.CJ.id))?.physical_quantity, 'The seeded row holds physical stock 1,234,567').toBe(1_234_567);
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management)', async () => {
      await list.open('ko');
    });

    await step('Assert: Expected 1 — The Stock management list opens', async () => {
      await expect(list.table, '[Expected 1] The stock list table is shown').toBeVisible();
    });

    await step('Act: Step 2 — Find the row with Total stock = 1,234,567 and read the displayed value', async () => {
      await list.findSku(sku);
      total = await list.cellText(bigRow, 'col.totalQuantity');
    });

    await step('Assert: Expected 2 — Total stock displays 1,234,567 with thousand separators', async () => {
      expect(total, '[Expected 2] 전체재고 shows 1,234,567').toBe('1,234,567');
    });

    await step('Act: Step 3 — Check the alignment of all numeric stock cells in that row', async () => {
      alignments = await list.numericAlignments(bigRow);
    });

    await step('Assert: Expected 3 — All numeric stock cells are right-aligned', async () => {
      NUMERIC_COLUMNS.forEach((column, index) => {
        expect(['right', 'end'], `[Expected 3] ${stx(column, 'ko')} is right-aligned`).toContain(alignments[index]);
      });
    });

    await step('Act: Step 4 — Find DEMO-SKU-0003 and read all 10 numeric stock cells', async () => {
      await list.findSku(third);
      thirdCells = await list.numericTexts(thirdRow);
    });

    await step('Assert: Expected 4 — DEMO-SKU-0003 shows 주문가능수량 without a negative value (0 / 50 not automated)', async () => {
      await expect(thirdRow, '[Expected 4] The DEMO-SKU-0003 row is shown').toBeVisible();
      expect(isNegativeNumber(thirdCells[NUMERIC_COLUMNS.indexOf('col.orderableQuantity')]), '[Expected 4] 주문가능수량 of DEMO-SKU-0003 is not negative').toBe(false);
      expect(isNegativeNumber(thirdCells[NUMERIC_COLUMNS.indexOf('col.insufficientQuantity')]), '[Expected 4] 재고부족수량 of DEMO-SKU-0003 is not negative').toBe(false);
    });

    await step('Act: Step 5 — Review all 10 numeric stock columns across all 12 rows for a minus sign', async () => {
      await list.openWorld(world);
      for (const row of await list.dataRows()) allCells.push({ code: await list.cellText(row, 'col.skuCode'), cells: await list.numericTexts(row) });
    });

    await step('Assert: Expected 5 — No number in the 10 numeric stock columns is negative', async () => {
      expect(allCells.length, '[Expected 5] The 12 demo rows are reviewed').toBe(12);
      for (const { code, cells } of allCells) {
        NUMERIC_COLUMNS.forEach((column, index) => {
          expect(isNegativeNumber(cells[index]), `[Expected 5] ${stx(column, 'ko')} of ${code} is not a negative number (got "${cells[index]}")`).toBe(false);
        });
      }
    });
  });
});
