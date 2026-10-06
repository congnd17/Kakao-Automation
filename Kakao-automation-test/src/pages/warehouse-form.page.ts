import { Page, Locator, Response, expect, test } from '@playwright/test';
import { BasePage } from './base.page';
import { buttonText, exactText } from './warehouse-list.page';

/** Nhãn field của form 창고 등록 / chi tiết — đúng chữ trên UI (có dấu `*` với field bắt buộc). */
export const FIELD = {
  bizPartner: '거래처 *',
  name: '창고명 *',
  type: '창고 유형 *',
  category: '분류 (자동)',
  logisticsType: '물류 유형 *',
  channel: '물류사 유형 *',
  cjWarehouseCode: '물류사 창고 코드 *',
  cjChannelCode: '물류 채널 코드 *',
  logisticsInfo: '물류사 연동 정보 (JSON)',
  country: '국가 *',
  addr: '거리(상세) 주소 *',
  city: '도시',
  state: '주/도',
  zipCode: '우편번호 *',
  detailAddr: '추가 주소',
  phone: '전화번호 *',
} as const;

export type FieldLabel = (typeof FIELD)[keyof typeof FIELD];

export interface WarehouseFormInput {
  bizPartner?: string;
  name?: string;
  type?: string;
  logisticsType?: string;
  channel?: string;
  cjWarehouseCode?: string;
  cjChannelCode?: string;
  logisticsInfo?: string;
  addr?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  detailAddr?: string;
  callingCode?: string;
  number?: string;
}

/**
 * Form 창고 등록 (`/commerce/warehouses/create`) và màn chi tiết/sửa (`/commerce/warehouses/{id}`) — US069.
 * Mỗi field là `div.col-md-6 > label + control` (field JSON rộng hết dòng: `div.col-md-12` — verify 29/09); label không gắn `for` → neo control theo label cùng khung.
 * Lỗi validate nằm trong `.invalid-feedback` của khung field, control nhận class `is-invalid`.
 * Màn chi tiết có thêm panel 상태 및 작업 (trạng thái, số liệu tham chiếu, nút 변경 이력 / 비활성화 / 재활성화 / 삭제).
 */
export class WarehouseFormPage extends BasePage {
  readonly formCard = this.page.locator('.card').filter({ has: this.page.locator('label', { hasText: exactText(FIELD.type) }) });
  readonly cardHeader = this.formCard.locator('.card-header');
  readonly headerStatusBadge = this.cardHeader.locator('.badge');

  readonly bizPartnerSelect = this.field(FIELD.bizPartner).locator('select');
  readonly nameInput = this.page.getByPlaceholder('예: 인천 물류센터');
  readonly typeSelect = this.field(FIELD.type).locator('select');
  readonly categoryInput = this.field(FIELD.category).locator('input');
  readonly logisticsTypeSelect = this.field(FIELD.logisticsType).locator('select');
  readonly channelSelect = this.field(FIELD.channel).locator('select');
  readonly cjWarehouseCodeInput = this.page.getByPlaceholder('예: WH01');
  readonly cjChannelCodeInput = this.page.getByPlaceholder('예: CH01');
  readonly logisticsInfoInput = this.field(FIELD.logisticsInfo).locator('input, textarea');
  readonly countryCombo = this.page.getByRole('combobox', { name: FIELD.country });
  readonly countryValue = this.field(FIELD.country).locator('[class*="singleValue"]');
  readonly countryMenu = this.page.locator('[id^="react-select"][id$="-listbox"]');
  readonly addrInput = this.page.getByPlaceholder('예: 테헤란로 123');
  readonly cityInput = this.page.getByPlaceholder('예: 인천', { exact: true });
  readonly stateInput = this.page.getByPlaceholder('예: 인천광역시');
  readonly zipCodeInput = this.page.getByPlaceholder('예: 21500');
  readonly detailAddrInput = this.page.getByPlaceholder('예: 3동 2층');
  readonly callingCodeInput = this.page.getByRole('textbox', { name: '국가번호 *' });
  readonly numberInput = this.page.getByRole('textbox', { name: '전화번호 *' });

  readonly backButton = this.page.getByRole('button', { name: buttonText('목록으로') });
  readonly saveButton = this.page.getByRole('button', { name: buttonText('저장') });
  readonly saveNote = this.page.getByText('저장 즉시 창고가 적용됩니다 — 별도의 승인 절차는 없습니다.', { exact: true });

