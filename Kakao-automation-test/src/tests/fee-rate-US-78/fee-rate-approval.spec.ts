import { test, expect } from '@fixtures/fee-rate.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { getAccountDisplayName } from '@utils/auth-token';
import { FEE_TEXT, KEY, FeeKey, QUEUE_NOT_COMPUTABLE, inDays } from '@utils/fee-rate.data';

/**
 * US078 — nhóm [Approval]: request fee rate trong hàng đợi 변경 승인 (US120), impact box, khoá dòng khi chờ.
 * Nguồn TC: input/TESTCASE_US078_v2.md (Steps N / Expected N → `Act: Step N` / `Assert: Expected N`).
 * TC cần người DUYỆT / TỪ CHỐI khác người gửi (TC_US078_64–68, 73–80) nằm ở fee-rate-decision.spec.ts (maker ≠ checker từ
 * 30/09). Dữ liệu: contract automation tạo qua API (không xoá được); đơn chờ rút lại ở teardown.
 */
const TAGS = ['ui', 'fee-rate', 'fee-rate-approval'];
const DATA = 'Data: automation-owned contract(s) created through the API (contracts cannot be deleted); pending requests are withdrawn in teardown.';
const NOT_COMPUTABLE = QUEUE_NOT_COMPUTABLE;
const FANCLUB_KIT_SELF: FeeKey = { category: 'FANCLUB_KIT', saleType: 'SELF' };

