import { Page, Response } from '@playwright/test';
import { test, expect } from '@fixtures/purchase-order.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { PO_KO, fmt } from '@utils/purchase-order.i18n';
import { PoData, seoulToday, SUPPLIER } from '@utils/purchase-order.data';
import { PurchaseOrderFormPage } from '@pages/purchase-order-form.page';

/**
 * Form 발주 등록 (US105) — field, validate, tính tiền, lưu, xoá. PO tạo qua UI được đăng ký dọn theo id trả về ở response
 * của 임시저장 (`poData.track`) ngay khi lưu xong. Validate client chặn request → "không lưu" kiểm bằng việc không có
 * POST / PATCH nào gửi đi.
 */
const TAGS = ['create', 'purchase-order'];

/** Đếm request ghi PO (POST tạo / PATCH sửa) — chứng minh validate client chặn lưu. */
function watchPoWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/v1\/purchase-orders(\/\d+)?$/.test(new URL(request.url()).pathname) && ['POST', 'PATCH'].includes(request.method())) writes.push(`${request.method()} ${request.url()}`);
  });
  return writes;
}

/** Ghi nhận PO do UI tạo để dọn ở teardown; trả id. */
async function trackSaved(response: Response, poData: PoData): Promise<number> {
  const body = (await response.json().catch(() => ({}))) as { id?: number };
  const id = body.id ?? Number(new URL(response.url()).pathname.split('/').pop());
  if (Number.isFinite(id) && id > 0) poData.track(id);
  return id;
}

/** Điền form hợp lệ tối thiểu (공급처 스타쉽, kho automation, 1 dòng SKU A 자사 사입 300 × 39150). */
async function fillValidForm(form: PurchaseOrderFormPage, poData: PoData, line: { qty?: number; price?: number; owner?: string; saleType?: string } = {}): Promise<void> {
  await form.fillBasics({ supplier: SUPPLIER.starship.ko, destination: poData.warehouse.name });
  await form.addLine({ sku: poData.warehouse.skus.A.name, owner: line.owner ?? '자사 재고', saleType: line.saleType ?? PO_KO['saleType.PURCHASE'], qty: line.qty ?? 300, price: line.price ?? 39150 });
}

