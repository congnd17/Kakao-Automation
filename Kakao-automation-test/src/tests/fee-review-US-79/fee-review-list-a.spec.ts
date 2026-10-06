import * as fs from 'fs';
import type { RowDataPacket } from 'mysql2/promise';
import { test, expect } from '@fixtures/fee-review-v1.fixture';
import { makeStep } from '@utils/step';
import { tcMeta, skipTc } from '@utils/tc-meta';
import { Observations } from '@utils/observations';
import { FR_EN, FR_KO, frFormat } from '@utils/fee-review.i18n';
import { family, product, reasonOf, row } from '@utils/fee-review-v1.data';
import { feeReviewDb } from '@utils/fee-review-db';
import { env } from '@utils/env.config';
import { getValidAccessToken } from '@utils/auth-token';
import { parseCsv } from '@utils/fee-review.data';
import type { ProductDef, SeedSpec } from '@utils/fee-review-seed';
import type { Bucket, FeeReviewPage, Problem, SettlementCycle } from '@api/fee-review.api';
import type { FeeReviewListPage } from '@pages/fee-review.page';
import { ALL_CHIPS, ChipKey, FeeReviewListAPage } from '@pages/fee-review-v1/list-a.page';

/**
 * US079 v1 — nhóm [List] A (TC_US079_18 → 37, `input/TESTCASE_US079_v1.md`): cycle mặc định / selector / banner, tập sản
 * phẩm của cycle, tìm kiếm, chip, 초기화, empty state, phân trang, checkbox header. Mỗi TC tự seed dữ liệu theo pre-condition
 * (họ contract + cycle ≥ 2100 + bảng fixture) qua `seedData`, dọn sản phẩm / correction theo tiền tố ở teardown.
 * Assert theo TC; chỗ TC lệch UI dev ghi Deviation trong description.
 */
const TAGS = ['list', 'fee-review'];
const OPEN_DEV = 'Deviation: the 정산 관리 (Settlement management) sidebar group has no 정산 수수료 확인·수정 (Settlement fee review) item on dev (29/09) — the screen is opened by its URL.';
const CYCLE_DEV = 'Deviation: "select the cycle in 정산 주기 and click 검색" is done by opening the screen on that cycle (cycleId query) — on dev the selector alone does not re-query the list (01/10).';
const YEAR_DEV = 'Deviation: cycles are created on the next free month from 2100 instead of year Y = 2100 + 200 × RUN + N (shared-dev rule in fee-review-seed.ts).';
const COND_DEV = 'Deviation: dev has no 검색 조건 (Search condition) dropdown — only the 검색어 (Keyword) box; the condition choice is skipped and the keyword is typed (the TC expectation is kept).';
const CLEAN = 'Data: products, targets and corrections of the TC prefix are deleted in teardown; contracts and cycles stay (no delete API).';

/** Chip → tham số lọc của GET products (cùng endpoint màn hình gọi). */
const CHIP_QUERY: Record<ChipKey, { bucket?: Bucket; problem?: Problem }> = {
  'bucket.ALL': {},
  'bucket.EXC': { bucket: 'NEEDS_REVIEW' },
  'bucket.NC': { bucket: 'NOT_COMPUTABLE' },
  'bucket.PROV': { bucket: 'PROVISIONAL' },
  'bucket.FIXED': { bucket: 'CORRECTED_THIS_PERIOD' },
  'bucket.OK': { bucket: 'RESOLVED_CLEANLY' },
  'bucket.NF': { problem: 'NO_ROW' },
  'bucket.AMB': { problem: 'AMBIGUOUS' },
  'bucket.DIFF': { problem: 'ASSIGNED_NE_RESOLVED' },
  'bucket.SRCDIFF': { problem: 'SOURCE_NEEDS_FIXING' },
};

/** Chip → số đếm API trả cho cả cycle. */
const CHIP_COUNT: Record<ChipKey, (p: FeeReviewPage) => number> = {
  'bucket.ALL': (p) => p.buckets.total,
  'bucket.EXC': (p) => p.buckets.needsReview,
  'bucket.NC': (p) => p.buckets.notComputable,
  'bucket.PROV': (p) => p.buckets.provisional,
  'bucket.FIXED': (p) => p.buckets.correctedThisPeriod,
  'bucket.OK': (p) => p.buckets.resolvedCleanly,
  'bucket.NF': (p) => p.problems.noRow,
  'bucket.AMB': (p) => p.problems.ambiguous,
  'bucket.DIFF': (p) => p.problems.assignedNeResolved,
  'bucket.SRCDIFF': (p) => p.problems.sourceNeedsFixing,
};

/** Họ contract hay gặp: ROOT (R_A, R_B10) + ANNEX1 (R_B9). */
const FAMILY_AB = family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9'] });
const FAMILY_A = family({ ROOT: ['R_A'] });

/** N sản phẩm hàng loạt B001…B0NN giống P14 (C_ROOT, CAT_A, ST1, slot R_A), 1 sale line trên CY_MAIN. */
function bulk(n: number): ProductDef[] {
  return Array.from({ length: n }, (_, i): ProductDef => ({ code: `B${String(i + 1).padStart(3, '0')}`, contract: 'ROOT', category: 'A', saleType: 'ST1', defaultSlot: 'R_A', targets: [{ cycle: 'CY_MAIN', saleLines: 1 }] }));
}

/** Giá trị đầu tiên của khoá `key` ở bất kỳ độ sâu nào trong body JSON (trace có cấu trúc lồng). */
function findKey(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  if (key in (value as Record<string, unknown>)) return (value as Record<string, unknown>)[key];
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findKey(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Ngày của cột DATE (mysql2 trả Date) → YYYY-MM-DD. */
function day(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '').slice(0, 10);
}

/** Dòng `settlement_cycle` của 1 cycle (SELECT chỉ đọc theo TC). */
async function cycleRecord(cycleId: number): Promise<{ status: string; periodStart: string; periodEnd: string } | undefined> {
  const rows = await feeReviewDb.query<RowDataPacket[]>('SELECT id, period_start, period_end, status FROM settlement_cycle WHERE id = ?', [cycleId]);
  return rows[0] ? { status: String(rows[0].status), periodStart: day(rows[0].period_start), periodEnd: day(rows[0].period_end) } : undefined;
}

/**
 * Danh sách đang hiển thị đúng bằng `expected` (sản phẩm lặp lại = số dòng của nó): 1 assertion cho MỖI sản phẩm TC gọi tên
 * + tổng số dòng (không có dòng lạ).
 */
async function assertListed(extras: FeeReviewListAPage, expected: string[], tag: string): Promise<void> {
  const counts = new Map<string, number>();
  for (const id of expected) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, n] of counts) await expect.soft(extras.rowsOf(id), `${tag} ${id} is listed${n > 1 ? ` ${n} times` : ''}`).toHaveCount(n);
  await expect(extras.productIdCells, `${tag} Exactly ${expected.length} row(s) are listed`).toHaveCount(expected.length);
}

/** Tải file CSV từ dialog 내보내기 đang mở → tên file + các dòng dữ liệu (bỏ header và dòng trống). */
async function downloadCsv(list: FeeReviewListPage): Promise<{ name: string; header: string[]; rows: string[][] }> {
  await list.exporter.chooseFormat('csv');
  const file = await list.exporter.download();
  const [header = [], ...rows] = parseCsv(fs.readFileSync((await file.path()) as string, 'utf8'));
  return { name: file.suggestedFilename(), header, rows: rows.filter((r) => r.some((c) => c.trim())) };
}

/** Cycle mặc định theo pre-condition: OPEN có periodStart nhỏ nhất, không có thì CLOSED mới nhất. */
function defaultCycleOf(cycles: SettlementCycle[]): SettlementCycle | undefined {
  const start = (c: SettlementCycle) => c.periodStart ?? `${c.label}-01`;
  const open = cycles.filter((c) => c.status === 'OPEN').sort((a, b) => start(a).localeCompare(start(b)));
  if (open.length) return open[0];
  return cycles.filter((c) => c.status === 'CLOSED').sort((a, b) => start(b).localeCompare(start(a)))[0];
}

