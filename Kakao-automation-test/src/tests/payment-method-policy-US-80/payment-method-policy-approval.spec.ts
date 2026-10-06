import { test, expect } from '@fixtures/base.fixture';
import { allure } from 'allure-playwright';
import { makeStep } from '@utils/step';
import { switchAccount } from '@utils/switch-account';
import { getAccountDisplayName } from '@utils/auth-token';
import { PaymentMethodPolicy } from '@api/payment-method-policy.api';
import {
  LIVE_ROW,
  PolicyValues,
  formatChannelKey,
  liveRow,
  restoreLiveRow,
  submitStrategyChange,
  traceReason,
  valuesOf,
} from '@utils/payment-method-policy.data';

/**
 * Luồng duyệt/từ chối trên màn 변경 승인 (US120) cho register 결제수단 정책 (US080). Nguồn TC:
 * input/Test_Cases_US080_EN_v1.md — mỗi dòng Steps N / Expected N map đúng 1 step `Act: Step N` / `Assert: Expected N`.
 * TC lệch UI thật → assert theo UI, ghi "Deviation from TC" trong description (quyết định 28/09).
 *
 * Account: submitter = storageState của setup-auth; approver (role APPROVER, khác danh tính) qua `switchAccount(page,
 * 'approver')` trên CÙNG tab và `approverPolicyApi` — chưa cấu hình APPROVER_* trong .env → test tự skip.
 * Dữ liệu: chạy trên LIVE_ROW (TC gốc dùng NICEPAY · CREDIT_CARD · KRW — seed thật, không được đụng vào). Duyệt 1 thay đổi
 * 환율 적용 방식 tạo bản ghi MỚI (id mới), bản cũ SUPERSEDED → `finally` trả về baseline bằng gửi đổi ngược + duyệt.
 * Queue luôn được chọn theo changeApprovalId + lý do (openRequest) — không bao giờ thao tác trên request người khác.
 */
const REGISTER = '결제수단 정책';
const LIVE_KEY = formatChannelKey(LIVE_ROW);
const DEVIATION_LIVE_ROW = `Deviation from TC: runs on the automation-owned row ${LIVE_KEY} instead of NICEPAY · CREDIT_CARD · KRW (real seed data on the shared env).`;
const DEVIATION_APPROVE_CONFIRM = '승인 opens a "승인 확인" confirmation dialog that is confirmed with its own 승인 button';
const strategyLabel = (value: string) => (value === 'ALREADY_KRW' ? '이미 KRW' : '정산환율');
const strategyFullLabel = (value: string) => (value === 'ALREADY_KRW' ? '이미 KRW — 환율 미적용' : '정산환율');
const asRow = (key: typeof LIVE_ROW) => [key.pgCode, key.paymentMethodCode, key.currency] as const;

