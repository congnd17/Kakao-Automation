import type { Locator } from '@playwright/test';
import { test, expect } from '@fixtures/stock.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { stx } from '@utils/stock.i18n';
import { WORLD_NOTE, stockTags } from '@utils/stock-spec';
import type { StockWorld, WorldSku, WorldWarehouse } from '@utils/stock.data';
import { stockDb } from '@utils/stock-db';
import type { ApiResult } from '@api/payment-method-policy.api';
import { ownGroupName, ownPhysicalSku, squash } from '@pages/stock-calculation.page';
import { errorOf } from '@pages/stock-inbound.page';
import {
  CsSave,
  StockWarehouseDetailPage,
  bulkPhysicalSkus,
  deleteReservation,
  openCsReservations,
  releasedCsRow,
  seedCsReservation,
  storedManaged,
} from '@pages/stock-warehouse-detail.page';

/**
 * US134 — nhóm [Warehouse Detail] (TC_US134_273–295): dialog 창고별 상세 + cờ CS재고 관리여부 (PATCH
 * /stocks/cs-stock-management). Steps N / Expected N → `Act: Step N` / `Assert: Expected N`. Mọi lần lưu cờ CS chạy trên
 * SKU riêng của test trong kho automation (CJ Incheon Aam / CJ Daegu / Demo Pickup Point); dòng world chỉ được đọc.
 */
const TAGS = stockTags('warehouse-detail');
const KO = (key: Parameters<typeof stx>[0]) => stx(key, 'ko');
const NOT_MANAGED = KO('label.notManaged');
const SAVED = KO('msg.saved');
const NON_CJ_GUARD = squash(KO('guard.nonCjWarehouse'));
const RESERVED_MESSAGE = '진행 중인 CS 재배송 출고가 없을 경우에만 CS재고 관리안함으로 수정이 가능합니다.';
const OWN_NOTE =
  'Data: the CS flag is written, so the test builds its own physical SKU(s) named "<label> run <tag>" in the automation copies of the TC warehouses and maps the TC DEMO-SKU rows onto them; the shared demo rows are only read.';
const RELEASE_NOTE = 'The pre-condition release of CS stock is done with a real 재고 전환 RELEASE_CS call (DB fixture fallback when the call is refused).';

type CsItem = { skuId: number; warehouseId: number; managed: boolean };

/** Một SKU riêng nhiều dòng (option A, B, …) của Partner A, tên nhóm `ownGroupName`. */
async function ownSkus(world: StockWorld, label: string, count: number): Promise<WorldSku[]> {
  const lines = Array.from({ length: count }, (_, index) => ({ option: String.fromCharCode(65 + index) }));
  return world.createPhysicalSku(label, { partner: world.partners.A, manufacturer: world.manufacturers.M1, groupName: ownGroupName(world, label), lines });
}

/** Mở list và lọc về nhóm SKU riêng của test. */
async function showOwn(wd: StockWarehouseDetailPage, world: StockWorld, label: string): Promise<void> {
  await wd.open();
  await wd.search('SKU_GROUP_NAME', ownGroupName(world, label));
}

function item(sku: WorldSku, warehouse: WorldWarehouse | { id: number }, managed: boolean): CsItem {
  return { skuId: sku.skuId, warehouseId: warehouse.id, managed };
}

