import { test, expect } from '@fixtures/stock.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { squash } from '@pages/stock-calculation.page';
import { UsageSeed, daeguOf, minutesAgo, ownStockSku, seedUsage } from '@pages/stock-adjustment.page';
import { StockListSearchPage } from '@pages/stock-list-search.page';
import {
  ExportOutcome, HISTORY_EXPORT_HEADERS, HISTORY_EXPORT_PATH, LIST_EXPORT_HEADERS, LIST_EXPORT_PATH, StockAdjustmentUploadPage,
  isSpreadsheetAnswer, parseSeoulStamp,
} from '@pages/stock-adjustment-upload.page';
import { StockTextKey, stx } from '@utils/stock.i18n';
import { WORLD_NOTE, stockTags } from '@utils/stock-spec';
import { stockDb } from '@utils/stock-db';
import type { StockWorld, WorldSku } from '@utils/stock.data';

/**
 * US134 — nhóm [List Export] (TC_US134_369–380) + [Stock History Export] (TC_US134_381–387). Nguồn TC:
 * SCRATCH/us134/TC_US134_<n>.txt (Steps N / Expected N → `Act: Step N` / `Assert: Expected N`). TC mô tả export bất đồng bộ
 * (hàng đợi + panel tải về của header); build dev 05/10 tải file đồng bộ — assert theo TC, ghi lệch trong description.
 * File đọc từ lượt tải của trình duyệt bằng `readXlsxRows`. Dữ liệu 재고이력 dựng bằng DB trên SKU riêng của test.
 */
const TAGS = stockTags('export');
const ko = (key: StockTextKey) => stx(key, 'ko');
const QUEUED = ko('msg.exportQueued');
const SYNC_NOTE =
  'Observed on dev (bundle 05/10): 엑셀 다운로드 is a synchronous download — the GET call holds the connection until the file is built and streams it back (saved by the browser), there is no background queue and the header download panel is not used; the TC expectations on the asynchronous path (queued answer, header download panel, no browser download, answer under 3 s) are asserted as written with soft assertions — they fail on this build (confirmed by the run of 2026-10-06: the answer is the spreadsheet itself and the panel stays closed) while the later Expected lines are still checked. The file is read from the browser download instead of the header panel.';
const OWN_HISTORY_NOTE =
  'Data: the stock history of the shared demo rows must stay untouched, so the test creates its own physical SKU (Partner A, manufacturer M1) in the automation CJ Incheon Aam warehouse and writes its 재고이력 movements through the DB (stock_usage); the TC pair DEMO-SKU-0001 × CJ Incheon Aam maps onto it.';
const LIST_FILTERS = ['searchType', 'keyword', 'skuType', 'warehouseCategory', 'warehouseIds', 'bizPartnerIds', 'sort'];

/** Cột của file theo tên header (−1 khi file không có cột đó). */
const fileColumn = (rows: string[][], name: string): number => (rows[0] ?? []).indexOf(name);
const fileCell = (rows: string[][], row: string[], name: string): string => row[fileColumn(rows, name)] ?? '';
/** Số trong file (có thể ghi dạng số mũ) → chuỗi số nguyên để so với ID. */
const asId = (value: string): string => (value === '' ? '' : String(Number(value.replace(/,/g, ''))));

/** Tạo SKU riêng ở CJ Incheon Aam và ghi các biến động 재고이력 bằng DB — trả về số chứng từ (번호) theo thứ tự ghi. */
async function ownPairWithHistory(world: StockWorld, label: string, seeds: UsageSeed[]): Promise<{ sku: WorldSku; refIds: number[] }> {
  const sku = await ownStockSku(world, label, world.warehouses.CJ.id, { available: 100 });
  const refIds: number[] = [];
  for (const seed of seeds) refIds.push(await seedUsage(sku, world.warehouses.CJ.id, seed));
  return { sku, refIds };
}

const threeMovements = (): UsageSeed[] => [
  { refType: 'INCOMING', type: 'INCOMING_COMPLETED', before: 70, delta: 20, after: 90, memo: 'INCOMING/fixture', createdAt: minutesAgo(3) },
  { refType: 'ADJUSTMENT', type: 'ADJUSTMENT_COMPLETED', before: 90, delta: 15, after: 105, memo: 'ADJUSTMENT/fixture', createdAt: minutesAgo(2) },
  { refType: 'OUTGOING', type: 'OUTGOING_COMPLETED', before: 105, delta: -5, after: 100, memo: 'OUTGOING/fixture', createdAt: minutesAgo(1) },
];

