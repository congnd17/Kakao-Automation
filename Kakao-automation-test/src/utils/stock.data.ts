import type { WarehouseApi, WarehouseDetail, WarehouseSummary, WarehouseWriteBody } from '@api/warehouse.api';
import type { PhysicalSkuBody, SkuType, SkuUsageType, StockApi } from '@api/stock.api';
import { WarehouseCleanup, WarehouseKind, buildWarehouseBody } from '@utils/warehouse.data';
import { stockDb, StockBuckets } from '@utils/stock-db';

/**
 * Dữ liệu test US134 — quyết định 05/10: suite TỰ SEED. TC viết quanh "12 demo rows" (DEMO-SKU-0001…0012, DEMO-PC-xxx,
 * Demo Partner A/B, kho CJ Incheon Aam / CJ Daegu warehouse / Demo Pickup Point). Trên dev dùng chung, suite dựng lại đúng
 * thế giới đó bằng dữ liệu riêng: mã/tên gắn tag run `T134xxxxxx` (traceable), nên lọc 상품코드명 = tag ra đúng 12 dòng.
 *  - SKU / nhóm SKU tạo qua API POST /skus (đúng body form gửi).
 *  - Ngăn tồn kho (가용 / 보류 / CS / 할당) dựng trực tiếp bằng DB trên SKU × kho của suite (UI/API không có đường tạo).
 *  - Teardown: xoá dấu vết tồn kho, xoá mềm SKU, xoá kho automation.
 */

export type DemoKey =
  | 'SKU0001' | 'SKU0002' | 'SKU0003' | 'SKU0004' | 'SKU0005' | 'SKU0006'
  | 'SKU0007' | 'SKU0008' | 'SKU0009' | 'SKU0010' | 'SKU0011' | 'SKU0012';

export type PartnerKey = 'A' | 'B';
export type ManufacturerKey = 'M1' | 'M2' | 'MB';
export type WarehouseKey = 'CJ' | 'DAEGU' | 'PICKUP' | 'GENERAL';

/** Biz partner thật trên dev đóng vai Demo Partner A / B (tên lấy lúc chạy). */
export interface WorldPartner {
  id: number;
  nameKo: string;
  nameEn: string;
}

export interface WorldManufacturer {
  id: number;
  name: string;
}

export interface WorldWarehouse {
  id: number;
  name: string;
  category: string;
  /** 5 kho ảo hệ thống sinh kèm (매출대기 / 이동중 / 폐기 / 이슈격리 / 불량) — chỉ có ở kho vật lý. */
  buckets: WarehouseSummary[];
}

/** 1 SKU của world — `skuName` là tên đã lưu (상품코드명 + ' ' + SKU명 khi 옵션있음). */
export interface WorldSku {
  key: string;
  type: SkuType;
  skuId: number;
  skuCode: string;
  skuName: string;
  barcode: string | null;
  hsCode: string | null;
  groupId: number;
  groupCode: string;
  groupName: string;
  partner: WorldPartner;
  manufacturer: WorldManufacturer | null;
  usageType: SkuUsageType | null;
}

/** 1 dòng tồn kho đã dựng (SKU × kho) cùng các ngăn đã ghi vào DB. */
export interface WorldStockRow {
  sku: WorldSku;
  warehouse: WorldWarehouse;
  buckets: Required<StockBuckets>;
}

/** Định nghĩa nhóm SKU (상품코드) của world — mỗi dòng `lines` = 1 SKU. */
interface GroupSpec {
  group: string;
  type: SkuType;
  partner: PartnerKey;
  name: string;
  usageType?: SkuUsageType;
  manufacturer?: ManufacturerKey;
  hasOption?: boolean;
  lines: Array<{ key: DemoKey; option?: string; hsCode?: string }>;
  bundles?: Array<{ key: DemoKey; quantity: number }>;
}

