import { APIRequest, APIRequestContext } from '@playwright/test';
import { AccountRole, getValidAccessToken } from '@utils/auth-token';
import { env } from '@utils/env.config';
import type { ApiExchange, ApiResult } from '@api/payment-method-policy.api';

/**
 * Register contract + fee row (US078 — Fee rate + effective dating). Endpoint + body lấy từ bundle frontend màn
 * 계약/프로젝트/수수료, verify 28/09: contract chỉ có POST / GET / PATCH (KHÔNG xoá được); fee row có
 * `…/fee-rows` (list, add), `…/{rowId}/changes` (정정 / 변경), `…/changes/{changeId}/withdraw`, `…/status` (활성/비활성),
 * `…/history`, DELETE (초안 삭제).
 */
const CONTRACTS = '/api/v1/contracts';

export type CommissionPolicy = 'NORMAL' | 'PROMOTION';
export type CommissionType = 'PERCENT' | 'FIXED_UNIT' | 'MARGIN' | 'TIERED_SLIDING' | 'GUARANTEE_RUNNING' | 'GUARANTEE_MINIMUM';
export type FeeRowApproval = 'DRAFT' | 'PENDING' | 'APPLIED' | 'SUPERSEDED';
export type ChangeKind = 'CORRECTION' | 'RATE_CHANGE';

/** 1 dòng commission trong body POST /contracts — cùng shape màn 새 계약서 등록 gửi lên (hàm map commission của bundle). */
export interface ContractCommissionBody {
  categoryId: number;
  saleTypeId: number;
  commissionPolicy: CommissionPolicy;
  commissionType: CommissionType;
  commission: number;
  pgCommissionRate: number;
  status: 'ACTIVE' | 'INACTIVE';
  vatIncluded: boolean;
  pgVatIncluded: boolean;
  pgOverrides: Record<string, number>;
  feeBase: string;
  feeBaseVatIncluded: boolean;
  pgFeeBase: string;
  pgFeeBaseVatIncluded: boolean;
  startAt?: string;
  endAt?: string;
  rateOrigin?: 'FROM_CONTRACT' | 'KEYED_BY_HAND';
}

export interface ContractCreateBody {
  bizPartnerId: number;
  artists: Array<{ id: number; name: string }>;
  contractName: string;
  labelTypeId: number;
  businessModelTypeId: number;
  regionType: 'DOMESTIC' | 'GLOBAL';
  ipDomains: string[];
  contractStartAt: string;
  contractEndAt: string;
  internalApproveDocumentUrl?: string;
  commissions: ContractCommissionBody[];
}

export interface ContractValues {
  labels: Array<{ id: number; code: string; title: string }>;
  businessModels: Array<{ id: number; code: string; title: string }>;
  categories: Array<{ id: number; code: string; title: string }>;
  saleTypes: Array<{ id: number; code: string; title: string }>;
}

export interface ContractDetail {
  id: number;
  code: string;
  contractName: string;
  contractPeriod: { startAt: string; endAt: string };
  status: string;
}

/** 1 dòng của GET /contracts/{id}/fee-rows — `commission` là chuỗi thập phân ("8.75"). */
export interface FeeRow {
  id: number;
  categoryId: number;
  saleTypeId: number;
  policy: CommissionPolicy;
  commissionType: CommissionType;
  commission: string | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
  promotionFrom?: string | null;
  promotionTo?: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  approval: FeeRowApproval;
  rateOrigin: string;
  source: string;
  changeControlOffered: boolean;
}

/** 1 mục của GET …/fee-rows/{rowId}/history — mỗi request (정정 / 변경 / 비활성 / 신규) là 1 mục. */
export interface FeeRowChange {
  id: number;
  feeRowId: number;
  kind: string;
  status: 'PENDING' | 'APPLIED' | 'REJECTED' | 'WITHDRAWN' | 'DRAFT' | 'DISCARDED';
  gated: boolean;
  changeApprovalId?: number | null;
  actor: string;
  previousCommission?: string | null;
  previousEffectiveFrom?: string | null;
  requestedCommission?: string | null;
  requestedEffectiveFrom?: string | null;
  reason?: string | null;
}

export interface SubmitChangeBody {
  changeKind: ChangeKind;
  commission: string;
  changeReason: string;
  effectiveFrom?: string;
}

