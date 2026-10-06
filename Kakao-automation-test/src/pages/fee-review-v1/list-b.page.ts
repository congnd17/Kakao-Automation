import { Locator, Page } from '@playwright/test';
import { FeeReviewListPage } from '@pages/fee-review.page';
import { FR_KO } from '@utils/fee-review.i18n';

/**
 * Bổ sung cho `FeeReviewListPage` dùng riêng nhóm TC [List] phần B (TC_US079_38–56).
 * Locator lấy từ recon `.playwright-mcp/v1-recon/01-list-all.yml` (01/10): chip = button "{n} {nhãn}" với số trong span đầu;
 * ô 작업 chứa các button 근거 / 수정 / 회수 / 이력 theo thứ tự DOM; nút 수정 bị khoá nằm trong vỏ bọc mang thuộc tính title.
 * `handKeyedBadge` CHƯA verify trên DOM (recon không có dòng đã duyệt bằng tay) — xem báo cáo UNVERIFIED.
 */
export type ChipKey = Parameters<FeeReviewListPage['chip']>[0];

export class FeeReviewListBPage {
  constructor(
    private readonly page: Page,
    readonly list: FeeReviewListPage,
  ) {}

  /** Số hiển thị trên chip (span đầu của button chip). */
  chipNumber(key: ChipKey): Locator {
    return this.list.chip(key).locator('span').first();
  }

  /** Bấm lại 검색 (Search) với bộ lọc đang có — app không gửi lại request khi bộ lọc không đổi (run 02/10) → tải lại trang. */
  async searchAgain(): Promise<void> {
    await this.list.searchOrReload();
  }

  /** Mở cycle qua URL (`cycleId`), rồi gõ từ khoá nếu TC dùng cycle chung — chỉ giữ dòng của TC. */
  async show(cycleId: number, keyword?: string, pageSize: '20' | '100' = '100'): Promise<void> {
    await this.list.open({ cycleId, pageSize });
    if (keyword) await this.list.search(keyword);
  }

  /** Bấm chip rồi trả về mã sản phẩm của mọi dòng đang hiển thị (không trùng). */
  async idsUnder(key: ChipKey): Promise<string[]> {
    await this.list.clickChip(this.list.chip(key));
    return [...new Set(await this.list.productIds())].sort();
  }

  /** Các nút trong ô 작업 (Actions) theo thứ tự trái → phải. */
  actionButtons(row: Locator): Locator {
    return this.list.cell(row, 'actions').getByRole('button');
  }

  /** Chữ ô 산정 요율 của mọi dòng (mọi chính sách) của 1 sản phẩm. */
  async rateTexts(productId: string): Promise<string[]> {
    const rows = this.list.rows.filter({ has: this.page.getByRole('cell', { name: productId, exact: true }) });
    const texts: string[] = [];
    for (let i = 0; i < (await rows.count()); i++) texts.push(((await this.list.cell(rows.nth(i), 'rate').textContent()) ?? '').trim());
    return texts;
  }

  /** Badge 직접 입력 (Hand-keyed) trong ô 산정 요율 — UNVERIFIED (chưa có trong recon). */
  handKeyedBadge(row: Locator): Locator {
    return this.list.cell(row, 'rate').getByText(FR_KO['lbl.handKeyed'], { exact: true });
  }

  /** Dòng chính của ô 2 dòng (text node đầu, không gồm dòng phụ `div.small`). */
  async mainLine(cell: Locator): Promise<string> {
    return cell.evaluate((el) => (el.childNodes[0]?.textContent ?? '').trim());
  }

  /** Dòng phụ trông mờ hơn dòng chính: màu chữ khác hoặc opacity < 1. */
  async isDimmed(cell: Locator): Promise<boolean> {
    return cell.evaluate((el) => {
      const second = el.querySelector('div.small');
      if (!second) return false;
      const main = getComputedStyle(el);
      const sub = getComputedStyle(second);
      return sub.color !== main.color || Number(sub.opacity) < 1;
    });
  }

  /** Nút 수정 trông bị khoá: disabled + opacity < 1 + con trỏ not-allowed (trên nút hoặc vỏ bọc). */
  async looksDisabled(row: Locator): Promise<{ disabled: boolean; dimmed: boolean; notAllowed: boolean }> {
    const button = this.list.rowButton(row, 'btn.correct');
    const wrapper = this.list.correctWrapper(row);
    const disabled = await button.isDisabled();
    const style = await button.evaluate((el) => ({ opacity: Number(getComputedStyle(el).opacity), cursor: getComputedStyle(el).cursor }));
    const wrapperCursor = await wrapper.evaluate((el) => getComputedStyle(el).cursor);
    return { disabled, dimmed: style.opacity < 1, notAllowed: style.cursor === 'not-allowed' || wrapperCursor === 'not-allowed' };
  }

  /** Giờ trong nhãn 산정 시각 {time} — … (chuỗi {time} nguyên văn). */
  async resolvedAtTime(): Promise<string> {
    const text = (await this.list.resolvedAtLabel.innerText()).trim();
    return /^(?:산정 시각|Resolved at) (.+?) — /.exec(text)?.[1] ?? '';
  }

  /** Giờ hiện tại của trình duyệt dạng HH:MM (cùng múi giờ app hiển thị). */
  async browserClock(): Promise<string> {
    return this.page.evaluate(() => new Date().toTimeString().slice(0, 5));
  }
}
