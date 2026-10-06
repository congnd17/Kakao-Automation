import { Page, Locator, Response, expect, test } from '@playwright/test';
import { BasePage } from './base.page';
import { StockListPage, escapeRegex, iconButtonName } from './stock-list.page';
import { SkuFormKind, SkuFormPage, SkuSearchDialog } from './sku-form.page';
import { stx, StockTextKey } from '@utils/stock.i18n';

/** Kết quả 1 lần bấm 저장 trên form SKU: body request gửi đi, status + body response. */
export interface SkuSaveCapture {
  requestBody: Record<string, unknown>;
  status: number;
  body: { code?: string; message?: string; detail?: string } & Record<string, unknown>;
}

/** Kết quả 1 lần bấm 중복확인 (POST /sku-groups/check-duplication). */
export interface CodeCheckCapture {
  status: number;
  body: { ids?: unknown[]; code?: unknown } & Record<string, unknown>;
}

/** Route list mà form quay về sau khi lưu (returnTo = 재고 관리, mặc định = SKU master của loại đó). */
export const SKU_LIST_ROUTE = /\/commerce\/product-stock\/(stock|sku-master\/(physical|digital|set))(\?|$)/;
/** Route màn 재고 관리. */
export const STOCK_LIST_ROUTE = /\/commerce\/product-stock\/stock(\?|$)/;

/**
 * Bổ sung cho form Set / Digital SKU (US134 TC_143–173) — verify theo bundle (`Rue` set form, `Tue` digital form,
 * `j8t` dialog SKU 검색, `Zq` 4 trường chung, `e8` khung form) + recon out/pg-stock_set_create.*:
 *  - Lỗi lưu (server) hiện ở `div.alert-danger` đặt TRƯỚC card form (không nằm trong card) — `SkuFormPage.pageError` tìm
 *    trong card nên không thấy; dùng `formAlert` ở đây.
 *  - Bảng SET 설정: 4 cột SKU 코드 · SKU명 · 구성 개수 (input aria-label 구성 개수, readOnly ở edit) · 삭제; bảng rỗng = 1 dòng
 *    "SKU를 추가해주세요". Nút 추가 dưới bảng chỉ có ở create.
 *  - Dialog SKU 검색: giữ dấu tick qua nhiều lượt tìm trong cùng 1 lần mở → tìm theo từng mã rồi tick, cuối cùng 추가.
 *  - Sidebar: mục đang chọn mang `a.side-menu__item.active`; breadcrumb `nav[aria-label=breadcrumb] li.breadcrumb-item`.
 */
export class StockSkuSetPage extends BasePage {
  readonly form: SkuFormPage;
  readonly dialog: SkuSearchDialog;
  readonly list: StockListPage;
  readonly formAlert = this.page.locator('.alert.alert-danger').first();
  readonly toasts = this.page.locator('.toast-container .toast');
  readonly breadcrumbItems = this.page.locator('nav[aria-label="breadcrumb"] li.breadcrumb-item');
  readonly pageHeading = this.page.getByRole('heading', { level: 4 });

  constructor(page: Page, form?: SkuFormPage, dialog?: SkuSearchDialog) {
    super(page);
    this.form = form ?? new SkuFormPage(page);
    this.dialog = dialog ?? new SkuSearchDialog(page);
    this.list = new StockListPage(page);
  }

  t(key: StockTextKey): string {
    return stx(key, this.form.lang);
  }

  /** Dòng thành phần của bảng SET 설정 (bỏ dòng "SKU를 추가해주세요"). */
  get componentRows(): Locator {
    return this.form.linesTable.locator('tbody tr').filter({ has: this.page.locator('input') });
  }

  get componentHeaders(): Locator {
    return this.form.linesTable.locator('thead th');
  }

  /** Dòng "SKU를 추가해주세요" của bảng SET 설정 rỗng. */
  get emptyRow(): Locator {
    return this.form.linesTable.locator('tbody td', { hasText: this.t('skuForm.err.setEmpty') });
  }

  componentRow(skuCode: string): Locator {
    return this.componentRows.filter({ has: this.page.locator('td:first-child', { hasText: new RegExp(`^${escapeRegex(skuCode)}$`) }) }).first();
  }

  quantityInput(row: Locator): Locator {
    return row.locator(`input[aria-label="${this.t('skuForm.col.quantity')}"]`);
  }

  deleteButton(row: Locator): Locator {
    return row.getByRole('button', { name: iconButtonName(this.t('skuForm.btn.delete')) });
  }

  /** Nút 추가 dưới bảng SET 설정 (chỉ có ở create). */
  get addComponentButton(): Locator {
    return this.form.card.getByRole('button', { name: iconButtonName(this.t('skuForm.btn.add')) });
  }

  /** SKU 코드 của mọi dòng thành phần theo thứ tự. */
  async componentCodes(): Promise<string[]> {
    return (await this.componentRows.locator('td:first-child').allInnerTexts()).map((text) => text.trim());
  }

  /** Ô tick của 1 dòng kết quả trong dialog SKU 검색. */
  dialogCheckbox(skuCode: string): Locator {
    return this.dialog.row(skuCode).locator('input[type="checkbox"]');
  }

  /** Giá trị cột SKU 유형 của mọi dòng kết quả trong dialog. */
  async dialogTypes(): Promise<string[]> {
    return (await this.dialog.rows.filter({ has: this.page.locator('input[type="checkbox"]') }).locator('td:nth-child(4)').allInnerTexts()).map((text) => text.trim());
  }

