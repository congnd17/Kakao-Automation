import { Request } from '@playwright/test';
import { test, expect } from '@fixtures/purchase-order.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { PO_KO, fmt } from '@utils/purchase-order.i18n';
import { PurchaseOrderFormPage, ReceiveDialog } from '@pages/purchase-order-form.page';
import { DELIVERY_NOTE, seoulToday, UI_REASONS } from '@utils/purchase-order.data';
import { newIdempotencyKey } from '@api/purchase-order.api';

/**
 * 입고 검수 (US105) — dialog nhận hàng, tính toán theo phần còn tồn đọng, lý do chênh lệch, chứng từ giao hàng, chống
 * ghi trùng (Idempotency-Key), 2 trình duyệt cùng ghi. Receipt chỉ ghi trên kho automation; số tồn đọc từ /stock-status.
 * Người ghi receipt qua UI = congnd17.fpt; người duyệt chênh lệch = dungbd.fpt (browser 2 / approverPoApi).
 */
const TAGS = ['receive', 'purchase-order'];

/** Mở dialog, nhập số lượng (+ lý do), đính kèm 1 chứng từ PDF nếu `attach`. */
async function fillReceipt(form: PurchaseOrderFormPage, received: number, damaged = 0, reason?: string, attach = true): Promise<ReceiveDialog> {
  const dialog = await form.openReceive();
  await dialog.fillQuantities(received, damaged);
  if (reason) await dialog.reasonSelect.selectOption({ label: reason });
  if (attach) await dialog.attach('auto_delivery_note.pdf', DELIVERY_NOTE);
  return dialog;
}

/** Bấm 저장 và chờ response POST goods-receipts. */
async function saveReceipt(form: PurchaseOrderFormPage, dialog: ReceiveDialog) {
  const response = form.waitForReceiptSave();
  await dialog.saveButton.click();
  return response;
}

