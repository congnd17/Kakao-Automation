import { test, expect } from '@fixtures/stock.fixture';
import type { Page } from '@playwright/test';
import type { RowDataPacket } from 'mysql2/promise';
import { makeStep } from '@utils/step';
import { skipTc, tcMeta } from '@utils/tc-meta';
import { WAREHOUSE_CATEGORY_ORDER, WAREHOUSE_CATEGORY_TEXT, stx } from '@utils/stock.i18n';
import { WORLD_NOTE, stockTags } from '@utils/stock-spec';
import { stockDb } from '@utils/stock-db';
import { env } from '@utils/env.config';
import { xlsxFile } from '@utils/xlsx-writer';
import { uniqueCode, uniqueHsCode, exportName } from '@utils/stock.data';
import type { StockWorld } from '@utils/stock.data';
import type { ApiResult } from '@api/payment-method-policy.api';
import type { StockApiError } from '@api/stock.api';
import {
  CapturedCall,
  StockCalculationPage,
  asWorldWarehouse,
  futureDate,
  ownGroupName,
  ownPhysicalSku,
  squash,
} from '@pages/stock-calculation.page';

/**
 * US134 — nhóm [Integration] (TC_US134_413–433): kho đọc từ danh mục kho US069, guard khi kho không tồn tại / sai nhóm,
 * kho ảo, menu, phiên đăng nhập + header của mọi call, mã lỗi chữ, 대구분 suy ra từ 2 cột, guard phía server.
 * TC cần US105 (Procurement), CJ connector log, migration / deploy hoặc review mã nguồn → skip kèm lý do.
 * Mọi ghi dữ liệu chỉ trên SKU / kho do test tự tạo (teardown world dọn).
 */
const TAGS = stockTags('integration');

/** Kho không tồn tại trong danh mục kho (TC_414 / 415). */
const MISSING_WAREHOUSE_ID = 999_999_999_999_999;

const US105_REASON =
  'Needs US105 Procurement to post goods receipts (damaged / fully consigned lines) into the shared inventory — US105 is a separate story whose posting flow this suite does not drive, and the system-raised inbound rows cannot be told apart from operator writes by seeding.';

/** code / message của body lỗi Problem Details. */
function errorOf(result: ApiResult<unknown>): { status: number; code: string; message: string } {
  const body = (result.body ?? {}) as StockApiError;
  return { status: result.status, code: body.code ?? '', message: body.message ?? body.detail ?? '' };
}

/** Bấm 1 nút toolbar khi guard đang hiện câu `previous` → đợi guard đổi câu rồi đọc. */
async function nextGuard(list: StockCalculationPage, key: 'btn.convertStock' | 'btn.warehouseDetail', previous: string): Promise<string> {
  await list.clickToolbar(key);
  await expect(list.guardAlert, `The guard message changes after clicking ${list.t(key)}`).not.toHaveText(previous);
  return squash(await list.guardAlert.innerText());
}

/** Mở 1 mục menu sidebar theo tên — mở nhóm COMMERCE › 물류관리 khi mục nằm ở đó và đang đóng. */
async function clickMenuItem(list: StockCalculationPage, name: string): Promise<void> {
  if (!(await list.sidebarLink(name).isVisible())) await list.expandSidebarGroup('물류관리');
  await list.click(list.sidebarLink(name), `${name} menu item`);
}

/** Tên mục con của nhóm sidebar (rỗng khi nhóm không có trên menu). */
async function groupChildren(list: StockCalculationPage, name: string): Promise<string[]> {
  if ((await list.sidebarLink(name).count()) === 0) return [];
  await list.expandSidebarGroup(name);
  return list.sidebarChildren(name);
}

function pathOf(page: Page): string {
  return new URL(page.url()).pathname;
}

function daeguOrSkip(world: StockWorld): void {
  test.skip(!world.warehouses.DAEGU, world.daeguUnavailableReason ?? 'The CJ Daegu warehouse could not be built on dev.');
}

