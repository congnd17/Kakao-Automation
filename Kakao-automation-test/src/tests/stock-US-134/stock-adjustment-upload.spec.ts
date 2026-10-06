import { FileChooser } from '@playwright/test';
import { test, expect } from '@fixtures/stock.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { squash } from '@pages/stock-calculation.page';
import { ADJUST_URL, ownSkuLines, ownStockSku } from '@pages/stock-adjustment.page';
import {
  ADJ_HEADERS, ADJ_UPLOAD_URL, AdjLine, StockAdjustmentUploadPage, UploadOutcome, adjustmentWorkbook, ole2XlsFile, rawFile,
} from '@pages/stock-adjustment-upload.page';
import { stx } from '@utils/stock.i18n';
import { stockTags } from '@utils/stock-spec';
import { stockDb } from '@utils/stock-db';
import { uniqueCode } from '@utils/stock.data';
import type { WorldSku } from '@utils/stock.data';
import type { XlsxCell } from '@utils/xlsx-writer';
import { readXlsxRows } from '@utils/xlsx-reader';

/**
 * US134 — nhóm [Adjustment Upload] (TC_US134_344–368): nút 재고 조정 업로드 trên màn 재고 관리. Nguồn TC:
 * SCRATCH/us134/TC_US134_<n>.txt (Steps N / Expected N → `Act: Step N` / `Assert: Expected N`). Kỳ vọng assert theo TC;
 * chỗ UI khác TC ghi trong description. Mọi workbook chỉ ghi lên SKU riêng của test (world.createPhysicalSku + tồn kho
 * dựng bằng DB) — 12 dòng world giữ nguyên. Số dòng TC ghi ("row 2") = số dòng của sheet (dòng 1 là header).
 */
const TAGS = stockTags('adjustment-upload');
const ko = (key: Parameters<typeof stx>[0]) => stx(key, 'ko');
const DONE = ko('msg.uploadAdjustmentDone');
const MIB = 1_048_576;
const OWN_NOTE =
  'Data: the DEMO-SKU rows of the shared world must stay untouched, so the test creates its own physical SKU(s) (Partner A, manufacturer M1) in the automation CJ Incheon Aam warehouse, seeds the TC stock through the DB, and every workbook (built in memory) names only those SKUs; the TC SKU codes map onto them. Row numbers in the TC are sheet rows (row 1 = header).';

/** 1 dòng workbook cho SKU × kho của test. */
const at = (sku: WorldSku, warehouseId: number, quantity: XlsxCell, direction: XlsxCell, extra: Partial<AdjLine> = {}): AdjLine => ({
  skuCode: sku.skuCode,
  warehouseId: String(warehouseId),
  quantity,
  direction,
  ...extra,
});

/** Số dòng của sheet mà câu lỗi nêu (`{n}행`). */
const rowNumberOf = (message: string): number => Number(/^(\d+)행/.exec(message)?.[1] ?? NaN);