/**
 * Bản đồ world ↔ TC: 8 현물, 2 디지털, 2 Set (TC_036); Partner A 7 dòng, Partner B 5 dòng (TC_042); DEMO-PC-001 có 2 dòng
 * SKU0001 + SKU0002 (TC_097); DEMO-PC-002 chứa SKU0003/0004/0008 (TC_027); SKU0006 + SKU0010 không có barcode (TC_025);
 * SKU0005 현물 không kho, không tồn (TC_068); Set SKU0007 = SKU0001 × 1 + SKU0009 × 1 (TC_080).
 */
const GROUPS: GroupSpec[] = [
  { group: 'PC001', type: 'PHYSICAL', partner: 'A', name: 'Demo Album [Vol.1]', usageType: 'MAIN', manufacturer: 'M1', hasOption: true, lines: [{ key: 'SKU0001', option: 'Photocard (Type A)', hsCode: '6109101001' }, { key: 'SKU0002', option: 'Photocard (Type B)', hsCode: '6109101002' }] },
  { group: 'PC002', type: 'PHYSICAL', partner: 'A', name: 'Demo Hoodie', usageType: 'MAIN', manufacturer: 'M1', hasOption: true, lines: [{ key: 'SKU0003', option: 'S', hsCode: '6109101003' }, { key: 'SKU0004', option: 'M', hsCode: '6109101004' }, { key: 'SKU0008', option: 'L', hsCode: '6109101008' }] },
  { group: 'PC003', type: 'PHYSICAL', partner: 'A', name: 'Demo Keyring', usageType: 'MAIN', manufacturer: 'M2', lines: [{ key: 'SKU0009', hsCode: '6109101009' }] },
  { group: 'PC004', type: 'PHYSICAL', partner: 'B', name: 'Demo Light Stick [Gen.3] — Body', usageType: 'MAIN', manufacturer: 'MB', lines: [{ key: 'SKU0005', hsCode: '6109101005' }] },
  { group: 'PC005', type: 'PHYSICAL', partner: 'B', name: 'Demo Poster', usageType: 'GIVEAWAY', manufacturer: 'MB', lines: [{ key: 'SKU0011', hsCode: '6109101011' }] },
  { group: 'PC006', type: 'DIGITAL', partner: 'B', name: 'Demo Digital Pass', lines: [{ key: 'SKU0006' }] },
  { group: 'PC010', type: 'DIGITAL', partner: 'B', name: 'Demo Digital Album', lines: [{ key: 'SKU0010' }] },
  { group: 'PC007', type: 'MIXED', partner: 'A', name: 'Demo Set Bundle', lines: [{ key: 'SKU0007' }], bundles: [{ key: 'SKU0001', quantity: 1 }, { key: 'SKU0009', quantity: 1 }] },
  { group: 'PC012', type: 'MIXED', partner: 'B', name: 'Demo Poster Set', lines: [{ key: 'SKU0012' }], bundles: [{ key: 'SKU0011', quantity: 2 }] },
];

/**
 * Tồn kho world (TC_071/073/075/076): SKU0001 @ CJ: 할당 40 · 가용 120 · CS 20 · 보류 10 → 전체 190, CS 관리함.
 * SKU0002 @ CJ: CS 관리안함. SKU0003 / SKU0008 @ CJ Daegu. SKU0004 @ Demo Pickup Point. SKU0009 / SKU0011 @ CJ.
 */
const STOCKS: Array<{ key: DemoKey; warehouse: WarehouseKey; buckets: StockBuckets }> = [
  { key: 'SKU0001', warehouse: 'CJ', buckets: { available: 120, reserved: 40, cs: 20, hold: 10, csManaged: true } },
  { key: 'SKU0002', warehouse: 'CJ', buckets: { available: 50, csManaged: false } },
  { key: 'SKU0003', warehouse: 'DAEGU', buckets: { available: 200, csManaged: false } },
  { key: 'SKU0004', warehouse: 'PICKUP', buckets: { available: 10, csManaged: false } },
  { key: 'SKU0008', warehouse: 'DAEGU', buckets: { available: 14, reserved: 12, cs: 8, csManaged: true } },
  { key: 'SKU0009', warehouse: 'CJ', buckets: { available: 30, csManaged: false } },
  { key: 'SKU0011', warehouse: 'CJ', buckets: { available: 5, cs: 5, csManaged: true } },
];

