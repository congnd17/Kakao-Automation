import { Page, Locator, Response, expect, test } from '@playwright/test';
import { BasePage } from './base.page';
import { FeeKey, CATEGORY, SALE_TYPE, POLICY_LABEL, FEE_TEXT } from '@utils/fee-rate.data';

/** Tên nút có icon font đứng trước — khớp đúng chữ (`회수` KHÔNG khớp marker `회수됨`). */
const buttonText = (text: string) => new RegExp(`^[^가-힣A-Za-z]*${text}[^가-힣A-Za-z]*$`);
const exactText = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

export interface FeeRowPostResult {
  status: number;
  body: { changeApprovalId?: number; gated?: boolean; code?: string; message?: string } | null;
}

/** Cột của bảng phí (1-based, đúng thứ tự header — verify 28/09). */
const COL = { no: 1, category: 2, saleType: 3, policy: 4, type: 5, feeBase: 6, vat: 7, pgFee: 8, fee: 9, effectiveFrom: 10, promotion: 11, approval: 12, status: 13, action: 14 } as const;

/**
 * Tab 수수료 정보 của màn contract (US078) — `/commerce/contracts?view=view|edit&contractId={id}`.
 * - Chế độ xem: mỗi dòng chỉ có 비활성 (disabled) + 변경 이력. Nút 요율 수정 / 금액 수정 / 회수 / 비활성 (bấm được) chỉ có ở
 *   chế độ sửa (계약 수정).
 * - Mỗi ô 카테고리 / 판매유형 / 정책 là `<select>` chứa MỌI option → lọc dòng theo option ĐANG CHỌN, không lọc theo text dòng.
 * Locator verify trên DOM thật 28/09 (contract automation).
 */
export class ContractFeePage extends BasePage {
  readonly editButton = this.page.getByRole('button', { name: buttonText('계약 수정') });
  readonly saveButton = this.page.getByRole('button', { name: buttonText('저장') });
  readonly feeTab = this.page.getByRole('tab', { name: FEE_TEXT.tab });
  readonly periodTab = this.page.getByRole('tab', { name: '계약 기간' });
  readonly basicTab = this.page.getByRole('tab', { name: '기본 정보' });
  readonly feePanel = this.page.getByRole('tabpanel', { name: FEE_TEXT.tab });
  readonly periodPanel = this.page.getByRole('tabpanel', { name: '계약 기간' });
  readonly basicPanel = this.page.getByRole('tabpanel', { name: '기본 정보' });
  readonly columnHeaders = this.page.getByRole('tabpanel').getByRole('columnheader');
  readonly feeRows = this.page.getByRole('tabpanel').locator('tbody tr');
  readonly addButton = this.page.getByRole('tabpanel').getByRole('button', { name: /^[^가-힣A-Za-z]*(추가|Add)$/ });
  readonly feePanelAlert = this.feePanel.getByRole('alert');
  readonly periodEndInput = this.periodPanel.getByPlaceholder('날짜 선택').last();
  readonly approvalUrlInput = this.periodPanel.getByPlaceholder('https://...');
  readonly changeDialog = new ChangeRateDialog(this.page);
  readonly historyDialog = new HistoryDialog(this.page);
  readonly withdrawDialog = new WithdrawDialog(this.page);
  readonly reasonDialog = new ReasonDialog(this.page);
  readonly discardDialog = new DiscardDialog(this.page);

  constructor(page: Page) {
    super(page);
  }

  /** Mở contract ở chế độ xem, tab 수수료 정보. `lang = 'en'` → giao diện tiếng Anh (`?lang=en`, tham số ngôn ngữ của app). */
  async open(contractId: number, lang?: 'en'): Promise<void> {
    await this.goto(`/commerce/contracts?view=view&contractId=${contractId}${lang ? `&lang=${lang}` : ''}`);
    await this.click(this.page.getByRole('tab').nth(2), 'Fee Information (수수료 정보) tab');
    await expect(this.feeRows.first(), 'The fee table must finish loading').toBeVisible();
  }

