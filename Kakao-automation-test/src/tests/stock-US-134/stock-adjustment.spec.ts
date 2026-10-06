import { test, expect } from '@fixtures/stock.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { squash, toNumber } from '@pages/stock-calculation.page';
import { ADJUST_URL, CONVERT_URL, CS_URL, SaveOutcome, StockAdjustmentPage, daeguOf, ownSkuLines, ownStockSku } from '@pages/stock-adjustment.page';
import { stx } from '@utils/stock.i18n';
import { WORLD_NOTE, stockTags } from '@utils/stock-spec';
import { stockDb } from '@utils/stock-db';
import { env } from '@utils/env.config';

/**
 * US134 — nhóm [Adjustment] (TC_US134_205–227): dialog 재고 조정 trên màn 재고 관리. Nguồn TC: SCRATCH/us134/TC_US134_<n>.txt
 * (Steps N / Expected N → `Act: Step N` / `Assert: Expected N`). Kỳ vọng assert theo TC; chỗ UI khác TC ghi trong description.
 * Mọi lần lưu ghi lên SKU riêng của test (world.createPhysicalSku + tồn kho dựng bằng DB) — 12 dòng world giữ nguyên.
 */
const TAGS = stockTags('adjustment');
const ko = (key: Parameters<typeof stx>[0]) => stx(key, 'ko');
const REGISTERED = ko('msg.registered');
const BELOW_ZERO = '조정으로 재고를 0 미만으로 줄일 수 없습니다.';
const OWN_NOTE =
  'Data: the DEMO-SKU rows of the shared world must stay untouched, so the test creates its own physical SKU(s) (Partner A, manufacturer M1) in the automation warehouses and seeds the TC stock buckets through the DB (the seed writes no movement); the TC SKU codes map onto those SKUs.';
const DAEGU_NOTE = 'CJ Daegu warehouse = the automation CJ Daegu copy (the automation General warehouse when dev cannot build a CJ_LOGISTICS_DT warehouse).';

