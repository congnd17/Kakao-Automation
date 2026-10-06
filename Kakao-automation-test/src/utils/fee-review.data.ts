import { expect, test } from '@playwright/test';
import type { FeeReviewApi, Policy } from '@api/fee-review.api';
import type { ChangeApproval } from '@api/payment-method-policy.api';

/**
 * Dữ liệu test US079 (정산 수수료 확인·수정). Dev DÙNG CHUNG: TC viết trên seed prototype (900412, 880021, 900318…,
 * cycle 2026-08 mở, 2026-07/06 đóng) — không tồn tại trên dev. Quyết định user 29/09: map từng TC sang fixture
 * `T079-43176-*` có CÙNG kịch bản trong cycle 2026-10 (OPEN, do nghianv8 / thangnd132 tạo), ghi Deviation; TC không có
 * fixture tương ứng → skip kèm lý do. Ghi đầy đủ được phép (lưu → trình → duyệt / trả lại) + dọn dẹp (`FeeReviewState`).
 */

/** Cycle có dữ liệu trên dev (verify GET 29/09). */
export const CYCLE = { id: 449751562857664, label: '2026-10' } as const;
/** Cycle mở cũ nhất = mặc định khi mở màn (defaultSelected), không có dữ liệu. */
export const OLDEST_OPEN_CYCLE = { id: 1005, label: '2026-07' } as const;
/** Cycle đã đóng (không có dữ liệu). */
export const CLOSED_CYCLE = { id: 1007, label: '2026-09' } as const;
/** Cycle mở không có dữ liệu — 01/10 cycle 2026-08 (1006) đã có fixture T079 của tester khác → dùng 2026-07. */
export const EMPTY_OPEN_CYCLE = { id: 1005, label: '2026-07' } as const;

/**
 * Fixture T079 theo kịch bản (tên sản phẩm mô tả kịch bản — verify GET 29/09). Cột "TC seed" = sản phẩm TC dùng.
 * | Fixture | Kịch bản trên dev | TC seed tương ứng |
 * | P01 (NORMAL + PROMOTION) | Resolved, Matches, correction đã duyệt (2 lần, của người khác) | 900190 (có correction đang áp dụng), sản phẩm 2 chính sách |
 * | P02 | Resolved sạch — annex thắng (HIERARCHY), 팬클럽 키트 9.00% (30/09: đang hiệu lực 음반 9.00% — lệch) | 900412 (Resolved) cho Basis |
 * | P03 | Mismatch + nháp của người khác | 900318 (Mismatch) — chỉ đọc |
 * | P04 | Ambiguous — 2 annex đồng hạng | 880021 (Ambiguous) |
 * | P06 | Not computable (bracket) + nháp của người khác | 26010 (Not computable) — chỉ đọc |
 * | P09 (PROMOTION) | PROMOTION thắng (POLICY), 팬클럽 9.50% | 900277 (promotion thắng) |
 * | P10 | No row applies — Tier 2 mở | sản phẩm "zero-fee-row" của TC_62–67 |
 * | P12 / P13 / P99 | No row applies (không binding / không có row cho key / không category) | 900154 (No row applies) |
 * | P14 | Resolved sạch 음반 12.50% — dev đặt tên "for save / submit" (30/09: đang hiệu lực 팬클럽 키트 9.00% — lệch; danh mục ghi chọn lúc chạy qua RATE_MOVING) | 900412 cho các TC ghi |
 */
export const FIXTURE = {
  approvedTwoPolicies: 'T079-43176-P01',
  resolvedAnnex: 'T079-43176-P02',
  mismatchWithDraft: 'T079-43176-P03',
  ambiguous: 'T079-43176-P04',
  notAssignedWithDraft: 'T079-43176-P05',
  notComputable: 'T079-43176-P06',
  promotionWins: 'T079-43176-P09',
  tier2Open: 'T079-43176-P10',
  noBinding: 'T079-43176-P12',
  noRowForKey: 'T079-43176-P13',
  noCategory: 'T079-43176-P99',
  forSave: 'T079-43176-P14',
} as const;

/**
 * Chọn danh mục lúc chạy thay cho tên viết cứng: danh mục làm ĐỔI mức phí (route NEEDS_APPROVAL), khác danh mục đang
 * hiệu lực, không đồng hạng. Lý do (run 30/09): baseline fixture dùng chung bị lệch — P14 không còn 음반 12.50% mà là
 * 팬클럽 키트 9.00%, P02 đổi 팬클럽 키트 → 음반 — nên tên cứng `팬클럽 키트` / `음반` thành "không đổi phí", lưu là áp dụng ngay
 * và bước trình duyệt trả 409.
 */