  /** Vào chế độ 계약 수정 (nút 계약 수정 trên màn xem) và mở tab 수수료 정보 — nơi có 요율 수정 / 회수 / 비활성. */
  async openEdit(contractId: number): Promise<void> {
    await this.goto(`/commerce/contracts?view=view&contractId=${contractId}`);
    await this.click(this.editButton, '계약 수정 (Edit contract) button');
    await expect(this.page, 'Edit mode opens').toHaveURL(/view=edit/);
    await this.click(this.feeTab, 'Fee Information (수수료 정보) tab');
    await expect(this.feeRows.first(), 'The fee table must finish loading').toBeVisible();
  }

  /** Chế độ sửa bằng tiếng Anh — vào thẳng URL `view=edit` (URL màn sửa quan sát được 28/09) kèm `lang=en`. */
  async openEditEnglish(contractId: number): Promise<void> {
    await this.goto(`/commerce/contracts?view=edit&contractId=${contractId}&lang=en`);
    await this.click(this.page.getByRole('tab').nth(2), 'Fee Information tab');
    await expect(this.feeRows.first(), 'The fee table must finish loading').toBeVisible();
  }

  /** Dòng phí theo khoá (option đang chọn của 3 cột khoá); `effectiveFrom` phân biệt các dòng cùng khoá. */
  row(key: FeeKey, effectiveFrom?: string): Locator {
    const selected = (col: number, label: string) => this.page.locator(`td:nth-child(${col}) select option:checked`, { hasText: exactText(label) });
    let rows = this.feeRows
      .filter({ has: selected(COL.category, CATEGORY[key.category].label) })
      .filter({ has: selected(COL.saleType, SALE_TYPE[key.saleType].label) })
      .filter({ has: selected(COL.policy, POLICY_LABEL[key.policy ?? 'NORMAL']) });
    if (effectiveFrom) rows = rows.filter({ has: this.page.locator(`td:nth-child(${COL.effectiveFrom})`, { hasText: new RegExp(`^\\s*${effectiveFrom}`) }) });
    return rows.first();
  }

  cell(row: Locator, column: keyof typeof COL): Locator {
    return row.locator(`td:nth-child(${COL[column]})`);
  }

  /** Nút đổi phí của dòng — 요율 수정 (dòng 비율) hoặc 금액 수정 (dòng 고정). */
  changeButton(row: Locator): Locator {
    return row.getByRole('button', { name: /^[^가-힣A-Za-z]*(요율 수정|금액 수정|Change rate|Change amount)$/ });
  }

  rowButton(row: Locator, name: string): Locator {
    return row.getByRole('button', { name: buttonText(name) });
  }

  /** Dòng mới vừa bấm 추가 (chưa lưu) — luôn nằm cuối bảng. */
  get newRow(): Locator {
    return this.feeRows.last();
  }

  async openChangeDialog(row: Locator): Promise<void> {
    await this.click(this.changeButton(row), '요율 수정 / 금액 수정 (Change rate) button');
    await expect(this.changeDialog.root, 'Change fee rate dialog opens').toBeVisible();
  }

  /**
   * Mở 변경 이력 của dòng. App tải sẵn lịch sử mọi dòng khi mở tab (verify 28–29/09) → click có thể không gọi lại API;
   * chờ dialog hết "불러오는 중..." thay vì chờ response. Nhãn nút: 변경 이력 (KO) / History (EN).
   */
  async openHistory(row: Locator): Promise<void> {
    await this.click(row.getByRole('button', { name: /^[^가-힣A-Za-z]*(변경 이력|History)$/ }), '변경 이력 (History) button');
    await expect(this.historyDialog.root, 'Fee row history dialog opens').toBeVisible();
    await expect(this.historyDialog.root.getByText(/불러오는 중|Loading/), 'History finishes loading').toHaveCount(0);
  }

  async openWithdraw(row: Locator): Promise<void> {
    await this.click(this.rowButton(row, FEE_TEXT.btnWithdraw), '회수 (Withdraw) button');
    await expect(this.withdrawDialog.root, 'Withdraw approval request dialog opens').toBeVisible();
  }

  /** Bấm nút trạng thái (비활성 / 활성) của dòng — trên contract đang chạy mở dialog lý do. */
  async clickStatusToggle(row: Locator): Promise<void> {
    await this.click(row.getByRole('button', { name: /^[^가-힣A-Za-z]*(비활성|활성)$/ }), 'Status (활성 / 비활성) toggle button');
  }

