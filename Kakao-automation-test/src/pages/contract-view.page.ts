import { Page } from '@playwright/test';
import { BasePage } from './base.page';

export class ContractViewPage extends BasePage {
  readonly editButton = this.page.getByRole('button', { name: '계약 수정' });
  readonly reviseButton = this.page.getByRole('button', { name: '계약 변경' });
  // Trang có thêm nút "목록으로" rút gọn ở cuối nội dung tab — chỉ lấy nút đầu tiên (toolbar trên cùng)
  readonly backToListButton = this.page.getByRole('button', { name: '목록으로' }).first();

  constructor(page: Page) {
    super(page);
  }

  async openEdit(): Promise<void> {
    await this.click(this.editButton, '계약 수정 (Edit contract) button');
  }
}
