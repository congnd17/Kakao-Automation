import { test, expect } from '@fixtures/stock.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { escapeRegex, StockListPage } from '@pages/stock-list.page';
import { ListLoad, StockListSearchPage } from '@pages/stock-list-search.page';
import { DemoKey, StockWorld, WorldPartner, WorldSku } from '@utils/stock.data';
import { stockDb } from '@utils/stock-db';
import { stx } from '@utils/stock.i18n';
import { WORLD_NOTE, stockTags } from '@utils/stock-spec';

/**
 * US134 — nhóm [List] tìm kiếm / filter / 초기화 (TC_US134_22–45). Nguồn TC: SCRATCH/us134/TC_US134_<n>.txt.
 * Dữ liệu demo của TC (DEMO-SKU-0001…0012, DEMO-PC-xxx, Demo Partner A/B, 3 kho) được map lên world của suite:
 * mã/tên mang tag run → keyword 상품코드명 `<tag> Demo` khoanh đúng 12 dòng demo (SKU riêng của test khác mang tên
 * `<tag> <label>` nên không lọt vào). Kỳ vọng số dòng/mã tính từ world; chỗ dữ liệu world ≠ dữ liệu TC ghi trong description.
 * Chỉ chạy tiếng Hàn (không TC nào trong nhóm yêu cầu chạy 2 ngôn ngữ).
 */
const TAGS = stockTags('list');

const DEMO_KEYS: DemoKey[] = ['SKU0001', 'SKU0002', 'SKU0003', 'SKU0004', 'SKU0005', 'SKU0006', 'SKU0007', 'SKU0008', 'SKU0009', 'SKU0010', 'SKU0011', 'SKU0012'];

const MAPPING_NOTE =
  'The TC demo data is mapped onto the suite world (DEMO-PC-001 → world group PC001, DEMO-PC-002 → PC002, DEMO-SKU-000N → SKU000N); expected rows and counts are derived from the world, which differs from the TC tables where noted.';

/** Keyword 상품코드명 khoanh đúng 12 dòng demo của world. */
const demoKeyword = (world: StockWorld) => `${world.tag} Demo`;

const partnerName = (partner: WorldPartner) => partner.nameKo || partner.nameEn;

const stockRowOf = (world: StockWorld, key: DemoKey) => world.stockRows.find((row) => row.sku.key === key);

/** Khoá demo thoả điều kiện (SKU + dòng tồn kho nếu có). */
function keysWhere(world: StockWorld, predicate: (sku: WorldSku, warehouseId: number | null) => boolean): DemoKey[] {
  return DEMO_KEYS.filter((key) => predicate(world.sku(key), stockRowOf(world, key)?.warehouse.id ?? null));
}

const codesOf = (world: StockWorld, keys: DemoKey[]) => keys.map((key) => world.sku(key).skuCode).sort();

const demoCodes = (world: StockWorld) => new Set(codesOf(world, DEMO_KEYS));

/** SKU코드 đang hiển thị, đã sắp xếp; `demoOnly` = chỉ giữ dòng demo (search theo trường không mang tag run). */
async function shownCodes(search: StockListSearchPage, world: StockWorld, demoOnly = false): Promise<string[]> {
  const codes = await search.visibleSkuCodes();
  const demo = demoCodes(world);
  return codes.filter((code) => !demoOnly || demo.has(code)).sort();
}

/** Mở list và khoanh 12 dòng demo (Arrange cho TC giả định "Existing data" = 12 dòng). */
async function openDemoList(list: StockListPage, search: StockListSearchPage, world: StockWorld): Promise<ListLoad> {
  await list.open();
  return search.searchBy('SKU_GROUP_NAME', demoKeyword(world));
}

const noSelectionPattern = new RegExp(stx('guard.noSelection').split('\n').map(escapeRegex).join('\\s*'));

