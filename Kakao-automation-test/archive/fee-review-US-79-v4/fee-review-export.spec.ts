import * as fs from 'fs';
import type { Page } from '@playwright/test';
import { test, expect } from '@fixtures/fee-review.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { CYCLE, FIXTURE, RATE_MOVING, autoReason, parseCsv } from '@utils/fee-review.data';
import { FR_EN, FR_KO } from '@utils/fee-review.i18n';
import type { FeeReviewListPage } from '@pages/fee-review.page';

/**
 * US079 — nhóm [Export]: file list (15 cột) và báo cáo kỳ (19 cột) tải qua dialog 내보내기. Nội dung được đọc bằng CSV
 * (không có thư viện đọc .xlsx trong project → ý chỉ kiểm được trong file .xlsx ghi Not automated). Tải file không ghi dữ liệu;
 * riêng TC_116 tạo 1 correction chờ duyệt (dọn ở teardown).
 */
const TAGS = ['export', 'fee-review'];
const DEV = `Deviation: the TC's prototype seed does not exist on dev — cycle ${CYCLE.label} with the T079 fixtures is used.`;
const READ = 'Data: read-only (files are only downloaded).';
const LIST_HEADERS = [
  'Settlement period ‖ 정산 주기', 'Product ID ‖ 상품ID', 'Product name ‖ 상품명', 'Assigned vs resolved ‖ 지정 대조', 'Resolution status ‖ 산정 상태',
  'Correction state ‖ 수정 상태', 'Assigned category (commerce) ‖ 지정된 카테고리', 'Assigned contract row ‖ 지정된 계약 행', 'Resolved category ‖ 산정된 카테고리',
  'Resolved rate ‖ 산정 요율', 'Rate source ‖ 요율 출처', 'Rate basis (contract) ‖ 근거 계약', 'Basis effective from ‖ 적용 시작일', 'Contract family ‖ 계약 패밀리', 'Sales type ‖ 판매유형',
];
const REPORT_HEADERS = ['Settlement period', 'Change no.', 'Product ID', 'Product name', 'Tier', 'Fields changed', 'Category before', 'Category after', 'Rate before', 'Rate after', 'Applied?', 'Approval state', 'Maker', 'Submitted at', 'Approver', 'Decided at', 'Reason (maker)', 'Reject reason', 'Order lines affected'];
const DOWNLOADING = new RegExp(`${FR_KO['export.downloading']}|${FR_EN['export.downloading']}`);

/** Tải file từ dialog đang mở; trả tên file + nội dung (Buffer). `format` bỏ trống = giữ định dạng mặc định. */
async function download(list: FeeReviewListPage, format?: 'xlsx' | 'csv'): Promise<{ name: string; bytes: Buffer; ms: number }> {
  if (format) await list.exporter.chooseFormat(format);
  const started = Date.now();
  const file = await list.exporter.download();
  const ms = Date.now() - started;
  return { name: file.suggestedFilename(), bytes: fs.readFileSync((await file.path()) as string), ms };
}

/**
 * Bấm 내려받기 với định dạng mặc định và đo thời điểm file bắt đầu về. Chưa về sau 3 giây → ghi nhận nút có đang hiện
 * "내려받는 중" (chỉ báo đang chạy) hay không; về kịp thì `indicatorAt3s` = null (không áp dụng).
 */
async function timedDownload(page: Page, list: FeeReviewListPage): Promise<{ ms: number; indicatorAt3s: boolean | null }> {
  const downloaded = page.waitForEvent('download', { timeout: 30_000 });
  const early = page.waitForEvent('download', { timeout: 3_000 }).then(() => true, () => false);
  const started = Date.now();
  await list.exporter.downloadButton.click();
  const inTime = await early;
  const indicatorAt3s = inTime ? null : await list.exporter.downloadButton.filter({ hasText: DOWNLOADING }).isVisible();
  await downloaded;
  return { ms: Date.now() - started, indicatorAt3s };
}

/** Mở dialog export của báo cáo kỳ. */
async function openReportExport(list: FeeReviewListPage): Promise<void> {
  await list.openReport();
  await list.report.exportButton.click();
  await expect(list.exporter.root, 'The report export dialog opens').toBeVisible();
}