test.describe('[Warehouse Detail] Stock management — per-warehouse detail and the CS managed flag', () => {
  test('TC_US134_273 — A successful save shows the saved message and clears every tick', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    const wd = new StockWarehouseDetailPage(page);
    const label = 'WD273';
    const cj = world.warehouses.CJ;
    await tcMeta(
      'TC_US134_273',
      'Critical',
      TAGS,
      `A CS-managed row with CS stock 0 (after releasing its 5 CS units) is switched to 관리안함 in 창고별 상세 and saved: the dialog closes, the message reads ${SAVED}, no row stays ticked and the CS재고(가용재고) cell of the reloaded list reads ${NOT_MANAGED}. ${RELEASE_NOTE} ${OWN_NOTE}`,
    );
    let sku!: WorldSku;
    let save!: CsSave;

    await step('Arrange: Pre-condition 1–2 — Own SKU in CJ Incheon Aam, CS managed, its 5 CS units released so CS stock reads 0', async () => {
      sku = await ownPhysicalSku(world, label);
      await releasedCsRow(world, stockApi, sku, cj, { available: 10, cs: 5 });
      expect(await storedManaged(sku.skuId, cj.id), 'The own row is CS managed').toBe(true);
      await showOwn(wd, world, label);
    });

    await step('Act: Step 1 — Tick the row and click 창고별 상세 (Per-warehouse detail)', async () => {
      await wd.openDetail([wd.row(sku.skuCode, cj.name)]);
    });

    await step('Assert: Expected 1 — The dialog opens with 1 row', async () => {
      await expect(wd.detail.root, '[Expected 1] The 창고별 상세 dialog is open').toBeVisible();
      await expect(wd.detail.rows, '[Expected 1] The dialog has exactly 1 row').toHaveCount(1);
    });

    await step('Act: Step 2 — Set CS재고 관리여부 (CS stock managed) to 관리안함 (Not managed) and click 저장 (Save)', async () => {
      await wd.setManaged(0, false);
      save = await wd.saveDetail();
    });

    await step('Assert: Expected 2 — The save finishes and the dialog closes', async () => {
      expect(save.status, `[Expected 2] The save call is accepted (got ${save.status} ${save.code} ${save.message})`).toBeLessThan(300);
      await expect(wd.detail.root, '[Expected 2] The dialog closes').toHaveCount(0);
    });

    await step('Act: Step 3 — Read the message that appears word by word', async () => {
      await expect(wd.lastToast(), 'A message appears after the save').toBeVisible();
    });

    await step(`Assert: Expected 3 — The message shows "${SAVED} (Saved.)"`, async () => {
      await expect(wd.lastToast(), `[Expected 3] The message reads ${SAVED}`).toContainText(SAVED);
    });

    let csCell = '';
    await step('Act: Step 4 — Read the tick boxes and the CS재고(가용재고) (CS stock — available) cell on the reloaded list', async () => {
      csCell = await wd.cellText(wd.row(sku.skuCode, cj.name), 'col.csQuantity');
    });

    await step(`Assert: Expected 4 — No tick box is selected and that cell now shows ${NOT_MANAGED} (Not managed)`, async () => {
      await expect(wd.tickedBoxes, '[Expected 4] No tick box is selected on the list').toHaveCount(0);
      expect(csCell, `[Expected 4] The CS재고(가용재고) cell reads ${NOT_MANAGED}`).toBe(NOT_MANAGED);
    });
  });

  test('TC_US134_274 — Switching the flag off goes through when CS stock is 0 even with available and total stock above 0', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    const wd = new StockWarehouseDetailPage(page);
    const label = 'WD274';
    const cj = world.warehouses.CJ;
    await tcMeta(
      'TC_US134_274',
      'High',
      TAGS,
      `A CS-managed row with CS stock 0 (its 5 CS units released back into available) but 가용재고 and 전체재고 above 0 is switched to 관리안함: the dialog shows 0 in CS재고(가용재고), the radio takes the change, the save goes through with ${SAVED}, and both CS columns of the reloaded list read ${NOT_MANAGED}. ${RELEASE_NOTE} ${OWN_NOTE}`,
    );
    let sku!: WorldSku;
    let csInDialog = '';
    let save!: CsSave;
    let available = '';
    let total = '';

    await step('Arrange: Pre-condition 1–3 — Own SKU in CJ Incheon Aam, CS managed with CS stock 0 after the release, available and total above 0, no CS re-delivery', async () => {
      sku = await ownPhysicalSku(world, label);
      await releasedCsRow(world, stockApi, sku, cj, { available: 20, cs: 5 });
      expect(await openCsReservations(sku.skuId), 'The SKU has no open CS re-delivery outbound').toBe(0);
      await showOwn(wd, world, label);
      const row = wd.row(sku.skuCode, cj.name);
      available = await wd.cellText(row, 'col.availableQuantity');
      total = await wd.cellText(row, 'col.totalQuantity');
    });

    await step('Act: Step 1 — Tick the row and click 창고별 상세 (Per-warehouse detail)', async () => {
      await wd.openDetail([wd.row(sku.skuCode, cj.name)]);
    });

    await step('Assert: Expected 1 — The dialog opens with 1 row', async () => {
      await expect(wd.detail.root, '[Expected 1] The 창고별 상세 dialog is open').toBeVisible();
      await expect(wd.detail.rows, '[Expected 1] The dialog has exactly 1 row').toHaveCount(1);
    });

    await step('Act: Step 2 — Read the CS재고(가용재고) cell, then set CS재고 관리여부 to 관리안함 (Not managed)', async () => {
      csInDialog = await wd.dialogCellText(0, 3);
      await wd.setManaged(0, false);
    });

    await step('Assert: Expected 2 — The cell shows 0 and the radio button takes the change', async () => {
      expect(csInDialog, '[Expected 2] The CS재고(가용재고) cell shows 0').toBe('0');
      await expect(wd.managedRadio(0, false), '[Expected 2] The 관리안함 (Not managed) radio is selected').toBeChecked();
      await expect(wd.managedRadio(0, true), '[Expected 2] The 관리함 (Managed) radio is no longer selected').not.toBeChecked();
    });

    await step('Act: Step 3 — Click 저장 (Save)', async () => {
      save = await wd.saveDetail();
    });

    await step(`Assert: Expected 3 — The save goes through with ${SAVED}; available and total stock above 0 do not block it`, async () => {
      expect(save.status, `[Expected 3] The save call is accepted (got ${save.status} ${save.code} ${save.message})`).toBeLessThan(300);
      await expect(wd.lastToast(), `[Expected 3] The message reads ${SAVED}`).toContainText(SAVED);
      expect(Number(available.replace(/,/g, '')), '[Expected 3] 가용재고 (Available stock) of the row is above 0').toBeGreaterThan(0);
      expect(Number(total.replace(/,/g, '')), '[Expected 3] 전체재고 (Total stock) of the row is above 0').toBeGreaterThan(0);
    });

    let cs = '';
    let csOrderable = '';
    await step('Act: Step 4 — Read the 2 CS columns of that row on the reloaded list', async () => {
      const row = wd.row(sku.skuCode, cj.name);
      cs = await wd.cellText(row, 'col.csQuantity');
      csOrderable = await wd.cellText(row, 'col.csOrderableQuantity');
    });

    await step(`Assert: Expected 4 — Both CS columns show the words ${NOT_MANAGED} instead of a number`, async () => {
      expect(cs, `[Expected 4] CS재고(가용재고) reads ${NOT_MANAGED}`).toBe(NOT_MANAGED);
      expect(csOrderable, `[Expected 4] CS재고(CS가능수량) reads ${NOT_MANAGED}`).toBe(NOT_MANAGED);
    });
  });

  test('TC_US134_275 — Both toolbar guards block 창고별 상세 for no selection and for a row outside a CJ warehouse', async ({ page, world }) => {
    const step = makeStep(page);
    const wd = new StockWarehouseDetailPage(page);
    const wms = world.row('SKU0001', world.warehouses.CJ);
    const pickup = world.row('SKU0004', world.warehouses.PICKUP);
    await tcMeta(
      'TC_US134_275',
      'Medium',
      TAGS,
      `창고별 상세 with nothing ticked shows ${squash(KO('guard.noSelection'))} and opens nothing; with DEMO-SKU-0004 (Demo Pickup Point) alone or together with DEMO-SKU-0001 (CJ Incheon Aam) it shows ${NON_CJ_GUARD} and opens nothing; with DEMO-SKU-0001 alone the dialog opens with 1 row. The guard message renders the 2 sentences on separate lines — compared with whitespace collapsed. Read-only on the shared rows. ${WORLD_NOTE}`,
    );
    const guards: string[] = [];

    await step('Arrange: Pre-condition 1–2 — DEMO-SKU-0001 in CJ Incheon Aam (WMS) and DEMO-SKU-0004 in Demo Pickup Point (PICKUP_LOCATION)', async () => {
      expect(world.warehouses.CJ.category, 'CJ Incheon Aam is a CJ warehouse').toBe('CJ_WAREHOUSE');
      await wd.openWorld(world);
    });

    await step('Act: Step 1 — With nothing ticked, click 창고별 상세 (Per-warehouse detail)', async () => {
      await expect(wd.tickedBoxes, 'Nothing is ticked').toHaveCount(0);
      await wd.clickDetail();
      guards.push(await wd.guardText());
    });

    await step('Assert: Expected 1 — The action is blocked', async () => {
      await expect(wd.guardAlert, '[Expected 1] A guard message blocks the action').toBeVisible();
      await expect(wd.openDialogs, '[Expected 1] No dialog opens').toHaveCount(0);
    });

    await step('Act: Step 2 — Read the message that appears and look for any dialog', async () => {
      await expect(wd.guardAlert, 'The guard message is shown').toBeVisible();
    });

    await step(`Assert: Expected 2 — The message shows "${squash(KO('guard.noSelection'))}" and no dialog opens`, async () => {
      expect(guards[0], `[Expected 2] The message reads ${squash(KO('guard.noSelection'))}`).toBe(squash(KO('guard.noSelection')));
      await expect(wd.openDialogs, '[Expected 2] No dialog opens').toHaveCount(0);
    });

    await step('Act: Step 3 — Tick only DEMO-SKU-0004, click 창고별 상세 and read the message', async () => {
      await wd.tick(wd.row(pickup.sku.skuCode, pickup.warehouse.name), `${pickup.sku.skuCode} @ ${pickup.warehouse.name}`);
      await wd.clickDetail();
      guards.push(await wd.guardText());
    });

    await step(`Assert: Expected 3 — The message shows "${NON_CJ_GUARD}" and no dialog opens`, async () => {
      expect(guards[1], `[Expected 3] The message reads ${NON_CJ_GUARD}`).toBe(NON_CJ_GUARD);
      await expect(wd.openDialogs, '[Expected 3] No dialog opens').toHaveCount(0);
    });

    await step('Act: Step 4 — Also tick DEMO-SKU-0001 (1 WMS row + 1 non-WMS row) and click 창고별 상세', async () => {
      await wd.tick(wd.row(wms.sku.skuCode, wms.warehouse.name), `${wms.sku.skuCode} @ ${wms.warehouse.name}`);
      await expect(wd.tickedBoxes, '2 rows are ticked').toHaveCount(2);
      await wd.clickDetail();
      guards.push(await wd.guardText());
    });

    await step('Assert: Expected 4 — The action is still blocked with the same CJ-warehouse message', async () => {
      expect(guards[2], `[Expected 4] The message reads ${NON_CJ_GUARD}`).toBe(NON_CJ_GUARD);
      await expect(wd.openDialogs, '[Expected 4] No dialog opens').toHaveCount(0);
    });

    await step('Act: Step 5 — Untick DEMO-SKU-0004 so only DEMO-SKU-0001 is left, then click 창고별 상세', async () => {
      await wd.checkbox(wd.row(pickup.sku.skuCode, pickup.warehouse.name)).uncheck();
      await wd.clickDetail();
    });

    await step('Assert: Expected 5 — The per-warehouse detail dialog opens with 1 row', async () => {
      await expect(wd.detail.root, '[Expected 5] The 창고별 상세 dialog opens').toBeVisible();
      await expect(wd.detail.rows, '[Expected 5] The dialog has exactly 1 row').toHaveCount(1);
      await expect(wd.dialogCell(0, 0), `[Expected 5] The row is ${wms.sku.skuCode}`).toHaveText(wms.sku.skuCode);
    });
  });

  test('TC_US134_276 — The server refuses setting the CS flag on a non-WMS warehouse sent around the screen guard', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    const wd = new StockWarehouseDetailPage(page);
    const pickup = world.row('SKU0004', world.warehouses.PICKUP);
    const original = { ...pickup.buckets };
    await tcMeta(
      'TC_US134_276',
      'Medium',
      TAGS,
      'A PATCH /stocks/cs-stock-management call setting DEMO-SKU-0004 × Demo Pickup Point (PLATFORM · PICKUP_LOCATION) to managed is rejected with WH-CS_STOCK_MANAGEMENT_NOT_ALLOWED "CJ창고가 아닌 창고에는 CS재고 관리를 설정할 수 없습니다.", the list cell stays "-" and no flag is stored. If the server ever accepts the call, the shared row is restored in teardown. ' +
        WORLD_NOTE,
    );
    let result!: ApiResult<unknown>;
    let error = { status: 0, code: '', message: '' };
    let cell = '';

    try {
      await step('Arrange: Pre-condition 1–3 — DEMO-SKU-0004 in Demo Pickup Point (PLATFORM · PICKUP_LOCATION), flag off; an authenticated API client', async () => {
        expect(await storedManaged(pickup.sku.skuId, pickup.warehouse.id), 'The pickup row has no CS flag').toBe(false);
      });

      await step('Act: Step 1 — Send a change-CS-managed-flag call for DEMO-SKU-0004 × Demo Pickup Point set to MANAGED, around the screen', async () => {
        result = await stockApi.setCsManagement({ items: [item(pickup.sku, pickup.warehouse, true)] });
      });

      await step('Assert: Expected 1 — The server rejects the request', async () => {
        expect(result.status, '[Expected 1] The call is rejected with a 4xx status').toBeGreaterThanOrEqual(400);
        expect(result.status, '[Expected 1] The rejection is not a server error').toBeLessThan(500);
      });

      await step('Act: Step 2 — Read the error that comes back', async () => {
        error = errorOf(result);
      });

      await step('Assert: Expected 2 — WH-CS_STOCK_MANAGEMENT_NOT_ALLOWED: CJ창고가 아닌 창고에는 CS재고 관리를 설정할 수 없습니다.', async () => {
        expect(error.code, '[Expected 2] The code is WH-CS_STOCK_MANAGEMENT_NOT_ALLOWED').toBe('WH-CS_STOCK_MANAGEMENT_NOT_ALLOWED');
        expect(error.message, '[Expected 2] The message is the non-CJ warehouse message').toBe('CJ창고가 아닌 창고에는 CS재고 관리를 설정할 수 없습니다.');
      });

      await step('Act: Step 3 — Read the CS재고(가용재고) cell of that row on the list', async () => {
        await wd.openWorld(world);
        cell = await wd.cellText(wd.row(pickup.sku.skuCode, pickup.warehouse.name), 'col.csQuantity');
      });

      await step('Assert: Expected 3 — The cell is unchanged and no CS managed flag is written for the non-WMS warehouse', async () => {
        expect(cell, '[Expected 3] The CS재고(가용재고) cell still reads "-"').toBe('-');
        expect(await storedManaged(pickup.sku.skuId, pickup.warehouse.id), '[Expected 3] The stored flag is still false').toBe(false);
      });
    } finally {
      if (await storedManaged(pickup.sku.skuId, pickup.warehouse.id)) await world.seedStock(pickup.sku, pickup.warehouse, original);
    }
  });

  test('TC_US134_277 — The CJ guard lets exactly the 2 WMS warehouses with a CJ channel through', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    const wd = new StockWarehouseDetailPage(page);
    await tcMeta(
      'TC_US134_277',
      'Medium',
      TAGS,
      `One row at a time: the DEMO-SKU-0001 row in CJ Incheon Aam (WMS · CJ_LOGISTICS) and the DEMO-SKU-0003 row in CJ Daegu warehouse (WMS · CJ_LOGISTICS_DT) open 창고별 상세; the DEMO-SKU-0004 row in Demo Pickup Point (PICKUP_LOCATION · NONE) is blocked with ${NON_CJ_GUARD}. The set that got through equals the set of WMS warehouses and both carry a CJ channel. The previous tick is cleared before the next row is ticked so each warehouse is tested on its own. Read-only on the shared rows. ${WORLD_NOTE}`,
    );
    test.skip(!world.warehouses.DAEGU, world.daeguUnavailableReason ?? 'No CJ Daegu warehouse in the demo world');
    const daeguWarehouse = world.warehouses.DAEGU as WorldWarehouse;
    const rows = [world.row('SKU0001', world.warehouses.CJ), world.row('SKU0003', daeguWarehouse), world.row('SKU0004', world.warehouses.PICKUP)];
    const passed: boolean[] = [];
    let guard = '';
    const catalogue: Array<{ id: number; logisticsType: string; channel: string }> = [];

    const tryOpen = async (index: number) => {
      const row = rows[index];
      await wd.untickAll();
      await wd.tick(wd.row(row.sku.skuCode, row.warehouse.name), `${row.sku.skuCode} @ ${row.warehouse.name}`);
      await wd.clickDetail();
      await expect(wd.detail.root.or(wd.guardAlert).first(), 'The dialog or a guard message appears').toBeVisible();
      passed[index] = await wd.detail.root.isVisible();
    };

    await step('Arrange: Pre-condition 1–3 — CJ Incheon Aam (WMS · CJ_LOGISTICS), CJ Daegu warehouse (WMS · CJ_LOGISTICS_DT), Demo Pickup Point (PICKUP_LOCATION · NONE), each with a physical stock row', async () => {
      const selectable = await stockApi.selectableWarehouses();
      for (const row of rows) {
        const stock = await stockApi.stockRow(row.sku.skuId, row.warehouse.id);
        const entry = selectable.find((w) => w.id === row.warehouse.id);
        const [stored] = await stockDb.query('SELECT logistics_type FROM warehouse WHERE id = ?', [row.warehouse.id]);
        catalogue.push({ id: row.warehouse.id, logisticsType: stock?.warehouse?.logisticsType || String(stored?.logistics_type ?? ''), channel: entry?.logisticsChannelType ?? '' });
      }
      expect(catalogue.length, 'Each of the 3 warehouses has a physical stock row').toBe(3);
      await wd.openWorld(world);
    });

    await step('Act: Step 1 — Tick the row in CJ Incheon Aam and click 창고별 상세', async () => {
      await tryOpen(0);
    });

    await step('Assert: Expected 1 — The dialog opens', async () => {
      expect(passed[0], '[Expected 1] The dialog opens for CJ Incheon Aam').toBe(true);
    });

    await step('Act: Step 2 — Close the dialog, tick the row in CJ Daegu warehouse and click 창고별 상세', async () => {
      if (await wd.detail.root.isVisible()) await wd.closeDetail();
      await tryOpen(1);
    });

    await step('Assert: Expected 2 — The dialog opens', async () => {
      expect(passed[1], '[Expected 2] The dialog opens for CJ Daegu warehouse').toBe(true);
    });

    await step('Act: Step 3 — Close the dialog, tick the row in Demo Pickup Point and click 창고별 상세', async () => {
      if (await wd.detail.root.isVisible()) await wd.closeDetail();
      await tryOpen(2);
      guard = (await wd.guardAlert.isVisible()) ? squash(await wd.guardAlert.innerText()) : '';
    });

    await step(`Assert: Expected 3 — The action is blocked with ${NON_CJ_GUARD}`, async () => {
      expect(passed[2], '[Expected 3] No dialog opens for Demo Pickup Point').toBe(false);
      expect(guard, `[Expected 3] The message reads ${NON_CJ_GUARD}`).toBe(NON_CJ_GUARD);
    });

    await step('Act: Step 4 — Compare which warehouses got through the guard against their logistics type and channel', async () => {
      expect(passed.length, 'All 3 warehouses were tried').toBe(3);
    });

    await step('Assert: Expected 4 — Exactly the 2 WMS warehouses got through and both carry a CJ channel', async () => {
      const through = catalogue.filter((_, index) => passed[index]);
      const wmsSet = catalogue.filter((entry) => entry.logisticsType === 'WMS');
      expect(through.length, '[Expected 4] Exactly 2 warehouses got through').toBe(2);
      expect(through.map((entry) => entry.id), '[Expected 4] The warehouses that got through are exactly the WMS ones').toEqual(wmsSet.map((entry) => entry.id));
      for (const entry of through) {
        expect(entry.logisticsType, `[Expected 4] Warehouse ${entry.id} that got through has logistics type WMS`).toBe('WMS');
        expect(entry.channel, `[Expected 4] Warehouse ${entry.id} that got through carries a CJ channel`).toMatch(/^CJ_LOGISTICS/);
      }
    });
  });

  test('TC_US134_278 — The dialog lists 1 row per picked stock row with its 5 columns', async ({ page, world }) => {
    const step = makeStep(page);
    const wd = new StockWarehouseDetailPage(page);
    const label = 'WD278';
    await tcMeta(
      'TC_US134_278',
      'Medium',
      TAGS,
      `Ticking a CS-managed row in CJ Incheon Aam (CS 20) and one in CJ Daegu warehouse (CS 50) opens 창고별 상세 with exactly 2 rows; the CJ Incheon Aam row reads its SKU 코드, SKU명, 창고 CJ Incheon Aam, CS재고(가용재고) 20 and the radio on 관리함; the 2 rows name the 2 warehouses. The TC rows DEMO-SKU-0001 / DEMO-SKU-0003 are played by 2 lines of an own SKU (the shared DEMO-SKU-0003 is not CS managed); the TC "first row" is located by its SKU code since the dialog keeps the list order. ${OWN_NOTE}`,
    );
    test.skip(!world.warehouses.DAEGU, world.daeguUnavailableReason ?? 'No CJ Daegu warehouse in the demo world');
    const cj = world.warehouses.CJ;
    const daegu = world.warehouses.DAEGU as WorldWarehouse;
    let skus: WorldSku[] = [];
    let headers: string[] = [];
    let first = 0;

    await step('Arrange: Pre-condition 1–2 — Own row in CJ Incheon Aam (CS managed, CS 20) and own row in CJ Daegu warehouse (CS managed, CS 50)', async () => {
      skus = await ownSkus(world, label, 2);
      await world.seedStock(skus[0], cj, { available: 100, cs: 20, csManaged: true });
      await world.seedStock(skus[1], daegu, { available: 10, cs: 50, csManaged: true });
      await showOwn(wd, world, label);
    });

    await step('Act: Step 1 — Tick both rows and click 창고별 상세', async () => {
      await wd.openDetail([wd.row(skus[0].skuCode, cj.name), wd.row(skus[1].skuCode, daegu.name)]);
    });

    await step('Assert: Expected 1 — The dialog opens', async () => {
      await expect(wd.detail.root, '[Expected 1] The 창고별 상세 dialog is open').toBeVisible();
    });

    await step('Act: Step 2 — Count the rows in the table', async () => {
      await expect(wd.detail.table, 'The table is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — The table has exactly 2 rows, 1 per picked stock row', async () => {
      await expect(wd.detail.rows, '[Expected 2] The table has exactly 2 rows').toHaveCount(2);
    });

    let cells: string[] = [];
    await step('Act: Step 3 — Read the 5 cells of the CJ Incheon Aam row', async () => {
      headers = await wd.detail.headerTexts();
      first = await wd.dialogRowIndex(skus[0].skuCode, cj.name);
      cells = (await wd.detail.rows.nth(first).locator('td').allTextContents()).map((text) => text.trim());
    });

    await step('Assert: Expected 3 — SKU 코드, SKU명, 창고 CJ Incheon Aam, CS재고(가용재고) 20 and CS재고 관리여부 on 관리함', async () => {
      expect(headers, '[Expected 3] The 5 columns are SKU 코드 · SKU명 · 창고 · CS재고(가용재고) · CS재고 관리여부').toEqual(
        (['whdetail.col.skuCode', 'whdetail.col.skuName', 'whdetail.col.warehouse', 'whdetail.col.csQuantity', 'whdetail.col.csStockManaged'] as const).map(KO),
      );
      expect(cells.length, '[Expected 3] The row has 5 cells').toBe(5);
      expect(cells[0], `[Expected 3] SKU 코드 is ${skus[0].skuCode}`).toBe(skus[0].skuCode);
      expect(cells[1], `[Expected 3] SKU명 is ${skus[0].skuName}`).toBe(skus[0].skuName);
      expect(cells[2], `[Expected 3] 창고 is ${cj.name}`).toBe(cj.name);
      expect(cells[3], '[Expected 3] CS재고(가용재고) is 20').toBe('20');
      await expect(wd.managedRadio(first, true), '[Expected 3] CS재고 관리여부 is set to 관리함 (Managed)').toBeChecked();
    });

    let warehouses: string[] = [];
    await step('Act: Step 4 — Read the 창고 (Warehouse) cell on each row', async () => {
      warehouses = [await wd.dialogCellText(0, 2), await wd.dialogCellText(1, 2)];
    });

    await step('Assert: Expected 4 — One row shows CJ Incheon Aam and the other shows CJ Daegu warehouse', async () => {
      expect(warehouses, `[Expected 4] One row shows ${cj.name}`).toContain(cj.name);
      expect(warehouses, `[Expected 4] The other row shows ${daegu.name}`).toContain(daegu.name);
    });
  });

  test('TC_US134_279 — The CS managed flag stays per SKU and warehouse pair when it is switched in one warehouse', async ({ page, world }) => {
    const step = makeStep(page);
    const wd = new StockWarehouseDetailPage(page);
    const label = 'WD279';
    await tcMeta(
      'TC_US134_279',
      'Critical',
      TAGS,
      `The same SKU sits in CJ Incheon Aam and CJ Daegu warehouse, both 관리함 with CS 0. Switching only the CJ Incheon Aam row to 관리안함 saves with ${SAVED}; that row then reads ${NOT_MANAGED} while the CJ Daegu row still reads 0 and its dialog radio stays on 관리함. ${OWN_NOTE}`,
    );
    test.skip(!world.warehouses.DAEGU, world.daeguUnavailableReason ?? 'No CJ Daegu warehouse in the demo world');
    const cj = world.warehouses.CJ;
    const daegu = world.warehouses.DAEGU as WorldWarehouse;
    let sku!: WorldSku;
    let save!: CsSave;
    let cjCell = '';
    let daeguCell = '';

    await step('Arrange: Pre-condition 1–2 — Own SKU in CJ Incheon Aam and CJ Daegu warehouse, both 관리함 with CS stock 0', async () => {
      sku = await ownPhysicalSku(world, label);
      await world.seedStock(sku, cj, { available: 10, csManaged: true });
      await world.seedStock(sku, daegu, { available: 10, csManaged: true });
      await showOwn(wd, world, label);
    });

    await step('Act: Step 1 — Tick only the row in CJ Incheon Aam and click 창고별 상세', async () => {
      await wd.openDetail([wd.row(sku.skuCode, cj.name)]);
    });

    await step('Assert: Expected 1 — The dialog opens with 1 row, for CJ Incheon Aam only', async () => {
      await expect(wd.detail.rows, '[Expected 1] The dialog has exactly 1 row').toHaveCount(1);
      await expect(wd.dialogCell(0, 2), `[Expected 1] The row is in ${cj.name}`).toHaveText(cj.name);
    });

    await step('Act: Step 2 — Set CS재고 관리여부 to 관리안함 (Not managed) and click 저장 (Save)', async () => {
      await wd.setManaged(0, false);
      save = await wd.saveDetail();
    });

    await step(`Assert: Expected 2 — The save goes through and shows ${SAVED}`, async () => {
      expect(save.status, `[Expected 2] The save call is accepted (got ${save.status} ${save.code} ${save.message})`).toBeLessThan(300);
      await expect(wd.lastToast(), `[Expected 2] The message reads ${SAVED}`).toContainText(SAVED);
    });

    await step('Act: Step 3 — Read CS재고(가용재고) of the row in CJ Incheon Aam', async () => {
      cjCell = await wd.cellText(wd.row(sku.skuCode, cj.name), 'col.csQuantity');
    });

    await step(`Assert: Expected 3 — The cell shows ${NOT_MANAGED}, so the flag changed for this pair`, async () => {
      expect(cjCell, `[Expected 3] The CJ Incheon Aam cell reads ${NOT_MANAGED}`).toBe(NOT_MANAGED);
    });

    await step('Act: Step 4 — Read CS재고(가용재고) of the row in CJ Daegu warehouse', async () => {
      daeguCell = await wd.cellText(wd.row(sku.skuCode, daegu.name), 'col.csQuantity');
    });

    await step(`Assert: Expected 4 — The cell still shows the number 0 and not ${NOT_MANAGED}`, async () => {
      expect(daeguCell, '[Expected 4] The CJ Daegu warehouse cell still reads 0').toBe('0');
      expect(await storedManaged(sku.skuId, daegu.id), '[Expected 4] The CJ Daegu warehouse row kept 관리함 (Managed)').toBe(true);
    });

    await step('Act: Step 5 — Tick the CJ Daegu warehouse row, open the dialog and read its CS재고 관리여부 value', async () => {
      await wd.openDetail([wd.row(sku.skuCode, daegu.name)]);
    });

    await step('Assert: Expected 5 — The radio button is still on 관리함 (Managed)', async () => {
      await expect(wd.managedRadio(0, true), '[Expected 5] The CJ Daegu warehouse line is on 관리함 (Managed)').toBeChecked();
    });
  });

  test('TC_US134_280 — The CS quantity column shows Not managed in the dialog the same way as on the list', async ({ page, world }) => {
    const step = makeStep(page);
    const wd = new StockWarehouseDetailPage(page);
    const managed = world.row('SKU0001', world.warehouses.CJ);
    const unmanaged = world.row('SKU0002', world.warehouses.CJ);
    await tcMeta(
      'TC_US134_280',
      'Medium',
      TAGS,
      `With DEMO-SKU-0001 (관리함, CS 20) and DEMO-SKU-0002 (관리안함) of CJ Incheon Aam ticked, 창고별 상세 opens with 2 rows: the DEMO-SKU-0002 CS cell reads ${NOT_MANAGED}, the DEMO-SKU-0001 cell reads 20, and both match the CS재고(가용재고) cells of the list. Read-only on the shared rows (the dialog is not saved). ${WORLD_NOTE}`,
    );
    const dialogCells: Record<string, string> = {};
    const listCells: Record<string, string> = {};

    await step('Arrange: Pre-condition 1–2 — DEMO-SKU-0001 (관리함, CS 20) and DEMO-SKU-0002 (관리안함) in CJ Incheon Aam', async () => {
      expect(managed.buckets.csManaged && managed.buckets.cs === 20, 'DEMO-SKU-0001 is managed with CS 20').toBe(true);
      expect(unmanaged.buckets.csManaged, 'DEMO-SKU-0002 is not managed').toBe(false);
      await wd.openWorld(world);
    });

    await step('Act: Step 1 — Tick both rows and click 창고별 상세', async () => {
      await wd.openDetail([wd.row(managed.sku.skuCode, managed.warehouse.name), wd.row(unmanaged.sku.skuCode, unmanaged.warehouse.name)]);
    });

    await step('Assert: Expected 1 — The dialog opens with 2 rows', async () => {
      await expect(wd.detail.rows, '[Expected 1] The dialog has exactly 2 rows').toHaveCount(2);
    });

    await step('Act: Step 2 — Read the CS재고(가용재고) cell on the DEMO-SKU-0002 row', async () => {
      dialogCells.unmanaged = await wd.dialogCellText(await wd.dialogRowIndex(unmanaged.sku.skuCode, unmanaged.warehouse.name), 3);
    });

    await step(`Assert: Expected 2 — The cell shows the words ${NOT_MANAGED} instead of a number`, async () => {
      expect(dialogCells.unmanaged, `[Expected 2] The DEMO-SKU-0002 cell reads ${NOT_MANAGED}`).toBe(NOT_MANAGED);
    });

    await step('Act: Step 3 — Read that cell on the DEMO-SKU-0001 row', async () => {
      dialogCells.managed = await wd.dialogCellText(await wd.dialogRowIndex(managed.sku.skuCode, managed.warehouse.name), 3);
    });

    await step('Assert: Expected 3 — The cell shows the number 20', async () => {
      expect(dialogCells.managed, '[Expected 3] The DEMO-SKU-0001 cell reads 20').toBe('20');
    });

    await step('Act: Step 4 — Compare with the CS재고(가용재고) column of those 2 rows on the list behind the dialog', async () => {
      listCells.managed = await wd.cellText(wd.row(managed.sku.skuCode, managed.warehouse.name), 'col.csQuantity');
      listCells.unmanaged = await wd.cellText(wd.row(unmanaged.sku.skuCode, unmanaged.warehouse.name), 'col.csQuantity');
    });

    await step('Assert: Expected 4 — The dialog cells match the list cells on both rows', async () => {
      expect(dialogCells.unmanaged, '[Expected 4] DEMO-SKU-0002: the dialog cell matches the list cell').toBe(listCells.unmanaged);
      expect(dialogCells.managed, '[Expected 4] DEMO-SKU-0001: the dialog cell matches the list cell').toBe(listCells.managed);
    });
  });

  test('TC_US134_281 — The save is blocked on screen when the flag is switched off while CS stock is above 0', async ({ page, world }) => {
    const step = makeStep(page);
    const wd = new StockWarehouseDetailPage(page);
    const label = 'WD281';
    const cj = world.warehouses.CJ;
    const blocked = KO('err.csUnmanageBlocked');
    await tcMeta(
      'TC_US134_281',
      'High',
      TAGS,
      `A 관리함 row with CS stock 20 is switched to 관리안함 in 창고별 상세: 저장 is blocked on screen with "${blocked}" (no save call leaves the browser), the dialog stays open with 관리안함 still picked, and the list row still reads 20 with the flag stored as managed. ${OWN_NOTE}`,
    );
    let sku!: WorldSku;
    let csInDialog = '';
    let writes: string[] = [];
    let listCell = '';

    await step('Arrange: Pre-condition 1–2 — Own SKU in CJ Incheon Aam, 관리함 with CS stock 20', async () => {
      sku = await ownPhysicalSku(world, label);
      await world.seedStock(sku, cj, { available: 100, cs: 20, csManaged: true });
      await showOwn(wd, world, label);
    });

    await step('Act: Step 1 — Tick the row and click 창고별 상세', async () => {
      await wd.openDetail([wd.row(sku.skuCode, cj.name)]);
    });

    await step('Assert: Expected 1 — The dialog opens with 1 row', async () => {
      await expect(wd.detail.rows, '[Expected 1] The dialog has exactly 1 row').toHaveCount(1);
    });

    await step('Act: Step 2 — Read the CS재고(가용재고) cell, then set CS재고 관리여부 to 관리안함 (Not managed)', async () => {
      csInDialog = await wd.dialogCellText(0, 3);
      await wd.setManaged(0, false);
    });

    await step('Assert: Expected 2 — The cell shows 20 and the radio button takes the change on screen', async () => {
      expect(csInDialog, '[Expected 2] The CS재고(가용재고) cell shows 20').toBe('20');
      await expect(wd.managedRadio(0, false), '[Expected 2] The 관리안함 (Not managed) radio is selected').toBeChecked();
    });

    await step('Act: Step 3 — Click 저장 (Save)', async () => {
      writes = wd.csWrites();
      await wd.detail.clickSave();
      await expect(wd.detail.errorAlert, 'A message appears in the dialog').toBeVisible();
    });

    await step(`Assert: Expected 3 — Saving is blocked with ${blocked}`, async () => {
      await expect(wd.detail.errorAlert, `[Expected 3] The dialog shows ${blocked}`).toHaveText(blocked);
      expect(writes.length, '[Expected 3] No save call leaves the browser').toBe(0);
    });

    await step('Act: Step 4 — See whether the dialog is still open and which value the radio button holds', async () => {
      await expect(wd.detail.root, 'The dialog is shown').toBeVisible();
    });

    await step('Assert: Expected 4 — The dialog is still open and the radio still shows the newly picked 관리안함', async () => {
      await expect(wd.detail.root, '[Expected 4] The dialog is still open').toBeVisible();
      await expect(wd.managedRadio(0, false), '[Expected 4] The radio still shows 관리안함 (Not managed)').toBeChecked();
    });

    await step('Act: Step 5 — Read CS재고(가용재고) on that list row', async () => {
      listCell = await wd.cellText(wd.row(sku.skuCode, cj.name), 'col.csQuantity');
    });

    await step('Assert: Expected 5 — The cell still shows 20 and the flag is still 관리함', async () => {
      expect(listCell, '[Expected 5] The list cell still reads 20').toBe('20');
      expect(await storedManaged(sku.skuId, cj.id), '[Expected 5] The flag is still 관리함 (Managed)').toBe(true);
    });
  });

  test('TC_US134_282 — The server refuses switching CS management off while CS stock remains', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    const wd = new StockWarehouseDetailPage(page);
    const label = 'WD282';
    const cj = world.warehouses.CJ;
    const message = 'CS가용재고가 0개일 경우에만 CS재고 관리안함으로 수정이 가능합니다.';
    await tcMeta(
      'TC_US134_282',
      'Medium',
      TAGS,
      `A PATCH /stocks/cs-stock-management call switching a 관리함 row with CS stock 20 (no CS re-delivery open) to not managed is rejected with WH-CS_STOCK_REMAINS "${message}" carrying no id or quantity; the list row keeps 20 and the flag stays managed. ${OWN_NOTE}`,
    );
    let sku!: WorldSku;
    let result!: ApiResult<unknown>;
    let error = { status: 0, code: '', message: '' };
    let cell = '';

    await step('Arrange: Pre-condition 1–4 — Own SKU in CJ Incheon Aam, 관리함 with CS 20, no CS re-delivery outbound in any warehouse', async () => {
      sku = await ownPhysicalSku(world, label);
      await world.seedStock(sku, cj, { available: 100, cs: 20, csManaged: true });
      expect(await openCsReservations(sku.skuId), 'The SKU has no open CS re-delivery outbound').toBe(0);
    });

    await step('Act: Step 1 — Send a change-CS-managed-flag call setting the row to not managed, around the screen', async () => {
      result = await stockApi.setCsManagement({ items: [item(sku, cj, false)] });
    });

    await step('Assert: Expected 1 — The call is rejected', async () => {
      expect(result.status, '[Expected 1] The call is rejected with a 4xx status').toBeGreaterThanOrEqual(400);
      expect(result.status, '[Expected 1] The rejection is not a server error').toBeLessThan(500);
    });

    await step('Act: Step 2 — Read the code and the message that come back', async () => {
      error = errorOf(result);
    });

    await step(`Assert: Expected 2 — WH-CS_STOCK_REMAINS: ${message} — no id or quantity in the message`, async () => {
      expect(error.code, '[Expected 2] The code is WH-CS_STOCK_REMAINS').toBe('WH-CS_STOCK_REMAINS');
      expect(error.message, '[Expected 2] The message is the CS-stock-remains message').toBe(message);
      expect(error.message, '[Expected 2] The message carries no SKU id').not.toContain(String(sku.skuId));
      expect(error.message, '[Expected 2] The message carries no warehouse id').not.toContain(String(cj.id));
      expect(error.message, '[Expected 2] The message carries no quantity').not.toContain('20');
    });

    await step('Act: Step 3 — Read the flag and CS재고(가용재고) of that row on the list', async () => {
      await showOwn(wd, world, label);
      cell = await wd.cellText(wd.row(sku.skuCode, cj.name), 'col.csQuantity');
    });

    await step('Assert: Expected 3 — The flag is still 관리함 and CS stock (available) is still 20', async () => {
      expect(cell, '[Expected 3] CS재고(가용재고) still reads 20').toBe('20');
      expect(await storedManaged(sku.skuId, cj.id), '[Expected 3] The flag is still 관리함 (Managed)').toBe(true);
    });
  });

  test('TC_US134_283 — The server refuses switching CS management off while a CS re-delivery outbound is open', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    const wd = new StockWarehouseDetailPage(page);
    const label = 'WD283';
    await tcMeta(
      'TC_US134_283',
      'High',
      TAGS,
      `A 관리함 row in CJ Daegu warehouse whose 8 CS units were released (CS 0) but with one open CS re-delivery outbound: the dialog shows no re-delivery field or status, the screen check passes and the save request is sent, and the server answers WH-CS_STOCK_RESERVED "${RESERVED_MESSAGE}" with no id or quantity; the dialog stays open and the flag stays managed. The open re-delivery is staged as a DB fixture: one stock_reservation row (OUTGOING · RESERVED · quantity_type CS) of the SKU — commerce orders cannot be created from this admin; the fixture is removed afterwards. ${RELEASE_NOTE} ${OWN_NOTE}`,
    );
    test.skip(!world.warehouses.DAEGU, world.daeguUnavailableReason ?? 'No CJ Daegu warehouse in the demo world');
    const daegu = world.warehouses.DAEGU as WorldWarehouse;
    let sku!: WorldSku;
    let reservation = 0;
    let headers: string[] = [];
    let bodyText = '';
    let csInDialog = '';
    let save!: CsSave;

    try {
      await step('Arrange: Pre-condition 1–3 — Own SKU in CJ Daegu warehouse, 관리함, CS 8 released to 0, one open CS re-delivery outbound', async () => {
        sku = await ownPhysicalSku(world, label);
        await releasedCsRow(world, stockApi, sku, daegu, { available: 14, cs: 8, reserved: 12 });
        reservation = await seedCsReservation(sku.skuId);
        expect(await openCsReservations(sku.skuId), 'The SKU has one open CS re-delivery outbound').toBe(1);
        await showOwn(wd, world, label);
      });

      await step('Act: Step 1 — Tick the row and click 창고별 상세', async () => {
        await wd.openDetail([wd.row(sku.skuCode, daegu.name)]);
      });

      await step('Assert: Expected 1 — The dialog opens with 1 row', async () => {
        await expect(wd.detail.rows, '[Expected 1] The dialog has exactly 1 row').toHaveCount(1);
      });

      await step('Act: Step 2 — Read the whole dialog for any field or status about a CS re-delivery outbound', async () => {
        headers = await wd.detail.headerTexts();
        bodyText = squash(await wd.detail.root.innerText());
      });

      await step('Assert: Expected 2 — No CS re-delivery outbound field, status or indicator is displayed', async () => {
        expect(headers.length, '[Expected 2] The table has only its 5 columns').toBe(5);
        expect(bodyText, '[Expected 2] No text about a CS re-delivery (재배송) is shown').not.toContain('재배송');
        expect(bodyText, '[Expected 2] No text about an outbound (출고) is shown').not.toContain('출고');
      });

      await step('Act: Step 3 — Read CS재고(가용재고), set CS재고 관리여부 to 관리안함 and click 저장', async () => {
        csInDialog = await wd.dialogCellText(0, 3);
        await wd.setManaged(0, false);
        save = await wd.saveDetail();
      });

      await step('Assert: Expected 3 — CS stock shows 0, the client check passes and the save request is sent', async () => {
        expect(csInDialog, '[Expected 3] CS재고(가용재고) shows 0').toBe('0');
        expect(save.requestBody.items ?? [], '[Expected 3] The save request carries the row switched to not managed').toEqual([{ skuId: sku.skuId, warehouseId: daegu.id, managed: false }]);
      });

      await step('Act: Step 4 — Read the server response, the dialog and the list flag', async () => {
        await expect(wd.detail.errorAlert.or(wd.lastToast()).first(), 'The screen reacts to the save').toBeVisible();
      });

      await step('Assert: Expected 4 — WH-CS_STOCK_RESERVED with no id or quantity; the dialog stays open and the flag stays 관리함', async () => {
        expect(save.status, '[Expected 4] The server rejects the change with a 4xx status').toBeGreaterThanOrEqual(400);
        expect(save.status, '[Expected 4] The rejection is not a server error').toBeLessThan(500);
        expect(save.code, '[Expected 4] The code is WH-CS_STOCK_RESERVED').toBe('WH-CS_STOCK_RESERVED');
        expect(save.message, '[Expected 4] The message is the re-delivery-in-progress message').toBe(RESERVED_MESSAGE);
        expect(save.message, '[Expected 4] The message carries no id or quantity').not.toMatch(/\d/);
        await expect(wd.detail.root, '[Expected 4] The dialog remains open').toBeVisible();
        await expect(wd.detail.errorAlert, '[Expected 4] The dialog shows the server message').toHaveText(RESERVED_MESSAGE);
        expect(await storedManaged(sku.skuId, daegu.id), '[Expected 4] The flag remains 관리함 (Managed)').toBe(true);
      });
    } finally {
      if (reservation) await deleteReservation(reservation);
    }
  });

  test('TC_US134_284 — Switching CS management off is refused while the same SKU has a CS re-delivery open in another warehouse', async ({ page, world }) => {
    const step = makeStep(page);
    const wd = new StockWarehouseDetailPage(page);
    const label = 'WD284';
    await tcMeta(
      'TC_US134_284',
      'High',
      TAGS,
      `The SKU is 관리함 with CS 0 and no re-delivery of its own in CJ Incheon Aam, while a CS re-delivery is open for it in CJ Daegu warehouse: switching the CJ Incheon Aam row to 관리안함 passes the screen check but the server answers WH-CS_STOCK_RESERVED "${RESERVED_MESSAGE}" — the dialog stays open and the flag stays managed. Once the re-delivery is closed, the same save goes through with ${SAVED} and the row reads ${NOT_MANAGED}. The open re-delivery is a DB fixture: one stock_reservation row (OUTGOING · RESERVED · CS) of the SKU — the table holds no warehouse column, so the reservation belongs to the SKU (the CJ Daegu row exists and is managed as the TC states); "complete or cancel the re-delivery" = the fixture row is deleted. ${OWN_NOTE}`,
    );
    test.skip(!world.warehouses.DAEGU, world.daeguUnavailableReason ?? 'No CJ Daegu warehouse in the demo world');
    const cj = world.warehouses.CJ;
    const daegu = world.warehouses.DAEGU as WorldWarehouse;
    let sku!: WorldSku;
    let reservation = 0;
    let csInDialog = '';
    let first!: CsSave;
    let second!: CsSave;

    try {
      await step('Arrange: Pre-condition 1–3 — Own SKU 관리함 with CS 0 in CJ Incheon Aam; managed in CJ Daegu warehouse with one open CS re-delivery', async () => {
        sku = await ownPhysicalSku(world, label);
        await world.seedStock(sku, cj, { available: 10, csManaged: true });
        await world.seedStock(sku, daegu, { available: 10, csManaged: true });
        reservation = await seedCsReservation(sku.skuId);
        await showOwn(wd, world, label);
      });

      await step('Act: Step 1 — Tick the row in CJ Incheon Aam and click 창고별 상세', async () => {
        await wd.openDetail([wd.row(sku.skuCode, cj.name)]);
      });

      await step('Assert: Expected 1 — The dialog opens with 1 row', async () => {
        await expect(wd.detail.rows, '[Expected 1] The dialog has exactly 1 row').toHaveCount(1);
        await expect(wd.dialogCell(0, 2), `[Expected 1] The row is in ${cj.name}`).toHaveText(cj.name);
      });

      await step('Act: Step 2 — Read CS재고(가용재고), set CS재고 관리여부 to 관리안함 and click 저장', async () => {
        csInDialog = await wd.dialogCellText(0, 3);
        await wd.setManaged(0, false);
        first = await wd.saveDetail();
      });

      await step('Assert: Expected 2 — The cell shows 0, so the screen check passes and the save request is sent', async () => {
        expect(csInDialog, '[Expected 2] CS재고(가용재고) shows 0').toBe('0');
        expect(first.requestBody.items ?? [], '[Expected 2] The save request is sent for the CJ Incheon Aam row').toEqual([{ skuId: sku.skuId, warehouseId: cj.id, managed: false }]);
      });

      await step('Act: Step 3 — Read the server response, the dialog and the list flag', async () => {
        await expect(wd.detail.errorAlert.or(wd.lastToast()).first(), 'The screen reacts to the save').toBeVisible();
      });

      await step('Assert: Expected 3 — WH-CS_STOCK_RESERVED although this row has no re-delivery; the dialog stays open and the flag stays 관리함', async () => {
        expect(first.status, '[Expected 3] The save is rejected with a 4xx status').toBeGreaterThanOrEqual(400);
        expect(first.code, '[Expected 3] The code is WH-CS_STOCK_RESERVED').toBe('WH-CS_STOCK_RESERVED');
        expect(first.message, '[Expected 3] The message is the re-delivery-in-progress message').toBe(RESERVED_MESSAGE);
        await expect(wd.detail.root, '[Expected 3] The dialog stays open').toBeVisible();
        expect(await storedManaged(sku.skuId, cj.id), '[Expected 3] The flag stays 관리함 (Managed)').toBe(true);
      });

      let cell = '';
      await step('Act: Step 4 — Close the CJ Daegu re-delivery so no CS reservation is open for the SKU, then repeat step 2', async () => {
        await deleteReservation(reservation);
        reservation = 0;
        await wd.setManaged(0, false);
        second = await wd.saveDetail();
        if (second.status < 300) cell = await wd.cellText(wd.row(sku.skuCode, cj.name), 'col.csQuantity');
      });

      await step(`Assert: Expected 4 — The save goes through with ${SAVED} and the row shows ${NOT_MANAGED}`, async () => {
        expect(second.status, `[Expected 4] The save call is accepted (got ${second.status} ${second.code} ${second.message})`).toBeLessThan(300);
        await expect(wd.lastToast(), `[Expected 4] The message reads ${SAVED}`).toContainText(SAVED);
        expect(cell, `[Expected 4] The row reads ${NOT_MANAGED}`).toBe(NOT_MANAGED);
      });
    } finally {
      if (reservation) await deleteReservation(reservation);
    }
  });

  test('TC_US134_285 — Only rows just switched to not managed are checked when the dialog is saved', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    const wd = new StockWarehouseDetailPage(page);
    const label = 'WD285';
    const cj = world.warehouses.CJ;
    await tcMeta(
      'TC_US134_285',
      'High',
      TAGS,
      `3 rows of CJ Incheon Aam: one already 관리안함 left untouched (TC DEMO-SKU-0002), one 관리안함 switched to 관리함 (DEMO-SKU-0009) and one 관리함 with CS 0 after releasing 5 units switched to 관리안함 (DEMO-SKU-0011). Each line offers exactly 관리함 / 관리안함 with the current flag selected; the save goes through with ${SAVED} and the reloaded list shows the 2 unmanaged rows as ${NOT_MANAGED} and the newly managed row as a number. The list has no separate flag column — the flag is read from CS재고(가용재고) (${NOT_MANAGED} = off, number = on) and from the stored flag. ${RELEASE_NOTE} ${OWN_NOTE}`,
    );
    let skus: WorldSku[] = [];
    const index: Record<'untouched' | 'toManaged' | 'toUnmanaged', number> = { untouched: 0, toManaged: 0, toUnmanaged: 0 };
    const choices: string[][] = [];
    let save!: CsSave;
    const cells: Record<string, string> = {};

    await step('Arrange: Pre-condition 1–3 — 3 own rows in CJ Incheon Aam: 관리안함, 관리안함, and 관리함 with CS 5 released to 0 (no re-delivery)', async () => {
      skus = await ownSkus(world, label, 3);
      await world.seedStock(skus[0], cj, { available: 50, csManaged: false });
      await world.seedStock(skus[1], cj, { available: 30, csManaged: false });
      await releasedCsRow(world, stockApi, skus[2], cj, { available: 5, cs: 5 });
      expect(await openCsReservations(skus[2].skuId), 'The row switched off has no CS re-delivery outbound').toBe(0);
      await showOwn(wd, world, label);
    });

    await step('Act: Step 1 — Tick the 3 rows and click 창고별 상세', async () => {
      await wd.openDetail(skus.map((sku) => wd.row(sku.skuCode, cj.name)));
    });

    await step('Assert: Expected 1 — The dialog opens with 3 rows', async () => {
      await expect(wd.detail.rows, '[Expected 1] The dialog has exactly 3 rows').toHaveCount(3);
    });

    await step('Act: Step 2 — Read the CS재고 관리여부 choices and the selected value on each row', async () => {
      index.untouched = await wd.dialogRowIndex(skus[0].skuCode, cj.name);
      index.toManaged = await wd.dialogRowIndex(skus[1].skuCode, cj.name);
      index.toUnmanaged = await wd.dialogRowIndex(skus[2].skuCode, cj.name);
      for (let line = 0; line < 3; line += 1) choices.push(await wd.choiceLabels(line));
    });

    await step('Assert: Expected 2 — Each row offers only 관리함 and 관리안함, selected = the current flag', async () => {
      for (let line = 0; line < 3; line += 1) {
        expect(choices[line], `[Expected 2] Line ${line + 1} offers exactly 관리함 (Managed) and 관리안함 (Not managed)`).toEqual([KO('csManaged.MANAGED'), KO('csManaged.UNMANAGED')]);
        await expect(wd.radios(line), `[Expected 2] Line ${line + 1} has exactly 2 choices`).toHaveCount(2);
      }
      await expect(wd.managedRadio(index.untouched, false), '[Expected 2] The untouched row (DEMO-SKU-0002) is on 관리안함').toBeChecked();
      await expect(wd.managedRadio(index.toManaged, false), '[Expected 2] The DEMO-SKU-0009 row is on 관리안함').toBeChecked();
      await expect(wd.managedRadio(index.toUnmanaged, true), '[Expected 2] The DEMO-SKU-0011 row is on 관리함').toBeChecked();
    });

    await step('Act: Step 3 — Leave the first row, switch the DEMO-SKU-0011 row to 관리안함 and the DEMO-SKU-0009 row to 관리함', async () => {
      await wd.setManaged(index.toUnmanaged, false);
      await wd.setManaged(index.toManaged, true);
    });

    await step('Assert: Expected 3 — Untouched row 관리안함, DEMO-SKU-0011 now 관리안함, DEMO-SKU-0009 now 관리함', async () => {
      await expect(wd.managedRadio(index.untouched, false), '[Expected 3] The untouched row still shows 관리안함').toBeChecked();
      await expect(wd.managedRadio(index.toUnmanaged, false), '[Expected 3] The DEMO-SKU-0011 row now shows 관리안함').toBeChecked();
      await expect(wd.managedRadio(index.toManaged, true), '[Expected 3] The DEMO-SKU-0009 row now shows 관리함').toBeChecked();
    });

    await step('Act: Step 4 — Click 저장 (Save)', async () => {
      save = await wd.saveDetail();
    });

    await step(`Assert: Expected 4 — The save goes through and shows ${SAVED}`, async () => {
      expect(save.status, `[Expected 4] The save call is accepted (got ${save.status} ${save.code} ${save.message})`).toBeLessThan(300);
      await expect(wd.lastToast(), `[Expected 4] The message reads ${SAVED}`).toContainText(SAVED);
    });

    await step('Act: Step 5 — Read the CS재고 관리여부 value of the 3 rows on the reloaded list', async () => {
      for (const [key, sku] of [['untouched', skus[0]], ['toManaged', skus[1]], ['toUnmanaged', skus[2]]] as const) {
        cells[key] = await wd.cellText(wd.row(sku.skuCode, cj.name), 'col.csQuantity');
      }
    });

    await step(`Assert: Expected 5 — DEMO-SKU-0002 and DEMO-SKU-0011 show ${NOT_MANAGED}, DEMO-SKU-0009 shows 관리함`, async () => {
      expect(cells.untouched, `[Expected 5] DEMO-SKU-0002 reads ${NOT_MANAGED}`).toBe(NOT_MANAGED);
      expect(cells.toUnmanaged, `[Expected 5] DEMO-SKU-0011 reads ${NOT_MANAGED}`).toBe(NOT_MANAGED);
      expect(cells.toManaged, '[Expected 5] DEMO-SKU-0009 shows a number (관리함)').toBe('0');
      expect(await storedManaged(skus[0].skuId, cj.id), '[Expected 5] DEMO-SKU-0002 is stored as not managed').toBe(false);
      expect(await storedManaged(skus[2].skuId, cj.id), '[Expected 5] DEMO-SKU-0011 is stored as not managed').toBe(false);
      expect(await storedManaged(skus[1].skuId, cj.id), '[Expected 5] DEMO-SKU-0009 is stored as managed').toBe(true);
    });
  });

  test('TC_US134_286 — The server lets a legacy non-WMS CS flag be switched off but not back on', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    const wd = new StockWarehouseDetailPage(page);
    const label = 'WD286';
    const pickup = world.warehouses.PICKUP;
    await tcMeta(
      'TC_US134_286',
      'Medium',
      TAGS,
      'DB fixture: an own row in Demo Pickup Point (PLATFORM · PICKUP_LOCATION) with the CS flag stored as true. Setting it to UNMANAGED through the API is accepted, the stored flag becomes false and both CS columns of the list read "-"; setting it back to MANAGED is rejected with WH-CS_STOCK_MANAGEMENT_NOT_ALLOWED "CJ창고가 아닌 창고에는 CS재고 관리를 설정할 수 없습니다." and the flag stays false. ' +
        OWN_NOTE,
    );
    let sku!: WorldSku;
    let off!: ApiResult<unknown>;
    let on!: ApiResult<unknown>;
    let storedAfterOff: boolean | undefined;
    const cells: string[] = [];

    await step('Arrange: Pre-condition 1–3 — DB fixture: own row in Demo Pickup Point with the CS flag stored as true; an authenticated API client', async () => {
      sku = await ownPhysicalSku(world, label);
      await world.seedStock(sku, pickup, { available: 10, csManaged: true });
      expect(await storedManaged(sku.skuId, pickup.id), 'The legacy flag is stored as true').toBe(true);
    });

    await step('Act: Step 1 — Send a change-CS-managed-flag call setting the pair to UNMANAGED and read the response', async () => {
      off = await stockApi.setCsManagement({ items: [item(sku, pickup, false)] });
    });

    await step('Assert: Expected 1 — The call is accepted', async () => {
      expect(off.status, `[Expected 1] The call is accepted (got ${off.status} ${JSON.stringify(off.body)})`).toBeLessThan(300);
    });

    await step('Act: Step 2 — Read the stored flag of that pair and the 2 CS columns of the row on the list', async () => {
      storedAfterOff = await storedManaged(sku.skuId, pickup.id);
      await showOwn(wd, world, label);
      const row = wd.row(sku.skuCode, pickup.name);
      cells.push(await wd.cellText(row, 'col.csQuantity'), await wd.cellText(row, 'col.csOrderableQuantity'));
    });

    await step('Assert: Expected 2 — The stored flag is false and both CS columns show a dash (-)', async () => {
      expect(storedAfterOff, '[Expected 2] The stored flag is false').toBe(false);
      expect(cells[0], '[Expected 2] CS재고(가용재고) shows "-"').toBe('-');
      expect(cells[1], '[Expected 2] CS재고(CS가능수량) shows "-"').toBe('-');
    });

    await step('Act: Step 3 — Send the same call setting it back to MANAGED and read the response', async () => {
      on = await stockApi.setCsManagement({ items: [item(sku, pickup, true)] });
    });

    await step('Assert: Expected 3 — Rejected with WH-CS_STOCK_MANAGEMENT_NOT_ALLOWED', async () => {
      const error = errorOf(on);
      expect(on.status, '[Expected 3] The call is rejected with a 4xx status').toBeGreaterThanOrEqual(400);
      expect(error.code, '[Expected 3] The code is WH-CS_STOCK_MANAGEMENT_NOT_ALLOWED').toBe('WH-CS_STOCK_MANAGEMENT_NOT_ALLOWED');
      expect(error.message, '[Expected 3] The message is the non-CJ warehouse message').toBe('CJ창고가 아닌 창고에는 CS재고 관리를 설정할 수 없습니다.');
    });

    let storedAfterOn: boolean | undefined;
    await step('Act: Step 4 — Read the stored flag again', async () => {
      storedAfterOn = await storedManaged(sku.skuId, pickup.id);
    });

    await step('Assert: Expected 4 — The stored flag is still false', async () => {
      expect(storedAfterOn, '[Expected 4] The stored flag is still false').toBe(false);
    });
  });

  test('TC_US134_287 — A CS-flag request on a row outside a PLATFORM warehouse is refused in both directions', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    const label = 'WD287';
    await tcMeta(
      'TC_US134_287',
      'Medium',
      TAGS,
      'DB fixture: in an own SUPPLIER warehouse ("<tag> Demo Supplier Warehouse"), line A has the CS flag stored as true and line B as false. Switching A off and B on through the API are both rejected with WH-WAREHOUSE_NOT_FOUND "창고를 찾을 수 없습니다. - id: <warehouse id>" and both stored flags are unchanged. Pre-condition 5 (Dev report on the review F4 data check) is outside the test. ' +
        OWN_NOTE,
    );
    let skus: WorldSku[] = [];
    let supplier = { id: 0, name: '' };
    let off!: ApiResult<unknown>;
    let on!: ApiResult<unknown>;
    const errors: Array<{ status: number; code: string; message: string }> = [];

    try {
      await step('Arrange: Pre-condition 1–5 — DB fixture: own SUPPLIER warehouse, line A flag true, line B flag false; an authenticated API client', async () => {
        const created = await world.createWarehouse('Demo Supplier Warehouse', 'SUPPLIER');
        supplier = { id: created.id, name: created.name };
        skus = await ownSkus(world, label, 2);
        await stockDb.upsertStock(skus[0].skuId, supplier.id, { available: 10, csManaged: true });
        await stockDb.upsertStock(skus[1].skuId, supplier.id, { available: 10, csManaged: false });
        expect(await storedManaged(skus[0].skuId, supplier.id), 'Line A is stored as true').toBe(true);
        expect(await storedManaged(skus[1].skuId, supplier.id), 'Line B is stored as false').toBe(false);
      });

      await step('Act: Step 1 — Send a change-CS-managed-flag call setting line A × the supplier warehouse to not managed', async () => {
        off = await stockApi.setCsManagement({ items: [item(skus[0], supplier, false)] });
      });

      await step('Assert: Expected 1 — The call is rejected', async () => {
        expect(off.status, '[Expected 1] The call is rejected with a 4xx status').toBeGreaterThanOrEqual(400);
        expect(off.status, '[Expected 1] The rejection is not a server error').toBeLessThan(500);
      });

      await step('Act: Step 2 — Read the code and the message that come back', async () => {
        errors.push(errorOf(off));
      });

      await step('Assert: Expected 2 — WH-WAREHOUSE_NOT_FOUND: 창고를 찾을 수 없습니다. - id: <warehouse id>', async () => {
        expect(errors[0].code, '[Expected 2] The code is WH-WAREHOUSE_NOT_FOUND').toBe('WH-WAREHOUSE_NOT_FOUND');
        expect(errors[0].message, `[Expected 2] The message names the real warehouse id ${supplier.id}`).toBe(`창고를 찾을 수 없습니다. - id: ${supplier.id}`);
      });

      await step('Act: Step 3 — Send a call setting line B × the supplier warehouse to managed', async () => {
        on = await stockApi.setCsManagement({ items: [item(skus[1], supplier, true)] });
      });

      await step('Assert: Expected 3 — The call is rejected', async () => {
        expect(on.status, '[Expected 3] The call is rejected with a 4xx status').toBeGreaterThanOrEqual(400);
        expect(on.status, '[Expected 3] The rejection is not a server error').toBeLessThan(500);
      });

      await step('Act: Step 4 — Read the code and the message that come back', async () => {
        errors.push(errorOf(on));
      });

      await step('Assert: Expected 4 — The same code and message as step 2', async () => {
        expect(errors[1].code, '[Expected 4] The code is WH-WAREHOUSE_NOT_FOUND').toBe('WH-WAREHOUSE_NOT_FOUND');
        expect(errors[1].message, '[Expected 4] The message is the same as in step 2').toBe(`창고를 찾을 수 없습니다. - id: ${supplier.id}`);
      });

      const stored: Array<boolean | undefined> = [];
      await step('Act: Step 5 — Read the stored flag of both rows', async () => {
        stored.push(await storedManaged(skus[0].skuId, supplier.id), await storedManaged(skus[1].skuId, supplier.id));
      });

      await step('Assert: Expected 5 — Line A is still true and line B is still false', async () => {
        expect(stored[0], '[Expected 5] Line A (DEMO-SKU-0001) is still true').toBe(true);
        expect(stored[1], '[Expected 5] Line B (DEMO-SKU-0002) is still false').toBe(false);
      });
    } finally {
      for (const sku of skus) if (supplier.id) await stockDb.deleteStock(sku.skuId, supplier.id);
    }
  });

  test('TC_US134_288 — Save rejects a stock row deleted while the dialog is open', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    const wd = new StockWarehouseDetailPage(page);
    const label = 'WD288';
    const cj = world.warehouses.CJ;
    const message = 'SKU의 재고가 존재하지 않습니다.';
    await tcMeta(
      'TC_US134_288',
      'Medium',
      TAGS,
      `With 창고별 상세 open on a 관리함 row whose 5 CS units were released (CS 0), the stock row is deleted in the database: the dialog does not change; switching to 관리안함 and saving is rejected with WH-STOCK_NOT_FOUND "${message}" (no SKU or warehouse id), and the dialog stays open on 관리안함. The deletion is a DB fixture as the TC asks. ${RELEASE_NOTE} ${OWN_NOTE}`,
    );
    let sku!: WorldSku;
    let save!: CsSave;
    let before: string[] = [];
    let after: string[] = [];

    await step('Arrange: Pre-condition 1–3 — Own SKU in CJ Incheon Aam, 관리함, CS 5 released to 0', async () => {
      sku = await ownPhysicalSku(world, label);
      await releasedCsRow(world, stockApi, sku, cj, { available: 10, cs: 5 });
      await showOwn(wd, world, label);
    });

    await step('Act: Step 1 — Tick the row and click 창고별 상세', async () => {
      await wd.openDetail([wd.row(sku.skuCode, cj.name)]);
      before = (await wd.detail.rows.first().locator('td').allTextContents()).map((text) => text.trim());
    });

    await step('Assert: Expected 1 — The dialog opens with 1 row', async () => {
      await expect(wd.detail.rows, '[Expected 1] The dialog has exactly 1 row').toHaveCount(1);
    });

    await step('Act: Step 2 — Delete that stock row in the database while the dialog stays open', async () => {
      await stockDb.deleteStock(sku.skuId, cj.id);
      expect(await storedManaged(sku.skuId, cj.id), 'The stock row is gone from the database').toBeUndefined();
      after = (await wd.detail.rows.first().locator('td').allTextContents()).map((text) => text.trim());
    });

    await step('Assert: Expected 2 — Nothing on the dialog changes', async () => {
      await expect(wd.detail.rows, '[Expected 2] The dialog still has 1 row').toHaveCount(1);
      expect(after, '[Expected 2] The row cells are unchanged').toEqual(before);
      await expect(wd.managedRadio(0, true), '[Expected 2] The radio is still on 관리함').toBeChecked();
    });

    await step('Act: Step 3 — Set CS재고 관리여부 to 관리안함 and click 저장', async () => {
      await wd.setManaged(0, false);
      save = await wd.saveDetail();
    });

    await step(`Assert: Expected 3 — WH-STOCK_NOT_FOUND: ${message}, with no SKU id or warehouse id`, async () => {
      expect(save.status, '[Expected 3] The save is rejected with a 4xx status').toBeGreaterThanOrEqual(400);
      expect(save.status, '[Expected 3] The rejection is not a server error').toBeLessThan(500);
      expect(save.code, '[Expected 3] The code is WH-STOCK_NOT_FOUND').toBe('WH-STOCK_NOT_FOUND');
      expect(save.message, '[Expected 3] The message is the stock-not-found message').toBe(message);
      await expect(wd.detail.errorAlert, `[Expected 3] The dialog displays ${message}`).toHaveText(message);
      expect(save.message, '[Expected 3] The message carries no SKU id').not.toContain(String(sku.skuId));
      expect(save.message, '[Expected 3] The message carries no warehouse id').not.toContain(String(cj.id));
    });

    await step('Act: Step 4 — See whether the dialog is still open and still holds the picked value', async () => {
      await expect(wd.detail.root, 'The dialog is shown').toBeVisible();
    });

    await step('Assert: Expected 4 — The dialog is still open and the radio still holds 관리안함', async () => {
      await expect(wd.detail.root, '[Expected 4] The dialog is still open').toBeVisible();
      await expect(wd.managedRadio(0, false), '[Expected 4] The radio still holds 관리안함 (Not managed)').toBeChecked();
    });
  });

  test('TC_US134_289 — A CS-flag save that loses a race with another save is refused with the concurrent-change message', async ({ page, world }) => {
    const step = makeStep(page);
    const wdA = new StockWarehouseDetailPage(page);
    const label = 'WD289';
    const cj = world.warehouses.CJ;
    const conflict = '다른 요청이 이 자원을 먼저 변경했습니다. 새로고침 후 다시 시도하세요.';
    await tcMeta(
      'TC_US134_289',
      'Medium',
      TAGS,
      `2 browser sessions (2 tabs of the logged-in context) open 창고별 상세 on the same 관리함 row with CS 0 and both pick 관리안함; both save calls are held in the browser and released together so they reach the server at the same moment. One must go through with ${SAVED}; the other must be refused with CMN-4090 "${conflict}" (not a 500) and keep its dialog open on 관리안함; the reloaded list shows ${NOT_MANAGED}. Defect observed in the 06/10 run: both concurrent saves were accepted (200 + 200) — the CS-flag API has no concurrent-change (optimistic lock) check; Expected 3–4 are asserted as the TC writes them (soft, so Expected 5 still runs). ${OWN_NOTE}`,
    );
    let sku!: WorldSku;
    const pageB = await page.context().newPage();
    const wdB = new StockWarehouseDetailPage(pageB);
    const outcomes: Array<{ status: number; code: string; message: string }> = [];
    let loser = -1;
    let cell = '';

    try {
      await step('Arrange: Pre-condition 1–3 — Own SKU in CJ Incheon Aam, 관리함 with CS 0; 2 sessions A and B', async () => {
        sku = await ownPhysicalSku(world, label);
        await world.seedStock(sku, cj, { available: 10, csManaged: true });
        await pageB.setViewportSize({ width: 1920, height: 1080 });
        await showOwn(wdA, world, label);
        await showOwn(wdB, world, label);
      });

      await step('Act: Step 1 — In sessions A and B, tick the row and click 창고별 상세', async () => {
        await wdA.openDetail([wdA.row(sku.skuCode, cj.name)]);
        await wdB.openDetail([wdB.row(sku.skuCode, cj.name)]);
      });

      await step('Assert: Expected 1 — Both dialogs open on the same row', async () => {
        for (const [name, wd] of [['A', wdA], ['B', wdB]] as const) {
          await expect(wd.detail.rows, `[Expected 1] Session ${name}: the dialog has 1 row`).toHaveCount(1);
          await expect(wd.dialogCell(0, 0), `[Expected 1] Session ${name}: the row is ${sku.skuCode}`).toHaveText(sku.skuCode);
        }
      });

      await step('Act: Step 2 — In both sessions set CS재고 관리여부 to 관리안함', async () => {
        await wdA.setManaged(0, false);
        await wdB.setManaged(0, false);
      });

      await step('Assert: Expected 2 — Both radio buttons show 관리안함', async () => {
        await expect(wdA.managedRadio(0, false), '[Expected 2] Session A shows 관리안함').toBeChecked();
        await expect(wdB.managedRadio(0, false), '[Expected 2] Session B shows 관리안함').toBeChecked();
      });

      await step('Act: Step 3 — Send both saves at the same moment', async () => {
        const sessions = [wdA, wdB];
        const holds = await Promise.all(sessions.map((wd) => wd.holdCsWrite()));
        try {
          const responses = sessions.map((wd) => wd.nextCsResponse());
          for (const wd of sessions) await wd.detail.clickSave();
          await Promise.all(holds.map((hold) => hold.seen));
          holds.forEach((hold) => hold.release());
          outcomes.push(...(await Promise.all(responses)));
        } finally {
          for (const hold of holds) {
            hold.release();
            await hold.dispose();
          }
        }
        loser = outcomes.findIndex((outcome) => outcome.status >= 300);
      });

      await step(`Assert: Expected 3 — One save goes through and shows ${SAVED}`, async () => {
        const winners = outcomes.map((outcome, index) => (outcome.status < 300 ? index : -1)).filter((index) => index >= 0);
        expect.soft(winners.length, `[Expected 3] Exactly one save goes through (statuses ${outcomes.map((o) => o.status).join(', ')})`).toBe(1);
        if (winners.length > 0) await expect.soft([wdA, wdB][winners[0]].lastToast(), `[Expected 3] The winning session shows ${SAVED}`).toContainText(SAVED);
      });

      await step('Act: Step 4 — Read the response and the dialog of the session that lost', async () => {
        if (loser >= 0) {
          const shot = await [wdA, wdB][loser].screenshotPng();
          await test.info().attach(`Session ${loser === 0 ? 'A' : 'B'} (lost the race)`, { body: shot, contentType: 'image/png' });
        }
      });

      await step(`Assert: Expected 4 — CMN-4090: ${conflict} — not a 500 — and its dialog stays open with 관리안함`, async () => {
        expect.soft(loser, '[Expected 4] One session lost the race').toBeGreaterThanOrEqual(0);
        const lost = outcomes[loser] ?? { status: 0, code: '', message: '' };
        const wd = [wdA, wdB][Math.max(loser, 0)];
        expect.soft(lost.status, '[Expected 4] The losing save is not a 500').toBeLessThan(500);
        expect.soft(lost.code, '[Expected 4] The code is CMN-4090').toBe('CMN-4090');
        expect.soft(lost.message, '[Expected 4] The message is the concurrent-change message').toBe(conflict);
        await expect.soft(wd.detail.root, '[Expected 4] The losing dialog stays open').toBeVisible();
        await expect.soft(wd.managedRadio(0, false), '[Expected 4] 관리안함 is still picked').toBeChecked();
      });

      await step('Act: Step 5 — Reload the list and read the row', async () => {
        await showOwn(wdA, world, label);
        cell = await wdA.cellText(wdA.row(sku.skuCode, cj.name), 'col.csQuantity');
      });

      await step(`Assert: Expected 5 — The row shows ${NOT_MANAGED}`, async () => {
        expect(cell, `[Expected 5] The row reads ${NOT_MANAGED}`).toBe(NOT_MANAGED);
      });
    } finally {
      await pageB.close();
    }
  });

  test('TC_US134_290 — 100 picked rows open and save with no count limit or warning', async ({ page, world }) => {
    const step = makeStep(page);
    const wd = new StockWarehouseDetailPage(page);
    const prefix = `W290 run ${world.tag.slice(4)}`;
    const cj = world.warehouses.CJ;
    await tcMeta(
      'TC_US134_290',
      'Medium',
      TAGS,
      `With 페이지당 100개 and the header tick box, 100 physical rows in a WMS warehouse are ticked; 창고별 상세 opens with 100 rows and no warning, count limit or trimming; 저장 with no change sends one request carrying all 100 rows and no count-limit message appears before it. Data: the test creates its own 100 physical SKUs (5 groups "${'W290 run <tag> G1…5'}") with a stock row each in the automation copy of CJ Incheon Aam, and filters the list to them so exactly 100 valid rows sit on the page (the TC's ≥ 120 rows are only needed to fill a page of 100).`,
    );
    let skus: WorldSku[] = [];
    let ticked = 0;
    let alertsBefore = -1;
    let save!: CsSave;

    await step('Arrange: Pre-condition 1–3 — 100 own physical stock rows in CJ Incheon Aam (WMS), list at 100 rows per page; network capture on', async () => {
      skus = await bulkPhysicalSkus(world, ['WA', 'WB', 'WC', 'WD', 'WE'], prefix, 100);
      for (const sku of skus) await world.seedStock(sku, cj, { available: 5, csManaged: false });
      expect(skus.length, '100 own physical SKUs exist').toBe(100);
    });

    await step('Act: Step 1 — Open 재고 관리, set 페이지당 to 100개 and tick all rows with the header tick box', async () => {
      await wd.open();
      await wd.search('SKU_GROUP_NAME', prefix);
      await wd.choosePageSize(100);
      await wd.selectAllCheckbox.check();
      ticked = await wd.table.locator('tbody input[type="checkbox"]:checked').count();
    });

    await step('Assert: Expected 1 — All 100 valid rows are ticked', async () => {
      expect(await wd.dataRowCount(), '[Expected 1] The page shows 100 rows').toBe(100);
      expect(ticked, '[Expected 1] All 100 rows are ticked').toBe(100);
    });

    await step('Act: Step 2 — Click 창고별 상세 and count the rows in the dialog', async () => {
      await wd.clickDetail();
      await wd.detail.waitOpen();
    });

    await step('Assert: Expected 2 — The dialog opens with 100 rows, 1 per picked row', async () => {
      await expect(wd.detail.rows, '[Expected 2] The dialog has 100 rows').toHaveCount(100);
    });

    await step('Act: Step 3 — Look for any warning, trimming notice or count limit', async () => {
      alertsBefore = await wd.detail.root.locator('.alert').count();
    });

    await step('Assert: Expected 3 — No warning, no count-limit message, the row list is not trimmed', async () => {
      expect(alertsBefore, '[Expected 3] The dialog shows no warning or count-limit message').toBe(0);
      await expect(wd.guardAlert, '[Expected 3] No guard message is shown above the list').toHaveCount(0);
      await expect(wd.detail.rows, '[Expected 3] The row list is not trimmed (still 100 rows)').toHaveCount(100);
    });

    await step('Act: Step 4 — Click 저장 without changing any flag and read the save request', async () => {
      save = await wd.saveDetail();
    });

    await step('Assert: Expected 4 — The save request carries all 100 rows and no count-limit message appears before it', async () => {
      const items = save.requestBody.items ?? [];
      expect(items.length, '[Expected 4] The save request carries 100 rows').toBe(100);
      expect(new Set(items.map((entry) => String(entry.skuId))).size, '[Expected 4] The 100 rows are the 100 picked SKUs').toBe(100);
      expect(save.status, `[Expected 4] No count limit stops the request (got ${save.status} ${save.code} ${save.message})`).toBeLessThan(300);
    });
  });

  test('TC_US134_291 — A CS-flag request with more than 100 rows is turned down whole', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    const prefix = `X291 run ${world.tag.slice(4)}`;
    const cj = world.warehouses.CJ;
    const message = '변경 대상은 최대 100건까지 지정할 수 있습니다.';
    await tcMeta(
      'TC_US134_291',
      'Medium',
      TAGS,
      `A PATCH /stocks/cs-stock-management call listing 101 distinct rows set to not managed is rejected with CMN-4000 "${message}" and none of the 101 flags changes; the same call with exactly 100 of them goes through and those 100 rows are stored as not managed. API test (SPEC-GAP-29: the screen cannot tick 101 rows). Data: 101 own physical SKUs (6 groups "X291 run <tag> G1…6"), each with a 관리함 stock row with CS 0 in the automation copy of CJ Incheon Aam.`,
    );
    let skus: WorldSku[] = [];
    let over!: ApiResult<unknown>;
    let exact!: ApiResult<unknown>;
    let managedCount = -1;

    const countManaged = async (list: WorldSku[], managed: boolean) => {
      const rows = await stockDb.query('SELECT COUNT(*) AS n FROM stock WHERE warehouse_id = ? AND sku_id IN (?) AND cs_stock_managed = ?', [cj.id, list.map((sku) => sku.skuId), managed ? 1 : 0]);
      return Number(rows[0]?.n ?? 0);
    };

    await step('Arrange: Pre-condition 1–4 — 101 own physical stock rows in CJ Incheon Aam, all 관리함 with CS 0; an authenticated API client', async () => {
      skus = await bulkPhysicalSkus(world, ['XA', 'XB', 'XC', 'XD', 'XE', 'XF'], prefix, 101);
      for (const sku of skus) await world.seedStock(sku, cj, { available: 1, csManaged: true });
      expect(await countManaged(skus, true), '101 rows are 관리함').toBe(101);
    });

    await step('Act: Step 1 — Send a CS-flag request listing 101 distinct rows, each set to not managed', async () => {
      over = await stockApi.setCsManagement({ items: skus.map((sku) => item(sku, cj, false)) });
    });

    await step('Assert: Expected 1 — The request is turned down', async () => {
      expect(over.status, '[Expected 1] The request is rejected with a 4xx status').toBeGreaterThanOrEqual(400);
      expect(over.status, '[Expected 1] The rejection is not a server error').toBeLessThan(500);
    });

    let error = { status: 0, code: '', message: '' };
    await step('Act: Step 2 — Read the code and the message that come back', async () => {
      error = errorOf(over);
    });

    await step(`Assert: Expected 2 — CMN-4000: ${message}`, async () => {
      expect(error.code, '[Expected 2] The code is CMN-4000').toBe('CMN-4000');
      expect(error.message, '[Expected 2] The message is the 100-target limit message').toBe(message);
    });

    await step('Act: Step 3 — Read the flag of the 101 rows', async () => {
      managedCount = await countManaged(skus, true);
    });

    await step('Assert: Expected 3 — All 101 rows are still 관리함 — nothing is saved', async () => {
      expect(managedCount, '[Expected 3] All 101 rows are still 관리함 (Managed)').toBe(101);
    });

    await step('Act: Step 4 — Send the same request with exactly 100 of those rows', async () => {
      exact = await stockApi.setCsManagement({ items: skus.slice(0, 100).map((sku) => item(sku, cj, false)) });
    });

    await step(`Assert: Expected 4 — The request goes through and the 100 rows are ${NOT_MANAGED}`, async () => {
      expect(exact.status, `[Expected 4] The request with 100 rows is accepted (got ${exact.status} ${JSON.stringify(exact.body)})`).toBeLessThan(300);
      expect(await countManaged(skus.slice(0, 100), false), `[Expected 4] The 100 rows are stored as ${NOT_MANAGED}`).toBe(100);
    });
  });

  test('TC_US134_292 — The save response lists only the rows whose flag changed', async ({ page, world }) => {
    const step = makeStep(page);
    const wd = new StockWarehouseDetailPage(page);
    const label = 'WD292';
    const cj = world.warehouses.CJ;
    const second = world.warehouses.DAEGU ?? cj;
    await tcMeta(
      'TC_US134_292',
      'Medium',
      TAGS,
      `3 rows are opened in 창고별 상세 — 관리함 with CS 0 in CJ Incheon Aam (TC DEMO-SKU-0001), 관리함 in CJ Daegu warehouse (DEMO-SKU-0008) and 관리안함 in CJ Incheon Aam (DEMO-SKU-0011); only the first is switched to 관리안함. The save closes the dialog, its response lists exactly 1 id (the switched row, matched against its stock id or SKU id) and the message is ${SAVED} with no count; only the switched row changes. The request still carries all 3 rows (the screen sends every line). ${world.warehouses.DAEGU ? '' : 'No CJ Daegu warehouse could be built on dev, so the 2nd managed row sits in CJ Incheon Aam. '}${OWN_NOTE}`,
    );
    let skus: WorldSku[] = [];
    let stockId = 0;
    let save!: CsSave;
    let ids: Array<string | number> = [];
    const cells: string[] = [];

    await step('Arrange: Pre-condition 1–5 — Own rows: 관리함 CS 0 (CJ Incheon Aam), 관리함 (CJ Daegu warehouse), 관리안함 (CJ Incheon Aam)', async () => {
      skus = await ownSkus(world, label, 3);
      await world.seedStock(skus[0], cj, { available: 10, csManaged: true });
      await world.seedStock(skus[1], second, { available: 14, reserved: 12, cs: 8, csManaged: true });
      await world.seedStock(skus[2], cj, { available: 5, csManaged: false });
      stockId = Number((await stockDb.stock(skus[0].skuId, cj.id))?.id ?? 0);
      await showOwn(wd, world, label);
    });

    await step('Act: Step 1 — Tick the 3 rows and click 창고별 상세', async () => {
      await wd.openDetail([wd.row(skus[0].skuCode, cj.name), wd.row(skus[1].skuCode, second.name), wd.row(skus[2].skuCode, cj.name)]);
    });

    await step('Assert: Expected 1 — The dialog opens with 3 rows', async () => {
      await expect(wd.detail.rows, '[Expected 1] The dialog has exactly 3 rows').toHaveCount(3);
    });

    await step('Act: Step 2 — Set the DEMO-SKU-0001 row to 관리안함, leave the other 2 rows and click 저장', async () => {
      await wd.setManaged(await wd.dialogRowIndex(skus[0].skuCode, cj.name), false);
      save = await wd.saveDetail();
    });

    await step('Assert: Expected 2 — The save finishes and the dialog closes', async () => {
      expect(save.status, `[Expected 2] The save call is accepted (got ${save.status} ${save.code} ${save.message})`).toBeLessThan(300);
      await expect(wd.detail.root, '[Expected 2] The dialog closes').toHaveCount(0);
    });

    await step('Act: Step 3 — Read the save response', async () => {
      ids = responseIds(save.responseBody);
    });

    await step('Assert: Expected 3 — The response lists exactly 1 id — the DEMO-SKU-0001 × CJ Incheon Aam row', async () => {
      expect(ids.length, `[Expected 3] The response lists exactly 1 id (body ${JSON.stringify(save.responseBody)})`).toBe(1);
      expect([String(stockId), String(skus[0].skuId)], '[Expected 3] The listed id is the switched row').toContain(String(ids[0]));
    });

    let toast = '';
    await step('Act: Step 4 — Read the message on the screen and the flag of the 3 rows on the list', async () => {
      toast = squash(await wd.lastToast().innerText());
      cells.push(
        await wd.cellText(wd.row(skus[0].skuCode, cj.name), 'col.csQuantity'),
        await wd.cellText(wd.row(skus[1].skuCode, second.name), 'col.csQuantity'),
        await wd.cellText(wd.row(skus[2].skuCode, cj.name), 'col.csQuantity'),
      );
    });

    await step(`Assert: Expected 4 — The message is ${SAVED} with no row count; only DEMO-SKU-0001 changed to ${NOT_MANAGED}`, async () => {
      expect(toast, `[Expected 4] The message reads ${SAVED}`).toContain(SAVED);
      expect(toast, '[Expected 4] The message carries no row count').not.toMatch(/\d/);
      expect(cells[0], `[Expected 4] DEMO-SKU-0001 reads ${NOT_MANAGED}`).toBe(NOT_MANAGED);
      expect(cells[1], '[Expected 4] DEMO-SKU-0008 is unchanged (CS 8, 관리함)').toBe('8');
      expect(cells[2], `[Expected 4] DEMO-SKU-0011 is unchanged (${NOT_MANAGED})`).toBe(NOT_MANAGED);
      expect(await storedManaged(skus[1].skuId, second.id), '[Expected 4] DEMO-SKU-0008 is still stored as managed').toBe(true);
    });
  });

  test('TC_US134_293 — The CS managed flag can be set only on a WMS warehouse row', async ({ page, world }) => {
    const step = makeStep(page);
    const wd = new StockWarehouseDetailPage(page);
    const wms = world.row('SKU0001', world.warehouses.CJ);
    const pickup = world.row('SKU0004', world.warehouses.PICKUP);
    await tcMeta(
      'TC_US134_293',
      'Medium',
      TAGS,
      `On DEMO-SKU-0001 (CJ Incheon Aam, WMS) the 창고별 상세 radio switches between 관리함 and 관리안함 (switched back, never saved); DEMO-SKU-0004 (Demo Pickup Point) is stopped by the CJ-warehouse guard; neither the 재고 조정 nor the 재고 전환 dialog carries a CS-managed control and no other toolbar button sets the flag; both CS columns of DEMO-SKU-0004 read "-", not ${NOT_MANAGED}. Read-only on the shared rows. ${WORLD_NOTE}`,
    );
    const switched: boolean[] = [];
    let guard = '';
    let opened = false;
    const flagControls: Record<string, number> = {};
    let toolbarNames: string[] = [];
    const cells: string[] = [];

    const flagControlsIn = async (root: Locator) =>
      (await root.locator('input[id^="cs-"]').count()) + (await root.getByText(KO('whdetail.col.csStockManaged'), { exact: true }).count());

    await step('Arrange: Pre-condition 1–3 — DEMO-SKU-0001 in CJ Incheon Aam (WMS), DEMO-SKU-0004 in Demo Pickup Point (PICKUP_LOCATION)', async () => {
      await wd.openWorld(world);
    });

    await step('Act: Step 1 — Tick DEMO-SKU-0001, click 창고별 상세 and see whether CS재고 관리여부 can be changed', async () => {
      await wd.openDetail([wd.row(wms.sku.skuCode, wms.warehouse.name)]);
      await wd.setManaged(0, false);
      switched.push(await wd.managedRadio(0, false).isChecked());
      await wd.setManaged(0, true);
      switched.push(await wd.managedRadio(0, true).isChecked());
    });

    await step('Assert: Expected 1 — The dialog opens and the radio switches between 관리함 and 관리안함', async () => {
      await expect(wd.detail.root, '[Expected 1] The dialog is open').toBeVisible();
      expect(switched[0], '[Expected 1] The radio switches to 관리안함 (Not managed)').toBe(true);
      expect(switched[1], '[Expected 1] The radio switches back to 관리함 (Managed)').toBe(true);
    });

    await step('Act: Step 2 — Close the dialog, tick DEMO-SKU-0004 and click 창고별 상세', async () => {
      await wd.closeDetail();
      await wd.untickAll();
      await wd.tick(wd.row(pickup.sku.skuCode, pickup.warehouse.name), `${pickup.sku.skuCode} @ ${pickup.warehouse.name}`);
      await wd.clickDetail();
      guard = await wd.guardText();
      opened = (await wd.openDialogs.count()) > 0;
    });

    await step('Assert: Expected 2 — The CJ-warehouse guard stops the action and no dialog opens', async () => {
      expect(guard, `[Expected 2] The guard reads ${NON_CJ_GUARD}`).toBe(NON_CJ_GUARD);
      expect(opened, '[Expected 2] No dialog opens').toBe(false);
    });

    await step('Act: Step 3 — Search the whole screen for any other button that could set the CS managed flag', async () => {
      toolbarNames = (await wd.toolbarButtons.locator(':scope > *').allInnerTexts()).map((text) => text.trim());
      await wd.untickAll();
      await wd.tick(wd.row(wms.sku.skuCode, wms.warehouse.name), `${wms.sku.skuCode} @ ${wms.warehouse.name}`);
      await wd.clickToolbar('btn.adjustStock');
      await wd.adjustment.waitOpen();
      flagControls.adjustment = await flagControlsIn(wd.adjustment.root);
      await closeDialog(wd.adjustment);
      await wd.clickToolbar('btn.convertStock');
      await wd.conversion.waitOpen();
      flagControls.conversion = await flagControlsIn(wd.conversion.root);
      await closeDialog(wd.conversion);
    });

    await step('Assert: Expected 3 — No other button sets this flag — neither 재고 조정 nor 재고 전환 carries it', async () => {
      expect(flagControls.adjustment, '[Expected 3] The 재고 조정 (Stock adjustment) dialog has no CS-managed control').toBe(0);
      expect(flagControls.conversion, '[Expected 3] The 재고 전환 (Stock conversion) dialog has no CS-managed control').toBe(0);
      const flagButtons = toolbarNames.filter((name) => name !== KO('btn.warehouseDetail') && /CS|관리여부/.test(name));
      expect(flagButtons, '[Expected 3] No other toolbar button is about the CS managed flag').toEqual([]);
    });

    await step('Act: Step 4 — Read the 2 CS columns of the DEMO-SKU-0004 row on the list', async () => {
      const row = wd.row(pickup.sku.skuCode, pickup.warehouse.name);
      cells.push(await wd.cellText(row, 'col.csQuantity'), await wd.cellText(row, 'col.csOrderableQuantity'));
    });

    await step(`Assert: Expected 4 — Both CS columns show a dash (-) and not ${NOT_MANAGED}`, async () => {
      expect(cells[0], '[Expected 4] CS재고(가용재고) shows "-"').toBe('-');
      expect(cells[1], '[Expected 4] CS재고(CS가능수량) shows "-"').toBe('-');
    });
  });

  test('TC_US134_294 — Cancel asks first and clears the dialog when something has been changed', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    const wd = new StockWarehouseDetailPage(page);
    const label = 'WD294';
    const cj = world.warehouses.CJ;
    const question = KO('msg.closeWithoutSaving');
    await tcMeta(
      'TC_US134_294',
      'Low',
      TAGS,
      `취소 on an unchanged 창고별 상세 closes it with no question; after switching to 관리안함, 취소 opens a confirm box reading "${question}" and confirming closes the dialog; reopening shows 관리함 again. Nothing is saved. ${RELEASE_NOTE} ${OWN_NOTE}`,
    );
    let sku!: WorldSku;
    let askedFirst = true;
    let confirmText = '';

    await step('Arrange: Pre-condition 1–2 — Own SKU in CJ Incheon Aam, 관리함, CS 5 released to 0', async () => {
      sku = await ownPhysicalSku(world, label);
      await releasedCsRow(world, stockApi, sku, cj, { available: 10, cs: 5 });
      await showOwn(wd, world, label);
    });

    await step('Act: Step 1 — Tick the row, click 창고별 상세 and click 취소 with nothing changed', async () => {
      await wd.openDetail([wd.row(sku.skuCode, cj.name)]);
      await wd.detail.clickCancel();
      await expect.poll(async () => (await wd.detail.confirmClose.isVisible()) || (await wd.detail.root.count()) === 0, { message: 'The dialog reacts to 취소' }).toBe(true);
      askedFirst = await wd.detail.confirmClose.isVisible();
    });

    await step('Assert: Expected 1 — The dialog closes with no question', async () => {
      expect(askedFirst, '[Expected 1] No confirm box is shown').toBe(false);
      await expect(wd.detail.root, '[Expected 1] The dialog closes').toHaveCount(0);
    });

    await step('Act: Step 2 — Open the dialog again, set CS재고 관리여부 to 관리안함 and click 취소', async () => {
      await wd.openDetail([wd.row(sku.skuCode, cj.name)]);
      await wd.setManaged(0, false);
      await wd.detail.clickCancel();
    });

    await step('Assert: Expected 2 — A confirm dialog opens', async () => {
      await expect(wd.detail.confirmClose, '[Expected 2] A confirm dialog opens').toBeVisible();
    });

    await step('Act: Step 3 — Read the confirm dialog, then confirm closing', async () => {
      confirmText = squash(await wd.detail.confirmClose.innerText());
      await wd.detail.confirmDiscard();
    });

    await step(`Assert: Expected 3 — The confirm dialog shows "${question}" and the dialog closes on confirming`, async () => {
      expect(confirmText, `[Expected 3] The confirm dialog reads ${question}`).toContain(question);
      await expect(wd.detail.root, '[Expected 3] The 창고별 상세 dialog closes').toHaveCount(0);
      await expect(wd.detail.confirmClose, '[Expected 3] The confirm dialog closes').toHaveCount(0);
    });

    await step('Act: Step 4 — Open the dialog again and read CS재고 관리여부', async () => {
      await wd.openDetail([wd.row(sku.skuCode, cj.name)]);
    });

    await step('Assert: Expected 4 — The radio button is back on 관리함', async () => {
      await expect(wd.managedRadio(0, true), '[Expected 4] The radio is back on 관리함 (Managed)').toBeChecked();
    });
  });

  test('TC_US134_295 — A CS-flag request listing the same stock row twice is turned down whole', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    const wd = new StockWarehouseDetailPage(page);
    const label = 'WD295';
    const cj = world.warehouses.CJ;
    const message = '같은 SKU와 창고를 중복으로 지정할 수 없습니다.';
    await tcMeta(
      'TC_US134_295',
      'Medium',
      TAGS,
      `A PATCH /stocks/cs-stock-management call listing line A × CJ Incheon Aam twice (managed, then not managed) and line B × CJ Incheon Aam once (not managed) is rejected whole with WH-DUPLICATED_CS_STOCK_MANAGEMENT_TARGET "${message}": both rows stay 관리함 on the list, B included; the same call with each pair listed once (both not managed) goes through and both flags are written. ${OWN_NOTE}`,
    );
    let skus: WorldSku[] = [];
    let duplicated!: ApiResult<unknown>;
    let single!: ApiResult<unknown>;
    const cells: string[] = [];

    await step('Arrange: Pre-condition 1–3 — Own lines A and B in CJ Incheon Aam (WMS), both 관리함', async () => {
      skus = await ownSkus(world, label, 2);
      for (const sku of skus) await world.seedStock(sku, cj, { available: 10, csManaged: true });
    });

    await step('Act: Step 1 — Send a CS-flag request listing A twice (관리함, then 관리안함) and B once (관리안함)', async () => {
      duplicated = await stockApi.setCsManagement({ items: [item(skus[0], cj, true), item(skus[0], cj, false), item(skus[1], cj, false)] });
    });

    await step('Assert: Expected 1 — The request is turned down', async () => {
      expect(duplicated.status, '[Expected 1] The request is rejected with a 4xx status').toBeGreaterThanOrEqual(400);
      expect(duplicated.status, '[Expected 1] The rejection is not a server error').toBeLessThan(500);
    });

    let error = { status: 0, code: '', message: '' };
    await step('Act: Step 2 — Read the code and the message that come back', async () => {
      error = errorOf(duplicated);
    });

    await step(`Assert: Expected 2 — WH-DUPLICATED_CS_STOCK_MANAGEMENT_TARGET: ${message}`, async () => {
      expect(error.code, '[Expected 2] The code is WH-DUPLICATED_CS_STOCK_MANAGEMENT_TARGET').toBe('WH-DUPLICATED_CS_STOCK_MANAGEMENT_TARGET');
      expect(error.message, '[Expected 2] The message is the duplicated-target message').toBe(message);
    });

    await step('Act: Step 3 — Open 재고 관리 and read the CS재고 관리여부 value of both rows', async () => {
      await showOwn(wd, world, label);
      for (const sku of skus) cells.push(await wd.cellText(wd.row(sku.skuCode, cj.name), 'col.csQuantity'));
    });

    await step('Assert: Expected 3 — Both rows are unchanged (관리함), line B included', async () => {
      expect(cells[0], '[Expected 3] Line A still shows a number (관리함)').toBe('0');
      expect(cells[1], '[Expected 3] Line B still shows a number (관리함) — the whole request was rejected').toBe('0');
      expect(await storedManaged(skus[0].skuId, cj.id), '[Expected 3] Line A is still stored as managed').toBe(true);
      expect(await storedManaged(skus[1].skuId, cj.id), '[Expected 3] Line B is still stored as managed').toBe(true);
    });

    await step('Act: Step 4 — Send the same request with each pair listed once and read the result', async () => {
      single = await stockApi.setCsManagement({ items: [item(skus[0], cj, false), item(skus[1], cj, false)] });
    });

    await step('Assert: Expected 4 — The request goes through and both flags are written', async () => {
      expect(single.status, `[Expected 4] The request is accepted (got ${single.status} ${JSON.stringify(single.body)})`).toBeLessThan(300);
      expect(await storedManaged(skus[0].skuId, cj.id), '[Expected 4] Line A is written as not managed').toBe(false);
      expect(await storedManaged(skus[1].skuId, cj.id), '[Expected 4] Line B is written as not managed').toBe(false);
    });
  });
});

/** Ids trong body trả về của PATCH CS (mảng gốc, hoặc mảng đầu tiên trong object: `ids` / `items` …). */
function responseIds(body: unknown): Array<string | number> {
  if (Array.isArray(body)) return body.map((entry) => (typeof entry === 'object' && entry ? ((entry as { id?: number }).id ?? JSON.stringify(entry)) : entry) as string | number);
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const key = ['ids', 'stockIds', 'updatedIds', 'items'].find((name) => Array.isArray(record[name])) ?? Object.keys(record).find((name) => Array.isArray(record[name]));
    if (key) return responseIds(record[key]);
  }
  return [];
}

/** Đóng dialog ghi (재고 조정 / 재고 전환) bằng 취소, xác nhận nếu được hỏi. */
async function closeDialog(dialog: { clickCancel: () => Promise<void>; confirmClose: Locator; confirmDiscard: () => Promise<void>; root: Locator }): Promise<void> {
  await dialog.clickCancel();
  await expect(async () => {
    if (await dialog.confirmClose.isVisible()) await dialog.confirmDiscard();
    await expect(dialog.root).toHaveCount(0, { timeout: 1_000 });
  }, 'The dialog closes').toPass({ timeout: 15_000 });
}
