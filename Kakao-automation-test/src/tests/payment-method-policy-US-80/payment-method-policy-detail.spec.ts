import { test, expect } from '@fixtures/base.fixture';
import { allure } from 'allure-playwright';
import { makeStep } from '@utils/step';
import { Observations } from '@utils/observations';
import { getAccountDisplayName, getValidSession, toSessionCookies, UI_SESSION_BUFFER_MS } from '@utils/auth-token';
import { env } from '@utils/env.config';
import { AUTH_STORAGE_STATE } from '@setup/constants';
import { PaymentMethodPolicy } from '@api/payment-method-policy.api';
import { PaymentMethodPolicyFormPage } from '@pages/payment-method-policy-form.page';
import {
  LIVE_ROW,
  SEED_ROW,
  PolicyValues,
  createApprovedPolicy,
  formatChannelKey,
  liveRow,
  pickUnusedKey,
  restoreLiveRow,
  setCadence,
  submitStrategyChange,
  traceReason,
  valuesOf,
} from '@utils/payment-method-policy.data';

/**
 * Form sửa 결제수단 정책 (US080) — luồng duyệt phía nguồn, lịch sử, validation. Nguồn TC: input/Test_Cases_US080_EN_v1.md —
 * mỗi dòng Steps N / Expected N map đúng 1 step `Act: Step N` / `Assert: Expected N`. TC lệch UI thật → assert theo UI,
 * ghi "Deviation from TC" trong description (quyết định 28/09).
 *
 * Dữ liệu (môi trường dev DÙNG CHUNG):
 * - TC có ghi (lưu, gửi duyệt, 회수) chạy trên LIVE_ROW — TC gốc dùng SEED_ROW (dữ liệu seed thật, không được đụng vào).
 *   Arrange đưa LIVE_ROW về đúng pre-condition qua API; `finally` trả về baseline (restoreLiveRow).
 * - TC chỉ đọc / sửa trên form rồi 뒤로 (không lưu) dùng đúng SEED_ROW như TC.
 */
const SEED_KEY = formatChannelKey(SEED_ROW);
const LIVE_KEY = formatChannelKey(LIVE_ROW);
const DEVIATION_LIVE_ROW = `Deviation from TC: runs on the automation-owned row ${LIVE_KEY} instead of ${SEED_KEY} (real seed data on the shared env).`;
const DEVIATION_CONFIRM =
  'the approval dialog carries the 변경 사유 input and its button is 승인 요청 (TC: "enter a reason, 저장, then 확인 및 저장")';
const HISTORY_FIELD_NAMES = ['환율 적용 방식', '주기 유형', '기준 요일', '지연일수(일)'];
const MSG_REVIEW_HINT = '승인자가 판단 근거로 읽습니다. 최대 200자.';
const asRow = (key: typeof LIVE_ROW) => [key.pgCode, key.paymentMethodCode, key.currency] as const;