  /**
   * Điền dòng mới (sau khi bấm 추가). Trường tối thiểu để lưu được: khoá + loại + 판매대행기준금액 (verify 28/09: thiếu
   * 기준금액 → "수수료 행의 필수 항목을 모두 입력해주세요…").
   */
  async fillNewRow(values: FeeKey & { rate: number; startDate?: string; promotion?: { from: string; to: string } }): Promise<void> {
    await test.step(`Fill the new fee row ${CATEGORY[values.category].label} · ${SALE_TYPE[values.saleType].label}`, async () => {
      const row = this.newRow;
      await row.locator(`td:nth-child(${COL.category}) select`).selectOption({ label: CATEGORY[values.category].label });
      await row.locator(`td:nth-child(${COL.saleType}) select`).selectOption({ label: SALE_TYPE[values.saleType].label });
      await row.locator(`td:nth-child(${COL.policy}) select`).selectOption({ label: POLICY_LABEL[values.policy ?? 'NORMAL'] });
      await row.locator(`td:nth-child(${COL.type}) select`).selectOption({ label: '비율' });
      await row.locator(`td:nth-child(${COL.feeBase}) select`).first().selectOption({ label: '상품가' });
      await row.locator(`td:nth-child(${COL.fee}) input`).fill(String(values.rate));
      if (values.startDate) await row.locator(`td:nth-child(${COL.effectiveFrom}) input`).fill(values.startDate);
      if (values.promotion) {
        const [from, to] = [row.locator(`td:nth-child(${COL.promotion}) input`).first(), row.locator(`td:nth-child(${COL.promotion}) input`).last()];
        await from.fill(values.promotion.from);
        await to.fill(values.promotion.to);
      }
    });
  }

  async save(): Promise<void> {
    await this.click(this.saveButton, '저장 (Save) button');
  }

  /**
   * 저장 trên contract đang chạy có dòng mới → dialog lý do (운영 중인 계약에 수수료 행 추가) → nhập lý do → 승인 요청.
   * App gửi 1 POST …/fee-rows cho MỖI dòng mới, NỐI TIẾP và kết thúc SAU khi dialog đóng, rồi quay về 계약 목록
   * (verify trace 29/09) → chờ đủ `newRows` response. Trả các response đó (body có changeApprovalId).
   */
  async saveWithReason(reason: string, newRows = 1): Promise<FeeRowPostResult[]> {
    return test.step('Save the contract and submit the new fee row(s) with a reason', async () => {
      await this.save();
      await expect(this.reasonDialog.root, 'The reason dialog opens on save').toBeVisible();
      await this.reasonDialog.reasonInput.fill(reason);
      return this.collectFeeRowPosts(() => this.reasonDialog.submitButton.click(), newRows);
    });
  }

