import { Page, Locator, test, expect } from '@playwright/test';
import { BasePage } from './base.page';

export interface HistoryRecord {
  when: string;
  who: string;
  items: string[];
  changes: string[];
  reason: string;
}

/** Nhãn chỉ khớp đúng chữ, cho phép dấu `*` bắt buộc theo sau (VD `PG*`). */
const labelText = (text: string) => new RegExp(`^${text}\\*?$`);
/** Tên nút có icon font đứng trước/sau (ký tự private-use) — khớp đúng chữ, KHÔNG khớp nhầm "확인 및 저장". */
const buttonText = (text: string) => new RegExp(`^[^가-힣A-Za-z]*${text}[^가-힣A-Za-z]*$`);

/**
 * Form 결제수단 정책 (US080) — tạo mới `/commerce/payment-method-policies/create`, sửa `/commerce/payment-method-policies/{id}`.
 * Locator verify trên UI thật 28/09. Tiêu đề form: tạo mới "신규 결제 채널", sửa "결제 채널 {pg} · {method} · {currency}".
 * Ở màn sửa, 3 field channel key render `<label>` + `<p>` (plain text), không có select.
 */
export class PaymentMethodPolicyFormPage extends BasePage {
  readonly createTitle = this.page.getByText('신규 결제 채널', { exact: true });
  readonly channelKeyPanelTitle = this.page.getByText('채널 키', { exact: true });
  readonly policySettingsTitle = this.page.getByText('정책 설정', { exact: true });

  readonly pgSelect = this.page.locator('#policy-pg');
  readonly methodSelect = this.page.locator('#policy-method');
  readonly currencySelect = this.page.locator('#policy-currency');
  readonly channelKeyLockedHint = this.page.getByText(
    '이 세 필드는 채널을 식별하며, 정책 생성 후에는 변경할 수 없습니다. 동일한 결제수단이라도 통화가 다르면 별도의 정책 행입니다.',
    { exact: true },
  );
  readonly duplicateKeyMessage = this.page.getByText('채널에 대한 정책이 이미 존재합니다', { exact: false });

  readonly strategySelect = this.page.locator('#policy-strategy');
  readonly cycleTypeSelect = this.page.locator('#policy-cycle-type');
  readonly anchorSelect = this.page.locator('#policy-anchor');
  readonly lagInput = this.page.locator('#policy-lag');
  readonly lagError = this.lagInput.locator('xpath=..').locator('.invalid-feedback');
  readonly lagHint = this.page.getByText(
    '거래 후 실제 입금까지의 명목 지연 기간입니다. 캘린더 일 기준이며, 공휴일 주변 실제 날짜는 은행이 자체적으로 조정합니다.',
    { exact: true },
  );
  readonly whatThisMeansTitle = this.page.getByText('이것이 의미하는 바', { exact: true });
  readonly whatThisMeansPanel = this.whatThisMeansTitle.locator('xpath=..');

  readonly historyButton = this.page.getByRole('button', { name: buttonText('변경 이력') });
  readonly backToListButton = this.page.getByRole('button', { name: buttonText('목록으로') });
  readonly saveButton = this.page.getByRole('button', { name: buttonText('저장') });
  readonly cancelButton = this.page.getByRole('button', { name: buttonText('취소') });

  // Dialog xác nhận — "이 변경을 적용할까요?" (lag/cycle/anchor, áp dụng ngay) / "승인을 요청할까요?" (환율 적용 방식, tạo mới)
  readonly confirmDialog = this.page.getByRole('dialog');
  readonly confirmDialogTitle = this.confirmDialog.getByRole('heading');
  readonly confirmDialogBackButton = this.confirmDialog.getByRole('button', { name: buttonText('뒤로') });
  readonly applyNowConfirmButton = this.confirmDialog.getByRole('button', { name: buttonText('확인 및 저장') });
  readonly requestApprovalButton = this.confirmDialog.getByRole('button', { name: buttonText('승인 요청') });
  readonly changeReasonInput = this.page.locator('#policy-change-reason');
  readonly changeReasonLabel = this.page.locator('label[for="policy-change-reason"]');

