import { Page, Locator, expect, test } from '@playwright/test';
import { BasePage } from './base.page';
import { stx, StockLang, StockTextKey } from '@utils/stock.i18n';
import type { StockSearchField } from '@api/stock.api';

/** Tên accessible của nút có icon font (glyph trước chữ) — khớp đúng chữ, bỏ qua glyph. */
export const iconButtonName = (text: string) => new RegExp(`^[^\\p{L}\\p{N}]*${escapeRegex(text)}\\s*$`, 'u');

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Khoá cột của bảng 재고 목록 theo đúng thứ tự frontend render (22 cột, cột đầu là ô tick không nhãn). */
export const STOCK_COLUMN_KEYS = [
  'select', 'col.skuGroupCode', 'col.skuName', 'col.skuCode', 'col.barcode', 'col.totalQuantity', 'col.reservedQuantity',
  'col.availableQuantity', 'col.csQuantity', 'col.csOrderableQuantity', 'col.pendingAllocationQuantity', 'col.orderableQuantity',
  'col.incomingQuantity', 'col.insufficientQuantity', 'col.unconfirmedQuantity', 'col.skuType', 'col.warehouse',
  'col.manufacturer', 'col.skuId', 'col.bizPartner', 'col.createdAt', 'col.stockHistory',
] as const;

export type StockColumnKey = Exclude<(typeof STOCK_COLUMN_KEYS)[number], 'select'>;

/**
 * Màn (NEW)FPT › 물류 관리 › 재고 관리 (US134) — `/commerce/product-stock/stock`, ngôn ngữ đổi bằng `?lang=en`.
 * Filter: 검색조건 (select + ô từ khoá), SKU유형, 대구분 (select thường), 창고 + 비즈파트너 (react-select nhiều lựa chọn).
 * Toolbar: 정렬 + 4 nút + 2 nhãn upload (`label[role=button]` bọc `input[type=file]` ẩn). Guard chọn dòng hiện
 * `div.alert-danger[role=alert]` phía trên bảng; lưu thành công hiện toast `.toast-container .toast`. Verify 05/10/2026.
 */
export class StockListPage extends BasePage {
  lang: StockLang = 'ko';

  readonly pageHeading = this.page.getByRole('heading', { level: 4 });
  readonly card = this.page.locator('.custom-card.card').filter({ has: this.page.locator('.card-title') }).first();
  readonly cardTitle = this.card.locator('.card-title');
  readonly filterBlock = this.card.locator('.border-bottom.pb-3.mb-3').first();
  readonly filterRow = this.filterBlock.locator(':scope > div').first();
  readonly filterActionRow = this.filterBlock.locator(':scope > div').nth(1);
  readonly toolbar = this.card.locator('.d-flex.flex-wrap.align-items-end.gap-3.mb-3').first();
  readonly toolbarButtons = this.toolbar.locator('.ms-auto').first();
  readonly searchFieldSelect = this.filterBlock.locator('select').first();
  readonly keywordInput = this.filterBlock.locator('input.form-control[type="text"]').first();
  readonly skuTypeSelect = this.filterBlock.locator('select').nth(1);
  readonly warehouseGroupSelect = this.filterBlock.locator('select').nth(2);
  readonly warehouseMulti = this.filterBlock.locator('[class*="-container"]').nth(0);
  readonly bizPartnerMulti = this.filterBlock.locator('[class*="-container"]').nth(1);
  readonly warehouseInput = this.warehouseMulti.getByRole('combobox');
  readonly bizPartnerInput = this.bizPartnerMulti.getByRole('combobox');
  readonly sortSelect = this.toolbar.locator('select').first();

  readonly table = this.card.locator('table').first();
  readonly headerCells = this.table.locator('thead th');
  readonly bodyRows = this.table.locator('tbody tr');
  readonly selectAllCheckbox = this.table.locator('thead input[type="checkbox"]');
  readonly guardAlert = this.card.locator('.alert-danger[role="alert"]');
  readonly toasts = this.page.locator('.toast-container .toast');
  readonly pagerText = this.card.getByText(/^(총 \d[\d,]*개의 .+ 중 \d[\d,]*-\d[\d,]*개 표시|Showing .+|Total .+)/);
  readonly pageSizeSelect = this.card.locator('select').last();
  readonly pagination = this.card.locator('ul.pagination');
  readonly activePage = this.pagination.locator('li.active, li[aria-current="page"]');
  readonly incomingFileInput = this.toolbar.locator('label[role="button"]').nth(0).locator('input[type="file"]');
  readonly adjustmentFileInput = this.toolbar.locator('label[role="button"]').nth(1).locator('input[type="file"]');

