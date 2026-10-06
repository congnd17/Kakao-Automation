import { BuildReceipt, ReceiptReconciliationApi } from '@api/receipt-reconciliation.api';

/**
 * US020 — chuỗi UI (verify trên dev 30/09 bằng MCP + bundle frontend) và tìm dữ liệu dev lúc chạy.
 * Dev dùng chung, dữ liệu seed của TC (`BP-0001`, `GRN-0830`, `RG-2026-09-0007`…) không tồn tại → mọi TC tìm bản ghi
 * thật có cùng kịch bản qua API ở Arrange, không có thì skip kèm lý do (quyết định 30/09).
 */
export const RR_TEXT = {
  noRows: '조회 결과가 없습니다.',
  noMismatches: '불일치 항목이 없습니다.',
  rangeInvalid: '종료일은 시작일보다 빠를 수 없습니다.',
  buildRequired: '입고 전표와 증빙을 각각 1건 이상 선택하세요.',
  awaitingCompletion: '입고 완료 확인 대기',
  noGoodsReceipt: '입고 전표 없음 — 이번 버전에서 대사하지 않음',
  groupNotFound: '해당 대사 묶음이 존재하지 않습니다.',
  /** Câu banner "chưa gom nhóm" — số phiếu / số chứng từ ghép vào. */
  ungroupedBanner: (receipts: number, documents: number) =>
    `이 기간에 아직 어느 대사 묶음에도 포함되지 않은 입고 전표 ${receipts}건, 증빙 ${documents}건이 있습니다.`,
} as const;

/** 9 cột bảng nhóm theo thứ tự TC_US020_017 (period · group no. · biz partner · receipts · documents · SKU lines · mismatches · difference · status). */
export const GROUP_COLUMNS = ['대사 기간', '대사 묶음 번호', '비즈파트너', '입고 전표 수', '증빙 수', '품목 수', '불일치 수', '차액', '상태'];

/** Giá trị filter 상태 theo vòng đời (TC_US020_020): giá trị "tất cả" đứng đầu rồi 5 trạng thái. */
export const STATUS_OPTIONS = ['전체', '대사 전', '일치', '불일치', '해결됨', '마감됨'];

const KST_OFFSET_MS = 9 * 60 * 60_000;

/** Ngày hôm nay theo giờ Hàn Quốc (app tính kỳ theo KST) — `yyyy-MM-dd`. */
export function kstToday(): string {
  return new Date(Date.now() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Tháng hiện tại theo KST — `yyyy-MM`. */
export function currentPeriod(): string {
  return kstToday().slice(0, 7);
}

/** `count` tháng `yyyy-MM` tính lùi từ tháng hiện tại (mới nhất trước). */
export function recentPeriods(count = 12): string[] {
  const [year, month] = currentPeriod().split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    return d.toISOString().slice(0, 7);
  });
}

/** Lùi `months` tháng từ một ngày `yyyy-MM-dd` (cùng ngày trong tháng, kẹp về ngày cuối nếu tháng ngắn hơn). */
export function minusMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m - 1 - months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 - months, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

/** Ngày đầu / cuối của một kỳ `yyyy-MM`. */
export function periodBounds(period: string): { from: string; to: string } {
  const [y, m] = period.split('-').map(Number);
  return { from: `${period}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}

/** Phiếu nhập đầu tiên của kỳ thoả điều kiện — không có trả `undefined` để test skip kèm lý do. */
export async function findReceipt(
  api: ReceiptReconciliationApi,
  period: string,
  match: (receipt: BuildReceipt) => boolean,
): Promise<BuildReceipt | undefined> {
  return (await api.buildReceipts(period)).find(match);
}
