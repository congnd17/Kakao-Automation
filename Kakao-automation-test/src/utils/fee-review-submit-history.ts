import * as fs from 'fs';
import { expect, test } from '@playwright/test';
import type { RowDataPacket } from 'mysql2/promise';
import type { FeeReviewApi, SaveCorrectionBody } from '@api/fee-review.api';
import type { ApiExchange, ApiResult } from '@api/payment-method-policy.api';
import type { FeeReviewListPage } from '@pages/fee-review.page';
import { feeReviewDb } from '@utils/fee-review-db';
import { parseCsv } from '@utils/fee-review.data';
import { FR_KO, FR_TC } from '@utils/fee-review.i18n';

/**
 * Helper dùng chung cho 2 spec US079 v1 nhóm [API] / [Submit & Withdraw] / [History] / [Change Report]:
 * dựng correction qua API, đọc DB CHỈ BẰNG SELECT (đính kèm kết quả làm bằng chứng), kiểm lỗi STL-xxxx, đọc CSV báo cáo kỳ.
 */
export type DbRow = Record<string, unknown>;

/** Thông báo lỗi theo TC (EN ‖ KO). KO lấy từ bundle khi trùng nguyên văn TC. */
export const STL = {
  1011: { en: 'This product already has a correction awaiting approval. Withdraw it before making another.', ko: FR_KO['errCode.pendingExists'] },
  1012: { en: 'A contract rate already covers this product. Change the fee category instead of typing a rate.', ko: FR_KO['errCode.contractRateExists'] },
  1015: { en: 'An approver has already decided this correction. The screen has been refreshed.', ko: FR_KO['errCode.alreadyDecided'] },
  1018: {
    en: 'Check the correction: the reason must be 1 to 200 characters, and a typed rate a positive number with at most two decimals.',
    ko: '수정 내용을 확인해 주세요. 사유는 1~200자, 직접 입력한 요율은 소수 둘째 자리까지의 양수여야 합니다.',
  },
  1019: { en: FR_TC.staleStateEn, ko: FR_TC.staleStateKo },
  1020: { en: 'This correction no longer exists. The screen has been refreshed.', ko: '수정 건이 더 이상 존재하지 않습니다. 화면을 새로 고쳤습니다.' },
} as const;

export const esc = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Danh tính "user A / user B" trong DB / API: tên hiển thị hoặc email đầy đủ của account. */
export const identity = (displayName: string): RegExp => new RegExp(`^${esc(displayName)}(@.+)?$`);

/** Bọc test.step() và đính kèm mọi request/response của các API client gọi trong step (bản nhiều client của makeApiStep). */
export function apiStep(...apis: Array<{ exchanges: ApiExchange[] }>) {
  return async function step(name: string, fn: () => Promise<void>): Promise<void> {
    await test.step(name, async () => {
      const marks = apis.map((a) => a.exchanges.length);
      await fn();
      const exchanges = apis.flatMap((a, i) => a.exchanges.slice(marks[i]));
      await test.info().attach(name, { body: JSON.stringify(exchanges, null, 2), contentType: 'application/json' });
    });
  };
}

/** SELECT chỉ đọc trên schema settlement; kết quả đính kèm report. Câu lệnh khác SELECT bị từ chối. */
export async function select(label: string, query: string, params: unknown[] = []): Promise<DbRow[]> {
  if (!/^\s*SELECT\b/i.test(query)) throw new Error(`Only SELECT is allowed here: ${query}`);
  const rows = (await feeReviewDb.query<RowDataPacket[]>(query, params)) as DbRow[];
  await test.info().attach(`SQL — ${label}`, { body: JSON.stringify({ query, params, rows }, null, 2), contentType: 'application/json' });
  return rows;
}

export async function correctionRow(id: string): Promise<DbRow | undefined> {
  return (await select(`fee_correction ${id}`, 'SELECT * FROM fee_correction WHERE id = ?', [id]))[0];
}

export async function approvalRow(id: number): Promise<DbRow | undefined> {
  return (await select(`change_approval ${id}`, 'SELECT * FROM change_approval WHERE id = ?', [id]))[0];
}

