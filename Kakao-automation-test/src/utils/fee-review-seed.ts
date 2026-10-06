import type { FeeRateApi, FeeRow, ContractValues } from '@api/fee-rate.api';
import type { FeeReviewApi, Policy } from '@api/fee-review.api';
import { feeReviewDb, FixtureProduct } from '@utils/fee-review-db';

/**
 * Seed dữ liệu US079 theo pre-condition của `input/TESTCASE_US079_v1.md` (mô hình US079_FLOW_GUIDE: họ contract ROOT/ANNEX,
 * cycle năm ≥ 2100, sản phẩm `fee_review_fixture_*`).
 *
 * Quyết định 01/10 (giảm rác vĩnh viễn trên dev dùng chung): contract và cycle KHÔNG xoá được → mỗi lần chạy (RUN) tạo
 * 1 họ contract cho mỗi CHỮ KÝ khác nhau và tái dùng cho mọi TC cùng chữ ký; cycle CY_MAIN dùng chung cho TC chỉ đọc theo
 * keyword. TC làm thay đổi contract (thêm / tắt fee row), đọc số đếm toàn cycle hoặc đóng cycle → `private: true`.
 * Sản phẩm luôn riêng từng TC (`T079-<RUN>-<N>-Pxx`) và được dọn bằng SQL ở teardown.
 * Deviation chung: TC dùng `Y = 2100 + 200 × RUN + N` cho năm cycle (chỉ đủ ~38 lần chạy) — ở đây cấp tháng trống ≥ 2100.
 */

/** Mã master theo TC: CAT_A ALBUM · CAT_B FANCLUB_KIT · CAT_C MD_CONSIGNMENT · CAT_D MD · CAT_E FANCLUB · ST1/ST2. */
export const CATEGORY_CODE = { A: 'ALBUM', B: 'FANCLUB_KIT', C: 'MD_CONSIGNMENT', D: 'MD', E: 'FANCLUB' } as const;
export const SALE_TYPE_CODE = { ST1: 'FULL_CONSIGNMENT', ST2: 'PURCHASE' } as const;
export type CategoryKey = keyof typeof CATEGORY_CODE;
export type SaleTypeKey = keyof typeof SALE_TYPE_CODE;
const PARTNER = 1771579487807;

export interface RowDef {
  /** Nhãn TC đặt cho fee row (R_A, R_B10, R_B9, R_PROMO…) — dùng để lấy id sau khi tạo. */
  label: string;
  category: CategoryKey;
  saleType?: SaleTypeKey;
  policy?: Policy;
  type?: 'PERCENT' | 'MARGIN' | 'FIXED_UNIT';
  rate: number;
  /** Kỳ khuyến mãi của dòng PROMOTION (`startAt` / `endAt` của commission). */
  period?: { startAt: string; endAt: string };
  status?: 'ACTIVE' | 'INACTIVE';
}

export interface ContractDef {
  /** Khoá TC: ROOT, ANNEX1, ANNEX2, CT2, CT3, CT4. */
  key: string;
  parent?: string;
  rows: RowDef[];
  startAt?: string;
  endAt?: string;
  partner?: number;
}

export interface Family {
  contracts: Record<string, number>;
  rows: Record<string, number>;
}

export interface ProductDef {
  /** Hậu tố TC (P01, P03, P14, X99…). */
  code: string;
  name?: string;
  contract?: string | null;
  category?: CategoryKey | null;
  saleType?: SaleTypeKey | null;
  defaultSlot?: string | null;
  promotionSlot?: string | null;
  /** Dòng `fee_review_fixture_target` trên các cycle (khoá cycle trong `Seeded.cycles`). */
  targets: Array<{ cycle: string; policy?: Policy; saleLines?: number }>;
}

export interface SeedSpec {
  /** Số TC (N trong `T079-<RUN>-<N>`). */
  tc: number;
  contracts: ContractDef[];
  /** Các cycle cần có (khoá TC: CY_MAIN, CY_CLOSE, CY_NEXT, CY_EMPTY…). */
  cycles: string[];
  products: ProductDef[];
  /** TC thay đổi contract / đóng cycle / đọc số đếm toàn cycle → không dùng chung. */
  private?: boolean;
  /** Cycle cần đóng ngay sau khi seed (sau khi chèn target). */
  close?: string[];
}

