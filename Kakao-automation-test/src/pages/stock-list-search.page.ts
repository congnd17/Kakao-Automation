import { Locator, Page, Response, test } from '@playwright/test';
import { StockListPage, escapeRegex } from './stock-list.page';
import type { ListPage, StockSearchField, StockStatusRow } from '@api/stock.api';

/** 1 lượt tải list (GET /stock-status) — URL đã gửi + dữ liệu server trả. */
export interface ListLoad {
  url: URL;
  status: number;
  items: StockStatusRow[];
  totalCount: number;
}

/** Chữ pager theo TC (`총 N개의 항목 …`) — UI host hiện itemName 재고 (`stock.pager.itemName`). */
export const TC_PAGER_ITEM_NAME = '항목';

const isListResponse = (response: Response) => response.url().includes('/api/v1/stock-status?') && response.request().method() === 'GET';

/**
 * Bổ sung cho `StockListPage` dành cho nhóm [List] tìm kiếm / filter (TC_US134_22–45): đếm request list, chờ 1 lượt tải
 * và đọc dữ liệu server trả, đọc option các select, gõ từng ký tự, Enter trong ô từ khoá, bỏ chọn react-select.
 * Draft filter chỉ áp dụng khi bấm 검색 / Enter (bundle `bqt`); 초기화 áp dụng ngay; 검색 xoá dòng đã tick, 초기화 thì không.
 */
export class StockListSearchPage {
  /** URL mọi request GET /stock-status phát ra từ lúc tạo object. */
  readonly listRequests: string[] = [];

  constructor(
    private readonly page: Page,
    readonly list: StockListPage,
  ) {
    page.on('request', (request) => {
      if (request.method() === 'GET' && request.url().includes('/api/v1/stock-status?')) this.listRequests.push(request.url());
    });
  }

  /** Cột filter 창고 (nhãn + control) — vẫn đúng khi control là dòng "không có kho". */
  get warehouseColumn(): Locator {
    return this.list.filterLabel('filter.warehouse').locator('xpath=..');
  }

  /** Dòng "선택 가능한 창고가 없습니다" thay cho react-select khi danh mục kho rỗng. */
  get noWarehousesLine(): Locator {
    return this.warehouseColumn.locator('.form-control.text-muted');
  }

  /** Placeholder 전체 của react-select (hiện khi chưa chọn giá trị nào). */
  placeholder(control: 'warehouse' | 'bizPartner'): Locator {
    return (control === 'warehouse' ? this.list.warehouseMulti : this.list.bizPartnerMulti).locator('[class*="placeholder"]');
  }

  /** Mọi ô tick đang được tick trong thân bảng. */
  get tickedBoxes(): Locator {
    return this.list.table.locator('tbody input[type="checkbox"]:checked');
  }

  /** Chạy `action` rồi đợi 1 lượt GET /stock-status trả về và bảng hiện lại. */
  async load(action: () => Promise<void>): Promise<ListLoad> {
    const responsePromise = this.page.waitForResponse(isListResponse, { timeout: 30_000 });
    await action();
    const response = await responsePromise;
    const body = (await response.json().catch(() => null)) as ListPage<StockStatusRow> | null;
    await this.list.waitForList();
    return { url: new URL(response.url()), status: response.status(), items: body?.items ?? [], totalCount: body?.paging?.totalCount ?? -1 };
  }

  async clickSearch(): Promise<ListLoad> {
    return this.load(() => this.list.click(this.list.searchButton, `${this.list.t('btn.search')} button`));
  }

  async clickReset(): Promise<ListLoad> {
    return this.load(() => this.list.click(this.list.resetButton, `${this.list.t('btn.reset')} button`));
  }

  /** Chọn 검색조건, thay từ khoá rồi bấm 검색 — trả về lượt tải list. */
  async searchBy(field: StockSearchField, keyword: string): Promise<ListLoad> {
    return test.step(`Search ${field} = "${keyword}"`, async () => {
      await this.list.chooseSearchField(field);
      await this.list.typeKeyword(keyword);
      return this.clickSearch();
    });
  }

  /** Bấm Enter khi con trỏ đang ở ô từ khoá. */
  async pressEnterInKeyword(): Promise<ListLoad> {
    return this.load(async () => {
      await test.step('Press Enter in the keyword box', async () => {
        await this.list.keywordInput.press('Enter');
      });
    });
  }

  /** Gõ từ khoá từng ký tự (thay nội dung cũ) — không bấm gì khác. */
  async typeSlowly(text: string): Promise<void> {
    await test.step(`Type "${text}" one character at a time into the keyword box`, async () => {
      await this.list.keywordInput.click();
      await this.list.keywordInput.clear();
      await this.list.keywordInput.pressSequentially(text);
    });
  }

  async selectByLabel(select: Locator, label: string, description: string): Promise<void> {
    await test.step(`Choose "${label || 'All'}" in ${description}`, async () => {
      await select.selectOption({ label });
    });
  }

  async optionTexts(select: Locator): Promise<string[]> {
    return (await select.locator('option').allInnerTexts()).map((text) => text.trim());
  }

  async selectedText(select: Locator): Promise<string> {
    return select.evaluate((element: HTMLSelectElement) => element.selectedOptions[0]?.textContent?.trim() ?? '');
  }

  /** Bỏ chọn 1 giá trị đã chọn trong react-select (menu giữ cả lựa chọn đã chọn — bấm lại để bỏ). */
  async unpickMulti(control: 'warehouse' | 'bizPartner', optionName: string): Promise<void> {
    await test.step(`Unpick ${control} "${optionName}"`, async () => {
      const input = control === 'warehouse' ? this.list.warehouseInput : this.list.bizPartnerInput;
      await input.click();
      await input.fill(optionName);
      await this.page.locator('[id^="react-select-"][id*="-option-"]').filter({ hasText: new RegExp(`^${escapeRegex(optionName)}$`) }).first().click();
      await this.page.keyboard.press('Escape');
    });
  }

  /** Nhãn các control của khối filter, trái → phải. */
  async filterLabels(): Promise<string[]> {
    return (await this.list.filterRow.locator('label.form-label').allInnerTexts()).map((text) => text.trim());
  }

  /** SKU코드 của mọi dòng dữ liệu đang hiển thị, theo thứ tự bảng. */
  async visibleSkuCodes(): Promise<string[]> {
    return this.list.columnValues('col.skuCode');
  }

  /** Dòng đếm của pager: số khớp tuyệt đối, tên mục bất kỳ (UI: 재고, TC: 항목). */
  pagerPattern(total: number, from: number, to: number): RegExp {
    return new RegExp(`^총 (${total}|${escapeRegex(total.toLocaleString('en-US'))})개의 .+ 중 ${from}-${to}개 표시$`);
  }

  /** Dòng đếm đúng chữ TC ghi. */
  tcPagerText(total: number, from: number, to: number): string {
    return `총 ${total.toLocaleString('en-US')}개의 ${TC_PAGER_ITEM_NAME} 중 ${from}-${to}개 표시`;
  }
}
