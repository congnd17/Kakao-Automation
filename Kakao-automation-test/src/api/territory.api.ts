import { APIRequest, APIRequestContext } from '@playwright/test';
import { AccountRole, getValidAccessToken } from '@utils/auth-token';
import { env } from '@utils/env.config';
import type { ApiExchange, ApiResult } from '@api/payment-method-policy.api';

/**
 * Register Territory (US089) — endpoint lấy từ bundle frontend, verify 29/09: GET list (`size` ∈ 10/20/50/100),
 * GET /{code}, GET /{code}/history, PATCH /{code} `{vatTreatment, exportDeclarationRequired, reason, version}`.
 * Không có route tạo / xoá.
 */
const BASE_PATH = '/api/v1/territories';

export type VatTreatment = 'TAXABLE_STANDARD' | 'ZERO_RATED';

export interface Territory {
  id: number;
  countryCode: string;
  nameEn: string;
  nameKo: string;
  vatTreatment: VatTreatment;
  exportDeclarationRequired: boolean;
  seededDefault: boolean;
  updatedAt: string;
  updatedBy?: string | null;
  version: number;
}

export interface TerritoryPage {
  items: Territory[];
  paging: { totalCount: number; currentPage: number; totalPage: number; hasNext: boolean };
}

export interface TerritoryHistoryRecord {
  id: number | string;
  changeType: string;
  changedAt: string;
  changedBy?: string | null;
  reason: string;
  changes: Array<{ field: string; before: unknown; after: unknown }>;
}

export interface TerritoryUpdateBody {
  vatTreatment: string;
  exportDeclarationRequired: boolean;
  reason?: string;
  version: number;
  /** Trường định danh — server phải từ chối mọi thay đổi (TER-1005, TC_US089_43). */
  countryCode?: string;
  nameEn?: string;
  nameKo?: string;
}

/** API object của register Territory — đọc dữ liệu đối chiếu, gửi lời gọi trực tiếp cho TC [API]. Ghi mọi exchange làm bằng chứng. */
export class TerritoryApi {
  readonly exchanges: ApiExchange[] = [];

  constructor(
    private readonly request: APIRequestContext,
    private readonly role: AccountRole,
  ) {}

  async list(query: Record<string, string> = {}): Promise<ApiResult<TerritoryPage>> {
    const params = new URLSearchParams({ page: '0', size: '100', ...query });
    return this.send('GET', `${BASE_PATH}?${params.toString()}`);
  }

  /** Toàn bộ quốc gia của register (đi qua mọi trang 100 dòng). */
  async all(): Promise<Territory[]> {
    const rows: Territory[] = [];
    for (let page = 0; ; page += 1) {
      const { body } = await this.list({ page: String(page) });
      rows.push(...body.items);
      if (!body.paging.hasNext) return rows;
    }
  }

  async get(code: string): Promise<ApiResult<Territory>> {
    return this.send('GET', `${BASE_PATH}/${encodeURIComponent(code)}`);
  }

  async history(code: string): Promise<TerritoryHistoryRecord[]> {
    const { body } = await this.send<{ items: TerritoryHistoryRecord[] }>('GET', `${BASE_PATH}/${encodeURIComponent(code)}/history`);
    return body.items;
  }

  /** Lời gọi ghi trực tiếp (bỏ qua UI) — dùng cho TC kiểm server từ chối. */
  async update<T = unknown>(code: string, body: TerritoryUpdateBody): Promise<ApiResult<T>> {
    return this.send('PATCH', `${BASE_PATH}/${encodeURIComponent(code)}`, body);
  }

  async raw<T = unknown>(method: 'POST' | 'DELETE', url: string, data?: unknown): Promise<ApiResult<T>> {
    return this.send(method, url, data);
  }

  private async send<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, data?: unknown): Promise<ApiResult<T>> {
    const token = await getValidAccessToken(undefined, this.role);
    const call = () => this.request.fetch(url, { method, data, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    let response = await call();
    // Dev trả 500 rải rác cho GET (29/09) — GET idempotent nên thử lại tối đa 2 lần; lệnh ghi không bao giờ tự thử lại.
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

export async function openTerritoryApi(request: APIRequest, role: AccountRole): Promise<{ api: TerritoryApi; dispose: () => Promise<void> }> {
  const context = await request.newContext({ baseURL: env.apiBaseURL });
  return { api: new TerritoryApi(context, role), dispose: () => context.dispose() };
}
