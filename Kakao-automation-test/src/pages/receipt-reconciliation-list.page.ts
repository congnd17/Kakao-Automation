import { Locator, Page, expect, test } from '@playwright/test';
import { BasePage } from '@pages/base.page';

/**
 * US020 — màn 입고 대사 (danh sách nhóm + tab 불일치 목록). Route `/commerce/inventory-ledger/receipt-reconciliation`
 * — không có mục ở sidebar (verify 30/09), mở bằng URL. Locator verify bằng MCP trên dev 30/09: các `id` do màn tự gắn
 * (`sel_recon_period`, `btn_search`, `tbl_batches`…), ô ngày là react-datepicker (placeholder `YYYY-MM-DD`).
 */
export const RECEIPT_RECONCILIATION_PATH = '/commerce/inventory-ledger/receipt-reconciliation';

export class ReceiptReconciliationListPage extends BasePage {
  readonly sidebar: Locator;
  readonly buildGroupButton: Locator;
  readonly groupsTab: Locator;
  readonly mismatchesTab: Locator;
  readonly groupsBadge: Locator;
  readonly mismatchesBadge: Locator;
  readonly periodSelect: Locator;
  readonly receivedFrom: Locator;
  readonly receivedTo: Locator;
  readonly partnerInput: Locator;
  readonly statusSelect: Locator;
  readonly resetButton: Locator;
  readonly searchButton: Locator;
  readonly groupTable: Locator;
  readonly groupHeaders: Locator;
  readonly groupRows: Locator;
  readonly noRowsMessage: Locator;
  readonly ungroupedBanner: Locator;
  readonly mismatchTable: Locator;
  readonly datePicker: Locator;
  readonly loading: Locator;

  constructor(page: Page) {
    super(page);
    this.sidebar = page.getByRole('complementary').getByRole('navigation');
    this.buildGroupButton = page.locator('#btn_build_group');
    this.groupsTab = page.locator('#tab_batches');
    this.mismatchesTab = page.locator('#tab_mismatch');
    this.groupsBadge = page.locator('#cnt_batches');
    this.mismatchesBadge = page.locator('#cnt_mismatch');
    this.periodSelect = page.locator('#sel_recon_period');
    this.receivedFrom = page.getByPlaceholder('YYYY-MM-DD').nth(0);
    this.receivedTo = page.getByPlaceholder('YYYY-MM-DD').nth(1);
    this.partnerInput = page.locator('#input_partner');
    this.statusSelect = page.locator('#sel_status');
    this.resetButton = page.locator('#btn_reset');
    this.searchButton = page.locator('#btn_search');
    this.groupTable = page.locator('#tbl_batches');
    this.groupHeaders = this.groupTable.getByRole('columnheader');
    this.groupRows = this.groupTable.locator('tbody tr');
    this.noRowsMessage = page.locator('#msg_no_rows');
    this.ungroupedBanner = page.getByText(/이 기간에 아직 어느 대사 묶음에도 포함되지 않은/).locator('xpath=..');
    this.mismatchTable = page.locator('#tbl_mismatch');
    this.datePicker = page.getByRole('dialog', { name: 'Choose Date' });
    this.loading = page.getByText('불러오는 중...');
  }

  /** Mở màn (có thể kèm query `period=`) và chờ bảng tải xong. */
  async open(query = ''): Promise<void> {
    await this.goto(`${RECEIPT_RECONCILIATION_PATH}${query}`);
    await this.waitLoaded();
  }

  async waitLoaded(): Promise<void> {
    await expect(this.groupsTab, 'The Receipt reconciliation tabs render').toBeVisible();
    await expect(this.loading, 'The list finishes loading').toHaveCount(0);
  }

  /** Nhóm menu cấp 1 trong sidebar (link có nhãn nhóm, bấm để mở danh sách con). */
  menuGroup(label: string): Locator {
    return this.sidebar.getByRole('link', { name: label, exact: true }).first();
  }

  /** Nhãn các mục con của một nhóm menu theo thứ tự hiển thị (bỏ dòng tiêu đề lặp lại tên nhóm). */
  async menuChildren(label: string): Promise<string[]> {
    const items = this.menuGroup(label).locator('xpath=following-sibling::ul').locator('li:not(.side-menu__label1) > a');
    return (await items.allTextContents()).map((text) => text.trim());
  }

