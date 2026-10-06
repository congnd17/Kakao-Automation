import { Page, Locator, expect } from '@playwright/test';
import { BasePage } from './base.page';

export interface ChannelKeyFilter {
  pg?: string;
  method?: string;
  currency?: string;
  strategy?: string;
}

/**
 * Màn 결제수단 정책 › danh sách (US080) — `/commerce/payment-method-policies`. Locator verify trên UI thật 28/09.
 * - Dòng bảng là `tr[role="button"]`; empty state là 1 `<tr><td colspan>` không có role.
 * - Link 변경 이력 trong ô 작업 là `span[role="button"]` lồng trong dòng role=button → cây accessibility coi nó là
 *   con "presentational" của dòng, `getByRole` KHÔNG thấy — phải neo bằng CSS + text.
 * - Pager: nút trang là `a.page-link[role="button"]`; ở trang cuối Next/Last đổi thành `<span>` trong `li.disabled`.
 */
export class PaymentMethodPolicyListPage extends BasePage {
  readonly addPolicyButton = this.page.getByRole('button', { name: '정책 추가' });
  readonly pgFilterSelect = this.page.locator('select').filter({ has: this.page.locator('option[value="EXIMBAY"]') });
  readonly methodFilterSelect = this.page.locator('select').filter({ has: this.page.locator('option[value="ALIPAY"]') });
  readonly currencyFilterSelect = this.page.locator('select').filter({ has: this.page.locator('option[value="JPY"]') });
  readonly strategyFilterSelect = this.page
    .locator('select')
    .filter({ has: this.page.locator('option[value="BANK_SETTLEMENT_RATE"]') });
  readonly resetButton = this.page.getByRole('button', { name: '초기화' });
  readonly searchButton = this.page.getByRole('button', { name: '검색' });
  readonly pageSizeSelect = this.page.locator('select').filter({ has: this.page.locator('option[value="20"]') });
  readonly pageSizeLabel = this.page.getByText('페이지당', { exact: true });
  readonly table = this.page.locator('table');
  /** Khung bọc trực tiếp bảng — so bề rộng bảng với khung. */
  readonly tableContainer = this.table.locator('..');
  readonly dataRows = this.table.locator('tbody tr[role="button"]');
  readonly pagerTotalText = this.page.getByText(/^총 \d+개의 항목 중/);
  readonly emptyStateTitle = this.table.getByText('조건에 맞는 정책이 없습니다', { exact: true });
  readonly emptyStateSubLine = this.table.getByText('조건을 초기화하면 설정된 모든 채널을 볼 수 있습니다.', { exact: true });
  readonly emptyStateBlock = this.table.locator('tbody td[colspan]');

  constructor(page: Page) {
    super(page);
  }

  async open(): Promise<void> {
    await this.reloadingList(() => this.goto('/commerce/payment-method-policies'));
  }

  /** Bảng đã render xong: có ít nhất 1 dòng dữ liệu hoặc empty state. */
  async waitForTableLoaded(): Promise<void> {
    await expect(this.dataRows.first().or(this.emptyStateTitle), 'Policy table must finish loading').toBeVisible();
  }

  /**
   * Chạy 1 thao tác làm danh sách tải lại (mở trang, 검색, 초기화, đổi page size/trang, 목록으로) và chờ ĐÚNG response
   * `GET /payment-method-policies?…` nó gây ra — chỉ chờ "có dòng" sẽ trả về ngay trên các dòng CŨ còn trên màn hình.
   */
  async reloadingList(action: () => Promise<unknown>): Promise<void> {
    // Timeout ngắn + bỏ qua: 검색 lại đúng bộ filter cũ có thể không gọi API mới — khi đó bảng hiện tại đã là kết quả đúng.
    const listResponse = this.page
      .waitForResponse(
        (response) => response.request().method() === 'GET' && /\/api\/v1\/payment-method-policies\?/.test(response.url()),
        { timeout: 10_000 },
      )
      .catch(() => null);
    await action();
    await listResponse;
    await this.waitForTableLoaded();
  }

  /**
   * Đang ở trang 1: có nút trang thì nút active là "1"; khi mọi dòng vừa 1 trang, pager ẩn các nút trang và chỉ còn dòng
   * "총 {n}개의 항목 중 1-{n}개 표시" (quan sát 28/09).
   */
  async isOnFirstPage(): Promise<boolean> {
    if ((await this.activePageItem.count()) > 0) return /^1/.test(((await this.activePageItem.textContent()) ?? '').trim());
    return / 1-\d+개 표시$/.test(((await this.pagerTotalText.textContent()) ?? '').trim());
  }

