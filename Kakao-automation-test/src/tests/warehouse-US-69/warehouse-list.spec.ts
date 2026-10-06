import { test, expect } from '@fixtures/base.fixture';
import { makeStep } from '@utils/step';
import { skipTc, tcMeta } from '@utils/tc-meta';
import { isClipped } from '@utils/layout';
import { BIZ_PARTNER, VIRTUAL_LABEL, WH_TEXT, warehouseName } from '@utils/warehouse.data';

/**
 * Màn 창고 목록 (US069) — layout, tìm kiếm, filter, phân trang, điều hướng. Nguồn TC: input/US069_TestCases_EN_v1.20.md —
 * mỗi dòng Steps N / Expected N map đúng 1 step `Act: Step N` / `Assert: Expected N`. TC lệch UI thật → assert theo UI,
 * ghi "Deviation from TC" trong description (quyết định 28/09).
 *
 * Dữ liệu: môi trường dev DÙNG CHUNG — test cần dữ liệu cụ thể tự tạo warehouse `auto_US069_<TC>_<timestamp>` qua API
 * (kèm 5 bucket hệ thống sinh) và xoá ở teardown (fixture warehouseCleanup). Warehouse của người khác chỉ đọc.
 * Tìm kiếm / filter chỉ áp dụng khi bấm 검색 hoặc Enter — không lọc ngay khi gõ.
 */
const TAGS = ['ui', 'warehouse', 'warehouse-list'];
const COLUMNS = ['ID', '거래처', '창고 유형', '창고명', '물류사 유형', '분류', '상태'];
const DEVIATION_SEARCH_TRIGGER = 'Deviation from TC: the search applies on 검색 / Enter, not while typing.';

