import { Page, expect } from '@playwright/test';
import { BasePage } from './base.page';
import { FEE_TEXT } from '@utils/fee-rate.data';

/**
 * Màn 계약 #{code} 변경 이력 — mở từ nút 변경 히스토리 của dòng contract trên 계약 목록
 * (`/commerce/contracts?view=history&contractId={id}&contractCode={code}`). Bảng snapshot contract ở trên, bảng
 * 수수료율 수정 이력 (fee-rate change trail, US078) ở dưới. Verify DOM thật 28/09.
 */
export class ContractHistoryPage extends BasePage {
  readonly title = this.page.getByText(/^계약 #.+ 변경 이력$/);
  readonly snapshotTable = this.page.locator('table').first();
  readonly snapshotHeaders = this.snapshotTable.getByRole('columnheader');
  readonly trailTitle = this.page.getByText(FEE_TEXT.trail.title, { exact: true });
  readonly trailTable = this.trailTitle.locator('xpath=following::table[1]');
  readonly trailHeaders = this.trailTable.getByRole('columnheader');
  readonly trailRows = this.trailTable.locator('tbody tr');

  constructor(page: Page) {
    super(page);
  }

  /** Mở như người dùng: 계약 목록 → tìm theo 계약서명 (list phân trang) → dòng contract → 변경 히스토리. */
  async openFromList(contractName: string): Promise<void> {
    await this.goto('/commerce/contracts');
    await this.type(this.page.getByPlaceholder('검색어를 입력하세요'), contractName, '검색어 (Search keyword) field — 계약서명');
    await this.click(this.page.getByRole('button', { name: /^[^가-힣A-Za-z]*검색$/ }), '검색 (Search) button');
    // Cột 계약서명 cũng cắt tên dài + "…" (verify 29/09) → tìm theo tên đầy đủ đã lọc đúng 1 contract; khớp theo tiền tố tên.
    const row = this.page.getByRole('row').filter({ has: this.page.getByRole('button', { name: /변경 히스토리/ }) }).filter({ hasText: contractName.slice(0, 15) });
    await expect(row, `Exactly one contract "${contractName}" is found`).toHaveCount(1);
    await this.click(row.getByRole('button', { name: /변경 히스토리/ }), '변경 히스토리 (Change history) button');
    await expect(this.trailTitle, 'The fee-rate change trail is shown').toBeVisible();
  }
}