test.describe('[List Export] Stock management — list Excel export', () => {
  test('TC_US134_369 — The list export is queued and carries the applied filters, not the half-picked ones', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_369',
      'High',
      TAGS,
      `With 비즈파트너 = Demo Partner B applied (5 demo rows) and Demo Partner A only half-picked, 엑셀 다운로드 returns at once with no file in the browser download list, the call carries bizPartnerIds of Partner B (the applied value) and the finished file holds 5 data rows. The list is also narrowed to the demo world with 상품코드명 = run tag so exactly the 5 Partner B demo rows are known. ${SYNC_NOTE} ${WORLD_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const search = new StockListSearchPage(page, list);
    const { A, B } = world.partners;
    let outcome: ExportOutcome | undefined;
    let partnersShown: string[] = [];

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; 5 demo rows belong to Demo Partner B; the export call is recorded', async () => {
      await list.open('ko');
    });

    await step('Act: Step 1 — Set 비즈파트너 (Biz partner) to Demo Partner B and click 검색 (Search)', async () => {
      await list.chooseSearchField('SKU_GROUP_NAME');
      await list.typeKeyword(world.keyword);
      await list.pickMulti('bizPartner', B.nameKo);
      await list.clickSearch();
      partnersShown = await list.columnValues('col.bizPartner');
    });

    await step('Assert: Expected 1 — Only the 5 Demo Partner B rows are listed', async () => {
      expect(await list.dataRowCount(), '[Expected 1] 5 rows are listed').toBe(5);
      partnersShown.forEach((name, index) => expect(name, `[Expected 1] Row ${index + 1} belongs to Demo Partner B (${B.nameKo})`).toBe(B.nameKo));
    });

    await step('Act: Step 2 — Without clicking Search again, change 비즈파트너 (Biz partner) to Demo Partner A', async () => {
      await search.unpickMulti('bizPartner', B.nameKo);
      await list.pickMulti('bizPartner', A.nameKo);
    });

    await step('Assert: Expected 2 — The field shows Demo Partner A while the table still shows the 5 Demo Partner B rows', async () => {
      await expect(list.multiValues('bizPartner').filter({ hasText: A.nameKo }).first(), '[Expected 2] The field shows Demo Partner A').toBeVisible();
      await expect(list.multiValues('bizPartner').filter({ hasText: B.nameKo }), '[Expected 2] Demo Partner B is no longer picked in the field').toHaveCount(0);
      expect(await list.dataRowCount(), '[Expected 2] The table still shows 5 rows').toBe(5);
      for (const name of await list.columnValues('col.bizPartner')) expect(name, '[Expected 2] The table still shows Demo Partner B rows').toBe(B.nameKo);
    });

    await step('Act: Step 3 — Click 엑셀 다운로드 (Excel download) and read the call and the browser download list', async () => {
      outcome = await list.exportList();
    });

    await step('Assert: Expected 3 — The call comes back at once and no file enters the browser download list at click time', async () => {
      expect(outcome?.status, '[Expected 3] The export call succeeds').toBeLessThan(300);
      expect.soft(outcome && isSpreadsheetAnswer(outcome), '[Expected 3] The call comes back with a queued request, not the built file').toBe(false);
      expect.soft(outcome?.download, '[Expected 3] No file enters the browser download list at click time').toBeNull();
    });

    let params: URLSearchParams = new URLSearchParams();
    await step('Act: Step 4 — Read the filter values the export call carries', async () => {
      params = outcome?.requestUrl.searchParams ?? new URLSearchParams();
    });

    await step('Assert: Expected 4 — The call carries Demo Partner B, the applied value, and not Demo Partner A', async () => {
      expect(params.get('bizPartnerIds'), '[Expected 4] The call carries the applied Demo Partner B').toBe(String(B.id));
      expect((params.get('bizPartnerIds') ?? '').split(','), '[Expected 4] The half-picked Demo Partner A is not sent').not.toContain(String(A.id));
    });

    let dataRows = -1;
    await step('Act: Step 5 — Fetch the file once the server has finished it and count its data rows', async () => {
      dataRows = StockAdjustmentUploadPage.dataRows(outcome?.rows ?? []).length;
    });

    await step('Assert: Expected 5 — The file has 5 data rows, matching the applied filter', async () => {
      expect(outcome?.rows.length ?? 0, '[Expected 5] A file is fetched').toBeGreaterThan(0);
      expect(dataRows, '[Expected 5] The file has 5 data rows').toBe(5);
    });
  });

  test('TC_US134_370 — A success toast follows the list export while a failed export stays silent', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_370',
      'Medium',
      TAGS,
      `A successful list export is queued and the host toast ${QUEUED} appears; when the export call is forced to fail (the browser answers it with HTTP 500), no toast, alert or message line appears. ${SYNC_NOTE} ${WORLD_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    let outcome: ExportOutcome | undefined;
    let failedStatus = 0;
    let toastsAfterFailure = -1;
    let alertsAfterFailure = -1;

    await step('Arrange: Pre-condition 1–3 — Stock data exists (the demo world is listed); the export call can be forced to fail', async () => {
      await list.open('ko');
      await list.search('SKU_GROUP_NAME', world.keyword);
    });

    await step('Act: Step 1 — Click 엑셀 다운로드 (Excel download) in a case where the export succeeds', async () => {
      outcome = await list.exportList();
    });

    await step('Assert: Expected 1 — The export is queued', async () => {
      expect(outcome?.status, '[Expected 1] The export call succeeds').toBeLessThan(300);
      expect.soft(outcome && isSpreadsheetAnswer(outcome), '[Expected 1] The export is queued (the call answers with a request, not the file)').toBe(false);
    });

    await step('Act: Step 2 — Look at the screen for any pop-up, alert or message line', async () => {
      await expect(list.lastToast(), 'A message appears after the export').toBeVisible();
    });

    await step(`Assert: Expected 2 — A success toast appears: ${QUEUED}`, async () => {
      await expect(list.toast(QUEUED).first(), `[Expected 2] The toast ${QUEUED} appears`).toBeVisible();
    });

    await step('Act: Step 3 — Force the export call to fail, then click 엑셀 다운로드 (Excel download) again', async () => {
      await expect(list.toasts, 'The earlier toast has gone before the second click').toHaveCount(0, { timeout: 15_000 });
      const restore = await list.forceFailure(LIST_EXPORT_PATH);
      try {
        failedStatus = await list.failedExportVia(list.exportButton, LIST_EXPORT_PATH);
      } finally {
        await restore();
      }
    });

    await step('Assert: Expected 3 — The export call fails', async () => {
      expect(failedStatus, '[Expected 3] The export call fails').toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 4 — Look again at the screen for any pop-up, alert or message line', async () => {
      toastsAfterFailure = await list.toasts.count();
      alertsAfterFailure = await page.locator('.alert-danger, [role="alert"]').count();
    });

    await step('Assert: Expected 4 — No message appears on failure', async () => {
      expect(toastsAfterFailure, '[Expected 4] No toast appears on failure').toBe(0);
      expect(alertsAfterFailure, '[Expected 4] No alert or message line appears on failure').toBe(0);
      await expect(list.openModals, '[Expected 4] No pop-up appears on failure').toHaveCount(0);
    });
  });

  test('TC_US134_371 — The queued list export appears in the platform download panel of the header', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_371',
      'Medium',
      TAGS,
      `Before the export the header download panel (#downloadDropdown) is closed; after 엑셀 다운로드 the export is queued, the panel opens with the request in it and the finished file can be collected from it (status 다운로드 가능). Which service answers GET /api/v1/download-requests is recorded in an attachment (open infrastructure question). ${SYNC_NOTE} ${WORLD_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const downloadRequestHosts: string[] = [];
    page.on('response', (response) => {
      if (new URL(response.url()).pathname.startsWith('/api/v1/download-requests')) downloadRequestHosts.push(`${new URL(response.url()).host} → ${response.status()}`);
    });
    let panelBefore = true;
    let outcome: ExportOutcome | undefined;
    let panelAfter = false;
    let panelItems = 0;
    let collectible = false;

    await step('Arrange: Pre-condition 1–3 — Stock data exists (the demo world is listed); the platform download panel is in the header', async () => {
      await list.open('ko');
      await list.search('SKU_GROUP_NAME', world.keyword);
    });

    await step('Act: Step 1 — Note that the top-bar download panel is closed', async () => {
      panelBefore = await list.downloadPanel.isVisible();
    });

    await step('Assert: Expected 1 — The panel is closed and shows no pending request', async () => {
      await expect(list.downloadToggle, '[Expected 1] The download panel toggle is in the header').toBeVisible();
      expect(panelBefore, '[Expected 1] The download panel is closed').toBe(false);
    });

    await step('Act: Step 2 — Click 엑셀 다운로드 (Excel download)', async () => {
      outcome = await list.exportList();
    });

    await step('Assert: Expected 2 — The export is queued', async () => {
      expect(outcome?.status, '[Expected 2] The export call succeeds').toBeLessThan(300);
      expect.soft(outcome && isSpreadsheetAnswer(outcome), '[Expected 2] The export is queued (the call answers with a request, not the file)').toBe(false);
    });

    await step('Act: Step 3 — Read the top-bar area of the application', async () => {
      panelAfter = await list.downloadPanel.isVisible();
      panelItems = panelAfter ? await list.downloadPanel.locator('.dropdown-item, li').count() : 0;
    });

    await step('Assert: Expected 3 — The header download panel opens and the queued request appears in it', async () => {
      expect.soft(panelAfter, '[Expected 3] The header download panel opens').toBe(true);
      expect.soft(panelItems, '[Expected 3] The queued request appears in the panel').toBeGreaterThan(0);
    });

    await step('Act: Step 4 — Wait for the server to finish the file and read the panel again', async () => {
      if (panelAfter) {
        collectible = await expect(list.downloadPanel, 'The request reaches 다운로드 가능').toContainText('다운로드 가능', { timeout: 90_000 }).then(() => true, () => false);
      }
      await test.info().attach('GET /api/v1/download-requests answers', { body: JSON.stringify(downloadRequestHosts, null, 2), contentType: 'application/json' });
    });

    await step('Assert: Expected 4 — The file can be collected from the panel once the server has produced it', async () => {
      expect.soft(collectible, '[Expected 4] The finished file can be collected from the header download panel').toBe(true);
    });
  });

  test('TC_US134_372 — The list export opens no confirmation, destination or format dialog', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_372',
      'Medium',
      TAGS,
      `엑셀 다운로드 queues the list export straight away with the host toast ${QUEUED} (expected, not a defect) and the header download panel opening; no confirmation, destination or format-selection dialog opens — the call leaves on the single click. ${SYNC_NOTE} ${WORLD_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    let outcome: ExportOutcome | undefined;
    let panelOpen = false;
    let dialogs = -1;

    await step('Arrange: Pre-condition 1–2 — Logged in with write access; stock data exists on the list', async () => {
      expect(world.stockRows.length, 'The demo world holds stock rows').toBeGreaterThan(0);
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management)', async () => {
      await list.open('ko');
      await list.search('SKU_GROUP_NAME', world.keyword);
    });

    await step('Assert: Expected 1 — The stock list opens', async () => {
      await expect(list.table, '[Expected 1] The stock list is shown').toBeVisible();
      expect(await list.dataRowCount(), '[Expected 1] The list shows stock rows').toBeGreaterThan(0);
    });

    await step('Act: Step 2 — Click 엑셀 다운로드 (Excel download) on the list', async () => {
      outcome = await list.exportList();
      panelOpen = await list.downloadPanel.isVisible();
    });

    await step(`Assert: Expected 2 — The export is queued, the header download panel opens and the toast ${QUEUED} appears`, async () => {
      expect.soft(outcome && isSpreadsheetAnswer(outcome), '[Expected 2] The list export is queued (the call answers with a request, not the file)').toBe(false);
      expect.soft(panelOpen, "[Expected 2] The host header's download panel opens").toBe(true);
      await expect(list.toast(QUEUED).first(), `[Expected 2] The host fires the toast ${QUEUED}`).toBeVisible();
    });

    await step('Act: Step 3 — Look for any dialog that asks to confirm, names a destination or selects a format', async () => {
      dialogs = await list.openModals.count();
    });

    await step('Assert: Expected 3 — No confirmation, destination or format-selection dialog opens', async () => {
      expect(outcome?.requestUrl.pathname, '[Expected 3] The export call leaves on the single click, with no dialog in between').toBe(LIST_EXPORT_PATH);
      expect(dialogs, '[Expected 3] No confirmation, destination or format-selection dialog is open').toBe(0);
    });
  });

  test('TC_US134_373 — Exporting the whole list neither freezes the screen nor times out', async ({ page }) => {
    test.setTimeout(420_000);
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_373',
      'High',
      TAGS,
      `With no filter (about 24,400 rows on dev) the export call must come back at once (< 3 s) without timing out, searching / sorting / paging keep working while the file is built (the second export call is held in the browser while the 3 actions run), and the call goes down the background export route. Environment deviation: the TC data set (about 24,400 rows, measured on another environment) does not exist on dev — the run of 2026-10-06 counted 208 rows — so Expected 1 is a soft assertion that fails on dev and the timing of Expected 2 is measured on the dev volume. ${SYNC_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    let total = 0;
    let outcome: ExportOutcome | undefined;
    const during = { search: false, sort: false, paging: false };

    await step('Arrange: Pre-condition 1–3 — The unfiltered stock list on dev; the export call is recorded', async () => {
      await list.open('ko');
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management) with no filters applied and read the count line', async () => {
      total = Number((/총 ([\d,]+)개/.exec(squash(await list.pagerText.first().innerText()))?.[1] ?? '0').replace(/,/g, ''));
    });

    await step('Assert: Expected 1 — The count line shows about 24,400 items', async () => {
      expect.soft(total, '[Expected 1] The count line shows about 24,400 items (±10%)').toBeGreaterThanOrEqual(21_960);
      expect.soft(total, '[Expected 1] The count line shows about 24,400 items (±10%)').toBeLessThanOrEqual(26_840);
    });

    await step('Act: Step 2 — Click 엑셀 다운로드 (Excel download) and measure how long the call takes to come back', async () => {
      outcome = await list.exportList();
      await test.info().attach('Export call duration', { body: JSON.stringify({ rows: total, elapsedMs: outcome.elapsedMs, status: outcome.status }, null, 2), contentType: 'application/json' });
    });

    await step('Assert: Expected 2 — The call comes back at once rather than holding the connection, and does not time out', async () => {
      expect(outcome?.status, '[Expected 2] The call does not time out').toBeLessThan(300);
      expect.soft(outcome?.elapsedMs, '[Expected 2] The call comes back at once (under 3 s)').toBeLessThan(3_000);
    });

    await step('Act: Step 3 — While the file is being built, try searching, sorting and paging on the list', async () => {
      const held = await list.paging.holdRequest((url, method) => method === 'GET' && url.includes(LIST_EXPORT_PATH));
      const download = page.waitForEvent('download', { timeout: 180_000 }).catch(() => null);
      try {
        await list.click(list.exportButton, '엑셀 다운로드 (Excel download) button');
        await held.seen;
        during.search = await list.clickSearch().then(() => true, () => false);
        during.sort = await list.chooseSort('UNCONFIRMED_OUTGOING_QUANTITY').then(() => true, () => false);
        during.paging = await list.paging.clickPager('Next').then(() => true, () => false);
        held.release();
        await download;
      } finally {
        held.release();
        await held.dispose();
      }
    });

    await step('Assert: Expected 3 — All 3 actions still work and the screen does not freeze', async () => {
      expect(during.search, '[Expected 3] Searching still works while the export runs').toBe(true);
      expect(during.sort, '[Expected 3] Sorting still works while the export runs').toBe(true);
      expect(during.paging, '[Expected 3] Paging still works while the export runs').toBe(true);
      await expect(list.table, '[Expected 3] The screen does not freeze — the table is shown').toBeVisible();
    });

    await step('Act: Step 4 — Read the export call', async () => {
      expect(outcome?.requestUrl.pathname, 'The export call is read').toBe(LIST_EXPORT_PATH);
    });

    await step('Assert: Expected 4 — The call goes down the background export route', async () => {
      expect.soft(outcome && isSpreadsheetAnswer(outcome), '[Expected 4] The call answers with a background request, not the built file').toBe(false);
    });
  });

  test('TC_US134_374 — The exported file carries the 20 data columns of the list in the list order', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_374',
      'Medium',
      TAGS,
      `The list export header row has exactly 20 columns — the 22 list columns minus the tick box and 재고이력 — in the order ${LIST_EXPORT_HEADERS.join(' · ')}, with no extra and no missing column (a 22-column file is a FAIL). The list is narrowed to the demo world. ${SYNC_NOTE} ${WORLD_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    let outcome: ExportOutcome | undefined;
    let panelOpen = false;
    let header: string[] = [];
    let screen: string[] = [];

    await step('Arrange: Pre-condition 1–3 — The stock list shows at least 1 row (the demo world)', async () => {
      await list.openWorld(world);
      expect(await list.dataRowCount(), 'The list shows at least 1 row').toBeGreaterThan(0);
    });

    await step('Act: Step 1 — Click 엑셀 다운로드 (Excel download)', async () => {
      outcome = await list.exportList();
      panelOpen = await list.downloadPanel.isVisible();
    });

    await step('Assert: Expected 1 — The export is queued and the header panel opens', async () => {
      expect.soft(outcome && isSpreadsheetAnswer(outcome), '[Expected 1] The export is queued').toBe(false);
      expect.soft(panelOpen, '[Expected 1] The header download panel opens').toBe(true);
    });

    await step('Act: Step 2 — Collect the finished file and open it', async () => {
      header = outcome?.rows[0] ?? [];
    });

    await step('Assert: Expected 2 — The file is produced and can be opened', async () => {
      expect(outcome?.download, '[Expected 2] A file is produced').not.toBeNull();
      expect(outcome?.rows.length ?? 0, '[Expected 2] The file opens with a header row').toBeGreaterThan(0);
    });

    await step('Act: Step 3 — Count the columns in the header row', async () => {
      expect(header, 'The header row is read').toBeDefined();
    });

    await step('Assert: Expected 3 — The header row has exactly 20 columns', async () => {
      expect(header.length, '[Expected 3] The header row has exactly 20 columns (22 list columns minus the tick box and 재고이력)').toBe(20);
    });

    await step('Act: Step 4 — Read the header row left to right and compare it with the list on screen', async () => {
      screen = (await list.headerTexts()).slice(1, 21);
    });

    await step('Assert: Expected 4 — The order is exactly the 20 TC columns from 상품코드 to 생성일', async () => {
      LIST_EXPORT_HEADERS.forEach((name, index) => {
        expect(header[index], `[Expected 4] File column ${index + 1} is ${name}`).toBe(name);
        expect(screen[index], `[Expected 4] File column ${index + 1} matches list column ${index + 2} (${name})`).toBe(name);
      });
    });

    await step('Act: Step 5 — Check whether the file carries any column the screen does not, or omits one the screen has', async () => {
      expect(screen.length, 'The 20 data columns of the screen are read').toBe(20);
    });

    await step('Assert: Expected 5 — No extra column and no missing data column; no tick box or 재고이력 column', async () => {
      expect(header.filter((name) => !screen.includes(name)), '[Expected 5] The file carries no column the screen does not').toEqual([]);
      expect(screen.filter((name) => !header.includes(name)), '[Expected 5] The file omits no data column of the list').toEqual([]);
      expect(header, '[Expected 5] The 재고이력 control is not in the file').not.toContain(ko('col.stockHistory'));
      expect(header.length, '[Expected 5] A 22-column file is a FAIL').not.toBe(22);
    });
  });

  test('TC_US134_375 — The exported values are the screen display values, not the raw wire values', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_375',
      'High',
      TAGS,
      `For the 12 demo rows the file must carry what the list renders: 비즈파트너 as the displayed NAME (not the internal id), SKU 유형 as 현물 / Set (not PHYSICAL / MIXED), and every other column with the screen formatting (thousand separators, "-" for no stock record). Dev measured the 2 failures (partner id, raw enum) on the current build. ${SYNC_NOTE} ${WORLD_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const keys = ['SKU0001', 'SKU0002', 'SKU0003', 'SKU0004', 'SKU0005', 'SKU0006', 'SKU0007', 'SKU0008', 'SKU0009', 'SKU0010', 'SKU0011', 'SKU0012'];
    const screen = new Map<string, string[]>();
    let outcome: ExportOutcome | undefined;
    const fileRow = (skuId: number): string[] =>
      StockAdjustmentUploadPage.dataRows(outcome?.rows ?? []).find((row) => asId(fileCell(outcome?.rows ?? [], row, 'SKU ID')) === String(skuId)) ?? [];

    await step('Arrange: Pre-condition 1–4 — Rows of a known biz partner, a 현물 SKU and a Set SKU are on the list (the demo world)', async () => {
      await list.openWorld(world);
    });

    await step('Act: Step 1 — Note 비즈파트너 and SKU 유형 shown on screen for those rows and click 엑셀 다운로드 (Excel download)', async () => {
      for (const key of keys) {
        const sku = world.sku(key);
        screen.set(key, (await list.rowTexts(list.rowBySkuId(sku.skuId))).slice(1, 21));
      }
      outcome = await list.exportList();
    });

    await step('Assert: Expected 1 — The export is queued and the screen values are recorded', async () => {
      expect.soft(outcome && isSpreadsheetAnswer(outcome), '[Expected 1] The export is queued').toBe(false);
      expect([...screen.values()].filter((cells) => cells.length === 20).length, '[Expected 1] The screen values of the 12 demo rows are recorded').toBe(12);
    });

    await step('Act: Step 2 — Collect the finished file and open it', async () => {
      expect(outcome?.rows, 'The file rows are read').toBeDefined();
    });

    await step('Assert: Expected 2 — The file is produced and can be opened', async () => {
      expect(outcome?.download, '[Expected 2] A file is produced').not.toBeNull();
      expect(StockAdjustmentUploadPage.dataRows(outcome?.rows ?? []).length, '[Expected 2] The file holds the 12 demo rows').toBe(12);
    });

    const partners: Array<{ key: string; file: string; screen: string; id: number }> = [];
    await step('Act: Step 3 — Read the 비즈파트너 (Biz partner) column for the same rows', async () => {
      for (const key of ['SKU0001', 'SKU0011']) {
        const sku = world.sku(key);
        partners.push({ key, file: fileCell(outcome?.rows ?? [], fileRow(sku.skuId), '비즈파트너'), screen: screen.get(key)?.[18] ?? '', id: sku.partner.id });
      }
    });

    await step('Assert: Expected 3 — The 비즈파트너 column carries the displayed NAME, not the internal id', async () => {
      for (const partner of partners) {
        expect(partner.file, `[Expected 3] 비즈파트너 of ${partner.key} is the displayed name ${partner.screen}`).toBe(partner.screen);
        expect(partner.file, `[Expected 3] 비즈파트너 of ${partner.key} is not the internal id ${partner.id}`).not.toBe(String(partner.id));
      }
    });

    const types: Array<{ key: string; file: string; screen: string }> = [];
    await step('Act: Step 4 — Read the SKU 유형 (SKU type) column for the same rows', async () => {
      for (const key of ['SKU0001', 'SKU0007']) {
        types.push({ key, file: fileCell(outcome?.rows ?? [], fileRow(world.sku(key).skuId), 'SKU 유형'), screen: screen.get(key)?.[14] ?? '' });
      }
    });

    await step('Assert: Expected 4 — SKU 유형 carries 현물 or Set as the list renders it, not PHYSICAL / MIXED', async () => {
      expect(types[0].screen, 'The list renders the physical SKU as 현물').toBe(ko('skuType.PHYSICAL'));
      expect(types[1].screen, 'The list renders the set SKU as Set').toBe(ko('skuType.MIXED'));
      for (const type of types) {
        expect(type.file, `[Expected 4] SKU 유형 of ${type.key} is the displayed label ${type.screen}`).toBe(type.screen);
        expect(['PHYSICAL', 'MIXED', 'DIGITAL'], `[Expected 4] SKU 유형 of ${type.key} is not a raw enum`).not.toContain(type.file);
      }
    });

    const mismatches: string[] = [];
    await step('Act: Step 5 — Compare every other formatted column with the screen', async () => {
      for (const key of keys) {
        const row = fileRow(world.sku(key).skuId);
        const cells = screen.get(key) ?? [];
        LIST_EXPORT_HEADERS.forEach((name, index) => {
          if (name === '비즈파트너' || name === 'SKU 유형') return;
          const file = fileCell(outcome?.rows ?? [], row, name);
          if (file !== cells[index]) mismatches.push(`${key} · ${name}: file "${file}" ≠ screen "${cells[index]}"`);
        });
      }
    });

    await step('Assert: Expected 5 — Every other column follows the screen formatting rather than the wire', async () => {
      expect(mismatches, '[Expected 5] Every exported value equals the value the list shows (thousand separators, "-" for no stock record)').toEqual([]);
    });
  });

  test('TC_US134_376 — The exported row order follows the list sort currently applied', async ({ page }) => {
    test.setTimeout(420_000);
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_376',
      'Medium',
      TAGS,
      'The first 5 data rows of the file follow the on-screen order for 최근 등록 순 (default) and, after switching to 미확보 출고수량 내림차순, the new on-screen order; the 2 files differ in row order. The whole dev list is used (no filter) because the order-derived 미확보 출고수량 cannot be seeded — the 2 orders only differ when dev holds rows with that quantity. Rows are compared by SKU ID.',
    );
    const list = new StockAdjustmentUploadPage(page);
    let screen1: string[] = [];
    let screen2: string[] = [];
    let file1: ExportOutcome | undefined;
    let file2: ExportOutcome | undefined;
    const firstFive = (outcome?: ExportOutcome): string[] =>
      StockAdjustmentUploadPage.dataRows(outcome?.rows ?? []).slice(0, 5).map((row) => asId(fileCell(outcome?.rows ?? [], row, 'SKU ID')));

    await step('Arrange: Pre-condition 1–3 — The unfiltered list; the 2 sort options 최근 등록 순 and 미확보 출고수량 내림차순', async () => {
      await list.open('ko');
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management) with the default sort and record the first 5 rows in order', async () => {
      screen1 = (await list.columnValues('col.skuId')).slice(0, 5);
    });

    await step('Assert: Expected 1 — The list is shown in the default order and the first 5 rows are recorded', async () => {
      await expect(list.sortSelect, '[Expected 1] The default sort is 최근 등록 순').toHaveValue('CREATED_AT');
      expect(screen1.length, '[Expected 1] The first 5 rows are recorded').toBe(5);
    });

    await step('Act: Step 2 — Click 엑셀 다운로드 (Excel download), collect the file and read its first 5 data rows', async () => {
      file1 = await list.exportList();
    });

    await step('Assert: Expected 2 — The first 5 data rows of the file are in the same order as the screen', async () => {
      expect(firstFive(file1), '[Expected 2] The first 5 file rows follow the on-screen order').toEqual(screen1);
    });

    await step('Act: Step 3 — Change the sort to 미확보 출고수량 내림차순 and record the first 5 rows again', async () => {
      await list.chooseSort('UNCONFIRMED_OUTGOING_QUANTITY');
      screen2 = (await list.columnValues('col.skuId')).slice(0, 5);
    });

    await step('Assert: Expected 3 — The list re-queries in the new order and the first 5 rows differ from Step 1', async () => {
      await expect(list.sortSelect, '[Expected 3] The sort is 미확보 출고수량 내림차순').toHaveValue('UNCONFIRMED_OUTGOING_QUANTITY');
      expect(screen2, '[Expected 3] The first 5 rows differ from Step 1').not.toEqual(screen1);
    });

    await step('Act: Step 4 — Click 엑셀 다운로드 (Excel download) again, collect the second file and read its first 5 data rows', async () => {
      file2 = await list.exportList();
    });

    await step('Assert: Expected 4 — The first 5 data rows of the second file match the new on-screen order', async () => {
      expect(firstFive(file2), '[Expected 4] The first 5 rows of the second file follow the new on-screen order').toEqual(screen2);
    });

    await step('Act: Step 5 — Compare the 2 files with each other', async () => {
      expect(file2?.requestUrl.searchParams.get('sort'), 'The second export carries the new sort').toContain('UNCONFIRMED_OUTGOING_QUANTITY');
    });

    await step('Assert: Expected 5 — The 2 files differ in row order', async () => {
      expect(firstFive(file2), '[Expected 5] The 2 files differ in row order — the export follows the current sort').not.toEqual(firstFive(file1));
    });
  });

  test('TC_US134_377 — A search with no rows still exports a file holding only the 20-column header', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_377',
      'Medium',
      TAGS,
      `상품코드명 = "<run tag> NOMATCH" matches nothing: the list shows 검색 결과가 없습니다. with no count line and no page navigation, 엑셀 다운로드 behaves as for a non-empty result (no error), and the file holds the 20-column header row and 0 data rows. ${SYNC_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const keyword = `${world.tag} NOMATCH`;
    let outcome: ExportOutcome | undefined;
    let errors = -1;

    await step('Arrange: Pre-condition 1–3 — A 상품코드명 keyword certain to match no row is known', async () => {
      await list.open('ko');
    });

    await step('Act: Step 1 — Apply the filter that matches nothing and click 검색 (Search)', async () => {
      await list.search('SKU_GROUP_NAME', keyword);
    });

    await step('Assert: Expected 1 — The filter is applied and the search runs', async () => {
      await expect(list.keywordInput, '[Expected 1] The keyword is applied').toHaveValue(keyword);
    });

    await step('Act: Step 2 — Confirm the list shows its no-results state', async () => {
      await expect(list.noResultsRow(), 'The no-results row is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — 검색 결과가 없습니다. inside the table; no count line and no page navigation', async () => {
      await expect(list.noResultsRow(), `[Expected 2] The table shows ${ko('empty.noResults')}`).toHaveText(ko('empty.noResults'));
      await expect(list.pagerText, '[Expected 2] The pagination bar shows no total-count line').toHaveCount(0);
      await expect(list.pagination, '[Expected 2] The pagination bar shows no page navigation').toHaveCount(0);
    });

    await step('Act: Step 3 — Click 엑셀 다운로드 (Excel download) and read the screen and the header panel', async () => {
      outcome = await list.exportList();
      errors = await page.locator('.alert-danger').count();
    });

    await step('Assert: Expected 3 — The export is queued exactly as for a non-empty result — no error, no special case', async () => {
      expect(outcome?.status, '[Expected 3] The export call succeeds').toBeLessThan(300);
      expect.soft(outcome && isSpreadsheetAnswer(outcome), '[Expected 3] The export is queued as for a non-empty result').toBe(false);
      expect(errors, '[Expected 3] No error is shown on screen').toBe(0);
    });

    await step('Act: Step 4 — Collect the file and open it', async () => {
      expect(outcome?.rows, 'The file rows are read').toBeDefined();
    });

    await step('Assert: Expected 4 — A file IS produced, not an error', async () => {
      expect(outcome?.download, '[Expected 4] A file is produced').not.toBeNull();
    });

    await step('Act: Step 5 — Count its header row and its data rows', async () => {
      expect(outcome?.rows.length ?? 0, 'The file rows are counted').toBeGreaterThanOrEqual(0);
    });

    await step('Assert: Expected 5 — The file holds the 20-column header row and 0 data rows', async () => {
      expect((outcome?.rows[0] ?? []).length, '[Expected 5] The header row has 20 columns').toBe(20);
      expect(StockAdjustmentUploadPage.dataRows(outcome?.rows ?? []).length, '[Expected 5] The file has 0 data rows').toBe(0);
    });
  });

  test('TC_US134_378 — The export file name carries the screen and a Seoul timestamp and stays unique', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_378',
      'Medium',
      TAGS,
      `Each export file is named {screen}_{YYYYMMDD_HHmmss}.xlsx; 2 exports at least 1 second apart give 2 different names, and the timestamp is Asia/Seoul time whatever the browser zone (the browser zone is attached). The bundle names the file from Content-Disposition, falling back to "Stock management.xlsx". ${SYNC_NOTE} ${WORLD_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const pattern = /^(.+)_(\d{8}_\d{6})\.xlsx$/;
    let first: ExportOutcome | undefined;
    let second: ExportOutcome | undefined;
    let firstAt = new Date();

    await step('Arrange: Pre-condition 1–3 — Stock data exists (the demo world is listed); the browser time zone is read', async () => {
      await list.open('ko');
      await list.search('SKU_GROUP_NAME', world.keyword);
      const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
      await test.info().attach('Browser time zone', { body: zone, contentType: 'text/plain' });
    });

    await step('Act: Step 1 — Click 엑셀 다운로드 (Excel download)', async () => {
      firstAt = new Date();
      first = await list.exportList();
    });

    await step('Assert: Expected 1 — The export is queued', async () => {
      expect.soft(first && isSpreadsheetAnswer(first), '[Expected 1] The export is queued').toBe(false);
    });

    await step('Act: Step 2 — Collect the file and read its name', async () => {
      expect(first?.download, 'A file is collected').not.toBeNull();
    });

    await step('Assert: Expected 2 — The name follows {screen}_{YYYYMMDD_HHmmss}.xlsx', async () => {
      expect(first?.fileName, '[Expected 2] The name follows {screen}_{YYYYMMDD_HHmmss}.xlsx').toMatch(pattern);
    });

    await step('Act: Step 3 — Wait at least 1 second, click 엑셀 다운로드 again and collect the second file', async () => {
      await expect.poll(() => Date.now() - firstAt.getTime(), { message: 'At least 1 second has passed since the first export', timeout: 10_000 }).toBeGreaterThanOrEqual(1_000);
      second = await list.exportList();
    });

    await step('Assert: Expected 3 — The second export is queued and produces its own file', async () => {
      expect.soft(second && isSpreadsheetAnswer(second), '[Expected 3] The second export is queued').toBe(false);
      expect(second?.download, '[Expected 3] The second export produces its own file').not.toBeNull();
    });

    await step('Act: Step 4 — Compare the 2 file names', async () => {
      expect(second?.fileName, 'The second name is read').toBeDefined();
    });

    await step('Assert: Expected 4 — The 2 names DIFFER', async () => {
      expect(second?.fileName, '[Expected 4] The 2 names differ').not.toBe(first?.fileName);
    });

    await step('Act: Step 5 — Compare the timestamp in the name with the current time in Asia/Seoul', async () => {
      expect(first?.fileName, 'The first name is read').toBeDefined();
    });

    await step('Assert: Expected 5 — The timestamp is Asia/Seoul, not the browser zone', async () => {
      const stamp = pattern.exec(first?.fileName ?? '')?.[2] ?? '';
      const skew = Math.abs(parseSeoulStamp(stamp).getTime() - firstAt.getTime());
      expect(skew, '[Expected 5] The timestamp in the name is the Asia/Seoul time of the export (within 2 minutes)').toBeLessThanOrEqual(120_000);
    });
  });

  test('TC_US134_379 — Exporting changes no stock value, leaves no movement and keeps the ticked rows', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_379',
      'Medium',
      TAGS,
      `With 2 demo rows ticked (DEMO-SKU-0001 and 0002 in CJ Incheon Aam), 엑셀 다운로드 is queued with the header panel opening, both rows stay ticked, every stock value is unchanged after a reload, and no 재고이력 movement is created (read in the dialog and in stock_usage). ${SYNC_NOTE} ${WORLD_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const skus = [world.sku('SKU0001'), world.sku('SKU0002')];
    const rows = skus.map((sku) => list.row(sku.skuCode, cj.name));
    const before: string[][] = [];
    const usagesBefore: number[] = [];
    let outcome: ExportOutcome | undefined;
    let panelOpen = false;
    const after: string[][] = [];
    const usagesAfter: number[] = [];
    const historyLines: number[] = [];

    await step('Arrange: Pre-condition 1–3 — The stock values and movements of the 2 rows are recorded; both rows can be ticked', async () => {
      await list.openWorld(world);
      for (const [index, sku] of skus.entries()) {
        before.push(await list.numericTexts(rows[index]));
        usagesBefore.push((await stockDb.usages(sku.skuId, cj.id)).length);
      }
    });

    await step('Act: Step 1 — Tick the 2 rows', async () => {
      for (const row of rows) await list.tick(row, 'demo row');
    });

    await step('Assert: Expected 1 — Both rows are ticked', async () => {
      for (const row of rows) await expect(list.checkbox(row), '[Expected 1] The row is ticked').toBeChecked();
    });

    await step('Act: Step 2 — Click 엑셀 다운로드 (Excel download)', async () => {
      outcome = await list.exportList();
      panelOpen = await list.downloadPanel.isVisible();
    });

    await step('Assert: Expected 2 — The export is queued and the header panel opens', async () => {
      expect.soft(outcome && isSpreadsheetAnswer(outcome), '[Expected 2] The export is queued').toBe(false);
      expect.soft(panelOpen, '[Expected 2] The header download panel opens').toBe(true);
    });

    await step('Act: Step 3 — Read the tick boxes once the call has come back', async () => {
      expect(outcome?.status, 'The export call has come back').toBeGreaterThan(0);
    });

    await step('Assert: Expected 3 — Both rows are still ticked', async () => {
      for (const row of rows) await expect(list.checkbox(row), '[Expected 3] The row is still ticked after the export').toBeChecked();
    });

    await step('Act: Step 4 — Reload the list and read the stock values of the 2 rows', async () => {
      await list.openWorld(world);
      for (const row of rows) after.push(await list.numericTexts(row));
    });

    await step('Assert: Expected 4 — Every stock value is unchanged', async () => {
      skus.forEach((sku, index) => expect(after[index], `[Expected 4] Every stock value of ${sku.skuCode} is unchanged`).toEqual(before[index]));
    });

    await step('Act: Step 5 — Open 재고이력 (Stock history) for both rows and look for any movement created by the export', async () => {
      for (const [index, sku] of skus.entries()) {
        await list.openHistoryOf(rows[index], 'ko');
        historyLines.push((await list.historyLines()).length);
        await list.closeHistory();
        usagesAfter.push((await stockDb.usages(sku.skuId, cj.id)).length);
      }
    });

    await step('Assert: Expected 5 — No movement was created by the export in either history', async () => {
      skus.forEach((sku, index) => {
        expect(usagesAfter[index], `[Expected 5] No movement is stored for ${sku.skuCode}`).toBe(usagesBefore[index]);
        expect(historyLines[index], `[Expected 5] The 재고이력 dialog of ${sku.skuCode} shows no new movement`).toBe(Math.min(usagesBefore[index], 10));
      });
    });
  });

  test('TC_US134_380 — Whether the list export runs asynchronously is recorded with its duration', async ({ page }) => {
    test.setTimeout(300_000);
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_380',
      'Medium',
      TAGS,
      `Record-only (EX-5): with no filter (about 24,400 rows) the export call is sent and the header download panel must open; whether the call returns at once (asynchronous) or holds the connection until the file is ready (synchronous interim) and the measured time are attached to the report, not judged. Dev measured 13–22 s for about 24,400 rows. ${SYNC_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    let outcome: ExportOutcome | undefined;
    let panelOpen = false;
    let path = '';

    await step('Arrange: Pre-condition 1–3 — The unfiltered stock list on dev; the export call is recorded', async () => {
      await list.open('ko');
    });

    await step('Act: Step 1 — Click 엑셀 다운로드 (Excel download) with no filter applied, watching the network call', async () => {
      outcome = await list.exportList();
      panelOpen = await list.downloadPanel.isVisible();
    });

    await step('Assert: Expected 1 — The call is sent and the header download panel opens', async () => {
      expect(outcome?.requestUrl.pathname, '[Expected 1] The export call is sent').toBe(LIST_EXPORT_PATH);
      expect.soft(panelOpen, '[Expected 1] The header download panel opens').toBe(true);
    });

    await step('Act: Step 2 — Note whether the call returns at once or holds the connection open until the file is ready', async () => {
      path = outcome && isSpreadsheetAnswer(outcome) ? 'synchronous — the connection is held until the file is built' : 'asynchronous — the call returns at once';
      await test.info().attach('Export path observed', { body: path, contentType: 'text/plain' });
    });

    await step('Assert: Expected 2 — Which of the two it is is recorded', async () => {
      expect(path, '[Expected 2] The observed export path is recorded (not judged)').not.toBe('');
    });

    await step('Act: Step 3 — If it holds the connection, measure how long the call takes and write the figure down', async () => {
      await test.info().attach('Export call duration', { body: JSON.stringify({ elapsedMs: outcome?.elapsedMs, dataRows: StockAdjustmentUploadPage.dataRows(outcome?.rows ?? []).length }, null, 2), contentType: 'application/json' });
    });

    await step('Assert: Expected 3 — The measured time is recorded', async () => {
      expect(outcome?.elapsedMs ?? 0, '[Expected 3] The measured time is recorded (not judged)').toBeGreaterThan(0);
    });
  });
});

test.describe('[Stock History Export] Stock management — stock history Excel export', () => {
  test('TC_US134_381 — The stock history export carries the pair SKU and warehouse, not the list filters', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_381',
      'Medium',
      TAGS,
      `After filtering the list to CJ Daegu warehouse and resetting, the 재고이력 dialog of the own SKU × CJ Incheon Aam pair exports with skuId and warehouseId of that pair only (none of searchType / keyword / skuType / warehouseCategory / warehouseIds / bizPartnerIds / sort), and every file row is one of that pair's movements (matched on 번호). After 초기화 the pair is found with 검색조건 SKU코드 (the shared list is too long to show it on page 1), so that keyword is one more list filter the export must not carry. CJ Daegu warehouse = the automation CJ Daegu copy (General warehouse when CJ_LOGISTICS_DT cannot be built). ${SYNC_NOTE} ${OWN_HISTORY_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const daegu = daeguOf(world);
    const { sku, refIds } = await ownPairWithHistory(world, 'X381', threeMovements());
    let warehouses: string[] = [];
    let outcome: ExportOutcome | undefined;

    await step('Arrange: Pre-condition 1–3 — The own pair in CJ Incheon Aam holds 3 movements; a row exists in CJ Daegu warehouse', async () => {
      await list.open('ko');
    });

    await step('Act: Step 1 — Set 창고 (Warehouse) to CJ Daegu warehouse and click 검색 (Search)', async () => {
      await list.pickMulti('warehouse', daegu.name);
      await list.clickSearch();
      warehouses = await list.columnValues('col.warehouse');
    });

    await step('Assert: Expected 1 — Only the CJ Daegu warehouse rows are listed', async () => {
      expect(warehouses.length, '[Expected 1] CJ Daegu warehouse rows are listed').toBeGreaterThan(0);
      warehouses.forEach((name, index) => expect(name, `[Expected 1] Row ${index + 1} is in ${daegu.name}`).toBe(daegu.name));
    });

    await step('Act: Step 2 — Clear the filters with 초기화 (Reset), then click 재고이력 (Stock history) on the pair row in CJ Incheon Aam', async () => {
      await list.clickReset();
      await list.findSku(sku);
      await list.openHistoryOf(list.row(sku.skuCode, cj.name), 'ko');
    });

    await step('Assert: Expected 2 — The stock history dialog opens for the SKU and CJ Incheon Aam', async () => {
      await expect(list.history.root, '[Expected 2] The stock history dialog opens').toBeVisible();
      expect(await list.historyContext(), `[Expected 2] The dialog is for ${sku.skuCode}`).toContain(sku.skuCode);
      expect(await list.historyContext(), `[Expected 2] The dialog is for ${cj.name}`).toContain(cj.name);
    });

    let params: URLSearchParams = new URLSearchParams();
    await step('Act: Step 3 — Click 엑셀 다운로드 (Excel download) inside the dialog and read the data sent to the server', async () => {
      outcome = await list.exportHistory();
      params = outcome.requestUrl.searchParams;
    });

    await step("Assert: Expected 3 — The data sent carries the pair's SKU id and warehouse id and none of the list filters", async () => {
      expect(params.get('skuId'), `[Expected 3] The call carries SKU id ${sku.skuId}`).toBe(String(sku.skuId));
      expect(params.get('warehouseId'), `[Expected 3] The call carries the warehouse id of ${cj.name}`).toBe(String(cj.id));
      for (const name of LIST_FILTERS) expect(params.has(name), `[Expected 3] The call carries no list filter ${name}`).toBe(false);
    });

    let numbers: string[] = [];
    await step('Act: Step 4 — Fetch the finished file and read which pair its rows belong to', async () => {
      numbers = StockAdjustmentUploadPage.dataRows(outcome?.rows ?? []).map((row) => asId(fileCell(outcome?.rows ?? [], row, '번호')));
    });

    await step('Assert: Expected 4 — Every row in the file belongs to the pair', async () => {
      expect(numbers.length, '[Expected 4] The file holds the 3 movements of the pair').toBe(refIds.length);
      for (const number of numbers) expect(refIds.map(String), `[Expected 4] File row 번호 ${number} is a movement of the pair`).toContain(number);
    });
  });

  test('TC_US134_382 — A success toast follows the history export and a failed export raises an alert in the dialog', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_382',
      'Medium',
      TAGS,
      `A successful 재고이력 export is queued with the toast ${QUEUED} and no error alert; when the export call is forced to fail (HTTP 500 answered in the browser) the dialog shows ${ko('err.historyExportFailed')}, stays open and nothing else changes. ${SYNC_NOTE} ${OWN_HISTORY_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const { sku } = await ownPairWithHistory(world, 'X382', threeMovements());
    let outcome: ExportOutcome | undefined;
    let failedStatus = 0;
    let linesBefore = -1;
    let linesAfter = -1;

    await step('Arrange: Pre-condition 1–3 — The own pair in CJ Incheon Aam holds movements; the export call can be forced to fail', async () => {
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Open the 재고이력 (Stock history) dialog and click 엑셀 다운로드 (Excel download) where the call succeeds', async () => {
      await list.openHistoryOf(list.row(sku.skuCode, cj.name), 'ko');
      linesBefore = (await list.historyLines()).length;
      outcome = await list.exportHistory();
    });

    await step('Assert: Expected 1 — The export is queued', async () => {
      expect(outcome?.status, '[Expected 1] The export call succeeds').toBeLessThan(300);
      expect.soft(outcome && isSpreadsheetAnswer(outcome), '[Expected 1] The export is queued (the call answers with a request, not the file)').toBe(false);
    });

    await step('Act: Step 2 — Look at the dialog for any alert', async () => {
      await expect(list.lastToast(), 'A message appears after the export').toBeVisible();
    });

    await step(`Assert: Expected 2 — A success toast ${QUEUED} appears and no error alert is raised`, async () => {
      await expect(list.toast(QUEUED).first(), `[Expected 2] The toast ${QUEUED} appears`).toBeVisible();
      await expect(list.history.errorAlert, '[Expected 2] No error alert is raised').toHaveCount(0);
    });

    await step('Act: Step 3 — Force the export call to fail and click 엑셀 다운로드 (Excel download) again', async () => {
      const restore = await list.forceFailure(HISTORY_EXPORT_PATH);
      try {
        failedStatus = await list.failedExportVia(list.history.exportButton, HISTORY_EXPORT_PATH);
      } finally {
        await restore();
      }
    });

    await step('Assert: Expected 3 — The call fails', async () => {
      expect(failedStatus, '[Expected 3] The export call fails').toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 4 — Read the alert and see whether the dialog is still open', async () => {
      linesAfter = (await list.historyLines()).length;
    });

    await step(`Assert: Expected 4 — ${ko('err.historyExportFailed')} is shown, the dialog stays open and nothing else changes`, async () => {
      await expect(list.history.errorAlert, `[Expected 4] The alert shows ${ko('err.historyExportFailed')}`).toContainText(ko('err.historyExportFailed'));
      await expect(list.history.root, '[Expected 4] The dialog is still open').toBeVisible();
      expect(linesAfter, '[Expected 4] The history table is unchanged').toBe(linesBefore);
    });
  });

  test('TC_US134_383 — The history export is queued asynchronously and opens the host download panel', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_383',
      'Medium',
      TAGS,
      `Clicking 엑셀 다운로드 in 재고이력 must put nothing in the browser download list, return at once (< 3 s) with a download request (a synchronous file stream is a FAIL), open the header download panel with the request and its count badge, and let the file be collected from the panel while the dialog stays open and usable. ${SYNC_NOTE} ${OWN_HISTORY_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const { sku } = await ownPairWithHistory(world, 'X383', threeMovements());
    let outcome: ExportOutcome | undefined;
    let panelOpen = false;
    let panelItems = 0;
    let collectible = false;

    await step('Arrange: Pre-condition 1–4 — The own pair holds movements; the header download panel is closed; calls and downloads are recorded', async () => {
      await list.open('ko');
      await list.findSku(sku);
      expect(await list.downloadPanel.isVisible(), 'The header download panel is closed').toBe(false);
    });

    await step('Act: Step 1 — Open 재고이력 (Stock history) for the pair in CJ Incheon Aam', async () => {
      await list.openHistoryOf(list.row(sku.skuCode, cj.name), 'ko');
    });

    await step('Assert: Expected 1 — The dialog opens for that pair', async () => {
      await expect(list.history.root, '[Expected 1] The dialog opens').toBeVisible();
      expect(await list.historyContext(), `[Expected 1] The dialog is for ${sku.skuCode} in ${cj.name}`).toContain(sku.skuCode);
      expect(await list.historyContext(), `[Expected 1] The dialog is for ${cj.name}`).toContain(cj.name);
    });

    await step('Act: Step 2 — Click 엑셀 다운로드 (Excel download) inside the dialog and watch the browser download list', async () => {
      outcome = await list.exportHistory();
    });

    await step('Assert: Expected 2 — NOTHING enters the browser download list at click time', async () => {
      expect.soft(outcome?.download, '[Expected 2] No file is streamed back on the click').toBeNull();
    });

    await step('Act: Step 3 — Read the call and how quickly it returns', async () => {
      await test.info().attach('History export call', { body: JSON.stringify({ status: outcome?.status, elapsedMs: outcome?.elapsedMs, contentType: outcome?.contentType }, null, 2), contentType: 'application/json' });
    });

    await step('Assert: Expected 3 — The call creates a download request and returns immediately', async () => {
      expect.soft(outcome && isSpreadsheetAnswer(outcome), '[Expected 3] The call creates a download request — a synchronous download is a FAIL').toBe(false);
      expect.soft(outcome?.elapsedMs, '[Expected 3] The call returns immediately (under 3 s)').toBeLessThan(3_000);
    });

    await step('Act: Step 4 — Read the header download panel', async () => {
      panelOpen = await list.downloadPanel.isVisible();
      panelItems = panelOpen ? await list.downloadPanel.locator('.dropdown-item, li').count() : 0;
    });

    await step('Assert: Expected 4 — The header download panel opens with the queued request and its count badge', async () => {
      expect.soft(panelOpen, '[Expected 4] The header download panel opens').toBe(true);
      expect.soft(panelItems, '[Expected 4] The queued request appears in the panel').toBeGreaterThan(0);
      await expect.soft(list.downloadToggle, '[Expected 4] The panel toggle shows a count badge').toContainText(/\d/);
    });

    await step('Act: Step 5 — Wait for the server to finish and collect the file from the panel', async () => {
      if (panelOpen) {
        collectible = await expect(list.downloadPanel, 'The request reaches 다운로드 가능').toContainText('다운로드 가능', { timeout: 90_000 }).then(() => true, () => false);
      }
    });

    await step('Assert: Expected 5 — The file is collected from the panel and the 재고이력 dialog stayed open and usable', async () => {
      expect.soft(collectible, '[Expected 5] The file can be collected from the panel').toBe(true);
      await expect(list.history.root, '[Expected 5] The 재고이력 dialog stayed open').toBeVisible();
      await expect(list.history.exportButton, '[Expected 5] The dialog is still usable').toBeEnabled();
    });
  });

  test('TC_US134_384 — The history export carries the same 10 columns in the same order as the dialog', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_384',
      'Medium',
      TAGS,
      `With 입고, 출고 and 조정 movements on the pair, the dialog shows 10 columns and the exported file header has exactly the same 10 in the same order: ${HISTORY_EXPORT_HEADERS.join(' · ')} — no extra, none missing. ${SYNC_NOTE} ${OWN_HISTORY_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const { sku } = await ownPairWithHistory(world, 'X384', threeMovements());
    let dialogHeaders: string[] = [];
    let outcome: ExportOutcome | undefined;
    let header: string[] = [];

    await step('Arrange: Pre-condition 1–3 — The own pair holds 입고, 출고 and 조정 movements', async () => {
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Open 재고이력 (Stock history) for the pair and read the table header left to right', async () => {
      await list.openHistoryOf(list.row(sku.skuCode, cj.name), 'ko');
      dialogHeaders = await list.history.headerTexts();
    });

    await step('Assert: Expected 1 — The dialog shows its 10 columns', async () => {
      expect(dialogHeaders.length, '[Expected 1] The dialog shows 10 columns').toBe(10);
      HISTORY_EXPORT_HEADERS.forEach((name, index) => expect(dialogHeaders[index], `[Expected 1] Dialog column ${index + 1} is ${name}`).toBe(name));
    });

    await step('Act: Step 2 — Click 엑셀 다운로드 (Excel download) and collect the finished file', async () => {
      outcome = await list.exportHistory();
      header = outcome.rows[0] ?? [];
    });

    await step('Assert: Expected 2 — The export is queued and the file is produced', async () => {
      expect.soft(outcome && isSpreadsheetAnswer(outcome), '[Expected 2] The export is queued').toBe(false);
      expect(outcome?.download, '[Expected 2] The file is produced').not.toBeNull();
    });

    await step("Act: Step 3 — Count the columns in the file's header row", async () => {
      expect(header, 'The header row is read').toBeDefined();
    });

    await step("Assert: Expected 3 — The file's header row has exactly 10 columns", async () => {
      expect(header.length, '[Expected 3] The header row has exactly 10 columns').toBe(10);
    });

    await step("Act: Step 4 — Read the file's header row left to right and compare it with the dialog", async () => {
      expect(dialogHeaders.length, 'The dialog header is at hand').toBe(10);
    });

    await step('Assert: Expected 4 — The order is exactly 날짜 … 작업자 ip', async () => {
      HISTORY_EXPORT_HEADERS.forEach((name, index) => expect(header[index], `[Expected 4] File column ${index + 1} is ${name}`).toBe(name));
    });

    await step('Act: Step 5 — Check whether the file carries any column the dialog does not, or omits one the dialog has', async () => {
      expect(header, 'The header row is read').toBeDefined();
    });

    await step('Assert: Expected 5 — There is no extra column and none is missing', async () => {
      expect(header.filter((name) => !dialogHeaders.includes(name)), '[Expected 5] The file carries no column the dialog does not').toEqual([]);
      expect(dialogHeaders.filter((name) => !header.includes(name)), '[Expected 5] The file omits no column of the dialog').toEqual([]);
    });
  });

  test("TC_US134_385 — The history export keeps the dialog's own formatting, labels and placeholders", async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_385',
      'High',
      TAGS,
      `The pair holds one movement for each of the 8 detail types the screen labels (입고완료, 보류입고완료, 출고요청, 출고완료, 출고취소, 출고실패, 조정완료, 불량처리), an increase of +10, a decrease of -4, a row whose 비고 is null with an empty operator and IP, and a row carried by "system" / "0.0.0.0". In the file 변경수량 is signed (+10, -4), the empty 비고 / 작업자 / 작업자 ip render "-", 구분 carries 입고 / 출고 / 조정 and 상세구분 carries each label — never a raw enum or a blank cell. What the build does with "system" and "0.0.0.0" is attached (record-only). Suspected defect (run of 2026-10-06): the dialog shows the increase signed (+3, +10) but the file cell reads 10 without the + — kept as a soft assertion so Expected 4–5 still run; the exported workbook is attached so the cell can be checked for a "+" number format (the suite reader returns the stored value, not the formatted text). ${SYNC_NOTE} ${OWN_HISTORY_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const seeds: UsageSeed[] = [
      { refType: 'INCOMING', type: 'INCOMING_COMPLETED', before: 50, delta: 10, after: 60, memo: 'INCOMING/increase', createdAt: minutesAgo(8) },
      { refType: 'INCOMING', type: 'HOLD_INCOMING_COMPLETED', before: 60, delta: 5, after: 65, memo: 'INCOMING/hold', createdAt: minutesAgo(7) },
      { refType: 'OUTGOING', type: 'OUTGOING_REQUESTED', before: 65, delta: 0, after: 65, memo: 'OUTGOING/requested', createdBy: 'system', createdIp: '0.0.0.0', createdAt: minutesAgo(6) },
      { refType: 'OUTGOING', type: 'OUTGOING_COMPLETED', before: 65, delta: -4, after: 61, memo: 'OUTGOING/decrease', createdAt: minutesAgo(5) },
      { refType: 'OUTGOING', type: 'OUTGOING_CANCELLED', before: 61, delta: 2, after: 63, memo: 'OUTGOING/cancelled', createdAt: minutesAgo(4) },
      { refType: 'OUTGOING', type: 'OUTGOING_FAILED', before: 63, delta: 1, after: 64, memo: 'OUTGOING/failed', createdAt: minutesAgo(3) },
      { refType: 'ADJUSTMENT', type: 'ADJUSTMENT_COMPLETED', before: 64, delta: 3, after: 67, memo: null, createdBy: '', createdIp: '', createdAt: minutesAgo(2) },
      { refType: 'ADJUSTMENT', type: 'DEFECTIVE_SCRAPPED', before: 67, delta: -1, after: 66, memo: 'ADJUSTMENT/scrapped', createdAt: minutesAgo(1) },
    ];
    const { sku, refIds } = await ownPairWithHistory(world, 'X385', seeds);
    const [increaseRef, , systemRef, decreaseRef, , , emptyRef] = refIds;
    let dialogLines = 0;
    let outcome: ExportOutcome | undefined;
    const byRef = (refId: number): string[] =>
      StockAdjustmentUploadPage.dataRows(outcome?.rows ?? []).find((row) => asId(fileCell(outcome?.rows ?? [], row, '번호')) === String(refId)) ?? [];
    const cell = (refId: number, name: string): string => fileCell(outcome?.rows ?? [], byRef(refId), name);

    await step('Arrange: Pre-condition 1–4 — The pair holds increase / decrease rows, an empty-operator row, a system row and all detail types', async () => {
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Open 재고이력 (Stock history) for the pair and record how the dialog renders those rows', async () => {
      await list.openHistoryOf(list.row(sku.skuCode, cj.name), 'ko');
      const lines = await list.historyLines();
      dialogLines = lines.length;
      await test.info().attach('Dialog rendering', { body: JSON.stringify(lines, null, 2), contentType: 'application/json' });
    });

    await step('Assert: Expected 1 — The dialog renders the rows and the values are recorded', async () => {
      expect(dialogLines, '[Expected 1] The dialog renders the 8 movements').toBe(seeds.length);
    });

    await step('Act: Step 2 — Click 엑셀 다운로드 (Excel download) and collect the finished file', async () => {
      outcome = await list.exportHistory();
      const saved = outcome.download ? await outcome.download.path() : null;
      if (saved) await test.info().attach('Exported stock history workbook', { path: saved, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    });

    await step('Assert: Expected 2 — The file is produced and can be opened', async () => {
      expect(outcome?.download, '[Expected 2] The file is produced').not.toBeNull();
      expect(StockAdjustmentUploadPage.dataRows(outcome?.rows ?? []).length, '[Expected 2] The file opens with the 8 movements').toBe(seeds.length);
    });

    let increase = '';
    let decrease = '';
    await step('Act: Step 3 — Read 변경수량 (Change quantity) for the increase and the decrease rows', async () => {
      increase = cell(increaseRef, '변경수량');
      decrease = cell(decreaseRef, '변경수량');
    });

    await step('Assert: Expected 3 — 변경수량 is SIGNED: +10 on the increase and -4 on the decrease', async () => {
      expect.soft(increase, '[Expected 3] The increase reads +10, with the + shown').toBe('+10');
      expect(decrease, '[Expected 3] The decrease reads -4').toBe('-4');
    });

    const recorded = { system: { operator: '', ip: '' } };
    await step('Act: Step 4 — Read 비고, 작업자 and 작업자 ip on the row where they are empty or null', async () => {
      recorded.system = { operator: cell(systemRef, '작업자'), ip: cell(systemRef, '작업자 ip') };
      await test.info().attach('No-actor values in the file', {
        body: JSON.stringify({ emptyRow: { note: cell(emptyRef, '비고'), operator: cell(emptyRef, '작업자'), ip: cell(emptyRef, '작업자 ip') }, systemRow: recorded.system }, null, 2),
        contentType: 'application/json',
      });
    });

    await step('Assert: Expected 4 — All 3 empty values render a dash (-), not a blank cell; system / 0.0.0.0 are recorded', async () => {
      expect(cell(emptyRef, '비고'), '[Expected 4] The null 비고 renders -').toBe('-');
      expect(cell(emptyRef, '작업자'), '[Expected 4] The empty 작업자 renders -').toBe('-');
      expect(cell(emptyRef, '작업자 ip'), '[Expected 4] The empty 작업자 ip renders -').toBe('-');
      expect(recorded.system.operator, '[Expected 4] The value the build writes for operator "system" is recorded').not.toBe('');
    });

    const labels: Array<{ refId: number; seed: UsageSeed; type: string; detail: string }> = [];
    await step('Act: Step 5 — Read 구분 (Type) and 상세구분 (Detail type) on every row', async () => {
      seeds.forEach((seed, index) => labels.push({ refId: refIds[index], seed, type: cell(refIds[index], '구분'), detail: cell(refIds[index], '상세구분') }));
    });

    await step('Assert: Expected 5 — 구분 carries 입고 / 출고 / 조정 and 상세구분 carries its label for every detail type', async () => {
      for (const label of labels) {
        const typeLabel = ko(`usageRef.${label.seed.refType}` as StockTextKey);
        const detailLabel = ko(`usageType.${label.seed.type}` as StockTextKey);
        expect(label.type, `[Expected 5] 구분 of ${label.seed.type} is ${typeLabel}, not ${label.seed.refType}`).toBe(typeLabel);
        expect(label.detail, `[Expected 5] 상세구분 of ${label.seed.type} is ${detailLabel}, not a raw enum or a blank cell`).toBe(detailLabel);
      }
    });
  });

  test('TC_US134_386 — The history export follows the dialog order with an id tie-break, and an empty pair still exports a file', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_386',
      'Medium',
      TAGS,
      `A pair with 6 movements (2 written in the SAME second) is listed newest first in the dialog and the file has the same order (날짜 descending), the 2 same-second rows ordered by id DESCENDING (the later write first); a second own pair with a stock row but no movement shows an empty table (no error) and still exports a file with the 10-column header and 0 data rows. ${SYNC_NOTE} ${OWN_HISTORY_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const tie = minutesAgo(1);
    const seeds: UsageSeed[] = [
      ...[6, 5, 4, 3].map((minutes, index): UsageSeed => ({ refType: 'ADJUSTMENT', type: 'ADJUSTMENT_COMPLETED', before: index, delta: 1, after: index + 1, memo: `ADJUSTMENT/order ${index + 1}`, createdAt: minutesAgo(minutes) })),
      { refType: 'ADJUSTMENT', type: 'ADJUSTMENT_COMPLETED', before: 4, delta: 1, after: 5, memo: 'ADJUSTMENT/tie first write', createdAt: tie },
      { refType: 'ADJUSTMENT', type: 'ADJUSTMENT_COMPLETED', before: 5, delta: 1, after: 6, memo: 'ADJUSTMENT/tie second write', createdAt: tie },
    ];
    const { sku, refIds } = await ownPairWithHistory(world, 'X386', seeds);
    const empty = await ownStockSku(world, 'Y386', cj.id, { available: 10 });
    const [tieFirst, tieSecond] = refIds.slice(4);
    let dialogOrder: string[] = [];
    let dialogDates: string[] = [];
    let outcome: ExportOutcome | undefined;
    let fileOrder: string[] = [];
    let emptyLines = -1;
    let emptyOutcome: ExportOutcome | undefined;

    await step('Arrange: Pre-condition 1–4 — Pair 1 holds 6 movements, 2 in the same second; pair 2 has a stock row and no movement', async () => {
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Open 재고이력 (Stock history) for the first pair and record the on-screen row order', async () => {
      await list.openHistoryOf(list.row(sku.skuCode, cj.name), 'ko');
      const lines = await list.historyLines();
      dialogOrder = lines.map((line) => line.refId);
      dialogDates = lines.map((line) => line.date);
    });

    await step('Assert: Expected 1 — The dialog lists the movements newest first', async () => {
      expect(dialogOrder.length, '[Expected 1] The dialog lists the 6 movements').toBe(6);
      expect(dialogDates, '[Expected 1] The movements are listed newest first').toEqual([...dialogDates].sort().reverse());
    });

    await step('Act: Step 2 — Click 엑셀 다운로드 (Excel download), collect the file and compare its row order with the dialog', async () => {
      outcome = await list.exportHistory();
      fileOrder = StockAdjustmentUploadPage.dataRows(outcome.rows).map((row) => asId(fileCell(outcome?.rows ?? [], row, '번호')));
    });

    await step('Assert: Expected 2 — The file rows are in the same order as the dialog — 날짜 descending', async () => {
      expect(fileOrder, '[Expected 2] The file rows follow the dialog order').toEqual(dialogOrder);
    });

    await step('Act: Step 3 — Find the 2 rows sharing a second and read their order in the file', async () => {
      expect(fileOrder, 'The file order is read').toBeDefined();
    });

    await step('Assert: Expected 3 — The 2 rows sharing a second are ordered by id DESCENDING', async () => {
      expect(fileOrder.indexOf(String(tieSecond)), '[Expected 3] The later write of the same second is in the file').toBeGreaterThanOrEqual(0);
      expect(fileOrder.indexOf(String(tieSecond)), '[Expected 3] The later write (higher id) comes before the earlier one').toBeLessThan(fileOrder.indexOf(String(tieFirst)));
    });

    await step('Act: Step 4 — Open 재고이력 (Stock history) for the pair with no movements and read the dialog', async () => {
      await list.closeHistory();
      await list.findSku(empty);
      await list.openHistoryOf(list.row(empty.skuCode, cj.name), 'ko');
      emptyLines = (await list.historyLines()).length;
    });

    await step('Assert: Expected 4 — The dialog shows an EMPTY table, not an error', async () => {
      expect(emptyLines, '[Expected 4] The table has no movement').toBe(0);
      await expect(list.history.rows.filter({ hasText: ko('empty.noResults') }), `[Expected 4] The empty table shows ${ko('empty.noResults')}`).toHaveCount(1);
      await expect(list.history.errorAlert, '[Expected 4] No error is shown').toHaveCount(0);
    });

    await step('Act: Step 5 — Click 엑셀 다운로드 (Excel download) for that pair, collect the file and count its header row and data rows', async () => {
      emptyOutcome = await list.exportHistory();
    });

    await step('Assert: Expected 5 — A file IS produced, holding the 10-column header row and 0 data rows', async () => {
      expect(emptyOutcome?.download, '[Expected 5] A file is produced, not an error').not.toBeNull();
      expect((emptyOutcome?.rows[0] ?? []).length, '[Expected 5] The header row has 10 columns').toBe(10);
      expect(StockAdjustmentUploadPage.dataRows(emptyOutcome?.rows ?? []).length, '[Expected 5] The file has 0 data rows').toBe(0);
    });
  });

  test('TC_US134_387 — The history export opens no confirmation or download-queued dialog', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_387',
      'Medium',
      TAGS,
      `엑셀 다운로드 in 재고이력 queues the export for the selected SKU × warehouse pair with no confirmation, destination, format-selection or download-queued dialog, and the 재고이력 dialog stays usable. Expected 1 of the TC states the queue result although the click is Step 2: the dialog is checked for the pair in Assert 1, and the queued call is checked (messages prefixed [Expected 1]) right after the click in Assert 2. ${SYNC_NOTE} ${OWN_HISTORY_NOTE}`,
    );
    const list = new StockAdjustmentUploadPage(page);
    const cj = world.warehouses.CJ;
    const { sku } = await ownPairWithHistory(world, 'X387', threeMovements());
    let outcome: ExportOutcome | undefined;
    let dialogs = -1;

    await step('Arrange: Pre-condition 1–2 — The own pair in CJ Incheon Aam holds movements', async () => {
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Open 재고이력 (Stock History) for the pair', async () => {
      await list.openHistoryOf(list.row(sku.skuCode, cj.name), 'ko');
    });

    await step('Assert: Expected 1 — The Stock History dialog is open for the selected SKU × warehouse pair, ready to queue its export', async () => {
      expect(await list.historyContext(), `[Expected 1] The dialog is for ${sku.skuCode}`).toContain(sku.skuCode);
      expect(await list.historyContext(), `[Expected 1] The dialog is for ${cj.name}`).toContain(cj.name);
      await expect(list.history.exportButton, '[Expected 1] 엑셀 다운로드 is offered for the pair').toBeEnabled();
    });

    await step('Act: Step 2 — Click 엑셀 다운로드 (Excel download) inside the dialog', async () => {
      outcome = await list.exportHistory();
      dialogs = await list.openModals.count();
    });

    await step('Assert: Expected 2 — No confirmation, destination, format-selection or download-queued dialog opens', async () => {
      expect(outcome?.requestUrl.searchParams.get('skuId'), '[Expected 1] The export is for the selected SKU').toBe(String(sku.skuId));
      expect(outcome?.requestUrl.searchParams.get('warehouseId'), '[Expected 1] The export is for the selected warehouse').toBe(String(cj.id));
      expect.soft(outcome && isSpreadsheetAnswer(outcome), '[Expected 1] The Stock History export is queued').toBe(false);
      expect(dialogs, '[Expected 2] Only the 재고이력 dialog is open — no confirmation, destination, format or download-queued dialog').toBe(1);
    });

    await step('Act: Step 3 — Check that the Stock History dialog can still be used', async () => {
      await expect(list.history.table, 'The history table is shown').toBeVisible();
    });

    await step('Assert: Expected 3 — The Stock History dialog remains usable', async () => {
      await expect(list.history.root, '[Expected 3] The dialog is still open').toBeVisible();
      await expect(list.history.exportButton, '[Expected 3] 엑셀 다운로드 is still usable').toBeEnabled();
      await expect(list.history.closeButton, '[Expected 3] 닫기 is still usable').toBeEnabled();
    });
  });
});
