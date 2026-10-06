import { apiTest as test, expect } from '@fixtures/purchase-order.fixture';
import { makeApiStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { PO_KO, fmt } from '@utils/purchase-order.i18n';
import { errorCode, GrnDetail, newIdempotencyKey, PoApiError, PoDetail, PurchaseOrderApi } from '@api/purchase-order.api';
import { WarehouseApi } from '@api/warehouse.api';
import { buildPoBody, createBaseWarehouse, PoData, seoulToday, SkuKey, toPoUpdateBody } from '@utils/purchase-order.data';
import { hasDbCredentials, purchaseOrderDb } from '@utils/purchase-order-db';

/**
 * API receipt (US105) — tạo / sửa / duyệt / từ chối receipt gọi thẳng API, Idempotency-Key, khoá theo đơn, guard theo
 * trạng thái. 2 danh tính: account chính congnd17.fpt (`poApi`, bypass) và dungbd.fpt (`approverPoApi`). Trạng thái mà API
 * không cho dựng (PO đóng khi còn receipt chờ, đơn sai nhà sản xuất "trước BR-22") được dựng qua MySQL trên PO của kho
 * automation (người dùng cho phép 05/10). Màn hình ở các bước "open on screen" đọc cùng payload detail mà form hiển thị.
 */
const TAGS = ['api', 'purchase-order', 'receipt'];
const OTHER_MANUFACTURER = 1388097789514506241; // "SM 제조사" — không sản xuất SKU STARSHIP_* (lookups/skus, 05/10)

function message(body: unknown): string {
  const error = body as PoApiError;
  return `${error?.message ?? ''} ${error?.detail ?? ''}`;
}

async function receiptOf(api: PurchaseOrderApi, poId: number): Promise<GrnDetail> {
  const [grn] = await api.goodsReceipts(poId);
  return (await api.goodsReceipt(poId, grn.id)).body;
}

async function mappingId(api: WarehouseApi, warehouseId: number, productId: number, owner: string): Promise<number> {
  const { body } = await api.mappingsOf(warehouseId);
  const mapping = body.items.find((m) => m.productId === productId && m.ownershipType === owner);
  if (!mapping) throw new Error(`Test data setup failed — no mapping ${productId}/${owner} on warehouse ${warehouseId}`);
  return mapping.id;
}

/** PO Issued + 1 receipt Exception (290 / 300) do `recorder` ghi. */
async function heldReceipt(poData: PoData, recorder: PurchaseOrderApi, lines: Array<{ sku?: SkuKey; qty: number }> = [{ qty: 300 }]): Promise<{ po: PoDetail; grn: GrnDetail }> {
  const po = await poData.createIssued(lines);
  await poData.receive(po, lines[0].qty - 10, 0, 'ADJ_DISCREPANCY', recorder);
  return { po: await poData.read(po.id), grn: await receiptOf(poData.api, po.id) };
}

test.describe('[API] Goods receipts — create, edit, resolve, reject and their guards', () => {
  test.describe.configure({ timeout: 150_000 });

  test('TC_US105_078 — A replayed request with the same Idempotency-Key is ignored and returns the first receipt', async ({ poApi, approverPoApi, poData }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_078', 'High', TAGS, 'A completed single-SKU receipt created under key K; replaying the SAME request is ignored (PRC-1019 "이 입고 건은 이미 저장되었습니다.") and refers to the same receipt — WH-INCOMING_DUPLICATED does not fire; the receipt still points to the one Incoming record; stock unchanged. The Incoming record is read through the receipt\'s incomingId (no Incoming list API on dev).');
    const po = await poData.createIssued([{ sku: 'C', qty: 50 }]);
    const sku = poData.warehouse.skus.C.id;
    const key = newIdempotencyKey('k078');
    let body: Awaited<ReturnType<PoData['receiptBody']>>;
    let first: GrnDetail;
    let replay = { status: 0, body: null as unknown };
    let baseline = 0;

    await step('Arrange: Pre-condition 1–2 — APPROVER token; one completed receipt created with a known key', async () => {
      body = await poData.receiptBody(po, 50, 0);
      const created = await approverPoApi.createReceipt(po.id, body, key);
      first = (await approverPoApi.goodsReceipt(po.id, (created.body as GrnDetail).id)).body;
    });

    await step('Act: Step 1 — Note the id of the Incoming record and the available stock', async () => {
      baseline = (await poApi.stockOf(sku, poData.warehouse.id)).available;
    });
    await step('Assert: Expected 1 — The record id and the baseline are noted', async () => {
      expect(first.status, '[Expected 1] The first receipt is Complete').toBe('COMPLETE');
      expect(first.incomingId, '[Expected 1] The Incoming record id is noted').toBeTruthy();
    });

    await step('Act: Step 2 — Replay the SAME create-receipt request with the same key', async () => {
      replay = await approverPoApi.createReceipt(po.id, body, key);
    });
    await step('Assert: Expected 2 — Ignored, not refused: the same receipt under PRC-1019; not WH-INCOMING_DUPLICATED', async () => {
      const code = errorCode(replay.body);
      expect(code ?? 'PRC-1019', '[Expected 2] PRC-1019 (or the same receipt returned)').toBe('PRC-1019');
      expect(code, '[Expected 2] WH-INCOMING_DUPLICATED does not fire').not.toBe('WH-INCOMING_DUPLICATED');
      if (!code) expect((replay.body as GrnDetail).id, '[Expected 2] The SAME receipt is returned').toBe(first.id);
      else expect(message(replay.body), '[Expected 2] PRC-1019 sentence').toContain(PO_KO['error.PRC-1019']);
    });

    await step('Act: Step 3 — List the Incoming records of this receipt', async () => undefined);
    await step('Assert: Expected 3 — Exactly one Incoming record, still the id noted at step 1', async () => {
      expect(await poApi.goodsReceipts(po.id), '[Expected 3] Still one receipt').toHaveLength(1);
      expect((await receiptOf(poApi, po.id)).incomingId, '[Expected 3] Same Incoming id').toBe(first.incomingId);
    });

    await step('Act: Step 4 — Check available stock again', async () => undefined);
    await step('Assert: Expected 4 — Stock unchanged from step 1', async () => {
      expect((await poApi.stockOf(sku, poData.warehouse.id)).available, '[Expected 4] Unchanged').toBe(baseline);
    });
  });

  test('TC_US105_079 — A create-receipt call on a PO that is not Issued is refused in every case', async ({ poApi, poData }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_079', 'High', TAGS, 'Draft → PRC-1017; Canceled → same code; Closed → "이 발주서는 종결되었습니다. 추가 입고는 새 발주서를 등록해 주세요."; none of the three gains a receipt or changes status.');
    let draft: PoDetail;
    let canceled: PoDetail;
    let closed: PoDetail;
    const r: Record<string, { status: number; body: unknown }> = {};

    await step('Arrange: Pre-condition 1–2 — PO A Draft, PO B Canceled, PO C Closed', async () => {
      draft = await poData.createDraft();
      canceled = await poData.createIssued();
      closed = await poData.createIssued();
      await poApi.cancel(canceled.id, 'auto 079', canceled.version);
      await poApi.close(closed.id, 'auto 079', closed.version);
    });

    for (const [n, key, label] of [[1, 'draft', 'PO A'], [2, 'canceled', 'PO B'], [3, 'closed', 'PO C']] as const) {
      await step(`Act: Step ${n} — Call the create-receipt API on ${label}`, async () => {
        const po = { draft, canceled, closed }[key];
        r[key] = await poApi.createReceipt(po.id, await poData.receiptBody(po, 10, 0));
      });
      await step(`Assert: Expected ${n} — Refused${n === 3 ? ' with the closed-order sentence' : ' with PRC-1017'}`, async () => {
        expect(errorCode(r[key].body), `[Expected ${n}] PRC-1017`).toBe('PRC-1017');
        if (n === 3) expect(message(r[key].body), '[Expected 3] PRC-1017 sentence').toContain(PO_KO['error.PRC-1017']);
      });
    }

    await step('Act: Step 4 — Open all three POs on screen in turn', async () => undefined);
    await step('Assert: Expected 4 — No receipt gained and no status changed', async () => {
      for (const [po, status] of [[draft, 'DRAFT'], [canceled, 'CANCELED'], [closed, 'CLOSED']] as const) {
        expect(await poApi.goodsReceipts(po.id), `[Expected 4] ${po.poNo} has no receipt`).toEqual([]);
        expect((await poData.read(po.id)).status, `[Expected 4] ${po.poNo} still ${status}`).toBe(status);
      }
    });
  });

  test('TC_US105_086 — Resolving a Complete receipt is refused with PRC-1013', async ({ poApi, approverPoApi, poData }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_086', 'Medium', TAGS, 'Resolve on a Complete receipt (200) → PRC-1013 "이 입고 건은 이미 완료되어 수정할 수 없습니다. 재고 조정으로 처리해 주세요."; Received qty stays 200; the row stays Complete. Not automated: the View-vs-Resolve link text of step 4 (API test; covered by TC_US105_017 / 138 on screen).');
    const po = await poData.createIssued([{ qty: 200 }]);
    let grn: GrnDetail;
    let r = { status: 0, body: null as unknown };

    await step('Arrange: Pre-condition 1–2 — APPROVER token; Receipt A Complete with Received qty 200', async () => {
      await poData.receive(po, 200, 0);
      grn = await receiptOf(poApi, po.id);
    });

    await step('Act: Step 1 — Call the resolve-discrepancy API on Receipt A', async () => {
      r = await approverPoApi.resolveReceipt(po.id, grn.id, 'ADJ_DISCREPANCY', null, grn.version);
    });
    await step('Assert: Expected 1 — PRC-1013 with its sentence (resolve branch only)', async () => {
      expect(errorCode(r.body), '[Expected 1] PRC-1013').toBe('PRC-1013');
      expect(message(r.body), '[Expected 1] PRC-1013 sentence').toContain(PO_KO['error.PRC-1013']);
    });

    await step('Act: Step 2 — Read the message returned', async () => undefined);
    await step('Assert: Expected 2 — Received qty is still 200', async () => {
      expect((await receiptOf(poApi, po.id)).receivedQty, '[Expected 2] 200').toBe(200);
    });

    await step('Act: Step 3 — Call the read API on the receipt', async () => undefined);
    await step('Assert: Expected 3 — Received qty is unchanged', async () => {
      expect((await receiptOf(poApi, po.id)).version, '[Expected 3] Not written').toBe(grn.version);
    });

    await step('Act: Step 4 — Open the PO holding that receipt and observe its row', async () => undefined);
    await step('Assert: Expected 4 — The row carries a Complete badge (View link: Not automated here)', async () => {
      expect((await poApi.goodsReceipts(po.id))[0].status, '[Expected 4] COMPLETE').toBe('COMPLETE');
    });
  });

  test('TC_US105_097 — When the stock layer refuses, the receipt stays in Exception and nothing is written', async ({ poApi, approverPoApi, poData, poWarehouseApi }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_097', 'High', TAGS, 'With the line mapping deactivated after the receipt was created, resolving is refused with WH-INCOMING_INVALID "이 입고 건의 재고 반영이 거부되었습니다…"; the receipt stays Exception, stock unchanged, no Incoming record; the row keeps its Exception badge and Resolve link. Known gap reported 17/09: resolve() does not re-check the mapping. SKU C mapping is reactivated afterwards.');
    const sku = poData.warehouse.skus.C.id;
    let po: PoDetail;
    let grn: GrnDetail;
    let id = 0;
    let baseline = 0;
    let r = { status: 0, body: null as unknown };

    try {
      await step('Arrange: Pre-condition 1–3 — PO A Issued with one Exception receipt; the line mapping deactivated afterwards', async () => {
        ({ po, grn } = await heldReceipt(poData, poApi, [{ sku: 'C', qty: 300 }]));
        id = await mappingId(poWarehouseApi, poData.warehouse.id, sku, 'OWN');
        await poWarehouseApi.deactivateMapping(id);
      });

      await step('Act: Step 1 — Note the current available stock', async () => {
        baseline = (await poApi.stockOf(sku, poData.warehouse.id)).available;
      });
      await step('Assert: Expected 1 — The baseline figure is noted', async () => {
        expect(baseline, '[Expected 1] Baseline').toBeGreaterThanOrEqual(0);
      });

      await step('Act: Step 2 — Call the resolve-discrepancy API to complete the receipt', async () => {
        r = await approverPoApi.resolveReceipt(po.id, grn.id, 'ADJ_DISCREPANCY', null, grn.version);
      });
      await step('Assert: Expected 2 — WH-INCOMING_INVALID with its sentence', async () => {
        expect(errorCode(r.body), '[Expected 2] WH-INCOMING_INVALID').toBe('WH-INCOMING_INVALID');
        expect(message(r.body), '[Expected 2] Sentence').toContain(PO_KO['error.WH-INCOMING_INVALID']);
      });

      await step('Act: Step 3 — Check the receipt status and stock', async () => undefined);
      await step('Assert: Expected 3 — Still Exception, stock unchanged, no Incoming record', async () => {
        const after = await receiptOf(poApi, po.id);
        expect(after.status, '[Expected 3] EXCEPTION').toBe('EXCEPTION');
        expect(after.incomingId ?? null, '[Expected 3] No Incoming record').toBeNull();
        expect((await poApi.stockOf(sku, poData.warehouse.id)).available, '[Expected 3] Stock unchanged').toBe(baseline);
      });

      await step('Act: Step 4 — Open PO A on screen', async () => undefined);
      await step('Assert: Expected 4 — The row still carries the Exception badge and its Resolve link', async () => {
        expect((await poApi.goodsReceipts(po.id))[0].status, '[Expected 4] EXCEPTION').toBe('EXCEPTION');
      });
    } finally {
      if (id) await poWarehouseApi.reactivateMapping(id);
    }
  });

  test('TC_US105_120 — The inbound-layer backstop for an order with a mismatched manufacturer', async ({ poApi, approverPoApi, poData }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_120', 'Medium', TAGS, 'An Issued PO naming manufacturer M1 with a line of a SKU made by M2 (built by writing purchase_order.manufacturer_id directly — the form path is blocked by PRC-1029); resolving its Exception receipt is refused with WH-MANUFACTURER_DIFFERENT "이 상품의 제조사가 발주서에 지정된 제조사와 다릅니다…"; receipt stays Exception, stock unchanged, no Incoming record.');
    test.skip(!hasDbCredentials(), 'MySQL credentials (DB_*) are not configured in .env — the mismatched order cannot be built');
    const sku = poData.warehouse.skus.A.id;
    let held: { po: PoDetail; grn: GrnDetail };
    let baseline = 0;
    let r = { status: 0, body: null as unknown };

    await step('Arrange: Pre-condition 1–3 — PO A Issued with manufacturer ≠ the SKU maker; one Exception receipt', async () => {
      held = await heldReceipt(poData, poApi);
      await purchaseOrderDb.setManufacturer(held.po.id, OTHER_MANUFACTURER);
    });

    await step('Act: Step 1 — Note the available stock', async () => {
      baseline = (await poApi.stockOf(sku, poData.warehouse.id)).available;
    });
    await step('Assert: Expected 1 — The baseline figure is noted', async () => {
      expect((await poData.read(held.po.id)).manufacturerId, '[Expected 1] The order names the other manufacturer').toBe(OTHER_MANUFACTURER);
    });

    await step('Act: Step 2 — Call the API to complete the receipt', async () => {
      const fresh = await receiptOf(poApi, held.po.id);
      r = await approverPoApi.resolveReceipt(held.po.id, fresh.id, 'ADJ_DISCREPANCY', null, fresh.version);
    });
    await step('Assert: Expected 2 — WH-MANUFACTURER_DIFFERENT with its sentence', async () => {
      expect(errorCode(r.body), '[Expected 2] WH-MANUFACTURER_DIFFERENT').toBe('WH-MANUFACTURER_DIFFERENT');
      expect(message(r.body), '[Expected 2] Sentence').toContain(PO_KO['error.WH-MANUFACTURER_DIFFERENT']);
    });

    await step('Act: Step 3 — Check the receipt status and stock', async () => undefined);
    await step('Assert: Expected 3 — Still Exception and stock unchanged', async () => {
      expect((await receiptOf(poApi, held.po.id)).status, '[Expected 3] EXCEPTION').toBe('EXCEPTION');
      expect((await poApi.stockOf(sku, poData.warehouse.id)).available, '[Expected 3] Unchanged').toBe(baseline);
    });

    await step('Act: Step 4 — Check the Incoming records', async () => undefined);
    await step('Assert: Expected 4 — No Incoming record is created', async () => {
      expect((await receiptOf(poApi, held.po.id)).incomingId ?? null, '[Expected 4] No Incoming').toBeNull();
      await purchaseOrderDb.setManufacturer(held.po.id, null);
    });
  });

  test('TC_US105_121 — Saving a receipt is blocked when the mapping was deactivated after the issue', async ({ poApi, poData, poWarehouseApi }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_121', 'High', TAGS, 'Mapping SKU C / Warehouse A / 자사 deactivated after issue; the create-receipt call is refused with PRC-1007 naming the warehouse and the owner; no receipt row, no Incoming, stock unchanged. Known permanent gap (OQ-20 → US032): the inbound layer carries no owner field, so the Owner half passes unverified. Mapping reactivated afterwards.');
    const po = await poData.createIssued([{ sku: 'C', qty: 100 }]);
    const sku = poData.warehouse.skus.C.id;
    const id = await mappingId(poWarehouseApi, poData.warehouse.id, sku, 'OWN');
    let baseline = 0;
    let r = { status: 0, body: null as unknown };

    try {
      await step('Arrange: Pre-condition 1–3 — PO A Issued on Warehouse A with SKU C / 자사; no receipt', async () => undefined);

      await step('Act: Step 1 — Note the available stock', async () => {
        baseline = (await poApi.stockOf(sku, poData.warehouse.id)).available;
      });
      await step('Assert: Expected 1 — The baseline figure is noted', async () => {
        expect(baseline, '[Expected 1] Baseline').toBeGreaterThanOrEqual(0);
      });

      await step('Act: Step 2 — Have an administrator deactivate the mapping', async () => {
        await poWarehouseApi.deactivateMapping(id);
      });
      await step('Assert: Expected 2 — The mapping becomes inactive; PO A still Issued', async () => {
        expect((await poWarehouseApi.mappingsOf(poData.warehouse.id)).body.items.find((m) => m.id === id)?.status, '[Expected 2] INACTIVE').toBe('INACTIVE');
        expect((await poData.read(po.id)).status, '[Expected 2] Issued').toBe('ISSUED');
      });

      await step('Act: Step 3 — Call the API to save a goods receipt with a valid quantity', async () => {
        r = await poApi.createReceipt(po.id, await poData.receiptBody(po, 100, 0));
      });
      await step('Assert: Expected 3 — Refused with PRC-1007', async () => {
        expect(errorCode(r.body), '[Expected 3] PRC-1007').toBe('PRC-1007');
      });

      await step('Act: Step 4 — Read the message returned', async () => undefined);
      await step('Assert: Expected 4 — The message names the warehouse and the owner', async () => {
        expect(message(r.body), '[Expected 4] Names Warehouse A').toContain(poData.warehouse.name);
        expect(message(r.body), '[Expected 4] Names the owner').toMatch(/자사|OWN|Own/);
      });

      await step('Act: Step 5 — Check the receipt row, the Incoming record and stock', async () => undefined);
      await step('Assert: Expected 5 — No receipt, no Incoming, stock unchanged', async () => {
        expect(await poApi.goodsReceipts(po.id), '[Expected 5] No receipt').toEqual([]);
        expect((await poApi.stockOf(sku, poData.warehouse.id)).available, '[Expected 5] Stock unchanged').toBe(baseline);
      });
    } finally {
      await poWarehouseApi.reactivateMapping(id);
    }
  });

  test('TC_US105_130 — A reason code not resolving to an active US062 row is refused on write only', async ({ poApi, approverPoApi, poData }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_130', 'Medium', TAGS, 'Create with an unknown discrepancy code → PRC-1037 "유효하지 않은 차이 사유 코드입니다…"; resolve with the same code → same code. Not automated: steps 3–4 (a receipt filed under a code deactivated later) — deactivating a US062 reason would change the shared master for every user.');
    const po = await poData.createIssued([{ qty: 300 }]);
    const r: Record<string, { status: number; body: unknown }> = {};
    let held: { po: PoDetail; grn: GrnDetail };

    await step('Arrange: Pre-condition 1–3 — PO A Issued 300; an Exception receipt for the resolve call', async () => {
      held = await heldReceipt(poData, poApi);
    });

    await step('Act: Step 1 — Call the save API with a discrepancy reason code that does not exist', async () => {
      r.create = await poApi.createReceipt(po.id, await poData.receiptBody(po, 290, 0, 'NOT_A_REASON'));
    });
    await step('Assert: Expected 1 — PRC-1037 with its sentence; nothing stored', async () => {
      expect(errorCode(r.create.body), '[Expected 1] PRC-1037').toBe('PRC-1037');
      expect(message(r.create.body), '[Expected 1] Sentence').toContain(PO_KO['error.PRC-1037']);
      expect(await poApi.goodsReceipts(po.id), '[Expected 1] Nothing stored').toEqual([]);
    });

    await step('Act: Step 2 — Call the resolve API on an Exception receipt with the same invalid code', async () => {
      r.resolve = await approverPoApi.resolveReceipt(held.po.id, held.grn.id, 'NOT_A_REASON', null, held.grn.version);
    });
    await step('Assert: Expected 2 — Refused under the same code', async () => {
      expect(errorCode(r.resolve.body), '[Expected 2] PRC-1037').toBe('PRC-1037');
    });

    await step('Act: Step 3 — Open Receipt B (filed under a since-deactivated code) on screen', async () => undefined);
    await step('Assert: Expected 3 — Not automated (shared US062 master)', async () => {
      expect((await receiptOf(poApi, held.po.id)).discrepancyReasonCode, '[Expected 3] Reading a receipt returns its stored code').toBe('ADJ_DISCREPANCY');
    });

    await step('Act: Step 4 — Call the read API on Receipt B', async () => undefined);
    await step('Assert: Expected 4 — Reading never re-runs the active-row test', async () => {
      expect((await poApi.goodsReceipt(held.po.id, held.grn.id)).status, '[Expected 4] The read succeeds').toBe(200);
    });
  });

  test('TC_US105_132 — grn_source is stamped by the server and never accepted as a request field', async ({ poApi, poData }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_132', 'Medium', TAGS, 'A create without a source field is accepted and stored MANUAL; a create declaring source LOGISTICS is ignored — stored MANUAL and the BR-25 attachment rule still applies (PRC-1031 when no document); an update trying LOGISTICS is refused or ignored. The stored source is read from goods_receipt.source.');
    test.skip(!hasDbCredentials(), 'MySQL credentials (DB_*) are not configured in .env — the stored source cannot be read');
    const po = await poData.createIssued([{ qty: 300 }]);
    const r: Record<string, { status: number; body: unknown }> = {};

    await step('Arrange: Pre-condition 1–2 — PO A Issued with quantity outstanding', async () => undefined);

    await step('Act: Step 1 — Call the create-receipt API with valid data and no source field', async () => {
      r.plain = await poApi.createReceipt(po.id, await poData.receiptBody(po, 100, 0, 'ADJ_DISCREPANCY'));
    });
    await step('Assert: Expected 1 — The request is accepted', async () => {
      expect(r.plain.status, '[Expected 1] 201').toBe(201);
    });

    await step('Act: Step 2 — Read the stored source field', async () => undefined);
    await step('Assert: Expected 2 — The stored source is MANUAL', async () => {
      expect(await purchaseOrderDb.receiptSource((r.plain.body as GrnDetail).id), '[Expected 2] MANUAL').toBe('MANUAL');
    });

    await step('Act: Step 3 — Call the create-receipt API again with source LOGISTICS and no attachment', async () => {
      const other = await poData.createIssued([{ qty: 300 }]);
      r.logistics = await poApi.createReceipt(other.id, { ...(await poData.receiptBody(other, 300, 0)), attachments: [], source: 'LOGISTICS', grnSource: 'LOGISTICS' });
    });
    await step('Assert: Expected 3 — The extra field is IGNORED, not honoured', async () => {
      expect(errorCode(r.logistics.body), '[Expected 3] The LOGISTICS declaration does not lift the document rule').toBe('PRC-1031');
    });

    await step('Act: Step 4 — Read the stored source and check whether BR-25 was skipped', async () => undefined);
    await step('Assert: Expected 4 — Still MANUAL; the attachment requirement applies in full', async () => {
      expect(message(r.logistics.body), '[Expected 4] PRC-1031 sentence').toContain(PO_KO['error.PRC-1031']);
    });

    await step('Act: Step 5 — Call the update API on the same receipt trying to change source to LOGISTICS', async () => {
      const grn = (await poApi.goodsReceipt(po.id, (r.plain.body as GrnDetail).id)).body;
      r.update = await poApi.updateReceipt(po.id, grn.id, { receivedDate: grn.receivedDate, discrepancyReasonCode: grn.discrepancyReasonCode, discrepancyReason: grn.discrepancyReason, attachments: grn.attachments, lines: grn.lines.map((l) => ({ purchaseOrderLineId: l.purchaseOrderLineId, receivedQty: l.receivedQty, damagedQty: l.damagedQty })), version: grn.version, source: 'LOGISTICS' });
    });
    await step('Assert: Expected 5 — Refused or ignored; the field never changes', async () => {
      expect(await purchaseOrderDb.receiptSource((r.plain.body as GrnDetail).id), '[Expected 5] Still MANUAL').toBe('MANUAL');
    });
  });

  test('TC_US105_134 — Edit and Reject are refused by identity or by state under distinct codes', async ({ poApi, approverPoApi, poData }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_134', 'High', TAGS, 'Edit by a non-recorder → PRC-1033; edit of a Complete or Rejected receipt by its recorder → PRC-1034; reject of a Complete or Rejected receipt → PRC-1034. Operator 1 = congnd17.fpt (records), APPROVER = dungbd.fpt.');
    const r: Record<number, { status: number; body: unknown }> = {};
    let a: { po: PoDetail; grn: GrnDetail };
    let b: { po: PoDetail; grn: GrnDetail };
    let c: { po: PoDetail; grn: GrnDetail };
    const editBody = (grn: GrnDetail) => ({ receivedDate: grn.receivedDate, discrepancyReasonCode: grn.discrepancyReasonCode, discrepancyReason: grn.discrepancyReason, attachments: grn.attachments, lines: grn.lines.map((l) => ({ purchaseOrderLineId: l.purchaseOrderLineId, receivedQty: l.receivedQty, damagedQty: l.damagedQty })), version: grn.version });

    await step('Arrange: Pre-condition 1–2 — Receipt A Exception, Receipt B Complete, Receipt C Rejected (recorded by Operator 1)', async () => {
      a = await heldReceipt(poData, poApi);
      const poB = await poData.createIssued([{ qty: 100 }]);
      await poData.receive(poB, 100, 0);
      b = { po: poB, grn: await receiptOf(poApi, poB.id) };
      c = await heldReceipt(poData, poApi);
      await approverPoApi.rejectReceipt(c.po.id, c.grn.id, 'ADJ_DISCREPANCY', 'auto 134', c.grn.version);
      c.grn = await receiptOf(poApi, c.po.id);
    });

    await step('Act: Step 1 — With the APPROVER token, call the edit API on Receipt A', async () => {
      r[1] = await approverPoApi.updateReceipt(a.po.id, a.grn.id, editBody(a.grn));
    });
    await step('Assert: Expected 1 — PRC-1033 with its sentence', async () => {
      expect(errorCode(r[1].body), '[Expected 1] PRC-1033').toBe('PRC-1033');
      expect(message(r[1].body), '[Expected 1] Sentence').toContain(PO_KO['error.PRC-1033']);
    });

    await step('Act: Step 2 — With Operator 1\'s token, call the edit API on Receipt B', async () => {
      r[2] = await poApi.updateReceipt(b.po.id, b.grn.id, editBody(b.grn));
    });
    await step('Assert: Expected 2 — PRC-1034 with its sentence', async () => {
      expect(errorCode(r[2].body), '[Expected 2] PRC-1034').toBe('PRC-1034');
      expect(message(r[2].body), '[Expected 2] Sentence').toContain(PO_KO['error.PRC-1034']);
    });

    await step('Act: Step 3 — With Operator 1\'s token, call the edit API on Receipt C', async () => {
      r[3] = await poApi.updateReceipt(c.po.id, c.grn.id, editBody(c.grn));
    });
    await step('Assert: Expected 3 — Refused under the same code PRC-1034', async () => {
      expect(errorCode(r[3].body), '[Expected 3] PRC-1034').toBe('PRC-1034');
    });

    await step('Act: Step 4 — With the APPROVER token, call the reject API on Receipt B', async () => {
      r[4] = await approverPoApi.rejectReceipt(b.po.id, b.grn.id, 'ADJ_DISCREPANCY', 'auto 134', b.grn.version);
    });
    await step('Assert: Expected 4 — Refused under PRC-1034', async () => {
      expect(errorCode(r[4].body), '[Expected 4] PRC-1034').toBe('PRC-1034');
    });

    await step('Act: Step 5 — With the APPROVER token, call the reject API on Receipt C', async () => {
      r[5] = await approverPoApi.rejectReceipt(c.po.id, c.grn.id, 'ADJ_DISCREPANCY', 'auto 134', c.grn.version);
    });
    await step('Assert: Expected 5 — Refused under PRC-1034 as well', async () => {
      expect(errorCode(r[5].body), '[Expected 5] PRC-1034').toBe('PRC-1034');
    });
  });

  test('TC_US105_137 — A second receipt is refused while one is held; the lock is per ORDER', async ({ poApi, approverPoApi, poData }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_137', 'High', TAGS, 'With an Exception receipt on the SKU X line, a receipt naming only the SKU Y line is refused with PRC-1035 naming the blocking GRN ("처리 대기 중인 입고 건({grn_no})이 있어 새 입고를 등록할 수 없습니다…"); once the held receipt is resolved the lock lifts and the second call succeeds.');
    let po: PoDetail;
    let held: GrnDetail;
    const r: Record<number, { status: number; body: unknown }> = {};
    const yBody = async () => ({ ...(await poData.receiptBody(po, 50, 0)), lines: [{ purchaseOrderLineId: po.lines[1].id, receivedQty: 50, damagedQty: 0 }] });

    await step('Arrange: Pre-condition 1–2 — PO A Issued with lines SKU X and SKU Y; an Exception receipt on X alone', async () => {
      po = await poData.createIssued([{ sku: 'A', qty: 300 }, { sku: 'B', qty: 50 }]);
      await poData.receive(po, 290, 0, 'ADJ_DISCREPANCY');
      held = await receiptOf(poApi, po.id);
    });

    await step('Act: Step 1 — Call the create-receipt API naming only the SKU Y line', async () => {
      r[1] = await poApi.createReceipt(po.id, await yBody());
    });
    await step('Assert: Expected 1 — Refused with PRC-1035 even though the button was bypassed', async () => {
      expect(errorCode(r[1].body), '[Expected 1] PRC-1035').toBe('PRC-1035');
    });

    await step('Act: Step 2 — Read the message returned', async () => undefined);
    await step('Assert: Expected 2 — The message names the blocking GRN', async () => {
      expect(message(r[1].body), '[Expected 2] Names the GRN').toContain(fmt(PO_KO['error.PRC-1035'], { grn_no: held.grnNo }));
    });

    await step('Act: Step 3 — Have an approver resolve the SKU X receipt', async () => {
      r[3] = await approverPoApi.resolveReceipt(po.id, held.id, 'ADJ_DISCREPANCY', null, held.version);
    });
    await step('Assert: Expected 3 — The held receipt is resolved and the lock lifts', async () => {
      expect(r[3].status, '[Expected 3] Resolved').toBeLessThan(300);
    });

    await step('Act: Step 4 — Call the create-receipt API for SKU Y again', async () => {
      r[4] = await poApi.createReceipt(po.id, await yBody());
    });
    await step('Assert: Expected 4 — The second call now succeeds', async () => {
      expect(r[4].status, '[Expected 4] 201').toBe(201);
    });
  });

  test('TC_US105_139 — A held receipt can still be Edited or Rejected after its PO was Closed', async ({ poApi, approverPoApi, poData }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_139', 'Medium', TAGS, 'PO A Closed while its receipt is still Exception (the Close-PO guard PRC-1042 forbids this through the API, so the state is built by writing purchase_order.status = CLOSED); edit by the recorder succeeds; reject by the approver succeeds on a fresh scenario built the same way; neither moves stock.');
    test.skip(!hasDbCredentials(), 'MySQL credentials (DB_*) are not configured in .env — the closed-with-held-receipt state cannot be built');
    const sku = poData.warehouse.skus.A.id;
    let first: { po: PoDetail; grn: GrnDetail };
    let second: { po: PoDetail; grn: GrnDetail };
    let baseline = 0;
    const r: Record<number, { status: number; body: unknown }> = {};

    await step('Arrange: Pre-condition 1–2 — PO A Issued → receipt Exception → PO A closed with a reason (receipt still held)', async () => {
      first = await heldReceipt(poData, poApi);
      second = await heldReceipt(poData, poApi);
      for (const held of [first, second]) await purchaseOrderDb.forceStatus(held.po.id, 'CLOSED');
      baseline = (await poApi.stockOf(sku, poData.warehouse.id)).available;
    });

    await step('Act: Step 1 — Confirm PO A is Closed while its receipt is still Exception', async () => undefined);
    await step('Assert: Expected 1 — PO A Closed; receipt Exception', async () => {
      expect((await poData.read(first.po.id)).status, '[Expected 1] CLOSED').toBe('CLOSED');
      expect((await receiptOf(poApi, first.po.id)).status, '[Expected 1] EXCEPTION').toBe('EXCEPTION');
    });

    await step('Act: Step 2 — Call the Edit API as the receipt\'s received_by, correcting the quantity', async () => {
      const grn = await receiptOf(poApi, first.po.id);
      r[2] = await poApi.updateReceipt(first.po.id, grn.id, { receivedDate: grn.receivedDate, discrepancyReasonCode: grn.discrepancyReasonCode, discrepancyReason: grn.discrepancyReason, attachments: grn.attachments, lines: [{ purchaseOrderLineId: grn.lines[0].purchaseOrderLineId, receivedQty: 280, damagedQty: 0 }], version: grn.version });
    });
    await step('Assert: Expected 2 — The edit succeeds (gated on the receipt state only)', async () => {
      expect(r[2].status, '[Expected 2] Edited').toBeLessThan(300);
    });

    await step('Act: Step 3 — Call the Reject API as the approver on a fresh scenario', async () => {
      const grn = await receiptOf(poApi, second.po.id);
      r[3] = await approverPoApi.rejectReceipt(second.po.id, grn.id, 'ADJ_DISCREPANCY', 'auto 139', grn.version);
    });
    await step('Assert: Expected 3 — The reject succeeds as well', async () => {
      expect(r[3].status, '[Expected 3] Rejected').toBeLessThan(300);
    });

    await step('Act: Step 4 — Check what moved in stock', async () => undefined);
    await step('Assert: Expected 4 — Neither call moves any stock', async () => {
      expect((await poApi.stockOf(sku, poData.warehouse.id)).available, '[Expected 4] Unchanged').toBe(baseline);
      for (const held of [first, second]) await purchaseOrderDb.forceStatus(held.po.id, 'ISSUED');
    });
  });

  test('TC_US105_140 — A Rejected receipt does not block Cancel PO; gapQty / gapAmount absent, not zero', async ({ poApi, approverPoApi, poData }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_140', 'Medium', TAGS, 'PO A whose only receipt was Rejected: gapQty and gapAmount absent from the read; Cancel PO accepted and the PO is Canceled; PO B with an Exception receipt → Cancel refused with PRC-1005.');
    let poA: PoDetail;
    let detail: Record<string, unknown> = {};
    const r: Record<number, { status: number; body: unknown }> = {};

    await step('Arrange: Pre-condition 1–2 — PO A Issued; its only receipt Rejected', async () => {
      const held = await heldReceipt(poData, poApi);
      await approverPoApi.rejectReceipt(held.po.id, held.grn.id, 'ADJ_DISCREPANCY', 'auto 140 wrong PO', held.grn.version);
      poA = await poData.read(held.po.id);
    });

    await step('Act: Step 1 — Call the read API on PO A and inspect gapQty and gapAmount', async () => {
      detail = (await poApi.get<Record<string, unknown>>(poA.id)).body;
    });
    await step('Assert: Expected 1 — Both fields ABSENT, not 0', async () => {
      expect(detail, '[Expected 1] gapQty absent').not.toHaveProperty('gapQty');
      expect(detail, '[Expected 1] gapAmount absent').not.toHaveProperty('gapAmount');
    });

    await step('Act: Step 2 — Call the Cancel PO API on PO A with a reason', async () => {
      r[2] = await poApi.cancel(poA.id, 'auto 140 cancel', poA.version);
    });
    await step('Assert: Expected 2 — The cancellation is accepted', async () => {
      expect(r[2].status, '[Expected 2] Accepted').toBeLessThan(300);
    });

    await step('Act: Step 3 — Check the resulting status', async () => undefined);
    await step('Assert: Expected 3 — PO A is Canceled', async () => {
      expect((await poData.read(poA.id)).status, '[Expected 3] CANCELED').toBe('CANCELED');
    });

    await step('Act: Step 4 — Build PO B with an EXCEPTION receipt and call Cancel PO on it', async () => {
      const held = await heldReceipt(poData, poApi);
      r[4] = await poApi.cancel(held.po.id, 'auto 140', held.po.version);
    });
    await step('Assert: Expected 4 — Refused with PRC-1005', async () => {
      expect(errorCode(r[4].body), '[Expected 4] PRC-1005').toBe('PRC-1005');
    });
  });

  test('TC_US105_141 — Close PO is refused while the order holds a receipt awaiting a decision', async ({ poApi, approverPoApi, poData }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_141', 'Medium', TAGS, 'Close on a PO with an Exception receipt → PRC-1042 naming the GRN ("처리 대기 중인 입고 건({grn_no})이 있어 이 발주서를 종결할 수 없습니다…"), order stays Issued; after the receipt is resolved the same close succeeds.');
    let held: { po: PoDetail; grn: GrnDetail };
    const r: Record<number, { status: number; body: unknown }> = {};

    await step('Arrange: Pre-condition 1–2 — PO A Issued with an Exception receipt; GRN noted', async () => {
      held = await heldReceipt(poData, poApi);
    });

    await step('Act: Step 1 — Call the Close PO API with a reason', async () => {
      r[1] = await poApi.close(held.po.id, 'auto 141', held.po.version);
    });
    await step('Assert: Expected 1 — PRC-1042; the order stays Issued', async () => {
      expect(errorCode(r[1].body), '[Expected 1] PRC-1042').toBe('PRC-1042');
      expect((await poData.read(held.po.id)).status, '[Expected 1] ISSUED').toBe('ISSUED');
    });

    await step('Act: Step 2 — Read the message returned', async () => undefined);
    await step('Assert: Expected 2 — The message names the blocking GRN', async () => {
      expect(message(r[1].body), '[Expected 2] Sentence with the GRN').toContain(fmt(PO_KO['error.PRC-1042'], { grn_no: held.grn.grnNo }));
    });

    await step('Act: Step 3 — Have an approver resolve the held receipt', async () => {
      r[3] = await approverPoApi.resolveReceipt(held.po.id, held.grn.id, 'ADJ_DISCREPANCY', null, held.grn.version);
    });
    await step('Assert: Expected 3 — The receipt moves to Complete', async () => {
      expect((await receiptOf(poApi, held.po.id)).status, '[Expected 3] COMPLETE').toBe('COMPLETE');
    });

    await step('Act: Step 4 — Call the Close PO API again with the same reason', async () => {
      r[4] = await poApi.close(held.po.id, 'auto 141', (await poData.read(held.po.id)).version);
    });
    await step('Assert: Expected 4 — The close succeeds and the order is Closed', async () => {
      expect(r[4].status, '[Expected 4] Accepted').toBeLessThan(300);
      expect((await poData.read(held.po.id)).status, '[Expected 4] CLOSED').toBe('CLOSED');
    });
  });

  test('TC_US105_144 — receivedDate / receivedQty / damagedQty / purchaseOrderLineId are mandatory, never defaulted', async ({ poApi, poData }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_144', 'Medium', TAGS, 'Omitting receivedDate, receivedQty, damagedQty or purchaseOrderLineId → 400 each (never defaulted); receivedDate after today → PRC-1021 with "입고일은 미래 날짜로 지정할 수 없습니다."');
    const po = await poData.createIssued([{ qty: 300 }]);
    const r: Record<number, { status: number; body: unknown }> = {};
    const base = async () => poData.receiptBody(po, 300, 0);

    await step('Arrange: Pre-condition 1–2 — PO A Issued with quantity outstanding', async () => undefined);

    await step('Act: Step 1 — Call the create-receipt API omitting receivedDate', async () => {
      const { receivedDate: _omit, ...body } = await base();
      void _omit;
      r[1] = await poApi.createReceipt(po.id, body);
    });
    await step('Assert: Expected 1 — 400, not silently defaulted to today', async () => {
      expect(r[1].status, '[Expected 1] 400').toBe(400);
    });

    for (const [n, field] of [[2, 'receivedQty'], [3, 'damagedQty'], [4, 'purchaseOrderLineId']] as const) {
      await step(`Act: Step ${n} — Call it again omitting ${field}`, async () => {
        const body = await base();
        const line = { ...body.lines[0] } as Record<string, unknown>;
        delete line[field];
        r[n] = await poApi.createReceipt(po.id, { ...body, lines: [line as never] });
      });
      await step(`Assert: Expected ${n} — Refused with 400`, async () => {
        expect(r[n].status, `[Expected ${n}] 400`).toBe(400);
      });
    }

    await step('Act: Step 5 — Call it with receivedDate set to a day after today', async () => {
      r[5] = await poApi.createReceipt(po.id, { ...(await base()), receivedDate: seoulToday(1) });
    });
    await step('Assert: Expected 5 — PRC-1021 "The received date cannot be in the future."', async () => {
      expect(errorCode(r[5].body), '[Expected 5] PRC-1021').toBe('PRC-1021');
      expect(message(r[5].body), '[Expected 5] Sentence').toContain(PO_KO['text.errReceivedDateFuture']);
      expect(await poApi.goodsReceipts(po.id), '[Expected 5] Nothing stored').toEqual([]);
    });
  });

  test('TC_US105_145 — A receipt naming the same line twice is refused; a single merged row saves', async ({ poApi, poData }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_145', 'Medium', TAGS, 'Two entries for the same purchase_order_line_id (100 + 90) → PRC-1039 "같은 발주 품목이 입고 요청에 두 번 이상 들어 있습니다…", nothing written; one entry of 190 saves as a single row.');
    const po = await poData.createIssued([{ qty: 300 }]);
    const r: Record<number, { status: number; body: unknown }> = {};

    await step('Arrange: Pre-condition 1–2 — PO A Issued with one line of 300', async () => undefined);

    await step('Act: Step 1 — Call the create-receipt API with two entries for the same line (100 and 90)', async () => {
      const body = await poData.receiptBody(po, 100, 0, 'ADJ_DISCREPANCY');
      r[1] = await poApi.createReceipt(po.id, { ...body, lines: [body.lines[0], { ...body.lines[0], receivedQty: 90 }] });
    });
    await step('Assert: Expected 1 — PRC-1039; nothing written', async () => {
      expect(errorCode(r[1].body), '[Expected 1] PRC-1039').toBe('PRC-1039');
      expect(await poApi.goodsReceipts(po.id), '[Expected 1] Nothing stored').toEqual([]);
    });

    await step('Act: Step 2 — Read the message returned', async () => undefined);
    await step('Assert: Expected 2 — The one-row-per-item sentence', async () => {
      expect(message(r[1].body), '[Expected 2] Sentence').toContain(PO_KO['error.PRC-1039']);
    });

    await step('Act: Step 3 — Call it again with ONE entry of 190', async () => {
      r[3] = await poApi.createReceipt(po.id, await poData.receiptBody(po, 190, 0, 'ADJ_DISCREPANCY'));
    });
    await step('Assert: Expected 3 — Saved as a single row of 190', async () => {
      expect(r[3].status, '[Expected 3] 201').toBe(201);
      expect((await poApi.goodsReceipts(po.id)).map((g) => g.receivedQty), '[Expected 3] One row of 190').toEqual([190]);
    });
  });

  test('TC_US105_149 — A receipt save is refused before any rule runs when the Idempotency-Key is missing or malformed', async ({ poApi, poData }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_149', 'Medium', TAGS, 'No header → 400 CMN-4000 and nothing stored (no quantity check runs); empty header, 3 characters, a space → same code; a valid 40-character key with valid quantities → receipt created. The operator-facing sentence ("입고를 저장할 수 없습니다. 입고 화면을 닫았다가 다시 열어 주세요.") is not in the frontend dictionary — only the code is asserted.');
    const po = await poData.createIssued([{ qty: 300 }]);
    const r: Record<number, { status: number; body: unknown }> = {};
    const body = async (qty = 300) => poData.receiptBody(po, qty, 0);

    await step('Arrange: Pre-condition 1–2 — PO A Issued with quantity outstanding', async () => undefined);

    await step('Act: Step 1 — Call the create-receipt API with NO Idempotency-Key header', async () => {
      r[1] = await poApi.createReceipt(po.id, await body(999_999), null);
    });
    await step('Assert: Expected 1 — 400 CMN-4000; nothing stored; no quantity rule ran', async () => {
      expect(r[1].status, '[Expected 1] 400').toBe(400);
      expect(errorCode(r[1].body), '[Expected 1] CMN-4000, not the PRC-1014 quantity check').toBe('CMN-4000');
      expect(await poApi.goodsReceipts(po.id), '[Expected 1] Nothing stored').toEqual([]);
    });

    await step('Act: Step 2 — Read the response code and message', async () => undefined);
    await step('Assert: Expected 2 — The operator is not told about a header', async () => {
      expect(message(r[1].body).toLowerCase(), '[Expected 2] No mention of the header').not.toContain('idempotency');
    });

    for (const [n, key, label] of [[3, '', 'present but EMPTY'], [4, 'abc', '3 characters'], [5, 'bad key value 1', 'containing a space']] as const) {
      await step(`Act: Step ${n} — Call it again with the header ${label}`, async () => {
        r[n] = await poApi.createReceipt(po.id, await body(), key);
      });
      await step(`Assert: Expected ${n} — Refused under the same code CMN-4000`, async () => {
        expect(errorCode(r[n].body), `[Expected ${n}] CMN-4000`).toBe('CMN-4000');
      });
    }

    await step('Act: Step 6 — Call it once more with a valid 40-character key and valid quantities', async () => {
      r[6] = await poApi.createReceipt(po.id, await body(), `k149_${'a'.repeat(35)}`);
    });
    await step('Assert: Expected 6 — The request succeeds and a receipt is created', async () => {
      expect(r[6].status, '[Expected 6] 201').toBe(201);
    });
  });

  test('TC_US105_150 — A key already spent on a DIFFERENT receipt is refused with PRC-1046', async ({ poApi, poData }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_150', 'Medium', TAGS, 'Reusing key K1 (owned by Receipt A on PO A) against PO B with other quantities → 409 PRC-1046 "이미 다른 입고 등록에 사용된 요청입니다…", nothing stored for PO B; Receipt A unchanged.');
    const poA = await poData.createIssued([{ qty: 300 }]);
    const poB = await poData.createIssued([{ qty: 200 }]);
    const key = newIdempotencyKey('k150');
    let receiptA: GrnDetail;
    let r = { status: 0, body: null as unknown };

    await step('Arrange: Pre-condition 1–3 — Receipt A created under K1 on PO A; PO B Issued with quantity outstanding', async () => {
      const created = await poApi.createReceipt(poA.id, await poData.receiptBody(poA, 300, 0), key);
      receiptA = (await poApi.goodsReceipt(poA.id, (created.body as GrnDetail).id)).body;
    });

    await step('Act: Step 1 — Call the create-receipt API against PO B reusing K1 with different quantities', async () => {
      r = await poApi.createReceipt(poB.id, await poData.receiptBody(poB, 150, 0, 'ADJ_DISCREPANCY'), key);
    });
    await step('Assert: Expected 1 — 409 PRC-1046; nothing stored for PO B', async () => {
      expect(r.status, '[Expected 1] 409').toBe(409);
      expect(errorCode(r.body), '[Expected 1] PRC-1046').toBe('PRC-1046');
      expect(await poApi.goodsReceipts(poB.id), '[Expected 1] Nothing stored').toEqual([]);
    });

    await step('Act: Step 2 — Read the message returned', async () => undefined);
    await step('Assert: Expected 2 — The already-used sentence', async () => {
      expect(message(r.body), '[Expected 2] Sentence').toContain(PO_KO['error.PRC-1046'].slice(0, 25));
    });

    await step('Act: Step 3 — Call the read API on Receipt A', async () => undefined);
    await step('Assert: Expected 3 — Receipt A is completely unchanged', async () => {
      const after = (await poApi.goodsReceipt(poA.id, receiptA.id)).body;
      expect([after.receivedQty, after.status, after.version], '[Expected 3] Unchanged').toEqual([receiptA.receivedQty, receiptA.status, receiptA.version]);
    });
  });

  test('TC_US105_151 — Replaying the original create after an Edit is refused, not answered with the stale receipt', async ({ poApi, poData }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_151', 'Medium', TAGS, 'Receipt A created under K2 with 290 and edited to 209 by its recorder; replaying the original K2 / 290 request → PRC-1046 (not PRC-1019); Received qty stays 209.');
    const po = await poData.createIssued([{ qty: 300 }]);
    const key = newIdempotencyKey('k151');
    let original: Awaited<ReturnType<PoData['receiptBody']>>;
    let grn: GrnDetail;
    let r = { status: 0, body: null as unknown };

    await step('Arrange: Pre-condition 1–3 — Receipt A under K2 with 290 (Exception), edited to 209 by Operator 1', async () => {
      original = await poData.receiptBody(po, 290, 0, 'ADJ_DISCREPANCY');
      const created = await poApi.createReceipt(po.id, original, key);
      grn = (await poApi.goodsReceipt(po.id, (created.body as GrnDetail).id)).body;
      await poApi.updateReceipt(po.id, grn.id, { ...original, lines: [{ ...original.lines[0], receivedQty: 209 }], version: grn.version });
    });

    await step('Act: Step 1 — Note the stored Received qty', async () => undefined);
    await step('Assert: Expected 1 — The stored value is 209', async () => {
      expect((await poApi.goodsReceipt(po.id, grn.id)).body.receivedQty, '[Expected 1] 209').toBe(209);
    });

    await step('Act: Step 2 — Replay the ORIGINAL create request (K2, 290)', async () => {
      r = await poApi.createReceipt(po.id, original, key);
    });
    await step('Assert: Expected 2 — PRC-1046, NOT ignored-and-returned as PRC-1019', async () => {
      expect(errorCode(r.body), '[Expected 2] PRC-1046').toBe('PRC-1046');
    });

    await step('Act: Step 3 — Read the message returned', async () => undefined);
    await step('Assert: Expected 3 — The already-used sentence', async () => {
      expect(message(r.body), '[Expected 3] Sentence').toContain(PO_KO['error.PRC-1046'].slice(0, 25));
    });

    await step('Act: Step 4 — Call the read API on Receipt A', async () => undefined);
    await step('Assert: Expected 4 — Received qty is still 209', async () => {
      expect((await poApi.goodsReceipt(po.id, grn.id)).body.receivedQty, '[Expected 4] 209').toBe(209);
    });
  });

  test('TC_US105_153 — A line belonging to another order, or removed while Draft, is refused with PRC-1044', async ({ poApi, poData }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_153', 'Medium', TAGS, 'Receipt on PO A naming PO B\'s line → 404 PRC-1044 "이 발주서에 없는 품목입니다…", nothing stored (not an uncoded 500); receipt on PO C naming the line removed while it was Draft → same code.');
    const poA = await poData.createIssued([{ qty: 300 }]);
    const poB = await poData.createIssued([{ qty: 300 }]);
    let poC: PoDetail;
    let removedLine = 0;
    const r: Record<number, { status: number; body: unknown }> = {};

    await step('Arrange: Pre-condition 1–3 — PO A and PO B Issued; PO C edited in Draft (line replaced) then issued', async () => {
      const draft = await poData.createDraft([{ sku: 'A' }]);
      removedLine = draft.lines[0].id;
      await poApi.update(draft.id, toPoUpdateBody(draft, { lines: [{ skuId: poData.warehouse.skus.B.id, ownershipType: 'OWN', saleType: 'PURCHASE', orderedQty: 100, unitPrice: 1000 }] }));
      const edited = await poData.read(draft.id);
      await poApi.issue(edited.id, edited.version);
      poC = await poData.read(draft.id);
    });

    await step('Act: Step 1 — Create a receipt on PO A naming the line of PO B', async () => {
      const body = await poData.receiptBody(poA, 300, 0);
      r[1] = await poApi.createReceipt(poA.id, { ...body, lines: [{ purchaseOrderLineId: poB.lines[0].id, receivedQty: 300, damagedQty: 0 }] });
    });
    await step('Assert: Expected 1 — 404 PRC-1044; nothing stored', async () => {
      expect(r[1].status, '[Expected 1] 404').toBe(404);
      expect(errorCode(r[1].body), '[Expected 1] PRC-1044').toBe('PRC-1044');
      expect(await poApi.goodsReceipts(poA.id), '[Expected 1] Nothing stored').toEqual([]);
    });

    await step('Act: Step 2 — Read the response code and message', async () => undefined);
    await step('Assert: Expected 2 — "This item is not on this purchase order. Reopen the order and check its items."', async () => {
      expect(message(r[1].body), '[Expected 2] Sentence').toContain(PO_KO['error.PRC-1044']);
    });

    await step('Act: Step 3 — Create a receipt on PO C naming the line removed while it was Draft', async () => {
      const body = await poData.receiptBody(poC, 100, 0);
      r[3] = await poApi.createReceipt(poC.id, { ...body, lines: [{ purchaseOrderLineId: removedLine, receivedQty: 100, damagedQty: 0 }] });
    });
    await step('Assert: Expected 3 — Refused under the same code PRC-1044', async () => {
      expect(errorCode(r[3].body), '[Expected 3] PRC-1044').toBe('PRC-1044');
    });
  });

  test('TC_US105_156 — Resolve is refused when the order became Closed through a path predating PRC-1042', async ({ poApi, approverPoApi, poData }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_156', 'Medium', TAGS, 'PO A forced to CLOSED at the data level while its receipt is Exception; resolve → PRC-1017 "이 발주서는 종결되었습니다. 추가 입고는 새 발주서를 등록해 주세요."; receipt still Exception, nothing posted. The status is written directly to purchase_order (allowed 05/10) and restored afterwards.');
    test.skip(!hasDbCredentials(), 'MySQL credentials (DB_*) are not configured in .env — the forced CLOSED state cannot be built');
    const sku = poData.warehouse.skus.A.id;
    let held: { po: PoDetail; grn: GrnDetail };
    let baseline = 0;
    let r = { status: 0, body: null as unknown };

    await step('Arrange: Pre-condition 1–3 — PO A with an Exception receipt, status forced to CLOSED in the database', async () => {
      held = await heldReceipt(poData, poApi);
      await purchaseOrderDb.forceStatus(held.po.id, 'CLOSED');
      baseline = (await poApi.stockOf(sku, poData.warehouse.id)).available;
    });

    try {
      await step('Act: Step 1 — Confirm PO A shows CLOSED while its receipt shows Exception', async () => undefined);
      await step('Assert: Expected 1 — PO A CLOSED, receipt Exception', async () => {
        expect((await poData.read(held.po.id)).status, '[Expected 1] CLOSED').toBe('CLOSED');
        expect((await receiptOf(poApi, held.po.id)).status, '[Expected 1] EXCEPTION').toBe('EXCEPTION');
      });

      await step('Act: Step 2 — Call the resolve-discrepancy API on that receipt', async () => {
        const grn = await receiptOf(poApi, held.po.id);
        r = await approverPoApi.resolveReceipt(held.po.id, grn.id, 'ADJ_DISCREPANCY', null, grn.version);
      });
      await step('Assert: Expected 2 — Refused with PRC-1017', async () => {
        expect(errorCode(r.body), '[Expected 2] PRC-1017').toBe('PRC-1017');
      });

      await step('Act: Step 3 — Read the message returned', async () => undefined);
      await step('Assert: Expected 3 — The closed-order sentence', async () => {
        expect(message(r.body), '[Expected 3] Sentence').toContain(PO_KO['error.PRC-1017']);
      });

      await step('Act: Step 4 — Check the receipt status and stock', async () => undefined);
      await step('Assert: Expected 4 — Still Exception, nothing posted', async () => {
        expect((await receiptOf(poApi, held.po.id)).status, '[Expected 4] EXCEPTION').toBe('EXCEPTION');
        expect((await poApi.stockOf(sku, poData.warehouse.id)).available, '[Expected 4] Stock unchanged').toBe(baseline);
      });
    } finally {
      await purchaseOrderDb.forceStatus(held!.po.id, 'ISSUED');
    }
  });

  test('TC_US105_157 — A stale write on a GOODS RECEIPT is refused with the receipt-specific conflict message', async ({ poApi, approverPoApi, poData }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_157', 'Medium', TAGS, 'Both sessions read the same Exception receipt; A resolves it (Complete); B, still on the pre-resolve version, rejects and is refused with PRC-1018 carrying the RECEIPT sentence ("이 입고 건은 화면을 연 이후 변경되었습니다…"), not the order\'s. Deviation: only two accounts exist, so the receipt is recorded by dungbd.fpt and both stale sessions run as congnd17.fpt (the conflict is decided by the version sent).');
    let held: { po: PoDetail; grn: GrnDetail };
    const r: Record<number, { status: number; body: unknown }> = {};

    await step('Arrange: Pre-condition 1–2 — Two approver sessions; a receipt in Exception recorded by another account', async () => {
      held = await heldReceipt(poData, approverPoApi);
    });

    await step('Act: Step 1 — Open the discrepancy dialog for that receipt on both sessions', async () => undefined);
    await step('Assert: Expected 1 — Both read the same Exception state', async () => {
      expect(held.grn.status, '[Expected 1] EXCEPTION').toBe('EXCEPTION');
    });

    await step('Act: Step 2 — On session A, resolve the discrepancy with a valid reason', async () => {
      r[2] = await poApi.resolveReceipt(held.po.id, held.grn.id, 'ADJ_DISCREPANCY', null, held.grn.version);
    });
    await step('Assert: Expected 2 — The resolve succeeds; the receipt is Complete', async () => {
      expect((await receiptOf(poApi, held.po.id)).status, '[Expected 2] COMPLETE').toBe('COMPLETE');
    });

    await step('Act: Step 3 — On session B (pre-resolve version), click Reject receipt with a reason', async () => {
      r[3] = await poApi.rejectReceipt(held.po.id, held.grn.id, 'ADJ_DISCREPANCY', 'auto 157', held.grn.version);
    });
    await step('Assert: Expected 3 — Refused as a conflict with PRC-1018', async () => {
      expect(errorCode(r[3].body), '[Expected 3] PRC-1018').toBe('PRC-1018');
    });

    await step('Act: Step 4 — Observe the error on session B', async () => undefined);
    await step('Assert: Expected 4 — The RECEIPT sentence, not the order\'s', async () => {
      expect(message(r[3].body), '[Expected 4] Receipt-scoped sentence').toContain('이 입고 건은 화면을 연 이후 변경되었습니다');
      expect(message(r[3].body), '[Expected 4] Not the order sentence').not.toContain(PO_KO['error.PRC-1018']);
    });
  });

  test('TC_US105_158 — A SKU with no CJ mapping fails with a known, uncoded 500 at a logistics-connected destination', async ({ poApi, poData, poWarehouseApi }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_158', 'Low', TAGS, 'KNOWN DEFECT (not a US105 bug): on a CJ-connected destination a receipt for a SKU never mapped to the CJ 3PL fails with an UNCODED 500 (LogisticsSkuNotIntegratedException); no bilingual message; no receipt created. The destination is an automation WMS warehouse on CJ대한통운(EgFlex) with the SKU mapped only in the product register.');
    let po: PoDetail;
    let r = { status: 0, body: null as unknown };

    await step('Arrange: Pre-condition 1–2 — PO A Issued, one line for a SKU never mapped to CJ, logistics-connected destination', async () => {
      const cj = await createBaseWarehouse(poWarehouseApi, poApi, 'TC158_CJ', 'PLATFORM_WMS_EGFLEX');
      const created = await poApi.create(buildPoBody(cj, 1, [{ qty: 10 }]));
      poData.track(created.body.id);
      const draft = await poData.read(created.body.id);
      await poApi.issue(draft.id, draft.version);
      po = await poData.read(draft.id);
    });

    await step('Act: Step 1 — Call the create-receipt API with valid quantities and a valid key', async () => {
      r = await poApi.createReceipt(po.id, await poData.receiptBody(po, 10, 0));
    });
    await step('Assert: Expected 1 — An UNCODED 500 raised by the inventory module', async () => {
      expect(r.status, '[Expected 1] 500').toBe(500);
      expect(errorCode(r.body) ?? null, '[Expected 1] No business code').toBeNull();
    });

    await step('Act: Step 2 — Read the response code and body', async () => undefined);
    await step('Assert: Expected 2 — Only the generic server error; no bilingual message', async () => {
      expect(message(r.body), '[Expected 2] No PRC / WH sentence').not.toMatch(/PRC-|WH-/);
    });

    await step('Act: Step 3 — Check the receipt status', async () => undefined);
    await step('Assert: Expected 3 — No receipt is created, nothing posted', async () => {
      expect(await poApi.goodsReceipts(po.id), '[Expected 3] No receipt').toEqual([]);
    });
  });
});
