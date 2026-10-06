import { test, expect } from '@fixtures/fee-rate.fixture';
import { makeStep } from '@utils/step';
import { ContractFeePage } from '@pages/contract-fee.page';
import { skipTc, tcMeta } from '@utils/tc-meta';
import { getAccountDisplayName } from '@utils/auth-token';
import { FEE_TEXT, KEY, FeeKey, FeeRowSpec, DEFAULT_ROWS, QUEUE_NOT_COMPUTABLE, addDays, addRowBody, inDays, keyLabel } from '@utils/fee-rate.data';

/**
 * US078 — nhóm [Fee Tab]: thêm / sửa / bật tắt fee row, cổng duyệt, khoá khi có đơn chờ, trạng thái hiển thị.
 * Nguồn TC: input/TESTCASE_US078_v2.md (Steps N / Expected N → `Act: Step N` / `Assert: Expected N`).
 * Kỳ vọng assert theo TC; chỗ UI thật khác TC được ghi "Deviation from TC" và báo BA (automation_rules.md 6.1 bước 3).
 * Dữ liệu: contract automation tạo qua API (không xoá được); đơn còn chờ rút lại ở teardown. Contract "chưa bắt đầu"
 * (áp dụng ngay, không cần duyệt) thay cho tiền điều kiện "đã được duyệt" khi TC cần — chỉ có 1 account (quyết định 28/09).
 */
const TAGS = ['ui', 'fee-rate', 'fee-rate-tab'];
const DATA = 'Data: automation-owned contract(s) created through the API (contracts cannot be deleted); pending requests are withdrawn in teardown.';
const APPLIED_INSTEAD = 'the "approved change" pre-condition is built on a not-yet-started contract, where the change applies at once without approval (a second approver is needed otherwise — decision 28/09)';
const NO_RULE_CODE = /\b(CNT|BR|W-CNT|CHG)-?\d+/;
const CORRECTION_REASON = 'Contract says 8%, corrected from a 10% keying error';
const FANCLUB_KIT_SELF: FeeKey = { category: 'FANCLUB_KIT', saleType: 'SELF' };
const FANCLUB_KIT_CONSIGNMENT: FeeKey = { category: 'FANCLUB_KIT', saleType: 'CONSIGNMENT' };

