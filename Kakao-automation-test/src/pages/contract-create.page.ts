import { Page } from '@playwright/test';
import { BasePage } from './base.page';

export class ContractCreatePage extends BasePage {
  readonly tabList = this.page.getByRole('tablist');
  readonly basicInfoTab = this.page.getByRole('tab', { name: '기본 정보' });
  readonly contractPeriodTab = this.page.getByRole('tab', { name: '계약 기간' });
  readonly feeInfoTab = this.page.getByRole('tab', { name: '수수료 정보' });

  private readonly basicInfoPanel = this.page.getByRole('tabpanel', { name: '기본 정보' });
  private readonly periodPanel = this.page.getByRole('tabpanel', { name: '계약 기간' });

  // Tab 1 — 기본 정보 (Thông tin cơ bản)
  readonly contractNameLabel = this.basicInfoPanel.getByText('계약서명 *', { exact: true });
  readonly contractNameInput = this.basicInfoPanel.getByPlaceholder('계약서명을 입력하세요');
  readonly bizPartnerLabel = this.basicInfoPanel.getByText('비즈파트너 *', { exact: true });
  readonly bizPartnerSearchInput = this.basicInfoPanel.getByPlaceholder('비즈파트너를 검색하세요');
  readonly labelClassificationLabel = this.basicInfoPanel.getByText('레이블 구분 *', { exact: true });
  readonly labelClassificationRadio = this.basicInfoPanel.getByRole('radio', { name: 'SM', exact: true });
  readonly bmClassificationLabel = this.basicInfoPanel.getByText('BM 구분 *', { exact: true });
  readonly bmClassificationRadio = this.basicInfoPanel.getByRole('radio', { name: '사입' });
  readonly regionLabel = this.basicInfoPanel.getByText('국내/해외 구분 *', { exact: true });
  readonly regionRadio = this.basicInfoPanel.getByRole('radio', { name: '국내' });
  readonly ipDomainLabel = this.basicInfoPanel.getByText('IP 도메인 *', { exact: true });
  readonly ipDomainCheckbox = this.basicInfoPanel.getByRole('checkbox', { name: 'k-pop' });
  readonly artistLabel = this.basicInfoPanel.getByText('아티스트 *', { exact: true });

  // Tab 2 — 계약 기간 (Thời hạn hợp đồng)
  readonly signedDateInput = this.periodPanel.locator('.row', { hasText: '계약 체결 일자' }).locator('input[type="date"]');
  readonly renewalNoticeDateInput = this.periodPanel.locator('.row', { hasText: '갱신 알림일' }).locator('input[type="date"]');
  readonly internalApprovalUrlLabel = this.periodPanel.getByText('내부 승인 문서 URL', { exact: true });
  readonly internalApprovalUrlInput = this.periodPanel.getByPlaceholder('https://...');
  readonly approvalRequiredBanner = this.page.getByText(
    '수수료 정보가 있는 계약서는 내부 승인 문서 URL이 필수입니다.',
  );

  constructor(page: Page) {
    super(page);
  }

  async openTab(tab: 'basic' | 'period' | 'fee'): Promise<void> {
    const tabLocator = { basic: this.basicInfoTab, period: this.contractPeriodTab, fee: this.feeInfoTab }[tab];
    const tabName = { basic: '기본 정보', period: '계약 기간', fee: '수수료 정보' }[tab];
    await this.click(tabLocator, `tab ${tabName}`);
  }

  async getTabLabels(): Promise<string[]> {
    return this.tabList.getByRole('tab').allTextContents();
  }
}
