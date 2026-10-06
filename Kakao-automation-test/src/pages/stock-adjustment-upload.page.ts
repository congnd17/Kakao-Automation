import * as fs from 'fs';
import { Download, FileChooser, Locator, Page, Request, Route, expect, test } from '@playwright/test';
import { RowDataPacket } from 'mysql2/promise';
import { StockAdjustmentPage } from './stock-adjustment.page';
import { StockListPagingPage } from './stock-list-paging.page';
import { stockDb } from '@utils/stock-db';
import { XLSX_MIME, XlsxCell, xlsxFile } from '@utils/xlsx-writer';
import { readXlsxRows } from '@utils/xlsx-reader';

/**
 * Nhóm [Adjustment Upload] + [List Export] + [Stock History Export] của US134 — bổ sung cho màn 재고 관리 (bundle 05/10/2026):
 *  - Nhãn upload `kH`: `label[role=button]` bọc `input[type=file] accept=".xlsx,.xls"`; chọn file là gửi ngay
 *    (POST /api/v1/adjustments/upload-excel, field `file`), nhãn `aria-disabled=true` trong lúc gửi. Thành công → toast
 *    success `msg.uploadAdjustmentDone` rồi list gọi lại GET /stock-status (giữ nguyên dòng đã tick); lỗi → toast danger
 *    mang `message` của server, list KHÔNG gọi lại.
 *  - 엑셀 다운로드 của list: GET /stock-status/excel với filter ĐÃ ÁP DỤNG (không page/size), tải file đồng bộ (blob →
 *    thẻ a download "Stock management.xlsx"), thành công → toast `msg.exportQueued`, lỗi → im lặng (console.error).
 *  - 엑셀 다운로드 trong 재고이력: GET /stock-usages/excel?skuId&warehouseId, thành công → toast, lỗi → alert trong dialog
 *    `err.historyExportFailed`.
 *  - Panel tải về của host header: toggle `#downloadDropdown`, menu `.dropdown-menu` (chỉ dùng cho export bất đồng bộ).
 */
export const ADJ_UPLOAD_URL = '/api/v1/adjustments/upload-excel';
export const LIST_EXPORT_PATH = '/api/v1/stock-status/excel';
export const HISTORY_EXPORT_PATH = '/api/v1/stock-usages/excel';

/** 6 cột workbook 재고 조정 업로드 — header tiếng Hàn, server khớp cột theo chữ header. */
export const ADJ_HEADERS = ['SKU 코드', '창고 ID', '조정수량', '증가(P)/차감(M)', '조정사유코드', '비고'] as const;

/** 20 cột file export list theo TC (22 cột list bỏ ô tick + 재고이력). */
export const LIST_EXPORT_HEADERS = [
  '상품코드', 'SKU명', 'SKU코드', '바코드', '전체재고', '할당재고', '가용재고', 'CS재고(가용재고)', 'CS재고(CS가능수량)', '할당대기재고',
  '주문가능수량', '입고예정수량', '재고부족수량', '미확보 출고수량', 'SKU 유형', '창고', '제조사', 'SKU ID', '비즈파트너', '생성일',
] as const;

/** 10 cột file export 재고이력 theo TC (= 10 cột dialog). */
export const HISTORY_EXPORT_HEADERS = ['날짜', '구분', '상세구분', '번호', '비고', '변경전 수량', '변경수량', '변경 후 수량', '작업자', '작업자 ip'] as const;

/** 1 dòng dữ liệu workbook 조정 (ô `null` = để trống). */
export interface AdjLine {
  skuCode: XlsxCell;
  warehouseId: XlsxCell;
  quantity: XlsxCell;
  direction: XlsxCell;
  reason?: XlsxCell;
  note?: XlsxCell;
}

/** Mã lý do hợp lệ dùng trong workbook (cùng enum với dialog 조정사유). */
export const ADJ_REASON = 'ADJUSTMENT';

export function adjustmentRows(lines: AdjLine[], headers: readonly string[] = ADJ_HEADERS): XlsxCell[][] {
  const byHeader = (line: AdjLine): Record<string, XlsxCell> => ({
    'SKU 코드': line.skuCode,
    '창고 ID': line.warehouseId,
    조정수량: line.quantity,
    '증가(P)/차감(M)': line.direction,
    조정사유코드: line.reason === undefined ? ADJ_REASON : line.reason,
    비고: line.note ?? null,
  });
  return [[...headers], ...lines.map((line) => headers.map((header) => byHeader(line)[header] ?? null))];
}

/** Workbook .xlsx 조정 (header 6 cột mặc định). */
export function adjustmentWorkbook(name: string, lines: AdjLine[], headers: readonly string[] = ADJ_HEADERS): { name: string; mimeType: string; buffer: Buffer } {
  return xlsxFile(name, adjustmentRows(lines, headers));
}

