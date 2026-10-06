import { test, expect } from '@fixtures/purchase-order.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { PO_KO } from '@utils/purchase-order.i18n';
import { errorCode, PoDetail, PurchaseOrderApi } from '@api/purchase-order.api';
import { PoData, toPoUpdateBody } from '@utils/purchase-order.data';

/**
 * 발주 취소 / 발주 종결 (US105) — huỷ PO chưa có receipt, đóng PO giao thiếu, lý do lưu nguyên văn, trạng thái cuối không
 * còn thao tác, worklist cuối tháng. Receipt chênh lệch được account thứ 2 (dungbd.fpt) duyệt để thành Complete khi TC cần
 * "đã nhận N"; số 입고예정 đọc từ /stock-status.
 */
const TAGS = ['close', 'purchase-order'];

/** PO Issued đã nhận `received` (Complete — chênh lệch được account thứ 2 duyệt). */
async function shortDelivered(poData: PoData, approver: PurchaseOrderApi, qty: number, received: number, sku: 'A' | 'B' | 'C' = 'A'): Promise<PoDetail> {
  const po = await poData.createIssued([{ sku, qty }]);
  await poData.receive(po, received, 0, 'ADJ_DISCREPANCY');
  const [grn] = await poData.api.goodsReceipts(po.id);
  if (grn.status === 'EXCEPTION') {
    const detail = (await approver.goodsReceipt(po.id, grn.id)).body;
    await approver.resolveReceipt(po.id, grn.id, 'ADJ_DISCREPANCY', null, detail.version);
  }
  return poData.read(po.id);
}

