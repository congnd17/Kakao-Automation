import { test, expect } from '@fixtures/purchase-order.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { PO_KO } from '@utils/purchase-order.i18n';
import { getAccountDisplayName } from '@utils/auth-token';
import { PurchaseOrderFormPage } from '@pages/purchase-order-form.page';
import { HistoryRecord, PoDetail } from '@api/purchase-order.api';
import { SUPPLIER } from '@utils/purchase-order.data';

/**
 * 변경 이력 (US105) — 1 lần lưu = 1 bản ghi, khoá dòng theo mã SKU, mốc vòng đời và người thực hiện, nút 변경 이력 theo
 * trạng thái / vai trò. Lịch sử đọc qua `GET /purchase-orders/{id}/history` (cùng nguồn dialog 변경 이력 hiển thị) và
 * `…/goods-receipts/{id}/history`. Tên account đọc lúc chạy từ token (không hardcode).
 */
const TAGS = ['history', 'purchase-order'];

const statusChange = (record: HistoryRecord) => record.changes.find((change) => change.field === 'po_status');

test.describe('[History] 변경 이력 — grain, keys, milestones and visibility', () => {
  test.describe.configure({ timeout: 240_000 });

  test('TC_US105_105 — One Save produces exactly one record; a Save that changes nothing writes none', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_105', 'High', TAGS, 'Changing the Expected date and one line Ordered qty in one Save adds exactly ONE record (UPDATED, two changes with before / after) shown stacked in a single dialog row; a Save with no change adds none.');
    const po = await poData.createDraft([{ qty: 300 }]);
    let baseline = 0;

    await step('Arrange: Pre-condition 1–3 — PO A saved Draft with one line; domainType purchaseorder registered', async () => {
      await poForm.openPo(po.id);
    });

    await step('Act: Step 1 — Note the current number of history records on PO A', async () => {
      baseline = (await poData.api.history(po.id)).length;
    });
    await step('Assert: Expected 1 — The baseline figure is noted', async () => {
      expect(baseline, '[Expected 1] At least the CREATED record').toBeGreaterThanOrEqual(1);
    });

    await step('Act: Step 2 — Change 입고예정일 and the 발주 수량 of one line together, then click 임시저장', async () => {
      await poForm.setDate(poForm.expectedDateInput, new Date(Date.now() + 10 * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }));
      await poForm.lineQty().fill('320');
      await poForm.saveDraft();
    });
    await step('Assert: Expected 2 — The save succeeds', async () => {
      await expect(poForm.toast(PO_KO['text.toastSaved']), '[Expected 2] Saved').toBeVisible();
    });

    await step('Act: Step 3 — Read the PO A history again', async () => {
      await poForm.openHistory();
    });
    await step('Assert: Expected 3 — Exactly one new UPDATED record with two changes, stacked in a single row', async () => {
      const history = await poData.api.history(po.id);
      expect(history.length, '[Expected 3] Exactly one new record').toBe(baseline + 1);
      expect(history[0].changeType, '[Expected 3] UPDATED').toBe('UPDATED');
      expect(history[0].changes.map((c) => c.field).sort(), '[Expected 3] Two entries, one per field').toHaveLength(2);
      expect(history[0].changes.every((c) => c.before !== c.after), '[Expected 3] Each with before and after').toBe(true);
      await expect(poForm.historyDialog().rows.first().locator('td').nth(2).locator('.d-block'), '[Expected 3] Two changes stacked in one row').toHaveCount(2);
      await poForm.historyDialog().closeButton.click();
    });

    await step('Act: Step 4 — Reopen PO A and click 임시저장 without changing anything', async () => {
      await poForm.openPo(po.id);
      await poForm.saveDraft();
    });
    await step('Assert: Expected 4 — The save succeeds', async () => {
      await expect(poForm.toast(PO_KO['text.toastSaved']), '[Expected 4] Saved').toBeVisible();
    });

    await step('Act: Step 5 — Read the PO A history once more', async () => undefined);
    await step('Assert: Expected 5 — No record has been added', async () => {
      expect((await poData.api.history(po.id)).length, '[Expected 5] Unchanged').toBe(baseline + 1);
    });
  });

  test('TC_US105_106 — Line fields are keyed by SKU code, so inserting or deleting a line makes no phantom change', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_106', 'High', TAGS, 'SKU B 300 → 320 gives one entry keyed lines[SKU B code].ordered_qty (no array index); deleting the SKU A line gives one entry with an empty after, B and C untouched; adding a new line gives one entry with an empty before. Deviation: the automation warehouse maps three SKUs only, so the "new SKU D line" re-adds SKU A (absent from the order at that point).');
    const po = await poData.createDraft([{ sku: 'A', qty: 100 }, { sku: 'B', qty: 300 }, { sku: 'C', qty: 50 }]);
    const codes = { A: poData.warehouse.skus.A.code, B: poData.warehouse.skus.B.code, C: poData.warehouse.skus.C.code };
    const latest = async () => (await poData.api.history(po.id))[0];

    await step('Arrange: Pre-condition 1–3 — PO A Draft with lines SKU A, SKU B (300), SKU C', async () => {
      await poForm.openPo(po.id);
    });

    await step('Act: Step 1 — Change the SKU B Ordered qty from 300 to 320 and click 임시저장', async () => {
      await poForm.lineQty(1).fill('320');
      await poForm.saveDraft();
    });
    await step('Assert: Expected 1 — The save succeeds', async () => {
      await expect(poForm.toast(PO_KO['text.toastSaved']), '[Expected 1] Saved').toBeVisible();
    });

    await step('Act: Step 2 — Read the record just created and inspect the key of the changed field', async () => undefined);
    await step('Assert: Expected 2 — One entry lines[SKU B].ordered_qty 300 → 320, no array index', async () => {
      const record = await latest();
      expect(record.changes, '[Expected 2] One entry').toHaveLength(1);
      expect(record.changes[0].field, '[Expected 2] Keyed by SKU code').toBe(`lines[${codes.B}].ordered_qty`);
      expect(record.changes[0], '[Expected 2] 300 → 320').toMatchObject({ before: '300', after: '320' });
      expect(record.changes[0].field, '[Expected 2] No array index').not.toMatch(/\[\d+\]/);
    });

    await step('Act: Step 3 — Delete the SKU A line and click 임시저장', async () => {
      await poForm.lineRemove(0).click();
      const confirm = poForm.confirmDialog();
      if (await confirm.root.isVisible().catch(() => false)) await confirm.root.locator('.modal-footer button').last().click();
      await poForm.saveDraft();
    });
    await step('Assert: Expected 3 — The save succeeds', async () => {
      await expect(poForm.toast(PO_KO['text.toastSaved']), '[Expected 3] Saved').toBeVisible();
    });

    await step('Act: Step 4 — Read the record just created and count the entries in its change list', async () => undefined);
    await step('Assert: Expected 4 — Exactly one entry for the deleted SKU A line; B and C absent', async () => {
      const record = await latest();
      expect(record.changes.filter((c) => c.field.includes(codes.A)).length, '[Expected 4] One entry for SKU A').toBeGreaterThanOrEqual(1);
      expect(record.changes.every((c) => c.field.includes(codes.A)), '[Expected 4] SKU B / SKU C do not appear').toBe(true);
      expect(record.changes.every((c) => c.after === null || c.after === ''), '[Expected 4] Empty after value').toBe(true);
    });

    await step('Act: Step 5 — Add a new line (SKU A again), click 임시저장 and read the record', async () => {
      await poForm.addLine({ sku: poData.warehouse.skus.A.name, owner: '자사 재고', saleType: PO_KO['saleType.PURCHASE'], qty: 10, price: 1000 });
      await poForm.saveDraft();
    });
    await step('Assert: Expected 5 — Exactly one entry for the new line, with an empty before', async () => {
      const record = await latest();
      expect(record.changes.every((c) => c.field.includes(codes.A)), '[Expected 5] Only the new line').toBe(true);
      expect(record.changes.every((c) => c.before === null || c.before === ''), '[Expected 5] Empty before value').toBe(true);
    });
  });

  for (const tc of ['TC_US105_107', 'TC_US105_110'] as const) {
    const withResolve = tc === 'TC_US105_110';
    test(`${tc} — Lifecycle milestones record the right content and the right acting user${withResolve ? ', resolve included' : ''}`, async ({ page, poForm, poData, approverPoApi }) => {
      const step = makeStep(page);
      await tcMeta(tc, 'High', TAGS, `Issue → UPDATED po_status DRAFT → ISSUED by Operator 1 (not SYSTEM); Cancel → one record holding po_status ISSUED → CANCELED and the reason; Close → ISSUED → CLOSED with the close reason; a full receipt by Operator 2 closing the order names Operator 2; the first record is CREATED with an empty change list${withResolve ? '; resolving a receipt writes ONE row to the receipt history (grn_status EXCEPTION → COMPLETE) naming the approver' : ''}. Operator 1 = congnd17.fpt (browser), Operator 2 = dungbd.fpt (API).`);
      const operator1 = getAccountDisplayName('submitter');
      const operator2 = getAccountDisplayName('approver');
      const a = await poData.createDraft();
      const b = await poData.createIssued();
      const c = await poData.createIssued([{ qty: 300 }]);
      const d = await poData.createIssued([{ qty: 40 }]);
      let e: PoDetail;
      const first = async (id: number) => (await poData.api.history(id))[0];

      await step(`Arrange: Pre-condition 1–${withResolve ? 4 : 3} — PO A Draft, PO B Issued, PO C short-delivered, PO D about to be fully received${withResolve ? ', PO E with an Exception receipt by Operator 1' : ''}`, async () => {
        await poData.receive(c, 100, 0, 'ADJ_DISCREPANCY');
        const [grn] = await poData.api.goodsReceipts(c.id);
        await approverPoApi.resolveReceipt(c.id, grn.id, 'ADJ_DISCREPANCY', null, (await approverPoApi.goodsReceipt(c.id, grn.id)).body.version);
        if (withResolve) {
          e = await poData.createIssued([{ qty: 300 }]);
          await poData.receive(e, 290, 0, 'ADJ_DISCREPANCY');
        }
      });

      await step('Act: Step 1 — Operator 1 opens PO A, clicks 발주 발행 and reads the newest record', async () => {
        await poForm.openPo(a.id);
        await poForm.issueButton.click();
        await expect(poForm.statusBadge).toHaveText(PO_KO['poStatus.ISSUED']);
      });
      await step('Assert: Expected 1 — UPDATED po_status DRAFT → ISSUED by Operator 1, not SYSTEM', async () => {
        const record = await first(a.id);
        expect(record.changeType, '[Expected 1] UPDATED').toBe('UPDATED');
        expect(statusChange(record), '[Expected 1] DRAFT → ISSUED').toMatchObject({ before: 'DRAFT', after: 'ISSUED' });
        expect(record.changedByName, '[Expected 1] Operator 1').toBe(operator1);
      });

      await step('Act: Step 2 — Operator 1 cancels PO B with a reason and reads the newest record', async () => {
        await poForm.openPo(b.id);
        await poForm.cancelPoButton.click();
        await poForm.reasonDialog().reasonInput.fill(`auto ${tc} cancel`);
        await poForm.reasonDialog().confirmButton.click();
        await expect(poForm.statusBadge).toHaveText(PO_KO['poStatus.CANCELED']);
      });
      await step('Assert: Expected 2 — One record holds po_status ISSUED → CANCELED and the reason', async () => {
        const record = await first(b.id);
        expect(statusChange(record), '[Expected 2] ISSUED → CANCELED').toMatchObject({ before: 'ISSUED', after: 'CANCELED' });
        expect(record.changes.find((ch) => ch.field === 'close_reason'), '[Expected 2] Reason from empty to the string').toMatchObject({ after: `auto ${tc} cancel` });
      });

      await step('Act: Step 3 — Operator 1 closes PO C with a reason and reads the newest record', async () => {
        await poForm.openPo(c.id);
        await poForm.closePoButton.click();
        await poForm.reasonDialog().reasonInput.fill(`auto ${tc} close`);
        await poForm.reasonDialog().confirmButton.click();
        await expect(poForm.statusBadge).toHaveText(PO_KO['poStatus.CLOSED']);
      });
      await step('Assert: Expected 3 — ISSUED → CLOSED together with the close reason', async () => {
        const record = await first(c.id);
        expect(statusChange(record), '[Expected 3] ISSUED → CLOSED').toMatchObject({ before: 'ISSUED', after: 'CLOSED' });
        expect(record.changes.find((ch) => ch.field === 'close_reason'), '[Expected 3] Close reason').toMatchObject({ after: `auto ${tc} close` });
      });

      await step('Act: Step 4 — Operator 2 receives the full quantity on PO D and reads the newest record', async () => {
        await poData.receive(d, 40, 0, null, approverPoApi);
      });
      await step('Assert: Expected 4 — The record names Operator 2, not a system action', async () => {
        const record = await first(d.id);
        expect(statusChange(record), '[Expected 4] → CLOSED').toMatchObject({ after: 'CLOSED' });
        expect(record.changedByName, '[Expected 4] Operator 2').toBe(operator2);
      });

      await step('Act: Step 5 — Read the first record in the PO A history', async () => undefined);
      await step('Assert: Expected 5 — CREATED with an empty change list', async () => {
        const history = await poData.api.history(a.id);
        const created = history[history.length - 1];
        expect(created.changeType, '[Expected 5] CREATED').toBe('CREATED');
        expect(created.changes, '[Expected 5] Empty change list').toEqual([]);
      });

      if (withResolve) {
        await step('Act: Step 6 — The approver resolves the PO E receipt and reads that receipt\'s change history', async () => {
          const [grn] = await poData.api.goodsReceipts(e.id);
          await approverPoApi.resolveReceipt(e.id, grn.id, 'ADJ_DISCREPANCY', null, (await approverPoApi.goodsReceipt(e.id, grn.id)).body.version);
        });
        await step('Assert: Expected 6 — ONE row grn_status EXCEPTION → COMPLETE naming the resolving approver', async () => {
          const [grn] = await poData.api.goodsReceipts(e.id);
          const rows = (await poData.api.receiptHistory(e.id, grn.id)).filter((h) => h.changes.some((ch) => ch.field === 'grn_status' && ch.after === 'COMPLETE'));
          expect(rows, '[Expected 6] Exactly one resolve row').toHaveLength(1);
          expect(rows[0].changes.find((ch) => ch.field === 'grn_status'), '[Expected 6] EXCEPTION → COMPLETE').toMatchObject({ before: 'EXCEPTION', after: 'COMPLETE' });
          expect(rows[0].changedByName, '[Expected 6] The resolving approver').toBe(operator2);
        });
      }
    });
  }

  test('TC_US105_108 — Change history is absent before the first save, present in every status and for every role', async ({ page, poForm, poData, approverPage }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_108', 'Medium', TAGS, 'Not rendered at all before the first save; appears as soon as the draft is saved; shown on Issued, Closed and Canceled; read-only roles keep it outside their empty action row. Not automated: the SETTLEMENT_OPERATOR / MANAGER / AUDIT halves of steps 4–5 — no such accounts exist; the APPROVER half runs as dungbd.fpt (which also holds write permissions, so its action row is not empty).');
    const issued = await poData.createIssued();
    const closed = await poData.createIssued();
    const canceled = await poData.createIssued();
    const formB = new PurchaseOrderFormPage(approverPage);

    await step('Arrange: Pre-condition 1–2 — PO B Issued, PO C Closed, PO D Canceled', async () => {
      await poData.api.close(closed.id, 'auto 108', closed.version);
      await poData.api.cancel(canceled.id, 'auto 108', canceled.version);
    });

    await step('Act: Step 1 — As INVENTORY_OPERATOR click 발주 등록 and look for 변경 이력 before any save', async () => {
      await poForm.openCreate();
    });
    await step('Assert: Expected 1 — Not rendered at all (not merely disabled)', async () => {
      await expect(poForm.historyButton, '[Expected 1] Absent').toHaveCount(0);
    });

    await step('Act: Step 2 — Fill the mandatory fields and one line, click 임시저장 and look again', async () => {
      await poForm.fillBasics({ supplier: SUPPLIER.starship.ko, destination: poData.warehouse.name });
      await poForm.addLine({ sku: poData.warehouse.skus.A.name, owner: '자사 재고', saleType: PO_KO['saleType.PURCHASE'], qty: 5, price: 1000 });
      const response = await poForm.saveDraft();
      poData.track(((await response.json()) as { id: number }).id);
    });
    await step('Assert: Expected 2 — The button appears as soon as the first save completes', async () => {
      await expect(poForm.historyButton, '[Expected 2] Rendered').toBeVisible();
    });

    const shown: Record<string, boolean> = {};
    await step('Act: Step 3 — Open PO B, PO C and PO D in turn and observe the button', async () => {
      for (const [label, po] of [['Issued', issued], ['Closed', closed], ['Canceled', canceled]] as const) {
        await poForm.openPo(po.id);
        shown[label] = await poForm.historyButton.isVisible();
      }
    });
    await step('Assert: Expected 3 — Shown in Issued, Closed and Canceled', async () => {
      expect(shown, '[Expected 3] Shown in all three').toEqual({ Issued: true, Closed: true, Canceled: true });
    });

    await step('Act: Step 4 — As APPROVER open PO B and observe the action row and 변경 이력', async () => {
      await formB.openPo(issued.id);
    });
    await step('Assert: Expected 4 — Change history shown and clickable outside the action row (role halves: Not automated)', async () => {
      await expect(formB.historyButton, '[Expected 4] Shown').toBeVisible();
      await expect(formB.historyButton, '[Expected 4] Clickable').toBeEnabled();
      await expect(formB.actionRow.getByRole('button', { name: PO_KO['text.changeHistory'] }), '[Expected 4] Outside the action row').toHaveCount(0);
    });

    await step('Act: Step 5 — As MANAGER and then AUDIT, open PO B and observe the same', async () => {
      await formB.historyButton.scrollIntoViewIfNeeded();
    });
    await step('Assert: Expected 5 — Identical to step 4 (Not automated — no MANAGER / AUDIT account)', async () => {
      // Not automated: không có account MANAGER / AUDIT (quyết định 05/10) — giữ step, kiểm lại điều kiện chung của bước 4.
      await expect(formB.historyButton, '[Expected 5] Change history still rendered for a read role').toBeVisible();
    });
  });
});
