import { test, expect } from '@fixtures/fee-rate.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { getAccountDisplayName } from '@utils/auth-token';
import { isClipped } from '@utils/layout';
import { FEE_TEXT, KEY, FeeRowSpec, DEFAULT_ROWS, QUEUE_NOT_COMPUTABLE, addDays, inDays, keyLabel } from '@utils/fee-rate.data';

/**
 * US078 — nhóm [UI]: nhãn, cột, dialog, hàng đợi, trail. Nguồn TC: input/TESTCASE_US078_v2.md (Steps N / Expected N →
 * `Act: Step N` / `Assert: Expected N`). TC lệch UI → assert theo UI, ghi "Deviation from TC".
 * "In both English and Korean": giao diện KO là mặc định; bản EN mở bằng `?lang=en` (tham số ngôn ngữ của app) — mỗi ý có
 * nhãn TC ghi 2 thứ tiếng được assert ở cả 2 bản.
 */
const TAGS = ['ui', 'fee-rate', 'fee-rate-ui'];
const DATA = 'Data: automation-owned contract(s) created through the API (contracts cannot be deleted); pending requests are withdrawn in teardown.';
const WITH_FIXED_AND_GUARANTEE: FeeRowSpec[] = [...DEFAULT_ROWS, { ...KEY.FIXED, type: 'FIXED_UNIT', commission: 4000 }, { ...KEY.GUARANTEE, type: 'GUARANTEE_RUNNING', commission: 0 }];

