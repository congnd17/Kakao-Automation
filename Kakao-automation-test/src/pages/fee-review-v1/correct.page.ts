import { Locator, Page, Response, test } from '@playwright/test';
import { FeeReviewListPage } from '@pages/fee-review.page';
import { FR_KO, FR_TC } from '@utils/fee-review.i18n';

/**
 * Phần bổ sung cho dialog 수수료 산정 수정 + list (US079 v1, nhóm [Correct]). Locator lấy từ recon
 * `.playwright-mcp/v1-recon/07-correct-P14-draft.yml`, `08-correct-P10-tier2.yml`, `01-list-all.yml`, `10-report-dialog.yml`.
 * Locator ghi "UNVERIFIED" = chưa có trong recon (trạng thái chỉ xuất hiện khi validate / sau khi lưu) — cần soi DOM lần chạy đầu.
 */
export class CorrectV1Page {
  constructor(
    private readonly page: Page,
    private readonly list: FeeReviewListPage,
  ) {}

  /** Khối 2단계 — label + (ô nhập | dòng chữ khoá) cùng 1 cha (recon 07 / 08). */
  get tier2Area(): Locator {
    return this.list.correct.tier2Label.locator('xpath=..');
  }

  /** Option đang chọn của 1단계. */
  get checkedOption(): Locator {
    return this.list.correct.tier1Select.locator('option:checked');
  }

  get reasonRequired(): Locator {
    return this.list.correct.message(FR_KO['fix.reasonRequired']);
  }

  get reasonTooLong(): Locator {
    return this.list.correct.message(FR_KO['fix.reasonTooLong']);
  }

  get nothingChanged(): Locator {
    return this.list.correct.message(FR_KO['fix.nothingChanged']);
  }

  /** Câu STL-1019 theo TC (không có trong bundle) — KO hoặc EN, ở bất kỳ đâu trên trang (dialog / toast). */
  get staleStateMessage(): Locator {
    return this.page.getByText(FR_TC.staleStateKo).or(this.page.getByText(FR_TC.staleStateEn)).first();
  }

  /** Badge 직접 입력 trong ô 산정 요율 — UNVERIFIED (chưa có recon dòng có tier-2 draft). */
  handKeyedBadge(row: Locator): Locator {
    return this.list.cell(row, 'rate').getByText(FR_KO['lbl.handKeyed'], { exact: true });
  }

  /** Dòng của sản phẩm trong dialog 이번 기 수정 내역 (cột 상품ID, recon 10). */
  reportRow(productId: string): Locator {
    return this.list.report.rows.filter({ has: this.page.getByRole('cell', { name: productId, exact: true }) });
  }

  /** Chữ "chính" của ô (text node trực tiếp, bỏ dòng đề xuất `div.small`) — recon 01: "12.50%" + div "→ 9.00%". */
  async mainText(cell: Locator): Promise<string> {
    return cell.evaluate((el) =>
      Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? '')
        .join('')
        .trim(),
    );
  }

  /** Giá trị CSS đã tính của phần tử. */
  async cssValue(locator: Locator, property: 'opacity' | 'cursor' | 'text-decoration-line'): Promise<string> {
    return locator.evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), property);
  }

  /** Có phần tử con (hoặc chính nó) bị gạch ngang (`<s>`, `<del>` hoặc text-decoration line-through) — UNVERIFIED. */
  async hasStrikeThrough(locator: Locator): Promise<boolean> {
    return locator.evaluate((el) =>
      [el, ...Array.from(el.querySelectorAll('*'))].some((n) => n.tagName === 'S' || n.tagName === 'DEL' || getComputedStyle(n).textDecorationLine.includes('line-through')),
    );
  }

  /** Rê chuột lên vỏ bọc nút 수정 (nút disabled không nhận hover — vỏ bọc mang `title`, recon 01). */
  async hoverCorrect(row: Locator): Promise<void> {
    await test.step('Hover the 수정 (Correct) button', () => this.list.correctWrapper(row).hover());
  }

  /** Bấm 수정 버리기 và chờ DELETE correction trả về. */
  async discard(): Promise<Response> {
    const done = this.page.waitForResponse((r) => r.request().method() === 'DELETE' && /\/fee-review\/corrections\/[^/]+$/.test(r.url()));
    await test.step('Click 수정 버리기 (원래대로) (Discard correction)', () => this.list.correct.discardButton.click());
    return done;
  }

  /** Bấm nút X góc phải dialog. */
  async closeByCorner(): Promise<void> {
    await test.step('Click the X icon of the Correct dialog', () => this.list.correct.cornerClose.click());
  }
}