  filterLabel(text: string): Locator {
    return this.page.locator('label', { hasText: new RegExp(`^${text}$`) });
  }

  columnHeader(name: string): Locator {
    return this.table.getByRole('columnheader', { name, exact: true });
  }

  rowByKey(pg: string, method: string, currency: string): Locator {
    const exact = (s: string) => new RegExp(`^${s}$`);
    return this.dataRows
      .filter({ has: this.page.locator('td:nth-child(1)', { hasText: exact(pg) }) })
      .filter({ has: this.page.locator('td:nth-child(2)', { hasText: exact(method) }) })
      .filter({ has: this.page.locator('td:nth-child(3)', { hasText: exact(currency) }) });
  }

  /** Link 변경 이력 trong ô 작업 của 1 dòng (span role=button, không lộ qua getByRole — xem mô tả class). */
  historyLinkInRow(row: Locator): Locator {
    return row.locator('td:last-child [role="button"]', { hasText: '변경 이력' });
  }

  /** Link 회수 (Withdraw) trong ô 작업 — chỉ có khi dòng đang có request chờ duyệt của chính mình. */
  withdrawLinkInRow(row: Locator): Locator {
    return row.locator('td:last-child [role="button"]', { hasText: /^회수$/ });
  }

  /** Mọi phần tử bấm được trong ô 작업. */
  actionItemsInRow(row: Locator): Locator {
    return row.locator('td:last-child [role="button"], td:last-child button, td:last-child a');
  }

  /** Pill trạng thái cạnh 환율 적용 방식 (승인 대기 / ⏱ 회수됨 / ⏱ 반려됨) — `title` mang chi tiết ai/khi nào/giá trị. */
  statusPill(row: Locator, text: '승인 대기' | '⏱ 회수됨' | '⏱ 반려됨'): Locator {
    return row.locator('td:nth-child(4) span[title]', { hasText: text });
  }

  readonly withdrawDialog = this.page.getByRole('dialog').filter({ hasText: '이 요청을 회수할까요?' });
  readonly withdrawDialogConfirmButton = this.withdrawDialog.getByRole('button', { name: /^[^가-힣A-Za-z]*회수[^가-힣A-Za-z]*$/ });
  readonly withdrawnToast = this.page.getByText('회수되었습니다 — 새 버전이 생성되지 않았고 기존 값이 그대로 유지됩니다', { exact: true });

  /** Ô `nth` (1-based) của mọi dòng dữ liệu trên trang hiện tại. */
  async columnTexts(nth: number): Promise<string[]> {
    return (await this.dataRows.locator(`td:nth-child(${nth})`).allTextContents()).map((t) => t.trim());
  }

  /** Mục pager theo nhãn ẩn (First/Previous/Next/Last) hoặc số trang. */
  pagerItem(name: string): Locator {
    return this.page.locator('ul.pagination li.page-item', { hasText: name });
  }

  readonly activePageItem = this.page.locator('ul.pagination li.page-item.active');

  async fillFilters(filters: ChannelKeyFilter): Promise<void> {
    if (filters.pg !== undefined) await this.pgFilterSelect.selectOption(filters.pg);
    if (filters.method !== undefined) await this.methodFilterSelect.selectOption(filters.method);
    if (filters.currency !== undefined) await this.currencyFilterSelect.selectOption(filters.currency);
    if (filters.strategy !== undefined) await this.strategyFilterSelect.selectOption(filters.strategy);
  }

  async clickSearch(): Promise<void> {
    await this.reloadingList(() => this.click(this.searchButton, '검색 (Search) button'));
  }

  async clickReset(): Promise<void> {
    await this.reloadingList(() => this.click(this.resetButton, '초기화 (Reset) button'));
  }

  /** Lọc đúng 1 channel key rồi tìm — không phụ thuộc phân trang. */
  async searchKey(pg: string, method: string, currency: string): Promise<Locator> {
    await this.fillFilters({ pg, method, currency });
    await this.clickSearch();
    return this.rowByKey(pg, method, currency);
  }

  async setPageSize(value: string): Promise<void> {
    await this.reloadingList(() => this.pageSizeSelect.selectOption(value));
  }

  async goToPage(name: 'First' | 'Previous' | 'Next' | 'Last'): Promise<void> {
    await this.reloadingList(() => this.click(this.pagerItem(name).locator('a'), `${name} page button`));
  }

  async openCreateForm(): Promise<void> {
    await this.click(this.addPolicyButton, '정책 추가 (Add policy) button');
  }

  async openRow(pg: string, method: string, currency: string): Promise<void> {
    await this.click(this.rowByKey(pg, method, currency).locator('td:first-child'), `row ${pg} · ${method} · ${currency}`);
  }
}
