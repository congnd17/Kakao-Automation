import type { Request } from '@playwright/test';
import { test, expect } from '@fixtures/stock.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { stx, StockTextKey } from '@utils/stock.i18n';
import { stockTags } from '@utils/stock-spec';
import { readXlsxRows } from '@utils/xlsx-reader';
import { stockDb } from '@utils/stock-db';
import { uniqueCode, type StockWorld, type WorldManufacturer, type WorldSku, type WorldWarehouse } from '@utils/stock.data';
import { ownGroupName, ownPhysicalSku } from '@pages/stock-calculation.page';
import { dbDate, firstOfNextMonth } from '@pages/stock-inbound.page';
import { StockListPagingPage } from '@pages/stock-list-paging.page';
import {
  INBOUND_HEADERS,
  IncomingLine,
  InboundHeader,
  MultipartFilePart,
  InboundRow,
  StockUploadPage,
  UPLOAD_PATHS,
  UploadResult,
  addDays,
  buildXls,
  inboundColumn,
  inboundWorkbook,
  incomingCountInWarehouses,
  incomingCountOfSkus,
  incomingLinesOf,
  incomingLinesOfSkus,
  isUpload,
  parseConvert,
  parseRequired,
  rawFile,
  readUpload,
  rowOf,
  watchMultipartFiles,
} from '@pages/stock-upload.page';

/**
 * US134 — nhóm [Inbound Request Upload] (TC_US134_313–343): nút 입고 요청 업로드 trên màn 재고 관리 — địa chỉ upload,
 * hộp chọn file OS, không cần chọn dòng, gom nhóm (입고유형 · 출고지 · 제조사 · 입고 요청일), mã 입고유형, 9 cột, thông báo,
 * upload lặp, workbook chỉ có tiêu đề, không có template, giới hạn dung lượng / số dòng, .xls, file hỏng / rỗng, lỗi bắt
 * buộc / chuyển kiểu kèm dòng + cột, fail-fast + rollback, khoá theo SKU 코드, 기타 사유, biên 수량 / 메모 / 매입가격, kho /
 * 제조사 sai, SKU xoá mềm, mất mạng, mã P, SKU trùng trong nhóm, message lỗi. Mọi workbook chỉ chứa SKU riêng của test
 * (Partner A) và kho automation của suite — teardown `purgeSkus` xoá mọi phiếu 입고 của các SKU đó.
 */
const TAGS = stockTags('inbound-upload');
const t = (key: StockTextKey) => stx(key, 'ko');
const DONE = t('msg.uploadIncomingDone');

/** Ngày dùng thay 2026-10-01 của TC (đã qua ở ngày chạy). */
const DATE = firstOfNextMonth();
const DATE_NOTE = `The TC date 2026-10-01 is already past on the run date, so the inbound request date used is ${DATE} (the 1st of next month, Seoul) and the "other date" is the day after.`;
const OWN_NOTE = 'Data: every workbook row names a physical SKU the test creates for itself (the TC\'s DEMO-SKU-xxxx played by Demo Partner A SKUs of Demo Manufacturer 1 unless stated) and the automation warehouses of the suite (CJ Incheon Aam = WMS · CJ_LOGISTICS of Demo Partner A), so the shared demo rows keep their numbers; the teardown removes the SKUs and every inbound request they carry.';
const STATUS_NOTE = 'The inbound status screen (입고 현황) belongs to US032/US033, so created requests are read from the incoming / incoming_item tables (the records that screen lists).';
const ROW_NOTE = 'Row numbers are Excel sheet rows as the user sees them (row 1 = the header row, row 2 = the first data row); column numbers count from 1 (A = 1).';
const TYPE_CODE: Record<string, string> = { G: 'PURCHASE_ORDER', T: 'TRANSFER', E: 'ETC', '': 'PURCHASE_ORDER' };

/** N SKU 현물 riêng (Partner A, cùng 1 상품코드) — 1 SKU thì không có option. */
async function ownSkus(world: StockWorld, label: string, count: number, manufacturer?: WorldManufacturer): Promise<WorldSku[]> {
  if (count === 1) return [await ownPhysicalSku(world, label, manufacturer ?? world.manufacturers.M1)];
  return world.createPhysicalSku(label, {
    partner: world.partners.A,
    manufacturer: manufacturer ?? world.manufacturers.M1,
    groupName: ownGroupName(world, label),
    lines: Array.from({ length: count }, (_, index) => ({ option: `Type ${String.fromCharCode(65 + index)}` })),
  });
}

/** Dòng workbook hợp lệ chuẩn: CJ Incheon Aam · 제조사 của SKU · G · DATE · 수량 10 · 매입가격 1000. */
function inboundRow(world: StockWorld, sku: WorldSku, over: Partial<InboundRow> = {}): InboundRow {
  return {
    warehouseId: world.warehouses.CJ.id,
    manufacturerId: (sku.manufacturer ?? world.manufacturers.M1).id,
    type: 'G',
    requestDate: DATE,
    skuCode: sku.skuCode,
    quantity: 10,
    purchasePrice: 1000,
    memo: null,
    reason: null,
    ...over,
  };
}

/** Kho thứ 2 của CJ: CJ Daegu warehouse, hoặc General warehouse khi dev không dựng được kho Daegu. */
function secondWarehouse(world: StockWorld): { warehouse: WorldWarehouse; note: string } {
  if (world.warehouses.DAEGU) return { warehouse: world.warehouses.DAEGU, note: '' };
  return { warehouse: world.warehouses.GENERAL, note: `CJ Daegu warehouse is not available (${world.daeguUnavailableReason ?? 'not built'}), so the automation General warehouse of Demo Partner A plays the other warehouse.` };
}

/** Dòng DB khớp đúng 1 dòng workbook (입고유형 · kho · ngày · SKU). */
function matches(line: IncomingLine, row: InboundRow, sku: WorldSku): boolean {
  return (
    line.type === TYPE_CODE[String(row.type ?? '')] &&
    Number(line.warehouse_id) === Number(row.warehouseId) &&
    dbDate(line.request_date) === String(row.requestDate) &&
    Number(line.sku_id) === sku.skuId
  );
}

/** Đính kèm điều ghi nhận được (TC "record the code and string returned"). */
async function record(name: string, value: unknown): Promise<void> {
  await test.info().attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
}

/** Tóm tắt 1 lần upload cho message assertion. */
function brief(result: UploadResult): string {
  return `HTTP ${result.status} ${result.code} ${result.message}`.slice(0, 300);
}

