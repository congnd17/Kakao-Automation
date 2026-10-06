import { FileChooser, Locator, Page, Request, Response, expect, test } from '@playwright/test';
import type { RowDataPacket } from 'mysql2/promise';
import { BasePage } from './base.page';
import { StockListPage } from './stock-list.page';
import { stockDb } from '@utils/stock-db';
import { XlsxCell, xlsxFile } from '@utils/xlsx-writer';
import type { StockWorld, WorldSku } from '@utils/stock.data';

/**
 * Upload Excel trên màn 재고 관리 (US134 — nhóm [Inbound Request Upload] TC_US134_313–343): nhãn upload là
 * `label[role=button]` bọc `input[type=file]` ẩn (accept `.xlsx,.xls`), chọn file là gửi ngay
 * `POST /api/v1/{incoming|adjustments}/upload-excel` (multipart `file`); thành công → toast success + list tải lại
 * (không xoá ô tick), lỗi → toast danger mang nguyên `message` của server (không có `code`), list KHÔNG tải lại.
 * Bundle 05/10/2026 (component `kH`, handler `ee` của `a8t`).
 */
export type UploadKind = 'incoming' | 'adjustment';

export const UPLOAD_PATHS: Record<UploadKind | 'sku', string> = {
  incoming: '/api/v1/incoming/upload-excel',
  adjustment: '/api/v1/adjustments/upload-excel',
  sku: '/api/v1/skus/upload-excel',
};

/** 9 cột workbook 입고 요청 theo AC 14 — server khớp cột theo đúng chữ tiêu đề tiếng Hàn. */
export const INBOUND_HEADERS = ['출고지 ID', '제조사 ID', '입고유형', '입고 요청일', 'SKU 코드', '수량', '매입가격', '메모', '기타 사유'] as const;

export type InboundHeader = (typeof INBOUND_HEADERS)[number];

/** 1 dòng dữ liệu workbook 입고 — `null` = ô trống. */
export interface InboundRow {
  warehouseId: XlsxCell;
  manufacturerId: XlsxCell;
  type: XlsxCell;
  requestDate: XlsxCell;
  skuCode: XlsxCell;
  quantity: XlsxCell;
  purchasePrice: XlsxCell;
  memo?: XlsxCell;
  reason?: XlsxCell;
}

const ROW_FIELD: Record<InboundHeader, keyof InboundRow> = {
  '출고지 ID': 'warehouseId',
  '제조사 ID': 'manufacturerId',
  '입고유형': 'type',
  '입고 요청일': 'requestDate',
  'SKU 코드': 'skuCode',
  '수량': 'quantity',
  '매입가격': 'purchasePrice',
  '메모': 'memo',
  '기타 사유': 'reason',
};

/** Số cột (1-based, như Excel hiển thị) của tiêu đề trong workbook chuẩn. */
export function inboundColumn(header: InboundHeader): number {
  return INBOUND_HEADERS.indexOf(header) + 1;
}

/** Workbook 입고 (.xlsx) — `headers` cho phép bỏ / đổi cột (TC thiếu cột tiêu đề). */
export function inboundWorkbook(name: string, rows: InboundRow[], headers: readonly InboundHeader[] = INBOUND_HEADERS): { name: string; mimeType: string; buffer: Buffer } {
  return xlsxFile(name, [[...headers], ...rows.map((row) => headers.map((header) => row[ROW_FIELD[header]] ?? null))]);
}

/** File upload tuỳ ý (text đổi đuôi, file 0 byte, .xls). */
export function rawFile(name: string, buffer: Buffer, mimeType = 'application/octet-stream'): { name: string; mimeType: string; buffer: Buffer } {
  return { name, mimeType, buffer };
}

/** YYYY-MM-DD + `days` ngày. */
export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Kết quả 1 lần upload (đọc từ response trình duyệt nhận). */
export interface UploadResult {
  url: string;
  status: number;
  body: Record<string, unknown>;
  code: string;
  message: string;
  ids: number[] | null;
}

/** 1 dòng 입고 (header + item) trong DB. */
export interface IncomingLine extends RowDataPacket {
  incoming_id: number;
  type: string;
  status: string;
  warehouse_id: number;
  biz_partner_id: number;
  request_date: Date | string | null;
  note: string | null;
  sku_id: number;
  requested_quantity: number;
  purchase_price: string | number;
  memo: string | null;
}

