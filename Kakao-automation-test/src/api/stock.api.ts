import { APIRequest, APIRequestContext } from '@playwright/test';
import { AccountRole, getValidAccessToken } from '@utils/auth-token';
import { env } from '@utils/env.config';
import type { ApiExchange, ApiResult } from '@api/payment-method-policy.api';

/**
 * Endpoint màn 재고 관리 + SKU master (US134) — lấy từ bundle frontend dev ngày 05/10/2026
 * (class GF / u8t trong bundle). ID 15 chữ số luôn gửi/đọc dạng số (frontend `sE()` đổi chuỗi ≤ 15 chữ số → Number).
 */
const STOCK_STATUS_PATH = '/api/v1/stock-status';
const STOCK_USAGE_PATH = '/api/v1/stock-usages';
const STOCKS_PATH = '/api/v1/stocks';
const INCOMING_PATH = '/api/v1/incoming';
const ADJUSTMENT_PATH = '/api/v1/adjustments';
const SKUS_PATH = '/api/v1/skus';
const SKU_GROUPS_PATH = '/api/v1/sku-groups';
const MANUFACTURERS_PATH = '/api/v1/manufacturers';
const BIZ_PARTNERS_PATH = '/api/v1/internal/bizpartners';
const PARTNER_API_BASE_URL = process.env.PARTNER_API_BASE_URL ?? 'https://dev-partner-account-internal-api.berriz.in';
const WAREHOUSES_ALL_PATH = '/api/v1/warehouses/all';

export type SkuType = 'PHYSICAL' | 'DIGITAL' | 'MIXED';
export type SkuUsageType = 'MAIN' | 'PARTS' | 'GIVEAWAY';
export type StockSearchField = 'SKU_GROUP_NAME' | 'SKU_GROUP_CODE' | 'SKU_NAME' | 'SKU_CODE' | 'SKU_ID' | 'BARCODE' | 'HS_CODE';
export type IncomingType = 'PURCHASE_ORDER' | 'TRANSFER' | 'ETC';
export type ModifyType = 'ADD' | 'SUBTRACT';
export type AdjustReason = 'ADJUSTMENT' | 'DISCREPANCY' | 'DAMAGED' | 'LOST' | 'TAKING' | 'ETC';
export type ConversionPolicy = 'SECURE_CS' | 'RELEASE_CS' | 'SECURE_HOLD' | 'RELEASE_HOLD' | 'SCRAP_DEFECTIVE';

/** Khối `warehouse` của 1 dòng tồn kho — `category` là 대구분 (CJ_WAREHOUSE, CJ_DAEGU_WAREHOUSE…). */
export interface StockWarehouse {
  id: number;
  name: string;
  category?: string | null;
  logisticsType?: string | null;
  virtual: boolean;
}

export interface StockQuantities {
  totalQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  holdQuantity: number;
  csQuantity?: number;
  csOrderableQuantity?: number;
  pendingAllocationQuantity: number;
  orderableQuantity: number;
  incomingQuantity: number;
  insufficientQuantity: number;
  unconfirmedQuantity: number;
  csStockManaged: boolean;
}

/** 1 dòng của GET /stock-status (= 1 dòng của bảng 재고 목록). SKU chưa có tồn kho → `warehouse`/`stock` vắng mặt. */
export interface StockStatusRow {
  skuId: number;
  skuCode: string;
  skuGroupId: number;
  skuGroupCode: string;
  skuName: string;
  barcode?: string | null;
  hsCode?: string | null;
  type: SkuType;
  usageType?: SkuUsageType | null;
  bizPartnerId: number;
  price?: number | null;
  warehouse?: StockWarehouse | null;
  manufacturer?: { id: number; name: string } | null;
  stock?: StockQuantities | null;
  createdAt: string;
}

export interface Paging {
  totalCount: number;
  nextPage?: number;
  currentPage: number;
  totalPage: number;
  hasNext: boolean;
}

export interface ListPage<T> {
  items: T[];
  paging: Paging;
}

export interface StockStatusQuery {
  searchType?: StockSearchField;
  keyword?: string;
  skuType?: SkuType;
  warehouseCategory?: string;
  warehouseIds?: string;
  bizPartnerIds?: string;
  sort?: string;
  page?: number;
  size?: 10 | 20 | 50 | 100;
}

