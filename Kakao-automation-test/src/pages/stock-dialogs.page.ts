import { Page, Locator, expect, test } from '@playwright/test';
import { BasePage } from './base.page';
import { escapeRegex, iconButtonName } from './stock-list.page';
import { stx, StockLang, StockTextKey } from '@utils/stock.i18n';

/**
 * Khung dialog chung của màn 재고 관리 (`qF` trong bundle): `.modal[role=dialog]` có tiêu đề `.modal-title`, nút
 * 취소 / 저장 ở footer, lỗi hiện ở `.modal-body .alert-danger`. Đóng khi đã nhập liệu → hộp xác nhận thứ 2
 * (확인 · "작성된 항목을 등록하지 않고, 입력창을 닫을까요?" · nút 닫기 / 취소). Verify 05/10/2026.
 */
export class StockDialog extends BasePage {
  lang: StockLang = 'ko';

  constructor(page: Page, private readonly titleKey: StockTextKey) {
    super(page);
  }

  t(key: StockTextKey, values?: Record<string, string | number>): string {
    return stx(key, this.lang, values);
  }

  get root(): Locator {
    return this.page.locator('.modal.show[role="dialog"]').filter({ has: this.page.locator('.modal-title', { hasText: new RegExp(`^${escapeRegex(this.t(this.titleKey))}$`) }) });
  }

  get title(): Locator { return this.root.locator('.modal-title'); }
  get header(): Locator { return this.root.locator('.modal-header'); }
  get body(): Locator { return this.root.locator('.modal-body'); }
  get footer(): Locator { return this.root.locator('.modal-footer'); }
  get closeX(): Locator { return this.header.locator('.btn-close'); }
  get cancelButton(): Locator { return this.footer.getByRole('button', { name: iconButtonName(this.t('btn.cancel')) }); }
  get saveButton(): Locator { return this.footer.getByRole('button', { name: iconButtonName(this.t('btn.save')) }); }
  get footerButtons(): Locator { return this.footer.getByRole('button'); }
  get errorAlert(): Locator { return this.body.locator('.alert-danger'); }
  get table(): Locator { return this.body.locator('table').first(); }
  get headerCells(): Locator { return this.table.locator('thead th'); }
  get rows(): Locator { return this.table.locator('tbody tr'); }

  /** Hộp xác nhận "đóng mà không lưu" (modal thứ 2, tiêu đề 확인). */
  get confirmClose(): Locator {
    return this.page.locator('.modal.show[role="dialog"]').filter({ hasText: this.t('msg.closeWithoutSaving') });
  }

  async waitOpen(lang: StockLang = this.lang): Promise<void> {
    this.lang = lang;
    await expect(this.root, `The ${this.t(this.titleKey)} dialog must open`).toBeVisible();
  }

  async headerTexts(): Promise<string[]> {
    return (await this.headerCells.allInnerTexts()).map((text) => text.trim());
  }

  /** Text các ô của dòng `index` (ô có ô nhập → giá trị ô nhập). */
  async rowValues(index = 0): Promise<string[]> {
    const cells = this.rows.nth(index).locator('td');
    const values: string[] = [];
    for (const cell of await cells.all()) {
      const input = cell.locator('input:not([type="radio"]):not([type="checkbox"]), select').first();
      values.push((await input.count()) > 0 ? await input.inputValue() : (await cell.innerText()).trim());
    }
    return values;
  }

  /** Ô nhập thứ `n` (0-based, chỉ tính textbox) của dòng `index`. */
  rowInput(index: number, n: number): Locator {
    return this.rows.nth(index).locator('input.form-control').nth(n);
  }

  async clickSave(): Promise<void> {
    await this.click(this.saveButton, `${this.t('btn.save')} button of the ${this.t(this.titleKey)} dialog`);
  }

  async clickCancel(): Promise<void> {
    await this.click(this.cancelButton, `${this.t('btn.cancel')} button of the ${this.t(this.titleKey)} dialog`);
  }

  /** Bấm 저장 và đợi request ghi (`urlPart`) trả về — trả về status HTTP. */
  async saveAndWait(urlPart: string): Promise<number> {
    const response = this.page.waitForResponse((res) => res.url().includes(urlPart) && res.request().method() !== 'GET', { timeout: 60_000 });
    await this.clickSave();
    return (await response).status();
  }

