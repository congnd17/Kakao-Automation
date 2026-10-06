import * as fs from 'fs';
import type { Download, Page } from '@playwright/test';
import { test, expect } from '@fixtures/fee-review-v1.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { FR_EN, FR_KO } from '@utils/fee-review.i18n';
import { family, product, reasonOf, type ProductCode } from '@utils/fee-review-v1.data';
import { feeReviewDb } from '@utils/fee-review-db';
import type { CategoryKey, ProductDef, Seeded } from '@utils/fee-review-seed';
import type { FeeReviewApi, Policy } from '@api/fee-review.api';
import type { FeeReviewListPage } from '@pages/fee-review.page';
import type { RowDataPacket } from 'mysql2/promise';
import { EXPORT_URL, FeeReviewExportPage } from '@pages/fee-review-v1/export.page';

/**
 * US079 v1 — nhóm [Export] (TC_US079_161–172): file list (15 cột) và báo cáo kỳ (19 cột) tải qua dialog 내보내기.
 * - Export phủ TOÀN cycle → TC đọc nội dung / số dòng file dùng cycle riêng (`private: true`); TC chỉ đọc header dùng chung.
 * - Project không có thư viện đọc .xlsx (không thêm dependency) → file .xlsx chỉ kiểm "là file Excel" (tên + chữ ký ZIP `PK`);
 *   nội dung của chính lần export đó đọc bằng CSV mà BE trả cho CÙNG request (cùng cycle / bucket / keyword, chỉ đổi format).
 * - Correction / trình / duyệt / trả lại của pre-condition làm qua API (TOKEN_A = submitter, TOKEN_B = approver).
 */
const TAGS = ['export', 'fee-review'];
const COMMON =
  'Deviation (all TCs): the screen is opened by URL with the seeded cycle id instead of through the side menu; the cycle is the next free month from 2100 instead of Y = 2100 + 200 × RUN + N; corrections, submissions and approvals of the pre-conditions are made through the API.';
const XLSX_NOTE =
  'Not automated: opening the .xlsx in Excel (the project has no .xlsx reader) — each .xlsx export is checked as a delivered Excel file (name + ZIP signature) and its rows are read from the CSV the server returns for the same export request (same cycle, filter and keyword, format=csv).';

const LIST_HEADERS = [
  'Settlement period ‖ 정산 주기', 'Product ID ‖ 상품ID', 'Product name ‖ 상품명', 'Assigned vs resolved ‖ 지정 대조', 'Resolution status ‖ 산정 상태',
  'Correction state ‖ 수정 상태', 'Assigned category (commerce) ‖ 지정된 카테고리', 'Assigned contract row ‖ 지정된 계약 행', 'Resolved category ‖ 산정된 카테고리',
  'Resolved rate ‖ 산정 요율', 'Rate source ‖ 요율 출처', 'Rate basis (contract) ‖ 근거 계약', 'Basis effective from ‖ 적용 시작일', 'Contract family ‖ 계약 패밀리', 'Sales type ‖ 판매유형',
];
const PERIOD_HEADERS = [
  'Settlement period ‖ 정산 주기', 'Change no. ‖ 변경 번호', 'Product ID ‖ 상품ID', 'Product name ‖ 상품명', 'Tier ‖ 수정 단계', 'Fields changed ‖ 변경 항목',
  'Category before ‖ 변경 전 카테고리', 'Category after ‖ 변경 후 카테고리', 'Rate before ‖ 변경 전 요율', 'Rate after ‖ 변경 후 요율', 'Applied? ‖ 적용 여부',
  'Approval state ‖ 승인 상태', 'Maker ‖ 기안자', 'Submitted at ‖ 상신 일시', 'Approver ‖ 승인자', 'Decided at ‖ 결정 일시', 'Reason (maker) ‖ 사유(기안자)',
  'Reject reason ‖ 반려 사유', 'Order lines affected ‖ 영향 주문 라인 수',
];

function esc(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** Chữ màn hình theo cả 2 ngôn ngữ (file có thể ghi KO hoặc EN). */
const word = (key: keyof typeof FR_KO): RegExp => new RegExp(`^(${esc(FR_KO[key])}|${esc(FR_EN[key])})$`);
const HAND_KEYED = word('lbl.handKeyed');
const CONTRACT_SOURCE = /^(Contract|계약)$/;
type CountRow = RowDataPacket & { n: number };

/** Ngày export theo giờ máy chạy: `YYYYMMDD` hoặc `YYYY-MM-DD`. */
function dateStamp(): RegExp {
  const d = new Date();
  const y = String(d.getFullYear());
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return new RegExp(`${y}${m}${day}|${y}-${m}-${day}`);
}

// ─── Đọc file export ────────────────────────────────────────────────────────────────────────────────────────────────

interface Csv {
  header: string[];
  rows: string[][];
  text: string;
}

/** CSV RFC 4180 (dấu phẩy, ngoặc kép, xuống dòng trong ô); bỏ BOM đầu file và dòng rỗng. */
function readCsv(text: string): Csv {
  const all: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      all.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    all.push(row);
  }
  const lines = all.filter((r) => r.some((c) => c.trim() !== ''));
  return { header: (lines[0] ?? []).map((h) => h.trim()), rows: lines.slice(1), text: src };
}

/** Giá trị ô theo nửa tiếng Anh của header ("EN ‖ KO"). */
function cellOf(csv: Csv, row: string[] | undefined, english: string): string | undefined {
  const i = csv.header.findIndex((h) => h.split('‖')[0].trim() === english);
  return i < 0 || !row ? undefined : row[i]?.trim();
}

function rowsOf(csv: Csv, productId: string): string[][] {
  return csv.rows.filter((r) => cellOf(csv, r, 'Product ID') === productId);
}

function idsOf(csv: Csv): string[] {
  return csv.rows.map((r) => cellOf(csv, r, 'Product ID') ?? '').sort();
}

/** Nửa tiếng Anh của header ở vị trí cột `n` (đếm từ 1). */
function headerAt(csv: Csv, n: number): string {
  return (csv.header[n - 1] ?? '').split('‖')[0].trim();
}

interface Exported {
  name: string;
  bytes: Buffer;
  cycleId: number;
  kind: 'products' | 'corrections';
  /** Query của request export (bỏ `format`) — dùng lấy bản CSV của cùng lần export. */
  query: Record<string, string>;
}

function isXlsx(file: Exported): boolean {
  return file.bytes.length > 4 && file.bytes[0] === 0x50 && file.bytes[1] === 0x4b;
}

/** Bấm 내려받기 trong dialog đang mở (đổi định dạng nếu có), chờ file về và ghi lại request export của FE. */
async function downloadExport(page: Page, list: FeeReviewListPage, format?: 'xlsx' | 'csv'): Promise<Exported> {
  if (format) await list.exporter.chooseFormat(format);
  const requested = page.waitForRequest((r) => EXPORT_URL.test(r.url()), { timeout: 30_000 });
  const file: Download = await list.exporter.download();
  const url = new URL((await requested).url());
  const [, cycleId, kind] = EXPORT_URL.exec(url.href) as RegExpExecArray;
  const query = Object.fromEntries(url.searchParams.entries());
  delete query.format;
  return { name: file.suggestedFilename(), bytes: fs.readFileSync((await file.path()) as string), cycleId: Number(cycleId), kind: kind as Exported['kind'], query };
}

/** Bản CSV mà BE trả cho cùng request export (chỉ đổi format) — đọc nội dung của 1 lần export .xlsx. */
async function csvTwin(api: FeeReviewApi, file: Exported): Promise<Csv> {
  const { status, text } = await api.exportCsv(file.cycleId, file.kind, file.query);
  if (status !== 200) throw new Error(`GET ${file.kind}/export?format=csv → ${status}`);
  return readCsv(text);
}

/** Đọc khối 내보낼 범위 (sau khi số dòng đã hiện). */
async function scopeOf(list: FeeReviewListPage): Promise<{ period: string; filter: string | null; rows: string }> {
  await expect(list.exporter.scopeValue('export.rows'), 'The scope block shows its row count').toHaveText(/\S/);
  const text = async (key: 'export.period' | 'export.filter' | 'export.rows') => ((await list.exporter.scopeValue(key).textContent()) ?? '').trim();
  return { period: await text('export.period'), filter: (await list.exporter.scopeValue('export.filter').count()) ? await text('export.filter') : null, rows: await text('export.rows') };
}

/** Mở dialog export của báo cáo kỳ (báo cáo đang mở). */
async function openPeriodExport(list: FeeReviewListPage): Promise<void> {
  await test.step('Click 내보내기 (Export) in the Changes this period dialog', () => list.report.exportButton.click());
  await expect(list.exporter.root, 'The period export dialog opens').toBeVisible();
}

/** Gõ từ khoá (rỗng = xoá) rồi nhấn Enter như TC, chờ list tải lại. */
async function searchByEnter(list: FeeReviewListPage, keyword: string): Promise<void> {
  await list.keywordInput.fill(keyword);
  await list.untilListed(() => list.keywordInput.press('Enter'));
}

// ─── Dựng dữ liệu ───────────────────────────────────────────────────────────────────────────────────────────────────

/** 1 sản phẩm theo mẫu TC với số sale line trên CY_MAIN (policy theo mẫu: P09 = PROMOTION). */
function p(code: ProductCode, saleLines: number): ProductDef {
  return product(code, [{ cycle: 'CY_MAIN', saleLines }]);
}

/** Dòng target không có dòng sản phẩm (P99 của TC) — dọn theo tiền tố ở teardown của `seedData`. */
async function targetOnly(s: Seeded, code: string, saleLines: number): Promise<void> {
  await feeReviewDb.insertTargets([{ cycleId: s.cycles.CY_MAIN.id, productId: `${s.prefix}${code}`, policy: 'NORMAL', saleLineCount: saleLines }]);
}

async function tier1(api: FeeReviewApi, s: Seeded, code: string, category: CategoryKey, reason: string, policy: Policy = 'NORMAL'): Promise<{ id: string; state?: string }> {
  const { status, body } = await api.save(s.cycles.CY_MAIN.id, s.products[code], { policy, tier: 'ASSIGNMENT', commissionCategoryId: s.master.category[category], reason });
  if (status >= 300 || !body?.correctionId) throw new Error(`Save tier 1 on ${code} → ${status}: ${JSON.stringify(body).slice(0, 200)}`);
  return { id: body.correctionId, state: body.state };
}

