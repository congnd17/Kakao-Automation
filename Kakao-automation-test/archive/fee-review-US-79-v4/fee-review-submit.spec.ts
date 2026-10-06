import { test, expect } from '@fixtures/fee-review.fixture';
import { makeStep } from '@utils/step';
import { skipTc, tcMeta } from '@utils/tc-meta';
import { getAccountDisplayName } from '@utils/auth-token';
import { FR_KO, FR_TC, frFormat } from '@utils/fee-review.i18n';
import { CYCLE, FIXTURE, RATE_MOVING, autoReason, baseline, parseCsv } from '@utils/fee-review.data';
import type { FeeReviewApi } from '@api/fee-review.api';

/**
 * US079 — nhóm [Permission] tách nút, [Submit], [Withdraw], [Approval Queue]. Nguồn TC: input/US079_TestCase_EN_v4.md.
 * Maker = account submitter (quyền ghi màn, không phải approver); approver = account APPROVER_* (phiên trình duyệt thứ 2 / API) — tên đọc lúc chạy qua getAccountDisplayName().
 * TC_US079_01 / 05 (v4 Result BLOCKED — chưa có phân quyền) chuyển sang fee-review-blocked.spec.ts (quyết định 01/10).
 * Correction đã DUYỆT không xoá được → `feeReviewState` lưu 1 correction đưa về category gốc ở teardown (quyết định 29/09).
 */
const TAGS = ['submit', 'fee-review'];
const DEV = `Deviation: the TC's prototype seed does not exist on dev — the T079 fixture with the same scenario in cycle ${CYCLE.label} is used (${FIXTURE.forSave} as the correctable product).`;
const CLEAN = 'Data: every correction the test creates is withdrawn / discarded in teardown; an approved one is reverted to the original category.';
// Value của option 원장 — nhãn hiển thị là 수수료 규칙 (KO) / Fee Rule (EN), verify DOM 01/10.
const REGISTER = 'FEE_RULE';
const OTHER_REGISTER = '결제수단 정책';
// Nhãn khối chi tiết hàng đợi trên dev (verify DOM 01/10).
const Q_TARGET = '대상 레코드';
const Q_PREV = '직전 승인 값';
// Chính sách hiển thị trong khoá tự nhiên — enum hoặc nhãn bản địa (chưa verify nhãn bản địa).
const POLICY_RE = /NORMAL|일반|Normal/;
// Ba bucket của impact summary theo TC (EN) + nhãn KO phỏng đoán — CHƯA verify trên DOM (không có request Fee Rule chờ duyệt lúc recon 01/10).
const BUCKETS: Array<{ name: string; re: RegExp }> = [
  { name: 'Not yet settled', re: /Not yet settled|정산 전/ },
  { name: 'Settled, period still open', re: /Settled, period still open|정산 완료.*(열린|진행)/ },
  { name: 'Settled, period closed', re: /Settled, period closed|마감/ },
];
const BUCKET_DEV = 'Deviation: the three bucket labels could not be verified on the DOM (no pending Fee Rule request existed during recon 01/10) — the TC English names and guessed Korean labels are matched.';

/** Phần số của mức phí ("9.00%" → "9.00") để so khớp giữa API, list và hàng đợi. */
const rateNum = (rate?: string): string => String(rate ?? '').replace('%', '').trim();
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Mức phí của danh mục trong dropdown Tier 1 của dòng (giá trị đề xuất khi chọn danh mục đó). */
async function categoryRate(api: FeeReviewApi, productId: string, category: string): Promise<string> {
  return rateNum((await api.options(CYCLE.id, productId)).categories.find((c) => c.categoryName === category)?.rate);
}

