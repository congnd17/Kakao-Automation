import { test, expect } from '@fixtures/stock.fixture';
import type { Locator } from '@playwright/test';
import type { StockApi } from '@api/stock.api';
import { makeStep } from '@utils/step';
import { skipTc, tcMeta } from '@utils/tc-meta';
import { StockListPage } from '@pages/stock-list.page';
import { StockListPagingPage } from '@pages/stock-list-paging.page';
import { STOCK_LANGS, StockTextKey, stx } from '@utils/stock.i18n';
import { LANG_SUFFIX, WORLD_NOTE, stockTags } from '@utils/stock-spec';
import { DemoKey, StockWorld, WorldSku, uniqueCode } from '@utils/stock.data';
import { stockDb } from '@utils/stock-db';
import { xlsxFile } from '@utils/xlsx-writer';

/**
 * US134 — nhóm [List] (TC_US134_46–70): 정렬, 페이지당, nút trang, xoá ô tick khi đổi trang / đổi sort / lưu thành công,
 * dòng đếm, dòng "검색 결과가 없습니다.", ô tick tắt với SKU 디지털 / Set, chọn tất cả, link 상품코드, giá trị định danh,
 * múi giờ, nút 재고이력, 2 thanh cuộn ngang, guard thiếu chọn / thiếu kho, tooltip 할당대기재고, nút tắt khi đang gọi API.
 * Nguồn TC: SCRATCH/us134/TC_US134_<n>.txt — Steps N / Expected N → `Act: Step N` / `Assert: Expected N`.
 * Dữ liệu: world dùng chung (lọc 상품코드명 = tag ra đúng 12 dòng); TC ghi dữ liệu (TC_58, TC_70) tự tạo SKU riêng
 * (상품코드명 KHÔNG chứa tag để không lọt vào 12 dòng của test khác). TC cần thứ tự 생성일 của TC (trang 2 = 2 dòng 디지털)
 * tạm đặt `sku.created_at` / `sku_group.created_at` của world theo ngày TC rồi trả lại trong `finally`.
 */
const TAGS = stockTags('list');

const NO_ORDER_REASON =
  'Pre-condition 2 needs specific 미확보 출고수량 (Unsecured outbound quantity) values (60 on DEMO-SKU-0003, 30 on DEMO-SKU-0001, 6 on DEMO-SKU-0008). That column comes from commerce orders (KakaoEnt BRZ-14801 / interim mock) and this admin cannot create orders, so every world row shows 0 and the ordering under test cannot be built.';

const COUNT_LINE_NOTE =
  'Count lines are checked on their numbers: the shared pager names the items 재고 (stock) — "총 N개의 재고 중 a-b개 표시" — where the TC writes 항목.';

/** 생성일 của TC (giờ Seoul), mới nhất trước: 0011 = 2026-09-02 … 0006 / 0010 = 2026-07-30; 0001 = 2026-08-11 01:30 KST (UTC còn là 08-10). */
const TC_CREATED_ORDER: Array<[DemoKey, string]> = [
  ['SKU0011', '2026-09-02T10:00:00+09:00'],
  ['SKU0012', '2026-09-01T10:00:00+09:00'],
  ['SKU0005', '2026-08-30T10:00:00+09:00'],
  ['SKU0007', '2026-08-25T10:00:00+09:00'],
  ['SKU0009', '2026-08-20T10:00:00+09:00'],
  ['SKU0008', '2026-08-18T12:00:00+09:00'],
  ['SKU0003', '2026-08-18T11:00:00+09:00'],
  ['SKU0004', '2026-08-18T10:00:00+09:00'],
  ['SKU0001', '2026-08-11T01:30:02+09:00'],
  ['SKU0002', '2026-08-11T01:30:01+09:00'],
  ['SKU0006', '2026-07-30T12:00:00+09:00'],
  ['SKU0010', '2026-07-30T11:00:00+09:00'],
];

const PHYSICAL_KEYS: DemoKey[] = ['SKU0011', 'SKU0005', 'SKU0009', 'SKU0008', 'SKU0003', 'SKU0004', 'SKU0001', 'SKU0002'];
const PARTNER_A_KEYS: DemoKey[] = ['SKU0001', 'SKU0002', 'SKU0003', 'SKU0004', 'SKU0008', 'SKU0009', 'SKU0007'];

const toDbTime = (iso: string): string => new Date(iso).toISOString().replace('T', ' ').replace('Z', '');

/**
 * Tạm đặt 생성일 của 12 SKU world (và nhóm SKU = SKU mới nhất của nhóm) theo TC_CREATED_ORDER. Trả về hàm khôi phục giá trị
 * gốc (giữ nguyên micro giây) — gọi trong `finally`.
 */
async function arrangeTcCreatedDates(world: StockWorld): Promise<() => Promise<void>> {
  const skus = TC_CREATED_ORDER.map(([key]) => world.sku(key));
  const skuIds = skus.map((sku) => sku.skuId);
  const groupIds = [...new Set(skus.map((sku) => sku.groupId))];
  const skuRows = await stockDb.query("SELECT id, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS c FROM sku WHERE id IN (?)", [skuIds]);
  const groupRows = await stockDb.query("SELECT id, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS c FROM sku_group WHERE id IN (?)", [groupIds]);
  const restore = async () => {
    for (const row of skuRows) await stockDb.exec('UPDATE sku SET created_at = ? WHERE id = ?', [row.c, row.id]);
    for (const row of groupRows) await stockDb.exec('UPDATE sku_group SET created_at = ? WHERE id = ?', [row.c, row.id]);
  };
  const doneGroups = new Set<number>();
  try {
    for (const [key, iso] of TC_CREATED_ORDER) {
      const sku = world.sku(key);
      await stockDb.exec('UPDATE sku SET created_at = ? WHERE id = ?', [toDbTime(iso), sku.skuId]);
      if (!doneGroups.has(sku.groupId)) {
        doneGroups.add(sku.groupId);
        await stockDb.exec('UPDATE sku_group SET created_at = ? WHERE id = ?', [toDbTime(iso), sku.groupId]);
      }
    }
  } catch (error) {
    await restore();
    throw error;
  }
  return restore;
}

/** Thứ tự SKU ID của 12 dòng world theo API (sort CREATED_AT desc) — kiểm bước Arrange đã dựng đúng thứ tự TC. */
async function worldOrderFromApi(world: StockWorld, api: StockApi): Promise<number[]> {
  const { body } = await api.stockStatus({ searchType: 'SKU_GROUP_NAME', keyword: world.keyword, sort: 'CREATED_AT,desc', page: 0, size: 20 });
  return body.items.map((item) => item.skuId);
}

/** Mở list và lọc 상품코드명 = tag → đúng 12 dòng world. */
async function openWorldList(list: StockListPage, world: StockWorld): Promise<void> {
  await list.open();
  await list.search('SKU_GROUP_NAME', world.keyword);
}

/** SKU 현물 riêng của test (Partner A · Demo Manufacturer 1), 상품코드 / 상품코드명 không chứa tag world. */
async function createOwnPhysical(world: StockWorld, label: string, options: string[]): Promise<WorldSku[]> {
  const groupCode = uniqueCode(`P${world.tag.slice(4)}`, label);
  return world.createPhysicalSku(label, {
    partner: world.partners.A,
    manufacturer: world.manufacturers.M1,
    groupCode,
    groupName: `Auto list ${groupCode}`,
    lines: options.map((option) => ({ option })),
  });
}

/** Ngày YYYY-MM-DD theo giờ Seoul, cách hôm nay `days` ngày. */
function kstDate(days: number): string {
  return new Date(Date.now() + days * 86_400_000 + 9 * 3_600_000).toISOString().slice(0, 10);
}

const normalize = (text: string | null): string => (text ?? '').replace(/\s+/g, ' ').trim();

