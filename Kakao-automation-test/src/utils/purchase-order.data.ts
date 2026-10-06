import { WarehouseApi } from '@api/warehouse.api';
import {
  Attachment,
  GrnDetail,
  GrnWriteBody,
  OwnershipType,
  PoDetail,
  PoLineBody,
  PoWriteBody,
  PurchaseOrderApi,
  SaleType,
  newIdempotencyKey,
} from '@api/purchase-order.api';
import { buildWarehouseBody, WarehouseKind } from '@utils/warehouse.data';

/**
 * Dữ liệu test US105 (발주 관리 + 입고 검수). Dev DÙNG CHUNG — quyết định 05/10/2026:
 *  - Mọi PO / receipt chỉ ghi trên KHO AUTOMATION tự tạo (`auto_US105_<run>_…`), không bao giờ trên kho thật.
 *  - PO Draft bị xoá ở teardown; PO Issued bị huỷ (chưa có receipt) hoặc đóng (đã có receipt) — PO đã phát hành không
 *    xoá được nên chấp nhận để lại PO Closed/Canceled và tồn kho trên kho automation.
 *  - Master data (공급처, 제조사, SKU) đọc lúc chạy từ register thật; thiếu thì test skip kèm lý do.
 */

/** Hậu tố traceable cho mọi dữ liệu của 1 lần chạy — `auto_US105_<RUN>_…`. */
export const RUN_ID = Date.now().toString(36).toUpperCase();

/** Biz partner sở hữu kho automation (cùng partner US069 dùng, verify 28/09). */
export const WAREHOUSE_OWNER = { id: '3333', name: '카카오엔터테인먼트 테스트' };

