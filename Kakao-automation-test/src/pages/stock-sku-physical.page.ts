import { Page, Locator, Request, expect, test } from '@playwright/test';
import { SkuFormPage } from './sku-form.page';
import { StockListPage } from './stock-list.page';
import type { WorldManufacturer, WorldPartner } from '@utils/stock.data';
import type { StockTextKey } from '@utils/stock.i18n';

/** Giá trị các trường chung của form 현물 SKU (trừ bảng dòng SKU) — chọn partner / 제조사 theo id (tên option có thể trùng). */
export interface PhysicalCommonValues {
  partner: WorldPartner;
  manufacturer: WorldManufacturer;
  groupCode: string;
  groupName: string;
  usageType?: 'MAIN' | 'PARTS' | 'GIVEAWAY';
  price?: string;
  weight?: string;
  volume?: [string, string, string];
  hsCode?: string;
  description?: string;
}

/**
 * Form 현물 SKU — phần bổ sung cho nhóm [Physical SKU Form] TC_093–117 (verify bundle `Nue`/`t8` + recon 05/10/2026):
 * 상품코드 / SKU 코드 / 바코드 khoá bằng `readonly` (+ `bg-light`), không phải `disabled`; thông báo của 바코드 중복확인 /
 * 추가 / lỗi validate hiện ở toast `.toast-container .toast`; lỗi trùng 상품코드 ở `.invalid-feedback` dưới trường;
 * lỗi 저장 từ server ở `.alert-danger` đầu trang; trail = breadcrumb của host (`ol.breadcrumb`).
 */
export class PhysicalSkuFormPage extends SkuFormPage {
  readonly breadcrumbItems = this.page.locator('ol.breadcrumb li.breadcrumb-item');
  readonly breadcrumbActive = this.page.locator('ol.breadcrumb li.breadcrumb-item.active');
  readonly pageAlert = this.page.locator('.alert-danger');
  /** Dòng SKU thật (có ô nhập) — không tính dòng trống "SKU를 추가해주세요.". */
  readonly dataLines = this.lineRows.filter({ has: this.page.locator('input') });
  readonly emptyLineRow = this.lineRows.filter({ hasNot: this.page.locator('input') });
  /** Gợi ý (title) của tiêu đề cột SKU명. */
  readonly skuNameHeaderHint = this.linesTable.locator('thead th span[title]');

  constructor(page: Page) {
    super(page);
  }

  /** Toast theo nội dung (chứa chuỗi). */
  toast(text: string): Locator {
    return this.toasts.filter({ hasText: text });
  }

  toastOf(key: StockTextKey): Locator {
    return this.toast(this.t(key));
  }

  get groupCodeError(): Locator {
    return this.fieldError('skuForm.field.skuGroupCode');
  }

  /** Text các tiêu đề cột của bảng dòng SKU (textContent). */
  async lineHeaderTexts(): Promise<string[]> {
    return (await this.lineHeaders.allTextContents()).map((text) => text.trim());
  }

  /** Text các mục breadcrumb (trail) phía trên form. */
  async trailTexts(): Promise<string[]> {
    return (await this.breadcrumbItems.allInnerTexts()).map((text) => text.trim());
  }

  async choosePartner(partner: WorldPartner): Promise<void> {
    await test.step(`Choose biz partner ${partner.nameKo}`, async () => {
      await this.bizPartnerSelect.selectOption(String(partner.id));
    });
  }

  async chooseManufacturerOf(manufacturer: WorldManufacturer): Promise<void> {
    await test.step(`Choose manufacturer ${manufacturer.name}`, async () => {
      await this.manufacturerSelect.selectOption(String(manufacturer.id));
    });
  }

  /** 원산지 = 대한민국 (KR) trong react-select (nhãn "🇰🇷 대한민국 (KR)"). */
  async chooseKorea(): Promise<void> {
    await test.step('Choose country of origin 대한민국 (Korea)', async () => {
      await this.countryInput.click();
      await this.countryInput.fill('대한민국');
      await this.page.locator('[id^="react-select-"][id*="-option-"]').filter({ hasText: '(KR)' }).first().click();
    });
  }

  /** Điền mọi trường chung (không đụng 옵션 설정 và bảng dòng SKU). */
  async fillCommon(values: PhysicalCommonValues): Promise<void> {
    await test.step(`Fill the common fields of the physical SKU form for product code ${values.groupCode}`, async () => {
      await this.choosePartner(values.partner);
      await this.skuGroupCodeInput.fill(values.groupCode);
      await this.skuGroupCodeNameInput.fill(values.groupName);
      await this.usageRadio(values.usageType ?? 'MAIN').check();
      await this.priceInput.fill(values.price ?? '12000');
      await this.weightInput.fill(values.weight ?? '250');
      const [width, depth, height] = values.volume ?? ['100', '80', '30'];
      await this.widthInput.fill(width);
      await this.depthInput.fill(depth);
      await this.heightInput.fill(height);
      if (values.hsCode !== undefined) await this.hsCodeInput.fill(values.hsCode);
      await this.descriptionInput.fill(values.description ?? 'CD');
      await this.chooseManufacturerOf(values.manufacturer);
      await this.chooseKorea();
    });
  }

  /** Bấm 중복확인 của 상품코드 và đợi phản hồi — trả về status + body. */
  async checkCodeWithResponse(): Promise<{ status: number; body: { ids?: unknown[] } | null }> {
    const response = this.page.waitForResponse((res) => res.url().includes('/sku-groups/check-duplication'));
    await this.click(this.checkCodeButton, `${this.t('skuForm.btn.checkCode')} button`);
    const res = await response;
    return { status: res.status(), body: (await res.json().catch(() => null)) as { ids?: unknown[] } | null };
  }