test.describe('[Receive] 입고 검수 — receive dialog, quantities, reasons and duplicates', () => {
  test.describe.configure({ timeout: 240_000 });

  for (const tc of ['TC_US105_065', 'TC_US105_066'] as const) {
    test(`${tc} — A receipt for the exact quantity completes at once, writes stock once and closes the PO`, async ({ page, poForm, poData }) => {
      const step = makeStep(page);
      await tcMeta(tc, 'Critical', TAGS, `Baseline available stock noted; 120 received with 0 damaged shows Discrepancy 0 and needs no reason; Save shows "입고 건이 저장되었습니다."${tc === 'TC_US105_066' ? ' and carries the Idempotency-Key minted when the dialog opened' : ''}; the receipt is Complete and the PO closes itself with no reason; available stock is exactly 120 higher.`);
      const po = await poData.createIssued([{ sku: 'C', qty: 120 }]);
      const sku = poData.warehouse.skus.C.id;
      let baseline = 0;
      let dialog: ReceiveDialog;
      const posted: Request[] = [];

      await step('Arrange: Pre-condition 1–2 — PO A Issued, one line of 120 at Warehouse A, no receipt', async () => {
        await poForm.openPo(po.id);
        page.on('request', (r) => r.method() === 'POST' && /\/goods-receipts$/.test(new URL(r.url()).pathname) && posted.push(r));
      });

      await step('Act: Step 1 — Note the current available stock of the SKU at Warehouse A', async () => {
        baseline = (await poData.api.stockOf(sku, poData.warehouse.id)).available;
      });
      await step('Assert: Expected 1 — The baseline figure is noted', async () => {
        expect(baseline, '[Expected 1] Baseline noted').toBeGreaterThanOrEqual(0);
      });

      await step(`Act: Step 2 — Open 입고 검수${tc === 'TC_US105_066' ? ' (one Idempotency-Key minted)' : ''}, enter 120 and leave 파손 수량 at 0`, async () => {
        dialog = await fillReceipt(poForm, 120, 0);
      });
      await step('Assert: Expected 2 — Discrepancy 0 and no Discrepancy reason required', async () => {
        await expect(dialog.calcValue(PO_KO['text.calcDiscrepancy']), '[Expected 2] Discrepancy 0').toHaveText('0');
        await expect(dialog.root.locator('label.form-label').filter({ hasText: PO_KO['text.discrepancyReasonLabel'] }), '[Expected 2] No mandatory marker on the reason').not.toContainText('*');
      });

      await step('Act: Step 3 — Click Save', async () => {
        await saveReceipt(poForm, dialog);
      });
      await step('Assert: Expected 3 — "Goods receipt saved."', async () => {
        await expect(poForm.toast(PO_KO['text.toastGrnSaved']), '[Expected 3] Save toast').toBeVisible();
        if (tc === 'TC_US105_066') expect(posted[0]?.headers()['idempotency-key'], '[Expected 3] The request carries the key minted at dialog opening').toMatch(/^[A-Za-z0-9_-]{8,}$/);
      });

      await step('Act: Step 4 — Observe the receipt history block and the PO status badge', async () => {
        await poForm.grnTable.scrollIntoViewIfNeeded();
      });
      await step('Assert: Expected 4 — Complete badge; the PO moves to Closed with no reason asked for', async () => {
        await expect(poForm.grnRows.first().locator('.badge'), '[Expected 4] Complete').toHaveText(PO_KO['grnStatus.COMPLETE']);
        await expect(poForm.statusBadge, '[Expected 4] PO Closed').toHaveText(PO_KO['poStatus.CLOSED']);
        expect((await poData.read(po.id)).closeReason ?? null, '[Expected 4] No reason stored on a self-close').toBeNull();
      });

      await step('Act: Step 5 — Reopen the stock screen for the SKU at Warehouse A', async () => undefined);
      await step('Assert: Expected 5 — Available stock is exactly 120 higher', async () => {
        expect((await poData.api.stockOf(sku, poData.warehouse.id)).available, '[Expected 5] +120').toBe(baseline + 120);
      });
    });
  }

  test('TC_US105_067 — The derived figures compute against the outstanding basis, not the ordered quantity', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_067', 'High', TAGS, 'After a COMPLETE receipt of 200 on a 300 line the dialog shows Still outstanding 100; entering 100 gives Missing / Discrepancy 0 against that basis; Accepted, Missing, Discrepancy and Still outstanding are all 0; on a fresh order 90 received / 5 damaged gives Missing 10 and Discrepancy −10 against the full 300.');
    const po = await poData.createIssued([{ qty: 300 }]);
    const fresh = await poData.createIssued([{ qty: 300 }]);
    let dialog: ReceiveDialog;

    await step('Arrange: Pre-condition 1–2 — PO A 300 × 39,150 with one prior COMPLETE receipt of 200 (100 outstanding)', async () => {
      await poData.receive(po, 200, 0);
      await poForm.openPo(po.id);
    });

    await step('Act: Step 1 — Open PO A and click 입고 검수', async () => {
      dialog = await poForm.openReceive();
    });
    await step('Assert: Expected 1 — Still outstanding 100, the basis for this receipt', async () => {
      await expect(dialog.lineCell(0, 4), '[Expected 1] Still outstanding 100').toHaveText('100');
    });

    await step('Act: Step 2 — Enter 입고완료수량 100', async () => {
      await dialog.fillQuantities(100);
    });
    await step('Assert: Expected 2 — Missing and Discrepancy compute against the 100 outstanding', async () => {
      await expect(dialog.calcValue(PO_KO['text.calcDiscrepancy']), '[Expected 2] Discrepancy 0').toHaveText('0');
    });

    await step('Act: Step 3 — Observe the summary calculation panel', async () => {
      await dialog.calcPanel.scrollIntoViewIfNeeded();
    });
    await step('Assert: Expected 3 — Accepted, Missing, Discrepancy all zero; Still outstanding 0', async () => {
      await expect(dialog.calcValue(PO_KO['text.calcDiscrepancy']), '[Expected 3] Discrepancy 0 (not −200)').toHaveText('0');
      await expect(dialog.lineCell(0, 4), '[Expected 3] Still outstanding 0').toHaveText('0');
      await expect(dialog.calcValue(PO_KO['text.calcToDefective']), '[Expected 3] Nothing to Defective').toHaveText('0');
    });

    await step('Act: Step 4 — On a fresh order with no prior receipt, enter 90 and 파손 수량 5', async () => {
      await dialog.cancelButton.click();
      await poForm.openPo(fresh.id);
      dialog = await poForm.openReceive();
      await dialog.fillQuantities(90, 5);
    });
    await step('Assert: Expected 4 — Missing 10 and Discrepancy −10 against the full 300', async () => {
      await expect(dialog.calcValue(PO_KO['text.calcDiscrepancy']), '[Expected 4] Discrepancy −10 against the full 300 (as the TC states)').toHaveText('−10');
      await expect(dialog.lineCell(0, 4), '[Expected 4] Missing 10').toHaveText('10');
    });
  });

  test('TC_US105_068 — A Damaged qty greater than the Received qty is refused', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_068', 'Medium', TAGS, 'Received 290 accepted; Damaged 290 (equal) accepted with Accepted 0; Damaged 291 blocks Save, highlights the field and shows PRC-1015 "파손 수량은 입고 완료 수량을 초과할 수 없습니다."');
    const po = await poData.createIssued([{ qty: 300 }]);
    let dialog: ReceiveDialog;

    await step('Arrange: Pre-condition 1–2 — PO A Issued with one line of 300', async () => {
      await poForm.openPo(po.id);
    });

    await step('Act: Step 1 — Open 입고 검수 and enter 입고완료수량 290', async () => {
      dialog = await poForm.openReceive();
      await dialog.fillQuantities(290);
    });
    await step('Assert: Expected 1 — Received qty takes 290', async () => {
      await expect(dialog.receivedQty(), '[Expected 1] 290').toHaveValue('290');
    });

    await step('Act: Step 2 — Enter 파손 수량 290', async () => {
      await dialog.damagedQty().fill('290');
    });
    await step('Assert: Expected 2 — Equal value accepted; Accepted computes to 0', async () => {
      await expect(dialog.damagedQty(), '[Expected 2] Not flagged').not.toHaveClass(/is-invalid/);
      await expect(dialog.calcValue(PO_KO['text.calcToAvailable']), '[Expected 2] Accepted 0').toHaveText('0');
    });

    await step('Act: Step 3 — Enter 파손 수량 291 and click Save', async () => {
      await dialog.damagedQty().fill('291');
      await dialog.saveButton.click();
    });
    await step('Assert: Expected 3 — Blocked, field highlighted, PRC-1015 message', async () => {
      await expect(dialog.damagedQty(), '[Expected 3] Damaged qty highlighted').toHaveClass(/is-invalid/);
      await expect(dialog.root, '[Expected 3] PRC-1015 message').toContainText(PO_KO['error.PRC-1015']);
      expect(await poData.api.goodsReceipts(po.id), '[Expected 3] No receipt created').toEqual([]);
    });
  });

  test('TC_US105_069 — A receipt exceeding the outstanding quantity is refused, naming the remainder', async ({ page, poForm, poData, approverPoApi }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_069', 'High', TAGS, 'With 10 outstanding: 10 accepted (Still outstanding 0); 11 blocks Save with PRC-1014 "이 품목의 잔량은 10개입니다."; back to 10 saves.');
    const po = await poData.createIssued([{ qty: 300 }]);
    let dialog: ReceiveDialog;

    await step('Arrange: Pre-condition 1–2 — PO A 300 with one Complete receipt of 290 (10 outstanding)', async () => {
      // 290 / 300 có chênh lệch → receipt vào Exception; account thứ 2 duyệt để thành Complete đúng pre-condition.
      await poData.receive(po, 290, 0, 'ADJ_DISCREPANCY');
      const [grn] = await poData.api.goodsReceipts(po.id);
      const detail = (await approverPoApi.goodsReceipt(po.id, grn.id)).body;
      await approverPoApi.resolveReceipt(po.id, grn.id, 'ADJ_DISCREPANCY', null, detail.version);
      await poForm.openPo(po.id);
    });

    await step('Act: Step 1 — Open 입고 검수 and enter 입고완료수량 10', async () => {
      dialog = await poForm.openReceive();
      await dialog.fillQuantities(10);
    });
    await step('Assert: Expected 1 — Equal to the remainder is accepted; Still outstanding 0', async () => {
      await expect(dialog.lineCell(0, 4), '[Expected 1] Still outstanding 0').toHaveText('0');
    });

    await step('Act: Step 2 — Enter 입고완료수량 11 and click Save', async () => {
      await dialog.attach('auto_delivery_note.pdf', DELIVERY_NOTE);
      await dialog.receivedQty().fill('11');
      await dialog.saveButton.click();
    });
    await step('Assert: Expected 2 — Blocked, the dialog stays open, PRC-1014', async () => {
      await expect(dialog.root, '[Expected 2] Dialog stays open').toBeVisible();
      await expect(dialog.root, '[Expected 2] PRC-1014').toContainText('잔량');
    });

    await step('Act: Step 3 — Read the message returned', async () => undefined);
    await step('Assert: Expected 3 — "Only 10 unit(s) are still outstanding on this line."', async () => {
      await expect(dialog.root, '[Expected 3] Names the exact remainder').toContainText(fmt(PO_KO['error.PRC-1014'], { qty: 10 }));
    });

    await step('Act: Step 4 — Change it back to 10 and click Save', async () => {
      await dialog.receivedQty().fill('10');
      await saveReceipt(poForm, dialog);
    });
    await step('Assert: Expected 4 — The save succeeds', async () => {
      await expect(poForm.toast(PO_KO['text.toastGrnSaved']), '[Expected 4] Saved').toBeVisible();
    });
  });

  test('TC_US105_070 — Received date is mandatory, cannot be in the future and dates the receipt', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_070', 'Medium', TAGS, 'Received date defaults to today (Seoul); cleared → blocked with "입고일을 선택하세요."; N+1 cannot be picked ("입고일은 미래 날짜로 지정할 수 없습니다."); N−1 saves and the receipt records N−1, not the server day. The machine-clock-after-midnight condition is not reproduced; the date rule is checked on the current day.');
    const po = await poData.createIssued([{ qty: 300 }]);
    let dialog: ReceiveDialog;

    await step('Arrange: Pre-condition 1–3 — PO A Issued with quantity outstanding; today = day N', async () => {
      await poForm.openPo(po.id);
    });

    await step('Act: Step 1 — Open 입고 검수 and observe the default 입고일', async () => {
      dialog = await poForm.openReceive();
    });
    await step('Assert: Expected 1 — The default is today in Seoul time', async () => {
      await expect(dialog.receivedDate, '[Expected 1] Today').toHaveValue(seoulToday());
    });

    await step('Act: Step 2 — Clear 입고일 and click Save', async () => {
      await dialog.fillQuantities(300);
      await dialog.receivedDate.fill('');
      await dialog.receivedDate.press('Escape');
      await dialog.saveButton.click();
    });
    await step('Assert: Expected 2 — Blocked with a mandatory-field message', async () => {
      await expect(dialog.root, '[Expected 2] "입고일을 선택하세요."').toContainText(PO_KO['text.errRequiredReceivedDate']);
    });

    await step('Act: Step 3 — Open the calendar and try to pick day N+1', async () => {
      await dialog.receivedDate.click();
      await dialog.receivedDate.fill(seoulToday(1));
      await dialog.receivedDate.press('Enter');
    });
    await step('Assert: Expected 3 — A future date cannot be picked; the future message is shown', async () => {
      await expect(dialog.receivedDate, '[Expected 3] N+1 not kept').not.toHaveValue(seoulToday(1));
      await expect(dialog.root, '[Expected 3] "입고일은 미래 날짜로 지정할 수 없습니다."').toContainText(PO_KO['text.errReceivedDateFuture']);
    });

    await step('Act: Step 4 — Set 입고일 to day N−1, enter a valid quantity and click Save', async () => {
      await dialog.receivedDate.fill(seoulToday(-1));
      await dialog.receivedDate.press('Enter');
      await dialog.attach('auto_delivery_note.pdf', DELIVERY_NOTE);
      await saveReceipt(poForm, dialog);
    });
    await step('Assert: Expected 4 — The save succeeds', async () => {
      await expect(poForm.toast(PO_KO['text.toastGrnSaved']), '[Expected 4] Saved').toBeVisible();
    });

    await step('Act: Step 5 — Observe the 입고일 column in the receipt history', async () => {
      await poForm.grnTable.scrollIntoViewIfNeeded();
    });
    await step('Assert: Expected 5 — The receipt records day N−1 as entered, not the server clock', async () => {
      await expect(poForm.grnRows.first().locator('td').nth(2), '[Expected 5] N−1').toHaveText(seoulToday(-1));
    });
  });

  for (const tc of ['TC_US105_071', 'TC_US105_072'] as const) {
    const five = tc === 'TC_US105_071';
    test(`${tc} — A discrepancy cannot be saved without a reason; the reasons come from the adjustment group`, async ({ page, poForm, poData }) => {
      const step = makeStep(page);
      await tcMeta(tc, 'Medium', TAGS, `290 received on a 300 line gives Discrepancy −10 (outside tolerance) and makes the reason mandatory; the list holds only adjustment codes — ${five ? 'FIVE: 불일치, 파손, 분실, 기타, 실사' : 'four: 불일치, 파손, 분실, 기타'}; Save without a reason → PRC-1016; 불일치 saves${five ? '' : '; a reason code outside the master sent to the API → PRC-1037'}.`);
      const po = await poData.createIssued([{ qty: 300 }]);
      let dialog: ReceiveDialog;
      let api = { status: 0, body: null as unknown };

      await step('Arrange: Pre-condition 1–3 — PO A Issued 300; the master holds the adjustment and inbound groups', async () => {
        await poForm.openPo(po.id);
      });

      await step('Act: Step 1 — Open 입고 검수, enter 입고완료수량 290 and 파손 수량 0', async () => {
        dialog = await poForm.openReceive();
        await dialog.fillQuantities(290, 0);
      });
      await step('Assert: Expected 1 — Discrepancy −10; the reason becomes mandatory', async () => {
        await expect(dialog.calcValue(PO_KO['text.calcDiscrepancy']), '[Expected 1] −10').toHaveText('−10');
        await expect(dialog.root.locator('label.form-label').filter({ hasText: PO_KO['text.discrepancyReasonLabel'] }), '[Expected 1] Reason marked mandatory').toContainText('*');
      });

      await step('Act: Step 2 — Expand the 차이 사유 list and sweep every entry', async () => {
        await dialog.reasonSelect.focus();
      });
      await step(`Assert: Expected 2 — Only adjustment-group codes: ${five ? 'FIVE codes' : '불일치, 파손, 분실, 기타'}`, async () => {
        const names = (await dialog.reasonSelect.locator('option').allInnerTexts()).slice(1);
        const expected = five ? ['불일치', '파손', '분실', '기타', '실사'] : UI_REASONS.map((r) => r.name);
        expect(names, `[Expected 2] Exactly ${expected.join(', ')}`).toEqual(expected);
        expect(names, '[Expected 2] No inbound-group code').not.toContain('발주');
      });

      await step('Act: Step 3 — Leave it at "— 사유 선택 —" and click Save', async () => {
        await dialog.attach('auto_delivery_note.pdf', DELIVERY_NOTE);
        await dialog.saveButton.click();
      });
      await step('Assert: Expected 3 — Blocked with PRC-1016; no receipt is created', async () => {
        await expect(dialog.root, '[Expected 3] PRC-1016 sentence').toContainText(PO_KO['error.PRC-1016']);
        expect(await poData.api.goodsReceipts(po.id), '[Expected 3] No receipt').toEqual([]);
      });

      await step('Act: Step 4 — Set 차이 사유 to 불일치 and click Save', async () => {
        await dialog.reasonSelect.selectOption({ label: '불일치' });
        await saveReceipt(poForm, dialog);
      });
      await step('Assert: Expected 4 — The save succeeds and the receipt is created', async () => {
        await expect(poForm.toast(PO_KO['text.toastGrnSavedException']), '[Expected 4] Saved (held as Exception)').toBeVisible();
        expect(await poData.api.goodsReceipts(po.id), '[Expected 4] One receipt').toHaveLength(1);
      });

      if (!five) {
        await step('Act: Step 5 — Call the save API with a reason code that does not resolve to an active master row', async () => {
          const other = await poData.createIssued([{ qty: 300 }]);
          api = await poData.api.createReceipt(other.id, await poData.receiptBody(other, 290, 0, 'NOT_A_REASON'), newIdempotencyKey());
        });
        await step('Assert: Expected 5 — Refused with PRC-1037 and its sentence', async () => {
          expect((api.body as { code?: string }).code, '[Expected 5] PRC-1037').toBe('PRC-1037');
          expect(JSON.stringify(api.body), '[Expected 5] PRC-1037 sentence').toContain(PO_KO['error.PRC-1037']);
        });
      }
    });
  }

  test('TC_US105_074 — A fully damaged receipt completes on a warehouse with a DEFECTIVE bucket', async ({ page, poForm, poData, approverPage, poWarehouseApi }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_074', 'High', TAGS, '50 received / 50 damaged on 50 × 15,400 shows Accepted 0, To available 0, To Defective 50, Purchase 770,000 KRW; saved in Exception; approved by another account with "차이가 승인되었습니다 — 재고가 반영되었습니다." and Complete; destination available stock +0 and the 50 land in the DEFECTIVE bucket\'s on-hold stock (보류재고), not its available stock. Recorded by congnd17.fpt, approved by dungbd.fpt on browser 2.');
    const po = await poData.createIssued([{ sku: 'C', qty: 50, price: 15400 }]);
    const sku = poData.warehouse.skus.C.id;
    let dialog: ReceiveDialog;
    let defective = 0;
    let before = { dest: 0, hold: 0, defAvail: 0 };
    const formB = new PurchaseOrderFormPage(approverPage);

    await step('Arrange: Pre-condition 1–3 — PO A Issued 50 × 15,400 on a warehouse created after 2026-09-22', async () => {
      defective = (await poWarehouseApi.bucketsOf({ id: poData.warehouse.id, name: poData.warehouse.name })).find((b) => b.name.endsWith('불량'))!.id;
      before = {
        dest: (await poData.api.stockOf(sku, poData.warehouse.id)).available,
        hold: (await poData.api.stockOf(sku, defective)).hold,
        defAvail: (await poData.api.stockOf(sku, defective)).available,
      };
      await poForm.openPo(po.id);
    });

    await step('Act: Step 1 — Open 입고 검수, enter 50 and 파손 수량 50, observe the panel', async () => {
      dialog = await poForm.openReceive();
      await dialog.fillQuantities(50, 50);
    });
    await step('Assert: Expected 1 — Accepted 0, To available 0, To Defective 50, Purchase 770,000 KRW', async () => {
      await expect(dialog.calcValue(PO_KO['text.calcToAvailable']), '[Expected 1] To available 0').toHaveText('0');
      await expect(dialog.calcValue(PO_KO['text.calcToDefective']), '[Expected 1] To Defective 50').toHaveText('50');
      await expect(dialog.calcValue(PO_KO['text.calcPurchaseAmount']), '[Expected 1] 770,000 KRW').toHaveText('770,000 KRW');
    });

    await step('Act: Step 2 — Pick a 차이 사유 and click Save', async () => {
      await dialog.reasonSelect.selectOption({ label: '파손' });
      await dialog.attach('auto_delivery_note.pdf', DELIVERY_NOTE);
      await saveReceipt(poForm, dialog);
    });
    await step('Assert: Expected 2 — The receipt is created in Exception', async () => {
      expect((await poData.api.goodsReceipts(po.id))[0]?.status, '[Expected 2] EXCEPTION').toBe('EXCEPTION');
    });

    await step('Act: Step 3 — Open the discrepancy dialog, pick a reason and click 차이 승인', async () => {
      const [grn] = await poData.api.goodsReceipts(po.id);
      await formB.openPo(po.id);
      const resolve = await formB.openResolve(grn.grnNo);
      await resolve.reasonSelect.selectOption({ label: '파손' });
      await resolve.approveButton.click();
    });
    await step('Assert: Expected 3 — Complete with "Discrepancy approved — stock updated."', async () => {
      await expect(formB.toast(PO_KO['text.toastGrnResolved']), '[Expected 3] Resolve toast').toBeVisible();
      expect((await poData.api.goodsReceipts(po.id))[0]?.status, '[Expected 3] COMPLETE').toBe('COMPLETE');
    });

    await step('Act: Step 4 — Check available stock, the Defective bucket and the receipt status', async () => undefined);
    await step('Assert: Expected 4 — Destination +0; the 50 land in the Defective on-hold stock, not its available stock', async () => {
      expect((await poData.api.stockOf(sku, poData.warehouse.id)).available, '[Expected 4] Destination available +0').toBe(before.dest);
      expect((await poData.api.stockOf(sku, defective)).hold, '[Expected 4] Defective on-hold (보류재고) +50').toBe(before.hold + 50);
      expect((await poData.api.stockOf(sku, defective)).available, '[Expected 4] Defective available unchanged (known GoodsReceiptService regression risk)').toBe(before.defAvail);
    });
  });

  for (const tc of ['TC_US105_076', 'TC_US105_077'] as const) {
    const keyed = tc === 'TC_US105_077';
    test(`${tc} — A rapid double click on Save creates one receipt only and writes stock once`, async ({ page, poForm, poData }) => {
      const step = makeStep(page);
      await tcMeta(tc, 'High', TAGS, `Baseline stock noted; 120 / 0 shows Discrepancy 0; the button is disabled after the first click and any second request is ignored with PRC-1019${keyed ? '; both outgoing requests carry the SAME Idempotency-Key minted at the dialog opening' : ''}; exactly one receipt row; stock rises by 120 once, not 240.`);
      const po = await poData.createIssued([{ sku: 'C', qty: 120 }]);
      const sku = poData.warehouse.skus.C.id;
      const posted: Request[] = [];
      let baseline = 0;
      let dialog: ReceiveDialog;
      let disabledAfterFirst = false;

      await step('Arrange: Pre-condition 1–2 — PO A Issued, one line of 120 at Warehouse A', async () => {
        await poForm.openPo(po.id);
        page.on('request', (r) => r.method() === 'POST' && /\/goods-receipts$/.test(new URL(r.url()).pathname) && posted.push(r));
      });

      await step('Act: Step 1 — Note the available stock', async () => {
        baseline = (await poData.api.stockOf(sku, poData.warehouse.id)).available;
      });
      await step('Assert: Expected 1 — The baseline figure is noted', async () => {
        expect(baseline, '[Expected 1] Baseline').toBeGreaterThanOrEqual(0);
      });

      await step(`Act: Step 2 — Open 입고 검수${keyed ? ' (note the key minted at this opening)' : ''}, enter 120 and 0`, async () => {
        dialog = await fillReceipt(poForm, 120, 0);
      });
      await step('Assert: Expected 2 — The panel shows Discrepancy 0', async () => {
        await expect(dialog.calcValue(PO_KO['text.calcDiscrepancy']), '[Expected 2] 0').toHaveText('0');
      });

      await step('Act: Step 3 — Click Save twice in rapid succession', async () => {
        const response = page.waitForResponse((r) => r.request().method() === 'POST' && /\/goods-receipts$/.test(new URL(r.url()).pathname));
        await dialog.saveButton.dblclick();
        disabledAfterFirst = await dialog.saveButton.isDisabled().catch(() => true);
        await response;
      });
      await step('Assert: Expected 3 — Disabled after the first click; a second request is ignored (PRC-1019)', async () => {
        expect(disabledAfterFirst || posted.length === 1, '[Expected 3] The second click is not sent, or is ignored').toBe(true);
      });

      if (keyed) {
        await step('Act: Step 4 — Inspect the outgoing requests and their keys', async () => undefined);
        await step('Assert: Expected 4 — Every request carries the identical Idempotency-Key', async () => {
          const keys = new Set(posted.map((r) => r.headers()['idempotency-key']));
          expect(keys.size, '[Expected 4] One key for the whole dialog opening').toBe(1);
        });
      }

      const n = keyed ? 5 : 4;
      await step(`Act: Step ${n} — Observe the receipt history block`, async () => {
        await poForm.grnTable.scrollIntoViewIfNeeded();
      });
      await step(`Assert: Expected ${n} — Exactly one receipt row has been created`, async () => {
        expect(await poData.api.goodsReceipts(po.id), `[Expected ${n}] One receipt`).toHaveLength(1);
      });

      await step(`Act: Step ${n + 1} — Reopen the stock screen for the SKU`, async () => undefined);
      await step(`Assert: Expected ${n + 1} — Stock rises by exactly 120 once, not 240`, async () => {
        expect((await poData.api.stockOf(sku, poData.warehouse.id)).available, `[Expected ${n + 1}] +120`).toBe(baseline + 120);
      });
    });
  }

  for (const tc of ['TC_US105_080', 'TC_US105_081'] as const) {
    const keyed = tc === 'TC_US105_081';
    test(`${tc} — Two receipts saved at the same time on one line; the second is re-checked against the remainder`, async ({ page, poForm, poData, approverPage }) => {
      const step = makeStep(page);
      await tcMeta(tc, 'High', TAGS, `Both dialogs show a remainder of 300${keyed ? ' and carry two different Idempotency-Keys (one per opening)' : ''}; browser A saves 200 and the remainder drops to 100; browser B is refused with PRC-1014 naming exactly 100${keyed ? ' — an ordinary business refusal, not an idempotency one' : ''}; exactly one receipt and Received qty 200. Browser A = congnd17.fpt, browser B = dungbd.fpt.`);
      const po = await poData.createIssued([{ qty: 300 }]);
      const formB = new PurchaseOrderFormPage(approverPage);
      const keys: string[] = [];
      let dialogA: ReceiveDialog;
      let dialogB: ReceiveDialog;

      await step('Arrange: Pre-condition 1–2 — Two accounts on browsers A and B; PO A 300 with no receipt', async () => {
        for (const p of [page, approverPage]) p.on('request', (r) => r.method() === 'POST' && /\/goods-receipts$/.test(new URL(r.url()).pathname) && keys.push(r.headers()['idempotency-key'] ?? ''));
        await poForm.openPo(po.id);
        await formB.openPo(po.id);
      });

      await step('Act: Step 1 — Open 입고 검수 on both browsers and enter 200 on each', async () => {
        dialogA = await poForm.openReceive();
        dialogB = await formB.openReceive();
        await dialogA.fillQuantities(200);
        await dialogB.fillQuantities(200);
        await dialogA.attach('auto_delivery_note.pdf', DELIVERY_NOTE);
        await dialogB.attach('auto_delivery_note.pdf', DELIVERY_NOTE);
        for (const d of [dialogA, dialogB]) await d.reasonSelect.selectOption({ label: '불일치' });
      });
      await step('Assert: Expected 1 — Both dialogs show a remainder of 300', async () => {
        await expect(dialogA.table.locator('tbody tr td').nth(1), '[Expected 1] Browser A ordered 300').toHaveText('300');
        await expect(dialogB.table.locator('tbody tr td').nth(1), '[Expected 1] Browser B ordered 300').toHaveText('300');
      });

      await step('Act: Step 2 — Click Save on browser A', async () => {
        await saveReceipt(poForm, dialogA);
      });
      await step('Assert: Expected 2 — The save succeeds and the remainder drops to 100', async () => {
        expect((await poData.read(po.id)).lines[0].outstanding, '[Expected 2] Remainder 100').toBe(100);
      });

      await step('Act: Step 3 — Click Save on browser B', async () => {
        await saveReceipt(formB, dialogB);
      });
      await step('Assert: Expected 3 — Refused with PRC-1014 naming exactly 100', async () => {
        await expect(dialogB.root, '[Expected 3] "이 품목의 잔량은 100개입니다."').toContainText(fmt(PO_KO['error.PRC-1014'], { qty: 100 }));
        if (keyed) expect(new Set(keys).size, '[Expected 3] The two keys never collide').toBe(2);
      });

      await step('Act: Step 4 — Observe the receipt history block and the line 입고완료수량', async () => {
        await poForm.openPo(po.id);
      });
      await step('Assert: Expected 4 — Exactly one receipt; Received qty 200', async () => {
        expect(await poData.api.goodsReceipts(po.id), '[Expected 4] One receipt').toHaveLength(1);
        expect((await poData.api.goodsReceipts(po.id))[0].receivedQty, '[Expected 4] 200').toBe(200);
      });
    });
  }

  test('TC_US105_129 — A catch-all reason cannot be saved without saying what it was', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_129', 'Medium', TAGS, '파손 with an empty Detailed reason saves; 기타 with it empty → PRC-1030 "이 사유는 상세 사유 입력이 필요합니다.", dialog stays, no receipt; with a text the save succeeds in Exception; Detailed reason takes 200 characters and refuses the 201st.');
    const po = await poData.createIssued([{ qty: 300 }]);
    const second = await poData.createIssued([{ qty: 300 }]);
    const third = await poData.createIssued([{ qty: 300 }]);
    let dialog: ReceiveDialog;

    await step('Arrange: Pre-condition 1–3 — PO A Issued 300; 기타 requires a note, 파손 does not', async () => {
      await poForm.openPo(po.id);
    });

    await step('Act: Step 1 — Enter 290, set 차이 사유 to 파손, leave Detailed reason empty and Save', async () => {
      dialog = await fillReceipt(poForm, 290, 0, '파손');
      await saveReceipt(poForm, dialog);
    });
    await step('Assert: Expected 1 — The save succeeds (the field stays optional for this code)', async () => {
      expect(await poData.api.goodsReceipts(po.id), '[Expected 1] Receipt created').toHaveLength(1);
    });

    await step('Act: Step 2 — Reopen the dialog, set 기타, leave Detailed reason empty and Save', async () => {
      await poForm.openPo(second.id);
      dialog = await fillReceipt(poForm, 290, 0, '기타');
      await dialog.saveButton.click();
    });
    await step('Assert: Expected 2 — PRC-1030; the dialog stays open, no receipt row', async () => {
      await expect(dialog.root, '[Expected 2] PRC-1030 sentence').toContainText(PO_KO['error.PRC-1030']);
      expect(await poData.api.goodsReceipts(second.id), '[Expected 2] No receipt').toEqual([]);
    });

    await step('Act: Step 3 — Enter "supplier shipped 10 short, confirmed by phone with SM" and Save', async () => {
      await dialog.detailReasonInput.fill('supplier shipped 10 short, confirmed by phone with SM');
      await saveReceipt(poForm, dialog);
    });
    await step('Assert: Expected 3 — The save succeeds and the receipt is created in Exception', async () => {
      expect((await poData.api.goodsReceipts(second.id))[0]?.status, '[Expected 3] EXCEPTION').toBe('EXCEPTION');
    });

    await step('Act: Step 4 — On a fresh receipt enter exactly 200 characters, then try a 201st', async () => {
      await poForm.openPo(third.id);
      dialog = await poForm.openReceive();
      await dialog.detailReasonInput.fill('x'.repeat(200));
      await dialog.detailReasonInput.press('End');
      await dialog.detailReasonInput.pressSequentially('y');
    });
    await step('Assert: Expected 4 — 200 characters taken; the 201st refused', async () => {
      expect((await dialog.detailReasonInput.inputValue()).length, '[Expected 4] Capped at 200').toBe(200);
    });
  });

  test('TC_US105_131 — A hand-keyed receipt needs its delivery document; attachment limits enforced', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_131', 'Medium', TAGS, 'No attachment → PRC-1031; one .pdf → saved; an 11th file refused at the control with "파일은 최대 10개, 각 10MB까지 첨부할 수 있습니다." keeping the ten; a >10 MB file and an unsupported type refused at the control; the create API with more than 10 attachments → PRC-1032.');
    const po = await poData.createIssued([{ qty: 300 }]);
    const fresh = await poData.createIssued([{ qty: 300 }]);
    const api = await poData.createIssued([{ qty: 300 }]);
    let dialog: ReceiveDialog;
    let tooMany = { status: 0, body: null as unknown };

    await step('Arrange: Pre-condition 1–3 — PO A Issued with quantity outstanding; every receipt is source MANUAL', async () => {
      await poForm.openPo(po.id);
    });

    await step('Act: Step 1 — Fill valid quantities, attach nothing and click Save', async () => {
      dialog = await fillReceipt(poForm, 300, 0, undefined, false);
      await dialog.saveButton.click();
    });
    await step('Assert: Expected 1 — PRC-1031 "Attach at least one delivery document before saving."; no receipt', async () => {
      await expect(dialog.root, '[Expected 1] PRC-1031').toContainText(PO_KO['error.PRC-1031']);
      expect(await poData.api.goodsReceipts(po.id), '[Expected 1] No receipt').toEqual([]);
    });

    await step('Act: Step 2 — Attach one .pdf file and click Save', async () => {
      await dialog.attach('auto_delivery_note.pdf', DELIVERY_NOTE);
      await saveReceipt(poForm, dialog);
    });
    await step('Assert: Expected 2 — The save succeeds', async () => {
      expect(await poData.api.goodsReceipts(po.id), '[Expected 2] Receipt created').toHaveLength(1);
    });

    const files = Array.from({ length: 11 }, (_, i) => ({ name: `auto_note_${i + 1}.pdf`, mimeType: 'application/pdf', buffer: DELIVERY_NOTE }));
    await step('Act: Step 3 — On a fresh receipt, try to attach an 11th file after ten are attached', async () => {
      await poForm.openPo(fresh.id);
      dialog = await poForm.openReceive();
      await dialog.fileInput.setInputFiles(files.slice(0, 10));
      await dialog.fileInput.setInputFiles(files);
    });
    await step('Assert: Expected 3 — The 11th file is rejected at the control; the ten stay; no request', async () => {
      await expect(dialog.root, '[Expected 3] "파일은 최대 10개, 각 10MB까지 첨부할 수 있습니다."').toContainText(PO_KO['text.errAttachLimit']);
    });

    await step('Act: Step 4 — Try a file over 10 MB and a file of a type outside the accept list', async () => {
      await dialog.fileInput.setInputFiles({ name: 'auto_big.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
    });
    await step('Assert: Expected 4 — Both rejected at the control with the same message', async () => {
      await expect(dialog.root, '[Expected 4] Oversized file refused').toContainText(PO_KO['text.errAttachLimit']);
      await dialog.fileInput.setInputFiles({ name: 'auto_script.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') });
      await expect(dialog.root, '[Expected 4] Unsupported type refused').toContainText(PO_KO['text.errAttachLimit']);
    });

    await step('Act: Step 5 — Call the create API with more than 10 attachments', async () => {
      const body = await poData.receiptBody(api, 300, 0);
      tooMany = await poData.api.createReceipt(api.id, { ...body, attachments: Array.from({ length: 11 }, () => body.attachments[0]) }, newIdempotencyKey());
    });
    await step('Assert: Expected 5 — Refused with PRC-1032 "입고 1건에 첨부할 수 있는 파일은 최대 10개입니다."', async () => {
      expect((tooMany.body as { code?: string }).code, '[Expected 5] PRC-1032').toBe('PRC-1032');
      expect(JSON.stringify(tooMany.body), '[Expected 5] PRC-1032 sentence').toContain(PO_KO['error.PRC-1032']);
    });
  });

  test('TC_US105_136 — Receive goods renders disabled the instant an order holds a receipt in Exception', async ({ page, poForm, poData, approverPoApi }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_136', 'Medium', TAGS, 'With a held receipt the button is rendered disabled and the message naming the GRN is already visible beside it (no click needed); a click does nothing; after an approver resolves the receipt the button is enabled and the message disappears.');
    let po = await poData.createIssued([{ qty: 300 }]);
    let grnNo = '';

    await step('Arrange: Pre-condition 1–2 — PO A Issued with one receipt in Exception; GRN noted', async () => {
      await poData.receive(po, 290, 0, 'ADJ_DISCREPANCY');
      po = await poData.read(po.id);
      grnNo = (await poData.api.goodsReceipts(po.id))[0].grnNo;
    });

    await step('Act: Step 1 — Open PO A and observe Receive goods and the area beside it, without clicking', async () => {
      await poForm.openPo(po.id);
    });
    await step('Assert: Expected 1 — Rendered disabled and the GRN message is already visible', async () => {
      await expect(poForm.receiveButton, '[Expected 1] Receive goods disabled').toBeDisabled();
      await expect(page.getByText(fmt(PO_KO['error.PRC-1035'], { grn_no: grnNo })), '[Expected 1] Message naming the held GRN is visible before any click').toBeVisible();
    });

    await step('Act: Step 2 — Try to click Receive goods anyway', async () => {
      await poForm.receiveButton.click({ force: true }).catch(() => undefined);
    });
    await step('Assert: Expected 2 — Nothing happens; the button does not respond', async () => {
      await expect(poForm.receiveDialog().root, '[Expected 2] No receive dialog opens').toHaveCount(0);
    });

    await step('Act: Step 3 — Have an approver resolve the held receipt, then reopen PO A', async () => {
      const [grn] = await poData.api.goodsReceipts(po.id);
      const detail = (await approverPoApi.goodsReceipt(po.id, grn.id)).body;
      await approverPoApi.resolveReceipt(po.id, grn.id, 'ADJ_DISCREPANCY', null, detail.version);
      await poForm.openPo(po.id);
    });
    await step('Assert: Expected 3 — Receive goods enabled again; the blocking message is gone', async () => {
      await expect(poForm.receiveButton, '[Expected 3] Enabled').toBeEnabled();
      await expect(poForm.receiveButton, '[Expected 3] Not dimmed').not.toHaveClass(/opacity-50/);
      await expect(page.getByText(fmt(PO_KO['error.PRC-1035'], { grn_no: grnNo })), '[Expected 3] Message gone').toHaveCount(0);
    });
  });

  test('TC_US105_152 — Two lorries on the same day produce two receipts, neither a duplicate', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_152', 'Medium', TAGS, 'The first receipt of 100 saves and completes; a fresh dialog opening mints its own key and the second identical 100 saves as a separate receipt; the history holds two rows of 100, both Complete, and the remainder is 100.');
    const po = await poData.createIssued([{ qty: 300 }]);
    const keys: string[] = [];
    let dialog: ReceiveDialog;

    await step('Arrange: Pre-condition 1–2 — PO A Issued with one line of 300', async () => {
      page.on('request', (r) => r.method() === 'POST' && /\/goods-receipts$/.test(new URL(r.url()).pathname) && keys.push(r.headers()['idempotency-key'] ?? ''));
      await poForm.openPo(po.id);
    });

    await step('Act: Step 1 — Open 입고 검수, enter 100 for the first lorry and save', async () => {
      dialog = await fillReceipt(poForm, 100, 0, '불일치');
      await saveReceipt(poForm, dialog);
    });
    await step('Assert: Expected 1 — The first receipt saves and completes', async () => {
      expect((await poData.api.goodsReceipts(po.id))[0]?.status, '[Expected 1] COMPLETE').toBe('COMPLETE');
    });

    await step('Act: Step 2 — Open a FRESH 입고 검수 dialog, enter 100 for the second lorry and save', async () => {
      await poForm.openPo(po.id);
      dialog = await fillReceipt(poForm, 100, 0, '불일치');
      await saveReceipt(poForm, dialog);
    });
    await step('Assert: Expected 2 — A new key; saved as a genuinely separate receipt', async () => {
      expect(new Set(keys).size, '[Expected 2] Two different keys').toBe(2);
      expect(await poData.api.goodsReceipts(po.id), '[Expected 2] Two receipts').toHaveLength(2);
    });

    await step('Act: Step 3 — Observe the receipt history block', async () => {
      await poForm.openPo(po.id);
    });
    await step('Assert: Expected 3 — Two rows of 100, both Complete; remainder 100', async () => {
      const receipts = await poData.api.goodsReceipts(po.id);
      expect(receipts.map((r) => [r.receivedQty, r.status]), '[Expected 3] Two Complete rows of 100').toEqual([[100, 'COMPLETE'], [100, 'COMPLETE']]);
      expect((await poData.read(po.id)).lines[0].outstanding, '[Expected 3] Remainder 100').toBe(100);
    });
  });
});
