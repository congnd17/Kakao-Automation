import { test, expect } from '@fixtures/base.fixture';
import { allure } from 'allure-playwright';
import { makeStep } from '@utils/step';
import { Observations } from '@utils/observations';
import { ChannelKey, PaymentMethodPolicy } from '@api/payment-method-policy.api';
import {
  MSG_DUPLICATE_SUFFIX,
  createApprovedPolicy,
  formatChannelKey,
  pickPairWithFreeCurrency,
  pickUnusedKey,
  traceReason,
  withdrawPendingCreate,
} from '@utils/payment-method-policy.data';

/**
 * Form tạo mới 결제수단 정책 (US080). Nguồn TC: input/Test_Cases_US080_EN_v1.md — mỗi dòng Steps N / Expected N map
 * đúng 1 step `Act: Step N` / `Assert: Expected N`. TC lệch UI thật → assert theo UI, ghi "Deviation from TC" trong
 * description (quyết định 28/09).
 *
 * Dữ liệu: register dùng chung KHÔNG có xoá (BR-18) → key TC ghi cứng (EXIMBAY·PAYPAL·JPY, GOOGLE_PLAY·GOOGLE_PLAY·KRW,
 * EXIMBAY·CREDIT_CARD_GLOBAL·JPY) đã bị các lần chạy trước chiếm; test chọn key trống trong pool automation (PG
 * GOOGLE_PLAY/APP_STORE, "inert" theo TC_028). TC_023/024/028/035 tiêu thụ vĩnh viễn 1 key mỗi lần chạy; request tạo mới
 * còn treo được 회수 ở teardown. Các TC khác chỉ điền form rồi rời đi, không lưu.
 */
const DUPLICATE_KEY: ChannelKey = { pgCode: 'EXIMBAY', paymentMethodCode: 'CREDIT_CARD_GLOBAL', currency: 'KRW' };
const MSG_INVALID_LAG = '0 이상의 정수(일)를 입력하세요.';
const DEVIATION_PG_LABEL = 'the PG key field is labelled "PG" on the UI, not "결제관리"';
const DEVIATION_LAG_DEFAULT =
  '지연일수 has no default on the create form (empty, placeholder 0) and 저장 stays disabled until it holds a valid ' +
  'value — the test enters 5';
const DEVIATION_CONFIRM =
  'creating a row opens "승인을 요청할까요?" whose 변경 사유 input and 승인 요청 button replace the TC\'s "enter a reason, ' +
  '저장, then 확인 및 저장"';
const asForm = (key: ChannelKey) => ({ pg: key.pgCode, method: key.paymentMethodCode, currency: key.currency });

