import type { ContractDef, ProductDef, RowDef } from '@utils/fee-review-seed';
import type { Policy } from '@api/fee-review.api';

/**
 * Preset dữ liệu US079 v1 — đúng nhãn và giá trị của pre-condition `input/TESTCASE_US079_v1.md` (mô hình US079_FLOW_GUIDE).
 * Spec dựng `SeedSpec` từ các preset này: chỉ khai báo dòng phí / sản phẩm mà TC của mình liệt kê, KHÔNG thêm dòng thừa —
 * thêm dòng làm đổi bậc ưu tiên quyết định (VD có/không R_B10 đổi SINGLE_CANDIDATE ↔ HIERARCHY).
 * Token ngày `@CY_MAIN.start | .mid | .end` chỉ dùng cho TC `private: true` (họ contract dùng chung không gắn với 1 cycle riêng).
 */

/** Dòng phí theo nhãn TC. */
export const ROW = {
  R_A: { label: 'R_A', category: 'A', rate: 12.5 },
  R_B10: { label: 'R_B10', category: 'B', rate: 10 },
  R_B9: { label: 'R_B9', category: 'B', rate: 9 },
  R_C20: { label: 'R_C20', category: 'C', rate: 20 },
  R_C22: { label: 'R_C22', category: 'C', rate: 22 },
  R_D: { label: 'R_D', category: 'D', rate: 12.5 },
  R_PROMO: { label: 'R_PROMO', category: 'E', policy: 'PROMOTION', rate: 9.5, period: { startAt: '2020-01-01T00:00:00Z', endAt: '9999-12-31T00:00:00Z' } },
  R_E11: { label: 'R_E11', category: 'E', rate: 11 },
  R_MARGIN: { label: 'R_MARGIN', category: 'A', type: 'MARGIN', rate: 30 },
} as const satisfies Record<string, RowDef>;

export type RowLabel = keyof typeof ROW;

/** Dòng phí tuỳ biến (TC đặt giá trị khác preset) — giữ nhãn TC. */
export function row(label: string, def: Omit<RowDef, 'label'>): RowDef {
  return { label, ...def };
}

/**
 * Họ contract theo TC: ROOT (+ ANNEX1 / ANNEX2 con của ROOT) và contract độc lập CT2 / CT3 / CT4.
 * Mỗi phần tử là danh sách dòng phí (nhãn preset hoặc `row(...)`). Bỏ trống contract nào TC không tạo.
 */
export function family(parts: { ROOT?: Array<RowLabel | RowDef>; ANNEX1?: Array<RowLabel | RowDef>; ANNEX2?: Array<RowLabel | RowDef>; CT2?: { rows: Array<RowLabel | RowDef>; endAt?: string }; CT3?: Array<RowLabel | RowDef>; CT4?: Array<RowLabel | RowDef> }): ContractDef[] {
  const rows = (list: Array<RowLabel | RowDef>) => list.map((r) => (typeof r === 'string' ? ({ ...ROW[r] } as RowDef) : r));
  const out: ContractDef[] = [];
  if (parts.ROOT) out.push({ key: 'ROOT', rows: rows(parts.ROOT) });
  if (parts.ANNEX1) out.push({ key: 'ANNEX1', parent: 'ROOT', rows: rows(parts.ANNEX1) });
  if (parts.ANNEX2) out.push({ key: 'ANNEX2', parent: 'ROOT', rows: rows(parts.ANNEX2) });
  if (parts.CT2) out.push({ key: 'CT2', rows: rows(parts.CT2.rows), endAt: parts.CT2.endAt });
  if (parts.CT3) out.push({ key: 'CT3', rows: rows(parts.CT3) });
  if (parts.CT4) out.push({ key: 'CT4', rows: rows(parts.CT4) });
  return out;
}

/** Mẫu sản phẩm `fee_review_fixture_product` theo TC (contract / category / sale type / slot mặc định / slot khuyến mãi). */
export const PRODUCT = {
  P01: { contract: 'ROOT', category: 'A', saleType: 'ST1', defaultSlot: 'R_A' },
  P02: { contract: 'ROOT', category: 'B', saleType: 'ST1', defaultSlot: 'R_B9' },
  P03: { contract: 'ROOT', category: 'B', saleType: 'ST1', defaultSlot: 'R_B10' },
  P04: { contract: 'ROOT', category: 'C', saleType: 'ST1' },
  P05: { contract: 'ROOT', category: 'A', saleType: 'ST1' },
  P06: { contract: 'ROOT', category: 'D', saleType: 'ST1' },
  P09: { contract: 'ROOT', category: 'E', saleType: 'ST1', promotionSlot: 'R_PROMO' },
  P10: { contract: 'ROOT', category: 'A', saleType: 'ST2' },
  P12: { contract: null, category: 'A', saleType: 'ST1' },
  P13: { contract: 'ROOT', category: 'A', saleType: null },
  P14: { contract: 'ROOT', category: 'A', saleType: 'ST1', defaultSlot: 'R_A' },
  P20: { contract: 'CT2', category: 'A', saleType: 'ST1' },
  P21: { contract: 'CT3', category: 'A', saleType: 'ST1' },
  P22: { contract: 'CT4', category: 'B', saleType: 'ST1' },
  X99: { contract: 'ROOT', category: 'A', saleType: 'ST1', defaultSlot: 'R_A' },
} as const satisfies Record<string, Omit<ProductDef, 'code' | 'targets'>>;

export type ProductCode = keyof typeof PRODUCT;

/**
 * 1 sản phẩm theo mẫu + target. `targets` mặc định: CY_MAIN, policy theo mẫu (P09 = PROMOTION), sale lines theo TC.
 * `overrides` cho biến thể TC (VD P05 không category: `{ category: null }`).
 */
export function product(code: ProductCode, targets: Array<{ cycle: string; policy?: Policy; saleLines?: number }> = [{ cycle: 'CY_MAIN' }], overrides: Partial<Omit<ProductDef, 'code' | 'targets'>> = {}): ProductDef {
  const policy: Policy = code === 'P09' ? 'PROMOTION' : 'NORMAL';
  return { code, ...PRODUCT[code], ...overrides, targets: targets.map((t) => ({ policy, ...t })) };
}

/** Lý do correction traceable: `[AUTO-US079] TC_US079_xx <timestamp> — <text>`. */
export function reasonOf(tc: string, text: string): string {
  return `[AUTO-US079] ${tc} ${Date.now()} — ${text}`;
}
