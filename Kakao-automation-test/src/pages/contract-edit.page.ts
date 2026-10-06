import { Page } from '@playwright/test';
import { BasePage } from './base.page';

type TabKey = 'basic' | 'period' | 'fee';

export class ContractEditPage extends BasePage {
  readonly basicInfoTab = this.page.getByRole('tab', { name: '기본 정보' });
  readonly contractPeriodTab = this.page.getByRole('tab', { name: '계약 기간' });
  readonly feeInfoTab = this.page.getByRole('tab', { name: '수수료 정보' });
  readonly cancelButton = this.page.getByRole('button', { name: '취소' });
  readonly saveButton = this.page.getByRole('button', { name: '저장' });

  private readonly basicInfoPanel = this.page.getByRole('tabpanel', { name: '기본 정보' });
  private readonly periodPanel = this.page.getByRole('tabpanel', { name: '계약 기간' });
  private readonly feePanel = this.page.getByRole('tabpanel', { name: '수수료 정보' });

  // Tab 1 — 기본 정보 (Thông tin cơ bản)
  readonly contractNameInput = this.basicInfoPanel.getByPlaceholder('계약서명을 입력하세요');
  readonly contractCodeInput = this.basicInfoPanel.locator('input[name="code"]');
  readonly bizPartnerInput = this.basicInfoPanel.locator('.row', { hasText: '비즈파트너' }).getByRole('textbox');
  readonly statusActiveRadio = this.basicInfoPanel.getByRole('radio', { name: '정상 ACTIVE' });
  readonly statusCanceledRadio = this.basicInfoPanel.getByRole('radio', { name: '취소 CANCELED' });
  readonly labelClassificationRadio = this.basicInfoPanel.getByRole('radio', { name: 'SM', exact: true });
  readonly bmClassificationRadio = this.basicInfoPanel.getByRole('radio', { name: '사입' });
  readonly domesticGlobalRadio = this.basicInfoPanel.getByRole('radio', { name: '국내' });
  readonly ipDomainCheckbox = this.basicInfoPanel.getByRole('checkbox', { name: 'k-pop' });
  readonly artistSelectAllButton = this.basicInfoPanel.getByRole('button', { name: '전체 선택' });
  readonly artistCheckbox = this.basicInfoPanel.getByRole('checkbox', { name: '코테' });
  readonly remarkInput = this.basicInfoPanel.getByPlaceholder('추가 정보를 입력하세요');

  // Tab 2 — 계약 기간 (Thời hạn hợp đồng)
  readonly periodStartDateInput = this.periodPanel.getByPlaceholder('날짜 선택').first();
  readonly periodEndDateInput = this.periodPanel.getByPlaceholder('날짜 선택').last();
  readonly signedDateInput = this.periodPanel.locator('.row', { hasText: '계약 체결 일자' }).locator('input[type="date"]');
  readonly renewalNoticeDateInput = this.periodPanel.locator('.row', { hasText: '갱신 알림일' }).locator('input[type="date"]');
  readonly internalApprovalUrlInput = this.periodPanel.getByPlaceholder('https://...');

  // Tab 3 — 수수료 정보 (Thông tin phí)
  readonly addFeeButton = this.feePanel.getByRole('button', { name: '추가' });
  readonly existingFeeRowDeactivateButton = this.feePanel.getByRole('button', { name: '비활성' });

  constructor(page: Page) {
    super(page);
  }

  async openTab(tab: TabKey): Promise<void> {
    const tabLocator = { basic: this.basicInfoTab, period: this.contractPeriodTab, fee: this.feeInfoTab }[tab];
    const tabName = { basic: '기본 정보', period: '계약 기간', fee: '수수료 정보' }[tab];
    await this.click(tabLocator, `tab ${tabName}`);
  }

  async fillRemark(text: string): Promise<void> {
    await this.type(this.remarkInput, text, '비고 (Remark) field');
  }

  async cancel(): Promise<void> {
    await this.click(this.cancelButton, '취소 (Cancel changes) button');
  }
}
