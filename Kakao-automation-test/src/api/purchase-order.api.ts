import { APIRequest, APIRequestContext } from '@playwright/test';
import { AccountRole, getValidAccessToken } from '@utils/auth-token';
import { env } from '@utils/env.config';
import type { ApiExchange, ApiResult } from '@api/payment-method-policy.api';

/**
 * Endpoint 발주 관리 / 입고 검수 (US105) — lấy từ API client `mq` trong bundle frontend dev, verify 05/10/2026
 * (GET list/detail/history/lookups trả 200; tạo kho + PO + issue + receipt chạy thật trên kho automation).
 */
const BASE_PATH = '/api/v1/purchase-orders';
/** Upload file đính kèm (납품 증빙) đi qua shop-admin API — bucket ADMIN_CONTENT, folder BIZ_PARTNER (bundle `Gje`). */
const UPLOAD_URL = 'https://dev-shop-admin-api.berriz.in/api/v1/admin/attach-files/upload';
/** Register 거래처 — frontend đọc không kèm token (`_fetchPartnerApi`), lọc contractStatus = ACTIVE. */
const PARTNER_URL = 'https://dev-partner-account-internal-api.berriz.in/api/v1/internal/bizpartners';

export type PoStatus = 'DRAFT' | 'ISSUED' | 'CLOSED' | 'CANCELED';
export type GrnStatus = 'RECEIVED' | 'EXCEPTION' | 'COMPLETE' | 'REJECTED';
export type SupplierType = 'BIZ_PARTNER' | 'MANUFACTURER';
export type OwnershipType = 'OWN' | 'PARTNER';
export type SaleType = 'PURCHASE' | 'LICENSE' | 'SELF';
export type CurrencyCode = 'KRW' | 'USD' | 'JPY';
export type SearchType = 'PO_NO' | 'SUPPLIER' | 'SKU_CODE';
export type PeriodType = 'ORDER_DATE' | 'EXPECTED_DATE';

export interface PoLine {
  id: number;
  skuId: number;
  ownershipType: OwnershipType;
  saleType: SaleType;
  orderedQty: number;
  unitPrice: number;
  lineAmount: number;
  receivedTotal: number;
  outstanding: number;
}

export interface PoDetail {
  id: number;
  poNo: string;
  status: PoStatus;
  supplierId: number;
  supplierNameKo?: string | null;
  supplierNameEn?: string | null;
  supplierType: SupplierType;
  manufacturerId?: number | null;
  warehouseId: number;
  currencyCode: CurrencyCode;
  orderDate: string;
  expectedDate?: string | null;
  closeReason?: string | null;
  lines: PoLine[];
  expectedInboundQty: number;
  gapQty?: number;
  gapAmount?: number;
  version: number;
  createdBy: string;
}

export interface PoSummary {
  id: number;
  poNo: string;
  status: PoStatus;
  supplierId: number;
  supplierType: SupplierType;
  supplierNameKo?: string | null;
  supplierNameEn?: string | null;
  warehouseId: number;
  orderDate: string;
  expectedDate?: string | null;
  lineCount: number;
  poAmount: number;
  orderedTotal: number;
  receivedTotal: number;
  createdBy: string;
}

export interface Paged<T> {
  items: T[];
  paging: { totalCount: number; currentPage: number; totalPage: number; hasNext: boolean };
}

export interface PoLineBody {
  skuId: number;
  ownershipType: OwnershipType | null;
  saleType: SaleType | null;
  orderedQty: number;
  unitPrice: number;
  [extraField: string]: unknown;
}

/** Body POST / PATCH — đúng shape `Pce` của frontend (+ `version` khi PATCH). */
export interface PoWriteBody {
  supplierId: number;
  supplierType: SupplierType | null;
  manufacturerId: number | null;
  warehouseId: number;
  currencyCode: string;
  orderDate: string;
  expectedDate: string | null;
  lines: PoLineBody[];
  version?: number;
  [extraField: string]: unknown;
}

export interface PoFilter {
  searchType?: SearchType;
  keyword?: string;
  status?: PoStatus;
  warehouseId?: number;
  ownershipType?: OwnershipType;
  saleType?: SaleType;
  periodType?: PeriodType;
  periodFrom?: string;
  periodTo?: string;
}

