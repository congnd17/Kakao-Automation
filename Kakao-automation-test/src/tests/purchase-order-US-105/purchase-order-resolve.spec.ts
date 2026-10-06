import { test, expect } from '@fixtures/purchase-order.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { PO_KO } from '@utils/purchase-order.i18n';
import { PurchaseOrderFormPage } from '@pages/purchase-order-form.page';
import { DELIVERY_NOTE, PoData, UI_REASONS } from '@utils/purchase-order.data';
import { GrnDetail, PoDetail, PurchaseOrderApi } from '@api/purchase-order.api';

/**
 * 입고 차이 처리 (US105) — duyệt / sửa / từ chối receipt bị giữ ở Exception, quy tắc maker ≠ checker. 2 danh tính:
 * congnd17.fpt (browser chính, `poApi`) và dungbd.fpt (browser 2 `approverPage`, `approverPoApi`). Người ghi receipt
 * được chọn theo TC; teardown từ chối các receipt còn chờ và huỷ / đóng PO.
 */
const TAGS = ['resolve', 'purchase-order'];

async function held(poData: PoData, recorder: PurchaseOrderApi, qty = 300, received = 290, damaged = 0, sku: 'A' | 'C' = 'A'): Promise<{ po: PoDetail; grn: GrnDetail }> {
  const po = await poData.createIssued([{ sku, qty }]);
  await poData.receive(po, received, damaged, 'ADJ_DISCREPANCY', recorder);
  const [summary] = await poData.api.goodsReceipts(po.id);
  return { po: await poData.read(po.id), grn: (await poData.api.goodsReceipt(po.id, summary.id)).body };
}

