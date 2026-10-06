import { Page, Locator, expect, test } from '@playwright/test';
import { BasePage } from './base.page';
import { escapeRegex, iconButtonName } from './stock-list.page';
import { stx, StockLang, StockTextKey } from '@utils/stock.i18n';

export type SkuFormKind = 'physical' | 'digital' | 'set';

/**
 * Form SKU (US134) — `/commerce/product-stock/stock/{physical|digital|set}/{create|edit}` (`edit?skuGroupId=`).
 * Mọi trường dạng `div.col-md-* > label.form-label + control`; lỗi trường ở `.invalid-feedback`, lỗi trang ở `.alert-danger`.
 * 현물: thêm SKU 종류 (radio usage-*), 공급원가, 옵션 설정 (radio option-none / option-has), bảng dòng SKU, 중량, 부피, HS 코드,
 * 상품 간단 설명, 제조사 (select), 원산지 (react-select). Set: bảng SET 설정 + nút 추가 mở dialog SKU 검색. Verify 05/10/2026.
 */
export class SkuFormPage extends BasePage {
  lang: StockLang = 'ko';
  kind: SkuFormKind = 'physical';

  readonly card = this.page.locator('.custom-card.card').first();
  readonly cardTitle = this.card.locator('.card-title');
  readonly modeBadge = this.card.locator('.card-header .badge');
  /** Alert lỗi server nằm phía trên card form (ngoài card) — tìm trong toàn vùng nội dung. */
  readonly pageError = this.page.locator('.main-content .alert-danger');
  readonly toasts = this.page.locator('.toast-container .toast');
  readonly linesTable = this.card.locator('table').first();
  readonly lineRows = this.linesTable.locator('tbody tr');
  readonly lineHeaders = this.linesTable.locator('thead th');

  constructor(page: Page) {
    super(page);
  }

  t(key: StockTextKey, values?: Record<string, string | number>): string {
    return stx(key, this.lang, values);
  }

  async openCreate(kind: SkuFormKind, lang: StockLang = 'ko'): Promise<void> {
    this.kind = kind;
    this.lang = lang;
    await this.goto(`/commerce/product-stock/stock/${kind}/create${lang === 'en' ? '?lang=en' : ''}`);
    await expect(this.cardTitle, 'The SKU form must load').toBeVisible({ timeout: 30_000 });
  }

  async openEdit(kind: SkuFormKind, skuGroupId: number | string, lang: StockLang = 'ko'): Promise<void> {
    this.kind = kind;
    this.lang = lang;
    await this.goto(`/commerce/product-stock/stock/${kind}/edit?skuGroupId=${skuGroupId}${lang === 'en' ? '&lang=en' : ''}`);
    await expect(this.cardTitle, 'The SKU form must load').toBeVisible({ timeout: 30_000 });
    await expect(this.skuGroupCodeInput, 'The SKU form must finish loading the saved values').not.toHaveValue('', { timeout: 30_000 });
  }

  /** Khung trường theo nhãn (label.form-label, bỏ dấu `*`). */
  field(key: StockTextKey): Locator {
    return this.card.locator('div[class*="col-md-"]').filter({ has: this.page.locator(':scope > label.form-label', { hasText: new RegExp(`^${escapeRegex(this.t(key))}\\*?$`) }) }).first();
  }

  label(key: StockTextKey): Locator {
    return this.field(key).locator(':scope > label.form-label');
  }

  fieldError(key: StockTextKey): Locator {
    return this.field(key).locator('.invalid-feedback');
  }