export interface Attachment {
  savedPath: string;
  originalName: string;
}

export interface GrnLineBody {
  purchaseOrderLineId: number;
  receivedQty?: number;
  damagedQty?: number;
}

/** Body tạo / sửa receipt — shape `Oce` của frontend (+ `version` khi PUT). */
export interface GrnWriteBody {
  receivedDate?: string;
  discrepancyReasonCode: string | null;
  discrepancyReason: string | null;
  attachments: Attachment[];
  lines: GrnLineBody[];
  version?: number;
  [extraField: string]: unknown;
}

export interface GrnSummary {
  id: number;
  grnNo: string;
  status: GrnStatus;
  receivedDate: string;
  receivedQty: number;
  damagedQty: number;
  missingQty: number;
}

export interface GrnDetail extends GrnSummary {
  discrepancyReasonCode: string | null;
  discrepancyReason: string | null;
  attachments: Attachment[];
  resolvedBy?: string | null;
  resolutionReason?: string | null;
  incomingId?: number | null;
  grnSource?: string | null;
  receivedBy?: string | null;
  lines: Array<{ purchaseOrderLineId: number; receivedQty: number; damagedQty: number }>;
  version: number;
}

export interface HistoryChange {
  field: string;
  before: string | null;
  after: string | null;
}

export interface HistoryRecord {
  changedAt: string;
  changedByName: string;
  changeType: 'CREATED' | 'UPDATED' | 'DELETED';
  changes: HistoryChange[];
}

/** Body lỗi Problem Details — `code` là mã nghiệp vụ `PRC-xxxx` / `WH-*` / `CMN-4000`. */
export interface PoApiError {
  code?: string;
  title?: string;
  message?: string;
  detail?: string;
  status?: number;
}

export interface SkuLookup {
  id: number;
  skuCode: string;
  name: string;
  barcode?: string | null;
  type: 'PHYSICAL' | 'MIXED' | 'DIGITAL' | string;
}

export interface BizPartner {
  id: number;
  companyNames: { ko?: string | null; en?: string | null };
  contractStatus: 'ACTIVE' | 'TERMINATED' | string;
}

/** Idempotency-Key hợp lệ (32 ký tự A-Z a-z 0-9 _ -) — frontend sinh 1 key cho mỗi lần MỞ dialog 입고 검수. */
export function newIdempotencyKey(prefix = 'auto'): string {
  const random = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `${prefix}_${Date.now()}_${random}`.replace(/[^A-Za-z0-9_-]/g, '').padEnd(32, 'x').slice(0, 32);
}

/** Mã nghiệp vụ trong body lỗi — backend trả ở `code` (Problem Details `title` mang cùng giá trị). */
export function errorCode(body: unknown): string | undefined {
  const error = body as PoApiError | null;
  return error?.code ?? error?.title;
}

/**
 * API object của 발주 관리 (US105) — dựng/đọc/dọn dữ liệu cho test UI và là đối tượng test của TC API.
 * Ghi lại mọi request/response vào `exchanges` để đính kèm Allure làm bằng chứng.
 */
export class PurchaseOrderApi {
  readonly exchanges: ApiExchange[] = [];

  constructor(
    private readonly request: APIRequestContext,
    readonly role: AccountRole = 'submitter',
  ) {}

  async list(filter: PoFilter = {}, page = 0, size = 100): Promise<ApiResult<Paged<PoSummary>>> {
    return this.send('GET', `${BASE_PATH}?${toQuery({ ...filter, page, size })}`);
  }

  async get<T = PoDetail>(id: number | string): Promise<ApiResult<T>> {
    return this.send('GET', `${BASE_PATH}/${id}`);
  }

  async create<T = { id: number }>(body: Partial<PoWriteBody>): Promise<ApiResult<T>> {
    return this.send('POST', BASE_PATH, body);
  }

  async update<T = unknown>(id: number | string, body: Partial<PoWriteBody>): Promise<ApiResult<T>> {
    return this.send('PATCH', `${BASE_PATH}/${id}`, body);
  }