  /** Tab theo nhãn (TC gọi tên tab, VD `대사 묶음`) — tên khả dụng của tab = nhãn + badge số, nên khớp nguyên cụm. */
  tab(label: string): Locator {
    return this.page.getByRole('button', { name: new RegExp(`^${label}\\s*[\\d–]*$`) });
  }

  async optionTexts(select: Locator): Promise<string[]> {
    return select.locator('option').allTextContents();
  }

  async selectedOption(select: Locator): Promise<string> {
    return select.evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.text ?? '');
  }

  /** Gõ ngày như người dùng (không dùng lịch) rồi đóng lịch bằng Escape. */
  async typeDate(field: Locator, value: string, description: string): Promise<void> {
    await test.step(`Type ${value} into ${description}`, async () => {
      await field.click();
      await field.fill('');
      await field.pressSequentially(value);
      await field.press('Escape');
    });
  }

  async dateValues(): Promise<[string, string]> {
    return [await this.receivedFrom.inputValue(), await this.receivedTo.inputValue()];
  }

  async quickRange(label: '오늘' | '1주일' | '1개월' | '3개월' | '6개월' | '1년'): Promise<void> {
    await this.click(this.page.getByRole('button', { name: label, exact: true }), `${label} quick-range button`);
  }

  async search(): Promise<void> {
    await this.click(this.searchButton, '검색 (Search) button');
    await this.waitLoaded();
  }

  /** Nhập một kỳ theo cách TC mô tả: chọn tháng ở 기간* rồi gõ khoảng ngày 입고일 기준. */
  async enterPeriod(period: string, from: string, to: string): Promise<void> {
    await this.periodSelect.selectOption(period);
    await this.typeDate(this.receivedFrom, from, 'the start date field');
    await this.typeDate(this.receivedTo, to, 'the end date field');
  }

  async typePartner(code: string): Promise<void> {
    await this.type(this.partnerInput, code, '비즈파트너 (Biz partner) field');
  }

  async openMismatches(): Promise<void> {
    await this.click(this.mismatchesTab, '불일치 목록 (Mismatches) tab');
    await expect(this.mismatchTable, 'The mismatch table renders').toBeVisible();
  }

  async openBuildGroup(): Promise<void> {
    await this.click(this.buildGroupButton, '대사 묶음 만들기 (Build group) button');
    await this.page.waitForURL(/\/build-group/);
  }

  /** Text từng dòng của bảng nhóm (bỏ dòng "không có kết quả"). */
  async groupRowTexts(): Promise<string[]> {
    const rows = await this.groupRows.allInnerTexts();
    return rows.filter((row) => !row.includes('조회 결과가 없습니다.'));
  }

  /** Các ô ngày không chọn được của tháng đang mở trong lịch (không tính ngày tràn sang tháng khác). */
  async disabledDaysInPicker(): Promise<number[]> {
    const days = this.datePicker.locator('.react-datepicker__day--disabled:not(.react-datepicker__day--outside-month)');
    return (await days.allTextContents()).map(Number);
  }

  /** Tiêu đề tháng đang mở trong lịch (VD `September 2026`). */
  get pickerMonth(): Locator {
    return this.datePicker.locator('.react-datepicker__current-month');
  }

  /** Từng dòng câu của banner "chưa gom nhóm": text + kiểu hiển thị (câu nằm trên dòng riêng = display block). */
  async bannerLines(): Promise<Array<{ text: string; display: string }>> {
    return this.ungroupedBanner.locator(':scope > span').evaluateAll((spans) =>
      spans.map((span) => ({ text: span.textContent?.trim() ?? '', display: getComputedStyle(span).display })),
    );
  }

  /** Nút lùi tháng của lịch — react-datepicker không render nút này khi tháng trước nằm ngoài minDate. */
  get previousMonthButton(): Locator {
    return this.datePicker.getByRole('button', { name: 'Previous Month' });
  }

  async enabledDaysInPicker(): Promise<number[]> {
    const days = this.datePicker.locator('.react-datepicker__day:not(.react-datepicker__day--disabled):not(.react-datepicker__day--outside-month)');
    return (await days.allTextContents()).map(Number);
  }
}