/** Tag run 10 ký tự `T134` + base36 — nằm trong mọi mã/tên world, dùng làm keyword lọc list. */
export function newRunTag(): string {
  return `T134${Date.now().toString(36).slice(-6).toUpperCase()}`;
}

let codeSeq = 0;

/** Mã duy nhất ≤ 20 ký tự (giới hạn 상품코드 / SKU코드 / 바코드): `<tag><label><seq>` — chỉ chữ HOA, số, `-`. */
export function uniqueCode(tag: string, label: string): string {
  codeSeq = (codeSeq + 1) % 1000;
  const suffix = `${label}${String(codeSeq).padStart(3, '0')}`.toUpperCase().replace(/[^A-Z0-9-]/g, '');
  return `${tag}${suffix}`.slice(0, 20);
}

/** HS 코드 10 chữ số duy nhất theo thời gian. */
export function uniqueHsCode(): string {
  return `61${String(Date.now()).slice(-8)}`;
}

/** Tên xuất khẩu hợp lệ (≥ 10 ký tự Latin, chỉ ký tự cho phép). */
export function exportName(code: string): string {
  return `EXPORT ITEM ${code}`.slice(0, 150);
}

export interface PhysicalSkuOptions {
  partner: WorldPartner;
  manufacturer: WorldManufacturer;
  groupName?: string;
  usageType?: SkuUsageType;
  /** Mỗi phần tử = 1 dòng SKU; có `option` → 옵션있음 và SKU명 lưu = 상품코드명 + ' ' + option. */
  lines?: Array<{ option?: string; barcode?: string | null; skuCode?: string; exportSkuName?: string }>;
  hsCode?: string;
  price?: number;
  groupCode?: string;
  overrides?: Partial<PhysicalSkuBody>;
}

/**
 * World dữ liệu dùng chung cho 1 lần chạy suite (worker fixture) + factory tạo SKU riêng cho test cần ghi.
 * Mọi thứ tạo ra được theo dõi để dọn ở `dispose()`.
 */
export class StockWorld {
  readonly tag = newRunTag();
  partners!: Record<PartnerKey, WorldPartner>;
  manufacturers!: Record<ManufacturerKey, WorldManufacturer>;
  warehouses!: Record<'CJ' | 'PICKUP' | 'GENERAL', WorldWarehouse> & { DAEGU: WorldWarehouse | null };
  readonly skus = new Map<string, WorldSku>();
  readonly stockRows: WorldStockRow[] = [];
  /** Lý do không dựng được kho CJ Daegu (kênh CJ_LOGISTICS_DT) — TC cần kho này tự skip với lý do. */
  daeguUnavailableReason: string | null = null;

  private readonly createdSkuIds = new Set<number>();
  private readonly createdGroupIds = new Set<number>();
  private readonly createdManufacturerIds = new Set<number>();
  private readonly pendingGroupCodes = new Set<string>();
  private readonly extraWarehouseIds = new Set<number>();
  private readonly warehouseCleanup: WarehouseCleanup;

  constructor(
    readonly api: StockApi,
    private readonly warehouseApi: WarehouseApi,
  ) {
    this.warehouseCleanup = new WarehouseCleanup(warehouseApi);
  }

  /**
   * Keyword lọc 상품코드명 ra đúng 12 dòng world: mọi 상품코드명 world là `<tag> Demo …`, còn SKU riêng của từng test là
   * `<tag> <label>` — không lẫn vào.
   */
  get keyword(): string {
    return `${this.tag} Demo`;
  }