  async remove<T = unknown>(id: number | string): Promise<ApiResult<T>> {
    return this.send('DELETE', `${BASE_PATH}/${id}`);
  }

  /** `version` undefined → gửi request không body (đúng hành vi frontend khi chưa có version). */
  async issue<T = unknown>(id: number | string, version?: number): Promise<ApiResult<T>> {
    return this.send('POST', `${BASE_PATH}/${id}/issue`, version === undefined ? undefined : { version });
  }

  async cancel<T = unknown>(id: number | string, reason: string, version?: number): Promise<ApiResult<T>> {
    return this.send('POST', `${BASE_PATH}/${id}/cancel`, { reason, ...(version === undefined ? {} : { version }) });
  }

  async close<T = unknown>(id: number | string, reason: string, version?: number): Promise<ApiResult<T>> {
    return this.send('POST', `${BASE_PATH}/${id}/close`, { reason, ...(version === undefined ? {} : { version }) });
  }

  async history(id: number | string): Promise<HistoryRecord[]> {
    const { body } = await this.send<{ items: HistoryRecord[] }>('GET', `${BASE_PATH}/${id}/history`);
    return body.items;
  }

  async listExcel(filter: PoFilter = {}): Promise<ApiResult<unknown>> {
    return this.send('GET', `${BASE_PATH}/excel?${toQuery(filter)}`, undefined, { raw: true });
  }

  async goodsReceipts(poId: number | string): Promise<GrnSummary[]> {
    const { body } = await this.send<{ items: GrnSummary[] }>('GET', `${BASE_PATH}/${poId}/goods-receipts`);
    return body.items;
  }

  async goodsReceipt<T = GrnDetail>(poId: number | string, grnId: number | string): Promise<ApiResult<T>> {
    return this.send('GET', `${BASE_PATH}/${poId}/goods-receipts/${grnId}`);
  }

  /** `idempotencyKey` null → KHÔNG gửi header (TC_149 bước 1); chuỗi rỗng → gửi header rỗng. */
  async createReceipt<T = GrnDetail>(poId: number | string, body: Partial<GrnWriteBody>, idempotencyKey: string | null = newIdempotencyKey()): Promise<ApiResult<T>> {
    return this.send('POST', `${BASE_PATH}/${poId}/goods-receipts`, body, {
      headers: idempotencyKey === null ? {} : { 'Idempotency-Key': idempotencyKey },
    });
  }

  async updateReceipt<T = GrnDetail>(poId: number | string, grnId: number | string, body: Partial<GrnWriteBody>): Promise<ApiResult<T>> {
    return this.send('PUT', `${BASE_PATH}/${poId}/goods-receipts/${grnId}`, body);
  }

  async resolveReceipt<T = unknown>(poId: number | string, grnId: number | string, reasonCode: string | null, note: string | null, version?: number): Promise<ApiResult<T>> {
    return this.send('POST', `${BASE_PATH}/${poId}/goods-receipts/${grnId}/resolve`, { resolutionReasonCode: reasonCode, note, version });
  }

  async rejectReceipt<T = unknown>(poId: number | string, grnId: number | string, reasonCode: string | null, reason: string, version?: number): Promise<ApiResult<T>> {
    return this.send('POST', `${BASE_PATH}/${poId}/goods-receipts/${grnId}/reject`, { reasonCode, reason, version });
  }

  async receiptHistory(poId: number | string, grnId: number | string): Promise<HistoryRecord[]> {
    const { body } = await this.send<{ items: HistoryRecord[] }>('GET', `${BASE_PATH}/${poId}/goods-receipts/${grnId}/history`);
    return body.items;
  }

  async manufacturers(): Promise<Array<{ id: number; name: string }>> {
    const { body } = await this.send<{ items: Array<{ id: number; name: string }> }>('GET', `${BASE_PATH}/lookups/manufacturers`);
    return body.items;
  }

  async skus(query: { warehouseId?: number; manufacturerId?: number; supplierId?: number; keyword?: string } = {}): Promise<SkuLookup[]> {
    const { body } = await this.send<{ items: SkuLookup[] }>('GET', `${BASE_PATH}/lookups/skus?${toQuery(query)}`);
    return body.items;
  }

