import { PaymentMethodPolicyApi } from '@api/payment-method-policy.api';
import type { ChannelKey, PaymentMethodPolicy, PolicyCreateBody } from '@api/payment-method-policy.api';

/**
 * Test data dùng chung cho các spec US080 (결제수단 정책). Môi trường dev DÙNG CHUNG — xem task/memory:
 * - LIVE_ROW: dòng automation sở hữu, được phép sửa/gửi duyệt rồi trả về.
 * - SEED_ROW: dòng seed thật chưa sửa lần nào (version 0) — CHỈ đọc / mở dialog rồi 뒤로, không lưu.
 * - AUTOMATION_PG_POOL: PG "inert" (TC_028) — tạo policy mới không sinh dòng định mức thật. Register không có xoá
 *   (BR-18) nên mỗi lần tạo tiêu thụ vĩnh viễn 1 tổ hợp.
 */
export const LIVE_ROW: ChannelKey = { pgCode: 'NICEPAY', paymentMethodCode: 'KAKAO_PAY', currency: 'KRW' };
export const SEED_ROW: ChannelKey = { pgCode: 'NICEPAY', paymentMethodCode: 'CREDIT_CARD', currency: 'KRW' };
export const AUTOMATION_PG_POOL = ['GOOGLE_PLAY', 'APP_STORE'];

export const METHOD_CODES = [
  'ZERO_PAYMENT',
  'CREDIT_CARD',
  'KAKAO_PAY',
  'BANK_TRANSFER',
  'CREDIT_CARD_GLOBAL',
  'PAYPAL',
  'ALIPAY',
  'GOOGLE_PLAY',
  'APP_STORE',
];

export const MSG_DUPLICATE_SUFFIX = '채널에 대한 정책이 이미 존재합니다. 새로 만들지 말고 기존 정책을 여세요.';

/** Lý do traceable: nhìn vào hàng đợi/lịch sử biết ngay test nào tạo ra. */
export function traceReason(tcId: string): string {
  return `auto_${tcId}_${Date.now()}`;
}

export function formatChannelKey(key: ChannelKey): string {
  return `${key.pgCode} · ${key.paymentMethodCode} · ${key.currency}`;
}

export function buildPool(methodCodes: string[], currencies: string[]): ChannelKey[] {
  return AUTOMATION_PG_POOL.flatMap((pgCode) =>
    methodCodes.flatMap((paymentMethodCode) => currencies.map((currency) => ({ pgCode, paymentMethodCode, currency }))),
  );
}

/** Tổ hợp đầu tiên trong pool automation chưa có dòng nào — theo catalog thật của server. */
export async function pickUnusedKey(api: PaymentMethodPolicyApi): Promise<ChannelKey> {
  const { body: catalog } = await api.getCatalog();
  return api.findUnusedKey(buildPool(catalog.paymentMethodCodes, catalog.currencies));
}

/**
 * Cặp PG×결제수단 trong pool automation có ≥1 dòng và còn ≥1 currency trống — cho kịch bản "trùng key → đổi
 * currency sang tổ hợp trống" (TC_026, TC_035). `existing` = các dòng hiện có của cặp đó.
 */
export async function pickPairWithFreeCurrency(
  api: PaymentMethodPolicyApi,
): Promise<{ taken: ChannelKey; free: ChannelKey; existingCount: number }> {
  const [{ body: catalog }, { body: page }] = [await api.getCatalog(), await api.list({}, 1000)];
  for (const pgCode of AUTOMATION_PG_POOL) {
    for (const paymentMethodCode of catalog.paymentMethodCodes) {
      const rows = page.content.filter((row) => row.pgCode === pgCode && row.paymentMethodCode === paymentMethodCode);
      const freeCurrency = catalog.currencies.find((currency) => !rows.some((row) => row.currency === currency));
      if (rows.length > 0 && freeCurrency) {
        return {
          taken: { pgCode, paymentMethodCode, currency: rows[0].currency },
          free: { pgCode, paymentMethodCode, currency: freeCurrency },
          existingCount: rows.length,
        };
      }
    }
  }
  throw new Error('No PG × 결제수단 pair in the automation pool has both a used and a free currency — extend the pool');
}

/**
 * Tạo policy qua API (account gốc) rồi duyệt bằng account APPROVER → dòng live. Dùng cho pre-condition
 * "create request already approved" (TC_024). Ném lỗi rõ ràng nếu bước nào bị server từ chối.
 */
export async function createApprovedPolicy(
  submitter: PaymentMethodPolicyApi,
  approver: PaymentMethodPolicyApi,
  body: PolicyCreateBody,
): Promise<PaymentMethodPolicy> {
  const created = await submitter.create<{ id: number }>(body);
  if (created.status >= 300) throw new Error(`Create ${formatChannelKey(body)} was refused with ${created.status}`);
  const pendingRow = (await submitter.get(created.body.id)).body;
  if (!pendingRow.pending) throw new Error(`Create ${formatChannelKey(body)} did not enter the approval queue`);
  const approved = await approver.approveChange(pendingRow.pending.changeApprovalId);
  if (approved.status >= 300) throw new Error(`Approving ${formatChannelKey(body)} was refused with ${approved.status}`);
  // Duyệt có thể tạo bản ghi mới (id mới) — lấy dòng live theo KEY, không theo id vừa tạo.
  return submitter.getRowByKey(body);
}