  readonly panel = this.page.locator('.card').filter({ has: this.page.getByText('상태 및 작업', { exact: true }) });
  readonly panelTitle = this.panel.getByText('상태 및 작업', { exact: true });
  readonly historyButton = this.panel.getByRole('button', { name: buttonText('변경 이력') });
  readonly deactivateButton = this.panel.getByRole('button', { name: buttonText('창고 비활성화') });
  readonly reactivateButton = this.panel.getByRole('button', { name: buttonText('재활성화') });
  readonly deleteButton = this.panel.getByRole('button', { name: buttonText('창고 삭제') });
  readonly panelActionButtons = this.panel.getByRole('button');
  readonly systemNote = this.panel.getByText(/^시스템이 관리하는 가상 창고입니다/);
  /** Nút bị chặn nằm trong `span[tabindex=0]` mang lý do ở `aria-label`; hover hiện tooltip cùng nội dung (verify 28/09). */
  // `has` tính TƯƠNG ĐỐI từ span → dùng locator nút không neo panel (neo panel thì không bao giờ khớp — lỗi lần chạy 28/09).
  readonly deleteBlockedWrapper = this.panel.locator('span[tabindex="0"]').filter({ has: this.page.getByRole('button', { name: buttonText('창고 삭제') }) });
  readonly tooltip = this.page.getByRole('tooltip').locator('.tooltip-inner');

  readonly dialog = this.page.getByRole('dialog');
  readonly dialogTitle = this.dialog.locator('.modal-title');
  readonly dialogBodyLines = this.dialog.locator('.modal-body p');
  readonly dialogCancelButton = this.dialog.getByRole('button', { name: buttonText('취소') });
  readonly deactivateConfirmButton = this.dialog.getByRole('button', { name: buttonText('비활성화') });
  readonly deleteConfirmButton = this.dialog.getByRole('button', { name: buttonText('영구 삭제') });

  readonly historyDialog = this.page.getByRole('dialog').filter({ has: this.page.locator('.modal-title', { hasText: /^변경 이력/ }) });
  readonly historySubtitle = this.historyDialog.locator('.modal-title span');
  readonly historyHeaders = this.historyDialog.getByRole('columnheader');
  readonly historyRows = this.historyDialog.locator('tbody tr');
  readonly historyEmptyTitle = this.historyDialog.getByText('변경 이력이 없습니다', { exact: true });
  readonly historyCloseButton = this.historyDialog.locator('.modal-footer').getByRole('button', { name: buttonText('닫기') });
  readonly historyCloseIcon = this.historyDialog.locator('.modal-header .btn-close');

  readonly conflictDialog = this.page.getByRole('dialog').filter({ has: this.page.locator('.modal-title', { hasText: '저장 충돌' }) });
  readonly conflictMessage = this.conflictDialog.locator('.modal-body > p').first();
  readonly conflictAttribution = this.conflictDialog.locator('.modal-body > p.text-muted');
  readonly conflictFieldsTitle = this.conflictDialog.getByText('다른 사용자가 아래 항목을 변경했습니다.', { exact: true });
  readonly conflictFieldList = this.conflictDialog.locator('ul');
  readonly conflictFields = this.conflictDialog.locator('ul li');
  readonly conflictReloadButton = this.conflictDialog.getByRole('button', { name: buttonText('다시 불러오기') });
  readonly conflictOverwriteButton = this.conflictDialog.getByRole('button', { name: buttonText('덮어쓰기') });
  readonly conflictRetryButton = this.conflictDialog.getByRole('button', { name: buttonText('다시 시도') });
  readonly conflictCloseIcon = this.conflictDialog.locator('.btn-close');

  readonly loadingIndicator = this.page.getByText('불러오는 중...');
  readonly pageError = this.page.locator('div.main-content .alert-danger');

  constructor(page: Page) {
    super(page);
  }

  /** Khung field theo nhãn đúng nguyên văn. */
  field(label: string): Locator {
    return this.page.locator('div.col-md-6, div.col-md-12').filter({ has: this.page.locator(':scope > label', { hasText: exactText(label) }) });
  }

  fieldLabel(label: string): Locator {
    return this.field(label).locator(':scope > label');
  }

  /** Thông báo lỗi validate của field (rỗng khi field hợp lệ). */
  fieldError(label: string): Locator {
    return this.field(label).locator('.invalid-feedback');
  }

  /** Dòng gợi ý xám dưới control. */
  fieldHint(label: string): Locator {
    return this.field(label).locator('.small.text-muted.mt-1');
  }

  /** Control chính (select / input) của field. */
  fieldControl(label: string): Locator {
    return this.field(label).locator('select, input:not([id^="react-select"]), textarea').first();
  }

  async openCreate(): Promise<void> {
    await this.goto('/commerce/warehouses/create');
    await expect(this.nameInput, 'Create warehouse form must be displayed').toBeVisible();
  }

