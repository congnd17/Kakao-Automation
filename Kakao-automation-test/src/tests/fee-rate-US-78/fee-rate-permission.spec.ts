import { test, expect } from '@fixtures/fee-rate.fixture';
import { makeStep } from '@utils/step';
import { skipTc, tcMeta } from '@utils/tc-meta';
import { getAccountDisplayName } from '@utils/auth-token';
import { FEE_TEXT, KEY, keyLabel } from '@utils/fee-rate.data';

/**
 * US078 — nhóm [Permission]. Nguồn TC: input/TESTCASE_US078_v2.md — mỗi dòng Steps N / Expected N map đúng 1 step
 * `Act: Step N` / `Assert: Expected N`. TC lệch UI thật → assert theo UI, ghi "Deviation from TC" trong description.
 * Dữ liệu: contract automation `[AUTO-US078] <TC> <timestamp>` tạo qua API (không xoá được); đơn còn chờ được rút lại ở teardown.
 * Account: chỉ `dungbd.fpt` (ADMIN + APPROVER, có COMMERCE_CONTRACTS) — quyết định 28/09.
 */
const TAGS = ['ui', 'fee-rate', 'fee-rate-permission'];
const NO_ROLE_ACCOUNTS =
  'no SETTLEMENT_OPERATOR / MANAGER / INVENTORY_OPERATOR / STORE_MANAGER / BIPACEN_ADMIN / LABEL_PARTNER account exists for this suite — only dungbd.fpt (ADMIN + APPROVER) can open contracts (decision 28/09)';
const CORRECTION_REASON = 'Contract says 8%, corrected from a 10% keying error';
const DEVIATION_EDIT_MODE = 'the Change rate control (요율 수정) is only rendered in the contract edit mode (계약 수정); the view mode shows 비활성 (disabled) + 변경 이력 only (verified 28/09)';
const DATA = 'Data: an automation-owned running contract is created through the API (contracts cannot be deleted); a pending request is withdrawn in teardown.';

