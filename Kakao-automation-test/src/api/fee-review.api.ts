import { APIRequest, APIRequestContext } from '@playwright/test';
import { AccountRole, getValidAccessToken } from '@utils/auth-token';
import { env } from '@utils/env.config';
import type { ApiExchange, ApiResult, ChangeApproval } from '@api/payment-method-policy.api';

/**
 * Register 정산 수수료 확인·수정 (US079) — endpoint lấy từ bundle frontend, verify GET 29/09:
 * - GET  /settlement-cycles                                            (danh sách cycle + trạng thái)
 * - GET  /fee-review/cycles/{cycleId}/products?bucket|problem|keyword|page|size
 * - GET  /fee-review/cycles/{cycleId}/products/{productId}/trace?policy
 * - GET  /fee-review/cycles/{cycleId}/products/{productId}/correction-options?policy
 * - GET  /fee-review/cycles/{cycleId}/products/{productId}/history?page|size
 * - POST /fee-review/cycles/{cycleId}/products/{productId}/corrections  {policy, tier, commissionCategoryId|overrideRate, reason, previewRoute, correctionId?}
 * - GET  /fee-review/cycles/{cycleId}/corrections?page|size (+ /export?format)
 * - POST /fee-review/corrections/submit {correctionIds} · POST /fee-review/corrections/{id}/withdraw · DELETE /fee-review/corrections/{id}
 * - GET  /change-approvals?targetType=FEE_RULE · POST /change-approvals/{id}/approve | /reject {rejectReason}
 */
const API = '/api/v1';
const BASE = `${API}/fee-review`;

export type Bucket = 'NEEDS_REVIEW' | 'NOT_COMPUTABLE' | 'PROVISIONAL' | 'CORRECTED_THIS_PERIOD' | 'RESOLVED_CLEANLY';
export type Problem = 'NO_ROW' | 'AMBIGUOUS' | 'ASSIGNED_NE_RESOLVED' | 'SOURCE_NEEDS_FIXING';
export type Policy = 'NORMAL' | 'PROMOTION';
export type CorrectionState = 'DRAFT' | 'PENDING' | 'APPLIED' | 'APPROVED' | 'REJECTED' | 'RETIRED' | 'WITHDRAWN';

export interface SettlementCycle {
  cycleId: number;
  label: string;
  periodStart?: string;
  periodEnd?: string;
  status: 'OPEN' | 'CLOSED';
  defaultSelected: boolean;
  coverageIncomplete: boolean;
}

export interface FeeReviewRow {
  productId: string;
  productName?: string;
  policy: Policy;
  status: string;
  verdict: string;
  bucket: string;
  inForceCategory?: string;
  inForceRate?: string;
  rateHandKeyed: boolean;
  correction?: { correctionId: string; state: CorrectionState; tier: string } | null;
  problems: string[];
}

export interface FeeReviewPage {
  content: FeeReviewRow[];
  totalElements: number;
  totalPages: number;
  buckets: { total: number; notComputable: number; needsReview: number; correctedThisPeriod: number; provisional: number; resolvedCleanly: number };
  problems: { noRow: number; ambiguous: number; assignedNeResolved: number; sourceNeedsFixing: number };
  computedAt?: string;
  provisional?: boolean;
  emptyStateCode?: string;
}

export interface CorrectionOption {
  categoryId: number;
  categoryName: string;
  rate?: string;
  tied: boolean;
  route: 'APPLIES_AT_ONCE' | 'NEEDS_APPROVAL';
}

export interface CorrectionOptions {
  correctable: boolean;
  currentRate?: string;
  categories: CorrectionOption[];
  tier2Open: boolean;
}

export interface SaveCorrectionBody {
  policy: Policy;
  tier: 'ASSIGNMENT' | 'RATE_OVERRIDE';
  commissionCategoryId?: number;
  overrideRate?: string;
  reason: string;
  previewRoute?: string;
  correctionId?: string;
}

export interface SavedCorrection {
  correctionId?: string;
  routeTaken?: string;
  state?: CorrectionState;
  code?: string;
}