  /** Mục sidebar đang được chọn (class active) theo tên. */
  activeSidebarItem(name: string): Locator {
    return this.page.locator('aside a.side-menu__item.active').filter({ hasText: new RegExp(`^\\s*${escapeRegex(name)}\\s*$`) });
  }

  async breadcrumbTexts(): Promise<string[]> {
    return (await this.breadcrumbItems.allInnerTexts()).map((text) => text.replace(/[^\p{L}\p{N} ()-]/gu, '').trim());
  }

  /** Điền 3 trường chung (비즈파트너 theo id, 상품코드, 상품코드명) — không bấm 중복확인. */
  async fillCommon(values: { partnerId?: number; code?: string; name?: string }): Promise<void> {
    await test.step('Fill the common SKU fields', async () => {
      if (values.partnerId !== undefined) await this.form.bizPartnerSelect.selectOption(String(values.partnerId));
      if (values.code !== undefined) await this.form.skuGroupCodeInput.fill(values.code);
      if (values.name !== undefined) await this.form.skuGroupCodeNameInput.fill(values.name);
    });
  }

  /** Bấm 중복확인 và trả về response của POST /sku-groups/check-duplication. */
  async checkCode(): Promise<CodeCheckCapture> {
    const response = this.page.waitForResponse((res) => res.url().includes('/sku-groups/check-duplication') && res.request().method() === 'POST', { timeout: 30_000 });
    await this.click(this.form.checkCodeButton, `${this.t('skuForm.btn.checkCode')} button`);
    const res = await response;
    return { status: res.status(), body: ((await res.json().catch(() => ({}))) ?? {}) as CodeCheckCapture['body'] };
  }

  /** Mở dialog SKU 검색 bằng nút 추가 dưới bảng. */
  async openSearch(): Promise<void> {
    await this.click(this.addComponentButton, `${this.t('skuForm.btn.add')} button below the ${this.t('skuForm.section.set')} table`);
    await this.dialog.waitOpen(this.form.lang);
  }

  /** Tìm từng SKU theo SKU 코드 trong dialog đang mở và tick (dấu tick giữ qua các lượt tìm). */
  async tickByCode(skuCodes: string[]): Promise<void> {
    for (const code of skuCodes) {
      await this.dialog.search('SKU_CODE', code);
      await expect(this.dialog.row(code), `SKU ${code} must be offered by the SKU search`).toBeVisible();
      await this.dialogCheckbox(code).check();
    }
  }

  /** Bấm 추가 trong dialog và đợi dialog đóng. */
  async confirmDialog(): Promise<void> {
    await this.click(this.dialog.addButton, `${this.t('skuSearch.btn.add')} button inside the dialog`);
    await expect(this.dialog.root, 'The SKU search dialog closes').toBeHidden();
  }

  /** Thêm SKU thành phần qua dialog SKU 검색 (mở → tìm + tick từng mã → 추가) rồi điền 구성 개수 nếu có. */
  async addComponents(components: Array<{ code: string; quantity?: string }>): Promise<void> {
    await test.step(`Add components ${components.map((c) => c.code).join(', ')} through SKU search`, async () => {
      await this.openSearch();
      await this.tickByCode(components.map((c) => c.code));
      await this.confirmDialog();
      for (const component of components) {
        if (component.quantity !== undefined) await this.quantityInput(this.componentRow(component.code)).fill(component.quantity);
      }
    });
  }

  /** Bấm 저장 và bắt request + response POST/PATCH /skus. */
  async saveCapture(): Promise<SkuSaveCapture> {
    const isSkuWrite = (res: Response) => {
      const path = new URL(res.url()).pathname;
      return (path === '/api/v1/skus' || path.startsWith('/api/v1/skus/')) && !path.includes('check-duplication') && ['POST', 'PATCH'].includes(res.request().method());
    };
    const response = this.page.waitForResponse(isSkuWrite, { timeout: 60_000 });
    await this.click(this.form.saveButton, `${this.t('btn.save')} button`);
    const res = await response;
    return {
      requestBody: (res.request().postDataJSON() ?? {}) as Record<string, unknown>,
      status: res.status(),
      body: ((await res.json().catch(() => ({}))) ?? {}) as SkuSaveCapture['body'],
    };
  }

  /** Đợi màn trả lời 1 lần bấm 저장 (toast thành công / lỗi kiểm tra, hoặc alert lỗi server) — không fail nếu không có. */
  async waitForAnswer(timeout = 30_000): Promise<void> {
    await this.toasts.first().or(this.formAlert).first().waitFor({ state: 'visible', timeout }).catch(() => undefined);
  }

  /** Mở form tạo và điền đủ trường chung + qua 중복확인 với mã mới. */
  async openReadyCreate(kind: SkuFormKind, values: { partnerId: number; code: string; name: string }): Promise<void> {
    await test.step(`Open the ${kind} create form ready to save (${values.code})`, async () => {
      await this.form.openCreate(kind);
      await this.fillCommon(values);
      const check = await this.checkCode();
      expect((check.body.ids ?? []).length, `Product code ${values.code} must be free`).toBe(0);
    });
  }

  /** Dòng 재고 관리 theo 상품코드: tìm SKU_GROUP_CODE rồi lấy dòng theo SKU ID. */
  async findStockRow(groupCode: string, skuId: number): Promise<Locator> {
    await this.list.open('ko');
    await this.list.search('SKU_GROUP_CODE', groupCode);
    return this.list.rowBySkuId(skuId);
  }
}
