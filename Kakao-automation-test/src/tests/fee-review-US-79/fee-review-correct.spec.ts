import type { RowDataPacket } from 'mysql2/promise';
import type { Locator, Response } from '@playwright/test';
import { test, expect } from '@fixtures/fee-review-v1.fixture';
import type { CorrectionOptions, FeeReviewApi, SaveCorrectionBody } from '@api/fee-review.api';
import type { FeeRateApi, FeeRow } from '@api/fee-rate.api';
import { FeeReviewListPage } from '@pages/fee-review.page';
import { CorrectV1Page } from '@pages/fee-review-v1/correct.page';
import { feeReviewDb } from '@utils/fee-review-db';
import { family, product, reasonOf } from '@utils/fee-review-v1.data';
import { FR_EN, FR_KO, FR_TC, frFormat } from '@utils/fee-review.i18n';
import { getAccountDisplayName } from '@utils/auth-token';
import { Observations } from '@utils/observations';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';

/**
 * US079 v1 — nhóm [Correct] (`input/TESTCASE_US079_v1.md`, TC_US079_84 … 115): dialog 수수료 산정 수정 — Tier 1 đổi
 * category, Tier 2 nhập tay, 3 đường lưu (áp dụng ngay / cần duyệt / nhập tay), validate lý do + rate, khoá theo trạng thái,
 * bỏ correction, đua 2 phiên. Dữ liệu dựng theo pre-condition qua `seedData` (sản phẩm riêng từng TC, dọn bằng SQL ở teardown);
 * DB chỉ đọc (SELECT) cho các Expected trích bảng `fee_correction` / `fee_correction_history` / `change_approval`.
 */
const TAGS = ['correct', 'fee-review'];
const DEV_CYCLE = 'Deviation: CY_MAIN / CY_CLOSE is the next free month ≥ 2100 instead of <Y>-03 / <Y>-06 (Y = 2100 + 200 × RUN + N would run out after ~38 runs).';
const DEV_SHARED = 'Data: CY_MAIN and the contract family are shared by the TCs of this run with the same family; the products are private to this TC.';
const DEV_PRIVATE = 'Data: this TC gets its own contract family and cycle (it changes contract rows / closes a cycle).';
const CLEAN = 'Cleanup: every row of the TC prefix (history, Fee Rule approvals, corrections, fixture targets and products) is deleted by SQL in teardown; contracts and cycles stay (no delete API).';
const NO_RULE_CODE = /\b(BR|STL|CNT|OQ|QA|SPEC-GAP|DEV)-\d+/;
const PERCENT_FIGURE = /\d+\.\d{2}%/g;

const esc = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const main = (saleLines: number) => [{ cycle: 'CY_MAIN', saleLines }];
/** Họ contract đầy đủ của TC (ROOT R_A/R_B10/R_PROMO/R_E11 · ANNEX1 R_B9/R_C20 · ANNEX2 R_C22). */
const fullFamily = () => family({ ROOT: ['R_A', 'R_B10', 'R_PROMO', 'R_E11'], ANNEX1: ['R_B9', 'R_C20'], ANNEX2: ['R_C22'] });
/** Nhãn option Tier 1 theo app: "{tên} (12.50%)" hoặc "{tên} (⚠ 동순위)" (recon 07). */
const option = (name: string, rate?: string): string => (rate ? `${name} (${rate}%)` : `${name}${FR_KO['fix.tied']}`);
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const asText = (body: unknown): string => (typeof body === 'string' ? body : JSON.stringify(body ?? ''));
const either = (ko: string, en: string): RegExp => new RegExp(`${esc(ko)}|${esc(en)}`);

async function db(sql: string, params: unknown[]): Promise<RowDataPacket[]> {
  return feeReviewDb.query<RowDataPacket[]>(sql, params);
}

/** Mở list ở cycle (bucket 전체), gõ 검색어 = mã sản phẩm, bấm 검색 — trả về dòng NORMAL của sản phẩm. */
async function showRow(list: FeeReviewListPage, cycleId: number, productId: string): Promise<Locator> {
  await list.open({ cycleId, bucket: 'ALL' });
  await list.search(productId);
  return list.row(productId);
}

/** Pre-condition "Save draft" qua API (TOKEN_A) — trả về correctionId. */
async function saveDraft(api: FeeReviewApi, cycleId: number, productId: string, body: SaveCorrectionBody): Promise<string> {
  const saved = await api.save(cycleId, productId, body);
  expect(saved.status, `Pre-condition — POST corrections for ${productId} returns 201`).toBe(201);
  expect(saved.body?.correctionId, `Pre-condition — ${productId} correction id is returned`).toBeTruthy();
  return String(saved.body.correctionId);
}

/** Pre-condition "Submit" qua API — trả về id 변경 승인 (Fee Rule) đọc từ `fee_correction.change_approval_id`. */
async function submitDraft(api: FeeReviewApi, correctionId: string): Promise<number> {
  const submitted = await api.submit([correctionId]);
  expect(submitted.status, `Pre-condition — submit correction ${correctionId} returns 200`).toBe(200);
  const [row] = await db('SELECT change_approval_id FROM fee_correction WHERE id = ?', [correctionId]);
  expect(row?.change_approval_id, `Pre-condition — correction ${correctionId} carries its Fee Rule approval record`).toBeTruthy();
  return Number(row.change_approval_id);
}

/** Đổi trạng thái fee row (TOKEN_A); contract đang chạy → thay đổi chờ duyệt → TOKEN_B duyệt để có hiệu lực. */
async function setRowStatus(maker: FeeRateApi, approver: FeeRateApi, contractId: number, rowId: number, status: 'ACTIVE' | 'INACTIVE', reason: string): Promise<number[]> {
  const set = await maker.setStatus(contractId, rowId, status, reason);
  const statuses = [set.status];
  if (set.status < 300 && set.body?.gated && set.body.changeApprovalId) statuses.push((await approver.approve(set.body.changeApprovalId)).status);
  return statuses;
}

async function optionsWithStatus(api: FeeReviewApi, cycleId: number, productId: string): Promise<{ status: number; body: CorrectionOptions & Record<string, unknown> }> {
  const body = (await api.options(cycleId, productId)) as CorrectionOptions & Record<string, unknown>;
  return { status: api.exchanges.at(-1)?.status ?? 0, body };
}

/** Lệnh ghi bị từ chối: HTTP status + mã lỗi + câu thông báo (KO hoặc EN) trong body. */
function expectRefused(result: { status: number; body: unknown }, status: number, code: string, ko: string, en: string, tag: string): void {
  expect(result.status, `${tag} HTTP ${status}`).toBe(status);
  expect(asText(result.body), `${tag} Error code ${code}`).toContain(code);
  expect(asText(result.body), `${tag} Message "${ko}"`).toMatch(either(ko, en));
}

