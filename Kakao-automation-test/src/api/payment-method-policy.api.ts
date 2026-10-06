import { APIRequest, APIRequestContext } from '@playwright/test';
import { AccountRole, getValidAccessToken } from '@utils/auth-token';
import { env } from '@utils/env.config';

const BASE_PATH = '/api/v1/payment-method-policies';
/** Hàng đợi 변경 승인 (US120) — endpoint lấy từ bundle frontend, verify 28/09 (approve không body, reject {rejectReason}). */
const CHANGE_APPROVAL_PATH = '/api/v1/change-approvals';

export interface ChannelKey {
  pgCode: string;
  paymentMethodCode: string;
  currency: string;
}

export interface PendingChange {
  changeApprovalId: number;
  changeType: string;
  requestedValue: string;
  submittedBy: string;
  submittedAt: string;
}

export interface PaymentMethodPolicy extends ChannelKey {
  id: number;
  fxSourceStrategy: string;
  cycleType: string;
  cycleAnchorWeekday?: string | null;
  cycleLagDays: number;
  approval: string;
  pending?: PendingChange;
  version: number;
  updatedAt: string;
}

export interface PolicyCatalog {
  pgCodes: string[];
  paymentMethodCodes: string[];
  currencies: string[];
  fxSourceStrategies: string[];
  cycleTypes: string[];
  anchorWeekdays: string[];
}

export interface ByKeyResponse {
  taken: boolean;
  holder?: PaymentMethodPolicy;
}

export interface PolicyPage {
  content: PaymentMethodPolicy[];
  page: number;
  size: number;
  totalElements: number;
}

/** Body lỗi dạng Problem Details của backend — `code` là mã nghiệp vụ `PMP-100x`. */
export interface ApiError {
  code: string;
  message: string;
  status: number;
  field?: string;
}

/** Body của PUT /{id} — cùng shape màn sửa gửi lên (lấy từ bundle frontend US080). */
export interface PolicyUpdateBody {
  fxSourceStrategy: string;
  cycleType: string;
  cycleAnchorWeekday: string | null;
  cycleLagDays: string;
  version: number;
  changeReason?: string;
  [extraField: string]: unknown;
}

export interface PolicyCreateBody extends ChannelKey {
  fxSourceStrategy: string;
  cycleType: string;
  cycleAnchorWeekday: string | null;
  cycleLagDays: string;
  changeReason: string;
}

/** 1 request trong hàng đợi 변경 승인 — shape đọc từ GET /change-approvals/{id} ngày 28/09. */
export interface ChangeApproval {
  id: number;
  targetType: string;
  changeType: string;
  approvalStatus: string;
  requestedBy: string;
  requestedAt: string;
  prevValue?: string;
  changeSummary: string;
  changeReason?: string;
}

export interface ApiResult<T> {
  status: number;
  body: T;
}

export interface ApiExchange {
  request: string;
  requestBody?: unknown;
  status: number;
  responseBody: unknown;
}

/**
 * API object của register 결제수단 정책 (US080) — vai trò tương đương Page Object ở tầng API.
 * Ghi lại mọi request/response vào `exchanges` để đính kèm Allure làm bằng chứng (thay cho screenshot).
 */
export class PaymentMethodPolicyApi {
  readonly exchanges: ApiExchange[] = [];

  constructor(
    private readonly request: APIRequestContext,
    private readonly role: AccountRole = 'submitter',
  ) {}

  async getCatalog(): Promise<ApiResult<PolicyCatalog>> {
    return this.send('GET', `${BASE_PATH}/catalog`);
  }

  async list(filter: Partial<ChannelKey> = {}, size = 100): Promise<ApiResult<PolicyPage>> {
    const query = new URLSearchParams({ ...filter, page: '0', size: String(size) });
    return this.send('GET', `${BASE_PATH}?${query.toString()}`);
  }

  async get(id: number): Promise<ApiResult<PaymentMethodPolicy>> {
    return this.send('GET', `${BASE_PATH}/${id}`);
  }

  async getByKey(key: ChannelKey): Promise<ApiResult<ByKeyResponse>> {
    return this.send('GET', `${BASE_PATH}/by-key?${new URLSearchParams({ ...key }).toString()}`);
  }

  async update<T = PaymentMethodPolicy | ApiError>(id: number, body: PolicyUpdateBody): Promise<ApiResult<T>> {
    return this.send('PUT', `${BASE_PATH}/${id}`, body);
  }