  get skuTypeSelect(): Locator { return this.field('skuForm.field.skuType').locator('select'); }
  get bizPartnerSelect(): Locator { return this.field('skuForm.field.bizPartner').locator('select'); }
  get bizPartnerLockNote(): Locator { return this.field('skuForm.field.bizPartner').getByText(this.t('skuForm.lockNotice'), { exact: true }); }
  get skuGroupCodeInput(): Locator { return this.field('skuForm.field.skuGroupCode').locator('input'); }
  get checkCodeButton(): Locator { return this.field('skuForm.field.skuGroupCode').getByRole('button', { name: iconButtonName(this.t('skuForm.btn.checkCode')) }); }
  get skuGroupCodeNameInput(): Locator { return this.field('skuForm.field.skuGroupCodeName').locator('input'); }
  usageRadio(type: 'MAIN' | 'PARTS' | 'GIVEAWAY'): Locator { return this.card.locator(`#usage-${type}`); }
  get priceInput(): Locator { return this.field('skuForm.field.price').locator('input'); }
  get optionNone(): Locator { return this.card.locator('#option-none'); }
  get optionHas(): Locator { return this.card.locator('#option-has'); }
  get checkBarcodeButton(): Locator { return this.card.getByRole('button', { name: iconButtonName(this.t('skuForm.btn.checkBarcode')) }); }
  get useOtherBarcodeButton(): Locator { return this.card.getByRole('button', { name: iconButtonName(this.t('skuForm.btn.useOtherBarcode')) }); }
  get addButton(): Locator { return this.card.getByRole('button', { name: iconButtonName(this.t('skuForm.btn.add')) }).last(); }
  get weightInput(): Locator { return this.field('skuForm.field.weight').locator('input'); }
  get widthInput(): Locator { return this.card.getByPlaceholder(this.t('skuForm.ph.width'), { exact: true }); }
  get depthInput(): Locator { return this.card.getByPlaceholder(this.t('skuForm.ph.depth'), { exact: true }); }
  get heightInput(): Locator { return this.card.getByPlaceholder(this.t('skuForm.ph.height'), { exact: true }); }
  get hsCodeInput(): Locator { return this.field('skuForm.field.hsCode').locator('input'); }
  get descriptionInput(): Locator { return this.field('skuForm.field.description').locator('input'); }
  get manufacturerSelect(): Locator { return this.field('skuForm.field.manufacturer').locator('select'); }
  get countryInput(): Locator { return this.field('skuForm.field.countryOfOrigin').getByRole('combobox'); }
  get backButton(): Locator { return this.card.getByRole('button', { name: iconButtonName(this.t('skuForm.btn.backToList')) }); }
  get saveButton(): Locator { return this.card.getByRole('button', { name: iconButtonName(this.t('btn.save')) }); }

  /** Ô nhập của dòng SKU `index` theo khoá cột (SKU 코드 / SKU명 / 수출용 SKU명 / 바코드 / 구성 개수). */
  lineInput(index: number, column: 'skuCode' | 'skuName' | 'exportSkuName' | 'barcode' | 'quantity'): Locator {
    const placeholder: Record<string, StockTextKey> = { skuCode: 'skuForm.ph.skuCode', skuName: 'skuForm.ph.skuName', exportSkuName: 'skuForm.ph.exportSkuName', barcode: 'skuForm.ph.barcode' };
    const row = this.lineRows.nth(index);
    return column === 'quantity' ? row.locator('input').first() : row.getByPlaceholder(this.t(placeholder[column]), { exact: true });
  }

  lineDeleteButton(index: number): Locator {
    return this.lineRows.nth(index).getByRole('button', { name: iconButtonName(this.t('skuForm.btn.delete')) });
  }

  /** Chọn 비즈파트너 — truyền số = chọn theo id (dev có nhãn trùng như "TEST", "SM엔터테인먼트"), chuỗi = theo nhãn. */
  async chooseBizPartner(partner: string | number): Promise<void> {
    await test.step(`Choose biz partner ${partner}`, async () => {
      await this.bizPartnerSelect.selectOption(typeof partner === 'number' ? String(partner) : { label: partner });
    });
  }

  async chooseManufacturer(name: string): Promise<void> {
    await test.step(`Choose manufacturer ${name}`, async () => {
      await this.manufacturerSelect.selectOption({ label: name });
    });
  }

  /** Chọn 원산지 trong react-select theo mã nước (nhãn thật dạng "🇰🇷 대한민국 (KR)"): mở menu, chọn option chứa "(KR)". */
  async chooseCountry(code: string): Promise<void> {
    await test.step(`Choose country of origin ${code}`, async () => {
      await this.countryInput.click();
      await this.page.locator('[id^="react-select-"][id*="-option-"]').filter({ hasText: `(${code})` }).first().click();
    });
  }

  async checkCode(): Promise<void> {
    const response = this.page.waitForResponse((res) => res.url().includes('/sku-groups/check-duplication'));
    await this.click(this.checkCodeButton, `${this.t('skuForm.btn.checkCode')} button`);
    await response;
  }

