import type { StockLang } from '@utils/stock.i18n';

/**
 * Quy ước chung cho spec US134 (input/US134_TestCase_EN_v18.md):
 *  - Tags: `US134`, `stock` + nhóm TC ([UI] → 'ui', [List] → 'list'…).
 *  - TC ghi "run once in Korean, then again in English" → chạy TRỌN chuỗi Act/Assert của TC 2 lượt, tên step mang hậu tố
 *    ngôn ngữ (`Act: Step 1 — … (Korean)`), số step mỗi lượt khớp đúng số dòng Steps/Expected của TC.
 */
export const LANG_SUFFIX: Record<StockLang, string> = { ko: '(Korean)', en: '(English)' };

export function stockTags(group: string): string[] {
  return ['US134', 'stock', group];
}

/** Câu chuẩn ghi trong description về dữ liệu dùng chung (world tự seed). */
export const WORLD_NOTE =
  'Data: the suite builds its own copy of the TC demo world (12 rows tagged T134…, Demo Partner A/B played by real dev partners, automation warehouses for CJ Incheon Aam / CJ Daegu / Demo Pickup Point) and removes it afterwards.';

/** Description mặc định cho TC [Permission] — account automation có mọi quyền nên không chứng minh được giới hạn role. */
export const PERMISSION_SKIP_REASON =
  'Blocked in the TC file — needs an account holding exactly that role / read-only flag on the stock permission code; the automation account is a bypass account with every permission.';
