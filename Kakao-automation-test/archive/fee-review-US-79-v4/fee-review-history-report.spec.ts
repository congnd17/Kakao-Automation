import { test, expect } from '@fixtures/fee-review.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { getAccountDisplayName } from '@utils/auth-token';
import { FR_EN, FR_KO } from '@utils/fee-review.i18n';
import { CYCLE, FIXTURE, RATE_MOVING, autoReason } from '@utils/fee-review.data';

/**
 * US079 — nhóm [History] / [Report]: dialog 변경 이력 và 이번 기 수정 내역 với correction ở nhiều trạng thái. Bản ghi bị trả /
 * đã rút / chờ duyệt được tạo qua API ở Arrange trên fixture ghi và dọn ở teardown.
 */
const TAGS = ['history', 'report', 'fee-review'];
const DEV = `Deviation: the TC's prototype seed does not exist on dev — the T079 fixture with the same scenario in cycle ${CYCLE.label} is used.`;
const CLEAN = 'Data: every correction the test creates is withdrawn / discarded in teardown.';
const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Chuỗi UI tiếng Hàn hoặc tiếng Anh của cùng 1 khoá i18n. */
const either = (key: keyof typeof FR_KO) => new RegExp(`${esc(FR_KO[key])}|${esc(FR_EN[key])}`);