/** Kết quả gửi 1 thay đổi — `gated = false` khi contract chưa bắt đầu / đã kết thúc (áp dụng ngay, không cần duyệt). */
export interface SubmitChangeResult {
  id: number;
  changeId: number;
  gated: boolean;
  changeApprovalId?: number | null;
  warnings: unknown[];
}

/**
 * API object của register contract / fee row (US078) — dựng dữ liệu cho test UI, đọc trạng thái để đối chiếu, dọn đơn chờ.
 * Ghi lại mọi request/response vào `exchanges` làm bằng chứng đính kèm Allure.
 */
export class FeeRateApi {
  readonly exchanges: ApiExchange[] = [];

  constructor(
    private readonly request: APIRequestContext,
    private readonly role: AccountRole,
  ) {}

  async createContract(body: ContractCreateBody): Promise<ApiResult<{ id: number }>> {
    return this.send('POST', CONTRACTS, body);
  }

  /** Body đúng nguyên văn pre-condition TC US079 v1 (shape tối giản, không đủ trường của màn 새 계약서 등록). */
  async createContractRaw(body: Record<string, unknown>): Promise<ApiResult<{ id: number }>> {
    return this.send('POST', CONTRACTS, body);
  }

  /** Master của màn contract (cần quyền COMMERCE_CONTRACTS): labels, businessModels, categories, saleTypes. */
  async values(): Promise<ApiResult<ContractValues>> {
    return this.send('GET', `${CONTRACTS}/values`);
  }

  async getContract(id: number): Promise<ApiResult<ContractDetail>> {
    return this.send('GET', `${CONTRACTS}/${id}`);
  }

  async feeRows(contractId: number): Promise<FeeRow[]> {
    const { body } = await this.send<{ items: FeeRow[] }>('GET', `${CONTRACTS}/${contractId}/fee-rows?includeInactive=true`);
    return body.items;
  }

  /** Gửi thay đổi thẳng qua API (bỏ qua UI) — chỉ dùng dựng tiền điều kiện hoặc cho TC tự gửi request trực tiếp. */
  async submitChange(contractId: number, rowId: number, body: SubmitChangeBody): Promise<ApiResult<SubmitChangeResult>> {
    return this.send('POST', `${CONTRACTS}/${contractId}/fee-rows/${rowId}/changes`, body);
  }

  async setStatus(contractId: number, rowId: number, status: 'ACTIVE' | 'INACTIVE', changeReason: string): Promise<ApiResult<SubmitChangeResult>> {
    return this.send('PUT', `${CONTRACTS}/${contractId}/fee-rows/${rowId}/status`, { status, changeReason });
  }

  async addFeeRow<T = SubmitChangeResult>(contractId: number, body: Record<string, unknown>): Promise<ApiResult<T>> {
    return this.send('POST', `${CONTRACTS}/${contractId}/fee-rows`, body);
  }

  async withdrawChange(contractId: number, rowId: number, changeId: number): Promise<ApiResult<unknown>> {
    return this.send('POST', `${CONTRACTS}/${contractId}/fee-rows/${rowId}/changes/${changeId}/withdraw`);
  }

  async history(contractId: number, rowId: number): Promise<FeeRowChange[]> {
    const { body } = await this.send<{ items: FeeRowChange[] }>('GET', `${CONTRACTS}/${contractId}/fee-rows/${rowId}/history`);
    return body.items;
  }

  /** Người duyệt quyết định thẳng qua API (dựng tiền điều kiện "đã duyệt / đã bị từ chối") — verify 30/09: approve không có body. */
  async approve(changeApprovalId: number): Promise<ApiResult<{ id: number }>> {
    return this.send('POST', `/api/v1/change-approvals/${changeApprovalId}/approve`);
  }

  async reject(changeApprovalId: number, rejectReason: string): Promise<ApiResult<{ id: number }>> {
    return this.send('POST', `/api/v1/change-approvals/${changeApprovalId}/reject`, { rejectReason });
  }

  private async send<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, data?: unknown): Promise<ApiResult<T>> {
    const token = await getValidAccessToken(undefined, this.role);
    const response = await this.request.fetch(url, {
      method,
      data,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
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

/** Client API trên request context riêng (baseURL = API). US078 chạy bằng account `approver` (dungbd.fpt — có COMMERCE_CONTRACTS). */
export async function openFeeRateApi(request: APIRequest, role: AccountRole): Promise<{ api: FeeRateApi; dispose: () => Promise<void> }> {
  const context = await request.newContext({ baseURL: env.apiBaseURL });
  return { api: new FeeRateApi(context, role), dispose: () => context.dispose() };
}
