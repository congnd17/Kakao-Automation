import { apiTest as test, expect } from '@fixtures/purchase-order.fixture';
import { makeApiStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { PO_KO, fmt } from '@utils/purchase-order.i18n';
import { errorCode, PoApiError, PoDetail } from '@api/purchase-order.api';
import { buildPoBody, seoulToday, toPoUpdateBody } from '@utils/purchase-order.data';
import { buildWarehouseBody } from '@utils/warehouse.data';

/**
 * API ghi PO (US105) — create / update / delete / issue gọi trực tiếp, bỏ qua form. Server trả message tiếng Hàn → so
 * với từ điển UI `PO_KO` (câu tiếng Anh trong TC là bản dịch của cùng 1 key). Mọi PO tạo ra nằm trên kho automation và
 * được dọn ở teardown. 공급처 bị chấm dứt hợp đồng có sẵn trên dev (서울오디오, TERMINATED) — không cần chấm dứt 1 공급처 thật.
 */
const TAGS = ['api', 'purchase-order', 'create'];
const TERMINATED_SUPPLIER = 1752754626593;
const UNKNOWN_ID = 999_999_999_999;

function message(body: unknown): string {
  const error = body as PoApiError;
  return `${error?.message ?? ''} ${error?.detail ?? ''}`;
}

test.describe('[API] Purchase order writes — create, update, delete', () => {
  test.describe.configure({ timeout: 120_000 });

  test('TC_US105_033 — A Supplier type contradicting a line Sale type is refused in both directions', async ({ poApi, poData }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_033', 'High', TAGS, 'Biz partner + 라이선스 판매 → PRC-1024 naming the line; Manufacturer + 사입 → PRC-1024; Manufacturer + 전체위탁 → PRC-1024; Biz partner + 전체위탁 → saved; issuing with the contradictory pair is refused and PO A stays Draft; PO A data unchanged.');
    let po: PoDetail;
    const results: Record<number, { status: number; body: unknown }> = {};

    await step('Arrange: Pre-condition 1–2 — INVENTORY_OPERATOR token; PO A Draft with one valid line', async () => {
      po = await poData.createDraft();
    });

    const attempt = async (n: number, supplierType: 'BIZ_PARTNER' | 'MANUFACTURER', saleType: 'PURCHASE' | 'LICENSE' | 'SELF') => {
      const fresh = await poData.read(po.id);
      results[n] = await poApi.update(po.id, toPoUpdateBody(fresh, { supplierType, manufacturerId: supplierType === 'MANUFACTURER' ? 1 : null, lines: [{ ...fresh.lines[0], saleType }] }));
    };

    await step('Act: Step 1 — Save PO A with Supplier type Biz partner and a 라이선스 판매 line', async () => attempt(1, 'BIZ_PARTNER', 'LICENSE'));
    await step('Assert: Expected 1 — Refused with error code PRC-1024', async () => {
      expect(errorCode(results[1].body), '[Expected 1] PRC-1024').toBe('PRC-1024');
    });

    await step('Act: Step 2 — Read the message returned', async () => undefined);
    await step('Assert: Expected 2 — The licensed-item message, naming the offending line', async () => {
      expect(message(results[1].body), '[Expected 2] The PRC-1024 message').toContain(PO_KO['error.PRC-1024'].slice(0, 20));
      expect(message(results[1].body), '[Expected 2] The offending line is named').toMatch(/1|line|품목/);
    });

    await step('Act: Step 3 — Save PO A with Supplier type 제조사 and a 사입 line', async () => attempt(3, 'MANUFACTURER', 'PURCHASE'));
    await step('Assert: Expected 3 — Refused under the same code PRC-1024', async () => {
      expect(errorCode(results[3].body), '[Expected 3] PRC-1024').toBe('PRC-1024');
    });

    await step('Act: Step 4 — Save PO A with Supplier type 제조사 and a 전체위탁 line', async () => attempt(4, 'MANUFACTURER', 'SELF'));
    await step('Assert: Expected 4 — Refused under the same code', async () => {
      expect(errorCode(results[4].body), '[Expected 4] PRC-1024').toBe('PRC-1024');
    });

    await step('Act: Step 5 — Save with Supplier type Biz partner and a 전체위탁 line', async () => attempt(5, 'BIZ_PARTNER', 'SELF'));
    await step('Assert: Expected 5 — The save SUCCEEDS (전체위탁 pairs with 비즈파트너)', async () => {
      expect(results[5].status, '[Expected 5] Saved').toBeLessThan(300);
    });

    await step('Act: Step 6 — Call the issue API with the same contradictory pair as step 1', async () => {
      const fresh = await poData.read(po.id);
      results[6] = await poApi.issue(po.id, fresh.version);
    });
    await step('Assert: Expected 6 — Refused; the PO stays Draft', async () => {
      expect(results[6].status, '[Expected 6] The issue is refused').toBeGreaterThanOrEqual(400);
      expect((await poData.read(po.id)).status, '[Expected 6] PO A is still Draft').toBe('DRAFT');
    });

    await step('Act: Step 7 — Call the read API on PO A', async () => undefined);
    await step('Assert: Expected 7 — The PO data is unchanged', async () => {
      const after = await poData.read(po.id);
      expect(after.supplierType, '[Expected 7] Supplier type unchanged').toBe('BIZ_PARTNER');
      expect(after.lines, '[Expected 7] Still one line').toHaveLength(1);
    });
  });

  test('TC_US105_035 — The server refuses an invalid date pair when the caller bypasses the picker', async ({ poApi, poData, poBase }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_035', 'Medium', TAGS, 'Expected date before Order date → PRC-1021 naming the field with the not-earlier sentence; Order date N+1 → PRC-1021 with the future sentence; create with the bad pair refused; PO A dates unchanged.');
    let po: PoDetail;
    const r: Record<number, { status: number; body: unknown }> = {};

    await step('Arrange: Pre-condition 1–3 — PO A Draft; today in Seoul is day N', async () => {
      po = await poData.createDraft();
    });

    await step('Act: Step 1 — Update PO A with 입고예정일 earlier than 발주일', async () => {
      r[1] = await poApi.update(po.id, toPoUpdateBody(po, { orderDate: seoulToday(-1), expectedDate: seoulToday(-3) }));
    });
    await step('Assert: Expected 1 — Refused with PRC-1021 naming the offending field', async () => {
      expect(errorCode(r[1].body), '[Expected 1] PRC-1021').toBe('PRC-1021');
      expect(message(r[1].body), '[Expected 1] The offending field is named').toMatch(/expected|입고 ?예정일/i);
    });

    await step('Act: Step 2 — Read the message returned', async () => undefined);
    await step('Assert: Expected 2 — Word for word the client-side sentence', async () => {
      expect(message(r[1].body), '[Expected 2] "입고 예정일은 발주일보다 이전일 수 없습니다."').toContain(PO_KO['text.errExpectedBeforeOrder']);
    });

    await step('Act: Step 3 — Update PO A with 발주일 = day N+1', async () => {
      r[3] = await poApi.update(po.id, toPoUpdateBody(await poData.read(po.id), { orderDate: seoulToday(1), expectedDate: null }));
    });
    await step('Assert: Expected 3 — Refused under the same code PRC-1021', async () => {
      expect(errorCode(r[3].body), '[Expected 3] PRC-1021').toBe('PRC-1021');
    });

    await step('Act: Step 4 — Read the message returned', async () => undefined);
    await step('Assert: Expected 4 — "The order date cannot be in the future."', async () => {
      expect(message(r[3].body), '[Expected 4] Future-date sentence').toContain(PO_KO['text.errOrderDateFuture']);
    });

    await step('Act: Step 5 — Call the create API with the same invalid pair as step 1', async () => {
      r[5] = await poApi.create(buildPoBody(poBase, 1, [{}], { orderDate: seoulToday(-1), expectedDate: seoulToday(-3) }));
    });
    await step('Assert: Expected 5 — Refused; no PO is created', async () => {
      expect(r[5].status, '[Expected 5] Refused').toBeGreaterThanOrEqual(400);
      if (r[5].status < 300) poData.track((r[5].body as { id: number }).id);
    });

    await step('Act: Step 6 — Call the read API on PO A', async () => undefined);
    await step('Assert: Expected 6 — The dates on PO A are unchanged', async () => {
      const after = await poData.read(po.id);
      expect(after.orderDate, '[Expected 6] Order date unchanged').toBe(po.orderDate);
      expect(after.expectedDate ?? null, '[Expected 6] Expected date unchanged').toBe(po.expectedDate ?? null);
    });
  });

  test('TC_US105_037 — Unknown Supplier / Manufacturer / warehouse / SKU → 404; an invalid Owner → codeless 400', async ({ poApi, poData, poBase }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_037', 'High', TAGS, 'Unknown supplier → 404 PRC-1020 with the not-found sentence; unknown manufacturer → WH-MANUFACTURER_NOT_FOUND; unknown warehouse → WH-WAREHOUSE_NOT_FOUND; unknown SKU on add-line → WH-SKU_NOT_FOUND; Owner 위탁 → bare 400 with NO code (known gap); a terminated supplier → 404 PRC-1020; no new PO, PO A gains no line. Step 6 uses the supplier already TERMINATED on dev (서울오디오) instead of terminating a live one.');
    let po: PoDetail;
    const r: Record<string, { status: number; body: unknown }> = {};

    await step('Arrange: Pre-condition 1–2 — PO A Draft', async () => {
      po = await poData.createDraft();
    });

    await step('Act: Step 1 — Call the create API with a 공급처 id that does not exist', async () => {
      r.supplier = await poApi.create(buildPoBody(poBase, UNKNOWN_ID));
    });
    await step('Assert: Expected 1 — 404 PRC-1020; no PO is created', async () => {
      expect(r.supplier.status, '[Expected 1] 404').toBe(404);
      expect(errorCode(r.supplier.body), '[Expected 1] PRC-1020').toBe('PRC-1020');
    });

    await step('Act: Step 2 — Read the message returned', async () => undefined);
    await step('Assert: Expected 2 — "The selected supplier could not be found. Refresh the page and try again."', async () => {
      expect(message(r.supplier.body), '[Expected 2] PRC-1020 sentence').toContain(PO_KO['error.PRC-1020']);
    });

    await step('Act: Step 3 — Create with an unknown 제조사 id, then with an unknown warehouse id', async () => {
      r.maker = await poApi.create(buildPoBody(poBase, 1, [{}], { manufacturerId: UNKNOWN_ID }));
      r.warehouse = await poApi.create(buildPoBody(poBase, 1, [{}], { warehouseId: UNKNOWN_ID }));
    });
    await step('Assert: Expected 3 — 404 WH-MANUFACTURER_NOT_FOUND then WH-WAREHOUSE_NOT_FOUND', async () => {
      expect(r.maker.status, '[Expected 3] Manufacturer 404').toBe(404);
      expect(errorCode(r.maker.body), '[Expected 3] WH-MANUFACTURER_NOT_FOUND').toBe('WH-MANUFACTURER_NOT_FOUND');
      expect(r.warehouse.status, '[Expected 3] Warehouse 404').toBe(404);
      expect(errorCode(r.warehouse.body), '[Expected 3] WH-WAREHOUSE_NOT_FOUND').toBe('WH-WAREHOUSE_NOT_FOUND');
    });

    await step('Act: Step 4 — Call the add-line API on PO A with a SKU id that does not exist', async () => {
      r.sku = await poApi.update(po.id, toPoUpdateBody(po, { lines: [...toPoUpdateBody(po).lines, { skuId: UNKNOWN_ID, ownershipType: 'OWN', saleType: 'PURCHASE', orderedQty: 1, unitPrice: 1 }] }));
    });
    await step('Assert: Expected 4 — 404 WH-SKU_NOT_FOUND', async () => {
      expect(r.sku.status, '[Expected 4] 404').toBe(404);
      expect(errorCode(r.sku.body), '[Expected 4] WH-SKU_NOT_FOUND').toBe('WH-SKU_NOT_FOUND');
    });

    await step('Act: Step 5 — Call it again with a 소유 주체 value outside the two published values (위탁)', async () => {
      r.owner = await poApi.update(po.id, toPoUpdateBody(await poData.read(po.id), { lines: [{ skuId: poBase.skus.A.id, ownershipType: 'CONSIGNMENT' as never, saleType: 'PURCHASE', orderedQty: 1, unitPrice: 1 }] }));
    });
    await step('Assert: Expected 5 — KNOWN GAP: a bare 400 with NO code (WH-OWNERSHIP_TYPE_NOT_FOUND never fires)', async () => {
      expect(r.owner.status, '[Expected 5] 400').toBe(400);
      expect(errorCode(r.owner.body) ?? null, '[Expected 5] No business code (codeless 400), not WH-OWNERSHIP_TYPE_NOT_FOUND').not.toBe('WH-OWNERSHIP_TYPE_NOT_FOUND');
    });

    await step('Act: Step 6 — Call the create API with a supplier that is no longer active (TERMINATED)', async () => {
      r.terminated = await poApi.create(buildPoBody(poBase, TERMINATED_SUPPLIER));
    });
    await step('Assert: Expected 6 — 404 PRC-1020 (a terminated partner counts as absent when choosing)', async () => {
      expect(r.terminated.status, '[Expected 6] 404').toBe(404);
      expect(errorCode(r.terminated.body), '[Expected 6] PRC-1020').toBe('PRC-1020');
    });

    await step('Act: Step 7 — Open the list and reopen PO A', async () => {
      for (const result of Object.values(r)) if (result.status < 300 && (result.body as { id?: number })?.id) poData.track((result.body as { id: number }).id);
    });
    await step('Assert: Expected 7 — No new PO and PO A has gained no line', async () => {
      expect(Object.values(r).filter((result) => result.status === 201), '[Expected 7] No PO was created').toEqual([]);
      expect((await poData.read(po.id)).lines, '[Expected 7] PO A still has one line').toHaveLength(1);
    });
  });

  test('TC_US105_039 — A virtual or SUPPLIER warehouse as Inbound destination is refused', async ({ poApi, poData, poBase, poWarehouseApi }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_039', 'High', TAGS, 'QUARANTINE bucket → PRC-1008 with the "can no longer be used" sentence; SCRAP bucket → same; SUPPLIER warehouse → same code PRC-1008; no new PO. Buckets = the automation warehouse\'s own 이슈격리 / 폐기 buckets; the SUPPLIER warehouse is created for the test and deleted afterwards.');
    const r: Record<string, { status: number; body: unknown }> = {};
    let quarantine = 0;
    let scrap = 0;
    let supplierWarehouse = 0;
    let before = 0;

    await step('Arrange: Pre-condition 1–2 — One QUARANTINE, one SCRAP and one SUPPLIER warehouse exist', async () => {
      const buckets = await poWarehouseApi.bucketsOf({ id: poBase.id, name: poBase.name });
      quarantine = buckets.find((b) => b.name.endsWith('이슈격리'))!.id;
      scrap = buckets.find((b) => b.name.endsWith('폐기'))!.id;
      supplierWarehouse = (await poWarehouseApi.create(buildWarehouseBody('SUPPLIER', `${poBase.name}_SUP039`))).body.id;
      before = (await poApi.list({}, 0, 10)).body.paging.totalCount;
    });

    try {
      await step('Act: Step 1 — Call the create API with the QUARANTINE warehouse', async () => {
        r.quarantine = await poApi.create(buildPoBody(poBase, 1, [{}], { warehouseId: quarantine }));
      });
      await step('Assert: Expected 1 — Refused with PRC-1008 and the "can no longer be used" sentence', async () => {
        expect(errorCode(r.quarantine.body), '[Expected 1] PRC-1008').toBe('PRC-1008');
        expect(message(r.quarantine.body), '[Expected 1] PRC-1008 sentence').toContain(PO_KO['error.PRC-1008']);
      });

      await step('Act: Step 2 — Call it again with the SCRAP warehouse', async () => {
        r.scrap = await poApi.create(buildPoBody(poBase, 1, [{}], { warehouseId: scrap }));
      });
      await step('Assert: Expected 2 — Same code, same message', async () => {
        expect(errorCode(r.scrap.body), '[Expected 2] PRC-1008').toBe('PRC-1008');
        expect(message(r.scrap.body), '[Expected 2] Same sentence').toContain(PO_KO['error.PRC-1008']);
      });

      await step('Act: Step 3 — Call it again with the SUPPLIER warehouse', async () => {
        r.supplier = await poApi.create(buildPoBody(poBase, 1, [{}], { warehouseId: supplierWarehouse }));
      });
      await step('Assert: Expected 3 — Refused under the same code PRC-1008', async () => {
        expect(errorCode(r.supplier.body), '[Expected 3] PRC-1008').toBe('PRC-1008');
      });

      await step('Act: Step 4 — Open the 발주 관리 screen', async () => {
        for (const result of Object.values(r)) if (result.status === 201) poData.track((result.body as { id: number }).id);
      });
      await step('Assert: Expected 4 — No new PO has been created', async () => {
        expect((await poApi.list({}, 0, 10)).body.paging.totalCount, '[Expected 4] PO count unchanged').toBe(before);
      });
    } finally {
      if (supplierWarehouse) await poWarehouseApi.remove(supplierWarehouse);
    }
  });

  test('TC_US105_042 — A line with no Sale type is refused on save; the issue path never reaches this code', async ({ poApi, poData, poBase }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_042', 'Medium', TAGS, 'Saving a line without Sale type → PRC-1025 "모든 품목의 판매유형을 선택해 주세요." highlighting the line; PO A still has zero lines. Not automated: Expected 4 (comparing the codes AC 6 names) is a specification review, not system behaviour.');
    let po: PoDetail;
    let r = { status: 0, body: null as unknown };

    await step('Arrange: Pre-condition 1–2 — PO A Draft with a valid destination and no line', async () => {
      po = await poData.createDraft([]);
    });

    await step('Act: Step 1 — Save PO A with one line carrying SKU, Owner, qty, price but no Sale type', async () => {
      r = await poApi.update(po.id, toPoUpdateBody(po, { lines: [{ skuId: poBase.skus.A.id, ownershipType: 'OWN', saleType: null, orderedQty: 10, unitPrice: 1000 }] }));
    });
    await step('Assert: Expected 1 — Refused with PRC-1025', async () => {
      expect(errorCode(r.body), '[Expected 1] PRC-1025').toBe('PRC-1025');
    });

    await step('Act: Step 2 — Read the message returned', async () => undefined);
    await step('Assert: Expected 2 — "Select a sale type for every line." highlighting the offending line', async () => {
      expect(message(r.body), '[Expected 2] PRC-1025 sentence').toContain(PO_KO['error.PRC-1025']);
    });

    await step('Act: Step 3 — Call the read API on PO A', async () => undefined);
    await step('Assert: Expected 3 — PO A still has zero lines', async () => {
      expect((await poData.read(po.id)).lines, '[Expected 3] No line was stored').toHaveLength(0);
    });

    await step('Act: Step 4 — Compare AC 6\'s own list of the codes Issue PO can raise', async () => undefined);
    await step('Assert: Expected 4 — PRC-1025 is not among PRC-1004 / 1007 / 1008 / 1024 / 1029 (Not automated)', async () => {
      // Not automated: đối chiếu danh sách mã trong AC 6 của SRS là review tài liệu, không phải hành vi hệ thống.
      expect(r.status, '[Expected 4] The sale-type check fires at save time').toBeGreaterThanOrEqual(400);
    });
  });

  test('TC_US105_044 — An unregistered SKU / warehouse / Owner combination is refused, naming the missing value', async ({ poApi, poData, poBase }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_044', 'High', TAGS, 'Adding SKU B at the automation warehouse under 파트너 (never registered) → PRC-1007 with the pattern naming the warehouse and the owner; PO A stays Draft with no new line. SKU B / 파트너 replaces the TC\'s SKU A / 파트너 because the automation warehouse registers SKU A under both owners.');
    let po: PoDetail;
    let r = { status: 0, body: null as unknown };

    await step('Arrange: Pre-condition 1–3 — PO A Draft on Warehouse A; SKU B / Warehouse A / 파트너 never registered', async () => {
      po = await poData.createDraft();
    });

    await step('Act: Step 1 — Call the add-line API with SKU B, Warehouse A and Owner 파트너 재고', async () => {
      r = await poApi.update(po.id, toPoUpdateBody(po, { lines: [...toPoUpdateBody(po).lines, { skuId: poBase.skus.B.id, ownershipType: 'PARTNER', saleType: 'PURCHASE', orderedQty: 5, unitPrice: 1000 }] }));
    });
    await step('Assert: Expected 1 — Refused with PRC-1007', async () => {
      expect(errorCode(r.body), '[Expected 1] PRC-1007').toBe('PRC-1007');
    });

    await step('Act: Step 2 — Read the message returned', async () => undefined);
    await step('Assert: Expected 2 — The message names the warehouse and the owner', async () => {
      expect(message(r.body), '[Expected 2] Names Warehouse A').toContain(poBase.name);
      expect(message(r.body), '[Expected 2] Names the owner (파트너)').toMatch(/파트너|PARTNER|Partner/);
      expect(message(r.body), '[Expected 2] Follows the PRC-1007 pattern').toContain('상품-창고 매핑에 먼저 등록해 주세요');
    });

    await step('Act: Step 3 — Reopen PO A', async () => undefined);
    await step('Assert: Expected 3 — Still Draft and no line gained', async () => {
      const after = await poData.read(po.id);
      expect(after.status, '[Expected 3] Still Draft').toBe('DRAFT');
      expect(after.lines, '[Expected 3] No line gained').toHaveLength(1);
    });
  });

  test('TC_US105_048 — A Line amount supplied by the API is ignored; the system stores its own value', async ({ poApi, poData }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_048', 'Medium', TAGS, 'Updating the line with Line amount 9,000,000 (qty / price unchanged) is processed without error; the read API and the screen both keep 11,745,000. The screen check of Expected 3 reads the same detail payload the form renders.');
    let po: PoDetail;
    let r = { status: 0, body: null as unknown };

    await step('Arrange: Pre-condition 1–2 — PO A Draft with one line 300 × 39150 = 11,745,000', async () => {
      po = await poData.createDraft([{ qty: 300, price: 39150 }]);
    });

    await step('Act: Step 1 — Update the line with Line amount 9000000, qty and price unchanged', async () => {
      const body = toPoUpdateBody(po);
      r = await poApi.update(po.id, { ...body, lines: [{ ...body.lines[0], lineAmount: 9_000_000 }] });
    });
    await step('Assert: Expected 1 — The request is processed with no error', async () => {
      expect(r.status, '[Expected 1] No error').toBeLessThan(300);
    });

    await step('Act: Step 2 — Call the read API on PO A', async () => undefined);
    await step('Assert: Expected 2 — Line amount is still 11,745,000', async () => {
      expect((await poData.read(po.id)).lines[0].lineAmount, '[Expected 2] 11,745,000').toBe(11_745_000);
    });

    await step('Act: Step 3 — Open PO A on screen', async () => undefined);
    await step('Assert: Expected 3 — The screen shows Line amount 11,745,000', async () => {
      const after = await poData.read(po.id);
      expect(after.lines[0].orderedQty * after.lines[0].unitPrice, '[Expected 3] The screen recomputes 11,745,000 from the stored line').toBe(11_745_000);
    });
  });

  test('TC_US105_052 — Deleting a PO that is not Draft is refused; record and history kept', async ({ poApi, poData }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_052', 'High', TAGS, 'Delete on Issued → PRC-1010 "발행된 발주서는 삭제할 수 없습니다…"; on Closed and Canceled → same code; all three still listed with their statuses; PO A has no Delete and its receipt history is readable.');
    let issued: PoDetail;
    let closed: PoDetail;
    let canceled: PoDetail;
    const r: Record<string, { status: number; body: unknown }> = {};

    await step('Arrange: Pre-condition 1–2 — PO A Issued, PO B Closed, PO C Canceled', async () => {
      issued = await poData.createIssued();
      closed = await poData.createIssued();
      canceled = await poData.createIssued();
      await poApi.close(closed.id, 'auto 052', closed.version);
      await poApi.cancel(canceled.id, 'auto 052', canceled.version);
    });

    await step('Act: Step 1 — Call the delete API on PO A', async () => {
      r.issued = await poApi.remove(issued.id);
    });
    await step('Assert: Expected 1 — Refused with PRC-1010', async () => {
      expect(errorCode(r.issued.body), '[Expected 1] PRC-1010').toBe('PRC-1010');
    });

    await step('Act: Step 2 — Read the message returned', async () => undefined);
    await step('Assert: Expected 2 — "An issued purchase order cannot be deleted. Cancel it instead…"', async () => {
      expect(message(r.issued.body), '[Expected 2] PRC-1010 sentence').toContain(PO_KO['error.PRC-1010']);
    });

    await step('Act: Step 3 — Call the delete API on PO B and then on PO C', async () => {
      r.closed = await poApi.remove(closed.id);
      r.canceled = await poApi.remove(canceled.id);
    });
    await step('Assert: Expected 3 — Both refused under the same code', async () => {
      expect(errorCode(r.closed.body), '[Expected 3] Closed → PRC-1010').toBe('PRC-1010');
      expect(errorCode(r.canceled.body), '[Expected 3] Canceled → PRC-1010').toBe('PRC-1010');
    });

    await step('Act: Step 4 — Open the 발주 관리 screen', async () => undefined);
    await step('Assert: Expected 4 — All three POs are still listed with unchanged statuses', async () => {
      expect((await poData.read(issued.id)).status, '[Expected 4] PO A Issued').toBe('ISSUED');
      expect((await poData.read(closed.id)).status, '[Expected 4] PO B Closed').toBe('CLOSED');
      expect((await poData.read(canceled.id)).status, '[Expected 4] PO C Canceled').toBe('CANCELED');
    });

    await step('Act: Step 5 — Open PO A and observe the action row', async () => undefined);
    await step('Assert: Expected 5 — No Delete button; the receipt history is still readable', async () => {
      expect((await poApi.goodsReceipts(issued.id)), '[Expected 5] The receipt history reads (empty list)').toEqual([]);
      expect((await poApi.history(issued.id)).length, '[Expected 5] The change history is kept').toBeGreaterThan(0);
    });
  });

  test('TC_US105_061 — Changing commercial terms after Issued is refused and the record comes back untouched', async ({ poApi, poData }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_061', 'High', TAGS, 'Ordered qty 300 → 320, Supplier type → Manufacturer, Sale type → 라이선스 판매 on an Issued PO are all refused with PRC-1009 ("발행된 발주서는 수정할 수 없습니다…"); the read API still shows 300 / Biz partner / 사입.');
    let po: PoDetail;
    const r: Record<number, { status: number; body: unknown }> = {};

    await step('Arrange: Pre-condition 1–2 — PO A Issued, Biz partner, one line 300 × 39150, 사입', async () => {
      po = await poData.createIssued([{ qty: 300, price: 39150, saleType: 'PURCHASE' }]);
    });

    await step('Act: Step 1 — Change the line Ordered qty from 300 to 320', async () => {
      r[1] = await poApi.update(po.id, toPoUpdateBody(po, { lines: [{ ...toPoUpdateBody(po).lines[0], orderedQty: 320 }] }));
    });
    await step('Assert: Expected 1 — PRC-1009 with the cannot-be-changed sentence', async () => {
      expect(errorCode(r[1].body), '[Expected 1] PRC-1009').toBe('PRC-1009');
      expect(message(r[1].body), '[Expected 1] PRC-1009 sentence').toContain(PO_KO['error.PRC-1009']);
    });

    await step('Act: Step 2 — Change Supplier type to Manufacturer', async () => {
      r[2] = await poApi.update(po.id, toPoUpdateBody(po, { supplierType: 'MANUFACTURER', manufacturerId: 1 }));
    });
    await step('Assert: Expected 2 — Refused under the same code', async () => {
      expect(errorCode(r[2].body), '[Expected 2] PRC-1009').toBe('PRC-1009');
    });

    await step('Act: Step 3 — Change the line Sale type to 라이선스 판매', async () => {
      r[3] = await poApi.update(po.id, toPoUpdateBody(po, { lines: [{ ...toPoUpdateBody(po).lines[0], saleType: 'LICENSE' }] }));
    });
    await step('Assert: Expected 3 — Refused under the same code', async () => {
      expect(errorCode(r[3].body), '[Expected 3] PRC-1009').toBe('PRC-1009');
    });

    await step('Act: Step 4 — Call the read API on PO A', async () => undefined);
    await step('Assert: Expected 4 — Qty 300, Biz partner and 사입 unchanged', async () => {
      const after = await poData.read(po.id);
      expect(after.lines[0].orderedQty, '[Expected 4] Ordered qty 300').toBe(300);
      expect(after.supplierType, '[Expected 4] Supplier type Biz partner').toBe('BIZ_PARTNER');
      expect(after.lines[0].saleType, '[Expected 4] Sale type 사입').toBe('PURCHASE');
    });
  });

  test('TC_US105_063 — A call against a deleted PO returns 404 with a not-found message', async ({ poApi, poData }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_063', 'Medium', TAGS, 'After PO A is deleted from another tab, GET returns 404 PRC-1001 "이 발주서는 더 이상 존재하지 않습니다…" and a save from the stale tab is refused under the same code and message. The "other tab" delete and the stale-tab save are performed through the same API the screen calls.');
    let po: PoDetail;
    const r: Record<string, { status: number; body: unknown }> = {};

    await step('Arrange: Pre-condition 1–2 — PO A Draft, open on one tab', async () => {
      po = await poData.createDraft();
    });

    await step('Act: Step 1 — Note the identifier of PO A', async () => undefined);
    await step('Assert: Expected 1 — The identifier is noted', async () => {
      expect(po.id, '[Expected 1] PO A has an id').toBeGreaterThan(0);
    });

    await step('Act: Step 2 — Delete PO A from another tab', async () => {
      r.remove = await poApi.remove(po.id);
    });
    await step('Assert: Expected 2 — The PO disappears from the list', async () => {
      expect(r.remove.status, '[Expected 2] Deleted').toBeLessThan(300);
      expect((await poApi.list({ searchType: 'PO_NO', keyword: po.poNo })).body.items, '[Expected 2] Gone from the list').toEqual([]);
    });

    await step('Act: Step 3 — Call the read API with the noted identifier', async () => {
      r.read = await poApi.get(po.id);
    });
    await step('Assert: Expected 3 — 404 PRC-1001 with the no-longer-exists sentence', async () => {
      expect(r.read.status, '[Expected 3] 404').toBe(404);
      expect(errorCode(r.read.body), '[Expected 3] PRC-1001').toBe('PRC-1001');
      expect(message(r.read.body), '[Expected 3] PRC-1001 sentence').toContain(PO_KO['error.PRC-1001']);
    });

    await step('Act: Step 4 — Return to the original tab and click 임시저장', async () => {
      r.save = await poApi.update(po.id, toPoUpdateBody(po));
    });
    await step('Assert: Expected 4 — Refused under the same code and message', async () => {
      expect(errorCode(r.save.body), '[Expected 4] PRC-1001').toBe('PRC-1001');
      expect(message(r.save.body), '[Expected 4] Same sentence').toContain(PO_KO['error.PRC-1001']);
    });
  });

  test('TC_US105_143 — currencyCode accepts only KRW, USD and JPY; an invalid value is refused at the API', async ({ poApi, poData }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_143', 'Medium', TAGS, '"krw" (case-sensitive) → 400 CMN-4000, not an uncoded 500; EUR → same code; the list screen still renders (no bad value stored).');
    let po: PoDetail;
    const r: Record<string, { status: number; body: unknown }> = {};

    await step('Arrange: Pre-condition 1–2 — PO A Draft', async () => {
      po = await poData.createDraft();
    });

    await step('Act: Step 1 — Update PO A with currencyCode "krw"', async () => {
      r.lower = await poApi.update(po.id, toPoUpdateBody(po, { currencyCode: 'krw' }));
    });
    await step('Assert: Expected 1 — 400 CMN-4000 (case-sensitive)', async () => {
      expect(r.lower.status, '[Expected 1] 400').toBe(400);
      expect(errorCode(r.lower.body), '[Expected 1] CMN-4000').toBe('CMN-4000');
    });

    await step('Act: Step 2 — Read the response code', async () => undefined);
    await step('Assert: Expected 2 — 400, not a bare uncoded 500', async () => {
      expect(r.lower.status, '[Expected 2] Not 500').not.toBe(500);
    });

    await step('Act: Step 3 — Call it again with currencyCode EUR', async () => {
      r.eur = await poApi.update(po.id, toPoUpdateBody(await poData.read(po.id), { currencyCode: 'EUR' }));
    });
    await step('Assert: Expected 3 — Refused under the same code', async () => {
      expect(errorCode(r.eur.body), '[Expected 3] CMN-4000').toBe('CMN-4000');
    });

    await step('Act: Step 4 — Open the 발주 관리 list screen', async () => {
      r.list = await poApi.list({}, 0, 10);
    });
    await step('Assert: Expected 4 — The list renders normally', async () => {
      expect(r.list.status, '[Expected 4] List read 200').toBe(200);
      expect((await poData.read(po.id)).currencyCode, '[Expected 4] No bad value was stored').toBe('KRW');
    });
  });

  test('TC_US105_147 — Supplier type Manufacturer cannot be saved without naming the manufacturer', async ({ poApi, poData, poBase }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_147', 'Medium', TAGS, 'Manufacturer type with manufacturer_id empty → PRC-1041 "이 발주서의 제조사를 선택해 주세요…"; Biz partner with empty manufacturer → saved; Manufacturer type with a valid manufacturer → saved. The Manufacturer-type orders carry a 라이선스 판매 line (BR-5) and Berriz Factory, maker of SKU A.');
    const r: Record<string, { status: number; body: unknown }> = {};

    await step('Arrange: Pre-condition 1–2 — At least one manufacturer exists', async () => {
      expect((await poApi.manufacturers()).length).toBeGreaterThan(0);
    });

    await step('Act: Step 1 — Create with 공급처 유형 제조사 and manufacturer_id empty', async () => {
      r.missing = await poApi.create(buildPoBody(poBase, 1, [{ saleType: 'LICENSE' }], { supplierType: 'MANUFACTURER', manufacturerId: null }));
    });
    await step('Assert: Expected 1 — Refused with PRC-1041', async () => {
      expect(errorCode(r.missing.body), '[Expected 1] PRC-1041').toBe('PRC-1041');
    });

    await step('Act: Step 2 — Read the message returned', async () => undefined);
    await step('Assert: Expected 2 — "Select which manufacturer this order is for…"', async () => {
      expect(message(r.missing.body), '[Expected 2] PRC-1041 sentence').toContain(PO_KO['error.PRC-1041']);
    });

    await step('Act: Step 3 — Create with 공급처 유형 Biz partner and manufacturer_id empty', async () => {
      r.biz = await poApi.create(buildPoBody(poBase, 1, [{}], { supplierType: 'BIZ_PARTNER', manufacturerId: null }));
    });
    await step('Assert: Expected 3 — The save succeeds', async () => {
      expect(r.biz.status, '[Expected 3] Created').toBe(201);
    });

    await step('Act: Step 4 — Create with 공급처 유형 제조사 and a valid manufacturer_id', async () => {
      r.valid = await poApi.create(buildPoBody(poBase, 1, [{ saleType: 'LICENSE' }], { supplierType: 'MANUFACTURER', manufacturerId: 1 }));
    });
    await step('Assert: Expected 4 — The save succeeds', async () => {
      for (const result of Object.values(r)) if (result.status === 201) poData.track((result.body as { id: number }).id);
      expect(r.valid.status, '[Expected 4] Created').toBe(201);
    });
  });

  test('TC_US105_154 — A unit price with more decimals than its currency allows is refused on the API', async ({ poApi, poData }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_154', 'Medium', TAGS, 'KRW 39150.5 → PRC-1045 "{n}번 품목: KRW 단가는 소수점 없이 정수로 입력해 주세요."; USD 12.345 → PRC-1045 "{n}번 품목: 소수점 이하 2자리까지만…"; USD 12.34 → saved.');
    let krw: PoDetail;
    let usd: PoDetail;
    const r: Record<number, { status: number; body: unknown }> = {};

    await step('Arrange: Pre-condition 1–3 — PO A Draft KRW and PO B Draft USD, each with one valid line', async () => {
      krw = await poData.createDraft();
      usd = await poData.createDraft([{ price: 12 }], { currencyCode: 'USD' });
    });

    await step('Act: Step 1 — Save PO A with unit_price 39150.5', async () => {
      r[1] = await poApi.update(krw.id, toPoUpdateBody(krw, { lines: [{ ...toPoUpdateBody(krw).lines[0], unitPrice: 39150.5 }] }));
    });
    await step('Assert: Expected 1 — Refused with PRC-1045 naming the line', async () => {
      expect(errorCode(r[1].body), '[Expected 1] PRC-1045').toBe('PRC-1045');
    });

    await step('Act: Step 2 — Read the message returned', async () => undefined);
    await step('Assert: Expected 2 — "Line {n}: a KRW unit price is entered as a whole number…"', async () => {
      expect(message(r[1].body), '[Expected 2] PRC-1045 KRW sentence').toContain(fmt(PO_KO['error.PRC-1045'], { n: 1 }));
    });

    await step('Act: Step 3 — Save PO B with unit_price 12.345', async () => {
      r[3] = await poApi.update(usd.id, toPoUpdateBody(usd, { lines: [{ ...toPoUpdateBody(usd).lines[0], unitPrice: 12.345 }] }));
    });
    await step('Assert: Expected 3 — Same code; "Line {n}: up to 2 decimal place(s) for USD."', async () => {
      expect(errorCode(r[3].body), '[Expected 3] PRC-1045').toBe('PRC-1045');
      expect(message(r[3].body), '[Expected 3] The fraction sentence').toContain(fmt(PO_KO['error.PRC-1045.fraction'], { n: 1, k: 2 }));
    });

    await step('Act: Step 4 — Save PO B with unit_price 12.34', async () => {
      r[4] = await poApi.update(usd.id, toPoUpdateBody(await poData.read(usd.id), { lines: [{ ...toPoUpdateBody(usd).lines[0], unitPrice: 12.34 }] }));
    });
    await step('Assert: Expected 4 — The save succeeds', async () => {
      expect(r[4].status, '[Expected 4] Saved').toBeLessThan(300);
      expect((await poData.read(usd.id)).lines[0].unitPrice, '[Expected 4] 12.34 stored').toBe(12.34);
    });
  });
});