  sku(key: DemoKey | string): WorldSku {
    const sku = this.skus.get(key);
    if (!sku) throw new Error(`World SKU ${key} was not created`);
    return sku;
  }

  /** Dòng tồn kho world của `key` (mặc định kho đầu tiên). */
  row(key: DemoKey | string, warehouse?: WorldWarehouse): WorldStockRow {
    const row = this.stockRows.find((r) => r.sku.key === key && (!warehouse || r.warehouse.id === warehouse.id));
    if (!row) throw new Error(`World stock row ${key} was not created`);
    return row;
  }

  /** Bucket kho ảo theo hậu tố tên (불량 = DEFECTIVE, 매출대기 = PENDING_REVENUE, 이동중 = IN_TRANSIT…). */
  bucket(parent: WorldWarehouse, suffix: '매출대기' | '이동중' | '폐기' | '이슈격리' | '불량'): WarehouseSummary {
    const bucket = parent.buckets.find((b) => b.name.endsWith(suffix));
    if (!bucket) throw new Error(`Warehouse ${parent.name} has no ${suffix} bucket`);
    return bucket;
  }

  async build(): Promise<this> {
    await this.pickPartners();
    await this.createWarehouses();
    for (const spec of GROUPS) await this.createGroup(spec);
    for (const stock of STOCKS) {
      const warehouse = this.warehouseFor(stock.warehouse);
      if (warehouse) await this.seedStock(this.sku(stock.key), warehouse, stock.buckets);
    }
    return this;
  }

  /** Ghi đè ngăn tồn kho của 1 dòng (DB) và cập nhật bản ghi world. */
  async seedStock(sku: WorldSku, warehouse: WorldWarehouse, buckets: StockBuckets): Promise<WorldStockRow> {
    await stockDb.upsertStock(sku.skuId, warehouse.id, buckets);
    const full = { available: buckets.available, hold: buckets.hold ?? 0, reserved: buckets.reserved ?? 0, cs: buckets.cs ?? 0, csManaged: buckets.csManaged ?? false };
    const existing = this.stockRows.find((r) => r.sku.skuId === sku.skuId && r.warehouse.id === warehouse.id);
    if (existing) {
      existing.buckets = full;
      return existing;
    }
    const row = { sku, warehouse, buckets: full };
    this.stockRows.push(row);
    return row;
  }

  /** Tạo 1 nhóm 현물 SKU riêng cho test (traceable theo tag + nhãn TC). Trả về mọi dòng SKU theo thứ tự. */
  async createPhysicalSku(label: string, options: PhysicalSkuOptions): Promise<WorldSku[]> {
    const groupCode = options.groupCode ?? uniqueCode(this.tag, label);
    const groupName = options.groupName ?? `${this.tag} ${label}`;
    const lines = options.lines ?? [{}];
    const hasOption = lines.some((line) => line.option !== undefined);
    const body: PhysicalSkuBody = {
      type: 'PHYSICAL',
      bizPartnerId: options.partner.id,
      group: { code: groupCode, name: groupName },
      usageType: options.usageType ?? 'MAIN',
      price: options.price ?? 12000,
      skus: lines.map((line, index) => {
        const skuCode = line.skuCode ?? uniqueCode(this.tag, `${label}S${index}`);
        return {
          name: hasOption ? line.option ?? '' : '',
          skuCode,
          exportSkuName: line.exportSkuName ?? exportName(skuCode),
          barcode: line.barcode === undefined ? uniqueCode(this.tag, `${label}B${index}`) : line.barcode ?? '',
        };
      }),
      weight: 250,
      width: 100,
      length: 80,
      height: 30,
      hsCode: options.hsCode ?? uniqueHsCode(),
      description: 'Automation SKU',
      manufacturerId: options.manufacturer.id,
      countryOfOrigin: 'KR',
      ...options.overrides,
    };
    const created = await this.api.createSku(body);
    if (created.status >= 300) throw new Error(`Test data setup failed — POST /skus (physical ${groupCode}) returned ${created.status}: ${JSON.stringify(created.body)}`);
    return this.readGroup('PHYSICAL', groupCode, label, options.partner, options.manufacturer, body.usageType, body.hsCode, lines.length);
  }

