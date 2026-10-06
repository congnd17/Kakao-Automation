import { Page, Locator, Request, Route, test } from '@playwright/test';
import { BasePage } from './base.page';
import { STOCK_COLUMN_KEYS, StockColumnKey, StockListPage } from './stock-list.page';

/** Nút điều hướng của pager dùng chung (react-bootstrap Pagination: «, ‹, ›, » mang chữ ẩn First/Previous/Next/Last). */
export type PagerControl = 'First' | 'Previous' | 'Next' | 'Last';

/** Request đang bị giữ lại (thay cho network throttling) — test kiểm trạng thái nút trong lúc request chưa trả về. */
export interface HeldRequest {
  /** Resolve khi request khớp đã được trình duyệt gửi (và đang bị giữ). */
  seen: Promise<Request>;
  /** Thả request cho đi tiếp tới server. */
  release: () => void;
  /** Gỡ route giữ request. */
  dispose: () => Promise<void>;
}

/**
 * Phần mở rộng cho nhóm [List] (TC_US134_46–70) trên màn 재고 관리: pager (nút trang, ô 페이지당, dòng đếm),
 * ô tick, 2 thanh cuộn ngang (thanh trên `.custom-thick-scrollbar` đồng bộ với khung `.table-responsive`), dòng
 * "검색 결과가 없습니다.". Dùng kèm `StockListPage` dùng chung (không sửa file đó). Verify bundle + recon 05/10/2026.
 */
export class StockListPagingPage extends BasePage {
  readonly topScrollbar: Locator;
  readonly tableScroller: Locator;
  readonly checkedRowBoxes: Locator;
  readonly pageSizeOptions: Locator;

  constructor(page: Page, private readonly list: StockListPage) {
    super(page);
    this.topScrollbar = list.card.locator('div.custom-thick-scrollbar:not(.table-responsive)').first();
    this.tableScroller = list.card.locator('div.table-responsive').first();
    this.checkedRowBoxes = list.table.locator('tbody input[type="checkbox"]:checked');
    this.pageSizeOptions = list.pageSizeSelect.locator('option');
  }

  /** Nút điều hướng pager (bản bật là `a[role=button]`, bản tắt là `span`) — tìm theo chữ ẩn. */
  pagerControl(name: PagerControl): Locator {
    return this.list.pagination.locator('li.page-item').filter({ has: this.page.locator('.visually-hidden', { hasText: new RegExp(`^${name}$`) }) });
  }

  /** Mọi nút số trang của pager. */
  get pageNumberItems(): Locator {
    return this.list.pagination.locator('li.page-item').filter({ hasText: /^\s*\d+/ });
  }

  /** Số trang đang mở (1-based) theo ô `li.active`; pager ẩn (≤ 1 trang) → 1. */
  async currentPage(): Promise<number> {
    if ((await this.list.pagination.count()) === 0) return 1;
    const text = (await this.list.activePage.first().innerText()).replace(/\(current\)/, '').trim();
    return Number(text);
  }

  /** Bấm nút điều hướng pager và đợi list tải lại (không bấm 검색). */
  async clickPager(name: PagerControl): Promise<void> {
    await this.list.waitForListReload(() => this.click(this.pagerControl(name).locator('a[role="button"]'), `pagination button ${name}`));
  }

  /** Regex dòng đếm "총 N개의 <item> 중 a-b개 표시" của pager dùng chung. */
  static countLine(total: number, start: number, end: number): RegExp {
    return new RegExp(`^총 ${total}개의 .+ 중 ${start}-${end}개 표시$`);
  }

  /** Bấm ô tick ở dòng tiêu đề (chọn tất cả) — `force` để vẫn bấm được khi ô bị tắt. */
  async clickSelectAll(): Promise<void> {
    await test.step('Click the header tick box (select all)', async () => {
      await this.list.selectAllCheckbox.click({ force: true });
    });
  }

  /** Thử bấm ô tick của dòng dù ô bị tắt (TC "try to tick"). */
  async tryTick(row: Locator, description: string): Promise<void> {
    await test.step(`Try to tick the row ${description}`, async () => {
      await this.list.checkbox(row).click({ force: true });
    });
  }

  /** Ô tiêu đề theo khoá cột. */
  headerCell(column: StockColumnKey): Locator {
    return this.list.headerCells.nth(STOCK_COLUMN_KEYS.indexOf(column));
  }

  /** Cuộn thanh cuộn ngang phía trên bảng tới `left` px (tương đương kéo thanh cuộn). */
  async scrollTopBarTo(left: number): Promise<void> {
    await test.step(`Drag the top sideways scrollbar to ${left}px`, async () => {
      await this.topScrollbar.evaluate((element, value) => {
        element.scrollLeft = value;
        element.dispatchEvent(new Event('scroll'));
      }, left);
    });
  }

  async scrollLeftOf(locator: Locator): Promise<number> {
    return locator.evaluate((element) => Math.round(element.scrollLeft));
  }

  /** scrollWidth / clientWidth của khung cuộn — có thanh cuộn ngang khi scrollWidth > clientWidth. */
  async scrollExtent(locator: Locator): Promise<{ scrollWidth: number; clientWidth: number }> {
    return locator.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  }

  /** Cạnh phải của ô so với cạnh trái khung cuộn bảng (≤ 0 → ô đã cuộn khuất bên trái). */
  async rightEdgeFromScrollerLeft(cell: Locator): Promise<number> {
    const scroller = await this.tableScroller.boundingBox();
    const box = await cell.boundingBox();
    if (!scroller || !box) throw new Error('The table and the cell must be rendered to measure the scroll position');
    return Math.round(box.x + box.width - scroller.x);
  }

  /** CSS position / left đã tính của ô — kiểm tra có luật ghim cột (sticky) hay không. */
  async pinningStyle(cell: Locator): Promise<{ position: string; left: string }> {
    return cell.evaluate((element) => {
      const style = window.getComputedStyle(element);
      return { position: style.position, left: style.left };
    });
  }

  /**
   * Giữ request API khớp `match` cho tới khi gọi `release()` (thay cho bật network throttling): test thấy được trạng
   * thái "đang chạy" của nút mà không cần chờ cứng.
   */
  async holdRequest(match: (url: string, method: string) => boolean): Promise<HeldRequest> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markSeen!: (request: Request) => void;
    const seen = new Promise<Request>((resolve) => {
      markSeen = resolve;
    });
    const handler = async (route: Route) => {
      const request = route.request();
      if (!match(request.url(), request.method())) {
        await route.fallback();
        return;
      }
      markSeen(request);
      await gate;
      await route.continue();
    };
    await this.page.route('**/api/v1/**', handler);
    return { seen, release, dispose: () => this.page.unroute('**/api/v1/**', handler) };
  }

  /** Ghi lại mọi request GET /stock-status (list) gửi đi trong lúc chạy `action`. */
  async listRequestsDuring(action: () => Promise<void>): Promise<URL[]> {
    const urls: URL[] = [];
    const listener = (request: Request) => {
      if (request.method() === 'GET' && /\/api\/v1\/stock-status\?/.test(request.url())) urls.push(new URL(request.url()));
    };
    this.page.on('request', listener);
    try {
      await action();
    } finally {
      this.page.off('request', listener);
    }
    return urls;
  }
}