  constructor(page: Page) {
    super(page);
  }

  t(key: StockTextKey, values?: Record<string, string | number>): string {
    return stx(key, this.lang, values);
  }

  /** Nút / nhãn-nút trên màn theo text (bỏ glyph icon). */
  button(key: StockTextKey): Locator {
    return this.card.getByRole('button', { name: iconButtonName(this.t(key)) }).first();
  }

  get resetButton(): Locator { return this.button('btn.reset'); }
  get searchButton(): Locator { return this.button('btn.search'); }
  get exportButton(): Locator { return this.button('btn.exportStockExcel'); }
  get incomingButton(): Locator { return this.button('btn.incomingRequest'); }
  get uploadIncomingButton(): Locator { return this.toolbar.locator('label[role="button"]').nth(0); }
  get adjustButton(): Locator { return this.button('btn.adjustStock'); }
  get uploadAdjustmentButton(): Locator { return this.toolbar.locator('label[role="button"]').nth(1); }
  get convertButton(): Locator { return this.button('btn.convertStock'); }
  get warehouseDetailButton(): Locator { return this.button('btn.warehouseDetail'); }

  /** Nhãn filter theo text (label.form-label trong khối filter / toolbar). */
  filterLabel(key: StockTextKey): Locator {
    return this.card.locator('label.form-label', { hasText: new RegExp(`^${escapeRegex(this.t(key))}$`) });
  }

  /** Link sidebar theo tên hiển thị (tên menu mang glyph icon phía sau — bỏ qua glyph). */
  sidebarLink(name: string): Locator {
    return this.page.locator('aside').getByRole('link', { name: new RegExp(`^[^\\p{L}\\p{N}(]*${escapeRegex(name)}[^\\p{L}\\p{N}]*$`, 'u') }).first();
  }

  /** Tên các mục con trực tiếp của nhóm sidebar `groupName` (nhóm phải đang mở). */
  async sidebarChildren(groupName: string): Promise<string[]> {
    const items = this.sidebarLink(groupName).locator('xpath=ancestor::li[1]/ul/li/a');
    return (await items.allInnerTexts()).map((text) => text.replace(/[^\p{L}\p{N}()/ \-]/gu, '').trim());
  }

  /** Mở màn qua sidebar (NEW)FPT › 물류 관리 › 재고 관리 — link sidebar điều hướng bằng JS, không có href riêng. */
  async openFromSidebar(): Promise<void> {
    await this.goto('/commerce/product-stock/stock');
    await this.waitForList();
    for (const name of ['(NEW)FPT', '물류 관리']) {
      const children = this.sidebarLink(name).locator('xpath=ancestor::li[1]/ul');
      if (!(await children.isVisible())) await this.click(this.sidebarLink(name), `${name} group in the sidebar`);
    }
  }

  /** Mở màn — `lang` = 'en' thêm `?lang=en`; đợi bảng tải xong. */
  async open(lang: StockLang = 'ko'): Promise<void> {
    this.lang = lang;
    await this.goto(`/commerce/product-stock/stock${lang === 'en' ? '?lang=en' : ''}`);
    await this.waitForList();
  }

  /** Bảng đã có dòng dữ liệu hoặc dòng "không có kết quả". */
  async waitForList(): Promise<void> {
    await expect(this.table, 'The stock list table must be shown').toBeVisible({ timeout: 30_000 });
    await expect(this.bodyRows.first(), 'The stock list must finish loading').toBeVisible({ timeout: 30_000 });
  }

  /**
   * Chạy hành động rồi đợi đúng 1 lượt gọi GET /stock-status hoàn tất (list tải lại).
   * `optional` — frontend KHÔNG gọi lại khi tiêu chí đã áp dụng không đổi (verify 05/10: 검색 lần 2 cùng keyword không có
   * request) → chỉ chờ request tối đa 5 s, không có thì coi list đang đúng tiêu chí.
   */
  async waitForListReload(action: () => Promise<void>, optional = false): Promise<boolean> {
    let reloaded = false;
    const response = this.page
      .waitForResponse((res) => res.url().includes('/api/v1/stock-status?') && res.request().method() === 'GET', { timeout: optional ? 5_000 : 30_000 })
      .then(() => {
        reloaded = true;
      })
      .catch((error: Error) => {
        if (!optional) throw error;
      });
    await action();
    await response;
    await this.waitForList();
    return reloaded;
  }