  async createDigitalSku(label: string, partner: WorldPartner, groupName?: string): Promise<WorldSku> {
    const groupCode = uniqueCode(this.tag, label);
    const created = await this.api.createSku({ type: 'DIGITAL', bizPartnerId: partner.id, group: { code: groupCode, name: groupName ?? `${this.tag} ${label}` } });
    if (created.status >= 300) throw new Error(`Test data setup failed — POST /skus (digital ${groupCode}) returned ${created.status}: ${JSON.stringify(created.body)}`);
    return (await this.readGroup('DIGITAL', groupCode, label, partner, null, null, null, 1))[0];
  }

  async createSetSku(label: string, partner: WorldPartner, bundles: Array<{ sku: WorldSku; quantity: number }>, groupName?: string): Promise<WorldSku> {
    const groupCode = uniqueCode(this.tag, label);
    const created = await this.api.createSku({
      type: 'MIXED',
      bizPartnerId: partner.id,
      group: { code: groupCode, name: groupName ?? `${this.tag} ${label}` },
      bundles: bundles.map((bundle) => ({ skuId: bundle.sku.skuId, quantity: bundle.quantity })),
    });
    if (created.status >= 300) throw new Error(`Test data setup failed — POST /skus (set ${groupCode}) returned ${created.status}: ${JSON.stringify(created.body)}`);
    return (await this.readGroup('MIXED', groupCode, label, partner, null, null, null, 1))[0];
  }

  /** Theo dõi SKU / nhóm do UI tạo (test bấm 저장 trên form) để teardown dọn. */
  trackSkuGroup(groupId: number, skuIds: number[]): void {
    this.createdGroupIds.add(groupId);
    skuIds.forEach((id) => this.createdSkuIds.add(id));
  }

  /**
   * Theo dõi SKU do UI / upload tạo khi chỉ biết 상품코드 — gọi được cả TRƯỚC khi lưu: mã được ghi nhớ và tra lại ở
   * `dispose()`, nên SKU tạo sau lời gọi này vẫn được dọn.
   */
  async trackGroupCode(groupCode: string): Promise<void> {
    this.pendingGroupCodes.add(groupCode);
    await this.resolveGroupCode(groupCode);
  }

  /** Tra mọi SKU của 상품코드 ở cả 3 loại (GET /skus không có `type` chỉ trả 현물). So khớp không phân biệt hoa thường. */
  private async resolveGroupCode(groupCode: string): Promise<void> {
    for (const type of ['PHYSICAL', 'DIGITAL', 'MIXED'] as const) {
      const { body } = await this.api.skus({ type, searchType: 'SKU_GROUP_CODE', keyword: groupCode });
      for (const row of (body.items ?? []).filter((item) => item.skuGroupCode.toUpperCase() === groupCode.toUpperCase())) {
        this.createdGroupIds.add(row.skuGroupId);
        this.createdSkuIds.add(row.skuId);
      }
    }
  }

  /** Tạo 제조사 riêng (DB) cho 1 partner — TC cần 제조사 bị xoá / danh sách 제조사 theo partner. */
  async createManufacturer(partner: WorldPartner, label: string): Promise<WorldManufacturer> {
    const name = `${this.tag} ${label}`;
    const id = await stockDb.insertManufacturer(partner.id, name);
    this.createdManufacturerIds.add(id);
    return { id, name };
  }

