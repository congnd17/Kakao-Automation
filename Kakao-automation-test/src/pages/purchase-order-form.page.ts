import { Locator, Page, test } from '@playwright/test';
import { BasePage } from '@pages/base.page';
import { escapeRegExp, PO_LIST_PATH } from '@pages/purchase-order-list.page';
import { PO_KO } from '@utils/purchase-order.i18n';

/** Cột bảng 발주 품목 theo thứ tự (DOM verify 05/10) — cột cuối là nút 품목 삭제, không có tiêu đề. */
export const LINE_COLUMNS = [
  PO_KO['col.poLine.no'],
  PO_KO['col.poLine.sku'],
  PO_KO['col.poLine.barcode'],
  PO_KO['col.poLine.owner'],
  PO_KO['col.poLine.saleType'],
  PO_KO['col.poLine.orderedQty'],
  PO_KO['col.poLine.unitPrice'],
  PO_KO['col.poLine.lineAmount'],
  PO_KO['col.poLine.receivedQty'],
] as const;

/** Cột bảng 입고 이력 — cột cuối là link thao tác (차이 처리), không có tiêu đề. */
export const GRN_COLUMNS = [
  PO_KO['col.grnList.grnNo'],
  PO_KO['col.grnList.status'],
  PO_KO['col.grnList.receivedDate'],
  PO_KO['col.grnList.receivedQty'],
  PO_KO['col.grnList.damagedQty'],
  PO_KO['col.grnList.missingQty'],
  PO_KO['col.grnList.reason'],
] as const;

/** Control ngay sau `label.form-label` có đúng text `label`, trong phạm vi `scope`. */
function labeled(scope: Page | Locator, label: string): Locator {
  return scope.locator('label.form-label').filter({ hasText: new RegExp(`^${escapeRegExp(label)}\\s*\\*?`) }).locator('xpath=following-sibling::*[1]');
}

/**
 * Dialog dùng chung của US105 (React-Bootstrap modal `.modal.show`). Title đọc ở `.modal-title`; field theo nhãn.
 */
export class PoDialog {
  readonly root: Locator;
  readonly title: Locator;
  readonly closeIcon: Locator;

  constructor(
    protected readonly page: Page,
    root?: Locator,
  ) {
    this.root = root ?? page.locator('.modal.show').last();
    this.title = this.root.locator('.modal-title');
    this.closeIcon = this.root.getByRole('button', { name: 'Close' });
  }

  field(label: string): Locator {
    return labeled(this.root, label);
  }

  button(name: string): Locator {
    return this.root.locator('.modal-footer').getByRole('button', { name, exact: true });
  }

  /** Message lỗi đỏ trong dialog (validate client hoặc lỗi server). */
  errors(): Locator {
    return this.root.locator('.text-danger, .alert-danger, .invalid-feedback').filter({ hasText: /\S/ });
  }

  async waitOpen(): Promise<void> {
    await this.root.waitFor();
  }
}

/** Dialog 입고 검수 (Receive goods) — 1 dòng cho mỗi dòng PO còn tồn đọng. */
export class ReceiveDialog extends PoDialog {
  readonly poNoBadge: Locator;
  readonly receivedDate: Locator;
  readonly table: Locator;
  readonly calcPanel: Locator;
  readonly reasonSelect: Locator;
  readonly detailReasonInput: Locator;
  readonly attachLabel: Locator;
  readonly fileInput: Locator;
  readonly uploadButton: Locator;
  readonly saveButton: Locator;
  readonly cancelButton: Locator;