test.describe('[Adjustment] Stock management — stock adjustment dialog', () => {
  test('TC_US134_205 — A successful adjustment shows Registered, reloads the list, clears the ticks and records the movement', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_205',
      'Critical',
      TAGS,
      `Ticking a row with total stock 190 / available 120 and saving 증가 10 · 조정 · "Demo stock count correction" closes the dialog, shows 등록되었습니다, reloads the list with no tick left, raises total to 200 and available to 130, and the newest 재고이력 movement reads 조정 · 190 → 200 (measured on total stock) · +10 with the reason and the memo in 비고. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'A205', cj.id, { available: 120, reserved: 40, cs: 20, hold: 10, csManaged: true });
    const row = list.row(sku.skuCode, cj.name);
    const memo = 'Demo stock count correction';
    let rowCount = 0;
    let values: string[] = [];
    let saved: SaveOutcome | undefined;

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; own physical row in CJ Incheon Aam with total 190 / available 120', async () => {
      await list.open('ko');
      await list.findSku(sku);
      await expect(row, 'The own stock row is listed').toBeVisible();
    });

    await step('Act: Step 1 — Tick the row and click 재고 조정 (Stock adjustment)', async () => {
      await list.openAdjustment([row]);
      rowCount = await list.adjustment.rows.count();
      values = await list.adjustment.rowValues(0);
    });

    await step('Assert: Expected 1 — The dialog opens with 1 row showing total stock 190', async () => {
      expect(rowCount, '[Expected 1] The dialog holds exactly 1 row').toBe(1);
      expect(values[3], '[Expected 1] The row shows total stock 190').toBe('190');
    });

    await step('Act: Step 2 — Fill 10 · 증가 (Increase) · 조정 (Adjustment) · the remark, then click 저장 (Save)', async () => {
      await list.adjustment.fillLine(0, { quantity: '10', modifyType: 'ADD', reason: 'ADJUSTMENT', note: memo });
      saved = await list.save(list.adjustment, ADJUST_URL);
    });

    await step('Assert: Expected 2 — The save finishes and the dialog closes', async () => {
      expect(saved?.status, '[Expected 2] The save is accepted').toBeLessThan(300);
      await list.adjustment.expectClosed();
    });

    await step('Act: Step 3 — Read the message that appears and the tick boxes on the list', async () => {
      await expect(list.lastToast(), 'A message appears after the save').toBeVisible();
    });

    await step('Assert: Expected 3 — 등록되었습니다 (Registered.) appears, the list reloaded, no tick box is selected', async () => {
      await expect(list.lastToast(), `[Expected 3] The message reads ${REGISTERED}`).toContainText(REGISTERED);
      expect(saved?.reloaded, '[Expected 3] The list asked for its data again (GET /stock-status)').toBe(true);
      await expect(list.tickedBoxes(), '[Expected 3] No tick box is selected').toHaveCount(0);
    });

    let total = '';
    let available = '';
    await step('Act: Step 4 — Read 전체재고 (Total stock) and 가용재고 (Available stock) on the reloaded row', async () => {
      total = await list.cellText(row, 'col.totalQuantity');
      available = await list.cellText(row, 'col.availableQuantity');
    });

    await step('Assert: Expected 4 — Total stock shows 200 and available stock shows 130', async () => {
      expect(total, '[Expected 4] Total stock is up by exactly 10 to 200').toBe('200');
      expect(available, '[Expected 4] Available stock is up by exactly 10 to 130').toBe('130');
    });

    let newest: Record<string, string> = {};
    await step('Act: Step 5 — Open 재고이력 (Stock history) for the row and read the newest movement', async () => {
      await list.openHistoryOf(row, 'ko');
      newest = (await list.historyLines())[0] ?? {};
    });

    await step('Assert: Expected 5 — 조정 · 190 → 200 on total stock · +10 · 비고 holds the reason and the memo', async () => {
      expect(newest.refType, '[Expected 5] 구분 (Type) is 조정 (Adjustment)').toBe(ko('usageRef.ADJUSTMENT'));
      expect(newest.before, '[Expected 5] 변경전 수량 (Qty before) is 190 — total stock, not available stock 120').toBe('190');
      expect(newest.after, '[Expected 5] 변경 후 수량 (Qty after) is 200').toBe('200');
      expect(newest.change, '[Expected 5] 변경수량 (Change qty) is +10').toBe('+10');
      expect(newest.note, '[Expected 5] 비고 holds the reason 조정').toContain(ko('reason.ADJUSTMENT'));
      expect(newest.note, `[Expected 5] 비고 holds the memo ${memo}`).toContain(memo);
    });
  });

  test('TC_US134_206 — Increase adds and Decrease subtracts the adjustment quantity from available stock row by row', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_206',
      'Critical',
      TAGS,
      `Two rows (available 120 in CJ Incheon Aam, available 200 in CJ Daegu) open together; 증가 is the default on both; row 1 stays 증가, row 2 becomes 차감; saving 5 · 조정 on both shows 등록되었습니다 and gives 125 and 195; the newest movements read +5 and -5. ${OWN_NOTE} ${DAEGU_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const daegu = daeguOf(world);
    const [a, b] = await ownSkuLines(world, 'A206', 2);
    await stockDb.upsertStock(a.skuId, cj.id, { available: 120 });
    await stockDb.upsertStock(b.skuId, daegu.id, { available: 200 });
    const rowA = list.row(a.skuCode, cj.name);
    const rowB = list.row(b.skuCode, daegu.name);
    const initial: string[] = [];
    let indexA = 0;
    let indexB = 1;

    await step('Arrange: Pre-condition 1–4 — Own row A available 120 in CJ Incheon Aam, own row B available 200 in CJ Daegu; quantity 5', async () => {
      await list.open('ko');
    });

    await step('Act: Step 1 — Open 재고 관리 and read 가용재고 (Available stock) of both rows', async () => {
      await list.findGroup(world, 'A206');
      initial.push(await list.cellText(rowA, 'col.availableQuantity'), await list.cellText(rowB, 'col.availableQuantity'));
    });

    await step('Assert: Expected 1 — The initial available stock values are 120 and 200', async () => {
      expect(initial[0], '[Expected 1] Row A (DEMO-SKU-0001) shows available 120').toBe('120');
      expect(initial[1], '[Expected 1] Row B (DEMO-SKU-0003) shows available 200').toBe('200');
    });

    await step('Act: Step 2 — Select both rows and click 재고 조정 (Stock adjustment)', async () => {
      await list.openAdjustment([rowA, rowB]);
      indexA = await list.dialogRowIndex(list.adjustment, a.skuCode, cj.name);
      indexB = await list.dialogRowIndex(list.adjustment, b.skuCode, daegu.name);
    });

    await step('Assert: Expected 2 — The dialog opens with 2 rows', async () => {
      await expect(list.adjustment.rows, '[Expected 2] The dialog holds 2 rows').toHaveCount(2);
    });

    await step('Act: Step 3 — Read the 증가/차감 (Increase/Decrease) choice of both rows', async () => {
      await expect(list.adjustment.modifyRadio(indexA, 'ADD'), 'The direction choice of row A is shown').toBeVisible();
    });

    await step('Assert: Expected 3 — 증가 (Increase) is the default on both rows', async () => {
      await expect(list.adjustment.modifyRadio(indexA, 'ADD'), '[Expected 3] Row A defaults to 증가').toBeChecked();
      await expect(list.adjustment.modifyRadio(indexB, 'ADD'), '[Expected 3] Row B defaults to 증가').toBeChecked();
    });

    await step('Act: Step 4 — Keep row 1 as 증가 (Increase) and change row 2 to 차감 (Decrease)', async () => {
      await list.adjustment.modifyRadio(indexB, 'SUBTRACT').check();
    });

    await step('Assert: Expected 4 — Each row keeps its own direction', async () => {
      await expect(list.adjustment.modifyRadio(indexA, 'ADD'), '[Expected 4] Row A keeps 증가').toBeChecked();
      await expect(list.adjustment.modifyRadio(indexA, 'SUBTRACT'), '[Expected 4] Row A is not 차감').not.toBeChecked();
      await expect(list.adjustment.modifyRadio(indexB, 'SUBTRACT'), '[Expected 4] Row B is 차감').toBeChecked();
      await expect(list.adjustment.modifyRadio(indexB, 'ADD'), '[Expected 4] Row B is no longer 증가').not.toBeChecked();
    });

    let saved: SaveOutcome | undefined;
    await step('Act: Step 5 — Enter 5 and pick 조정 (Adjustment) on both rows, then click 저장 (Save)', async () => {
      await list.adjustment.fillLine(indexA, { quantity: '5', reason: 'ADJUSTMENT' });
      await list.adjustment.fillLine(indexB, { quantity: '5', reason: 'ADJUSTMENT' });
      saved = await list.save(list.adjustment, ADJUST_URL);
    });

    await step('Assert: Expected 5 — The save succeeds and 등록되었습니다 (Registered.) appears', async () => {
      expect(saved?.status, '[Expected 5] The save is accepted').toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 5] ${REGISTERED} appears`).toContainText(REGISTERED);
    });

    const after: string[] = [];
    await step('Act: Step 6 — Read 가용재고 (Available stock) of both rows on the refreshed list', async () => {
      after.push(await list.cellText(rowA, 'col.availableQuantity'), await list.cellText(rowB, 'col.availableQuantity'));
    });

    await step('Assert: Expected 6 — Row A shows 125 (120 + 5) and row B shows 195 (200 - 5)', async () => {
      expect(after[0], '[Expected 6] Row A (DEMO-SKU-0001) shows 125').toBe('125');
      expect(after[1], '[Expected 6] Row B (DEMO-SKU-0003) shows 195').toBe('195');
    });

    const changes: string[] = [];
    await step('Act: Step 7 — Open 재고이력 (Stock history) of each row and read the newest 변경수량 (Change qty)', async () => {
      for (const row of [rowA, rowB]) {
        await list.openHistoryOf(row, 'ko');
        changes.push((await list.historyLines())[0]?.change ?? '');
        await list.closeHistory();
      }
    });

    await step('Assert: Expected 7 — The newest movements show +5 for row A and -5 for row B', async () => {
      expect(changes[0], '[Expected 7] Row A (DEMO-SKU-0001) newest movement is +5').toBe('+5');
      expect(changes[1], '[Expected 7] Row B (DEMO-SKU-0003) newest movement is -5').toBe('-5');
    });
  });

  test('TC_US134_207 — The dialog lists 1 row per stock record when the same SKU is picked in 2 warehouses', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_207',
      'Medium',
      TAGS,
      `The same SKU stocked in CJ Incheon Aam and CJ Daegu shows 2 list rows; ticking both and clicking 재고 조정 opens a dialog with exactly 2 rows whose 창고 cells name the 2 warehouses. ${OWN_NOTE} ${DAEGU_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const daegu = daeguOf(world);
    const sku = await ownStockSku(world, 'A207', cj.id, { available: 120 });
    await stockDb.upsertStock(sku.skuId, daegu.id, { available: 200 });
    const rows = [list.row(sku.skuCode, cj.name), list.row(sku.skuCode, daegu.name)];
    let warehouses: string[] = [];

    await step('Arrange: Pre-condition 1–2 — Own SKU stocked in CJ Incheon Aam and in CJ Daegu warehouse', async () => {
      await list.open('ko');
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management) and tick both rows of the SKU', async () => {
      await list.findSku(sku);
      for (const row of rows) await list.checkbox(row).check();
    });

    await step('Assert: Expected 1 — Two rows are ticked', async () => {
      await expect(list.tickedBoxes(), '[Expected 1] Exactly 2 rows are ticked').toHaveCount(2);
    });

    await step('Act: Step 2 — Click 재고 조정 (Stock adjustment)', async () => {
      await list.clickToolbar('btn.adjustStock');
    });

    await step('Assert: Expected 2 — The stock adjustment dialog opens', async () => {
      await list.adjustment.waitOpen('ko');
    });

    let count = 0;
    await step('Act: Step 3 — Count the rows in the table', async () => {
      count = await list.adjustment.rows.count();
    });

    await step('Assert: Expected 3 — The table has exactly 2 rows', async () => {
      expect(count, '[Expected 3] The dialog table has exactly 2 rows').toBe(2);
    });

    await step('Act: Step 4 — Read the 창고 (Warehouse) cell of each row', async () => {
      for (let index = 0; index < count; index += 1) warehouses.push((await list.dialogMappedCells(index))[2]);
      warehouses = warehouses.sort();
    });

    await step('Assert: Expected 4 — One row shows CJ Incheon Aam and the other CJ Daegu warehouse', async () => {
      expect(warehouses, `[Expected 4] One row names ${cj.name}`).toContain(cj.name);
      expect(warehouses, `[Expected 4] The other row names ${daegu.name}`).toContain(daegu.name);
    });
  });

  test('TC_US134_208 — The adjustment reason offers exactly its 6 values and each one saves', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_208',
      'High',
      TAGS,
      `The 조정사유 select shows the placeholder 조정사유를 선택해주세요 and exactly 6 choices 조정 · 불일치 · 파손 · 분실 · 실사 · 기타; 6 consecutive saves of 증가 1, one per reason, all go through and 재고이력 lists 6 separate movements. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'A208', cj.id, { available: 190 });
    const row = list.row(sku.skuCode, cj.name);
    const reasons = ['ADJUSTMENT', 'DISCREPANCY', 'DAMAGED', 'LOST', 'TAKING', 'ETC'] as const;
    let options: Array<{ value: string; label: string }> = [];

    await step('Arrange: Pre-condition 1–2 — Own physical row in CJ Incheon Aam with total stock 190', async () => {
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Tick the row, click 재고 조정 and open the 조정사유 (Adjustment reason) dropdown', async () => {
      await list.openAdjustment([row]);
      await expect(list.adjustment.reasonSelect(0), 'The 조정사유 dropdown is shown').toBeVisible();
      options = await list.reasonOptions(0);
    });

    await step('Assert: Expected 1 — The dialog opens with 1 row', async () => {
      await expect(list.adjustment.rows, '[Expected 1] The dialog holds 1 row').toHaveCount(1);
    });

    let placeholder = '';
    let choices: string[] = [];
    await step('Act: Step 2 — Read the placeholder and count the choices', async () => {
      placeholder = options.find((option) => option.value === '')?.label ?? '';
      choices = options.filter((option) => option.value !== '').map((option) => option.label);
    });

    await step('Assert: Expected 2 — The placeholder is 조정사유를 선택해주세요 and there are exactly 6 choices', async () => {
      expect(placeholder, `[Expected 2] The placeholder is ${ko('reason.placeholder')}`).toBe(ko('reason.placeholder'));
      expect(choices.length, '[Expected 2] There are exactly 6 choices').toBe(6);
    });

    await step('Act: Step 3 — Read each choice in turn', async () => {
      expect(choices.length, 'The choices are read').toBeGreaterThan(0);
    });

    await step('Assert: Expected 3 — The choices are 조정, 불일치, 파손, 분실, 실사, 기타', async () => {
      for (const reason of reasons) expect(choices, `[Expected 3] ${ko(`reason.${reason}`)} is offered`).toContain(ko(`reason.${reason}`));
      expect(choices, '[Expected 3] The choices read in the TC order').toEqual(reasons.map((reason) => ko(`reason.${reason}`)));
    });

    const statuses: number[] = [];
    let movements: Record<string, string>[] = [];
    await step('Act: Step 4 — Save 6 adjustments of 증가 1, one per reason, then open 재고이력 (Stock history)', async () => {
      await list.adjustment.clickCancel();
      await list.adjustment.expectClosed();
      for (const reason of reasons) {
        await list.openAdjustment([row]);
        await list.adjustment.fillLine(0, { quantity: '1', modifyType: 'ADD', reason });
        statuses.push((await list.save(list.adjustment, ADJUST_URL)).status);
      }
      await list.openHistoryOf(row, 'ko');
      movements = await list.historyLines();
    });

    await step('Assert: Expected 4 — All 6 saves go through and the history shows 6 separate movements', async () => {
      reasons.forEach((reason, index) => expect(statuses[index], `[Expected 4] The save with reason ${ko(`reason.${reason}`)} goes through`).toBeLessThan(300));
      expect(movements.filter((line) => line.refType === ko('usageRef.ADJUSTMENT')).length, '[Expected 4] The history shows 6 adjustment movements').toBe(6);
      expect(new Set(movements.map((line) => line.refId)).size, '[Expected 4] The 6 movements are separate (6 voucher numbers)').toBe(6);
    });
  });

  test('TC_US134_209 — The no-row-picked and no-warehouse guards each block with their own message', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_209',
      'Medium',
      TAGS,
      `재고 조정 with nothing ticked shows "선택된 재고가 없습니다. 재고를 선택해주세요."; with only DEMO-SKU-0005 (physical, no warehouse) ticked, and again with DEMO-SKU-0001 added, it shows "선택된 SKU 중, 창고 정보 없는 SKU가 포함되어 있습니다. 재고조정은 창고 등록 후 가능합니다." — no dialog opens in any case. Read-only on the shared world. ${WORLD_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const noWarehouse = list.row(world.sku('SKU0005').skuCode);
    const withWarehouse = list.row(world.sku('SKU0001').skuCode, world.warehouses.CJ.name);
    const messages: string[] = [];

    await step('Arrange: Pre-condition 1–2 — DEMO-SKU-0005 (no warehouse) and DEMO-SKU-0001 (CJ Incheon Aam) on the list', async () => {
      await list.openWorld(world, 'ko');
      await expect(noWarehouse, 'DEMO-SKU-0005 is listed').toBeVisible();
      await expect(list.tickedBoxes(), 'No row is selected').toHaveCount(0);
    });

    await step('Act: Step 1 — With no row selected, click 재고 조정 (Stock adjustment)', async () => {
      messages.push(await list.guardTextAfter('btn.adjustStock'));
    });

    await step('Assert: Expected 1 — The action is blocked', async () => {
      await expect(list.adjustment.root, '[Expected 1] No adjustment dialog opens').toHaveCount(0);
      await expect(list.guardAlert, '[Expected 1] A blocking message is shown').toBeVisible();
    });

    await step('Act: Step 2 — Read the message and check whether the dialog opens', async () => {
      await expect(list.guardAlert, 'The message is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — "선택된 재고가 없습니다. 재고를 선택해주세요." and no dialog', async () => {
      expect(messages[0], '[Expected 2] The message is the no-selection sentence').toBe(squash(ko('guard.noSelection')));
      await expect(list.adjustment.root, '[Expected 2] No dialog opens').toHaveCount(0);
    });

    await step('Act: Step 3 — Select only DEMO-SKU-0005 and click 재고 조정', async () => {
      await list.checkbox(noWarehouse).check();
      messages.push(await list.guardTextAfter('btn.adjustStock'));
    });

    await step('Assert: Expected 3 — The action is blocked', async () => {
      await expect(list.adjustment.root, '[Expected 3] No adjustment dialog opens').toHaveCount(0);
      await expect(list.guardAlert, '[Expected 3] A blocking message is shown').toBeVisible();
    });

    await step('Act: Step 4 — Read the message and check whether the dialog opens', async () => {
      await expect(list.guardAlert, 'The message is shown').toBeVisible();
    });

    await step('Assert: Expected 4 — The no-warehouse sentence for adjustment is shown and no dialog opens', async () => {
      expect(messages[1], '[Expected 4] The message is the no-warehouse sentence for 재고조정').toBe(squash(ko('guard.noWarehouseAdjustment')));
      await expect(list.adjustment.root, '[Expected 4] No dialog opens').toHaveCount(0);
    });

    await step('Act: Step 5 — Keep DEMO-SKU-0005, also select DEMO-SKU-0001, then click 재고 조정 again', async () => {
      await list.checkbox(withWarehouse).check();
      messages.push(await list.guardTextAfter('btn.adjustStock'));
    });

    await step('Assert: Expected 5 — The action is still blocked with the same no-warehouse sentence', async () => {
      await expect(list.adjustment.root, '[Expected 5] No adjustment dialog opens').toHaveCount(0);
      expect(messages[2], '[Expected 5] The same no-warehouse sentence is shown').toBe(squash(ko('guard.noWarehouseAdjustment')));
    });
  });

  test('TC_US134_210 — The adjustment is stored as operator-made with the direction in the sign of the quantity', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_210',
      'Medium',
      TAGS,
      `Saving 증가 5 then 차감 5 from this screen stores 2 adjustment records whose source is MANAGING (not EXTERNAL) with adjusting quantity +5 and -5 — the direction lives in the sign, there is no separate direction column. Observed on dev 05/10: the source is the column adjustment.type (value MANAGING). ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'A210', cj.id, { available: 190 });
    const row = list.row(sku.skuCode, cj.name);
    let first: SaveOutcome | undefined;
    let records: Array<Record<string, unknown>> = [];

    await step('Arrange: Pre-condition 1–2 — Own physical row in CJ Incheon Aam with total stock 190', async () => {
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Save 5 · 증가 (Increase) · 조정 (Adjustment)', async () => {
      await list.openAdjustment([row]);
      await list.adjustment.fillLine(0, { quantity: '5', modifyType: 'ADD', reason: 'ADJUSTMENT' });
      first = await list.save(list.adjustment, ADJUST_URL);
    });

    await step('Assert: Expected 1 — The save goes through and shows 등록되었습니다 (Registered.)', async () => {
      expect(first?.status, '[Expected 1] The save is accepted').toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 1] ${REGISTERED} appears`).toContainText(REGISTERED);
    });

    await step('Act: Step 2 — Read the source column of the stored adjustment record', async () => {
      records = (await stockDb.adjustments(sku.skuId, cj.id)) as Array<Record<string, unknown>>;
    });

    await step('Assert: Expected 2 — The source is MANAGING (operator-made), not EXTERNAL', async () => {
      expect(records.length, '[Expected 2] One adjustment record is stored').toBe(1);
      expect(records[0].type, '[Expected 2] The source is MANAGING').toBe('MANAGING');
      expect(records[0].type, '[Expected 2] The source is not EXTERNAL').not.toBe('EXTERNAL');
    });

    await step('Act: Step 3 — Read the stored adjustment quantity', async () => {
      expect(records[0], 'The stored record is read').toBeDefined();
    });

    await step('Assert: Expected 3 — The stored adjustment quantity is plus 5', async () => {
      expect(Number(records[0].adjusting_quantity), '[Expected 3] The stored adjustment quantity is +5').toBe(5);
    });

    await step('Act: Step 4 — Save again with 차감 (Decrease) and read the stored adjustment quantity', async () => {
      await list.openAdjustment([row]);
      await list.adjustment.fillLine(0, { quantity: '5', modifyType: 'SUBTRACT', reason: 'ADJUSTMENT' });
      await list.save(list.adjustment, ADJUST_URL);
      records = (await stockDb.adjustments(sku.skuId, cj.id)) as Array<Record<string, unknown>>;
    });

    await step('Assert: Expected 4 — The stored quantity is minus 5; the direction is in the sign, not in a separate column', async () => {
      expect(records.length, '[Expected 4] A second adjustment record is stored').toBe(2);
      expect(Number(records[0].adjusting_quantity), '[Expected 4] The stored adjustment quantity is -5').toBe(-5);
      for (const column of ['modify_type', 'modifyType', 'direction']) {
        expect(Object.keys(records[0]), `[Expected 4] No separate direction column ${column} is stored`).not.toContain(column);
      }
    });
  });

  test('TC_US134_211 — SKU code, SKU name, warehouse and total stock are mapped to each dialog row and read-only', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_211',
      'Medium',
      TAGS,
      `Two rows (one in CJ Incheon Aam, one in CJ Daegu) open together; each dialog row repeats the SKU 코드, SKU명, 창고 and 전체 재고 of its list row (not swapped) and none of these 4 cells holds an editable control. ${OWN_NOTE} ${DAEGU_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const daegu = daeguOf(world);
    const [a, b] = await ownSkuLines(world, 'A211', 2);
    await stockDb.upsertStock(a.skuId, cj.id, { available: 120, hold: 10 });
    await stockDb.upsertStock(b.skuId, daegu.id, { available: 200 });
    const pairs = [
      { sku: a, warehouse: cj, row: list.row(a.skuCode, cj.name) },
      { sku: b, warehouse: daegu, row: list.row(b.skuCode, daegu.name) },
    ];
    const listValues: string[][] = [];

    await step('Arrange: Pre-condition 1–2 — Own rows in CJ Incheon Aam and CJ Daegu warehouse', async () => {
      await list.open('ko');
    });

    await step('Act: Step 1 — Record SKU code, SKU name, Warehouse and Total stock of both list rows', async () => {
      await list.findGroup(world, 'A211');
      for (const pair of pairs) {
        listValues.push([
          await list.cellText(pair.row, 'col.skuCode'),
          await list.cellText(pair.row, 'col.skuName'),
          await list.cellText(pair.row, 'col.warehouse'),
          await list.cellText(pair.row, 'col.totalQuantity'),
        ]);
      }
    });

    await step('Assert: Expected 1 — The source values are displayed on the list', async () => {
      pairs.forEach((pair, index) => {
        expect(listValues[index][0], `[Expected 1] List row ${index + 1} shows SKU code ${pair.sku.skuCode}`).toBe(pair.sku.skuCode);
        expect(listValues[index][1], `[Expected 1] List row ${index + 1} shows its SKU name`).toBe(pair.sku.skuName);
        expect(listValues[index][2], `[Expected 1] List row ${index + 1} shows warehouse ${pair.warehouse.name}`).toBe(pair.warehouse.name);
        expect(listValues[index][3], `[Expected 1] List row ${index + 1} shows its total stock`).not.toBe('');
      });
    });

    await step('Act: Step 2 — Select both rows and click 재고 조정 (Stock adjustment)', async () => {
      await list.openAdjustment(pairs.map((pair) => pair.row));
    });

    await step('Assert: Expected 2 — The dialog opens with one row for each selected stock record', async () => {
      await expect(list.adjustment.rows, '[Expected 2] The dialog holds 2 rows').toHaveCount(2);
    });

    const dialogValues: string[][] = [];
    await step('Act: Step 3 — Compare the 4 mapped values of each dialog row with its list row', async () => {
      for (const pair of pairs) dialogValues.push(await list.dialogMappedCells(await list.dialogRowIndex(list.adjustment, pair.sku.skuCode, pair.warehouse.name)));
    });

    await step('Assert: Expected 3 — Each dialog row shows the same 4 values as its list row; nothing is swapped', async () => {
      const labels = ['SKU code', 'SKU name', 'Warehouse', 'Total stock'];
      pairs.forEach((pair, index) => {
        labels.forEach((label, column) => {
          expect(dialogValues[index][column], `[Expected 3] The dialog row of ${pair.sku.skuCode} shows the list ${label}`).toBe(listValues[index][column]);
        });
      });
    });

    const editable: number[] = [];
    await step('Act: Step 4 — Try to edit the 4 mapped values on both dialog rows', async () => {
      for (let index = 0; index < 2; index += 1) editable.push(await list.editableInMappedCells(index));
    });

    await step('Assert: Expected 4 — All 4 mapped values are read-only on both rows', async () => {
      editable.forEach((count, index) => expect(count, `[Expected 4] Dialog row ${index + 1} has no editable control in its 4 mapped cells`).toBe(0));
    });
  });

  test('TC_US134_212 — Save is blocked with its own message and the row highlighted when the quantity or the reason is missing', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_212',
      'Medium',
      TAGS,
      `With 조정 수량 empty, 저장 sends nothing and shows "조정 수량을 입력해주세요" under the highlighted quantity field; reopened with quantity 5 and no 조정사유, 저장 sends nothing and shows "조정사유를 선택해주세요" under the highlighted reason field. Observed in the bundle: the per-field sentence sits under the field and the dialog alert reads 필수항목을 입력해주세요. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'A212', cj.id, { available: 100 });
    const row = list.row(sku.skuCode, cj.name);
    const posts = list.writeRequests(ADJUST_URL);

    await step('Arrange: Pre-condition 1–3 — Own physical row in CJ Incheon Aam; each round reopens the dialog', async () => {
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Leave 조정 수량 empty, pick 조정 (Adjustment) and click 저장 (Save)', async () => {
      await list.openAdjustment([row]);
      await list.adjustment.fillLine(0, { reason: 'ADJUSTMENT' });
      await list.adjustment.clickSave();
    });

    await step('Assert: Expected 1 — Saving is blocked', async () => {
      await expect(list.adjustment.errorAlert, '[Expected 1] The dialog reports the missing field').toBeVisible();
      expect(posts.length, '[Expected 1] No save request is sent').toBe(0);
      await expect(list.adjustment.root, '[Expected 1] The dialog stays open').toBeVisible();
    });

    await step('Act: Step 2 — Read the message and the state of the row', async () => {
      await expect(list.adjustment.rows.first(), 'The row is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — "조정 수량을 입력해주세요" is shown and the row is highlighted', async () => {
      await expect(list.lineFeedback(0, ko('err.adjustQuantityRequired')), `[Expected 2] ${ko('err.adjustQuantityRequired')} is shown`).toBeVisible();
      await expect(list.adjustment.quantityInput(0), '[Expected 2] The quantity field of the row is highlighted').toHaveClass(/is-invalid/);
    });

    await step('Act: Step 3 — Reopen the dialog, type 5, leave 조정사유 empty and click 저장 (Save)', async () => {
      await list.adjustment.clickCancel();
      await list.adjustment.confirmDiscard();
      await list.adjustment.expectClosed();
      await list.clickToolbar('btn.adjustStock');
      await list.adjustment.waitOpen('ko');
      await list.adjustment.fillLine(0, { quantity: '5' });
      await list.adjustment.clickSave();
    });

    await step('Assert: Expected 3 — Saving is blocked', async () => {
      await expect(list.adjustment.errorAlert, '[Expected 3] The dialog reports the missing field').toBeVisible();
      expect(posts.length, '[Expected 3] No save request is sent').toBe(0);
    });

    await step('Act: Step 4 — Read the message and the state of the row', async () => {
      await expect(list.adjustment.rows.first(), 'The row is shown').toBeVisible();
    });

    await step('Assert: Expected 4 — "조정사유를 선택해주세요" is shown and the row is highlighted', async () => {
      await expect(list.lineFeedback(0, ko('err.adjustReasonRequired')), `[Expected 4] ${ko('err.adjustReasonRequired')} is shown`).toBeVisible();
      await expect(list.adjustment.reasonSelect(0), '[Expected 4] The reason field of the row is highlighted').toHaveClass(/is-invalid/);
    });
  });

  test('TC_US134_213 — Save is blocked when any row misses required fields in a multi-SKU adjustment', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_213',
      'Medium',
      TAGS,
      `Two rows open; row 1 gets 5 · 조정, row 2 stays empty; 저장 sends nothing, shows 필수항목을 입력해주세요., highlights row 2, keeps the dialog open and keeps row 1's values. ${OWN_NOTE} ${DAEGU_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const daegu = daeguOf(world);
    const [a, b] = await ownSkuLines(world, 'A213', 2);
    await stockDb.upsertStock(a.skuId, cj.id, { available: 100 });
    await stockDb.upsertStock(b.skuId, daegu.id, { available: 100 });
    const posts = list.writeRequests(ADJUST_URL);

    await step('Arrange: Pre-condition 1–2 — Own rows in CJ Incheon Aam and CJ Daegu warehouse', async () => {
      await list.open('ko');
      await list.findGroup(world, 'A213');
    });

    await step('Act: Step 1 — Select both rows and click 재고 조정 (Stock adjustment)', async () => {
      await list.openAdjustment([list.row(a.skuCode, cj.name), list.row(b.skuCode, daegu.name)]);
    });

    await step('Assert: Expected 1 — The dialog opens with 2 rows', async () => {
      await expect(list.adjustment.rows, '[Expected 1] The dialog holds 2 rows').toHaveCount(2);
    });

    await step('Act: Step 2 — On the first row enter 5 and select 조정 (Adjustment)', async () => {
      await list.adjustment.fillLine(0, { quantity: '5', reason: 'ADJUSTMENT' });
    });

    await step('Assert: Expected 2 — The first row keeps quantity 5 and reason 조정', async () => {
      await expect(list.adjustment.quantityInput(0), '[Expected 2] Row 1 keeps quantity 5').toHaveValue('5');
      await expect(list.adjustment.reasonSelect(0), '[Expected 2] Row 1 keeps reason 조정').toHaveValue('ADJUSTMENT');
    });

    await step('Act: Step 3 — Leave the second row empty and click 저장 (Save)', async () => {
      await list.adjustment.clickSave();
    });

    await step('Assert: Expected 3 — Save is blocked with 필수항목을 입력해주세요. and row 2 is highlighted', async () => {
      await expect(list.adjustment.errorAlert, `[Expected 3] ${ko('msg.requiredFields')} appears`).toContainText(ko('msg.requiredFields'));
      expect(posts.length, '[Expected 3] No save request is sent').toBe(0);
      await expect(list.adjustment.quantityInput(1), '[Expected 3] The quantity field of row 2 is highlighted').toHaveClass(/is-invalid/);
      await expect(list.adjustment.reasonSelect(1), '[Expected 3] The reason field of row 2 is highlighted').toHaveClass(/is-invalid/);
    });

    await step('Act: Step 4 — Read the message, the dialog and the values of the first row', async () => {
      await expect(list.adjustment.errorAlert, 'The message is shown').toBeVisible();
    });

    await step('Assert: Expected 4 — The dialog stays open and row 1 values are not cleared', async () => {
      await expect(list.adjustment.root, '[Expected 4] The dialog remains open').toBeVisible();
      await expect(list.adjustment.quantityInput(0), '[Expected 4] Row 1 still holds 5').toHaveValue('5');
      await expect(list.adjustment.reasonSelect(0), '[Expected 4] Row 1 still holds 조정').toHaveValue('ADJUSTMENT');
    });
  });

  test('TC_US134_214 — The adjustment quantity is accepted at the 1,000,000,000 limit and rejected above it', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_214',
      'Medium',
      TAGS,
      `1000000000 · 증가 saves with 등록되었습니다; 1000000001 must be blocked with WH-STOCK_QUANTITY_EXCEEDED "조정 수량이 허용 범위를 초과했습니다." and create nothing; 1.5 and 0 are recorded as observed (NEEDS CLARIFICATION / record only). Observed in the bundle: the field drops non-digits (1.5 becomes 15) and ignores a value above 1e9, so 1000000001 never reaches the field and the client answers 필수항목을 입력해주세요. instead of the TC sentence — asserted softly so the later steps still run. The observed outcomes of 1.5 and 0 are attached as annotations. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'A214', cj.id, { available: 500 });
    const row = list.row(sku.skuCode, cj.name);
    let first: SaveOutcome | undefined;

    const reopen = async () => {
      if (await list.adjustment.root.count()) {
        await list.adjustment.clickCancel();
        await list.adjustment.confirmDiscard();
        await list.adjustment.expectClosed();
      }
      await list.openAdjustment([row]);
    };

    await step('Arrange: Pre-condition 1–3 — Own row DEMO-SKU-0009 in CJ Incheon Aam with available 500; limit test values', async () => {
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Type 1000000000 with 증가 (Increase) and 조정 (Adjustment), then click 저장 (Save)', async () => {
      await list.openAdjustment([row]);
      await list.adjustment.fillLine(0, { quantity: '1000000000', modifyType: 'ADD', reason: 'ADJUSTMENT' });
      first = await list.save(list.adjustment, ADJUST_URL);
    });

    await step('Assert: Expected 1 — The save goes through and shows 등록되었습니다 (Registered.)', async () => {
      expect(first?.status, '[Expected 1] The save at the limit is accepted').toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 1] ${REGISTERED} appears`).toContainText(REGISTERED);
    });

    let overValue = '';
    await step('Act: Step 2 — Open the dialog again, type 1000000001 and click 저장 (Save)', async () => {
      await reopen();
      await list.adjustment.fillLine(0, { quantity: '1000000001', modifyType: 'ADD', reason: 'ADJUSTMENT' });
      overValue = await list.adjustment.quantityInput(0).inputValue();
      await list.adjustment.clickSave();
      await expect(list.adjustment.errorAlert, 'The save is answered in the dialog').toBeVisible();
    });

    await step('Assert: Expected 2 — Blocked with "조정 수량이 허용 범위를 초과했습니다." and no adjustment is created', async () => {
      expect(await stockDb.adjustments(sku.skuId, cj.id), '[Expected 2] No adjustment is created above the limit').toHaveLength(1);
      expect(overValue, '[Expected 2] 1000000001 is not kept in the field').not.toBe('1000000001');
      await expect.soft(list.adjustment.errorAlert, '[Expected 2] The message reads 조정 수량이 허용 범위를 초과했습니다.').toContainText('조정 수량이 허용 범위를 초과했습니다.');
    });

    let decimalValue = '';
    let decimalOutcome = 'blocked on the client';
    await step('Act: Step 3 — Open the dialog again, try typing 1.5 and click 저장 (Save)', async () => {
      await reopen();
      await list.adjustment.fillLine(0, { quantity: '1.5', modifyType: 'ADD', reason: 'ADJUSTMENT' });
      decimalValue = await list.adjustment.quantityInput(0).inputValue();
      if (decimalValue.trim() === '') {
        await list.adjustment.clickSave();
        await expect(list.adjustment.errorAlert, 'The save is answered in the dialog').toBeVisible();
      } else {
        const outcome = await list.save(list.adjustment, ADJUST_URL);
        decimalOutcome = `sent as adjustingQuantity ${JSON.stringify((outcome.requestBody as { items?: Array<{ adjustingQuantity?: unknown }> })?.items?.[0]?.adjustingQuantity)} → HTTP ${outcome.status}`;
      }
      test.info().annotations.push({ type: 'TC_US134_214 Step 3 observed', description: `Typing 1.5 leaves "${decimalValue}" in the field; save ${decimalOutcome}.` });
    });

    await step('Assert: Expected 3 — NEEDS CLARIFICATION: the field never holds a decimal value (behaviour recorded)', async () => {
      expect(decimalValue, '[Expected 3] The quantity field does not keep the decimal 1.5').not.toContain('.');
      for (const record of await stockDb.adjustments(sku.skuId, cj.id)) {
        expect(Number.isInteger(Number(record.adjusting_quantity)), '[Expected 3] Every stored adjustment quantity is a whole number').toBe(true);
      }
    });

    let zeroOutcome = '';
    await step('Act: Step 4 — Try typing 0 and click 저장 (Save)', async () => {
      await reopen();
      await list.adjustment.fillLine(0, { quantity: '0', modifyType: 'ADD', reason: 'ADJUSTMENT' });
      const before = (await stockDb.usages(sku.skuId, cj.id)).length;
      if ((await list.adjustment.quantityInput(0).inputValue()) === '') {
        await list.adjustment.clickSave();
        zeroOutcome = 'blocked on the client';
      } else {
        const outcome = await list.save(list.adjustment, ADJUST_URL);
        const usages = await stockDb.usages(sku.skuId, cj.id);
        const zeroMovement = usages.length > before && Number(usages[0].delta) === 0;
        zeroOutcome = outcome.status < 300 ? `saved (HTTP ${outcome.status}); zero-quantity movement written: ${zeroMovement}` : `rejected by the server (HTTP ${outcome.status} ${outcome.code})`;
      }
      test.info().annotations.push({ type: 'TC_US134_214 Step 4 observed', description: `Quantity 0: ${zeroOutcome}.` });
    });

    await step('Assert: Expected 4 — Record only: whether 0 is blocked and whether a zero-quantity movement is written', async () => {
      expect(zeroOutcome, '[Expected 4] The outcome of saving 0 is recorded').not.toBe('');
    });
  });

  test('TC_US134_215 — The remarks field holds its 100-character limit and its value reaches the stock history', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_215',
      'Medium',
      TAGS,
      `비고 takes 데모 조정 비고, counts characters out of 100, stops at 100 characters for a 101-character value and drops the emoji of "Demo remark 📦"; saving 5 · 증가 · 조정 with "Demo adjustment remark for traceability" shows 등록되었습니다 and the newest 재고이력 비고 holds the reason 조정 and that memo. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'A215', cj.id, { available: 100 });
    const row = list.row(sku.skuCode, cj.name);
    const memo = 'Demo adjustment remark for traceability';
    const korean = '데모 조정 비고';
    const observed = { korean: '', counter: '', long: '', longCounter: '', emoji: '' };

    await step('Arrange: Pre-condition 1–3 — Own physical row in CJ Incheon Aam; remark test values', async () => {
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Tick the row, open 재고 조정 and type 데모 조정 비고 into 비고 (Remarks)', async () => {
      await list.openAdjustment([row]);
      await list.adjustment.noteInput(0).fill(korean);
      observed.korean = await list.adjustment.noteInput(0).inputValue();
    });

    await step('Assert: Expected 1 — The field takes 데모 조정 비고', async () => {
      expect(observed.korean, `[Expected 1] The field holds ${korean}`).toBe(korean);
    });

    await step('Act: Step 2 — Read the counter, then try the 101-character value and the emoji value', async () => {
      observed.counter = squash(await list.noteCounter(0).textContent());
      await list.adjustment.noteInput(0).fill('A'.repeat(101));
      observed.long = await list.adjustment.noteInput(0).inputValue();
      observed.longCounter = squash(await list.noteCounter(0).textContent());
      await list.adjustment.noteInput(0).fill('Demo remark 📦');
      observed.emoji = await list.adjustment.noteInput(0).inputValue();
    });

    await step('Assert: Expected 2 — The counter shows used / 100, the field stops at 100 characters and drops the emoji', async () => {
      expect(observed.counter, `[Expected 2] The counter reads ${korean.length}/100`).toBe(`${korean.length}/100`);
      expect(observed.long.length, '[Expected 2] The field stops at 100 characters').toBe(100);
      expect(observed.longCounter, '[Expected 2] The counter reads 100/100').toBe('100/100');
      expect(observed.emoji, '[Expected 2] The field does not take the emoji').not.toContain('📦');
    });

    let saved: SaveOutcome | undefined;
    await step('Act: Step 3 — Replace 비고 with the test remark, type 5 · 증가 · 조정 and click 저장 (Save)', async () => {
      await list.adjustment.fillLine(0, { quantity: '5', modifyType: 'ADD', reason: 'ADJUSTMENT', note: memo });
      saved = await list.save(list.adjustment, ADJUST_URL);
    });

    await step('Assert: Expected 3 — The save goes through and shows 등록되었습니다 (Registered.)', async () => {
      expect(saved?.status, '[Expected 3] The save is accepted').toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 3] ${REGISTERED} appears`).toContainText(REGISTERED);
    });

    let note = '';
    await step('Act: Step 4 — Open 재고이력 (Stock history) and read the 비고 (Remarks) cell of the newest movement', async () => {
      await list.openHistoryOf(row, 'ko');
      note = (await list.historyLines())[0]?.note ?? '';
    });

    await step('Assert: Expected 4 — The cell holds the reason 조정 and the memo typed in the dialog', async () => {
      expect(note, '[Expected 4] 비고 holds the reason 조정').toContain(ko('reason.ADJUSTMENT'));
      expect(note, `[Expected 4] 비고 holds the memo ${memo}`).toContain(memo);
    });
  });

  test('TC_US134_216 — Save uses the latest available stock when another session changes it after the dialog opens', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_216',
      'High',
      TAGS,
      `Session A opens 재고 조정 on a row with available 17; session B decreases it by 15 (available 2); session A then saves 차감 10 · 조정 and is rejected with WH-STOCK_ADJUSTMENT_BELOW_ZERO "${BELOW_ZERO} - skuId: …, warehouseId: …, available: 2, hold: …, physical: …, requested: 10"; no adjustment of session A is created, the dialog keeps its values and available stays 2. Session B is the adjustment API (POST /adjustments, the call the dialog makes) under the same account. Deviation observed (run 05/10/2026): the server prints the signed change "requested: -10" instead of the TC's "requested: 10" — asserted as the TC states. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'A216', cj.id, { available: 17, cs: 8, csManaged: true });
    const row = list.row(sku.skuCode, cj.name);
    let sessionB = 0;
    let availableB = -1;
    let saved: SaveOutcome | undefined;

    await step('Arrange: Pre-condition 1–3 — Own row DEMO-SKU-0011 in CJ Incheon Aam with available 17; test data 10 · 차감 · 조정', async () => {
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — In session A, select the row and open 재고 조정 (Stock adjustment)', async () => {
      await list.openAdjustment([row]);
    });

    await step('Assert: Expected 1 — The dialog opens for DEMO-SKU-0011', async () => {
      expect((await list.dialogMappedCells(0))[0], '[Expected 1] The dialog row is the selected SKU').toBe(sku.skuCode);
    });

    await step('Act: Step 2 — In session B, save an adjustment of 15 with 차감 (Decrease) on the same row', async () => {
      sessionB = (await stockApi.createAdjustments({ items: [{ skuId: sku.skuId, warehouseId: cj.id, adjustingQuantity: 15, modifyType: 'SUBTRACT', reason: 'ADJUSTMENT', note: `Session B ${world.tag}` }] })).status;
      availableB = (await stockDb.stock(sku.skuId, cj.id))?.available_quantity ?? -1;
    });

    await step('Assert: Expected 2 — 가용재고 (Available stock) is updated to 2 by session B', async () => {
      expect(sessionB, '[Expected 2] The session B adjustment is accepted').toBeLessThan(300);
      expect(availableB, '[Expected 2] Available stock is now 2').toBe(2);
    });

    await step('Act: Step 3 — In session A, enter 10 · 차감 (Decrease) · 조정 (Adjustment) and click 저장 (Save)', async () => {
      await list.adjustment.fillLine(0, { quantity: '10', modifyType: 'SUBTRACT', reason: 'ADJUSTMENT' });
      saved = await list.save(list.adjustment, ADJUST_URL);
    });

    await step('Assert: Expected 3 — Save is rejected and no adjustment is created', async () => {
      expect(saved?.status, '[Expected 3] The save is rejected').toBeGreaterThanOrEqual(400);
      expect(await stockDb.adjustments(sku.skuId, cj.id), '[Expected 3] Only the session B adjustment exists').toHaveLength(1);
    });

    let available = -1;
    await step('Act: Step 4 — Check the error, the dialog values and the latest 가용재고 (Available stock)', async () => {
      await expect(list.adjustment.errorAlert, 'The error is shown in the dialog').toBeVisible();
      available = (await stockDb.stock(sku.skuId, cj.id))?.available_quantity ?? -1;
    });

    await step('Assert: Expected 4 — WH-STOCK_ADJUSTMENT_BELOW_ZERO with available: 2 and requested: 10; dialog keeps its values; available stays 2', async () => {
      expect(saved?.code, '[Expected 4] The code is WH-STOCK_ADJUSTMENT_BELOW_ZERO').toBe('WH-STOCK_ADJUSTMENT_BELOW_ZERO');
      await expect(list.adjustment.errorAlert, '[Expected 4] The message starts with the below-zero sentence').toContainText(BELOW_ZERO);
      for (const part of [`skuId: ${sku.skuId}`, `warehouseId: ${cj.id}`, 'available: 2', 'hold: ', 'physical: ', 'requested: 10']) {
        await expect(list.adjustment.errorAlert, `[Expected 4] The message carries ${part}`).toContainText(part);
      }
      await expect(list.adjustment.root, '[Expected 4] The dialog remains open').toBeVisible();
      await expect(list.adjustment.quantityInput(0), '[Expected 4] The quantity 10 is kept').toHaveValue('10');
      await expect(list.adjustment.modifyRadio(0, 'SUBTRACT'), '[Expected 4] 차감 is kept').toBeChecked();
      await expect(list.adjustment.reasonSelect(0), '[Expected 4] 조정 is kept').toHaveValue('ADJUSTMENT');
      expect(available, '[Expected 4] Available stock remains 2').toBe(2);
    });
  });

  test('TC_US134_217 — Save is rejected when Decrease would take a bucket below zero', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_217',
      'Critical',
      TAGS,
      `A 차감 30 on a row with total 25 / available 17 is rejected with WH-STOCK_ADJUSTMENT_BELOW_ZERO "${BELOW_ZERO} - skuId: …, warehouseId: …, available: 17, hold: …, physical: 25, requested: 30" (real values in place of the brackets), the dialog keeps the values, nothing is created and the list still shows 25 / 17. The TC does not fix the form of the requested value: the server prints the signed change (requested: -30 for a decrease of 30), so either sign is accepted. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'A217', cj.id, { available: 17, cs: 8, csManaged: true });
    const row = list.row(sku.skuCode, cj.name);
    let saved: SaveOutcome | undefined;

    await step('Arrange: Pre-condition 1–3 — Own row DEMO-SKU-0011 in CJ Incheon Aam with total 25 / available 17; test data 30 · 차감 · 조정', async () => {
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Select the row and open 재고 조정 (Stock adjustment)', async () => {
      await list.openAdjustment([row]);
    });

    await step('Assert: Expected 1 — The dialog opens for DEMO-SKU-0011', async () => {
      expect((await list.dialogMappedCells(0))[0], '[Expected 1] The dialog row is the selected SKU').toBe(sku.skuCode);
    });

    await step('Act: Step 2 — Enter 30 · 차감 (Decrease) · 조정 (Adjustment) and click 저장 (Save)', async () => {
      await list.adjustment.fillLine(0, { quantity: '30', modifyType: 'SUBTRACT', reason: 'ADJUSTMENT' });
      saved = await list.save(list.adjustment, ADJUST_URL);
    });

    await step('Assert: Expected 2 — Save is rejected and no adjustment is created', async () => {
      expect(saved?.status, '[Expected 2] The save is rejected').toBeGreaterThanOrEqual(400);
      expect(await stockDb.adjustments(sku.skuId, cj.id), '[Expected 2] No adjustment is created').toHaveLength(0);
    });

    await step('Act: Step 3 — Read the error code and message', async () => {
      await expect(list.adjustment.errorAlert, 'The error is shown in the dialog').toBeVisible();
    });

    await step('Assert: Expected 3 — WH-STOCK_ADJUSTMENT_BELOW_ZERO with the real values, including available: 17 and physical: 25', async () => {
      expect(saved?.code, '[Expected 3] The code is WH-STOCK_ADJUSTMENT_BELOW_ZERO').toBe('WH-STOCK_ADJUSTMENT_BELOW_ZERO');
      await expect(list.adjustment.errorAlert, '[Expected 3] The message starts with the below-zero sentence').toContainText(BELOW_ZERO);
      for (const part of [`skuId: ${sku.skuId}`, `warehouseId: ${cj.id}`, 'available: 17', 'hold: 0', 'physical: 25']) {
        await expect(list.adjustment.errorAlert, `[Expected 3] The message carries ${part}`).toContainText(part);
      }
      await expect(list.adjustment.errorAlert, '[Expected 3] The message carries the real requested quantity (the decrease of 30)').toContainText(/requested: -?30(?!\d)/);
      await expect(list.adjustment.errorAlert, '[Expected 3] No placeholder in curly brackets is left').not.toContainText('{');
    });

    await step('Act: Step 4 — Check the dialog and the entered values', async () => {
      await expect(list.adjustment.root, 'The dialog is shown').toBeVisible();
    });

    await step('Assert: Expected 4 — The dialog remains open and keeps the entered values', async () => {
      await expect(list.adjustment.quantityInput(0), '[Expected 4] The quantity 30 is kept').toHaveValue('30');
      await expect(list.adjustment.modifyRadio(0, 'SUBTRACT'), '[Expected 4] 차감 is kept').toBeChecked();
      await expect(list.adjustment.reasonSelect(0), '[Expected 4] 조정 is kept').toHaveValue('ADJUSTMENT');
    });

    const after = { total: '', available: '' };
    await step('Act: Step 5 — Close the dialog, reload the list and read 전체재고 and 가용재고', async () => {
      await list.adjustment.clickCancel();
      await list.adjustment.confirmDiscard();
      await list.adjustment.expectClosed();
      await list.refreshSku(sku);
      after.total = await list.cellText(row, 'col.totalQuantity');
      after.available = await list.cellText(row, 'col.availableQuantity');
    });

    await step('Assert: Expected 5 — Total stock remains 25 and available stock remains 17', async () => {
      expect(after.total, '[Expected 5] Total stock remains 25').toBe('25');
      expect(after.available, '[Expected 5] Available stock remains 17').toBe('17');
    });
  });

  test('TC_US134_218 — Save fails when the stock record is deleted after the dialog opens', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_218',
      'High',
      TAGS,
      `The dialog opens on a row with total 34; the stock record is then deleted (DB fixture, SKU kept); saving 5 · 증가 · 조정 is rejected with WH-STOCK_NOT_FOUND "SKU의 재고가 존재하지 않습니다." carrying no SKU id or warehouse id, no adjustment is created and the dialog keeps 5 · 증가 · 조정. ${OWN_NOTE} ${DAEGU_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const daegu = daeguOf(world);
    const sku = await ownStockSku(world, 'A218', daegu.id, { available: 14, reserved: 12, cs: 8, csManaged: true });
    const row = list.row(sku.skuCode, daegu.name);
    let opened: string[] = [];
    let saved: SaveOutcome | undefined;

    await step('Arrange: Pre-condition 1–4 — Own row DEMO-SKU-0008 in CJ Daegu with total 34; the DB fixture can delete the stock record', async () => {
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Select the row and open 재고 조정 (Stock adjustment)', async () => {
      await list.openAdjustment([row]);
      opened = await list.dialogMappedCells(0);
    });

    await step('Assert: Expected 1 — The dialog opens and shows total stock 34', async () => {
      expect(opened[3], '[Expected 1] The dialog shows total stock 34').toBe('34');
    });

    let stillThere = true;
    let shown = '';
    await step('Act: Step 2 — Keep the dialog open and delete only the stock record of the row', async () => {
      await stockDb.deleteStock(sku.skuId, daegu.id);
      stillThere = !!(await stockDb.stock(sku.skuId, daegu.id));
      shown = (await list.dialogMappedCells(0))[3];
    });

    await step('Assert: Expected 2 — The record is deleted but the open dialog still shows total stock 34', async () => {
      expect(stillThere, '[Expected 2] The stock record is deleted').toBe(false);
      expect(!!(await stockDb.sku(sku.skuId)), '[Expected 2] The SKU itself is kept').toBe(true);
      expect(shown, '[Expected 2] The open dialog still shows total stock 34').toBe('34');
    });

    await step('Act: Step 3 — Enter 5 · 증가 (Increase) · 조정 (Adjustment) and click 저장 (Save)', async () => {
      await list.adjustment.fillLine(0, { quantity: '5', modifyType: 'ADD', reason: 'ADJUSTMENT' });
      saved = await list.save(list.adjustment, ADJUST_URL);
    });

    await step('Assert: Expected 3 — Rejected with WH-STOCK_NOT_FOUND "SKU의 재고가 존재하지 않습니다.", no ids, nothing created', async () => {
      expect(saved?.status, '[Expected 3] The save is rejected').toBeGreaterThanOrEqual(400);
      expect(await stockDb.adjustments(sku.skuId), '[Expected 3] No adjustment is created').toHaveLength(0);
      expect(saved?.code, '[Expected 3] The code is WH-STOCK_NOT_FOUND').toBe('WH-STOCK_NOT_FOUND');
      await expect(list.adjustment.errorAlert, '[Expected 3] The message reads SKU의 재고가 존재하지 않습니다.').toContainText('SKU의 재고가 존재하지 않습니다.');
      await expect(list.adjustment.errorAlert, '[Expected 3] The message names no SKU id').not.toContainText(String(sku.skuId));
      await expect(list.adjustment.errorAlert, '[Expected 3] The message names no warehouse id').not.toContainText(String(daegu.id));
    });

    await step('Act: Step 4 — Read the error message and the dialog values', async () => {
      await expect(list.adjustment.errorAlert, 'The error is shown').toBeVisible();
    });

    await step('Assert: Expected 4 — The dialog stays open and keeps 5, 증가 (Increase) and 조정 (Adjustment)', async () => {
      await expect(list.adjustment.root, '[Expected 4] The dialog remains open').toBeVisible();
      await expect(list.adjustment.quantityInput(0), '[Expected 4] The quantity 5 is kept').toHaveValue('5');
      await expect(list.adjustment.modifyRadio(0, 'ADD'), '[Expected 4] 증가 is kept').toBeChecked();
      await expect(list.adjustment.reasonSelect(0), '[Expected 4] 조정 is kept').toHaveValue('ADJUSTMENT');
    });
  });

  test('TC_US134_219 — Two sessions can adjust the same stock row and each accepted save creates one movement', async ({ page, browser, context, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_219',
      'Medium',
      TAGS,
      `Sessions A and B both open 재고 조정 on the same row (available 120) with no lock or version warning; A saves 증가 10 (130), B saves 증가 20 on the latest value (150); both show 등록되었습니다 and 재고이력 lists 2 new movements +10 and +20. Session B is a second browser context of the same automation account (a second operator account is not available). ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'A219', cj.id, { available: 120 });
    const contextB = await browser.newContext({ storageState: await context.storageState(), baseURL: env.baseURL, viewport: { width: 1920, height: 1080 } });
    try {
      const listB = new StockAdjustmentPage(await contextB.newPage());
      let savedA: SaveOutcome | undefined;
      let savedB: SaveOutcome | undefined;
      let availableA = '';
      let availableAfterB = -1;

      await step('Arrange: Pre-condition 1–2 — Sessions A and B logged in; own row DEMO-SKU-0001 in CJ Incheon Aam with available 120', async () => {
        await list.open('ko');
        await list.findSku(sku);
        await listB.open('ko');
        await listB.findSku(sku);
      });

      await step('Act: Step 1 — In session A and in session B tick the row and open 재고 조정 (Stock adjustment)', async () => {
        await list.openAdjustment([list.row(sku.skuCode, cj.name)]);
        await listB.openAdjustment([listB.row(sku.skuCode, cj.name)]);
      });

      await step('Assert: Expected 1 — Both dialogs open with no row lock, version warning or concurrent-edit warning', async () => {
        await expect(list.adjustment.root, '[Expected 1] Session A dialog is open').toBeVisible();
        await expect(listB.adjustment.root, '[Expected 1] Session B dialog is open').toBeVisible();
        await expect(list.adjustment.errorAlert, '[Expected 1] Session A shows no warning').toHaveCount(0);
        await expect(listB.adjustment.errorAlert, '[Expected 1] Session B shows no warning').toHaveCount(0);
      });

      await step('Act: Step 2 — In session A save 10 · 증가 (Increase) · 조정 (Adjustment)', async () => {
        await list.adjustment.fillLine(0, { quantity: '10', modifyType: 'ADD', reason: 'ADJUSTMENT' });
        savedA = await list.save(list.adjustment, ADJUST_URL);
        availableA = await list.cellText(list.row(sku.skuCode, cj.name), 'col.availableQuantity');
      });

      await step('Assert: Expected 2 — Session A save succeeds, Registered appears and available becomes 130', async () => {
        expect(savedA?.status, '[Expected 2] Session A save is accepted').toBeLessThan(300);
        await expect(list.lastToast(), `[Expected 2] Session A shows ${REGISTERED}`).toContainText(REGISTERED);
        expect(availableA, '[Expected 2] Available stock becomes 130').toBe('130');
      });

      await step('Act: Step 3 — In session B save 20 · 증가 (Increase) with the same reason', async () => {
        await listB.adjustment.fillLine(0, { quantity: '20', modifyType: 'ADD', reason: 'ADJUSTMENT' });
        savedB = await listB.save(listB.adjustment, ADJUST_URL);
        availableAfterB = (await stockDb.stock(sku.skuId, cj.id))?.available_quantity ?? -1;
      });

      await step('Assert: Expected 3 — Session B save also succeeds, Registered appears and +20 lands on 130', async () => {
        expect(savedB?.status, '[Expected 3] Session B save is accepted').toBeLessThan(300);
        await expect(listB.lastToast(), `[Expected 3] Session B shows ${REGISTERED}`).toContainText(REGISTERED);
        expect(availableAfterB, '[Expected 3] The +20 is applied to the latest value 130').toBe(150);
      });

      let available = '';
      let changes: string[] = [];
      await step('Act: Step 4 — Reload the list, read 가용재고 (Available stock) and open 재고이력 (Stock history)', async () => {
        await list.refreshSku(sku);
        available = await list.cellText(list.row(sku.skuCode, cj.name), 'col.availableQuantity');
        await list.openHistoryOf(list.row(sku.skuCode, cj.name), 'ko');
        changes = (await list.historyLines()).map((line) => line.change);
      });

      await step('Assert: Expected 4 — Available stock is 150 and the history holds 2 new movements +10 and +20', async () => {
        expect(available, '[Expected 4] Available stock is 150').toBe('150');
        expect(changes.length, '[Expected 4] Exactly 2 movements are written').toBe(2);
        expect(changes, '[Expected 4] The +10 movement is listed').toContain('+10');
        expect(changes, '[Expected 4] The +20 movement is listed').toContain('+20');
      });
    } finally {
      await contextB.close();
    }
  });

  test('TC_US134_220 — No half-finished adjustment is left when the save is cut off partway', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_220',
      'High',
      TAGS,
      `The adjustment request reaches the server but the browser loses the answer (the route is aborted after the server call, "internetdisconnected"); no 등록되었습니다 appears; after reconnecting, total / available are either both unchanged (190 / 120) or both moved by one whole adjustment (200 / 130), and the history holds either 0 or exactly 1 movement, consistent with the numbers. The own SKU has no earlier movement, so every listed movement is from the last minute. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'A220', cj.id, { available: 120, reserved: 40, cs: 20, hold: 10, csManaged: true });
    const row = list.row(sku.skuCode, cj.name);
    let reconnect: (() => Promise<void>) | undefined;

    await step('Arrange: Pre-condition 1–3 — Own row DEMO-SKU-0001 in CJ Incheon Aam with total 190 / available 120; test data 10 · 증가 · 조정', async () => {
      await list.open('ko');
      await list.findSku(sku);
    });

    try {
      await step('Act: Step 1 — Tick the row, click 재고 조정 and type the test data', async () => {
        await list.openAdjustment([row]);
        await list.adjustment.fillLine(0, { quantity: '10', modifyType: 'ADD', reason: 'ADJUSTMENT' });
      });

      await step('Assert: Expected 1 — The dialog holds the values typed', async () => {
        await expect(list.adjustment.quantityInput(0), '[Expected 1] The quantity 10 is held').toHaveValue('10');
        await expect(list.adjustment.modifyRadio(0, 'ADD'), '[Expected 1] 증가 is held').toBeChecked();
        await expect(list.adjustment.reasonSelect(0), '[Expected 1] 조정 is held').toHaveValue('ADJUSTMENT');
      });

      await step('Act: Step 2 — Click 저장 (Save) and cut the network before any answer comes back', async () => {
        reconnect = await list.cutAnswerOf(ADJUST_URL);
        await list.adjustment.clickSave();
        await expect(list.adjustment.errorAlert, 'The dialog reports the lost answer').toBeVisible({ timeout: 60_000 });
      });

      await step('Assert: Expected 2 — No 등록되었습니다 (Registered.) message appears while the network is cut', async () => {
        await expect(list.toasts.filter({ hasText: REGISTERED }), `[Expected 2] No ${REGISTERED} message appears`).toHaveCount(0);
      });

      const after = { total: '', available: '' };
      await step('Act: Step 3 — Reconnect, reload the list and read 전체재고 and 가용재고', async () => {
        await reconnect?.();
        reconnect = undefined;
        await list.adjustment.clickCancel();
        await list.adjustment.confirmDiscard();
        await list.adjustment.expectClosed();
        await list.refreshSku(sku);
        after.total = await list.cellText(row, 'col.totalQuantity');
        after.available = await list.cellText(row, 'col.availableQuantity');
      });

      await step('Assert: Expected 3 — Either both unchanged at 190 / 120, or both reflect one whole adjustment of 10', async () => {
        expect([['190', '120'], ['200', '130']], '[Expected 3] Total / available are both unchanged or both moved by exactly 10').toContainEqual([after.total, after.available]);
      });

      let movements = -1;
      await step('Act: Step 4 — Open 재고이력 (Stock history) and count the movements written in the last minute', async () => {
        await list.openHistoryOf(row, 'ko');
        movements = (await list.historyLines()).length;
      });

      await step('Assert: Expected 4 — Either 0 movements or exactly 1 movement is written, matching the numbers', async () => {
        expect(movements, '[Expected 4] At most 1 movement is written').toBeLessThanOrEqual(1);
        expect(movements, '[Expected 4] The movement count matches the stock numbers (1 only when the stock moved)').toBe(after.total === '200' ? 1 : 0);
      });
    } finally {
      await reconnect?.();
    }
  });

  test('TC_US134_221 — Double-clicking Save sends 1 request and moves stock once in each of the 3 stock dialogs', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_221',
      'High',
      TAGS,
      `In 재고 조정, 재고 전환 (보류재고 지정 5) and 창고별 상세 (관리함) a quick double-click on 저장 sends exactly 1 write request; 저장 is disabled right after the first click; available goes 120 → 130 (not 140) and on-hold 10 → 15 (not 20). The first request is held in the browser until the button state is read (no throttling). 보류재고 is not a list column, so it is read from the stock record. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const [a, b] = await ownSkuLines(world, 'A221', 2);
    await stockDb.upsertStock(a.skuId, cj.id, { available: 120, hold: 10, csManaged: true });
    await stockDb.upsertStock(b.skuId, cj.id, { available: 30, csManaged: false });
    const rowA = list.row(a.skuCode, cj.name);
    const rowB = list.row(b.skuCode, cj.name);
    const adjust = { disabledAfterFirst: false, requestCount: 0 };
    const convert = { disabledAfterFirst: false, requestCount: 0 };
    const detail = { disabledAfterFirst: false, requestCount: 0 };

    await step('Arrange: Pre-condition 1–4 — Own row A (DEMO-SKU-0001: available 120, on hold 10) and row B (DEMO-SKU-0009: CS not managed) in CJ Incheon Aam', async () => {
      await list.open('ko');
      await list.findGroup(world, 'A221');
    });

    await step('Act: Step 1 — Tick row A, click 재고 조정 and fill 10 · 증가 (Increase) · 조정 (Adjustment)', async () => {
      await list.openAdjustment([rowA]);
      await list.adjustment.fillLine(0, { quantity: '10', modifyType: 'ADD', reason: 'ADJUSTMENT' });
    });

    await step('Assert: Expected 1 — The row is filled', async () => {
      await expect(list.adjustment.quantityInput(0), '[Expected 1] Quantity 10 is filled').toHaveValue('10');
      await expect(list.adjustment.reasonSelect(0), '[Expected 1] Reason 조정 is filled').toHaveValue('ADJUSTMENT');
    });

    await step('Act: Step 2 — Double-click 저장 (Save) quickly', async () => {
      Object.assign(adjust, await list.doubleClickSave(list.adjustment, ADJUST_URL));
    });

    await step('Assert: Expected 2 — 저장 (Save) is disabled right after the first click', async () => {
      expect(adjust.disabledAfterFirst, '[Expected 2] 저장 is disabled while the first save is in flight').toBe(true);
    });

    let available = '';
    await step('Act: Step 3 — Count the save requests and read 가용재고 (Available stock) on the reloaded list', async () => {
      available = await list.cellText(rowA, 'col.availableQuantity');
    });

    await step('Assert: Expected 3 — Exactly 1 request is sent and available shows 130, not 140', async () => {
      expect(adjust.requestCount, '[Expected 3] Exactly 1 adjustment request is sent').toBe(1);
      expect(available, '[Expected 3] Available stock shows 130').toBe('130');
    });

    let hold = -1;
    await step('Act: Step 4 — Tick row A, 재고 전환 with 보류재고 지정 (가용재고 → 보류재고), type 5, double-click 저장', async () => {
      await list.openConversion([rowA]);
      await list.conversion.choosePolicy('SECURE_HOLD');
      await list.conversion.fillLine(0, { quantity: '5' });
      Object.assign(convert, await list.doubleClickSave(list.conversion, CONVERT_URL));
      hold = (await stockDb.stock(a.skuId, cj.id))?.hold_quantity ?? -1;
    });

    await step('Assert: Expected 4 — Exactly 1 request is sent and on-hold stock shows 15, not 20', async () => {
      expect(convert.requestCount, '[Expected 4] Exactly 1 conversion request is sent').toBe(1);
      expect(hold, '[Expected 4] On-hold stock is 15').toBe(15);
    });

    await step('Act: Step 5 — Tick row B, open 창고별 상세, set CS재고 관리여부 to 관리함 and double-click 저장', async () => {
      await list.openWarehouseDetail([rowB]);
      await list.managedRadio(0, true).check();
      Object.assign(detail, await list.doubleClickSave(list.detail, CS_URL));
    });

    await step('Assert: Expected 5 — Exactly 1 request is sent', async () => {
      expect(detail.requestCount, '[Expected 5] Exactly 1 CS stock management request is sent').toBe(1);
    });
  });

  test('TC_US134_222 — Entered data is kept when the save fails on the server', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_222',
      'Medium',
      TAGS,
      `Two rows are filled with 5 · 증가 · 조정; a DB fixture then turns SKU 2 into a non-stock SKU (sku.type = MIXED, restored afterwards); 저장 is rejected with WH-SKU_NOT_SHIPPABLE "재고로 관리되는 SKU가 아닙니다. - skuIds: <id of SKU 2>", the dialog stays open and both rows keep their values. ${OWN_NOTE} ${DAEGU_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const daegu = daeguOf(world);
    const [a, b] = await ownSkuLines(world, 'A222', 2);
    await stockDb.upsertStock(a.skuId, cj.id, { available: 100 });
    await stockDb.upsertStock(b.skuId, daegu.id, { available: 100 });
    let saved: SaveOutcome | undefined;

    try {
      await step('Arrange: Pre-condition 1–3 — Own rows in CJ Incheon Aam and CJ Daegu; a DB fixture can make SKU 2 non-stock', async () => {
        await list.open('ko');
        await list.findGroup(world, 'A222');
      });

      await step('Act: Step 1 — Tick both rows, click 재고 조정 and fill both rows with 5 · 증가 · 조정', async () => {
        await list.openAdjustment([list.row(a.skuCode, cj.name), list.row(b.skuCode, daegu.name)]);
        for (const index of [0, 1]) await list.adjustment.fillLine(index, { quantity: '5', modifyType: 'ADD', reason: 'ADJUSTMENT' });
      });

      await step('Assert: Expected 1 — The dialog has 2 filled rows', async () => {
        await expect(list.adjustment.rows, '[Expected 1] The dialog holds 2 rows').toHaveCount(2);
        for (const index of [0, 1]) await expect(list.adjustment.quantityInput(index), `[Expected 1] Row ${index + 1} is filled`).toHaveValue('5');
      });

      await step('Act: Step 2 — Apply the DB fixture to SKU 2 (DEMO-SKU-0003), then click 저장 (Save)', async () => {
        await stockDb.exec("UPDATE sku SET type = 'MIXED' WHERE id = ? AND type = 'PHYSICAL'", [b.skuId]);
        saved = await list.save(list.adjustment, ADJUST_URL);
      });

      await step('Assert: Expected 2 — The system rejects the save', async () => {
        expect(saved?.status, '[Expected 2] The save is rejected').toBeGreaterThanOrEqual(400);
        expect(await stockDb.adjustments(a.skuId), '[Expected 2] No adjustment is created for SKU 1').toHaveLength(0);
        expect(await stockDb.adjustments(b.skuId), '[Expected 2] No adjustment is created for SKU 2').toHaveLength(0);
      });

      await step('Act: Step 3 — Read what the screen shows', async () => {
        await expect(list.adjustment.errorAlert, 'The error is shown in the dialog').toBeVisible();
      });

      await step('Assert: Expected 3 — WH-SKU_NOT_SHIPPABLE "재고로 관리되는 SKU가 아닙니다. - skuIds: …" with the real id of SKU 2', async () => {
        expect(saved?.code, '[Expected 3] The code is WH-SKU_NOT_SHIPPABLE').toBe('WH-SKU_NOT_SHIPPABLE');
        await expect(list.adjustment.errorAlert, '[Expected 3] The message reads 재고로 관리되는 SKU가 아닙니다. - skuIds:').toContainText('재고로 관리되는 SKU가 아닙니다. - skuIds:');
        await expect(list.adjustment.errorAlert, '[Expected 3] The message names the id of SKU 2').toContainText(String(b.skuId));
        await expect(list.adjustment.errorAlert, '[Expected 3] No placeholder in curly brackets is left').not.toContainText('{');
      });

      await step('Act: Step 4 — See whether the dialog is still open and whether both rows hold their values', async () => {
        await expect(list.adjustment.rows, 'The rows are shown').toHaveCount(2);
      });

      await step('Assert: Expected 4 — The dialog is still open and both rows still hold 5, 증가 and 조정', async () => {
        await expect(list.adjustment.root, '[Expected 4] The dialog is still open').toBeVisible();
        for (const index of [0, 1]) {
          await expect(list.adjustment.quantityInput(index), `[Expected 4] Row ${index + 1} still holds 5`).toHaveValue('5');
          await expect(list.adjustment.modifyRadio(index, 'ADD'), `[Expected 4] Row ${index + 1} still holds 증가`).toBeChecked();
          await expect(list.adjustment.reasonSelect(index), `[Expected 4] Row ${index + 1} still holds 조정`).toHaveValue('ADJUSTMENT');
        }
      });
    } finally {
      await stockDb.exec("UPDATE sku SET type = 'PHYSICAL' WHERE id = ? AND type = 'MIXED'", [b.skuId]);
    }
  });

  test('TC_US134_223 — The adjustment still works on a row in a QUARANTINE virtual warehouse', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_223',
      'Medium',
      TAGS,
      `A row in the QUARANTINE bucket (이슈격리) of CJ Incheon Aam with available 10 opens 재고 조정; 5 · 증가 · 조정 saves with 등록되었습니다; the row shows available 15 and its newest 재고이력 movement +5. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const quarantine = world.bucket(world.warehouses.CJ, '이슈격리');
    const sku = await ownStockSku(world, 'A223', quarantine.id, { available: 10 });
    const row = list.row(sku.skuCode, quarantine.name);
    let saved: SaveOutcome | undefined;

    await step('Arrange: Pre-condition 1–3 — Own row in the QUARANTINE warehouse of CJ Incheon Aam with available 10', async () => {
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Tick the QUARANTINE row and click 재고 조정 (Stock adjustment)', async () => {
      await list.openAdjustment([row]);
    });

    await step('Assert: Expected 1 — The dialog opens', async () => {
      expect((await list.dialogMappedCells(0))[2], '[Expected 1] The dialog row is the QUARANTINE row').toBe(quarantine.name);
    });

    await step('Act: Step 2 — Type 5 · 증가 (Increase) · 조정 (Adjustment) and click 저장 (Save)', async () => {
      await list.adjustment.fillLine(0, { quantity: '5', modifyType: 'ADD', reason: 'ADJUSTMENT' });
      saved = await list.save(list.adjustment, ADJUST_URL);
    });

    await step('Assert: Expected 2 — The save goes through and shows 등록되었습니다 (Registered.)', async () => {
      expect(saved?.status, '[Expected 2] The save is accepted').toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 2] ${REGISTERED} appears`).toContainText(REGISTERED);
    });

    let available = '';
    let change = '';
    await step('Act: Step 3 — Read 가용재고 of the QUARANTINE row and the newest movement of its 재고이력', async () => {
      available = await list.cellText(row, 'col.availableQuantity');
      await list.openHistoryOf(row, 'ko');
      change = (await list.historyLines())[0]?.change ?? '';
    });

    await step('Assert: Expected 3 — Available stock 15 and the newest movement +5', async () => {
      expect(available, '[Expected 3] The QUARANTINE row shows available 15').toBe('15');
      expect(change, '[Expected 3] The newest movement shows +5').toBe('+5');
    });
  });

  test('TC_US134_224 — Adjustment and conversion lock for a pending-revenue or in-transit row and stay open for other virtual warehouses', async ({ page, world }) => {
    const step = makeStep(page);
    const guard = squash(ko('guard.systemOnlyWarehouse'));
    await tcMeta(
      'TC_US134_224',
      'High',
      TAGS,
      `Ticking a PENDING_REVENUE (매출대기) or IN_TRANSIT (이동중) row — alone or with an ordinary row — locks 재고 조정 and 재고 전환 (disabled, tooltip "${guard}"); SCRAP (폐기), QUARANTINE (이슈격리) and DEFECTIVE (불량) rows open both dialogs; 재고이력 still opens on the PENDING_REVENUE row. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const buckets = {
      PENDING_REVENUE: world.bucket(cj, '매출대기'),
      IN_TRANSIT: world.bucket(cj, '이동중'),
      SCRAP: world.bucket(cj, '폐기'),
      QUARANTINE: world.bucket(cj, '이슈격리'),
      DEFECTIVE: world.bucket(cj, '불량'),
    };
    const sku = await ownStockSku(world, 'A224', cj.id, { available: 120 });
    for (const bucket of Object.values(buckets)) await stockDb.upsertStock(sku.skuId, bucket.id, { available: 10, hold: 10 });
    const rowOf = (name: keyof typeof buckets) => list.row(sku.skuCode, buckets[name].name);
    const ordinary = list.row(sku.skuCode, cj.name);
    const opens = async (key: 'btn.adjustStock' | 'btn.convertStock'): Promise<boolean> => {
      const dialog = key === 'btn.adjustStock' ? list.adjustment : list.conversion;
      await list.clickToolbar(key);
      const opened = await dialog.root.waitFor({ state: 'visible' }).then(() => true, () => false);
      if (opened) {
        await dialog.clickCancel();
        await dialog.expectClosed();
      }
      return opened;
    };
    const locked = async () => ({ adjust: await list.adjustButton.isDisabled(), convert: await list.convertButton.isDisabled() });
    let state = { adjust: false, convert: false };
    const tips: string[] = [];

    await step('Arrange: Pre-condition 1–4 — Own SKU rows in the 5 virtual warehouses of CJ Incheon Aam (available 10, on hold 10) and an ordinary CJ row', async () => {
      await list.open('ko');
      await list.findSku(sku);
      await expect(rowOf('PENDING_REVENUE'), 'The PENDING_REVENUE row is listed').toBeVisible();
    });

    await step('Act: Step 1 — Tick only the PENDING_REVENUE row and read both buttons', async () => {
      await list.checkbox(rowOf('PENDING_REVENUE')).check();
      state = await locked();
    });

    await step('Assert: Expected 1 — Both buttons are locked and no dialog can be opened', async () => {
      expect(state.adjust, '[Expected 1] 재고 조정 is locked').toBe(true);
      expect(state.convert, '[Expected 1] 재고 전환 is locked').toBe(true);
      await expect(list.adjustment.root, '[Expected 1] No adjustment dialog is open').toHaveCount(0);
      await expect(list.conversion.root, '[Expected 1] No conversion dialog is open').toHaveCount(0);
    });

    await step('Act: Step 2 — Hover over each of the 2 buttons and read the tooltip', async () => {
      tips.push(await list.lockTooltip(list.adjustButton), await list.lockTooltip(list.convertButton));
    });

    await step('Assert: Expected 2 — The tooltip shows the system-only sentence', async () => {
      expect(tips[0], '[Expected 2] The 재고 조정 tooltip is the system-only sentence').toBe(guard);
      expect(tips[1], '[Expected 2] The 재고 전환 tooltip is the system-only sentence').toBe(guard);
    });

    await step('Act: Step 3 — Untick it, tick only the IN_TRANSIT row and read both buttons', async () => {
      await list.untickAll();
      await list.checkbox(rowOf('IN_TRANSIT')).check();
      state = await locked();
      tips.push(await list.lockTooltip(list.adjustButton), await list.lockTooltip(list.convertButton));
    });

    await step('Assert: Expected 3 — Both buttons are locked with the same tooltip', async () => {
      expect(state.adjust, '[Expected 3] 재고 조정 is locked').toBe(true);
      expect(state.convert, '[Expected 3] 재고 전환 is locked').toBe(true);
      expect(tips[2], '[Expected 3] The 재고 조정 tooltip is the same sentence').toBe(guard);
      expect(tips[3], '[Expected 3] The 재고 전환 tooltip is the same sentence').toBe(guard);
    });

    await step('Act: Step 4 — Tick the IN_TRANSIT row together with the ordinary CJ Incheon Aam row', async () => {
      await list.checkbox(ordinary).check();
      state = await locked();
    });

    await step('Assert: Expected 4 — Both buttons are locked — one locked row locks the whole selection', async () => {
      expect(state.adjust, '[Expected 4] 재고 조정 is locked').toBe(true);
      expect(state.convert, '[Expected 4] 재고 전환 is locked').toBe(true);
    });

    const opened: Record<string, { adjust: boolean; convert: boolean }> = {};
    await step('Act: Step 5 — Tick only the SCRAP row, open and close 재고 조정, then open and close 재고 전환', async () => {
      await list.untickAll();
      await list.checkbox(rowOf('SCRAP')).check();
      opened.SCRAP = { adjust: await opens('btn.adjustStock'), convert: await opens('btn.convertStock') };
    });

    await step('Assert: Expected 5 — Both dialogs open for the SCRAP row', async () => {
      expect(opened.SCRAP.adjust, '[Expected 5] 재고 조정 opens for the SCRAP row').toBe(true);
      expect(opened.SCRAP.convert, '[Expected 5] 재고 전환 opens for the SCRAP row').toBe(true);
    });

    await step('Act: Step 6 — Repeat step 5 for the QUARANTINE row and for the DEFECTIVE row', async () => {
      for (const name of ['QUARANTINE', 'DEFECTIVE'] as const) {
        await list.untickAll();
        await list.checkbox(rowOf(name)).check();
        opened[name] = { adjust: await opens('btn.adjustStock'), convert: await opens('btn.convertStock') };
      }
    });

    await step('Assert: Expected 6 — Both dialogs open for the QUARANTINE row and for the DEFECTIVE row', async () => {
      for (const name of ['QUARANTINE', 'DEFECTIVE']) {
        expect(opened[name].adjust, `[Expected 6] 재고 조정 opens for the ${name} row`).toBe(true);
        expect(opened[name].convert, `[Expected 6] 재고 전환 opens for the ${name} row`).toBe(true);
      }
    });

    await step('Act: Step 7 — Click the 재고이력 (Stock history) button on the PENDING_REVENUE row', async () => {
      await list.untickAll();
      await list.openHistory(rowOf('PENDING_REVENUE'));
    });

    await step('Assert: Expected 7 — The stock history dialog opens', async () => {
      await list.history.waitOpen('ko');
    });
  });

  test('TC_US134_225 — An adjustment at the DEFECTIVE warehouse moves the on-hold bucket', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_225',
      'Critical',
      TAGS,
      `On a DEFECTIVE (불량) row with on hold 20 / available 0 (fixture built deliberately) the dialog has no bucket selector; 증가 5 takes on hold to 25 with available 0, 차감 5 takes it back to 20, 차감 999 is rejected with WH-STOCK_ADJUSTMENT_BELOW_ZERO naming hold: 20 and requested: 999; on the CJ Incheon Aam row 증가 5 takes available 120 → 125. 보류재고 is not a list column, so both buckets are read from the stock record. Not automated: whether the message "presents available: 0 as the reason" is a wording judgement — the message parameters are asserted instead. Deviation observed (run 05/10/2026): the server prints the signed change "requested: -999" instead of the TC's "requested: 999" — asserted as the TC states. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const defective = world.bucket(cj, '불량');
    const sku = await ownStockSku(world, 'A225', cj.id, { available: 120 });
    await stockDb.upsertStock(sku.skuId, defective.id, { available: 0, hold: 20 });
    const defectiveRow = list.row(sku.skuCode, defective.name);
    const cjRow = list.row(sku.skuCode, cj.name);
    const buckets = async (warehouseId: number) => {
      const stock = await stockDb.stock(sku.skuId, warehouseId);
      return { hold: stock?.hold_quantity ?? -1, available: stock?.available_quantity ?? -1 };
    };
    const adjust = async (row: typeof cjRow, quantity: string, modifyType: 'ADD' | 'SUBTRACT') => {
      await list.openAdjustment([row]);
      await list.adjustment.fillLine(0, { quantity, modifyType, reason: 'ADJUSTMENT' });
      return list.save(list.adjustment, ADJUST_URL);
    };
    let controls = { selects: 0, radios: 0, bodySelects: 0 };
    let after = { hold: -1, available: -1 };

    await step('Arrange: Pre-condition 1–4 — Own row in the DEFECTIVE warehouse (on hold 20, available 0) and in CJ Incheon Aam (available 120)', async () => {
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Tick the DEFECTIVE row, open 재고 조정 and look for a bucket selector', async () => {
      await list.openAdjustment([defectiveRow]);
      controls = {
        selects: await list.adjustment.rows.nth(0).locator('select').count(),
        radios: await list.adjustment.rows.nth(0).locator('input[type="radio"]').count(),
        bodySelects: await list.adjustment.body.locator('select').count(),
      };
    });

    await step('Assert: Expected 1 — The dialog opens and there is no bucket selector', async () => {
      await expect(list.adjustment.root, '[Expected 1] The dialog is open').toBeVisible();
      expect(controls.selects, '[Expected 1] The row has only the 조정사유 select').toBe(1);
      expect(controls.bodySelects, '[Expected 1] The dialog has no other select').toBe(1);
      expect(controls.radios, '[Expected 1] The only radios are 증가 / 차감').toBe(2);
    });

    await step('Act: Step 2 — Enter 5 · 증가 (Increase) and save, then read 보류재고 and 가용재고', async () => {
      await list.adjustment.fillLine(0, { quantity: '5', modifyType: 'ADD', reason: 'ADJUSTMENT' });
      await list.save(list.adjustment, ADJUST_URL);
      after = await buckets(defective.id);
    });

    await step('Assert: Expected 2 — 보류재고 goes from 20 to 25 and 가용재고 stays 0', async () => {
      expect(after.hold, '[Expected 2] On-hold stock is 25').toBe(25);
      expect(after.available, '[Expected 2] Available stock stays 0').toBe(0);
    });

    await step('Act: Step 3 — Enter 5 · 차감 (Decrease) and save, then read both buckets', async () => {
      await adjust(defectiveRow, '5', 'SUBTRACT');
      after = await buckets(defective.id);
    });

    await step('Assert: Expected 3 — 보류재고 goes back to 20', async () => {
      expect(after.hold, '[Expected 3] On-hold stock is back to 20').toBe(20);
      expect(after.available, '[Expected 3] Available stock stays 0').toBe(0);
    });

    let rejected: SaveOutcome | undefined;
    let message = '';
    await step('Act: Step 4 — Enter 999 · 차감 (Decrease) and save, then read the error and its parameters', async () => {
      rejected = await adjust(defectiveRow, '999', 'SUBTRACT');
      if (rejected.status >= 400) {
        await expect(list.adjustment.errorAlert, 'The error is shown in the dialog').toBeVisible();
        message = squash(await list.adjustment.errorAlert.textContent());
      }
    });

    await step('Assert: Expected 4 — Rejected with WH-STOCK_ADJUSTMENT_BELOW_ZERO naming hold: 20 and requested: 999', async () => {
      expect(rejected?.status, '[Expected 4] The save is rejected').toBeGreaterThanOrEqual(400);
      expect(rejected?.code, '[Expected 4] The code is WH-STOCK_ADJUSTMENT_BELOW_ZERO').toBe('WH-STOCK_ADJUSTMENT_BELOW_ZERO');
      expect(message, '[Expected 4] The message starts with the below-zero sentence').toContain(BELOW_ZERO);
      expect(message, '[Expected 4] The message carries hold: 20').toContain('hold: 20');
      expect(message, '[Expected 4] The message carries requested: 999').toContain('requested: 999');
    });

    let cjAvailable = -1;
    await step('Act: Step 5 — Repeat step 2 on the CJ Incheon Aam row and read which bucket moved', async () => {
      await list.adjustment.clickCancel();
      await list.adjustment.confirmDiscard();
      await list.adjustment.expectClosed();
      await list.untickAll();
      await adjust(cjRow, '5', 'ADD');
      cjAvailable = (await buckets(cj.id)).available;
    });

    await step('Assert: Expected 5 — 가용재고 goes from 120 to 125 at the CJ warehouse', async () => {
      expect(cjAvailable, '[Expected 5] Available stock of the CJ row is 125').toBe(125);
    });
  });

  test('TC_US134_226 — A decrease is refused on a defective row whose stock sits in available, and goes through once it is on hold', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_226',
      'Medium',
      TAGS,
      `A DEFECTIVE (불량) row with available 5 / on hold 0 (the shape US105's damaged receipt writes today) refuses 차감 5 with WH-STOCK_ADJUSTMENT_BELOW_ZERO naming available: 5, hold: 0, physical: 5, requested: 5 and both buckets unchanged; 재고 전환 보류재고 지정 5 then gives available 0 / on hold 5, and 차감 5 now goes through to on hold 0 and total 0. 보류재고 is not a list column, so it is read from the stock record. Deviation observed (run 05/10/2026): the server prints the signed change "requested: -5" instead of the TC's "requested: 5" — asserted as the TC states. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const defective = world.bucket(world.warehouses.CJ, '불량');
    const sku = await ownStockSku(world, 'A226', defective.id, { available: 5, hold: 0 });
    const row = list.row(sku.skuCode, defective.name);
    const stockOf = async () => stockDb.stock(sku.skuId, defective.id);
    let rejected: SaveOutcome | undefined;

    await step('Arrange: Pre-condition 1–3 — Own row in the DEFECTIVE warehouse holding available 5 and on hold 0', async () => {
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Tick the DEFECTIVE row and click 재고 조정 (Stock adjustment)', async () => {
      await list.openAdjustment([row]);
    });

    await step('Assert: Expected 1 — The dialog opens with 1 line', async () => {
      await expect(list.adjustment.rows, '[Expected 1] The dialog holds 1 line').toHaveCount(1);
    });

    await step('Act: Step 2 — Type 5 · 차감 (Decrease) · 조정 (Adjustment) and click 저장 (Save)', async () => {
      await list.adjustment.fillLine(0, { quantity: '5', modifyType: 'SUBTRACT', reason: 'ADJUSTMENT' });
      rejected = await list.save(list.adjustment, ADJUST_URL);
    });

    await step('Assert: Expected 2 — Save is rejected and no adjustment is created', async () => {
      expect(rejected?.status, '[Expected 2] The save is rejected').toBeGreaterThanOrEqual(400);
      expect(await stockDb.adjustments(sku.skuId), '[Expected 2] No adjustment is created').toHaveLength(0);
    });

    let available = '';
    let stock = await stockOf();
    await step('Act: Step 3 — Read the message, 가용재고 on the row and 보류재고 from the stock record', async () => {
      await expect(list.adjustment.errorAlert, 'The error is shown in the dialog').toBeVisible();
      available = await list.cellText(row, 'col.availableQuantity');
      stock = await stockOf();
    });

    await step('Assert: Expected 3 — WH-STOCK_ADJUSTMENT_BELOW_ZERO with available: 5, hold: 0, physical: 5, requested: 5; buckets unchanged', async () => {
      expect(rejected?.code, '[Expected 3] The code is WH-STOCK_ADJUSTMENT_BELOW_ZERO').toBe('WH-STOCK_ADJUSTMENT_BELOW_ZERO');
      for (const part of [BELOW_ZERO, 'available: 5', 'hold: 0', 'physical: 5', 'requested: 5']) {
        await expect(list.adjustment.errorAlert, `[Expected 3] The message carries ${part}`).toContainText(part);
      }
      expect(available, '[Expected 3] 가용재고 is unchanged at 5').toBe('5');
      expect(stock?.hold_quantity, '[Expected 3] 보류재고 is unchanged at 0').toBe(0);
    });

    let conversion: SaveOutcome | undefined;
    await step('Act: Step 4 — Tick the row, 재고 전환 with 보류재고 지정 (가용재고 → 보류재고), type 5 and save', async () => {
      await list.adjustment.clickCancel();
      await list.adjustment.confirmDiscard();
      await list.adjustment.expectClosed();
      await list.openConversion([row]);
      await list.conversion.choosePolicy('SECURE_HOLD');
      await list.conversion.fillLine(0, { quantity: '5' });
      conversion = await list.save(list.conversion, CONVERT_URL);
      stock = await stockOf();
    });

    await step('Assert: Expected 4 — The conversion goes through with 등록되었습니다; 가용재고 0 and 보류재고 5', async () => {
      expect(conversion?.status, '[Expected 4] The conversion is accepted').toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 4] ${REGISTERED} appears`).toContainText(REGISTERED);
      expect(stock?.available_quantity, '[Expected 4] 가용재고 becomes 0').toBe(0);
      expect(stock?.hold_quantity, '[Expected 4] 보류재고 becomes 5').toBe(5);
    });

    let decrease: SaveOutcome | undefined;
    let total = '';
    await step('Act: Step 5 — Repeat step 2, then read 전체재고 on the row and 보류재고 from the stock record', async () => {
      await list.openAdjustment([row]);
      await list.adjustment.fillLine(0, { quantity: '5', modifyType: 'SUBTRACT', reason: 'ADJUSTMENT' });
      decrease = await list.save(list.adjustment, ADJUST_URL);
      total = await list.cellText(row, 'col.totalQuantity');
      stock = await stockOf();
    });

    await step('Assert: Expected 5 — The decrease now goes through: 보류재고 0 and 전체재고 0', async () => {
      expect(decrease?.status, '[Expected 5] The decrease is accepted').toBeLessThan(300);
      expect(stock?.hold_quantity, '[Expected 5] 보류재고 becomes 0').toBe(0);
      expect(toNumber(total), '[Expected 5] 전체재고 becomes 0').toBe(0);
    });
  });

  test('TC_US134_227 — Cancel asks first and clears the dialog when something has been typed', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_227',
      'Low',
      TAGS,
      `취소 with nothing typed closes the dialog with no question; with 5 typed it opens a confirm box "작성된 항목을 등록하지 않고, 입력창을 닫을까요?" and closes on confirming; the reopened dialog has an empty 조정 수량. Nothing is saved, so the shared DEMO-SKU-0001 row is used read-only. ${WORLD_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const row = list.row(world.sku('SKU0001').skuCode, world.warehouses.CJ.name);
    let confirmText = '';
    let quantity = '';

    await step('Arrange: Pre-condition 1–3 — DEMO-SKU-0001 in CJ Incheon Aam on the list; test quantity 5', async () => {
      await list.openWorld(world, 'ko');
    });

    await step('Act: Step 1 — Tick the row, click 재고 조정 and click 취소 (Cancel) with nothing typed', async () => {
      await list.openAdjustment([row]);
      await list.adjustment.clickCancel();
    });

    await step('Assert: Expected 1 — The dialog closes with no question', async () => {
      await list.adjustment.expectClosed();
      await expect(list.adjustment.confirmClose, '[Expected 1] No confirm box is shown').toHaveCount(0);
    });

    await step('Act: Step 2 — Open the dialog again, type 5 into 조정 수량 and click 취소 (Cancel)', async () => {
      await list.clickToolbar('btn.adjustStock');
      await list.adjustment.waitOpen('ko');
      await list.adjustment.fillLine(0, { quantity: '5' });
      await list.adjustment.clickCancel();
    });

    await step('Assert: Expected 2 — A confirm dialog opens', async () => {
      await expect(list.adjustment.confirmClose, '[Expected 2] The confirm box opens').toBeVisible();
    });

    await step('Act: Step 3 — Read the confirm dialog, then confirm closing', async () => {
      confirmText = squash(await list.adjustment.confirmClose.textContent());
      await list.adjustment.confirmDiscard();
    });

    await step('Assert: Expected 3 — The confirm text is "작성된 항목을 등록하지 않고, 입력창을 닫을까요?" and the dialog closes', async () => {
      expect(confirmText, `[Expected 3] The confirm box reads ${ko('msg.closeWithoutSaving')}`).toContain(ko('msg.closeWithoutSaving'));
      await list.adjustment.expectClosed();
    });

    await step('Act: Step 4 — Open the dialog again and read 조정 수량 (Adjustment quantity)', async () => {
      await list.clickToolbar('btn.adjustStock');
      await list.adjustment.waitOpen('ko');
      quantity = await list.adjustment.quantityInput(0).inputValue();
    });

    await step('Assert: Expected 4 — The field is empty', async () => {
      expect(quantity, '[Expected 4] 조정 수량 is empty').toBe('');
    });
  });
});