test.describe('[Adjustment Upload] Stock management — stock adjustment workbook upload', () => {
  test('TC_US134_344 — The adjustment upload button sends the file to the adjustment upload address only', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_344',
      'Medium',
      TAGS,
      `재고 조정 업로드 is shown on the toolbar and the chosen workbook goes to POST /api/v1/adjustments/upload-excel only — never to the inbound-request (/incoming/upload-excel) or SKU-creation (/skus/upload-excel) upload address. The file picker is answered in Step 2 (Playwright receives the OS picker as soon as the button is clicked); Step 3 reads the recorded call. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'U344', cj.id, { available: 20 });
    const file = adjustmentWorkbook(`adjustment-${sku.skuCode}.xlsx`, [at(sku, cj.id, 1, 'P')]);
    let outcome: UploadOutcome | undefined;
    let paths: string[] = [];

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; a valid adjustment workbook on the own SKU; every upload call is recorded', async () => {
      expect(file.buffer.length, 'The adjustment workbook is built').toBeGreaterThan(0);
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management)', async () => {
      await list.open('ko');
    });

    await step('Assert: Expected 1 — The adjustment upload button is displayed', async () => {
      await expect(list.uploadAdjustmentButton, '[Expected 1] 재고 조정 업로드 (Upload stock adjustment) is displayed').toBeVisible();
      await expect(list.uploadAdjustmentButton, `[Expected 1] The button reads ${ko('btn.uploadAdjustmentExcel')}`).toContainText(ko('btn.uploadAdjustmentExcel'));
    });

    await step('Act: Step 2 — Click 재고 조정 업로드 (Upload stock adjustment) and choose the workbook in the file picker', async () => {
      outcome = await list.uploadAdjustment(file);
    });

    await step('Assert: Expected 2 — The file is sent to the stock-adjustment upload address', async () => {
      expect(outcome?.uploadUrls.some((url) => new URL(url).pathname === ADJ_UPLOAD_URL), `[Expected 2] The file is sent to ${ADJ_UPLOAD_URL}`).toBe(true);
      expect(outcome?.status, '[Expected 2] The adjustment upload address takes the file').toBeLessThan(300);
    });

    await step('Act: Step 3 — Read the address of every upload call made', async () => {
      paths = (outcome?.uploadUrls ?? []).map((url) => new URL(url).pathname);
    });

    await step('Assert: Expected 3 — The call does not use the inbound-request or SKU-creation upload address', async () => {
      expect(paths, '[Expected 3] The inbound-request upload address is not called').not.toContain('/api/v1/incoming/upload-excel');
      expect(paths, '[Expected 3] The SKU-creation upload address is not called').not.toContain('/api/v1/skus/upload-excel');
      expect(paths, '[Expected 3] Only the adjustment upload address is called').toEqual([ADJ_UPLOAD_URL]);
    });
  });

  test('TC_US134_345 — The file picker offers .xlsx and .xls and the chosen file uploads at once with no confirmation', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_345',
      'Medium',
      TAGS,
      `Clicking 재고 조정 업로드 opens the OS file picker (Playwright file-chooser event), the hidden input accepts .xlsx and .xls, choosing a file sends POST /adjustments/upload-excel with no further click, and no in-app dialog is open when the call leaves the browser (the call is held in the browser to look at the screen at that moment). ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'U345', cj.id, { available: 20 });
    const file = adjustmentWorkbook(`adjustment-${sku.skuCode}.xlsx`, [at(sku, cj.id, 1, 'P')]);
    let chooser: FileChooser | undefined;
    let accept: string[] = [];
    let sentUrl = '';
    let status = 0;
    let modalsAtCall = -1;

    await step('Arrange: Pre-condition 1–2 — Logged in with write access; a valid adjustment workbook on the own SKU', async () => {
      await list.open('ko');
    });

    await step('Act: Step 1 — Click 재고 조정 업로드 (Upload stock adjustment)', async () => {
      chooser = await list.openAdjustmentPicker();
    });

    await step('Assert: Expected 1 — The operating system file picker opens', async () => {
      expect(chooser, '[Expected 1] The operating system file picker opens').toBeDefined();
      expect(chooser?.isMultiple(), '[Expected 1] The picker takes a single file').toBe(false);
    });

    await step('Act: Step 2 — Read the accepted file types', async () => {
      accept = ((await list.adjustmentFileInput.getAttribute('accept')) ?? '').split(',').map((type) => type.trim());
    });

    await step('Assert: Expected 2 — It offers .xlsx and .xls files', async () => {
      expect(accept, '[Expected 2] The picker offers .xlsx files').toContain('.xlsx');
      expect(accept, '[Expected 2] The picker offers .xls files').toContain('.xls');
    });

    await step('Act: Step 3 — Pick the file', async () => {
      const held = await list.paging.holdRequest((url, method) => method === 'POST' && url.includes(ADJ_UPLOAD_URL));
      try {
        const response = page.waitForResponse((res) => res.url().includes(ADJ_UPLOAD_URL), { timeout: 60_000 });
        await chooser?.setFiles(file);
        sentUrl = (await held.seen).url();
        modalsAtCall = await list.openModals.count();
        held.release();
        status = (await response).status();
      } finally {
        held.release();
        await held.dispose();
      }
      await expect(list.uploadAdjustmentButton, 'The upload button is usable again').toHaveAttribute('aria-disabled', 'false', { timeout: 60_000 });
    });

    await step('Assert: Expected 3 — The selected file uploads immediately with no extra click', async () => {
      expect(new URL(sentUrl).pathname, '[Expected 3] Choosing the file alone sends it to the adjustment upload address').toBe(ADJ_UPLOAD_URL);
      expect(status, '[Expected 3] The upload is taken').toBeLessThan(300);
      await expect(list.toast(DONE).first(), `[Expected 3] ${DONE} confirms the upload`).toBeVisible();
    });

    await step('Act: Step 4 — Look for any extra confirmation control before the call', async () => {
      expect(modalsAtCall, 'The screen was read while the call was held').toBeGreaterThanOrEqual(0);
    });

    await step('Assert: Expected 4 — No in-app confirmation step appears before the call', async () => {
      expect(modalsAtCall, '[Expected 4] No dialog is open when the upload call leaves the browser').toBe(0);
    });
  });

  test('TC_US134_346 — The adjustment upload runs with no row ticked and no selection guard', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_346',
      'Medium',
      TAGS,
      `With no tick box selected, 재고 조정 업로드 opens the file picker at once (no 선택된 재고가 없습니다. 재고를 선택해주세요. guard), and a valid workbook is processed with ${DONE}. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'U346', cj.id, { available: 20 });
    const file = adjustmentWorkbook(`adjustment-${sku.skuCode}.xlsx`, [at(sku, cj.id, 2, 'P')]);
    let ticked = -1;
    let chooser: FileChooser | undefined;
    let guards = -1;
    let outcome: UploadOutcome | undefined;

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; no row selected; a valid adjustment workbook on the own SKU', async () => {
      await list.open('ko');
    });

    await step('Act: Step 1 — Confirm no tick box is selected', async () => {
      ticked = await list.tickedBoxes().count();
    });

    await step('Assert: Expected 1 — No row is ticked', async () => {
      expect(ticked, '[Expected 1] No row is ticked').toBe(0);
    });

    await step('Act: Step 2 — Click 재고 조정 업로드 (Upload stock adjustment)', async () => {
      chooser = await list.openAdjustmentPicker();
      guards = await page.getByText('선택된 재고가 없습니다.').count();
    });

    await step('Assert: Expected 2 — The file picker opens immediately and no selection guard appears', async () => {
      expect(chooser, '[Expected 2] The file picker opens immediately').toBeDefined();
      expect(guards, '[Expected 2] No 선택된 재고가 없습니다. 재고를 선택해주세요. guard appears').toBe(0);
      await expect(list.guardAlert, '[Expected 2] No guard alert is shown above the table').toHaveCount(0);
    });

    await step('Act: Step 3 — Pick the valid file', async () => {
      outcome = await list.uploadAdjustment(file, chooser);
    });

    await step(`Assert: Expected 3 — The adjustment file is processed and ${DONE} is shown`, async () => {
      expect(outcome?.status, '[Expected 3] The adjustment file is processed').toBeLessThan(300);
      await expect(list.toast(DONE).first(), `[Expected 3] ${DONE} (Stock adjustment upload is complete.) is shown`).toBeVisible();
      expect(await list.adjustmentCount([sku.skuId]), '[Expected 3] The adjustment is written').toBe(1);
    });
  });

  test('TC_US134_347 — Direction P increases and M decreases available stock and history shows +10 / -4', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_347',
      'Critical',
      TAGS,
      `Uploading P 10 then M 4 on a row with 가용재고 120 shows 130 then 126 on the list, and the 2 newest 재고이력 movements read -4 (newest) and +10. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'U347', cj.id, { available: 120 });
    const plus = adjustmentWorkbook(`adjustment-P-${sku.skuCode}.xlsx`, [at(sku, cj.id, 10, 'P')]);
    const minus = adjustmentWorkbook(`adjustment-M-${sku.skuCode}.xlsx`, [at(sku, cj.id, 4, 'M')]);
    let first: UploadOutcome | undefined;
    let second: UploadOutcome | undefined;
    let afterPlus = '';
    let afterMinus = '';
    let changes: string[] = [];

    await step('Arrange: Pre-condition 1–4 — Own physical row in CJ Incheon Aam with 가용재고 120; a P 10 workbook and an M 4 workbook', async () => {
      await list.open('ko');
      expect(await list.availableOnList(sku.skuCode, cj.name), 'The own row starts at 가용재고 120').toBe('120');
    });

    await step('Act: Step 1 — Upload the file with direction P through 재고 조정 업로드 (Upload stock adjustment)', async () => {
      first = await list.uploadAdjustment(plus);
    });

    await step('Assert: Expected 1 — The file is taken', async () => {
      expect(first?.status, '[Expected 1] The P workbook is taken').toBeLessThan(300);
    });

    await step('Act: Step 2 — Read 가용재고 (Available stock) of the row', async () => {
      afterPlus = await list.availableOnList(sku.skuCode, cj.name);
    });

    await step('Assert: Expected 2 — Available stock shows 130, so P is an INCREASE', async () => {
      expect(afterPlus, '[Expected 2] 가용재고 shows 130 — P is an increase').toBe('130');
    });

    await step('Act: Step 3 — Upload the file with direction M', async () => {
      second = await list.uploadAdjustment(minus);
    });

    await step('Assert: Expected 3 — The file is taken', async () => {
      expect(second?.status, '[Expected 3] The M workbook is taken').toBeLessThan(300);
    });

    await step('Act: Step 4 — Read 가용재고 (Available stock) again', async () => {
      afterMinus = await list.availableOnList(sku.skuCode, cj.name);
    });

    await step('Assert: Expected 4 — Available stock shows 126, so M is a DECREASE', async () => {
      expect(afterMinus, '[Expected 4] 가용재고 shows 126 — M is a decrease').toBe('126');
    });

    await step('Act: Step 5 — Open 재고이력 (Stock history) for the row and read 변경수량 (Change qty) of the 2 newest movements', async () => {
      await list.openHistoryOf(list.row(sku.skuCode, cj.name), 'ko');
      changes = (await list.historyLines()).slice(0, 2).map((line) => line.change);
      await list.closeHistory();
    });

    await step('Assert: Expected 5 — The 2 movements show plus 10 and minus 4', async () => {
      expect(changes.length, '[Expected 5] 2 movements are listed').toBe(2);
      expect(changes[0], '[Expected 5] The newest movement shows minus 4').toBe('-4');
      expect(changes[1], '[Expected 5] The movement before it shows plus 10').toBe('+10');
    });
  });

  test('TC_US134_348 — The adjustment workbook has exactly 6 columns keyed on SKU code and warehouse ID', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_348',
      'Medium',
      TAGS,
      `The workbook schema is the 6 Korean headers SKU 코드 · 창고 ID · 조정수량 · 증가(P)/차감(M) · 조정사유코드 · 비고 (there is no template download, so the workbook is built from the TC column table and read back), keyed on SKU 코드 (not SKU ID) and 창고 ID (not a name); a fully filled workbook is accepted and the stored adjustment points at the intended SKU and warehouse. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'U348', cj.id, { available: 40 });
    const file = adjustmentWorkbook(`adjustment-${sku.skuCode}.xlsx`, [at(sku, cj.id, 3, 'P', { note: `TC348 ${sku.skuCode}` })]);
    let header: string[] = [];
    let outcome: UploadOutcome | undefined;
    let stored: Array<{ sku_id: number; warehouse_id: number }> = [];

    await step('Arrange: Pre-condition 1–3 — A valid adjustment workbook; the own CJ Incheon Aam warehouse ID and the reason code ADJUSTMENT are known', async () => {
      await list.open('ko');
    });

    await step('Act: Step 1 — Read the header row from left to right and count the columns', async () => {
      header = readXlsxRows(file.buffer)[0];
    });

    await step('Assert: Expected 1 — Exactly 6 columns: SKU 코드, 창고 ID, 조정수량, 증가(P)/차감(M), 조정사유코드, 비고', async () => {
      expect(header.length, '[Expected 1] The header row has exactly 6 columns').toBe(6);
      ADJ_HEADERS.forEach((name, index) => expect(header[index], `[Expected 1] Column ${index + 1} is ${name}`).toBe(name));
    });

    await step('Act: Step 2 — Confirm which column carries the SKU key', async () => {
      expect(header[0], 'The key column is read').toBeDefined();
    });

    await step('Assert: Expected 2 — SKU 코드 (SKU code) is the key, not SKU ID', async () => {
      expect(header, '[Expected 2] SKU 코드 carries the key').toContain('SKU 코드');
      expect(header, '[Expected 2] There is no SKU ID column').not.toContain('SKU ID');
    });

    await step('Act: Step 3 — Confirm how the warehouse is supplied', async () => {
      expect(header[1], 'The warehouse column is read').toBeDefined();
    });

    await step('Assert: Expected 3 — The warehouse is supplied by ID (창고 ID), not by name', async () => {
      expect(header, '[Expected 3] 창고 ID carries the warehouse').toContain('창고 ID');
      expect(header.filter((name) => /창고명|창고$/.test(name)), '[Expected 3] There is no warehouse-name column').toHaveLength(0);
    });

    await step('Act: Step 4 — Enter valid values in every column and upload the workbook', async () => {
      outcome = await list.uploadAdjustment(file);
    });

    await step('Assert: Expected 4 — The workbook is accepted', async () => {
      expect(outcome?.status, '[Expected 4] The workbook is accepted').toBeLessThan(300);
      await expect(list.toast(DONE).first(), `[Expected 4] ${DONE} is shown`).toBeVisible();
    });

    await step('Act: Step 5 — Open the created adjustment and check which SKU and warehouse it resolved to', async () => {
      stored = (await stockDb.adjustments(sku.skuId)) as unknown as Array<{ sku_id: number; warehouse_id: number }>;
    });

    await step('Assert: Expected 5 — The adjustment resolved to the intended SKU and warehouse', async () => {
      expect(stored.length, '[Expected 5] Exactly 1 adjustment is created').toBe(1);
      expect(Number(stored[0]?.sku_id), `[Expected 5] The adjustment points at SKU ${sku.skuCode}`).toBe(sku.skuId);
      expect(Number(stored[0]?.warehouse_id), `[Expected 5] The adjustment points at warehouse ${cj.name}`).toBe(cj.id);
    });
  });

  test('TC_US134_349 — A successful upload shows its message, re-queries the list once and keeps the ticked rows', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_349',
      'High',
      TAGS,
      `With 2 rows ticked, a valid adjustment workbook finishes with ${DONE}, exactly 1 GET /stock-status re-query follows the upload, and both rows are still ticked after the reload. The 2 own rows stand in for DEMO-SKU-0001 / 0003. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const label = 'U349';
    const [one, two] = await ownSkuLines(world, label, 2);
    await stockDb.upsertStock(one.skuId, cj.id, { available: 30 });
    await stockDb.upsertStock(two.skuId, cj.id, { available: 30 });
    const file = adjustmentWorkbook(`adjustment-${label}.xlsx`, [at(one, cj.id, 1, 'P'), at(two, cj.id, 1, 'P')]);
    const rows = [list.row(one.skuCode, cj.name), list.row(two.skuCode, cj.name)];
    let outcome: UploadOutcome | undefined;

    await step('Arrange: Pre-condition 1–4 — 2 own rows listed and tickable; a valid workbook; the upload calls are recorded from a clean start', async () => {
      await list.open('ko');
      await list.findGroup(world, label);
      for (const row of rows) await expect(row, 'The own row is listed').toBeVisible();
    });

    await step('Act: Step 1 — Tick the 2 rows', async () => {
      for (const row of rows) await list.tick(row, 'own row');
    });

    await step('Assert: Expected 1 — Both rows are ticked', async () => {
      for (const row of rows) await expect(list.checkbox(row), '[Expected 1] The row is ticked').toBeChecked();
    });

    await step('Act: Step 2 — Upload the adjustment workbook through 재고 조정 업로드 (Upload stock adjustment)', async () => {
      outcome = await list.uploadAdjustment(file);
    });

    await step('Assert: Expected 2 — The upload finishes', async () => {
      expect(outcome?.status, '[Expected 2] The upload finishes successfully').toBeLessThan(300);
    });

    await step('Act: Step 3 — Read the message that appears and the calls made after the upload', async () => {
      await expect(list.lastToast(), 'A message appears after the upload').toBeVisible();
    });

    await step(`Assert: Expected 3 — ${DONE} is shown and exactly 1 list re-query call is sent`, async () => {
      await expect(list.toast(DONE).first(), `[Expected 3] The message shows ${DONE}`).toBeVisible();
      expect(outcome?.listReloads, '[Expected 3] Exactly 1 GET /stock-status re-query follows the upload').toBe(1);
    });

    await step('Act: Step 4 — Read the tick boxes once the list has reloaded', async () => {
      await list.waitForList();
    });

    await step('Assert: Expected 4 — Both rows are still ticked', async () => {
      for (const row of rows) await expect(list.checkbox(row), '[Expected 4] The row is still ticked after the upload').toBeChecked();
    });
  });

  test('TC_US134_350 — The workbook is keyed on SKU code and a SKU ID in the SKU 코드 column is not found', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_350',
      'High',
      TAGS,
      `A workbook carrying the SKU code is accepted and its adjustment points at that SKU; the identical workbook carrying the SKU ID in the SKU 코드 column is rejected with WH-SKU_CODE_NOT_FOUND "2행의 SKU 코드를 찾을 수 없습니다. - skuCode: <SKU ID>". ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'U350', cj.id, { available: 30 });
    const byCode = adjustmentWorkbook(`adjustment-code-${sku.skuCode}.xlsx`, [at(sku, cj.id, 1, 'P')]);
    const byId = adjustmentWorkbook(`adjustment-id-${sku.skuCode}.xlsx`, [at(sku, cj.id, 1, 'P', { skuCode: String(sku.skuId) })]);
    let first: UploadOutcome | undefined;
    let second: UploadOutcome | undefined;
    let stored: Array<{ sku_id: number }> = [];

    await step('Arrange: Pre-condition 1–3 — Own SKU with its SKU ID known; 2 workbooks identical except the SKU 코드 cell (code vs SKU ID)', async () => {
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload the SKU-code workbook', async () => {
      first = await list.uploadAdjustment(byCode);
    });

    await step('Assert: Expected 1 — The workbook is accepted', async () => {
      expect(first?.status, '[Expected 1] The SKU-code workbook is accepted').toBeLessThan(300);
    });

    await step('Act: Step 2 — Open the adjustment it created and read which SKU it points at', async () => {
      stored = (await stockDb.adjustments(sku.skuId)) as unknown as Array<{ sku_id: number }>;
    });

    await step('Assert: Expected 2 — The adjustment was written against the SKU code', async () => {
      expect(stored.length, `[Expected 2] 1 adjustment is written against ${sku.skuCode}`).toBe(1);
      expect(Number(stored[0]?.sku_id), `[Expected 2] The adjustment points at ${sku.skuCode}`).toBe(sku.skuId);
    });

    await step('Act: Step 3 — Upload the SKU-ID workbook', async () => {
      second = await list.uploadAdjustment(byId);
    });

    await step('Assert: Expected 3 — The workbook is rejected with WH-SKU_CODE_NOT_FOUND naming the SKU ID', async () => {
      expect(second?.status, '[Expected 3] The SKU-ID workbook is rejected').toBeGreaterThanOrEqual(400);
      expect(second?.code, '[Expected 3] The code is WH-SKU_CODE_NOT_FOUND').toBe('WH-SKU_CODE_NOT_FOUND');
      expect(second?.message, '[Expected 3] The message reads "{n}행의 SKU 코드를 찾을 수 없습니다. - skuCode: <SKU ID>"').toBe(`2행의 SKU 코드를 찾을 수 없습니다. - skuCode: ${sku.skuId}`);
      expect(await list.adjustmentCount([sku.skuId]), '[Expected 3] The rejected workbook writes nothing').toBe(1);
    });
  });

  test('TC_US134_351 — No row cap applies at the 3,000-row write batch: 3,000 and 3,001 rows are all written', async ({ page, world }) => {
    test.setTimeout(600_000);
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_351',
      'Medium',
      TAGS,
      `A 3,000-row and a 3,001-row workbook (each under 1 MB) both finish with ${DONE}; exactly 3,000 then 3,001 adjustments are written (row 3,001 targets its own SKU so its write can be seen), and no row-count message appears. The rows spread over 3 own SKUs with increase 1 each; 창고 ID is written as a numeric cell (a text cell would push the 3,001-row file just over 1 MB). ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const skus = await ownSkuLines(world, 'B51', 4);
    for (const sku of skus) await stockDb.upsertStock(sku.skuId, cj.id, { available: 10 });
    const spread = (count: number) => Array.from({ length: count }, (_, index) => at(skus[index % 3], cj.id, 1, 'P', { warehouseId: cj.id }));
    const file3000 = adjustmentWorkbook('adjustment-3000-rows.xlsx', spread(3000));
    const file3001 = adjustmentWorkbook('adjustment-3001-rows.xlsx', [...spread(3000), at(skus[3], cj.id, 1, 'P', { warehouseId: cj.id })]);
    const ids = skus.map((sku) => sku.skuId);
    let first: UploadOutcome | undefined;
    let second: UploadOutcome | undefined;
    let afterFirst = 0;
    let afterSecond = 0;
    let lastRowWrites = 0;
    const messages: string[] = [];

    await step('Arrange: Pre-condition 1–2 — A 3,000-row and a 3,001-row adjustment workbook, both under 1 MB, on own SKUs', async () => {
      expect(file3000.buffer.length, 'The 3,000-row workbook is under 1 MB').toBeLessThan(MIB);
      expect(file3001.buffer.length, 'The 3,001-row workbook is under 1 MB').toBeLessThan(MIB);
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload the 3,000-row file through 재고 조정 업로드 (Upload stock adjustment) and read the message', async () => {
      first = await list.uploadAdjustment(file3000);
      messages.push(...(await list.toasts.allInnerTexts()).map(squash));
    });

    await step(`Assert: Expected 1 — The file is taken and the message shows ${DONE}`, async () => {
      expect(first?.status, '[Expected 1] The 3,000-row file is taken').toBeLessThan(300);
      await expect(list.toast(DONE).first(), `[Expected 1] The message shows ${DONE}`).toBeVisible();
    });

    await step('Act: Step 2 — Check how many adjustment records were created', async () => {
      afterFirst = await list.adjustmentCount(ids);
    });

    await step('Assert: Expected 2 — Exactly 3,000 adjustments are written', async () => {
      expect(afterFirst, '[Expected 2] Exactly 3,000 adjustments are written — none lost, none doubled').toBe(3000);
    });

    await step('Act: Step 3 — Upload the 3,001-row file the same way and read the message', async () => {
      second = await list.uploadAdjustment(file3001);
      messages.push(...(await list.toasts.allInnerTexts()).map(squash));
    });

    await step(`Assert: Expected 3 — The file is taken and the message shows ${DONE}`, async () => {
      expect(second?.status, '[Expected 3] The 3,001-row file is taken').toBeLessThan(300);
      await expect(list.toast(DONE).first(), `[Expected 3] The message shows ${DONE}`).toBeVisible();
    });

    await step('Act: Step 4 — Check how many adjustment records were created', async () => {
      afterSecond = await list.adjustmentCount(ids);
      lastRowWrites = await list.adjustmentCount([skus[3].skuId]);
    });

    await step('Assert: Expected 4 — Exactly 3,001 adjustments are written, including row 3,001', async () => {
      expect(afterSecond - afterFirst, '[Expected 4] Exactly 3,001 adjustments are written — none lost, none doubled').toBe(3001);
      expect(lastRowWrites, '[Expected 4] Row 3,001 is written').toBe(1);
    });

    await step('Act: Step 5 — Look for any message about going over an allowed row count', async () => {
      expect(messages.length, 'The messages after both uploads are read').toBeGreaterThan(0);
    });

    await step('Assert: Expected 5 — There is no row-count message for either file', async () => {
      for (const message of messages) expect(message, '[Expected 5] Only the completion message is shown — no row-count message').toContain(DONE);
      expect(first?.code, '[Expected 5] The 3,000-row upload carries no error code').toBe('');
      expect(second?.code, '[Expected 5] The 3,001-row upload carries no error code').toBe('');
    });
  });

  test('TC_US134_352 — There is no Download Template action for the adjustment upload', async ({ page }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_352',
      'Medium',
      TAGS,
      'The toolbar and the 재고 조정 업로드 flow carry no Download Template button or link (no "템플릿" / "양식" / "template" control anywhere on the screen), and clicking 재고 조정 업로드 opens only the OS file picker with no template-download call before a file is chosen (the picker is then dismissed without a file).',
    );
    const list = new StockAdjustmentUploadPage(page);
    const template = /템플릿|양식|template/i;
    let controls = -1;
    let besideUpload = -1;
    const calls: string[] = [];
    let opened = false;

    await step('Arrange: Pre-condition 1–2 — Logged in with write access; every API call is recorded from a clean start', async () => {
      page.on('request', (request) => {
        if (request.url().includes('/api/')) calls.push(`${request.method()} ${new URL(request.url()).pathname}`);
      });
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management)', async () => {
      await list.open('ko');
    });

    await step('Assert: Expected 1 — The Stock management list opens', async () => {
      await expect(list.table, '[Expected 1] The stock list is shown').toBeVisible();
      await expect(list.uploadAdjustmentButton, '[Expected 1] 재고 조정 업로드 is on the toolbar').toBeVisible();
    });

    await step('Act: Step 2 — Inspect the toolbar and the whole 재고 조정 업로드 (Upload stock adjustment) flow', async () => {
      controls = await list.card.locator('button, a, label[role="button"]').filter({ hasText: template }).count();
    });

    await step('Assert: Expected 2 — The toolbar and the adjustment upload flow carry no Download Template action', async () => {
      expect(controls, '[Expected 2] No Download Template action is on the stock screen').toBe(0);
    });

    await step('Act: Step 3 — Look for a Download Template button or link beside the upload button', async () => {
      besideUpload = await list.toolbarButtons.locator(':scope > *').filter({ hasText: template }).count();
    });

    await step('Assert: Expected 3 — No Download Template button or link is found beside 재고 조정 업로드', async () => {
      expect(besideUpload, '[Expected 3] No Download Template control sits beside 재고 조정 업로드').toBe(0);
    });

    let callsBeforeFile: string[] = [];
    await step('Act: Step 4 — Click 재고 조정 업로드 (Upload stock adjustment) and read the calls made before a file is chosen', async () => {
      const start = calls.length;
      const chooser = await list.openAdjustmentPicker();
      opened = !!chooser;
      callsBeforeFile = calls.slice(start);
      await chooser.setFiles([]);
    });

    await step('Assert: Expected 4 — Only the operating system file picker opens and no template-download endpoint is called', async () => {
      expect(opened, '[Expected 4] The operating system file picker opens').toBe(true);
      await expect(list.openModals, '[Expected 4] No in-app dialog opens').toHaveCount(0);
      expect(callsBeforeFile.filter((call) => /template|upload-excel/i.test(call)), '[Expected 4] No template-download (or upload) endpoint is called before a file is chosen').toEqual([]);
    });
  });

  test('TC_US134_353 — No file size limit applies: a 2 MB workbook and a small control are both written', async ({ page, world }) => {
    test.setTimeout(600_000);
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_353',
      'High',
      TAGS,
      `A content-valid adjustment workbook of about 2 MB (4,000 rows with a long 비고) is taken with ${DONE} and no error code, every one of its rows is written, the 1-row control under 1 MB is taken too, and the largest size tested is attached to the report. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const skus = await ownSkuLines(world, 'B53', 3);
    for (const sku of skus) await stockDb.upsertStock(sku.skuId, cj.id, { available: 10 });
    const note = 'Automation large workbook row for the file size check '.padEnd(90, 'X');
    const rows = 4000;
    const big = adjustmentWorkbook('adjustment-2mb.xlsx', Array.from({ length: rows }, (_, index) => at(skus[index % 2], cj.id, 1, 'P', { note })));
    const control = adjustmentWorkbook('adjustment-control.xlsx', [at(skus[2], cj.id, 1, 'P')]);
    let bigOutcome: UploadOutcome | undefined;
    let controlOutcome: UploadOutcome | undefined;
    let bigWrites = 0;
    let controlWrites = 0;

    await step('Arrange: Pre-condition 1–3 — A content-valid workbook of about 2 MB and a control workbook under 1 MB, on own SKUs', async () => {
      expect(big.buffer.length, 'The large workbook is about 2 MB').toBeGreaterThan(1.8 * 1_000_000);
      expect(control.buffer.length, 'The control workbook is under 1 MB').toBeLessThan(MIB);
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload the roughly 2 MB file through 재고 조정 업로드 (Upload stock adjustment)', async () => {
      bigOutcome = await list.uploadAdjustment(big);
    });

    await step('Assert: Expected 1 — The file is taken', async () => {
      expect(bigOutcome?.status, '[Expected 1] The 2 MB file is taken').toBeLessThan(300);
    });

    await step('Act: Step 2 — Read the message that appears and the error code if there is one', async () => {
      await expect(list.lastToast(), 'A message appears after the upload').toBeVisible();
    });

    await step(`Assert: Expected 2 — The message shows ${DONE} and no error code appears`, async () => {
      await expect(list.toast(DONE).first(), `[Expected 2] The message shows ${DONE}`).toBeVisible();
      expect(bigOutcome?.code, '[Expected 2] No error code appears').toBe('');
    });

    await step('Act: Step 3 — Check whether any records were created', async () => {
      bigWrites = await list.adjustmentCount([skus[0].skuId, skus[1].skuId]);
    });

    await step('Assert: Expected 3 — Every adjustment row of the roughly 2 MB file is created', async () => {
      expect(bigWrites, `[Expected 3] All ${rows} rows of the 2 MB file are written`).toBe(rows);
    });

    await step('Act: Step 4 — Upload the under-1 MB file as a control', async () => {
      controlOutcome = await list.uploadAdjustment(control);
      controlWrites = await list.adjustmentCount([skus[2].skuId]);
    });

    await step('Assert: Expected 4 — The control file is taken and its records are created', async () => {
      expect(controlOutcome?.status, '[Expected 4] The control file is taken').toBeLessThan(300);
      expect(controlWrites, '[Expected 4] The control record is created').toBe(1);
    });

    const sizes = { largestTestedBytes: big.buffer.length, largestTakenBytes: 0 };
    await step('Act: Step 5 — Write down the largest size the system actually takes', async () => {
      sizes.largestTakenBytes = Math.max(bigOutcome && bigOutcome.status < 300 ? big.buffer.length : 0, controlOutcome && controlOutcome.status < 300 ? control.buffer.length : 0);
      await test.info().attach('Largest workbook size tested', { body: JSON.stringify(sizes, null, 2), contentType: 'application/json' });
    });

    await step('Assert: Expected 5 — The largest size tested is recorded and no file is rejected purely on its size', async () => {
      expect(sizes.largestTakenBytes, '[Expected 5] The largest size tested (about 2 MB) is taken — no rejection on size').toBe(big.buffer.length);
    });
  });

  test('TC_US134_354 — The whole file is rejected when one row would make available stock negative', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_354',
      'High',
      TAGS,
      `A 2-row workbook (decrease 10 on a row with 가용재고 120, decrease 30 on a row with 17) is rejected as a whole with WH-STOCK_ADJUSTMENT_BELOW_ZERO "3행: 조정으로 재고를 0 미만으로 줄일 수 없습니다. - skuCode: <second SKU>…"; both rows keep 120 / 17 and no movement is written. The 2 own SKUs stand in for DEMO-SKU-0001 / 0011. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const [one, two] = await ownSkuLines(world, 'U354', 2);
    await stockDb.upsertStock(one.skuId, cj.id, { available: 120 });
    await stockDb.upsertStock(two.skuId, cj.id, { available: 17 });
    const file = adjustmentWorkbook('adjustment-below-zero.xlsx', [at(one, cj.id, 10, 'M'), at(two, cj.id, 30, 'M')]);
    let outcome: UploadOutcome | undefined;
    const available: string[] = [];
    const movements: number[] = [];

    await step('Arrange: Pre-condition 1–4 — Own rows with 가용재고 120 and 17 in CJ Incheon Aam; a 2-row workbook decreasing 10 and 30', async () => {
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload the file through 재고 조정 업로드 (Upload stock adjustment)', async () => {
      outcome = await list.uploadAdjustment(file);
    });

    await step('Assert: Expected 1 — The entire file is rejected', async () => {
      expect(outcome?.status, '[Expected 1] The file is rejected').toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 2 — Read the error code and message', async () => {
      await expect(list.lastToast(), 'A message appears after the rejected upload').toBeVisible();
    });

    await step('Assert: Expected 2 — WH-STOCK_ADJUSTMENT_BELOW_ZERO names the row and SKU code of the second row', async () => {
      expect(outcome?.code, '[Expected 2] The code is WH-STOCK_ADJUSTMENT_BELOW_ZERO').toBe('WH-STOCK_ADJUSTMENT_BELOW_ZERO');
      expect(outcome?.message, '[Expected 2] The message reads "{n}행: 조정으로 재고를 0 미만으로 줄일 수 없습니다. - skuCode: <code>, …"').toMatch(new RegExp(`^\\d+행: 조정으로 재고를 0 미만으로 줄일 수 없습니다\\. - skuCode: ${two.skuCode}`));
      expect(rowNumberOf(outcome?.message ?? ''), '[Expected 2] {n} points at the second row (sheet row 3)').toBe(3);
    });

    await step('Act: Step 3 — Reload the stock list and read 가용재고 (Available stock) for both SKUs', async () => {
      available.push(await list.availableOnList(one.skuCode, cj.name), await list.availableOnList(two.skuCode, cj.name));
    });

    await step('Assert: Expected 3 — 가용재고 remains 120 and 17', async () => {
      expect(available[0], '[Expected 3] 가용재고 of the first SKU remains 120').toBe('120');
      expect(available[1], '[Expected 3] 가용재고 of the second SKU remains 17').toBe('17');
    });

    await step('Act: Step 4 — Open Stock history for both SKUs and check for movements created by this upload', async () => {
      for (const sku of [one, two]) {
        await list.search('SKU_CODE', sku.skuCode);
        await list.openHistoryOf(list.row(sku.skuCode, cj.name), 'ko');
        movements.push((await list.historyLines()).length);
        await list.closeHistory();
      }
    });

    await step('Assert: Expected 4 — No movement from this upload is created for either SKU', async () => {
      expect(movements[0], '[Expected 4] No movement is created for the first SKU').toBe(0);
      expect(movements[1], '[Expected 4] No movement is created for the second SKU').toBe(0);
      expect(await list.adjustmentCount([one.skuId, two.skuId]), '[Expected 4] No adjustment is stored').toBe(0);
    });
  });

  test('TC_US134_355 — The row number is reported when the SKU code does not exist and nothing is written', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_355',
      'Medium',
      TAGS,
      `A workbook with an unknown SKU code on row 2 (stand-in for DEMO-SKU-9999) and a valid row 3 is rejected with WH-SKU_CODE_NOT_FOUND "2행의 SKU 코드를 찾을 수 없습니다. - skuCode: <code>", and the valid row is not written either. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'U355', cj.id, { available: 30 });
    const missing = uniqueCode(world.tag, 'NX355');
    const file = adjustmentWorkbook('adjustment-unknown-code.xlsx', [at(sku, cj.id, 1, 'P', { skuCode: missing }), at(sku, cj.id, 1, 'P')]);
    let before = -1;
    let outcome: UploadOutcome | undefined;

    await step('Arrange: Pre-condition 1–3 — Row 2 carries an SKU code that matches no SKU, row 3 is valid; the adjustment count is known', async () => {
      before = await list.adjustmentCount([sku.skuId]);
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload the file through 재고 조정 업로드 (Upload stock adjustment)', async () => {
      outcome = await list.uploadAdjustment(file);
    });

    await step('Assert: Expected 1 — The file is rejected', async () => {
      expect(outcome?.status, '[Expected 1] The file is rejected').toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 2 — Read the error code and the message', async () => {
      await expect(list.lastToast(), 'A message appears after the rejected upload').toBeVisible();
    });

    await step('Assert: Expected 2 — WH-SKU_CODE_NOT_FOUND with "{n}행의 SKU 코드를 찾을 수 없습니다. - skuCode: {code}" filled in', async () => {
      expect(outcome?.code, '[Expected 2] The code is WH-SKU_CODE_NOT_FOUND').toBe('WH-SKU_CODE_NOT_FOUND');
      expect(outcome?.message, '[Expected 2] The message carries the real row and code').toMatch(new RegExp(`^\\d+행의 SKU 코드를 찾을 수 없습니다\\. - skuCode: ${missing}$`));
      await expect(list.toast(outcome?.message ?? '').first(), '[Expected 2] The server message is shown on screen').toBeVisible();
    });

    await step('Act: Step 3 — Compare the row the message names with the file', async () => {
      expect(outcome?.message, 'The message is read').toBeTruthy();
    });

    await step('Assert: Expected 3 — The message names row 2, the row carrying the unknown code', async () => {
      expect(rowNumberOf(outcome?.message ?? ''), '[Expected 3] The message names row 2').toBe(2);
    });

    let after = -1;
    await step('Act: Step 4 — Check whether any adjustment was created', async () => {
      after = await list.adjustmentCount([sku.skuId]);
    });

    await step('Assert: Expected 4 — No adjustment is created, not even for the valid row', async () => {
      expect(after, '[Expected 4] The whole workbook is rejected — the valid row is not written').toBe(before);
    });
  });

  test('TC_US134_356 — The picker offers .xls while the server takes only .xlsx', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_356',
      'Medium',
      TAGS,
      `The picker accepts .xlsx and .xls; a .xls file (Excel 97-2003 / OLE2 signature, built in memory) is sent and refused with "xlsx 형식의 엑셀 파일만 업로드 가능합니다." and writes nothing; the valid .xlsx file is then taken and written. The refusal is the AS-IS expected result. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'U356', cj.id, { available: 30 });
    const xls = ole2XlsFile(`adjustment-${sku.skuCode}.xls`);
    const xlsx = adjustmentWorkbook(`adjustment-${sku.skuCode}.xlsx`, [at(sku, cj.id, 1, 'P')]);
    const onlyXlsx = 'xlsx 형식의 엑셀 파일만 업로드 가능합니다.';
    let chooser: FileChooser | undefined;
    let accept: string[] = [];
    let xlsOutcome: UploadOutcome | undefined;
    let xlsxOutcome: UploadOutcome | undefined;

    await step('Arrange: Pre-condition 1–3 — A .xls file and a valid .xlsx adjustment file on the own SKU; the adjustment count is known', async () => {
      await list.open('ko');
    });

    await step('Act: Step 1 — Click 재고 조정 업로드 (Upload stock adjustment) and read which file types the picker offers', async () => {
      chooser = await list.openAdjustmentPicker();
      accept = ((await list.adjustmentFileInput.getAttribute('accept')) ?? '').split(',').map((type) => type.trim());
    });

    await step('Assert: Expected 1 — The picker offers BOTH .xlsx and .xls', async () => {
      expect(accept, '[Expected 1] The picker offers .xlsx').toContain('.xlsx');
      expect(accept, '[Expected 1] The picker offers .xls').toContain('.xls');
    });

    await step('Act: Step 2 — Pick the .xls file', async () => {
      xlsOutcome = await list.uploadAdjustment(xls, chooser);
    });

    await step('Assert: Expected 2 — The file is picked and sent; the picker does not stop it', async () => {
      expect(xlsOutcome?.uploadUrls.map((url) => new URL(url).pathname), '[Expected 2] The .xls file is sent to the adjustment upload address').toContain(ADJ_UPLOAD_URL);
    });

    await step('Act: Step 3 — Read the message that appears', async () => {
      await expect(list.lastToast(), 'A message appears after the upload').toBeVisible();
    });

    await step(`Assert: Expected 3 — The message shows ${onlyXlsx}`, async () => {
      expect(xlsOutcome?.status, '[Expected 3] The .xls file is refused').toBeGreaterThanOrEqual(400);
      expect(xlsOutcome?.message, `[Expected 3] The server answers ${onlyXlsx}`).toBe(onlyXlsx);
      await expect(list.toast(onlyXlsx).first(), `[Expected 3] The message ${onlyXlsx} is shown`).toBeVisible();
    });

    let writes = -1;
    await step('Act: Step 4 — Check whether any adjustment record was created', async () => {
      writes = await list.adjustmentCount([sku.skuId]);
    });

    await step('Assert: Expected 4 — No adjustment record is created', async () => {
      expect(writes, '[Expected 4] No adjustment record is created').toBe(0);
    });

    await step('Act: Step 5 — Upload the valid .xlsx file', async () => {
      xlsxOutcome = await list.uploadAdjustment(xlsx);
    });

    await step('Assert: Expected 5 — The .xlsx file is taken and the adjustment records are created', async () => {
      expect(xlsxOutcome?.status, '[Expected 5] The .xlsx file is taken').toBeLessThan(300);
      expect(await list.adjustmentCount([sku.skuId]), '[Expected 5] The adjustment record is created').toBe(1);
    });
  });

  test('TC_US134_357 — A text file and a CSV renamed to .xlsx are rejected with EXL-4000 and a control file is written', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_357',
      'Medium',
      TAGS,
      `A plain text file and a CSV file renamed to .xlsx pass the picker (extension only) and are rejected with EXL-4000 "유효하지 않은 엑셀입니다."; neither writes anything, and a valid control .xlsx is then taken and written. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'U357', cj.id, { available: 30 });
    const invalid = '유효하지 않은 엑셀입니다.';
    const text = rawFile(`notes-${sku.skuCode}.xlsx`, Buffer.from(`Plain text file for ${sku.skuCode}, not a workbook.\n`, 'utf8'));
    const csv = rawFile(`adjustment-${sku.skuCode}-csv.xlsx`, Buffer.from(`${ADJ_HEADERS.join(',')}\n${sku.skuCode},${cj.id},1,P,ADJUSTMENT,\n`, 'utf8'));
    const control = adjustmentWorkbook(`adjustment-${sku.skuCode}.xlsx`, [at(sku, cj.id, 1, 'P')]);
    let textOutcome: UploadOutcome | undefined;
    let csvOutcome: UploadOutcome | undefined;
    let controlOutcome: UploadOutcome | undefined;

    await step('Arrange: Pre-condition 1–3 — A plain text file and a CSV file renamed to .xlsx, and a valid control workbook on the own SKU', async () => {
      await list.open('ko');
    });

    await step('Act: Step 1 — Click 재고 조정 업로드 (Upload stock adjustment) and pick the renamed text file', async () => {
      textOutcome = await list.uploadAdjustment(text);
    });

    await step('Assert: Expected 1 — The picker accepts the name and the file is sent', async () => {
      expect(textOutcome?.uploadUrls.map((url) => new URL(url).pathname), '[Expected 1] The renamed text file is sent').toContain(ADJ_UPLOAD_URL);
    });

    await step('Act: Step 2 — Read the error code and the message', async () => {
      await expect(list.lastToast(), 'A message appears after the upload').toBeVisible();
    });

    await step(`Assert: Expected 2 — The server rejects it with EXL-4000 and ${invalid}`, async () => {
      expect(textOutcome?.status, '[Expected 2] The text file is rejected').toBeGreaterThanOrEqual(400);
      expect(textOutcome?.code, '[Expected 2] The code is EXL-4000').toBe('EXL-4000');
      expect(textOutcome?.message, `[Expected 2] The message is ${invalid}`).toBe(invalid);
    });

    await step('Act: Step 3 — Pick the renamed CSV file and read the message', async () => {
      csvOutcome = await list.uploadAdjustment(csv);
    });

    await step('Assert: Expected 3 — The CSV file is rejected the same way', async () => {
      expect(csvOutcome?.status, '[Expected 3] The CSV file is rejected').toBeGreaterThanOrEqual(400);
      expect(csvOutcome?.code, '[Expected 3] The code is EXL-4000').toBe('EXL-4000');
      expect(csvOutcome?.message, `[Expected 3] The message is ${invalid}`).toBe(invalid);
      await expect(list.toast(invalid).first(), `[Expected 3] ${invalid} is shown`).toBeVisible();
    });

    let writes = -1;
    await step('Act: Step 4 — Check whether any adjustment record was created by either file', async () => {
      writes = await list.adjustmentCount([sku.skuId]);
    });

    await step('Assert: Expected 4 — No adjustment record is created by either file', async () => {
      expect(writes, '[Expected 4] No adjustment record is created').toBe(0);
    });

    await step('Act: Step 5 — Upload the control file', async () => {
      controlOutcome = await list.uploadAdjustment(control);
    });

    await step('Assert: Expected 5 — The control file is taken and its records are created', async () => {
      expect(controlOutcome?.status, '[Expected 5] The control file is taken').toBeLessThan(300);
      expect(await list.adjustmentCount([sku.skuId]), '[Expected 5] The control record is created').toBe(1);
    });
  });

  test('TC_US134_358 — A corrupted workbook and a 0 KB file are rejected with two different EXL-4000 sentences', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_358',
      'Medium',
      TAGS,
      `A corrupted .xlsx (a valid workbook cut in half) is rejected with EXL-4000 "유효하지 않은 엑셀입니다." and writes nothing; a 0 KB empty.xlsx is rejected with EXL-4000 "엑셀 파일이 비어있습니다." (a different sentence); a valid workbook is then taken and written. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'U358', cj.id, { available: 30 });
    const valid = adjustmentWorkbook(`adjustment-${sku.skuCode}.xlsx`, [at(sku, cj.id, 1, 'P')]);
    const corrupted = rawFile(`corrupted-${sku.skuCode}.xlsx`, valid.buffer.subarray(0, Math.floor(valid.buffer.length / 2)));
    const empty = rawFile('empty.xlsx', Buffer.alloc(0));
    const invalid = '유효하지 않은 엑셀입니다.';
    const emptyText = '엑셀 파일이 비어있습니다.';
    let corruptOutcome: UploadOutcome | undefined;
    let emptyOutcome: UploadOutcome | undefined;
    let validOutcome: UploadOutcome | undefined;
    let writesAfterCorrupt = -1;

    await step('Arrange: Pre-condition 1–3 — A corrupted .xlsx, a 0 KB empty.xlsx and a valid workbook on the own SKU; the adjustment count is known', async () => {
      expect(empty.buffer.length, 'empty.xlsx is exactly 0 KB').toBe(0);
      await list.open('ko');
    });

    await step('Act: Step 1 — Click 재고 조정 업로드 (Upload stock adjustment) and pick the corrupted file', async () => {
      corruptOutcome = await list.uploadAdjustment(corrupted);
    });

    await step('Assert: Expected 1 — The system rejects the corrupted file', async () => {
      expect(corruptOutcome?.status, '[Expected 1] The corrupted file is rejected').toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 2 — Read the error code and the message, then check whether any record was created', async () => {
      writesAfterCorrupt = await list.adjustmentCount([sku.skuId]);
    });

    await step(`Assert: Expected 2 — EXL-4000 with ${invalid} and no record is created`, async () => {
      expect(corruptOutcome?.code, '[Expected 2] The code is EXL-4000').toBe('EXL-4000');
      expect(corruptOutcome?.message, `[Expected 2] The message is ${invalid}`).toBe(invalid);
      expect(writesAfterCorrupt, '[Expected 2] No record is created').toBe(0);
    });

    await step('Act: Step 3 — Pick the 0 KB file empty.xlsx', async () => {
      emptyOutcome = await list.uploadAdjustment(empty);
    });

    await step('Assert: Expected 3 — The system rejects the empty file', async () => {
      expect(emptyOutcome?.status, '[Expected 3] The empty file is rejected').toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 4 — Read the message that appears', async () => {
      await expect(list.lastToast(), 'A message appears after the upload').toBeVisible();
    });

    await step(`Assert: Expected 4 — The message shows ${emptyText} — still EXL-4000 but a different sentence`, async () => {
      expect(emptyOutcome?.code, '[Expected 4] The code is still EXL-4000').toBe('EXL-4000');
      expect(emptyOutcome?.message, `[Expected 4] The message is ${emptyText}`).toBe(emptyText);
      expect(emptyOutcome?.message, '[Expected 4] The empty-file sentence differs from the corrupted-file sentence').not.toBe(corruptOutcome?.message);
      await expect(list.toast(emptyText).first(), `[Expected 4] ${emptyText} is shown`).toBeVisible();
    });

    await step('Act: Step 5 — Upload the valid file', async () => {
      validOutcome = await list.uploadAdjustment(valid);
    });

    await step('Assert: Expected 5 — The valid file is taken and the records are created', async () => {
      expect(validOutcome?.status, '[Expected 5] The valid file is taken').toBeLessThan(300);
      expect(await list.adjustmentCount([sku.skuId]), '[Expected 5] The record is created').toBe(1);
    });
  });

  test('TC_US134_359 — A header-only workbook answers 201 {"ids": []} with the ordinary success message', async ({ page }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_359',
      'Medium',
      TAGS,
      `A workbook with only the 6 headers uploads with HTTP 201 and body {"ids": []}, shows ${DONE} (AS-IS, not a defect) and leaves the total adjustment count unchanged (counted in the adjustment table before and after).`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const file = adjustmentWorkbook('adjustment-header-only.xlsx', []);
    let before = -1;
    let outcome: UploadOutcome | undefined;

    await step('Arrange: Pre-condition 1–4 — A workbook with the 6 headers and no data row; the adjustment count is known; the upload call is recorded', async () => {
      expect(readXlsxRows(file.buffer), 'The workbook holds only the header row').toHaveLength(1);
      before = await list.adjustmentTotal();
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload it through 재고 조정 업로드 (Upload stock adjustment)', async () => {
      outcome = await list.uploadAdjustment(file);
    });

    await step('Assert: Expected 1 — The upload finishes', async () => {
      expect(outcome?.status, '[Expected 1] The upload finishes successfully').toBeLessThan(300);
    });

    await step('Act: Step 2 — Read the HTTP status and response body', async () => {
      expect(outcome?.body, 'The response body is read').toBeDefined();
    });

    await step('Assert: Expected 2 — HTTP 201 with the body {"ids": []}', async () => {
      expect(outcome?.status, '[Expected 2] HTTP 201').toBe(201);
      expect(outcome?.body, '[Expected 2] The body is {"ids": []}').toEqual({ ids: [] });
    });

    await step('Act: Step 3 — Read the alert', async () => {
      await expect(list.lastToast(), 'A message appears after the upload').toBeVisible();
    });

    await step(`Assert: Expected 3 — The alert shows ${DONE}`, async () => {
      await expect(list.toast(DONE).first(), `[Expected 3] The alert shows ${DONE}`).toBeVisible();
    });

    let after = -1;
    await step('Act: Step 4 — Count the adjustments', async () => {
      after = await list.adjustmentTotal();
    });

    await step('Assert: Expected 4 — No adjustment is created; the adjustment count is unchanged', async () => {
      expect(after, '[Expected 4] The adjustment count is unchanged').toBe(before);
    });
  });

  test('TC_US134_360 — A workbook missing a header column is rejected naming that column and no row', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_360',
      'Medium',
      TAGS,
      `A workbook whose header row lacks 조정사유코드 (data rows otherwise valid) is rejected with "엑셀에 '조정사유코드' 항목이 존재하지 않습니다." — the column is named, no row number is named, and nothing is written. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'U360', cj.id, { available: 30 });
    const missingColumn = '조정사유코드';
    const headers = ADJ_HEADERS.filter((name) => name !== missingColumn);
    const file = adjustmentWorkbook('adjustment-missing-header.xlsx', [at(sku, cj.id, 1, 'P'), at(sku, cj.id, 2, 'P')], headers);
    let outcome: UploadOutcome | undefined;

    await step('Arrange: Pre-condition 1–3 — The header row lacks 조정사유코드, the data rows are otherwise valid; the adjustment count is known', async () => {
      expect(readXlsxRows(file.buffer)[0], `The header row has no ${missingColumn}`).not.toContain(missingColumn);
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload that file through 재고 조정 업로드 (Upload stock adjustment)', async () => {
      outcome = await list.uploadAdjustment(file);
    });

    await step('Assert: Expected 1 — The system rejects the file', async () => {
      expect(outcome?.status, '[Expected 1] The file is rejected').toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 2 — Read the message that appears', async () => {
      await expect(list.lastToast(), 'A message appears after the upload').toBeVisible();
    });

    await step("Assert: Expected 2 — The message shows 엑셀에 '{column}' 항목이 존재하지 않습니다.", async () => {
      expect(outcome?.message, "[Expected 2] The message reads 엑셀에 '{column}' 항목이 존재하지 않습니다.").toBe(`엑셀에 '${missingColumn}' 항목이 존재하지 않습니다.`);
    });

    await step('Act: Step 3 — Check whether the message names the missing column', async () => {
      expect(outcome?.message, 'The message is read').toBeDefined();
    });

    await step('Assert: Expected 3 — The message names the missing column by NAME', async () => {
      expect(outcome?.message, `[Expected 3] The message names ${missingColumn}`).toContain(missingColumn);
    });

    await step('Act: Step 4 — Check whether the message names any row number', async () => {
      expect(outcome?.message, 'The message is read').toBeDefined();
    });

    await step('Assert: Expected 4 — The message names NO row number', async () => {
      expect(outcome?.message, '[Expected 4] The message names no row number').not.toMatch(/\d+\s*행/);
    });

    let writes = -1;
    await step('Act: Step 5 — Check whether any adjustment record was created', async () => {
      writes = await list.adjustmentCount([sku.skuId]);
    });

    await step('Assert: Expected 5 — No adjustment record is created', async () => {
      expect(writes, '[Expected 5] No adjustment record is created').toBe(0);
    });
  });

  test('TC_US134_361 — An empty required cell is reported with its exact row and column and nothing is written', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_361',
      'Medium',
      TAGS,
      `A 6-column workbook with the 조정수량 cell empty on sheet row 3 (rows 2 and 4 valid) is rejected with "3행의 3열(조정수량)은 필수 항목입니다." (row, 1-based column number as Excel shows it, column name) and no row is written. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const [one, two] = await ownSkuLines(world, 'U361', 2);
    await stockDb.upsertStock(one.skuId, cj.id, { available: 30 });
    await stockDb.upsertStock(two.skuId, cj.id, { available: 30 });
    const file = adjustmentWorkbook('adjustment-empty-cell.xlsx', [at(one, cj.id, 1, 'P'), at(two, cj.id, null, 'P'), at(one, cj.id, 2, 'P')]);
    let outcome: UploadOutcome | undefined;
    let parts: RegExpExecArray | null = null;

    await step('Arrange: Pre-condition 1–3 — 6-column workbook with 조정수량 empty on row 3, every other row valid; the adjustment count is known', async () => {
      expect(readXlsxRows(file.buffer)[2][2] ?? '', 'The 조정수량 cell of row 3 is empty').toBe('');
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload that file through 재고 조정 업로드 (Upload stock adjustment)', async () => {
      outcome = await list.uploadAdjustment(file);
    });

    await step('Assert: Expected 1 — The system rejects the file', async () => {
      expect(outcome?.status, '[Expected 1] The file is rejected').toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 2 — Read the message that appears', async () => {
      parts = /^(\d+)행의 (\d+)열\((.+)\)은 필수 항목입니다\.$/.exec(outcome?.message ?? '');
    });

    await step('Assert: Expected 2 — The message shows {n}행의 {m}열({column})은 필수 항목입니다. with real values', async () => {
      expect(outcome?.message, '[Expected 2] The message reads "{n}행의 {m}열({column})은 필수 항목입니다."').toMatch(/^\d+행의 \d+열\(.+\)은 필수 항목입니다\.$/);
    });

    await step('Act: Step 3 — Compare the row and column the message names with the real fault in the file', async () => {
      expect(outcome?.message, 'The message is read').toBeDefined();
    });

    await step('Assert: Expected 3 — The row and column point at row 3 and the 조정수량 column', async () => {
      const found = parts as RegExpExecArray | null;
      expect(found?.[1], '[Expected 3] The message names row 3').toBe('3');
      expect(found?.[2], '[Expected 3] The message names column 3 (조정수량)').toBe('3');
      expect(found?.[3], '[Expected 3] The message names the 조정수량 column').toBe('조정수량');
    });

    let writes = -1;
    await step('Act: Step 4 — Check whether any adjustment record was created', async () => {
      writes = await list.adjustmentCount([one.skuId, two.skuId]);
    });

    await step('Assert: Expected 4 — No adjustment record is created, including for the valid rows', async () => {
      expect(writes, '[Expected 4] No adjustment record is created').toBe(0);
    });
  });

  test('TC_US134_362 — A cell that cannot be converted is reported with row, column, value and type', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_362',
      'Medium',
      TAGS,
      `File A (조정수량 = abc on row 2) is rejected with "2행 3열(조정수량): 셀(value:abc, type:…)을 {type}으로 변환할 수 없습니다."; file B (증가(P)/차감(M) = X on row 4) is rejected with EXL-4000 "엑셀의 '4'행이 유효하지 않습니다. {cause}" — the cause text is attached to the report; neither writes anything. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'U362', cj.id, { available: 30 });
    const fileA = adjustmentWorkbook('adjustment-file-a.xlsx', [at(sku, cj.id, 'abc', 'P'), at(sku, cj.id, 1, 'P')]);
    const fileB = adjustmentWorkbook('adjustment-file-b.xlsx', [at(sku, cj.id, 1, 'P'), at(sku, cj.id, 1, 'P'), at(sku, cj.id, 1, 'X')]);
    let outcomeA: UploadOutcome | undefined;
    let outcomeB: UploadOutcome | undefined;
    const conversion = /^(\d+)행 (\d+)열\(조정수량\): 셀\(value:(.*?), type:([^)]*)\)을 (\S+?)으로 변환할 수 없습니다/;

    await step('Arrange: Pre-condition 1–3 — File A with abc in 조정수량 on row 2, file B with X in 증가(P)/차감(M) on row 4; the adjustment count is known', async () => {
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload file A through 재고 조정 업로드 (Upload stock adjustment)', async () => {
      outcomeA = await list.uploadAdjustment(fileA);
    });

    await step('Assert: Expected 1 — File A is rejected with the conversion message pointing at row 2', async () => {
      expect(outcomeA?.status, '[Expected 1] File A is rejected').toBeGreaterThanOrEqual(400);
      expect(outcomeA?.message, '[Expected 1] The message reads "{n}행 {m}열(조정수량): 셀(value:{v}, type:{t})을 {type}으로 변환할 수 없습니다."').toMatch(conversion);
      expect(rowNumberOf(outcomeA?.message ?? ''), '[Expected 1] {n} points at row 2').toBe(2);
    });

    await step('Act: Step 2 — Read the message that appears', async () => {
      await expect(list.toast(outcomeA?.message ?? '').first(), 'The server message is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — The message names the value it could not convert and the type it was trying to reach', async () => {
      const parts = conversion.exec(outcomeA?.message ?? '');
      expect(parts?.[3], '[Expected 2] The message names the value abc').toBe('abc');
      expect(parts?.[5] ?? '', '[Expected 2] The message names the target type').not.toBe('');
    });

    await step('Act: Step 3 — Upload file B and read the message', async () => {
      outcomeB = await list.uploadAdjustment(fileB);
      await test.info().attach('File B rejection cause', { body: JSON.stringify({ code: outcomeB.code, message: outcomeB.message }, null, 2), contentType: 'application/json' });
    });

    await step("Assert: Expected 3 — File B is rejected with EXL-4000 엑셀의 '4'행이 유효하지 않습니다. {cause}", async () => {
      expect(outcomeB?.status, '[Expected 3] File B is rejected').toBeGreaterThanOrEqual(400);
      expect(outcomeB?.code, '[Expected 3] The code is EXL-4000').toBe('EXL-4000');
      expect(outcomeB?.message, "[Expected 3] The message reads 엑셀의 '4'행이 유효하지 않습니다. {cause}").toMatch(/^엑셀의 '4'행이 유효하지 않습니다\./);
      expect((outcomeB?.message ?? '').replace(/^엑셀의 '4'행이 유효하지 않습니다\.\s*/, ''), '[Expected 3] A {cause} text is given').not.toBe('');
    });

    let writes = -1;
    await step('Act: Step 4 — Check whether either upload created a record', async () => {
      writes = await list.adjustmentCount([sku.skuId]);
    });

    await step('Assert: Expected 4 — Neither upload creates a record', async () => {
      expect(writes, '[Expected 4] Neither upload creates a record').toBe(0);
    });
  });

  test('TC_US134_363 — A soft-deleted SKU code is rejected with its own sentence and the control workbook completes', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_363',
      'High',
      TAGS,
      `A 3-row workbook whose middle row names a soft-deleted own SKU is rejected with WH-SKU_CODE_NOT_FOUND "3행: 삭제된 SKU 코드입니다. - skuCode: <code>" (a different sentence from the never-existed one), none of the 3 rows is written, and the identical workbook naming an active SKU in the middle completes. The SKU is soft-deleted through the DB (deleted_at) after its stock was built. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const [first, deleted, third, active] = await ownSkuLines(world, 'U363', 4);
    for (const sku of [first, deleted, third, active]) await stockDb.upsertStock(sku.skuId, cj.id, { available: 30 });
    const file = adjustmentWorkbook('adjustment-deleted-sku.xlsx', [at(first, cj.id, 1, 'P'), at(deleted, cj.id, 1, 'P'), at(third, cj.id, 1, 'P')]);
    const control = adjustmentWorkbook('adjustment-active-sku.xlsx', [at(first, cj.id, 1, 'P'), at(active, cj.id, 1, 'P'), at(third, cj.id, 1, 'P')]);
    const ids = [first.skuId, deleted.skuId, third.skuId];
    let outcome: UploadOutcome | undefined;
    let controlOutcome: UploadOutcome | undefined;

    await step('Arrange: Pre-condition 1–4 — The middle row names a soft-deleted SKU, an identical control names an active SKU; the adjustment count is known', async () => {
      await stockDb.softDeleteSku(deleted.skuId);
      expect((await stockDb.sku(deleted.skuId))?.deleted_at, 'The middle SKU is soft-deleted').toBeTruthy();
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload the workbook through 재고 조정 업로드 (Upload stock adjustment)', async () => {
      outcome = await list.uploadAdjustment(file);
    });

    await step('Assert: Expected 1 — The workbook is rejected', async () => {
      expect(outcome?.status, '[Expected 1] The workbook is rejected').toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 2 — Read the error code and the message', async () => {
      await expect(list.lastToast(), 'A message appears after the upload').toBeVisible();
    });

    await step('Assert: Expected 2 — WH-SKU_CODE_NOT_FOUND with "{n}행: 삭제된 SKU 코드입니다. - skuCode: {code}"', async () => {
      expect(outcome?.code, '[Expected 2] The code is WH-SKU_CODE_NOT_FOUND').toBe('WH-SKU_CODE_NOT_FOUND');
      expect(outcome?.message, '[Expected 2] The message reads "{n}행: 삭제된 SKU 코드입니다. - skuCode: {code}"').toMatch(new RegExp(`^\\d+행: 삭제된 SKU 코드입니다\\. - skuCode: ${deleted.skuCode}$`));
      expect(outcome?.message, '[Expected 2] The sentence differs from the never-existed one').not.toContain('SKU 코드를 찾을 수 없습니다');
    });

    await step('Act: Step 3 — Check which row the message names', async () => {
      expect(outcome?.message, 'The message is read').toBeDefined();
    });

    await step('Assert: Expected 3 — The message names the middle row', async () => {
      expect(rowNumberOf(outcome?.message ?? ''), '[Expected 3] The message names the middle row (sheet row 3)').toBe(3);
    });

    let writes = -1;
    await step('Act: Step 4 — Check whether any of the 3 rows produced an adjustment', async () => {
      writes = await list.adjustmentCount(ids);
    });

    await step('Assert: Expected 4 — No adjustment is created for any of the 3 rows', async () => {
      expect(writes, '[Expected 4] No adjustment is created for any of the 3 rows').toBe(0);
    });

    await step('Act: Step 5 — Upload the control workbook', async () => {
      controlOutcome = await list.uploadAdjustment(control);
    });

    await step('Assert: Expected 5 — The control workbook completes', async () => {
      expect(controlOutcome?.status, '[Expected 5] The control workbook completes').toBeLessThan(300);
      await expect(list.toast(DONE).first(), `[Expected 5] ${DONE} is shown`).toBeVisible();
    });
  });

  test('TC_US134_364 — Parsing stops at the first invalid row and nothing is committed until the file is corrected', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_364',
      'Critical',
      TAGS,
      `A 5-row workbook (data rows 1–2 valid, row 3 조정수량 = abc, row 4 증가(P)/차감(M) = X, row 5 valid) is rejected with the conversion error of row 3 only — not a list of every fault; every stock value of the 5 SKUs and the adjustment count stay unchanged; the corrected workbook then writes all 5 rows with ${DONE}. The TC numbers these rows from the first data row, so the reported {n} is accepted as either that data-row number (3) or its sheet row (4). Not automated: Expected 3 (a server parser trace showing row 4 is never read) — no trace is reachable from the browser; the check is that the message names row 3's fault only. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const label = 'U364';
    const skus = await ownSkuLines(world, label, 5);
    for (const sku of skus) await stockDb.upsertStock(sku.skuId, cj.id, { available: 50 });
    const bad = adjustmentWorkbook('adjustment-fail-fast.xlsx', skus.map((sku, index) => at(sku, cj.id, index === 2 ? 'abc' : 1, index === 3 ? 'X' : 'P')));
    const fixed = adjustmentWorkbook('adjustment-corrected.xlsx', skus.map((sku) => at(sku, cj.id, 1, 'P')));
    const ids = skus.map((sku) => sku.skuId);
    let outcome: UploadOutcome | undefined;
    let fixedOutcome: UploadOutcome | undefined;
    let values: string[] = [];

    await step('Arrange: Pre-condition 1–4 — 5-row workbook with abc on row 3 and X on row 4; the adjustment count and the 가용재고 50 of the 5 SKUs are known', async () => {
      expect(await list.adjustmentCount(ids), 'No adjustment exists yet for the 5 SKUs').toBe(0);
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload the 5-row workbook through 재고 조정 업로드 (Upload stock adjustment)', async () => {
      outcome = await list.uploadAdjustment(bad);
    });

    await step('Assert: Expected 1 — The file is rejected', async () => {
      expect(outcome?.status, '[Expected 1] The file is rejected').toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 2 — Read the error and the row it reports', async () => {
      await expect(list.lastToast(), 'A message appears after the upload').toBeVisible();
    });

    await step('Assert: Expected 2 — The error reports row 3 only with the 조정수량 conversion message', async () => {
      expect(outcome?.message, '[Expected 2] The message reads "{n}행 {m}열(조정수량): 셀(value:abc, type:{t})을 {type}으로 변환할 수 없습니다."').toMatch(/^\d+행 \d+열\(조정수량\): 셀\(value:abc, type:[^)]*\)을 \S+으로 변환할 수 없습니다/);
      expect([3, 4], '[Expected 2] {n} points at row 3 (data row 3 = sheet row 4)').toContain(rowNumberOf(outcome?.message ?? ''));
      expect((outcome?.message ?? '').match(/\d+행/g) ?? [], '[Expected 2] Only one row is reported — not a list of every fault').toHaveLength(1);
    });

    await step('Act: Step 3 — Check for any attempt to read row 4 (the message is the only trace reachable)', async () => {
      expect(outcome?.message, 'The message is read').toBeDefined();
    });

    await step('Assert: Expected 3 — Row 4 is never parsed (its fault is not reported)', async () => {
      expect(outcome?.message, '[Expected 3] The fault of row 4 (value X) is not reported').not.toContain('value:X');
      expect(outcome?.message, '[Expected 3] The direction column of row 4 is not reported').not.toContain('증가(P)/차감(M)');
    });

    await step('Act: Step 4 — Reload the stock list and read the stock values of all 5 SKUs', async () => {
      await list.findGroup(world, label);
      values = [];
      for (const sku of skus) values.push(await list.cellText(list.row(sku.skuCode, cj.name), 'col.availableQuantity'));
    });

    await step('Assert: Expected 4 — Every stock value is unchanged and the adjustment count is unchanged', async () => {
      values.forEach((value, index) => expect(value, `[Expected 4] 가용재고 of row ${index + 1} is unchanged at 50`).toBe('50'));
      expect(await list.adjustmentCount(ids), '[Expected 4] The adjustment count is unchanged').toBe(0);
    });

    await step('Act: Step 5 — Correct both invalid rows and upload again', async () => {
      fixedOutcome = await list.uploadAdjustment(fixed);
    });

    await step(`Assert: Expected 5 — The corrected workbook succeeds with ${DONE} and all 5 rows are written`, async () => {
      expect(fixedOutcome?.status, '[Expected 5] The corrected workbook succeeds').toBeLessThan(300);
      await expect(list.toast(DONE).first(), `[Expected 5] ${DONE} is shown`).toBeVisible();
      expect(await list.adjustmentCount(ids), '[Expected 5] All 5 rows are written').toBe(5);
    });
  });

  test('TC_US134_365 — Nothing is written when the first bad row sits in the second write batch', async ({ page, world }) => {
    test.setTimeout(600_000);
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_365',
      'Critical',
      TAGS,
      `A 3,500-row workbook (all increase 1) with 조정수량 = abc on row 3,200 is rejected with the conversion message naming row 3,200; the adjustment count and 가용재고 of the SKUs on rows 1–3 are unchanged — none of the first 3,000 rows is committed. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const label = 'B65';
    const skus = await ownSkuLines(world, label, 3);
    for (const sku of skus) await stockDb.upsertStock(sku.skuId, cj.id, { available: 100 });
    const badSheetRow = 3200;
    const file = adjustmentWorkbook(
      'adjustment-3500-rows.xlsx',
      Array.from({ length: 3500 }, (_, index) => at(skus[index % 3], cj.id, index + 2 === badSheetRow ? 'abc' : 1, 'P')),
    );
    const ids = skus.map((sku) => sku.skuId);
    let outcome: UploadOutcome | undefined;
    let values: string[] = [];
    let writes = -1;

    await step('Arrange: Pre-condition 1–3 — 3,500-row workbook, direction P, abc on row 3,200; the adjustment count and 가용재고 100 of the SKUs on rows 1–3 are known', async () => {
      expect(readXlsxRows(file.buffer)[badSheetRow - 1][2], 'Row 3,200 carries abc').toBe('abc');
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload the workbook through 재고 조정 업로드 (Upload stock adjustment)', async () => {
      outcome = await list.uploadAdjustment(file);
    });

    await step('Assert: Expected 1 — The file is rejected', async () => {
      expect(outcome?.status, '[Expected 1] The file is rejected').toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 2 — Read the message', async () => {
      await expect(list.lastToast(), 'A message appears after the upload').toBeVisible();
    });

    await step('Assert: Expected 2 — The conversion message names row 3,200', async () => {
      expect(outcome?.message, '[Expected 2] The message reads "{n}행 {m}열(조정수량): 셀(value:abc, type:{t})을 {type}으로 변환할 수 없습니다."').toMatch(/^\d+행 \d+열\(조정수량\): 셀\(value:abc, type:[^)]*\)을 \S+으로 변환할 수 없습니다/);
      expect(rowNumberOf(outcome?.message ?? ''), '[Expected 2] {n} = 3,200').toBe(badSheetRow);
    });

    await step('Act: Step 3 — Count the adjustments and read 가용재고 (Available stock) of the SKUs on rows 1–3', async () => {
      writes = await list.adjustmentCount(ids);
      await list.findGroup(world, label);
      values = [];
      for (const sku of skus) values.push(await list.cellText(list.row(sku.skuCode, cj.name), 'col.availableQuantity'));
    });

    await step('Assert: Expected 3 — The adjustment count and every stock value are unchanged', async () => {
      expect(writes, '[Expected 3] The adjustment count is unchanged — none of the first 3,000 rows was committed').toBe(0);
      values.forEach((value, index) => expect(value, `[Expected 3] 가용재고 of the SKU on row ${index + 2} is unchanged at 100`).toBe('100'));
    });
  });

  test('TC_US134_366 — The workbook upper bound on 조정수량 is recorded while the dialog refuses 1,000,000,001', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_366',
      'Medium',
      TAGS,
      `Record-only for the workbook door (QC asserts what Dev measures): the outcomes of 조정수량 = 1,000,000,000 and 1,000,000,001 (direction P) are attached to the report. The 재고 조정 dialog must refuse 1,000,000,001 and stay open; if the value reaches the server the rejection must be WH-STOCK_QUANTITY_EXCEEDED "조정 수량이 허용 범위를 초과했습니다.". The bundle's quantity box drops any value above 1e9 as it is typed, so 저장 then meets an empty quantity. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const label = 'U366';
    const sku = await ownStockSku(world, label, cj.id, { available: 100 });
    const atLimit = adjustmentWorkbook('adjustment-1000000000.xlsx', [at(sku, cj.id, 1_000_000_000, 'P')]);
    const overLimit = adjustmentWorkbook('adjustment-1000000001.xlsx', [at(sku, cj.id, 1_000_000_001, 'P')]);
    const record: Record<string, unknown> = {};
    let limitOutcome: UploadOutcome | undefined;
    let overOutcome: UploadOutcome | undefined;
    const dialog = { stillOpen: false, typedValue: '', postStatus: 0, postCode: '', postMessage: '', posts: 0 };

    await step('Arrange: Pre-condition 1–4 — Own row with enough stock; workbooks carrying 1,000,000,000 and 1,000,000,001 with direction P; the adjustment count is known', async () => {
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload the workbook carrying 1,000,000,000 and record the outcome', async () => {
      limitOutcome = await list.uploadAdjustment(atLimit);
      record.workbook1000000000 = { status: limitOutcome.status, code: limitOutcome.code, message: limitOutcome.message, adjustments: await list.adjustmentCount([sku.skuId]) };
    });

    await step('Assert: Expected 1 — The outcome of 1,000,000,000 is recorded', async () => {
      expect(limitOutcome?.status, '[Expected 1] The server answered the 1,000,000,000 workbook (outcome recorded, not judged)').toBeGreaterThan(0);
      await test.info().attach('Workbook 1,000,000,000 outcome', { body: JSON.stringify(record.workbook1000000000, null, 2), contentType: 'application/json' });
    });

    await step('Act: Step 2 — Upload the workbook carrying 1,000,000,001 and record the outcome, code and message', async () => {
      overOutcome = await list.uploadAdjustment(overLimit);
      record.workbook1000000001 = { status: overOutcome.status, code: overOutcome.code, message: overOutcome.message, adjustments: await list.adjustmentCount([sku.skuId]) };
    });

    await step('Assert: Expected 2 — The outcome of 1,000,000,001 is recorded, with code and message if rejected', async () => {
      expect(overOutcome?.status, '[Expected 2] The server answered the 1,000,000,001 workbook (outcome recorded, not judged)').toBeGreaterThan(0);
      if ((overOutcome?.status ?? 0) >= 400) expect(overOutcome?.message, '[Expected 2] A rejection carries a message to record').not.toBe('');
      await test.info().attach('Workbook 1,000,000,001 outcome', { body: JSON.stringify(record.workbook1000000001, null, 2), contentType: 'application/json' });
    });

    await step('Act: Step 3 — Open 재고 조정 (Stock adjustment), type 1,000,000,001 into 조정 수량 (Adjustment quantity) and click 저장 (Save)', async () => {
      await list.findSku(sku);
      const posts = list.writeRequests(ADJUST_URL);
      await list.openAdjustment([list.row(sku.skuCode, cj.name)]);
      const reason = (await list.reasonOptions(0)).find((option) => option.value !== '')?.value ?? '';
      await list.adjustment.fillLine(0, { quantity: '1000000001', modifyType: 'ADD', reason });
      dialog.typedValue = await list.adjustment.quantityInput(0).inputValue();
      const answer = page.waitForResponse((res) => new URL(res.url()).pathname === ADJUST_URL && res.request().method() === 'POST', { timeout: 10_000 }).catch(() => null);
      await list.adjustment.clickSave();
      const res = posts.length > 0 || dialog.typedValue !== '' ? await answer : null;
      if (res) {
        const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
        dialog.postStatus = res.status();
        dialog.postCode = body.code ?? '';
        dialog.postMessage = body.message ?? '';
      }
      dialog.posts = posts.filter((request) => new URL(request.url()).pathname === ADJUST_URL).length;
      dialog.stillOpen = await list.adjustment.root.isVisible();
      record.dialog = { ...dialog };
      if (dialog.stillOpen) {
        await list.adjustment.clickCancel();
        if (await list.adjustment.confirmClose.isVisible()) await list.adjustment.confirmDiscard();
        await list.adjustment.expectClosed();
      }
    });

    await step('Assert: Expected 3 — The dialog refuses 1,000,000,001 and stays open; a server rejection would be WH-STOCK_QUANTITY_EXCEEDED', async () => {
      expect(dialog.stillOpen, '[Expected 3] The 재고 조정 dialog stays open').toBe(true);
      expect(dialog.posts === 0 || dialog.postStatus >= 400, '[Expected 3] 1,000,000,001 is not saved by the dialog').toBe(true);
      if (dialog.posts > 0) {
        expect(dialog.postCode, '[Expected 3] The server rejection is WH-STOCK_QUANTITY_EXCEEDED').toBe('WH-STOCK_QUANTITY_EXCEEDED');
        expect(dialog.postMessage, '[Expected 3] The message is 조정 수량이 허용 범위를 초과했습니다.').toBe('조정 수량이 허용 범위를 초과했습니다.');
      }
    });

    await step('Act: Step 4 — Compare the two doors', async () => {
      await test.info().attach('Workbook door vs dialog door', { body: JSON.stringify(record, null, 2), contentType: 'application/json' });
    });

    await step('Assert: Expected 4 — The two doors may differ: the comparison is recorded', async () => {
      expect(Object.keys(record), '[Expected 4] Both workbook outcomes and the dialog outcome are recorded for comparison').toEqual(['workbook1000000000', 'workbook1000000001', 'dialog']);
    });
  });

  test('TC_US134_367 — A negative 조정수량 is rejected on both directions and the outcome of 0 is recorded', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_367',
      'High',
      TAGS,
      `Workbooks carrying -5 with M and -5 with P are both rejected as a whole (the quantity is a magnitude on both directions) and 가용재고 stays at 50 with no movement; the outcome of 0 with P (accepted or not, and whether it writes a zero-quantity 재고이력 row) is recorded, not judged. The rejection {cause} strings are attached. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'U367', cj.id, { available: 50 });
    const minusM = adjustmentWorkbook('adjustment-minus5-M.xlsx', [at(sku, cj.id, -5, 'M')]);
    const minusP = adjustmentWorkbook('adjustment-minus5-P.xlsx', [at(sku, cj.id, -5, 'P')]);
    const zero = adjustmentWorkbook('adjustment-zero-P.xlsx', [at(sku, cj.id, 0, 'P')]);
    let mOutcome: UploadOutcome | undefined;
    let pOutcome: UploadOutcome | undefined;
    let zeroOutcome: UploadOutcome | undefined;
    let available = '';
    let movementsAfterNegatives = -1;
    const zeroRecord = { status: 0, code: '', message: '', newMovements: 0, zeroQuantityMovement: false };

    await step('Arrange: Pre-condition 1–4 — Own row in CJ Incheon Aam with 가용재고 50; 3 workbooks differing only in 조정수량 / direction; no movement yet', async () => {
      expect(await stockDb.usages(sku.skuId, cj.id), 'The own row has no movement yet').toHaveLength(0);
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload the workbook carrying -5 with direction M and record the outcome', async () => {
      mOutcome = await list.uploadAdjustment(minusM);
    });

    await step('Assert: Expected 1 — The workbook is rejected: a negative 조정수량 is refused for the whole file', async () => {
      expect(mOutcome?.status, '[Expected 1] -5 with M is rejected').toBeGreaterThanOrEqual(400);
      await test.info().attach('-5 with M rejection', { body: JSON.stringify({ code: mOutcome?.code, message: mOutcome?.message }, null, 2), contentType: 'application/json' });
    });

    await step('Act: Step 2 — Read 가용재고 (Available stock) and compare it with the value before the run', async () => {
      available = await list.availableOnList(sku.skuCode, cj.name);
    });

    await step('Assert: Expected 2 — The stock value is unchanged (not raised by 5)', async () => {
      expect(available, '[Expected 2] 가용재고 is unchanged at 50 — the two minus signs did not cancel').toBe('50');
    });

    await step('Act: Step 3 — Upload the workbook carrying -5 with direction P and record the outcome', async () => {
      pOutcome = await list.uploadAdjustment(minusP);
      movementsAfterNegatives = (await stockDb.usages(sku.skuId, cj.id)).length;
    });

    await step('Assert: Expected 3 — Also rejected: the rule is on the sign of 조정수량, not on the direction', async () => {
      expect(pOutcome?.status, '[Expected 3] -5 with P is rejected').toBeGreaterThanOrEqual(400);
      await test.info().attach('-5 with P rejection', { body: JSON.stringify({ code: pOutcome?.code, message: pOutcome?.message }, null, 2), contentType: 'application/json' });
    });

    await step('Act: Step 4 — Upload the workbook carrying 0 with direction P and record the outcome', async () => {
      zeroOutcome = await list.uploadAdjustment(zero);
      const usages = await stockDb.usages(sku.skuId, cj.id);
      Object.assign(zeroRecord, {
        status: zeroOutcome.status,
        code: zeroOutcome.code,
        message: zeroOutcome.message,
        newMovements: usages.length - movementsAfterNegatives,
        zeroQuantityMovement: usages.some((usage) => Number(usage.delta) === 0),
      });
    });

    await step('Assert: Expected 4 — The outcome of 0 is recorded (accepted or not, zero-quantity history row or not)', async () => {
      expect(zeroRecord.status, '[Expected 4] The server answered the 0 workbook (outcome recorded, not judged)').toBeGreaterThan(0);
      await test.info().attach('Quantity 0 outcome', { body: JSON.stringify(zeroRecord, null, 2), contentType: 'application/json' });
    });

    await step('Act: Step 5 — Record whether any of the 3 produced a stock movement', async () => {
      expect(movementsAfterNegatives, 'The movements after the 2 negative workbooks are counted').toBeGreaterThanOrEqual(0);
    });

    await step('Assert: Expected 5 — Neither negative workbook produced a movement; the 0 outcome is recorded', async () => {
      expect(movementsAfterNegatives, '[Expected 5] Neither negative workbook produced a movement').toBe(0);
      expect(zeroRecord.newMovements, '[Expected 5] The movement count of the 0 workbook is recorded').toBeGreaterThanOrEqual(0);
    });
  });

  test('TC_US134_368 — A failed upload raises the server message, re-queries the list once and keeps the ticked rows', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_368',
      'Medium',
      TAGS,
      `With 2 rows ticked, a workbook naming a SKU code that does not exist is rejected, an alert shows the server's rejection message, the stock list re-queries itself exactly once, and both rows stay ticked. Observed in the bundle (05/10): a failed upload shows the message as a danger toast and does NOT re-query the list (only the success path calls the reload); the run of 2026-10-06 confirmed 0 re-queries. Deviation TC ≠ UI: Expected 3 is kept as a soft assertion (fails until the BA/dev align) so Expected 4 is still checked. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const label = 'U368';
    const [one, two] = await ownSkuLines(world, label, 2);
    await stockDb.upsertStock(one.skuId, cj.id, { available: 30 });
    await stockDb.upsertStock(two.skuId, cj.id, { available: 30 });
    const missing = uniqueCode(world.tag, 'NX368');
    const file = adjustmentWorkbook('adjustment-failing.xlsx', [at(one, cj.id, 1, 'P', { skuCode: missing })]);
    const rows = [list.row(one.skuCode, cj.name), list.row(two.skuCode, cj.name)];
    let outcome: UploadOutcome | undefined;

    await step('Arrange: Pre-condition 1–4 — A workbook naming an unknown SKU code; 2 own rows ticked; the calls are recorded from a clean start', async () => {
      await list.open('ko');
      await list.findGroup(world, label);
      for (const row of rows) await list.tick(row, 'own row');
      for (const row of rows) await expect(list.checkbox(row), 'The row is ticked').toBeChecked();
    });

    await step('Act: Step 1 — Upload the failing workbook through 재고 조정 업로드 (Upload stock adjustment)', async () => {
      outcome = await list.uploadAdjustment(file);
    });

    await step('Assert: Expected 1 — The upload is rejected', async () => {
      expect(outcome?.status, '[Expected 1] The upload is rejected').toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 2 — Read whether any message appears and what it says', async () => {
      await expect(list.lastToast(), 'A message appears after the rejected upload').toBeVisible();
    });

    await step("Assert: Expected 2 — An alert is raised and shows the server's rejection message", async () => {
      expect(outcome?.message, '[Expected 2] The server answers with a rejection message').not.toBe('');
      await expect(list.toast(outcome?.message ?? '').first(), "[Expected 2] The alert shows the server's rejection message").toBeVisible();
    });

    await step('Act: Step 3 — Read the calls made and count the list re-queries', async () => {
      expect(outcome?.listReloads, 'The list re-queries after the upload are counted').toBeGreaterThanOrEqual(0);
    });

    await step('Assert: Expected 3 — The stock list re-queries itself exactly once', async () => {
      expect.soft(outcome?.listReloads, '[Expected 3] Exactly 1 GET /stock-status re-query follows the failed upload').toBe(1);
    });

    await step('Act: Step 4 — Read the tick boxes once the call has finished', async () => {
      await list.waitForList();
    });

    await step('Assert: Expected 4 — Both rows are still ticked', async () => {
      for (const row of rows) await expect(list.checkbox(row), '[Expected 4] The row is still ticked after the failed upload').toBeChecked();
    });
  });
});
