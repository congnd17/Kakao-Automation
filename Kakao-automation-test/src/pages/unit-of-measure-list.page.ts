import { Page, Locator, test, expect } from '@playwright/test';
import { BasePage } from './base.page';

export class UnitOfMeasureListPage extends BasePage {
  readonly addUnitButton = this.page.getByRole('button', { name: '단위 등록' });
  readonly searchInput = this.page.getByPlaceholder('코드 또는 이름');
  readonly statusFilterSelect = this.page.locator('select').filter({ has: this.page.locator('option[value="ACTIVE"]') });
  readonly resetButton = this.page.getByRole('button', { name: '초기화' });
  readonly searchButton = this.page.getByRole('button', { name: '검색' });
  readonly pageSizeSelect = this.page.locator('select').filter({ has: this.page.locator('option[value="20"]') });
  readonly table = this.page.locator('table');
  readonly pagerTotalText = this.page.getByText(/^총 \d+개의 항목 중/);

  constructor(page: Page) {
    super(page);
  }

  async open(): Promise<void> {
    await this.goto('/commerce/unit-of-measures');
  }

  rowByCode(code: string): Locator {
    const exactCode = new RegExp(`^${code}$`);
    return this.table.locator('tbody tr').filter({ has: this.page.locator('td', { hasText: exactCode }) });
  }

  rowActionLink(code: string): Locator {
    return this.rowByCode(code).locator('td:last-child button');
  }

  async toggleStatusFromRow(code: string): Promise<void> {
    await this.ensureRowVisible(code);
    await this.click(this.rowActionLink(code), `status toggle of row ${code}`);
  }

  /**
   * Dữ liệu thật có thể đã có nhiều bản ghi hơn 1 trang mặc định — dòng vừa tạo không chắc nằm
   * trên trang hiện tại. Tìm theo mã trước khi thao tác trên dòng để không phụ thuộc phân trang.
   */
  private async ensureRowVisible(code: string): Promise<void> {
    const onCurrentPage = await this.rowByCode(code)
      .first()
      .waitFor({ state: 'visible', timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    if (onCurrentPage) return;
    await this.fillSearch(code);
    await this.clickSearch();
  }

  async fillSearch(keyword: string): Promise<void> {
    await this.type(this.searchInput, keyword, '검색 (Code or name) field');
  }

  async clickSearch(): Promise<void> {
    await this.click(this.searchButton, '검색 (Search) button');
  }

  async clickReset(): Promise<void> {
    await this.click(this.resetButton, '초기화 (Reset) button');
  }

  async selectStatusFilter(value: '' | 'ACTIVE' | 'INACTIVE'): Promise<void> {
    await test.step(`Select status filter "${value || '전체'}"`, async () => {
      await this.statusFilterSelect.selectOption(value);
    });
  }

  async setPageSize(value: string): Promise<void> {
    await test.step(`Select rows per page "${value}"`, async () => {
      await this.pageSizeSelect.selectOption(value);
    });
  }

  async openUnit(code: string): Promise<void> {
    await this.ensureRowVisible(code);
    await this.click(this.rowByCode(code), `UOM row with code ${code}`);
  }

  async openCreateForm(): Promise<void> {
    // Ngay sau khi vừa xoá/điều hướng về danh sách, nút render tạm thời 2 bản trong lúc
    // chuyển tiếp UI — chờ ổn định về 1 bản trước khi click để tránh strict-mode violation.
    await expect(this.addUnitButton).toHaveCount(1);
    await this.click(this.addUnitButton, '단위 등록 (Add unit) button');
  }

  /**
   * Dọn sạch 1 mã test trước/sau khi chạy — môi trường là backend thật, dữ liệu tồn tại vĩnh viễn
   * giữa các lần chạy. Bỏ qua an toàn nếu mã chưa tồn tại hoặc không xoá được.
   */
  async ensureCodeDeleted(code: string): Promise<void> {
    await this.open();
    await this.fillSearch(code);
    await this.clickSearch();
    const row = this.rowByCode(code);
    const found = await row
      .first()
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!found) return;
    await this.openUnit(code);
    const deleteButton = this.page.getByRole('button', { name: '삭제' });
    if (await deleteButton.isDisabled().catch(() => true)) return;
    await deleteButton.click();
    await this.page.getByRole('dialog').getByRole('button', { name: '삭제' }).click();
    await expect(this.page).toHaveURL(/\/commerce\/unit-of-measures$/);
  }
}