test.describe('[Create] 결제수단 정책 create form', () => {
  test('TC_US080_023 — A policy row is created for a channel that has none', async ({
    page,
    paymentMethodPolicyListPage: list,
    paymentMethodPolicyFormPage: form,
    policyApi,
  }) => {
    const step = makeStep(page);
    let key: ChannelKey = DUPLICATE_KEY;
    let submitStatus = 0;
    let created: PaymentMethodPolicy | undefined;

    await allure.severity('blocker');
    await allure.tags('regression', 'ui', 'create', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_023');

    try {
      await step('Arrange: Pre-condition 1–3 — Logged in as ADMIN, an unused key combination picked from the automation pool', async () => {
        key = await pickUnusedKey(policyApi);
        await allure.description(
          `Create a policy for ${formatChannelKey(key)}, a key that has no row: the form opens empty, the three key ` +
            'fields take their values with no duplicate message, and the create request enters the approval queue (not ' +
            `live). Consumes the key permanently (BR-18). Deviation from TC: EXIMBAY · PAYPAL · JPY is already taken, so an ` +
            `unused automation-pool key is used; ${DEVIATION_PG_LABEL}; ${DEVIATION_LAG_DEFAULT}; ${DEVIATION_CONFIRM}.`,
        );
        await list.open();
      });

      await step('Act: Step 1 — Click 정책 추가 (Add policy)', async () => {
        await list.openCreateForm();
      });

      await step('Assert: Expected 1 — The form opens in create mode with the three key fields empty', async () => {
        await expect(form.createTitle, '[Expected 1] Create form is open').toBeVisible();
        await expect(form.pgSelect, '[Expected 1] PG is empty').toHaveValue('');
        await expect(form.methodSelect, '[Expected 1] 결제수단 is empty').toHaveValue('');
        await expect(form.currencySelect, '[Expected 1] 거래금액 통화 is empty').toHaveValue('');
      });

      await step(`Act: Step 2 — Set PG, 결제수단, 거래금액 통화 to ${formatChannelKey(key)}`, async () => {
        await form.fillChannelKey(asForm(key));
      });

      await step('Assert: Expected 2 — All three fields take their value; no duplicate-key message', async () => {
        await expect(form.pgSelect, `[Expected 2] PG takes ${key.pgCode}`).toHaveValue(key.pgCode);
        await expect(form.methodSelect, `[Expected 2] 결제수단 takes ${key.paymentMethodCode}`).toHaveValue(key.paymentMethodCode);
        await expect(form.currencySelect, `[Expected 2] 거래금액 통화 takes ${key.currency}`).toHaveValue(key.currency);
        await expect(form.duplicateKeyMessage, '[Expected 2] No duplicate-key message appears').toHaveCount(0);
      });

      await step('Act: Step 3 — Keep the defaults, enter 지연일수, click 저장, enter 변경 사유 and click 승인 요청', async () => {
        await form.fillPolicySettings({ lag: '5' });
        await form.save();
        submitStatus = await form.submitForApproval(traceReason('TC_US080_023'));
        created = (await policyApi.getByKey(key)).body.holder;
      });

      await step('Assert: Expected 3 — The create request is recorded and awaits approval (not live yet)', async () => {
        expect(submitStatus, '[Expected 3] The create request is accepted by the server').toBeLessThan(300);
        expect(created, `[Expected 3] ${formatChannelKey(key)} is now recorded in the register`).toBeDefined();
        expect(created?.approval, '[Expected 3] The new row awaits approval').toBe('PENDING');
        expect(created?.pending?.changeType, '[Expected 3] The pending request is a create (NEW)').toBe('NEW');
      });
    } finally {
      if (key !== DUPLICATE_KEY) await withdrawPendingCreate(policyApi, key);
    }
  });

  test('TC_US080_024 — A created row appears in the list with the entered values and reopens identically', async ({
    page,
    paymentMethodPolicyListPage: list,
    paymentMethodPolicyFormPage: form,
    policyApi,
    approverPolicyApi,
  }) => {
    const step = makeStep(page);
    const entered = { fxSourceStrategy: 'BANK_SETTLEMENT_RATE', cycleType: 'DAILY', cycleAnchorWeekday: null, cycleLagDays: '12' } as const;
    let key: ChannelKey = DUPLICATE_KEY;
    let row: PaymentMethodPolicy | undefined;

    await allure.severity('critical');
    await allure.tags('regression', 'ui', 'create', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_024');

    await step('Arrange: Pre-condition 1–3 — An unused key is created via API and approved by the approver account (live row)', async () => {
      key = await pickUnusedKey(policyApi);
      await allure.description(
        `${formatChannelKey(key)} is created (정산환율 · DAILY · lag 12) and approved by the approver account via the API, ` +
          'so the row is live. On the list the row shows the three key values, 정산환율 and the cycle "DAILY · — · lag ' +
          '12d"; opening it shows every field exactly as entered. Consumes the key permanently (BR-18).',
      );
      row = await createApprovedPolicy(policyApi, approverPolicyApi, { ...key, ...entered, changeReason: traceReason('TC_US080_024') });
      expect(row.approval, '[Pre-condition 2] The created row is live after approval').toBe('ACTIVE');
      await list.open();
    });

    await step(`Act: Step 1 — Find the row just created (${formatChannelKey(key)}) on the list`, async () => {
      await list.searchKey(key.pgCode, key.paymentMethodCode, key.currency);
    });

    await step('Assert: Expected 1 — The row shows the key values, 환율 적용 방식 and the cycle phrase as chosen', async () => {
      const listRow = list.rowByKey(key.pgCode, key.paymentMethodCode, key.currency);
      await expect(listRow, '[Expected 1] The created row appears in the table').toHaveCount(1);
      await expect(listRow.locator('td:nth-child(4)'), '[Expected 1] 환율 적용 방식 is 정산환율').toContainText('정산환율');
      await expect(listRow.locator('td:nth-child(5)'), '[Expected 1] Cycle phrase is DAILY · — · lag 12d').toContainText('DAILY · — · lag 12d');
    });

    await step('Act: Step 2 — Click that row and compare every value against what was entered', async () => {
      await list.openRow(key.pgCode, key.paymentMethodCode, key.currency);
    });

    await step('Assert: Expected 2 — Every field of the edit form matches the entered value one for one', async () => {
      await expect(form.keyPlainValue('PG'), `[Expected 2] PG is ${key.pgCode}`).toHaveText(key.pgCode);
      await expect(form.keyPlainValue('결제수단'), `[Expected 2] 결제수단 is ${key.paymentMethodCode}`).toHaveText(key.paymentMethodCode);
      await expect(form.keyPlainValue('거래금액 통화'), `[Expected 2] 거래금액 통화 is ${key.currency}`).toHaveText(key.currency);
      await expect(form.strategySelect, '[Expected 2] 환율 적용 방식 is BANK_SETTLEMENT_RATE').toHaveValue(entered.fxSourceStrategy);
      await expect(form.cycleTypeSelect, '[Expected 2] 정산 주기 is DAILY').toHaveValue(entered.cycleType);
      await expect(form.anchorSelect, '[Expected 2] 기준 요일 is absent for DAILY').toHaveCount(0);
      await expect(form.lagInput, '[Expected 2] 지연일수 is 12').toHaveValue(entered.cycleLagDays);
    });
  });

  test('TC_US080_025 — A duplicate key is reported inline as soon as the three key fields are complete', async ({
    page,
    paymentMethodPolicyListPage: list,
    paymentMethodPolicyFormPage: form,
    policyApi,
  }) => {
    const step = makeStep(page);
    const expectedMessage = `${formatChannelKey(DUPLICATE_KEY)} ${MSG_DUPLICATE_SUFFIX}`;
    await allure.description(
      `On the create form choose ${formatChannelKey(DUPLICATE_KEY)}, a key that already exists: the moment the third key ` +
        'field takes a value (without clicking 저장) the duplicate message appears inline with the three values filled ' +
        'in, it does not auto-dismiss (still shown 5 s later) and 저장 stays disabled. Read-only — nothing is saved. ' +
        `Deviation from TC: ${DEVIATION_PG_LABEL}; 지연일수 is filled first so that only the duplicate can keep 저장 disabled.`,
    );
    await allure.severity('blocker');
    await allure.tags('regression', 'ui', 'create', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_025');

    await step(`Arrange: Pre-condition 1–2 — Logged in as ADMIN, ${formatChannelKey(DUPLICATE_KEY)} already exists`, async () => {
      expect((await policyApi.getByKey(DUPLICATE_KEY)).body.taken, `[Pre-condition 2] ${formatChannelKey(DUPLICATE_KEY)} exists`).toBe(true);
      await list.open();
    });

    await step('Act: Step 1 — Click 정책 추가 (Add policy)', async () => {
      await list.openCreateForm();
    });

    await step('Assert: Expected 1 — The form opens in create mode with 저장 disabled', async () => {
      await expect(form.createTitle, '[Expected 1] Create form is open').toBeVisible();
      await expect(form.saveButton, '[Expected 1] 저장 (Save) is disabled').toBeDisabled();
    });

    await step(`Act: Step 2 — Set PG, 결제수단, then 거래금액 통화 to ${formatChannelKey(DUPLICATE_KEY)}`, async () => {
      await form.fillPolicySettings({ lag: '5' });
      await form.fillChannelKey(asForm(DUPLICATE_KEY));
    });

    await step('Assert: Expected 2 — The duplicate message appears inline, does not auto-dismiss, 저장 stays disabled', async () => {
      await expect(form.duplicateKeyMessage, `[Expected 2] Inline message is "${expectedMessage}"`).toHaveText(expectedMessage);
      const autoDismissed = await expect(form.duplicateKeyMessage)
        .toBeHidden({ timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      expect(autoDismissed, '[Expected 2] The message does not auto-dismiss within 5 s').toBe(false);
      await expect(form.saveButton, '[Expected 2] 저장 (Save) stays disabled').toBeDisabled();
    });
  });

  test('TC_US080_026 — The duplicate message clears when a key field is changed to a free combination', async ({
    page,
    paymentMethodPolicyFormPage: form,
    policyApi,
  }) => {
    const step = makeStep(page);
    let pair = { taken: DUPLICATE_KEY, free: DUPLICATE_KEY, existingCount: 0 };
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'create', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_026');

    await step('Arrange: Pre-condition 1–2 — A PG × 결제수단 pair with one taken and one free currency picked via API', async () => {
      pair = await pickPairWithFreeCurrency(policyApi);
      await allure.description(
        `Choose the taken key ${formatChannelKey(pair.taken)} so the duplicate message appears (저장 disabled), then change ` +
          `거래금액 통화 to ${pair.free.currency}: the message disappears on that same interaction and 저장 becomes enabled. ` +
          'Read-only — nothing is saved. Deviation from TC: EXIMBAY · CREDIT_CARD_GLOBAL · JPY is already taken (no free ' +
          `currency left for that pair), so a pair from the automation pool is used; ${DEVIATION_LAG_DEFAULT}.`,
      );
      await form.openCreate();
      await form.fillPolicySettings({ lag: '5' });
    });

    await step(`Act: Step 1 — On the create form choose ${formatChannelKey(pair.taken)}`, async () => {
      await form.fillChannelKey(asForm(pair.taken));
    });

    await step('Assert: Expected 1 — The duplicate message appears inline and 저장 is disabled', async () => {
      await expect(form.duplicateKeyMessage, '[Expected 1] Duplicate message names the taken key').toHaveText(
        `${formatChannelKey(pair.taken)} ${MSG_DUPLICATE_SUFFIX}`,
      );
      await expect(form.saveButton, '[Expected 1] 저장 (Save) is disabled').toBeDisabled();
    });

    await step(`Act: Step 2 — Change 거래금액 통화 (Transaction currency) to ${pair.free.currency}`, async () => {
      await form.selectCurrencyAndAwaitKeyCheck(pair.free.currency);
    });

    await step('Assert: Expected 2 — The message disappears immediately and 저장 becomes enabled', async () => {
      await expect(form.duplicateKeyMessage, '[Expected 2] The duplicate message has disappeared').toHaveCount(0);
      await expect(form.saveButton, '[Expected 2] 저장 (Save) is enabled again').toBeEnabled();
    });
  });

  test('TC_US080_027 — Save stays disabled while any mandatory key field is empty', async ({ page, paymentMethodPolicyFormPage: form, policyApi }) => {
    const step = makeStep(page);
    const observations = new Observations(page);
    const writes: string[] = [];
    let freeKey: ChannelKey = DUPLICATE_KEY;
    page.on('request', (request) => {
      if (request.method() !== 'GET' && request.url().includes('/payment-method-policies')) writes.push(`${request.method()} ${request.url()}`);
    });
    await allure.description(
      'With the key fields empty, clicking the disabled 저장 does nothing (no request, no dialog); filling the key fields ' +
        'one at a time, 저장 stays disabled on every pass where one field is left empty. Deviation from TC: the UI shows ' +
        'no "필수 입력 항목입니다." message and does not mark the empty field — mandatory fields are flagged only by the ' +
        'required * in their label, and the only reaction to a missing field is the disabled 저장. Read-only.',
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'create', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_027');

    await step('Arrange: Pre-condition 1 — Logged in as ADMIN, create form open, 지연일수 filled', async () => {
      freeKey = await pickUnusedKey(policyApi);
      await form.openCreate();
      await form.fillPolicySettings({ lag: '5' });
    });

    await step('Act: Step 1 — Leave all three key fields empty and click the disabled 저장 (Save)', async () => {
      await form.saveButton.click({ force: true });
    });

    await step('Assert: Expected 1 — 저장 is disabled: no request, no dialog; the key fields carry the required *', async () => {
      await expect(form.saveButton, '[Expected 1] 저장 (Save) is disabled').toBeDisabled();
      await expect(form.confirmDialog, '[Expected 1] No dialog opens').toHaveCount(0);
      expect(writes, '[Expected 1] No request is sent').toEqual([]);
      for (const label of ['PG', '결제수단', '거래금액 통화']) {
        await expect(form.requiredMarker(label), `[Expected 1] ${label} is marked mandatory (*)`).toHaveCount(1);
      }
    });

    await step('Act: Step 2 — Fill the key fields one at a time, each time leaving exactly one empty, and click 저장', async () => {
      const fields = [
        { name: 'PG', select: form.pgSelect, value: freeKey.pgCode },
        { name: '결제수단', select: form.methodSelect, value: freeKey.paymentMethodCode },
        { name: '거래금액 통화', select: form.currencySelect, value: freeKey.currency },
      ];
      for (const left of fields) {
        for (const field of fields) await field.select.selectOption(field === left ? '' : field.value);
        await form.saveButton.click({ force: true });
        await observations.record(`[Expected 2] ${left.name} left empty: 저장 stays disabled`, () => form.saveButton.isDisabled());
        await observations.record(`[Expected 2] ${left.name} left empty: no dialog opens`, async () => (await form.confirmDialog.count()) === 0);
        await observations.record(`[Expected 2] ${left.name} left empty: the field is still empty`, async () => (await left.select.inputValue()) === '');
        await observations.screenshot(`${left.name} left empty`);
      }
      await observations.record('[Expected 2] No request was sent on any pass', async () => writes.length === 0);
    });

    await step('Assert: Expected 2 — On each pass exactly the field left empty keeps 저장 disabled', async () => {
      observations.assertAll();
    });
  });

  test('TC_US080_028 — An unused-but-valid key combination is created without a scope error', async ({
    page,
    paymentMethodPolicyFormPage: form,
    policyApi,
  }) => {
    const step = makeStep(page);
    let key: ChannelKey = DUPLICATE_KEY;
    let submitStatus = 0;
    let created: PaymentMethodPolicy | undefined;
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'create', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_028');

    try {
      await step('Arrange: Pre-condition 1–3 — An unused in-app (inert) key picked from the automation pool, create form open', async () => {
        key = await pickUnusedKey(policyApi);
        await allure.description(
          `Create ${formatChannelKey(key)} — an in-app channel that produces no statement lines, so the row is inert but ` +
            'still valid: the create request is recorded normally with no error about scope or a "meaningless ' +
            'combination". Consumes the key permanently (BR-18). Deviation from TC: GOOGLE_PLAY · GOOGLE_PLAY · KRW is ' +
            `already taken, so an unused inert key from the pool is used; ${DEVIATION_LAG_DEFAULT}; ${DEVIATION_CONFIRM}.`,
        );
        await form.openCreate();
      });

      await step(`Act: Step 1 — Choose ${formatChannelKey(key)}, enter 변경 사유 and submit (저장 → 승인 요청)`, async () => {
        await form.fillChannelKey(asForm(key));
        await form.fillPolicySettings({ lag: '5' });
        await form.save();
        submitStatus = await form.submitForApproval(traceReason('TC_US080_028'));
        created = (await policyApi.getByKey(key)).body.holder;
      });

      await step('Assert: Expected 1 — The create request is recorded normally, with no scope error', async () => {
        expect(submitStatus, '[Expected 1] The create request is accepted by the server').toBeLessThan(300);
        expect(created?.pending?.changeType, `[Expected 1] ${formatChannelKey(key)} is recorded as a create awaiting approval`).toBe('NEW');
        // Không dùng chữ "범위": hint tĩnh dưới trường PG ("…프로젝트 범위 밖이므로…") luôn chứa nó → khớp nhầm thành lỗi.
        await expect(page.locator('.invalid-feedback').filter({ hasText: /\S/ }), '[Expected 1] No field error is shown').toHaveCount(0);
        await expect(page.getByText(/scope|meaningless|의미 없는/i), '[Expected 1] No scope / meaningless-combination error is shown').toHaveCount(0);
      });
    } finally {
      if (key !== DUPLICATE_KEY) await withdrawPendingCreate(policyApi, key);
    }
  });

  test('TC_US080_029 — Back to list leaves the form without saving and without a confirmation prompt', async ({
    page,
    paymentMethodPolicyListPage: list,
    paymentMethodPolicyFormPage: form,
    policyApi,
  }) => {
    const step = makeStep(page);
    let freeKey: ChannelKey = DUPLICATE_KEY;
    let dialogShown = false;
    page.on('dialog', async (dialog) => {
      dialogShown = true;
      await dialog.dismiss();
    });
    await allure.description(
      'From the list with PG = EXIMBAY applied, open 정책 추가, fill an unused key (저장 becomes enabled), then click ' +
        '목록으로: the list returns immediately with no confirmation prompt, no 취소 button exists on the form, and the ' +
        'register has no new row. Deviation from TC: back on the list the filters are reset to 전체 (the UI does not ' +
        `preserve the EXIMBAY filter; page 1 is shown); ${DEVIATION_PG_LABEL}; ${DEVIATION_LAG_DEFAULT}.`,
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'create', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_029');

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN, list open with PG = EXIMBAY applied on page 1', async () => {
      freeKey = await pickUnusedKey(policyApi);
      await list.open();
      await list.fillFilters({ pg: 'EXIMBAY' });
      await list.clickSearch();
    });

    await step(`Act: Step 1 — Click 정책 추가 and fill the three key fields with the unused key ${formatChannelKey(freeKey)}`, async () => {
      await list.openCreateForm();
      await form.fillPolicySettings({ lag: '5' });
      await form.fillChannelKey(asForm(freeKey));
    });

    await step('Assert: Expected 1 — The form takes all three key values and 저장 becomes enabled', async () => {
      await expect(form.pgSelect, `[Expected 1] PG takes ${freeKey.pgCode}`).toHaveValue(freeKey.pgCode);
      await expect(form.methodSelect, `[Expected 1] 결제수단 takes ${freeKey.paymentMethodCode}`).toHaveValue(freeKey.paymentMethodCode);
      await expect(form.currencySelect, `[Expected 1] 거래금액 통화 takes ${freeKey.currency}`).toHaveValue(freeKey.currency);
      await expect(form.saveButton, '[Expected 1] 저장 (Save) is enabled').toBeEnabled();
      await expect(form.cancelButton, '[Expected 1] No 취소 (Cancel) button exists on the form').toHaveCount(0);
    });

    await step('Act: Step 2 — Click 목록으로 (Back to list)', async () => {
      await list.reloadingList(() => form.backToList());
    });

    await step('Assert: Expected 2 — The list returns immediately with no prompt; no new row is registered', async () => {
      await expect(page, '[Expected 2] The list screen is shown again').toHaveURL(/\/payment-method-policies$/);
      expect(dialogShown, '[Expected 2] No confirmation prompt appeared').toBe(false);
      await expect(form.confirmDialog, '[Expected 2] No confirmation dialog appeared').toHaveCount(0);
      await expect(list.pgFilterSelect, '[Expected 2] PG filter is reset to 전체 (UI behaviour, see description)').toHaveValue('');
      await expect.poll(() => list.isOnFirstPage(), { message: '[Expected 2] The list is on page 1' }).toBe(true);
      expect((await policyApi.getByKey(freeKey)).body.taken, `[Expected 2] ${formatChannelKey(freeKey)} was not created`).toBe(false);
    });
  });

  test('TC_US080_030 — Lag accepts 0, 14, 21, 999 and a value with surrounding spaces', async ({ page, paymentMethodPolicyFormPage: form, policyApi }) => {
    const step = makeStep(page);
    const acceptance = new Observations(page);
    const states = new Observations(page);
    const values = ['0', '14', '21', '999', ' 14 '];
    await allure.description(
      'With an unused key on the create form, enter 지연일수 = 0, 14, 21, 999 and " 14 " in turn: every value is accepted — ' +
        'the input is not marked in error, no message appears and 저장 is enabled. Deviation from TC: the field has ' +
        'maxlength=3, so " 14 " is cut to " 14" as it is entered; that value is accepted. Read-only — nothing is saved.',
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'create', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_030');

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN, create form open with an unused key combination', async () => {
      const freeKey = await pickUnusedKey(policyApi);
      await form.openCreate();
      await form.fillPolicySettings({ lag: '5' });
      await form.fillChannelKey(asForm(freeKey));
    });

    await step('Act: Step 1 — Enter 지연일수 = 0, 14, 21, 999 and " 14 " in turn', async () => {
      for (const value of values) {
        await form.fillPolicySettings({ lag: value });
        await form.lagInput.blur();
        await acceptance.record(`[Expected 1] "${value}" is accepted (not marked in error)`, async () => !(await form.lagInput.evaluate((el) => el.classList.contains('is-invalid'))));
      }
    });

    await step('Assert: Expected 1 — All five values are accepted', async () => {
      acceptance.assertAll();
    });

    await step('Act: Step 2 — After each value, read the state of 저장 (Save) and of the input', async () => {
      for (const value of values) {
        await form.fillPolicySettings({ lag: value });
        await form.lagInput.blur();
        await states.record(`[Expected 2] "${value}": no error message`, async () => ((await form.lagError.textContent()) ?? '').trim() === '');
        await states.record(`[Expected 2] "${value}": 저장 is enabled`, () => form.saveButton.isEnabled());
      }
      await states.record('[Expected 2] " 14 " is kept as " 14" by maxlength=3 and accepted', async () => (await form.lagInput.inputValue()) === ' 14');
    });

    await step('Assert: Expected 2 — After each value: no error, no message and 저장 is enabled', async () => {
      states.assertAll();
    });
  });

  test('TC_US080_031 — Lag rejects -1, 3.5, abc and empty on the client tier', async ({ page, paymentMethodPolicyFormPage: form, policyApi }) => {
    const step = makeStep(page);
    const rejection = new Observations(page);
    const states = new Observations(page);
    const values = ['-1', '3.5', 'abc', ''];
    let typed = '';
    await allure.description(
      'With an unused key on the create form, enter 지연일수 = -1, 3.5, abc, then clear it: no value is accepted — each is ' +
        'marked in error with "0 이상의 정수(일)를 입력하세요." and 저장 is disabled; typing 1000 keeps only 3 digits. ' +
        'Deviation from TC: for the cleared field the UI shows no message and no error mark — only 저장 is disabled. ' +
        'Read-only — nothing is saved.',
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'create', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_031');

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN, create form open with an unused key combination', async () => {
      const freeKey = await pickUnusedKey(policyApi);
      await form.openCreate();
      await form.fillPolicySettings({ lag: '5' });
      await form.fillChannelKey(asForm(freeKey));
    });

    await step('Act: Step 1 — Enter 지연일수 = -1, 3.5, abc in turn, then clear the field', async () => {
      for (const value of values) {
        await form.fillPolicySettings({ lag: value });
        await form.lagInput.blur();
        await rejection.record(`[Expected 1] "${value}" is not accepted (저장 disabled)`, () => form.saveButton.isDisabled());
      }
    });

    await step('Assert: Expected 1 — No value is accepted', async () => {
      rejection.assertAll();
    });

    await step('Act: Step 2 — After each value, read the input and 저장 (Save)', async () => {
      for (const value of values) {
        await form.fillPolicySettings({ lag: value });
        await form.lagInput.blur();
        if (value !== '') {
          await states.record(`[Expected 2] "${value}": input is marked in error`, () => form.lagInput.evaluate((el) => el.classList.contains('is-invalid')));
          await states.record(`[Expected 2] "${value}": message "${MSG_INVALID_LAG}"`, async () => ((await form.lagError.textContent()) ?? '').trim() === MSG_INVALID_LAG);
        }
        await states.record(`[Expected 2] "${value}": 저장 is disabled`, () => form.saveButton.isDisabled());
      }
    });

    await step('Assert: Expected 2 — Each value is marked in error with the message and 저장 is disabled', async () => {
      states.assertAll();
    });

    await step('Act: Step 3 — Try typing 1000 into the field', async () => {
      await form.lagInput.fill('');
      await form.lagInput.pressSequentially('1000');
      typed = await form.lagInput.inputValue();
    });

    await step('Assert: Expected 3 — The field takes only 3 digits', async () => {
      expect(typed, '[Expected 3] The fourth character cannot be entered').toBe('100');
    });
  });

  test('TC_US080_032 — JPY is selectable on the create form', async ({ page, paymentMethodPolicyListPage: list, paymentMethodPolicyFormPage: form }) => {
    const step = makeStep(page);
    await allure.description(
      'Open 정책 추가 and the 거래금액 통화 dropdown: JPY is listed and selectable. Deviation from TC: pre-condition 2 ' +
        '("no seed row carries JPY") no longer holds — automation-created JPY rows exist — which does not affect the ' +
        'check. Read-only.',
    );
    await allure.severity('minor');
    await allure.tags('regression', 'ui', 'create', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_032');

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN, list open', async () => {
      await list.open();
    });

    await step('Act: Step 1 — Click 정책 추가 (Add policy) and open the 거래금액 통화 (Transaction currency) dropdown', async () => {
      await list.openCreateForm();
      await form.currencySelect.selectOption('JPY');
    });

    await step('Assert: Expected 1 — JPY is in the list and selectable', async () => {
      await expect(form.currencySelect.locator('option[value="JPY"]'), '[Expected 1] JPY is offered').toHaveCount(1);
      await expect(form.currencySelect, '[Expected 1] JPY can be selected').toHaveValue('JPY');
    });
  });

  test('TC_US080_033 — The three key fields open with no value pre-selected and Save is disabled', async ({
    page,
    paymentMethodPolicyListPage: list,
    paymentMethodPolicyFormPage: form,
  }) => {
    const step = makeStep(page);
    await allure.description(
      'Open 정책 추가: PG · 결제수단 · 거래금액 통화 all show the empty "— 선택 —" entry with nothing pre-selected, and 저장 ' +
        `is disabled. Deviation from TC: the empty entry reads "— 선택 —" on the Korean UI (TC: "— Select —"); ${DEVIATION_PG_LABEL}.`,
    );
    await allure.severity('critical');
    await allure.tags('regression', 'ui', 'create', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_033');

    await step('Arrange: Pre-condition 1 — Logged in as ADMIN, list open', async () => {
      await list.open();
    });

    await step('Act: Step 1 — Click 정책 추가 and read the three 채널 키 fields and 저장 (Save)', async () => {
      await list.openCreateForm();
    });

    await step('Assert: Expected 1 — All three key fields show "— 선택 —" with nothing pre-selected; 저장 is disabled', async () => {
      for (const [name, select] of [['PG', form.pgSelect], ['결제수단', form.methodSelect], ['거래금액 통화', form.currencySelect]] as const) {
        await expect(select, `[Expected 1] ${name} has no value pre-selected`).toHaveValue('');
        await expect(select.locator('option:checked'), `[Expected 1] ${name} shows "— 선택 —"`).toHaveText('— 선택 —');
      }
      await expect(form.saveButton, '[Expected 1] 저장 (Save) is disabled').toBeDisabled();
    });
  });

  test('TC_US080_034 — The policy value fields keep their defaults', async ({ page, paymentMethodPolicyListPage: list, paymentMethodPolicyFormPage: form }) => {
    const step = makeStep(page);
    await allure.description(
      'Open 정책 추가 and read the policy value fields: 환율 적용 방식 = "이미 KRW — 환율 미적용", 정산 주기 = WEEKLY, 기준 요일 = ' +
        'WED — they keep their defaults instead of being blanked along with the key fields.',
    );
    await allure.severity('minor');
    await allure.tags('regression', 'ui', 'create', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_034');

    await step('Arrange: Pre-condition 1 — Logged in as ADMIN, list open', async () => {
      await list.open();
    });

    await step('Act: Step 1 — Click 정책 추가 and read the three policy value fields', async () => {
      await list.openCreateForm();
    });

    await step('Assert: Expected 1 — 환율 적용 방식, 정산 주기 and 기준 요일 keep their defaults', async () => {
      await expect(form.strategySelect.locator('option:checked'), '[Expected 1] 환율 적용 방식 = 이미 KRW — 환율 미적용').toHaveText('이미 KRW — 환율 미적용');
      await expect(form.cycleTypeSelect, '[Expected 1] 정산 주기 = WEEKLY').toHaveValue('WEEKLY');
      await expect(form.anchorSelect, '[Expected 1] 기준 요일 = WED').toHaveValue('WED');
    });
  });

  test('TC_US080_035 — The same PG and method with a different currency is accepted as a separate row', async ({
    page,
    paymentMethodPolicyListPage: list,
    paymentMethodPolicyFormPage: form,
    policyApi,
  }) => {
    const step = makeStep(page);
    let pair = { taken: DUPLICATE_KEY, free: DUPLICATE_KEY, existingCount: 0 };
    let submitStatus = 0;
    let rowsAfter = 0;
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'create', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_035');

    try {
      await step('Arrange: Pre-condition 1–4 — A PG × 결제수단 pair with existing rows and one free currency picked via API', async () => {
        pair = await pickPairWithFreeCurrency(policyApi);
        await allure.description(
          `Filter the list on ${pair.free.pgCode} · ${pair.free.paymentMethodCode}: it shows the existing rows, differing ` +
            `only in currency. Create ${formatChannelKey(pair.free)}: no duplicate message appears (only the first two ` +
            'fields match) and the create request is accepted as a distinct key next to the existing rows. Consumes the ' +
            'key permanently (BR-18). Deviation from TC: EXIMBAY · CREDIT_CARD_GLOBAL · JPY is already taken, so a pair ' +
            'from the automation pool is used — its existing rows need not carry two different 환율 적용 방식 values; ' +
            `${DEVIATION_LAG_DEFAULT}; ${DEVIATION_CONFIRM}.`,
        );
        await list.open();
      });

      await step(`Act: Step 1 — Filter the list on ${pair.free.pgCode} · ${pair.free.paymentMethodCode}, click 검색 and read the row count`, async () => {
        await list.fillFilters({ pg: pair.free.pgCode, method: pair.free.paymentMethodCode });
        await list.clickSearch();
      });

      await step(`Assert: Expected 1 — The table shows the ${pair.existingCount} existing row(s), differing only in currency`, async () => {
        await expect(list.dataRows, `[Expected 1] The table shows ${pair.existingCount} existing row(s)`).toHaveCount(pair.existingCount);
        for (const [row, pg] of (await list.columnTexts(1)).entries()) {
          expect(pg, `[Expected 1] Row ${row + 1} PG is ${pair.free.pgCode}`).toBe(pair.free.pgCode);
        }
        for (const [row, method] of (await list.columnTexts(2)).entries()) {
          expect(method, `[Expected 1] Row ${row + 1} 결제수단 is ${pair.free.paymentMethodCode}`).toBe(pair.free.paymentMethodCode);
        }
      });

      await step(`Act: Step 2 — Click 정책 추가 and set the key to ${formatChannelKey(pair.free)}`, async () => {
        await list.openCreateForm();
        await form.fillPolicySettings({ lag: '5' });
        await form.fillChannelKey(asForm(pair.free));
      });

      await step('Assert: Expected 2 — All three key fields take the values; no duplicate-key message appears', async () => {
        await expect(form.currencySelect, `[Expected 2] 거래금액 통화 takes ${pair.free.currency}`).toHaveValue(pair.free.currency);
        await expect(form.duplicateKeyMessage, '[Expected 2] No duplicate-key message appears').toHaveCount(0);
      });

      await step('Act: Step 3 — Keep the defaults, click 저장, enter 변경 사유 and click 승인 요청', async () => {
        await form.save();
        submitStatus = await form.submitForApproval(traceReason('TC_US080_035'));
        rowsAfter = (await policyApi.list({ pgCode: pair.free.pgCode, paymentMethodCode: pair.free.paymentMethodCode }, 1000)).body.totalElements;
      });

      await step('Assert: Expected 3 — The create request is accepted as a distinct key next to the existing rows', async () => {
        expect(submitStatus, '[Expected 3] The create request is accepted by the server').toBeLessThan(300);
        expect((await policyApi.getByKey(pair.free)).body.holder?.pending?.changeType, `[Expected 3] ${formatChannelKey(pair.free)} awaits approval as a create`).toBe(
          'NEW',
        );
        expect(rowsAfter, '[Expected 3] The new key coexists with the existing rows').toBe(pair.existingCount + 1);
      });
    } finally {
      if (pair.free !== DUPLICATE_KEY) await withdrawPendingCreate(policyApi, pair.free);
    }
  });

  test('TC_US080_036 — Save becomes enabled only when every required field is valid', async ({ page, paymentMethodPolicyFormPage: form, policyApi }) => {
    const step = makeStep(page);
    const observations = new Observations(page);
    let freeKey: ChannelKey = DUPLICATE_KEY;
    await allure.description(
      'On the create form select the key fields one by one: 저장 stays disabled after the first and second, and becomes ' +
        'enabled once the third is selected and the key is free; clearing 지연일수 disables it again and entering 14 ' +
        `enables it again. Deviation from TC: ${DEVIATION_LAG_DEFAULT} before the key fields. Read-only.`,
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'create', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_036');

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN, an unused key picked, create form open with 지연일수 filled', async () => {
      freeKey = await pickUnusedKey(policyApi);
      await form.openCreate();
      await form.fillPolicySettings({ lag: '5' });
    });

    await step('Act: Step 1 — Select the first, then the second, then the third key field', async () => {
      await form.pgSelect.selectOption(freeKey.pgCode);
      await observations.record('[Expected 1] 저장 stays disabled after the first key field', () => form.saveButton.isDisabled());
      await form.methodSelect.selectOption(freeKey.paymentMethodCode);
      await observations.record('[Expected 1] 저장 stays disabled after the second key field', () => form.saveButton.isDisabled());
      await form.selectCurrencyAndAwaitKeyCheck(freeKey.currency);
      await observations.record('[Expected 1] 저장 is enabled once the third field is selected and the key is free', () => form.saveButton.isEnabled());
    });

    await step('Assert: Expected 1 — 저장 is enabled only after the third key field, on a free key', async () => {
      observations.assertAll();
    });

    await step('Act: Step 2 — Clear 지연일수 (Lag)', async () => {
      await form.lagInput.fill('');
    });

    await step('Assert: Expected 2 — 저장 goes back to disabled', async () => {
      await expect(form.saveButton, '[Expected 2] 저장 (Save) is disabled').toBeDisabled();
    });

    await step('Act: Step 3 — Enter 지연일수 (Lag) = 14 again', async () => {
      await form.fillPolicySettings({ lag: '14' });
    });

    await step('Assert: Expected 3 — 저장 becomes enabled again', async () => {
      await expect(form.saveButton, '[Expected 3] 저장 (Save) is enabled').toBeEnabled();
    });
  });
});