test.describe('[Approval] Fee rate requests in the change approval queue', () => {
  test.describe.configure({ timeout: 150_000 });

  test('TC_US078_69 — The approval queue shows the impact status and a sentence on how many order lines it could affect', async ({ page, feeRateContracts, changeApprovalQueuePage: queue }) => {
    const step = makeStep(page);
    const reason = 'Impact check right after submitting';
    await tcMeta('TC_US078_69', 'Medium', TAGS, `Opened right after it arrives, the Fee Rate request's impact box shows "산출 불가" together with a sentence naming the scan scope (the order lines it could reach) — never an empty summary. Deviation from TC: the APPROVER opens their own request (only one contract-capable account — decision 28/09). ${DATA}`);
    let changeApprovalId: number | null | undefined;

    await step('Arrange: Pre-condition 1–2 — Logged in as APPROVER; a fee rate request has just been submitted', async () => {
      const contract = await feeRateContracts.create('TC_US078_69', 'RUNNING');
      changeApprovalId = (await feeRateContracts.submit(contract.id, KEY.MD, { changeKind: 'CORRECTION', commission: '8', changeReason: reason })).changeApprovalId;
    });

    await step('Act: Step 1 — Open the request in 변경 승인 immediately after it arrives', async () => {
      await queue.openRequest({ register: FEE_TEXT.queue.register, requester: getAccountDisplayName('approver'), changeApprovalId: changeApprovalId!, reason });
    });

    await step('Assert: Expected 1 — "not computable" with a sentence naming the scan scope — never an empty summary', async () => {
      const impact = queue.impactSection;
      await expect(impact, '[Expected 1] The impact box reads not computable').toContainText(NOT_COMPUTABLE);
      await expect(impact, '[Expected 1] A sentence names how many order lines the change could reach').toContainText(/주문 라인|order line/i);
    });
  });

  test('TC_US078_70 — The Register filter lists all five entries, opens on All, and shows the fee row detail for Fee Rate', async ({ page, feeRateContracts, changeApprovalQueuePage: queue }) => {
    const step = makeStep(page);
    const reason = 'Register filter check';
    const tcOptions = [
      { name: 'All (전체)', label: /^(전체|All)$/ },
      { name: 'FX Rate (환율)', label: /환율|FX Rate/ },
      { name: 'Coupon Burden (쿠폰 부담)', label: /쿠폰 부담|Coupon Burden/ },
      { name: 'Fee Rate (수수료율)', label: /^(수수료율|Fee Rate)$/ },
      { name: 'Fee Rule (수수료 규칙)', label: /^(수수료 규칙|Fee Rule)$/ },
    ];
    await tcMeta('TC_US078_70', 'Medium', TAGS, `The 원장 filter opens on 전체 and offers exactly five entries — All, FX Rate, Coupon Burden, Fee Rate, Fee Rule; picking Fee Rate lists only fee rate requests and the detail shows the fee row context. Known UI difference (28/09): the filter also lists 결제수단 정책 (six entries) and shows "Fee Rate" / "Fee Rule" in English inside the Korean UI — reported to the BA. ${DATA}`);
    let options: string[] = [];
    let changeApprovalId: number | null | undefined;

    await step('Arrange: Pre-condition 1–2 — Logged in as APPROVER; at least one pending Fee Rate request exists', async () => {
      const contract = await feeRateContracts.create('TC_US078_70', 'RUNNING');
      changeApprovalId = (await feeRateContracts.submit(contract.id, KEY.MD, { changeKind: 'CORRECTION', commission: '8', changeReason: reason })).changeApprovalId;
    });

    await step("Act: Step 1 — Go to 변경 승인 and read the Register filter's default selection and its option list", async () => {
      await queue.open();
      options = (await queue.registerFilterSelect.locator('option').allTextContents()).map((o) => o.trim());
    });

    await step('Assert: Expected 1 — The filter opens on 전체; its options are the five entries', async () => {
      await expect(queue.registerFilterSelect.locator('option:checked'), '[Expected 1] The filter opens on 전체 (All)').toHaveText('전체');
      for (const option of tcOptions) {
        expect(options.some((o) => option.label.test(o)), `[Expected 1] Option ${option.name} is listed`).toBe(true);
      }
      expect(options, '[Expected 1] Exactly five entries').toHaveLength(5);
    });

    await step('Act: Step 2 — Pick Fee Rate and open a pending fee rate request', async () => {
      await queue.openRequest({ register: FEE_TEXT.queue.register, requester: getAccountDisplayName('approver'), changeApprovalId: changeApprovalId!, reason });
    });

    await step('Assert: Expected 2 — The queue lists only fee rate requests; the detail shows the fee row context', async () => {
      const items = await queue.queueItems.allTextContents();
      expect(items.every((item) => item.trim().startsWith(FEE_TEXT.queue.register)), '[Expected 2] Every listed item is a Fee Rate request').toBe(true);
      await expect(queue.panelValue('원장'), '[Expected 2] The detail belongs to the Fee Rate register').toHaveText(FEE_TEXT.queue.register);
      await expect(queue.changeSummaryHeading, '[Expected 2] The fee row context (변경 요약) is shown').toBeVisible();
    });
  });

  test('TC_US078_71 — The approval queue and the change dialog say the same thing about impact for one request', async ({ page, feeRateContracts, contractFeePage: fee, changeApprovalQueuePage: queue }) => {
    const step = makeStep(page);
    const reason = 'Impact agreement check';
    await tcMeta('TC_US078_71', 'Medium', TAGS, `The Change rate dialog reads "산출 불가" for a correction, and the same request in 변경 승인 also reads "not computable" — no computed count on either side. Deviation from TC: submitter and reviewer are the same account (only one contract-capable account — decision 28/09). ${DATA}`);
    let contract = { id: 0 };
    let dialogBadge = '';
    let dialogBody = '';
    let changeApprovalId: number | undefined;

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN (submit) and APPROVER (review); the MD row is Active', async () => {
      contract = await feeRateContracts.create('TC_US078_71', 'RUNNING');
    });

    await step('Act: Step 1 — As ADMIN submit a correction and read the Impact box in the change dialog', async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD));
      await fee.changeDialog.fill({ kind: 'correction', rate: '8', reason });
      dialogBadge = ((await fee.changeDialog.impactBadge.textContent()) ?? '').trim();
      dialogBody = ((await fee.changeDialog.impactBody.textContent()) ?? '').trim();
      changeApprovalId = (await fee.changeDialog.submit()).body?.changeApprovalId;
    });

    await step('Assert: Expected 1 — The dialog reads not computable', async () => {
      expect(dialogBadge, '[Expected 1] The dialog impact reads 산출 불가').toBe(FEE_TEXT.dialog.notComputable);
      expect(dialogBody.match(/\d+\s*건/), '[Expected 1] No computed count in the dialog').toBeNull();
    });

    await step('Act: Step 2 — As APPROVER open the same request in 변경 승인 and read its Impact box', async () => {
      await queue.openRequest({ register: FEE_TEXT.queue.register, requester: getAccountDisplayName('approver'), changeApprovalId: changeApprovalId!, reason });
    });

    await step('Assert: Expected 2 — The queue also reads not computable — both surfaces agree, no computed count', async () => {
      const impact = queue.impactSection;
      await expect(impact, '[Expected 2] The queue impact reads not computable').toContainText(NOT_COMPUTABLE);
      await expect(queue.panelValue('영향 건수'), '[Expected 2] No computed impact count is shown').not.toHaveText(/^\d+$/);
    });
  });

  test('TC_US078_72 — A new fee row in the queue reads New fee row, a dash for the previous value, and no difference row', async ({ page, feeRateContracts, contractFeePage: fee, changeApprovalQueuePage: queue }) => {
    const step = makeStep(page);
    const reason = 'New fee row for the queue check';
    await tcMeta('TC_US078_72', 'Medium', TAGS, `A new fee row submitted on a running contract appears in 변경 승인 with change type "신규" (New fee row), "Previously approved" reading "— (new fee row)", and no "Proposed change" difference row. Deviation from TC: the reviewer is the submitting account (decision 28/09). ${DATA}`);
    let changeApprovalId: number | undefined;

    await step('Arrange: Pre-condition 1–2 — Logged in as APPROVER; a new fee row submitted on a running contract is pending', async () => {
      const contract = await feeRateContracts.create('TC_US078_72', 'RUNNING');
      await fee.openEdit(contract.id);
      await fee.addButton.click();
      await fee.fillNewRow({ ...FANCLUB_KIT_SELF, rate: 12 });
      changeApprovalId = (await fee.saveWithReason(reason))[0]?.body?.changeApprovalId;
    });

    await step('Act: Step 1 — Open the pending "new fee row" request in 변경 승인', async () => {
      await queue.openRequest({ register: FEE_TEXT.queue.register, requester: getAccountDisplayName('approver'), changeApprovalId: changeApprovalId!, reason });
    });

    await step('Assert: Expected 1 — Change type 신규; Previously approved "— (new fee row)"; no Proposed change difference row', async () => {
      await expect(queue.panelValue('변경 유형'), '[Expected 1] Change type reads 신규 (New fee row)').toHaveText(/^신규/);
      await expect(page.getByText(/—\s*\((new fee row|신규 수수료 행)\)/), '[Expected 1] "Previously approved" reads "— (new fee row)"').toBeVisible();
      await expect(queue.changeContentHeading.locator('xpath=following-sibling::*[1]').getByText('→'), '[Expected 1] No before → after difference row is rendered').toHaveCount(0);
    });
  });

  test('TC_US078_82 — A request nobody decides leaves that fee row locked until the sender withdraws it', async ({ page, feeRateApi, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_82', 'Medium', TAGS, `While the Fan Club request is pending, a second submission is refused (the row stays locked to one pending request); withdrawing succeeds; a new submission then succeeds. Deviation from TC: the pending row offers no Change rate control, so the second attempt goes through the change endpoint. ${DATA}`);
    let contract = { id: 0 };
    let second = 0;
    let third = 0;

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; Fan Club has a pending request left undecided', async () => {
      contract = await feeRateContracts.create('TC_US078_82', 'RUNNING');
      await feeRateContracts.submit(contract.id, KEY.FANCLUB, { changeKind: 'RATE_CHANGE', commission: '6.5', effectiveFrom: inDays(3), changeReason: 'Undecided request' });
    });

    await step('Act: Step 1 — Try to submit a second change on the same row while the first is still pending', async () => {
      second = (await feeRateApi.submitChange(contract.id, await feeRateContracts.rowId(contract.id, KEY.FANCLUB), { changeKind: 'CORRECTION', commission: '6', changeReason: 'Second change' })).status;
    });

    await step('Assert: Expected 1 — The second submission is refused — one pending request at a time', async () => {
      expect(second, '[Expected 1] The second submission is refused').toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 2 — Withdraw the pending request', async () => {
      await fee.openEdit(contract.id);
      await fee.openWithdraw(fee.row(KEY.FANCLUB));
      await fee.withdrawDialog.confirmButton.click();
    });

    await step('Assert: Expected 2 — Withdrawal succeeds', async () => {
      await expect(fee.toast(FEE_TEXT.withdrawnDone), '[Expected 2] The withdrawal is confirmed').toBeVisible();
    });

    await step('Act: Step 3 — Submit a new change on the same row', async () => {
      await fee.openChangeDialog(fee.row(KEY.FANCLUB));
      await fee.changeDialog.fill({ kind: 'correction', rate: '6', reason: 'New change after withdrawal' });
      third = (await fee.changeDialog.submit()).status;
    });

    await step('Assert: Expected 3 — The new submission succeeds — the row is unlocked', async () => {
      expect(third, '[Expected 3] The new submission is accepted (201)').toBe(201);
    });
  });

  test('TC_US078_83 — The parts of the approval queue that this feature does not touch still work as before', async ({ page, feeRateContracts, contractFeePage: fee, changeApprovalQueuePage: queue }) => {
    const step = makeStep(page);
    const reason = 'Queue regression check';
    await tcMeta('TC_US078_83', 'High', TAGS, `승인 / 반려 exist only on 변경 승인 (not on the Fee Information tab) and 회수 only on the tab (not in the queue); only one decision per record — no batch selection. Not automated: step 1 / Expected 1 (the queue columns match the pre-existing shape — no baseline of the old shape exists) and the hand-back fields of a rejected item in step 3 (a rejected fee request needs a second approver — decision 28/09). ${DATA}`);
    let contract = { id: 0 };
    let changeApprovalId: number | null | undefined;

    await step('Arrange: Pre-condition 1–2 — Logged in as APPROVER; 변경 승인 has pending items across registers', async () => {
      contract = await feeRateContracts.create('TC_US078_83', 'RUNNING');
      changeApprovalId = (await feeRateContracts.submit(contract.id, KEY.MD, { changeKind: 'CORRECTION', commission: '8', changeReason: reason })).changeApprovalId;
    });

    // Step 1 / Expected 1: không có baseline "hình dạng cột cũ" để so — ghi Not automated.
    await step("Act: Step 1 — Confirm the queue table's columns are unchanged (Not automated — no baseline)", async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Step 1: no recorded baseline of the pre-existing queue shape' });
    });

    await step('Assert: Expected 1 — Columns match the pre-existing shape (Not automated)', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Expected 1: see Step 1' });
    });

    await step('Act: Step 2 — Check where Approve / Reject and Withdraw are offered', async () => {
      await queue.openRequest({ register: FEE_TEXT.queue.register, requester: getAccountDisplayName('approver'), changeApprovalId: changeApprovalId!, reason });
    });

    await step('Assert: Expected 2 — Approve/Reject only on 변경 승인; Withdraw only on the Fee Information tab', async () => {
      await expect(queue.rejectButton, '[Expected 2] 반려… exists on 변경 승인').toBeVisible();
      await expect(queue.approveButton, '[Expected 2] 승인 exists on 변경 승인').toBeVisible();
      await expect(page.getByRole('button', { name: /^[^가-힣A-Za-z]*회수$/ }), '[Expected 2] No 회수 (Withdraw) on 변경 승인').toHaveCount(0);
      await fee.openEdit(contract.id);
      await expect(fee.rowButton(fee.row(KEY.MD), FEE_TEXT.btnWithdraw), '[Expected 2] 회수 exists on the Fee Information tab').toBeVisible();
      await expect(fee.feePanel.getByRole('button', { name: /^[^가-힣A-Za-z]*(승인|반려…?)$/ }), '[Expected 2] No 승인 / 반려 on the Fee Information tab').toHaveCount(0);
    });

    await step('Act: Step 3 — Check the hand-back fields on a rejected item and that only one decision can be made per record', async () => {
      await queue.open();
      await queue.showRegister(FEE_TEXT.queue.register);
      test.info().annotations.push({ type: 'Not automated', description: 'Step 3: hand-back fields of a rejected fee item — a rejection needs a second approver' });
    });

    await step('Assert: Expected 3 — Only one decision per record — no batch select', async () => {
      await expect(page.getByRole('checkbox'), '[Expected 3] No batch-selection checkbox in the queue').toHaveCount(0);
    });
  });
});