  async ownershipTypesOf(skuId: number, warehouseId: number): Promise<string[]> {
    const { body } = await this.send<{ items: Array<string | { code: string }> }>('GET', `${BASE_PATH}/lookups/skus/${skuId}/ownership-types?warehouseId=${warehouseId}`);
    return body.items.map((item) => (typeof item === 'string' ? item : item.code));
  }

  /**
   * Số tồn của SKU tại kho — `/api/v1/stock-status?warehouseIds=` (màn 재고 관리, bundle `GF`). Không có dòng nào = 0:
   * kho automation chưa từng có giao dịch tồn kho của SKU đó.
   */
  async stockOf(skuId: number, warehouseId: number): Promise<{ available: number; hold: number; incoming: number; total: number }> {
    const { body } = await this.send<{ items: Array<{ skuId: number; warehouse: { id: number }; stock: Record<string, number> }> }>(
      'GET',
      `/api/v1/stock-status?${toQuery({ warehouseIds: warehouseId, page: 0, size: 100 })}`,
    );
    const row = body.items.find((item) => item.skuId === skuId && item.warehouse.id === warehouseId);
    return {
      available: row?.stock.availableQuantity ?? 0,
      hold: row?.stock.holdQuantity ?? 0,
      incoming: row?.stock.incomingQuantity ?? 0,
      total: row?.stock.totalQuantity ?? 0,
    };
  }

  /** Upload 1 file 납품 증빙 → đối tượng attachment dùng trong body receipt. */
  async uploadAttachment(name: string, content: Buffer, mimeType = 'application/pdf'): Promise<Attachment> {
    const token = await getValidAccessToken(undefined, this.role);
    const response = await this.request.post(UPLOAD_URL, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: { files: { name, mimeType, buffer: content }, bucketType: 'ADMIN_CONTENT', folder: 'BIZ_PARTNER' },
    });
    const body = (await response.json()) as { data: { files: Array<{ savePath: string; originalFileName: string }> } };
    this.exchanges.push({ request: `POST ${UPLOAD_URL}`, requestBody: { file: name }, status: response.status(), responseBody: body });
    const file = body.data.files[0];
    return { savedPath: file.savePath, originalName: file.originalFileName };
  }

  /** Register 거래처 (không cần token) — nguồn danh sách 공급처 của form. */
  async bizPartners(): Promise<BizPartner[]> {
    const response = await this.request.get(`${PARTNER_URL}?page=0&size=500`);
    const body = (await response.json()) as { data?: { bizPartners?: BizPartner[] } } | BizPartner[];
    return Array.isArray(body) ? body : body.data?.bizPartners ?? [];
  }

  private async send<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    data?: unknown,
    options: { headers?: Record<string, string>; raw?: boolean } = {},
  ): Promise<ApiResult<T>> {
    const token = await getValidAccessToken(undefined, this.role);
    const response = await this.request.fetch(url, {
      method,
      data,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...options.headers },
    });
    let body: unknown;
    if (options.raw && response.ok()) {
      const buffer = await response.body();
      body = { contentType: response.headers()['content-type'], contentDisposition: response.headers()['content-disposition'], bytes: buffer.length, buffer };
    } else {
      const text = await response.text();
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
    }
    const logged = options.raw && response.ok() ? { ...(body as object), buffer: undefined } : body;
    this.exchanges.push({ request: `${method} ${url}`, requestBody: data, status: response.status(), responseBody: logged });
    return { status: response.status(), body: body as T };
  }
}

function toQuery(values: object): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  return query.toString();
}

/** Client API trên request context riêng (baseURL = API) — dùng chung cho fixture test API và test UI. */
export async function openPurchaseOrderApi(
  request: APIRequest,
  role: AccountRole = 'submitter',
): Promise<{ api: PurchaseOrderApi; dispose: () => Promise<void> }> {
  const context = await request.newContext({ baseURL: env.apiBaseURL });
  return { api: new PurchaseOrderApi(context, role), dispose: () => context.dispose() };
}