  async chooseSearchField(field: StockSearchField): Promise<void> {
    await test.step(`Choose search condition ${field}`, async () => {
      await this.searchFieldSelect.selectOption(field);
    });
  }

  async typeKeyword(keyword: string): Promise<void> {
    await this.type(this.keywordInput, keyword, 'keyword box');
  }

  /** Bấm 검색 — trả về `true` nếu list thực sự gọi lại API (tiêu chí không đổi → frontend không gọi lại). */
  async clickSearch(): Promise<boolean> {
    return this.waitForListReload(() => this.click(this.searchButton, `${this.t('btn.search')} button`), true);
  }

  async clickReset(): Promise<void> {
    await this.waitForListReload(() => this.click(this.resetButton, `${this.t('btn.reset')} button`));
  }

  /**
   * Điền 검색조건 + từ khoá rồi bấm 검색 — luôn trả về dữ liệu MỚI: nếu tiêu chí trùng tiêu chí đang áp dụng (frontend không
   * gọi lại API, bảng giữ số cũ sau khi test đổi dữ liệu qua DB/API) thì tải lại trang rồi tìm lại.
   */
  async search(field: StockSearchField, keyword: string): Promise<void> {
    await test.step(`Search ${field} = "${keyword}"`, async () => {
      await this.chooseSearchField(field);
      await this.typeKeyword(keyword);
      if (await this.clickSearch()) return;
      await this.page.reload();
      await this.waitForList();
      await this.chooseSearchField(field);
      await this.typeKeyword(keyword);
      await this.clickSearch();
    });
  }

  async chooseSkuType(value: '' | 'PHYSICAL' | 'DIGITAL' | 'MIXED'): Promise<void> {
    await test.step(`Choose SKU type ${value || 'All'}`, async () => {
      await this.skuTypeSelect.selectOption(value);
    });
  }

  async chooseWarehouseGroup(value: string): Promise<void> {
    await test.step(`Choose warehouse group ${value || 'All'}`, async () => {
      await this.warehouseGroupSelect.selectOption(value);
    });
  }

  /** Chọn 1 lựa chọn trong react-select nhiều lựa chọn (gõ để lọc rồi chọn đúng tên). */
  async pickMulti(control: 'warehouse' | 'bizPartner', optionName: string): Promise<void> {
    await test.step(`Pick ${control} "${optionName}"`, async () => {
      const input = control === 'warehouse' ? this.warehouseInput : this.bizPartnerInput;
      await input.click();
      await input.fill(optionName);
      const option = this.page.locator('[id^="react-select-"][id*="-option-"]').filter({ hasText: new RegExp(`^${escapeRegex(optionName)}$`) }).first();
      await expect(option, `Option "${optionName}" must be offered`).toBeVisible();
      await option.click();
      await this.page.keyboard.press('Escape');
    });
  }

  /** Mở menu react-select và đọc mọi lựa chọn đang được đề nghị. */
  async multiOptions(control: 'warehouse' | 'bizPartner'): Promise<string[]> {
    const input = control === 'warehouse' ? this.warehouseInput : this.bizPartnerInput;
    await input.click();
    const options = this.page.locator('[id^="react-select-"][id*="-option-"]');
    const menu = this.page.locator('[class*="-menu"]').filter({ has: this.page.locator('[class*="MenuList"], [role="listbox"], [id*="-option-"]') });
    await expect(menu.first().or(this.page.getByText(this.t('filter.noWarehouses'))).first(), `The ${control} menu must open`).toBeVisible();
    const names = await options.allInnerTexts();
    await this.page.keyboard.press('Escape');
    return names.map((name) => name.trim());
  }

  /** Text của mỗi chip đã chọn trong react-select (bao gồm chip "+N"). */
  multiValues(control: 'warehouse' | 'bizPartner'): Locator {
    const container = control === 'warehouse' ? this.warehouseMulti : this.bizPartnerMulti;
    return container.locator('[class*="multiValue"], .badge');
  }

  async chooseSort(value: 'CREATED_AT' | 'UNCONFIRMED_OUTGOING_QUANTITY'): Promise<void> {
    await this.waitForListReload(async () => {
      await this.sortSelect.selectOption(value);
    });
  }

  async choosePageSize(size: 10 | 20 | 50 | 100): Promise<void> {
    await this.waitForListReload(async () => {
      await this.pageSizeSelect.selectOption(String(size));
    });
  }

  async goToPage(name: string): Promise<void> {
    await this.waitForListReload(() => this.click(this.pagination.getByRole('button', { name, exact: true }), `pagination button ${name}`));
  }