export interface Seeded {
  run: string;
  prefix: string;
  family: Family;
  cycles: Record<string, { id: number; label: string; periodStart: string; periodEnd: string }>;
  products: Record<string, string>;
  master: Master;
  cleanup: () => Promise<void>;
}

export interface Master {
  category: Record<CategoryKey, number>;
  saleType: Record<SaleTypeKey, number>;
  categoryName: Record<CategoryKey, string>;
  label: number;
  businessModel: number;
}

/** RUN = 1 lần chạy (1 worker). Base-36 timestamp: ngắn, duy nhất, truy vết được (product_id varchar(64)). */
export const RUN = Date.now().toString(36);

const familyCache = new Map<string, Promise<Family>>();
const sharedCycleCache = new Map<string, Promise<Seeded['cycles'][string]>>();
let masterCache: Promise<Master> | undefined;
let monthCursor: Promise<{ year: number; month: number }> | undefined;

function pick<T extends { code: string; id: number; title: string }>(list: T[], code: string, what: string): T {
  const item = list.find((x) => x.code === code);
  if (!item) throw new Error(`Master ${what} "${code}" not found in GET /contracts/values`);
  return item;
}

/** GET đọc master — dev đôi khi chậm > 15s (run 02/10) → thử lại tối đa 3 lần. */
async function valuesWithRetry(contracts: FeeRateApi): Promise<Awaited<ReturnType<FeeRateApi['values']>>> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await contracts.values();
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
}

/** Cache 1 promise nhưng KHÔNG giữ lại lỗi: lần lỗi bị xoá để TC sau gọi lại (run 02/10: 1 timeout làm 18 TC fail theo). */
function cacheOnce<K, V>(cache: Map<K, Promise<V>>, key: K, make: () => Promise<V>): Promise<V> {
  if (!cache.has(key)) {
    const pending = make();
    cache.set(key, pending);
    pending.catch(() => cache.delete(key));
  }
  return cache.get(key)!;
}

async function master(contracts: FeeRateApi): Promise<Master> {
  masterCache ??= (async () => {
    const { status, body } = await valuesWithRetry(contracts);
    if (status !== 200) throw new Error(`GET /contracts/values → ${status} (the contract account needs COMMERCE_CONTRACTS)`);
    const v = body as ContractValues;
    const twoLetter = <T extends { code: string }>(list: T[]) => list.find((x) => /^[A-Z]{2}$/.test(x.code)) ?? list[0];
    const cats = Object.fromEntries(Object.entries(CATEGORY_CODE).map(([k, code]) => [k, pick(v.categories, code, 'category')]));
    return {
      category: Object.fromEntries(Object.entries(cats).map(([k, c]) => [k, c.id])) as Master['category'],
      categoryName: Object.fromEntries(Object.entries(cats).map(([k, c]) => [k, c.title])) as Master['categoryName'],
      saleType: Object.fromEntries(Object.entries(SALE_TYPE_CODE).map(([k, code]) => [k, pick(v.saleTypes, code, 'sale type').id])) as Master['saleType'],
      label: twoLetter(v.labels).id,
      businessModel: twoLetter(v.businessModels).id,
    };
  })();
  masterCache.catch(() => {
    masterCache = undefined;
  });
  return masterCache;
}

/** Chữ ký chuẩn hoá của họ contract — 2 TC cùng chữ ký dùng chung 1 họ trong cùng RUN. */
export function familySignature(contracts: ContractDef[]): string {
  return JSON.stringify(
    contracts.map((c) => ({ ...c, rows: c.rows.map((r) => ({ ...r, saleType: r.saleType ?? 'ST1', policy: r.policy ?? 'NORMAL', type: r.type ?? 'PERCENT', status: r.status ?? 'ACTIVE' })) })),
  );
}

