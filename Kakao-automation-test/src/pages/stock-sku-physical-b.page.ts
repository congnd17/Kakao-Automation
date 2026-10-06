import { Page, Locator, Response, expect, test } from '@playwright/test';
import type { RowDataPacket } from 'mysql2/promise';
import { SkuFormPage } from './sku-form.page';
import { StockListPage, escapeRegex, iconButtonName } from './stock-list.page';
import type { SkuUsageType, StockApi } from '@api/stock.api';
import type { WorldPartner } from '@utils/stock.data';
import { stockDb } from '@utils/stock-db';
import { readXlsxRows } from '@utils/xlsx-reader';

/** Dữ liệu điền form 현물 SKU — `''` = để trống trường đó, `undefined` = giá trị mặc định của TC. */
export interface PhysicalFormData {
  partnerId?: number | null;
  groupCode: string;
  groupName: string;
  usageType?: SkuUsageType;
  price?: string;
  hasOption?: boolean;
  lines: Array<{ skuCode: string; skuName?: string; exportSkuName?: string; barcode: string }>;
  weight?: string;
  volume?: [string, string, string];
  hsCode?: string;
  description?: string;
  manufacturerId?: number | null;
  country?: string;
}

/** Kết quả 1 lần bấm 저장: nút bị khoá / bị chặn ở client (kèm toast) / đã gửi lên server (kèm response). */
export interface SaveAttempt {
  disabled: boolean;
  sent: boolean;
  toast: string | null;
  status: number | null;
  body: Record<string, unknown> | null;
  requestBody: Record<string, unknown> | null;
}

/** Giá trị mặc định theo bộ test data chung của nhóm TC [Physical SKU Form]. */
export const TC_DEFAULTS = {
  price: '12000',
  weight: '250',
  volume: ['100', '80', '30'] as [string, string, string],
  hsCode: '6109101000',
  description: 'CD',
  exportSkuName: 'CS_ 2026 SPRING',
  country: 'KR',
} as const;

const isSkuWrite = (url: string, method: string): boolean => {
  const path = new URL(url).pathname;
  return (path === '/api/v1/skus' || path.startsWith('/api/v1/skus/')) && !path.includes('check-duplication') && !path.includes('upload-excel') && ['POST', 'PATCH'].includes(method);
};

/**
 * Bổ sung cho form 현물 SKU (TC_US134_118–142): chọn biz partner / 제조사 theo id (tên partner trên dev có trùng), điền form
 * theo bộ data TC, qua 2 bước 중복확인, bấm 저장 và đọc kết quả (khoá / chặn ở client / server trả lỗi), lỗi trang
 * (`.alert-danger` nằm NGOÀI card form), dòng prefix (FREE OF CHARGE) dưới ô 수출용 SKU명, đơn vị g / mm.
 * Hành vi lấy từ bundle 05/10/2026 (Nue / y8t / C8t / Zq / e8).
 */
export class PhysicalSkuFormB extends SkuFormPage {
  /** Lỗi trang của form (lưu thất bại) — `Alert variant=danger` render trước card, không nằm trong card. */
  readonly pageAlert = this.page.locator('div.alert-danger.alert-dismissible').first();

  constructor(page: Page) {
    super(page);
  }

  toast(text: string): Locator {
    return this.toasts.filter({ hasText: text });
  }

  /** Đóng mọi toast đang hiện để toast của thao tác kế tiếp đọc được chắc chắn. */
  async dismissToasts(): Promise<void> {
    await test.step('Close the toasts still on screen', async () => {
      for (let count = await this.toasts.count(); count > 0; count = await this.toasts.count()) {
        await this.toasts.first().locator('.btn-close').click().catch(() => undefined);
        await expect(this.toasts, 'The closed toast must disappear').toHaveCount(count - 1, { timeout: 10_000 }).catch(() => undefined);
      }
    });
  }

  /** Nội dung chữ của toast (bỏ icon ✓ / ✕). */
  async toastMessage(toast: Locator): Promise<string> {
    return ((await toast.locator('.toast-body > span').nth(1).textContent()) ?? '').trim();
  }

  async choosePartnerId(id: number): Promise<void> {
    await test.step(`Choose biz partner id ${id}`, async () => {
      await expect(this.bizPartnerSelect.locator(`option[value="${id}"]`), `Biz partner ${id} must be offered`).toHaveCount(1, { timeout: 30_000 });
      await this.bizPartnerSelect.selectOption(String(id));
    });
  }

