import { Locator, Page, Response, expect, test } from '@playwright/test';
import { FeeReviewListPage, LIST_COL } from '@pages/fee-review.page';
import { FR_EN, FR_KO } from '@utils/fee-review.i18n';

/**
 * Bổ sung locator / thao tác cho nhóm TC [List] A (TC_US079_18 → 37) — dựa trên snapshot recon thật
 * `.playwright-mcp/v1-recon/01-list-all.yml` (01/10). Không sửa page object dùng chung `FeeReviewListPage`.
 */
export type ChipKey = 'bucket.ALL' | 'bucket.EXC' | 'bucket.NC' | 'bucket.PROV' | 'bucket.FIXED' | 'bucket.OK' | 'bucket.NF' | 'bucket.AMB' | 'bucket.DIFF' | 'bucket.SRCDIFF';

/** 10 chip tóm tắt theo thứ tự trên UI: 6 chip phạm vi (범위) + 4 chip theo loại vấn đề (유형별). */
export const ALL_CHIPS: readonly ChipKey[] = ['bucket.ALL', 'bucket.EXC', 'bucket.NC', 'bucket.PROV', 'bucket.FIXED', 'bucket.OK', 'bucket.NF', 'bucket.AMB', 'bucket.DIFF', 'bucket.SRCDIFF'];

const LIST_URL = /\/api\/v1\/fee-review\/cycles\/(\d+)\/products\?/;

function esc(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class FeeReviewListAPage {
  /** Option của 정산 주기 (select native — recon: option "2100-02", "2100-01"…, mới nhất trước). */
  readonly cycleOptions: Locator;
  /** Ô mã sản phẩm (cột 상품ID) của mọi dòng đang hiển thị. */
  readonly productIdCells: Locator;
  /** Nút 검색 ở mọi trạng thái (khi đang chạy query nút có thể đổi chữ thành 조회 중 — `btn.searching`). */
  readonly searchAnyState: Locator;
  /** Trang hiện tại của pager — recon: listitem chứa "1" + "(current)". */
  readonly currentPage: Locator;
  /** Các mục số trang của pager (bỏ First / Previous / Next / Last). */
  readonly pageNumbers: Locator;
  /** Checkbox chọn dòng của mọi dòng trên trang (không gồm checkbox header). */
  readonly rowCheckboxes: Locator;
  /** Điều khiển đổi trạng thái cycle (đóng / mở lại kỳ) — TC_US079_24 kỳ vọng KHÔNG có. */
  readonly cycleStatusControls: Locator;

  constructor(
    private readonly page: Page,
    private readonly list: FeeReviewListPage,
  ) {
    this.cycleOptions = list.cycleSelect.locator('option');
    this.productIdCells = list.rows.locator(`td:nth-child(${LIST_COL.productId + 1})`);
    this.searchAnyState = page.getByRole('button', { name: new RegExp(`^\\s*(검색|Search|${esc(FR_KO['btn.searching'])}|${esc(FR_EN['btn.searching'])})`) });
    this.currentPage = list.pagination.locator('li', { hasText: '(current)' });
    this.pageNumbers = list.pagination.locator('li').filter({ hasText: /^\s*\d+/ });
    this.rowCheckboxes = list.rows.getByRole('checkbox');
    this.cycleStatusControls = page.getByRole('button', { name: /마감|재오픈|다시 열기|Close period|Reopen/ });
  }

  /** Mọi dòng của 1 sản phẩm (sản phẩm bán theo 2 chính sách = 2 dòng). */
  rowsOf(productId: string): Locator {
    return this.list.rows.filter({ has: this.page.getByRole('cell', { name: productId, exact: true }) });
  }

  /** Chip đang đọc đúng số `count` (tên nút = "N nhãn" — recon `button "12 기간 내 판매 상품"`). */
  chipReading(key: ChipKey, count: number): Locator {
    return this.page.getByRole('button', { name: new RegExp(`^${count} (${esc(FR_KO[key])}|${esc(FR_EN[key])})$`) });
  }

  /** Tổng trên pager "총 N개의 상품 중 a-b개 표시"; không có pager → null. */
  async pagerTotal(): Promise<number | null> {
    if (!(await this.list.counter.count())) return null;
    return Number(/(\d+)/.exec(await this.list.counter.innerText())?.[1] ?? NaN);
  }

  /** Số trên cả 10 chip. */
  async chipCounts(): Promise<Record<ChipKey, number>> {
    const counts = {} as Record<ChipKey, number>;
    for (const key of ALL_CHIPS) counts[key] = await this.list.chipCount(this.list.chip(key));
    return counts;
  }

  /**
   * Chạy `action` và chờ GET products tối đa `ms` — dùng cho thao tác TC kỳ vọng tự chạy query nhưng dev có thể không
   * chạy (đổi cycle, 초기화, Enter…). Không có request → trả null (để step Assert kết luận), không làm vỡ step Act.
   */
  async maybeListed(action: () => Promise<void>, ms = 10_000): Promise<Response | null> {
    const listed = this.page.waitForResponse((r) => r.request().method() === 'GET' && LIST_URL.test(r.url()), { timeout: ms }).catch(() => null);
    await action();
    const response = await listed;
    await expect(this.list.loading, 'The fee review list finishes loading').toHaveCount(0, { timeout: 20_000 });
    return response;
  }

  /** Ghi lại mọi URL GET products mà trang gửi từ lúc gọi (để kiểm "query có chạy không" và tham số của nó). */
  trackListRequests(): string[] {
    const urls: string[] = [];
    this.page.on('request', (r) => {
      if (r.method() === 'GET' && LIST_URL.test(r.url())) urls.push(r.url());
    });
    return urls;
  }

  /** Cycle id trong URL GET products. */
  static cycleOf(url: string): string {
    return LIST_URL.exec(url)?.[1] ?? '';
  }

  /** Chọn cycle theo id (giá trị option) — dùng khi nhãn option có thể kèm dấu hiệu khác ngoài YYYY-MM. */
  async selectCycleById(cycleId: number): Promise<void> {
    await test.step(`Select cycle ${cycleId} in 정산 주기 (Settlement cycle)`, async () => {
      await this.list.cycleSelect.selectOption(String(cycleId));
    });
  }

  /** Bấm 검색 trong lúc giữ response của GET products → đọc trạng thái nút khi query đang chạy, rồi thả response. */
  async searchObservingBusy(): Promise<boolean> {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await this.page.route(LIST_URL, async (route) => {
      await gate;
      await route.continue();
    });
    const done = this.list.untilListed(() => this.list.click(this.list.searchButton, '검색 (Search) button'));
    const busyDisabled = await expect(this.searchAnyState, 'The Search button while the query runs')
      .toBeDisabled({ timeout: 5_000 })
      .then(() => true, () => false);
    release();
    await done;
    await this.page.unroute(LIST_URL);
    return busyDisabled;
  }

  /** Style tính toán của phần tử (độ mờ + con trỏ) — đo "looks disabled". */
  static async lookOf(locator: Locator): Promise<{ opacity: number; cursor: string }> {
    return locator.evaluate((el) => {
      const style = getComputedStyle(el);
      return { opacity: Number(style.opacity), cursor: style.cursor };
    });
  }
}
