import type { Page } from '@playwright/test';
import { test, expect } from '@fixtures/stock.fixture';
import { makeStep } from '@utils/step';
import { skipTc, tcMeta } from '@utils/tc-meta';
import { STOCK_LANGS, stx, StockTextKey } from '@utils/stock.i18n';
import { LANG_SUFFIX, WORLD_NOTE, stockTags } from '@utils/stock-spec';
import { StockBuckets, stockDb } from '@utils/stock-db';
import type { StockWorld, WorldSku, WorldWarehouse } from '@utils/stock.data';
import { ConversionDialog } from '@pages/stock-dialogs.page';
import { iconButtonName } from '@pages/stock-list.page';
import { StockListPagingPage } from '@pages/stock-list-paging.page';
import { StockCalculationPage, asWorldWarehouse, ownGroupName, ownPhysicalSku, squash, toNumber } from '@pages/stock-calculation.page';
import { errorOf } from '@pages/stock-inbound.page';
import {
  CONVERSION_PATH,
  ConversionSave,
  StockConversionPage,
  StoredBuckets,
  conversionCount,
  defectiveBucketId,
  setBucketParent,
  storedBuckets,
} from '@pages/stock-conversion.page';

/**
 * US134 — nhóm [Conversion] (TC_US134_228–272): dialog 재고 전환 — 5 policy, di chuyển giữa các ngăn của 1 dòng, 불량 처리
 * sang bucket DEFECTIVE của kho, dòng bị chặn bởi cờ CS, thông báo, ô 전환 후 수량, validate, giới hạn, server từ chối
 * (stale, dòng bị xoá, dòng trùng, kho không PLATFORM, race), hộp xác nhận 취소, kho ảo. Mọi lần 저장 chạy trên SKU riêng
 * của test (ownPhysicalSku + seedStock bằng DB) — dòng world dùng chung chỉ được mở dialog rồi đóng.
 */
const TAGS = stockTags('conversion');
const t = (key: StockTextKey) => stx(key, 'ko');

const OWN_NOTE =
  'Data: every save runs on a physical SKU the test creates for itself (Demo Partner A · Demo Manufacturer 1) whose stock buckets are seeded by DB fixture in the automation warehouses, so the shared demo rows keep their numbers; the teardown removes the SKU, its stock rows and its conversions.';
const HOLD_NOTE = '보류재고 (On-hold stock) is not a list column, so it is read from the stock table (hold_quantity) — the inventory data source.';
const MEMO_100 = 'Demo conversion memo filler text repeated to exactly one hundred characters for this run'.padEnd(100, '0').slice(0, 100);
const MEMO_EMOJI = 'Demo memo 🔁';
const MEMO_KO = '데모 전환 메모.';
const CS_USABLE_NOTE ='CS재고(CS가능수량) equals CS재고(가용재고) until BRZ-14805, so both are seeded through the one cs bucket.';

/** Kho "CJ Daegu warehouse" của TC — kho world CJ Daegu, hoặc CJ Incheon Aam khi dev không dựng được kho CJ_LOGISTICS_DT. */
function daegu(world: StockWorld): { warehouse: WorldWarehouse; note: string } {
  if (world.warehouses.DAEGU) return { warehouse: world.warehouses.DAEGU, note: '' };
  return { warehouse: world.warehouses.CJ, note: `The CJ Daegu warehouse is played by the automation CJ Incheon Aam because ${world.daeguUnavailableReason ?? 'it is not available'}.` };
}

/** SKU 현물 riêng của test có 1 dòng tồn kho với đúng các ngăn TC cần. */
async function ownRow(world: StockWorld, label: string, warehouse: WorldWarehouse, buckets: StockBuckets): Promise<WorldSku> {
  const sku = await ownPhysicalSku(world, label);
  await world.seedStock(sku, warehouse, buckets);
  return sku;
}

/** 2 SKU 현물 riêng cùng 1 상품코드 — mỗi SKU 1 dòng tồn kho (kho + ngăn riêng). */
async function ownPair(world: StockWorld, label: string, rows: Array<{ warehouse: WorldWarehouse; buckets: StockBuckets }>): Promise<WorldSku[]> {
  const skus = await world.createPhysicalSku(label, {
    partner: world.partners.A,
    manufacturer: world.manufacturers.M1,
    groupName: ownGroupName(world, label),
    lines: rows.map((_, index) => ({ option: `Type ${String.fromCharCode(65 + index)}` })),
  });
  for (const [index, row] of rows.entries()) await world.seedStock(skus[index], row.warehouse, row.buckets);
  return skus;
}

/** Màn list + helper dialog dùng chung trong 1 test. */
function pages(page: Page, dialog: ConversionDialog): { list: StockCalculationPage; conv: StockConversionPage } {
  const list = new StockCalculationPage(page);
  return { list, conv: new StockConversionPage(page, list, dialog) };
}

/** Mở list và lọc ra 12 dòng world (20 dòng / trang). */
async function showWorld(list: StockCalculationPage, world: StockWorld): Promise<void> {
  await list.open('ko');
  await list.search('SKU_GROUP_NAME', world.keyword);
  await list.choosePageSize(20);
}

/** Số liệu 1 dòng: 가용 / CS / 전체 từ list, 보류 từ bảng stock. */
interface RowNumbers {
  available: number;
  cs: number;
  total: number;
  hold: number;
}

async function readNumbers(list: StockCalculationPage, sku: WorldSku, warehouse: { id: number; name: string }): Promise<RowNumbers> {
  const row = list.row(sku.skuCode, warehouse.name);
  const stored = await storedBuckets(sku.skuId, warehouse.id);
  return {
    available: toNumber(await list.cellText(row, 'col.availableQuantity')),
    cs: toNumber(await list.cellText(row, 'col.csQuantity')),
    total: toNumber(await list.cellText(row, 'col.totalQuantity')),
    hold: stored?.hold ?? Number.NaN,
  };
}

/** Body lỗi tóm tắt của 1 lần lưu (đính kèm vào message assertion). */
const brief = (save: ConversionSave | null): string => (save ? `status ${save.status}, body ${JSON.stringify(save.body).slice(0, 300)}` : 'no request sent');

