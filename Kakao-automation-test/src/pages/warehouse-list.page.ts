import { Page, Locator, expect, test } from '@playwright/test';
import { BasePage } from './base.page';

/** Tên accessible của nút mang icon font (glyph private-use trước/sau chữ) — khớp đúng chữ, bỏ qua glyph. */
export const buttonText = (text: string) => new RegExp(`^[^가-힣A-Za-z]*${text}[^가-힣A-Za-z]*$`);

/** Regex khớp nguyên văn toàn bộ chuỗi (escape ký tự đặc biệt). */
export const exactText = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

/** Độ dài tối đa tên hiển thị ở cột 창고명 trước khi bị cắt "…" (verify 29/09). */
const NAME_DISPLAY_LIMIT = 40;

export interface WarehouseListCriteria {
  keyword?: string;
  bizPartner?: string;
  type?: string;
  status?: string;
}

/**
 * Màn 창고 관리 › 창고 목록 (US069) — `/commerce/warehouses`, menu nằm trong nhóm sidebar **FPT**.
 * Link sidebar dùng chung href giả (điều hướng bằng JS) — phải bấm menu, không có URL riêng trên link.
 * Label filter KHÔNG gắn `for` với control — control được neo theo label cùng khung `div` cha trực tiếp.
 * Tìm kiếm / filter chỉ áp dụng khi bấm 검색 (hoặc Enter) — trạng thái lọc nằm trên URL (keyword, bizPartnerId, type,
 * status, page, size). List sắp theo ID tăng dần — warehouse mới nằm ở trang cuối (verify 28/09).
 */
export class WarehouseListPage extends BasePage {
  readonly sidebarFptGroup = this.page.getByRole('link', { name: 'FPT' });
  readonly sidebarWarehouseMenu = this.page.getByRole('link', { name: '창고 관리', exact: true });

  readonly panelTitle = this.page.getByText('창고 목록', { exact: true });
  readonly addWarehouseButton = this.page.getByRole('button', { name: buttonText('창고 등록') });
  readonly searchByNameLabel = this.filterLabel('창고명 검색');
  readonly searchByNameInput = this.page.getByPlaceholder('예: 인천', { exact: true });
  readonly bizPartnerLabel = this.filterLabel('거래처');
  readonly bizPartnerSelect = this.filterControl('거래처', 'select');
  readonly typeLabel = this.filterLabel('유형');
  readonly typeSelect = this.filterControl('유형', 'select');
  readonly statusLabel = this.filterLabel('상태');
  readonly statusSelect = this.filterControl('상태', 'select');
  readonly resetButton = this.page.getByRole('button', { name: buttonText('초기화') });
  readonly searchButton = this.page.getByRole('button', { name: buttonText('검색') });

  readonly table = this.page.locator('table');
  readonly tableRows = this.table.locator('tbody tr[role="button"]');
  readonly loadingIndicator = this.page.getByText('불러오는 중...');
  readonly noResultsTitle = this.page.getByRole('heading', { name: '필터 조건에 맞는 결과가 없습니다' });
  readonly noResultsHint = this.page.getByText('필터를 초기화해 보세요.', { exact: true });
  readonly emptyTitle = this.page.getByRole('heading', { name: '등록된 창고가 없습니다' });
  readonly pagerTotalText = this.page.getByText(/^총 \d+개의 항목 중 \d+-\d+개 표시$/);
  readonly pageSizeSelect = this.page
    .locator('div')
    .filter({ has: this.page.locator(':scope > span', { hasText: /^페이지당$/ }) })
    .locator('select');
  readonly pagination = this.page.locator('ul.pagination');
  readonly activePageItem = this.pagination.locator('li.page-item.active');

  constructor(page: Page) {
    super(page);
  }