  /**
   * Lưu lại dòng 작성 중 đã bị trả về: 저장 → dialog lý do → 승인 요청. App gửi lại qua POST …/fee-rows/{rowId}/changes
   * (KHÔNG phải POST …/fee-rows như dòng mới — trace 30/09), dùng lại change id cũ. Trả response đó.
   */
  async resubmitDraftWithReason(reason: string): Promise<{ status: number; body: { changeApprovalId?: number } | null }> {
    return test.step('Save the contract and resubmit the draft fee row with a reason', async () => {
      await this.save();
      await expect(this.reasonDialog.root, 'The reason dialog opens on save').toBeVisible();
      await this.reasonDialog.reasonInput.fill(reason);
      const response = this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/fee-rows\/\d+\/changes$/.test(r.url()));
      await this.reasonDialog.submitButton.click();
      const res = await response;
      return { status: res.status(), body: await res.json().catch(() => null) };
    });
  }

  /** Chạy `action` và chờ đủ `count` response POST …/fee-rows (smart wait qua expect.poll, không hard sleep). */
  async collectFeeRowPosts(action: () => Promise<void>, count: number): Promise<FeeRowPostResult[]> {
    const pending: Array<Promise<FeeRowPostResult>> = [];
    const listener = (r: Response) => {
      if (r.request().method() === 'POST' && /\/contracts\/\d+\/fee-rows$/.test(r.url())) pending.push(r.json().catch(() => null).then((body) => ({ status: r.status(), body })));
    };
    this.page.on('response', listener);
    try {
      await action();
      await expect.poll(() => pending.length, { message: `All ${count} new fee row(s) are sent to the register`, timeout: 30_000 }).toBe(count);
      return await Promise.all(pending);
    } finally {
      this.page.off('response', listener);
    }
  }

  /** Bấm 비활성 trên dòng đang chạy → dialog lý do → nhập lý do → 승인 요청; trả response PUT …/status. */
  async requestDeactivate(row: Locator, reason: string): Promise<{ status: number; body: { changeApprovalId?: number; gated?: boolean } | null }> {
    return test.step('Request to deactivate the fee row with a reason', async () => {
      await this.clickStatusToggle(row);
      await expect(this.reasonDialog.root, 'The deactivate reason dialog opens').toBeVisible();
      await this.reasonDialog.reasonInput.fill(reason);
      const response = this.page.waitForResponse((r) => r.request().method() === 'PUT' && /\/fee-rows\/\d+\/status$/.test(r.url()));
      await this.reasonDialog.submitButton.click();
      const res = await response;
      return { status: res.status(), body: await res.json().catch(() => null) };
    });
  }

  /** Badge chính của ô 승인 상태 (`<td><span class="badge">…</span> + marker`) — dùng cho assertion web-first (tự chờ bảng làm mới). */
  approvalBadge(row: Locator): Locator {
    return this.cell(row, 'approval').locator('span').first();
  }

  /** Ô nhập phí của dòng (chỉ đọc với dòng đã áp dụng, sửa được với dòng 작성 중 ở chế độ sửa — verify 30/09). */
  feeInput(row: Locator): Locator {
    return this.cell(row, 'fee').locator('input').first();
  }

  /** Marker "반려됨" dưới badge 승인 상태 — `span[role=button]`, `title` = lý do từ chối, bấm mở 변경 이력 (verify 30/09). */
  returnedMarker(row: Locator): Locator {
    return this.cell(row, 'approval').getByRole('button', { name: FEE_TEXT.markReturned, exact: true });
  }

  /** Bấm 초안 삭제 trên dòng 작성 중 (chế độ sửa) và chờ dialog xác nhận mở. */
  async openDiscard(row: Locator): Promise<void> {
    await this.click(this.rowButton(row, FEE_TEXT.btnDiscardDraft), '초안 삭제 (Discard draft) button');
    await expect(this.discardDialog.root, 'The Discard draft dialog opens').toBeVisible();
  }

  /** Text chính của ô 승인 상태 (bỏ marker 회수됨 / 반려됨 đứng sau). */
  async approvalValue(row: Locator): Promise<string> {
    return this.cell(row, 'approval').evaluate((td) => (td.childNodes[0]?.textContent ?? td.textContent ?? '').trim());
  }

  toast(text: string | RegExp): Locator {
    return this.page.getByText(text).first();
  }
}

/** Dialog 수수료 요율 수정 / 수수료 금액 수정 (Change fee rate). */
export class ChangeRateDialog {
  readonly root: Locator;
  readonly title: Locator;
  readonly closeIcon: Locator;
  readonly correctionRadio: Locator;
  readonly rateChangeRadio: Locator;
  readonly correctionOption: Locator;
  readonly rateChangeOption: Locator;
  readonly rateInput: Locator;
  readonly rateLabel: Locator;
  readonly unit: Locator;
  readonly dateInput: Locator;
  readonly reasonInput: Locator;
  readonly reasonLabel: Locator;
  readonly reasonError: Locator;
  readonly counter: Locator;
  readonly impactHeader: Locator;
  readonly impactBadge: Locator;
  readonly impactBody: Locator;
  readonly submitButton: Locator;
  readonly cancelButton: Locator;

