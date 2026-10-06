import { Locator, Page, Request, Response, Route, expect, test } from '@playwright/test';
import type { RowDataPacket } from 'mysql2/promise';
import { BasePage } from './base.page';
import { IncomingDialog } from './stock-dialogs.page';
import { StockListPage } from './stock-list.page';
import { stockDb } from '@utils/stock-db';
import type { WorldSku } from '@utils/stock.data';

/** Path của call ghi 입고 요청 (POST). */
export const INCOMING_PATH = '/api/v1/incoming';

/** Giá trị điền vào 1 dòng SKU của dialog 입고 요청 (undefined = giữ nguyên, '' = xoá trống). */
export interface InboundLine {
  supplyPrice?: string;
  quantity?: string;
  memo?: string;
}

/** Toàn bộ giá trị điền dialog — `warehouseId` chọn theo value (tên kho có thể trùng). */
export interface InboundForm {
  warehouseId?: number;
  expectedDate?: string;
  type?: 'PURCHASE_ORDER' | 'TRANSFER' | 'ETC';
  note?: string;
  lines?: InboundLine[];
}

/** Kết quả 1 lần bấm 저장 đã gửi call POST /incoming. */
export interface InboundSave {
  status: number;
  body: Record<string, unknown>;
  payload: Record<string, unknown>;
}

/** 1 phiếu 입고 + dòng của SKU (bảng incoming / incoming_item). */
export interface IncomingRecord {
  incoming_id: number;
  status: string;
  type: string;
  warehouse_id: number;
  request_date: Date | string | null;
  note: string | null;
  requested_quantity: number;
  purchase_price: number | string;
  memo: string | null;
}