  /** Tạo thêm 1 kho automation (VD kho ảo khác loại, kho INACTIVE, kho SUPPLIER) — xoá ở teardown. */
  async createWarehouse(label: string, kind: WarehouseKind = 'PLATFORM_GENERAL', overrides: Partial<WarehouseWriteBody> = {}): Promise<WarehouseDetail> {
    const detail = await this.warehouseCleanup.create(kind, label, { bizPartnerId: String(this.partners.A.id), name: `${this.tag} ${label}`, ...overrides });
    this.extraWarehouseIds.add(detail.id);
    (await this.warehouseApi.bucketsOf(detail)).forEach((bucket) => this.extraWarehouseIds.add(bucket.id));
    return detail;
  }

  async dispose(): Promise<void> {
    const warehouseIds = [this.warehouses?.CJ, this.warehouses?.DAEGU, this.warehouses?.PICKUP, this.warehouses?.GENERAL]
      .filter((w): w is WorldWarehouse => !!w)
      .flatMap((w) => [w.id, ...w.buckets.map((b) => b.id)]);
    for (const code of this.pendingGroupCodes) await this.resolveGroupCode(code).catch(() => undefined);
    await stockDb.purgeSkus([...this.createdSkuIds], [...this.createdGroupIds]);
    await stockDb.purgeWarehouseStock([...warehouseIds, ...this.extraWarehouseIds]);
    for (const id of this.createdManufacturerIds) await stockDb.deleteManufacturer(id);
    await this.warehouseCleanup.dispose();
  }

  private warehouseFor(key: WarehouseKey): WorldWarehouse | null {
    return key === 'DAEGU' ? this.warehouses.DAEGU : this.warehouses[key];
  }

  /**
   * Partner A = biz partner có ≥ 2 제조사 (cần cho TC "manufacturers differ"), ưu tiên partner 카키카키 (1750221212252);
   * Partner B = partner khác có ≥ 1 제조사.
   */
  private async pickPartners(): Promise<void> {
    const partners = await this.api.bizPartners();
    const withManufacturers: Array<{ partner: WorldPartner; manufacturers: WorldManufacturer[] }> = [];
    const preferred = [1750221212252, 1];
    const ordered = [...preferred.map((id) => partners.find((p) => p.id === id)).filter((p): p is (typeof partners)[number] => !!p), ...partners.filter((p) => !preferred.includes(p.id))];
    for (const partner of ordered) {
      const manufacturers = await this.api.manufacturers(partner.id);
      if (manufacturers.length === 0) continue;
      withManufacturers.push({ partner: { id: partner.id, nameKo: partner.companyNames?.ko ?? String(partner.id), nameEn: partner.companyNames?.en || partner.companyNames?.ko || String(partner.id) }, manufacturers });
      if (withManufacturers.length >= 2 && withManufacturers.some((p) => p.manufacturers.length >= 2)) break;
    }
    const a = withManufacturers.find((p) => p.manufacturers.length >= 2);
    const b = withManufacturers.find((p) => p !== a);
    if (!a || !b) throw new Error('Test data setup failed — dev has no two biz partners with manufacturers (need one with ≥ 2)');
    this.partners = { A: a.partner, B: b.partner };
    this.manufacturers = { M1: a.manufacturers[0], M2: a.manufacturers[1], MB: b.manufacturers[0] };
  }