/** Ngày hôm nay theo giờ Seoul (YYYY-MM-DD) — đúng hàm `hC()` của frontend. */
export function seoulToday(offsetDays = 0): string {
  const date = new Date(Date.now() + offsetDays * 86_400_000);
  return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

/** Tên traceable cho dữ liệu do test tạo. */
export function autoName(tcId: string, label = ''): string {
  return `auto_US105_${RUN_ID}_${tcId.replace(/^TC_US105_/, '')}${label ? `_${label}` : ''}`;
}

/** SKU dùng cho test — đọc từ register thật (lookups/skus, verify 05/10): 3 SKU PHYSICAL của 2 nhãn. */
export const SKU_CODES = { A: 'STARSHIP_JSH_KIT_001', B: 'STARSHIP_MX_PHOTO_001', C: 'EDAM_IU_KIT_001' } as const;
export type SkuKey = keyof typeof SKU_CODES;

/** 공급처 có cả tên ko và en khác nhau trong register (verify 05/10). */
export const SUPPLIER = {
  starship: { ko: '스타쉽엔터테인먼트', en: 'STARSHIP ENTERTAINMENT' },
  antenna: { ko: '안테나뮤직', en: 'Antenna Music' },
} as const;

/** 4 mã lý do chênh lệch frontend đang hardcode (`Kje`, verify 05/10) — TC v17 ghi 5 mã (thêm ADJ_TAKING / 실사). */
export const UI_REASONS = [
  { code: 'ADJ_DISCREPANCY', name: '불일치' },
  { code: 'ADJ_DAMAGED', name: '파손' },
  { code: 'ADJ_LOST', name: '분실' },
  { code: 'ADJ_ETC', name: '기타' },
] as const;

/** PDF tối thiểu dùng làm 납품 증빙 — upload thật lên bucket ADMIN_CONTENT. */
export const DELIVERY_NOTE = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

export interface BaseWarehouse {
  id: number;
  name: string;
  /** skuId theo khoá A/B/C — mapping OWN đăng ký trên kho này; SKU A có thêm PARTNER. */
  skus: Record<SkuKey, { id: number; code: string; name: string; barcode: string }>;
}

/**
 * Kho automation dùng chung cho 1 worker (1 lần chạy): tạo kho PLATFORM / GENERAL + 5 bucket hệ thống sinh
 * (có DEFECTIVE vì kho tạo sau 2026-09-22), đăng ký mapping SKU A (OWN + PARTNER), SKU B (OWN), SKU C (OWN).
 * Không xoá được khi đã có PO tham chiếu → để lại, tên mang RUN_ID để truy vết.
 */
export async function createBaseWarehouse(warehouseApi: WarehouseApi, poApi: PurchaseOrderApi, label = 'BASE', kind: WarehouseKind = 'PLATFORM_GENERAL'): Promise<BaseWarehouse> {
  const name = autoName('WH', label);
  const created = await warehouseApi.create(buildWarehouseBody(kind, name, { bizPartnerId: WAREHOUSE_OWNER.id }));
  if (created.status !== 201) throw new Error(`Test data setup failed — POST /warehouses returned ${created.status}: ${JSON.stringify(created.body)}`);
  const warehouseId = created.body.id;
  const mappings: Array<{ key: SkuKey; owner: OwnershipType; isDefault: boolean }> = [
    { key: 'A', owner: 'OWN', isDefault: true },
    { key: 'A', owner: 'PARTNER', isDefault: false },
    { key: 'B', owner: 'OWN', isDefault: true },
    { key: 'C', owner: 'OWN', isDefault: true },
  ];
  for (const mapping of mappings) {
    const [product] = (await warehouseApi.selectableProducts(SKU_CODES[mapping.key])).filter((p) => p.code === SKU_CODES[mapping.key]);
    if (!product) throw new Error(`Test data setup failed — product ${SKU_CODES[mapping.key]} is not selectable for mapping`);
    const result = await warehouseApi.createMapping({ productId: product.id, warehouseId, ownershipType: mapping.owner, isDefault: mapping.isDefault });
    if (result.status >= 300) throw new Error(`Test data setup failed — mapping ${SKU_CODES[mapping.key]}/${mapping.owner} returned ${result.status}: ${JSON.stringify(result.body)}`);
  }
  const lookups = await poApi.skus({ warehouseId });
  const skus = {} as BaseWarehouse['skus'];
  for (const key of Object.keys(SKU_CODES) as SkuKey[]) {
    const sku = lookups.find((row) => row.skuCode === SKU_CODES[key]);
    if (!sku) throw new Error(`Test data setup failed — SKU ${SKU_CODES[key]} is not offered for the automation warehouse`);
    skus[key] = { id: sku.id, code: sku.skuCode, name: sku.name, barcode: sku.barcode ?? '' };
  }
  return { id: warehouseId, name, skus };
}

export interface LineSpec {
  sku?: SkuKey;
  owner?: OwnershipType;
  saleType?: SaleType;
  qty?: number;
  price?: number;
}

/** Body PO hợp lệ trên kho automation — test chỉ ghi đè phần mình kiểm. */
export function buildPoBody(warehouse: BaseWarehouse, supplierId: number, lines: LineSpec[] = [{}], overrides: Partial<PoWriteBody> = {}): PoWriteBody {
  return {
    supplierId,
    supplierType: 'BIZ_PARTNER',
    manufacturerId: null,
    warehouseId: warehouse.id,
    currencyCode: 'KRW',
    orderDate: seoulToday(),
    expectedDate: null,
    lines: lines.map((line): PoLineBody => ({
      skuId: warehouse.skus[line.sku ?? 'A'].id,
      ownershipType: line.owner ?? 'OWN',
      saleType: line.saleType ?? 'PURCHASE',
      orderedQty: line.qty ?? 300,
      unitPrice: line.price ?? 39150,
    })),
    ...overrides,
  };
}

/** Body PATCH giữ nguyên toàn bộ giá trị hiện tại của PO — test chỉ ghi đè trường cần thử. */
export function toPoUpdateBody(po: PoDetail, overrides: Partial<PoWriteBody> = {}): PoWriteBody {
  return {
    supplierId: po.supplierId,
    supplierType: po.supplierType,
    manufacturerId: po.manufacturerId ?? null,
    warehouseId: po.warehouseId,
    currencyCode: po.currencyCode,
    orderDate: po.orderDate,
    expectedDate: po.expectedDate ?? null,
    lines: po.lines.map((line) => ({
      skuId: line.skuId,
      ownershipType: line.ownershipType,
      saleType: line.saleType,
      orderedQty: line.orderedQty,
      unitPrice: line.unitPrice,
    })),
    version: po.version,
    ...overrides,
  };
}

/**
 * Dựng + dọn PO / receipt của 1 test. Mọi PO tạo qua đây (hoặc đăng ký bằng `track`) được dọn ở teardown:
 * Draft → xoá; Issued → từ chối receipt còn chờ (bằng account khác người ghi), rồi huỷ (chưa có receipt) / đóng.
 */
export class PoData {
  private readonly poIds = new Set<number>();
  private attachment?: Attachment;

  constructor(
    readonly api: PurchaseOrderApi,
    /** Account thứ 2 (APPROVER, khác danh tính) — dùng từ chối receipt do account chính ghi khi dọn dẹp. */
    private readonly otherApi: PurchaseOrderApi | undefined,
    readonly warehouse: BaseWarehouse,
    readonly supplierId: number,
  ) {}

  track(id: number): void {
    this.poIds.add(id);
  }

  async createDraft(lines: LineSpec[] = [{}], overrides: Partial<PoWriteBody> = {}): Promise<PoDetail> {
    const created = await this.api.create(buildPoBody(this.warehouse, this.supplierId, lines, overrides));
    if (created.status !== 201) throw new Error(`Test data setup failed — POST /purchase-orders returned ${created.status}: ${JSON.stringify(created.body)}`);
    this.track(created.body.id);
    return this.read(created.body.id);
  }

  async createIssued(lines: LineSpec[] = [{}], overrides: Partial<PoWriteBody> = {}): Promise<PoDetail> {
    const draft = await this.createDraft(lines, overrides);
    const issued = await this.api.issue(draft.id, draft.version);
    if (issued.status >= 300) throw new Error(`Test data setup failed — issue returned ${issued.status}: ${JSON.stringify(issued.body)}`);
    return this.read(draft.id);
  }

  async read(id: number): Promise<PoDetail> {
    const { status, body } = await this.api.get(id);
    if (status !== 200) throw new Error(`GET /purchase-orders/${id} returned ${status}`);
    return body;
  }

  /** 납품 증빙 upload 1 lần cho mỗi test, dùng lại cho mọi receipt. */
  async deliveryNote(): Promise<Attachment> {
    this.attachment ??= await this.api.uploadAttachment('auto_delivery_note.pdf', DELIVERY_NOTE);
    return this.attachment;
  }

  /** Body receipt hợp lệ cho dòng đầu tiên của PO. */
  async receiptBody(po: PoDetail, received: number, damaged = 0, reasonCode: string | null = null, detail: string | null = null): Promise<GrnWriteBody> {
    return {
      receivedDate: seoulToday(),
      discrepancyReasonCode: reasonCode,
      discrepancyReason: detail,
      attachments: [await this.deliveryNote()],
      lines: [{ purchaseOrderLineId: po.lines[0].id, receivedQty: received, damagedQty: damaged }],
    };
  }

  /** Ghi 1 receipt qua API (account `api`, mặc định account chính). */
  async receive(po: PoDetail, received: number, damaged = 0, reasonCode: string | null = null, api: PurchaseOrderApi = this.api): Promise<GrnDetail> {
    const body = await this.receiptBody(po, received, damaged, reasonCode);
    const created = await api.createReceipt(po.id, body, newIdempotencyKey('seed'));
    if (created.status !== 201) throw new Error(`Test data setup failed — POST goods-receipts returned ${created.status}: ${JSON.stringify(created.body)}`);
    return (await api.goodsReceipt(po.id, created.body.id)).body;
  }

  async dispose(): Promise<void> {
    for (const id of this.poIds) {
      const { status, body: po } = await this.api.get(id);
      if (status !== 200) continue;
      if (po.status === 'DRAFT') {
        await this.api.remove(id);
        continue;
      }
      if (po.status !== 'ISSUED') continue;
      const receipts = await this.api.goodsReceipts(id);
      for (const grn of receipts.filter((r) => r.status === 'EXCEPTION')) {
        const detail = (await this.api.goodsReceipt(id, grn.id)).body;
        const rejected = await this.api.rejectReceipt(id, grn.id, 'ADJ_DISCREPANCY', 'automation teardown', detail.version);
        if (rejected.status >= 300 && this.otherApi) {
          await this.otherApi.rejectReceipt(id, grn.id, 'ADJ_DISCREPANCY', 'automation teardown', detail.version);
        }
      }
      const fresh = (await this.api.get(id)).body;
      const live = (await this.api.goodsReceipts(id)).filter((r) => r.status !== 'REJECTED');
      if (live.length === 0) await this.api.cancel(id, 'automation teardown', fresh.version);
      else await this.api.close(id, 'automation teardown', fresh.version);
    }
  }
}