export const RATE_MOVING = '<rate-moving category>';

/** Tên danh mục làm đổi mức phí của dòng ở thời điểm gọi (dùng khi test chọn trên dropdown UI). */
export async function movingCategory(api: FeeReviewApi, productId: string, policy: Policy = 'NORMAL'): Promise<string> {
  const inForce = (await api.row(CYCLE.id, productId, policy)).inForceCategory;
  const options = (await api.options(CYCLE.id, productId, policy)).categories;
  const usable = options.filter((o) => o.route === 'NEEDS_APPROVAL' && !o.tied && o.categoryName !== inForce);
  // Ưu tiên danh mục có mức phí (30/09: `MD` cần duyệt nhưng không có rate — preview / dialog khác kịch bản TC).
  const moving = usable.find((o) => o.rate !== undefined) ?? usable[0];
  if (!moving) throw new Error(`No rate-moving category is offered for ${productId} / ${policy} (in force: ${inForce ?? '—'}) — the fixture baseline has changed`);
  return moving.categoryName;
}

/**
 * Baseline của 1 dòng lúc chạy: `original` = danh mục đang hiệu lực (đích khôi phục), `moving` / `other` = 2 danh mục làm đổi
 * phí khác nhau (TC hai phiên / "chọn danh mục khác"). Thiếu danh mục thứ hai → `other` = `moving`.
 */
export async function baseline(api: FeeReviewApi, productId: string, policy: Policy = 'NORMAL'): Promise<{ original?: string; moving: string; other: string }> {
  const original = (await api.row(CYCLE.id, productId, policy)).inForceCategory;
  const usable = (await api.options(CYCLE.id, productId, policy)).categories.filter((o) => o.route === 'NEEDS_APPROVAL' && !o.tied && o.categoryName !== original);
  const candidates = [...usable.filter((o) => o.rate !== undefined), ...usable.filter((o) => o.rate === undefined)];
  if (!candidates.length) throw new Error(`No rate-moving category is offered for ${productId} / ${policy} (in force: ${original ?? '—'}) — the fixture baseline has changed`);
  return { original, moving: candidates[0].categoryName, other: (candidates[1] ?? candidates[0]).categoryName };
}

/** Danh mục đang hiệu lực của dòng — đích khôi phục ở teardown (đọc TRƯỚC khi test đổi, không viết cứng). */
export async function inForceCategory(api: FeeReviewApi, productId: string, policy: Policy = 'NORMAL'): Promise<string | undefined> {
  return (await api.row(CYCLE.id, productId, policy)).inForceCategory;
}

/** Chuỗi lý do sinh động, truy vết được: `[AUTO-US079] TC_xx <timestamp> — <nội dung>`. */
export function autoReason(tc: string, text: string): string {
  return `[AUTO-US079] ${tc} ${Date.now()} — ${text}`;
}

type Tracked = { correctionId: string; productId: string; policy: Policy; api: FeeReviewApi; originalCategory?: string; priorCorrectionId?: string };

/**
 * Dọn correction mà test tạo ra trên fixture dùng chung. Teardown đọc trạng thái thật rồi:
 * DRAFT / REJECTED → xoá (discard) · PENDING → rút (bằng đúng account đã trình) rồi xoá ·
 * APPROVED → lưu 1 correction đưa về category gốc (route APPLIES_AT_ONCE vì trùng category hợp đồng) — không xoá được bản
 * đã duyệt (quyết định 29/09). Lỗi của 1 correction không chặn các correction khác; còn sót → throw để report hiện rõ.
 */
export class FeeReviewState {
  private readonly tracked: Tracked[] = [];

  constructor(private readonly testId: string) {}

  /**
   * Dọn trước (safety net): sản phẩm ghi của suite còn correction nháp / chờ / bị trả mà mục lịch sử mới nhất mang nhãn
   * `[AUTO-US079]` (do chính suite tạo, lần chạy trước sót lại) → rút / xoá, để một teardown hỏng không làm fail dây chuyền.
   * Correction của người khác (không có nhãn) không bị đụng tới.
   */
  static async sweep(api: FeeReviewApi, productIds: string[], policyOf: (id: string) => Policy = () => 'NORMAL'): Promise<void> {
    for (const id of productIds) {
      const c = (await api.row(CYCLE.id, id, policyOf(id))).correction;
      if (!c || !['DRAFT', 'PENDING', 'REJECTED', 'WITHDRAWN'].includes(c.state)) continue;
      const newest = (await api.history(CYCLE.id, id))[0] as { reason?: string } | undefined;
      if (!String(newest?.reason ?? '').includes('[AUTO-US079]')) continue;
      if (c.state === 'PENDING') await api.withdraw(c.correctionId);
      await expect.poll(async () => (await api.discard(c.correctionId)).status, { message: `Sweep ${id}`, timeout: 20_000 }).toBeLessThan(300);
    }
  }