test.describe('[List] Settlement fee review list — cycle, target set, search, chips, paging (v1 group A)', () => {
  test.describe.configure({ timeout: 240_000 });

  test('TC_US079_18 — The screen opens on the oldest open cycle with 확인 필요 (Needs review) selected', async ({ page, feeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const extras = new FeeReviewListAPage(page, list);
    await tcMeta('TC_US079_18', 'High', TAGS, `A fresh open of the screen loads the list on the default cycle (the OPEN cycle with the smallest period start, else the newest CLOSED one) with only 확인 필요 selected; exactly one cycle is flagged defaultSelected; switching to CY_MAIN keeps Needs review selected and lists P03 and P05. Step 5 switches the cycle in the UI selector as the TC says (no URL shortcut). ${OPEN_DEV} ${YEAR_DEV} ${CLEAN}`);
    const spec: SeedSpec = { tc: 18, private: true, contracts: FAMILY_AB, cycles: ['CY_MAIN'], products: [product('P03', [{ cycle: 'CY_MAIN', saleLines: 1 }]), product('P05', [{ cycle: 'CY_MAIN', saleLines: 1 }]), product('P14', [{ cycle: 'CY_MAIN', saleLines: 1 }])] };
    let seeded!: Awaited<ReturnType<typeof seedData>>;
    let expectedDefault: SettlementCycle | undefined;
    let cycles: SettlementCycle[] = [];

    await step('Arrange: Pre-condition 1–13 — CY_MAIN holds P03 (Mismatch), P05 (Not assigned) and P14 (Matches); the DEFAULT cycle is noted', async () => {
      seeded = await seedData(spec);
      expectedDefault = defaultCycleOf(await feeReviewApi.cycles());
      expect(expectedDefault, 'A DEFAULT cycle can be derived from GET /settlement-cycles').toBeDefined();
    });

    await step('Act: Step 1 — Open 정산 관리 › 정산 수수료 확인·수정 (Settlement fee review)', async () => {
      await list.open({ pageSize: '10' });
    });

    await step('Assert: Expected 1 — The screen opens and the list loads without any other action', async () => {
      await expect(list.pageTitle, '[Expected 1] The 정산 수수료 확인·수정 screen is open').toBeVisible();
      await expect(list.loading, '[Expected 1] The list has finished loading').toHaveCount(0);
      await expect(list.partitionGroup, '[Expected 1] The bucket strip of the loaded list is drawn').toBeVisible();
    });

    await step('Act: Step 2 — Read the value shown in 정산 주기 (Settlement cycle)', async () => {
      await list.cycleSelect.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Settlement cycle shows the DEFAULT cycle, labelled YYYY-MM', async () => {
      const checked = list.cycleSelect.locator('option:checked');
      await expect(checked, `[Expected 2] The selected cycle is the DEFAULT ${expectedDefault?.label}`).toHaveText(expectedDefault?.label ?? '');
      await expect(checked, '[Expected 2] The selected cycle is labelled YYYY-MM').toHaveText(/^\d{4}-\d{2}$/);
    });

    await step('Act: Step 3 — Look at the bucket strip', async () => {
      await list.partitionGroup.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Chip 확인 필요 (Needs review) is selected; no other chip is selected', async () => {
      await expect(list.chip('bucket.EXC'), '[Expected 3] 확인 필요 (Needs review) is selected').toHaveAttribute('aria-pressed', 'true');
      for (const key of ALL_CHIPS.filter((k) => k !== 'bucket.EXC')) {
        await expect.soft(list.chip(key), `[Expected 3] ${FR_KO[key]} (${FR_EN[key]}) is not selected`).not.toHaveAttribute('aria-pressed', 'true');
      }
    });

    await step('Act: Step 4 — Call GET /settlement-cycles', async () => {
      cycles = await feeReviewApi.cycles();
    });

    await step('Assert: Expected 4 — Exactly one item has defaultSelected = true and it is the DEFAULT cycle', async () => {
      const flagged = cycles.filter((c) => c.defaultSelected);
      expect(flagged.length, '[Expected 4] Exactly one cycle has defaultSelected = true').toBe(1);
      expect(flagged[0]?.cycleId, `[Expected 4] The defaultSelected cycle is the DEFAULT ${expectedDefault?.label}`).toBe(expectedDefault?.cycleId);
    });

    await step(`Act: Step 5 — Select CY_MAIN (${seeded.cycles.CY_MAIN.label}) in Settlement cycle and click 검색 (Search)`, async () => {
      await list.selectCycle(seeded.cycles.CY_MAIN.label);
      await list.search('');
    });

    await step('Assert: Expected 5 — Needs review stays selected and reads 2; the list shows exactly P03 and P05', async () => {
      await expect(list.chip('bucket.EXC'), '[Expected 5] 확인 필요 (Needs review) stays selected').toHaveAttribute('aria-pressed', 'true');
      await expect(extras.chipReading('bucket.EXC', 2), '[Expected 5] 확인 필요 (Needs review) reads 2').toBeVisible();
      await assertListed(extras, [seeded.products.P03, seeded.products.P05], '[Expected 5]');
    });
  });

  test('TC_US079_19 — The cycle selector lists every cycle as YYYY-MM, newest first', async ({ page, feeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_19', 'Medium', TAGS, `The 정산 주기 options are YYYY-MM labels ordered newest first (CY_NEXT > CY_CLOSE > CY_MAIN > CY_EMPTY); their count equals SELECT COUNT(*) FROM settlement_cycle — every cycle is listed, including CY_EMPTY with no target rows, and no option carries a data marker (DEV-07); each option value is the cycle id, matching settlement_cycle.id. Step 2 reads the options of the native select (a native dropdown cannot be screenshotted open). ${OPEN_DEV} ${YEAR_DEV} ${CLEAN}`);
    const spec: SeedSpec = { tc: 19, private: true, contracts: FAMILY_A, cycles: ['CY_EMPTY', 'CY_MAIN', 'CY_CLOSE', 'CY_NEXT'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 1 }])] };
    let seeded!: Awaited<ReturnType<typeof seedData>>;
    let cycleCount = 0;
    let optionCount = 0;
    let labels: string[] = [];
    let values: string[] = [];
    let cycles: SettlementCycle[] = [];
    let dbIds: string[] = [];

    await step('Arrange: Pre-condition 1–11 — CY_EMPTY, CY_MAIN, CY_CLOSE, CY_NEXT exist (all OPEN); CYCLE_COUNT is noted', async () => {
      seeded = await seedData(spec);
      cycleCount = Number((await feeReviewDb.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM settlement_cycle'))[0]?.n ?? 0);
    });

    await step('Act: Step 1 — Open 정산 관리 › 정산 수수료 확인·수정 (Settlement fee review)', async () => {
      await list.open();
    });

    await step('Assert: Expected 1 — The screen opens', async () => {
      await expect(list.pageTitle, '[Expected 1] The 정산 수수료 확인·수정 screen is open').toBeVisible();
    });

    await step('Act: Step 2 — Open the 정산 주기 (Settlement cycle) dropdown', async () => {
      const options = list.cycleSelect.locator('option');
      labels = (await options.allTextContents()).map((t) => t.trim());
      values = await options.evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value));
    });

    await step('Assert: Expected 2 — Each option is labelled YYYY-MM and the options run newest first', async () => {
      for (const label of labels) expect.soft(label, `[Expected 2] Option "${label}" is labelled YYYY-MM`).toMatch(/^\d{4}-\d{2}$/);
      expect.soft(labels, '[Expected 2] The options run newest first').toEqual([...labels].sort().reverse());
      const at = (key: string) => labels.indexOf(seeded.cycles[key].label);
      for (const key of ['CY_EMPTY', 'CY_MAIN', 'CY_CLOSE', 'CY_NEXT']) expect.soft(at(key), `[Expected 2] ${key} (${seeded.cycles[key].label}) is offered`).toBeGreaterThanOrEqual(0);
      expect.soft(at('CY_NEXT'), '[Expected 2] CY_NEXT is above CY_CLOSE').toBeLessThan(at('CY_CLOSE'));
      expect.soft(at('CY_CLOSE'), '[Expected 2] CY_CLOSE is above CY_MAIN').toBeLessThan(at('CY_MAIN'));
      expect(at('CY_MAIN'), '[Expected 2] CY_MAIN is above CY_EMPTY').toBeLessThan(at('CY_EMPTY'));
    });

    await step('Act: Step 3 — Compare the option list with CYCLE_COUNT', async () => {
      optionCount = await list.cycleSelect.locator('option').count();
    });

    await step('Assert: Expected 3 — The option count equals CYCLE_COUNT, CY_EMPTY is listed and no option carries a data marker', async () => {
      expect.soft(optionCount, `[Expected 3] The option count equals CYCLE_COUNT (${cycleCount})`).toBe(cycleCount);
      expect.soft(labels, `[Expected 3] CY_EMPTY (${seeded.cycles.CY_EMPTY.label}) with no target rows is listed`).toContain(seeded.cycles.CY_EMPTY.label);
      expect(labels.filter((l) => !/^\d{4}-\d{2}$/.test(l)), '[Expected 3] No option carries a data marker').toEqual([]);
    });

    await step('Act: Step 4 — Call GET /settlement-cycles', async () => {
      cycles = await feeReviewApi.cycles();
      dbIds = (await feeReviewDb.query<RowDataPacket[]>('SELECT id FROM settlement_cycle')).map((r) => String(r.id)).sort();
    });

    await step('Assert: Expected 4 — Each item carries the cycle id as its value and the YYYY-MM label as display text; the ids match settlement_cycle.id', async () => {
      for (const c of cycles) {
        expect.soft(labels[values.indexOf(String(c.cycleId))], `[Expected 4] The option with value ${c.cycleId} displays ${c.label}`).toBe(c.label);
        expect.soft(c.label, `[Expected 4] Cycle ${c.cycleId} is labelled YYYY-MM`).toMatch(/^\d{4}-\d{2}$/);
      }
      expect(cycles.map((c) => String(c.cycleId)).sort(), '[Expected 4] The cycle ids match settlement_cycle.id').toEqual(dbIds);
    });
  });

  test('TC_US079_20 — Changing the cycle reloads the list at once and shows the provisional banner only for an open cycle', async ({ page, feeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const extras = new FeeReviewListAPage(page, list);
    await tcMeta('TC_US079_20', 'Medium', TAGS, `Switching 정산 주기 from CY_MAIN to the closed CY_CLOSE and then to the open CY_NEXT reloads the list without Search, redraws every bucket count for the new cycle and toggles the 잠정치입니다. (provisional) banner; the API reports provisional = false for CY_CLOSE and true for CY_NEXT. Steps 2 and 3 are expected to FAIL on develop (the FE re-queries only on Search — TC remark). Not automated: Expected 3 "(T079-…-P14)" — 확인 필요 stays selected and P14 resolves cleanly, so P14 is not on the list; only the 기간 내 판매 상품 count is asserted. ${OPEN_DEV} ${CYCLE_DEV} ${YEAR_DEV} ${CLEAN}`);
    const spec: SeedSpec = {
      tc: 20,
      private: true,
      contracts: FAMILY_AB,
      cycles: ['CY_MAIN', 'CY_CLOSE', 'CY_NEXT'],
      products: [product('P03', [{ cycle: 'CY_MAIN', saleLines: 1 }, { cycle: 'CY_CLOSE', saleLines: 10 }]), product('P14', [{ cycle: 'CY_MAIN', saleLines: 1 }, { cycle: 'CY_NEXT', saleLines: 5 }])],
      close: ['CY_CLOSE'],
    };
    let seeded!: Awaited<ReturnType<typeof seedData>>;
    let requests: string[] = [];
    let closedApi!: FeeReviewPage;
    let provisional = { closed: undefined as boolean | undefined, next: undefined as boolean | undefined };

    await step('Arrange: Pre-condition 1–13 — CY_MAIN holds P03 + P14, the closed CY_CLOSE holds P03, the open CY_NEXT holds P14', async () => {
      seeded = await seedData(spec);
      closedApi = await feeReviewApi.products(seeded.cycles.CY_CLOSE.id);
    });

    await step(`Act: Step 1 — Open the screen, select CY_MAIN (${seeded.cycles.CY_MAIN.label}) and click 검색 (Search)`, async () => {
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id });
    });

    await step('Assert: Expected 1 — The list loads for CY_MAIN with 기간 내 판매 상품 2 and the provisional banner', async () => {
      await expect.soft(extras.chipReading('bucket.ALL', 2), '[Expected 1] 기간 내 판매 상품 (Products sold in period) reads 2').toBeVisible();
      await expect.soft(list.provisionalBanner, '[Expected 1] Banner 잠정치입니다. (These are provisional figures.) shows').toContainText(FR_KO['bnr.provisionalTitle']);
      await expect(list.provisionalBanner, '[Expected 1] The banner body explains the period is not closed yet').toContainText(FR_KO['bnr.provisionalBody']);
    });

    await step(`Act: Step 2 — Select CY_CLOSE (${seeded.cycles.CY_CLOSE.label}) in Settlement cycle — do not click Search`, async () => {
      requests = extras.trackListRequests();
      await list.selectCycle(seeded.cycles.CY_CLOSE.label);
    });

    await step('Assert: Expected 2 — The list reloads at once for CY_CLOSE: 1 product (P03), counts redrawn, no provisional banner', async () => {
      expect.soft(requests.map(FeeReviewListAPage.cycleOf), '[Expected 2] The list re-queries CY_CLOSE without Search').toContain(String(seeded.cycles.CY_CLOSE.id));
      await expect.soft(extras.chipReading('bucket.ALL', 1), '[Expected 2] 기간 내 판매 상품 (Products sold in period) reads 1').toBeVisible();
      for (const key of ALL_CHIPS) {
        await expect.soft(extras.chipReading(key, CHIP_COUNT[key](closedApi)), `[Expected 2] ${FR_KO[key]} is redrawn for CY_CLOSE (${CHIP_COUNT[key](closedApi)})`).toBeVisible();
      }
      await expect.soft(extras.productIdCells, '[Expected 2] The only product is P03').toHaveText([seeded.products.P03]);
      await expect(list.provisionalBanner, '[Expected 2] The provisional banner is gone').toHaveCount(0);
    });

    await step(`Act: Step 3 — Select CY_NEXT (${seeded.cycles.CY_NEXT.label}) in Settlement cycle — do not click Search`, async () => {
      requests.length = 0;
      await list.selectCycle(seeded.cycles.CY_NEXT.label);
    });

    await step('Assert: Expected 3 — The list reloads at once for CY_NEXT: 기간 내 판매 상품 1 and the provisional banner again', async () => {
      expect.soft(requests.map(FeeReviewListAPage.cycleOf), '[Expected 3] The list re-queries CY_NEXT without Search').toContain(String(seeded.cycles.CY_NEXT.id));
      await expect.soft(extras.chipReading('bucket.ALL', 1), '[Expected 3] 기간 내 판매 상품 (Products sold in period) reads 1').toBeVisible();
      await expect(list.provisionalBanner, '[Expected 3] The provisional banner shows again').toBeVisible();
    });

    await step('Act: Step 4 — Call GET products for CY_CLOSE and for CY_NEXT', async () => {
      provisional = { closed: (await feeReviewApi.products(seeded.cycles.CY_CLOSE.id)).provisional, next: (await feeReviewApi.products(seeded.cycles.CY_NEXT.id)).provisional };
    });

    await step('Assert: Expected 4 — CY_CLOSE returns provisional = false; CY_NEXT returns provisional = true', async () => {
      expect.soft(provisional.closed, '[Expected 4] CY_CLOSE returns provisional = false').toBe(false);
      expect(provisional.next, '[Expected 4] CY_NEXT returns provisional = true').toBe(true);
    });
  });

  test('TC_US079_21 — A cycle with incomplete source coverage stays selectable and shows the coverage warning', async ({ page, feeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_21', 'Medium', TAGS, `A cycle flagged coverage-incomplete is listed (marked incomplete) and selectable; selecting it shows the amber coverage warning and the blue provisional banner; going back to CY_MAIN removes the warning and keeps the provisional banner. The test skips at run time when no cycle is flagged coverageIncomplete (DEV-07: the flag is not built — BE/FE always false). Not automated: "naming the sources still to arrive" — the source names are not known in advance. ${OPEN_DEV} ${YEAR_DEV} ${CLEAN}`);
    const spec: SeedSpec = { tc: 21, contracts: FAMILY_A, cycles: ['CY_MAIN'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 1 }])] };
    let seeded!: Awaited<ReturnType<typeof seedData>>;
    let flagged: SettlementCycle | undefined;
    let flaggedOption = '';

    await step('Arrange: Pre-condition 1–12 — CY_MAIN holds P14 (complete coverage); a cycle flagged coverage-incomplete exists', async () => {
      flagged = (await feeReviewApi.cycles()).find((c) => c.coverageIncomplete);
      test.skip(!flagged, 'No settlement cycle is flagged coverageIncomplete on this build (DEV-07: the coverage flag is not built) — the coverage-incomplete cycle cannot be produced');
      seeded = await seedData(spec);
    });

    await step('Act: Step 1 — Open 정산 관리 › 정산 수수료 확인·수정 (Settlement fee review)', async () => {
      await list.open();
    });

    await step('Assert: Expected 1 — The screen opens', async () => {
      await expect(list.pageTitle, '[Expected 1] The 정산 수수료 확인·수정 screen is open').toBeVisible();
    });

    await step('Act: Step 2 — Open the 정산 주기 (Settlement cycle) dropdown', async () => {
      flaggedOption = ((await list.cycleSelect.locator(`option[value="${flagged?.cycleId}"]`).textContent()) ?? '').trim();
    });

    await step('Assert: Expected 2 — The coverage-incomplete cycle is listed, marked as incomplete, and can be picked', async () => {
      const option = list.cycleSelect.locator(`option[value="${flagged?.cycleId}"]`);
      await expect.soft(option, `[Expected 2] Cycle ${flagged?.label} is listed`).toHaveCount(1);
      expect.soft(flaggedOption, `[Expected 2] Cycle ${flagged?.label} is marked as incomplete (its label carries a marker)`).not.toBe(flagged?.label);
      await expect(option, `[Expected 2] Cycle ${flagged?.label} can be picked`).toBeEnabled();
    });

    await step('Act: Step 3 — Select the coverage-incomplete cycle and click 검색 (Search)', async () => {
      await new FeeReviewListAPage(page, list).selectCycleById(flagged?.cycleId ?? 0);
      await list.search('');
    });

    await step('Assert: Expected 3 — The amber coverage warning and the blue provisional banner show as two banners', async () => {
      await expect.soft(list.coverageBanner, '[Expected 3] Warning 이 주기의 원천 데이터가 아직 다 들어오지 않았습니다. shows').toContainText(FR_KO['bnr.coverageTitle']);
      await expect.soft(list.coverageBanner, '[Expected 3] The warning says the list reflects only what has been loaded so far').toContainText(FR_KO['bnr.coverageBody']);
      await expect(list.provisionalBanner, '[Expected 3] Banner 잠정치입니다. (These are provisional figures.) shows').toBeVisible();
    });

    await step(`Act: Step 4 — Select CY_MAIN (${seeded.cycles.CY_MAIN.label}) and click Search`, async () => {
      await list.selectCycle(seeded.cycles.CY_MAIN.label);
      await list.search('');
    });

    await step('Assert: Expected 4 — The coverage warning is gone; the provisional banner stays', async () => {
      await expect.soft(list.coverageBanner, '[Expected 4] The coverage warning is gone').toHaveCount(0);
      await expect(list.provisionalBanner, '[Expected 4] The provisional banner stays').toBeVisible();
    });
  });

  test('TC_US079_22 — The cycle selector is disabled with a message when no cycle is available', async () => {
    await skipTc(
      'TC_US079_22',
      'Low',
      TAGS,
      'With no settlement cycle at all, 정산 주기 is disabled and reads 선택할 수 있는 정산 주기가 없습니다. (No settlement period available.), and GET /settlement-cycles returns an empty list.',
      'The shared dev environment always holds settlement cycles and cycles have no delete API, so the "no cycle available" state cannot be produced (mocking GET /settlement-cycles would make Expected 3 self-fulfilling).',
    );
  });

  test('TC_US079_23 — A closed cycle opens as a look-up view with the exports and the change report still available', async ({ page, feeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const extras = new FeeReviewListAPage(page, list);
    await tcMeta('TC_US079_23', 'High', TAGS, `On the closed CY_CLOSE the P03 row shows 산정 완료 / 9.00% / 불일치 with the closed-period label and no provisional banner; both chips filter; 수정 is disabled with the closed-period tooltip; 근거, 이력, 이번 기 수정 내역 and 목록 내보내기 (CSV) still work; correction-options returns correctable = false / CYCLE_CLOSED. Deviation: the 요율 산정 근거 panel on dev shows the contract id, not its name — the TC's contract name "[T079-<RUN>-23] ANNEX1" is asserted (expected to FAIL on dev) and the id is recorded. ${OPEN_DEV} ${CYCLE_DEV} ${YEAR_DEV} ${CLEAN}`);
    const spec: SeedSpec = { tc: 23, private: true, contracts: family({ ROOT: ['R_B10'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN', 'CY_CLOSE'], products: [product('P03', [{ cycle: 'CY_CLOSE', saleLines: 10 }])], close: ['CY_CLOSE'] };
    let seeded!: Awaited<ReturnType<typeof seedData>>;
    let p03 = '';
    const ids = { all: [] as string[], exc: [] as string[] };
    const basisObs = new Observations(page);
    const historyObs = new Observations(page);
    let look = { button: { opacity: 1, cursor: '' }, wrapper: { opacity: 1, cursor: '' } };
    let csv = { name: '', header: [] as string[], rows: [] as string[][] };
    let options: Record<string, unknown> = {};

    await step('Arrange: Pre-condition 1–13 — The closed CY_CLOSE holds P03 (Resolved 9.00% from ANNEX1, Mismatch), no correction', async () => {
      seeded = await seedData(spec);
      p03 = seeded.products.P03;
    });

    await step(`Act: Step 1 — Open the screen, select CY_CLOSE (${seeded.cycles.CY_CLOSE.label}) and click 검색 (Search)`, async () => {
      await list.open({ cycleId: seeded.cycles.CY_CLOSE.id });
    });

    await step('Assert: Expected 1 — P03 shows 산정 완료, 9.00%, 불일치; no provisional banner; the closed-period label shows', async () => {
      const r = list.row(p03);
      await expect.soft(list.cell(r, 'status'), '[Expected 1] P03 shows 산정 완료 (Resolved)').toContainText(FR_KO['status.RESOLVED']);
      await expect.soft(list.cell(r, 'rate'), '[Expected 1] P03 shows 9.00%').toHaveText('9.00%');
      await expect.soft(list.cell(r, 'compare'), '[Expected 1] P03 shows 불일치 (Mismatch)').toHaveText(FR_KO['compare.MISMATCH']);
      await expect.soft(list.provisionalBanner, '[Expected 1] The provisional banner is not shown').toHaveCount(0);
      await expect(list.resolvedAtLabel, '[Expected 1] The computed-at label reads the closed-period text').toHaveText(FR_KO['lbl.resolvedAtClosed']);
    });

    await step('Act: Step 2 — Click chip 기간 내 판매 상품 (Products sold in period), then chip 확인 필요 (Needs review)', async () => {
      await list.clickChip(list.chip('bucket.ALL'));
      ids.all = await list.productIds();
      await list.clickChip(list.chip('bucket.EXC'));
      ids.exc = await list.productIds();
    });

    await step('Assert: Expected 2 — Both chips filter the list: each reads 1 and lists the P03 row', async () => {
      await expect.soft(extras.chipReading('bucket.ALL', 1), '[Expected 2] 기간 내 판매 상품 (Products sold in period) reads 1').toBeVisible();
      await expect.soft(extras.chipReading('bucket.EXC', 1), '[Expected 2] 확인 필요 (Needs review) reads 1').toBeVisible();
      expect.soft(ids.all, '[Expected 2] 기간 내 판매 상품 lists the P03 row').toEqual([p03]);
      expect(ids.exc, '[Expected 2] 확인 필요 lists the P03 row').toEqual([p03]);
    });

    await step('Act: Step 3 — Hover 수정 (Correct) on the P03 row', async () => {
      await list.correctWrapper(list.row(p03)).hover();
      look = { button: await FeeReviewListAPage.lookOf(list.rowButton(list.row(p03), 'btn.correct')), wrapper: await FeeReviewListAPage.lookOf(list.correctWrapper(list.row(p03))) };
    });

    await step('Assert: Expected 3 — Correct looks disabled (reduced opacity, not-allowed cursor) and its tooltip reads the closed-period message', async () => {
      await expect.soft(list.rowButton(list.row(p03), 'btn.correct'), '[Expected 3] 수정 (Correct) is disabled').toBeDisabled();
      expect.soft(Math.min(look.button.opacity, look.wrapper.opacity), '[Expected 3] 수정 (Correct) has reduced opacity').toBeLessThan(1);
      expect.soft([look.button.cursor, look.wrapper.cursor], '[Expected 3] 수정 (Correct) shows a not-allowed cursor').toContain('not-allowed');
      await expect(list.correctWrapper(list.row(p03)), '[Expected 3] The tooltip reads 마감된 기간은 수정할 수 없습니다').toHaveAttribute('title', FR_KO['msg.correctDisabledClosed']);
    });

    await step('Act: Step 4 — Click 근거 (Basis) on the P03 row, then close the panel', async () => {
      await list.openBasis(list.row(p03));
      await basisObs.record('[Expected 4] Panel 요율 산정 근거 (Why this rate) opens', () => list.basis.root.isVisible());
      await basisObs.record('[Expected 4] The panel shows rate 9.00%', async () => ((await list.basis.headlineRate.textContent()) ?? '').trim() === '9.00%');
      await basisObs.record(`[Expected 4] The rate comes from contract [T079-${seeded.run}-23] ANNEX1`, async () => ((await list.basis.root.innerText()) ?? '').includes(`[T079-${seeded.run}-23] ANNEX1`));
      test.info().annotations.push({ type: 'Observed', description: `ANNEX1 contract id ${seeded.family.contracts.ANNEX1} shown in the panel: ${(await list.basis.root.innerText()).includes(String(seeded.family.contracts.ANNEX1))}` });
      await basisObs.screenshot('Why this rate panel (P03)');
      await list.basis.close();
    });

    await step('Assert: Expected 4 — Panel 요율 산정 근거 (Why this rate) opens with rate 9.00% from contract ANNEX1', async () => {
      basisObs.assertAll();
    });

    await step('Act: Step 5 — Click 이력 (History) on the P03 row, then close the dialog', async () => {
      await list.openHistory(list.row(p03));
      await historyObs.record('[Expected 5] Dialog 변경 이력 (Change history) opens', () => list.history.root.isVisible());
      await historyObs.record('[Expected 5] The dialog reads 이 상품은 이번 기에 변경된 적이 없습니다.', () => list.history.empty.isVisible());
      await historyObs.screenshot('Change history dialog (P03)');
      await list.history.close();
    });

    await step('Assert: Expected 5 — Dialog 변경 이력 (Change history) opens and reads that the product has not been changed this period', async () => {
      historyObs.assertAll();
    });

    await step('Act: Step 6 — Click 이번 기 수정 내역 (Changes this period)', async () => {
      await list.openReport();
    });

    await step('Assert: Expected 6 — Dialog Changes this period opens and reads 이번 기에 수정된 내역이 없습니다.', async () => {
      await expect.soft(list.report.root, '[Expected 6] Dialog 이번 기 수정 내역 (Changes this period) opens').toBeVisible();
      await expect(list.report.root.getByText(FR_KO['report.empty']), '[Expected 6] The dialog reads 이번 기에 수정된 내역이 없습니다. (No corrections were made this period.)').toBeVisible();
    });

    await step('Act: Step 7 — Close the dialog, click 목록 내보내기 (Export list), pick CSV and click 내려받기 (Download)', async () => {
      await list.report.close();
      await list.openExport();
      csv = await downloadCsv(list);
    });

    await step('Assert: Expected 7 — A CSV file downloads; its file name carries the cycle and it holds 1 data row for P03', async () => {
      expect.soft(csv.name, '[Expected 7] A .csv file downloads').toMatch(/\.csv$/);
      expect.soft(csv.name, `[Expected 7] The file name carries the cycle ${seeded.cycles.CY_CLOSE.label}`).toContain(seeded.cycles.CY_CLOSE.label);
      expect.soft(csv.rows.length, '[Expected 7] The file holds 1 data row').toBe(1);
      expect(csv.rows[0] ?? [], '[Expected 7] The data row is P03').toContain(p03);
    });

    await step('Act: Step 8 — Call GET correction-options for P03 on CY_CLOSE (policy NORMAL)', async () => {
      options = (await feeReviewApi.options(seeded.cycles.CY_CLOSE.id, p03)) as unknown as Record<string, unknown>;
    });

    await step('Assert: Expected 8 — correctable = false, notCorrectableReason = CYCLE_CLOSED', async () => {
      expect.soft(options.correctable, '[Expected 8] correctable = false').toBe(false);
      expect(options.notCorrectableReason, '[Expected 8] notCorrectableReason = CYCLE_CLOSED').toBe('CYCLE_CLOSED');
    });
  });

  test("TC_US079_24 — No action on the screen changes a cycle's status", async ({ page, feeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const extras = new FeeReviewListAPage(page, list);
    await tcMeta('TC_US079_24', 'Medium', TAGS, `Clicking every chip, opening 근거 / 이력, saving a Tier 1 correction (P14 → category B, 9.00%), submitting and withdrawing it, opening 이번 기 수정 내역 and exporting the list never changes CY_MAIN in settlement_cycle (status OPEN, same period). Each chip is checked to filter by comparing the list with the API for that chip. Deviation: the reason is the TC text "카테고리 오매핑 정정" prefixed with a traceable [AUTO-US079] tag. ${OPEN_DEV} ${CYCLE_DEV} ${YEAR_DEV} ${CLEAN}`);
    const spec: SeedSpec = { tc: 24, contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P01', [{ cycle: 'CY_MAIN', saleLines: 1 }]), product('P14', [{ cycle: 'CY_MAIN', saleLines: 1 }])] };
    let seeded!: Awaited<ReturnType<typeof seedData>>;
    let before: Awaited<ReturnType<typeof cycleRecord>>;
    let after: Awaited<ReturnType<typeof cycleRecord>>;
    const chipIds = {} as Record<ChipKey, { ui: string[]; api: string[]; pressed: boolean }>;
    const dialogs = new Observations(page);
    const closing = new Observations(page);
    const reason = reasonOf('TC_US079_24', '카테고리 오매핑 정정');

    await step('Arrange: Pre-condition 1–12 — CY_MAIN holds P01 and P14 (Resolved 12.50%, Matches), no correction', async () => {
      seeded = await seedData(spec);
    });

    await step('Act: Step 1 — Run SELECT id, period_start, period_end, status FROM settlement_cycle WHERE id = CY_MAIN', async () => {
      before = await cycleRecord(seeded.cycles.CY_MAIN.id);
    });

    await step('Assert: Expected 1 — CY_MAIN shows status OPEN with its period start and end', async () => {
      expect.soft(before?.status, '[Expected 1] CY_MAIN status = OPEN').toBe('OPEN');
      expect.soft(before?.periodStart, `[Expected 1] period_start = ${seeded.cycles.CY_MAIN.periodStart}`).toBe(seeded.cycles.CY_MAIN.periodStart);
      expect(before?.periodEnd, `[Expected 1] period_end = ${seeded.cycles.CY_MAIN.periodEnd}`).toBe(seeded.cycles.CY_MAIN.periodEnd);
    });

    await step(`Act: Step 2 — Open the screen on CY_MAIN (${seeded.cycles.CY_MAIN.label}) and click every bucket chip once`, async () => {
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id });
      for (const key of ALL_CHIPS) {
        await list.untilListed(() => list.click(list.chip(key), `${FR_KO[key]} chip`));
        const api = await feeReviewApi.products(seeded.cycles.CY_MAIN.id, CHIP_QUERY[key]);
        chipIds[key] = { ui: (await list.productIds()).sort(), api: api.content.map((r) => r.productId).sort(), pressed: (await list.chip(key).getAttribute('aria-pressed')) === 'true' };
      }
    });

    await step('Assert: Expected 2 — Each chip filters the list; no cycle-status control exists on the screen', async () => {
      for (const key of ALL_CHIPS) {
        expect.soft(chipIds[key].pressed, `[Expected 2] ${FR_KO[key]} is selected after its click`).toBe(true);
        expect.soft(chipIds[key].ui, `[Expected 2] ${FR_KO[key]} filters the list to its own rows`).toEqual(chipIds[key].api);
      }
      await expect(extras.cycleStatusControls, '[Expected 2] No cycle-status control (close / reopen period) exists').toHaveCount(0);
    });

    await step('Act: Step 3 — Open 근거 (Basis) on the P01 NORMAL row and close it; open 이력 (History) on the same row and close it', async () => {
      await list.clickChip(list.chip('bucket.ALL'));
      await list.openBasis(list.row(seeded.products.P01));
      await dialogs.record('[Expected 3] Panel 요율 산정 근거 (Why this rate) opens', () => list.basis.root.isVisible());
      await dialogs.screenshot('Why this rate panel (P01)');
      await list.basis.close();
      await dialogs.record('[Expected 3] Panel 요율 산정 근거 (Why this rate) closes', async () => (await list.basis.root.count()) === 0);
      await list.openHistory(list.row(seeded.products.P01));
      await dialogs.record('[Expected 3] Dialog 변경 이력 (Change history) opens', () => list.history.root.isVisible());
      await dialogs.screenshot('Change history dialog (P01)');
      await list.history.close();
      await dialogs.record('[Expected 3] Dialog 변경 이력 (Change history) closes', async () => (await list.history.root.count()) === 0);
    });

    await step('Assert: Expected 3 — Panel and dialog open and close', async () => {
      dialogs.assertAll();
    });

    await step('Act: Step 4 — Click 수정 (Correct) on P14, pick category B (FANCLUB_KIT, 9.00%) in Tier 1, enter the reason and click 저장 (Save)', async () => {
      await list.openCorrect(list.row(seeded.products.P14));
      await list.correct.pickCategory(seeded.master.categoryName.B);
      await list.correct.reasonInput.fill(reason);
      await list.correct.save();
    });

    await step('Assert: Expected 4 — Toast 승인 요청으로 상신되었습니다. 요율이 변경됩니다. shows; the row shows 수정됨 — 미상신', async () => {
      await expect.soft(list.toast(FR_KO['fix.savedDraft']), '[Expected 4] Toast 승인 요청으로 상신되었습니다. 요율이 변경됩니다. shows').toBeVisible();
      await expect(list.statusPills(list.row(seeded.products.P14)), '[Expected 4] P14 shows 수정됨 — 미상신 (Corrected — not submitted)').toContainText([FR_KO['state.DRAFT']]);
    });

    await step('Act: Step 5 — Tick the P14 row and click 선택 일괄 상신 (Submit selected)', async () => {
      await list.rowCheckbox(list.row(seeded.products.P14)).check();
      await list.submitSelected();
    });

    await step('Assert: Expected 5 — Toast 수정 1건을 승인 요청으로 상신했습니다. shows; the row shows 승인 대기', async () => {
      await expect.soft(list.toast(frFormat(FR_KO['msg.submitted'], { n: 1 })), '[Expected 5] Toast 수정 1건을 승인 요청으로 상신했습니다. shows').toBeVisible();
      await expect(list.statusPills(list.row(seeded.products.P14)), '[Expected 5] P14 shows 승인 대기 (Awaiting approval)').toContainText([FR_KO['state.PENDING']]);
    });

    await step('Act: Step 6 — Click 회수 (Withdraw) on the P14 row and confirm', async () => {
      await list.openWithdraw(list.row(seeded.products.P14));
      await list.withdraw.confirm();
    });

    await step('Assert: Expected 6 — Toast 수정 건을 회수했습니다. … shows', async () => {
      await expect(list.toast(FR_KO['withdraw.done']), '[Expected 6] Toast 수정 건을 회수했습니다. 승인 대기열에서 빠졌으며 다시 수정할 수 있습니다. shows').toBeVisible();
    });

    await step('Act: Step 7 — Open 이번 기 수정 내역 (Changes this period) and close it; click 목록 내보내기 (Export list) and download the CSV', async () => {
      await list.openReport();
      await closing.record('[Expected 7] Dialog 이번 기 수정 내역 (Changes this period) opens', () => list.report.root.isVisible());
      await closing.screenshot('Changes this period dialog');
      await list.report.close();
      await list.openExport();
      const file = await downloadCsv(list);
      await closing.record('[Expected 7] The CSV file downloads', async () => /\.csv$/.test(file.name));
    });

    await step('Assert: Expected 7 — The dialog opens and the file downloads', async () => {
      closing.assertAll();
    });

    await step('Act: Step 8 — Run the SQL of step 1 again', async () => {
      after = await cycleRecord(seeded.cycles.CY_MAIN.id);
    });

    await step('Assert: Expected 8 — CY_MAIN still shows status OPEN with the same period start and end', async () => {
      expect.soft(after?.status, '[Expected 8] CY_MAIN status is still OPEN').toBe('OPEN');
      expect.soft(after?.periodStart, '[Expected 8] period_start is unchanged').toBe(before?.periodStart);
      expect(after?.periodEnd, '[Expected 8] period_end is unchanged').toBe(before?.periodEnd);
    });
  });

  test("TC_US079_25 — The list holds one row per product in the cycle's settlement-target set", async ({ page, feeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const extras = new FeeReviewListAPage(page, list);
    await tcMeta('TC_US079_25', 'High', TAGS, `The list of CY_MAIN holds exactly one row per (product, policy) target row: P01 twice, P04 (Ambiguous), P06 (No row applies), P14 and P99 (target row without a product row — NO_BINDING), never X99 (product row without a target). After P20 (expired CT2), P21 (margin CT3) and P22 (fixed-amount CT4) are inserted, 기간 내 판매 상품 reads 9 with Needs review 5, Not computable 1, Resolved cleanly 3. The chip members in Expected 5 are checked through GET products of each bucket. Deviation: the seed helper has no FIXED_UNIT row type — CT4's row is sent with commissionType FIXED_UNIT through a cast (see report). ${OPEN_DEV} ${CYCLE_DEV} ${YEAR_DEV} ${CLEAN}`);
    const fixedUnit = row('R_FIXED', { category: 'B', type: 'FIXED_UNIT', rate: 500 });
    const spec: SeedSpec = {
      tc: 25,
      private: true,
      contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_C20'], ANNEX2: ['R_C22'], CT2: { rows: [row('R_A_CT2', { category: 'A', rate: 12.5 })], endAt: '2030-12-31T00:00:00Z' }, CT3: ['R_MARGIN'], CT4: [fixedUnit] }),
      cycles: ['CY_MAIN'],
      products: [
        product('P01', [{ cycle: 'CY_MAIN', saleLines: 3 }, { cycle: 'CY_MAIN', policy: 'PROMOTION', saleLines: 2 }]),
        product('P04', [{ cycle: 'CY_MAIN', saleLines: 1 }]),
        product('P06', [{ cycle: 'CY_MAIN', saleLines: 1 }]),
        product('P14', [{ cycle: 'CY_MAIN', saleLines: 1 }]),
        product('X99', []),
      ],
    };
    let seeded!: Awaited<ReturnType<typeof seedData>>;
    let id = (code: string) => code;
    let targetCount = -1;
    let apiPage!: FeeReviewPage;
    const members = { exc: [] as string[], nc: [] as string[], ok: [] as string[] };

    await step('Arrange: Pre-condition 1–16 — Families ROOT/ANNEX1/ANNEX2/CT2/CT3/CT4; CY_MAIN targets P01 ×2, P04, P06, P14, P99; X99 has no target', async () => {
      seeded = await seedData(spec);
      id = (code: string) => `${seeded.prefix}${code}`;
      // P99: dòng target không có dòng sản phẩm (NO_BINDING) — đúng câu SQL của pre-condition 13.
      await feeReviewDb.insertTargets([{ cycleId: seeded.cycles.CY_MAIN.id, productId: id('P99'), policy: 'NORMAL', saleLineCount: 1 }]);
    });

    await step('Act: Step 1 — Run SELECT COUNT(*) FROM fee_review_fixture_target WHERE settlement_cycle_id = CY_MAIN', async () => {
      targetCount = Number((await feeReviewDb.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM fee_review_fixture_target WHERE settlement_cycle_id = ?', [seeded.cycles.CY_MAIN.id]))[0]?.n ?? -1);
    });

    await step('Assert: Expected 1 — Count = 6', async () => {
      expect(targetCount, '[Expected 1] The target set of CY_MAIN holds 6 rows').toBe(6);
    });

    await step(`Act: Step 2 — Open the screen on CY_MAIN (${seeded.cycles.CY_MAIN.label}), then click chip 기간 내 판매 상품 (Products sold in period)`, async () => {
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id, pageSize: '10' });
      await list.clickChip(list.chip('bucket.ALL'));
    });

    await step('Assert: Expected 2 — Products sold in period reads 6 and the pager total reads 6', async () => {
      await expect.soft(extras.chipReading('bucket.ALL', 6), '[Expected 2] 기간 내 판매 상품 (Products sold in period) reads 6').toBeVisible();
      expect(await extras.pagerTotal(), '[Expected 2] The pager total reads 6').toBe(6);
    });

    await step('Act: Step 3 — Set 페이지당 (Rows per page) to 20', async () => {
      await list.setPageSize('20');
    });

    await step('Assert: Expected 3 — All 6 rows on one page with Resolved, Ambiguous and No row applies in one list; X99 not listed', async () => {
      await assertListed(extras, [id('P01'), id('P01'), id('P04'), id('P06'), id('P14'), id('P99')], '[Expected 3]');
      const statusCells = list.rows.locator('td:nth-child(6)');
      for (const key of ['status.RESOLVED', 'status.AMBIGUOUS', 'status.NO_ROW'] as const) {
        await expect.soft(statusCells.filter({ hasText: FR_KO[key] }), `[Expected 3] Status ${FR_KO[key]} (${FR_EN[key]}) shows in the list`).not.toHaveCount(0);
      }
      await expect(extras.rowsOf(id('X99')), '[Expected 3] X99 (no target row) is not listed').toHaveCount(0);
    });

    await step('Act: Step 4 — Call GET products of CY_MAIN (size 100)', async () => {
      apiPage = await feeReviewApi.products(seeded.cycles.CY_MAIN.id, { size: 100 });
    });

    await step('Assert: Expected 4 — totalElements = 6 and buckets.total = 6', async () => {
      expect.soft(apiPage.totalElements, '[Expected 4] totalElements = 6').toBe(6);
      expect(apiPage.buckets.total, '[Expected 4] buckets.total = 6').toBe(6);
    });

    await step('Act: Step 5 — Insert P20 (CT2), P21 (CT3), P22 (CT4) with a CY_MAIN target each, then click Search', async () => {
      const m = seeded.master;
      await feeReviewDb.insertProducts([
        { productId: id('P20'), productName: '[T079] P20', contractId: seeded.family.contracts.CT2, categoryId: m.category.A, saleTypeId: m.saleType.ST1, defaultSlotFeeRowId: null, promotionSlotFeeRowId: null },
        { productId: id('P21'), productName: '[T079] P21', contractId: seeded.family.contracts.CT3, categoryId: m.category.A, saleTypeId: m.saleType.ST1, defaultSlotFeeRowId: null, promotionSlotFeeRowId: null },
        { productId: id('P22'), productName: '[T079] P22', contractId: seeded.family.contracts.CT4, categoryId: m.category.B, saleTypeId: m.saleType.ST1, defaultSlotFeeRowId: null, promotionSlotFeeRowId: null },
      ]);
      await feeReviewDb.insertTargets(['P20', 'P21', 'P22'].map((code) => ({ cycleId: seeded.cycles.CY_MAIN.id, productId: id(code), policy: 'NORMAL' as const, saleLineCount: 1 })));
      await list.search('');
      const ids = async (bucket: Bucket) => (await feeReviewApi.products(seeded.cycles.CY_MAIN.id, { bucket })).content.map((r) => r.productId).sort();
      members.exc = await ids('NEEDS_REVIEW');
      members.nc = await ids('NOT_COMPUTABLE');
      members.ok = await ids('RESOLVED_CLEANLY');
    });

    await step('Assert: Expected 5 — Products sold in period reads 9; P20 No row applies, P21 Not computable, P22 Resolved with an empty rate; bucket counts 5 / 1 / 3', async () => {
      await expect.soft(extras.chipReading('bucket.ALL', 9), '[Expected 5] 기간 내 판매 상품 (Products sold in period) reads 9').toBeVisible();
      await expect.soft(list.cell(list.row(id('P20')), 'status'), '[Expected 5] P20 shows 적용 행 없음 (No row applies)').toContainText(FR_KO['status.NO_ROW']);
      await expect.soft(list.cell(list.row(id('P21')), 'status'), '[Expected 5] P21 shows 구간형 요율 — 산정 전 (Not computable)').toContainText(FR_KO['status.NOT_COMPUTABLE']);
      await expect.soft(list.cell(list.row(id('P22')), 'status'), '[Expected 5] P22 shows 산정 완료 (Resolved)').toContainText(FR_KO['status.RESOLVED']);
      await expect.soft(list.cell(list.row(id('P22')), 'rate'), '[Expected 5] P22 shows an empty rate').toHaveText(/^\s*(—|-)?\s*$/);
      await expect.soft(extras.chipReading('bucket.EXC', 5), '[Expected 5] 확인 필요 (Needs review) reads 5').toBeVisible();
      expect.soft(members.exc, '[Expected 5] Needs review holds P04, P06, P99, P20, P22').toEqual(['P04', 'P06', 'P20', 'P22', 'P99'].map(id).sort());
      await expect.soft(extras.chipReading('bucket.NC', 1), '[Expected 5] 구간형 요율 — 산정 전 (Not computable yet) reads 1').toBeVisible();
      expect.soft(members.nc, '[Expected 5] Not computable yet holds P21').toEqual([id('P21')]);
      await expect.soft(extras.chipReading('bucket.OK', 3), '[Expected 5] 정상 (Resolved cleanly) reads 3').toBeVisible();
      expect(members.ok, '[Expected 5] Resolved cleanly holds P01 twice and P14').toEqual([id('P01'), id('P01'), id('P14')].sort());
    });
  });

  test('TC_US079_26 — A refund-only product is not listed and a product with a sale and a refund is listed once', async ({ page, feeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const extras = new FeeReviewListAPage(page, list);
    await tcMeta('TC_US079_26', 'Medium', TAGS, `Refund simulation as the TC states: the US008 target read with refund lines is not delivered, so X99 (product row, no target row) stands for a refund-only product and P14 (one target row, 234 sale lines) for a product with a sale and a refund. X99 is not listed (empty state); P14 is listed once; the API returns one NORMAL item with saleLineCount 234. ${OPEN_DEV} ${CYCLE_DEV} ${YEAR_DEV} ${CLEAN}`);
    const spec: SeedSpec = { tc: 26, private: true, contracts: FAMILY_A, cycles: ['CY_MAIN'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }]), product('X99', [])] };
    let seeded!: Awaited<ReturnType<typeof seedData>>;
    let items: Array<Record<string, unknown>> = [];

    await step('Arrange: Pre-condition 1–12 — CY_MAIN targets P14 (234 sale lines); X99 has a product row and no target', async () => {
      seeded = await seedData(spec);
    });

    await step(`Act: Step 1 — Open the screen on CY_MAIN (${seeded.cycles.CY_MAIN.label}), then click chip 기간 내 판매 상품 (Products sold in period)`, async () => {
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id });
      await list.clickChip(list.chip('bucket.ALL'));
    });

    await step('Assert: Expected 1 — Products sold in period reads 1', async () => {
      await expect(extras.chipReading('bucket.ALL', 1), '[Expected 1] 기간 내 판매 상품 (Products sold in period) reads 1').toBeVisible();
    });

    await step('Act: Step 2 — Enter the X99 product id in 검색어 (Keyword) and click Search', async () => {
      await list.search(seeded.products.X99);
    });

    await step('Assert: Expected 2 — No row is listed; the empty state 이 기간에 해당하는 상품이 없습니다 shows', async () => {
      await expect.soft(extras.productIdCells, '[Expected 2] No row is listed').toHaveCount(0);
      await expect(list.emptyTitle, '[Expected 2] The empty state 이 기간에 해당하는 상품이 없습니다 (No products for this period) shows').toBeVisible();
    });

    await step('Act: Step 3 — Replace the keyword with the P14 product id and click Search', async () => {
      await list.search(seeded.products.P14);
    });

    await step('Assert: Expected 3 — Exactly 1 row P14 is listed', async () => {
      await assertListed(extras, [seeded.products.P14], '[Expected 3]');
    });

    await step('Act: Step 4 — Call GET products of CY_MAIN with keyword = P14', async () => {
      items = (await feeReviewApi.products(seeded.cycles.CY_MAIN.id, { keyword: seeded.products.P14 })).content as unknown as Array<Record<string, unknown>>;
    });

    await step('Assert: Expected 4 — One item with policy = NORMAL and saleLineCount = 234', async () => {
      expect.soft(items.length, '[Expected 4] One item is returned').toBe(1);
      expect.soft(items[0]?.policy, '[Expected 4] policy = NORMAL').toBe('NORMAL');
      expect(items[0]?.saleLineCount, '[Expected 4] saleLineCount = 234').toBe(234);
    });
  });

  test('TC_US079_27 — A product left out of the target set by its contract billing cycle does not appear', async ({ page, feeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const extras = new FeeReviewListAPage(page, list);
    await tcMeta('TC_US079_27', 'Medium', TAGS, `X99 (product row on C_ROOT, no target row — a product whose contract billing cycle has not come due) is not listed although its own trace resolves (RESOLVED, 12.50); inserting its target row makes it appear once (Resolved, 12.50%, Matches) and deleting the row makes it disappear again. The INSERT / DELETE are the TC's SQL steps. ${OPEN_DEV} ${CYCLE_DEV} ${YEAR_DEV} ${CLEAN}`);
    const spec: SeedSpec = { tc: 27, contracts: FAMILY_A, cycles: ['CY_MAIN'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 1 }]), product('X99', [])] };
    let seeded!: Awaited<ReturnType<typeof seedData>>;
    let x99 = '';
    let targetRows = -1;
    let trace: { status: number; body: Record<string, unknown> } = { status: 0, body: {} };

    await step('Arrange: Pre-condition 1–11 — CY_MAIN targets P14; X99 has a product row (C_ROOT, CAT_A, ST1, slot R_A) and no target row', async () => {
      seeded = await seedData(spec);
      x99 = seeded.products.X99;
    });

    await step('Act: Step 1 — Run SELECT * FROM fee_review_fixture_target for CY_MAIN and X99', async () => {
      targetRows = (await feeReviewDb.query<RowDataPacket[]>('SELECT * FROM fee_review_fixture_target WHERE settlement_cycle_id = ? AND product_id = ?', [seeded.cycles.CY_MAIN.id, x99])).length;
    });

    await step('Assert: Expected 1 — 0 rows', async () => {
      expect(targetRows, '[Expected 1] X99 has no target row on CY_MAIN').toBe(0);
    });

    await step(`Act: Step 2 — Open the screen on CY_MAIN (${seeded.cycles.CY_MAIN.label}), click chip 기간 내 판매 상품, enter the X99 id in 검색어 and click Search`, async () => {
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id });
      await list.clickChip(list.chip('bucket.ALL'));
      await list.search(x99);
    });

    await step('Assert: Expected 2 — No row is listed; the empty state 이 기간에 해당하는 상품이 없습니다 shows', async () => {
      await expect.soft(extras.productIdCells, '[Expected 2] No row is listed').toHaveCount(0);
      await expect(list.emptyTitle, '[Expected 2] The empty state 이 기간에 해당하는 상품이 없습니다 (No products for this period) shows').toBeVisible();
    });

    await step('Act: Step 3 — Call GET trace of X99 on CY_MAIN (policy NORMAL)', async () => {
      const r = await feeReviewApi.trace(seeded.cycles.CY_MAIN.id, x99);
      trace = { status: r.status, body: r.body ?? {} };
    });

    await step('Assert: Expected 3 — HTTP 200, status RESOLVED, rate 12.50', async () => {
      expect.soft(trace.status, '[Expected 3] HTTP 200').toBe(200);
      expect.soft(trace.body.status, '[Expected 3] status = RESOLVED').toBe('RESOLVED');
      expect(trace.body.inForceRate, '[Expected 3] inForceRate = 12.50').toBe('12.50');
    });

    await step('Act: Step 4 — Insert the CY_MAIN target row of X99 and click Search', async () => {
      await feeReviewDb.insertTargets([{ cycleId: seeded.cycles.CY_MAIN.id, productId: x99, policy: 'NORMAL', saleLineCount: 1 }]);
      await list.search(x99);
    });

    await step('Assert: Expected 4 — X99 appears once with 산정 완료, 12.50%, 일치', async () => {
      await expect.soft(extras.rowsOf(x99), '[Expected 4] X99 appears once').toHaveCount(1);
      await expect.soft(list.cell(list.row(x99), 'status'), '[Expected 4] X99 shows 산정 완료 (Resolved)').toContainText(FR_KO['status.RESOLVED']);
      await expect.soft(list.cell(list.row(x99), 'rate'), '[Expected 4] X99 shows 12.50%').toHaveText('12.50%');
      await expect(list.cell(list.row(x99), 'compare'), '[Expected 4] X99 shows 일치 (Matches)').toHaveText(FR_KO['compare.MATCHES']);
    });

    await step('Act: Step 5 — Delete the CY_MAIN target row of X99 and click Search', async () => {
      await feeReviewDb.execute('DELETE FROM fee_review_fixture_target WHERE settlement_cycle_id = ? AND product_id = ?', [seeded.cycles.CY_MAIN.id, x99]);
      await list.search(x99);
    });

    await step('Assert: Expected 5 — X99 disappears again', async () => {
      await expect(extras.rowsOf(x99), '[Expected 5] X99 is no longer listed').toHaveCount(0);
    });
  });

  test('TC_US079_28 — A product sold under two policies in one cycle shows as two rows', async ({ page, feeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const extras = new FeeReviewListAPage(page, list);
    await tcMeta('TC_US079_28', 'Medium', TAGS, `P01 with a NORMAL and a PROMOTION target on CY_MAIN shows as two rows, each Resolved 12.50% Matches; the API returns both policies with their sale lines; the PROMOTION trace keeps derivedKey.policy = PROMOTION while the winning row is R_A (NORMAL) and the verdict is MATCHES (SPEC-GAP-15: policy is a ladder tier, not a filter). The trace fields candidates[].feeRowId / won and verdict are read as the TC names them. ${OPEN_DEV} ${CYCLE_DEV} ${YEAR_DEV} ${CLEAN}`);
    const spec: SeedSpec = { tc: 28, contracts: FAMILY_A, cycles: ['CY_MAIN'], products: [product('P01', [{ cycle: 'CY_MAIN', saleLines: 3 }, { cycle: 'CY_MAIN', policy: 'PROMOTION', saleLines: 2 }])] };
    let seeded!: Awaited<ReturnType<typeof seedData>>;
    let p01 = '';
    let items: Array<Record<string, unknown>> = [];
    let trace: Record<string, unknown> = {};

    await step('Arrange: Pre-condition 1–11 — CY_MAIN targets P01 under NORMAL (3 lines) and PROMOTION (2 lines); C_ROOT has no PROMOTION row for CAT_A', async () => {
      seeded = await seedData(spec);
      p01 = seeded.products.P01;
    });

    await step(`Act: Step 1 — Open the screen on CY_MAIN (${seeded.cycles.CY_MAIN.label}), click chip 기간 내 판매 상품, enter the P01 id in 검색어 and click Search`, async () => {
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id });
      await list.clickChip(list.chip('bucket.ALL'));
      await list.search(p01);
    });

    await step('Assert: Expected 1 — Two P01 rows are listed, each 산정 완료, 12.50%, 일치', async () => {
      await expect.soft(extras.rowsOf(p01), '[Expected 1] Two P01 rows are listed').toHaveCount(2);
      for (const i of [0, 1]) {
        await expect.soft(list.cell(list.row(p01, i), 'status'), `[Expected 1] P01 row ${i + 1} shows 산정 완료 (Resolved)`).toContainText(FR_KO['status.RESOLVED']);
        await expect.soft(list.cell(list.row(p01, i), 'rate'), `[Expected 1] P01 row ${i + 1} shows 12.50%`).toHaveText('12.50%');
        await expect.soft(list.cell(list.row(p01, i), 'compare'), `[Expected 1] P01 row ${i + 1} shows 일치 (Matches)`).toHaveText(FR_KO['compare.MATCHES']);
      }
      await expect(extras.productIdCells, '[Expected 1] Only the two P01 rows are listed').toHaveCount(2);
    });

    await step('Act: Step 2 — Call GET products of CY_MAIN with keyword = P01', async () => {
      items = (await feeReviewApi.products(seeded.cycles.CY_MAIN.id, { keyword: p01 })).content as unknown as Array<Record<string, unknown>>;
    });

    await step('Assert: Expected 2 — NORMAL (3 lines) and PROMOTION (2 lines), both 12.50 and RESOLVED_CLEANLY', async () => {
      const normal = items.find((i) => i.policy === 'NORMAL');
      const promo = items.find((i) => i.policy === 'PROMOTION');
      expect.soft(items.length, '[Expected 2] Two items are returned').toBe(2);
      expect.soft(normal?.saleLineCount, '[Expected 2] NORMAL has saleLineCount = 3').toBe(3);
      expect.soft(promo?.saleLineCount, '[Expected 2] PROMOTION has saleLineCount = 2').toBe(2);
      for (const [name, item] of [['NORMAL', normal], ['PROMOTION', promo]] as const) {
        expect.soft(item?.inForceRate, `[Expected 2] ${name} inForceRate = "12.50"`).toBe('12.50');
        expect.soft(item?.bucket, `[Expected 2] ${name} bucket = RESOLVED_CLEANLY`).toBe('RESOLVED_CLEANLY');
      }
      expect(items.map((i) => i.policy).sort(), '[Expected 2] The two items are NORMAL and PROMOTION').toEqual(['NORMAL', 'PROMOTION']);
    });

    await step('Act: Step 3 — Call GET trace of P01 on CY_MAIN with policy = PROMOTION', async () => {
      trace = (await feeReviewApi.trace(seeded.cycles.CY_MAIN.id, p01, 'PROMOTION')).body ?? {};
    });

    await step('Assert: Expected 3 — derivedKey.policy = PROMOTION; the winner is R_A (NORMAL); verdict MATCHES against the default slot', async () => {
      const candidates = (trace.candidates as Array<Record<string, unknown>> | undefined) ?? [];
      const winner = candidates.find((c) => c.won === true);
      expect.soft((trace.derivedKey as Record<string, unknown> | undefined)?.policy, '[Expected 3] derivedKey.policy = PROMOTION').toBe('PROMOTION');
      expect.soft(String(winner?.feeRowId ?? ''), `[Expected 3] The winning row is R_A (${seeded.family.rows.R_A})`).toBe(String(seeded.family.rows.R_A));
      expect(findKey(trace, 'verdict'), '[Expected 3] verdict = MATCHES against the default slot').toBe('MATCHES');
    });
  });

  test('TC_US079_29 — A cycle with no settlement data shows the empty state with every bucket at zero', async ({ page, feeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const extras = new FeeReviewListAPage(page, list);
    await tcMeta('TC_US079_29', 'Medium', TAGS, `The empty CY_EMPTY (a new cycle with no target row, no contract, no fixture product) lists no row and shows the STL-1014 message; all ten chips read 0; the API returns content [], totalElements 0, emptyStateCode STL-1014 and zero in every bucket and problem count. ${OPEN_DEV} ${CYCLE_DEV} ${YEAR_DEV} Data: creates one empty cycle only (no delete API).`);
    const spec: SeedSpec = { tc: 29, private: true, contracts: [], cycles: ['CY_EMPTY'], products: [] };
    let seeded!: Awaited<ReturnType<typeof seedData>>;
    let apiPage!: FeeReviewPage;

    await step('Arrange: Pre-condition 1–6 — CY_EMPTY exists with 0 target rows', async () => {
      seeded = await seedData(spec);
      const n = Number((await feeReviewDb.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM fee_review_fixture_target WHERE settlement_cycle_id = ?', [seeded.cycles.CY_EMPTY.id]))[0]?.n ?? -1);
      expect(n, 'CY_EMPTY holds no target row').toBe(0);
    });

    await step(`Act: Step 1 — Open the screen on CY_EMPTY (${seeded.cycles.CY_EMPTY.label})`, async () => {
      await list.open({ cycleId: seeded.cycles.CY_EMPTY.id });
    });

    await step('Assert: Expected 1 — No row is listed and the list area shows the no-settlement-data message', async () => {
      await expect.soft(extras.productIdCells, '[Expected 1] No row is listed').toHaveCount(0);
      await expect(list.noSettlementData, '[Expected 1] 이 주기에는 아직 정산 데이터가 없습니다. 데이터 적재·계산이 끝나면 목록이 표시됩니다. shows').toBeVisible();
    });

    await step('Act: Step 2 — Read every bucket chip', async () => {
      await list.partitionGroup.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Every chip reads 0', async () => {
      for (const key of ALL_CHIPS) await expect.soft(extras.chipReading(key, 0), `[Expected 2] ${FR_KO[key]} (${FR_EN[key]}) reads 0`).toBeVisible();
    });

    await step('Act: Step 3 — Call GET products of CY_EMPTY', async () => {
      apiPage = await feeReviewApi.products(seeded.cycles.CY_EMPTY.id);
    });

    await step('Assert: Expected 3 — HTTP 200, content = [], totalElements = 0, emptyStateCode = STL-1014, every bucket and problem count 0', async () => {
      expect.soft(apiPage.content, '[Expected 3] content = []').toEqual([]);
      expect.soft(apiPage.totalElements, '[Expected 3] totalElements = 0').toBe(0);
      expect.soft(apiPage.emptyStateCode, '[Expected 3] emptyStateCode = STL-1014').toBe('STL-1014');
      for (const [name, value] of Object.entries({ ...apiPage.buckets })) expect.soft(value, `[Expected 3] buckets.${name} = 0`).toBe(0);
      for (const [name, value] of Object.entries({ ...apiPage.problems })) expect.soft(value, `[Expected 3] problems.${name} = 0`).toBe(0);
      expect(Object.keys(apiPage.buckets ?? {}).length, '[Expected 3] The bucket counts are returned').toBeGreaterThan(0);
    });
  });

  test('TC_US079_30 — The keyword runs only on Search or Enter for each search condition', async ({ page, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const extras = new FeeReviewListAPage(page, list);
    await tcMeta('TC_US079_30', 'Medium', TAGS, `Typing a keyword does nothing until 검색 or Enter; 검색 is disabled while the query runs; the keyword finds P03 by product ID and by name (MISMATCH), P09 by fee category (FANCLUB title) and the three C_ROOT products by contract name. Steps 5–7 are expected to FAIL on develop (no Search condition — the keyword matches product ID or name only; TC remark). The "disabled while the query runs" check holds the list response until the button state is read. ${COND_DEV} ${OPEN_DEV} ${CYCLE_DEV} ${YEAR_DEV} ${CLEAN}`);
    const spec: SeedSpec = {
      tc: 30,
      private: true,
      contracts: family({ ROOT: ['R_A', 'R_B10', 'R_PROMO'], ANNEX1: ['R_B9'] }),
      cycles: ['CY_MAIN'],
      products: [
        product('P03', [{ cycle: 'CY_MAIN', saleLines: 1 }], { name: '[T079] MISMATCH — slot = root row' }),
        product('P09', [{ cycle: 'CY_MAIN', saleLines: 1 }]),
        product('P12', [{ cycle: 'CY_MAIN', saleLines: 1 }]),
        product('P14', [{ cycle: 'CY_MAIN', saleLines: 1 }]),
      ],
    };
    let seeded!: Awaited<ReturnType<typeof seedData>>;
    let busyDisabled = false;
    let requests: string[] = [];

    await step('Arrange: Pre-condition 1–12 — CY_MAIN holds P03 (name with MISMATCH), P09 (CAT_E), P12 (no contract) and P14', async () => {
      seeded = await seedData(spec);
    });

    await step(`Act: Step 1 — Open the screen on CY_MAIN (${seeded.cycles.CY_MAIN.label}), then click chip 기간 내 판매 상품 (Products sold in period)`, async () => {
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id });
      await list.clickChip(list.chip('bucket.ALL'));
    });

    await step('Assert: Expected 1 — Products sold in period lists 4 rows; Keyword shows placeholder 검색어를 입력하세요', async () => {
      await expect.soft(extras.productIdCells, '[Expected 1] 4 rows are listed').toHaveCount(4);
      await expect(list.keywordInput, '[Expected 1] Keyword shows placeholder 검색어를 입력하세요 (Enter a keyword)').toHaveAttribute('placeholder', FR_KO['filter.keywordPlaceholder']);
    });

    await step('Act: Step 2 — Select 검색 조건 = 상품ID (Product ID) and type the P03 id in 검색어 — press nothing', async () => {
      requests = extras.trackListRequests();
      await list.keywordInput.fill(seeded.products.P03);
    });

    await step('Assert: Expected 2 — The list still shows 4 rows', async () => {
      expect.soft(requests, '[Expected 2] Typing runs no query').toHaveLength(0);
      await expect(extras.productIdCells, '[Expected 2] The list still shows 4 rows').toHaveCount(4);
    });

    await step('Act: Step 3 — Click Search', async () => {
      busyDisabled = await extras.searchObservingBusy();
    });

    await step('Assert: Expected 3 — Search is disabled while the query runs; then exactly 1 row P03 is listed', async () => {
      expect.soft(busyDisabled, '[Expected 3] 검색 (Search) is disabled while the query runs').toBe(true);
      await assertListed(extras, [seeded.products.P03], '[Expected 3]');
    });

    await step('Act: Step 4 — Select 검색 조건 = 상품명 (Product name), replace the keyword with MISMATCH and press Enter', async () => {
      await list.keywordInput.fill('MISMATCH');
      await extras.maybeListed(() => list.keywordInput.press('Enter'));
    });

    await step('Assert: Expected 4 — Exactly 1 row P03 is listed', async () => {
      await assertListed(extras, [seeded.products.P03], '[Expected 4]');
    });

    await step(`Act: Step 5 — Select 검색 조건 = 수수료 카테고리 (Fee category), replace the keyword with "${seeded.master.categoryName.E}" and click Search`, async () => {
      await list.search(seeded.master.categoryName.E);
    });

    await step('Assert: Expected 5 — Exactly 1 row P09 is listed', async () => {
      await assertListed(extras, [seeded.products.P09], '[Expected 5]');
    });

    await step(`Act: Step 6 — Select 검색 조건 = 계약 (Contract), replace the keyword with "[T079-${seeded.run}-30] ROOT" — press nothing`, async () => {
      requests.length = 0;
      await list.keywordInput.fill(`[T079-${seeded.run}-30] ROOT`);
    });

    await step('Assert: Expected 6 — The list still shows only P09', async () => {
      expect.soft(requests, '[Expected 6] Typing runs no query').toHaveLength(0);
      await expect(extras.productIdCells, '[Expected 6] The list still shows only P09').toHaveText([seeded.products.P09]);
    });

    await step('Act: Step 7 — Press Enter', async () => {
      await extras.maybeListed(() => list.keywordInput.press('Enter'));
    });

    await step('Assert: Expected 7 — 3 rows are listed (P03, P09, P14); P12 is not listed', async () => {
      await expect.soft(extras.rowsOf(seeded.products.P12), '[Expected 7] P12 (no contract) is not listed').toHaveCount(0);
      await assertListed(extras, [seeded.products.P03, seeded.products.P09, seeded.products.P14], '[Expected 7]');
    });
  });

  test('TC_US079_31 — Changing the search condition alone does not run the query', async ({ page, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const extras = new FeeReviewListAPage(page, list);
    await tcMeta('TC_US079_31', 'Low', TAGS, `After a 상품ID search lists P03, switching 검색 조건 to 상품명 runs no query; the next 검색 searches the same keyword by name and finds nothing (product names carry no product ID). Expected to FAIL on develop: the Search condition control is absent and the keyword still matches the product ID (TC remark). ${COND_DEV} ${OPEN_DEV} ${CYCLE_DEV} ${YEAR_DEV} ${CLEAN}`);
    const spec: SeedSpec = { tc: 31, private: true, contracts: FAMILY_AB, cycles: ['CY_MAIN'], products: [product('P03', [{ cycle: 'CY_MAIN', saleLines: 1 }], { name: '[T079] MISMATCH — slot = root row' }), product('P14', [{ cycle: 'CY_MAIN', saleLines: 1 }])] };
    let seeded!: Awaited<ReturnType<typeof seedData>>;
    let requests: string[] = [];
    let conditionPresent = false;

    await step('Arrange: Pre-condition 1–12 — CY_MAIN holds P03 and P14; product names carry no product ID', async () => {
      seeded = await seedData(spec);
    });

    await step(`Act: Step 1 — Open the screen on CY_MAIN (${seeded.cycles.CY_MAIN.label}), then click chip 기간 내 판매 상품 (Products sold in period)`, async () => {
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id });
      await list.clickChip(list.chip('bucket.ALL'));
    });

    await step('Assert: Expected 1 — 2 rows are listed', async () => {
      await expect(extras.productIdCells, '[Expected 1] 2 rows are listed').toHaveCount(2);
    });

    await step('Act: Step 2 — Select 검색 조건 = 상품ID (Product ID), type the P03 id in 검색어 and click Search', async () => {
      await list.search(seeded.products.P03);
    });

    await step('Assert: Expected 2 — Exactly 1 row P03 is listed', async () => {
      await assertListed(extras, [seeded.products.P03], '[Expected 2]');
    });

    await step('Act: Step 3 — Change 검색 조건 to 상품명 (Product name) — press nothing', async () => {
      requests = extras.trackListRequests();
      conditionPresent = (await list.searchConditionSelect.count()) > 0;
      if (conditionPresent) await list.searchConditionSelect.selectOption({ label: '상품명' });
    });

    await step('Assert: Expected 3 — No query runs; the list still shows P03 only', async () => {
      expect.soft(conditionPresent, '[Expected 3] The 검색 조건 (Search condition) control exists to be changed').toBe(true);
      expect.soft(requests, '[Expected 3] No query runs').toHaveLength(0);
      await expect(extras.productIdCells, '[Expected 3] The list still shows P03 only').toHaveText([seeded.products.P03]);
    });

    await step('Act: Step 4 — Click Search', async () => {
      await list.untilListed(() => list.click(list.searchButton, '검색 (Search) button'));
    });

    await step('Assert: Expected 4 — No row is listed; the empty state 이 기간에 해당하는 상품이 없습니다 shows', async () => {
      await expect.soft(extras.productIdCells, '[Expected 4] No row is listed').toHaveCount(0);
      await expect(list.emptyTitle, '[Expected 4] The empty state 이 기간에 해당하는 상품이 없습니다 (No products for this period) shows').toBeVisible();
    });
  });

  test('TC_US079_32 — Picking a bucket keeps the keyword and shows only rows matching both', async ({ page, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const extras = new FeeReviewListAPage(page, list);
    await tcMeta('TC_US079_32', 'Medium', TAGS, `A searched keyword "…-P0" stays applied when 확인 필요 and 정상 are picked (rows matching both), while the chip counts keep counting the whole cycle (Needs review 4, Resolved cleanly 2); a keyword typed but not searched ("…-P1") is used by the next chip click. Step 5 is expected to FAIL on develop (the FE keeps the last searched keyword — TC remark). ${OPEN_DEV} ${CYCLE_DEV} ${YEAR_DEV} ${CLEAN}`);
    const spec: SeedSpec = {
      tc: 32,
      private: true,
      contracts: FAMILY_AB,
      cycles: ['CY_MAIN'],
      products: (['P01', 'P03', 'P05', 'P10', 'P13', 'P14'] as const).map((code) => product(code, [{ cycle: 'CY_MAIN', saleLines: 1 }])),
    };
    let seeded!: Awaited<ReturnType<typeof seedData>>;
    let id = (code: string) => code;
    let requests: string[] = [];

    await step('Arrange: Pre-condition 1–12 — CY_MAIN: Needs review P03, P05, P10, P13; Resolved cleanly P01, P14', async () => {
      seeded = await seedData(spec);
      id = (code: string) => `${seeded.prefix}${code}`;
    });

    await step(`Act: Step 1 — Open the screen on CY_MAIN (${seeded.cycles.CY_MAIN.label}), then click chip 기간 내 판매 상품 (Products sold in period)`, async () => {
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id });
      await list.clickChip(list.chip('bucket.ALL'));
    });

    await step('Assert: Expected 1 — 6 rows are listed', async () => {
      await expect(extras.productIdCells, '[Expected 1] 6 rows are listed').toHaveCount(6);
    });

    await step(`Act: Step 2 — Type "${id('P0')}" in 검색어 (Keyword) and click Search`, async () => {
      await list.search(id('P0'));
    });

    await step('Assert: Expected 2 — 3 rows are listed: P01, P03, P05', async () => {
      await assertListed(extras, [id('P01'), id('P03'), id('P05')], '[Expected 2]');
    });

    await step('Act: Step 3 — Click chip 확인 필요 (Needs review)', async () => {
      await list.clickChip(list.chip('bucket.EXC'));
    });

    await step('Assert: Expected 3 — The keyword stays; P03 and P05 are listed; Needs review reads 4 and Resolved cleanly 2', async () => {
      await expect.soft(list.keywordInput, '[Expected 3] The keyword stays in the box').toHaveValue(id('P0'));
      await assertListed(extras, [id('P03'), id('P05')], '[Expected 3]');
      await expect.soft(extras.chipReading('bucket.EXC', 4), '[Expected 3] 확인 필요 (Needs review) still reads 4').toBeVisible();
      await expect(extras.chipReading('bucket.OK', 2), '[Expected 3] 정상 (Resolved cleanly) still reads 2').toBeVisible();
    });

    await step('Act: Step 4 — Click chip 정상 (Resolved cleanly)', async () => {
      await list.clickChip(list.chip('bucket.OK'));
    });

    await step('Assert: Expected 4 — The keyword stays; 1 row is listed: P01', async () => {
      await expect.soft(list.keywordInput, '[Expected 4] The keyword stays in the box').toHaveValue(id('P0'));
      await assertListed(extras, [id('P01')], '[Expected 4]');
    });

    await step(`Act: Step 5 — Replace the keyword with "${id('P1')}" — do not click Search — and click chip Needs review`, async () => {
      await list.keywordInput.fill(id('P1'));
      requests = extras.trackListRequests();
      await list.clickChip(list.chip('bucket.EXC'));
    });

    await step('Assert: Expected 5 — The query runs with the keyword on screen; 2 rows are listed: P10, P13', async () => {
      expect.soft(requests.map((u) => new URL(u).searchParams.get('keyword')), `[Expected 5] The query runs with the keyword on screen "${id('P1')}"`).toContain(id('P1'));
      await assertListed(extras, [id('P10'), id('P13')], '[Expected 5]');
    });
  });

  test('TC_US079_33 — Reset clears the criteria, returns to Needs review and reloads the list', async ({ page, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const extras = new FeeReviewListAPage(page, list);
    await tcMeta('TC_US079_33', 'Medium', TAGS, `After a 상품ID search for P01 under 정상, 초기화 resets 검색 조건 to 상품명, empties the keyword, re-selects 확인 필요 and reloads the list with P03 and P05. Expected to FAIL on develop: Reset clears the keyword only — no bucket reset, no re-query (TC remark). ${COND_DEV} ${OPEN_DEV} ${CYCLE_DEV} ${YEAR_DEV} ${CLEAN}`);
    const spec: SeedSpec = {
      tc: 33,
      private: true,
      contracts: FAMILY_AB,
      cycles: ['CY_MAIN'],
      products: [product('P01', [{ cycle: 'CY_MAIN', saleLines: 1 }, { cycle: 'CY_MAIN', policy: 'PROMOTION', saleLines: 1 }]), product('P03', [{ cycle: 'CY_MAIN', saleLines: 1 }]), product('P05', [{ cycle: 'CY_MAIN', saleLines: 1 }])],
    };
    let seeded!: Awaited<ReturnType<typeof seedData>>;
    let reloaded = false;

    await step('Arrange: Pre-condition 1–12 — CY_MAIN: Needs review P03, P05; Resolved cleanly P01 NORMAL and PROMOTION', async () => {
      seeded = await seedData(spec);
    });

    await step(`Act: Step 1 — Open the screen on CY_MAIN (${seeded.cycles.CY_MAIN.label})`, async () => {
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id });
    });

    await step('Assert: Expected 1 — Chip 확인 필요 (Needs review) is selected and lists P03, P05', async () => {
      await expect.soft(list.chip('bucket.EXC'), '[Expected 1] 확인 필요 (Needs review) is selected').toHaveAttribute('aria-pressed', 'true');
      await assertListed(extras, [seeded.products.P03, seeded.products.P05], '[Expected 1]');
    });

    await step('Act: Step 2 — Select 검색 조건 = 상품ID (Product ID), type the P01 id, click Search, then click chip 정상 (Resolved cleanly)', async () => {
      await list.search(seeded.products.P01);
      await list.clickChip(list.chip('bucket.OK'));
    });

    await step('Assert: Expected 2 — 2 rows P01 are listed under Resolved cleanly', async () => {
      await expect.soft(list.chip('bucket.OK'), '[Expected 2] 정상 (Resolved cleanly) is selected').toHaveAttribute('aria-pressed', 'true');
      await assertListed(extras, [seeded.products.P01, seeded.products.P01], '[Expected 2]');
    });

    await step('Act: Step 3 — Click 초기화 (Reset)', async () => {
      reloaded = (await extras.maybeListed(() => list.click(list.resetButton, '초기화 (Reset) button'))) !== null;
    });

    await step('Assert: Expected 3 — Search condition = 상품명, Keyword empty, Needs review selected and the list reloads with P03, P05', async () => {
      await expect.soft(list.searchConditionSelect.locator('option:checked'), '[Expected 3] 검색 조건 (Search condition) returns to 상품명 (Product name)').toHaveText('상품명');
      await expect.soft(list.keywordInput, '[Expected 3] Keyword is empty').toHaveValue('');
      await expect.soft(list.chip('bucket.EXC'), '[Expected 3] 확인 필요 (Needs review) is selected').toHaveAttribute('aria-pressed', 'true');
      expect.soft(reloaded, '[Expected 3] The list reloads').toBe(true);
      await assertListed(extras, [seeded.products.P03, seeded.products.P05], '[Expected 3]');
    });
  });

  test('TC_US079_34 — A search with no match shows the empty state and its Reset filter action', async ({ page, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const extras = new FeeReviewListAPage(page, list);
    await tcMeta('TC_US079_34', 'Low', TAGS, `A keyword with no match ("…-ZZZ") shows the empty state — title, subtitle and the 필터 초기화 (Reset filter) button; the button clears the keyword and reloads the cycle's row P14. ${OPEN_DEV} ${CYCLE_DEV} ${YEAR_DEV} ${CLEAN}`);
    const spec: SeedSpec = { tc: 34, private: true, contracts: FAMILY_A, cycles: ['CY_MAIN'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 1 }])] };
    let seeded!: Awaited<ReturnType<typeof seedData>>;

    await step('Arrange: Pre-condition 1–11 — CY_MAIN holds P14 (Resolved 12.50%)', async () => {
      seeded = await seedData(spec);
    });

    await step(`Act: Step 1 — Open the screen on CY_MAIN (${seeded.cycles.CY_MAIN.label}), then click chip 기간 내 판매 상품 (Products sold in period)`, async () => {
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id });
      await list.clickChip(list.chip('bucket.ALL'));
    });

    await step('Assert: Expected 1 — 1 row P14 is listed', async () => {
      await assertListed(extras, [seeded.products.P14], '[Expected 1]');
    });

    await step(`Act: Step 2 — Type "${seeded.prefix}ZZZ" in 검색어 (Keyword) and click Search`, async () => {
      await list.search(`${seeded.prefix}ZZZ`);
    });

    await step('Assert: Expected 2 — No row is listed and the empty state shows its title, subtitle and the Reset filter button', async () => {
      await expect.soft(extras.productIdCells, '[Expected 2] No row is listed').toHaveCount(0);
      await expect.soft(list.emptyTitle, '[Expected 2] Title 이 기간에 해당하는 상품이 없습니다 (No products for this period)').toBeVisible();
      await expect.soft(list.emptySubtitle, '[Expected 2] Subtitle 이 주기에 아직 정산 데이터가 없거나, 필터에 맞는 행이 없습니다.').toBeVisible();
      await expect(list.emptyCta, '[Expected 2] Button 필터 초기화 (Reset filter)').toBeVisible();
    });

    await step('Act: Step 3 — Click 필터 초기화 (Reset filter)', async () => {
      await extras.maybeListed(() => list.click(list.emptyCta, '필터 초기화 (Reset filter) button'));
    });

    await step("Assert: Expected 3 — The keyword is cleared and the list reloads with the cycle's row P14", async () => {
      await expect.soft(list.keywordInput, '[Expected 3] The keyword is cleared').toHaveValue('');
      await assertListed(extras, [seeded.products.P14], '[Expected 3]');
    });
  });

  test('TC_US079_35 — Page and rows-per-page changes apply at once for 10, 20, 50 and 100 rows', async ({ page, playwright, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const extras = new FeeReviewListAPage(page, list);
    await tcMeta('TC_US079_35', 'Medium', TAGS, `With 53 resolved products B001…B053 on CY_MAIN (sorted by product ID), the pager pages at 10 / 20 / 50 / 100 rows without Search: page 2 holds B011–B020, the last page (6) B051–B053, 20 rows → 3 pages, 50 rows → 2 pages with B051–B053 on page 2, 100 rows → all 53 on one page; the pager total and the 기간 내 판매 상품 count stay 53 throughout; size 101 is refused with HTTP 400 CMN-4000. ${OPEN_DEV} ${CYCLE_DEV} ${YEAR_DEV} ${CLEAN}`);
    const spec: SeedSpec = { tc: 35, private: true, contracts: FAMILY_A, cycles: ['CY_MAIN'], products: bulk(53) };
    let seeded!: Awaited<ReturnType<typeof seedData>>;
    let b = (n: number) => String(n);
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => b(from + i));
    const totals: Array<{ at: string; pager: number | null; chip: number }> = [];
    const note = async (at: string) => totals.push({ at, pager: await extras.pagerTotal(), chip: await list.chipCount(list.chip('bucket.ALL')) });
    let oversize = { status: 0, body: '' };

    await step('Arrange: Pre-condition 1–12 — CY_MAIN holds 53 products B001…B053, each Resolved 12.50% Matches', async () => {
      seeded = await seedData(spec);
      b = (n: number) => `${seeded.prefix}B${String(n).padStart(3, '0')}`;
    });

    await step(`Act: Step 1 — Open the screen on CY_MAIN (${seeded.cycles.CY_MAIN.label}), then click chip 기간 내 판매 상품 (Products sold in period)`, async () => {
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id, pageSize: '10' });
      await list.clickChip(list.chip('bucket.ALL'));
      await note('Step 1');
    });

    await step('Assert: Expected 1 — Pager total reads 53; page 1 shows 10 rows B001…B010', async () => {
      expect.soft(await extras.pagerTotal(), '[Expected 1] The pager total reads 53').toBe(53);
      await expect(extras.productIdCells, '[Expected 1] Page 1 shows B001…B010').toHaveText(range(1, 10));
    });

    await step('Act: Step 2 — Click page 2 in the pager', async () => {
      await list.goToPage(/^2$/);
      await note('Step 2');
    });

    await step('Assert: Expected 2 — Page 2 shows B011…B020 at once, without Search', async () => {
      await expect(extras.productIdCells, '[Expected 2] Page 2 shows B011…B020').toHaveText(range(11, 20));
    });

    await step('Act: Step 3 — Click the last page', async () => {
      await list.goToPage('Last');
      await note('Step 3');
    });

    await step('Assert: Expected 3 — Page 6 shows 3 rows: B051, B052, B053', async () => {
      await expect.soft(extras.currentPage, '[Expected 3] The last page is page 6').toContainText('6');
      await expect(extras.productIdCells, '[Expected 3] Page 6 shows B051, B052, B053').toHaveText(range(51, 53));
    });

    await step('Act: Step 4 — Set 페이지당 (Rows per page) to 20', async () => {
      await list.setPageSize('20');
      await note('Step 4');
    });

    await step('Assert: Expected 4 — The list redraws at once with 20 rows per page and 3 pages', async () => {
      await expect.soft(extras.productIdCells, '[Expected 4] 20 rows per page').toHaveCount(20);
      await expect(extras.pageNumbers, '[Expected 4] 3 pages').toHaveCount(3);
    });

    await step('Act: Step 5 — Set Rows per page to 50, then click page 2', async () => {
      await list.setPageSize('50');
      await note('Step 5 (50 rows)');
      await list.goToPage(/^2$/);
      await note('Step 5 (page 2)');
    });

    await step('Assert: Expected 5 — 50 rows per page and 2 pages; page 2 shows B051, B052, B053', async () => {
      await expect.soft(extras.pageNumbers, '[Expected 5] 2 pages at 50 rows per page').toHaveCount(2);
      await expect.soft(list.pageSizeSelect.locator('option:checked'), '[Expected 5] 50 rows per page').toHaveText('50개');
      await expect(extras.productIdCells, '[Expected 5] Page 2 shows B051, B052, B053').toHaveText(range(51, 53));
    });

    await step('Act: Step 6 — Set Rows per page to 100', async () => {
      await list.setPageSize('100');
      await note('Step 6');
    });

    await step('Assert: Expected 6 — All 53 rows on 1 page; the pager total and Products sold in period stay 53 throughout', async () => {
      await expect.soft(extras.productIdCells, '[Expected 6] All 53 rows are on one page').toHaveText(range(1, 53));
      await expect.soft(extras.pageNumbers, '[Expected 6] One page').toHaveCount(1);
      for (const t of totals) {
        expect.soft(t.pager, `[Expected 6] The pager total reads 53 (${t.at})`).toBe(53);
        expect.soft(t.chip, `[Expected 6] 기간 내 판매 상품 reads 53 (${t.at})`).toBe(53);
      }
      expect(totals.length, '[Expected 6] The totals were read after every step').toBe(7);
    });

    await step('Act: Step 7 — Call GET products of CY_MAIN with size = 101', async () => {
      const api = await playwright.request.newContext({ baseURL: env.apiBaseURL });
      const response = await api.get(`/api/v1/fee-review/cycles/${seeded.cycles.CY_MAIN.id}/products?page=0&size=101`, { headers: { Authorization: `Bearer ${await getValidAccessToken(undefined, 'submitter')}`, Accept: 'application/json' } });
      oversize = { status: response.status(), body: await response.text() };
      await test.info().attach('GET products size=101', { body: JSON.stringify(oversize, null, 2), contentType: 'application/json' });
      await api.dispose();
    });

    await step('Assert: Expected 7 — HTTP 400 CMN-4000', async () => {
      expect.soft(oversize.status, '[Expected 7] HTTP 400').toBe(400);
      expect(oversize.body, '[Expected 7] Error code CMN-4000').toContain('CMN-4000');
    });
  });

  test('TC_US079_36 — Bucket counts always count the whole cycle whatever the filter', async ({ page, feeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const extras = new FeeReviewListAPage(page, list);
    await tcMeta('TC_US079_36', 'Medium', TAGS, `On CY_MAIN (P01, P14 Matches; P03 Mismatch; P04 Ambiguous; P06 No row) the ten chips read 5 / 3 / 0 / 0 / 0 / 2 / 1 / 1 / 3 / 0 and keep those numbers while 확인 필요, a keyword (P03) and 중복 적용 narrow the list; the API returns the same counts for a filtered query. ${OPEN_DEV} ${CYCLE_DEV} ${YEAR_DEV} ${CLEAN}`);
    const spec: SeedSpec = {
      tc: 36,
      private: true,
      contracts: family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9', 'R_C20'], ANNEX2: ['R_C22'] }),
      cycles: ['CY_MAIN'],
      products: (['P01', 'P03', 'P04', 'P06', 'P14'] as const).map((code) => product(code, [{ cycle: 'CY_MAIN', saleLines: 1 }])),
    };
    const EXPECTED: Record<ChipKey, number> = { 'bucket.ALL': 5, 'bucket.EXC': 3, 'bucket.NC': 0, 'bucket.PROV': 0, 'bucket.FIXED': 0, 'bucket.OK': 2, 'bucket.NF': 1, 'bucket.AMB': 1, 'bucket.DIFF': 3, 'bucket.SRCDIFF': 0 };
    let seeded!: Awaited<ReturnType<typeof seedData>>;
    let step1 = {} as Record<ChipKey, number>;
    let apiPage!: FeeReviewPage;
    const countsStay = async (tag: string) => {
      for (const key of ALL_CHIPS) await expect.soft(extras.chipReading(key, step1[key]), `${tag} ${FR_KO[key]} stays ${step1[key]}`).toBeVisible();
    };

    await step('Arrange: Pre-condition 1–13 — CY_MAIN: P01, P14 Matches; P03 Mismatch; P04 Ambiguous; P06 No row', async () => {
      seeded = await seedData(spec);
    });

    await step(`Act: Step 1 — Open the screen on CY_MAIN (${seeded.cycles.CY_MAIN.label}), then click chip 기간 내 판매 상품 (Products sold in period)`, async () => {
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id });
      await list.clickChip(list.chip('bucket.ALL'));
      step1 = await extras.chipCounts();
    });

    await step('Assert: Expected 1 — The ten chips read 5 / 3 / 0 / 0 / 0 / 2 / 1 / 1 / 3 / 0', async () => {
      for (const key of ALL_CHIPS) await expect.soft(extras.chipReading(key, EXPECTED[key]), `[Expected 1] ${FR_KO[key]} (${FR_EN[key]}) reads ${EXPECTED[key]}`).toBeVisible();
      expect(step1, '[Expected 1] Every chip reads the TC count').toEqual(EXPECTED);
    });

    await step('Act: Step 2 — Click chip 확인 필요 (Needs review)', async () => {
      await list.clickChip(list.chip('bucket.EXC'));
    });

    await step('Assert: Expected 2 — The list shows P03, P04, P06; every count stays as in step 1', async () => {
      await assertListed(extras, [seeded.products.P03, seeded.products.P04, seeded.products.P06], '[Expected 2]');
      await countsStay('[Expected 2]');
    });

    await step('Act: Step 3 — Type the P03 id in 검색어 (Keyword) and click Search', async () => {
      await list.search(seeded.products.P03);
    });

    await step('Assert: Expected 3 — The list shows 1 row P03; every count stays as in step 1', async () => {
      await assertListed(extras, [seeded.products.P03], '[Expected 3]');
      await countsStay('[Expected 3]');
    });

    await step('Act: Step 4 — Click chip 중복 적용 (Ambiguous)', async () => {
      await list.clickChip(list.chip('bucket.AMB'));
    });

    await step('Assert: Expected 4 — The list shows no row (P03 is not ambiguous); every count stays as in step 1', async () => {
      await expect.soft(extras.productIdCells, '[Expected 4] No row is listed').toHaveCount(0);
      await countsStay('[Expected 4]');
    });

    await step('Act: Step 5 — Call GET products of CY_MAIN with bucket = NEEDS_REVIEW and keyword = P03', async () => {
      apiPage = await feeReviewApi.products(seeded.cycles.CY_MAIN.id, { bucket: 'NEEDS_REVIEW', keyword: seeded.products.P03 });
    });

    await step('Assert: Expected 5 — totalElements = 1; buckets and problems carry the step 1 counts', async () => {
      expect.soft(apiPage.totalElements, '[Expected 5] totalElements = 1').toBe(1);
      for (const key of ALL_CHIPS) expect.soft(CHIP_COUNT[key](apiPage), `[Expected 5] The API count of ${FR_KO[key]} equals step 1 (${step1[key]})`).toBe(step1[key]);
      expect(apiPage.buckets.total, '[Expected 5] buckets.total equals step 1').toBe(step1['bucket.ALL']);
    });
  });

  test('TC_US079_37 — The header checkbox selects only the rows of the current page', async ({ page, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const extras = new FeeReviewListAPage(page, list);
    await tcMeta('TC_US079_37', 'Low', TAGS, `With 13 products B001…B013 at 10 rows per page, ticking the header checkbox ticks the 10 rows of page 1 only; the 3 rows of page 2 stay unticked; unticking it on page 1 clears all 10. ${OPEN_DEV} ${CYCLE_DEV} ${YEAR_DEV} ${CLEAN}`);
    const spec: SeedSpec = { tc: 37, private: true, contracts: FAMILY_A, cycles: ['CY_MAIN'], products: bulk(13) };
    let seeded!: Awaited<ReturnType<typeof seedData>>;
    let b = (n: number) => String(n);
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => b(from + i));

    await step('Arrange: Pre-condition 1–13 — CY_MAIN holds 13 products B001…B013 (Resolved 12.50% Matches); 페이지당 = 10', async () => {
      seeded = await seedData(spec);
      b = (n: number) => `${seeded.prefix}B${String(n).padStart(3, '0')}`;
    });

    await step(`Act: Step 1 — Open the screen on CY_MAIN (${seeded.cycles.CY_MAIN.label}), then click chip 기간 내 판매 상품 (Products sold in period)`, async () => {
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id, pageSize: '10' });
      await list.clickChip(list.chip('bucket.ALL'));
    });

    await step('Assert: Expected 1 — Page 1 shows 10 rows (B001…B010), page 2 holds 3 rows', async () => {
      await expect.soft(extras.productIdCells, '[Expected 1] Page 1 shows B001…B010').toHaveText(range(1, 10));
      expect.soft(await extras.pagerTotal(), '[Expected 1] 13 products in total — page 2 holds 3 rows').toBe(13);
      await expect(extras.pageNumbers, '[Expected 1] There are 2 pages').toHaveCount(2);
    });

    await step('Act: Step 2 — Tick the header checkbox of the selection column', async () => {
      await list.headerCheckbox.check();
    });

    await step('Assert: Expected 2 — All 10 rows of page 1 are ticked', async () => {
      for (const id of range(1, 10)) await expect.soft(list.rowCheckbox(list.row(id)), `[Expected 2] ${id} is ticked`).toBeChecked();
      await expect(extras.rowCheckboxes, '[Expected 2] 10 row checkboxes on page 1').toHaveCount(10);
    });

    await step('Act: Step 3 — Go to page 2', async () => {
      await list.goToPage(/^2$/);
    });

    await step('Assert: Expected 3 — The 3 rows of page 2 (B011, B012, B013) are not ticked', async () => {
      await expect.soft(extras.productIdCells, '[Expected 3] Page 2 shows B011, B012, B013').toHaveText(range(11, 13));
      for (const id of range(11, 13)) await expect.soft(list.rowCheckbox(list.row(id)), `[Expected 3] ${id} is not ticked`).not.toBeChecked();
      await expect(extras.rowCheckboxes, '[Expected 3] 3 row checkboxes on page 2').toHaveCount(3);
    });

    await step('Act: Step 4 — Go back to page 1 and untick the header checkbox', async () => {
      await list.goToPage(/^1$/);
      await list.headerCheckbox.uncheck();
    });

    await step('Assert: Expected 4 — All 10 rows of page 1 are unticked', async () => {
      for (const id of range(1, 10)) await expect.soft(list.rowCheckbox(list.row(id)), `[Expected 4] ${id} is unticked`).not.toBeChecked();
      await expect(extras.rowCheckboxes, '[Expected 4] 10 row checkboxes on page 1').toHaveCount(10);
    });
  });
});