  async clearPartner(): Promise<void> {
    await test.step('Clear the biz partner', async () => {
      await this.bizPartnerSelect.selectOption('');
    });
  }

  async chooseManufacturerId(id: number): Promise<void> {
    await test.step(`Choose manufacturer id ${id}`, async () => {
      await expect(this.manufacturerSelect.locator(`option[value="${id}"]`), `Manufacturer ${id} must be offered`).toHaveCount(1, { timeout: 30_000 });
      await this.manufacturerSelect.selectOption(String(id));
    });
  }

  async clearManufacturer(): Promise<void> {
    await test.step('Clear the manufacturer', async () => {
      await this.manufacturerSelect.selectOption('');
    });
  }

  /** Giá trị 원산지 đang chọn (react-select single value). */
  get countryValue(): Locator {
    return this.field('skuForm.field.countryOfOrigin').locator('[class*="singleValue"]');
  }

  /** Thử xoá 원산지 bằng bàn phím (react-select không có nút xoá). */
  async tryClearCountry(): Promise<void> {
    await test.step('Try to clear the country of origin with the keyboard', async () => {
      await this.countryInput.focus();
      await this.countryInput.press('Backspace');
      await this.countryInput.press('Delete');
      await this.countryInput.blur();
    });
  }

  /** Text các option của 1 select (textContent). */
  async optionTexts(select: Locator): Promise<string[]> {
    return (await select.locator('option').allTextContents()).map((text) => text.trim());
  }

  /** Đơn vị in cạnh ô nhập (InputGroup.Text) của 1 trường. */
  unitTexts(field: Locator): Locator {
    return field.locator('.input-group-text');
  }

  get volumeGroup(): Locator {
    return this.field('skuForm.field.volume').getByRole('group');
  }

  /** Dòng prefix "(FREE OF CHARGE) …" dưới ô 수출용 SKU명 của dòng `index` (chỉ hiện khi SKU 종류 ≠ 본품). */
  lineExportPreview(index: number): Locator {
    return this.lineRows.nth(index).locator('div.small.text-muted');
  }

  lineExportError(index: number): Locator {
    return this.lineRows.nth(index).locator('.invalid-feedback');
  }

  async lineHeaderTexts(): Promise<string[]> {
    return (await this.lineHeaders.allTextContents()).map((text) => text.trim());
  }

  /** Mọi nút / link trên màn có chữ 제조사 추가 / 제조사 생성 (Add / Create manufacturer). */
  get addManufacturerActions(): Locator {
    return this.page.locator('a, button, [role="button"]').filter({ hasText: /제조사\s*(추가|생성)|(Add|Create)\s+manufacturer/i });
  }

  /** Điền form 현물 theo bộ data TC (không bấm 중복확인). */
  async fillForm(data: PhysicalFormData): Promise<void> {
    await test.step(`Fill the physical SKU form for product code ${data.groupCode}`, async () => {
      if (data.partnerId) await this.choosePartnerId(data.partnerId);
      await this.skuGroupCodeInput.fill(data.groupCode);
      await this.skuGroupCodeNameInput.fill(data.groupName);
      await this.usageRadio(data.usageType ?? 'MAIN').check();
      await this.priceInput.fill(data.price ?? TC_DEFAULTS.price);
      if (data.hasOption) await this.optionHas.check();
      for (let index = 0; index < data.lines.length; index += 1) {
        if (index > 0) await this.addButton.click();
        const line = data.lines[index];
        await this.lineInput(index, 'skuCode').fill(line.skuCode);
        if (data.hasOption) await this.lineInput(index, 'skuName').fill(line.skuName ?? '');
        await this.lineInput(index, 'exportSkuName').fill(line.exportSkuName ?? TC_DEFAULTS.exportSkuName);
        await this.lineInput(index, 'barcode').fill(line.barcode);
      }
      await this.weightInput.fill(data.weight ?? TC_DEFAULTS.weight);
      const [width, depth, height] = data.volume ?? TC_DEFAULTS.volume;
      await this.widthInput.fill(width);
      await this.depthInput.fill(depth);
      await this.heightInput.fill(height);
      await this.hsCodeInput.fill(data.hsCode ?? TC_DEFAULTS.hsCode);
      await this.descriptionInput.fill(data.description ?? TC_DEFAULTS.description);
      if (data.manufacturerId) await this.chooseManufacturerId(data.manufacturerId);
      const country = data.country ?? TC_DEFAULTS.country;
      if (country) await this.chooseCountry(country);
    });
  }