export interface PeriodCorrection {
  changeNo: string;
  productId: string;
  tier: string;
  fieldsChanged: string[];
  categoryBefore?: string;
  categoryAfter?: string;
  rateBefore?: string;
  rateAfter?: string;
  applied: boolean;
  approvalState: string;
  maker: string;
  reason: string;
  rejectReason?: string;
}

/** API object của US079 — đọc trạng thái đối chiếu và dựng / dọn tiền điều kiện. Ghi mọi exchange làm bằng chứng. */
export class FeeReviewApi {
  readonly exchanges: ApiExchange[] = [];

  constructor(
    private readonly request: APIRequestContext,
    private readonly role: AccountRole,
  ) {}

  async cycles(): Promise<SettlementCycle[]> {
    return (await this.send<{ items: SettlementCycle[] }>('GET', `${API}/settlement-cycles`)).body.items;
  }

  /** Tạo cycle mới (pre-condition TC US079 v1 "Create cycle"). Cycle KHÔNG có API xoá. */
  async createCycle(periodStart: string, periodEnd: string): Promise<ApiResult<{ id?: number; cycleId?: number }>> {
    return this.send('POST', `${API}/settlement-cycles`, { periodStart, periodEnd });
  }

  /** Đóng cycle — KHÔNG mở lại được. */
  async closeCycle(cycleId: number): Promise<ApiResult<unknown>> {
    return this.send('POST', `${API}/settlement-cycles/${cycleId}/close`);
  }

  async cycle(cycleId: number): Promise<ApiResult<SettlementCycle & Record<string, unknown>>> {
    return this.send('GET', `${API}/settlement-cycles/${cycleId}`);
  }

  async products(cycleId: number, query: { bucket?: Bucket; problem?: Problem; keyword?: string; page?: number; size?: number } = {}): Promise<FeeReviewPage> {
    const params = new URLSearchParams({ page: String(query.page ?? 0), size: String(query.size ?? 100) });
    if (query.bucket) params.set('bucket', query.bucket);
    if (query.problem) params.set('problem', query.problem);
    if (query.keyword) params.set('keyword', query.keyword);
    return (await this.send<FeeReviewPage>('GET', `${BASE}/cycles/${cycleId}/products?${params.toString()}`)).body;
  }

  /** Dòng của sản phẩm + chính sách (mỗi cặp là 1 dòng độc lập trên list). */
  async row(cycleId: number, productId: string, policy: Policy = 'NORMAL'): Promise<FeeReviewRow> {
    const row = (await this.products(cycleId, { keyword: productId })).content.find((r) => r.productId === productId && r.policy === policy);
    if (!row) throw new Error(`Fee review row ${productId} / ${policy} not found in cycle ${cycleId}`);
    return row;
  }

  async trace(cycleId: number, productId: string, policy: Policy = 'NORMAL'): Promise<ApiResult<Record<string, unknown>>> {
    return this.send('GET', `${BASE}/cycles/${cycleId}/products/${encodeURIComponent(productId)}/trace?policy=${policy}`);
  }

  async options(cycleId: number, productId: string, policy: Policy = 'NORMAL'): Promise<CorrectionOptions> {
    return (await this.send<CorrectionOptions>('GET', `${BASE}/cycles/${cycleId}/products/${encodeURIComponent(productId)}/correction-options?policy=${policy}`)).body;
  }

  async history(cycleId: number, productId: string): Promise<Array<Record<string, unknown>>> {
    const body = (await this.send<{ items?: Array<Record<string, unknown>>; content?: Array<Record<string, unknown>> }>('GET', `${BASE}/cycles/${cycleId}/products/${encodeURIComponent(productId)}/history?page=0&size=100`)).body;
    return body.items ?? body.content ?? [];
  }

  async periodCorrections(cycleId: number): Promise<PeriodCorrection[]> {
    return (await this.send<{ content: PeriodCorrection[] }>('GET', `${BASE}/cycles/${cycleId}/corrections?page=0&size=100`)).body.content ?? [];
  }