/** 4 trường chính sách của 1 dòng — đủ để khôi phục dòng live về đúng trạng thái trước test. */
export interface PolicyValues {
  fxSourceStrategy: string;
  cycleType: string;
  cycleAnchorWeekday: string | null;
  cycleLagDays: number;
}

export const valuesOf = (row: PaymentMethodPolicy): PolicyValues => ({
  fxSourceStrategy: row.fxSourceStrategy,
  cycleType: row.cycleType,
  cycleAnchorWeekday: row.cycleAnchorWeekday ?? null,
  cycleLagDays: row.cycleLagDays,
});

export const otherStrategy = (strategy: string) => (strategy === 'ALREADY_KRW' ? 'BANK_SETTLEMENT_RATE' : 'ALREADY_KRW');

/**
 * Dòng live của LIVE_ROW, không còn request treo. ⚠️ Tra theo KEY: duyệt 1 thay đổi 환율 적용 방식 tạo bản ghi MỚI (id
 * mới), bản cũ chuyển SUPERSEDED — id của dòng live không cố định (quan sát 28/09).
 */
export async function liveRow(api: PaymentMethodPolicyApi): Promise<PaymentMethodPolicy> {
  return api.getEditableRow(LIVE_ROW);
}

/** Đổi 정산 주기 / 기준 요일 / 지연일수 — áp dụng ngay, không qua duyệt (BR-7.V1). */
export async function setCadence(
  api: PaymentMethodPolicyApi,
  cadence: { cycleType: string; cycleAnchorWeekday: string | null; cycleLagDays: number },
): Promise<PaymentMethodPolicy> {
  const row = await liveRow(api);
  const result = await api.update(row.id, {
    ...PaymentMethodPolicyApi.toUpdateBody(row),
    cycleType: cadence.cycleType,
    cycleAnchorWeekday: cadence.cycleAnchorWeekday,
    cycleLagDays: String(cadence.cycleLagDays),
  });
  if (result.status >= 300) throw new Error(`Setting the cadence of ${formatChannelKey(LIVE_ROW)} was refused with ${result.status}`);
  return liveRow(api);
}

/** Gửi đổi 환율 적용 방식 sang giá trị còn lại (vào hàng đợi duyệt) — trả về dòng đang chờ duyệt. */
export async function submitStrategyChange(api: PaymentMethodPolicyApi, reason: string): Promise<PaymentMethodPolicy> {
  const row = await liveRow(api);
  const result = await api.update(row.id, { ...PaymentMethodPolicyApi.toUpdateBody(row), fxSourceStrategy: otherStrategy(row.fxSourceStrategy), changeReason: reason });
  if (result.status >= 300) throw new Error(`Submitting the 환율 적용 방식 change was refused with ${result.status}`);
  const pendingRow = (await api.get(row.id)).body;
  if (!pendingRow.pending) throw new Error('The 환율 적용 방식 change did not enter the approval queue');
  return pendingRow;
}

/**
 * Trả LIVE_ROW về `baseline`: 회수 request treo; nhịp chu kỳ khác → sửa thẳng; 환율 적용 방식 khác (chỉ xảy ra sau khi đã
 * DUYỆT) → gửi đổi ngược + duyệt bằng account APPROVER.
 */
export async function restoreLiveRow(
  submitter: PaymentMethodPolicyApi,
  baseline: PolicyValues,
  approver?: PaymentMethodPolicyApi,
): Promise<void> {
  let row = await liveRow(submitter);
  if (row.fxSourceStrategy !== baseline.fxSourceStrategy) {
    if (!approver) throw new Error(`${formatChannelKey(LIVE_ROW)} 환율 적용 방식 differs from the baseline and no approver client was given`);
    const pendingRow = await submitStrategyChange(submitter, traceReason('restore'));
    await approver.approveChange(pendingRow.pending!.changeApprovalId);
    row = await liveRow(submitter);
  }
  const cadenceDiffers =
    row.cycleType !== baseline.cycleType ||
    (row.cycleAnchorWeekday ?? null) !== baseline.cycleAnchorWeekday ||
    row.cycleLagDays !== baseline.cycleLagDays;
  if (cadenceDiffers) await setCadence(submitter, baseline);
}

/** Dọn hàng đợi duyệt dùng chung: 회수 request tạo mới còn treo của key (key vẫn bị chiếm vĩnh viễn — BR-18). */
export async function withdrawPendingCreate(api: PaymentMethodPolicyApi, key: ChannelKey): Promise<void> {
  const { body } = await api.getByKey(key);
  if (body.holder?.pending) {
    await api.withdraw(body.holder.id);
  }
}
