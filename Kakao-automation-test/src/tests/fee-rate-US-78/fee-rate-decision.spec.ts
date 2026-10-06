import { test, expect } from '@fixtures/fee-rate.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { switchAccount } from '@utils/switch-account';
import { getAccountDisplayName } from '@utils/auth-token';
import { FEE_TEXT, KEY, CATEGORY, SALE_TYPE, addDays, inDays, latestChange } from '@utils/fee-rate.data';
import type { FeeRow } from '@api/fee-rate.api';

/**
 * US078 — nhóm [Approval] cần người DUYỆT khác người GỬI (maker ≠ checker, mở khoá 30/09).
 * Người gửi = account `submitter` (anhdtv2.fpt, có COMMERCE_CONTRACTS ghi) — tạo contract + gửi request qua API hoặc UI
 * (browser đổi sang submitter bằng `switchAccount`). Người duyệt = `approver` (dungbd.fpt) — browser mặc định và `feeRateApi`.
 * Nguồn TC: input/TESTCASE_US078_v2.md (Steps N / Expected N → `Act: Step N` / `Assert: Expected N`).
 * Fixture contract `26009CU-M1-0-MD` của TC không có trên dev → mỗi test tạo contract riêng (không xoá được, quyết định 28/09);
 * đơn còn chờ được rút lại ở teardown. Locator verify bằng recon 30/09 (contract recon `[AUTO-US078] recon maker-checker`).
 */
const TAGS = ['ui', 'fee-rate', 'fee-rate-approval', 'maker-checker'];
const DATA = 'Data: automation-owned contract created by the submitter account through the API (contracts cannot be deleted); pending requests are withdrawn in teardown.';
const NEW_ROW_KEY = { category: 'FANCLUB_KIT', saleType: 'SELF' } as const;

/** Dòng API theo khoá + ngày bắt đầu (không có ngày → dòng đầu tiên của khoá). */
function apiRow(rows: FeeRow[], key: { category: keyof typeof CATEGORY; saleType: keyof typeof SALE_TYPE }, effectiveFrom?: string): FeeRow | undefined {
  return rows.find((row) => row.categoryId === CATEGORY[key.category].id && row.saleTypeId === SALE_TYPE[key.saleType].id && (!effectiveFrom || row.effectiveFrom === effectiveFrom));
}

