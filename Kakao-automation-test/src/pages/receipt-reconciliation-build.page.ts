import { Locator, Page, expect } from '@playwright/test';
import { BasePage } from '@pages/base.page';
import { RECEIPT_RECONCILIATION_PATH } from '@pages/receipt-reconciliation-list.page';

/**
 * US020 — màn 대사 묶음 만들기 (Build group) `/build-group?period=yyyy-MM`. Locator verify bằng MCP trên dev 30/09:
 * id do màn gắn (`sel_bg_partner` value = bizPartnerId, `tbl_bg_receipts`, `btn_bg_create`…).
 * Phiếu không chọn được hiện lý do (VD `입고 완료 확인 대기`) ở ô checkbox thay cho checkbox.
 */
export class ReceiptReconciliationBuildPage extends BasePage {
  readonly backButton: Locator;
  readonly partnerSelect: Locator;
  readonly periodSelect: Locator;
  readonly searchButton: Locator;
  readonly receiptsHeading: Locator;
  readonly documentsHeading: Locator;
  readonly receiptTable: Locator;
  readonly receiptHeaders: Locator;
  readonly documentTable: Locator;
  readonly cancelButton: Locator;
  readonly createButton: Locator;
  readonly requiredMessage: Locator;

  constructor(page: Page) {
    super(page);
    this.backButton = page.locator('#btn_bg_back');
    this.partnerSelect = page.locator('#sel_bg_partner');
    this.periodSelect = page.locator('#sel_bg_period');
    this.searchButton = page.locator('#btn_bg_search');
    this.receiptsHeading = page.getByRole('heading', { name: '미대사 입고 전표', exact: true });
    this.documentsHeading = page.getByRole('heading', { name: '미대사 증빙', exact: true });
    this.receiptTable = page.locator('#tbl_bg_receipts');
    this.receiptHeaders = this.receiptTable.getByRole('columnheader');
    this.documentTable = page.locator('#tbl_bg_docs');
    this.cancelButton = page.locator('#btn_bg_cancel');
    this.createButton = page.locator('#btn_bg_create');
    this.requiredMessage = page.locator('#msg_bg_required');
  }

  async open(period: string): Promise<void> {
    await this.goto(`${RECEIPT_RECONCILIATION_PATH}/build-group?period=${period}`);
    await this.waitLoaded();
  }

  async waitLoaded(): Promise<void> {
    await expect(this.receiptTable, 'The build screen renders its receipt table').toBeVisible();
    await expect(this.partnerSelect.locator('option').first(), 'The biz-partner list is loaded').toBeAttached();
  }

  async periodOptions(): Promise<string[]> {
    return this.periodSelect.locator('option').allTextContents();
  }

  /** Chọn đối tác (theo bizPartnerId) + kỳ rồi 검색, chờ bảng phiếu nhập tải lại. */
  async pick(bizPartnerId: number, period: string): Promise<void> {
    await this.partnerSelect.selectOption(String(bizPartnerId));
    await this.periodSelect.selectOption(period);
    const reloaded = this.page.waitForResponse((r) => r.url().includes(`build-candidates/receipts?period=${period}&bizPartnerId=${bizPartnerId}`));
    await this.click(this.searchButton, '검색 (Search) button of the build screen');
    expect((await reloaded).ok(), 'The receipt candidates of the picked partner are loaded').toBe(true);
    await expect(this.receiptTable.locator('tbody tr').first(), 'The receipt table is reloaded').toBeVisible();
  }

  /** Dòng phiếu nhập theo 입고 번호. */
  receiptRow(grnNo: string): Locator {
    return this.receiptTable.getByRole('row').filter({ has: this.page.getByRole('cell', { name: grnNo, exact: true }) });
  }

  /** Dòng phiếu nhập theo ngày nhập + lý do không chọn được (dòng không có 입고 번호, VD Incoming chưa có goods receipt). */
  receiptRowByReason(reason: string): Locator {
    return this.receiptTable.locator('tbody tr').filter({ hasText: reason });
  }

  /** Ô đầu dòng (checkbox hoặc lý do không chọn được). */
  checkCell(row: Locator): Locator {
    return row.getByRole('cell').first();
  }

  /** Giá trị ô theo tên cột của bảng phiếu nhập. */
  async receiptCell(row: Locator, column: string): Promise<string> {
    const headers = (await this.receiptHeaders.allTextContents()).map((text) => text.trim());
    return (await row.getByRole('cell').nth(headers.indexOf(column)).innerText()).trim();
  }

  async tickReceipt(grnNo: string): Promise<void> {
    await this.click(this.receiptRow(grnNo).getByRole('checkbox'), `checkbox of receipt ${grnNo}`);
  }

  async create(): Promise<void> {
    await this.click(this.createButton, '대사 묶음 생성 (Create group) button');
  }
}
