import { test, expect } from '@fixtures/purchase-order.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { PO_KO } from '@utils/purchase-order.i18n';
import { WarehouseApi } from '@api/warehouse.api';
import { PurchaseOrderFormPage } from '@pages/purchase-order-form.page';
import { buildPoBody, createBaseWarehouse, SUPPLIER, toPoUpdateBody } from '@utils/purchase-order.data';
import { errorCode } from '@api/purchase-order.api';

/**
 * 발주 발행 (US105) — chuyển Draft → Issued, khoá điều khoản, số 입고예정 (incomingQuantity của /stock-status), các chặn
 * khi phát hành, lý do bắt buộc, xung đột phiên bản giữa 2 trình duyệt (browser B = account thứ 2 dungbd.fpt).
 * Mapping bị deactivate trong test được bật lại ở finally — kho automation dùng chung cho cả lần chạy.
 */
const TAGS = ['issue', 'purchase-order'];

async function mappingId(api: WarehouseApi, warehouseId: number, productId: number, owner: string): Promise<number> {
  const { body } = await api.mappingsOf(warehouseId);
  const mapping = body.items.find((m) => m.productId === productId && m.ownershipType === owner);
  if (!mapping) throw new Error(`Test data setup failed — no mapping ${productId}/${owner} on warehouse ${warehouseId}`);
  return mapping.id;
}

