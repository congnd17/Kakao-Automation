import { APIRequest, APIRequestContext } from '@playwright/test';
import { AccountRole, getValidAccessToken } from '@utils/auth-token';
import { env } from '@utils/env.config';
import type { ApiExchange, ApiResult } from '@api/payment-method-policy.api';

/** Endpoint register 창고 (US069) — lấy từ bundle frontend, verify 28/09 (PATCH cập nhật, DELETE trả 204). */
const BASE_PATH = '/api/v1/warehouses';
const MAPPING_PATH = '/api/v1/product-warehouse-mappings';

export type WarehouseType = 'SUPPLIER' | 'PLATFORM';
export type WarehouseStatus = 'ACTIVE' | 'INACTIVE';
export type LogisticsType = 'WMS' | 'PICKUP_LOCATION' | 'STORE' | 'GENERAL' | 'PENDING_REVENUE' | 'IN_TRANSIT' | 'SCRAP' | 'QUARANTINE' | 'DEFECTIVE';
export type LogisticsChannelType = 'NONE' | 'CJ_LOGISTICS' | 'CJ_LOGISTICS_DT';

/** 1 dòng của GET /warehouses — bucket có `virtual = true` và `locationWarehouseId` = id warehouse cha. */
export interface WarehouseSummary {
  id: number;
  bizPartnerId: number;
  name: string;
  type: WarehouseType;
  logisticsChannelType: LogisticsChannelType;
  category?: string | null;
  virtual: boolean;
  status: WarehouseStatus;
  locationWarehouseId?: number | null;
}

export interface WarehouseDetail extends WarehouseSummary {
  country: string;
  addr: string;
  city?: string | null;
  stateOrProvince?: string | null;
  zipCode: string;
  detailAddr?: string | null;
  callingCode: string;
  number: string;
  logisticsType?: LogisticsType | null;
  logisticsChannelWarehouseCode?: string | null;
  logisticsChannelCode?: string | null;
  logisticsChannelInfo?: string | null;
  version: number;
  linkedStockRecordCount: number | null;
  linkedStoreCount: number | null;
  activeStoreName?: string | null;
  createdAt: string;
  updatedAt: string;
  updatedByName: string;
}

export interface WarehousePage {
  items: WarehouseSummary[];
  paging: { totalCount: number; currentPage: number; totalPage: number; hasNext: boolean };
}

/** Body POST/PATCH — cùng shape màn 창고 등록 / chi tiết gửi lên (bundle frontend). */
export interface WarehouseWriteBody {
  bizPartnerId: string;
  name: string;
  type: WarehouseType;
  logisticsType: LogisticsType | null;
  country: string;
  addr: string;
  city: string | null;
  stateOrProvince: string | null;
  zipCode: string;
  detailAddr: string | null;
  callingCode: string;
  number: string;
  logisticsChannelType: LogisticsChannelType | null;
  logisticsChannelWarehouseCode: string | null;
  logisticsChannelCode: string | null;
  logisticsChannelInfo: string | null;
  version?: number;
  [extraField: string]: unknown;
}

export interface HistoryChange {
  field: string;
  label: string;
  before: string | null;
  after: string | null;
}

export interface HistoryRecord {
  changedAt: string;
  changedByName: string;
  changeType: 'CREATED' | 'UPDATED' | 'DELETED';
  changes: HistoryChange[];
}

/** Body lỗi Problem Details — `code` là mã nghiệp vụ `WH-WAREHOUSE_*`. */
export interface WarehouseApiError {
  code: string;
  message: string;
  status: number;
}

/** 1 mapping (SKU, warehouse, owner) của register US071 — chỉ dùng dựng dữ liệu tham chiếu cho TC xoá warehouse. */
export interface ProductWarehouseMapping {
  id: number;
  productId: number;
  warehouseId: number;
  ownershipType: string;
  status: 'ACTIVE' | 'INACTIVE';
  isDefault: boolean;
}

export interface ProductWarehouseMappingBody {
  productId: number;
  warehouseId: number;
  ownershipType: string;
  isDefault: boolean;
}

export interface WarehouseFilter {
  name?: string;
  bizPartnerId?: string;
  type?: WarehouseType;
  status?: WarehouseStatus;
}

/**
 * API object của register 창고 (US069) — dựng/đọc/dọn dữ liệu cho test UI và là đối tượng test của TC API.
 * Ghi lại mọi request/response vào `exchanges` để đính kèm Allure làm bằng chứng.
 */
export class WarehouseApi {
  readonly exchanges: ApiExchange[] = [];

  constructor(
    private readonly request: APIRequestContext,
    private readonly role: AccountRole = 'submitter',
  ) {}

  async list(filter: WarehouseFilter = {}, page = 0, size = 100): Promise<ApiResult<WarehousePage>> {
    const query = new URLSearchParams({ ...filter, page: String(page), size: String(size) } as Record<string, string>);
    return this.send('GET', `${BASE_PATH}?${query.toString()}`);
  }

  /** Mọi dòng khớp filter, đi qua đủ các trang 100 dòng. */
  async listAll(filter: WarehouseFilter = {}): Promise<WarehouseSummary[]> {
    const rows: WarehouseSummary[] = [];
    for (let page = 0; ; page += 1) {
      const { body } = await this.list(filter, page, 100);
      rows.push(...body.items);
      if (!body.paging.hasNext) return rows;
    }
  }