test.describe('[List] Stock management — sorting, paging, selection and row actions', () => {
  test.describe.configure({ timeout: 240_000 });

  test('TC_US134_46 — The sort control has exactly 2 choices and re-runs the list at once without Search', async () => {
    await skipTc(
      'TC_US134_46',
      'Medium',
      TAGS,
      'The 정렬 (Sort) list offers exactly 최근 등록 순 (default) and 미확보 출고수량 내림차순; choosing the second sends one list request without Search and the table starts with DEMO-SKU-0003 (60), DEMO-SKU-0001 (30), DEMO-SKU-0008 (6).',
      NO_ORDER_REASON,
    );
  });

  test('TC_US134_47 — Changing the sort returns to page 1, clears ticked rows and keeps the applied filters', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const paging = new StockListPagingPage(page, list);
    await tcMeta(
      'TC_US134_47',
      'Medium',
      TAGS,
      `With 비즈파트너 = Demo Partner A applied (7 rows), ticking a physical row and then switching 정렬 to 미확보 출고수량 내림차순 keeps the same 7 rows ordered highest first, sends page 0, clears every tick box and leaves Demo Partner A in the filter. The list is narrowed to the world rows with 상품코드명 = run tag before the partner filter (Demo Partner A is a real dev partner with other data). Every world row shows 미확보 출고수량 0, so "highest first" is checked as a non-increasing column plus the sort sent in the request. ${WORLD_NOTE}`,
    );
    const partnerA = world.partners.A;

    await step('Arrange: Pre-condition 1–2 — Logged in with write access, stock data present, 페이지당 = 10', async () => {
      expect(PARTNER_A_KEYS.every((key) => world.sku(key).partner.id === partnerA.id), 'The 7 world rows of Demo Partner A exist').toBe(true);
    });

    await step('Act: Step 1 — Open 재고 관리, set 비즈파트너 (Biz partner) to Demo Partner A and click 검색 (Search)', async () => {
      await list.open();
      await list.chooseSearchField('SKU_GROUP_NAME');
      await list.typeKeyword(world.keyword);
      await list.pickMulti('bizPartner', partnerA.nameKo);
      await list.clickSearch();
    });

    await step('Assert: Expected 1 — Only the 7 rows for Demo Partner A are listed', async () => {
      expect(await list.dataRowCount(), '[Expected 1] Exactly 7 rows are listed').toBe(7);
      for (const key of PARTNER_A_KEYS) {
        await expect(list.rowBySkuId(world.sku(key).skuId), `[Expected 1] ${world.sku(key).skuCode} (Demo Partner A) is listed`).toBeVisible();
      }
    });

    const ticked = world.sku('SKU0001');
    await step('Act: Step 2 — Tick a physical row on page 1', async () => {
      await list.tick(list.row(ticked.skuCode), ticked.skuCode);
    });

    await step('Assert: Expected 2 — One physical row is ticked', async () => {
      await expect(list.checkbox(list.row(ticked.skuCode)), `[Expected 2] ${ticked.skuCode} is ticked`).toBeChecked();
      await expect(paging.checkedRowBoxes, '[Expected 2] Exactly one row is ticked').toHaveCount(1);
    });

    let requests: URL[] = [];
    let unsecured: string[] = [];
    await step('Act: Step 3 — Change 정렬 (Sort) to 미확보 출고수량 내림차순 (Unsecured outbound qty — descending)', async () => {
      requests = await paging.listRequestsDuring(() => list.chooseSort('UNCONFIRMED_OUTGOING_QUANTITY'));
      unsecured = await list.columnValues('col.unconfirmedQuantity');
    });

    await step('Assert: Expected 3 — The same 7 filtered rows remain, reordered by 미확보 출고수량, highest first', async () => {
      expect(requests.length, '[Expected 3] Changing the sort sends one list request').toBe(1);
      expect(requests[0]?.searchParams.get('sort'), '[Expected 3] The list is asked for 미확보 출고수량 descending').toBe('UNCONFIRMED_OUTGOING_QUANTITY,desc');
      expect(requests[0]?.searchParams.get('bizPartnerIds'), '[Expected 3] The request keeps the Demo Partner A filter').toBe(String(partnerA.id));
      expect(await list.dataRowCount(), '[Expected 3] The same 7 rows remain').toBe(7);
      for (const key of PARTNER_A_KEYS) {
        await expect(list.rowBySkuId(world.sku(key).skuId), `[Expected 3] ${world.sku(key).skuCode} is still listed`).toBeVisible();
      }
      const numbers = unsecured.map((value) => (value === '-' ? -1 : Number(value.replace(/,/g, ''))));
      expect(numbers.every((value, index) => index === 0 || value <= numbers[index - 1]), `[Expected 3] 미확보 출고수량 runs from highest to lowest (${unsecured.join(', ')})`).toBe(true);
    });

    await step('Act: Step 4 — Read the pages, the tick boxes and the 비즈파트너 (Biz partner) control', async () => {
      await expect(list.table, 'The list is shown').toBeVisible();
    });

    await step('Assert: Expected 4 — Page 1, no tick box ticked, 비즈파트너 still Demo Partner A with the same 7 rows', async () => {
      expect(requests[0]?.searchParams.get('page'), '[Expected 4] The sort change asks for page 1 (page=0)').toBe('0');
      expect(await paging.currentPage(), '[Expected 4] The list is on page 1').toBe(1);
      await expect(paging.checkedRowBoxes, '[Expected 4] No tick box is ticked').toHaveCount(0);
      await expect(list.selectAllCheckbox, '[Expected 4] The header tick box is not ticked').not.toBeChecked();
      await expect(list.multiValues('bizPartner').filter({ hasText: partnerA.nameKo }), '[Expected 4] 비즈파트너 still shows Demo Partner A').toHaveCount(1);
      expect(await list.dataRowCount(), '[Expected 4] The same 7 rows are listed').toBe(7);
    });
  });

  test('TC_US134_48 — Default sort is newest created first and the alternative sort is unsecured outbound descending', async () => {
    await skipTc(
      'TC_US134_48',
      'Medium',
      TAGS,
      'Without touching 정렬 the rows run by 생성일 newest first (DEMO-SKU-0011 2026.09.02 on top, the two 2026.07.30 rows last); switching to 미확보 출고수량 내림차순 lists 60 (DEMO-SKU-0003), 30 (DEMO-SKU-0001), 6 (DEMO-SKU-0008), then the zeros.',
      NO_ORDER_REASON,
    );
  });

  test('TC_US134_49 — Rows with no stock record sort after the rows showing 0 on the unsecured-outbound sort', async () => {
    await skipTc(
      'TC_US134_49',
      'Medium',
      TAGS,
      'With 페이지당 20개 and 정렬 = 미확보 출고수량 내림차순 the column reads 60, 30, 6, then every 0, and the 3 rows showing - (DEMO-SKU-0005, DEMO-SKU-0006, DEMO-SKU-0010) are the last 3 rows.',
      NO_ORDER_REASON,
    );
  });

  test('TC_US134_50 — Rows-per-page offers 10/20/50/100, defaults to 10 and shows all 12 rows from 20 up', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const paging = new StockListPagingPage(page, list);
    await tcMeta(
      'TC_US134_50',
      'Medium',
      TAGS,
      `페이지당 shows 10개 with 10 rows on open, lists exactly 10개 / 20개 / 50개 / 100개, and 20 / 50 / 100 each show all 12 rows with the count line 1-12 of 12. The 12 demo rows are the world rows (상품코드명 = run tag). ${COUNT_LINE_NOTE} ${WORLD_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–2 — Logged in with write access, the 12 demo rows present', async () => {
      expect(TC_CREATED_ORDER.length, 'The world holds the 12 demo rows').toBe(12);
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management) and read the value in 페이지당 (Rows per page)', async () => {
      await openWorldList(list, world);
    });

    await step('Assert: Expected 1 — The control shows 10개 (10) and the table shows 10 rows', async () => {
      await expect(list.pageSizeSelect, '[Expected 1] 페이지당 holds 10').toHaveValue('10');
      await expect(list.pageSizeSelect.locator('option:checked'), '[Expected 1] 페이지당 shows 10개').toHaveText('10개');
      expect(await list.dataRowCount(), '[Expected 1] The table shows 10 rows').toBe(10);
    });

    let options: string[] = [];
    await step('Act: Step 2 — Open the 페이지당 list and read every choice', async () => {
      options = (await paging.pageSizeOptions.allInnerTexts()).map((text) => text.trim());
    });

    await step('Assert: Expected 2 — Exactly 4 choices: 10개, 20개, 50개, 100개', async () => {
      expect(options.length, '[Expected 2] The list has exactly 4 choices').toBe(4);
      for (const option of ['10개', '20개', '50개', '100개']) {
        expect(options, `[Expected 2] ${option} is offered`).toContain(option);
      }
    });

    for (const [index, size] of [[3, 20], [4, 50], [5, 100]] as const) {
      let rows = 0;
      await step(`Act: Step ${index} — Choose ${size}개 (${size}) and count the rows shown`, async () => {
        await list.choosePageSize(size);
        rows = await list.dataRowCount();
      });

      const expectation = index === 3 ? 'All 12 rows are on one page and the count line reads 총 12개의 항목 중 1-12개 표시' : 'All 12 rows are shown and the count line does not change';
      await step(`Assert: Expected ${index} — ${expectation}`, async () => {
        expect(rows, `[Expected ${index}] All 12 rows are shown`).toBe(12);
        await expect(list.pagerText, `[Expected ${index}] The count line reads total 12, showing 1-12`).toHaveText(StockListPagingPage.countLine(12, 1, 12));
        await expect(list.pagination, `[Expected ${index}] All rows fit on one page (no page buttons)`).toHaveCount(0);
      });
    }
  });

  test('TC_US134_51 — Changing rows-per-page goes back to page 1 and clears the ticked rows', async ({ page, world, stockListPage: list, adjustmentDialog }) => {
    const step = makeStep(page);
    const paging = new StockListPagingPage(page, list);
    await tcMeta(
      'TC_US134_51',
      'Medium',
      TAGS,
      `From page 2 at 10 rows per page, choosing 20개 sends one list request (no Search) for page 0 and shows all 12 rows; after ticking DEMO-SKU-0001 and DEMO-SKU-0003, choosing 50개 clears both ticks, and 재고 조정 then shows the no-selection guard without opening a dialog. ${WORLD_NOTE}`,
    );
    const first = world.sku('SKU0001');
    const third = world.sku('SKU0003');

    await step('Arrange: Pre-condition 1–3 — Logged in with write access, 12 rows on 2 pages at 10 per page, list requests recorded', async () => {
      expect(first.type, 'DEMO-SKU-0001 is physical').toBe('PHYSICAL');
      expect(third.type, 'DEMO-SKU-0003 is physical').toBe('PHYSICAL');
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management) and go to page 2', async () => {
      await openWorldList(list, world);
      await list.goToPage('2');
    });

    await step('Assert: Expected 1 — Page 2 is shown', async () => {
      expect(await paging.currentPage(), '[Expected 1] Page 2 is shown').toBe(2);
    });

    let requests: URL[] = [];
    await step('Act: Step 2 — Change 페이지당 (Rows per page) to 20개, then read the request list and the pages', async () => {
      requests = await paging.listRequestsDuring(() => list.choosePageSize(20));
    });

    await step('Assert: Expected 2 — One list request without Search, back on page 1 with all 12 rows', async () => {
      expect(requests.length, '[Expected 2] Exactly one list request is sent by the control').toBe(1);
      expect(requests[0]?.searchParams.get('size'), '[Expected 2] The request asks for 20 rows').toBe('20');
      expect(requests[0]?.searchParams.get('page'), '[Expected 2] The request asks for page 1 (page=0)').toBe('0');
      expect(await paging.currentPage(), '[Expected 2] The pages go back to page 1').toBe(1);
      expect(await list.dataRowCount(), '[Expected 2] All 12 rows are on page 1').toBe(12);
    });

    await step('Act: Step 3 — Tick the 2 physical rows DEMO-SKU-0001 and DEMO-SKU-0003', async () => {
      await list.tick(list.row(first.skuCode), first.skuCode);
      await list.tick(list.row(third.skuCode), third.skuCode);
    });

    await step('Assert: Expected 3 — Both rows are ticked', async () => {
      await expect(list.checkbox(list.row(first.skuCode)), `[Expected 3] ${first.skuCode} is ticked`).toBeChecked();
      await expect(list.checkbox(list.row(third.skuCode)), `[Expected 3] ${third.skuCode} is ticked`).toBeChecked();
    });

    await step('Act: Step 4 — Change 페이지당 (Rows per page) to 50개 and read the tick boxes', async () => {
      await list.choosePageSize(50);
    });

    await step('Assert: Expected 4 — No tick box is ticked', async () => {
      await expect(paging.checkedRowBoxes, '[Expected 4] No row tick box is ticked').toHaveCount(0);
      await expect(list.selectAllCheckbox, '[Expected 4] The header tick box is not ticked').not.toBeChecked();
    });

    await step('Act: Step 5 — Click 재고 조정 (Stock adjustment)', async () => {
      await list.clickToolbar('btn.adjustStock');
    });

    await step('Assert: Expected 5 — The no-selection message is shown and no dialog opens', async () => {
      await expect(list.guardAlert, `[Expected 5] The message "${stx('guard.noSelection', 'ko')}" is shown`).toHaveText(stx('guard.noSelection', 'ko'));
      await expect(adjustmentDialog.root, '[Expected 5] The 재고 조정 dialog does not open').toHaveCount(0);
      await expect(page.locator('.modal.show[role="dialog"]'), '[Expected 5] No dialog opens').toHaveCount(0);
    });
  });

  test('TC_US134_52 — Page buttons take effect at once and clear the ticked rows', async ({ page, world, stockApi, stockListPage: list }) => {
    const step = makeStep(page);
    const paging = new StockListPagingPage(page, list);
    await tcMeta(
      'TC_US134_52',
      'Medium',
      TAGS,
      `A tick on page 1 is cleared by next-page and previous-page; the last-page button goes to page 2 and the first-page button to page 1, each with one list request and no Search click. To match the TC (page 2 holds only DEMO-SKU-0006 and DEMO-SKU-0010) the world rows' 생성일 are set to the TC dates for this test and restored afterwards. ${WORLD_NOTE}`,
    );
    const ticked = world.sku('SKU0001');
    let restore: () => Promise<void> = async () => undefined;

    try {
      await step('Arrange: Pre-condition 1–2 — Logged in with write access, 12 rows on 2 pages at 10 per page, page 2 = the 2 digital rows', async () => {
        restore = await arrangeTcCreatedDates(world);
        const order = await worldOrderFromApi(world, stockApi);
        expect(order.slice(10), 'Page 2 holds the digital rows DEMO-SKU-0006 and DEMO-SKU-0010').toEqual([world.sku('SKU0006').skuId, world.sku('SKU0010').skuId]);
      });

      await step('Act: Step 1 — Open 재고 관리 (Stock management) and tick a physical row on page 1', async () => {
        await openWorldList(list, world);
        await list.tick(list.row(ticked.skuCode), ticked.skuCode);
      });

      await step('Assert: Expected 1 — That row is ticked and you are on page 1', async () => {
        await expect(list.checkbox(list.row(ticked.skuCode)), `[Expected 1] ${ticked.skuCode} is ticked`).toBeChecked();
        expect(await paging.currentPage(), '[Expected 1] Page 1 is shown').toBe(1);
      });

      await step('Act: Step 2 — Click the next-page button, then read the pages and the tick boxes', async () => {
        await paging.clickPager('Next');
      });

      await step('Assert: Expected 2 — Page 2 is shown and no tick box is ticked', async () => {
        expect(await paging.currentPage(), '[Expected 2] Page 2 is shown').toBe(2);
        await expect(paging.checkedRowBoxes, '[Expected 2] No tick box is ticked').toHaveCount(0);
      });

      await step('Act: Step 3 — Click the previous-page button', async () => {
        await paging.clickPager('Previous');
      });

      await step('Assert: Expected 3 — Page 1 is shown and no tick box is ticked', async () => {
        expect(await paging.currentPage(), '[Expected 3] Page 1 is shown').toBe(1);
        await expect(paging.checkedRowBoxes, '[Expected 3] No tick box is ticked').toHaveCount(0);
        await expect(list.checkbox(list.row(ticked.skuCode)), `[Expected 3] ${ticked.skuCode} is no longer ticked`).not.toBeChecked();
      });

      let lastRequests: URL[] = [];
      let firstRequests: URL[] = [];
      let pageAfterLast = 0;
      let pageAfterFirst = 0;
      await step('Act: Step 4 — Click the last-page button, then the first-page button', async () => {
        lastRequests = await paging.listRequestsDuring(() => paging.clickPager('Last'));
        pageAfterLast = await paging.currentPage();
        firstRequests = await paging.listRequestsDuring(() => paging.clickPager('First'));
        pageAfterFirst = await paging.currentPage();
      });

      await step('Assert: Expected 4 — Last goes to page 2, First goes to page 1, each at once with no Search click', async () => {
        expect(pageAfterLast, '[Expected 4] The last-page button goes to page 2').toBe(2);
        expect(lastRequests.length, '[Expected 4] The last-page button runs the list at once (one request)').toBe(1);
        expect(lastRequests[0]?.searchParams.get('page'), '[Expected 4] The last-page request asks for page 2 (page=1)').toBe('1');
        expect(pageAfterFirst, '[Expected 4] The first-page button goes to page 1').toBe(1);
        expect(firstRequests.length, '[Expected 4] The first-page button runs the list at once (one request)').toBe(1);
        expect(firstRequests[0]?.searchParams.get('page'), '[Expected 4] The first-page request asks for page 1 (page=0)').toBe('0');
      });

      await step('Act: Step 5 — Read the tick boxes', async () => {
        await expect(list.table, 'The list is shown').toBeVisible();
      });

      await step('Assert: Expected 5 — No tick box is ticked', async () => {
        await expect(paging.checkedRowBoxes, '[Expected 5] No tick box is ticked').toHaveCount(0);
      });
    } finally {
      await restore();
    }
  });

  test('TC_US134_53 — Ticked rows are cleared after going to another page and back', async ({ page, world, stockApi, stockListPage: list, adjustmentDialog }) => {
    const step = makeStep(page);
    const paging = new StockListPagingPage(page, list);
    await tcMeta(
      'TC_US134_53',
      'Medium',
      TAGS,
      `DEMO-SKU-0001 and DEMO-SKU-0003 ticked on page 1 are no longer ticked after going to page 2 and back (header tick box too), and 재고 조정 then shows the no-selection guard without opening the dialog. The world rows' 생성일 are set to the TC dates for this test (both rows on page 1) and restored afterwards. ${WORLD_NOTE}`,
    );
    const first = world.sku('SKU0001');
    const third = world.sku('SKU0003');
    let restore: () => Promise<void> = async () => undefined;

    try {
      await step('Arrange: Pre-condition 1–2 — Logged in with write access, the 12 demo rows on 2 pages at 10 per page', async () => {
        restore = await arrangeTcCreatedDates(world);
        const order = await worldOrderFromApi(world, stockApi);
        expect(order.slice(0, 10), 'DEMO-SKU-0001 and DEMO-SKU-0003 are on page 1').toEqual(expect.arrayContaining([first.skuId, third.skuId]));
      });

      await step('Act: Step 1 — Open 재고 관리 and tick the physical rows DEMO-SKU-0001 and DEMO-SKU-0003 on page 1', async () => {
        await openWorldList(list, world);
        await list.tick(list.row(first.skuCode), first.skuCode);
        await list.tick(list.row(third.skuCode), third.skuCode);
      });

      await step('Assert: Expected 1 — Both rows are ticked', async () => {
        await expect(list.checkbox(list.row(first.skuCode)), `[Expected 1] ${first.skuCode} is ticked`).toBeChecked();
        await expect(list.checkbox(list.row(third.skuCode)), `[Expected 1] ${third.skuCode} is ticked`).toBeChecked();
      });

      await step('Act: Step 2 — Go to page 2', async () => {
        await list.goToPage('2');
      });

      await step('Assert: Expected 2 — Page 2 is shown and no row is ticked', async () => {
        expect(await paging.currentPage(), '[Expected 2] Page 2 is shown').toBe(2);
        await expect(paging.checkedRowBoxes, '[Expected 2] No row is ticked').toHaveCount(0);
      });

      await step('Act: Step 3 — Go back to page 1 and read the tick boxes', async () => {
        await list.goToPage('1');
      });

      await step('Assert: Expected 3 — On page 1 DEMO-SKU-0001, DEMO-SKU-0003 and the header tick box are not ticked', async () => {
        expect(await paging.currentPage(), '[Expected 3] Page 1 is shown').toBe(1);
        await expect(list.checkbox(list.row(first.skuCode)), `[Expected 3] ${first.skuCode} is not ticked`).not.toBeChecked();
        await expect(list.checkbox(list.row(third.skuCode)), `[Expected 3] ${third.skuCode} is not ticked`).not.toBeChecked();
        await expect(list.selectAllCheckbox, '[Expected 3] The header tick box is not ticked').not.toBeChecked();
      });

      await step('Act: Step 4 — Click 재고 조정 (Stock adjustment)', async () => {
        await list.clickToolbar('btn.adjustStock');
      });

      await step('Assert: Expected 4 — The no-selection message is shown and the 재고 조정 dialog does not open', async () => {
        await expect(list.guardAlert, `[Expected 4] The message "${stx('guard.noSelection', 'ko')}" is shown`).toHaveText(stx('guard.noSelection', 'ko'));
        await expect(adjustmentDialog.root, '[Expected 4] The 재고 조정 dialog does not open').toHaveCount(0);
      });
    } finally {
      await restore();
    }
  });

  test('TC_US134_54 — The count line shows the right total and shown range', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const paging = new StockListPagingPage(page, list);
    await tcMeta(
      'TC_US134_54',
      'Medium',
      TAGS,
      `The count line reads 1-10 of 12 on page 1, 11-12 of 12 on page 2, 1-8 of 8 after SKU유형 = 현물 + 검색, and still 1-8 of 8 at 20 per page. ${COUNT_LINE_NOTE} ${WORLD_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–2 — Logged in with write access, 12 rows of which 8 are 현물 (Physical)', async () => {
      expect(PHYSICAL_KEYS.every((key) => world.sku(key).type === 'PHYSICAL'), 'The world holds 8 physical SKUs').toBe(true);
    });

    await step('Act: Step 1 — Open 재고 관리 with 페이지당 = 10 and read the count line', async () => {
      await openWorldList(list, world);
    });

    await step('Assert: Expected 1 — The count line reads 총 12개의 항목 중 1-10개 표시', async () => {
      await expect(list.pagerText, '[Expected 1] Total 12, showing 1-10').toHaveText(StockListPagingPage.countLine(12, 1, 10));
    });

    await step('Act: Step 2 — Click the next-page button and read the count line', async () => {
      await paging.clickPager('Next');
    });

    await step('Assert: Expected 2 — The count line reads 총 12개의 항목 중 11-12개 표시', async () => {
      await expect(list.pagerText, '[Expected 2] Total 12, showing 11-12').toHaveText(StockListPagingPage.countLine(12, 11, 12));
    });

    await step('Act: Step 3 — Set SKU유형 (SKU type) to 현물 (Physical), click 검색 (Search) and read the count line', async () => {
      await list.chooseSkuType('PHYSICAL');
      await list.clickSearch();
    });

    await step('Assert: Expected 3 — The count line reads 총 8개의 항목 중 1-8개 표시', async () => {
      await expect(list.pagerText, '[Expected 3] Total 8, showing 1-8').toHaveText(StockListPagingPage.countLine(8, 1, 8));
    });

    await step('Act: Step 4 — Change 페이지당 (Rows per page) to 20개 and read the count line', async () => {
      await list.choosePageSize(20);
    });

    await step('Assert: Expected 4 — The count line reads 총 8개의 항목 중 1-8개 표시', async () => {
      await expect(list.pagerText, '[Expected 4] Total 8, showing 1-8').toHaveText(StockListPagingPage.countLine(8, 1, 8));
    });
  });

  test('TC_US134_55 — The list changes only after Search is clicked', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const paging = new StockListPagingPage(page, list);
    const daegu = world.warehouses.DAEGU;
    const extra = world.sku('SKU0004');
    await tcMeta(
      'TC_US134_55',
      'Medium',
      TAGS,
      `After 창고 = CJ Daegu warehouse + 검색 the 3 Daegu rows are listed (1-3 of 3); changing 창고 to Demo Pickup Point and typing ZZZZ without Search changes the controls but neither the table nor the count line, and no list request is sent. The world holds 2 rows in CJ Daegu (DEMO-SKU-0003, DEMO-SKU-0008); a third row DEMO-SKU-0004 @ CJ Daegu is seeded for this test and removed afterwards. ${COUNT_LINE_NOTE} ${WORLD_NOTE}`,
    );
    test.skip(!daegu, world.daeguUnavailableReason ?? 'The CJ Daegu warehouse is not available on dev');
    if (!daegu) return;
    const daeguKeys: DemoKey[] = ['SKU0003', 'SKU0008', 'SKU0004'];

    try {
      await step('Arrange: Pre-condition 1–2 — Logged in with write access, 3 stock rows in CJ Daegu warehouse', async () => {
        await stockDb.upsertStock(extra.skuId, daegu.id, { available: 7, csManaged: false });
        expect(await stockDb.stock(extra.skuId, daegu.id), 'The third CJ Daegu row exists').toBeDefined();
      });

      await step('Act: Step 1 — Open 재고 관리, set 창고 (Warehouse) to CJ Daegu warehouse and click 검색 (Search)', async () => {
        await list.open();
        await list.pickMulti('warehouse', daegu.name);
        await list.clickSearch();
      });

      await step('Assert: Expected 1 — The list runs again', async () => {
        await expect(list.multiValues('warehouse').filter({ hasText: daegu.name }), '[Expected 1] The list runs with CJ Daegu warehouse applied').toHaveCount(1);
        await expect(list.rowBySkuId(world.sku('SKU0003').skuId), '[Expected 1] The list shows the CJ Daegu rows').toBeVisible();
      });

      let rowsBefore: string[] = [];
      await step('Act: Step 2 — Read the table and the count line', async () => {
        rowsBefore = await list.columnValues('col.skuId');
      });

      await step('Assert: Expected 2 — The 3 rows in CJ Daegu warehouse are listed; count line 총 3개의 항목 중 1-3개 표시', async () => {
        expect(rowsBefore.length, '[Expected 2] Exactly 3 rows are listed').toBe(3);
        for (const key of daeguKeys) {
          await expect(list.rowBySkuId(world.sku(key).skuId, daegu.name), `[Expected 2] ${world.sku(key).skuCode} in CJ Daegu warehouse is listed`).toBeVisible();
        }
        await expect(list.pagerText, '[Expected 2] Total 3, showing 1-3').toHaveText(StockListPagingPage.countLine(3, 1, 3));
      });

      let requests: URL[] = [];
      await step('Act: Step 3 — Without Search, change 창고 to Demo Pickup Point and type ZZZZ into the keyword box', async () => {
        requests = await paging.listRequestsDuring(async () => {
          await list.warehouseInput.click();
          await page.keyboard.press('Backspace');
          await page.keyboard.press('Escape');
          await list.pickMulti('warehouse', world.warehouses.PICKUP.name);
          await list.typeKeyword('ZZZZ');
        });
      });

      await step('Assert: Expected 3 — Both controls show the new values', async () => {
        await expect(list.multiValues('warehouse').filter({ hasText: world.warehouses.PICKUP.name }), '[Expected 3] 창고 shows Demo Pickup Point').toHaveCount(1);
        await expect(list.multiValues('warehouse').filter({ hasText: daegu.name }), '[Expected 3] 창고 no longer shows CJ Daegu warehouse').toHaveCount(0);
        await expect(list.keywordInput, '[Expected 3] The keyword box shows ZZZZ').toHaveValue('ZZZZ');
      });

      await step('Act: Step 4 — Read the table and the count line again', async () => {
        await expect(list.table, 'The list is shown').toBeVisible();
      });

      await step('Assert: Expected 4 — The same 3 rows and the same count line; nothing follows the values only chosen on screen', async () => {
        expect(requests.length, '[Expected 4] No list request is sent without Search').toBe(0);
        expect(await list.columnValues('col.skuId'), '[Expected 4] The table still shows the same 3 rows').toEqual(rowsBefore);
        await expect(list.pagerText, '[Expected 4] The count line still reads total 3, showing 1-3').toHaveText(StockListPagingPage.countLine(3, 1, 3));
      });
    } finally {
      await stockDb.deleteStock(extra.skuId, daegu.id);
    }
  });

  test('TC_US134_56 — The count line is recomputed on search, reset, sort change, page change and page-size change', async ({ page, world, stockApi, stockListPage: list }) => {
    const step = makeStep(page);
    const paging = new StockListPagingPage(page, list);
    await tcMeta(
      'TC_US134_56',
      'Medium',
      TAGS,
      `The count line follows every list run: 1-10 of 12, 11-12 of 12 on page 2, 1-5 of 5 for Demo Partner B, still 1-5 of 5 after the sort change, back to 1-10 after 초기화, and 1-20 at 20 per page. The TC's 12 rows are the world rows (상품코드명 = run tag, kept through Steps 1–4); 초기화 clears that keyword, so Steps 5–6 expect the unfiltered dev total read from the API at that moment (the TC's "12" there assumes a database holding only the demo rows). ${COUNT_LINE_NOTE} ${WORLD_NOTE}`,
    );
    const partnerB = world.partners.B;

    await step('Arrange: Pre-condition 1–2 — Logged in with write access, stock data present, 페이지당 = 10', async () => {
      expect(['SKU0005', 'SKU0006', 'SKU0010', 'SKU0011', 'SKU0012'].every((key) => world.sku(key).partner.id === partnerB.id), 'Demo Partner B owns 5 world rows').toBe(true);
    });

    await step('Act: Step 1 — Open 재고 관리 with no filter and read the count line', async () => {
      await openWorldList(list, world);
    });

    await step('Assert: Expected 1 — The count line reads 총 12개의 항목 중 1-10개 표시', async () => {
      await expect(list.pagerText, '[Expected 1] Total 12, showing 1-10').toHaveText(StockListPagingPage.countLine(12, 1, 10));
    });

    await step('Act: Step 2 — Click the next-page button and read the count line', async () => {
      await paging.clickPager('Next');
    });

    await step('Assert: Expected 2 — The count line reads 총 12개의 항목 중 11-12개 표시', async () => {
      await expect(list.pagerText, '[Expected 2] Total 12, showing 11-12').toHaveText(StockListPagingPage.countLine(12, 11, 12));
    });

    await step('Act: Step 3 — Set 비즈파트너 (Biz partner) to Demo Partner B, click 검색 (Search) and read the count line', async () => {
      await list.pickMulti('bizPartner', partnerB.nameKo);
      await list.clickSearch();
    });

    await step('Assert: Expected 3 — The count line reads 총 5개의 항목 중 1-5개 표시', async () => {
      await expect(list.pagerText, '[Expected 3] Total 5, showing 1-5').toHaveText(StockListPagingPage.countLine(5, 1, 5));
    });

    await step('Act: Step 4 — Change 정렬 (Sort) to 미확보 출고수량 내림차순 and read the count line', async () => {
      await list.chooseSort('UNCONFIRMED_OUTGOING_QUANTITY');
    });

    await step('Assert: Expected 4 — The count line reads 총 5개의 항목 중 1-5개 표시', async () => {
      await expect(list.pagerText, '[Expected 4] Total 5, showing 1-5').toHaveText(StockListPagingPage.countLine(5, 1, 5));
    });

    let unfilteredTotal = 0;
    await step('Act: Step 5 — Click 초기화 (Reset) and read the count line', async () => {
      await list.clickReset();
      unfilteredTotal = (await stockApi.stockStatus({ sort: 'CREATED_AT,desc', page: 0, size: 10 })).body.paging.totalCount;
    });

    await step('Assert: Expected 5 — The count line reads total N, showing 1-10 (TC: 총 12개의 항목 중 1-10개 표시)', async () => {
      await expect(list.pagerText, `[Expected 5] Total ${unfilteredTotal} (every row), showing 1-${Math.min(10, unfilteredTotal)}`).toHaveText(
        StockListPagingPage.countLine(unfilteredTotal, 1, Math.min(10, unfilteredTotal)),
      );
    });

    await step('Act: Step 6 — Change 페이지당 (Rows per page) to 20개 and read the count line', async () => {
      await list.choosePageSize(20);
    });

    await step('Assert: Expected 6 — The count line reads total N, showing 1-20 (TC: 총 12개의 항목 중 1-12개 표시)', async () => {
      await expect(list.pagerText, `[Expected 6] Total ${unfilteredTotal}, showing 1-${Math.min(20, unfilteredTotal)}`).toHaveText(
        StockListPagingPage.countLine(unfilteredTotal, 1, Math.min(20, unfilteredTotal)),
      );
    });
  });

  test('TC_US134_57 — No-results shows one full-width row inside the table, no count line and the applied filters', async ({ page, stockApi, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_57',
      'Medium',
      TAGS,
      'Searching ZZZZ returns no rows: the 22 headers stay, the table body holds one cell spanning 22 columns with 검색 결과가 없습니다., no count line is shown, the keyword box keeps ZZZZ and the other 4 filter controls keep their applied values.',
    );
    let before = { field: '', skuType: '', group: '', warehouses: 0, partners: 0 };

    await step('Arrange: Pre-condition 1–2 — Logged in with write access, no row matches the keyword ZZZZ', async () => {
      const { body } = await stockApi.stockStatus({ searchType: 'SKU_GROUP_NAME', keyword: 'ZZZZ', page: 0, size: 10 });
      expect(body.paging.totalCount, 'No row matches the keyword ZZZZ').toBe(0);
    });

    await step('Act: Step 1 — Open 재고 관리, type ZZZZ into the keyword box and click 검색 (Search)', async () => {
      await list.open();
      before = {
        field: await list.searchFieldSelect.inputValue(),
        skuType: await list.skuTypeSelect.inputValue(),
        group: await list.warehouseGroupSelect.inputValue(),
        warehouses: await list.multiValues('warehouse').count(),
        partners: await list.multiValues('bizPartner').count(),
      };
      await list.typeKeyword('ZZZZ');
      await list.clickSearch();
    });

    await step('Assert: Expected 1 — The list runs again and returns no rows', async () => {
      expect(await list.dataRowCount(), '[Expected 1] No data row is returned').toBe(0);
    });

    await step('Act: Step 2 — Read the table area', async () => {
      await expect(list.table, 'The table is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — One full-width row shows 검색 결과가 없습니다. and the 22 column headers stay above it', async () => {
      await expect(list.bodyRows, '[Expected 2] The table body holds exactly one row').toHaveCount(1);
      await expect(list.noResultsRow(), `[Expected 2] The row shows ${stx('empty.noResults', 'ko')}`).toHaveText(stx('empty.noResults', 'ko'));
      await expect(list.headerCells, '[Expected 2] The 22 column headers are still shown').toHaveCount(22);
      await expect(list.headerCells.nth(1), '[Expected 2] The headers stay visible above the message').toBeVisible();
    });

    const cell = list.table.locator('tbody > tr > td');
    await step("Act: Step 3 — Use the browser's own code view to check where the message sits", async () => {
      await expect(cell, 'The message cell is rendered').toHaveCount(1);
    });

    await step('Assert: Expected 3 — The message is inside the table body, as one cell spanning 22 columns', async () => {
      await expect(cell, '[Expected 3] The message cell is inside tbody').toHaveText(stx('empty.noResults', 'ko'));
      await expect(cell, '[Expected 3] The cell spans 22 columns').toHaveAttribute('colspan', '22');
    });

    await step('Act: Step 4 — Read the area below the table and the 5 filter controls', async () => {
      await expect(list.pageSizeSelect, 'The area below the table is shown').toBeVisible();
    });

    await step('Assert: Expected 4 — No count line; keyword box keeps ZZZZ and the other 4 controls keep their applied values', async () => {
      await expect(list.pagerText, '[Expected 4] No count line is shown').toHaveCount(0);
      await expect(list.keywordInput, '[Expected 4] The keyword box still holds ZZZZ').toHaveValue('ZZZZ');
      await expect(list.searchFieldSelect, '[Expected 4] 검색조건 keeps its applied choice').toHaveValue(before.field);
      await expect(list.warehouseGroupSelect, '[Expected 4] 대구분 keeps its applied value').toHaveValue(before.group);
      await expect(list.skuTypeSelect, '[Expected 4] SKU유형 keeps its applied value').toHaveValue(before.skuType);
      await expect(list.multiValues('warehouse'), '[Expected 4] 창고 keeps its applied value').toHaveCount(before.warehouses);
      await expect(list.multiValues('bizPartner'), '[Expected 4] 비즈파트너 keeps its applied value').toHaveCount(before.partners);
    });
  });

  test('TC_US134_58 — A successful save in any of the 4 dialogs clears every ticked row', async ({
    page,
    world,
    stockListPage: list,
    adjustmentDialog,
    conversionDialog,
    warehouseDetailDialog,
    incomingDialog,
  }) => {
    const step = makeStep(page);
    const paging = new StockListPagingPage(page, list);
    await tcMeta(
      'TC_US134_58',
      'Medium',
      TAGS,
      `After a successful 저장 in 재고 조정 (+5 증가, 조정), 재고 전환 (보류재고 지정 5), 창고별 상세 (관리함 kept) and 입고 요청 (CJ Incheon Aam, 요청 수량 10 on both lines, pre-filled 공급가 12000) no tick box stays ticked. The writes run on the test's own copy of DEMO-SKU-0001 (전체재고 190, 관리함) and DEMO-SKU-0002 in CJ Incheon Aam with Demo Manufacturer 1, not on the shared world rows; 입고 예정일 is today + 10 days (Seoul) — 2026-10-15 in the TC. ${WORLD_NOTE}`,
    );
    let first!: WorldSku;
    let second!: WorldSku;
    const cj = world.warehouses.CJ;

    await step('Arrange: Pre-condition 1–2 — Rows DEMO-SKU-0001 (190, 관리함) and DEMO-SKU-0002 in CJ Incheon Aam, both Demo Manufacturer 1', async () => {
      [first, second] = await createOwnPhysical(world, 'L58', ['Photocard (Type A)', 'Photocard (Type B)']);
      await world.seedStock(first, cj, { available: 120, reserved: 40, cs: 20, hold: 10, csManaged: true });
      await world.seedStock(second, cj, { available: 50, csManaged: false });
      await list.open();
      await list.search('SKU_GROUP_CODE', first.groupCode);
      await expect(list.cell(list.row(first.skuCode), 'col.totalQuantity'), 'The first row holds 전체재고 190').toHaveText('190');
    });

    let adjustStatus = 0;
    await step('Act: Step 1 — Tick DEMO-SKU-0001, save a 재고 조정 of +5 (증가, 조정), then read the tick boxes', async () => {
      await list.tick(list.row(first.skuCode), first.skuCode);
      await list.clickToolbar('btn.adjustStock');
      await adjustmentDialog.waitOpen();
      await adjustmentDialog.fillLine(0, { quantity: '5', modifyType: 'ADD', reason: 'ADJUSTMENT' });
      adjustStatus = await adjustmentDialog.saveAndWait('/api/v1/adjustments');
      await adjustmentDialog.expectClosed();
      await list.waitForList();
    });

    await step('Assert: Expected 1 — The save works and no tick box is left ticked', async () => {
      expect(adjustStatus, '[Expected 1] The adjustment save succeeds').toBeLessThan(300);
      await expect(paging.checkedRowBoxes, '[Expected 1] No tick box is left ticked').toHaveCount(0);
    });

    let convertStatus = 0;
    await step('Act: Step 2 — Tick DEMO-SKU-0001 again, save a 재고 전환 보류재고 지정 of 5, then read the tick boxes', async () => {
      await list.tick(list.row(first.skuCode), first.skuCode);
      await list.clickToolbar('btn.convertStock');
      await conversionDialog.waitOpen();
      await conversionDialog.choosePolicy('SECURE_HOLD');
      await conversionDialog.fillLine(0, { quantity: '5' });
      convertStatus = await conversionDialog.saveAndWait('/api/v1/stocks/conversions');
      await conversionDialog.expectClosed();
      await list.waitForList();
    });

    await step('Assert: Expected 2 — The save works and no tick box is left ticked', async () => {
      expect(convertStatus, '[Expected 2] The conversion save succeeds').toBeLessThan(300);
      await expect(paging.checkedRowBoxes, '[Expected 2] No tick box is left ticked').toHaveCount(0);
    });

    let detailStatus = 0;
    await step('Act: Step 3 — Tick DEMO-SKU-0001 again, save 창고별 상세 with the flag left on 관리함, then read the tick boxes', async () => {
      await list.tick(list.row(first.skuCode), first.skuCode);
      await list.clickToolbar('btn.warehouseDetail');
      await warehouseDetailDialog.waitOpen();
      await warehouseDetailDialog.setManaged(0, true);
      detailStatus = await warehouseDetailDialog.saveAndWait('/api/v1/stocks/cs-stock-management');
      await warehouseDetailDialog.expectClosed();
      await list.waitForList();
    });

    await step('Assert: Expected 3 — The save works and no tick box is left ticked', async () => {
      expect(detailStatus, '[Expected 3] The per-warehouse detail save succeeds').toBeLessThan(300);
      await expect(paging.checkedRowBoxes, '[Expected 3] No tick box is left ticked').toHaveCount(0);
    });

    let incomingStatus = 0;
    const expectedDate = kstDate(10);
    await step(`Act: Step 4 — Tick both rows, save a 입고 요청 to CJ Incheon Aam on ${expectedDate} with 요청 수량 10 on both lines, then read the tick boxes`, async () => {
      await list.tick(list.row(first.skuCode), first.skuCode);
      await list.tick(list.row(second.skuCode), second.skuCode);
      await list.clickToolbar('btn.incomingRequest');
      await incomingDialog.waitOpen();
      await incomingDialog.chooseWarehouse(cj.name);
      await incomingDialog.typeExpectedDate(expectedDate);
      await expect(incomingDialog.supplyPriceInput(0), 'Line 1 keeps the pre-filled 공급가 12000').toHaveValue(/^12,?000$/);
      await expect(incomingDialog.supplyPriceInput(1), 'Line 2 keeps the pre-filled 공급가 12000').toHaveValue(/^12,?000$/);
      await incomingDialog.fillLine(0, { quantity: '10' });
      await incomingDialog.fillLine(1, { quantity: '10' });
      incomingStatus = await incomingDialog.saveAndWait('/api/v1/incoming');
      await incomingDialog.expectClosed();
      await list.waitForList();
    });

    await step('Assert: Expected 4 — The save works and no tick box is left ticked', async () => {
      expect(incomingStatus, '[Expected 4] The inbound request save succeeds').toBeLessThan(300);
      await expect(paging.checkedRowBoxes, '[Expected 4] No tick box is left ticked').toHaveCount(0);
    });
  });

  test('TC_US134_59 — The tick box is disabled on Digital and Set rows and enabled on Physical rows', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const paging = new StockListPagingPage(page, list);
    await tcMeta(
      'TC_US134_59',
      'Medium',
      TAGS,
      `The tick boxes of DEMO-SKU-0006 (디지털) and DEMO-SKU-0007 (Set) are shown but disabled and cannot be ticked, alone or together; the tick box of DEMO-SKU-0001 (현물) is enabled and ticks. ${WORLD_NOTE}`,
    );
    const digital = world.sku('SKU0006');
    const set = world.sku('SKU0007');
    const physical = world.sku('SKU0001');
    const digitalRow = list.rowBySkuId(digital.skuId);
    const setRow = list.rowBySkuId(set.skuId);
    const physicalRow = list.rowBySkuId(physical.skuId);

    await step('Arrange: Pre-condition 1–2 — DEMO-SKU-0006 (디지털), DEMO-SKU-0007 (Set) and DEMO-SKU-0001 (현물) are in the stock list', async () => {
      expect([digital.type, set.type, physical.type], 'The world holds the three SKU types').toEqual(['DIGITAL', 'MIXED', 'PHYSICAL']);
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management)', async () => {
      await openWorldList(list, world);
      await list.choosePageSize(20);
    });

    await step('Assert: Expected 1 — The stock list opens and all 3 rows are shown', async () => {
      await expect(digitalRow, `[Expected 1] ${digital.skuCode} is shown`).toBeVisible();
      await expect(setRow, `[Expected 1] ${set.skuCode} is shown`).toBeVisible();
      await expect(physicalRow, `[Expected 1] ${physical.skuCode} is shown`).toBeVisible();
    });

    await step('Act: Step 2 — Try to tick the checkbox on the DEMO-SKU-0006 row', async () => {
      await paging.tryTick(digitalRow, digital.skuCode);
    });

    await step('Assert: Expected 2 — The Digital row checkbox is shown but disabled, and nothing is ticked', async () => {
      await expect(list.checkbox(digitalRow), '[Expected 2] The Digital row has a tick box').toBeVisible();
      await expect(list.checkbox(digitalRow), '[Expected 2] The Digital row tick box is disabled').toBeDisabled();
      await expect(list.checkbox(digitalRow), '[Expected 2] The Digital row is not ticked').not.toBeChecked();
      await expect(paging.checkedRowBoxes, '[Expected 2] Nothing is ticked').toHaveCount(0);
    });

    await step('Act: Step 3 — Try to tick the checkbox on the DEMO-SKU-0007 row', async () => {
      await paging.tryTick(setRow, set.skuCode);
    });

    await step('Assert: Expected 3 — The Set row checkbox is shown but disabled, and nothing is ticked', async () => {
      await expect(list.checkbox(setRow), '[Expected 3] The Set row has a tick box').toBeVisible();
      await expect(list.checkbox(setRow), '[Expected 3] The Set row tick box is disabled').toBeDisabled();
      await expect(list.checkbox(setRow), '[Expected 3] The Set row is not ticked').not.toBeChecked();
      await expect(paging.checkedRowBoxes, '[Expected 3] Nothing is ticked').toHaveCount(0);
    });

    await step('Act: Step 4 — Try to tick both of those checkboxes at once', async () => {
      await paging.tryTick(digitalRow, digital.skuCode);
      await paging.tryTick(setRow, set.skuCode);
    });

    await step('Assert: Expected 4 — Neither row can be ticked', async () => {
      await expect(list.checkbox(digitalRow), `[Expected 4] ${digital.skuCode} cannot be ticked`).not.toBeChecked();
      await expect(list.checkbox(setRow), `[Expected 4] ${set.skuCode} cannot be ticked`).not.toBeChecked();
      await expect(paging.checkedRowBoxes, '[Expected 4] Nothing is ticked').toHaveCount(0);
    });

    await step('Act: Step 5 — Tick the checkbox on the physical row DEMO-SKU-0001', async () => {
      await list.tick(physicalRow, physical.skuCode);
    });

    await step('Assert: Expected 5 — The DEMO-SKU-0001 checkbox is enabled and the row is ticked', async () => {
      await expect(list.checkbox(physicalRow), '[Expected 5] The physical row tick box is enabled').toBeEnabled();
      await expect(list.checkbox(physicalRow), '[Expected 5] The physical row is ticked').toBeChecked();
    });
  });

  test('TC_US134_60 — Select all ticks only the physical SKUs of the current page', async ({ page, world, stockApi, stockListPage: list }) => {
    const step = makeStep(page);
    const paging = new StockListPagingPage(page, list);
    await tcMeta(
      'TC_US134_60',
      'Medium',
      TAGS,
      `The header tick box on page 1 (10 rows: 8 physical, 2 set) ticks exactly the 8 physical rows DEMO-SKU-0011, 0005, 0009, 0008, 0003, 0004, 0001, 0002 and no digital / set row; a second click unticks all; with SKU유형 = 디지털 the header tick box stays unticked and no row ticks. The world rows' 생성일 are set to the TC dates for this test (page 1 = the 8 physical + 2 set rows) and restored afterwards. ${WORLD_NOTE}`,
    );
    let restore: () => Promise<void> = async () => undefined;

    try {
      await step('Arrange: Pre-condition 1–3 — 페이지당 = 10, page 1 has physical, digital and set rows; second run filters 디지털', async () => {
        restore = await arrangeTcCreatedDates(world);
        const order = await worldOrderFromApi(world, stockApi);
        expect(order.slice(0, 10), 'Page 1 holds the 8 physical rows').toEqual(expect.arrayContaining(PHYSICAL_KEYS.map((key) => world.sku(key).skuId)));
      });

      await step('Act: Step 1 — Open 재고 관리 (Stock management) and click the tick box in the header row', async () => {
        await openWorldList(list, world);
        await paging.clickSelectAll();
      });

      await step('Assert: Expected 1 — 8 rows are ticked: DEMO-SKU-0011, 0005, 0009, 0008, 0003, 0004, 0001, 0002', async () => {
        await expect(paging.checkedRowBoxes, '[Expected 1] Exactly 8 rows are ticked').toHaveCount(8);
        for (const key of PHYSICAL_KEYS) {
          await expect(list.checkbox(list.rowBySkuId(world.sku(key).skuId)), `[Expected 1] ${world.sku(key).skuCode} is ticked`).toBeChecked();
        }
      });

      let tickedTypes: string[] = [];
      await step('Act: Step 2 — Count the ticked rows and read their SKU 유형 (SKU type) values', async () => {
        const rows = list.bodyRows.filter({ has: page.locator('input[type="checkbox"]:checked') });
        tickedTypes = [];
        for (const row of await rows.all()) tickedTypes.push(await list.cellText(row, 'col.skuType'));
      });

      await step('Assert: Expected 2 — Only 현물 (Physical) rows are ticked, no 디지털 or Set row', async () => {
        expect(tickedTypes.length, '[Expected 2] 8 ticked rows are read').toBe(8);
        expect(tickedTypes.every((type) => type === stx('skuType.PHYSICAL', 'ko')), `[Expected 2] Every ticked row is 현물 (${tickedTypes.join(', ')})`).toBe(true);
        for (const key of ['SKU0007', 'SKU0012'] as const) {
          await expect(list.checkbox(list.rowBySkuId(world.sku(key).skuId)), `[Expected 2] Set row ${world.sku(key).skuCode} is not ticked`).not.toBeChecked();
        }
      });

      await step('Act: Step 3 — Click the header tick box again', async () => {
        await paging.clickSelectAll();
      });

      await step('Assert: Expected 3 — All rows are unticked', async () => {
        await expect(paging.checkedRowBoxes, '[Expected 3] No row is ticked').toHaveCount(0);
        await expect(list.selectAllCheckbox, '[Expected 3] The header tick box is unticked').not.toBeChecked();
      });

      await step('Act: Step 4 — Set SKU유형 to 디지털 (Digital), click 검색 (Search), then click the header tick box', async () => {
        await list.chooseSkuType('DIGITAL');
        await list.clickSearch();
        await paging.clickSelectAll();
      });

      await step('Assert: Expected 4 — The header tick box stays unticked and no row is ticked', async () => {
        expect(await list.dataRowCount(), 'The page holds only the 2 digital rows').toBe(2);
        await expect(list.selectAllCheckbox, '[Expected 4] The header tick box stays unticked').not.toBeChecked();
        await expect(paging.checkedRowBoxes, '[Expected 4] No row is ticked').toHaveCount(0);
      });
    } finally {
      await restore();
    }
  });

  test('TC_US134_61 — Clicking the product code opens the edit screen of the right SKU type', async ({ page, world, stockListPage: list, skuFormPage }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_61',
      'Medium',
      TAGS,
      `The 상품코드 link of DEMO-SKU-0001 opens /commerce/product-stock/stock/physical/edit?skuGroupId=<group id> titled 현물 SKU, DEMO-SKU-0006 opens the digital edit route titled 디지털 SKU, DEMO-SKU-0007 the set edit route titled set SKU. "Go back" uses the browser back button; the world keyword is applied again if the list comes back unfiltered. ${WORLD_NOTE}`,
    );
    const physical = world.sku('SKU0001');
    const digital = world.sku('SKU0006');
    const set = world.sku('SKU0007');

    const backToList = async (sku: WorldSku) => {
      await page.goBack();
      await list.waitForList();
      if ((await list.rowBySkuId(sku.skuId).count()) === 0) await list.search('SKU_GROUP_NAME', world.keyword);
      if ((await list.rowBySkuId(sku.skuId).count()) === 0) await list.choosePageSize(20);
    };
    const openCode = async (sku: WorldSku) => {
      await list.click(list.rowBySkuId(sku.skuId).getByRole('link', { name: sku.groupCode, exact: true }), `product code ${sku.groupCode}`);
      await expect(skuFormPage.cardTitle, 'The SKU edit screen loads').toBeVisible({ timeout: 30_000 });
    };

    await step('Arrange: Pre-condition 1–2 — DEMO-SKU-0001 (physical), DEMO-SKU-0006 (digital) and DEMO-SKU-0007 (set) are in the stock list', async () => {
      expect([physical.type, digital.type, set.type], 'The world holds the three SKU types').toEqual(['PHYSICAL', 'DIGITAL', 'MIXED']);
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management)', async () => {
      await openWorldList(list, world);
      await list.choosePageSize(20);
    });

    await step('Assert: Expected 1 — The stock list opens and all 3 rows are shown', async () => {
      for (const sku of [physical, digital, set]) {
        await expect(list.rowBySkuId(sku.skuId), `[Expected 1] ${sku.skuCode} is shown`).toBeVisible();
      }
    });

    await step('Act: Step 2 — Click the 상품코드 of DEMO-SKU-0001, read the address and title, then go back to the list', async () => {
      await openCode(physical);
    });

    await step('Assert: Expected 2 — The physical SKU edit screen opens at /physical/edit?skuGroupId=<id>, titled 현물 SKU', async () => {
      await expect(page, `[Expected 2] The address is the physical edit route of SKU group ${physical.groupId}`).toHaveURL(
        new RegExp(`/commerce/product-stock/stock/physical/edit\\?skuGroupId=${physical.groupId}(&|$)`),
      );
      await expect(skuFormPage.cardTitle, `[Expected 2] The page title is ${stx('skuForm.title.physical', 'ko')}`).toHaveText(stx('skuForm.title.physical', 'ko'));
      await expect(skuFormPage.skuGroupCodeInput, `[Expected 2] The edit screen is for ${physical.groupCode}`).toHaveValue(physical.groupCode, { timeout: 30_000 });
      await backToList(digital);
    });

    await step('Act: Step 3 — Click the 상품코드 of DEMO-SKU-0006, read the address and title, then go back to the list', async () => {
      await openCode(digital);
    });

    await step('Assert: Expected 3 — The digital SKU edit screen opens (address contains digital), titled 디지털 SKU', async () => {
      await expect(page, '[Expected 3] The address contains digital').toHaveURL(new RegExp(`/commerce/product-stock/stock/digital/edit\\?skuGroupId=${digital.groupId}(&|$)`));
      await expect(skuFormPage.cardTitle, `[Expected 3] The page title is ${stx('skuForm.title.digital', 'ko')}`).toHaveText(stx('skuForm.title.digital', 'ko'));
      await expect(skuFormPage.skuGroupCodeInput, `[Expected 3] The edit screen is for ${digital.groupCode}`).toHaveValue(digital.groupCode, { timeout: 30_000 });
      await backToList(set);
    });

    await step('Act: Step 4 — Click the 상품코드 of DEMO-SKU-0007 and read the address and title', async () => {
      await openCode(set);
    });

    await step('Assert: Expected 4 — The set SKU edit screen opens (address contains set), titled set SKU', async () => {
      await expect(page, '[Expected 4] The address contains set').toHaveURL(new RegExp(`/commerce/product-stock/stock/set/edit\\?skuGroupId=${set.groupId}(&|$)`));
      await expect(skuFormPage.cardTitle, `[Expected 4] The page title is ${stx('skuForm.title.set', 'ko')}`).toHaveText(stx('skuForm.title.set', 'ko'));
      await expect(skuFormPage.skuGroupCodeInput, `[Expected 4] The edit screen is for ${set.groupCode}`).toHaveValue(set.groupCode, { timeout: 30_000 });
    });
  });

  test('TC_US134_62 — The stock row shows the same identifiers as the SKU master', async ({ page, world, stockApi, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_62',
      'Medium',
      TAGS,
      `The stock row of DEMO-PC-001 / DEMO-SKU-0001 reads, left to right, 상품코드, SKU명, SKU코드, 바코드 equal to the SKU master record (DEMO-PC-001, Demo Album [Vol.1] — Photocard (Type A), DEMO-SKU-0001, DEMO-BC-0001 in the TC; the world's run-tagged copies here). ${WORLD_NOTE}`,
    );
    const sku = world.sku('SKU0001');
    let master: { skuGroupCode: string; skuName: string; skuCode: string; barcode?: string | null } | undefined;
    let cells: string[] = [];

    await step('Arrange: Pre-condition 1–3 — The SKU master holds DEMO-SKU-0001 and its stock record exists', async () => {
      const { body } = await stockApi.skus({ searchType: 'SKU_CODE', keyword: sku.skuCode });
      master = body.items.find((item) => item.skuId === sku.skuId);
      expect(master, 'The SKU master holds DEMO-SKU-0001').toBeDefined();
      expect(world.row('SKU0001').warehouse.id, 'DEMO-SKU-0001 has a stock record').toBe(world.warehouses.CJ.id);
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management)', async () => {
      await openWorldList(list, world);
    });

    await step('Assert: Expected 1 — The stock list opens', async () => {
      await expect(list.table, '[Expected 1] The stock list is shown').toBeVisible();
    });

    const row = list.rowBySkuId(sku.skuId);
    await step('Act: Step 2 — Find the stock row for product code DEMO-PC-001', async () => {
      await list.choosePageSize(20);
    });

    await step('Assert: Expected 2 — The matching stock row is shown', async () => {
      await expect(row, `[Expected 2] The row of ${sku.groupCode} / ${sku.skuCode} is shown`).toBeVisible();
    });

    await step('Act: Step 3 — Read the 상품코드, SKU명, SKU코드 and 바코드 cells of that row, left to right', async () => {
      cells = (await list.rowTexts(row)).slice(1, 5);
    });

    await step('Assert: Expected 3 — The 4 cells read the product code, SKU name, SKU code and barcode of the SKU master', async () => {
      expect(cells[0], `[Expected 3] 상품코드 is ${sku.groupCode}`).toBe(sku.groupCode);
      expect(cells[1], `[Expected 3] SKU명 is ${sku.skuName}`).toBe(sku.skuName);
      expect(cells[2], `[Expected 3] SKU코드 is ${sku.skuCode}`).toBe(sku.skuCode);
      expect(cells[3], `[Expected 3] 바코드 is ${sku.barcode}`).toBe(sku.barcode ?? '-');
      expect(cells, '[Expected 3] The 4 cells equal the SKU master record').toEqual([master?.skuGroupCode, master?.skuName, master?.skuCode, master?.barcode ?? '-']);
    });
  });

  test('TC_US134_63 — The created date stays in Seoul time and the SKU ID has no separators when the browser time zone changes', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_63',
      'Medium',
      TAGS,
      `DEMO-SKU-0001 created 2026-08-11 01:30 Seoul time (still 2026-08-10 in UTC) shows 생성일 2026.08.11 with no time and its SKU ID as plain digits; after switching the browser time zone to UTC (Chromium time-zone override) and reloading, 생성일 still reads 2026.08.11. The SKU ID is the world SKU's own ID (900000000000101 in the TC). The world rows' 생성일 are set to the TC dates for this test and restored afterwards. ${WORLD_NOTE}`,
    );
    const sku = world.sku('SKU0001');
    const row = list.rowBySkuId(sku.skuId);
    let restore: () => Promise<void> = async () => undefined;

    try {
      await step('Arrange: Pre-condition 1–3 — DEMO-SKU-0001 created 2026-08-11 Seoul time; the browser time zone can be changed', async () => {
        restore = await arrangeTcCreatedDates(world);
        const rows = await stockDb.query("SELECT DATE_FORMAT(CONVERT_TZ(created_at, '+00:00', '+09:00'), '%Y-%m-%d') AS d FROM sku WHERE id = ?", [sku.skuId]);
        expect(rows[0]?.d, 'DEMO-SKU-0001 is created on 2026-08-11 Seoul time').toBe('2026-08-11');
      });

      await step('Act: Step 1 — Open 재고 관리 and find the DEMO-SKU-0001 row', async () => {
        await openWorldList(list, world);
      });

      await step('Assert: Expected 1 — The DEMO-SKU-0001 row is shown', async () => {
        await expect(row, `[Expected 1] The ${sku.skuCode} row is shown`).toBeVisible();
      });

      let created = '';
      let skuIdText = '';
      await step('Act: Step 2 — Read the 생성일 (Created date) and the SKU ID of that row', async () => {
        created = await list.cellText(row, 'col.createdAt');
        skuIdText = await list.cellText(row, 'col.skuId');
      });

      await step('Assert: Expected 2 — 생성일 reads 2026.08.11 (YYYY.MM.DD, no time) and the SKU ID has no thousand separators', async () => {
        expect(created, '[Expected 2] 생성일 reads 2026.08.11').toBe('2026.08.11');
        expect(created, '[Expected 2] 생성일 is YYYY.MM.DD with no time value').toMatch(/^\d{4}\.\d{2}\.\d{2}$/);
        expect(skuIdText, `[Expected 2] The SKU ID reads ${sku.skuId}`).toBe(String(sku.skuId));
        expect(skuIdText, '[Expected 2] The SKU ID has no thousand separators').toMatch(/^\d+$/);
      });

      let zone = '';
      await step('Act: Step 3 — Change the browser time zone to UTC', async () => {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
        zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
      });

      await step('Assert: Expected 3 — The browser time zone is now UTC', async () => {
        expect(zone, '[Expected 3] The browser time zone is UTC').toMatch(/^(UTC|Etc\/UTC)$/);
      });

      let createdUtc = '';
      await step('Act: Step 4 — Reload the stock list and read the 생성일 (Created date) again', async () => {
        await page.reload();
        await list.waitForList();
        await list.search('SKU_GROUP_NAME', world.keyword);
        createdUtc = await list.cellText(row, 'col.createdAt');
      });

      await step('Assert: Expected 4 — 생성일 still reads 2026.08.11, because the column shows Seoul time', async () => {
        expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), 'The reloaded page still runs in UTC').toMatch(/^(UTC|Etc\/UTC)$/);
        expect(createdUtc, '[Expected 4] 생성일 still reads 2026.08.11').toBe('2026.08.11');
      });
    } finally {
      await restore();
    }
  });

  test('TC_US134_64 — The Stock history button is shown for a row with a warehouse and missing for a row without one', async ({ page, world, stockListPage: list, stockHistoryDialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_64',
      'Medium',
      TAGS,
      `The 재고이력 cell of DEMO-SKU-0001 (CJ Incheon Aam) holds an enabled 재고이력 button that opens the stock history dialog for that SKU and warehouse; the cell of DEMO-SKU-0005 (no warehouse) is empty. ${WORLD_NOTE}`,
    );
    const withStock = world.sku('SKU0001');
    const noStock = world.sku('SKU0005');
    const cj = world.warehouses.CJ;
    const historyButton = (row: Locator) => list.cell(row, 'col.stockHistory').getByRole('button');

    await step('Arrange: Pre-condition 1–2 — DEMO-SKU-0001 in CJ Incheon Aam and DEMO-SKU-0005 with no warehouse', async () => {
      expect(world.row('SKU0001').warehouse.id, 'DEMO-SKU-0001 sits in CJ Incheon Aam').toBe(cj.id);
      expect(world.stockRows.some((row) => row.sku.skuId === noStock.skuId), 'DEMO-SKU-0005 has no stock record').toBe(false);
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management)', async () => {
      await openWorldList(list, world);
      await list.choosePageSize(20);
    });

    await step('Assert: Expected 1 — The list opens and both rows are shown', async () => {
      await expect(list.rowBySkuId(withStock.skuId), `[Expected 1] ${withStock.skuCode} is shown`).toBeVisible();
      await expect(list.rowBySkuId(noStock.skuId), `[Expected 1] ${noStock.skuCode} is shown`).toBeVisible();
    });

    await step('Act: Step 2 — Check the 재고이력 (Stock history) cell for DEMO-SKU-0001', async () => {
      await expect(list.cell(list.rowBySkuId(withStock.skuId), 'col.stockHistory'), 'The cell is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — The Stock history button is displayed and enabled for DEMO-SKU-0001', async () => {
      const button = historyButton(list.rowBySkuId(withStock.skuId));
      await expect(button, '[Expected 2] The 재고이력 button is displayed').toBeVisible();
      await expect(button, `[Expected 2] The button reads ${stx('btn.stockHistory', 'ko')}`).toHaveText(stx('btn.stockHistory', 'ko'));
      await expect(button, '[Expected 2] The 재고이력 button is enabled').toBeEnabled();
    });

    await step('Act: Step 3 — Check the 재고이력 (Stock history) cell for DEMO-SKU-0005', async () => {
      await expect(list.rowBySkuId(noStock.skuId), 'The row is shown').toBeVisible();
    });

    await step('Assert: Expected 3 — The Stock history cell is empty for DEMO-SKU-0005', async () => {
      await expect(historyButton(list.rowBySkuId(noStock.skuId)), '[Expected 3] No 재고이력 button in the cell').toHaveCount(0);
      expect(await list.cellText(list.rowBySkuId(noStock.skuId), 'col.stockHistory'), '[Expected 3] The cell is empty').toBe('');
    });

    await step('Act: Step 4 — Click the 재고이력 (Stock history) button for DEMO-SKU-0001', async () => {
      await list.openHistory(list.rowBySkuId(withStock.skuId));
    });

    await step('Assert: Expected 4 — The Stock history dialog opens for DEMO-SKU-0001 in CJ Incheon Aam', async () => {
      await stockHistoryDialog.waitOpen('ko');
      await expect(stockHistoryDialog.contextLine, `[Expected 4] The dialog names ${withStock.skuCode}`).toContainText(withStock.skuCode);
      await expect(stockHistoryDialog.contextLine, `[Expected 4] The dialog names the warehouse ${cj.name}`).toContainText(cj.name);
    });
  });

  test('TC_US134_65 — Two linked sideways scrollbars and no column pinning when 22 columns do not fit', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const paging = new StockListPagingPage(page, list);
    await tcMeta(
      'TC_US134_65',
      'Medium',
      TAGS,
      `At a 1440-wide window the table has a sideways scrollbar above it and one below it that move together; scrolling until SKU ID shows takes 상품코드, SKU명 and SKU코드 off screen, and the 상품코드 cell has no sticky/pinning rule (checked through the computed style). The top bar is dragged by setting its scroll position. ${WORLD_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–3 — 22 columns shown, browser window 1440 wide', async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      expect(page.viewportSize()?.width, 'The window is 1440 wide').toBe(1440);
    });

    let top = { scrollWidth: 0, clientWidth: 0 };
    let bottom = { scrollWidth: 0, clientWidth: 0 };
    await step('Act: Step 1 — Open 재고 관리 and look just above and just below the table', async () => {
      await openWorldList(list, world);
      top = await paging.scrollExtent(paging.topScrollbar);
      bottom = await paging.scrollExtent(paging.tableScroller);
    });

    await step('Assert: Expected 1 — There are 2 sideways scrollbars, one above the table and one below', async () => {
      await expect(paging.topScrollbar, '[Expected 1] A scrollbar is shown above the table').toBeVisible();
      expect(top.scrollWidth, '[Expected 1] The top bar scrolls sideways').toBeGreaterThan(top.clientWidth);
      expect(bottom.scrollWidth, '[Expected 1] The table frame below scrolls sideways').toBeGreaterThan(bottom.clientWidth);
      const topBox = await paging.topScrollbar.boundingBox();
      const tableBox = await list.table.boundingBox();
      expect(!!topBox && !!tableBox && topBox.y + topBox.height <= tableBox.y + 1, '[Expected 1] The top scrollbar sits above the table').toBe(true);
    });

    await step('Act: Step 2 — Drag the top scrollbar to the right and look at where the bottom one is', async () => {
      await paging.scrollTopBarTo(600);
    });

    await step('Assert: Expected 2 — The bottom scrollbar moves to the matching position', async () => {
      const topLeft = await paging.scrollLeftOf(paging.topScrollbar);
      expect(topLeft, '[Expected 2] The top scrollbar moved right').toBeGreaterThan(0);
      await expect.poll(() => paging.scrollLeftOf(paging.tableScroller), { message: '[Expected 2] The bottom scrollbar follows the top one' }).toBe(topLeft);
    });

    await step('Act: Step 3 — Scroll the table right until the SKU ID column shows, then look at the left edge', async () => {
      await paging.headerCell('col.skuId').scrollIntoViewIfNeeded();
      await expect(paging.headerCell('col.skuId'), 'The SKU ID column is shown').toBeInViewport();
    });

    await step('Assert: Expected 3 — 상품코드, SKU명 and SKU코드 have all scrolled off the screen', async () => {
      for (const column of ['col.skuGroupCode', 'col.skuName', 'col.skuCode'] as const) {
        expect(await paging.rightEdgeFromScrollerLeft(paging.headerCell(column)), `[Expected 3] ${stx(column as StockTextKey, 'ko')} has scrolled off to the left`).toBeLessThanOrEqual(0);
      }
    });

    let headerStyle = { position: '', left: '' };
    let cellStyle = { position: '', left: '' };
    await step("Act: Step 4 — Check the 상품코드 cell's own code for any pinning rule", async () => {
      headerStyle = await paging.pinningStyle(paging.headerCell('col.skuGroupCode'));
      cellStyle = await paging.pinningStyle(list.cell(list.bodyRows.first(), 'col.skuGroupCode'));
    });

    await step('Assert: Expected 4 — That cell has no pinning rule', async () => {
      expect(cellStyle.position, '[Expected 4] The 상품코드 cell is not sticky / fixed').not.toMatch(/sticky|fixed/);
      expect(headerStyle.position, '[Expected 4] The 상품코드 header is not sticky / fixed').not.toMatch(/sticky|fixed/);
    });
  });

  test('TC_US134_66 — With no rows the paging bar keeps 페이지당 but shows no page buttons and no count line', async ({ page, stockApi, stockListPage: list }) => {
    const step = makeStep(page);
    const paging = new StockListPagingPage(page, list);
    await tcMeta(
      'TC_US134_66',
      'Medium',
      TAGS,
      'Searching ZZZZ shows 검색 결과가 없습니다. inside the table; below it the paging bar keeps 페이지당 = 10개 but has no first / previous / next / last or page-number buttons and no count line, and the filter block keeps ZZZZ.',
    );

    await step('Arrange: Pre-condition 1–2 — Logged in with write access, no row matches the keyword ZZZZ', async () => {
      const { body } = await stockApi.stockStatus({ searchType: 'SKU_GROUP_NAME', keyword: 'ZZZZ', page: 0, size: 10 });
      expect(body.paging.totalCount, 'No row matches the keyword ZZZZ').toBe(0);
    });

    await step('Act: Step 1 — Open 재고 관리, type ZZZZ into the keyword box and click 검색 (Search)', async () => {
      await list.open();
      await list.typeKeyword('ZZZZ');
      await list.clickSearch();
    });

    await step('Assert: Expected 1 — No rows; 검색 결과가 없습니다. is shown inside the table', async () => {
      expect(await list.dataRowCount(), '[Expected 1] No data row is returned').toBe(0);
      await expect(list.noResultsRow(), `[Expected 1] ${stx('empty.noResults', 'ko')} is shown inside the table`).toHaveText(stx('empty.noResults', 'ko'));
    });

    await step('Act: Step 2 — Look at the area below the table where the paging bar sits', async () => {
      await expect(list.pageSizeSelect, 'The paging bar area is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — The bar is there with no first / previous / next / last buttons; the filters keep the applied values', async () => {
      await expect(list.card.getByText('페이지당', { exact: true }), '[Expected 2] The pagination bar is there').toBeVisible();
      for (const control of ['First', 'Previous', 'Next', 'Last'] as const) {
        await expect(paging.pagerControl(control), `[Expected 2] No ${control} page button is shown`).toHaveCount(0);
      }
      await expect(paging.pageNumberItems, '[Expected 2] No page-number button is shown').toHaveCount(0);
      await expect(list.keywordInput, '[Expected 2] The filter block keeps ZZZZ').toHaveValue('ZZZZ');
    });

    await step('Act: Step 3 — Read the 페이지당 (Rows per page) control and the count line', async () => {
      await expect(list.pageSizeSelect, 'The 페이지당 control is shown').toBeVisible();
    });

    await step('Assert: Expected 3 — 페이지당 still shows 10개 and no count line is shown', async () => {
      await expect(list.pageSizeSelect, '[Expected 3] 페이지당 is still 10').toHaveValue('10');
      await expect(list.pageSizeSelect.locator('option:checked'), '[Expected 3] 페이지당 shows 10개').toHaveText('10개');
      await expect(list.pagerText, '[Expected 3] No count line is shown').toHaveCount(0);
    });
  });

  test('TC_US134_67 — The no-selection warning disappears once a row is ticked', async ({ page, world, stockListPage: list, adjustmentDialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_67',
      'Low',
      TAGS,
      `Clicking 재고 조정 with nothing ticked opens no dialog and shows "선택된 재고가 없습니다. 재고를 선택해주세요." above the table; ticking DEMO-SKU-0001 removes the message. ${WORLD_NOTE}`,
    );
    const sku = world.sku('SKU0001');
    const row = list.rowBySkuId(sku.skuId);

    await step('Arrange: Pre-condition 1–2 — Stock data present and nothing is ticked', async () => {
      expect(sku.type, 'DEMO-SKU-0001 is physical').toBe('PHYSICAL');
    });

    await step('Act: Step 1 — Open 재고 관리 and click 재고 조정 (Stock adjustment) with nothing ticked', async () => {
      await openWorldList(list, world);
      await list.choosePageSize(20);
      await list.clickToolbar('btn.adjustStock');
    });

    await step('Assert: Expected 1 — No dialog opens', async () => {
      await expect(list.guardAlert, 'The click is answered on the list').toBeVisible();
      await expect(adjustmentDialog.root, '[Expected 1] The 재고 조정 dialog does not open').toHaveCount(0);
      await expect(page.locator('.modal.show[role="dialog"]'), '[Expected 1] No dialog opens').toHaveCount(0);
    });

    await step('Act: Step 2 — Read the message area above the table', async () => {
      await expect(list.table, 'The table is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — The message shows 선택된 재고가 없습니다. 재고를 선택해주세요.', async () => {
      await expect(list.guardAlert, `[Expected 2] The message reads "${stx('guard.noSelection', 'ko')}"`).toHaveText(stx('guard.noSelection', 'ko'));
      const alertBox = await list.guardAlert.boundingBox();
      const tableBox = await list.table.boundingBox();
      expect(!!alertBox && !!tableBox && alertBox.y < tableBox.y, '[Expected 2] The message sits above the table').toBe(true);
    });

    await step('Act: Step 3 — Tick the physical row DEMO-SKU-0001', async () => {
      await list.tick(row, sku.skuCode);
    });

    await step('Assert: Expected 3 — That row is ticked', async () => {
      await expect(list.checkbox(row), `[Expected 3] ${sku.skuCode} is ticked`).toBeChecked();
    });

    await step('Act: Step 4 — Read the message area again', async () => {
      await expect(list.table, 'The table is shown').toBeVisible();
    });

    await step('Assert: Expected 4 — The message is not displayed', async () => {
      await expect(list.guardAlert, '[Expected 4] The no-selection message is gone').toHaveCount(0);
    });
  });

  test('TC_US134_68 — Adjustment, conversion, per-warehouse detail and stock history are blocked for a row with no warehouse', async ({
    page,
    world,
    stockListPage: list,
    adjustmentDialog,
    conversionDialog,
    warehouseDetailDialog,
  }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_68',
      'High',
      TAGS,
      `DEMO-SKU-0006 shows - for 창고 and 제조사; with only DEMO-SKU-0005 (현물, no warehouse, no stock) ticked, 재고 조정 and 재고 전환 show their no-warehouse guards and 창고별 상세 shows the non-CJ guard, none opening a dialog; the 재고이력 cell of DEMO-SKU-0005 is empty. ${WORLD_NOTE}`,
    );
    const digital = world.sku('SKU0006');
    const noWarehouse = world.sku('SKU0005');
    const digitalRow = list.rowBySkuId(digital.skuId);
    const noWarehouseRow = list.rowBySkuId(noWarehouse.skuId);
    const anyDialog = page.locator('.modal.show[role="dialog"]');

    await step('Arrange: Pre-condition 1–2 — DEMO-SKU-0005 (현물) with no warehouse / stock, DEMO-SKU-0006 (디지털) with no warehouse / manufacturer', async () => {
      expect(noWarehouse.type, 'DEMO-SKU-0005 is physical').toBe('PHYSICAL');
      expect(world.stockRows.some((row) => row.sku.skuId === noWarehouse.skuId), 'DEMO-SKU-0005 has no stock record').toBe(false);
      expect(digital.manufacturer, 'DEMO-SKU-0006 has no manufacturer').toBeNull();
    });

    let warehouseCell = '';
    let manufacturerCell = '';
    await step('Act: Step 1 — Open 재고 관리 and read the 창고 and 제조사 cells of the DEMO-SKU-0006 row', async () => {
      await openWorldList(list, world);
      await list.choosePageSize(20);
      warehouseCell = await list.cellText(digitalRow, 'col.warehouse');
      manufacturerCell = await list.cellText(digitalRow, 'col.manufacturer');
    });

    await step('Assert: Expected 1 — Both cells show a dash', async () => {
      expect(warehouseCell, '[Expected 1] 창고 shows -').toBe('-');
      expect(manufacturerCell, '[Expected 1] 제조사 shows -').toBe('-');
    });

    await step('Act: Step 2 — Tick only DEMO-SKU-0005 and click 재고 조정 (Stock adjustment)', async () => {
      await list.tick(noWarehouseRow, noWarehouse.skuCode);
      await list.clickToolbar('btn.adjustStock');
    });

    await step('Assert: Expected 2 — The no-warehouse adjustment message is shown and no dialog opens', async () => {
      await expect(list.guardAlert, `[Expected 2] The message reads "${stx('guard.noWarehouseAdjustment', 'ko')}"`).toHaveText(stx('guard.noWarehouseAdjustment', 'ko'));
      await expect(adjustmentDialog.root, '[Expected 2] The 재고 조정 dialog does not open').toHaveCount(0);
      await expect(anyDialog, '[Expected 2] No dialog opens').toHaveCount(0);
    });

    await step('Act: Step 3 — With DEMO-SKU-0005 still ticked, click 재고 전환 (Stock conversion)', async () => {
      await expect(list.checkbox(noWarehouseRow), 'DEMO-SKU-0005 is still ticked').toBeChecked();
      await list.clickToolbar('btn.convertStock');
    });

    await step('Assert: Expected 3 — The no-warehouse conversion message is shown and no dialog opens', async () => {
      await expect(list.guardAlert, `[Expected 3] The message reads "${stx('guard.noWarehouseConversion', 'ko')}"`).toHaveText(stx('guard.noWarehouseConversion', 'ko'));
      await expect(conversionDialog.root, '[Expected 3] The 재고 전환 dialog does not open').toHaveCount(0);
      await expect(anyDialog, '[Expected 3] No dialog opens').toHaveCount(0);
    });

    await step('Act: Step 4 — With DEMO-SKU-0005 still ticked, click 창고별 상세 (Per-warehouse detail)', async () => {
      await expect(list.checkbox(noWarehouseRow), 'DEMO-SKU-0005 is still ticked').toBeChecked();
      await list.clickToolbar('btn.warehouseDetail');
    });

    await step('Assert: Expected 4 — The non-CJ warehouse message is shown and no dialog opens', async () => {
      await expect(list.guardAlert, `[Expected 4] The message reads "${stx('guard.nonCjWarehouse', 'ko')}"`).toHaveText(stx('guard.nonCjWarehouse', 'ko'));
      await expect(warehouseDetailDialog.root, '[Expected 4] The 창고별 상세 dialog does not open').toHaveCount(0);
      await expect(anyDialog, '[Expected 4] No dialog opens').toHaveCount(0);
    });

    await step('Act: Step 5 — Read the 재고이력 (Stock history) cell of the DEMO-SKU-0005 row', async () => {
      await expect(list.cell(noWarehouseRow, 'col.stockHistory'), 'The cell is shown').toBeAttached();
    });

    await step('Assert: Expected 5 — The cell is empty, so the stock history cannot be opened for this row', async () => {
      expect(await list.cellText(noWarehouseRow, 'col.stockHistory'), '[Expected 5] The 재고이력 cell is empty').toBe('');
      await expect(list.cell(noWarehouseRow, 'col.stockHistory').getByRole('button'), '[Expected 5] There is no 재고이력 button to open').toHaveCount(0);
    });
  });

  test('TC_US134_69 — The 할당대기재고 tooltip carries both the CJ warehouse and the pickup warehouse descriptions', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_69',
      'Low',
      TAGS,
      `The 할당대기재고 (Stock awaiting allocation) header carries a hint (title attribute, dashed underline, help cursor) holding word for word the CJ-warehouse and pickup-warehouse branches of the TC, and the same hint when only pickup-warehouse rows are listed — in Korean, then in English. Not automated: the browser's native tooltip pop-up itself (it is drawn by the OS from the title attribute). ${WORLD_NOTE}`,
    );
    const TC_HINT: Record<'ko' | 'en', string> = {
      ko: "- CJ 창고: 주문 완료 후 'CJ어드민'으로 전송되기 전 상태인 수량 데이터만 집계됩니다. (CJ어드민으로 전송된 이후에는 출고대기재고 집계에서 제외) - 현장수령지 창고: 주문 완료 후 아직 '수령완료'되지 않은 상태의 수량 데이터가 집계됩니다.",
      en: '- CJ warehouse: counts only quantities after order completion and before transmission to CJ Admin. (Excluded once sent to CJ Admin.) - Pickup-location warehouse: counts quantities after order completion that are not yet marked as picked up.',
    };
    const tip = list.headerTooltip('col.pendingAllocationQuantity');

    await step('Arrange: Pre-condition 1–3 — DEMO-SKU-0001 in CJ Incheon Aam, DEMO-SKU-0004 in Demo Pickup Point; Korean then English', async () => {
      expect(world.row('SKU0001').warehouse.id, 'DEMO-SKU-0001 sits in CJ Incheon Aam').toBe(world.warehouses.CJ.id);
      expect(world.row('SKU0004').warehouse.id, 'DEMO-SKU-0004 sits in Demo Pickup Point').toBe(world.warehouses.PICKUP.id);
    });

    for (const lang of STOCK_LANGS) {
      const sfx = LANG_SUFFIX[lang];
      let cursor = '';
      let hint = '';

      await step(`Act: Step 1 — Open 재고 관리 and hover over the 할당대기재고 (Stock awaiting allocation) column header ${sfx}`, async () => {
        await list.open(lang);
        await list.search('SKU_GROUP_NAME', world.keyword);
        await tip.hover();
        cursor = await tip.evaluate((element) => window.getComputedStyle(element).cursor);
      });

      await step(`Assert: Expected 1 — A hint appears on the column header ${sfx}`, async () => {
        await expect(tip, `[Expected 1] The ${stx('col.pendingAllocationQuantity', lang)} header carries a hint`).toHaveAttribute('title', /\S/);
        expect(cursor, '[Expected 1] The header shows the help cursor on hover').toBe('help');
      });

      await step(`Act: Step 2 — Read the whole hint text ${sfx}`, async () => {
        hint = normalize(await tip.getAttribute('title'));
      });

      await step(`Assert: Expected 2 — The hint carries both branches word for word ${sfx}`, async () => {
        expect(hint, '[Expected 2] The hint carries the CJ-warehouse and the pickup-warehouse branches word for word').toBe(normalize(TC_HINT[lang]));
      });

      let pickupHint = '';
      await step(`Act: Step 3 — Hover over the same header while only pickup-warehouse rows are listed, and read the hint again ${sfx}`, async () => {
        await list.pickMulti('warehouse', world.warehouses.PICKUP.name);
        await list.clickSearch();
        await expect(list.rowBySkuId(world.sku('SKU0004').skuId), 'The pickup-warehouse row is listed').toBeVisible();
        expect(await list.dataRowCount(), 'Only the pickup-warehouse row is listed').toBe(1);
        await tip.hover();
        pickupHint = normalize(await tip.getAttribute('title'));
      });

      await step(`Assert: Expected 3 — The hint text is the same ${sfx}`, async () => {
        expect(pickupHint, '[Expected 3] The hint text is the same with only pickup-warehouse rows listed').toBe(hint);
      });
    }
  });

  test('TC_US134_70 — Search, export, upload and Save buttons switch off while their own call is running', async ({ page, world, stockListPage: list, adjustmentDialog }) => {
    const step = makeStep(page);
    const paging = new StockListPagingPage(page, list);
    await tcMeta(
      'TC_US134_70',
      'Medium',
      TAGS,
      `검색, 엑셀 다운로드, 입고 요청 업로드 and the 재고 조정 저장 button are each greyed out while their own call runs and come back once it answers. Instead of network throttling the test holds each call in the browser until the button state has been read, then lets it through (no fixed wait). The rows used are the test's own physical SKU in CJ Incheon Aam (DEMO-SKU-0001 in the TC), so the upload and the adjustment write only test data. ${WORLD_NOTE}`,
    );
    let own!: WorldSku;
    const cj = world.warehouses.CJ;

    await step('Arrange: Pre-condition 1–3 — A physical SKU in CJ Incheon Aam can be picked; calls are held to see the running state', async () => {
      [own] = await createOwnPhysical(world, 'L70', ['Photocard (Type A)']);
      await world.seedStock(own, cj, { available: 100, csManaged: false });
      await list.open();
      await list.chooseSearchField('SKU_GROUP_CODE');
      await list.typeKeyword(own.groupCode);
    });

    const observe = async (check: () => Promise<void>): Promise<boolean> => check().then(() => true, () => false);

    let searchOff = false;
    let searchBack = false;
    await step('Act: Step 1 — Click 검색 (Search) and watch that button while the list call is running', async () => {
      const held = await paging.holdRequest((url, method) => method === 'GET' && /\/api\/v1\/stock-status\?/.test(url));
      try {
        const response = page.waitForResponse((res) => /\/api\/v1\/stock-status\?/.test(res.url()), { timeout: 30_000 });
        await list.click(list.searchButton, `${stx('btn.search', 'ko')} button`);
        await held.seen;
        searchOff = await observe(() => expect(list.searchButton).toBeDisabled({ timeout: 5_000 }));
        held.release();
        await response;
        searchBack = await observe(() => expect(list.searchButton).toBeEnabled({ timeout: 30_000 }));
      } finally {
        held.release();
        await held.dispose();
      }
      await list.waitForList();
    });

    await step('Assert: Expected 1 — The button is greyed out until an answer comes back', async () => {
      expect(searchOff, '[Expected 1] 검색 is greyed out while the list call runs').toBe(true);
      expect(searchBack, '[Expected 1] 검색 is usable again once the answer comes back').toBe(true);
    });

    let exportOff = false;
    let exportBack = false;
    let fileName = '';
    await step('Act: Step 2 — Click 엑셀 다운로드 (Excel download) and watch that button while the call is running', async () => {
      const held = await paging.holdRequest((url, method) => method === 'GET' && /\/api\/v1\/stock-status\/excel/.test(url));
      try {
        const download = page.waitForEvent('download', { timeout: 60_000 });
        await list.click(list.exportButton, `${stx('btn.exportStockExcel', 'ko')} button`);
        await held.seen;
        exportOff = await observe(() => expect(list.exportButton).toBeDisabled({ timeout: 5_000 }));
        held.release();
        fileName = (await download).suggestedFilename();
        exportBack = await observe(() => expect(list.exportButton).toBeEnabled({ timeout: 30_000 }));
      } finally {
        held.release();
        await held.dispose();
      }
    });

    await step('Assert: Expected 2 — The button is greyed out until an answer comes back', async () => {
      expect(exportOff, '[Expected 2] 엑셀 다운로드 is greyed out while the export call runs').toBe(true);
      expect(fileName, '[Expected 2] The export answers with an Excel file').toMatch(/\.xlsx$/);
      expect(exportBack, '[Expected 2] 엑셀 다운로드 is usable again once the answer comes back').toBe(true);
    });

    let uploadOff = false;
    let uploadBack = false;
    let uploadStatus = 0;
    await step('Act: Step 3 — Upload a valid inbound file through 입고 요청 업로드 and watch that button while the file goes up', async () => {
      const file = xlsxFile(`inbound-${own.skuCode}.xlsx`, [
        ['출고지 ID', '제조사 ID', '입고유형', '입고 요청일', 'SKU 코드', '수량', '매입가격', '메모', '기타 사유'],
        [String(cj.id), String(world.manufacturers.M1.id), 'G', kstDate(10), own.skuCode, 10, 12000, `TC70 ${own.skuCode}`, null],
      ]);
      const held = await paging.holdRequest((url, method) => method === 'POST' && /\/api\/v1\/incoming\/upload-excel/.test(url));
      try {
        const response = page.waitForResponse((res) => /\/api\/v1\/incoming\/upload-excel/.test(res.url()), { timeout: 60_000 });
        await list.uploadVia('incoming', file);
        await held.seen;
        uploadOff = await observe(() => expect(list.uploadIncomingButton).toHaveAttribute('aria-disabled', 'true', { timeout: 5_000 }));
        held.release();
        uploadStatus = (await response).status();
        uploadBack = await observe(() => expect(list.uploadIncomingButton).toHaveAttribute('aria-disabled', 'false', { timeout: 30_000 }));
      } finally {
        held.release();
        await held.dispose();
      }
    });

    await step('Assert: Expected 3 — The button is greyed out until the file has finished uploading', async () => {
      expect(uploadOff, '[Expected 3] 입고 요청 업로드 is greyed out while the file goes up').toBe(true);
      expect(uploadStatus, '[Expected 3] The upload call has finished').toBeGreaterThan(0);
      expect(uploadBack, '[Expected 3] 입고 요청 업로드 is usable again once the upload has finished').toBe(true);
    });

    let saveOff = false;
    let saveStatus = 0;
    await step('Act: Step 4 — Tick the row, open 재고 조정, fill the row and watch 저장 (Save) while the save call is running', async () => {
      await list.search('SKU_GROUP_CODE', own.groupCode);
      await list.tick(list.row(own.skuCode), own.skuCode);
      await list.clickToolbar('btn.adjustStock');
      await adjustmentDialog.waitOpen();
      await adjustmentDialog.fillLine(0, { quantity: '1', modifyType: 'ADD', reason: 'ADJUSTMENT' });
      const held = await paging.holdRequest((url, method) => method === 'POST' && /\/api\/v1\/adjustments(\?|$)/.test(url));
      try {
        const response = page.waitForResponse((res) => /\/api\/v1\/adjustments(\?|$)/.test(res.url()) && res.request().method() === 'POST', { timeout: 60_000 });
        await adjustmentDialog.clickSave();
        await held.seen;
        saveOff = await observe(() => expect(adjustmentDialog.saveButton).toBeDisabled({ timeout: 5_000 }));
        held.release();
        saveStatus = (await response).status();
      } finally {
        held.release();
        await held.dispose();
      }
    });

    await step('Assert: Expected 4 — The button is greyed out until the save finishes', async () => {
      expect(saveOff, '[Expected 4] 저장 is greyed out while the save call runs').toBe(true);
      expect(saveStatus, '[Expected 4] The save call succeeds').toBeLessThan(300);
      await expect(adjustmentDialog.root, '[Expected 4] The save finishes and the dialog closes').toHaveCount(0);
    });
  });
});
