import { Page, Locator } from '@playwright/test';
import { BasePage } from './base.page';

export class ContractListPage extends BasePage {
  readonly addContractButton = this.page.getByRole('button', { name: '새 계약 추가' });

  constructor(page: Page) {
    super(page);
  }

  async open(): Promise<void> {
    await this.goto('/commerce/contracts');
  }

  contractCodeLink(contractCode: string): Locator {
    return this.page.getByRole('link', { name: contractCode, exact: true });
  }

  async openContract(contractCode: string): Promise<void> {
    await this.click(this.contractCodeLink(contractCode), `contract code ${contractCode}`);
  }

  async openCreateForm(): Promise<void> {
    await this.click(this.addContractButton, '새 계약 추가 (Add new contract) button');
  }
}