  /** Mở màn chi tiết `id` và chờ panel 상태 및 작업 vẽ xong. */
  async open(id: number | string): Promise<void> {
    await this.goto(`/commerce/warehouses/${id}`);
    await this.waitForDetailLoaded();
  }

  async waitForDetailLoaded(): Promise<void> {
    await expect(this.loadingIndicator, 'Warehouse detail must finish loading').toHaveCount(0, { timeout: 30_000 });
    await expect(this.panelTitle, 'Warehouse detail must show the 상태 및 작업 (Status & actions) panel').toBeVisible();
  }

  /** Điền các field được truyền — thứ tự giống người dùng (loại → loại vận hành → 3PL) để form tự tính lại. */
  async fill(input: WarehouseFormInput): Promise<void> {
    await test.step(`Fill the warehouse form with ${JSON.stringify(input)}`, async () => {
      if (input.bizPartner !== undefined) await this.bizPartnerSelect.selectOption({ label: input.bizPartner });
      if (input.name !== undefined) await this.nameInput.fill(input.name);
      if (input.type !== undefined) await this.typeSelect.selectOption({ label: input.type });
      if (input.logisticsType !== undefined) await this.logisticsTypeSelect.selectOption({ label: input.logisticsType });
      if (input.channel !== undefined) await this.channelSelect.selectOption({ label: input.channel });
      if (input.cjWarehouseCode !== undefined) await this.cjWarehouseCodeInput.fill(input.cjWarehouseCode);
      if (input.cjChannelCode !== undefined) await this.cjChannelCodeInput.fill(input.cjChannelCode);
      if (input.logisticsInfo !== undefined) await this.logisticsInfoInput.fill(input.logisticsInfo);
      if (input.addr !== undefined) await this.addrInput.fill(input.addr);
      if (input.city !== undefined) await this.cityInput.fill(input.city);
      if (input.state !== undefined) await this.stateInput.fill(input.state);
      if (input.zipCode !== undefined) await this.zipCodeInput.fill(input.zipCode);
      if (input.detailAddr !== undefined) await this.detailAddrInput.fill(input.detailAddr);
      if (input.callingCode !== undefined) await this.callingCodeInput.fill(input.callingCode);
      if (input.number !== undefined) await this.numberInput.fill(input.number);
    });
  }

  /** Chọn quốc gia qua ô tìm kiếm của react-select. */
  async selectCountry(search: string, optionText: string | RegExp): Promise<void> {
    await this.countryCombo.click();
    await this.countryCombo.fill(search);
    await this.countryMenu.getByRole('option', { name: optionText }).click();
  }

  async openCountryMenu(): Promise<void> {
    await this.countryCombo.click();
    await expect(this.countryMenu, 'Country (국가) option list opens').toBeVisible();
  }

  /** Bấm 저장 khi form hợp lệ — chờ POST (tạo) / PATCH (sửa) trả về và trả response. */
  async saveAndWait(): Promise<Response> {
    const saved = this.page.waitForResponse(
      (r) => /\/api\/v1\/warehouses(\/\d+)?$/.test(r.url()) && ['POST', 'PATCH'].includes(r.request().method()),
    );
    await this.click(this.saveButton, '저장 (Save) button');
    return saved;
  }

  /** Bấm 저장 khi form có lỗi — client validate chặn, không có request nào được gửi. */
  async saveExpectingValidation(): Promise<void> {
    await this.click(this.saveButton, '저장 (Save) button');
  }

  async backToList(): Promise<void> {
    await this.click(this.backButton, '목록으로 (Back to list) button');
    await expect(this.page, 'Returns to the warehouse list').toHaveURL(/\/commerce\/warehouses(\?.*)?$/);
  }

  /** Giá trị của 1 dòng trong panel 상태 및 작업 theo nhãn (상태, 물류사 유형, 분류, 등록일시, 연결된 …). */
  panelValue(label: string): Locator {
    return this.panel.locator('li').filter({ has: this.page.locator(':scope > span.text-muted', { hasText: exactText(label) }) }).locator(':scope > span.text-end');
  }

  /**
   * Chờ 3 số tham chiếu của panel tải xong — số mapping được đếm bằng 1 request riêng, trong lúc chờ panel hiện "확인 불가"
   * (verify 29/09). Chỉ dùng cho warehouse thật (bucket luôn hiện "확인 불가").
   */
  async waitForReferenceFigures(): Promise<void> {
    for (const label of ['연결된 재고 기록', '연결된 매장', '연결된 상품-창고 매핑']) {
      await expect(this.panelValue(label), `${label} has finished loading`).toHaveText(/^\d+/);
    }
  }

  toast(text: string | RegExp): Locator {
    return this.page.getByRole('alert').filter({ hasText: text });
  }