  /** Bấm 바코드 중복확인 và đợi phản hồi server (chỉ dùng khi chắc chắn form gọi server). */
  async checkBarcodeWithResponse(): Promise<{ status: number; body: { ids?: unknown[]; type?: string } | null }> {
    const response = this.page.waitForResponse((res) => new URL(res.url()).pathname === '/api/v1/skus/check-duplication');
    await this.checkBarcode();
    const res = await response;
    return { status: res.status(), body: (await res.json().catch(() => null)) as { ids?: unknown[]; type?: string } | null };
  }

  /** Bấm 다른 바코드 사용. */
  async useOtherBarcode(): Promise<void> {
    await this.click(this.useOtherBarcodeButton, `${this.t('skuForm.btn.useOtherBarcode')} button`);
  }

  /** Thử bấm 1 control (có thể đang disabled) bằng cú click chuột thật — control disabled không phản hồi. */
  async tryClick(target: Locator, description: string): Promise<void> {
    await test.step(`Try to click ${description}`, async () => {
      await target.click({ force: true });
    });
  }

  /** Thử đổi select (có thể đang disabled) bằng chuột + phím như người dùng. */
  async tryChangeSelect(select: Locator, description: string): Promise<void> {
    await test.step(`Try to change ${description}`, async () => {
      await select.click({ force: true });
      await this.page.keyboard.press('ArrowDown');
      await this.page.keyboard.press('Enter');
      await this.page.keyboard.press('Escape');
    });
  }

  /** Thử gõ phím vào ô (có thể readonly). */
  async tryType(input: Locator, text: string, description: string): Promise<void> {
    await test.step(`Try to type "${text}" into ${description}`, async () => {
      await input.click({ force: true });
      await this.page.keyboard.press('End');
      await this.page.keyboard.type(text);
    });
  }

  /** Xoá ô rồi gõ từng ký tự như người dùng. */
  async retype(input: Locator, text: string, description: string): Promise<void> {
    await test.step(`Type "${text.length > 40 ? `${text.slice(0, 37)}…` : text}" into ${description}`, async () => {
      await input.fill('');
      await input.pressSequentially(text);
    });
  }

  /** Xoá ô rồi dán `text` từ clipboard (Ctrl+V). */
  async pasteInto(input: Locator, text: string, description: string): Promise<void> {
    await test.step(`Paste "${text}" from the clipboard into ${description}`, async () => {
      await this.page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await this.page.evaluate((value) => navigator.clipboard.writeText(value), text);
      await input.fill('');
      await input.focus();
      await this.page.keyboard.press('ControlOrMeta+V');
    });
  }

  /** Ghi lại mọi request khớp điều kiện từ lúc gọi (để đếm / đọc payload). */
  recordRequests(match: (request: Request) => boolean): Request[] {
    const seen: Request[] = [];
    this.page.on('request', (request) => {
      if (match(request)) seen.push(request);
    });
    return seen;
  }

  /** Request gọi 바코드 중복확인 phía server (POST /skus/check-duplication). */
  recordBarcodeChecks(): Request[] {
    return this.recordRequests((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/skus/check-duplication');
  }

  /** Request 저장 (POST /skus hoặc PATCH /skus/{id}). */
  recordSkuWrites(): Request[] {
    return this.recordRequests((request) => {
      const path = new URL(request.url()).pathname;
      return ['POST', 'PATCH'].includes(request.method()) && (path === '/api/v1/skus' || /^\/api\/v1\/skus\/\d+$/.test(path));
    });
  }

  /** Bấm 저장 và đợi POST/PATCH /skus trả về — trả về status, body phản hồi và payload đã gửi. */
  async saveWithResponse(): Promise<{ status: number; body: Record<string, unknown> | null; requestBody: Record<string, unknown> | null }> {
    const response = this.page.waitForResponse((res) => {
      const request = res.request();
      const path = new URL(request.url()).pathname;
      return ['POST', 'PATCH'].includes(request.method()) && (path === '/api/v1/skus' || /^\/api\/v1\/skus\/\d+$/.test(path));
    }, { timeout: 60_000 });
    await this.click(this.saveButton, `${this.t('btn.save')} button`);
    const res = await response;
    return {
      status: res.status(),
      body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
      requestBody: (res.request().postDataJSON() ?? null) as Record<string, unknown> | null,
    };
  }

  /** Đợi phần tử hiện trong `timeout` — trả về true/false để ghi nhận trong Act, assert ở Assert. */
  async seen(target: Locator, timeout = 15_000): Promise<boolean> {
    return target.first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);
  }

  /** Bấm 저장 nếu nút đang bật; nút tắt → ghi nhận "blocked". Trả về trạng thái nút lúc bấm. */
  async trySave(): Promise<{ disabled: boolean }> {
    const disabled = await this.saveButton.isDisabled();
    await this.tryClick(this.saveButton, `${this.t('btn.save')} button`);
    return { disabled };
  }

  /** Mở màn sửa bằng link 상품코드 trên dòng `skuCode` của 재고 관리 (list đã lọc sẵn). */
  async openEditFromList(list: StockListPage, skuCode: string, groupCode: string): Promise<void> {
    await test.step(`Click the product code link ${groupCode} on the ${skuCode} row`, async () => {
      await list.search('SKU_CODE', skuCode);
      await list.click(list.cell(list.row(skuCode), 'col.skuGroupCode').getByRole('link', { name: groupCode, exact: true }), `product code link ${groupCode}`);
      this.kind = 'physical';
      this.lang = 'ko';
      await expect(this.cardTitle, 'The SKU form must load').toBeVisible({ timeout: 30_000 });
      await expect(this.skuGroupCodeInput, 'The SKU form must finish loading the saved values').not.toHaveValue('', { timeout: 30_000 });
    });
  }
}
