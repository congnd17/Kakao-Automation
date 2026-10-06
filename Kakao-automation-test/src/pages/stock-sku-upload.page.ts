import { FileChooser, Locator, Page, Request, Response, expect, test } from '@playwright/test';
import { BasePage } from './base.page';
import { SkuMasterListPage } from './sku-form.page';
import { UPLOAD_PATHS, UploadResult, readUpload } from './stock-upload.page';
import type { SkuListRow, SkuType, StockApi } from '@api/stock.api';
import { XlsxCell, xlsxFile } from '@utils/xlsx-writer';
import { exportName, uniqueCode, uniqueHsCode, type StockWorld, type WorldManufacturer, type WorldPartner } from '@utils/stock.data';
import { stx } from '@utils/stock.i18n';

/**
 * Upload SKU 생성 trên màn SKU master (US134 — nhóm [SKU Creation Upload] TC_US134_388–412).
 * Nút `label[role=button]` bọc `input[type=file]` ẩn (accept `.xlsx,.xls`, component `kH`); chọn file là gửi ngay
 * `POST /api/v1/skus/upload-excel` (handler `W` của `l8t`): thành công → toast success `master.msg.uploadSkuDone` + list
 * gọi lại `GET /api/v1/skus?` đúng 1 lần (giữ điều kiện tìm kiếm); lỗi → toast danger mang nguyên `message` server.
 *
 * 20 tiêu đề workbook KHÔNG công bố (SRS, bundle, không có template) → `skuUploadSchema()` hỏi chính server lúc chạy:
 * upload workbook CHỈ có dòng tiêu đề (không tạo gì), server trả `엑셀에 '{column}' 항목이 존재하지 않습니다.` cho cột
 * thiếu đầu tiên → thêm cột đó → lặp đến khi server nhận (201 `{ids: []}`). Giá trị từng cột suy từ tên cột (`fieldOf`).
 */
export const SKU_UPLOAD_PATH = UPLOAD_PATHS.sku;
export const SKU_UPLOAD_DONE = stx('master.msg.uploadSkuDone', 'ko');
export const MISSING_HEADER = /엑셀에 '(.+?)' 항목이 존재하지 않습니다\./;
export const EMPTY_EXCEL = '엑셀 파일이 비어있습니다.';
export const INVALID_EXCEL = '유효하지 않은 엑셀입니다.';
export const XLSX_ONLY = 'xlsx 형식의 엑셀 파일만 업로드 가능합니다.';
export const XLS_MIME = 'application/vnd.ms-excel';

/** Ý nghĩa 1 cột workbook (suy từ tên tiêu đề server yêu cầu). */
export type SkuField =
  | 'type' | 'bizPartner' | 'groupCode' | 'groupName' | 'usageType' | 'price' | 'optionSetting'
  | 'skuCode' | 'skuName' | 'exportSkuName' | 'barcode' | 'weight' | 'width' | 'length' | 'height'
  | 'hsCode' | 'description' | 'manufacturer' | 'country' | 'materialCode' | 'bom' | 'date' | 'compositionType';

/** Luật tên cột → ý nghĩa, theo thứ tự ưu tiên (cụ thể trước: 수출용 SKU명 trước SKU명, 상품코드명 trước 상품코드). */
const FIELD_RULES: Array<[RegExp, SkuField]> = [
  [/수출/, 'exportSkuName'],
  [/자재/, 'materialCode'],
  [/BOM/i, 'bom'],
  [/상품\s*코드\s*명|상품명|그룹\s*명/, 'groupName'],
  [/상품\s*코드|그룹\s*코드/, 'groupCode'],
  [/HS/i, 'hsCode'],
  [/바코드|barcode/i, 'barcode'],
  [/SKU\s*(코드|code)/i, 'skuCode'],
  [/SKU\s*(명|이름|name)|옵션\s*명/i, 'skuName'],
  [/비즈|파트너|partner/i, 'bizPartner'],
  [/제조사|manufacturer/i, 'manufacturer'],
  [/원산지|국가|country/i, 'country'],
  [/구성\s*유형|composition/i, 'compositionType'],
  // Cột "유형" của workbook là 용도 유형 (SKU 종류): server chỉ nhận MAIN / PARTS / GIVEAWAY (EXL-4000, run 06/10).
  [/^\s*유형\s*$/, 'usageType'],
  [/유형|타입|type/i, 'type'],
  [/종류|용도|usage/i, 'usageType'],
  [/원가|가격|금액|price/i, 'price'],
  [/중량|무게|weight/i, 'weight'],
  [/너비|가로|폭|width/i, 'width'],
  [/세로|깊이|길이|length|depth/i, 'length'],
  [/높이|height/i, 'height'],
  [/설명|description/i, 'description'],
  [/일자|날짜|date|일$/i, 'date'],
  [/옵션/, 'optionSetting'],
];