  /** Xác nhận đóng không lưu (nút 닫기 trong hộp xác nhận). */
  async confirmDiscard(): Promise<void> {
    await this.click(this.confirmClose.getByRole('button', { name: this.t('btn.close') }), `${this.t('btn.close')} button of the confirm box`);
  }

  async expectClosed(): Promise<void> {
    await expect(this.root, `The ${this.t(this.titleKey)} dialog must close`).toHaveCount(0);
  }
}

/** Dialog 입고 요청 — bảng SKU 정보 (6 cột) + khối 입고 정보 (입고지 / 입고 예정일 / 입고구분 / 제조사). */
export class IncomingDialog extends StockDialog {
  constructor(page: Page) {
    super(page, 'incoming.title');
  }

  get requestDateText(): Locator { return this.header.locator('span.text-muted'); }
  get skuSectionTitle(): Locator { return this.body.getByText(this.t('incoming.skuSection'), { exact: true }); }
  get infoSectionTitle(): Locator { return this.body.getByText(this.t('incoming.infoSection'), { exact: true }); }
  fieldLabel(key: StockTextKey): Locator {
    return this.body.locator('label.form-label', { hasText: new RegExp(`^${escapeRegex(this.t(key))}\\*?$`) });
  }
  get warehouseSelect(): Locator { return this.body.locator('.row select.form-select').first(); }
  get expectedDateInput(): Locator { return this.body.getByPlaceholder('YYYY-MM-DD'); }
  typeRadio(type: 'PURCHASE_ORDER' | 'TRANSFER' | 'ETC'): Locator { return this.body.locator(`#incoming-type-${type}`); }
  get typeRadios(): Locator { return this.body.locator('input[name="incoming-type"]'); }
  get typeLabels(): Locator { return this.body.locator('input[name="incoming-type"] + label'); }
  get manufacturerText(): Locator { return this.fieldLabel('incoming.field.manufacturer').locator('xpath=following-sibling::*[1]'); }
  get etcNote(): Locator { return this.body.getByPlaceholder(this.t('incoming.field.etcNotePlaceholder')); }
  get etcNotice(): Locator { return this.body.getByText(this.t('incoming.etcNotExpected'), { exact: true }); }
  supplyPriceInput(index = 0): Locator { return this.rowInput(index, 0); }
  quantityInput(index = 0): Locator { return this.rowInput(index, 1); }
  memoInput(index = 0): Locator { return this.rowInput(index, 2); }

  async chooseWarehouse(name: string): Promise<void> {
    await test.step(`Choose inbound destination ${name}`, async () => {
      await this.warehouseSelect.selectOption({ label: name });
    });
  }

  /** Nhập ngày YYYY-MM-DD vào date picker rồi đóng lịch. */
  async typeExpectedDate(date: string): Promise<void> {
    await test.step(`Enter expected inbound date ${date}`, async () => {
      await this.expectedDateInput.fill(date);
      await this.expectedDateInput.press('Enter');
      await this.title.click();
    });
  }

  async fillLine(index: number, values: { supplyPrice?: string; quantity?: string; memo?: string }): Promise<void> {
    await test.step(`Fill SKU line ${index + 1}`, async () => {
      if (values.supplyPrice !== undefined) await this.supplyPriceInput(index).fill(values.supplyPrice);
      if (values.quantity !== undefined) await this.quantityInput(index).fill(values.quantity);
      if (values.memo !== undefined) await this.memoInput(index).fill(values.memo);
    });
  }

  async warehouseOptions(): Promise<string[]> {
    return (await this.warehouseSelect.locator('option').allInnerTexts()).map((text) => text.trim());
  }
}

/** Dialog 재고 조정 — 8 cột: SKU 코드 · SKU명 · 창고 · 전체 재고 · 조정 수량 · 증가/차감 · 조정사유 · 비고. */
export class AdjustmentDialog extends StockDialog {
  constructor(page: Page) {
    super(page, 'adjust.title');
  }

  quantityInput(index = 0): Locator { return this.rowInput(index, 0); }
  noteInput(index = 0): Locator { return this.rowInput(index, 1); }
  reasonSelect(index = 0): Locator { return this.rows.nth(index).locator('select'); }
  modifyRadio(index: number, type: 'ADD' | 'SUBTRACT'): Locator { return this.rows.nth(index).locator(`input[type="radio"][id$="-${type}"]`); }