/** 1 dòng 재고이력 (GET /stock-usages). */
export interface StockUsageRow {
  id: number;
  createdAt: string;
  refType: string;
  type: string;
  typeLabel?: string | null;
  refId: number | string;
  note?: string | null;
  beforeQuantity: number;
  delta: number;
  afterQuantity: number;
  createdBy?: string | null;
  createdIp?: string | null;
}

export interface SkuListRow {
  skuId: number;
  skuCode: string;
  skuName: string;
  type: SkuType;
  skuGroupCode: string;
  skuGroupId: number;
  barcode?: string | null;
  usageType?: SkuUsageType | null;
  bizPartnerId: number;
  createdAt: string;
}

/** GET /sku-groups/{id} — dữ liệu form sửa SKU. */
export interface SkuGroupDetail {
  skuGroupId: number;
  skuGroupCode: string;
  groupName: string;
  bizPartnerId: number;
  type: SkuType;
  usageType?: SkuUsageType;
  price?: number;
  width?: number;
  length?: number;
  height?: number;
  weight?: number;
  hsCode?: string;
  description?: string;
  countryOfOrigin?: string;
  manufacturerId?: number;
  optionSetting?: 'NONE' | 'MULTIPLE';
  skus: Array<{ skuId: number; skuCode: string; skuName: string; barcode?: string; exportSkuName?: string }>;
  bundles?: Array<{ skuId: number; skuCode: string; skuName: string; quantity: number; deleted?: boolean }>;
}

export interface PhysicalSkuLine {
  name: string;
  skuCode: string;
  exportSkuName: string;
  barcode: string;
  skuId?: number;
}

/** Body POST /skus của form 현물 SKU (`Uqt(jue(...))` trong bundle). */
export interface PhysicalSkuBody {
  type: 'PHYSICAL';
  bizPartnerId: number;
  group: { code: string; name: string };
  usageType: SkuUsageType;
  price: number;
  skus: PhysicalSkuLine[];
  weight: number;
  width: number;
  length: number;
  height: number;
  hsCode: string;
  description: string;
  manufacturerId: number;
  countryOfOrigin: string;
}

export interface DigitalSkuBody {
  type: 'DIGITAL';
  bizPartnerId: number;
  group: { code: string; name: string };
}

export interface SetSkuBody {
  type: 'MIXED';
  bizPartnerId: number;
  group: { code: string; name: string };
  bundles: Array<{ skuId: number; quantity: number }>;
}

export type SkuCreateBody = PhysicalSkuBody | DigitalSkuBody | SetSkuBody;

/** Body POST /incoming của dialog 입고 요청. */
export interface IncomingBody {
  warehouseId: number;
  requestDate: string;
  type: IncomingType;
  note?: string;
  manufacturerId: number;
  items: Array<{ skuId: number; quantity: number; purchasePrice: { amount: number }; memo?: string }>;
}

/** Body POST /adjustments của dialog 재고 조정. */
export interface AdjustmentBody {
  items: Array<{ skuId: number; warehouseId: number; adjustingQuantity: number; modifyType: ModifyType; reason: AdjustReason; note?: string }>;
}

/** Body POST /stocks/conversions của dialog 재고 전환. */
export interface ConversionBody {
  policy: ConversionPolicy;
  items: Array<{ skuId: number; warehouseId: number; quantity: number; memo?: string }>;
}

/** Body PATCH /stocks/cs-stock-management của dialog 창고별 상세. */
export interface CsManagementBody {
  items: Array<{ skuId: number; warehouseId: number; managed: boolean }>;
}

/** Body lỗi Problem Details — `code` là mã nghiệp vụ (VD `CMN-4000`). */
export interface StockApiError {
  code?: string;
  title?: string;
  message?: string;
  detail?: string;
  status: number;
}

export interface UploadFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export interface BinaryResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * API object của US134 — dựng dữ liệu (SKU, tồn kho, kho) cho test UI, đọc số liệu để đối chiếu, và là đối tượng test
 * của TC phía server. Ghi lại mọi request/response vào `exchanges` để đính kèm Allure làm bằng chứng.
 */
export class StockApi {
  readonly exchanges: ApiExchange[] = [];

  constructor(
    private readonly request: APIRequestContext,
    private readonly role: AccountRole = 'submitter',
  ) {}

  async stockStatus(query: StockStatusQuery = {}): Promise<ApiResult<ListPage<StockStatusRow>>> {
    return this.send('GET', `${STOCK_STATUS_PATH}?${toQuery({ searchType: 'SKU_GROUP_NAME', sort: 'CREATED_AT,desc', page: 0, size: 100, ...query })}`);
  }

