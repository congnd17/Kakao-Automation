import { test, expect } from '@fixtures/base.fixture';
import { allure } from 'allure-playwright';
import { makeStep } from '@utils/step';
import { PaymentMethodPolicy } from '@api/payment-method-policy.api';
import { LIVE_ROW, SEED_ROW, formatChannelKey } from '@utils/payment-method-policy.data';

/**
 * Form 결제수단 정책 (US080) — hiển thị form tạo mới / form sửa, 2 nhánh dialog [M-CONFIRM], dialog [M-HISTORY].
 * Nguồn TC: input/Test_Cases_US080_EN_v1.md — mỗi dòng Steps N / Expected N map đúng 1 step `Act: Step N` /
 * `Assert: Expected N`. TC lệch UI thật → assert theo UI, ghi "Deviation from TC" trong description (quyết định 28/09).
 *
 * KHÔNG lưu gì: dòng seed SEED_ROW chỉ được mở, sửa trên form rồi đóng dialog bằng 뒤로 — không bấm 확인 및 저장 /
 * 승인 요청. TC_008 đọc lịch sử của LIVE_ROW (dòng automation sở hữu, đã sửa nhiều lần).
 */
const SEED_KEY = formatChannelKey(SEED_ROW);
const LIVE_KEY = formatChannelKey(LIVE_ROW);