test.describe('[Close] 발주 취소 / 발주 종결 — cancel, close and the terminal states', () => {
  test.describe.configure({ timeout: 180_000 });

  test('TC_US105_098 — Cancel PO on an Issued PO without receipt moves it to Canceled and withdraws the expected inbound', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_098', 'Critical', TAGS, 'Baseline expected inbound noted; the dialog is titled "발주 취소 사유" and usable without an approver; confirming moves the PO to Canceled storing the reason; the expected inbound falls by exactly 120; the form shows the reason verbatim labelled 취소 사유 (not 종결 사유).');
    const po = await poData.createIssued([{ sku: 'B', qty: 120 }]);
    const sku = poData.warehouse.skus.B.id;
    let baseline = 0;

    await step('Arrange: Pre-condition 1–2 — PO A Issued, one line of 120, no receipt', async () => {
      await poForm.openPo(po.id);
    });

    await step('Act: Step 1 — Note the current expected inbound quantity', async () => {
      baseline = (await poData.api.stockOf(sku, poData.warehouse.id)).incoming;
    });
    await step('Assert: Expected 1 — The baseline figure is noted', async () => {
      expect(baseline, '[Expected 1] Baseline includes the 120 of PO A').toBeGreaterThanOrEqual(120);
    });

    await step('Act: Step 2 — Open PO A and click 발주 취소', async () => {
      await poForm.cancelPoButton.click();
      await poForm.reasonDialog().waitOpen();
    });
    await step('Assert: Expected 2 — Title "Cancel reason"; usable with no approver', async () => {
      await expect(poForm.reasonDialog().title, '[Expected 2] 발주 취소 사유').toHaveText(PO_KO['text.reasonTitleCancel']);
      await expect(poForm.reasonDialog().confirmButton, '[Expected 2] Usable').toBeEnabled();
    });

    await step('Act: Step 3 — Enter any reason and confirm', async () => {
      await poForm.reasonDialog().reasonInput.fill('auto 098 supplier withdrew');
      await poForm.reasonDialog().confirmButton.click();
    });
    await step('Assert: Expected 3 — Canceled; the reason is stored in close_reason', async () => {
      await expect(poForm.toast(PO_KO['text.toastCanceled']), '[Expected 3] Cancel toast').toBeVisible();
      const after = await poData.read(po.id);
      expect(after.status, '[Expected 3] CANCELED').toBe('CANCELED');
      expect(after.closeReason, '[Expected 3] Reason stored').toBe('auto 098 supplier withdrew');
    });

    await step('Act: Step 4 — Reopen the stock screen', async () => undefined);
    await step('Assert: Expected 4 — The expected inbound falls by exactly 120', async () => {
      expect((await poData.api.stockOf(sku, poData.warehouse.id)).incoming, '[Expected 4] −120').toBe(baseline - 120);
    });

    await step('Act: Step 5 — Reopen PO A and read the reason shown on the form', async () => {
      await poForm.openPo(po.id);
    });
    await step('Assert: Expected 5 — The reason verbatim, labelled 취소 사유 rather than 종결 사유', async () => {
      await expect(page.getByText(PO_KO['text.cancelReasonLabel'], { exact: true }), '[Expected 5] Label 발주 취소 사유').toBeVisible();
      await expect(page.getByText(PO_KO['text.closeReasonLabel'], { exact: true }), '[Expected 5] Not labelled 종결 사유').toHaveCount(0);
      await expect(page.getByText('auto 098 supplier withdrew', { exact: true }), '[Expected 5] Verbatim').toBeVisible();
    });
  });

  test('TC_US105_099 — Cancel PO is blocked once the PO has a receipt; the message points to Close PO', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_099', 'High', TAGS, 'Cancel reason dialog opens; confirming is refused with PRC-1005 "이미 입고 건이 등록된 발주서는 취소할 수 없습니다…"; the PO stays Issued; Close PO opens the Close reason dialog normally.');
    const po = await poData.createIssued([{ qty: 300 }]);

    await step('Arrange: Pre-condition 1–2 — PO A Issued with Receipt A in Exception', async () => {
      await poData.receive(po, 290, 0, 'ADJ_DISCREPANCY');
      await poForm.openPo(po.id);
    });

    await step('Act: Step 1 — Click 발주 취소', async () => {
      await poForm.cancelPoButton.click();
      await poForm.reasonDialog().waitOpen();
    });
    await step('Assert: Expected 1 — The dialog opens titled "Cancel reason"', async () => {
      await expect(poForm.reasonDialog().title, '[Expected 1] 발주 취소 사유').toHaveText(PO_KO['text.reasonTitleCancel']);
    });

    await step('Act: Step 2 — Enter any reason and confirm', async () => {
      await poForm.reasonDialog().reasonInput.fill('auto 099');
      await poForm.reasonDialog().confirmButton.click();
    });
    await step('Assert: Expected 2 — Refused with PRC-1005 and its sentence', async () => {
      await expect(page.locator('body'), '[Expected 2] PRC-1005 sentence').toContainText(PO_KO['error.PRC-1005']);
    });

    await step('Act: Step 3 — Observe the PO status badge', async () => {
      await page.keyboard.press('Escape');
    });
    await step('Assert: Expected 3 — Still Issued', async () => {
      await expect(poForm.statusBadge, '[Expected 3] Issued').toHaveText(PO_KO['poStatus.ISSUED']);
    });

    await step('Act: Step 4 — Click 발주 종결 on the same PO', async () => {
      await poForm.closePoButton.click();
      await poForm.reasonDialog().waitOpen();
    });
    await step('Assert: Expected 4 — The Close reason dialog opens normally', async () => {
      await expect(poForm.reasonDialog().title, '[Expected 4] 발주 종결 사유').toHaveText(PO_KO['text.reasonTitleClose']);
    });
  });

  test('TC_US105_101 — The close reason renders verbatim, is capped at 200 and cannot be edited afterwards', async ({ page, poForm, poData, approverPoApi }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_101', 'Medium', TAGS, '200 characters accepted, the 201st refused; confirming closes the PO and the reason renders verbatim labelled 종결 사유; the text is read-only; an API attempt to change the close reason is refused and the original stays; a PO that closes itself by a full receipt shows no reason area.');
    const reason = 'r'.repeat(199) + 'Z';
    let po: PoDetail;
    let api = { status: 0, body: null as unknown };

    await step('Arrange: Pre-condition 1–2 — PO A Issued and short-delivered', async () => {
      po = await shortDelivered(poData, approverPoApi, 300, 290);
      await poForm.openPo(po.id);
      await poForm.closePoButton.click();
      await poForm.reasonDialog().waitOpen();
    });

    await step('Act: Step 1 — Click 발주 종결 and enter exactly 200 characters', async () => {
      await poForm.reasonDialog().reasonInput.fill(reason);
    });
    await step('Assert: Expected 1 — The field takes all 200 characters', async () => {
      await expect(poForm.reasonDialog().reasonInput, '[Expected 1] 200').toHaveValue(reason);
    });

    await step('Act: Step 2 — Try to enter a 201st character', async () => {
      await poForm.reasonDialog().reasonInput.press('End');
      await poForm.reasonDialog().reasonInput.pressSequentially('!');
    });
    await step('Assert: Expected 2 — The 201st character is not accepted', async () => {
      expect((await poForm.reasonDialog().reasonInput.inputValue()).length, '[Expected 2] Still 200').toBe(200);
    });

    await step('Act: Step 3 — Confirm, then read the close reason on screen', async () => {
      await poForm.reasonDialog().confirmButton.click();
      await expect(poForm.statusBadge).toHaveText(PO_KO['poStatus.CLOSED']);
    });
    await step('Assert: Expected 3 — Closed; the reason renders verbatim, labelled 종결 사유', async () => {
      await expect(page.getByText(PO_KO['text.closeReasonLabel'], { exact: true }), '[Expected 3] Label').toBeVisible();
      await expect(page.getByText(reason, { exact: true }), '[Expected 3] Verbatim, untruncated').toBeVisible();
    });

    await step('Act: Step 4 — Try to click into the reason text and edit it', async () => {
      await page.getByText(reason, { exact: true }).click();
      await page.keyboard.type('edit');
    });
    await step('Assert: Expected 4 — It cannot be edited (read-only area)', async () => {
      await expect(page.getByText(reason, { exact: true }), '[Expected 4] Unchanged').toBeVisible();
      await expect(page.locator(`input[value="${reason}"], textarea`), '[Expected 4] Not an editable control').toHaveCount(0);
    });

    await step('Act: Step 5 — Call the API to change the close reason, then reload', async () => {
      const fresh = await poData.read(po.id);
      api = await poData.api.update(po.id, { ...toPoUpdateBody(fresh), closeReason: 'changed by api' });
      await page.reload();
    });
    await step('Assert: Expected 5 — Refused; the reason is still the original string', async () => {
      expect(api.status, '[Expected 5] Refused').toBeGreaterThanOrEqual(400);
      expect((await poData.read(po.id)).closeReason, '[Expected 5] Original reason').toBe(reason);
    });

    let selfClosed: PoDetail;
    await step('Act: Step 6 — On another PO, receive the full quantity so it closes itself; open it and look for a reason area', async () => {
      selfClosed = await poData.createIssued([{ qty: 50 }]);
      await poData.receive(selfClosed, 50, 0);
      await poForm.openPo(selfClosed.id);
    });
    await step('Assert: Expected 6 — No reason area at all on a self-closed order', async () => {
      await expect(poForm.statusBadge, '[Expected 6] Closed').toHaveText(PO_KO['poStatus.CLOSED']);
      await expect(page.getByText(PO_KO['text.closeReasonLabel'], { exact: true }), '[Expected 6] No reason area').toHaveCount(0);
    });
  });

  test('TC_US105_102 — A Closed or Canceled PO shows an empty action row; its history stays readable', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_102', 'High', TAGS, 'Closed PO A (one completed receipt) and Canceled PO B render none of Save draft / Issue PO / Delete / Receive goods / Cancel PO / Close PO (not even disabled); the receipt history is fully readable; every field is read-only; Excel download stays usable.');
    const closed = await poData.createIssued([{ qty: 40 }]);
    const canceled = await poData.createIssued();
    const actions = () => [poForm.saveDraftButton, poForm.issueButton, poForm.deleteButton, poForm.receiveButton, poForm.cancelPoButton, poForm.closePoButton];

    await step('Arrange: Pre-condition 1–2 — PO A Closed with one completed receipt; PO B Canceled', async () => {
      await poData.receive(closed, 40, 0);
      await poData.api.cancel(canceled.id, 'auto 102', canceled.version);
    });

    await step('Act: Step 1 — Open PO A and observe the action row', async () => {
      await poForm.openPo(closed.id);
    });
    await step('Assert: Expected 1 — None of the six action buttons is rendered', async () => {
      for (const button of actions()) await expect(button, '[Expected 1] Not drawn at all').toHaveCount(0);
    });

    await step('Act: Step 2 — Observe the receipt history block on PO A', async () => {
      await poForm.grnTable.scrollIntoViewIfNeeded();
    });
    await step('Assert: Expected 2 — The receipt history is rendered and readable', async () => {
      await expect(poForm.grnRows, '[Expected 2] One receipt row').toHaveCount(1);
      await expect(poForm.grnRows.first().locator('td').nth(3), '[Expected 2] Received qty readable').toHaveText('40');
    });

    await step('Act: Step 3 — Open PO B and observe the action row', async () => {
      await poForm.openPo(canceled.id);
    });
    await step('Assert: Expected 3 — No action button is rendered', async () => {
      for (const button of actions()) await expect(button, '[Expected 3] Not drawn').toHaveCount(0);
    });

    await step('Act: Step 4 — Observe the general information fields on PO B', async () => {
      await poForm.supplierTypeSelect.scrollIntoViewIfNeeded();
    });
    await step('Assert: Expected 4 — Every field read-only; Excel download usable', async () => {
      await expect(page.locator('.card-body select, .card-body input:not([readonly])').filter({ visible: true }), '[Expected 4] No editable field').toHaveCount(0);
      await expect(poForm.excelButton, '[Expected 4] Excel download usable').toBeEnabled();
    });
  });

  test('TC_US105_103 — Every write against a Closed or Canceled PO is refused; the status is untouched', async ({ page, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_103', 'High', TAGS, 'Changing qty on a Closed PO → PRC-1002; re-issuing it → PRC-1002 "현재 상태의 발주서에서는 사용할 수 없는 작업입니다…"; re-opening a Canceled PO to a previous status refused; create-receipt on it refused; both keep their status and data. API calls only (the browser shows nothing).');
    const closed = await poData.createIssued();
    const canceled = await poData.createIssued();
    const r: Record<number, { status: number; body: unknown }> = {};

    await step('Arrange: Pre-condition 1–2 — PO A Closed and PO B Canceled', async () => {
      await poData.api.close(closed.id, 'auto 103', closed.version);
      await poData.api.cancel(canceled.id, 'auto 103', canceled.version);
    });

    await step('Act: Step 1 — Change the line Ordered qty on PO A', async () => {
      const fresh = await poData.read(closed.id);
      r[1] = await poData.api.update(closed.id, toPoUpdateBody(fresh, { lines: [{ ...toPoUpdateBody(fresh).lines[0], orderedQty: 999 }] }));
    });
    await step('Assert: Expected 1 — Refused with PRC-1002', async () => {
      expect(errorCode(r[1].body), '[Expected 1] PRC-1002').toBe('PRC-1002');
    });

    await step('Act: Step 2 — Call the API to re-issue PO A', async () => {
      r[2] = await poData.api.issue(closed.id, (await poData.read(closed.id)).version);
    });
    await step('Assert: Expected 2 — Same code with the not-available sentence', async () => {
      expect(errorCode(r[2].body), '[Expected 2] PRC-1002').toBe('PRC-1002');
      expect(JSON.stringify(r[2].body), '[Expected 2] Sentence').toContain(PO_KO['error.PRC-1002']);
    });

    await step('Act: Step 3 — Call the API to reopen PO B to its previous status', async () => {
      r[3] = await poData.api.issue(canceled.id, (await poData.read(canceled.id)).version);
    });
    await step('Assert: Expected 3 — Refused; no path back to a previous status', async () => {
      expect(r[3].status, '[Expected 3] Refused').toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 4 — Call the create-receipt API on PO B', async () => {
      const fresh = await poData.read(canceled.id);
      r[4] = await poData.api.createReceipt(canceled.id, await poData.receiptBody(fresh, 10, 0));
    });
    await step('Assert: Expected 4 — Refused; no receipt is created', async () => {
      expect(r[4].status, '[Expected 4] Refused').toBeGreaterThanOrEqual(400);
      expect(await poData.api.goodsReceipts(canceled.id), '[Expected 4] No receipt').toEqual([]);
    });

    await step('Act: Step 5 — Call the read API on both POs', async () => undefined);
    await step('Assert: Expected 5 — Still Closed and Canceled; data unchanged', async () => {
      expect((await poData.read(closed.id)).status, '[Expected 5] CLOSED').toBe('CLOSED');
      expect((await poData.read(closed.id)).lines[0].orderedQty, '[Expected 5] Qty unchanged').toBe(300);
      expect((await poData.read(canceled.id)).status, '[Expected 5] CANCELED').toBe('CANCELED');
    });
  });

  test('TC_US105_104 — The month-end review flow: leave open or close with a reason; nothing closes on elapsed time', async ({ page, poList, poForm, poData, approverPoApi }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_104', 'High', TAGS, 'Status Issued on the shared destination returns exactly PO A (290 / 300) and PO B (180 / 200); PO A left alone stays Issued; closing PO B with a reason stores it; the expected inbound falls by exactly PO B\'s 20 while PO A\'s 10 is kept. Not automated: step 6 (waiting past 30 days from the Expected date). Counted on the automation warehouse of the run.');
    const sku = poData.warehouse.skus.A.id;
    let poA: PoDetail;
    let poB: PoDetail;
    let baseline = 0;

    await step('Arrange: Pre-condition 1–3 — PO A received 290 / 300 and PO B 180 / 200 on one destination; no other Issued PO', async () => {
      poA = await shortDelivered(poData, approverPoApi, 300, 290);
      poB = await shortDelivered(poData, approverPoApi, 200, 180);
      await poList.open();
      await poList.warehouseSelect.selectOption({ label: poData.warehouse.name });
    });

    await step('Act: Step 1 — Set Status to Issued and click 검색', async () => {
      await poList.statusSelect.selectOption('ISSUED');
      await poList.search();
    });
    await step('Assert: Expected 1 — Exactly PO A and PO B (the short-delivered worklist)', async () => {
      expect((await poList.columnTexts(PO_KO['col.poList.poNo'])).sort(), '[Expected 1] Exactly A and B').toEqual([poA.poNo, poB.poNo].sort());
    });

    await step('Act: Step 2 — Note the current expected inbound quantity at the destination', async () => {
      baseline = (await poData.api.stockOf(sku, poData.warehouse.id)).incoming;
    });
    await step('Assert: Expected 2 — The baseline figure is noted', async () => {
      expect(baseline, '[Expected 2] Includes the 10 + 20 outstanding').toBeGreaterThanOrEqual(30);
    });

    await step('Act: Step 3 — Open PO A, do nothing and return to the list', async () => {
      await poList.openPo(poA.poNo);
      await poForm.backToListButton.click();
    });
    await step('Assert: Expected 3 — PO A is still Issued', async () => {
      expect((await poData.read(poA.id)).status, '[Expected 3] ISSUED').toBe('ISSUED');
    });

    await step('Act: Step 4 — Open PO B, click 발주 종결, enter any reason and confirm', async () => {
      await poForm.openPo(poB.id);
      await poForm.closePoButton.click();
      await poForm.reasonDialog().reasonInput.fill('auto 104 remainder will not arrive');
      await poForm.reasonDialog().confirmButton.click();
    });
    await step('Assert: Expected 4 — PO B is Closed and the reason is stored', async () => {
      await expect(poForm.statusBadge, '[Expected 4] Closed').toHaveText(PO_KO['poStatus.CLOSED']);
      expect((await poData.read(poB.id)).closeReason, '[Expected 4] Reason stored').toBe('auto 104 remainder will not arrive');
    });

    await step('Act: Step 5 — Check the expected inbound quantity again', async () => undefined);
    await step('Assert: Expected 5 — Falls by exactly PO B\'s 20; PO A\'s 10 is kept', async () => {
      expect((await poData.api.stockOf(sku, poData.warehouse.id)).incoming, '[Expected 5] −20').toBe(baseline - 20);
    });

    await step('Act: Step 6 — Wait past the 30-day mark from PO A\'s Expected date, then reopen PO A', async () => {
      await poForm.openPo(poA.id);
    });
    await step('Assert: Expected 6 — PO A is still Issued (elapsed-time part: Not automated)', async () => {
      // Not automated: chờ quá 30 ngày kể từ 입고예정일 — không giả lập được đồng hồ server. Kiểm trạng thái hiện tại.
      await expect(poForm.statusBadge, '[Expected 6] Issued').toHaveText(PO_KO['poStatus.ISSUED']);
    });
  });
});