/** Chỉ số cột theo nửa tiếng Anh của header ("EN ‖ KO"). */
function col(header: string[], english: string): number {
  return header.findIndex((h) => h.split('‖')[0].trim() === english);
}

test.describe('[Export] Settlement fee review exports', () => {
  test.describe.configure({ timeout: 150_000 });

  test('TC_US079_111 — Exporting with a filter produces every matching row across all pages and the file name carries the cycle', async ({ page, feeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_111', 'High', TAGS, `With the list filtered to 기간 내 판매 상품 (spans two pages at 10 rows — the dev 확인 필요 set fits one page), the default export's name carries ${CYCLE.label} and a date stamp, and the file holds exactly the product IDs of every matching row across pages. Deviation: row content is read from the CSV export (no .xlsx reader in the project). ${DEV} ${READ}`);
    let xlsx: { name: string; bytes: Buffer; ms: number } = { name: '', bytes: Buffer.alloc(0), ms: 0 };
    let exported: string[] = [];
    let expected: string[] = [];

    await step('Arrange: Pre-condition 1–2 — The list is filtered and spans more than one page', async () => {
      const all = await feeReviewApi.products(CYCLE.id);
      expected = all.content.map((r) => r.productId).sort();
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL', pageSize: '10' });
      expect(await list.productIds(), 'Pre-condition: a full first page').toHaveLength(10);
      expect(all.totalElements, 'Pre-condition: the filter spans more than one page').toBeGreaterThan(10);
    });

    await step('Act: Step 1 — Click 목록 내보내기, keep the default format and click 내려받기', async () => {
      await list.openExport();
      xlsx = await download(list);
      await list.openExport();
      const rows = parseCsv((await download(list, 'csv')).bytes.toString('utf8'));
      const id = col(rows[0], 'Product ID');
      exported = rows.slice(1).map((r) => r[id]).sort();
    });

    await step('Assert: Expected 1 — Every matching row across every page is in the file', async () => {
      expect(exported.length, '[Expected 1] Every row of the filter (all pages)').toBe(expected.length);
      expect(exported, '[Expected 1] Exactly the product IDs of the filter across all pages').toEqual(expected);
    });

    await step('Assert: Expected 2 — The file name carries the settlement cycle and a date stamp', async () => {
      expect(xlsx.name, '[Expected 2] Cycle + date stamp').toMatch(new RegExp(`${CYCLE.label}_\\d{8}\\.xlsx$`));
    });
  });

  test('TC_US079_112 — The list export carries exactly its fifteen columns in order, each header English then Korean', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_112', 'Medium', TAGS, `The list export's header row reads, in order, the fifteen "EN ‖ KO" headers of the TC. Deviation: read from the CSV export. ${DEV} ${READ}`);
    let header: string[] = [];

    await step('Arrange: Pre-condition 1–2 — The open cycle is selected', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Export the list and open the file', async () => {
      await list.openExport();
      header = (parseCsv((await download(list, 'csv')).bytes.toString('utf8'))[0] ?? []).map((h) => h.trim());
    });

    await step('Assert: Expected 1 — Exactly the fifteen columns in order, each "EN ‖ KO"', async () => {
      LIST_HEADERS.forEach((name, i) => expect.soft(header[i], `[Expected 1] Column ${i + 1} reads "${name}"`).toBe(name));
      expect(header, '[Expected 1] Exactly fifteen columns, nothing else').toHaveLength(LIST_HEADERS.length);
    });
  });

  test('TC_US079_113 — The period report export carries exactly its nineteen columns in order and no money-delta column', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_113', 'Medium', TAGS, `The report export's header row holds the nineteen columns of the TC in order and no money-delta column. Deviation: read from the CSV export; headers are matched on their English half. ${DEV} ${READ}`);
    let header: string[] = [];

    await step('Arrange: Pre-condition 1–2 — The cycle holds several corrections', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Export the period change report and open the file', async () => {
      await openReportExport(list);
      header = (parseCsv((await download(list, 'csv')).bytes.toString('utf8'))[0] ?? []).map((h) => h.split('‖')[0].trim());
    });

    await step('Assert: Expected 1 — The nineteen columns in order', async () => {
      REPORT_HEADERS.forEach((name, i) => expect.soft(header[i], `[Expected 1] Column ${i + 1} reads "${name}"`).toBe(name));
      expect(header, '[Expected 1] Exactly nineteen columns').toHaveLength(REPORT_HEADERS.length);
    });

    await step('Assert: Expected 2 — No money-delta column', async () => {
      expect(header.filter((h) => /amount|money|금액|delta|차액/i.test(h)), '[Expected 2] No money-delta column').toEqual([]);
    });
  });

  test('TC_US079_114 — The period report export ignores the main-list filter and holds every correction of the cycle', async ({ page, feeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_114', 'Medium', TAGS, `With 확인 필요 applied on the main list, the period report export (BR-21.V8) holds every correction of the cycle — as many rows as the report's own total — including products outside 확인 필요; the export dialog's scope block shows no filter row and states the file covers the whole period. Deviation: the report may fit one page on dev; the file is downloaded as CSV (not the default .xlsx) so its rows can be read. ${DEV} ${READ}`);
    const scope = { filterRows: -1, noteVisible: false, rows: '' };
    let reportTotal = 0;
    let exported: string[] = [];
    let needsReview: string[] = [];

    await step('Arrange: Pre-condition 1–2 — 확인 필요 applied on the main list', async () => {
      needsReview = (await feeReviewApi.products(CYCLE.id, { bucket: 'NEEDS_REVIEW' })).content.map((r) => r.productId);
      await list.open({ cycleId: CYCLE.id, bucket: 'EXC' });
      await expect(list.chip('bucket.EXC'), 'Pre-condition: the 확인 필요 chip is applied').toHaveAttribute('aria-pressed', 'true');
    });

    await step('Act: Step 1 — With 확인 필요 applied, open 이번 기 수정 내역, export it and download (CSV read)', async () => {
      await list.openReport();
      reportTotal = Number(/(\d+)/.exec((await list.report.counter.textContent()) ?? '')?.[1] ?? 0);
      await list.report.exportButton.click();
      await expect(list.exporter.root, 'The report export dialog opens').toBeVisible();
      scope.filterRows = await list.exporter.scopeValue('export.filter').count();
      scope.noteVisible = await list.exporter.scopeReportNote.isVisible();
      scope.rows = ((await list.exporter.scopeValue('export.rows').textContent()) ?? '').trim();
      const rows = parseCsv((await download(list, 'csv')).bytes.toString('utf8'));
      const id = col(rows[0], 'Product ID');
      exported = rows.slice(1).map((r) => r[id]);
    });

    await step('Assert: Expected 1 — The file holds every correction of the cycle regardless of the main-list filter; the scope block shows no filter and covers the whole period', async () => {
      expect(reportTotal, '[Expected 1] The period report lists corrections').toBeGreaterThan(0);
      expect(exported.length, '[Expected 1] One row per correction of the cycle (report total)').toBe(reportTotal);
      expect.soft(scope.rows, '[Expected 1] The scope block row count equals the report total').toBe(String(reportTotal));
      expect.soft(exported.filter((id) => !needsReview.includes(id)).length, '[Expected 1] The file is not limited to 확인 필요 products').toBeGreaterThan(0);
      expect(scope.filterRows, '[Expected 1] The scope block shows no filter row in period-report mode').toBe(0);
      expect(scope.noteVisible, `[Expected 1] The scope block states "${FR_KO['export.scopeReport']}"`).toBe(true);
    });
  });

  test('TC_US079_115 — The file constraints: text product ID, rate with %, UTF-8 BOM CSV, effect by column, paired difference column', async ({ page, feeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_115', 'High', TAGS, `CSV: starts with a UTF-8 BOM and reads Korean correctly; the rate keeps its % sign; the report CSV's Applied? column marks every row Y/N with no formatting markup; "Assigned contract row" sits beside "Assigned vs resolved" and, for a mismatch product read from the API at runtime (replaces 900318), shows the exact assigned row next to Mismatch. Not automated: Expected 1 (.xlsx cell format of Product ID) — no .xlsx reader in the project. Deviation: Expected 2 is checked in the CSV (the .xlsx cell is not readable); the list CSV has no Applied? column, so Step 3 uses the period report CSV. ${DEV} ${READ}`);
    let csv: Buffer = Buffer.alloc(0);
    let rows: string[][] = [];
    let report: string[][] = [];
    let mismatchId = '';
    let xlsxName = '';
    const pair = { assignedVsResolved: -1, assignedRow: -1 };

    await step('Arrange: Pre-condition 1–2 — The open cycle is selected', async () => {
      mismatchId = (await feeReviewApi.products(CYCLE.id, { problem: 'ASSIGNED_NE_RESOLVED' })).content[0]?.productId ?? FIXTURE.mismatchWithDraft;
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Export the list as .xlsx and check the Product ID and rate cells', async () => {
      await list.openExport();
      xlsxName = (await download(list, 'xlsx')).name;
      test.info().annotations.push({ type: 'Not automated', description: `Step 1: ${xlsxName} downloaded — its cell formats need an .xlsx reader` });
    });

    await step('Assert: Expected 1 — Product ID opens as text in the .xlsx (Not automated)', async () => {
      expect(xlsxName, 'The .xlsx file was delivered').toMatch(/\.xlsx$/);
      test.info().annotations.push({ type: 'Not automated', description: 'Expected 1: .xlsx cell format — see Step 1' });
    });

    await step('Act: Step 2 — Export the list as .csv and open it as plain text', async () => {
      await list.openExport();
      csv = (await download(list, 'csv')).bytes;
      rows = parseCsv(csv.toString('utf8'));
    });

    await step('Assert: Expected 2 — The rate keeps its % sign as text', async () => {
      const rate = col(rows[0], 'Resolved rate');
      const rated = rows.slice(1).filter((r) => r[rate] && r[rate] !== '—');
      expect(rated.length, '[Expected 2] Rows carrying a resolved rate').toBeGreaterThan(0);
      for (const r of rated) expect.soft(r[rate], `[Expected 2] Rate of ${r[col(rows[0], 'Product ID')]} keeps its %`).toMatch(/%$/);
    });

    await step('Act: Step 3 — Check how a non-applied correction is distinguished in the .csv', async () => {
      await openReportExport(list);
      report = parseCsv((await download(list, 'csv')).bytes.toString('utf8'));
    });

    await step('Assert: Expected 3 — The .csv opens with correct Korean — the UTF-8 BOM is present', async () => {
      expect([...csv.subarray(0, 3)], '[Expected 3] UTF-8 BOM EF BB BF').toEqual([0xef, 0xbb, 0xbf]);
      expect(csv.toString('utf8'), '[Expected 3] Korean reads correctly').toContain('정산 주기');
    });

    await step('Act: Step 4 — Check that Assigned contract row sits beside Assigned vs resolved', async () => {
      pair.assignedVsResolved = col(rows[0], 'Assigned vs resolved');
      pair.assignedRow = col(rows[0], 'Assigned contract row');
    });

    await step('Assert: Expected 4 — The Applied? column is the sole way of telling a non-applied row apart (no formatting in CSV)', async () => {
      const applied = col(report[0], 'Applied?');
      expect(applied, '[Expected 4] The report CSV has an Applied? column').toBeGreaterThanOrEqual(0);
      const values = report.slice(1).map((r) => r[applied]?.trim());
      expect(values.filter((v) => !/^(Y|N)$/.test(v ?? '')), '[Expected 4] Every Applied? cell reads Y or N').toEqual([]);
      expect(values, '[Expected 4] At least one non-applied row (N)').toContain('N');
      expect(report.map((r) => r.join(',')).join('\n'), '[Expected 4] No formatting markup in the CSV').not.toMatch(/<s>|<del>|line-through/);
    });

    await step('Assert: Expected 5 — Assigned contract row shows the exact row beside Assigned vs resolved = Mismatch', async () => {
      expect(Math.abs(pair.assignedVsResolved - pair.assignedRow), '[Expected 5] The two columns sit side by side').toBe(1);
      const row = rows.find((r) => r[col(rows[0], 'Product ID')] === mismatchId);
      expect(row, `[Expected 5] ${mismatchId} is in the file`).toBeDefined();
      expect(row?.[pair.assignedVsResolved], `[Expected 5] ${mismatchId} reads Mismatch`).toMatch(new RegExp(`${FR_KO['compare.MISMATCH']}|${FR_EN['compare.MISMATCH']}`));
      expect(row?.[pair.assignedRow], `[Expected 5] ${mismatchId} shows the exact assigned row (family · type · rate)`).toMatch(/\S+ · \S+ · \d+(\.\d+)?%/);
    });
  });

  test('TC_US079_116 — Every status in either file uses the screen wording and no file carries a rule code or version', async ({ page, feeReviewApi, feeReviewState, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_116', 'Medium', TAGS, `Both CSV exports read statuses as the screen shows them — No row applies (적용 행 없음), not NOT_FOUND; Awaiting approval (승인 대기), not PENDING — filtering the file by on-screen wording returns the matching rows, and neither file carries a rule code, question code or version (NOT_FOUND, PENDING, STL-, BR-, OQ-, v1.x). The no-row product is read from the API at runtime (replaces 900154); a pending correction is created on ${FIXTURE.forSave} (replaces 880021). ${DEV} Data: the pending correction is withdrawn and discarded in teardown.`);
    const files: string[][][] = [];
    let noRow: string[] = [];
    let onScreen = '';

    await step('Arrange: Pre-condition 1–2 — The cycle holds products in several statuses, including No row applies and Awaiting approval', async () => {
      noRow = (await feeReviewApi.products(CYCLE.id, { problem: 'NO_ROW' })).content.map((r) => r.productId);
      expect(noRow.length, 'Pre-condition: a No row applies product exists').toBeGreaterThan(0);
      await feeReviewState.pending(feeReviewApi, FIXTURE.forSave, RATE_MOVING, autoReason('TC_US079_116', 'awaiting approval for the export wording'));
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Export both files and read every status cell', async () => {
      await list.openExport();
      files.push(parseCsv((await download(list, 'csv')).bytes.toString('utf8')));
      await openReportExport(list);
      files.push(parseCsv((await download(list, 'csv')).bytes.toString('utf8')));
    });

    await step('Assert: Expected 1 — Every status reads the screen wording, not the enum', async () => {
      const [lst] = files;
      const id = col(lst[0], 'Product ID');
      const status = lst.find((r) => r[id] === noRow[0])?.[col(lst[0], 'Resolution status')];
      const state = lst.find((r) => r[id] === FIXTURE.forSave)?.[col(lst[0], 'Correction state')];
      expect(status, `[Expected 1] ${noRow[0]} reads No row applies`).toMatch(new RegExp(`${FR_KO['bucket.NF']}|${FR_EN['bucket.NF']}`));
      expect(state, `[Expected 1] ${FIXTURE.forSave} reads Awaiting approval`).toMatch(new RegExp(`${FR_KO['state.PENDING']}|${FR_EN['state.PENDING']}`));
      const text = files.map((f) => f.map((r) => r.join(',')).join('\n')).join('\n');
      for (const raw of ['NOT_FOUND', 'PENDING', 'NO_ROW', 'NOT_COMPUTABLE', 'AMBIGUOUS', 'RESOLVED,', 'DRAFT', 'APPROVED']) {
        expect.soft(text, `[Expected 1] No raw status ${raw}`).not.toContain(raw);
      }
    });

    await step('Act: Step 2 — Filter the file for text seen on screen', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      onScreen = FR_KO['bucket.NF'];
      await expect(list.cell(list.row(noRow[0]), 'status'), `The screen shows "${onScreen}" for ${noRow[0]}`).toContainText(onScreen);
    });

    await step('Assert: Expected 2 — Filtering for on-screen text returns the matching rows', async () => {
      const [lst] = files;
      const id = col(lst[0], 'Product ID');
      const matched = lst.slice(1).filter((r) => r.some((c) => c.includes(onScreen))).map((r) => r[id]);
      expect(matched.length, '[Expected 2] Rows found by the on-screen wording').toBeGreaterThan(0);
      for (const p of noRow) expect.soft(matched, `[Expected 2] ${p} is returned by the on-screen wording`).toContain(p);
    });

    await step('Act: Step 3 — Search both files for internal codes and versions', async () => {
      expect(files.length, 'Both files read').toBe(2);
    });

    await step('Assert: Expected 3 — No rule code, question code or document version in either file', async () => {
      for (const [i, f] of files.entries()) {
        expect(f.map((r) => r.join(',')).join('\n'), `[Expected 3] ${i === 0 ? 'List' : 'Report'} file: no NOT_FOUND / STL- / BR- / OQ- / version`).not.toMatch(/NOT_FOUND|STL-\d|BR-\d|OQ-\d|\bv\d+\.\d+\b/);
      }
    });
  });

  test('TC_US079_117 — Filtering the list to Source needs fixing and exporting produces exactly that set', async ({ page, feeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_117', 'High', TAGS, `After clicking the 원천 수정 필요 chip, the export holds exactly the chip's set (same product IDs as the API and as many rows as the chip count). Deviation: 0 products sit in 원천 수정 필요 on dev — the file then carries the header only and the equality holds on an empty set. ${DEV} ${READ}`);
    let exported: string[] = [];
    let expected: string[] = [];
    let chipCount = 0;

    await step('Arrange: Pre-condition 1–2 — The Source needs fixing set is read', async () => {
      expected = (await feeReviewApi.products(CYCLE.id, { problem: 'SOURCE_NEEDS_FIXING' })).content.map((r) => r.productId).sort();
      if (!expected.length) test.info().annotations.push({ type: 'Deviation', description: 'Source needs fixing is empty on dev — the comparison runs on an empty set' });
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Click the 원천 수정 필요 chip and export the list', async () => {
      const chip = list.chip('bucket.SRCDIFF');
      await list.clickChip(chip);
      const n = await list.chipCount(chip);
      chipCount = Number.isNaN(n) ? 0 : n;
      await list.openExport();
      const rows = parseCsv((await download(list, 'csv')).bytes.toString('utf8'));
      const id = col(rows[0], 'Product ID');
      exported = rows.slice(1).map((r) => r[id]).sort();
    });

    await step('Assert: Expected 1 — The rows are exactly the Source needs fixing set', async () => {
      expect(exported, '[Expected 1] Same product IDs as the Source needs fixing set').toEqual(expected);
      expect(exported.length, '[Expected 1] As many rows as the 원천 수정 필요 chip count').toBe(chipCount);
    });
  });

  test('TC_US079_118 — An export starts delivering within three seconds and any export that runs longer says it is running until the file arrives', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_118', 'Medium', TAGS, `The list export and the report export each start delivering within 3 seconds of 내려받기 (default format); for any export not delivered by 3 seconds, the 내려받기 button reads 내려받는 중 (running indicator) at the 3-second mark. Not automated: the 3,000-product volume case (out of scope per the TC); the indicator is checked at the 3-second mark, not continuously until the file arrives. ${DEV} ${READ}`);
    const runs: Array<{ ms: number; indicatorAt3s: boolean | null }> = [];

    await step('Arrange: Pre-condition 1–2 — The cycle with ordinary data', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Click 목록 내보내기, keep the default format, click 내려받기 and time the delivery', async () => {
      await list.openExport();
      runs.push(await timedDownload(page, list));
    });

    await step('Assert: Expected 1 — The export starts delivering within 3 seconds', async () => {
      expect(runs[0].ms, '[Expected 1] List export starts delivering ≤ 3000 ms').toBeLessThanOrEqual(3000);
    });

    await step('Act: Step 2 — Repeat for 이번 기 수정 내역 via its own export', async () => {
      await openReportExport(list);
      runs.push(await timedDownload(page, list));
      test.info().annotations.push({ type: 'Observed', description: `export times ${runs.map((r) => r.ms).join(' / ')} ms` });
    });

    await step('Assert: Expected 2 — An export not delivered by 3 seconds shows a running indicator until the file arrives', async () => {
      expect.soft(runs[1].ms, '[Expected 2] Report export starts delivering ≤ 3000 ms (Step 2 repeats Step 1)').toBeLessThanOrEqual(3000);
      for (const [i, r] of runs.entries()) {
        const name = i === 0 ? 'List export' : 'Report export';
        if (r.indicatorAt3s === null) test.info().annotations.push({ type: 'Observed', description: `Expected 2: ${name} delivered in ${r.ms} ms — the running indicator was not needed` });
        else expect.soft(r.indicatorAt3s, `[Expected 2] ${name} not delivered by 3 s shows 내려받는 중 (running)`).toBe(true);
      }
    });
  });
});