export function fieldOf(header: string): SkuField | null {
  return FIELD_RULES.find(([rule]) => rule.test(header))?.[1] ?? null;
}

/** Cột số (đặt chữ vào → lỗi chuyển kiểu) theo thứ tự ưu tiên. */
export const NUMERIC_FIELDS: SkuField[] = ['weight', 'price', 'width', 'length', 'height'];

/** Bộ tiêu đề server đòi + nhật ký các lần hỏi (đính kèm report làm bằng chứng). */
export interface SkuUploadSchema {
  headers: string[];
  probes: Array<{ headers: number; status: number; message: string }>;
}

export function headerOf(schema: SkuUploadSchema, field: SkuField): string | undefined {
  return schema.headers.find((header) => fieldOf(header) === field);
}

/** Số cột 1-based (như Excel) của tiêu đề. */
export function columnOf(schema: SkuUploadSchema, header: string): number {
  return schema.headers.indexOf(header) + 1;
}

/** Cột kiểu số đầu tiên có trong bộ tiêu đề (ngoài `skip`). */
export function numericHeader(schema: SkuUploadSchema, skip: string[] = []): string | undefined {
  for (const field of NUMERIC_FIELDS) {
    const header = headerOf(schema, field);
    if (header && !skip.includes(header)) return header;
  }
  return undefined;
}

const SEED_HEADER = '상품코드';
let schemaPromise: Promise<SkuUploadSchema> | null = null;