  /** Dòng bảng theo SKU코드 (aria-label của ô tick) và tuỳ chọn tên kho. */
  row(skuCode: string, warehouseName?: string): Locator {
    let rows = this.bodyRows.filter({ has: this.page.locator(`input[type="checkbox"][aria-label="${skuCode}"]`) });
    if (warehouseName) rows = rows.filter({ has: this.page.locator('td', { hasText: new RegExp(`^${escapeRegex(warehouseName)}$`) }) });
    return rows.first();
  }

  /** Dòng bảng theo SKU ID (SKU không có ô tick — digital/set — vẫn tìm được). */
  rowBySkuId(skuId: number | string, warehouseName?: string): Locator {
    let rows = this.bodyRows.filter({ has: this.page.locator('td', { hasText: new RegExp(`^${skuId}$`) }) });
    if (warehouseName) rows = rows.filter({ has: this.page.locator('td', { hasText: new RegExp(`^${escapeRegex(warehouseName)}$`) }) });
    return rows.first();
  }

  checkbox(row: Locator): Locator {
    return row.locator('input[type="checkbox"]');
  }

  async tick(row: Locator, description: string): Promise<void> {
    await test.step(`Tick the row ${description}`, async () => {
      await this.checkbox(row).check();
    });
  }

  /** Ô của dòng theo khoá cột (vị trí cột cố định theo STOCK_COLUMN_KEYS). */
  cell(row: Locator, column: StockColumnKey): Locator {
    return row.locator('td').nth(STOCK_COLUMN_KEYS.indexOf(column));
  }

  async cellText(row: Locator, column: StockColumnKey): Promise<string> {
    return (await this.cell(row, column).innerText()).trim();
  }

  /** Mọi ô của 1 dòng theo thứ tự cột. */
  async rowTexts(row: Locator): Promise<string[]> {
    return (await row.locator('td').allInnerTexts()).map((text) => text.trim());
  }

  /** Text các tiêu đề cột (ô tick → chuỗi rỗng). */
  async headerTexts(): Promise<string[]> {
    return (await this.headerCells.allInnerTexts()).map((text) => text.trim());
  }

  /** Tooltip (thuộc tính title) của tiêu đề cột. */
  headerTooltip(column: StockColumnKey): Locator {
    return this.headerCells.nth(STOCK_COLUMN_KEYS.indexOf(column)).locator('span[title]');
  }

  /** Giá trị cột `column` của mọi dòng đang hiển thị. */
  async columnValues(column: StockColumnKey): Promise<string[]> {
    const index = STOCK_COLUMN_KEYS.indexOf(column);
    const values: string[] = [];
    for (const row of await this.bodyRows.all()) {
      const cells = row.locator('td');
      if ((await cells.count()) > index) values.push((await cells.nth(index).innerText()).trim());
    }
    return values;
  }

  /** Số dòng dữ liệu trên trang (không tính dòng "검색 결과가 없습니다."). */
  async dataRowCount(): Promise<number> {
    const rows = await this.bodyRows.all();
    let count = 0;
    for (const row of rows) if ((await row.locator('td').count()) > 1) count += 1;
    return count;
  }

  noResultsRow(): Locator {
    return this.bodyRows.filter({ hasText: this.t('empty.noResults') });
  }

  /** Bấm nút mở dialog (입고 요청 / 재고 조정 / 재고 전환 / 창고별 상세). */
  async clickToolbar(key: 'btn.incomingRequest' | 'btn.adjustStock' | 'btn.convertStock' | 'btn.warehouseDetail'): Promise<void> {
    await this.click(this.button(key), `${this.t(key)} button`);
  }

  /** Bấm 재고이력 của dòng. */
  async openHistory(row: Locator): Promise<void> {
    await this.click(row.getByRole('button', { name: iconButtonName(this.t('btn.stockHistory')) }), `${this.t('btn.stockHistory')} button of the row`);
  }

  lastToast(): Locator {
    return this.toasts.last();
  }

  /** Bấm nhãn upload và chọn file qua hộp chọn file của OS (filechooser). */
  async uploadVia(kind: 'incoming' | 'adjustment', file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
    await test.step(`Upload ${file.name} through the ${kind} upload button`, async () => {
      const chooser = this.page.waitForEvent('filechooser');
      await (kind === 'incoming' ? this.uploadIncomingButton : this.uploadAdjustmentButton).click();
      await (await chooser).setFiles(file);
    });
  }
}