  constructor(page: Page) {
    super(page);
    this.poNoBadge = this.title.locator('.badge');
    this.receivedDate = this.field(PO_KO['text.receivedDateLabel']).locator('input');
    this.table = this.root.getByRole('table');
    this.calcPanel = this.root.locator('.border.rounded').filter({ hasText: PO_KO['text.calcPurchaseAmount'] });
    this.reasonSelect = this.field(PO_KO['text.discrepancyReasonLabel']);
    this.detailReasonInput = this.field(PO_KO['text.detailReasonLabel']);
    this.attachLabel = this.root.locator('label.form-label').filter({ hasText: PO_KO['text.attachLabel'] });
    this.fileInput = this.root.locator('input[type=file]');
    this.uploadButton = this.root.getByRole('button', { name: '파일 업로드' });
    this.saveButton = this.button(PO_KO['text.save']);
    this.cancelButton = this.button(PO_KO['text.cancel']);
  }

  receivedQty(line = 0): Locator {
    return this.table.locator('tbody tr').nth(line).locator('td').nth(2).locator('input');
  }

  damagedQty(line = 0): Locator {
    return this.table.locator('tbody tr').nth(line).locator('td').nth(3).locator('input');
  }

  lineCell(line: number, column: number): Locator {
    return this.table.locator('tbody tr').nth(line).locator('td').nth(column);
  }

  /** Giá trị của 1 ô trong panel tính toán theo nhãn (발주 / 입고 완료 / 파손 / 가용재고 / 불량 창고 / 차이 / 매입금액). */
  calcValue(label: string): Locator {
    return this.calcPanel.locator('div.d-flex.flex-column').filter({ has: this.page.locator('span', { hasText: new RegExp(`^${escapeRegExp(label)}$`) }) }).locator('span').nth(1);
  }

  async fillQuantities(received: number | string, damaged?: number | string, line = 0): Promise<void> {
    await test.step(`Enter 입고완료수량 ${received}${damaged === undefined ? '' : ` and 파손 수량 ${damaged}`}`, async () => {
      await this.receivedQty(line).fill(String(received));
      if (damaged !== undefined) await this.damagedQty(line).fill(String(damaged));
    });
  }

  /** Chọn file rồi bấm 파일 업로드 — chờ đến khi upload trả về. */
  async attach(name: string, content: Buffer, mimeType = 'application/pdf'): Promise<void> {
    await test.step(`Attach delivery document ${name}`, async () => {
      await this.fileInput.setInputFiles({ name, mimeType, buffer: content });
      const upload = this.page.waitForResponse((r) => r.url().includes('/attach-files/upload'));
      await this.uploadButton.click();
      await upload;
    });
  }
}

/** Dialog 입고 차이 처리 (discrepancy / resolve). */
export class ResolveDialog extends PoDialog {
  readonly statusBadge: Locator;
  readonly table: Locator;
  readonly reasonSelect: Locator;
  readonly noteInput: Locator;
  readonly historyButton: Locator;
  readonly editButton: Locator;
  readonly cancelButton: Locator;
  readonly rejectButton: Locator;
  readonly approveButton: Locator;

  constructor(page: Page) {
    super(page);
    this.statusBadge = this.title.locator('.badge');
    this.table = this.root.getByRole('table');
    this.reasonSelect = this.field(PO_KO['text.resolutionReasonLabel']);
    this.noteInput = this.field(PO_KO['text.noteLabel']);
    this.historyButton = this.button(PO_KO['text.grnChangeHistory']);
    this.editButton = this.button(PO_KO['text.grnEdit']);
    this.cancelButton = this.button(PO_KO['text.cancel']);
    this.rejectButton = this.button(PO_KO['text.grnReject']);
    this.approveButton = this.button(PO_KO['text.approveDiscrepancy']);
  }
}

/** Dialog lý do dùng chung — 3 caller: 발주 취소 / 발주 종결 / 입고 반려. */
export class ReasonDialog extends PoDialog {
  readonly reasonCodeSelect: Locator;
  readonly reasonInput: Locator;
  readonly warning: Locator;
  readonly confirmButton: Locator;
  readonly cancelButton: Locator;

  constructor(page: Page) {
    super(page);
    this.reasonCodeSelect = this.field(PO_KO['text.reasonCodeLabel']);
    this.reasonInput = this.field(PO_KO['text.reasonLabel']);
    this.warning = this.root.locator('.alert-warning');
    this.confirmButton = this.button(PO_KO['text.confirm']);
    this.cancelButton = this.button(PO_KO['text.cancel']);
  }
}

