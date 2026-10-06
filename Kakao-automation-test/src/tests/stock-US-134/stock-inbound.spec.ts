import type { RowDataPacket } from 'mysql2/promise';
import { test, expect } from '@fixtures/stock.fixture';
import { openWarehouseApi } from '@api/warehouse.api';
import { makeStep } from '@utils/step';
import { skipTc, tcMeta } from '@utils/tc-meta';
import { stx, StockTextKey } from '@utils/stock.i18n';
import { WORLD_NOTE, stockTags } from '@utils/stock-spec';
import { stockDb } from '@utils/stock-db';
import type { StockWorld, WorldSku, WorldWarehouse } from '@utils/stock.data';
import type { IncomingDialog } from '@pages/stock-dialogs.page';
import { NUMERIC_COLUMNS, StockCalculationPage, ownGroupName, ownPhysicalSku, seedIncoming, squash } from '@pages/stock-calculation.page';
import {
  INCOMING_PATH,
  InboundSave,
  IncomingRecord,
  StockInboundPage,
  clearCjWarehouseCode,
  dbDate,
  errorOf,
  firstOfNextMonth,
  forceIncomingStatus,
  incomingHeader,
  incomingItems,
  incomingsOf,
  incomingsToWarehouse,
  kstDate,
  utcDate,
} from '@pages/stock-inbound.page';

/**
 * US134 — nhóm [Inbound Request] (TC_US134_174–204): dialog 입고 요청 — lưu, tạo bản ghi tồn kho, guard chọn dòng,
 * 1 dòng / SKU ID, ngày Seoul, 공급가 mặc định, 제조사 dạng text, lọc 입고지, server chặn kho SUPPLIER / INACTIVE,
 * 입고구분, 기타 사유, 입고예정수량, date picker, validate bắt buộc, giới hạn số lượng / 메모 / 공급가, lưu 2 lần,
 * double click, kho bị xoá, hộp xác nhận 취소. Mọi lần 저장 chạy trên SKU riêng của test (ownPhysicalSku + seedStock) —
 * dòng world dùng chung chỉ được mở dialog rồi đóng. TC cần log CJ connector / stub CJ / luồng US032-033 → skip kèm lý do.
 */
const TAGS = stockTags('inbound');
const t = (key: StockTextKey) => stx(key, 'ko');

/** Ngày dự kiến nhập dùng thay cho 2026-10-01 của TC (ngày đó đã qua ở ngày chạy). */
const EXPECTED_DATE = firstOfNextMonth();
const DATE_NOTE = `The TC date 2026-10-01 is already past on the run date, so the expected inbound date used is ${EXPECTED_DATE} (the 1st of next month, Seoul) to keep a minimum-date rule out of the way.`;
const OWN_NOTE = 'Data: every save runs on a physical SKU the test creates for itself (Demo Partner A · Demo Manufacturer 1 · cost price 12000) with a stock row seeded in the automation CJ Incheon Aam, so the shared demo rows keep their numbers; the teardown removes the SKU and its inbound records.';
const STATUS_NOTE = 'The inbound status screen (입고 현황) belongs to US032/US033, so the created request is read from the incoming / incoming_item tables (same records that screen lists).';
const CJ_NOTE = 'An inbound request into the automation CJ Incheon Aam (WMS · CJ_LOGISTICS, channel codes A12/CH01) makes the server register the SKU with the CJ connector; that call is server-to-server and is not observed here.';
const MEMO_100 = 'Demo inbound memo filler text repeated to exactly one hundred characters for this test run 123456789';

/** Kho đích của các TC "CJ Incheon Aam". */
function destination(world: StockWorld): WorldWarehouse {
  return world.warehouses.CJ;
}

/** SKU 현물 riêng của test có tồn kho ở CJ Incheon Aam. */
async function ownStockedSku(world: StockWorld, label: string, available = 100): Promise<WorldSku> {
  const sku = await ownPhysicalSku(world, label);
  await world.seedStock(sku, destination(world), { available, csManaged: false });
  return sku;
}

/** 2 SKU 현물 riêng cùng 1 상품코드 (Demo Manufacturer 1), cả 2 có tồn kho ở CJ Incheon Aam. */
async function ownStockedPair(world: StockWorld, label: string): Promise<WorldSku[]> {
  const skus = await world.createPhysicalSku(label, {
    partner: world.partners.A,
    manufacturer: world.manufacturers.M1,
    groupName: ownGroupName(world, label),
    lines: [{ option: 'Type A' }, { option: 'Type B' }],
  });
  for (const sku of skus) await world.seedStock(sku, destination(world), { available: 100, csManaged: false });
  return skus;
}

/** Màn list + helper dialog dùng chung trong 1 test. */
function pages(page: Parameters<typeof makeStep>[0], dialog: IncomingDialog): { list: StockCalculationPage; inbound: StockInboundPage } {
  const list = new StockCalculationPage(page);
  return { list, inbound: new StockInboundPage(page, list, dialog) };
}

/** Mở list và lọc ra 12 dòng world (20 dòng / trang). */
async function showWorld(list: StockCalculationPage, world: StockWorld): Promise<void> {
  await list.open('ko');
  await list.search('SKU_GROUP_NAME', world.keyword);
  await list.choosePageSize(20);
}

/** Giá trị đầy đủ của 1 lần lưu chuẩn (TC test data) cho 1 dòng. */
function standardForm(world: StockWorld, line: { supplyPrice?: string; quantity?: string } = {}) {
  return { warehouseId: destination(world).id, expectedDate: EXPECTED_DATE, lines: [{ supplyPrice: line.supplyPrice ?? '12000', quantity: line.quantity ?? '100' }] };
}

/** Phiếu 입고 mới (không nằm trong `before`). */
function newRecords(after: IncomingRecord[], before: IncomingRecord[]): IncomingRecord[] {
  const known = new Set(before.map((r) => r.incoming_id));
  return after.filter((r) => !known.has(r.incoming_id));
}

type PostCounter = ReturnType<StockInboundPage['countPosts']>;

/**
 * Bấm 저장 khi validate phía client phải chặn: đếm call POST /incoming trong lúc bấm và đợi dòng lỗi trong dialog —
 * trả về số call đã gửi (0 = bị chặn ở client).
 */
async function blockedSave(dialog: IncomingDialog, inbound: StockInboundPage): Promise<number> {
  const posts = inbound.countPosts();
  try {
    await dialog.clickSave();
    await expect(dialog.errorAlert, 'A message appears in the dialog').toBeVisible();
  } finally {
    posts.stop();
  }
  return posts.count;
}

/**
 * ref_id "rỗng" của incoming / incoming_item: NULL, hoặc 0 — server ghi cặp ref_type NONE + ref_id 0 cho phiếu không tham
 * chiếu (verify DB 05/10: mọi phiếu tạo từ dialog đều NONE / 0, phiếu từ đơn mua mang ref_type PURCHASE_ORDER + id thật).
 */
function emptyRefId(value: unknown): boolean {
  return value === null || value === undefined || Number(value) === 0;
}

/** Mọi khoá (kể cả lồng nhau) của payload JSON. */
function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys);
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, inner]) => [key, ...allKeys(inner)]);
  return [];
}

