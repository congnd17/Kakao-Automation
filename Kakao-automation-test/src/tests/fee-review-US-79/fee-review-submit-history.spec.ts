import { Page } from '@playwright/test';
import { test, expect } from '@fixtures/fee-review-v1.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { getAccountDisplayName } from '@utils/auth-token';
import { FR_EN, FR_KO, frFormat } from '@utils/fee-review.i18n';
import { family, product } from '@utils/fee-review-v1.data';
import { feeReviewDb } from '@utils/fee-review-db';
import type { ProductDef } from '@utils/fee-review-seed';
import { FeeReviewListPage } from '@pages/fee-review.page';
import type { ChangeApprovalQueuePage } from '@pages/change-approval-queue.page';
import { SubmitHistoryView } from '@pages/fee-review-v1/submit-history.page';
import {
  DbRow,
  approvalIdOf,
  approvalRow,
  correctionRow,
  csvMatches,
  csvRecord,
  decide,
  esc,
  expectRefused,
  exportReportCsv,
  identity,
  saveCorrection,
  select,
  submitCorrections,
} from '@utils/fee-review-submit-history';
import type { ApiResult } from '@api/payment-method-policy.api';

/**
 * US079 v1 — nhóm [Submit & Withdraw], [History], [Change Report] (`input/TESTCASE_US079_v1.md`). Maker = TOKEN_A (browser
 * mặc định), approver = TOKEN_B (phiên trình duyệt thứ 2 / API). Tên account đọc lúc chạy qua getAccountDisplayName().
 * Tiền điều kiện dựng qua API + SQL (seedData) ở Arrange; DB chỉ đọc bằng SELECT, trừ câu UPDATE mà chính TC ghi ở Steps.
 */
const TAGS = ['fee-review', 'submit-history'];
const REGISTER = 'FEE_RULE';
const SEED =
  'Data: the T079 contract family and CY_MAIN are shared within the run (no delete API); products are private to the test and every correction / approval / history row of them is removed by SQL in teardown. Deviation: the cycle is the next free month from 2100 instead of Y = 2100 + 200 × RUN + N.';
const PRIVATE =
  'Data: the test owns its contract family and cycle (it reads cycle-wide state, exports the whole cycle or changes a contract) — they stay on dev (no delete API); products, corrections, approvals and history rows are removed by SQL in teardown. Deviation: the cycle is the next free month from 2100 instead of Y = 2100 + 200 × RUN + N.';
const SEARCH_DEV = 'Deviation: CY_MAIN is shared by every test of the run, so the list is narrowed with 검색어 (Keyword) to the products of this test.';
const DATE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
/** Mã nội bộ không được lộ ra lý do hiển thị (STL-…, BR-…, enum kiểu CONTRACT_ROW_ADDED). */
const INTERNAL_CODE = /STL-\d|BR-\d|OQ-\d|\b[A-Z]{2,}_[A-Z_]{2,}\b/;

/** Mở màn với cycle + bucket rồi lọc theo từ khoá (bấm 검색 hoặc Enter như TC ghi). */
async function openFiltered(list: FeeReviewListPage, cycleId: number, keyword: string, via: 'click' | 'enter' = 'click', bucket: 'ALL' | 'FIXED' = 'ALL'): Promise<void> {
  await list.open({ cycleId });
  await list.clickChip(list.chip(bucket === 'ALL' ? 'bucket.ALL' : 'bucket.FIXED'));
  await searchKeyword(list, keyword, via);
}

async function searchKeyword(list: FeeReviewListPage, keyword: string, via: 'click' | 'enter'): Promise<void> {
  if (via === 'click') return list.search(keyword);
  await list.keywordInput.fill(keyword);
  await list.untilListed(() => list.keywordInput.press('Enter'));
}

/** Mở hàng đợi 변경 승인 của approver ở register Fee Rule. */
async function openApproverQueue(secondSession: (role: 'approver') => Promise<{ page: Page; queue: ChangeApprovalQueuePage }>) {
  const session = await secondSession('approver');
  await session.queue.open();
  await session.queue.showRegister(REGISTER);
  return session;
}