/** File bất kỳ (text, CSV, rỗng, hỏng) mang tên `name` — giả lập file đổi đuôi. */
export function rawFile(name: string, buffer: Buffer, mimeType = XLSX_MIME): { name: string; mimeType: string; buffer: Buffer } {
  return { name, mimeType, buffer };
}

/** File .xls kiểu OLE2 (chữ ký D0 CF 11 E0 A1 B1 1A E1 + header 512 byte) — đủ để server nhận ra định dạng Excel 97-2003. */
export function ole2XlsFile(name: string): { name: string; mimeType: string; buffer: Buffer } {
  const buffer = Buffer.alloc(4096);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(buffer, 0);
  buffer.writeUInt16LE(0x003e, 24);
  buffer.writeUInt16LE(0x0003, 26);
  buffer.writeUInt16LE(0xfffe, 28);
  buffer.writeUInt16LE(0x0009, 30);
  buffer.writeUInt16LE(0x0006, 32);
  return { name, mimeType: 'application/vnd.ms-excel', buffer };
}

/** Kết quả 1 lần upload qua nút 재고 조정 업로드. */
export interface UploadOutcome {
  status: number;
  code: string;
  message: string;
  body: unknown;
  /** Mọi URL upload-excel trình duyệt gửi trong lần này. */
  uploadUrls: string[];
  /** Số lượt GET /stock-status gửi sau khi upload trả lời (tới lúc nhãn upload bật lại). */
  listReloads: number;
}

/** Kết quả 1 lần bấm 엑셀 다운로드 (list hoặc 재고이력). */
export interface ExportOutcome {
  requestUrl: URL;
  status: number;
  contentType: string;
  contentDisposition: string;
  elapsedMs: number;
  download: Download | null;
  fileName: string;
  rows: string[][];
}

/** File trả về là chính bảng tính (tải đồng bộ), không phải phiếu yêu cầu tải nền. */
export const isSpreadsheetAnswer = (outcome: ExportOutcome): boolean =>
  /spreadsheetml|octet-stream|ms-excel/.test(outcome.contentType) || /attachment|filename/i.test(outcome.contentDisposition);

export class StockAdjustmentUploadPage extends StockAdjustmentPage {
  readonly paging: StockListPagingPage;
  readonly openModals: Locator;
  readonly downloadToggle: Locator;
  readonly downloadPanel: Locator;

  constructor(page: Page) {
    super(page);
    this.paging = new StockListPagingPage(page, this);
    this.openModals = page.locator('.modal.show');
    this.downloadToggle = page.locator('#downloadDropdown');
    this.downloadPanel = page.locator('.header-element').filter({ has: this.downloadToggle }).locator('.dropdown-menu');
  }

  /** Toast có đúng câu `text`. */
  toast(text: string): Locator {
    return this.toasts.filter({ hasText: text });
  }

  /** Bấm nhãn 재고 조정 업로드 và nhận hộp chọn file của OS (chưa chọn file). */
  async openAdjustmentPicker(): Promise<FileChooser> {
    return test.step('Click 재고 조정 업로드 (Upload stock adjustment) and receive the file picker', async () => {
      const chooser = this.page.waitForEvent('filechooser', { timeout: 15_000 });
      await this.uploadAdjustmentButton.click();
      return chooser;
    });
  }

  /**
   * Chọn `file` trong hộp chọn file (đã mở hoặc mở mới) và đợi server trả lời upload, rồi đợi nhãn upload bật lại
   * (lúc này lượt tải lại list — nếu có — đã xong). Đếm URL upload và lượt GET /stock-status phát ra.
   */
  async uploadAdjustment(file: { name: string; mimeType: string; buffer: Buffer }, chooser?: FileChooser): Promise<UploadOutcome> {
    return test.step(`Upload ${file.name} (${file.buffer.length} bytes) through 재고 조정 업로드`, async () => {
      const uploadUrls: string[] = [];
      let answered = false;
      let listReloads = 0;
      const listener = (request: Request) => {
        if (request.method() === 'POST' && request.url().includes('/upload-excel')) uploadUrls.push(request.url());
        if (answered && request.method() === 'GET' && /\/api\/v1\/stock-status\?/.test(request.url())) listReloads += 1;
      };
      this.page.on('request', listener);
      try {
        const response = this.page.waitForResponse((res) => res.url().includes('/upload-excel') && res.request().method() === 'POST', { timeout: 180_000 });
        const picker = chooser ?? (await this.openAdjustmentPicker());
        await picker.setFiles(file);
        const res = await response;
        answered = true;
        const body = (await res.json().catch(() => null)) as { code?: string; message?: string; detail?: string } | null;
        await expect(this.uploadAdjustmentButton, 'The upload button must be usable again once the upload has finished').toHaveAttribute('aria-disabled', 'false', { timeout: 60_000 });
        await this.waitForList();
        return { status: res.status(), code: body?.code ?? '', message: body?.message ?? body?.detail ?? '', body, uploadUrls, listReloads };
      } finally {
        this.page.off('request', listener);
      }
    });
  }