/** Bộ tiêu đề workbook SKU 생성 — hỏi server 1 lần mỗi worker (chỉ upload workbook không có dòng dữ liệu hợp lệ). */
export function skuUploadSchema(api: StockApi): Promise<SkuUploadSchema> {
  schemaPromise ??= discoverSchema(api).catch((error: Error) => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

function messageOf(body: unknown): string {
  const value = (body ?? {}) as Record<string, unknown>;
  if (typeof value.message === 'string') return value.message;
  if (typeof value.detail === 'string') return value.detail;
  return typeof body === 'string' ? body : '';
}

async function discoverSchema(api: StockApi): Promise<SkuUploadSchema> {
  const headers = [SEED_HEADER];
  const probes: SkuUploadSchema['probes'] = [];
  let probeRow = false;
  const ask = async (cells: string[], withRow: boolean) => {
    const rows: XlsxCell[][] = withRow ? [cells, cells.map((_, index) => (index === 0 ? 'PROBE' : null))] : [cells];
    const { status, body } = await api.uploadSkuExcel(xlsxFile('sku-header-probe.xlsx', rows));
    const message = messageOf(body);
    probes.push({ headers: cells.length, status, message });
    return { status, message };
  };
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { status, message } = await ask(headers, probeRow);
    if (status < 300) break;
    const missing = MISSING_HEADER.exec(message);
    if (missing) {
      if (headers.includes(missing[1])) throw new Error(`SKU upload header discovery loops on '${missing[1]}': HTTP ${status} ${message}`);
      headers.push(missing[1]);
      continue;
    }
    if (!probeRow && message.includes(EMPTY_EXCEL)) {
      probeRow = true;
      continue;
    }
    if (probeRow) break;
    throw new Error(`SKU upload header discovery stopped on an unexpected answer: HTTP ${status} ${message}`);
  }
  if (!probeRow) {
    const withoutSeed = headers.filter((header) => header !== SEED_HEADER);
    const check = await ask(withoutSeed, false);
    if (check.status < 300) return { headers: withoutSeed, probes };
  }
  return { headers, probes };
}

/** 1 dòng dữ liệu workbook theo ý nghĩa cột — `null` = ô trống. */
export type SkuRow = Partial<Record<SkuField, XlsxCell>>;

export interface SkuRowOptions {
  groupCode: string;
  skuCode: string;
  groupName?: string;
  skuName?: XlsxCell;
  barcode?: string;
  partner?: WorldPartner;
  manufacturer?: WorldManufacturer;
  type?: SkuType;
  /** HS 코드 của nhóm — mọi dòng cùng 상품코드 phải mang cùng giá trị nhóm. */
  hsCode?: string;
}

/** Dòng 현물 hợp lệ chuẩn (Partner A · Demo Manufacturer 1 · 본품 · KR) — mã lấy từ `uniqueCode`. */
export function skuRow(world: StockWorld, options: SkuRowOptions): SkuRow {
  return {
    type: options.type ?? 'PHYSICAL',
    bizPartner: (options.partner ?? world.partners.A).id,
    groupCode: options.groupCode,
    groupName: options.groupName ?? `${world.tag} ${options.groupCode.slice(world.tag.length)} Upload`,
    usageType: 'MAIN',
    price: 12000,
    optionSetting: null,
    skuCode: options.skuCode,
    skuName: options.skuName === undefined ? `Item ${options.skuCode.slice(world.tag.length)}` : options.skuName,
    exportSkuName: exportName(options.skuCode),
    barcode: options.barcode ?? uniqueCode(world.tag, `B${options.skuCode.slice(world.tag.length, world.tag.length + 4)}`),
    weight: 250,
    width: 100,
    length: 80,
    height: 30,
    hsCode: options.hsCode ?? uniqueHsCode(),
    description: 'Automation upload SKU',
    manufacturer: (options.manufacturer ?? world.manufacturers.M1).id,
    country: 'KR',
    materialCode: null,
    compositionType: 'SINGLE',
    bom: null,
    date: null,
  };
}

/** `count` dòng hợp lệ dưới 1 상품코드 — SKU 코드 dạng `<tag><skuLabel><seq>`. */
export function skuRows(world: StockWorld, groupCode: string, skuLabel: string, count: number, extra: Partial<SkuRowOptions> = {}): SkuRow[] {
  const hsCode = extra.hsCode ?? uniqueHsCode();
  return Array.from({ length: count }, () => skuRow(world, { groupCode, skuCode: uniqueCode(world.tag, skuLabel), ...extra, hsCode }));
}

/** SKU 코드 của các dòng workbook. */
export function codesOf(rows: SkuRow[]): string[] {
  return rows.map((row) => String(row.skuCode ?? ''));
}

/** Tiêu đề của 1 ý nghĩa cột — báo rõ khi bộ tiêu đề của build không có cột đó. */
export function requireHeader(schema: SkuUploadSchema, field: SkuField, label: string): string {
  const header = headerOf(schema, field);
  if (!header) throw new Error(`The SKU-creation header the build demands has no ${label} column: ${schema.headers.join(' | ')}`);
  return header;
}

/**
 * Workbook SKU 생성 (.xlsx): dòng 1 = bộ tiêu đề server đòi (bỏ `omit`), dòng 2… = dữ liệu; `cells` ghi đè ô theo tên
 * tiêu đề cho từng dòng (index dòng dữ liệu).
 */
export function skuWorkbook(
  name: string,
  schema: SkuUploadSchema,
  rows: SkuRow[],
  options: { omit?: string[]; cells?: Record<number, Record<string, XlsxCell>> } = {},
): { name: string; mimeType: string; buffer: Buffer } {
  const headers = schema.headers.filter((header) => !(options.omit ?? []).includes(header));
  const data = rows.map((row, index) =>
    headers.map((header) => {
      const override = options.cells?.[index];
      if (override && header in override) return override[header];
      const field = fieldOf(header);
      return field ? row[field] ?? null : null;
    }),
  );
  return xlsxFile(name, [headers, ...data]);
}

/** SKU (mọi loại) có SKU 코드 khớp tuyệt đối. */
export async function skusByCode(api: StockApi, skuCode: string): Promise<SkuListRow[]> {
  const { body } = await api.skus({ searchType: 'SKU_CODE', keyword: skuCode });
  return (body.items ?? []).filter((row) => row.skuCode === skuCode);
}

/** SKU có SKU 코드 bắt đầu bằng `prefix` (tìm SKU코드 khớp một phần rồi lọc). */
export async function skusWithPrefix(api: StockApi, prefix: string): Promise<SkuListRow[]> {
  const { body } = await api.skus({ searchType: 'SKU_CODE', keyword: prefix });
  return (body.items ?? []).filter((row) => row.skuCode.startsWith(prefix));
}

/** SKU của 1 상품코드 — so khớp không phân biệt hoa thường (mọi nhóm trùng mã đều trả về). */
export async function groupSkus(api: StockApi, groupCode: string): Promise<SkuListRow[]> {
  const { body } = await api.skus({ searchType: 'SKU_GROUP_CODE', keyword: groupCode });
  return (body.items ?? []).filter((row) => row.skuGroupCode.toLowerCase() === groupCode.toLowerCase());
}

/** Tổng số dòng của list SKU master 1 loại (pager "총 N개"). */
export async function masterTotal(api: StockApi, type: SkuType = 'PHYSICAL'): Promise<number> {
  const { body } = await api.skus({ type, size: 10 });
  return body.paging?.totalCount ?? 0;
}

export function isSkuUpload(request: Request): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === SKU_UPLOAD_PATH;
}