  /** 상품코드 중복확인 — thành công khi ô 상품코드 chuyển sang chỉ đọc. */
  async passCodeCheck(): Promise<void> {
    await test.step('Pass the product code duplicate check', async () => {
      await this.checkCode();
      await expect(this.skuGroupCodeInput, 'The product code is locked once the duplicate check passes').toHaveAttribute('readonly', '', { timeout: 15_000 });
    });
  }

  /** 바코드 중복확인 — thành công khi nút đổi sang 다른 바코드 사용. */
  async passBarcodeCheck(): Promise<void> {
    await test.step('Pass the barcode duplicate check', async () => {
      await this.checkBarcode();
      await expect(this.useOtherBarcodeButton, 'The barcode check turns into 다른 바코드 사용 once it passes').toBeVisible({ timeout: 15_000 });
    });
  }

  async passBothChecks(): Promise<void> {
    await this.passCodeCheck();
    await this.passBarcodeCheck();
  }

  /**
   * Bấm 저장 (nếu bật) và đọc kết quả: chặn ở client → toast; gửi lên server → status + body. Toast cũ được đóng trước để
   * toast mới là của lần bấm này.
   */
  async attemptSave(): Promise<SaveAttempt> {
    const attempt: SaveAttempt = { disabled: false, sent: false, toast: null, status: null, body: null, requestBody: null };
    await test.step(`Try to click ${this.t('btn.save')}`, async () => {
      if (!(await this.saveButton.isEnabled())) {
        attempt.disabled = true;
        return;
      }
      await this.dismissToasts();
      const write = this.page.waitForResponse((res) => isSkuWrite(res.url(), res.request().method()), { timeout: 60_000 });
      write.catch(() => undefined);
      await this.click(this.saveButton, `${this.t('btn.save')} button`);
      const toast = this.toasts.first();
      const winner = await Promise.race([
        write.then(() => 'response' as const),
        toast.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'toast' as const),
      ]);
      if (winner === 'toast') {
        attempt.toast = await this.toastMessage(toast);
        const success = [this.t('msg.registered'), this.t('msg.saved')];
        if (!success.includes(attempt.toast)) return;
      }
      await this.readResponse(await write, attempt);
    });
    return attempt;
  }

  private async readResponse(response: Response, attempt: SaveAttempt): Promise<void> {
    attempt.sent = true;
    attempt.status = response.status();
    attempt.requestBody = (response.request().postDataJSON() as Record<string, unknown> | null) ?? null;
    attempt.body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  }

  /** Sau khi lưu thành công form quay về list (재고 관리 khi mở từ list, SKU master khi mở bằng URL). */
  async waitBackOnList(): Promise<void> {
    await this.page.waitForURL(/\/commerce\/product-stock\/(stock|sku-master\/physical)(\?|$)/, { timeout: 30_000 });
  }

  /** Mở form sửa bằng link 상품코드 trên dòng `skuCode` của 재고 관리 (tìm theo 상품코드). */
  async openEditFromList(list: StockListPage, groupCode: string, skuCode: string): Promise<void> {
    await test.step(`Open the edit screen of ${groupCode} from the stock list`, async () => {
      await list.open();
      await list.search('SKU_GROUP_CODE', groupCode);
      await list.click(list.cell(list.row(skuCode), 'col.skuGroupCode').getByRole('link', { name: groupCode, exact: true }), `product code ${groupCode}`);
      this.kind = 'physical';
      this.lang = 'ko';
      await expect(this.cardTitle, 'The SKU form must load').toBeVisible({ timeout: 30_000 });
      await expect(this.skuGroupCodeInput, 'The SKU form must finish loading the saved values').not.toHaveValue('', { timeout: 30_000 });
    });
  }

  /** Bấm 엑셀 다운로드 trên 재고 관리 (đang lọc) và đọc file tải về. */
  async downloadStockExport(list: StockListPage): Promise<string[][]> {
    let rows: string[][] = [];
    await test.step(`Click ${list.t('btn.exportStockExcel')} and read the downloaded file`, async () => {
      const download = this.page.waitForEvent('download', { timeout: 60_000 });
      await list.click(list.exportButton, `${list.t('btn.exportStockExcel')} button`);
      const file = await (await download).createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of file) chunks.push(Buffer.from(chunk));
      rows = readXlsxRows(Buffer.concat(chunks));
    });
    return rows;
  }

  /** Nút "목록으로" / "취소" của hộp xác nhận rời form. */
  get leaveConfirmButton(): Locator {
    return this.leaveConfirm.getByRole('button', { name: iconButtonName(this.t('skuForm.btn.backToList')) });
  }

  get leaveCancelButton(): Locator {
    return this.leaveConfirm.getByRole('button', { name: iconButtonName(this.t('btn.cancel')) });
  }

  /** Option đang chọn của 제조사. */
  get selectedManufacturer(): Locator {
    return this.manufacturerSelect.locator('option:checked');
  }

  /** Thanh thông báo riêng (alert / toast) ở bất kỳ đâu trên màn chứa `text`. */
  messageBars(text: string): Locator {
    return this.page.locator('.alert, [role="alert"], .toast').filter({ hasText: text });
  }

  /** Chọn biz partner theo id và đợi danh sách 제조사 của partner đó tải xong (GET /manufacturers?bizPartnerId=). */
  async choosePartnerAndWaitManufacturers(id: number): Promise<void> {
    await test.step(`Choose biz partner id ${id} and wait for its manufacturer list`, async () => {
      const loaded = this.page.waitForResponse((res) => new URL(res.url()).pathname === '/api/v1/manufacturers' && res.url().includes(`bizPartnerId=${id}`), { timeout: 30_000 });
      await this.choosePartnerId(id);
      await loaded;
    });
  }

  /** Text các option 제조사 trừ placeholder (option value rỗng). */
  async manufacturerOptionTexts(): Promise<string[]> {
    return (await this.manufacturerSelect.locator('option:not([value=""])').allTextContents()).map((text) => text.trim());
  }

  /** Text đúng câu trên toàn màn (đếm số nơi câu xuất hiện). */
  exactText(text: string): Locator {
    return this.page.getByText(new RegExp(`^\\s*${escapeRegex(text)}\\s*$`));
  }
}