  async checkBarcode(): Promise<void> {
    await this.click(this.checkBarcodeButton, `${this.t('skuForm.btn.checkBarcode')} button`);
  }

  /** Điền 1 dòng SKU. */
  async fillLine(index: number, values: { skuCode?: string; skuName?: string; exportSkuName?: string; barcode?: string }): Promise<void> {
    await test.step(`Fill SKU line ${index + 1}`, async () => {
      for (const [column, value] of Object.entries(values) as Array<['skuCode' | 'skuName' | 'exportSkuName' | 'barcode', string]>) {
        if (value !== undefined) await this.lineInput(index, column).fill(value);
      }
    });
  }

  /** Điền toàn bộ form 현물 (trừ 2 bước 중복확인) với dữ liệu hợp lệ. */
  async fillPhysical(values: {
    bizPartner: string;
    groupCode: string;
    groupName: string;
    usageType?: 'MAIN' | 'PARTS' | 'GIVEAWAY';
    price?: string;
    hasOption?: boolean;
    lines: Array<{ skuCode: string; skuName?: string; exportSkuName?: string; barcode: string }>;
    weight?: string;
    volume?: [string, string, string];
    hsCode?: string;
    description?: string;
    manufacturer: string;
    country?: string;
  }): Promise<void> {
    await test.step(`Fill the physical SKU form for product code ${values.groupCode}`, async () => {
      await this.chooseBizPartner(values.bizPartner);
      await this.skuGroupCodeInput.fill(values.groupCode);
      await this.skuGroupCodeNameInput.fill(values.groupName);
      await this.usageRadio(values.usageType ?? 'MAIN').check();
      await this.priceInput.fill(values.price ?? '12000');
      if (values.hasOption) await this.optionHas.check();
      for (let index = 0; index < values.lines.length; index += 1) {
        if (index > 0) await this.addButton.click();
        await this.fillLine(index, values.lines[index]);
      }
      await this.weightInput.fill(values.weight ?? '250');
      const [width, depth, height] = values.volume ?? ['100', '80', '30'];
      await this.widthInput.fill(width);
      await this.depthInput.fill(depth);
      await this.heightInput.fill(height);
      await this.hsCodeInput.fill(values.hsCode ?? '6109100000');
      await this.descriptionInput.fill(values.description ?? 'Album');
      await this.chooseManufacturer(values.manufacturer);
      await this.chooseCountry(values.country ?? 'KR');
    });
  }

  /** Bấm 저장 và đợi POST/PATCH /skus trả về — trả về status HTTP. */
  async saveAndWait(): Promise<number> {
    const isSkuWrite = (url: string, method: string) => {
      const path = new URL(url).pathname;
      return (path === '/api/v1/skus' || path.startsWith('/api/v1/skus/')) && !path.includes('check-duplication') && ['POST', 'PATCH'].includes(method);
    };
    const response = this.page.waitForResponse((res) => isSkuWrite(res.url(), res.request().method()), { timeout: 60_000 });
    await this.click(this.saveButton, `${this.t('btn.save')} button`);
    return (await response).status();
  }

  /** Hộp xác nhận rời form (목록으로 khi có thay đổi). */
  get leaveConfirm(): Locator {
    return this.page.locator('.modal.show[role="dialog"]').filter({ hasText: this.t('skuForm.msg.leaveConfirm') });
  }
}

/** Dialog SKU 검색 của form Set — chọn SKU thành phần (chỉ SKU 현물). */
export class SkuSearchDialog extends BasePage {
  lang: StockLang = 'ko';

  constructor(page: Page) {
    super(page);
  }

  t(key: StockTextKey): string {
    return stx(key, this.lang);
  }

  get root(): Locator {
    return this.page.locator('.modal.show[role="dialog"]').filter({ has: this.page.locator('.modal-title', { hasText: this.t('skuSearch.title') }) });
  }