test.describe('[List] Stock management — search, filters and reset', () => {
  test('TC_US134_22 — A 15-digit SKU ID is shown and sent unchanged when its row is used for a stock adjustment', async ({ page, world, stockListPage: list, adjustmentDialog, stockHistoryDialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_22',
      'Critical',
      TAGS,
      `A physical SKU line with a 15-digit SKU ID, listed next to a line with the following ID, shows its ID digit by digit in the list, is the single line of the 재고 조정 dialog, is sent unchanged in POST /adjustments and gets the movement in 재고이력 — the neighbour row gets none. The test builds its own SKU group with 2 lines (adjacent server-generated 15-digit IDs, mapping 900000000000101/102) stocked in CJ Incheon Aam, and adjusts +1 with reason 조정. Deviation: the 재고 조정 dialog has no SKU ID column (SKU 코드 · SKU명 · 창고 · 전체 재고 · 조정 수량 · 증가/차감 · 조정사유 · 비고), so Expected 3 is checked softly on the line text. ${WORLD_NOTE}`,
    );
    const search = new StockListSearchPage(page, list);
    let first!: WorldSku;
    let next!: WorldSku;

    await step('Arrange: Pre-condition 1–4 — Own physical SKU group with 2 lines of adjacent 15-digit SKU IDs, both stocked in CJ Incheon Aam', async () => {
      [first, next] = await world.createPhysicalSku('TC022', { partner: world.partners.A, manufacturer: world.manufacturers.M1, lines: [{ option: 'A' }, { option: 'B' }] });
      await world.seedStock(first, world.warehouses.CJ, { available: 10 });
      await world.seedStock(next, world.warehouses.CJ, { available: 10 });
      expect(String(first.skuId), 'The SKU ID under test is 15 digits long').toMatch(/^\d{15}$/);
      expect(String(next.skuId), 'The neighbour SKU ID is 15 digits long').toMatch(/^\d{15}$/);
    });

    let cellText = '';
    await step('Act: Step 1 — Open 재고 관리 (Stock management) and read the SKU ID cell of the first row, digit by digit', async () => {
      await list.open();
      await search.searchBy('SKU_GROUP_CODE', first.groupCode);
      cellText = await list.cellText(list.rowBySkuId(first.skuId, world.warehouses.CJ.name), 'col.skuId');
    });

    await step('Assert: Expected 1 — The cell shows the 15-digit SKU ID', async () => {
      expect(cellText, `[Expected 1] The SKU ID cell shows ${first.skuId}`).toBe(String(first.skuId));
      await expect(list.rowBySkuId(next.skuId), `[Expected 1] The row with the next SKU ID ${next.skuId} is listed beside it`).toBeVisible();
    });

    await step('Act: Step 2 — Tick that row and click 재고 조정 (Stock adjustment)', async () => {
      await list.tick(list.row(first.skuCode, world.warehouses.CJ.name), first.skuCode);
      await list.clickToolbar('btn.adjustStock');
      await adjustmentDialog.waitOpen();
    });

    await step('Assert: Expected 2 — The dialog opens with one line', async () => {
      await expect(adjustmentDialog.root, '[Expected 2] The 재고 조정 dialog is open').toBeVisible();
      await expect(adjustmentDialog.rows, '[Expected 2] The dialog has exactly one line').toHaveCount(1);
    });

    let lineText = '';
    await step('Act: Step 3 — Read the SKU ID shown on the line in the dialog', async () => {
      lineText = (await adjustmentDialog.rowValues(0)).join(' | ');
    });

    await step('Assert: Expected 3 — The line shows the 15-digit SKU ID', async () => {
      expect(lineText, `[Expected 3] The line belongs to ${first.skuCode}`).toContain(first.skuCode);
      expect.soft(lineText, `[Expected 3] The line shows SKU ID ${first.skuId}`).toContain(String(first.skuId));
    });

    let rawBody = '';
    let sentSkuId: unknown;
    await step('Act: Step 4 — Enter 조정 수량 1 with 증가 and 조정사유 조정, click 저장 (Save) and read the data sent', async () => {
      await adjustmentDialog.fillLine(0, { quantity: '1', modifyType: 'ADD', reason: 'ADJUSTMENT' });
      const request = page.waitForRequest((req) => req.url().includes('/api/v1/adjustments') && req.method() === 'POST');
      const status = await adjustmentDialog.saveAndWait('/api/v1/adjustments');
      rawBody = (await request).postData() ?? '';
      sentSkuId = ((await request).postDataJSON() as { items?: Array<{ skuId?: unknown }> }).items?.[0]?.skuId;
      expect(status, 'POST /adjustments succeeds').toBeLessThan(300);
      await adjustmentDialog.expectClosed();
    });

    await step('Assert: Expected 4 — The data sent carries exactly the 15-digit SKU ID, with no digit changed', async () => {
      expect(rawBody, `[Expected 4] The raw request body carries "skuId":${first.skuId}`).toMatch(new RegExp(`"skuId":"?${first.skuId}"?[,}]`));
      expect(String(sentSkuId), `[Expected 4] items[0].skuId is ${first.skuId}`).toBe(String(first.skuId));
    });

    let firstUsages = 0;
    let nextUsages = 0;
    await step('Act: Step 5 — Open 재고이력 (Stock history) for that row and read which SKU the movement was written against', async () => {
      await list.waitForList();
      await list.openHistory(list.rowBySkuId(first.skuId, world.warehouses.CJ.name));
      await stockHistoryDialog.waitOpen();
      await stockHistoryDialog.waitLoaded();
      firstUsages = (await stockDb.usages(first.skuId, world.warehouses.CJ.id)).length;
      nextUsages = (await stockDb.usages(next.skuId, world.warehouses.CJ.id)).length;
    });

    await step('Assert: Expected 5 — The movement is written against the adjusted SKU and not the row next to it', async () => {
      await expect(stockHistoryDialog.contextLine, `[Expected 5] The history is the one of ${first.skuCode}`).toContainText(first.skuCode);
      await expect(stockHistoryDialog.contextLine, `[Expected 5] The history is not the one of ${next.skuCode}`).not.toContainText(next.skuCode);
      await expect(stockHistoryDialog.rows.filter({ hasNotText: stx('empty.noResults') }), '[Expected 5] The history of the adjusted row shows the one movement').toHaveCount(1);
      expect(firstUsages, `[Expected 5] One movement is stored against SKU ${first.skuId}`).toBe(1);
      expect(nextUsages, `[Expected 5] No movement is stored against the neighbour SKU ${next.skuId}`).toBe(0);
    });
  });

  test('TC_US134_23 — The filter block shows its 5 controls left to right and no date-range, status or created-date control', async ({ page, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_23',
      'Medium',
      TAGS,
      'The filter block reads 검색조건 · SKU유형 · 대구분 · 창고 · 비즈파트너 from left to right (대구분 right before 창고) and has no date-range, status or created-date control and no 6th control.',
    );
    const search = new StockListSearchPage(page, list);

    await step('Arrange: Pre-condition 1–2 — Logged in with write access, stock data exists', async () => {
      await list.open();
    });

    let labels: string[] = [];
    await step('Act: Step 1 — Open 재고 관리 (Stock management) and read the labels of the filter block from left to right', async () => {
      labels = await search.filterLabels();
    });

    await step('Assert: Expected 1 — 검색조건, SKU유형, 대구분, 창고, 비즈파트너 from left to right', async () => {
      const expected = ['filter.searchCondition', 'filter.skuType', 'filter.warehouseGroup', 'filter.warehouse', 'filter.bizPartner'] as const;
      expected.forEach((key, index) => {
        expect(labels[index], `[Expected 1] Control ${index + 1} from the left is ${stx(key)}`).toBe(stx(key));
      });
      expect(labels.indexOf(stx('filter.warehouse')) - labels.indexOf(stx('filter.warehouseGroup')), '[Expected 1] 대구분 sits right before 창고').toBe(1);
    });

    await step('Act: Step 2 — Look in the filter block for any date-range, status or created-date control', async () => {
      await expect(list.filterRow, 'The filter block is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — No date-range, status or created-date control and no 6th control', async () => {
      await expect(list.filterRow.locator('input[type="date"], input[placeholder*="YYYY"], .react-datepicker-wrapper'), '[Expected 2] There is no date-range control').toHaveCount(0);
      await expect(list.filterRow.locator('label.form-label', { hasText: /상태|status/i }), '[Expected 2] There is no status control').toHaveCount(0);
      await expect(list.filterRow.locator('label.form-label', { hasText: /생성일|등록일|기간|날짜|date/i }), '[Expected 2] There is no created-date or date control').toHaveCount(0);
      await expect(list.filterRow.locator('label.form-label'), '[Expected 2] There is no 6th control').toHaveCount(5);
    });
  });

  test('TC_US134_24 — The search condition offers 7 choices in order and starts on 상품코드명', async ({ page, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US134_24', 'Medium', TAGS, '검색조건 starts on 상품코드명 and offers exactly 7 choices: 상품코드명, 상품코드, SKU명, SKU코드, SKU ID, 바코드, HS CODE.');
    const search = new StockListSearchPage(page, list);

    await step('Arrange: Pre-condition 1–2 — Logged in with write access, stock data exists', async () => {
      await list.open();
    });

    let initial = '';
    await step('Act: Step 1 — Open 재고 관리 (Stock management) and read the value in 검색조건 (Search condition) before touching anything', async () => {
      initial = await search.selectedText(list.searchFieldSelect);
    });

    await step('Assert: Expected 1 — 검색조건 shows 상품코드명', async () => {
      expect(initial, `[Expected 1] 검색조건 starts on ${stx('searchField.SKU_GROUP_NAME')}`).toBe(stx('searchField.SKU_GROUP_NAME'));
      await expect(list.searchFieldSelect, '[Expected 1] The selected value is SKU_GROUP_NAME').toHaveValue('SKU_GROUP_NAME');
    });

    let options: string[] = [];
    await step('Act: Step 2 — Open the list and count the choices', async () => {
      options = await search.optionTexts(list.searchFieldSelect);
    });

    await step('Assert: Expected 2 — There are exactly 7 choices', async () => {
      expect(options.length, '[Expected 2] 검색조건 has exactly 7 choices').toBe(7);
    });

    await step('Act: Step 3 — Read each choice in order', async () => {
      expect(options.length, 'The choices are read').toBeGreaterThan(0);
    });

    await step('Assert: Expected 3 — 상품코드명, 상품코드, SKU명, SKU코드, SKU ID, 바코드, HS CODE in this order', async () => {
      const fields = ['SKU_GROUP_NAME', 'SKU_GROUP_CODE', 'SKU_NAME', 'SKU_CODE', 'SKU_ID', 'BARCODE', 'HS_CODE'] as const;
      fields.forEach((field, index) => {
        expect(options[index], `[Expected 3] Choice ${index + 1} is ${stx(`searchField.${field}`)}`).toBe(stx(`searchField.${field}`));
      });
    });
  });

  test('TC_US134_25 — The Barcode search condition matches a fragment of the barcode only and skips rows with no barcode', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_25',
      'Medium',
      TAGS,
      `바코드 search with a fragment of SKU0001's barcode lists only SKU0001; a fragment of SKU0001's SKU code finds nothing (검색 결과가 없습니다.); the fragment shared by every demo barcode (the run tag, mapping "DEMO") lists every SKU that has a barcode and none of the digital SKU0006 / SKU0010. World: only the 8 physical SKUs carry a barcode (the 2 set SKUs have none), so the count line expects 8 instead of the TC's 10. The host pager writes "총 N개의 재고 중 …", the TC "총 N개의 항목 중 …" — the wording is checked softly. ${MAPPING_NOTE} ${WORLD_NOTE}`,
    );
    const search = new StockListSearchPage(page, list);
    const sku1 = world.sku('SKU0001');
    const barcodeFragment = (sku1.barcode ?? '').slice(2);
    const skuCodeFragment = sku1.skuCode.slice(2);
    const withBarcode = keysWhere(world, (sku) => !!sku.barcode && sku.barcode.includes(world.tag));

    await step('Arrange: Pre-condition 1–2 — Demo rows with barcodes, SKU0006 / SKU0010 without, 페이지당 10', async () => {
      expect(sku1.barcode, 'SKU0001 has a barcode').toBeTruthy();
      expect(world.sku('SKU0006').barcode ?? '', 'SKU0006 has no barcode').toBe('');
      expect(world.sku('SKU0010').barcode ?? '', 'SKU0010 has no barcode').toBe('');
      await list.open();
    });

    await step('Act: Step 1 — Set 검색조건 to 바코드 (Barcode), type a fragment of SKU0001\'s barcode and click 검색 (Search)', async () => {
      await search.searchBy('BARCODE', barcodeFragment);
    });

    await step('Assert: Expected 1 — Only the SKU0001 row is listed', async () => {
      expect(await shownCodes(search, world), `[Expected 1] Only ${sku1.skuCode} is listed`).toEqual([sku1.skuCode]);
    });

    await step('Act: Step 2 — Replace the keyword with a fragment of SKU0001\'s SKU code and click 검색 (Search)', async () => {
      await list.typeKeyword(skuCodeFragment);
      await search.clickSearch();
    });

    await step('Assert: Expected 2 — No row is listed and 검색 결과가 없습니다. is shown inside the table', async () => {
      expect(await list.dataRowCount(), '[Expected 2] No row is listed although SKU0001 has that SKU code').toBe(0);
      await expect(list.noResultsRow(), `[Expected 2] ${stx('empty.noResults')} is shown inside the table`).toBeVisible();
    });

    await step('Act: Step 3 — Replace the keyword with the fragment shared by every demo barcode, click 검색 (Search) and read the count line', async () => {
      await list.typeKeyword(world.tag);
      await search.clickSearch();
    });

    await step('Assert: Expected 3 — The count line shows every SKU with a barcode, and neither SKU0006 nor SKU0010 is listed', async () => {
      const total = withBarcode.length;
      await expect(list.pagerText, `[Expected 3] The count line shows ${total} items, 1-${Math.min(total, 10)}`).toHaveText(search.pagerPattern(total, 1, Math.min(total, 10)));
      expect.soft(await list.pagerText.innerText(), '[Expected 3] The count line uses the TC wording').toBe(search.tcPagerText(total, 1, Math.min(total, 10)));
      const shown = await shownCodes(search, world);
      expect(shown, '[Expected 3] Every demo SKU with a barcode is listed').toEqual(codesOf(world, withBarcode));
      expect(shown, '[Expected 3] SKU0006 (no barcode) is not listed').not.toContain(world.sku('SKU0006').skuCode);
      expect(shown, '[Expected 3] SKU0010 (no barcode) is not listed').not.toContain(world.sku('SKU0010').skuCode);
    });
  });

  test('TC_US134_26 — Searching by HS code matches the full code and fragments of it', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_26',
      'Medium',
      TAGS,
      `HS CODE search: 6109101001 lists the SKU0001 row, the fragment 91010 lists every demo row that has an HS code (not the digital SKU0006 / SKU0010), the fragment 1003 lists the SKU0003 row; every row the server returns carries an HS code containing the keyword. World: the HS code is stored per SKU group (product code), so 6109101001 also lists SKU0002 (same group PC001) and 1003 also lists SKU0004 / SKU0008 (group PC002); only the 8 physical SKUs carry an HS code (TC: 10). HS codes are not run-unique, so only demo rows are compared and the page shows 100 rows. ${MAPPING_NOTE} ${WORLD_NOTE}`,
    );
    const search = new StockListSearchPage(page, list);
    const hsOf = (fragment: string) => keysWhere(world, (sku) => !!sku.hsCode && sku.hsCode.includes(fragment));
    let load!: ListLoad;

    await step('Arrange: Pre-condition 1–2 — Demo rows with HS codes (SKU0001 6109101001, SKU0003 6109101003), SKU0006 / SKU0010 without; 100 rows per page', async () => {
      expect(world.sku('SKU0001').hsCode, 'SKU0001 has HS code 6109101001').toBe('6109101001');
      expect(world.sku('SKU0003').hsCode, 'SKU0003 has HS code 6109101003').toBe('6109101003');
      await list.open();
      await list.choosePageSize(100);
    });

    await step('Act: Step 1 — Set 검색조건 to HS CODE, type 6109101001 and click 검색 (Search)', async () => {
      load = await search.searchBy('HS_CODE', '6109101001');
    });

    await step('Assert: Expected 1 — The list runs again', async () => {
      expect(load.status, '[Expected 1] The list request succeeds').toBe(200);
      expect(load.url.searchParams.get('searchType'), '[Expected 1] The list runs with searchType HS_CODE').toBe('HS_CODE');
      expect(load.url.searchParams.get('keyword'), '[Expected 1] The list runs with keyword 6109101001').toBe('6109101001');
    });

    await step('Act: Step 2 — Read the table', async () => {
      await list.waitForList();
    });

    await step('Assert: Expected 2 — Only the SKU0001 row is listed (world: SKU0001 and SKU0002 of the same group)', async () => {
      expect(await shownCodes(search, world, true), '[Expected 2] The demo rows with HS code 6109101001 are listed').toEqual(codesOf(world, hsOf('6109101001')));
      expect(await shownCodes(search, world, true), '[Expected 2] SKU0001 is listed').toContain(world.sku('SKU0001').skuCode);
      for (const item of load.items) expect(item.hsCode ?? '', `[Expected 2] Listed row ${item.skuCode} has HS code 6109101001`).toBe('6109101001');
    });

    await step('Act: Step 3 — Replace the keyword with 91010 and click 검색 (Search)', async () => {
      await list.typeKeyword('91010');
      load = await search.clickSearch();
    });

    await step('Assert: Expected 3 — The rows that have an HS code are listed, and SKU0006 / SKU0010 are not', async () => {
      const shown = await shownCodes(search, world, true);
      expect(shown, '[Expected 3] Every demo row with an HS code is listed').toEqual(codesOf(world, hsOf('91010')));
      expect(shown, '[Expected 3] SKU0006 is not listed').not.toContain(world.sku('SKU0006').skuCode);
      expect(shown, '[Expected 3] SKU0010 is not listed').not.toContain(world.sku('SKU0010').skuCode);
      for (const item of load.items) expect(item.hsCode ?? '', `[Expected 3] Listed row ${item.skuCode} has an HS code containing 91010`).toContain('91010');
    });

    await step('Act: Step 4 — Replace the keyword with 1003 and click 검색 (Search)', async () => {
      await list.typeKeyword('1003');
      load = await search.clickSearch();
    });

    await step('Assert: Expected 4 — Only the SKU0003 row is listed (world: the whole group PC002)', async () => {
      const shown = await shownCodes(search, world, true);
      expect(shown, '[Expected 4] The demo rows whose HS code contains 1003 are listed').toEqual(codesOf(world, hsOf('1003')));
      expect(shown, '[Expected 4] SKU0003 is listed').toContain(world.sku('SKU0003').skuCode);
      expect(shown, '[Expected 4] SKU0001 (6109101001) is not listed').not.toContain(world.sku('SKU0001').skuCode);
      for (const item of load.items) expect(item.hsCode ?? '', `[Expected 4] Listed row ${item.skuCode} has an HS code containing 1003`).toContain('1003');
    });
  });

  test('TC_US134_27 — Each search condition targets its own field', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_27',
      'Medium',
      TAGS,
      `상품코드명 / 상품코드 / SKU코드 / SKU명 / SKU ID / 바코드 / HS CODE each filter on their own field. Mapping: "Hoodie zip-up" → the world product name "<tag> Demo Hoodie", DEMO-PC-002 → world group PC002, "Tote bag" → SKU0008's SKU name. World: group PC002 holds SKU0003 / SKU0004 / SKU0008 (TC: product name matches 0003+0004, product code 0003/0004/0008/0012), and the HS code is per group so 6109101001 lists SKU0001 and SKU0002. ${MAPPING_NOTE} ${WORLD_NOTE}`,
    );
    const search = new StockListSearchPage(page, list);
    const hoodie = `${world.tag} Demo Hoodie`;
    const pc002 = world.sku('SKU0003').groupCode;
    const sku1 = world.sku('SKU0001');
    const sku8Name = world.sku('SKU0008').skuName;
    let load!: ListLoad;

    await step('Arrange: Pre-condition 1–2 — Demo rows present (group PC002 = SKU0003/0004/0008, SKU0001 with barcode, SKU ID and HS code 6109101001)', async () => {
      await list.open();
    });

    await step('Act: Step 1 — Leave 검색조건 on 상품코드명, type the Hoodie product name and click 검색 (Search)', async () => {
      await list.typeKeyword(hoodie);
      await search.clickSearch();
    });

    await step('Assert: Expected 1 — Only the rows whose product name contains the keyword are listed', async () => {
      expect(await shownCodes(search, world), `[Expected 1] Only the rows of product "${hoodie}" are listed`).toEqual(codesOf(world, keysWhere(world, (sku) => sku.groupName.includes(hoodie))));
    });

    await step('Act: Step 2 — Switch to 상품코드 (Product code), replace the keyword with the PC002 product code and click 검색 (Search)', async () => {
      await search.searchBy('SKU_GROUP_CODE', pc002);
    });

    await step('Assert: Expected 2 — Only the rows with that product code are listed', async () => {
      expect(await shownCodes(search, world), `[Expected 2] Only the rows of product code ${pc002} are listed`).toEqual(codesOf(world, keysWhere(world, (sku) => sku.groupCode === pc002)));
    });

    await step('Act: Step 3 — Switch to SKU코드 (SKU code), replace the keyword with SKU0003\'s SKU code and click 검색 (Search)', async () => {
      await search.searchBy('SKU_CODE', world.sku('SKU0003').skuCode);
    });

    await step('Assert: Expected 3 — Only the SKU0003 row is listed', async () => {
      expect(await shownCodes(search, world), '[Expected 3] Only SKU0003 is listed').toEqual([world.sku('SKU0003').skuCode]);
    });

    await step('Act: Step 4 — Switch to SKU명 (SKU name), replace the keyword with SKU0008\'s SKU name and click 검색 (Search)', async () => {
      await search.searchBy('SKU_NAME', sku8Name);
    });

    await step('Assert: Expected 4 — Only the SKU0008 row is listed', async () => {
      expect(await shownCodes(search, world), '[Expected 4] Only SKU0008 is listed').toEqual([world.sku('SKU0008').skuCode]);
    });

    await step('Act: Step 5 — Switch to SKU ID, replace the keyword with SKU0001\'s SKU ID and click 검색 (Search)', async () => {
      await search.searchBy('SKU_ID', String(sku1.skuId));
    });

    await step('Assert: Expected 5 — Only the SKU0001 row is listed', async () => {
      expect(await shownCodes(search, world), '[Expected 5] Only SKU0001 is listed').toEqual([sku1.skuCode]);
    });

    await step('Act: Step 6 — Switch to 바코드 (Barcode), replace the keyword with SKU0001\'s barcode and click 검색 (Search)', async () => {
      await search.searchBy('BARCODE', sku1.barcode ?? '');
    });

    await step('Assert: Expected 6 — Only the SKU0001 row is listed, filtered on the barcode column', async () => {
      expect(await shownCodes(search, world), '[Expected 6] Only SKU0001 is listed').toEqual([sku1.skuCode]);
      expect(await list.columnValues('col.barcode'), `[Expected 6] The listed row has barcode ${sku1.barcode}`).toEqual([sku1.barcode ?? '']);
    });

    await step('Act: Step 7 — Switch to HS CODE, replace the keyword with 6109101001 and click 검색 (Search)', async () => {
      load = await search.searchBy('HS_CODE', '6109101001');
    });

    await step('Assert: Expected 7 — Only the SKU0001 row is listed, filtered on the HS code column', async () => {
      const shown = await shownCodes(search, world, true);
      expect(shown, '[Expected 7] SKU0001 is listed').toContain(sku1.skuCode);
      expect(shown, '[Expected 7] Only the demo rows with HS code 6109101001 are listed').toEqual(codesOf(world, keysWhere(world, (sku) => sku.hsCode === '6109101001')));
      for (const item of load.items) expect(item.hsCode ?? '', `[Expected 7] Listed row ${item.skuCode} has HS code 6109101001`).toBe('6109101001');
    });
  });

  test('TC_US134_28 — Every text search matches part of a value, including product code, SKU code and barcode', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_28',
      'High',
      TAGS,
      `상품코드 / SKU코드 / 바코드 match on part of the value. Mapping: product code 263QRVPPFALIV2 → the world PC001 product code (fragment "263Q" → its leading part, "RV" → a middle part); "SKU-000" → "<tag>SKU000" (minus the first 2 tag characters); "BC-000" → "<tag>PC00" (the barcodes of the 5 physical groups). ${MAPPING_NOTE} ${WORLD_NOTE}`,
    );
    const search = new StockListSearchPage(page, list);
    const code = world.sku('SKU0001').groupCode;
    const skuFragment = `${world.tag.slice(2)}SKU000`;
    const barcodeFragment = `${world.tag.slice(2)}PC00`;

    await step('Arrange: Pre-condition 1–3 — A physical row with a known product code; SKU0001 with its barcode', async () => {
      expect(world.sku('SKU0001').barcode, 'SKU0001 has a barcode').toBeTruthy();
      await list.open();
    });

    await step('Act: Step 1 — Set 검색조건 to 상품코드 (Product code), type the leading part of the product code and click 검색 (Search)', async () => {
      await search.searchBy('SKU_GROUP_CODE', code.slice(0, -2));
    });

    await step('Assert: Expected 1 — The row with that product code is listed', async () => {
      expect(await list.columnValues('col.skuGroupCode'), `[Expected 1] The row with product code ${code} is listed`).toContain(code);
    });

    await step('Act: Step 2 — Replace the keyword with a middle part of the product code and click 검색 (Search)', async () => {
      await list.typeKeyword(code.slice(3, -3));
      await search.clickSearch();
    });

    await step('Assert: Expected 2 — That row is still listed', async () => {
      expect(await list.columnValues('col.skuGroupCode'), `[Expected 2] The row with product code ${code} is still listed`).toContain(code);
    });

    await step('Act: Step 3 — Switch to SKU코드 (SKU code), type the SKU-code fragment and click 검색 (Search)', async () => {
      await search.searchBy('SKU_CODE', skuFragment);
    });

    await step('Assert: Expected 3 — Every row whose SKU code contains the fragment is listed', async () => {
      const expected = codesOf(world, keysWhere(world, (sku) => sku.skuCode.includes(skuFragment)));
      const shown = await shownCodes(search, world);
      expect(expected.length, 'The world holds SKU codes with that fragment').toBeGreaterThan(0);
      expect(shown, `[Expected 3] Every demo row whose SKU code contains ${skuFragment} is listed`).toEqual(expect.arrayContaining(expected));
      for (const shownCode of shown) expect(shownCode, `[Expected 3] Listed SKU code ${shownCode} contains ${skuFragment}`).toContain(skuFragment);
    });

    await step('Act: Step 4 — Switch to 바코드 (Barcode), type the barcode fragment and click 검색 (Search)', async () => {
      await search.searchBy('BARCODE', barcodeFragment);
    });

    await step('Assert: Expected 4 — Every row whose barcode contains the fragment is listed', async () => {
      const expected = codesOf(world, keysWhere(world, (sku) => !!sku.barcode && sku.barcode.includes(barcodeFragment)));
      expect(expected.length, 'The world holds barcodes with that fragment').toBeGreaterThan(0);
      expect(await shownCodes(search, world), `[Expected 4] Every demo row whose barcode contains ${barcodeFragment} is listed`).toEqual(expect.arrayContaining(expected));
      for (const barcode of await list.columnValues('col.barcode')) expect(barcode, `[Expected 4] Listed barcode ${barcode} contains ${barcodeFragment}`).toContain(barcodeFragment);
    });
  });

  test('TC_US134_29 — SKU ID alone matches the full value, not part of it', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_29',
      'Medium',
      TAGS,
      `SKU ID search with SKU0001's full 15-digit ID lists only SKU0001; its first 7 digits (mapping 9000000) list nothing. ${MAPPING_NOTE} ${WORLD_NOTE}`,
    );
    const search = new StockListSearchPage(page, list);
    const sku1 = world.sku('SKU0001');
    const part = String(sku1.skuId).slice(0, 7);
    let load!: ListLoad;

    await step('Arrange: Pre-condition 1–3 — SKU0001 and SKU0002 with 15-digit SKU IDs', async () => {
      expect(String(sku1.skuId), 'SKU0001 has a 15-digit SKU ID').toMatch(/^\d{15}$/);
      expect(String(world.sku('SKU0002').skuId), 'SKU0002 has a 15-digit SKU ID').toMatch(/^\d{15}$/);
      await list.open();
    });

    await step('Act: Step 1 — Set 검색조건 to SKU ID, type SKU0001\'s full SKU ID and click 검색 (Search)', async () => {
      load = await search.searchBy('SKU_ID', String(sku1.skuId));
    });

    await step('Assert: Expected 1 — The list runs again', async () => {
      expect(load.status, '[Expected 1] The list request succeeds').toBe(200);
      expect(load.url.searchParams.get('keyword'), `[Expected 1] The list runs with keyword ${sku1.skuId}`).toBe(String(sku1.skuId));
    });

    await step('Act: Step 2 — Read the table', async () => {
      await list.waitForList();
    });

    await step('Assert: Expected 2 — Only the SKU0001 row is listed', async () => {
      expect(await shownCodes(search, world), '[Expected 2] Only SKU0001 is listed').toEqual([sku1.skuCode]);
    });

    await step('Act: Step 3 — Replace the keyword with part of the SKU ID and click 검색 (Search)', async () => {
      await list.typeKeyword(part);
      load = await search.clickSearch();
    });

    await step('Assert: Expected 3 — The list runs again', async () => {
      expect(load.status, '[Expected 3] The list request succeeds').toBe(200);
      expect(load.url.searchParams.get('keyword'), `[Expected 3] The list runs with keyword ${part}`).toBe(part);
    });

    await step('Act: Step 4 — Read the table again', async () => {
      await list.waitForList();
    });

    await step('Assert: Expected 4 — No row is listed', async () => {
      expect(await list.dataRowCount(), '[Expected 4] No row is listed for part of a SKU ID').toBe(0);
      await expect(list.noResultsRow(), `[Expected 4] ${stx('empty.noResults')} is shown`).toBeVisible();
    });
  });

  test('TC_US134_30 — % and _ in the keyword are matched as plain characters', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const code = world.sku('SKU0001').groupCode;
    const underscored = `${code.slice(0, world.tag.length)}_${code.slice(world.tag.length + 1)}`;
    await tcMeta(
      'TC_US134_30',
      'Medium',
      TAGS,
      `상품코드 search: "%" lists nothing (검색 결과가 없습니다.); "DEMO_PC" is mapped to the PC001 product code with one character replaced by "_" (<tag>_C001…) — as a one-character wildcard it would match PC001, as a plain character it matches nothing. ${MAPPING_NOTE} ${WORLD_NOTE}`,
    );
    const search = new StockListSearchPage(page, list);

    await step('Arrange: Pre-condition 1–2 — Demo rows present; no product code contains % or _', async () => {
      expect(code.includes('_') || code.includes('%'), 'The PC001 product code has no % or _').toBe(false);
      await list.open();
    });

    await step('Act: Step 1 — Set 검색조건 to 상품코드 (Product code), type % and click 검색 (Search)', async () => {
      await search.searchBy('SKU_GROUP_CODE', '%');
    });

    await step('Assert: Expected 1 — No row is listed and 검색 결과가 없습니다. is shown', async () => {
      expect(await list.dataRowCount(), '[Expected 1] No row is listed for %').toBe(0);
      await expect(list.noResultsRow(), `[Expected 1] ${stx('empty.noResults')} is shown`).toBeVisible();
    });

    await step('Act: Step 2 — Replace the keyword with the product code holding _ and click 검색 (Search)', async () => {
      await list.typeKeyword(underscored);
      await search.clickSearch();
    });

    await step('Assert: Expected 2 — No row is listed — _ is not a one-character wildcard', async () => {
      expect(await list.dataRowCount(), `[Expected 2] No row is listed for ${underscored}`).toBe(0);
      expect(await list.columnValues('col.skuGroupCode'), `[Expected 2] ${code} is not matched through _`).not.toContain(code);
    });
  });

  test('TC_US134_31 — Typing and changing a choice list never starts a search by itself', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_31',
      'Medium',
      TAGS,
      `With the 12 demo rows listed (count line 총 12개 … 1-10), typing the PC002 product code one character at a time and changing 창고 → CJ Daegu warehouse, 비즈파트너, SKU유형 → 현물 sends no list request and leaves the table and the count line as they were; 검색 then sends exactly 1 request listing only the rows matching all 4 conditions. Mapping: "Demo Partner B" (owner of DEMO-SKU-0008 in CJ Daegu in the TC) → world Demo Partner A, which owns SKU0008 and the CJ Daegu warehouse — the 창고 choice list only offers warehouses of the chosen biz partners and drops a chosen warehouse of another partner. The host pager wording (재고 vs 항목) is checked softly. ${MAPPING_NOTE} ${WORLD_NOTE}`,
    );
    test.skip(!world.warehouses.DAEGU, world.daeguUnavailableReason ?? 'No CJ Daegu warehouse in the world');
    const search = new StockListSearchPage(page, list);
    const daegu = world.warehouses.DAEGU!;
    const partner = world.partners.A;
    const pc002 = world.sku('SKU0003').groupCode;
    let codesBefore: string[] = [];
    let pagerBefore = '';
    let requestsBefore = 0;

    await step('Arrange: Pre-condition 1–3 — The 12 demo rows are listed (총 12개 … 1-10) and the request history is cleared', async () => {
      await openDemoList(list, search, world);
      await expect(list.pagerText, 'The count line shows 12 items, 1-10').toHaveText(search.pagerPattern(12, 1, 10));
      expect.soft(await list.pagerText.innerText(), 'The count line uses the TC wording').toBe(search.tcPagerText(12, 1, 10));
      codesBefore = await search.visibleSkuCodes();
      pagerBefore = await list.pagerText.innerText();
      requestsBefore = search.listRequests.length;
    });

    await step('Act: Step 1 — Click into the keyword box and type the PC002 product code one character at a time', async () => {
      await search.typeSlowly(pc002);
    });

    await step('Assert: Expected 1 — The keyword box holds the product code', async () => {
      await expect(list.keywordInput, `[Expected 1] The keyword box holds ${pc002}`).toHaveValue(pc002);
    });

    await step('Act: Step 2 — Without clicking anything, read the table, the count line and the request list', async () => {
      await expect(list.table, 'The table is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — Same 10 rows, same count line, no list request sent', async () => {
      expect(await search.visibleSkuCodes(), '[Expected 2] The table still shows the same 10 rows').toEqual(codesBefore);
      expect(codesBefore.length, '[Expected 2] The table shows 10 rows').toBe(10);
      await expect(list.pagerText, '[Expected 2] The count line still reads 총 12개 … 1-10').toHaveText(pagerBefore);
      expect(search.listRequests.length - requestsBefore, '[Expected 2] No list request has been sent while typing').toBe(0);
    });

    await step('Act: Step 3 — Change 창고 to CJ Daegu warehouse, then 비즈파트너 to the partner owning SKU0008, then SKU유형 to 현물', async () => {
      await list.pickMulti('warehouse', daegu.name);
      await list.pickMulti('bizPartner', partnerName(partner));
      await list.chooseSkuType('PHYSICAL');
    });

    await step('Assert: Expected 3 — Each control shows the value just chosen', async () => {
      await expect(list.warehouseMulti, `[Expected 3] 창고 shows ${daegu.name}`).toContainText(daegu.name);
      await expect(list.bizPartnerMulti, `[Expected 3] 비즈파트너 shows ${partnerName(partner)}`).toContainText(partnerName(partner));
      await expect(list.skuTypeSelect, '[Expected 3] SKU유형 shows 현물').toHaveValue('PHYSICAL');
      expect(await search.selectedText(list.skuTypeSelect), '[Expected 3] SKU유형 reads 현물').toBe(stx('skuType.PHYSICAL'));
    });

    await step('Act: Step 4 — Read the table, the count line and the request list again', async () => {
      await expect(list.table, 'The table is shown').toBeVisible();
    });

    await step('Assert: Expected 4 — Table and count line unchanged, still no list request', async () => {
      expect(await search.visibleSkuCodes(), '[Expected 4] The table is unchanged').toEqual(codesBefore);
      await expect(list.pagerText, '[Expected 4] The count line is unchanged').toHaveText(pagerBefore);
      expect(search.listRequests.length - requestsBefore, '[Expected 4] Still no list request has been sent').toBe(0);
    });

    let requestsAtSearch = 0;
    await step('Act: Step 5 — Click 검색 (Search)', async () => {
      requestsAtSearch = search.listRequests.length;
      await search.clickSearch();
    });

    await step('Assert: Expected 5 — Exactly 1 list request is sent and only rows matching all 4 conditions are listed', async () => {
      expect(search.listRequests.length - requestsAtSearch, '[Expected 5] Exactly 1 list request is sent').toBe(1);
      const expected = codesOf(world, keysWhere(world, (sku, warehouseId) => sku.groupCode === pc002 && warehouseId === daegu.id && sku.partner.id === partner.id && sku.type === 'PHYSICAL'));
      expect(expected.length, 'The world holds rows matching all 4 conditions').toBeGreaterThan(0);
      expect(await shownCodes(search, world), '[Expected 5] Only the rows matching keyword, warehouse, biz partner and SKU type are listed').toEqual(expected);
    });
  });

  test('TC_US134_32 — Pressing Enter in the keyword box runs the same search as the Search button', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_32',
      'Medium',
      TAGS,
      `Typing the PC002 product code (mapping DEMO-PC-002) with 검색조건 on 상품코드명 and pressing Enter runs the list without the Search button; 초기화 + the same keyword + 검색 gives the same rows in the same order. World: group PC002 holds SKU0003 / SKU0004 / SKU0008 (TC also lists SKU0012). ${MAPPING_NOTE} ${WORLD_NOTE}`,
    );
    const search = new StockListSearchPage(page, list);
    const pc002 = world.sku('SKU0003').groupCode;
    let enterLoad!: ListLoad;
    let enterRows: string[] = [];
    let buttonLoad!: ListLoad;

    await step('Arrange: Pre-condition 1–2 — Logged in with write access, demo rows present', async () => {
      await list.open();
    });

    await step('Act: Step 1 — Type the PC002 product code into the keyword box and press Enter while the cursor is in the box', async () => {
      await list.typeKeyword(pc002);
      enterLoad = await search.pressEnterInKeyword();
    });

    await step('Assert: Expected 1 — The list runs again without the Search button being clicked', async () => {
      expect(enterLoad.status, '[Expected 1] The list request sent on Enter succeeds').toBe(200);
      expect(enterLoad.url.searchParams.get('keyword'), `[Expected 1] The list runs with keyword ${pc002}`).toBe(pc002);
    });

    await step('Act: Step 2 — Read the table', async () => {
      enterRows = await search.visibleSkuCodes();
    });

    await step('Assert: Expected 2 — Only the rows with the PC002 product code are listed', async () => {
      expect([...enterRows].sort(), `[Expected 2] Only the rows of product code ${pc002} are listed`).toEqual(codesOf(world, keysWhere(world, (sku) => sku.groupCode === pc002)));
    });

    await step('Act: Step 3 — Click 초기화 (Reset), type the PC002 product code again and click 검색 (Search)', async () => {
      await search.clickReset();
      await list.typeKeyword(pc002);
      buttonLoad = await search.clickSearch();
    });

    await step('Assert: Expected 3 — The list runs again', async () => {
      expect(buttonLoad.status, '[Expected 3] The list request sent by 검색 succeeds').toBe(200);
      expect(buttonLoad.url.searchParams.get('keyword'), `[Expected 3] The list runs with keyword ${pc002}`).toBe(pc002);
    });

    await step('Act: Step 4 — Compare the table with the result from step 2', async () => {
      await list.waitForList();
    });

    await step('Assert: Expected 4 — Same rows in the same order — Enter and the Search button run the same thing', async () => {
      expect(await search.visibleSkuCodes(), '[Expected 4] The same rows are listed in the same order').toEqual(enterRows);
      expect(buttonLoad.url.search, '[Expected 4] Enter and 검색 send the same list request').toBe(enterLoad.url.search);
    });
  });

  test('TC_US134_33 — Spaces around a keyword are trimmed when searching, not while typing', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_33',
      'Medium',
      TAGS,
      `A keyword of 3 spaces + the PC002 product code + 3 spaces stays untrimmed in the box while typing, and 검색 lists the PC002 rows as a clean keyword does (the request carries the trimmed keyword). Expected 4 is NEEDS CLARIFICATION in the TC: the test only checks the box still holds the keyword and records its exact value (the screen re-syncs the box from the applied, trimmed criteria). ${MAPPING_NOTE} ${WORLD_NOTE}`,
    );
    const search = new StockListSearchPage(page, list);
    const pc002 = world.sku('SKU0003').groupCode;
    const padded = `   ${pc002}   `;
    let load!: ListLoad;
    let afterValue = '';

    await step('Arrange: Pre-condition 1–3 — Demo rows present; keyword = 3 spaces + product code + 3 spaces', async () => {
      await list.open();
    });

    await step('Act: Step 1 — Type the keyword with spaces at both ends into the box', async () => {
      await list.typeKeyword(padded);
    });

    await step('Assert: Expected 1 — The box accepts the value with spaces at both ends', async () => {
      await expect(list.keywordInput, '[Expected 1] The box accepts the padded value').toHaveValue(padded);
    });

    await step('Act: Step 2 — Read what is in the keyword box before clicking anything', async () => {
      await expect(list.keywordInput, 'The keyword box is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — The box still has the spaces at both ends', async () => {
      await expect(list.keywordInput, '[Expected 2] The spaces at both ends are kept while typing').toHaveValue(padded);
    });

    await step('Act: Step 3 — Click 검색 (Search)', async () => {
      load = await search.clickSearch();
    });

    await step('Assert: Expected 3 — The PC002 rows are listed, as with a clean keyword', async () => {
      expect(await shownCodes(search, world), `[Expected 3] The rows of product code ${pc002} are listed`).toEqual(codesOf(world, keysWhere(world, (sku) => sku.groupCode === pc002)));
      expect(load.url.searchParams.get('keyword'), '[Expected 3] The keyword sent is trimmed').toBe(pc002);
    });

    await step('Act: Step 4 — Read the keyword box again after the search has run', async () => {
      afterValue = await list.keywordInput.inputValue();
      test.info().annotations.push({ type: 'Keyword box after search', description: JSON.stringify(afterValue) });
    });

    await step('Assert: Expected 4 — NEEDS CLARIFICATION — the box keeps the keyword (typed or trimmed form)', async () => {
      expect(afterValue.trim(), '[Expected 4] The keyword box still holds the keyword after the search').toBe(pc002);
    });
  });

  test('TC_US134_34 — Changing the search choice does not wipe what is typed in the keyword box', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US134_34', 'Low', TAGS, `With SKU0003's SKU code typed, switching 검색조건 from 상품코드명 to SKU코드 keeps the keyword. ${MAPPING_NOTE}`);
    const code = world.sku('SKU0003').skuCode;

    await step('Arrange: Pre-condition 1–2 — Logged in with write access, demo rows present', async () => {
      await list.open();
    });

    await step('Act: Step 1 — Type SKU0003\'s SKU code into the keyword box', async () => {
      await list.typeKeyword(code);
    });

    await step('Assert: Expected 1 — The box holds the SKU code', async () => {
      await expect(list.keywordInput, `[Expected 1] The box holds ${code}`).toHaveValue(code);
    });

    await step('Act: Step 2 — Change 검색조건 (Search condition) from 상품코드명 to SKU코드 (SKU code)', async () => {
      await expect(list.searchFieldSelect, 'The search condition starts on 상품코드명').toHaveValue('SKU_GROUP_NAME');
      await list.chooseSearchField('SKU_CODE');
    });

    await step('Assert: Expected 2 — The choice list shows SKU코드', async () => {
      await expect(list.searchFieldSelect, '[Expected 2] The choice list shows SKU코드').toHaveValue('SKU_CODE');
      expect(await new StockListSearchPage(page, list).selectedText(list.searchFieldSelect), `[Expected 2] The choice reads ${stx('searchField.SKU_CODE')}`).toBe(stx('searchField.SKU_CODE'));
    });

    await step('Act: Step 3 — Read the keyword box', async () => {
      await expect(list.keywordInput, 'The keyword box is shown').toBeVisible();
    });

    await step('Assert: Expected 3 — The keyword box still holds the SKU code', async () => {
      await expect(list.keywordInput, `[Expected 3] The box still holds ${code}`).toHaveValue(code);
    });
  });

  test('TC_US134_35 — Search applies the chosen values, goes back to page 1 and clears every ticked row', async ({ page, world, stockListPage: list, adjustmentDialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_35',
      'High',
      TAGS,
      `On page 2 of the 12 demo rows, typing the PC001 product code (mapping DEMO-PC-001) changes nothing until 검색, which lists only the PC001 rows on page 1; ticking SKU0001 then 검색 again clears the tick, and 재고 조정 shows "선택된 재고가 없습니다. 재고를 선택해주세요." with no dialog. World: group PC001 holds SKU0001 / SKU0002 (TC: 0001, 0002, 0007, 0009). ${MAPPING_NOTE} ${WORLD_NOTE}`,
    );
    const search = new StockListSearchPage(page, list);
    const pc001 = world.sku('SKU0001').groupCode;
    let page2Rows: string[] = [];
    let load!: ListLoad;
    let requestsBefore = 0;

    await step('Arrange: Pre-condition 1–2 — The 12 demo rows with 페이지당 10, so there are 2 pages', async () => {
      await openDemoList(list, search, world);
      await expect(list.pagerText, 'The demo list holds 12 rows on 2 pages').toHaveText(search.pagerPattern(12, 1, 10));
    });

    await step('Act: Step 1 — Go to page 2', async () => {
      await list.goToPage('2');
      page2Rows = await search.visibleSkuCodes();
    });

    await step('Assert: Expected 1 — Page 2 is shown', async () => {
      await expect(list.activePage, '[Expected 1] Page 2 is the active page').toContainText('2');
      await expect(list.pagerText, '[Expected 1] The count line shows rows 11-12').toHaveText(search.pagerPattern(12, 11, 12));
    });

    await step('Act: Step 2 — Type the PC001 product code into the keyword box but do not click Search yet', async () => {
      requestsBefore = search.listRequests.length;
      await list.typeKeyword(pc001);
    });

    await step('Assert: Expected 2 — The table still shows the page 2 rows', async () => {
      expect(await search.visibleSkuCodes(), '[Expected 2] The page 2 rows are still shown').toEqual(page2Rows);
      expect(search.listRequests.length - requestsBefore, '[Expected 2] The keyword just typed has not been applied').toBe(0);
    });

    await step('Act: Step 3 — Click 검색 (Search) and read the page number', async () => {
      load = await search.clickSearch();
    });

    await step('Assert: Expected 3 — Only the PC001 rows are listed and the pages go back to page 1', async () => {
      expect(load.url.searchParams.get('keyword'), `[Expected 3] The list runs with keyword ${pc001}`).toBe(pc001);
      expect(load.url.searchParams.get('page'), '[Expected 3] The list request asks for the first page').toBe('0');
      expect(await shownCodes(search, world), `[Expected 3] Only the rows of product code ${pc001} are listed`).toEqual(codesOf(world, keysWhere(world, (sku) => sku.groupCode === pc001)));
      await expect(list.activePage, '[Expected 3] Page 1 is the active page').toContainText('1');
    });

    await step('Act: Step 4 — Tick the physical row SKU0001, then click 검색 (Search) again', async () => {
      await list.tick(list.row(world.sku('SKU0001').skuCode), world.sku('SKU0001').skuCode);
      await expect(list.checkbox(list.row(world.sku('SKU0001').skuCode)), 'SKU0001 is ticked before searching again').toBeChecked();
      load = await search.clickSearch();
    });

    await step('Assert: Expected 4 — The list runs again and no tick box is ticked', async () => {
      expect(load.status, '[Expected 4] The list runs again').toBe(200);
      await expect(search.tickedBoxes, '[Expected 4] No tick box is ticked').toHaveCount(0);
    });

    await step('Act: Step 5 — Click 재고 조정 (Stock adjustment)', async () => {
      await list.clickToolbar('btn.adjustStock');
    });

    await step('Assert: Expected 5 — The blocking message is shown and no dialog opens', async () => {
      await expect(list.guardAlert, '[Expected 5] "선택된 재고가 없습니다. 재고를 선택해주세요." is shown').toHaveText(noSelectionPattern);
      await expect(adjustmentDialog.root, '[Expected 5] The 재고 조정 dialog does not open').toHaveCount(0);
    });
  });

  test('TC_US134_36 — The SKU type filter offers 전체 / 현물 / 디지털 / Set and Set sends MIXED', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_36',
      'Medium',
      TAGS,
      `SKU유형 starts on 전체, offers 전체 / 현물 / 디지털 / Set with 전체 a real selectable choice, sends skuType=MIXED for Set and lists only the 2 set rows SKU0007 and SKU0012 of the 12 demo rows (8 physical, 2 digital, 2 set). ${MAPPING_NOTE} ${WORLD_NOTE}`,
    );
    const search = new StockListSearchPage(page, list);
    let initial = '';
    let options: string[] = [];
    let load!: ListLoad;

    await step('Arrange: Pre-condition 1–3 — The 12 demo rows (8 physical, 2 digital, 2 set) are listed', async () => {
      expect(keysWhere(world, (sku) => sku.type === 'PHYSICAL').length, 'The world holds 8 physical SKUs').toBe(8);
      expect(keysWhere(world, (sku) => sku.type === 'DIGITAL').length, 'The world holds 2 digital SKUs').toBe(2);
      expect(keysWhere(world, (sku) => sku.type === 'MIXED').length, 'The world holds 2 set SKUs').toBe(2);
      await openDemoList(list, search, world);
    });

    await step('Act: Step 1 — Read the starting value of SKU유형 (SKU type)', async () => {
      initial = await search.selectedText(list.skuTypeSelect);
    });

    await step('Assert: Expected 1 — SKU유형 shows 전체', async () => {
      expect(initial, `[Expected 1] SKU유형 starts on ${stx('filter.all')}`).toBe(stx('filter.all'));
    });

    await step('Act: Step 2 — Open the list and read every choice', async () => {
      options = await search.optionTexts(list.skuTypeSelect);
      await search.selectByLabel(list.skuTypeSelect, stx('filter.all'), 'SKU유형');
    });

    await step('Assert: Expected 2 — 전체, 현물, 디지털, Set — and 전체 is a real choice', async () => {
      const expected = [stx('filter.all'), stx('skuType.PHYSICAL'), stx('skuType.DIGITAL'), stx('skuType.MIXED')];
      expected.forEach((name, index) => expect(options[index], `[Expected 2] Choice ${index + 1} is ${name}`).toBe(name));
      expect(options.length, '[Expected 2] SKU유형 has exactly these 4 choices').toBe(4);
      await expect(list.skuTypeSelect.locator('option').first(), `[Expected 2] ${stx('filter.all')} is an enabled choice`).toBeEnabled();
      expect(await search.selectedText(list.skuTypeSelect), `[Expected 2] ${stx('filter.all')} can be chosen`).toBe(stx('filter.all'));
    });

    await step('Act: Step 3 — Choose Set, click 검색 (Search) and read the data sent to the server', async () => {
      await search.selectByLabel(list.skuTypeSelect, stx('skuType.MIXED'), 'SKU유형');
      load = await search.clickSearch();
    });

    await step('Assert: Expected 3 — The data sent carries MIXED, not the word Set', async () => {
      expect(load.url.searchParams.get('skuType'), '[Expected 3] skuType=MIXED is sent').toBe('MIXED');
      expect(load.url.searchParams.getAll('skuType'), '[Expected 3] The word Set is not sent').not.toContain('Set');
    });

    await step('Act: Step 4 — Read the table', async () => {
      await list.waitForList();
    });

    await step('Assert: Expected 4 — Only the 2 set rows SKU0007 and SKU0012 are listed', async () => {
      expect(await shownCodes(search, world), '[Expected 4] Only SKU0007 and SKU0012 are listed').toEqual(codesOf(world, ['SKU0007', 'SKU0012']));
    });
  });

  test('TC_US134_37 — The warehouse group filter has All plus the 5 catalogue groups, left in Korean', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_37',
      'Medium',
      TAGS,
      `대구분 starts on 전체 and offers 6 choices: 전체 + CJ 창고, CJ 대구 창고, 현장 수령지, 매장 창고, 일반 창고 (the same Korean names on the English screen); CJ 창고 lists only the demo rows in CJ Incheon Aam (WMS · CJ_LOGISTICS), 현장 수령지 only those in Demo Pickup Point. Rows are scoped to the 12 demo rows. ${MAPPING_NOTE} ${WORLD_NOTE}`,
    );
    const search = new StockListSearchPage(page, list);
    const groups = ['CJ 창고', 'CJ 대구 창고', '현장 수령지', '매장 창고', '일반 창고'];
    const cj = world.warehouses.CJ;
    const pickup = world.warehouses.PICKUP;
    let initial = '';
    let options: string[] = [];
    let optionsEn: string[] = [];

    await step('Arrange: Pre-condition 1–2 — The catalogue holds CJ Incheon Aam (CJ_WAREHOUSE) and Demo Pickup Point; the 12 demo rows are listed', async () => {
      expect(cj.category, 'CJ Incheon Aam is in group CJ_WAREHOUSE').toBe('CJ_WAREHOUSE');
      await openDemoList(list, search, world);
    });

    await step('Act: Step 1 — Read the starting value of 대구분 (Warehouse group)', async () => {
      initial = await search.selectedText(list.warehouseGroupSelect);
    });

    await step('Assert: Expected 1 — 대구분 shows 전체', async () => {
      expect(initial, `[Expected 1] 대구분 starts on ${stx('filter.all')}`).toBe(stx('filter.all'));
    });

    await step('Act: Step 2 — Open the list and count the choices', async () => {
      options = await search.optionTexts(list.warehouseGroupSelect);
    });

    await step('Assert: Expected 2 — 6 choices: All plus 5 warehouse groups', async () => {
      expect(options.length, '[Expected 2] 대구분 has exactly 6 choices').toBe(6);
      expect(options[0], `[Expected 2] The first choice is ${stx('filter.all')}`).toBe(stx('filter.all'));
    });

    await step('Act: Step 3 — Read each group in turn (also on the English screen)', async () => {
      const enTab = await page.context().newPage();
      try {
        const enList = new StockListPage(enTab);
        await enList.open('en');
        optionsEn = await new StockListSearchPage(enTab, enList).optionTexts(enList.warehouseGroupSelect);
      } finally {
        await enTab.close();
      }
    });

    await step('Assert: Expected 3 — CJ 창고, CJ 대구 창고, 현장 수령지, 매장 창고, 일반 창고 — Korean and not translated', async () => {
      groups.forEach((name, index) => {
        expect(options[index + 1], `[Expected 3] Group ${index + 1} is ${name}`).toBe(name);
        expect(optionsEn[index + 1], `[Expected 3] Group ${name} stays in Korean on the English screen`).toBe(name);
      });
    });

    await step('Act: Step 4 — Choose CJ 창고 and click 검색 (Search)', async () => {
      await search.selectByLabel(list.warehouseGroupSelect, 'CJ 창고', '대구분');
      await search.clickSearch();
    });

    await step('Assert: Expected 4 — Only the rows in CJ Incheon Aam are listed', async () => {
      expect(await shownCodes(search, world), `[Expected 4] Only the demo rows in ${cj.name} are listed`).toEqual(codesOf(world, keysWhere(world, (_sku, warehouseId) => warehouseId === cj.id)));
      for (const name of await list.columnValues('col.warehouse')) expect(name, `[Expected 4] Listed row is in ${cj.name} (WMS · CJ_LOGISTICS)`).toBe(cj.name);
    });

    await step('Act: Step 5 — Switch to 현장 수령지 and click 검색 (Search)', async () => {
      await search.selectByLabel(list.warehouseGroupSelect, '현장 수령지', '대구분');
      await search.clickSearch();
    });

    await step('Assert: Expected 5 — Only the rows in Demo Pickup Point are listed', async () => {
      expect(await shownCodes(search, world), `[Expected 5] Only the demo rows in ${pickup.name} are listed`).toEqual(codesOf(world, keysWhere(world, (_sku, warehouseId) => warehouseId === pickup.id)));
      for (const name of await list.columnValues('col.warehouse')) expect(name, `[Expected 5] Listed row is in ${pickup.name}`).toBe(pickup.name);
    });
  });

  test('TC_US134_38 — Warehouse group and warehouse filters work together and either may be left empty', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_38',
      'Medium',
      TAGS,
      `With 대구분 = CJ 창고 the 창고 control stays usable; group alone lists every demo row of the CJ 창고 group, group + CJ Incheon Aam and CJ Incheon Aam alone list only that warehouse, both cleared lists all 12 demo rows. The 창고 choices are narrowed to the chosen group. ${MAPPING_NOTE} ${WORLD_NOTE}`,
    );
    const search = new StockListSearchPage(page, list);
    const cj = world.warehouses.CJ;
    const cjRows = codesOf(world, keysWhere(world, (_sku, warehouseId) => warehouseId === cj.id));
    let warehouseChoices: string[] = [];

    await step('Arrange: Pre-condition 1–3 — CJ Incheon Aam, CJ Daegu warehouse and Demo Pickup Point hold demo rows; the 12 demo rows are listed', async () => {
      expect(world.stockRows.some((row) => row.warehouse.id === world.warehouses.PICKUP.id), 'Demo Pickup Point holds a demo row').toBe(true);
      await openDemoList(list, search, world);
    });

    await step('Act: Step 1 — Choose 대구분 (Warehouse group) CJ 창고 and look at the 창고 (Warehouse) control', async () => {
      await search.selectByLabel(list.warehouseGroupSelect, 'CJ 창고', '대구분');
      warehouseChoices = await list.multiOptions('warehouse');
    });

    await step('Assert: Expected 1 — The 창고 control can still be clicked and still lets you choose', async () => {
      await expect(list.warehouseInput, '[Expected 1] The 창고 control is enabled').toBeEnabled();
      expect(warehouseChoices, `[Expected 1] The 창고 control offers ${cj.name}`).toContain(cj.name);
    });

    await step('Act: Step 2 — Leave 창고 (Warehouse) empty and click 검색 (Search)', async () => {
      await search.clickSearch();
    });

    await step('Assert: Expected 2 — Every row in the warehouses of the CJ 창고 group is listed', async () => {
      const groupRows = codesOf(world, keysWhere(world, (_sku, warehouseId) => world.stockRows.some((row) => row.warehouse.id === warehouseId && row.warehouse.category === 'CJ_WAREHOUSE')));
      expect(await shownCodes(search, world), '[Expected 2] Every demo row of the CJ 창고 group is listed').toEqual(groupRows);
    });

    await step('Act: Step 3 — Also choose 창고 (Warehouse) CJ Incheon Aam and click 검색 (Search)', async () => {
      await list.pickMulti('warehouse', cj.name);
      await search.clickSearch();
    });

    await step('Assert: Expected 3 — Only the rows in CJ Incheon Aam are listed', async () => {
      expect(await shownCodes(search, world), `[Expected 3] Only the demo rows in ${cj.name} are listed`).toEqual(cjRows);
    });

    await step('Act: Step 4 — Clear 대구분 (Warehouse group), keep 창고 on CJ Incheon Aam and click 검색 (Search)', async () => {
      await search.selectByLabel(list.warehouseGroupSelect, stx('filter.all'), '대구분');
      await expect(list.warehouseMulti, `${cj.name} is still chosen`).toContainText(cj.name);
      await search.clickSearch();
    });

    await step('Assert: Expected 4 — Still only the rows in CJ Incheon Aam are listed', async () => {
      expect(await shownCodes(search, world), `[Expected 4] Still only the demo rows in ${cj.name} are listed`).toEqual(cjRows);
    });

    await step('Act: Step 5 — Clear both controls and click 검색 (Search)', async () => {
      await search.unpickMulti('warehouse', cj.name);
      await search.clickSearch();
    });

    await step('Assert: Expected 5 — All 12 rows come back', async () => {
      await expect(list.pagerText, '[Expected 5] All 12 demo rows come back').toHaveText(search.pagerPattern(12, 1, 10));
    });
  });

  test('TC_US134_39 — The warehouse filter reads the catalogue, shows only PLATFORM warehouses and takes several values', async ({ page, world, stockApi, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_39',
      'Medium',
      TAGS,
      `The 창고 choices are the PLATFORM catalogue warehouses in name order (CJ Daegu warehouse, CJ Incheon Aam, Demo Pickup Point among them — dev holds many more PLATFORM warehouses, so the list is compared with the catalogue API); a SUPPLIER warehouse the test creates is not offered; CJ Daegu alone lists its rows, CJ Daegu + CJ Incheon Aam list the rows of both. World: CJ Daegu holds SKU0003 / SKU0008 (TC also SKU0012). ${MAPPING_NOTE} ${WORLD_NOTE}`,
    );
    test.skip(!world.warehouses.DAEGU, world.daeguUnavailableReason ?? 'No CJ Daegu warehouse in the world');
    const search = new StockListSearchPage(page, list);
    const daegu = world.warehouses.DAEGU!;
    const cj = world.warehouses.CJ;
    let supplierName = '';
    let catalogue: string[] = [];
    let choices: string[] = [];

    await step('Arrange: Pre-condition 1–3 — PLATFORM warehouses CJ Daegu / CJ Incheon Aam / Demo Pickup Point plus an own SUPPLIER warehouse; the 12 demo rows are listed', async () => {
      supplierName = (await world.createWarehouse('TC039 Supplier', 'SUPPLIER')).name;
      catalogue = (await stockApi.selectableWarehouses()).map((warehouse) => warehouse.name);
      await openDemoList(list, search, world);
    });

    await step('Act: Step 1 — Open the 창고 (Warehouse) list', async () => {
      choices = await list.multiOptions('warehouse');
    });

    await step('Assert: Expected 1 — The list opens', async () => {
      expect(choices.length, '[Expected 1] The 창고 list opens with choices').toBeGreaterThan(0);
    });

    await step('Act: Step 2 — Read each choice in turn', async () => {
      expect(choices.length, 'The choices are read').toBeGreaterThan(0);
    });

    await step('Assert: Expected 2 — The choices are the PLATFORM warehouses in name order', async () => {
      expect(choices, '[Expected 2] The choices are the PLATFORM catalogue warehouses, in the catalogue name order').toEqual(catalogue);
      const demoOrder = [daegu.name, cj.name, world.warehouses.PICKUP.name];
      demoOrder.forEach((name) => expect(choices, `[Expected 2] ${name} is offered`).toContain(name));
      expect(demoOrder.map((name) => choices.indexOf(name)), '[Expected 2] CJ Daegu warehouse, CJ Incheon Aam, Demo Pickup Point come in name order').toEqual([...demoOrder.map((name) => choices.indexOf(name))].sort((a, b) => a - b));
    });

    await step('Act: Step 3 — Look for the SUPPLIER warehouse in the list', async () => {
      choices = await list.multiOptions('warehouse');
    });

    await step('Assert: Expected 3 — The SUPPLIER warehouse is not in the list', async () => {
      expect(choices, `[Expected 3] SUPPLIER warehouse ${supplierName} is not offered`).not.toContain(supplierName);
    });

    await step('Act: Step 4 — Choose CJ Daegu warehouse, click 검색 (Search) and read the table', async () => {
      await list.pickMulti('warehouse', daegu.name);
      await search.clickSearch();
    });

    await step('Assert: Expected 4 — Only the rows in CJ Daegu warehouse are listed', async () => {
      expect(await shownCodes(search, world), `[Expected 4] Only the demo rows in ${daegu.name} are listed`).toEqual(codesOf(world, keysWhere(world, (_sku, warehouseId) => warehouseId === daegu.id)));
    });

    let load!: ListLoad;
    await step('Act: Step 5 — Also choose CJ Incheon Aam so the filter holds 2 values, click 검색 (Search) and read the table', async () => {
      await list.pickMulti('warehouse', cj.name);
      load = await search.clickSearch();
    });

    await step('Assert: Expected 5 — The rows of BOTH warehouses are listed', async () => {
      expect((load.url.searchParams.get('warehouseIds') ?? '').split(',').sort(), '[Expected 5] Both warehouse ids are sent').toEqual([String(daegu.id), String(cj.id)].sort());
      expect(await shownCodes(search, world), '[Expected 5] The demo rows of both warehouses are listed').toEqual(codesOf(world, keysWhere(world, (_sku, warehouseId) => warehouseId === daegu.id || warehouseId === cj.id)));
    });
  });

  test('TC_US134_40 — Leaving the warehouse filter empty means all warehouses', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_40',
      'Medium',
      TAGS,
      `With no warehouse chosen all 12 demo rows are listed (총 12개 … 1-10); choosing the 3 demo warehouses lists only rows that have one of them (SKU0005 / SKU0006 / SKU0010 without a warehouse are not listed); unpicking them all brings the 12 rows back. World: 7 demo rows have a warehouse (the 2 set SKUs have no stock either), the TC expects 9. The host pager wording (재고 vs 항목) is checked softly. ${MAPPING_NOTE} ${WORLD_NOTE}`,
    );
    test.skip(!world.warehouses.DAEGU, world.daeguUnavailableReason ?? 'No CJ Daegu warehouse in the world');
    const search = new StockListSearchPage(page, list);
    const warehouses = [world.warehouses.CJ, world.warehouses.DAEGU!, world.warehouses.PICKUP];

    await step('Arrange: Pre-condition 1–2 — Demo rows spread over 3 warehouses', async () => {
      await list.open();
      await list.typeKeyword(demoKeyword(world));
    });

    await step('Act: Step 1 — With no warehouse chosen, click 검색 (Search)', async () => {
      await search.clickSearch();
    });

    await step('Assert: Expected 1 — All 12 rows are listed', async () => {
      await expect(search.placeholder('warehouse'), '[Expected 1] No warehouse is chosen').toBeVisible();
      await expect(list.pagerText, '[Expected 1] All 12 demo rows are listed').toHaveText(search.pagerPattern(12, 1, 10));
    });

    await step('Act: Step 2 — Read the count line', async () => {
      await expect(list.pagerText, 'The count line is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — The count line shows 총 12개의 항목 중 1-10개 표시', async () => {
      await expect(list.pagerText, '[Expected 2] The count line shows 12 items, 1-10').toHaveText(search.pagerPattern(12, 1, 10));
      expect.soft(await list.pagerText.innerText(), '[Expected 2] The count line uses the TC wording').toBe(search.tcPagerText(12, 1, 10));
    });

    await step('Act: Step 3 — Choose all 3 warehouses and click 검색 (Search)', async () => {
      for (const warehouse of warehouses) await list.pickMulti('warehouse', warehouse.name);
      await search.clickSearch();
    });

    await step('Assert: Expected 3 — Only the rows with one of the 3 warehouses are listed; SKU0005 / SKU0006 / SKU0010 are not', async () => {
      const ids = warehouses.map((warehouse) => warehouse.id);
      const shown = await shownCodes(search, world);
      expect(shown, '[Expected 3] The demo rows of the 3 warehouses are listed').toEqual(codesOf(world, keysWhere(world, (_sku, warehouseId) => warehouseId !== null && ids.includes(warehouseId))));
      for (const key of ['SKU0005', 'SKU0006', 'SKU0010'] as const) expect(shown, `[Expected 3] ${key} (no warehouse) is not listed`).not.toContain(world.sku(key).skuCode);
    });

    await step('Act: Step 4 — Unpick them all so the filter is empty again and click 검색 (Search)', async () => {
      for (const warehouse of warehouses) await search.unpickMulti('warehouse', warehouse.name);
      await search.clickSearch();
    });

    await step('Assert: Expected 4 — All 12 rows are listed and the count line is back to 총 12개 … 1-10', async () => {
      await expect(search.placeholder('warehouse'), '[Expected 4] The warehouse filter is empty again').toBeVisible();
      await expect(list.pagerText, '[Expected 4] All 12 demo rows are listed again').toHaveText(search.pagerPattern(12, 1, 10));
      expect.soft(await list.pagerText.innerText(), '[Expected 4] The count line uses the TC wording').toBe(search.tcPagerText(12, 1, 10));
    });
  });

  test('TC_US134_41 — The warehouse filter shows a no-warehouses line when the warehouse catalogue is empty', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_41',
      'Medium',
      TAGS,
      `With an empty warehouse catalogue the 창고 control is replaced by the line "${stx('filter.noWarehouses')}" with no 전체 entry, and rows show a dash in 창고. The shared dev catalogue cannot be emptied, so the catalogue call GET /warehouses/all is answered with an empty list in the browser, and the rows are the test's own 2 physical SKU lines that have no stock (no warehouse) — the state of a system before its warehouse set-up. The KO/EN wording of the line is NEEDS CLARIFICATION in the TC; the screen's own text is asserted. ${WORLD_NOTE}`,
    );
    const search = new StockListSearchPage(page, list);
    let skus: WorldSku[] = [];

    await step('Arrange: Pre-condition 1–3 — The warehouse catalogue answers empty; own SKU lines without any warehouse', async () => {
      skus = await world.createPhysicalSku('TC041', { partner: world.partners.A, manufacturer: world.manufacturers.M1, lines: [{ option: 'A' }, { option: 'B' }] });
      await page.route('**/api/v1/warehouses/all**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }));
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management) and open the 창고 (Warehouse) list', async () => {
      await list.open();
      await search.searchBy('SKU_GROUP_CODE', skus[0].groupCode);
      await search.warehouseColumn.click();
    });

    await step('Assert: Expected 1 — The list opens', async () => {
      await expect(search.warehouseColumn, '[Expected 1] The 창고 control is shown').toBeVisible();
    });

    await step('Act: Step 2 — Read every choice', async () => {
      await expect(search.warehouseColumn, 'The 창고 control is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — An explicit no-warehouses line instead of an empty list, and no 전체 entry', async () => {
      await expect(search.noWarehousesLine, `[Expected 2] The line "${stx('filter.noWarehouses')}" is shown`).toHaveText(stx('filter.noWarehouses'));
      await expect(search.warehouseColumn.getByText(stx('filter.all'), { exact: true }), '[Expected 2] There is no 전체 entry').toHaveCount(0);
      await expect(search.warehouseColumn.getByRole('combobox'), '[Expected 2] No empty choice list is offered').toHaveCount(0);
    });

    let warehouseCells: string[] = [];
    await step('Act: Step 3 — Read the 창고 (Warehouse) column of the rows', async () => {
      warehouseCells = await list.columnValues('col.warehouse');
    });

    await step('Assert: Expected 3 — Every row shows a dash in the 창고 column', async () => {
      expect(warehouseCells.length, '[Expected 3] The rows are listed').toBe(skus.length);
      warehouseCells.forEach((cell, index) => expect(cell, `[Expected 3] Row ${index + 1} shows a dash in 창고`).toBe('-'));
    });
  });

  test('TC_US134_42 — The biz partner filter lists the partners and takes several values', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_42',
      'Medium',
      TAGS,
      `비즈파트너 offers Demo Partner A and Demo Partner B in name order; B alone lists its 5 demo rows, A + B list all 12. World: Demo Partner B owns SKU0005 / SKU0006 / SKU0010 / SKU0011 / SKU0012 (TC: 0004, 0005, 0008, 0010, 0012). Not automated: "only the partners the account may see / Demo Partner C is not offered" — the automation account is a bypass account that sees every dev partner, so the list holds all of them and the exact-two check cannot be made. ${MAPPING_NOTE} ${WORLD_NOTE}`,
    );
    const search = new StockListSearchPage(page, list);
    const a = partnerName(world.partners.A);
    const b = partnerName(world.partners.B);
    let choices: string[] = [];

    await step('Arrange: Pre-condition 1–2 — Demo rows: 7 for Demo Partner A, 5 for Demo Partner B; the 12 demo rows are listed', async () => {
      expect(keysWhere(world, (sku) => sku.partner.id === world.partners.A.id).length, 'Demo Partner A owns 7 demo rows').toBe(7);
      expect(keysWhere(world, (sku) => sku.partner.id === world.partners.B.id).length, 'Demo Partner B owns 5 demo rows').toBe(5);
      await openDemoList(list, search, world);
    });

    await step('Act: Step 1 — Open the 비즈파트너 (Biz partner) list', async () => {
      choices = await list.multiOptions('bizPartner');
    });

    await step('Assert: Expected 1 — The list opens', async () => {
      expect(choices.length, '[Expected 1] The 비즈파트너 list opens with choices').toBeGreaterThan(0);
    });

    await step('Act: Step 2 — Read each choice in turn', async () => {
      expect(choices.length, 'The choices are read').toBeGreaterThan(0);
    });

    await step('Assert: Expected 2 — Demo Partner A and Demo Partner B in name order', async () => {
      expect(choices, `[Expected 2] ${a} is offered`).toContain(a);
      expect(choices, `[Expected 2] ${b} is offered`).toContain(b);
      expect(choices, '[Expected 2] The partners are in name order').toEqual([...choices].sort((x, y) => x.localeCompare(y, 'ko')));
    });

    await step('Act: Step 3 — Choose Demo Partner B, click 검색 (Search) and read the table', async () => {
      await list.pickMulti('bizPartner', b);
      await search.clickSearch();
    });

    await step('Assert: Expected 3 — Only the 5 rows for Demo Partner B are listed', async () => {
      expect(await shownCodes(search, world), `[Expected 3] Only the 5 demo rows of ${b} are listed`).toEqual(codesOf(world, keysWhere(world, (sku) => sku.partner.id === world.partners.B.id)));
    });

    let load!: ListLoad;
    await step('Act: Step 4 — Also choose Demo Partner A so the filter holds 2 values, click 검색 (Search) and read the table', async () => {
      await list.pickMulti('bizPartner', a);
      load = await search.clickSearch();
    });

    await step('Assert: Expected 4 — All 12 rows are listed', async () => {
      expect((load.url.searchParams.get('bizPartnerIds') ?? '').split(',').sort(), '[Expected 4] Both partner ids are sent').toEqual([String(world.partners.A.id), String(world.partners.B.id)].sort());
      await expect(list.pagerText, '[Expected 4] All 12 demo rows are listed').toHaveText(search.pagerPattern(12, 1, 10));
    });
  });

  test('TC_US134_43 — The biz partner filter reuses the shared multi-choice control', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_43',
      'Medium',
      TAGS,
      `Clicking 비즈파트너 should open the host's shared dialog for choosing several biz partners; 창고 and 비즈파트너 take several values, 대구분 one. Deviation: the screen shows an inline multi-select drop-down (react-select menu), not a dialog — Expected 1 is checked softly. Not automated: Expected 2–3 (reading the page's code in browser dev tools and comparing styles with another host screen that picks biz partners — no reference screen is named); the test only records that the control is the shared react-select component. ${WORLD_NOTE}`,
    );
    const a = partnerName(world.partners.A);
    const b = partnerName(world.partners.B);

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; the host has a shared multi biz partner picker', async () => {
      await list.open();
    });

    await step('Act: Step 1 — Click the 비즈파트너 (Biz partner) control', async () => {
      await list.bizPartnerInput.click();
    });

    await step('Assert: Expected 1 — A dialog for choosing several biz partners opens', async () => {
      await expect(page.locator('[id^="react-select-"][id*="-option-"]').first(), '[Expected 1] A choice list of biz partners opens').toBeVisible();
      await expect.soft(page.getByRole('dialog'), '[Expected 1] The choices open in a dialog').toBeVisible();
      await page.keyboard.press('Escape');
    });

    await step('Act: Step 2 — Look at what opened in the page code', async () => {
      await expect(list.bizPartnerMulti, 'The 비즈파트너 control is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — It is the host system\'s shared control, not a dialog written just for this screen', async () => {
      await expect(list.bizPartnerInput, '[Expected 2] The control is the shared react-select combobox').toHaveAttribute('id', /^react-select-\d+-input$/);
      test.info().annotations.push({ type: 'Not automated', description: 'Expected 2 — confirming in dev tools that it is the host shared component (beyond the react-select markup).' });
    });

    await step('Act: Step 3 — Open another host screen that also picks several biz partners and compare the two', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Step 3 — no reference host screen is named by the TC.' });
    });

    await step('Assert: Expected 3 — The two are the same control, with the same styles and the same way of working', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Expected 3 — style and behaviour comparison with another host screen.' });
    });

    await step('Act: Step 4 — Open the 대구분 (Warehouse group) and 창고 (Warehouse) controls and check how many values each one takes', async () => {
      await list.pickMulti('warehouse', world.warehouses.CJ.name);
      await list.pickMulti('warehouse', world.warehouses.PICKUP.name);
      await list.pickMulti('bizPartner', a);
      await list.pickMulti('bizPartner', b);
    });

    await step('Assert: Expected 4 — 창고 and 비즈파트너 take several values; 대구분 takes one value only', async () => {
      await expect(list.warehouseMulti, `[Expected 4] 창고 holds ${world.warehouses.CJ.name}`).toContainText(world.warehouses.CJ.name);
      await expect(list.warehouseMulti, `[Expected 4] 창고 also holds ${world.warehouses.PICKUP.name}`).toContainText(world.warehouses.PICKUP.name);
      await expect(list.bizPartnerMulti, `[Expected 4] 비즈파트너 holds ${a}`).toContainText(a);
      await expect(list.bizPartnerMulti, `[Expected 4] 비즈파트너 also holds ${b}`).toContainText(b);
      expect(await list.warehouseGroupSelect.evaluate((element: HTMLSelectElement) => element.multiple), '[Expected 4] 대구분 takes one value only').toBe(false);
    });
  });

  test('TC_US134_44 — Reset puts all 5 controls back, goes to page 1 and reloads the list with no extra click', async ({ page, world, stockApi, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_44',
      'Medium',
      TAGS,
      `SKU코드 = SKU0003's code + 대구분 CJ 대구 창고 + SKU유형 현물 + 창고 CJ Daegu warehouse + 비즈파트너 Demo Partner A lists only SKU0003; 초기화 reloads at once with exactly 1 request, puts 검색조건 on 상품코드명 with an empty keyword, 대구분 and SKU유형 on 전체, 창고 and 비즈파트너 empty. "All 12 rows are back" is mapped to the whole unfiltered list of the shared dev environment (count = GET /stock-status total, page 1). The host pager wording (재고 vs 항목) is checked softly. ${MAPPING_NOTE} ${WORLD_NOTE}`,
    );
    test.skip(!world.warehouses.DAEGU, world.daeguUnavailableReason ?? 'No CJ Daegu warehouse in the world');
    const search = new StockListSearchPage(page, list);
    const daegu = world.warehouses.DAEGU!;
    const sku3 = world.sku('SKU0003');
    let load!: ListLoad;
    let requestsBefore = 0;

    await step('Arrange: Pre-condition 1–3 — Demo rows present, 페이지당 10', async () => {
      await list.open();
    });

    await step('Act: Step 1 — Set SKU코드 = SKU0003\'s code, 대구분 CJ 대구 창고, SKU유형 현물, 창고 CJ Daegu warehouse, 비즈파트너 Demo Partner A, then click 검색 (Search)', async () => {
      await list.chooseSearchField('SKU_CODE');
      await list.typeKeyword(sku3.skuCode);
      await search.selectByLabel(list.warehouseGroupSelect, 'CJ 대구 창고', '대구분');
      await list.chooseSkuType('PHYSICAL');
      await list.pickMulti('warehouse', daegu.name);
      await list.pickMulti('bizPartner', partnerName(world.partners.A));
      await search.clickSearch();
    });

    await step('Assert: Expected 1 — Only the SKU0003 row is listed', async () => {
      expect(await shownCodes(search, world), '[Expected 1] Only SKU0003 is listed').toEqual([sku3.skuCode]);
    });

    await step('Act: Step 2 — Click 초기화 (Reset)', async () => {
      requestsBefore = search.listRequests.length;
      load = await search.clickReset();
    });

    await step('Assert: Expected 2 — The list runs again straight away, with no need to click Search', async () => {
      expect(load.status, '[Expected 2] The list runs again on 초기화').toBe(200);
      expect(load.url.searchParams.get('keyword'), '[Expected 2] The list runs with no keyword').toBeNull();
    });

    await step('Act: Step 3 — Read all 5 filter controls again', async () => {
      await expect(list.filterRow, 'The filter block is shown').toBeVisible();
    });

    await step('Assert: Expected 3 — 상품코드명 with an empty keyword, 대구분 전체, SKU유형 전체, 창고 and 비즈파트너 empty', async () => {
      await expect(list.searchFieldSelect, '[Expected 3] 검색조건 is back on 상품코드명').toHaveValue('SKU_GROUP_NAME');
      await expect(list.keywordInput, '[Expected 3] The keyword box is empty').toHaveValue('');
      await expect(list.warehouseGroupSelect, '[Expected 3] 대구분 is back on 전체').toHaveValue('');
      expect(await search.selectedText(list.warehouseGroupSelect), '[Expected 3] 대구분 reads 전체').toBe(stx('filter.all'));
      await expect(list.skuTypeSelect, '[Expected 3] SKU유형 is back on 전체').toHaveValue('');
      expect(await search.selectedText(list.skuTypeSelect), '[Expected 3] SKU유형 reads 전체').toBe(stx('filter.all'));
      await expect(search.placeholder('warehouse'), '[Expected 3] 창고 is empty again (전체)').toHaveText(stx('filter.all'));
      await expect(list.warehouseMulti, `[Expected 3] ${daegu.name} is no longer chosen`).not.toContainText(daegu.name);
      await expect(search.placeholder('bizPartner'), '[Expected 3] 비즈파트너 is empty again (전체)').toHaveText(stx('filter.all'));
    });

    await step('Act: Step 4 — Read the table, the count line and the request list', async () => {
      await list.waitForList();
    });

    await step('Assert: Expected 4 — The whole list is back on page 1 and exactly 1 list request was sent for this Reset', async () => {
      const total = (await stockApi.stockStatus({ size: 10 })).body.paging.totalCount;
      expect(load.totalCount, '[Expected 4] The reset list holds every row').toBe(total);
      await expect(list.pagerText, `[Expected 4] The count line shows ${total} items, 1-10`).toHaveText(search.pagerPattern(total, 1, 10));
      expect.soft(await list.pagerText.innerText(), '[Expected 4] The count line uses the TC wording').toBe(search.tcPagerText(total, 1, 10));
      expect(search.listRequests.length - requestsBefore, '[Expected 4] Exactly 1 list request was sent for this Reset').toBe(1);
    });
  });

  test('TC_US134_45 — Reset does not clear the ticked rows and does not reset the sort control', async ({ page, world, stockListPage: list, adjustmentDialog }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_45',
      'Medium',
      TAGS,
      `With 정렬 = 미확보 출고수량 내림차순 and SKU0001 + SKU0003 ticked, typing the PC001 product code and clicking 초기화 empties the keyword and reloads the whole list, keeps the sort and both ticks, and 재고 조정 opens with 2 lines. Not automated: the order "SKU0003 first at 60, SKU0001 second at 30" — 미확보 출고수량 comes from commerce orders that cannot be created from this admin, so Expected 1 checks the sort request only. "All 12 rows" is mapped to the whole unfiltered list of the shared dev environment. Risk on shared dev: the screen keeps only the ticked rows that are on the reloaded page, so the ticks survive only while both rows stay on page 1 of the sorted, unfiltered list (100 rows per page are set before ticking). ${MAPPING_NOTE} ${WORLD_NOTE}`,
    );
    test.skip(!world.warehouses.DAEGU, world.daeguUnavailableReason ?? 'No CJ Daegu warehouse in the world');
    const search = new StockListSearchPage(page, list);
    const sku1 = world.sku('SKU0001');
    const sku3 = world.sku('SKU0003');
    let load!: ListLoad;

    await step('Arrange: Pre-condition 1–2 — The demo rows are listed, 100 rows per page', async () => {
      await openDemoList(list, search, world);
      await list.choosePageSize(100);
    });

    await step('Act: Step 1 — Set 정렬 (Sort) to 미확보 출고수량 내림차순', async () => {
      load = await search.load(async () => {
        await list.sortSelect.selectOption('UNCONFIRMED_OUTGOING_QUANTITY');
      });
    });

    await step('Assert: Expected 1 — The list reorders by 미확보 출고수량, descending', async () => {
      expect(load.url.searchParams.get('sort'), '[Expected 1] The list is reloaded sorted by 미확보 출고수량, descending').toBe('UNCONFIRMED_OUTGOING_QUANTITY,desc');
      expect(await search.selectedText(list.sortSelect), `[Expected 1] 정렬 reads ${stx('sort.unconfirmed')}`).toBe(stx('sort.unconfirmed'));
    });

    await step('Act: Step 2 — Tick the 2 physical rows SKU0001 and SKU0003', async () => {
      await list.tick(list.row(sku1.skuCode), sku1.skuCode);
      await list.tick(list.row(sku3.skuCode), sku3.skuCode);
    });

    await step('Assert: Expected 2 — Both rows are ticked', async () => {
      await expect(list.checkbox(list.row(sku1.skuCode)), `[Expected 2] ${sku1.skuCode} is ticked`).toBeChecked();
      await expect(list.checkbox(list.row(sku3.skuCode)), `[Expected 2] ${sku3.skuCode} is ticked`).toBeChecked();
    });

    await step('Act: Step 3 — Type the PC001 product code into the keyword box without clicking 검색, then click 초기화 (Reset)', async () => {
      await list.typeKeyword(sku1.groupCode);
      load = await search.clickReset();
    });

    await step('Assert: Expected 3 — Reset empties the keyword box and the list runs again with all rows', async () => {
      await expect(list.keywordInput, '[Expected 3] The keyword box is empty').toHaveValue('');
      expect(load.status, '[Expected 3] The list runs again').toBe(200);
      expect(load.url.searchParams.get('keyword'), '[Expected 3] The list runs with no keyword (all rows)').toBeNull();
    });

    await step('Act: Step 4 — Read the 정렬 (Sort) control and the tick boxes', async () => {
      await list.waitForList();
    });

    await step('Assert: Expected 4 — 정렬 is still 미확보 출고수량 내림차순 and SKU0001 / SKU0003 are still ticked', async () => {
      await expect(list.sortSelect, `[Expected 4] 정렬 is still ${stx('sort.unconfirmed')}`).toHaveValue('UNCONFIRMED_OUTGOING_QUANTITY');
      expect(load.url.searchParams.get('sort'), '[Expected 4] The reset list keeps the sort').toBe('UNCONFIRMED_OUTGOING_QUANTITY,desc');
      await expect(list.checkbox(list.row(sku1.skuCode)), `[Expected 4] ${sku1.skuCode} is still ticked`).toBeChecked();
      await expect(list.checkbox(list.row(sku3.skuCode)), `[Expected 4] ${sku3.skuCode} is still ticked`).toBeChecked();
    });

    await step('Act: Step 5 — Click 재고 조정 (Stock adjustment)', async () => {
      await list.clickToolbar('btn.adjustStock');
    });

    await step('Assert: Expected 5 — The dialog opens with 2 lines, one per ticked row, and no blocking message', async () => {
      await expect(adjustmentDialog.root, '[Expected 5] The 재고 조정 dialog opens').toBeVisible();
      await expect(adjustmentDialog.rows, '[Expected 5] The dialog has 2 lines').toHaveCount(2);
      await expect(adjustmentDialog.rows.filter({ hasText: sku1.skuCode }), `[Expected 5] One line is ${sku1.skuCode}`).toHaveCount(1);
      await expect(adjustmentDialog.rows.filter({ hasText: sku3.skuCode }), `[Expected 5] One line is ${sku3.skuCode}`).toHaveCount(1);
      await expect(list.guardAlert, '[Expected 5] The blocking message does not appear').toHaveCount(0);
    });
  });
});
