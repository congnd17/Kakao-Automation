import type { Request } from '@playwright/test';
import { test, expect } from '@fixtures/stock.fixture';
import type { StockApi } from '@api/stock.api';
import { makeStep } from '@utils/step';
import { skipTc, tcMeta } from '@utils/tc-meta';
import { stx, StockTextKey } from '@utils/stock.i18n';
import { stockTags } from '@utils/stock-spec';
import { uniqueCode, type StockWorld } from '@utils/stock.data';
import { XLSX_MIME } from '@utils/xlsx-writer';
import { MultipartFilePart, UPLOAD_PATHS, UploadResult, buildXls, parseConvert, parseRequired, rawFile, watchMultipartFiles } from '@pages/stock-upload.page';
import {
  EMPTY_EXCEL,
  INVALID_EXCEL,
  MISSING_HEADER,
  SKU_UPLOAD_DONE,
  SKU_UPLOAD_PATH,
  SkuUploadPage,
  SkuUploadSchema,
  XLSX_ONLY,
  XLS_MIME,
  codesOf,
  columnOf,
  fieldOf,
  groupSkus,
  headerOf,
  isSkuListQuery,
  isSkuUpload,
  masterTotal,
  numericHeader,
  requireHeader,
  skuRow,
  skuRows,
  skuUploadSchema,
  skuWorkbook,
  skusByCode,
  skusWithPrefix,
} from '@pages/stock-sku-upload.page';

/**
 * US134 — nhóm [SKU Creation Upload] (TC_US134_388–412): nút SKU 생성 업로드 trên màn SKU master
 * (`/commerce/product-stock/sku-master/physical`) — địa chỉ upload, toast + list tự tải lại, hộp chọn file OS, gửi ngay,
 * không xác nhận, không template, message server, .xls / file hỏng / rỗng / chỉ tiêu đề, thiếu cột, ô bắt buộc trống,
 * ô không chuyển kiểu được, 수출용 SKU명 > 150, 상품코드 đã có (nối nhóm) / của partner khác, SKU 코드 / SKU명 lưu đúng,
 * tìm được, cả workbook 1 transaction, fail-fast. Mọi mã trong workbook sinh từ tag run; mọi 상품코드 được
 * `world.trackGroupCode()` trước khi upload để teardown xoá mềm.
 */
const TAGS = stockTags('sku-upload');
const t = (key: StockTextKey) => stx(key, 'ko');
const HEADER_NOTE =
  "Workbook: the 20 SKU-creation headers are not published (SRS, bundle) and the build offers no template, so the suite asks the server itself once per run — it uploads header-only workbooks (no data row, nothing is created) and adds each column the server names in 엑셀에 '{column}' 항목이 존재하지 않습니다. until the header is accepted; the header list used is attached to the report. Cell values are chosen from the column name: biz partner and manufacturer by id (Demo Partner A / Demo Manufacturer 1 unless stated), 유형 PHYSICAL, 구성유형 SINGLE, 원산지 국가 KR, 원가(원) 12000, 무게(g) 250, 너비/길이/높이(mm) 100/80/30, optional 자재코드 / BOM 구성 left empty; every product code, SKU code and barcode carries the run tag and is removed by the teardown.";
const ROW_NOTE = 'Row numbers are Excel sheet rows as the user sees them (row 1 = the header row, row 2 = the first data row); column numbers count from 1 (A = 1).';
const COUNT_NOTE = 'The SKU master row count is read through the list API (total of the physical SKU master list) and, for workbook rows, by looking up every SKU code the workbook carries — the dev environment is shared, so the codes are the exact proof.';

/** Đính kèm điều ghi nhận được (TC "record the code and string returned"). */
async function record(name: string, value: unknown): Promise<void> {
  await test.info().attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
}

function brief(result: UploadResult | null | undefined): string {
  return result ? `HTTP ${result.status} ${result.code} ${result.message}`.slice(0, 300) : 'no upload';
}

/** Bộ tiêu đề server đòi (đính kèm làm bằng chứng). */
async function headerSchema(stockApi: StockApi): Promise<SkuUploadSchema> {
  const schema = await skuUploadSchema(stockApi);
  await record('SKU-creation workbook header used (asked from the server)', {
    count: schema.headers.length,
    headers: schema.headers.map((header) => ({ header, meaning: fieldOf(header) ?? 'left empty' })),
    probes: schema.probes,
  });
  return schema;
}

/** 상품코드 mới cho test, được theo dõi để teardown dọn (gọi trước khi upload). */
async function newGroupCode(world: StockWorld, label: string): Promise<string> {
  const code = uniqueCode(world.tag, label);
  await world.trackGroupCode(code);
  return code;
}

/** Số SKU code của danh sách đang tồn tại (tra từng mã). */
async function existingCodes(stockApi: StockApi, codes: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const code of codes) if ((await skusByCode(stockApi, code)).length > 0) found.push(code);
  return found;
}