  // Banner trạng thái trên form sửa (tiêu đề + 1 dòng chi tiết ngay sau) — verify 28/09
  readonly pendingLockTitle = this.page.getByText('승인 대기 중 — 수정할 수 없습니다', { exact: true });
  readonly pendingLockDetail = this.pendingLockTitle.locator('xpath=following-sibling::div[1]');
  readonly reviewInApprovalButton = this.page.getByRole('button', { name: buttonText('변경 승인에서 확인') });
  readonly rejectedBannerTitle = this.page.getByText('최근 변경 요청이 반려되었습니다', { exact: true });
  readonly rejectedBannerDetail = this.rejectedBannerTitle.locator('xpath=following-sibling::div[1]');
  readonly withdrawnBannerTitle = this.page.getByText('최근 변경 요청을 회수했습니다', { exact: true });
  readonly withdrawnBannerDetail = this.withdrawnBannerTitle.locator('xpath=following-sibling::div[1]');
  readonly staleVersionBanner = this.page.getByText('다른 사용자가 이 정책을 변경했습니다. 최신 값을 보려면 새로고침하세요.', { exact: true });
  readonly staleVersionBannerActions = this.staleVersionBanner.locator('xpath=..').getByRole('button');
  readonly reloadButton = this.page.getByRole('button', { name: buttonText('새로고침') });

  readonly savedToast = this.page.getByText('저장됨 — 다음 정산 실행부터 새 값이 적용됩니다.', { exact: true });
  readonly submittedToast = this.page.getByText('승인 요청됨 — 승인 전까지 기존 값이 유지됩니다', { exact: true });

  // Dialog 변경 이력 — cột thực tế: 일시 / 변경자 / 항목 / 변경 내용 / 사유
  readonly historyDialog = this.page.getByRole('dialog').filter({ hasText: '변경 이력' });
  readonly historyTable = this.historyDialog.locator('table');
  /** Dòng bản ghi thật — loại dòng loading/empty-state (1 `<td colspan>`). */
  readonly historyRows = this.historyTable.locator('tbody tr:not(:has(td[colspan]))');
  readonly historyLoading = this.historyDialog.getByText('불러오는 중...');
  readonly historyEmptyTitle = this.historyDialog.getByText('아직 변경 이력이 없습니다', { exact: true });
  readonly historyEmptySubLine = this.historyDialog.getByText('이 채널은 아직 처음 등록된 값을 그대로 유지하고 있습니다.', { exact: true });
  readonly historyCloseButton = this.historyDialog.getByRole('button', { name: buttonText('닫기') });

  constructor(page: Page) {
    super(page);
  }