  get searchFieldSelect(): Locator { return this.root.locator('select').first(); }
  get keywordInput(): Locator { return this.root.locator('input[type="text"]').first(); }
  get searchButton(): Locator { return this.root.getByRole('button', { name: iconButtonName(stx('btn.search', this.lang)) }); }
  get table(): Locator { return this.root.locator('table').first(); }
  get headerCells(): Locator { return this.table.locator('thead th'); }
  get rows(): Locator { return this.table.locator('tbody tr'); }
  get cancelButton(): Locator { return this.root.getByRole('button', { name: iconButtonName(stx('btn.cancel', this.lang)) }); }
  get addButton(): Locator { return this.root.getByRole('button', { name: iconButtonName(this.t('skuSearch.btn.add')) }); }
  get pagination(): Locator { return this.root.locator('ul.pagination'); }

  async waitOpen(lang: StockLang = this.lang): Promise<void> {
    this.lang = lang;
    await expect(this.root, 'The SKU search dialog must open').toBeVisible();
  }

  /** Dòng kết quả theo SKU 코드. */
  row(skuCode: string): Locator {
    return this.rows.filter({ has: this.page.locator('td', { hasText: new RegExp(`^${escapeRegex(skuCode)}$`) }) }).first();
  }

  async search(field: 'SKU_NAME' | 'SKU_CODE', keyword: string): Promise<void> {
    await test.step(`Search SKU ${field} = "${keyword}"`, async () => {
      await this.searchFieldSelect.selectOption(field).catch(() => undefined);
      await this.keywordInput.fill(keyword);
      const response = this.page.waitForResponse((res) => res.url().includes('/api/v1/skus?'));
      await this.searchButton.click();
      await response;
    });
  }
}

/** Màn SKU master `/commerce/product-stock/sku-master/{physical|digital|set}` — không có trên menu (verify 05/10). */
export class SkuMasterListPage extends BasePage {
  lang: StockLang = 'ko';

  readonly heading = this.page.getByRole('heading', { level: 4 });
  readonly card = this.page.locator('.custom-card.card').first();
  readonly table = this.card.locator('table').first();
  readonly headerCells = this.table.locator('thead th');
  readonly bodyRows = this.table.locator('tbody tr');
  readonly searchFieldSelect = this.card.locator('select').first();
  readonly keywordInput = this.card.locator('input[type="text"]').first();
  readonly uploadButton = this.card.locator('label[role="button"]').first();
  readonly uploadInput = this.uploadButton.locator('input[type="file"]');
  readonly toasts = this.page.locator('.toast-container .toast');

  constructor(page: Page) {
    super(page);
  }

  t(key: StockTextKey): string {
    return stx(key, this.lang);
  }

  get createLink(): Locator { return this.page.getByRole('link', { name: /SKU 생성$|Create .* SKU$/ }); }
  get searchButton(): Locator { return this.card.getByRole('button', { name: iconButtonName(this.t('btn.search')) }); }
  get resetButton(): Locator { return this.card.getByRole('button', { name: iconButtonName(this.t('btn.reset')) }); }

  async open(kind: SkuFormKind, lang: StockLang = 'ko'): Promise<void> {
    this.lang = lang;
    await this.goto(`/commerce/product-stock/sku-master/${kind}${lang === 'en' ? '?lang=en' : ''}`);
    await expect(this.table, 'The SKU master list must load').toBeVisible({ timeout: 30_000 });
    await expect(this.bodyRows.first(), 'The SKU master list must finish loading').toBeVisible({ timeout: 30_000 });
  }

  async search(field: string, keyword: string): Promise<void> {
    await test.step(`Search SKU master ${field} = "${keyword}"`, async () => {
      await this.searchFieldSelect.selectOption(field);
      await this.keywordInput.fill(keyword);
      const response = this.page.waitForResponse((res) => res.url().includes('/api/v1/skus?'));
      await this.searchButton.click();
      await response;
    });
  }

  row(skuCode: string): Locator {
    return this.bodyRows.filter({ has: this.page.locator('td', { hasText: new RegExp(`^${escapeRegex(skuCode)}$`) }) }).first();
  }

  async headerTexts(): Promise<string[]> {
    return (await this.headerCells.allInnerTexts()).map((text) => text.trim());
  }

  async uploadSkuFile(file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
    await test.step(`Upload ${file.name} through the SKU creation upload button`, async () => {
      const chooser = this.page.waitForEvent('filechooser');
      await this.uploadButton.click();
      await (await chooser).setFiles(file);
    });
  }
}