  /** Mọi dòng tồn kho của 1 SKU (mọi kho) — tìm theo SKU ID khớp tuyệt đối. */
  async stockRowsOfSku(skuId: number): Promise<StockStatusRow[]> {
    const { body } = await this.stockStatus({ searchType: 'SKU_ID', keyword: String(skuId) });
    return body.items.filter((row) => row.skuId === skuId);
  }

  /** Dòng tồn kho (SKU × kho) — undefined khi chưa có bản ghi tồn kho. */
  async stockRow(skuId: number, warehouseId: number): Promise<StockStatusRow | undefined> {
    return (await this.stockRowsOfSku(skuId)).find((row) => row.warehouse?.id === warehouseId);
  }

  async stockUsages(skuId: number, warehouseId: number, page = 0, size: 10 | 20 | 50 | 100 = 100): Promise<ApiResult<ListPage<StockUsageRow>>> {
    return this.send('GET', `${STOCK_USAGE_PATH}?${toQuery({ skuId, warehouseId, page, size })}`);
  }

  async createIncoming<T = unknown>(body: IncomingBody): Promise<ApiResult<T>> {
    return this.send('POST', INCOMING_PATH, body);
  }

  async createAdjustments<T = unknown>(body: AdjustmentBody): Promise<ApiResult<T>> {
    return this.send('POST', ADJUSTMENT_PATH, body);
  }

  async convert<T = unknown>(body: ConversionBody): Promise<ApiResult<T>> {
    return this.send('POST', `${STOCKS_PATH}/conversions`, body);
  }

  async setCsManagement<T = unknown>(body: CsManagementBody): Promise<ApiResult<T>> {
    return this.send('PATCH', `${STOCKS_PATH}/cs-stock-management`, body);
  }

  async skus(query: { type?: SkuType; searchType?: string; keyword?: string; page?: number; size?: number } = {}): Promise<ApiResult<ListPage<SkuListRow>>> {
    return this.send('GET', `${SKUS_PATH}?${toQuery({ page: 0, size: 100, ...query })}`);
  }

  async skuGroup<T = SkuGroupDetail>(skuGroupId: number | string): Promise<ApiResult<T>> {
    return this.send('GET', `${SKU_GROUPS_PATH}/${encodeURIComponent(String(skuGroupId))}`);
  }

  async createSku<T = unknown>(body: SkuCreateBody | Record<string, unknown>): Promise<ApiResult<T>> {
    return this.send('POST', SKUS_PATH, body);
  }

  async updateSku<T = unknown>(skuGroupId: number | string, body: Record<string, unknown>): Promise<ApiResult<T>> {
    return this.send('PATCH', `${SKUS_PATH}/${encodeURIComponent(String(skuGroupId))}`, body);
  }

  /** Kiểm trùng 상품코드 — `ids` rỗng = chưa dùng. */
  async checkSkuGroupCode(skuGroupCode: string): Promise<ApiResult<{ ids: number[] }>> {
    return this.send('POST', `${SKU_GROUPS_PATH}/check-duplication`, { skuGroupCode });
  }

  /** Kiểm trùng SKU code / barcode — `type` cho biết trùng ở trường nào. */
  async checkSkuDuplication(body: { skuCodes: string[]; barcodes: string[] }): Promise<ApiResult<{ ids: Array<string | number>; type?: 'SKU_CODE' | 'BARCODE' }>> {
    return this.send('POST', `${SKUS_PATH}/check-duplication`, body);
  }

  async manufacturers(bizPartnerId?: number | string): Promise<Array<{ id: number; name: string; corpRegistrationNo?: string }>> {
    const query = bizPartnerId === undefined ? '' : `?${toQuery({ bizPartnerId })}`;
    const { body } = await this.send<{ items: Array<{ id: number; name: string; corpRegistrationNo?: string }> }>('GET', `${MANUFACTURERS_PATH}${query}`);
    return body.items ?? [];
  }

  /**
   * Danh sách 비즈파트너 — frontend đọc từ host partner riêng (không cần token, class `Xl` trong bundle), body
   * `{ code: '0000', data: { bizPartners } }`; KHÔNG có trên API settlement (404, verify 05/10).
   */
  async bizPartners(): Promise<Array<{ id: number; companyNames?: { ko?: string; en?: string } }>> {
    type Partner = { id: number; companyNames?: { ko?: string; en?: string } };
    const url = `${PARTNER_API_BASE_URL}${BIZ_PARTNERS_PATH}?page=0&size=2000`;
    const response = await this.request.fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
    const body = parseBody(await response.text()) as { data?: { bizPartners?: Partner[] }; items?: Partner[] } | null;
    this.exchanges.push({ request: `GET ${url}`, status: response.status(), responseBody: `<${body?.data?.bizPartners?.length ?? 0} biz partners>` });
    return body?.data?.bizPartners ?? body?.items ?? [];
  }