  /** Tiêu đề form sửa: "결제 채널" kèm channel key. */
  editTitle(key: string): Locator {
    return this.page.getByText(new RegExp(`^결제 채널\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  }

  /** Hint tĩnh dưới 1 field dạng select (`<select id> <div.invalid-feedback> <div.text-muted>hint</div>`). */
  hintFor(select: Locator): Locator {
    return select.locator('xpath=following-sibling::div[contains(@class,"text-muted")][1]');
  }

  fieldLabel(text: string): Locator {
    return this.page.locator('label', { hasText: labelText(text) });
  }

  /** Dấu `*` bắt buộc ngay trong label. */
  requiredMarker(text: string): Locator {
    return this.fieldLabel(text).locator('span', { hasText: '*' });
  }

  /** Giá trị channel key plain text ở màn sửa (`<label>PG</label><p>NICEPAY</p>`). */
  keyPlainValue(label: string): Locator {
    return this.page.locator('label', { hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::p[1]');
  }

  /** Dòng "{nhãn} {cũ} → {mới}" trong khối 변경 내용 của dialog xác nhận. */
  confirmChangeLine(label: string): { line: Locator; oldValue: Locator; newValue: Locator } {
    const line = this.confirmDialog.locator('div').filter({ has: this.page.locator(':scope > span', { hasText: new RegExp(`^${label}$`) }) });
    return { line, oldValue: line.locator('s'), newValue: line.locator('b') };
  }

  async open(id: number): Promise<void> {
    await this.goto(`/commerce/payment-method-policies/${id}`);
    await expect(this.lagInput, 'Edit form must finish loading').toBeVisible();
  }

  async openCreate(): Promise<void> {
    await this.goto('/commerce/payment-method-policies/create');
    await expect(this.pgSelect, 'Create form must finish loading').toBeVisible();
  }

  /**
   * Chọn đủ 3 key — khi đủ, app gọi GET …/by-key để kiểm trùng: chờ đúng response đó (smart wait) để thông báo
   * trùng / trạng thái 저장 đọc sau đó là kết quả kiểm thật, không phải trạng thái giữa chừng.
   */
  async fillChannelKey(data: { pg: string; method: string; currency: string }): Promise<void> {
    await test.step(`Select channel key ${data.pg} · ${data.method} · ${data.currency}`, async () => {
      await this.pgSelect.selectOption(data.pg);
      await this.methodSelect.selectOption(data.method);
      await this.selectCurrencyAndAwaitKeyCheck(data.currency);
    });
  }

  /** Đổi 거래금액 통화 khi 2 key kia đã chọn — chờ response kiểm trùng của tổ hợp mới. */
  async selectCurrencyAndAwaitKeyCheck(currency: string): Promise<void> {
    const keyCheck = this.page.waitForResponse(
      (response) => response.url().includes('/payment-method-policies/by-key') && response.url().includes(`currency=${currency}`),
    );
    await this.currencySelect.selectOption(currency);
    await keyCheck;
  }

  async fillPolicySettings(data: {
    strategy?: 'ALREADY_KRW' | 'BANK_SETTLEMENT_RATE';
    cycleType?: 'WEEKLY' | 'DAILY';
    anchor?: string;
    lag?: string;
  }): Promise<void> {
    if (data.strategy !== undefined) await this.strategySelect.selectOption(data.strategy);
    if (data.cycleType !== undefined) await this.cycleTypeSelect.selectOption(data.cycleType);
    if (data.anchor !== undefined) await this.anchorSelect.selectOption(data.anchor);
    if (data.lag !== undefined) await this.type(this.lagInput, data.lag, '지연일수 (Lag) field');
  }

  async save(): Promise<void> {
    await this.click(this.saveButton, '저장 (Save) button');
  }

  async backToList(): Promise<void> {
    await this.click(this.backToListButton, '목록으로 (Back to list) button');
  }

  async fillChangeReason(reason: string): Promise<void> {
    await this.type(this.changeReasonInput, reason, '변경 사유 (Reason for this change) field');
  }

  async confirmApplyNow(): Promise<void> {
    await this.click(this.applyNowConfirmButton, '확인 및 저장 (Confirm and save) button on the apply-now dialog');
  }

  /** Nhập lý do + bấm 승인 요청 — chờ response của request ghi (POST tạo mới / PUT sửa), trả về HTTP status. */
  async submitForApproval(reason: string): Promise<number> {
    await this.fillChangeReason(reason);
    const write = this.page.waitForResponse(
      (response) => response.request().method() !== 'GET' && /\/api\/v1\/payment-method-policies(\/\d+)?$/.test(response.url()),
    );
    await this.click(this.requestApprovalButton, '승인 요청 (Request approval) button on the approval dialog');
    return (await write).status();
  }

  async backFromDialog(): Promise<void> {
    await this.click(this.confirmDialogBackButton, '뒤로 (Back) button on the confirm dialog');
    await expect(this.confirmDialog, 'Confirm dialog must close').toBeHidden();
  }

  async openHistory(): Promise<void> {
    await this.click(this.historyButton, '변경 이력 (Change history) button');
    await this.waitForHistoryLoaded();
  }

  /** Dialog 변경 이력 render "불러오는 중..." trước — chờ tới khi hết loading (có bản ghi hoặc empty state). */
  async waitForHistoryLoaded(): Promise<void> {
    await expect(this.historyDialog, '변경 이력 dialog must open').toBeVisible();
    await expect(this.historyLoading, '변경 이력 dialog must finish loading').toHaveCount(0, { timeout: 15_000 });
    await expect(this.historyRows.first().or(this.historyEmptyTitle), '변경 이력 dialog must show records or its empty state').toBeVisible();
  }

  async closeHistory(): Promise<void> {
    await this.click(this.historyCloseButton, '닫기 (Close) button on the 변경 이력 dialog');
    await expect(this.historyDialog).toBeHidden();
  }

  /** Mọi bản ghi trong dialog 변경 이력 — ô 항목/변경 내용 xếp chồng nhiều `<span>` khi 1 lần lưu đổi nhiều field. */
  async getHistoryRecords(): Promise<HistoryRecord[]> {
    return this.historyRows.evaluateAll((trs) =>
      trs.map((tr) => {
        const cells = Array.from(tr.querySelectorAll('td'));
        const spans = (td: Element | undefined) =>
          td ? Array.from(td.querySelectorAll(':scope > span')).map((s) => (s.textContent ?? '').replace(/\s+/g, ' ').trim()) : [];
        return {
          when: (cells[0]?.textContent ?? '').trim(),
          who: (cells[1]?.textContent ?? '').trim(),
          items: spans(cells[2]),
          changes: spans(cells[3]),
          reason: (cells[4]?.textContent ?? '').trim(),
        };
      }),
    );
  }
}