  async create<T = unknown>(body: PolicyCreateBody): Promise<ApiResult<T>> {
    return this.send('POST', BASE_PATH, body);
  }

  async withdraw(id: number): Promise<ApiResult<unknown>> {
    return this.send('POST', `${BASE_PATH}/${id}/withdraw`);
  }

  async getHistory(id: number): Promise<ApiResult<unknown>> {
    return this.send('GET', `${BASE_PATH}/${id}/history?page=0&size=100`);
  }

  async getChangeApproval(changeApprovalId: number): Promise<ApiResult<ChangeApproval>> {
    return this.send('GET', `${CHANGE_APPROVAL_PATH}/${changeApprovalId}`);
  }

  /** Chỉ account role APPROVER, khác danh tính người nộp (SoD) — account khác nhận 403. */
  async approveChange(changeApprovalId: number): Promise<ApiResult<unknown>> {
    return this.send('POST', `${CHANGE_APPROVAL_PATH}/${changeApprovalId}/approve`);
  }

  async rejectChange(changeApprovalId: number, rejectReason: string): Promise<ApiResult<unknown>> {
    return this.send('POST', `${CHANGE_APPROVAL_PATH}/${changeApprovalId}/reject`, { rejectReason });
  }

  /** Dòng cần tìm theo channel key — ném lỗi nếu register không có dòng nào khớp. */
  async getRowByKey(key: ChannelKey): Promise<PaymentMethodPolicy> {
    const { body } = await this.getByKey(key);
    if (!body.taken || !body.holder) {
      throw new Error(`Register has no row ${formatKey(key)}`);
    }
    return body.holder;
  }

  /**
   * Dòng ở trạng thái sửa được — tự 회수 request chờ duyệt bị bỏ sót nếu 1 lần chạy trước lỗi giữa chừng
   * ngay sau bước gửi duyệt (cùng lý do `beforeAll` của payment-method-policy-detail.spec.ts).
   */
  async getEditableRow(key: ChannelKey): Promise<PaymentMethodPolicy> {
    const row = await this.getRowByKey(key);
    if (!row.pending) return row;
    await this.withdraw(row.id);
    return (await this.get(row.id)).body;
  }

  /** Tổ hợp đầu tiên trong `candidates` chưa có dòng nào giữ key — register không có xoá (BR-18). */
  async findUnusedKey(candidates: ChannelKey[]): Promise<ChannelKey> {
    for (const key of candidates) {
      const { body } = await this.getByKey(key);
      if (!body.taken) return key;
    }
    throw new Error(`No unused combination left in the ${candidates.length}-candidate pool — extend the pool`);
  }

  /** Body PUT giữ nguyên toàn bộ giá trị hiện tại của dòng — test chỉ ghi đè trường cần thử. */
  static toUpdateBody(row: PaymentMethodPolicy): PolicyUpdateBody {
    return {
      fxSourceStrategy: row.fxSourceStrategy,
      cycleType: row.cycleType,
      cycleAnchorWeekday: row.cycleAnchorWeekday ?? null,
      cycleLagDays: String(row.cycleLagDays),
      version: row.version,
    };
  }

  private async send<T>(method: 'GET' | 'PUT' | 'POST', url: string, data?: unknown): Promise<ApiResult<T>> {
    const token = await getValidAccessToken(undefined, this.role);
    const response = await this.request.fetch(url, {
      method,
      data,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const text = await response.text();
    const body = (text ? JSON.parse(text) : null) as T;
    this.exchanges.push({ request: `${method} ${url}`, requestBody: data, status: response.status(), responseBody: body });
    return { status: response.status(), body };
  }
}

/** Client API trên request context riêng (baseURL = API) — dùng chung cho fixture test API và test UI. */
export async function openPaymentMethodPolicyApi(
  request: APIRequest,
  role: AccountRole = 'submitter',
): Promise<{ api: PaymentMethodPolicyApi; dispose: () => Promise<void> }> {
  const context = await request.newContext({ baseURL: env.apiBaseURL });
  return { api: new PaymentMethodPolicyApi(context, role), dispose: () => context.dispose() };
}

export function formatKey(key: ChannelKey): string {
  return `${key.pgCode} · ${key.paymentMethodCode} · ${key.currency}`;
}