  constructor(private readonly page: Page) {
    this.root = page.getByRole('dialog').filter({ has: page.locator('.modal-title', { hasText: /^(수수료 (요율|금액) 수정|Change the fee (rate|amount))$/ }) });
    this.title = this.root.locator('.modal-title');
    this.closeIcon = this.root.getByRole('button', { name: 'Close' });
    this.correctionOption = this.root.locator('label').filter({ has: page.locator('input[name="feeChangeKind"]') }).nth(0);
    this.rateChangeOption = this.root.locator('label').filter({ has: page.locator('input[name="feeChangeKind"]') }).nth(1);
    this.correctionRadio = this.correctionOption.locator('input[type="radio"]');
    this.rateChangeRadio = this.rateChangeOption.locator('input[type="radio"]');
    this.rateInput = this.root.locator('input[type="number"]');
    this.rateLabel = this.root.locator('label.form-label').first();
    this.unit = this.root.locator('.input-group-text').first();
    this.dateInput = this.root.getByPlaceholder('YYYY-MM-DD');
    this.reasonInput = this.root.locator('textarea');
    this.reasonLabel = this.root.locator('label.form-label').filter({ has: page.locator('xpath=following-sibling::textarea') });
    // Hàng dưới textarea: [lỗi lý do][bộ đếm] — bộ đếm đổi class text-muted → text-danger khi chạm/vượt giới hạn (verify 29/09).
    this.reasonError = this.root.locator('textarea ~ div > span').first();
    this.counter = this.root.getByText(/^\d+ \/ 200$/);
    this.impactHeader = this.root.locator('div.fw-bold', { hasText: /^(영향 범위|Impact)/ });
    this.impactBadge = this.impactHeader.locator('span');
    this.impactBody = this.impactHeader.locator('xpath=following-sibling::div[1]');
    this.submitButton = this.root.getByRole('button', { name: /^[^가-힣A-Za-z]*(승인 요청|적용|Submit for approval|Apply)$/ });
    this.cancelButton = this.root.getByRole('button', { name: buttonText('취소') });
  }

  summaryValue(label: string): Locator {
    return this.root.locator('span.text-muted.fw-semibold', { hasText: exactText(label) }).locator('xpath=following-sibling::span[1]');
  }

  async fill(values: { kind?: 'correction' | 'rateChange'; rate?: string; date?: string; reason?: string }): Promise<void> {
    await test.step('Fill the Change fee rate dialog', async () => {
      if (values.kind === 'correction') await this.correctionRadio.check();
      if (values.kind === 'rateChange') await this.rateChangeRadio.check();
      if (values.rate !== undefined) await this.rateInput.fill(values.rate);
      if (values.date !== undefined) await this.dateInput.fill(values.date);
      if (values.reason !== undefined) await this.reasonInput.fill(values.reason);
    });
  }

  /** Bấm 승인 요청 / 적용 và chờ đúng lượt POST …/changes trả về. */
  async submit(): Promise<{ status: number; body: { changeId?: number; changeApprovalId?: number; gated?: boolean; code?: string; message?: string } | null }> {
    return test.step('Click 승인 요청 / 적용 (Submit)', async () => {
      const response = this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/fee-rows\/\d+\/changes$/.test(r.url()));
      await this.submitButton.click();
      const res = await response;
      return { status: res.status(), body: await res.json().catch(() => null) };
    });
  }

  /** Cảnh báo / lỗi chặn trong khung check của dialog (tiêu đề + nội dung — chữ UI nguyên văn). */
  message(text: string | RegExp): Locator {
    return this.root.getByText(text);
  }
}

/** Dialog 수수료율 변경 이력 (fee row History). */
export class HistoryDialog {
  readonly root: Locator;
  readonly headers: Locator;
  readonly rows: Locator;
  readonly footer: Locator;
  readonly closeButton: Locator;

  constructor(page: Page) {
    this.root = page.getByRole('dialog').filter({ has: page.locator('.modal-title', { hasText: /^(수수료율 변경 이력|Fee-rate change history)$/ }) });
    this.headers = this.root.getByRole('columnheader');
    this.rows = this.root.locator('tbody tr');
    this.footer = this.root.getByText(/^(승인된 기안만|Only an approved request)/);
    // Nút đóng ở footer: "닫기" (KO) / "Close" (EN). Giao diện EN có thêm nút X cùng tên "Close" ở header → lấy nút cuối (footer).
    this.closeButton = this.root.getByRole('button', { name: buttonText('(닫기|Close)') }).last();
  }

