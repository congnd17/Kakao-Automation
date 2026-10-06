import { Locator, Page, test } from '@playwright/test';
import { BasePage } from '@pages/base.page';
import { PO_KO } from '@utils/purchase-order.i18n';

export const PO_LIST_PATH = '/commerce/purchase-orders';

/** 10 cột bảng 발주 목록 theo thứ tự (DOM verify 05/10). */
export const LIST_COLUMNS = [
  PO_KO['col.poList.poNo'],
  PO_KO['col.poList.status'],
  PO_KO['col.poList.supplier'],
  PO_KO['col.poList.destination'],
  PO_KO['col.poList.orderDate'],
  PO_KO['col.poList.expectedDate'],
  PO_KO['col.poList.lineCount'],
  PO_KO['col.poList.poAmount'],
  PO_KO['col.poList.receivedProgress'],
  PO_KO['col.poList.createdBy'],
] as const;

export const QUICK_RANGES = [
  PO_KO['text.quickToday'],
  PO_KO['text.quick1Week'],
  PO_KO['text.quick1Month'],
  PO_KO['text.quick3Months'],
  PO_KO['text.quick6Months'],
  PO_KO['text.quick1Year'],
] as const;

/**
 * Màn 발주 관리 — list (US105). Mỗi field filter là `label.form-label` + control ngay sau nó (không có id / testid,
 * DOM verify 05/10) → locator theo nhãn hiển thị.
 */
export class PurchaseOrderListPage extends BasePage {
  readonly heading: Locator;
  readonly createButton: Locator;
  readonly excelButton: Locator;
  readonly searchTypeSelect: Locator;
  readonly keywordInput: Locator;
  readonly statusSelect: Locator;
  readonly warehouseSelect: Locator;
  readonly ownerSelect: Locator;
  readonly saleTypeSelect: Locator;
  readonly periodTypeSelect: Locator;
  readonly periodFromInput: Locator;
  readonly periodToInput: Locator;
  readonly resetButton: Locator;
  readonly searchButton: Locator;
  readonly table: Locator;
  readonly rows: Locator;
  readonly noRowsMessage: Locator;
  readonly pagerSummary: Locator;
  readonly pageSizeSelect: Locator;
  readonly pager: Locator;

  constructor(page: Page) {
    super(page);
    this.heading = page.getByRole('heading', { level: 4, name: '발주 관리' });
    this.createButton = page.getByRole('button', { name: PO_KO['text.createPo'], exact: true });
    this.excelButton = page.getByRole('button', { name: PO_KO['text.excelDownload'], exact: true });
    this.searchTypeSelect = this.field(PO_KO['text.searchByLabel']);
    this.keywordInput = this.field(PO_KO['text.keywordLabel']);
    this.statusSelect = this.field(PO_KO['text.statusLabel']);
    this.warehouseSelect = this.field(PO_KO['text.warehouseLabel']);
    this.ownerSelect = this.field(PO_KO['text.ownershipLabel']);
    this.saleTypeSelect = this.field(PO_KO['text.saleTypeLabel']);
    this.periodTypeSelect = this.field(PO_KO['text.periodTypeLabel']);
    const period = this.field(PO_KO['text.periodLabel']);
    this.periodFromInput = period.getByPlaceholder(PO_KO['text.datePlaceholder']).first();
    this.periodToInput = period.getByPlaceholder(PO_KO['text.datePlaceholder']).nth(1);
    this.resetButton = page.getByRole('button', { name: PO_KO['text.reset'], exact: true });
    this.searchButton = page.getByRole('button', { name: PO_KO['text.search'], exact: true });
    this.table = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: PO_KO['col.poList.poNo'], exact: true }) });
    this.rows = this.table.locator('tbody tr');
    this.noRowsMessage = page.locator('.alert').filter({ hasText: PO_KO['text.noRows'] });
    this.pagerSummary = page.getByText(/^총 .+개의 항목 중 .+개 표시$/);
    this.pageSizeSelect = page.locator('select').filter({ has: page.locator('option', { hasText: '100개' }) });
    this.pager = page.getByRole('list').filter({ has: page.getByRole('button', { name: 'Last' }) });
  }

  /** Control ngay sau `label.form-label` có đúng text `label`. */
  field(label: string): Locator {
    return this.page.locator('label.form-label').filter({ hasText: new RegExp(`^${escapeRegExp(label)}$`) }).locator('xpath=following-sibling::*[1]');
  }

  columnHeader(name: string): Locator {
    return this.table.getByRole('columnheader', { name, exact: true });
  }

  quickRange(name: string): Locator {
    return this.page.getByRole('button', { name, exact: true });
  }

  pageButton(name: string): Locator {
    return this.pager.getByRole('button', { name, exact: true });
  }

  rowByPoNo(poNo: string): Locator {
    return this.rows.filter({ has: this.page.getByRole('button', { name: poNo, exact: true }) });
  }

  cell(row: Locator, column: (typeof LIST_COLUMNS)[number]): Locator {
    return row.locator('td').nth(LIST_COLUMNS.indexOf(column));
  }

  async open(query = ''): Promise<void> {
    await test.step('Open 발주 관리 (Purchase order management)', async () => {
      await this.page.goto(`${PO_LIST_PATH}${query}`);
      await this.heading.waitFor();
      await this.waitForRows();
    });
  }

  /** Bảng đã vẽ xong (có dòng dữ liệu hoặc thông báo không có kết quả). */
  async waitForRows(): Promise<void> {
    await this.rows.first().or(this.noRowsMessage).waitFor();
  }

  /** Chờ đúng request list kế tiếp — dùng khi thao tác có làm chạy lại query. */
  waitForListRequest(): Promise<unknown> {
    return this.page.waitForResponse((response) => /\/api\/v1\/purchase-orders\?/.test(response.url()) && response.request().method() === 'GET');
  }

  async search(): Promise<void> {
    await test.step('Click 검색 (Search)', async () => {
      const response = this.waitForListRequest();
      await this.searchButton.click();
      await response;
      await this.waitForRows();
    });
  }

  async searchBy(type: string, keyword: string): Promise<void> {
    await test.step(`Search by ${type} "${keyword}"`, async () => {
      await this.searchTypeSelect.selectOption({ label: type });
      await this.keywordInput.fill(keyword);
      await this.search();
    });
  }

  async openPo(poNo: string): Promise<void> {
    await test.step(`Open PO ${poNo}`, async () => {
      await this.page.getByRole('button', { name: poNo, exact: true }).click();
      await this.page.waitForURL(/\/commerce\/purchase-orders\/\d+/);
    });
  }

  /** Text của mọi ô trong cột `column` trên trang hiện tại. */
  async columnTexts(column: (typeof LIST_COLUMNS)[number]): Promise<string[]> {
    const index = LIST_COLUMNS.indexOf(column);
    return this.rows.locator(`td:nth-child(${index + 1})`).allInnerTexts();
  }

  async optionLabels(select: Locator): Promise<string[]> {
    return (await select.locator('option').allInnerTexts()).map((text) => text.trim());
  }
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