async function tier2(api: FeeReviewApi, s: Seeded, code: string, rate: string, reason: string): Promise<string> {
  const { status, body } = await api.save(s.cycles.CY_MAIN.id, s.products[code], { policy: 'NORMAL', tier: 'RATE_OVERRIDE', overrideRate: rate, reason });
  if (status >= 300 || !body?.correctionId) throw new Error(`Save tier 2 on ${code} → ${status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body.correctionId;
}

async function submit(api: FeeReviewApi, ids: string[]): Promise<void> {
  const { status, body } = await api.submit(ids);
  if (status >= 300) throw new Error(`Submit ${ids.join(', ')} → ${status}: ${JSON.stringify(body).slice(0, 200)}`);
}

/** Request 변경 승인 (Fee Rule, PENDING) của sản phẩm — đọc bằng TOKEN_B; khớp mã sản phẩm (duy nhất theo RUN) trong item / chi tiết. */
async function approvalFor(approver: FeeReviewApi, productId: string): Promise<number> {
  const pending = (await approver.feeRuleApprovals()).filter((a) => a.approvalStatus === 'PENDING');
  const direct = pending.find((a) => JSON.stringify(a).includes(productId));
  if (direct) return direct.id;
  for (const a of pending.slice(0, 40)) {
    if (JSON.stringify((await approver.approval(a.id)).body).includes(productId)) return a.id;
  }
  throw new Error(`No pending Fee Rule approval found for ${productId}`);
}

async function decide(approver: FeeReviewApi, productId: string, decision: 'approve' | 'reject'): Promise<void> {
  const id = await approvalFor(approver, productId);
  const { status } = decision === 'approve' ? await approver.approve(id) : await approver.reject(id, '근거 계약 확인 필요');
  if (status >= 300) throw new Error(`${decision} the approval of ${productId} → ${status}`);
}

test.describe('[Export] Settlement fee review exports (US079 v1)', () => {
  test.describe.configure({ timeout: 240_000 });

  test('TC_US079_161 — The list export follows the filter in force and covers every page', async ({ page, feeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const ex = new FeeReviewExportPage(page, list);
    await tcMeta(
      'TC_US079_161',
      'High',
      TAGS,
      `With 13 rows in the cycle (10 per page), the list export's scope block names the period, the filter and 13 rows with the "every page" sentence; the file holds all 13 rows including the 3 on page 2; with Needs review it holds exactly the 8 Needs review rows; with keyword T079-<RUN>-161-P0 the scope names the keyword and the file holds the 8 matching rows. ${XLSX_NOTE} Known build issue (TC remark): the FE scope block omits the keyword — Expected 5 is expected to fail. Data: own cycle; P99 is a target row without a product row. ${COMMON}`,
    );
    let s!: Seeded;
    let label = '';
    let all: string[] = [];
    let needsReview: string[] = [];
    let pageOne: string[] = [];
    let first!: Exported;
    let firstCsv!: Csv;
    let second!: Csv;
    let third!: Exported;
    let thirdCsv!: Csv;
    let scope4!: { period: string; filter: string | null; rows: string };
    let scope5!: { period: string; filter: string | null; rows: string };
    let keyword = '';

    await step('Arrange: Pre-condition 1–14 — ROOT / ANNEX1 / ANNEX2 family, own cycle CY_MAIN with 13 rows (8 Needs review, P99 target only), no correction', async () => {
      s = await seedData({
        tc: 161,
        private: true,
        cycles: ['CY_MAIN'],
        contracts: family({ ROOT: ['R_A', 'R_B10', 'R_PROMO'], ANNEX1: ['R_B9', 'R_C20'], ANNEX2: ['R_C22'] }),
        products: [
          product('P01', [{ cycle: 'CY_MAIN', saleLines: 3 }, { cycle: 'CY_MAIN', policy: 'PROMOTION', saleLines: 2 }]),
          p('P02', 40), p('P03', 77), p('P04', 114), p('P05', 151), p('P06', 188), p('P09', 49), p('P10', 86), p('P12', 160), p('P13', 197), p('P14', 234),
        ],
      });
      await targetOnly(s, 'P99', 5);
      label = s.cycles.CY_MAIN.label;
      keyword = `${s.prefix}P0`;
      const listed = await feeReviewApi.products(s.cycles.CY_MAIN.id, { keyword: s.prefix.slice(0, -1), size: 100 });
      expect(listed.totalElements, 'Pre-condition 12: 13 rows in the cycle').toBe(13);
      expect(listed.buckets.needsReview, 'Pre-condition 12: 8 Needs review rows').toBe(8);
      all = listed.content.map((r) => r.productId);
      needsReview = (await feeReviewApi.products(s.cycles.CY_MAIN.id, { bucket: 'NEEDS_REVIEW' })).content.map((r) => r.productId).sort();
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN, click 기간 내 판매 상품 (Products sold in period), keep 10 rows per page on page 1', async () => {
      await list.open({ cycleId: s.cycles.CY_MAIN.id, bucket: 'ALL', pageSize: '10' });
      await list.clickChip(list.chip('bucket.ALL'));
      pageOne = await list.productIds();
    });

    await step('Assert: Expected 1 — Page 1 shows 10 rows; the total reads 13', async () => {
      await expect(list.rows, '[Expected 1] Page 1 shows 10 rows').toHaveCount(10);
      await expect(list.counter, '[Expected 1] The total reads 13').toHaveText(/^총 13개의/);
    });

    await step('Act: Step 2 — Click 목록 내보내기 (Export list)', async () => {
      await list.openExport();
    });

    await step('Assert: Expected 2 — Dialog 내보내기 shows Period, Filter Products sold in period, Rows 13 and the "every page" sentence', async () => {
      await expect(list.exporter.title, '[Expected 2] Dialog title 내보내기 (Export)').toHaveText(word('export.title'));
      await expect(list.exporter.scopeValue('export.period'), `[Expected 2] 정산 주기 (Period) ${label}`).toHaveText(label);
      await expect(list.exporter.scopeValue('export.filter'), '[Expected 2] 필터 (Filter) 기간 내 판매 상품 (Products sold in period)').toHaveText(word('bucket.ALL'));
      await expect(list.exporter.scopeValue('export.rows'), '[Expected 2] 행 수 (Rows) 13').toHaveText('13');
      await expect(ex.scopeListNote, '[Expected 2] The "every page, not just the page on screen" sentence').toHaveText(word('export.scopeList'));
    });

    await step('Act: Step 3 — Keep Excel (.xlsx), click 내려받기 (Download) and open the file', async () => {
      first = await downloadExport(page, list);
      firstCsv = await csvTwin(feeReviewApi, first);
    });

    await step('Assert: Expected 3 — The file holds 13 data rows, including the 3 rows on page 2 of the screen', async () => {
      expect(first.name, '[Expected 3] An Excel (.xlsx) file is delivered').toMatch(/\.xlsx$/);
      expect(isXlsx(first), '[Expected 3] The file is an Excel workbook (ZIP signature PK)').toBe(true);
      expect(firstCsv.rows.length, '[Expected 3] The file holds 13 data rows').toBe(13);
      const rest = [...all];
      for (const id of pageOne) rest.splice(rest.indexOf(id), 1);
      expect(rest.length, '[Expected 3] 3 rows sit on page 2 of the screen').toBe(3);
      for (const id of rest) expect.soft(idsOf(firstCsv), `[Expected 3] Page-2 row ${id} is in the file`).toContain(id);
    });

    await step('Act: Step 4 — Close the dialog, click 확인 필요 (Needs review), export the list as CSV (.csv) and open the file', async () => {
      await ex.closeIfOpen();
      await list.clickChip(list.chip('bucket.EXC'));
      await list.openExport();
      scope4 = await scopeOf(list);
      second = readCsv((await downloadExport(page, list, 'csv')).bytes.toString('utf8'));
    });

    await step('Assert: Expected 4 — Scope reads Filter Needs review, Rows 8; the file holds exactly the 8 Needs review rows', async () => {
      expect(scope4.filter, '[Expected 4] 필터 (Filter) 확인 필요 (Needs review)').toMatch(word('bucket.EXC'));
      expect(scope4.rows, '[Expected 4] 행 수 (Rows) 8').toBe('8');
      expect(second.rows.length, '[Expected 4] The file holds 8 rows').toBe(8);
      for (const code of ['P03', 'P04', 'P05', 'P06', 'P10', 'P12', 'P13', 'P99']) {
        expect.soft(idsOf(second), `[Expected 4] Needs review row ${code} is in the file`).toContain(`${s.prefix}${code}`);
      }
      expect(idsOf(second), '[Expected 4] Exactly the Needs review rows of the cycle').toEqual(needsReview);
    });

    await step(`Act: Step 5 — Click 기간 내 판매 상품, type T079-<RUN>-161-P0 in 검색어 (Keyword), press Enter and export the list as Excel (.xlsx)`, async () => {
      await ex.closeIfOpen();
      await list.clickChip(list.chip('bucket.ALL'));
      await searchByEnter(list, keyword);
      await list.openExport();
      scope5 = await scopeOf(list);
      third = await downloadExport(page, list, 'xlsx');
      thirdCsv = await csvTwin(feeReviewApi, third);
    });

    await step('Assert: Expected 5 — The scope names the filter including the keyword; the file holds the 8 rows matching both', async () => {
      expect.soft(scope5.filter ?? '', `[Expected 5] 필터 (Filter) names the keyword ${keyword}`).toContain(keyword);
      expect(isXlsx(third), '[Expected 5] An Excel (.xlsx) file is delivered').toBe(true);
      expect(thirdCsv.rows.length, '[Expected 5] The file holds 8 rows').toBe(8);
      expect(rowsOf(thirdCsv, s.products.P01).length, '[Expected 5] P01 NORMAL and P01 PROMOTION are both in the file').toBe(2);
      for (const code of ['P02', 'P03', 'P04', 'P05', 'P06', 'P09']) {
        expect.soft(rowsOf(thirdCsv, s.products[code]).length, `[Expected 5] ${code} is in the file`).toBe(1);
      }
    });
  });

  test('TC_US079_162 — The list export has the 15 columns in order with EN ‖ KO headers', async ({ page, feeReviewApi, approverFeeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US079_162',
      'Medium',
      TAGS,
      `The list CSV header holds exactly the 15 "EN ‖ KO" columns of BR-21.V5 in order, and the Excel export carries the same header. ${XLSX_NOTE} Data: shared cycle (only the header is read); P14 carries an approved tier-1 correction. ${COMMON}`,
    );
    let s!: Seeded;
    let csvFile!: Exported;
    let csv!: Csv;
    let xlsx!: Exported;
    let xlsxCsv!: Csv;

    await step('Arrange: Pre-condition 1–16 — ROOT / ANNEX1 family, CY_MAIN with P14 carrying an approved tier-1 correction to B', async () => {
      s = await seedData({ tc: 162, cycles: ['CY_MAIN'], contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }), products: [p('P14', 234)] });
      const x = await tier1(feeReviewApi, s, 'P14', 'B', reasonOf('TC_US079_162', '카테고리 오매핑 정정'));
      await submit(feeReviewApi, [x.id]);
      await decide(approverFeeReviewApi, s.products.P14, 'approve');
      const row = await feeReviewApi.row(s.cycles.CY_MAIN.id, s.products.P14);
      expect(row.inForceRate, 'Pre-condition 13: P14 in-force rate 9.00').toBe('9.00');
      expect(row.correction?.state, 'Pre-condition 13: P14 correction APPROVED').toBe('APPROVED');
    });

    await step('Act: Step 1 — Open CY_MAIN, click 기간 내 판매 상품, click 목록 내보내기, choose CSV (.csv) and click 내려받기', async () => {
      await list.open({ cycleId: s.cycles.CY_MAIN.id, bucket: 'ALL' });
      await list.openExport();
      csvFile = await downloadExport(page, list, 'csv');
    });

    await step('Assert: Expected 1 — A CSV file downloads', async () => {
      expect(csvFile.name, '[Expected 1] The saved file is a .csv').toMatch(/\.csv$/);
      expect(csvFile.bytes.length, '[Expected 1] The CSV file is not empty').toBeGreaterThan(0);
    });

    await step('Act: Step 2 — Open the CSV as text and read the header line', async () => {
      csv = readCsv(csvFile.bytes.toString('utf8'));
    });

    await step('Assert: Expected 2 — The header holds exactly 15 columns in order', async () => {
      LIST_HEADERS.forEach((name, i) => expect.soft(csv.header[i], `[Expected 2] Column ${i + 1} reads "${name}"`).toBe(name));
      expect(csv.header, '[Expected 2] Exactly 15 columns').toHaveLength(15);
    });

    await step('Act: Step 3 — Export the same list as Excel (.xlsx) and read row 1', async () => {
      await new FeeReviewExportPage(page, list).closeIfOpen();
      await list.openExport();
      xlsx = await downloadExport(page, list, 'xlsx');
      xlsxCsv = await csvTwin(feeReviewApi, xlsx);
    });

    await step('Assert: Expected 3 — Row 1 of the Excel file holds the same 15 headers in the same order', async () => {
      expect(isXlsx(xlsx), '[Expected 3] An Excel (.xlsx) file is delivered').toBe(true);
      LIST_HEADERS.forEach((name, i) => expect.soft(xlsxCsv.header[i], `[Expected 3] Excel header ${i + 1} reads "${name}"`).toBe(name));
      expect(xlsxCsv.header, '[Expected 3] Same 15 headers as the CSV').toEqual(csv.header);
    });
  });

  test('TC_US079_163 — The period export holds every correction of the cycle whatever filter or search is applied', async ({ page, feeReviewApi, approverFeeReviewApi, contractsApi, approverContractsApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const ex = new FeeReviewExportPage(page, list);
    await tcMeta(
      'TC_US079_163',
      'High',
      TAGS,
      `With the list narrowed to P03 (Needs review + keyword), 이번 기 수정 내역 lists all six corrections of the cycle (applied, approved, retired, rejected, withdrawn, awaiting approval); its export dialog shows Period and Rows 6 with no Filter line and the period-close sentence, and both the Excel and the CSV export hold the same 6 rows with Applied? and Approval state. ${XLSX_NOTE} Data: own cycle; row R_A8 is added to ROOT (approved by TOKEN_B) to retire Y2. ${COMMON}`,
    );
    let s!: Seeded;
    let label = '';
    const codes = ['P05', 'P14', 'P10', 'P03', 'P04', 'P09'];
    let xlsx!: Exported;
    let xlsxCsv!: Csv;
    let csv!: Csv;

    await step('Arrange: Pre-condition 1–25 — Own cycle CY_MAIN with six corrections: X5 applied, X approved, Y2 retired, Y rejected, X4 withdrawn, X9 awaiting approval', async () => {
      s = await seedData({
        tc: 163,
        private: true,
        cycles: ['CY_MAIN'],
        contracts: family({ ROOT: ['R_A', 'R_B10', 'R_PROMO', 'R_D'], ANNEX1: ['R_B9', 'R_C20'], ANNEX2: ['R_C22'] }),
        products: [p('P03', 77), p('P04', 114), p('P05', 151), p('P09', 49), p('P10', 86), p('P14', 234)],
      });
      label = s.cycles.CY_MAIN.label;
      const x5 = await tier1(feeReviewApi, s, 'P05', 'D', reasonOf('TC_US079_163', 'Wrong category mapped in commerce'));
      expect(x5.state, 'Pre-condition 11: X5 applies at once').toBe('APPLIED');
      const x = await tier1(feeReviewApi, s, 'P14', 'B', reasonOf('TC_US079_163', '카테고리 오매핑 정정'));
      const y2 = await tier2(feeReviewApi, s, 'P10', '6.75', reasonOf('TC_US079_163', 'Side letter rate agreed with the label'));
      const y = await tier1(feeReviewApi, s, 'P03', 'A', reasonOf('TC_US079_163', 'Wrong category mapped in commerce'));
      const x4 = await tier1(feeReviewApi, s, 'P04', 'A', reasonOf('TC_US079_163', 'Ambiguous rows — use ALBUM until the contract is fixed'));
      const x9 = await tier1(feeReviewApi, s, 'P09', 'A', reasonOf('TC_US079_163', 'Promotion ended — use ALBUM'), 'PROMOTION');
      await submit(feeReviewApi, [x.id, y2, y.id, x4.id, x9.id]);
      await decide(approverFeeReviewApi, s.products.P14, 'approve');
      await decide(approverFeeReviewApi, s.products.P10, 'approve');
      await decide(approverFeeReviewApi, s.products.P03, 'reject');
      expect((await feeReviewApi.withdraw(x4.id)).status, 'Pre-condition 20: X4 is withdrawn').toBe(204);
      const added = await contractsApi.addFeeRow(s.family.contracts.ROOT, {
        key: { categoryId: s.master.category.A, saleTypeId: s.master.saleType.ST2, policy: 'NORMAL' },
        commissionType: 'PERCENT',
        commission: 8,
        effectiveFrom: '2020-01-01',
        pgCommissionRate: 3,
        feeBase: 'PRODUCT_PRICE',
        pgFeeBase: 'PRODUCT_PRICE',
        changeReason: '[T079] R_A8',
      });
      expect(added.status, 'Pre-condition 21: row R_A8 is added').toBeLessThan(300);
      expect(added.body?.changeApprovalId, 'Pre-condition 21: R_A8 waits for approval').toBeTruthy();
      expect((await approverContractsApi.approve(Number(added.body.changeApprovalId))).status, 'Pre-condition 21: R_A8 is approved').toBeLessThan(300);
      // Lượt đọc list này làm Y2 tự hết hiệu lực (RETIRED) vì R_A8 đã có hiệu lực — pre-condition 21.
      await feeReviewApi.products(s.cycles.CY_MAIN.id, { keyword: s.prefix.slice(0, -1) });
      expect((await feeReviewApi.products(s.cycles.CY_MAIN.id, { keyword: s.prefix.slice(0, -1) })).totalElements, 'Pre-condition 22: 6 rows').toBe(6);
      expect((await feeReviewApi.periodCorrections(s.cycles.CY_MAIN.id)).length, 'Pre-condition 23: 6 corrections in the cycle').toBe(6);
    });

    await step('Act: Step 1 — Open CY_MAIN, keep 확인 필요 (Needs review), type T079-<RUN>-163-P03 in 검색어 and press Enter', async () => {
      await list.open({ cycleId: s.cycles.CY_MAIN.id, bucket: 'EXC' });
      await searchByEnter(list, s.products.P03);
    });

    await step('Assert: Expected 1 — The list shows only P03', async () => {
      expect(await list.productIds(), '[Expected 1] Only P03 is listed').toEqual([s.products.P03]);
    });

    await step('Act: Step 2 — Click 이번 기 수정 내역 (Changes this period)', async () => {
      await list.openReport();
      await list.report.showLatest();
    });

    await step('Assert: Expected 2 — The report lists all six corrections, not only P03', async () => {
      await expect(list.report.rows, '[Expected 2] Six corrections are listed').toHaveCount(6);
      for (const code of codes) await expect.soft(list.report.rows.filter({ hasText: s.products[code] }), `[Expected 2] The correction of ${code} is listed`).toHaveCount(1);
    });

    await step('Act: Step 3 — Click 내보내기 (Export)', async () => {
      await openPeriodExport(list);
    });

    await step('Assert: Expected 3 — Dialog shows Period and Rows 6, no Filter line, and the period-close sentence', async () => {
      await expect(list.exporter.scopeValue('export.period'), `[Expected 3] 정산 주기 (Period) ${label}`).toHaveText(label);
      await expect(list.exporter.scopeValue('export.rows'), '[Expected 3] 행 수 (Rows) 6').toHaveText('6');
      await expect(list.exporter.scopeValue('export.filter'), '[Expected 3] No 필터 (Filter) line').toHaveCount(0);
      await expect(list.exporter.scopeReportNote, '[Expected 3] The "every correction in this period" sentence').toHaveText(word('export.scopeReport'));
    });

    await step('Act: Step 4 — Keep Excel (.xlsx), click 내려받기 (Download) and open the file', async () => {
      xlsx = await downloadExport(page, list);
      xlsxCsv = await csvTwin(feeReviewApi, xlsx);
    });

    await step('Assert: Expected 4 — The file holds 6 rows (P05, P14, P10, P03, P04, P09), each with Applied? Y or N and its Approval state', async () => {
      expect(isXlsx(xlsx), '[Expected 4] An Excel (.xlsx) file is delivered').toBe(true);
      expect(xlsxCsv.rows.length, '[Expected 4] The file holds 6 rows').toBe(6);
      for (const code of codes) {
        const row = rowsOf(xlsxCsv, s.products[code])[0];
        expect.soft(row, `[Expected 4] ${code} is in the file`).toBeDefined();
        expect.soft(cellOf(xlsxCsv, row, 'Applied?'), `[Expected 4] ${code} Applied? is Y or N`).toMatch(/^(Y|N)$/);
        expect.soft(cellOf(xlsxCsv, row, 'Approval state') ?? '', `[Expected 4] ${code} carries its Approval state`).toMatch(/\S/);
      }
    });

    await step('Act: Step 5 — Close the dialogs, clear the keyword, click 원천 수정 필요 (Source needs fixing), open 이번 기 수정 내역 and export again as CSV (.csv)', async () => {
      await ex.closeIfOpen();
      await list.report.close();
      await searchByEnter(list, '');
      await list.clickChip(list.chip('bucket.SRCDIFF'));
      await list.openReport();
      await openPeriodExport(list);
      csv = readCsv((await downloadExport(page, list, 'csv')).bytes.toString('utf8'));
    });

    await step('Assert: Expected 5 — The second file holds the same 6 rows', async () => {
      expect(csv.rows.length, '[Expected 5] The second file holds 6 rows').toBe(6);
      expect(idsOf(csv), '[Expected 5] Same rows as the first file').toEqual(idsOf(xlsxCsv));
    });
  });

  test('TC_US079_164 — The period export has the 19 columns in order', async ({ page, feeReviewApi, approverFeeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US079_164',
      'Medium',
      TAGS,
      `The period-report CSV header holds exactly the 19 "EN ‖ KO" columns of BR-21.V5 in order (KO halves are Dev-proposed, DEV-32), and the Excel export carries the same header. ${XLSX_NOTE} Data: shared cycle (only the header is read); P14 carries an approved tier-1 correction. ${COMMON}`,
    );
    let s!: Seeded;
    let csvFile!: Exported;
    let csv!: Csv;
    let xlsx!: Exported;
    let xlsxCsv!: Csv;

    await step('Arrange: Pre-condition 1–16 — ROOT / ANNEX1 family, CY_MAIN with P14 carrying an approved tier-1 correction to B', async () => {
      s = await seedData({ tc: 164, cycles: ['CY_MAIN'], contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }), products: [p('P14', 234)] });
      const x = await tier1(feeReviewApi, s, 'P14', 'B', reasonOf('TC_US079_164', '카테고리 오매핑 정정'));
      await submit(feeReviewApi, [x.id]);
      await decide(approverFeeReviewApi, s.products.P14, 'approve');
      const row = await feeReviewApi.row(s.cycles.CY_MAIN.id, s.products.P14);
      expect(row.inForceRate, 'Pre-condition 13: P14 in-force rate 9.00').toBe('9.00');
      expect(row.correction?.state, 'Pre-condition 13: P14 correction APPROVED').toBe('APPROVED');
    });

    await step('Act: Step 1 — Open CY_MAIN, click 이번 기 수정 내역, click 내보내기, choose CSV (.csv) and click 내려받기', async () => {
      await list.open({ cycleId: s.cycles.CY_MAIN.id });
      await list.openReport();
      await openPeriodExport(list);
      csvFile = await downloadExport(page, list, 'csv');
    });

    await step('Assert: Expected 1 — A CSV file downloads', async () => {
      expect(csvFile.name, '[Expected 1] The saved file is a .csv').toMatch(/\.csv$/);
      expect(csvFile.bytes.length, '[Expected 1] The CSV file is not empty').toBeGreaterThan(0);
    });

    await step('Act: Step 2 — Open the CSV as text and read the header line', async () => {
      csv = readCsv(csvFile.bytes.toString('utf8'));
    });

    await step('Assert: Expected 2 — The header holds exactly 19 columns in order, each written EN ‖ KO', async () => {
      PERIOD_HEADERS.forEach((name, i) => expect.soft(csv.header[i], `[Expected 2] Column ${i + 1} reads "${name}"`).toBe(name));
      expect(csv.header, '[Expected 2] Exactly 19 columns').toHaveLength(19);
    });

    await step('Act: Step 3 — Export again as Excel (.xlsx) and read row 1', async () => {
      await new FeeReviewExportPage(page, list).closeIfOpen();
      await openPeriodExport(list);
      xlsx = await downloadExport(page, list, 'xlsx');
      xlsxCsv = await csvTwin(feeReviewApi, xlsx);
    });

    await step('Assert: Expected 3 — Row 1 of the Excel file holds the same 19 headers in the same order', async () => {
      expect(isXlsx(xlsx), '[Expected 3] An Excel (.xlsx) file is delivered').toBe(true);
      PERIOD_HEADERS.forEach((name, i) => expect.soft(xlsxCsv.header[i], `[Expected 3] Excel header ${i + 1} reads "${name}"`).toBe(name));
      expect(xlsxCsv.header, '[Expected 3] Same 19 headers as the CSV').toEqual(csv.header);
    });
  });

  test('TC_US079_165 — Product IDs stay text, rates keep the per-cent sign and the CSV opens Korean correctly', async ({ page, feeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US079_165',
      'Medium',
      TAGS,
      `The list export writes Product IDs exactly as on screen and resolved rates as text with the per-cent sign (12.50%, 9.00%, 9.50%); the CSV header reads Korean without mojibake and the CSV starts with the UTF-8 BOM EF BB BF. ${XLSX_NOTE} Not automated: the Excel cell type (text vs number / date) and how Excel renders the double-clicked CSV — checked as the exact cell text and the BOM instead. Data: own cycle, no correction. ${COMMON}`,
    );
    let s!: Seeded;
    let xlsx!: Exported;
    let xlsxCsv!: Csv;
    let onScreen = '';
    let csvFile!: Exported;
    let csv!: Csv;
    let firstBytes: number[] = [];
    const rates: Array<[string, string]> = [['P01', '12.50%'], ['P14', '12.50%'], ['P02', '9.00%'], ['P03', '9.00%'], ['P09', '9.50%']];

    await step('Arrange: Pre-condition 1–14 — ROOT / ANNEX1 family, own cycle CY_MAIN with P01, P02, P03, P09, P14 and no correction', async () => {
      s = await seedData({
        tc: 165,
        private: true,
        cycles: ['CY_MAIN'],
        contracts: family({ ROOT: ['R_A', 'R_B10', 'R_PROMO'], ANNEX1: ['R_B9'] }),
        products: [p('P01', 3), p('P02', 40), p('P03', 77), p('P09', 49), p('P14', 234)],
      });
      const listed = await feeReviewApi.products(s.cycles.CY_MAIN.id, { keyword: s.prefix.slice(0, -1) });
      expect(listed.totalElements, 'Pre-condition 11: 5 rows').toBe(5);
      for (const [code, rate] of rates) expect.soft(listed.content.find((r) => r.productId === s.products[code])?.inForceRate, `Pre-condition 11: ${code} in-force rate`).toBe(rate.replace('%', ''));
    });

    await step('Act: Step 1 — Open CY_MAIN, 기간 내 판매 상품, click 목록 내보내기, keep Excel (.xlsx) and click 내려받기', async () => {
      await list.open({ cycleId: s.cycles.CY_MAIN.id, bucket: 'ALL' });
      onScreen = ((await list.cell(list.row(s.products.P14), 'productId').textContent()) ?? '').trim();
      await list.openExport();
      xlsx = await downloadExport(page, list);
    });

    await step('Assert: Expected 1 — An .xlsx file downloads', async () => {
      expect(xlsx.name, '[Expected 1] The saved file is a .xlsx').toMatch(/\.xlsx$/);
      expect(isXlsx(xlsx), '[Expected 1] The file is an Excel workbook (ZIP signature PK)').toBe(true);
    });

    await step('Act: Step 2 — Open the .xlsx and read the Product ID cell of P14 and the Resolved rate cells', async () => {
      xlsxCsv = await csvTwin(feeReviewApi, xlsx);
    });

    await step('Assert: Expected 2 — Product ID shows the identifier exactly as on screen; Resolved rates read 12.50%, 9.00%, 9.50% as text', async () => {
      expect(cellOf(xlsxCsv, rowsOf(xlsxCsv, s.products.P14)[0], 'Product ID'), '[Expected 2] P14 Product ID is exactly the on-screen identifier').toBe(onScreen);
      for (const [code, rate] of rates) {
        expect.soft(cellOf(xlsxCsv, rowsOf(xlsxCsv, s.products[code])[0], 'Resolved rate'), `[Expected 2] ${code} Resolved rate reads ${rate} (with the per-cent sign, not a fraction)`).toBe(rate);
      }
    });

    await step('Act: Step 3 — Export the same list as CSV (.csv) and open it', async () => {
      await new FeeReviewExportPage(page, list).closeIfOpen();
      await list.openExport();
      csvFile = await downloadExport(page, list, 'csv');
      csv = readCsv(csvFile.bytes.toString('utf8'));
    });

    await step('Assert: Expected 3 — Korean header halves display correctly, no mojibake; rates still read 12.50%', async () => {
      for (const ko of ['정산 주기', '상품ID', '산정 상태']) expect.soft(csv.header.some((h) => h.endsWith(`‖ ${ko}`)), `[Expected 3] Korean header half ${ko} reads correctly`).toBe(true);
      expect(csv.text, '[Expected 3] No replacement characters (mojibake)').not.toContain('�');
      for (const code of ['P01', 'P14']) expect.soft(cellOf(csv, rowsOf(csv, s.products[code])[0], 'Resolved rate'), `[Expected 3] ${code} rate still reads 12.50%`).toBe('12.50%');
    });

    await step('Act: Step 4 — Read the first three bytes of the CSV file', async () => {
      firstBytes = [...csvFile.bytes.subarray(0, 3)];
    });

    await step('Assert: Expected 4 — The file starts with bytes EF BB BF (UTF-8 byte-order mark)', async () => {
      expect(firstBytes, '[Expected 4] UTF-8 BOM EF BB BF').toEqual([0xef, 0xbb, 0xbf]);
    });
  });

  test('TC_US079_166 — The outcome and the assigned row are carried by their own columns, not by formatting', async ({ page, feeReviewApi, approverFeeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const ex = new FeeReviewExportPage(page, list);
    await tcMeta(
      'TC_US079_166',
      'Medium',
      TAGS,
      `The period CSV carries no formatting and marks the rejected P03 correction Applied? = N and the approved P14 one Y (the Excel export keeps the same column); in the list CSV the P03 row shows Mismatch, the same assigned and resolved category B, the assigned row R_B10 (not the resolved R_B9) and the basis contract ANNEX1. ${XLSX_NOTE} Not automated: the strike-through formatting inside the .xlsx. Data: own cycle. ${COMMON}`,
    );
    let s!: Seeded;
    let period!: Csv;
    let xlsx!: Exported;
    let xlsxCsv!: Csv;
    let listCsv!: Csv;

    await step('Arrange: Pre-condition 1–17 — ROOT / ANNEX1 family, own cycle; P03 correction rejected, P14 correction approved', async () => {
      s = await seedData({ tc: 166, private: true, cycles: ['CY_MAIN'], contracts: family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9'] }), products: [p('P03', 77), p('P14', 234)] });
      const y = await tier1(feeReviewApi, s, 'P03', 'A', reasonOf('TC_US079_166', 'Wrong category mapped in commerce'));
      const x = await tier1(feeReviewApi, s, 'P14', 'B', reasonOf('TC_US079_166', '카테고리 오매핑 정정'));
      await submit(feeReviewApi, [y.id, x.id]);
      await decide(approverFeeReviewApi, s.products.P14, 'approve');
      await decide(approverFeeReviewApi, s.products.P03, 'reject');
      const p03 = await feeReviewApi.row(s.cycles.CY_MAIN.id, s.products.P03);
      expect(p03.verdict, 'Pre-condition 15: P03 verdict MISMATCH').toBe('MISMATCH');
      expect(p03.correction?.state, 'Pre-condition 15: P03 correction REJECTED').toBe('REJECTED');
      expect((await feeReviewApi.row(s.cycles.CY_MAIN.id, s.products.P14)).correction?.state, 'Pre-condition 15: P14 correction APPROVED').toBe('APPROVED');
    });

    await step('Act: Step 1 — Open CY_MAIN, click 이번 기 수정 내역, 내보내기, choose CSV (.csv), 내려받기 and open the file as text', async () => {
      await list.open({ cycleId: s.cycles.CY_MAIN.id });
      await list.openReport();
      await openPeriodExport(list);
      period = readCsv((await downloadExport(page, list, 'csv')).bytes.toString('utf8'));
    });

    await step('Assert: Expected 1 — The CSV carries no formatting; P03 has Applied? = N and P14 has Applied? = Y', async () => {
      expect(period.text, '[Expected 1] No formatting markup in the CSV').not.toMatch(/<\/?(s|del|strike|span|b|i)\b|line-through|̶|\x1b\[/i);
      expect(cellOf(period, rowsOf(period, s.products.P03)[0], 'Applied?'), '[Expected 1] P03 Applied? = N').toBe('N');
      expect(cellOf(period, rowsOf(period, s.products.P14)[0], 'Applied?'), '[Expected 1] P14 Applied? = Y').toBe('Y');
    });

    await step('Act: Step 2 — Export the period report again as Excel (.xlsx) and open it', async () => {
      await ex.closeIfOpen();
      await openPeriodExport(list);
      xlsx = await downloadExport(page, list, 'xlsx');
      xlsxCsv = await csvTwin(feeReviewApi, xlsx);
    });

    await step('Assert: Expected 2 — In the Excel file the Applied? column is still present with N for P03 and Y for P14', async () => {
      expect(isXlsx(xlsx), '[Expected 2] An Excel (.xlsx) file is delivered').toBe(true);
      expect(xlsxCsv.header.some((h) => h.startsWith('Applied?')), '[Expected 2] The Applied? column is present').toBe(true);
      expect(cellOf(xlsxCsv, rowsOf(xlsxCsv, s.products.P03)[0], 'Applied?'), '[Expected 2] P03 Applied? = N').toBe('N');
      expect(cellOf(xlsxCsv, rowsOf(xlsxCsv, s.products.P14)[0], 'Applied?'), '[Expected 2] P14 Applied? = Y').toBe('Y');
    });

    await step('Act: Step 3 — Close the dialog, click 기간 내 판매 상품, export the list as CSV (.csv) and read the P03 row', async () => {
      await ex.closeIfOpen();
      await list.report.close();
      await list.clickChip(list.chip('bucket.ALL'));
      await list.openExport();
      listCsv = readCsv((await downloadExport(page, list, 'csv')).bytes.toString('utf8'));
    });

    await step('Assert: Expected 3 — P03 row: Mismatch, assigned = resolved category B, assigned row R_B10 (not R_B9), basis contract ANNEX1', async () => {
      const row = rowsOf(listCsv, s.products.P03)[0];
      const at = (n: number) => row?.[n - 1]?.trim() ?? '';
      expect(row, '[Expected 3] The P03 row is in the list file').toBeDefined();
      expect.soft(headerAt(listCsv, 4), '[Expected 3] Column 4 is Assigned vs resolved').toBe('Assigned vs resolved');
      expect.soft(at(4), '[Expected 3] Column 4 Assigned vs resolved = Mismatch').toMatch(word('compare.MISMATCH'));
      expect.soft(headerAt(listCsv, 7), '[Expected 3] Column 7 is Assigned category (commerce)').toBe('Assigned category (commerce)');
      expect.soft(at(7), `[Expected 3] Column 7 Assigned category = B (${s.master.categoryName.B})`).toContain(s.master.categoryName.B);
      expect.soft(headerAt(listCsv, 9), '[Expected 3] Column 9 is Resolved category').toBe('Resolved category');
      expect.soft(at(9), `[Expected 3] Column 9 Resolved category = B (${s.master.categoryName.B})`).toContain(s.master.categoryName.B);
      expect.soft(at(9), '[Expected 3] Columns 7 and 9 carry the same name').toBe(at(7));
      expect.soft(headerAt(listCsv, 8), '[Expected 3] Column 8 is Assigned contract row').toBe('Assigned contract row');
      expect.soft(at(8), `[Expected 3] Column 8 = the id of R_B10 (${s.family.rows.R_B10})`).toMatch(new RegExp(`\\b${s.family.rows.R_B10}\\b`));
      expect.soft(at(8), `[Expected 3] Column 8 differs from the resolved row R_B9 (${s.family.rows.R_B9})`).not.toMatch(new RegExp(`\\b${s.family.rows.R_B9}\\b`));
      expect.soft(headerAt(listCsv, 12), '[Expected 3] Column 12 is Rate basis (contract)').toBe('Rate basis (contract)');
      expect.soft(at(12), '[Expected 3] Column 12 Rate basis = contract ANNEX1').toContain(`[T079-${s.run}-166] ANNEX1`);
    });
  });

  test('TC_US079_167 — Exported statuses use the screen wording and carry no rule codes or document versions', async ({ page, feeReviewApi, approverFeeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const ex = new FeeReviewExportPage(page, list);
    await tcMeta(
      'TC_US079_167',
      'Medium',
      TAGS,
      `In the list CSV, columns 4–6 read the screen wording (Matches / Mismatch / Not assigned; Resolved / Ambiguous / No row applies; Awaiting approval for P14, Rejected — fix and resubmit for P03) and never the enum; the period CSV Approval state reads the same wording; neither file holds a rule code (XX-12), a question code (OQ…) or a document version (v…). Words are accepted in Korean or English (the UI runs in Korean). Data: own cycle; P99 is a target row without a product row. ${COMMON}`,
    );
    let s!: Seeded;
    let listFile!: Exported;
    let listCsv!: Csv;
    let period!: Csv;
    const noRow = ['P06', 'P10', 'P12', 'P13', 'P99'];
    const found: Array<{ name: string; rule: string[]; question: string[]; version: string[] }> = [];

    await step('Arrange: Pre-condition 1–18 — Own cycle with 8 rows: P14 pending, P03 rejected, P04 ambiguous, P06 / P10 / P12 / P13 / P99 no row', async () => {
      s = await seedData({
        tc: 167,
        private: true,
        cycles: ['CY_MAIN'],
        contracts: family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9', 'R_C20'], ANNEX2: ['R_C22'] }),
        products: [p('P03', 77), p('P04', 114), p('P06', 188), p('P10', 86), p('P12', 160), p('P13', 197), p('P14', 234)],
      });
      await targetOnly(s, 'P99', 5);
      const x = await tier1(feeReviewApi, s, 'P14', 'B', reasonOf('TC_US079_167', '카테고리 오매핑 정정'));
      const y = await tier1(feeReviewApi, s, 'P03', 'A', reasonOf('TC_US079_167', 'Wrong category mapped in commerce'));
      await submit(feeReviewApi, [x.id, y.id]);
      await decide(approverFeeReviewApi, s.products.P03, 'reject');
      expect((await feeReviewApi.products(s.cycles.CY_MAIN.id, { keyword: s.prefix.slice(0, -1) })).totalElements, 'Pre-condition 16: 8 rows').toBe(8);
    });

    await step('Act: Step 1 — Open CY_MAIN, click 기간 내 판매 상품, export the list as CSV (.csv) and open the file', async () => {
      await list.open({ cycleId: s.cycles.CY_MAIN.id, bucket: 'ALL' });
      await list.openExport();
      listFile = await downloadExport(page, list, 'csv');
    });

    await step('Assert: Expected 1 — The list file downloads', async () => {
      expect(listFile.name, '[Expected 1] A .csv list file is saved').toMatch(/\.csv$/);
      expect(listFile.bytes.length, '[Expected 1] The file is not empty').toBeGreaterThan(0);
    });

    await step('Act: Step 2 — Read columns 4, 5 and 6 of every row', async () => {
      listCsv = readCsv(listFile.bytes.toString('utf8'));
    });

    await step('Assert: Expected 2 — Columns 4–6 use the screen wording, not the enum codes', async () => {
      expect.soft(headerAt(listCsv, 4), '[Expected 2] Column 4 is Assigned vs resolved').toBe('Assigned vs resolved');
      expect.soft(headerAt(listCsv, 5), '[Expected 2] Column 5 is Resolution status').toBe('Resolution status');
      expect.soft(headerAt(listCsv, 6), '[Expected 2] Column 6 is Correction state').toBe('Correction state');
      const verdict = new RegExp(`${word('compare.MATCHES').source}|${word('compare.MISMATCH').source}|${word('compare.NOT_ASSIGNED').source}`);
      for (const r of listCsv.rows) expect.soft(r[3]?.trim(), `[Expected 2] Column 4 of ${r[1]} is Matches / Mismatch / Not assigned`).toMatch(verdict);
      for (const code of ['MATCHES', 'MISMATCH', 'NOT_ASSIGNED']) expect.soft(listCsv.rows.map((r) => r[3]?.trim()), `[Expected 2] Column 4 never reads ${code}`).not.toContain(code);
      expect.soft((rowsOf(listCsv, s.products.P14)[0]?.[3]?.trim() ?? '(row not found)'), '[Expected 2] Column 4 of P14 reads Matches').toMatch(word('compare.MATCHES'));
      expect.soft((rowsOf(listCsv, s.products.P03)[0]?.[3]?.trim() ?? '(row not found)'), '[Expected 2] Column 4 of P03 reads Mismatch').toMatch(word('compare.MISMATCH'));
      expect.soft(listCsv.rows.some((r) => word('compare.NOT_ASSIGNED').test(r[3]?.trim() ?? '')), '[Expected 2] Column 4 reads Not assigned for an unassigned row').toBe(true);
      for (const code of ['P14', 'P03']) expect.soft((rowsOf(listCsv, s.products[code])[0]?.[4]?.trim() ?? '(row not found)'), `[Expected 2] Column 5 of ${code} reads Resolved`).toMatch(word('status.RESOLVED'));
      expect.soft((rowsOf(listCsv, s.products.P04)[0]?.[4]?.trim() ?? '(row not found)'), '[Expected 2] Column 5 of P04 reads Ambiguous').toMatch(word('status.AMBIGUOUS'));
      for (const code of noRow) expect.soft((rowsOf(listCsv, s.products[code])[0]?.[4]?.trim() ?? '(row not found)'), `[Expected 2] Column 5 of ${code} reads No row applies`).toMatch(word('status.NO_ROW'));
      for (const code of ['RESOLVED', 'AMBIGUOUS', 'NO_ROW']) expect.soft(listCsv.rows.map((r) => r[4]?.trim()), `[Expected 2] Column 5 never reads ${code}`).not.toContain(code);
      expect.soft((rowsOf(listCsv, s.products.P14)[0]?.[5]?.trim() ?? '(row not found)'), '[Expected 2] Column 6 of P14 reads Awaiting approval').toMatch(word('state.PENDING'));
      expect.soft((rowsOf(listCsv, s.products.P03)[0]?.[5]?.trim() ?? '(row not found)'), '[Expected 2] Column 6 of P03 reads Rejected — fix and resubmit').toMatch(word('state.REJECTED'));
    });

    await step('Act: Step 3 — Click 이번 기 수정 내역, 내보내기, choose CSV (.csv), download and read column 12', async () => {
      await ex.closeIfOpen();
      await list.openReport();
      await openPeriodExport(list);
      period = readCsv((await downloadExport(page, list, 'csv')).bytes.toString('utf8'));
    });

    await step('Assert: Expected 3 — Column 12 reads Awaiting approval for P14 and Rejected — fix and resubmit for P03, not PENDING / REJECTED', async () => {
      expect.soft(headerAt(period, 12), '[Expected 3] Column 12 is Approval state').toBe('Approval state');
      const p14 = rowsOf(period, s.products.P14)[0]?.[11]?.trim();
      const p03 = rowsOf(period, s.products.P03)[0]?.[11]?.trim();
      expect.soft(p14, '[Expected 3] P14 column 12 reads Awaiting approval').toMatch(word('state.PENDING'));
      expect.soft(p03, '[Expected 3] P03 column 12 reads Rejected — fix and resubmit').toMatch(word('state.REJECTED'));
      expect.soft(p14, '[Expected 3] P14 column 12 is not PENDING').not.toBe('PENDING');
      expect.soft(p03, '[Expected 3] P03 column 12 is not REJECTED').not.toBe('REJECTED');
    });

    await step('Act: Step 4 — Search both files for a rule code, a question code and a version number', async () => {
      for (const [name, csv] of [['List', listCsv], ['Period', period]] as const) {
        found.push({ name, rule: csv.text.match(/\b[A-Z]{2,}-\d+/g) ?? [], question: csv.text.match(/\bOQ-?\d+/g) ?? [], version: csv.text.match(/\bv\d+(\.\d+)*\b/g) ?? [] });
      }
    });

    await step('Assert: Expected 4 — No rule code, question code or document version in either file', async () => {
      expect(found.map((f) => f.name), '[Expected 4] Both files were searched').toEqual(['List', 'Period']);
      for (const f of found) {
        expect.soft(f.rule, `[Expected 4] ${f.name} file: no rule code (XX-12)`).toEqual([]);
        expect.soft(f.question, `[Expected 4] ${f.name} file: no question code (OQ…)`).toEqual([]);
        expect.soft(f.version, `[Expected 4] ${f.name} file: no document version (v…)`).toEqual([]);
      }
    });
  });

  test('TC_US079_168 — The file name carries the settlement cycle and a date stamp', async ({ page, feeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const ex = new FeeReviewExportPage(page, list);
    await tcMeta(
      'TC_US079_168',
      'Low',
      TAGS,
      `The 파일명 (File name) preview and the saved file name of both the list export and the period export hold the cycle label and the date stamp of the export day (YYYYMMDD or YYYY-MM-DD, local time). Known build issue (TC remark): the BE names the saved file fee-review_YYYY-MM / fee-period-report_YYYY-MM without a date stamp — Expected 2 and the saved half of Expected 3 are expected to fail. Data: own cycle (one pending correction). ${COMMON}`,
    );
    let s!: Seeded;
    let label = '';
    const stamp = dateStamp();
    let listName = '';
    let periodPreview = '';
    let periodName = '';

    await step('Arrange: Pre-condition 1–13 — ROOT family, own cycle with P14 and one pending correction', async () => {
      s = await seedData({ tc: 168, private: true, cycles: ['CY_MAIN'], contracts: family({ ROOT: ['R_A', 'R_B10'] }), products: [p('P14', 234)] });
      label = s.cycles.CY_MAIN.label;
      const x = await tier1(feeReviewApi, s, 'P14', 'B', reasonOf('TC_US079_168', '카테고리 오매핑 정정'));
      await submit(feeReviewApi, [x.id]);
      expect((await feeReviewApi.periodCorrections(s.cycles.CY_MAIN.id)).length, 'Pre-condition 11: one correction in CY_MAIN').toBe(1);
    });

    await step('Act: Step 1 — Open CY_MAIN, click 목록 내보내기 and read 파일명 (File name)', async () => {
      await list.open({ cycleId: s.cycles.CY_MAIN.id });
      await list.openExport();
    });

    await step('Assert: Expected 1 — 파일명 shows a name holding the cycle and the date stamp of the export day', async () => {
      await expect(list.exporter.fileName, `[Expected 1] The file name holds the cycle ${label}`).toContainText(label);
      await expect(list.exporter.fileName, '[Expected 1] The file name holds the date stamp of the export day').toHaveText(stamp);
    });

    await step('Act: Step 2 — Click 내려받기 and read the saved file name', async () => {
      listName = (await downloadExport(page, list)).name;
    });

    await step('Assert: Expected 2 — The saved list file name holds the cycle and the date stamp of the export day', async () => {
      expect.soft(listName, `[Expected 2] The saved name holds the cycle ${label}`).toContain(label);
      expect.soft(listName, '[Expected 2] The saved name holds the date stamp of the export day').toMatch(stamp);
    });

    await step('Act: Step 3 — Click 이번 기 수정 내역, 내보내기, read 파일명, click 내려받기 and read the saved file name', async () => {
      await ex.closeIfOpen();
      await list.openReport();
      await openPeriodExport(list);
      periodPreview = ((await list.exporter.fileName.textContent()) ?? '').trim();
      periodName = (await downloadExport(page, list)).name;
    });

    await step('Assert: Expected 3 — The period file name preview and the saved name both hold the cycle and the date stamp', async () => {
      expect.soft(periodPreview, `[Expected 3] The preview holds the cycle ${label}`).toContain(label);
      expect.soft(periodPreview, '[Expected 3] The preview holds the date stamp of the export day').toMatch(stamp);
      expect.soft(periodName, `[Expected 3] The saved name holds the cycle ${label}`).toContain(label);
      expect.soft(periodName, '[Expected 3] The saved name holds the date stamp of the export day').toMatch(stamp);
    });
  });

  test('TC_US079_169 — Exporting the Source needs fixing bucket gives the list used to correct commerce', async ({ page, feeReviewApi, approverFeeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const ex = new FeeReviewExportPage(page, list);
    await tcMeta(
      'TC_US079_169',
      'Medium',
      TAGS,
      `With 원천 수정 필요 (Source needs fixing) applied the list shows P14 and P05 only (not the hand-keyed P10); the 목록 내보내기 tooltip explains the all-pages export; the scope reads Filter Source needs fixing, Rows 2; the file holds P14 (commerce A → resolved B) and P05 (A → D). ${XLSX_NOTE} Data: own cycle. ${COMMON}`,
    );
    let s!: Seeded;
    let xlsx!: Exported;
    let xlsxCsv!: Csv;

    await step('Arrange: Pre-condition 1–18 — Own cycle: P14 approved to B, P10 hand-keyed 6.75 approved, P05 applied to D; commerce still holds A', async () => {
      s = await seedData({ tc: 169, private: true, cycles: ['CY_MAIN'], contracts: family({ ROOT: ['R_A', 'R_D'], ANNEX1: ['R_B9'] }), products: [p('P05', 151), p('P10', 86), p('P14', 234)] });
      const x = await tier1(feeReviewApi, s, 'P14', 'B', reasonOf('TC_US079_169', '카테고리 오매핑 정정'));
      const y2 = await tier2(feeReviewApi, s, 'P10', '6.75', reasonOf('TC_US079_169', 'Side letter rate agreed with the label'));
      await submit(feeReviewApi, [x.id, y2]);
      await decide(approverFeeReviewApi, s.products.P14, 'approve');
      await decide(approverFeeReviewApi, s.products.P10, 'approve');
      const x5 = await tier1(feeReviewApi, s, 'P05', 'D', reasonOf('TC_US079_169', 'Wrong category mapped in commerce'));
      expect(x5.state, 'Pre-condition 14: X5 applies at once').toBe('APPLIED');
      const cy = s.cycles.CY_MAIN.id;
      expect((await feeReviewApi.products(cy, { keyword: s.prefix.slice(0, -1) })).totalElements, 'Pre-condition 16: 3 rows').toBe(3);
      expect((await feeReviewApi.products(cy, { problem: 'SOURCE_NEEDS_FIXING' })).content.map((r) => r.productId).sort(), 'Pre-condition 16: Source needs fixing on P14 and P05 only').toEqual([s.products.P05, s.products.P14].sort());
      const p10 = await feeReviewApi.row(cy, s.products.P10);
      expect(p10.inForceRate, 'Pre-condition 16: P10 in-force rate 6.75').toBe('6.75');
      expect(p10.rateHandKeyed, 'Pre-condition 16: P10 rate is hand-keyed').toBe(true);
    });

    await step('Act: Step 1 — Open CY_MAIN and click 원천 수정 필요 (Source needs fixing)', async () => {
      await list.open({ cycleId: s.cycles.CY_MAIN.id });
      await list.clickChip(list.chip('bucket.SRCDIFF'));
    });

    await step('Assert: Expected 1 — The list shows P14 and P05 only; P10 (hand-keyed rate) is not listed', async () => {
      const ids = await list.productIds();
      expect(ids.sort(), '[Expected 1] Only P14 and P05 are listed').toEqual([s.products.P05, s.products.P14].sort());
      expect(ids, '[Expected 1] P10 (hand-keyed) is not listed').not.toContain(s.products.P10);
    });

    await step('Act: Step 2 — Hover 목록 내보내기 (Export list)', async () => {
      await list.exportButton.hover();
    });

    await step('Assert: Expected 2 — The tooltip explains the all-pages export and the Source needs fixing use', async () => {
      await expect.poll(() => ex.exportListTooltipText(), { message: '[Expected 2] Tooltip "현재 필터에 해당하는 전체 상품을 내보냅니다 — …"', timeout: 10_000 }).toMatch(word('msg.exportListTitle'));
    });

    await step('Act: Step 3 — Click 목록 내보내기 (Export list)', async () => {
      await list.openExport();
    });

    await step('Assert: Expected 3 — Scope block: Filter Source needs fixing, Rows 2', async () => {
      await expect(list.exporter.scopeValue('export.filter'), '[Expected 3] 필터 (Filter) 원천 수정 필요 (Source needs fixing)').toHaveText(word('bucket.SRCDIFF'));
      await expect(list.exporter.scopeValue('export.rows'), '[Expected 3] 행 수 (Rows) 2').toHaveText('2');
    });

    await step('Act: Step 4 — Keep Excel (.xlsx), click 내려받기 (Download) and open the file', async () => {
      xlsx = await downloadExport(page, list);
      xlsxCsv = await csvTwin(feeReviewApi, xlsx);
    });

    await step('Assert: Expected 4 — The file holds 2 rows: P14 A → B and P05 A → D, each naming what commerce holds next to the target category', async () => {
      const name = s.master.categoryName;
      expect(isXlsx(xlsx), '[Expected 4] An Excel (.xlsx) file is delivered').toBe(true);
      expect(xlsxCsv.rows.length, '[Expected 4] The file holds 2 rows').toBe(2);
      const p14 = rowsOf(xlsxCsv, s.products.P14)[0];
      const p05 = rowsOf(xlsxCsv, s.products.P05)[0];
      expect.soft(cellOf(xlsxCsv, p14, 'Assigned category (commerce)'), `[Expected 4] P14 Assigned category (commerce) = A (${name.A})`).toBe(name.A);
      expect.soft(cellOf(xlsxCsv, p14, 'Resolved category'), `[Expected 4] P14 Resolved category = B (${name.B})`).toBe(name.B);
      expect.soft(cellOf(xlsxCsv, p05, 'Assigned category (commerce)'), `[Expected 4] P05 Assigned category (commerce) = A (${name.A})`).toBe(name.A);
      expect.soft(cellOf(xlsxCsv, p05, 'Resolved category'), `[Expected 4] P05 Resolved category = D (${name.D})`).toBe(name.D);
      for (const [code, row] of [['P14', p14], ['P05', p05]] as const) {
        expect.soft(cellOf(xlsxCsv, row, 'Assigned category (commerce)'), `[Expected 4] ${code} names what commerce holds next to a different target category`).not.toBe(cellOf(xlsxCsv, row, 'Resolved category'));
      }
    });
  });

  test('TC_US079_170 — Hand-keyed rates are marked in both exports', async ({ page, feeReviewApi, approverFeeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const ex = new FeeReviewExportPage(page, list);
    await tcMeta(
      'TC_US079_170',
      'Medium',
      TAGS,
      `P10 carries an approved hand-keyed rate 6.75%: the list shows the 직접 입력 (Hand-keyed) badge with the basis in its tooltip; the list CSV reads Resolved rate 6.75% with Rate source Hand-keyed (P01: Contract); the period report shows 2단계 with the Hand-keyed mark and its CSV reads Tier 2, Rate after 6.75%. Rate-source words are accepted in Korean or English. Data: own cycle. ${COMMON}`,
    );
    let s!: Seeded;
    const basis = '라벨과 합의한 별도 약정 요율';
    let listCsv!: Csv;
    let period!: Csv;

    await step('Arrange: Pre-condition 1–15 — ROOT with R_A only, own cycle; P10 hand-keyed 6.75 approved, P01 from the contract', async () => {
      s = await seedData({ tc: 170, private: true, cycles: ['CY_MAIN'], contracts: family({ ROOT: ['R_A'] }), products: [p('P01', 3), p('P10', 86)] });
      const y2 = await tier2(feeReviewApi, s, 'P10', '6.75', reasonOf('TC_US079_170', basis));
      await submit(feeReviewApi, [y2]);
      await decide(approverFeeReviewApi, s.products.P10, 'approve');
      const p10 = await feeReviewApi.row(s.cycles.CY_MAIN.id, s.products.P10);
      const p01 = await feeReviewApi.row(s.cycles.CY_MAIN.id, s.products.P01);
      expect(p10.inForceRate, 'Pre-condition 13: P10 in-force rate 6.75').toBe('6.75');
      expect(p10.rateHandKeyed, 'Pre-condition 13: P10 rate is hand-keyed').toBe(true);
      expect(p01.inForceRate, 'Pre-condition 13: P01 in-force rate 12.50').toBe('12.50');
      expect(p01.rateHandKeyed, 'Pre-condition 13: P01 rate comes from the contract').toBe(false);
    });

    await step('Act: Step 1 — Open CY_MAIN, 기간 내 판매 상품, type T079-<RUN>-170-P10 in 검색어 and press Enter', async () => {
      await list.open({ cycleId: s.cycles.CY_MAIN.id, bucket: 'ALL' });
      await searchByEnter(list, s.products.P10);
    });

    await step('Assert: Expected 1 — P10 shows 6.75% with badge 직접 입력; its tooltip holds the basis', async () => {
      const rate = list.cell(list.row(s.products.P10), 'rate');
      await expect(rate, '[Expected 1] P10 rate reads 6.75%').toContainText('6.75%');
      const badge = ex.handKeyedBadge(rate);
      await expect(badge, '[Expected 1] Badge 직접 입력 (Hand-keyed) is shown').toBeVisible();
      await badge.hover();
      await expect(list.tooltip, `[Expected 1] The tooltip holds the basis "${basis}"`).toContainText(basis);
    });

    await step('Act: Step 2 — Clear the keyword, press Enter, export the list as CSV (.csv) and read the P10 and P01 rows', async () => {
      await searchByEnter(list, '');
      await list.openExport();
      listCsv = readCsv((await downloadExport(page, list, 'csv')).bytes.toString('utf8'));
    });

    await step('Assert: Expected 2 — List file: P10 Resolved rate 6.75%, Rate source Hand-keyed; P01 Rate source Contract', async () => {
      const p10 = rowsOf(listCsv, s.products.P10)[0];
      const p01 = rowsOf(listCsv, s.products.P01)[0];
      expect.soft(cellOf(listCsv, p10, 'Resolved rate'), '[Expected 2] P10 Resolved rate 6.75%').toBe('6.75%');
      expect.soft(cellOf(listCsv, p10, 'Rate source'), '[Expected 2] P10 Rate source = Hand-keyed').toMatch(HAND_KEYED);
      expect.soft(cellOf(listCsv, p01, 'Rate source'), '[Expected 2] P01 Rate source = Contract').toMatch(CONTRACT_SOURCE);
    });

    await step('Act: Step 3 — Click 이번 기 수정 내역 (Changes this period) and read the P10 row', async () => {
      await ex.closeIfOpen();
      await list.openReport();
      await list.report.showLatest();
    });

    await step('Assert: Expected 3 — P10 단계 (Tier) = 2단계 (Tier 2) with the Hand-keyed mark on the rate', async () => {
      const row = list.report.rows.filter({ hasText: s.products.P10 });
      await expect(list.report.cell(row, 'tier'), '[Expected 3] P10 단계 = 2단계 (Tier 2)').toHaveText(word('report.tier2'));
      await expect(ex.handKeyedBadge(list.report.cell(row, 'rate')), '[Expected 3] The rate carries the Hand-keyed mark').toBeVisible();
    });

    await step('Act: Step 4 — Click 내보내기, choose CSV (.csv), 내려받기 and read the P10 row', async () => {
      await openPeriodExport(list);
      period = readCsv((await downloadExport(page, list, 'csv')).bytes.toString('utf8'));
    });

    await step('Assert: Expected 4 — Period file P10 row: Tier = Tier 2, Rate after = 6.75%', async () => {
      const row = rowsOf(period, s.products.P10)[0];
      expect.soft(cellOf(period, row, 'Tier'), '[Expected 4] P10 Tier = Tier 2').toMatch(word('report.tier2'));
      expect.soft(cellOf(period, row, 'Rate after'), '[Expected 4] P10 Rate after = 6.75%').toBe('6.75%');
    });
  });

  test('TC_US079_171 — Excel and CSV can both be chosen with Excel as the default', async ({ page, feeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const ex = new FeeReviewExportPage(page, list);
    await tcMeta(
      'TC_US079_171',
      'Low',
      TAGS,
      `Both export dialogs offer 파일 형식 (File format) Excel (.xlsx) — selected by default — and CSV (.csv) with their descriptions; the default download is an .xlsx, choosing CSV shows the UTF-8 (BOM) note and downloads a .csv; the period export API refuses format=PDF with HTTP 400 and no file. Data: own cycle (one pending correction). ${COMMON}`,
    );
    let s!: Seeded;
    let first!: Exported;
    let second!: Exported;
    let pdf!: { status: number; fileName: string };

    await step('Arrange: Pre-condition 1–13 — ROOT family, own cycle with P14 and one pending correction', async () => {
      s = await seedData({ tc: 171, private: true, cycles: ['CY_MAIN'], contracts: family({ ROOT: ['R_A', 'R_B10'] }), products: [p('P14', 234)] });
      const x = await tier1(feeReviewApi, s, 'P14', 'B', reasonOf('TC_US079_171', '카테고리 오매핑 정정'));
      await submit(feeReviewApi, [x.id]);
      expect((await feeReviewApi.periodCorrections(s.cycles.CY_MAIN.id)).length, 'Pre-condition 11: one correction in CY_MAIN').toBe(1);
    });

    await step('Act: Step 1 — Open CY_MAIN and click 목록 내보내기 (Export list)', async () => {
      await list.open({ cycleId: s.cycles.CY_MAIN.id });
      await list.openExport();
    });

    await step('Assert: Expected 1 — 파일 형식 offers Excel (.xlsx) (selected by default) and CSV (.csv) with their descriptions', async () => {
      await expect(ex.formatLabel, '[Expected 1] 파일 형식 (File format) is shown').toBeVisible();
      await expect(ex.xlsxRadio, '[Expected 1] Excel (.xlsx) is offered with "서식이 유지되고, 바로 열어 읽기 좋습니다"').toHaveAccessibleName(new RegExp(`^Excel \\(\\.xlsx\\)\\s*${esc(FR_KO['export.xlsxDesc'])}$`));
      await expect(ex.csvRadio, '[Expected 1] CSV (.csv) is offered with "다른 시스템·스크립트로 넘기기 좋습니다"').toHaveAccessibleName(new RegExp(`^CSV \\(\\.csv\\)\\s*${esc(FR_KO['export.csvDesc'])}$`));
      await expect(list.exporter.radios, '[Expected 1] Exactly two format options').toHaveCount(2);
      await expect(ex.xlsxRadio, '[Expected 1] Excel (.xlsx) is selected by default').toBeChecked();
    });

    await step('Act: Step 2 — Click 내려받기 (Download) without changing the format', async () => {
      first = await downloadExport(page, list);
    });

    await step('Assert: Expected 2 — An .xlsx file downloads', async () => {
      expect(first.name, '[Expected 2] The saved file is a .xlsx').toMatch(/\.xlsx$/);
      expect(isXlsx(first), '[Expected 2] The file is an Excel workbook (ZIP signature PK)').toBe(true);
    });

    await step('Act: Step 3 — Reopen 목록 내보내기 and choose CSV (.csv)', async () => {
      await ex.closeIfOpen();
      await list.openExport();
      await list.exporter.chooseFormat('csv');
    });

    await step('Assert: Expected 3 — CSV is selected and the UTF-8 (BOM) note shows', async () => {
      await expect(ex.csvRadio, '[Expected 3] CSV (.csv) is selected').toBeChecked();
      await expect(ex.csvNote, '[Expected 3] The note "UTF-8 (BOM) 로 저장되어 Excel에서 바로 열립니다. …" shows').toBeVisible();
    });

    await step('Act: Step 4 — Click 내려받기 (Download)', async () => {
      second = await downloadExport(page, list);
    });

    await step('Assert: Expected 4 — A .csv file downloads', async () => {
      expect(second.name, '[Expected 4] The saved file is a .csv').toMatch(/\.csv$/);
      expect(isXlsx(second), '[Expected 4] The file is plain text, not a workbook').toBe(false);
    });

    await step('Act: Step 5 — Click 이번 기 수정 내역 (Changes this period), then 내보내기 (Export)', async () => {
      await ex.closeIfOpen();
      await list.openReport();
      await openPeriodExport(list);
    });

    await step('Assert: Expected 5 — The period export dialog offers the same two options with Excel (.xlsx) selected by default', async () => {
      await expect(list.exporter.radios, '[Expected 5] Exactly two format options').toHaveCount(2);
      await expect(ex.xlsxRadio, '[Expected 5] Excel (.xlsx) is offered with its description').toHaveAccessibleName(new RegExp(`^Excel \\(\\.xlsx\\)\\s*${esc(FR_KO['export.xlsxDesc'])}$`));
      await expect(ex.csvRadio, '[Expected 5] CSV (.csv) is offered with its description').toHaveAccessibleName(new RegExp(`^CSV \\(\\.csv\\)\\s*${esc(FR_KO['export.csvDesc'])}$`));
      await expect(ex.xlsxRadio, '[Expected 5] Excel (.xlsx) is selected by default').toBeChecked();
    });

    await step('Act: Step 6 — Call GET /fee-review/cycles/CY_MAIN/corrections/export?format=PDF', async () => {
      const res = await feeReviewApi.exportCsv(s.cycles.CY_MAIN.id, 'corrections', { format: 'PDF' });
      pdf = { status: res.status, fileName: res.fileName };
    });

    await step('Assert: Expected 6 — HTTP 400; no file is returned', async () => {
      expect(pdf.status, '[Expected 6] HTTP 400').toBe(400);
      expect(pdf.fileName, '[Expected 6] No file is returned (no attachment file name)').toBe('');
    });
  });

  test('TC_US079_172 — A long export starts within 3 seconds and says it is running until the file arrives', async ({ page, feeReviewApi, seedData, feeReviewPage: list }) => {
    test.setTimeout(600_000);
    const step = makeStep(page);
    await tcMeta(
      'TC_US079_172',
      'Medium',
      TAGS,
      `With 3,000 rows in the cycle, the export dialog reads Rows 3,000; the export request starts delivering (response headers) within 3 seconds of 내려받기; while the file is on its way the button reads 내려받는 중 (Downloading), is disabled and a second click starts no second export request; one file arrives, the button returns to 내려받기 and the file holds 3,000 rows; the extra rows are then deleted. ${XLSX_NOTE} Deviation: "first bytes in the Network tab" is measured as the arrival of the export response headers. Data: own cycle; 3,000 fixture rows removed in Step 6 (and again by the teardown). ${COMMON}`,
    );
    let s!: Seeded;
    let started = 0;
    const requests: string[] = [];
    const downloads: Download[] = [];
    let firstBytes!: Promise<number | null>;
    let downloaded!: Promise<Download>;
    let file!: Download;
    let busy = { arrived: false, label: '', disabled: false };
    let rows = 0;
    let xlsxOk = false;
    let left = { products: -1, targets: -1 };
    const like = () => `${s.prefix}B%`;

    await step('Arrange: Pre-condition 1–14 — ROOT with R_A, own cycle CY_MAIN with 3,000 resolved products B0001–B3000 and no correction', async () => {
      const bulk: ProductDef[] = Array.from({ length: 3000 }, (_, i) => {
        const code = `B${String(i + 1).padStart(4, '0')}`;
        return { code, name: `[T079] ${code}`, contract: 'ROOT', category: 'A', saleType: 'ST1', defaultSlot: 'R_A', targets: [{ cycle: 'CY_MAIN', saleLines: 1 }] };
      });
      s = await seedData({ tc: 172, private: true, cycles: ['CY_MAIN'], contracts: family({ ROOT: ['R_A'] }), products: bulk });
      const [count] = await feeReviewDb.query<CountRow[]>('SELECT COUNT(*) AS n FROM fee_review_fixture_target WHERE settlement_cycle_id = ?', [s.cycles.CY_MAIN.id]);
      expect(Number(count.n), 'Pre-condition 10: 3,000 target rows in CY_MAIN').toBe(3000);
      expect((await feeReviewApi.products(s.cycles.CY_MAIN.id, { keyword: s.prefix.slice(0, -1), size: 10 })).totalElements, 'Pre-condition 11: 3,000 rows listed').toBe(3000);
    });

    await step('Act: Step 1 — Open CY_MAIN, click 기간 내 판매 상품 and click 목록 내보내기 (Export list)', async () => {
      await list.open({ cycleId: s.cycles.CY_MAIN.id, bucket: 'ALL' });
      await list.openExport();
    });

    await step('Assert: Expected 1 — 행 수 (Rows) reads 3,000', async () => {
      await expect(list.exporter.scopeValue('export.rows'), '[Expected 1] 행 수 (Rows) 3,000').toHaveText('3,000');
    });

    await step('Act: Step 2 — Keep Excel (.xlsx), click 내려받기 (Download) and start a stopwatch', async () => {
      page.on('request', (r) => {
        if (EXPORT_URL.test(r.url())) requests.push(r.url());
      });
      page.on('download', (d) => downloads.push(d));
      firstBytes = page.waitForResponse((r) => EXPORT_URL.test(r.url()), { timeout: 3_000 }).then(
        () => Date.now() - started,
        () => null,
      );
      downloaded = page.waitForEvent('download', { timeout: 300_000 });
      started = Date.now();
      await list.exporter.downloadButton.click();
    });

    await step('Assert: Expected 2 — The export request starts delivering within 3 seconds', async () => {
      const ms = await firstBytes;
      expect(ms, '[Expected 2] The export response starts within 3 seconds').not.toBeNull();
      expect(ms ?? Number.POSITIVE_INFINITY, '[Expected 2] First bytes within 3,000 ms').toBeLessThanOrEqual(3000);
    });

    await step('Act: Step 3 — While the file has not arrived, look at the button and click it again', async () => {
      busy = {
        arrived: downloads.length > 0,
        label: ((await list.exporter.downloadButton.textContent()) ?? '').trim(),
        disabled: await list.exporter.downloadButton.isDisabled(),
      };
      if (!busy.arrived) await list.exporter.downloadButton.click({ force: true });
    });

    await step('Assert: Expected 3 — The button reads 내려받는 중 (Downloading) and is disabled; the second click starts no second export request', async () => {
      expect(busy.arrived, '[Expected 3] The file is still on its way when the button is read').toBe(false);
      expect.soft(busy.label, '[Expected 3] The button reads 내려받는 중 (Downloading)').toMatch(word('export.downloading'));
      expect.soft(busy.disabled, '[Expected 3] The button is disabled').toBe(true);
      expect.soft(requests.length, '[Expected 3] The second click starts no second export request').toBe(1);
    });

    await step('Act: Step 4 — Wait for the file to arrive', async () => {
      file = await downloaded;
    });

    await step('Assert: Expected 4 — One file arrives; the button returns to 내려받기 (Download)', async () => {
      expect(downloads.length, '[Expected 4] Exactly one file arrives').toBe(1);
      expect(requests.length, '[Expected 4] Exactly one export request was made').toBe(1);
      await expect(list.exporter.downloadButton, '[Expected 4] The button returns to 내려받기 (Download)').toHaveText(word('export.download'));
    });

    await step('Act: Step 5 — Open the file', async () => {
      const url = new URL(requests[0]);
      const [, cycleId, kind] = EXPORT_URL.exec(url.href) as RegExpExecArray;
      const query = Object.fromEntries(url.searchParams.entries());
      delete query.format;
      const exported: Exported = { name: file.suggestedFilename(), bytes: fs.readFileSync((await file.path()) as string), cycleId: Number(cycleId), kind: kind as Exported['kind'], query };
      xlsxOk = isXlsx(exported);
      rows = (await csvTwin(feeReviewApi, exported)).rows.length;
    });

    await step('Assert: Expected 5 — The file holds 3,000 data rows', async () => {
      expect(xlsxOk, '[Expected 5] The delivered file is an Excel workbook (ZIP signature PK)').toBe(true);
      expect(rows, '[Expected 5] 3,000 data rows').toBe(3000);
    });

    await step('Act: Step 6 — Delete the extra rows (fixture targets, then products B0001–B3000)', async () => {
      await feeReviewDb.execute('DELETE FROM fee_review_fixture_target WHERE product_id LIKE ?', [like()]);
      await feeReviewDb.execute('DELETE FROM fee_review_fixture_product WHERE product_id LIKE ?', [like()]);
      const [t] = await feeReviewDb.query<CountRow[]>('SELECT COUNT(*) AS n FROM fee_review_fixture_target WHERE product_id LIKE ?', [like()]);
      const [pr] = await feeReviewDb.query<CountRow[]>('SELECT COUNT(*) AS n FROM fee_review_fixture_product WHERE product_id LIKE ?', [like()]);
      left = { targets: Number(t.n), products: Number(pr.n) };
    });

    await step('Assert: Expected 6 — Extra rows removed', async () => {
      expect(left.targets, '[Expected 6] No fixture target row B0001–B3000 is left').toBe(0);
      expect(left.products, '[Expected 6] No fixture product row B0001–B3000 is left').toBe(0);
    });
  });
});