test.describe('[Resolve] 입고 차이 처리 — approve, edit and reject a held receipt', () => {
  test.describe.configure({ timeout: 240_000 });

  test('TC_US105_087 — The person who recorded the receipt cannot resolve its own discrepancy', async ({ page, poForm, poData, approverPage, approverPoApi }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_087', 'Critical', TAGS, 'Approver 1 recorded Receipt A; its dialog opens; approving is refused with 403 PRC-1028 "본인이 등록한 입고 건은 본인이 처리할 수 없습니다…" (never PRC-1011); the receipt stays Exception with no stock; Approver 2 resolves it to Complete. Approver 1 = dungbd.fpt (browser 2), Approver 2 = congnd17.fpt.');
    const formB = new PurchaseOrderFormPage(approverPage);
    let data: { po: PoDetail; grn: GrnDetail };
    let baseline = 0;

    await step('Arrange: Pre-condition 1–2 — Two APPROVER accounts; Receipt A in Exception recorded by Approver 1', async () => {
      data = await held(poData, approverPoApi);
      baseline = (await poData.api.stockOf(poData.warehouse.skus.A.id, poData.warehouse.id)).available;
    });

    await step('Act: Step 1 — Log in as Approver 1 and open the discrepancy dialog for Receipt A', async () => {
      await formB.openPo(data.po.id);
      await formB.openResolve(data.grn.grnNo);
    });
    await step('Assert: Expected 1 — The dialog opens (this account really is an APPROVER)', async () => {
      await expect(formB.resolveDialog().title, '[Expected 1] Dialog open').toContainText(PO_KO['text.exceptionTitle']);
    });

    let status = 0;
    await step('Act: Step 2 — Pick a 차이 사유 and click 차이 승인', async () => {
      const dialog = formB.resolveDialog();
      await dialog.reasonSelect.selectOption({ label: '불일치' });
      const response = approverPage.waitForResponse((r) => r.url().endsWith('/resolve')).catch(() => null);
      await dialog.approveButton.click({ force: true });
      status = (await response)?.status() ?? 0;
    });
    await step('Assert: Expected 2 — 403 PRC-1028 identity sentence; never PRC-1011', async () => {
      if (status) expect(status, '[Expected 2] 403').toBe(403);
      await expect(approverPage.locator('body'), '[Expected 2] PRC-1028 sentence').toContainText(PO_KO['error.PRC-1028']);
      await expect(approverPage.locator('body'), '[Expected 2] Not the role sentence (PRC-1011)').not.toContainText(PO_KO['error.PRC-1011']);
    });

    await step('Act: Step 3 — Observe the receipt status and stock', async () => undefined);
    await step('Assert: Expected 3 — Still Exception; no stock written', async () => {
      expect((await poData.api.goodsReceipts(data.po.id))[0].status, '[Expected 3] EXCEPTION').toBe('EXCEPTION');
      expect((await poData.api.stockOf(poData.warehouse.skus.A.id, poData.warehouse.id)).available, '[Expected 3] Stock unchanged').toBe(baseline);
    });

    await step('Act: Step 4 — Log in as Approver 2 and click 차이 승인 on the same receipt', async () => {
      await poForm.openPo(data.po.id);
      const dialog = await poForm.openResolve(data.grn.grnNo);
      await dialog.reasonSelect.selectOption({ label: '불일치' });
      await dialog.approveButton.click();
    });
    await step('Assert: Expected 4 — The resolution succeeds and the receipt is Complete', async () => {
      await expect(poForm.toast(PO_KO['text.toastGrnResolved']), '[Expected 4] Resolve toast').toBeVisible();
      expect((await poData.api.goodsReceipts(data.po.id))[0].status, '[Expected 4] COMPLETE').toBe('COMPLETE');
    });
  });

  test('TC_US105_088 — An APPROVER resolves the discrepancy; accepted goods enter stock, damage goes to Defective on-hold', async ({ page, poForm, poData, approverPoApi, poWarehouseApi }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_088', 'Critical', TAGS, 'Baseline stock; the dialog shows 300 / 290 / 0 / −10; Purchase amount 11,353,500; 불일치 approve moves Exception → Complete with "차이가 승인되었습니다 — 재고가 반영되었습니다."; available +290; with damaged 5 available +285 and the Defective bucket\'s on-hold stock (보류재고) +5, not its available stock. Recorded by dungbd.fpt, resolved by congnd17.fpt.');
    const sku = poData.warehouse.skus.C.id;
    let data: { po: PoDetail; grn: GrnDetail };
    let baseline = 0;
    let defective = 0;

    await step('Arrange: Pre-condition 1–4 — Receipt A Exception 290 / 0 at 39,150 recorded by another account; DEFECTIVE bucket exists', async () => {
      data = await held(poData, approverPoApi, 300, 290, 0, 'C');
      defective = (await poWarehouseApi.bucketsOf({ id: poData.warehouse.id, name: poData.warehouse.name })).find((b) => b.name.endsWith('불량'))!.id;
    });

    await step('Act: Step 1 — Note the available stock of the SKU at Warehouse A', async () => {
      baseline = (await poData.api.stockOf(sku, poData.warehouse.id)).available;
    });
    await step('Assert: Expected 1 — The baseline figure is noted', async () => {
      expect(baseline, '[Expected 1] Baseline').toBeGreaterThanOrEqual(0);
    });

    await step('Act: Step 2 — Open PO A and click the Resolve link', async () => {
      await poForm.openPo(data.po.id);
      await poForm.openResolve(data.grn.grnNo);
    });
    await step('Assert: Expected 2 — Ordered 300, Received 290, Damaged 0, Discrepancy −10', async () => {
      const cells = poForm.resolveDialog().table.locator('tbody tr').first().locator('td');
      await expect(cells.nth(1), '[Expected 2] Ordered 300').toHaveText('300');
      await expect(cells.nth(2), '[Expected 2] Received 290').toHaveText('290');
      await expect(cells.nth(3), '[Expected 2] Damaged 0').toHaveText('0');
      await expect(cells.nth(4), '[Expected 2] Discrepancy −10').toHaveText('−10');
    });

    await step('Act: Step 3 — Check the Purchase amount column', async () => undefined);
    await step('Assert: Expected 3 — 11,353,500 (received × unit price)', async () => {
      await expect(poForm.resolveDialog().table.locator('tbody tr').first().locator('td').nth(5), '[Expected 3] 11,353,500').toHaveText('11,353,500');
    });

    await step('Act: Step 4 — Set 차이 사유 to 불일치 and click 차이 승인', async () => {
      const dialog = poForm.resolveDialog();
      await dialog.reasonSelect.selectOption({ label: '불일치' });
      await dialog.approveButton.click();
    });
    await step('Assert: Expected 4 — Exception → Complete with the resolve toast', async () => {
      await expect(poForm.toast(PO_KO['text.toastGrnResolved']), '[Expected 4] Toast').toBeVisible();
      expect((await poData.api.goodsReceipts(data.po.id))[0].status, '[Expected 4] COMPLETE').toBe('COMPLETE');
    });

    await step('Act: Step 5 — Reopen the stock screen for the SKU', async () => undefined);
    await step('Assert: Expected 5 — Available stock at Warehouse A rises by exactly 290', async () => {
      expect((await poData.api.stockOf(sku, poData.warehouse.id)).available, '[Expected 5] +290').toBe(baseline + 290);
    });

    let before = { available: 0, hold: 0, defAvail: 0 };
    await step('Act: Step 6 — Repeat the whole flow on a receipt with 파손 수량 5', async () => {
      const damaged = await held(poData, approverPoApi, 300, 290, 5, 'C');
      before = { available: (await poData.api.stockOf(sku, poData.warehouse.id)).available, hold: (await poData.api.stockOf(sku, defective)).hold, defAvail: (await poData.api.stockOf(sku, defective)).available };
      await poForm.openPo(damaged.po.id);
      const dialog = await poForm.openResolve(damaged.grn.grnNo);
      await dialog.reasonSelect.selectOption({ label: '파손' });
      await dialog.approveButton.click();
      await expect(poForm.toast(PO_KO['text.toastGrnResolved'])).toBeVisible();
    });
    await step('Assert: Expected 6 — Available +285; Defective on-hold +5 (not its available); Complete', async () => {
      expect((await poData.api.stockOf(sku, poData.warehouse.id)).available, '[Expected 6] Available +285').toBe(before.available + 285);
      expect((await poData.api.stockOf(sku, defective)).hold, '[Expected 6] Defective on-hold +5').toBe(before.hold + 5);
      expect((await poData.api.stockOf(sku, defective)).available, '[Expected 6] Defective available unchanged (known regression risk)').toBe(before.defAvail);
    });
  });

  test('TC_US105_089 — Cancel on the discrepancy dialog leaves the receipt in Exception and writes nothing', async ({ page, poForm, poData, approverPoApi }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_089', 'Medium', TAGS, 'Baseline stock noted; the dialog takes a reason and a note; Cancel closes it; the receipt keeps its Exception badge, the reason / note are not saved and stock is unchanged.');
    let data: { po: PoDetail; grn: GrnDetail };
    let baseline = 0;

    await step('Arrange: Pre-condition 1–2 — PO A with Receipt A in Exception', async () => {
      data = await held(poData, approverPoApi);
      await poForm.openPo(data.po.id);
    });

    await step('Act: Step 1 — Note the available stock', async () => {
      baseline = (await poData.api.stockOf(poData.warehouse.skus.A.id, poData.warehouse.id)).available;
    });
    await step('Assert: Expected 1 — The baseline figure is noted', async () => {
      expect(baseline, '[Expected 1] Baseline').toBeGreaterThanOrEqual(0);
    });

    await step('Act: Step 2 — Open the discrepancy dialog, pick a 차이 사유 and enter a note', async () => {
      const dialog = await poForm.openResolve(data.grn.grnNo);
      await dialog.reasonSelect.selectOption({ label: '분실' });
      await dialog.noteInput.fill('auto 089 note');
    });
    await step('Assert: Expected 2 — The dialog takes the values', async () => {
      await expect(poForm.resolveDialog().noteInput, '[Expected 2] Note entered').toHaveValue('auto 089 note');
    });

    await step('Act: Step 3 — Click the cancel button', async () => {
      await poForm.resolveDialog().cancelButton.click();
    });
    await step('Assert: Expected 3 — The dialog closes', async () => {
      await expect(page.locator('.modal.show'), '[Expected 3] Closed').toHaveCount(0);
    });

    await step('Act: Step 4 — Observe the receipt badge and check stock again', async () => undefined);
    await step('Assert: Expected 4 — Still Exception, reason / note not saved, stock unchanged', async () => {
      await expect(poForm.grnRow(data.grn.grnNo).locator('.badge'), '[Expected 4] Exception badge').toHaveText(PO_KO['grnStatus.EXCEPTION']);
      const after = (await poData.api.goodsReceipt(data.po.id, data.grn.id)).body;
      expect(after.resolutionReason ?? null, '[Expected 4] Note not saved').toBeNull();
      expect((await poData.api.stockOf(poData.warehouse.skus.A.id, poData.warehouse.id)).available, '[Expected 4] Stock unchanged').toBe(baseline);
    });
  });

  test('TC_US105_090 — Approve discrepancy stays disabled until a reason is chosen; the table is read-only', async ({ page, poForm, poData, approverPoApi }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_090', 'Medium', TAGS, 'Approve discrepancy disabled before a reason; no table cell is editable; the reason list matches the Receive goods list exactly; choosing 파손 enables the button. Receipt recorded by dungbd.fpt, reviewed by congnd17.fpt.');
    let data: { po: PoDetail; grn: GrnDetail };

    await step('Arrange: Pre-condition 1–2 — Receipt A in Exception recorded by a different account', async () => {
      data = await held(poData, approverPoApi);
      await poForm.openPo(data.po.id);
    });

    await step('Act: Step 1 — Open the discrepancy dialog and observe 차이 승인 before a reason', async () => {
      await poForm.openResolve(data.grn.grnNo);
    });
    await step('Assert: Expected 1 — Approve discrepancy is disabled', async () => {
      await expect(poForm.resolveDialog().approveButton, '[Expected 1] Disabled').toBeDisabled();
    });

    await step('Act: Step 2 — Try to edit 입고완료수량 and 파손 수량 in the dialog table', async () => {
      await poForm.resolveDialog().table.scrollIntoViewIfNeeded();
    });
    await step('Assert: Expected 2 — No cell can be edited', async () => {
      await expect(poForm.resolveDialog().table.locator('input, select, textarea'), '[Expected 2] Read-only table').toHaveCount(0);
    });

    await step('Act: Step 3 — Expand the 차이 사유 list and sweep every entry', async () => {
      await poForm.resolveDialog().reasonSelect.focus();
    });
    await step('Assert: Expected 3 — The list matches the Receive goods dialog exactly', async () => {
      expect((await poForm.resolveDialog().reasonSelect.locator('option').allInnerTexts()).slice(1), '[Expected 3] Same four codes').toEqual(UI_REASONS.map((r) => r.name));
    });

    await step('Act: Step 4 — Set 차이 사유 to 파손', async () => {
      await poForm.resolveDialog().reasonSelect.selectOption({ label: '파손' });
    });
    await step('Assert: Expected 4 — Approve discrepancy becomes usable', async () => {
      await expect(poForm.resolveDialog().approveButton, '[Expected 4] Enabled').toBeEnabled();
    });
  });

  for (const tc of ['TC_US105_091', 'TC_US105_093'] as const) {
    test(`${tc} — An approver who recorded the receipt has Approve discrepancy disabled with the identity message`, async ({ page, poData, approverPage, approverPoApi, poApi }) => {
      const step = makeStep(page);
      await tcMeta(tc, 'High', TAGS, 'Approver 1 recorded Receipt A: the dialog opens; 차이 승인 disabled with the tooltip "You recorded this receipt."; still disabled once a reason is chosen; the identity message (ko form) is shown and the approver-only sentence is not; on Receipt B (recorded by another account) neither branch shows and the button is usable. Approver 1 = dungbd.fpt on browser 2.');
      const formB = new PurchaseOrderFormPage(approverPage);
      let a: { po: PoDetail; grn: GrnDetail };
      let b: { po: PoDetail; grn: GrnDetail };

      await step('Arrange: Pre-condition 1–3 — Receipt A recorded by Approver 1; Receipt B recorded by a different account', async () => {
        a = await held(poData, approverPoApi);
        b = await held(poData, poApi);
      });

      await step('Act: Step 1 — Log in as Approver 1, open PO A and click the Resolve link', async () => {
        await formB.openPo(a.po.id);
        await formB.openResolve(a.grn.grnNo);
      });
      await step('Assert: Expected 1 — The dialog opens normally', async () => {
        await expect(formB.resolveDialog().title, '[Expected 1] Open').toContainText(PO_KO['text.exceptionTitle']);
      });

      await step('Act: Step 2 — Observe 차이 승인 and its tooltip', async () => {
        await formB.resolveDialog().approveButton.scrollIntoViewIfNeeded();
      });
      await step('Assert: Expected 2 — Disabled with the tooltip "You recorded this receipt."', async () => {
        const button = formB.resolveDialog().approveButton;
        await expect(button, '[Expected 2] Disabled').toBeDisabled();
        await expect(button, '[Expected 2] Tooltip "You recorded this receipt."').toHaveAttribute('title', /본인이 등록한|You recorded this receipt/);
      });

      await step('Act: Step 3 — Pick a 차이 사유 and observe the button again', async () => {
        await formB.resolveDialog().reasonSelect.selectOption({ label: '불일치' });
      });
      await step('Assert: Expected 3 — Still disabled: identity locks it, not a missing reason', async () => {
        await expect(formB.resolveDialog().approveButton, '[Expected 3] Still disabled').toBeDisabled();
      });

      await step('Act: Step 4 — Observe the message area directly above the button group', async () => {
        await formB.resolveDialog().root.locator('.modal-footer').scrollIntoViewIfNeeded();
      });
      await step('Assert: Expected 4 — Identity message shown (ko form); approver-only sentence NOT shown', async () => {
        const root = formB.resolveDialog().root;
        await expect(root, '[Expected 4] "본인이 등록한 입고 건은 본인이 처리할 수 없습니다. 다른 승인자에게 요청해 주세요."').toContainText(PO_KO['error.PRC-1028']);
        await expect(root, '[Expected 4] "Only an approver can resolve…" is not shown').not.toContainText(/Only an approver can resolve|승인자만/);
      });

      await step('Act: Step 5 — Close, open PO B, click its Resolve link and observe the message area and the button', async () => {
        await formB.resolveDialog().cancelButton.click();
        await formB.openPo(b.po.id);
        await formB.openResolve(b.grn.grnNo);
        await formB.resolveDialog().reasonSelect.selectOption({ label: '불일치' });
      });
      await step('Assert: Expected 5 — Neither branch rendered; Approve discrepancy usable', async () => {
        const root = formB.resolveDialog().root;
        await expect(root, '[Expected 5] No identity message').not.toContainText(PO_KO['error.PRC-1028']);
        await expect(formB.resolveDialog().approveButton, '[Expected 5] Usable').toBeEnabled();
      });
    });
  }

  test('TC_US105_094 — The note is mandatory when the code requires one, optional otherwise, capped at 200', async ({ page, poForm, poData, approverPoApi }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_094', 'Medium', TAGS, '파손 with an empty note resolves; 기타 with an empty note → PRC-1030 "이 사유는 상세 사유 입력이 필요합니다.", receipt still Exception; the note takes 200 characters and refuses the 201st; after approving, the note is stored in the history and cannot be edited. Receipts recorded by dungbd.fpt.');
    let first: { po: PoDetail; grn: GrnDetail };
    let second: { po: PoDetail; grn: GrnDetail };

    await step('Arrange: Pre-condition 1–3 — Two Exception receipts recorded by another account; 기타 requires a note, 파손 does not', async () => {
      first = await held(poData, approverPoApi);
      second = await held(poData, approverPoApi);
    });

    await step('Act: Step 1 — Open the first receipt, set 파손, leave the note empty and click 차이 승인', async () => {
      await poForm.openPo(first.po.id);
      const dialog = await poForm.openResolve(first.grn.grnNo);
      await dialog.reasonSelect.selectOption({ label: '파손' });
      await dialog.approveButton.click();
    });
    await step('Assert: Expected 1 — The resolution succeeds (note optional for this code)', async () => {
      await expect(poForm.toast(PO_KO['text.toastGrnResolved']), '[Expected 1] Resolved').toBeVisible();
    });

    await step('Act: Step 2 — Open the second receipt, set 기타, leave the note empty and click 차이 승인', async () => {
      await poForm.openPo(second.po.id);
      const dialog = await poForm.openResolve(second.grn.grnNo);
      await dialog.reasonSelect.selectOption({ label: '기타' });
      await dialog.approveButton.click();
    });
    await step('Assert: Expected 2 — Blocked with PRC-1030; still Exception, nothing posted', async () => {
      await expect(poForm.resolveDialog().root, '[Expected 2] PRC-1030 sentence').toContainText(PO_KO['error.PRC-1030']);
      expect((await poData.api.goodsReceipts(second.po.id))[0].status, '[Expected 2] EXCEPTION').toBe('EXCEPTION');
    });

    await step('Act: Step 3 — Enter exactly 200 characters in the note field', async () => {
      await poForm.resolveDialog().noteInput.fill('n'.repeat(200));
    });
    await step('Assert: Expected 3 — The field takes all 200 characters', async () => {
      expect((await poForm.resolveDialog().noteInput.inputValue()).length, '[Expected 3] 200').toBe(200);
    });

    await step('Act: Step 4 — Try to enter a 201st character', async () => {
      await poForm.resolveDialog().noteInput.press('End');
      await poForm.resolveDialog().noteInput.pressSequentially('z');
    });
    await step('Assert: Expected 4 — The 201st character is not accepted', async () => {
      expect((await poForm.resolveDialog().noteInput.inputValue()).length, '[Expected 4] Still 200').toBe(200);
    });

    await step('Act: Step 5 — Click 차이 승인, then reopen the receipt and try to edit the note', async () => {
      await poForm.resolveDialog().approveButton.click();
      await expect(poForm.toast(PO_KO['text.toastGrnResolved'])).toBeVisible();
      await poForm.openPo(second.po.id);
      await poForm.grnAction(second.grn.grnNo).click();
    });
    await step('Assert: Expected 5 — Complete; the note is stored in the history and cannot be edited', async () => {
      expect((await poData.api.goodsReceipts(second.po.id))[0].status, '[Expected 5] COMPLETE').toBe('COMPLETE');
      const history = await poData.api.receiptHistory(second.po.id, second.grn.id);
      expect(history.flatMap((h) => h.changes).some((c) => c.field === 'resolution_reason' && c.after === 'n'.repeat(200)), '[Expected 5] The note is in the history').toBe(true);
      await expect(poForm.resolveDialog().noteInput, '[Expected 5] The note is not editable').toHaveCount(0);
    });
  });

  test('TC_US105_133 — Edit is offered only to the recorder, overwrites the same receipt and leaves it in Exception', async ({ page, poForm, poData, approverPage }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_133', 'High', TAGS, 'Operator 2 sees Edit disabled with "입고를 등록한 담당자만 수정할 수 있습니다…"; Operator 1 (received_by) has Edit enabled; Edit reopens the receive dialog pre-filled; correcting to 300 overwrites the SAME GRN; Discrepancy 0 but still Exception; correcting back to 290 with a new reason leaves one history row per edit. Operator 1 = congnd17.fpt, Operator 2 = dungbd.fpt.');
    const formB = new PurchaseOrderFormPage(approverPage);
    let data: { po: PoDetail; grn: GrnDetail };

    await step('Arrange: Pre-condition 1–2 — Receipt A Exception, 290 of 300, recorded by Operator 1', async () => {
      data = await held(poData, poData.api);
    });

    await step('Act: Step 1 — As Operator 2, open PO A, click the Resolve link and observe Edit', async () => {
      await formB.openPo(data.po.id);
      await formB.openResolve(data.grn.grnNo);
    });
    await step('Assert: Expected 1 — Edit rendered but DISABLED with the recorder-only tooltip', async () => {
      await expect(formB.resolveDialog().editButton, '[Expected 1] Disabled').toBeDisabled();
      await expect(formB.resolveDialog().editButton, '[Expected 1] Tooltip').toHaveAttribute('title', PO_KO['error.PRC-1033']);
    });

    await step('Act: Step 2 — As Operator 1, open PO A, click the Resolve link and observe Edit', async () => {
      await poForm.openPo(data.po.id);
      await poForm.openResolve(data.grn.grnNo);
    });
    await step('Assert: Expected 2 — Edit is enabled for the receipt\'s own received_by', async () => {
      await expect(poForm.resolveDialog().editButton, '[Expected 2] Enabled').toBeEnabled();
    });

    await step('Act: Step 3 — Click Edit, observe the dialog, correct 입고완료수량 to 300 and save', async () => {
      await poForm.resolveDialog().editButton.click();
      const dialog = poForm.receiveDialog();
      await dialog.waitOpen();
      await expect(dialog.receivedQty(), 'The receive dialog reopens pre-filled with 290').toHaveValue('290');
      await dialog.receivedQty().fill('300');
      const response = page.waitForResponse((r) => r.request().method() === 'PUT' && /\/goods-receipts\/\d+$/.test(new URL(r.url()).pathname));
      await dialog.saveButton.click();
      await response;
    });
    await step('Assert: Expected 3 — Pre-filled dialog; saving overwrites the SAME GRN, no second receipt', async () => {
      const receipts = await poData.api.goodsReceipts(data.po.id);
      expect(receipts.map((r) => r.grnNo), '[Expected 3] Same GRN, one receipt').toEqual([data.grn.grnNo]);
      expect(receipts[0].receivedQty, '[Expected 3] Overwritten to 300').toBe(300);
      await expect(poForm.toast(PO_KO['text.toastGrnUpdated']), '[Expected 3] Update toast').toBeVisible();
    });

    await step('Act: Step 4 — Observe the receipt status and the Approve discrepancy button', async () => {
      await poForm.openPo(data.po.id);
      await poForm.openResolve(data.grn.grnNo);
    });
    await step('Assert: Expected 4 — Discrepancy 0 but STILL Exception; approval still needed by another person', async () => {
      expect((await poData.api.goodsReceipts(data.po.id))[0].status, '[Expected 4] EXCEPTION').toBe('EXCEPTION');
      await expect(poForm.resolveDialog().table.locator('tbody tr').first().locator('td').nth(4), '[Expected 4] Discrepancy 0').toHaveText('0');
      await poForm.resolveDialog().reasonSelect.selectOption({ label: '불일치' });
      await expect(poForm.resolveDialog().approveButton, '[Expected 4] Recorder cannot approve').toBeDisabled();
    });

    await step('Act: Step 5 — Reopen and correct 입고완료수량 back to 290 with a new reason; check the receipt history', async () => {
      await poForm.resolveDialog().editButton.click();
      const dialog = poForm.receiveDialog();
      await dialog.waitOpen();
      await dialog.receivedQty().fill('290');
      await dialog.reasonSelect.selectOption({ label: '분실' });
      const response = page.waitForResponse((r) => r.request().method() === 'PUT' && /\/goods-receipts\/\d+$/.test(new URL(r.url()).pathname));
      await dialog.saveButton.click();
      await response;
    });
    await step('Assert: Expected 5 — Still Exception; one history row per Edit with before / after', async () => {
      expect((await poData.api.goodsReceipts(data.po.id))[0].status, '[Expected 5] EXCEPTION').toBe('EXCEPTION');
      const qtyRows = (await poData.api.receiptHistory(data.po.id, data.grn.id)).filter((h) => h.changes.some((c) => c.field === 'received_qty'));
      expect(qtyRows, '[Expected 5] One row per edit').toHaveLength(2);
      expect(qtyRows[0].changes.find((c) => c.field === 'received_qty'), '[Expected 5] Newest edit 300 → 290').toMatchObject({ before: '300', after: '290' });
    });
  });

  test('TC_US105_135 — An approver rejects a held receipt with a coded reason; the quantity returns to outstanding', async ({ page, poForm, poData, approverPoApi }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_135', 'High', TAGS, 'Reject receipt opens the third caller "입고 반려 사유"; a code without an explanation → PRC-1006; 불일치 + "receipt was keyed against the wrong purchase order" → REJECTED; Receive goods unlocks and outstanding is back to 300; the approver rejecting a receipt they recorded → PRC-1028. Approver 1 = congnd17.fpt; the receipt is recorded by dungbd.fpt.');
    let data: { po: PoDetail; grn: GrnDetail };
    const reason = poForm.reasonDialog();

    await step('Arrange: Pre-condition 1–2 — Receipt A Exception 290 / 300 recorded by an INVENTORY_OPERATOR (not the approver)', async () => {
      data = await held(poData, approverPoApi);
    });

    await step('Act: Step 1 — As Approver 1 open PO A, click the Resolve link and click Reject receipt', async () => {
      await poForm.openPo(data.po.id);
      const dialog = await poForm.openResolve(data.grn.grnNo);
      await dialog.rejectButton.click();
      await reason.waitOpen();
    });
    await step('Assert: Expected 1 — The shared reason dialog opens titled "Reject reason"', async () => {
      await expect(reason.title, '[Expected 1] 입고 반려 사유').toHaveText(PO_KO['text.reasonTitleGrnReject']);
    });

    await step('Act: Step 2 — Observe the fields, then confirm with a code but no explanation', async () => {
      await reason.reasonCodeSelect.selectOption({ label: '불일치' });
      await reason.confirmButton.click();
    });
    await step('Assert: Expected 2 — Refused with PRC-1006 (code and explanation both mandatory)', async () => {
      await expect(reason.root, '[Expected 2] PRC-1006 sentence').toContainText(PO_KO['error.PRC-1006']);
    });

    await step('Act: Step 3 — Set code 불일치, enter the explanation and confirm', async () => {
      await reason.reasonInput.fill('receipt was keyed against the wrong purchase order');
      await reason.confirmButton.click();
    });
    await step('Assert: Expected 3 — The receipt becomes REJECTED (terminal)', async () => {
      await expect(poForm.toast(PO_KO['text.toastGrnRejected']), '[Expected 3] Reject toast').toBeVisible();
      expect((await poData.api.goodsReceipts(data.po.id))[0].status, '[Expected 3] REJECTED').toBe('REJECTED');
    });

    await step('Act: Step 4 — Observe the receipt status, the outstanding quantity and Receive goods', async () => {
      await poForm.openPo(data.po.id);
    });
    await step('Assert: Expected 4 — Receive goods unlocks and the outstanding quantity is back to 300', async () => {
      await expect(poForm.receiveButton, '[Expected 4] Receive goods enabled').toBeEnabled();
      await expect(poForm.receiveButton, '[Expected 4] Not dimmed').not.toHaveClass(/opacity-50/);
      expect((await poData.read(data.po.id)).lines[0].outstanding, '[Expected 4] Outstanding 300').toBe(300);
    });

    await step('Act: Step 5 — Approver 1 records Receipt B in Exception and tries to reject it', async () => {
      const dialog = await poForm.openReceive();
      await dialog.fillQuantities(280);
      await dialog.reasonSelect.selectOption({ label: '불일치' });
      await dialog.attach('auto_delivery_note.pdf', DELIVERY_NOTE);
      const saved = poForm.waitForReceiptSave();
      await dialog.saveButton.click();
      await saved;
      const receiptB = (await poData.api.goodsReceipts(data.po.id)).find((r) => r.status === 'EXCEPTION')!;
      await poForm.openPo(data.po.id);
      const resolve = await poForm.openResolve(receiptB.grnNo);
      await resolve.rejectButton.click();
      await reason.reasonCodeSelect.selectOption({ label: '불일치' });
      await reason.reasonInput.fill('auto 135 self reject');
      await reason.confirmButton.click();
    });
    await step('Assert: Expected 5 — Refused with PRC-1028 (the rejecter must not be the received_by)', async () => {
      await expect(page.locator('body'), '[Expected 5] PRC-1028 sentence').toContainText(PO_KO['error.PRC-1028']);
    });
  });

  test('TC_US105_138 — Change history is reachable on a receipt in every status; Reject is not offered once not held', async ({ page, poForm, poData, approverPoApi }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_138', 'Medium', TAGS, 'Receipt A (Exception) opens via "차이 처리" ready to act; Receipts B (Complete) and C (Rejected) open via "View" read-only; on A Edit and Reject are rendered (Edit disabled for a non-recorder, Reject enabled); on B and C neither has a live path while Change history is rendered on all three; Change history on C opens the goodsreceipt history. Receipts recorded by dungbd.fpt, reviewed by congnd17.fpt on one PO of 300.');
    const po = await poData.createIssued([{ qty: 300 }]);
    const grn: Record<'A' | 'B' | 'C', GrnDetail> = {} as never;

    await step('Arrange: Pre-condition 1–2 — PO A carries Receipt A Exception, Receipt B Complete, Receipt C Rejected', async () => {
      const receiveAs = async () => {
        await poData.receive(po, 100, 0, 'ADJ_DISCREPANCY', approverPoApi);
        const latest = (await poData.api.goodsReceipts(po.id)).find((r) => r.status === 'EXCEPTION')!;
        return (await poData.api.goodsReceipt(po.id, latest.id)).body;
      };
      grn.C = await receiveAs();
      await poData.api.rejectReceipt(po.id, grn.C.id, 'ADJ_DISCREPANCY', 'auto 138', grn.C.version);
      grn.B = await receiveAs();
      await poData.api.resolveReceipt(po.id, grn.B.id, 'ADJ_DISCREPANCY', null, grn.B.version);
      grn.A = await receiveAs();
      await poForm.openPo(po.id);
    });

    await step('Act: Step 1 — Click the action-cell link on Receipt A, B and C in turn', async () => {
      await poForm.grnTable.scrollIntoViewIfNeeded();
    });
    await step('Assert: Expected 1 — A opens via "Resolve"; B and C via "View", read-only', async () => {
      await expect(poForm.grnAction(grn.A.grnNo), '[Expected 1] Receipt A → 차이 처리').toHaveText(PO_KO['text.resolve']);
      for (const key of ['B', 'C'] as const) await expect(poForm.grnAction(grn[key].grnNo), `[Expected 1] Receipt ${key} → View`).not.toHaveText(PO_KO['text.resolve']);
    });

    await step('Act: Step 2 — On Receipt A\'s dialog, observe Edit and Reject receipt', async () => {
      await poForm.openResolve(grn.A.grnNo);
    });
    await step('Assert: Expected 2 — Both rendered: Edit disabled (not the recorder), Reject enabled', async () => {
      await expect(poForm.resolveDialog().editButton, '[Expected 2] Edit disabled').toBeDisabled();
      await expect(poForm.resolveDialog().rejectButton, '[Expected 2] Reject enabled').toBeEnabled();
      await poForm.resolveDialog().cancelButton.click();
    });

    await step('Act: Step 3 — On Receipt B\'s and C\'s read-only dialogs, observe the same two buttons and Change history', async () => {
      await poForm.openResolve(grn.B.grnNo);
    });
    await step('Assert: Expected 3 — Edit and Reject absent or disabled on B and C; Change history rendered on all three', async () => {
      for (const key of ['B', 'C'] as const) {
        if (key === 'C') {
          await page.keyboard.press('Escape');
          await poForm.openResolve(grn.C.grnNo);
        }
        const dialog = poForm.resolveDialog();
        for (const button of [dialog.editButton, dialog.rejectButton]) {
          const live = (await button.count()) > 0 && (await button.isEnabled());
          expect(live, `[Expected 3] Receipt ${key}: ${await button.innerText().catch(() => 'button')} has no live path`).toBe(false);
        }
        await expect(dialog.historyButton, `[Expected 3] Receipt ${key}: Change history rendered`).toBeVisible();
      }
    });

    await step('Act: Step 4 — Click Change history on Receipt C', async () => {
      const history = page.waitForResponse((r) => new RegExp(`/goods-receipts/${grn.C.id}/history`).test(r.url()));
      await poForm.resolveDialog().historyButton.click();
      await history;
    });
    await step('Assert: Expected 4 — The shared history dialog opens for Receipt C', async () => {
      await expect(poForm.historyDialog().title, '[Expected 4] 변경 이력').toContainText(PO_KO['text.grnHistoryTitle']);
    });
  });
});