const LINE_COLUMNS = `i.id AS incoming_id, i.type, i.status, i.warehouse_id, i.biz_partner_id, i.request_date, i.note,
  ii.sku_id, ii.requested_quantity, ii.purchase_price, ii.memo`;

/** Mọi dòng 입고 của các SKU (mới nhất trước). */
export async function incomingLinesOfSkus(skus: WorldSku[]): Promise<IncomingLine[]> {
  if (skus.length === 0) return [];
  return stockDb.query<IncomingLine>(
    `SELECT ${LINE_COLUMNS} FROM incoming i JOIN incoming_item ii ON ii.incoming_id = i.id WHERE ii.sku_id IN (?) ORDER BY i.id, ii.id`,
    [skus.map((sku) => sku.skuId)],
  );
}

/** Mọi dòng của các phiếu 입고 theo id (id server trả về trong IdsResponse). */
export async function incomingLinesOf(ids: number[]): Promise<IncomingLine[]> {
  if (ids.length === 0) return [];
  return stockDb.query<IncomingLine>(`SELECT ${LINE_COLUMNS} FROM incoming i JOIN incoming_item ii ON ii.incoming_id = i.id WHERE i.id IN (?) ORDER BY i.id, ii.id`, [ids]);
}

/** Số phiếu 입고 trỏ vào các kho automation của world (+ kho thêm) — chỉ suite ghi vào các kho này. */
export async function incomingCountInWarehouses(world: StockWorld, extraWarehouseIds: number[] = []): Promise<number> {
  const ids = [world.warehouses.CJ, world.warehouses.DAEGU, world.warehouses.PICKUP, world.warehouses.GENERAL]
    .filter((w): w is NonNullable<typeof w> => !!w)
    .map((w) => w.id)
    .concat(extraWarehouseIds);
  const rows = await stockDb.query<RowDataPacket>('SELECT COUNT(*) AS n FROM incoming WHERE warehouse_id IN (?)', [ids]);
  return Number(rows[0]?.n ?? 0);
}

/** Số phiếu 입고 (distinct) chứa ít nhất 1 SKU trong danh sách. */
export async function incomingCountOfSkus(skus: WorldSku[]): Promise<number> {
  return new Set((await incomingLinesOfSkus(skus)).map((line) => String(line.incoming_id))).size;
}

/** `{n}행의 {m}열({column})은 필수 항목입니다.` */
export function parseRequired(message: string): { row: number; column: number; name: string } | null {
  const match = /(\d+)행의 (\d+)열\((.+?)\)[은는] 필수 항목입니다\./.exec(message);
  return match ? { row: Number(match[1]), column: Number(match[2]), name: match[3] } : null;
}

/** `{n}행 {m}열({column}): 셀(value:{v}, type:{t})을 {type}으로 변환할 수 없습니다.` */
export function parseConvert(message: string): { row: number; column: number; name: string; value: string; cellType: string; target: string } | null {
  const match = /(\d+)행 (\d+)열\((.+?)\): 셀\(value:(.*?), type:(.+?)\)[을를] (.+?)(?:으로|로) 변환할 수 없습니다\./.exec(message);
  return match ? { row: Number(match[1]), column: Number(match[2]), name: match[3], value: match[4], cellType: match[5], target: match[6] } : null;
}

/** Phần "N행" đầu message lỗi theo dòng (`{n}행의 SKU 코드를…`, `{n}행: 삭제된…`). */
export function rowOf(message: string): number | null {
  const match = /(\d+)행/.exec(message);
  return match ? Number(match[1]) : null;
}

export class StockUploadPage extends BasePage {
  constructor(
    page: Page,
    readonly list: StockListPage,
  ) {
    super(page);
  }

  /** Mọi modal đang mở (TC "no application upload modal"). */
  get openModals(): Locator {
    return this.page.locator('.modal.show');
  }

  /** Mọi toast chứa đúng đoạn chữ. */
  toast(text: string): Locator {
    return this.list.toasts.filter({ hasText: text });
  }

  button(kind: UploadKind): Locator {
    return kind === 'incoming' ? this.list.uploadIncomingButton : this.list.uploadAdjustmentButton;
  }