  async get<T = WarehouseDetail>(id: number): Promise<ApiResult<T>> {
    return this.send('GET', `${BASE_PATH}/${id}`);
  }

  async create<T = { id: number }>(body: Partial<WarehouseWriteBody>): Promise<ApiResult<T>> {
    return this.send('POST', BASE_PATH, body);
  }

  async update<T = { id: number }>(id: number, body: Partial<WarehouseWriteBody>): Promise<ApiResult<T>> {
    return this.send('PATCH', `${BASE_PATH}/${id}`, body);
  }

  async remove<T = unknown>(id: number): Promise<ApiResult<T>> {
    return this.send('DELETE', `${BASE_PATH}/${id}`);
  }

  async deactivate<T = unknown>(id: number, version?: number): Promise<ApiResult<T>> {
    return this.send('POST', `${BASE_PATH}/${id}/deactivate`, version === undefined ? undefined : { version });
  }

  async reactivate<T = unknown>(id: number, version?: number): Promise<ApiResult<T>> {
    return this.send('POST', `${BASE_PATH}/${id}/reactivate`, version === undefined ? undefined : { version });
  }

  /** Lịch sử của 1 warehouse, mới nhất trước — cùng tham số dialog 변경 이력 gọi (size = 101). */
  async history(id: number): Promise<HistoryRecord[]> {
    const { body } = await this.send<{ items: HistoryRecord[] }>('GET', `${BASE_PATH}/${id}/history?size=101`);
    return body.items;
  }

  /** 5 bucket (virtual) do hệ thống sinh cho warehouse `parentId`. */
  async bucketsOf(parent: { id: number; name: string }): Promise<WarehouseSummary[]> {
    const rows = await this.listAll({ name: parent.name.slice(0, 60) });
    return rows.filter((row) => row.virtual && row.locationWarehouseId === parent.id);
  }

  /**
   * Mapping sản phẩm–kho (US071, `/api/v1/product-warehouse-mappings`) — endpoint + body lấy từ bundle frontend màn
   * 상품-창고 매핑, verify 28/09. Dùng để dựng tham chiếu ③ của warehouse automation, dọn ở teardown.
   */
  async selectableProducts(keyword: string): Promise<Array<{ id: number; code: string; name: string }>> {
    const { body } = await this.send<{ items: Array<{ id: number; code: string; name: string }> }>(
      'GET',
      `${MAPPING_PATH}/selectable-products?${new URLSearchParams({ keyword }).toString()}`,
    );
    return body.items;
  }

  async mappingsOf(warehouseId: number, status?: 'ACTIVE' | 'INACTIVE'): Promise<ApiResult<{ items: ProductWarehouseMapping[]; paging: { totalCount: number } }>> {
    const query = new URLSearchParams({ warehouseId: String(warehouseId), page: '0', size: '100', ...(status ? { status } : {}) });
    return this.send('GET', `${MAPPING_PATH}?${query.toString()}`);
  }

  async createMapping<T = { id: number }>(body: ProductWarehouseMappingBody): Promise<ApiResult<T>> {
    return this.send('POST', MAPPING_PATH, body);
  }

  async deactivateMapping<T = unknown>(id: number): Promise<ApiResult<T>> {
    return this.send('POST', `${MAPPING_PATH}/${id}/deactivate`);
  }

  async reactivateMapping<T = unknown>(id: number): Promise<ApiResult<T>> {
    return this.send('POST', `${MAPPING_PATH}/${id}/reactivate`);
  }

  async removeMapping<T = unknown>(id: number): Promise<ApiResult<T>> {
    return this.send('DELETE', `${MAPPING_PATH}/${id}`);
  }

  /** Body PATCH giữ nguyên toàn bộ giá trị hiện tại — test chỉ ghi đè trường cần thử. */
  static toUpdateBody(row: WarehouseDetail, patch: Partial<WarehouseWriteBody> = {}): WarehouseWriteBody {
    return {
      bizPartnerId: String(row.bizPartnerId),
      name: row.name,
      type: row.type,
      logisticsType: row.logisticsType ?? null,
      country: row.country,
      addr: row.addr,
      city: row.city ?? null,
      stateOrProvince: row.stateOrProvince ?? null,
      zipCode: row.zipCode,
      detailAddr: row.detailAddr ?? null,
      callingCode: row.callingCode,
      number: row.number,
      logisticsChannelType: row.type === 'PLATFORM' ? row.logisticsChannelType : null,
      logisticsChannelWarehouseCode: row.logisticsChannelWarehouseCode ?? null,
      logisticsChannelCode: row.logisticsChannelCode ?? null,
      logisticsChannelInfo: row.logisticsChannelInfo ?? null,
      version: row.version,
      ...patch,
    };
  }

  private async send<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, data?: unknown): Promise<ApiResult<T>> {
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

/** Client API trên request context riêng (baseURL = API) — dùng chung cho fixture test API và test UI. */
export async function openWarehouseApi(
  request: APIRequest,
  role: AccountRole = 'submitter',
): Promise<{ api: WarehouseApi; dispose: () => Promise<void> }> {
  const context = await request.newContext({ baseURL: env.apiBaseURL });
  return { api: new WarehouseApi(context, role), dispose: () => context.dispose() };
}