test.describe('[Fee Tab] Adding, changing and switching fee rows', () => {
  test.describe.configure({ timeout: 180_000 });

  test('TC_US078_13 — Fee rows added while creating a contract apply straight away and start from the contract start date', async ({ page, feeRateApi, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_13', 'Critical', [...TAGS, 'create'], `On 새 계약서 등록 the operator adds MD · 전체 위탁 · 일반 · 비율 · 8 % with no start date (row shows 작성 중, no reason asked); after registering, the row reads 적용됨, has no pending request, and its 적용 시작일 is the contract start (2026-06-01 → here 2026-01-01 run contract). Deviation from TC: the 비즈파트너 search popup never finishes loading on dev ("Loading..." — verified 28/09), so the Register step saves the same contract data through POST /contracts; the contract code is system-generated (26099TB-M1-0-MD cannot be chosen). ${DATA}`);
    let contract = { id: 0, start: '' };
    let reasonDialogs = 0;

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; no contract of this test exists yet', async () => {
      await page.goto('/commerce/contracts');
    });

    await step('Act: Step 1 — Go to Contract management and click New Contract Registration (새 계약서 등록)', async () => {
      await page.goto('/commerce/contracts?view=create');
    });

    await step('Assert: Expected 1 — The New Contract Registration form opens for data entry', async () => {
      await expect(page.getByText('새 계약서 등록', { exact: true }), '[Expected 1] The 새 계약서 등록 form is shown').toBeVisible();
      await expect(page.getByPlaceholder('계약서명을 입력하세요'), '[Expected 1] Contract name is editable').toBeEditable();
    });

    await step('Act: Step 2 — On tab Fee Information click Add and fill MD · 전체 위탁 · 일반 · 비율 · 8 %, start date empty', async () => {
      await fee.feeTab.click();
      await fee.addButton.click();
      await fee.fillNewRow({ ...KEY.MD, rate: 8 });
      reasonDialogs = await fee.reasonDialog.root.count();
    });

    await step('Assert: Expected 2 — The new row appears with 8 % and Approval 작성 중', async () => {
      await expect(fee.cell(fee.newRow, 'fee').locator('input'), '[Expected 2] The new row holds 8').toHaveValue('8');
      await expect(fee.approvalBadge(fee.newRow), '[Expected 2] Approval reads 작성 중 (Draft)').toHaveText(FEE_TEXT.approval.DRAFT);
    });

    await step('Act: Step 3 — Register the whole contract (same data saved through the API — see Deviation)', async () => {
      contract = await feeRateContracts.create('TC_US078_13', 'RUNNING', [{ ...KEY.MD, commission: 8 }]);
      await fee.open(contract.id);
    });

    await step('Assert: Expected 3 — Applied with no pending request, Effective from = contract start, no reason ever asked', async () => {
      const row = fee.row(KEY.MD);
      await expect(fee.approvalBadge(row), '[Expected 3] Approval reads 적용됨 (Applied)').toHaveText(FEE_TEXT.approval.APPLIED);
      const rowId = await feeRateContracts.rowId(contract.id, KEY.MD);
      expect((await feeRateApi.history(contract.id, rowId)).filter((c) => c.status === 'PENDING'), '[Expected 3] No pending request was created').toHaveLength(0);
      await expect(fee.cell(row, 'effectiveFrom'), '[Expected 3] Effective from shows the contract start date').toContainText(contract.start);
      expect(reasonDialogs, '[Expected 3] No reason was asked for while keying the row on the creation form').toBe(0);
    });
  });

  test('TC_US078_14 — A contract with fee rows and no approval document link is accepted as it is, nothing flags it', async () => {
    await skipTc('TC_US078_14', 'High', TAGS, 'A contract with a fee row and an empty internal approval document URL renders its Fee Information tab with no flag.', 'the fixture cannot be built: POST /contracts refuses a contract with fee rows and no internal approval document URL ("수수료가 있는 계약은 내부 승인 문서 URL이 필요합니다", verified 29/09) and the TC says only Dev can prepare it — no such contract exists on dev');
  });

  test('TC_US078_15 — A promotion row can be registered before its campaign starts; the two dates are shown separately', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    const start = inDays(2);
    const promotion = { from: inDays(5), to: inDays(35) };
    await tcMeta('TC_US078_15', 'High', TAGS, `Adding MD · 부분 위탁 · 프로모션 · 20 % with start ${'{today+2}'} and promotion ${'{today+5}'}~${'{today+35}'} saves (on a running contract through the reason dialog) and shows Effective from and Promotion period as two separate values, with no error about them differing. Deviation from TC: dates are run-relative (TC 2026-09-20 / 2026-10-01~31 are already in the past or about to be). ${DATA}`);
    let contract = { id: 0 };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the contract never had a row on MD · 부분 위탁 · 프로모션', async () => {
      contract = await feeRateContracts.create('TC_US078_15', 'RUNNING');
    });

    await step('Act: Step 1 — Open the Fee Information tab, click Add and fill the promotion row', async () => {
      await fee.openEdit(contract.id);
      await fee.addButton.click();
      await fee.fillNewRow({ ...KEY.MD_PROMO, rate: 20, startDate: start, promotion });
    });

    await step('Assert: Expected 1 — The new row is added to the form for entry', async () => {
      await expect(fee.approvalBadge(fee.newRow), '[Expected 1] The new row reads 작성 중 (Draft)').toHaveText(FEE_TEXT.approval.DRAFT);
    });

    await step('Act: Step 2 — Save', async () => {
      const [saved] = await fee.saveWithReason('New promotion campaign agreed with the partner');
      expect(saved.status, 'The new fee row is sent to the register').toBeLessThan(300);
      await fee.open(contract.id);
    });

    await step('Assert: Expected 2 — Effective from and Promotion period show as two separate values, no error', async () => {
      const row = fee.row(KEY.MD_PROMO);
      await expect(fee.cell(row, 'effectiveFrom'), `[Expected 2] Effective from shows ${start}`).toContainText(start);
      await expect(fee.cell(row, 'promotion').locator('input').first(), `[Expected 2] Promotion period starts ${promotion.from}`).toHaveValue(promotion.from);
      await expect(fee.cell(row, 'promotion').locator('input').last(), `[Expected 2] Promotion period ends ${promotion.to}`).toHaveValue(promotion.to);
      await expect(fee.feePanelAlert, '[Expected 2] No error about the two dates differing').toHaveCount(0);
    });
  });

  test('TC_US078_16 — The first fee row of a category can start from the contract start date; the approver sees the impact status', async ({ page, feeRateContracts, contractFeePage: fee, changeApprovalQueuePage: queue }) => {
    const step = makeStep(page);
    const reason = 'First Fan Club Kit row from the contract start';
    await tcMeta('TC_US078_16', 'High', TAGS, `A first row on 팬클럽 키트 · 전체 위탁 · 일반 at 12 % starting on the contract start date saves; its request reaches 변경 승인 (Fee Rate) and the impact box reads "산출 불가" with a sentence naming the order lines it could affect. Deviation from TC: "Fan Club + Kit" maps to 팬클럽 키트 on dev. ${DATA}`);
    let contract = { id: 0, start: '' };
    let changeApprovalId: number | undefined;

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the contract never had a 팬클럽 키트 · 전체 위탁 · 일반 row', async () => {
      contract = await feeRateContracts.create('TC_US078_16', 'RUNNING');
    });

    await step("Act: Step 1 — Click Add and fill 팬클럽 키트 · 전체 위탁 · 일반 · 비율 · 12 % with the contract's own start date", async () => {
      await fee.openEdit(contract.id);
      await fee.addButton.click();
      await fee.fillNewRow({ ...FANCLUB_KIT_SELF, rate: 12, startDate: contract.start });
    });

    await step("Assert: Expected 1 — The row is added for entry with the contract's start date", async () => {
      await expect(fee.cell(fee.newRow, 'effectiveFrom').locator('input'), '[Expected 1] The start date holds the contract start').toHaveValue(contract.start);
    });

    await step('Act: Step 2 — Save, then open the resulting request in 변경 승인 (원장 = Fee Rate)', async () => {
      const [saved] = await fee.saveWithReason(reason);
      changeApprovalId = saved?.body?.changeApprovalId;
      await queue.openRequest({ register: FEE_TEXT.queue.register, requester: getAccountDisplayName('approver'), changeApprovalId: changeApprovalId!, reason });
    });

    await step('Assert: Expected 2 — The request reaches the queue; its impact box reads not computable with an order-line sentence', async () => {
      expect(changeApprovalId, '[Expected 2] A change approval request was created').toBeTruthy();
      const impact = queue.impactSection;
      await expect(impact, '[Expected 2] The impact box reads not computable').toContainText(QUEUE_NOT_COMPUTABLE);
      await expect(impact, '[Expected 2] A sentence names how many order lines it could affect').toContainText(/주문 라인|order line/i);
    });
  });

  test('TC_US078_17 — Editing a rate, adding a row and switching a row off on a running contract all wait for approval', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_17', 'Critical', TAGS, `On a running contract: a correction keeps the MD row at 10 % with 승인 대기; a new 팬클럽 키트 row saves as 승인 대기; switching a row to inactive opens a reason dialog naming the direction and, after submitting, the row stays 활성 with 승인 대기. Not automated: "no order priced by it yet" (needs settlement data). Deviation from TC: step 3 is done on the Album row — the MD row already carries the pending correction from step 1, and a row with a pending request cannot take a second one (BR-3.V0). ${DATA}`);
    let contract = { id: 0 };
    let deactivateDialog = { title: '', body: '' };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; a running contract has MD · 10 %, saved and Active', async () => {
      contract = await feeRateContracts.create('TC_US078_17', 'RUNNING');
    });

    await step('Act: Step 1 — Change rate on MD: 정정, rate 8, reason, click 승인 요청', async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD));
      await fee.changeDialog.fill({ kind: 'correction', rate: '8', reason: CORRECTION_REASON });
      await fee.changeDialog.submit();
    });

    await step('Assert: Expected 1 — The MD row still reads 10 % and 승인 대기', async () => {
      await expect(fee.cell(fee.row(KEY.MD), 'fee').locator('input'), '[Expected 1] The value has not changed yet (10)').toHaveValue('10');
      await expect(fee.approvalBadge(fee.row(KEY.MD)), '[Expected 1] Approval reads 승인 대기').toHaveText(FEE_TEXT.approval.PENDING);
    });

    await step('Act: Step 2 — Click Add, fill 팬클럽 키트 · 전체 위탁 · 일반 · 비율 · 12 % with no start date, save the contract', async () => {
      await fee.addButton.click();
      await fee.fillNewRow({ ...FANCLUB_KIT_SELF, rate: 12 });
      await fee.saveWithReason('New Fan Club Kit line agreed with the partner');
      await fee.openEdit(contract.id);
    });

    await step("Assert: Expected 2 — The new row's Approval reads 승인 대기", async () => {
      await expect(fee.approvalBadge(fee.row(FANCLUB_KIT_SELF)), '[Expected 2] The new row reads 승인 대기').toHaveText(FEE_TEXT.approval.PENDING);
    });

    await step('Act: Step 3 — Switch the Status toggle on the Album row from Active to Inactive and submit the reason', async () => {
      await fee.clickStatusToggle(fee.row(KEY.ALBUM));
      await expect(fee.reasonDialog.root, 'The reason dialog opens').toBeVisible();
      deactivateDialog = { title: ((await fee.reasonDialog.title.textContent()) ?? '').trim(), body: ((await fee.reasonDialog.root.locator('.modal-body').textContent()) ?? '').trim() };
      await fee.reasonDialog.reasonInput.fill('Category being retired, replaced by a new row');
      await fee.reasonDialog.submitButton.click();
      await expect(fee.reasonDialog.root, 'The reason dialog closes').toHaveCount(0);
    });

    await step('Assert: Expected 3 — A reason dialog named the direction; the row still shows 활성 and reads 승인 대기', async () => {
      expect(deactivateDialog.title, '[Expected 3] The dialog names the direction (수수료 행 비활성화)').toBe(FEE_TEXT.reasonDialog.deactivateTitle);
      expect(deactivateDialog.body, '[Expected 3] The body asks to deactivate this row').toContain(FEE_TEXT.reasonDialog.deactivateBody(keyLabel(KEY.ALBUM)));
      await expect(fee.cell(fee.row(KEY.ALBUM), 'status'), '[Expected 3] Status still shows 활성').toHaveText(FEE_TEXT.statusActive);
      await expect(fee.approvalBadge(fee.row(KEY.ALBUM)), '[Expected 3] Approval reads 승인 대기').toHaveText(FEE_TEXT.approval.PENDING);
    });
  });

  test('TC_US078_18 — Adding fee rows on a running contract opens the reason dialog with no change-kind choice and waits for approval', async ({ page, feeRateApi, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    const reason = 'New consignment lines agreed with the partner on 2026-09-20';
    await tcMeta('TC_US078_18', 'Critical', TAGS, `Two new rows keyed in one save (팬클럽 키트 · 부분 위탁 · 9 %, MD · 부분 위탁 · 11 %) open ONE reason dialog with no 정정 / 변경 choice — only the reason field and its counter, with a sentence stating these are new fee rows; submitting places both rows at 승인 대기, each request carrying the one reason. Not automated: "no order priced by either yet". Deviation from TC: the reason dialog opens when the contract is saved (step 3), not while keying each row, so the dialog ideas of Expected 1 and 2 are observed when it opens and asserted in their own steps afterwards. ${DATA}`);
    let contract = { id: 0 };
    const dialog = { radios: -1, counter: false, body: '', reasonFields: -1 };
    let responses: Array<{ status: number }> = [];

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the contract never had rows on 팬클럽 키트 · 부분 위탁 · 일반 nor MD · 부분 위탁 · 일반', async () => {
      contract = await feeRateContracts.create('TC_US078_18', 'RUNNING');
    });

    await step('Act: Step 1 — Click Add and fill 팬클럽 키트 · 부분 위탁 · 일반 · 비율 · 9 %, no start date', async () => {
      await fee.openEdit(contract.id);
      await fee.addButton.click();
      await fee.fillNewRow({ ...FANCLUB_KIT_CONSIGNMENT, rate: 9 });
    });

    await step('Assert: Expected 1 — The row is added for entry', async () => {
      await expect(fee.approvalBadge(fee.newRow), '[Expected 1] The first new row reads 작성 중').toHaveText(FEE_TEXT.approval.DRAFT);
    });

    await step('Act: Step 2 — Before saving, click Add again and key MD · 부분 위탁 · 일반 · 비율 · 11 %, no start date', async () => {
      await fee.addButton.click();
      await fee.fillNewRow({ ...KEY.MD_CONSIGNMENT, rate: 11 });
    });

    await step('Assert: Expected 2 — The second row is added for entry the same way', async () => {
      await expect(fee.approvalBadge(fee.newRow), '[Expected 2] The second new row reads 작성 중').toHaveText(FEE_TEXT.approval.DRAFT);
    });

    await step('Act: Step 3 — Save, enter the reason and click 승인 요청 (Submit for approval)', async () => {
      await fee.save();
      await expect(fee.reasonDialog.root, 'The reason dialog opens').toBeVisible();
      dialog.radios = await fee.reasonDialog.kindRadios.count();
      dialog.counter = await fee.reasonDialog.counter.isVisible();
      dialog.body = ((await fee.reasonDialog.root.locator('.modal-body').textContent()) ?? '').trim();
      dialog.reasonFields = await fee.reasonDialog.reasonInput.count();
      await fee.reasonDialog.reasonInput.fill(reason);
      responses = await fee.collectFeeRowPosts(() => fee.reasonDialog.submitButton.click(), 2);
    });

    await step('Assert: Expected 3 — Both rows at 승인 대기, each request carrying the one reason (dialog: no kind choice, one reason field)', async () => {
      expect(dialog.radios, '[Expected 1] The dialog offers no 정정 / 변경 choice').toBe(0);
      expect(dialog.counter, '[Expected 1] The reason field has its character counter').toBe(true);
      expect(dialog.body, '[Expected 1] A sentence states these are new fee rows').toContain('신규 수수료 행');
      expect(dialog.reasonFields, '[Expected 2] Only one reason field across the whole save').toBe(1);
      expect(responses.map((r) => r.status), '[Expected 3] Both rows are submitted').toHaveLength(2);
      await fee.openEdit(contract.id);
      for (const key of [FANCLUB_KIT_CONSIGNMENT, KEY.MD_CONSIGNMENT]) {
        await expect(fee.approvalBadge(fee.row(key)), `[Expected 3] ${keyLabel(key)} reads 승인 대기`).toHaveText(FEE_TEXT.approval.PENDING);
        const history = await feeRateApi.history(contract.id, await feeRateContracts.rowId(contract.id, key));
        expect(history.map((c) => c.reason), `[Expected 3] ${keyLabel(key)} request carries the one reason`).toContain(reason);
      }
    });
  });

  test('TC_US078_19 — Switching a row off on a running contract opens the reason dialog, names the direction and waits for approval', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_19', 'Critical', TAGS, `Clicking the Status toggle on MD opens "수수료 행 비활성화" naming the direction (Active → Inactive) with "이 행의 비활성화를 요청합니다. 승인되기 전까지는 계속 주문에 적용됩니다.", a required reason and its counter; submitting keeps the row 활성 with 승인 대기. ${DATA}`);
    let contract = { id: 0 };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; a running contract has MD · 10 %, saved and Active', async () => {
      contract = await feeRateContracts.create('TC_US078_19', 'RUNNING');
    });

    await step('Act: Step 1 — Click the Status toggle on the MD row to switch it to Inactive', async () => {
      await fee.openEdit(contract.id);
      await fee.clickStatusToggle(fee.row(KEY.MD));
    });

    await step('Assert: Expected 1 — The reason dialog names the direction, with the sentence, a required reason and its counter', async () => {
      const d = fee.reasonDialog;
      await expect(d.title, '[Expected 1] Title 수수료 행 비활성화 (Deactivate the fee row)').toHaveText(FEE_TEXT.reasonDialog.deactivateTitle);
      await expect(d.root, '[Expected 1] The direction Active → Inactive is named').toContainText(/활성\s*→\s*비활성|Active\s*→\s*Inactive/);
      await expect(d.root, '[Expected 1] Sentence "이 행의 비활성화를 요청합니다. 승인되기 전까지는 계속 주문에 적용됩니다."').toContainText('이 행의 비활성화를 요청합니다. 승인되기 전까지는 계속 주문에 적용됩니다.');
      await expect(d.root.getByText(FEE_TEXT.dialog.reason, { exact: true }), '[Expected 1] The reason field is marked required').toBeVisible();
      await expect(d.counter, '[Expected 1] The reason counter is shown').toHaveText('0 / 200');
      await expect(d.submitButton, '[Expected 1] Submit stays disabled without a reason').toBeDisabled();
    });

    await step('Act: Step 2 — Enter the reason and click 승인 요청 (Submit for approval)', async () => {
      await fee.reasonDialog.reasonInput.fill('Category being retired, replaced by a new row');
      await fee.reasonDialog.submitButton.click();
      await expect(fee.reasonDialog.root, 'The reason dialog closes').toHaveCount(0);
    });

    await step('Assert: Expected 2 — The row still shows 활성 and reads 승인 대기', async () => {
      await expect(fee.cell(fee.row(KEY.MD), 'status'), '[Expected 2] Status still shows 활성').toHaveText(FEE_TEXT.statusActive);
      await expect(fee.approvalBadge(fee.row(KEY.MD)), '[Expected 2] Approval reads 승인 대기').toHaveText(FEE_TEXT.approval.PENDING);
    });
  });

  test('TC_US078_20 — A change on a contract that has not started yet applies immediately with a notice and is written to history', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    const reason = 'Renegotiated rate before launch';
    let contract = { id: 0, start: '' };
    await tcMeta('TC_US078_20', 'High', TAGS, `On a not-yet-started contract the Change rate dialog shows the "no approval needed" notice and an "적용" (Apply) button; a rate change MD 30 % → 25 % applies at once and the history lists actor, before/after (30 % → 25 %) and reason. Deviation from TC: the contract starts tomorrow (not 2027-01-01) and the rate change starts on contract start + 15 days — a rate change dated on the contract start would collide with the existing row's own start date. ${DATA}`);

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; a not-yet-started contract has MD · 전체 위탁 · 일반 · 비율 · 30 %', async () => {
      contract = await feeRateContracts.create('TC_US078_20', 'NOT_STARTED', [{ ...KEY.MD, commission: 30 }]);
    });

    await step('Act: Step 1 — Open the contract, tab Fee Information, click Change rate on the MD row', async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD));
    });

    await step('Assert: Expected 1 — The dialog opens', async () => {
      await expect(fee.changeDialog.root, '[Expected 1] The Change rate dialog is open').toBeVisible();
    });

    await step('Act: Step 2 — Pick 변경 (Rate change), rate 25, effective from start + 15 days, the reason, click 적용 (Apply)', async () => {
      await fee.changeDialog.fill({ kind: 'rateChange', rate: '25', date: addDays(contract.start, 15), reason });
      await expect(fee.changeDialog.root.getByText(FEE_TEXT.dialog.gateTitle), 'The no-approval notice is shown').toBeVisible();
      await expect(fee.changeDialog.submitButton, 'The button reads 적용').toHaveText(FEE_TEXT.dialog.apply);
      await fee.changeDialog.submit();
    });

    await step('Assert: Expected 2 — A notice said no approval is needed, the button read 적용, and the row now shows 25 %', async () => {
      await expect(fee.toast(FEE_TEXT.appliedNoGate), '[Expected 2] The change applied immediately without approval').toBeVisible();
      await expect(fee.cell(fee.row(KEY.MD, addDays(contract.start, 15)), 'fee').locator('input'), '[Expected 2] The row now shows 25').toHaveValue('25');
    });

    await step('Act: Step 3 — Click History on the MD row', async () => {
      await fee.openHistory(fee.row(KEY.MD, contract.start));
    });

    await step('Assert: Expected 3 — The history lists the change with actor, before/after 30 % → 25 % and reason', async () => {
      const h = fee.historyDialog;
      await expect(h.cell(0, 'who'), '[Expected 3] The actor is shown').toHaveText(getAccountDisplayName('approver'));
      await expect(h.cell(0, 'change'), '[Expected 3] Before/after 30 % → 25 %').toContainText('30 % → 25 %');
      await expect(h.cell(0, 'reason'), '[Expected 3] The reason is shown').toHaveText(reason);
    });
  });

  test('TC_US078_21 — A fee row does not change while its request is waiting, and only one request can be open at a time', async ({ page, feeRateApi, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_21', 'Critical', TAGS, `While Fan Club has a pending request (6.5 %), the row still shows 7 % and 승인 대기, not the pending value; a second change is refused and the UI states a request is already pending. Deviation from TC: the pending row offers no 요율 수정 control (only 회수), so the second attempt is sent through the change endpoint and the refusal is asserted on its response. ${DATA}`);
    let contract = { id: 0 };
    let second = { status: 0, body: '' };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; Fan Club · 7 % has a pending request (6.5 % from today + 3 days)', async () => {
      contract = await feeRateContracts.create('TC_US078_21', 'RUNNING');
      await feeRateContracts.submit(contract.id, KEY.FANCLUB, { changeKind: 'RATE_CHANGE', commission: '6.5', effectiveFrom: inDays(3), changeReason: 'First pending request' });
    });

    await step('Act: Step 1 — Open the Fee Information tab and read the Fan Club row', async () => {
      await fee.openEdit(contract.id);
    });

    await step('Assert: Expected 1 — The row still shows 7 % and 승인 대기; the pending value is not shown', async () => {
      const row = fee.row(KEY.FANCLUB);
      await expect(fee.cell(row, 'fee').locator('input'), '[Expected 1] The row still shows 7').toHaveValue('7');
      await expect(fee.approvalBadge(row), '[Expected 1] Approval reads 승인 대기').toHaveText(FEE_TEXT.approval.PENDING);
      await expect(row, '[Expected 1] The pending value 6.5 is not shown on the row').not.toContainText('6.5');
    });

    await step('Act: Step 2 — Try to submit a second change on the same row (rate 5, reason "Second attempt")', async () => {
      const rowId = await feeRateContracts.rowId(contract.id, KEY.FANCLUB);
      const res = await feeRateApi.submitChange(contract.id, rowId, { changeKind: 'CORRECTION', commission: '5', changeReason: 'Second attempt' });
      second = { status: res.status, body: JSON.stringify(res.body) };
    });

    await step('Assert: Expected 2 — The second submission is refused because a request is already pending', async () => {
      await expect(fee.changeButton(fee.row(KEY.FANCLUB)), '[Expected 2] The pending row offers no second Change rate').toHaveCount(0);
      expect(second.status, `[Expected 2] The second submission is refused (response: ${second.body})`).toBeGreaterThanOrEqual(400);
      expect(second.body, '[Expected 2] The refusal states a change is already pending').toMatch(/대기|pending/i);
    });
  });

  test('TC_US078_22 — The sender can withdraw a waiting request, the row stays as it was, and the row can be sent again', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_22', 'High', TAGS, `Withdrawing the pending Fan Club request needs no reason; the row still shows 7 % and 적용됨 (not 승인 대기); a new request (6.8 %, "Adjusted proposal") can be submitted and the row reads 승인 대기 again. Deviation from TC: the new request is sent as a correction (the TC names no kind). ${DATA}`);
    let contract = { id: 0 };
    let resubmit = 0;

    await step('Arrange: Pre-condition 1–2 — Logged in as the submitter; Fan Club · 7 % has a pending request (6.5 %)', async () => {
      contract = await feeRateContracts.create('TC_US078_22', 'RUNNING');
      await feeRateContracts.submit(contract.id, KEY.FANCLUB, { changeKind: 'RATE_CHANGE', commission: '6.5', effectiveFrom: inDays(3), changeReason: 'Pending request to withdraw' });
    });

    await step('Act: Step 1 — Click Withdraw (회수) on the Fan Club row and confirm 회수', async () => {
      await fee.openEdit(contract.id);
      await fee.openWithdraw(fee.row(KEY.FANCLUB));
      await fee.withdrawDialog.confirmButton.click();
    });

    await step('Assert: Expected 1 — The withdrawal completes with no reason required', async () => {
      await expect(fee.toast(FEE_TEXT.withdrawnDone), '[Expected 1] "회수되었습니다. 수수료 행은 변경되지 않았습니다." is shown').toBeVisible();
      await expect(fee.withdrawDialog.root.locator('textarea'), '[Expected 1] No reason was asked for').toHaveCount(0);
    });

    await step("Act: Step 2 — Read the row's value and Approval column", async () => {
      await fee.row(KEY.FANCLUB).scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — The row still shows 7 % and reads 적용됨, not 승인 대기', async () => {
      await expect(fee.cell(fee.row(KEY.FANCLUB), 'fee').locator('input'), '[Expected 2] The row still shows 7').toHaveValue('7');
      await expect(fee.approvalBadge(fee.row(KEY.FANCLUB)), '[Expected 2] Approval reads 적용됨 (Applied)').toHaveText(FEE_TEXT.approval.APPLIED);
    });

    await step('Act: Step 3 — Click Change rate on the same row and submit a new request: rate 6.8, reason "Adjusted proposal"', async () => {
      await fee.openChangeDialog(fee.row(KEY.FANCLUB));
      await fee.changeDialog.fill({ kind: 'correction', rate: '6.8', reason: 'Adjusted proposal' });
      resubmit = (await fee.changeDialog.submit()).status;
    });

    await step('Assert: Expected 3 — The new request submits and the row reads 승인 대기 again', async () => {
      expect(resubmit, '[Expected 3] The new request is accepted (201)').toBe(201);
      await expect(fee.approvalBadge(fee.row(KEY.FANCLUB)), '[Expected 3] Approval reads 승인 대기 again').toHaveText(FEE_TEXT.approval.PENDING);
    });
  });

  test('TC_US078_23 — Only the person who sent the request sees the Withdraw button', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_23', 'High', TAGS, `The submitter sees 회수 on the pending Fan Club row. Not automated: step 2 / Expected 2 (a different ADMIN sees no Withdraw button) — no second account with contract access exists (only dungbd.fpt — decision 28/09). ${DATA}`);
    let contract = { id: 0 };

    await step('Arrange: Pre-condition 1–2 — Logged in as the submitter; Fan Club has a pending request submitted by this user', async () => {
      contract = await feeRateContracts.create('TC_US078_23', 'RUNNING');
      await feeRateContracts.submit(contract.id, KEY.FANCLUB, { changeKind: 'CORRECTION', commission: '6.5', changeReason: 'Pending request of the submitter' });
    });

    await step("Act: Step 1 — Open the Fee Information tab and look at the Fan Club row's controls as the submitter", async () => {
      await fee.openEdit(contract.id);
    });

    await step('Assert: Expected 1 — A Withdraw button is visible on the row', async () => {
      await expect(fee.rowButton(fee.row(KEY.FANCLUB), FEE_TEXT.btnWithdraw), '[Expected 1] 회수 (Withdraw) is visible').toBeVisible();
    });

    // Step 2 / Expected 2 cần account ADMIN thứ hai có quyền contract — không tồn tại (quyết định 28/09): giữ step, ghi Not automated.
    await step('Act: Step 2 — Log in as a different ADMIN and open the same tab (Not automated — no second account)', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Step 2: no second ADMIN account with contract access exists' });
    });

    await step('Assert: Expected 2 — No Withdraw button for another user (Not automated — no second account)', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Expected 2: no second ADMIN account with contract access exists' });
    });
  });

  test('TC_US078_24 — Withdrawing a request that the approver has just decided fails with a message', async () => {
    await skipTc('TC_US078_24', 'High', TAGS, 'A withdraw sent after the approver approved the request fails with a message instead of doing nothing.', 'needs an APPROVER different from the submitter to approve the request (SoD blocks self-approval; only dungbd.fpt is available — decision 28/09); the TC itself also marks the message wording ⚠ NEEDS CLARIFICATION');
  });

  test('TC_US078_25 — Switching an inactive row back on creates a new row with an empty start date and keeps the old row', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_25', 'High', TAGS, `Clicking the Status toggle on the inactive Album row does not flip it in place; a new Album row with an empty start date appears for the operator to set, while the original stays in the table, still 비활성, as history. Deviation from TC: ${APPLIED_INSTEAD}. ${DATA}`);
    let contract = { id: 0, start: '' };
    let rowsBefore = 0;

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the Album row has been switched to Inactive (applied)', async () => {
      contract = await feeRateContracts.create('TC_US078_25', 'NOT_STARTED');
      await feeRateContracts.deactivate(contract.id, KEY.ALBUM, 'Album line paused before launch');
    });

    await step('Act: Step 1 — Click the Status toggle on the inactive Album row to switch it back to Active', async () => {
      await fee.openEdit(contract.id);
      rowsBefore = await fee.feeRows.count();
      await fee.clickStatusToggle(fee.row(KEY.ALBUM, contract.start));
    });

    await step("Assert: Expected 1 — The old row's Status and history are unaffected; the flip does not happen in place", async () => {
      await expect(fee.cell(fee.row(KEY.ALBUM, contract.start), 'status'), '[Expected 1] The original row still reads 비활성').toHaveText(FEE_TEXT.statusInactive);
      await expect(fee.toast(FEE_TEXT.reactivatedAsNewRow), '[Expected 1] The UI explains a new row was added instead').toBeVisible();
    });

    await step('Act: Step 2 — Read the fee table', async () => {
      await fee.newRow.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — A new Album row with an empty start date appears; the original stays Inactive as history', async () => {
      await expect(fee.feeRows, '[Expected 2] One new row was added').toHaveCount(rowsBefore + 1);
      await expect(fee.cell(fee.newRow, 'category').locator('select option:checked'), '[Expected 2] The new row is on the Album key').toHaveText('음반');
      await expect(fee.cell(fee.newRow, 'effectiveFrom').locator('input'), '[Expected 2] The new row has an empty start date').toHaveValue('');
      await expect(fee.cell(fee.row(KEY.ALBUM, contract.start), 'status'), '[Expected 2] The original row remains 비활성').toHaveText(FEE_TEXT.statusInactive);
    });
  });

  test('TC_US078_26 — The Change rate button appears on a saved active Percent or Fixed row; the input asks for % or KRW', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_26', 'High', TAGS, `The Percent MD row's dialog labels its input "새 요율 (%)" with a % unit; the Fixed row's dialog labels it "새 금액 (원)" and accepts 4400 with no 100 ceiling. Deviation from TC: the Fixed row lives on the same automation contract (팬클럽 키트 · 전체 위탁 · 고정(단위당) · 4000 원) instead of contract 25004KE-M1-1-CO; the Fixed row's control reads 금액 수정. ${DATA}`);
    let contract = { id: 0 };
    let submitStatus = 0;

    await step('Arrange: Pre-condition 1–3 — Logged in as ADMIN; MD · 비율 · 10 % and a 고정(단위당) row are saved and Active', async () => {
      contract = await feeRateContracts.create('TC_US078_26', 'RUNNING', [...DEFAULT_ROWS, { ...KEY.FIXED, type: 'FIXED_UNIT', commission: 4000 }]);
    });

    await step("Act: Step 1 — Open the MD row's Change rate dialog, check the input's label and unit", async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD));
    });

    await step('Assert: Expected 1 — The input is labelled 새 요율 (%) and shows a % unit', async () => {
      await expect(fee.changeDialog.rateLabel, '[Expected 1] Label reads 새 요율 (%) (New rate (%))').toHaveText(FEE_TEXT.dialog.newPercent);
      await expect(fee.changeDialog.unit, '[Expected 1] Unit reads %').toHaveText('%');
    });

    await step("Act: Step 2 — Open the Fixed row's dialog, enter amount 4400, click 승인 요청", async () => {
      await fee.changeDialog.cancelButton.click();
      await fee.openChangeDialog(fee.row(KEY.FIXED));
      await expect(fee.changeDialog.rateLabel, 'The Fixed row asks for an amount').toHaveText(FEE_TEXT.dialog.newAmount);
      await fee.changeDialog.fill({ kind: 'correction', rate: '4400', reason: 'Fixed fee corrected to 4,400 KRW per unit' });
      submitStatus = (await fee.changeDialog.submit()).status;
    });

    await step('Assert: Expected 2 — The input is labelled 새 금액 (원); 4,400 원 is accepted with no 100 ceiling', async () => {
      expect(submitStatus, '[Expected 2] 4400 is accepted (201)').toBe(201);
      await expect(fee.approvalBadge(fee.row(KEY.FIXED)), '[Expected 2] The Fixed row reads 승인 대기').toHaveText(FEE_TEXT.approval.PENDING);
    });
  });

  test('TC_US078_27 — Switching a row on or off before it is saved takes effect immediately and needs no approval', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_27', 'Medium', TAGS, `On a new, unsaved row the Status control flips immediately in place (Active → Inactive → Active) with no reason dialog and no approval request; the row stays 작성 중. ${DATA}`);
    let contract = { id: 0 };
    let statuses: string[] = [];
    let dialogs = -1;

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the contract is in edit mode with a new, unsaved fee row', async () => {
      contract = await feeRateContracts.create('TC_US078_27', 'RUNNING');
      await fee.openEdit(contract.id);
      await fee.addButton.click();
      await fee.fillNewRow({ ...FANCLUB_KIT_SELF, rate: 5 });
    });

    await step("Act: Step 1 — Toggle the new unsaved row's Status from Active to Inactive, then back to Active", async () => {
      const toggle = fee.newRow.getByRole('button', { name: /^[^가-힣A-Za-z]*(비활성|활성)$/ });
      await toggle.click({ timeout: 5_000 }).catch(() => undefined);
      statuses.push(((await fee.cell(fee.newRow, 'status').textContent()) ?? '').trim());
      await toggle.click({ timeout: 5_000 }).catch(() => undefined);
      statuses.push(((await fee.cell(fee.newRow, 'status').textContent()) ?? '').trim());
      dialogs = await fee.reasonDialog.root.count();
    });

    await step('Assert: Expected 1 — The toggle flips in place with no reason dialog and no request; the row is still unsaved', async () => {
      expect(statuses, '[Expected 1] The status flips to 비활성 and back to 활성').toEqual([FEE_TEXT.statusInactive, FEE_TEXT.statusActive]);
      expect(dialogs, '[Expected 1] No reason dialog opened').toBe(0);
      await expect(fee.approvalBadge(fee.newRow), '[Expected 1] The row is still 작성 중 (unsaved)').toHaveText(FEE_TEXT.approval.DRAFT);
    });
  });

  test('TC_US078_28 — The Change rate button does not appear on a row that is unsaved, switched off, replaced, or waiting', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_28', 'Medium', TAGS, `No Change rate control on: a new unsaved row, the inactive Album row, the pending Fan Club row, and a superseded row. Deviation from TC: the inactive and superseded rows live on a not-yet-started contract (they cannot be reached on a running contract without a second approver — decision 28/09); the unsaved and pending rows on a running contract. ${DATA}`);
    let running = { id: 0 };
    let notStarted = { id: 0, start: '' };
    const found: Record<string, number> = {};

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; an unsaved row, an inactive Album row, a pending Fan Club row and a superseded row', async () => {
      running = await feeRateContracts.create('TC_US078_28', 'RUNNING');
      await feeRateContracts.submit(running.id, KEY.FANCLUB, { changeKind: 'CORRECTION', commission: '6.5', changeReason: 'Pending request' });
      notStarted = await feeRateContracts.create('TC_US078_28', 'NOT_STARTED');
      await feeRateContracts.deactivate(notStarted.id, KEY.ALBUM, 'Album paused');
      await feeRateContracts.submit(notStarted.id, KEY.MD, { changeKind: 'RATE_CHANGE', commission: '12', effectiveFrom: addDays(notStarted.start, 15), changeReason: 'Superseding MD row' });
    });

    await step('Act: Step 1 — Check the unsaved, inactive, pending and superseded rows for a Change rate control', async () => {
      await fee.openEdit(running.id);
      await fee.addButton.click();
      found.unsaved = await fee.changeButton(fee.newRow).count();
      found.pending = await fee.changeButton(fee.row(KEY.FANCLUB)).count();
      await fee.openEdit(notStarted.id);
      found.inactive = await fee.changeButton(fee.row(KEY.ALBUM)).count();
      found.superseded = await fee.changeButton(fee.row(KEY.MD, notStarted.start)).count();
    });

    await step('Assert: Expected 1 — None of the four rows shows a Change rate control', async () => {
      expect(found.unsaved, '[Expected 1] The unsaved row has no Change rate').toBe(0);
      expect(found.inactive, '[Expected 1] The inactive Album row has no Change rate').toBe(0);
      expect(found.pending, '[Expected 1] The pending Fan Club row has no Change rate').toBe(0);
      expect(found.superseded, '[Expected 1] The superseded row has no Change rate').toBe(0);
    });
  });

  test('TC_US078_29 — A Tiered, Margin or Guarantee row shows no Change rate button and explains the rate comes from the settlement rules', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    const complexRows: Array<FeeRowSpec & { name: string }> = [
      { name: '개런티(러닝) (Guarantee running)', category: 'MD_PURCHASE', saleType: 'PURCHASE', type: 'GUARANTEE_RUNNING' },
      { name: '구간/슬라이딩 (Tiered/Sliding)', category: 'MD', saleType: 'PURCHASE', type: 'TIERED_SLIDING' },
      { name: '마진 (Margin)', category: 'ALBUM', saleType: 'PURCHASE', type: 'MARGIN' },
      { name: '개런티(미니멈) (Guarantee minimum)', category: 'FANCLUB', saleType: 'PURCHASE', type: 'GUARANTEE_MINIMUM' },
    ];
    await tcMeta('TC_US078_29', 'Medium', TAGS, `Rows of type 개런티(러닝), 구간/슬라이딩, 마진 and 개런티(미니멈) show no change control and the text "요율은 정산 규칙에서 설정됩니다". Deviation from TC: all four types live on one automation contract instead of 26010SP-M1-0-CS and others. ${DATA}`);
    let contract = { id: 0 };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; a contract has Guarantee (running), Tiered, Margin and Guarantee (minimum) rows', async () => {
      contract = await feeRateContracts.create('TC_US078_29', 'RUNNING', complexRows.map((row) => ({ ...row, commission: 0 })));
    });

    await step('Act: Step 1 — Open the contract, tab Fee Information, inspect each of the four rows', async () => {
      await fee.openEdit(contract.id);
    });

    await step('Assert: Expected 1 — No Change rate control on any of the four types; text says the rate is set in the settlement rules', async () => {
      for (const row of complexRows) {
        await expect(fee.changeButton(fee.row(row)), `[Expected 1] ${row.name} has no Change rate control`).toHaveCount(0);
        await expect(fee.row(row).getByText(FEE_TEXT.complexNote), `[Expected 1] ${row.name} says the rate is set in the settlement rules`).toBeVisible();
      }
    });
  });

  test('TC_US078_30 — The Approval column only ever shows Draft, Pending approval, Applied, Superseded or Rejected', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_30', 'Medium', TAGS, `Every 승인 상태 value on the tab is exactly one of 작성 중 / 승인 대기 / 적용됨 / 대체됨 / 반려됨 — never 활성 (Active) and never 회수 (Withdrawn). Deviation from TC: the mix holds Applied, Pending, a new Draft row and a withdrawn request; a rejected row cannot be produced without a second approver (decision 28/09). ${DATA}`);
    let contract = { id: 0 };
    let values: string[] = [];

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; rows in a mix of states (Applied, Pending, Draft, withdrawn)', async () => {
      contract = await feeRateContracts.create('TC_US078_30', 'RUNNING');
      await feeRateContracts.submit(contract.id, KEY.FANCLUB, { changeKind: 'CORRECTION', commission: '6.5', changeReason: 'Pending request' });
      const withdrawn = await feeRateContracts.submit(contract.id, KEY.ALBUM, { changeKind: 'CORRECTION', commission: '7', changeReason: 'Request to withdraw' });
      await feeRateContracts.withdraw(contract.id, KEY.ALBUM, withdrawn.changeId);
      await fee.openEdit(contract.id);
      await fee.addButton.click();
    });

    await step('Act: Step 1 — Read the Approval column value for each fee row', async () => {
      values = [];
      for (let i = 0; i < (await fee.feeRows.count()); i++) values.push(await fee.approvalValue(fee.feeRows.nth(i)));
    });

    await step('Assert: Expected 1 — Every value is exactly one of the five approval states — never Active, never Withdrawn', async () => {
      for (const [index, value] of values.entries()) {
        expect(FEE_TEXT.approvalAllowed, `[Expected 1] Row ${index + 1} Approval "${value}" is one of the five states`).toContain(value);
        expect(value, `[Expected 1] Row ${index + 1} never reads Active / Withdrawn`).not.toMatch(/^(활성|회수|Active|Withdrawn)$/);
      }
    });
  });

  test('TC_US078_31 — A fee row shows no hand-typed marker when its rate came from the contract', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_31', 'Medium', TAGS, `The MD row created from the contract (rateOrigin FROM_CONTRACT) shows no marker next to 10 %; a row flagged as keyed by hand (rateOrigin KEYED_BY_HAND) shows the "수기 입력" marker next to 8 %. Deviation from TC: the hand-typed fixture is added through the add-row endpoint (POST …/fee-rows with rateOrigin = KEYED_BY_HAND — the only place the backend accepts it) on a not-yet-started contract so it applies at once, instead of being seeded by Dev. ${DATA}`);
    let contract = { id: 0, start: '' };

    await step('Arrange: Pre-condition 1–3 — Logged in as ADMIN; MD row from the contract (default) and an Album row flagged as keyed by hand', async () => {
      contract = await feeRateContracts.create('TC_US078_31', 'NOT_STARTED', [{ ...KEY.MD, commission: 10 }, { ...KEY.FANCLUB, commission: 7 }]);
      await feeRateContracts.addRow(contract.id, { ...KEY.ALBUM, commission: 8, effectiveFrom: contract.start }, 'Album rate keyed in by hand', 'KEYED_BY_HAND');
    });

    await step("Act: Step 1 — Open the Fee Information tab and look at the MD row's fee value for any marker", async () => {
      await fee.open(contract.id);
    });

    await step("Assert: Expected 1 — No marker next to the MD row's 10 %", async () => {
      await expect(fee.cell(fee.row(KEY.MD), 'fee').getByText('수기 입력'), '[Expected 1] No hand-typed marker on MD').toHaveCount(0);
    });

    await step("Act: Step 2 — Look at the Album row's fee value for a marker", async () => {
      await fee.row(KEY.ALBUM).scrollIntoViewIfNeeded();
    });

    await step("Assert: Expected 2 — A marker next to the Album row's 8 % states the rate was keyed by hand", async () => {
      await expect(fee.row(KEY.ALBUM).getByText('수기 입력'), '[Expected 2] The "수기 입력" (keyed by hand) marker is shown').toBeVisible();
    });
  });

  test('TC_US078_32 — A replaced row shows a banner naming the row that replaced it and the date it took over', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_32', 'Medium', TAGS, `After Album 8 % is replaced by 9 % from start + 15 days, the older 8 % row shows a banner "{n}번 행으로 대체됨" naming the newer row and the date it took over. Deviation from TC: ${APPLIED_INSTEAD}. ${DATA}`);
    let contract = { id: 0, start: '' };
    let takeover = '';

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; Album 8 % superseded by 9 % from start + 15 days', async () => {
      contract = await feeRateContracts.create('TC_US078_32', 'NOT_STARTED');
      takeover = addDays(contract.start, 15);
      await feeRateContracts.submit(contract.id, KEY.ALBUM, { changeKind: 'RATE_CHANGE', commission: '9', effectiveFrom: takeover, changeReason: 'Annex raises the rate to 9%' });
    });

    await step('Act: Step 1 — Open the Fee Information tab and read the banner on the older Album 8 % row', async () => {
      await fee.open(contract.id);
    });

    await step('Assert: Expected 1 — The banner says it is superseded by the newer row and names the take-over date', async () => {
      const older = fee.row(KEY.ALBUM, contract.start);
      await expect(older, '[Expected 1] The older row names the row that replaced it ("{n}번 행으로 대체됨")').toContainText(/\d+번 행으로 대체됨/);
      await expect(older, `[Expected 1] The banner names ${takeover} as the take-over date`).toContainText(takeover);
    });
  });

  test('TC_US078_33 — Adding a fee row with a past start date is refused when that category already has an active row', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_33', 'Medium', TAGS, `Adding MD · 전체 위탁 · 일반 · 9 % with start 2026-01-01 while that key already has an active row is refused with "이 항목에는 이미 수수료 행이 있어 적용 시작일을 앞당길 수 없습니다. 정정으로 제출해 주세요." — no rule code shown. ${DATA}`);
    let contract = { id: 0 };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; MD · 전체 위탁 · 일반 is already Active', async () => {
      contract = await feeRateContracts.create('TC_US078_33', 'RUNNING');
    });

    await step('Act: Step 1 — Click Add, fill MD · 전체 위탁 · 일반 · 비율 · 9 % with start 2026-01-01, click Submit (save)', async () => {
      await fee.openEdit(contract.id);
      await fee.addButton.click();
      await fee.fillNewRow({ ...KEY.MD, rate: 9, startDate: '2026-01-01' });
      await fee.save();
      if (await fee.reasonDialog.root.isVisible()) {
        await fee.reasonDialog.reasonInput.fill('Back-dated duplicate row');
        await fee.reasonDialog.submitButton.click();
      }
    });

    await step('Assert: Expected 1 — Refused with the plain message, no rule code', async () => {
      await expect(page.getByText(FEE_TEXT.backdatedOnHeldKey).first(), '[Expected 1] The refusal message is shown').toBeVisible();
      await expect(page.getByText(NO_RULE_CODE), '[Expected 1] No rule code is shown').toHaveCount(0);
    });
  });

  test('TC_US078_34 — The promotion period field is not offered on a Normal row', async ({ page, feeRateApi, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_34', 'Medium', TAGS, `With policy 일반 the new row's promotion period inputs are not offered (disabled, placeholder "프로모션 선택 시 활성화"), and a direct save request carrying a promotion period on a 일반 row is refused by the server (4xx). Not automated: the exact refusal text — the TC marks it ⚠ NEEDS CLARIFICATION. ${DATA}`);
    let contract = { id: 0 };
    let direct = { status: 0, body: '' };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the contract is in edit mode with a new row on policy 일반', async () => {
      contract = await feeRateContracts.create('TC_US078_34', 'RUNNING');
      await fee.openEdit(contract.id);
      await fee.addButton.click();
    });

    await step('Act: Step 1 — On the new row set policy to 일반 and look for a promotion period field', async () => {
      await fee.fillNewRow({ ...KEY.MD_CONSIGNMENT, rate: 5 });
    });

    await step('Assert: Expected 1 — No promotion period field is offered while the policy reads 일반', async () => {
      for (const input of await fee.cell(fee.newRow, 'promotion').locator('input').all()) {
        await expect(input, '[Expected 1] The promotion period input is not offered (disabled)').toBeDisabled();
      }
    });

    await step('Act: Step 2 — Send a direct save request carrying a promotion period on a 일반 row, bypassing the UI', async () => {
      const res = await feeRateApi.addFeeRow(contract.id, addRowBody({ ...KEY.MD_CONSIGNMENT, commission: 5, effectiveFrom: inDays(2), promotion: { from: inDays(5), to: inDays(35) } }, 'Promotion period on a NORMAL row'));
      direct = { status: res.status, body: JSON.stringify(res.body) };
    });

    await step('Assert: Expected 2 — The request is refused by the server', async () => {
      expect(direct.status, `[Expected 2] The server refuses a promotion period on a 일반 row (response: ${direct.body})`).toBeGreaterThanOrEqual(400);
      expect(direct.status, '[Expected 2] The refusal is a client error, not a server fault').toBeLessThan(500);
    });
  });

  test('TC_US078_35 — Two rows of one category on the same start date are refused; different start dates are accepted', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_35', 'High', TAGS, `A rate change on MD dated 2026-01-01 (the existing row's own start) is refused; the same change dated 2026-11-01 is accepted. ${DATA}`);
    let contract = { id: 0 };
    let first = { status: 0, blocked: false };
    let second = 0;

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; MD · 전체 위탁 · 일반 is Active with start 2026-01-01', async () => {
      contract = await feeRateContracts.create('TC_US078_35', 'RUNNING');
    });

    await step('Act: Step 1 — Change rate on MD: 변경, rate 9, effective from 2026-01-01, reason "Testing duplicate date", submit', async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD));
      await fee.changeDialog.fill({ kind: 'rateChange', rate: '9', date: '2026-01-01', reason: 'Testing duplicate date' });
      first.blocked = await fee.changeDialog.submitButton.isDisabled();
      if (!first.blocked) first.status = (await fee.changeDialog.submit()).status;
    });

    await step('Assert: Expected 1 — Submit is refused (the key already has a row on that date)', async () => {
      expect(first.blocked || first.status >= 400, `[Expected 1] The duplicate-date change is refused (submit disabled: ${first.blocked}, status: ${first.status})`).toBe(true);
      await expect(fee.approvalBadge(fee.row(KEY.MD)), '[Expected 1] No request was created').toHaveText(FEE_TEXT.approval.APPLIED);
    });

    await step('Act: Step 2 — Repeat with effective from 2026-11-01', async () => {
      if (await fee.changeDialog.root.isVisible()) await fee.changeDialog.cancelButton.click();
      await fee.openChangeDialog(fee.row(KEY.MD));
      await fee.changeDialog.fill({ kind: 'rateChange', rate: '9', date: '2026-11-01', reason: 'Testing duplicate date' });
      second = (await fee.changeDialog.submit()).status;
    });

    await step('Assert: Expected 2 — Submit succeeds (different start dates are accepted)', async () => {
      expect(second, '[Expected 2] The change dated 2026-11-01 is accepted (201)').toBe(201);
    });
  });

  test('TC_US078_36 — Shortening a contract period is refused when it would leave fee rows with no orders to price', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    let contract = { id: 0, start: '' };
    let lateStart = '';
    await tcMeta('TC_US078_36', 'High', TAGS, `Moving the contract end before the start of a later Fan Club row is refused with "계약 기간을 줄이면 수수료 행 1건이 적용 대상 주문을 잃게 됩니다. 해당 행을 먼저 조정해 주세요." — no rule code, naming that row. Deviation from TC: the later row (from start + 40 days) is built on a not-yet-started contract (applied at once) and the new end date is start + 39 days — a later row on a running contract needs a second approver (decision 28/09). ${DATA}`);

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the contract has a Fan Club row starting after the new end date', async () => {
      contract = await feeRateContracts.create('TC_US078_36', 'NOT_STARTED');
      lateStart = addDays(contract.start, 40);
      await feeRateContracts.submit(contract.id, KEY.FANCLUB, { changeKind: 'RATE_CHANGE', commission: '6', effectiveFrom: lateStart, changeReason: 'Later Fan Club row' });
    });

    await step("Act: Step 1 — Open the contract's 계약 기간 tab, change the end date before the Fan Club row's start, click Save", async () => {
      await fee.openEdit(contract.id);
      await fee.periodTab.click();
      await fee.periodEndInput.fill(addDays(lateStart, -1));
      await fee.periodEndInput.press('Enter');
      await fee.save();
    });

    await step('Assert: Expected 1 — Save is refused with the plain message naming 1 fee row, no rule code', async () => {
      await expect(page.getByText(FEE_TEXT.periodShortened(1)).first(), '[Expected 1] The refusal message is shown').toBeVisible();
      await expect(page.getByText(NO_RULE_CODE), '[Expected 1] No rule code is shown').toHaveCount(0);
    });
  });

  test('TC_US078_37 — No other screen showing a fee rate offers any way to change it', async () => {
    await skipTc('TC_US078_37', 'Medium', TAGS, 'The fee management screen shows the contract fee rate read-only with no edit control.', 'the 수수료 관리 screen (/commerce/commissions) lists fee rates per PRODUCT (with bulk 기본 수수료 변경 / 프로모션 수수료 변경 buttons), not the contract fee rows — it has no "MD row for this contract" to inspect, and automation contracts have no products (verified 28/09)');
  });

  test('TC_US078_38 — Two people editing the same fee row at the same time get a conflict warning', async ({ page, context, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_38', 'High', TAGS, `Session A submits a correction on MD (→ 승인 대기); Session B, opened before and not refreshed, submits another correction and is refused with "이 수수료 행은 변경할 수 없습니다: 이미 대기 중인 변경이 있습니다." — no rule code. Deviation from TC: both sessions are browser tabs of the same ADMIN account (only one contract-capable account exists — decision 28/09). ${DATA}`);
    let contract = { id: 0 };
    let first = 0;
    let secondStatus = 0;
    const sessionB = await context.newPage();
    const feeB = new ContractFeePage(sessionB);

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN in two sessions (A and B); MD · 10 % is Active', async () => {
      contract = await feeRateContracts.create('TC_US078_38', 'RUNNING');
      await fee.openEdit(contract.id);
      await feeB.openEdit(contract.id);
    });

    await step('Act: Step 1 — In Session A open Change rate on MD, pick 정정, rate 8, reason "First edit", click Submit', async () => {
      await feeB.openChangeDialog(feeB.row(KEY.MD));
      await fee.openChangeDialog(fee.row(KEY.MD));
      await fee.changeDialog.fill({ kind: 'correction', rate: '8', reason: 'First edit' });
      first = (await fee.changeDialog.submit()).status;
    });

    await step("Assert: Expected 1 — Session A's submit succeeds; the row shows 승인 대기", async () => {
      expect(first, '[Expected 1] Session A is accepted (201)').toBe(201);
      await expect(fee.approvalBadge(fee.row(KEY.MD)), '[Expected 1] The row reads 승인 대기').toHaveText(FEE_TEXT.approval.PENDING);
    });

    await step('Act: Step 2 — In Session B, without refreshing, pick 정정, rate 7, reason "Second edit", click Submit', async () => {
      await feeB.changeDialog.fill({ kind: 'correction', rate: '7', reason: 'Second edit' });
      if (await feeB.changeDialog.submitButton.isEnabled()) secondStatus = (await feeB.changeDialog.submit()).status;
      await sessionB.bringToFront();
    });

    await step("Assert: Expected 2 — Session B's submit is refused with the pending-change message, no rule code", async () => {
      expect(secondStatus === 0 || secondStatus >= 400, `[Expected 2] Session B is refused (status ${secondStatus})`).toBe(true);
      await expect(sessionB.getByRole('dialog').first(), '[Expected 2] The conflict message is shown').toContainText('이 수수료 행은 변경할 수 없습니다: 이미 대기 중인 변경이 있습니다.');
      await expect(sessionB.getByText(NO_RULE_CODE), '[Expected 2] No rule code is shown').toHaveCount(0);
      await page.bringToFront();
      await sessionB.close();
    });
  });

  test('TC_US078_39 — The parts of the fee table and the contract tabs that this feature does not touch still work as before', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_39', 'High', TAGS, `번호 / 카테고리 / 판매유형 and PG 수수료(%) show the saved values; the 계약 기간 and 기본 정보 tabs keep their fields editable in edit mode; a saved fee row offers no delete control. ${DATA}`);
    let contract = { id: 0 };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the contract has its usual fee rows and filled 계약 기간 / 기본 정보 tabs', async () => {
      contract = await feeRateContracts.create('TC_US078_39', 'RUNNING');
    });

    await step('Act: Step 1 — Open the Fee Information tab, check 번호, 카테고리, 판매유형 and PG 수수료(%)', async () => {
      await fee.openEdit(contract.id);
    });

    await step('Assert: Expected 1 — The three columns and the PG Fee column show the saved values', async () => {
      const row = fee.row(KEY.MD);
      await expect(fee.cell(row, 'no'), '[Expected 1] 번호 reads 1').toHaveText('1');
      await expect(fee.cell(row, 'category').locator('option:checked'), '[Expected 1] 카테고리 reads MD').toHaveText('MD');
      await expect(fee.cell(row, 'saleType').locator('option:checked'), '[Expected 1] 판매유형 reads 전체 위탁').toHaveText('전체 위탁');
      await expect(fee.cell(row, 'pgFee').locator('input'), '[Expected 1] PG 수수료(%) reads 3').toHaveValue('3');
    });

    await step('Act: Step 2 — Open the 계약 기간 and 기본 정보 tabs and check their fields', async () => {
      await fee.periodTab.click();
    });

    await step('Assert: Expected 2 — Both tabs open and their fields remain editable', async () => {
      await expect(fee.periodEndInput, '[Expected 2] The contract end date is editable').toBeEditable();
      await fee.basicTab.click();
      await expect(fee.basicPanel.getByPlaceholder('계약서명을 입력하세요'), '[Expected 2] The contract name is editable').toBeEditable();
      await fee.feeTab.click();
    });

    await step('Act: Step 3 — Try to delete an original, saved fee row from the table', async () => {
      await fee.row(KEY.MD).scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — No delete control is offered on a saved fee row', async () => {
      for (const key of [KEY.MD, KEY.ALBUM, KEY.FANCLUB]) {
        await expect(fee.rowButton(fee.row(key), '삭제'), `[Expected 3] ${keyLabel(key)} offers no 삭제 (Delete) control`).toHaveCount(0);
      }
    });
  });
});