test.describe('[Approval] 변경 승인 queue — approve, reject and self-approval', () => {
  test('TC_US080_003 — The submitter cannot approve their own change', async ({ page, changeApprovalQueuePage: queue, policyApi, approverPolicyApi }) => {
    const step = makeStep(page);
    let baseline: PolicyValues | undefined;
    let pending: PaymentMethodPolicy | undefined;
    const reason = traceReason('TC_US080_003');
    const approver = getAccountDisplayName('approver');
    await allure.description(
      'The approver account (holds APPROVER) submits a 환율 적용 방식 change itself, then opens it on 변경 승인: the request ' +
        'shows that account as submitter, 승인 is disabled with the inline message "본인이 제출한 변경은 승인할 수 없습니다." ' +
        '(no rule code) and the row value is unchanged. ' +
        `${DEVIATION_LIVE_ROW} Deviation from TC: the message is Korean on the UI (TC quotes the English "You cannot ` +
        'approve a change you submitted yourself."); 반려… is disabled as well.',
    );
    await allure.severity('blocker');
    await allure.tags('regression', 'ui', 'approval', 'sod', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_003');

    try {
      await step('Arrange: Pre-condition 1–3 — The approver account submits a 환율 적용 방식 change itself; queue usable', async () => {
        baseline = valuesOf(await liveRow(policyApi));
        pending = await submitStrategyChange(approverPolicyApi, reason);
        await switchAccount(page, 'approver');
      });

      await step('Act: Step 1 — Open 변경 승인 (Change Approval) and select the request just submitted', async () => {
        await queue.openRequest({ register: REGISTER, requester: approver, changeApprovalId: pending!.pending!.changeApprovalId, reason });
      });

      await step('Assert: Expected 1 — The request shows the currently logged-in account as submitter', async () => {
        await expect(queue.panelValue('기안자'), `[Expected 1] Submitter is the logged-in account ${approver}`).toHaveText(approver);
        await expect(page.getByRole('heading', { name: approver, exact: true }), `[Expected 1] The logged-in account is ${approver}`).toBeVisible();
      });

      await step('Act: Step 2 — Click 승인 (Approve)', async () => {
        await queue.approveButton.click({ force: true });
      });

      await step('Assert: Expected 2 — 승인 is disabled with the self-approval message (no rule code); the row is unchanged', async () => {
        await expect(queue.approveButton, '[Expected 2] 승인 (Approve) is disabled').toBeDisabled();
        await expect(queue.selfApprovalMessage, '[Expected 2] Inline message "본인이 제출한 변경은 승인할 수 없습니다." is shown').toBeVisible();
        await expect(queue.selfApprovalMessage, '[Expected 2] The message carries no rule code').not.toContainText(/SoD|BR-|\d-\d/);
        await expect(queue.approveDialog, '[Expected 2] No approval confirmation opens').toHaveCount(0);
        expect((await policyApi.getByKey(LIVE_ROW)).body.holder?.fxSourceStrategy, '[Expected 2] 환율 적용 방식 on the row is unchanged').toBe(
          baseline!.fxSourceStrategy,
        );
      });
    } finally {
      if (pending) await approverPolicyApi.withdraw((await policyApi.getRowByKey(LIVE_ROW)).id).catch(() => undefined);
      if (baseline) await restoreLiveRow(policyApi, baseline, approverPolicyApi);
    }
  });

  test('TC_US080_009 — The Change Approval queue renders this register\'s request', async ({ page, changeApprovalQueuePage: queue, policyApi, approverPolicyApi }) => {
    const step = makeStep(page);
    let baseline: PolicyValues | undefined;
    let pending: PaymentMethodPolicy | undefined;
    const reason = traceReason('TC_US080_009');
    const submitter = getAccountDisplayName('submitter');
    await allure.description(
      'As the approver, open 변경 승인 and select the request submitted by the 결제수단 정책 register: the queue lists it with the ' +
        'register name and the right-hand panel shows its blocks. Deviation from TC: the UI has no screen-owner banner ' +
        '"US120의 화면입니다"; the register name is a badge on each queue entry (no table column); the panel shows four ' +
        'blocks 변경 요약 · 사유 (기안자) · 변경 내용 · 영향 미리보기 (TC: three blocks 변경 요약 · 사유 (작성자) · 영향 범위). ' +
        `${DEVIATION_LIVE_ROW} The request is withdrawn afterwards.`,
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'approval', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_009');

    try {
      await step('Arrange: Pre-condition 1–3 — A pending 환율 적용 방식 change exists; logged in as the approver', async () => {
        baseline = valuesOf(await liveRow(policyApi));
        pending = await submitStrategyChange(policyApi, reason);
        await switchAccount(page, 'approver');
      });

      await step('Act: Step 1 — Open 변경 승인 (Change Approval)', async () => {
        await queue.open();
        await queue.showRegister(REGISTER);
      });

      await step('Assert: Expected 1 — The queue lists the request submitted by the 결제수단 정책 register', async () => {
        await expect(queue.queueItems.filter({ hasText: submitter }).first(), `[Expected 1] A ${REGISTER} request by ${submitter} is listed`).toBeVisible();
      });

      await step('Act: Step 2 — Select the request submitted by the payment method policy register', async () => {
        await queue.openRequest({ register: REGISTER, requester: submitter, changeApprovalId: pending!.pending!.changeApprovalId, reason });
      });

      await step('Assert: Expected 2 — The entry names the register; the panel shows its blocks', async () => {
        await expect(queue.queueItems.filter({ hasText: submitter }).last(), `[Expected 2] The entry names the register ${REGISTER}`).toContainText(REGISTER);
        await expect(queue.panelValue('원장'), `[Expected 2] Panel 원장 (Register) is ${REGISTER}`).toHaveText(REGISTER);
        await expect(queue.changeSummaryHeading, '[Expected 2] Block 변경 요약 (Change summary) is shown').toBeVisible();
        await expect(queue.reasonHeading, '[Expected 2] Block 사유 (기안자) (Reason (maker)) is shown').toBeVisible();
        await expect(queue.changeContentHeading, '[Expected 2] Block 변경 내용 (Change) is shown').toBeVisible();
        await expect(queue.impactPreviewHeading, '[Expected 2] Block 영향 미리보기 (Impact preview) is shown').toBeVisible();
        await expect(queue.reasonBlock, '[Expected 2] The reason block shows the submitted reason').toHaveText(reason);
      });
    } finally {
      if (baseline) await restoreLiveRow(policyApi, baseline, approverPolicyApi);
    }
  });

  test('TC_US080_040 — Approving makes the new value live and supersedes the previous row', async ({
    page,
    changeApprovalQueuePage: queue,
    paymentMethodPolicyListPage: list,
    policyApi,
    approverPolicyApi,
  }) => {
    const step = makeStep(page);
    let baseline: PolicyValues | undefined;
    let pending: PaymentMethodPolicy | undefined;
    let previous: PaymentMethodPolicy | undefined;
    const reason = traceReason('TC_US080_040');
    await allure.description(
      'As the approver, approve a pending 환율 적용 방식 change: the request leaves the queue, the list shows the new value ' +
        'without the 승인 대기 pill, and the previous record remains readable in state SUPERSEDED (not deleted). ' +
        `${DEVIATION_LIVE_ROW} Deviation from TC: ${DEVIATION_APPROVE_CONFIRM}. The row is restored afterwards (reverse ` +
        'change + approval).',
    );
    await allure.severity('blocker');
    await allure.tags('regression', 'ui', 'approval', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_040');

    try {
      await step('Arrange: Pre-condition 1–3 — A pending 환율 적용 방식 change awaits approval; logged in as the approver', async () => {
        baseline = valuesOf(await liveRow(policyApi));
        pending = await submitStrategyChange(policyApi, reason);
        await switchAccount(page, 'approver');
      });

      await step('Act: Step 1 — Open 변경 승인, select that request and click 승인 (Approve)', async () => {
        await queue.openRequest({ register: REGISTER, requester: getAccountDisplayName('submitter'), changeApprovalId: pending!.pending!.changeApprovalId, reason });
        await queue.approve();
      });

      await step('Assert: Expected 1 — The request is approved and leaves the queue', async () => {
        await expect(queue.approvedToast, '[Expected 1] Toast 승인되었습니다 confirms the approval').toBeVisible();
        expect((await approverPolicyApi.getChangeApproval(pending!.pending!.changeApprovalId)).body.approvalStatus, '[Expected 1] The request is no longer pending').not.toBe(
          'PENDING',
        );
      });

      await step('Act: Step 2 — Return to the policy list screen and read that row', async () => {
        await switchAccount(page, 'submitter');
        await list.open();
        await list.searchKey(...asRow(LIVE_ROW));
      });

      await step('Assert: Expected 2 — 환율 적용 방식 reads the new value; the 승인 대기 pill is gone', async () => {
        const row = list.rowByKey(...asRow(LIVE_ROW));
        const newLabel = strategyLabel(pending!.pending!.requestedValue);
        await expect(row.locator('td:nth-child(4)'), `[Expected 2] 환율 적용 방식 reads ${newLabel}`).toContainText(newLabel);
        await expect(list.statusPill(row, '승인 대기'), '[Expected 2] The 승인 대기 pill is gone').toHaveCount(0);
      });

      await step('Act: Step 3 — Read the previous row\'s record in the register', async () => {
        previous = (await policyApi.get(pending!.id)).body;
      });

      await step('Assert: Expected 3 — The previous record remains, in state SUPERSEDED, not deleted', async () => {
        expect(previous?.id, '[Expected 3] The previous record still exists').toBe(pending!.id);
        expect(previous?.approval, '[Expected 3] The previous record is SUPERSEDED').toBe('SUPERSEDED');
        expect((await policyApi.getRowByKey(LIVE_ROW)).id, '[Expected 3] The live record is a new one').not.toBe(pending!.id);
      });
    } finally {
      if (baseline) await restoreLiveRow(policyApi, baseline, approverPolicyApi);
    }
  });

  test('TC_US080_044 — An approved change is visible on the list and in history end to end', async ({
    page,
    changeApprovalQueuePage: queue,
    paymentMethodPolicyListPage: list,
    paymentMethodPolicyFormPage: form,
    policyApi,
    approverPolicyApi,
  }) => {
    // Luồng end-to-end 2 account (gửi → đổi phiên → duyệt → kiểm list + lịch sử + khôi phục) vượt 30 s mặc định (lần chạy 28/09).
    test.setTimeout(120_000);
    const step = makeStep(page);
    let baseline: PolicyValues | undefined;
    let changeApprovalId = 0;
    const reason = `Aligned with the Eximbay file (${traceReason('TC_US080_044')})`;
    await allure.description(
      'The submitter changes 환율 적용 방식 with a reason and submits; the approver approves it on 변경 승인; the list then ' +
        'shows the new value and 변경 이력 holds a new record for 환율 적용 방식 with the old → new values and the reason. ' +
        `${DEVIATION_LIVE_ROW} Deviations from TC: the reason gets a traceable suffix; the history columns are titled 항목 / ` +
        `사유 (TC: 정책 설정 / 이유) and the old value reads "이미 KRW — 환율 미적용"; ${DEVIATION_APPROVE_CONFIRM}. The row is ` +
        'restored afterwards.',
    );
    await allure.severity('critical');
    await allure.tags('regression', 'ui', 'approval', 'history', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_044');

    try {
      await step(`Arrange: Pre-condition 1–3 — Logged in as the submitter; ${LIVE_KEY} has no pending request; approver available`, async () => {
        const row = await liveRow(policyApi);
        baseline = valuesOf(row);
        await form.open(row.id);
      });

      await step('Act: Step 1 — Change 환율 적용 방식, enter 변경 사유 and submit for approval', async () => {
        await form.strategySelect.selectOption(baseline!.fxSourceStrategy === 'ALREADY_KRW' ? 'BANK_SETTLEMENT_RATE' : 'ALREADY_KRW');
        await form.save();
        await form.submitForApproval(reason);
      });

      await step('Assert: Expected 1 — The request enters the queue and the row carries the 승인 대기 pill', async () => {
        const holder = (await policyApi.getByKey(LIVE_ROW)).body.holder;
        expect(holder?.pending, '[Expected 1] The request is in the approval queue').toBeDefined();
        changeApprovalId = holder!.pending!.changeApprovalId;
        await list.open();
        await list.searchKey(...asRow(LIVE_ROW));
        await expect(list.statusPill(list.rowByKey(...asRow(LIVE_ROW)), '승인 대기'), '[Expected 1] The row carries the 승인 대기 pill').toBeVisible();
      });

      await step('Act: Step 2 — Log in as the approver, open 변경 승인 and click 승인 (Approve)', async () => {
        await switchAccount(page, 'approver');
        await queue.openRequest({ register: REGISTER, requester: getAccountDisplayName('submitter'), changeApprovalId, reason });
        await queue.approve();
      });

      await step('Assert: Expected 2 — The request leaves the queue', async () => {
        await expect(queue.approvedToast, '[Expected 2] Toast 승인되었습니다 confirms the approval').toBeVisible();
        expect((await approverPolicyApi.getChangeApproval(changeApprovalId)).body.approvalStatus, '[Expected 2] The request is no longer pending').not.toBe('PENDING');
      });

      await step('Act: Step 3 — Return to the policy list, read that row, then open 변경 이력 (Change history)', async () => {
        await switchAccount(page, 'submitter');
        await list.open();
        await list.searchKey(...asRow(LIVE_ROW));
        await list.historyLinkInRow(list.rowByKey(...asRow(LIVE_ROW))).click();
        await form.waitForHistoryLoaded();
      });

      await step('Assert: Expected 3 — The list shows the new value; history holds the new record with values and reason', async () => {
        const newValue = baseline!.fxSourceStrategy === 'ALREADY_KRW' ? 'BANK_SETTLEMENT_RATE' : 'ALREADY_KRW';
        await expect(list.rowByKey(...asRow(LIVE_ROW)).locator('td:nth-child(4)'), `[Expected 3] The list reads ${strategyLabel(newValue)}`).toContainText(
          strategyLabel(newValue),
        );
        const newest = (await form.getHistoryRecords())[0];
        expect(newest.items, '[Expected 3] The new record is for 환율 적용 방식').toEqual(['환율 적용 방식']);
        expect(newest.changes, '[Expected 3] 변경 내용 reads old → new').toEqual([
          `${strategyFullLabel(baseline!.fxSourceStrategy)} → ${strategyFullLabel(newValue)}`,
        ]);
        expect(newest.reason, '[Expected 3] 사유 (Reason) is the submitted reason').toBe(reason);
      });
    } finally {
      if (baseline) await restoreLiveRow(policyApi, baseline, approverPolicyApi);
    }
  });

  test('TC_US080_054 — The history record carries the submitter and the change time', async ({
    page,
    changeApprovalQueuePage: queue,
    paymentMethodPolicyFormPage: form,
    policyApi,
    approverPolicyApi,
  }) => {
    const step = makeStep(page);
    let baseline: PolicyValues | undefined;
    let pending: PaymentMethodPolicy | undefined;
    let approvedAt = '';
    const reason = traceReason('TC_US080_054');
    const submitter = getAccountDisplayName('submitter');
    const minute = (date: Date) => {
      const kst = new Date(date.getTime() + 9 * 3_600_000);
      return kst.toISOString().slice(0, 16).replace('T', ' ');
    };
    await allure.description(
      'Submit a 환율 적용 방식 change as the submitter, approve it as the approver, then read the newest 변경 이력 record. ' +
        'Deviation from TC: the UI record has one 변경자 (the submitter) and one 일시 — it does not show the approver ' +
        'identity or a second (approval) timestamp, so the test asserts the submitter and that the time matches the ' +
        `submission or approval minute (KST). ${DEVIATION_LIVE_ROW} The row is restored afterwards.`,
    );
    await allure.severity('critical');
    await allure.tags('regression', 'ui', 'approval', 'history', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_054');

    try {
      await step('Arrange: Pre-condition 1–3 — Submitter logged in, approver available, row without pending request', async () => {
        baseline = valuesOf(await liveRow(policyApi));
      });

      await step('Act: Step 1 — Submit a 환율 적용 방식 change from the submitter account and note the submission time', async () => {
        pending = await submitStrategyChange(policyApi, reason);
      });

      await step('Assert: Expected 1 — The request enters the queue', async () => {
        expect((await policyApi.getChangeApproval(pending!.pending!.changeApprovalId)).body.approvalStatus, '[Expected 1] The request is pending').toBe('PENDING');
      });

      await step('Act: Step 2 — Approve that request from the approver account and note the approval time', async () => {
        await switchAccount(page, 'approver');
        await queue.openRequest({ register: REGISTER, requester: submitter, changeApprovalId: pending!.pending!.changeApprovalId, reason });
        await queue.approve();
        approvedAt = minute(new Date());
      });

      await step('Assert: Expected 2 — The request is approved', async () => {
        await expect(queue.approvedToast, '[Expected 2] Toast 승인되었습니다 confirms the approval').toBeVisible();
      });

      await step('Act: Step 3 — Open 변경 이력 (Change history) for that row and read the newest record', async () => {
        await switchAccount(page, 'submitter');
        await form.open((await liveRow(policyApi)).id);
        await form.openHistory();
      });

      await step('Assert: Expected 3 — The newest record names the submitter and the submission/approval time', async () => {
        const newest = (await form.getHistoryRecords())[0];
        expect(newest.items, '[Expected 3] The newest record is the approved 환율 적용 방식 change').toEqual(['환율 적용 방식']);
        expect(newest.who, `[Expected 3] 변경자 is the submitter ${submitter}`).toBe(submitter);
        const submittedAt = minute(new Date(pending!.pending!.submittedAt));
        expect([submittedAt, approvedAt], `[Expected 3] 일시 ${newest.when} matches the submission or approval minute`).toContain(newest.when);
      });
    } finally {
      if (baseline) await restoreLiveRow(policyApi, baseline, approverPolicyApi);
    }
  });

  test('TC_US080_055 — A rejection shows who, when, the requested value and the reason, with no history row', async ({
    page,
    paymentMethodPolicyListPage: list,
    paymentMethodPolicyFormPage: form,
    policyApi,
    approverPolicyApi,
  }) => {
    const step = makeStep(page);
    let baseline: PolicyValues | undefined;
    let historyBefore = 0;
    const rejectReason = traceReason('TC_US080_055_reject');
    const approver = getAccountDisplayName('approver');
    await allure.description(
      'After a 환율 적용 방식 change was rejected with a reason, open the row: the banner shows who rejected it, when, the ' +
        'requested value and the reject reason exactly; the history gains no record and the list row carries ⏱ 반려됨. ' +
        'Deviation from TC: the banner title reads "최근 변경 요청이 반려되었습니다" (TC: "반려됨 — 기존 값이 그대로 유지되며 새 ' +
        `버전은 생성되지 않았습니다"); the rejection itself is staged via the API. ${DEVIATION_LIVE_ROW}`,
    );
    await allure.severity('critical');
    await allure.tags('regression', 'ui', 'approval', 'reject', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_055');

    try {
      await step('Arrange: Pre-condition 1–3 — A 환율 적용 방식 change was just rejected on 변경 승인 with a reason', async () => {
        const row = await liveRow(policyApi);
        baseline = valuesOf(row);
        historyBefore = ((await policyApi.getHistory(row.id)).body as { totalElements: number }).totalElements;
        const pending = await submitStrategyChange(policyApi, traceReason('TC_US080_055'));
        const rejected = await approverPolicyApi.rejectChange(pending.pending!.changeApprovalId, rejectReason);
        expect(rejected.status, '[Pre-condition 2] The approver rejects the change').toBeLessThan(300);
        await list.open();
        await list.searchKey(...asRow(LIVE_ROW));
      });

      await step('Act: Step 1 — Open that row on the policy list screen and read the banner', async () => {
        await list.openRow(...asRow(LIVE_ROW));
      });

      await step('Assert: Expected 1 — The banner shows who rejected it, when, the requested value and the reason', async () => {
        await expect(form.rejectedBannerTitle, '[Expected 1] Rejection banner is shown').toBeVisible();
        await expect(form.rejectedBannerDetail, `[Expected 1] The banner names the rejecter ${approver}`).toContainText(approver);
        await expect(form.rejectedBannerDetail, '[Expected 1] The banner states when').toContainText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
        // Nhãn giá trị có thể mang phần giải thích sau tiền tố (VD "이미 KRW — 환율 미적용", verify 29/09) → khớp theo tiền tố.
        await expect(form.rejectedBannerDetail, '[Expected 1] The banner states the requested value').toContainText(
          new RegExp(`${strategyLabel(baseline!.fxSourceStrategy === 'ALREADY_KRW' ? 'BANK_SETTLEMENT_RATE' : 'ALREADY_KRW')}[^()]*\\(으\\)로 변경 요청`),
        );
        await expect(form.rejectedBannerDetail, '[Expected 1] The banner quotes the reject reason exactly').toContainText(`사유: ${rejectReason}`);
      });

      await step('Act: Step 2 — Click 변경 이력 (Change history) and count the records', async () => {
        await form.openHistory();
      });

      await step('Assert: Expected 2 — No history record was added; the list row carries ⏱ 반려됨', async () => {
        await expect(form.historyRows, '[Expected 2] The record count did not increase').toHaveCount(historyBefore);
        await form.closeHistory();
        await form.backToList();
        await list.searchKey(...asRow(LIVE_ROW));
        await expect(list.statusPill(list.rowByKey(...asRow(LIVE_ROW)), '⏱ 반려됨'), '[Expected 2] The list row carries ⏱ 반려됨').toBeVisible();
      });
    } finally {
      if (baseline) await restoreLiveRow(policyApi, baseline, approverPolicyApi);
    }
  });

  test('TC_US080_066 — The submitter\'s reason text reaches the Reason column verbatim', async ({
    page,
    changeApprovalQueuePage: queue,
    paymentMethodPolicyFormPage: form,
    policyApi,
    approverPolicyApi,
  }) => {
    const step = makeStep(page);
    let baseline: PolicyValues | undefined;
    let changeApprovalId = 0;
    const reason = `Đồng bộ theo tệp Eximbay — kỳ 07/2026 (100%) ${traceReason('TC_US080_066')}`;
    await allure.description(
      'Submit a 환율 적용 방식 change with an accented Latin reason ("Đồng bộ theo tệp Eximbay — kỳ 07/2026 (100%)"), approve ' +
        'it, and read the newest 변경 이력 record: the reason column shows the string verbatim — every diacritic, the em dash ' +
        'and the brackets kept. Deviation from TC: the reason gets a traceable suffix; the column is titled 사유 (TC: 이유). ' +
        `${DEVIATION_LIVE_ROW} The row is restored afterwards.`,
    );
    await allure.severity('critical');
    await allure.tags('regression', 'ui', 'approval', 'history', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_066');

    try {
      await step('Arrange: Pre-condition 1–3 — Submitter logged in, approver available, row without pending request', async () => {
        const row = await liveRow(policyApi);
        baseline = valuesOf(row);
        await form.open(row.id);
      });

      await step('Act: Step 1 — Change 환율 적용 방식, enter the accented Latin 변경 사유 and submit', async () => {
        await form.strategySelect.selectOption(baseline!.fxSourceStrategy === 'ALREADY_KRW' ? 'BANK_SETTLEMENT_RATE' : 'ALREADY_KRW');
        await form.save();
        await form.submitForApproval(reason);
      });

      await step('Assert: Expected 1 — The request enters the queue', async () => {
        const holder = (await policyApi.getByKey(LIVE_ROW)).body.holder;
        expect(holder?.pending, '[Expected 1] The request is in the approval queue').toBeDefined();
        changeApprovalId = holder!.pending!.changeApprovalId;
      });

      await step('Act: Step 2 — Approve that request from the approver account', async () => {
        await switchAccount(page, 'approver');
        await queue.openRequest({ register: REGISTER, requester: getAccountDisplayName('submitter'), changeApprovalId, reason });
        await queue.approve();
      });

      await step('Assert: Expected 2 — The request is approved', async () => {
        await expect(queue.approvedToast, '[Expected 2] Toast 승인되었습니다 confirms the approval').toBeVisible();
      });

      await step('Act: Step 3 — Open 변경 이력 (Change history) and read the 사유 (Reason) of the newest record', async () => {
        await switchAccount(page, 'submitter');
        await form.open((await liveRow(policyApi)).id);
        await form.openHistory();
      });

      await step('Assert: Expected 3 — The reason is shown verbatim, diacritics, em dash and brackets kept', async () => {
        const newest = (await form.getHistoryRecords())[0];
        expect(newest.reason, '[Expected 3] 사유 shows the reason verbatim').toBe(reason);
      });
    } finally {
      if (baseline) await restoreLiveRow(policyApi, baseline, approverPolicyApi);
    }
  });

  test('TC_US080_067 — The row becomes editable again after a rejection', async ({ page, paymentMethodPolicyListPage: list, paymentMethodPolicyFormPage: form, policyApi, approverPolicyApi }) => {
    const step = makeStep(page);
    let baseline: PolicyValues | undefined;
    await allure.description(
      'After a request was rejected, open the row: no 승인 대기 lock banner and every field editable; changing a field enables ' +
        '저장 and the change can be submitted as normal (the confirm dialog opens; it is closed with 뒤로 — nothing saved). ' +
        `The rejection is staged via the API. ${DEVIATION_LIVE_ROW}`,
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'approval', 'reject', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_067');

    try {
      await step('Arrange: Pre-condition 1–3 — A request on the row was just rejected on 변경 승인', async () => {
        baseline = valuesOf(await liveRow(policyApi));
        const pending = await submitStrategyChange(policyApi, traceReason('TC_US080_067'));
        await approverPolicyApi.rejectChange(pending.pending!.changeApprovalId, traceReason('TC_US080_067_reject'));
        await list.open();
        await list.searchKey(...asRow(LIVE_ROW));
      });

      await step('Act: Step 1 — Open that row on the policy list screen', async () => {
        await list.openRow(...asRow(LIVE_ROW));
      });

      await step('Assert: Expected 1 — No 승인 대기 banner; every field is editable', async () => {
        await expect(form.pendingLockTitle, '[Expected 1] No 승인 대기 lock banner').toHaveCount(0);
        await expect(form.strategySelect, '[Expected 1] 환율 적용 방식 is editable').toBeEnabled();
        await expect(form.cycleTypeSelect, '[Expected 1] 정산 주기 is editable').toBeEnabled();
        await expect(form.lagInput, '[Expected 1] 지연일수 is editable').toBeEditable();
      });

      await step('Act: Step 2 — Change 지연일수 and read the 저장 (Save) button', async () => {
        await form.fillPolicySettings({ lag: String((baseline!.cycleLagDays + 1) % 1000) });
      });

      await step('Assert: Expected 2 — 저장 is enabled and the change can be submitted as normal', async () => {
        await expect(form.saveButton, '[Expected 2] 저장 (Save) is enabled').toBeEnabled();
        await form.save();
        await expect(form.confirmDialogTitle, '[Expected 2] The change can be submitted — the confirm dialog opens').toHaveText('이 변경을 적용할까요?');
        await form.backFromDialog();
      });
    } finally {
      if (baseline) await restoreLiveRow(policyApi, baseline, approverPolicyApi);
    }
  });

  test('TC_US080_068 — The reject reason is required on the queue', async ({ page, changeApprovalQueuePage: queue, policyApi, approverPolicyApi }) => {
    const step = makeStep(page);
    let baseline: PolicyValues | undefined;
    let pending: PaymentMethodPolicy | undefined;
    const reason = traceReason('TC_US080_068');
    await allure.description(
      'As the approver, select a pending 결제수단 정책 request and open 반려…: the reject-reason field is shown; confirming with ' +
        'it empty does not go through (the field is marked required, the request stays pending); with a reason the request ' +
        'is rejected and leaves the queue. Deviation from TC: the reason field lives in the "반려 확정" dialog opened by 반려… ' +
        '(not in the detail panel), its placeholder reads "예: 08-16에 이미 승인된 환율과 중복" (TC: "반려 사유를 입력하세요") and ' +
        `the confirm button is 반려 확정. ${DEVIATION_LIVE_ROW}`,
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'approval', 'reject', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_068');

    try {
      await step('Arrange: Pre-condition 1–3 — A 결제수단 정책 change awaits approval; logged in as the approver', async () => {
        baseline = valuesOf(await liveRow(policyApi));
        pending = await submitStrategyChange(policyApi, reason);
        await switchAccount(page, 'approver');
      });

      await step('Act: Step 1 — Open 변경 승인, select that request and open 반려… (Reject)', async () => {
        await queue.openRequest({ register: REGISTER, requester: getAccountDisplayName('submitter'), changeApprovalId: pending!.pending!.changeApprovalId, reason });
        await queue.openRejectDialog();
      });

      await step('Assert: Expected 1 — The 반려 사유 (Reject reason) field is shown with its placeholder', async () => {
        await expect(queue.rejectReasonInput, '[Expected 1] 반려 사유 field is shown').toBeVisible();
        await expect(queue.rejectReasonInput, '[Expected 1] Placeholder "예: 08-16에 이미 승인된 환율과 중복"').toHaveAttribute('placeholder', '예: 08-16에 이미 승인된 환율과 중복');
      });

      await step('Act: Step 2 — Leave 반려 사유 empty and click 반려 확정', async () => {
        await queue.confirmReject();
      });

      await step('Assert: Expected 2 — The rejection does not go through; the field is marked required; the request stays', async () => {
        await expect(queue.rejectDialog, '[Expected 2] The dialog stays open').toBeVisible();
        await expect(queue.rejectReasonInput, '[Expected 2] The field is marked invalid').toHaveClass(/is-invalid/);
        await expect(queue.rejectReasonError, '[Expected 2] Message "이 변경을 반려하려면 사유를 입력하세요."').toHaveText('이 변경을 반려하려면 사유를 입력하세요.');
        expect((await approverPolicyApi.getChangeApproval(pending!.pending!.changeApprovalId)).body.approvalStatus, '[Expected 2] The request stays pending').toBe('PENDING');
      });

      await step('Act: Step 3 — Enter a reason and click 반려 확정 again', async () => {
        await queue.confirmReject(traceReason('TC_US080_068_reject'));
      });

      await step('Assert: Expected 3 — The request is rejected and leaves the queue', async () => {
        await expect(queue.rejectedToast, '[Expected 3] Toast 반려되었습니다 confirms the rejection').toBeVisible();
        expect((await approverPolicyApi.getChangeApproval(pending!.pending!.changeApprovalId)).body.approvalStatus, '[Expected 3] The request is rejected').toBe('REJECTED');
      });
    } finally {
      if (baseline) await restoreLiveRow(policyApi, baseline, approverPolicyApi);
    }
  });

  test('TC_US080_069 — Rejecting leaves the active row untouched and creates no version', async ({
    page,
    changeApprovalQueuePage: queue,
    policyApi,
    approverPolicyApi,
  }) => {
    const step = makeStep(page);
    let baseline: PolicyValues | undefined;
    let pending: PaymentMethodPolicy | undefined;
    let before = { id: 0, values: {} as PolicyValues, history: 0, rowsForKey: 0 };
    let after = { id: 0, values: {} as PolicyValues, history: 0, rowsForKey: 0 };
    const reason = traceReason('TC_US080_069');
    const snapshot = async () => {
      const row = await policyApi.getRowByKey(LIVE_ROW);
      return {
        id: row.id,
        values: valuesOf(row),
        history: ((await policyApi.getHistory(row.id)).body as { totalElements: number }).totalElements,
        rowsForKey: (await policyApi.list(LIVE_ROW)).body.totalElements,
      };
    };
    await allure.description(
      'Record the live row and its version count, reject its pending 환율 적용 방식 change on 변경 승인, and read the row again: ' +
        'every value is untouched, no new version (record) and no orphan version exist. Deviation from TC: the row\'s ' +
        '`version` field is an optimistic-lock counter that also moves on submit/withdraw/reject, so "version count" is ' +
        `measured as the live record id, the history record count and the register rows for the key. ${DEVIATION_LIVE_ROW}`,
    );
    await allure.severity('critical');
    await allure.tags('regression', 'ui', 'approval', 'reject', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_069');

    try {
      await step('Arrange: Pre-condition 1–3 — The live row has a pending 환율 적용 방식 change; logged in as the approver', async () => {
        baseline = valuesOf(await liveRow(policyApi));
        pending = await submitStrategyChange(policyApi, reason);
        await switchAccount(page, 'approver');
      });

      await step('Act: Step 1 — Record every current value and the version count of that row', async () => {
        before = await snapshot();
      });

      await step('Assert: Expected 1 — The current values and the version count are recorded as the baseline', async () => {
        expect(before.id, '[Expected 1] The live record is recorded').toBeGreaterThan(0);
        expect(before.values.fxSourceStrategy, '[Expected 1] 환율 적용 방식 is recorded').toBe(baseline!.fxSourceStrategy);
        expect(before.rowsForKey, '[Expected 1] Exactly one register row for the key').toBe(1);
      });

      await step('Act: Step 2 — On 변경 승인, enter a reason and click 반려 (Reject)', async () => {
        await queue.openRequest({ register: REGISTER, requester: getAccountDisplayName('submitter'), changeApprovalId: pending!.pending!.changeApprovalId, reason });
        await queue.openRejectDialog();
        await queue.confirmReject(traceReason('TC_US080_069_reject'));
      });

      await step('Assert: Expected 2 — The request is rejected and leaves the queue', async () => {
        await expect(queue.rejectedToast, '[Expected 2] Toast 반려되었습니다 confirms the rejection').toBeVisible();
        expect((await approverPolicyApi.getChangeApproval(pending!.pending!.changeApprovalId)).body.approvalStatus, '[Expected 2] The request is rejected').toBe('REJECTED');
      });

      await step('Act: Step 3 — Read that row again and count the versions in the register', async () => {
        after = await snapshot();
      });

      await step('Assert: Expected 3 — The live row is untouched; no new or orphan version', async () => {
        expect(after.id, '[Expected 3] The live record is the same one (no new version)').toBe(before.id);
        expect(after.values, '[Expected 3] Every policy value is untouched').toEqual(before.values);
        expect(after.history, '[Expected 3] The history gained no record').toBe(before.history);
        expect(after.rowsForKey, '[Expected 3] Still exactly one register row for the key (no orphan)').toBe(1);
      });
    } finally {
      if (baseline) await restoreLiveRow(policyApi, baseline, approverPolicyApi);
    }
  });
});