test.describe('[Permission] Who can see and change fee rows', () => {
  test.describe.configure({ timeout: 120_000 });

  test('TC_US078_01 — An Admin can open the Fee Information tab and send a fee rate change for approval', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_01', 'High', TAGS, `An ADMIN opens the Fee Information tab (row fields read-only, Change rate visible), opens the Change rate dialog on the MD row (key + current value) and submits a correction to 8 % — a toast confirms and the row's 승인 상태 reads 승인 대기. Deviation from TC: ${DEVIATION_EDIT_MODE}. ${DATA}`);
    let contract = { id: 0 };
    let submitStatus = 0;

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; a running contract has fee row MD · 전체 위탁 · 일반 · 비율 · 10 %', async () => {
      contract = await feeRateContracts.create('TC_US078_01', 'RUNNING');
    });

    await step('Act: Step 1 — Open the contract and click the Fee Information (수수료 정보) tab (edit mode)', async () => {
      await fee.openEdit(contract.id);
    });

    await step('Assert: Expected 1 — The tab opens; the row fields are read-only and the Change rate control is visible', async () => {
      const row = fee.row(KEY.MD);
      await expect(fee.feePanel, '[Expected 1] The Fee Information tab is open').toBeVisible();
      await expect(fee.cell(row, 'category').locator('select'), '[Expected 1] 카테고리 is read-only').toBeDisabled();
      await expect(fee.cell(row, 'fee').locator('input'), '[Expected 1] 수수료 is read-only').toBeDisabled();
      await expect(fee.changeButton(row), '[Expected 1] The 요율 수정 (Change rate) control is visible').toBeVisible();
    });

    const dialog = fee.changeDialog;
    await step('Act: Step 2 — Click Change rate (요율 수정) on the MD row', async () => {
      await fee.openChangeDialog(fee.row(KEY.MD));
    });

    await step('Assert: Expected 2 — The Change the rate dialog opens with the row key and current value', async () => {
      await expect(dialog.title, '[Expected 2] The dialog title reads 수수료 요율 수정').toHaveText(FEE_TEXT.dialog.titleRate);
      await expect(dialog.summaryValue(FEE_TEXT.dialog.rowLabel), '[Expected 2] The row key is shown').toHaveText(keyLabel(KEY.MD));
      await expect(dialog.summaryValue(FEE_TEXT.dialog.currentRate), '[Expected 2] The current value 10 % is shown').toHaveText('10 %');
    });

    await step('Act: Step 3 — Pick 정정 (Correction), enter rate 8 and the reason, click 승인 요청 (Submit for approval)', async () => {
      await dialog.fill({ kind: 'correction', rate: '8', reason: CORRECTION_REASON });
      submitStatus = (await dialog.submit()).status;
    });

    await step('Assert: Expected 3 — Submit succeeds, a toast appears and the Approval column reads 승인 대기', async () => {
      expect(submitStatus, '[Expected 3] The change request is accepted (201)').toBe(201);
      await expect(fee.toast(FEE_TEXT.submittedForApproval), '[Expected 3] The confirmation toast is shown').toBeVisible();
      await expect(fee.cell(fee.row(KEY.MD), 'approval'), '[Expected 3] 승인 상태 reads 승인 대기 (Pending approval)').toContainText(FEE_TEXT.approval.PENDING);
    });
  });

  test('TC_US078_02 — A Settlement Operator, an Approver and a Manager can read the fee rows but see no button to change them', async () => {
    await skipTc('TC_US078_02', 'High', TAGS, 'Read-only roles see every fee row and no Change rate control.', NO_ROLE_ACCOUNTS);
  });

  test('TC_US078_03 — Other roles cannot open the Fee Information tab, even by pasting the link', async () => {
    await skipTc('TC_US078_03', 'High', TAGS, 'Roles without contract access do not see the menu and get 403 on the direct link.', NO_ROLE_ACCOUNTS);
  });

  test('TC_US078_04 — Only an Approver can approve or reject a fee rate request; an Admin sees no such buttons', async () => {
    await skipTc(
      'TC_US078_04',
      'High',
      TAGS,
      'An APPROVER sees enabled 승인 / 반려 on a request submitted by someone else; an ADMIN without APPROVER sees neither.',
      'needs a pending request submitted by a DIFFERENT user and an ADMIN account without APPROVER — only dungbd.fpt (ADMIN + APPROVER) is available, and its own requests are blocked by SoD (see TC_US078_05)',
    );
  });

  test('TC_US078_05 — The person who sent a fee rate change cannot approve it themselves', async ({ page, feeRateContracts, contractFeePage: fee, changeApprovalQueuePage: queue }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_05', 'High', TAGS, `The ADMIN+APPROVER user submits a correction on the MD row (row → 승인 대기), then opens it in 변경 승인 (원장 = Fee Rate): a notice says they submitted it and both 승인 and 반려… are disabled. Deviation from TC: the register option reads "Fee Rate" (English) in the Korean UI. ${DATA}`);
    let contract = { id: 0 };
    let submitted: { changeApprovalId?: number } = {};

    await step('Arrange: Pre-condition 1–2 — Logged in as a user holding ADMIN and APPROVER; a running contract has MD · 전체 위탁 · 일반 · 10 %', async () => {
      contract = await feeRateContracts.create('TC_US078_05', 'RUNNING');
    });

    await step('Act: Step 1 — On the Fee Information tab submit a correction on the MD row: rate 8 and the reason', async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD));
      const dialog = fee.changeDialog;
      await dialog.fill({ kind: 'correction', rate: '8', reason: CORRECTION_REASON });
      submitted = (await dialog.submit()).body ?? {};
    });

    await step('Assert: Expected 1 — Submit succeeds; the row shows 승인 대기', async () => {
      expect(submitted.changeApprovalId, '[Expected 1] A change approval request is created').toBeTruthy();
      await expect(fee.cell(fee.row(KEY.MD), 'approval'), '[Expected 1] The row reads 승인 대기').toContainText(FEE_TEXT.approval.PENDING);
    });

    await step('Act: Step 2 — Go to 변경 승인, filter 원장 to Fee Rate and open the request just submitted', async () => {
      await queue.openRequest({ register: FEE_TEXT.queue.register, requester: getAccountDisplayName('approver'), changeApprovalId: submitted.changeApprovalId!, reason: CORRECTION_REASON });
    });

    await step('Assert: Expected 2 — A notice says the current user submitted it; 승인 and 반려 are both disabled', async () => {
      await expect(queue.selfApprovalMessage, '[Expected 2] The notice "본인이 제출한 변경은 승인할 수 없습니다." is shown').toBeVisible();
      await expect(queue.approveButton, '[Expected 2] 승인 (Approve) is disabled').toBeDisabled();
      await expect(queue.rejectButton, '[Expected 2] 반려… (Reject) is disabled').toBeDisabled();
    });
  });
});