test.describe('[Detail] 결제수단 정책 edit form, source-side approval flow and history', () => {
  test('TC_US080_038 — Changing FX source does not go live on submit', async ({
    page,
    paymentMethodPolicyListPage: list,
    paymentMethodPolicyFormPage: form,
    policyApi,
  }) => {
    const step = makeStep(page);
    let baseline: PolicyValues | undefined;
    let submitStatus = 0;
    await allure.description(
      'Change 환율 적용 방식 and submit it for approval: the dialog warns in advance that nothing changes until approval, ' +
        'the request is recorded as awaiting approval, and the list still shows the OLD value with the 승인 대기 pill. ' +
        `${DEVIATION_LIVE_ROW} Deviation from TC: the dialog note reads "승인 전까지 기존 값이 그대로 적용되며, 정산 실행도 기존 ` +
        '값으로 동작합니다. 승인 대기 중에는 이 정책을 수정할 수 없습니다." (TC: "승인 즉시 새 값이 적용되며, 다음 정산 실행부터 ' +
        `반영됩니다."); ${DEVIATION_CONFIRM}. The pending request is withdrawn afterwards.`,
    );
    await allure.severity('blocker');
    await allure.tags('regression', 'ui', 'approval', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_038');

    try {
      await step(`Arrange: Pre-condition 1–2 — ${LIVE_KEY} has no pending request (current 환율 적용 방식 recorded)`, async () => {
        const row = await liveRow(policyApi);
        baseline = valuesOf(row);
        await form.open(row.id);
      });

      const newLabel = () => (baseline!.fxSourceStrategy === 'ALREADY_KRW' ? '정산환율' : '이미 KRW');
      const oldLabel = () => (baseline!.fxSourceStrategy === 'ALREADY_KRW' ? '이미 KRW' : '정산환율');

      await step('Act: Step 1 — Change 환율 적용 방식 (FX source strategy) to the other value and click 저장', async () => {
        await form.strategySelect.selectOption(baseline!.fxSourceStrategy === 'ALREADY_KRW' ? 'BANK_SETTLEMENT_RATE' : 'ALREADY_KRW');
        await form.save();
      });

      await step('Assert: Expected 1 — The dialog warns in advance that the new value waits for approval', async () => {
        await expect(form.confirmDialogTitle, '[Expected 1] Approval dialog 승인을 요청할까요? opens').toHaveText('승인을 요청할까요?');
        await expect(
          form.confirmDialog.getByText('승인 전까지 기존 값이 그대로 적용되며, 정산 실행도 기존 값으로 동작합니다. 승인 대기 중에는 이 정책을 수정할 수 없습니다.', { exact: true }),
          '[Expected 1] The dialog warns that the old value stays in force until approval',
        ).toBeVisible();
      });

      await step('Act: Step 2 — Enter 변경 사유 (Reason) and click 승인 요청', async () => {
        submitStatus = await form.submitForApproval(traceReason('TC_US080_038'));
      });

      await step('Assert: Expected 2 — The request is recorded as awaiting approval', async () => {
        expect(submitStatus, '[Expected 2] The server accepts the request').toBeLessThan(300);
        await expect(form.submittedToast, '[Expected 2] Toast 승인 요청됨 confirms the submission').toBeVisible();
        expect((await policyApi.getByKey(LIVE_ROW)).body.holder?.pending, '[Expected 2] The row has a pending approval request').toBeDefined();
      });

      await step('Act: Step 3 — Click 목록으로 (Back to list) and read that row', async () => {
        await form.backToList();
        await list.searchKey(...asRow(LIVE_ROW));
      });

      await step('Assert: Expected 3 — The list still shows the old value and carries the 승인 대기 pill', async () => {
        const row = list.rowByKey(...asRow(LIVE_ROW));
        await expect(row.locator('td:nth-child(4)'), `[Expected 3] 환율 적용 방식 still reads ${oldLabel()}`).toContainText(oldLabel());
        await expect(row.locator('td:nth-child(4)'), `[Expected 3] The new value ${newLabel()} is not in force`).not.toContainText(newLabel());
        await expect(list.statusPill(row, '승인 대기'), '[Expected 3] The row carries the 승인 대기 (Awaiting approval) pill').toBeVisible();
      });
    } finally {
      if (baseline) await restoreLiveRow(policyApi, baseline);
    }
  });

  test('TC_US080_039 — The submitter can withdraw their own pending request', async ({
    page,
    paymentMethodPolicyListPage: list,
    paymentMethodPolicyFormPage: form,
    policyApi,
  }) => {
    const step = makeStep(page);
    let baseline: PolicyValues | undefined;
    await allure.description(
      'As the submitter, click 회수 in the 작업 cell of a row with a pending 환율 적용 방식 change: the dialog "이 요청을 회수할까요?" ' +
        'opens with no reason input; confirming withdraws the request, the 승인 대기 pill is replaced by ⏱ 회수됨 and the ' +
        `row can be edited again. ${DEVIATION_LIVE_ROW}`,
    );
    await allure.severity('critical');
    await allure.tags('regression', 'ui', 'approval', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_039');

    try {
      await step(`Arrange: Pre-condition 1–2 — ${LIVE_KEY} has a pending 환율 적용 방식 change submitted by this account`, async () => {
        baseline = valuesOf(await liveRow(policyApi));
        await submitStrategyChange(policyApi, traceReason('TC_US080_039'));
        await list.open();
        await list.searchKey(...asRow(LIVE_ROW));
      });

      await step('Act: Step 1 — Click 회수 (Withdraw) in that row\'s 작업 (Action) cell', async () => {
        await list.withdrawLinkInRow(list.rowByKey(...asRow(LIVE_ROW))).click();
      });

      await step('Assert: Expected 1 — The withdraw dialog opens with no reason input', async () => {
        await expect(list.withdrawDialog, '[Expected 1] Dialog 이 요청을 회수할까요? (Withdraw this request?) opens').toBeVisible();
        await expect(list.withdrawDialog.locator('textarea, input'), '[Expected 1] The dialog has no reason input').toHaveCount(0);
      });

      await step('Act: Step 2 — Confirm on the 이 요청을 회수할까요? dialog', async () => {
        await list.withdrawDialogConfirmButton.click();
        await expect(list.withdrawDialog).toBeHidden();
      });

      await step('Assert: Expected 2 — Withdrawn: 승인 대기 is gone, ⏱ 회수됨 shows, the row can be edited again', async () => {
        await expect(list.withdrawnToast, '[Expected 2] Toast confirms the withdrawal').toBeVisible();
        await list.searchKey(...asRow(LIVE_ROW));
        const row = list.rowByKey(...asRow(LIVE_ROW));
        await expect(list.statusPill(row, '승인 대기'), '[Expected 2] The 승인 대기 pill has disappeared').toHaveCount(0);
        await expect(list.statusPill(row, '⏱ 회수됨'), '[Expected 2] The row carries the ⏱ 회수됨 (withdrawn) annotation').toBeVisible();
        await list.openRow(...asRow(LIVE_ROW));
        await expect(form.strategySelect, '[Expected 2] The row can be edited again').toBeEnabled();
      });
    } finally {
      if (baseline) await restoreLiveRow(policyApi, baseline);
    }
  });

  test('TC_US080_041 — The annotation is cleared by the next submission', async ({
    page,
    paymentMethodPolicyListPage: list,
    paymentMethodPolicyFormPage: form,
    policyApi,
  }) => {
    const step = makeStep(page);
    let baseline: PolicyValues | undefined;
    let submitStatus = 0;
    await allure.description(
      'On a row carrying ⏱ 회수됨, change 환율 적용 방식 again and submit: the new request is recorded as awaiting approval ' +
        `and the ⏱ 회수됨 annotation is replaced by the 승인 대기 pill. ${DEVIATION_LIVE_ROW} Deviation from TC: ` +
        `${DEVIATION_CONFIRM}. The new request is withdrawn afterwards.`,
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'approval', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_041');

    try {
      await step(`Arrange: Pre-condition 1–2 — ${LIVE_KEY} carries ⏱ 회수됨 from an earlier withdrawal`, async () => {
        baseline = valuesOf(await liveRow(policyApi));
        const pendingRow = await submitStrategyChange(policyApi, traceReason('TC_US080_041_setup'));
        await policyApi.withdraw(pendingRow.id);
        await form.open((await liveRow(policyApi)).id);
      });

      await step('Act: Step 1 — Change 환율 적용 방식, click 저장, enter 변경 사유 and click 승인 요청', async () => {
        await form.strategySelect.selectOption(baseline!.fxSourceStrategy === 'ALREADY_KRW' ? 'BANK_SETTLEMENT_RATE' : 'ALREADY_KRW');
        await form.save();
        submitStatus = await form.submitForApproval(traceReason('TC_US080_041'));
      });

      await step('Assert: Expected 1 — The new request is recorded as awaiting approval', async () => {
        expect(submitStatus, '[Expected 1] The server accepts the request').toBeLessThan(300);
        expect((await policyApi.getByKey(LIVE_ROW)).body.holder?.pending, '[Expected 1] The row has a pending request').toBeDefined();
      });

      await step('Act: Step 2 — Return to the list and read that row', async () => {
        await list.open();
        await list.searchKey(...asRow(LIVE_ROW));
      });

      await step('Assert: Expected 2 — ⏱ 회수됨 is gone, replaced by the 승인 대기 pill', async () => {
        const row = list.rowByKey(...asRow(LIVE_ROW));
        await expect(list.statusPill(row, '⏱ 회수됨'), '[Expected 2] The ⏱ 회수됨 annotation is gone').toHaveCount(0);
        await expect(list.statusPill(row, '승인 대기'), '[Expected 2] The 승인 대기 (Awaiting approval) pill is shown').toBeVisible();
      });
    } finally {
      if (baseline) await restoreLiveRow(policyApi, baseline);
    }
  });

  test('TC_US080_042 — Changing lag goes live immediately with no approval step', async ({
    page,
    paymentMethodPolicyListPage: list,
    paymentMethodPolicyFormPage: form,
    policyApi,
  }) => {
    const step = makeStep(page);
    let baseline: PolicyValues | undefined;
    await allure.description(
      'Change 지연일수 5 → 7 and save: the dialog is "이 변경을 적용할까요?" (not the approval dialog) with no reason input; ' +
        '확인 및 저장 shows the toast "저장됨 — 다음 정산 실행부터 새 값이 적용됩니다." and the list shows lag 7 immediately with ' +
        `no 승인 대기 pill. ${DEVIATION_LIVE_ROW} The lag is restored afterwards.`,
    );
    await allure.severity('blocker');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_042');

    try {
      await step(`Arrange: Pre-condition 1–2 — ${LIVE_KEY} has 지연일수 = 5 and no pending request`, async () => {
        const row = await liveRow(policyApi);
        baseline = valuesOf(row);
        const prepared = await setCadence(policyApi, { cycleType: row.cycleType, cycleAnchorWeekday: row.cycleAnchorWeekday ?? null, cycleLagDays: 5 });
        await form.open(prepared.id);
      });

      await step('Act: Step 1 — Change 지연일수 (Lag) from 5 to 7 and click 저장 (Save)', async () => {
        await form.fillPolicySettings({ lag: '7' });
        await form.save();
      });

      await step('Assert: Expected 1 — "이 변경을 적용할까요?" opens, not the approval dialog, with no reason input', async () => {
        await expect(form.confirmDialogTitle, '[Expected 1] Dialog title is 이 변경을 적용할까요? (Apply this change?)').toHaveText('이 변경을 적용할까요?');
        await expect(form.changeReasonInput, '[Expected 1] No 변경 사유 (Reason) input').toHaveCount(0);
      });

      await step('Act: Step 2 — Click 확인 및 저장 (Confirm and save)', async () => {
        await form.confirmApplyNow();
      });

      await step('Assert: Expected 2 — The toast reads "저장됨 — 다음 정산 실행부터 새 값이 적용됩니다."', async () => {
        await expect(form.savedToast, '[Expected 2] Saved toast is shown').toBeVisible();
      });

      await step('Act: Step 3 — Return to the list and read that row', async () => {
        await list.open();
        await list.searchKey(...asRow(LIVE_ROW));
      });

      await step('Assert: Expected 3 — 지연일수 = 7 immediately; no 승인 대기 pill', async () => {
        const row = list.rowByKey(...asRow(LIVE_ROW));
        await expect(row.locator('td:nth-child(5)'), '[Expected 3] The row shows lag 7 immediately').toContainText('lag 7d');
        await expect(list.statusPill(row, '승인 대기'), '[Expected 3] No 승인 대기 (Awaiting approval) pill appears').toHaveCount(0);
      });
    } finally {
      if (baseline) await restoreLiveRow(policyApi, baseline);
    }
  });

  test('TC_US080_043 — Changing cycle type to DAILY hides the anchor weekday field', async ({ page, paymentMethodPolicyFormPage: form, policyApi }) => {
    const step = makeStep(page);
    let baseline: PolicyValues | undefined;
    await allure.description(
      'On a WEEKLY · WED row, switch 정산 주기 to DAILY: the 기준 요일 field disappears entirely (not greyed out); switching ' +
        `back to WEEKLY brings it back with WED. Nothing is saved. ${DEVIATION_LIVE_ROW} (the row is set to WEEKLY · WED for ` +
        'the test and restored afterwards).',
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_043');

    try {
      await step(`Arrange: Pre-condition 1–2 — ${LIVE_KEY} has 정산 주기 = WEEKLY and 기준 요일 = WED`, async () => {
        const row = await liveRow(policyApi);
        baseline = valuesOf(row);
        const prepared = await setCadence(policyApi, { cycleType: 'WEEKLY', cycleAnchorWeekday: 'WED', cycleLagDays: row.cycleLagDays });
        await form.open(prepared.id);
      });

      await step('Act: Step 1 — Change 정산 주기 (Settlement cycle) to DAILY', async () => {
        await form.cycleTypeSelect.selectOption('DAILY');
      });

      await step('Assert: Expected 1 — The 기준 요일 field disappears entirely from the form', async () => {
        await expect(form.anchorSelect, '[Expected 1] 기준 요일 control is removed, not disabled').toHaveCount(0);
        await expect(form.fieldLabel('기준 요일'), '[Expected 1] 기준 요일 label is removed too').toHaveCount(0);
      });

      await step('Act: Step 2 — Change 정산 주기 back to WEEKLY', async () => {
        await form.cycleTypeSelect.selectOption('WEEKLY');
      });

      await step('Assert: Expected 2 — The 기준 요일 field reappears with WED', async () => {
        await expect(form.anchorSelect, '[Expected 2] 기준 요일 reappears with WED').toHaveValue('WED');
      });
    } finally {
      if (baseline) await restoreLiveRow(policyApi, baseline);
    }
  });

  test('TC_US080_045 — The row is locked with a stated reason while a replacement is pending', async ({
    page,
    paymentMethodPolicyListPage: list,
    paymentMethodPolicyFormPage: form,
    policyApi,
  }) => {
    const step = makeStep(page);
    let baseline: PolicyValues | undefined;
    await allure.description(
      'Open a row with a pending 환율 적용 방식 change: a banner states the lock reason with the 변경 승인에서 확인 link; no ' +
        `field can be edited and 저장 is disabled — nothing is locked silently. ${DEVIATION_LIVE_ROW} Deviation from TC: the ` +
        'banner title reads "승인 대기 중 — 수정할 수 없습니다" (TC: "승인 대기") followed by who requested what and when.',
    );
    await allure.severity('critical');
    await allure.tags('regression', 'ui', 'approval', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_045');

    try {
      await step(`Arrange: Pre-condition 1–2 — ${LIVE_KEY} has a pending 환율 적용 방식 change`, async () => {
        baseline = valuesOf(await liveRow(policyApi));
        await submitStrategyChange(policyApi, traceReason('TC_US080_045'));
        await list.open();
        await list.searchKey(...asRow(LIVE_ROW));
      });

      await step('Act: Step 1 — Open that row from the list screen', async () => {
        await list.openRow(...asRow(LIVE_ROW));
      });

      await step('Assert: Expected 1 — A banner states the lock reason, with the 변경 승인에서 확인 link', async () => {
        await expect(form.pendingLockTitle, '[Expected 1] Lock banner "승인 대기 중 — 수정할 수 없습니다" is shown').toBeVisible();
        await expect(form.pendingLockDetail, '[Expected 1] The banner says who requested the change').toContainText(getAccountDisplayName('submitter'));
        await expect(form.reviewInApprovalButton, '[Expected 1] 변경 승인에서 확인 (Review in Change Approval) link is shown').toBeVisible();
      });

      await step('Act: Step 2 — Try to edit any field and read the 저장 (Save) button', async () => {
        await form.lagInput.click({ force: true });
      });

      await step('Assert: Expected 2 — No field can be edited and 저장 is disabled', async () => {
        await expect(form.strategySelect, '[Expected 2] 환율 적용 방식 is locked').toBeDisabled();
        await expect(form.cycleTypeSelect, '[Expected 2] 정산 주기 is locked').toBeDisabled();
        await expect(form.lagInput, '[Expected 2] 지연일수 is locked').toBeDisabled();
        await expect(form.saveButton, '[Expected 2] 저장 (Save) is disabled').toBeDisabled();
      });
    } finally {
      if (baseline) await restoreLiveRow(policyApi, baseline);
    }
  });

  test('TC_US080_046 — The annotation survives opening the form without submitting', async ({
    page,
    paymentMethodPolicyListPage: list,
    paymentMethodPolicyFormPage: form,
    policyApi,
  }) => {
    const step = makeStep(page);
    let baseline: PolicyValues | undefined;
    let firstBanner = '';
    const submitter = getAccountDisplayName('submitter');
    await allure.description(
      'On a row carrying ⏱ 회수됨, open the form: the banner states who withdrew, when and the requested value with no ' +
        'reason field; back on the list the row still carries ⏱ 회수됨; reopening shows the same banner — opening the form ' +
        `does not clear it. ${DEVIATION_LIVE_ROW} Deviation from TC: the banner title reads "최근 변경 요청을 회수했습니다" and ` +
        'the ⏱ 회수됨 pill itself is shown on the list row, not inside the form banner.',
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'approval', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_046');

    try {
      await step(`Arrange: Pre-condition 1–2 — ${LIVE_KEY} carries the ⏱ 회수됨 annotation`, async () => {
        baseline = valuesOf(await liveRow(policyApi));
        const pendingRow = await submitStrategyChange(policyApi, traceReason('TC_US080_046'));
        await policyApi.withdraw(pendingRow.id);
        await list.open();
        await list.searchKey(...asRow(LIVE_ROW));
      });

      await step('Act: Step 1 — Open that row in edit mode and read the banner', async () => {
        await list.openRow(...asRow(LIVE_ROW));
        firstBanner = ((await form.withdrawnBannerDetail.textContent()) ?? '').trim();
      });

      await step('Assert: Expected 1 — The banner states who withdrew, when and the requested value, with no reason field', async () => {
        await expect(form.withdrawnBannerTitle, '[Expected 1] Withdrawn banner is shown').toBeVisible();
        expect(firstBanner, `[Expected 1] The banner names the submitter ${submitter}`).toContain(submitter);
        expect(firstBanner, '[Expected 1] The banner states when it was withdrawn').toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
        expect(firstBanner, '[Expected 1] The banner states the requested value').toMatch(/(정산환율|이미 KRW)[^()]*\(으\)로 변경 요청/);
        await expect(page.locator('textarea'), '[Expected 1] No reason field').toHaveCount(0);
      });

      await step('Act: Step 2 — Click 목록으로 (Back to list) without saving anything', async () => {
        await form.backToList();
        await list.searchKey(...asRow(LIVE_ROW));
      });

      await step('Assert: Expected 2 — Back on the list, the row still carries ⏱ 회수됨', async () => {
        await expect(list.statusPill(list.rowByKey(...asRow(LIVE_ROW)), '⏱ 회수됨'), '[Expected 2] ⏱ 회수됨 is still shown').toBeVisible();
      });

      await step('Act: Step 3 — Open that row again', async () => {
        await list.openRow(...asRow(LIVE_ROW));
      });

      await step('Assert: Expected 3 — The banner is still shown with the same content', async () => {
        await expect(form.withdrawnBannerTitle, '[Expected 3] Withdrawn banner is still shown').toBeVisible();
        await expect(form.withdrawnBannerDetail, '[Expected 3] Banner content is unchanged').toHaveText(firstBanner);
      });
    } finally {
      if (baseline) await restoreLiveRow(policyApi, baseline);
    }
  });

  test('TC_US080_047 — Save is disabled until a field actually differs from the saved row', async ({ page, paymentMethodPolicyFormPage: form, policyApi }) => {
    const step = makeStep(page);
    await allure.description(
      `On the seed row ${SEED_KEY} (지연일수 = 5): 저장 is disabled before touching anything, enabled after 5 → 7, and ` +
        'disabled again after 7 → 5 — compared by value, not by interaction. Nothing is saved.',
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_047');

    await step(`Arrange: Pre-condition 1–2 — Seed row ${SEED_KEY} has 지연일수 = 5`, async () => {
      const seed = (await policyApi.getByKey(SEED_ROW)).body.holder!;
      expect(seed.cycleLagDays, '[Pre-condition 2] Seed row 지연일수 is 5').toBe(5);
      await form.open(seed.id);
    });

    await step('Act: Step 1 — Open that row and read 저장 (Save) before touching anything', async () => {
      await form.saveButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — 저장 is disabled', async () => {
      await expect(form.saveButton, '[Expected 1] 저장 (Save) is disabled').toBeDisabled();
    });

    await step('Act: Step 2 — Change 지연일수 from 5 to 7', async () => {
      await form.fillPolicySettings({ lag: '7' });
    });

    await step('Assert: Expected 2 — 저장 becomes enabled', async () => {
      await expect(form.saveButton, '[Expected 2] 저장 (Save) is enabled').toBeEnabled();
    });

    await step('Act: Step 3 — Change 지연일수 back to 5', async () => {
      await form.fillPolicySettings({ lag: '5' });
    });

    await step('Assert: Expected 3 — 저장 goes back to disabled (compared by value)', async () => {
      await expect(form.saveButton, '[Expected 3] 저장 (Save) is disabled again').toBeDisabled();
    });
  });

  test('TC_US080_048 — Neither enum dropdown offers a way to add a new value', async ({ page, paymentMethodPolicyFormPage: form, policyApi }) => {
    const step = makeStep(page);
    await allure.description(
      `On the seed row ${SEED_KEY} in edit mode: 환율 적용 방식 offers only its two values (a select, not free text), 정산 주기 ` +
        'only WEEKLY and DAILY, and no button or link anywhere lets an enum value be added. Read-only.',
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_048');

    await step(`Arrange: Pre-condition 1–2 — Seed row ${SEED_KEY} open in edit mode`, async () => {
      await form.open((await policyApi.getByKey(SEED_ROW)).body.holder!.id);
    });

    await step('Act: Step 1 — Open the 환율 적용 방식 (FX source strategy) dropdown and inspect every entry', async () => {
      await form.strategySelect.focus();
    });

    await step('Assert: Expected 1 — Only the two defined values; no Add/Other entry; not typeable', async () => {
      await expect(form.strategySelect.locator('option'), '[Expected 1] Exactly two entries').toHaveCount(2);
      await expect(form.strategySelect.locator('option[value="ALREADY_KRW"]'), '[Expected 1] 이미 KRW — 환율 미적용 is offered').toHaveCount(1);
      await expect(form.strategySelect.locator('option[value="BANK_SETTLEMENT_RATE"]'), '[Expected 1] 정산환율 is offered').toHaveCount(1);
      await expect(form.strategySelect.locator('option', { hasText: /추가|기타|add|other/i }), '[Expected 1] No Add / Other entry').toHaveCount(0);
      expect(await form.strategySelect.evaluate((el) => el.tagName), '[Expected 1] The control is a select, not free text').toBe('SELECT');
    });

    await step('Act: Step 2 — Open the 정산 주기 (Settlement cycle) dropdown and inspect every entry', async () => {
      await form.cycleTypeSelect.focus();
    });

    await step('Assert: Expected 2 — Only WEEKLY and DAILY; no add entry', async () => {
      await expect(form.cycleTypeSelect.locator('option'), '[Expected 2] Exactly two entries').toHaveCount(2);
      await expect(form.cycleTypeSelect.locator('option[value="WEEKLY"]'), '[Expected 2] WEEKLY is offered').toHaveCount(1);
      await expect(form.cycleTypeSelect.locator('option[value="DAILY"]'), '[Expected 2] DAILY is offered').toHaveCount(1);
    });

    await step('Act: Step 3 — Inspect the whole form for a catalogue-management button or link', async () => {
      await form.saveButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — No button or link on the screen adds an enum value', async () => {
      await expect(page.getByRole('button', { name: /추가|관리|add|manage/i }), '[Expected 3] No add / manage button').toHaveCount(0);
      await expect(page.getByRole('link', { name: /값 추가|코드 추가|add value/i }), '[Expected 3] No add-value link').toHaveCount(0);
    });
  });

  test('TC_US080_049 — No delete or deactivate affordance exists on the screen', async ({
    page,
    paymentMethodPolicyListPage: list,
    paymentMethodPolicyFormPage: form,
    policyApi,
  }) => {
    const step = makeStep(page);
    const observations = new Observations(page);
    await allure.description(
      'The 작업 cell of every row carries only 변경 이력 and, while a request is pending, 회수 — no delete and no enable/disable ' +
        `toggle; the edit form (seed row ${SEED_KEY}) has no delete or deactivate button and no enabled/active field. ` +
        'Deviation from TC: the register holds more than the 7 seed rows, so every row (page size 100) is inspected. Read-only.',
    );
    await allure.severity('critical');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_049');

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN, every register row on one page', async () => {
      await list.open();
      await list.setPageSize('100');
    });

    await step('Act: Step 1 — Inspect the 작업 (Action) cell of every row', async () => {
      const cells = await list.dataRows.locator('td:last-child').evaluateAll((tds) =>
        tds.map((td) => Array.from(td.querySelectorAll('[role="button"], button, a, input')).map((el) => (el.textContent ?? '').trim() || el.tagName)),
      );
      for (const [row, items] of cells.entries()) {
        await observations.record(`[Expected 1] Row ${row + 1} 작업 cell carries only 변경 이력 / 회수 (${items.join(', ')})`, async () =>
          items.every((item) => item === '변경 이력' || item === '회수'),
        );
      }
    });

    await step('Assert: Expected 1 — Only 변경 이력 and (when pending) 회수; no delete, no toggle', async () => {
      observations.assertAll();
    });

    await step(`Act: Step 2 — Open the seed row ${SEED_KEY} and inspect the whole form, including the footer`, async () => {
      await form.open((await policyApi.getByKey(SEED_ROW)).body.holder!.id);
      await form.saveButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — No delete / deactivate button and no enabled/active flag field', async () => {
      await expect(page.getByRole('button', { name: /삭제|비활성|delete|deactivate|disable/i }), '[Expected 2] No delete or deactivate button').toHaveCount(0);
      await expect(page.getByRole('checkbox'), '[Expected 2] No enabled/active checkbox').toHaveCount(0);
      await expect(page.getByRole('switch'), '[Expected 2] No enabled/active switch').toHaveCount(0);
      await expect(form.fieldLabel('활성').or(form.fieldLabel('사용 여부')), '[Expected 2] No enabled/active field').toHaveCount(0);
    });
  });

  test('TC_US080_050 — A never-edited channel shows the empty state with the baseline filtered out', async ({ page, paymentMethodPolicyFormPage: form, policyApi }) => {
    const step = makeStep(page);
    await allure.description(
      `Open 변경 이력 on the never-edited seed row ${SEED_KEY}: the dialog shows its empty state "아직 변경 이력이 없습니다" with ` +
        'the sub-line and no record row. Not automated: "the CREATED record exists" — neither the UI nor the history API ' +
        'exposes CREATED records (the API returns an empty page too).',
    );
    await allure.severity('critical');
    await allure.tags('regression', 'ui', 'history', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_050');

    await step(`Arrange: Pre-condition 1–2 — Seed row ${SEED_KEY} has never been edited`, async () => {
      const seed = (await policyApi.getByKey(SEED_ROW)).body.holder!;
      expect(seed.version, '[Pre-condition 2] Seed row has never been edited').toBe(0);
      await form.open(seed.id);
    });

    await step('Act: Step 1 — Open that row and click 변경 이력 (Change history)', async () => {
      await form.openHistory();
    });

    await step('Assert: Expected 1 — Empty state with its sub-line; no record row is rendered', async () => {
      await expect(form.historyEmptyTitle, '[Expected 1] "아직 변경 이력이 없습니다" is shown').toBeVisible();
      await expect(form.historyEmptySubLine, '[Expected 1] The sub-line is shown').toBeVisible();
      await expect(form.historyRows, '[Expected 1] No record row is rendered').toHaveCount(0);
    });
  });

  test('TC_US080_051 — The Reason field accepts up to 200 characters and is required for an FX change', async ({
    page,
    paymentMethodPolicyFormPage: form,
    policyApi,
  }) => {
    const step = makeStep(page);
    const reason200 = '가'.repeat(200);
    let typed = '';
    await allure.description(
      `On the seed row ${SEED_KEY}, change 환율 적용 방식 and click 저장: "승인을 요청할까요?" opens with 변경 사유 and its hint; with ` +
        'the reason empty nothing can be submitted; 200 Hangul characters are accepted intact and enable the submit ' +
        `button; a 201st cannot be typed. Deviation from TC: ${DEVIATION_CONFIRM}. Nothing is submitted — the dialog is ` +
        'closed with 뒤로.',
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_051');

    await step(`Arrange: Pre-condition 1–2 — Seed row ${SEED_KEY} has no pending request`, async () => {
      const seed = (await policyApi.getByKey(SEED_ROW)).body.holder!;
      expect(seed.pending, '[Pre-condition 2] No pending request').toBeUndefined();
      await form.open(seed.id);
    });

    await step('Act: Step 1 — Change 환율 적용 방식 and click 저장 (Save)', async () => {
      await form.strategySelect.selectOption('BANK_SETTLEMENT_RATE');
      await form.save();
    });

    await step('Assert: Expected 1 — "승인을 요청할까요?" opens with 변경 사유 and its hint', async () => {
      await expect(form.confirmDialogTitle, '[Expected 1] Dialog title is 승인을 요청할까요?').toHaveText('승인을 요청할까요?');
      await expect(form.changeReasonInput, '[Expected 1] 변경 사유 field is shown').toBeVisible();
      await expect(form.confirmDialog.getByText(MSG_REVIEW_HINT, { exact: true }), `[Expected 1] Hint "${MSG_REVIEW_HINT}" is shown`).toBeVisible();
    });

    await step('Act: Step 2 — Leave 변경 사유 empty and try to click 승인 요청', async () => {
      await form.requestApprovalButton.click({ force: true });
    });

    await step('Assert: Expected 2 — Nothing is submitted; the field is marked as required', async () => {
      await expect(form.requestApprovalButton, '[Expected 2] 승인 요청 stays disabled — nothing is submitted').toBeDisabled();
      await expect(form.confirmDialog, '[Expected 2] The dialog stays open').toBeVisible();
      await expect(form.changeReasonLabel.locator('span', { hasText: '*' }), '[Expected 2] 변경 사유 is marked required (*)').toHaveCount(1);
    });

    await step('Act: Step 3 — Enter exactly 200 Hangul characters into 변경 사유', async () => {
      await form.fillChangeReason(reason200);
    });

    await step('Assert: Expected 3 — All 200 characters are kept intact and 승인 요청 becomes enabled', async () => {
      await expect(form.changeReasonInput, '[Expected 3] All 200 Hangul characters are kept intact').toHaveValue(reason200);
      await expect(form.requestApprovalButton, '[Expected 3] 승인 요청 becomes enabled').toBeEnabled();
    });

    await step('Act: Step 4 — Try to type a 201st character', async () => {
      await form.changeReasonInput.press('End');
      await form.changeReasonInput.pressSequentially('나');
      typed = await form.changeReasonInput.inputValue();
    });

    await step('Assert: Expected 4 — The 201st character cannot be entered', async () => {
      expect(typed.length, '[Expected 4] The field still holds exactly 200 characters').toBe(200);
      await form.backFromDialog();
    });
  });

  test('TC_US080_053 — Creating a row waits for approval and leaves the quarantine state unchanged', async () => {
    await allure.description(
      'Not automated: Expected 2 reads the quarantine state of the settlement engine (US006, BR-2) for the channel — no ' +
        'US080 screen or API exposes it. The "create waits for approval" half is covered by TC_US080_023 / TC_US080_028.',
    );
    await allure.severity('blocker');
    await allure.tags('detail', 'out-of-scope', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_053');
    test.skip(true, 'Engine quarantine state (US006) is not observable from any US080 screen or API');
  });

  test('TC_US080_056 — A withdrawal shows the submitter and the requested value with no reason field', async ({
    page,
    paymentMethodPolicyFormPage: form,
    policyApi,
  }) => {
    const step = makeStep(page);
    let baseline: PolicyValues | undefined;
    const submitter = getAccountDisplayName('submitter');
    await allure.description(
      'Open a row whose request was just withdrawn by the submitter: the banner shows the withdrawal with the submitter\'s ' +
        `name and the requested value; no reason field and no control asking for one. ${DEVIATION_LIVE_ROW} Deviation from ` +
        'TC: the banner title reads "최근 변경 요청을 회수했습니다" (the ⏱ 회수됨 pill is shown on the list row).',
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'approval', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_056');

    try {
      await step(`Arrange: Pre-condition 1–2 — ${LIVE_KEY} has a request just withdrawn by the submitter`, async () => {
        baseline = valuesOf(await liveRow(policyApi));
        const pendingRow = await submitStrategyChange(policyApi, traceReason('TC_US080_056'));
        await policyApi.withdraw(pendingRow.id);
      });

      await step('Act: Step 1 — Open that row and read the banner', async () => {
        await form.open((await liveRow(policyApi)).id);
      });

      await step('Assert: Expected 1 — Withdrawal banner with submitter and requested value; no reason field or control', async () => {
        await expect(form.withdrawnBannerTitle, '[Expected 1] Withdrawal banner is shown').toBeVisible();
        await expect(form.withdrawnBannerDetail, `[Expected 1] The banner names the submitter ${submitter}`).toContainText(submitter);
        await expect(form.withdrawnBannerDetail, '[Expected 1] The banner states the requested value').toContainText(/(정산환율|이미 KRW)[^()]*\(으\)로 변경 요청/);
        await expect(page.locator('textarea'), '[Expected 1] No reason field').toHaveCount(0);
        await expect(page.getByRole('textbox', { name: /사유/ }), '[Expected 1] No control asking for a reason').toHaveCount(0);
      });
    } finally {
      if (baseline) await restoreLiveRow(policyApi, baseline);
    }
  });

  test('TC_US080_057 — The cycle phrase is recomputed at render and never stored', async ({
    page,
    paymentMethodPolicyListPage: list,
    paymentMethodPolicyFormPage: form,
    policyApi,
  }) => {
    const step = makeStep(page);
    let baseline: PolicyValues | undefined;
    let record: Record<string, unknown> = {};
    await allure.description(
      'On a DAILY row with 지연일수 = 5 the list cycle phrase describes DAILY with a 5-day lag; after changing the lag to 7 ' +
        'and saving, the phrase follows (7-day lag); the stored record holds only the four policy fields and no pre-built ' +
        `phrase. ${DEVIATION_LIVE_ROW} Deviation from TC: "the record in the table" is read through GET ` +
        '/payment-method-policies/{id} (no direct DB access). The row is restored afterwards.',
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_057');

    try {
      await step(`Arrange: Pre-condition 1–2 — ${LIVE_KEY} is DAILY with 지연일수 = 5`, async () => {
        baseline = valuesOf(await liveRow(policyApi));
        await setCadence(policyApi, { cycleType: 'DAILY', cycleAnchorWeekday: null, cycleLagDays: 5 });
        await list.open();
      });

      await step('Act: Step 1 — Open that row on the list and read the 정산 주기 (Settlement cycle) phrase', async () => {
        await list.searchKey(...asRow(LIVE_ROW));
      });

      await step('Assert: Expected 1 — The phrase describes DAILY with a 5-day lag', async () => {
        const cell = list.rowByKey(...asRow(LIVE_ROW)).locator('td:nth-child(5)');
        await expect(cell, '[Expected 1] Phrase reads 매일 · 거래 후 약 5일').toContainText('매일 · 거래 후 약 5일');
        await expect(cell, '[Expected 1] Machine line reads DAILY · — · lag 5d').toContainText('DAILY · — · lag 5d');
      });

      await step('Act: Step 2 — Change 지연일수 to 7, save, then read the phrase again', async () => {
        await list.openRow(...asRow(LIVE_ROW));
        await form.fillPolicySettings({ lag: '7' });
        await form.save();
        await form.confirmApplyNow();
        await expect(form.savedToast).toBeVisible();
        await list.open();
        await list.searchKey(...asRow(LIVE_ROW));
      });

      await step('Assert: Expected 2 — The phrase follows, describing a 7-day lag', async () => {
        const cell = list.rowByKey(...asRow(LIVE_ROW)).locator('td:nth-child(5)');
        await expect(cell, '[Expected 2] Phrase reads 매일 · 거래 후 약 7일').toContainText('매일 · 거래 후 약 7일');
        await expect(cell, '[Expected 2] Machine line reads DAILY · — · lag 7d').toContainText('DAILY · — · lag 7d');
      });

      await step('Act: Step 3 — Read that row\'s record', async () => {
        record = (await policyApi.get((await liveRow(policyApi)).id)).body as unknown as Record<string, unknown>;
      });

      await step('Assert: Expected 3 — The record stores only the four policy fields; no pre-built phrase', async () => {
        for (const field of ['fxSourceStrategy', 'cycleType', 'cycleLagDays']) {
          expect(record, `[Expected 3] The record stores ${field}`).toHaveProperty(field);
        }
        expect(Object.keys(record).filter((field) => /phrase|label|text|description|summary/i.test(field)), '[Expected 3] No field holds a pre-built cycle phrase').toEqual([]);
        expect(Object.values(record).some((value) => typeof value === 'string' && value.includes('거래 후')), '[Expected 3] No value carries the rendered phrase').toBe(false);
      });
    } finally {
      if (baseline) await restoreLiveRow(policyApi, baseline);
    }
  });

  test('TC_US080_058 — The "What this means" panel recomputes from the four policy fields', async ({ page, paymentMethodPolicyFormPage: form, policyApi }) => {
    const step = makeStep(page);
    const observations = new Observations(page);
    const paragraphs = form.whatThisMeansPanel.locator('p');
    let before = '';
    await allure.description(
      'With WEEKLY · WED · 14 · 정산환율 on the form, the 이것이 의미하는 바 block shows two sentences derived from those four ' +
        'values; changing each of the four fields in turn updates the block at once, without saving. Deviation from TC: ' +
        `the four values are set on the form of the seed row ${SEED_KEY} (not saved) instead of a stored row — the block ` +
        'reads the form values either way.',
    );
    await allure.severity('minor');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_058');

    await step('Arrange: Pre-condition 1–2 — Edit form open with WEEKLY · WED · 지연일수 14 · 정산환율 (not saved)', async () => {
      await form.open((await policyApi.getByKey(SEED_ROW)).body.holder!.id);
      await form.fillPolicySettings({ strategy: 'BANK_SETTLEMENT_RATE', cycleType: 'WEEKLY', anchor: 'WED', lag: '14' });
    });

    await step('Act: Step 1 — Read the 이것이 의미하는 바 (What this means) block', async () => {
      before = ((await form.whatThisMeansPanel.textContent()) ?? '').trim();
    });

    await step('Assert: Expected 1 — Two sentences derived from the four current values', async () => {
      await expect(paragraphs, '[Expected 1] The block shows two sentences').toHaveCount(2);
      // 정산환율 → câu 1 mô tả việc quy đổi theo tỷ giá đã đăng ký ("…환율로 환산됩니다…"), không lặp lại nhãn "정산환율".
      await expect(paragraphs.nth(0), '[Expected 1] Sentence 1 reflects 환율 적용 방식 = 정산환율 (converted at the registered rate)').toContainText(
        '환율로 환산됩니다',
      );
      await expect(paragraphs.nth(1), '[Expected 1] Sentence 2 reflects WEEKLY · WED · 14 days').toContainText('매주 수요일 · 2주 후');
    });

    await step('Act: Step 2 — Change each of the four fields in turn, reading the block after every change', async () => {
      const changes: Array<[string, () => Promise<unknown>]> = [
        ['기준 요일 WED → FRI', () => form.anchorSelect.selectOption('FRI')],
        ['지연일수 14 → 21', () => form.fillPolicySettings({ lag: '21' })],
        ['정산 주기 WEEKLY → DAILY', () => form.cycleTypeSelect.selectOption('DAILY')],
        ['환율 적용 방식 정산환율 → 이미 KRW', () => form.strategySelect.selectOption('ALREADY_KRW')],
      ];
      for (const [name, change] of changes) {
        await change();
        await observations.record(`[Expected 2] After ${name} the block updates at once`, async () => {
          const now = ((await form.whatThisMeansPanel.textContent()) ?? '').trim();
          const changed = now !== before;
          before = now;
          return changed;
        });
      }
    });

    await step('Assert: Expected 2 — After every change the block updates at once, none of the four skipped', async () => {
      observations.assertAll();
    });
  });

  test('TC_US080_059 — The strategy dropdown offers exactly two options in the specified order', async ({ page, paymentMethodPolicyFormPage: form, policyApi }) => {
    const step = makeStep(page);
    await allure.description(
      `On the seed row ${SEED_KEY} in edit mode, 환율 적용 방식 holds exactly two entries: "이미 KRW — 환율 미적용" first, ` +
        '"정산환율" second; no empty entry and no third value. Read-only.',
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_059');

    await step(`Arrange: Pre-condition 1–2 — Seed row ${SEED_KEY} open in edit mode`, async () => {
      await form.open((await policyApi.getByKey(SEED_ROW)).body.holder!.id);
    });

    await step('Act: Step 1 — Open the 환율 적용 방식 (FX source strategy) dropdown', async () => {
      await form.strategySelect.focus();
    });

    await step('Assert: Expected 1 — Exactly two entries in order, no empty entry, no third value', async () => {
      const options = form.strategySelect.locator('option');
      await expect(options, '[Expected 1] Exactly two entries').toHaveCount(2);
      await expect(options.nth(0), '[Expected 1] First entry is 이미 KRW — 환율 미적용').toHaveText('이미 KRW — 환율 미적용');
      await expect(options.nth(1), '[Expected 1] Second entry is 정산환율').toHaveText('정산환율');
      await expect(form.strategySelect.locator('option[value=""]'), '[Expected 1] No empty entry').toHaveCount(0);
    });
  });

  test('TC_US080_060 — The Change history button is present in edit mode and absent in create mode', async ({
    page,
    paymentMethodPolicyListPage: list,
    paymentMethodPolicyFormPage: form,
    policyApi,
  }) => {
    const step = makeStep(page);
    await allure.description(
      `On the seed row ${SEED_KEY} in edit mode the 변경 이력 button is present and clickable; on the create form it is ` +
        'entirely absent (not present and greyed out). Read-only.',
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_060');

    await step(`Arrange: Pre-condition 1–2 — Seed row ${SEED_KEY} exists`, async () => {
      expect((await policyApi.getByKey(SEED_ROW)).body.taken, '[Pre-condition 2] Seed row exists').toBe(true);
    });

    await step('Act: Step 1 — Open that row in edit mode and look for the 변경 이력 (Change history) button', async () => {
      await form.open((await policyApi.getByKey(SEED_ROW)).body.holder!.id);
    });

    await step('Assert: Expected 1 — The 변경 이력 button is present and clickable', async () => {
      await expect(form.historyButton, '[Expected 1] 변경 이력 button is visible').toBeVisible();
      await expect(form.historyButton, '[Expected 1] 변경 이력 button is clickable').toBeEnabled();
    });

    await step('Act: Step 2 — Return to the list, click 정책 추가 (Add policy) and look for that button again', async () => {
      await form.backToList();
      await list.openCreateForm();
      await expect(form.createTitle).toBeVisible();
    });

    await step('Assert: Expected 2 — The button is entirely absent from the create form', async () => {
      await expect(form.historyButton, '[Expected 2] No 변경 이력 button on the create form').toHaveCount(0);
    });
  });

  test('TC_US080_061 — A stale save is rejected with the concurrent-modification message', async ({ page, browser, paymentMethodPolicyFormPage: formB, policyApi }) => {
    const step = makeStep(page);
    let baseline: PolicyValues | undefined;
    let rowId = 0;
    let lagInB = '';
    await allure.description(
      'Two sessions of the same account have the row open. Session A saves 지연일수 = 7; session B, still on the version it ' +
        'opened, saves 9: it is refused with the persistent banner "다른 사용자가 이 정책을 변경했습니다. 최신 값을 보려면 ' +
        '새로고침하세요." carrying one action, and the 9 just typed stays in the field. Session B is the test page; session A ' +
        `is a second browser context. ${DEVIATION_LIVE_ROW} Deviation from TC: the single action reads "새로고침" (TC: ` +
        '"Reload"). The lag is restored afterwards.',
    );
    await allure.severity('critical');
    await allure.tags('regression', 'ui', 'concurrency', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_061');

    const contextA = await browser.newContext({ storageState: AUTH_STORAGE_STATE, viewport: { width: 1920, height: 1080 }, baseURL: env.baseURL });
    try {
      await contextA.addCookies(toSessionCookies(await getValidSession('submitter', UI_SESSION_BUFFER_MS), env.baseURL));
      const formA = new PaymentMethodPolicyFormPage(await contextA.newPage());

      await step(`Arrange: Pre-condition 1–2 — Two sessions have ${LIVE_KEY} open in edit mode at the same time`, async () => {
        const row = await liveRow(policyApi);
        baseline = valuesOf(row);
        rowId = row.id;
        await formA.open(rowId);
        await formB.open(rowId);
      });

      await step('Act: Step 1 — In session A, change 지연일수 to 7 and save', async () => {
        await formA.fillPolicySettings({ lag: '7' });
        await formA.save();
        await formA.confirmApplyNow();
      });

      await step('Assert: Expected 1 — Session A saves; the row becomes 7', async () => {
        await expect(formA.savedToast, '[Expected 1] Session A shows the saved toast').toBeVisible();
        expect((await policyApi.get(rowId)).body.cycleLagDays, '[Expected 1] The row 지연일수 is 7').toBe(7);
      });

      await step('Act: Step 2 — In session B, change 지연일수 to 9, click 저장 and 확인 및 저장', async () => {
        await formB.fillPolicySettings({ lag: '9' });
        await formB.save();
        await formB.confirmApplyNow();
      });

      await step('Assert: Expected 2 — Session B is refused with the persistent banner carrying one action', async () => {
        await expect(formB.staleVersionBanner, '[Expected 2] The concurrent-modification banner is shown').toBeVisible();
        await expect(formB.staleVersionBannerActions, '[Expected 2] The banner carries exactly one action').toHaveCount(1);
        await expect(formB.staleVersionBannerActions, '[Expected 2] The action is 새로고침 (Reload)').toHaveText(/새로고침/);
        expect((await policyApi.get(rowId)).body.cycleLagDays, '[Expected 2] Session B did not overwrite the row').toBe(7);
      });

      await step('Act: Step 3 — Read the 지연일수 field on session B\'s form', async () => {
        lagInB = await formB.lagInput.inputValue();
      });

      await step('Assert: Expected 3 — The 9 just typed is still in the field', async () => {
        expect(lagInB, '[Expected 3] Session B keeps the value just typed').toBe('9');
      });
    } finally {
      await contextA.close();
      if (baseline) await restoreLiveRow(policyApi, baseline);
    }
  });

  test('TC_US080_062 — One save touching two fields renders as a single stacked record', async ({ page, paymentMethodPolicyFormPage: form, policyApi }) => {
    const step = makeStep(page);
    let baseline: PolicyValues | undefined;
    let recordsBefore = 0;
    let previousNewest = 'null';
    await allure.description(
      'On a DAILY · lag 5 row, change 정산 주기 to WEEKLY and 지연일수 to 7 and save once: the save succeeds and the history ' +
        'gains exactly one record stacking the changed fields in one 변경 내용 cell — not one record per field. ' +
        `${DEVIATION_LIVE_ROW} Deviation from TC: switching to WEEKLY also sets 기준 요일 (— → WED), so the single record ` +
        'stacks three lines. The row is restored afterwards.',
    );
    await allure.severity('critical');
    await allure.tags('regression', 'ui', 'history', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_062');

    try {
      await step(`Arrange: Pre-condition 1–2 — ${LIVE_KEY} is DAILY with 지연일수 = 5; current history counted`, async () => {
        baseline = valuesOf(await liveRow(policyApi));
        const prepared = await setCadence(policyApi, { cycleType: 'DAILY', cycleAnchorWeekday: null, cycleLagDays: 5 });
        await form.open(prepared.id);
        await form.openHistory();
        recordsBefore = await form.historyRows.count();
        previousNewest = JSON.stringify((await form.getHistoryRecords())[0] ?? null);
        await form.closeHistory();
      });

      await step('Act: Step 1 — Change 정산 주기 to WEEKLY and 지연일수 to 7, then save with one click of 저장', async () => {
        await form.fillPolicySettings({ cycleType: 'WEEKLY', lag: '7' });
        await form.save();
        await form.confirmApplyNow();
      });

      await step('Assert: Expected 1 — The save succeeds', async () => {
        await expect(form.savedToast, '[Expected 1] Saved toast is shown').toBeVisible();
      });

      await step('Act: Step 2 — Open 변경 이력 (Change history) and count the new records', async () => {
        await form.openHistory();
      });

      await step('Assert: Expected 2 — Exactly one new record, stacking the changed fields in one cell', async () => {
        // Dialog chỉ hiện tối đa 100 bản ghi gần nhất (29/09: đã chạm trần 100) → đếm dòng không tăng được nữa; kiểm
        // "đúng 1 bản ghi mới" bằng vị trí: bản ghi mới nhất cũ giờ phải nằm ngay dòng thứ 2.
        const after = await form.getHistoryRecords();
        if (recordsBefore < 100) await expect(form.historyRows, '[Expected 2] The history gains exactly one record').toHaveCount(recordsBefore + 1);
        expect(JSON.stringify(after[1] ?? null), '[Expected 2] Exactly one new record sits above the previous newest').toBe(previousNewest);
        const newest = after[0];
        expect(newest.items, '[Expected 2] The record stacks 주기 유형').toContain('주기 유형');
        expect(newest.items, '[Expected 2] The record stacks 지연일수(일)').toContain('지연일수(일)');
        expect(newest.changes, '[Expected 2] The record carries DAILY → WEEKLY').toContain('DAILY → WEEKLY');
        expect(newest.changes, '[Expected 2] The record carries 5일 → 7일').toContain('5일 → 7일');
      });
    } finally {
      if (baseline) await restoreLiveRow(policyApi, baseline);
    }
  });

  test('TC_US080_063 — The Setting column shows the field name and never the change type', async ({ page, paymentMethodPolicyFormPage: form, policyApi }) => {
    const step = makeStep(page);
    await allure.description(
      `Open 변경 이력 on ${LIVE_KEY} (edited many times): every 항목 cell shows a business field name from the confirm-dialog ` +
        'dictionary (환율 적용 방식 · 주기 유형 · 기준 요일 · 지연일수(일)); no cell shows UPDATED, CREATED or another changeType. ' +
        'Deviation from TC: the column is titled 항목 on the UI (TC: 정책 설정). Read-only.',
    );
    await allure.severity('critical');
    await allure.tags('regression', 'ui', 'history', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_063');

    await step(`Arrange: Pre-condition 1–2 — ${LIVE_KEY} has been edited and carries UPDATED records`, async () => {
      const row = await liveRow(policyApi);
      expect(row.version, '[Pre-condition 2] The row has been edited').toBeGreaterThan(0);
      await form.open(row.id);
    });

    await step('Act: Step 1 — Click 변경 이력 (Change history) and read the 항목 (Setting) column', async () => {
      await form.openHistory();
    });

    await step('Assert: Expected 1 — Every cell shows a business field name, never a changeType', async () => {
      const items = (await form.getHistoryRecords()).flatMap((record) => record.items);
      expect(items.length, '[Expected 1] The column carries entries').toBeGreaterThan(0);
      for (const item of new Set(items)) {
        expect(HISTORY_FIELD_NAMES, `[Expected 1] "${item}" is a business field name`).toContain(item);
      }
      expect(items.filter((item) => /UPDATED|CREATED|REPLACEMENT|NEW|changeType/i.test(item)), '[Expected 1] No cell shows a changeType').toEqual([]);
    });
  });

  test('TC_US080_064 — Creating a row writes a baseline record that the dialog does not display', async ({
    page,
    paymentMethodPolicyFormPage: form,
    policyApi,
    approverPolicyApi,
  }) => {
    const step = makeStep(page);
    let created: PaymentMethodPolicy | undefined;
    let historyTotal = -1;
    await allure.description(
      'Create a policy for an unused key and let it go live (approved by the approver account via the API); its 변경 이력 ' +
        'dialog shows the empty state. Not automated: "the database holds a CREATED record" — there is no DB access and ' +
        'the history API filters CREATED records as well (observed: it returns an empty page); the test records that API ' +
        'result as evidence. Consumes the key permanently (BR-18).',
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'history', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_064');

    await step('Arrange: Pre-condition 1–2 — An unused key combination picked from the automation pool (consumed)', async () => {
      created = { ...(await pickUnusedKey(policyApi)) } as PaymentMethodPolicy;
    });

    await step(`Act: Step 1 — Create a policy row for ${formatChannelKey(created!)} and wait until it is live`, async () => {
      created = await createApprovedPolicy(policyApi, approverPolicyApi, {
        pgCode: created!.pgCode,
        paymentMethodCode: created!.paymentMethodCode,
        currency: created!.currency,
        fxSourceStrategy: 'ALREADY_KRW',
        cycleType: 'WEEKLY',
        cycleAnchorWeekday: 'WED',
        cycleLagDays: '5',
        changeReason: traceReason('TC_US080_064'),
      });
    });

    await step('Assert: Expected 1 — The row is created (live)', async () => {
      expect(created?.approval, '[Expected 1] The created row is live').toBe('ACTIVE');
    });

    await step('Act: Step 2 — Open 변경 이력 (Change history) for the row just created', async () => {
      await form.open(created!.id);
      await form.openHistory();
    });

    await step('Assert: Expected 2 — The dialog shows the empty state "아직 변경 이력이 없습니다"', async () => {
      await expect(form.historyEmptyTitle, '[Expected 2] Empty state is shown').toBeVisible();
      await expect(form.historyRows, '[Expected 2] No record row is rendered').toHaveCount(0);
    });

    await step("Act: Step 3 — Read that row's history records (history API — no direct database access)", async () => {
      historyTotal = ((await policyApi.getHistory(created!.id)).body as { totalElements: number }).totalElements;
    });

    await step('Assert: Expected 3 — Not automated: the CREATED record in the database (evidence: the API filters it too)', async () => {
      // Not automated: bản ghi CREATED trong DB — không có quyền truy cập DB, API history cũng lọc CREATED. Chỉ ghi nhận
      // kết quả API làm bằng chứng quan sát được.
      expect(historyTotal, '[Expected 3] (observable part) the history API exposes no record for a never-edited row').toBe(0);
    });
  });

  test('TC_US080_065 — The Reason column shows an em dash for records written before the field existed', async ({
    page,
    paymentMethodPolicyFormPage: form,
    policyApi,
  }) => {
    const step = makeStep(page);
    await allure.description(
      `Open 변경 이력 on ${LIVE_KEY}: its oldest records were written before 변경 사유 existed, and their reason cell shows an ` +
        'em dash "—" — no badge, no "not in model yet" label, no blank cell. Deviation from TC: the column is titled 사유 on ' +
        'the UI (TC: 이유). Read-only.',
    );
    await allure.severity('minor');
    await allure.tags('regression', 'ui', 'history', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_065');

    await step(`Arrange: Pre-condition 1–2 — ${LIVE_KEY} carries UPDATED records written before 변경 사유 existed`, async () => {
      await form.open((await liveRow(policyApi)).id);
    });

    await step('Act: Step 1 — Click 변경 이력 (Change history) and read the 사유 (Reason) column of the old record', async () => {
      await form.openHistory();
    });

    await step('Assert: Expected 1 — The old record\'s reason cell shows an em dash', async () => {
      const oldest = (await form.getHistoryRecords()).at(-1);
      expect(oldest, '[Expected 1] The row has an old record').toBeDefined();
      expect(oldest!.reason, '[Expected 1] The reason cell shows an em dash — not blank, no badge').toBe('—');
    });
  });
});