  cell(rowIndex: number, column: 'when' | 'who' | 'setting' | 'change' | 'reason'): Locator {
    const index = { when: 0, who: 1, setting: 2, change: 3, reason: 4 }[column];
    return this.rows.nth(rowIndex).locator('td').nth(index);
  }

  async close(): Promise<void> {
    await this.closeButton.click();
    await expect(this.root, 'History dialog closes').toHaveCount(0);
  }

  /**
   * Nội dung ĐẦY ĐỦ của 1 ô — ô dài bị JS cắt và thêm "…" (verify 29/09); bản đầy đủ lấy từ tooltip khi hover hoặc
   * thuộc tính `title`. Ô không bị cắt → trả chính text của ô.
   */
  async fullText(rowIndex: number, column: 'when' | 'who' | 'setting' | 'change' | 'reason'): Promise<string> {
    const cell = this.cell(rowIndex, column);
    const shown = ((await cell.innerText()) ?? '').trim();
    if (!/(…|\.\.\.)$/.test(shown)) return shown;
    const titled = cell.locator('[title]').first();
    const title = (await titled.count()) ? await titled.getAttribute('title') : await cell.getAttribute('title');
    if (title) return title.trim();
    await cell.hover();
    const tooltip = this.root.page().getByRole('tooltip');
    await tooltip.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    return (await tooltip.count()) ? ((await tooltip.first().innerText()) ?? '').trim() : shown;
  }
}

/** Dialog 승인 요청 회수 (Withdraw approval request). */
export class WithdrawDialog {
  readonly root: Locator;
  readonly notice: Locator;
  readonly cancelButton: Locator;
  readonly confirmButton: Locator;

  constructor(page: Page) {
    this.root = page.getByRole('dialog').filter({ hasText: /^(승인 요청 회수|Withdraw approval request)/ });
    this.notice = this.root.getByRole('paragraph');
    this.cancelButton = this.root.getByRole('button', { name: buttonText('취소') });
    this.confirmButton = this.root.getByRole('button', { name: buttonText('회수') });
  }

  /** Giá trị chỉ đọc theo nhãn (요청 번호, 수수료 행, 변경 유형, 직전 승인값, 요청값, 기안자, 사유). */
  value(label: string): Locator {
    return this.root.getByText(exactText(label)).locator('xpath=following-sibling::*[1]');
  }
}

/** Dialog 초안 삭제 (Discard draft) của dòng 작성 중 — verify 30/09: nút 취소 / 초안 삭제, confirm gọi DELETE …/fee-rows/{id}. */
export class DiscardDialog {
  readonly root: Locator;
  readonly confirmButton: Locator;
  readonly cancelButton: Locator;

  constructor(page: Page) {
    this.root = page.getByRole('dialog').filter({ has: page.locator('.modal-title', { hasText: /^초안 삭제$/ }) });
    this.confirmButton = this.root.getByRole('button', { name: buttonText('초안 삭제') });
    this.cancelButton = this.root.getByRole('button', { name: buttonText('취소') });
  }
}

/** Dialog lý do dùng chung cho 비활성 / thêm dòng trên contract đang chạy (수수료 행 비활성화 · 운영 중인 계약에 수수료 행 추가). */
export class ReasonDialog {
  readonly root: Locator;
  readonly title: Locator;
  readonly reasonInput: Locator;
  readonly counter: Locator;
  readonly kindRadios: Locator;
  readonly submitButton: Locator;

  constructor(page: Page) {
    this.root = page.getByRole('dialog').filter({ has: page.locator('.modal-title', { hasText: /^(수수료 행 비활성화|운영 중인 계약에 수수료 행 추가|새 수수료 행 추가)$/ }) });
    this.title = this.root.locator('.modal-title');
    this.reasonInput = this.root.getByRole('textbox');
    this.counter = this.root.getByText(/^\d+ \/ 200$/);
    this.kindRadios = this.root.getByRole('radio');
    this.submitButton = this.root.getByRole('button', { name: /^[^가-힣A-Za-z]*(승인 요청|적용)$/ });
  }
}