  /** Kho world thuộc Partner A: CJ Incheon Aam (WMS · CJ_LOGISTICS), CJ Daegu (WMS · CJ_LOGISTICS_DT), Demo Pickup Point, General. */
  private async createWarehouses(): Promise<void> {
    const partnerId = String(this.partners.A.id);
    const make = async (label: string, kind: WarehouseKind, extra: Partial<WarehouseWriteBody> = {}): Promise<WorldWarehouse> => {
      const detail = await this.warehouseCleanup.create(kind, label, { ...buildWarehouseBody(kind, `${this.tag} ${label}`), bizPartnerId: partnerId, name: `${this.tag} ${label}`, ...extra });
      const buckets = await this.warehouseApi.bucketsOf(detail);
      return { id: detail.id, name: detail.name, category: detail.category ?? '', buckets };
    };
    const cj = await make('CJ Incheon Aam', 'PLATFORM_WMS_EGFLEX');
    let daegu: WorldWarehouse | null = null;
    try {
      daegu = await make('CJ Daegu warehouse', 'PLATFORM_WMS_EGFLEX', { logisticsChannelType: 'CJ_LOGISTICS_DT' });
    } catch (error) {
      this.daeguUnavailableReason = `A CJ Daegu warehouse (WMS · CJ_LOGISTICS_DT) cannot be created on dev: ${(error as Error).message.slice(0, 200)}`;
    }
    const pickup = await make('Demo Pickup Point', 'PLATFORM_PICKUP');
    const general = await make('General warehouse', 'PLATFORM_GENERAL');
    this.warehouses = { CJ: cj, DAEGU: daegu, PICKUP: pickup, GENERAL: general };
  }

  private async createGroup(spec: GroupSpec): Promise<void> {
    const partner = this.partners[spec.partner];
    const groupName = `${this.tag} ${spec.name}`;
    let created: WorldSku[];
    if (spec.type === 'PHYSICAL') {
      created = await this.createPhysicalSku(spec.group, {
        partner,
        manufacturer: this.manufacturers[spec.manufacturer ?? 'M1'],
        groupName,
        usageType: spec.usageType,
        hsCode: spec.lines[0].hsCode,
        lines: spec.lines.map((line) => ({ option: spec.hasOption ? line.option : undefined, skuCode: uniqueCode(this.tag, line.key) })),
      });
    } else if (spec.type === 'DIGITAL') {
      created = [await this.createDigitalSku(spec.group, partner, groupName)];
    } else {
      created = [await this.createSetSku(spec.group, partner, (spec.bundles ?? []).map((b) => ({ sku: this.sku(b.key), quantity: b.quantity })), groupName)];
    }
    created.forEach((sku, index) => {
      const key = spec.lines[index].key;
      const worldSku = { ...sku, key };
      this.skus.set(key, worldSku);
    });
  }

  /** Tra SKU vừa tạo theo 상품코드 — GET /skus không truyền `type` chỉ trả SKU 현물 (verify 05/10), nên luôn truyền type. */
  private async readGroup(
    type: SkuType,
    groupCode: string,
    label: string,
    partner: WorldPartner,
    manufacturer: WorldManufacturer | null,
    usageType: SkuUsageType | null,
    hsCode: string | null,
    expectedLines: number,
  ): Promise<WorldSku[]> {
    this.pendingGroupCodes.add(groupCode);
    const { body } = await this.api.skus({ type, searchType: 'SKU_GROUP_CODE', keyword: groupCode });
    const rows = body.items.filter((item) => item.skuGroupCode === groupCode).sort((a, b) => a.skuId - b.skuId);
    if (rows.length < expectedLines) throw new Error(`Test data setup failed — SKU group ${groupCode} shows ${rows.length} SKU(s) after create, expected ${expectedLines}`);
    const detail = (await this.api.skuGroup(rows[0].skuGroupId)).body;
    this.createdGroupIds.add(rows[0].skuGroupId);
    const ordered = detail.skus?.length ? detail.skus.map((line) => rows.find((row) => row.skuId === line.skuId) ?? rows[0]) : rows;
    return ordered.map((row, index) => {
      this.createdSkuIds.add(row.skuId);
      const sku: WorldSku = {
        key: `${label}#${index + 1}`,
        type: row.type,
        skuId: row.skuId,
        skuCode: row.skuCode,
        skuName: row.skuName,
        barcode: row.barcode ?? null,
        hsCode,
        groupId: row.skuGroupId,
        groupCode,
        groupName: detail.groupName,
        partner,
        manufacturer,
        usageType,
      };
      this.skus.set(sku.key, sku);
      return sku;
    });
  }
}