test.describe('[Correct] Correct fee resolution (US079 v1)', () => {
  test.describe.configure({ timeout: 240_000 });

  test('TC_US079_84 — A tier-1 correction that keeps the rate applies at once without an approval record', async ({ page, feeReviewPage: list, feeReviewApi, seedData }) => {
    const step = makeStep(page);
    const ext = new CorrectV1Page(page, list);
    const reason = reasonOf('TC_US079_84', '카테고리 오매핑 정정');
    await tcMeta('TC_US079_84', 'Critical', TAGS, `P05 (category A, resolved by R_A 12.50%) is corrected to category D, which the family also prices at 12.50%: the delta preview reads 요율 그대로 — 승인 불필요, Save shows the applied toast, the row shows D 12.50% with pill 적용됨 (요율 변동 없음) in bucket 이번 기 수정됨, fee_correction holds one APPLIED row with no approval record, the history holds one APPLIED entry by user A and the period report lists it. The reason carries a traceable [AUTO-US079] prefix before the TC text. ${DEV_CYCLE} ${DEV_SHARED} ${CLEAN}`);
    let s!: Awaited<ReturnType<typeof seedData>>;
    let pid = '';
    let cycleId = 0;
    let row!: Locator;
    let saved!: Response;
    let correction: RowDataPacket[] = [];
    let approvals: RowDataPacket[] = [];
    let history: RowDataPacket[] = [];

    await step('Arrange: Pre-condition 1–11 — Contract ROOT (R_A A 12.50 · R_D D 12.50), cycle CY_MAIN, product P05 (category A, no slot) resolved at 12.50%', async () => {
      s = await seedData({ tc: 84, contracts: family({ ROOT: ['R_A', 'R_D'] }), cycles: ['CY_MAIN'], products: [product('P05', main(151))] });
      pid = s.products.P05;
      cycleId = s.cycles.CY_MAIN.id;
      const r = await feeReviewApi.row(cycleId, pid);
      expect(r.status, 'Pre-condition 9 — P05 is RESOLVED').toBe('RESOLVED');
      expect(r.correction ?? null, 'Pre-condition 9 — P05 has no correction').toBeNull();
    });

    await step('Act: Step 1 — Open Settlement fee review on CY_MAIN and search the P05 product id', async () => {
      row = await showRow(list, cycleId, pid);
    });

    await step('Assert: Expected 1 — 산정 완료, category A, 12.50%, 지정 없음, no correction pill', async () => {
      await expect(list.cell(row, 'status'), '[Expected 1] 산정 상태 (Resolution status) 산정 완료 (Resolved)').toContainText(FR_KO['status.RESOLVED']);
      await expect(list.cell(row, 'category'), '[Expected 1] Resolved fee category A').toHaveText(s.master.categoryName.A);
      await expect(list.cell(row, 'rate'), '[Expected 1] Resolved rate 12.50%').toHaveText('12.50%');
      await expect(list.cell(row, 'compare'), '[Expected 1] 지정 대조 (Assigned vs resolved) 지정 없음 (Not assigned)').toHaveText(FR_KO['compare.NOT_ASSIGNED']);
      await expect(list.statusPills(row), '[Expected 1] No correction pill').toHaveCount(1);
    });

    await step('Act: Step 2 — Click 수정 (Correct) on the P05 / NORMAL row', async () => {
      await list.openCorrect(row);
    });

    await step('Assert: Expected 2 — The dialog shows A · 12.50% · Resolved as plain text and offers D annotated with 12.50%', async () => {
      await expect(list.correct.title, '[Expected 2] Dialog 수수료 산정 수정 (Correct fee resolution) opens').toHaveText(FR_KO['fix.title']);
      await expect(list.correct.contractValue('fix.kvCategory'), '[Expected 2] Resolved from the contract — category A').toHaveText(s.master.categoryName.A);
      await expect(list.correct.contractValue('fix.kvRate'), '[Expected 2] Resolved from the contract — 12.50%').toHaveText('12.50%');
      await expect(list.correct.contractValue('fix.kvStatus'), '[Expected 2] Resolved from the contract — 산정 완료 (Resolved)').toHaveText(FR_KO['status.RESOLVED']);
      await expect(list.correct.fromContract.locator('a, button, input, select, .badge'), '[Expected 2] The contract values are plain text (no control or badge)').toHaveCount(0);
      expect(await list.correct.optionTexts(), '[Expected 2] Tier 1 offers D annotated with 12.50%').toContain(option(s.master.categoryName.D, '12.50'));
    });

    await step('Act: Step 3 — Select category D in 1단계 — 수수료 카테고리 변경 (Tier 1)', async () => {
      await list.correct.pickCategory(s.master.categoryName.D);
    });

    await step('Assert: Expected 3 — The delta preview reads 요율 그대로 — 승인 불필요 and the rate stays 12.50%', async () => {
      await expect(list.correct.deltaHead, '[Expected 3] Heading 요율 그대로 — 승인 불필요 (Rate unchanged — no approval)').toHaveText(FR_KO['fix.deltaZeroHead']);
      await expect(list.correct.deltaPanel, '[Expected 3] States the rate stays 12.50% and the correction is listed under Changes this period').toContainText(frFormat(FR_KO['fix.deltaZeroBody'], { rate: '12.50%' }));
    });

    await step('Act: Step 4 — Type 수정 사유 (필수) (Reason) and click 저장 (Save)', async () => {
      await list.correct.reasonInput.fill(reason);
      saved = await list.correct.save();
    });

    await step('Assert: Expected 4 — The applied toast shows and the dialog closes', async () => {
      expect(saved.status(), '[Expected 4] The save request succeeds (201)').toBe(201);
      await expect(list.toast(FR_KO['fix.savedApplied']), '[Expected 4] Toast 수정이 적용되었습니다. 요율이 변하지 않아 승인이 필요하지 않습니다.').toBeVisible();
      await expect(list.correct.root, '[Expected 4] The dialog closes').toHaveCount(0);
    });

    await step('Act: Step 5 — Look at the P05 / NORMAL row on the list', async () => {
      await list.search(pid);
    });

    await step('Assert: Expected 5 — D 12.50% as the only rate line, pill 적용됨 (요율 변동 없음), counted under 이번 기 수정됨', async () => {
      expect(await ext.mainText(list.cell(row, 'category')), '[Expected 5] Resolved fee category D').toBe(s.master.categoryName.D);
      expect(await ext.mainText(list.cell(row, 'rate')), '[Expected 5] Resolved rate 12.50%').toBe('12.50%');
      await expect(list.secondLine(list.cell(row, 'rate')), '[Expected 5] No proposed rate beside it').toHaveCount(0);
      await expect(list.secondLine(list.cell(row, 'category')), '[Expected 5] No proposed category beside it').toHaveCount(0);
      await expect(list.statusPills(row).nth(1), '[Expected 5] Second pill 적용됨 (요율 변동 없음) (Applied (no rate change))').toHaveText(FR_KO['state.APPLIED']);
      expect((await feeReviewApi.row(cycleId, pid)).bucket, '[Expected 5] Counted under bucket 이번 기 수정됨 (Corrected this period)').toBe('CORRECTED_THIS_PERIOD');
    });

    await step('Act: Step 6 — Read fee_correction of P05', async () => {
      correction = await db('SELECT id, state, tier, category_id, rate_before, rate_after, change_approval_id, submitted_by FROM fee_correction WHERE product_id = ?', [pid]);
    });

    await step('Assert: Expected 6 — Exactly one APPLIED ASSIGNMENT row D 12.5 → 12.5 with no approval and no submitter', async () => {
      expect(correction.length, '[Expected 6] Exactly one fee_correction row').toBe(1);
      const c = correction[0] ?? {};
      expect(c.state, '[Expected 6] state = APPLIED').toBe('APPLIED');
      expect(c.tier, '[Expected 6] tier = ASSIGNMENT').toBe('ASSIGNMENT');
      expect(num(c.category_id), '[Expected 6] category_id = CAT_D').toBe(s.master.category.D);
      expect(num(c.rate_before), '[Expected 6] rate_before = 12.5000').toBe(12.5);
      expect(num(c.rate_after), '[Expected 6] rate_after = 12.5000').toBe(12.5);
      expect(c.change_approval_id ?? null, '[Expected 6] change_approval_id = NULL').toBeNull();
      expect(c.submitted_by ?? null, '[Expected 6] submitted_by = NULL').toBeNull();
    });

    await step('Act: Step 7 — Read change_approval and fee_correction_history for the correction', async () => {
      approvals = await db("SELECT id FROM change_approval WHERE target_type = 'FEE_RULE' AND target_ref LIKE ?", [`%/${pid}/NORMAL`]);
      history = await db('SELECT outcome, who FROM fee_correction_history WHERE correction_id = ?', [correction[0]?.id ?? null]);
    });

    await step('Assert: Expected 7 — No approval record; one history row APPLIED by user A', async () => {
      expect(approvals.length, '[Expected 7] change_approval returns 0 rows').toBe(0);
      expect(history.length, '[Expected 7] fee_correction_history returns 1 row').toBe(1);
      expect(history[0]?.outcome, '[Expected 7] outcome = APPLIED').toBe('APPLIED');
      expect(String(history[0]?.who ?? ''), '[Expected 7] who = user A').toContain(getAccountDisplayName('submitter'));
    });

    await step('Act: Step 8 — Click 이번 기 수정 내역 (Changes this period) and find P05', async () => {
      await list.openReport();
      await list.report.showLatest();
    });

    await step('Assert: Expected 8 — The report lists the correction: Applied (no rate change), A → D, 12.50% before and after, user A, the reason', async () => {
      const r = ext.reportRow(pid);
      await expect(r, '[Expected 8] P05 is listed once').toHaveCount(1);
      await expect(list.report.cell(r, 'approval'), '[Expected 8] 승인 (Approval) = 적용됨 (요율 변동 없음)').toHaveText(FR_KO['state.APPLIED']);
      await expect(list.report.cell(r, 'change'), '[Expected 8] Change A → D').toHaveText(new RegExp(`${esc(s.master.categoryName.A)}\\s*→\\s*${esc(s.master.categoryName.D)}`));
      await expect(list.report.cell(r, 'rate'), '[Expected 8] Rate 12.50% before and after').toHaveText(/12\.50%[\s\S]*12\.50%/);
      await expect(list.report.cell(r, 'who'), '[Expected 8] Who = user A').toHaveText(getAccountDisplayName('submitter'));
      await expect(list.report.cell(r, 'reason'), '[Expected 8] Reason').toHaveText(reason);
    });
  });

  test('TC_US079_85 — A tier-1 correction that moves the rate is saved as Corrected — not submitted', async ({ page, feeReviewPage: list, feeReviewApi, seedData }) => {
    const step = makeStep(page);
    const ext = new CorrectV1Page(page, list);
    const reason = reasonOf('TC_US079_85', 'Wrong category mapped in commerce');
    await tcMeta('TC_US079_85', 'Critical', TAGS, `P14 (A 12.50%, assigned R_A) is corrected to B, which resolves to the annex row R_B9 9.00%: the preview reads 요율이 바뀝니다 — 승인 필요 (12.50% → 9.00%), the save returns 201 DRAFT / NEEDS_APPROVAL with the draft toast, the row keeps A 12.50% in force with B 9.00% proposed and pill 수정됨 — 미상신 in bucket 이번 기 수정됨, fee_correction is DRAFT with no approval record or history, and the row can still be submitted. Not automated: that the proposed 9.00% is drawn "dimmed" (styling only — the proposed line beside the figure is asserted). ${DEV_CYCLE} ${DEV_SHARED} ${CLEAN}`);
    let s!: Awaited<ReturnType<typeof seedData>>;
    let pid = '';
    let cycleId = 0;
    let row!: Locator;
    let saved!: Response;
    let correction: RowDataPacket[] = [];
    let counts = { approvals: -1, history: -1 };

    await step('Arrange: Pre-condition 1–12 — ROOT (R_A 12.50 · R_B10 10.00) + ANNEX1 (R_B9 9.00), cycle CY_MAIN, product P14 (A, assigned R_A)', async () => {
      s = await seedData({ tc: 85, contracts: family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P14', main(234))] });
      pid = s.products.P14;
      cycleId = s.cycles.CY_MAIN.id;
      const r = await feeReviewApi.row(cycleId, pid);
      expect(r.status, 'Pre-condition 10 — P14 is RESOLVED').toBe('RESOLVED');
      expect(r.correction ?? null, 'Pre-condition 10 — P14 has no correction').toBeNull();
    });

    await step('Act: Step 1 — Open Settlement fee review on CY_MAIN and search the P14 product id', async () => {
      row = await showRow(list, cycleId, pid);
    });

    await step('Assert: Expected 1 — 산정 완료, A, 12.50%, 일치, no correction pill', async () => {
      await expect(list.cell(row, 'status'), '[Expected 1] 산정 완료 (Resolved)').toContainText(FR_KO['status.RESOLVED']);
      await expect(list.cell(row, 'category'), '[Expected 1] Category A').toHaveText(s.master.categoryName.A);
      await expect(list.cell(row, 'rate'), '[Expected 1] 12.50%').toHaveText('12.50%');
      await expect(list.cell(row, 'compare'), '[Expected 1] 일치 (Matches)').toHaveText(FR_KO['compare.MATCHES']);
      await expect(list.statusPills(row), '[Expected 1] No correction pill').toHaveCount(1);
    });

    await step('Act: Step 2 — Click 수정 (Correct) on the P14 / NORMAL row', async () => {
      await list.openCorrect(row);
    });

    await step('Assert: Expected 2 — The dialog opens; Tier 1 offers B annotated with 9.00%', async () => {
      await expect(list.correct.title, '[Expected 2] Dialog 수수료 산정 수정 opens').toHaveText(FR_KO['fix.title']);
      expect(await list.correct.optionTexts(), '[Expected 2] Tier 1 offers B — 9.00%').toContain(option(s.master.categoryName.B, '9.00'));
    });

    await step('Act: Step 3 — Select category B in Tier 1', async () => {
      await list.correct.pickCategory(s.master.categoryName.B);
    });

    await step('Assert: Expected 3 — 요율이 바뀝니다 — 승인 필요, the rate changes from 12.50% to 9.00% and needs approval', async () => {
      await expect(list.correct.deltaHead, '[Expected 3] Heading 요율이 바뀝니다 — 승인 필요').toHaveText(FR_KO['fix.deltaChgHead']);
      await expect(list.correct.deltaPanel, '[Expected 3] The rate changes from 12.50% to 9.00%').toContainText(/12\.50%[\s\S]*9\.00%/);
      await expect(list.correct.deltaPanel, '[Expected 3] Needs approval before it counts').toContainText(FR_KO['fix.deltaChgTail'].trim());
    });

    await step('Act: Step 4 — Type the reason and click 저장 (Save), capturing the save request', async () => {
      await list.correct.reasonInput.fill(reason);
      saved = await list.correct.save();
    });

    await step('Assert: Expected 4 — 201 DRAFT / NEEDS_APPROVAL; the draft toast shows and the dialog closes', async () => {
      const body = (await saved.json().catch(() => ({}))) as Record<string, unknown>;
      expect(saved.status(), '[Expected 4] Save request returns 201').toBe(201);
      expect(body.state, '[Expected 4] state = DRAFT').toBe('DRAFT');
      expect(body.routeTaken, '[Expected 4] routeTaken = NEEDS_APPROVAL').toBe('NEEDS_APPROVAL');
      await expect(list.toast(FR_KO['fix.savedDraft']), '[Expected 4] Toast 승인 요청으로 상신되었습니다. 요율이 변경됩니다.').toBeVisible();
      await expect(list.correct.root, '[Expected 4] The dialog closes').toHaveCount(0);
    });

    await step('Act: Step 5 — Look at the P14 / NORMAL row on the list', async () => {
      await list.search(pid);
    });

    await step('Assert: Expected 5 — 12.50% in force with 9.00% proposed, A in force with B proposed, 수정됨 — 미상신, bucket 이번 기 수정됨', async () => {
      expect(await ext.mainText(list.cell(row, 'rate')), '[Expected 5] In-force rate 12.50% stays the figure').toBe('12.50%');
      await expect(list.secondLine(list.cell(row, 'rate')), '[Expected 5] Proposed 9.00% beside it with an arrow').toHaveText(/→\s*9\.00%/);
      expect(await ext.mainText(list.cell(row, 'category')), '[Expected 5] Category A stays in force').toBe(s.master.categoryName.A);
      await expect(list.secondLine(list.cell(row, 'category')), '[Expected 5] Proposed B beside it').toContainText(s.master.categoryName.B);
      await expect(list.statusPills(row).nth(1), '[Expected 5] Second pill 수정됨 — 미상신 (Corrected — not submitted)').toHaveText(FR_KO['state.DRAFT']);
      expect((await feeReviewApi.row(cycleId, pid)).bucket, '[Expected 5] Counted under bucket 이번 기 수정됨').toBe('CORRECTED_THIS_PERIOD');
    });

    await step('Act: Step 6 — Read fee_correction of P14', async () => {
      correction = await db('SELECT state, category_id, category_before_id, rate_before, rate_after, submission_no, pending_key, change_approval_id FROM fee_correction WHERE product_id = ?', [pid]);
    });

    await step('Assert: Expected 6 — DRAFT · CAT_B · before CAT_A · 12.5 → 9.0 · submission_no 1 · no pending key · no approval', async () => {
      const c = correction[0] ?? {};
      expect(c.state, '[Expected 6] state = DRAFT').toBe('DRAFT');
      expect(num(c.category_id), '[Expected 6] category_id = CAT_B').toBe(s.master.category.B);
      expect(num(c.category_before_id), '[Expected 6] category_before_id = CAT_A').toBe(s.master.category.A);
      expect(num(c.rate_before), '[Expected 6] rate_before = 12.5000').toBe(12.5);
      expect(num(c.rate_after), '[Expected 6] rate_after = 9.0000').toBe(9);
      expect(num(c.submission_no), '[Expected 6] submission_no = 1').toBe(1);
      expect(c.pending_key ?? null, '[Expected 6] pending_key = NULL').toBeNull();
      expect(c.change_approval_id ?? null, '[Expected 6] change_approval_id = NULL').toBeNull();
    });

    await step('Act: Step 7 — Count change_approval and fee_correction_history rows of P14', async () => {
      const [a] = await db("SELECT COUNT(*) AS n FROM change_approval WHERE target_type = 'FEE_RULE' AND target_ref LIKE ?", [`%/${pid}/NORMAL`]);
      const [h] = await db('SELECT COUNT(*) AS n FROM fee_correction_history WHERE product_id = ?', [pid]);
      counts = { approvals: Number(a.n), history: Number(h.n) };
    });

    await step('Assert: Expected 7 — Both counts are 0', async () => {
      expect(counts.approvals, '[Expected 7] change_approval count = 0').toBe(0);
      expect(counts.history, '[Expected 7] fee_correction_history count = 0').toBe(0);
    });

    await step('Act: Step 8 — Tick the selection box of the P14 / NORMAL row', async () => {
      await list.rowCheckbox(row).check();
    });

    await step('Assert: Expected 8 — The row is selected and 선택 일괄 상신 (Submit selected) is enabled', async () => {
      await expect(list.rowCheckbox(row), '[Expected 8] The row can be selected').toBeChecked();
      await expect(list.submitButton, '[Expected 8] 선택 일괄 상신 (Submit selected) is enabled').toBeEnabled();
    });
  });

  test('TC_US079_86 — A hand-keyed rate on a product with no contract row is saved for approval', async ({ page, feeReviewPage: list, feeReviewApi, seedData }) => {
    const step = makeStep(page);
    const ext = new CorrectV1Page(page, list);
    const reason = reasonOf('TC_US079_86', 'Side letter rate agreed with the partner');
    await tcMeta('TC_US079_86', 'Critical', TAGS, `P10 (sale type ST2, the family prices no ST2 row → 적용 행 없음): the dialog shows an empty Tier 1 list, the Tier 2 input (placeholder 예: 4.50%) and the basis label; typing 6.75 reads 직접 입력 — 승인 필요; Save shows the hand-keyed toast; the row keeps no in-force rate with 6.75% proposed, badge 직접 입력 and pill 수정됨 — 미상신; fee_correction is a DRAFT RATE_OVERRIDE 6.75. ${DEV_CYCLE} ${DEV_SHARED} ${CLEAN}`);
    let s!: Awaited<ReturnType<typeof seedData>>;
    let pid = '';
    let cycleId = 0;
    let row!: Locator;
    let saved!: Response;
    let correction: RowDataPacket[] = [];

    await step('Arrange: Pre-condition 1–11 — ROOT (R_A A × ST1 12.50), cycle CY_MAIN, product P10 (A × ST2) with no row applying', async () => {
      s = await seedData({ tc: 86, contracts: family({ ROOT: ['R_A'] }), cycles: ['CY_MAIN'], products: [product('P10', main(86))] });
      pid = s.products.P10;
      cycleId = s.cycles.CY_MAIN.id;
      expect((await feeReviewApi.row(cycleId, pid)).status, 'Pre-condition 9 — P10 is NO_ROW').toBe('NO_ROW');
    });

    await step('Act: Step 1 — Open Settlement fee review on CY_MAIN and search the P10 product id', async () => {
      row = await showRow(list, cycleId, pid);
    });

    await step('Assert: Expected 1 — 적용 행 없음, empty rate, 지정 없음', async () => {
      await expect(list.cell(row, 'status'), '[Expected 1] 산정 상태 적용 행 없음 (No row applies)').toContainText(FR_KO['status.NO_ROW']);
      await expect(list.cell(row, 'rate'), '[Expected 1] Empty rate').not.toContainText('%');
      await expect(list.cell(row, 'compare'), '[Expected 1] 지정 없음 (Not assigned)').toHaveText(FR_KO['compare.NOT_ASSIGNED']);
    });

    await step('Act: Step 2 — Click 수정 (Correct) on the P10 / NORMAL row', async () => {
      await list.openCorrect(row);
    });

    await step('Assert: Expected 2 — Empty Tier 1 list with the family-empty text, Tier 2 input with placeholder, basis label', async () => {
      await expect(list.correct.title, '[Expected 2] Dialog 수수료 산정 수정 opens').toHaveText(FR_KO['fix.title']);
      expect(await list.correct.optionTexts(), '[Expected 2] Tier 1 list is empty and reads 이 상품의 계약 패밀리는 어떤 카테고리도 가격을 매기지 않습니다').toEqual([FR_KO['fix.familyEmpty']]);
      await expect(list.correct.tier2Input, '[Expected 2] Tier 2 input is rendered').toBeVisible();
      await expect(list.correct.tier2Input, '[Expected 2] Tier 2 placeholder 예: 4.50%').toHaveAttribute('placeholder', FR_KO['fix.tier2Placeholder']);
      await expect(list.correct.reasonLabel, '[Expected 2] Reason label 수수료 산정 근거 (필수) (Basis for this rate (required))').toHaveText(FR_KO['fix.reasonLabelT2']);
    });

    await step('Act: Step 3 — Type 6.75 into 2단계 — 요율 직접 입력 (Tier 2)', async () => {
      await list.correct.tier2Input.fill('6.75');
    });

    await step('Assert: Expected 3 — The delta preview reads 직접 입력 — 승인 필요', async () => {
      await expect(list.correct.deltaHead, '[Expected 3] Heading 직접 입력 — 승인 필요 (Typed by hand — needs approval)').toHaveText(FR_KO['fix.deltaT2Head']);
    });

    await step('Act: Step 4 — Type the basis for this rate and click 저장 (Save)', async () => {
      await list.correct.reasonInput.fill(reason);
      saved = await list.correct.save();
    });

    await step('Assert: Expected 4 — The hand-keyed toast shows and the dialog closes', async () => {
      expect(saved.status(), '[Expected 4] The save request succeeds (201)').toBe(201);
      await expect(list.toast(FR_KO['fix.savedDraftTyped']), '[Expected 4] Toast 승인 요청으로 상신되었습니다. 직접 입력한 요율은 항상 승인이 필요합니다.').toBeVisible();
      await expect(list.correct.root, '[Expected 4] The dialog closes').toHaveCount(0);
    });

    await step('Act: Step 5 — Look at the P10 / NORMAL row on the list', async () => {
      await list.search(pid);
    });

    await step('Assert: Expected 5 — No in-force rate, still 적용 행 없음, proposed 6.75% with badge 직접 입력, pill 수정됨 — 미상신', async () => {
      expect(await ext.mainText(list.cell(row, 'rate')), '[Expected 5] The in-force rate stays empty').not.toContain('%');
      await expect(list.cell(row, 'status'), '[Expected 5] The status stays 적용 행 없음 (No row applies)').toContainText(FR_KO['status.NO_ROW']);
      await expect(list.secondLine(list.cell(row, 'rate')), '[Expected 5] Proposed rate 6.75% beside it').toContainText('6.75%');
      await expect(ext.handKeyedBadge(row), '[Expected 5] Badge 직접 입력 (Hand-keyed)').toBeVisible();
      await expect(list.statusPills(row).nth(1), '[Expected 5] Second pill 수정됨 — 미상신').toHaveText(FR_KO['state.DRAFT']);
    });

    await step('Act: Step 6 — Read fee_correction of P10', async () => {
      correction = await db('SELECT tier, override_rate, rate_after, category_id, rate_before, state, change_approval_id FROM fee_correction WHERE product_id = ?', [pid]);
    });

    await step('Assert: Expected 6 — RATE_OVERRIDE 6.75, no category, no rate before, DRAFT, no approval', async () => {
      const c = correction[0] ?? {};
      expect(c.tier, '[Expected 6] tier = RATE_OVERRIDE').toBe('RATE_OVERRIDE');
      expect(num(c.override_rate), '[Expected 6] override_rate = 6.75').toBe(6.75);
      expect(num(c.rate_after), '[Expected 6] rate_after = 6.7500').toBe(6.75);
      expect(c.category_id ?? null, '[Expected 6] category_id = NULL').toBeNull();
      expect(c.rate_before ?? null, '[Expected 6] rate_before = NULL').toBeNull();
      expect(c.state, '[Expected 6] state = DRAFT').toBe('DRAFT');
      expect(c.change_approval_id ?? null, '[Expected 6] change_approval_id = NULL').toBeNull();
    });
  });

  test('TC_US079_87 — A correction is routed to approval when the contract rate changed after the dialog opened', async ({ page, feeReviewPage: list, feeReviewApi, contractsApi, approverContractsApi, seedData }) => {
    const step = makeStep(page);
    const ext = new CorrectV1Page(page, list);
    const reason = reasonOf('TC_US079_87', 'Contract moved while the dialog was open');
    await tcMeta('TC_US079_87', 'Critical', TAGS, `With a pending fee row R_A2 (A 13.00% from mid-cycle) on ROOT, P05 is corrected A → D while the preview says 요율 그대로; user B then approves R_A2 while the dialog stays open; Save sends previewRoute = APPLIES_AT_ONCE and the server reroutes it (201 DRAFT, REROUTED_TO_APPROVAL) with the rerouted toast; the row shows 13.00% in force with D 12.50% proposed and pill 수정됨 — 미상신; fee_correction is DRAFT 13.0 → 12.5. Deviation: R_A2 effectiveFrom = the 15th of the CY_MAIN month (the TC's <Y>-03-15). ${DEV_CYCLE} ${DEV_PRIVATE} ${CLEAN}`);
    let s!: Awaited<ReturnType<typeof seedData>>;
    let pid = '';
    let cycleId = 0;
    let row!: Locator;
    let added = { rowId: 0, approvalId: 0 };
    let approved = 0;
    let saved!: Response;
    let correction: RowDataPacket[] = [];

    await step('Arrange: Pre-condition 1–13 — ROOT (R_A 12.50 · R_D 12.50), pending row R_A2 (A 13.00 from mid-cycle), cycle CY_MAIN, product P05', async () => {
      s = await seedData({ tc: 87, private: true, contracts: family({ ROOT: ['R_A', 'R_D'] }), cycles: ['CY_MAIN'], products: [product('P05', main(151))] });
      pid = s.products.P05;
      cycleId = s.cycles.CY_MAIN.id;
      const res = await contractsApi.addFeeRow<{ newRowId?: number; changeApprovalId?: number }>(s.family.contracts.ROOT, {
        key: { categoryId: s.master.category.A, saleTypeId: s.master.saleType.ST1, policy: 'NORMAL' },
        commissionType: 'PERCENT',
        commission: 13,
        effectiveFrom: `${s.cycles.CY_MAIN.label}-15`,
        pgCommissionRate: 3,
        feeBase: 'PRODUCT_PRICE',
        pgFeeBase: 'PRODUCT_PRICE',
        changeReason: `[T079-${s.run}-87] R_A2`,
      });
      expect(res.status, 'Pre-condition 6 — POST fee-rows (R_A2) returns 201').toBe(201);
      added = { rowId: Number(res.body?.newRowId), approvalId: Number(res.body?.changeApprovalId) };
      expect(added.approvalId, 'Pre-condition 6 — R_A2 waits for approval (CA_A2)').toBeGreaterThan(0);
      const r2 = (await contractsApi.feeRows(s.family.contracts.ROOT)).find((r) => r.id === added.rowId);
      expect(r2?.status, 'Pre-condition 7 — R_A2 is not ACTIVE yet').not.toBe('ACTIVE');
      expect((await feeReviewApi.row(cycleId, pid)).status, 'Pre-condition 11 — P05 is RESOLVED').toBe('RESOLVED');
    });

    await step('Act: Step 1 — Open Settlement fee review on CY_MAIN and search the P05 product id', async () => {
      row = await showRow(list, cycleId, pid);
    });

    await step('Assert: Expected 1 — 산정 완료, A, 12.50%', async () => {
      await expect(list.cell(row, 'status'), '[Expected 1] 산정 완료 (Resolved)').toContainText(FR_KO['status.RESOLVED']);
      await expect(list.cell(row, 'category'), '[Expected 1] Category A').toHaveText(s.master.categoryName.A);
      await expect(list.cell(row, 'rate'), '[Expected 1] 12.50%').toHaveText('12.50%');
    });

    await step('Act: Step 2 — Click 수정 (Correct) on P05 / NORMAL and select category D in Tier 1', async () => {
      await list.openCorrect(row);
      await list.correct.pickCategory(s.master.categoryName.D);
    });

    await step('Assert: Expected 2 — The delta preview reads 요율 그대로 — 승인 불필요, rate stays 12.50%', async () => {
      await expect(list.correct.deltaHead, '[Expected 2] Heading 요율 그대로 — 승인 불필요').toHaveText(FR_KO['fix.deltaZeroHead']);
      await expect(list.correct.deltaPanel, '[Expected 2] The rate stays 12.50%').toContainText(frFormat(FR_KO['fix.deltaZeroBody'], { rate: '12.50%' }));
    });

    await step('Act: Step 3 — Type the reason and leave the dialog open', async () => {
      await list.correct.reasonInput.fill(reason);
    });

    await step('Assert: Expected 3 — The reason is accepted and Save is enabled', async () => {
      await expect(ext.reasonRequired, '[Expected 3] No reason message').toHaveCount(0);
      await expect(list.correct.saveButton, '[Expected 3] 저장 (Save) is enabled').toBeEnabled();
    });

    await step('Act: Step 4 — As user B approve CA_A2, then read the ROOT fee rows', async () => {
      approved = (await approverContractsApi.approve(added.approvalId)).status;
    });

    await step('Assert: Expected 4 — Approve returns 200; R_A2 is ACTIVE from the 15th of the cycle month', async () => {
      expect(approved, '[Expected 4] Approve returns 200').toBe(200);
      const r2 = (await contractsApi.feeRows(s.family.contracts.ROOT)).find((r) => r.id === added.rowId);
      expect(r2?.status, '[Expected 4] R_A2 status ACTIVE').toBe('ACTIVE');
      expect(String(r2?.effectiveFrom ?? ''), `[Expected 4] R_A2 effectiveFrom ${s.cycles.CY_MAIN.label}-15`).toContain(`${s.cycles.CY_MAIN.label}-15`);
    });

    await step('Act: Step 5 — Back in the still-open dialog (no reload) click 저장 (Save), capturing the request', async () => {
      saved = await list.correct.save();
    });

    await step('Assert: Expected 5 — Request carries previewRoute = APPLIES_AT_ONCE; 201 DRAFT / REROUTED_TO_APPROVAL; the rerouted toast shows', async () => {
      const sent = (saved.request().postDataJSON() ?? {}) as Record<string, unknown>;
      const body = (await saved.json().catch(() => ({}))) as Record<string, unknown>;
      expect(sent.previewRoute, '[Expected 5] Request body carries previewRoute = APPLIES_AT_ONCE').toBe('APPLIES_AT_ONCE');
      expect(saved.status(), '[Expected 5] Response 201').toBe(201);
      expect(body.state, '[Expected 5] state = DRAFT').toBe('DRAFT');
      expect(body.routeTaken, '[Expected 5] routeTaken = REROUTED_TO_APPROVAL').toBe('REROUTED_TO_APPROVAL');
      await expect(list.toast(FR_KO['fix.savedRerouted']), '[Expected 5] Toast 승인 요청으로 상신되었습니다. 창을 연 뒤 계약 요율이 바뀌어, 이 수정은 이제 승인이 필요합니다.').toBeVisible();
    });

    await step('Act: Step 6 — Look at the P05 / NORMAL row on the list', async () => {
      if (await list.correct.root.isVisible()) await list.correct.cancel();
      await list.search(pid);
    });

    await step('Assert: Expected 6 — 13.00% in force with D 12.50% proposed and pill 수정됨 — 미상신', async () => {
      expect(await ext.mainText(list.cell(row, 'rate')), '[Expected 6] In-force rate 13.00%').toBe('13.00%');
      await expect(list.secondLine(list.cell(row, 'rate')), '[Expected 6] Proposed 12.50% beside it').toContainText('12.50%');
      await expect(list.secondLine(list.cell(row, 'category')), '[Expected 6] Proposed category D beside it').toContainText(s.master.categoryName.D);
      await expect(list.statusPills(row).nth(1), '[Expected 6] Second pill 수정됨 — 미상신 — not in force').toHaveText(FR_KO['state.DRAFT']);
    });

    await step('Act: Step 7 — Read fee_correction of P05', async () => {
      correction = await db('SELECT state, rate_before, rate_after, change_approval_id FROM fee_correction WHERE product_id = ?', [pid]);
    });

    await step('Assert: Expected 7 — DRAFT · rate_before 13.0000 · rate_after 12.5000 · no approval', async () => {
      const c = correction[0] ?? {};
      expect(c.state, '[Expected 7] state = DRAFT').toBe('DRAFT');
      expect(num(c.rate_before), '[Expected 7] rate_before = 13.0000').toBe(13);
      expect(num(c.rate_after), '[Expected 7] rate_after = 12.5000').toBe(12.5);
      expect(c.change_approval_id ?? null, '[Expected 7] change_approval_id = NULL').toBeNull();
    });
  });

  test('TC_US079_88 — The category list offers only categories the family prices, each with its rate', async ({ page, feeReviewPage: list, feeReviewApi, seedData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_88', 'High', TAGS, `P06 (category D, which the family does not price → 적용 행 없음) opens with — 변경 없음 —; the list offers exactly A 12.50%, B 9.00%, C (⚠ 동순위) and E 9.50% in catalogue order and no D; correction-options returns the same four entries with tier2Open = false; picking B / E previews a rate change to 9.00% / 9.50% needing approval. Deviation: the app writes each option as "<category> (12.50%)" where the TC reads "A — 12.50%" — the rate figure is asserted. ${DEV_CYCLE} ${DEV_SHARED} ${CLEAN}`);
    let s!: Awaited<ReturnType<typeof seedData>>;
    let pid = '';
    let cycleId = 0;
    let row!: Locator;
    let options: string[] = [];
    let api!: Awaited<ReturnType<typeof optionsWithStatus>>;

    await step('Arrange: Pre-condition 1–13 — Full family (ROOT R_A/R_B10/R_PROMO/R_E11 · ANNEX1 R_B9/R_C20 · ANNEX2 R_C22), cycle CY_MAIN, product P06 (category D)', async () => {
      s = await seedData({ tc: 88, contracts: fullFamily(), cycles: ['CY_MAIN'], products: [product('P06', main(188))] });
      pid = s.products.P06;
      cycleId = s.cycles.CY_MAIN.id;
      expect((await feeReviewApi.row(cycleId, pid)).status, 'Pre-condition 11 — P06 is NO_ROW').toBe('NO_ROW');
    });

    await step('Act: Step 1 — Open Settlement fee review on CY_MAIN and search the P06 product id', async () => {
      row = await showRow(list, cycleId, pid);
    });

    await step('Assert: Expected 1 — 적용 행 없음, empty rate', async () => {
      await expect(list.cell(row, 'status'), '[Expected 1] 적용 행 없음 (No row applies)').toContainText(FR_KO['status.NO_ROW']);
      await expect(list.cell(row, 'rate'), '[Expected 1] Empty rate').not.toContainText('%');
    });

    await step('Act: Step 2 — Click 수정 (Correct) on the P06 / NORMAL row', async () => {
      await list.openCorrect(row);
    });

    await step('Assert: Expected 2 — The dialog opens; Tier 1 shows — 변경 없음 —', async () => {
      await expect(list.correct.title, '[Expected 2] Dialog 수수료 산정 수정 opens').toHaveText(FR_KO['fix.title']);
      await expect(new CorrectV1Page(page, list).checkedOption, '[Expected 2] Tier 1 shows — 변경 없음 — (— no change —)').toHaveText(FR_KO['fix.noChange']);
    });

    await step('Act: Step 3 — Open the Tier 1 list and read every option', async () => {
      options = (await list.correct.optionTexts()).filter((t) => t !== FR_KO['fix.noChange']);
    });

    await step('Assert: Expected 3 — Exactly A 12.50%, B 9.00%, C tied, E 9.50% in catalogue order; D is not offered', async () => {
      const n = s.master.categoryName;
      expect(options, '[Expected 3] Exactly 4 categories in catalogue order').toEqual([option(n.A, '12.50'), option(n.B, '9.00'), option(n.C), option(n.E, '9.50')]);
      expect(options, '[Expected 3] A — 12.50%').toContain(option(n.A, '12.50'));
      expect(options, '[Expected 3] B — 9.00%').toContain(option(n.B, '9.00'));
      expect(options, '[Expected 3] C — marked (⚠ 동순위), no rate').toContain(option(n.C));
      expect(options, '[Expected 3] E — 9.50%').toContain(option(n.E, '9.50'));
      expect(options.filter((t) => t === n.D || t.startsWith(`${n.D} (`)), '[Expected 3] D is not offered').toEqual([]);
    });

    await step('Act: Step 4 — Call GET correction-options for P06 / NORMAL', async () => {
      api = await optionsWithStatus(feeReviewApi, cycleId, pid);
    });

    await step('Assert: Expected 4 — 200; A "12.50", B "9.00", C tied with no rate, E "9.50"; no D; tier2Open = false', async () => {
      const cat = (key: 'A' | 'B' | 'C' | 'D' | 'E') => api.body.categories.find((c) => c.categoryId === s.master.category[key]);
      expect(api.status, '[Expected 4] HTTP 200').toBe(200);
      expect(cat('A')?.rate, '[Expected 4] A rate "12.50"').toBe('12.50');
      expect(cat('B')?.rate, '[Expected 4] B rate "9.00"').toBe('9.00');
      expect(cat('C')?.tied, '[Expected 4] C tied = true').toBe(true);
      expect(cat('C')?.rate ?? null, '[Expected 4] C rate = null').toBeNull();
      expect(cat('E')?.rate, '[Expected 4] E rate "9.50"').toBe('9.50');
      expect(cat('D'), '[Expected 4] No entry for D').toBeUndefined();
      expect(api.body.tier2Open, '[Expected 4] tier2Open = false').toBe(false);
    });

    await step('Act: Step 5 — Select category B', async () => {
      await list.correct.pickCategory(s.master.categoryName.B);
    });

    await step('Assert: Expected 5 — The preview states the rate changes to 9.00% and needs approval', async () => {
      await expect(list.correct.deltaHead, '[Expected 5] Rate changes — needs approval').toHaveText(FR_KO['fix.deltaChgHead']);
      await expect(list.correct.deltaPanel, '[Expected 5] The rate changes to 9.00%').toContainText('9.00%');
      await expect(list.correct.deltaPanel, '[Expected 5] Needs approval').toContainText(FR_KO['fix.deltaChgTail'].trim());
    });

    await step('Act: Step 6 — Select category E', async () => {
      await list.correct.pickCategory(s.master.categoryName.E);
    });

    await step('Assert: Expected 6 — The preview states the rate changes to 9.50% and needs approval', async () => {
      await expect(list.correct.deltaHead, '[Expected 6] Rate changes — needs approval').toHaveText(FR_KO['fix.deltaChgHead']);
      await expect(list.correct.deltaPanel, '[Expected 6] The rate changes to 9.50%').toContainText('9.50%');
      await expect(list.correct.deltaPanel, '[Expected 6] Needs approval').toContainText(FR_KO['fix.deltaChgTail'].trim());
    });
  });

  test('TC_US079_89 — A category the family prices with two rows is marked tied and gives an ambiguous result', async ({ page, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const reason = reasonOf('TC_US079_89', '동순위 카테고리 선택 확인');
    await tcMeta('TC_US079_89', 'Medium', TAGS, `The family prices C with two annex rows tied on every ranking step (R_C20 / R_C22): C is offered as (⚠ 동순위) with no rate; picking it previews a rate change needing approval with no target rate; Save shows the draft toast; the row keeps A 12.50% with C proposed and no proposed rate; fee_correction is DRAFT CAT_C 12.5 → NULL. ${DEV_CYCLE} ${DEV_SHARED} ${CLEAN}`);
    let s!: Awaited<ReturnType<typeof seedData>>;
    let pid = '';
    let cycleId = 0;
    let row!: Locator;
    let tied = '';
    let saved!: Response;
    let correction: RowDataPacket[] = [];

    await step('Arrange: Pre-condition 1–13 — ROOT (R_A 12.50) + ANNEX1 (R_C20) + ANNEX2 (R_C22), cycle CY_MAIN, product P14 (A, assigned R_A)', async () => {
      s = await seedData({ tc: 89, contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_C20'], ANNEX2: ['R_C22'] }), cycles: ['CY_MAIN'], products: [product('P14', main(234))] });
      pid = s.products.P14;
      cycleId = s.cycles.CY_MAIN.id;
    });

    await step('Act: Step 1 — Open the list on CY_MAIN, search P14 and click 수정 (Correct) on P14 / NORMAL', async () => {
      row = await showRow(list, cycleId, pid);
      await list.openCorrect(row);
    });

    await step('Assert: Expected 1 — Dialog 수수료 산정 수정 opens', async () => {
      await expect(list.correct.title, '[Expected 1] Dialog 수수료 산정 수정 (Correct fee resolution) opens').toHaveText(FR_KO['fix.title']);
    });

    await step('Act: Step 2 — Open the Tier 1 list', async () => {
      tied = (await list.correct.optionTexts()).find((t) => t.startsWith(s.master.categoryName.C)) ?? '';
    });

    await step('Assert: Expected 2 — C is offered, marked (⚠ 동순위) with no rate', async () => {
      expect(tied, '[Expected 2] Category C is offered').not.toBe('');
      expect(tied, '[Expected 2] C is marked (⚠ 동순위)').toBe(option(s.master.categoryName.C));
      expect(tied, '[Expected 2] C carries no rate').not.toContain('%');
    });

    await step('Act: Step 3 — Select category C', async () => {
      await list.correct.tier1Select.selectOption({ label: tied });
    });

    await step('Assert: Expected 3 — The preview states the rate changes and needs approval, with no target rate', async () => {
      await expect(list.correct.deltaHead, '[Expected 3] Rate changes — needs approval').toHaveText(FR_KO['fix.deltaChgHead']);
      await expect(list.correct.deltaPanel, '[Expected 3] Needs approval').toContainText(FR_KO['fix.deltaChgTail'].trim());
      const figures = (await list.correct.deltaPanel.innerText()).match(PERCENT_FIGURE) ?? [];
      expect(figures.filter((f) => f !== '12.50%'), '[Expected 3] No target rate shown').toEqual([]);
    });

    await step('Act: Step 4 — Type the reason and click 저장 (Save)', async () => {
      await list.correct.reasonInput.fill(reason);
      saved = await list.correct.save();
    });

    await step('Assert: Expected 4 — The draft toast shows', async () => {
      expect(saved.status(), '[Expected 4] The save request succeeds (201)').toBe(201);
      await expect(list.toast(FR_KO['fix.savedDraft']), '[Expected 4] Toast 승인 요청으로 상신되었습니다. 요율이 변경됩니다.').toBeVisible();
    });

    await step('Act: Step 5 — Look at the P14 / NORMAL row on the list', async () => {
      await list.search(pid);
    });

    await step('Assert: Expected 5 — A 12.50% stays in force; C proposed with no proposed rate; pill 수정됨 — 미상신', async () => {
      const ext = new CorrectV1Page(page, list);
      expect(await ext.mainText(list.cell(row, 'category')), '[Expected 5] Category A stays in force').toBe(s.master.categoryName.A);
      expect(await ext.mainText(list.cell(row, 'rate')), '[Expected 5] 12.50% stays in force').toBe('12.50%');
      await expect(list.secondLine(list.cell(row, 'category')), '[Expected 5] Proposed category C beside it').toContainText(s.master.categoryName.C);
      expect((await list.cell(row, 'rate').innerText()).match(PERCENT_FIGURE) ?? [], '[Expected 5] No proposed rate (ambiguous result, not a rate)').toEqual(['12.50%']);
      await expect(list.statusPills(row).nth(1), '[Expected 5] Second pill 수정됨 — 미상신').toHaveText(FR_KO['state.DRAFT']);
    });

    await step('Act: Step 6 — Read the open fee_correction of P14', async () => {
      correction = await db('SELECT state, category_id, rate_before, rate_after FROM fee_correction WHERE product_id = ? AND discarded_at IS NULL', [pid]);
    });

    await step('Assert: Expected 6 — DRAFT · CAT_C · 12.5 → NULL', async () => {
      const c = correction[0] ?? {};
      expect(c.state, '[Expected 6] state = DRAFT').toBe('DRAFT');
      expect(num(c.category_id), '[Expected 6] category_id = CAT_C').toBe(s.master.category.C);
      expect(num(c.rate_before), '[Expected 6] rate_before = 12.5000').toBe(12.5);
      expect(c.rate_after ?? null, '[Expected 6] rate_after = NULL').toBeNull();
    });
  });

  test('TC_US079_90 — The delta preview states which of the three paths the save will take', async ({ page, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_90', 'Medium', TAGS, `On P05 (A 12.50%): nothing picked reads 아직 고른 것이 없습니다; D (12.50%) reads 요율 그대로 — 승인 불필요 with the rate kept and the Changes-this-period note; B (9.00%) reads 요율이 바뀝니다 — 승인 필요 from 12.50% to 9.00%; neither text names a rule code; Cancel saves nothing; on P10 (no row) a typed 6.75 reads 직접 입력 — 승인 필요 with the typed-rate sentence. ${DEV_CYCLE} ${DEV_SHARED} ${CLEAN}`);
    let s!: Awaited<ReturnType<typeof seedData>>;
    let cycleId = 0;
    let count = -1;

    await step('Arrange: Pre-condition 1–12 — ROOT (R_A 12.50 · R_D 12.50) + ANNEX1 (R_B9 9.00), cycle CY_MAIN, products P05 (A) and P10 (A × ST2)', async () => {
      s = await seedData({ tc: 90, contracts: family({ ROOT: ['R_A', 'R_D'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P05', main(151)), product('P10', main(86))] });
      cycleId = s.cycles.CY_MAIN.id;
    });

    await step('Act: Step 1 — Open the list on CY_MAIN, search P05 and click 수정 (Correct) on P05 / NORMAL', async () => {
      await list.openCorrect(await showRow(list, cycleId, s.products.P05));
    });

    await step('Assert: Expected 1 — Dialog 수수료 산정 수정 opens', async () => {
      await expect(list.correct.title, '[Expected 1] Dialog opens').toHaveText(FR_KO['fix.title']);
    });

    await step('Act: Step 2 — Leave Tier 1 on — 변경 없음 — and read the delta preview', async () => {
      await expect(list.correct.deltaPanel, 'The delta preview is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — 아직 고른 것이 없습니다 — 위에서 다른 카테고리를 고르세요.', async () => {
      await expect(list.correct.deltaHead, '[Expected 2] Heading 아직 고른 것이 없습니다 (Nothing picked yet)').toHaveText(FR_KO['fix.deltaNoneHead']);
      await expect(list.correct.deltaPanel, '[Expected 2] Text 위에서 다른 카테고리를 고르세요. (Pick another category above.)').toContainText(FR_KO['fix.deltaNoneBody']);
    });

    await step('Act: Step 3 — Select category D and read the delta preview', async () => {
      await list.correct.pickCategory(s.master.categoryName.D);
    });

    await step('Assert: Expected 3 — Path "rate does not move": heading, rate stays 12.50%, saved right away, listed under 이번 기 수정 내역, no rule code', async () => {
      await expect(list.correct.deltaHead, '[Expected 3] Heading 요율 그대로 — 승인 불필요').toHaveText(FR_KO['fix.deltaZeroHead']);
      await expect(list.correct.deltaPanel, '[Expected 3] The rate stays 12.50%, saved right away, listed under 이번 기 수정 내역').toContainText(frFormat(FR_KO['fix.deltaZeroBody'], { rate: '12.50%' }));
      expect(await list.correct.deltaPanel.innerText(), '[Expected 3] No rule code appears in the text').not.toMatch(NO_RULE_CODE);
    });

    await step('Act: Step 4 — Select category B and read the delta preview', async () => {
      await list.correct.pickCategory(s.master.categoryName.B);
    });

    await step('Assert: Expected 4 — Path "rate moves": heading, 12.50% → 9.00%, needs approval, no rule code', async () => {
      await expect(list.correct.deltaHead, '[Expected 4] Heading 요율이 바뀝니다 — 승인 필요').toHaveText(FR_KO['fix.deltaChgHead']);
      await expect(list.correct.deltaPanel, '[Expected 4] The rate changes from 12.50% to 9.00%').toContainText(/12\.50%[\s\S]*9\.00%/);
      await expect(list.correct.deltaPanel, '[Expected 4] Needs approval before it counts').toContainText(FR_KO['fix.deltaChgTail'].trim());
      expect(await list.correct.deltaPanel.innerText(), '[Expected 4] No rule code appears in the text').not.toMatch(NO_RULE_CODE);
    });

    await step('Act: Step 5 — Click 취소 (Cancel)', async () => {
      await list.correct.cancelButton.click();
      const [row] = await db('SELECT COUNT(*) AS n FROM fee_correction WHERE product_id = ?', [s.products.P05]);
      count = Number(row.n);
    });

    await step('Assert: Expected 5 — The dialog closes; nothing is saved', async () => {
      await expect(list.correct.root, '[Expected 5] The dialog closes').toHaveCount(0);
      expect(count, '[Expected 5] Nothing is saved (no fee_correction row for P05)').toBe(0);
    });

    await step('Act: Step 6 — Search P10, click 수정 (Correct) on P10 / NORMAL and type 6.75 into Tier 2', async () => {
      await list.search(s.products.P10);
      await list.openCorrect(list.row(s.products.P10));
      await list.correct.tier2Input.fill('6.75');
    });

    await step('Assert: Expected 6 — Path "rate typed": heading 직접 입력 — 승인 필요 and the typed-rate sentence', async () => {
      await expect(list.correct.deltaHead, '[Expected 6] Heading 직접 입력 — 승인 필요').toHaveText(FR_KO['fix.deltaT2Head']);
      await expect(list.correct.deltaPanel, '[Expected 6] Text 이 상품을 다루는 계약 요율이 없습니다. …').toContainText(FR_KO['fix.deltaT2Body']);
    });
  });

  test('TC_US079_91 — The hand-keyed field is replaced by a line of text while a contract row applies', async ({ page, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const ext = new CorrectV1Page(page, list);
    const seen = new Observations(page);
    await tcMeta('TC_US079_91', 'Medium', TAGS, `On P14 (a contract row applies) the Tier 2 area shows only the line 계약에 요율이 있어 직접 입력할 수 없습니다. 위에서 카테고리를 선택하세요. with no input element (not a disabled box), and it stays so after picking B, E, C and — 변경 없음 —; on P10 (no row) the Tier 2 area renders the rate input with placeholder 예: 4.50% and no text line. ${DEV_CYCLE} ${DEV_SHARED} ${CLEAN}`);
    let s!: Awaited<ReturnType<typeof seedData>>;
    let cycleId = 0;

    await step('Arrange: Pre-condition 1–13 — Full family, cycle CY_MAIN, products P14 (A, assigned R_A) and P10 (A × ST2)', async () => {
      s = await seedData({ tc: 91, contracts: fullFamily(), cycles: ['CY_MAIN'], products: [product('P14', main(234)), product('P10', main(86))] });
      cycleId = s.cycles.CY_MAIN.id;
    });

    await step('Act: Step 1 — Open the list on CY_MAIN, search P14 and click 수정 (Correct) on P14 / NORMAL', async () => {
      await list.openCorrect(await showRow(list, cycleId, s.products.P14));
    });

    await step('Assert: Expected 1 — Under the Tier 2 label one line of text: 계약에 요율이 있어 직접 입력할 수 없습니다. …', async () => {
      await expect(list.correct.tier2Label, '[Expected 1] The Tier 2 label is shown').toBeVisible();
      await expect(ext.tier2Area.getByText(FR_KO['fix.tier2Lock'], { exact: true }), '[Expected 1] The lock line sits under the Tier 2 label').toBeVisible();
    });

    await step('Act: Step 2 — Inspect the Tier 2 area', async () => {
      await ext.tier2Area.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — No rate input element exists in the Tier 2 area (not rendered, not a disabled box)', async () => {
      await expect(ext.tier2Area.locator('input, textarea'), '[Expected 2] No rate input element in the Tier 2 area').toHaveCount(0);
    });

    await step('Act: Step 3 — Select B, then E, then C, then — 변경 없음 — in Tier 1', async () => {
      const n = s.master.categoryName;
      for (const name of [n.B, n.E, n.C]) {
        await list.correct.pickCategory(name);
        await seen.record(`[Expected 3] After picking ${name} the lock line stays`, () => ext.tier2Area.getByText(FR_KO['fix.tier2Lock'], { exact: true }).isVisible());
        await seen.record(`[Expected 3] After picking ${name} no rate input appears`, async () => (await ext.tier2Area.locator('input, textarea').count()) === 0);
      }
      await list.correct.tier1Select.selectOption({ label: FR_KO['fix.noChange'] });
      await seen.record('[Expected 3] After — 변경 없음 — the lock line stays', () => ext.tier2Area.getByText(FR_KO['fix.tier2Lock'], { exact: true }).isVisible());
      await seen.record('[Expected 3] After — 변경 없음 — no rate input appears', async () => (await ext.tier2Area.locator('input, textarea').count()) === 0);
    });

    await step('Assert: Expected 3 — After every category change the text line stays and no rate input appears', async () => {
      seen.assertAll();
    });

    await step('Act: Step 4 — Click 취소 (Cancel), search P10 and click 수정 (Correct) on P10 / NORMAL', async () => {
      await list.correct.cancel();
      await list.search(s.products.P10);
      await list.openCorrect(list.row(s.products.P10));
    });

    await step('Assert: Expected 4 — The Tier 2 area renders a rate input with placeholder 예: 4.50% and no text line', async () => {
      await expect(list.correct.tier2Input, '[Expected 4] Tier 2 rate input is rendered').toBeVisible();
      await expect(list.correct.tier2Input, '[Expected 4] Placeholder 예: 4.50%').toHaveAttribute('placeholder', FR_KO['fix.tier2Placeholder']);
      await expect(list.correct.tier2Lock, '[Expected 4] No lock text line').toHaveCount(0);
    });
  });

  test('TC_US079_92 — The reason label and placeholder follow the tier', async ({ page, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const reason = reasonOf('TC_US079_92', '유사 계약 요율과 동일하게 적용');
    await tcMeta('TC_US079_92', 'Medium', TAGS, `On P14 (tier 1) the reason field reads 수정 사유 (필수) / 왜 수정하는지 입력하세요; on P10 (tier 2) it reads 수수료 산정 근거 (필수) / 이 요율을 어떻게 정했는지 입력하세요; a typed 6.75 with that basis saves with the hand-keyed toast and the record keeps tier RATE_OVERRIDE with the reason. ${DEV_CYCLE} ${DEV_SHARED} ${CLEAN}`);
    let s!: Awaited<ReturnType<typeof seedData>>;
    let cycleId = 0;
    let saved!: Response;
    let correction: RowDataPacket[] = [];

    await step('Arrange: Pre-condition 1–11 — ROOT (R_A 12.50), cycle CY_MAIN, products P14 (A, assigned R_A) and P10 (A × ST2)', async () => {
      s = await seedData({ tc: 92, contracts: family({ ROOT: ['R_A'] }), cycles: ['CY_MAIN'], products: [product('P14', main(234)), product('P10', main(86))] });
      cycleId = s.cycles.CY_MAIN.id;
    });

    await step('Act: Step 1 — Open the list on CY_MAIN, search P14 and click 수정 (Correct) on P14 / NORMAL', async () => {
      await list.openCorrect(await showRow(list, cycleId, s.products.P14));
    });

    await step('Assert: Expected 1 — Tier 1 reason field: label 수정 사유 (필수), placeholder 왜 수정하는지 입력하세요', async () => {
      await expect(list.correct.reasonLabel, '[Expected 1] Label 수정 사유 (필수) (Reason (required))').toHaveText(FR_KO['fix.reasonLabel']);
      await expect(list.correct.reasonInput, '[Expected 1] Placeholder 왜 수정하는지 입력하세요 (Why is this being corrected?)').toHaveAttribute('placeholder', FR_KO['fix.reasonPlaceholder']);
    });

    await step('Act: Step 2 — Click 취소 (Cancel), search P10 and click 수정 (Correct) on P10 / NORMAL', async () => {
      await list.correct.cancel();
      await list.search(s.products.P10);
      await list.openCorrect(list.row(s.products.P10));
    });

    await step('Assert: Expected 2 — Tier 2 reason field: label 수수료 산정 근거 (필수), placeholder 이 요율을 어떻게 정했는지 입력하세요', async () => {
      await expect(list.correct.reasonLabel, '[Expected 2] Label 수수료 산정 근거 (필수) (Basis for this rate (required))').toHaveText(FR_KO['fix.reasonLabelT2']);
      await expect(list.correct.reasonInput, '[Expected 2] Placeholder 이 요율을 어떻게 정했는지 입력하세요 (How was this rate arrived at?)').toHaveAttribute('placeholder', FR_KO['fix.reasonPlaceholderT2']);
    });

    await step('Act: Step 3 — Type 6.75 into Tier 2, type the reason and click 저장 (Save)', async () => {
      await list.correct.tier2Input.fill('6.75');
      await list.correct.reasonInput.fill(reason);
      saved = await list.correct.save();
    });

    await step('Assert: Expected 3 — The hand-keyed toast shows', async () => {
      expect(saved.status(), '[Expected 3] The save request succeeds (201)').toBe(201);
      await expect(list.toast(FR_KO['fix.savedDraftTyped']), '[Expected 3] Toast 승인 요청으로 상신되었습니다. 직접 입력한 요율은 항상 승인이 필요합니다.').toBeVisible();
    });

    await step('Act: Step 4 — Read the open fee_correction of P10', async () => {
      correction = await db('SELECT tier, reason FROM fee_correction WHERE product_id = ? AND discarded_at IS NULL', [s.products.P10]);
    });

    await step('Assert: Expected 4 — tier = RATE_OVERRIDE · reason = the typed reason', async () => {
      expect(correction[0]?.tier, '[Expected 4] tier = RATE_OVERRIDE (the tier it was made under)').toBe('RATE_OVERRIDE');
      expect(correction[0]?.reason, '[Expected 4] reason = the typed reason').toBe(reason);
    });
  });

  test('TC_US079_93 — The reason accepts 1 to 200 characters after trimming', async ({ page, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const ext = new CorrectV1Page(page, list);
    const r199 = '가'.repeat(199);
    const r200 = 'R'.repeat(200);
    const r201 = 'A'.repeat(201);
    const padded = `   ${'K'.repeat(198)}`;
    await tcMeta('TC_US079_93', 'Medium', TAGS, `With B picked on P14: an empty or whitespace-only reason keeps 저장 disabled with 수정 사유를 입력해 주세요.; 1, 199 and 200 characters are accepted (counter 199 / 200, 200 / 200); 201 characters are refused (Save blocked, red counter, 사유는 200자까지 입력할 수 있습니다.); 200 'R' saves and is stored at length 200; on P05, 3 spaces + 198 'K' (201 raw, 198 trimmed) is accepted, saves and is stored trimmed at length 198. Expected to fail (TC build note): the reason box has maxLength 200, so the 201-character paste is cut and the too-long message never shows; the server counts length before trimming, so the 3 + 198 save is refused. Data: the fixed-length reasons are the TC's own strings (no traceable prefix, the length is under test). ${DEV_CYCLE} ${DEV_SHARED} ${CLEAN}`);
    let s!: Awaited<ReturnType<typeof seedData>>;
    let cycleId = 0;
    let saved!: Response;
    let savedPadded!: Response;
    let stored: RowDataPacket[] = [];
    let storedPadded: RowDataPacket[] = [];

    await step('Arrange: Pre-condition 1–12 — ROOT (R_A 12.50) + ANNEX1 (R_B9 9.00), cycle CY_MAIN, products P14 (A, assigned R_A) and P05 (A)', async () => {
      s = await seedData({ tc: 93, contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P14', main(234)), product('P05', main(151))] });
      cycleId = s.cycles.CY_MAIN.id;
    });

    await step('Act: Step 1 — Search P14, click 수정 (Correct) on P14 / NORMAL and select category B', async () => {
      await list.openCorrect(await showRow(list, cycleId, s.products.P14));
      await list.correct.pickCategory(s.master.categoryName.B);
    });

    await step('Assert: Expected 1 — The dialog opens; the counter reads 0 / 200', async () => {
      await expect(list.correct.title, '[Expected 1] Dialog opens').toHaveText(FR_KO['fix.title']);
      await expect(list.correct.counter, '[Expected 1] Counter 0 / 200').toHaveText('0 / 200');
    });

    await step('Act: Step 2 — Leave 수정 사유 (필수) (Reason) empty (0 characters)', async () => {
      await list.correct.reasonInput.fill('');
      await list.correct.reasonInput.blur();
    });

    await step('Assert: Expected 2 — 0 characters is refused: Save disabled, field highlighted with 수정 사유를 입력해 주세요.', async () => {
      await expect(list.correct.saveButton, '[Expected 2] 저장 (Save) stays disabled').toBeDisabled();
      await expect(list.correct.reasonInput, '[Expected 2] The reason field is highlighted').toHaveClass(/is-invalid/);
      await expect(ext.reasonRequired, '[Expected 2] Message 수정 사유를 입력해 주세요.').toBeVisible();
    });

    await step('Act: Step 3 — Type 5 spaces only', async () => {
      await list.correct.reasonInput.fill('     ');
    });

    await step('Assert: Expected 3 — Whitespace-only counts as empty: Save disabled, field highlighted with the reason message', async () => {
      await expect(list.correct.saveButton, '[Expected 3] Save stays disabled').toBeDisabled();
      await expect(list.correct.reasonInput, '[Expected 3] The reason field is highlighted').toHaveClass(/is-invalid/);
      await expect(ext.reasonRequired, '[Expected 3] Message 수정 사유를 입력해 주세요.').toBeVisible();
    });

    await step('Act: Step 4 — Clear the field and type X (1 character)', async () => {
      await list.correct.reasonInput.fill('X');
    });

    await step('Assert: Expected 4 — 1 character is accepted: no message, Save enabled', async () => {
      await expect(ext.reasonRequired, '[Expected 4] No reason message').toHaveCount(0);
      await expect(ext.reasonTooLong, '[Expected 4] No too-long message').toHaveCount(0);
      await expect(list.correct.saveButton, '[Expected 4] Save is enabled').toBeEnabled();
    });

    await step("Act: Step 5 — Clear the field and paste 199 '가'", async () => {
      await list.correct.reasonInput.fill(r199);
    });

    await step('Assert: Expected 5 — 199 characters are accepted: no message, counter 199 / 200, Save enabled', async () => {
      await expect(ext.reasonRequired, '[Expected 5] No reason message').toHaveCount(0);
      await expect(ext.reasonTooLong, '[Expected 5] No too-long message').toHaveCount(0);
      await expect(list.correct.counter, '[Expected 5] Counter 199 / 200').toHaveText('199 / 200');
      await expect(list.correct.saveButton, '[Expected 5] Save is enabled').toBeEnabled();
    });

    await step("Act: Step 6 — Clear the field and paste 200 'R'", async () => {
      await list.correct.reasonInput.fill(r200);
    });

    await step('Assert: Expected 6 — 200 characters are accepted: no message, counter 200 / 200, Save enabled', async () => {
      await expect(ext.reasonRequired, '[Expected 6] No reason message').toHaveCount(0);
      await expect(ext.reasonTooLong, '[Expected 6] No too-long message').toHaveCount(0);
      await expect(list.correct.counter, '[Expected 6] Counter 200 / 200').toHaveText('200 / 200');
      await expect(list.correct.saveButton, '[Expected 6] Save is enabled').toBeEnabled();
    });

    await step("Act: Step 7 — Clear the field and paste 201 'A'", async () => {
      await list.correct.reasonInput.fill(r201);
    });

    await step('Assert: Expected 7 — 201 characters are refused: Save blocked, red counter, 사유는 200자까지 입력할 수 있습니다.', async () => {
      await expect.soft(list.correct.saveButton, '[Expected 7] Save is blocked').toBeDisabled();
      await expect.soft(list.correct.counter, '[Expected 7] The counter turns red').toHaveClass(/text-danger/);
      await expect.soft(ext.reasonTooLong, '[Expected 7] Message 사유는 200자까지 입력할 수 있습니다.').toBeVisible();
    });

    await step("Act: Step 8 — Clear the field, paste 200 'R' and click 저장 (Save)", async () => {
      await list.correct.reasonInput.fill(r200);
      saved = await list.correct.save();
    });

    await step('Assert: Expected 8 — The draft toast shows', async () => {
      expect(saved.status(), '[Expected 8] The save request succeeds (201)').toBe(201);
      await expect(list.toast(FR_KO['fix.savedDraft']), '[Expected 8] Toast 승인 요청으로 상신되었습니다. 요율이 변경됩니다.').toBeVisible();
    });

    await step('Act: Step 9 — Read the stored reason of P14', async () => {
      stored = await db('SELECT CHAR_LENGTH(reason) AS len, reason FROM fee_correction WHERE product_id = ? AND discarded_at IS NULL', [s.products.P14]);
    });

    await step("Assert: Expected 9 — CHAR_LENGTH(reason) = 200 and reason = the 200 'R' characters", async () => {
      expect(num(stored[0]?.len), '[Expected 9] CHAR_LENGTH(reason) = 200').toBe(200);
      expect(stored[0]?.reason, "[Expected 9] reason = the 200 'R' characters").toBe(r200);
    });

    await step("Act: Step 10 — Search P05, click 수정 (Correct), select B and paste 3 spaces + 198 'K'", async () => {
      if (await list.correct.root.isVisible()) await list.correct.cancel();
      await list.search(s.products.P05);
      await list.openCorrect(list.row(s.products.P05));
      await list.correct.pickCategory(s.master.categoryName.B);
      await list.correct.reasonInput.fill(padded);
    });

    await step('Assert: Expected 10 — 198 characters after trimming are accepted: no too-long message, Save enabled', async () => {
      await expect(ext.reasonTooLong, '[Expected 10] No too-long message').toHaveCount(0);
      await expect(list.correct.saveButton, '[Expected 10] Save is enabled').toBeEnabled();
    });

    await step('Act: Step 11 — Click 저장 (Save)', async () => {
      savedPadded = await list.correct.save();
    });

    await step('Assert: Expected 11 — The draft toast shows', async () => {
      expect(savedPadded.status(), '[Expected 11] The save request succeeds (201)').toBe(201);
      await expect(list.toast(FR_KO['fix.savedDraft']), '[Expected 11] Toast 승인 요청으로 상신되었습니다. 요율이 변경됩니다.').toBeVisible();
    });

    await step('Act: Step 12 — Read the stored reason of P05', async () => {
      storedPadded = await db('SELECT CHAR_LENGTH(reason) AS len, reason FROM fee_correction WHERE product_id = ? AND discarded_at IS NULL', [s.products.P05]);
    });

    await step('Assert: Expected 12 — CHAR_LENGTH(reason) = 198, stored trimmed with no leading spaces', async () => {
      expect(num(storedPadded[0]?.len), '[Expected 12] CHAR_LENGTH(reason) = 198').toBe(198);
      expect(storedPadded[0]?.reason, '[Expected 12] The stored reason is the trimmed text with no leading spaces').toBe(padded.trim());
    });
  });

  test('TC_US079_94 — The hand-keyed rate accepts only a positive number with at most two decimals', async ({ page, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_94', 'Medium', TAGS, `On P10 (tier 2 open): 0.00, 4.505, -1.00 and abc are refused with 요율을 예시와 같이 입력해 주세요 — 4.50% (field highlighted, Save blocked); 0.01, 4.5 and 4.50 are accepted; 4.5 saves with the hand-keyed toast and is stored as override_rate 4.50 / rate_after 4.5000 (the screen sends two decimals). ${DEV_CYCLE} ${DEV_SHARED} ${CLEAN}`);
    let s!: Awaited<ReturnType<typeof seedData>>;
    let saved!: Response;
    let correction: RowDataPacket[] = [];

    await step('Arrange: Pre-condition 1–11 — ROOT (R_A 12.50), cycle CY_MAIN, product P10 (A × ST2, no row applies)', async () => {
      s = await seedData({ tc: 94, contracts: family({ ROOT: ['R_A'] }), cycles: ['CY_MAIN'], products: [product('P10', main(86))] });
    });

    await step('Act: Step 1 — Search P10, click 수정 (Correct) on P10 / NORMAL and type the basis for this rate', async () => {
      await list.openCorrect(await showRow(list, s.cycles.CY_MAIN.id, s.products.P10));
      await list.correct.reasonInput.fill(reasonOf('TC_US079_94', 'Agreed rate per side letter'));
    });

    await step('Assert: Expected 1 — The dialog opens with the Tier 2 rate input rendered', async () => {
      await expect(list.correct.title, '[Expected 1] Dialog opens').toHaveText(FR_KO['fix.title']);
      await expect(list.correct.tier2Input, '[Expected 1] Tier 2 rate input rendered').toBeVisible();
    });

    const cases = [
      { n: 2, value: '0.00', ok: false, what: '0.00 (not positive)' },
      { n: 3, value: '0.01', ok: true, what: '0.01 (smallest positive value)' },
      { n: 4, value: '4.5', ok: true, what: '4.5 (one decimal)' },
      { n: 5, value: '4.50', ok: true, what: '4.50 (two decimals)' },
      { n: 6, value: '4.505', ok: false, what: '4.505 (three decimals)' },
      { n: 7, value: '-1.00', ok: false, what: '-1.00 (negative)' },
      { n: 8, value: 'abc', ok: false, what: 'abc (not a number)' },
    ] as const;
    for (const c of cases) {
      await step(`Act: Step ${c.n} — ${c.n === 2 ? 'Type' : 'Replace the rate with'} ${c.value}`, async () => {
        await list.correct.tier2Input.fill(c.value);
      });

      await step(`Assert: Expected ${c.n} — ${c.what} is ${c.ok ? 'accepted: no message, Save enabled' : 'refused: field highlighted with the rate message, Save blocked'}`, async () => {
        if (c.ok) {
          await expect(list.correct.rateError, `[Expected ${c.n}] No rate message`).toHaveCount(0);
          await expect(list.correct.saveButton, `[Expected ${c.n}] Save is enabled`).toBeEnabled();
        } else {
          await expect(list.correct.rateError, `[Expected ${c.n}] Message 요율을 예시와 같이 입력해 주세요 — 4.50%`).toBeVisible();
          await expect(list.correct.tier2Input, `[Expected ${c.n}] The field is highlighted`).toHaveClass(/is-invalid/);
          await expect(list.correct.saveButton, `[Expected ${c.n}] Save is blocked`).toBeDisabled();
        }
      });
    }

    await step('Act: Step 9 — Replace the rate with 4.5 and click 저장 (Save)', async () => {
      await list.correct.tier2Input.fill('4.5');
      saved = await list.correct.save();
    });

    await step('Assert: Expected 9 — The hand-keyed toast shows', async () => {
      expect(saved.status(), '[Expected 9] The save request succeeds (201)').toBe(201);
      await expect(list.toast(FR_KO['fix.savedDraftTyped']), '[Expected 9] Toast 승인 요청으로 상신되었습니다. 직접 입력한 요율은 항상 승인이 필요합니다.').toBeVisible();
    });

    await step('Act: Step 10 — Read the open fee_correction of P10', async () => {
      correction = await db('SELECT override_rate, rate_after FROM fee_correction WHERE product_id = ? AND discarded_at IS NULL', [s.products.P10]);
    });

    await step('Assert: Expected 10 — override_rate = 4.50 · rate_after = 4.5000', async () => {
      expect(num(correction[0]?.override_rate), '[Expected 10] override_rate = 4.50').toBe(4.5);
      expect(num(correction[0]?.rate_after), '[Expected 10] rate_after = 4.5000').toBe(4.5);
    });
  });

  test('TC_US079_95 — Save stays disabled until the category or the rate changes', async ({ page, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const ext = new CorrectV1Page(page, list);
    await tcMeta('TC_US079_95', 'Low', TAGS, `On P14 with a reason only, or with the category in force (A) picked, 저장 stays disabled with 변경된 내용이 없습니다.; B enables it; going back to — 변경 없음 — disables it again; on P10 a reason alone keeps it disabled, typing 6.75 enables it and clearing the rate disables it again. Nothing is saved. ${DEV_CYCLE} ${DEV_SHARED} ${CLEAN}`);
    let s!: Awaited<ReturnType<typeof seedData>>;

    await step('Arrange: Pre-condition 1–11 — ROOT (R_A 12.50 · R_B10 10.00), cycle CY_MAIN, products P14 (A, assigned R_A) and P10 (A × ST2)', async () => {
      s = await seedData({ tc: 95, contracts: family({ ROOT: ['R_A', 'R_B10'] }), cycles: ['CY_MAIN'], products: [product('P14', main(234)), product('P10', main(86))] });
    });

    await step('Act: Step 1 — Search P14 and click 수정 (Correct) on P14 / NORMAL', async () => {
      await list.openCorrect(await showRow(list, s.cycles.CY_MAIN.id, s.products.P14));
    });

    await step('Assert: Expected 1 — The dialog opens; 저장 (Save) is disabled', async () => {
      await expect(list.correct.title, '[Expected 1] Dialog opens').toHaveText(FR_KO['fix.title']);
      await expect(list.correct.saveButton, '[Expected 1] Save is disabled').toBeDisabled();
    });

    await step('Act: Step 2 — Type the reason without touching the category', async () => {
      await list.correct.reasonInput.fill(reasonOf('TC_US079_95', '변경 없음 확인'));
    });

    await step('Assert: Expected 2 — Save stays disabled and 변경된 내용이 없습니다. shows', async () => {
      await expect(list.correct.saveButton, '[Expected 2] Save stays disabled').toBeDisabled();
      await expect(ext.nothingChanged, '[Expected 2] Message 변경된 내용이 없습니다. (Nothing has changed yet.)').toBeVisible();
    });

    await step('Act: Step 3 — Select category A (the category in force)', async () => {
      await list.correct.pickCategory(s.master.categoryName.A);
    });

    await step('Assert: Expected 3 — Save stays disabled (the chosen category equals the one in force)', async () => {
      await expect(list.correct.saveButton, '[Expected 3] Save stays disabled').toBeDisabled();
    });

    await step('Act: Step 4 — Select category B', async () => {
      await list.correct.pickCategory(s.master.categoryName.B);
    });

    await step('Assert: Expected 4 — Save becomes enabled', async () => {
      await expect(list.correct.saveButton, '[Expected 4] Save becomes enabled').toBeEnabled();
    });

    await step('Act: Step 5 — Select — 변경 없음 — again', async () => {
      await list.correct.tier1Select.selectOption({ label: FR_KO['fix.noChange'] });
    });

    await step('Assert: Expected 5 — Save is disabled again with 변경된 내용이 없습니다.', async () => {
      await expect(list.correct.saveButton, '[Expected 5] Save is disabled again').toBeDisabled();
      await expect(ext.nothingChanged, '[Expected 5] Message 변경된 내용이 없습니다.').toBeVisible();
    });

    await step('Act: Step 6 — Click 취소 (Cancel), open 수정 (Correct) on P10 / NORMAL and type the reason', async () => {
      await list.correct.cancel();
      await list.search(s.products.P10);
      await list.openCorrect(list.row(s.products.P10));
      await list.correct.reasonInput.fill(reasonOf('TC_US079_95', 'No change check'));
    });

    await step('Assert: Expected 6 — Save is disabled with 변경된 내용이 없습니다.', async () => {
      await expect(list.correct.saveButton, '[Expected 6] Save is disabled').toBeDisabled();
      await expect(ext.nothingChanged, '[Expected 6] Message 변경된 내용이 없습니다.').toBeVisible();
    });

    await step('Act: Step 7 — Type 6.75 into Tier 2', async () => {
      await list.correct.tier2Input.fill('6.75');
    });

    await step('Assert: Expected 7 — Save becomes enabled', async () => {
      await expect(list.correct.saveButton, '[Expected 7] Save becomes enabled').toBeEnabled();
    });

    await step('Act: Step 8 — Clear the rate field', async () => {
      await list.correct.tier2Input.fill('');
    });

    await step('Assert: Expected 8 — Save is disabled again', async () => {
      await expect(list.correct.saveButton, '[Expected 8] Save is disabled again').toBeDisabled();
    });
  });

  test('TC_US079_97 — The save is refused when the chosen category is no longer priced at save time', async ({ page, feeReviewPage: list, contractsApi, approverContractsApi, seedData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_97', 'High', TAGS, `With B (9.00%) picked on P14 and the dialog open, both category B rows (R_B9 on ANNEX1, R_B10 on ROOT) are deactivated; Save is refused with STL-1017 계약이 이 카테고리에 요율을 더 이상 매기지 않습니다. … and no hand-keyed field appears; no correction is created; the reopened list offers only A, C, E; both rows are reactivated. Deviation: on a running contract a status change waits for approval, so each status change is approved by user B right away (the TC expects the rows to switch at once). ${DEV_CYCLE} ${DEV_PRIVATE} ${CLEAN}`);
    let s!: Awaited<ReturnType<typeof seedData>>;
    let pid = '';
    let off: number[] = [];
    let on: number[] = [];
    let saved = { status: 0, body: '' };
    let count = -1;
    let reopened: string[] = [];
    const statusOf = async (key: 'ROOT' | 'ANNEX1', label: 'R_B9' | 'R_B10') => (await contractsApi.feeRows(s.family.contracts[key])).find((r) => r.id === s.family.rows[label])?.status;

    await step('Arrange: Pre-condition 1–13 — Full private family, cycle CY_MAIN, product P14 (A, assigned R_A); R_B9 and R_B10 are the only B rows', async () => {
      s = await seedData({ tc: 97, private: true, contracts: fullFamily(), cycles: ['CY_MAIN'], products: [product('P14', main(234))] });
      pid = s.products.P14;
    });

    await step('Act: Step 1 — Search P14 and click 수정 (Correct) on P14 / NORMAL', async () => {
      await list.openCorrect(await showRow(list, s.cycles.CY_MAIN.id, pid));
    });

    await step('Assert: Expected 1 — The dialog opens; Tier 1 offers B annotated with 9.00%', async () => {
      await expect(list.correct.title, '[Expected 1] Dialog opens').toHaveText(FR_KO['fix.title']);
      expect(await list.correct.optionTexts(), '[Expected 1] B — 9.00%').toContain(option(s.master.categoryName.B, '9.00'));
    });

    await step('Act: Step 2 — Select B, type the reason and leave the dialog open', async () => {
      await list.correct.pickCategory(s.master.categoryName.B);
      await list.correct.reasonInput.fill(reasonOf('TC_US079_97', '팬클럽 키트로 정정'));
    });

    await step('Assert: Expected 2 — The preview states the rate changes to 9.00% and needs approval', async () => {
      await expect(list.correct.deltaHead, '[Expected 2] Rate changes — needs approval').toHaveText(FR_KO['fix.deltaChgHead']);
      await expect(list.correct.deltaPanel, '[Expected 2] The rate changes to 9.00%').toContainText('9.00%');
    });

    await step('Act: Step 3 — In the API client set R_B9 and R_B10 to INACTIVE', async () => {
      off = [
        ...(await setRowStatus(contractsApi, approverContractsApi, s.family.contracts.ANNEX1, s.family.rows.R_B9, 'INACTIVE', `[T079-${s.run}-97] R_B9 off`)),
        ...(await setRowStatus(contractsApi, approverContractsApi, s.family.contracts.ROOT, s.family.rows.R_B10, 'INACTIVE', `[T079-${s.run}-97] R_B10 off`)),
      ];
    });

    await step('Assert: Expected 3 — Both calls succeed; R_B9 and R_B10 are INACTIVE', async () => {
      for (const st of off) expect(st, '[Expected 3] The status call succeeds').toBeLessThan(300);
      expect(await statusOf('ANNEX1', 'R_B9'), '[Expected 3] R_B9 INACTIVE').toBe('INACTIVE');
      expect(await statusOf('ROOT', 'R_B10'), '[Expected 3] R_B10 INACTIVE').toBe('INACTIVE');
    });

    await step('Act: Step 4 — Back in the dialog click 저장 (Save)', async () => {
      const response = await list.correct.save();
      saved = { status: response.status(), body: await response.text() };
    });

    await step('Assert: Expected 4 — Refused with STL-1017 and its message; no hand-keyed rate field appears', async () => {
      expect(saved.status, '[Expected 4] The save is refused').toBeGreaterThanOrEqual(400);
      expect(saved.body, '[Expected 4] Error code STL-1017').toContain('STL-1017');
      await expect(list.correct.message(FR_KO['errCode.categoryNotPriced']), '[Expected 4] Message 계약이 이 카테고리에 요율을 더 이상 매기지 않습니다. …').toBeVisible();
      await expect(list.correct.tier2Input, '[Expected 4] No hand-keyed rate field appears').toHaveCount(0);
    });

    await step('Act: Step 5 — Count the open fee_correction rows of P14', async () => {
      const [r] = await db('SELECT COUNT(*) AS n FROM fee_correction WHERE product_id = ? AND discarded_at IS NULL', [pid]);
      count = Number(r.n);
    });

    await step('Assert: Expected 5 — Count = 0 — no correction was created', async () => {
      expect(count, '[Expected 5] Count = 0').toBe(0);
    });

    await step('Act: Step 6 — Click 취소 (Cancel), click 수정 (Correct) on the same row again and open the Tier 1 list', async () => {
      await list.correct.cancel();
      await list.openCorrect(list.row(pid));
      reopened = (await list.correct.optionTexts()).filter((t) => t !== FR_KO['fix.noChange']);
    });

    await step('Assert: Expected 6 — The reopened list no longer offers B (only A, C, E)', async () => {
      const n = s.master.categoryName;
      expect(reopened.filter((t) => t === n.B || t.startsWith(`${n.B} (`)), '[Expected 6] B is no longer offered').toEqual([]);
      expect(reopened.some((t) => t.startsWith(`${n.A} (`)), '[Expected 6] A is offered').toBe(true);
      expect(reopened.some((t) => t.startsWith(`${n.C} (`)), '[Expected 6] C is offered').toBe(true);
      expect(reopened.some((t) => t.startsWith(`${n.E} (`)), '[Expected 6] E is offered').toBe(true);
      expect(reopened.length, '[Expected 6] Only A, C, E').toBe(3);
    });

    await step('Act: Step 7 — Set R_B9 and R_B10 back to ACTIVE', async () => {
      await list.correct.cancel();
      on = [
        ...(await setRowStatus(contractsApi, approverContractsApi, s.family.contracts.ANNEX1, s.family.rows.R_B9, 'ACTIVE', `[T079-${s.run}-97] R_B9 on`)),
        ...(await setRowStatus(contractsApi, approverContractsApi, s.family.contracts.ROOT, s.family.rows.R_B10, 'ACTIVE', `[T079-${s.run}-97] R_B10 on`)),
      ];
    });

    await step('Assert: Expected 7 — Both rows are ACTIVE again', async () => {
      for (const st of on) expect(st, '[Expected 7] The status call succeeds').toBeLessThan(300);
      expect(await statusOf('ANNEX1', 'R_B9'), '[Expected 7] R_B9 ACTIVE').toBe('ACTIVE');
      expect(await statusOf('ROOT', 'R_B10'), '[Expected 7] R_B10 ACTIVE').toBe('ACTIVE');
    });
  });

  test('TC_US079_99 — A correction never changes the contract or commerce data', async ({ page, feeReviewPage: list, feeReviewApi, approverFeeReviewApi, contractsApi, seedData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_99', 'High', TAGS, `The 7 fee rows of ROOT / ANNEX1 / ANNEX2 and the fixture product row of P14 are read before and after a full correction cycle on P14 (A → B saved, submitted from the list, approved by user B): the row ends at B 9.00% 승인됨 — 적용 / 불일치 counted under 원천 수정 필요, while the contract rows and the commerce product row are unchanged. ${DEV_CYCLE} ${DEV_SHARED} ${CLEAN}`);
    let s!: Awaited<ReturnType<typeof seedData>>;
    let pid = '';
    let cycleId = 0;
    let row!: Locator;
    type Snap = Record<string, Array<Pick<FeeRow, 'id' | 'categoryId' | 'saleTypeId' | 'policy' | 'commission' | 'status' | 'effectiveFrom'>>>;
    let before: Snap = {};
    let after: Snap = {};
    let productBefore: RowDataPacket[] = [];
    let productAfter: RowDataPacket[] = [];
    let saved!: Response;
    let approved = 0;
    const snapshot = async (): Promise<Snap> => {
      const out: Snap = {};
      for (const key of ['ROOT', 'ANNEX1', 'ANNEX2']) {
        out[key] = (await contractsApi.feeRows(s.family.contracts[key]))
          .map((r) => ({ id: r.id, categoryId: r.categoryId, saleTypeId: r.saleTypeId, policy: r.policy, commission: r.commission, status: r.status, effectiveFrom: r.effectiveFrom }))
          .sort((a, b) => a.id - b.id);
      }
      return out;
    };
    const readProduct = () => db('SELECT * FROM fee_review_fixture_product WHERE product_id = ?', [pid]);

    await step('Arrange: Pre-condition 1–13 — Full family, cycle CY_MAIN, product P14 (A, assigned R_A) resolved at 12.50%', async () => {
      s = await seedData({ tc: 99, contracts: fullFamily(), cycles: ['CY_MAIN'], products: [product('P14', main(234))] });
      pid = s.products.P14;
      cycleId = s.cycles.CY_MAIN.id;
    });

    await step('Act: Step 1 — Read the fee rows of C_ROOT, C_ANNEX1 and C_ANNEX2', async () => {
      before = await snapshot();
    });

    await step('Assert: Expected 1 — 7 rows, all ACTIVE, with the rates the contracts were created with', async () => {
      const all = Object.values(before).flat();
      expect(all.length, '[Expected 1] 7 rows').toBe(7);
      const want: Array<[string, string, number]> = [['ROOT', 'R_A', 12.5], ['ROOT', 'R_B10', 10], ['ROOT', 'R_PROMO', 9.5], ['ROOT', 'R_E11', 11], ['ANNEX1', 'R_B9', 9], ['ANNEX1', 'R_C20', 20], ['ANNEX2', 'R_C22', 22]];
      for (const [key, label, rate] of want) {
        const r = before[key].find((x) => x.id === s.family.rows[label]);
        expect(num(r?.commission), `[Expected 1] ${key}: ${label} ${rate.toFixed(2)}`).toBe(rate);
        expect(r?.status, `[Expected 1] ${key}: ${label} ACTIVE`).toBe('ACTIVE');
      }
    });

    await step('Act: Step 2 — Read the fixture product row of P14', async () => {
      productBefore = await readProduct();
    });

    await step('Assert: Expected 2 — category_id = CAT_A · default_slot_fee_row_id = R_A', async () => {
      expect(num(productBefore[0]?.category_id), '[Expected 2] category_id = CAT_A').toBe(s.master.category.A);
      expect(num(productBefore[0]?.default_slot_fee_row_id), '[Expected 2] default_slot_fee_row_id = R_A').toBe(s.family.rows.R_A);
    });

    await step('Act: Step 3 — On CY_MAIN click 수정 (Correct) on P14, select B, type the reason and click 저장 (Save)', async () => {
      row = await showRow(list, cycleId, pid);
      await list.openCorrect(row);
      await list.correct.pickCategory(s.master.categoryName.B);
      await list.correct.reasonInput.fill(reasonOf('TC_US079_99', 'Wrong category mapped in commerce'));
      saved = await list.correct.save();
    });

    await step('Assert: Expected 3 — The draft toast shows', async () => {
      expect(saved.status(), '[Expected 3] The save request succeeds (201)').toBe(201);
      await expect(list.toast(FR_KO['fix.savedDraft']), '[Expected 3] Toast 승인 요청으로 상신되었습니다. 요율이 변경됩니다.').toBeVisible();
    });

    await step('Act: Step 4 — Tick the P14 row and click 선택 일괄 상신 (Submit selected)', async () => {
      await list.search(pid);
      await list.rowCheckbox(row).check();
      expect((await list.submitSelected()).status(), 'The submit request succeeds').toBeLessThan(300);
      await list.search(pid);
    });

    await step('Assert: Expected 4 — The row pill changes to 승인 대기', async () => {
      await expect(list.statusPills(row).nth(1), '[Expected 4] Pill 승인 대기 (Awaiting approval)').toHaveText(FR_KO['state.PENDING']);
    });

    await step('Act: Step 5 — As user B approve the Fee Rule record of P14', async () => {
      const [c] = await db('SELECT change_approval_id FROM fee_correction WHERE product_id = ? AND discarded_at IS NULL', [pid]);
      expect(c?.change_approval_id, 'The Fee Rule record of P14 exists').toBeTruthy();
      approved = (await approverFeeReviewApi.approve(Number(c.change_approval_id))).status;
    });

    await step('Assert: Expected 5 — Approve returns 200', async () => {
      expect(approved, '[Expected 5] Approve returns 200').toBe(200);
    });

    await step('Act: Step 6 — Search the P14 product id on the list', async () => {
      await list.search(pid);
    });

    await step('Assert: Expected 6 — B 9.00%, 승인됨 — 적용, 불일치, counted under 원천 수정 필요', async () => {
      await expect(list.cell(row, 'category'), '[Expected 6] Category B').toHaveText(s.master.categoryName.B);
      await expect(list.cell(row, 'rate'), '[Expected 6] Rate 9.00%').toHaveText('9.00%');
      await expect(list.statusPills(row).nth(1), '[Expected 6] Pill 승인됨 — 적용 (Approved — applied)').toHaveText(FR_KO['state.APPROVED']);
      await expect(list.cell(row, 'compare'), '[Expected 6] 지정 대조 불일치 (Mismatch)').toHaveText(FR_KO['compare.MISMATCH']);
      expect((await feeReviewApi.row(cycleId, pid)).problems, '[Expected 6] Counted under 원천 수정 필요 (Source needs fixing)').toContain('SOURCE_NEEDS_FIXING');
    });

    await step('Act: Step 7 — Repeat the three fee-row reads of step 1', async () => {
      after = await snapshot();
    });

    await step('Assert: Expected 7 — Identical to step 1: no fee row added, changed or deactivated; R_A still 12.50 ACTIVE', async () => {
      for (const key of ['ROOT', 'ANNEX1', 'ANNEX2']) expect(after[key], `[Expected 7] ${key} fee rows are identical to step 1`).toEqual(before[key]);
      const ra = after.ROOT.find((x) => x.id === s.family.rows.R_A);
      expect(num(ra?.commission), '[Expected 7] R_A still 12.50').toBe(12.5);
      expect(ra?.status, '[Expected 7] R_A still ACTIVE').toBe('ACTIVE');
    });

    await step('Act: Step 8 — Repeat the fixture product read of step 2', async () => {
      productAfter = await readProduct();
    });

    await step('Assert: Expected 8 — Identical to step 2: category A, default slot R_A', async () => {
      expect(productAfter, '[Expected 8] The product row is identical to step 2').toEqual(productBefore);
      expect(num(productAfter[0]?.category_id), '[Expected 8] category_id still A').toBe(s.master.category.A);
      expect(num(productAfter[0]?.default_slot_fee_row_id), '[Expected 8] default_slot_fee_row_id still R_A').toBe(s.family.rows.R_A);
    });
  });

  test('TC_US079_100 — Correct on a closed cycle is disabled and the server refuses it', async ({ page, feeReviewPage: list, feeReviewApi, seedData }) => {
    const step = makeStep(page);
    const ext = new CorrectV1Page(page, list);
    await tcMeta('TC_US079_100', 'Medium', TAGS, `On the closed cycle CY_CLOSE the list still loads P03; 수정 is disabled, looks disabled (reduced opacity, not-allowed cursor) and carries the tooltip 마감된 기간은 수정할 수 없습니다; a direct POST corrections returns 409 STL-1010 with the closed-period message; correction-options returns correctable = false / CYCLE_CLOSED; no correction exists in the cycle. Not automated: the "muted fill" of the disabled button (colour only). ${DEV_CYCLE} ${DEV_PRIVATE} ${CLEAN}`);
    let s!: Awaited<ReturnType<typeof seedData>>;
    let pid = '';
    let cycleId = 0;
    let row!: Locator;
    let refused = { status: 0, body: undefined as unknown };
    let api!: Awaited<ReturnType<typeof optionsWithStatus>>;
    let count = -1;

    await step('Arrange: Pre-condition 1–11 — ROOT (R_A 12.50 · R_B10 10.00), closed cycle CY_CLOSE, product P03 (B, assigned R_B10)', async () => {
      s = await seedData({ tc: 100, private: true, contracts: family({ ROOT: ['R_A', 'R_B10'] }), cycles: ['CY_CLOSE'], products: [product('P03', [{ cycle: 'CY_CLOSE', saleLines: 10 }])], close: ['CY_CLOSE'] });
      pid = s.products.P03;
      cycleId = s.cycles.CY_CLOSE.id;
      expect((await feeReviewApi.cycle(cycleId)).body?.status, 'Pre-condition 9 — CY_CLOSE is CLOSED').toBe('CLOSED');
    });

    await step('Act: Step 1 — Open Settlement fee review, select CY_CLOSE and click 검색 (Search)', async () => {
      await list.open({ cycleId, bucket: 'ALL' });
      await list.search('');
      row = list.row(pid);
    });

    await step('Assert: Expected 1 — The list loads with the P03 row', async () => {
      await expect(row, '[Expected 1] The P03 row is listed on the closed cycle').toBeVisible();
    });

    await step('Act: Step 2 — Hover 수정 (Correct) on the P03 / NORMAL row', async () => {
      await ext.hoverCorrect(row);
    });

    await step('Assert: Expected 2 — 수정 is disabled and looks disabled; tooltip 마감된 기간은 수정할 수 없습니다', async () => {
      const button = list.rowButton(row, 'btn.correct');
      await expect(button, '[Expected 2] 수정 (Correct) is disabled').toBeDisabled();
      expect(Number(await ext.cssValue(button, 'opacity')), '[Expected 2] Reduced opacity').toBeLessThan(1);
      expect([await ext.cssValue(button, 'cursor'), await ext.cssValue(list.correctWrapper(row), 'cursor')], '[Expected 2] Not-allowed cursor').toContain('not-allowed');
      await expect(list.correctWrapper(row), '[Expected 2] Tooltip 마감된 기간은 수정할 수 없습니다').toHaveAttribute('title', FR_KO['msg.correctDisabledClosed']);
    });

    await step('Act: Step 3 — Call POST corrections on CY_CLOSE for P03 (ASSIGNMENT, CAT_A)', async () => {
      refused = await feeReviewApi.save(cycleId, pid, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.A, reason: reasonOf('TC_US079_100', 'Closed period check') });
    });

    await step('Assert: Expected 3 — HTTP 409, STL-1010 with the closed-period message', async () => {
      expectRefused(refused, 409, 'STL-1010', FR_KO['errCode.closedCycle'], FR_EN['errCode.closedCycle'], '[Expected 3]');
    });

    await step('Act: Step 4 — Call GET correction-options on CY_CLOSE for P03', async () => {
      api = await optionsWithStatus(feeReviewApi, cycleId, pid);
    });

    await step('Assert: Expected 4 — 200, correctable = false, notCorrectableReason = CYCLE_CLOSED', async () => {
      expect(api.status, '[Expected 4] HTTP 200').toBe(200);
      expect(api.body.correctable, '[Expected 4] correctable = false').toBe(false);
      expect(api.body.notCorrectableReason, '[Expected 4] notCorrectableReason = CYCLE_CLOSED').toBe('CYCLE_CLOSED');
    });

    await step('Act: Step 5 — Count fee_correction rows of CY_CLOSE', async () => {
      const [r] = await db('SELECT COUNT(*) AS n FROM fee_correction WHERE settlement_cycle_id = ?', [cycleId]);
      count = Number(r.n);
    });

    await step('Assert: Expected 5 — Count = 0', async () => {
      expect(count, '[Expected 5] Count = 0').toBe(0);
    });
  });

  test('TC_US079_101 — Correct on a row with a pending correction is disabled and the server refuses it', async ({ page, feeReviewPage: list, feeReviewApi, seedData }) => {
    const step = makeStep(page);
    const ext = new CorrectV1Page(page, list);
    await tcMeta('TC_US079_101', 'Medium', TAGS, `P14 carries a submitted correction X (A → B 9.00%, PENDING): the row shows 승인 대기 with 12.50% in force and 9.00% proposed; 수정 is disabled with the tooltip 승인 대기 중입니다 — 먼저 회수한 뒤에 수정하세요.; direct saves with and without correctionId return 409 STL-1011; correction-options returns PENDING_CORRECTION; X is untouched. Deviation: the duplicate-pending query is scoped to this TC's products (other testers' rows on the shared database are out of scope). Not automated: the "muted fill" of the disabled button (colour only). ${DEV_CYCLE} ${DEV_SHARED} ${CLEAN}`);
    let s!: Awaited<ReturnType<typeof seedData>>;
    let pid = '';
    let cycleId = 0;
    let row!: Locator;
    let x = '';
    let version = -1;
    let second = { status: 0, body: undefined as unknown };
    let withId = { status: 0, body: undefined as unknown };
    let api!: Awaited<ReturnType<typeof optionsWithStatus>>;
    let xRow: RowDataPacket[] = [];
    let duplicates: RowDataPacket[] = [];

    await step('Arrange: Pre-condition 1–14 — ROOT (R_A · R_E11) + ANNEX1 (R_B9), cycle CY_MAIN, P14 with correction X (A → B) submitted and PENDING', async () => {
      s = await seedData({ tc: 101, contracts: family({ ROOT: ['R_A', 'R_E11'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P14', main(234))] });
      pid = s.products.P14;
      cycleId = s.cycles.CY_MAIN.id;
      x = await saveDraft(feeReviewApi, cycleId, pid, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.B, reason: reasonOf('TC_US079_101', 'Wrong category mapped in commerce') });
      await submitDraft(feeReviewApi, x);
      expect((await feeReviewApi.row(cycleId, pid)).correction?.state, 'Pre-condition 12 — X is PENDING').toBe('PENDING');
      const [v] = await db('SELECT version FROM fee_correction WHERE id = ?', [x]);
      version = Number(v?.version);
    });

    await step('Act: Step 1 — Open the list on CY_MAIN and search P14', async () => {
      row = await showRow(list, cycleId, pid);
    });

    await step('Assert: Expected 1 — Pill 승인 대기, 12.50% in force with 9.00% proposed beside it', async () => {
      await expect(list.statusPills(row).nth(1), '[Expected 1] Pill 승인 대기 (Awaiting approval)').toHaveText(FR_KO['state.PENDING']);
      expect(await ext.mainText(list.cell(row, 'rate')), '[Expected 1] In force 12.50%').toBe('12.50%');
      await expect(list.secondLine(list.cell(row, 'rate')), '[Expected 1] Proposed 9.00% beside it').toContainText('9.00%');
    });

    await step('Act: Step 2 — Hover 수정 (Correct) on the P14 / NORMAL row', async () => {
      await ext.hoverCorrect(row);
    });

    await step('Assert: Expected 2 — 수정 is disabled and looks disabled; tooltip 승인 대기 중입니다 — 먼저 회수한 뒤에 수정하세요.', async () => {
      const button = list.rowButton(row, 'btn.correct');
      await expect(button, '[Expected 2] 수정 (Correct) is disabled').toBeDisabled();
      expect(Number(await ext.cssValue(button, 'opacity')), '[Expected 2] Looks disabled (reduced opacity)').toBeLessThan(1);
      await expect(list.correctWrapper(row), '[Expected 2] Tooltip 승인 대기 중입니다 — 먼저 회수한 뒤에 수정하세요.').toHaveAttribute('title', FR_KO['msg.correctDisabledPending']);
    });

    await step('Act: Step 3 — Call POST corrections for P14 (ASSIGNMENT, CAT_E) without correctionId', async () => {
      second = await feeReviewApi.save(cycleId, pid, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.E, reason: reasonOf('TC_US079_101', 'Second correction while pending') });
    });

    await step('Assert: Expected 3 — HTTP 409, STL-1011 with the pending message', async () => {
      expectRefused(second, 409, 'STL-1011', FR_KO['errCode.pendingExists'], FR_EN['errCode.pendingExists'], '[Expected 3]');
    });

    await step('Act: Step 4 — Same call with correctionId = X', async () => {
      withId = await feeReviewApi.save(cycleId, pid, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.E, reason: reasonOf('TC_US079_101', 'Second correction while pending'), correctionId: x });
    });

    await step('Assert: Expected 4 — HTTP 409, STL-1011, same message', async () => {
      expectRefused(withId, 409, 'STL-1011', FR_KO['errCode.pendingExists'], FR_EN['errCode.pendingExists'], '[Expected 4]');
    });

    await step('Act: Step 5 — Call GET correction-options for P14', async () => {
      api = await optionsWithStatus(feeReviewApi, cycleId, pid);
    });

    await step('Assert: Expected 5 — 200, correctable = false, notCorrectableReason = PENDING_CORRECTION', async () => {
      expect(api.status, '[Expected 5] HTTP 200').toBe(200);
      expect(api.body.correctable, '[Expected 5] correctable = false').toBe(false);
      expect(api.body.notCorrectableReason, '[Expected 5] notCorrectableReason = PENDING_CORRECTION').toBe('PENDING_CORRECTION');
    });

    await step('Act: Step 6 — Read X and look for keys holding more than one PENDING correction', async () => {
      xRow = await db('SELECT state, category_id, rate_after, version FROM fee_correction WHERE id = ?', [x]);
      duplicates = await db("SELECT settlement_cycle_id, product_id, policy, COUNT(*) AS n FROM fee_correction WHERE state = 'PENDING' AND product_id LIKE ? GROUP BY 1,2,3 HAVING COUNT(*) > 1", [`${s.prefix}%`]);
    });

    await step('Assert: Expected 6 — X untouched (PENDING · CAT_B · 9.0000 · version unchanged); no duplicate pending key', async () => {
      const c = xRow[0] ?? {};
      expect(c.state, '[Expected 6] state = PENDING').toBe('PENDING');
      expect(num(c.category_id), '[Expected 6] category_id = CAT_B').toBe(s.master.category.B);
      expect(num(c.rate_after), '[Expected 6] rate_after = 9.0000').toBe(9);
      expect(num(c.version), '[Expected 6] version unchanged').toBe(version);
      expect(duplicates.length, '[Expected 6] The duplicate-pending query returns 0 rows').toBe(0);
    });
  });

  test('TC_US079_102 — Correct on a draft or rejected row opens that correction and Save updates it', async ({ page, feeReviewPage: list, feeReviewApi, approverFeeReviewApi, seedData }) => {
    const step = makeStep(page);
    const reasonX = reasonOf('TC_US079_102', 'Wrong category mapped in commerce');
    const reasonY = reasonOf('TC_US079_102', '카테고리 오매핑 정정');
    const reasonY2 = reasonOf('TC_US079_102', '반려 사유 반영하여 재수정');
    await tcMeta('TC_US079_102', 'High', TAGS, `Draft X (P14 A → B) and rejected Y (P03 B → A) are reopened: the dialog pre-selects their category, pre-fills their reason and offers 수정 버리기; saving E updates the same correction (same id, E 9.50%, version + 1 / new reason). Expected to fail (TC build note): the screen pre-fills only the tier-2 rate — category and reason open empty. The pre-condition reasons carry a traceable [AUTO-US079] prefix. ${DEV_CYCLE} ${DEV_SHARED} ${CLEAN}`);
    let s!: Awaited<ReturnType<typeof seedData>>;
    let cycleId = 0;
    let x = '';
    let y = '';
    let versionX = -1;
    let savedX!: Response;
    let savedY!: Response;
    let rowsX: RowDataPacket[] = [];
    let rowsY: RowDataPacket[] = [];

    await step('Arrange: Pre-condition 1–16 — ROOT (R_A/R_B10/R_PROMO/R_E11) + ANNEX1 (R_B9), cycle CY_MAIN, draft X on P14 (B) and rejected Y on P03 (A)', async () => {
      s = await seedData({ tc: 102, contracts: family({ ROOT: ['R_A', 'R_B10', 'R_PROMO', 'R_E11'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P14', main(234)), product('P03', main(97))] });
      cycleId = s.cycles.CY_MAIN.id;
      x = await saveDraft(feeReviewApi, cycleId, s.products.P14, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.B, reason: reasonX });
      y = await saveDraft(feeReviewApi, cycleId, s.products.P03, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.A, reason: reasonY });
      const caY = await submitDraft(feeReviewApi, y);
      expect((await approverFeeReviewApi.reject(caY, `[T079-${s.run}-102] sai category`)).status, 'Pre-condition 13 — Reject CA_Y returns 200').toBe(200);
      expect((await feeReviewApi.row(cycleId, s.products.P03)).correction?.state, 'Pre-condition 14 — Y is REJECTED').toBe('REJECTED');
      const [v] = await db('SELECT version FROM fee_correction WHERE id = ?', [x]);
      versionX = Number(v?.version);
    });

    await step('Act: Step 1 — Search P14 and click 수정 (Correct) on P14 / NORMAL', async () => {
      await list.openCorrect(await showRow(list, cycleId, s.products.P14));
    });

    await step('Assert: Expected 1 — Correction X opens: Tier 1 pre-selected on B, reason pre-filled, 수정 버리기 shown', async () => {
      const ext = new CorrectV1Page(page, list);
      await expect.soft(ext.checkedOption, '[Expected 1] Tier 1 is pre-selected on B').toHaveText(new RegExp(`^${esc(s.master.categoryName.B)}( \\(|$)`));
      await expect.soft(list.correct.reasonInput, '[Expected 1] Reason is pre-filled with the draft reason').toHaveValue(reasonX);
      await expect.soft(list.correct.discardButton, '[Expected 1] 수정 버리기 (원래대로) (Discard correction) is shown').toBeVisible();
    });

    await step('Act: Step 2 — Change Tier 1 to category E and click 저장 (Save)', async () => {
      await list.correct.pickCategory(s.master.categoryName.E);
      savedX = await list.correct.save();
    });

    await step('Assert: Expected 2 — The draft toast shows; the row shows proposed E 9.50%', async () => {
      expect(savedX.status(), '[Expected 2] The save request succeeds').toBeLessThan(300);
      await expect(list.toast(FR_KO['fix.savedDraft']), '[Expected 2] Toast 승인 요청으로 상신되었습니다. 요율이 변경됩니다.').toBeVisible();
      await list.search(s.products.P14);
      const row = list.row(s.products.P14);
      await expect(list.secondLine(list.cell(row, 'category')), '[Expected 2] Proposed category E').toContainText(s.master.categoryName.E);
      await expect(list.secondLine(list.cell(row, 'rate')), '[Expected 2] Proposed rate 9.50%').toContainText('9.50%');
    });

    await step('Act: Step 3 — Read the open fee_correction of P14', async () => {
      rowsX = await db('SELECT id, category_id, rate_after, version FROM fee_correction WHERE product_id = ? AND discarded_at IS NULL', [s.products.P14]);
    });

    await step('Assert: Expected 3 — Exactly one row: id = X · CAT_E · 9.5000 · version + 1', async () => {
      expect(rowsX.length, '[Expected 3] Exactly one row').toBe(1);
      expect(String(rowsX[0]?.id), '[Expected 3] id = X').toBe(x);
      expect(num(rowsX[0]?.category_id), '[Expected 3] category_id = CAT_E').toBe(s.master.category.E);
      expect(num(rowsX[0]?.rate_after), '[Expected 3] rate_after = 9.5000').toBe(9.5);
      expect(num(rowsX[0]?.version), '[Expected 3] version increased by 1').toBe(versionX + 1);
    });

    await step('Act: Step 4 — Search P03 and click 수정 (Correct) on P03 / NORMAL', async () => {
      await list.search(s.products.P03);
      await list.openCorrect(list.row(s.products.P03));
    });

    await step('Assert: Expected 4 — Correction Y opens: Tier 1 pre-selected on A, reason pre-filled', async () => {
      const ext = new CorrectV1Page(page, list);
      await expect.soft(ext.checkedOption, '[Expected 4] Tier 1 is pre-selected on A').toHaveText(new RegExp(`^${esc(s.master.categoryName.A)}( \\(|$)`));
      await expect.soft(list.correct.reasonInput, '[Expected 4] Reason is pre-filled with the rejected reason').toHaveValue(reasonY);
    });

    await step('Act: Step 5 — Change the category to E, replace the reason and click 저장 (Save)', async () => {
      await list.correct.pickCategory(s.master.categoryName.E);
      await list.correct.reasonInput.fill(reasonY2);
      savedY = await list.correct.save();
    });

    await step('Assert: Expected 5 — The draft toast shows', async () => {
      expect(savedY.status(), '[Expected 5] The save request succeeds').toBeLessThan(300);
      await expect(list.toast(FR_KO['fix.savedDraft']), '[Expected 5] Toast 승인 요청으로 상신되었습니다. 요율이 변경됩니다.').toBeVisible();
    });

    await step('Act: Step 6 — Read the open fee_correction of P03', async () => {
      rowsY = await db('SELECT id, category_id, rate_after, reason FROM fee_correction WHERE product_id = ? AND discarded_at IS NULL', [s.products.P03]);
    });

    await step('Assert: Expected 6 — Exactly one row: id = Y · CAT_E · 9.5000 · the new reason', async () => {
      expect(rowsY.length, '[Expected 6] Exactly one row').toBe(1);
      expect(String(rowsY[0]?.id), '[Expected 6] id = Y').toBe(y);
      expect(num(rowsY[0]?.category_id), '[Expected 6] category_id = CAT_E').toBe(s.master.category.E);
      expect(num(rowsY[0]?.rate_after), '[Expected 6] rate_after = 9.5000').toBe(9.5);
      expect(rowsY[0]?.reason, '[Expected 6] reason = the new reason').toBe(reasonY2);
    });
  });

  test('TC_US079_104 — A not-computable product cannot be corrected', async ({ page, feeReviewPage: list, feeReviewApi, seedData }) => {
    const step = makeStep(page);
    const ext = new CorrectV1Page(page, list);
    await tcMeta('TC_US079_104', 'Medium', TAGS, `P21's only row is a MARGIN (bracket) row on CT3: the row reads 구간형 요율 — 산정 전 with no rate in bucket 구간형 요율 — 산정 전; 수정 is disabled with the bracket tooltip; direct ASSIGNMENT and RATE_OVERRIDE saves return 409 STL-1019 with the TC sentence 화면을 불러온 뒤 …; correction-options returns NOT_COMPUTABLE; no correction is created. Not automated: the "muted fill" of the disabled button (colour only). ${DEV_CYCLE} ${DEV_SHARED} ${CLEAN}`);
    let s!: Awaited<ReturnType<typeof seedData>>;
    let pid = '';
    let cycleId = 0;
    let row!: Locator;
    let assign = { status: 0, body: undefined as unknown };
    let typed = { status: 0, body: undefined as unknown };
    let api!: Awaited<ReturnType<typeof optionsWithStatus>>;
    let count = -1;

    await step('Arrange: Pre-condition 1–11 — Contract CT3 (one A × ST1 MARGIN 30 row), cycle CY_MAIN, product P21', async () => {
      s = await seedData({ tc: 104, contracts: family({ CT3: ['R_MARGIN'] }), cycles: ['CY_MAIN'], products: [product('P21', main(1))] });
      pid = s.products.P21;
      cycleId = s.cycles.CY_MAIN.id;
    });

    await step('Act: Step 1 — Open the list on CY_MAIN and search P21', async () => {
      row = await showRow(list, cycleId, pid);
    });

    await step('Assert: Expected 1 — Status 구간형 요율 — 산정 전 with no rate, counted under 구간형 요율 — 산정 전', async () => {
      await expect(list.cell(row, 'status'), '[Expected 1] Status 구간형 요율 — 산정 전 (Not computable)').toContainText(FR_KO['status.NOT_COMPUTABLE']);
      await expect(list.cell(row, 'rate'), '[Expected 1] No rate').not.toContainText('%');
      expect((await feeReviewApi.row(cycleId, pid)).bucket, '[Expected 1] Counted under bucket 구간형 요율 — 산정 전 (Not computable yet)').toBe('NOT_COMPUTABLE');
    });

    await step('Act: Step 2 — Hover 수정 (Correct) on the P21 / NORMAL row', async () => {
      await ext.hoverCorrect(row);
    });

    await step('Assert: Expected 2 — 수정 is disabled and looks disabled; bracket tooltip', async () => {
      const button = list.rowButton(row, 'btn.correct');
      await expect(button, '[Expected 2] 수정 (Correct) is disabled').toBeDisabled();
      expect(Number(await ext.cssValue(button, 'opacity')), '[Expected 2] Looks disabled (reduced opacity)').toBeLessThan(1);
      await expect(list.correctWrapper(row), '[Expected 2] Tooltip 구간형 요율이라 이 화면에서는 산정할 수 없습니다 — …').toHaveAttribute('title', FR_KO['msg.correctDisabledBracket']);
    });

    await step('Act: Step 3 — Call POST corrections for P21 (ASSIGNMENT, CAT_B)', async () => {
      assign = await feeReviewApi.save(cycleId, pid, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.B, reason: reasonOf('TC_US079_104', 'Bracket rate check') });
    });

    await step('Assert: Expected 3 — HTTP 409, STL-1019 with the TC sentence', async () => {
      expectRefused(assign, 409, 'STL-1019', FR_TC.staleStateKo, FR_TC.staleStateEn, '[Expected 3]');
    });

    await step('Act: Step 4 — Same call with RATE_OVERRIDE 5.00', async () => {
      typed = await feeReviewApi.save(cycleId, pid, { policy: 'NORMAL', tier: 'RATE_OVERRIDE', overrideRate: '5.00', reason: reasonOf('TC_US079_104', 'Bracket rate check') });
    });

    await step('Assert: Expected 4 — HTTP 409, STL-1019, same message', async () => {
      expectRefused(typed, 409, 'STL-1019', FR_TC.staleStateKo, FR_TC.staleStateEn, '[Expected 4]');
    });

    await step('Act: Step 5 — Call GET correction-options for P21', async () => {
      api = await optionsWithStatus(feeReviewApi, cycleId, pid);
    });

    await step('Assert: Expected 5 — 200, correctable = false, notCorrectableReason = NOT_COMPUTABLE', async () => {
      expect(api.status, '[Expected 5] HTTP 200').toBe(200);
      expect(api.body.correctable, '[Expected 5] correctable = false').toBe(false);
      expect(api.body.notCorrectableReason, '[Expected 5] notCorrectableReason = NOT_COMPUTABLE').toBe('NOT_COMPUTABLE');
    });

    await step('Act: Step 6 — Count fee_correction rows of P21', async () => {
      const [r] = await db('SELECT COUNT(*) AS n FROM fee_correction WHERE product_id = ?', [pid]);
      count = Number(r.n);
    });

    await step('Assert: Expected 6 — Count = 0', async () => {
      expect(count, '[Expected 6] Count = 0').toBe(0);
    });
  });

  test('TC_US079_107 — A fee category removed from the master is refused and the list reloads', async ({ page, feeReviewPage: list, feeReviewApi, contractsApi, seedData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_107', 'Medium', TAGS, `With the dialog open on P14 (offering A, B, C tied, E), a save with commissionCategoryId 999999 (a category that does not exist — a master removal cannot be produced on dev, as the TC states) returns 404 CNT-1001 with the SRS sentence 해당 수수료 카테고리가 존재하지 않습니다. …; no correction is created; the reopened list still offers only the family's master categories and not 999999. Expected to fail (TC build note): the server message is diagnostic ("commission category not found: id=999999"). ${DEV_CYCLE} ${DEV_SHARED} ${CLEAN}`);
    let s!: Awaited<ReturnType<typeof seedData>>;
    let pid = '';
    let cycleId = 0;
    let first: string[] = [];
    let refused = { status: 0, body: undefined as unknown };
    let count = -1;
    let reopened: string[] = [];

    await step('Arrange: Pre-condition 1–14 — Full family, cycle CY_MAIN, product P14 (A, assigned R_A); no master category has id 999999', async () => {
      s = await seedData({ tc: 107, contracts: fullFamily(), cycles: ['CY_MAIN'], products: [product('P14', main(234))] });
      pid = s.products.P14;
      cycleId = s.cycles.CY_MAIN.id;
      expect((await contractsApi.values()).body.categories.some((c) => c.id === 999999), 'Pre-condition 11 — No master category has id 999999').toBe(false);
    });

    await step('Act: Step 1 — Search P14 and click 수정 (Correct) on P14 / NORMAL', async () => {
      await list.openCorrect(await showRow(list, cycleId, pid));
    });

    await step('Assert: Expected 1 — Dialog 수수료 산정 수정 opens', async () => {
      await expect(list.correct.title, '[Expected 1] Dialog opens').toHaveText(FR_KO['fix.title']);
    });

    await step('Act: Step 2 — Open the Tier 1 list', async () => {
      first = (await list.correct.optionTexts()).filter((t) => t !== FR_KO['fix.noChange']);
    });

    await step('Assert: Expected 2 — The list offers A, B, C (tied), E', async () => {
      const n = s.master.categoryName;
      expect(first, '[Expected 2] A').toContain(option(n.A, '12.50'));
      expect(first, '[Expected 2] B').toContain(option(n.B, '9.00'));
      expect(first, '[Expected 2] C (tied)').toContain(option(n.C));
      expect(first, '[Expected 2] E').toContain(option(n.E, '9.50'));
      expect(first.length, '[Expected 2] Exactly these 4').toBe(4);
    });

    await step('Act: Step 3 — Call POST corrections for P14 with commissionCategoryId 999999', async () => {
      refused = await feeReviewApi.save(cycleId, pid, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: 999999, reason: reasonOf('TC_US079_107', 'Category removed check') });
    });

    await step('Assert: Expected 3 — HTTP 404, CNT-1001 with the SRS sentence', async () => {
      expectRefused(refused, 404, 'CNT-1001', FR_KO['errCode.categoryGone'], FR_EN['errCode.categoryGone'], '[Expected 3]');
    });

    await step('Act: Step 4 — Count the open fee_correction rows of P14', async () => {
      const [r] = await db('SELECT COUNT(*) AS n FROM fee_correction WHERE product_id = ? AND discarded_at IS NULL', [pid]);
      count = Number(r.n);
    });

    await step('Assert: Expected 4 — Count = 0 — no correction was created', async () => {
      expect(count, '[Expected 4] Count = 0').toBe(0);
    });

    await step('Act: Step 5 — Click 취소 (Cancel), click 수정 (Correct) on the same row again and open the Tier 1 list', async () => {
      await list.correct.cancel();
      await list.openCorrect(list.row(pid));
      reopened = (await list.correct.optionTexts()).filter((t) => t !== FR_KO['fix.noChange']);
    });

    await step('Assert: Expected 5 — Only the family-priced master categories (A, B, C, E); 999999 is not offered', async () => {
      const n = s.master.categoryName;
      expect(reopened, '[Expected 5] A, B, C (tied), E in catalogue order').toEqual([option(n.A, '12.50'), option(n.B, '9.00'), option(n.C), option(n.E, '9.50')]);
      await expect(list.correct.tier1Select.locator('option[value="999999"]'), '[Expected 5] id 999999 is not offered').toHaveCount(0);
    });
  });

  test('TC_US079_108 — A product with no fee category opens on tier 1 with its family categories', async ({ page, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_108', 'Medium', TAGS, `P05 is seeded with category_id NULL: the row reads 적용 행 없음 with empty category and rate; Why this rate states the missing-category part; the Correct dialog opens on tier 1 (list enabled, Tier 2 locked with the contract-rate line) offering A 12.50%, B 9.00%, C (⚠ 동순위), E 9.50%; the product is then restored to category A. Deviation: the app writes each option as "<category> (12.50%)" where the TC reads "A — 12.50%". ${DEV_CYCLE} ${DEV_SHARED} ${CLEAN}`);
    let s!: Awaited<ReturnType<typeof seedData>>;
    let pid = '';
    let row!: Locator;
    let basisText = '';
    let offered: string[] = [];
    let restored: RowDataPacket[] = [];

    await step('Arrange: Pre-condition 1–13 — Full family, cycle CY_MAIN, product P05 with category_id NULL (contract ROOT, sale type ST1)', async () => {
      s = await seedData({ tc: 108, contracts: fullFamily(), cycles: ['CY_MAIN'], products: [product('P05', main(151), { category: null })] });
      pid = s.products.P05;
    });

    await step('Act: Step 1 — Open the list on CY_MAIN and search P05', async () => {
      row = await showRow(list, s.cycles.CY_MAIN.id, pid);
    });

    await step('Assert: Expected 1 — 적용 행 없음, empty category and empty rate', async () => {
      await expect(list.cell(row, 'status'), '[Expected 1] 적용 행 없음 (No row applies)').toContainText(FR_KO['status.NO_ROW']);
      await expect(list.cell(row, 'category'), '[Expected 1] Empty category').toHaveText(/^\s*(—|-)?\s*$/);
      await expect(list.cell(row, 'rate'), '[Expected 1] Empty rate').not.toContainText('%');
    });

    await step('Act: Step 2 — Click 근거 (Basis) on P05 / NORMAL, read the panel and close it', async () => {
      await list.openBasis(row);
      basisText = await list.basis.root.innerText();
      await list.basis.close();
    });

    await step('Assert: Expected 2 — The panel states the missing fee category part', async () => {
      expect(basisText, '[Expected 2] 찾지 못한 부분: 수수료 카테고리 — 이 상품에는 카테고리가 없어 맞는 수수료 행이 없습니다. 상품명으로 카테고리를 추측하지 않습니다.').toContain(FR_KO['trace.noRowPartCategory']);
    });

    await step('Act: Step 3 — Click 수정 (Correct) on the same row', async () => {
      await list.openCorrect(row);
    });

    await step('Assert: Expected 3 — Opens on tier 1: list enabled; Tier 2 shows the contract-rate text line', async () => {
      await expect(list.correct.title, '[Expected 3] Dialog opens').toHaveText(FR_KO['fix.title']);
      await expect(list.correct.tier1Select, '[Expected 3] Tier 1 list is enabled').toBeEnabled();
      await expect(list.correct.tier2Lock, '[Expected 3] Tier 2 text line 계약에 요율이 있어 직접 입력할 수 없습니다. …').toBeVisible();
    });

    await step('Act: Step 4 — Open the Tier 1 list', async () => {
      offered = (await list.correct.optionTexts()).filter((t) => t !== FR_KO['fix.noChange']);
    });

    await step("Assert: Expected 4 — The family's categories: A 12.50%, B 9.00%, C (⚠ 동순위), E 9.50%", async () => {
      const n = s.master.categoryName;
      expect(offered, '[Expected 4] A — 12.50%').toContain(option(n.A, '12.50'));
      expect(offered, '[Expected 4] B — 9.00%').toContain(option(n.B, '9.00'));
      expect(offered, '[Expected 4] C — (⚠ 동순위)').toContain(option(n.C));
      expect(offered, '[Expected 4] E — 9.50%').toContain(option(n.E, '9.50'));
    });

    await step('Act: Step 5 — Click 취소 (Cancel) and restore P05 to category A', async () => {
      await list.correct.cancel();
      await feeReviewDb.updateProduct(pid, { categoryId: s.master.category.A });
      restored = await db('SELECT category_id FROM fee_review_fixture_product WHERE product_id = ?', [pid]);
    });

    await step('Assert: Expected 5 — P05 is restored to category A', async () => {
      expect(num(restored[0]?.category_id), '[Expected 5] category_id = CAT_A').toBe(s.master.category.A);
    });
  });

  test('TC_US079_109 — A product tied to no contract family shows an empty category list', async ({ page, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_109', 'Medium', TAGS, `P12 has no contract: the row reads 적용 행 없음 with no rate; Why this rate shows 적용 가능한 행 없음 and the missing-contract part; the Correct dialog shows an empty Tier 1 list with 이 상품의 계약 패밀리는 어떤 카테고리도 가격을 매기지 않습니다 and the Tier 2 input with placeholder 예: 4.50%. ${DEV_CYCLE} Data: no contract is created; the product is private to this TC. ${CLEAN}`);
    let s!: Awaited<ReturnType<typeof seedData>>;
    let row!: Locator;
    let basisText = '';

    await step('Arrange: Pre-condition 1–9 — Cycle CY_MAIN and product P12 with contract_id NULL', async () => {
      s = await seedData({ tc: 109, contracts: [], cycles: ['CY_MAIN'], products: [product('P12', main(160))] });
    });

    await step('Act: Step 1 — Open the list on CY_MAIN and search P12', async () => {
      row = await showRow(list, s.cycles.CY_MAIN.id, s.products.P12);
    });

    await step('Assert: Expected 1 — 적용 행 없음 with empty rate', async () => {
      await expect(list.cell(row, 'status'), '[Expected 1] 적용 행 없음 (No row applies)').toContainText(FR_KO['status.NO_ROW']);
      await expect(list.cell(row, 'rate'), '[Expected 1] Empty rate').not.toContainText('%');
    });

    await step('Act: Step 2 — Click 근거 (Basis) on P12 / NORMAL, read the panel and close it', async () => {
      await list.openBasis(row);
      basisText = await list.basis.root.innerText();
      await list.basis.close();
    });

    await step('Assert: Expected 2 — 적용 가능한 행 없음 and the missing-contract part', async () => {
      expect(basisText, '[Expected 2] 적용 가능한 행 없음 (No row applies)').toContain(FR_KO['trace.noRowTitle']);
      expect(basisText, '[Expected 2] 찾지 못한 부분: 계약 — 이 상품은 어떤 계약 패밀리에도 묶여 있지 않아 …').toContain(FR_KO['trace.noRowPartFamily']);
    });

    await step('Act: Step 3 — Click 수정 (Correct) on the same row', async () => {
      await list.openCorrect(row);
    });

    await step('Assert: Expected 3 — The dialog opens; the Tier 1 list is empty and reads the family-empty text', async () => {
      await expect(list.correct.title, '[Expected 3] Dialog opens').toHaveText(FR_KO['fix.title']);
      expect(await list.correct.optionTexts(), '[Expected 3] Tier 1 list is empty and reads 이 상품의 계약 패밀리는 어떤 카테고리도 가격을 매기지 않습니다').toEqual([FR_KO['fix.familyEmpty']]);
    });

    await step('Act: Step 4 — Look at the Tier 2 area', async () => {
      await list.correct.tier2Label.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — The tier 2 rate input is rendered with placeholder 예: 4.50%', async () => {
      await expect(list.correct.tier2Input, '[Expected 4] Tier 2 rate input is rendered').toBeVisible();
      await expect(list.correct.tier2Input, '[Expected 4] Placeholder 예: 4.50%').toHaveAttribute('placeholder', FR_KO['fix.tier2Placeholder']);
    });
  });

  test('TC_US079_110 — Discard returns a draft or rejected correction to the contract result', async ({ page, feeReviewPage: list, feeReviewApi, approverFeeReviewApi, seedData }) => {
    const step = makeStep(page);
    const ext = new CorrectV1Page(page, list);
    await tcMeta('TC_US079_110', 'High', TAGS, `Draft Y (P10 typed 6.75) and rejected Z (P03 B → A) are discarded from the dialog: each shows the discarded toast, the row returns to the contract result (P10 적용 행 없음 in 확인 필요; P03 산정 완료 B 9.00% 불일치) with no correction pill or proposed line, the rows stay in fee_correction with discarded_at set (DRAFT / REJECTED), and the period report keeps P03 as 반려됨 — 수정 후 재상신 with its target value struck through while P10 is absent. ${DEV_CYCLE} ${DEV_SHARED} ${CLEAN}`);
    let s!: Awaited<ReturnType<typeof seedData>>;
    let cycleId = 0;
    let y = '';
    let z = '';
    let discardY!: Response;
    let discardZ!: Response;
    let rowY: RowDataPacket[] = [];
    let rowZ: RowDataPacket[] = [];

    await step('Arrange: Pre-condition 1–16 — ROOT (R_A · R_B10) + ANNEX1 (R_B9), cycle CY_MAIN, draft Y on P10 (typed 6.75), rejected Z on P03 (A)', async () => {
      s = await seedData({ tc: 110, contracts: family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P10', main(86)), product('P03', main(97))] });
      cycleId = s.cycles.CY_MAIN.id;
      y = await saveDraft(feeReviewApi, cycleId, s.products.P10, { policy: 'NORMAL', tier: 'RATE_OVERRIDE', overrideRate: '6.75', reason: reasonOf('TC_US079_110', '유사 계약 요율 적용') });
      z = await saveDraft(feeReviewApi, cycleId, s.products.P03, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.A, reason: reasonOf('TC_US079_110', '카테고리 오매핑 정정') });
      const caZ = await submitDraft(feeReviewApi, z);
      expect((await approverFeeReviewApi.reject(caZ, `[T079-${s.run}-110] sai category`)).status, 'Pre-condition 13 — Reject CA_Z returns 200').toBe(200);
      expect((await feeReviewApi.row(cycleId, s.products.P10)).correction?.state, 'Pre-condition 14 — Y is DRAFT').toBe('DRAFT');
      expect((await feeReviewApi.row(cycleId, s.products.P03)).correction?.state, 'Pre-condition 14 — Z is REJECTED').toBe('REJECTED');
    });

    await step('Act: Step 1 — Search P10 and click 수정 (Correct) on P10 / NORMAL', async () => {
      await list.openCorrect(await showRow(list, cycleId, s.products.P10));
    });

    await step('Assert: Expected 1 — The dialog opens correction Y; 수정 버리기 (원래대로) is shown', async () => {
      await expect(list.correct.root, '[Expected 1] The dialog opens the existing correction Y').toContainText(FR_KO['fix.ctxPendingHead'].trim());
      await expect(list.correct.root, '[Expected 1] Correction Y is the draft (수정됨 — 미상신)').toContainText(FR_KO['state.DRAFT']);
      await expect(list.correct.discardButton, '[Expected 1] 수정 버리기 (원래대로) (Discard correction) is shown').toBeVisible();
    });

    await step('Act: Step 2 — Click 수정 버리기 (원래대로) (Discard correction)', async () => {
      discardY = await ext.discard();
    });

    await step('Assert: Expected 2 — The discarded toast shows and the dialog closes', async () => {
      expect(discardY.status(), '[Expected 2] The discard request succeeds').toBeLessThan(300);
      await expect(list.toast(FR_KO['fix.discarded']), '[Expected 2] Toast 수정을 취소했습니다. 계약이 산정한 요율로 돌아갑니다.').toBeVisible();
      await expect(list.correct.root, '[Expected 2] The dialog closes').toHaveCount(0);
    });

    await step('Act: Step 3 — Look at the P10 / NORMAL row', async () => {
      await list.search(s.products.P10);
    });

    await step('Assert: Expected 3 — Back to the contract result: 적용 행 없음, empty rate, no pill, no proposed line, counted under 확인 필요', async () => {
      const row = list.row(s.products.P10);
      await expect(list.cell(row, 'status'), '[Expected 3] 적용 행 없음 (No row applies)').toContainText(FR_KO['status.NO_ROW']);
      await expect(list.cell(row, 'rate'), '[Expected 3] Empty rate').not.toContainText('%');
      await expect(list.statusPills(row), '[Expected 3] No correction pill').toHaveCount(1);
      await expect(list.secondLine(list.cell(row, 'rate')), '[Expected 3] No proposed rate line').toHaveCount(0);
      await expect(list.secondLine(list.cell(row, 'category')), '[Expected 3] No proposed category line').toHaveCount(0);
      expect((await feeReviewApi.row(cycleId, s.products.P10)).bucket, '[Expected 3] Counted under 확인 필요 (Needs review)').toBe('NEEDS_REVIEW');
    });

    await step('Act: Step 4 — Read correction Y', async () => {
      rowY = await db('SELECT state, discarded_at FROM fee_correction WHERE id = ?', [y]);
    });

    await step('Assert: Expected 4 — The row still exists: DRAFT with discarded_at set (soft discard)', async () => {
      expect(rowY.length, '[Expected 4] The row still exists').toBe(1);
      expect(rowY[0]?.state, '[Expected 4] state = DRAFT').toBe('DRAFT');
      expect(rowY[0]?.discarded_at ?? null, '[Expected 4] discarded_at is set').not.toBeNull();
    });

    await step('Act: Step 5 — Search P03, click 수정 (Correct) on P03 / NORMAL and click 수정 버리기 (원래대로)', async () => {
      await list.search(s.products.P03);
      await list.openCorrect(list.row(s.products.P03));
      discardZ = await ext.discard();
    });

    await step('Assert: Expected 5 — The discarded toast shows', async () => {
      expect(discardZ.status(), '[Expected 5] The discard request succeeds').toBeLessThan(300);
      await expect(list.toast(FR_KO['fix.discarded']), '[Expected 5] Toast 수정을 취소했습니다. 계약이 산정한 요율로 돌아갑니다.').toBeVisible();
    });

    await step('Act: Step 6 — Look at the P03 / NORMAL row', async () => {
      await list.search(s.products.P03);
    });

    await step('Assert: Expected 6 — Back to the contract result: 산정 완료, B, 9.00%, 불일치, no pill, no proposed line', async () => {
      const row = list.row(s.products.P03);
      await expect(list.cell(row, 'status'), '[Expected 6] 산정 완료 (Resolved)').toContainText(FR_KO['status.RESOLVED']);
      await expect(list.cell(row, 'category'), '[Expected 6] Category B').toHaveText(s.master.categoryName.B);
      await expect(list.cell(row, 'rate'), '[Expected 6] 9.00%').toHaveText('9.00%');
      await expect(list.cell(row, 'compare'), '[Expected 6] 불일치 (Mismatch)').toHaveText(FR_KO['compare.MISMATCH']);
      await expect(list.statusPills(row), '[Expected 6] No correction pill').toHaveCount(1);
      await expect(list.secondLine(list.cell(row, 'rate')), '[Expected 6] No proposed line').toHaveCount(0);
    });

    await step('Act: Step 7 — Read correction Z', async () => {
      rowZ = await db('SELECT state, discarded_at FROM fee_correction WHERE id = ?', [z]);
    });

    await step('Assert: Expected 7 — REJECTED with discarded_at set', async () => {
      expect(rowZ[0]?.state, '[Expected 7] state = REJECTED').toBe('REJECTED');
      expect(rowZ[0]?.discarded_at ?? null, '[Expected 7] discarded_at is set').not.toBeNull();
    });

    await step('Act: Step 8 — Click 이번 기 수정 내역 (Changes this period) and look for P10 and P03', async () => {
      await list.openReport();
      await list.report.showLatest();
    });

    await step('Assert: Expected 8 — P10 is not on the report; P03 stays as 반려됨 — 수정 후 재상신 with its target value struck through', async () => {
      await expect(ext.reportRow(s.products.P10), '[Expected 8] P10 is not on the report (never submitted)').toHaveCount(0);
      const p03 = ext.reportRow(s.products.P03);
      await expect(p03, '[Expected 8] P03 stays on the report').toHaveCount(1);
      await expect(list.report.cell(p03, 'approval'), '[Expected 8] 승인 (Approval) 반려됨 — 수정 후 재상신').toHaveText(FR_KO['state.REJECTED']);
      expect(await ext.hasStrikeThrough(list.report.cell(p03, 'change')), '[Expected 8] Its target value is struck through').toBe(true);
    });
  });

  test('TC_US079_111 — Discard is not offered on a pending, applied, approved or retired correction', async ({ page, feeReviewPage: list, feeReviewApi, approverFeeReviewApi, contractsApi, approverContractsApi, seedData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_111', 'Medium', TAGS, `Pending X (P14 → B), applied P05C (P05 → D, same rate), approved X and retired P10C (P10 typed 6.75, approved, then retired by a new A × ST2 8.00% row): the pending row cannot be opened (수정 disabled); the applied, approved and retired corrections open with no 수정 버리기; a direct DELETE on each returns 409 STL-1019 with the TC sentence and the state is kept. ${DEV_CYCLE} ${DEV_PRIVATE} ${CLEAN}`);
    let s!: Awaited<ReturnType<typeof seedData>>;
    let cycleId = 0;
    let x = '';
    let caX = 0;
    let p05c = '';
    let p10c = '';
    let del = { status: 0, body: undefined as unknown };
    const stateOf = async (id: string) => String((await db('SELECT state FROM fee_correction WHERE id = ?', [id]))[0]?.state ?? '');

    await step('Arrange: Pre-condition 1–20 — ROOT (R_A · R_B10 · R_D), cycle CY_MAIN; X pending on P14, P05C applied on P05, P10C approved then retired by row R_A8 (A × ST2 8.00)', async () => {
      s = await seedData({ tc: 111, private: true, contracts: family({ ROOT: ['R_A', 'R_B10', 'R_D'] }), cycles: ['CY_MAIN'], products: [product('P14', main(234)), product('P05', main(151)), product('P10', main(86))] });
      cycleId = s.cycles.CY_MAIN.id;
      x = await saveDraft(feeReviewApi, cycleId, s.products.P14, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.B, reason: reasonOf('TC_US079_111', 'Wrong category mapped in commerce') });
      caX = await submitDraft(feeReviewApi, x);
      p05c = await saveDraft(feeReviewApi, cycleId, s.products.P05, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.D, reason: reasonOf('TC_US079_111', '카테고리 오매핑 정정') });
      p10c = await saveDraft(feeReviewApi, cycleId, s.products.P10, { policy: 'NORMAL', tier: 'RATE_OVERRIDE', overrideRate: '6.75', reason: reasonOf('TC_US079_111', '유사 계약 요율 적용') });
      expect((await approverFeeReviewApi.approve(await submitDraft(feeReviewApi, p10c))).status, 'Pre-condition 14 — Approve CA_P10 returns 200').toBe(200);
      const added = await contractsApi.addFeeRow<{ newRowId?: number; changeApprovalId?: number }>(s.family.contracts.ROOT, {
        key: { categoryId: s.master.category.A, saleTypeId: s.master.saleType.ST2, policy: 'NORMAL' },
        commissionType: 'PERCENT',
        commission: 8,
        effectiveFrom: '2020-01-01',
        pgCommissionRate: 3,
        feeBase: 'PRODUCT_PRICE',
        pgFeeBase: 'PRODUCT_PRICE',
        changeReason: `[T079-${s.run}-111] R_A8`,
      });
      expect(added.status, 'Pre-condition 15 — POST fee-rows (R_A8) returns 201').toBe(201);
      expect((await approverContractsApi.approve(Number(added.body?.changeApprovalId))).status, 'Pre-condition 16 — Approve CA_ROW returns 200').toBe(200);
      await feeReviewApi.products(cycleId, { keyword: s.prefix });
      expect((await feeReviewApi.row(cycleId, s.products.P14)).correction?.state, 'Pre-condition 18 — X is PENDING').toBe('PENDING');
      expect((await feeReviewApi.row(cycleId, s.products.P05)).correction?.state, 'Pre-condition 18 — P05C is APPLIED').toBe('APPLIED');
      expect((await feeReviewApi.row(cycleId, s.products.P10)).correction?.state, 'Pre-condition 18 — P10C is RETIRED').toBe('RETIRED');
    });

    await step('Act: Step 1 — Search P14 and hover 수정 (Correct) on P14 / NORMAL', async () => {
      const row = await showRow(list, cycleId, s.products.P14);
      await new CorrectV1Page(page, list).hoverCorrect(row);
    });

    await step('Assert: Expected 1 — Pending: pill 승인 대기; 수정 disabled, so no dialog and no 수정 버리기 can be reached', async () => {
      const row = list.row(s.products.P14);
      await expect(list.statusPills(row).nth(1), '[Expected 1] Pill 승인 대기 (Awaiting approval)').toHaveText(FR_KO['state.PENDING']);
      await expect(list.rowButton(row, 'btn.correct'), '[Expected 1] 수정 (Correct) is disabled').toBeDisabled();
      await expect(list.correct.root, '[Expected 1] No dialog (so no Discard) can be reached').toHaveCount(0);
    });

    await step('Act: Step 2 — Call DELETE on correction X', async () => {
      del = await feeReviewApi.discard(x);
    });

    await step('Assert: Expected 2 — HTTP 409, STL-1019 with the TC sentence; X stays PENDING', async () => {
      expectRefused(del, 409, 'STL-1019', FR_TC.staleStateKo, FR_TC.staleStateEn, '[Expected 2]');
      expect(await stateOf(x), '[Expected 2] X stays PENDING').toBe('PENDING');
    });

    await step('Act: Step 3 — Search P05 and click 수정 (Correct) on P05 / NORMAL', async () => {
      await list.search(s.products.P05);
      await list.openCorrect(list.row(s.products.P05));
    });

    await step('Assert: Expected 3 — Applied: pill 적용됨 (요율 변동 없음); the dialog opens with no 수정 버리기', async () => {
      await expect(list.statusPills(list.row(s.products.P05)).nth(1), '[Expected 3] Pill 적용됨 (요율 변동 없음) (Applied (no rate change))').toHaveText(FR_KO['state.APPLIED']);
      await expect(list.correct.title, '[Expected 3] Dialog 수수료 산정 수정 opens').toHaveText(FR_KO['fix.title']);
      await expect(list.correct.discardButton, '[Expected 3] No Discard correction button').toHaveCount(0);
    });

    await step('Act: Step 4 — Click 취소 (Cancel) and call DELETE on P05C', async () => {
      await list.correct.cancel();
      del = await feeReviewApi.discard(p05c);
    });

    await step('Assert: Expected 4 — HTTP 409, STL-1019, same message; the correction stays APPLIED', async () => {
      expectRefused(del, 409, 'STL-1019', FR_TC.staleStateKo, FR_TC.staleStateEn, '[Expected 4]');
      expect(await stateOf(p05c), '[Expected 4] The correction stays APPLIED').toBe('APPLIED');
    });

    await step('Act: Step 5 — As user B approve CA_X, then search P14 and click 수정 (Correct) on its row', async () => {
      expect((await approverFeeReviewApi.approve(caX)).status, 'Approve CA_X returns 200').toBe(200);
      await list.search(s.products.P14);
      await list.openCorrect(list.row(s.products.P14));
    });

    await step('Assert: Expected 5 — Approved: pill 승인됨 — 적용; the dialog opens with no 수정 버리기', async () => {
      await expect(list.statusPills(list.row(s.products.P14)).nth(1), '[Expected 5] Pill 승인됨 — 적용 (Approved — applied)').toHaveText(FR_KO['state.APPROVED']);
      await expect(list.correct.title, '[Expected 5] The dialog opens').toHaveText(FR_KO['fix.title']);
      await expect(list.correct.discardButton, '[Expected 5] No Discard correction button').toHaveCount(0);
    });

    await step('Act: Step 6 — Click 취소 (Cancel) and call DELETE on X', async () => {
      await list.correct.cancel();
      del = await feeReviewApi.discard(x);
    });

    await step('Assert: Expected 6 — HTTP 409, STL-1019, same message; X stays APPROVED', async () => {
      expectRefused(del, 409, 'STL-1019', FR_TC.staleStateKo, FR_TC.staleStateEn, '[Expected 6]');
      expect(await stateOf(x), '[Expected 6] X stays APPROVED').toBe('APPROVED');
    });

    await step('Act: Step 7 — Search P10 and click 수정 (Correct) on P10 / NORMAL', async () => {
      await list.search(s.products.P10);
      await list.openCorrect(list.row(s.products.P10));
    });

    await step('Assert: Expected 7 — Retired: pill 자동 해제 — 더 이상 불필요, rate 8.00%; the dialog opens with no 수정 버리기', async () => {
      const row = list.row(s.products.P10);
      await expect(list.statusPills(row).nth(1), '[Expected 7] Pill 자동 해제 — 더 이상 불필요 (Retired — no longer needed)').toHaveText(FR_KO['state.RETIRED']);
      await expect(list.cell(row, 'rate'), '[Expected 7] Rate 8.00%').toContainText('8.00%');
      await expect(list.correct.title, '[Expected 7] The dialog opens').toHaveText(FR_KO['fix.title']);
      await expect(list.correct.discardButton, '[Expected 7] No Discard correction button').toHaveCount(0);
    });

    await step('Act: Step 8 — Click 취소 (Cancel) and call DELETE on P10C', async () => {
      await list.correct.cancel();
      del = await feeReviewApi.discard(p10c);
    });

    await step('Assert: Expected 8 — HTTP 409, STL-1019, same message; the correction stays RETIRED', async () => {
      expectRefused(del, 409, 'STL-1019', FR_TC.staleStateKo, FR_TC.staleStateEn, '[Expected 8]');
      expect(await stateOf(p10c), '[Expected 8] The correction stays RETIRED').toBe('RETIRED');
    });
  });

  test('TC_US079_113 — A double-clicked Save creates only one correction', async ({ page, feeReviewPage: list, feeReviewApi, seedData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_113', 'Medium', TAGS, `A double-click on 저장 for P14 (A → B) sends one save request, shows exactly one draft toast and leaves one open correction; two identical parallel API saves on P05 return one 201 DRAFT and one 409 STL-1019, and no key holds two open corrections. Not automated: that 저장 turns disabled during the in-flight request (a sub-second state) — the single request is asserted instead. Expected to fail (TC build note): no unique key guards open drafts, so the two parallel saves can both create a draft. Deviation: the duplicate-open query is scoped to this TC's products (shared database). ${DEV_CYCLE} ${DEV_SHARED} ${CLEAN}`);
    let s!: Awaited<ReturnType<typeof seedData>>;
    let cycleId = 0;
    let posts = 0;
    let count = -1;
    let parallel: Array<{ status: number; body: unknown }> = [];
    let duplicates: RowDataPacket[] = [];

    await step('Arrange: Pre-condition 1–11 — ROOT (R_A 12.50 · R_B10 10.00), cycle CY_MAIN, products P14 (A, assigned R_A) and P05 (A)', async () => {
      s = await seedData({ tc: 113, contracts: family({ ROOT: ['R_A', 'R_B10'] }), cycles: ['CY_MAIN'], products: [product('P14', main(234)), product('P05', main(151))] });
      cycleId = s.cycles.CY_MAIN.id;
      page.on('request', (r) => {
        if (r.method() === 'POST' && /\/fee-review\/cycles\/\d+\/products\/[^/]+\/corrections$/.test(r.url())) posts += 1;
      });
    });

    await step('Act: Step 1 — Search P14, click 수정 (Correct), select B and type the reason', async () => {
      await list.openCorrect(await showRow(list, cycleId, s.products.P14));
      await list.correct.pickCategory(s.master.categoryName.B);
      await list.correct.reasonInput.fill(reasonOf('TC_US079_113', 'Double click check'));
    });

    await step('Assert: Expected 1 — The dialog is ready to save', async () => {
      await expect(list.correct.saveButton, '[Expected 1] 저장 (Save) is enabled').toBeEnabled();
    });

    await step('Act: Step 2 — Double-click 저장 (Save) as fast as possible', async () => {
      const saved = page.waitForResponse((r) => r.request().method() === 'POST' && /\/corrections$/.test(r.url()));
      await list.correct.saveButton.dblclick();
      await saved;
    });

    await step('Assert: Expected 2 — One save request; exactly one draft toast', async () => {
      await expect(list.toast(FR_KO['fix.savedDraft']), '[Expected 2] The draft toast shows').toBeVisible();
      await expect(page.getByText(FR_KO['fix.savedDraft']), '[Expected 2] Exactly one toast').toHaveCount(1);
      expect(posts, '[Expected 2] Only the first click sends a save request').toBe(1);
    });

    await step('Act: Step 3 — Count the open fee_correction rows of P14', async () => {
      const [r] = await db('SELECT COUNT(*) AS n FROM fee_correction WHERE product_id = ? AND discarded_at IS NULL', [s.products.P14]);
      count = Number(r.n);
    });

    await step('Assert: Expected 3 — Count = 1', async () => {
      expect(count, '[Expected 3] Count = 1').toBe(1);
    });

    await step('Act: Step 4 — Send two identical POST corrections for P05 at the same moment', async () => {
      const body: SaveCorrectionBody = { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.B, reason: reasonOf('TC_US079_113', 'Parallel save check') };
      parallel = await Promise.all([feeReviewApi.save(cycleId, s.products.P05, body), feeReviewApi.save(cycleId, s.products.P05, body)]);
    });

    await step('Assert: Expected 4 — One request returns 201 (DRAFT); the other returns 409 STL-1019', async () => {
      const ok = parallel.filter((r) => r.status === 201);
      const refused = parallel.filter((r) => r.status !== 201);
      expect(ok.length, '[Expected 4] Exactly one request returns 201').toBe(1);
      expect((ok[0]?.body as { state?: string } | undefined)?.state, '[Expected 4] The created correction is DRAFT').toBe('DRAFT');
      expect(refused[0]?.status, '[Expected 4] The other returns 409').toBe(409);
      expect(asText(refused[0]?.body), '[Expected 4] Error code STL-1019').toContain('STL-1019');
    });

    await step('Act: Step 5 — Look for keys holding two open corrections', async () => {
      duplicates = await db("SELECT settlement_cycle_id, product_id, policy, COUNT(*) AS n FROM fee_correction WHERE state IN ('DRAFT','REJECTED') AND discarded_at IS NULL AND product_id LIKE ? GROUP BY 1,2,3 HAVING COUNT(*) > 1", [`${s.prefix}%`]);
    });

    await step('Assert: Expected 5 — 0 rows — no key holds two open corrections', async () => {
      expect(duplicates.length, '[Expected 5] 0 rows').toBe(0);
    });
  });

  test('TC_US079_114 — Closing the dialog without saving keeps nothing and reopening shows the value in force', async ({ page, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const ext = new CorrectV1Page(page, list);
    await tcMeta('TC_US079_114', 'Low', TAGS, `On P14 a picked B (9.00%) with a reason is dropped by the X icon (no toast, row unchanged, nothing stored); reopening shows the contract value A · 12.50% · 산정 완료 with — 변경 없음 —, an empty reason, counter 0 / 200 and Save disabled; the same holds after 취소. ${DEV_CYCLE} ${DEV_SHARED} ${CLEAN}`);
    let s!: Awaited<ReturnType<typeof seedData>>;
    let pid = '';
    let row!: Locator;
    let count = -1;

    await step('Arrange: Pre-condition 1–12 — ROOT (R_A · R_E11) + ANNEX1 (R_B9), cycle CY_MAIN, product P14 (A, assigned R_A)', async () => {
      s = await seedData({ tc: 114, contracts: family({ ROOT: ['R_A', 'R_E11'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P14', main(234))] });
      pid = s.products.P14;
    });

    await step('Act: Step 1 — Search P14 and click 수정 (Correct) on P14 / NORMAL', async () => {
      row = await showRow(list, s.cycles.CY_MAIN.id, pid);
      await list.openCorrect(row);
    });

    await step('Assert: Expected 1 — Dialog 수수료 산정 수정 opens', async () => {
      await expect(list.correct.title, '[Expected 1] Dialog opens').toHaveText(FR_KO['fix.title']);
    });

    await step('Act: Step 2 — Select category B and type the reason', async () => {
      await list.correct.pickCategory(s.master.categoryName.B);
      await list.correct.reasonInput.fill(reasonOf('TC_US079_114', 'Close without saving'));
    });

    await step('Assert: Expected 2 — The preview states the rate changes to 9.00%; Save is enabled', async () => {
      await expect(list.correct.deltaPanel, '[Expected 2] The rate changes to 9.00%').toContainText('9.00%');
      await expect(list.correct.saveButton, '[Expected 2] Save is enabled').toBeEnabled();
    });

    await step('Act: Step 3 — Click the X icon at the top right of the dialog', async () => {
      await ext.closeByCorner();
    });

    await step('Assert: Expected 3 — The dialog closes with no toast', async () => {
      await expect(list.correct.root, '[Expected 3] The dialog closes').toHaveCount(0);
      for (const key of ['fix.savedDraft', 'fix.savedApplied', 'fix.savedDraftTyped'] as const) await expect(page.getByText(FR_KO[key]), `[Expected 3] No toast "${FR_KO[key]}"`).toHaveCount(0);
    });

    await step('Act: Step 4 — Look at the row and count the fee_correction rows of P14', async () => {
      await list.search(pid);
      const [r] = await db('SELECT COUNT(*) AS n FROM fee_correction WHERE product_id = ?', [pid]);
      count = Number(r.n);
    });

    await step('Assert: Expected 4 — A, 12.50%, 일치, no correction pill; count = 0', async () => {
      await expect(list.cell(row, 'category'), '[Expected 4] Category A').toHaveText(s.master.categoryName.A);
      await expect(list.cell(row, 'rate'), '[Expected 4] 12.50%').toHaveText('12.50%');
      await expect(list.cell(row, 'compare'), '[Expected 4] 일치 (Matches)').toHaveText(FR_KO['compare.MATCHES']);
      await expect(list.statusPills(row), '[Expected 4] No correction pill').toHaveCount(1);
      expect(count, '[Expected 4] Count = 0').toBe(0);
    });

    await step('Act: Step 5 — Click 수정 (Correct) on the same row again', async () => {
      await list.openCorrect(row);
    });

    await step('Assert: Expected 5 — Reset to the value in force: A · 12.50% · 산정 완료, — 변경 없음 —, empty reason, 0 / 200, Save disabled', async () => {
      await expect(list.correct.contractValue('fix.kvCategory'), '[Expected 5] Resolved from the contract — A').toHaveText(s.master.categoryName.A);
      await expect(list.correct.contractValue('fix.kvRate'), '[Expected 5] Resolved from the contract — 12.50%').toHaveText('12.50%');
      await expect(list.correct.contractValue('fix.kvStatus'), '[Expected 5] Resolved from the contract — 산정 완료').toHaveText(FR_KO['status.RESOLVED']);
      await expect(ext.checkedOption, '[Expected 5] Tier 1 shows — 변경 없음 —').toHaveText(FR_KO['fix.noChange']);
      await expect(list.correct.reasonInput, '[Expected 5] Reason is empty').toHaveValue('');
      await expect(list.correct.counter, '[Expected 5] Counter 0 / 200').toHaveText('0 / 200');
      await expect(list.correct.saveButton, '[Expected 5] Save disabled').toBeDisabled();
    });

    await step('Act: Step 6 — Select category E, type the reason and click 취소 (Cancel)', async () => {
      await list.correct.pickCategory(s.master.categoryName.E);
      await list.correct.reasonInput.fill(reasonOf('TC_US079_114', '취소 버튼 확인'));
      await list.correct.cancelButton.click();
      const [r] = await db('SELECT COUNT(*) AS n FROM fee_correction WHERE product_id = ?', [pid]);
      count = Number(r.n);
    });

    await step('Assert: Expected 6 — The dialog closes; nothing is saved', async () => {
      await expect(list.correct.root, '[Expected 6] The dialog closes').toHaveCount(0);
      expect(count, '[Expected 6] Nothing is saved').toBe(0);
    });

    await step('Act: Step 7 — Click 수정 (Correct) on the same row again', async () => {
      await list.openCorrect(row);
    });

    await step('Assert: Expected 7 — Reset again: — 변경 없음 —, empty reason, 0 / 200', async () => {
      await expect(ext.checkedOption, '[Expected 7] Tier 1 shows — 변경 없음 —').toHaveText(FR_KO['fix.noChange']);
      await expect(list.correct.reasonInput, '[Expected 7] Reason is empty').toHaveValue('');
      await expect(list.correct.counter, '[Expected 7] Counter 0 / 200').toHaveText('0 / 200');
    });
  });

  test('TC_US079_115 — A refused save keeps the dialog open with the error shown', async ({ page, feeReviewPage: list, feeReviewApi, seedData }) => {
    const step = makeStep(page);
    const ext = new CorrectV1Page(page, list);
    const uiReason = reasonOf('TC_US079_115', 'Refused save keeps the dialog');
    const apiReason = reasonOf('TC_US079_115', 'Second tab draft');
    await tcMeta('TC_US079_115', 'Medium', TAGS, `With B picked on P14 in the dialog, a second-tab draft (E) is saved through the API; the dialog's Save is then refused with STL-1019 and the TC sentence 화면을 불러온 뒤 …, the dialog stays open with the error, B and the typed reason kept; after 취소 + 검색 the row shows the API draft (E 9.50%, 수정됨 — 미상신) and fee_correction holds only that draft. ${DEV_CYCLE} ${DEV_SHARED} ${CLEAN}`);
    let s!: Awaited<ReturnType<typeof seedData>>;
    let pid = '';
    let cycleId = 0;
    let row!: Locator;
    let second = { status: 0, body: undefined as unknown };
    let refused = { status: 0, body: '' };
    let stored: RowDataPacket[] = [];

    await step('Arrange: Pre-condition 1–11 — ROOT (R_A/R_B10/R_PROMO/R_E11), cycle CY_MAIN, product P14 (A, assigned R_A); E resolves to R_PROMO 9.50', async () => {
      s = await seedData({ tc: 115, contracts: family({ ROOT: ['R_A', 'R_B10', 'R_PROMO', 'R_E11'] }), cycles: ['CY_MAIN'], products: [product('P14', main(234))] });
      pid = s.products.P14;
      cycleId = s.cycles.CY_MAIN.id;
    });

    await step('Act: Step 1 — Search P14, click 수정 (Correct), select B and type the reason', async () => {
      row = await showRow(list, cycleId, pid);
      await list.openCorrect(row);
      await list.correct.pickCategory(s.master.categoryName.B);
      await list.correct.reasonInput.fill(uiReason);
    });

    await step('Assert: Expected 1 — The dialog is ready to save', async () => {
      await expect(list.correct.saveButton, '[Expected 1] 저장 (Save) is enabled').toBeEnabled();
    });

    await step('Act: Step 2 — In the API client save a draft E for P14', async () => {
      second = await feeReviewApi.save(cycleId, pid, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.E, reason: apiReason });
    });

    await step('Assert: Expected 2 — HTTP 201, state = DRAFT', async () => {
      expect(second.status, '[Expected 2] HTTP 201').toBe(201);
      expect((second.body as { state?: string } | undefined)?.state, '[Expected 2] state = DRAFT').toBe('DRAFT');
    });

    await step('Act: Step 3 — Back in the dialog click 저장 (Save)', async () => {
      const response = await list.correct.save();
      refused = { status: response.status(), body: await response.text() };
    });

    await step('Assert: Expected 3 — Refused with STL-1019 and the TC sentence', async () => {
      expect(refused.status, '[Expected 3] The save is refused').toBeGreaterThanOrEqual(400);
      expect(refused.body, '[Expected 3] Error code STL-1019').toContain('STL-1019');
      await expect(ext.staleStateMessage, '[Expected 3] Message 화면을 불러온 뒤 상품 또는 수정 건의 상태가 바뀌어 이 작업을 할 수 없습니다. 화면을 새로 고쳤습니다.').toBeVisible();
    });

    await step('Act: Step 4 — Look at the dialog', async () => {
      await list.correct.root.scrollIntoViewIfNeeded().catch(() => undefined);
    });

    await step('Assert: Expected 4 — The dialog stays open with the error; B and the reason are kept', async () => {
      await expect(list.correct.root, '[Expected 4] The dialog stays open').toBeVisible();
      await expect(list.correct.root.getByText(FR_TC.staleStateKo).or(list.correct.root.getByText(FR_TC.staleStateEn)), '[Expected 4] The error is visible in the dialog').toBeVisible();
      await expect(ext.checkedOption, '[Expected 4] Category B is kept').toHaveText(new RegExp(`^${esc(s.master.categoryName.B)}( \\(|$)`));
      await expect(list.correct.reasonInput, '[Expected 4] The reason is kept').toHaveValue(uiReason);
    });

    await step('Act: Step 5 — Click 취소 (Cancel) and click 검색 (Search)', async () => {
      await list.correct.cancel();
      await list.search(pid);
    });

    await step('Assert: Expected 5 — Pill 수정됨 — 미상신 with proposed E 9.50% (the draft from step 2)', async () => {
      await expect(list.statusPills(row).nth(1), '[Expected 5] Pill 수정됨 — 미상신').toHaveText(FR_KO['state.DRAFT']);
      await expect(list.secondLine(list.cell(row, 'category')), '[Expected 5] Proposed category E').toContainText(s.master.categoryName.E);
      await expect(list.secondLine(list.cell(row, 'rate')), '[Expected 5] Proposed rate 9.50%').toContainText('9.50%');
    });

    await step('Act: Step 6 — Read the open fee_correction of P14', async () => {
      stored = await db('SELECT category_id, reason FROM fee_correction WHERE product_id = ? AND discarded_at IS NULL', [pid]);
    });

    await step('Assert: Expected 6 — Exactly one row: CAT_E · the second-tab reason', async () => {
      expect(stored.length, '[Expected 6] Exactly one row').toBe(1);
      expect(num(stored[0]?.category_id), '[Expected 6] category_id = CAT_E').toBe(s.master.category.E);
      expect(stored[0]?.reason, '[Expected 6] reason = the second-tab reason').toBe(apiReason);
    });
  });
});