  /** Lưu nháp Tier 1 sang `categoryName` (hoặc `RATE_MOVING`) qua API (tiền điều kiện) — trả correctionId. */
  async draft(api: FeeReviewApi, productId: string, categoryName: string, reason: string, policy: Policy = 'NORMAL'): Promise<string> {
    return (await this.draftWithCategory(api, productId, categoryName, reason, policy)).correctionId;
  }

  private async draftWithCategory(api: FeeReviewApi, productId: string, categoryName: string, reason: string, policy: Policy): Promise<{ correctionId: string; category: string }> {
    const row = await api.row(CYCLE.id, productId, policy);
    const wanted = categoryName === RATE_MOVING ? await movingCategory(api, productId, policy) : categoryName;
    const option = (await api.options(CYCLE.id, productId, policy)).categories.find((c) => c.categoryName === wanted);
    if (!option) throw new Error(`Category "${wanted}" is not offered for ${productId}`);
    const { status, body } = await api.save(CYCLE.id, productId, { policy, tier: 'ASSIGNMENT', commissionCategoryId: option.categoryId, reason, previewRoute: option.route });
    const correctionId = body?.correctionId ?? (await api.row(CYCLE.id, productId, policy)).correction?.correctionId;
    if (status >= 300 || !correctionId) throw new Error(`Could not save a draft on ${productId} for ${this.testId} (status ${status})`);
    this.track(api, correctionId, productId, policy, row.inForceCategory, row.correction?.correctionId);
    return { correctionId, category: wanted };
  }

  /** Nháp + trình duyệt → PENDING; trả { correctionId, approval, category } (request 변경 승인 mới nhất của sản phẩm). */
  async pending(api: FeeReviewApi, productId: string, categoryName: string, reason: string, policy: Policy = 'NORMAL'): Promise<{ correctionId: string; approval: ChangeApproval; category: string }> {
    const { correctionId, category } = await this.draftWithCategory(api, productId, categoryName, reason, policy);
    const { status } = await api.submit([correctionId]);
    if (status >= 300) throw new Error(`Could not submit ${productId} for ${this.testId} (status ${status})`);
    return { correctionId, approval: await this.approvalOf(api, productId, reason), category };
  }

  /** Request 변경 승인 của sản phẩm mang đúng lý do đã trình. */
  async approvalOf(api: FeeReviewApi, productId: string, reason: string): Promise<ChangeApproval> {
    // Item của danh sách chỉ mang targetDisplay (không có lý do) — lọc theo sản phẩm rồi đọc chi tiết để khớp lý do (29/09).
    const pool = [...(await api.feeRuleApprovals()), ...(await api.latestApprovals())];
    const unique = [...new Map(pool.map((a) => [a.id, a])).values()].sort((x, y) => String(y.requestedAt).localeCompare(String(x.requestedAt)));
    for (const a of unique.slice(0, 30)) {
      const detail = JSON.stringify((await api.approval(a.id)).body);
      if (detail.includes(productId) && detail.includes(reason.slice(0, 30))) return a;
    }
    // Dự phòng: chi tiết không mang mã sản phẩm / lý do → request Fee Rule PENDING mới nhất (suite chạy tuần tự, 1 worker).
    const newest = (await api.feeRuleApprovals()).filter((a) => a.approvalStatus === 'PENDING').sort((x, y) => String(y.requestedAt).localeCompare(String(x.requestedAt)))[0];
    if (newest) return newest;
    throw new Error(`No Fee Rule approval found for ${productId} (${this.testId})`);
  }

  /** Ghi nhận correction test tạo qua UI để teardown dọn. */
  track(api: FeeReviewApi, correctionId: string, productId: string, policy: Policy = 'NORMAL', originalCategory?: string, priorCorrectionId?: string): void {
    if (!this.tracked.some((t) => t.correctionId === correctionId)) this.tracked.push({ correctionId, productId, policy, api, originalCategory, priorCorrectionId });
  }

  /** Ghi nhận correction đang nằm trên dòng (sau khi lưu qua UI). */
  async trackRow(api: FeeReviewApi, productId: string, policy: Policy = 'NORMAL', originalCategory?: string): Promise<string | undefined> {
    const id = (await api.row(CYCLE.id, productId, policy)).correction?.correctionId;
    if (id) this.track(api, id, productId, policy, originalCategory);
    return id;
  }