export function isSkuListQuery(request: Request): boolean {
  return request.method() === 'GET' && new URL(request.url()).pathname === '/api/v1/skus';
}

export class SkuUploadPage extends BasePage {
  constructor(
    page: Page,
    readonly master: SkuMasterListPage,
  ) {
    super(page);
  }

  get openModals(): Locator {
    return this.page.locator('.modal.show');
  }

  /** Phần chữ của toast (span thứ 2 trong `.toast-body`, sau icon). */
  toastMessage(toast: Locator): Locator {
    return toast.locator('.toast-body > span').nth(1);
  }

  toast(text: string): Locator {
    return this.master.toasts.filter({ hasText: text });
  }

  /** Dòng list có SKU코드 bắt đầu bằng `prefix`. */
  rowsWithPrefix(prefix: string): Locator {
    return this.master.bodyRows.filter({ has: this.page.locator('td', { hasText: new RegExp(`^${prefix}`) }) });
  }

  get noResultsCell(): Locator {
    return this.master.table.locator('tbody td', { hasText: stx('empty.noResults', this.master.lang) });
  }

  /** Bấm nút SKU 생성 업로드, trả về hộp chọn file OS (chưa chọn file). */
  async openChooser(): Promise<FileChooser> {
    let chooser!: FileChooser;
    await test.step('Click SKU 생성 업로드 (Upload SKU creation) and wait for the operating system file picker', async () => {
      const opened = this.page.waitForEvent('filechooser', { timeout: 15_000 });
      await this.master.uploadButton.click();
      chooser = await opened;
    });
    return chooser;
  }

  /** Chọn file trong hộp chọn đã mở, đợi response upload. */
  async pick(chooser: FileChooser, file: { name: string; mimeType: string; buffer: Buffer }): Promise<UploadResult> {
    let result!: UploadResult;
    await test.step(`Pick ${file.name} (${file.buffer.length} bytes)`, async () => {
      const response = this.page.waitForResponse((res: Response) => isSkuUpload(res.request()), { timeout: 180_000 });
      await chooser.setFiles(file);
      result = await readUpload(await response);
    });
    return result;
  }

  async upload(file: { name: string; mimeType: string; buffer: Buffer }): Promise<UploadResult> {
    return this.pick(await this.openChooser(), file);
  }

  /** Upload và (khi thành công) đợi lượt list tự gọi lại + toast hoàn tất. */
  async uploadAndReload(file: { name: string; mimeType: string; buffer: Buffer }): Promise<UploadResult> {
    const reload = this.page.waitForResponse((res) => isSkuListQuery(res.request()), { timeout: 180_000 }).catch(() => null);
    const result = await this.upload(file);
    if (result.status < 300) {
      await reload;
      await expect(this.master.table, 'The SKU master list is shown again after the re-query').toBeVisible({ timeout: 30_000 });
    }
    return result;
  }

  /** Ghi mọi request `/api/` gửi đi trong lúc chạy `action`. */
  async requestsDuring(action: () => Promise<void>): Promise<Request[]> {
    const requests: Request[] = [];
    const listener = (request: Request) => {
      if (request.url().includes('/api/')) requests.push(request);
    };
    this.page.on('request', listener);
    try {
      await action();
    } finally {
      this.page.off('request', listener);
    }
    return requests;
  }
}