test.describe('[List] 창고 목록 layout, search, filters and paging', () => {
  test.describe.configure({ timeout: 120_000 });

  test('TC_US069_002 — Navigation between the list, the create screen and the detail screen', async ({ page, warehouseListPage: list, warehouseFormPage: form }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US069_002',
      'Medium',
      TAGS,
      '창고 등록 opens the create screen and 목록으로 returns to the list; clicking a row opens its Detail/Edit screen and 목록으로 returns ' +
        'to the list. Deviation from TC: 목록으로 on Detail/Edit returns to the plain list URL — the applied filter and page are NOT kept ' +
        '(verified 28/09); the test asserts the return to the list and the reset state, and the gap is reported to the BA.',
    );

    await step('Arrange: Pre-condition 1 — The ADMIN is on 창고 목록 with the 상태 = 활성 filter applied on page 2', async () => {
      await list.open({ status: 'ACTIVE', page: '1', size: '10' });
    });

    await step('Act: Step 1 — Click the 창고 등록 (Add warehouse) button', async () => {
      await list.click(list.addWarehouseButton, '창고 등록 (Add warehouse) button');
    });

    await step('Act: Step 2 — Check that the 창고 등록 (Create Warehouse) screen is open', async () => {
      await expect(form.nameInput).toBeVisible();
    });

    await step('Assert: Expected 2 — The 창고 등록 (Add warehouse) screen opens', async () => {
      await expect(page, '[Expected 2] URL is the create route').toHaveURL(/\/commerce\/warehouses\/create$/);
      await expect(form.cardHeader, '[Expected 2] Card title reads 창고 등록').toHaveText('창고 등록');
    });

    await step('Act: Step 3 — Click 목록으로 (Back to list)', async () => {
      await list.reloadingList(() => form.backToList());
    });

    await step('Assert: Expected 3 — The list 창고 목록 is shown again', async () => {
      await expect(list.panelTitle, '[Expected 3] 창고 목록 panel is visible').toBeVisible();
      await expect(list.tableRows.first(), '[Expected 3] The list shows rows').toBeVisible();
    });

    let openedName = '';
    await step('Act: Step 4 — Click a warehouse on the list', async () => {
      await list.open({ status: 'ACTIVE', page: '1', size: '10' });
      openedName = (await list.readRows())[0]['창고명'];
      await list.tableRows.first().click();
      await form.waitForDetailLoaded();
    });

    await step('Assert: Expected 4 — The Warehouse Detail/Edit screen opens', async () => {
      await expect(page, '[Expected 4] URL is a detail route').toHaveURL(/\/commerce\/warehouses\/-?\d+$/);
      await expect(form.nameInput, '[Expected 4] The detail form shows the clicked warehouse').toHaveValue(openedName);
    });

    await step('Act: Step 5 — Click the 목록으로 (Back to list) button', async () => {
      await list.reloadingList(() => form.backToList());
    });

    await step('Assert: Expected 5 — The list 창고 목록 is shown again (filter / page are reset — see Deviation)', async () => {
      await expect(list.panelTitle, '[Expected 5] 창고 목록 panel is visible').toBeVisible();
      await expect(page, '[Expected 5] Back lands on the plain list URL (filter and page not kept — Deviation)').toHaveURL(/\/commerce\/warehouses$/);
      await expect(list.statusSelect, '[Expected 5] The 상태 filter reads 전체 after returning (Deviation)').toHaveValue('');
      await expect(list.activePageItem, '[Expected 5] Page 1 is active after returning (Deviation)').toHaveText(/^1/);
    });
  });

  test('TC_US069_003 — Refresh and browser Back/Forward keep the current screen', async ({ page, warehouseListPage: list, warehouseFormPage: form }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_003', 'Low', TAGS, 'Refreshing the list or the Detail/Edit screen keeps the current screen, and browser Back/Forward move correctly between the list and the Detail/Edit screen.');

    let listUrl = '';
    let detailUrl = '';
    await step('Arrange: Pre-condition 1 — The ADMIN is on 창고 목록 with 상태 = 활성 applied', async () => {
      await list.open({ status: 'ACTIVE' });
      listUrl = page.url();
    });

    await step('Act: Step 1 — Refresh the 창고 목록 screen', async () => {
      await list.reloadingList(async () => {
        await page.reload();
      });
    });

    await step('Assert: Expected 1 — Refresh does not lose the current screen', async () => {
      await expect(page, '[Expected 1] The same list URL (with its filter) is kept').toHaveURL(listUrl);
      await expect(list.statusSelect, '[Expected 1] The 상태 filter is still 활성').toHaveValue('ACTIVE');
      await expect(list.tableRows.first(), '[Expected 1] The list shows rows').toBeVisible();
    });

    await step('Act: Step 2 — Open a warehouse in the Warehouse Detail/Edit screen', async () => {
      await list.tableRows.first().click();
      await form.waitForDetailLoaded();
      detailUrl = page.url();
    });

    await step('Act: Step 3 — Refresh the Warehouse Detail/Edit screen', async () => {
      await page.reload();
      await form.waitForDetailLoaded();
    });

    await step('Assert: Expected 3 — Refresh does not lose the current screen', async () => {
      await expect(page, '[Expected 3] The same detail URL is kept').toHaveURL(detailUrl);
      await expect(form.panelTitle, '[Expected 3] The Detail/Edit screen is still shown').toBeVisible();
    });

    let backUrl = '';
    let forwardUrl = '';
    await step('Act: Step 4 — Use browser Back and browser Forward', async () => {
      await list.reloadingList(async () => {
        await page.goBack();
      });
      backUrl = page.url();
      await page.goForward();
      await form.waitForDetailLoaded();
      forwardUrl = page.url();
    });

    await step('Assert: Expected 4 — Back/Forward move correctly between the list and Detail/Edit', async () => {
      expect(backUrl, '[Expected 4] Back returns to the list with its filter').toBe(listUrl);
      expect(forwardUrl, '[Expected 4] Forward returns to the same Detail/Edit screen').toBe(detailUrl);
      await expect(form.panelTitle, '[Expected 4] The Detail/Edit screen is shown after Forward').toBeVisible();
    });
  });

  test('TC_US069_004 — 창고 목록 displays the complete default layout', async ({ page, warehouseListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US069_004',
      'Low',
      TAGS,
      'The list shows the 창고 관리 menu, the 창고 등록 button, 창고명 검색, the 거래처 and 유형 filters, 초기화, the table with a 상태 column ' +
        'reading 활성/비활성, and the 페이지당 selector with 10/20/50/100.',
    );

    await step('Arrange: Pre-condition 1 — ADMIN opens the 창고 관리 (Warehouse management) menu', async () => {
      await list.openFromSidebar();
    });

    await step('Act: Step 1 — Observe the sidebar area and the 창고 관리 menu', async () => {
      await list.sidebarWarehouseMenu.scrollIntoViewIfNeeded();
    });

    await step('Act: Step 2 — Observe the 창고 등록 (Add warehouse) button', async () => {
      await list.addWarehouseButton.scrollIntoViewIfNeeded();
    });

    await step('Act: Step 3 — Observe 창고명 검색, the 거래처 filter, the 유형 filter and the 초기화 button', async () => {
      await list.searchByNameInput.scrollIntoViewIfNeeded();
    });

    await step('Act: Step 4 — Observe the 창고 목록 table and the paging area', async () => {
      await list.pageSizeSelect.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — Every listed layout element is displayed', async () => {
      await expect(list.sidebarWarehouseMenu, '[Expected 4] 창고 관리 menu is visible').toBeVisible();
      await expect(list.addWarehouseButton, '[Expected 4] 창고 등록 button is visible').toBeVisible();
      await expect(list.searchByNameLabel, '[Expected 4] 창고명 검색 label is visible').toBeVisible();
      await expect(list.searchByNameInput, '[Expected 4] 창고명 검색 input is visible').toBeVisible();
      await expect(list.bizPartnerLabel, '[Expected 4] 거래처 filter label is visible').toBeVisible();
      await expect(list.bizPartnerSelect, '[Expected 4] 거래처 filter select is visible').toBeVisible();
      await expect(list.typeLabel, '[Expected 4] 유형 filter label is visible').toBeVisible();
      await expect(list.typeSelect, '[Expected 4] 유형 filter select is visible').toBeVisible();
      await expect(list.resetButton, '[Expected 4] 초기화 button is visible').toBeVisible();
      await expect(list.panelTitle, '[Expected 4] 창고 목록 panel title is visible').toBeVisible();
      await expect(list.table, '[Expected 4] Warehouse table is visible').toBeVisible();
      await expect(list.columnHeader('상태'), '[Expected 4] 상태 column is visible').toBeVisible();
      const statuses = await list.columnValues('상태');
      expect(statuses.length, '[Expected 4] The table shows rows').toBeGreaterThan(0);
      for (const status of statuses) {
        expect([WH_TEXT.statusActive, WH_TEXT.statusInactive], `[Expected 4] 상태 cell "${status}" reads 활성 or 비활성`).toContain(status);
      }
      await expect(list.pageSizeSelect, '[Expected 4] 페이지당 selector is visible').toBeVisible();
      for (const size of ['10', '20', '50', '100']) {
        await expect(list.pageSizeOption(size), `[Expected 4] 페이지당 offers ${size}`).toHaveCount(1);
      }
    });
  });

  test('TC_US069_005 — The table shows every main column and renders buckets as System (virtual)', async ({ page, warehouseListPage: list, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US069_005',
      'Low',
      TAGS,
      'The 창고 목록 table shows ID, 거래처, 창고 유형, 창고명, 물류사 유형, 분류 and 상태. For a bucket row (virtual = true) the three columns ' +
        '창고 유형, 물류사 유형 and 분류 read "System (virtual)" and the 창고명 cell carries a "System (virtual)" badge. Data: an ' +
        'automation-owned warehouse (and its 5 buckets) is created and deleted afterwards.',
    );
    let name = '';

    await step('Arrange: Pre-condition 1 — The list has data, including an automation-owned warehouse with its 5 buckets', async () => {
      name = (await warehouseCleanup.create('PLATFORM_WMS_EGFLEX', 'TC_US069_005')).name;
    });

    await step('Act: Step 1 — Open 창고 목록 (narrowed to the automation-owned warehouse)', async () => {
      await list.open({ keyword: name });
    });

    await step('Act: Step 2 — Observe the header of the 창고 목록 table', async () => {
      await list.table.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — All main columns are shown and bucket rows read System (virtual)', async () => {
      for (const column of COLUMNS) {
        await expect(list.columnHeader(column), `[Expected 2] Column ${column} is displayed`).toBeVisible();
      }
      const bucketRows = list.tableRows.filter({ has: page.locator('span.badge', { hasText: VIRTUAL_LABEL }) });
      await expect(bucketRows, '[Expected 2] The 5 bucket rows are listed').toHaveCount(5);
      for (let i = 0; i < 5; i += 1) {
        const row = bucketRows.nth(i);
        for (const column of ['창고 유형', '물류사 유형', '분류']) {
          await expect(await list.cell(row, column), `[Expected 2] Bucket row ${i + 1}: ${column} reads System (virtual)`).toHaveText(VIRTUAL_LABEL);
        }
        await expect(list.virtualBadge(row), `[Expected 2] Bucket row ${i + 1}: 창고명 carries the System (virtual) badge`).toBeVisible();
      }
    });
  });

  test('TC_US069_006 — Warehouse data on the list matches the Detail/Edit screen', async ({ page, warehouseListPage: list, warehouseFormPage: form, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US069_006',
      'Medium',
      TAGS,
      'ID, 거래처, 창고 유형, 창고명, 물류사 유형, 분류 and 상태 of a list row match its Detail/Edit screen; for a bucket row the list and the ' +
        'Detail/Edit 상태 및 작업 panel both read "System (virtual)". Deviation from TC: on a bucket\'s Detail/Edit FORM the 창고 유형 select ' +
        'shows its stored type 플랫폼 물류 and 분류 shows "—" — only the panel reads System (virtual); the bucket comparison uses the panel. ' +
        'Data: an automation-owned warehouse is created and deleted afterwards.',
    );
    let name = '';
    let parentRow: Record<string, string> = {};
    let bucketRow: Record<string, string> = {};
    const obs = { parent: {} as Record<string, string>, parentPanel: {} as Record<string, string>, bucketPanel: {} as Record<string, string>, parentUrl: '' };

    await step('Arrange: Pre-condition 1 — The list contains an automation-owned warehouse with its buckets', async () => {
      name = (await warehouseCleanup.create('PLATFORM_WMS_EGFLEX', 'TC_US069_006')).name;
      await list.open({ keyword: name });
    });

    await step('Act: Step 1 — Record the information of the warehouse and of one bucket on the list', async () => {
      const rows = await list.readRows();
      parentRow = rows.find((row) => row['창고명'] === name)!;
      bucketRow = rows.find((row) => row['창고명'] !== name)!;
    });

    await step('Act: Step 2 — Click the warehouse on the list', async () => {
      await list.rowByName(name).click();
      await form.waitForDetailLoaded();
      obs.parentUrl = page.url();
    });

    await step('Assert: Expected 2 — The Detail/Edit screen opens the selected warehouse', async () => {
      await expect(page, '[Expected 2] URL carries the selected warehouse ID').toHaveURL(new RegExp(`/commerce/warehouses/${parentRow['ID']}$`));
      await expect(form.nameInput, '[Expected 2] The form shows the selected warehouse name').toHaveValue(name);
    });

    await step('Act: Step 3 — Compare the Detail/Edit information of the warehouse, then of the bucket, with the list', async () => {
      obs.parent = await form.readForm();
      for (const label of ['상태', '물류사 유형', '분류']) obs.parentPanel[label] = (await form.panelValue(label).textContent())?.trim() ?? '';
      await form.open(bucketRow['ID']);
      for (const label of ['상태', '물류사 유형', '분류']) obs.bucketPanel[label] = (await form.panelValue(label).textContent())?.trim() ?? '';
    });

    await step('Assert: Expected 3 — Every value matches the list, and the bucket reads System (virtual) on both', async () => {
      expect(obs.parentUrl.endsWith(`/${parentRow['ID']}`), '[Expected 3] ID matches').toBe(true);
      expect(obs.parent['거래처 *'], '[Expected 3] 거래처 matches').toBe(parentRow['거래처']);
      expect(obs.parent['창고 유형 *'], '[Expected 3] 창고 유형 matches').toBe(parentRow['창고 유형']);
      expect(obs.parent['창고명 *'], '[Expected 3] 창고명 matches').toBe(parentRow['창고명']);
      expect(obs.parentPanel['물류사 유형'], '[Expected 3] 물류사 유형 matches').toBe(parentRow['물류사 유형']);
      expect(obs.parentPanel['분류'], '[Expected 3] 분류 matches').toBe(parentRow['분류']);
      expect(obs.parentPanel['상태'], '[Expected 3] 상태 matches').toBe(parentRow['상태']);
      expect(bucketRow['창고 유형'], '[Expected 3] Bucket list 창고 유형 reads System (virtual)').toBe(VIRTUAL_LABEL);
      expect(obs.bucketPanel['물류사 유형'], '[Expected 3] Bucket 물류사 유형 matches the list (System (virtual))').toBe(bucketRow['물류사 유형']);
      expect(obs.bucketPanel['분류'], '[Expected 3] Bucket 분류 matches the list (System (virtual))').toBe(bucketRow['분류']);
      expect(obs.bucketPanel['상태'], '[Expected 3] Bucket 상태 matches the list').toBe(bucketRow['상태']);
    });
  });

  test('TC_US069_007 — No-data state on 창고 목록', async () => {
    await skipTc(
      'TC_US069_007',
      'Low',
      TAGS,
      'With no warehouse in the system the list shows "등록된 창고가 없습니다", the first-warehouse instructions and a 창고 등록 button.',
      'the pre-condition "no warehouses in the system" cannot be produced on the shared dev environment (other teams\' warehouses exist and must not be deleted).',
    );
  });

  test('TC_US069_008 — Search by warehouse name', async ({ page, warehouseListPage: list, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US069_008',
      'Medium',
      TAGS,
      `Searching "Incheon" shows only warehouses whose name contains "Incheon" (case-insensitive). ${DEVIATION_SEARCH_TRIGGER} Data: an ` +
        'automation-owned warehouse named "…Incheon Logistics Center" is created and deleted afterwards.',
    );
    let name = '';

    await step('Arrange: Pre-condition 1 — The list has a warehouse named "… Incheon Logistics Center"', async () => {
      name = (await warehouseCleanup.create('SUPPLIER', 'TC_US069_008', { name: `${warehouseName('TC_US069_008')} Incheon Logistics Center` })).name;
      await list.open({ size: '100' });
    });

    await step('Act: Step 1 — Enter "Incheon" in 창고명 검색 and press Enter', async () => {
      await list.searchByNameInput.fill('Incheon');
      await list.reloadingList(() => list.searchByNameInput.press('Enter'));
    });

    await step('Assert: Expected 1 — The list is filtered by 창고명', async () => {
      await expect(page, '[Expected 1] The keyword is applied to the list').toHaveURL(/keyword=Incheon/);
      await expect(list.rowByName(name), '[Expected 1] The matching automation-owned warehouse is listed').toBeVisible();
    });

    await step('Act: Step 2 — Observe the results on the 창고 목록 panel', async () => {
      await list.table.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Only warehouses whose name contains "Incheon" are displayed', async () => {
      const names = await list.columnValues('창고명');
      expect(names.length, '[Expected 2] At least one row is displayed').toBeGreaterThan(0);
      for (const shown of names) {
        expect(shown.toLowerCase(), `[Expected 2] "${shown}" contains "Incheon"`).toContain('incheon');
      }
    });
  });

  test('TC_US069_009 — Search is case-insensitive', async ({ page, warehouseListPage: list, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_009', 'Medium', TAGS, `Searching "incheon" and "INCHEON" returns the same rows. ${DEVIATION_SEARCH_TRIGGER} Data: an automation-owned "…Incheon…" warehouse is created and deleted afterwards.`);
    let name = '';
    let lower: string[] = [];
    let upper: string[] = [];

    await step('Arrange: Pre-condition 1 — The list has a warehouse whose name contains "Incheon"', async () => {
      name = (await warehouseCleanup.create('SUPPLIER', 'TC_US069_009', { name: `${warehouseName('TC_US069_009')} Incheon` })).name;
      await list.open({ size: '100' });
    });

    await step('Act: Step 1 — Type "incheon" in 창고명 검색 and press Enter', async () => {
      await list.searchByNameInput.fill('incheon');
      await list.reloadingList(() => list.searchByNameInput.press('Enter'));
      lower = await list.columnValues('ID');
    });

    await step('Act: Step 2 — Enter "INCHEON" in 창고명 검색 and press Enter', async () => {
      await list.searchByNameInput.fill('INCHEON');
      await list.reloadingList(() => list.searchByNameInput.press('Enter'));
      upper = await list.columnValues('ID');
    });

    await step('Act: Step 3 — Compare the results of the two searches', async () => {
      await list.table.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Both searches return the same rows', async () => {
      expect(lower.length, '[Expected 3] The lowercase search returns rows').toBeGreaterThan(0);
      expect(upper, '[Expected 3] The uppercase search returns exactly the lowercase result').toEqual(lower);
      await expect(list.rowByName(name), '[Expected 3] The automation-owned warehouse is in both results').toBeVisible();
    });
  });

  test('TC_US069_010 — No-result state when search/filter does not match', async ({ page, warehouseListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_010', 'Low', TAGS, 'A keyword matching nothing shows "필터 조건에 맞는 결과가 없습니다" with the hint "필터를 초기화해 보세요." and no warehouse row.');

    await step('Arrange: Pre-condition 1 — The list has data and can be searched', async () => {
      await list.open();
    });

    await step('Act: Step 1 — Enter a keyword that matches no warehouse and click 검색', async () => {
      await list.search({ keyword: `zz_no_match_${Date.now()}` });
    });

    await step('Assert: Expected 1 — The no-result title and hint are displayed', async () => {
      await expect(list.noResultsTitle, '[Expected 1] Title 필터 조건에 맞는 결과가 없습니다 is shown').toBeVisible();
      await expect(list.noResultsHint, '[Expected 1] Hint 필터를 초기화해 보세요. is shown').toBeVisible();
    });

    await step('Act: Step 2 — Observe the 창고 목록 panel area', async () => {
      await list.table.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — No warehouse is displayed', async () => {
      await expect(list.tableRows, '[Expected 2] No warehouse row is displayed').toHaveCount(0);
    });
  });

  test('TC_US069_011 — Filter by 거래처 (Biz partner)', async ({ page, warehouseListPage: list, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_011', 'Medium', TAGS, `Selecting a 거래처 shows only warehouses of that biz partner. Data: an automation-owned warehouse of ${BIZ_PARTNER.name} is created and deleted afterwards.`);
    let name = '';

    await step('Arrange: Pre-condition 1 — Warehouses of several biz partners exist (incl. an automation-owned one)', async () => {
      name = (await warehouseCleanup.create('SUPPLIER', 'TC_US069_011')).name;
      await list.open({ size: '100' });
    });

    await step('Act: Step 1 — Open the 거래처 filter', async () => {
      await list.bizPartnerSelect.focus();
    });

    await step(`Act: Step 2 — Choose ${BIZ_PARTNER.name} and click 검색`, async () => {
      await list.search({ bizPartner: BIZ_PARTNER.name });
    });

    await step('Act: Step 3 — Observe the 창고 목록 panel', async () => {
      await list.table.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Only warehouses of the selected biz partner are displayed', async () => {
      const partners = await list.columnValues('거래처');
      expect(partners.length, '[Expected 3] Rows are displayed').toBeGreaterThan(0);
      for (const partner of partners) {
        expect(partner, `[Expected 3] Row biz partner "${partner}" is ${BIZ_PARTNER.name}`).toBe(BIZ_PARTNER.name);
      }
      await list.search({ keyword: name });
      await expect(list.rowByName(name), '[Expected 3] The automation-owned warehouse of that partner is included').toBeVisible();
    });
  });

  test('TC_US069_012 — Filter by 창고 유형 (Type)', async ({ page, warehouseListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US069_012',
      'Medium',
      TAGS,
      'Selecting 유형 = 판매자 물류 shows only Supplier warehouses. Buckets always carry type PLATFORM (BR-8a), so they never appear under ' +
        '판매자 물류 — that is correct behaviour. The check covers the first page of 100 rows.',
    );

    await step('Arrange: Pre-condition 1 — The list has both 판매자 물류 and 플랫폼 물류 warehouses', async () => {
      await list.open({ size: '100' });
    });

    await step('Act: Step 1 — Open the 유형 filter', async () => {
      await list.typeSelect.focus();
    });

    await step('Act: Step 2 — Select 판매자 물류 (Supplier warehouse) and click 검색', async () => {
      await list.search({ type: WH_TEXT.typeSupplier });
    });

    await step('Act: Step 3 — Observe the 창고 목록 panel', async () => {
      await list.table.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Only warehouses of 창고 유형 = 판매자 물류 are displayed', async () => {
      const types = await list.columnValues('창고 유형');
      expect(types.length, '[Expected 3] Rows are displayed').toBeGreaterThan(0);
      for (const type of types) {
        expect(type, `[Expected 3] Row type "${type}" is 판매자 물류`).toBe(WH_TEXT.typeSupplier);
      }
    });
  });

  test('TC_US069_013 — Combined search, 거래처, 유형 and 상태 filters', async ({ page, warehouseListPage: list, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_013', 'Medium', TAGS, `All four conditions apply together: name contains the keyword, 거래처, 유형 and 상태 match. ${DEVIATION_SEARCH_TRIGGER} Data: an automation-owned Supplier warehouse is created and deleted afterwards.`);
    let name = '';

    await step('Arrange: Pre-condition 1 — Data for searching and filtering exists (automation-owned Supplier warehouse)', async () => {
      name = (await warehouseCleanup.create('SUPPLIER', 'TC_US069_013')).name;
      await list.open({ size: '100' });
    });

    await step('Act: Step 1 — Enter the keyword in 창고명 검색', async () => {
      await list.searchByNameInput.fill(name);
    });

    await step(`Act: Step 2 — Select 거래처 = ${BIZ_PARTNER.name}`, async () => {
      await list.bizPartnerSelect.selectOption({ label: BIZ_PARTNER.name });
    });

    await step('Act: Step 3 — Select 유형 = 판매자 물류', async () => {
      await list.typeSelect.selectOption({ label: WH_TEXT.typeSupplier });
    });

    await step('Act: Step 4 — Select 상태 = 활성 and click 검색', async () => {
      await list.search({ status: WH_TEXT.statusActive });
    });

    await step('Act: Step 5 — Observe the 창고 목록 table', async () => {
      await list.table.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 5 — Only warehouses satisfying all four conditions are displayed', async () => {
      const rows = await list.readRows();
      expect(rows.length, '[Expected 5] The matching warehouse is displayed').toBeGreaterThan(0);
      for (const row of rows) {
        expect(row['창고명'], '[Expected 5] Name contains the keyword').toContain(name);
        expect(row['거래처'], '[Expected 5] 거래처 matches').toBe(BIZ_PARTNER.name);
        expect(row['창고 유형'], '[Expected 5] 창고 유형 matches (buckets are PLATFORM, so excluded)').toBe(WH_TEXT.typeSupplier);
        expect(row['상태'], '[Expected 5] 상태 matches').toBe(WH_TEXT.statusActive);
      }
      await expect(list.rowByName(name), '[Expected 5] The automation-owned warehouse is displayed').toBeVisible();
    });
  });

  test('TC_US069_014 — 초기화 (Reset) clears the search and every filter', async ({ page, warehouseListPage: list, warehouseApi }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_014', 'Medium', TAGS, '초기화 clears 창고명 검색 and sets 거래처, 유형 and 상태 back to 전체; the list shows every warehouse again (total equals the API total).');

    await step('Arrange: Pre-condition 1 — A search and filters are applied', async () => {
      await list.open();
      await list.search({ keyword: 'auto', bizPartner: BIZ_PARTNER.name, type: WH_TEXT.typeSupplier, status: WH_TEXT.statusActive });
    });

    await step('Act: Step 1 — Click the 초기화 (Reset) button', async () => {
      await list.reset();
    });

    await step('Act: Step 2 — Look at the 창고명 검색 box and the filters', async () => {
      await list.searchByNameInput.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — 창고명 검색 is cleared', async () => {
      await expect(list.searchByNameInput, '[Expected 2] 창고명 검색 is empty').toHaveValue('');
    });

    await step('Act: Step 3 — Observe the 창고 목록 panel', async () => {
      await list.table.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — 거래처 and 유형 read 전체 and the list shows every warehouse', async () => {
      await expect(list.bizPartnerSelect, '[Expected 3] 거래처 is 전체').toHaveValue('');
      await expect(list.bizPartnerSelect.locator('option:checked'), '[Expected 3] 거래처 label reads 전체').toHaveText('전체');
      await expect(list.typeSelect, '[Expected 3] 유형 is 전체').toHaveValue('');
      const total = (await warehouseApi.list({}, 0, 1)).body.paging.totalCount;
      await expect(list.pagerTotalText, `[Expected 3] The list shows all ${total} warehouses`).toHaveText(new RegExp(`^총 ${total}개의 항목 중`));
    });

    await step('Act: Step 4 — Observe the 상태 filter', async () => {
      await list.statusSelect.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — 상태 is set to 전체', async () => {
      await expect(list.statusSelect, '[Expected 4] 상태 is 전체').toHaveValue('');
      await expect(list.statusSelect.locator('option:checked'), '[Expected 4] 상태 label reads 전체').toHaveText('전체');
    });
  });

  test('TC_US069_015 — Pagination and the 페이지당 (rows per page) selector', async ({ page, warehouseListPage: list, warehouseApi }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US069_015',
      'Medium',
      TAGS,
      'Default 10 rows per page; options 10/20/50/100; each option shows at most that many rows; switching page shows the selected page. ' +
        'Totals are counted on every row incl. buckets (6 rows per physical warehouse) — the pager total is compared with the API total.',
    );
    let total = 0;
    const shown: Record<string, number> = {};

    await step('Arrange: Pre-condition 1 — The list has more than 10 rows', async () => {
      total = (await warehouseApi.list({}, 0, 1)).body.paging.totalCount;
      expect(total, 'The environment holds enough warehouses for paging').toBeGreaterThan(10);
    });

    await step('Act: Step 1 — Open 창고 목록', async () => {
      await list.open();
    });

    await step('Act: Step 2 — Check the default number of rows per page', async () => {
      await list.pageSizeSelect.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Default is 10', async () => {
      await expect(list.pageSizeSelect, '[Expected 2] 페이지당 defaults to 10').toHaveValue('10');
      await expect(list.tableRows, '[Expected 2] 10 rows are displayed').toHaveCount(10);
    });

    await step('Act: Step 3 — Check the paging options', async () => {
      await list.pageSizeSelect.focus();
    });

    await step('Assert: Expected 3 — The options are 10, 20, 50 and 100', async () => {
      await expect(list.pageSizeSelect.locator('option'), '[Expected 3] Exactly four options').toHaveCount(4);
      for (const size of ['10', '20', '50', '100']) {
        await expect(list.pageSizeOption(size), `[Expected 3] Option ${size} exists`).toHaveCount(1);
      }
    });

    await step('Act: Step 4 — Switch the rows per page to 10, 20, 50 and 100', async () => {
      for (const size of ['20', '50', '100', '10']) {
        await list.setPageSize(size);
        shown[size] = await list.tableRows.count();
      }
    });

    await step('Assert: Expected 4 — Each option shows at most that many rows', async () => {
      for (const size of ['10', '20', '50', '100']) {
        expect(shown[size], `[Expected 4] ${size} per page shows ${Math.min(Number(size), total)} rows`).toBe(Math.min(Number(size), total));
      }
    });

    await step('Act: Step 5 — Switch to page 2', async () => {
      await list.goToPage('2');
    });

    await step('Assert: Expected 5 — The selected page is displayed', async () => {
      await expect(list.activePageItem, '[Expected 5] Page 2 is active').toHaveText(/^2/);
      await expect(list.pagerTotalText, '[Expected 5] The pager reads rows 11–20 of the total').toHaveText(`총 ${total}개의 항목 중 11-${Math.min(20, total)}개 표시`);
      await expect(list.tableRows, '[Expected 5] Page 2 shows its rows').toHaveCount(Math.min(10, total - 10));
    });
  });

  test('TC_US069_063 — Clicking a row opens its Detail/Edit screen', async ({ page, warehouseListPage: list, warehouseFormPage: form, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_063', 'Medium', TAGS, 'Clicking a warehouse on the list opens the Detail/Edit screen of that warehouse. Data: an automation-owned warehouse is created and deleted afterwards.');
    let id = 0;
    let name = '';

    await step('Arrange: Pre-condition 1 — The list has data (automation-owned warehouse listed)', async () => {
      ({ id, name } = await warehouseCleanup.create('SUPPLIER', 'TC_US069_063'));
      await list.open({ keyword: name });
    });

    await step('Act: Step 1 — Click the warehouse on the list', async () => {
      await list.rowByName(name).click();
    });

    await step('Act: Step 2 — Observe the screen being opened', async () => {
      await form.waitForDetailLoaded();
    });

    await step('Assert: Expected 2 — The Detail/Edit screen of the selected warehouse opens', async () => {
      await expect(page, '[Expected 2] URL carries the warehouse ID').toHaveURL(new RegExp(`/commerce/warehouses/${id}$`));
      await expect(form.cardHeader, '[Expected 2] The card title is the warehouse name').toContainText(name);
      await expect(form.nameInput, '[Expected 2] 창고명 holds the warehouse name').toHaveValue(name);
    });
  });

  test('TC_US069_090 — Korean UI of 창고 목록', async ({ page, warehouseListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US069_090',
      'Medium',
      [...TAGS, 'i18n'],
      'The list shows its main texts in Korean — 창고 목록, 창고 등록, 창고명 검색, 거래처, 창고 유형 (column; the filter label reads 유형), ' +
        '초기화, 상태 — with no unexpected English and no clipped text. Not automated: "misaligned" (visual judgement).',
    );
    const texts = () => [
      { name: '창고 목록', locator: list.panelTitle },
      { name: '창고 등록', locator: list.addWarehouseButton },
      { name: '창고명 검색', locator: list.searchByNameLabel },
      { name: '거래처', locator: list.bizPartnerLabel },
      { name: '창고 유형', locator: list.columnHeader('창고 유형') },
      { name: '초기화', locator: list.resetButton },
      { name: '상태', locator: list.statusLabel },
    ];

    await step('Arrange: Pre-condition 1 — ADMIN is logged in with 한국어', async () => {
      await list.goto('/');
    });

    await step('Act: Step 1 — Open the 창고 관리 (Warehouse management) menu', async () => {
      await list.openFromSidebar();
    });

    await step('Assert: Expected 1 — The 창고 목록 screen opens', async () => {
      await expect(list.panelTitle, '[Expected 1] 창고 목록 is displayed').toBeVisible();
    });

    await step('Act: Step 2 — Observe the entire 창고 목록 screen', async () => {
      await list.table.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — The main texts read in Korean, are not English and are not clipped', async () => {
      for (const { name, locator } of texts()) {
        await expect(locator, `[Expected 2] "${name}" is displayed`).toBeVisible();
        await expect(locator, `[Expected 2] "${name}" reads in Korean`).toHaveText(new RegExp(name));
        expect(await isClipped(locator), `[Expected 2] "${name}" is not clipped`).toBe(false);
      }
      const labels = [...(await page.locator('div.main-content label').allTextContents()), ...(await list.table.locator('thead th').allTextContents())];
      for (const label of labels.map((l) => l.trim()).filter((l) => l !== 'ID')) {
        expect(label, `[Expected 2] Label "${label}" has no unexpected English`).not.toMatch(/[A-Za-z]/);
      }
    });
  });

  test('TC_US069_100 — 상태 column shows the correct status, and buckets follow their parent', async ({ page, warehouseListPage: list, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US069_100',
      'Medium',
      TAGS,
      'The 상태 column is displayed: Active warehouses read 활성, Inactive ones 비활성, matching the stored detail; a deactivated parent\'s 5 ' +
        'buckets read 비활성 too. Data: two automation-owned warehouses (one deactivated via API) are created and deleted afterwards.',
    );
    const prefix = warehouseName('TC_US069_100');
    let active = { id: 0, name: '' };
    let inactive = { id: 0, name: '' };

    await step('Arrange: Pre-condition 1 — One Active and one Inactive warehouse exist (automation-owned)', async () => {
      active = await warehouseCleanup.create('SUPPLIER', 'TC_US069_100', { name: `${prefix}_A` });
      inactive = await warehouseCleanup.create('SUPPLIER', 'TC_US069_100', { name: `${prefix}_I` });
      await warehouseApi.deactivate(inactive.id, (await warehouseApi.get(inactive.id)).body.version);
    });

    await step('Act: Step 1 — Open 창고 목록 (narrowed to the two warehouses)', async () => {
      await list.open({ keyword: prefix, size: '20' });
    });

    await step('Act: Step 2 — Check the 상태 column', async () => {
      await list.columnHeader('상태').scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — 상태 reads 활성 / 비활성 per warehouse, matches the detail, and buckets follow their parent', async () => {
      await expect(list.columnHeader('상태'), '[Expected 2] 상태 column is displayed').toBeVisible();
      await expect(await list.cell(list.rowByName(active.name), '상태'), '[Expected 2] The Active warehouse reads 활성').toHaveText(WH_TEXT.statusActive);
      await expect(await list.cell(list.rowByName(inactive.name), '상태'), '[Expected 2] The Inactive warehouse reads 비활성').toHaveText(WH_TEXT.statusInactive);
      expect((await warehouseApi.get(active.id)).body.status, '[Expected 2] The Active warehouse detail is ACTIVE').toBe('ACTIVE');
      expect((await warehouseApi.get(inactive.id)).body.status, '[Expected 2] The Inactive warehouse detail is INACTIVE').toBe('INACTIVE');
      const rows = await list.readRows();
      const inactiveBuckets = rows.filter((row) => row['창고명'].startsWith(`${inactive.name} - `));
      const activeBuckets = rows.filter((row) => row['창고명'].startsWith(`${active.name} - `));
      expect(inactiveBuckets.length, '[Expected 2] The deactivated parent\'s 5 buckets are listed').toBe(5);
      for (const bucket of inactiveBuckets) expect(bucket['상태'], `[Expected 2] Bucket "${bucket['창고명']}" of the Inactive parent reads 비활성`).toBe(WH_TEXT.statusInactive);
      for (const bucket of activeBuckets) expect(bucket['상태'], `[Expected 2] Bucket "${bucket['창고명']}" of the Active parent reads 활성`).toBe(WH_TEXT.statusActive);
    });
  });

  test('TC_US069_101 — 상태 filter is displayed with 전체 / 활성 / 비활성', async ({ page, warehouseListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_101', 'Medium', TAGS, 'The list shows a 상태 filter offering 전체, 활성 and 비활성, defaulting to 전체.');

    await step('Arrange: Pre-condition 1 — Active and Inactive warehouses exist', async () => {
      await list.goto('/');
    });

    await step('Act: Step 1 — Open 창고 목록', async () => {
      await list.open();
    });

    await step('Assert: Expected 1 — A 상태 filter is displayed', async () => {
      await expect(list.statusLabel, '[Expected 1] 상태 filter label is visible').toBeVisible();
      await expect(list.statusSelect, '[Expected 1] 상태 filter select is visible').toBeVisible();
    });

    await step('Act: Step 2 — Locate the 상태 filter', async () => {
      await list.statusSelect.focus();
    });

    await step('Assert: Expected 2 — Options are 전체, 활성 and 비활성, default 전체', async () => {
      await expect(list.statusSelect.locator('option'), '[Expected 2] Options read 전체 · 활성 · 비활성').toHaveText(['전체', WH_TEXT.statusActive, WH_TEXT.statusInactive]);
      await expect(list.statusSelect.locator('option:checked'), '[Expected 2] Default is 전체').toHaveText('전체');
    });
  });

  test('TC_US069_102 — Filter warehouses by 상태', async ({ page, warehouseListPage: list, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US069_102',
      'Medium',
      TAGS,
      '상태 = 활성 shows only Active rows, 비활성 only Inactive rows (a deactivated parent returns with its 5 buckets = 6 rows), 전체 shows ' +
        'both. Data: two automation-owned warehouses (one deactivated) scope the check and are deleted afterwards.',
    );
    const prefix = warehouseName('TC_US069_102');
    let active = { id: 0, name: '' };
    let inactive = { id: 0, name: '' };
    const statusesOf = async () => list.columnValues('상태');

    await step('Arrange: Pre-condition 1–2 — One Active and one Inactive warehouse exist (automation-owned)', async () => {
      active = await warehouseCleanup.create('SUPPLIER', 'TC_US069_102', { name: `${prefix}_A` });
      inactive = await warehouseCleanup.create('SUPPLIER', 'TC_US069_102', { name: `${prefix}_I` });
      await warehouseApi.deactivate(inactive.id, (await warehouseApi.get(inactive.id)).body.version);
    });

    await step('Act: Step 1 — Open 창고 목록 (search narrowed to the two warehouses)', async () => {
      await list.open({ keyword: prefix, size: '20' });
    });

    await step('Act: Step 2 — Select 활성 in the 상태 filter and click 검색', async () => {
      await list.search({ status: WH_TEXT.statusActive });
    });

    await step('Act: Step 3 — Verify the result list', async () => {
      await list.table.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Only Active warehouses are displayed', async () => {
      for (const status of await statusesOf()) expect(status, '[Expected 3] Every row reads 활성').toBe(WH_TEXT.statusActive);
      await expect(list.rowByName(active.name), '[Expected 3] The Active warehouse is listed').toBeVisible();
      await expect(list.rowByName(inactive.name), '[Expected 3] The Inactive warehouse is not listed').toHaveCount(0);
    });

    await step('Act: Step 4 — Change the 상태 filter to 비활성 and click 검색', async () => {
      await list.search({ status: WH_TEXT.statusInactive });
    });

    await step('Act: Step 5 — Verify the result list', async () => {
      await list.table.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 5 — Only Inactive warehouses are displayed, the parent with its 5 buckets', async () => {
      for (const status of await statusesOf()) expect(status, '[Expected 5] Every row reads 비활성').toBe(WH_TEXT.statusInactive);
      await expect(list.tableRows, '[Expected 5] The deactivated parent and its 5 buckets = 6 rows').toHaveCount(6);
      await expect(list.rowByName(inactive.name), '[Expected 5] The Inactive warehouse is listed').toBeVisible();
    });

    await step('Act: Step 6 — Select 전체 in the 상태 filter and click 검색', async () => {
      await list.search({ status: '전체' });
    });

    await step('Act: Step 7 — Verify the result list', async () => {
      await list.table.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 7 — Both Active and Inactive warehouses are displayed', async () => {
      await expect(list.rowByName(active.name), '[Expected 7] The Active warehouse is listed').toBeVisible();
      await expect(list.rowByName(inactive.name), '[Expected 7] The Inactive warehouse is listed').toBeVisible();
      await expect(list.tableRows, '[Expected 7] Both parents and their 10 buckets = 12 rows').toHaveCount(12);
    });
  });

  test('TC_US069_103 — No-result message when no warehouse matches the selected 상태', async ({ page, warehouseListPage: list, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US069_103',
      'Medium',
      TAGS,
      'When no warehouse has the selected status the list shows no row and the no-result message, and the user can change the filter and ' +
        'search again. Deviation from TC: the shared environment always holds Inactive warehouses, so the pre-condition is produced by ' +
        'narrowing the list to one automation-owned Active warehouse (deleted afterwards).',
    );
    let name = '';

    await step('Arrange: Pre-condition 1–2 — No warehouse in scope has 상태 = 비활성 (list narrowed to an automation-owned Active warehouse)', async () => {
      name = (await warehouseCleanup.create('SUPPLIER', 'TC_US069_103')).name;
      await list.open({ keyword: name });
    });

    await step('Act: Step 1 — Open 창고 목록', async () => {
      await expect(list.rowByName(name)).toBeVisible();
    });

    await step('Act: Step 2 — Select 비활성 in the 상태 filter', async () => {
      await list.statusSelect.selectOption({ label: WH_TEXT.statusInactive });
    });

    await step('Act: Step 3 — Perform the filter action (검색)', async () => {
      await list.reloadingList(() => list.searchButton.click());
    });

    await step('Assert: Expected 3 — No row, the no-result message, and another search still works', async () => {
      await expect(list.tableRows, '[Expected 3] No warehouse row is displayed').toHaveCount(0);
      await expect(list.noResultsTitle, '[Expected 3] The no-result message is displayed').toBeVisible();
      await list.search({ status: WH_TEXT.statusActive });
      await expect(list.rowByName(name), '[Expected 3] Changing the filter and searching again shows the warehouse').toBeVisible();
    });
  });
});