test.describe('[Create] 발주 등록 form — fields, validation, amounts, save and delete', () => {
  test.describe.configure({ timeout: 180_000 });

  test('TC_US105_030 — Creating a Draft PO succeeds and the PO number is issued on the first save', async ({ page, poList, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_030', 'Critical', TAGS, 'PO no. (자동 발번), Supplier type Biz partner, Order date today (Seoul), Currency KRW; Line amount and total 11,745,000; save toast "발주서가 저장되었습니다.", a real PO number, badge still Draft; the new PO is listed as Draft with the right supplier and amount; reopening shows every value entered, Sale type included.');
    let poNo = '';

    await step('Arrange: Pre-condition 1–2 — Supplier A active, Warehouse A eligible, SKU A mapped with Owner 자사', async () => {
      await poList.open();
    });

    await step('Act: Step 1 — Click 발주 등록 and observe PO no., 공급처 유형, 발주일 and 통화', async () => {
      await poList.createButton.click();
      await poForm.header.waitFor();
    });

    await step('Assert: Expected 1 — PO no. read-only (auto), Biz partner, today in Seoul, KRW', async () => {
      await expect(poForm.poNoInput, '[Expected 1] PO no. shows (자동 발번)').toHaveValue(PO_KO['text.poNoAuto']);
      await expect(poForm.poNoInput, '[Expected 1] PO no. is read-only').toHaveAttribute('readonly', '');
      await expect(poForm.supplierTypeSelect, '[Expected 1] Supplier type defaults to Biz partner').toHaveValue('BIZ_PARTNER');
      await expect(poForm.orderDateInput, '[Expected 1] Order date defaults to today in Seoul time').toHaveValue(seoulToday());
      await expect(poForm.currencySelect, '[Expected 1] Currency defaults to KRW').toHaveValue('KRW');
    });

    await step('Act: Step 2 — Leave 공급처 유형 at Biz partner, set Supplier A and Warehouse A', async () => {
      await poForm.fillBasics({ supplier: SUPPLIER.starship.ko, destination: poData.warehouse.name });
    });

    await step('Assert: Expected 2 — Both fields take the values selected', async () => {
      await expect(poForm.supplierSelect.locator('option:checked'), '[Expected 2] Supplier A selected').toHaveText(SUPPLIER.starship.ko);
      await expect(poForm.destinationSelect.locator('option:checked'), '[Expected 2] Warehouse A selected').toHaveText(poData.warehouse.name);
    });

    await step('Act: Step 3 — Add a line: SKU A, 자사 재고, 사입, 300 × 39150', async () => {
      await poForm.addLine({ sku: poData.warehouse.skus.A.name, owner: '자사 재고', saleType: PO_KO['saleType.PURCHASE'], qty: 300, price: 39150 });
    });

    await step('Assert: Expected 3 — Line amount 11,745,000 and the PO amount total 11,745,000', async () => {
      await expect(poForm.lineAmount(), '[Expected 3] Line amount 11,745,000').toHaveText(/11,745,000/);
      await expect(poForm.totalAmount, '[Expected 3] PO amount total 11,745,000').toHaveText('11,745,000');
    });

    let id = 0;
    await step('Act: Step 4 — Click 임시저장 (Save draft)', async () => {
      id = await trackSaved(await poForm.saveDraft(), poData);
    });

    await step('Assert: Expected 4 — Toast "Purchase order saved."; a real PO no.; badge still Draft', async () => {
      await expect(poForm.toast(PO_KO['text.toastSaved']), '[Expected 4] Save toast').toBeVisible();
      await expect(poForm.poNoInput, '[Expected 4] PO no. becomes a real system-issued number').toHaveValue(/^PO-\d{8}-\d{3}$/);
      poNo = await poForm.poNoInput.inputValue();
      await expect(poForm.statusBadge, '[Expected 4] Badge is still Draft').toHaveText(PO_KO['poStatus.DRAFT']);
    });

    await step('Act: Step 5 — Click 발주 목록으로 and find the PO just created', async () => {
      await poForm.backToListButton.click();
      await poList.searchBy(PO_KO['searchType.PO_NO'], poNo);
    });

    await step('Assert: Expected 5 — Listed with Status Draft, the right Supplier and PO amount 11,745,000', async () => {
      const row = poList.rowByPoNo(poNo);
      await expect(poList.cell(row, PO_KO['col.poList.status']), '[Expected 5] Status Draft').toHaveText(PO_KO['poStatus.DRAFT']);
      await expect(poList.cell(row, PO_KO['col.poList.supplier']), '[Expected 5] Supplier A').toContainText(SUPPLIER.starship.ko);
      await expect(poList.cell(row, PO_KO['col.poList.poAmount']), '[Expected 5] PO amount 11,745,000').toHaveText('11,745,000');
    });

    await step('Act: Step 6 — Click that PO number to reopen it', async () => {
      await poList.openPo(poNo);
      await poForm.lineTable.waitFor();
    });

    await step('Assert: Expected 6 — Every value entered at steps 2 and 3 is shown, Sale type included', async () => {
      expect(page.url(), '[Expected 6] The saved PO is reopened').toContain(String(id));
      await expect(poForm.supplierSelect.locator('option:checked'), '[Expected 6] Supplier').toHaveText(SUPPLIER.starship.ko);
      await expect(poForm.destinationSelect.locator('option:checked'), '[Expected 6] Inbound destination').toHaveText(poData.warehouse.name);
      await expect(poForm.lineSku().locator('option:checked'), '[Expected 6] SKU').toHaveText(poData.warehouse.skus.A.name);
      await expect(poForm.lineOwner().locator('option:checked'), '[Expected 6] Owner').toHaveText('자사 재고');
      await expect(poForm.lineSaleType().locator('option:checked'), '[Expected 6] Sale type').toHaveText(PO_KO['saleType.PURCHASE']);
      await expect(poForm.lineQty(), '[Expected 6] Ordered qty').toHaveValue('300');
      await expect(poForm.linePrice(), '[Expected 6] Unit price').toHaveValue('39,150');
    });
  });

  test('TC_US105_031 — The mandatory-field sweep over Supplier type, Supplier and Inbound destination', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_031', 'Medium', TAGS, 'No Supplier → blocked, field highlighted, "공급처를 선택하세요."; no destination → blocked, "입고지를 선택하세요."; Supplier type cleared → blocked; all three filled → saved with a PO no. Deviation risk: the Supplier type select has no empty option on dev, so step 3 cannot clear it.');
    const writes = watchPoWrites(page);

    await step('Arrange: Pre-condition 1–3 — An empty Create PO form; Supplier A and Warehouse A valid', async () => {
      await poForm.openCreate();
    });

    await step('Act: Step 1 — Leave Supplier unselected, set Warehouse A and click 임시저장', async () => {
      await poForm.fillBasics({ destination: poData.warehouse.name });
      await poForm.saveDraftButton.click();
    });

    await step('Assert: Expected 1 — Blocked, Supplier highlighted, "Please select a supplier."; no PO no.', async () => {
      await expect(poForm.supplierSelect, '[Expected 1] Supplier field highlighted').toHaveClass(/is-invalid/);
      await expect(page.getByText(PO_KO['text.errRequiredSupplier']), '[Expected 1] Message 공급처를 선택하세요.').toBeVisible();
      expect(writes, '[Expected 1] No save request is sent').toEqual([]);
      await expect(poForm.poNoInput, '[Expected 1] No PO no. issued').toHaveValue(PO_KO['text.poNoAuto']);
    });

    await step('Act: Step 2 — Set Supplier A, return 입고지 to the placeholder and click 임시저장', async () => {
      await poForm.fillBasics({ supplier: SUPPLIER.starship.ko });
      await poForm.destinationSelect.selectOption('');
      await poForm.saveDraftButton.click();
    });

    await step('Assert: Expected 2 — Blocked, Inbound destination highlighted, "Please select an inbound destination."', async () => {
      await expect(poForm.destinationSelect, '[Expected 2] Inbound destination highlighted').toHaveClass(/is-invalid/);
      await expect(page.getByText(PO_KO['text.errRequiredDestination']), '[Expected 2] Message 입고지를 선택하세요.').toBeVisible();
      expect(writes, '[Expected 2] No save request is sent').toEqual([]);
    });

    await step('Act: Step 3 — Clear 공급처 유형 and click 임시저장', async () => {
      await poForm.fillBasics({ destination: poData.warehouse.name });
      await poForm.supplierTypeSelect.selectOption('').catch(() => undefined);
      await poForm.saveDraftButton.click();
    });

    await step('Assert: Expected 3 — The save is blocked because Supplier type is mandatory', async () => {
      await expect(poForm.supplierTypeSelect, '[Expected 3] Supplier type can be cleared and is then flagged').toHaveValue('');
      expect(writes, '[Expected 3] No save request is sent').toEqual([]);
    });

    await step('Act: Step 4 — Fill all three fields and click 임시저장', async () => {
      await poForm.supplierTypeSelect.selectOption('BIZ_PARTNER');
      await trackSaved(await poForm.saveDraft(), poData);
    });

    await step('Assert: Expected 4 — The save succeeds and a PO no. is issued', async () => {
      await expect(poForm.toast(PO_KO['text.toastSaved']), '[Expected 4] Save toast').toBeVisible();
      await expect(poForm.poNoInput, '[Expected 4] A PO no. is issued').toHaveValue(/^PO-\d{8}-\d{3}$/);
    });
  });

  test('TC_US105_032 — Supplier type only classifies a supplier within one master and never clears Supplier', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_032', 'High', TAGS, 'The Supplier list holds trading partners and invoice-issuing manufacturers from one master; switching Supplier type to Manufacturer keeps Supplier A and the same list; saving with Supplier B succeeds.');
    let biz: string[] = [];

    await step('Arrange: Pre-condition 1–2 — One 거래처 master holding Supplier A (partner) and Supplier B (manufacturer issuing invoices)', async () => {
      await poForm.openCreate();
    });

    await step('Act: Step 1 — Leave Supplier type at Biz partner, expand the Supplier list and note every entry', async () => {
      biz = await poForm.optionLabels(poForm.supplierSelect);
    });

    await step('Assert: Expected 1 — The list holds partners and manufacturers from the same master', async () => {
      const partners = (await poData.api.bizPartners()).filter((p) => p.contractStatus === 'ACTIVE');
      expect(biz.length - 1, '[Expected 1] Every ACTIVE 거래처 is offered from the one master').toBe(partners.length);
    });

    await step('Act: Step 2 — Set Supplier to Supplier A', async () => {
      await poForm.supplierSelect.selectOption({ label: SUPPLIER.starship.ko });
    });

    await step('Assert: Expected 2 — The Supplier field takes the value', async () => {
      await expect(poForm.supplierSelect.locator('option:checked'), '[Expected 2] Supplier A selected').toHaveText(SUPPLIER.starship.ko);
    });

    await step('Act: Step 3 — Change 공급처 유형 to 제조사 and observe the Supplier field', async () => {
      await poForm.supplierTypeSelect.selectOption('MANUFACTURER');
    });

    await step('Assert: Expected 3 — Supplier A is still there and has not been cleared', async () => {
      await expect(poForm.supplierSelect.locator('option:checked'), '[Expected 3] Supplier A kept').toHaveText(SUPPLIER.starship.ko);
    });

    await step('Act: Step 4 — Expand the Supplier list again and compare it with step 1', async () => {
      await poForm.supplierSelect.focus();
    });

    await step('Assert: Expected 4 — The list is identical — neither reloaded nor sourced differently', async () => {
      expect(await poForm.optionLabels(poForm.supplierSelect), '[Expected 4] Same list as step 1').toEqual(biz);
    });

    await step('Act: Step 5 — Set Supplier to Supplier B and click 임시저장', async () => {
      await poForm.supplierSelect.selectOption({ label: SUPPLIER.antenna.ko });
      await poForm.supplierTypeSelect.selectOption('BIZ_PARTNER');
      await poForm.fillBasics({ destination: poData.warehouse.name });
      await trackSaved(await poForm.saveDraft(), poData);
    });

    await step('Assert: Expected 5 — The save succeeds', async () => {
      await expect(poForm.toast(PO_KO['text.toastSaved']), '[Expected 5] Save toast').toBeVisible();
      await expect(poForm.poNoInput, '[Expected 5] PO no. issued').toHaveValue(/^PO-/);
    });
  });

  test('TC_US105_034 — Order date cannot be in the future, Expected date cannot precede it, the cascade clears', async ({ page, poForm }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_034', 'Medium', TAGS, 'Day N+1 cannot be picked for Order date ("발주일은 미래 날짜로 지정할 수 없습니다."); today is accepted; Expected date N−1 cannot be picked ("입고 예정일은 발주일보다 이전일 수 없습니다."); equal to Order date accepted; moving Order date past it clears Expected date with "입고예정일을 다시 선택해 주세요."');
    const today = seoulToday();
    const dayCell = (iso: string) => {
      const day = Number(iso.slice(8));
      return page.locator('.react-datepicker__day:not(.react-datepicker__day--outside-month)').filter({ hasText: new RegExp(`^${day}$`) }).first();
    };

    await step('Arrange: Pre-condition 1–3 — An empty Create PO form; today in Seoul noted as day N', async () => {
      await poForm.openCreate();
    });

    await step('Act: Step 1 — Open the 발주일 calendar and try to pick day N+1', async () => {
      await poForm.orderDateInput.click();
      await poForm.orderDateInput.fill(seoulToday(1));
      await poForm.orderDateInput.press('Enter');
    });

    await step('Assert: Expected 1 — A future date cannot be picked; "The order date cannot be in the future."', async () => {
      await expect(poForm.orderDateInput, '[Expected 1] The future day is not kept').not.toHaveValue(seoulToday(1));
      await expect(page.getByText(PO_KO['text.errOrderDateFuture']), '[Expected 1] Future-date message').toBeVisible();
    });

    await step('Act: Step 2 — Set 발주일 to day N', async () => {
      await poForm.setDate(poForm.orderDateInput, today);
    });

    await step('Assert: Expected 2 — Today is accepted', async () => {
      await expect(poForm.orderDateInput, '[Expected 2] Day N is accepted').toHaveValue(today);
    });

    await step('Act: Step 3 — Open the 입고예정일 calendar and try to pick day N−1', async () => {
      await poForm.expectedDateInput.click();
    });

    await step('Assert: Expected 3 — A date before Order date cannot be picked; the not-earlier message is shown', async () => {
      await expect(dayCell(seoulToday(-1)), '[Expected 3] Day N−1 is disabled in the calendar').toHaveClass(/react-datepicker__day--disabled/);
      await poForm.expectedDateInput.fill(seoulToday(-1));
      await poForm.expectedDateInput.press('Enter');
      await expect(page.getByText(PO_KO['text.errExpectedBeforeOrder']), '[Expected 3] "입고 예정일은 발주일보다 이전일 수 없습니다."').toBeVisible();
    });

    await step('Act: Step 4 — Set 입고예정일 to day N', async () => {
      await poForm.setDate(poForm.expectedDateInput, today);
    });

    await step('Assert: Expected 4 — A date equal to Order date is accepted', async () => {
      await expect(poForm.expectedDateInput, '[Expected 4] Expected date = Order date accepted').toHaveValue(today);
    });

    await step('Act: Step 5 — Change 발주일 to a day later than the selected 입고예정일', async () => {
      // Hôm nay là ngày lớn nhất 발주일 nhận được → dựng 입고예정일 N−4 trên 발주일 N−5 rồi đẩy 발주일 lên N−3.
      await poForm.setDate(poForm.orderDateInput, seoulToday(-5));
      await poForm.setDate(poForm.expectedDateInput, seoulToday(-4));
      await poForm.setDate(poForm.orderDateInput, seoulToday(-3));
    });

    await step('Assert: Expected 5 — Expected date is cleared with "Re-select the expected inbound date."', async () => {
      await expect(poForm.expectedDateInput, '[Expected 5] Expected inbound date cleared').toHaveValue('');
      await expect(page.getByText(PO_KO['text.errReExpectedDate']), '[Expected 5] Re-select message').toBeVisible();
    });
  });

  test('TC_US105_036 — Manufacturer is hidden when the supplier is the manufacturer, optional otherwise', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_036', 'Medium', TAGS, 'Manufacturer shown with no mandatory marker and "— 선택 (임의) —"; the list holds every manufacturer record unfiltered; Supplier type Manufacturer hides the field entirely; Biz partner with an empty Manufacturer saves.');

    await step('Arrange: Pre-condition 1–2 — The Manufacturer master holds several records', async () => {
      await poForm.openCreate();
    });

    await step('Act: Step 1 — Leave Supplier type at Biz partner and observe 제조사', async () => {
      await poForm.manufacturerSelect.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — Shown, no mandatory marker, placeholder "— Select (optional) —"', async () => {
      await expect(poForm.manufacturerSelect, '[Expected 1] Manufacturer is shown').toBeVisible();
      await expect(poForm.manufacturerSelect.locator('xpath=preceding-sibling::label'), '[Expected 1] No mandatory marker').not.toContainText('*');
      await expect(poForm.manufacturerSelect.locator('option:checked'), '[Expected 1] Placeholder').toHaveText(PO_KO['text.manufacturerPlaceholder']);
    });

    await step('Act: Step 2 — Expand the 제조사 list and compare it with every record in the master', async () => {
      await poForm.manufacturerSelect.focus();
    });

    await step('Assert: Expected 2 — Every record is listed, none filtered out (not by status, not by supplier)', async () => {
      const master = await poData.api.manufacturers();
      const listed = (await poForm.optionLabels(poForm.manufacturerSelect)).slice(1);
      expect(listed.length, '[Expected 2] One option per manufacturer record').toBe(master.length);
      for (const record of master) expect(listed, `[Expected 2] ${record.name} is listed`).toContain(record.name.trim());
    });

    await step('Act: Step 3 — Change 공급처 유형 to 제조사 and observe the 제조사 field', async () => {
      await poForm.supplierTypeSelect.selectOption('MANUFACTURER');
    });

    await step('Assert: Expected 3 — The Manufacturer field is hidden entirely, not merely disabled', async () => {
      await expect(page.locator('label.form-label').filter({ hasText: new RegExp(`^${PO_KO['text.manufacturerLabel']}`) }), '[Expected 3] Manufacturer is not rendered').toHaveCount(0);
    });

    await step('Act: Step 4 — Back to Biz partner, leave 제조사 empty, fill the rest and click 임시저장', async () => {
      await poForm.supplierTypeSelect.selectOption('BIZ_PARTNER');
      await fillValidForm(poForm, poData);
      await trackSaved(await poForm.saveDraft(), poData);
    });

    await step('Assert: Expected 4 — The save succeeds with an empty Manufacturer', async () => {
      await expect(poForm.toast(PO_KO['text.toastSaved']), '[Expected 4] Save toast').toBeVisible();
      await expect(poForm.poNoInput, '[Expected 4] PO no. issued').toHaveValue(/^PO-/);
    });
  });

  test('TC_US105_038 — The Inbound destination list excludes SUPPLIER warehouses and every virtual type', async ({ page, poForm, poData, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_038', 'High', TAGS, 'Warehouse A listed; SUPPLIER Warehouse B absent although not virtual; the QUARANTINE bucket (PLATFORM, virtual) absent; the other four virtual buckets, DEFECTIVE included, absent; no helper text under the field. Warehouse A = automation warehouse, its 5 buckets = the virtual warehouses, Warehouse B = SUPPLIER warehouse created for the test.');
    let supplierWarehouse = '';
    let options: string[] = [];

    await step('Arrange: Pre-condition 1–2 — Warehouse A PLATFORM, Warehouse B SUPPLIER, the five virtual buckets', async () => {
      supplierWarehouse = (await warehouseCleanup.create('SUPPLIER', 'TC_US105_038')).name;
      await poForm.openCreate();
    });

    await step('Act: Step 1 — Click 발주 등록 and expand the 입고지 list', async () => {
      options = (await poForm.optionLabels(poForm.destinationSelect)).slice(1);
    });

    await step('Assert: Expected 1 — The list opens and holds Warehouse A', async () => {
      expect(options, '[Expected 1] Warehouse A is listed').toContain(poData.warehouse.name);
    });

    await step('Act: Step 2 — Look for Warehouse B in the list', async () => {
      await poForm.destinationSelect.focus();
    });

    await step('Assert: Expected 2 — Warehouse B is absent (excluded for being SUPPLIER)', async () => {
      expect(options, '[Expected 2] SUPPLIER Warehouse B is absent').not.toContain(supplierWarehouse);
    });

    await step('Act: Step 3 — Look for Warehouse C (QUARANTINE bucket) in the list', async () => {
      await poForm.destinationSelect.focus();
    });

    await step('Assert: Expected 3 — Warehouse C is absent (excluded for being virtual)', async () => {
      expect(options, '[Expected 3] The QUARANTINE bucket is absent').not.toContain(`${poData.warehouse.name} - 이슈격리`);
    });

    await step('Act: Step 4 — Sweep the four remaining virtual warehouses, DEFECTIVE included', async () => {
      await poForm.destinationSelect.focus();
    });

    await step('Assert: Expected 4 — All four remaining virtual warehouses are absent', async () => {
      for (const bucket of ['매출대기', '이동중', '폐기', '불량']) expect(options, `[Expected 4] Bucket ${bucket} is absent`).not.toContain(`${poData.warehouse.name} - ${bucket}`);
    });

    await step('Act: Step 5 — Observe the area directly under the 입고지 field', async () => {
      await poForm.destinationSelect.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 5 — No text explaining the exclusion', async () => {
      await expect(poForm.destinationSelect.locator('xpath=following-sibling::*'), '[Expected 5] Nothing under the field').toHaveCount(0);
    });
  });

  test('TC_US105_041 — Sale type is mandatory on every line, offers three values and is independent of Owner', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_041', 'High', TAGS, 'Sale type lists 사입 / 라이선스 판매 / 전체위탁; Owner and Sale type never follow each other; changing Owner keeps 사입; 파트너 + 전체위탁 saves and is stored together.');
    let id = 0;

    await step('Arrange: Pre-condition 1–3 — Create PO form with Warehouse A and one line on SKU A (mapped 자사 and 파트너)', async () => {
      await poForm.openCreate();
      await poForm.fillBasics({ supplier: SUPPLIER.starship.ko, destination: poData.warehouse.name });
      await poForm.addLine({ sku: poData.warehouse.skus.A.name, qty: 10, price: 1000 });
    });

    await step('Act: Step 1 — Expand the 판매유형 list on the line', async () => {
      await poForm.lineSaleType().focus();
    });

    await step('Assert: Expected 1 — Exactly 사입, 라이선스 판매, 전체위탁', async () => {
      expect((await poForm.optionLabels(poForm.lineSaleType())).slice(1), '[Expected 1] Three sale types').toEqual([PO_KO['saleType.PURCHASE'], PO_KO['saleType.LICENSE'], PO_KO['saleType.SELF']]);
    });

    await step('Act: Step 2 — Set 소유 주체 to 자사 재고 and then 판매유형 to 사입', async () => {
      await poForm.lineOwner().selectOption({ label: '자사 재고' });
      await poForm.lineSaleType().selectOption({ label: PO_KO['saleType.PURCHASE'] });
    });

    await step('Assert: Expected 2 — Both fields take their values; neither follows the other', async () => {
      await expect(poForm.lineOwner(), '[Expected 2] Owner 자사').toHaveValue('OWN');
      await expect(poForm.lineSaleType(), '[Expected 2] Sale type 사입').toHaveValue('PURCHASE');
    });

    await step('Act: Step 3 — Change 소유 주체 to 파트너 재고 and observe 판매유형', async () => {
      await poForm.lineOwner().selectOption({ label: '파트너 재고' });
    });

    await step('Assert: Expected 3 — Sale type stays at 사입, neither changed nor cleared', async () => {
      await expect(poForm.lineSaleType(), '[Expected 3] Sale type kept at 사입').toHaveValue('PURCHASE');
    });

    await step('Act: Step 4 — Change 판매유형 to 전체위탁 and click 임시저장', async () => {
      await poForm.lineSaleType().selectOption({ label: PO_KO['saleType.SELF'] });
      id = await trackSaved(await poForm.saveDraft(), poData);
    });

    await step('Assert: Expected 4 — The save succeeds', async () => {
      await expect(poForm.toast(PO_KO['text.toastSaved']), '[Expected 4] Save toast').toBeVisible();
    });

    await step('Act: Step 5 — Reopen the PO just saved and read the line', async () => {
      await poForm.openPo(id);
    });

    await step('Assert: Expected 5 — The line records Owner 파트너 and Sale type 전체위탁 together', async () => {
      await expect(poForm.lineOwner().locator('option:checked'), '[Expected 5] Owner 파트너 재고').toHaveText('파트너 재고');
      await expect(poForm.lineSaleType().locator('option:checked'), '[Expected 5] Sale type 전체위탁').toHaveText(PO_KO['saleType.SELF']);
    });
  });

  test('TC_US105_043 — Changing the Inbound destination re-validates every line; an invalid line blocks the issue', async ({ page, poForm, poData, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_043', 'High', TAGS, 'The line is valid on Warehouse A; switching to Warehouse D (no mapping for SKU A) flags it; Issue PO is blocked, the PO stays Draft and the message names the unregistered value. Warehouse D = a PLATFORM warehouse created for the test without mappings.');
    const po = await poData.createDraft();
    let warehouseD = '';

    await step('Arrange: Pre-condition 1–3 — PO A Draft on Warehouse A with SKU A / 자사; Warehouse D valid but unmapped for SKU A', async () => {
      warehouseD = (await warehouseCleanup.create('PLATFORM_GENERAL', 'TC_US105_043')).name;
    });

    await step('Act: Step 1 — Open PO A', async () => {
      await poForm.openPo(po.id);
    });

    await step('Assert: Expected 1 — The line is currently valid and carries no warning', async () => {
      await expect(poForm.line().locator('.text-danger'), '[Expected 1] No warning on the line').toHaveCount(0);
    });

    await step('Act: Step 2 — Change 입고지 to Warehouse D', async () => {
      await poForm.destinationSelect.selectOption({ label: warehouseD });
    });

    await step('Assert: Expected 2 — The line is flagged as no longer valid for the new warehouse', async () => {
      await expect(poForm.line(), '[Expected 2] The line carries the not-registered warning').toContainText(PO_KO['text.errSkuNotDeclared']);
    });

    await step('Act: Step 3 — Click 발주 발행 (Issue PO)', async () => {
      await poForm.issueButton.click().catch(() => undefined);
    });

    await step('Assert: Expected 3 — Blocked, the PO stays Draft and the message names the unregistered value', async () => {
      await expect(poForm.statusBadge, '[Expected 3] Still Draft').toHaveText(PO_KO['poStatus.DRAFT']);
      expect((await poData.read(po.id)).status, '[Expected 3] Server-side status is still DRAFT').toBe('DRAFT');
      await expect(page.locator('body'), '[Expected 3] The message names the unregistered SKU / warehouse').toContainText(new RegExp(`${PO_KO['text.errSkuNotDeclared']}|${warehouseD}`));
    });
  });

  test('TC_US105_045 — Ordered qty and Unit price accept only their permitted formats', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_045', 'Medium', TAGS, '0 / -5 / 12.5 / 1e3 in Ordered qty → "1 이상의 정수를 입력하세요." and the field keeps the last valid value; 300 shown with separators; -100 / 39150.55 in Unit price → "0 이상의 숫자를 입력하세요." (KRW has no decimals); 39150 shown as 39,150; column named 매입단가 with a VAT-excluded placeholder and no extra VAT line.');

    await step('Arrange: Pre-condition 1–2 — Create PO form with one valid line, Currency KRW', async () => {
      await poForm.openCreate();
      await poForm.fillBasics({ supplier: SUPPLIER.starship.ko, destination: poData.warehouse.name });
      await poForm.addLine({ sku: poData.warehouse.skus.A.name, owner: '자사 재고', saleType: PO_KO['saleType.PURCHASE'] });
    });

    const qtyResults: Array<{ value: string; kept: string; error: boolean }> = [];
    await step('Act: Step 1 — Enter 0, then -5, then 12.5, then 1e3 into 발주 수량', async () => {
      for (const value of ['0', '-5', '12.5', '1e3']) {
        await poForm.lineQty().fill('');
        await poForm.lineQty().pressSequentially(value);
        qtyResults.push({ value, kept: await poForm.lineQty().inputValue(), error: await poForm.line().getByText(PO_KO['text.errQty']).isVisible() });
      }
    });

    await step('Assert: Expected 1 — All four blocked with "Enter a whole number of 1 or more."; last valid value kept', async () => {
      for (const { value, kept, error } of qtyResults) {
        expect(error, `[Expected 1] "${value}" shows "1 이상의 정수를 입력하세요."`).toBe(true);
        expect(kept, `[Expected 1] "${value}" is not kept in the field`).not.toBe(value);
      }
    });

    await step('Act: Step 2 — Enter 300 into 발주 수량', async () => {
      await poForm.lineQty().fill('300');
    });

    await step('Assert: Expected 2 — Accepted and displayed with thousands separators', async () => {
      await expect(poForm.lineQty(), '[Expected 2] 300 accepted').toHaveValue('300');
      await expect(poForm.line().getByText(PO_KO['text.errQty']), '[Expected 2] No error').toHaveCount(0);
    });

    const priceResults: Array<{ value: string; error: boolean }> = [];
    await step('Act: Step 3 — Enter -100 and then 39150.55 into 매입단가', async () => {
      for (const value of ['-100', '39150.55']) {
        await poForm.linePrice().fill('');
        await poForm.linePrice().pressSequentially(value);
        priceResults.push({ value, error: await poForm.line().getByText(PO_KO['text.errPrice']).isVisible() });
      }
    });

    await step('Assert: Expected 3 — Both blocked with "Enter a number of 0 or more."', async () => {
      for (const { value, error } of priceResults) expect(error, `[Expected 3] "${value}" shows "0 이상의 숫자를 입력하세요."`).toBe(true);
    });

    await step('Act: Step 4 — Enter 39150 into 매입단가', async () => {
      await poForm.linePrice().fill('39150');
    });

    await step('Assert: Expected 4 — Accepted and displayed as 39,150', async () => {
      await expect(poForm.linePrice(), '[Expected 4] Displayed as 39,150').toHaveValue('39,150');
    });

    await step('Act: Step 5 — Observe the 매입단가 column name and placeholder', async () => {
      await poForm.linePrice().scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 5 — Column 매입단가, VAT-excluded placeholder, no separate VAT line', async () => {
      await expect(poForm.lineTable.getByRole('columnheader', { name: PO_KO['col.poLine.unitPrice'] }), '[Expected 5] Column named 매입단가').toBeVisible();
      await expect(poForm.linePrice(), '[Expected 5] Placeholder states VAT excluded').toHaveAttribute('placeholder', PO_KO['text.pricePlaceholder']);
      await expect(poForm.lineTable.locator('xpath=following-sibling::*').filter({ hasText: /부가세|VAT/ }), '[Expected 5] No separate VAT line').toHaveCount(0);
    });
  });

  test('TC_US105_046 — Ordered qty boundaries 1 to 999,999,999 and a Unit price of 0', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_046', 'Medium', TAGS, 'Qty 1 → Line amount 39,150; 999,999,999 accepted (upper bound); 1,000,000,000 blocked with "1 이상의 정수를 입력하세요." (10 digits rejected before typing completes); Unit price 0 → Line amount 0.');

    await step('Arrange: Pre-condition 1–2 — Create PO form with one valid line, Currency KRW', async () => {
      await poForm.openCreate();
      await poForm.fillBasics({ supplier: SUPPLIER.starship.ko, destination: poData.warehouse.name });
      await poForm.addLine({ sku: poData.warehouse.skus.A.name, owner: '자사 재고', saleType: PO_KO['saleType.PURCHASE'] });
    });

    await step('Act: Step 1 — Enter 발주 수량 1 and 매입단가 39150', async () => {
      await poForm.lineQty().fill('1');
      await poForm.linePrice().fill('39150');
    });

    await step('Assert: Expected 1 — 1 accepted and Line amount 39,150', async () => {
      await expect(poForm.lineAmount(), '[Expected 1] Line amount 39,150').toHaveText(/^39,150/);
    });

    await step('Act: Step 2 — Change 발주 수량 to 999999999', async () => {
      await poForm.lineQty().fill('999999999');
    });

    await step('Assert: Expected 2 — 999,999,999 accepted and Line amount computed', async () => {
      await expect(poForm.line().getByText(PO_KO['text.errQty']), '[Expected 2] No error at the upper bound').toHaveCount(0);
      await expect(poForm.lineAmount(), '[Expected 2] Line amount = 999,999,999 × 39,150').toHaveText(/^39,149,999,960,850/);
    });

    await step('Act: Step 3 — Try to enter 발주 수량 1000000000', async () => {
      await poForm.lineQty().fill('');
      await poForm.lineQty().pressSequentially('1000000000');
    });

    await step('Assert: Expected 3 — Blocked with "Enter a whole number of 1 or more."', async () => {
      const value = (await poForm.lineQty().inputValue()).replace(/,/g, '');
      const error = await poForm.line().getByText(PO_KO['text.errQty']).isVisible();
      expect(value !== '1000000000' || error, '[Expected 3] 10 digits are rejected (not kept, or flagged with the qty message)').toBe(true);
      expect(error || value.length <= 9, '[Expected 3] "1 이상의 정수를 입력하세요." or the 10th digit refused').toBe(true);
    });

    await step('Act: Step 4 — Change 발주 수량 back to 300 and enter 매입단가 0', async () => {
      await poForm.lineQty().fill('300');
      await poForm.linePrice().fill('0');
    });

    await step('Assert: Expected 4 — 0 accepted and Line amount 0', async () => {
      await expect(poForm.line().getByText(PO_KO['text.errPrice']), '[Expected 4] 0 is accepted').toHaveCount(0);
      await expect(poForm.lineAmount(), '[Expected 4] Line amount 0').toHaveText(/^0/);
    });
  });

  test('TC_US105_047 — Line amount rounds once; PO amount is the sum of the rounded Line amounts', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_047', 'High', TAGS, 'Line 1 300 × 39150 = 11,745,000; line 2 30 × 20790 = 623,700; total 12,368,700; the Line amount cell is read-only.');

    await step('Arrange: Pre-condition 1–3 — Create PO form, Currency KRW, two mapped SKUs on Warehouse A', async () => {
      await poForm.openCreate();
      await poForm.fillBasics({ supplier: SUPPLIER.starship.ko, destination: poData.warehouse.name });
    });

    await step('Act: Step 1 — Add line 1 with 발주 수량 300 and 매입단가 39150', async () => {
      await poForm.addLine({ sku: poData.warehouse.skus.A.name, owner: '자사 재고', saleType: PO_KO['saleType.PURCHASE'], qty: 300, price: 39150 });
    });

    await step('Assert: Expected 1 — Line amount on line 1 computes at once to 11,745,000', async () => {
      await expect(poForm.lineAmount(0), '[Expected 1] 11,745,000').toHaveText(/^11,745,000/);
    });

    await step('Act: Step 2 — Add line 2 with 발주 수량 30 and 매입단가 20790', async () => {
      await poForm.addLine({ sku: poData.warehouse.skus.B.name, owner: '자사 재고', saleType: PO_KO['saleType.PURCHASE'], qty: 30, price: 20790 });
    });

    await step('Assert: Expected 2 — Line amount on line 2 computes at once to 623,700', async () => {
      await expect(poForm.lineAmount(1), '[Expected 2] 623,700').toHaveText(/^623,700/);
    });

    await step('Act: Step 3 — Observe the PO amount total', async () => {
      await poForm.totalAmount.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — 12,368,700, exactly the sum of the two rounded Line amounts', async () => {
      await expect(poForm.totalAmount, '[Expected 3] 12,368,700').toHaveText('12,368,700');
    });

    await step('Act: Step 4 — Try to click into the Line amount cell of line 1 and type', async () => {
      await poForm.lineAmount(0).click();
      await page.keyboard.type('123');
    });

    await step('Assert: Expected 4 — The Line amount cell accepts no input; it is read-only', async () => {
      await expect(poForm.lineAmount(0).locator('input, textarea'), '[Expected 4] No input in the Line amount cell').toHaveCount(0);
      await expect(poForm.lineAmount(0), '[Expected 4] Value unchanged').toHaveText(/^11,745,000/);
    });
  });

  test('TC_US105_049 — Changing Currency re-formats every amount and re-rounds Line amount', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_049', 'Medium', TAGS, 'KRW shows 11,745,000 with no decimals; USD re-formats to 2 decimals; USD accepts 39150.55 and blocks 39150.555 with "0 이상의 숫자를 입력하세요."; JPY re-formats to 0 decimals and blocks a decimal part with the same message.');

    await step('Arrange: Pre-condition 1–2 — Create PO form in Draft, one line 300 × 39150, Currency KRW', async () => {
      await poForm.openCreate();
      await poForm.fillBasics({ supplier: SUPPLIER.starship.ko, destination: poData.warehouse.name });
      await poForm.addLine({ sku: poData.warehouse.skus.A.name, owner: '자사 재고', saleType: PO_KO['saleType.PURCHASE'], qty: 300, price: 39150 });
    });

    await step('Act: Step 1 — Observe the Line amount and PO amount', async () => {
      await poForm.totalAmount.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — 11,745,000 and 11,745,000 with no decimals', async () => {
      await expect(poForm.lineAmount(), '[Expected 1] Line amount 11,745,000').toHaveText(/^11,745,000/);
      await expect(poForm.totalAmount, '[Expected 1] PO amount 11,745,000').toHaveText('11,745,000');
    });

    await step('Act: Step 2 — Change 통화 to USD and observe every amount', async () => {
      await poForm.currencySelect.selectOption('USD');
    });

    await step('Assert: Expected 2 — Every amount re-formats to 2 decimals', async () => {
      await expect(poForm.lineAmount(), '[Expected 2] Line amount with 2 decimals').toHaveText(/^11,745,000\.00/);
      await expect(poForm.totalAmount, '[Expected 2] PO amount with 2 decimals').toHaveText('11,745,000.00');
    });

    let threeDecimals = { value: '', error: false };
    await step('Act: Step 3 — Enter 매입단가 39150.55 and then try 39150.555', async () => {
      await poForm.linePrice().fill('');
      await poForm.linePrice().pressSequentially('39150.55');
      await expect(poForm.linePrice()).toHaveValue('39,150.55');
      await poForm.linePrice().pressSequentially('5');
      threeDecimals = { value: await poForm.linePrice().inputValue(), error: await poForm.line().getByText(PO_KO['text.errPrice']).isVisible() };
    });

    await step('Assert: Expected 3 — 2 decimals accepted; the third decimal blocked with "Enter a number of 0 or more."', async () => {
      expect(threeDecimals.value, '[Expected 3] The 3-decimal value is not kept').not.toBe('39,150.555');
      expect(threeDecimals.error, '[Expected 3] "0 이상의 숫자를 입력하세요." is shown').toBe(true);
    });

    await step('Act: Step 4 — Change 통화 to JPY and observe every amount', async () => {
      await poForm.currencySelect.selectOption('JPY');
    });

    await step('Assert: Expected 4 — Every amount re-formats to 0 decimals', async () => {
      await expect(poForm.totalAmount, '[Expected 4] PO amount with no decimals').toHaveText(/^[\d,]+$/);
    });

    let jpy = { value: '', error: false };
    await step('Act: Step 5 — Try to enter a 매입단가 with a decimal part while on JPY', async () => {
      await poForm.linePrice().fill('');
      await poForm.linePrice().pressSequentially('39150.5');
      jpy = { value: await poForm.linePrice().inputValue(), error: await poForm.line().getByText(PO_KO['text.errPrice']).isVisible() };
    });

    await step('Assert: Expected 5 — The decimal part is blocked with the same message, as for KRW', async () => {
      expect(jpy.value, '[Expected 5] No decimal part is kept').not.toContain('.');
      expect(jpy.error, '[Expected 5] "0 이상의 숫자를 입력하세요." is shown').toBe(true);
    });
  });

  test('TC_US105_050 — Add line disabled before a warehouse, Remove line disabled on the last line, both gone from Issued', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_050', 'Medium', TAGS, 'Add line disabled until a destination is chosen, then usable; Remove line disabled on the only line of a saved Draft; neither button rendered on an Issued PO.');
    const draft = await poData.createDraft();
    const issued = await poData.createIssued();

    await step('Arrange: Pre-condition 1–2 — PO A saved Draft with one line; PO B Issued', async () => {
      await poForm.openCreate();
    });

    await step('Act: Step 1 — Click 발주 등록 and observe 품목 추가 before a destination is chosen', async () => {
      await poForm.addLineButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — Add line is disabled', async () => {
      await expect(poForm.addLineButton, '[Expected 1] Add line disabled').toBeDisabled();
    });

    await step('Act: Step 2 — Set 입고지 to Warehouse A and observe 품목 추가 again', async () => {
      await poForm.destinationSelect.selectOption({ label: poData.warehouse.name });
    });

    await step('Assert: Expected 2 — Add line becomes usable', async () => {
      await expect(poForm.addLineButton, '[Expected 2] Add line enabled').toBeEnabled();
    });

    await step('Act: Step 3 — Open PO A and click Remove line on its only line', async () => {
      await poForm.openPo(draft.id);
    });

    await step('Assert: Expected 3 — Remove line is disabled (a PO may not have zero lines)', async () => {
      await expect(poForm.lineRemove(), '[Expected 3] Remove line disabled on the last line').toBeDisabled();
    });

    await step('Act: Step 4 — Open PO B and look for 품목 추가 and Remove line', async () => {
      await poForm.openPo(issued.id);
    });

    await step('Assert: Expected 4 — Neither button is rendered in Issued status', async () => {
      await expect(poForm.addLineButton, '[Expected 4] No Add line').toHaveCount(0);
      await expect(poForm.lineRemove(), '[Expected 4] No Remove line').toHaveCount(0);
    });
  });

  test('TC_US105_051 — Delete removes a Draft PO and refreshes the list', async ({ page, poList, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_051', 'Critical', TAGS, 'Delete shown on a Draft; a confirmation dialog appears; confirming deletes with "발주서가 삭제되었습니다." and returns to a refreshed list; the PO number is gone.');
    const po = await poData.createDraft([{}, { sku: 'B' }]);

    await step('Arrange: Pre-condition 1–2 — PO A Draft with two lines; its PO number noted', async () => {
      await poForm.openPo(po.id);
    });

    await step('Act: Step 1 — Open PO A', async () => {
      await poForm.header.waitFor();
    });

    await step('Assert: Expected 1 — The Delete button is shown because the PO is Draft', async () => {
      await expect(poForm.deleteButton, '[Expected 1] Delete is shown').toBeVisible();
    });

    const dialog = poForm.confirmDialog();
    await step('Act: Step 2 — Click 삭제 (Delete)', async () => {
      await poForm.deleteButton.click();
      await dialog.waitOpen();
    });

    await step('Assert: Expected 2 — A delete confirmation dialog appears', async () => {
      await expect(dialog.title, '[Expected 2] "발주서를 삭제할까요?"').toHaveText(PO_KO['text.deleteConfirmTitle']);
      await expect(dialog.root, '[Expected 2] Confirmation message').toContainText(PO_KO['text.deleteConfirmMessage']);
    });

    await step('Act: Step 3 — Confirm in the dialog', async () => {
      await dialog.button(PO_KO['text.deletePo']).click();
      await page.waitForURL(/\/commerce\/purchase-orders$/);
    });

    await step('Assert: Expected 3 — Deleted with "Purchase order deleted." and back on a refreshed list', async () => {
      await expect(poForm.toast(PO_KO['text.toastDeleted']), '[Expected 3] Delete toast').toBeVisible();
      await expect(poList.heading, '[Expected 3] Back on the list').toBeVisible();
    });

    await step('Act: Step 4 — Look for the noted PO number in the list again', async () => {
      await poList.searchBy(PO_KO['searchType.PO_NO'], po.poNo);
    });

    await step('Assert: Expected 4 — No row carries that PO number', async () => {
      await expect(poList.rowByPoNo(po.poNo), '[Expected 4] The PO is gone').toHaveCount(0);
      expect((await poData.api.get(po.id)).status, '[Expected 4] The API no longer finds it').toBe(404);
    });
  });

  test('TC_US105_053 — A rapid double click on Save draft creates exactly one PO', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_053', 'High', TAGS, 'Only one save is carried out; the button is disabled while the request is in flight; the list grows by exactly one, no duplicate. Counted on the automation warehouse of the run.');
    const creates: string[] = [];
    let before = 0;

    await step('Arrange: Pre-condition 1–3 — A filled Create PO form never saved; the current row count noted', async () => {
      before = (await poData.api.list({ warehouseId: poData.warehouse.id })).body.paging.totalCount;
      await poForm.openCreate();
      await fillValidForm(poForm, poData);
      page.on('request', (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/purchase-orders' && creates.push(r.url()));
    });

    let disabledAfterFirst = false;
    await step('Act: Step 1 — Click 임시저장 twice in rapid succession', async () => {
      const response = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/purchase-orders');
      await poForm.saveDraftButton.dblclick();
      disabledAfterFirst = await poForm.saveDraftButton.isDisabled();
      await trackSaved(await response, poData);
    });

    await step('Assert: Expected 1 — Only one save is carried out', async () => {
      expect(creates, '[Expected 1] Exactly one create request').toHaveLength(1);
    });

    await step('Act: Step 2 — Observe the 임시저장 button immediately after the first click', async () => {
      await poForm.saveDraftButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — The button is disabled while the request is in flight', async () => {
      expect(disabledAfterFirst || creates.length === 1, '[Expected 2] The second click is never sent').toBe(true);
    });

    await step('Act: Step 3 — Click 발주 목록으로 and count the list rows again', async () => {
      await poForm.backToListButton.click();
    });

    await step('Assert: Expected 3 — Exactly one more row, no duplicate', async () => {
      expect((await poData.api.list({ warehouseId: poData.warehouse.id })).body.paging.totalCount, '[Expected 3] Row count +1').toBe(before + 1);
    });
  });

  test('TC_US105_146 — A PO cannot carry the same SKU on two lines, even under two legitimate owners', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_146', 'Medium', TAGS, 'The form accepts the destination and both SKU A lines (자사 / 파트너); saving is refused with PRC-1040 naming the SKU; with one line for SKU A both save and issue succeed.');
    let id = 0;

    await step('Arrange: Pre-condition 1–2 — SKU A mapped at Warehouse A under both 자사 and 파트너', async () => {
      await poForm.openCreate();
    });

    await step('Act: Step 1 — Create a Draft PO with 입고지 Warehouse A', async () => {
      await poForm.fillBasics({ supplier: SUPPLIER.starship.ko, destination: poData.warehouse.name });
    });

    await step('Assert: Expected 1 — The form takes the destination', async () => {
      await expect(poForm.destinationSelect.locator('option:checked'), '[Expected 1] Warehouse A selected').toHaveText(poData.warehouse.name);
    });

    await step('Act: Step 2 — Add SKU A with 자사, then a second line for SKU A with 파트너', async () => {
      await poForm.addLine({ sku: poData.warehouse.skus.A.name, owner: '자사 재고', saleType: PO_KO['saleType.PURCHASE'], qty: 10, price: 1000 });
      await poForm.addLine({ sku: poData.warehouse.skus.A.name, owner: '파트너 재고', saleType: PO_KO['saleType.PURCHASE'], qty: 10, price: 1000 });
    });

    await step('Assert: Expected 2 — Both lines are added as entered', async () => {
      await expect(poForm.lineRows.filter({ has: page.locator('select') }), '[Expected 2] Two lines').toHaveCount(2);
    });

    let saveStatus = 0;
    await step('Act: Step 3 — Click 임시저장', async () => {
      const response = await poForm.saveDraft();
      saveStatus = response.status();
      if (saveStatus < 300) id = await trackSaved(response, poData);
    });

    await step('Assert: Expected 3 — Blocked with PRC-1040 naming the SKU and both lines', async () => {
      expect(saveStatus, '[Expected 3] The save is refused').toBeGreaterThanOrEqual(400);
      await expect(page.locator('body'), '[Expected 3] PRC-1040 message naming the SKU').toContainText(fmt(PO_KO['error.PRC-1040'], { sku: poData.warehouse.skus.A.code }).slice(0, 10));
    });

    await step('Act: Step 4 — Remove the second line, click 임시저장, then 발주 발행', async () => {
      await poForm.lineRemove(1).click();
      const confirm = poForm.confirmDialog();
      if (await confirm.root.isVisible().catch(() => false)) await confirm.button(PO_KO['text.deletePo']).click().catch(() => confirm.button(PO_KO['text.confirm']).click());
      id = await trackSaved(await poForm.saveDraft(), poData);
      await poForm.issueButton.click();
    });

    await step('Assert: Expected 4 — With one line for SKU A the save and the issue both succeed', async () => {
      await expect(poForm.toast(PO_KO['text.toastIssued']), '[Expected 4] Issue toast').toBeVisible();
      expect((await poData.read(id)).status, '[Expected 4] The PO is Issued').toBe('ISSUED');
    });
  });
});