test.describe('[Integration] Stock management — warehouse catalogue, menu, session and server guards', () => {
  test('TC_US134_413 — Every warehouse is read from the warehouse catalogue where it is shown, offered or filtered by', async ({ page, world, incomingDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_413',
      'High',
      TAGS,
      `The 창고 filter choices equal the warehouse catalogue response (GET /warehouses/all · type=PLATFORM) and no other warehouse call is made; each demo row shows the catalogue name of its warehouse; 입고지 in 입고 요청 offers only catalogue (PLATFORM) warehouses; after renaming a warehouse in the catalogue to "… v2" both the filter choice and the row cell show the new name; the list call and the inbound save each carry exactly 1 warehouse id. Data: renaming / saving needs a warehouse the suite owns, so a PLATFORM general warehouse and a physical SKU are created for the test (the shared CJ Incheon Aam of the world is not renamed); the rename is written to the warehouse table (the US069 catalogue) directly because the US069 screen belongs to another suite. ${WORLD_NOTE}`,
    );
    const list = new StockCalculationPage(page);
    const calls = list.captureApiCalls();
    const warehouse = await world.createWarehouse('WH413 Aam', 'PLATFORM_GENERAL');
    const renamed = `${warehouse.name} v2`;
    const sku = await ownPhysicalSku(world, 'TC413');
    let catalogue: Array<{ id: number; name: string }> = [];
    let catalogueUrl = '';
    let warehouseCalls: CapturedCall[] = [];
    let filterChoices: string[] = [];
    const rowCells: Array<{ code: string; expected: string; shown: string }> = [];
    let destinations: string[] = [];
    let afterRename = { choices: [] as string[], cell: '' };
    let listUrl = '';
    let inboundBody: Record<string, unknown> = {};

    await step('Arrange: Pre-condition 1–3 — The catalogue holds the automation CJ Incheon Aam / CJ Daegu / Demo Pickup Point (PLATFORM) and the test warehouse; DEMO-SKU-0001 @ CJ Incheon Aam exists', async () => {
      await world.seedStock(sku, asWorldWarehouse(warehouse), { available: 10 });
      expect(warehouse.type, 'The test warehouse is a PLATFORM warehouse').toBe('PLATFORM');
      expect(world.row('SKU0001', world.warehouses.CJ).buckets.available, 'DEMO-SKU-0001 @ CJ Incheon Aam exists').toBe(120);
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management) and read every choice in the 창고 (Warehouse) filter', async () => {
      const start = calls.length;
      const response = page.waitForResponse((res) => res.url().includes('/api/v1/warehouses/all'), { timeout: 30_000 });
      await list.openWorld(world);
      const res = await response;
      catalogueUrl = res.url();
      catalogue = ((await res.json()) as { items: Array<{ id: number; name: string }> }).items;
      warehouseCalls = calls.slice(start).filter((call) => /\/warehouses?\b/.test(new URL(call.url).pathname));
      filterChoices = await list.multiOptions('warehouse');
    });

    await step('Assert: Expected 1 — The choices come from the warehouse catalogue and from no other source', async () => {
      expect(new URL(catalogueUrl).searchParams.get('type'), '[Expected 1] The catalogue call asks for PLATFORM warehouses').toBe('PLATFORM');
      expect(warehouseCalls.length, '[Expected 1] The screen makes exactly 1 warehouse call (the catalogue)').toBe(1);
      expect([...filterChoices].sort(), '[Expected 1] The filter choices are exactly the catalogue warehouses').toEqual(catalogue.map((w) => w.name).sort());
    });

    await step('Act: Step 2 — Read the 창고 (Warehouse) column of the demo rows', async () => {
      for (const seed of world.stockRows.filter((r) => /^SKU\d{4}$/.test(r.sku.key))) {
        const row = list.row(seed.sku.skuCode, seed.warehouse.name);
        const expected = catalogue.find((w) => w.id === seed.warehouse.id)?.name ?? `<warehouse ${seed.warehouse.id} not in catalogue>`;
        rowCells.push({ code: seed.sku.skuCode, expected, shown: (await row.count()) > 0 ? await list.cellText(row, 'col.warehouse') : '<row not listed>' });
      }
    });

    await step('Assert: Expected 2 — Each row shows exactly the name stored in the warehouse catalogue', async () => {
      expect(rowCells.length, '[Expected 2] Demo rows with stock are reviewed').toBeGreaterThan(0);
      for (const cell of rowCells) expect(cell.shown, `[Expected 2] The 창고 cell of ${cell.code} is its catalogue name`).toBe(cell.expected);
    });

    await step('Act: Step 3 — Tick DEMO-SKU-0001, open 입고 요청 (Inbound request) and read every choice in 입고지', async () => {
      const seed = world.row('SKU0001', world.warehouses.CJ);
      const row = list.row(seed.sku.skuCode, seed.warehouse.name);
      await list.tick(row, seed.sku.skuCode);
      await list.clickToolbar('btn.incomingRequest');
      await dialog.waitOpen('ko');
      destinations = (await dialog.warehouseOptions()).filter((name) => name !== stx('incoming.field.warehousePlaceholder', 'ko'));
      await dialog.clickCancel();
      await dialog.expectClosed();
      await list.checkbox(row).uncheck();
    });

    await step('Assert: Expected 3 — The dropdown offers those same catalogue warehouses, filtered to PLATFORM', async () => {
      expect(destinations.length, '[Expected 3] 입고지 offers warehouses').toBeGreaterThan(0);
      const names = catalogue.map((w) => w.name);
      for (const name of destinations) expect(names, `[Expected 3] 입고지 choice "${name}" is a PLATFORM catalogue warehouse`).toContain(name);
      expect(destinations, `[Expected 3] 입고지 offers ${world.warehouses.CJ.name}`).toContain(world.warehouses.CJ.name);
    });

    await step('Act: Step 4 — Rename the test warehouse to "… v2" in the catalogue, come back to the list and read the filter choices and its row', async () => {
      await stockDb.exec('UPDATE warehouse SET name = ? WHERE id = ?', [renamed, warehouse.id]);
      await list.open('ko');
      afterRename.choices = await list.multiOptions('warehouse');
      await list.findSku(sku);
      afterRename.cell = await list.cellText(list.row(sku.skuCode), 'col.warehouse');
    });

    await step('Assert: Expected 4 — Both the filter choice and the row cell show the new name "… v2"', async () => {
      expect(afterRename.choices, `[Expected 4] The filter offers ${renamed}`).toContain(renamed);
      expect(afterRename.choices, `[Expected 4] The filter no longer offers the old name ${warehouse.name}`).not.toContain(warehouse.name);
      expect(afterRename.cell, `[Expected 4] The row cell shows ${renamed}`).toBe(renamed);
    });

    await step('Act: Step 5 — Read the data sent by the list call and by the inbound request save, looking for a second warehouse id', async () => {
      await list.pickMulti('warehouse', renamed);
      const listRequest = page.waitForRequest((req) => req.url().includes('/api/v1/stock-status?') && req.url().includes('warehouseIds='));
      await list.clickSearch();
      listUrl = (await listRequest).url();
      const row = list.row(sku.skuCode, renamed);
      await list.tick(row, sku.skuCode);
      await list.clickToolbar('btn.incomingRequest');
      await dialog.waitOpen('ko');
      await dialog.chooseWarehouse(renamed);
      await dialog.typeExpectedDate(futureDate(7));
      await dialog.fillLine(0, { supplyPrice: '1000', quantity: '1' });
      const saveRequest = page.waitForRequest((req) => new URL(req.url()).pathname === '/api/v1/incoming' && req.method() === 'POST');
      await list.waitForListReload(async () => {
        await dialog.saveAndWait('/api/v1/incoming');
      });
      inboundBody = ((await saveRequest).postDataJSON() ?? {}) as Record<string, unknown>;
    });

    await step('Assert: Expected 5 — Each call carries exactly 1 warehouse id', async () => {
      const ids = (new URL(listUrl).searchParams.get('warehouseIds') ?? '').split(',').filter(Boolean);
      expect(ids, '[Expected 5] The list call carries exactly the 1 selected warehouse id').toEqual([String(warehouse.id)]);
      const warehouseKeys = Object.keys(inboundBody).filter((key) => /warehouse/i.test(key));
      expect(warehouseKeys, '[Expected 5] The inbound save carries exactly 1 warehouse field').toEqual(['warehouseId']);
      expect(String(inboundBody.warehouseId), '[Expected 5] The inbound save names the test warehouse').toBe(String(warehouse.id));
    });
  });

  test('TC_US134_414 — A dash is shown and the 4 actions are closed when the warehouse is not in the catalogue', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_414',
      'Medium',
      TAGS,
      `A stock row whose warehouse id (999999999999999) is absent from the catalogue shows "-" as 창고; 재고 조정 and 재고 전환 are blocked with the no-warehouse sentences and 창고별 상세 with the CJ-warehouse sentence; the 재고이력 cell is empty with no button. Data: the fixture row is inserted on the suite's own physical SKU (the TC uses DEMO-SKU-0002, which must stay as built in the shared world). Bundle note: a row with no warehouse renders "-" in the 재고이력 cell (not an empty cell) — the TC expectation (empty) is asserted. ${WORLD_NOTE}`,
    );
    const list = new StockCalculationPage(page);
    const sku = await ownPhysicalSku(world, 'TC414');
    const row = list.row(sku.skuCode);
    let warehouseCell = '';
    const guards = { adjust: '', convert: '', detail: '' };
    let history = { text: '', buttons: -1 };

    await step('Arrange: Pre-condition 1–2 — A fixture stock row with warehouse id 999999999999999 is inserted in the DB', async () => {
      await stockDb.upsertStock(sku.skuId, MISSING_WAREHOUSE_ID, { available: 10 });
      expect(await stockDb.stock(sku.skuId, MISSING_WAREHOUSE_ID), 'The fixture stock row exists').toBeTruthy();
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management) and read the 창고 (Warehouse) cell of the fixture row', async () => {
      await list.open('ko');
      await list.findSku(sku);
      warehouseCell = await list.cellText(row, 'col.warehouse');
    });

    await step('Assert: Expected 1 — The cell shows a dash', async () => {
      expect(warehouseCell, '[Expected 1] The 창고 cell shows a dash').toBe('-');
    });

    await step('Act: Step 2 — Tick that row and click 재고 조정 (Stock adjustment)', async () => {
      await list.tick(row, sku.skuCode);
      guards.adjust = await list.guardTextAfter('btn.adjustStock');
    });

    await step('Assert: Expected 2 — The action is blocked with the no-warehouse adjustment sentence', async () => {
      expect(guards.adjust, '[Expected 2] 재고 조정 is blocked with the no-warehouse sentence').toBe('선택된 SKU 중, 창고 정보 없는 SKU가 포함되어 있습니다. 재고조정은 창고 등록 후 가능합니다.');
    });

    await step('Act: Step 3 — With the row still ticked, click 재고 전환 (Stock conversion), then 창고별 상세 (Per-warehouse detail)', async () => {
      guards.convert = await nextGuard(list, 'btn.convertStock', guards.adjust);
      guards.detail = await nextGuard(list, 'btn.warehouseDetail', guards.convert);
    });

    await step('Assert: Expected 3 — Conversion is blocked with the no-warehouse sentence and per-warehouse detail with the CJ-warehouse sentence', async () => {
      expect(guards.convert, '[Expected 3] 재고 전환 is blocked with the no-warehouse sentence').toBe('선택된 SKU 중, 창고 정보 없는 SKU가 포함되어 있습니다. 재고 전환은 창고 등록 후 가능합니다.');
      expect(guards.detail, '[Expected 3] 창고별 상세 is blocked with the CJ-warehouse sentence').toBe('선택한 SKU 중 CJ창고가 아닌 항목이 포함되어 있습니다. CJ창고 SKU만 선택해 주세요.');
    });

    await step('Act: Step 4 — Read the 재고이력 (Stock history) cell of that row', async () => {
      const cell = list.cell(row, 'col.stockHistory');
      history = { text: (await cell.innerText()).trim(), buttons: await cell.getByRole('button').count() };
    });

    await step('Assert: Expected 4 — The cell is empty and there is no 재고이력 (Stock history) button', async () => {
      expect(history.buttons, '[Expected 4] The 재고이력 cell holds no button').toBe(0);
      expect(history.text, '[Expected 4] The 재고이력 cell is empty').toBe('');
    });
  });

  test('TC_US134_415 — A write naming a warehouse id that cannot be found is rejected with WH-WAREHOUSE_NOT_FOUND', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_415',
      'Medium',
      TAGS,
      'An adjustment call (quantity 5, reason ADJUSTMENT) sent through the API for a stock row whose warehouse id 999999999999999 is absent from the catalogue is rejected with WH-WAREHOUSE_NOT_FOUND "창고를 찾을 수 없습니다. - id: 999999999999999"; the row\'s 전체재고 stays 10 and no adjustment is written. Data: the carried-over row is inserted on the suite\'s own physical SKU.',
    );
    const list = new StockCalculationPage(page);
    const sku = await ownPhysicalSku(world, 'TC415');
    let result = { status: 0, code: '', message: '' };
    let total = '';
    let adjustments = -1;
    let physical = -1;

    await step('Arrange: Pre-condition 1–3 — A physical stock row with an absent warehouse id exists; the API client is authenticated', async () => {
      await stockDb.upsertStock(sku.skuId, MISSING_WAREHOUSE_ID, { available: 10 });
      await list.open('ko');
    });

    await step('Act: Step 1 — Send an adjustment call for that stock row with quantity 5 and reason ADJUSTMENT', async () => {
      result = errorOf(await stockApi.createAdjustments({ items: [{ skuId: sku.skuId, warehouseId: MISSING_WAREHOUSE_ID, adjustingQuantity: 5, modifyType: 'ADD', reason: 'ADJUSTMENT' }] }));
    });

    await step('Assert: Expected 1 — The server rejects the request', async () => {
      expect(result.status, '[Expected 1] The adjustment call is rejected with a 4xx status').toBeGreaterThanOrEqual(400);
      expect(result.status, '[Expected 1] The rejection is not a server error').toBeLessThan(500);
    });

    await step('Act: Step 2 — Read the error that comes back', async () => {
      expect(result.code, 'The error body carries a code').toBeDefined();
    });

    await step('Assert: Expected 2 — The server returns WH-WAREHOUSE_NOT_FOUND: 창고를 찾을 수 없습니다. - id: {id} with the real id', async () => {
      expect(result.code, '[Expected 2] The error code is WH-WAREHOUSE_NOT_FOUND').toBe('WH-WAREHOUSE_NOT_FOUND');
      expect(result.message, '[Expected 2] The message names the real warehouse id').toBe(`창고를 찾을 수 없습니다. - id: ${MISSING_WAREHOUSE_ID}`);
    });

    await step('Act: Step 3 — Read the 전체재고 (Total stock) cell of that row on the list', async () => {
      await list.findSku(sku);
      total = await list.cellText(list.row(sku.skuCode), 'col.totalQuantity');
      adjustments = (await stockDb.adjustments(sku.skuId)).length;
      physical = (await stockDb.stock(sku.skuId, MISSING_WAREHOUSE_ID))?.physical_quantity ?? -1;
    });

    await step('Assert: Expected 3 — The cell is unchanged and no write got through', async () => {
      expect(total, '[Expected 3] 전체재고 is still 10').toBe('10');
      expect(physical, '[Expected 3] The stored physical stock is still 10').toBe(10);
      expect(adjustments, '[Expected 3] No adjustment record is written').toBe(0);
    });
  });

  test('TC_US134_416 — The 3 warehouse classifications each drive their own decision', async () => {
    await skipTc(
      'TC_US134_416',
      'Medium',
      TAGS,
      'The 창고 filter and 입고지 offer only PLATFORM warehouses (warehouse type), 창고별 상세 on a pickup row is blocked by logistics type, and an inbound request into Demo Pickup Point sends no CJ call while one into CJ Incheon Aam sends one product registration call (channel).',
      'Steps 3–4 read the log of calls sent to the CJ connector, which is a server-to-CJ integration not observable from the browser, the admin API or the settlement tables; the filter / guard parts are covered by TC_US134_413, 417 and 425.',
    );
  });

  test('TC_US134_417 — None of the 5 virtual warehouses is offered by any warehouse dropdown', async ({ page, world, incomingDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_417',
      'Medium',
      TAGS,
      `The 창고 filter and 입고지 of 입고 요청 list the ordinary automation warehouses and none of the 5 virtual warehouses (매출대기 PENDING_REVENUE, 이동중 IN_TRANSIT, 폐기 SCRAP, 이슈격리 QUARANTINE, 불량 DEFECTIVE). Data: the 5 virtual warehouses are the system buckets generated with the automation CJ Incheon Aam warehouse. ${WORLD_NOTE}`,
    );
    const list = new StockCalculationPage(page);
    const buckets = world.warehouses.CJ.buckets;
    const ordinary = [world.warehouses.CJ.name, world.warehouses.PICKUP.name, world.warehouses.GENERAL.name];
    let filterChoices: string[] = [];
    let destinations: string[] = [];
    let offered = { filter: -1, dialog: -1 };

    await step('Arrange: Pre-condition 1–3 — The catalogue holds 1 virtual warehouse of each of the 5 types next to the ordinary warehouses', async () => {
      expect(buckets.length, 'The automation CJ Incheon Aam warehouse has 5 virtual buckets').toBe(5);
      expect(buckets.every((bucket) => bucket.virtual), 'Every bucket is a virtual warehouse').toBe(true);
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management) and read every choice in the 창고 (Warehouse) filter', async () => {
      await list.openWorld(world);
      filterChoices = await list.multiOptions('warehouse');
    });

    await step('Assert: Expected 1 — The filter lists the ordinary warehouses', async () => {
      for (const name of ordinary) expect(filterChoices, `[Expected 1] The filter offers ${name}`).toContain(name);
    });

    await step('Act: Step 2 — Count how many of the 5 virtual warehouses are offered there', async () => {
      offered.filter = buckets.filter((bucket) => filterChoices.includes(bucket.name)).length;
    });

    await step('Assert: Expected 2 — None of the 5 is offered', async () => {
      expect(offered.filter, '[Expected 2] No virtual warehouse is offered in the filter').toBe(0);
      for (const bucket of buckets) expect(filterChoices, `[Expected 2] The filter does not offer ${bucket.name}`).not.toContain(bucket.name);
    });

    await step('Act: Step 3 — Tick a physical row, open 입고 요청 (Inbound request) and read every choice in 입고지', async () => {
      const seed = world.row('SKU0001', world.warehouses.CJ);
      const row = list.row(seed.sku.skuCode, seed.warehouse.name);
      await list.tick(row, seed.sku.skuCode);
      await list.clickToolbar('btn.incomingRequest');
      await dialog.waitOpen('ko');
      destinations = await dialog.warehouseOptions();
      await dialog.clickCancel();
      await dialog.expectClosed();
      await list.checkbox(row).uncheck();
    });

    await step('Assert: Expected 3 — The dropdown lists the ordinary PLATFORM warehouses', async () => {
      expect(destinations, `[Expected 3] 입고지 offers ${world.warehouses.CJ.name}`).toContain(world.warehouses.CJ.name);
    });

    await step('Act: Step 4 — Count how many of the 5 virtual warehouses are offered there', async () => {
      offered.dialog = buckets.filter((bucket) => destinations.includes(bucket.name)).length;
    });

    await step('Assert: Expected 4 — None of the 5 is offered', async () => {
      expect(offered.dialog, '[Expected 4] No virtual warehouse is offered in 입고지').toBe(0);
      for (const bucket of buckets) expect(destinations, `[Expected 4] 입고지 does not offer ${bucket.name}`).not.toContain(bucket.name);
    });
  });

  test('TC_US134_418 — The left menu item stays lit when the page address is typed into the browser', async ({ page, skuMasterPage }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_418',
      'Medium',
      TAGS,
      'Loading /commerce/product-stock/stock directly from another screen opens the stock list; the first path part is commerce; (NEW)FPT › 물류 관리 is open with 재고 관리 lit, and the same after a reload. "Lit" is read as the active class on the menu link or its list item.',
    );
    const list = new StockCalculationPage(page);
    let firstPart = '';
    let menu = { open: false, lit: false };
    let reloaded = { open: false, lit: false };

    await step('Arrange: Pre-condition 1–2 — Logged in with write access; the browser is on another screen', async () => {
      await skuMasterPage.open('physical');
    });

    await step('Act: Step 1 — Type /commerce/product-stock/stock into the address bar and load the page', async () => {
      await page.goto('/commerce/product-stock/stock');
      await list.waitForList();
    });

    await step('Assert: Expected 1 — The stock list opens', async () => {
      await expect(list.table, '[Expected 1] The stock list table is shown').toBeVisible();
      await expect(list.cardTitle, '[Expected 1] The card 재고 목록 is shown').toHaveText(stx('list.cardTitle', 'ko'));
    });

    await step('Act: Step 2 — Read the page address and its first part', async () => {
      firstPart = pathOf(page).split('/')[1] ?? '';
    });

    await step('Assert: Expected 2 — The first path part is commerce', async () => {
      expect(firstPart, '[Expected 2] The first path part is commerce').toBe('commerce');
    });

    await step('Act: Step 3 — Look at the left menu: which group is open and which item is lit', async () => {
      menu = { open: await list.isSidebarGroupOpen('물류 관리'), lit: await list.isSidebarLit('재고 관리') };
    });

    await step('Assert: Expected 3 — The 물류 관리 group is open and the 재고 관리 item is lit', async () => {
      expect(menu.open, '[Expected 3] The 물류 관리 (Logistics management) group is open').toBe(true);
      expect(menu.lit, '[Expected 3] The 재고 관리 (Stock management) item is lit').toBe(true);
    });

    await step('Act: Step 4 — Reload the page and read the left menu again', async () => {
      await page.reload();
      await list.waitForList();
      reloaded = { open: await list.isSidebarGroupOpen('물류 관리'), lit: await list.isSidebarLit('재고 관리') };
    });

    await step('Assert: Expected 4 — The lit item is still there after the reload', async () => {
      expect(reloaded.open, '[Expected 4] 물류 관리 is still open after the reload').toBe(true);
      expect(reloaded.lit, '[Expected 4] 재고 관리 is still lit after the reload').toBe(true);
    });
  });

  test('TC_US134_419 — Only Stock management and the SKU master group are added and the 2 live logistics screens still work', async ({ page }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_419',
      'Medium',
      TAGS,
      '(NEW)FPT › 물류 관리 holds 재고 관리 (/commerce/product-stock/stock), the sub-group SKU 마스터 관리 with 현물 / set / 디지털 SKU 마스터 관리, 입고 현황 (/commerce/logistics/inbound) and 출고/배송 관리 (/commerce/logistics/outbound); both logistics screens load. Observed on dev 05/10: (NEW)FPT › 물류 관리 holds only 발주 관리 and 재고 관리 and there is no SKU 마스터 관리 group (also TC_US134_08); 입고 현황 / 출고/배송 관리 are looked up anywhere in the menu (COMMERCE › 물류관리 opened when needed). Not automated: "exactly 2 entries are new compared with the state before this user story" — no baseline of the earlier menu exists; the 2 entries are asserted to be inside 물류 관리.',
    );
    const list = new StockCalculationPage(page);
    let children: string[] = [];
    let skuMaster: string[] = [];
    const addresses: Record<string, string> = {};

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; 입고 현황 and 출고/배송 관리 are live', async () => {
      await list.openFromSidebar();
    });

    await step('Act: Step 1 — Expand 물류 관리 (Logistics management) and list every item with its page address', async () => {
      children = await list.sidebarChildren('물류 관리');
      skuMaster = await groupChildren(list, 'SKU 마스터 관리');
      for (const name of ['재고 관리', '입고 현황', '출고/배송 관리']) {
        if (!children.includes(name)) continue;
        const before = pathOf(page);
        await list.click(list.sidebarLink(name), `${name} menu item`);
        if (name !== '재고 관리') await page.waitForURL((url) => url.pathname !== before, { timeout: 15_000 }).catch(() => undefined);
        addresses[name] = pathOf(page);
        await list.expandSidebarGroup('물류 관리');
      }
    });

    await step('Assert: Expected 1 — 물류 관리 holds 재고 관리, the SKU 마스터 관리 sub-group with 3 items, 입고 현황 and 출고/배송 관리 at their addresses', async () => {
      for (const name of ['재고 관리', 'SKU 마스터 관리', '입고 현황', '출고/배송 관리']) expect(children, `[Expected 1] 물류 관리 holds ${name}`).toContain(name);
      for (const name of ['현물 SKU 마스터 관리', 'set SKU 마스터 관리', '디지털 SKU 마스터 관리']) expect(skuMaster, `[Expected 1] SKU 마스터 관리 holds ${name}`).toContain(name);
      expect(addresses['재고 관리'], '[Expected 1] 재고 관리 opens /commerce/product-stock/stock').toBe('/commerce/product-stock/stock');
      expect(addresses['입고 현황'], '[Expected 1] 입고 현황 opens /commerce/logistics/inbound').toBe('/commerce/logistics/inbound');
      expect(addresses['출고/배송 관리'], '[Expected 1] 출고/배송 관리 opens /commerce/logistics/outbound').toBe('/commerce/logistics/outbound');
    });

    await step('Act: Step 2 — Count how many items are new compared with the state before this user story', async () => {
      children = await list.sidebarChildren('물류 관리');
    });

    await step('Assert: Expected 2 — The new entries 재고 관리 and SKU 마스터 관리 sit inside the existing 물류 관리 group', async () => {
      expect(children, '[Expected 2] 재고 관리 is inside 물류 관리').toContain('재고 관리');
      expect(children, '[Expected 2] SKU 마스터 관리 is inside 물류 관리').toContain('SKU 마스터 관리');
    });

    await step('Act: Step 3 — Click 입고 현황 (Incoming status) and confirm the screen loads', async () => {
      await clickMenuItem(list, '입고 현황');
    });

    await step('Assert: Expected 3 — The incoming status screen loads and works', async () => {
      await expect(page, '[Expected 3] 입고 현황 opens /commerce/logistics/inbound').toHaveURL(/\/commerce\/logistics\/inbound(\?|$)/, { timeout: 30_000 });
      await expect(page.getByRole('heading', { level: 4 }), '[Expected 3] The incoming status screen shows its heading').toBeVisible();
      await expect(page.locator('table').first(), '[Expected 3] The incoming status list is shown').toBeVisible({ timeout: 30_000 });
    });

    await step('Act: Step 4 — Click 출고/배송 관리 (Outbound/Shipping management) and confirm the screen loads', async () => {
      await clickMenuItem(list, '출고/배송 관리');
    });

    await step('Assert: Expected 4 — The outbound and shipping management screen loads and works', async () => {
      await expect(page, '[Expected 4] 출고/배송 관리 opens /commerce/logistics/outbound').toHaveURL(/\/commerce\/logistics\/outbound(\?|$)/, { timeout: 30_000 });
      await expect(page.getByRole('heading', { level: 4 }), '[Expected 4] The outbound screen shows its heading').toBeVisible();
      await expect(page.locator('table').first(), '[Expected 4] The outbound list is shown').toBeVisible({ timeout: 30_000 });
    });
  });

  test('TC_US134_420 — The platform shared parts are reused and no new design value is added', async () => {
    await skipTc(
      'TC_US134_420',
      'Medium',
      TAGS,
      'The table wrapper, the status badge, the code link and the sortable header are the platform shared parts, every colour / spacing resolves to a value of the logistics area shared set, and no colour is written in by hand.',
      'This is a source-code / design-token review (which component and which token the screen\'s code uses, hand-written colours in its style file) — the minified production bundle and computed styles cannot tell a shared part from a local copy with the same classes.',
    );
  });

  test('TC_US134_421 — Every call goes to the operator server with the platform session', async ({ page, world, adjustmentDialog, conversionDialog, warehouseDetailDialog, incomingDialog, stockHistoryDialog, skuFormPage }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_421',
      'High',
      TAGS,
      `Search, sort, 재고이력, an adjustment, a conversion (보류재고 지정), a CS managed flag change, an inbound request, a SKU create and 엑셀 다운로드 each send exactly 1 call; every /api call goes to the settlement operator API host (${new URL(env.apiBaseURL).host}) and none to a partner server; every call carries the same platform single sign-on bearer session and no separate credential header. Data: the writes run on the suite's own physical SKU seeded at the automation CJ Incheon Aam warehouse (CS-managed, CS stock 0 so the flag can be switched off); the SKU create is a digital SKU of Demo Partner A, removed at teardown. Token values are compared, never attached.`,
    );
    const list = new StockCalculationPage(page);
    const warehouse = world.warehouses.CJ;
    const sku = await ownPhysicalSku(world, 'TC421');
    const row = list.row(sku.skuCode, warehouse.name);
    const calls = list.captureApiCalls();
    const counts: Record<string, number> = {};
    const kinds: Array<{ name: string; method: string; path: string }> = [
      { name: 'search', method: 'GET', path: '/api/v1/stock-status' },
      { name: 'sort', method: 'GET', path: '/api/v1/stock-status' },
      { name: 'stock history', method: 'GET', path: '/api/v1/stock-usages' },
      { name: 'adjustment', method: 'POST', path: '/api/v1/adjustments' },
      { name: 'conversion', method: 'POST', path: '/api/v1/stocks/conversions' },
      { name: 'CS managed flag', method: 'PATCH', path: '/api/v1/stocks/cs-stock-management' },
      { name: 'inbound request', method: 'POST', path: '/api/v1/incoming' },
      { name: 'SKU create', method: 'POST', path: '/api/v1/skus' },
      { name: 'Excel download', method: 'GET', path: '/api/v1/stock-status/excel' },
    ];
    const measure = async (name: string, action: () => Promise<void>): Promise<void> => {
      const kind = kinds.find((k) => k.name === name);
      const start = calls.length;
      await action();
      counts[name] = calls.slice(start).filter((call) => call.method === kind?.method && new URL(call.url).pathname === kind?.path).length;
    };
    let hosts: string[] = [];
    let auth: string[] = [];

    await step('Arrange: Pre-condition 1–3 — Logged in through the platform SSO; a CS-managed physical stock row exists; the call log is cleared', async () => {
      await world.seedStock(sku, warehouse, { available: 50, csManaged: true });
      await list.open('ko');
      calls.length = 0;
    });

    await step('Act: Step 1 — Run a search, change the sorting and open 재고이력 (Stock history) for the row', async () => {
      await measure('search', () => list.findSku(sku));
      await measure('sort', () => list.chooseSort('UNCONFIRMED_OUTGOING_QUANTITY'));
      await measure('stock history', async () => {
        await list.openHistory(row);
        await stockHistoryDialog.waitOpen('ko');
        await stockHistoryDialog.waitLoaded();
      });
      await stockHistoryDialog.close();
    });

    await step('Assert: Expected 1 — Each action produces 1 call', async () => {
      for (const name of ['search', 'sort', 'stock history']) expect(counts[name], `[Expected 1] The ${name} action sends exactly 1 call`).toBe(1);
    });

    await step('Act: Step 2 — Save an adjustment, a conversion and a CS flag change, save an inbound request, create a SKU and click 엑셀 다운로드', async () => {
      await measure('adjustment', async () => {
        await list.tick(row, sku.skuCode);
        await list.clickToolbar('btn.adjustStock');
        await adjustmentDialog.waitOpen('ko');
        await adjustmentDialog.fillLine(0, { quantity: '1', modifyType: 'ADD', reason: 'ADJUSTMENT' });
        await list.waitForListReload(async () => { await adjustmentDialog.saveAndWait('/api/v1/adjustments'); });
      });
      await measure('conversion', async () => {
        await list.tick(row, sku.skuCode);
        await list.clickToolbar('btn.convertStock');
        await conversionDialog.waitOpen('ko');
        await conversionDialog.choosePolicy('SECURE_HOLD');
        await conversionDialog.fillLine(0, { quantity: '1' });
        await list.waitForListReload(async () => { await conversionDialog.saveAndWait('/api/v1/stocks/conversions'); });
      });
      await measure('CS managed flag', async () => {
        await list.tick(row, sku.skuCode);
        await list.clickToolbar('btn.warehouseDetail');
        await warehouseDetailDialog.waitOpen('ko');
        await warehouseDetailDialog.setManaged(0, false);
        await list.waitForListReload(async () => { await warehouseDetailDialog.saveAndWait('/api/v1/stocks/cs-stock-management'); });
      });
      await measure('inbound request', async () => {
        await list.tick(row, sku.skuCode);
        await list.clickToolbar('btn.incomingRequest');
        await incomingDialog.waitOpen('ko');
        await incomingDialog.chooseWarehouse(warehouse.name);
        await incomingDialog.typeExpectedDate(futureDate(7));
        await incomingDialog.fillLine(0, { supplyPrice: '1000', quantity: '5' });
        await list.waitForListReload(async () => { await incomingDialog.saveAndWait('/api/v1/incoming'); });
      });
      const groupCode = uniqueCode(world.tag, 'TC421D');
      await measure('SKU create', async () => {
        await skuFormPage.openCreate('digital');
        await skuFormPage.bizPartnerSelect.selectOption(String(world.partners.A.id));
        await skuFormPage.skuGroupCodeInput.fill(groupCode);
        await skuFormPage.checkCode();
        await skuFormPage.skuGroupCodeNameInput.fill(ownGroupName(world, 'TC421D'));
        await skuFormPage.saveAndWait();
      });
      await world.trackGroupCode(groupCode);
      await list.open('ko');
      await list.findSku(sku);
      await measure('Excel download', async () => {
        const download = page.waitForEvent('download', { timeout: 60_000 });
        await list.click(list.exportButton, `${stx('btn.exportStockExcel', 'ko')} button`);
        await download;
      });
    });

    await step('Assert: Expected 2 — Each of the 9 kinds of action produces 1 call', async () => {
      for (const kind of kinds) expect(counts[kind.name], `[Expected 2] The ${kind.name} action sends exactly 1 ${kind.method} ${kind.path} call`).toBe(1);
    });

    await step('Act: Step 3 — List which servers each of those calls went to', async () => {
      hosts = [...new Set(calls.map((call) => new URL(call.url).host))];
    });

    await step('Assert: Expected 3 — Every call goes to the settlement operator server and none to the partner server', async () => {
      expect(hosts, '[Expected 3] Every /api call goes to the settlement operator API host').toEqual([new URL(env.apiBaseURL).host]);
      for (const host of hosts) expect(host, `[Expected 3] ${host} is not a partner server`).not.toMatch(/partner/i);
    });

    await step('Act: Step 4 — Read the sign-in part each call carries', async () => {
      auth = calls.map((call) => call.headers.authorization ?? '');
    });

    await step('Assert: Expected 4 — Every call signs in with the platform single sign-on session and not its own credentials', async () => {
      expect(auth.length, '[Expected 4] Calls were captured').toBeGreaterThan(0);
      expect(auth.every((value) => /^Bearer \S+$/.test(value)), '[Expected 4] Every call carries a bearer session').toBe(true);
      expect(new Set(auth).size, '[Expected 4] Every call carries the same platform session').toBe(1);
      const ownCredentials = calls.filter((call) => Object.keys(call.headers).some((name) => /api[-_]?key|x-auth|partner/i.test(name)));
      expect(ownCredentials.length, '[Expected 4] No call carries a separate credential header').toBe(0);
    });
  });

  test('TC_US134_422 — No partner pass or partner id header is carried when a call is sent', async ({ page, world, adjustmentDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_422',
      'High',
      TAGS,
      `Filtering 비즈파트너 = Demo Partner B lists its 5 demo rows; the list call carries no partner header and sends the partner as the bizPartnerIds address parameter; an adjustment save carries no partner header either. Data: the adjustment writes stock, so it is saved on the suite's own physical SKU at the automation CJ Incheon Aam warehouse (not on the shared DEMO-SKU-0001). ${WORLD_NOTE}`,
    );
    const list = new StockCalculationPage(page);
    const sku = await ownPhysicalSku(world, 'TC422');
    const partnerHeader = (headers: Record<string, string>) => Object.keys(headers).filter((name) => /partner/i.test(name));
    let rows = -1;
    let listCall = { url: '', headers: {} as Record<string, string> };
    let saveHeaders: Record<string, string> = {};

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; a physical stock row exists; the call log is cleared', async () => {
      await world.seedStock(sku, world.warehouses.CJ, { available: 30 });
      await list.open('ko');
    });

    await step('Act: Step 1 — Set 비즈파트너 (Biz partner) to Demo Partner B and click 검색 (Search)', async () => {
      await list.pickMulti('bizPartner', world.partners.B.nameKo);
      await list.chooseSearchField('SKU_GROUP_NAME');
      await list.typeKeyword(world.keyword);
      const request = page.waitForRequest((req) => req.url().includes('/api/v1/stock-status?') && req.url().includes('bizPartnerIds='));
      await list.clickSearch();
      const req = await request;
      listCall = { url: req.url(), headers: await req.allHeaders() };
      rows = await list.dataRowCount();
    });

    await step('Assert: Expected 1 — Only the 5 Demo Partner B rows are listed', async () => {
      expect(rows, '[Expected 1] 5 rows are listed').toBe(5);
      for (const key of ['SKU0005', 'SKU0006', 'SKU0010', 'SKU0011', 'SKU0012']) await expect(list.rowBySkuId(world.sku(key).skuId), `[Expected 1] Demo Partner B row ${world.sku(key).skuCode} is listed`).toBeVisible();
    });

    await step('Act: Step 2 — Read the headers of that list call', async () => {
      expect(Object.keys(listCall.headers).length, 'The list call headers are captured').toBeGreaterThan(0);
    });

    await step('Assert: Expected 2 — The call carries no partner pass header and no partner id header', async () => {
      expect(partnerHeader(listCall.headers), '[Expected 2] The list call carries no partner header').toEqual([]);
    });

    await step('Act: Step 3 — Read which way the partner value travels in that call', async () => {
      expect(listCall.url, 'The list call address is captured').toContain('/api/v1/stock-status?');
    });

    await step('Assert: Expected 3 — The partner value travels as a parameter of the address', async () => {
      expect(new URL(listCall.url).searchParams.get('bizPartnerIds'), '[Expected 3] bizPartnerIds carries Demo Partner B').toBe(String(world.partners.B.id));
    });

    await step('Act: Step 4 — Save an adjustment on the row and read that call\'s headers', async () => {
      await list.open('ko');
      await list.findSku(sku);
      const row = list.row(sku.skuCode, world.warehouses.CJ.name);
      await list.tick(row, sku.skuCode);
      await list.clickToolbar('btn.adjustStock');
      await dialog.waitOpen('ko');
      await dialog.fillLine(0, { quantity: '1', modifyType: 'ADD', reason: 'ADJUSTMENT' });
      const request = page.waitForRequest((req) => new URL(req.url()).pathname === '/api/v1/adjustments' && req.method() === 'POST');
      await list.waitForListReload(async () => { await dialog.saveAndWait('/api/v1/adjustments'); });
      saveHeaders = await (await request).allHeaders();
    });

    await step('Assert: Expected 4 — The save call carries neither of those 2 headers', async () => {
      expect(Object.keys(saveHeaders).length, '[Expected 4] The save call headers are captured').toBeGreaterThan(0);
      expect(partnerHeader(saveHeaders), '[Expected 4] The adjustment save carries no partner header').toEqual([]);
    });
  });

  test('TC_US134_423 — The error data carries the word-form code WH-STOCK_NOT_FOUND and its message when a save is rejected', async ({ page, world, adjustmentDialog: dialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_423',
      'Medium',
      TAGS,
      'With 재고 조정 open on a physical stock row, the row is deleted behind the dialog (a DB delete plays the second session); 저장 is rejected and the raw error carries code WH-STOCK_NOT_FOUND (no number) and the message "SKU의 재고가 존재하지 않습니다." with no skuId / warehouseId appended. Data: the deleted row is the suite\'s own physical SKU at the automation CJ Daegu warehouse (CJ Incheon Aam when Daegu cannot be built) — the shared DEMO-SKU-0008 row is not deleted.',
    );
    const list = new StockCalculationPage(page);
    const warehouse = world.warehouses.DAEGU ?? world.warehouses.CJ;
    const sku = await ownPhysicalSku(world, 'TC423');
    const row = list.row(sku.skuCode, warehouse.name);
    let deleted = false;
    let status = 0;
    let body: StockApiError = { status: 0 };

    await step('Arrange: Pre-condition 1–3 — A physical stock row exists; a second session will delete it; the raw error data can be read', async () => {
      await world.seedStock(sku, warehouse, { available: 20 });
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Tick the row, open 재고 조정 (Stock adjustment), then delete that stock row from the second session', async () => {
      await list.tick(row, sku.skuCode);
      await list.clickToolbar('btn.adjustStock');
      await dialog.waitOpen('ko');
      await stockDb.deleteStock(sku.skuId, warehouse.id);
      deleted = (await stockDb.stock(sku.skuId, warehouse.id)) === undefined;
    });

    await step('Assert: Expected 1 — The dialog opens and the row is deleted behind it', async () => {
      await expect(dialog.root, '[Expected 1] The 재고 조정 dialog is open').toBeVisible();
      expect(deleted, '[Expected 1] The stock row is deleted behind the dialog').toBe(true);
    });

    await step('Act: Step 2 — Fill the row, click 저장 (Save) and read the raw error data', async () => {
      await dialog.fillLine(0, { quantity: '1', modifyType: 'ADD', reason: 'ADJUSTMENT' });
      const response = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/v1/adjustments' && res.request().method() === 'POST');
      await dialog.clickSave();
      const res = await response;
      status = res.status();
      body = (await res.json().catch(() => ({ status }))) as StockApiError;
    });

    await step('Assert: Expected 2 — The system rejects the save and the error data can be read', async () => {
      expect(status, '[Expected 2] The save is rejected with a 4xx status').toBeGreaterThanOrEqual(400);
      expect(status, '[Expected 2] The rejection is not a server error').toBeLessThan(500);
      await expect(dialog.errorAlert, '[Expected 2] The dialog shows the rejection').toBeVisible();
    });

    await step('Act: Step 3 — Read the error code field', async () => {
      expect(body, 'The error body is read').toBeTruthy();
    });

    await step('Assert: Expected 3 — The error code field carries WH-STOCK_NOT_FOUND, a name with no number', async () => {
      expect(body.code, '[Expected 3] The error code is WH-STOCK_NOT_FOUND').toBe('WH-STOCK_NOT_FOUND');
      expect(body.code ?? '', '[Expected 3] The error code holds no number').not.toMatch(/\d/);
    });

    await step('Act: Step 4 — Read the message field', async () => {
      expect(body.message ?? body.detail, 'The error body carries a message').toBeDefined();
    });

    await step('Assert: Expected 4 — The message is "SKU의 재고가 존재하지 않습니다." with no skuId or warehouseId appended', async () => {
      const message = body.message ?? body.detail ?? '';
      expect(message, '[Expected 4] The message is the Korean sentence').toBe('SKU의 재고가 존재하지 않습니다.');
      expect(message, '[Expected 4] The message carries no skuId').not.toContain(String(sku.skuId));
      expect(message, '[Expected 4] The message carries no warehouseId').not.toContain(String(warehouse.id));
      expect(message, '[Expected 4] The message is not the bare constant name').not.toBe('STOCK_NOT_FOUND');
    });
  });

  test('TC_US134_424 — The warehouse group is worked out from logistics type and channel, not stored', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_424',
      'Medium',
      TAGS,
      `The warehouse table has no warehouse-group column; 대구분 = CJ 창고 lists the CJ Incheon Aam rows (WMS · CJ_LOGISTICS), 현장 수령지 only the Demo Pickup Point rows (PICKUP_LOCATION · NONE), CJ 대구 창고 only the CJ Daegu warehouse rows (WMS · CJ_LOGISTICS_DT). ${WORLD_NOTE}`,
    );
    daeguOrSkip(world);
    const list = new StockCalculationPage(page);
    const daegu = world.warehouses.DAEGU;
    let columns: string[] = [];
    const listed: Record<string, string[]> = {};
    const demoRows = (name: string) => world.stockRows.filter((r) => /^SKU\d{4}$/.test(r.sku.key) && r.warehouse.name === name);

    const filterBy = async (category: string): Promise<string[]> => {
      await list.chooseWarehouseGroup(category);
      await list.search('SKU_GROUP_NAME', world.keyword);
      return list.columnValues('col.warehouse');
    };

    await step('Arrange: Pre-condition 1–5 — CJ Incheon Aam (WMS · CJ_LOGISTICS), CJ Daegu warehouse (WMS · CJ_LOGISTICS_DT) and Demo Pickup Point (PICKUP_LOCATION · NONE) hold demo rows', async () => {
      expect(demoRows(world.warehouses.CJ.name).length, 'CJ Incheon Aam holds demo rows').toBeGreaterThan(0);
      expect(demoRows(world.warehouses.PICKUP.name).length, 'Demo Pickup Point holds demo rows').toBeGreaterThan(0);
      expect(demoRows(daegu?.name ?? '').length, 'CJ Daegu warehouse holds demo rows').toBeGreaterThan(0);
    });

    await step('Act: Step 1 — Read the warehouse table structure and look for a column storing the warehouse group', async () => {
      columns = (await stockDb.query<RowDataPacket>('SHOW COLUMNS FROM warehouse')).map((column) => String(column.Field));
    });

    await step('Assert: Expected 1 — There is NO column storing the warehouse group', async () => {
      expect(columns, '[Expected 1] The warehouse table has its logistics type and channel columns').toEqual(expect.arrayContaining(['logistics_type', 'logistics_channel_type']));
      expect(columns.filter((name) => /categor|group/i.test(name)), '[Expected 1] No column stores the warehouse group').toEqual([]);
    });

    await step('Act: Step 2 — Open 재고 관리, filter 대구분 (Warehouse group) to CJ 창고 and click 검색 (Search)', async () => {
      await list.open('ko');
      listed.cj = await filterBy('CJ_WAREHOUSE');
    });

    await step('Assert: Expected 2 — The CJ Incheon Aam rows are listed', async () => {
      for (const seed of demoRows(world.warehouses.CJ.name)) await expect(list.row(seed.sku.skuCode, seed.warehouse.name), `[Expected 2] ${seed.sku.skuCode} @ CJ Incheon Aam is listed`).toBeVisible();
    });

    await step('Act: Step 3 — Filter 대구분 (Warehouse group) to 현장 수령지 (Pickup location) and click 검색', async () => {
      listed.pickup = await filterBy('PICKUP_LOCATION');
    });

    await step('Assert: Expected 3 — Only the Demo Pickup Point rows are listed and no CJ Incheon Aam row appears', async () => {
      expect(listed.pickup.length, '[Expected 3] The pickup-location rows are listed').toBe(demoRows(world.warehouses.PICKUP.name).length);
      expect(listed.pickup.every((name) => name === world.warehouses.PICKUP.name), '[Expected 3] Every listed row is in Demo Pickup Point').toBe(true);
      expect(listed.pickup, '[Expected 3] No CJ Incheon Aam row appears').not.toContain(world.warehouses.CJ.name);
    });

    await step('Act: Step 4 — Filter 대구분 (Warehouse group) to CJ 대구 창고 (CJ Daegu warehouse) and click 검색', async () => {
      listed.daegu = await filterBy('CJ_DAEGU_WAREHOUSE');
    });

    await step('Assert: Expected 4 — Only the CJ Daegu warehouse rows are listed', async () => {
      expect(listed.daegu.length, '[Expected 4] The CJ Daegu warehouse rows are listed').toBe(demoRows(daegu?.name ?? '').length);
      expect(listed.daegu.every((name) => name === daegu?.name), '[Expected 4] Every listed row is in CJ Daegu warehouse').toBe(true);
    });
  });

  test('TC_US134_425 — A warehouse matching no group is treated as badly set up, not ungrouped', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_425',
      'Medium',
      TAGS,
      '대구분 offers 전체 + the 5 groups and no sixth group; a stock row in a warehouse with logistics type STORE and channel CJ_LOGISTICS shows in none of the 5 groups; 창고별 상세 on that row is blocked with the CJ-warehouse sentence. Data: the badly set-up warehouse is a store warehouse the test creates; its channel is set to CJ_LOGISTICS in the warehouse table because the US069 screen does not allow that pair; the stock row is the suite\'s own physical SKU.',
    );
    const list = new StockCalculationPage(page);
    const store = await world.createWarehouse('WH425 Store', 'PLATFORM_STORE');
    const sku = await ownPhysicalSku(world, 'TC425');
    const row = list.row(sku.skuCode);
    let options: string[] = [];
    const foundIn: Record<string, number> = {};
    let guard = '';

    await step('Arrange: Pre-condition 1–3 — A warehouse with logistics type STORE and channel CJ_LOGISTICS holds a stock row', async () => {
      await stockDb.exec("UPDATE warehouse SET logistics_channel_type = 'CJ_LOGISTICS' WHERE id = ?", [store.id]);
      await world.seedStock(sku, asWorldWarehouse(store), { available: 10 });
      const [stored] = await stockDb.query<RowDataPacket>('SELECT logistics_type, logistics_channel_type FROM warehouse WHERE id = ?', [store.id]);
      expect(stored, 'The warehouse holds logistics type STORE and channel CJ_LOGISTICS').toMatchObject({ logistics_type: 'STORE', logistics_channel_type: 'CJ_LOGISTICS' });
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management) and open the 대구분 (Warehouse group) dropdown', async () => {
      await list.open('ko');
      options = await list.warehouseGroupOptions();
    });

    await step('Assert: Expected 1 — The dropdown opens with All plus the 5 groups', async () => {
      expect(options[0], '[Expected 1] The first choice is 전체 (All)').toBe(stx('filter.all', 'ko'));
      for (const category of WAREHOUSE_CATEGORY_ORDER) expect(options, `[Expected 1] 대구분 offers ${WAREHOUSE_CATEGORY_TEXT[category].ko}`).toContain(WAREHOUSE_CATEGORY_TEXT[category].ko);
    });

    await step('Act: Step 2 — Look for a sixth group such as Ungrouped or Other', async () => {
      options = await list.warehouseGroupOptions();
    });

    await step('Assert: Expected 2 — There is no sixth group', async () => {
      expect(options.length, '[Expected 2] 대구분 holds exactly 전체 + 5 groups').toBe(6);
    });

    await step('Act: Step 3 — Filter through all 5 groups and see whether the row shows in any of them', async () => {
      for (const category of WAREHOUSE_CATEGORY_ORDER) {
        await list.chooseWarehouseGroup(category);
        await list.findSku(sku);
        foundIn[category] = await row.count();
      }
    });

    await step('Assert: Expected 3 — That row shows in no group at all', async () => {
      for (const category of WAREHOUSE_CATEGORY_ORDER) expect(foundIn[category], `[Expected 3] The row is not listed under ${WAREHOUSE_CATEGORY_TEXT[category].ko}`).toBe(0);
    });

    await step('Act: Step 4 — Tick that row and click 창고별 상세 (Per-warehouse detail)', async () => {
      await list.chooseWarehouseGroup('');
      await list.findSku(sku);
      await list.tick(row, sku.skuCode);
      guard = await list.guardTextAfter('btn.warehouseDetail');
    });

    await step('Assert: Expected 4 — The action is blocked with the CJ-warehouse sentence', async () => {
      expect(guard, '[Expected 4] 창고별 상세 is blocked with the CJ-warehouse sentence').toBe('선택한 SKU 중 CJ창고가 아닌 항목이 포함되어 있습니다. CJ창고 SKU만 선택해 주세요.');
    });
  });

  test('TC_US134_426 — The defective warehouse row adds up writes from US105 and from stock conversion', async () => {
    await skipTc('TC_US134_426', 'Medium', TAGS, 'US105 writes 5 damaged units of DEMO-SKU-0001 into the DEFECTIVE warehouse, then 불량 처리 (보류재고 → 불량) of 5 from this screen adds to the same row (on hold 10, no duplicate row) and 재고이력 shows both +5 movements.', US105_REASON);
  });

  test('TC_US134_427 — The 3 order-derived columns run on the interim mock until the commerce order API is available', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_427',
      'High',
      TAGS,
      `DEMO-SKU-0003 @ CJ Daegu warehouse shows numbers in 할당대기재고, 주문가능수량 and 재고부족수량 (interim mock values, not compared with order data); the list call succeeds without a 500. Not automated: Steps 3–4 (250 / 0 / 50 matching the order data once BRZ-14801 is deployed and the mock removed) are Blocked in the TC file until BRZ-14801 — the list is reloaded and the cells are attached for the record. ${WORLD_NOTE}`,
    );
    daeguOrSkip(world);
    const list = new StockCalculationPage(page);
    const third = world.row('SKU0003', world.warehouses.DAEGU ?? undefined);
    const row = list.row(third.sku.skuCode, third.warehouse.name);
    const columns = ['col.pendingAllocationQuantity', 'col.orderableQuantity', 'col.insufficientQuantity'] as const;
    let cells: string[] = [];
    let listStatus = 0;

    const readCells = async (): Promise<string[]> => {
      const values: string[] = [];
      for (const column of columns) values.push(await list.cellText(row, column));
      return values;
    };

    await step('Arrange: Pre-condition 1–4 — DEMO-SKU-0003 exists in CJ Daegu warehouse; BRZ-14801 is not available; the Network tab is open', async () => {
      expect(third.buckets.available, 'DEMO-SKU-0003 @ CJ Daegu warehouse holds available 200').toBe(200);
    });

    await step('Act: Step 1 — Open 재고 관리 and read 할당대기재고, 주문가능수량 and 재고부족수량 on DEMO-SKU-0003', async () => {
      const response = page.waitForResponse((res) => res.url().includes('/api/v1/stock-status?') && new URL(res.url()).searchParams.get('keyword') === world.keyword, { timeout: 30_000 });
      await list.openWorld(world);
      listStatus = (await response).status();
      cells = await readCells();
    });

    await step('Assert: Expected 1 — The list renders and all 3 columns show numbers', async () => {
      columns.forEach((column, index) => {
        expect(cells[index], `[Expected 1] ${stx(column, 'ko')} shows a number`).toMatch(/^\d[\d,]*$/);
      });
    });

    await step('Act: Step 2 — Read the stock list call in the Network tab', async () => {
      expect(listStatus, 'The list call status is captured').toBeGreaterThan(0);
    });

    await step('Assert: Expected 2 — The list call succeeds and returns no 500', async () => {
      expect(listStatus, '[Expected 2] The stock list call succeeds').toBe(200);
    });

    await step('Act: Step 3 — Reload the list and read the same 3 columns (BRZ-14801 not deployed yet)', async () => {
      await list.clickSearch();
      cells = await readCells();
      await test.info().attach('Order-derived cells of DEMO-SKU-0003 (mock)', { body: JSON.stringify(Object.fromEntries(columns.map((c, i) => [c, cells[i]])), null, 2), contentType: 'application/json' });
    });

    await step('Assert: Expected 3 — The 3 columns show 250, 0 and 50 (Blocked until BRZ-14801 — not automated)', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Expected 3 is Blocked until KakaoEnt BRZ-14801 replaces the interim mock.' });
    });

    await step('Act: Step 4 — Compare the values of step 3 with the source order data (Blocked until BRZ-14801)', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Step 4 needs the commerce order data of BRZ-14801.' });
    });

    await step('Assert: Expected 4 — The values match the order data and are not all 0 (Blocked until BRZ-14801 — not automated)', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Expected 4 is Blocked until KakaoEnt BRZ-14801 is on the test environment.' });
    });
  });

  test('TC_US134_428 — The server enforces the five guards the screen applies client-side', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_428',
      'Critical',
      TAGS,
      'Sent around the screen: an inbound request naming a MIXED SKU, the 4 writes naming a soft-deleted SKU, an inbound request into a PLATFORM warehouse of another biz partner, a physical SKU create with another partner\'s manufacturer, an edit of a saved set\'s components / quantities and a conversion (SECURE_HOLD) + CS flag call naming a MIXED SKU are each turned down with the TC code and message (ids substituted). Data: every SKU, the set, the partner-B warehouse and the soft-deleted SKU are created by the test (Demo Partner A / B are the world partners). The conversion / CS-flag doors of the deleted-SKU guard may need the GetSkuIn port (TC note) — they are asserted as written; a failure there is to be recorded as Blocked, not as a defect.',
    );
    const list = new StockCalculationPage(page);
    const cj = world.warehouses.CJ;
    const results: Record<string, { status: number; code: string; message: string }> = {};
    const ids = { first: 0, set: 0, deleted: 0, groupId: 0, warehouseB: 0 };
    const created = { physicalCode: '' };
    let leftover = -1;

    await step('Arrange: Pre-condition 1–3 — A MIXED SKU, a soft-deleted SKU, a partner-B PLATFORM warehouse, a partner-B manufacturer and a saved set exist', async () => {
      const first = await ownPhysicalSku(world, 'TC428A');
      const second = await ownPhysicalSku(world, 'TC428B', world.manufacturers.M2);
      const set = await world.createSetSku('TC428S', world.partners.A, [{ sku: first, quantity: 1 }, { sku: second, quantity: 1 }], ownGroupName(world, 'TC428S'));
      const deleted = await ownPhysicalSku(world, 'TC428D');
      await world.seedStock(deleted, cj, { available: 10, csManaged: true });
      await stockDb.softDeleteSku(deleted.skuId);
      const warehouseB = await world.createWarehouse('WH428 B', 'PLATFORM_GENERAL', { bizPartnerId: String(world.partners.B.id) });
      ids.first = first.skuId;
      ids.set = set.skuId;
      ids.deleted = deleted.skuId;
      ids.groupId = set.groupId;
      ids.warehouseB = warehouseB.id;
      await list.open('ko');
    });

    const inbound = (warehouseId: number, skuId: number) => ({ warehouseId, requestDate: futureDate(7), type: 'PURCHASE_ORDER' as const, manufacturerId: world.manufacturers.M1.id, items: [{ skuId, quantity: 1, purchasePrice: { amount: 1000 } }] });

    await step('Act: Step 1 — POST an inbound request whose SKU id is the MIXED SKU', async () => {
      results.mixedInbound = errorOf(await stockApi.createIncoming(inbound(cj.id, ids.set)));
    });

    await step('Assert: Expected 1 — The call is turned down with WH-SKU_NOT_SHIPPABLE and its message', async () => {
      const r = results.mixedInbound;
      expect(r.status, '[Expected 1] The inbound request is not accepted (a 201 is a FAIL)').toBeGreaterThanOrEqual(400);
      expect(r.code, '[Expected 1] The code is WH-SKU_NOT_SHIPPABLE').toBe('WH-SKU_NOT_SHIPPABLE');
      expect(r.message, '[Expected 1] The message is 재고로 관리되는 SKU가 아닙니다. - skuIds: …').toContain('재고로 관리되는 SKU가 아닙니다. - skuIds: ');
      expect(r.message, '[Expected 1] The message names the MIXED SKU id').toContain(String(ids.set));
    });

    await step('Act: Step 2 — Send an adjustment, an inbound, a conversion and a CS-flag call, each naming the soft-deleted SKU', async () => {
      results.deletedAdjustment = errorOf(await stockApi.createAdjustments({ items: [{ skuId: ids.deleted, warehouseId: cj.id, adjustingQuantity: 1, modifyType: 'ADD', reason: 'ADJUSTMENT' }] }));
      results.deletedInbound = errorOf(await stockApi.createIncoming(inbound(cj.id, ids.deleted)));
      results.deletedConversion = errorOf(await stockApi.convert({ policy: 'SECURE_HOLD', items: [{ skuId: ids.deleted, warehouseId: cj.id, quantity: 1 }] }));
      results.deletedCsFlag = errorOf(await stockApi.setCsManagement({ items: [{ skuId: ids.deleted, warehouseId: cj.id, managed: false }] }));
    });

    await step('Assert: Expected 2 — All 4 are turned down with WH-SKU_NOT_FOUND and 삭제된 SKU 입니다. - skuId: {skuId}', async () => {
      for (const name of ['deletedAdjustment', 'deletedInbound', 'deletedConversion', 'deletedCsFlag']) {
        const r = results[name];
        expect(r.status, `[Expected 2] The ${name} call is turned down`).toBeGreaterThanOrEqual(400);
        expect(r.code, `[Expected 2] The ${name} call returns WH-SKU_NOT_FOUND`).toBe('WH-SKU_NOT_FOUND');
        expect(r.message, `[Expected 2] The ${name} message is 삭제된 SKU 입니다. - skuId: ${ids.deleted}`).toBe(`삭제된 SKU 입니다. - skuId: ${ids.deleted}`);
      }
    });

    await step('Act: Step 3 — POST an operator inbound request into the PLATFORM warehouse of biz partner B with SKUs of biz partner A', async () => {
      results.partnerMismatch = errorOf(await stockApi.createIncoming(inbound(ids.warehouseB, ids.first)));
    });

    await step('Assert: Expected 3 — The call is turned down with WH-WAREHOUSE_BIZ_PARTNER_MISMATCH and its message', async () => {
      const r = results.partnerMismatch;
      expect(r.status, '[Expected 3] The inbound request is turned down').toBeGreaterThanOrEqual(400);
      expect(r.code, '[Expected 3] The code is WH-WAREHOUSE_BIZ_PARTNER_MISMATCH').toBe('WH-WAREHOUSE_BIZ_PARTNER_MISMATCH');
      expect(r.message, '[Expected 3] The message states the biz partners differ').toContain('SKU의 비즈파트너와 창고의 비즈파트너가 다릅니다.');
      expect(r.message, '[Expected 3] The message names the warehouse id').toContain(`warehouseId: ${ids.warehouseB}`);
    });

    await step('Act: Step 4 — Send a physical SKU create for Demo Partner A naming a manufacturer of Demo Partner B', async () => {
      created.physicalCode = uniqueCode(world.tag, 'TC428M');
      const skuCode = uniqueCode(world.tag, 'TC428MS');
      results.manufacturerMismatch = errorOf(
        await stockApi.createSku({
          type: 'PHYSICAL',
          bizPartnerId: world.partners.A.id,
          group: { code: created.physicalCode, name: ownGroupName(world, 'TC428M') },
          usageType: 'MAIN',
          price: 12000,
          skus: [{ name: '', skuCode, exportSkuName: exportName(skuCode), barcode: uniqueCode(world.tag, 'TC428MB') }],
          weight: 250,
          width: 100,
          length: 80,
          height: 30,
          hsCode: uniqueHsCode(),
          description: 'Automation SKU',
          manufacturerId: world.manufacturers.MB.id,
          countryOfOrigin: 'KR',
        }),
      );
      await world.trackGroupCode(created.physicalCode);
      leftover = (await stockApi.skus({ searchType: 'SKU_GROUP_CODE', keyword: created.physicalCode })).body.items.filter((item) => item.skuGroupCode === created.physicalCode).length;
    });

    await step('Assert: Expected 4 — The call is turned down with WH-MANUFACTURER_BIZ_PARTNER_MISMATCH and no SKU is created', async () => {
      const r = results.manufacturerMismatch;
      expect(r.status, '[Expected 4] The SKU create is turned down').toBeGreaterThanOrEqual(400);
      expect(r.code, '[Expected 4] The code is WH-MANUFACTURER_BIZ_PARTNER_MISMATCH').toBe('WH-MANUFACTURER_BIZ_PARTNER_MISMATCH');
      expect(r.message, '[Expected 4] The message states the manufacturer is not the partner\'s').toContain('선택한 비즈파트너의 제조사가 아닙니다.');
      expect(r.message, '[Expected 4] The message names the manufacturer id').toContain(`manufacturerId: ${world.manufacturers.MB.id}`);
      expect(leftover, '[Expected 4] No SKU is created').toBe(0);
    });

    await step('Act: Step 5 — Edit the saved set SKU group with a different component list and different quantities', async () => {
      const extra = await ownPhysicalSku(world, 'TC428C');
      results.setEdit = errorOf(
        await stockApi.updateSku(ids.groupId, {
          type: 'MIXED',
          groupName: ownGroupName(world, 'TC428S'),
          bundles: [{ skuId: ids.first, quantity: 2 }, { skuId: extra.skuId, quantity: 1 }],
        }),
      );
    });

    await step('Assert: Expected 5 — The call is turned down with WH-SKU_IMMUTABLE_FIELD and its message', async () => {
      const r = results.setEdit;
      expect(r.status, '[Expected 5] The set edit is turned down').toBeGreaterThanOrEqual(400);
      expect(r.code, '[Expected 5] The code is WH-SKU_IMMUTABLE_FIELD').toBe('WH-SKU_IMMUTABLE_FIELD');
      expect(r.message, '[Expected 5] The message states set components cannot be changed').toContain('SET 구성은 수정 시 추가하거나 수량을 변경할 수 없습니다.');
      expect(r.message, '[Expected 5] The message names the SKU group id').toContain(`skuGroupId: ${ids.groupId}`);
    });

    await step('Act: Step 6 — Send a conversion call (policy SECURE_HOLD) and a CS-flag call, each naming the MIXED SKU', async () => {
      results.mixedConversion = errorOf(await stockApi.convert({ policy: 'SECURE_HOLD', items: [{ skuId: ids.set, warehouseId: cj.id, quantity: 1 }] }));
      results.mixedCsFlag = errorOf(await stockApi.setCsManagement({ items: [{ skuId: ids.set, warehouseId: cj.id, managed: true }] }));
    });

    await step('Assert: Expected 6 — Both are turned down with WH-SKU_NOT_SHIPPABLE and the same message as step 1', async () => {
      for (const name of ['mixedConversion', 'mixedCsFlag']) {
        const r = results[name];
        expect(r.status, `[Expected 6] The ${name} call is turned down`).toBeGreaterThanOrEqual(400);
        expect(r.code, `[Expected 6] The ${name} call returns WH-SKU_NOT_SHIPPABLE`).toBe('WH-SKU_NOT_SHIPPABLE');
        expect(r.message, `[Expected 6] The ${name} message is 재고로 관리되는 SKU가 아닙니다. - skuIds: …`).toContain('재고로 관리되는 SKU가 아닙니다. - skuIds: ');
        expect(r.message, `[Expected 6] The ${name} message names the MIXED SKU id`).toContain(String(ids.set));
      }
    });
  });

  test('TC_US134_429 — The server refuses an adjustment or a conversion on a pending-revenue or in-transit row from every door', async ({ page, world, stockApi, stockHistoryDialog: history }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_429',
      'High',
      TAGS,
      'An API adjustment on a PENDING_REVENUE row and an API conversion (SECURE_HOLD 5) on an IN_TRANSIT row are rejected with WH-WAREHOUSE_VIRTUAL_NOT_MODIFIABLE "매출대기 또는 이동중 재고는 시스템만 변경할 수 있습니다."; a 재고 조정 업로드 workbook naming the IN_TRANSIT row is rejected as a whole and the alert shows the server message; both rows keep 가용재고 10 / 보류재고 10 and get no new movement. Data: the 2 virtual rows are DB fixtures on the suite\'s own physical SKU in the 매출대기 / 이동중 buckets of the automation CJ Incheon Aam warehouse. Workbook header row as written in the TC: SKU 코드 · 창고 ID · 조정수량 · 증가(P)/차감(M) · 조정사유코드 · 비고.',
    );
    const list = new StockCalculationPage(page);
    const pending = world.bucket(world.warehouses.CJ, '매출대기');
    const transit = world.bucket(world.warehouses.CJ, '이동중');
    const sku = await ownPhysicalSku(world, 'TC429');
    const message = '매출대기 또는 이동중 재고는 시스템만 변경할 수 있습니다.';
    let adjust = { status: 0, code: '', message: '' };
    let convert = { status: 0, code: '', message: '' };
    let upload = { status: 0, message: '' };
    const after: Array<{ name: string; available: string; hold: number; usages: number; historyEmpty: boolean }> = [];

    await step('Arrange: Pre-condition 1–4 — Own SKU rows in the PENDING_REVENUE and IN_TRANSIT warehouses with available 10 and on hold 10; an adjustment workbook naming the IN_TRANSIT row', async () => {
      await stockDb.upsertStock(sku.skuId, pending.id, { available: 10, hold: 10 });
      await stockDb.upsertStock(sku.skuId, transit.id, { available: 10, hold: 10 });
      await list.open('ko');
    });

    await step('Act: Step 1 — Send an adjustment call (increase 5) for the PENDING_REVENUE row', async () => {
      adjust = errorOf(await stockApi.createAdjustments({ items: [{ skuId: sku.skuId, warehouseId: pending.id, adjustingQuantity: 5, modifyType: 'ADD', reason: 'ADJUSTMENT' }] }));
    });

    await step('Assert: Expected 1 — The call is rejected with WH-WAREHOUSE_VIRTUAL_NOT_MODIFIABLE and its message', async () => {
      expect(adjust.status, '[Expected 1] The adjustment call is rejected').toBeGreaterThanOrEqual(400);
      expect(adjust.code, '[Expected 1] The code is WH-WAREHOUSE_VIRTUAL_NOT_MODIFIABLE').toBe('WH-WAREHOUSE_VIRTUAL_NOT_MODIFIABLE');
      expect(adjust.message, '[Expected 1] The message is the system-only sentence').toBe(message);
    });

    await step('Act: Step 2 — Send a conversion call with policy SECURE_HOLD and quantity 5 for the IN_TRANSIT row', async () => {
      convert = errorOf(await stockApi.convert({ policy: 'SECURE_HOLD', items: [{ skuId: sku.skuId, warehouseId: transit.id, quantity: 5 }] }));
    });

    await step('Assert: Expected 2 — The call is rejected with the same code and message', async () => {
      expect(convert.status, '[Expected 2] The conversion call is rejected').toBeGreaterThanOrEqual(400);
      expect(convert.code, '[Expected 2] The code is WH-WAREHOUSE_VIRTUAL_NOT_MODIFIABLE').toBe('WH-WAREHOUSE_VIRTUAL_NOT_MODIFIABLE');
      expect(convert.message, '[Expected 2] The message is the system-only sentence').toBe(message);
    });

    await step('Act: Step 3 — Upload the workbook with 재고 조정 업로드 (Upload stock adjustment)', async () => {
      const file = xlsxFile(`stock-adjustment-${sku.skuCode}.xlsx`, [
        ['SKU 코드', '창고 ID', '조정수량', '증가(P)/차감(M)', '조정사유코드', '비고'],
        [sku.skuCode, String(transit.id), 5, 'P', 'ADJUSTMENT', null],
      ]);
      const response = page.waitForResponse((res) => res.url().includes('/api/v1/adjustments/upload-excel'), { timeout: 120_000 });
      await list.uploadVia('adjustment', file);
      const res = await response;
      const body = (await res.json().catch(() => ({}))) as StockApiError;
      upload = { status: res.status(), message: body.message ?? body.detail ?? '' };
    });

    await step('Assert: Expected 3 — The whole workbook is rejected, the alert shows the server message and no adjustment is created', async () => {
      expect(upload.status, '[Expected 3] The workbook upload is rejected').toBeGreaterThanOrEqual(400);
      expect(upload.message, '[Expected 3] The server answers with the system-only sentence').toContain(message);
      await expect(page.locator('.alert-danger, .toast-container .toast').filter({ hasText: message }).first(), '[Expected 3] The alert shows the server message').toBeVisible();
      expect(await stockDb.adjustments(sku.skuId), '[Expected 3] No adjustment is created').toHaveLength(0);
    });

    await step('Act: Step 4 — Read both rows on the list and open their 재고이력 (Stock history)', async () => {
      await list.findSku(sku);
      for (const bucket of [pending, transit]) {
        const row = list.row(sku.skuCode, bucket.name);
        const available = (await row.count()) > 0 ? await list.cellText(row, 'col.availableQuantity') : '<row not listed>';
        let historyEmpty = false;
        if ((await row.count()) > 0) {
          await list.openHistory(row);
          await history.waitOpen('ko');
          await history.waitLoaded();
          historyEmpty = (await history.rows.filter({ hasText: stx('empty.noResults', 'ko') }).count()) === 1;
          await history.close();
        }
        after.push({ name: bucket.name, available, hold: (await stockDb.stock(sku.skuId, bucket.id))?.hold_quantity ?? -1, usages: (await stockDb.usages(sku.skuId, bucket.id)).length, historyEmpty });
      }
    });

    await step('Assert: Expected 4 — Both rows still read 가용재고 10 and 보류재고 10, and no new movement appears', async () => {
      for (const row of after) {
        expect(row.available, `[Expected 4] 가용재고 of the ${row.name} row is still 10`).toBe('10');
        expect(row.hold, `[Expected 4] 보류재고 of the ${row.name} row is still 10`).toBe(10);
        expect(row.usages, `[Expected 4] The ${row.name} row has no stored movement`).toBe(0);
        expect(row.historyEmpty, `[Expected 4] 재고이력 of the ${row.name} row shows no movement`).toBe(true);
      }
    });
  });

  test('TC_US134_430 — The inbound gate does not refuse the damaged-quantity posting US105 raises into the defective warehouse', async () => {
    await skipTc('TC_US134_430', 'Critical', TAGS, 'A US105 goods receipt with a damaged quantity of 5 for DEMO-SKU-0001 creates an inbound row into the DEFECTIVE warehouse without WH-WAREHOUSE_BIZ_PARTNER_MISMATCH, twice in a row; the damaged quantity lands on the DEFECTIVE row.', US105_REASON);
  });

  test('TC_US134_431 — The inbound gate does not refuse a fully consigned line received into a Berriz-run warehouse', async () => {
    await skipTc('TC_US134_431', 'High', TAGS, 'A US105 전체위탁 (fully consigned) receipt of Demo Partner A into CJ Incheon Aam is accepted without WH-WAREHOUSE_BIZ_PARTNER_MISMATCH and the stock row carries the received quantity.', US105_REASON);
  });

  test('TC_US134_432 — No stored quantity is recomputed when this story\'s migration runs', async () => {
    await skipTc('TC_US134_432', 'High', TAGS, 'Running this story\'s migrations leaves every stored quantity and the warehouse id of DEMO-SKU-0001 @ CJ Incheon Aam unchanged, adds exactly 4 schema changes, and 전체재고 still shows 190.', 'Needs a database from before this story\'s migrations and the right to run / deploy migrations — the shared dev schema has already run them and the suite must not change schema.');
  });

  test('TC_US134_433 — KakaoEnt V52 raises physical stock by the on-hold stock once and leaves total stock unchanged', async () => {
    await skipTc('TC_US134_433', 'High', TAGS, 'On a schema before V52, deploying the build raises physical of DEMO-SKU-0001 from 120 to 130 (hold 10) once, Total stock stays 130 / 14, a +1 adjustment then reads 130 → 131 and V52 appears once in the Flyway history.', 'Needs a test schema before V52 (never migrated, or reset) and a build deployment that runs Flyway — the shared dev environment has already run V52 and the suite cannot deploy.');
  });
});