  async openDeactivateDialog(): Promise<void> {
    await this.click(this.deactivateButton, '창고 비활성화 (Deactivate warehouse) button');
    await expect(this.dialogTitle, 'Deactivate confirm dialog opens').toHaveText('창고를 비활성화할까요?');
  }

  /** Xác nhận 비활성화 trong dialog — trả response của POST /deactivate. */
  async confirmDeactivate(): Promise<Response> {
    const done = this.page.waitForResponse((r) => r.url().includes('/deactivate'));
    await this.click(this.deactivateConfirmButton, '비활성화 (Deactivate) button in the dialog');
    return done;
  }

  async reactivate(): Promise<Response> {
    const done = this.page.waitForResponse((r) => r.url().includes('/reactivate'));
    await this.click(this.reactivateButton, '재활성화 (Reactivate) button');
    return done;
  }

  /** Hover nút 창고 삭제 đang bị chặn (qua khung bọc — nút disabled không nhận hover) và chờ tooltip hiện. */
  async hoverBlockedDelete(): Promise<void> {
    await test.step('Hover the disabled 창고 삭제 (Delete warehouse) button', async () => {
      await this.deleteBlockedWrapper.hover();
      await expect(this.tooltip, 'The blocking-reason tooltip appears').toBeVisible();
    });
  }

  async openDeleteDialog(): Promise<void> {
    await this.click(this.deleteButton, '창고 삭제 (Delete warehouse) button');
    await expect(this.dialogTitle, 'Delete confirm dialog opens').toHaveText('창고를 삭제할까요?');
  }

  async confirmDelete(): Promise<Response> {
    const done = this.page.waitForResponse((r) => r.request().method() === 'DELETE' && /\/api\/v1\/warehouses\/\d+$/.test(r.url()));
    await this.click(this.deleteConfirmButton, '영구 삭제 (Delete permanently) button in the dialog');
    return done;
  }

  /** Mở dialog 변경 이력 và chờ đúng lượt GET /history trả về (trạng thái rỗng thoáng qua khi đang tải). */
  async openHistory(): Promise<void> {
    const loaded = this.page.waitForResponse((r) => /\/api\/v1\/warehouses\/\d+\/history/.test(r.url()));
    await this.click(this.historyButton, '변경 이력 (Change history) button');
    await loaded;
    await expect(this.historyDialog, 'Change history dialog opens').toBeVisible();
    await expect(this.historyDialog.getByText('변경 이력을 불러오는 중…'), 'Change history finishes loading').toHaveCount(0);
  }

  async closeHistory(): Promise<void> {
    await this.click(this.historyCloseButton, '닫기 (Close) button of the Change history dialog');
    await expect(this.historyDialog, 'Change history dialog closes').toHaveCount(0);
  }

  /** Các dòng của dialog 변경 이력: [변경 일시, 변경자, 항목, 변경 내용] — mỗi ô giữ xuống dòng giữa các dòng xếp chồng. */
  async readHistoryRows(): Promise<string[][]> {
    return this.historyRows.evaluateAll((rows) =>
      rows.filter((r) => (r as HTMLTableRowElement).cells.length === 4).map((r) => Array.from((r as HTMLTableRowElement).cells).map((c) => (c as HTMLElement).innerText.trim())),
    );
  }

  /** Ô 변경 내용 của dòng `index`: phần giá trị cũ (gạch ngang) và mới (in đậm). */
  historyChangeCell(index: number): Locator {
    return this.historyRows.nth(index).locator('td').nth(3);
  }

  /** Giá trị hiện tại của mọi field đang hiển thị trên form, theo nhãn. */
  async readForm(): Promise<Record<string, string>> {
    return this.formCard.locator('.card-body .row > div').evaluateAll((cols) =>
      Object.fromEntries(
        cols.map((col) => {
          const label = col.querySelector('label')?.textContent?.trim() ?? '';
          const select = col.querySelector('select') as HTMLSelectElement | null;
          const single = col.querySelector('[class*="singleValue"]');
          const inputs = Array.from(col.querySelectorAll('input:not([id^="react-select"]), textarea')) as HTMLInputElement[];
          const value = select ? (select.selectedOptions[0]?.textContent ?? '') : single ? (single.textContent ?? '') : inputs.map((i) => i.value).join(' ');
          return [label, value.trim()];
        }),
      ),
    );
  }

  /** Nhãn của mọi field đang hiển thị trên form, theo thứ tự. */
  async visibleFieldLabels(): Promise<string[]> {
    return (await this.formCard.locator('.card-body .row > div > label').allTextContents()).map((l) => l.trim());
  }
}