test.describe('[UI] 결제수단 정책 form and dialogs', () => {
  test('TC_US080_005 — The create form renders every label, hint and default', async ({
    page,
    paymentMethodPolicyListPage: list,
    paymentMethodPolicyFormPage: form,
  }) => {
    const step = makeStep(page);
    await allure.description(
      'Click 정책 추가 on the list: the form opens in create mode; the 채널 키 panel holds the three empty key fields, ' +
        '환율 적용 방식 defaults to "이미 KRW — 환율 미적용", 정산 주기 to WEEKLY, 기준 요일 to WED, and 지연일수 carries its ' +
        'hint. Deviation from TC: the create form title on the UI is "신규 결제 채널" (TC: "정책 추가").',
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_005');

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN, UI in Korean, list open', async () => {
      await list.open();
    });

    await step('Act: Step 1 — Click 정책 추가 (Add policy) on the list screen', async () => {
      await list.openCreateForm();
    });

    await step('Assert: Expected 1 — The form opens in create mode with its title', async () => {
      await expect(page, '[Expected 1] The create form URL is open').toHaveURL(/\/payment-method-policies\/create$/);
      await expect(form.createTitle, '[Expected 1] Create form title "신규 결제 채널" is visible').toBeVisible();
    });

    await step('Act: Step 2 — Compare the label, hint text and default value of every field', async () => {
      await form.lagHint.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Key panel empty, policy defaults set, 지연일수 hint shown', async () => {
      await expect(form.channelKeyPanelTitle, '[Expected 2] 채널 키 (Channel key) panel is visible').toBeVisible();
      await expect(form.pgSelect, '[Expected 2] PG key field is empty').toHaveValue('');
      await expect(form.methodSelect, '[Expected 2] 결제수단 key field is empty').toHaveValue('');
      await expect(form.currencySelect, '[Expected 2] 거래금액 통화 key field is empty').toHaveValue('');
      await expect(form.strategySelect.locator('option:checked'), '[Expected 2] 환율 적용 방식 defaults to 이미 KRW — 환율 미적용').toHaveText(
        '이미 KRW — 환율 미적용',
      );
      await expect(form.cycleTypeSelect, '[Expected 2] 정산 주기 defaults to WEEKLY').toHaveValue('WEEKLY');
      await expect(form.anchorSelect, '[Expected 2] 기준 요일 defaults to WED').toHaveValue('WED');
      await expect(form.lagHint, '[Expected 2] 지연일수 carries its hint text').toBeVisible();
    });
  });

  test('TC_US080_006 — The edit form renders the channel key as plain text', async ({
    page,
    paymentMethodPolicyListPage: list,
    paymentMethodPolicyFormPage: form,
    policyApi,
  }) => {
    const step = makeStep(page);
    await allure.description(
      `Open the never-edited seed row ${SEED_KEY}: the form opens straight into edit mode with the values pre-filled, ` +
        'and the three key fields render as plain text — no input, no required *, no dropdown — with the lock ' +
        `message. Deviation from TC: the edit form title on the UI is "결제 채널 ${SEED_KEY}" (TC: "정책 수정"). ` +
        'Read-only — nothing is saved.',
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_006');

    let seed: PaymentMethodPolicy | undefined;

    await step(`Arrange: Pre-condition 1–2 — Logged in as ADMIN, seed row ${SEED_KEY} never edited (ALREADY_KRW · DAILY · lag 5)`, async () => {
      seed = (await policyApi.getByKey(SEED_ROW)).body.holder;
      expect(seed?.version, '[Pre-condition 2] Seed row has never been edited').toBe(0);
      await list.open();
      await list.searchKey(SEED_ROW.pgCode, SEED_ROW.paymentMethodCode, SEED_ROW.currency);
    });

    await step(`Act: Step 1 — Click the ${SEED_KEY} row`, async () => {
      await list.openRow(SEED_ROW.pgCode, SEED_ROW.paymentMethodCode, SEED_ROW.currency);
    });

    await step('Assert: Expected 1 — The form opens in edit mode with its title and the values pre-filled', async () => {
      await expect(form.editTitle(SEED_KEY), `[Expected 1] Edit form title "결제 채널 ${SEED_KEY}" is visible`).toBeVisible();
      await expect(form.strategySelect, `[Expected 1] 환율 적용 방식 is pre-filled with ${seed!.fxSourceStrategy}`).toHaveValue(seed!.fxSourceStrategy);
      await expect(form.cycleTypeSelect, `[Expected 1] 정산 주기 is pre-filled with ${seed!.cycleType}`).toHaveValue(seed!.cycleType);
      await expect(form.lagInput, `[Expected 1] 지연일수 is pre-filled with ${seed!.cycleLagDays}`).toHaveValue(String(seed!.cycleLagDays));
    });

    await step('Act: Step 2 — Inspect the 채널 키 (Channel key) panel', async () => {
      await form.channelKeyPanelTitle.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — The three key fields are plain text with no *, no dropdown, plus the lock message', async () => {
      const keyFields: Array<[string, string]> = [
        ['PG', SEED_ROW.pgCode],
        ['결제수단', SEED_ROW.paymentMethodCode],
        ['거래금액 통화', SEED_ROW.currency],
      ];
      for (const [label, value] of keyFields) {
        await expect(form.keyPlainValue(label), `[Expected 2] ${label} renders as plain text "${value}"`).toHaveText(value);
        await expect(form.requiredMarker(label), `[Expected 2] ${label} carries no required * marker`).toHaveCount(0);
      }
      await expect(form.pgSelect, '[Expected 2] PG has no openable dropdown').toHaveCount(0);
      await expect(form.methodSelect, '[Expected 2] 결제수단 has no openable dropdown').toHaveCount(0);
      await expect(form.currencySelect, '[Expected 2] 거래금액 통화 has no openable dropdown').toHaveCount(0);
      await expect(form.channelKeyLockedHint, '[Expected 2] The key-lock message is shown').toBeVisible();
    });
  });

  test('TC_US080_007 — [M-CONFIRM] renders both the apply branch and the approval branch', async ({
    page,
    paymentMethodPolicyFormPage: form,
    policyApi,
  }) => {
    const step = makeStep(page);
    await allure.description(
      `On the never-edited seed row ${SEED_KEY}: changing 지연일수 5 → 7 opens "이 변경을 적용할까요?" with one 변경 내용 ` +
        'line; 뒤로 closes it and keeps 7 in the field; then changing 환율 적용 방식 to 정산환율 opens "승인을 요청할까요?" ' +
        'with a 변경 사유 input. Deviation from TC: the 변경 내용 line reads "지연일수(일) 5일 → 7일" (label and values carry the ' +
        '(일)/일 unit). Nothing is saved — each dialog is closed with 뒤로.',
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_007');

    let seed: PaymentMethodPolicy | undefined;
    const lagLine = form.confirmChangeLine('지연일수\\(일\\)');

    await step(`Arrange: Pre-condition 1–2 — Logged in as ADMIN, seed row ${SEED_KEY} never edited`, async () => {
      seed = (await policyApi.getByKey(SEED_ROW)).body.holder;
      expect(seed?.version, '[Pre-condition 2] Seed row has never been edited').toBe(0);
      expect(seed?.cycleLagDays, '[Pre-condition 2] Seed row 지연일수 is 5').toBe(5);
    });

    await step('Act: Step 1 — Open that row, change 지연일수 (Lag) from 5 to 7 and click 저장 (Save)', async () => {
      await form.open(seed!.id);
      await form.fillPolicySettings({ lag: '7' });
      await form.save();
    });

    await step('Assert: Expected 1 — "이 변경을 적용할까요?" with one 변경 내용 line for 지연일수 5 → 7', async () => {
      await expect(form.confirmDialogTitle, '[Expected 1] Dialog title is 이 변경을 적용할까요? (Apply this change?)').toHaveText('이 변경을 적용할까요?');
      await expect(form.confirmDialog.locator('div:has(> s)'), '[Expected 1] 변경 내용 block lists exactly one line').toHaveCount(1);
      await expect(lagLine.line, '[Expected 1] The line is for 지연일수(일)').toHaveCount(1);
      await expect(lagLine.oldValue, '[Expected 1] Old value is 5일').toHaveText('5일');
      await expect(lagLine.newValue, '[Expected 1] New value is 7일').toHaveText('7일');
    });

    await step('Act: Step 2 — Click 뒤로 (Back) on the dialog', async () => {
      await form.backFromDialog();
    });

    await step('Assert: Expected 2 — The dialog closes, returning to the form', async () => {
      await expect(form.confirmDialog, '[Expected 2] The confirm dialog is closed').toBeHidden();
      await expect(form.lagInput, '[Expected 2] The edit form is shown again').toBeVisible();
    });

    let lagAfterBack = '';
    await step('Act: Step 3 — Read the 지연일수 (Lag) field on the form', async () => {
      lagAfterBack = await form.lagInput.inputValue();
    });

    await step('Assert: Expected 3 — 지연일수 still reads 7', async () => {
      expect(lagAfterBack, '[Expected 3] 지연일수 keeps 7 after 뒤로 — the value is not lost').toBe('7');
    });

    await step('Act: Step 4 — Change 환율 적용 방식 (FX source strategy) to 정산환율 and click 저장 (Save)', async () => {
      await form.fillPolicySettings({ strategy: 'BANK_SETTLEMENT_RATE' });
      await form.save();
    });

    await step('Assert: Expected 4 — "승인을 요청할까요?" with a 변경 사유 (Reason) input', async () => {
      await expect(form.confirmDialogTitle, '[Expected 4] Dialog title is 승인을 요청할까요? (Send for approval?)').toHaveText('승인을 요청할까요?');
      await expect(form.changeReasonLabel, '[Expected 4] 변경 사유 (Reason for this change) label is visible').toContainText('변경 사유');
      await expect(form.changeReasonInput, '[Expected 4] 변경 사유 input is visible').toBeVisible();
      await form.backFromDialog();
    });
  });

  test('TC_US080_008 — [M-HISTORY] renders the shared five-column shape', async ({
    page,
    paymentMethodPolicyFormPage: form,
    policyApi,
  }) => {
    const step = makeStep(page);
    await allure.description(
      `Open 변경 이력 on ${LIVE_KEY} (edited many times, carries UPDATED records): the dialog has exactly five columns ` +
        'in order with the newest record on top; 닫기 closes it leaving the form unchanged. Deviation from TC: the five ' +
        'columns on the UI are 일시 · 변경자 · 항목 · 변경 내용 · 사유 (TC: 시각 · 변경자 · 정책 설정 · 변경 내용 · 이유).',
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_008');

    let row: PaymentMethodPolicy | undefined;
    let formUrl = '';
    let lagBefore = '';

    await step(`Arrange: Pre-condition 1–2 — Logged in as ADMIN, ${LIVE_KEY} already edited, its form open`, async () => {
      row = (await policyApi.getByKey(LIVE_ROW)).body.holder;
      expect(row!.version, '[Pre-condition 2] The row has been edited at least once').toBeGreaterThan(0);
      await form.open(row!.id);
      formUrl = page.url();
      lagBefore = await form.lagInput.inputValue();
    });

    await step('Act: Step 1 — Open that row and click 변경 이력 (Change history)', async () => {
      await form.openHistory();
    });

    await step('Assert: Expected 1 — Exactly five columns in order; the newest record is on top', async () => {
      const headers = form.historyTable.locator('thead th');
      await expect(headers, '[Expected 1] The dialog has exactly five columns').toHaveCount(5);
      for (const [index, name] of ['일시', '변경자', '항목', '변경 내용', '사유'].entries()) {
        await expect(headers.nth(index), `[Expected 1] Column ${index + 1} is ${name}`).toHaveText(name);
      }
      const times = (await form.getHistoryRecords()).map((record) => record.when);
      expect(times.length, '[Expected 1] The row carries history records').toBeGreaterThan(0);
      expect(times, '[Expected 1] Records are ordered newest first').toEqual([...times].sort().reverse());
    });

    await step('Act: Step 2 — Click 닫기 (Close)', async () => {
      await form.closeHistory();
    });

    await step('Assert: Expected 2 — The dialog closes; the background form and its values are unchanged', async () => {
      await expect(form.historyDialog, '[Expected 2] 변경 이력 dialog is closed').toBeHidden();
      expect(page.url(), '[Expected 2] URL is unchanged').toBe(formUrl);
      await expect(form.lagInput, '[Expected 2] 지연일수 on the form is unchanged').toHaveValue(lagBefore);
    });
  });
});