/** Ngày YYYY-MM-DD theo giờ Seoul, cách hôm nay `days` ngày. */
export function kstDate(days = 0): string {
  return new Date(Date.now() + days * 86_400_000 + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** Ngày YYYY-MM-DD theo giờ UTC hôm nay. */
export function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Ngày 1 của tháng sau (giờ Seoul) — thay cho ngày cố định 2026-10-01 của TC (đã qua ở ngày chạy). */
export function firstOfNextMonth(): string {
  const seoul = new Date(Date.now() + 9 * 3_600_000);
  const next = new Date(Date.UTC(seoul.getUTCFullYear(), seoul.getUTCMonth() + 1, 1));
  return next.toISOString().slice(0, 10);
}

/** request_date đọc từ MySQL (DATE → Date 00:00Z) về dạng YYYY-MM-DD. */
export function dbDate(value: Date | string | null): string {
  if (!value) return '';
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

/**
 * Nhóm [Inbound Request] của US134 (TC_US134_174–204) — thao tác bổ sung cho dialog 입고 요청 (`IncomingDialog` dùng
 * chung, không sửa file đó): chọn 입고지 theo id, điền cả form, bắt call POST /incoming, đếm call ghi, bộ đếm ký tự
 * (`n/100` dưới ô), dòng bị đánh dấu lỗi, lịch date picker (react-datepicker), lỗi validate trong dialog / toast,
 * đọc phiếu 입고 trong DB. DOM dialog verify theo recon out/dlg-incoming.html (05/10/2026).
 */
export class StockInboundPage extends BasePage {
  constructor(
    page: Page,
    readonly list: StockListPage,
    readonly dialog: IncomingDialog,
  ) {
    super(page);
  }

  /** Lịch của date picker 입고 예정일 (popup react-datepicker). */
  get datePicker(): Locator { return this.page.locator('.react-datepicker[role="dialog"], .react-datepicker').first(); }
  get datePickerMonth(): Locator { return this.datePicker.locator('.react-datepicker__current-month, .react-datepicker__header [class*="month"]').first(); }
  get datePickerNext(): Locator { return this.datePicker.locator('button.react-datepicker__navigation--next'); }
  get datePickerPrevious(): Locator { return this.datePicker.locator('button.react-datepicker__navigation--previous'); }
  get datePickerDays(): Locator { return this.datePicker.locator('.react-datepicker__day:not(.react-datepicker__day--outside-month)'); }
  /** Nút không phải điều hướng tháng trong lịch (VD nút chọn nhanh khoảng ngày). */
  get datePickerExtraButtons(): Locator { return this.datePicker.locator('button:not(.react-datepicker__navigation)'); }
  /** Ô nhập trong khung date picker (khoảng ngày → 2 ô). */
  get dateInputs(): Locator { return this.dialog.body.locator('.react-datepicker-wrapper input'); }
  get typeLabelTexts(): Locator { return this.dialog.typeLabels; }

  /** Dòng lỗi validate / lỗi server hiện trong dialog (alert, feedback dưới ô) hoặc toast. */
  message(text: string): Locator {
    return this.page.locator('.modal.show .alert-danger, .modal.show .invalid-feedback, .modal.show .text-danger.small, .toast-container .toast').filter({ hasText: text }).first();
  }

  /** Bộ đếm ký tự `n/max` ngay dưới ô nhập. */
  counterOf(input: Locator): Locator {
    return input.locator('xpath=..').locator('div.text-muted').filter({ hasText: /^\s*\d+\s*\/\s*\d+\s*$/ }).first();
  }

  /** Tick các dòng (bỏ qua dòng đã tick) rồi bấm 입고 요청 và đợi dialog mở. */
  async openFor(rows: Array<{ row: Locator; label: string }>): Promise<void> {
    await test.step(`Open 입고 요청 for ${rows.map((r) => r.label).join(', ')}`, async () => {
      for (const { row, label } of rows) {
        if (!(await this.list.checkbox(row).isChecked())) await this.list.tick(row, label);
      }
      await this.list.clickToolbar('btn.incomingRequest');
      await this.dialog.waitOpen(this.list.lang);
    });
  }

  /** Mở lại list tìm theo 상품코드 của SKU riêng của test (mọi dòng của nhóm SKU). */
  async showGroup(sku: WorldSku): Promise<void> {
    await this.list.search('SKU_GROUP_CODE', sku.groupCode);
  }

  async chooseWarehouseById(id: number, description: string): Promise<void> {
    await test.step(`Choose inbound destination ${description}`, async () => {
      await this.dialog.warehouseSelect.selectOption(String(id));
    });
  }

  /** value + nhãn của mọi option 입고지 (option đầu là placeholder value rỗng). */
  async warehouseOptionEntries(): Promise<Array<{ value: string; label: string }>> {
    return this.dialog.warehouseSelect.locator('option').evaluateAll((options) =>
      options.map((option) => ({ value: (option as HTMLOptionElement).value, label: (option.textContent ?? '').trim() })),
    );
  }

  /** Điền dialog theo `form` (chỉ trường được truyền). */
  async fill(form: InboundForm): Promise<void> {
    await test.step('Fill the inbound request dialog', async () => {
      if (form.warehouseId !== undefined) await this.dialog.warehouseSelect.selectOption(String(form.warehouseId));
      if (form.expectedDate !== undefined) await this.dialog.typeExpectedDate(form.expectedDate);
      if (form.type) await this.dialog.typeRadio(form.type).check();
      if (form.note !== undefined) await this.dialog.etcNote.fill(form.note);
      for (const [index, line] of (form.lines ?? []).entries()) await this.dialog.fillLine(index, line);
    });
  }

  /** Bấm 저장 và đợi call POST /incoming trả về — trả về status, body lỗi/thành công và payload đã gửi. */
  async save(): Promise<InboundSave> {
    const response = this.page.waitForResponse((res) => isIncomingPost(res.request()), { timeout: 60_000 });
    await this.dialog.clickSave();
    return readSave(await response);
  }

  /** Bấm 저장 (lưu thành công) và đợi list tải lại. */
  async saveAndReload(): Promise<InboundSave> {
    let result!: InboundSave;
    await this.list.waitForListReload(async () => {
      result = await this.save();
    });
    return result;
  }

  /** Bấm 저장 và theo dõi list có tải lại sau đó không (`reloaded` = true khi GET /stock-status chạy lại trong 30 s). */
  async saveWatchingReload(): Promise<{ save: InboundSave; reloaded: Promise<boolean> }> {
    const reloaded = this.page
      .waitForResponse((res) => res.url().includes('/api/v1/stock-status?') && res.request().method() === 'GET', { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    const save = await this.save();
    return { save, reloaded };
  }

  /**
   * Bấm 저장 khi chưa chắc call có được gửi (validate phía client có thể chặn): đợi tối đa `timeout` ms cho response,
   * trả về null khi không có call nào.
   */
  async trySave(timeout = 15_000): Promise<InboundSave | null> {
    const response = this.page.waitForResponse((res) => isIncomingPost(res.request()), { timeout }).catch(() => null);
    await this.dialog.clickSave();
    const res = await response;
    return res ? readSave(res) : null;
  }

  /** Ô tick đang được tick trên bảng 재고 목록. */
  get checkedRowBoxes(): Locator {
    return this.list.table.locator('tbody input[type="checkbox"]:checked');
  }

  /** Đếm mọi call POST /incoming trình duyệt gửi từ lúc gọi tới lúc `stop()`. */
  countPosts(): { readonly count: number; stop: () => void } {
    let count = 0;
    const listener = (request: Request) => {
      if (isIncomingPost(request)) count += 1;
    };
    this.page.on('request', listener);
    return {
      get count() {
        return count;
      },
      stop: () => this.page.off('request', listener),
    };
  }

  /** Dòng `index` của bảng SKU (hoặc ô nhập trong dòng) mang class lỗi (is-invalid / danger). */
  async lineHighlighted(index: number): Promise<boolean> {
    return this.dialog.rows.nth(index).evaluate((tr) =>
      [tr, ...Array.from(tr.querySelectorAll('*'))].some((node) => /is-invalid|danger|error/.test((node as HTMLElement).className?.toString() ?? '')),
    );
  }

  /** Tag + thuộc tính chỉnh sửa của phần tử (TC "plain text, not an input"). */
  async elementKind(locator: Locator): Promise<{ tag: string; editable: boolean; inputs: number }> {
    return locator.evaluate((el) => ({
      tag: el.tagName.toLowerCase(),
      editable: (el as HTMLElement).isContentEditable,
      inputs: el.querySelectorAll('input, select, textarea').length,
    }));
  }

  /** Mở lịch, đi tới tháng của `date` (YYYY-MM-DD) bằng nút tháng trước / sau rồi chọn ngày. */
  async pickDate(date: string): Promise<void> {
    await test.step(`Pick ${date} in the date picker`, async () => {
      const [year, month, day] = date.split('-').map(Number);
      if (!(await this.datePicker.isVisible())) await this.dialog.expectedDateInput.click();
      await expect(this.datePicker, 'The date picker calendar must open').toBeVisible();
      for (let attempt = 0; attempt < 36; attempt += 1) {
        const shown = await this.shownMonth();
        if (shown.year === year && shown.month === month) break;
        const forward = shown.year * 12 + shown.month < year * 12 + month;
        await (forward ? this.datePickerNext : this.datePickerPrevious).click();
      }
      await this.datePickerDays.filter({ hasText: new RegExp(`^${day}$`) }).first().click();
    });
  }

  /** Năm / tháng lịch đang hiện (đọc tiêu đề "2026년 10월" / "October 2026" / "2026-10"). */
  async shownMonth(): Promise<{ year: number; month: number }> {
    const text = (await this.datePickerMonth.innerText()).trim();
    const year = Number(/(\d{4})/.exec(text)?.[1] ?? 0);
    const names = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    const named = names.findIndex((name) => text.toLowerCase().includes(name));
    const numeric = Number(/(\d{1,2})\s*월/.exec(text)?.[1] ?? /\d{4}[-./]\s*(\d{1,2})/.exec(text)?.[1] ?? 0);
    return { year, month: named >= 0 ? named + 1 : numeric };
  }

  /** Đổi múi giờ của trình duyệt đang mở (CDP Emulation — Chromium / Edge). */
  async setBrowserTimezone(timezoneId: string): Promise<void> {
    await test.step(`Change the browser time zone to ${timezoneId}`, async () => {
      const session = await this.page.context().newCDPSession(this.page);
      await session.send('Emulation.setTimezoneOverride', { timezoneId });
    });
  }

  /** Bấm 취소 của dialog và — nếu hiện hộp xác nhận (dialog đã nhập liệu) — chọn 닫기; đợi dialog đóng hẳn. */
  async discard(): Promise<void> {
    await test.step('Close the inbound request dialog without saving', async () => {
      await this.dialog.clickCancel();
      const confirm = this.dialog.confirmClose;
      await expect(async () => {
        if (await confirm.isVisible()) await this.dialog.confirmDiscard();
        await expect(this.dialog.root).toHaveCount(0, { timeout: 1_000 });
      }, 'The dialog closes (after confirming when asked)').toPass({ timeout: 15_000 });
    });
  }

  /** Đóng dialog nếu đang mở rồi mở lại 입고 요청 cho 1 dòng (SKU × kho) — mỗi vòng TC bắt đầu từ dialog mới. */
  async reopenFor(sku: WorldSku, warehouseName: string): Promise<void> {
    if ((await this.dialog.root.count()) > 0) await this.discard();
    await this.list.search('SKU_CODE', sku.skuCode);
    await this.openFor([{ row: this.list.row(sku.skuCode, warehouseName), label: sku.skuCode }]);
  }

  /** Giữ nguyên request POST /incoming cho tới khi `release()` (kiểm trạng thái nút 저장 lúc request đang chạy). */
  async holdIncomingPost(): Promise<{ seen: Promise<Request>; release: () => void; dispose: () => Promise<void> }> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markSeen!: (request: Request) => void;
    const seen = new Promise<Request>((resolve) => {
      markSeen = resolve;
    });
    const handler = async (route: Route) => {
      if (!isIncomingPost(route.request())) {
        await route.fallback();
        return;
      }
      markSeen(route.request());
      await gate;
      await route.continue();
    };
    await this.page.route('**/api/v1/**', handler);
    return { seen, release, dispose: () => this.page.unroute('**/api/v1/**', handler) };
  }

  /** Đợi response của call POST /incoming kế tiếp. */
  nextIncomingResponse(timeout = 60_000): Promise<InboundSave> {
    return this.page.waitForResponse((res) => isIncomingPost(res.request()), { timeout }).then(readSave);
  }
}

function isIncomingPost(request: Request): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === INCOMING_PATH;
}

async function readSave(response: Response): Promise<InboundSave> {
  let body: Record<string, unknown> = {};
  try {
    body = ((await response.json()) ?? {}) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: response.status(), body, payload: (response.request().postDataJSON() ?? {}) as Record<string, unknown> };
}

/** code / message của body lỗi Problem Details. */
export function errorOf(result: { status: number; body: unknown }): { status: number; code: string; message: string } {
  const body = (result.body ?? {}) as { code?: string; message?: string; detail?: string };
  return { status: result.status, code: body.code ?? '', message: body.message ?? body.detail ?? '' };
}

/** Phiếu 입고 của 1 SKU (mới nhất trước). */
export async function incomingsOf(sku: WorldSku): Promise<IncomingRecord[]> {
  return (await stockDb.incomingsOfSku(sku.skuId)) as unknown as IncomingRecord[];
}

/** Phiếu 입고 trỏ vào 1 kho (đếm request tới kho bị từ chối). */
export async function incomingsToWarehouse(warehouseId: number): Promise<number> {
  const rows = await stockDb.query<RowDataPacket>('SELECT COUNT(*) AS n FROM incoming WHERE warehouse_id = ?', [warehouseId]);
  return Number(rows[0]?.n ?? 0);
}

/** Bản ghi header incoming đầy đủ cột (kiểm trường tham chiếu). */
export async function incomingHeader(incomingId: number): Promise<Record<string, unknown>> {
  const rows = await stockDb.query<RowDataPacket>('SELECT * FROM incoming WHERE id = ?', [incomingId]);
  return (rows[0] ?? {}) as Record<string, unknown>;
}

/** Dòng incoming_item của 1 phiếu 입고 (trường tham chiếu ref_type / ref_id). */
export async function incomingItems(incomingId: number): Promise<Array<Record<string, unknown>>> {
  return (await stockDb.query<RowDataPacket>('SELECT * FROM incoming_item WHERE incoming_id = ?', [incomingId])) as Array<Record<string, unknown>>;
}

/** Bỏ mã kho CJ của 1 kho WMS do suite tạo (API kho bắt buộc mã này nên không tạo thiếu mã qua API được). */
export async function clearCjWarehouseCode(warehouseId: number): Promise<void> {
  await stockDb.exec('UPDATE warehouse SET logistics_channel_warehouse_code = NULL WHERE id = ?', [warehouseId]);
}

/** Ép trạng thái 1 phiếu 입고 (bước REGISTERED → REQUESTED thuộc US032/US033, không có đường trên màn này). */
export async function forceIncomingStatus(incomingId: number, status: 'REQUESTED' | 'REGISTERED'): Promise<void> {
  await stockDb.exec('UPDATE incoming SET status = ?, updated_at = NOW(6) WHERE id = ?', [status, incomingId]);
}