  /** Bấm nhãn upload và trả về hộp chọn file của OS (filechooser) — chưa chọn file. */
  async openChooser(kind: UploadKind): Promise<FileChooser> {
    let chooser!: FileChooser;
    await test.step(`Click the ${kind} upload button and wait for the operating system file picker`, async () => {
      const opened = this.page.waitForEvent('filechooser', { timeout: 15_000 });
      await this.button(kind).click();
      chooser = await opened;
    });
    return chooser;
  }

  /** Chọn file trong hộp chọn file đã mở và đợi response upload. */
  async pick(chooser: FileChooser, kind: UploadKind, file: { name: string; mimeType: string; buffer: Buffer }, timeout = 300_000): Promise<UploadResult> {
    let result!: UploadResult;
    await test.step(`Pick ${file.name} (${file.buffer.length} bytes)`, async () => {
      const response = this.page.waitForResponse((res) => isUpload(res.request(), kind), { timeout });
      await chooser.setFiles(file);
      result = await readUpload(await response);
    });
    return result;
  }

  /** Bấm nhãn upload, chọn file và đợi response — trả về status / body / code / message. */
  async upload(kind: UploadKind, file: { name: string; mimeType: string; buffer: Buffer }, timeout = 300_000): Promise<UploadResult> {
    return this.pick(await this.openChooser(kind), kind, file, timeout);
  }

  /** Upload thành công: đợi toast hoàn tất và lượt tải lại list sau đó. */
  async uploadAndReload(kind: UploadKind, file: { name: string; mimeType: string; buffer: Buffer }, timeout = 300_000): Promise<UploadResult> {
    const reload = this.page.waitForResponse((res) => res.url().includes('/api/v1/stock-status?') && res.request().method() === 'GET', { timeout }).catch(() => null);
    const result = await this.upload(kind, file, timeout);
    if (result.status < 300) {
      await reload;
      await this.list.waitForList();
    }
    return result;
  }

  /** Ghi lại mọi request `/api/` gửi đi trong lúc chạy `action`. */
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

  /** Đợi toast mang `text` hiện (thành công hoặc lỗi). */
  async expectToast(text: string, message: string): Promise<void> {
    await expect(this.toast(text).last(), message).toBeVisible({ timeout: 30_000 });
  }
}

/** 1 phần file app đưa vào FormData (tên field multipart, tên file, số byte). */
export interface MultipartFilePart {
  field: string;
  name: string;
  size: number;
}

/**
 * Chromium không đưa phần thân multipart có File vào `request.postData()` (null) → ghi lại các File app
 * `FormData.append()` ngay trên trang (client `fileUploadRequest` tạo `new FormData` + `append('file', file)` rồi `fetch`).
 * Gọi sau khi trang đã mở (không điều hướng giữa chừng); trả về hàm đọc các phần đã ghi từ lúc gọi.
 */
export async function watchMultipartFiles(page: Page): Promise<() => Promise<MultipartFilePart[]>> {
  await page.evaluate(() => {
    const store = window as unknown as { __multipartFiles?: Array<{ field: string; name: string; size: number }> };
    if (store.__multipartFiles) {
      store.__multipartFiles.length = 0;
      return;
    }
    const parts: Array<{ field: string; name: string; size: number }> = [];
    store.__multipartFiles = parts;
    const original = FormData.prototype.append;
    FormData.prototype.append = function append(this: FormData, ...args: unknown[]) {
      const [field, value, filename] = args;
      if (value instanceof Blob) parts.push({ field: String(field), name: typeof filename === 'string' ? filename : value instanceof File ? value.name : '', size: value.size });
      return (original as (...rest: unknown[]) => void).apply(this, args);
    };
  });
  return () => page.evaluate(() => [...((window as unknown as { __multipartFiles?: Array<{ field: string; name: string; size: number }> }).__multipartFiles ?? [])]);
}

export function isUpload(request: Request, kind: UploadKind): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === UPLOAD_PATHS[kind];
}

