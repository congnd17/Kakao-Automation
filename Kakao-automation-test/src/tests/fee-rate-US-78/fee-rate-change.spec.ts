import { test, expect } from '@fixtures/fee-rate.fixture';
import { makeStep } from '@utils/step';
import { skipTc, tcMeta } from '@utils/tc-meta';
import { FEE_TEXT, KEY, DEFAULT_ROWS, FeeRowSpec, addDays, inDays, keyLabel, latestChange } from '@utils/fee-rate.data';

/**
 * US078 — nhóm [Change Request]: dialog 요율 수정 (정정 / 변경), kiểm tra ngày, lý do, biên giá trị, impact box.
 * Nguồn TC: input/TESTCASE_US078_v2.md (Steps N / Expected N → `Act: Step N` / `Assert: Expected N`). Kỳ vọng assert theo TC;
 * chỗ UI khác TC ghi "Deviation from TC". Ngày gửi thay đổi dạng tương đối theo ngày chạy (standing rule 3 của TC).
 * Dữ liệu: contract automation tạo qua API (không xoá được); đơn còn chờ rút lại ở teardown.
 */
const TAGS = ['ui', 'fee-rate', 'fee-rate-change'];
const DATA = 'Data: automation-owned contract(s) created through the API (contracts cannot be deleted); pending requests are withdrawn in teardown.';
const APPLIED_INSTEAD = 'rows that need an earlier approved change are built on a not-yet-started contract, where changes apply at once (a second approver is needed otherwise — decision 28/09)';
const NO_RULE_CODE = /\b(CNT|BR|W-CNT|CHG)-?\d+/;
const CORRECTION_REASON = 'Contract says 8%, corrected from a 10% keying error';
const NEVER_APPLIES = '이 수수료 행은 어떤 주문에도 적용되지 않습니다. 계약 기간과 프로모션 기간 안의 적용 시작일을 입력해 주세요';
const promoPeriod = () => ({ from: inDays(5), to: inDays(35) });
const withPromotion = (rows: FeeRowSpec[] = DEFAULT_ROWS): FeeRowSpec[] => [...rows, { ...KEY.MD_PROMO, commission: 20, promotion: promoPeriod() }];