/** Id bản ghi 변경 승인 mà correction đang trỏ tới (fee_correction.change_approval_id). */
export async function approvalIdOf(correctionId: string): Promise<number> {
  const id = (await correctionRow(correctionId))?.change_approval_id;
  if (!id) throw new Error(`Correction ${correctionId} has no change_approval_id`);
  return Number(id);
}

/** Lưu correction (tiền điều kiện) — phải trả 201 và có correctionId. */
export async function saveCorrection(api: FeeReviewApi, cycleId: number, productId: string, body: SaveCorrectionBody): Promise<string> {
  const { status, body: saved } = await api.save(cycleId, productId, body);
  if (status !== 201 || !saved?.correctionId) throw new Error(`Pre-condition: save on ${productId} → ${status}: ${JSON.stringify(saved).slice(0, 300)}`);
  return String(saved.correctionId);
}

/** Gửi duyệt (tiền điều kiện) — phải trả 200. */
export async function submitCorrections(api: FeeReviewApi, ids: string[]): Promise<void> {
  const { status, body } = await api.submit(ids);
  if (status !== 200) throw new Error(`Pre-condition: submit ${ids.join(', ')} → ${status}: ${JSON.stringify(body).slice(0, 300)}`);
}

/** Lệnh dựng tiền điều kiện (duyệt / từ chối / rút / thêm dòng phí) — phải trả 1 trong các status `ok`. */
export async function decide(result: Promise<ApiResult<unknown>>, what: string, ok: number[] = [200]): Promise<void> {
  const { status, body } = await result;
  if (!ok.includes(status)) throw new Error(`Pre-condition: ${what} → ${status}: ${JSON.stringify(body).slice(0, 300)}`);
}

/** Kiểm 1 response bị từ chối: HTTP, mã STL-xxxx và (nếu có) câu thông báo của TC (EN hoặc KO). */
export function expectRefused(res: ApiResult<unknown>, label: string, status: number, code: keyof typeof STL, withMessage = true): void {
  const text = JSON.stringify(res.body ?? '');
  expect.soft(res.status, `${label} HTTP ${status}`).toBe(status);
  expect.soft(text, `${label} error code STL-${code}`).toContain(`STL-${code}`);
  if (withMessage) expect.soft(text, `${label} message "${STL[code].en}" ‖ "${STL[code].ko}"`).toMatch(new RegExp(`${esc(STL[code].en)}|${esc(STL[code].ko)}`));
}

/** Mở (nếu chưa mở) dialog 이번 기 수정 내역, xuất CSV và trả về các dòng của file. */
export async function exportReportCsv(list: FeeReviewListPage): Promise<string[][]> {
  if (!(await list.report.root.isVisible())) await list.openReport();
  await list.click(list.report.exportButton, '내보내기 (Export) button of the period report');
  await expect(list.exporter.root, 'The export dialog opens').toBeVisible();
  await list.exporter.chooseFormat('csv');
  const file = await list.exporter.download();
  const text = fs.readFileSync((await file.path()) as string, 'utf8');
  await test.info().attach('Period report CSV', { body: text, contentType: 'text/csv' });
  if (await list.exporter.root.isVisible()) await list.exporter.cancelButton.click();
  return parseCsv(text);
}

/** Dòng CSV của sản phẩm dạng { header tiếng Anh → giá trị } (header "EN ‖ KO" lấy nửa tiếng Anh). */
export function csvRecord(rows: string[][], productId: string): Record<string, string> | undefined {
  const header = (rows[0] ?? []).map((h) => h.split('‖')[0].trim());
  const idCol = header.indexOf('Product ID');
  const row = rows.slice(1).find((r) => (r[idCol] ?? '').trim() === productId);
  return row ? Object.fromEntries(header.map((h, i) => [h, (row[i] ?? '').trim()])) : undefined;
}

/** Giá trị ô CSV khớp 1 trong các cách viết chấp nhận (cả ô, hoặc 1 nửa "EN ‖ KO"). */
export function csvMatches(value: string | undefined, accepted: string[]): boolean {
  const v = value ?? '';
  return [v, ...v.split('‖')].map((x) => x.trim()).some((x) => accepted.includes(x));
}