test.describe('[Submit & Withdraw / History / Change Report] Fee review corrections', () => {
  test.describe.configure({ timeout: 300_000 });

  test('TC_US079_116 — Submit selected sends each selected draft for approval as its own record', async ({ page, feeReviewApi, seedData, feeReviewPage: list, secondSession }) => {
    const step = makeStep(page);
    const view = new SubmitHistoryView(page, list);
    await tcMeta(
      'TC_US079_116',
      'Critical',
      TAGS,
      `Drafts X (P14 → B) and Y (P03 → A) ticked and submitted together show "수정 2건을 승인 요청으로 상신했습니다.", each row turns 승인 대기 with the value in force unchanged, 회수 shown and 수정 disabled; user B's queue lists two separate Fee Rule records by user A; the DB holds two PENDING corrections with their own pending_key and approval record (target_row_ref X/1, Y/1). ${SEARCH_DEV} ${SEED}`,
    );
    const d = { cy: 0, prefix: '', P14: '', P03: '', X: '', Y: '', A: '', B: '' };
    const maker = getAccountDisplayName('submitter');
    let corrections: DbRow[] = [];
    let approvals: DbRow[] = [];
    let queueSession: Awaited<ReturnType<typeof openApproverQueue>> | undefined;
    const plan = () => [
      { name: 'P14', id: d.P14, inCat: d.A, inRate: '12.50%', newCat: d.B, newRate: '9.00%' },
      { name: 'P03', id: d.P03, inCat: d.B, inRate: '9.00%', newCat: d.A, newRate: '12.50%' },
    ];

    await step('Arrange: Pre-condition 1–14 — ROOT + ANNEX1, CY_MAIN open, drafts X (P14 → B) and Y (P03 → A), no approval record', async () => {
      const s = await seedData({
        tc: 116,
        contracts: family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9'] }),
        cycles: ['CY_MAIN'],
        products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }]), product('P03', [{ cycle: 'CY_MAIN', saleLines: 10 }])],
      });
      Object.assign(d, { cy: s.cycles.CY_MAIN.id, prefix: s.prefix, P14: s.products.P14, P03: s.products.P03, A: s.master.categoryName.A, B: s.master.categoryName.B });
      d.X = await saveCorrection(feeReviewApi, d.cy, d.P14, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.B, reason: '카테고리 오매핑 정정' });
      d.Y = await saveCorrection(feeReviewApi, d.cy, d.P03, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.A, reason: 'Wrong category mapped in commerce' });
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN and click chip 이번 기 수정됨 (Corrected this period)', async () => {
      await openFiltered(list, d.cy, d.prefix, 'click', 'FIXED');
    });
    await step('Assert: Expected 1 — The list of CY_MAIN opens on the products that carry a correction', async () => {
      await expect.soft(list.chip('bucket.FIXED'), '[Expected 1] 이번 기 수정됨 chip is selected').toHaveAttribute('aria-pressed', 'true');
      for (const p of plan()) await expect.soft(list.row(p.id), `[Expected 1] ${p.name} is listed`).toBeVisible();
    });

    await step('Act: Step 2 — Read the rows of P14 and P03', async () => {
      await list.row(d.P14).scrollIntoViewIfNeeded();
    });
    await step('Assert: Expected 2 — Each row shows 수정됨 — 미상신 and the proposed value dimmed under the value in force', async () => {
      for (const p of plan()) {
        const r = list.row(p.id);
        await expect.soft(list.statusPills(r).nth(1), `[Expected 2] ${p.name}: second pill 수정됨 — 미상신`).toHaveText(FR_KO['state.DRAFT']);
        await expect.soft(list.cell(r, 'category'), `[Expected 2] ${p.name}: ${p.inCat} in force`).toHaveText(new RegExp(`^\\s*${esc(p.inCat)}`));
        await expect.soft(list.cell(r, 'rate'), `[Expected 2] ${p.name}: ${p.inRate} in force`).toHaveText(new RegExp(`^\\s*${esc(p.inRate)}`));
        await expect.soft(list.secondLine(list.cell(r, 'category')), `[Expected 2] ${p.name}: ${p.newCat} proposed`).toContainText(p.newCat);
        await expect.soft(list.secondLine(list.cell(r, 'rate')), `[Expected 2] ${p.name}: ${p.newRate} proposed`).toContainText(p.newRate);
      }
    });

    await step('Act: Step 3 — Tick the rows of P14 and P03', async () => {
      for (const p of plan()) await list.rowCheckbox(list.row(p.id)).check();
    });
    await step('Assert: Expected 3 — Both rows are ticked and 선택 일괄 상신 is enabled', async () => {
      for (const p of plan()) await expect.soft(list.rowCheckbox(list.row(p.id)), `[Expected 3] ${p.name} is ticked`).toBeChecked();
      await expect.soft(list.submitButton, '[Expected 3] 선택 일괄 상신 (Submit selected) is enabled').toBeEnabled();
    });

    await step('Act: Step 4 — Click 선택 일괄 상신 (Submit selected)', async () => {
      await list.submitSelected();
    });
    await step('Assert: Expected 4 — Toast "수정 2건을 승인 요청으로 상신했습니다." and the selection clears', async () => {
      await expect.soft(list.toast(frFormat(FR_KO['msg.submitted'], { n: 2 })), '[Expected 4] Toast for 2 submitted corrections').toBeVisible();
      for (const p of plan()) await expect.soft(list.rowCheckbox(list.row(p.id)), `[Expected 4] ${p.name} selection cleared`).not.toBeChecked();
    });

    await step('Act: Step 5 — Read both rows after the list reloads', async () => {
      await list.row(d.P14).scrollIntoViewIfNeeded();
    });
    await step('Assert: Expected 5 — Each row reads 승인 대기, value in force unchanged with the proposal beneath, 회수 shown, 수정 disabled', async () => {
      for (const p of plan()) {
        const r = list.row(p.id);
        await expect.soft(list.statusPills(r).nth(1), `[Expected 5] ${p.name}: second pill 승인 대기`).toHaveText(FR_KO['state.PENDING']);
        await expect.soft(list.cell(r, 'rate'), `[Expected 5] ${p.name}: ${p.inRate} still in force`).toHaveText(new RegExp(`^\\s*${esc(p.inRate)}`));
        await expect.soft(list.secondLine(list.cell(r, 'rate')), `[Expected 5] ${p.name}: proposed ${p.newRate} stays beneath`).toContainText(p.newRate);
        await expect.soft(list.rowButton(r, 'btn.withdraw'), `[Expected 5] ${p.name}: 회수 (Withdraw) shown`).toBeVisible();
        await expect.soft(list.rowButton(r, 'btn.correct'), `[Expected 5] ${p.name}: 수정 (Correct) disabled`).toBeDisabled();
      }
    });

    await step('Act: Step 6 — As user B open 변경 승인 (Change Approval) with 원장 (Register) = 수수료 규칙 (Fee Rule)', async () => {
      queueSession = await openApproverQueue(secondSession);
    });
    await step('Assert: Expected 6 — Two separate Fee Rule records, one for P14 and one for P03, each with 기안자 = user A', async () => {
      for (const p of plan()) {
        const record = view.queueRecord(queueSession!.queue, `${d.cy}/${p.id}/NORMAL`);
        await expect.soft(record, `[Expected 6] One Fee Rule record for ${p.name}`).toHaveCount(1);
        await expect.soft(record, `[Expected 6] ${p.name}: 기안자 (Maker) = user A`).toContainText(`기안자: ${maker}`);
      }
    });

    await step('Act: Step 7 — Read the fee_correction rows of P14 and P03', async () => {
      corrections = await select('corrections', 'SELECT * FROM fee_correction WHERE product_id IN (?, ?)', [d.P14, d.P03]);
    });
    await step('Assert: Expected 7 — Both PENDING with their pending_key, submitted by user A, submission_no 1, distinct approval ids', async () => {
      for (const p of plan()) {
        const c = corrections.find((r) => r.product_id === p.id);
        expect.soft(c?.state, `[Expected 7] ${p.name}: state PENDING`).toBe('PENDING');
        expect.soft(c?.pending_key, `[Expected 7] ${p.name}: pending_key`).toBe(`${d.cy}/${p.id}/NORMAL`);
        expect.soft(String(c?.submitted_by ?? ''), `[Expected 7] ${p.name}: submitted_by user A`).toMatch(identity(maker));
        expect.soft(Number(c?.submission_no), `[Expected 7] ${p.name}: submission_no 1`).toBe(1);
        expect.soft(c?.change_approval_id, `[Expected 7] ${p.name}: change_approval_id is set`).toBeTruthy();
      }
      expect.soft(new Set(corrections.map((c) => String(c.change_approval_id))).size, '[Expected 7] change_approval_id differs between the two rows').toBe(2);
    });

    await step('Act: Step 8 — Read the FEE_RULE change_approval rows of the test products', async () => {
      approvals = await select('approvals', "SELECT * FROM change_approval WHERE target_type = 'FEE_RULE' AND target_ref LIKE ?", [`%/${d.prefix}%`]);
    });
    await step('Assert: Expected 8 — Exactly 2 rows: FEE_RULE, PENDING, requested by user A, target_row_ref X/1 and Y/1', async () => {
      expect.soft(approvals, '[Expected 8] Exactly 2 approval rows').toHaveLength(2);
      for (const a of approvals) {
        expect.soft(a.target_type, '[Expected 8] target_type FEE_RULE').toBe('FEE_RULE');
        expect.soft(a.approval_status, '[Expected 8] approval_status PENDING').toBe('PENDING');
        expect.soft(String(a.requested_by ?? ''), '[Expected 8] requested_by user A').toMatch(identity(maker));
      }
      expect.soft(approvals.map((a) => String(a.target_row_ref)).sort(), '[Expected 8] target_row_ref X/1 and Y/1').toEqual([`${d.X}/1`, `${d.Y}/1`].sort());
    });
  });

  test('TC_US079_117 — Submit selected is disabled with no draft selected and while a submit runs', async ({ page, feeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const view = new SubmitHistoryView(page, list);
    await tcMeta(
      'TC_US079_117',
      'Medium',
      TAGS,
      `선택 일괄 상신 stays disabled with the tooltip "상신할 행을 먼저 선택하세요." when nothing is ticked and with "선택한 항목 중 상신할 것이 없습니다 — …" when only a product without correction (P01) or an awaiting-approval one (P03) is ticked; ticking draft P14 enables it ("1건 상신"); under Slow 3G throttling the button disables with a spinner and a second click sends nothing; the toast shows once and P14 reads 승인 대기. The tooltip is the title attribute of the button wrapper (DOM 01/10). Throttling is applied through the Chrome DevTools protocol (Slow 3G: 2000 ms latency, 500 kbit/s). ${SEARCH_DEV} ${SEED}`,
    );
    const d = { cy: 0, prefix: '', P14: '', P03: '', P01: '' };
    const SUBMIT_URL = /\/fee-review\/corrections\/submit$/;
    let posts = 0;
    let submitted: Promise<unknown> | undefined;
    const throttle = async (on: boolean) => {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', on ? { offline: false, latency: 2000, downloadThroughput: 62_500, uploadThroughput: 62_500 } : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    };

    await step('Arrange: Pre-condition 1–15 — ROOT + ANNEX1, CY_MAIN open, draft X (P14), Y (P03) awaiting approval, P01 without correction', async () => {
      const s = await seedData({
        tc: 117,
        contracts: family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9'] }),
        cycles: ['CY_MAIN'],
        products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }]), product('P03', [{ cycle: 'CY_MAIN', saleLines: 10 }]), product('P01', [{ cycle: 'CY_MAIN', saleLines: 5 }])],
      });
      Object.assign(d, { cy: s.cycles.CY_MAIN.id, prefix: s.prefix, P14: s.products.P14, P03: s.products.P03, P01: s.products.P01 });
      await saveCorrection(feeReviewApi, d.cy, d.P14, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.B, reason: 'Wrong category mapped in commerce' });
      const Y = await saveCorrection(feeReviewApi, d.cy, d.P03, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.A, reason: 'Wrong category mapped in commerce' });
      await submitCorrections(feeReviewApi, [Y]);
      page.on('request', (r) => {
        if (r.method() === 'POST' && SUBMIT_URL.test(r.url())) posts++;
      });
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN with chip 기간 내 판매 상품 (Products sold in period)', async () => {
      await openFiltered(list, d.cy, d.prefix);
    });
    await step('Assert: Expected 1 — The list of CY_MAIN opens with every product sold in the cycle', async () => {
      await expect.soft(list.chip('bucket.ALL'), '[Expected 1] 기간 내 판매 상품 chip is selected').toHaveAttribute('aria-pressed', 'true');
      for (const [name, id] of [['P14', d.P14], ['P03', d.P03], ['P01', d.P01]]) await expect.soft(list.row(id), `[Expected 1] ${name} is listed`).toBeVisible();
    });

    await step('Act: Step 2 — With no row ticked, hover 선택 일괄 상신', async () => {
      await list.submitWrapper.hover();
    });
    await step('Assert: Expected 2 — Disabled with tooltip "상신할 행을 먼저 선택하세요."', async () => {
      await expect.soft(list.submitButton, '[Expected 2] Button disabled').toBeDisabled();
      await expect.soft(list.submitWrapper, '[Expected 2] Tooltip').toHaveAttribute('title', FR_KO['msg.submitNothingSelected']);
    });

    await step('Act: Step 3 — Tick only P01 (no correction) and hover the button', async () => {
      await list.rowCheckbox(list.row(d.P01)).check();
      await list.submitWrapper.hover();
    });
    await step('Assert: Expected 3 — Stays disabled with tooltip "선택한 항목 중 상신할 것이 없습니다 — …"', async () => {
      await expect.soft(list.submitButton, '[Expected 3] Button disabled').toBeDisabled();
      await expect.soft(list.submitWrapper, '[Expected 3] Tooltip').toHaveAttribute('title', FR_KO['msg.submitNothingToSend']);
    });

    await step('Act: Step 4 — Untick P01, tick only P03 (awaiting approval) and hover the button', async () => {
      await list.rowCheckbox(list.row(d.P01)).uncheck();
      await list.rowCheckbox(list.row(d.P03)).check();
      await list.submitWrapper.hover();
    });
    await step('Assert: Expected 4 — Stays disabled with the same tooltip as step 3', async () => {
      await expect.soft(list.submitButton, '[Expected 4] Button disabled').toBeDisabled();
      await expect.soft(list.submitWrapper, '[Expected 4] Tooltip').toHaveAttribute('title', FR_KO['msg.submitNothingToSend']);
    });

    await step('Act: Step 5 — Also tick P14 (draft) and hover the button', async () => {
      await list.rowCheckbox(list.row(d.P14)).check();
      await list.submitWrapper.hover();
    });
    await step('Assert: Expected 5 — Enabled with tooltip "1건 상신"', async () => {
      await expect.soft(list.submitButton, '[Expected 5] Button enabled').toBeEnabled();
      await expect.soft(list.submitWrapper, '[Expected 5] Tooltip').toHaveAttribute('title', frFormat(FR_KO['msg.submitTitle'], { n: 1 }));
    });

    await step('Act: Step 6 — Throttle the network to Slow 3G, click 선택 일괄 상신 and click it again at once', async () => {
      await throttle(true);
      submitted = page.waitForResponse((r) => r.request().method() === 'POST' && SUBMIT_URL.test(r.url()), { timeout: 60_000 });
      await list.click(list.submitButton, '선택 일괄 상신 (Submit selected) button');
      await list.submitButton.click({ force: true });
    });
    await step('Assert: Expected 6 — The button is disabled with a spinner while the request runs; the second click sends nothing', async () => {
      await expect.soft(list.submitButton, '[Expected 6] Button disabled while the request runs').toBeDisabled();
      await expect.soft(view.submitSpinner, '[Expected 6] Spinner shown while the request runs').toBeVisible();
      expect.soft(posts, '[Expected 6] Only one submit request was sent').toBe(1);
    });

    await step('Act: Step 7 — Wait until the request returns', async () => {
      await submitted;
      await throttle(false);
    });
    await step('Assert: Expected 7 — Toast shows once; P14 reads 승인 대기; the selection clears and the button is disabled again', async () => {
      await expect.soft(page.getByText(frFormat(FR_KO['msg.submitted'], { n: 1 })), '[Expected 7] Toast "수정 1건을 승인 요청으로 상신했습니다." shows once').toHaveCount(1);
      await expect.soft(list.statusPills(list.row(d.P14)).nth(1), '[Expected 7] P14 reads 승인 대기').toHaveText(FR_KO['state.PENDING']);
      for (const id of [d.P14, d.P03]) await expect.soft(list.rowCheckbox(list.row(id)), `[Expected 7] ${id} selection cleared`).not.toBeChecked();
      await expect.soft(list.submitButton, '[Expected 7] Button disabled again').toBeDisabled();
      expect.soft(posts, '[Expected 7] Still one submit request').toBe(1);
    });
  });

  test('TC_US079_120 — A product never holds two pending corrections for the same cycle and policy', async ({ page, feeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US079_120',
      'High',
      TAGS,
      `Two submits of draft X fired at the same moment leave exactly one PENDING correction and one PENDING Fee Rule record (the other call gets 409 STL-1019 or STL-1011); the row shows one 승인 대기 pill with 수정 disabled ("승인 대기 중입니다 — 먼저 회수한 뒤에 수정하세요."); a further save is refused with 409 STL-1011 and creates nothing. Deviation: the two concurrent calls are sent in parallel from one API client instead of two terminals. ${SEED}`,
    );
    const d = { cy: 0, P14: '', catE: 0 };
    const G = "SELECT settlement_cycle_id, product_id, policy, COUNT(*) AS n FROM fee_correction WHERE state = 'PENDING' GROUP BY 1,2,3 HAVING COUNT(*) > 1";
    let calls: Array<ApiResult<unknown>> = [];
    let dup: DbRow[] = [];
    let pendingRecords = -1;
    let save: ApiResult<unknown> | undefined;
    const rowsOfP14 = { before: -1, after: -1 };

    await step('Arrange: Pre-condition 1–12 — ROOT + ANNEX1, CY_MAIN open, draft X on P14, no PENDING correction of the key', async () => {
      const s = await seedData({ tc: 120, contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      Object.assign(d, { cy: s.cycles.CY_MAIN.id, P14: s.products.P14, catE: s.master.category.E });
      await saveCorrection(feeReviewApi, d.cy, d.P14, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.B, reason: 'Wrong category mapped in commerce' });
    });

    await step('Act: Step 1 — Fire two submits of X at the same moment', async () => {
      const X = String((await select('X', 'SELECT id FROM fee_correction WHERE product_id = ? AND discarded_at IS NULL', [d.P14]))[0]?.id);
      calls = await Promise.all([feeReviewApi.submit([X]), feeReviewApi.submit([X])]);
    });
    await step('Assert: Expected 1 — One call returns 200 (1 submitted); the other 409 with STL-1019 or STL-1011', async () => {
      const ok = calls.filter((c) => c.status === 200);
      const refused = calls.filter((c) => c.status === 409);
      expect.soft(ok, '[Expected 1] Exactly one call returns HTTP 200').toHaveLength(1);
      expect.soft((ok[0]?.body as { submitted?: number } | undefined)?.submitted, '[Expected 1] 1 submitted').toBe(1);
      expect.soft(refused, '[Expected 1] The other call returns HTTP 409').toHaveLength(1);
      expect.soft(JSON.stringify(refused[0]?.body ?? ''), '[Expected 1] Refused with STL-1019 or STL-1011').toMatch(/STL-1019|STL-1011/);
    });

    await step('Act: Step 2 — Run invariant query G', async () => {
      dup = await select('invariant G', G);
    });
    await step('Assert: Expected 2 — 0 rows', async () => {
      expect(dup, '[Expected 2] No key holds two PENDING corrections').toEqual([]);
    });

    await step('Act: Step 3 — Count the PENDING Fee Rule records of the key', async () => {
      pendingRecords = Number(
        (await select('pending records of P14', "SELECT COUNT(*) AS n FROM change_approval WHERE target_type = 'FEE_RULE' AND target_ref = ? AND approval_status = 'PENDING'", [`${d.cy}/${d.P14}/NORMAL`]))[0]?.n,
      );
    });
    await step('Assert: Expected 3 — 1', async () => {
      expect(pendingRecords, '[Expected 3] Exactly one PENDING record').toBe(1);
    });

    await step('Act: Step 4 — Open the screen on CY_MAIN, find P14 and hover 수정 (Correct)', async () => {
      await openFiltered(list, d.cy, d.P14);
      await list.correctWrapper(list.row(d.P14)).hover();
    });
    await step('Assert: Expected 4 — One second pill 승인 대기; 수정 disabled with tooltip "승인 대기 중입니다 — 먼저 회수한 뒤에 수정하세요."', async () => {
      const r = list.row(d.P14);
      await expect.soft(list.statusPills(r), '[Expected 4] Exactly two pills (resolution + one correction pill)').toHaveCount(2);
      await expect.soft(list.statusPills(r).nth(1), '[Expected 4] Second pill 승인 대기').toHaveText(FR_KO['state.PENDING']);
      await expect.soft(list.rowButton(r, 'btn.correct'), '[Expected 4] 수정 (Correct) disabled').toBeDisabled();
      await expect.soft(list.correctWrapper(r), '[Expected 4] Tooltip').toHaveAttribute('title', FR_KO['msg.correctDisabledPending']);
    });

    await step('Act: Step 5 — POST another correction (category E) on P14', async () => {
      const count = async () => Number((await select('corrections of P14', 'SELECT COUNT(*) AS n FROM fee_correction WHERE product_id = ?', [d.P14]))[0]?.n);
      rowsOfP14.before = await count();
      save = await feeReviewApi.save(d.cy, d.P14, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: d.catE, reason: 'Second pending attempt' });
      rowsOfP14.after = await count();
    });
    await step('Assert: Expected 5 — HTTP 409 STL-1011 with the TC message; no new fee_correction row', async () => {
      expectRefused(save!, '[Expected 5]', 409, 1011);
      expect.soft(rowsOfP14.after, '[Expected 5] No new fee_correction row').toBe(rowsOfP14.before);
    });

    await step('Act: Step 6 — Run invariant query G again', async () => {
      dup = await select('invariant G (again)', G);
    });
    await step('Assert: Expected 6 — 0 rows', async () => {
      expect(dup, '[Expected 6] No key holds two PENDING corrections').toEqual([]);
    });
  });

  test('TC_US079_121 — Withdrawing returns the correction to editable, removes it from the queue and records it', async ({ page, feeReviewApi, seedData, feeReviewPage: list, secondSession }) => {
    const step = makeStep(page);
    const view = new SubmitHistoryView(page, list);
    await tcMeta(
      'TC_US079_121',
      'Critical',
      TAGS,
      `Withdrawing pending X on P14 through 회수 opens 승인 요청 회수 (product named, explanation, no reason field, 취소 / 회수); confirming shows the withdrawal toast, the row returns to 수정됨 — 미상신 with 수정 enabled and 회수 gone, the period report reads 회수됨, user B's queue no longer lists it, X is DRAFT / WITHDRAWN keeping CA1, CA1 is DRAFT / WITHDRAWN and one audit row change_approval.withdraw is written. Deviation: dev has no 검색 조건 (Search condition) dropdown — the product ID is typed in 검색어 (Keyword) only. Deviation: the audit query is narrowed to entity_id = CA1 (shared environment); its time is checked within 2 minutes of Step 3. ${SEED}`,
    );
    const d = { cy: 0, P14: '', X: '', ca1: 0, A: '', B: '' };
    const maker = getAccountDisplayName('submitter');
    const at = { from: 0, to: 0 };
    let x: DbRow | undefined;
    let ca: DbRow | undefined;
    let audit: DbRow[] = [];
    let queueSession: Awaited<ReturnType<typeof openApproverQueue>> | undefined;

    await step('Arrange: Pre-condition 1–13 — ROOT + ANNEX1, CY_MAIN open, X (P14 → B) submitted as CA1 by user A', async () => {
      const s = await seedData({ tc: 121, contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      Object.assign(d, { cy: s.cycles.CY_MAIN.id, P14: s.products.P14, A: s.master.categoryName.A, B: s.master.categoryName.B });
      d.X = await saveCorrection(feeReviewApi, d.cy, d.P14, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.B, reason: 'Wrong category mapped in commerce' });
      await submitCorrections(feeReviewApi, [d.X]);
      d.ca1 = await approvalIdOf(d.X);
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN, chip 기간 내 판매 상품, search the product ID of P14', async () => {
      await openFiltered(list, d.cy, d.P14);
    });
    await step('Assert: Expected 1 — The P14 row shows 승인 대기 and button 회수', async () => {
      await expect.soft(list.statusPills(list.row(d.P14)).nth(1), '[Expected 1] Second pill 승인 대기').toHaveText(FR_KO['state.PENDING']);
      await expect.soft(list.rowButton(list.row(d.P14), 'btn.withdraw'), '[Expected 1] 회수 (Withdraw) button').toBeVisible();
    });

    await step('Act: Step 2 — Click 회수 (Withdraw) on the P14 row', async () => {
      await list.openWithdraw(list.row(d.P14));
    });
    await step('Assert: Expected 2 — Dialog 승인 요청 회수 names the product, explains the effect, has no reason field and offers 취소 / 회수', async () => {
      await expect.soft(list.withdraw.title, '[Expected 2] Title 승인 요청 회수').toHaveText(FR_KO['withdraw.title']);
      await expect.soft(list.withdraw.productLine, '[Expected 2] Product name').toContainText('[T079] P14');
      await expect.soft(list.withdraw.productLine, '[Expected 2] Product ID').toContainText(d.P14);
      await expect.soft(list.withdraw.body, '[Expected 2] Explanation text').toContainText(FR_KO['withdraw.body']);
      await expect.soft(list.withdraw.reasonField, '[Expected 2] No reason field').toHaveCount(0);
      await expect.soft(list.withdraw.cancelButton, '[Expected 2] 취소 (Cancel) button').toBeVisible();
      await expect.soft(list.withdraw.confirmButton, '[Expected 2] 회수 (Withdraw) button').toBeVisible();
    });

    await step('Act: Step 3 — Click 회수 (Withdraw) in the dialog', async () => {
      at.from = Date.now();
      await list.withdraw.confirm();
      at.to = Date.now();
    });
    await step('Assert: Expected 3 — The dialog closes and the withdrawal toast shows', async () => {
      await expect.soft(list.withdraw.root, '[Expected 3] Dialog closed').toHaveCount(0);
      await expect.soft(list.toast(FR_KO['withdraw.done']), '[Expected 3] Toast "수정 건을 회수했습니다. …"').toBeVisible();
    });

    await step('Act: Step 4 — Read the P14 row', async () => {
      await list.row(d.P14).scrollIntoViewIfNeeded();
    });
    await step('Assert: Expected 4 — 수정됨 — 미상신, 회수 gone, 수정 enabled, A 12.50% in force with B 9.00% proposed beneath', async () => {
      const r = list.row(d.P14);
      await expect.soft(list.statusPills(r).nth(1), '[Expected 4] Second pill 수정됨 — 미상신').toHaveText(FR_KO['state.DRAFT']);
      await expect.soft(list.rowButton(r, 'btn.withdraw'), '[Expected 4] 회수 no longer shown').toHaveCount(0);
      await expect.soft(list.rowButton(r, 'btn.correct'), '[Expected 4] 수정 enabled').toBeEnabled();
      await expect.soft(list.cell(r, 'category'), `[Expected 4] ${d.A} in force`).toHaveText(new RegExp(`^\\s*${esc(d.A)}`));
      await expect.soft(list.cell(r, 'rate'), '[Expected 4] 12.50% in force').toHaveText(/^\s*12\.50%/);
      await expect.soft(list.secondLine(list.cell(r, 'category')), `[Expected 4] ${d.B} proposed`).toContainText(d.B);
      await expect.soft(list.secondLine(list.cell(r, 'rate')), '[Expected 4] 9.00% proposed').toContainText('9.00%');
    });

    await step('Act: Step 5 — Click 이번 기 수정 내역 (Changes this period) and find the P14 row', async () => {
      await list.openReport();
      await list.report.showLatest();
    });
    await step('Assert: Expected 5 — The P14 row reads 승인 = 회수됨 (Withdrawn)', async () => {
      await expect.soft(list.report.cell(view.reportRow(d.P14), 'approval'), '[Expected 5] 승인 (Approval) = 회수됨').toContainText(FR_KO['outcome.WITHDRAWN']);
      await list.report.close();
    });

    await step('Act: Step 6 — As user B open 변경 승인 with 원장 = 수수료 규칙 (Fee Rule)', async () => {
      queueSession = await openApproverQueue(secondSession);
    });
    await step('Assert: Expected 6 — No pending Fee Rule record for P14 is listed', async () => {
      await expect(view.queueRecord(queueSession!.queue, `${d.cy}/${d.P14}/NORMAL`), '[Expected 6] P14 record no longer listed').toHaveCount(0);
    });

    await step('Act: Step 7 — Read X and CA1', async () => {
      x = await correctionRow(d.X);
      ca = await approvalRow(d.ca1);
    });
    await step('Assert: Expected 7 — X DRAFT / WITHDRAWN / submission_no 1 / CA1 kept / pending_key NULL; CA1 DRAFT / WITHDRAWN', async () => {
      expect.soft(x?.state, '[Expected 7] X state DRAFT').toBe('DRAFT');
      expect.soft(x?.last_return_cause, '[Expected 7] X last_return_cause WITHDRAWN').toBe('WITHDRAWN');
      expect.soft(Number(x?.submission_no), '[Expected 7] X submission_no 1').toBe(1);
      expect.soft(Number(x?.change_approval_id), '[Expected 7] X keeps change_approval_id CA1').toBe(d.ca1);
      expect.soft(x?.pending_key ?? null, '[Expected 7] X pending_key NULL').toBeNull();
      expect.soft(ca?.approval_status, '[Expected 7] CA1 approval_status DRAFT').toBe('DRAFT');
      expect.soft(ca?.returned_cause, '[Expected 7] CA1 returned_cause WITHDRAWN').toBe('WITHDRAWN');
    });

    await step('Act: Step 8 — Read the latest change_approval.withdraw audit row', async () => {
      audit = await select('withdraw audit', "SELECT ts, actor, action, entity_id FROM audit_log WHERE action = 'change_approval.withdraw' AND entity_id = ? ORDER BY ts DESC LIMIT 1", [d.ca1]);
    });
    await step('Assert: Expected 8 — One row: actor user A, change_approval.withdraw, entity_id CA1, at the time of step 3', async () => {
      expect.soft(audit, '[Expected 8] One audit row').toHaveLength(1);
      expect.soft(String(audit[0]?.actor ?? ''), '[Expected 8] actor user A').toMatch(identity(maker));
      expect.soft(audit[0]?.action, '[Expected 8] action').toBe('change_approval.withdraw');
      expect.soft(Number(audit[0]?.entity_id), '[Expected 8] entity_id CA1').toBe(d.ca1);
      const ts = new Date(String(audit[0]?.ts ?? '')).getTime();
      expect.soft(ts, '[Expected 8] ts at the time of step 3').toBeGreaterThanOrEqual(at.from - 120_000);
      expect.soft(ts, '[Expected 8] ts at the time of step 3').toBeLessThanOrEqual(at.to + 120_000);
    });
  });

  test('TC_US079_122 — A withdrawn correction can be edited and submitted again without being recreated', async ({ page, feeReviewApi, seedData, feeReviewPage: list, secondSession }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US079_122',
      'High',
      TAGS,
      `After X (P14 → B) is submitted and withdrawn, 수정 reopens X with category B (팬클럽 키트), 9.00% and the earlier reason; saving a new reason shows "승인 요청으로 상신되었습니다. 요율이 변경됩니다." but leaves 수정됨 — 미상신; Submit selected sends it again — the same correction X and the same approval record CA1 return to PENDING (target_row_ref X/1, no new record) and user B sees the new reason. Note: the recon of 01/10 showed the dialog on an existing draft preselecting "— 변경 없음 —" with B disabled and an empty reason — Expected 1 and Step 2 are expected to fail on dev. ${SEARCH_DEV} ${SEED}`,
    );
    const d = { cy: 0, P14: '', X: '', ca1: 0, B: '' };
    const OLD = 'Wrong category mapped in commerce';
    const NEW = 'Wrong category mapped in commerce — resubmitted after withdrawal';
    let rows: DbRow[] = [];
    let approvals: DbRow[] = [];
    let queueSession: Awaited<ReturnType<typeof openApproverQueue>> | undefined;

    await step('Arrange: Pre-condition 1–14 — ROOT + ANNEX1, CY_MAIN open, X (P14 → B) submitted as CA1 then withdrawn', async () => {
      const s = await seedData({ tc: 122, contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      Object.assign(d, { cy: s.cycles.CY_MAIN.id, P14: s.products.P14, B: s.master.categoryName.B });
      d.X = await saveCorrection(feeReviewApi, d.cy, d.P14, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.B, reason: OLD });
      await submitCorrections(feeReviewApi, [d.X]);
      d.ca1 = await approvalIdOf(d.X);
      await decide(feeReviewApi.withdraw(d.X), 'withdraw X', [200, 204]);
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN, find P14 and click 수정 (Correct)', async () => {
      await openFiltered(list, d.cy, d.P14);
      await list.openCorrect(list.row(d.P14));
    });
    await step('Assert: Expected 1 — The dialog opens on X with category B (팬클럽 키트), 9.00% and the earlier reason filled in', async () => {
      const chosen = list.correct.tier1Select.locator('option:checked');
      await expect.soft(chosen, `[Expected 1] Category ${d.B} selected`).toHaveText(new RegExp(`^\\s*${esc(d.B)}`));
      await expect.soft(chosen, '[Expected 1] Rate 9.00%').toContainText('9.00%');
      await expect.soft(list.correct.reasonInput, '[Expected 1] Earlier reason filled in').toHaveValue(OLD);
    });

    await step('Act: Step 2 — Keep category B, replace the reason and click 저장 (Save)', async () => {
      await list.correct.reasonInput.fill(NEW);
      if (!(await list.correct.saveButton.isEnabled())) throw new Error('저장 (Save) stays disabled with category B kept — the dialog does not carry the withdrawn correction');
      await list.correct.save();
    });
    await step('Assert: Expected 2 — The dialog closes and toast "승인 요청으로 상신되었습니다. 요율이 변경됩니다." shows', async () => {
      await expect.soft(list.correct.root, '[Expected 2] Dialog closed').toHaveCount(0);
      await expect.soft(list.toast(FR_KO['fix.savedDraft']), '[Expected 2] Toast').toBeVisible();
    });

    await step('Act: Step 3 — Read the P14 row', async () => {
      await list.row(d.P14).scrollIntoViewIfNeeded();
    });
    await step('Assert: Expected 3 — The second pill reads 수정됨 — 미상신 (the save did not submit it)', async () => {
      await expect(list.statusPills(list.row(d.P14)).nth(1), '[Expected 3] Second pill 수정됨 — 미상신').toHaveText(FR_KO['state.DRAFT']);
    });

    await step('Act: Step 4 — Tick P14 and click 선택 일괄 상신 (Submit selected)', async () => {
      await list.rowCheckbox(list.row(d.P14)).check();
      await list.submitSelected();
    });
    await step('Assert: Expected 4 — Toast "수정 1건을 승인 요청으로 상신했습니다."; the pill reads 승인 대기', async () => {
      await expect.soft(list.toast(frFormat(FR_KO['msg.submitted'], { n: 1 })), '[Expected 4] Toast').toBeVisible();
      await expect.soft(list.statusPills(list.row(d.P14)).nth(1), '[Expected 4] Second pill 승인 대기').toHaveText(FR_KO['state.PENDING']);
    });

    await step('Act: Step 5 — Read the corrections of P14 / CY_MAIN / NORMAL', async () => {
      rows = await select('corrections of the key', "SELECT * FROM fee_correction WHERE product_id = ? AND settlement_cycle_id = ? AND policy = 'NORMAL'", [d.P14, d.cy]);
    });
    await step('Assert: Expected 5 — One row only, id X: PENDING, CA1, submission_no 1, last_return_cause NULL, the new reason', async () => {
      expect.soft(rows.map((r) => String(r.id)), '[Expected 5] One row only — X').toEqual([d.X]);
      expect.soft(rows[0]?.state, '[Expected 5] state PENDING').toBe('PENDING');
      expect.soft(Number(rows[0]?.change_approval_id), '[Expected 5] change_approval_id CA1').toBe(d.ca1);
      expect.soft(Number(rows[0]?.submission_no), '[Expected 5] submission_no 1').toBe(1);
      expect.soft(rows[0]?.last_return_cause ?? null, '[Expected 5] last_return_cause NULL').toBeNull();
      expect.soft(rows[0]?.reason, '[Expected 5] reason = the new text').toBe(NEW);
    });

    await step('Act: Step 6 — Read the Fee Rule approval records of the key', async () => {
      approvals = await select('approvals of the key', "SELECT * FROM change_approval WHERE target_type = 'FEE_RULE' AND target_ref = ?", [`${d.cy}/${d.P14}/NORMAL`]);
    });
    await step('Assert: Expected 6 — One row only: CA1, PENDING, target_row_ref X/1, returned_cause NULL', async () => {
      expect.soft(approvals.map((a) => Number(a.id)), '[Expected 6] One row only — CA1').toEqual([d.ca1]);
      expect.soft(approvals[0]?.approval_status, '[Expected 6] approval_status PENDING').toBe('PENDING');
      expect.soft(approvals[0]?.target_row_ref, '[Expected 6] target_row_ref X/1').toBe(`${d.X}/1`);
      expect.soft(approvals[0]?.returned_cause ?? null, '[Expected 6] returned_cause NULL').toBeNull();
    });

    await step('Act: Step 7 — As user B open 변경 승인, 원장 = 수수료 규칙, and open the P14 record', async () => {
      queueSession = await secondSession('approver');
      await queueSession.queue.openRequest({ register: REGISTER, requester: getAccountDisplayName('submitter'), changeApprovalId: d.ca1, reason: NEW });
    });
    await step('Assert: Expected 7 — 사유 (기안자) (Reason (maker)) shows the new reason', async () => {
      await expect(queueSession!.queue.reasonBlock, '[Expected 7] 사유 (기안자)').toHaveText(NEW);
    });
  });

  test('TC_US079_125 — Cancelling the withdraw dialog leaves the correction awaiting approval', async ({ page, feeReviewApi, seedData, feeReviewPage: list, secondSession }) => {
    const step = makeStep(page);
    const view = new SubmitHistoryView(page, list);
    await tcMeta(
      'TC_US079_125',
      'Low',
      TAGS,
      `Closing 승인 요청 회수 with 취소 (Cancel) or with × leaves pending X on P14 untouched: no toast, the row still reads 승인 대기 with 회수, X stays PENDING on CA1 and user B's queue still lists the record. ${SEARCH_DEV} ${SEED}`,
    );
    const d = { cy: 0, P14: '', X: '', ca1: 0 };
    let x: DbRow | undefined;
    let ca: DbRow | undefined;
    let queueSession: Awaited<ReturnType<typeof openApproverQueue>> | undefined;
    const rowUnchanged = async (n: number) => {
      const r = list.row(d.P14);
      await expect.soft(list.withdraw.root, `[Expected ${n}] Dialog closed`).toHaveCount(0);
      await expect.soft(page.getByText(FR_KO['withdraw.done']), `[Expected ${n}] No toast`).toHaveCount(0);
      await expect.soft(list.statusPills(r).nth(1), `[Expected ${n}] Row still 승인 대기`).toHaveText(FR_KO['state.PENDING']);
      await expect.soft(list.rowButton(r, 'btn.withdraw'), `[Expected ${n}] 회수 (Withdraw) still shown`).toBeVisible();
    };

    await step('Arrange: Pre-condition 1–13 — ROOT + ANNEX1, CY_MAIN open, X (P14 → B) submitted as CA1', async () => {
      const s = await seedData({ tc: 125, contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      Object.assign(d, { cy: s.cycles.CY_MAIN.id, P14: s.products.P14 });
      d.X = await saveCorrection(feeReviewApi, d.cy, d.P14, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.B, reason: 'Wrong category mapped in commerce' });
      await submitCorrections(feeReviewApi, [d.X]);
      d.ca1 = await approvalIdOf(d.X);
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN, find P14 and click 회수 (Withdraw)', async () => {
      await openFiltered(list, d.cy, d.P14);
      await list.openWithdraw(list.row(d.P14));
    });
    await step('Assert: Expected 1 — Dialog 승인 요청 회수 opens', async () => {
      await expect(list.withdraw.title, '[Expected 1] 승인 요청 회수 dialog').toHaveText(FR_KO['withdraw.title']);
    });

    await step('Act: Step 2 — Click 취소 (Cancel)', async () => {
      await list.click(list.withdraw.cancelButton, '취소 (Cancel) in the withdraw dialog');
    });
    await step('Assert: Expected 2 — The dialog closes with no toast; the row still shows 승인 대기 and 회수', async () => {
      await rowUnchanged(2);
    });

    await step('Act: Step 3 — Click 회수 on the row again, then × in the dialog header', async () => {
      await list.openWithdraw(list.row(d.P14));
      await list.click(view.withdrawCornerClose, '× (Close) in the withdraw dialog header');
    });
    await step('Assert: Expected 3 — The dialog closes with no toast; the row is unchanged as in step 2', async () => {
      await rowUnchanged(3);
    });

    await step('Act: Step 4 — Read X and CA1', async () => {
      x = await correctionRow(d.X);
      ca = await approvalRow(d.ca1);
    });
    await step('Assert: Expected 4 — X PENDING with pending_key set and CA1; CA1 PENDING', async () => {
      expect.soft(x?.state, '[Expected 4] X state PENDING').toBe('PENDING');
      expect.soft(x?.pending_key, '[Expected 4] X pending_key set').toBeTruthy();
      expect.soft(Number(x?.change_approval_id), '[Expected 4] X change_approval_id CA1').toBe(d.ca1);
      expect.soft(ca?.approval_status, '[Expected 4] CA1 approval_status PENDING').toBe('PENDING');
    });

    await step('Act: Step 5 — As user B open 변경 승인 with 원장 = 수수료 규칙 (Fee Rule)', async () => {
      queueSession = await openApproverQueue(secondSession);
    });
    await step('Assert: Expected 5 — The P14 Fee Rule record is still listed as pending', async () => {
      const record = view.queueRecord(queueSession!.queue, `${d.cy}/${d.P14}/NORMAL`);
      await expect.soft(record, '[Expected 5] P14 record listed').toHaveCount(1);
      await expect.soft(record, '[Expected 5] P14 record pending').toContainText(FR_KO['state.PENDING']);
    });
  });

  test('TC_US079_151 — One submission is one history entry with a line per changed field', async ({ page, feeReviewApi, approverFeeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const view = new SubmitHistoryView(page, list);
    await tcMeta(
      'TC_US079_151',
      'Medium',
      TAGS,
      `P14's approved submission (A → B, 12.50% → 9.00%) is one 변경 이력 entry by user A with two lines (수수료 카테고리, 수수료율), the reason 카테고리 오매핑 정정 and the approval outcome on the same entry; the history API returns one entry with CATEGORY and RATE changes; P05's applied A → D (rate unchanged) has a single category line. Note: dev renders the rate line without the % sign (recon 01/10) — the TC text "12.50% → 9.00%" is asserted. ${SEED}`,
    );
    const d = { cy: 0, P14: '', P05: '', A: '', B: '', D: '' };
    const maker = getAccountDisplayName('submitter');
    const REASON = '카테고리 오매핑 정정';
    let api: Array<Record<string, unknown>> = [];
    const states = Object.entries(FR_KO).filter(([k]) => k.startsWith('state.') || k.startsWith('outcome.')).map(([, v]) => v);

    await step('Arrange: Pre-condition 1–15 — ROOT (R_A, R_D) + ANNEX1 (R_B9), CY_MAIN; X on P14 submitted and approved; X5 on P05 applied', async () => {
      const s = await seedData({
        tc: 151,
        contracts: family({ ROOT: ['R_A', 'R_D'], ANNEX1: ['R_B9'] }),
        cycles: ['CY_MAIN'],
        products: [product('P05', [{ cycle: 'CY_MAIN', saleLines: 151 }]), product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])],
      });
      Object.assign(d, { cy: s.cycles.CY_MAIN.id, P14: s.products.P14, P05: s.products.P05, A: s.master.categoryName.A, B: s.master.categoryName.B, D: s.master.categoryName.D });
      const X = await saveCorrection(feeReviewApi, d.cy, d.P14, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.B, reason: REASON });
      await submitCorrections(feeReviewApi, [X]);
      await decide(approverFeeReviewApi.approve(await approvalIdOf(X)), 'approve CA1');
      await saveCorrection(feeReviewApi, d.cy, d.P05, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.D, reason: 'Wrong category mapped in commerce' });
      expect((await feeReviewApi.row(d.cy, d.P05)).correction?.state, 'Pre-condition 14: P05 correction APPLIED').toBe('APPLIED');
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN, keyword P14 + Enter, click 이력 (History) on P14', async () => {
      await openFiltered(list, d.cy, d.P14, 'enter');
      await list.openHistory(list.row(d.P14));
    });
    await step('Assert: Expected 1 — One entry by user A with two lines (category A → B, rate 12.50% → 9.00%), the reason, outcome on the same entry', async () => {
      for (const [i, key] of (['hist.colWhen', 'hist.colWho', 'hist.colSetting', 'hist.colChange', 'hist.colReason'] as const).entries()) {
        await expect.soft(list.history.headers.nth(i), `[Expected 1] Column ${i + 1} ${FR_KO[key]}`).toHaveText(FR_KO[key]);
      }
      const entry = list.history.rows.first();
      await expect.soft(list.history.rows, '[Expected 1] Exactly one entry for the submission').toHaveCount(1);
      await expect.soft(list.history.cell(entry, 'who'), '[Expected 1] Who = user A').toHaveText(maker);
      await expect.soft(view.historyLines(entry, 'setting'), '[Expected 1] Two field lines: 수수료 카테고리, 수수료율').toHaveText([FR_KO['hist.fieldCategory'], FR_KO['hist.fieldRate']]);
      const changes = view.historyLines(entry, 'change').filter({ hasText: '→' });
      await expect.soft(changes, '[Expected 1] Two change lines').toHaveCount(2);
      await expect.soft(changes.nth(0), `[Expected 1] 수수료 카테고리 ${d.A} → ${d.B}`).toHaveText(`${d.A} → ${d.B}`);
      await expect.soft(changes.nth(1), '[Expected 1] 수수료율 12.50% → 9.00%').toHaveText('12.50% → 9.00%');
      await expect.soft(list.history.cell(entry, 'reason'), `[Expected 1] Reason ${REASON}`).toHaveText(REASON);
      const setting = (await list.history.cell(entry, 'setting').innerText()).trim();
      expect.soft(states.filter((s) => setting.includes(s)), '[Expected 1] 항목 (Setting) holds field names only, never a status').toEqual([]);
      await expect.soft(list.history.cell(entry, 'change'), '[Expected 1] The approval outcome sits on the same entry').toContainText(FR_KO['state.APPROVED']);
    });

    await step('Act: Step 2 — GET the history of P14', async () => {
      api = await feeReviewApi.history(d.cy, d.P14);
    });
    await step('Assert: Expected 2 — One entry whose changes list has two items, CATEGORY and RATE', async () => {
      expect.soft(api, '[Expected 2] One entry').toHaveLength(1);
      const changes = (api[0]?.changes ?? []) as unknown[];
      expect.soft(changes, '[Expected 2] Two change items').toHaveLength(2);
      expect.soft(JSON.stringify(changes), '[Expected 2] A CATEGORY item').toContain('CATEGORY');
      expect.soft(JSON.stringify(changes), '[Expected 2] A RATE item').toContain('RATE');
    });

    await step('Act: Step 3 — Close the dialog, keyword P05 + Enter, click 이력 (History) on P05', async () => {
      await list.history.close();
      await searchKeyword(list, d.P05, 'enter');
      await list.openHistory(list.row(d.P05));
    });
    await step('Assert: Expected 3 — One entry with a single line 수수료 카테고리 A → D and no 수수료율 line', async () => {
      const entry = list.history.rows.first();
      await expect.soft(list.history.rows, '[Expected 3] One entry').toHaveCount(1);
      await expect.soft(view.historyLines(entry, 'setting'), '[Expected 3] A single 수수료 카테고리 line').toHaveText([FR_KO['hist.fieldCategory']]);
      await expect.soft(view.historyLines(entry, 'change').filter({ hasText: '→' }), `[Expected 3] ${d.A} → ${d.D}`).toHaveText([`${d.A} → ${d.D}`]);
      await expect.soft(list.history.cell(entry, 'setting'), '[Expected 3] No 수수료율 line').not.toContainText(FR_KO['hist.fieldRate']);
    });
  });

  test("TC_US079_152 — A rejected entry shows the approver's reason in its own block with the target struck through", async ({ page, feeReviewApi, approverFeeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const view = new SubmitHistoryView(page, list);
    await tcMeta(
      'TC_US079_152',
      'Medium',
      TAGS,
      `After user B rejects Y (P03 B → A), 변경 이력 shows user A's entry with lines B → A and 9.00% → 12.50% with the targets A and 12.50% struck through, the maker reason in 사유, a separate 반려 사유 block with user B's name and the reject text, and the footer "${FR_KO['hist.footer']}". Note: dev renders the rate line without the % sign (recon 01/10) — the TC text is asserted. ${SEED}`,
    );
    const d = { cy: 0, P03: '', ca2: 0, A: '', B: '' };
    const MAKER_REASON = 'Wrong category mapped in commerce';
    const REJECT = '계약 근거 부족 — 계약서 재확인 필요';
    let rejected: { status: number; approvalStatus?: string } = { status: 0 };

    await step('Arrange: Pre-condition 1–13 — ROOT + ANNEX1, CY_MAIN, Y (P03 → A) submitted as CA2, awaiting approval', async () => {
      const s = await seedData({ tc: 152, contracts: family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P03', [{ cycle: 'CY_MAIN', saleLines: 77 }])] });
      Object.assign(d, { cy: s.cycles.CY_MAIN.id, P03: s.products.P03, A: s.master.categoryName.A, B: s.master.categoryName.B });
      const Y = await saveCorrection(feeReviewApi, d.cy, d.P03, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.A, reason: MAKER_REASON });
      await submitCorrections(feeReviewApi, [Y]);
      d.ca2 = await approvalIdOf(Y);
    });

    await step('Act: Step 1 — As user B reject CA2 with the reason', async () => {
      const res = await approverFeeReviewApi.reject(d.ca2, REJECT);
      rejected = { status: res.status, approvalStatus: String((await approverFeeReviewApi.approval(d.ca2)).body?.approvalStatus ?? '') };
    });
    await step('Assert: Expected 1 — HTTP 200; CA2 approvalStatus = REJECTED', async () => {
      expect.soft(rejected.status, '[Expected 1] HTTP 200').toBe(200);
      expect.soft(rejected.approvalStatus, '[Expected 1] approvalStatus REJECTED').toBe('REJECTED');
    });

    await step('Act: Step 2 — As user A open the screen on CY_MAIN, keyword P03 + Enter, click 이력 (History) on P03', async () => {
      await openFiltered(list, d.cy, d.P03, 'enter');
      await list.openHistory(list.row(d.P03));
    });
    await step("Assert: Expected 2 — Lines B → A and 9.00% → 12.50% with targets struck through, maker reason, a separate 반려 사유 block, the footer", async () => {
      const entry = list.history.rows.filter({ has: page.getByRole('cell', { name: getAccountDisplayName('submitter'), exact: true }) }).first();
      const change = list.history.cell(entry, 'change');
      const lines = view.historyLines(entry, 'change').filter({ hasText: '→' });
      await expect.soft(lines.nth(0), `[Expected 2] 수수료 카테고리 ${d.B} → ${d.A}`).toHaveText(`${d.B} → ${d.A}`);
      await expect.soft(lines.nth(1), '[Expected 2] 수수료율 9.00% → 12.50%').toHaveText('9.00% → 12.50%');
      await expect.soft(view.struck(change).filter({ hasText: d.A }), `[Expected 2] Target ${d.A} struck through`).toHaveCount(1);
      await expect.soft(view.struck(change).filter({ hasText: '12.50' }), '[Expected 2] Target 12.50% struck through').toHaveCount(1);
      await expect.soft(list.history.cell(entry, 'reason'), "[Expected 2] The maker's reason in 사유").toContainText(MAKER_REASON);
      const block = view.historyRejectBlock(entry);
      await expect.soft(block, '[Expected 2] 반려 사유 (Reject reason) block').toContainText(FR_KO['hist.rejectReason']);
      await expect.soft(block, "[Expected 2] User B's name in the block").toContainText(getAccountDisplayName('approver'));
      await expect.soft(block, '[Expected 2] The reject reason in the block').toContainText(REJECT);
      await expect.soft(block, "[Expected 2] Not merged into the maker's reason").not.toContainText(MAKER_REASON);
      await expect.soft(list.history.footer, '[Expected 2] Footer').toHaveText(FR_KO['hist.footer']);
    });
  });

  test('TC_US079_153 — An auto-retired entry is attributed to system and sits above the entry that created it', async ({ page, feeReviewApi, approverFeeReviewApi, contractsApi, approverContractsApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US079_153',
      'Medium',
      TAGS,
      `Y2 (P10 typed 6.75%) retired by a new contract row R_A8 (8%) and X (P14 → B) retired by commerce assigning B themselves each show, newest first, a 변경 이력 entry by system with a plain-words reason (no internal code) directly above user A's entry; fee_correction_history holds the SYSTEM / RETIRED row after user A's row. Not automated: that the system reason "says in plain words" why it retired — only its presence and the absence of internal codes are asserted. ${PRIVATE}`,
    );
    const d = { cy: 0, P10: '', P14: '', Y2: '', A: '', B: '' };
    const maker = getAccountDisplayName('submitter');
    let history: DbRow[] = [];
    const systemOnTop = async (n: number) => {
      const top = list.history.rows.nth(0);
      await expect.soft(list.history.cell(top, 'who'), `[Expected ${n}] Top entry Who = system`).toHaveText(/^\s*system\s*$/i);
      const reason = (await list.history.cell(top, 'reason').innerText()).trim();
      expect.soft(reason, `[Expected ${n}] System entry carries a reason`).not.toBe('');
      expect.soft(reason, `[Expected ${n}] No internal code in the reason`).not.toMatch(INTERNAL_CODE);
      await expect.soft(list.history.cell(list.history.rows.nth(1), 'who'), `[Expected ${n}] User A's entry directly below`).toHaveText(maker);
    };

    await step('Arrange: Pre-condition 1–18 — Y2 (P10 6.75%) and X (P14 → B) approved, then retired by row R_A8 and by commerce assigning B', async () => {
      const s = await seedData({
        tc: 153,
        private: true,
        contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }),
        cycles: ['CY_MAIN'],
        products: [product('P10', [{ cycle: 'CY_MAIN', saleLines: 86 }]), product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])],
      });
      Object.assign(d, { cy: s.cycles.CY_MAIN.id, P10: s.products.P10, P14: s.products.P14, A: s.master.categoryName.A, B: s.master.categoryName.B });
      d.Y2 = await saveCorrection(feeReviewApi, d.cy, d.P10, { policy: 'NORMAL', tier: 'RATE_OVERRIDE', overrideRate: '6.75', reason: 'Side letter rate agreed with the label' });
      const X = await saveCorrection(feeReviewApi, d.cy, d.P14, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.B, reason: '카테고리 오매핑 정정' });
      await submitCorrections(feeReviewApi, [d.Y2, X]);
      for (const id of [d.Y2, X]) await decide(approverFeeReviewApi.approve(await approvalIdOf(id)), `approve ${id}`);
      const added = await contractsApi.addFeeRow<{ changeApprovalId?: number | null }>(s.family.contracts.ROOT, {
        key: { categoryId: s.master.category.A, saleTypeId: s.master.saleType.ST2, policy: 'NORMAL' },
        commissionType: 'PERCENT',
        commission: 8,
        effectiveFrom: '2020-01-01',
        pgCommissionRate: 3,
        feeBase: 'PRODUCT_PRICE',
        pgFeeBase: 'PRODUCT_PRICE',
        changeReason: `[T079-${s.run}-153] R_A8`,
      });
      if (added.status >= 300) throw new Error(`Pre-condition 14: add row R_A8 → ${added.status}: ${JSON.stringify(added.body).slice(0, 300)}`);
      if (added.body?.changeApprovalId) await decide(approverContractsApi.approve(added.body.changeApprovalId), 'approve R_A8');
      await feeReviewDb.updateProduct(d.P14, { categoryId: s.master.category.B, defaultSlotFeeRowId: s.family.rows.R_B9 });
      await feeReviewApi.products(d.cy, { keyword: s.prefix });
      const states = await select('retired corrections', 'SELECT id, state FROM fee_correction WHERE id IN (?, ?)', [d.Y2, X]);
      expect(states.map((r) => r.state), 'Pre-condition 17: Y2 and X are RETIRED').toEqual(['RETIRED', 'RETIRED']);
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN, keyword P10 + Enter, click 이력 (History)', async () => {
      await openFiltered(list, d.cy, d.P10, 'enter');
      await list.openHistory(list.row(d.P10));
    });
    await step("Assert: Expected 1 — Top: system, 6.75% → 8.00%, plain reason; directly below: user A's 6.75% entry with its basis", async () => {
      await systemOnTop(1);
      await expect.soft(list.history.cell(list.history.rows.nth(0), 'change'), '[Expected 1] 수수료율 6.75% → 8.00%').toContainText('6.75% → 8.00%');
      await expect.soft(list.history.cell(list.history.rows.nth(1), 'change'), '[Expected 1] User A typed 6.75%').toContainText('6.75%');
      await expect.soft(list.history.cell(list.history.rows.nth(1), 'reason'), '[Expected 1] Basis of user A').toContainText('Side letter rate agreed with the label');
    });

    await step('Act: Step 2 — Read the history rows of Y2 (newest first)', async () => {
      history = await select('history of Y2', 'SELECT at, who, outcome FROM fee_correction_history WHERE correction_id = ? ORDER BY at DESC', [d.Y2]);
    });
    await step("Assert: Expected 2 — Two rows: the SYSTEM / RETIRED row is later than user A's row", async () => {
      expect.soft(history, '[Expected 2] Two rows').toHaveLength(2);
      expect.soft(String(history[0]?.who ?? ''), '[Expected 2] Newest row by SYSTEM').toMatch(/^system$/i);
      expect.soft(history[0]?.outcome, '[Expected 2] Newest row RETIRED').toBe('RETIRED');
      expect.soft(String(history[1]?.who ?? ''), "[Expected 2] Older row by user A").toMatch(identity(maker));
      expect.soft(new Date(String(history[0]?.at)).getTime(), "[Expected 2] SYSTEM row later than user A's").toBeGreaterThan(new Date(String(history[1]?.at)).getTime());
    });

    await step('Act: Step 3 — Close the dialog, keyword P14 + Enter, click 이력 (History)', async () => {
      await list.history.close();
      await searchKeyword(list, d.P14, 'enter');
      await list.openHistory(list.row(d.P14));
    });
    await step("Assert: Expected 3 — Top: system with a plain reason; user A's A → B entry directly below", async () => {
      await systemOnTop(3);
      await expect.soft(list.history.cell(list.history.rows.nth(1), 'change'), `[Expected 3] User A's ${d.A} → ${d.B}`).toContainText(`${d.A} → ${d.B}`);
    });
  });

  test('TC_US079_154 — The report lists every correction of the cycle in every state with non-applied targets struck through', async ({ page, feeReviewApi, approverFeeReviewApi, contractsApi, approverContractsApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const view = new SubmitHistoryView(page, list);
    await tcMeta(
      'TC_US079_154',
      'High',
      TAGS,
      `CY_MAIN holds six corrections — P05 applied (no rate change), P14 approved, P10 retired (tier 2), P03 rejected, P04 withdrawn, P09 awaiting approval; 이번 기 수정 내역 lists the six with the eight columns, newest first, the applied ones not struck through and the rejected / withdrawn targets A / 12.50% struck through; the API gives each its approvalState and applied flag. Note: the page object records that dev lists the report oldest first — "newest first" is asserted per TC. ${PRIVATE}`,
    );
    const d = { cy: 0, A: '', B: '' };
    const P: Record<string, string> = {};
    let api: Array<Record<string, unknown>> = [];

    await step('Arrange: Pre-condition 1–24 — Six corrections in CY_MAIN: applied, approved, retired, rejected, withdrawn and pending', async () => {
      const s = await seedData({
        tc: 154,
        private: true,
        contracts: family({ ROOT: ['R_A', 'R_B10', 'R_PROMO', 'R_D'], ANNEX1: ['R_B9', 'R_C20'], ANNEX2: ['R_C22'] }),
        cycles: ['CY_MAIN'],
        products: [
          product('P03', [{ cycle: 'CY_MAIN', saleLines: 77 }]),
          product('P04', [{ cycle: 'CY_MAIN', saleLines: 114 }]),
          product('P05', [{ cycle: 'CY_MAIN', saleLines: 151 }]),
          product('P09', [{ cycle: 'CY_MAIN', saleLines: 49 }]),
          product('P10', [{ cycle: 'CY_MAIN', saleLines: 86 }]),
          product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }]),
        ],
      });
      d.cy = s.cycles.CY_MAIN.id;
      d.A = s.master.categoryName.A;
      d.B = s.master.categoryName.B;
      Object.assign(P, s.products);
      const cat = s.master.category;
      await saveCorrection(feeReviewApi, d.cy, P.P05, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: cat.D, reason: 'Wrong category mapped in commerce' });
      const X = await saveCorrection(feeReviewApi, d.cy, P.P14, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: cat.B, reason: '카테고리 오매핑 정정' });
      const Y2 = await saveCorrection(feeReviewApi, d.cy, P.P10, { policy: 'NORMAL', tier: 'RATE_OVERRIDE', overrideRate: '6.75', reason: 'Side letter rate agreed with the label' });
      const Y = await saveCorrection(feeReviewApi, d.cy, P.P03, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: cat.A, reason: 'Wrong category mapped in commerce' });
      const X4 = await saveCorrection(feeReviewApi, d.cy, P.P04, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: cat.A, reason: 'Ambiguous rows — use ALBUM until the contract is fixed' });
      const X9 = await saveCorrection(feeReviewApi, d.cy, P.P09, { policy: 'PROMOTION', tier: 'ASSIGNMENT', commissionCategoryId: cat.A, reason: 'Promotion ended — use ALBUM' });
      await submitCorrections(feeReviewApi, [X, Y2, Y, X4, X9]);
      for (const id of [X, Y2]) await decide(approverFeeReviewApi.approve(await approvalIdOf(id)), `approve ${id}`);
      await decide(approverFeeReviewApi.reject(await approvalIdOf(Y), '근거 계약 확인 필요'), 'reject Y');
      await decide(feeReviewApi.withdraw(X4), 'withdraw X4', [200, 204]);
      const added = await contractsApi.addFeeRow<{ changeApprovalId?: number | null }>(s.family.contracts.ROOT, {
        key: { categoryId: cat.A, saleTypeId: s.master.saleType.ST2, policy: 'NORMAL' },
        commissionType: 'PERCENT',
        commission: 8,
        effectiveFrom: '2020-01-01',
        pgCommissionRate: 3,
        feeBase: 'PRODUCT_PRICE',
        pgFeeBase: 'PRODUCT_PRICE',
        changeReason: `[T079-${s.run}-154] R_A8`,
      });
      if (added.status >= 300) throw new Error(`Pre-condition 21: add row R_A8 → ${added.status}: ${JSON.stringify(added.body).slice(0, 300)}`);
      if (added.body?.changeApprovalId) await decide(approverContractsApi.approve(added.body.changeApprovalId), 'approve R_A8');
      await feeReviewApi.products(d.cy, { keyword: s.prefix });
      expect(await feeReviewApi.periodCorrections(d.cy), 'Pre-condition 23: six corrections in the cycle').toHaveLength(6);
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN and click 이번 기 수정 내역 (Changes this period)', async () => {
      await list.open({ cycleId: d.cy });
      await list.openReport();
    });
    await step('Assert: Expected 1 — The eight columns, newest first, one row per correction — six rows', async () => {
      const cols = ['report.colProductId', 'report.colChange', 'report.colRate', 'report.colTier', 'report.colApproval', 'report.colWho', 'report.colWhen', 'report.colReason'] as const;
      for (const [i, key] of cols.entries()) await expect.soft(list.report.headers.nth(i), `[Expected 1] Column ${i + 1} ${FR_KO[key]}`).toHaveText(FR_KO[key]);
      await expect.soft(list.report.rows, '[Expected 1] Six rows').toHaveCount(6);
      const when = (await list.report.rows.locator('td:nth-child(7)').allTextContents()).map((t) => t.trim());
      expect.soft(when, '[Expected 1] Sorted newest first').toEqual([...when].sort().reverse());
    });

    await step('Act: Step 2 — Read the rows of P05, P14 and P10', async () => {
      await view.reportRow(P.P05).scrollIntoViewIfNeeded();
    });
    await step('Assert: Expected 2 — Applied rows, targets not struck through: P05 적용됨 (요율 변동 없음), P14 승인됨 — 적용 B / 9.00%, P10 자동 해제 (2단계)', async () => {
      const [p05, p14, p10] = [view.reportRow(P.P05), view.reportRow(P.P14), view.reportRow(P.P10)];
      await expect.soft(list.report.cell(p05, 'approval'), '[Expected 2] P05 적용됨 (요율 변동 없음)').toContainText(FR_KO['state.APPLIED']);
      await expect.soft(list.report.cell(p14, 'approval'), '[Expected 2] P14 승인됨 — 적용').toContainText(FR_KO['state.APPROVED']);
      await expect.soft(list.report.cell(p14, 'change'), `[Expected 2] P14 target ${d.B}`).toContainText(d.B);
      await expect.soft(list.report.cell(p14, 'rate'), '[Expected 2] P14 target 9.00%').toContainText('9.00%');
      await expect.soft(list.report.cell(p10, 'approval'), '[Expected 2] P10 자동 해제 — 더 이상 불필요').toContainText(FR_KO['state.RETIRED']);
      await expect.soft(list.report.cell(p10, 'tier'), '[Expected 2] P10 단계 = 2단계').toHaveText(FR_KO['report.tier2']);
      for (const [name, r] of [['P05', p05], ['P14', p14], ['P10', p10]] as const) {
        await expect.soft(view.struck(r), `[Expected 2] ${name}: target not struck through`).toHaveCount(0);
      }
    });

    await step('Act: Step 3 — Read the rows of P03 and P04', async () => {
      await view.reportRow(P.P03).scrollIntoViewIfNeeded();
    });
    await step('Assert: Expected 3 — Not applied: P03 반려됨 — 수정 후 재상신, P04 회수됨, each target A / 12.50% struck through', async () => {
      for (const [name, id, label] of [['P03', P.P03, FR_KO['state.REJECTED']], ['P04', P.P04, FR_KO['outcome.WITHDRAWN']]] as const) {
        const r = view.reportRow(id);
        await expect.soft(list.report.cell(r, 'approval'), `[Expected 3] ${name} ${label}`).toContainText(label);
        await expect.soft(view.struck(list.report.cell(r, 'change')).filter({ hasText: d.A }), `[Expected 3] ${name} target ${d.A} struck through`).toHaveCount(1);
        await expect.soft(view.struck(list.report.cell(r, 'rate')).filter({ hasText: '12.50%' }), `[Expected 3] ${name} target 12.50% struck through`).toHaveCount(1);
      }
    });

    await step('Act: Step 4 — Read the row of P09', async () => {
      await view.reportRow(P.P09).scrollIntoViewIfNeeded();
    });
    await step('Assert: Expected 4 — P09 승인 대기 (Awaiting approval)', async () => {
      await expect(list.report.cell(view.reportRow(P.P09), 'approval'), '[Expected 4] P09 승인 대기').toContainText(FR_KO['state.PENDING']);
    });

    await step('Act: Step 5 — GET the period corrections of CY_MAIN', async () => {
      api = (await feeReviewApi.periodCorrections(d.cy)) as unknown as Array<Record<string, unknown>>;
    });
    await step('Assert: Expected 5 — approvalState and applied per row', async () => {
      const want: Array<[string, string, boolean]> = [
        ['P05', 'APPLIED_NO_RATE_CHANGE', true],
        ['P14', 'APPROVED_APPLIED', true],
        ['P10', 'RETIRED', true],
        ['P03', 'REJECTED', false],
        ['P04', 'WITHDRAWN', false],
        ['P09', 'AWAITING_APPROVAL', false],
      ];
      for (const [name, state, applied] of want) {
        const item = api.find((c) => c.productId === P[name]);
        expect.soft(item?.approvalState, `[Expected 5] ${name} approvalState ${state}`).toBe(state);
        expect.soft(item?.applied, `[Expected 5] ${name} applied = ${applied}`).toBe(applied);
      }
    });
  });

  test('TC_US079_155 — A correction applied without approval shows the same detail and reads Applied (no rate change)', async ({ page, feeReviewApi, approverFeeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const view = new SubmitHistoryView(page, list);
    await tcMeta(
      'TC_US079_155',
      'High',
      TAGS,
      `P05's correction A → D applied at once (no approval) is listed in 이번 기 수정 내역 filling every column P14's approved correction fills — A → D, 12.50% → 12.50%, 1단계, 적용됨 (요율 변동 없음), user A, the save time, the reason — and the CSV export carries the same detail with Applied? = Y and Order lines affected = 151. Not automated: that 시점 equals the exact save time — its date-time format is asserted. ${PRIVATE}`,
    );
    const d = { cy: 0, P05: '', P14: '', A: '', D: '' };
    const maker = getAccountDisplayName('submitter');
    const REASON = 'Wrong category mapped in commerce';
    let csv: Record<string, string> | undefined;

    await step('Arrange: Pre-condition 1–15 — ROOT (R_A, R_D) + ANNEX1 (R_B9), CY_MAIN; X5 on P05 applied, X on P14 approved', async () => {
      const s = await seedData({
        tc: 155,
        private: true,
        contracts: family({ ROOT: ['R_A', 'R_D'], ANNEX1: ['R_B9'] }),
        cycles: ['CY_MAIN'],
        products: [product('P05', [{ cycle: 'CY_MAIN', saleLines: 151 }]), product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])],
      });
      Object.assign(d, { cy: s.cycles.CY_MAIN.id, P05: s.products.P05, P14: s.products.P14, A: s.master.categoryName.A, D: s.master.categoryName.D });
      await saveCorrection(feeReviewApi, d.cy, d.P05, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.D, reason: REASON });
      const X = await saveCorrection(feeReviewApi, d.cy, d.P14, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.B, reason: '카테고리 오매핑 정정' });
      await submitCorrections(feeReviewApi, [X]);
      await decide(approverFeeReviewApi.approve(await approvalIdOf(X)), 'approve CA1');
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN and click 이번 기 수정 내역 (Changes this period)', async () => {
      await list.open({ cycleId: d.cy });
      await list.openReport();
    });
    await step('Assert: Expected 1 — P05 is listed', async () => {
      await expect(view.reportRow(d.P05), '[Expected 1] P05 listed').toHaveCount(1);
    });

    await step('Act: Step 2 — Compare the P05 row with the P14 row column by column', async () => {
      await view.reportRow(d.P05).scrollIntoViewIfNeeded();
    });
    await step('Assert: Expected 2 — P05 fills every column P14 fills, with its own values', async () => {
      const r = view.reportRow(d.P05);
      await expect.soft(list.report.cell(r, 'productId'), '[Expected 2] 상품ID').toHaveText(d.P05);
      await expect.soft(list.report.cell(r, 'change'), `[Expected 2] 수정 내용 ${d.A} → ${d.D}`).toHaveText(`${d.A} → ${d.D}`);
      await expect.soft(list.report.cell(r, 'rate'), '[Expected 2] 요율 변동 12.50% → 12.50%').toHaveText('12.50% → 12.50%');
      await expect.soft(list.report.cell(r, 'tier'), '[Expected 2] 단계 1단계').toHaveText(FR_KO['report.tier1']);
      await expect.soft(list.report.cell(r, 'approval'), '[Expected 2] 승인 적용됨 (요율 변동 없음)').toContainText(FR_KO['state.APPLIED']);
      await expect.soft(list.report.cell(r, 'who'), '[Expected 2] 수행자 user A').toHaveText(maker);
      await expect.soft(list.report.cell(r, 'when'), '[Expected 2] 시점 the save time').toHaveText(DATE_TIME);
      await expect.soft(list.report.cell(r, 'reason'), '[Expected 2] 사유').toHaveText(REASON);
      const p14 = (await view.reportRow(d.P14).locator('td').allInnerTexts()).map((t) => t.trim());
      const p05 = (await r.locator('td').allInnerTexts()).map((t) => t.trim());
      p14.forEach((v, i) => {
        if (v) expect.soft(p05[i] ?? '', `[Expected 2] Column ${i + 1} filled for P05 as for P14`).not.toBe('');
      });
    });

    await step('Act: Step 3 — Click 내보내기 (Export), choose CSV, download and open the file', async () => {
      csv = csvRecord(await exportReportCsv(list), d.P05);
    });
    await step('Assert: Expected 3 — The P05 row of the file carries the same detail, Applied? = Y and Order lines affected = 151', async () => {
      expect(csv, '[Expected 3] P05 row in the file').toBeDefined();
      const checks: Array<[string, string[]]> = [
        ['Tier', ['Tier 1', FR_KO['report.tier1']]],
        ['Fields changed', ['Category', FR_EN['hist.fieldCategory'], FR_KO['hist.fieldCategory']]],
        ['Category before', [d.A]],
        ['Category after', [d.D]],
        ['Rate before', ['12.50%']],
        ['Rate after', ['12.50%']],
        ['Applied?', ['Y']],
        ['Approval state', [FR_EN['state.APPLIED'], FR_KO['state.APPLIED']]],
        ['Reason (maker)', [REASON]],
        ['Order lines affected', ['151']],
      ];
      for (const [column, accepted] of checks) expect.soft(csvMatches(csv?.[column], accepted), `[Expected 3] ${column} = ${accepted[0]} (file: "${csv?.[column]}")`).toBe(true);
      expect.soft(csv?.Maker ?? '', '[Expected 3] Maker = user A').toMatch(identity(maker));
    });
  });

  test('TC_US079_156 — A retired correction reads Retired — no longer needed and not Applied', async ({ page, feeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const view = new SubmitHistoryView(page, list);
    await tcMeta(
      'TC_US079_156',
      'Medium',
      TAGS,
      `P05's applied correction A → D reads 적용됨 (요율 변동 없음) until commerce assigns D itself (simulated with the TC's SQL UPDATE); then the row shows 자동 해제 — 더 이상 불필요 and the report and the CSV export read Retired — no longer needed, never Applied or "Retired — contract now covers it". ${PRIVATE}`,
    );
    const d = { cy: 0, P05: '', catD: 0 };
    let updated = -1;
    let csv: Record<string, string> | undefined;

    await step('Arrange: Pre-condition 1–12 — ROOT (R_A, R_D), CY_MAIN; X5 on P05 applied while commerce still holds A', async () => {
      const s = await seedData({ tc: 156, private: true, contracts: family({ ROOT: ['R_A', 'R_D'] }), cycles: ['CY_MAIN'], products: [product('P05', [{ cycle: 'CY_MAIN', saleLines: 151 }])] });
      Object.assign(d, { cy: s.cycles.CY_MAIN.id, P05: s.products.P05, catD: s.master.category.D });
      await saveCorrection(feeReviewApi, d.cy, d.P05, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: d.catD, reason: 'Wrong category mapped in commerce' });
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN, click 이번 기 수정 내역 and read the P05 row', async () => {
      await list.open({ cycleId: d.cy });
      await list.openReport();
    });
    await step('Assert: Expected 1 — P05 승인 = 적용됨 (요율 변동 없음)', async () => {
      await expect(list.report.cell(view.reportRow(d.P05), 'approval'), '[Expected 1] 적용됨 (요율 변동 없음)').toContainText(FR_KO['state.APPLIED']);
    });

    await step('Act: Step 2 — Simulate commerce assigning D (UPDATE fee_review_fixture_product)', async () => {
      updated = await feeReviewDb.execute('UPDATE fee_review_fixture_product SET category_id = ? WHERE product_id = ?', [d.catD, d.P05]);
    });
    await step('Assert: Expected 2 — 1 row updated', async () => {
      expect(updated, '[Expected 2] 1 row updated').toBe(1);
    });

    await step('Act: Step 3 — Close the dialog, chip 기간 내 판매 상품, keyword P05 + Enter', async () => {
      await list.report.close();
      await list.clickChip(list.chip('bucket.ALL'));
      await searchKeyword(list, d.P05, 'enter');
    });
    await step('Assert: Expected 3 — The P05 row shows 자동 해제 — 더 이상 불필요', async () => {
      await expect(list.statusPills(list.row(d.P05)).nth(1), '[Expected 3] Pill 자동 해제 — 더 이상 불필요').toHaveText(FR_KO['state.RETIRED']);
    });

    await step('Act: Step 4 — Click 이번 기 수정 내역 again and read the P05 row', async () => {
      await list.openReport();
    });
    await step('Assert: Expected 4 — 승인 = 자동 해제 — 더 이상 불필요, not any applied / contract wording', async () => {
      const cell = list.report.cell(view.reportRow(d.P05), 'approval');
      await expect.soft(cell, '[Expected 4] 자동 해제 — 더 이상 불필요').toContainText(FR_KO['state.RETIRED']);
      for (const wrong of [FR_KO['state.APPLIED'], 'Applied — no approval needed', '자동 해제 — 계약이 생김']) await expect.soft(cell, `[Expected 4] Does not read "${wrong}"`).not.toContainText(wrong);
    });

    await step('Act: Step 5 — Click 내보내기 (Export), choose CSV, download and open the file', async () => {
      csv = csvRecord(await exportReportCsv(list), d.P05);
    });
    await step('Assert: Expected 5 — The P05 row has Approval state = Retired — no longer needed', async () => {
      expect(csvMatches(csv?.['Approval state'], [FR_EN['state.RETIRED'], FR_KO['state.RETIRED']]), `[Expected 5] Approval state (file: "${csv?.['Approval state']}")`).toBe(true);
    });
  });

  test('TC_US079_157 — A withdrawn submission reads Withdrawn with Applied set to N', async ({ page, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const view = new SubmitHistoryView(page, list);
    await tcMeta(
      'TC_US079_157',
      'Medium',
      TAGS,
      `Through the UI, ambiguous P04 is corrected to A (toast "승인 요청으로 상신되었습니다. 요율이 변경됩니다.", 수정됨 — 미상신), submitted (승인 대기), then withdrawn from 승인 요청 회수 (no reason field, withdrawal toast, back to 수정됨 — 미상신); the report reads 회수됨 with A / 12.50% struck through and the CSV export reads Withdrawn with Applied? = N. ${PRIVATE}`,
    );
    const d = { cy: 0, P04: '', A: '' };
    const REASON = 'Ambiguous rows — use ALBUM until the contract is fixed';
    let csv: Record<string, string> | undefined;
    const pill = () => list.statusPills(list.row(d.P04)).nth(1);

    await step('Arrange: Pre-condition 1–13 — ROOT (R_A) + ANNEX1 (R_C20) + ANNEX2 (R_C22), CY_MAIN; P04 ambiguous, no correction', async () => {
      const s = await seedData({
        tc: 157,
        private: true,
        contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_C20'], ANNEX2: ['R_C22'] }),
        cycles: ['CY_MAIN'],
        products: [product('P04', [{ cycle: 'CY_MAIN', saleLines: 114 }])],
      });
      Object.assign(d, { cy: s.cycles.CY_MAIN.id, P04: s.products.P04, A: s.master.categoryName.A });
    });

    await step('Act: Step 1 — Find P04 (keyword + Enter), click 수정, pick category A, type the reason and click 저장 (Save)', async () => {
      await openFiltered(list, d.cy, d.P04, 'enter');
      await list.openCorrect(list.row(d.P04));
      await list.correct.pickCategory(d.A);
      await list.correct.reasonInput.fill(REASON);
      await list.correct.save();
    });
    await step('Assert: Expected 1 — Toast "승인 요청으로 상신되었습니다. 요율이 변경됩니다."; pill 수정됨 — 미상신', async () => {
      await expect.soft(list.toast(FR_KO['fix.savedDraft']), '[Expected 1] Toast').toBeVisible();
      await expect.soft(pill(), '[Expected 1] Pill 수정됨 — 미상신').toHaveText(FR_KO['state.DRAFT']);
    });

    await step('Act: Step 2 — Tick P04 and click 선택 일괄 상신 (Submit selected)', async () => {
      await list.rowCheckbox(list.row(d.P04)).check();
      await list.submitSelected();
    });
    await step('Assert: Expected 2 — Toast "수정 1건을 승인 요청으로 상신했습니다."; pill 승인 대기', async () => {
      await expect.soft(list.toast(frFormat(FR_KO['msg.submitted'], { n: 1 })), '[Expected 2] Toast').toBeVisible();
      await expect.soft(pill(), '[Expected 2] Pill 승인 대기').toHaveText(FR_KO['state.PENDING']);
    });

    await step('Act: Step 3 — Click 회수 (Withdraw) on the P04 row', async () => {
      await list.openWithdraw(list.row(d.P04));
    });
    await step('Assert: Expected 3 — The dialog states the correction leaves the queue, becomes editable and is recorded; no reason field', async () => {
      await expect.soft(list.withdraw.body, '[Expected 3] Explanation text').toContainText(FR_KO['withdraw.body']);
      await expect.soft(list.withdraw.reasonField, '[Expected 3] No reason field').toHaveCount(0);
    });

    await step('Act: Step 4 — Click 회수 (Withdraw) in 승인 요청 회수', async () => {
      await list.withdraw.confirm();
    });
    await step('Assert: Expected 4 — Withdrawal toast; pill back to 수정됨 — 미상신', async () => {
      await expect.soft(list.toast(FR_KO['withdraw.done']), '[Expected 4] Toast').toBeVisible();
      await expect.soft(pill(), '[Expected 4] Pill 수정됨 — 미상신').toHaveText(FR_KO['state.DRAFT']);
    });

    await step('Act: Step 5 — Click 이번 기 수정 내역 and read the P04 row', async () => {
      await list.openReport();
    });
    await step('Assert: Expected 5 — 승인 = 회수됨, target A / 12.50% struck through', async () => {
      const r = view.reportRow(d.P04);
      await expect.soft(list.report.cell(r, 'approval'), '[Expected 5] 회수됨').toContainText(FR_KO['outcome.WITHDRAWN']);
      await expect.soft(view.struck(list.report.cell(r, 'change')).filter({ hasText: d.A }), `[Expected 5] Target ${d.A} struck through`).toHaveCount(1);
      await expect.soft(view.struck(list.report.cell(r, 'rate')).filter({ hasText: '12.50%' }), '[Expected 5] Target 12.50% struck through').toHaveCount(1);
    });

    await step('Act: Step 6 — Click 내보내기 (Export), choose CSV, download and open the file', async () => {
      csv = csvRecord(await exportReportCsv(list), d.P04);
    });
    await step('Assert: Expected 6 — The P04 row has Approval state = Withdrawn and Applied? = N', async () => {
      expect.soft(csvMatches(csv?.['Approval state'], [FR_EN['outcome.WITHDRAWN'], FR_KO['outcome.WITHDRAWN']]), `[Expected 6] Approval state Withdrawn (file: "${csv?.['Approval state']}")`).toBe(true);
      expect.soft(csv?.['Applied?'], '[Expected 6] Applied? = N').toBe('N');
    });
  });

  test('TC_US079_158 — A rejected correction re-saved without a rate change keeps its rejection on the report', async ({ page, approverFeeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const view = new SubmitHistoryView(page, list);
    await tcMeta(
      'TC_US079_158',
      'Medium',
      TAGS,
      `P05 corrected to E through the UI, submitted and rejected by user B ("프로모션 기간 근거 없음"), then re-saved to D with no rate change (적용됨 (요율 변동 없음)); the period report, 변경 이력 and the CSV still show the rejection (E / 9.50% struck through, the reject reason). Remark: the build turns the correction APPLIED and clears lastReturnCause, so the rejection disappears — Expected 5 and 7 are expected to FAIL. Deviation: user B's record id is read from fee_correction.change_approval_id instead of searching GET change-approvals by targetRef. ${PRIVATE}`,
    );
    const d = { cy: 0, P05: '', D: '', E: '' };
    const REJECT = '프로모션 기간 근거 없음';
    const FIRST = 'Promotion category per label request';
    let rejected = 0;
    const opened = { option: '', reason: '' };
    let csv: Record<string, string> | undefined;
    const pill = () => list.statusPills(list.row(d.P05)).nth(1);

    await step('Arrange: Pre-condition 1–11 — ROOT (R_A, R_PROMO, R_D), CY_MAIN; P05 resolved A 12.50%, no correction', async () => {
      const s = await seedData({ tc: 158, private: true, contracts: family({ ROOT: ['R_A', 'R_PROMO', 'R_D'] }), cycles: ['CY_MAIN'], products: [product('P05', [{ cycle: 'CY_MAIN', saleLines: 151 }])] });
      Object.assign(d, { cy: s.cycles.CY_MAIN.id, P05: s.products.P05, D: s.master.categoryName.D, E: s.master.categoryName.E });
    });

    await step('Act: Step 1 — Find P05 (keyword + Enter), click 수정, pick category E, type the reason and click 저장 (Save)', async () => {
      await openFiltered(list, d.cy, d.P05, 'enter');
      await list.openCorrect(list.row(d.P05));
      await list.correct.pickCategory(d.E);
      await list.correct.reasonInput.fill(FIRST);
      await list.correct.save();
    });
    await step('Assert: Expected 1 — Toast "승인 요청으로 상신되었습니다. 요율이 변경됩니다."', async () => {
      await expect(list.toast(FR_KO['fix.savedDraft']), '[Expected 1] Toast').toBeVisible();
    });

    await step('Act: Step 2 — Tick P05 and click 선택 일괄 상신 (Submit selected)', async () => {
      await list.rowCheckbox(list.row(d.P05)).check();
      await list.submitSelected();
    });
    await step('Assert: Expected 2 — Pill 승인 대기', async () => {
      await expect(pill(), '[Expected 2] Pill 승인 대기').toHaveText(FR_KO['state.PENDING']);
    });

    await step('Act: Step 3 — As user B reject the pending record of P05, then reload the list', async () => {
      const id = String((await select('correction of P05', 'SELECT id FROM fee_correction WHERE product_id = ? AND discarded_at IS NULL', [d.P05]))[0]?.id);
      rejected = (await approverFeeReviewApi.reject(await approvalIdOf(id), REJECT)).status;
      await searchKeyword(list, d.P05, 'enter');
    });
    await step('Assert: Expected 3 — HTTP 200; P05 shows 반려됨 — 수정 후 재상신', async () => {
      expect.soft(rejected, '[Expected 3] HTTP 200').toBe(200);
      await expect.soft(pill(), '[Expected 3] Pill 반려됨 — 수정 후 재상신').toHaveText(FR_KO['state.REJECTED']);
    });

    await step('Act: Step 4 — Press Enter in 검색어, click 수정 on P05, change Tier 1 to D, reason 카테고리 오매핑 정정, click 저장', async () => {
      await searchKeyword(list, d.P05, 'enter');
      await list.openCorrect(list.row(d.P05));
      opened.option = ((await list.correct.tier1Select.locator('option:checked').textContent()) ?? '').trim();
      opened.reason = await list.correct.reasonInput.inputValue();
      await list.correct.pickCategory(d.D);
      await list.correct.reasonInput.fill('카테고리 오매핑 정정');
      await list.correct.save();
    });
    await step('Assert: Expected 4 — Opened on E with the rejected reason; after Save the no-approval toast and pill 적용됨 (요율 변동 없음)', async () => {
      expect.soft(opened.option, `[Expected 4] Dialog opened with category ${d.E}`).toMatch(new RegExp(`^${esc(d.E)}`));
      expect.soft(opened.reason, '[Expected 4] Reason of the rejected correction filled in').toBe(FIRST);
      await expect.soft(list.toast(FR_KO['fix.savedApplied']), '[Expected 4] Toast "수정이 적용되었습니다. …"').toBeVisible();
      await expect.soft(pill(), '[Expected 4] Pill 적용됨 (요율 변동 없음)').toHaveText(FR_KO['state.APPLIED']);
    });

    await step('Act: Step 5 — Click 이번 기 수정 내역 and read the P05 row', async () => {
      await list.openReport();
    });
    await step('Assert: Expected 5 — The report still shows the rejection: E / 9.50% struck through and the reject reason readable', async () => {
      const r = view.reportRow(d.P05);
      await expect.soft(view.struck(list.report.cell(r, 'change')).filter({ hasText: d.E }), `[Expected 5] Rejected target ${d.E} struck through`).toHaveCount(1);
      await expect.soft(view.struck(list.report.cell(r, 'rate')).filter({ hasText: '9.50%' }), '[Expected 5] Rejected target 9.50% struck through').toHaveCount(1);
      await expect.soft(r, '[Expected 5] Reject reason readable').toContainText(REJECT);
    });

    await step('Act: Step 6 — Close it and click 이력 (History) on P05', async () => {
      await list.report.close();
      await list.openHistory(list.row(d.P05));
    });
    await step('Assert: Expected 6 — The rejected entry (E, 9.50% struck through, 반려 사유) and above it the applied entry A → D', async () => {
      const rejectedEntry = list.history.rows.filter({ hasText: REJECT });
      await expect.soft(rejectedEntry, '[Expected 6] The rejected entry is kept').toHaveCount(1);
      await expect.soft(view.struck(list.history.cell(rejectedEntry, 'change')).filter({ hasText: d.E }), `[Expected 6] ${d.E} struck through`).toHaveCount(1);
      await expect.soft(view.struck(list.history.cell(rejectedEntry, 'change')).filter({ hasText: '9.50' }), '[Expected 6] 9.50% struck through').toHaveCount(1);
      await expect.soft(view.historyRejectBlock(rejectedEntry), '[Expected 6] 반려 사유 block').toContainText(REJECT);
      await expect.soft(list.history.cell(list.history.rows.nth(0), 'change'), '[Expected 6] Applied entry A → D on top').toContainText(d.D);
      await expect.soft(list.history.rows.nth(0), '[Expected 6] The applied entry sits above the rejected one').not.toContainText(REJECT);
    });

    await step('Act: Step 7 — Open 이번 기 수정 내역 again, export CSV, download and open the file', async () => {
      await list.history.close();
      csv = csvRecord(await exportReportCsv(list), d.P05);
    });
    await step('Assert: Expected 7 — The P05 row keeps Reject reason = 프로모션 기간 근거 없음', async () => {
      expect(csv?.['Reject reason'], '[Expected 7] Reject reason kept').toBe(REJECT);
    });
  });

  test('TC_US079_159 — Order lines affected counts sale lines of the open cycle only', async ({ page, feeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US079_159',
      'Medium',
      TAGS,
      `P14's pending correction in CY_MAIN reports Order lines affected = 234 in the CSV and orderLinesAffected = 234 in the API (CY_NEXT's 5 lines not added); after the TC's SQL UPDATE of the sale-line count to 500 a new export reads 500 at once; the approval record keeps impact_count 0 / NOT_COMPUTABLE. Not automated: refund lines of a closed cycle (the fixture carries sale-line counts only). ${PRIVATE}`,
    );
    const d = { cy: 0, P14: '', ca1: 0 };
    let csv: Record<string, string> | undefined;
    let apiLines: unknown;
    let updated = -1;
    let ca: DbRow | undefined;

    await step('Arrange: Pre-condition 1–14 — ROOT + ANNEX1, CY_MAIN (234 lines) and CY_NEXT (5 lines) for P14; X submitted as CA1', async () => {
      const s = await seedData({
        tc: 159,
        private: true,
        contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }),
        cycles: ['CY_MAIN', 'CY_NEXT'],
        products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }, { cycle: 'CY_NEXT', saleLines: 5 }])],
      });
      Object.assign(d, { cy: s.cycles.CY_MAIN.id, P14: s.products.P14 });
      const X = await saveCorrection(feeReviewApi, d.cy, d.P14, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.B, reason: '카테고리 오매핑 정정' });
      await submitCorrections(feeReviewApi, [X]);
      d.ca1 = await approvalIdOf(X);
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN, click 이번 기 수정 내역, export CSV and open the file', async () => {
      await list.open({ cycleId: d.cy });
      csv = csvRecord(await exportReportCsv(list), d.P14);
    });
    await step('Assert: Expected 1 — P14 row: Order lines affected = 234', async () => {
      expect(csv?.['Order lines affected'], '[Expected 1] 234 (CY_NEXT lines not added)').toBe('234');
    });

    await step('Act: Step 2 — GET the period corrections of CY_MAIN and read the P14 item', async () => {
      apiLines = ((await feeReviewApi.periodCorrections(d.cy)).find((c) => c.productId === d.P14) as unknown as Record<string, unknown> | undefined)?.orderLinesAffected;
    });
    await step('Assert: Expected 2 — orderLinesAffected = 234', async () => {
      expect(Number(apiLines), '[Expected 2] orderLinesAffected').toBe(234);
    });

    await step('Act: Step 3 — UPDATE the CY_MAIN sale-line count of P14 to 500', async () => {
      updated = await feeReviewDb.execute("UPDATE fee_review_fixture_target SET sale_line_count = 500 WHERE settlement_cycle_id = ? AND product_id = ? AND policy = 'NORMAL'", [d.cy, d.P14]);
    });
    await step('Assert: Expected 3 — 1 row updated', async () => {
      expect(updated, '[Expected 3] 1 row updated').toBe(1);
    });

    await step('Act: Step 4 — Without restarting anything, export the period report as CSV again', async () => {
      csv = csvRecord(await exportReportCsv(list), d.P14);
    });
    await step('Assert: Expected 4 — P14 row: Order lines affected = 500', async () => {
      expect(csv?.['Order lines affected'], '[Expected 4] 500').toBe('500');
    });

    await step('Act: Step 5 — Read impact_count and impact_status of CA1', async () => {
      ca = await approvalRow(d.ca1);
    });
    await step('Assert: Expected 5 — impact_count = 0 and impact_status = NOT_COMPUTABLE', async () => {
      expect.soft(Number(ca?.impact_count), '[Expected 5] impact_count 0').toBe(0);
      expect.soft(ca?.impact_status, '[Expected 5] impact_status NOT_COMPUTABLE').toBe('NOT_COMPUTABLE');
    });
  });

  test('TC_US079_160 — The report pagination changes page and rows-per-page at once', async ({ page, feeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    const view = new SubmitHistoryView(page, list);
    await tcMeta(
      'TC_US079_160',
      'Low',
      TAGS,
      `With 12 pending corrections in CY_MAIN, 이번 기 수정 내역 shows total 12 건, page navigation and 10 rows per page; page 2 shows the remaining 2 rows at once; 20 rows per page shows all 12 on a single page. Note: the recon of 01/10 (2 rows) showed no navigation bar for a single page — Expected 3's "single page" navigation is asserted per TC. ${PRIVATE}`,
    );
    const d = { cy: 0 };

    await step('Arrange: Pre-condition 1–13 — ROOT (R_A, R_B10), CY_MAIN; 12 products B001…B012 each with a submitted correction', async () => {
      const codes = Array.from({ length: 12 }, (_, i) => `B${String(i + 1).padStart(3, '0')}`);
      const products: ProductDef[] = codes.map((code) => ({ code, contract: 'ROOT', category: 'A', saleType: 'ST1', defaultSlot: 'R_A', targets: [{ cycle: 'CY_MAIN', saleLines: 1 }] }));
      const s = await seedData({ tc: 160, private: true, contracts: family({ ROOT: ['R_A', 'R_B10'] }), cycles: ['CY_MAIN'], products });
      d.cy = s.cycles.CY_MAIN.id;
      const ids: string[] = [];
      for (const code of codes) ids.push(await saveCorrection(feeReviewApi, d.cy, s.products[code], { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.B, reason: 'Paging test' }));
      await submitCorrections(feeReviewApi, ids);
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN and click 이번 기 수정 내역 (Changes this period)', async () => {
      await list.open({ cycleId: d.cy });
      await list.openReport();
    });
    await step('Assert: Expected 1 — Total 12 건, page navigation, rows-per-page 10; page 1 shows 10 rows', async () => {
      await expect.soft(list.report.counter, '[Expected 1] Total 12 건').toHaveText('총 12개의 건 중 1-10개 표시');
      await expect.soft(view.reportPagination, '[Expected 1] Page navigation').toBeVisible();
      await expect.soft(list.report.pageSizeSelect.locator('option:checked'), '[Expected 1] Rows per page = 10').toHaveText('10개');
      await expect.soft(list.report.rows, '[Expected 1] Page 1 shows 10 rows').toHaveCount(10);
    });

    await step('Act: Step 2 — Click page 2 in the pagination bar', async () => {
      await list.click(view.reportPageButton('2'), 'Page 2 of the period report');
    });
    await step('Assert: Expected 2 — Page 2 shows the remaining 2 rows at once', async () => {
      await expect.soft(list.report.rows, '[Expected 2] Two rows on page 2').toHaveCount(2);
      await expect.soft(list.report.counter, '[Expected 2] Rows 11-12').toHaveText('총 12개의 건 중 11-12개 표시');
    });

    await step('Act: Step 3 — Change rows per page from 10 to 20', async () => {
      await list.report.pageSizeSelect.selectOption({ label: '20개' });
    });
    await step('Assert: Expected 3 — All 12 rows on one page; the navigation shows a single page', async () => {
      await expect.soft(list.report.rows, '[Expected 3] All 12 rows on one page').toHaveCount(12);
      await expect.soft(view.reportPagination.getByRole('button', { name: /^\d+$/ }), '[Expected 3] A single page in the navigation').toHaveCount(1);
    });
  });
});