test.describe('[Change Request] The Change fee rate dialog and its checks', () => {
  test.describe.configure({ timeout: 150_000 });

  test('TC_US078_40 — A correction can be sent with a new rate, a reason, and the original start date kept', async ({ page, feeRateApi, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_40', 'Critical', TAGS, `The dialog shows current value 10 % and start date; no kind is pre-selected; a correction to 8 % with the start date left empty submits, the row stays 10 % with 승인 대기, and the request carries the unchanged start date. ${DATA}`);
    let contract = { id: 0, start: '' };
    let preselected = { correction: true, rateChange: true };
    let submitStatus = 0;

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; MD · 10 % effective from the contract start is Active', async () => {
      contract = await feeRateContracts.create('TC_US078_40', 'RUNNING');
    });

    await step('Act: Step 1 — Click Change rate on the MD row', async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD));
    });

    await step('Assert: Expected 1 — The dialog shows the current value 10 % and the current start date', async () => {
      await expect(fee.changeDialog.summaryValue(FEE_TEXT.dialog.currentRate), '[Expected 1] Current value 10 %').toHaveText('10 %');
      await expect(fee.changeDialog.summaryValue(FEE_TEXT.dialog.currentEf), `[Expected 1] Current start date ${contract.start}`).toHaveText(contract.start);
    });

    await step('Act: Step 2 — Pick 정정 (Correction)', async () => {
      preselected = { correction: await fee.changeDialog.correctionRadio.isChecked(), rateChange: await fee.changeDialog.rateChangeRadio.isChecked() };
      await fee.changeDialog.correctionRadio.check();
    });

    await step('Assert: Expected 2 — The dialog stays open with no default kind selected', async () => {
      await expect(fee.changeDialog.root, '[Expected 2] The dialog stays open').toBeVisible();
      expect(preselected, '[Expected 2] No kind was pre-selected before picking').toEqual({ correction: false, rateChange: false });
    });

    await step('Act: Step 3 — Enter rate 8, leave the start date empty, enter the reason, click 승인 요청', async () => {
      await fee.changeDialog.fill({ rate: '8', reason: CORRECTION_REASON });
      submitStatus = (await fee.changeDialog.submit()).status;
    });

    await step('Assert: Expected 3 — The row still shows 10 % with 승인 대기; the request carries the unchanged start date', async () => {
      expect(submitStatus, '[Expected 3] Submit succeeds (201)').toBe(201);
      await expect(fee.cell(fee.row(KEY.MD), 'fee').locator('input'), '[Expected 3] The row still shows 10').toHaveValue('10');
      await expect(fee.approvalBadge(fee.row(KEY.MD)), '[Expected 3] Approval reads 승인 대기').toHaveText(FEE_TEXT.approval.PENDING);
      const request = latestChange(await feeRateApi.history(contract.id, await feeRateContracts.rowId(contract.id, KEY.MD)));
      expect(request.requestedEffectiveFrom, `[Expected 3] The request carries start date ${contract.start}, unchanged`).toBe(contract.start);
    });
  });

  test('TC_US078_41 — A rate change can be sent with a future start date; the dialog says which orders keep the current rate', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    const effective = inDays(5);
    await tcMeta('TC_US078_41', 'Critical', TAGS, `With 변경 at 9 % from today + 5 days the dialog states orders before that date keep the current rate (8 %) and orders from it use 9 %; submit succeeds and the row stays 8 % with 승인 대기. Deviation from TC: the TC numbers only one Expected line, describing the outcome of step 2 — it is asserted after step 2. ${DATA}`);
    let contract = { id: 0 };
    let sentence = '';
    let submitStatus = 0;

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; Album · 전체 위탁 · 일반 · 8 % is Active', async () => {
      contract = await feeRateContracts.create('TC_US078_41', 'RUNNING');
    });

    await step('Act: Step 1 — Click Change rate on the Album row and pick 변경 (Rate change)', async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.ALBUM));
      await fee.changeDialog.rateChangeRadio.check();
    });

    await step('Act: Step 2 — Enter rate 9, effective from today + 5 days, the reason, click 승인 요청', async () => {
      await fee.changeDialog.fill({ rate: '9', date: effective, reason: 'Annex signed this week raises the rate to 9%' });
      sentence = ((await fee.changeDialog.impactBody.textContent()) ?? '').trim();
      submitStatus = (await fee.changeDialog.submit()).status;
    });

    await step('Assert: Expected 1 — The dialog said which orders keep 8 % and which use 9 %; submit succeeds; the row stays 8 % with 승인 대기', async () => {
      expect(sentence, '[Expected 1] The dialog states orders before the date keep the current rate').toContain(FEE_TEXT.dialog.impactChangeDetail(effective));
      expect(sentence, '[Expected 1] The sentence names the current rate 8 %').toContain('8 %');
      expect(sentence, '[Expected 1] The sentence names the new rate 9 %').toContain('9 %');
      expect(submitStatus, '[Expected 1] Submit succeeds (201)').toBe(201);
      await expect(fee.cell(fee.row(KEY.ALBUM), 'fee').locator('input'), '[Expected 1] The row still shows 8').toHaveValue('8');
      await expect(fee.approvalBadge(fee.row(KEY.ALBUM)), '[Expected 1] Approval reads 승인 대기').toHaveText(FEE_TEXT.approval.PENDING);
    });
  });

  test('TC_US078_42 — Submit stays greyed out until Correction or Rate change is picked', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_42', 'High', TAGS, `Neither 정정 nor 변경 is pre-selected; with rate 8 and reason "Test" but no kind, 승인 요청 stays disabled until a kind is picked. ${DATA}`);
    let contract = { id: 0 };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the MD row is Active', async () => {
      contract = await feeRateContracts.create('TC_US078_42', 'RUNNING');
    });

    await step('Act: Step 1 — Click Change rate on the MD row and read which radio option is selected', async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD));
    });

    await step('Assert: Expected 1 — Neither 정정 nor 변경 is pre-selected', async () => {
      await expect(fee.changeDialog.correctionRadio, '[Expected 1] 정정 (Correction) is not pre-selected').not.toBeChecked();
      await expect(fee.changeDialog.rateChangeRadio, '[Expected 1] 변경 (Rate change) is not pre-selected').not.toBeChecked();
    });

    await step('Act: Step 2 — Without picking a kind, enter rate 8 and reason "Test", check the Submit button', async () => {
      await fee.changeDialog.fill({ rate: '8', reason: 'Test' });
    });

    await step('Assert: Expected 2 — Submit stays disabled until a kind is picked', async () => {
      await expect(fee.changeDialog.submitButton, '[Expected 2] 승인 요청 is disabled without a kind').toBeDisabled();
      await fee.changeDialog.correctionRadio.check();
      await expect(fee.changeDialog.submitButton, '[Expected 2] 승인 요청 becomes enabled once a kind is picked').toBeEnabled();
      await fee.changeDialog.cancelButton.click();
    });
  });

  test('TC_US078_43 — A correction can fix a mistyped start date; leaving the date empty keeps the current one', async ({ page, feeRateApi, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    let contract = { id: 0, start: '' };
    let wrong = '';
    await tcMeta('TC_US078_43', 'High', TAGS, `A correction moving the MD start date from the mistyped day back to the right one succeeds and its trail records both the old and the new date; a correction with the date left empty on another row keeps that row's start date. Deviation from TC: ${APPLIED_INSTEAD} — the mistyped date is contract start + 9 days (TC 2026-01-10) and the right one the contract start (TC 2026-01-01). ${DATA}`);
    let submitA = 0;
    let submitB = 0;

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the MD row starts on a mistyped date (start + 9 days)', async () => {
      contract = await feeRateContracts.create('TC_US078_43', 'NOT_STARTED');
      wrong = addDays(contract.start, 9);
      await feeRateContracts.submit(contract.id, KEY.MD, { changeKind: 'CORRECTION', commission: '10', effectiveFrom: wrong, changeReason: 'Start date keyed in wrong' });
    });

    await step('Act: Step 1 — Change rate on MD: 정정, rate 10 (unchanged), effective from the right date, reason, submit', async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD));
      await fee.changeDialog.fill({ kind: 'correction', rate: '10', date: contract.start, reason: 'Fixing a mis-keyed start date' });
      submitA = (await fee.changeDialog.submit()).status;
    });

    await step('Assert: Expected 1 — Submit succeeds; the trail records both the old and the new date', async () => {
      expect(submitA, '[Expected 1] Submit succeeds (201)').toBe(201);
      const latest = latestChange(await feeRateApi.history(contract.id, await feeRateContracts.rowId(contract.id, KEY.MD)));
      expect(latest.previousEffectiveFrom, `[Expected 1] The old date ${wrong} is recorded`).toBe(wrong);
      expect(latest.requestedEffectiveFrom, `[Expected 1] The new date ${contract.start} is recorded`).toBe(contract.start);
      await fee.openHistory(fee.row(KEY.MD));
      await expect(fee.historyDialog.cell(0, 'change'), '[Expected 1] The history shows old → new date').toContainText(`${wrong} → ${contract.start}`);
      await fee.historyDialog.close();
    });

    await step('Act: Step 2 — On a different row pick 정정, leave the date empty, submit with a rate change and a reason', async () => {
      await fee.openChangeDialog(fee.row(KEY.ALBUM));
      await fee.changeDialog.fill({ kind: 'correction', rate: '7.5', reason: 'Album rate corrected, date unchanged' });
      submitB = (await fee.changeDialog.submit()).status;
    });

    await step("Assert: Expected 2 — Submit succeeds and the row's start date is unchanged", async () => {
      expect(submitB, '[Expected 2] Submit succeeds (201)').toBe(201);
      await expect(fee.cell(fee.row(KEY.ALBUM), 'effectiveFrom'), `[Expected 2] The Album start date is still ${contract.start}`).toContainText(contract.start);
    });
  });

  test('TC_US078_44 — A correction is refused when the new date would jump over the row before or after it', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    let contract = { id: 0, start: '' };
    let second = '';
    await tcMeta('TC_US078_44', 'High', TAGS, `On a key with rows at S and S + 15 days, correcting the S row to S + 30 is refused with "더 늦은 적용 시작일이 필요합니다. 이 항목의 최신 행은 {S+15}부터 적용됩니다."; correcting the S + 15 row to a date before S is refused with "정정한 적용 시작일은 {S} 이후, {S+15} 이전이어야 합니다." — no rule code. Deviation from TC: ${APPLIED_INSTEAD}; S = contract start (TC 2026-01-01), later row S + 15 (TC today + 15), dates shifted accordingly. ${DATA}`);

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; Album has rows at S and S + 15 days on the same key', async () => {
      contract = await feeRateContracts.create('TC_US078_44', 'NOT_STARTED');
      second = addDays(contract.start, 15);
      await feeRateContracts.submit(contract.id, KEY.ALBUM, { changeKind: 'RATE_CHANGE', commission: '9', effectiveFrom: second, changeReason: 'Second Album row' });
    });

    await step('Act: Step 1 — Pick 정정 on the S row, set its date to S + 30 (past the S + 15 row), submit', async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.ALBUM, contract.start));
      await fee.changeDialog.fill({ kind: 'correction', rate: '8', date: addDays(contract.start, 30), reason: 'Test' });
    });

    await step('Assert: Expected 1 — Refused with "A later start date is required…" naming S + 15, no rule code', async () => {
      await expect(fee.changeDialog.message(FEE_TEXT.check.tooEarly(second)), '[Expected 1] The refusal names the most recent row date').toBeVisible();
      await expect(fee.changeDialog.message(NO_RULE_CODE), '[Expected 1] No rule code is shown').toHaveCount(0);
      await fee.changeDialog.cancelButton.click();
    });

    await step('Act: Step 2 — Pick 정정 on the S + 15 row, set its date before S, submit', async () => {
      await fee.openChangeDialog(fee.row(KEY.ALBUM, second));
      await fee.changeDialog.fill({ kind: 'correction', rate: '9', date: addDays(contract.start, -31), reason: 'Test' });
    });

    await step('Assert: Expected 2 — Refused with "The corrected date must stay after S and before S + 15"', async () => {
      await expect(fee.changeDialog.message(FEE_TEXT.check.reorderBoth(contract.start, second)), '[Expected 2] The refusal names both bounds').toBeVisible();
      await expect(fee.changeDialog.message(NO_RULE_CODE), '[Expected 2] No rule code is shown').toHaveCount(0);
      await fee.changeDialog.cancelButton.click();
    });
  });

  test('TC_US078_45 — A correction is refused when the new start date is before the contract starts', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_45', 'High', TAGS, `Correcting MD to 2025-12-25 (before the contract start 2026-01-01) is refused with "${NEVER_APPLIES}" — no rule code. ${DATA}`);
    let contract = { id: 0 };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the contract starts 2026-01-01; MD starts 2026-01-01', async () => {
      contract = await feeRateContracts.create('TC_US078_45', 'RUNNING');
    });

    await step('Act: Step 1 — Pick 정정 on MD, set its date to 2025-12-25, reason "Test", click Submit', async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD));
      await fee.changeDialog.fill({ kind: 'correction', rate: '10', date: '2025-12-25', reason: 'Test' });
    });

    await step('Assert: Expected 1 — Refused with "This fee row would never apply to any order…", no rule code', async () => {
      await expect(fee.changeDialog.message(NEVER_APPLIES), '[Expected 1] The refusal message is shown').toBeVisible();
      await expect(fee.changeDialog.message(NO_RULE_CODE), '[Expected 1] No rule code is shown').toHaveCount(0);
      await expect(fee.changeDialog.submitButton, '[Expected 1] Submit is refused (disabled)').toBeDisabled();
    });
  });

  test('TC_US078_46 — A rate change with a past start date is refused and told to send it as a correction', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_46', 'High', TAGS, `A rate change on Album at 9 % from a past date is refused with "${FEE_TEXT.check.backdated}" — no rule code. Deviation from TC: the past date is today − 7 days (TC 2026-09-01). ${DATA}`);
    let contract = { id: 0 };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; Album is Active; today is after the chosen date', async () => {
      contract = await feeRateContracts.create('TC_US078_46', 'RUNNING');
    });

    await step('Act: Step 1 — Pick 변경 on Album, rate 9, effective from a past date, reason "Test", click Submit', async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.ALBUM));
      await fee.changeDialog.fill({ kind: 'rateChange', rate: '9', date: inDays(-7), reason: 'Test' });
    });

    await step('Assert: Expected 1 — Refused with "A rate change cannot start in the past…", no rule code', async () => {
      await expect(fee.changeDialog.message(FEE_TEXT.check.backdated), '[Expected 1] The refusal message is shown').toBeVisible();
      await expect(fee.changeDialog.message(NO_RULE_CODE), '[Expected 1] No rule code is shown').toHaveCount(0);
    });
  });

  test('TC_US078_47 — A rate change is refused when its start date is on or before the newest row of that category', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    let contract = { id: 0, start: '' };
    let newest = '';
    await tcMeta('TC_US078_47', 'High', TAGS, `With Album rows at S and S + 15, a rate change from S + 15 (same as the newest) and one from S + 10 (earlier than the newest) are both refused with "더 늦은 적용 시작일이 필요합니다. 이 항목의 최신 행은 {S+15}부터 적용됩니다." — no rule code. Deviation from TC: ${APPLIED_INSTEAD}. ${DATA}`);

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; Album has rows at S and S + 15 days', async () => {
      contract = await feeRateContracts.create('TC_US078_47', 'NOT_STARTED');
      newest = addDays(contract.start, 15);
      await feeRateContracts.submit(contract.id, KEY.ALBUM, { changeKind: 'RATE_CHANGE', commission: '9', effectiveFrom: newest, changeReason: 'Newest Album row' });
    });

    await step('Act: Step 1 — Pick 변경 on this key, effective from S + 15 (same as the newest), reason "Test", submit', async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.ALBUM, newest));
      await fee.changeDialog.fill({ kind: 'rateChange', rate: '10', date: newest, reason: 'Test' });
    });

    await step('Assert: Expected 1 — Refused with "A later start date is required…" naming S + 15', async () => {
      await expect(fee.changeDialog.message(FEE_TEXT.check.tooEarly(newest)), '[Expected 1] The refusal names the newest row date').toBeVisible();
      await expect(fee.changeDialog.message(NO_RULE_CODE), '[Expected 1] No rule code is shown').toHaveCount(0);
    });

    await step('Act: Step 2 — Repeat with effective from S + 10 (still future, before the newest row)', async () => {
      await fee.changeDialog.fill({ date: addDays(contract.start, 10) });
    });

    await step('Assert: Expected 2 — Refused with the same message', async () => {
      await expect(fee.changeDialog.message(FEE_TEXT.check.tooEarly(newest)), '[Expected 2] The same refusal message is shown').toBeVisible();
      await fee.changeDialog.cancelButton.click();
    });
  });

  test('TC_US078_48 — A start date outside the promotion period is refused; a mid-campaign date is accepted', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    const promo = promoPeriod();
    await tcMeta('TC_US078_48', 'Medium', TAGS, `On MD · 부분 위탁 · 프로모션 (promotion today+5 → today+35) a rate change from promotion end + 5 days is refused with "${NEVER_APPLIES}" — no rule code; one from a mid-campaign date (today + 20) is accepted. Deviation from TC: the promotion period is run-relative (TC 2026-10-01 → 2026-10-31). ${DATA}`);
    let contract = { id: 0 };
    let accepted = 0;

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; MD · 부분 위탁 · 프로모션 has its promotion period', async () => {
      contract = await feeRateContracts.create('TC_US078_48', 'RUNNING', withPromotion());
    });

    await step('Act: Step 1 — Pick 변경 on this row, effective from after the promotion ends, reason "Test", submit', async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD_PROMO));
      await fee.changeDialog.fill({ kind: 'rateChange', rate: '18', date: addDays(promo.to, 5), reason: 'Test' });
    });

    await step('Assert: Expected 1 — Refused with "This fee row would never apply to any order…", no rule code', async () => {
      await expect(fee.changeDialog.message(NEVER_APPLIES), '[Expected 1] The refusal message is shown').toBeVisible();
      await expect(fee.changeDialog.message(NO_RULE_CODE), '[Expected 1] No rule code is shown').toHaveCount(0);
    });

    await step('Act: Step 2 — Repeat with a mid-campaign date inside the period (today + 20)', async () => {
      await fee.changeDialog.fill({ date: inDays(20) });
      accepted = (await fee.changeDialog.submit()).status;
    });

    await step('Assert: Expected 2 — Submit succeeds — a mid-campaign rate change is accepted', async () => {
      expect(accepted, '[Expected 2] The mid-campaign change is accepted (201)').toBe(201);
    });
  });

  test('TC_US078_49 — The start date accepts the first and last allowed day and refuses the day just outside each end', async () => {
    await skipTc(
      'TC_US078_49',
      'Medium',
      TAGS,
      'Six boundary attempts on one new promotion row: contract start − 1 refused, start / start + 1 / coverage end − 1 / coverage end accepted, coverage end + 1 refused.',
      'each ACCEPTED attempt on a running contract leaves a pending new row that locks the key ("이 키에는 이미 저장되지 않은 새 행이 있습니다" / one pending request per row), so the next boundary on the SAME key cannot be tried without an approver to clear it; the TC dates (2026-10-30/31) also collide with the rule that a fresh date must not be in the past — only one contract-capable account exists (decision 28/09)',
    );
  });

  test('TC_US078_50 — A warning appears when the first days of a promotion have no row covering them, and the save still goes through', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    const promo = promoPeriod();
    const rowStart = addDays(promo.from, 19);
    const warning = FEE_TEXT.check.gapByRow(promo.from, addDays(rowStart, -1), keyLabel(KEY.MD_CONSIGNMENT), '15 %');
    await tcMeta('TC_US078_50', 'Medium', TAGS, `Adding the MD · 부분 위탁 · 프로모션 row at 20 % from promotion start + 19 days warns "${warning}" — no rule code — and the save is still allowed. Deviation from TC: dates are run-relative (TC promotion from 2026-10-01, row from 2026-10-20). ${DATA}`);
    let contract = { id: 0 };
    let warned = false;
    let saved = 0;

    await step('Arrange: Pre-condition 1–3 — Logged in as ADMIN; no promotion row yet; MD · 부분 위탁 · 일반 · 15 % exists', async () => {
      contract = await feeRateContracts.create('TC_US078_50', 'RUNNING', [...DEFAULT_ROWS, { ...KEY.MD_CONSIGNMENT, commission: 15 }]);
    });

    await step('Act: Step 1 — Add the promotion row with rate 20 starting 19 days into the promotion, submit', async () => {
      await fee.openEdit(contract.id);
      await fee.addButton.click();
      await fee.fillNewRow({ ...KEY.MD_PROMO, rate: 20, startDate: rowStart, promotion: promo });
      await fee.save();
      await expect(fee.reasonDialog.root, 'The reason dialog opens').toBeVisible();
      await fee.reasonDialog.reasonInput.fill('Promotion row starting mid-campaign');
      saved = (await fee.collectFeeRowPosts(() => fee.reasonDialog.submitButton.click(), 1))[0].status;
      // Cảnh báo do server trả về sau khi gửi dòng → hiện dạng toast (verify 29/09).
      warned = await page.getByText(warning).first().waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false);
    });

    await step('Assert: Expected 1 — The gap warning names the rate those orders will use, no rule code; the save still goes through', async () => {
      expect(warned, `[Expected 1] Warning "${warning}" is shown`).toBe(true);
      await expect(page.getByText(NO_RULE_CODE), '[Expected 1] No rule code is shown').toHaveCount(0);
      expect(saved, '[Expected 1] The save is still allowed').toBeLessThan(300);
    });
  });

  test('TC_US078_51 — No gap warning appears when the row being changed already covers the first days of the promotion', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_51', 'Medium', TAGS, `The MD · 부분 위탁 · 프로모션 row already starts before its own promotion start; a rate change from a later mid-promotion date (today + 15) raises no "요율 적용 공백" warning. Deviation from TC: dates are run-relative (row from the contract start, promotion today+5 → today+35). ${DATA}`);
    let contract = { id: 0 };
    let submitted = 0;

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the promotion row starts before its own promotion start', async () => {
      contract = await feeRateContracts.create('TC_US078_51', 'RUNNING', withPromotion());
    });

    await step("Act: Step 1 — Pick 변경 on this row, a new rate effective later than the row's own start, inside the promotion, submit", async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD_PROMO));
      await fee.changeDialog.fill({ kind: 'rateChange', rate: '18', date: inDays(15), reason: 'Mid-promotion rate change' });
      submitted = (await fee.changeDialog.submit()).status;
    });

    await step('Assert: Expected 1 — No opening-days warning is raised', async () => {
      await expect(page.getByText('요율 적용 공백'), '[Expected 1] No "요율 적용 공백" (gap) warning').toHaveCount(0);
      expect(submitted, '[Expected 1] The change is submitted (201)').toBe(201);
    });
  });

  test('TC_US078_52 — A rate change dated today is accepted in the early morning Korea time', async () => {
    await skipTc('TC_US078_52', 'High', TAGS, "A rate change dated today's Korean calendar date is accepted between 00:00 and 08:59 KST.", 'BR-22.V1 is about the SERVER clock in the 00:00–08:59 KST window; the suite cannot run or observe the dev server inside that window, and the TC says to mark the case Blocked rather than change the local clock');
  });

  test('TC_US078_53 — The reason box stops at 200 characters with a live counter; an empty reason blocks Submit with a message', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    const reason200 = 'R'.repeat(200);
    await tcMeta('TC_US078_53', 'Medium', TAGS, `A 200-character reason is accepted and the counter reads 200 / 200; a 201st character cannot be typed; clearing the reason and clicking 승인 요청 is blocked, the field is highlighted and "${FEE_TEXT.dialog.reasonRequired}" is shown with the counter turned red. ${DATA}`);
    let contract = { id: 0 };
    let posted = 0;

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the MD row is Active', async () => {
      contract = await feeRateContracts.create('TC_US078_53', 'RUNNING');
    });

    await step('Act: Step 1 — Pick 정정, rate 8, type a reason exactly 200 characters long, check the counter', async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD));
      await fee.changeDialog.fill({ kind: 'correction', rate: '8', reason: reason200 });
    });

    await step('Assert: Expected 1 — All 200 characters are accepted; the counter shows the limit reached', async () => {
      await expect(fee.changeDialog.reasonInput, '[Expected 1] All 200 characters are kept').toHaveValue(reason200);
      await expect(fee.changeDialog.counter, '[Expected 1] The counter reads 200 / 200').toHaveText('200 / 200');
    });

    await step('Act: Step 2 — Try to type a 201st character', async () => {
      await fee.changeDialog.reasonInput.press('End');
      await fee.changeDialog.reasonInput.pressSequentially('X');
    });

    await step('Assert: Expected 2 — The 201st character cannot be typed', async () => {
      await expect(fee.changeDialog.reasonInput, '[Expected 2] The reason is still 200 characters').toHaveValue(reason200);
    });

    await step('Act: Step 3 — Clear the reason field entirely and click 승인 요청', async () => {
      page.on('request', (r) => {
        if (r.method() === 'POST' && /\/fee-rows\/\d+\/changes$/.test(r.url())) posted += 1;
      });
      await fee.changeDialog.reasonInput.fill('');
      await fee.changeDialog.submitButton.click({ force: true, timeout: 5_000 }).catch(() => undefined);
    });

    await step('Assert: Expected 3 — Submit is blocked; the field is highlighted, the message is shown and the counter is red', async () => {
      expect(posted, '[Expected 3] No request was submitted').toBe(0);
      await expect(fee.changeDialog.reasonInput, '[Expected 3] The reason field is highlighted').toHaveClass(/is-invalid/);
      await expect(fee.changeDialog.reasonError, '[Expected 3] "사유는 필수이며 200자 이내로 입력해 주세요." is shown').toHaveText(FEE_TEXT.dialog.reasonRequired);
      await expect(fee.changeDialog.root.getByText(/^\d+ \/ 200$/), '[Expected 3] The counter is turned red').toHaveClass(/text-danger/);
    });
  });

  test('TC_US078_54 — A reason with Korean, English, symbols or an HTML tag is saved and shown exactly as typed', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    const reason = '계약 조건 변경에 따른 정정 <b>test</b> & special chars: 100%/₩';
    await tcMeta('TC_US078_54', 'Medium', TAGS, `The reason "${reason}" is submitted and the History shows it exactly as typed — Korean text, the <b> tag as plain text (not bold) and the special characters. ${DATA}`);
    let contract = { id: 0 };
    let submitted = 0;

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the MD row is Active', async () => {
      contract = await feeRateContracts.create('TC_US078_54', 'RUNNING');
    });

    await step('Act: Step 1 — Pick 정정, rate 8, enter the mixed reason, click Submit', async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD));
      await fee.changeDialog.fill({ kind: 'correction', rate: '8', reason });
      submitted = (await fee.changeDialog.submit()).status;
    });

    await step('Assert: Expected 1 — Submit succeeds', async () => {
      expect(submitted, '[Expected 1] Submit succeeds (201)').toBe(201);
    });

    await step('Act: Step 2 — Click History on this row and read the saved reason', async () => {
      await fee.openHistory(fee.row(KEY.MD));
    });

    await step('Assert: Expected 2 — The reason is shown exactly as typed; the <b> tag is plain text', async () => {
      const cell = fee.historyDialog.cell(0, 'reason');
      expect(await fee.historyDialog.fullText(0, 'reason'), '[Expected 2] The full reason (cell + hover) is exactly as typed').toBe(reason);
      await expect(cell.locator('b'), '[Expected 2] The <b> tag is not rendered as bold').toHaveCount(0);
    });
  });

  test('TC_US078_55 — A percent row refuses anything below 0 or above 100; a fixed amount row accepts values above 100', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    const cases = [
      { value: '-0.01', ok: false },
      { value: '0', ok: true },
      { value: '0.01', ok: true },
      { value: '99.99', ok: true },
      { value: '100', ok: true },
      { value: '100.01', ok: false },
    ];
    await tcMeta('TC_US078_55', 'Medium', TAGS, `On the MD Percent row -0.01 and 100.01 are refused with "${FEE_TEXT.dialog.rateRange}" (Enter a rate between 0 and 100.) while 0, 0.01, 99.99 and 100 are accepted; on the Fixed row 4400 is accepted with no upper limit. Deviation from TC: "accepted" is judged by the dialog's own validation (no range message, 승인 요청 enabled) without submitting each value — one pending request per row would block the next value. ${DATA}`);
    let contract = { id: 0 };
    const percent: Array<{ value: string; message: boolean; enabled: boolean }> = [];
    let fixed = { message: true, enabled: false };

    await step('Arrange: Pre-condition 1–3 — Logged in as ADMIN; MD · 비율 and a 고정(단위당) row are Active', async () => {
      contract = await feeRateContracts.create('TC_US078_55', 'RUNNING', [...DEFAULT_ROWS, { ...KEY.FIXED, type: 'FIXED_UNIT', commission: 4000 }]);
    });

    await step('Act: Step 1 — On the MD row try rates -0.01, 0, 0.01, 99.99, 100, 100.01', async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD));
      await fee.changeDialog.fill({ kind: 'correction', reason: 'Boundary check' });
      for (const { value } of cases) {
        await fee.changeDialog.rateInput.fill(value);
        percent.push({ value, message: await fee.changeDialog.message(FEE_TEXT.dialog.rateRange).isVisible(), enabled: await fee.changeDialog.submitButton.isEnabled() });
      }
      await fee.changeDialog.cancelButton.click();
    });

    await step('Assert: Expected 1 — -0.01 and 100.01 refused with the range message; 0, 0.01, 99.99 and 100 accepted', async () => {
      for (const [index, expected] of cases.entries()) {
        const seen = percent[index];
        expect(seen.message, `[Expected 1] ${expected.value}: range message ${expected.ok ? 'not shown' : 'shown'}`).toBe(!expected.ok);
        expect(seen.enabled, `[Expected 1] ${expected.value}: ${expected.ok ? 'accepted (Submit enabled)' : 'refused (Submit disabled)'}`).toBe(expected.ok);
      }
    });

    await step('Act: Step 2 — On the Fixed row try amount 4400', async () => {
      await fee.openChangeDialog(fee.row(KEY.FIXED));
      await fee.changeDialog.fill({ kind: 'correction', rate: '4400', reason: 'Boundary check' });
      fixed = { message: await fee.changeDialog.message(FEE_TEXT.dialog.rateRange).isVisible(), enabled: await fee.changeDialog.submitButton.isEnabled() };
    });

    await step('Assert: Expected 2 — 4,400 원 is accepted with no upper limit', async () => {
      expect(fixed.message, '[Expected 2] No range message for 4400').toBe(false);
      expect(fixed.enabled, '[Expected 2] 4400 is accepted (Submit enabled)').toBe(true);
      await fee.changeDialog.cancelButton.click();
    });
  });

  test('TC_US078_56 — A rate with decimals keeps every decimal place through sending, applying and display', async ({ page, feeRateApi, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_56', 'Medium', TAGS, `A correction to 8.75 is accepted with no rounding and, once applied, the MD row displays exactly 8.75 %. Deviation from TC: step 2 "approve the request" is replaced by the change applying at once on a not-yet-started contract (approval needs a second approver — decision 28/09). ${DATA}`);
    let contract = { id: 0 };
    let sent = '';

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the MD row is Active (not-yet-started contract)', async () => {
      contract = await feeRateContracts.create('TC_US078_56', 'NOT_STARTED');
    });

    await step('Act: Step 1 — Pick 정정, rate 8.75, reason "Test", submit', async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD));
      await fee.changeDialog.fill({ kind: 'correction', rate: '8.75', reason: 'Test' });
      await fee.changeDialog.submit();
      const latest = latestChange(await feeRateApi.history(contract.id, await feeRateContracts.rowId(contract.id, KEY.MD)));
      sent = latest.requestedCommission ?? '';
    });

    await step('Assert: Expected 1 — Submit accepts 8.75 with no rounding', async () => {
      expect(Number(sent), '[Expected 1] The request carries 8.75 exactly').toBe(8.75);
    });

    await step("Act: Step 2 — Apply the change (applies at once — see Deviation), then read the row's displayed rate", async () => {
      await fee.open(contract.id);
    });

    await step('Assert: Expected 2 — The row displays exactly 8.75 %, digit for digit', async () => {
      await expect(fee.cell(fee.row(KEY.MD), 'fee').locator('input'), '[Expected 2] The row shows 8.75').toHaveValue('8.75');
    });
  });

  test('TC_US078_57 — Every warning and error in the dialog is written in plain words, with no rule code', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_57', 'Medium', TAGS, `Triggering the past-date check (변경 with a past date) shows the plain-language message "${FEE_TEXT.check.backdated}" and no rule code such as BR-7 or CNT-1025 anywhere in the dialog. ${DATA}`);
    let contract = { id: 0 };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the MD row is Active', async () => {
      contract = await feeRateContracts.create('TC_US078_57', 'RUNNING');
    });

    await step('Act: Step 1 — Trigger a blocking check (변경 with a past date) and read the message', async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD));
      await fee.changeDialog.fill({ kind: 'rateChange', rate: '9', date: inDays(-3), reason: 'Test' });
    });

    await step('Assert: Expected 1 — A plain-language message; no rule code in the visible text', async () => {
      await expect(fee.changeDialog.message(FEE_TEXT.check.backdated), '[Expected 1] The plain-language message is shown').toBeVisible();
      expect(((await fee.changeDialog.root.innerText()) ?? '').match(NO_RULE_CODE), '[Expected 1] No rule code appears in the dialog text').toBeNull();
    });
  });

  test('TC_US078_58 — The Impact box shows not computable and never a made-up number of affected orders', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_58', 'Medium', TAGS, `With 정정, rate 8 and reason "Test", the impact box reads "산출 불가" (not computable), shows no computed impact count, and its badge colour differs from the approval-status pills on the same screen. ${DATA}`);
    let contract = { id: 0 };
    let colours = { impact: '', approval: '' };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the MD row is Active', async () => {
      contract = await feeRateContracts.create('TC_US078_58', 'RUNNING');
    });

    await step('Act: Step 1 — Pick 정정, rate 8, reason "Test", read the Impact box before submitting', async () => {
      await fee.openEdit(contract.id);
      colours.approval = await fee.cell(fee.row(KEY.MD), 'approval').locator('span.badge').evaluate((el) => getComputedStyle(el).backgroundColor);
      await fee.openChangeDialog(fee.row(KEY.MD));
      await fee.changeDialog.fill({ kind: 'correction', rate: '8', reason: 'Test' });
      colours.impact = await fee.changeDialog.impactBadge.evaluate((el) => getComputedStyle(el).backgroundColor);
    });

    await step('Assert: Expected 1 — "산출 불가", no computed count, and a badge colour different from the approval pills', async () => {
      await expect(fee.changeDialog.impactBadge, '[Expected 1] The impact box reads 산출 불가 (not computable)').toHaveText(FEE_TEXT.dialog.notComputable);
      expect(((await fee.changeDialog.impactBody.textContent()) ?? '').match(/\d+\s*건/), '[Expected 1] No number is shown as a computed impact count').toBeNull();
      expect(colours.impact, '[Expected 1] The impact badge colour differs from the approval-status pill').not.toBe(colours.approval);
      await fee.changeDialog.cancelButton.click();
    });
  });

  test('TC_US078_59 — The dialog shows the no-approval notice and the button reads Apply when the contract has not started', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_59', 'Medium', TAGS, `On a not-yet-started contract the Change rate dialog shows "${FEE_TEXT.dialog.gateTitle}" and the button reads "적용" (Apply) instead of "승인 요청". Deviation from TC: the contract starts tomorrow (not 2027-01-01). ${DATA}`);
    let contract = { id: 0 };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; a not-yet-started contract has an Active MD row', async () => {
      contract = await feeRateContracts.create('TC_US078_59', 'NOT_STARTED');
    });

    await step("Act: Step 1 — Click Change rate on the MD row and read the notice and the submit button's label", async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD));
    });

    await step('Assert: Expected 1 — A notice says no approval is needed; the button reads 적용', async () => {
      await expect(fee.changeDialog.message(FEE_TEXT.dialog.gateTitle), '[Expected 1] The no-approval notice is shown').toBeVisible();
      await expect(fee.changeDialog.submitButton, '[Expected 1] The button reads 적용 (Apply)').toHaveText(FEE_TEXT.dialog.apply);
      await fee.changeDialog.cancelButton.click();
    });
  });

  test('TC_US078_60 — Closing the dialog with X saves nothing; reopening shows every field empty again', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_60', 'Medium', TAGS, `After 정정, rate 8 and reason "Test", closing with X saves nothing (the row keeps 10 % and 적용됨); reopening shows no kind selected and empty rate and reason. ${DATA}`);
    let contract = { id: 0 };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the MD row is Active', async () => {
      contract = await feeRateContracts.create('TC_US078_60', 'RUNNING');
    });

    await step('Act: Step 1 — Click Change rate, pick 정정, rate 8, reason "Test", click X to close', async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD));
      await fee.changeDialog.fill({ kind: 'correction', rate: '8', reason: 'Test' });
      await fee.changeDialog.closeIcon.click();
    });

    await step('Assert: Expected 1 — The dialog closes; the row still shows its original value', async () => {
      await expect(fee.changeDialog.root, '[Expected 1] The dialog closes').toHaveCount(0);
      await expect(fee.cell(fee.row(KEY.MD), 'fee').locator('input'), '[Expected 1] The row still shows 10').toHaveValue('10');
      await expect(fee.approvalBadge(fee.row(KEY.MD)), '[Expected 1] Nothing was submitted (적용됨)').toHaveText(FEE_TEXT.approval.APPLIED);
    });

    await step('Act: Step 2 — Click Change rate on the same row again', async () => {
      await fee.openChangeDialog(fee.row(KEY.MD));
    });

    await step('Assert: Expected 2 — No kind selected, the rate field and the reason field empty', async () => {
      await expect(fee.changeDialog.correctionRadio, '[Expected 2] 정정 is not selected').not.toBeChecked();
      await expect(fee.changeDialog.rateChangeRadio, '[Expected 2] 변경 is not selected').not.toBeChecked();
      await expect(fee.changeDialog.rateInput, '[Expected 2] The rate field is empty').toHaveValue('');
      await expect(fee.changeDialog.reasonInput, '[Expected 2] The reason field is empty').toHaveValue('');
      await fee.changeDialog.cancelButton.click();
    });
  });

  test('TC_US078_61 — A failed submit keeps the dialog open with the error still visible', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_61', 'Medium', TAGS, `A rate change with a past date and a click on 승인 요청 keeps the dialog open with the TC_US078_46 message ("${FEE_TEXT.check.backdated}") still visible inside it — not closed, not a toast. ${DATA}`);
    let contract = { id: 0 };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the MD row is Active', async () => {
      contract = await feeRateContracts.create('TC_US078_61', 'RUNNING');
    });

    await step('Act: Step 1 — Pick 변경, a past effective date, reason "Test", click 승인 요청', async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD));
      await fee.changeDialog.fill({ kind: 'rateChange', rate: '9', date: inDays(-3), reason: 'Test' });
      await fee.changeDialog.submitButton.click({ force: true, timeout: 5_000 }).catch(() => undefined);
    });

    await step('Assert: Expected 1 — The dialog stays open with the refusal message inside it, not as a toast', async () => {
      await expect(fee.changeDialog.root, '[Expected 1] The dialog stays open').toBeVisible();
      await expect(fee.changeDialog.message(FEE_TEXT.check.backdated), '[Expected 1] The refusal message is still visible inside the dialog').toBeVisible();
      await expect(page.getByRole('alert').filter({ hasText: FEE_TEXT.check.backdated }), '[Expected 1] The message does not appear as a toast').toHaveCount(0);
      await fee.changeDialog.cancelButton.click();
    });
  });

  test('TC_US078_62 — Double-clicking Submit creates only one request', async ({ page, feeRateApi, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_62', 'High', TAGS, `A rapid double-click on 승인 요청 disables the button after the first click and exactly one request exists for the MD row. Deviation from TC: requests are counted through the row's change history (same register as 변경 승인) instead of counting queue items. ${DATA}`);
    let contract = { id: 0 };
    let posts = 0;
    let requests = -1;

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the MD row is Active', async () => {
      contract = await feeRateContracts.create('TC_US078_62', 'RUNNING');
    });

    await step('Act: Step 1 — Pick 정정, rate 8, reason "Test", double-click 승인 요청 rapidly', async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD));
      await fee.changeDialog.fill({ kind: 'correction', rate: '8', reason: 'Test' });
      page.on('request', (r) => {
        if (r.method() === 'POST' && /\/fee-rows\/\d+\/changes$/.test(r.url())) posts += 1;
      });
      await fee.changeDialog.submitButton.dblclick();
      await page.waitForLoadState('networkidle');
    });

    await step('Assert: Expected 1 — The button disables after the first click', async () => {
      expect(posts, '[Expected 1] Only one submit request left the browser').toBe(1);
    });

    await step('Act: Step 2 — Count the requests for this row', async () => {
      requests = (await feeRateApi.history(contract.id, await feeRateContracts.rowId(contract.id, KEY.MD))).length;
    });

    await step('Assert: Expected 2 — Exactly one request exists for this row', async () => {
      expect(requests, '[Expected 2] Exactly one request exists').toBe(1);
    });
  });
});

test.describe('[Change Request] Date format with an English (United States) browser', () => {
  test.use({ locale: 'en-US' });
  test.describe.configure({ timeout: 120_000 });

  test('TC_US078_63 — The start date always shows as YYYY-MM-DD even when the browser language is English', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_63', 'Medium', TAGS, `With the browser locale en-US the dialog shows the current start date as YYYY-MM-DD and the date field keeps the YYYY-MM-DD format (typed and placeholder) — never 01/01/2026. ${DATA}`);
    let contract = { id: 0, start: '' };

    await step('Arrange: Pre-condition 1–3 — Browser language English (United States); logged in as ADMIN; the MD row is Active', async () => {
      contract = await feeRateContracts.create('TC_US078_63', 'RUNNING');
    });

    await step("Act: Step 1 — Click Change rate on the MD row and read the date field's displayed format", async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD));
      await fee.changeDialog.fill({ kind: 'correction' });
      await fee.changeDialog.dateInput.fill(contract.start);
    });

    await step('Assert: Expected 1 — The date shows YYYY-MM-DD, never the locale format', async () => {
      await expect(fee.changeDialog.summaryValue(FEE_TEXT.dialog.currentEf), '[Expected 1] Current start date reads YYYY-MM-DD').toHaveText(contract.start);
      await expect(fee.changeDialog.dateInput, '[Expected 1] Placeholder reads YYYY-MM-DD').toHaveAttribute('placeholder', 'YYYY-MM-DD');
      await expect(fee.changeDialog.dateInput, '[Expected 1] The date field keeps YYYY-MM-DD').toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
      expect(await fee.changeDialog.root.innerText(), '[Expected 1] No MM/DD/YYYY date anywhere in the dialog').not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
      await fee.changeDialog.cancelButton.click();
    });
  });
});