test.describe('[Issue] 발주 발행 — Draft → Issued, guards and reasons', () => {
  test.describe.configure({ timeout: 180_000 });

  test('TC_US105_054 — Issue PO moves Draft to Issued in one step, freezes the terms, creates the expected inbound', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_054', 'Critical', TAGS, 'Baseline expected inbound noted; the button reads 발주 발행 (no Submit, no approval queue); the status moves straight to Issued with "발주서가 발행되었습니다." and the form turns read-only; Supplier and Ordered qty cannot be edited; the expected inbound quantity of SKU A at Warehouse A rises by exactly 30.');
    const po = await poData.createDraft([{ sku: 'B', qty: 30 }]);
    const sku = poData.warehouse.skus.B.id;
    let baseline = 0;

    await step('Arrange: Pre-condition 1–2 — PO A Draft with one line of 30 on Warehouse A', async () => {
      await poForm.openPo(po.id);
    });

    await step('Act: Step 1 — Note the current expected inbound quantity on the stock screen', async () => {
      baseline = (await poData.api.stockOf(sku, poData.warehouse.id)).incoming;
    });

    await step('Assert: Expected 1 — The baseline figure is noted', async () => {
      expect(baseline, '[Expected 1] Baseline expected inbound is a number').toBeGreaterThanOrEqual(0);
    });

    await step('Act: Step 2 — Open PO A and observe the label on the issue button', async () => {
      await poForm.issueButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Labelled Issue PO, not Submit; no approval queue on the screen', async () => {
      await expect(poForm.issueButton, '[Expected 2] Label 발주 발행').toHaveText(PO_KO['text.issuePo']);
      await expect(page.getByRole('button', { name: /제출|Submit|승인 요청/ }), '[Expected 2] No Submit / approval button').toHaveCount(0);
    });

    await step('Act: Step 3 — Click 발주 발행 (Issue PO)', async () => {
      await poForm.issueButton.click();
    });

    await step('Assert: Expected 3 — Straight to Issued, toast "Purchase order issued.", the form turns read-only', async () => {
      await expect(poForm.toast(PO_KO['text.toastIssued']), '[Expected 3] Issue toast').toBeVisible();
      await expect(poForm.statusBadge, '[Expected 3] Status Issued').toHaveText(PO_KO['poStatus.ISSUED']);
      await expect(page, '[Expected 3] The screen stays on the form').toHaveURL(new RegExp(`/purchase-orders/${po.id}$`));
      const history = await poData.api.history(po.id);
      expect(history[0].changes.find((c) => c.field === 'po_status'), '[Expected 3] DRAFT → ISSUED with no intermediate status').toMatchObject({ before: 'DRAFT', after: 'ISSUED' });
    });

    await step('Act: Step 4 — Try to edit 공급처 and the line 발주 수량', async () => {
      await poForm.header.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — No field can be edited', async () => {
      await expect(poForm.supplierSelect.locator('xpath=self::select'), '[Expected 4] Supplier is not an editable select').toHaveCount(0);
      await expect(poForm.lineQty(), '[Expected 4] Ordered qty is not an editable input').toHaveCount(0);
    });

    await step('Act: Step 5 — Reopen the stock screen for SKU A at Warehouse A', async () => undefined);

    await step('Assert: Expected 5 — The expected inbound quantity rises by exactly 30, at once', async () => {
      expect((await poData.api.stockOf(sku, poData.warehouse.id)).incoming, '[Expected 5] Expected inbound +30').toBe(baseline + 30);
    });
  });

  test('TC_US105_055 — Issue PO is blocked when the PO has no line', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_055', 'Medium', TAGS, 'An empty line table shows "품목을 추가하여 발주서를 생성합니다."; 발주 발행 is rendered disabled; a click sends no request and shows no error; the PO stays 작성 중.');
    const po = await poData.createDraft([]);
    const issues: string[] = [];

    await step('Arrange: Pre-condition 1–2 — PO A saved Draft with a Supplier and destination but no line', async () => {
      page.on('request', (r) => r.url().endsWith(`/purchase-orders/${po.id}/issue`) && issues.push(r.url()));
    });

    await step('Act: Step 1 — Open PO A and observe the line table', async () => {
      await poForm.openPo(po.id);
    });

    await step('Assert: Expected 1 — The line table is empty with its message', async () => {
      await expect(poForm.emptyLines, '[Expected 1] "품목을 추가하여 발주서를 생성합니다."').toBeVisible();
    });

    await step('Act: Step 2 — Observe the 발주 발행 button in the action row', async () => {
      await poForm.issueButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Issue PO is rendered disabled', async () => {
      await expect(poForm.issueButton, '[Expected 2] Rendered').toBeVisible();
      await expect(poForm.issueButton, '[Expected 2] Disabled while the order has zero lines').toBeDisabled();
    });

    await step('Act: Step 3 — Try to click the Issue PO button', async () => {
      await poForm.issueButton.click({ force: true }).catch(() => undefined);
    });

    await step('Assert: Expected 3 — Nothing happens: no request and no error message', async () => {
      expect(issues, '[Expected 3] No issue request').toEqual([]);
      await expect(poForm.pageAlert, '[Expected 3] No error message').toHaveCount(0);
    });

    await step('Act: Step 4 — Observe the PO status badge', async () => undefined);

    await step('Assert: Expected 4 — The PO is still 작성 중 (Draft)', async () => {
      await expect(poForm.statusBadge, '[Expected 4] Draft').toHaveText(PO_KO['poStatus.DRAFT']);
    });
  });

  test('TC_US105_056 — Issue PO is blocked when a line mapping is deactivated after the line was added', async ({ page, poForm, poData, poWarehouseApi }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_056', 'High', TAGS, 'The line renders normally; once the SKU / warehouse / 자사 mapping is deactivated, Issue PO is blocked with PRC-1007 naming the combination and the PO stays Draft. SKU C is used so the shared SKU A / B mappings stay active; the mapping is reactivated afterwards.');
    const po = await poData.createDraft([{ sku: 'C' }]);
    const id = await mappingId(poWarehouseApi, poData.warehouse.id, poData.warehouse.skus.C.id, 'OWN');

    try {
      await step('Arrange: Pre-condition 1–2 — PO A Draft with SKU C / 자사, mapping active when the line was added', async () => {
        await poForm.openPo(po.id);
      });

      await step('Act: Step 1 — Open PO A and confirm the line is normal', async () => {
        await poForm.line().scrollIntoViewIfNeeded();
      });

      await step('Assert: Expected 1 — The line renders normally with no warning', async () => {
        await expect(poForm.line().locator('.text-danger'), '[Expected 1] No warning').toHaveCount(0);
      });

      await step('Act: Step 2 — Have an administrator deactivate the SKU / Warehouse / 자사 mapping', async () => {
        await poWarehouseApi.deactivateMapping(id);
      });

      await step('Assert: Expected 2 — The mapping becomes inactive', async () => {
        const { body } = await poWarehouseApi.mappingsOf(poData.warehouse.id);
        expect(body.items.find((m) => m.id === id)?.status, '[Expected 2] INACTIVE').toBe('INACTIVE');
      });

      await step('Act: Step 3 — Return to the original tab and click 발주 발행', async () => {
        await poForm.issueButton.click();
      });

      await step('Assert: Expected 3 — Blocked with PRC-1007, PO stays Draft, the message names the combination', async () => {
        await expect(page.locator('body'), '[Expected 3] PRC-1007 message naming the warehouse').toContainText(poData.warehouse.name);
        await expect(page.locator('body'), '[Expected 3] PRC-1007 pattern').toContainText('상품-창고 매핑에 먼저 등록해 주세요');
        expect((await poData.read(po.id)).status, '[Expected 3] Still Draft').toBe('DRAFT');
      });
    } finally {
      await poWarehouseApi.reactivateMapping(id);
    }
  });

  test('TC_US105_057 — Issue PO is blocked when the stored destination is no longer eligible', async ({ page, poForm, poData, poWarehouseApi }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_057', 'Medium', TAGS, 'A Draft PO on a valid warehouse renders normally; once that warehouse becomes a SUPPLIER (or virtual) warehouse, Issue PO is blocked with PRC-1008 "이 입고지는 더 이상 사용할 수 없습니다…" and the PO stays Draft. Runs on a dedicated automation warehouse so the shared one keeps its type.');
    let own = { id: 0 };
    let poId = 0;
    let typeChange = 0;

    await step('Arrange: Pre-condition 1–2 — PO A Draft on Warehouse A (valid) with one valid line', async () => {
      const warehouse = await createBaseWarehouse(poWarehouseApi, poData.api, 'TC057');
      own = warehouse;
      poId = (await poData.api.create(buildPoBody(warehouse, 1))).body.id;
      poData.track(poId);
      await poForm.openPo(poId);
    });

    await step('Act: Step 1 — Open PO A', async () => {
      await poForm.header.waitFor();
    });

    await step('Assert: Expected 1 — The PO renders normally in Draft', async () => {
      await expect(poForm.statusBadge, '[Expected 1] Draft').toHaveText(PO_KO['poStatus.DRAFT']);
    });

    await step('Act: Step 2 — Have an administrator change Warehouse A to type SUPPLIER', async () => {
      const detail = (await poWarehouseApi.get(own.id)).body;
      typeChange = (await poWarehouseApi.update(own.id, WarehouseApi.toUpdateBody(detail, { type: 'SUPPLIER', logisticsType: null, logisticsChannelType: null }))).status;
    });

    await step('Assert: Expected 2 — Warehouse A no longer meets the Inbound destination conditions', async () => {
      expect(typeChange, '[Expected 2] The warehouse type change is accepted (Warehouse A becomes SUPPLIER)').toBeLessThan(300);
    });

    await step('Act: Step 3 — Return to the original tab and click 발주 발행', async () => {
      await poForm.issueButton.click();
    });

    await step('Assert: Expected 3 — Blocked with PRC-1008 and its sentence; the PO stays Draft', async () => {
      await expect(page.locator('body'), '[Expected 3] PRC-1008 sentence').toContainText(PO_KO['error.PRC-1008']);
      expect((await poData.read(poId)).status, '[Expected 3] Still Draft').toBe('DRAFT');
    });
  });

  test('TC_US105_058 — An empty or whitespace-only reason is refused from both callers; cancel writes nothing', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_058', 'Medium', TAGS, 'Cancel PO with an empty reason → dialog stays, field highlighted, PRC-1006 "사유를 입력해야 진행할 수 있습니다."; three spaces refused the same way; the dialog cancel button writes nothing; Close PO with an empty reason refused the same way; the PO stays Issued.');
    const po = await poData.createIssued();
    const reason = poForm.reasonDialog();

    await step('Arrange: Pre-condition 1–2 — PO A Issued with no receipt', async () => {
      await poForm.openPo(po.id);
    });

    await step('Act: Step 1 — Click 발주 취소, leave the reason empty and confirm', async () => {
      await poForm.cancelPoButton.click();
      await reason.waitOpen();
      await reason.confirmButton.click();
    });

    await step('Assert: Expected 1 — Dialog stays open, field highlighted, PRC-1006; status unchanged', async () => {
      await expect(reason.root, '[Expected 1] Dialog stays open').toBeVisible();
      await expect(reason.reasonInput, '[Expected 1] Reason field highlighted').toHaveClass(/is-invalid/);
      await expect(reason.root, '[Expected 1] "사유를 입력해야 진행할 수 있습니다."').toContainText(PO_KO['error.PRC-1006']);
      expect((await poData.read(po.id)).status, '[Expected 1] Still Issued').toBe('ISSUED');
    });

    await step('Act: Step 2 — Enter three spaces and confirm', async () => {
      await reason.reasonInput.fill('   ');
      await reason.confirmButton.click();
    });

    await step('Assert: Expected 2 — Refused identically (whitespace counts as empty)', async () => {
      await expect(reason.root, '[Expected 2] Dialog stays open').toBeVisible();
      await expect(reason.root, '[Expected 2] Same message').toContainText(PO_KO['error.PRC-1006']);
    });

    await step('Act: Step 3 — Click the cancel button on the dialog and observe the PO status', async () => {
      await reason.cancelButton.click();
    });

    await step('Assert: Expected 3 — The dialog closes, the PO is still Issued, nothing written', async () => {
      await expect(reason.root, '[Expected 3] Dialog closed').toBeHidden();
      await expect(poForm.statusBadge, '[Expected 3] Still Issued').toHaveText(PO_KO['poStatus.ISSUED']);
      expect((await poData.read(po.id)).version, '[Expected 3] Nothing written').toBe(po.version);
    });

    await step('Act: Step 4 — Click 발주 종결, leave the reason empty and confirm', async () => {
      await poForm.closePoButton.click();
      await reason.waitOpen();
      await reason.confirmButton.click();
    });

    await step('Assert: Expected 4 — Refused under the same code and message; still Issued', async () => {
      await expect(reason.root, '[Expected 4] Same message').toContainText(PO_KO['error.PRC-1006']);
      expect((await poData.read(po.id)).status, '[Expected 4] Still Issued').toBe('ISSUED');
    });
  });

  test('TC_US105_059 — A PO in Draft does not raise the expected inbound quantity', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_059', 'High', TAGS, 'Saving a Draft PO with a 500-unit line leaves the expected inbound of SKU A at Warehouse A unchanged; issuing it raises the figure by exactly 500. SKU B is used to keep the figure isolated from other tests of the run.');
    const sku = poData.warehouse.skus.B;
    let baseline = 0;
    let id = 0;

    await step('Arrange: Pre-condition 1–2 — Warehouse A and SKU A with a registered mapping', async () => {
      await poForm.openCreate();
    });

    await step('Act: Step 1 — Note the current expected inbound quantity', async () => {
      baseline = (await poData.api.stockOf(sku.id, poData.warehouse.id)).incoming;
    });

    await step('Assert: Expected 1 — The baseline figure is noted', async () => {
      expect(baseline, '[Expected 1] Baseline noted').toBeGreaterThanOrEqual(0);
    });

    await step('Act: Step 2 — Create PO A in Draft with a 500-unit line, save and reopen the stock screen', async () => {
      await poForm.fillBasics({ supplier: SUPPLIER.starship.ko, destination: poData.warehouse.name });
      await poForm.addLine({ sku: sku.name, owner: '자사 재고', saleType: PO_KO['saleType.PURCHASE'], qty: 500, price: 1000 });
      const response = await poForm.saveDraft();
      id = ((await response.json()) as { id: number }).id;
      poData.track(id);
    });

    await step('Assert: Expected 2 — The expected inbound quantity is unchanged', async () => {
      expect((await poData.api.stockOf(sku.id, poData.warehouse.id)).incoming, '[Expected 2] Unchanged while Draft').toBe(baseline);
    });

    await step('Act: Step 3 — Return to PO A, click 발주 발행 and reopen the stock screen', async () => {
      await poForm.issueButton.click();
      await expect(poForm.statusBadge).toHaveText(PO_KO['poStatus.ISSUED']);
    });

    await step('Assert: Expected 3 — The expected inbound quantity rises by exactly 500', async () => {
      expect((await poData.api.stockOf(sku.id, poData.warehouse.id)).incoming, '[Expected 3] +500').toBe(baseline + 500);
    });
  });

  test('TC_US105_060 — Every commercial and line field turns read-only from Issued and renders as plain text', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_060', 'High', TAGS, 'Issued badge; Supplier type / Supplier / Inbound destination / Currency cannot be edited and still show their value; Supplier renders as plain text, not a locked input; SKU / Owner / Sale type / Ordered qty / Unit price on the line cannot be edited.');
    const po = await poData.createIssued();
    const form = poForm as PurchaseOrderFormPage;

    await step('Arrange: Pre-condition 1–2 — PO A Issued with one complete line', async () => {
      await form.openPo(po.id);
    });

    await step('Act: Step 1 — Open PO A', async () => {
      await form.header.waitFor();
    });

    await step('Assert: Expected 1 — Read-only form with an Issued badge', async () => {
      await expect(form.statusBadge, '[Expected 1] Issued').toHaveText(PO_KO['poStatus.ISSUED']);
    });

    await step('Act: Step 2 — Try to edit 공급처 유형, Supplier, 입고지 and 통화 in turn', async () => {
      await form.supplierTypeSelect.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — None of the four can be edited and every value is still displayed', async () => {
      for (const [label, value] of [
        [PO_KO['text.supplierTypeLabel'], PO_KO['supplierType.BIZ_PARTNER']],
        [PO_KO['text.supplierLabel'], SUPPLIER.starship.ko],
        [PO_KO['text.destinationLabel'], poData.warehouse.name],
        [PO_KO['text.currencyLabel'], 'KRW'],
      ] as const) {
        const field = form.field(label);
        await expect(field.locator('xpath=self::select | self::input[not(@readonly)]'), `[Expected 2] ${label} is not editable`).toHaveCount(0);
        await expect(field, `[Expected 2] ${label} still shows ${value}`).toContainText(value);
      }
    });

    await step('Act: Step 3 — Observe how the Supplier field is rendered', async () => {
      await form.supplierSelect.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Supplier renders as plain text, not a locked input', async () => {
      await expect(form.supplierSelect.locator('xpath=self::input | self::select'), '[Expected 3] Not an input / select').toHaveCount(0);
      await expect(form.supplierSelect, '[Expected 3] Plain text value').toHaveText(SUPPLIER.starship.ko);
    });

    await step('Act: Step 4 — Try to edit SKU, Owner, Sale type, Ordered qty and Unit price on the line', async () => {
      await form.line().scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — None of the five line fields can be edited', async () => {
      await expect(form.line().locator('select, input'), '[Expected 4] No editable control on the line').toHaveCount(0);
    });
  });

  test('TC_US105_062 — An action on stale data is refused as a conflict and the screen reloads', async ({ page, poForm, poData, approverPage }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_062', 'High', TAGS, 'Both browsers show Issued; browser A closes with a reason; browser B (still showing Issued) cancels and is refused with PRC-1018 "이 발주서는 화면을 연 이후 변경되었습니다…"; browser B reloads and shows Closed with the stored reason. Browser A = congnd17.fpt, browser B = dungbd.fpt.');
    const po = await poData.createIssued();
    const formB = new PurchaseOrderFormPage(approverPage);

    await step('Arrange: Pre-condition 1–2 — Two accounts on browsers A and B; PO A Issued with no receipt', async () => {
      await poForm.openPo(po.id);
      await formB.openPo(po.id);
    });

    await step('Act: Step 1 — Open PO A on both browsers', async () => {
      await formB.statusBadge.waitFor();
    });

    await step('Assert: Expected 1 — Both browsers show the PO in Issued', async () => {
      await expect(poForm.statusBadge, '[Expected 1] Browser A Issued').toHaveText(PO_KO['poStatus.ISSUED']);
      await expect(formB.statusBadge, '[Expected 1] Browser B Issued').toHaveText(PO_KO['poStatus.ISSUED']);
    });

    await step('Act: Step 2 — On browser A click 발주 종결, enter a reason and confirm', async () => {
      await poForm.closePoButton.click();
      const reason = poForm.reasonDialog();
      await reason.reasonInput.fill('auto 062 close');
      await reason.confirmButton.click();
    });

    await step('Assert: Expected 2 — The close succeeds and the PO moves to Closed', async () => {
      await expect(poForm.statusBadge, '[Expected 2] Closed').toHaveText(PO_KO['poStatus.CLOSED']);
    });

    await step('Act: Step 3 — On browser B, still showing Issued, click 발주 취소 and confirm', async () => {
      await formB.cancelPoButton.click();
      const reason = formB.reasonDialog();
      await reason.reasonInput.fill('auto 062 cancel');
      await reason.confirmButton.click();
    });

    await step('Assert: Expected 3 — Refused as a conflict with PRC-1018 and its sentence', async () => {
      await expect(approverPage.locator('body'), '[Expected 3] PRC-1018 sentence').toContainText(PO_KO['error.PRC-1018']);
    });

    await step('Act: Step 4 — Observe the browser B screen after the refusal', async () => {
      await formB.statusBadge.waitFor();
    });

    await step('Assert: Expected 4 — Browser B reloads to Closed with the stored reason; nothing overwritten', async () => {
      await expect(formB.statusBadge, '[Expected 4] Browser B shows Closed').toHaveText(PO_KO['poStatus.CLOSED']);
      await expect(approverPage.getByText('auto 062 close'), '[Expected 4] The stored close reason is shown').toBeVisible();
      const after = await poData.read(po.id);
      expect(after.status, '[Expected 4] Closed, not overwritten').toBe('CLOSED');
    });
  });

  test('TC_US105_148 — Issue PO carries a version; a stale issue is refused as a conflict', async ({ page, poForm, poData, approverPage }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_148', 'Medium', TAGS, 'Both browsers show the same Draft; browser A edits and issues; browser B (pre-edit version) issues and is refused with PRC-1018 (not PRC-1002) and reloads to Issued; an issue call omitting the version on an edited Draft is refused with PRC-1018 too.');
    const po = await poData.createDraft();
    const formB = new PurchaseOrderFormPage(approverPage);
    let noVersion = { status: 0, body: null as unknown };

    await step('Arrange: Pre-condition 1–2 — Two accounts on browsers A and B; PO A Draft, edited at least once', async () => {
      await poData.api.update(po.id, toPoUpdateBody(po, { lines: [{ ...toPoUpdateBody(po).lines[0], orderedQty: 301 }] }));
      await poForm.openPo(po.id);
      await formB.openPo(po.id);
    });

    await step('Act: Step 1 — Open PO A on both browsers', async () => {
      await formB.statusBadge.waitFor();
    });

    await step('Assert: Expected 1 — Both browsers show the same starting state', async () => {
      await expect(poForm.lineQty(), '[Expected 1] Browser A qty').toHaveValue('301');
      await expect(formB.lineQty(), '[Expected 1] Browser B qty').toHaveValue('301');
    });

    await step('Act: Step 2 — On browser A save a small edit to the line, then click Issue PO', async () => {
      await poForm.lineQty().fill('302');
      await poForm.saveDraft();
      await poForm.issueButton.click();
    });

    await step('Assert: Expected 2 — Browser A edit and issue both succeed; PO A is Issued', async () => {
      await expect(poForm.statusBadge, '[Expected 2] Issued').toHaveText(PO_KO['poStatus.ISSUED']);
    });

    await step('Act: Step 3 — On browser B (pre-edit version) click Issue PO', async () => {
      await formB.issueButton.click();
    });

    await step('Assert: Expected 3 — Refused as a CONFLICT with PRC-1018, not PRC-1002; the page reloads to Issued', async () => {
      await expect(approverPage.locator('body'), '[Expected 3] PRC-1018 sentence').toContainText(PO_KO['error.PRC-1018']);
      await expect(approverPage.locator('body'), '[Expected 3] Not the status-transition sentence').not.toContainText(PO_KO['error.PRC-1002']);
      await expect(formB.statusBadge, '[Expected 3] Reloaded to Issued').toHaveText(PO_KO['poStatus.ISSUED']);
    });

    await step('Act: Step 4 — Call the issue API without the version on a fresh Draft edited at least once', async () => {
      const fresh = await poData.createDraft();
      await poData.api.update(fresh.id, toPoUpdateBody(fresh, { lines: [{ ...toPoUpdateBody(fresh).lines[0], orderedQty: 299 }] }));
      noVersion = await poData.api.issue(fresh.id);
    });

    await step('Assert: Expected 4 — Refused with PRC-1018 as well', async () => {
      expect(errorCode(noVersion.body), '[Expected 4] PRC-1018').toBe('PRC-1018');
    });
  });
});