test.describe('[Approval] Fee rate decisions by a second approver (maker ≠ checker)', () => {
  test.describe.configure({ timeout: 180_000 });

  test('TC_US078_64 — Approving a rate change adds a new row, ends the old one by date, and leaves both rows switched on', async ({ page, submitterContracts, changeApprovalQueuePage: queue, contractFeePage: fee }) => {
    const step = makeStep(page);
    const reason = 'Album rate change to approve';
    const from = inDays(15);
    await tcMeta('TC_US078_64', 'Critical', TAGS, `After the approver approves Album 8 % → 9 % from today + 15 days, two Album rows exist: 8 % ending the day before (today + 14 days) and 9 % starting today + 15 days, both 활성 (Active). ${DATA}`);
    let contract = { id: 0 };
    let changeApprovalId: number | null | undefined;

    await step('Arrange: Pre-condition 1–2 — Logged in as APPROVER; the Album 8 % row has a pending rate change to 9 % from today + 15 days (sent by the submitter)', async () => {
      contract = await submitterContracts.create('TC_US078_64', 'RUNNING');
      changeApprovalId = (await submitterContracts.submit(contract.id, KEY.ALBUM, { changeKind: 'RATE_CHANGE', commission: '9', effectiveFrom: from, changeReason: reason })).changeApprovalId;
    });

    await step('Act: Step 1 — Go to 변경 승인, filter Register to Fee Rate, open the request, click 승인 (Approve)', async () => {
      await queue.openRequest({ register: FEE_TEXT.queue.register, requester: getAccountDisplayName('submitter'), changeApprovalId: changeApprovalId!, reason });
      await queue.approve();
    });

    await step('Assert: Expected 1 — Approval succeeds', async () => {
      await expect(queue.approvedToast, '[Expected 1] 승인되었습니다 (Approved) is confirmed').toBeVisible();
    });

    await step('Act: Step 2 — Read both rows on the Album key', async () => {
      await fee.open(contract.id);
    });

    await step('Assert: Expected 2 — 8 % ends the day before the change, 9 % starts on it; both rows stay Active', async () => {
      const [oldRow, newRow] = [fee.row(KEY.ALBUM, '2026-01-01'), fee.row(KEY.ALBUM, from)];
      await expect.soft(fee.feeInput(oldRow), '[Expected 2] The old Album row keeps 8 %').toHaveValue('8');
      await expect.soft(fee.cell(oldRow, 'effectiveFrom'), `[Expected 2] The 8 % row ends ${addDays(from, -1)}`).toContainText(FEE_TEXT.until(addDays(from, -1)));
      await expect.soft(fee.feeInput(newRow), '[Expected 2] The new Album row carries 9 %').toHaveValue('9');
      await expect.soft(fee.cell(newRow, 'effectiveFrom'), `[Expected 2] The 9 % row starts ${from}`).toContainText(from);
      await expect.soft(fee.cell(oldRow, 'status'), '[Expected 2] The 8 % row is still 활성 (Active) — not switched to Inactive').toHaveText(FEE_TEXT.statusActive);
      await expect(fee.cell(newRow, 'status'), '[Expected 2] The 9 % row is 활성 (Active)').toHaveText(FEE_TEXT.statusActive);
    });
  });

  test('TC_US078_65 — Approving a correction changes the existing row in place and its Approval column still reads Applied', async ({ page, submitterFeeRateApi, submitterContracts, changeApprovalQueuePage: queue, contractFeePage: fee }) => {
    const step = makeStep(page);
    const reason = 'MD correction to approve';
    await tcMeta('TC_US078_65', 'Critical', TAGS, `After approval of the MD correction 10 % → 8 %, the same MD row reads 8 % and 적용됨 (Applied); no second MD row exists and nothing on the tab reads 대체됨 (Superseded). ${DATA}`);
    let contract = { id: 0 };
    let changeApprovalId: number | null | undefined;
    let mdRowId = 0;

    await step('Arrange: Pre-condition 1–2 — Logged in as APPROVER; the MD 10 % row has a pending correction to 8 %', async () => {
      contract = await submitterContracts.create('TC_US078_65', 'RUNNING');
      mdRowId = await submitterContracts.rowId(contract.id, KEY.MD);
      changeApprovalId = (await submitterContracts.submit(contract.id, KEY.MD, { changeKind: 'CORRECTION', commission: '8', changeReason: reason })).changeApprovalId;
    });

    await step('Act: Step 1 — Open the request in 변경 승인, click 승인 (Approve)', async () => {
      await queue.openRequest({ register: FEE_TEXT.queue.register, requester: getAccountDisplayName('submitter'), changeApprovalId: changeApprovalId!, reason });
      await queue.approve();
    });

    await step('Assert: Expected 1 — Approval succeeds', async () => {
      await expect(queue.approvedToast, '[Expected 1] 승인되었습니다 (Approved) is confirmed').toBeVisible();
    });

    await step('Act: Step 2 — Read the MD row', async () => {
      await fee.open(contract.id);
    });

    await step('Assert: Expected 2 — The same row shows 8 % and 적용됨; no second row; nothing reads 대체됨', async () => {
      const mdRows = (await submitterFeeRateApi.feeRows(contract.id)).filter((row) => row.categoryId === CATEGORY.MD.id && row.saleTypeId === SALE_TYPE.SELF.id);
      await expect.soft(fee.feeInput(fee.row(KEY.MD)), '[Expected 2] The MD row now shows 8 %').toHaveValue('8');
      await expect.soft(fee.approvalBadge(fee.row(KEY.MD)), '[Expected 2] Approval reads 적용됨 (Applied)').toHaveText(FEE_TEXT.approval.APPLIED);
      expect.soft(mdRows.map((row) => row.id), '[Expected 2] Still one MD row — the same row id, no second row').toEqual([mdRowId]);
      await expect(fee.feePanel.getByText(FEE_TEXT.approval.SUPERSEDED), '[Expected 2] Nothing reads 대체됨 (Superseded)').toHaveCount(0);
    });
  });

  test('TC_US078_66 — Approving a change writes one history entry naming who did it, which row, what kind of change, and the difference', async ({ page, submitterContracts, changeApprovalQueuePage: queue, contractHistoryPage: history }) => {
    const step = makeStep(page);
    const reason = 'MD correction for the trail';
    await tcMeta('TC_US078_66', 'Critical', TAGS, `After approval, the contract's 수수료율 수정 이력 trail holds one entry: actor = the submitter, fee row MD · 전체 위탁 · 일반, kind 정정 (Correction), 10 % → 8 %, 영향 주문 라인 = 산출 불가, and no edit or delete control. Deviation from TC: the submitter is the automation account (the TC names admin.ke). ${DATA}`);
    let contract = { id: 0, name: '' };
    let changeApprovalId: number | null | undefined;
    let cells: string[] = [];

    await step('Arrange: Pre-condition 1–2 — Logged in as APPROVER; the MD 10 % row has a pending correction to 8 % sent by the submitter', async () => {
      contract = await submitterContracts.create('TC_US078_66', 'RUNNING');
      changeApprovalId = (await submitterContracts.submit(contract.id, KEY.MD, { changeKind: 'CORRECTION', commission: '8', changeReason: reason })).changeApprovalId;
    });

    await step('Act: Step 1 — Approve the request, then open Change history on the contract and scroll to the fee-rate change trail', async () => {
      await queue.openRequest({ register: FEE_TEXT.queue.register, requester: getAccountDisplayName('submitter'), changeApprovalId: changeApprovalId!, reason });
      await queue.approve();
      await expect(queue.approvedToast, 'The approval is confirmed').toBeVisible();
      await history.openFromList(contract.name);
      await history.trailTable.scrollIntoViewIfNeeded();
      cells = await history.trailRows.first().locator('td').allInnerTexts();
    });

    await step('Assert: Expected 1 — One entry names actor, fee row, kind and 10 % → 8 %; no edit/delete control; order lines affected = not computable', async () => {
      const columns = FEE_TEXT.trail.columns;
      const at = (name: string) => (cells[columns.indexOf(name as (typeof columns)[number])] ?? '').trim();
      await expect.soft(history.trailRows, '[Expected 1] Exactly one trail entry').toHaveCount(1);
      expect.soft(at('수행자'), '[Expected 1] Actor = the submitter').toBe(getAccountDisplayName('submitter'));
      expect.soft(at('수수료 행'), '[Expected 1] Fee row MD · 전체 위탁 · 일반').toBe('MD · 전체 위탁 · 일반');
      expect.soft(at('구분'), '[Expected 1] Kind 정정 (Correction)').toBe('정정');
      expect.soft(at('수수료 (전 → 후)'), '[Expected 1] Difference 10 % → 8 %').toBe('10 % → 8 %');
      expect.soft(at('영향 주문 라인'), '[Expected 1] Order lines affected reads 산출 불가 (not computable)').toBe(FEE_TEXT.dialog.notComputable);
      await expect(history.trailRows.first().getByRole('button'), '[Expected 1] The entry has no edit or delete control').toHaveCount(0);
    });
  });

  test('TC_US078_67 — Approving a second request does not undo a request approved earlier on a different row', async ({ page, submitterContracts, changeApprovalQueuePage: queue, contractFeePage: fee }) => {
    const step = makeStep(page);
    const [mdReason, albumReason] = ['MD correction approved first', 'Album rate change approved second'];
    const from = inDays(15);
    await tcMeta('TC_US078_67', 'Critical', TAGS, `Approving the MD correction (→ 8 %) then the Album rate change (→ 9 % from today + 15 days) updates each row by its own request; MD still reads 8 % after the Album approval. ${DATA}`);
    let contract = { id: 0 };
    const ids = { md: 0, album: 0 };
    const requester = () => getAccountDisplayName('submitter');

    await step('Arrange: Pre-condition 1–2 — Logged in as APPROVER; two separate pending requests (MD correction to 8 %, Album rate change to 9 %)', async () => {
      contract = await submitterContracts.create('TC_US078_67', 'RUNNING');
      ids.md = (await submitterContracts.submit(contract.id, KEY.MD, { changeKind: 'CORRECTION', commission: '8', changeReason: mdReason })).changeApprovalId!;
      ids.album = (await submitterContracts.submit(contract.id, KEY.ALBUM, { changeKind: 'RATE_CHANGE', commission: '9', effectiveFrom: from, changeReason: albumReason })).changeApprovalId!;
    });

    await step('Act: Step 1 — Approve the MD request', async () => {
      await queue.openRequest({ register: FEE_TEXT.queue.register, requester: requester(), changeApprovalId: ids.md, reason: mdReason });
      await queue.approve();
      await expect(queue.approvedToast, 'The MD approval is confirmed').toBeVisible();
      await fee.open(contract.id);
    });

    await step('Assert: Expected 1 — MD now shows 8 %', async () => {
      await expect(fee.feeInput(fee.row(KEY.MD)), '[Expected 1] MD shows 8 %').toHaveValue('8');
    });

    await step('Act: Step 2 — Approve the Album request', async () => {
      await queue.openRequest({ register: FEE_TEXT.queue.register, requester: requester(), changeApprovalId: ids.album, reason: albumReason });
      await queue.approve();
      await expect(queue.approvedToast, 'The Album approval is confirmed').toBeVisible();
      await fee.open(contract.id);
    });

    await step('Assert: Expected 2 — Album is updated per its own change', async () => {
      await expect.soft(fee.feeInput(fee.row(KEY.ALBUM, from)), `[Expected 2] Album has a 9 % row from ${from}`).toHaveValue('9');
      await expect(fee.cell(fee.row(KEY.ALBUM, '2026-01-01'), 'effectiveFrom'), '[Expected 2] The old Album row ends the day before').toContainText(FEE_TEXT.until(addDays(from, -1)));
    });

    await step('Act: Step 3 — Re-open the MD row and confirm its value', async () => {
      await fee.open(contract.id);
    });

    await step('Assert: Expected 3 — MD still shows 8 % — the Album approval did not touch it', async () => {
      await expect(fee.feeInput(fee.row(KEY.MD)), '[Expected 3] MD still shows 8 %').toHaveValue('8');
    });
  });

  test('TC_US078_68 — A request is refused at approval time when the contract period has changed since it was sent', async ({ page, submitterFeeRateApi, submitterContracts, changeApprovalQueuePage: queue, contractFeePage: fee }) => {
    const step = makeStep(page);
    const reason = 'Fan Club change before the period is shortened';
    const from = inDays(60);
    const newEnd = inDays(59);
    await tcMeta('TC_US078_68', 'High', TAGS, `With a Fan Club rate change pending from today + 60 days, the ADMIN shortens the contract end to today + 59 days (save succeeds); approving then is refused with "이 변경은 더 이상 승인할 수 없습니다: {reason}. 기안자에게 반려되었습니다." — no rule code — and the request is returned to the submitter. Deviations from TC: the dates are relative to the run (TC: effective 2026-11-01, end 2026-10-31 — standing rule 3); the ADMIN session is the submitter account. Observed in recon 30/09: the server answers 409 with the rule code (CNT-1023) in the message, the UI shows only "이 항목은 이미 처리되어 더 이상 대기 상태가 아닙니다. 목록을 다시 불러옵니다.", and the request stays pending. ${DATA}`);
    let contract = { id: 0 };
    let changeApprovalId: number | null | undefined;
    let savedEnd = '';
    let fanRowId = 0;

    await step(`Arrange: Pre-condition 1–2 — APPROVER and ADMIN sessions; the Fan Club row has a pending rate change effective ${from}`, async () => {
      contract = await submitterContracts.create('TC_US078_68', 'RUNNING');
      fanRowId = await submitterContracts.rowId(contract.id, KEY.FANCLUB);
      changeApprovalId = (await submitterContracts.submit(contract.id, KEY.FANCLUB, { changeKind: 'RATE_CHANGE', commission: '6', effectiveFrom: from, changeReason: reason })).changeApprovalId;
    });

    await step(`Act: Step 1 — In the ADMIN session shorten the contract end date to ${newEnd}, save`, async () => {
      await switchAccount(page, 'submitter');
      await fee.openEdit(contract.id);
      await fee.click(fee.periodTab, '계약 기간 (Contract period) tab');
      await fee.periodEndInput.fill(newEnd);
      await fee.periodEndInput.press('Escape');
      await fee.save();
      await expect(page, 'The save returns to the contract list').toHaveURL(/\/commerce\/contracts(\?(?!.*view=edit).*)?$/);
      const end = (await submitterFeeRateApi.getContract(contract.id)).body.contractPeriod.endAt;
      savedEnd = new Date(new Date(end).getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
    });

    await step('Assert: Expected 1 — Save succeeds on the shortened period', async () => {
      expect(savedEnd, `[Expected 1] The contract now ends ${newEnd}`).toBe(newEnd);
    });

    await step('Act: Step 2 — In the Approver session open the pending request and click 승인 (Approve)', async () => {
      await switchAccount(page, 'approver');
      await queue.openRequest({ register: FEE_TEXT.queue.register, requester: getAccountDisplayName('submitter'), changeApprovalId: changeApprovalId!, reason });
      await queue.approve();
    });

    await step('Assert: Expected 2 — Refused with "이 변경은 더 이상 승인할 수 없습니다: {reason}. 기안자에게 반려되었습니다." — no rule code; the request is returned', async () => {
      const message = page.getByText(/이 변경은 더 이상 승인할 수 없습니다: .+ 기안자에게 반려되었습니다\./).first();
      await expect.soft(message, '[Expected 2] The refusal names the failing check and says it was returned to the submitter').toBeVisible();
      await expect.soft(page.getByText(/[A-Z]{3}-\d{4}/), '[Expected 2] No rule code is shown on screen').toHaveCount(0);
      const change = latestChange((await submitterFeeRateApi.history(contract.id, fanRowId)).filter((item) => item.kind === 'RATE_CHANGE'));
      expect(change.status, '[Expected 2] The request is returned to the submitter — no longer pending').not.toBe('PENDING');
    });
  });

  test('TC_US078_73 — A rejected new fee row goes back to Draft, keeps what was typed, and prices no order', async ({ page, submitterFeeRateApi, submitterContracts, changeApprovalQueuePage: queue, contractFeePage: fee }) => {
    const step = makeStep(page);
    const reason = 'New fee row to reject';
    const rejectReason = 'Category not agreed with the partner yet';
    const from = inDays(20);
    await tcMeta('TC_US078_73', 'High', TAGS, `Rejecting a pending new fee row (팬클럽 키트 · 전체 위탁 · 일반, 9 % from today + 20 days) turns its Approval into 작성 중 (Draft) with the typed rate and date unchanged. Deviation from TC: the TC marks this BLOCKED (SPEC-GAP-14 — the add path created no request); recon 30/09 shows the add path now creates a request, so the case runs. Not automated: "prices no order" — no order data is available to price; the Draft approval state (never applied) is asserted instead. ${DATA}`);
    let contract = { id: 0 };
    let changeApprovalId: number | null | undefined;

    await step('Arrange: Pre-condition 1–2 — Logged in as APPROVER; a pending new fee row request exists (sent by the submitter)', async () => {
      contract = await submitterContracts.create('TC_US078_73', 'RUNNING');
      changeApprovalId = (await submitterContracts.addRow(contract.id, { ...NEW_ROW_KEY, commission: 9, effectiveFrom: from }, reason)).changeApprovalId;
    });

    await step(`Act: Step 1 — Open the request in 변경 승인, click 반려… (Reject), enter "${rejectReason}", confirm`, async () => {
      await queue.openRequest({ register: FEE_TEXT.queue.register, requester: getAccountDisplayName('submitter'), changeApprovalId: changeApprovalId!, reason });
      await queue.openRejectDialog();
      await queue.confirmReject(rejectReason);
    });

    await step('Assert: Expected 1 — Reject succeeds; the row reads 작성 중 (Draft), rate and date unchanged, prices no order', async () => {
      await expect.soft(queue.rejectedToast, '[Expected 1] 반려되었습니다 (Rejected) is confirmed').toBeVisible();
      await fee.open(contract.id);
      const row = fee.row(NEW_ROW_KEY);
      await expect.soft(fee.approvalBadge(row), '[Expected 1] Approval reads 작성 중 (Draft)').toHaveText(FEE_TEXT.approval.DRAFT);
      await expect.soft(fee.feeInput(row), '[Expected 1] The typed rate 9 is unchanged').toHaveValue('9');
      await expect.soft(fee.cell(row, 'effectiveFrom'), `[Expected 1] The typed date ${from} is unchanged`).toContainText(from);
      const apiNewRow = apiRow(await submitterFeeRateApi.feeRows(contract.id), NEW_ROW_KEY);
      expect(apiNewRow?.approval, '[Expected 1] The row was never applied (DRAFT), so it prices no order').toBe('DRAFT');
    });
  });

  test('TC_US078_74 — Fixing and saving a new fee row that was rejected sends it for approval again', async ({ page, feeRateApi, submitterFeeRateApi, submitterContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    const reason = 'Resubmit after rejection';
    await tcMeta('TC_US078_74', 'Medium', TAGS, `On a rejected new fee row (작성 중, rate 9), correcting the rate to 8 and saving creates a new approval request and the row reads 승인 대기 (Pending approval). Deviations from TC: the Draft row carries a start date (the add endpoint requires one); save on a running contract opens the "운영 중인 계약에 수수료 행 추가" reason dialog — the normal save path, filled in as part of the save. ${DATA}`);
    let contract = { id: 0 };
    let resubmitted = { status: 0 };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the 팬클럽 키트 new row was rejected and reads 작성 중 with rate 9', async () => {
      contract = await submitterContracts.create('TC_US078_74', 'RUNNING');
      const sent = await submitterContracts.addRow(contract.id, { ...NEW_ROW_KEY, commission: 9, effectiveFrom: inDays(20) }, 'New fee row to reject');
      expect((await feeRateApi.reject(sent.changeApprovalId!, 'Category not agreed with the partner yet')).status, 'The approver rejects the new row').toBe(200);
      await switchAccount(page, 'submitter');
    });

    await step('Act: Step 1 — Open the row, correct the rate to 8, save', async () => {
      await fee.openEdit(contract.id);
      await fee.feeInput(fee.row(NEW_ROW_KEY)).fill('8');
      resubmitted = await fee.resubmitDraftWithReason(reason);
    });

    await step('Assert: Expected 1 — A new request is created and the row reads 승인 대기 (Pending approval)', async () => {
      expect.soft(resubmitted.status, '[Expected 1] The save sends the row for approval again (201)').toBe(201);
      const row = apiRow(await submitterFeeRateApi.feeRows(contract.id), NEW_ROW_KEY);
      expect.soft(row?.approval, '[Expected 1] The register holds the row as PENDING').toBe('PENDING');
      await fee.open(contract.id);
      await expect.soft(fee.feeInput(fee.row(NEW_ROW_KEY)), '[Expected 1] The corrected rate 8 is kept').toHaveValue('8');
      await expect(fee.approvalBadge(fee.row(NEW_ROW_KEY)), '[Expected 1] Approval reads 승인 대기 (Pending approval)').toHaveText(FEE_TEXT.approval.PENDING);
    });
  });

  test('TC_US078_75 — A rejected draft row can be discarded, and its request history is still readable afterwards', async ({ page, feeRateApi, submitterFeeRateApi, submitterContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    const reason = 'New fee row to discard';
    await tcMeta('TC_US078_75', 'High', TAGS, `초안 삭제 on the rejected 작성 중 row, confirmed, removes it from the table; its earlier submission is still in the history. Deviation from TC: once removed the row has no History button and the contract trail lists approved changes only (recon 30/09) — the history is read through GET …/fee-rows/{id}/history. ${DATA}`);
    let contract = { id: 0 };
    let draftRowId = 0;

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the 팬클럽 키트 new row was rejected (작성 중) and no settlement run references it', async () => {
      contract = await submitterContracts.create('TC_US078_75', 'RUNNING');
      const sent = await submitterContracts.addRow(contract.id, { ...NEW_ROW_KEY, commission: 9, effectiveFrom: inDays(20) }, reason);
      draftRowId = sent.id;
      expect((await feeRateApi.reject(sent.changeApprovalId!, 'Category not agreed with the partner yet')).status, 'The approver rejects the new row').toBe(200);
      await switchAccount(page, 'submitter');
    });

    await step('Act: Step 1 — Click 초안 삭제 (Discard draft) on the row, confirm', async () => {
      await fee.openEdit(contract.id);
      await fee.openDiscard(fee.row(NEW_ROW_KEY));
      const deleted = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes(`/fee-rows/${draftRowId}`));
      await fee.discardDialog.confirmButton.click();
      expect((await deleted).status(), 'The discard is accepted').toBe(204);
    });

    await step('Assert: Expected 1 — The row is removed from the table', async () => {
      await expect(fee.row(NEW_ROW_KEY), '[Expected 1] The 팬클럽 키트 row is no longer in the table').toHaveCount(0);
    });

    await step('Act: Step 2 — Check the fee-rate change history for this row', async () => {
      await expect(fee.discardDialog.root, 'The discard dialog is closed').toHaveCount(0);
    });

    await step('Assert: Expected 2 — Its earlier submission is still visible in the history', async () => {
      const changes = await submitterFeeRateApi.history(contract.id, draftRowId);
      expect.soft(changes.length, '[Expected 2] The history still holds the submission').toBeGreaterThan(0);
      expect(changes.some((change) => change.reason === reason), `[Expected 2] The submission "${reason}" is still in the trail`).toBe(true);
    });
  });

  test('TC_US078_76 — Rejecting a correction or a replacement leaves the live row exactly as it was, still reading Applied', async ({ page, submitterFeeRateApi, submitterContracts, changeApprovalQueuePage: queue, contractFeePage: fee }) => {
    const step = makeStep(page);
    const [mdReason, albumReason] = ['MD correction to reject', 'Album rate change to reject'];
    const rejectReason = 'Rate confirmed correct as-is';
    await tcMeta('TC_US078_76', 'High', TAGS, `Rejecting the MD correction (10 % → 8 %) leaves the MD row identical to before the submission — 10 %, 적용됨 (Applied), not 반려; the same holds for a rejected rate change on the Album row. "Byte-identical" is checked on the register row (every field of GET …/fee-rows before vs after). ${DATA}`);
    let contract = { id: 0 };
    const ids = { md: 0, album: 0 };
    let before: FeeRow[] = [];
    const requester = () => getAccountDisplayName('submitter');
    const sameRow = async (key: typeof KEY.MD | typeof KEY.ALBUM) => [apiRow(before, key), apiRow(await submitterFeeRateApi.feeRows(contract.id), key)];

    await step('Arrange: Pre-condition 1–2 — Logged in as APPROVER; MD 10 % has a pending correction to 8 %; Album has a pending rate change', async () => {
      contract = await submitterContracts.create('TC_US078_76', 'RUNNING');
      before = await submitterFeeRateApi.feeRows(contract.id);
      ids.md = (await submitterContracts.submit(contract.id, KEY.MD, { changeKind: 'CORRECTION', commission: '8', changeReason: mdReason })).changeApprovalId!;
      ids.album = (await submitterContracts.submit(contract.id, KEY.ALBUM, { changeKind: 'RATE_CHANGE', commission: '9', effectiveFrom: inDays(15), changeReason: albumReason })).changeApprovalId!;
    });

    await step(`Act: Step 1 — Reject the correction request with "${rejectReason}", confirm`, async () => {
      await queue.openRequest({ register: FEE_TEXT.queue.register, requester: requester(), changeApprovalId: ids.md, reason: mdReason });
      await queue.openRejectDialog();
      await queue.confirmReject(rejectReason);
    });

    await step('Assert: Expected 1 — Reject succeeds', async () => {
      await expect(queue.rejectedToast, '[Expected 1] 반려되었습니다 (Rejected) is confirmed').toBeVisible();
    });

    await step('Act: Step 2 — Read the MD row', async () => {
      await fee.open(contract.id);
    });

    await step('Assert: Expected 2 — The row is identical to before — still 10 %, Approval still 적용됨, not Rejected', async () => {
      const [old, now] = await sameRow(KEY.MD);
      expect.soft(now, '[Expected 2] The MD register row is identical to before the submission').toEqual(old);
      await expect.soft(fee.feeInput(fee.row(KEY.MD)), '[Expected 2] MD still shows 10 %').toHaveValue('10');
      await expect(fee.approvalBadge(fee.row(KEY.MD)), '[Expected 2] Approval still reads 적용됨 (Applied)').toHaveText(FEE_TEXT.approval.APPLIED);
    });

    await step('Act: Step 3 — Repeat steps 1–2 for the pending rate change (replacement) on the Album row', async () => {
      await queue.openRequest({ register: FEE_TEXT.queue.register, requester: requester(), changeApprovalId: ids.album, reason: albumReason });
      await queue.openRejectDialog();
      await queue.confirmReject(rejectReason);
      await expect(queue.rejectedToast, 'The Album rejection is confirmed').toBeVisible();
      await fee.open(contract.id);
    });

    await step('Assert: Expected 3 — Same outcome for the rate-change case', async () => {
      const [old, now] = await sameRow(KEY.ALBUM);
      expect.soft(now, '[Expected 3] The Album register row is identical to before the submission').toEqual(old);
      await expect.soft(fee.feeInput(fee.row(KEY.ALBUM)), '[Expected 3] Album still shows 8 %').toHaveValue('8');
      await expect.soft(fee.approvalBadge(fee.row(KEY.ALBUM)), '[Expected 3] Approval still reads 적용됨 (Applied)').toHaveText(FEE_TEXT.approval.APPLIED);
      await expect(fee.row(KEY.ALBUM, inDays(15)), '[Expected 3] No replacement row was created').toHaveCount(0);
    });
  });

  test('TC_US078_77 — Rejecting a switch-on or switch-off request leaves the row in the state it was in, still reading Applied', async ({ page, submitterContracts, changeApprovalQueuePage: queue, contractFeePage: fee }) => {
    const step = makeStep(page);
    const reason = 'MD switch-off to reject';
    const rejectReason = 'Category still in use';
    await tcMeta('TC_US078_77', 'High', TAGS, `Rejecting the pending "switch to Inactive" request on MD leaves Status 활성 (Active) and Approval 적용됨 (Applied) — not 반려. ${DATA}`);
    let contract = { id: 0 };
    let changeApprovalId: number | null | undefined;

    await step('Arrange: Pre-condition 1–2 — Logged in as APPROVER; the MD row has a pending "switch to Inactive" request', async () => {
      contract = await submitterContracts.create('TC_US078_77', 'RUNNING');
      changeApprovalId = (await submitterContracts.deactivate(contract.id, KEY.MD, reason)).changeApprovalId;
    });

    await step(`Act: Step 1 — Reject the request with "${rejectReason}", confirm`, async () => {
      await queue.openRequest({ register: FEE_TEXT.queue.register, requester: getAccountDisplayName('submitter'), changeApprovalId: changeApprovalId!, reason });
      await queue.openRejectDialog();
      await queue.confirmReject(rejectReason);
    });

    await step('Assert: Expected 1 — Reject succeeds', async () => {
      await expect(queue.rejectedToast, '[Expected 1] 반려되었습니다 (Rejected) is confirmed').toBeVisible();
    });

    await step("Act: Step 2 — Read the MD row's Status and Approval", async () => {
      await fee.open(contract.id);
    });

    await step('Assert: Expected 2 — Status still 활성 (Active), Approval 적용됨 (Applied) — not Rejected', async () => {
      await expect.soft(fee.cell(fee.row(KEY.MD), 'status'), '[Expected 2] Status still reads 활성 (Active)').toHaveText(FEE_TEXT.statusActive);
      await expect(fee.approvalBadge(fee.row(KEY.MD)), '[Expected 2] Approval reads 적용됨 (Applied)').toHaveText(FEE_TEXT.approval.APPLIED);
    });
  });

  test("TC_US078_78 — The row shows a returned marker and the approver's reason can be read without leaving the tab", async ({ page, feeRateApi, submitterContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    const rejectReason = 'Rate confirmed correct as-is';
    await tcMeta('TC_US078_78', 'High', TAGS, `On the ADMIN's Fee Information tab the MD row carries a 반려됨 marker; its 변경 이력 shows the approver's reason "${rejectReason}" in full — all without leaving the tab. ${DATA}`);
    let contract = { id: 0 };
    let tabUrl = '';
    let reasonCell = '';

    await step(`Arrange: Pre-condition 1–2 — Logged in as ADMIN; the MD row has a rejected correction with reason "${rejectReason}"`, async () => {
      contract = await submitterContracts.create('TC_US078_78', 'RUNNING');
      const sent = await submitterContracts.submit(contract.id, KEY.MD, { changeKind: 'CORRECTION', commission: '8', changeReason: 'MD correction rejected by the approver' });
      expect((await feeRateApi.reject(sent.changeApprovalId!, rejectReason)).status, 'The approver rejects the correction').toBe(200);
      await switchAccount(page, 'submitter');
    });

    await step('Act: Step 1 — Open the Fee Information tab and look at the MD row', async () => {
      await fee.open(contract.id);
      tabUrl = page.url();
    });

    await step('Assert: Expected 1 — A marker on the row shows something came back, without leaving the tab', async () => {
      await expect.soft(fee.returnedMarker(fee.row(KEY.MD)), '[Expected 1] The MD row carries the 반려됨 (Returned) marker').toBeVisible();
      await expect(page, '[Expected 1] Still on the Fee Information tab').toHaveURL(tabUrl);
    });

    await step('Act: Step 2 — Click History on the row and read the rejection reason', async () => {
      await fee.openHistory(fee.row(KEY.MD));
      reasonCell = await fee.historyDialog.cell(0, 'reason').innerText();
    });

    await step(`Assert: Expected 2 — The history shows the approver's reason "${rejectReason}" in full`, async () => {
      expect.soft(reasonCell, `[Expected 2] The approver's reason is shown in full, attributed to ${getAccountDisplayName('approver')}`).toContain(`반려 사유 (${getAccountDisplayName('approver')}): ${rejectReason}`);
      await expect(page, '[Expected 2] The history opens over the same tab').toHaveURL(tabUrl);
    });
  });

  test('TC_US078_79 — The Fee Information tab shows the fresh approval result every time it is opened, never an old one', async ({ page, submitterContracts, approverBrowser, contractFeePage: fee }) => {
    const step = makeStep(page);
    const reason = 'MD correction approved in another session';
    await tcMeta('TC_US078_79', 'High', TAGS, `The ADMIN's tab reads 승인 대기 (Pending approval); the APPROVER approves in a second browser; the ADMIN leaves the contract and comes back with the browser Back button — the tab reads 적용됨 (Applied), not the cached 승인 대기. ${DATA}`);
    let contract = { id: 0 };
    let changeApprovalId: number | null | undefined;

    await step('Arrange: Pre-condition 1–2 — ADMIN in one session, APPROVER in a second; the MD row has a pending correction', async () => {
      contract = await submitterContracts.create('TC_US078_79', 'RUNNING');
      changeApprovalId = (await submitterContracts.submit(contract.id, KEY.MD, { changeKind: 'CORRECTION', commission: '8', changeReason: reason })).changeApprovalId;
      await switchAccount(page, 'submitter');
    });

    await step("Act: Step 1 — In the ADMIN session open the tab and note the row's Approval value", async () => {
      await fee.open(contract.id);
    });

    await step('Assert: Expected 1 — The row shows 승인 대기 (Pending approval)', async () => {
      await expect(fee.approvalBadge(fee.row(KEY.MD)), '[Expected 1] The MD row reads 승인 대기').toHaveText(FEE_TEXT.approval.PENDING);
    });

    await step('Act: Step 2 — In the Approver session approve the request', async () => {
      await approverBrowser.queue.openRequest({ register: FEE_TEXT.queue.register, requester: getAccountDisplayName('submitter'), changeApprovalId: changeApprovalId!, reason });
      await approverBrowser.queue.approve();
    });

    await step('Assert: Expected 2 — Approval succeeds', async () => {
      await expect(approverBrowser.queue.approvedToast, '[Expected 2] 승인되었습니다 is confirmed in the Approver session').toBeVisible();
    });

    await step('Act: Step 3 — In the ADMIN session leave the contract, then use the browser Back button to return to the same tab', async () => {
      await page.goto('/commerce/contracts');
      await page.goBack();
      if (!(await fee.feePanel.isVisible())) await fee.click(fee.feeTab, 'Fee Information (수수료 정보) tab');
    });

    await step('Assert: Expected 3 — The tab shows the fresh value 적용됨 (Applied), not the stale 승인 대기', async () => {
      await expect(fee.approvalBadge(fee.row(KEY.MD)), '[Expected 3] The MD row reads 적용됨 (Applied)').toHaveText(FEE_TEXT.approval.APPLIED);
    });
  });

  test('TC_US078_80 — Approving the same request twice has the same effect as approving it once', async ({ page, submitterFeeRateApi, submitterContracts, changeApprovalQueuePage: queue, contractFeePage: fee }) => {
    const step = makeStep(page);
    const reason = 'MD correction approved twice';
    await tcMeta('TC_US078_80', 'High', TAGS, `A duplicate 승인 click on the same pending MD correction changes the row once: one MD row at 8 % and one applied entry in the row history. ${DATA}`);
    let contract = { id: 0 };
    let changeApprovalId: number | null | undefined;
    let mdRowId = 0;
    const approveCalls: number[] = [];

    await step('Arrange: Pre-condition 1–2 — Logged in as APPROVER; the MD row has a pending correction', async () => {
      contract = await submitterContracts.create('TC_US078_80', 'RUNNING');
      mdRowId = await submitterContracts.rowId(contract.id, KEY.MD);
      changeApprovalId = (await submitterContracts.submit(contract.id, KEY.MD, { changeKind: 'CORRECTION', commission: '8', changeReason: reason })).changeApprovalId;
    });

    await step('Act: Step 1 — Click 승인 (Approve) and, before the queue refreshes, click 승인 again on the same item if still visible', async () => {
      page.on('response', (r) => {
        if (r.request().method() === 'POST' && r.url().includes(`/change-approvals/${changeApprovalId}/approve`)) approveCalls.push(r.status());
      });
      await queue.openRequest({ register: FEE_TEXT.queue.register, requester: getAccountDisplayName('submitter'), changeApprovalId: changeApprovalId!, reason });
      await queue.click(queue.approveButton, '승인 (Approve) button');
      await expect(queue.approveDialog, 'The 승인 확인 dialog opens').toBeVisible();
      await queue.approveDialogConfirmButton.dblclick();
      await expect.poll(() => approveCalls.length, { message: 'The approve call is answered' }).toBeGreaterThan(0);
      if (await queue.approveButton.isVisible()) await queue.approveButton.click();
      await page.waitForLoadState('networkidle');
    });

    await step('Assert: Expected 1 — The row changes exactly once — no second row, no second trail entry', async () => {
      const mdRows = (await submitterFeeRateApi.feeRows(contract.id)).filter((row) => row.categoryId === CATEGORY.MD.id && row.saleTypeId === SALE_TYPE.SELF.id);
      const applied = (await submitterFeeRateApi.history(contract.id, mdRowId)).filter((change) => change.status === 'APPLIED');
      expect.soft(approveCalls.filter((status) => status < 300), '[Expected 1] Only one approve call succeeds').toHaveLength(1);
      expect.soft(mdRows.map((row) => [row.id, row.commission]), '[Expected 1] One MD row at 8 %').toEqual([[mdRowId, '8']]);
      expect.soft(applied, '[Expected 1] One applied history entry').toHaveLength(1);
      await fee.open(contract.id);
      await expect(fee.feeInput(fee.row(KEY.MD)), '[Expected 1] The tab shows MD at 8 %').toHaveValue('8');
    });
  });
});