test.describe('[History / Report] Change history and Changes this period', () => {
  test.describe.configure({ timeout: 150_000 });

  test('TC_US079_106 — A correction that changed both category and rate gives one history entry with two change lines, and an unchanged field gives no line', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_106', 'Medium', TAGS, `An approved correction on ${FIXTURE.approvedTwoPolicies} that changed both category and rate (replaces 880021's resubmission) shows one entry holding two change lines (수수료 카테고리 and 수수료율). Not automated: step 2 / expected 2 (a category-only change with no rate line) — no same-rate category exists on dev (see TC_US079_54). ${DEV} Data: read-only.`);
    let entry = list.history.rows.first();

    await step('Arrange: Pre-condition 1–3 — A correction that changed both fields is on record', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Open 이력 and read the entry', async () => {
      await list.openHistory(list.row(FIXTURE.approvedTwoPolicies));
      entry = list.history.rows.filter({ hasText: FR_KO['hist.fieldRate'] }).first();
    });

    await step('Assert: Expected 1 — One entry with two change lines (category and rate), not two entries', async () => {
      await expect(list.history.cell(entry, 'setting'), '[Expected 1] The category line is in the entry').toContainText(FR_KO['hist.fieldCategory']);
      await expect(list.history.cell(entry, 'setting'), '[Expected 1] The rate line is in the same entry').toContainText(FR_KO['hist.fieldRate']);
      await expect(list.history.cell(entry, 'change').locator('.text-decoration-line-through'), '[Expected 1] Two change lines (before → after) in the one entry').toHaveCount(2);
      await list.history.close();
    });

    await step('Act: Step 2 — Open 이력 on a category-only correction (Not automated)', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Step 2: no same-rate (category-only) correction can be made on dev' });
    });

    await step('Assert: Expected 2 — Only the category line, no rate line (Not automated)', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Expected 2: see Step 2' });
    });
  });

  test("TC_US079_107 — A rejected submission shows the approver's reason in its own block, its target struck through, and the footer stating that only approved corrections move a figure", async ({ page, feeReviewApi, approverFeeReviewApi, feeReviewState, feeReviewPage: list }) => {
    const step = makeStep(page);
    const SUBMIT_TAIL = 'to be rejected';
    const REJECT_TAIL = '번들 구성품이 아니라 단품 판매 건입니다. 공연MD 유지해 주세요.';
    const submitReason = autoReason('TC_US079_107', SUBMIT_TAIL);
    const rejectReason = autoReason('TC_US079_107', REJECT_TAIL);
    await tcMeta('TC_US079_107', 'Medium', TAGS, `A correction on ${FIXTURE.forSave} (replaces 900318) rejected by the approver account shows in History, inside the rejected entry, the reject reason as its own text separate from the submitter's reason with the approver's name, the rejected target value struck through, and the footer "${FR_KO['hist.footer']}". ${DEV} ${CLEAN}`);
    let entry = list.history.rows.first();

    await step('Arrange: Pre-condition 1–2 — The product history includes a rejected entry', async () => {
      const { approval } = await feeReviewState.pending(feeReviewApi, FIXTURE.forSave, RATE_MOVING, submitReason);
      await approverFeeReviewApi.reject(approval.id, rejectReason);
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Open 이력, locate the rejected entry and read its reason block', async () => {
      await list.openHistory(list.row(FIXTURE.forSave));
      entry = list.history.rows.filter({ hasText: rejectReason.slice(0, 40) }).first();
      await entry.scrollIntoViewIfNeeded();
    });

    await step("Assert: Expected 1 — The reject reason in its own block, separate from the submitter's reason, with the approver's name", async () => {
      // 2 lý do có chung tiền tố autoReason ("[AUTO-US079] TC_US079_107 {ts} — ") → phân biệt bằng phần đuôi riêng.
      const rejectText = entry.getByText(REJECT_TAIL);
      const submitText = entry.getByText(SUBMIT_TAIL);
      await expect(entry.getByText(either('hist.rejectReason')), '[Expected 1] 반려 사유 (Reject reason) label in the entry').toBeVisible();
      await expect(rejectText, '[Expected 1] The reject reason is shown in the entry').toBeVisible();
      await expect(submitText, "[Expected 1] The submitter's own reason is shown in the entry").toBeVisible();
      await expect(rejectText, "[Expected 1] The reject reason block does not hold the submitter's reason").not.toContainText(SUBMIT_TAIL);
      await expect(entry, "[Expected 1] The approver's name").toContainText(getAccountDisplayName('approver'));
    });

    await step("Act: Step 2 — Read the entry's target value", async () => {
      await list.history.cell(entry, 'change').scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — The rejected target value is struck through', async () => {
      await expect(list.history.cell(entry, 'change').locator('.fw-bold'), '[Expected 2] Target value struck through').toHaveClass(/line-through/);
    });

    await step("Act: Step 3 — Read the dialog's footer note", async () => {
      await list.history.footer.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — The footer about approved requests', async () => {
      await expect(list.history.footer, '[Expected 3] Footer note').toHaveText(FR_KO['hist.footer']);
      await list.history.close();
    });
  });

  test('TC_US079_109 — The period report holds every correction in every state, each marked with whether it took effect and non-applied targets struck through', async ({ page, feeReviewApi, approverFeeReviewApi, feeReviewState, feeReviewPage: list }) => {
    const step = makeStep(page);
    const reasons = { rejected: autoReason('TC_US079_109', 'rejected'), withdrawn: autoReason('TC_US079_109', 'withdrawn'), pending: autoReason('TC_US079_109', 'awaiting approval') };
    await tcMeta('TC_US079_109', 'High', TAGS, `The report lists the applied corrections of ${FIXTURE.approvedTwoPolicies}, a rejected one (${FIXTURE.forSave}), a withdrawn one (${FIXTURE.resolvedAnnex}), a pending one (${FIXTURE.promotionWins} PROMOTION) and an auto-retired one; an Applied? column marks each row Y/N and non-applied targets are struck through. Deviation: the pending correction is a plain submission (not reject-then-resubmit); the auto-retired correction is not created by the test — any on page 1 of the report counts; the on-screen report has no Applied? column on dev (the export has it) — the TC assertion is kept and the approval wording of each row is checked as well. ${DEV} ${CLEAN}`);
    let rows = list.report.rows;
    const byReason = (r: string) => rows.filter({ hasText: r.slice(0, 40) });

    await step('Arrange: Pre-condition 1–2 — Applied, pending, rejected and withdrawn corrections in the cycle', async () => {
      const rejected = await feeReviewState.pending(feeReviewApi, FIXTURE.forSave, RATE_MOVING, reasons.rejected);
      await approverFeeReviewApi.reject(rejected.approval.id, autoReason('TC_US079_109', 'reject'));
      const withdrawn = await feeReviewState.pending(feeReviewApi, FIXTURE.resolvedAnnex, RATE_MOVING, reasons.withdrawn);
      await feeReviewApi.withdraw(withdrawn.correctionId);
      await feeReviewState.pending(feeReviewApi, FIXTURE.promotionWins, RATE_MOVING, reasons.pending, 'PROMOTION');
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Open 이번 기 수정 내역 and check every state is represented', async () => {
      await list.openReport();
      await list.report.showLatest();
      rows = list.report.rows;
    });

    await step('Assert: Expected 1 — Rejected, withdrawn and auto-retired corrections appear, not only successful ones', async () => {
      await expect(byReason(reasons.rejected), '[Expected 1] Rejected correction listed').toHaveCount(1);
      await expect(byReason(reasons.withdrawn), '[Expected 1] Withdrawn correction listed').toHaveCount(1);
      await expect(byReason(reasons.pending), '[Expected 1] Pending correction listed').toHaveCount(1);
      await expect(rows.filter({ hasText: FIXTURE.approvedTwoPolicies }).first(), '[Expected 1] Applied correction listed').toBeVisible();
      await expect.soft(rows.filter({ hasText: either('state.RETIRED') }).first(), '[Expected 1] An auto-retired correction listed').toBeVisible();
    });

    await step('Act: Step 2 — Read the Applied?-style column for each row', async () => {
      await rows.first().scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Each row is marked with whether it took effect (Applied? Y/N)', async () => {
      await expect.soft(list.report.headers.filter({ hasText: /적용 여부|Applied\?/ }), '[Expected 2] An Applied? (Y/N) column').toHaveCount(1);
      await expect(list.report.cell(byReason(reasons.rejected), 'approval'), '[Expected 2] Rejected → not applied').toHaveText(new RegExp(FR_KO['state.REJECTED'].slice(0, 3)));
      await expect(list.report.cell(byReason(reasons.pending), 'approval'), '[Expected 2] Pending → not applied (승인 대기)').toHaveText(either('state.PENDING'));
      for (const applied of [FR_KO['state.APPROVED'], FR_KO['state.APPLIED']]) {
        await expect(list.report.cell(byReason(reasons.withdrawn), 'approval'), `[Expected 2] Withdrawn → not "${applied}"`).not.toHaveText(applied);
      }
      await expect(list.report.cell(rows.filter({ hasText: FIXTURE.approvedTwoPolicies }).first(), 'approval'), '[Expected 2] Applied').toHaveText(FR_KO['state.APPROVED']);
    });

    await step("Act: Step 3 — Read a rejected / withdrawn row's target value", async () => {
      await byReason(reasons.rejected).scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — The non-applied target value is struck through', async () => {
      for (const [name, r] of [['Rejected', reasons.rejected], ['Withdrawn', reasons.withdrawn]] as const) {
        await expect(list.report.cell(byReason(r), 'change').locator('.text-decoration-line-through, del, s').first(), `[Expected 3] ${name} target struck through`).toBeVisible();
      }
      await list.report.close();
    });
  });
});