function commissionBody(m: Master, r: RowDef, date: (v: string) => string): Record<string, unknown> {
  const type = r.type ?? 'PERCENT';
  return {
    categoryId: m.category[r.category],
    saleTypeId: m.saleType[r.saleType ?? 'ST1'],
    commissionPolicy: r.policy ?? 'NORMAL',
    commissionType: type,
    commission: r.rate,
    // MARGIN / FIXED_UNIT theo TC: pgCommissionRate 0, không gửi feeBase.
    pgCommissionRate: type === 'PERCENT' ? 3 : 0,
    ...(type === 'PERCENT' ? { feeBase: 'PRODUCT_PRICE', pgFeeBase: 'PRODUCT_PRICE' } : {}),
    ...(r.period ? { startAt: date(r.period.startAt), endAt: date(r.period.endAt) } : {}),
    status: r.status ?? 'ACTIVE',
  };
}

async function createFamily(contracts: FeeRateApi, m: Master, defs: ContractDef[], tag: string, date: (v: string) => string): Promise<Family> {
  const family: Family = { contracts: {}, rows: {} };
  // Cha trước con: ROOT → ANNEX1/ANNEX2 (parentContractId).
  const ordered = [...defs].sort((a, b) => Number(Boolean(a.parent)) - Number(Boolean(b.parent)));
  for (const def of ordered) {
    const parentId = def.parent ? family.contracts[def.parent] : undefined;
    if (def.parent && !parentId) throw new Error(`Contract ${def.key}: parent ${def.parent} is not defined in the same family`);
    const { status, body } = await contracts.createContractRaw({
      ...(parentId ? { parentContractId: parentId } : {}),
      bizPartnerId: def.partner ?? PARTNER,
      artists: [{ id: 1, name: '[T079] artist' }],
      contractName: `[T079-${RUN}-${tag}] ${def.key}`,
      contractSignedAt: null,
      contractStartAt: date(def.startAt ?? '2020-01-01T00:00:00Z'),
      contractEndAt: date(def.endAt ?? '9999-12-31T00:00:00Z'),
      internalApproveDocumentUrl: 'https://approval.example.com/T079',
      labelTypeId: m.label,
      businessModelTypeId: m.businessModel,
      regionType: 'DOMESTIC',
      commissions: def.rows.map((r) => commissionBody(m, r, date)),
    });
    if (status >= 300 || !body?.id) throw new Error(`POST /contracts (${def.key}) → ${status}: ${JSON.stringify(body).slice(0, 300)}`);
    family.contracts[def.key] = body.id;
    const rows: FeeRow[] = await contracts.feeRows(body.id);
    for (const r of def.rows) {
      const found = rows.find((x) => x.categoryId === m.category[r.category] && x.saleTypeId === m.saleType[r.saleType ?? 'ST1'] && x.policy === (r.policy ?? 'NORMAL') && Number(x.commission) === r.rate);
      if (!found) throw new Error(`Fee row ${r.label} not found on contract ${def.key} after creation`);
      if (r.label in family.rows) throw new Error(`Fee row label ${r.label} is used twice in one family — give each contract's row its own label (e.g. R_A_CT2)`);
      family.rows[r.label] = found.id;
    }
  }
  return family;
}

/** Tháng trống kế tiếp ≥ 2100-01 (sau cycle lớn nhất ≥ 2100 hiện có) — tránh trùng kỳ với tester khác. */
async function nextFreeMonth(review: FeeReviewApi): Promise<{ year: number; month: number }> {
  monthCursor = (async () => {
    const prev = monthCursor ? await monthCursor : undefined;
    let { year, month } = prev ?? { year: 2100, month: 0 };
    if (!prev) {
      for (const c of await review.cycles()) {
        const [y, mo] = (c.periodStart ?? `${c.label}-01`).split('-').map(Number);
        if (y > year || (y === year && mo > month)) [year, month] = [y, mo];
      }
    }
    month += 1;
    if (month > 12) [year, month] = [year + 1, 1];
    return { year, month };
  })();
  return monthCursor;
}

async function createCycle(review: FeeReviewApi): Promise<Seeded['cycles'][string]> {
  const { year, month } = await nextFreeMonth(review);
  const mm = String(month).padStart(2, '0');
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const periodStart = `${year}-${mm}-01`;
  const periodEnd = `${year}-${mm}-${last}`;
  const { status, body } = await review.createCycle(periodStart, periodEnd);
  const id = body?.cycleId ?? body?.id;
  if (status >= 300 || !id) throw new Error(`POST /settlement-cycles ${periodStart} → ${status}: ${JSON.stringify(body).slice(0, 300)}`);
  return { id, label: `${year}-${mm}`, periodStart, periodEnd };
}