test.describe('[SKU Creation Upload] SKU master — the SKU 생성 업로드 button', () => {
  test('TC_US134_388 — The upload button sends the file to the SKU-creation upload address', async ({ page, world, stockApi, skuMasterPage: master }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_388',
      'Medium',
      TAGS,
      `SKU 생성 업로드 is shown on the SKU master list (physical); picking a valid SKU-creation workbook (with 수출용 SKU명) sends one multipart POST to ${SKU_UPLOAD_PATH} and never to the inbound-request (${UPLOAD_PATHS.incoming}) or adjustment (${UPLOAD_PATHS.adjustment}) upload address. SKU 마스터 관리 has no sidebar entry on dev, so the list is opened by its route. ${HEADER_NOTE}`,
    );
    const uploads = new SkuUploadPage(page, master);
    let file!: ReturnType<typeof skuWorkbook>;
    let calls: Request[] = [];
    let result!: UploadResult;

    await step('Arrange: Pre-condition 1–3 — Logged in with write access, a valid SKU-creation workbook with 수출용 SKU명 is ready, network calls are recorded', async () => {
      const schema = await headerSchema(stockApi);
      expect.soft(headerOf(schema, 'exportSkuName'), 'Pre-condition 2 — the workbook carries a 수출용 SKU명 (Export SKU name) column').toBeDefined();
      const groupCode = await newGroupCode(world, 'P388');
      file = skuWorkbook(`sku-${groupCode}.xlsx`, schema, skuRows(world, groupCode, 'S388', 1));
    });

    await step('Act: Step 1 — Open SKU 마스터 관리 (SKU master management)', async () => {
      await master.open('physical', 'ko');
    });

    await step('Assert: Expected 1 — The SKU creation upload button is available in the SKU Master area', async () => {
      await expect(master.uploadButton, '[Expected 1] SKU 생성 업로드 (Upload SKU creation) is displayed').toBeVisible();
      await expect(master.uploadButton, `[Expected 1] The button reads ${t('master.btn.uploadSkuExcel')}`).toHaveText(new RegExp(`${t('master.btn.uploadSkuExcel')}\\s*$`));
      await expect(master.uploadButton, '[Expected 1] The button is enabled').toBeEnabled();
    });

    let parts: MultipartFilePart[] = [];
    await step('Act: Step 2 — Click SKU 생성 업로드 (Upload SKU creation) and pick the workbook', async () => {
      const readParts = await watchMultipartFiles(page);
      calls = await uploads.requestsDuring(async () => {
        result = await uploads.upload(file);
      });
      parts = await readParts();
    });

    await step('Assert: Expected 2 — The file is sent to the SKU-creation upload address', async () => {
      const posts = calls.filter((call) => isSkuUpload(call));
      expect(posts.length, `[Expected 2] Exactly one POST ${SKU_UPLOAD_PATH} is sent`).toBe(1);
      expect(posts[0]?.headers()['content-type'] ?? '', '[Expected 2] The call carries the file as multipart/form-data').toContain('multipart/form-data');
      expect(parts.map((part) => `${part.field}=${part.name}`), `[Expected 2] The multipart body carries ${file.name} in the field "file"`).toContain(`file=${file.name}`);
      expect(result.status, `[Expected 2] The SKU-creation upload answers (${brief(result)})`).toBeLessThan(300);
    });

    let paths: string[] = [];
    await step('Act: Step 3 — Read the call address of every upload call sent', async () => {
      paths = calls.filter((call) => call.method() === 'POST').map((call) => new URL(call.url()).pathname);
    });

    await step('Assert: Expected 3 — The call does not use the inbound-request or adjustment-upload address', async () => {
      expect(paths, `[Expected 3] No call goes to the inbound-request upload ${UPLOAD_PATHS.incoming}`).not.toContain(UPLOAD_PATHS.incoming);
      expect(paths, `[Expected 3] No call goes to the adjustment upload ${UPLOAD_PATHS.adjustment}`).not.toContain(UPLOAD_PATHS.adjustment);
      expect(paths, `[Expected 3] The upload address used is ${SKU_UPLOAD_PATH}`).toContain(SKU_UPLOAD_PATH);
    });
  });

  test('TC_US134_389 — A successful upload shows the completion message and re-queries the list once', async ({ page, world, stockApi, skuMasterPage: master }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_389',
      'High',
      TAGS,
      `After a valid SKU-creation workbook is uploaded from the SKU master list, the toast reads "${SKU_UPLOAD_DONE}", the list sends exactly one GET /api/v1/skus re-query after the upload call, and the new SKUs show in the refreshed list. The list is first filtered on SKU코드 = the test's code prefix so the new rows are on page 1 of the shared list (the re-query keeps the search). ${HEADER_NOTE}`,
    );
    const uploads = new SkuUploadPage(page, master);
    let file!: ReturnType<typeof skuWorkbook>;
    let codes: string[] = [];
    let prefix = '';

    await step('Arrange: Pre-condition 1–3 — Logged in with write access, a valid SKU-creation workbook is ready, network calls are recorded', async () => {
      const schema = await headerSchema(stockApi);
      const groupCode = await newGroupCode(world, 'P389');
      prefix = `${world.tag}S389`;
      const rows = skuRows(world, groupCode, 'S389', 2);
      codes = codesOf(rows);
      file = skuWorkbook(`sku-${groupCode}.xlsx`, schema, rows);
    });

    await step('Act: Step 1 — Open the SKU master list through SKU 마스터 관리 (SKU master management)', async () => {
      await master.open('physical', 'ko');
      await master.search('SKU_CODE', prefix);
    });

    await step('Assert: Expected 1 — The SKU master list opens', async () => {
      await expect(master.table, '[Expected 1] The SKU master table is shown').toBeVisible();
      await expect(master.table.getByRole('columnheader', { name: t('col.skuCode'), exact: true }), '[Expected 1] The SKU master columns are shown').toBeVisible();
    });

    let calls: Request[] = [];
    let result!: UploadResult;
    await step('Act: Step 2 — Upload the SKU-creation workbook through SKU 생성 업로드 (Upload SKU creation)', async () => {
      calls = await uploads.requestsDuring(async () => {
        result = await uploads.uploadAndReload(file);
        if (result.status < 300) await expect(uploads.rowsWithPrefix(prefix), 'The refreshed list shows the new rows').toHaveCount(codes.length, { timeout: 30_000 });
      });
    });

    await step('Assert: Expected 2 — The upload finishes', async () => {
      expect(result.status, `[Expected 2] The upload is processed (${brief(result)})`).toBeLessThan(300);
    });

    let message = '';
    await step('Act: Step 3 — Read the message that appears', async () => {
      const toast = uploads.toast(SKU_UPLOAD_DONE).last();
      await expect(toast, 'A message appears').toBeVisible({ timeout: 30_000 });
      message = ((await uploads.toastMessage(toast).textContent()) ?? '').trim();
    });

    await step('Assert: Expected 3 — The message shows SKU 생성 업로드가 완료되었습니다.', async () => {
      expect(message, `[Expected 3] The message reads "${SKU_UPLOAD_DONE}"`).toBe(SKU_UPLOAD_DONE);
    });

    let reQueries: Request[] = [];
    await step('Act: Step 4 — Read the calls sent after the upload and the refreshed list', async () => {
      const uploadIndex = calls.findIndex((call) => isSkuUpload(call));
      reQueries = calls.slice(uploadIndex + 1).filter((call) => isSkuListQuery(call));
    });

    await step('Assert: Expected 4 — Exactly 1 list re-query call is sent and the newly created SKUs appear in the refreshed list', async () => {
      expect(reQueries.length, '[Expected 4] Exactly 1 GET /api/v1/skus re-query is sent after the upload').toBe(1);
      for (const code of codes) await expect(master.row(code), `[Expected 4] The new SKU ${code} appears in the refreshed list`).toBeVisible();
    });
  });

  test('TC_US134_390 — The upload button opens the operating system file picker offering .xlsx and .xls', async ({ page, skuMasterPage: master }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_390',
      'Medium',
      TAGS,
      'SKU 생성 업로드 is present and enabled on the SKU master list for the automation account (bypass account holding every permission, so "write permission on the stock code" cannot be narrowed); clicking it raises the operating-system file picker (Playwright filechooser event) with no in-app modal first, and the hidden input accepts .xlsx and .xls. No file is chosen.',
    );
    const uploads = new SkuUploadPage(page, master);

    await step('Arrange: Pre-condition 1–2 — Logged in with write access, the SKU master list is open', async () => {
      await master.open('physical', 'ko');
    });

    await step('Act: Step 1 — Find SKU 생성 업로드 (Upload SKU creation) in the SKU master area', async () => {
      await master.uploadButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — The button is present and enabled', async () => {
      await expect(master.uploadButton, '[Expected 1] SKU 생성 업로드 is present').toBeVisible();
      await expect(master.uploadButton, '[Expected 1] SKU 생성 업로드 is enabled').toBeEnabled();
      await expect(master.uploadButton, '[Expected 1] SKU 생성 업로드 is not marked disabled').not.toHaveClass(/\bdisabled\b/);
    });

    let chooser!: Awaited<ReturnType<SkuUploadPage['openChooser']>>;
    let modals = -1;
    await step('Act: Step 2 — Click it', async () => {
      chooser = await uploads.openChooser();
      modals = await uploads.openModals.count();
    });

    await step('Assert: Expected 2 — The operating system file picker opens; no in-app modal opens first', async () => {
      expect(chooser, '[Expected 2] The operating system file picker opens').toBeTruthy();
      expect(modals, '[Expected 2] No in-app modal opens').toBe(0);
    });

    let accept = '';
    let input = { insideButton: false, width: -1, height: -1 };
    await step('Act: Step 3 — Read what opens and which file types are offered', async () => {
      accept = (await chooser.element().getAttribute('accept')) ?? '';
      input = await chooser.element().evaluate((el: HTMLInputElement) => {
        const box = el.getBoundingClientRect();
        return { insideButton: !!el.closest('label[role="button"]'), width: box.width, height: box.height };
      });
    });

    await step('Assert: Expected 3 — The picker offers .xlsx and .xls from the hidden input accept attribute', async () => {
      const types = accept.split(',').map((type) => type.trim());
      expect(types, '[Expected 3] The picker offers .xlsx').toContain('.xlsx');
      expect(types, '[Expected 3] The picker offers .xls').toContain('.xls');
      expect(input.insideButton, '[Expected 3] The file input sits inside the SKU 생성 업로드 button').toBe(true);
      expect(Math.max(input.width, input.height), '[Expected 3] The file input is hidden (visually-hidden, at most 1 px)').toBeLessThanOrEqual(1);
    });
  });

  test('TC_US134_391 — The chosen file uploads immediately with no further click', async ({ page, world, stockApi, skuMasterPage: master }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_391',
      'Medium',
      TAGS,
      `Choosing a valid SKU-creation workbook in the file picker sends POST ${SKU_UPLOAD_PATH} at once (within 10 s, no click in between) and no Upload / Confirm control has to be pressed. ${HEADER_NOTE}`,
    );
    const uploads = new SkuUploadPage(page, master);
    let file!: ReturnType<typeof skuWorkbook>;

    await step('Arrange: Pre-condition 1–3 — Logged in with write access, a valid SKU-creation workbook is ready, network calls are recorded', async () => {
      const schema = await headerSchema(stockApi);
      const groupCode = await newGroupCode(world, 'P391');
      file = skuWorkbook(`sku-${groupCode}.xlsx`, schema, skuRows(world, groupCode, 'S391', 1));
      await master.open('physical', 'ko');
    });

    let result!: UploadResult;
    let pickedAt = 0;
    let sentAt = 0;
    await step('Act: Step 1 — Click SKU 생성 업로드 (Upload SKU creation) and choose the file', async () => {
      const chooser = await uploads.openChooser();
      const sent = page.waitForRequest((request) => isSkuUpload(request), { timeout: 10_000 }).then(() => Date.now());
      pickedAt = Date.now();
      result = await uploads.pick(chooser, file);
      sentAt = await sent;
    });

    await step('Assert: Expected 1 — The picker closes and the file is accepted', async () => {
      expect(result.status, `[Expected 1] The file is accepted (${brief(result)})`).toBeLessThan(300);
    });

    await step('Act: Step 2 — Watch the network at the moment the picker closes', async () => {
      await uploads.toast(SKU_UPLOAD_DONE).last().waitFor({ state: 'visible', timeout: 30_000 });
    });

    await step('Assert: Expected 2 — The upload call is sent immediately on selection, with no further interaction', async () => {
      expect(sentAt, '[Expected 2] The upload call is sent right after the file is chosen').toBeGreaterThan(0);
      expect(sentAt - pickedAt, '[Expected 2] The call leaves within 10 s of choosing the file').toBeLessThan(10_000);
    });

    let modals = -1;
    let confirmButtons = -1;
    await step('Act: Step 3 — Look for any Upload or Confirm control that has to be pressed before the call', async () => {
      modals = await uploads.openModals.count();
      confirmButtons = await page.locator('.modal.show').getByRole('button', { name: /업로드|확인|Upload|Confirm/ }).count();
    });

    await step('Assert: Expected 3 — There is no second control to press', async () => {
      expect(modals, '[Expected 3] No upload / confirmation modal is open').toBe(0);
      expect(confirmButtons, '[Expected 3] No Upload / Confirm button is offered').toBe(0);
    });
  });

  test('TC_US134_392 — No confirmation dialogue opens before the upload; the alert comes after the call', async ({ page, world, stockApi, skuMasterPage: master }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_392',
      'Medium',
      TAGS,
      `Between choosing the SKU-creation workbook and the moment POST ${SKU_UPLOAD_PATH} leaves the browser, no modal and no browser confirm dialog appears (the screen is read the instant the request is seen); the completion toast appears only after the call. ${HEADER_NOTE}`,
    );
    const uploads = new SkuUploadPage(page, master);
    let dialogs = 0;
    page.on('dialog', () => {
      dialogs += 1;
    });
    let file!: ReturnType<typeof skuWorkbook>;

    await step('Arrange: Pre-condition 1–2 — Logged in with write access, a valid SKU-creation workbook is ready', async () => {
      const schema = await headerSchema(stockApi);
      const groupCode = await newGroupCode(world, 'P392');
      file = skuWorkbook(`sku-${groupCode}.xlsx`, schema, skuRows(world, groupCode, 'S392', 1));
      await master.open('physical', 'ko');
    });

    let result!: UploadResult;
    let atCall = { modals: -1, toasts: -1, dialogs: -1 };
    await step('Act: Step 1 — Click SKU 생성 업로드 (Upload SKU creation) and choose the file', async () => {
      const chooser = await uploads.openChooser();
      const seen = page.waitForRequest((request) => isSkuUpload(request), { timeout: 10_000 }).then(async () => {
        atCall = { modals: await uploads.openModals.count(), toasts: await uploads.toast(SKU_UPLOAD_DONE).count(), dialogs };
      });
      result = await uploads.pick(chooser, file);
      await seen;
    });

    await step('Assert: Expected 1 — The file is accepted and sent', async () => {
      expect(result.status, `[Expected 1] The file is accepted and sent (${brief(result)})`).toBeLessThan(300);
    });

    await step('Act: Step 2 — Look for any dialogue asking to confirm, or naming a destination or a format', async () => {
      await expect(uploads.openModals, 'The screen is read for dialogues').toHaveCount(atCall.modals);
    });

    await step('Assert: Expected 2 — No confirmation dialogue opens before the call', async () => {
      expect(atCall.modals, '[Expected 2] No modal is open when the call leaves the browser').toBe(0);
      expect(atCall.dialogs, '[Expected 2] No browser confirm dialog appeared before the call').toBe(0);
    });

    await step('Act: Step 3 — Let the call finish and read what appears afterwards', async () => {
      await uploads.toast(SKU_UPLOAD_DONE).last().waitFor({ state: 'visible', timeout: 30_000 });
    });

    await step('Assert: Expected 3 — An alert appears AFTER the call', async () => {
      expect(atCall.toasts, '[Expected 3] No alert was shown before the call').toBe(0);
      await expect(uploads.toast(SKU_UPLOAD_DONE).last(), `[Expected 3] The alert "${SKU_UPLOAD_DONE}" appears after the call`).toBeVisible();
      expect(dialogs, '[Expected 3] The alert is the in-app toast, not a browser dialog').toBe(0);
    });
  });

  test('TC_US134_393 — No Download Template action exists for the SKU creation upload', async ({ page, skuMasterPage: master }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_393',
      'Medium',
      TAGS,
      'The SKU master toolbar and the SKU 생성 업로드 flow offer no Download Template button or link (no control named 템플릿 / 양식 / Template), and no template or upload endpoint is called from opening the list to the file picker opening.',
    );
    const uploads = new SkuUploadPage(page, master);
    const templateName = /템플릿|양식|서식|template/i;
    const calls: Request[] = [];

    await step('Arrange: Pre-condition 1–2 — Logged in with write access, network calls are recorded', async () => {
      page.on('request', (request) => {
        if (request.url().includes('/api/')) calls.push(request);
      });
    });

    await step('Act: Step 1 — Open SKU 마스터 관리 (SKU master management)', async () => {
      await master.open('physical', 'ko');
    });

    await step('Assert: Expected 1 — The SKU master list opens', async () => {
      await expect(master.table, '[Expected 1] The SKU master table is shown').toBeVisible();
    });

    let chooserOpened = false;
    let callsBeforeFile: string[] = [];
    await step('Act: Step 2 — Inspect the toolbar and the whole SKU 생성 업로드 (Upload SKU creation) flow', async () => {
      const chooser = await uploads.openChooser();
      chooserOpened = !!chooser;
      callsBeforeFile = calls.map((call) => `${call.method()} ${new URL(call.url()).pathname}`);
    });

    await step('Assert: Expected 2 — The toolbar and the SKU creation upload flow carry no Download Template action', async () => {
      await expect(master.card.getByRole('button', { name: templateName }), '[Expected 2] No template button in the SKU master card').toHaveCount(0);
      await expect(master.card.getByRole('link', { name: templateName }), '[Expected 2] No template link in the SKU master card').toHaveCount(0);
      await expect(uploads.openModals, '[Expected 2] The upload flow opens no dialog offering a template').toHaveCount(0);
    });

    await step('Act: Step 3 — Look for a Download Template button or link beside SKU 생성 업로드', async () => {
      await master.uploadButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — No Download Template button or link is found beside SKU 생성 업로드', async () => {
      const toolbar = master.uploadButton.locator('..');
      await expect(toolbar.getByRole('button', { name: templateName }), '[Expected 3] No template button beside SKU 생성 업로드').toHaveCount(0);
      await expect(toolbar.getByRole('link', { name: templateName }), '[Expected 3] No template link beside SKU 생성 업로드').toHaveCount(0);
      await expect(master.card.getByText(templateName), '[Expected 3] No template wording anywhere in the SKU master area').toHaveCount(0);
    });

    await step('Act: Step 4 — Read the network calls made before a file is chosen', async () => {
      await record('API calls before a file is chosen', callsBeforeFile);
    });

    await step('Assert: Expected 4 — No template-download endpoint is called before a file is chosen; only the file picker opens', async () => {
      expect(callsBeforeFile.filter((call) => /template/i.test(call)), '[Expected 4] No template-download endpoint is called').toEqual([]);
      expect(callsBeforeFile.filter((call) => call.includes(SKU_UPLOAD_PATH)), '[Expected 4] No upload call is sent before a file is chosen').toEqual([]);
      expect(chooserOpened, '[Expected 4] Only the file picker opens').toBe(true);
    });
  });

  test('TC_US134_394 — A rejected upload shows the server message verbatim and creates nothing', async ({ page, world, stockApi, skuMasterPage: master }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_394',
      'High',
      TAGS,
      `A SKU-creation workbook whose header row is one column short (the SKU code column removed) is rejected; the danger toast shows the server's response message character for character (not the front-end fallback "${t('msg.uploadFailed')}"), and none of its SKU codes exists afterwards. ${HEADER_NOTE} ${COUNT_NOTE}`,
    );
    const uploads = new SkuUploadPage(page, master);
    let file!: ReturnType<typeof skuWorkbook>;
    let codes: string[] = [];
    let totalBefore = 0;

    await step('Arrange: Pre-condition 1–3 — Logged in with write access, a workbook short a header column is ready, the SKU master count is known', async () => {
      const schema = await headerSchema(stockApi);
      const groupCode = await newGroupCode(world, 'P394');
      const rows = skuRows(world, groupCode, 'S394', 2);
      codes = codesOf(rows);
      file = skuWorkbook(`sku-short-${groupCode}.xlsx`, schema, rows, { omit: [requireHeader(schema, 'skuCode', 'SKU code')] });
      totalBefore = await masterTotal(stockApi);
      await master.open('physical', 'ko');
    });

    let result!: UploadResult;
    await step('Act: Step 1 — Upload the failing workbook through SKU 생성 업로드 (Upload SKU creation)', async () => {
      result = await uploads.upload(file);
      await record('Server answer', result.body);
    });

    await step('Assert: Expected 1 — The upload is rejected', async () => {
      expect(result.status, `[Expected 1] The upload is rejected (${brief(result)})`).toBeGreaterThanOrEqual(400);
    });

    let shown = '';
    await step('Act: Step 2 — Read the message that appears and compare it with the server response', async () => {
      const toast = master.toasts.last();
      await expect(toast, 'A message appears').toBeVisible({ timeout: 30_000 });
      shown = ((await uploads.toastMessage(toast).textContent()) ?? '').trim();
    });

    await step("Assert: Expected 2 — The alert shows the SERVER's message verbatim", async () => {
      expect(result.message, '[Expected 2] The server response carries a message').not.toBe('');
      expect(shown, '[Expected 2] The alert shows the server message character for character').toBe(result.message);
      expect(shown, '[Expected 2] The alert is not the front-end fallback wording').not.toBe(t('msg.uploadFailed'));
    });

    let created: string[] = [];
    let totalAfter = 0;
    await step('Act: Step 3 — Check whether any SKU was created', async () => {
      created = await existingCodes(stockApi, codes);
      totalAfter = await masterTotal(stockApi);
    });

    await step('Assert: Expected 3 — No SKU is created', async () => {
      expect(created, '[Expected 3] None of the workbook SKU codes exists').toEqual([]);
      expect(totalAfter, '[Expected 3] The SKU master row count is unchanged').toBe(totalBefore);
    });
  });

  test('TC_US134_395 — SKIPPED — The row selection survives the upload', async () => {
    await skipTc(
      'TC_US134_395',
      'Medium',
      TAGS,
      'The rule that an upload keeps the row selection was written for 재고 관리 (Stock management), which no longer hosts SKU 생성 업로드.',
      'SKIPPED in the TC file — the SKU master list has no selection column (2.12 component 149), so there is no row to tick and no executable step until the BA answers the open question on row selection (SPEC-GAP).',
    );
  });

  test('TC_US134_396 — The picker offers .xls while the server takes only .xlsx', async ({ page, world, stockApi, skuMasterPage: master }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_396',
      'Medium',
      TAGS,
      `The SKU 생성 업로드 picker accepts .xlsx and .xls; a genuine .xls (BIFF8 in an OLE2 compound file, built by the suite) is sent and refused with "${XLSX_ONLY}" (AS-IS source defect, the rejection is the expected result), creating nothing; then a valid .xlsx workbook is accepted and its SKUs exist. ${HEADER_NOTE} ${COUNT_NOTE}`,
    );
    const uploads = new SkuUploadPage(page, master);
    const xls = rawFile('sku-legacy.xls', buildXls(), XLS_MIME);
    let file!: ReturnType<typeof skuWorkbook>;
    let codes: string[] = [];
    let totalBefore = 0;

    await step('Arrange: Pre-condition 1–2 — Logged in with write access, a genuine .xls file and a valid .xlsx SKU-creation workbook are ready', async () => {
      const schema = await headerSchema(stockApi);
      const groupCode = await newGroupCode(world, 'P396');
      const rows = skuRows(world, groupCode, 'S396', 2);
      codes = codesOf(rows);
      file = skuWorkbook(`sku-${groupCode}.xlsx`, schema, rows);
      totalBefore = await masterTotal(stockApi);
      await master.open('physical', 'ko');
    });

    let chooser!: Awaited<ReturnType<SkuUploadPage['openChooser']>>;
    let types: string[] = [];
    await step('Act: Step 1 — Click SKU 생성 업로드 (Upload SKU creation) and read the file types offered', async () => {
      chooser = await uploads.openChooser();
      types = ((await chooser.element().getAttribute('accept')) ?? '').split(',').map((type) => type.trim());
    });

    await step('Assert: Expected 1 — The picker offers BOTH .xlsx and .xls', async () => {
      expect(types, '[Expected 1] The picker offers .xlsx').toContain('.xlsx');
      expect(types, '[Expected 1] The picker offers .xls').toContain('.xls');
    });

    let xlsResult!: UploadResult;
    let shown = '';
    await step('Act: Step 2 — Choose the .xls file and read the message', async () => {
      xlsResult = await uploads.pick(chooser, xls);
      const toast = master.toasts.last();
      await expect(toast, 'A message appears').toBeVisible({ timeout: 30_000 });
      shown = ((await uploads.toastMessage(toast).textContent()) ?? '').trim();
    });

    await step('Assert: Expected 2 — The file is sent and the server rejects it with xlsx 형식의 엑셀 파일만 업로드 가능합니다.', async () => {
      expect(xlsResult.url, '[Expected 2] The .xls file is sent to the SKU-creation upload').toContain(SKU_UPLOAD_PATH);
      expect(xlsResult.status, `[Expected 2] The server rejects the .xls (${brief(xlsResult)})`).toBeGreaterThanOrEqual(400);
      expect(xlsResult.message, `[Expected 2] The server answers "${XLSX_ONLY}"`).toContain(XLSX_ONLY);
      expect(shown, `[Expected 2] The alert shows "${XLSX_ONLY}"`).toContain(XLSX_ONLY);
    });

    let totalAfterXls = 0;
    await step('Act: Step 3 — Check whether any SKU was created', async () => {
      totalAfterXls = await masterTotal(stockApi);
    });

    await step('Assert: Expected 3 — No SKU is created', async () => {
      expect(totalAfterXls, '[Expected 3] The SKU master row count is unchanged by the .xls').toBe(totalBefore);
    });

    let result!: UploadResult;
    let created: string[] = [];
    await step('Act: Step 4 — Upload the valid .xlsx workbook', async () => {
      result = await uploads.uploadAndReload(file);
      created = await existingCodes(stockApi, codes);
    });

    await step('Assert: Expected 4 — The .xlsx workbook is accepted and its SKUs are created', async () => {
      expect(result.status, `[Expected 4] The .xlsx workbook is accepted (${brief(result)})`).toBeLessThan(300);
      for (const code of codes) expect(created, `[Expected 4] SKU ${code} is created`).toContain(code);
    });
  });

  test('TC_US134_397 — An empty or unreadable workbook is rejected before any data is read', async ({ page, world, stockApi, skuMasterPage: master }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_397',
      'Medium',
      TAGS,
      `broken.xlsx (a text file renamed to .xlsx) is refused with EXL-4000 "${INVALID_EXCEL}"; the 0-byte empty.xlsx is refused with EXL-4000 "${EMPTY_EXCEL}" — a different sentence; neither creates a SKU; a valid workbook is then accepted. The code is read from the upload response (the toast shows only the message). ${HEADER_NOTE} ${COUNT_NOTE}`,
    );
    const uploads = new SkuUploadPage(page, master);
    const broken = rawFile('broken.xlsx', Buffer.from('This is a plain text file renamed to .xlsx', 'utf8'), XLSX_MIME);
    const empty = rawFile('empty.xlsx', Buffer.alloc(0), XLSX_MIME);
    let file!: ReturnType<typeof skuWorkbook>;
    let codes: string[] = [];
    let totalBefore = 0;

    await step('Arrange: Pre-condition 1–3 — Logged in with write access, broken.xlsx, empty.xlsx and a valid workbook are ready, the SKU master count is known', async () => {
      const schema = await headerSchema(stockApi);
      const groupCode = await newGroupCode(world, 'P397');
      const rows = skuRows(world, groupCode, 'S397', 1);
      codes = codesOf(rows);
      file = skuWorkbook(`sku-${groupCode}.xlsx`, schema, rows);
      totalBefore = await masterTotal(stockApi);
      await master.open('physical', 'ko');
    });

    let brokenResult!: UploadResult;
    await step('Act: Step 1 — Upload broken.xlsx and read the code and message', async () => {
      brokenResult = await uploads.upload(broken);
      await record('broken.xlsx answer', brokenResult.body);
    });

    await step('Assert: Expected 1 — The corrupted file is rejected with EXL-4000 and 유효하지 않은 엑셀입니다.', async () => {
      expect(brokenResult.status, `[Expected 1] broken.xlsx is rejected (${brief(brokenResult)})`).toBeGreaterThanOrEqual(400);
      expect(brokenResult.code, '[Expected 1] The code is EXL-4000').toBe('EXL-4000');
      expect(brokenResult.message, `[Expected 1] The message is "${INVALID_EXCEL}"`).toContain(INVALID_EXCEL);
      await expect(uploads.toast(INVALID_EXCEL).last(), `[Expected 1] The alert shows "${INVALID_EXCEL}"`).toBeVisible({ timeout: 30_000 });
    });

    let emptyResult!: UploadResult;
    await step('Act: Step 2 — Upload the 0-byte file empty.xlsx and read the message', async () => {
      emptyResult = await uploads.upload(empty);
      await record('empty.xlsx answer', emptyResult.body);
    });

    await step('Assert: Expected 2 — The empty file is rejected with 엑셀 파일이 비어있습니다. — still EXL-4000 but a different sentence', async () => {
      expect(emptyResult.status, `[Expected 2] empty.xlsx is rejected (${brief(emptyResult)})`).toBeGreaterThanOrEqual(400);
      expect(emptyResult.code, '[Expected 2] The code is still EXL-4000').toBe('EXL-4000');
      expect(emptyResult.message, `[Expected 2] The message is "${EMPTY_EXCEL}"`).toContain(EMPTY_EXCEL);
      expect(emptyResult.message, '[Expected 2] The two cases do not report the same string').not.toBe(brokenResult.message);
      await expect(uploads.toast(EMPTY_EXCEL).last(), `[Expected 2] The alert shows "${EMPTY_EXCEL}"`).toBeVisible({ timeout: 30_000 });
    });

    let totalAfter = 0;
    await step('Act: Step 3 — Check whether either created a SKU', async () => {
      totalAfter = await masterTotal(stockApi);
    });

    await step('Assert: Expected 3 — Neither file creates a SKU', async () => {
      expect(totalAfter, '[Expected 3] The SKU master row count is unchanged').toBe(totalBefore);
    });

    let result!: UploadResult;
    await step('Act: Step 4 — Upload the valid workbook', async () => {
      result = await uploads.uploadAndReload(file);
    });

    await step('Assert: Expected 4 — The valid workbook is accepted', async () => {
      expect(result.status, `[Expected 4] The valid workbook is accepted (${brief(result)})`).toBeLessThan(300);
      expect(await existingCodes(stockApi, codes), '[Expected 4] Its SKU is created').toEqual(codes);
    });
  });

  test('TC_US134_398 — A header-only SKU-creation workbook shows the success alert and creates nothing', async ({ page, stockApi, skuMasterPage: master }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_398',
      'Medium',
      TAGS,
      `A workbook holding only the header row is sent at once from the physical SKU master list; the response is 201 with {"ids": []}, the toast reads "${SKU_UPLOAD_DONE}" (AS-IS, not a defect) and the SKU master row count is unchanged. ${HEADER_NOTE} ${COUNT_NOTE}`,
    );
    const uploads = new SkuUploadPage(page, master);
    let file!: ReturnType<typeof skuWorkbook>;
    let totalBefore = 0;

    await step('Arrange: Pre-condition 1–4 — Logged in with write access, a header-only workbook is ready, the SKU master count is known, network calls are recorded', async () => {
      const schema = await headerSchema(stockApi);
      expect.soft(schema.headers.length, 'Pre-condition 2 — the header row holds the 20 header cells').toBe(20);
      file = skuWorkbook('sku-header-only.xlsx', schema, []);
      totalBefore = await masterTotal(stockApi);
    });

    let result!: UploadResult;
    let pickedAt = 0;
    let sentAt = 0;
    await step('Act: Step 1 — Open 현물 SKU 마스터 관리 (Physical SKU master) and upload the workbook through SKU 생성 업로드', async () => {
      await master.open('physical', 'ko');
      const chooser = await uploads.openChooser();
      const sent = page.waitForRequest((request) => isSkuUpload(request), { timeout: 10_000 }).then(() => Date.now());
      pickedAt = Date.now();
      result = await uploads.pick(chooser, file);
      sentAt = await sent;
    });

    await step('Assert: Expected 1 — The file is sent at once', async () => {
      expect(sentAt - pickedAt, '[Expected 1] The call leaves within 10 s of choosing the file').toBeLessThan(10_000);
      expect(result.url, '[Expected 1] The file is sent to the SKU-creation upload').toContain(SKU_UPLOAD_PATH);
    });

    await step('Act: Step 2 — Read the response', async () => {
      await record('Upload response', { status: result.status, body: result.body });
    });

    await step('Assert: Expected 2 — The response is 201 with {"ids": []}', async () => {
      expect(result.status, `[Expected 2] The response status is 201 (${brief(result)})`).toBe(201);
      expect(result.ids, '[Expected 2] The response body is {"ids": []}').toEqual([]);
    });

    let shown = '';
    await step('Act: Step 3 — Read the message that appears', async () => {
      const toast = uploads.toast(SKU_UPLOAD_DONE).last();
      await expect(toast, 'A message appears').toBeVisible({ timeout: 30_000 });
      shown = ((await uploads.toastMessage(toast).textContent()) ?? '').trim();
    });

    await step('Assert: Expected 3 — The alert shows SKU 생성 업로드가 완료되었습니다.', async () => {
      expect(shown, `[Expected 3] The alert reads "${SKU_UPLOAD_DONE}"`).toBe(SKU_UPLOAD_DONE);
    });

    let totalAfter = 0;
    await step('Act: Step 4 — Count the SKU master rows', async () => {
      totalAfter = await masterTotal(stockApi);
    });

    await step('Assert: Expected 4 — The count is unchanged', async () => {
      expect(totalAfter, '[Expected 4] The SKU master row count is unchanged').toBe(totalBefore);
    });
  });

  test('TC_US134_399 — A missing header column is rejected even when the column is optional', async ({ page, world, stockApi, skuMasterPage: master }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_399',
      'Medium',
      TAGS,
      `Three workbooks with valid data rows: without the 상품코드 (product code) header — the required column used for step 1 —, without the optional 자재코드 header, and without the optional BOM 구성 header. Each is refused with 엑셀에 '{column}' 항목이 존재하지 않습니다. naming the removed column and no row number, and none of their SKU codes exists afterwards. When the header the build demands has no 자재코드 / BOM 구성 column at all, that step fails on purpose (the TC requires the 20 headers to include them). ${HEADER_NOTE}`,
    );
    const uploads = new SkuUploadPage(page, master);
    let schema!: SkuUploadSchema;
    const cases: Array<{ header: string | undefined; codes: string[]; file: ReturnType<typeof skuWorkbook> | null }> = [];

    await step('Arrange: Pre-condition 1–4 — Logged in with write access, the three workbooks each missing one header are ready', async () => {
      schema = await headerSchema(stockApi);
      const omitted = [requireHeader(schema, 'groupCode', 'product code'), headerOf(schema, 'materialCode'), headerOf(schema, 'bom')];
      for (const [index, header] of omitted.entries()) {
        const groupCode = await newGroupCode(world, `P399${index}`);
        const rows = skuRows(world, groupCode, `S399${index}`, 2);
        cases.push({ header, codes: codesOf(rows), file: header ? skuWorkbook(`sku-no-${index}-${groupCode}.xlsx`, schema, rows, { omit: [header] }) : null });
      }
      await master.open('physical', 'ko');
    });

    const results: Array<UploadResult | null> = [null, null, null];
    const run = async (index: number) => {
      const current = cases[index];
      if (current.file) results[index] = await uploads.upload(current.file);
    };
    const expectMissing = async (index: number, n: number, what: string) => {
      const current = cases[index];
      const result = results[index];
      expect(current.header, `[Expected ${n}] The build's header carries the ${what} column`).toBeDefined();
      expect(result?.status ?? 0, `[Expected ${n}] The workbook without ${current.header ?? what} is rejected (${brief(result)})`).toBeGreaterThanOrEqual(400);
      expect(MISSING_HEADER.exec(result?.message ?? '')?.[1], `[Expected ${n}] The message names the missing column ${current.header ?? what}`).toBe(current.header);
      expect(result?.message ?? '', `[Expected ${n}] The message carries no row number`).not.toMatch(/\d+\s*행/);
    };

    await step('Act: Step 1 — Upload the workbook missing a required column (상품코드) and read the message', async () => {
      await run(0);
    });

    await step("Assert: Expected 1 — Rejected with 엑셀에 '{column}' 항목이 존재하지 않습니다., naming the column and NO row number", async () => {
      await expectMissing(0, 1, '상품코드 (product code)');
      await expect(uploads.toast(results[0]?.message ?? '').last(), '[Expected 1] The alert shows the message').toBeVisible({ timeout: 30_000 });
    });

    await step('Act: Step 2 — Upload the workbook missing 자재코드 and read the outcome', async () => {
      await run(1);
    });

    await step('Assert: Expected 2 — Also REJECTED; all 20 header cells must be present, including the optional columns', async () => {
      await expectMissing(1, 2, '자재코드 (material code)');
    });

    await step('Act: Step 3 — Upload the workbook missing BOM 구성 and read the outcome', async () => {
      await run(2);
    });

    await step('Assert: Expected 3 — Also rejected, for the same reason', async () => {
      await expectMissing(2, 3, 'BOM 구성 (BOM composition)');
    });

    let created: string[] = [];
    await step('Act: Step 4 — Check whether any SKU was created by the three runs', async () => {
      created = await existingCodes(stockApi, cases.flatMap((current) => current.codes));
    });

    await step('Assert: Expected 4 — No SKU is created by any of the three', async () => {
      expect(created, '[Expected 4] None of the SKU codes of the three workbooks exists').toEqual([]);
    });
  });

  test('TC_US134_400 — An empty required cell is reported with its row and column', async ({ page, world, stockApi, skuMasterPage: master }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_400',
      'Medium',
      TAGS,
      `A workbook of 3 data rows (sheet rows 2–4) whose SKU 코드 cell on row 3 is empty (not SKU 이름, which may be blank for a single-SKU product code) is refused with {n}행의 {m}열({column})은 필수 항목입니다. pointing at row 3 and the SKU code column; none of the 3 SKU codes exists afterwards, the valid rows included. ${ROW_NOTE} ${HEADER_NOTE}`,
    );
    const uploads = new SkuUploadPage(page, master);
    let file!: ReturnType<typeof skuWorkbook>;
    let codes: string[] = [];
    let header = '';
    let column = 0;

    await step('Arrange: Pre-condition 1–3 — Logged in with write access, a workbook with an empty required cell on row 3 is ready', async () => {
      const schema = await headerSchema(stockApi);
      header = requireHeader(schema, 'skuCode', 'SKU code');
      column = columnOf(schema, header);
      const groupCode = await newGroupCode(world, 'P400');
      const rows = skuRows(world, groupCode, 'S400', 3);
      codes = codesOf(rows);
      file = skuWorkbook(`sku-empty-cell-${groupCode}.xlsx`, schema, rows, { cells: { 1: { [header]: null } } });
      await master.open('physical', 'ko');
    });

    let result!: UploadResult;
    await step('Act: Step 1 — Upload the workbook through SKU 생성 업로드 (Upload SKU creation)', async () => {
      result = await uploads.upload(file);
    });

    await step('Assert: Expected 1 — The workbook is rejected', async () => {
      expect(result.status, `[Expected 1] The workbook is rejected (${brief(result)})`).toBeGreaterThanOrEqual(400);
    });

    let parsed: ReturnType<typeof parseRequired> = null;
    await step('Act: Step 2 — Read the message', async () => {
      await expect(master.toasts.last(), 'A message appears').toBeVisible({ timeout: 30_000 });
      parsed = parseRequired(result.message);
    });

    await step('Assert: Expected 2 — The message shows {n}행의 {m}열({column})은 필수 항목입니다. with real values', async () => {
      expect(parsed, `[Expected 2] The message has the shape {n}행의 {m}열({column})은 필수 항목입니다. ("${result.message}")`).not.toBeNull();
      expect(result.message, '[Expected 2] The curly-bracket parts are filled with real values').not.toMatch(/[{}]/);
      await expect(uploads.toast(result.message).last(), '[Expected 2] The alert shows the message').toBeVisible();
    });

    await step('Act: Step 3 — Compare the row and column it names with the real fault', async () => {
      await record('Required-cell message', { message: result.message, parsed, fault: { row: 3, column, header } });
    });

    await step('Assert: Expected 3 — It points at row 3 and the cell that was left empty', async () => {
      expect(parsed?.row, '[Expected 3] The message points at row 3').toBe(3);
      expect(parsed?.column, `[Expected 3] The message points at column ${column}`).toBe(column);
      expect(parsed?.name, `[Expected 3] The message names the column ${header}`).toBe(header);
    });

    let created: string[] = [];
    await step('Act: Step 4 — Check whether any SKU was created', async () => {
      created = await existingCodes(stockApi, codes);
    });

    await step('Assert: Expected 4 — No SKU is created, including from the valid rows', async () => {
      expect(created, '[Expected 4] None of the workbook SKU codes exists').toEqual([]);
    });
  });

  test('TC_US134_401 — A cell which cannot be converted is reported with its row, column and type', async ({ page, world, stockApi, skuMasterPage: master }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_401',
      'Medium',
      TAGS,
      `File A puts the text "ABC" in a numeric cell (중량 / weight, else the first numeric column) on row 2; file B puts the unparseable "NOT-A-DATE" in a date cell on row 4. Each is refused with {n}행 {m}열({column}): 셀(value:{v}, type:{t})을 {type}으로 변환할 수 없습니다. pointing at its row and column and naming the value and target type; neither creates a SKU. Deviation guard: the SKU-creation header may have no date column at all — then file B breaks a second numeric column on row 4 instead (the column used is attached). ${ROW_NOTE} ${HEADER_NOTE}`,
    );
    const uploads = new SkuUploadPage(page, master);
    let fileA!: ReturnType<typeof skuWorkbook>;
    let fileB!: ReturnType<typeof skuWorkbook>;
    let codes: string[] = [];
    let headerA = '';
    let headerB = '';
    let schema!: SkuUploadSchema;

    await step('Arrange: Pre-condition 1–3 — Logged in with write access, file A (text in a numeric cell, row 2) and file B (bad date, row 4) are ready', async () => {
      schema = await headerSchema(stockApi);
      headerA = numericHeader(schema) ?? requireHeader(schema, 'weight', 'numeric');
      headerB = headerOf(schema, 'date') ?? numericHeader(schema, [headerA]) ?? headerA;
      await record('Columns broken', { fileA: headerA, fileB: headerB, fileBIsDateColumn: fieldOf(headerB) === 'date' });
      const groupA = await newGroupCode(world, 'P401A');
      const groupB = await newGroupCode(world, 'P401B');
      const rowsA = skuRows(world, groupA, 'S401A', 1);
      const rowsB = skuRows(world, groupB, 'S401B', 3);
      codes = [...codesOf(rowsA), ...codesOf(rowsB)];
      fileA = skuWorkbook(`sku-text-number-${groupA}.xlsx`, schema, rowsA, { cells: { 0: { [headerA]: 'ABC' } } });
      fileB = skuWorkbook(`sku-bad-date-${groupB}.xlsx`, schema, rowsB, { cells: { 2: { [headerB]: 'NOT-A-DATE' } } });
      await master.open('physical', 'ko');
    });

    let resultA!: UploadResult;
    await step('Act: Step 1 — Upload file A and read the message', async () => {
      resultA = await uploads.upload(fileA);
    });

    await step('Assert: Expected 1 — File A is rejected with the conversion message pointing at row 2', async () => {
      const parsed = parseConvert(resultA.message);
      expect(resultA.status, `[Expected 1] File A is rejected (${brief(resultA)})`).toBeGreaterThanOrEqual(400);
      expect(parsed, `[Expected 1] The message has the conversion shape ("${resultA.message}")`).not.toBeNull();
      expect(parsed?.row, '[Expected 1] It points at row 2').toBe(2);
      expect(parsed?.column, `[Expected 1] It points at column ${columnOf(schema, headerA)}`).toBe(columnOf(schema, headerA));
      expect(parsed?.name, `[Expected 1] It names the column ${headerA}`).toBe(headerA);
      expect(parsed?.value ?? '', '[Expected 1] It names the value ABC').toContain('ABC');
      await expect(uploads.toast(resultA.message).last(), '[Expected 1] The alert shows the message').toBeVisible({ timeout: 30_000 });
    });

    let resultB!: UploadResult;
    await step('Act: Step 2 — Upload file B and read the message', async () => {
      resultB = await uploads.upload(fileB);
    });

    await step('Assert: Expected 2 — File B is rejected with the same message shape, pointing at row 4, naming the value and the target type', async () => {
      const parsed = parseConvert(resultB.message);
      expect(resultB.status, `[Expected 2] File B is rejected (${brief(resultB)})`).toBeGreaterThanOrEqual(400);
      expect(parsed, `[Expected 2] The message has the conversion shape ("${resultB.message}")`).not.toBeNull();
      expect(parsed?.row, '[Expected 2] It points at row 4').toBe(4);
      expect(parsed?.column, `[Expected 2] It points at column ${columnOf(schema, headerB)}`).toBe(columnOf(schema, headerB));
      expect(parsed?.name, `[Expected 2] It names the column ${headerB}`).toBe(headerB);
      expect(parsed?.value ?? '', '[Expected 2] It names the value it could not convert').toContain('NOT-A-DATE');
      expect(parsed?.target ?? '', '[Expected 2] It names the type it was aiming at').not.toBe('');
    });

    let created: string[] = [];
    await step('Act: Step 3 — Check whether either created a SKU', async () => {
      created = await existingCodes(stockApi, codes);
    });

    await step('Assert: Expected 3 — Neither file creates a SKU', async () => {
      expect(created, '[Expected 3] None of the SKU codes of file A or file B exists').toEqual([]);
    });
  });

  test('TC_US134_402 — A row with an export SKU name over 150 characters rejects the whole workbook', async ({ page, world, stockApi, skuMasterPage: master }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_402',
      'Medium',
      TAGS,
      `A workbook of 3 valid rows whose row 2 carries 수출용 SKU명 = 151 × "A" is refused; the code and string returned are recorded (NEEDS CLARIFICATION in the TC — the client string is "수출용 SKU명은 150자 이하로 입력해주세요."), and none of the 3 SKU codes exists afterwards. ${ROW_NOTE} ${HEADER_NOTE}`,
    );
    const uploads = new SkuUploadPage(page, master);
    let file!: ReturnType<typeof skuWorkbook>;
    let codes: string[] = [];
    let totalBefore = 0;

    await step('Arrange: Pre-condition 1–3 — Logged in with write access, a 3-row workbook with a 151-character export SKU name on row 2 is ready, the count is known', async () => {
      const schema = await headerSchema(stockApi);
      const header = requireHeader(schema, 'exportSkuName', '수출용 SKU명 (export SKU name)');
      const groupCode = await newGroupCode(world, 'P402');
      const rows = skuRows(world, groupCode, 'S402', 3);
      codes = codesOf(rows);
      file = skuWorkbook(`sku-long-export-${groupCode}.xlsx`, schema, rows, { cells: { 0: { [header]: 'A'.repeat(151) } } });
      totalBefore = await masterTotal(stockApi);
      await master.open('physical', 'ko');
    });

    let result!: UploadResult;
    await step('Act: Step 1 — Upload the workbook through SKU 생성 업로드 (Upload SKU creation)', async () => {
      result = await uploads.upload(file);
    });

    await step('Assert: Expected 1 — The workbook is rejected', async () => {
      expect(result.status, `[Expected 1] The workbook is rejected (${brief(result)})`).toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 2 — Read the message', async () => {
      await expect(master.toasts.last(), 'A message appears').toBeVisible({ timeout: 30_000 });
      await record('Code and string returned for the 151-character export SKU name', { status: result.status, code: result.code, message: result.message, body: result.body });
    });

    await step('Assert: Expected 2 — The code and string returned are recorded', async () => {
      expect(result.message, '[Expected 2] The server returns a message for the over-long export SKU name').not.toBe('');
      await expect(uploads.toast(result.message).last(), '[Expected 2] The alert shows the server string').toBeVisible();
    });

    let created: string[] = [];
    let totalAfter = 0;
    await step('Act: Step 3 — Count the SKU master rows', async () => {
      created = await existingCodes(stockApi, codes);
      totalAfter = await masterTotal(stockApi);
    });

    await step('Assert: Expected 3 — The count is unchanged — none of the 3 rows is created', async () => {
      expect(created, '[Expected 3] None of the 3 SKU codes exists').toEqual([]);
      expect(totalAfter, '[Expected 3] The SKU master row count is unchanged').toBe(totalBefore);
    });
  });

  test('TC_US134_403 — An existing product code EXTENDS its group rather than being rejected', async ({ page, world, stockApi, skuMasterPage: master }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_403',
      'Critical',
      TAGS,
      `DEMO-PC-001 is played by a product code the test creates for Demo Partner A with 2 SKUs (options Type A / Type B, Demo Manufacturer 1). A workbook carrying that product code with 2 new SKU lines naming Demo Partner A is accepted and the 2 SKUs are appended to the same group (no second group); a further workbook carrying the product code in lower case resolves to the same group. Groups are read through the SKU list API (search 상품코드, matched case-insensitively). ${HEADER_NOTE}`,
    );
    const uploads = new SkuUploadPage(page, master);
    let groupCode = '';
    let groupId = 0;
    let lowerCode = '';
    let file!: ReturnType<typeof skuWorkbook>;
    let fileLower!: ReturnType<typeof skuWorkbook>;
    let newCodes: string[] = [];
    let lowerCodes: string[] = [];

    await step('Arrange: Pre-condition 1–4 — Logged in with write access, an own product code of Demo Partner A with 2 SKUs exists, a workbook with 2 new lines for it is ready', async () => {
      const schema = await headerSchema(stockApi);
      const own = await world.createPhysicalSku('P403', { partner: world.partners.A, manufacturer: world.manufacturers.M1, lines: [{ option: 'Type A' }, { option: 'Type B' }] });
      groupCode = own[0].groupCode;
      groupId = own[0].groupId;
      lowerCode = groupCode.toLowerCase();
      await world.trackGroupCode(groupCode);
      await world.trackGroupCode(lowerCode);
      const shared = { groupName: own[0].groupName, hsCode: own[0].hsCode ?? undefined, partner: world.partners.A, manufacturer: world.manufacturers.M1 };
      const rows = skuRows(world, groupCode, 'S403', 2, shared);
      const rowsLower = skuRows(world, lowerCode, 'S403L', 1, shared);
      newCodes = codesOf(rows);
      lowerCodes = codesOf(rowsLower);
      file = skuWorkbook(`sku-extend-${groupCode}.xlsx`, schema, rows);
      fileLower = skuWorkbook(`sku-extend-lower-${groupCode}.xlsx`, schema, rowsLower);
      await master.open('physical', 'ko');
    });

    let before: Awaited<ReturnType<typeof groupSkus>> = [];
    await step('Act: Step 1 — Note how many SKUs the product code group holds', async () => {
      before = await groupSkus(stockApi, groupCode);
      await record('Group before the upload', before);
    });

    await step('Assert: Expected 1 — The starting count is recorded', async () => {
      expect(before.length, '[Expected 1] The starting count is recorded (2 SKUs)').toBe(2);
    });

    let result!: UploadResult;
    await step('Act: Step 2 — Upload the workbook through SKU 생성 업로드 (Upload SKU creation)', async () => {
      result = await uploads.uploadAndReload(file);
    });

    await step('Assert: Expected 2 — The workbook is ACCEPTED; a duplicate product code is NOT an error on this path', async () => {
      expect(result.status, `[Expected 2] The workbook is accepted (${brief(result)})`).toBeLessThan(300);
      await expect(uploads.toast(SKU_UPLOAD_DONE).last(), `[Expected 2] The alert reads "${SKU_UPLOAD_DONE}"`).toBeVisible({ timeout: 30_000 });
    });

    let after: Awaited<ReturnType<typeof groupSkus>> = [];
    await step('Act: Step 3 — Open the product code group and count its SKUs', async () => {
      after = await groupSkus(stockApi, groupCode);
      await master.open('physical');
      await master.search('SKU_GROUP_CODE', groupCode);
    });

    await step('Assert: Expected 3 — The group now holds 2 more SKUs — the 2 new lines were APPENDED to the existing group', async () => {
      expect(after.length, '[Expected 3] The group holds 2 more SKUs').toBe(before.length + 2);
      for (const code of newCodes) {
        expect(after.find((row) => row.skuCode === code)?.skuGroupId, `[Expected 3] The new SKU ${code} sits in the existing group`).toBe(groupId);
        await expect(master.row(code), `[Expected 3] The new SKU ${code} is listed under the product code`).toBeVisible();
      }
    });

    let groupIds: number[] = [];
    await step('Act: Step 4 — Check whether a second group with the same product code was created', async () => {
      groupIds = [...new Set(after.map((row) => row.skuGroupId))];
    });

    await step('Assert: Expected 4 — There is exactly ONE group for that product code', async () => {
      expect(groupIds, '[Expected 4] Exactly one group carries the product code').toEqual([groupId]);
    });

    let lowerResult!: UploadResult;
    let afterLower: Awaited<ReturnType<typeof groupSkus>> = [];
    await step('Act: Step 5 — Repeat with the product code in lower case', async () => {
      lowerResult = await uploads.uploadAndReload(fileLower);
      afterLower = await groupSkus(stockApi, groupCode);
    });

    await step('Assert: Expected 5 — The differently-cased code resolves to the SAME group — matching is case-insensitive', async () => {
      expect(lowerResult.status, `[Expected 5] The lower-case workbook is accepted (${brief(lowerResult)})`).toBeLessThan(300);
      const appended = afterLower.find((row) => row.skuCode === lowerCodes[0]);
      expect(appended?.skuGroupId, `[Expected 5] The SKU of ${lowerCode} sits in the group of ${groupCode}`).toBe(groupId);
      expect([...new Set(afterLower.map((row) => row.skuGroupId))], '[Expected 5] Still exactly one group for the product code in any case').toEqual([groupId]);
    });
  });

  test("TC_US134_404 — A product code owned by another biz partner is rejected", async ({ page, world, stockApi, skuMasterPage: master }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_404',
      'High',
      TAGS,
      `DEMO-PC-B01 is played by a product code the test creates for Demo Partner B (1 SKU, Demo Manufacturer B). A workbook carrying that product code with rows naming Demo Partner A is refused; the code and string returned are recorded (NEEDS CLARIFICATION in the TC — no InvalidBizPartnerAccessException row is published), the group keeps exactly its SKU, and none of the workbook SKU codes exists anywhere. ${HEADER_NOTE}`,
    );
    const uploads = new SkuUploadPage(page, master);
    let groupCode = '';
    let file!: ReturnType<typeof skuWorkbook>;
    let codes: string[] = [];
    let before: Awaited<ReturnType<typeof groupSkus>> = [];

    await step('Arrange: Pre-condition 1–4 — Logged in with write access, an own product code of Demo Partner B exists, a workbook naming Demo Partner A for it is ready, its SKU count is known', async () => {
      const schema = await headerSchema(stockApi);
      const own = await world.createPhysicalSku('P404', { partner: world.partners.B, manufacturer: world.manufacturers.MB });
      groupCode = own[0].groupCode;
      await world.trackGroupCode(groupCode);
      const rows = skuRows(world, groupCode, 'S404', 2, { groupName: own[0].groupName, hsCode: own[0].hsCode ?? undefined, partner: world.partners.A, manufacturer: world.manufacturers.M1 });
      codes = codesOf(rows);
      file = skuWorkbook(`sku-other-partner-${groupCode}.xlsx`, schema, rows);
      before = await groupSkus(stockApi, groupCode);
      await master.open('physical', 'ko');
    });

    let result!: UploadResult;
    await step('Act: Step 1 — Upload the workbook through SKU 생성 업로드 (Upload SKU creation)', async () => {
      result = await uploads.upload(file);
    });

    await step('Assert: Expected 1 — The workbook is rejected', async () => {
      expect(result.status, `[Expected 1] The workbook is rejected (${brief(result)})`).toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 2 — Read the code and the message', async () => {
      await expect(master.toasts.last(), 'A message appears').toBeVisible({ timeout: 30_000 });
      await record('Code and string returned for another partner\'s product code', { status: result.status, code: result.code, message: result.message, body: result.body });
    });

    await step('Assert: Expected 2 — The workbook is refused because the group belongs to another biz partner; the code and string are recorded', async () => {
      expect(result.message, '[Expected 2] The server returns a message for the refusal').not.toBe('');
      await expect(uploads.toast(result.message).last(), '[Expected 2] The alert shows the server string').toBeVisible();
    });

    let after: Awaited<ReturnType<typeof groupSkus>> = [];
    await step('Act: Step 3 — Open the product code group and count its SKUs', async () => {
      after = await groupSkus(stockApi, groupCode);
      await master.open('physical');
      await master.search('SKU_GROUP_CODE', groupCode);
    });

    await step('Assert: Expected 3 — The group is unchanged — no SKU was appended to another partner\'s group', async () => {
      expect(after.map((row) => row.skuId).sort(), '[Expected 3] The group holds exactly the SKUs it had').toEqual(before.map((row) => row.skuId).sort());
      for (const code of codes) await expect(master.row(code), `[Expected 3] ${code} is not listed under the product code`).toHaveCount(0);
    });

    let created: string[] = [];
    await step('Act: Step 4 — Check whether any SKU from the workbook was created anywhere', async () => {
      created = await existingCodes(stockApi, codes);
    });

    await step('Assert: Expected 4 — Nothing from the workbook was created', async () => {
      expect(created, '[Expected 4] None of the workbook SKU codes exists').toEqual([]);
    });
  });

  test('TC_US134_405 — The SKU code in the workbook is the code that is stored', async ({ page, world, stockApi, skuMasterPage: master }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_405',
      'High',
      TAGS,
      `A 1-row workbook carrying a new SKU code (DEMO-SKU-9001 played by a run-tagged code) creates exactly 1 SKU whose stored SKU code (API and the SKU master list cell) equals the cell character for character; a second workbook carrying the same SKU code (new product code, new barcode) is refused, the code and string returned are recorded (NEEDS CLARIFICATION — WH-SKU_ALREADY_EXISTS is published for the form only) and no SKU is created. ${HEADER_NOTE}`,
    );
    const uploads = new SkuUploadPage(page, master);
    let skuCode = '';
    let prefix = '';
    let secondGroup = '';
    let file!: ReturnType<typeof skuWorkbook>;
    let second!: ReturnType<typeof skuWorkbook>;

    await step('Arrange: Pre-condition 1–3 — Logged in with write access, a 1-row workbook with a new SKU code is ready, the count is known', async () => {
      const schema = await headerSchema(stockApi);
      const groupCode = await newGroupCode(world, 'P405');
      secondGroup = await newGroupCode(world, 'P405B');
      prefix = `${world.tag}S405`;
      skuCode = uniqueCode(world.tag, 'S405');
      file = skuWorkbook(`sku-code-${groupCode}.xlsx`, schema, [skuRow(world, { groupCode, skuCode })]);
      second = skuWorkbook(`sku-code-again-${secondGroup}.xlsx`, schema, [skuRow(world, { groupCode: secondGroup, skuCode })]);
      expect(await skusWithPrefix(stockApi, prefix), 'Pre-condition 2 — the SKU code does not exist yet').toEqual([]);
      await master.open('physical', 'ko');
    });

    let result!: UploadResult;
    let created: Awaited<ReturnType<typeof skusWithPrefix>> = [];
    await step('Act: Step 1 — Upload the workbook through SKU 생성 업로드 (Upload SKU creation)', async () => {
      result = await uploads.uploadAndReload(file);
      created = await skusWithPrefix(stockApi, prefix);
    });

    await step('Assert: Expected 1 — The workbook is accepted and 1 SKU is created', async () => {
      expect(result.status, `[Expected 1] The workbook is accepted (${brief(result)})`).toBeLessThan(300);
      expect(created.length, '[Expected 1] Exactly 1 SKU is created').toBe(1);
    });

    let cellText = '';
    await step('Act: Step 2 — Find the created SKU and read its SKU code', async () => {
      await master.search('SKU_CODE', skuCode);
      const column = (await master.headerTexts()).indexOf(t('col.skuCode'));
      cellText = ((await master.row(skuCode).locator('td').nth(column).textContent()) ?? '').trim();
    });

    await step('Assert: Expected 2 — The stored SKU code is the workbook code', async () => {
      expect(created[0]?.skuCode, `[Expected 2] The stored SKU code is ${skuCode}`).toBe(skuCode);
      await expect(master.row(skuCode), `[Expected 2] The SKU master list shows ${skuCode}`).toBeVisible();
    });

    await step('Act: Step 3 — Compare it character for character with the workbook cell', async () => {
      await record('SKU code comparison', { workbook: skuCode, stored: created[0]?.skuCode, listCell: cellText });
    });

    await step('Assert: Expected 3 — It matches the cell exactly — no prefix, no suffix, no case change', async () => {
      expect(cellText, '[Expected 3] The list cell matches the workbook cell exactly').toBe(skuCode);
      expect(cellText.length, '[Expected 3] No prefix or suffix was added').toBe(skuCode.length);
      expect(created[0]?.skuCode, '[Expected 3] The stored code keeps the exact letter case of the cell').toBe(skuCode);
    });

    let again!: UploadResult;
    let afterSecond: Awaited<ReturnType<typeof skusWithPrefix>> = [];
    await step('Act: Step 4 — Upload a second workbook carrying the same SKU code again', async () => {
      again = await uploads.upload(second);
      await record('Code and string returned for the repeated SKU code', { status: again.status, code: again.code, message: again.message, body: again.body });
      afterSecond = await skusWithPrefix(stockApi, prefix);
    });

    await step('Assert: Expected 4 — The second workbook is rejected and no SKU is created; the code and string are recorded', async () => {
      expect(again.status, `[Expected 4] The second workbook is rejected (${brief(again)})`).toBeGreaterThanOrEqual(400);
      expect(again.message, '[Expected 4] The server returns a message for the repeated SKU code').not.toBe('');
      expect(afterSecond.length, '[Expected 4] Still exactly 1 SKU carries the code').toBe(1);
      expect(await groupSkus(stockApi, secondGroup), '[Expected 4] The second workbook created no product code group').toEqual([]);
    });
  });

  test('TC_US134_406 — The SKU name is stored, and a blank name falls back to the product code name', async ({ page, world, stockApi, skuMasterPage: master }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_406',
      'High',
      TAGS,
      `Workbook 1 carries an explicit SKU name and the stored SKU name equals it exactly; workbook 2 carries a single-SKU product code with an empty SKU 이름 cell and is accepted (not reported as a missing required cell), and the stored name is the product code name — the form's 옵션없음 fallback. ${HEADER_NOTE}`,
    );
    const uploads = new SkuUploadPage(page, master);
    let explicitName = '';
    let groupName = '';
    let code1 = '';
    let code2 = '';
    let file1!: ReturnType<typeof skuWorkbook>;
    let file2!: ReturnType<typeof skuWorkbook>;
    let nameHeader = '';

    await step('Arrange: Pre-condition 1–4 — Logged in with write access, a row with an explicit SKU name and a single-SKU row with a blank SKU 이름 are ready, the product code name is known', async () => {
      const schema = await headerSchema(stockApi);
      nameHeader = requireHeader(schema, 'skuName', 'SKU 이름 (SKU name)');
      const group1 = await newGroupCode(world, 'P406A');
      const group2 = await newGroupCode(world, 'P406B');
      code1 = uniqueCode(world.tag, 'S406');
      code2 = uniqueCode(world.tag, 'S406');
      explicitName = `${world.tag} Explicit Name 406`;
      groupName = `${world.tag} Fallback Product 406`;
      file1 = skuWorkbook(`sku-name-${group1}.xlsx`, schema, [skuRow(world, { groupCode: group1, skuCode: code1, skuName: explicitName })]);
      file2 = skuWorkbook(`sku-blank-name-${group2}.xlsx`, schema, [skuRow(world, { groupCode: group2, skuCode: code2, groupName, skuName: null })]);
      await master.open('physical', 'ko');
    });

    let result1!: UploadResult;
    let stored1 = '';
    await step('Act: Step 1 — Upload the first workbook and read the stored SKU name', async () => {
      result1 = await uploads.uploadAndReload(file1);
      stored1 = (await skusByCode(stockApi, code1))[0]?.skuName ?? '';
    });

    await step('Assert: Expected 1 — The stored name matches the workbook cell exactly', async () => {
      expect(result1.status, `[Expected 1] The first workbook is accepted (${brief(result1)})`).toBeLessThan(300);
      expect(stored1, `[Expected 1] The stored SKU name is "${explicitName}"`).toBe(explicitName);
    });

    let result2!: UploadResult;
    await step('Act: Step 2 — Upload the second workbook with the blank name cell', async () => {
      result2 = await uploads.uploadAndReload(file2);
    });

    await step('Assert: Expected 2 — The second workbook is ACCEPTED', async () => {
      expect(result2.status, `[Expected 2] The second workbook is accepted (${brief(result2)})`).toBeLessThan(300);
    });

    await step('Act: Step 3 — Read whether it was accepted', async () => {
      await expect(master.toasts.last(), 'A message appears').toBeVisible({ timeout: 30_000 });
    });

    await step('Assert: Expected 3 — It is not reported as a missing required cell', async () => {
      expect(parseRequired(result2.message), `[Expected 3] No required-cell error is returned ("${result2.message}")`).toBeNull();
      expect(result2.message, `[Expected 3] The answer does not name the ${nameHeader} column`).not.toContain(nameHeader);
      await expect(uploads.toast(SKU_UPLOAD_DONE).last(), `[Expected 3] The alert reads "${SKU_UPLOAD_DONE}"`).toBeVisible();
    });

    let stored2 = '';
    await step('Act: Step 4 — Read the stored name of the SKU it created', async () => {
      stored2 = (await skusByCode(stockApi, code2))[0]?.skuName ?? '';
    });

    await step('Assert: Expected 4 — The stored name is the PRODUCT CODE NAME', async () => {
      expect(stored2, `[Expected 4] The stored SKU name is the product code name "${groupName}"`).toBe(groupName);
    });
  });

  test('TC_US134_407 — Every SKU created by the workbook appears on the SKU master list', async ({ page, world, stockApi, skuMasterPage: master }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_407',
      'High',
      TAGS,
      `The SKU master list is filtered on SKU코드 = the test's code prefix (so the rows are on page 1 of the shared list); after a workbook of 5 new SKU rows is uploaded the list re-queries itself (no page reload) and its row count rises by exactly 5 with each of the 5 SKU codes listed exactly once. ${HEADER_NOTE}`,
    );
    const uploads = new SkuUploadPage(page, master);
    let prefix = '';
    let codes: string[] = [];
    let file!: ReturnType<typeof skuWorkbook>;
    let navigations = 0;
    const exactRows = (code: string) => master.bodyRows.filter({ has: page.locator('td', { hasText: new RegExp(`^${code}$`) }) });

    await step('Arrange: Pre-condition 1–3 — Logged in with write access, a 5-row workbook is ready, the list is filtered on the test code prefix', async () => {
      const schema = await headerSchema(stockApi);
      const groupCode = await newGroupCode(world, 'P407');
      prefix = `${world.tag}S407`;
      const rows = skuRows(world, groupCode, 'S407', 5);
      codes = codesOf(rows);
      file = skuWorkbook(`sku-five-${groupCode}.xlsx`, schema, rows);
      await master.open('physical', 'ko');
      await master.search('SKU_CODE', prefix);
    });

    let before = -1;
    let beforeApi = -1;
    await step('Act: Step 1 — Note the row count on the SKU master list', async () => {
      before = await uploads.rowsWithPrefix(prefix).count();
      beforeApi = (await skusWithPrefix(stockApi, prefix)).length;
    });

    await step('Assert: Expected 1 — The starting count is recorded', async () => {
      expect(before, '[Expected 1] The starting list count matches the stored SKUs of the prefix').toBe(beforeApi);
    });

    let result!: UploadResult;
    let urlBefore = '';
    await step('Act: Step 2 — Upload the workbook through SKU 생성 업로드 (Upload SKU creation)', async () => {
      urlBefore = page.url();
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) navigations += 1;
      });
      result = await uploads.uploadAndReload(file);
    });

    await step('Assert: Expected 2 — The workbook is accepted', async () => {
      expect(result.status, `[Expected 2] The workbook is accepted (${brief(result)})`).toBeLessThan(300);
    });

    await step('Act: Step 3 — Read the refreshed list without reloading the page by hand', async () => {
      await expect(uploads.rowsWithPrefix(prefix), 'The list shows the new rows').toHaveCount(before + codes.length, { timeout: 30_000 });
    });

    await step('Assert: Expected 3 — The list has re-queried itself; the new rows are visible without a manual reload', async () => {
      expect(navigations, '[Expected 3] The page was not reloaded').toBe(0);
      expect(page.url(), '[Expected 3] The page address is unchanged').toBe(urlBefore);
      for (const code of codes) await expect(master.row(code), `[Expected 3] ${code} is visible in the refreshed list`).toBeVisible();
    });

    let after = -1;
    await step('Act: Step 4 — Count the rows again and look for all 5 SKUs', async () => {
      after = await uploads.rowsWithPrefix(prefix).count();
    });

    await step('Assert: Expected 4 — The count has risen by exactly 5 and all 5 SKUs are present, none duplicated', async () => {
      expect(after, '[Expected 4] The count has risen by exactly 5').toBe(before + 5);
      for (const code of codes) await expect(exactRows(code), `[Expected 4] ${code} is listed exactly once`).toHaveCount(1);
    });
  });

  test('TC_US134_408 — A SKU created by the workbook is findable by its SKU code', async ({ page, world, stockApi, skuMasterPage: master }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_408',
      'Medium',
      TAGS,
      `A SKU created through the SKU-creation upload (DEMO-SKU-9002 played by a run-tagged code; the upload is arranged through the same API the button calls) is found on the SKU master list by SKU코드 with the full code and with a fragment from its middle (partial match), and an unknown code shows the no-results state "${t('empty.noResults')}", not an error. ${HEADER_NOTE}`,
    );
    let skuCode = '';
    let groupCode = '';

    await step('Arrange: Pre-condition 1–3 — Logged in with write access, a SKU has just been created through the upload, the SKU코드 search condition is offered', async () => {
      const schema = await headerSchema(stockApi);
      groupCode = await newGroupCode(world, 'P408');
      skuCode = uniqueCode(world.tag, 'S408');
      const created = await stockApi.uploadSkuExcel(skuWorkbook(`sku-find-${groupCode}.xlsx`, schema, [skuRow(world, { groupCode, skuCode })]));
      if (created.status >= 300) throw new Error(`Test data setup failed — the SKU-creation upload returned ${created.status}: ${JSON.stringify(created.body)}`);
      await master.open('physical', 'ko');
      await expect(master.searchFieldSelect.locator('option[value="SKU_CODE"]'), 'Pre-condition 3 — SKU코드 is offered').toHaveText(t('skuSearchType.SKU_CODE'));
    });

    await step('Act: Step 1 — Set the search condition to SKU코드, enter the code and search', async () => {
      await master.search('SKU_CODE', skuCode);
    });

    await step('Assert: Expected 1 — The search runs and returns the SKU', async () => {
      await expect(master.row(skuCode), `[Expected 1] The search returns ${skuCode}`).toBeVisible();
    });

    let cells: Record<string, string> = {};
    await step('Act: Step 2 — Read the result', async () => {
      const headers = await master.headerTexts();
      const texts = (await master.row(skuCode).locator('td').allInnerTexts()).map((text) => text.trim());
      cells = Object.fromEntries(headers.map((header, index) => [header, texts[index] ?? '']));
    });

    await step('Assert: Expected 2 — It is the SKU the workbook created', async () => {
      expect(cells[t('col.skuCode')], '[Expected 2] The SKU코드 is the workbook code').toBe(skuCode);
      expect(cells[t('col.skuGroupCode')], '[Expected 2] The 상품코드 is the workbook product code').toBe(groupCode);
    });

    let fragment = '';
    await step('Act: Step 3 — Search again on a fragment of the code', async () => {
      fragment = skuCode.slice(4, skuCode.length - 2);
      await master.search('SKU_CODE', fragment);
    });

    await step('Assert: Expected 3 — The fragment also returns it — SKU코드 search matches partially', async () => {
      await expect(master.row(skuCode), `[Expected 3] The fragment "${fragment}" returns ${skuCode}`).toBeVisible();
    });

    await step('Act: Step 4 — Search on a code that exists nowhere', async () => {
      await master.search('SKU_CODE', `${world.tag}NONE999`);
    });

    await step('Assert: Expected 4 — The unknown code returns the no-results state, not an error', async () => {
      await expect(new SkuUploadPage(page, master).noResultsCell, `[Expected 4] The list shows "${t('empty.noResults')}"`).toBeVisible();
      await expect(page.locator('.main-content .alert-danger'), '[Expected 4] No error is shown').toHaveCount(0);
    });
  });

  test('TC_US134_409 — A SKU created by the workbook is findable by its SKU name', async ({ page, world, stockApi, skuMasterPage: master }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_409',
      'Medium',
      TAGS,
      `A SKU created through the SKU-creation upload with a known, run-tagged SKU name (the upload is arranged through the same API the button calls; the name searched is the stored name) is found on the SKU master list by SKU명 with the full name and with a fragment from the middle of the name, and an unknown name shows the no-results state "${t('empty.noResults')}". ${HEADER_NOTE}`,
    );
    let skuCode = '';
    let name = '';

    await step('Arrange: Pre-condition 1–3 — Logged in with write access, a SKU with a known name was created through the upload, the SKU명 search condition is offered', async () => {
      const schema = await headerSchema(stockApi);
      const groupCode = await newGroupCode(world, 'P409');
      skuCode = uniqueCode(world.tag, 'S409');
      const created = await stockApi.uploadSkuExcel(skuWorkbook(`sku-name-find-${groupCode}.xlsx`, schema, [skuRow(world, { groupCode, skuCode, skuName: `${world.tag} Upload Name 409` })]));
      if (created.status >= 300) throw new Error(`Test data setup failed — the SKU-creation upload returned ${created.status}: ${JSON.stringify(created.body)}`);
      name = (await skusByCode(stockApi, skuCode))[0]?.skuName ?? '';
      if (!name) throw new Error(`Test data setup failed — the uploaded SKU ${skuCode} has no stored name`);
      await master.open('physical', 'ko');
      await expect(master.searchFieldSelect.locator('option[value="SKU_NAME"]'), 'Pre-condition 3 — SKU명 is offered').toHaveText(t('skuSearchType.SKU_NAME'));
    });

    await step('Act: Step 1 — Set the search condition to SKU명, enter the full name and search', async () => {
      await master.search('SKU_NAME', name);
    });

    await step('Assert: Expected 1 — The search runs and returns the SKU', async () => {
      await expect(master.row(skuCode), `[Expected 1] The search on "${name}" returns ${skuCode}`).toBeVisible();
    });

    let cells: Record<string, string> = {};
    await step('Act: Step 2 — Read the result', async () => {
      const headers = await master.headerTexts();
      const texts = (await master.row(skuCode).locator('td').allInnerTexts()).map((text) => text.trim());
      cells = Object.fromEntries(headers.map((header, index) => [header, texts[index] ?? '']));
    });

    await step('Assert: Expected 2 — It is the SKU the workbook created', async () => {
      expect(cells[t('col.skuCode')], '[Expected 2] The SKU코드 is the workbook code').toBe(skuCode);
      expect(cells[t('col.skuName')], '[Expected 2] The SKU명 is the stored name').toBe(name);
    });

    let fragment = '';
    await step('Act: Step 3 — Search again on a fragment from the MIDDLE of the name', async () => {
      fragment = name.slice(3, name.length - 3);
      await master.search('SKU_NAME', fragment);
    });

    await step('Assert: Expected 3 — The fragment also returns it — SKU명 search matches partially', async () => {
      await expect(master.row(skuCode), `[Expected 3] The fragment "${fragment}" returns ${skuCode}`).toBeVisible();
    });

    await step('Act: Step 4 — Search on a name that exists nowhere', async () => {
      await master.search('SKU_NAME', `${world.tag} No Such Name`);
    });

    await step('Assert: Expected 4 — The unknown name returns the no-results state', async () => {
      await expect(new SkuUploadPage(page, master).noResultsCell, `[Expected 4] The list shows "${t('empty.noResults')}"`).toBeVisible();
      await expect(page.locator('.main-content .alert-danger'), '[Expected 4] No error is shown').toHaveCount(0);
    });
  });

  test('TC_US134_410 — A fully valid workbook commits every one of its rows', async ({ page, world, stockApi, skuMasterPage: master }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_410',
      'Critical',
      TAGS,
      `A workbook of 10 valid new SKU rows across 2 new product codes (6 + 4) is accepted with "${SKU_UPLOAD_DONE}"; exactly 10 SKUs carrying the workbook codes exist afterwards, each once, and each product code group holds exactly the rows the workbook assigned to it. ${HEADER_NOTE} ${COUNT_NOTE}`,
    );
    const uploads = new SkuUploadPage(page, master);
    let prefix = '';
    let groupA = '';
    let groupB = '';
    let codesA: string[] = [];
    let codesB: string[] = [];
    let file!: ReturnType<typeof skuWorkbook>;
    let before = -1;

    await step('Arrange: Pre-condition 1–3 — Logged in with write access, a 10-row workbook across 2 product codes is ready, the count is known', async () => {
      const schema = await headerSchema(stockApi);
      groupA = await newGroupCode(world, 'P410A');
      groupB = await newGroupCode(world, 'P410B');
      prefix = `${world.tag}S410`;
      const rowsA = skuRows(world, groupA, 'S410', 6);
      const rowsB = skuRows(world, groupB, 'S410', 4);
      codesA = codesOf(rowsA);
      codesB = codesOf(rowsB);
      file = skuWorkbook(`sku-ten-${groupA}.xlsx`, schema, [...rowsA, ...rowsB]);
      before = (await skusWithPrefix(stockApi, prefix)).length;
      await master.open('physical', 'ko');
    });

    let result!: UploadResult;
    await step('Act: Step 1 — Upload the workbook through SKU 생성 업로드 (Upload SKU creation)', async () => {
      result = await uploads.uploadAndReload(file);
    });

    await step('Assert: Expected 1 — The workbook is accepted and the success message appears', async () => {
      expect(result.status, `[Expected 1] The workbook is accepted (${brief(result)})`).toBeLessThan(300);
      await expect(uploads.toast(SKU_UPLOAD_DONE).last(), `[Expected 1] The alert reads "${SKU_UPLOAD_DONE}"`).toBeVisible({ timeout: 30_000 });
    });

    let stored: Awaited<ReturnType<typeof skusWithPrefix>> = [];
    await step('Act: Step 2 — Count the SKU master rows again', async () => {
      stored = await skusWithPrefix(stockApi, prefix);
    });

    await step('Assert: Expected 2 — The count has risen by exactly 10', async () => {
      expect(stored.length, '[Expected 2] The count has risen by exactly 10').toBe(before + 10);
    });

    await step('Act: Step 3 — Find each of the 10 SKUs', async () => {
      await master.search('SKU_CODE', prefix);
    });

    await step('Assert: Expected 3 — All 10 SKUs exist; none is missing and none is duplicated', async () => {
      for (const code of [...codesA, ...codesB]) {
        expect(stored.filter((row) => row.skuCode === code).length, `[Expected 3] ${code} exists exactly once`).toBe(1);
      }
      await expect(uploads.rowsWithPrefix(prefix), '[Expected 3] The SKU master list shows the 10 SKUs').toHaveCount(10);
    });

    let inA: Awaited<ReturnType<typeof groupSkus>> = [];
    let inB: Awaited<ReturnType<typeof groupSkus>> = [];
    await step('Act: Step 4 — Check that each product code group holds the rows the workbook assigned to it', async () => {
      inA = await groupSkus(stockApi, groupA);
      inB = await groupSkus(stockApi, groupB);
    });

    await step('Assert: Expected 4 — Each group holds its own rows', async () => {
      expect(inA.map((row) => row.skuCode).sort(), `[Expected 4] ${groupA} holds exactly its 6 rows`).toEqual([...codesA].sort());
      expect(inB.map((row) => row.skuCode).sort(), `[Expected 4] ${groupB} holds exactly its 4 rows`).toEqual([...codesB].sort());
      expect(new Set(inA.map((row) => row.skuGroupId)).size, `[Expected 4] ${groupA} is one group`).toBe(1);
      expect(new Set(inB.map((row) => row.skuGroupId)).size, `[Expected 4] ${groupB} is one group`).toBe(1);
      expect(inA[0]?.skuGroupId, '[Expected 4] The two product codes are separate groups').not.toBe(inB[0]?.skuGroupId);
    });
  });

  test('TC_US134_411 — One bad row leaves nothing created, appended or otherwise', async ({ page, world, stockApi, skuMasterPage: master }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_411',
      'Critical',
      TAGS,
      `A 5-row workbook: rows 1–2 extend a product code the test created for Demo Partner A (2 SKUs), rows 3–4 create a new product code, row 5 (sheet row 6) carries text in a numeric cell. The workbook is refused with a message naming row 6 and that column; none of the 4 valid rows exists afterwards and the existing group still holds exactly its 2 SKUs — the append path rolls back too. ${ROW_NOTE} ${HEADER_NOTE}`,
    );
    const uploads = new SkuUploadPage(page, master);
    let file!: ReturnType<typeof skuWorkbook>;
    let groupCode = '';
    let prefix = '';
    let badHeader = '';
    let validCodes: string[] = [];
    let schema!: SkuUploadSchema;

    await step('Arrange: Pre-condition 1–4 — Logged in with write access, a 5-row workbook (2 rows extend an own product code, 1 invalid row) is ready', async () => {
      schema = await headerSchema(stockApi);
      badHeader = numericHeader(schema) ?? requireHeader(schema, 'weight', 'numeric');
      const own = await world.createPhysicalSku('P411', { partner: world.partners.A, manufacturer: world.manufacturers.M1, lines: [{ option: 'Type A' }, { option: 'Type B' }] });
      groupCode = own[0].groupCode;
      await world.trackGroupCode(groupCode);
      const newGroup = await newGroupCode(world, 'P411N');
      prefix = `${world.tag}S411`;
      const extend = skuRows(world, groupCode, 'S411', 2, { groupName: own[0].groupName, hsCode: own[0].hsCode ?? undefined });
      const fresh = skuRows(world, newGroup, 'S411', 2);
      const bad = skuRows(world, newGroup, 'S411', 1, { hsCode: String(fresh[0].hsCode) });
      validCodes = codesOf([...extend, ...fresh]);
      file = skuWorkbook(`sku-one-bad-${groupCode}.xlsx`, schema, [...extend, ...fresh, ...bad], { cells: { 4: { [badHeader]: 'ABC' } } });
      await master.open('physical', 'ko');
    });

    let beforePrefix = -1;
    let beforeGroup: Awaited<ReturnType<typeof groupSkus>> = [];
    await step('Act: Step 1 — Note the SKU master count and the existing group\'s SKU count', async () => {
      beforePrefix = (await skusWithPrefix(stockApi, prefix)).length;
      beforeGroup = await groupSkus(stockApi, groupCode);
    });

    await step('Assert: Expected 1 — Both starting counts are recorded', async () => {
      expect(beforePrefix, '[Expected 1] The starting count of the workbook SKU codes is recorded (none yet)').toBe(0);
      expect(beforeGroup.length, '[Expected 1] The existing group count is recorded (2 SKUs)').toBe(2);
    });

    let result!: UploadResult;
    await step('Act: Step 2 — Upload the 5-row workbook through SKU 생성 업로드 (Upload SKU creation)', async () => {
      result = await uploads.upload(file);
    });

    await step("Assert: Expected 2 — The workbook is rejected and the server's message names the fault", async () => {
      const parsed = parseConvert(result.message);
      expect(result.status, `[Expected 2] The workbook is rejected (${brief(result)})`).toBeGreaterThanOrEqual(400);
      expect(parsed?.row, `[Expected 2] The message names the faulty row 6 ("${result.message}")`).toBe(6);
      expect(parsed?.name, `[Expected 2] The message names the faulty column ${badHeader}`).toBe(badHeader);
      await expect(uploads.toast(result.message).last(), '[Expected 2] The alert shows the server message').toBeVisible({ timeout: 30_000 });
    });

    let afterCodes: string[] = [];
    await step('Act: Step 3 — Count the SKU master rows again', async () => {
      afterCodes = (await skusWithPrefix(stockApi, prefix)).map((row) => row.skuCode);
    });

    await step('Assert: Expected 3 — The SKU master count is UNCHANGED; none of the 4 valid rows was created', async () => {
      expect(afterCodes.length, '[Expected 3] The count of the workbook SKU codes is unchanged').toBe(beforePrefix);
      for (const code of validCodes) expect(afterCodes, `[Expected 3] The valid row ${code} was not created`).not.toContain(code);
    });

    let afterGroup: Awaited<ReturnType<typeof groupSkus>> = [];
    await step('Act: Step 4 — Open the existing product code group and count its SKUs', async () => {
      afterGroup = await groupSkus(stockApi, groupCode);
      await master.search('SKU_GROUP_CODE', groupCode);
    });

    await step('Assert: Expected 4 — The existing group is UNCHANGED too — nothing was appended', async () => {
      expect(afterGroup.map((row) => row.skuId).sort(), '[Expected 4] The existing group holds exactly its 2 SKUs').toEqual(beforeGroup.map((row) => row.skuId).sort());
      await expect(uploads.rowsWithPrefix(prefix), '[Expected 4] No appended SKU is listed under the product code').toHaveCount(0);
    });
  });

  test('TC_US134_412 — Parsing stops at the first bad row rather than listing every fault', async ({ page, world, stockApi, skuMasterPage: master }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_412',
      'High',
      TAGS,
      `A 5-row workbook (data rows 1–5 = sheet rows 2–6): data row 3 has an empty SKU 코드 cell (sheet row 4), data row 4 has text in a numeric cell (sheet row 5). The refusal names only sheet row 4 with the required-cell message — not the conversion fault of the next row and no list of faults; with both faults corrected the same workbook creates all 5 SKUs. Not automated: the server parser trace (Step 3) is not reachable from the browser, so "row 4 is never parsed" is proven by the answer carrying a single row number and nothing of the data row 4 fault. ${ROW_NOTE} ${HEADER_NOTE}`,
    );
    const uploads = new SkuUploadPage(page, master);
    let faulty!: ReturnType<typeof skuWorkbook>;
    let fixed!: ReturnType<typeof skuWorkbook>;
    let prefix = '';
    let codeHeader = '';
    let numberHeader = '';

    await step('Arrange: Pre-condition 1–4 — Logged in with write access, a 5-row workbook with 2 different faults on data rows 3 and 4 is ready, the count is known', async () => {
      const schema = await headerSchema(stockApi);
      codeHeader = requireHeader(schema, 'skuCode', 'SKU code');
      numberHeader = numericHeader(schema) ?? requireHeader(schema, 'weight', 'numeric');
      const groupCode = await newGroupCode(world, 'P412');
      prefix = `${world.tag}S412`;
      const rows = skuRows(world, groupCode, 'S412', 5);
      faulty = skuWorkbook(`sku-fail-fast-${groupCode}.xlsx`, schema, rows, { cells: { 2: { [codeHeader]: null }, 3: { [numberHeader]: 'ABC' } } });
      fixed = skuWorkbook(`sku-fail-fast-fixed-${groupCode}.xlsx`, schema, rows);
      expect(await skusWithPrefix(stockApi, prefix), 'Pre-condition 4 — none of the SKU codes exists yet').toEqual([]);
      await master.open('physical', 'ko');
    });

    let result!: UploadResult;
    await step('Act: Step 1 — Upload the 5-row workbook', async () => {
      result = await uploads.upload(faulty);
    });

    await step('Assert: Expected 1 — The workbook is rejected', async () => {
      expect(result.status, `[Expected 1] The workbook is rejected (${brief(result)})`).toBeGreaterThanOrEqual(400);
    });

    let rowsNamed: number[] = [];
    await step('Act: Step 2 — Read the error and the row it reports', async () => {
      await expect(master.toasts.last(), 'A message appears').toBeVisible({ timeout: 30_000 });
      rowsNamed = [...result.message.matchAll(/(\d+)\s*행/g)].map((match) => Number(match[1]));
    });

    await step('Assert: Expected 2 — Row 3 is reported, and ONLY row 3', async () => {
      const parsed = parseRequired(result.message);
      expect(parsed?.row, `[Expected 2] Data row 3 (sheet row 4) is reported ("${result.message}")`).toBe(4);
      expect(parsed?.name, `[Expected 2] The fault named is the empty ${codeHeader} cell`).toBe(codeHeader);
      expect(rowsNamed, '[Expected 2] Only one row is reported').toEqual([4]);
    });

    await step('Act: Step 3 — Check the answer for any trace of reading row 4', async () => {
      await record('Fail-fast answer', { message: result.message, rowsNamed, body: result.body });
    });

    await step('Assert: Expected 3 — Row 4 is never parsed; the first bad row rejects the whole workbook', async () => {
      expect(parseConvert(result.message), '[Expected 3] The conversion fault of data row 4 is not reported').toBeNull();
      expect(result.message, '[Expected 3] The value of the data row 4 fault is not mentioned').not.toContain('ABC');
      expect(rowsNamed, '[Expected 3] Sheet row 5 (data row 4) is not mentioned').not.toContain(5);
    });

    let corrected!: UploadResult;
    let created: Awaited<ReturnType<typeof skusWithPrefix>> = [];
    await step('Act: Step 4 — Correct both invalid rows and upload again', async () => {
      corrected = await uploads.uploadAndReload(fixed);
      created = await skusWithPrefix(stockApi, prefix);
    });

    await step('Assert: Expected 4 — With both faults corrected the workbook succeeds and all 5 rows are created', async () => {
      expect(corrected.status, `[Expected 4] The corrected workbook succeeds (${brief(corrected)})`).toBeLessThan(300);
      expect(created.length, '[Expected 4] All 5 rows are created').toBe(5);
    });
  });
});