test.describe('[Conversion] Stock management — the 재고 전환 dialog', () => {
  test('TC_US134_228 — A successful save shows Registered., reloads the list, clears the ticks and moves the 2 number cells', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_228',
      'Critical',
      TAGS,
      `Round 1 (CS재고 확보 30, memo "Demo CS reservation") on a CS-managed row 190 / 120 / CS 20 / on hold 10 closes the dialog, shows 등록되었습니다, reloads the list with no tick left and reads 가용재고 90 · CS재고 50 · 전체재고 190; round 2 (불량 처리 5) shows 등록되었습니다 again, on-hold stock falls to 5 and 전체재고 to 185. ${HOLD_NOTE} ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    const cj = world.warehouses.CJ;
    let sku!: WorldSku;
    let saved!: ConversionSave;
    let reloaded!: Promise<boolean>;
    let listReloaded = false;
    let round1!: RowNumbers;
    let round2!: RowNumbers;

    await step('Arrange: Pre-condition 1–4 — Own physical row in CJ Incheon Aam: total 190, available 120, CS 20, on hold 10, CS managed; CJ Incheon Aam has a DEFECTIVE bucket', async () => {
      sku = await ownRow(world, 'TC228', cj, { available: 120, reserved: 40, cs: 20, hold: 10, csManaged: true });
      expect(world.bucket(cj, '불량').id, 'CJ Incheon Aam has its own DEFECTIVE (불량) virtual warehouse').toBeGreaterThan(0);
      await list.open('ko');
      await conv.showSku(sku);
    });

    await step('Act: Step 1 — Tick the row, click 재고 전환, fill in round 1 (CS재고 확보, 30, Demo CS reservation) and click 저장', async () => {
      await conv.openFor([{ row: list.row(sku.skuCode, cj.name), label: sku.skuCode }]);
      await conv.choose('SECURE_CS');
      await dialog.fillLine(0, { quantity: '30', memo: 'Demo CS reservation' });
      ({ save: saved, reloaded } = await conv.saveWatchingReload());
    });

    await step('Assert: Expected 1 — The save finishes and the dialog closes', async () => {
      expect(saved.status, `[Expected 1] POST ${CONVERSION_PATH} succeeds (${brief(saved)})`).toBeLessThan(300);
      await expect(dialog.root, '[Expected 1] The dialog closes').toHaveCount(0);
    });

    await step('Act: Step 2 — Read the message that appears and the tick boxes on the list', async () => {
      listReloaded = await reloaded;
      await list.waitForList();
    });

    await step('Assert: Expected 2 — 등록되었습니다 (Registered.) appears, the list asked for its data again and no tick box is selected', async () => {
      await expect(list.lastToast(), `[Expected 2] The message ${t('msg.registered')} appears`).toContainText(t('msg.registered'));
      expect(listReloaded, '[Expected 2] The list asks for its data again after the save').toBe(true);
      await expect(conv.checkedRowBoxes, '[Expected 2] No tick box is selected').toHaveCount(0);
    });

    await step('Act: Step 3 — Read 가용재고, CS재고(가용재고) and 전체재고 on the reloaded row', async () => {
      round1 = await readNumbers(list, sku, cj);
    });

    await step('Assert: Expected 3 — Available 90, CS available 50, and 전체재고 STILL 190', async () => {
      expect(round1.available, '[Expected 3] 가용재고 (Available stock) shows 90').toBe(90);
      expect(round1.cs, '[Expected 3] CS재고(가용재고) (CS stock — available) shows 50').toBe(50);
      expect(round1.total, '[Expected 3] 전체재고 (Total stock) still shows 190').toBe(190);
    });

    await step('Act: Step 4 — Tick the row again, open the dialog, fill in round 2 (불량 처리, 5) and click 저장', async () => {
      await conv.openFor([{ row: list.row(sku.skuCode, cj.name), label: sku.skuCode }]);
      await conv.choose('SCRAP_DEFECTIVE');
      await dialog.fillLine(0, { quantity: '5' });
      ({ save: saved, reloaded } = await conv.saveWatchingReload());
    });

    await step('Assert: Expected 4 — The save goes through and shows 등록되었습니다 (Registered.)', async () => {
      expect(saved.status, `[Expected 4] The scrap-as-defective save goes through (${brief(saved)})`).toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 4] The message ${t('msg.registered')} appears`).toContainText(t('msg.registered'));
    });

    await step('Act: Step 5 — Read 전체재고 on the reloaded row and 보류재고 from the inventory data source', async () => {
      await reloaded;
      await list.waitForList();
      round2 = await readNumbers(list, sku, cj);
    });

    await step('Assert: Expected 5 — On-hold stock 5 and 전체재고 FALLS to 185', async () => {
      expect(round2.hold, '[Expected 5] 보류재고 (On-hold stock) shows 5').toBe(5);
      expect(round2.total, '[Expected 5] 전체재고 (Total stock) falls to 185').toBe(185);
    });
  });

  test('TC_US134_229 — Securing CS stock on a managed row moves 30 from available to CS stock', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_229',
      'Critical',
      TAGS,
      `With CS재고 확보 on a CS-managed row (available 120, CS 20) the source cell reads 120 and the target cell 20 (CS-usable stock); saving 30 shows 등록되었습니다 and the row reads available 90 · CS 50. ${CS_USABLE_NOTE} ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    const cj = world.warehouses.CJ;
    let sku!: WorldSku;
    let saved!: ConversionSave;
    let after!: RowNumbers;

    await step('Arrange: Pre-condition 1–3 — Own physical row in CJ Incheon Aam: available 120, CS 20 (CS-usable 20), CS managed', async () => {
      sku = await ownRow(world, 'TC229', cj, { available: 120, cs: 20, csManaged: true });
      await list.open('ko');
      await conv.showSku(sku);
    });

    await step('Act: Step 1 — Tick the row, click 재고 전환 and pick CS재고 확보 (가용재고 → CS재고)', async () => {
      await conv.openFor([{ row: list.row(sku.skuCode, cj.name), label: sku.skuCode }]);
      await conv.choose('SECURE_CS');
    });

    await step('Assert: Expected 1 — The dialog opens with 1 row', async () => {
      await expect(dialog.rows, '[Expected 1] The dialog holds 1 row').toHaveCount(1);
    });

    await step('Act: Step 2 — Read the (전환 전 구분) 현재수량 and (전환 후 구분) 현재수량 cells', async () => {
      await expect(conv.fromCell(0), 'The source cell is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — The source cell shows 120 (available) and the target cell 20 (CS-usable)', async () => {
      await expect(conv.fromCell(0), '[Expected 2] The source cell shows 120, the available stock').toHaveText('120');
      await expect(conv.toCell(0), '[Expected 2] The target cell shows 20, the CS-usable stock').toHaveText('20');
    });

    await step('Act: Step 3 — Type 30 into 전환수량 and click 저장', async () => {
      await dialog.fillLine(0, { quantity: '30' });
      saved = await conv.saveAndReload();
    });

    await step('Assert: Expected 3 — The save goes through and shows 등록되었습니다 (Registered.)', async () => {
      expect(saved.status, `[Expected 3] The save goes through (${brief(saved)})`).toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 3] The message ${t('msg.registered')} appears`).toContainText(t('msg.registered'));
    });

    await step('Act: Step 4 — Read 가용재고 and CS재고(가용재고) on the reloaded row', async () => {
      after = await readNumbers(list, sku, cj);
    });

    await step('Assert: Expected 4 — Available 90 and CS available 50, each moved by exactly 30', async () => {
      expect(after.available, '[Expected 4] 가용재고 shows 90 (120 − 30)').toBe(90);
      expect(after.cs, '[Expected 4] CS재고(가용재고) shows 50 (20 + 30)').toBe(50);
    });
  });

  test('TC_US134_230 — Releasing CS stock on a managed row moves 20 from CS stock to available', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    const { warehouse, note } = daegu(world);
    await tcMeta(
      'TC_US134_230',
      'Critical',
      TAGS,
      `With CS재고 해제 on a CS-managed row (available 200, CS 50) the source cell reads 50 (CS-usable) and the target cell 200; saving 20 shows 등록되었습니다 and the row reads CS 30 · available 220. ${CS_USABLE_NOTE} ${note} ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    let sku!: WorldSku;
    let saved!: ConversionSave;
    let after!: RowNumbers;

    await step('Arrange: Pre-condition 1–3 — Own physical row in CJ Daegu warehouse: available 200, CS 50 (CS-usable 50), CS managed', async () => {
      sku = await ownRow(world, 'TC230', warehouse, { available: 200, cs: 50, csManaged: true });
      await list.open('ko');
      await conv.showSku(sku);
    });

    await step('Act: Step 1 — Tick the row, click 재고 전환 and pick CS재고 해제 (CS재고 → 가용재고)', async () => {
      await conv.openFor([{ row: list.row(sku.skuCode, warehouse.name), label: sku.skuCode }]);
      await conv.choose('RELEASE_CS');
    });

    await step('Assert: Expected 1 — The dialog opens with 1 row', async () => {
      await expect(dialog.rows, '[Expected 1] The dialog holds 1 row').toHaveCount(1);
    });

    await step('Act: Step 2 — Read the source and target current quantity cells', async () => {
      await expect(conv.fromCell(0), 'The source cell is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — The source cell shows 50 (CS-usable) and the target cell 200 (available)', async () => {
      await expect(conv.fromCell(0), '[Expected 2] The source cell shows 50, the CS-usable stock').toHaveText('50');
      await expect(conv.toCell(0), '[Expected 2] The target cell shows 200, the available stock').toHaveText('200');
    });

    await step('Act: Step 3 — Type 20 into 전환수량 and click 저장', async () => {
      await dialog.fillLine(0, { quantity: '20' });
      saved = await conv.saveAndReload();
    });

    await step('Assert: Expected 3 — The save goes through and shows 등록되었습니다 (Registered.)', async () => {
      expect(saved.status, `[Expected 3] The save goes through (${brief(saved)})`).toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 3] The message ${t('msg.registered')} appears`).toContainText(t('msg.registered'));
    });

    await step('Act: Step 4 — Read 가용재고 and CS재고(가용재고) on the reloaded row', async () => {
      after = await readNumbers(list, sku, warehouse);
    });

    await step('Assert: Expected 4 — CS available 30 and available 220, each moved by exactly 20', async () => {
      expect(after.cs, '[Expected 4] CS재고(가용재고) shows 30 (50 − 20)').toBe(30);
      expect(after.available, '[Expected 4] 가용재고 shows 220 (200 + 20)').toBe(220);
    });
  });

  test('TC_US134_231 — Setting stock on hold moves 30 from available to on-hold stock and the qty-after cell reads 10 + 30', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_231',
      'Critical',
      TAGS,
      `With 보류재고 지정 on a row with available 120 and on hold 10 the source cell reads 120, the target cell 10 and the qty-after cell a dash; typing 30 makes the qty-after cell 40; saving shows 등록되었습니다, available 90 and on hold 40. ${HOLD_NOTE} ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    const cj = world.warehouses.CJ;
    let sku!: WorldSku;
    let saved!: ConversionSave;
    let after!: RowNumbers;

    await step('Arrange: Pre-condition 1–3 — Own physical row in CJ Incheon Aam: available 120, on hold 10', async () => {
      sku = await ownRow(world, 'TC231', cj, { available: 120, hold: 10, csManaged: true });
      await list.open('ko');
      await conv.showSku(sku);
    });

    await step('Act: Step 1 — Tick the row, click 재고 전환 and pick 보류재고 지정 (가용재고 → 보류재고)', async () => {
      await conv.openFor([{ row: list.row(sku.skuCode, cj.name), label: sku.skuCode }]);
      await conv.choose('SECURE_HOLD');
    });

    await step('Assert: Expected 1 — The dialog opens with 1 row', async () => {
      await expect(dialog.rows, '[Expected 1] The dialog holds 1 row').toHaveCount(1);
    });

    await step('Act: Step 2 — Read the source, target and qty-after cells', async () => {
      await expect(conv.afterCell(0), 'The qty-after cell is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — Source 120, target 10, qty-after a dash', async () => {
      await expect(conv.fromCell(0), '[Expected 2] The source cell shows 120').toHaveText('120');
      await expect(conv.toCell(0), '[Expected 2] The target cell shows 10').toHaveText('10');
      await expect(conv.afterCell(0), '[Expected 2] The qty-after cell shows a dash').toHaveText('-');
    });

    await step('Act: Step 3 — Type 30 into 전환수량 and read the qty-after cell again', async () => {
      await dialog.fillLine(0, { quantity: '30' });
    });

    await step('Assert: Expected 3 — The qty-after cell shows 40 (10 + 30)', async () => {
      await expect(conv.afterCell(0), '[Expected 3] The qty-after cell shows 40').toHaveText('40');
    });

    await step('Act: Step 4 — Click 저장, then read 가용재고 on the reloaded row and 보류재고 from the inventory data source', async () => {
      saved = await conv.saveAndReload();
      after = await readNumbers(list, sku, cj);
    });

    await step('Assert: Expected 4 — 등록되었습니다, available 90 and on hold 40', async () => {
      expect(saved.status, `[Expected 4] The save goes through (${brief(saved)})`).toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 4] The message ${t('msg.registered')} appears`).toContainText(t('msg.registered'));
      expect(after.available, '[Expected 4] 가용재고 shows 90').toBe(90);
      expect(after.hold, '[Expected 4] 보류재고 shows 40').toBe(40);
    });
  });

  test('TC_US134_232 — Releasing on-hold stock moves 10 from on-hold to available stock', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_232',
      'Critical',
      TAGS,
      `With 보류재고 해제 on a row with available 120 and on hold 10 the source cell reads 10 and the target cell 120; saving 10 shows 등록되었습니다, on hold 0 and available 130. ${HOLD_NOTE} ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    const cj = world.warehouses.CJ;
    let sku!: WorldSku;
    let saved!: ConversionSave;
    let after!: RowNumbers;

    await step('Arrange: Pre-condition 1–3 — Own physical row in CJ Incheon Aam: available 120, on hold 10', async () => {
      sku = await ownRow(world, 'TC232', cj, { available: 120, hold: 10, csManaged: true });
      await list.open('ko');
      await conv.showSku(sku);
    });

    await step('Act: Step 1 — Tick the row, click 재고 전환 and pick 보류재고 해제 (보류재고 → 가용재고)', async () => {
      await conv.openFor([{ row: list.row(sku.skuCode, cj.name), label: sku.skuCode }]);
      await conv.choose('RELEASE_HOLD');
    });

    await step('Assert: Expected 1 — The dialog opens with 1 row', async () => {
      await expect(dialog.rows, '[Expected 1] The dialog holds 1 row').toHaveCount(1);
    });

    await step('Act: Step 2 — Read the source and target current quantity cells', async () => {
      await expect(conv.fromCell(0), 'The source cell is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — The source cell shows 10 (on hold) and the target cell 120 (available)', async () => {
      await expect(conv.fromCell(0), '[Expected 2] The source cell shows 10, the on-hold quantity').toHaveText('10');
      await expect(conv.toCell(0), '[Expected 2] The target cell shows 120, the available stock').toHaveText('120');
    });

    await step('Act: Step 3 — Type 10 into 전환수량 and click 저장', async () => {
      await dialog.fillLine(0, { quantity: '10' });
      saved = await conv.saveAndReload();
    });

    await step('Assert: Expected 3 — The save goes through and shows 등록되었습니다 (Registered.)', async () => {
      expect(saved.status, `[Expected 3] The save goes through (${brief(saved)})`).toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 3] The message ${t('msg.registered')} appears`).toContainText(t('msg.registered'));
    });

    await step('Act: Step 4 — Read 가용재고 on the reloaded row and 보류재고 from the inventory data source', async () => {
      after = await readNumbers(list, sku, cj);
    });

    await step('Assert: Expected 4 — On hold 0 and available 130', async () => {
      expect(after.hold, '[Expected 4] 보류재고 shows 0').toBe(0);
      expect(after.available, '[Expected 4] 가용재고 shows 130').toBe(130);
    });
  });

  test('TC_US134_233 — Total stock stays at 250 after each of the first four conversion types', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    const { warehouse, note } = daegu(world);
    await tcMeta(
      'TC_US134_233',
      'Critical',
      TAGS,
      `On a CS-managed row with total 250 (available 200, CS 50, on hold 0): CS재고 확보 30 → 170 / 80 / 250, CS재고 해제 30 → 200 / 50 / 250, 보류재고 지정 20 → 180 / on hold 20 / 250, 보류재고 해제 20 → 200 / on hold 0 / 250. ${HOLD_NOTE} ${note} ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    let sku!: WorldSku;
    const seen: Record<number, RowNumbers> = {};
    const saves: Record<number, ConversionSave> = {};
    const row = () => list.row(sku.skuCode, warehouse.name);

    await step('Arrange: Pre-condition 1–2 — Own physical row in CJ Daegu warehouse: total 250, available 200, CS 50, on hold 0, CS managed', async () => {
      sku = await ownRow(world, 'TC233', warehouse, { available: 200, cs: 50, hold: 0, csManaged: true });
    });

    await step('Act: Step 1 — Open 재고 관리 and find the row', async () => {
      await list.open('ko');
      await conv.showSku(sku);
    });

    await step('Assert: Expected 1 — The row is displayed', async () => {
      await expect(row(), '[Expected 1] The row is shown on the list').toBeVisible();
    });

    await step('Act: Step 2 — Record 전체재고, 가용재고, CS재고(가용재고) and 보류재고 before conversion', async () => {
      seen[2] = await readNumbers(list, sku, warehouse);
    });

    await step('Assert: Expected 2 — Before conversion: available 200, CS 50, on hold 0, total 250', async () => {
      expect(seen[2].available, '[Expected 2] Available stock = 200').toBe(200);
      expect(seen[2].cs, '[Expected 2] CS stock — available = 50').toBe(50);
      expect(seen[2].hold, '[Expected 2] On-hold stock = 0').toBe(0);
      expect(seen[2].total, '[Expected 2] Total stock = 250').toBe(250);
    });

    const rounds = [
      { n: 3, policy: 'SECURE_CS', label: 'CS재고 확보 (가용재고 → CS재고)', qty: '30', expected: { available: 170, cs: 80, total: 250 } },
      { n: 4, policy: 'RELEASE_CS', label: 'CS재고 해제 (CS재고 → 가용재고)', qty: '30', expected: { available: 200, cs: 50, total: 250 } },
      { n: 5, policy: 'SECURE_HOLD', label: '보류재고 지정 (가용재고 → 보류재고)', qty: '20', expected: { available: 180, hold: 20, total: 250 } },
      { n: 6, policy: 'RELEASE_HOLD', label: '보류재고 해제 (보류재고 → 가용재고)', qty: '20', expected: { available: 200, hold: 0, total: 250 } },
    ] as const;

    for (const round of rounds) {
      await step(`Act: Step ${round.n} — Convert ${round.qty} with ${round.label}, then read the values again`, async () => {
        saves[round.n] = await conv.runConversion(row(), sku.skuCode, round.policy, round.qty);
        seen[round.n] = await readNumbers(list, sku, warehouse);
      });

      await step(`Assert: Expected ${round.n} — ${Object.entries(round.expected).map(([k, v]) => `${k} = ${v}`).join(', ')}`, async () => {
        expect(saves[round.n].status, `[Expected ${round.n}] The ${round.policy} save goes through (${brief(saves[round.n])})`).toBeLessThan(300);
        for (const [key, value] of Object.entries(round.expected)) {
          expect(seen[round.n][key as keyof RowNumbers], `[Expected ${round.n}] ${key} = ${value}`).toBe(value);
        }
      });
    }
  });

  test('TC_US134_234 — Scrapping on-hold stock lowers the source total and lands in the DEFECTIVE warehouse as on-hold stock', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    const cj = world.warehouses.CJ;
    const defective = world.bucket(cj, '불량');
    await tcMeta(
      'TC_US134_234',
      'Critical',
      TAGS,
      `On a row with total 190 and on hold 10 in CJ Incheon Aam, 불량 처리 5 shows 등록되었습니다; on hold falls to 5 and total to 185, and a stock row appears in CJ Incheon Aam's own DEFECTIVE bucket (${defective.name}) with on hold 5 and available 0. ${HOLD_NOTE} ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    let sku!: WorldSku;
    let before!: RowNumbers;
    let baseline: StoredBuckets | null = null;
    let baselineListed = 0;
    let saved!: ConversionSave;
    let after!: RowNumbers;
    let landed: StoredBuckets | null = null;
    let landedListed = 0;

    await step('Arrange: Pre-condition 1–5 — Own row in CJ Incheon Aam: total 190, on hold 10; CJ Incheon Aam has its DEFECTIVE bucket with no row for this SKU', async () => {
      sku = await ownRow(world, 'TC234', cj, { available: 120, reserved: 40, cs: 20, hold: 10, csManaged: true });
    });

    await step('Act: Step 1 — Open 재고 관리 and find the row in CJ Incheon Aam', async () => {
      await list.open('ko');
      await conv.showSku(sku);
    });

    await step('Assert: Expected 1 — The row is shown for CJ Incheon Aam', async () => {
      await expect(list.row(sku.skuCode, cj.name), '[Expected 1] The row is shown for CJ Incheon Aam').toBeVisible();
    });

    await step('Act: Step 2 — Read 전체재고 on that row and 보류재고 from the inventory data source', async () => {
      before = await readNumbers(list, sku, cj);
    });

    await step('Assert: Expected 2 — 전체재고 190 and 보류재고 10', async () => {
      expect(before.total, '[Expected 2] 전체재고 reads 190').toBe(190);
      expect(before.hold, '[Expected 2] 보류재고 reads 10').toBe(10);
    });

    await step('Act: Step 3 — Read the quantity of the SKU in the DEFECTIVE bucket of CJ Incheon Aam', async () => {
      baselineListed = await list.row(sku.skuCode, defective.name).count();
      baseline = await storedBuckets(sku.skuId, defective.id);
    });

    await step('Assert: Expected 3 — No stock row in that DEFECTIVE bucket, so the baseline is 0', async () => {
      expect(baselineListed, '[Expected 3] The list shows no row for the DEFECTIVE bucket').toBe(0);
      expect(baseline, '[Expected 3] The stock table holds no row for the DEFECTIVE bucket').toBeNull();
    });

    await step('Act: Step 4 — Tick the row and click 재고 전환', async () => {
      await conv.openFor([{ row: list.row(sku.skuCode, cj.name), label: sku.skuCode }]);
    });

    await step('Assert: Expected 4 — The 재고 전환 dialog opens with 1 row', async () => {
      await expect(dialog.root, '[Expected 4] The dialog is open').toBeVisible();
      await expect(dialog.rows, '[Expected 4] The dialog holds 1 row').toHaveCount(1);
    });

    await step('Act: Step 5 — Set 전환 구분 to 불량 처리 (보류재고 → 불량)', async () => {
      await conv.choose('SCRAP_DEFECTIVE');
    });

    await step('Assert: Expected 5 — The dialog shows 불량 처리 (보류재고 → 불량) as the conversion type', async () => {
      await expect(dialog.policySelect, '[Expected 5] The choice is taken').toHaveValue('SCRAP_DEFECTIVE');
      await expect(conv.selectedPolicyText(), `[Expected 5] The field shows ${t('policy.SCRAP_DEFECTIVE')}`).toHaveText(t('policy.SCRAP_DEFECTIVE'));
    });

    await step('Act: Step 6 — Enter 전환수량 5 and click 저장', async () => {
      await dialog.fillLine(0, { quantity: '5' });
      saved = await conv.saveAndReload();
    });

    await step('Assert: Expected 6 — The save goes through and 등록되었습니다 (Registered.) is shown', async () => {
      expect(saved.status, `[Expected 6] The save goes through (${brief(saved)})`).toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 6] The message ${t('msg.registered')} appears`).toContainText(t('msg.registered'));
    });

    await step('Act: Step 7 — Read 전체재고 on the reloaded row and 보류재고 from the inventory data source', async () => {
      after = await readNumbers(list, sku, cj);
    });

    await step('Assert: Expected 7 — 보류재고 10 → 5 and 전체재고 190 → 185 (the stock leaves the warehouse)', async () => {
      expect(after.hold, '[Expected 7] 보류재고 falls from 10 to 5').toBe(5);
      expect(after.total, '[Expected 7] 전체재고 falls from 190 to 185 — 190 would mean a move between buckets of the same row').toBe(185);
    });

    await step('Act: Step 8 — Read the quantity of the SKU in the DEFECTIVE bucket of CJ Incheon Aam again', async () => {
      landedListed = await list.row(sku.skuCode, defective.name).count();
      landed = await storedBuckets(sku.skuId, defective.id);
    });

    await step('Assert: Expected 8 — A DEFECTIVE row now exists with 보류재고 5 and 가용재고 0', async () => {
      expect(landedListed, '[Expected 8] The list now shows a row for the DEFECTIVE bucket').toBe(1);
      expect(landed, '[Expected 8] The stock table holds a row for the DEFECTIVE bucket').not.toBeNull();
      expect(landed?.hold, '[Expected 8] 보류재고 of the DEFECTIVE row = 5').toBe(5);
      expect(landed?.available, '[Expected 8] 가용재고 of the DEFECTIVE row = 0 — the goods cannot be picked for an order').toBe(0);
    });
  });

  test('TC_US134_235 — Both guards block 재고 전환 with the conversion wording', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_235',
      'Medium',
      TAGS,
      `With nothing ticked 재고 전환 shows "${squash(t('guard.noSelection'))}" and opens no dialog; with only DEMO-SKU-0005 (physical, no warehouse) ticked 재고 전환 shows "${squash(t('guard.noWarehouseConversion'))}" and 재고 조정 shows "${squash(t('guard.noWarehouseAdjustment'))}" — the second sentences differ. ${WORLD_NOTE}`,
    );
    const list = new StockCalculationPage(page);
    const noWarehouse = world.sku('SKU0005');
    const texts: Record<string, string> = {};

    await step('Arrange: Pre-condition 1–2 — DEMO-SKU-0005 (physical, no warehouse) and DEMO-SKU-0001 in CJ Incheon Aam are on the list', async () => {
      await showWorld(list, world);
      await expect(list.row(noWarehouse.skuCode), 'DEMO-SKU-0005 is listed').toBeVisible();
      await expect(list.row(world.sku('SKU0001').skuCode, world.warehouses.CJ.name), 'DEMO-SKU-0001 @ CJ Incheon Aam is listed').toBeVisible();
    });

    await step('Act: Step 1 — With nothing ticked, click 재고 전환', async () => {
      texts.none = await list.guardTextAfter('btn.convertStock');
    });

    await step('Assert: Expected 1 — The action is blocked', async () => {
      await expect(list.guardAlert, '[Expected 1] A guard message blocks the action').toBeVisible();
    });

    await step('Act: Step 2 — Read the message and look for any dialog', async () => {
      await expect(list.guardAlert, 'The guard message is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — "선택된 재고가 없습니다. 재고를 선택해주세요." and no dialog opens', async () => {
      expect(texts.none, `[Expected 2] The message is ${squash(t('guard.noSelection'))}`).toBe(squash(t('guard.noSelection')));
      await expect(page.locator('.modal.show[role="dialog"]'), '[Expected 2] No dialog opens').toHaveCount(0);
    });

    await step('Act: Step 3 — Tick only DEMO-SKU-0005, click 재고 전환 and read the message', async () => {
      await list.tick(list.row(noWarehouse.skuCode), noWarehouse.skuCode);
      texts.conversion = await list.guardTextAfter('btn.convertStock');
    });

    await step('Assert: Expected 3 — The conversion wording "… 재고 전환은 창고 등록 후 가능합니다."', async () => {
      expect(texts.conversion, `[Expected 3] The message is ${squash(t('guard.noWarehouseConversion'))}`).toBe(squash(t('guard.noWarehouseConversion')));
    });

    await step('Act: Step 4 — With DEMO-SKU-0005 still ticked, click 재고 조정 and read that message', async () => {
      texts.adjustment = await list.guardTextAfter('btn.adjustStock');
    });

    await step('Assert: Expected 4 — The adjustment wording "… 재고조정은 창고 등록 후 가능합니다."', async () => {
      expect(texts.adjustment, `[Expected 4] The message is ${squash(t('guard.noWarehouseAdjustment'))}`).toBe(squash(t('guard.noWarehouseAdjustment')));
    });

    let second: string[] = [];
    await step('Act: Step 5 — Compare the 2 messages from step 3 and step 4', async () => {
      second = [texts.conversion, texts.adjustment].map((text) => text.split(/(?<=\.)\s+/)[1] ?? '');
    });

    await step('Assert: Expected 5 — The second sentence of the 2 messages differs', async () => {
      expect(second[0], '[Expected 5] The conversion message has a second sentence').not.toBe('');
      expect(second[0], '[Expected 5] The second sentences of the conversion and adjustment messages differ').not.toBe(second[1]);
    });
  });

  test('TC_US134_236 — The conversion type offers exactly its 5 policies and only the fifth names a warehouse', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    const cj = world.warehouses.CJ;
    const row = world.row('SKU0001', cj);
    const defective = world.bucket(cj, '불량');
    await tcMeta(
      'TC_US134_236',
      'Medium',
      TAGS,
      `On DEMO-SKU-0001 (CS managed) 전환 구분 starts at 선택 and offers exactly the 5 policies written in full; the first 4 name a destination among the row's number cells (가용재고 / CS재고 / 보류재고), the fifth names 불량 — the DEFECTIVE virtual warehouse (${defective.name}), not a number cell. The dialog is opened on the shared row and closed without saving. ${WORLD_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    let options: string[] = [];
    const bucketCells = ['가용재고', 'CS재고', '보류재고'];

    await step('Arrange: Pre-condition 1–2 — DEMO-SKU-0001 in CJ Incheon Aam is CS managed', async () => {
      expect(row.buckets.csManaged, 'DEMO-SKU-0001 @ CJ Incheon Aam is CS managed').toBe(true);
      await showWorld(list, world);
    });

    await step('Act: Step 1 — Tick DEMO-SKU-0001, click 재고 전환 and read 전환 구분 before picking anything', async () => {
      await conv.openFor([{ row: list.row(row.sku.skuCode, cj.name), label: row.sku.skuCode }]);
    });

    await step('Assert: Expected 1 — The field shows the placeholder 선택 and no policy is picked', async () => {
      await expect(dialog.policySelect, '[Expected 1] No policy is picked yet').toHaveValue('');
      await expect(conv.selectedPolicyText(), `[Expected 1] The field shows ${t('convert.policyPlaceholder')}`).toHaveText(t('convert.policyPlaceholder'));
    });

    await step('Act: Step 2 — Open the dropdown and count the choices', async () => {
      options = await conv.policyOptions();
    });

    await step('Assert: Expected 2 — There are exactly 5 choices', async () => {
      expect(options.length, '[Expected 2] The dropdown has exactly 5 choices').toBe(5);
    });

    await step('Act: Step 3 — Read each choice in full', async () => {
      options = await conv.policyOptions();
    });

    await step('Assert: Expected 3 — The 5 choices are the 5 settled policies, written in full', async () => {
      for (const key of ['policy.SECURE_CS', 'policy.RELEASE_CS', 'policy.SECURE_HOLD', 'policy.RELEASE_HOLD', 'policy.SCRAP_DEFECTIVE'] as const) {
        expect(options, `[Expected 3] The dropdown offers ${t(key)}`).toContain(t(key));
      }
    });

    let destinations: string[] = [];
    await step('Act: Step 4 — Check which label names a WAREHOUSE as the destination rather than a number cell', async () => {
      destinations = options.map((option) => /→\s*([^)]+)\)\s*$/.exec(option)?.[1].trim() ?? '');
    });

    await step('Assert: Expected 4 — The first 4 labels go between number cells of the row; the fifth names 불량, a virtual warehouse', async () => {
      destinations.slice(0, 4).forEach((destination, index) => {
        expect(bucketCells, `[Expected 4] Choice ${index + 1} (${options[index]}) names a number cell of the row as destination`).toContain(destination);
      });
      expect(destinations[4], `[Expected 4] Choice 5 (${options[4]}) names 불량 as the destination`).toBe('불량');
      expect(bucketCells, '[Expected 4] 불량 is not a number cell on the stock row').not.toContain(destinations[4]);
      expect(defective.virtual, `[Expected 4] 불량 is a virtual WAREHOUSE (${defective.name}) in the warehouse catalogue`).toBe(true);
      expect(defective.name.endsWith(` - ${destinations[4]}`), `[Expected 4] The warehouse ${defective.name} is the 불량 warehouse of CJ Incheon Aam`).toBe(true);
    });
  });

  test('TC_US134_237 — With scrap-as-defective the source cell reads on-hold stock and the target / qty-after cells stay a dash', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    const cj = world.warehouses.CJ;
    const row = world.row('SKU0001', cj);
    await tcMeta(
      'TC_US134_237',
      'Medium',
      TAGS,
      `On DEMO-SKU-0001 (available 120, on hold 10) 불량 처리 makes the source cell read 10 (on-hold stock), the target cell a dash (the target is a warehouse), and the qty-after cell stays a dash after 5 is typed. The dialog is opened on the shared row and nothing is saved. ${WORLD_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);

    await step('Arrange: Pre-condition 1–4 — DEMO-SKU-0001 in CJ Incheon Aam: available 120, on hold 10; CJ Incheon Aam has a DEFECTIVE bucket', async () => {
      expect(row.buckets.available, 'DEMO-SKU-0001 has available 120').toBe(120);
      expect(row.buckets.hold, 'DEMO-SKU-0001 has on hold 10').toBe(10);
      expect(world.bucket(cj, '불량').id, 'CJ Incheon Aam has its DEFECTIVE bucket').toBeGreaterThan(0);
      await showWorld(list, world);
    });

    await step('Act: Step 1 — Tick DEMO-SKU-0001, click 재고 전환 and pick 불량 처리 (보류재고 → 불량)', async () => {
      await conv.openFor([{ row: list.row(row.sku.skuCode, cj.name), label: row.sku.skuCode }]);
      await conv.choose('SCRAP_DEFECTIVE');
    });

    await step('Assert: Expected 1 — The dialog opens with 1 row', async () => {
      await expect(dialog.rows, '[Expected 1] The dialog holds 1 row').toHaveCount(1);
    });

    await step('Act: Step 2 — Read the (전환 전 구분) 현재수량 cell', async () => {
      await expect(conv.fromCell(0), 'The source cell is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — The source cell shows 10, the on-hold stock', async () => {
      await expect(conv.fromCell(0), '[Expected 2] The source cell shows 10 (보류재고), not the available 120').toHaveText('10');
    });

    await step('Act: Step 3 — Read the (전환 후 구분) 현재수량 cell', async () => {
      await expect(conv.toCell(0), 'The target cell is shown').toBeVisible();
    });

    await step('Assert: Expected 3 — The target cell shows a dash', async () => {
      await expect(conv.toCell(0), '[Expected 3] The target cell shows a dash (-)').toHaveText('-');
    });

    await step('Act: Step 4 — Type 5 into 전환수량 and read the (전환 후 구분) 전환 후 수량 cell', async () => {
      await dialog.fillLine(0, { quantity: '5' });
    });

    await step('Assert: Expected 4 — The qty-after cell still shows a dash', async () => {
      await expect(dialog.quantityInput(0), 'The quantity field holds 5').toHaveValue('5');
      await expect(conv.afterCell(0), '[Expected 4] The qty-after cell still shows a dash (-)').toHaveText('-');
    });
  });

  test('TC_US134_238 — Scrap-as-defective names the destination warehouse on the dialog before Save', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    const cj = world.warehouses.CJ;
    const row = world.row('SKU0001', cj);
    const defective = world.bucket(cj, '불량');
    await tcMeta(
      'TC_US134_238',
      'Medium',
      TAGS,
      `With 불량 처리 picked the dialog names the destination warehouse — CJ Incheon Aam's own DEFECTIVE bucket "${defective.name}" — before 저장; picking another policy removes it. Deviation TC ≠ UI (frontend bundle 05/10, confirmed by the 06/10 run): the dialog shows only the generic warning "${t('convert.crossWarehouseNotice')}" without the warehouse name — Expected 2–3 are asserted as the TC writes them (soft, so Expected 4 still runs). The dialog is opened on the shared row and nothing is saved. ${WORLD_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    let bodyText = '';

    await step('Arrange: Pre-condition 1–3 — DEMO-SKU-0001 in CJ Incheon Aam with on hold 10; CJ Incheon Aam has its own named DEFECTIVE bucket', async () => {
      expect(row.buckets.hold, 'DEMO-SKU-0001 has on hold 10').toBe(10);
      expect(defective.name, 'The DEFECTIVE bucket of CJ Incheon Aam has a name').not.toBe('');
      await showWorld(list, world);
    });

    await step('Act: Step 1 — Tick DEMO-SKU-0001, click 재고 전환 and pick 불량 처리 (보류재고 → 불량)', async () => {
      await conv.openFor([{ row: list.row(row.sku.skuCode, cj.name), label: row.sku.skuCode }]);
      await conv.choose('SCRAP_DEFECTIVE');
    });

    await step('Assert: Expected 1 — The dialog opens with 1 row', async () => {
      await expect(dialog.rows, '[Expected 1] The dialog holds 1 row').toHaveCount(1);
    });

    await step('Act: Step 2 — Read the whole dialog, looking for where the destination warehouse is named', async () => {
      bodyText = squash(await dialog.body.innerText());
    });

    await step('Assert: Expected 2 — The dialog names the destination warehouse in words, before the Save button', async () => {
      expect.soft(bodyText, '[Expected 2] The dialog body (above the footer with 저장) names a 불량 warehouse').toMatch(/\S+ - 불량/);
    });

    await step("Act: Step 3 — Compare that name with CJ Incheon Aam's own DEFECTIVE bucket in the warehouse master", async () => {
      bodyText = squash(await dialog.body.innerText());
    });

    await step("Assert: Expected 3 — The name matches CJ Incheon Aam's own DEFECTIVE bucket", async () => {
      expect.soft(bodyText, `[Expected 3] The dialog names ${defective.name}`).toContain(defective.name);
    });

    await step('Act: Step 4 — Pick one of the other 4 policies and look for the destination name again', async () => {
      await conv.choose('SECURE_HOLD');
      bodyText = squash(await dialog.body.innerText());
    });

    await step('Assert: Expected 4 — The destination name is gone', async () => {
      expect(bodyText, `[Expected 4] ${defective.name} is no longer named`).not.toContain(defective.name);
      await expect(dialog.crossWarehouseNotice, '[Expected 4] The scrap-as-defective warning is gone').toHaveCount(0);
    });
  });

  test('TC_US134_239 — Scrap-as-defective still works on a row with CS management switched off', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_239',
      'Medium',
      TAGS,
      `On a 관리안함 row with on hold 10, CS재고 확보 greys out 전환수량 and the CS side shows 관리안함; switching to 불량 처리 makes the field usable without 관리안함, and saving 5 shows 등록되었습니다. The TC raises the seed on-hold 0 to 10 with a 보류재고 지정 conversion first; here the row is seeded with on hold 10 directly. ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    const cj = world.warehouses.CJ;
    let sku!: WorldSku;
    let saved!: ConversionSave;

    await step('Arrange: Pre-condition 1–3 — Own row in CJ Incheon Aam, CS 관리안함, on hold 10', async () => {
      sku = await ownRow(world, 'TC239', cj, { available: 40, hold: 10, csManaged: false });
      await list.open('ko');
      await conv.showSku(sku);
    });

    await step('Act: Step 1 — Tick the row, click 재고 전환 and pick CS재고 확보 (가용재고 → CS재고)', async () => {
      await conv.openFor([{ row: list.row(sku.skuCode, cj.name), label: sku.skuCode }]);
      await conv.choose('SECURE_CS');
    });

    await step('Assert: Expected 1 — The dialog opens with 1 row', async () => {
      await expect(dialog.rows, '[Expected 1] The dialog holds 1 row').toHaveCount(1);
    });

    await step('Act: Step 2 — Read the state of the 전환수량 field', async () => {
      await expect(dialog.quantityInput(0), 'The quantity field is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — The field is greyed out and the CS side shows 관리안함', async () => {
      await expect(dialog.quantityInput(0), '[Expected 2] 전환수량 is greyed out').toBeDisabled();
      await expect(conv.toCell(0), `[Expected 2] The CS side shows ${t('label.notManaged')}`).toHaveText(t('label.notManaged'));
    });

    await step('Act: Step 3 — Switch to 불량 처리 (보류재고 → 불량) and read the field again', async () => {
      await conv.choose('SCRAP_DEFECTIVE');
    });

    await step('Assert: Expected 3 — The field turns usable and 관리안함 is gone', async () => {
      await expect(dialog.quantityInput(0), '[Expected 3] 전환수량 is usable').toBeEnabled();
      await expect(dialog.rows.nth(0), `[Expected 3] ${t('label.notManaged')} is gone from the row`).not.toContainText(t('label.notManaged'));
    });

    await step('Act: Step 4 — Type 5 and click 저장', async () => {
      await dialog.fillLine(0, { quantity: '5' });
      saved = await conv.saveAndReload();
    });

    await step('Assert: Expected 4 — The save goes through and shows 등록되었습니다 (Registered.)', async () => {
      expect(saved.status, `[Expected 4] The save goes through (${brief(saved)})`).toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 4] The message ${t('msg.registered')} appears`).toContainText(t('msg.registered'));
    });
  });

  test('TC_US134_240 — Scrap-as-defective is blocked and nothing moves when the source warehouse has no defective bucket', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    const sentence = '불량 재고 창고가 설정되어 있지 않습니다. 관리자에게 문의해주세요.';
    await tcMeta(
      'TC_US134_240',
      'High',
      TAGS,
      `Saving 불량 처리 5 for a row (total 190, on hold 10) whose source warehouse has no DEFECTIVE child bucket is refused with WH-STOCK_DEFECTIVE_WAREHOUSE_MISSING [proposed] "${sentence}" followed by "- warehouseId: {id}" of the source warehouse; on hold stays 10 and total 190. Data: the source warehouse is an automation general warehouse created for this test (CJ Incheon Aam is shared by every test), and its DEFECTIVE bucket is detached by DB fixture (location_warehouse_id cleared) for the duration of the test and re-attached afterwards. ${HOLD_NOTE} ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    let source!: WorldWarehouse;
    let bucketId: number | null = null;
    let sku!: WorldSku;
    let result: ConversionSave | null = null;
    let after!: RowNumbers;

    try {
      await step('Arrange: Pre-condition 1–4 — Own row (on hold 10, total 190) in a source warehouse with NO DEFECTIVE child bucket', async () => {
        source = asWorldWarehouse(await world.createWarehouse('TC240 source', 'PLATFORM_GENERAL'));
        bucketId = await defectiveBucketId(source.id);
        if (bucketId) await setBucketParent(bucketId, null);
        expect(await defectiveBucketId(source.id), 'The source warehouse has no DEFECTIVE child bucket').toBeNull();
        sku = await ownRow(world, 'TC240', source, { available: 180, hold: 10 });
        await list.open('ko');
        await conv.showSku(sku);
      });

      await step('Act: Step 1 — Tick the row, click 재고 전환 and pick 불량 처리 (보류재고 → 불량)', async () => {
        await conv.openFor([{ row: list.row(sku.skuCode, source.name), label: sku.skuCode }]);
        await conv.choose('SCRAP_DEFECTIVE');
      });

      await step('Assert: Expected 1 — The dialog opens with 1 row', async () => {
        await expect(dialog.rows, '[Expected 1] The dialog holds 1 row').toHaveCount(1);
      });

      await step('Act: Step 2 — Type 5 into 전환수량 and click 저장', async () => {
        await dialog.fillLine(0, { quantity: '5' });
        result = await conv.trySave(15_000);
      });

      await step('Assert: Expected 2 — Saving is blocked', async () => {
        expect(!result || result.status >= 400, `[Expected 2] The save is refused (${brief(result)})`).toBe(true);
        await expect(dialog.root, '[Expected 2] The dialog stays open').toBeVisible();
      });

      await step('Act: Step 3 — Read the error code and the message', async () => {
        await expect(dialog.errorAlert, 'An error is shown in the dialog').toBeVisible();
      });

      await step('Assert: Expected 3 — WH-STOCK_DEFECTIVE_WAREHOUSE_MISSING with the message and "- warehouseId: {id}" of the source warehouse', async () => {
        const error = errorOf(result ?? { status: 0, body: {} });
        expect(error.code, '[Expected 3] The code is WH-STOCK_DEFECTIVE_WAREHOUSE_MISSING').toBe('WH-STOCK_DEFECTIVE_WAREHOUSE_MISSING');
        expect(error.message, `[Expected 3] The message is ${sentence}`).toContain(sentence);
        expect(error.message, `[Expected 3] The message carries - warehouseId: ${source.id}`).toContain(`- warehouseId: ${source.id}`);
        await expect(dialog.errorAlert, '[Expected 3] The dialog shows the message').toContainText(sentence);
      });

      await step('Act: Step 4 — Read 전체재고 on the list row and 보류재고 from the inventory data source', async () => {
        await conv.discard();
        after = await readNumbers(list, sku, source);
      });

      await step('Assert: Expected 4 — On hold still 10 and total still 190', async () => {
        expect(after.hold, '[Expected 4] 보류재고 is still 10').toBe(10);
        expect(after.total, '[Expected 4] 전체재고 is still 190').toBe(190);
      });
    } finally {
      if (bucketId) await setBucketParent(bucketId, source.id);
    }
  });

  test('TC_US134_241 — Scrap-as-defective is refused from the DEFECTIVE warehouse and lands in the parent DEFECTIVE bucket from a virtual warehouse', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    const cj = world.warehouses.CJ;
    const defective = asWorldWarehouse(world.bucket(cj, '불량'));
    const quarantine = asWorldWarehouse(world.bucket(cj, '이슈격리'));
    const sentence = '불량 창고의 재고는 불량 처리할 수 없습니다.';
    await tcMeta(
      'TC_US134_241',
      'High',
      TAGS,
      `불량 처리 5 on the DEFECTIVE row of CJ Incheon Aam (on hold 20) is rejected with WH-WAREHOUSE_NOT_SUPPORTED "${sentence} - warehouseId: {id}" and the dialog stays open; after 취소 + confirm, 불량 처리 5 on the QUARANTINE (이슈격리) row (on hold 10) saves with 등록되었습니다 — QUARANTINE 5, DEFECTIVE of the parent 25. Data: the 2 virtual rows are DB fixtures on the test's own SKU in the buckets of the automation CJ Incheon Aam. ${HOLD_NOTE} ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    let sku!: WorldSku;
    let rejected: ConversionSave | null = null;
    let saved!: ConversionSave;
    let quarantineAfter: StoredBuckets | null = null;
    let defectiveAfter: StoredBuckets | null = null;

    await step('Arrange: Pre-condition 1–4 — Own SKU rows in the DEFECTIVE bucket (on hold 20) and the QUARANTINE bucket (on hold 10) of CJ Incheon Aam', async () => {
      sku = await ownPhysicalSku(world, 'TC241');
      await world.seedStock(sku, defective, { available: 0, hold: 20 });
      await world.seedStock(sku, quarantine, { available: 0, hold: 10 });
      await list.open('ko');
      await conv.showSku(sku);
    });

    await step('Act: Step 1 — Tick the DEFECTIVE row, click 재고 전환, pick 불량 처리, type 5 and click 저장', async () => {
      await conv.openFor([{ row: list.row(sku.skuCode, defective.name), label: `${sku.skuCode} @ ${defective.name}` }]);
      await conv.choose('SCRAP_DEFECTIVE');
      await dialog.fillLine(0, { quantity: '5' });
      rejected = await conv.trySave(15_000);
    });

    await step('Assert: Expected 1 — Rejected with WH-WAREHOUSE_NOT_SUPPORTED and the dialog stays open', async () => {
      const error = errorOf(rejected ?? { status: 0, body: {} });
      expect(error.code, `[Expected 1] The code is WH-WAREHOUSE_NOT_SUPPORTED (${brief(rejected)})`).toBe('WH-WAREHOUSE_NOT_SUPPORTED');
      expect(error.message, `[Expected 1] The message is ${sentence}`).toContain(sentence);
      expect(error.message, `[Expected 1] The message carries - warehouseId: ${defective.id}`).toContain(`- warehouseId: ${defective.id}`);
      await expect(dialog.root, '[Expected 1] The dialog stays open').toBeVisible();
    });

    await step('Act: Step 2 — Click 취소 and confirm closing, then scrap 5 from the QUARANTINE row', async () => {
      await conv.discard();
      await list.checkbox(list.row(sku.skuCode, defective.name)).uncheck();
      await conv.openFor([{ row: list.row(sku.skuCode, quarantine.name), label: `${sku.skuCode} @ ${quarantine.name}` }]);
      await conv.choose('SCRAP_DEFECTIVE');
      await dialog.fillLine(0, { quantity: '5' });
      saved = await conv.saveAndReload();
    });

    await step('Assert: Expected 2 — The save goes through and shows 등록되었습니다 (Registered.)', async () => {
      expect(saved.status, `[Expected 2] The save goes through (${brief(saved)})`).toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 2] The message ${t('msg.registered')} appears`).toContainText(t('msg.registered'));
    });

    await step('Act: Step 3 — Read 보류재고 of both rows from the inventory data source', async () => {
      quarantineAfter = await storedBuckets(sku.skuId, quarantine.id);
      defectiveAfter = await storedBuckets(sku.skuId, defective.id);
    });

    await step('Assert: Expected 3 — QUARANTINE on hold 5 and the parent DEFECTIVE row on hold 25', async () => {
      expect(quarantineAfter?.hold, '[Expected 3] 보류재고 of the QUARANTINE row = 5').toBe(5);
      expect(defectiveAfter?.hold, '[Expected 3] 보류재고 of the DEFECTIVE row of CJ Incheon Aam = 25').toBe(25);
    });
  });

  test('TC_US134_242 — No reverse direction is offered after scrap-as-defective; stock comes back only through 2 adjustments', async ({ page, world, conversionDialog: dialog, adjustmentDialog }) => {
    const step = makeStep(page);
    const cj = world.warehouses.CJ;
    const defective = asWorldWarehouse(world.bucket(cj, '불량'));
    await tcMeta(
      'TC_US134_242',
      'Low',
      TAGS,
      `On the DEFECTIVE row (on hold 10) 전환 구분 offers no reverse direction (불량 해제 / 불량 → 보류) and still exactly 5 choices; 재고 조정 차감 5 파손 on the DEFECTIVE row and 증가 5 파손 on the CJ Incheon Aam row (available 120) both show 등록되었습니다 — DEFECTIVE total falls by 5 (on hold 10 → 5) and CJ available rises to 125. Data: the DEFECTIVE row (earlier scrapping) is a DB fixture on the test's own SKU. ${HOLD_NOTE} ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    let sku!: WorldSku;
    let options: string[] = [];
    let before!: RowNumbers;
    const adjust: number[] = [];
    const toasts: string[] = [];
    let defectiveAfter!: RowNumbers;
    let cjAfter!: RowNumbers;

    const adjustRow = async (warehouse: WorldWarehouse, modifyType: 'ADD' | 'SUBTRACT'): Promise<number> => {
      const row = list.row(sku.skuCode, warehouse.name);
      if (!(await list.checkbox(row).isChecked())) await list.tick(row, `${sku.skuCode} @ ${warehouse.name}`);
      await list.clickToolbar('btn.adjustStock');
      await adjustmentDialog.waitOpen('ko');
      await adjustmentDialog.fillLine(0, { quantity: '5', modifyType, reason: 'DAMAGED' });
      const status = await adjustmentDialog.saveAndWait('/api/v1/adjustments');
      if (status < 300) {
        await expect(adjustmentDialog.root, 'The adjustment dialog closes').toHaveCount(0);
        await list.lastToast().waitFor({ state: 'visible' }).catch(() => undefined);
        toasts.push(squash(await list.lastToast().innerText().catch(() => '')));
        await list.waitForList();
        await conv.showSku(sku);
      } else {
        await adjustmentDialog.clickCancel();
        await expect(async () => {
          if (await adjustmentDialog.confirmClose.isVisible()) await adjustmentDialog.confirmDiscard();
          await expect(adjustmentDialog.root).toHaveCount(0, { timeout: 1_000 });
        }, 'The adjustment dialog closes (after confirming when asked)').toPass({ timeout: 15_000 });
        await list.checkbox(row).uncheck();
      }
      return status;
    };

    await step('Arrange: Pre-condition 1–3 — Own SKU: DEFECTIVE row of CJ Incheon Aam with on hold 10, CJ Incheon Aam row with available 120', async () => {
      sku = await ownRow(world, 'TC242', cj, { available: 120, csManaged: false });
      await world.seedStock(sku, defective, { available: 0, hold: 10 });
    });

    await step('Act: Step 1 — Open 재고 관리, tick the row in the defective warehouse and click 재고 전환', async () => {
      await list.open('ko');
      await conv.showSku(sku);
      await conv.openFor([{ row: list.row(sku.skuCode, defective.name), label: `${sku.skuCode} @ ${defective.name}` }]);
    });

    await step('Assert: Expected 1 — The dialog opens', async () => {
      await expect(dialog.root, '[Expected 1] The 재고 전환 dialog is open').toBeVisible();
    });

    await step('Act: Step 2 — Open the 전환 구분 dropdown and look for a reverse direction', async () => {
      options = await conv.policyOptions();
    });

    await step('Assert: Expected 2 — There is no reverse direction in the dropdown', async () => {
      expect(options.filter((option) => /불량\s*해제|불량\s*→/.test(option)), '[Expected 2] No 불량 해제 / 불량 → … choice is offered').toEqual([]);
    });

    await step('Act: Step 3 — Count the choices again', async () => {
      options = await conv.policyOptions();
    });

    await step('Assert: Expected 3 — Still exactly 5 choices', async () => {
      expect(options.length, '[Expected 3] The dropdown has exactly 5 choices').toBe(5);
    });

    await step('Act: Step 4 — Close the dialog; save 재고 조정 차감 5 파손 on the DEFECTIVE row, then 증가 5 파손 on the CJ Incheon Aam row', async () => {
      await conv.discard();
      await list.checkbox(list.row(sku.skuCode, defective.name)).uncheck();
      before = await readNumbers(list, sku, defective);
      adjust.push(await adjustRow(defective, 'SUBTRACT'));
      adjust.push(await adjustRow(cj, 'ADD'));
      defectiveAfter = await readNumbers(list, sku, defective);
      cjAfter = await readNumbers(list, sku, cj);
    });

    await step('Assert: Expected 4 — Both saves registered; DEFECTIVE total −5 (on hold 10 → 5); CJ available 120 → 125', async () => {
      expect(adjust[0], '[Expected 4] The 차감 (Decrease) adjustment on the DEFECTIVE row is saved').toBeLessThan(300);
      expect(adjust[1], '[Expected 4] The 증가 (Increase) adjustment on the CJ Incheon Aam row is saved').toBeLessThan(300);
      expect(toasts[0] ?? '', `[Expected 4] The 차감 (Decrease) save shows ${t('msg.registered')}`).toContain(t('msg.registered'));
      expect(toasts[1] ?? '', `[Expected 4] The 증가 (Increase) save shows ${t('msg.registered')}`).toContain(t('msg.registered'));
      expect(defectiveAfter.total, `[Expected 4] 전체재고 of the DEFECTIVE row falls by 5 (from ${before.total})`).toBe(before.total - 5);
      expect(defectiveAfter.hold, '[Expected 4] 보류재고 of the DEFECTIVE row goes 10 → 5').toBe(5);
      expect(cjAfter.available, '[Expected 4] 가용재고 of CJ Incheon Aam rises from 120 to 125').toBe(125);
    });
  });

  test('TC_US134_243 — No direct route from CS stock exists; CS to on-hold takes exactly 2 steps through available stock', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    const { warehouse, note } = daegu(world);
    await tcMeta(
      'TC_US134_243',
      'Medium',
      TAGS,
      `The 5 policies hold no direct CS → on-hold, on-hold → CS or CS → defective route; CS재고 해제 20 (CS 30, available 220) then 보류재고 지정 20 (available 200, on hold 20) moves 20 from CS to on-hold through available stock in 2 steps. ${HOLD_NOTE} ${note} ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    let sku!: WorldSku;
    let options: string[] = [];
    const saves: ConversionSave[] = [];
    const seen: Record<number, RowNumbers> = {};
    const row = () => list.row(sku.skuCode, warehouse.name);

    await step('Arrange: Pre-condition 1–3 — Own row in CJ Daegu warehouse: available 200, CS 50, on hold 0, CS managed', async () => {
      sku = await ownRow(world, 'TC243', warehouse, { available: 200, cs: 50, hold: 0, csManaged: true });
      await list.open('ko');
      await conv.showSku(sku);
    });

    await step('Act: Step 1 — Tick the row, click 재고 전환 and read every choice', async () => {
      await conv.openFor([{ row: row(), label: sku.skuCode }]);
      options = await conv.policyOptions();
    });

    await step('Assert: Expected 1 — Only the 5 settled policies; no CS → on-hold, on-hold → CS or CS → defective route', async () => {
      expect(options.length, '[Expected 1] Exactly 5 choices').toBe(5);
      for (const key of ['policy.SECURE_CS', 'policy.RELEASE_CS', 'policy.SECURE_HOLD', 'policy.RELEASE_HOLD', 'policy.SCRAP_DEFECTIVE'] as const) {
        expect(options, `[Expected 1] ${t(key)} is one of the settled policies`).toContain(t(key));
      }
      expect(options.filter((o) => /CS재고\s*→\s*보류재고/.test(o)), '[Expected 1] No direct CS → on-hold route').toEqual([]);
      expect(options.filter((o) => /보류재고\s*→\s*CS재고/.test(o)), '[Expected 1] No direct on-hold → CS route').toEqual([]);
      expect(options.filter((o) => /CS재고\s*→\s*불량/.test(o)), '[Expected 1] No direct CS → defective route').toEqual([]);
    });

    await step('Act: Step 2 — Pick CS재고 해제 (CS재고 → 가용재고), type 20 and click 저장', async () => {
      await conv.discard();
      saves.push(await conv.runConversion(row(), sku.skuCode, 'RELEASE_CS', '20'));
      seen[2] = await readNumbers(list, sku, warehouse);
    });

    await step('Assert: Expected 2 — The save goes through, CS available 30 and available 220', async () => {
      expect(saves[0].status, `[Expected 2] The save goes through (${brief(saves[0])})`).toBeLessThan(300);
      expect(seen[2].cs, '[Expected 2] CS available stock falls to 30').toBe(30);
      expect(seen[2].available, '[Expected 2] Available stock rises to 220').toBe(220);
    });

    await step('Act: Step 3 — Tick the row again, pick 보류재고 지정 (가용재고 → 보류재고), type 20 and click 저장', async () => {
      saves.push(await conv.runConversion(row(), sku.skuCode, 'SECURE_HOLD', '20'));
      seen[3] = await readNumbers(list, sku, warehouse);
    });

    await step('Assert: Expected 3 — The save goes through, available 200 and on hold 20', async () => {
      expect(saves[1].status, `[Expected 3] The save goes through (${brief(saves[1])})`).toBeLessThan(300);
      expect(seen[3].available, '[Expected 3] Available stock falls to 200').toBe(200);
      expect(seen[3].hold, '[Expected 3] On-hold stock rises to 20').toBe(20);
    });

    await step('Act: Step 4 — Read CS재고(가용재고), 가용재고 and 보류재고', async () => {
      seen[4] = await readNumbers(list, sku, warehouse);
    });

    await step('Assert: Expected 4 — CS available 30, available 200, on hold 20', async () => {
      expect(seen[4].cs, '[Expected 4] CS available stock = 30').toBe(30);
      expect(seen[4].available, '[Expected 4] Available stock = 200').toBe(200);
      expect(seen[4].hold, '[Expected 4] On-hold stock = 20').toBe(20);
    });
  });

  test('TC_US134_244 — One conversion type drives every row of the dialog the same way', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    const cj = world.warehouses.CJ;
    const { warehouse: dg, note } = daegu(world);
    await tcMeta(
      'TC_US134_244',
      'Medium',
      TAGS,
      `With 2 CS-managed rows ticked (row 1 available 120 · on hold 10 · CS 20, row 2 available 200 · on hold 5 · CS 50) the dialog has exactly 1 전환 구분 field and no per-row one; 보류재고 지정 makes both rows read available → on-hold, CS재고 확보 makes both read available → CS-usable. Nothing is saved. ${note} ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    let skus: WorldSku[] = [];
    let at = [0, 1];

    await step('Arrange: Pre-condition 1–2 — Own rows in CJ Incheon Aam and CJ Daegu warehouse, both CS managed', async () => {
      skus = await ownPair(world, 'TC244', [
        { warehouse: cj, buckets: { available: 120, hold: 10, cs: 20, csManaged: true } },
        { warehouse: dg, buckets: { available: 200, hold: 5, cs: 50, csManaged: true } },
      ]);
      await list.open('ko');
      await conv.showGroup(skus[0]);
    });

    await step('Act: Step 1 — Tick both rows and click 재고 전환', async () => {
      await conv.openFor([
        { row: list.row(skus[0].skuCode, cj.name), label: skus[0].skuCode },
        { row: list.row(skus[1].skuCode, dg.name), label: skus[1].skuCode },
      ]);
      at = await conv.lineIndexes(skus);
    });

    await step('Assert: Expected 1 — The dialog opens with 2 rows', async () => {
      await expect(dialog.rows, '[Expected 1] The dialog holds 2 rows').toHaveCount(2);
    });

    await step('Act: Step 2 — Look for any per-row 전환 구분 field', async () => {
      await expect(dialog.table, 'The conversion table is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — No per-row dropdown; exactly 1 전환 구분 field drives the dialog', async () => {
      await expect(dialog.table.locator('select'), '[Expected 2] No row carries its own 전환 구분 dropdown').toHaveCount(0);
      await expect(dialog.body.locator('select'), '[Expected 2] The dialog has exactly 1 전환 구분 field').toHaveCount(1);
    });

    await step('Act: Step 3 — Pick 보류재고 지정 (가용재고 → 보류재고) and read the source and target cells of both rows', async () => {
      await conv.choose('SECURE_HOLD');
    });

    await step('Assert: Expected 3 — Both rows take available stock as source and the on-hold quantity as target', async () => {
      await expect(conv.fromCell(at[0]), '[Expected 3] Row 1 source = available 120').toHaveText('120');
      await expect(conv.toCell(at[0]), '[Expected 3] Row 1 target = on hold 10').toHaveText('10');
      await expect(conv.fromCell(at[1]), '[Expected 3] Row 2 source = available 200').toHaveText('200');
      await expect(conv.toCell(at[1]), '[Expected 3] Row 2 target = on hold 5').toHaveText('5');
    });

    await step('Act: Step 4 — Change the dropdown to CS재고 확보 (가용재고 → CS재고) and read both rows again', async () => {
      await conv.choose('SECURE_CS');
    });

    await step('Assert: Expected 4 — Both rows take available stock as source and CS-usable stock as target', async () => {
      await expect(conv.fromCell(at[0]), '[Expected 4] Row 1 source = available 120').toHaveText('120');
      await expect(conv.toCell(at[0]), '[Expected 4] Row 1 target = CS-usable 20').toHaveText('20');
      await expect(conv.fromCell(at[1]), '[Expected 4] Row 2 source = available 200').toHaveText('200');
      await expect(conv.toCell(at[1]), '[Expected 4] Row 2 target = CS-usable 50').toHaveText('50');
    });
  });

  test('TC_US134_245 — Releasing CS stock reads CS-usable stock, not the whole CS stock held', async () => {
    await skipTc(
      'TC_US134_245',
      'High',
      TAGS,
      'On a CS-managed row with CS stock 20 and CS-usable stock 14, CS재고 해제 shows source 14 (not 20), refuses 15 with 전환 전 구분의 현재수량을 초과한 전환수량은 등록할 수 없습니다. and saves 14.',
      'Blocked in the TC file — runs only once KakaoEnt BRZ-14805 is on the test environment; until then CS-usable stock equals the whole CS stock by design (the interim limit is TC_US134_75).',
    );
  });

  for (const variant of [
    { id: 'TC_US134_246', policy: 'SECURE_CS', label: 'CS재고 확보 (가용재고 → CS재고)', what: 'secured', priority: 'High' },
    { id: 'TC_US134_247', policy: 'RELEASE_CS', label: 'CS재고 해제 (CS재고 → 가용재고)', what: 'released', priority: 'High' },
  ] as const) {
    test(`${variant.id} — With CS management off and CS stock ${variant.what}, the row is blocked and left out of the data sent`, async ({ page, world, conversionDialog: dialog }) => {
      const step = makeStep(page);
      await tcMeta(
        variant.id,
        variant.priority,
        TAGS,
        `On a 관리안함 row (available 80) ${variant.label} makes the CS-side cell read 관리안함, greys out 전환수량 and 메모 (no character taken), and 저장 raises no missing-quantity message and sends no entry for the row. Observed in the frontend bundle 05/10: when every row of the dialog is blocked, 저장 sends no request at all and shows "${squash(t('err.convertNoEnabledLine'))}". ${OWN_NOTE}`,
      );
      const { list, conv } = pages(page, dialog);
      const cj = world.warehouses.CJ;
      let sku!: WorldSku;
      const typed = { quantity: '', memo: '' };
      let sent: ConversionSave | null = null;

      await step('Arrange: Pre-condition 1–3 — Own row in CJ Incheon Aam with available 80, CS 관리안함', async () => {
        sku = await ownRow(world, variant.id.replace('TC_US134_', 'TC'), cj, { available: 80, csManaged: false });
        await list.open('ko');
        await conv.showSku(sku);
      });

      await step(`Act: Step 1 — Tick the row, click 재고 전환 and pick ${variant.label}`, async () => {
        await conv.openFor([{ row: list.row(sku.skuCode, cj.name), label: sku.skuCode }]);
        await conv.choose(variant.policy);
      });

      await step('Assert: Expected 1 — The dialog opens with 1 row', async () => {
        await expect(dialog.rows, '[Expected 1] The dialog holds 1 row').toHaveCount(1);
      });

      await step('Act: Step 2 — Read the CS-side current quantity cell', async () => {
        await expect(dialog.rows.nth(0), 'The row is shown').toBeVisible();
      });

      await step('Assert: Expected 2 — The CS-side cell shows 관리안함 instead of a number', async () => {
        const csSide = variant.policy === 'SECURE_CS' ? conv.toCell(0) : conv.fromCell(0);
        await expect(csSide, `[Expected 2] The CS-side cell shows ${t('label.notManaged')}`).toHaveText(t('label.notManaged'));
      });

      await step('Act: Step 3 — Try typing into 전환수량 and into 메모', async () => {
        typed.quantity = await conv.tryType(dialog.quantityInput(0), '10');
        typed.memo = await conv.tryType(dialog.memoInput(0), 'Demo memo');
      });

      await step('Assert: Expected 3 — Neither field takes any characters; both are greyed out', async () => {
        expect(typed.quantity, '[Expected 3] 전환수량 takes no characters').toBe('');
        expect(typed.memo, '[Expected 3] 메모 takes no characters').toBe('');
        await expect(dialog.quantityInput(0), '[Expected 3] 전환수량 is greyed out').toBeDisabled();
        await expect(dialog.memoInput(0), '[Expected 3] 메모 is greyed out').toBeDisabled();
      });

      await step('Act: Step 4 — Click 저장 and read the data sent to the server', async () => {
        sent = await conv.trySave(5_000);
      });

      await step('Assert: Expected 4 — No missing-quantity message for the row and no entry for it in the data sent', async () => {
        await expect(conv.message(t('err.convertQuantityBlank')), '[Expected 4] No missing-quantity message is shown for the blocked row').toHaveCount(0);
        const entries = (sent?.payload.items ?? []).filter((item) => Number(item.skuId) === sku.skuId);
        expect(entries, `[Expected 4] The data sent carries no entry for the row (${brief(sent)})`).toEqual([]);
      });
    });
  }

  test('TC_US134_248 — The server turns down both CS conversions on an unmanaged row', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    const sentence = 'CS재고 관리안함 재고는 가용재고와 CS재고 간 전환을 할 수 없습니다.';
    await tcMeta(
      'TC_US134_248',
      'Medium',
      TAGS,
      `API conversions SECURE_CS 10 and RELEASE_CS 10 on a 관리안함 row (going around the screen) are both rejected with WH-STOCK_QUANTITY_TYPE_NOT_ACTIVE "${sentence}"; the list cell still reads 관리안함 and no CS quantity is written. ${OWN_NOTE}`,
    );
    const list = new StockCalculationPage(page);
    const cj = world.warehouses.CJ;
    let sku!: WorldSku;
    const results: Record<string, { status: number; code: string; message: string }> = {};
    let csCell = '';
    let stored: StoredBuckets | null = null;

    await step('Arrange: Pre-condition 1–3 — Own row in CJ Incheon Aam, CS 관리안함; authenticated API client', async () => {
      sku = await ownRow(world, 'TC248', cj, { available: 50, csManaged: false });
    });

    await step('Act: Step 1 — Send a conversion call with policy SECURE_CS and quantity 10, going around the screen', async () => {
      results.secure = errorOf(await stockApi.convert({ policy: 'SECURE_CS', items: [{ skuId: sku.skuId, warehouseId: cj.id, quantity: 10 }] }));
    });

    await step('Assert: Expected 1 — The server rejects the request', async () => {
      expect(results.secure.status, '[Expected 1] The SECURE_CS call is rejected').toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 2 — Read the error that comes back', async () => {
      expect(results.secure, 'The error body is read').toBeDefined();
    });

    await step('Assert: Expected 2 — WH-STOCK_QUANTITY_TYPE_NOT_ACTIVE with its message for SECURE_CS', async () => {
      expect(results.secure.code, '[Expected 2] The code is WH-STOCK_QUANTITY_TYPE_NOT_ACTIVE').toBe('WH-STOCK_QUANTITY_TYPE_NOT_ACTIVE');
      expect(results.secure.message, `[Expected 2] The message is ${sentence}`).toContain(sentence);
    });

    await step('Act: Step 3 — Send the same call with policy RELEASE_CS and read the error', async () => {
      results.release = errorOf(await stockApi.convert({ policy: 'RELEASE_CS', items: [{ skuId: sku.skuId, warehouseId: cj.id, quantity: 10 }] }));
    });

    await step('Assert: Expected 3 — The same code and message for RELEASE_CS', async () => {
      expect(results.release.status, '[Expected 3] The RELEASE_CS call is rejected').toBeGreaterThanOrEqual(400);
      expect(results.release.code, '[Expected 3] The code is WH-STOCK_QUANTITY_TYPE_NOT_ACTIVE').toBe('WH-STOCK_QUANTITY_TYPE_NOT_ACTIVE');
      expect(results.release.message, `[Expected 3] The message is ${sentence}`).toContain(sentence);
    });

    await step('Act: Step 4 — Read CS재고(가용재고) of the row on the list', async () => {
      await list.open('ko');
      await list.findSku(sku);
      csCell = await list.cellText(list.row(sku.skuCode, cj.name), 'col.csQuantity');
      stored = await storedBuckets(sku.skuId, cj.id);
    });

    await step('Assert: Expected 4 — The cell still shows 관리안함 and no CS quantity has been written', async () => {
      expect(csCell, `[Expected 4] The cell still shows ${t('label.notManaged')}`).toBe(t('label.notManaged'));
      expect(stored?.cs, '[Expected 4] No CS quantity is written').toBe(0);
      expect(stored?.available, '[Expected 4] Available stock is untouched').toBe(50);
    });
  });

  test('TC_US134_249 — With CS management off, setting stock on hold still works', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_249',
      'Medium',
      TAGS,
      `On a 관리안함 row (available 80, on hold 0) 보류재고 지정 shows numbers 80 and 0 with no 관리안함, takes 10 and memo "Demo hold note", and saving shows 등록되었습니다 with available 70 and on hold 10. ${HOLD_NOTE} ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    const cj = world.warehouses.CJ;
    let sku!: WorldSku;
    let saved!: ConversionSave;
    let after!: RowNumbers;

    await step('Arrange: Pre-condition 1–3 — Own row in CJ Incheon Aam: available 80, on hold 0, CS 관리안함', async () => {
      sku = await ownRow(world, 'TC249', cj, { available: 80, hold: 0, csManaged: false });
      await list.open('ko');
      await conv.showSku(sku);
    });

    await step('Act: Step 1 — Tick the row, click 재고 전환 and pick 보류재고 지정 (가용재고 → 보류재고)', async () => {
      await conv.openFor([{ row: list.row(sku.skuCode, cj.name), label: sku.skuCode }]);
      await conv.choose('SECURE_HOLD');
    });

    await step('Assert: Expected 1 — The dialog opens with 1 row', async () => {
      await expect(dialog.rows, '[Expected 1] The dialog holds 1 row').toHaveCount(1);
    });

    await step('Act: Step 2 — Read the source and target current quantity cells', async () => {
      await expect(conv.fromCell(0), 'The source cell is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — Both cells show numbers, 80 and 0, with no 관리안함', async () => {
      await expect(conv.fromCell(0), '[Expected 2] The source cell shows 80').toHaveText('80');
      await expect(conv.toCell(0), '[Expected 2] The target cell shows 0').toHaveText('0');
      await expect(dialog.rows.nth(0), `[Expected 2] The row shows no ${t('label.notManaged')}`).not.toContainText(t('label.notManaged'));
    });

    await step('Act: Step 3 — Type 10 into 전환수량 and Demo hold note into 메모', async () => {
      await dialog.fillLine(0, { quantity: '10', memo: 'Demo hold note' });
    });

    await step('Assert: Expected 3 — Both fields take their values', async () => {
      await expect(dialog.quantityInput(0), '[Expected 3] 전환수량 holds 10').toHaveValue('10');
      await expect(dialog.memoInput(0), '[Expected 3] 메모 holds Demo hold note').toHaveValue('Demo hold note');
    });

    await step('Act: Step 4 — Click 저장, then read 가용재고 and 보류재고', async () => {
      saved = await conv.saveAndReload();
      after = await readNumbers(list, sku, cj);
    });

    await step('Assert: Expected 4 — 등록되었습니다, available 70 and on hold 10', async () => {
      expect(saved.status, `[Expected 4] The save goes through (${brief(saved)})`).toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 4] The message ${t('msg.registered')} appears`).toContainText(t('msg.registered'));
      expect(after.available, '[Expected 4] 가용재고 shows 70').toBe(70);
      expect(after.hold, '[Expected 4] 보류재고 shows 10').toBe(10);
    });
  });

  test('TC_US134_250 — With CS management off, releasing on-hold stock still works', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_250',
      'Medium',
      TAGS,
      `On a 관리안함 row (available 70, on hold 10) 보류재고 해제 shows numbers 10 and 70 with no 관리안함, takes 10, and saving shows 등록되었습니다 with on hold 0 and available 80. ${HOLD_NOTE} ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    const cj = world.warehouses.CJ;
    let sku!: WorldSku;
    let saved!: ConversionSave;
    let after!: RowNumbers;

    await step('Arrange: Pre-condition 1–3 — Own row in CJ Incheon Aam: available 70, on hold 10, CS 관리안함', async () => {
      sku = await ownRow(world, 'TC250', cj, { available: 70, hold: 10, csManaged: false });
      await list.open('ko');
      await conv.showSku(sku);
    });

    await step('Act: Step 1 — Tick the row, click 재고 전환 and pick 보류재고 해제 (보류재고 → 가용재고)', async () => {
      await conv.openFor([{ row: list.row(sku.skuCode, cj.name), label: sku.skuCode }]);
      await conv.choose('RELEASE_HOLD');
    });

    await step('Assert: Expected 1 — The dialog opens with one row', async () => {
      await expect(dialog.rows, '[Expected 1] The dialog holds 1 row').toHaveCount(1);
    });

    await step('Act: Step 2 — Read the source and target current quantity cells', async () => {
      await expect(conv.fromCell(0), 'The source cell is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — Source 10 and target 70, both numbers without 관리안함', async () => {
      await expect(conv.fromCell(0), '[Expected 2] The source cell shows 10').toHaveText('10');
      await expect(conv.toCell(0), '[Expected 2] The target cell shows 70').toHaveText('70');
      await expect(dialog.rows.nth(0), `[Expected 2] The row shows no ${t('label.notManaged')}`).not.toContainText(t('label.notManaged'));
    });

    await step('Act: Step 3 — Type 10 into 전환수량', async () => {
      await dialog.fillLine(0, { quantity: '10' });
    });

    await step('Assert: Expected 3 — The field accepts the value', async () => {
      await expect(dialog.quantityInput(0), '[Expected 3] 전환수량 holds 10').toHaveValue('10');
    });

    await step('Act: Step 4 — Click 저장, then read 가용재고 and 보류재고', async () => {
      saved = await conv.saveAndReload();
      after = await readNumbers(list, sku, cj);
    });

    await step('Assert: Expected 4 — 등록되었습니다, on hold 0 and available 80', async () => {
      expect(saved.status, `[Expected 4] The save goes through (${brief(saved)})`).toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 4] The message ${t('msg.registered')} appears`).toContainText(t('msg.registered'));
      expect(after.hold, '[Expected 4] 보류재고 becomes 0').toBe(0);
      expect(after.available, '[Expected 4] 가용재고 becomes 80').toBe(80);
    });
  });

  test('TC_US134_251 — Blocking by the CS flag is worked out again for every row on every policy change', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_251',
      'Medium',
      TAGS,
      `With a 관리함 and a 관리안함 row in the dialog: CS재고 확보 leaves the managed row usable and greys out the unmanaged one with 관리안함; 보류재고 지정 makes both usable without 관리안함; CS재고 해제 blocks the unmanaged row again. Nothing is saved. ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    const cj = world.warehouses.CJ;
    let skus: WorldSku[] = [];
    let at = [0, 1];
    const notManaged = t('label.notManaged');

    await step('Arrange: Pre-condition 1–2 — Own rows in CJ Incheon Aam: one CS 관리함, one CS 관리안함', async () => {
      skus = await ownPair(world, 'TC251', [
        { warehouse: cj, buckets: { available: 120, cs: 20, csManaged: true } },
        { warehouse: cj, buckets: { available: 50, csManaged: false } },
      ]);
      await list.open('ko');
      await conv.showGroup(skus[0]);
    });

    await step('Act: Step 1 — Tick both rows, click 재고 전환 and pick CS재고 확보 (가용재고 → CS재고)', async () => {
      await conv.openFor(skus.map((sku) => ({ row: list.row(sku.skuCode, cj.name), label: sku.skuCode })));
      at = await conv.lineIndexes(skus);
      await conv.choose('SECURE_CS');
    });

    await step('Assert: Expected 1 — The dialog opens with 2 rows', async () => {
      await expect(dialog.rows, '[Expected 1] The dialog holds 2 rows').toHaveCount(2);
    });

    await step('Act: Step 2 — Read the state of 전환수량 on each row', async () => {
      await expect(dialog.quantityInput(at[0]), 'The quantity field of row 1 is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — The managed row is usable; the unmanaged row shows 관리안함 with the field greyed out', async () => {
      await expect(dialog.quantityInput(at[0]), '[Expected 2] The managed row has a usable quantity field').toBeEnabled();
      await expect(dialog.quantityInput(at[1]), '[Expected 2] The unmanaged row has its quantity field greyed out').toBeDisabled();
      await expect(dialog.rows.nth(at[1]), `[Expected 2] The unmanaged row shows ${notManaged}`).toContainText(notManaged);
    });

    await step('Act: Step 3 — Change 전환 구분 to 보류재고 지정 (가용재고 → 보류재고) and read both rows again', async () => {
      await conv.choose('SECURE_HOLD');
    });

    await step('Assert: Expected 3 — Both rows have a usable field and neither shows 관리안함', async () => {
      for (const index of [0, 1]) {
        await expect(dialog.quantityInput(at[index]), `[Expected 3] Row ${index + 1} has a usable quantity field`).toBeEnabled();
        await expect(dialog.rows.nth(at[index]), `[Expected 3] Row ${index + 1} shows no ${notManaged}`).not.toContainText(notManaged);
      }
    });

    await step('Act: Step 4 — Change it again to CS재고 해제 (CS재고 → 가용재고) and read both rows again', async () => {
      await conv.choose('RELEASE_CS');
    });

    await step('Assert: Expected 4 — The unmanaged row is blocked again and shows 관리안함', async () => {
      await expect(dialog.quantityInput(at[1]), '[Expected 4] The unmanaged row is greyed out again').toBeDisabled();
      await expect(dialog.rows.nth(at[1]), `[Expected 4] The unmanaged row shows ${notManaged} again`).toContainText(notManaged);
      await expect(dialog.quantityInput(at[0]), '[Expected 4] The managed row stays usable').toBeEnabled();
    });
  });

  test('TC_US134_252 — The fixed CS notice keeps its exact wording whatever policy is picked and cannot be closed', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    const cj = world.warehouses.CJ;
    const row = world.row('SKU0001', cj);
    await tcMeta(
      'TC_US134_252',
      'Low',
      TAGS,
      `Above the table the notice "${t('convert.notice')}" is shown before any policy, unchanged after 보류재고 지정 and after CS재고 확보, with no close / fold button — in Korean, then in English ("${stx('convert.notice', 'en')}"). The dialog is opened on the shared row and nothing is saved. ${WORLD_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);

    await step('Arrange: Pre-condition 1–3 — DEMO-SKU-0001 in CJ Incheon Aam is CS managed; Korean first, then English', async () => {
      expect(row.buckets.csManaged, 'DEMO-SKU-0001 @ CJ Incheon Aam is CS managed').toBe(true);
    });

    for (const lang of STOCK_LANGS) {
      const tl = (key: StockTextKey) => stx(key, lang);
      const sfx = LANG_SUFFIX[lang];

      await step(`Act: Step 1 — Tick DEMO-SKU-0001, click 재고 전환 and read the notice before picking a policy ${sfx}`, async () => {
        await list.open(lang);
        await list.search('SKU_GROUP_NAME', world.keyword);
        await list.choosePageSize(20);
        await conv.openFor([{ row: list.row(row.sku.skuCode, cj.name), label: row.sku.skuCode }]);
      });

      await step(`Assert: Expected 1 — The notice shows ${tl('convert.notice')} ${sfx}`, async () => {
        await expect(dialog.notice, `[Expected 1] The notice reads ${tl('convert.notice')}`).toBeVisible();
        const [noteBox, tableBox] = [await dialog.notice.boundingBox(), await dialog.table.boundingBox()];
        expect(!!noteBox && !!tableBox && noteBox.y + noteBox.height <= tableBox.y + 1, '[Expected 1] The notice sits above the table').toBe(true);
      });

      await step(`Act: Step 2 — Pick 보류재고 지정 (가용재고 → 보류재고) and read the notice again ${sfx}`, async () => {
        await conv.choose('SECURE_HOLD');
      });

      await step(`Assert: Expected 2 — The notice is unchanged ${sfx}`, async () => {
        await expect(dialog.notice, `[Expected 2] The notice still reads ${tl('convert.notice')}`).toBeVisible();
      });

      let closers = -1;
      await step(`Act: Step 3 — Look for any button to close or fold away the notice ${sfx}`, async () => {
        closers = await dialog.notice.locator('xpath=..').locator('button, .btn-close, [role="button"]').count();
      });

      await step(`Assert: Expected 3 — There is no close or fold button ${sfx}`, async () => {
        expect(closers, '[Expected 3] The notice block has no close / fold button').toBe(0);
        await expect(dialog.notice.locator('button, .btn-close'), '[Expected 3] The notice itself has no button').toHaveCount(0);
      });

      await step(`Act: Step 4 — Pick CS재고 확보 (가용재고 → CS재고) and read the notice again ${sfx}`, async () => {
        await conv.choose('SECURE_CS');
      });

      await step(`Assert: Expected 4 — The notice is unchanged ${sfx}`, async () => {
        await expect(dialog.notice, `[Expected 4] The notice still reads ${tl('convert.notice')}`).toBeVisible();
      });
    }
  });

  test('TC_US134_253 — Securing CS stock lowers both available stock and the orderable quantity', async () => {
    await skipTc(
      'TC_US134_253',
      'High',
      TAGS,
      'On DEMO-SKU-0001 (available 120, 할당대기재고 15, 주문가능수량 105) CS재고 확보 30 shows 등록되었습니다, available 90 and orderable 75 (90 − the unchanged 15).',
      'Needs 할당대기재고 (stock awaiting allocation) 15, an order-derived figure from the commerce order service (KakaoEnt BRZ-14801 / interim mock); orders cannot be created from this admin, so the row cannot be built.',
    );
  });

  test('TC_US134_254 — The source, target and after-conversion columns show a dash until a policy is picked', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    const cj = world.warehouses.CJ;
    const { warehouse: dg, note } = daegu(world);
    await tcMeta(
      'TC_US134_254',
      'Medium',
      TAGS,
      `With 2 CS-managed rows (available 120 / on hold 10 and available 200 / on hold 0) and no policy, the source, target and qty-after cells all show a dash; 보류재고 지정 fills source and target with numbers while qty-after stays a dash. Nothing is saved. ${note} ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    let skus: WorldSku[] = [];
    let at = [0, 1];

    await step('Arrange: Pre-condition 1–2 — Own rows in CJ Incheon Aam and CJ Daegu warehouse, both CS managed', async () => {
      skus = await ownPair(world, 'TC254', [
        { warehouse: cj, buckets: { available: 120, hold: 10, csManaged: true } },
        { warehouse: dg, buckets: { available: 200, hold: 0, csManaged: true } },
      ]);
      await list.open('ko');
      await conv.showGroup(skus[0]);
    });

    await step('Act: Step 1 — Tick both rows and click 재고 전환 without picking a policy', async () => {
      await conv.openFor([
        { row: list.row(skus[0].skuCode, cj.name), label: skus[0].skuCode },
        { row: list.row(skus[1].skuCode, dg.name), label: skus[1].skuCode },
      ]);
      at = await conv.lineIndexes(skus);
    });

    await step('Assert: Expected 1 — 2 rows and 전환 구분 showing 선택', async () => {
      await expect(dialog.rows, '[Expected 1] The dialog holds 2 rows').toHaveCount(2);
      await expect(conv.selectedPolicyText(), `[Expected 1] 전환 구분 shows ${t('convert.policyPlaceholder')}`).toHaveText(t('convert.policyPlaceholder'));
    });

    await step('Act: Step 2 — Read the (전환 전 구분) 현재수량 cell on both rows', async () => {
      await expect(conv.fromCell(at[1]), 'The source cell of row 2 is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — Both source cells show a dash', async () => {
      for (const index of [0, 1]) await expect(conv.fromCell(at[index]), `[Expected 2] The source cell of row ${index + 1} shows a dash`).toHaveText('-');
    });

    await step('Act: Step 3 — Read the (전환 후 구분) 현재수량 and 전환 후 수량 cells on both rows', async () => {
      await expect(conv.afterCell(at[1]), 'The qty-after cell of row 2 is shown').toBeVisible();
    });

    await step('Assert: Expected 3 — All 4 cells show a dash', async () => {
      for (const index of [0, 1]) {
        await expect(conv.toCell(at[index]), `[Expected 3] The target cell of row ${index + 1} shows a dash`).toHaveText('-');
        await expect(conv.afterCell(at[index]), `[Expected 3] The qty-after cell of row ${index + 1} shows a dash`).toHaveText('-');
      }
    });

    await step('Act: Step 4 — Pick 보류재고 지정 (가용재고 → 보류재고) and read all 3 columns again', async () => {
      await conv.choose('SECURE_HOLD');
    });

    await step('Assert: Expected 4 — Source and target show numbers; qty-after still a dash', async () => {
      await expect(conv.fromCell(at[0]), '[Expected 4] Row 1 source shows 120').toHaveText('120');
      await expect(conv.toCell(at[0]), '[Expected 4] Row 1 target shows 10').toHaveText('10');
      await expect(conv.fromCell(at[1]), '[Expected 4] Row 2 source shows 200').toHaveText('200');
      await expect(conv.toCell(at[1]), '[Expected 4] Row 2 target shows 0').toHaveText('0');
      for (const index of [0, 1]) await expect(conv.afterCell(at[index]), `[Expected 4] The qty-after cell of row ${index + 1} still shows a dash`).toHaveText('-');
    });
  });

  test('TC_US134_255 — The after-conversion cell is worked out on every keystroke and goes back to a dash when cleared', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_255',
      'Medium',
      TAGS,
      `With 보류재고 지정 on a row (available 120, on hold 10): source 120, target 10, qty-after a dash; typing 3 shows 13, typing 0 (30) shows 40, clearing the field shows a dash again. Nothing is saved. ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    const cj = world.warehouses.CJ;
    let sku!: WorldSku;

    await step('Arrange: Pre-condition 1–3 — Own row in CJ Incheon Aam: available 120, on hold 10', async () => {
      sku = await ownRow(world, 'TC255', cj, { available: 120, hold: 10, csManaged: true });
      await list.open('ko');
      await conv.showSku(sku);
    });

    await step('Act: Step 1 — Tick the row, click 재고 전환 and pick 보류재고 지정 (가용재고 → 보류재고)', async () => {
      await conv.openFor([{ row: list.row(sku.skuCode, cj.name), label: sku.skuCode }]);
      await conv.choose('SECURE_HOLD');
    });

    await step('Assert: Expected 1 — Source 120, target 10, qty-after a dash', async () => {
      await expect(conv.fromCell(0), '[Expected 1] The source cell shows 120').toHaveText('120');
      await expect(conv.toCell(0), '[Expected 1] The target cell shows 10').toHaveText('10');
      await expect(conv.afterCell(0), '[Expected 1] The qty-after cell shows a dash').toHaveText('-');
    });

    await step('Act: Step 2 — Type 3 into 전환수량 and read the qty-after cell', async () => {
      await dialog.quantityInput(0).pressSequentially('3');
    });

    await step('Assert: Expected 2 — The qty-after cell shows 13 from the very first keystroke', async () => {
      await expect(conv.afterCell(0), '[Expected 2] The qty-after cell shows 13 (10 + 3)').toHaveText('13');
    });

    await step('Act: Step 3 — Type 0 to make the field 30 and read the qty-after cell again', async () => {
      await dialog.quantityInput(0).pressSequentially('0');
    });

    await step('Assert: Expected 3 — The qty-after cell shows 40', async () => {
      await expect(dialog.quantityInput(0), 'The field holds 30').toHaveValue('30');
      await expect(conv.afterCell(0), '[Expected 3] The qty-after cell shows 40 (10 + 30)').toHaveText('40');
    });

    await step('Act: Step 4 — Clear the field and read the qty-after cell again', async () => {
      await dialog.quantityInput(0).fill('');
    });

    await step('Assert: Expected 4 — The qty-after cell shows a dash again', async () => {
      await expect(conv.afterCell(0), '[Expected 4] The qty-after cell shows a dash').toHaveText('-');
    });
  });

  test('TC_US134_256 — Save is blocked with 전환 구분을 선택해주세요. when no conversion type is picked', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    const cj = world.warehouses.CJ;
    const row = world.row('SKU0001', cj);
    await tcMeta(
      'TC_US134_256',
      'Medium',
      TAGS,
      `On DEMO-SKU-0001 with 전환 구분 at 선택, 저장 sends nothing and shows "${t('err.policyRequired')}"; picking 보류재고 지정 clears the message at once. The dialog is opened on the shared row and nothing is saved. ${WORLD_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    let posts = -1;

    await step('Arrange: Pre-condition 1–2 — DEMO-SKU-0001 in CJ Incheon Aam, CS managed', async () => {
      expect(row.buckets.csManaged, 'DEMO-SKU-0001 @ CJ Incheon Aam is CS managed').toBe(true);
      await showWorld(list, world);
    });

    await step('Act: Step 1 — Tick DEMO-SKU-0001 and click 재고 전환', async () => {
      await conv.openFor([{ row: list.row(row.sku.skuCode, cj.name), label: row.sku.skuCode }]);
    });

    await step('Assert: Expected 1 — The dialog opens with 전환 구분 showing 선택', async () => {
      await expect(conv.selectedPolicyText(), `[Expected 1] 전환 구분 shows ${t('convert.policyPlaceholder')}`).toHaveText(t('convert.policyPlaceholder'));
    });

    await step('Act: Step 2 — Without picking a policy, click 저장', async () => {
      posts = await conv.blockedSave();
    });

    await step('Assert: Expected 2 — Saving is blocked', async () => {
      expect(posts, '[Expected 2] No conversion request is sent').toBe(0);
      await expect(dialog.root, '[Expected 2] The dialog stays open').toBeVisible();
    });

    await step('Act: Step 3 — Read the message that appears', async () => {
      await expect(dialog.errorAlert, 'The message is shown').toBeVisible();
    });

    await step(`Assert: Expected 3 — The message shows ${t('err.policyRequired')}`, async () => {
      await expect(dialog.errorAlert, `[Expected 3] The message is ${t('err.policyRequired')}`).toContainText(t('err.policyRequired'));
    });

    await step('Act: Step 4 — Pick 보류재고 지정 (가용재고 → 보류재고) and read the message area again', async () => {
      await conv.choose('SECURE_HOLD');
    });

    await step('Assert: Expected 4 — The message clears as soon as a policy is picked', async () => {
      await expect(dialog.errorAlert, '[Expected 4] The message is gone').toHaveCount(0);
    });
  });

  test('TC_US134_257 — Save is blocked and only the row left empty is highlighted', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_257',
      'Medium',
      TAGS,
      `With 보류재고 지정 on 2 CS-managed rows, 10 on row 1 and row 2 left empty, 저장 sends nothing and shows "${t('err.convertQuantityBlank')}"; row 2 is highlighted, row 1 is not, and the dialog stays open with 10 on row 1. ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    const cj = world.warehouses.CJ;
    let skus: WorldSku[] = [];
    let at = [0, 1];
    let posts = -1;
    const highlighted: boolean[] = [];

    await step('Arrange: Pre-condition 1–3 — 2 own rows in CJ Incheon Aam, both CS managed', async () => {
      skus = await ownPair(world, 'TC257', [
        { warehouse: cj, buckets: { available: 120, hold: 10, cs: 20, csManaged: true } },
        { warehouse: cj, buckets: { available: 5, cs: 5, csManaged: true } },
      ]);
      await list.open('ko');
      await conv.showGroup(skus[0]);
    });

    await step('Act: Step 1 — Tick both rows, click 재고 전환 and pick 보류재고 지정 (가용재고 → 보류재고)', async () => {
      await conv.openFor(skus.map((sku) => ({ row: list.row(sku.skuCode, cj.name), label: sku.skuCode })));
      at = await conv.lineIndexes(skus);
      await conv.choose('SECURE_HOLD');
    });

    await step('Assert: Expected 1 — 2 rows, both with a usable quantity field', async () => {
      await expect(dialog.rows, '[Expected 1] The dialog holds 2 rows').toHaveCount(2);
      for (const index of [0, 1]) await expect(dialog.quantityInput(at[index]), `[Expected 1] Row ${index + 1} has a usable quantity field`).toBeEnabled();
    });

    await step('Act: Step 2 — Type 10 on row 1 and leave row 2 empty', async () => {
      await dialog.fillLine(at[0], { quantity: '10' });
    });

    await step('Assert: Expected 2 — Row 1 holds 10 and row 2 is empty', async () => {
      await expect(dialog.quantityInput(at[0]), '[Expected 2] Row 1 holds 10').toHaveValue('10');
      await expect(dialog.quantityInput(at[1]), '[Expected 2] Row 2 is empty').toHaveValue('');
    });

    await step('Act: Step 3 — Click 저장', async () => {
      posts = await conv.blockedSave();
    });

    await step(`Assert: Expected 3 — Saving is blocked with ${t('err.convertQuantityBlank')}`, async () => {
      expect(posts, '[Expected 3] No conversion request is sent').toBe(0);
      await expect(dialog.errorAlert, `[Expected 3] The message is ${t('err.convertQuantityBlank')}`).toContainText(t('err.convertQuantityBlank'));
    });

    await step('Act: Step 4 — Read which row is highlighted and whether the dialog is still open', async () => {
      highlighted.push(await conv.lineHighlighted(at[0]), await conv.lineHighlighted(at[1]));
    });

    await step('Assert: Expected 4 — Row 2 highlighted, row 1 not; the dialog is still open with 10 on row 1', async () => {
      expect(highlighted[1], '[Expected 4] Row 2 is highlighted').toBe(true);
      expect(highlighted[0], '[Expected 4] Row 1 is not highlighted').toBe(false);
      await expect(dialog.root, '[Expected 4] The dialog is still open').toBeVisible();
      await expect(dialog.quantityInput(at[0]), '[Expected 4] Row 1 still holds 10').toHaveValue('10');
    });
  });

  test('TC_US134_258 — The save is blocked for 0 or a part number and taken for exactly 1', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_258',
      'Medium',
      TAGS,
      `With 보류재고 지정 on a row (available 120, on hold 10): 0 is blocked with "${t('err.convertQuantityMin')}" and the row highlighted; 1.5 is blocked with the same message; 1 saves with 등록되었습니다. Deviation TC ≠ UI (frontend bundle 05/10, confirmed by the 06/10 run): the quantity field keeps digits only, so typing 1.5 leaves 15 in the field and 저장 registers a conversion of 15 instead of blocking — Expected 3 is asserted as the TC writes it (soft, so Expected 4 still runs; the dialog is reopened when that save closed it). ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    const cj = world.warehouses.CJ;
    let sku!: WorldSku;
    let posts = -1;
    let highlighted = false;
    let partValue = '';
    let partSave: ConversionSave | null = null;
    let saved!: ConversionSave;

    await step('Arrange: Pre-condition 1–3 — Own row in CJ Incheon Aam: available 120, on hold 10', async () => {
      sku = await ownRow(world, 'TC258', cj, { available: 120, hold: 10, csManaged: true });
      await list.open('ko');
      await conv.showSku(sku);
    });

    await step('Act: Step 1 — Pick 보류재고 지정, type 0 into 전환수량 and click 저장', async () => {
      await conv.openFor([{ row: list.row(sku.skuCode, cj.name), label: sku.skuCode }]);
      await conv.choose('SECURE_HOLD');
      await dialog.fillLine(0, { quantity: '0' });
      posts = await conv.blockedSave();
      highlighted = await conv.lineHighlighted(0);
    });

    await step('Assert: Expected 1 — Saving is blocked and the row is highlighted', async () => {
      expect(posts, '[Expected 1] No conversion request is sent').toBe(0);
      expect(highlighted, '[Expected 1] The row is highlighted').toBe(true);
    });

    await step('Act: Step 2 — Read the message that appears', async () => {
      await expect(dialog.errorAlert, 'The message is shown').toBeVisible();
    });

    await step(`Assert: Expected 2 — The message shows ${t('err.convertQuantityMin')}`, async () => {
      await expect(dialog.errorAlert, `[Expected 2] The message is ${t('err.convertQuantityMin')}`).toContainText(t('err.convertQuantityMin'));
    });

    await step('Act: Step 3 — Try typing 1.5 into 전환수량, then click 저장', async () => {
      await dialog.quantityInput(0).fill('');
      await dialog.quantityInput(0).pressSequentially('1.5');
      partValue = await dialog.quantityInput(0).inputValue();
      partSave = await conv.trySave(5_000);
    });

    await step('Assert: Expected 3 — Saving is blocked with the same message and the row is highlighted', async () => {
      expect.soft(partSave, `[Expected 3] No conversion is sent for the part number (field held "${partValue}", ${brief(partSave)})`).toBeNull();
      await expect.soft(dialog.errorAlert, `[Expected 3] The message is ${t('err.convertQuantityMin')}`).toContainText(t('err.convertQuantityMin'));
      expect.soft(await conv.lineHighlighted(0), '[Expected 3] The row is highlighted').toBe(true);
    });

    await step('Act: Step 4 — Change the quantity to 1 and click 저장', async () => {
      if ((await dialog.root.count()) === 0) {
        await conv.showSku(sku);
        await conv.openFor([{ row: list.row(sku.skuCode, cj.name), label: sku.skuCode }]);
        await conv.choose('SECURE_HOLD');
      }
      await dialog.fillLine(0, { quantity: '1' });
      saved = await conv.saveAndReload();
    });

    await step('Assert: Expected 4 — The save goes through with 등록되었습니다 (Registered.)', async () => {
      expect(saved.status, `[Expected 4] The value 1 is taken (${brief(saved)})`).toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 4] The message ${t('msg.registered')} appears`).toContainText(t('msg.registered'));
    });
  });

  test('TC_US134_259 — The save is blocked above the source cell and taken when equal to it', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_259',
      'High',
      TAGS,
      `With 보류재고 지정 on a row (available 17, on hold 0) the source cell reads 17; 18 is blocked with "${t('err.convertQuantityExceeds')}"; 17 saves with 등록되었습니다 — available 0 and on hold 17. ${HOLD_NOTE} ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    const cj = world.warehouses.CJ;
    let sku!: WorldSku;
    let posts = -1;
    let saved!: ConversionSave;
    let after!: RowNumbers;

    await step('Arrange: Pre-condition 1–3 — Own row in CJ Incheon Aam: available 17, on hold 0', async () => {
      sku = await ownRow(world, 'TC259', cj, { available: 17, hold: 0, csManaged: true });
      await list.open('ko');
      await conv.showSku(sku);
    });

    await step('Act: Step 1 — Tick the row, click 재고 전환 and pick 보류재고 지정 (가용재고 → 보류재고)', async () => {
      await conv.openFor([{ row: list.row(sku.skuCode, cj.name), label: sku.skuCode }]);
      await conv.choose('SECURE_HOLD');
    });

    await step('Assert: Expected 1 — The dialog opens with 1 row', async () => {
      await expect(dialog.rows, '[Expected 1] The dialog holds 1 row').toHaveCount(1);
    });

    await step('Act: Step 2 — Read the source cell, type 18 and click 저장', async () => {
      await expect(conv.fromCell(0), 'The source cell is shown').toBeVisible();
      await dialog.fillLine(0, { quantity: '18' });
      posts = await conv.blockedSave();
    });

    await step('Assert: Expected 2 — The source cell shows 17 and saving is blocked', async () => {
      await expect(conv.fromCell(0), '[Expected 2] The source cell shows 17').toHaveText('17');
      expect(posts, '[Expected 2] No conversion request is sent').toBe(0);
    });

    await step('Act: Step 3 — Read the message that appears', async () => {
      await expect(dialog.errorAlert, 'The message is shown').toBeVisible();
    });

    await step(`Assert: Expected 3 — The message shows ${t('err.convertQuantityExceeds')}`, async () => {
      await expect(dialog.errorAlert, `[Expected 3] The message is ${t('err.convertQuantityExceeds')}`).toContainText(t('err.convertQuantityExceeds'));
    });

    await step('Act: Step 4 — Change the quantity to 17, click 저장 and read 가용재고 and 보류재고', async () => {
      await dialog.fillLine(0, { quantity: '17' });
      saved = await conv.saveAndReload();
      after = await readNumbers(list, sku, cj);
    });

    await step('Assert: Expected 4 — 등록되었습니다, available 0 and on hold 17', async () => {
      expect(saved.status, `[Expected 4] The value at the upper limit is taken (${brief(saved)})`).toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 4] The message ${t('msg.registered')} appears`).toContainText(t('msg.registered'));
      expect(after.available, '[Expected 4] 가용재고 shows 0').toBe(0);
      expect(after.hold, '[Expected 4] 보류재고 shows 17').toBe(17);
    });
  });

  test('TC_US134_260 — A row blocked by the CS flag is left out while the other row still saves', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_260',
      'High',
      TAGS,
      `With CS재고 확보 on a 관리함 row (available 120, CS 20) and a 관리안함 row (available 80), the unmanaged row is greyed out with 관리안함; 30 on the managed row saves with 등록되었습니다, the request carries exactly 1 entry (the managed SKU), and the rows read 90 and 80. ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    const cj = world.warehouses.CJ;
    let skus: WorldSku[] = [];
    let at = [0, 1];
    let saved!: ConversionSave;
    const after: RowNumbers[] = [];

    await step('Arrange: Pre-condition 1–4 — Own rows in CJ Incheon Aam: 관리함 (available 120, CS 20) and 관리안함 (available 80)', async () => {
      skus = await ownPair(world, 'TC260', [
        { warehouse: cj, buckets: { available: 120, cs: 20, csManaged: true } },
        { warehouse: cj, buckets: { available: 80, csManaged: false } },
      ]);
      await list.open('ko');
      await conv.showGroup(skus[0]);
    });

    await step('Act: Step 1 — Tick both rows, click 재고 전환 and pick CS재고 확보 (가용재고 → CS재고)', async () => {
      await conv.openFor(skus.map((sku) => ({ row: list.row(sku.skuCode, cj.name), label: sku.skuCode })));
      at = await conv.lineIndexes(skus);
      await conv.choose('SECURE_CS');
    });

    await step('Assert: Expected 1 — 2 rows: the managed one usable, the unmanaged one greyed out with 관리안함', async () => {
      await expect(dialog.rows, '[Expected 1] The dialog holds 2 rows').toHaveCount(2);
      await expect(dialog.quantityInput(at[0]), '[Expected 1] The managed row is usable').toBeEnabled();
      await expect(dialog.quantityInput(at[1]), '[Expected 1] The unmanaged row is greyed out').toBeDisabled();
      await expect(dialog.rows.nth(at[1]), `[Expected 1] The unmanaged row shows ${t('label.notManaged')}`).toContainText(t('label.notManaged'));
    });

    await step('Act: Step 2 — Type 30 on the managed row and leave the unmanaged row alone', async () => {
      await dialog.fillLine(at[0], { quantity: '30' });
    });

    await step('Assert: Expected 2 — The managed row holds 30 and the unmanaged row has no value', async () => {
      await expect(dialog.quantityInput(at[0]), '[Expected 2] The managed row holds 30').toHaveValue('30');
      await expect(dialog.quantityInput(at[1]), '[Expected 2] The unmanaged row has no value').toHaveValue('');
    });

    await step('Act: Step 3 — Click 저장 and read the data sent to the server', async () => {
      saved = await conv.saveAndReload();
    });

    await step('Assert: Expected 3 — 등록되었습니다 and exactly 1 row entry in the data sent, for the managed SKU', async () => {
      expect(saved.status, `[Expected 3] The save goes through (${brief(saved)})`).toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 3] The message ${t('msg.registered')} appears`).toContainText(t('msg.registered'));
      expect(saved.payload.items?.length, '[Expected 3] The data sent has exactly 1 row entry').toBe(1);
      expect(Number(saved.payload.items?.[0]?.skuId), '[Expected 3] The entry is for the managed SKU').toBe(skus[0].skuId);
    });

    await step('Act: Step 4 — Read 가용재고 on both rows of the reloaded list', async () => {
      for (const sku of skus) after.push(await readNumbers(list, sku, cj));
    });

    await step('Assert: Expected 4 — The managed row shows 90 and the unmanaged row still 80', async () => {
      expect(after[0].available, '[Expected 4] The managed row shows 90').toBe(90);
      expect(after[1].available, '[Expected 4] The unmanaged row still shows 80 — nothing was written to it').toBe(80);
    });
  });

  test('TC_US134_261 — The conversion quantity is accepted at 1,000,000,000 and rejected above it', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_261',
      'Medium',
      TAGS,
      `On a row with available 2,000,000,500, 보류재고 지정 1000000000 saves with 등록되었습니다; 1000000001 is rejected with WH-STOCK_QUANTITY_EXCEEDED [proposed] "전환수량이 허용 범위를 초과했습니다.", the dialog stays open and no conversion is created. The TC raises the seed 500 with two 재고 조정 saves of 1000000000; here the row is seeded with 2000000500 directly. Deviation TC ≠ UI (frontend bundle 05/10, confirmed by the 06/10 run): the quantity field refuses any value above 1,000,000,000 as it is typed, so the over-limit value never reaches the server and no WH-STOCK_QUANTITY_EXCEEDED code / message can appear — Expected 3 is asserted as the TC writes it (soft, so Expected 4 still runs). ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    const cj = world.warehouses.CJ;
    let sku!: WorldSku;
    let saved!: ConversionSave;
    let over: ConversionSave | null = null;
    let conversionsBefore = 0;
    let conversionsAfter = 0;

    await step('Arrange: Pre-condition 1–3 — Own row in CJ Incheon Aam with available 2000000500', async () => {
      sku = await ownRow(world, 'TC261', cj, { available: 2_000_000_500, csManaged: false });
      await list.open('ko');
      await conv.showSku(sku);
    });

    await step('Act: Step 1 — Tick the row, click 재고 전환 and pick 보류재고 지정 (가용재고 → 보류재고)', async () => {
      await conv.openFor([{ row: list.row(sku.skuCode, cj.name), label: sku.skuCode }]);
      await conv.choose('SECURE_HOLD');
    });

    await step('Assert: Expected 1 — The dialog opens with 1 row', async () => {
      await expect(dialog.rows, '[Expected 1] The dialog holds 1 row').toHaveCount(1);
    });

    await step('Act: Step 2 — Type 1000000000 into 전환수량 and click 저장', async () => {
      await dialog.fillLine(0, { quantity: '1000000000' });
      saved = await conv.saveAndReload();
    });

    await step('Assert: Expected 2 — The save goes through and shows 등록되었습니다 (Registered.)', async () => {
      expect(saved.status, `[Expected 2] The maximum 1000000000 is taken (${brief(saved)})`).toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 2] The message ${t('msg.registered')} appears`).toContainText(t('msg.registered'));
    });

    await step('Act: Step 3 — Open the dialog again, pick the same policy, type 1000000001 and click 저장', async () => {
      conversionsBefore = await conversionCount(sku.skuId);
      await conv.openFor([{ row: list.row(sku.skuCode, cj.name), label: sku.skuCode }]);
      await conv.choose('SECURE_HOLD');
      await dialog.quantityInput(0).fill('1000000001');
      over = await conv.trySave(10_000);
    });

    await step('Assert: Expected 3 — Blocked with WH-STOCK_QUANTITY_EXCEEDED: 전환수량이 허용 범위를 초과했습니다.', async () => {
      const error = errorOf(over ?? { status: 0, body: {} });
      expect.soft(error.code, `[Expected 3] The code is WH-STOCK_QUANTITY_EXCEEDED (${brief(over)})`).toBe('WH-STOCK_QUANTITY_EXCEEDED');
      await expect.soft(dialog.errorAlert, '[Expected 3] The message 전환수량이 허용 범위를 초과했습니다. is shown').toContainText('전환수량이 허용 범위를 초과했습니다.');
    });

    await step('Act: Step 4 — Read what the screen shows and whether any conversion was created', async () => {
      conversionsAfter = await conversionCount(sku.skuId);
    });

    await step('Assert: Expected 4 — The dialog stays open and no conversion is created', async () => {
      await expect(dialog.root, '[Expected 4] The dialog stays open').toBeVisible();
      expect(conversionsAfter, '[Expected 4] No conversion is created').toBe(conversionsBefore);
    });
  });

  test('TC_US134_262 — The memo field holds 100 characters, drops emoji, takes Korean and is switched off on a blocked row', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_262',
      'Medium',
      TAGS,
      `With CS재고 확보 on a 관리함 and a 관리안함 row, 메모 of the managed row takes exactly 100 characters (counter 100/100), refuses a 101st, drops the emoji of "${MEMO_EMOJI}" and takes "${MEMO_KO}"; 메모 of the unmanaged row takes nothing. Nothing is saved. ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    const cj = world.warehouses.CJ;
    let skus: WorldSku[] = [];
    let at = [0, 1];
    const values = { full: '', overflow: '', emoji: '', korean: '', blocked: '' };

    await step('Arrange: Pre-condition 1–3 — Own rows in CJ Incheon Aam: one 관리함, one 관리안함', async () => {
      skus = await ownPair(world, 'TC262', [
        { warehouse: cj, buckets: { available: 120, cs: 20, csManaged: true } },
        { warehouse: cj, buckets: { available: 50, csManaged: false } },
      ]);
      await list.open('ko');
      await conv.showGroup(skus[0]);
    });

    await step('Act: Step 1 — Tick both rows, click 재고 전환 and pick CS재고 확보 (가용재고 → CS재고)', async () => {
      await conv.openFor(skus.map((sku) => ({ row: list.row(sku.skuCode, cj.name), label: sku.skuCode })));
      at = await conv.lineIndexes(skus);
      await conv.choose('SECURE_CS');
    });

    await step('Assert: Expected 1 — The dialog opens with 2 rows', async () => {
      await expect(dialog.rows, '[Expected 1] The dialog holds 2 rows').toHaveCount(2);
    });

    await step('Act: Step 2 — Type the 100-character value into 메모 on the managed row and read the counter', async () => {
      await dialog.memoInput(at[0]).fill(MEMO_100);
      values.full = await dialog.memoInput(at[0]).inputValue();
    });

    await step('Assert: Expected 2 — All 100 characters taken and the counter shows 100/100', async () => {
      expect(values.full, '[Expected 2] The field holds the 100-character value').toBe(MEMO_100);
      await expect(conv.memoCounter(at[0]), '[Expected 2] The counter shows 100/100').toHaveText(/^\s*100\s*\/\s*100\s*$/);
    });

    await step('Act: Step 3 — Try 1 more character, then the emoji value, then the Korean value', async () => {
      await dialog.memoInput(at[0]).press('End');
      await dialog.memoInput(at[0]).pressSequentially('X');
      values.overflow = await dialog.memoInput(at[0]).inputValue();
      await dialog.memoInput(at[0]).fill(MEMO_EMOJI);
      values.emoji = await dialog.memoInput(at[0]).inputValue();
      await dialog.memoInput(at[0]).fill(MEMO_KO);
      values.korean = await dialog.memoInput(at[0]).inputValue();
    });

    await step('Assert: Expected 3 — Never past 100 characters, the emoji is not taken, the Korean value is', async () => {
      expect(values.overflow.length, '[Expected 3] The field does not go past 100 characters').toBe(100);
      expect(values.emoji, '[Expected 3] The emoji is not taken').not.toContain('🔁');
      expect(values.emoji, '[Expected 3] The text around the emoji is kept').toContain('Demo memo');
      expect(values.korean, `[Expected 3] The Korean value ${MEMO_KO} is taken`).toBe(MEMO_KO);
    });

    await step('Act: Step 4 — Try typing into 메모 on the unmanaged row', async () => {
      values.blocked = await conv.tryType(dialog.memoInput(at[1]), 'Demo memo');
    });

    await step('Assert: Expected 4 — The field takes no characters', async () => {
      expect(values.blocked, '[Expected 4] 메모 of the unmanaged row takes no characters').toBe('');
      await expect(dialog.memoInput(at[1]), '[Expected 4] 메모 of the unmanaged row is switched off').toBeDisabled();
    });
  });

  test('TC_US134_263 — The server rejects a quantity above the latest source stock changed by another session', async ({ page, world, stockApi, conversionDialog: dialog }) => {
    const step = makeStep(page);
    const sentence = '전환 전 구분의 현재수량을 초과한 전환수량은 등록할 수 없습니다.';
    await tcMeta(
      'TC_US134_263',
      'Medium',
      TAGS,
      `The dialog opens with source 17; a second session (API 재고 조정 차감 15) pulls available stock down to 2 while the dialog stays open; the dialog still compares against 17 and lets 15 through; the server rejects it with WH-STOCK_CONVERSION_NOT_ALLOWED "${sentence}", available stays 2, on hold unchanged, and the dialog stays open with the typed value. ${HOLD_NOTE} ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    const cj = world.warehouses.CJ;
    let sku!: WorldSku;
    let adjusted = 0;
    let result: ConversionSave | null = null;
    let stored: StoredBuckets | null = null;

    await step('Arrange: Pre-condition 1–4 — Own row in CJ Incheon Aam with available 17; a second authenticated session (API client)', async () => {
      sku = await ownRow(world, 'TC263', cj, { available: 17, csManaged: false });
      await list.open('ko');
      await conv.showSku(sku);
    });

    await step('Act: Step 1 — Tick the row, click 재고 전환 and pick 보류재고 지정 (가용재고 → 보류재고)', async () => {
      await conv.openFor([{ row: list.row(sku.skuCode, cj.name), label: sku.skuCode }]);
      await conv.choose('SECURE_HOLD');
    });

    await step('Assert: Expected 1 — The source cell shows 17, the value read when the dialog opened', async () => {
      await expect(conv.fromCell(0), '[Expected 1] The source cell shows 17').toHaveText('17');
    });

    await step('Act: Step 2 — Have the second session pull the available stock down to 2 while the dialog stays open', async () => {
      adjusted = (await stockApi.createAdjustments({ items: [{ skuId: sku.skuId, warehouseId: cj.id, adjustingQuantity: 15, modifyType: 'SUBTRACT', reason: 'ADJUSTMENT' }] })).status;
    });

    await step('Assert: Expected 2 — Nothing on the dialog changes, the screen check still compares against 17', async () => {
      expect(adjusted, 'The second session lowers the available stock to 2').toBeLessThan(300);
      expect((await storedBuckets(sku.skuId, cj.id))?.available, 'The stored available stock is now 2').toBe(2);
      await expect(conv.fromCell(0), '[Expected 2] The source cell still shows 17').toHaveText('17');
    });

    await step('Act: Step 3 — Type 15 into 전환수량 and click 저장', async () => {
      await dialog.fillLine(0, { quantity: '15' });
      result = await conv.trySave(15_000);
      stored = await storedBuckets(sku.skuId, cj.id);
    });

    await step('Assert: Expected 3 — Rejected with WH-STOCK_CONVERSION_NOT_ALLOWED; available stays 2 and on hold unchanged', async () => {
      expect(result, '[Expected 3] The screen check lets 15 through, so the request reaches the server').not.toBeNull();
      const error = errorOf(result ?? { status: 0, body: {} });
      expect(error.code, `[Expected 3] The code is WH-STOCK_CONVERSION_NOT_ALLOWED (${brief(result)})`).toBe('WH-STOCK_CONVERSION_NOT_ALLOWED');
      expect(error.message, `[Expected 3] The message is ${sentence}`).toContain(sentence);
      expect(stored?.available, '[Expected 3] Available stock stays 2').toBe(2);
      expect(stored?.hold, '[Expected 3] On-hold stock is unchanged (0)').toBe(0);
    });

    await step('Act: Step 4 — See whether the dialog is still open', async () => {
      await expect(dialog.table, 'The conversion table is read').toBeVisible();
    });

    await step('Assert: Expected 4 — The dialog is still open with the typed values', async () => {
      await expect(dialog.root, '[Expected 4] The dialog is still open').toBeVisible();
      await expect(dialog.quantityInput(0), '[Expected 4] 전환수량 still holds 15').toHaveValue('15');
      await expect(dialog.policySelect, '[Expected 4] 전환 구분 still holds 보류재고 지정').toHaveValue('SECURE_HOLD');
    });
  });

  test('TC_US134_264 — Save rejects a stock row deleted while the dialog is open', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    const { warehouse, note } = daegu(world);
    const sentence = 'SKU의 재고가 존재하지 않습니다.';
    await tcMeta(
      'TC_US134_264',
      'Medium',
      TAGS,
      `The dialog opens on a row with source 14; the stock row is deleted by DB fixture while the dialog stays open; 저장 of 5 is rejected with WH-STOCK_NOT_FOUND "${sentence}" carrying no SKU id or warehouse id, and the dialog stays open holding 5. ${note} ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    let sku!: WorldSku;
    let result: ConversionSave | null = null;

    await step('Arrange: Pre-condition 1–4 — Own row in CJ Daegu warehouse with available 14', async () => {
      sku = await ownRow(world, 'TC264', warehouse, { available: 14, csManaged: false });
      await list.open('ko');
      await conv.showSku(sku);
    });

    await step('Act: Step 1 — Tick the row, click 재고 전환 and pick 보류재고 지정 (가용재고 → 보류재고)', async () => {
      await conv.openFor([{ row: list.row(sku.skuCode, warehouse.name), label: sku.skuCode }]);
      await conv.choose('SECURE_HOLD');
    });

    await step('Assert: Expected 1 — The dialog opens with 1 row showing a source quantity of 14', async () => {
      await expect(dialog.rows, '[Expected 1] The dialog holds 1 row').toHaveCount(1);
      await expect(conv.fromCell(0), '[Expected 1] The source cell shows 14').toHaveText('14');
    });

    await step('Act: Step 2 — Delete the stock row in the database while the dialog stays open', async () => {
      await stockDb.deleteStock(sku.skuId, warehouse.id);
    });

    await step('Assert: Expected 2 — Nothing on the dialog changes', async () => {
      expect(await storedBuckets(sku.skuId, warehouse.id), 'The stock row is gone from the database').toBeNull();
      await expect(dialog.rows, '[Expected 2] The dialog still holds 1 row').toHaveCount(1);
      await expect(conv.fromCell(0), '[Expected 2] The source cell still shows 14').toHaveText('14');
    });

    await step('Act: Step 3 — Type 5 into 전환수량 and click 저장', async () => {
      await dialog.fillLine(0, { quantity: '5' });
      result = await conv.trySave(15_000);
    });

    await step(`Assert: Expected 3 — Rejected with WH-STOCK_NOT_FOUND: ${sentence} with no SKU id or warehouse id`, async () => {
      const error = errorOf(result ?? { status: 0, body: {} });
      expect(error.code, `[Expected 3] The code is WH-STOCK_NOT_FOUND (${brief(result)})`).toBe('WH-STOCK_NOT_FOUND');
      expect(error.message, `[Expected 3] The message is ${sentence}`).toContain(sentence);
      expect(error.message, '[Expected 3] The message carries no SKU id').not.toContain(String(sku.skuId));
      expect(error.message, '[Expected 3] The message carries no warehouse id').not.toContain(String(warehouse.id));
      await expect(dialog.errorAlert, '[Expected 3] The dialog shows the message').toContainText(sentence);
    });

    await step('Act: Step 4 — See whether the dialog is still open and still holds the typed value', async () => {
      await expect(dialog.table, 'The conversion table is read').toBeVisible();
    });

    await step('Assert: Expected 4 — The dialog is still open and still holds 5', async () => {
      await expect(dialog.root, '[Expected 4] The dialog is still open').toBeVisible();
      await expect(dialog.quantityInput(0), '[Expected 4] 전환수량 still holds 5').toHaveValue('5');
    });
  });

  test('TC_US134_265 — A conversion request naming the same stock row twice is turned down whole', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    const { warehouse: dg, note } = daegu(world);
    const cj = world.warehouses.CJ;
    const sentence = '같은 SKU와 창고를 한 번에 중복으로 전환할 수 없습니다.';
    await tcMeta(
      'TC_US134_265',
      'Medium',
      TAGS,
      `An API SECURE_HOLD request listing row 1 (available 120 / on hold 10) twice (5 each) and row 2 (14 / 0) once (3) is rejected with WH-DUPLICATED_STOCK_CONVERSION_TARGET [proposed] "${sentence}" and changes neither row; the same request with each row once goes through — 115 / 15 and 11 / 3. The rows are read through the list API (GET /stock-status). No UI path builds this payload. ${note} ${OWN_NOTE}`,
    );
    let skus: WorldSku[] = [];
    let duplicate = { status: 0, code: '', message: '' };
    let single = 0;
    const read: Record<string, Array<{ available: number; hold: number }>> = {};

    const readRows = async () =>
      Promise.all(
        [
          { sku: skus[0], warehouse: cj },
          { sku: skus[1], warehouse: dg },
        ].map(async ({ sku, warehouse }) => {
          const row = await stockApi.stockRow(sku.skuId, warehouse.id);
          return { available: row?.stock?.availableQuantity ?? Number.NaN, hold: row?.stock?.holdQuantity ?? Number.NaN };
        }),
      );

    await step('Arrange: Pre-condition 1–4 — Own rows: CJ Incheon Aam 120 / on hold 10, CJ Daegu warehouse 14 / on hold 0', async () => {
      skus = await ownPair(world, 'TC265', [
        { warehouse: cj, buckets: { available: 120, hold: 10, csManaged: false } },
        { warehouse: dg, buckets: { available: 14, hold: 0, csManaged: false } },
      ]);
      await page.goto('/commerce/product-stock/stock');
    });

    await step('Act: Step 1 — Send a SECURE_HOLD request listing row 1 twice (5 each) and row 2 once (3)', async () => {
      duplicate = errorOf(
        await stockApi.convert({
          policy: 'SECURE_HOLD',
          items: [
            { skuId: skus[0].skuId, warehouseId: cj.id, quantity: 5 },
            { skuId: skus[0].skuId, warehouseId: cj.id, quantity: 5 },
            { skuId: skus[1].skuId, warehouseId: dg.id, quantity: 3 },
          ],
        }),
      );
    });

    await step('Assert: Expected 1 — The request is turned down', async () => {
      expect(duplicate.status, '[Expected 1] The request is rejected').toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 2 — Read the code and the message', async () => {
      expect(duplicate, 'The error body is read').toBeDefined();
    });

    await step('Assert: Expected 2 — WH-DUPLICATED_STOCK_CONVERSION_TARGET with its message', async () => {
      expect(duplicate.code, '[Expected 2] The code is WH-DUPLICATED_STOCK_CONVERSION_TARGET').toBe('WH-DUPLICATED_STOCK_CONVERSION_TARGET');
      expect(duplicate.message, `[Expected 2] The message is ${sentence}`).toContain(sentence);
    });

    await step('Act: Step 3 — Read both rows on the list', async () => {
      read.after = await readRows();
    });

    await step('Assert: Expected 3 — Both rows unchanged: 120 / 10 and 14 / 0', async () => {
      expect(read.after[0], '[Expected 3] Row 1 still reads 120 / 10').toEqual({ available: 120, hold: 10 });
      expect(read.after[1], '[Expected 3] Row 2 still reads 14 / 0 — the whole request is rejected').toEqual({ available: 14, hold: 0 });
    });

    await step('Act: Step 4 — Send the same request with each row listed once', async () => {
      single = (
        await stockApi.convert({
          policy: 'SECURE_HOLD',
          items: [
            { skuId: skus[0].skuId, warehouseId: cj.id, quantity: 5 },
            { skuId: skus[1].skuId, warehouseId: dg.id, quantity: 3 },
          ],
        })
      ).status;
      read.single = await readRows();
    });

    await step('Assert: Expected 4 — The request goes through: 115 / 15 and 11 / 3', async () => {
      expect(single, '[Expected 4] The request goes through').toBeLessThan(300);
      expect(read.single[0], '[Expected 4] Row 1 reads 115 / 15').toEqual({ available: 115, hold: 15 });
      expect(read.single[1], '[Expected 4] Row 2 reads 11 / 3').toEqual({ available: 11, hold: 3 });
    });
  });

  test('TC_US134_266 — A conversion on a row outside a PLATFORM warehouse is refused with WH-WAREHOUSE_NOT_FOUND', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_266',
      'Medium',
      TAGS,
      'An API SECURE_HOLD 5 on a stock row in a SUPPLIER warehouse (available 10, on hold 0) is rejected with WH-WAREHOUSE_NOT_FOUND "창고를 찾을 수 없습니다. - id: {id}" carrying the real warehouse id, and the row still reads 10 / 0. Data: the SUPPLIER warehouse ("Demo Supplier Warehouse") is created for the test and the stock row on the test\'s own SKU is a DB fixture; both are removed afterwards. The F4 data-check pre-condition is informational and not verified here.',
    );
    let supplier!: WorldWarehouse;
    let sku!: WorldSku;
    let result = { status: 0, code: '', message: '' };
    let stored: StoredBuckets | null = null;

    await step('Arrange: Pre-condition 1–4 — Own SKU row in a SUPPLIER warehouse with available 10, on hold 0', async () => {
      supplier = asWorldWarehouse(await world.createWarehouse('Demo Supplier Warehouse', 'SUPPLIER'));
      sku = await ownRow(world, 'TC266', supplier, { available: 10, hold: 0 });
      await page.goto('/commerce/product-stock/stock');
    });

    await step('Act: Step 1 — Send a conversion call with policy SECURE_HOLD and quantity 5 for that row', async () => {
      result = errorOf(await stockApi.convert({ policy: 'SECURE_HOLD', items: [{ skuId: sku.skuId, warehouseId: supplier.id, quantity: 5 }] }));
    });

    await step('Assert: Expected 1 — The call is rejected', async () => {
      expect(result.status, '[Expected 1] The call is rejected').toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 2 — Read the code and the message', async () => {
      expect(result, 'The error body is read').toBeDefined();
    });

    await step('Assert: Expected 2 — WH-WAREHOUSE_NOT_FOUND: 창고를 찾을 수 없습니다. - id: {id} with the real warehouse id', async () => {
      expect(result.code, '[Expected 2] The code is WH-WAREHOUSE_NOT_FOUND').toBe('WH-WAREHOUSE_NOT_FOUND');
      expect(result.message, `[Expected 2] The message is 창고를 찾을 수 없습니다. - id: ${supplier.id}`).toContain(`창고를 찾을 수 없습니다. - id: ${supplier.id}`);
    });

    await step('Act: Step 3 — Read the stored quantities of the row', async () => {
      stored = await storedBuckets(sku.skuId, supplier.id);
    });

    await step('Assert: Expected 3 — The row still reads available 10 and on hold 0', async () => {
      expect(stored?.available, '[Expected 3] 가용재고 is still 10').toBe(10);
      expect(stored?.hold, '[Expected 3] 보류재고 is still 0').toBe(0);
    });
  });

  test('TC_US134_267 — A conversion that loses a race with another save is refused with the concurrent-change message', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    const sentence = '다른 요청이 이 자원을 먼저 변경했습니다. 새로고침 후 다시 시도하세요.';
    await tcMeta(
      'TC_US134_267',
      'Medium',
      TAGS,
      `Sessions A and B (2 browser tabs of the same login) open 재고 전환 on the same row (available 120, on hold 10) with 보류재고 지정 10 and 20; both saves are held in the browser and released together; one shows 등록되었습니다, the other is rejected with CMN-4090 "${sentence}" (not a 500) and keeps its dialog open with the typed value; only the winner is applied (110 / 20 or 100 / 30). Defect observed in the 06/10 run: both concurrent saves were accepted (201 + 201) — the conversion API has no concurrent-change (optimistic lock) check; Expected 3–4 are asserted as the TC writes them (soft, so Expected 5 still runs and shows what was applied). ${HOLD_NOTE} ${OWN_NOTE}`,
    );
    const a = pages(page, dialog);
    const cj = world.warehouses.CJ;
    const pageB = await page.context().newPage();
    await pageB.setViewportSize({ width: 1920, height: 1080 });
    const b = pages(pageB, new ConversionDialog(pageB));
    const holdA = await new StockListPagingPage(page, a.list).holdRequest((url, method) => method === 'POST' && new URL(url).pathname === CONVERSION_PATH);
    const holdB = await new StockListPagingPage(pageB, b.list).holdRequest((url, method) => method === 'POST' && new URL(url).pathname === CONVERSION_PATH);
    let sku!: WorldSku;
    const results: Record<'A' | 'B', ConversionSave> = {} as Record<'A' | 'B', ConversionSave>;
    let after!: RowNumbers;

    try {
      await step('Arrange: Pre-condition 1–3 — Own row in CJ Incheon Aam (available 120, on hold 10); sessions A and B; both saves held so they reach the server together', async () => {
        sku = await ownRow(world, 'TC267', cj, { available: 120, hold: 10, csManaged: false });
        for (const session of [a, b]) {
          await session.list.open('ko');
          await session.conv.showSku(sku);
        }
      });

      await step('Act: Step 1 — In sessions A and B, tick the row, click 재고 전환 and pick 보류재고 지정', async () => {
        for (const session of [a, b]) {
          await session.conv.openFor([{ row: session.list.row(sku.skuCode, cj.name), label: sku.skuCode }]);
          await session.conv.choose('SECURE_HOLD');
        }
      });

      await step('Assert: Expected 1 — Both dialogs open on the same row', async () => {
        for (const [name, session] of [['A', a], ['B', b]] as const) {
          await expect(session.conv.dialog.rows, `[Expected 1] The session ${name} dialog holds 1 row`).toHaveCount(1);
          await expect(session.conv.dialog.rows.nth(0), `[Expected 1] The session ${name} dialog shows ${sku.skuCode}`).toContainText(sku.skuCode);
        }
      });

      await step('Act: Step 2 — Type 10 in session A and 20 in session B', async () => {
        await a.conv.dialog.fillLine(0, { quantity: '10' });
        await b.conv.dialog.fillLine(0, { quantity: '20' });
      });

      await step('Assert: Expected 2 — Both values are typed', async () => {
        await expect(a.conv.dialog.quantityInput(0), '[Expected 2] Session A holds 10').toHaveValue('10');
        await expect(b.conv.dialog.quantityInput(0), '[Expected 2] Session B holds 20').toHaveValue('20');
      });

      await step('Act: Step 3 — Send both saves at the same moment', async () => {
        const savedA = a.conv.save();
        const savedB = b.conv.save();
        await Promise.all([holdA.seen, holdB.seen]);
        holdA.release();
        holdB.release();
        [results.A, results.B] = await Promise.all([savedA, savedB]);
      });

      await step('Assert: Expected 3 — One save goes through and shows 등록되었습니다 (Registered.)', async () => {
        const winners = (['A', 'B'] as const).filter((name) => results[name].status < 300);
        expect.soft(winners.length, `[Expected 3] Exactly one save goes through (A ${brief(results.A)}; B ${brief(results.B)})`).toBe(1);
        const winner = winners[0] === 'B' ? b : a;
        await expect.soft(winner.list.lastToast(), `[Expected 3] The winner shows ${t('msg.registered')}`).toContainText(t('msg.registered'));
      });

      await step('Act: Step 4 — Read the response and the dialog of the session that lost', async () => {
        await expect(page.locator('body'), 'Session A is still shown').toBeVisible();
      });

      await step('Assert: Expected 4 — The loser is rejected with CMN-4090 (not a 500) and keeps its dialog open with the typed value', async () => {
        const loserName = results.A.status < 300 ? 'B' : 'A';
        const loser = loserName === 'B' ? b : a;
        const error = errorOf(results[loserName]);
        expect.soft(error.status, `[Expected 4] The losing save (${loserName}) is not a 500`).not.toBe(500);
        expect.soft(error.code, `[Expected 4] The losing save (${loserName}) is rejected with CMN-4090`).toBe('CMN-4090');
        expect.soft(error.message, `[Expected 4] The message is ${sentence}`).toContain(sentence);
        await expect.soft(loser.conv.dialog.root, `[Expected 4] The session ${loserName} dialog stays open`).toBeVisible();
        await expect.soft(loser.conv.dialog.quantityInput(0), `[Expected 4] The session ${loserName} dialog keeps the typed value`).toHaveValue(loserName === 'A' ? '10' : '20');
      });

      await step('Act: Step 5 — Reload the list and read the row', async () => {
        await a.list.open('ko');
        await a.conv.showSku(sku);
        after = await readNumbers(a.list, sku, cj);
      });

      await step('Assert: Expected 5 — Only the winning conversion is applied: 110 / 20 if A won, 100 / 30 if B won', async () => {
        const expected = results.A.status < 300 ? { available: 110, hold: 20 } : { available: 100, hold: 30 };
        expect({ available: after.available, hold: after.hold }, '[Expected 5] Only the winning conversion is applied').toEqual(expected);
      });
    } finally {
      await holdA.dispose();
      await holdB.dispose();
      await pageB.close();
    }
  });

  test('TC_US134_268 — Cancel asks first when something has been typed and the dialog opens clean afterwards', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    const cj = world.warehouses.CJ;
    const row = world.row('SKU0001', cj);
    await tcMeta(
      'TC_US134_268',
      'Low',
      TAGS,
      `On DEMO-SKU-0001, 취소 with nothing typed closes the dialog without a question; after picking 보류재고 지정 and typing 30, 취소 opens a confirm box "${t('msg.closeWithoutSaving')}" and the dialog closes on confirming; reopening shows 전환 구분 at 선택 and an empty quantity. The dialog is opened on the shared row and nothing is saved. ${WORLD_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    let confirmText = '';
    const listRow = () => list.row(row.sku.skuCode, cj.name);

    await step('Arrange: Pre-condition 1–3 — DEMO-SKU-0001 in CJ Incheon Aam, CS managed', async () => {
      expect(row.buckets.csManaged, 'DEMO-SKU-0001 @ CJ Incheon Aam is CS managed').toBe(true);
      await showWorld(list, world);
    });

    await step('Act: Step 1 — Tick the row, click 재고 전환 and click 취소 with nothing typed', async () => {
      await conv.openFor([{ row: listRow(), label: row.sku.skuCode }]);
      await dialog.clickCancel();
    });

    await step('Assert: Expected 1 — The dialog closes with no question', async () => {
      await expect(dialog.root, '[Expected 1] The dialog closes').toHaveCount(0);
      await expect(dialog.confirmClose, '[Expected 1] No confirm box is shown').toHaveCount(0);
    });

    await step('Act: Step 2 — Open the dialog again, pick 보류재고 지정, type 30 and click 취소', async () => {
      await conv.openFor([{ row: listRow(), label: row.sku.skuCode }]);
      await conv.choose('SECURE_HOLD');
      await dialog.fillLine(0, { quantity: '30' });
      await dialog.clickCancel();
    });

    await step('Assert: Expected 2 — A confirm dialog opens', async () => {
      await expect(dialog.confirmClose, '[Expected 2] A confirm box opens').toBeVisible();
    });

    await step('Act: Step 3 — Read the confirm dialog, then confirm closing', async () => {
      confirmText = squash(await dialog.confirmClose.innerText());
      await dialog.confirmDiscard();
    });

    await step(`Assert: Expected 3 — The confirm box shows ${t('msg.closeWithoutSaving')} and the dialog closes on confirming`, async () => {
      expect(confirmText, `[Expected 3] The confirm box shows ${t('msg.closeWithoutSaving')}`).toContain(t('msg.closeWithoutSaving'));
      await expect(dialog.root, '[Expected 3] The dialog closes').toHaveCount(0);
      await expect(dialog.confirmClose, '[Expected 3] The confirm box closes').toHaveCount(0);
    });

    await step('Act: Step 4 — Open the dialog again and read 전환 구분 and 전환수량', async () => {
      await conv.openFor([{ row: listRow(), label: row.sku.skuCode }]);
    });

    await step('Assert: Expected 4 — 전환 구분 back to 선택 and the quantity field empty', async () => {
      await expect(dialog.policySelect, '[Expected 4] No policy is picked').toHaveValue('');
      await expect(conv.selectedPolicyText(), `[Expected 4] 전환 구분 shows ${t('convert.policyPlaceholder')}`).toHaveText(t('convert.policyPlaceholder'));
      await expect(dialog.quantityInput(0), '[Expected 4] The quantity field is empty').toHaveValue('');
    });
  });

  test('TC_US134_269 — Save is blocked when the conversion quantity is negative', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_269',
      'Medium',
      TAGS,
      `With 보류재고 지정 on a row (available 120, on hold 10), entering -1 and clicking 저장 is blocked with the row highlighted and "${t('err.convertQuantityMin')}", and no quantity changes. Deviation TC ≠ UI (frontend bundle 05/10, confirmed by the 06/10 run): the quantity field keeps digits only, so typing -1 leaves 1 in the field and 저장 registers a conversion of 1 (the dialog closes, available 119 / on hold 11) instead of blocking — Expected 3 is asserted as the TC writes it (soft, so Expected 4 still runs). ${HOLD_NOTE} ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    const cj = world.warehouses.CJ;
    let sku!: WorldSku;
    let typed = '';
    let result: ConversionSave | null = null;
    let stored: StoredBuckets | null = null;

    await step('Arrange: Pre-condition 1–2 — Own row in CJ Incheon Aam: available 120, on hold 10', async () => {
      sku = await ownRow(world, 'TC269', cj, { available: 120, hold: 10, csManaged: true });
      await list.open('ko');
      await conv.showSku(sku);
    });

    await step('Act: Step 1 — Tick the row and click 재고 전환', async () => {
      await conv.openFor([{ row: list.row(sku.skuCode, cj.name), label: sku.skuCode }]);
    });

    await step('Assert: Expected 1 — The dialog opens with 1 row', async () => {
      await expect(dialog.rows, '[Expected 1] The dialog holds 1 row').toHaveCount(1);
    });

    await step('Act: Step 2 — Select 보류재고 지정 (가용재고 → 보류재고)', async () => {
      await conv.choose('SECURE_HOLD');
    });

    await step('Assert: Expected 2 — Source 가용재고 120 and target 보류재고 10', async () => {
      await expect(conv.fromCell(0), '[Expected 2] The source cell shows 120').toHaveText('120');
      await expect(conv.toCell(0), '[Expected 2] The target cell shows 10').toHaveText('10');
    });

    await step('Act: Step 3 — Enter -1 in 전환수량 and click 저장', async () => {
      await dialog.quantityInput(0).pressSequentially('-1');
      typed = await dialog.quantityInput(0).inputValue();
      result = await conv.trySave(5_000);
    });

    await step('Assert: Expected 3 — Save is blocked and the row is highlighted', async () => {
      expect.soft(result, `[Expected 3] No conversion is sent for -1 (field held "${typed}", ${brief(result)})`).toBeNull();
      await expect.soft(dialog.root, '[Expected 3] The dialog stays open').toBeVisible();
      expect.soft(await conv.lineHighlighted(0), '[Expected 3] The row is highlighted').toBe(true);
    });

    await step('Act: Step 4 — Read the validation message and check whether any stock quantity changed', async () => {
      stored = await storedBuckets(sku.skuId, cj.id);
    });

    await step(`Assert: Expected 4 — The message shows ${t('err.convertQuantityMin')} and no stock quantity changes`, async () => {
      await expect.soft(dialog.errorAlert, `[Expected 4] The message is ${t('err.convertQuantityMin')}`).toContainText(t('err.convertQuantityMin'));
      expect(stored?.available, '[Expected 4] 가용재고 is still 120').toBe(120);
      expect(stored?.hold, '[Expected 4] 보류재고 is still 10').toBe(10);
    });
  });

  test('TC_US134_270 — A failed save does not leave a partial stock conversion', async () => {
    await skipTc(
      'TC_US134_270',
      'Critical',
      TAGS,
      'Saving 보류재고 지정 5 on DEMO-SKU-0001 (120 / 10) while a failure is forced inside the conversion transaction shows no success message, leaves 가용재고 / 보류재고 all-or-nothing (120 / 10 or 115 / 15, never only one changed) and adds no 재고이력 movement.',
      'Needs the test environment to interrupt or force a failure inside the server-side conversion transaction (fault injection in the stock service); neither the browser nor the DB fixture can break the transaction half way — cutting the browser request does not stop the server write.',
    );
  });

  test('TC_US134_271 — A conversion between 2 buckets of one row adds no Stock History movement', async ({ page, world, conversionDialog: dialog, stockHistoryDialog: history }) => {
    const step = makeStep(page);
    const memo = 'Conversion history test';
    await tcMeta(
      'TC_US134_271',
      'High',
      TAGS,
      `재고이력 of a row (available 120, on hold 10) shows the same movement count before and after a saved 보류재고 지정 5 with memo "${memo}", and no movement for the conversion appears (in the dialog or in stock_usage). ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    const cj = world.warehouses.CJ;
    let sku!: WorldSku;
    let saved!: ConversionSave;
    const counts: Record<'before' | 'after', { ui: number; db: number }> = { before: { ui: -1, db: -1 }, after: { ui: -1, db: -1 } };
    let rowsText = '';

    const readHistory = async (): Promise<{ ui: number; db: number }> => {
      await list.openHistory(list.row(sku.skuCode, cj.name));
      await history.waitOpen('ko');
      await history.waitLoaded();
      const empty = (await history.rows.filter({ hasText: t('empty.noResults') }).count()) === 1;
      const ui = empty ? 0 : await history.rows.count();
      rowsText = squash(await history.table.innerText());
      const db = (await stockDb.usages(sku.skuId, cj.id)).length;
      await history.close();
      return { ui, db };
    };

    await step('Arrange: Pre-condition 1–3 — Own row in CJ Incheon Aam: available 120, on hold 10', async () => {
      sku = await ownRow(world, 'TC271', cj, { available: 120, hold: 10, csManaged: true });
      await list.open('ko');
      await conv.showSku(sku);
    });

    await step('Act: Step 1 — Open 재고이력 for the row and record the current movement count', async () => {
      counts.before = await readHistory();
    });

    await step('Assert: Expected 1 — The baseline movement count is recorded', async () => {
      expect(counts.before.ui, '[Expected 1] The baseline count is read from 재고이력').toBeGreaterThanOrEqual(0);
      expect(counts.before.db, '[Expected 1] The baseline count matches the stored movements').toBe(counts.before.ui);
    });

    await step('Act: Step 2 — Run 재고 전환 with 보류재고 지정 5 and the memo, and save it', async () => {
      saved = await conv.runConversion(list.row(sku.skuCode, cj.name), sku.skuCode, 'SECURE_HOLD', '5', memo);
    });

    await step('Assert: Expected 2 — The save succeeds and 등록되었습니다 (Registered.) is shown', async () => {
      expect(saved.status, `[Expected 2] The save goes through (${brief(saved)})`).toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 2] The message ${t('msg.registered')} appears`).toContainText(t('msg.registered'));
    });

    await step('Act: Step 3 — Open 재고이력 again', async () => {
      counts.after = await readHistory();
    });

    await step('Assert: Expected 3 — The same movement count as the baseline', async () => {
      expect(counts.after.ui, '[Expected 3] 재고이력 shows the baseline movement count').toBe(counts.before.ui);
      expect(counts.after.db, '[Expected 3] No movement is stored for the conversion').toBe(counts.before.db);
    });

    await step('Act: Step 4 — Look for any movement created by this conversion', async () => {
      expect(rowsText, 'The 재고이력 table text is read').toBeDefined();
    });

    await step('Assert: Expected 4 — No movement for this conversion appears', async () => {
      expect(rowsText, `[Expected 4] No 재고이력 row carries the memo ${memo}`).not.toContain(memo);
      expect(rowsText, '[Expected 4] No 재고이력 row is typed as a conversion').not.toMatch(/전환|CONVERSION/);
    });
  });

  test('TC_US134_272 — Stock conversion opens for each virtual warehouse type and Stock History stays available', async ({ page, world, conversionDialog: dialog }) => {
    const step = makeStep(page);
    const cj = world.warehouses.CJ;
    const buckets = [
      { n: 1, type: 'QUARANTINE', warehouse: asWorldWarehouse(world.bucket(cj, '이슈격리')) },
      { n: 2, type: 'SCRAP', warehouse: asWorldWarehouse(world.bucket(cj, '폐기')) },
      { n: 3, type: 'DEFECTIVE', warehouse: asWorldWarehouse(world.bucket(cj, '불량')) },
    ] as const;
    await tcMeta(
      'TC_US134_272',
      'Medium',
      TAGS,
      `The test's own SKU has a row (available 10, on hold 10) in each of the QUARANTINE (이슈격리), SCRAP (폐기) and DEFECTIVE (불량) virtual warehouses of the automation CJ Incheon Aam (DB fixtures); 재고 전환 opens on each of them (closed without saving), and 재고이력 is available on all 3 rows. ${OWN_NOTE}`,
    );
    const { list, conv } = pages(page, dialog);
    let sku!: WorldSku;
    const opened: Record<number, { visible: boolean; rows: number }> = {};

    await step('Arrange: Pre-condition 1–2 — Own SKU rows in the QUARANTINE, SCRAP and DEFECTIVE warehouses, each available 10 and on hold 10', async () => {
      sku = await ownPhysicalSku(world, 'TC272');
      for (const bucket of buckets) await world.seedStock(sku, bucket.warehouse, { available: 10, hold: 10 });
      await list.open('ko');
      await conv.showSku(sku);
    });

    for (const bucket of buckets) {
      await step(`Act: Step ${bucket.n} — Tick the row in the ${bucket.type} warehouse and click 재고 전환; then close the dialog`, async () => {
        const row = list.row(sku.skuCode, bucket.warehouse.name);
        await conv.openFor([{ row, label: `${sku.skuCode} @ ${bucket.warehouse.name}` }]);
        opened[bucket.n] = { visible: await dialog.root.isVisible(), rows: await dialog.rows.count() };
        await conv.discard();
        await list.checkbox(row).uncheck();
      });

      await step(`Assert: Expected ${bucket.n} — The Stock conversion dialog opens for the ${bucket.type} row`, async () => {
        expect(opened[bucket.n].visible, `[Expected ${bucket.n}] The 재고 전환 dialog opens for the ${bucket.type} row`).toBe(true);
        expect(opened[bucket.n].rows, `[Expected ${bucket.n}] The dialog holds the ${bucket.type} row`).toBe(1);
      });
    }

    await step('Act: Step 4 — Check the 재고이력 (Stock history) action on all 3 rows', async () => {
      await expect(list.row(sku.skuCode, buckets[0].warehouse.name), 'The QUARANTINE row is listed').toBeVisible();
    });

    await step('Assert: Expected 4 — Stock History is available on all 3 rows', async () => {
      for (const bucket of buckets) {
        const button = list.row(sku.skuCode, bucket.warehouse.name).getByRole('button', { name: iconButtonName(t('btn.stockHistory')) });
        await expect(button, `[Expected 4] 재고이력 is shown on the ${bucket.type} row`).toBeVisible();
        await expect(button, `[Expected 4] 재고이력 is usable on the ${bucket.type} row`).toBeEnabled();
      }
    });
  });
});