test.describe('[Inbound Request] Stock management — the 입고 요청 dialog', () => {
  test('TC_US134_174 — A successful save shows Registered., reloads the list, clears the ticks and keeps the expected inbound quantity at 60', async ({ page, world, incomingDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_174',
      'Critical',
      TAGS,
      `Saving an inbound request (CJ Incheon Aam, 발주, 공급가 12000, 요청 수량 100) for a row whose 입고예정수량 is 60 closes the dialog, shows 등록되었습니다, reloads the list with no row ticked, stores the request as REGISTERED (not REQUESTED) and leaves 입고예정수량 at 60. The starting 60 is a REQUESTED purchase-order inbound record inserted by DB fixture on the test's own SKU; as the SKU is new, no purchase order can name it (Step 2 is checked on its inbound records). ${STATUS_NOTE} ${DATE_NOTE} ${OWN_NOTE} ${CJ_NOTE}`,
    );
    const { list, inbound } = pages(page, dialog);
    const cj = destination(world);
    let sku!: WorldSku;
    let seededId = 0;
    let before = '';
    let records: IncomingRecord[] = [];
    let saved!: InboundSave;
    let reloaded!: Promise<boolean>;
    let created: IncomingRecord | undefined;
    let after = '';

    await step('Arrange: Pre-condition 1–3 — Physical row DEMO-SKU-0001 in CJ Incheon Aam (Demo Manufacturer 1) with 입고예정수량 60', async () => {
      sku = await ownStockedSku(world, 'TC174');
      seededId = await seedIncoming(sku, cj.id, { type: 'PURCHASE_ORDER', status: 'REQUESTED', quantity: 60 });
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management), find DEMO-SKU-0001 and read 입고예정수량 (Expected inbound quantity)', async () => {
      await list.open('ko');
      await list.findSku(sku);
      before = await list.cellText(list.row(sku.skuCode, cj.name), 'col.incomingQuantity');
    });

    await step('Assert: Expected 1 — The initial expected inbound quantity is 60', async () => {
      expect(before, '[Expected 1] 입고예정수량 starts at 60').toBe('60');
    });

    await step('Act: Step 2 — Confirm that no purchase order for DEMO-SKU-0001 in CJ Incheon Aam is at 발행 (Issued) state', async () => {
      records = await incomingsOf(sku);
    });

    await step('Assert: Expected 2 — No matching purchase order is in Issued state', async () => {
      expect(records.map((r) => r.incoming_id), '[Expected 2] The only inbound record of the SKU is the seeded one — no issued purchase order adds to it').toEqual([seededId]);
    });

    await step('Act: Step 3 — Tick DEMO-SKU-0001 and click 입고 요청 (Inbound request)', async () => {
      await inbound.openFor([{ row: list.row(sku.skuCode, cj.name), label: sku.skuCode }]);
    });

    await step('Assert: Expected 3 — The dialog opens with 1 row', async () => {
      await expect(dialog.root, '[Expected 3] The 입고 요청 dialog is open').toBeVisible();
      await expect(dialog.rows, '[Expected 3] The SKU 정보 table has 1 row').toHaveCount(1);
    });

    await step('Act: Step 4 — Fill every required field with the test data and click 저장 (Save)', async () => {
      await inbound.fill(standardForm(world));
      ({ save: saved, reloaded } = await inbound.saveWatchingReload());
    });

    await step('Assert: Expected 4 — The save succeeds and the dialog closes', async () => {
      expect(saved.status, `[Expected 4] POST ${INCOMING_PATH} succeeds (body ${JSON.stringify(saved.body).slice(0, 200)})`).toBeLessThan(300);
      await expect(dialog.root, '[Expected 4] The dialog closes').toHaveCount(0);
    });

    let listReloaded = false;
    await step('Act: Step 5 — Read the confirmation message, list refresh and tick-box state', async () => {
      listReloaded = await reloaded;
      await list.waitForList();
    });

    await step('Assert: Expected 5 — 등록되었습니다 (Registered.) appears, the list reloads and no row is selected', async () => {
      await expect(list.lastToast(), `[Expected 5] The message ${t('msg.registered')} appears`).toContainText(t('msg.registered'));
      expect(listReloaded, '[Expected 5] The stock list reloads after the save').toBe(true);
      await expect(inbound.checkedRowBoxes, '[Expected 5] No row is left ticked').toHaveCount(0);
    });

    await step('Act: Step 6 — Open the inbound status screen and read the state of the new request', async () => {
      created = newRecords(await incomingsOf(sku), records)[0];
    });

    await step('Assert: Expected 6 — The new inbound request is Registered, not Requested', async () => {
      expect(created, '[Expected 6] The new inbound request exists').toBeDefined();
      expect(created?.status, '[Expected 6] The new request is REGISTERED').toBe('REGISTERED');
      expect(created?.status, '[Expected 6] The new request is not REQUESTED').not.toBe('REQUESTED');
    });

    await step('Act: Step 7 — Return to Stock management and read 입고예정수량 for DEMO-SKU-0001 again', async () => {
      await list.findSku(sku);
      after = await list.cellText(list.row(sku.skuCode, cj.name), 'col.incomingQuantity');
    });

    await step('Assert: Expected 7 — The expected inbound quantity remains 60', async () => {
      expect(after, '[Expected 7] 입고예정수량 is still 60').toBe('60');
    });
  });

  test('TC_US134_175 — Requesting inbound for a SKU with no stock record creates its stock row at the chosen warehouse', async ({ page, world, incomingDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_175',
      'Critical',
      TAGS,
      `A physical SKU with no stock record shows "-" as 창고 and in the 10 quantity cells; an inbound request into CJ Incheon Aam (공급가 45000, 요청 수량 50) is saved with 등록되었습니다, after which the row shows CJ Incheon Aam, a number (0 included) in every quantity cell and a 재고이력 button. Data: DEMO-SKU-0005 of the world must stay without stock for other tests, so the test creates its own physical SKU with no stock record. Deviation seen on 05/10: the stock record created by the inbound request is not CS-managed (cs_stock_managed defaults to false), so the 2 CS cells (CS재고(가용재고) / CS재고(CS가능수량)) show 관리안함 instead of a number — the Expected 4 assertion follows the TC ("all quantity cells show numeric values"), to be confirmed by BA. ${DATE_NOTE} ${CJ_NOTE}`,
    );
    const { list, inbound } = pages(page, dialog);
    const cj = destination(world);
    let sku!: WorldSku;
    let beforeCells = { warehouse: '', numbers: [] as string[] };
    let saved!: InboundSave;
    let afterCells = { warehouse: '', numbers: [] as string[] };

    await step('Arrange: Pre-condition 1–4 — Physical SKU DEMO-SKU-0005 has no stock record; PLATFORM warehouse CJ Incheon Aam exists', async () => {
      sku = await ownPhysicalSku(world, 'TC175');
      expect(await stockDb.stocksOfSku(sku.skuId), 'The SKU has no stock record').toHaveLength(0);
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management), find DEMO-SKU-0005 and read its 창고 (Warehouse) cell and 10 quantity cells', async () => {
      await list.open('ko');
      await list.findSku(sku);
      const row = list.row(sku.skuCode);
      beforeCells = { warehouse: await list.cellText(row, 'col.warehouse'), numbers: await list.numericTexts(row) };
    });

    await step('Assert: Expected 1 — The Warehouse cell and all 10 quantity cells show a dash', async () => {
      expect(beforeCells.warehouse, '[Expected 1] 창고 shows a dash').toBe('-');
      NUMERIC_COLUMNS.forEach((column, index) => expect(beforeCells.numbers[index], `[Expected 1] ${t(column as StockTextKey)} shows a dash`).toBe('-'));
    });

    await step('Act: Step 2 — Tick the row and click 입고 요청 (Inbound request)', async () => {
      await inbound.openFor([{ row: list.row(sku.skuCode), label: sku.skuCode }]);
    });

    await step('Assert: Expected 2 — The Inbound Request dialog opens for DEMO-SKU-0005', async () => {
      await expect(dialog.root, '[Expected 2] The 입고 요청 dialog is open').toBeVisible();
      await expect(dialog.rows, '[Expected 2] The dialog holds 1 SKU row').toHaveCount(1);
      await expect(dialog.rows.first().locator('td').first(), `[Expected 2] The row is SKU ID ${sku.skuId}`).toHaveText(String(sku.skuId));
    });

    await step('Act: Step 3 — Fill every required field with the test data and click 저장 (Save)', async () => {
      await inbound.fill(standardForm(world, { supplyPrice: '45000', quantity: '50' }));
      saved = await inbound.save();
    });

    await step('Assert: Expected 3 — The request is saved and 등록되었습니다 (Registered.) appears', async () => {
      expect(saved.status, `[Expected 3] The inbound request is saved (body ${JSON.stringify(saved.body).slice(0, 200)})`).toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 3] The message ${t('msg.registered')} appears`).toContainText(t('msg.registered'));
    });

    await step('Act: Step 4 — On the reloaded list, find DEMO-SKU-0005 and read its Warehouse cell and 10 quantity cells', async () => {
      await list.findSku(sku);
      const row = list.row(sku.skuCode);
      afterCells = { warehouse: await list.cellText(row, 'col.warehouse'), numbers: await list.numericTexts(row) };
    });

    await step('Assert: Expected 4 — Warehouse shows CJ Incheon Aam; all quantity cells show numeric values, including 0 for zero values', async () => {
      expect(afterCells.warehouse, `[Expected 4] 창고 shows ${cj.name}`).toBe(cj.name);
      NUMERIC_COLUMNS.forEach((column, index) => expect.soft(afterCells.numbers[index], `[Expected 4] ${t(column as StockTextKey)} shows a number`).toMatch(/^-?\d[\d,]*$/));
    });

    await step('Act: Step 5 — Check the 재고이력 (Stock history) cell on the same row', async () => {
      await expect(list.row(sku.skuCode), 'The row is listed').toBeVisible();
    });

    await step('Assert: Expected 5 — A Stock history button is displayed', async () => {
      await expect(list.cell(list.row(sku.skuCode), 'col.stockHistory').getByRole('button'), `[Expected 5] The row shows a ${t('btn.stockHistory')} button`).toHaveCount(1);
    });
  });

  test('TC_US134_176 — Inbound request with no row ticked is blocked with the no-selection message and opens no dialog', async ({ page, world, incomingDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_176',
      'Medium',
      TAGS,
      `With no tick box selected, clicking 입고 요청 opens no dialog and shows "선택된 재고가 없습니다. 재고를 선택해주세요." above the table. ${WORLD_NOTE}`,
    );
    const { list, inbound } = pages(page, dialog);
    let guard = '';

    await step('Arrange: Pre-condition 1–2 — Stock data exists and no row is ticked', async () => {
      expect(world.stockRows.length, 'The demo world holds stock rows').toBeGreaterThan(0);
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management) and confirm no tick box is selected', async () => {
      await showWorld(list, world);
    });

    await step('Assert: Expected 1 — No row is ticked', async () => {
      await expect(inbound.checkedRowBoxes, '[Expected 1] No row is ticked').toHaveCount(0);
    });

    await step('Act: Step 2 — Click 입고 요청 (Inbound request)', async () => {
      await list.clickToolbar('btn.incomingRequest');
    });

    await step('Assert: Expected 2 — The action is blocked', async () => {
      await expect(list.guardAlert, '[Expected 2] A guard message blocks the action').toBeVisible();
      await expect(dialog.root, '[Expected 2] The 입고 요청 dialog does not open').toHaveCount(0);
    });

    await step('Act: Step 3 — Read the message that appears above the table', async () => {
      guard = squash(await list.guardAlert.innerText());
    });

    await step('Assert: Expected 3 — The message shows "선택된 재고가 없습니다. 재고를 선택해주세요."', async () => {
      expect(guard, '[Expected 3] The message is the no-selection sentence').toBe(squash(t('guard.noSelection')));
      const tableBox = await list.table.boundingBox();
      const guardBox = await list.guardAlert.boundingBox();
      expect(!!tableBox && !!guardBox && guardBox.y < tableBox.y, '[Expected 3] The message sits above the table').toBe(true);
    });

    await step('Act: Step 4 — Look at the screen for any dialog', async () => {
      await expect(list.table, 'The list is shown').toBeVisible();
    });

    await step('Assert: Expected 4 — No dialog opens', async () => {
      await expect(page.locator('.modal.show[role="dialog"]'), '[Expected 4] No dialog is open').toHaveCount(0);
    });
  });

  test('TC_US134_177 — Inbound request on rows of two manufacturers is blocked with the manufacturers-differ message', async ({ page, world, incomingDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_177',
      'High',
      TAGS,
      `Ticking DEMO-SKU-0001 (Demo Manufacturer 1) and DEMO-SKU-0009 (Demo Manufacturer 2), both in CJ Incheon Aam, and clicking 입고 요청 is blocked with "제조사가 다릅니다. 제조사를 확인해주세요." and no dialog opens. Read-only on the shared demo rows. ${WORLD_NOTE}`,
    );
    const { list } = pages(page, dialog);
    const first = world.row('SKU0001', world.warehouses.CJ);
    const second = world.row('SKU0009', world.warehouses.CJ);
    let guard = '';

    await step('Arrange: Pre-condition 1–2 — DEMO-SKU-0001 (Demo Manufacturer 1) and DEMO-SKU-0009 (Demo Manufacturer 2) are in CJ Incheon Aam', async () => {
      expect(first.sku.manufacturer?.id, 'DEMO-SKU-0001 is under Demo Manufacturer 1').toBe(world.manufacturers.M1.id);
      expect(second.sku.manufacturer?.id, 'DEMO-SKU-0009 is under Demo Manufacturer 2').toBe(world.manufacturers.M2.id);
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management), tick DEMO-SKU-0001 and DEMO-SKU-0009, and click 입고 요청 (Inbound request)', async () => {
      await showWorld(list, world);
      for (const seed of [first, second]) await list.tick(list.row(seed.sku.skuCode, seed.warehouse.name), seed.sku.skuCode);
      await list.clickToolbar('btn.incomingRequest');
    });

    await step('Assert: Expected 1 — The action is blocked', async () => {
      await expect(list.guardAlert, '[Expected 1] A guard message blocks the action').toBeVisible();
      await expect(dialog.root, '[Expected 1] The 입고 요청 dialog does not open').toHaveCount(0);
    });

    await step('Act: Step 2 — Read the message that appears and look for any dialog', async () => {
      guard = squash(await list.guardAlert.innerText());
    });

    await step('Assert: Expected 2 — The message shows "제조사가 다릅니다. 제조사를 확인해주세요." and no dialog opens', async () => {
      expect(guard, '[Expected 2] The message is the manufacturers-differ sentence').toBe(squash(t('guard.manufacturerDiffer')));
      await expect(page.locator('.modal.show[role="dialog"]'), '[Expected 2] No dialog is open').toHaveCount(0);
    });
  });

  test('TC_US134_178 — The same SKU ticked in two warehouses gives one row in the inbound request dialog', async ({ page, world, incomingDialog: dialog }) => {
    const step = makeStep(page);
    const second = world.warehouses.DAEGU ?? world.warehouses.GENERAL;
    await tcMeta(
      'TC_US134_178',
      'Medium',
      TAGS,
      `One SKU with stock rows in CJ Incheon Aam and CJ Daegu warehouse (both Demo Manufacturer 1), both ticked, opens the 입고 요청 dialog with exactly 1 row carrying that SKU ID. Data: the shared DEMO-SKU-0001 has stock only in CJ Incheon Aam, so the test creates its own physical SKU (its own SKU ID instead of 900000000000101) with a stock row in each warehouse.${world.warehouses.DAEGU ? '' : ` CJ Daegu warehouse could not be built (${world.daeguUnavailableReason}); the second warehouse is the automation general warehouse.`} ${WORLD_NOTE}`,
    );
    const { list, inbound } = pages(page, dialog);
    const cj = destination(world);
    let sku!: WorldSku;
    let rowIds: string[] = [];

    await step('Arrange: Pre-condition 1–3 — The same physical SKU has stock rows in CJ Incheon Aam and CJ Daegu warehouse, both Demo Manufacturer 1', async () => {
      sku = await ownStockedSku(world, 'TC178');
      await world.seedStock(sku, second, { available: 40, csManaged: false });
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management) and tick both rows of the SKU, the CJ Incheon Aam one and the CJ Daegu warehouse one', async () => {
      await list.open('ko');
      await list.findSku(sku);
      await list.tick(list.row(sku.skuCode, cj.name), `${sku.skuCode} @ ${cj.name}`);
      await list.tick(list.row(sku.skuCode, second.name), `${sku.skuCode} @ ${second.name}`);
    });

    await step('Assert: Expected 1 — Two rows are ticked', async () => {
      await expect(inbound.checkedRowBoxes, '[Expected 1] Two rows are ticked').toHaveCount(2);
    });

    await step('Act: Step 2 — Click 입고 요청 (Inbound request)', async () => {
      await list.clickToolbar('btn.incomingRequest');
    });

    await step('Assert: Expected 2 — The inbound request dialog opens', async () => {
      await expect(dialog.root, '[Expected 2] The 입고 요청 dialog opens').toBeVisible();
    });

    await step('Act: Step 3 — Count the rows in the SKU 정보 (SKU information) table', async () => {
      await expect(dialog.table, 'The SKU 정보 table is shown').toBeVisible();
    });

    await step('Assert: Expected 3 — The table has exactly 1 row', async () => {
      await expect(dialog.rows, '[Expected 3] The SKU 정보 table has exactly 1 row').toHaveCount(1);
    });

    await step('Act: Step 4 — Read the SKU ID on each row', async () => {
      rowIds = (await dialog.rows.locator('td:first-child').allInnerTexts()).map((text) => text.trim());
    });

    await step('Assert: Expected 4 — That single row shows the SKU ID of the SKU', async () => {
      expect(rowIds, `[Expected 4] The single row shows SKU ID ${sku.skuId}`).toEqual([String(sku.skuId)]);
    });
  });

  test('TC_US134_179 — Two different SKUs give one dialog row per SKU ID', async ({ page, world, incomingDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_179',
      'Medium',
      TAGS,
      `Ticking DEMO-SKU-0001 and DEMO-SKU-0002 (CJ Incheon Aam, Demo Manufacturer 1) opens the 입고 요청 dialog with exactly 2 rows, one per SKU ID (the world's own SKU IDs stand for 900000000000101 / 900000000000102). Read-only on the shared demo rows (the dialog is not saved). ${WORLD_NOTE}`,
    );
    const { list, inbound } = pages(page, dialog);
    const first = world.row('SKU0001', world.warehouses.CJ);
    const second = world.row('SKU0002', world.warehouses.CJ);
    let rowIds: string[] = [];

    await step('Arrange: Pre-condition 1–4 — DEMO-SKU-0001 and DEMO-SKU-0002 are in CJ Incheon Aam under Demo Manufacturer 1', async () => {
      expect(first.sku.manufacturer?.id, 'Both SKUs share Demo Manufacturer 1').toBe(second.sku.manufacturer?.id);
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock Management) and select DEMO-SKU-0001 and DEMO-SKU-0002', async () => {
      await showWorld(list, world);
      for (const seed of [first, second]) await list.tick(list.row(seed.sku.skuCode, seed.warehouse.name), seed.sku.skuCode);
    });

    await step('Assert: Expected 1 — Two stock rows with different SKU IDs are selected', async () => {
      await expect(inbound.checkedRowBoxes, '[Expected 1] Two rows are ticked').toHaveCount(2);
      expect(first.sku.skuId, '[Expected 1] The two rows have different SKU IDs').not.toBe(second.sku.skuId);
    });

    await step('Act: Step 2 — Click 입고 요청 (Inbound Request)', async () => {
      await list.clickToolbar('btn.incomingRequest');
    });

    await step('Assert: Expected 2 — The 입고 요청 (Inbound Request) dialog opens successfully', async () => {
      await expect(dialog.root, '[Expected 2] The 입고 요청 dialog opens').toBeVisible();
    });

    await step('Act: Step 3 — Count the rows in the SKU 정보 (SKU Information) table', async () => {
      await expect(dialog.table, 'The SKU 정보 table is shown').toBeVisible();
    });

    await step('Assert: Expected 3 — The SKU 정보 table displays exactly two rows, one for each distinct SKU ID', async () => {
      await expect(dialog.rows, '[Expected 3] The SKU 정보 table has exactly 2 rows').toHaveCount(2);
    });

    await step('Act: Step 4 — Check the SKU ID displayed on each row', async () => {
      rowIds = (await dialog.rows.locator('td:first-child').allInnerTexts()).map((text) => text.trim());
    });

    await step('Assert: Expected 4 — One row displays the SKU ID of DEMO-SKU-0001 and the other that of DEMO-SKU-0002', async () => {
      expect(rowIds, `[Expected 4] A row shows SKU ID ${first.sku.skuId}`).toContain(String(first.sku.skuId));
      expect(rowIds, `[Expected 4] A row shows SKU ID ${second.sku.skuId}`).toContain(String(second.sku.skuId));
    });
  });

  test('TC_US134_180 — The inbound request date is today in Seoul time, read-only, also when the browser runs in UTC', async ({ page, world, incomingDialog: dialog }) => {
    const step = makeStep(page);
    const seoul = kstDate(0);
    const utc = utcDate();
    await tcMeta(
      'TC_US134_180',
      'Low',
      TAGS,
      `입고 요청일: in the dialog header shows today's Seoul date as YYYY-MM-DD, is display text (no input, not editable) and still shows the Seoul date after the browser time zone is switched to UTC (CDP time-zone override on the open page). On this run Seoul = ${seoul}, UTC = ${utc}${seoul === utc ? ' — the two dates are the same at run time, so Step 4 cannot tell them apart on this run' : ''}. Read-only on the shared DEMO-SKU-0001 row. ${WORLD_NOTE}`,
    );
    const { list, inbound } = pages(page, dialog);
    const seed = world.row('SKU0001', world.warehouses.CJ);
    const label = `${t('incoming.requestDate')}: `;
    let shown = '';
    let kind = { tag: '', editable: true, inputs: -1 };
    let afterTyping = '';
    let shownInUtc = '';

    await step('Arrange: Pre-condition 1–2 — Physical row DEMO-SKU-0001 is in CJ Incheon Aam', async () => {
      expect(seed.sku.type, 'DEMO-SKU-0001 is physical').toBe('PHYSICAL');
    });

    await step('Act: Step 1 — Tick DEMO-SKU-0001 and click 입고 요청 (Inbound request)', async () => {
      await showWorld(list, world);
      await inbound.openFor([{ row: list.row(seed.sku.skuCode, seed.warehouse.name), label: seed.sku.skuCode }]);
    });

    await step('Assert: Expected 1 — The dialog opens', async () => {
      await expect(dialog.root, '[Expected 1] The 입고 요청 dialog opens').toBeVisible();
    });

    await step('Act: Step 2 — Read the value next to 입고 요청일: (Inbound request date:)', async () => {
      shown = squash(await dialog.requestDateText.innerText());
    });

    await step("Assert: Expected 2 — The value shows today's date in Seoul time, as year-month-day", async () => {
      expect(shown, `[Expected 2] The header reads ${label}${seoul}`).toBe(`${label}${seoul}`);
      expect(shown.slice(label.length), '[Expected 2] The date is written YYYY-MM-DD').toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    await step('Act: Step 3 — Try clicking that value and changing it', async () => {
      await dialog.requestDateText.click();
      await page.keyboard.type('1999-01-01');
      kind = await inbound.elementKind(dialog.requestDateText);
      afterTyping = squash(await dialog.requestDateText.innerText());
    });

    await step('Assert: Expected 3 — The value cannot be changed — it is display text at the top of the dialog, not an input field', async () => {
      expect(afterTyping, '[Expected 3] The value is unchanged after typing').toBe(shown);
      expect(['input', 'textarea', 'select'], '[Expected 3] The value is not a form field').not.toContain(kind.tag);
      expect(kind.inputs, '[Expected 3] The value holds no input').toBe(0);
      expect(kind.editable, '[Expected 3] The value is not editable').toBe(false);
      await expect(dialog.header.locator('span.text-muted'), '[Expected 3] The value sits in the dialog header').toBeVisible();
    });

    await step('Act: Step 4 — Change the browser time zone to UTC, open the dialog again and read the value again', async () => {
      await inbound.discard();
      await inbound.setBrowserTimezone('UTC');
      await inbound.openFor([{ row: list.row(seed.sku.skuCode, seed.warehouse.name), label: seed.sku.skuCode }]);
      shownInUtc = squash(await dialog.requestDateText.innerText());
    });

    await step('Assert: Expected 4 — The value still shows the Seoul date and not the UTC date', async () => {
      expect(shownInUtc, `[Expected 4] The header still reads the Seoul date ${seoul}`).toBe(`${label}${seoul}`);
    });
  });

  test('TC_US134_181 — The supply price is pre-filled from the SKU cost price and an edited price is stored on the request only', async ({ page, world, stockApi, incomingDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_181',
      'Medium',
      TAGS,
      `공급가 on the dialog row is pre-filled with the SKU cost price 12000, takes 13000, and the saved request stores purchase price 13000 while the physical SKU keeps cost price 12000. ${DATE_NOTE} ${OWN_NOTE} ${STATUS_NOTE}`,
    );
    const { list, inbound } = pages(page, dialog);
    const cj = destination(world);
    let sku!: WorldSku;
    let prefilled = '';
    let typed = '';
    let saved!: InboundSave;
    let created: IncomingRecord | undefined;
    let costPrice: number | undefined;

    await step('Arrange: Pre-condition 1–3 — Physical row DEMO-SKU-0001 in CJ Incheon Aam with SKU 공급원가 12000', async () => {
      sku = await ownStockedSku(world, 'TC181');
      expect((await stockApi.skuGroup(sku.groupId)).body.price, 'The SKU cost price is 12000').toBe(12000);
    });

    await step('Act: Step 1 — Tick DEMO-SKU-0001 and click 입고 요청 (Inbound request)', async () => {
      await list.open('ko');
      await list.findSku(sku);
      await inbound.openFor([{ row: list.row(sku.skuCode, cj.name), label: sku.skuCode }]);
    });

    await step('Assert: Expected 1 — The dialog opens with 1 row', async () => {
      await expect(dialog.rows, '[Expected 1] The dialog holds 1 row').toHaveCount(1);
    });

    await step('Act: Step 2 — Read the 공급가 (Supply price) field on the row', async () => {
      prefilled = await dialog.supplyPriceInput(0).inputValue();
    });

    await step("Assert: Expected 2 — The field is filled in with 12000, taken from the SKU's cost price", async () => {
      expect(prefilled.replace(/,/g, ''), '[Expected 2] 공급가 is pre-filled with 12000').toBe('12000');
    });

    await step('Act: Step 3 — Clear the field and type 13000', async () => {
      await dialog.supplyPriceInput(0).fill('');
      await dialog.supplyPriceInput(0).pressSequentially('13000');
      typed = await dialog.supplyPriceInput(0).inputValue();
    });

    await step('Assert: Expected 3 — The field takes the new value 13000', async () => {
      expect(typed.replace(/,/g, ''), '[Expected 3] 공급가 holds 13000').toBe('13000');
    });

    await step('Act: Step 4 — Fill 입고지, 입고 예정일 and 요청 수량, click 저장 (Save) and read the request just created', async () => {
      await inbound.fill({ warehouseId: cj.id, expectedDate: EXPECTED_DATE, lines: [{ quantity: '100' }] });
      saved = await inbound.save();
      created = (await incomingsOf(sku))[0];
      costPrice = (await stockApi.skuGroup(sku.groupId)).body.price;
    });

    await step('Assert: Expected 4 — The request is created with Supply Price 13000 and the SKU keeps Supply Cost 12000', async () => {
      expect(saved.status, `[Expected 4] The inbound request is created (body ${JSON.stringify(saved.body).slice(0, 200)})`).toBeLessThan(300);
      expect(created, '[Expected 4] The inbound request exists').toBeDefined();
      expect(Number(created?.purchase_price), '[Expected 4] The request stores Supply Price 13000').toBe(13000);
      expect(costPrice, '[Expected 4] The physical SKU still has Supply Cost 12000').toBe(12000);
    });
  });

  test('TC_US134_182 — The manufacturer is plain text taken from the first picked row and cannot be changed', async ({ page, world, incomingDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_182',
      'Medium',
      TAGS,
      `With DEMO-SKU-0001 and DEMO-SKU-0002 (CJ Incheon Aam, Demo Manufacturer 1) ticked, the dialog shows 2 rows and 제조사 in 입고 정보 reads Demo Manufacturer 1 (the world's first manufacturer of Demo Partner A) as plain text: no input / select inside, not editable, unchanged after clicking and typing. Read-only on the shared demo rows. ${WORLD_NOTE}`,
    );
    const { list, inbound } = pages(page, dialog);
    const first = world.row('SKU0001', world.warehouses.CJ);
    const second = world.row('SKU0002', world.warehouses.CJ);
    let shown = '';
    let afterTyping = '';
    let kind = { tag: '', editable: true, inputs: -1 };

    await step('Arrange: Pre-condition 1–2 — DEMO-SKU-0001 and DEMO-SKU-0002 in CJ Incheon Aam, both Demo Manufacturer 1', async () => {
      expect(first.sku.manufacturer?.id, 'Both SKUs are Demo Manufacturer 1').toBe(world.manufacturers.M1.id);
      expect(second.sku.manufacturer?.id, 'Both SKUs are Demo Manufacturer 1').toBe(world.manufacturers.M1.id);
    });

    await step('Act: Step 1 — Tick DEMO-SKU-0001 and DEMO-SKU-0002, then click 입고 요청 (Inbound request)', async () => {
      await showWorld(list, world);
      await inbound.openFor([first, second].map((seed) => ({ row: list.row(seed.sku.skuCode, seed.warehouse.name), label: seed.sku.skuCode })));
    });

    await step('Assert: Expected 1 — The dialog opens with 2 rows', async () => {
      await expect(dialog.rows, '[Expected 1] The dialog holds 2 rows').toHaveCount(2);
    });

    await step('Act: Step 2 — Read the 제조사 (Manufacturer) value in the 입고 정보 (Inbound information) block', async () => {
      shown = (await dialog.manufacturerText.innerText()).trim();
    });

    await step('Assert: Expected 2 — The value shows Demo Manufacturer 1, taken from the first picked row', async () => {
      expect(shown, `[Expected 2] 제조사 reads ${world.manufacturers.M1.name}`).toBe(world.manufacturers.M1.name);
    });

    await step('Act: Step 3 — Try clicking it and changing it', async () => {
      await dialog.manufacturerText.click();
      await page.keyboard.type('Changed');
      afterTyping = (await dialog.manufacturerText.innerText()).trim();
    });

    await step('Assert: Expected 3 — The value takes no change', async () => {
      expect(afterTyping, '[Expected 3] 제조사 is unchanged').toBe(shown);
    });

    await step("Act: Step 4 — Use the browser tool that shows the page's own code to check whether this is an input field or just text", async () => {
      kind = await inbound.elementKind(dialog.manufacturerText);
    });

    await step('Assert: Expected 4 — It is plain text and not a locked input field', async () => {
      expect(['input', 'textarea', 'select'], `[Expected 4] 제조사 is not a form field (tag ${kind.tag})`).not.toContain(kind.tag);
      expect(kind.inputs, '[Expected 4] 제조사 holds no input, select or text area').toBe(0);
      expect(kind.editable, '[Expected 4] 제조사 is not editable').toBe(false);
    });
  });

  test('TC_US134_183 — 입고지 offers only the active PLATFORM warehouses of the SKU partner', async ({ page, world, stockApi, incomingDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_183',
      'Medium',
      TAGS,
      `For DEMO-SKU-0001 (Demo Partner A) the 입고지 drop-down shows the hint 입고지를 선택해주세요 and offers only PLATFORM warehouses of Demo Partner A (each choice is checked against the warehouse catalogue by id), including CJ Incheon Aam / CJ Daegu warehouse / Demo Pickup Point, and offers neither a SUPPLIER warehouse of Demo Partner A nor a PLATFORM warehouse of Demo Partner B. Data: the SUPPLIER warehouse and the partner-B warehouse are created by the test (removed in teardown); choices are compared by id because warehouse names can repeat. ${WORLD_NOTE}`,
    );
    const { list, inbound } = pages(page, dialog);
    const seed = world.row('SKU0001', world.warehouses.CJ);
    let supplierId = 0;
    let partnerBId = 0;
    let entries: Array<{ value: string; label: string }> = [];
    let catalogue: Array<{ id: number; bizPartnerId: number; name: string }> = [];

    await step('Arrange: Pre-condition 1–3 — PLATFORM CJ Incheon Aam / CJ Daegu / Demo Pickup Point of Demo Partner A, a SUPPLIER warehouse and a PLATFORM warehouse of Demo Partner B exist', async () => {
      supplierId = (await world.createWarehouse('WH183 Supplier', 'SUPPLIER')).id;
      partnerBId = (await world.createWarehouse('WH183 Partner B', 'PLATFORM_GENERAL', { bizPartnerId: String(world.partners.B.id) })).id;
      catalogue = await stockApi.selectableWarehouses();
    });

    await step('Act: Step 1 — Tick DEMO-SKU-0001 and click 입고 요청 (Inbound request)', async () => {
      await showWorld(list, world);
      await inbound.openFor([{ row: list.row(seed.sku.skuCode, seed.warehouse.name), label: seed.sku.skuCode }]);
    });

    await step('Assert: Expected 1 — The dialog opens with 1 row', async () => {
      await expect(dialog.rows, '[Expected 1] The dialog holds 1 row').toHaveCount(1);
    });

    await step('Act: Step 2 — Open the 입고지 (Inbound destination) dropdown and read the placeholder text and the choices', async () => {
      entries = await inbound.warehouseOptionEntries();
    });

    await step('Assert: Expected 2 — The placeholder shows 입고지를 선택해주세요 and the choices are the PLATFORM warehouses of Demo Partner A', async () => {
      expect(entries[0], `[Expected 2] The first entry is the hint ${t('incoming.field.warehousePlaceholder')}`).toEqual({ value: '', label: t('incoming.field.warehousePlaceholder') });
      const choices = entries.slice(1);
      expect(choices.length, '[Expected 2] 입고지 offers choices').toBeGreaterThan(0);
      for (const choice of choices) {
        const entry = catalogue.find((w) => String(w.id) === choice.value);
        expect(entry, `[Expected 2] Choice "${choice.label}" is an active PLATFORM warehouse of the catalogue`).toBeDefined();
        expect(entry?.bizPartnerId, `[Expected 2] Choice "${choice.label}" belongs to Demo Partner A`).toBe(world.partners.A.id);
      }
      const expected = [world.warehouses.CJ, world.warehouses.DAEGU, world.warehouses.PICKUP].filter((w): w is WorldWarehouse => !!w);
      for (const warehouse of expected) expect(choices.map((c) => c.value), `[Expected 2] 입고지 offers ${warehouse.name}`).toContain(String(warehouse.id));
    });

    await step('Act: Step 3 — Look for the SUPPLIER-type warehouse in the list', async () => {
      expect(entries.length, 'The choices are read').toBeGreaterThan(0);
    });

    await step('Assert: Expected 3 — The SUPPLIER-type warehouse is not offered', async () => {
      expect(entries.map((e) => e.value), '[Expected 3] The SUPPLIER warehouse is not offered').not.toContain(String(supplierId));
    });

    await step('Act: Step 4 — Look for the warehouse that belongs only to Demo Partner B', async () => {
      expect(entries.length, 'The choices are read').toBeGreaterThan(0);
    });

    await step('Assert: Expected 4 — The Demo Partner B warehouse is not offered', async () => {
      expect(entries.map((e) => e.value), '[Expected 4] The Demo Partner B warehouse is not offered').not.toContain(String(partnerBId));
    });
  });

  test('TC_US134_184 — The server rejects an inbound request into a SUPPLIER or an inactive warehouse', async ({ page, world, playwright, stockApi, incomingDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_184',
      'Medium',
      TAGS,
      `A create-inbound call (POST ${INCOMING_PATH}, 발주, 공급가 12000, 요청 수량 100) sent straight to the server is rejected with WH-WAREHOUSE_NOT_SUPPORTED "지원하지 않는 창고입니다. - id: {id}" for a SUPPLIER warehouse and with WH-WAREHOUSE_NOT_ACTIVE for an INACTIVE PLATFORM warehouse, and no inbound record is written by either call. Not automated: the message of WH-WAREHOUSE_NOT_ACTIVE (SPEC-GAP-26 — the SRS gives none); only the code is asserted. Data: both warehouses (Demo Partner A) and the physical SKU are created by the test; the inactive one is deactivated through the US069 warehouse API. ${DATE_NOTE} ${STATUS_NOTE}`,
    );
    const { list } = pages(page, dialog);
    const warehouses = await openWarehouseApi(playwright.request);
    let sku!: WorldSku;
    let supplierId = 0;
    let inactiveId = 0;
    const results: Record<'supplier' | 'inactive', { status: number; code: string; message: string }> = { supplier: { status: 0, code: '', message: '' }, inactive: { status: 0, code: '', message: '' } };
    let records: IncomingRecord[] = [];
    const body = (warehouseId: number) => ({ warehouseId, requestDate: EXPECTED_DATE, type: 'PURCHASE_ORDER' as const, manufacturerId: world.manufacturers.M1.id, items: [{ skuId: sku.skuId, quantity: 100, purchasePrice: { amount: 12000 } }] });

    try {
      await step('Arrange: Pre-condition 1–5 — DEMO-SKU-0001 in CJ Incheon Aam; a SUPPLIER and an INACTIVE PLATFORM warehouse of the same partner; an API client sharing the session', async () => {
        sku = await ownStockedSku(world, 'TC184');
        supplierId = (await world.createWarehouse('WH184 Supplier', 'SUPPLIER')).id;
        const inactive = await world.createWarehouse('WH184 Inactive', 'PLATFORM_GENERAL');
        inactiveId = inactive.id;
        const deactivated = await warehouses.api.deactivate(inactive.id, inactive.version);
        expect(deactivated.status, 'The PLATFORM warehouse is deactivated').toBeLessThan(300);
        expect((await warehouses.api.get(inactive.id)).body.status, 'The warehouse is INACTIVE').toBe('INACTIVE');
        await list.open('ko');
      });

      await step('Act: Step 1 — Send a create-inbound-request call for DEMO-SKU-0001 with the test data and the SUPPLIER warehouse as destination', async () => {
        results.supplier = errorOf(await stockApi.createIncoming(body(supplierId)));
      });

      await step('Assert: Expected 1 — The call is rejected with WH-WAREHOUSE_NOT_SUPPORTED: 지원하지 않는 창고입니다. - id: {warehouseId}', async () => {
        expect(results.supplier.status, '[Expected 1] The call is rejected with a 4xx status').toBeGreaterThanOrEqual(400);
        expect(results.supplier.status, '[Expected 1] The rejection is not a server error').toBeLessThan(500);
        expect(results.supplier.code, '[Expected 1] The code is WH-WAREHOUSE_NOT_SUPPORTED').toBe('WH-WAREHOUSE_NOT_SUPPORTED');
        expect(results.supplier.message, '[Expected 1] The message names the real warehouse id').toBe(`지원하지 않는 창고입니다. - id: ${supplierId}`);
      });

      await step('Act: Step 2 — Send the same call with the INACTIVE warehouse as destination', async () => {
        results.inactive = errorOf(await stockApi.createIncoming(body(inactiveId)));
      });

      await step('Assert: Expected 2 — The call is rejected with WH-WAREHOUSE_NOT_ACTIVE', async () => {
        expect(results.inactive.status, '[Expected 2] The call is rejected with a 4xx status').toBeGreaterThanOrEqual(400);
        expect(results.inactive.status, '[Expected 2] The rejection is not a server error').toBeLessThan(500);
        expect(results.inactive.code, '[Expected 2] The code is WH-WAREHOUSE_NOT_ACTIVE').toBe('WH-WAREHOUSE_NOT_ACTIVE');
      });

      await step('Act: Step 3 — Open the inbound status screen and look for a request from either call', async () => {
        records = await incomingsOf(sku);
      });

      await step('Assert: Expected 3 — No inbound request was created by either call', async () => {
        expect(records, '[Expected 3] No inbound record exists for the SKU').toHaveLength(0);
        expect(await incomingsToWarehouse(supplierId), '[Expected 3] No inbound record names the SUPPLIER warehouse').toBe(0);
        expect(await incomingsToWarehouse(inactiveId), '[Expected 3] No inbound record names the INACTIVE warehouse').toBe(0);
      });
    } finally {
      await warehouses.dispose();
    }
  });

  test('TC_US134_185 — 입고구분 offers exactly 발주, 재고이동입고 and 기타, no 조립, and sends PURCHASE_ORDER by default', async ({ page, world, incomingDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_185',
      'Medium',
      TAGS,
      `입고구분 has 발주 pre-selected, exactly 3 radio options of which only 1 can be chosen at a time (choosing 재고이동입고 clears 발주), the choices 발주 · 재고이동입고 · 기타, no 조립 (Assembly), and a save with the default sends type PURCHASE_ORDER. ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const { list, inbound } = pages(page, dialog);
    const cj = destination(world);
    let sku!: WorldSku;
    let radios = 0;
    let checkedAfterSwitch = -1;
    let purchaseAfterSwitch = true;
    let labels: string[] = [];
    let saved!: InboundSave;

    await step('Arrange: Pre-condition 1–2 — Physical row DEMO-SKU-0001 in CJ Incheon Aam', async () => {
      sku = await ownStockedSku(world, 'TC185');
    });

    await step('Act: Step 1 — Tick DEMO-SKU-0001, click 입고 요청 (Inbound request) and read the value already picked in 입고구분 (Inbound type)', async () => {
      await list.open('ko');
      await list.findSku(sku);
      await inbound.openFor([{ row: list.row(sku.skuCode, cj.name), label: sku.skuCode }]);
    });

    await step('Assert: Expected 1 — 발주 (Purchase order) is already picked', async () => {
      await expect(dialog.typeRadio('PURCHASE_ORDER'), `[Expected 1] ${t('incomingType.PURCHASE_ORDER')} is pre-selected`).toBeChecked();
    });

    await step('Act: Step 2 — Count the radio options in 입고구분 (Inbound type)', async () => {
      radios = await dialog.typeRadios.count();
      await dialog.typeRadio('TRANSFER').check();
      checkedAfterSwitch = await dialog.body.locator('input[name="incoming-type"]:checked').count();
      purchaseAfterSwitch = await dialog.typeRadio('PURCHASE_ORDER').isChecked();
      await dialog.typeRadio('PURCHASE_ORDER').check();
    });

    await step('Assert: Expected 2 — There are exactly 3 radio options and only 1 can be selected at a time', async () => {
      expect(radios, '[Expected 2] 입고구분 has exactly 3 radio options').toBe(3);
      await expect(dialog.typeRadios.first(), '[Expected 2] The options are radio buttons').toHaveAttribute('type', 'radio');
      expect(checkedAfterSwitch, '[Expected 2] Only 1 option is selected after choosing another').toBe(1);
      expect(purchaseAfterSwitch, `[Expected 2] Choosing ${t('incomingType.TRANSFER')} clears ${t('incomingType.PURCHASE_ORDER')}`).toBe(false);
    });

    await step('Act: Step 3 — Read each choice in turn', async () => {
      labels = (await dialog.typeLabels.allTextContents()).map((text) => text.trim());
    });

    await step('Assert: Expected 3 — The 3 choices are 발주 (Purchase order), 재고이동입고 (Stock-movement inbound), 기타 (Other)', async () => {
      (['incomingType.PURCHASE_ORDER', 'incomingType.TRANSFER', 'incomingType.ETC'] as const).forEach((key, index) => {
        expect(labels[index], `[Expected 3] Choice ${index + 1} is ${t(key)}`).toBe(t(key));
      });
    });

    await step('Act: Step 4 — Look for 조립 (Assembly) among the radio options', async () => {
      expect(labels.length, 'The choices are read').toBeGreaterThan(0);
    });

    await step('Assert: Expected 4 — 조립 (Assembly) is not offered because it is system-generated, not an operator choice', async () => {
      expect(labels, '[Expected 4] 조립 is not offered').not.toContain('조립');
      await expect(dialog.body.locator('#incoming-type-ASSEMBLY'), '[Expected 4] There is no ASSEMBLY radio').toHaveCount(0);
    });

    await step('Act: Step 5 — Leave the default as it is, fill the required fields, click 저장 (Save) and read the data sent to the server', async () => {
      await inbound.fill(standardForm(world));
      saved = await inbound.save();
    });

    await step('Assert: Expected 5 — The data sent to the server carries the inbound type value PURCHASE_ORDER', async () => {
      expect(saved.payload.type, '[Expected 5] The request body carries type PURCHASE_ORDER').toBe('PURCHASE_ORDER');
      expect(saved.status, '[Expected 5] The save is accepted').toBeLessThan(300);
    });
  });

  test('TC_US134_186 — A short inbound receipt creates an Assembly follow-up record with no manufacturer', async () => {
    await skipTc(
      'TC_US134_186',
      'Medium',
      TAGS,
      'Completing an inbound request of 100 with 60 received opens a follow-up inbound record of type Assembly (no manufacturer) for the shortfall, and 재고이력 shows only 입고완료 +60 until that follow-up is completed.',
      'The short-receipt completion and the Assembly follow-up record are produced by the server-side completion flow of US032/US033 (CJ inbound result), which has no route on this screen or API; marking the receipt completed by DB fixture does not run that logic, so the follow-up record and its stock history cannot be produced.',
    );
  });

  test('TC_US134_187 — Choosing 기타 shows one request-level note field and sends it apart from the line memo', async ({ page, world, incomingDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_187',
      'Medium',
      TAGS,
      `With 2 rows of 1 product code ticked, the 기타 사유 note field is hidden on 발주, appears on 기타 with the placeholder 기타 입고 사유를 입력해주세요. and the notice 기타 유형의 입고 요청은 입고예정수량에 합산되지 않습니다. under 입고구분, exists exactly once for the 2 rows, hides again on 발주, and on save travels in the request-level note while each line memo stays its own field. Data: the 2 rows (standing for DEMO-SKU-0001 / 0002) are the test's own physical SKUs because Step 5 saves. ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const { list, inbound } = pages(page, dialog);
    const cj = destination(world);
    const note = '데모 기타 입고 사유';
    const memo = `Line memo ${world.tag}`;
    let skus: WorldSku[] = [];
    let noteFields = -1;
    let saved!: InboundSave;

    await step('Arrange: Pre-condition 1–2 — 2 physical rows (DEMO-SKU-0001 / 0002) in CJ Incheon Aam, both Demo Manufacturer 1', async () => {
      skus = await ownStockedPair(world, 'TC187');
    });

    await step('Act: Step 1 — Tick both rows, click 입고 요청 (Inbound request) and look under 입고구분 (Inbound type) while it is on 발주 (Purchase order)', async () => {
      await list.open('ko');
      await inbound.showGroup(skus[0]);
      await inbound.openFor(skus.map((sku) => ({ row: list.row(sku.skuCode, cj.name), label: sku.skuCode })));
    });

    await step('Assert: Expected 1 — No note field is shown', async () => {
      await expect(dialog.typeRadio('PURCHASE_ORDER'), '[Expected 1] 발주 is selected').toBeChecked();
      await expect(dialog.etcNote, '[Expected 1] No 기타 사유 note field is shown').toHaveCount(0);
    });

    await step('Act: Step 2 — Change 입고구분 (Inbound type) to 기타 (Other) and look at the same spot again', async () => {
      await dialog.typeRadio('ETC').check();
    });

    await step('Assert: Expected 2 — The 기타 사유 note input appears with its placeholder and the not-counted notice is shown under 입고구분', async () => {
      await expect(dialog.fieldLabel('incoming.field.etcNote'), `[Expected 2] The label ${t('incoming.field.etcNote')} appears`).toBeVisible();
      await expect(dialog.etcNote, '[Expected 2] The note input appears').toBeVisible();
      await expect(dialog.etcNote, `[Expected 2] The placeholder is ${t('incoming.field.etcNotePlaceholder')}`).toHaveAttribute('placeholder', t('incoming.field.etcNotePlaceholder'));
      await expect(dialog.etcNotice, `[Expected 2] The notice ${t('incoming.etcNotExpected')} is shown`).toBeVisible();
      const radioBox = await dialog.typeRadios.first().boundingBox();
      const noticeBox = await dialog.etcNotice.boundingBox();
      expect(!!radioBox && !!noticeBox && noticeBox.y > radioBox.y, '[Expected 2] The notice sits under 입고구분').toBe(true);
    });

    await step('Act: Step 3 — Count the note fields shown and compare with the number of SKU rows in the table', async () => {
      noteFields = await dialog.etcNote.count();
    });

    await step('Assert: Expected 3 — There is exactly 1 note field for the whole request although the table has 2 SKU rows', async () => {
      await expect(dialog.rows, '[Expected 3] The table has 2 SKU rows').toHaveCount(2);
      expect(noteFields, '[Expected 3] There is exactly 1 기타 사유 note field').toBe(1);
    });

    await step('Act: Step 4 — Change it back to 발주 (Purchase order) and look again', async () => {
      await dialog.typeRadio('PURCHASE_ORDER').check();
    });

    await step('Assert: Expected 4 — The note field is hidden', async () => {
      await expect(dialog.etcNote, '[Expected 4] The 기타 사유 note field is hidden').toHaveCount(0);
    });

    await step('Act: Step 5 — Change it to 기타 (Other), fill the note and the required fields, click 저장 (Save) and read the data sent to the server', async () => {
      await inbound.fill({ warehouseId: cj.id, expectedDate: EXPECTED_DATE, type: 'ETC', note, lines: [{ supplyPrice: '12000', quantity: '100', memo }, { supplyPrice: '12000', quantity: '100' }] });
      saved = await inbound.save();
    });

    await step('Assert: Expected 5 — The note travels in the request-level note field and the per-line 메모 (Memo) stays a separate field', async () => {
      expect(saved.status, `[Expected 5] The save is accepted (body ${JSON.stringify(saved.body).slice(0, 200)})`).toBeLessThan(300);
      expect(saved.payload.note, '[Expected 5] The request-level note carries the 기타 사유 text').toBe(note);
      const items = (saved.payload.items ?? []) as Array<{ memo?: string }>;
      expect(items[0]?.memo, '[Expected 5] The memo of line 1 keeps its own value').toBe(memo);
      expect(items[1]?.memo, '[Expected 5] The memo of line 2 is not written over by the note').toBeUndefined();
    });
  });

  test('TC_US134_188 — Saving 기타 without a note is blocked with the note-required message', async ({ page, world, incomingDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_188',
      'Medium',
      TAGS,
      `With 입고구분 = 기타 and every other field filled, 저장 with an empty 기타 사유 sends nothing and shows "기타 입고 시 사유를 입력해주세요." with the cursor in the note field; with the note 데모 기타 입고 사유 the save goes through with 등록되었습니다. Deviation (bundle e8t): the dialog shows the message in its error box but does not move the focus to the note field — the focus assertion follows the TC. ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const { list, inbound } = pages(page, dialog);
    const cj = destination(world);
    let sku!: WorldSku;
    let posts!: PostCounter;
    let saved!: InboundSave;

    await step('Arrange: Pre-condition 1–3 — Physical row DEMO-SKU-0001 in CJ Incheon Aam and the TC test data', async () => {
      sku = await ownStockedSku(world, 'TC188');
    });

    await step('Act: Step 1 — Tick DEMO-SKU-0001, click 입고 요청 (Inbound request) and change 입고구분 (Inbound type) to 기타 (Other)', async () => {
      await list.open('ko');
      await inbound.reopenFor(sku, cj.name);
      await dialog.typeRadio('ETC').check();
    });

    await step('Assert: Expected 1 — The required note field appears', async () => {
      await expect(dialog.etcNote, '[Expected 1] The 기타 사유 note field appears').toBeVisible();
      await expect(dialog.fieldLabel('incoming.field.etcNote'), '[Expected 1] The note field is marked required (*)').toContainText('*');
    });

    await step('Act: Step 2 — Fill every other required field with the test data, leave the note EMPTY and click 저장 (Save)', async () => {
      await inbound.fill(standardForm(world));
      posts = inbound.countPosts();
      await dialog.clickSave();
    });

    await step('Assert: Expected 2 — Saving is blocked', async () => {
      await expect(dialog.errorAlert, '[Expected 2] A validation message blocks the save').toBeVisible();
      await expect(dialog.root, '[Expected 2] The dialog stays open').toBeVisible();
      posts.stop();
      expect(posts.count, `[Expected 2] No POST ${INCOMING_PATH} call is sent`).toBe(0);
    });

    await step('Act: Step 3 — Read the message that appears and see where the cursor jumps', async () => {
      await expect(dialog.errorAlert, 'The message is shown').toBeVisible();
    });

    await step('Assert: Expected 3 — The message shows "기타 입고 시 사유를 입력해주세요." and the cursor jumps into the note field', async () => {
      await expect(dialog.errorAlert, `[Expected 3] The message is ${t('err.incomingEtcNoteRequired')}`).toContainText(t('err.incomingEtcNoteRequired'));
      await expect.soft(dialog.etcNote, '[Expected 3] The cursor is in the 기타 사유 note field').toBeFocused();
    });

    await step('Act: Step 4 — Type 데모 기타 입고 사유 into the note field and click 저장 (Save)', async () => {
      await dialog.etcNote.fill('데모 기타 입고 사유');
      saved = await inbound.save();
    });

    await step('Assert: Expected 4 — The save goes through and shows 등록되었습니다 (Registered.)', async () => {
      expect(saved.status, `[Expected 4] The save is accepted (body ${JSON.stringify(saved.body).slice(0, 200)})`).toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 4] The message ${t('msg.registered')} appears`).toContainText(t('msg.registered'));
    });
  });

  test('TC_US134_189 — A requested 기타 inbound is not counted in 입고예정수량 while a requested 발주 inbound is', async ({ page, world, incomingDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_189',
      'High',
      TAGS,
      `Starting from 입고예정수량 60 (a REQUESTED purchase-order inbound of 60 inserted by DB fixture), a 기타 request of 100 created in the dialog and moved to REQUESTED by DB fixture leaves the cell at 60, while a 발주 request of 100 moved to REQUESTED raises it to 160. The REGISTERED → REQUESTED move belongs to US032/US033 and is done by DB fixture. ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const { list, inbound } = pages(page, dialog);
    const cj = destination(world);
    let sku!: WorldSku;
    const read = async () => {
      // Tải lại list từ đầu: sau khi lưu, list đã tải lại lúc phiếu còn REGISTERED, rồi DB mới chuyển sang REQUESTED; tìm lại
      // cùng tiêu chí SKU_CODE thì frontend không gọi lại GET /stock-status → đọc phải số cũ.
      await list.open('ko');
      await list.findSku(sku);
      return list.cellText(list.row(sku.skuCode, cj.name), 'col.incomingQuantity');
    };
    const createAndRequest = async (type: 'ETC' | 'PURCHASE_ORDER') => {
      const before = await incomingsOf(sku);
      await inbound.reopenFor(sku, cj.name);
      await inbound.fill({ ...standardForm(world), type, ...(type === 'ETC' ? { note: '데모 기타 입고 사유' } : {}) });
      const saved = await inbound.save();
      const created = newRecords(await incomingsOf(sku), before)[0];
      if (created) await forceIncomingStatus(created.incoming_id, 'REQUESTED');
      const moved = created ? newRecords(await incomingsOf(sku), before)[0] : undefined;
      return { saved, moved };
    };
    let first = '';
    let etc: Awaited<ReturnType<typeof createAndRequest>> | undefined;
    let afterEtc = '';
    let purchase: Awaited<ReturnType<typeof createAndRequest>> | undefined;
    let afterPurchase = '';

    await step('Arrange: Pre-condition 1–4 — DEMO-SKU-0001 in CJ Incheon Aam with 입고예정수량 60 and no issued purchase order', async () => {
      sku = await ownStockedSku(world, 'TC189');
      await seedIncoming(sku, cj.id, { type: 'PURCHASE_ORDER', status: 'REQUESTED', quantity: 60 });
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management) and write down the 입고예정수량 (Expected inbound quantity) of DEMO-SKU-0001', async () => {
      await list.open('ko');
      first = await read();
    });

    await step('Assert: Expected 1 — The value read is 60', async () => {
      expect(first, '[Expected 1] 입고예정수량 is 60').toBe('60');
    });

    await step('Act: Step 2 — Create 1 inbound request with 입고구분 기타 (Other) for 100 units, then move it to the requested state by DB fixture', async () => {
      etc = await createAndRequest('ETC');
    });

    await step('Assert: Expected 2 — The request is created and moved', async () => {
      expect(etc?.saved.status, '[Expected 2] The 기타 request is created').toBeLessThan(300);
      expect(etc?.moved?.type, '[Expected 2] The new request is of type ETC').toBe('ETC');
      expect(etc?.moved?.status, '[Expected 2] The new request is now REQUESTED').toBe('REQUESTED');
    });

    await step('Act: Step 3 — Read 입고예정수량 (Expected inbound quantity) again', async () => {
      afterEtc = await read();
    });

    await step('Assert: Expected 3 — The cell still shows 60', async () => {
      expect(afterEtc, '[Expected 3] 입고예정수량 is still 60').toBe('60');
    });

    await step('Act: Step 4 — Create 1 inbound request with 입고구분 발주 (Purchase order) for 100 units, then move it to the requested state by DB fixture', async () => {
      purchase = await createAndRequest('PURCHASE_ORDER');
    });

    await step('Assert: Expected 4 — The request is created and moved', async () => {
      expect(purchase?.saved.status, '[Expected 4] The 발주 request is created').toBeLessThan(300);
      expect(purchase?.moved?.type, '[Expected 4] The new request is of type PURCHASE_ORDER').toBe('PURCHASE_ORDER');
      expect(purchase?.moved?.status, '[Expected 4] The new request is now REQUESTED').toBe('REQUESTED');
    });

    await step('Act: Step 5 — Read 입고예정수량 (Expected inbound quantity) again', async () => {
      afterPurchase = await read();
    });

    await step('Assert: Expected 5 — The cell shows 160, so a requested purchase-order inbound is counted', async () => {
      expect(afterPurchase, '[Expected 5] 입고예정수량 is 160').toBe('160');
    });
  });

  test('TC_US134_190 — 발주 is only a type label: no purchase-order field, payload id or record reference', async ({ page, world, incomingDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_190',
      'Medium',
      TAGS,
      `With 입고구분 on 발주 the dialog offers no field to pick or type a purchase order (its only form fields are 입고지, 입고 예정일, the 3 입고구분 radios and the 3 inputs per SKU row), the request body carries no purchase-order key, and the stored inbound record has no reference (ref_type NONE with ref_id empty — the server stores 0 as the no-reference value — on the header and on every line). Pre-condition 3 (a real purchase order exists) is not checked: the purchase-order module (US105) is not read by this suite. ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const { list, inbound } = pages(page, dialog);
    const cj = destination(world);
    let sku!: WorldSku;
    let saved!: InboundSave;
    let header: Record<string, unknown> = {};
    let items: Array<Record<string, unknown>> = [];

    await step('Arrange: Pre-condition 1–3 — Physical row DEMO-SKU-0001 in CJ Incheon Aam', async () => {
      sku = await ownStockedSku(world, 'TC190');
    });

    await step('Act: Step 1 — Tick DEMO-SKU-0001, click 입고 요청 (Inbound request) and leave 입고구분 (Inbound type) on 발주 (Purchase order)', async () => {
      await list.open('ko');
      await inbound.reopenFor(sku, cj.name);
    });

    await step('Assert: Expected 1 — The dialog opens with 발주 (Purchase order) selected', async () => {
      await expect(dialog.root, '[Expected 1] The 입고 요청 dialog opens').toBeVisible();
      await expect(dialog.typeRadio('PURCHASE_ORDER'), '[Expected 1] 발주 is selected').toBeChecked();
    });

    await step('Act: Step 2 — Check the dialog for any field that selects or enters a purchase order', async () => {
      await expect(dialog.infoSectionTitle, 'The 입고 정보 block is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — There is no field to select or enter a purchase order', async () => {
      await expect(dialog.body.locator('select'), '[Expected 2] The only drop-down is 입고지').toHaveCount(1);
      await expect(dialog.body.locator('input:not([type="radio"]):not(table input)'), '[Expected 2] The only input outside the SKU table is 입고 예정일').toHaveCount(1);
      await expect(dialog.body.locator('textarea'), '[Expected 2] There is no text area').toHaveCount(0);
      await expect(dialog.body.getByText(/발주\s*(번호|ID|선택|서)|purchase order (no|id|number)/i), '[Expected 2] No purchase-order field label is shown').toHaveCount(0);
    });

    await step('Act: Step 3 — Fill the required fields, click 저장 (Save) and inspect the data sent to the server', async () => {
      await inbound.fill(standardForm(world));
      saved = await inbound.save();
    });

    await step('Assert: Expected 3 — The request payload contains no purchase order ID', async () => {
      expect(saved.status, '[Expected 3] The save is accepted').toBeLessThan(300);
      expect(allKeys(saved.payload).filter((key) => /order|ref/i.test(key)), '[Expected 3] The payload has no purchase-order / reference key').toEqual([]);
    });

    await step('Act: Step 4 — Open the inbound record just created and check for a reference to a purchase order', async () => {
      const created = (await incomingsOf(sku))[0];
      expect(created, 'The inbound record exists').toBeDefined();
      header = await incomingHeader(created.incoming_id);
      items = await incomingItems(created.incoming_id);
    });

    await step('Assert: Expected 4 — The inbound record has no purchase order reference and its reference field is empty', async () => {
      expect(emptyRefId(header.ref_id), `[Expected 4] The record reference id is empty (${String(header.ref_id)})`).toBe(true);
      expect([null, 'NONE'], `[Expected 4] The record reference type is empty (${String(header.ref_type)})`).toContain(header.ref_type ?? null);
      expect(header.external_ref_id ?? null, '[Expected 4] The record has no external reference').toBeNull();
      for (const item of items) {
        expect(emptyRefId(item.ref_id), `[Expected 4] The record line has no reference id (${String(item.ref_id)})`).toBe(true);
        expect([null, 'NONE'], `[Expected 4] The record line reference type is empty (${String(item.ref_type)})`).toContain(item.ref_type ?? null);
      }
    });
  });

  test('TC_US134_191 — 입고 예정일 is a single-date picker that writes YYYY-MM-DD', async ({ page, world, incomingDialog: dialog }) => {
    const step = makeStep(page);
    const date = '2026-10-01';
    await tcMeta(
      'TC_US134_191',
      'Low',
      TAGS,
      `입고 예정일 shows the placeholder YYYY-MM-DD, opens a react-datepicker calendar with month navigation, takes 1 October 2026 picked from the calendar, shows it as 2026-10-01 and holds one date only (1 input, no range separator, no quick-range buttons). The dialog sets no minimum date, so the TC date is used as is. Read-only on the shared DEMO-SKU-0001 row (the dialog is not saved). ${WORLD_NOTE}`,
    );
    const { list, inbound } = pages(page, dialog);
    const seed = world.row('SKU0001', world.warehouses.CJ);
    let shownMonth = { year: 0, month: 0 };
    let selectedDay = '';
    let value = '';

    await step('Arrange: Pre-condition 1–3 — Physical row DEMO-SKU-0001 in CJ Incheon Aam; test date 2026-10-01', async () => {
      expect(seed.sku.type, 'DEMO-SKU-0001 is physical').toBe('PHYSICAL');
    });

    await step('Act: Step 1 — Tick DEMO-SKU-0001 and click 입고 요청 (Inbound request)', async () => {
      await showWorld(list, world);
      await inbound.openFor([{ row: list.row(seed.sku.skuCode, seed.warehouse.name), label: seed.sku.skuCode }]);
    });

    await step('Assert: Expected 1 — The dialog opens', async () => {
      await expect(dialog.root, '[Expected 1] The 입고 요청 dialog opens').toBeVisible();
    });

    await step('Act: Step 2 — Read the placeholder in 입고 예정일 (Expected inbound date)', async () => {
      await expect(dialog.expectedDateInput, 'The 입고 예정일 field is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — The placeholder is YYYY-MM-DD', async () => {
      await expect(dialog.expectedDateInput, '[Expected 2] The placeholder is YYYY-MM-DD').toHaveAttribute('placeholder', 'YYYY-MM-DD');
    });

    await step('Act: Step 3 — Click the field and check the date-picker layout', async () => {
      await dialog.expectedDateInput.click();
    });

    await step('Assert: Expected 3 — A calendar opens with month/year navigation and selectable days', async () => {
      await expect(inbound.datePicker, '[Expected 3] A calendar date picker opens').toBeVisible();
      await expect(inbound.datePickerPrevious, '[Expected 3] The calendar has a previous-month button').toBeVisible();
      await expect(inbound.datePickerNext, '[Expected 3] The calendar has a next-month button').toBeVisible();
      await expect(inbound.datePickerMonth, '[Expected 3] The calendar shows the month and year').toHaveText(/\d{4}/);
      expect(await inbound.datePickerDays.count(), '[Expected 3] The calendar offers the days of the month').toBeGreaterThanOrEqual(28);
    });

    await step('Act: Step 4 — Navigate to October 2026 and select 1 October', async () => {
      await inbound.pickDate(date);
      await dialog.expectedDateInput.click();
      await expect(inbound.datePicker, 'The calendar opens again').toBeVisible();
      shownMonth = await inbound.shownMonth();
      selectedDay = (await inbound.datePicker.locator('.react-datepicker__day--selected').first().innerText()).trim();
    });

    await step('Assert: Expected 4 — 1 October 2026 is selected', async () => {
      expect(shownMonth, '[Expected 4] The calendar shows October 2026').toEqual({ year: 2026, month: 10 });
      expect(selectedDay, '[Expected 4] Day 1 is selected').toBe('1');
    });

    await step('Act: Step 5 — Read the value displayed in the field', async () => {
      value = await dialog.expectedDateInput.inputValue();
    });

    await step('Assert: Expected 5 — The field shows 2026-10-01, not 10/01/2026 or another format', async () => {
      expect(value, '[Expected 5] The field shows 2026-10-01').toBe(date);
      expect(value, '[Expected 5] The value is not written MM/DD/YYYY').not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
    });

    await step('Act: Step 6 — Check that the control accepts only one date and has no date-range separator or quick-range buttons', async () => {
      await expect(inbound.datePicker, 'The calendar is open').toBeVisible();
    });

    await step('Assert: Expected 6 — The control holds one date only, with no range separator and no quick-range buttons', async () => {
      await expect(inbound.dateInputs, '[Expected 6] The control has exactly 1 date input').toHaveCount(1);
      expect(value, '[Expected 6] The value holds a single date with no range separator').toMatch(/^\d{4}-\d{2}-\d{2}$/);
      await expect(inbound.datePicker.locator('.react-datepicker__day--in-range'), '[Expected 6] No day range is highlighted').toHaveCount(0);
      await expect(inbound.datePickerExtraButtons, '[Expected 6] The calendar has no quick-range buttons').toHaveCount(0);
    });
  });

  test('TC_US134_192 — Each required field left empty blocks the save with its own message', async ({ page, world, incomingDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_192',
      'Medium',
      TAGS,
      `4 rounds, each from a freshly opened dialog with only 1 field empty: 입고지 → 입고지를 선택해주세요, 입고 예정일 → 입고 예정일을 입력해주세요, 공급가 → 공급가를 입력해주세요 + the row highlighted, 요청 수량 → 요청 수량을 입력해주세요 + the row highlighted; no POST ${INCOMING_PATH} call is sent in any round. Deviation (bundle e8t): the message shows in the dialog error box and no row gets an error style — the highlight assertions follow the TC. Data: own SKU (a save that slipped through would write an inbound request). ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const { list, inbound } = pages(page, dialog);
    const cj = destination(world);
    let sku!: WorldSku;
    const rounds: Record<number, { posts: number; highlighted: boolean }> = {};
    const round = async (n: number, form: Parameters<StockInboundPage['fill']>[0]) => {
      await inbound.reopenFor(sku, cj.name);
      await inbound.fill(form);
      rounds[n] = { posts: await blockedSave(dialog, inbound), highlighted: await inbound.lineHighlighted(0) };
    };
    const blocked = async (n: number, key: StockTextKey) => {
      expect(rounds[n]?.posts, `[Expected ${n}] No POST ${INCOMING_PATH} call is sent`).toBe(0);
      await expect(dialog.root, `[Expected ${n}] The dialog stays open`).toBeVisible();
      await expect(dialog.errorAlert, `[Expected ${n}] The message is ${t(key)}`).toContainText(t(key));
    };

    await step('Arrange: Pre-condition 1–4 — Physical row DEMO-SKU-0001 in CJ Incheon Aam whose cost price fills 공급가; TC test data', async () => {
      sku = await ownStockedSku(world, 'TC192');
      await list.open('ko');
    });

    await step('Act: Step 1 — Open the dialog, fill everything except 입고지 (Inbound destination) and click 저장 (Save)', async () => {
      await round(1, { expectedDate: EXPECTED_DATE, lines: [{ supplyPrice: '12000', quantity: '100' }] });
    });

    await step('Assert: Expected 1 — Saving is blocked with 입고지를 선택해주세요 (Select an inbound destination.)', async () => {
      await blocked(1, 'err.warehouseRequired');
    });

    await step('Act: Step 2 — Open it again, fill everything except 입고 예정일 (Expected inbound date) and click 저장 (Save)', async () => {
      await round(2, { warehouseId: cj.id, lines: [{ supplyPrice: '12000', quantity: '100' }] });
    });

    await step('Assert: Expected 2 — Saving is blocked with 입고 예정일을 입력해주세요 (Enter the expected inbound date.)', async () => {
      await blocked(2, 'err.expectedDateRequired');
    });

    await step('Act: Step 3 — Open it again, clear 공급가 (Supply price) on the row, fill the rest and click 저장 (Save)', async () => {
      await round(3, { warehouseId: cj.id, expectedDate: EXPECTED_DATE, lines: [{ supplyPrice: '', quantity: '100' }] });
    });

    await step('Assert: Expected 3 — Saving is blocked with 공급가를 입력해주세요 (Enter the supply price.) and that row is highlighted', async () => {
      await blocked(3, 'err.supplyPriceRequired');
      expect.soft(rounds[3]?.highlighted, '[Expected 3] The SKU row is highlighted').toBe(true);
    });

    await step('Act: Step 4 — Open it again, leave 요청 수량 (Requested quantity) empty, fill the rest and click 저장 (Save)', async () => {
      await round(4, { warehouseId: cj.id, expectedDate: EXPECTED_DATE, lines: [{ supplyPrice: '12000' }] });
    });

    await step('Assert: Expected 4 — Saving is blocked with 요청 수량을 입력해주세요 (Enter the requested quantity.) and that row is highlighted', async () => {
      await blocked(4, 'err.incomingQuantityRequired');
      expect.soft(rounds[4]?.highlighted, '[Expected 4] The SKU row is highlighted').toBe(true);
    });
  });

  test('TC_US134_193 — A multi-SKU request with an incomplete row is blocked with the required-fields message and keeps row 1', async ({ page, world, incomingDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_193',
      'Medium',
      TAGS,
      `With 2 rows, row 1 filled (12000 / 100) and row 2 with its pre-filled 공급가 cleared and no 요청 수량, 저장 sends nothing, shows 필수항목을 입력해주세요. and keeps the dialog open with row 1 unchanged. Deviation (bundle e8t): the dialog checks the rows field by field and shows 공급가를 입력해주세요 instead of the generic sentence — the message assertion follows the TC. Data: the 2 rows are the test's own physical SKUs (one product code, Demo Manufacturer 1). ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const { list, inbound } = pages(page, dialog);
    const cj = destination(world);
    let skus: WorldSku[] = [];
    let posts = -1;
    let rowOne = { supplyPrice: '', quantity: '' };

    await step('Arrange: Pre-condition 1–3 — 2 physical rows (DEMO-SKU-0001 / 0002) in CJ Incheon Aam under Demo Manufacturer 1; TC test data', async () => {
      skus = await ownStockedPair(world, 'TC193');
    });

    await step('Act: Step 1 — Tick both rows and click 입고 요청 (Inbound request)', async () => {
      await list.open('ko');
      await inbound.showGroup(skus[0]);
      await inbound.openFor(skus.map((sku) => ({ row: list.row(sku.skuCode, cj.name), label: sku.skuCode })));
    });

    await step('Assert: Expected 1 — The dialog opens with 2 rows', async () => {
      await expect(dialog.rows, '[Expected 1] The dialog holds 2 rows').toHaveCount(2);
    });

    await step('Act: Step 2 — Fill 입고지 and 입고 예정일, fill row 1, clear the pre-filled 공급가 on row 2 and leave its 요청 수량 empty', async () => {
      await inbound.fill({ warehouseId: cj.id, expectedDate: EXPECTED_DATE, lines: [{ supplyPrice: '12000', quantity: '100' }, { supplyPrice: '' }] });
    });

    await step('Assert: Expected 2 — Row 1 holds the values and row 2 has no supply price and no requested quantity', async () => {
      await expect(dialog.supplyPriceInput(0), '[Expected 2] Row 1 공급가 is 12000').toHaveValue('12000');
      await expect(dialog.quantityInput(0), '[Expected 2] Row 1 요청 수량 is 100').toHaveValue('100');
      await expect(dialog.supplyPriceInput(1), '[Expected 2] Row 2 공급가 is empty').toHaveValue('');
      await expect(dialog.quantityInput(1), '[Expected 2] Row 2 요청 수량 is empty').toHaveValue('');
    });

    await step('Act: Step 3 — Click 저장 (Save)', async () => {
      posts = await blockedSave(dialog, inbound);
    });

    await step('Assert: Expected 3 — Saving is blocked and 필수항목을 입력해주세요. (Please complete the required fields.) appears', async () => {
      expect(posts, `[Expected 3] No POST ${INCOMING_PATH} call is sent`).toBe(0);
      await expect.soft(dialog.errorAlert, `[Expected 3] The message is ${t('msg.requiredFields')}`).toContainText(t('msg.requiredFields'));
    });

    await step('Act: Step 4 — See whether the dialog is still open and whether row 1 still holds its values', async () => {
      if ((await dialog.root.count()) > 0) rowOne = { supplyPrice: await dialog.supplyPriceInput(0).inputValue(), quantity: await dialog.quantityInput(0).inputValue() };
    });

    await step('Assert: Expected 4 — The dialog is still open and row 1 still holds 12000 and 100', async () => {
      await expect(dialog.root, '[Expected 4] The dialog is still open').toBeVisible();
      expect(rowOne.supplyPrice, '[Expected 4] Row 1 공급가 is still 12000').toBe('12000');
      expect(rowOne.quantity, '[Expected 4] Row 1 요청 수량 is still 100').toBe('100');
    });
  });

  test('TC_US134_194 — 요청 수량 takes 1 and 999999, takes no decimal point and rejects 1000000', async ({ page, world, incomingDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_194',
      'Medium',
      TAGS,
      `요청 수량 1 and 999999 are saved; 0 is tried and its outcome recorded; "10.5" cannot be entered as a decimal; 1000000 typed key by key is rejected with WH-INCOMING_QUANTITY_EXCEEDED "요청 수량이 허용 범위를 초과했습니다." [proposed], the dialog stays open and no request is created. Not automated: Expected 3 (quantity 0) is NEEDS CLARIFICATION in the TC — the SRS gives no minimum — so the test only checks that the attempt ends without a server error. Deviation (bundle e8t): the field drops any keystroke that would exceed 999999 and keeps digits only, so "1000000" typed becomes 100000 and that value is saved; the Step 5 assertions follow the TC. ${DATE_NOTE} ${OWN_NOTE} ${STATUS_NOTE}`,
    );
    const { list, inbound } = pages(page, dialog);
    const cj = destination(world);
    let sku!: WorldSku;
    const saves: Record<number, InboundSave | null> = {};
    const created: Record<number, IncomingRecord[]> = {};
    let decimalValue = '';
    const attempt = async (n: number, quantity: string) => {
      const before = await incomingsOf(sku);
      await inbound.reopenFor(sku, cj.name);
      await inbound.fill({ warehouseId: cj.id, expectedDate: EXPECTED_DATE, lines: [{ supplyPrice: '12000' }] });
      await dialog.quantityInput(0).fill('');
      await dialog.quantityInput(0).pressSequentially(quantity);
      saves[n] = await inbound.trySave();
      created[n] = newRecords(await incomingsOf(sku), before);
    };

    await step('Arrange: Pre-condition 1–2 — Physical row DEMO-SKU-0001 in CJ Incheon Aam', async () => {
      sku = await ownStockedSku(world, 'TC194');
      await list.open('ko');
    });

    await step('Act: Step 1 — Fill all other required fields, enter 1 in 요청 수량 (Requested quantity) and click 저장 (Save)', async () => {
      await attempt(1, '1');
    });

    await step('Assert: Expected 1 — Quantity 1 is accepted and the request is saved', async () => {
      expect(saves[1]?.status, '[Expected 1] The save is accepted').toBeLessThan(300);
      expect(created[1]?.map((r) => Number(r.requested_quantity)), '[Expected 1] A request of 1 unit is stored').toEqual([1]);
    });

    await step('Act: Step 2 — Reopen the dialog, fill all other required fields, enter 999999 and click 저장 (Save)', async () => {
      await attempt(2, '999999');
    });

    await step('Assert: Expected 2 — Quantity 999999 is accepted and the request is saved', async () => {
      expect(saves[2]?.status, '[Expected 2] The save is accepted').toBeLessThan(300);
      expect(created[2]?.map((r) => Number(r.requested_quantity)), '[Expected 2] A request of 999999 units is stored').toEqual([999999]);
    });

    await step('Act: Step 3 — Reopen the dialog, enter 0 and click 저장 (Save)', async () => {
      await attempt(3, '0');
    });

    await step('Assert: Expected 3 — NEEDS CLARIFICATION: the outcome for 0 is not specified (only the absence of a server error is checked)', async () => {
      expect(saves[3]?.status ?? 0, '[Expected 3] The attempt with 0 ends without a server error').toBeLessThan(500);
    });

    await step('Act: Step 4 — Reopen the dialog and try to enter 10.5', async () => {
      await inbound.reopenFor(sku, cj.name);
      await dialog.quantityInput(0).fill('');
      await dialog.quantityInput(0).pressSequentially('10.5');
      decimalValue = await dialog.quantityInput(0).inputValue();
    });

    await step('Assert: Expected 4 — The decimal point is not accepted, so 10.5 cannot be entered as a valid value', async () => {
      expect(decimalValue, '[Expected 4] The field does not hold 10.5').not.toBe('10.5');
      expect(decimalValue, '[Expected 4] The field holds no decimal point').not.toContain('.');
    });

    await step('Act: Step 5 — Reopen the dialog, enter 1000000 and click 저장 (Save)', async () => {
      await attempt(5, '1000000');
    });

    await step('Assert: Expected 5 — The save is rejected with WH-INCOMING_QUANTITY_EXCEEDED, the dialog stays open and no request is created', async () => {
      expect(errorOf(saves[5] ?? { status: 0, body: {} }).code, '[Expected 5] The save is rejected with WH-INCOMING_QUANTITY_EXCEEDED').toBe('WH-INCOMING_QUANTITY_EXCEEDED');
      await expect(dialog.errorAlert, '[Expected 5] The message 요청 수량이 허용 범위를 초과했습니다. is shown').toContainText('요청 수량이 허용 범위를 초과했습니다.');
      await expect(dialog.root, '[Expected 5] The dialog stays open').toBeVisible();
      expect(created[5], '[Expected 5] No inbound request is created').toHaveLength(0);
    });
  });

  test('TC_US134_195 — 메모 takes at most 100 characters, counts them and drops emoji but takes Korean', async ({ page, world, incomingDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_195',
      'Low',
      TAGS,
      `메모 on the dialog row takes the 100-character test value, its counter reads 100/100, a 101st character is not taken, the emoji of "Demo memo 🎁" is dropped and 데모 입고 메모 is taken. Read-only on the shared DEMO-SKU-0001 row (the dialog is not saved). ${WORLD_NOTE}`,
    );
    const { list, inbound } = pages(page, dialog);
    const seed = world.row('SKU0001', world.warehouses.CJ);
    const memo = dialog.memoInput(0);
    let full = '';
    let counter = '';
    let afterExtra = '';
    let emojiValue = '';
    let koreanValue = '';

    await step('Arrange: Pre-condition 1–3 — Physical row DEMO-SKU-0001 in CJ Incheon Aam; 100-character, Korean and emoji test values', async () => {
      expect(MEMO_100, 'The test value is exactly 100 characters').toHaveLength(100);
    });

    await step('Act: Step 1 — Tick DEMO-SKU-0001, click 입고 요청 (Inbound request) and type the 100-character value into 메모 (Memo)', async () => {
      await showWorld(list, world);
      await inbound.openFor([{ row: list.row(seed.sku.skuCode, seed.warehouse.name), label: seed.sku.skuCode }]);
      await memo.fill(MEMO_100);
      full = await memo.inputValue();
    });

    await step('Assert: Expected 1 — The field takes all 100 characters', async () => {
      expect(full, '[Expected 1] 메모 holds the full 100-character value').toBe(MEMO_100);
    });

    await step('Act: Step 2 — Read the character counter beside the field', async () => {
      counter = squash(await inbound.counterOf(memo).innerText());
    });

    await step('Assert: Expected 2 — The counter shows 100 out of a limit of 100', async () => {
      expect(counter.replace(/\s/g, ''), '[Expected 2] The counter reads 100/100').toBe('100/100');
    });

    await step('Act: Step 3 — Try to type 1 more character', async () => {
      await memo.press('End');
      await memo.pressSequentially('X');
      afterExtra = await memo.inputValue();
    });

    await step('Assert: Expected 3 — The field does not go past 100 characters', async () => {
      expect(afterExtra, '[Expected 3] 메모 still holds 100 characters').toHaveLength(100);
    });

    await step('Act: Step 4 — Clear the field, type the emoji value, then type the Korean value', async () => {
      await memo.fill('');
      await memo.pressSequentially('Demo memo 🎁');
      emojiValue = await memo.inputValue();
      await memo.fill('');
      await memo.pressSequentially('데모 입고 메모');
      koreanValue = await memo.inputValue();
    });

    await step('Assert: Expected 4 — The field does not take the emoji and does take the Korean value', async () => {
      expect(emojiValue, '[Expected 4] The emoji is not taken').not.toContain('🎁');
      expect(emojiValue, '[Expected 4] The text around the emoji is kept').toContain('Demo memo');
      expect(koreanValue, '[Expected 4] The Korean value is taken').toBe('데모 입고 메모');
    });
  });

  test('TC_US134_196 — 공급가 takes 0 and 99999999, rejects 100000000, and 기타 사유 caps at 100 characters without emoji', async ({ page, world, incomingDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_196',
      'Medium',
      TAGS,
      `공급가 0 and 99999999 are saved with 등록되었습니다; 100000000 is rejected with WH-INCOMING_PURCHASE_PRICE_EXCEEDED "매입가격이 허용 범위를 초과했습니다." [proposed] and no request is created; 기타 사유 takes the 100-character value, counts 100/100, refuses a 101st character, drops the emoji of "기타 입고 테스트 🎁" and keeps the Korean text. ${DATE_NOTE} ${OWN_NOTE} ${STATUS_NOTE}`,
    );
    const { list, inbound } = pages(page, dialog);
    const cj = destination(world);
    let sku!: WorldSku;
    const saves: Record<number, InboundSave | null> = {};
    const created: Record<number, IncomingRecord[]> = {};
    let note = { full: '', counter: '', afterExtra: '' };
    let mixed = '';
    const attempt = async (n: number, supplyPrice: string) => {
      const before = await incomingsOf(sku);
      await inbound.reopenFor(sku, cj.name);
      await inbound.fill(standardForm(world, { supplyPrice }));
      saves[n] = await inbound.trySave();
      created[n] = newRecords(await incomingsOf(sku), before);
    };

    await step('Arrange: Pre-condition 1–4 — Physical row DEMO-SKU-0001 in CJ Incheon Aam; TC test data and the 100-character note', async () => {
      sku = await ownStockedSku(world, 'TC196');
      await list.open('ko');
    });

    await step('Act: Step 1 — Tick DEMO-SKU-0001, open 입고 요청 (Inbound request), set 공급가 (Supply price) 0, fill the rest and click 저장 (Save)', async () => {
      await attempt(1, '0');
    });

    await step('Assert: Expected 1 — The save goes through and shows 등록되었습니다 (Registered.)', async () => {
      expect(saves[1]?.status, '[Expected 1] The save is accepted').toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 1] The message ${t('msg.registered')} appears`).toContainText(t('msg.registered'));
      expect(created[1]?.map((r) => Number(r.purchase_price)), '[Expected 1] A request with 공급가 0 is stored').toEqual([0]);
    });

    await step('Act: Step 2 — Reopen the dialog, set 공급가 (Supply price) 99999999, fill the rest and click 저장 (Save)', async () => {
      await attempt(2, '99999999');
    });

    await step('Assert: Expected 2 — The save goes through and shows 등록되었습니다 (Registered.)', async () => {
      expect(saves[2]?.status, '[Expected 2] The save is accepted').toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 2] The message ${t('msg.registered')} appears`).toContainText(t('msg.registered'));
      expect(created[2]?.map((r) => Number(r.purchase_price)), '[Expected 2] A request with 공급가 99999999 is stored').toEqual([99999999]);
    });

    await step('Act: Step 3 — Reopen the dialog, set 공급가 (Supply price) 100000000, fill the rest and click 저장 (Save)', async () => {
      await attempt(3, '100000000');
    });

    await step('Assert: Expected 3 — The save is rejected with WH-INCOMING_PURCHASE_PRICE_EXCEEDED and no request is created', async () => {
      const error = errorOf(saves[3] ?? { status: 0, body: {} });
      expect(error.status, '[Expected 3] The save is rejected with a 4xx status').toBeGreaterThanOrEqual(400);
      expect(error.status, '[Expected 3] The rejection is not a server error').toBeLessThan(500);
      expect(error.code, '[Expected 3] The code is WH-INCOMING_PURCHASE_PRICE_EXCEEDED').toBe('WH-INCOMING_PURCHASE_PRICE_EXCEEDED');
      await expect(dialog.errorAlert, '[Expected 3] The message 매입가격이 허용 범위를 초과했습니다. is shown').toContainText('매입가격이 허용 범위를 초과했습니다.');
      expect(created[3], '[Expected 3] No inbound request is created').toHaveLength(0);
    });

    await step('Act: Step 4 — Reopen the dialog, pick 기타 (Other), type the 100-character note into 기타 사유, read the counter, then type 1 more character', async () => {
      await inbound.reopenFor(sku, cj.name);
      await dialog.typeRadio('ETC').check();
      await dialog.etcNote.fill(MEMO_100);
      const full = await dialog.etcNote.inputValue();
      const counter = squash(await inbound.counterOf(dialog.etcNote).innerText());
      await dialog.etcNote.press('End');
      await dialog.etcNote.pressSequentially('X');
      note = { full, counter, afterExtra: await dialog.etcNote.inputValue() };
    });

    await step('Assert: Expected 4 — The field holds 100 characters, the counter shows 100 of 100 and the 101st character is not taken', async () => {
      expect(note.full, '[Expected 4] 기타 사유 holds the full 100-character value').toBe(MEMO_100);
      expect(note.counter.replace(/\s/g, ''), '[Expected 4] The counter reads 100/100').toBe('100/100');
      expect(note.afterExtra, '[Expected 4] The 101st character is not taken').toHaveLength(100);
    });

    await step('Act: Step 5 — Clear the note and type 기타 입고 테스트 🎁', async () => {
      await dialog.etcNote.fill('');
      await dialog.etcNote.pressSequentially('기타 입고 테스트 🎁');
      mixed = await dialog.etcNote.inputValue();
    });

    await step('Assert: Expected 5 — The emoji is not taken and the Korean text 기타 입고 테스트 is taken', async () => {
      expect(mixed, '[Expected 5] The emoji is not taken').not.toContain('🎁');
      expect(mixed, '[Expected 5] The Korean text is taken').toContain('기타 입고 테스트');
    });
  });

  test('TC_US134_197 — The CJ product-registration call is sent for a CJ destination and not for a non-CJ destination', async () => {
    await skipTc(
      'TC_US134_197',
      'High',
      TAGS,
      'An inbound request into CJ Incheon Aam (CJ_LOGISTICS, CJ warehouse code) sends exactly one CJ product-registration call (SKU code, name, barcode, price, HS code, country of origin) and no CJ inbound-request call, while a request into Demo Pickup Point (channel NONE) sends no CJ call.',
      'The CJ connector call is made server-to-server by the backend; the dev environment exposes no CJ connector call log to the browser, the admin API or the suite database, so the calls cannot be counted or read.',
    );
  });

  test('TC_US134_198 — Nothing is saved when the CJ product-registration call fails', async () => {
    await skipTc(
      'TC_US134_198',
      'High',
      TAGS,
      'With the CJ connector stubbed to fail the product-registration call, an inbound request for a SKU with no stock record into CJ Incheon Aam is rejected with WH-WAREHOUSE_FAILURE "물류 창고 연동에 실패했습니다. {cause}", and neither the request nor the stock row is written.',
      'The CJ connector is called server-to-server by the backend; dev offers no switch or stub to make that call fail, and the browser cannot intercept it, so the failure cannot be forced.',
    );
  });

  test('TC_US134_199 — A save into a CJ warehouse without a CJ warehouse code fails with the logistics-code error', async ({ page, world, incomingDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_199',
      'High',
      TAGS,
      `A WMS · CJ_LOGISTICS warehouse of Demo Partner A without a CJ warehouse code ("Demo CJ No Code") is still offered and can be picked in 입고지; the save is rejected with WH-WAREHOUSE_LOGISTICS_CODE_NOT_CONFIGURED "창고에 물류 코드가 설정되어 있지 않습니다. 관리자에게 문의해주세요." [proposed] and no inbound request names that warehouse. Data: the warehouse is created by the test through the US069 API (which requires a CJ code) and its code is then cleared by DB fixture; removed in teardown. Not automated: "no CJ call is sent" — the CJ connector call is server-to-server and not observable. ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const { list, inbound } = pages(page, dialog);
    let sku!: WorldSku;
    let noCode!: { id: number; name: string };
    let entries: Array<{ value: string; label: string }> = [];
    let picked = '';
    let saved!: InboundSave;

    await step('Arrange: Pre-condition 1–4 — WMS · CJ_LOGISTICS warehouse Demo CJ No Code with an empty CJ warehouse code; DEMO-SKU-0001 under the same partner', async () => {
      const created = await world.createWarehouse('Demo CJ No Code', 'PLATFORM_WMS_EGFLEX');
      noCode = { id: created.id, name: created.name };
      await clearCjWarehouseCode(created.id);
      const [stored] = await stockDb.query<RowDataPacket>('SELECT logistics_type, logistics_channel_type, logistics_channel_warehouse_code FROM warehouse WHERE id = ?', [created.id]);
      expect(stored, 'The warehouse is WMS · CJ_LOGISTICS with no CJ warehouse code').toMatchObject({ logistics_type: 'WMS', logistics_channel_type: 'CJ_LOGISTICS', logistics_channel_warehouse_code: null });
      sku = await ownStockedSku(world, 'TC199');
    });

    await step('Act: Step 1 — Tick DEMO-SKU-0001 and click 입고 요청 (Inbound request)', async () => {
      await list.open('ko');
      await inbound.reopenFor(sku, destination(world).name);
    });

    await step('Assert: Expected 1 — The dialog opens with 1 row', async () => {
      await expect(dialog.rows, '[Expected 1] The dialog holds 1 row').toHaveCount(1);
    });

    await step('Act: Step 2 — Pick Demo CJ No Code in 입고지 (Inbound destination) and read the dropdown', async () => {
      entries = await inbound.warehouseOptionEntries();
      if (entries.some((entry) => entry.value === String(noCode.id))) await inbound.chooseWarehouseById(noCode.id, noCode.name);
      picked = await dialog.warehouseSelect.inputValue();
    });

    await step('Assert: Expected 2 — That warehouse is still offered and can be picked', async () => {
      expect(entries.map((entry) => entry.value), `[Expected 2] 입고지 offers ${noCode.name}`).toContain(String(noCode.id));
      expect(picked, `[Expected 2] ${noCode.name} is picked`).toBe(String(noCode.id));
    });

    await step('Act: Step 3 — Fill the remaining required fields and click 저장 (Save)', async () => {
      await inbound.fill({ expectedDate: EXPECTED_DATE, lines: [{ supplyPrice: '12000', quantity: '100' }] });
      saved = await inbound.save();
    });

    await step('Assert: Expected 3 — The save is rejected with WH-WAREHOUSE_LOGISTICS_CODE_NOT_CONFIGURED', async () => {
      const error = errorOf(saved);
      expect(error.status, '[Expected 3] The save is rejected with a 4xx status').toBeGreaterThanOrEqual(400);
      expect(error.status, '[Expected 3] The rejection is not a server error').toBeLessThan(500);
      expect(error.code, '[Expected 3] The code is WH-WAREHOUSE_LOGISTICS_CODE_NOT_CONFIGURED').toBe('WH-WAREHOUSE_LOGISTICS_CODE_NOT_CONFIGURED');
      await expect(dialog.errorAlert, '[Expected 3] The logistics-code message is shown').toContainText('창고에 물류 코드가 설정되어 있지 않습니다. 관리자에게 문의해주세요.');
    });

    await step('Act: Step 4 — Open the inbound status screen and look for a request to Demo CJ No Code', async () => {
      expect(noCode.id, 'The warehouse id is known').toBeGreaterThan(0);
    });

    await step('Assert: Expected 4 — No inbound request is created', async () => {
      expect(await incomingsToWarehouse(noCode.id), '[Expected 4] No inbound record names Demo CJ No Code').toBe(0);
      expect(await incomingsOf(sku), '[Expected 4] The SKU has no inbound record').toHaveLength(0);
    });
  });

  test('TC_US134_200 — Saving the same inbound request twice creates 2 separate records', async ({ page, world, incomingDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_200',
      'High',
      TAGS,
      `The same inbound request (CJ Incheon Aam, 공급가 12000, 요청 수량 100) saved twice from 2 dialog openings is accepted twice with 등록되었습니다 and stored as 2 separate inbound records of 100 units each with the same expected inbound date. ${DATE_NOTE} ${OWN_NOTE} ${STATUS_NOTE}`,
    );
    const { list, inbound } = pages(page, dialog);
    const cj = destination(world);
    let sku!: WorldSku;
    const saves: InboundSave[] = [];
    let matching: IncomingRecord[] = [];

    await step('Arrange: Pre-condition 1–3 — Physical row DEMO-SKU-0001 in CJ Incheon Aam; TC test data', async () => {
      sku = await ownStockedSku(world, 'TC200');
      await list.open('ko');
    });

    await step('Act: Step 1 — Tick DEMO-SKU-0001, click 입고 요청 (Inbound request), fill every field with the test data and click 저장 (Save)', async () => {
      await inbound.reopenFor(sku, cj.name);
      await inbound.fill(standardForm(world));
      saves.push(await inbound.save());
    });

    await step('Assert: Expected 1 — The first save goes through and shows 등록되었습니다 (Registered.)', async () => {
      expect(saves[0]?.status, '[Expected 1] The first save is accepted').toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 1] The message ${t('msg.registered')} appears`).toContainText(t('msg.registered'));
    });

    await step('Act: Step 2 — Tick DEMO-SKU-0001 again, open the dialog again, fill exactly the same test data and click 저장 (Save)', async () => {
      await expect(dialog.root, 'The first dialog has closed').toHaveCount(0);
      await inbound.reopenFor(sku, cj.name);
      await inbound.fill(standardForm(world));
      saves.push(await inbound.save());
    });

    await step('Assert: Expected 2 — The second save also goes through and also shows 등록되었습니다 (Registered.)', async () => {
      expect(saves[1]?.status, `[Expected 2] The second save is accepted (body ${JSON.stringify(saves[1]?.body ?? {}).slice(0, 200)})`).toBeLessThan(300);
      await expect(dialog.root, '[Expected 2] The dialog closes').toHaveCount(0);
      await expect(list.lastToast(), `[Expected 2] The message ${t('msg.registered')} appears`).toContainText(t('msg.registered'));
    });

    await step(`Act: Step 3 — Open the inbound status screen and count the DEMO-SKU-0001 requests with expected inbound date ${EXPECTED_DATE} and quantity 100`, async () => {
      matching = (await incomingsOf(sku)).filter((r) => dbDate(r.request_date) === EXPECTED_DATE && Number(r.requested_quantity) === 100);
    });

    await step('Assert: Expected 3 — There are 2 separate inbound records, 100 units each', async () => {
      expect(matching, '[Expected 3] 2 inbound records match').toHaveLength(2);
      expect(new Set(matching.map((r) => r.incoming_id)).size, '[Expected 3] The 2 records are separate').toBe(2);
      for (const record of matching) expect(Number(record.requested_quantity), '[Expected 3] Each record holds 100 units').toBe(100);
    });
  });

  test('TC_US134_201 — A double-click on 저장 sends exactly one call and creates one record', async ({ page, world, incomingDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_201',
      'High',
      TAGS,
      `With the dialog filled with the test data, a fast double-click on 저장 greys the button out after the first click, sends exactly 1 POST ${INCOMING_PATH} call and creates exactly 1 inbound record. The save call is held in the browser (route) until the button state is read, in place of a slow network. ${DATE_NOTE} ${OWN_NOTE} ${STATUS_NOTE}`,
    );
    const { list, inbound } = pages(page, dialog);
    const cj = destination(world);
    let sku!: WorldSku;
    let held: Awaited<ReturnType<StockInboundPage['holdIncomingPost']>> | undefined;
    let posts!: PostCounter;
    let response!: Promise<InboundSave>;
    let records: IncomingRecord[] = [];

    try {
      await step('Arrange: Pre-condition 1–4 — Physical row DEMO-SKU-0001 in CJ Incheon Aam; call counter started; TC test data', async () => {
        sku = await ownStockedSku(world, 'TC201');
        await list.open('ko');
      });

      await step('Act: Step 1 — Tick DEMO-SKU-0001, click 입고 요청 (Inbound request) and fill every field with the test data', async () => {
        await inbound.reopenFor(sku, cj.name);
        await inbound.fill(standardForm(world));
      });

      await step('Assert: Expected 1 — The dialog holds the values typed', async () => {
        await expect(dialog.warehouseSelect, '[Expected 1] 입고지 is CJ Incheon Aam').toHaveValue(String(cj.id));
        await expect(dialog.expectedDateInput, `[Expected 1] 입고 예정일 is ${EXPECTED_DATE}`).toHaveValue(EXPECTED_DATE);
        await expect(dialog.supplyPriceInput(0), '[Expected 1] 공급가 is 12000').toHaveValue('12000');
        await expect(dialog.quantityInput(0), '[Expected 1] 요청 수량 is 100').toHaveValue('100');
      });

      await step('Act: Step 2 — Double-click 저장 (Save) as fast as possible', async () => {
        held = await inbound.holdIncomingPost();
        posts = inbound.countPosts();
        response = inbound.nextIncomingResponse();
        response.catch(() => undefined);
        await dialog.saveButton.dblclick();
        await held.seen;
      });

      await step('Assert: Expected 2 — The button is greyed out right after the first click', async () => {
        await expect(dialog.saveButton, '[Expected 2] 저장 is disabled while the save runs').toBeDisabled();
      });

      await step('Act: Step 3 — Count the save calls in the list of calls', async () => {
        held?.release();
        const saved = await response;
        expect(saved.status, 'The save call is answered').toBeLessThan(300);
        await expect(dialog.root, 'The dialog closes').toHaveCount(0);
        posts.stop();
      });

      await step('Assert: Expected 3 — Exactly 1 save call is sent', async () => {
        expect(posts.count, `[Expected 3] Exactly 1 POST ${INCOMING_PATH} call is sent`).toBe(1);
      });

      await step('Act: Step 4 — Open the inbound status screen and count the requests created', async () => {
        records = await incomingsOf(sku);
      });

      await step('Assert: Expected 4 — Exactly 1 inbound record is created', async () => {
        expect(new Set(records.map((r) => r.incoming_id)).size, '[Expected 4] Exactly 1 inbound record is created').toBe(1);
      });
    } finally {
      held?.release();
      await held?.dispose();
    }
  });

  test('TC_US134_202 — A save into a destination deleted after it was picked is rejected with WH-WAREHOUSE_NOT_FOUND', async ({ page, world, playwright, incomingDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_202',
      'Medium',
      TAGS,
      `With a PLATFORM warehouse of Demo Partner A picked in 입고지, deleting that warehouse through the US069 warehouse API while the dialog stays open changes nothing on the dialog; 저장 is then rejected with WH-WAREHOUSE_NOT_FOUND "창고를 찾을 수 없습니다. - id: {id}" carrying the real id, and the dialog stays open with every typed value. Data: the shared CJ Daegu warehouse must stay for other tests, so the test creates its own PLATFORM warehouse (standing for CJ Daegu warehouse) and deletes it. ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const { list, inbound } = pages(page, dialog);
    const warehouses = await openWarehouseApi(playwright.request);
    let sku!: WorldSku;
    let target!: { id: number; name: string };
    let before: string[] = [];
    let after: string[] = [];
    let saved!: InboundSave;

    try {
      await step('Arrange: Pre-condition 1–5 — DEMO-SKU-0001 in CJ Incheon Aam; a selectable PLATFORM warehouse (CJ Daegu warehouse); the warehouse API shares the session', async () => {
        sku = await ownStockedSku(world, 'TC202');
        const created = await world.createWarehouse('WH202 CJ Daegu warehouse', 'PLATFORM_GENERAL');
        target = { id: created.id, name: created.name };
        await list.open('ko');
      });

      await step('Act: Step 1 — Tick DEMO-SKU-0001, click 입고 요청 (Inbound request) and pick CJ Daegu warehouse in 입고지 (Inbound destination)', async () => {
        await inbound.reopenFor(sku, destination(world).name);
        await inbound.chooseWarehouseById(target.id, target.name);
      });

      await step('Assert: Expected 1 — The dialog opens and the destination is picked', async () => {
        await expect(dialog.root, '[Expected 1] The 입고 요청 dialog is open').toBeVisible();
        await expect(dialog.warehouseSelect, `[Expected 1] 입고지 is ${target.name}`).toHaveValue(String(target.id));
      });

      await step('Act: Step 2 — Remove the warehouse through the US069 warehouse API while this dialog stays open', async () => {
        before = await dialog.rowValues(0);
        const removed = await warehouses.api.remove(target.id);
        expect(removed.status, 'The warehouse is deleted').toBeLessThan(300);
        after = await dialog.rowValues(0);
      });

      await step('Assert: Expected 2 — Nothing on the dialog changes', async () => {
        await expect(dialog.root, '[Expected 2] The dialog is still open').toBeVisible();
        await expect(dialog.warehouseSelect, '[Expected 2] 입고지 still shows the picked warehouse').toHaveValue(String(target.id));
        expect(after, '[Expected 2] The SKU row is unchanged').toEqual(before);
      });

      await step('Act: Step 3 — Fill the remaining required fields and click 저장 (Save)', async () => {
        await inbound.fill({ expectedDate: EXPECTED_DATE, lines: [{ supplyPrice: '12000', quantity: '100' }] });
        saved = await inbound.save();
      });

      await step('Assert: Expected 3 — The save is rejected with WH-WAREHOUSE_NOT_FOUND: 창고를 찾을 수 없습니다. - id: {id} with the real id', async () => {
        const error = errorOf(saved);
        expect(error.status, '[Expected 3] The save is rejected with a 4xx status').toBeGreaterThanOrEqual(400);
        expect(error.status, '[Expected 3] The rejection is not a server error').toBeLessThan(500);
        expect(error.code, '[Expected 3] The code is WH-WAREHOUSE_NOT_FOUND').toBe('WH-WAREHOUSE_NOT_FOUND');
        expect(error.message, '[Expected 3] The message names the real warehouse id').toBe(`창고를 찾을 수 없습니다. - id: ${target.id}`);
        await expect(dialog.errorAlert, '[Expected 3] The dialog shows the message').toContainText(`창고를 찾을 수 없습니다. - id: ${target.id}`);
      });

      await step('Act: Step 4 — See whether the dialog is still open', async () => {
        await expect(dialog.footer, 'The dialog footer is shown').toBeVisible();
      });

      await step('Assert: Expected 4 — The dialog is still open and keeps every value that was typed', async () => {
        await expect(dialog.root, '[Expected 4] The dialog is still open').toBeVisible();
        await expect(dialog.warehouseSelect, '[Expected 4] 입고지 is kept').toHaveValue(String(target.id));
        await expect(dialog.expectedDateInput, '[Expected 4] 입고 예정일 is kept').toHaveValue(EXPECTED_DATE);
        await expect(dialog.supplyPriceInput(0), '[Expected 4] 공급가 is kept').toHaveValue('12000');
        await expect(dialog.quantityInput(0), '[Expected 4] 요청 수량 is kept').toHaveValue('100');
      });
    } finally {
      await warehouses.dispose();
    }
  });

  test('TC_US134_203 — The server rejects an invalid set of inbound values with WH-INCOMING_INVALID', async () => {
    await skipTc(
      'TC_US134_203',
      'Medium',
      TAGS,
      'A create-inbound call sent straight to the server with a value set the server refuses is rejected with WH-INCOMING_INVALID "유효하지 않은 입고입니다. {detail}" and creates no inbound record.',
      'The TC test data is NEEDS CLARIFICATION: the SRS names no payload that triggers WH-INCOMING_INVALID, and BA/Dev have not given one, so the call cannot be built.',
    );
  });

  test('TC_US134_204 — 취소 closes a clean dialog at once and asks first when something was typed', async ({ page, world, incomingDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_204',
      'Medium',
      TAGS,
      `취소 on an untouched 입고 요청 dialog closes it with no question; after typing 100 in 요청 수량 it opens the confirm box "작성된 항목을 등록하지 않고, 입력창을 닫을까요?" whose 취소 keeps the dialog with 100, and whose 닫기 closes it so that a reopened dialog has an empty 요청 수량. Read-only on the shared DEMO-SKU-0001 row (nothing is saved). ${WORLD_NOTE}`,
    );
    const { list, inbound } = pages(page, dialog);
    const seed = world.row('SKU0001', world.warehouses.CJ);
    const open = () => inbound.openFor([{ row: list.row(seed.sku.skuCode, seed.warehouse.name), label: seed.sku.skuCode }]);
    let confirmText = '';
    let closedAfterConfirm = false;
    let reopenedQuantity = '';

    await step('Arrange: Pre-condition 1–3 — Physical row DEMO-SKU-0001 in CJ Incheon Aam; requested quantity 100', async () => {
      expect(seed.sku.type, 'DEMO-SKU-0001 is physical').toBe('PHYSICAL');
    });

    await step('Act: Step 1 — Tick DEMO-SKU-0001, click 입고 요청 (Inbound request) and click 취소 (Cancel) with nothing typed', async () => {
      await showWorld(list, world);
      await open();
      await dialog.clickCancel();
    });

    await step('Assert: Expected 1 — The dialog closes with no question', async () => {
      await expect(dialog.root, '[Expected 1] The dialog closes').toHaveCount(0);
      await expect(dialog.confirmClose, '[Expected 1] No confirm box is shown').toHaveCount(0);
    });

    await step('Act: Step 2 — Open the dialog again, type 100 into 요청 수량 (Requested quantity) and click 취소 (Cancel)', async () => {
      await open();
      await dialog.quantityInput(0).fill('100');
      await dialog.clickCancel();
    });

    await step('Assert: Expected 2 — A confirm dialog opens', async () => {
      await expect(dialog.confirmClose, '[Expected 2] A confirm box opens').toBeVisible();
    });

    await step('Act: Step 3 — Read the confirm dialog, then choose the option that keeps the dialog open', async () => {
      confirmText = squash(await dialog.confirmClose.innerText());
      await dialog.confirmClose.getByRole('button', { name: t('btn.cancel') }).click();
    });

    await step('Assert: Expected 3 — The confirm shows 작성된 항목을 등록하지 않고, 입력창을 닫을까요? and the dialog stays open with 100 still in the field', async () => {
      expect(confirmText, `[Expected 3] The confirm reads ${t('msg.closeWithoutSaving')}`).toContain(t('msg.closeWithoutSaving'));
      await expect(dialog.confirmClose, '[Expected 3] The confirm box closes').toHaveCount(0);
      await expect(dialog.root, '[Expected 3] The 입고 요청 dialog stays open').toBeVisible();
      await expect(dialog.quantityInput(0), '[Expected 3] 요청 수량 still holds 100').toHaveValue('100');
    });

    await step('Act: Step 4 — Click 취소 (Cancel) again, confirm, then open the dialog again and read 요청 수량 (Requested quantity)', async () => {
      await dialog.clickCancel();
      await expect(dialog.confirmClose, 'The confirm box opens').toBeVisible();
      await dialog.confirmDiscard();
      await expect(dialog.root, 'The dialog closes').toHaveCount(0);
      closedAfterConfirm = true;
      await open();
      reopenedQuantity = await dialog.quantityInput(0).inputValue();
    });

    await step('Assert: Expected 4 — The dialog closes, and when reopened the field is empty', async () => {
      expect(closedAfterConfirm, '[Expected 4] The dialog closed after confirming').toBe(true);
      expect(reopenedQuantity, '[Expected 4] 요청 수량 is empty on the reopened dialog').toBe('');
    });
  });
});