/** Cột của 1 bảng MySQL khớp `pattern` (tên cột lấy lúc chạy — schema dev không công bố). */
export async function dbColumn(table: string, pattern: RegExp): Promise<string | null> {
  const columns = (await stockDb.query<RowDataPacket>(`SHOW COLUMNS FROM ${table}`)).map((column) => String(column.Field));
  return columns.find((name) => pattern.test(name)) ?? null;
}

/** Ô trong file export theo tên cột (khớp regex) của dòng có SKU 코드 = `skuCode`; null khi không có cột / dòng. */
export function exportCell(rows: string[][], skuCode: string, column: RegExp): { header: string | null; value: string | null } {
  const header = rows[0] ?? [];
  const columnIndex = header.findIndex((name) => column.test(name));
  const skuCodeIndex = header.findIndex((name) => /SKU\s*코드|SKU\s*code/i.test(name));
  const row = rows.slice(1).find((cells) => (skuCodeIndex >= 0 ? cells[skuCodeIndex] === skuCode : cells.includes(skuCode)));
  return { header: columnIndex >= 0 ? header[columnIndex] : null, value: columnIndex >= 0 && row ? row[columnIndex] ?? '' : null };
}

/**
 * Biz partner thật trên dev KHÔNG có 제조사 nào (TC cần danh sách 제조사 do test tự dựng, hoặc nguồn 제조사 rỗng).
 * `exclude` = partner đã dùng trong test.
 */
export async function findPartnersWithoutManufacturer(api: StockApi, count: number, exclude: number[] = []): Promise<WorldPartner[]> {
  const found: WorldPartner[] = [];
  for (const partner of await api.bizPartners()) {
    if (exclude.includes(partner.id)) continue;
    if ((await api.manufacturers(partner.id)).length > 0) continue;
    found.push({ id: partner.id, nameKo: partner.companyNames?.ko || String(partner.id), nameEn: partner.companyNames?.en || partner.companyNames?.ko || String(partner.id) });
    if (found.length >= count) break;
  }
  if (found.length < count) throw new Error(`Test data setup failed — dev has fewer than ${count} biz partner(s) without a manufacturer`);
  return found;
}

/** id nhóm SKU theo 상품코드 (null khi chưa có SKU nào mang mã này). */
export async function groupIdOf(api: StockApi, groupCode: string): Promise<number | null> {
  const { body } = await api.skus({ searchType: 'SKU_GROUP_CODE', keyword: groupCode });
  return body.items.find((item) => item.skuGroupCode === groupCode)?.skuGroupId ?? null;
}