  /**
   * Teardown theo SẢN PHẨM (không theo id): rút một correction đang chờ duyệt sẽ đưa nó về nháp, có thể mang id mới (lần chạy
   * 29/09: nháp của TC_44 bị kẹt trên P14) → mỗi vòng đọc correction HIỆN TẠI của sản phẩm + chính sách rồi xử lý:
   * PENDING → rút (account đã trình, dự phòng approver) · DRAFT / REJECTED / WITHDRAWN → xoá · APPROVED / APPLIED do test
   * tạo → lưu 1 correction đưa về category gốc (APPLIES_AT_ONCE) rồi dừng. Correction có sẵn trước test (của người khác)
   * không bị đụng tới. Còn sót nháp / chờ duyệt / bị trả → throw để report hiện rõ.
   */
  async dispose(approverApi?: FeeReviewApi): Promise<void> {
    const failed: string[] = [];
    const targets = new Map<string, Tracked>();
    for (const t of this.tracked) if (!targets.has(`${t.productId}|${t.policy}`)) targets.set(`${t.productId}|${t.policy}`, t);
    for (const t of targets.values()) {
      try {
        for (let round = 0; round < 4; round++) {
          const c = (await t.api.row(CYCLE.id, t.productId, t.policy)).correction;
          if (!c || (t.priorCorrectionId && c.correctionId === t.priorCorrectionId)) break;
          if (c.state === 'PENDING') {
            const withdrawn = await t.api.withdraw(c.correctionId);
            if (withdrawn.status >= 300 && approverApi) await approverApi.withdraw(c.correctionId);
            // Ngay sau khi rút, danh sách có thể tạm không trả correction rồi mới hiện lại dạng nháp (lần chạy 29/09 16:28)
            // → xoá luôn theo đúng id, thử lại tới khi server nhận.
            await expect.poll(async () => (await t.api.discard(c.correctionId)).status, { message: `Discard ${c.correctionId} after withdrawing`, timeout: 20_000 }).toBeLessThan(300);
          } else if (c.state === 'DRAFT' || c.state === 'REJECTED' || c.state === 'WITHDRAWN') {
            const discarded = await t.api.discard(c.correctionId);
            if (discarded.status >= 300 && approverApi) await approverApi.discard(c.correctionId);
          } else if ((c.state === 'APPROVED' || c.state === 'APPLIED') && t.originalCategory) {
            const option = (await t.api.options(CYCLE.id, t.productId, t.policy)).categories.find((o) => o.categoryName === t.originalCategory);
            const restoreReason = autoReason(this.testId, 'restore to the category in force before the test');
            const saved = option ? await t.api.save(CYCLE.id, t.productId, { policy: t.policy, tier: 'ASSIGNMENT', commissionCategoryId: option.categoryId, reason: restoreReason, previewRoute: option.route }) : undefined;
            // Khôi phục làm ĐỔI mức phí (route NEEDS_APPROVAL) chỉ lưu được nháp → phải trình + người duyệt duyệt, không thì dòng
            // bị kẹt nháp và baseline lệch (run 30/09, TC_91). Bản ghi duyệt khôi phục nằm lại vĩnh viễn trong lịch sử.
            if (saved?.body?.correctionId && saved.body.routeTaken === 'NEEDS_APPROVAL' && approverApi) {
              await t.api.submit([saved.body.correctionId]);
              const approval = await this.approvalOf(t.api, t.productId, restoreReason);
              await approverApi.approve(approval.id);
            }
            // Correction khôi phục trùng danh mục commerce đang gán thì hệ thống tự retire ngay (run 30/09) — danh mục đang
            // hiệu lực có thể KHÔNG về lại như cũ. Ghi rõ vào report thay vì bỏ qua lặng lẽ.
            const restored = (await t.api.row(CYCLE.id, t.productId, t.policy)).inForceCategory;
            if (restored !== t.originalCategory) {
              test.info().annotations.push({ type: 'Restore note', description: `${t.productId}/${t.policy}: in force is ${restored ?? '—'} after the restore to ${t.originalCategory} (auto-retired by the system) — shared fixture baseline changed` });
            }
            break;
          } else break;
        }
        const after = (await t.api.row(CYCLE.id, t.productId, t.policy)).correction;
        if (after && after.correctionId !== t.priorCorrectionId && ['DRAFT', 'PENDING', 'REJECTED'].includes(after.state)) failed.push(`${t.productId}:${after.state}`);
      } catch (error) {
        failed.push(`${t.productId}:${(error as Error).message.slice(0, 60)}`);
      }
    }
    if (failed.length) throw new Error(`Teardown could not clean up ${failed.join(', ')} after ${this.testId}`);
  }
}

/** Đọc CSV (RFC 4180: dấu phẩy, ngoặc kép, xuống dòng trong ô) → mảng dòng; bỏ BOM đầu file. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}