  async fillLine(index: number, values: { quantity?: string; modifyType?: 'ADD' | 'SUBTRACT'; reason?: string; note?: string }): Promise<void> {
    await test.step(`Fill adjustment line ${index + 1}`, async () => {
      if (values.quantity !== undefined) await this.quantityInput(index).fill(values.quantity);
      if (values.modifyType) await this.modifyRadio(index, values.modifyType).check();
      if (values.reason !== undefined) await this.reasonSelect(index).selectOption(values.reason);
      if (values.note !== undefined) await this.noteInput(index).fill(values.note);
    });
  }
}

/** Dialog 재고 전환 — select 전환 구분 + thông báo cố định + bảng 8 cột. */
export class ConversionDialog extends StockDialog {
  constructor(page: Page) {
    super(page, 'convert.title');
  }

  get policySelect(): Locator { return this.body.locator('select').first(); }
  get policyLabel(): Locator { return this.body.getByText(this.t('convert.policyLabel'), { exact: true }); }
  get notice(): Locator { return this.body.getByText(this.t('convert.notice'), { exact: true }); }
  get crossWarehouseNotice(): Locator { return this.body.getByText(this.t('convert.crossWarehouseNotice'), { exact: true }); }
  quantityInput(index = 0): Locator { return this.rowInput(index, 0); }
  memoInput(index = 0): Locator { return this.rowInput(index, 1); }

  async choosePolicy(policy: string): Promise<void> {
    await test.step(`Choose conversion type ${policy || '(none)'}`, async () => {
      await this.policySelect.selectOption(policy);
    });
  }

  async fillLine(index: number, values: { quantity?: string; memo?: string }): Promise<void> {
    await test.step(`Fill conversion line ${index + 1}`, async () => {
      if (values.quantity !== undefined) await this.quantityInput(index).fill(values.quantity);
      if (values.memo !== undefined) await this.memoInput(index).fill(values.memo);
    });
  }
}

/** Dialog 창고별 상세 — thông báo + bảng 5 cột, cột cuối là select 관리함 / 관리안함. */
export class WarehouseDetailDialog extends StockDialog {
  constructor(page: Page) {
    super(page, 'whdetail.title');
  }

  get notice(): Locator { return this.body.getByText(this.t('whdetail.notice'), { exact: true }); }
  /** Radio 관리함 / 관리안함 của dòng `index` (bundle `r8t`: `#cs-<row>-MANAGED` / `#cs-<row>-UNMANAGED`). */
  managedRadio(index: number, managed: boolean): Locator {
    return this.rows.nth(index).locator(`#cs-${index}-${managed ? 'MANAGED' : 'UNMANAGED'}`);
  }

  async setManaged(index: number, managed: boolean): Promise<void> {
    await test.step(`Set CS stock managed of line ${index + 1} to ${managed ? 'Managed' : 'Not managed'}`, async () => {
      await this.managedRadio(index, managed).check();
    });
  }
}

/** Dialog 재고이력 — dòng ngữ cảnh "SKU명 : … / SKU코드 : … / 창고 : …", nút 엑셀 다운로드, bảng 10 cột, pager riêng, nút 닫기. */
export class StockHistoryDialog extends StockDialog {
  constructor(page: Page) {
    super(page, 'history.title');
  }

  get contextLine(): Locator { return this.body.getByText(new RegExp(`^${escapeRegex(this.t('history.skuName'))}\\s*:`)); }
  get exportButton(): Locator { return this.root.getByRole('button', { name: iconButtonName(this.t('btn.exportStockExcel')) }); }
  /** Nút 닫기 ở footer — trong EN nút X ở header cũng có aria-label "Close", nên phải giới hạn trong footer. */
  get closeButton(): Locator { return this.footer.getByRole('button', { name: iconButtonName(this.t('btn.close')) }); }
  get pagerText(): Locator { return this.root.getByText(/^(총 |Total |Showing )/); }
  get pageSizeSelect(): Locator { return this.root.locator('.modal-body select').last(); }
  get pagination(): Locator { return this.root.locator('ul.pagination'); }

  /** Bảng lịch sử tải xong (có dòng dữ liệu hoặc dòng "검색 결과가 없습니다."). */
  async waitLoaded(): Promise<void> {
    await expect(this.table, 'The stock history table must be shown').toBeVisible({ timeout: 30_000 });
    await expect(this.rows.first(), 'The stock history must finish loading').toBeVisible({ timeout: 30_000 });
  }

  async close(): Promise<void> {
    await this.click(this.closeButton, `${this.t('btn.close')} button of the stock history dialog`);
  }
}