/** Dialog 변경 이력 (PO hoặc receipt). */
export class HistoryDialog extends PoDialog {
  readonly table: Locator;
  readonly rows: Locator;
  readonly closeButton: Locator;

  constructor(page: Page) {
    super(page);
    this.table = this.root.getByRole('table');
    this.rows = this.table.locator('tbody tr');
    this.closeButton = this.button(PO_KO['text.closeHistory']);
  }

  headers(): Promise<string[]> {
    return this.table.locator('thead th').allInnerTexts();
  }
}

/**
 * Form PO (tạo mới / chi tiết) — header card mang badge trạng thái, nút điều hướng, 엑셀 / 변경 이력 và action row;
 * block 발주 기본 정보, bảng 발주 품목, bảng 입고 이력 (từ Issued). DOM verify 05/10.
 */
export class PurchaseOrderFormPage extends BasePage {
  readonly header: Locator;
  readonly statusBadge: Locator;
  readonly actionRow: Locator;
  readonly backToListButton: Locator;
  readonly excelButton: Locator;
  readonly historyButton: Locator;
  readonly saveDraftButton: Locator;
  readonly issueButton: Locator;
  readonly deleteButton: Locator;
  readonly receiveButton: Locator;
  readonly cancelPoButton: Locator;
  readonly closePoButton: Locator;
  readonly poNoInput: Locator;
  readonly supplierTypeSelect: Locator;
  readonly supplierSelect: Locator;
  readonly manufacturerSelect: Locator;
  readonly orderDateInput: Locator;
  readonly expectedDateInput: Locator;
  readonly destinationSelect: Locator;
  readonly currencySelect: Locator;
  readonly lineTable: Locator;
  readonly lineRows: Locator;
  readonly emptyLines: Locator;
  readonly totalAmount: Locator;
  readonly addLineButton: Locator;
  readonly grnTable: Locator;
  readonly grnRows: Locator;
  readonly pageAlert: Locator;