/**
 * Dựng dữ liệu cho 1 TC. `contracts` = client có COMMERCE_CONTRACTS (account TOKEN_A theo TC); `review` = client màn
 * 정산 수수료 확인·수정 cùng account. Trả về id thật + hàm `cleanup()` (SQL DELETE theo tiền tố sản phẩm của TC).
 */
export async function seed(contracts: FeeRateApi, review: FeeReviewApi, spec: SeedSpec): Promise<Seeded> {
  const m = await master(contracts);
  const prefix = `T079-${RUN}-${spec.tc}-`;
  const cycles: Seeded['cycles'] = {};
  for (const key of spec.cycles) {
    const shared = !spec.private && key === 'CY_MAIN';
    if (shared) {
      cycles[key] = await cacheOnce(sharedCycleCache, key, () => createCycle(review));
    } else cycles[key] = await createCycle(review);
  }

  // Token ngày theo cycle: "@CY_MAIN.start" | "@CY_MAIN.mid" (ngày 15) | "@CY_MAIN.end" (+ "T…Z" giữ nguyên nếu có).
  const date = (v: string) =>
    v.replace(/@(\w+)\.(start|mid|end)/g, (_, key: string, part: string) => {
      const c = cycles[key];
      if (!c) throw new Error(`Date token @${key}.${part}: cycle ${key} is not in spec.cycles`);
      return part === 'start' ? c.periodStart : part === 'end' ? c.periodEnd : `${c.label}-15`;
    });
  const signature = familySignature(spec.contracts);
  let family: Family = { contracts: {}, rows: {} };
  if (spec.contracts.length) {
    if (spec.private) family = await createFamily(contracts, m, spec.contracts, String(spec.tc), date);
    else {
      family = await cacheOnce(familyCache, signature, () => createFamily(contracts, m, spec.contracts, `shared${familyCache.size + 1}`, date));
    }
  }

  const resolveRow = (label?: string | null) => (label ? (family.rows[label] ?? Number.NaN) : null);
  const products: Record<string, string> = {};
  const fixture: FixtureProduct[] = spec.products.map((p) => {
    const productId = `${prefix}${p.code}`;
    products[p.code] = productId;
    return {
      productId,
      productName: p.name ?? `[T079] ${p.code}`,
      contractId: p.contract === null ? null : (family.contracts[p.contract ?? 'ROOT'] ?? null),
      categoryId: p.category === null ? null : m.category[p.category ?? 'A'],
      saleTypeId: p.saleType === null ? null : m.saleType[p.saleType ?? 'ST1'],
      defaultSlotFeeRowId: resolveRow(p.defaultSlot),
      promotionSlotFeeRowId: resolveRow(p.promotionSlot),
    };
  });
  const broken = fixture.find((f) => Number.isNaN(f.defaultSlotFeeRowId) || Number.isNaN(f.promotionSlotFeeRowId));
  if (broken) throw new Error(`Product ${broken.productId}: a slot fee row label is not defined in the family`);

  const cleanup = () => feeReviewDb.cleanupPrefix(prefix);
  await cleanup();
  await feeReviewDb.insertProducts(fixture);
  await feeReviewDb.insertTargets(
    spec.products.flatMap((p) =>
      p.targets.map((t) => {
        const cycle = cycles[t.cycle];
        if (!cycle) throw new Error(`Product ${p.code}: target cycle ${t.cycle} is not in spec.cycles`);
        return { cycleId: cycle.id, productId: products[p.code], policy: t.policy ?? 'NORMAL', saleLineCount: t.saleLines ?? 10 };
      }),
    ),
  );
  for (const key of spec.close ?? []) {
    const { status, body } = await review.closeCycle(cycles[key].id);
    if (status >= 300) throw new Error(`POST /settlement-cycles/${cycles[key].id}/close → ${status}: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return { run: RUN, prefix, family, cycles, products, master: m, cleanup };
}
