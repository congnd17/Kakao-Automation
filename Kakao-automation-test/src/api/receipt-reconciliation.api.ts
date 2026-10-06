import { APIRequest, APIRequestContext } from '@playwright/test';
import { AccountRole, getValidAccessToken } from '@utils/auth-token';
import { env } from '@utils/env.config';
import type { ApiExchange, ApiResult } from '@api/payment-method-policy.api';

/**
 * Receipt reconciliation (US020) — endpoint lấy từ bundle frontend (class API của màn, verify 30/09):
 * GET /reconciliation-groups?period (bắt buộc) · GET /counts?period · GET /{id} · DELETE /{id} (giải tán) ·
 * GET /build-candidates/receipts|documents?period[&bizPartnerId] · POST /reconciliation-groups ·
 * GET /reconciliation-mismatches?period · GET /reconciliation-reasons. Client chỉ bọc các lời gọi suite đang dùng.
 * Không có endpoint "signal" gửi US019/US023 trong frontend — TC [API] về signal bị skip, không đoán đường dẫn.
 */
const GROUPS = '/api/v1/reconciliation-groups';

export type ReceiptNotSelectableReason = 'AWAITING_COMPLETION' | 'NO_GOODS_RECEIPT' | 'NOT_KRW' | string;

export interface BuildReceipt {
  goodsReceiptId?: number;
  grnNo?: string;
  incomingId?: number;
  bizPartnerId: number;
  bizPartnerName?: string;
  warehouseId: number;
  warehouseName: string;
  receivedOn: string;
  supplyValue?: string;
  selectable: boolean;
  notSelectableReason?: ReceiptNotSelectableReason;
}

export interface GroupCounts {
  groupCount: number;
  openMismatchCount: number;
  ungroupedReceiptCount: number;
  ungroupedDocumentCount: number;
  groupLevelExceptionCount: number;
  postLockOpenCount: number;
}

/** Dòng nhóm thô của API (frontend ghép `periodYear` + `periodMonth` thành kỳ `yyyy-MM`). */
export interface GroupSummary {
  id: number;
  groupNo?: string;
  periodYear: number;
  periodMonth: number;
  status?: string;
}

export function groupPeriod(group: GroupSummary): string {
  return `${group.periodYear}-${String(group.periodMonth).padStart(2, '0')}`;
}

export interface Paged<T> {
  items: T[];
  paging: { totalCount: number; currentPage: number; totalPage: number; hasNext: boolean };
}

export interface ProblemDetail {
  status: number;
  code: string;
  title?: string;
  detail?: string;
  message?: string;
}

/** API object của US020 — đọc dữ liệu đối chiếu, gửi lời gọi trực tiếp cho TC [API]. Ghi mọi exchange làm bằng chứng. */
export class ReceiptReconciliationApi {
  readonly exchanges: ApiExchange[] = [];

  constructor(
    private readonly request: APIRequestContext,
    private readonly role: AccountRole,
  ) {}

  async listGroups<T = Paged<GroupSummary>>(query: Record<string, string>): Promise<ApiResult<T>> {
    const params = new URLSearchParams(query);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return this.send('GET', `${GROUPS}${suffix}`);
  }

  async counts(period: string): Promise<GroupCounts> {
    const { body } = await this.send<GroupCounts>('GET', `${GROUPS}/counts?period=${period}`);
    return body;
  }

  async getGroup<T = unknown>(groupId: string | number): Promise<ApiResult<T>> {
    return this.send('GET', `${GROUPS}/${encodeURIComponent(String(groupId))}`);
  }

  async buildReceipts(period: string, bizPartnerId?: number): Promise<BuildReceipt[]> {
    const params = new URLSearchParams({ period, ...(bizPartnerId ? { bizPartnerId: String(bizPartnerId) } : {}) });
    const { body } = await this.send<{ receipts: BuildReceipt[] }>('GET', `${GROUPS}/build-candidates/receipts?${params.toString()}`);
    return body.receipts ?? [];
  }

  /** Suite chỉ gọi GET (không TC đang chạy nào ghi dữ liệu). */
  private async send<T>(method: 'GET', url: string): Promise<ApiResult<T>> {
    const token = await getValidAccessToken(undefined, this.role);
    const call = () => this.request.fetch(url, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    let response = await call();
    // Dev chập chờn (30/09: timeout / lỗi mạng rải rác) — GET idempotent nên thử lại tối đa 2 lần khi 5xx.
    for (let attempt = 0; response.status() >= 500 && attempt < 2; attempt++) response = await call();
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    this.exchanges.push({ request: `${method} ${url}`, status: response.status(), responseBody: body });
    return { status: response.status(), body: body as T };
  }
}

export async function openReceiptReconciliationApi(
  request: APIRequest,
  role: AccountRole = 'submitter',
): Promise<{ api: ReceiptReconciliationApi; dispose: () => Promise<void> }> {
  const context = await request.newContext({ baseURL: env.apiBaseURL });
  return { api: new ReceiptReconciliationApi(context, role), dispose: () => context.dispose() };
}