  constructor(page: Page) {
    super(page);
    this.header = page.locator('.card-header').filter({ hasText: PO_KO['text.formCardTitle'] });
    this.statusBadge = this.header.locator('.badge');
    this.actionRow = this.header.locator(':scope > div.d-flex.flex-wrap.gap-2');
    this.backToListButton = this.header.getByRole('button', { name: PO_KO['text.backToList'] });
    this.excelButton = this.header.getByRole('button', { name: PO_KO['text.excelDownload'] });
    this.historyButton = this.header.getByRole('button', { name: PO_KO['text.changeHistory'], exact: true });
    this.saveDraftButton = this.header.getByRole('button', { name: PO_KO['text.saveDraft'], exact: true });
    this.issueButton = this.header.getByRole('button', { name: PO_KO['text.issuePo'], exact: true });
    this.deleteButton = this.header.getByRole('button', { name: PO_KO['text.deletePo'], exact: true });
    this.receiveButton = this.header.getByRole('button', { name: PO_KO['text.receiveGoods'], exact: true });
    this.cancelPoButton = this.header.getByRole('button', { name: PO_KO['text.cancelPo'], exact: true });
    this.closePoButton = this.header.getByRole('button', { name: PO_KO['text.closePo'], exact: true });
    this.poNoInput = this.field(PO_KO['text.poNoLabel']);
    this.supplierTypeSelect = this.field(PO_KO['text.supplierTypeLabel']);
    this.supplierSelect = this.field(PO_KO['text.supplierLabel']);
    this.manufacturerSelect = this.field(PO_KO['text.manufacturerLabel']);
    this.orderDateInput = this.dateInput(PO_KO['text.orderDateLabel']);
    this.expectedDateInput = this.dateInput(PO_KO['text.expectedDateLabel']);
    this.destinationSelect = this.field(PO_KO['text.destinationLabel']);
    this.currencySelect = this.field(PO_KO['text.currencyLabel']);
    this.lineTable = page.getByRole('table').filter({ hasText: PO_KO['text.poAmountTotal'] });
    this.lineRows = this.lineTable.locator('tbody tr');
    this.emptyLines = this.lineTable.getByText(PO_KO['text.emptyLines']);
    this.totalAmount = this.lineTable.locator('tr').filter({ hasText: PO_KO['text.poAmountTotal'] }).locator('th').nth(1);
    this.addLineButton = page.getByRole('button', { name: PO_KO['text.addLine'] });
    this.grnTable = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: PO_KO['col.grnList.grnNo'] }) });
    this.grnRows = this.grnTable.locator('tbody tr');
    this.pageAlert = page.locator('.alert-danger').filter({ hasText: /\S/ });
  }

  /** Control (edit mode) hoặc text hiển thị (read-only) ngay sau nhãn field của block 발주 기본 정보. */
  field(label: string): Locator {
    return labeled(this.page, label);
  }

  /** Date input theo nhãn — react-datepicker bọc input trong wrapper. */
  dateInput(label: string): Locator {
    return this.field(label).locator('input');
  }

  async openCreate(): Promise<void> {
    await test.step('Open the Create PO form', async () => {
      await this.page.goto(`${PO_LIST_PATH}/create`);
      await this.header.waitFor();
      await this.supplierSelect.locator('option').nth(1).waitFor({ state: 'attached' });
    });
  }

  async openPo(id: number | string): Promise<void> {
    await test.step(`Open PO detail ${id}`, async () => {
      await this.page.goto(`${PO_LIST_PATH}/${id}`);
      await this.header.waitFor();
      await this.lineTable.waitFor();
    });
  }

  line(index = 0): Locator {
    return this.lineRows.nth(index);
  }

  lineCell(index: number, column: (typeof LINE_COLUMNS)[number]): Locator {
    return this.line(index).locator('td').nth(LINE_COLUMNS.indexOf(column));
  }

  lineSku(index = 0): Locator {
    return this.lineCell(index, PO_KO['col.poLine.sku']).locator('select');
  }

  lineOwner(index = 0): Locator {
    return this.lineCell(index, PO_KO['col.poLine.owner']).locator('select');
  }

  lineSaleType(index = 0): Locator {
    return this.lineCell(index, PO_KO['col.poLine.saleType']).locator('select');
  }

  lineQty(index = 0): Locator {
    return this.lineCell(index, PO_KO['col.poLine.orderedQty']).locator('input');
  }

  linePrice(index = 0): Locator {
    return this.lineCell(index, PO_KO['col.poLine.unitPrice']).locator('input');
  }

  lineAmount(index = 0): Locator {
    return this.lineCell(index, PO_KO['col.poLine.lineAmount']);
  }

  lineRemove(index = 0): Locator {
    return this.line(index).getByRole('button', { name: PO_KO['text.removeLineAria'] });
  }

  /** Message lỗi dưới 1 control của dòng / field. */
  errorUnder(control: Locator): Locator {
    return control.locator('xpath=following-sibling::div[contains(@class,"text-danger")] | ../div[contains(@class,"text-danger")]');
  }

  grnRow(grnNo: string): Locator {
    return this.grnRows.filter({ hasText: grnNo });
  }

  grnAction(grnNo: string): Locator {
    return this.grnRow(grnNo).getByRole('button');
  }

  toast(text: string): Locator {
    return this.page.getByText(text, { exact: false }).first();
  }

  receiveDialog(): ReceiveDialog {
    return new ReceiveDialog(this.page);
  }

  resolveDialog(): ResolveDialog {
    return new ResolveDialog(this.page);
  }

  reasonDialog(): ReasonDialog {
    return new ReasonDialog(this.page);
  }

  historyDialog(): HistoryDialog {
    return new HistoryDialog(this.page);
  }

  confirmDialog(): PoDialog {
    return new PoDialog(this.page);
  }

  async fillBasics(values: { supplierType?: string; supplier?: string; manufacturer?: string; destination?: string; currency?: string; orderDate?: string; expectedDate?: string }): Promise<void> {
    await test.step('Fill the general information block', async () => {
      if (values.supplierType) await this.supplierTypeSelect.selectOption({ label: values.supplierType });
      if (values.supplier) await this.supplierSelect.selectOption({ label: values.supplier });
      if (values.manufacturer) await this.manufacturerSelect.selectOption({ label: values.manufacturer });
      if (values.destination) await this.destinationSelect.selectOption({ label: values.destination });
      if (values.currency) await this.currencySelect.selectOption({ label: values.currency });
      if (values.orderDate !== undefined) await this.setDate(this.dateInput(PO_KO['text.orderDateLabel']), values.orderDate);
      if (values.expectedDate !== undefined) await this.setDate(this.dateInput(PO_KO['text.expectedDateLabel']), values.expectedDate);
    });
  }

  /** Gõ ngày vào react-datepicker rồi Enter — lịch đóng lại, giá trị được commit. */
  async setDate(input: Locator, value: string): Promise<void> {
    await input.click();
    await input.fill(value);
    await input.press('Enter');
  }

  async addLine(values: { sku?: string; owner?: string; saleType?: string; qty?: string | number; price?: string | number } = {}): Promise<number> {
    return test.step('Add a line', async () => {
      const index = await this.lineRows.filter({ has: this.page.locator('select') }).count();
      await this.addLineButton.click();
      await this.fillLine(index, values);
      return index;
    });
  }

  async fillLine(index: number, values: { sku?: string; owner?: string; saleType?: string; qty?: string | number; price?: string | number }): Promise<void> {
    if (values.sku) await this.lineSku(index).selectOption({ label: values.sku });
    if (values.owner) await this.lineOwner(index).selectOption({ label: values.owner });
    if (values.saleType) await this.lineSaleType(index).selectOption({ label: values.saleType });
    if (values.qty !== undefined) await this.lineQty(index).fill(String(values.qty));
    if (values.price !== undefined) await this.linePrice(index).fill(String(values.price));
  }

  /** Bấm 임시저장 và chờ response ghi PO (POST tạo mới / PATCH sửa). */
  async saveDraft() {
    return test.step('Click 임시저장 (Save draft)', async () => {
      const response = this.page.waitForResponse((r) => /\/api\/v1\/purchase-orders(\/\d+)?$/.test(new URL(r.url()).pathname) && ['POST', 'PATCH'].includes(r.request().method()));
      await this.saveDraftButton.click();
      return response;
    });
  }

  /** Chờ response POST tạo receipt kế tiếp (gọi TRƯỚC khi bấm 저장). */
  waitForReceiptSave() {
    return this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/goods-receipts$/.test(new URL(r.url()).pathname));
  }

  async openReceive(): Promise<ReceiveDialog> {
    await this.receiveButton.click();
    const dialog = this.receiveDialog();
    await dialog.waitOpen();
    return dialog;
  }

  async openResolve(grnNo: string): Promise<ResolveDialog> {
    await this.grnAction(grnNo).click();
    const dialog = this.resolveDialog();
    await dialog.waitOpen();
    return dialog;
  }

  async openHistory(): Promise<HistoryDialog> {
    await this.historyButton.click();
    const dialog = this.historyDialog();
    await dialog.waitOpen();
    return dialog;
  }

  /** Tên các nút đang được vẽ trong action row. */
  async actionNames(): Promise<string[]> {
    if ((await this.actionRow.count()) === 0) return [];
    return (await this.actionRow.getByRole('button').allInnerTexts()).map((text) => text.trim());
  }

  async optionLabels(select: Locator): Promise<string[]> {
    return (await select.locator('option').allInnerTexts()).map((text) => text.trim());
  }
}