test.describe('[Submit / Withdraw / Approval queue] Fee resolution corrections', () => {
  // Baseline P14 đọc lúc chạy — fixture dùng chung bị lệch (30/09), không viết cứng danh mục.
  const P14 = { original: undefined as string | undefined, moving: '', other: '' };
  test.beforeEach(async ({ feeReviewApi }) => {
    Object.assign(P14, await baseline(feeReviewApi, FIXTURE.forSave));
  });

  test.describe.configure({ timeout: 180_000 });

  test('TC_US079_04 — Approve / Reject never render on the fee review screen and Submit / Withdraw never render on the queue', async ({ page, feeReviewApi, feeReviewState, feeReviewPage: list, approvalQueuePage: queue }) => {
    const step = makeStep(page);
    const reason = autoReason('TC_US079_04', 'pending for the control split');
    await tcMeta('TC_US079_04', 'High', TAGS, `With a pending correction on ${FIXTURE.forSave} (replaces 880021): the row reads 승인 대기; no 승인 / 반려 exists on the screen, its 근거 panel or its 이력 dialog; the queue lists the record with 기안자, the natural key (cycle · product · policy) and the impact; the queue offers only 반려 / 승인, no 상신 / 회수. Note: v4 Result is BLOCKED ("Permission is not implement") — kept automated (decision 01/10) because the control split does not depend on grants. ${DEV} ${CLEAN}`);
    let approvalId = 0;
    const decisionControls = { screen: -1, basis: -1, history: -1 };
    const approveReject = page.getByRole('button', { name: /^(승인|반려|Approve|Reject)$/ });

    await step('Arrange: Pre-condition 1–2 — A correction awaiting approval in the open cycle', async () => {
      approvalId = (await feeReviewState.pending(feeReviewApi, FIXTURE.forSave, RATE_MOVING, reason)).approval.id;
    });

    await step('Act: Step 1 — Open the screen and locate the product', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await expect(list.row(FIXTURE.forSave), 'The product row is listed').toBeVisible();
    });

    await step('Assert: Expected 1 — The row shows 승인 대기', async () => {
      await expect(list.statusPills(list.row(FIXTURE.forSave)).nth(1), '[Expected 1] 승인 대기').toHaveText(FR_KO['state.PENDING']);
    });

    await step('Act: Step 2 — Open its 근거 panel and its 이력 dialog and look for approve / reject controls', async () => {
      decisionControls.screen = await approveReject.count();
      await list.openBasis(list.row(FIXTURE.forSave));
      decisionControls.basis = await approveReject.count();
      await list.basis.close();
      await list.openHistory(list.row(FIXTURE.forSave));
      decisionControls.history = await approveReject.count();
    });

    await step('Assert: Expected 2 — No 승인 / 반려 control anywhere on the screen, in any dialog', async () => {
      expect.soft(decisionControls.screen, '[Expected 2] No approve / reject control on the screen').toBe(0);
      expect.soft(decisionControls.basis, '[Expected 2] No approve / reject control in the 근거 (Basis) panel').toBe(0);
      expect.soft(decisionControls.history, '[Expected 2] No approve / reject control in the 이력 (History) dialog').toBe(0);
      await list.history.close();
    });

    await step('Act: Step 3 — Open 변경 승인 and locate the same record', async () => {
      await queue.openRequest({ register: REGISTER, requester: getAccountDisplayName('submitter'), changeApprovalId: approvalId, reason });
    });

    await step('Assert: Expected 3 — The record shows 기안자, the natural key and the impact figure', async () => {
      await expect.soft(queue.panelValue('기안자'), '[Expected 3] 기안자 (Maker)').toHaveText(getAccountDisplayName('submitter'));
      await expect.soft(queue.panelValue(Q_TARGET), '[Expected 3] Natural key: product').toContainText(FIXTURE.forSave);
      await expect.soft(queue.panelValue(Q_TARGET), '[Expected 3] Natural key: cycle').toContainText(new RegExp(`${CYCLE.label}|${CYCLE.id}`));
      await expect.soft(queue.panelValue(Q_TARGET), '[Expected 3] Natural key: policy').toContainText(POLICY_RE);
      await expect.soft(queue.impactAnySection, '[Expected 3] Impact figure').toBeVisible();
    });

    await step('Act: Step 4 — On the detail panel look for a submit / withdraw control', async () => {
      await queue.rejectButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — No 상신 / 회수; only 반려 and 승인', async () => {
      await expect(page.getByRole('button', { name: /^(상신|회수|Submit|Withdraw)$/ }), '[Expected 4] No submit / withdraw').toHaveCount(0);
      await expect(queue.rejectButton, '[Expected 4] 반려 (Reject) offered').toBeVisible();
      await expect(queue.approveButton, '[Expected 4] 승인 (Approve) offered').toBeVisible();
    });
  });

  test('TC_US079_80 — Submitting drafts creates one approval record per product with every mandatory field, decided one at a time', async ({ page, feeReviewApi, feeReviewState, feeReviewPage: list, approvalQueuePage: queue }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_80', 'Critical', TAGS, `Two rate-moving drafts (${FIXTURE.forSave}, ${FIXTURE.resolvedAnnex} — replace 900412 / 900277) selected and submitted together show "수정 2건을 승인 요청으로 상신했습니다." (Korean string BA-proposed, pending KE confirmation — OQ-154); two Fee Rule records are created, each carrying target type, natural key (cycle · product · policy), current (in-force) value, requested value, impact and the submitter reason (read from the record detail API); the queue offers no bulk decision. ${DEV} ${CLEAN}`);
    const products = [FIXTURE.forSave, FIXTURE.resolvedAnnex];
    const reasons = [autoReason('TC_US079_80', 'first draft'), autoReason('TC_US079_80', 'second draft')];
    const plan: Array<{ inForce: string; requested: string }> = [];
    const approvalIds: number[] = [];
    let before = 0;

    await step('Arrange: Pre-condition 1–2 — Two products each carry a fresh rate-moving draft', async () => {
      before = (await feeReviewApi.feeRuleApprovals()).length;
      for (const [i, id] of products.entries()) {
        const moving = i === 0 ? P14.moving : (await baseline(feeReviewApi, id)).moving;
        plan.push({ inForce: rateNum((await feeReviewApi.row(CYCLE.id, id)).inForceRate), requested: await categoryRate(feeReviewApi, id, moving) });
        await feeReviewState.draft(feeReviewApi, id, moving, reasons[i]);
      }
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step("Act: Step 1 — Select both rows' checkboxes", async () => {
      for (const id of products) await list.rowCheckbox(list.row(id)).check();
    });

    await step('Act: Step 2 — Click 선택 일괄 상신 (Submit selected)', async () => {
      await list.submitSelected();
    });

    await step('Assert: Expected 1 — The toast "수정 2건을 승인 요청으로 상신했습니다."', async () => {
      await expect(list.toast(frFormat(FR_KO['msg.submitted'], { n: 2 })), '[Expected 1] 2 corrections submitted for approval').toBeVisible();
    });

    await step('Assert: Expected 2 — Two separate records, each carrying every mandatory field', async () => {
      expect((await feeReviewApi.feeRuleApprovals()).length - before, '[Expected 2] Two new records — one per product').toBe(2);
      for (const [i, id] of products.entries()) {
        const record = await feeReviewState.approvalOf(feeReviewApi, id, reasons[i]);
        approvalIds.push(record.id);
        const body = (await feeReviewApi.approval(record.id)).body;
        const detail = JSON.stringify(body);
        expect.soft(body.targetType, `[Expected 2] ${id}: target type Fee rule`).toBe('FEE_RULE');
        expect.soft(detail, `[Expected 2] ${id}: natural key — product`).toContain(id);
        expect.soft(detail, `[Expected 2] ${id}: natural key — cycle`).toMatch(new RegExp(`${esc(CYCLE.label)}|${CYCLE.id}`));
        expect.soft(detail, `[Expected 2] ${id}: natural key — policy`).toMatch(POLICY_RE);
        expect.soft(String(body.prevValue ?? ''), `[Expected 2] ${id}: current value is the value in force`).toContain(plan[i].inForce);
        expect.soft(detail, `[Expected 2] ${id}: requested value`).toContain(plan[i].requested);
        expect.soft(detail, `[Expected 2] ${id}: an Impact figure / status`).toMatch(/impact/i);
        expect.soft(String(body.changeReason ?? ''), `[Expected 2] ${id}: the submitter reason`).toBe(reasons[i]);
      }
    });

    await step('Act: Step 3 — Open the approval queue and locate both records', async () => {
      for (const [i, id] of approvalIds.entries()) await queue.openRequest({ register: REGISTER, requester: getAccountDisplayName('submitter'), changeApprovalId: id, reason: reasons[i] });
    });

    await step('Assert: Expected 3 — Decided one at a time; no bulk-decide control', async () => {
      await expect(page.getByRole('checkbox'), '[Expected 3] No multi-select in the queue').toHaveCount(0);
      await expect(page.getByRole('button', { name: /일괄|bulk|전체 승인|전체 반려/i }), '[Expected 3] No bulk-decide control').toHaveCount(0);
      await expect(queue.approveButton, '[Expected 3] A single 승인 (Approve) for the open record').toHaveCount(1);
      await expect(queue.rejectButton, '[Expected 3] A single 반려 (Reject) for the open record').toHaveCount(1);
    });
  });

  test('TC_US079_81 — The current value sent to the approver is the value in force, never a pending draft', async ({ page, feeReviewApi, feeReviewState, feeReviewPage: list, approvalQueuePage: queue }) => {
    const step = makeStep(page);
    const reason = autoReason('TC_US079_81', 'current value check');
    await tcMeta('TC_US079_81', 'Critical', TAGS, `After saving and submitting a rate-moving correction on ${FIXTURE.forSave}, the queue detail's 변경 전 (Current value) field reads the in-force rate, never the draft's figure; an unsaved draft on another product has no approval record at all. Deviation: the queue detail on dev labels this field ${Q_PREV}, not the TC's 변경 전 — the TC label is asserted (expected to fail until the build matches) and the dev value is recorded. Deviation: the save and submit run through the API. ${DEV} ${CLEAN}`);
    let inForce = '';
    let approvalId = 0;

    await step('Arrange: Pre-condition 1–2 — The product is resolved; a draft is prepared', async () => {
      inForce = rateNum((await feeReviewApi.row(CYCLE.id, FIXTURE.forSave)).inForceRate);
      expect(inForce, 'Pre-condition: a rate in force').not.toBe('');
    });

    await step('Act: Step 1 — Save and submit the correction, then read 변경 전 on the approval detail', async () => {
      approvalId = (await feeReviewState.pending(feeReviewApi, FIXTURE.forSave, RATE_MOVING, reason)).approval.id;
      await queue.openRequest({ register: REGISTER, requester: getAccountDisplayName('submitter'), changeApprovalId: approvalId, reason });
      test.info().annotations.push({ type: 'Observed (dev label)', description: `${Q_PREV} = ${(await queue.panelValue(Q_PREV).textContent().catch(() => null)) ?? '—'}` });
    });

    await step('Assert: Expected 1 — 변경 전 (Current value) reads the in-force value at submission', async () => {
      expect(String((await feeReviewApi.approval(approvalId)).body.prevValue ?? ''), '[Expected 1] The record current value is the in-force rate').toContain(inForce);
      await expect(queue.panelValue(FR_TC.queueCurrentValue), `[Expected 1] ${FR_TC.queueCurrentValue} (Current value) reads ${inForce}%`).toContainText(inForce);
    });

    await step('Act: Step 2 — Prepare (do not save) a draft on another product and look for its approval record', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await list.openCorrect(list.row(FIXTURE.resolvedAnnex));
      await list.correct.pickCategory((await baseline(feeReviewApi, FIXTURE.resolvedAnnex)).moving);
    });

    await step('Assert: Expected 2 — No approval record exists for the unsaved draft', async () => {
      expect((await feeReviewApi.feeRuleApprovals()).some((a) => JSON.stringify(a).includes(FIXTURE.resolvedAnnex) && a.approvalStatus === 'PENDING'), '[Expected 2] No record for the unsaved draft').toBe(false);
      await list.correct.cancel();
    });
  });

  test('TC_US079_82 — The Impact field states in words that it cannot be computed yet and never shows a fabricated zero', async ({ page, feeReviewApi, feeReviewState, feeReviewPage: list, approvalQueuePage: queue }) => {
    const step = makeStep(page);
    const reason = autoReason('TC_US079_82', 'impact wording');
    await tcMeta('TC_US079_82', 'High', TAGS, `A draft correction on ${FIXTURE.forSave} is submitted from the list; the queue detail's Impact field never shows a bare 0 or any count and states in words that the impact is "not yet computable" (the SRS gives only the English wording — it is asserted, and the Korean text the build shows is recorded as an annotation). The Impact field is only rendered on the queue detail, so it is opened as part of step 1 to read Expected 1. Not automated: the optional API-level check of impact_count = 0 / impact_status = not_computable (TC: outside the browser, not required). ${DEV} ${CLEAN}`);
    let approvalId = 0;
    let submitted = 0;
    let impact = '';

    await step('Arrange: Pre-condition 1–2 — US008 cannot be read; the product has a draft ready to submit', async () => {
      await feeReviewState.draft(feeReviewApi, FIXTURE.forSave, RATE_MOVING, reason);
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Submit the correction', async () => {
      await list.rowCheckbox(list.row(FIXTURE.forSave)).check();
      submitted = (await list.submitSelected()).status();
      expect(submitted, 'The submission is accepted').toBeLessThan(300);
      approvalId = (await feeReviewState.approvalOf(feeReviewApi, FIXTURE.forSave, reason)).id;
      await queue.openRequest({ register: REGISTER, requester: getAccountDisplayName('submitter'), changeApprovalId: approvalId, reason });
      impact = await queue.impactAnySection.innerText();
    });

    await step('Assert: Expected 1 — The Impact field never shows a bare 0 or any figure', async () => {
      expect.soft(impact, '[Expected 1] No bare 0').not.toMatch(/(^|\s)0(건|$|\s)/);
      expect.soft(impact, '[Expected 1] No count figure').not.toMatch(/\d[\d,]*\s*건/);
      expect.soft(impact, '[Expected 1] No figure beside 영향 건수').not.toMatch(/영향 건수\s*[\d,]+/);
    });

    await step('Act: Step 2 — Open the approval detail and read the Impact field', async () => {
      await queue.impactAnySection.scrollIntoViewIfNeeded();
      impact = await queue.impactAnySection.innerText();
      test.info().annotations.push({ type: 'Observed Korean (Expected 2)', description: impact.replace(/\s+/g, ' ') });
    });

    await step('Assert: Expected 2 — It says in words that the impact cannot be computed yet', async () => {
      expect(impact, `[Expected 2] "${FR_TC.impactNotComputableEn}" wording`).toMatch(new RegExp(FR_TC.impactNotComputableEn, 'i'));
    });
  });

  test('TC_US079_83 — The impact summary names all three close-boundary buckets with a figure against each, and the count shown up front is only the second bucket\'s figure', async () => {
    await skipTc('TC_US079_83', 'Medium', TAGS, 'The queue detail impact summary names Not yet settled / Settled, period still open / Settled, period closed, each with a figure, and the up-front count equals only the second bucket figure.', 'needs computed per-bucket impact figures, which cannot exist while US008 (the settlement engine) cannot be read on dev — every Fee Rule record carries a not-computable impact (same US008 dependency as TC_US079_82, per the TC remark)');
  });

  test('TC_US079_84 — While the impact is not yet computable the summary names all three buckets, says why and shows no underived figure', async ({ page, feeReviewApi, feeReviewState, approvalQueuePage: queue }) => {
    const step = makeStep(page);
    const reason = autoReason('TC_US079_84', 'impact buckets');
    await tcMeta('TC_US079_84', 'Medium', TAGS, `A correction on ${FIXTURE.forSave} is submitted; its queue detail impact summary names the three buckets (Not yet settled / Settled, period still open / Settled, period closed), says in words that the counts cannot be produced until the settlement engine ships, and every bucket reads as not-yet-computable — never a bare 0. ${BUCKET_DEV} ${DEV} ${CLEAN}`);
    let approvalId = 0;
    let impact = '';
    let bucketLines: Array<{ name: string; line: string }> = [];

    await step('Arrange: Pre-condition 1–2 — US008 cannot be read; a correction is submitted', async () => {
      approvalId = (await feeReviewState.pending(feeReviewApi, FIXTURE.forSave, RATE_MOVING, reason)).approval.id;
    });

    await step('Act: Step 1 — Open the approval detail and read the three bucket names', async () => {
      await queue.openRequest({ register: REGISTER, requester: getAccountDisplayName('submitter'), changeApprovalId: approvalId, reason });
      impact = await queue.impactAnySection.innerText();
    });

    await step('Assert: Expected 1 — All three buckets are still named', async () => {
      for (const b of BUCKETS) expect.soft(impact, `[Expected 1] Bucket "${b.name}" is named`).toMatch(b.re);
    });

    await step('Act: Step 2 — Read the wording describing why no counts are shown', async () => {
      await queue.impactAnySection.scrollIntoViewIfNeeded();
      test.info().annotations.push({ type: 'Observed impact summary', description: impact.replace(/\s+/g, ' ') });
    });

    await step('Assert: Expected 2 — The summary states the counts cannot be produced until the settlement engine ships', async () => {
      expect.soft(impact, '[Expected 2] States the counts cannot be produced').toMatch(/cannot be (produced|computed)|not yet computable|산출할 수 없|계산할 수 없/i);
      expect.soft(impact, '[Expected 2] Names the settlement engine as the reason').toMatch(/settlement engine|정산 엔진|US008/i);
    });

    await step('Act: Step 3 — Check whether a figure is shown beside each bucket', async () => {
      const lines = impact.split('\n').map((l) => l.trim()).filter(Boolean);
      bucketLines = BUCKETS.map((b) => ({ name: b.name, line: lines.find((l) => b.re.test(l)) ?? '' }));
    });

    await step('Assert: Expected 3 — No bucket shows a figure the system did not derive', async () => {
      for (const b of bucketLines) {
        expect.soft(b.line, `[Expected 3] ${b.name}: no bare 0`).not.toMatch(/(^|\s)0(건|$|\s)/);
        expect.soft(b.line, `[Expected 3] ${b.name}: reads as not-yet-computable`).toMatch(/not yet computable|산출할 수 없|계산할 수 없/i);
      }
    });
  });

  test('TC_US079_85 — The submitter reason and the approver rejection reason are kept as separate fields', async ({ page, feeReviewApi, approverFeeReviewApi, feeReviewState, feeReviewPage: list }) => {
    const step = makeStep(page);
    const makerReason = autoReason('TC_US079_85', '응원봉 번들로 판매되어 응원봉 요율이 맞다고 판단');
    const rejectReason = autoReason('TC_US079_85', '번들 구성품이 아니라 단품 판매 건입니다. 공연MD 유지해 주세요.');
    await tcMeta('TC_US079_85', 'High', TAGS, `A correction on ${FIXTURE.forSave} (replaces 900318) submitted with a maker reason and rejected with a different reason keeps both apart: in History each reason sits in its own element (the reject reason under 반려 사유), the period report's 사유 column holds only the maker reason, and the report export carries them in its separate Reason (maker) / Reject reason columns — never merged. Deviation: the export file is downloaded through the export API. ${DEV} ${CLEAN}`);
    const makerTail = makerReason.slice(-20);
    const rejectTail = rejectReason.slice(-20);
    const seen = { historyMaker: '',historyReject: '', reportReason: '', exportMaker: '', exportReject: '' };

    await step('Arrange: Pre-condition 1–2 — A correction rejected with its own reason', async () => {
      const { approval } = await feeReviewState.pending(feeReviewApi, FIXTURE.forSave, RATE_MOVING, makerReason);
      expect((await approverFeeReviewApi.reject(approval.id, rejectReason)).status, 'The rejection is stored').toBeLessThan(300);
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Open 이력 and read both reasons', async () => {
      await list.openHistory(list.row(FIXTURE.forSave));
      // Ô lý do có thể rút gọn — khớp theo đuôi lý do như các TC lịch sử khác.
      seen.historyMaker = await list.history.root.getByText(makerTail).first().innerText();
      seen.historyReject = await list.history.root.getByText(rejectTail).first().innerText();
      await expect(list.history.root.getByText(FR_KO['hist.rejectReason']).first(), 'The 반려 사유 block is shown').toBeVisible();
      await list.history.close();
    });

    await step("Act: Step 2 — Open the period change report and read the same record's reason columns", async () => {
      await list.openReport();
      await list.report.showLatest();
      seen.reportReason = await list.report.cell(list.report.rows.filter({ hasText: makerReason.slice(0, 40) }).first(), 'reason').innerText();
      await list.report.close();
      const rows = parseCsv((await feeReviewApi.exportCsv(CYCLE.id, 'corrections')).text);
      const header = (rows[0] ?? []).map((h) => h.split('‖')[0].trim());
      const makerCol = header.indexOf('Reason (maker)');
      const rejectCol = header.indexOf('Reject reason');
      const record = rows.slice(1).find((r) => r[makerCol] === makerReason) ?? [];
      seen.exportMaker = record[makerCol] ?? '';
      seen.exportReject = record[rejectCol] ?? '';
    });

    await step('Assert: Expected 1 — Each reason in its own field / block on History and in the export, never merged', async () => {
      expect.soft(seen.historyMaker, '[Expected 1] History: the maker reason element does not hold the reject reason').not.toContain(rejectTail);
      expect.soft(seen.historyReject, '[Expected 1] History: the reject reason element does not hold the maker reason').not.toContain(makerTail);
      expect.soft(seen.reportReason, '[Expected 1] Report: 사유 holds the maker reason').toContain(makerReason.slice(0, 40));
      expect.soft(seen.reportReason, '[Expected 1] Report: 사유 does not merge the reject reason').not.toContain(rejectTail);
      expect.soft(seen.exportMaker, '[Expected 1] Export: Reason (maker) holds only the maker reason').toBe(makerReason);
      expect.soft(seen.exportReject, '[Expected 1] Export: Reject reason holds only the reject reason').toBe(rejectReason);
    });
  });

  test('TC_US079_86 — Submit selected is disabled with a stated reason when nothing is selected and when no selected row holds a draft', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_86', 'Medium', TAGS, `With nothing selected 선택 일괄 상신 is disabled with "상신할 행을 먼저 선택하세요."; with only rows that hold no draft selected it stays disabled with "선택한 항목 중 상신할 것이 없습니다 — …". ${DEV} Data: read-only.`);

    await step('Arrange: Pre-condition 1–2 — The open cycle with mixed rows', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — With nothing selected hover 선택 일괄 상신', async () => {
      await list.submitWrapper.hover();
    });

    await step('Assert: Expected 1 — Disabled; the tooltip reads "상신할 행을 먼저 선택하세요."', async () => {
      await expect(list.submitButton, '[Expected 1] Disabled').toBeDisabled();
      await expect(list.submitWrapper, '[Expected 1] Reason tooltip').toHaveAttribute('title', FR_KO['msg.submitNothingSelected']);
    });

    await step('Act: Step 2 — Select only rows without a draft and hover again', async () => {
      await list.rowCheckbox(list.row(FIXTURE.resolvedAnnex)).check();
      await list.submitWrapper.hover();
    });

    await step('Assert: Expected 2 — Still disabled with the second reason', async () => {
      await expect(list.submitButton, '[Expected 2] Disabled').toBeDisabled();
      await expect(list.submitWrapper, '[Expected 2] Nothing-to-send tooltip').toHaveAttribute('title', FR_KO['msg.submitNothingToSend']);
    });
  });

  test('TC_US079_87 — The header checkbox selects and clears every row on the current page only', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_87', 'Medium', TAGS, `On the 13-product view (two pages at 10 rows) the header checkbox selects every row of page 1, none on page 2, and clears page 1 when clicked again. ${DEV} Data: read-only.`);
    let pageTwoChecked = -1;

    await step('Arrange: Pre-condition 1–2 — More than one page of rows', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL', pageSize: '10' });
    });

    await step('Act: Step 1 — Click the header checkbox', async () => {
      await list.headerCheckbox.check();
    });

    await step('Assert: Expected 1 — Every row on page 1 is selected', async () => {
      const boxes = await list.rows.getByRole('checkbox').all();
      expect(boxes.length, '[Expected 1] Page 1 has rows').toBeGreaterThan(0);
      for (const box of boxes) await expect(box, '[Expected 1] Row selected').toBeChecked();
    });

    await step('Act: Step 2 — Move to page 2 and check its rows', async () => {
      await list.goToPage('Next');
      pageTwoChecked = await list.rows.locator('input[type="checkbox"]:checked').count();
    });

    await step('Assert: Expected 2 — No row on page 2 is selected', async () => {
      expect(pageTwoChecked, '[Expected 2] Nothing selected on page 2').toBe(0);
    });

    await step('Act: Step 3 — Back on page 1, click the header checkbox again', async () => {
      await list.goToPage('Previous');
      if (await list.headerCheckbox.isChecked()) await list.headerCheckbox.uncheck();
      else {
        await list.headerCheckbox.check();
        await list.headerCheckbox.uncheck();
      }
    });

    await step('Assert: Expected 3 — Every selection on page 1 is cleared', async () => {
      await expect(list.rows.locator('input[type="checkbox"]:checked'), '[Expected 3] Nothing selected').toHaveCount(0);
    });
  });

  test('TC_US079_88 — The submitter can withdraw a pending correction; it returns to editable and leaves the queue', async ({ page, feeReviewApi, feeReviewState, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_88', 'Critical', TAGS, `The submitter withdraws the pending correction on ${FIXTURE.forSave} (replaces 880021): the dialog carries no reason field; the toast reads "수정 건을 회수했습니다. 승인 대기열에서 빠졌으며 다시 수정할 수 있습니다."; 수정 opens it as a live draft, the approval record leaves the queue (read through the API), selecting the row enables 선택 일괄 상신 so it can be resubmitted as is, and History names who withdrew it and when. ${DEV} ${CLEAN}`);
    let approvalId = 0;

    await step('Arrange: Pre-condition 1–2 — A correction awaiting approval submitted by this account', async () => {
      approvalId = (await feeReviewState.pending(feeReviewApi, FIXTURE.forSave, RATE_MOVING, autoReason('TC_US079_88', 'to be withdrawn'))).approval.id;
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Click 회수 (Withdraw)', async () => {
      await list.openWithdraw(list.row(FIXTURE.forSave));
    });

    await step('Assert: Expected 1 — The dialog states what withdrawing causes, with no reason field', async () => {
      await expect(list.withdraw.body, '[Expected 1] Body').toContainText(FR_KO['withdraw.body']);
      await expect(list.withdraw.reasonField, '[Expected 1] No reason field').toHaveCount(0);
    });

    await step('Act: Step 2 — Confirm 회수', async () => {
      expect((await list.withdraw.confirm()).status(), 'The withdrawal succeeds').toBeLessThan(300);
    });

    await step('Assert: Expected 2 — The toast reads exactly the withdrawn message', async () => {
      await expect(list.toast(FR_KO['withdraw.done']), '[Expected 2] Withdrawn toast').toBeVisible();
    });

    await step('Act: Step 3 — Open 수정 afterwards', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await list.openCorrect(list.row(FIXTURE.forSave));
    });

    await step('Assert: Expected 3 — Editable again as a live draft; no longer in the queue; resubmittable as is', async () => {
      await expect(list.correct.saveButton, '[Expected 3] The dialog opens as a live draft (not blocked)').toBeVisible();
      await list.correct.cancel();
      expect((await feeReviewApi.approval(approvalId)).body.approvalStatus, '[Expected 3] Left the approval queue').not.toBe('PENDING');
      await list.rowCheckbox(list.row(FIXTURE.forSave)).check();
      await expect(list.submitButton, '[Expected 3] Can be resubmitted without being recreated').toBeEnabled();
      await list.rowCheckbox(list.row(FIXTURE.forSave)).uncheck();
    });

    await step('Act: Step 4 — Open 이력 (History)', async () => {
      await list.openHistory(list.row(FIXTURE.forSave));
    });

    await step('Assert: Expected 4 — An entry names who withdrew it and when', async () => {
      const entry = list.history.rows.filter({ hasText: FR_KO['outcome.WITHDRAWN'] }).first();
      await expect(entry, '[Expected 4] Withdrawal entry').toBeVisible();
      await expect(entry, '[Expected 4] Names who').toContainText(getAccountDisplayName('submitter'));
      await expect(entry, '[Expected 4] Names when').toContainText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
      await list.history.close();
    });
  });

  test('TC_US079_89 — A withdrawal by somebody other than the submitter is refused and the correction stays in the queue', async ({ page, feeReviewApi, approverFeeReviewApi, feeReviewState, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_89', 'Medium', TAGS, `With a pending correction on ${FIXTURE.forSave} submitted by the approver account, the maker account's withdrawal is refused with STL-1013 "이 수정 건은 상신한 담당자만 회수할 수 있습니다." and the correction stays pending. ${DEV} ${CLEAN}`);
    let result = { status: 0, body: '' };

    await step('Arrange: Pre-condition 1–2 — A pending correction submitted by a different account', async () => {
      await feeReviewState.pending(approverFeeReviewApi, FIXTURE.forSave, RATE_MOVING, autoReason('TC_US079_89', 'submitted by the other account'));
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Attempt to open / confirm 회수 as the other account', async () => {
      await list.openWithdraw(list.row(FIXTURE.forSave));
      const response = await list.withdraw.confirm();
      result = { status: response.status(), body: await response.text() };
    });

    await step('Assert: Expected 1 — Refused with STL-1013', async () => {
      expect(result.status, '[Expected 1] Refused').toBeGreaterThanOrEqual(400);
      expect(result.body, '[Expected 1] STL-1013').toContain('STL-1013');
      await expect(page.getByText(FR_KO['errCode.notSubmitter']).first(), '[Expected 1] Not-submitter message').toBeVisible();
    });

    await step("Assert: Expected 2 — The correction stays in the approver's queue", async () => {
      expect((await feeReviewApi.row(CYCLE.id, FIXTURE.forSave)).correction?.state, '[Expected 2] Still pending').toBe('PENDING');
    });
  });

  test('TC_US079_90 — A withdrawal confirmed after the approver decided is refused, the decision stands and the row reloads', async ({ page, feeReviewApi, approverFeeReviewApi, feeReviewState, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_90', 'Medium', TAGS, `The submitter opens the Withdraw confirmation on ${FIXTURE.forSave}; the approver rejects meanwhile (API); confirming is refused with STL-1015 "이미 승인 담당자가 처리한 수정 건입니다. 화면을 새로 고쳤습니다."; the rejection stands and the row reloads showing it. Deviation: the approver session is an API call. Deviation: the TC's Expected 1 (refusal) is the outcome of Steps 2–3, so the approver decision and the confirm run inside Expected 1 and Steps 2–3 verify what they produced. ${DEV} ${CLEAN}`);
    let approvalId = 0;
    let result = { status: 0, body: '' };

    await step('Arrange: Pre-condition 1–2 — A pending correction; two sessions', async () => {
      approvalId = (await feeReviewState.pending(feeReviewApi, FIXTURE.forSave, RATE_MOVING, autoReason('TC_US079_90', 'race with the approver'))).approval.id;
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — The submitter opens the Withdraw confirmation and pauses', async () => {
      await list.openWithdraw(list.row(FIXTURE.forSave));
    });

    await step('Assert: Expected 1 — (on confirm) the withdrawal is refused with STL-1015', async () => {
      expect((await approverFeeReviewApi.reject(approvalId, autoReason('TC_US079_90', 'decided first'))).status, 'The approver decides first').toBeLessThan(300);
      const response = await list.withdraw.confirm();
      result = { status: response.status(), body: await response.text() };
      expect(result.status, '[Expected 1] Refused').toBeGreaterThanOrEqual(400);
      expect(result.body, '[Expected 1] STL-1015').toContain('STL-1015');
      await expect(page.getByText(FR_KO['errCode.alreadyDecided']).first(), '[Expected 1] Already-decided message').toBeVisible();
    });

    await step('Act: Step 2 — The approver decides the same correction (done while the dialog was open)', async () => {
      expect((await feeReviewApi.approval(approvalId)).body.approvalStatus, 'The approver decision was stored').not.toBe('PENDING');
    });

    await step("Assert: Expected 2 — The approver's decision stands", async () => {
      expect((await feeReviewApi.row(CYCLE.id, FIXTURE.forSave)).correction?.state, '[Expected 2] Still rejected').toBe('REJECTED');
    });

    await step('Act: Step 3 — The submitter confirmed 회수 (above); look at the row', async () => {
      await list.row(FIXTURE.forSave).scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — The row reloads showing its new state', async () => {
      await expect(list.statusPills(list.row(FIXTURE.forSave)).nth(1), '[Expected 3] 반려됨 — 수정 후 재상신').toHaveText(FR_KO['state.REJECTED']);
    });
  });

  test('TC_US079_91 — Approving puts a correction in force and rejecting returns the product to Needs review with the reason captured', async ({ page, feeReviewApi, feeReviewState, feeReviewPage: list, secondSession }) => {
    const step = makeStep(page);
    const reasons = [autoReason('TC_US079_91', 'to be approved'), autoReason('TC_US079_91', 'to be rejected')];
    const rejectReason = autoReason('TC_US079_91', '동순위 재검토 필요');
    await tcMeta('TC_US079_91', 'Critical', TAGS, `Approving the correction on ${FIXTURE.forSave} (replaces 900412) makes it 승인됨 — 적용 with the new category and rate in force on the list; rejecting the one on ${FIXTURE.resolvedAnnex} (replaces 900277) with "동순위 재검토 필요" makes it 반려됨 — 수정 후 재상신, back in 확인 필요 (Needs review), with the reason in History. The approver is a second browser session. ${DEV} ${CLEAN}`);
    const ids: number[] = [];
    let approvedCategory = '';
    let approvedRate = '';
    let approver: Awaited<ReturnType<typeof secondSession>>;

    await step('Arrange: Pre-condition 1–2 — Two corrections awaiting approval; the approver session', async () => {
      const first = await feeReviewState.pending(feeReviewApi, FIXTURE.forSave, RATE_MOVING, reasons[0]);
      ids.push(first.approval.id);
      approvedCategory = first.category;
      approvedRate = await categoryRate(feeReviewApi, FIXTURE.forSave, first.category);
      ids.push((await feeReviewState.pending(feeReviewApi, FIXTURE.resolvedAnnex, RATE_MOVING, reasons[1])).approval.id);
      approver = await secondSession('approver');
    });

    await step('Act: Step 1 — Open the first record and click 승인 (Approve)', async () => {
      await approver.queue.openRequest({ register: REGISTER, requester: getAccountDisplayName('submitter'), changeApprovalId: ids[0], reason: reasons[0] });
      await approver.queue.approve();
      await expect(approver.queue.approvedToast, 'Approved toast').toBeVisible();
    });

    await step('Assert: Expected 1 — 승인됨 — 적용; the new category / rate is in force on the list', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await expect(list.statusPills(list.row(FIXTURE.forSave)).nth(1), '[Expected 1] 승인됨 — 적용').toHaveText(FR_KO['state.APPROVED']);
      await expect(list.cell(list.row(FIXTURE.forSave), 'category'), `[Expected 1] ${approvedCategory} in force`).toHaveText(approvedCategory);
      await expect(list.cell(list.row(FIXTURE.forSave), 'rate'), `[Expected 1] ${approvedRate}% in force`).toHaveText(new RegExp(`^${esc(approvedRate)}`));
    });

    await step('Act: Step 2 — Open the second record, click 반려, type the reason and confirm', async () => {
      await approver.queue.openRequest({ register: REGISTER, requester: getAccountDisplayName('submitter'), changeApprovalId: ids[1], reason: reasons[1] });
      await approver.queue.openRejectDialog();
      await approver.queue.confirmReject(rejectReason);
      await expect(approver.queue.rejectedToast, 'Rejected toast').toBeVisible();
    });

    await step('Assert: Expected 2 — 반려됨 — 수정 후 재상신; back in 확인 필요; the reason is in History', async () => {
      await list.open({ cycleId: CYCLE.id });
      expect(await list.productIds(), '[Expected 2] Back in 확인 필요 (Needs review)').toContain(FIXTURE.resolvedAnnex);
      await expect(list.statusPills(list.row(FIXTURE.resolvedAnnex)).nth(1), '[Expected 2] 반려됨 — 수정 후 재상신').toHaveText(FR_KO['state.REJECTED']);
      await list.openHistory(list.row(FIXTURE.resolvedAnnex));
      await expect(list.history.root, '[Expected 2] Reject reason 동순위 재검토 필요 captured').toContainText(rejectReason.slice(-15));
      await list.history.close();
    });
  });

  test('TC_US079_93 — Submitting again after a rejection creates a new approval record without overwriting the rejected one', async ({ page, feeReviewApi, approverFeeReviewApi, feeReviewState, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_93', 'High', TAGS, `On ${FIXTURE.forSave} (replaces 880021) a submission, its rejection and a resubmission read as three distinct History entries in order — the resubmission is a new record. Deviation: the reject → fix → resubmit sequence is created through the API during Arrange. ${DEV} ${CLEAN}`);
    let entries: string[] = [];

    await step('Arrange: Pre-condition 1–2 — The product went through reject → fix → resubmit', async () => {
      const first = await feeReviewState.pending(feeReviewApi, FIXTURE.forSave, RATE_MOVING, autoReason('TC_US079_93', 'first submission'));
      await approverFeeReviewApi.reject(first.approval.id, autoReason('TC_US079_93', 'rejected'));
      const option = (await feeReviewApi.options(CYCLE.id, FIXTURE.forSave)).categories.find((c) => c.categoryName === (first.category === P14.moving ? P14.other : P14.moving));
      const saved = await feeReviewApi.save(CYCLE.id, FIXTURE.forSave, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: option?.categoryId, reason: autoReason('TC_US079_93', 'resubmission'), previewRoute: option?.route, correctionId: first.correctionId });
      const id = saved.body?.correctionId ?? first.correctionId;
      feeReviewState.track(feeReviewApi, id, FIXTURE.forSave, 'NORMAL', P14.original);
      await feeReviewApi.submit([id]);
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Open 이력 and read the sequence of entries', async () => {
      await list.openHistory(list.row(FIXTURE.forSave));
      entries = (await list.history.rows.filter({ hasText: 'TC_US079_93' }).allInnerTexts()).map((t) => t.replace(/\s+/g, ' '));
    });

    await step('Assert: Expected 1 — Submission, rejection and resubmission are three distinct entries in order', async () => {
      const submission = entries.findIndex((e) => e.includes('first submission') && !e.includes('— rejected'));
      const rejection = entries.findIndex((e) => e.includes('— rejected'));
      const resubmission = entries.findIndex((e) => e.includes('resubmission'));
      expect(entries.length, '[Expected 1] At least three entries').toBeGreaterThanOrEqual(3);
      expect(submission, '[Expected 1] The first submission is its own entry').toBeGreaterThanOrEqual(0);
      expect(rejection, '[Expected 1] The rejection is kept as its own entry').toBeGreaterThanOrEqual(0);
      expect(resubmission, '[Expected 1] The resubmission is its own entry').toBeGreaterThanOrEqual(0);
      expect(new Set([submission, rejection, resubmission]).size, '[Expected 1] Three distinct entries').toBe(3);
      const ordered = (submission < rejection && rejection < resubmission) || (submission > rejection && rejection > resubmission);
      expect(ordered, `[Expected 1] Read in order submission → rejection → resubmission (indexes ${submission}, ${rejection}, ${resubmission})`).toBe(true);
      await list.history.close();
    });
  });

  test('TC_US079_94 — Approving the same record twice produces only one business effect', async ({ page, feeReviewApi, feeReviewState, secondSession }) => {
    const step = makeStep(page);
    const reason = autoReason('TC_US079_94', 'double approve');
    await tcMeta('TC_US079_94', 'High', TAGS, `Approving the correction on ${FIXTURE.forSave} and then trying to approve it again as fast as possible leaves one approved state and one applied change. AWAITING in TC v4: the SRS specifies no guard for a repeated decision (⚠ TBC, QA-03) — only the TC's minimum is asserted and the second attempt's outcome is recorded. ${DEV} ${CLEAN}`);
    let approvalId = 0;
    let approver: Awaited<ReturnType<typeof secondSession>>;
    let historyBefore = 0;

    await step('Arrange: Pre-condition 1–2 — A correction awaiting approval; the approver session', async () => {
      approvalId = (await feeReviewState.pending(feeReviewApi, FIXTURE.forSave, RATE_MOVING, reason)).approval.id;
      historyBefore = (await feeReviewApi.history(CYCLE.id, FIXTURE.forSave)).length;
      approver = await secondSession('approver');
      await approver.queue.openRequest({ register: REGISTER, requester: getAccountDisplayName('submitter'), changeApprovalId: approvalId, reason });
    });

    await step('Act: Step 1 — Click 승인 (Approve)', async () => {
      await approver.queue.approve();
    });

    await step('Act: Step 2 — Try to trigger 승인 a second time on the same record', async () => {
      // Nút có thể biến mất ngay sau lần duyệt đầu — lần bấm thứ 2 thất bại là kết quả hợp lệ, được ghi nhận qua lời gọi API bên dưới.
      if (await approver.queue.approveButton.isVisible()) await approver.queue.approveButton.dblclick({ force: true, timeout: 5_000 }).catch(() => undefined);
      const second = await feeReviewApi.approve(approvalId);
      test.info().annotations.push({ type: 'Observed (⚠ TBC)', description: `second approve → ${second.status}` });
    });

    await step('Assert: Expected 1 — The state does not toggle and the correction is applied once', async () => {
      expect((await feeReviewApi.row(CYCLE.id, FIXTURE.forSave)).correction?.state, '[Expected 1] Approved once — the state does not toggle').toBe('APPROVED');
      expect((await feeReviewApi.history(CYCLE.id, FIXTURE.forSave)).length - historyBefore, '[Expected 1] One approval entry — applied only once').toBeLessThanOrEqual(1);
    });
  });

  test('TC_US079_95 — The existing register types keep their own detail panels unaffected by the Fee Rule register', async ({ page, feeReviewApi, feeReviewState, approvalQueuePage: queue }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_95', 'High', TAGS, `With a Fee Rule record pending, a record of another register (${OTHER_REGISTER}) still opens its own detail panel (변경 요약, 사유), the register filter still works and its 승인 / 반려 decisions are offered (not clicked — shared data). Not automated: the cross-cycle half (one product pending in two open cycles) — BLOCKED per the TC remark. ${DEV} ${CLEAN}`);

    await step('Arrange: Pre-condition 1–2 — A Fee Rule record and records of other registers are pending', async () => {
      await feeReviewState.pending(feeReviewApi, FIXTURE.forSave, RATE_MOVING, autoReason('TC_US079_95', 'fee rule alongside others'));
    });

    await step('Act: Step 1 — Open the queue and a record of another pre-existing register', async () => {
      await queue.open();
      await queue.showRegister(OTHER_REGISTER);
      await queue.queueItems.first().click();
    });

    await step('Assert: Expected 1 — Its detail panel, filters and decisions behave as before', async () => {
      await expect.soft(queue.changeSummaryHeading, '[Expected 1] Detail panel: 변경 요약').toBeVisible();
      await expect.soft(queue.reasonHeading, '[Expected 1] Detail panel: 사유 (기안자)').toBeVisible();
      await expect.soft(queue.registerFilterSelect, '[Expected 1] Filter: 원장 still applied').toHaveValue(/.+/);
      await expect.soft(queue.approveButton, '[Expected 1] Decision: 승인 (Approve) offered').toBeEnabled();
      await expect.soft(queue.rejectButton, '[Expected 1] Decision: 반려 (Reject) offered').toBeEnabled();
    });
  });

  test('TC_US079_96 — A Fee Rule record is reachable through the register type filter', async ({ page, feeReviewApi, feeReviewState, approvalQueuePage: queue }) => {
    const step = makeStep(page);
    const reason = autoReason('TC_US079_96', 'register filter');
    await tcMeta('TC_US079_96', 'Medium', TAGS, `The pending Fee Rule record of ${FIXTURE.forSave} (replaces 880021) appears when 원장 = 수수료 규칙 (Fee Rule) is selected and disappears under another register (${OTHER_REGISTER}). ${DEV} ${CLEAN}`);
    let approvalId = 0;
    let underFeeRule = -1;
    let underOther = -1;

    await step('Arrange: Pre-condition 1–2 — A pending Fee Rule record', async () => {
      approvalId = (await feeReviewState.pending(feeReviewApi, FIXTURE.forSave, RATE_MOVING, reason)).approval.id;
    });

    await step('Act: Step 1 — Select the Fee Rule register, then an unrelated register', async () => {
      await queue.openRequest({ register: REGISTER, requester: getAccountDisplayName('submitter'), changeApprovalId: approvalId, reason });
      underFeeRule = await queue.queueItems.filter({ hasText: FIXTURE.forSave }).count();
      await queue.showRegister(OTHER_REGISTER);
      underOther = await queue.queueItems.filter({ hasText: FIXTURE.forSave }).count();
    });

    await step('Assert: Expected 1 — Present under Fee Rule, absent under the other register', async () => {
      expect.soft(underFeeRule, '[Expected 1] Listed under 수수료 규칙 (Fee Rule)').toBeGreaterThan(0);
      expect.soft(underOther, `[Expected 1] Not listed under ${OTHER_REGISTER}`).toBe(0);
    });
  });

  test('TC_US079_97 — An approver can reject a pending correction when the submitter is unavailable', async ({ page, feeReviewApi, feeReviewState, feeReviewPage: list, secondSession }) => {
    const step = makeStep(page);
    const reason = autoReason('TC_US079_97', 'submitter unavailable');
    const rejectReason = autoReason('TC_US079_97', '기안자 퇴사로 재검토 필요 — 담당자 변경 후 재상신 요망');
    await tcMeta('TC_US079_97', 'Medium', TAGS, `The approver rejects the pending correction on ${FIXTURE.forSave} with a reason naming the submitter as no longer responsible; the reason is stored, the product returns to 확인 필요 (Needs review) and 수정 is open again so a new submission can be raised. Not automated: "the sequence stays readable" — covered by TC_US079_93. ${DEV} ${CLEAN}`);
    let approvalId = 0;

    await step('Arrange: Pre-condition 1–2 — A pending correction; no deactivation is performed', async () => {
      approvalId = (await feeReviewState.pending(feeReviewApi, FIXTURE.forSave, RATE_MOVING, reason)).approval.id;
    });

    await step('Act: Step 1 — Open the record, click 반려, type the reason and confirm', async () => {
      const approver = await secondSession('approver');
      await approver.queue.openRequest({ register: REGISTER, requester: getAccountDisplayName('submitter'), changeApprovalId: approvalId, reason });
      await approver.queue.openRejectDialog();
      await approver.queue.confirmReject(rejectReason);
      await expect(approver.queue.rejectedToast, 'Rejected toast').toBeVisible();
    });

    await step('Assert: Expected 1 — The rejection succeeds without the submitter acting', async () => {
      expect((await feeReviewApi.row(CYCLE.id, FIXTURE.forSave)).correction?.state, '[Expected 1] Rejected').toBe('REJECTED');
    });

    await step('Act: Step 2 — Read the stored reject reason', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await list.openHistory(list.row(FIXTURE.forSave));
    });

    await step('Assert: Expected 2 — The reject reason is recorded', async () => {
      await expect(list.history.root, '[Expected 2] Reject reason naming the submitter as no longer responsible').toContainText(rejectReason.slice(-20));
      await list.history.close();
    });

    await step("Act: Step 3 — Check the product's bucket on the main list", async () => {
      await list.open({ cycleId: CYCLE.id });
    });

    await step('Assert: Expected 3 — The product returns to Needs review and can be raised again', async () => {
      expect(await list.productIds(), '[Expected 3] In 확인 필요 (Needs review)').toContain(FIXTURE.forSave);
      await expect(list.rowButton(list.row(FIXTURE.forSave), 'btn.correct'), '[Expected 3] 수정 (Correct) is open for a new submission').toBeEnabled();
    });
  });
});