  /** Danh sách kho mà filter 창고 / dialog 입고 요청 đọc (PLATFORM · ACTIVE · bỏ kho ảo). */
  async selectableWarehouses(): Promise<Array<{ id: number; bizPartnerId: number; name: string; category?: string | null; logisticsChannelType: string }>> {
    const { body } = await this.send<{ items: Array<{ id: number; bizPartnerId: number; name: string; category?: string | null; logisticsChannelType: string }> }>(
      'GET',
      `${WAREHOUSES_ALL_PATH}?type=PLATFORM&status=ACTIVE&excludeVirtual=true&sortByName=true`,
    );
    return body.items ?? [];
  }

  async uploadSkuExcel<T = unknown>(file: UploadFile): Promise<ApiResult<T>> {
    return this.upload(`${SKUS_PATH}/upload-excel`, file);
  }

  async uploadIncomingExcel<T = unknown>(file: UploadFile): Promise<ApiResult<T>> {
    return this.upload(`${INCOMING_PATH}/upload-excel`, file);
  }

  async uploadAdjustmentExcel<T = unknown>(file: UploadFile): Promise<ApiResult<T>> {
    return this.upload(`${ADJUSTMENT_PATH}/upload-excel`, file);
  }

  /** Nút 엑셀 다운로드 của list — tải file đồng bộ với đúng filter đang áp dụng. */
  async exportStockStatus(query: StockStatusQuery = {}): Promise<BinaryResult> {
    return this.download(`${STOCK_STATUS_PATH}/excel?${toQuery({ searchType: 'SKU_GROUP_NAME', sort: 'CREATED_AT,desc', ...query })}`);
  }

  async exportStockUsages(skuId: number, warehouseId: number): Promise<BinaryResult> {
    return this.download(`${STOCK_USAGE_PATH}/excel?${toQuery({ skuId, warehouseId })}`);
  }

  /** Gọi 1 endpoint tuỳ ý (TC phía server gửi body lệch chuẩn — trùng dòng, quá 100 dòng, header lạ…). */
  async raw<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, data?: unknown, headers: Record<string, string> = {}): Promise<ApiResult<T>> {
    return this.send(method, url, data, headers);
  }

  private async upload<T>(url: string, file: UploadFile): Promise<ApiResult<T>> {
    const token = await getValidAccessToken(undefined, this.role);
    const response = await this.request.fetch(url, {
      method: 'POST',
      multipart: { file },
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      timeout: 120_000,
    });
    const body = parseBody(await response.text());
    this.exchanges.push({ request: `POST ${url} (multipart file=${file.name}, ${file.buffer.length} bytes)`, status: response.status(), responseBody: body });
    return { status: response.status(), body: body as T };
  }

  private async download(url: string): Promise<BinaryResult> {
    const token = await getValidAccessToken(undefined, this.role);
    const response = await this.request.fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, timeout: 120_000 });
    const body = await response.body();
    this.exchanges.push({ request: `GET ${url}`, status: response.status(), responseBody: `<binary ${body.length} bytes, ${response.headers()['content-type'] ?? ''}>` });
    return { status: response.status(), headers: response.headers(), body };
  }

  private async send<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, data?: unknown, headers: Record<string, string> = {}): Promise<ApiResult<T>> {
    const token = await getValidAccessToken(undefined, this.role);
    const response = await this.request.fetch(url, {
      method,
      data,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...headers },
    });
    const body = parseBody(await response.text());
    this.exchanges.push({ request: `${method} ${url}`, requestBody: data, status: response.status(), responseBody: body });
    return { status: response.status(), body: body as T };
  }
}

function parseBody(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

function toQuery(params: Record<string, string | number | boolean | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') query.set(key, String(value));
  return query.toString();
}

/** Client API trên request context riêng (baseURL = API) — dùng chung cho fixture test API và test UI. */
export async function openStockApi(
  request: APIRequest,
  role: AccountRole = 'submitter',
): Promise<{ api: StockApi; dispose: () => Promise<void> }> {
  const context = await request.newContext({ baseURL: env.apiBaseURL });
  return { api: new StockApi(context, role), dispose: () => context.dispose() };
}