  /** Mở màn qua menu sidebar FPT › 창고 관리 (đúng pre-condition "ADMIN opens menu 창고 관리"). */
  async openFromSidebar(): Promise<void> {
    await this.goto('/');
    await this.click(this.sidebarFptGroup, 'FPT group in the sidebar');
    await this.click(this.sidebarWarehouseMenu, '창고 관리 (Warehouse management) menu in the sidebar');
    await expect(this.page).toHaveURL(/\/commerce\/warehouses$/);
    await this.waitForListLoaded();
  }

  /** Mở thẳng URL list, tuỳ chọn kèm query (keyword, status, page, size…). */
  async open(query: Record<string, string> = {}): Promise<void> {
    const search = new URLSearchParams(query).toString();
    await this.goto(`/commerce/warehouses${search ? `?${search}` : ''}`);
    await this.waitForListLoaded();
  }

  /** List đã tải xong: hết "불러오는 중..." và đang hiện dòng dữ liệu hoặc trạng thái không có kết quả. */
  async waitForListLoaded(): Promise<void> {
    await expect(this.loadingIndicator, 'Warehouse list must finish loading').toHaveCount(0, { timeout: 30_000 });
    await expect(this.tableRows.first().or(this.noResultsTitle).or(this.emptyTitle), 'Warehouse list must show rows or an empty state').toBeVisible();
  }

  /** Chạy `action` rồi chờ đúng lượt GET list mà nó kích hoạt trả về và list vẽ xong. */
  async reloadingList(action: () => Promise<void>): Promise<void> {
    const listLoaded = this.page.waitForResponse((r) => /\/api\/v1\/warehouses\?/.test(r.url()) && r.request().method() === 'GET');
    await action();
    await listLoaded;
    await this.waitForListLoaded();
  }

  /** Điền các điều kiện rồi bấm 검색 — điều kiện không truyền giữ nguyên giá trị đang chọn. */
  async search(criteria: WarehouseListCriteria): Promise<void> {
    await test.step(`Search the warehouse list by ${JSON.stringify(criteria)}`, async () => {
      if (criteria.keyword !== undefined) await this.searchByNameInput.fill(criteria.keyword);
      if (criteria.bizPartner !== undefined) await this.bizPartnerSelect.selectOption({ label: criteria.bizPartner });
      if (criteria.type !== undefined) await this.typeSelect.selectOption({ label: criteria.type });
      if (criteria.status !== undefined) await this.statusSelect.selectOption({ label: criteria.status });
      await this.reloadingList(() => this.searchButton.click());
    });
  }

  async reset(): Promise<void> {
    await this.reloadingList(() => this.click(this.resetButton, '초기화 (Reset) button'));
  }

  async setPageSize(value: string): Promise<void> {
    await this.reloadingList(async () => {
      await this.pageSizeSelect.selectOption(value);
    });
  }

  /** Nút phân trang theo nhãn: số trang, hoặc `First` / `Previous` / `Next` / `Last` (chữ visually-hidden). */
  pagerItem(label: string): Locator {
    return this.pagination.locator('li.page-item').filter({ hasText: new RegExp(`^\\D*${label}\\s*(\\(current\\))?$`) });
  }

  async goToPage(label: string): Promise<void> {
    await this.reloadingList(() => this.pagerItem(label).locator('a').click());
  }

  columnHeader(name: string): Locator {
    return this.table.getByRole('columnheader', { name, exact: true });
  }

  /**
   * Tên như list hiển thị: tên dài hơn 40 ký tự bị cắt thành 40 ký tự đầu + "…", bản đầy đủ chỉ có trong tooltip khi hover
   * (component cắt chữ của app, `maxLength` mặc định 40 — verify 29/09).
   */
  static displayName(name: string): string {
    return name.length > NAME_DISPLAY_LIMIT ? `${name.slice(0, NAME_DISPLAY_LIMIT)}…` : name;
  }