export async function readUpload(response: Response): Promise<UploadResult> {
  let body: Record<string, unknown> = {};
  try {
    body = ((await response.json()) ?? {}) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const ids = Array.isArray(body.ids) ? (body.ids as Array<number | string>).map(Number) : null;
  return {
    url: response.url(),
    status: response.status(),
    body,
    code: typeof body.code === 'string' ? body.code : '',
    message: typeof body.message === 'string' ? body.message : typeof body.detail === 'string' ? body.detail : '',
    ids,
  };
}

/**
 * File .xls thật (BIFF8 trong compound file OLE2 — chữ ký D0 CF 11 E0): 1 stream `Workbook` gồm BOF/CODEPAGE/
 * BOUNDSHEET/EOF của workbook + BOF/DIMENSIONS/EOF của 1 sheet. Dùng cho TC "server chỉ nhận .xlsx".
 */
export function buildXls(): Buffer {
  const record = (type: number, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt16LE(type, 0);
    head.writeUInt16LE(data.length, 2);
    return Buffer.concat([head, data]);
  };
  const bof = (kind: number) => {
    const data = Buffer.alloc(16);
    data.writeUInt16LE(0x0600, 0);
    data.writeUInt16LE(kind, 2);
    data.writeUInt16LE(0x0dbb, 4);
    data.writeUInt16LE(0x07cc, 6);
    data.writeUInt32LE(0x00000041, 8);
    data.writeUInt32LE(0x00000006, 12);
    return record(0x0809, data);
  };
  const eof = record(0x000a, Buffer.alloc(0));
  const codepage = Buffer.alloc(2);
  codepage.writeUInt16LE(0x04b0, 0);
  const sheetName = Buffer.from('Sheet1', 'latin1');
  const boundSheet = (offset: number) => {
    const data = Buffer.alloc(8 + sheetName.length);
    data.writeUInt32LE(offset, 0);
    data.writeUInt16LE(0, 4);
    data.writeUInt8(sheetName.length, 6);
    data.writeUInt8(0, 7);
    sheetName.copy(data, 8);
    return record(0x0085, data);
  };
  const globalsLength = bof(0x0005).length + record(0x0042, codepage).length + boundSheet(0).length + eof.length;
  const dimensions = Buffer.alloc(14);
  dimensions.writeUInt32LE(0, 0);
  dimensions.writeUInt32LE(1, 4);
  dimensions.writeUInt16LE(0, 8);
  dimensions.writeUInt16LE(1, 10);
  const workbook = Buffer.concat([bof(0x0005), record(0x0042, codepage), boundSheet(globalsLength), eof, bof(0x0010), record(0x0200, dimensions), eof]);
  const streamSize = 4096;
  const stream = Buffer.alloc(streamSize);
  workbook.copy(stream);

  const SECTOR = 512;
  const FREE = 0xffffffff;
  const END = 0xfffffffe;
  const FAT_SECT = 0xfffffffd;
  const streamSectors = streamSize / SECTOR;
  const header = Buffer.alloc(SECTOR);
  Buffer.from('D0CF11E0A1B11AE1', 'hex').copy(header, 0);
  header.writeUInt16LE(0x003e, 24);
  header.writeUInt16LE(0x0003, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(1, 44);
  header.writeUInt32LE(1, 48);
  header.writeUInt32LE(4096, 56);
  header.writeUInt32LE(END, 60);
  header.writeUInt32LE(0, 64);
  header.writeUInt32LE(END, 68);
  header.writeUInt32LE(0, 72);
  for (let i = 0; i < 109; i += 1) header.writeUInt32LE(i === 0 ? 0 : FREE, 76 + i * 4);

  const fat = Buffer.alloc(SECTOR, 0xff);
  fat.writeUInt32LE(FAT_SECT, 0);
  fat.writeUInt32LE(END, 4);
  for (let s = 0; s < streamSectors; s += 1) fat.writeUInt32LE(s === streamSectors - 1 ? END : 3 + s, (2 + s) * 4);

  const entry = (name: string, type: number, child: number, start: number, size: number) => {
    const data = Buffer.alloc(128);
    if (name) {
      const encoded = Buffer.from(`${name}\0`, 'utf16le');
      encoded.copy(data, 0);
      data.writeUInt16LE(encoded.length, 64);
    }
    data.writeUInt8(type, 66);
    data.writeUInt8(type === 0 ? 0 : 1, 67);
    data.writeUInt32LE(FREE, 68);
    data.writeUInt32LE(FREE, 72);
    data.writeUInt32LE(child, 76);
    data.writeUInt32LE(type === 0 ? 0 : start, 116);
    data.writeUInt32LE(size, 120);
    return data;
  };
  const directory = Buffer.concat([
    entry('Root Entry', 5, 1, END, 0),
    entry('Workbook', 2, FREE, 2, streamSize),
    entry('', 0, FREE, 0, 0),
    entry('', 0, FREE, 0, 0),
  ]);
  return Buffer.concat([header, fat, directory, stream]);
}