  /** Tổng số bản ghi bảng `adjustment` (TC so "adjustment count" trước / sau khi workbook không có dòng SKU). */
  async adjustmentTotal(): Promise<number> {
    const rows = await stockDb.query<RowDataPacket>('SELECT COUNT(*) AS total FROM adjustment');
    return Number(rows[0].total);
  }

  /** Số bản ghi `adjustment` của các SKU. */
  async adjustmentCount(skuIds: number[]): Promise<number> {
    let total = 0;
    for (const skuId of skuIds) total += (await stockDb.adjustments(skuId)).length;
    return total;
  }

  /** 가용재고 hiển thị trên list của SKU × kho (tìm theo SKU코드). */
  async availableOnList(skuCode: string, warehouseName: string): Promise<string> {
    await this.search('SKU_CODE', skuCode);
    const row = this.row(skuCode, warehouseName);
    return (await row.count()) > 0 ? this.cellText(row, 'col.availableQuantity') : '<row not listed>';
  }

  /**
   * Bấm nút 엑셀 다운로드 `button` và đợi lời đáp của `path`; nếu trình duyệt nhận file (tải đồng bộ) thì đọc file.
   * `download` = null khi không có file nào vào danh sách tải về của trình duyệt.
   */
  async exportVia(button: Locator, path: string, downloadTimeout = 120_000): Promise<ExportOutcome> {
    return test.step(`Click 엑셀 다운로드 (Excel download) and read the ${path} call`, async () => {
      const request = this.page.waitForRequest((req) => new URL(req.url()).pathname === path, { timeout: 30_000 });
      const response = this.page.waitForResponse((res) => new URL(res.url()).pathname === path, { timeout: 180_000 });
      const downloadEvent = this.page.waitForEvent('download', { timeout: downloadTimeout }).catch(() => null);
      const started = Date.now();
      await this.click(button, '엑셀 다운로드 (Excel download) button');
      const req = await request;
      const res = await response;
      const elapsedMs = Date.now() - started;
      const headers = res.headers();
      const download = res.status() < 300 ? await downloadEvent : null;
      const rows = download ? readXlsxRows(fs.readFileSync(await download.path())) : [];
      return {
        requestUrl: new URL(req.url()),
        status: res.status(),
        contentType: headers['content-type'] ?? '',
        contentDisposition: headers['content-disposition'] ?? '',
        elapsedMs,
        download,
        fileName: download?.suggestedFilename() ?? '',
        rows,
      };
    });
  }

  /** 엑셀 다운로드 của list (filter đang áp dụng). */
  async exportList(): Promise<ExportOutcome> {
    return this.exportVia(this.exportButton, LIST_EXPORT_PATH);
  }

  /** 엑셀 다운로드 trong dialog 재고이력 đang mở. */
  async exportHistory(): Promise<ExportOutcome> {
    return this.exportVia(this.history.exportButton, HISTORY_EXPORT_PATH);
  }

  /** Ép mọi lời gọi `path` trả 500 (thay cho tắt mạng) — trả về hàm gỡ route. */
  async forceFailure(path: string): Promise<() => Promise<void>> {
    const matcher = (url: URL) => url.pathname === path;
    const handler = async (route: Route) => {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'CMN-5000', message: 'Forced failure (automation)' }) });
    };
    await this.page.route(matcher, handler);
    return () => this.page.unroute(matcher, handler);
  }

  /** Bấm nút export trong lúc lời gọi bị ép lỗi — đợi lời đáp lỗi rồi đợi nút bật lại. */
  async failedExportVia(button: Locator, path: string): Promise<number> {
    return test.step(`Click 엑셀 다운로드 (Excel download) while ${path} is forced to fail`, async () => {
      const response = this.page.waitForResponse((res) => new URL(res.url()).pathname === path, { timeout: 30_000 });
      await this.click(button, '엑셀 다운로드 (Excel download) button');
      const status = (await response).status();
      await expect(button, 'The export button must be usable again after the failed call').toBeEnabled({ timeout: 30_000 });
      return status;
    });
  }

  /** Số dòng dữ liệu của file (bỏ dòng header, bỏ dòng rỗng hoàn toàn). */
  static dataRows(rows: string[][]): string[][] {
    return rows.slice(1).filter((row) => row.some((cell) => cell !== ''));
  }
}

/** Mốc giờ Seoul `YYYYMMDD_HHmmss` của thời điểm `date`. */
export function seoulStamp(date: Date): string {
  return new Date(date.getTime() + 9 * 3_600_000).toISOString().slice(0, 19).replace(/-/g, '').replace(/:/g, '').replace('T', '_');
}

/** `YYYYMMDD_HHmmss` → thời điểm (hiểu theo giờ Seoul). */
export function parseSeoulStamp(stamp: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  if (!m) return new Date(NaN);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), Number(m[6])));
}