test.describe('[Inbound Request Upload] Stock management — the 입고 요청 업로드 button', () => {
  test('TC_US134_313 — The upload button sends the file to the inbound upload address', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_313',
      'Medium',
      TAGS,
      `입고 요청 업로드 is shown on the stock list toolbar; picking a valid inbound file sends one multipart POST to ${UPLOAD_PATHS.incoming} and never to the adjustment upload (${UPLOAD_PATHS.adjustment}) or the SKU-creation upload (${UPLOAD_PATHS.sku}). ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    let file!: ReturnType<typeof inboundWorkbook>;
    let calls: Request[] = [];
    let result!: UploadResult;

    await step('Arrange: Pre-condition 1–3 — Logged in with write access, a valid inbound file is ready, network calls are recorded', async () => {
      const [sku] = await ownSkus(world, 'U313', 1);
      file = inboundWorkbook(`inbound-${sku.skuCode}.xlsx`, [inboundRow(world, sku, { memo: 'TC313' })]);
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management)', async () => {
      await list.open('ko');
    });

    await step('Assert: Expected 1 — The inbound upload button is displayed', async () => {
      await expect(list.uploadIncomingButton, '[Expected 1] 입고 요청 업로드 (Upload inbound request) is displayed').toBeVisible();
      await expect(list.uploadIncomingButton, `[Expected 1] The button reads ${t('btn.uploadIncomingExcel')}`).toHaveText(t('btn.uploadIncomingExcel'));
    });

    let parts: MultipartFilePart[] = [];
    await step('Act: Step 2 — Click 입고 요청 업로드 (Upload inbound request) and pick the inbound file in the picker', async () => {
      const readParts = await watchMultipartFiles(page);
      calls = await uploads.requestsDuring(async () => {
        result = await uploads.upload('incoming', file);
      });
      parts = await readParts();
    });

    await step('Assert: Expected 2 — The file is sent to the inbound-request upload address', async () => {
      const posts = calls.filter((call) => isUpload(call, 'incoming'));
      expect(posts.length, `[Expected 2] Exactly one POST ${UPLOAD_PATHS.incoming} is sent`).toBe(1);
      expect(posts[0]?.headers()['content-type'] ?? '', '[Expected 2] The call carries the file as multipart/form-data').toContain('multipart/form-data');
      expect(parts.map((part) => `${part.field}=${part.name}`), `[Expected 2] The multipart body carries ${file.name} in the field "file"`).toContain(`file=${file.name}`);
      expect(result.status, `[Expected 2] The inbound upload call answers (${brief(result)})`).toBeLessThan(300);
    });

    let paths: string[] = [];
    await step('Act: Step 3 — Read the call address of every upload call sent', async () => {
      paths = calls.filter((call) => call.method() === 'POST').map((call) => new URL(call.url()).pathname);
    });

    await step('Assert: Expected 3 — The call does not use the adjustment-upload or SKU-creation-upload address', async () => {
      expect(paths, `[Expected 3] No call goes to the adjustment upload ${UPLOAD_PATHS.adjustment}`).not.toContain(UPLOAD_PATHS.adjustment);
      expect(paths, `[Expected 3] No call goes to the SKU-creation upload ${UPLOAD_PATHS.sku}`).not.toContain(UPLOAD_PATHS.sku);
      expect(paths, `[Expected 3] The only upload address used is ${UPLOAD_PATHS.incoming}`).toContain(UPLOAD_PATHS.incoming);
    });
  });

  test('TC_US134_314 — The OS file picker opens and the chosen file uploads at once without a modal', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_314',
      'Medium',
      TAGS,
      `Clicking 입고 요청 업로드 opens the operating-system file picker (Playwright filechooser event) and no application modal; the picker accepts .xlsx and .xls; choosing the file sends the upload at once, with no Upload/Confirm button or confirmation dialog in between. ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    let dialogs = 0;
    page.on('dialog', async (dialog) => {
      dialogs += 1;
      await dialog.dismiss();
    });
    let file!: ReturnType<typeof inboundWorkbook>;
    let chooser!: Awaited<ReturnType<StockUploadPage['openChooser']>>;
    let modalsAtPicker = -1;

    await step('Arrange: Pre-condition 1–2 — Logged in with write access, a valid inbound .xlsx file is ready', async () => {
      const [sku] = await ownSkus(world, 'U314', 1);
      file = inboundWorkbook(`inbound-${sku.skuCode}.xlsx`, [inboundRow(world, sku, { memo: 'TC314' })]);
      await list.open('ko');
    });

    await step('Act: Step 1 — Click 입고 요청 업로드 (Upload inbound request)', async () => {
      chooser = await uploads.openChooser('incoming');
      modalsAtPicker = await uploads.openModals.count();
    });

    await step('Assert: Expected 1 — The operating system file picker opens; no application upload modal opens', async () => {
      expect(chooser, '[Expected 1] The operating system file picker opens').toBeTruthy();
      expect(modalsAtPicker, '[Expected 1] No application upload modal opens').toBe(0);
    });

    let accept = '';
    await step('Act: Step 2 — Observe what the picker offers before choosing a file', async () => {
      accept = (await chooser.element().getAttribute('accept')) ?? '';
    });

    await step('Assert: Expected 2 — The picker allows .xlsx and .xls', async () => {
      const types = accept.split(',').map((type) => type.trim());
      expect(types, '[Expected 2] The picker allows .xlsx').toContain('.xlsx');
      expect(types, '[Expected 2] The picker allows .xls').toContain('.xls');
    });

    let sentAt = 0;
    let pickedAt = 0;
    let result!: UploadResult;
    await step('Act: Step 3 — Choose the valid file', async () => {
      const sent = page.waitForRequest((request) => isUpload(request, 'incoming'), { timeout: 10_000 }).then(() => Date.now());
      pickedAt = Date.now();
      result = await uploads.pick(chooser, 'incoming', file);
      sentAt = await sent;
    });

    await step('Assert: Expected 3 — Choosing the file sends it immediately', async () => {
      expect(sentAt, '[Expected 3] The upload call is sent right after the file is chosen, with no further click').toBeGreaterThan(0);
      expect(sentAt - pickedAt, '[Expected 3] The call leaves within 10 s of choosing the file').toBeLessThan(10_000);
      expect(result.status, `[Expected 3] The upload is processed (${brief(result)})`).toBeLessThan(300);
    });

    let modalsAfter = -1;
    await step('Act: Step 4 — Look for an upload modal, Upload/Confirm button or confirmation dialog before the request is sent', async () => {
      await uploads.expectToast(DONE, 'The upload finishes');
      modalsAfter = await uploads.openModals.count();
    });

    await step('Assert: Expected 4 — No second Upload/Confirm action or pre-upload confirmation is shown', async () => {
      expect(modalsAfter, '[Expected 4] No upload / confirmation modal was shown').toBe(0);
      expect(dialogs, '[Expected 4] No browser confirmation dialog was shown').toBe(0);
      await expect(page.locator('.modal.show').getByRole('button', { name: /업로드|확인|Upload|Confirm/ }), '[Expected 4] No Upload / Confirm button is offered').toHaveCount(0);
    });
  });

  test('TC_US134_315 — The upload runs with no stock row selected', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_315',
      'Medium',
      TAGS,
      `With no row ticked, 입고 요청 업로드 opens the file picker at once, the no-selection guard (${t('guard.noSelection').replace('\n', ' ')}) never appears, and the picked file is processed (${DONE}). ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    const paging = new StockListPagingPage(page, list);
    const guardText = t('guard.noSelection').split('\n')[0];
    let file!: ReturnType<typeof inboundWorkbook>;
    let ticked = -1;

    await step('Arrange: Pre-condition 1–3 — Logged in with write access, a valid inbound file is ready', async () => {
      const [sku] = await ownSkus(world, 'U315', 1);
      file = inboundWorkbook(`inbound-${sku.skuCode}.xlsx`, [inboundRow(world, sku, { memo: 'TC315' })]);
    });

    await step('Act: Step 1 — Open the list and confirm no tick box is selected', async () => {
      await list.open('ko');
      ticked = await paging.checkedRowBoxes.count();
    });

    await step('Assert: Expected 1 — No row is selected', async () => {
      expect(ticked, '[Expected 1] No row is ticked').toBe(0);
    });

    let chooser!: Awaited<ReturnType<StockUploadPage['openChooser']>>;
    await step('Act: Step 2 — Click 입고 요청 업로드 (Upload inbound request)', async () => {
      chooser = await uploads.openChooser('incoming');
    });

    await step('Assert: Expected 2 — The file picker opens immediately', async () => {
      expect(chooser, '[Expected 2] The file picker opens').toBeTruthy();
      await expect(list.guardAlert.filter({ hasText: guardText }), '[Expected 2] No selection guard blocks the picker').toHaveCount(0);
    });

    let result!: UploadResult;
    await step('Act: Step 3 — Pick the valid file and read the message area', async () => {
      result = await uploads.pick(chooser, 'incoming', file);
      await uploads.expectToast(DONE, 'The upload message appears');
    });

    await step('Assert: Expected 3 — No "No stock selected" message appears and the file is processed', async () => {
      await expect(list.guardAlert.filter({ hasText: guardText }), `[Expected 3] ${guardText} does not appear`).toHaveCount(0);
      await expect(page.getByText(guardText), `[Expected 3] ${guardText} is nowhere on the screen`).toHaveCount(0);
      expect(result.status, `[Expected 3] The file is processed (${brief(result)})`).toBeLessThan(300);
      await expect(uploads.toast(DONE).last(), `[Expected 3] ${DONE} confirms the processing`).toBeVisible();
    });
  });

  test('TC_US134_316 — Valid rows map onto their requests and the response holds only the created IDs', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_316',
      'Critical',
      TAGS,
      `A 3-row workbook (G · 100 · 12000 · "Row one", T · 50 · 12000 · "Row two", E · 20 · 9000 · 기타 사유 "Sample restock"; all CJ Incheon Aam · Demo Manufacturer 1) uploads with ${DONE}; the body is an IdsResponse of exactly 3 ids with no per-row report or counts; each request carries its row's values. Deviation in data: DEMO-SKU-0011 belongs to Demo Partner B (Demo Manufacturer B) while CJ Incheon Aam and Demo Manufacturer 1 belong to Demo Partner A — the TC calls the 3 rows valid, so row 3 uses a third Demo Partner A SKU. ${STATUS_NOTE} ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    let skus: WorldSku[] = [];
    let rows: InboundRow[] = [];
    let result!: UploadResult;

    await step('Arrange: Pre-condition 1–3 — A valid 3-row workbook (G / T / E, one group each) and network calls are recorded', async () => {
      skus = await ownSkus(world, 'U316', 3);
      const m1 = world.manufacturers.M1.id;
      rows = [
        inboundRow(world, skus[0], { manufacturerId: m1, type: 'G', quantity: 100, purchasePrice: 12000, memo: 'Row one' }),
        inboundRow(world, skus[1], { manufacturerId: m1, type: 'T', quantity: 50, purchasePrice: 12000, memo: 'Row two' }),
        inboundRow(world, skus[2], { manufacturerId: m1, type: 'E', quantity: 20, purchasePrice: 9000, reason: 'Sample restock' }),
      ];
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload the file through 입고 요청 업로드 (Upload inbound request)', async () => {
      result = await uploads.uploadAndReload('incoming', inboundWorkbook('inbound-tc316.xlsx', rows));
    });

    await step('Assert: Expected 1 — The upload succeeds with 입고 요청 업로드가 완료되었습니다.', async () => {
      expect(result.status, `[Expected 1] The upload succeeds (${brief(result)})`).toBeLessThan(300);
      await expect(uploads.toast(DONE).last(), `[Expected 1] ${DONE} appears`).toBeVisible();
    });

    let keys: string[] = [];
    await step('Act: Step 2 — Inspect the response body', async () => {
      keys = Object.keys(result.body);
      await record('Upload response body', result.body);
    });

    await step('Assert: Expected 2 — IdsResponse holding exactly 3 IDs, one per group, no per-row report or counts', async () => {
      expect(keys, '[Expected 2] The body is an IdsResponse holding only "ids"').toEqual(['ids']);
      expect(result.ids?.length, '[Expected 2] Exactly 3 ids are returned').toBe(3);
      expect(new Set(result.ids ?? []).size, '[Expected 2] The 3 ids are distinct (one per group)').toBe(3);
      for (const key of ['success', 'successCount', 'failure', 'failureCount', 'failed', 'rows', 'results', 'errors']) {
        expect(keys, `[Expected 2] The body has no "${key}" report or count`).not.toContain(key);
      }
    });

    let lines: IncomingLine[] = [];
    await step('Act: Step 3 — Open the inbound status records and find the created requests', async () => {
      lines = await incomingLinesOf(result.ids ?? []);
    });

    await step('Assert: Expected 3 — The 3 created requests are found', async () => {
      expect(new Set(lines.map((line) => String(line.incoming_id))).size, '[Expected 3] The 3 returned ids are stored inbound requests').toBe(3);
      expect(lines.length, '[Expected 3] The 3 requests hold 3 lines in total').toBe(3);
    });

    await step('Act: Step 4 — Compare each stored field with its source cell', async () => {
      await record('Stored inbound lines', lines);
    });

    await step('Assert: Expected 4 — Each request carries the values of its source row, nothing shifts between rows or columns', async () => {
      rows.forEach((row, index) => {
        const line = lines.find((l) => Number(l.sku_id) === skus[index].skuId);
        const label = `row ${index + 2} (${row.type}, ${skus[index].skuCode})`;
        expect(line, `[Expected 4] ${label} has its own request`).toBeDefined();
        expect(line?.type, `[Expected 4] ${label}: 입고유형 ${row.type} → ${TYPE_CODE[String(row.type)]}`).toBe(TYPE_CODE[String(row.type)]);
        expect(Number(line?.warehouse_id), `[Expected 4] ${label}: 출고지 is CJ Incheon Aam`).toBe(world.warehouses.CJ.id);
        expect(dbDate(line?.request_date ?? null), `[Expected 4] ${label}: 입고 요청일 is ${DATE}`).toBe(DATE);
        expect(Number(line?.requested_quantity), `[Expected 4] ${label}: 수량 is ${row.quantity}`).toBe(row.quantity);
        expect(Number(line?.purchase_price), `[Expected 4] ${label}: 매입가격 is ${row.purchasePrice}`).toBe(row.purchasePrice);
        expect(line?.memo ?? null, `[Expected 4] ${label}: 메모 is ${row.memo ?? 'blank'}`).toBe(row.memo ?? null);
        if (row.reason) expect(line?.note, `[Expected 4] ${label}: 기타 사유 is ${row.reason}`).toBe(row.reason);
        else expect(line?.note ?? '', `[Expected 4] ${label}: no 기타 사유 is stored`).toBe('');
        expect(Number(line?.biz_partner_id), `[Expected 4] ${label}: the request belongs to Demo Partner A`).toBe(world.partners.A.id);
      });
    });
  });

  test('TC_US134_317 — Rows are grouped by inbound type, warehouse, manufacturer and request date', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const other = secondWarehouse(world);
    await tcMeta(
      'TC_US134_317',
      'Critical',
      TAGS,
      `Six rows (수량 10, 매입가격 1000, 메모 blank): rows 1-2 share key K1 (G · CJ Incheon Aam · Demo Manufacturer 1 · ${DATE}) with 2 SKUs; rows 3-6 each change one key field (T / ${other.warehouse.name} / Demo Manufacturer 2 with its own SKU / ${addDays(DATE, 1)}). The upload returns 5 ids; rows 1-2 share a request, rows 3-6 have one each; the inbound count rises by 5. The incoming table has no manufacturer column, so row 5 is told apart by its own request id. ${other.note} ${STATUS_NOTE} ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    let skus: WorldSku[] = [];
    let rows: Array<{ row: InboundRow; sku: WorldSku }> = [];
    let before = 0;
    let result!: UploadResult;

    await step('Arrange: Pre-condition 1–4 — Six-row workbook around key K1 and the inbound count before upload', async () => {
      const [a, b] = await ownSkus(world, 'U317', 2);
      const [c] = await ownSkus(world, 'U317M', 1, world.manufacturers.M2);
      skus = [a, b, c];
      const k1 = (sku: WorldSku, over: Partial<InboundRow> = {}) => ({ row: inboundRow(world, sku, { manufacturerId: world.manufacturers.M1.id, ...over }), sku });
      rows = [
        k1(a),
        k1(b),
        k1(a, { type: 'T' }),
        k1(a, { warehouseId: other.warehouse.id }),
        k1(c, { manufacturerId: world.manufacturers.M2.id }),
        k1(a, { requestDate: addDays(DATE, 1) }),
      ];
      before = await incomingCountOfSkus(skus);
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload the workbook', async () => {
      result = await uploads.uploadAndReload('incoming', inboundWorkbook('inbound-tc317.xlsx', rows.map((r) => r.row)));
    });

    await step('Assert: Expected 1 — The workbook is accepted with 입고 요청 업로드가 완료되었습니다.', async () => {
      expect(result.status, `[Expected 1] The workbook is accepted (${brief(result)})`).toBeLessThan(300);
      await expect(uploads.toast(DONE).last(), `[Expected 1] ${DONE} appears`).toBeVisible();
    });

    await step('Act: Step 2 — Inspect IdsResponse', async () => {
      await record('Upload response body', result.body);
    });

    await step('Assert: Expected 2 — IdsResponse holds exactly 5 request IDs, not one per workbook row', async () => {
      expect(result.ids?.length, '[Expected 2] Exactly 5 request ids are returned').toBe(5);
      expect(result.ids?.length, '[Expected 2] Not one id per workbook row (6)').not.toBe(6);
    });

    let lines: IncomingLine[] = [];
    let owner: Array<string | undefined> = [];
    await step('Act: Step 3 — Open the inbound status records and match each source row to a created request', async () => {
      lines = await incomingLinesOf(result.ids ?? []);
      owner = rows.map(({ row, sku }) => lines.find((line) => matches(line, row, sku))?.incoming_id?.toString());
      await record('Source row → request id', owner);
    });

    await step('Assert: Expected 3 — Rows 1-2 share one request, each of rows 3-6 is in its own request', async () => {
      owner.forEach((id, index) => expect(id, `[Expected 3] Row ${index + 1} is found in a created request`).toBeDefined());
      expect(owner[1], '[Expected 3] Rows 1 and 2 (same key K1) are in the same request').toBe(owner[0]);
      for (let index = 2; index < 6; index += 1) {
        expect(owner[index], `[Expected 3] Row ${index + 1} is not in the K1 request`).not.toBe(owner[0]);
        for (let other2 = index + 1; other2 < 6; other2 += 1) expect(owner[index], `[Expected 3] Rows ${index + 1} and ${other2 + 1} are in different requests`).not.toBe(owner[other2]);
      }
    });

    let after = 0;
    await step('Act: Step 4 — Count created requests and their lines', async () => {
      after = await incomingCountOfSkus(skus);
    });

    await step('Assert: Expected 4 — The count rose by 5: K1 has 2 lines, the other 4 have 1, every source row appears once', async () => {
      expect(after - before, '[Expected 4] The inbound count has risen by 5').toBe(5);
      const linesOf = (id: string | undefined) => lines.filter((line) => String(line.incoming_id) === id).length;
      expect(linesOf(owner[0]), '[Expected 4] The K1 request has 2 lines').toBe(2);
      for (let index = 2; index < 6; index += 1) expect(linesOf(owner[index]), `[Expected 4] The request of row ${index + 1} has 1 line`).toBe(1);
      rows.forEach(({ row, sku }, index) => expect(lines.filter((line) => matches(line, row, sku)).length, `[Expected 4] Row ${index + 1} appears exactly once`).toBe(1));
      expect(lines.length, '[Expected 4] 6 lines in total — one per source row').toBe(6);
    });
  });

  test('TC_US134_318 — The same SKU is accepted when it sits in two different inbound groups', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_318',
      'High',
      TAGS,
      `SKU-A appears once for CJ Incheon Aam (Warehouse-1) and once for Demo Pickup Point (Warehouse-2) with every other key equal: the workbook is accepted, 2 ids come back, SKU-A is once in each request and WH-INCOMING_DUPLICATED is not raised. ${STATUS_NOTE} ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    let sku!: WorldSku;
    let before = 0;
    let result!: UploadResult;

    await step('Arrange: Pre-condition 1–3 — SKU-A for Warehouse-1 and Warehouse-2 (2 groups), count known', async () => {
      [sku] = await ownSkus(world, 'U318', 1);
      before = await incomingCountOfSkus([sku]);
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload the workbook through 입고 요청 업로드 (Upload inbound request)', async () => {
      result = await uploads.uploadAndReload('incoming', inboundWorkbook('inbound-tc318.xlsx', [
        inboundRow(world, sku, { warehouseId: world.warehouses.CJ.id }),
        inboundRow(world, sku, { warehouseId: world.warehouses.PICKUP.id }),
      ]));
    });

    await step('Assert: Expected 1 — The workbook is accepted — 2 rows, 2 groups', async () => {
      expect(result.status, `[Expected 1] The workbook is accepted (${brief(result)})`).toBeLessThan(300);
      await expect(uploads.toast(DONE).last(), `[Expected 1] ${DONE} appears`).toBeVisible();
    });

    await step('Act: Step 2 — Inspect the IdsResponse the endpoint returns', async () => {
      await record('Upload response body', result.body);
    });

    await step('Assert: Expected 2 — Two request ids are returned, 1 per warehouse group', async () => {
      expect(result.ids?.length, '[Expected 2] 2 request ids are returned').toBe(2);
    });

    let lines: IncomingLine[] = [];
    await step('Act: Step 3 — Open the inbound status records and find both occurrences of SKU-A', async () => {
      lines = await incomingLinesOf(result.ids ?? []);
    });

    await step('Assert: Expected 3 — SKU-A appears exactly once in each of the 2 requests', async () => {
      for (const id of result.ids ?? []) {
        expect(lines.filter((line) => Number(line.incoming_id) === id && Number(line.sku_id) === sku.skuId).length, `[Expected 3] SKU-A is exactly once in request ${id}`).toBe(1);
      }
      expect(new Set(lines.map((line) => Number(line.warehouse_id))), '[Expected 3] One request per warehouse').toEqual(new Set([world.warehouses.CJ.id, world.warehouses.PICKUP.id]));
      expect((await incomingCountOfSkus([sku])) - before, '[Expected 3] 2 new requests hold SKU-A').toBe(2);
    });

    await step('Act: Step 4 — Check whether either occurrence was reported as a duplicate', async () => {
      await list.waitForList();
    });

    await step('Assert: Expected 4 — WH-INCOMING_DUPLICATED is not raised', async () => {
      expect(result.code, '[Expected 4] WH-INCOMING_DUPLICATED is not raised').not.toBe('WH-INCOMING_DUPLICATED');
      await expect(uploads.toast('SKU가 중복된'), '[Expected 4] No duplicate-SKU message is shown').toHaveCount(0);
    });
  });

  test('TC_US134_319 — Inbound type codes G, T, E and blank are stored as their inbound types', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_319',
      'Medium',
      TAGS,
      `Four one-row files differ only in 입고유형: G → PURCHASE_ORDER (발주), T → TRANSFER (재고이동입고), E with 기타 사유 → ETC (기타) keeping the reason, blank → PURCHASE_ORDER; all four succeed. ${STATUS_NOTE} ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    let sku!: WorldSku;
    const results: Record<string, UploadResult> = {};
    const stored: Record<string, IncomingLine | undefined> = {};
    const reason = 'TC319 other reason';
    const uploadType = async (code: 'G' | 'T' | 'E' | '') => {
      const label = code || 'blank';
      results[label] = await uploads.uploadAndReload('incoming', inboundWorkbook(`inbound-tc319-${label}.xlsx`, [inboundRow(world, sku, { type: code || null, reason: code === 'E' ? reason : null, memo: `TC319 ${label}` })]));
      stored[label] = (await incomingLinesOf(results[label].ids ?? []))[0];
    };

    await step('Arrange: Pre-condition 1–2 — Four valid files differing only in 입고유형: G, T, E with 기타 사유, blank', async () => {
      [sku] = await ownSkus(world, 'U319', 1);
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload the G file', async () => {
      await uploadType('G');
    });

    await step('Assert: Expected 1 — G is stored as PURCHASE_ORDER — 발주 (Purchase order)', async () => {
      expect(stored.G?.type, `[Expected 1] G is stored as PURCHASE_ORDER (${brief(results.G)})`).toBe('PURCHASE_ORDER');
    });

    await step('Act: Step 2 — Upload the T file', async () => {
      await uploadType('T');
    });

    await step('Assert: Expected 2 — T is stored as TRANSFER — 재고이동입고 (Stock-movement inbound)', async () => {
      expect(stored.T?.type, `[Expected 2] T is stored as TRANSFER (${brief(results.T)})`).toBe('TRANSFER');
    });

    await step('Act: Step 3 — Upload the E file with a valid 기타 사유', async () => {
      await uploadType('E');
    });

    await step('Assert: Expected 3 — E is stored as ETC — 기타 (Other) — and keeps the 기타 사유 value', async () => {
      expect(stored.E?.type, `[Expected 3] E is stored as ETC (${brief(results.E)})`).toBe('ETC');
      expect(stored.E?.note, `[Expected 3] The request keeps 기타 사유 "${reason}"`).toBe(reason);
    });

    await step('Act: Step 4 — Upload the blank-type file', async () => {
      await uploadType('');
    });

    await step('Assert: Expected 4 — Blank defaults to PURCHASE_ORDER, the same result as G', async () => {
      expect(stored.blank?.type, `[Expected 4] Blank 입고유형 is stored as PURCHASE_ORDER (${brief(results.blank)})`).toBe('PURCHASE_ORDER');
      expect(stored.blank?.type, '[Expected 4] Blank gives the same type as G').toBe(stored.G?.type);
    });

    await step('Act: Step 5 — Inspect the created requests', async () => {
      await record('Created requests per type', stored);
    });

    await step('Assert: Expected 5 — All four valid files succeed', async () => {
      for (const label of ['G', 'T', 'E', 'blank']) {
        expect(results[label]?.status, `[Expected 5] The ${label} file succeeds (${results[label] ? brief(results[label]) : 'not sent'})`).toBeLessThan(300);
        expect(stored[label], `[Expected 5] The ${label} file created its request`).toBeDefined();
      }
    });
  });

  test('TC_US134_320 — The workbook has exactly 9 columns and names warehouse and manufacturer by ID', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_320',
      'Medium',
      TAGS,
      `The inbound workbook has exactly the 9 Korean headers 출고지 ID, 제조사 ID, 입고유형, 입고 요청일, SKU 코드, 수량, 매입가격, 메모, 기타 사유 (no template exists — TC_324 — so the header row is the one the suite builds from AC 14 and the server accepts); SKU 코드 carries the SKU code, 출고지 ID / 제조사 ID carry IDs, and the created request points at that warehouse. ${STATUS_NOTE} ${DATE_NOTE} ${OWN_NOTE} Not automated: the manufacturer the 제조사 ID resolves to is not stored on the request (incoming has no manufacturer column), so Expected 4 checks it only through the accepted upload of a SKU of that manufacturer.`,
    );
    const uploads = new StockUploadPage(page, list);
    let sku!: WorldSku;
    let file!: ReturnType<typeof inboundWorkbook>;
    let header: string[] = [];

    await step('Arrange: Pre-condition 1–3 — The inbound workbook and valid warehouse / manufacturer IDs are known', async () => {
      [sku] = await ownSkus(world, 'U320', 1);
      file = inboundWorkbook(`inbound-${sku.skuCode}.xlsx`, [inboundRow(world, sku, { memo: 'TC320' })]);
      await list.open('ko');
    });

    await step('Act: Step 1 — Read the header row from left to right and count the columns', async () => {
      header = readXlsxRows(file.buffer)[0] ?? [];
    });

    await step('Assert: Expected 1 — Exactly 9 columns: 출고지 ID, 제조사 ID, 입고유형, 입고 요청일, SKU 코드, 수량, 매입가격, 메모, 기타 사유', async () => {
      expect(header.length, '[Expected 1] The header row has exactly 9 columns').toBe(9);
      INBOUND_HEADERS.forEach((name, index) => expect(header[index], `[Expected 1] Column ${index + 1} is ${name}`).toBe(name));
    });

    await step('Act: Step 2 — Confirm the SKU key column', async () => {
      expect(header, 'The header row is read').toBeDefined();
    });

    await step('Assert: Expected 2 — SKU 코드 (SKU code) is used instead of SKU ID', async () => {
      expect(header, '[Expected 2] The SKU key column is SKU 코드').toContain('SKU 코드');
      expect(header, '[Expected 2] There is no SKU ID column').not.toContain('SKU ID');
      expect(readXlsxRows(file.buffer)[1]?.[inboundColumn('SKU 코드') - 1], '[Expected 2] The SKU 코드 cell holds the SKU code').toBe(sku.skuCode);
    });

    let result!: UploadResult;
    await step('Act: Step 3 — Enter valid IDs in 출고지 ID and 제조사 ID and upload the workbook', async () => {
      result = await uploads.uploadAndReload('incoming', file);
    });

    await step('Assert: Expected 3 — Warehouse and manufacturer are supplied by ID, not by name', async () => {
      expect(header, '[Expected 3] The warehouse column is 출고지 ID').toContain('출고지 ID');
      expect(header, '[Expected 3] The manufacturer column is 제조사 ID').toContain('제조사 ID');
      expect(result.status, `[Expected 3] The workbook with IDs is accepted (${brief(result)})`).toBeLessThan(300);
      await expect(uploads.toast(DONE).last(), `[Expected 3] ${DONE} appears`).toBeVisible();
    });

    let line: IncomingLine | undefined;
    await step('Act: Step 4 — Inspect the created request', async () => {
      line = (await incomingLinesOf(result.ids ?? []))[0];
      await record('Created request', line);
    });

    await step('Assert: Expected 4 — The IDs resolve to the correct destination and manufacturer', async () => {
      expect(Number(line?.warehouse_id), `[Expected 4] 출고지 ID resolves to ${world.warehouses.CJ.name}`).toBe(world.warehouses.CJ.id);
      expect(Number(line?.sku_id), `[Expected 4] The line is for ${sku.skuCode} of manufacturer ${world.manufacturers.M1.name}`).toBe(sku.skuId);
      expect(Number(line?.biz_partner_id), '[Expected 4] The request belongs to Demo Partner A, owner of the warehouse and manufacturer').toBe(world.partners.A.id);
    });
  });

  test('TC_US134_321 — After upload the success message shows, the list reloads once and the ticked rows stay ticked', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const third = world.warehouses.DAEGU ? world.sku('SKU0003') : world.sku('SKU0002');
    await tcMeta(
      'TC_US134_321',
      'High',
      TAGS,
      `With DEMO-SKU-0001 and DEMO-SKU-0003 ticked, a valid inbound upload shows ${DONE}, sends exactly one list reload and leaves both rows ticked. ${world.warehouses.DAEGU ? '' : 'DEMO-SKU-0003 has no stock row because CJ Daegu warehouse is not available, so DEMO-SKU-0002 is ticked instead.'} The ticked rows are demo world rows (only ticked); the uploaded file names the test's own SKU. ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    const paging = new StockListPagingPage(page, list);
    const first = world.sku('SKU0001');
    let file!: ReturnType<typeof inboundWorkbook>;

    await step('Arrange: Pre-condition 1–4 — Demo rows can be selected, a valid inbound file is ready, calls are recorded', async () => {
      const [sku] = await ownSkus(world, 'U321', 1);
      file = inboundWorkbook(`inbound-${sku.skuCode}.xlsx`, [inboundRow(world, sku, { memo: 'TC321' })]);
      await list.open('ko');
      await list.search('SKU_GROUP_NAME', world.keyword);
      await list.choosePageSize(20);
    });

    await step(`Act: Step 1 — Select DEMO-SKU-0001 and DEMO-SKU-${third.key.slice(3)}`, async () => {
      await list.tick(list.row(first.skuCode), first.skuCode);
      await list.tick(list.row(third.skuCode), third.skuCode);
    });

    await step('Assert: Expected 1 — Both rows are ticked', async () => {
      await expect(list.checkbox(list.row(first.skuCode)), '[Expected 1] DEMO-SKU-0001 is ticked').toBeChecked();
      await expect(list.checkbox(list.row(third.skuCode)), `[Expected 1] DEMO-SKU-${third.key.slice(3)} is ticked`).toBeChecked();
    });

    let result!: UploadResult;
    let reloads: URL[] = [];
    await step('Act: Step 2 — Upload the inbound-request file', async () => {
      reloads = await paging.listRequestsDuring(async () => {
        result = await uploads.uploadAndReload('incoming', file);
      });
    });

    await step('Assert: Expected 2 — The upload finishes', async () => {
      expect(result.status, `[Expected 2] The upload finishes successfully (${brief(result)})`).toBeLessThan(300);
    });

    await step('Act: Step 3 — Read the success message and network calls', async () => {
      await uploads.expectToast(DONE, 'The success message appears');
    });

    await step('Assert: Expected 3 — 입고 요청 업로드가 완료되었습니다. shows and exactly one list reload call is sent', async () => {
      await expect(uploads.toast(DONE).last(), `[Expected 3] The message shows ${DONE}`).toBeVisible();
      expect(reloads.length, '[Expected 3] Exactly one list reload call (GET /stock-status) is sent').toBe(1);
    });

    await step('Act: Step 4 — Read the tick boxes after the list reloads', async () => {
      await list.waitForList();
    });

    await step(`Assert: Expected 4 — DEMO-SKU-0001 and DEMO-SKU-${third.key.slice(3)} remain selected`, async () => {
      await expect(list.checkbox(list.row(first.skuCode)), '[Expected 4] DEMO-SKU-0001 remains selected').toBeChecked();
      await expect(list.checkbox(list.row(third.skuCode)), `[Expected 4] DEMO-SKU-${third.key.slice(3)} remains selected`).toBeChecked();
    });
  });

  test('TC_US134_322 — Uploading the same file again creates another set of records', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_322',
      'High',
      TAGS,
      `A one-SKU file (입고 요청일 ${DATE}, 수량 100) uploaded twice creates one request each time: 1 matching record after the first upload, 2 records of 100 units after the second. ${STATUS_NOTE} ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    let sku!: WorldSku;
    let file!: ReturnType<typeof inboundWorkbook>;
    const matching = async () => (await incomingLinesOfSkus([sku])).filter((line) => dbDate(line.request_date) === DATE && Number(line.requested_quantity) === 100);

    await step('Arrange: Pre-condition 1–3 — A valid file with one SKU, date and 수량 100; inbound records are readable', async () => {
      [sku] = await ownSkus(world, 'U322', 1);
      file = inboundWorkbook(`inbound-${sku.skuCode}.xlsx`, [inboundRow(world, sku, { quantity: 100, memo: 'TC322' })]);
      await list.open('ko');
    });

    let first!: UploadResult;
    await step('Act: Step 1 — Click 입고 요청 업로드 (Upload inbound request) and pick that file', async () => {
      first = await uploads.uploadAndReload('incoming', file);
    });

    await step('Assert: Expected 1 — The file is taken', async () => {
      expect(first.status, `[Expected 1] The file is taken (${brief(first)})`).toBeLessThan(300);
      await expect(uploads.toast(DONE).last(), `[Expected 1] ${DONE} appears`).toBeVisible();
    });

    let count1 = 0;
    await step(`Act: Step 2 — Count the inbound records for that SKU with date ${DATE} and quantity 100`, async () => {
      count1 = (await matching()).length;
    });

    await step('Assert: Expected 2 — There is 1 record', async () => {
      expect(count1, '[Expected 2] There is 1 record').toBe(1);
    });

    let second!: UploadResult;
    await step('Act: Step 3 — Go back to 재고 관리 (Stock management) and upload exactly the same file again', async () => {
      await list.open('ko');
      second = await uploads.uploadAndReload('incoming', file);
    });

    await step('Assert: Expected 3 — The second upload is taken too', async () => {
      expect(second.status, `[Expected 3] The second upload is taken (${brief(second)})`).toBeLessThan(300);
      await expect(uploads.toast(DONE).last(), `[Expected 3] ${DONE} appears again`).toBeVisible();
    });

    let records: IncomingLine[] = [];
    await step('Act: Step 4 — Count the records again', async () => {
      records = await matching();
    });

    await step('Assert: Expected 4 — There are now 2 records, 100 units each', async () => {
      expect(records.length, '[Expected 4] There are now 2 records').toBe(2);
      expect(new Set(records.map((r) => String(r.incoming_id))).size, '[Expected 4] The 2 records are separate requests').toBe(2);
      records.forEach((r, index) => expect(Number(r.requested_quantity), `[Expected 4] Record ${index + 1} holds 100 units`).toBe(100));
    });
  });

  test('TC_US134_323 — A header-only workbook succeeds with an empty IDs response', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_323',
      'Medium',
      TAGS,
      `A .xlsx with the exact 9 headers and no data row returns HTTP 201 with IdsResponse { ids: [] }, shows the normal ${DONE} and creates no inbound request (counted on the suite's automation warehouses, the only place a stray request could land). ${STATUS_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    let before = 0;
    let result!: UploadResult;

    await step('Arrange: Pre-condition 1–3 — A workbook with the exact 9 headers and no data rows; the inbound count is known', async () => {
      before = await incomingCountInWarehouses(world);
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload the header-only workbook', async () => {
      result = await uploads.uploadAndReload('incoming', inboundWorkbook('inbound-header-only.xlsx', []));
    });

    await step('Assert: Expected 1 — The server returns HTTP 201', async () => {
      expect(result.status, `[Expected 1] The server returns HTTP 201 (${brief(result)})`).toBe(201);
    });

    await step('Act: Step 2 — Read the HTTP status and response body', async () => {
      await record('Upload response body', result.body);
    });

    await step('Assert: Expected 2 — IdsResponse contains an empty IDs list', async () => {
      expect(Object.keys(result.body), '[Expected 2] The body is an IdsResponse').toEqual(['ids']);
      expect(result.ids, '[Expected 2] The ids list is empty').toEqual([]);
    });

    await step('Act: Step 3 — Read the UI alert', async () => {
      await uploads.expectToast(DONE, 'The upload alert appears');
    });

    await step('Assert: Expected 3 — The normal success alert 입고 요청 업로드가 완료되었습니다. appears', async () => {
      await expect(uploads.toast(DONE).last(), `[Expected 3] ${DONE} appears`).toBeVisible();
    });

    let after = 0;
    await step('Act: Step 4 — Check the inbound status records', async () => {
      after = await incomingCountInWarehouses(world);
    });

    await step('Assert: Expected 4 — No inbound request is created', async () => {
      expect(after, '[Expected 4] No inbound request is created').toBe(before);
    });
  });

  test('TC_US134_324 — Stock management offers no Download Template action', async ({ page, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_324',
      'Medium',
      TAGS,
      'The stock list toolbar and the 입고 요청 업로드 flow carry no Download Template button or link (template / 템플릿 / 양식), and clicking 입고 요청 업로드 only opens the operating-system file picker without calling any template-download endpoint. No file is chosen, so nothing is uploaded.',
    );
    const uploads = new StockUploadPage(page, list);
    const templateName = /template|템플릿|양식/i;

    await step('Arrange: Pre-condition 1–2 — Logged in with write access, network calls are recorded', async () => {
      expect(templateName.test('엑셀 양식 다운로드'), 'The template search pattern is ready').toBe(true);
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock Management)', async () => {
      await list.open('ko');
    });

    await step('Assert: Expected 1 — The Stock management list opens', async () => {
      await expect(list.table, '[Expected 1] The stock list table is shown').toBeVisible();
      await expect(page, '[Expected 1] The address is the stock list').toHaveURL(/\/commerce\/product-stock\/stock(\?|$)/);
    });

    let toolbarText = '';
    await step('Act: Step 2 — Inspect the toolbar and the inbound-upload flow', async () => {
      toolbarText = await list.toolbar.innerText();
    });

    await step('Assert: Expected 2 — The toolbar and the inbound upload flow carry no Download Template action', async () => {
      expect(toolbarText, '[Expected 2] The toolbar has no Download Template action').not.toMatch(templateName);
      await expect(list.uploadIncomingButton, '[Expected 2] The inbound upload control is a single upload label, not a menu with a template item').toHaveText(t('btn.uploadIncomingExcel'));
    });

    await step('Act: Step 3 — Look for a Download Template button or link anywhere on the screen', async () => {
      await list.waitForList();
    });

    await step('Assert: Expected 3 — No Download Template button or link beside 입고 요청 업로드 or anywhere else', async () => {
      await expect(page.getByRole('button', { name: templateName }), '[Expected 3] No Download Template button on the screen').toHaveCount(0);
      await expect(page.getByRole('link', { name: templateName }), '[Expected 3] No Download Template link on the screen').toHaveCount(0);
      await expect(page.locator('main, .custom-card').getByText(templateName), '[Expected 3] No template wording on the stock screen').toHaveCount(0);
    });

    let calls: Request[] = [];
    let opened = false;
    await step('Act: Step 4 — Click 입고 요청 업로드 (Upload inbound request) and inspect the network calls before choosing a file', async () => {
      calls = await uploads.requestsDuring(async () => {
        opened = !!(await uploads.openChooser('incoming'));
      });
    });

    await step('Assert: Expected 4 — Only the operating system file picker opens and no template-download endpoint is called', async () => {
      expect(opened, '[Expected 4] The operating system file picker opens').toBe(true);
      await expect(uploads.openModals, '[Expected 4] Nothing else opens').toHaveCount(0);
      expect(calls.filter((call) => /template/i.test(call.url())).map((call) => call.url()), '[Expected 4] No template-download endpoint is called').toEqual([]);
      expect(calls.filter((call) => isUpload(call, 'incoming')).length, '[Expected 4] No upload is sent before a file is chosen').toBe(0);
    });
  });

  test('TC_US134_325 — There is no application file-size limit or row cap', async ({ page, world, stockListPage: list }) => {
    test.setTimeout(600_000);
    const step = makeStep(page);
    const dates = 52;
    await tcMeta(
      'TC_US134_325',
      'High',
      TAGS,
      `A valid .xlsx over 1 MB with ${dates * 60} data rows (10 own SKUs × G/T × CJ Incheon Aam / Demo Pickup Point / General warehouse × ${dates} request dates = ${dates * 6} groups, so no SKU repeats inside a group) is not refused for its size or row count, completes with ${DONE}, and every group — including the rows after row 3,000 — has its request. ${STATUS_NOTE} ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    let skus: WorldSku[] = [];
    let rows: Array<{ row: InboundRow; sku: WorldSku }> = [];
    let file!: ReturnType<typeof inboundWorkbook>;
    let before = 0;

    await step('Arrange: Pre-condition 1–3 — A valid .xlsx over 1 MB with more than 3,000 data rows; the inbound count is recorded', async () => {
      skus = await ownSkus(world, 'U325', 10);
      const warehouses = [world.warehouses.CJ, world.warehouses.PICKUP, world.warehouses.GENERAL];
      for (let day = 0; day < dates; day += 1) {
        for (const type of ['G', 'T']) {
          for (const warehouse of warehouses) {
            for (const sku of skus) {
              const memo = `TC325 row ${String(rows.length + 2).padStart(5, '0')} ${sku.skuCode} automation filler text`;
              rows.push({ row: inboundRow(world, sku, { type, warehouseId: warehouse.id, requestDate: addDays(DATE, day), memo }), sku });
            }
          }
        }
      }
      file = inboundWorkbook('inbound-tc325-large.xlsx', rows.map((r) => r.row));
      expect(file.buffer.length, 'The workbook is larger than 1 MB').toBeGreaterThan(1_048_576);
      expect(rows.length, 'The workbook has more than 3,000 data rows').toBeGreaterThan(3_000);
      before = await incomingCountOfSkus(skus);
      await list.open('ko');
    });

    let sent = false;
    let response!: Promise<UploadResult>;
    await step('Act: Step 1 — Upload the file through 입고 요청 업로드 (Upload inbound request)', async () => {
      const chooser = await uploads.openChooser('incoming');
      const request = page.waitForRequest((r) => isUpload(r, 'incoming'), { timeout: 30_000 });
      response = page.waitForResponse((res) => isUpload(res.request(), 'incoming'), { timeout: 540_000 }).then(readUpload);
      await chooser.setFiles(file);
      sent = !!(await request);
    });

    await step('Assert: Expected 1 — The application does not reject the workbook because it exceeds 1 MB', async () => {
      expect(sent, `[Expected 1] The ${(file.buffer.length / 1_048_576).toFixed(2)} MB file is sent — no client-side size check stops it`).toBe(true);
      await expect(uploads.toast(t('msg.uploadFailed')), '[Expected 1] No client-side upload failure is shown').toHaveCount(0);
    });

    let result!: UploadResult;
    await step('Act: Step 2 — Watch for file-size or row-count validation', async () => {
      result = await response;
      await record('Upload answer', { status: result.status, code: result.code, message: result.message, ids: result.ids?.length });
    });

    await step('Assert: Expected 2 — The application does not reject it because it exceeds 3,000 rows', async () => {
      expect(result.status, `[Expected 2] The server does not refuse the workbook (${brief(result)})`).toBeLessThan(300);
      expect(result.message, '[Expected 2] No size or row-count message is returned').not.toMatch(/크기|용량|size|3,?000|최대|초과|limit/i);
    });

    await step('Act: Step 3 — Wait for processing to complete', async () => {
      await uploads.expectToast(DONE, 'The upload completes');
    });

    await step('Assert: Expected 3 — Processing completes with 입고 요청 업로드가 완료되었습니다.', async () => {
      await expect(uploads.toast(DONE).last(), `[Expected 3] ${DONE} appears`).toBeVisible();
    });

    let lines: IncomingLine[] = [];
    let after = 0;
    await step('Act: Step 4 — Count the created inbound results', async () => {
      lines = await incomingLinesOf(result.ids ?? []);
      after = await incomingCountOfSkus(skus);
    });

    await step('Assert: Expected 4 — A request exists for every group, including the rows after row 3,000', async () => {
      expect(result.ids?.length, `[Expected 4] ${dates * 6} request ids — one per group`).toBe(dates * 6);
      expect(after - before, `[Expected 4] ${dates * 6} new requests are stored`).toBe(dates * 6);
      expect(lines.length, `[Expected 4] All ${rows.length} rows are stored`).toBe(rows.length);
      const stored = new Set(lines.map((line) => `${line.type}|${line.warehouse_id}|${dbDate(line.request_date)}|${line.sku_id}`));
      const late = rows.slice(3_000);
      const missing = late.filter(({ row, sku }) => !stored.has(`${TYPE_CODE[String(row.type)]}|${row.warehouseId}|${row.requestDate}|${sku.skuId}`));
      expect(missing.length, `[Expected 4] Every one of the ${late.length} rows after row 3,000 is stored`).toBe(0);
    });
  });

  test('TC_US134_326 — The picker offers .xls but the server takes only .xlsx', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const XLSX_ONLY = 'xlsx 형식의 엑셀 파일만 업로드 가능합니다.';
    await tcMeta(
      'TC_US134_326',
      'Medium',
      TAGS,
      `The picker accepts .xlsx and .xls; a genuine .xls (BIFF8 compound file built by the suite) is picked and sent, the screen shows "${XLSX_ONLY}" and nothing is created; the valid .xlsx then creates its request. ${STATUS_NOTE} ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    let sku!: WorldSku;
    let before = 0;

    await step('Arrange: Pre-condition 1–2 — One genuine .xls file and one valid .xlsx file are available', async () => {
      [sku] = await ownSkus(world, 'U326', 1);
      before = await incomingCountInWarehouses(world);
      await list.open('ko');
    });

    let chooser!: Awaited<ReturnType<StockUploadPage['openChooser']>>;
    let accept = '';
    await step('Act: Step 1 — Click 입고 요청 업로드 (Upload inbound request) and read which file types the picker offers', async () => {
      chooser = await uploads.openChooser('incoming');
      accept = (await chooser.element().getAttribute('accept')) ?? '';
    });

    await step('Assert: Expected 1 — The picker offers BOTH .xlsx and .xls', async () => {
      const types = accept.split(',').map((type) => type.trim());
      expect(types, '[Expected 1] The picker offers .xlsx').toContain('.xlsx');
      expect(types, '[Expected 1] The picker offers .xls').toContain('.xls');
    });

    let xls!: UploadResult;
    await step('Act: Step 2 — Pick that .xls file', async () => {
      xls = await uploads.pick(chooser, 'incoming', rawFile(`inbound-${sku.skuCode}.xls`, buildXls(), 'application/vnd.ms-excel'));
    });

    await step('Assert: Expected 2 — The file is picked and sent', async () => {
      expect(xls.status, '[Expected 2] The .xls file is sent and the server answers').toBeGreaterThan(0);
      expect(new URL(xls.url).pathname, `[Expected 2] The file goes to ${UPLOAD_PATHS.incoming}`).toBe(UPLOAD_PATHS.incoming);
    });

    await step('Act: Step 3 — Read the message that appears', async () => {
      await expect(list.toasts.last(), 'A message appears').toBeVisible({ timeout: 30_000 });
    });

    await step('Assert: Expected 3 — The message shows "xlsx 형식의 엑셀 파일만 업로드 가능합니다."', async () => {
      await expect(uploads.toast(XLSX_ONLY).last(), `[Expected 3] The message shows ${XLSX_ONLY}`).toBeVisible();
      expect(xls.message, `[Expected 3] The server answers ${XLSX_ONLY} (${brief(xls)})`).toBe(XLSX_ONLY);
    });

    let afterXls = 0;
    await step('Act: Step 4 — Check the inbound status records for any record created', async () => {
      afterXls = await incomingCountInWarehouses(world);
    });

    await step('Assert: Expected 4 — No record is created', async () => {
      expect(afterXls, '[Expected 4] No record is created by the .xls file').toBe(before);
    });

    let valid!: UploadResult;
    await step('Act: Step 5 — Upload the valid .xlsx file', async () => {
      valid = await uploads.uploadAndReload('incoming', inboundWorkbook(`inbound-${sku.skuCode}.xlsx`, [inboundRow(world, sku, { memo: 'TC326' })]));
    });

    await step('Assert: Expected 5 — The file is taken and the records are created', async () => {
      expect(valid.status, `[Expected 5] The .xlsx file is taken (${brief(valid)})`).toBeLessThan(300);
      await expect(uploads.toast(DONE).last(), `[Expected 5] ${DONE} appears`).toBeVisible();
      expect((await incomingLinesOf(valid.ids ?? [])).filter((line) => Number(line.sku_id) === sku.skuId).length, '[Expected 5] The record is created').toBe(1);
    });
  });

  test('TC_US134_327 — An unreadable workbook and a truly empty file are rejected before any data is read', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const INVALID = '유효하지 않은 엑셀입니다.';
    const EMPTY = '엑셀 파일이 비어있습니다.';
    await tcMeta(
      'TC_US134_327',
      'High',
      TAGS,
      `A plain text file renamed .xlsx is refused with EXL-4000 "${INVALID}", a 0-byte empty.xlsx with EXL-4000 "${EMPTY}", neither creates a record, and a valid file then creates its request. ${STATUS_NOTE} ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    let sku!: WorldSku;
    let before = 0;

    await step('Arrange: Pre-condition 1–3 — A renamed text file, a 0 KB empty.xlsx and a valid inbound file are ready', async () => {
      [sku] = await ownSkus(world, 'U327', 1);
      before = await incomingCountInWarehouses(world);
      await list.open('ko');
    });

    let text!: UploadResult;
    await step('Act: Step 1 — Click 입고 요청 업로드 (Upload inbound request) and pick the renamed text file', async () => {
      text = await uploads.upload('incoming', rawFile('renamed-text.xlsx', Buffer.from('This is a plain text file, not an Excel workbook.\n', 'utf8'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
    });

    await step('Assert: Expected 1 — The system rejects the file', async () => {
      expect(text.status, `[Expected 1] The text file is rejected (${brief(text)})`).toBeGreaterThanOrEqual(400);
    });

    let afterText = 0;
    await step('Act: Step 2 — Read the error code and message, then check the inbound status records', async () => {
      await expect(list.toasts.last(), 'A message appears').toBeVisible({ timeout: 30_000 });
      afterText = await incomingCountInWarehouses(world);
    });

    await step('Assert: Expected 2 — EXL-4000 with "유효하지 않은 엑셀입니다." and no record is created', async () => {
      expect(text.code, '[Expected 2] The error code is EXL-4000').toBe('EXL-4000');
      expect(text.message, `[Expected 2] The message is ${INVALID}`).toBe(INVALID);
      await expect(uploads.toast(INVALID).last(), `[Expected 2] The screen shows ${INVALID}`).toBeVisible();
      expect(afterText, '[Expected 2] No record is created').toBe(before);
    });

    let empty!: UploadResult;
    await step('Act: Step 3 — Click 입고 요청 업로드 (Upload inbound request) and pick the 0 KB file empty.xlsx', async () => {
      empty = await uploads.upload('incoming', rawFile('empty.xlsx', Buffer.alloc(0), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
    });

    await step('Assert: Expected 3 — The system rejects the file', async () => {
      expect(empty.status, `[Expected 3] The empty file is rejected (${brief(empty)})`).toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 4 — Read the message that appears', async () => {
      await expect(list.toasts.last(), 'A message appears').toBeVisible({ timeout: 30_000 });
    });

    await step('Assert: Expected 4 — The message shows "엑셀 파일이 비어있습니다." under code EXL-4000 but a different sentence', async () => {
      expect(empty.code, '[Expected 4] The error code is still EXL-4000').toBe('EXL-4000');
      expect(empty.message, `[Expected 4] The message is ${EMPTY}`).toBe(EMPTY);
      expect(empty.message, '[Expected 4] The sentence differs from the unreadable-file sentence').not.toBe(text.message);
      await expect(uploads.toast(EMPTY).last(), `[Expected 4] The screen shows ${EMPTY}`).toBeVisible();
      expect(await incomingCountInWarehouses(world), '[Expected 4] No record is created').toBe(before);
    });

    let valid!: UploadResult;
    await step('Act: Step 5 — Upload the valid file', async () => {
      valid = await uploads.uploadAndReload('incoming', inboundWorkbook(`inbound-${sku.skuCode}.xlsx`, [inboundRow(world, sku, { memo: 'TC327' })]));
    });

    await step('Assert: Expected 5 — The file is taken and the records are created', async () => {
      expect(valid.status, `[Expected 5] The valid file is taken (${brief(valid)})`).toBeLessThan(300);
      await expect(uploads.toast(DONE).last(), `[Expected 5] ${DONE} appears`).toBeVisible();
      expect((await incomingLinesOf(valid.ids ?? [])).filter((line) => Number(line.sku_id) === sku.skuId).length, '[Expected 5] The record is created').toBe(1);
    });
  });

  test('TC_US134_328 — The exact row and column are reported when a required cell is empty', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_328',
      'Medium',
      TAGS,
      `A 2-data-row workbook whose 수량 cell on row 3 is empty is refused with "{n}행의 {m}열({column})은 필수 항목입니다." naming row 3, column ${inboundColumn('수량')} (수량) — the empty cell — and creates nothing. ${ROW_NOTE} ${STATUS_NOTE} ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    let skus: WorldSku[] = [];
    let file!: ReturnType<typeof inboundWorkbook>;
    let before = 0;
    let result!: UploadResult;

    await step('Arrange: Pre-condition 1–2 — An inbound file whose required 수량 cell on row 3 is empty', async () => {
      skus = await ownSkus(world, 'U328', 2);
      file = inboundWorkbook('inbound-tc328.xlsx', [inboundRow(world, skus[0]), inboundRow(world, skus[1], { quantity: null })]);
      before = await incomingCountOfSkus(skus);
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload that file through 입고 요청 업로드 (Upload inbound request)', async () => {
      result = await uploads.upload('incoming', file);
    });

    await step('Assert: Expected 1 — The system rejects the file', async () => {
      expect(result.status, `[Expected 1] The file is rejected (${brief(result)})`).toBeGreaterThanOrEqual(400);
    });

    let parsed: ReturnType<typeof parseRequired> = null;
    await step('Act: Step 2 — Read the message that appears', async () => {
      await expect(list.toasts.last(), 'A message appears').toBeVisible({ timeout: 30_000 });
      parsed = parseRequired(result.message);
    });

    await step('Assert: Expected 2 — "{n}행의 {m}열({column})은 필수 항목입니다." with the real row, column and name', async () => {
      expect(parsed, `[Expected 2] The message has the shape {n}행의 {m}열({column})은 필수 항목입니다. (got "${result.message}")`).not.toBeNull();
      expect(result.code, '[Expected 2] The code is EXL-4000').toBe('EXL-4000');
      expect(parsed?.name, '[Expected 2] The column name is 수량').toBe('수량');
      await expect(uploads.toast(result.message || '<no message>').last(), '[Expected 2] The screen shows the message').toBeVisible();
    });

    let cell: string | undefined;
    await step('Act: Step 3 — Compare the row and column numbers in the message with the real fault in the file', async () => {
      const sheet = readXlsxRows(file.buffer);
      cell = sheet[(parsed?.row ?? 0) - 1]?.[(parsed?.column ?? 0) - 1];
    });

    await step('Assert: Expected 3 — The row and column point at the cell that was left empty', async () => {
      expect(parsed?.row, '[Expected 3] The row number is 3').toBe(3);
      expect(parsed?.column, `[Expected 3] The column number is ${inboundColumn('수량')} (수량)`).toBe(inboundColumn('수량'));
      expect(cell ?? '', '[Expected 3] The cell named by the message is the empty one').toBe('');
    });

    let after = 0;
    await step('Act: Step 4 — Check the inbound status records for any record created', async () => {
      after = await incomingCountOfSkus(skus);
    });

    await step('Assert: Expected 4 — No record is created', async () => {
      expect(after, '[Expected 4] No record is created').toBe(before);
    });
  });

  test('TC_US134_329 — The row, column and type are reported when a cell cannot be converted', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const BAD_DATE = 'not-a-date';
    await tcMeta(
      'TC_US134_329',
      'Medium',
      TAGS,
      `File A has abc in 수량 on row 2, file B a badly formatted 입고 요청일 ("${BAD_DATE}") on row 4; each is refused with "{n}행 {m}열({column}): 셀(value:{v}, type:{t})을 {type}으로 변환할 수 없습니다." naming its row, column, value and types, and neither creates a record. ${ROW_NOTE} ${STATUS_NOTE} ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    let skus: WorldSku[] = [];
    let before = 0;

    await step('Arrange: Pre-condition 1–3 — File A (abc in 수량 on row 2) and file B (bad 입고 요청일 on row 4)', async () => {
      skus = await ownSkus(world, 'U329', 3);
      before = await incomingCountOfSkus(skus);
      await list.open('ko');
    });

    let a!: UploadResult;
    await step('Act: Step 1 — Upload file A through 입고 요청 업로드 (Upload inbound request)', async () => {
      a = await uploads.upload('incoming', inboundWorkbook('inbound-tc329-a.xlsx', [inboundRow(world, skus[0], { quantity: 'abc' }), inboundRow(world, skus[1])]));
    });

    await step('Assert: Expected 1 — The system rejects the file', async () => {
      expect(a.status, `[Expected 1] File A is rejected (${brief(a)})`).toBeGreaterThanOrEqual(400);
    });

    let pa: ReturnType<typeof parseConvert> = null;
    await step('Act: Step 2 — Read the message that appears', async () => {
      await expect(list.toasts.last(), 'A message appears').toBeVisible({ timeout: 30_000 });
      pa = parseConvert(a.message);
    });

    await step('Assert: Expected 2 — The conversion message with the real values, row number pointing at row 2', async () => {
      expect(pa, `[Expected 2] The message has the conversion shape (got "${a.message}")`).not.toBeNull();
      expect(pa?.row, '[Expected 2] The row number is 2').toBe(2);
      expect(pa?.column, `[Expected 2] The column number is ${inboundColumn('수량')}`).toBe(inboundColumn('수량'));
      expect(pa?.name, '[Expected 2] The column name is 수량').toBe('수량');
      expect(pa?.value, '[Expected 2] The value is abc').toBe('abc');
      expect(pa?.cellType ?? '', '[Expected 2] The cell type is named').not.toBe('');
      expect(pa?.target ?? '', '[Expected 2] The target type is named').not.toBe('');
      await expect(uploads.toast(a.message || '<no message>').last(), '[Expected 2] The screen shows the message').toBeVisible();
    });

    let b!: UploadResult;
    await step('Act: Step 3 — Upload file B', async () => {
      b = await uploads.upload('incoming', inboundWorkbook('inbound-tc329-b.xlsx', [
        inboundRow(world, skus[0]),
        inboundRow(world, skus[1]),
        inboundRow(world, skus[2], { requestDate: BAD_DATE }),
      ]));
    });

    await step('Assert: Expected 3 — The system rejects the file', async () => {
      expect(b.status, `[Expected 3] File B is rejected (${brief(b)})`).toBeGreaterThanOrEqual(400);
    });

    let pb: ReturnType<typeof parseConvert> = null;
    await step('Act: Step 4 — Read the message that appears', async () => {
      await expect(uploads.toast(b.message || '<no message>').last(), 'The message appears').toBeVisible({ timeout: 30_000 });
      pb = parseConvert(b.message);
    });

    await step('Assert: Expected 4 — The same message shape, row number pointing at row 4', async () => {
      expect(pb, `[Expected 4] The message has the conversion shape (got "${b.message}")`).not.toBeNull();
      expect(pb?.row, '[Expected 4] The row number is 4').toBe(4);
      expect(pb?.column, `[Expected 4] The column number is ${inboundColumn('입고 요청일')}`).toBe(inboundColumn('입고 요청일'));
      expect(pb?.name, '[Expected 4] The column name is 입고 요청일').toBe('입고 요청일');
      expect(pb?.value, `[Expected 4] The value is ${BAD_DATE}`).toBe(BAD_DATE);
    });

    let after = 0;
    await step('Act: Step 5 — Check the inbound status records', async () => {
      after = await incomingCountOfSkus(skus);
    });

    await step('Assert: Expected 5 — Neither upload creates a record', async () => {
      expect(after, '[Expected 5] Neither upload creates a record').toBe(before);
    });
  });

  test('TC_US134_330 — A file whose header row misses a column is rejected before any data row is read', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const missing: InboundHeader = '수량';
    const expected = `엑셀에 '${missing}' 항목이 존재하지 않습니다.`;
    await tcMeta(
      'TC_US134_330',
      'Medium',
      TAGS,
      `A workbook with valid data rows but no ${missing} header is refused with "${expected}" — naming the column, no row number — and creates nothing. ${STATUS_NOTE} ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    let skus: WorldSku[] = [];
    let before = 0;
    let result!: UploadResult;

    await step(`Arrange: Pre-condition 1–3 — An inbound file whose header row lacks ${missing}, with valid data rows`, async () => {
      skus = await ownSkus(world, 'U330', 2);
      before = await incomingCountOfSkus(skus);
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload that file through 입고 요청 업로드 (Upload inbound request)', async () => {
      const headers = INBOUND_HEADERS.filter((header) => header !== missing);
      result = await uploads.upload('incoming', inboundWorkbook('inbound-tc330.xlsx', skus.map((sku) => inboundRow(world, sku)), headers));
    });

    await step('Assert: Expected 1 — The system rejects the file', async () => {
      expect(result.status, `[Expected 1] The file is rejected (${brief(result)})`).toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 2 — Read the message that appears', async () => {
      await expect(list.toasts.last(), 'A message appears').toBeVisible({ timeout: 30_000 });
    });

    await step(`Assert: Expected 2 — The message shows "엑셀에 '{column}' 항목이 존재하지 않습니다."`, async () => {
      expect(result.message, `[Expected 2] The message is ${expected}`).toBe(expected);
      await expect(uploads.toast(expected).last(), `[Expected 2] The screen shows ${expected}`).toBeVisible();
    });

    await step('Act: Step 3 — Check whether the message names the missing column', async () => {
      await record('Missing-header answer', { code: result.code, message: result.message });
    });

    await step('Assert: Expected 3 — The message names the missing column by NAME and names NO row number', async () => {
      expect(result.message, `[Expected 3] The message names ${missing}`).toContain(`'${missing}'`);
      expect(rowOf(result.message), '[Expected 3] The message names no row number').toBeNull();
    });

    let after = 0;
    await step('Act: Step 4 — Check the inbound status records for any record created', async () => {
      after = await incomingCountOfSkus(skus);
    });

    await step('Assert: Expected 4 — No record is created', async () => {
      expect(after, '[Expected 4] No record is created').toBe(before);
    });
  });

  test('TC_US134_331 — Parsing stops at the first invalid row and nothing of the workbook is committed', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_331',
      'Critical',
      TAGS,
      `Five data rows (1-2 valid, 3 with 수량 abc, 4 with 입고유형 X, 5 valid) are refused with the conversion error of data row 3 only (sheet row 4), nothing is committed, and the corrected workbook succeeds with ${DONE}. ${ROW_NOTE} ${STATUS_NOTE} ${DATE_NOTE} ${OWN_NOTE} Not automated: the server parser trace (pre-condition 3) is not reachable from the test, so Expected 3 is checked through the answer — it reports only row 3 and says nothing about row 4's 입고유형 X.`,
    );
    const uploads = new StockUploadPage(page, list);
    let skus: WorldSku[] = [];
    let before = 0;
    let result!: UploadResult;
    const rowsWith = (bad: boolean) =>
      skus.map((sku, index) => inboundRow(world, sku, bad && index === 2 ? { quantity: 'abc' } : bad && index === 3 ? { type: 'X' } : { memo: `TC331 row ${index + 1}` }));

    await step('Arrange: Pre-condition 1–4 — A 5-row workbook (row 3 수량 abc, row 4 입고유형 X); the inbound count is recorded', async () => {
      skus = await ownSkus(world, 'U331', 5);
      before = await incomingCountOfSkus(skus);
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload the 5-row file', async () => {
      result = await uploads.upload('incoming', inboundWorkbook('inbound-tc331-bad.xlsx', rowsWith(true)));
    });

    await step('Assert: Expected 1 — The file is rejected', async () => {
      expect(result.status, `[Expected 1] The file is rejected (${brief(result)})`).toBeGreaterThanOrEqual(400);
    });

    let parsed: ReturnType<typeof parseConvert> = null;
    await step('Act: Step 2 — Read the error and the reported row', async () => {
      await expect(list.toasts.last(), 'A message appears').toBeVisible({ timeout: 30_000 });
      parsed = parseConvert(result.message);
    });

    await step('Assert: Expected 2 — The error reports row 3 only: {n}행 {m}열(수량): 셀(value:abc, …)을 {type}으로 변환할 수 없습니다.', async () => {
      expect(parsed, `[Expected 2] The message has the conversion shape (got "${result.message}")`).not.toBeNull();
      expect(parsed?.row, '[Expected 2] {n} points at data row 3 (sheet row 4)').toBe(4);
      expect(parsed?.name, '[Expected 2] The column is 수량').toBe('수량');
      expect(parsed?.column, `[Expected 2] The column number is ${inboundColumn('수량')}`).toBe(inboundColumn('수량'));
      expect(parsed?.value, '[Expected 2] The value is abc').toBe('abc');
      expect(result.message.match(/\d+행/g)?.length ?? 0, '[Expected 2] Only one row is reported').toBe(1);
    });

    await step('Act: Step 3 — Check what the answer says about the rows after row 3', async () => {
      await record('Fail-fast answer', { code: result.code, message: result.message });
    });

    await step('Assert: Expected 3 — Row 4 is never parsed', async () => {
      expect(result.message, '[Expected 3] Nothing is reported about 입고유형').not.toContain('입고유형');
      expect(result.message, '[Expected 3] The invalid type X of row 4 is not reported').not.toMatch(/value:X\b/);
      expect(result.message, '[Expected 3] Sheet row 5 (data row 4) is not reported').not.toMatch(/(^|\D)5행/);
    });

    let after = 0;
    await step('Act: Step 4 — Check the inbound status records for all five rows', async () => {
      after = await incomingCountOfSkus(skus);
    });

    await step('Assert: Expected 4 — None of the 5 rows is committed and the inbound count is unchanged', async () => {
      expect(after, '[Expected 4] The inbound count is unchanged').toBe(before);
      expect((await incomingLinesOfSkus(skus)).length, '[Expected 4] None of the 5 rows is committed').toBe(0);
    });

    let fixed!: UploadResult;
    await step('Act: Step 5 — Correct both invalid rows and upload again', async () => {
      fixed = await uploads.uploadAndReload('incoming', inboundWorkbook('inbound-tc331-fixed.xlsx', rowsWith(false)));
    });

    await step('Assert: Expected 5 — The corrected workbook succeeds with 입고 요청 업로드가 완료되었습니다.', async () => {
      expect(fixed.status, `[Expected 5] The corrected workbook succeeds (${brief(fixed)})`).toBeLessThan(300);
      await expect(uploads.toast(DONE).last(), `[Expected 5] ${DONE} appears`).toBeVisible();
    });
  });

  test('TC_US134_332 — The file is keyed on SKU code, not SKU ID', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_332',
      'High',
      TAGS,
      `A workbook carrying the SKU code in SKU 코드 is accepted and creates the request for that SKU; the same workbook carrying the SKU ID in SKU 코드 is refused with WH-SKU_CODE_NOT_FOUND "{n}행의 SKU 코드를 찾을 수 없습니다. - skuCode: <SKU ID>". The SKU ID 900000000000101 of the TC is played by the real ID of the test's own SKU. ${ROW_NOTE} ${STATUS_NOTE} ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    let sku!: WorldSku;

    await step('Arrange: Pre-condition 1–3 — The SKU and its ID are known; a SKU-code workbook and a SKU-ID workbook are ready', async () => {
      [sku] = await ownSkus(world, 'U332', 1);
      await list.open('ko');
    });

    let byCode!: UploadResult;
    await step('Act: Step 1 — Upload the SKU-code file through 입고 요청 업로드 (Upload inbound request)', async () => {
      byCode = await uploads.uploadAndReload('incoming', inboundWorkbook(`inbound-code-${sku.skuCode}.xlsx`, [inboundRow(world, sku, { memo: 'TC332 code' })]));
    });

    await step('Assert: Expected 1 — The SKU-code file is accepted', async () => {
      expect(byCode.status, `[Expected 1] The SKU-code file is accepted (${brief(byCode)})`).toBeLessThan(300);
      await expect(uploads.toast(DONE).last(), `[Expected 1] ${DONE} appears`).toBeVisible();
    });

    let lines: IncomingLine[] = [];
    await step('Act: Step 2 — Check the created record', async () => {
      lines = await incomingLinesOf(byCode.ids ?? []);
    });

    await step('Assert: Expected 2 — The inbound record is created for the SKU', async () => {
      expect(lines.length, '[Expected 2] One inbound line is created').toBe(1);
      expect(Number(lines[0]?.sku_id), `[Expected 2] The record is for ${sku.skuCode}`).toBe(sku.skuId);
    });

    let byId!: UploadResult;
    await step('Act: Step 3 — Upload the SKU-ID file', async () => {
      byId = await uploads.upload('incoming', inboundWorkbook(`inbound-id-${sku.skuCode}.xlsx`, [inboundRow(world, sku, { skuCode: String(sku.skuId), memo: 'TC332 id' })]));
      await expect(list.toasts.last(), 'A message appears').toBeVisible({ timeout: 30_000 });
    });

    await step('Assert: Expected 3 — Rejected with WH-SKU_CODE_NOT_FOUND: {n}행의 SKU 코드를 찾을 수 없습니다. - skuCode: <SKU ID>', async () => {
      const expected = `2행의 SKU 코드를 찾을 수 없습니다. - skuCode: ${sku.skuId}`;
      expect(byId.status, `[Expected 3] The SKU-ID file is rejected (${brief(byId)})`).toBeGreaterThanOrEqual(400);
      expect(byId.code, '[Expected 3] The code is WH-SKU_CODE_NOT_FOUND').toBe('WH-SKU_CODE_NOT_FOUND');
      expect(byId.message, `[Expected 3] The message is ${expected}`).toBe(expected);
      await expect(uploads.toast(expected).last(), '[Expected 3] The screen shows the message').toBeVisible();
    });
  });

  test('TC_US134_333 — The row number is reported when the SKU code does not exist', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_333',
      'Medium',
      TAGS,
      `Row 2 carries a SKU code that does not exist (DEMO-SKU-9999 played by a never-created code of the run) and row 3 a valid SKU: the file is refused with WH-SKU_CODE_NOT_FOUND "{n}행의 SKU 코드를 찾을 수 없습니다. - skuCode: {code}" naming row 2, and nothing is created. ${ROW_NOTE} ${STATUS_NOTE} ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    let sku!: WorldSku;
    let missing = '';
    let before = 0;
    let result!: UploadResult;

    await step('Arrange: Pre-condition 1–4 — A file with an unknown SKU code on row 2; the inbound count is known', async () => {
      [sku] = await ownSkus(world, 'U333', 1);
      missing = uniqueCode(world.tag, 'NOSKU');
      before = await incomingCountOfSkus([sku]);
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload the file through 입고 요청 업로드 (Upload inbound request)', async () => {
      result = await uploads.upload('incoming', inboundWorkbook('inbound-tc333.xlsx', [inboundRow(world, sku, { skuCode: missing }), inboundRow(world, sku, { type: 'T' })]));
    });

    await step('Assert: Expected 1 — The file is rejected', async () => {
      expect(result.status, `[Expected 1] The file is rejected (${brief(result)})`).toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 2 — Read the error code and message', async () => {
      await expect(list.toasts.last(), 'A message appears').toBeVisible({ timeout: 30_000 });
    });

    await step('Assert: Expected 2 — WH-SKU_CODE_NOT_FOUND with {n}행의 SKU 코드를 찾을 수 없습니다. - skuCode: {code}', async () => {
      expect(result.code, '[Expected 2] The code is WH-SKU_CODE_NOT_FOUND').toBe('WH-SKU_CODE_NOT_FOUND');
      expect(result.message, '[Expected 2] The message has the shape {n}행의 SKU 코드를 찾을 수 없습니다. - skuCode: {code}').toMatch(new RegExp(`^\\d+행의 SKU 코드를 찾을 수 없습니다\\. - skuCode: ${missing}$`));
      await expect(uploads.toast(result.message || '<no message>').last(), '[Expected 2] The screen shows the message').toBeVisible();
    });

    await step('Act: Step 3 — Compare the reported row with the fault in the file', async () => {
      await record('Unknown SKU answer', { code: result.code, message: result.message, row: rowOf(result.message) });
    });

    await step('Assert: Expected 3 — The reported row is row 2', async () => {
      expect(rowOf(result.message), '[Expected 3] The reported row is row 2').toBe(2);
    });

    let after = 0;
    await step('Act: Step 4 — Check whether any inbound record was created', async () => {
      after = await incomingCountOfSkus([sku]);
    });

    await step('Assert: Expected 4 — No inbound record is created; the whole file is rejected', async () => {
      expect(after, '[Expected 4] No inbound record is created — the valid row 3 is not committed either').toBe(before);
    });
  });

  test('TC_US134_334 — 기타 사유 is required when the inbound type code is E', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const NOTE_REQUIRED = '기타 입고 시 사유를 입력해주세요.';
    await tcMeta(
      'TC_US134_334',
      'Medium',
      TAGS,
      `File A (입고유형 E, 기타 사유 blank, plus a valid G row) is refused with WH-INCOMING_NOTE_REQUIRED "${NOTE_REQUIRED}" naming no row or column and nothing is committed; file B (same rows with a 기타 사유) succeeds and stores the reason apart from 메모. ${STATUS_NOTE} ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    let skus: WorldSku[] = [];
    let before = 0;
    const reason = 'TC334 other reason';
    const memo = 'TC334 memo';
    const fileRows = (withReason: boolean) => [inboundRow(world, skus[0], { type: 'E', memo, reason: withReason ? reason : null }), inboundRow(world, skus[1])];

    await step('Arrange: Pre-condition 1–4 — File A (E, blank 기타 사유), file B (same with a reason); counts recorded', async () => {
      skus = await ownSkus(world, 'U334', 2);
      before = await incomingCountOfSkus(skus);
      await list.open('ko');
    });

    let a!: UploadResult;
    await step('Act: Step 1 — Upload file A through 입고 요청 업로드 (Upload inbound request)', async () => {
      a = await uploads.upload('incoming', inboundWorkbook('inbound-tc334-a.xlsx', fileRows(false)));
    });

    await step('Assert: Expected 1 — File A is rejected because 기타 사유 is required when 입고유형 = E', async () => {
      expect(a.status, `[Expected 1] File A is rejected (${brief(a)})`).toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 2 — Read the server error code, message, row and column', async () => {
      await expect(list.toasts.last(), 'A message appears').toBeVisible({ timeout: 30_000 });
    });

    await step('Assert: Expected 2 — WH-INCOMING_NOTE_REQUIRED: 기타 입고 시 사유를 입력해주세요. — no row or column number', async () => {
      expect(a.code, '[Expected 2] The code is WH-INCOMING_NOTE_REQUIRED').toBe('WH-INCOMING_NOTE_REQUIRED');
      expect(a.message, `[Expected 2] The message is ${NOTE_REQUIRED}`).toBe(NOTE_REQUIRED);
      expect(a.message, '[Expected 2] The message carries no row or column number').not.toMatch(/\d+\s*(행|열)/);
      await expect(uploads.toast(NOTE_REQUIRED).last(), '[Expected 2] The screen shows the message').toBeVisible();
    });

    let afterA = 0;
    await step('Act: Step 3 — Confirm that no inbound request from file A was created', async () => {
      afterA = await incomingCountOfSkus(skus);
    });

    await step('Assert: Expected 3 — The whole workbook is rejected; no row from file A is committed', async () => {
      expect(afterA, '[Expected 3] No row from file A is committed (the valid G row neither)').toBe(before);
    });

    let b!: UploadResult;
    let line: IncomingLine | undefined;
    await step('Act: Step 4 — Upload file B and inspect the created inbound request', async () => {
      b = await uploads.uploadAndReload('incoming', inboundWorkbook('inbound-tc334-b.xlsx', fileRows(true)));
      line = (await incomingLinesOf(b.ids ?? [])).find((l) => Number(l.sku_id) === skus[0].skuId);
    });

    await step('Assert: Expected 4 — File B succeeds and stores 기타 사유 separately without overwriting 메모', async () => {
      expect(b.status, `[Expected 4] File B succeeds (${brief(b)})`).toBeLessThan(300);
      await expect(uploads.toast(DONE).last(), `[Expected 4] ${DONE} appears`).toBeVisible();
      expect(line?.type, '[Expected 4] The request is ETC').toBe('ETC');
      expect(line?.note, `[Expected 4] 기타 사유 "${reason}" is stored on the request`).toBe(reason);
      expect(line?.memo, `[Expected 4] 메모 "${memo}" is kept on the line`).toBe(memo);
    });
  });

  test('TC_US134_335 — Requested quantity and memo boundaries', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const EXCEEDED = '요청 수량이 허용 범위를 초과했습니다.';
    const memo100 = 'M'.repeat(90) + 'TC335-0100';
    await tcMeta(
      'TC_US134_335',
      'Medium',
      TAGS,
      `수량 1 and 999999 are accepted; blank is refused with EXL-4000 "{n}행의 {m}열(수량)은 필수 항목입니다."; -1 and 10.5 are recorded (no SRS message — NEEDS CLARIFICATION); 1000000 is refused with WH-INCOMING_QUANTITY_EXCEEDED "${EXCEEDED}" (observed 2026-10-06: the upload answer prefixes the row, "2행: ${EXCEEDED}" — the sentence and code match the TC, the row prefix is accepted and checked to name row 2); a 100-character 메모 is stored in full; a 101-character and an emoji 메모 are refused without truncation (code and string recorded); no refused workbook creates a request. Each value is its own one-row workbook on the test's own SKU. ${STATUS_NOTE} ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    let sku!: WorldSku;
    const outcomes: Record<string, { result: UploadResult; created: number }> = {};
    const send = async (label: string, over: Partial<InboundRow>) => {
      const before = await incomingCountOfSkus([sku]);
      const result = await uploads.upload('incoming', inboundWorkbook(`inbound-tc335-${label}.xlsx`, [inboundRow(world, sku, { memo: `TC335 ${label}`, ...over })]));
      await expect(list.toasts.last(), `A message appears for ${label}`).toBeVisible({ timeout: 30_000 });
      outcomes[label] = { result, created: (await incomingCountOfSkus([sku])) - before };
    };

    await step('Arrange: Pre-condition 1–3 — Files with 수량 1, 999999, blank, -1, 10.5, 1000000 and 메모 of 100 / 101 characters / emoji', async () => {
      [sku] = await ownSkus(world, 'U335', 1);
      expect(memo100.length, 'The 100-character memo has 100 characters').toBe(100);
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload the workbooks with 수량 1 and 999999', async () => {
      await send('qty-1', { quantity: 1 });
      await send('qty-999999', { quantity: 999_999 });
    });

    await step('Assert: Expected 1 — Both workbooks are accepted and each creates its request', async () => {
      for (const label of ['qty-1', 'qty-999999']) {
        expect(outcomes[label].result.status, `[Expected 1] ${label} is accepted (${brief(outcomes[label].result)})`).toBeLessThan(300);
        expect(outcomes[label].created, `[Expected 1] ${label} creates its request`).toBe(1);
      }
    });

    await step('Act: Step 2 — Upload the workbooks with 수량 blank, -1 and 10.5', async () => {
      await send('qty-blank', { quantity: null });
      await send('qty-minus1', { quantity: -1 });
      await send('qty-10.5', { quantity: 10.5 });
      await record('수량 -1 / 10.5 answers', ['qty-minus1', 'qty-10.5'].map((label) => ({ label, status: outcomes[label].result.status, code: outcomes[label].result.code, message: outcomes[label].result.message })));
    });

    await step('Assert: Expected 2 — Blank is rejected with EXL-4000 (수량) is required; -1 and 10.5 are recorded', async () => {
      const blank = outcomes['qty-blank'].result;
      const parsed = parseRequired(blank.message);
      expect(blank.status, `[Expected 2] Blank 수량 is rejected (${brief(blank)})`).toBeGreaterThanOrEqual(400);
      expect(blank.code, '[Expected 2] The code is EXL-4000').toBe('EXL-4000');
      expect(parsed?.name, `[Expected 2] The message names column 수량 (got "${blank.message}")`).toBe('수량');
      expect(parsed?.row, '[Expected 2] The message names row 2').toBe(2);
      expect(parsed?.column, `[Expected 2] The message names column ${inboundColumn('수량')}`).toBe(inboundColumn('수량'));
      for (const label of ['qty-minus1', 'qty-10.5']) expect(outcomes[label].result.status, `[Expected 2] ${label} gets an answer to record (${brief(outcomes[label].result)})`).toBeGreaterThan(0);
    });

    await step('Act: Step 3 — Upload the workbook with 수량 1000000', async () => {
      await send('qty-1000000', { quantity: 1_000_000 });
    });

    await step('Assert: Expected 3 — 1000000 is rejected with WH-INCOMING_QUANTITY_EXCEEDED: 요청 수량이 허용 범위를 초과했습니다.', async () => {
      const result = outcomes['qty-1000000'].result;
      expect(result.status, `[Expected 3] 1000000 is rejected (${brief(result)})`).toBeGreaterThanOrEqual(400);
      expect(result.code, '[Expected 3] The code is WH-INCOMING_QUANTITY_EXCEEDED').toBe('WH-INCOMING_QUANTITY_EXCEEDED');
      expect(result.message.replace(/^\d+행: /, ''), `[Expected 3] The message is ${EXCEEDED} (the upload path may prefix the row as "{n}행: ")`).toBe(EXCEEDED);
      expect(rowOf(result.message) ?? 2, '[Expected 3] A row prefix, when present, names the data row 2').toBe(2);
    });

    let storedMemo: string | null | undefined;
    await step('Act: Step 4 — Upload the workbook with a 100-character 메모', async () => {
      await send('memo-100', { memo: memo100 });
      storedMemo = (await incomingLinesOf(outcomes['memo-100'].result.ids ?? []))[0]?.memo;
    });

    await step('Assert: Expected 4 — The 100-character memo is accepted and stored in full', async () => {
      expect(outcomes['memo-100'].result.status, `[Expected 4] The 100-character memo is accepted (${brief(outcomes['memo-100'].result)})`).toBeLessThan(300);
      expect(storedMemo, '[Expected 4] The memo is stored in full (100 characters)').toBe(memo100);
    });

    await step('Act: Step 5 — Upload the workbooks with a 101-character 메모 and with an emoji in 메모', async () => {
      await send('memo-101', { memo: `${memo100}X` });
      await send('memo-emoji', { memo: 'TC335 memo 😀' });
      await record('101-character / emoji memo answers', ['memo-101', 'memo-emoji'].map((label) => ({ label, status: outcomes[label].result.status, code: outcomes[label].result.code, message: outcomes[label].result.message })));
    });

    await step('Assert: Expected 5 — Both are rejected without truncation', async () => {
      for (const label of ['memo-101', 'memo-emoji']) {
        expect(outcomes[label].result.status, `[Expected 5] ${label} is rejected (${brief(outcomes[label].result)})`).toBeGreaterThanOrEqual(400);
        expect(outcomes[label].created, `[Expected 5] ${label} stores no (truncated) memo`).toBe(0);
      }
    });

    await step('Act: Step 6 — Count the inbound records created by the rejected workbooks', async () => {
      await record('Requests created per workbook', Object.fromEntries(Object.entries(outcomes).map(([label, o]) => [label, { status: o.result.status, created: o.created }])));
    });

    await step('Assert: Expected 6 — No rejected workbook created a request — there is no partial import', async () => {
      for (const [label, outcome] of Object.entries(outcomes)) {
        if (outcome.result.status >= 400) expect(outcome.created, `[Expected 6] The rejected ${label} workbook created no request`).toBe(0);
      }
    });
  });

  test('TC_US134_336 — The inbound request date is required and uses YYYY-MM-DD', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const [year, month, day] = DATE.split('-');
    const slash = `${month}/${day}/${year}`;
    await tcMeta(
      'TC_US134_336',
      'Medium',
      TAGS,
      `Four one-row workbooks differ only in 입고 요청일: ${DATE} is stored as that date; an empty cell is refused with EXL-4000 "{n}행의 {m}열(입고 요청일)은 필수 항목입니다."; the slash form ${slash} is recorded (no SRS format — NEEDS CLARIFICATION); 2026-02-30 is refused with the conversion message; only the valid file (plus the slash file if accepted) creates a record. ${STATUS_NOTE} ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    let sku!: WorldSku;
    let before = 0;
    const results: Record<string, UploadResult> = {};
    const send = async (label: string, requestDate: string | null) => {
      results[label] = await uploads.upload('incoming', inboundWorkbook(`inbound-tc336-${label}.xlsx`, [inboundRow(world, sku, { requestDate, memo: `TC336 ${label}` })]));
      await expect(list.toasts.last(), `A message appears for ${label}`).toBeVisible({ timeout: 30_000 });
    };

    await step('Arrange: Pre-condition 1–3 — Four workbooks differing only in 입고 요청일; the inbound count is known', async () => {
      [sku] = await ownSkus(world, 'U336', 1);
      before = await incomingCountOfSkus([sku]);
      await list.open('ko');
    });

    let stored = '';
    await step('Act: Step 1 — Upload the valid-date file', async () => {
      await send('valid', DATE);
      stored = dbDate((await incomingLinesOf(results.valid.ids ?? []))[0]?.request_date ?? null);
    });

    await step(`Assert: Expected 1 — The file is accepted and the date is stored as ${DATE}`, async () => {
      expect(results.valid.status, `[Expected 1] The valid-date file is accepted (${brief(results.valid)})`).toBeLessThan(300);
      expect(stored, `[Expected 1] The date is stored as ${DATE}`).toBe(DATE);
    });

    await step('Act: Step 2 — Upload the empty-date file', async () => {
      await send('empty', null);
    });

    await step('Assert: Expected 2 — Rejected with EXL-4000: {n}행의 {m}열(입고 요청일)은 필수 항목입니다.', async () => {
      const parsed = parseRequired(results.empty.message);
      expect(results.empty.status, `[Expected 2] The empty-date file is rejected (${brief(results.empty)})`).toBeGreaterThanOrEqual(400);
      expect(results.empty.code, '[Expected 2] The code is EXL-4000').toBe('EXL-4000');
      expect(parsed?.name, `[Expected 2] The message names column 입고 요청일 (got "${results.empty.message}")`).toBe('입고 요청일');
      expect(parsed?.column, `[Expected 2] The column number is ${inboundColumn('입고 요청일')}`).toBe(inboundColumn('입고 요청일'));
      expect(parsed?.row, '[Expected 2] The row number is 2').toBe(2);
    });

    let slashCreated = 0;
    await step(`Act: Step 3 — Upload the slash-formatted date file (${slash})`, async () => {
      const count = await incomingCountOfSkus([sku]);
      await send('slash', slash);
      slashCreated = (await incomingCountOfSkus([sku])) - count;
      await record('Slash-date answer', { status: results.slash.status, code: results.slash.code, message: results.slash.message, created: slashCreated });
    });

    await step('Assert: Expected 3 — The slash form is either accepted or rejected with the conversion message (recorded)', async () => {
      if (results.slash.status < 300) {
        expect(slashCreated, '[Expected 3] The accepted slash form created its record').toBe(1);
      } else {
        const parsed = parseConvert(results.slash.message);
        expect(parsed?.name, `[Expected 3] The rejection is the conversion message of 입고 요청일 (got "${results.slash.message}")`).toBe('입고 요청일');
        expect(parsed?.value, `[Expected 3] The rejection names the value ${slash}`).toBe(slash);
        expect(slashCreated, '[Expected 3] The rejected slash form created nothing').toBe(0);
      }
    });

    await step('Act: Step 4 — Upload the impossible-date file (2026-02-30)', async () => {
      await send('impossible', '2026-02-30');
    });

    await step('Assert: Expected 4 — Rejected with {n}행 {m}열(입고 요청일): 셀(value:{v}, type:{t})을 {type}으로 변환할 수 없습니다.', async () => {
      const parsed = parseConvert(results.impossible.message);
      expect(results.impossible.status, `[Expected 4] 2026-02-30 is rejected (${brief(results.impossible)})`).toBeGreaterThanOrEqual(400);
      expect(parsed, `[Expected 4] The message has the conversion shape (got "${results.impossible.message}")`).not.toBeNull();
      expect(parsed?.name, '[Expected 4] The column is 입고 요청일').toBe('입고 요청일');
      expect(parsed?.column, `[Expected 4] The column number is ${inboundColumn('입고 요청일')}`).toBe(inboundColumn('입고 요청일'));
      expect(parsed?.value, '[Expected 4] The value is 2026-02-30').toBe('2026-02-30');
    });

    let after = 0;
    await step('Act: Step 5 — Count the inbound records created by the 4 uploads', async () => {
      after = await incomingCountOfSkus([sku]);
    });

    await step('Assert: Expected 5 — Valid file 1 record, empty and impossible none; +1 only if the slash form was accepted', async () => {
      expect(after - before, '[Expected 5] The 4 uploads created 1 record (+1 for an accepted slash form)').toBe(1 + (results.slash.status < 300 ? 1 : 0));
    });
  });

  test('TC_US134_337 — An invalid warehouse ID or manufacturer ID is rejected and the workbook is rolled back', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_337',
      'High',
      TAGS,
      `3-row workbooks (rows 1 and 3 valid): run A puts a Demo Partner B PLATFORM warehouse in 출고지 ID on row 2 and is refused with WH-WAREHOUSE_BIZ_PARTNER_MISMATCH "SKU의 비즈파트너와 창고의 비즈파트너가 다릅니다. - warehouseId: {warehouseId}, bizPartnerId: {bizPartnerId}"; run B puts a Demo Partner B manufacturer in 제조사 ID on row 2 and is refused (BA proposal WH-MANUFACTURER_DIFFERENT, open item SPEC-GAP-27 — checked as a soft assertion, code and message recorded); neither run commits rows 1 and 3. The Demo Partner B warehouse is an automation PLATFORM warehouse the test creates (removed at teardown). ${STATUS_NOTE} ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    let skus: WorldSku[] = [];
    let warehouseB = 0;
    let before = 0;
    const counts = async () => (await incomingCountOfSkus(skus)) + (await incomingCountInWarehouses(world, [warehouseB]));

    await step('Arrange: Pre-condition 1–5 — 3-row files (rows 1 and 3 valid), a Demo Partner B warehouse and manufacturer; counts recorded', async () => {
      skus = await ownSkus(world, 'U337', 3);
      warehouseB = (await world.createWarehouse('U337 Partner B', 'PLATFORM_GENERAL', { bizPartnerId: String(world.partners.B.id) })).id;
      before = await counts();
      await list.open('ko');
    });

    let runA!: UploadResult;
    await step('Act: Step 1 — Upload run A (row 2 carries a Demo Partner B PLATFORM warehouse in 출고지 ID)', async () => {
      runA = await uploads.upload('incoming', inboundWorkbook('inbound-tc337-a.xlsx', [inboundRow(world, skus[0]), inboundRow(world, skus[1], { warehouseId: warehouseB }), inboundRow(world, skus[2])]));
    });

    await step('Assert: Expected 1 — Run A is rejected', async () => {
      expect(runA.status, `[Expected 1] Run A is rejected (${brief(runA)})`).toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 2 — Read the code and message', async () => {
      await expect(list.toasts.last(), 'A message appears').toBeVisible({ timeout: 30_000 });
    });

    await step('Assert: Expected 2 — WH-WAREHOUSE_BIZ_PARTNER_MISMATCH: SKU의 비즈파트너와 창고의 비즈파트너가 다릅니다. - warehouseId, bizPartnerId', async () => {
      expect(runA.code, '[Expected 2] The code is WH-WAREHOUSE_BIZ_PARTNER_MISMATCH').toBe('WH-WAREHOUSE_BIZ_PARTNER_MISMATCH');
      expect(runA.message, '[Expected 2] The message names the Demo Partner B warehouse and a biz partner id').toMatch(new RegExp(`^SKU의 비즈파트너와 창고의 비즈파트너가 다릅니다\\. - warehouseId: ${warehouseB}, bizPartnerId: \\d+$`));
      await expect(uploads.toast(runA.message || '<no message>').last(), '[Expected 2] The screen shows the message').toBeVisible();
    });

    let afterA = 0;
    await step('Act: Step 3 — Open the inbound status records and look for rows 1-3', async () => {
      afterA = await counts();
    });

    await step('Assert: Expected 3 — Rows 1 and 3 are not committed; the inbound count is unchanged', async () => {
      expect(afterA, '[Expected 3] The inbound count is unchanged').toBe(before);
      expect((await incomingLinesOfSkus([skus[0], skus[2]])).length, '[Expected 3] Rows 1 and 3 are not committed').toBe(0);
    });

    let runB!: UploadResult;
    await step('Act: Step 4 — Upload run B (row 2 carries a Demo Partner B manufacturer ID in 제조사 ID)', async () => {
      runB = await uploads.upload('incoming', inboundWorkbook('inbound-tc337-b.xlsx', [inboundRow(world, skus[0]), inboundRow(world, skus[1], { manufacturerId: world.manufacturers.MB.id }), inboundRow(world, skus[2])]));
    });

    await step('Assert: Expected 4 — Run B is rejected', async () => {
      expect(runB.status, `[Expected 4] Run B is rejected (${brief(runB)})`).toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 5 — Read the code and message', async () => {
      await expect(list.toasts.last(), 'A message appears').toBeVisible({ timeout: 30_000 });
      await record('Run B answer (SPEC-GAP-27)', { status: runB.status, code: runB.code, message: runB.message });
    });

    await step('Assert: Expected 5 — (Open, BA proposal) WH-MANUFACTURER_DIFFERENT naming the SKU, its manufacturer and the request manufacturer', async () => {
      expect(runB.code, '[Expected 5] WH-MANUFACTURER_BIZ_PARTNER_MISMATCH (a SKU-save rule) is not the code here').not.toBe('WH-MANUFACTURER_BIZ_PARTNER_MISMATCH');
      expect.soft(runB.code, '[Expected 5] The proposed code is WH-MANUFACTURER_DIFFERENT').toBe('WH-MANUFACTURER_DIFFERENT');
      expect.soft(runB.message, '[Expected 5] The proposed message names the SKU, its manufacturer and the request manufacturer').toBe(
        `입고 대상 SKU(id: ${skus[1].skuId})의 제조사(id: ${world.manufacturers.M1.id})와 입고 요청의 제조사(id: ${world.manufacturers.MB.id})가 다릅니다.`,
      );
    });

    let afterB = 0;
    await step('Act: Step 6 — Open the inbound status records again', async () => {
      afterB = await counts();
    });

    await step('Assert: Expected 6 — The inbound count is still unchanged', async () => {
      expect(afterB, '[Expected 6] The inbound count is still unchanged').toBe(before);
    });
  });

  test('TC_US134_338 — A soft-deleted SKU is rejected even though its SKU code is still in the file', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_338',
      'High',
      TAGS,
      `A 3-row file whose middle row (sheet row 3) names a soft-deleted SKU is refused with WH-SKU_CODE_NOT_FOUND "{n}행: 삭제된 SKU 코드입니다. - skuCode: {code}" naming row 3, nothing is created, and the same file with an active SKU in the middle row completes with ${DONE}. The soft-deleted SKU is the test's own SKU, soft-deleted by DB fixture (deleted_at). ${ROW_NOTE} ${STATUS_NOTE} ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    let skus: WorldSku[] = [];
    let deleted!: WorldSku;
    let before = 0;
    let result!: UploadResult;
    const fileWith = (middle: WorldSku, name: string) => inboundWorkbook(name, [inboundRow(world, skus[0]), inboundRow(world, middle), inboundRow(world, skus[2])]);

    await step('Arrange: Pre-condition 1–3 — A 3-row file whose middle row names a soft-deleted SKU; the inbound count is recorded', async () => {
      skus = await ownSkus(world, 'U338', 3);
      [deleted] = await ownSkus(world, 'U338D', 1);
      await stockDb.softDeleteSku(deleted.skuId);
      before = await incomingCountOfSkus([...skus, deleted]);
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload the file through 입고 요청 업로드 (Upload inbound request)', async () => {
      result = await uploads.upload('incoming', fileWith(deleted, 'inbound-tc338-deleted.xlsx'));
    });

    await step('Assert: Expected 1 — The file is rejected', async () => {
      expect(result.status, `[Expected 1] The file is rejected (${brief(result)})`).toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 2 — Read the error and row number', async () => {
      await expect(list.toasts.last(), 'A message appears').toBeVisible({ timeout: 30_000 });
    });

    await step('Assert: Expected 2 — WH-SKU_CODE_NOT_FOUND: {n}행: 삭제된 SKU 코드입니다. - skuCode: {code}, {n} at the middle row', async () => {
      expect(result.code, '[Expected 2] The code is WH-SKU_CODE_NOT_FOUND').toBe('WH-SKU_CODE_NOT_FOUND');
      expect(result.message, '[Expected 2] The message is the deleted-SKU sentence for the middle row').toBe(`3행: 삭제된 SKU 코드입니다. - skuCode: ${deleted.skuCode}`);
      expect(rowOf(result.message), '[Expected 2] {n} points at the middle row (row 3)').toBe(3);
      await expect(uploads.toast(result.message || '<no message>').last(), '[Expected 2] The screen shows the message').toBeVisible();
    });

    let after = 0;
    await step('Act: Step 3 — Check the inbound status records for all 3 rows', async () => {
      after = await incomingCountOfSkus([...skus, deleted]);
    });

    await step('Assert: Expected 3 — No inbound record is created for any of the 3 rows; the count is unchanged', async () => {
      expect(after, '[Expected 3] The inbound count is unchanged').toBe(before);
    });

    let active!: UploadResult;
    await step('Act: Step 4 — Repeat with an active SKU code in the middle row', async () => {
      active = await uploads.uploadAndReload('incoming', fileWith(skus[1], 'inbound-tc338-active.xlsx'));
    });

    await step('Assert: Expected 4 — With an active SKU code the file completes with 입고 요청 업로드가 완료되었습니다.', async () => {
      expect(active.status, `[Expected 4] The file with an active SKU completes (${brief(active)})`).toBeLessThan(300);
      await expect(uploads.toast(DONE).last(), `[Expected 4] ${DONE} appears`).toBeVisible();
    });
  });

  test('TC_US134_339 — A dropped connection during a large upload leaves all or none of the workbook', async ({ page, world, stockListPage: list }) => {
    test.setTimeout(600_000);
    const step = makeStep(page);
    const dates = 59;
    const groups = dates * 6;
    await tcMeta(
      'TC_US134_339',
      'Medium',
      TAGS,
      `A valid ${dates * 60}-row workbook (${groups} groups) is uploaded and the browser goes offline (Playwright context.setOffline) as soon as the request has left, before any alert; what the screen shows is recorded (NEEDS CLARIFICATION) — only the success message is ruled out, since no answer can arrive. After reconnecting, the inbound records hold either every group or none (polled up to 2 minutes for the server transaction). ${STATUS_NOTE} ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    let skus: WorldSku[] = [];
    let file!: ReturnType<typeof inboundWorkbook>;
    let before = 0;

    await step('Arrange: Pre-condition 1–3 — A valid 3,500-row workbook in several groups; the inbound records are recorded', async () => {
      skus = await ownSkus(world, 'U339', 10);
      const rows: InboundRow[] = [];
      for (let day = 0; day < dates; day += 1) {
        for (const type of ['G', 'T']) {
          for (const warehouse of [world.warehouses.CJ, world.warehouses.PICKUP, world.warehouses.GENERAL]) {
            for (const sku of skus) rows.push(inboundRow(world, sku, { type, warehouseId: warehouse.id, requestDate: addDays(DATE, day), memo: `TC339 row ${rows.length + 2}` }));
          }
        }
      }
      file = inboundWorkbook('inbound-tc339-large.xlsx', rows);
      expect(rows.length, 'The workbook has at least 3,500 data rows').toBeGreaterThanOrEqual(3_500);
      before = await incomingCountOfSkus(skus);
      await list.open('ko');
    });

    let shown: string[] = [];
    await step('Act: Step 1 — Upload the workbook and disconnect the network before the alert appears', async () => {
      const chooser = await uploads.openChooser('incoming');
      const request = page.waitForRequest((r) => isUpload(r, 'incoming'), { timeout: 30_000 });
      await chooser.setFiles(file);
      await request;
      await page.context().setOffline(true);
      await expect(list.uploadIncomingButton, 'The upload button settles once the call ends').toHaveAttribute('aria-disabled', 'false', { timeout: 330_000 });
      shown = (await list.toasts.allInnerTexts()).map((text) => text.trim());
      await record('Screen after the connection dropped', { toasts: shown });
    });

    await step('Assert: Expected 1 — (NEEDS CLARIFICATION) What the screen shows is recorded; it does not claim success', async () => {
      expect(shown.some((text) => text.includes(DONE)), `[Expected 1] The screen does not show ${DONE} for an upload whose answer never arrived`).toBe(false);
    });

    let after = 0;
    await step('Act: Step 2 — Reconnect and open the inbound status records', async () => {
      await page.context().setOffline(false);
      await list.open('ko');
      after = await expect
        .poll(async () => (await incomingCountOfSkus(skus)) - before, { timeout: 120_000, intervals: [5_000] })
        .toBe(groups)
        .then(async () => (await incomingCountOfSkus(skus)) - before, async () => (await incomingCountOfSkus(skus)) - before);
      await record('Requests found after reconnecting', { created: after, groups });
    });

    await step('Assert: Expected 2 — Either every group of the workbook is stored or none — never only part of the file', async () => {
      expect([0, groups], `[Expected 2] ${after} requests were created — all ${groups} groups or none`).toContain(after);
    });
  });

  test('TC_US134_340 — Assembly code P is rejected as an operator-created inbound type', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const NOT_SUPPORTED = '지원하지 않는 입고유형입니다.';
    await tcMeta(
      'TC_US134_340',
      'High',
      TAGS,
      `An otherwise valid workbook with 입고유형 P on one row is refused with WH-INCOMING_TYPE_NOT_SUPPORTED "${NOT_SUPPORTED}" (no row number), nothing is committed and no ASSEMBLY (조립) request exists. The TC notes the current build may still accept P (201) — that outcome fails this test by design. ${STATUS_NOTE} ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    let skus: WorldSku[] = [];
    let before = 0;
    let result!: UploadResult;

    await step('Arrange: Pre-condition 1–3 — A valid workbook with 입고유형 P on one row; the inbound count is known', async () => {
      skus = await ownSkus(world, 'U340', 2);
      before = await incomingCountOfSkus(skus);
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload the workbook through 입고 요청 업로드 (Upload inbound request)', async () => {
      result = await uploads.upload('incoming', inboundWorkbook('inbound-tc340.xlsx', [inboundRow(world, skus[0]), inboundRow(world, skus[1], { type: 'P' })]));
    });

    await step('Assert: Expected 1 — The workbook is rejected and nothing is committed', async () => {
      expect(result.status, `[Expected 1] The workbook is rejected (${brief(result)})`).toBeGreaterThanOrEqual(400);
      expect(await incomingCountOfSkus(skus), '[Expected 1] Nothing is committed').toBe(before);
    });

    await step('Act: Step 2 — Read the server code and the message', async () => {
      await expect(list.toasts.last(), 'A message appears').toBeVisible({ timeout: 30_000 });
    });

    await step('Assert: Expected 2 — WH-INCOMING_TYPE_NOT_SUPPORTED: 지원하지 않는 입고유형입니다.', async () => {
      expect(result.code, '[Expected 2] The code is WH-INCOMING_TYPE_NOT_SUPPORTED').toBe('WH-INCOMING_TYPE_NOT_SUPPORTED');
      expect(result.message, `[Expected 2] The message is ${NOT_SUPPORTED}`).toBe(NOT_SUPPORTED);
    });

    await step('Act: Step 3 — Check whether the message names a row number', async () => {
      await record('Type P answer', { code: result.code, message: result.message });
    });

    await step('Assert: Expected 3 — The message names no row number — it is exactly the string in step 2', async () => {
      expect(rowOf(result.message), '[Expected 3] The message names no row number').toBeNull();
      await expect(uploads.toast(NOT_SUPPORTED).last(), `[Expected 3] The screen shows exactly ${NOT_SUPPORTED}`).toBeVisible();
    });

    let lines: IncomingLine[] = [];
    await step('Act: Step 4 — Open the inbound status records and look for anything this file created', async () => {
      lines = await incomingLinesOfSkus(skus);
    });

    await step('Assert: Expected 4 — No inbound request exists, and no row was turned into 조립 (Assembly)', async () => {
      expect(lines.length, '[Expected 4] No inbound request exists').toBe(0);
      expect(lines.filter((line) => line.type === 'ASSEMBLY').length, '[Expected 4] No row was turned into ASSEMBLY').toBe(0);
    });
  });

  test('TC_US134_341 — 매입가격 is required and below 100,000,000', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const EXCEEDED = '매입가격이 허용 범위를 초과했습니다.';
    await tcMeta(
      'TC_US134_341',
      'Medium',
      TAGS,
      `One-row workbooks: blank 매입가격 on a G, a T and an E row (with 기타 사유) are each refused with EXL-4000 "{n}행의 {m}열(매입가격)은 필수 항목입니다."; 0 is accepted; -1 is refused (code and string recorded — NEEDS CLARIFICATION); 99,999,999 is accepted; 100,000,000 is refused with WH-INCOMING_PURCHASE_PRICE_EXCEEDED "${EXCEEDED}"; exactly 2 requests are created. ${STATUS_NOTE} ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    let sku!: WorldSku;
    let start = 0;
    const outcomes: Record<string, { result: UploadResult; created: number }> = {};
    const send = async (label: string, over: Partial<InboundRow>) => {
      const before = await incomingCountOfSkus([sku]);
      const result = await uploads.upload('incoming', inboundWorkbook(`inbound-tc341-${label}.xlsx`, [inboundRow(world, sku, { memo: `TC341 ${label}`, ...over })]));
      await expect(list.toasts.last(), `A message appears for ${label}`).toBeVisible({ timeout: 30_000 });
      outcomes[label] = { result, created: (await incomingCountOfSkus([sku])) - before };
    };

    await step('Arrange: Pre-condition 1–3 — Workbooks with 매입가격 blank (G / T / E), 0, -1, 99999999 and 100000000; counts recorded', async () => {
      [sku] = await ownSkus(world, 'U341', 1);
      start = await incomingCountOfSkus([sku]);
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload the 3 blank-price workbooks', async () => {
      await send('blank-G', { type: 'G', purchasePrice: null });
      await send('blank-T', { type: 'T', purchasePrice: null });
      await send('blank-E', { type: 'E', purchasePrice: null, reason: 'TC341 other reason' });
    });

    await step('Assert: Expected 1 — Each blank workbook is rejected with EXL-4000: {n}행의 {m}열(매입가격)은 필수 항목입니다.', async () => {
      for (const label of ['blank-G', 'blank-T', 'blank-E']) {
        const { result } = outcomes[label];
        const parsed = parseRequired(result.message);
        expect(result.status, `[Expected 1] ${label} is rejected (${brief(result)})`).toBeGreaterThanOrEqual(400);
        expect(result.code, `[Expected 1] ${label}: the code is EXL-4000`).toBe('EXL-4000');
        expect(parsed?.name, `[Expected 1] ${label}: the message names 매입가격 (got "${result.message}")`).toBe('매입가격');
        expect(parsed?.column, `[Expected 1] ${label}: the column number is ${inboundColumn('매입가격')}`).toBe(inboundColumn('매입가격'));
        expect(parsed?.row, `[Expected 1] ${label}: the row number is 2`).toBe(2);
      }
    });

    await step('Act: Step 2 — Upload the 0 workbook', async () => {
      await send('price-0', { purchasePrice: 0 });
    });

    await step('Assert: Expected 2 — 0 is accepted and the request is created', async () => {
      expect(outcomes['price-0'].result.status, `[Expected 2] 0 is accepted (${brief(outcomes['price-0'].result)})`).toBeLessThan(300);
      expect(outcomes['price-0'].created, '[Expected 2] The request is created').toBe(1);
    });

    await step('Act: Step 3 — Upload the -1 workbook', async () => {
      await send('price-minus1', { purchasePrice: -1 });
      await record('매입가격 -1 answer', { status: outcomes['price-minus1'].result.status, code: outcomes['price-minus1'].result.code, message: outcomes['price-minus1'].result.message });
    });

    await step('Assert: Expected 3 — -1 is rejected (code and string recorded)', async () => {
      expect(outcomes['price-minus1'].result.status, `[Expected 3] -1 is rejected (${brief(outcomes['price-minus1'].result)})`).toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 4 — Upload the 99999999 workbook', async () => {
      await send('price-99999999', { purchasePrice: 99_999_999 });
    });

    await step('Assert: Expected 4 — 99,999,999 is accepted and the request is created', async () => {
      expect(outcomes['price-99999999'].result.status, `[Expected 4] 99,999,999 is accepted (${brief(outcomes['price-99999999'].result)})`).toBeLessThan(300);
      expect(outcomes['price-99999999'].created, '[Expected 4] The request is created').toBe(1);
    });

    await step('Act: Step 5 — Upload the 100000000 workbook', async () => {
      await send('price-100000000', { purchasePrice: 100_000_000 });
    });

    await step('Assert: Expected 5 — 100,000,000 is rejected with WH-INCOMING_PURCHASE_PRICE_EXCEEDED: 매입가격이 허용 범위를 초과했습니다.', async () => {
      const { result } = outcomes['price-100000000'];
      expect(result.status, `[Expected 5] 100,000,000 is rejected (${brief(result)})`).toBeGreaterThanOrEqual(400);
      expect(result.code, '[Expected 5] The code is WH-INCOMING_PURCHASE_PRICE_EXCEEDED').toBe('WH-INCOMING_PURCHASE_PRICE_EXCEEDED');
      expect(result.message, `[Expected 5] The message is ${EXCEEDED}`).toBe(EXCEEDED);
    });

    let total = 0;
    await step('Act: Step 6 — Count the inbound requests created by the 7 uploads', async () => {
      total = (await incomingCountOfSkus([sku])) - start;
      await record('Requests created per workbook', Object.fromEntries(Object.entries(outcomes).map(([label, o]) => [label, { status: o.result.status, created: o.created }])));
    });

    await step('Assert: Expected 6 — Exactly 2 requests are created, by the 0 and the 99,999,999 workbooks', async () => {
      expect(total, '[Expected 6] Exactly 2 requests are created').toBe(2);
      for (const label of ['blank-G', 'blank-T', 'blank-E', 'price-minus1', 'price-100000000']) expect(outcomes[label].created, `[Expected 6] The rejected ${label} workbook created none`).toBe(0);
    });
  });

  test('TC_US134_342 — A duplicate SKU inside one inbound group rejects the whole workbook', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_342',
      'High',
      TAGS,
      `SKU-A twice with the same 입고유형 / 출고지 ID / 제조사 ID / 입고 요청일 (one group) plus a valid row of SKU-B in another group (T): the whole workbook is refused with WH-INCOMING_DUPLICATED "SKU가 중복된 입고 요청입니다. 중복된 SKU ID - {skuIds}" listing SKU IDs (not codes) and no row — as-is behaviour — and no group is created. ${STATUS_NOTE} ${DATE_NOTE} ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    let skus: WorldSku[] = [];
    let before = 0;
    let result!: UploadResult;

    await step('Arrange: Pre-condition 1–3 — SKU-A twice in one group, another valid row; the inbound count is known', async () => {
      skus = await ownSkus(world, 'U342', 2);
      before = await incomingCountOfSkus(skus);
      await list.open('ko');
    });

    await step('Act: Step 1 — Upload the workbook through 입고 요청 업로드 (Upload inbound request)', async () => {
      result = await uploads.upload('incoming', inboundWorkbook('inbound-tc342.xlsx', [
        inboundRow(world, skus[0], { memo: 'TC342 first' }),
        inboundRow(world, skus[0], { memo: 'TC342 second' }),
        inboundRow(world, skus[1], { type: 'T' }),
      ]));
    });

    await step('Assert: Expected 1 — The WHOLE WORKBOOK is rejected', async () => {
      expect(result.status, `[Expected 1] The workbook is rejected (${brief(result)})`).toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 2 — Read the server code and the message', async () => {
      await expect(list.toasts.last(), 'A message appears').toBeVisible({ timeout: 30_000 });
    });

    await step('Assert: Expected 2 — WH-INCOMING_DUPLICATED: SKU가 중복된 입고 요청입니다. 중복된 SKU ID - {skuIds}', async () => {
      expect(result.code, '[Expected 2] The code is WH-INCOMING_DUPLICATED').toBe('WH-INCOMING_DUPLICATED');
      expect(result.message, '[Expected 2] The message has the duplicate-SKU shape').toMatch(/^SKU가 중복된 입고 요청입니다\. 중복된 SKU ID - .+$/);
      await expect(uploads.toast(result.message || '<no message>').last(), '[Expected 2] The screen shows the message').toBeVisible();
    });

    await step('Act: Step 3 — Read the rows and identifiers the message names', async () => {
      await record('Duplicate answer', { code: result.code, message: result.message, skuId: skus[0].skuId, skuCode: skus[0].skuCode });
    });

    await step('Assert: Expected 3 — The message lists SKU IDs, not the SKU codes in the file, and names no row', async () => {
      expect(result.message, `[Expected 3] The message lists SKU ID ${skus[0].skuId}`).toContain(String(skus[0].skuId));
      expect(result.message, `[Expected 3] The message does not list the SKU code ${skus[0].skuCode}`).not.toContain(skus[0].skuCode);
      expect(rowOf(result.message), '[Expected 3] The message names no row').toBeNull();
    });

    let after = 0;
    await step('Act: Step 4 — Check whether any group in the workbook was created', async () => {
      after = await incomingCountOfSkus(skus);
    });

    await step('Assert: Expected 4 — No receipt is created for any group; the inbound-record count is unchanged', async () => {
      expect(after, '[Expected 4] The inbound-record count is unchanged').toBe(before);
      expect((await incomingLinesOfSkus([skus[1]])).length, '[Expected 4] The other group (SKU-B) is not created either').toBe(0);
    });
  });

  test('TC_US134_343 — A failed upload shows the original server message, re-queries the list and keeps the selection', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const third = world.warehouses.DAEGU ? world.sku('SKU0003') : world.sku('SKU0002');
    await tcMeta(
      'TC_US134_343',
      'High',
      TAGS,
      `With DEMO-SKU-0001 and DEMO-SKU-${third.key.slice(3)} ticked, a workbook whose row 2 names a missing SKU code (DEMO-SKU-9999 played by a never-created code) is refused; the alert shows the server message "{n}행의 SKU 코드를 찾을 수 없습니다. - skuCode: …" (row 2) exactly — the code WH-SKU_CODE_NOT_FOUND travels in the response body, the screen prints only the message — and not the generic ${t('msg.uploadFailed')}; exactly one list re-query follows (waited up to 10 s); the rows stay ticked, nothing is created and no per-row report is shown. Deviation TC ≠ UI: the bundle reloads the list only after a successful upload (handler: upload → toast → reload, the catch branch only raises the alert) and the run of 2026-10-06 saw no re-query within 10 s, so Expected 3 is kept as a soft assertion and fails until the BA/dev align. The alert is read as soon as it appears (the toast hides itself after 5 s). ${world.warehouses.DAEGU ? '' : 'DEMO-SKU-0003 has no stock row because CJ Daegu warehouse is not available, so DEMO-SKU-0002 is ticked instead.'} ${ROW_NOTE} ${STATUS_NOTE} ${OWN_NOTE}`,
    );
    const uploads = new StockUploadPage(page, list);
    const paging = new StockListPagingPage(page, list);
    const first = world.sku('SKU0001');
    let sku!: WorldSku;
    let missing = '';
    let result!: UploadResult;

    await step(`Arrange: Pre-condition 1–4 — DEMO-SKU-0001 and DEMO-SKU-${third.key.slice(3)} ticked, a workbook with an unknown SKU code on row 2`, async () => {
      [sku] = await ownSkus(world, 'U343', 1);
      missing = uniqueCode(world.tag, 'NOSKU');
      await list.open('ko');
      await list.search('SKU_GROUP_NAME', world.keyword);
      await list.choosePageSize(20);
      await list.tick(list.row(first.skuCode), first.skuCode);
      await list.tick(list.row(third.skuCode), third.skuCode);
    });

    let requery: URL[] = [];
    let alert = '';
    await step('Act: Step 1 — Upload the invalid workbook', async () => {
      requery = await paging.listRequestsDuring(async () => {
        result = await uploads.upload('incoming', inboundWorkbook('inbound-tc343.xlsx', [inboundRow(world, sku, { skuCode: missing }), inboundRow(world, sku, { type: 'T' })]));
        await expect(list.toasts.last(), 'An alert appears (read at once — the toast hides itself after 5 s)').toBeVisible({ timeout: 30_000 });
        alert = (await list.toasts.last().innerText()).trim();
        await page.waitForRequest((request) => request.method() === 'GET' && /\/api\/v1\/stock-status\?/.test(request.url()), { timeout: 10_000 }).catch(() => null);
      });
    });

    await step('Assert: Expected 1 — The upload is rejected', async () => {
      expect(result.status, `[Expected 1] The upload is rejected (${brief(result)})`).toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 2 — Compare the UI alert with the server response message', async () => {
      await record('UI alert and server message', { alert, server: { status: result.status, code: result.code, message: result.message } });
    });

    await step('Assert: Expected 2 — The alert shows the server message for row 2 exactly, not a generic client error', async () => {
      expect(result.code, '[Expected 2] The server code is WH-SKU_CODE_NOT_FOUND').toBe('WH-SKU_CODE_NOT_FOUND');
      expect(result.message, '[Expected 2] The server message names row 2 and the missing code').toBe(`2행의 SKU 코드를 찾을 수 없습니다. - skuCode: ${missing}`);
      expect(alert, '[Expected 2] The alert shows the server message as returned').toContain(result.message || '<no message>');
      expect(alert, `[Expected 2] The alert is not the generic ${t('msg.uploadFailed')}`).not.toContain(t('msg.uploadFailed'));
    });

    await step('Act: Step 3 — Read the network calls after the upload finishes', async () => {
      await record('List calls after the failed upload', requery.map((url) => url.toString()));
    });

    await step('Assert: Expected 3 — The stock list sends exactly one re-query after the failed upload call completes', async () => {
      expect.soft(requery.length, '[Expected 3] Exactly one list re-query (GET /stock-status) follows the failed upload').toBe(1);
    });

    let created = -1;
    await step('Act: Step 4 — Read the selected stock rows and the inbound count', async () => {
      created = await incomingCountOfSkus([sku]);
    });

    await step('Assert: Expected 4 — Rows stay selected, no inbound request is created, no per-row report is shown', async () => {
      await expect(list.checkbox(list.row(first.skuCode)), '[Expected 4] DEMO-SKU-0001 remains selected').toBeChecked();
      await expect(list.checkbox(list.row(third.skuCode)), `[Expected 4] DEMO-SKU-${third.key.slice(3)} remains selected`).toBeChecked();
      expect(created, '[Expected 4] No inbound request is created').toBe(0);
      await expect(uploads.openModals, '[Expected 4] No per-row success/failure report is shown').toHaveCount(0);
    });
  });
});