test.describe('[UI] Labels, columns and dialogs of the fee rate feature', () => {
  test.describe.configure({ timeout: 150_000 });

  test('TC_US078_06 — The Fee Information tab shows all 14 columns and every new button, in English and Korean', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_06', 'Medium', TAGS, `The tab renders 14 columns, each labelled in Korean (default) and English (?lang=en); every saved row shows a change control (요율 수정 on Percent rows, 금액 수정 on the Fixed row) or, on the Guarantee row, the explanatory text; an 추가 button below the table, per-row status and 변경 이력 controls; no "Bulk draft" button. Deviation from TC: the change controls only render in the contract edit mode (계약 수정). ${DATA}`);
    let contract = { id: 0 };
    let englishHeaders: string[] = [];

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; a contract with its seeded fee rows (Percent, Fixed, Guarantee)', async () => {
      contract = await feeRateContracts.create('TC_US078_06', 'RUNNING', WITH_FIXED_AND_GUARANTEE);
    });

    await step('Act: Step 1 — Open the contract and click the Fee Information (수수료 정보) tab (English, then Korean edit mode)', async () => {
      await fee.open(contract.id, 'en');
      englishHeaders = (await fee.columnHeaders.allTextContents()).map((h) => h.trim());
      await fee.openEdit(contract.id);
    });

    await step('Assert: Expected 1 — 14 columns, each with an English and a Korean label', async () => {
      await expect(fee.columnHeaders, '[Expected 1] The table has 14 columns').toHaveCount(14);
      for (const label of FEE_TEXT.columns) {
        await expect(fee.columnHeaders.filter({ hasText: new RegExp(`^${label.replace(/[()]/g, '\\$&')}$`) }), `[Expected 1] Korean column "${label}" is shown`).toHaveCount(1);
      }
      for (const label of FEE_TEXT.columnsEn) {
        expect(englishHeaders, `[Expected 1] English column "${label}" is shown`).toContain(label);
      }
    });

    await step('Assert: Expected 2 — Change control (or explanatory text) per row, 추가 below the table, status / history controls, no "Bulk draft"', async () => {
      for (const key of [KEY.MD, KEY.ALBUM, KEY.FANCLUB]) {
        await expect(fee.rowButton(fee.row(key), FEE_TEXT.btnChangeRate), `[Expected 2] ${keyLabel(key)} shows 요율 수정 (Change rate)`).toBeVisible();
      }
      await expect(fee.rowButton(fee.row(KEY.FIXED), FEE_TEXT.btnChangeAmount), '[Expected 2] The Fixed row shows 금액 수정 (Change amount)').toBeVisible();
      await expect(fee.row(KEY.GUARANTEE).getByText(FEE_TEXT.complexNote), '[Expected 2] The Guarantee row shows the explanatory text instead').toBeVisible();
      await expect(fee.addButton, '[Expected 2] An 추가 (Add) button is shown below the table').toBeVisible();
      for (const key of [KEY.MD, KEY.ALBUM, KEY.FANCLUB, KEY.FIXED, KEY.GUARANTEE]) {
        await expect(fee.rowButton(fee.row(key), FEE_TEXT.btnDeactivate), `[Expected 2] ${keyLabel(key)} has a Status control`).toBeVisible();
        await expect(fee.rowButton(fee.row(key), FEE_TEXT.btnHistory), `[Expected 2] ${keyLabel(key)} has a History control`).toBeVisible();
      }
      await expect(page.getByRole('button', { name: /Bulk draft|일괄/ }), '[Expected 2] No "Bulk draft" button anywhere on the tab').toHaveCount(0);
    });
  });

  test('TC_US078_07 — The Change fee rate dialog shows every label, hint and button, in English and Korean', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_07', 'Medium', TAGS, `The dialog shows a read-only summary (key, current rate 10 %, current start date), two unselected radios 정정 / 변경, "New rate (%)" with placeholder "e.g., 8.5", "Effective from" with "YYYY-MM-DD", "Reason (required)" with its placeholder, and a disabled Submit — checked in the Korean UI and in the English UI (?lang=en). ${DATA}`);
    let contract = { id: 0, start: '' };
    const english: Record<string, string> = {};

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; a contract has MD · 전체 위탁 · 일반 · 비율 · 10 %', async () => {
      contract = await feeRateContracts.create('TC_US078_07', 'RUNNING');
    });

    await step('Act: Step 1 — Open the contract, tab Fee Information, click Change rate on the MD row (English, then Korean)', async () => {
      await fee.openEditEnglish(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD));
      const d = fee.changeDialog;
      english.correction = ((await d.correctionOption.locator('strong').textContent()) ?? '').trim();
      english.rateChange = ((await d.rateChangeOption.locator('strong').textContent()) ?? '').trim();
      english.rateLabel = ((await d.rateLabel.textContent()) ?? '').trim();
      english.ratePlaceholder = (await d.rateInput.getAttribute('placeholder')) ?? '';
      english.dateLabel = ((await d.root.locator('label.form-label').nth(1).textContent()) ?? '').trim();
      english.reasonLabel = ((await d.reasonLabel.textContent()) ?? '').trim();
      english.reasonPlaceholder = (await d.reasonInput.getAttribute('placeholder')) ?? '';
      english.submit = ((await d.submitButton.textContent()) ?? '').trim();
      await d.closeIcon.click();
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD));
    });

    await step('Assert: Expected 1 — Summary, two unselected kinds, rate / date / reason fields with placeholders, disabled Submit', async () => {
      const d = fee.changeDialog;
      await expect(d.summaryValue(FEE_TEXT.dialog.rowLabel), '[Expected 1] Summary shows the row key').toHaveText(keyLabel(KEY.MD));
      await expect(d.summaryValue(FEE_TEXT.dialog.currentRate), '[Expected 1] Summary shows the current rate 10 %').toHaveText('10 %');
      await expect(d.summaryValue(FEE_TEXT.dialog.currentEf), '[Expected 1] Summary shows the current start date').toHaveText(contract.start);
      await expect(d.correctionOption.locator('strong'), '[Expected 1] Radio "정정 — 처음부터 잘못 등록된 요율"').toHaveText(FEE_TEXT.dialog.correctionHead);
      await expect(d.rateChangeOption.locator('strong'), '[Expected 1] Radio "변경 — 특정 일자부터 요율이 실제로 바뀜"').toHaveText(FEE_TEXT.dialog.changeHead);
      await expect(d.correctionRadio, '[Expected 1] Correction is not pre-selected').not.toBeChecked();
      await expect(d.rateChangeRadio, '[Expected 1] Rate change is not pre-selected').not.toBeChecked();
      expect(english.correction, '[Expected 1] English radio reads "Correction (정정) — the rate was wrong from the start"').toBe('Correction (정정) — the rate was wrong from the start');
      expect(english.rateChange, '[Expected 1] English radio reads "Rate change (변경) — the rate genuinely changes from a date"').toBe('Rate change (변경) — the rate genuinely changes from a date');
      await expect(d.rateLabel, '[Expected 1] Rate input label reads 새 요율 (%)').toHaveText(FEE_TEXT.dialog.newPercent);
      await expect(d.rateInput, '[Expected 1] Rate placeholder reads 예: 8.5').toHaveAttribute('placeholder', FEE_TEXT.dialog.ratePlaceholder);
      expect(english.rateLabel, '[Expected 1] English label "New rate (%)"').toBe('New rate (%)');
      expect(english.ratePlaceholder, '[Expected 1] English placeholder "e.g., 8.5"').toBe('e.g., 8.5');
      await expect(d.root.locator('label.form-label').nth(1), '[Expected 1] Date field label reads 적용 시작일').toHaveText(FEE_TEXT.dialog.effectiveFrom);
      await expect(d.dateInput, '[Expected 1] Date placeholder reads YYYY-MM-DD').toHaveAttribute('placeholder', FEE_TEXT.dialog.datePlaceholder);
      expect(english.dateLabel, '[Expected 1] English label "Effective from"').toBe('Effective from');
      await expect(d.reasonLabel, '[Expected 1] Reason label reads 사유 (필수)').toHaveText(FEE_TEXT.dialog.reason);
      await expect(d.reasonInput, '[Expected 1] Reason placeholder').toHaveAttribute('placeholder', FEE_TEXT.dialog.reasonPlaceholder);
      expect(english.reasonLabel, '[Expected 1] English label "Reason (required)"').toBe('Reason (required)');
      expect(english.reasonPlaceholder, '[Expected 1] English placeholder "e.g., Annex signed 2026-09-10 raises the rate to 9 %"').toBe('e.g., Annex signed 2026-09-10 raises the rate to 9 %');
      await expect(d.submitButton, '[Expected 1] Submit reads 승인 요청').toHaveText(FEE_TEXT.dialog.submit);
      await expect(d.submitButton, '[Expected 1] Submit is disabled').toBeDisabled();
      expect(english.submit, '[Expected 1] English Submit reads "Submit for approval"').toBe('Submit for approval');
    });
  });

  test('TC_US078_08 — The fee row History dialog shows its five columns, and the no-history message', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_08', 'Medium', TAGS, `History of a changed row has five columns 시점 / 수행자 / 항목 / 변경 내용 / 사유 (English: When / Who / Setting / Change / Reason) and the Setting column reads the field name "수수료율", never a code; a never-changed row shows "아직 변경 이력이 없습니다" + "이 수수료 행은 등록된 뒤 변경된 적이 없습니다.". Deviation from TC: the MD row's change on record is a pending correction (an approved one needs a second approver — decision 28/09). ${DATA}`);
    let contract = { id: 0 };
    let englishHeaders: string[] = [];

    await step('Arrange: Pre-condition 1–3 — Logged in as ADMIN; MD row has a change on record; Fan Club row never changed', async () => {
      contract = await feeRateContracts.create('TC_US078_08', 'RUNNING');
      await feeRateContracts.submit(contract.id, KEY.MD, { changeKind: 'CORRECTION', commission: '8', changeReason: 'Contract says 8%, corrected from a 10% keying error' });
    });

    await step('Act: Step 1 — Open the contract, tab Fee Information, click History on the MD row', async () => {
      await fee.open(contract.id, 'en');
      await fee.openHistory(fee.row(KEY.MD));
      englishHeaders = (await fee.historyDialog.headers.allTextContents()).map((h) => h.trim());
      await fee.historyDialog.close();
      await fee.open(contract.id);
      await fee.openHistory(fee.row(KEY.MD));
    });

    await step('Assert: Expected 1 — Five columns When / Who / Setting / Change / Reason; Setting shows the field name', async () => {
      await expect(fee.historyDialog.headers, '[Expected 1] Korean columns 시점 · 수행자 · 항목 · 변경 내용 · 사유').toHaveText([...FEE_TEXT.history.columns]);
      expect(englishHeaders, '[Expected 1] English columns When · Who · Setting · Change · Reason').toEqual([...FEE_TEXT.history.columnsEn]);
      await expect(fee.historyDialog.cell(0, 'setting'), '[Expected 1] Setting reads the field name 수수료율, not an internal code').toHaveText(FEE_TEXT.history.fieldRate);
    });

    await step('Act: Step 2 — Close the dialog, click History on the Fan Club row', async () => {
      await fee.historyDialog.close();
      await fee.openHistory(fee.row(KEY.FANCLUB));
    });

    await step('Assert: Expected 2 — "No changes recorded yet" with its subtitle instead of a table', async () => {
      await expect(fee.historyDialog.root.getByText(FEE_TEXT.history.emptyTitle, { exact: true }), '[Expected 2] "아직 변경 이력이 없습니다" (No changes recorded yet) is shown').toBeVisible();
      await expect(fee.historyDialog.root.getByText(FEE_TEXT.history.emptySub, { exact: true }), '[Expected 2] Subtitle "이 수수료 행은 등록된 뒤 변경된 적이 없습니다." is shown').toBeVisible();
      await expect(fee.historyDialog.rows.filter({ has: page.locator('td', { hasText: /\d{4}-\d{2}-\d{2}/ }) }), '[Expected 2] No history table row is rendered').toHaveCount(0);
    });
  });

  test('TC_US078_09 — The Withdraw request dialog shows the request detail and its note; Cancel leaves the request pending', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    const effective = inDays(3);
    await tcMeta('TC_US078_09', 'Medium', TAGS, `The 승인 요청 회수 dialog shows the request detail read-only (직전 승인값, 요청값 with dates, 변경 유형), the note "회수해도 수수료 행은 변경되지 않습니다. …" and 취소 / 회수; 취소 withdraws nothing. Deviation from TC: the rate-change date is run-relative (today + 3 days) instead of 2026-10-01; the English note wording differs from the TC ("Withdrawing leaves the fee row unchanged. A withdrawal is recorded in the trail as an event distinct from a rejection…") — only the Korean text, which matches the TC verbatim, is asserted. ${DATA}`);
    let contract = { id: 0, start: '' };

    await step('Arrange: Pre-condition 1–2 — Logged in as the submitter; Fan Club row has a pending request (6.5 % from today + 3 days)', async () => {
      contract = await feeRateContracts.create('TC_US078_09', 'RUNNING');
      await feeRateContracts.submit(contract.id, KEY.FANCLUB, { changeKind: 'RATE_CHANGE', commission: '6.5', effectiveFrom: effective, changeReason: 'Pending request for the withdraw dialog' });
    });

    await step('Act: Step 1 — Open the contract, tab Fee Information, click Withdraw (회수) on the Fan Club row', async () => {
      await fee.openEdit(contract.id);
      await fee.openWithdraw(fee.row(KEY.FANCLUB));
    });

    await step('Assert: Expected 1 — Request detail (previous, new, dates, kind), the note and 취소 / 회수 buttons', async () => {
      const d = fee.withdrawDialog;
      await expect(d.root.getByText(FEE_TEXT.withdraw.title, { exact: true }), '[Expected 1] Title 승인 요청 회수').toBeVisible();
      await expect(d.value('직전 승인값'), '[Expected 1] Previous value 7 % with its start date').toHaveText(`7 % · ${contract.start}`);
      await expect(d.value('요청값'), '[Expected 1] New value 6.5 % with its effective date').toHaveText(`6.5 % · ${effective}`);
      await expect(d.value('변경 유형'), '[Expected 1] The change kind is shown').toHaveText(/^변경/);
      await expect(d.notice, '[Expected 1] The withdraw note reads verbatim').toHaveText(FEE_TEXT.withdraw.notice);
      await expect(d.cancelButton, '[Expected 1] 취소 (Cancel) button').toBeVisible();
      await expect(d.confirmButton, '[Expected 1] 회수 (Withdraw) button').toBeVisible();
    });

    await step('Act: Step 2 — Click 취소 (Cancel) instead of confirming', async () => {
      await fee.withdrawDialog.cancelButton.click();
    });

    await step('Assert: Expected 2 — The dialog closes; the Fan Club row still reads 승인 대기', async () => {
      await expect(fee.withdrawDialog.root, '[Expected 2] The dialog closes').toHaveCount(0);
      await expect(fee.cell(fee.row(KEY.FANCLUB), 'approval'), '[Expected 2] The row still reads 승인 대기').toContainText(FEE_TEXT.approval.PENDING);
    });
  });

  test('TC_US078_10 — The approval queue shows the fee row detail, the proposed change and the impact box', async ({ page, feeRateContracts, changeApprovalQueuePage: queue }) => {
    const step = makeStep(page);
    const effective = inDays(3);
    const reason = 'Queue detail check — rate change on Fan Club';
    await tcMeta('TC_US078_10', 'Medium', TAGS, `The Fee Rate request detail shows the change summary (register, record, kind, maker), the maker's reason, the proposed change with the current 7 % and proposed 6.5 % values, and the impact preview reading "산출 불가" (not computable). Deviation from TC: the request is the APPROVER's own (only one contract-capable account exists — decision 28/09); the rate-change date is run-relative (today + 3 days). ${DATA}`);
    let submitted: { changeApprovalId?: number | null } = {};

    await step('Arrange: Pre-condition 1–2 — Logged in as APPROVER; a pending Fan Club request (7 % → 6.5 % from today + 3 days)', async () => {
      const contract = await feeRateContracts.create('TC_US078_10', 'RUNNING');
      submitted = await feeRateContracts.submit(contract.id, KEY.FANCLUB, { changeKind: 'RATE_CHANGE', commission: '6.5', effectiveFrom: effective, changeReason: reason });
    });

    await step('Act: Step 1 — Go to 변경 승인, filter 원장 to Fee Rate and open the request', async () => {
      await queue.openRequest({ register: FEE_TEXT.queue.register, requester: getAccountDisplayName('approver'), changeApprovalId: submitted.changeApprovalId!, reason });
    });

    await step('Assert: Expected 1 — Fee row context, the maker reason, the proposed change and the impact box', async () => {
      await expect(queue.changeSummaryHeading, '[Expected 1] The change summary (fee row context) is shown').toBeVisible();
      await expect(queue.panelValue('원장'), '[Expected 1] The register reads Fee Rate').toHaveText(FEE_TEXT.queue.register);
      await expect(queue.reasonBlock, "[Expected 1] The maker's reason is shown").toHaveText(reason);
      await expect(queue.changeContentHeading, '[Expected 1] The proposed change section is shown').toBeVisible();
      await expect(queue.changeContentHeading.locator('xpath=following-sibling::*[1]'), '[Expected 1] The proposed value 6.5 is shown').toContainText('6.5');
      await expect(queue.changeContentHeading.locator('xpath=following-sibling::*[1]'), '[Expected 1] The current value 7 is shown').toContainText('7');
      await expect(queue.impactPreviewHeading, '[Expected 1] The impact box is shown').toBeVisible();
      await expect(queue.impactSection, '[Expected 1] The impact reads not computable').toContainText(QUEUE_NOT_COMPUTABLE);
    });
  });

  test('TC_US078_11 — The fee rate change trail shows all nine columns', async ({ page, feeRateContracts, contractHistoryPage: history }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_11', 'Medium', TAGS, `The contract's 변경 히스토리 screen shows the 수수료율 수정 이력 trail with nine columns 시점 · 구분 · 수수료 행 · 수수료 (전 → 후) · 적용 시작일 · 영향 주문 라인 · 정산 차액 · 수행자 · 사유 and one row for the Album 8 % → 9 % change. Deviation from TC: the change is applied on a not-yet-started contract (applies without approval — an approved one needs a second approver, decision 28/09). ${DATA}`);
    let contract = { id: 0, name: '', start: '' };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; Album row has one applied rate change 8 % → 9 % (start + 15 days)', async () => {
      contract = await feeRateContracts.create('TC_US078_11', 'NOT_STARTED');
      await feeRateContracts.submit(contract.id, KEY.ALBUM, { changeKind: 'RATE_CHANGE', commission: '9', effectiveFrom: addDays(contract.start, 15), changeReason: 'Annex raises the album rate to 9%' });
    });

    await step("Act: Step 1 — Open the contract's Change history (변경 히스토리) and scroll to the fee-rate change trail", async () => {
      await history.openFromList(contract.name);
      await history.trailTable.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — Nine columns, with one row for the 8 % → 9 % change', async () => {
      await expect(history.trailHeaders, '[Expected 1] The trail has the nine columns').toHaveText([...FEE_TEXT.trail.columns]);
      await expect(history.trailRows, '[Expected 1] One row for the change').toHaveCount(1);
      await expect(history.trailRows.first(), '[Expected 1] The row shows 8 % → 9 %').toContainText(/8\s*%.*9\s*%/);
    });
  });

  test('TC_US078_12 — A very long reason is cut short with three dots and shows in full on hover', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    const base = 'Corrected from 10% to 8% to match the signed contract document. The original 10% figure was keyed in by mistake at product registration and never matched the contract terms as signed with the partner';
    // Đủ 200 ký tự và KHÔNG kết thúc bằng dấu cách — app trim khoảng trắng cuối khi lưu (TC_54).
    const reason = `${`${base} ${base}`.slice(0, 199)}.`;
    await tcMeta('TC_US078_12', 'Medium', TAGS, `In the MD row history the 200-character reason is cut with "..." (the cell clips its text) and hovering it shows the full reason. Deviation from TC: the correction is pending, not approved (a second approver is needed for approval — decision 28/09). ${DATA}`);
    let contract = { id: 0 };
    let hoverText = '';

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the MD row has a correction whose reason is exactly 200 characters', async () => {
      expect(reason.length, 'The reason is exactly 200 characters').toBe(200);
      contract = await feeRateContracts.create('TC_US078_12', 'RUNNING');
      await feeRateContracts.submit(contract.id, KEY.MD, { changeKind: 'CORRECTION', commission: '8', changeReason: reason });
    });

    await step('Act: Step 1 — Open the contract, click History on the MD row', async () => {
      await fee.open(contract.id);
      await fee.openHistory(fee.row(KEY.MD));
    });

    await step('Assert: Expected 1 — The Reason cell shows the text cut short with "..."', async () => {
      const cell = fee.historyDialog.cell(0, 'reason');
      const shown = ((await cell.innerText()) ?? '').trim();
      const cssEllipsis = (await isClipped(cell)) && (await cell.evaluate((el) => [el, ...Array.from(el.querySelectorAll('*'))].some((node) => getComputedStyle(node).textOverflow === 'ellipsis')));
      expect(cssEllipsis || (shown.length < reason.length && /(…|\.\.\.)$/.test(shown)), `[Expected 1] The reason is cut short with "..." (shown: "${shown}")`).toBe(true);
    });

    await step('Act: Step 2 — Hover the Reason cell of that entry, without clicking', async () => {
      hoverText = await fee.historyDialog.fullText(0, 'reason');
    });

    await step('Assert: Expected 2 — A tooltip shows the full 200-character reason', async () => {
      expect(hoverText.trim(), '[Expected 2] The hover text is the full 200-character reason').toBe(reason);
    });
  });
});