  async save(cycleId: number, productId: string, body: SaveCorrectionBody): Promise<ApiResult<SavedCorrection>> {
    return this.send('POST', `${BASE}/cycles/${cycleId}/products/${encodeURIComponent(productId)}/corrections`, body);
  }

  async submit(correctionIds: string[]): Promise<ApiResult<{ submitted?: number }>> {
    return this.send('POST', `${BASE}/corrections/submit`, { correctionIds });
  }

  async withdraw(correctionId: string): Promise<ApiResult<unknown>> {
    return this.send('POST', `${BASE}/corrections/${encodeURIComponent(correctionId)}/withdraw`);
  }

  async discard(correctionId: string): Promise<ApiResult<unknown>> {
    return this.send('DELETE', `${BASE}/corrections/${encodeURIComponent(correctionId)}`);
  }

  /** Request 변경 승인 thuộc register Fee Rule (mới nhất trước). */
  async feeRuleApprovals(): Promise<ChangeApproval[]> {
    return (await this.send<{ items: ChangeApproval[] }>('GET', `${API}/change-approvals?page=0&size=100&targetType=FEE_RULE`)).body.items ?? [];
  }

  /** Request 변경 승인 mới nhất (mọi register) — dự phòng khi register của US079 khác FEE_RULE. */
  async latestApprovals(): Promise<ChangeApproval[]> {
    return (await this.send<{ items: ChangeApproval[] }>('GET', `${API}/change-approvals?page=0&size=50`)).body.items ?? [];
  }

  async approval(changeApprovalId: number): Promise<ApiResult<ChangeApproval & Record<string, unknown>>> {
    return this.send('GET', `${API}/change-approvals/${changeApprovalId}`);
  }

  async approve(changeApprovalId: number): Promise<ApiResult<unknown>> {
    return this.send('POST', `${API}/change-approvals/${changeApprovalId}/approve`);
  }

  async reject(changeApprovalId: number, rejectReason: string): Promise<ApiResult<unknown>> {
    return this.send('POST', `${API}/change-approvals/${changeApprovalId}/reject`, { rejectReason });
  }

  /** Tải file export (list hoặc báo cáo kỳ) dạng text — chỉ dùng cho CSV. */
  async exportCsv(cycleId: number, kind: 'products' | 'corrections', query: Record<string, string> = {}): Promise<{ status: number; text: string; bytes: Buffer; fileName: string }> {
    // BE 02/10 chỉ nhận enum viết hoa (`format=csv` → 400 "Failed to convert 'format'"; `format=CSV` → 200).
    const params = new URLSearchParams({ format: 'CSV', ...query });
    const token = await getValidAccessToken(undefined, this.role);
    const response = await this.request.fetch(`${BASE}/cycles/${cycleId}/${kind}/export?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
    const bytes = Buffer.from(await response.body());
    const disposition = response.headers()['content-disposition'] ?? '';
    const fileName = decodeURIComponent(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1] ?? '');
    this.exchanges.push({ request: `GET export ${kind}`, status: response.status(), responseBody: `${bytes.length} bytes` });
    return { status: response.status(), text: bytes.toString('utf8'), bytes, fileName };
  }

  private async send<T>(method: 'GET' | 'POST' | 'DELETE', url: string, data?: unknown): Promise<ApiResult<T>> {
    const token = await getValidAccessToken(undefined, this.role);
    const call = () => this.request.fetch(url, { method, data, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    let response = await call();
    // GET idempotent → thử lại tối đa 2 lần khi dev trả 5xx rải rác (29/09); lệnh ghi không tự thử lại.
    for (let attempt = 0; method === 'GET' && response.status() >= 500 && attempt < 2; attempt++) response = await call();
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    this.exchanges.push({ request: `${method} ${url}`, requestBody: data, status: response.status(), responseBody: body });
    return { status: response.status(), body: body as T };
  }
}

export async function openFeeReviewApi(request: APIRequest, role: AccountRole): Promise<{ api: FeeReviewApi; dispose: () => Promise<void> }> {
  const context = await request.newContext({ baseURL: env.apiBaseURL });
  return { api: new FeeReviewApi(context, role), dispose: () => context.dispose() };
}