  /**
   * Dòng có ô 창고명 đúng bằng `name` (ô tên còn có thể mang badge System (virtual)). Tên bị cắt thì kho cha và 5 bucket
   * chung phần hiển thị → phân biệt bằng badge: mặc định lấy dòng KHÔNG phải bucket, `{ virtual: true }` lấy bucket.
   */
  rowByName(name: string, options: { virtual?: boolean } = {}): Locator {
    const rows = this.tableRows.filter({ has: this.page.locator('td span.text-primary', { hasText: exactText(WarehouseListPage.displayName(name)) }) });
    if (name.length <= NAME_DISPLAY_LIMIT) return rows;
    const badge = this.page.locator('span.badge', { hasText: 'System (virtual)' });
    return options.virtual ? rows.filter({ has: badge }) : rows.filter({ hasNot: badge });
  }

  /** Tên ĐẦY ĐỦ ở cột 창고명 của trang hiện tại — tên bị cắt "…" được đọc từ tooltip khi hover (cách người dùng xem tên dài). */
  async fullNames(): Promise<string[]> {
    const spans = this.tableRows.locator('td span.text-primary');
    const names: string[] = [];
    for (let i = 0; i < (await spans.count()); i++) {
      const shown = ((await spans.nth(i).textContent()) ?? '').trim();
      if (!shown.endsWith('…')) {
        names.push(shown);
        continue;
      }
      await spans.nth(i).hover();
      const tooltip = this.page.getByRole('tooltip');
      await expect(tooltip, `The full name of "${shown}" is shown on hover`).toBeVisible();
      names.push(((await tooltip.textContent()) ?? '').trim());
      await this.page.mouse.move(0, 0);
      await expect(tooltip, 'The name tooltip closes').toHaveCount(0);
    }
    return names;
  }

  rowById(id: number | string): Locator {
    return this.tableRows.filter({ has: this.page.locator('td:first-child', { hasText: exactText(String(id)) }) });
  }

  virtualBadge(row: Locator): Locator {
    return row.locator('span.badge', { hasText: 'System (virtual)' });
  }

  /** Ô của `row` thuộc cột `column` — vị trí cột lấy từ header thật. */
  async cell(row: Locator, column: string): Promise<Locator> {
    const index = await this.columnIndex(column);
    return row.locator(`td:nth-child(${index + 1})`);
  }

  /** Text của mọi ô thuộc cột `name` trên trang hiện tại. */
  async columnValues(name: string): Promise<string[]> {
    const index = await this.columnIndex(name);
    const cells = await this.tableRows.locator(`td:nth-child(${index + 1})`).allTextContents();
    return cells.map((c) => c.trim());
  }

  /** Mọi dòng trên trang hiện tại dạng { tên cột → text ô }; ô 창고명 chỉ lấy tên (bỏ badge). */
  async readRows(): Promise<Array<Record<string, string>>> {
    const headers = (await this.table.locator('thead th').allTextContents()).map((h) => h.trim());
    return this.tableRows.evaluateAll(
      (rows, cols) =>
        rows.map((row) =>
          Object.fromEntries(
            Array.from((row as HTMLTableRowElement).cells).map((cell, i) => [
              cols[i],
              (cell.querySelector('span.text-primary')?.textContent ?? cell.textContent ?? '').trim(),
            ]),
          ),
        ),
      headers,
    );
  }

  /** Option của selector 페이지당 theo giá trị số (nhãn hiển thị là `10개`, value là `10`). */
  pageSizeOption(value: string): Locator {
    return this.pageSizeSelect.locator(`option[value="${value}"]`);
  }

  private async columnIndex(name: string): Promise<number> {
    const headers = (await this.table.locator('thead th').allTextContents()).map((h) => h.trim());
    const index = headers.indexOf(name);
    if (index < 0) throw new Error(`Column "${name}" not found in the warehouse table — headers: ${headers.join(', ')}`);
    return index;
  }

  private filterLabel(text: string): Locator {
    return this.page.locator('label', { hasText: new RegExp(`^${text}$`) });
  }

  private filterControl(label: string, control: string): Locator {
    return this.page
      .locator('div')
      .filter({ has: this.page.locator(':scope > label', { hasText: new RegExp(`^${label}$`) }) })
      .locator(control);
  }
}
