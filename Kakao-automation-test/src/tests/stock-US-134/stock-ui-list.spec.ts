import { test, expect } from '@fixtures/stock.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { STOCK_COLUMN_KEYS } from '@pages/stock-list.page';
import { STOCK_LANGS, StockTextKey, stx } from '@utils/stock.i18n';
import { LANG_SUFFIX, WORLD_NOTE, stockTags } from '@utils/stock-spec';

/**
 * US134 — nhóm [UI] của màn list + menu (TC_US134_07, 08). Nguồn TC: input/US134_TestCase_EN_v18.md
 * (Steps N / Expected N → `Act: Step N` / `Assert: Expected N`; TC ghi "run in Korean, then English" → chạy trọn chuỗi
 * 2 lượt, hậu tố (Korean)/(English)). Kỳ vọng assert theo TC; chỗ UI khác TC ghi trong description.
 */
const TAGS = stockTags('ui');

test.describe('[UI] Stock management — list layout and menu', () => {
  test('TC_US134_07 — All 22 stock list columns and 5 filters are shown with their labels', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_07',
      'Medium',
      TAGS,
      `The stock list shows the 22 headers in order, 5 filter controls with the keyword hint, the action row 초기화 · 검색 · 엑셀 다운로드, the toolbar 정렬 + 6 buttons, 페이지당 in the pager, and none of the 4 SKU create actions — in Korean, then in English. The host pager (총 … 개 표시 / 페이지당) is not translated by the screen, so 페이지당 is checked in Korean in both runs. ${WORLD_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–3 — Logged in with write access, demo stock rows present, window 1920 wide', async () => {
      expect(world.stockRows.length, 'The demo world holds stock rows so every column is filled').toBeGreaterThan(0);
    });

    for (const lang of STOCK_LANGS) {
      const t = (key: StockTextKey) => stx(key, lang);
      const sfx = LANG_SUFFIX[lang];
      let headers: string[] = [];

      await step(`Act: Step 1 — Open 재고 관리 (Stock management) and read the 22 column headers ${sfx}`, async () => {
        await list.open(lang);
        await list.search('SKU_GROUP_NAME', world.keyword);
        headers = await list.headerTexts();
      });

      await step(`Assert: Expected 1 — The 22 headers are in the TC order, the first being the tick box with no label ${sfx}`, async () => {
        expect(headers.length, '[Expected 1] The table has exactly 22 columns').toBe(22);
        expect(headers[0], '[Expected 1] Column 1 is the tick box with no label').toBe('');
        await expect(list.selectAllCheckbox, '[Expected 1] Column 1 holds the tick box').toBeVisible();
        STOCK_COLUMN_KEYS.slice(1).forEach((key, index) => {
          expect(headers[index + 1], `[Expected 1] Column ${index + 2} is ${t(key as StockTextKey)}`).toBe(t(key as StockTextKey));
        });
      });

      await step(`Act: Step 2 — Count the controls in the filter block, read each label and the keyword hint ${sfx}`, async () => {
        await expect(list.filterRow, 'The filter block is shown').toBeVisible();
      });

      await step(`Assert: Expected 2 — Exactly 5 controls: 검색조건, 대구분, SKU유형, 창고, 비즈파트너; hint 검색어를 입력해주세요. ${sfx}`, async () => {
        await expect(list.filterRow.locator('label.form-label'), '[Expected 2] The filter block has exactly 5 labelled controls').toHaveCount(5);
        for (const key of ['filter.searchCondition', 'filter.warehouseGroup', 'filter.skuType', 'filter.warehouse', 'filter.bizPartner'] as const) {
          await expect(list.filterLabel(key), `[Expected 2] Filter ${t(key)} is shown`).toBeVisible();
        }
        await expect(list.searchFieldSelect, '[Expected 2] 검색조건 has a choice list').toBeVisible();
        await expect(list.keywordInput, '[Expected 2] 검색조건 has a text box next to the choice list').toBeVisible();
        await expect(list.keywordInput, `[Expected 2] The keyword box shows the hint ${t('filter.searchPlaceholder')}`).toHaveAttribute('placeholder', t('filter.searchPlaceholder'));
      });

      let actionRow: string[] = [];
      await step(`Act: Step 3 — Read the buttons in the filter block's action row ${sfx}`, async () => {
        actionRow = (await list.filterActionRow.getByRole('button').allInnerTexts()).map((text) => text.trim());
      });

      await step(`Assert: Expected 3 — The action row has 3 buttons in order: 초기화, 검색, 엑셀 다운로드 ${sfx}`, async () => {
        expect(actionRow, `[Expected 3] The action row reads ${t('btn.reset')} · ${t('btn.search')} · ${t('btn.exportStockExcel')}`).toEqual([t('btn.reset'), t('btn.search'), t('btn.exportStockExcel')]);
      });

      await step(`Act: Step 4 — Read the toolbar, then the pagination bar below the table ${sfx}`, async () => {
        await expect(list.toolbar, 'The toolbar is shown').toBeVisible();
      });

      await step(`Assert: Expected 4 — 정렬 and 6 buttons in the toolbar; 페이지당 in the pagination bar ${sfx}`, async () => {
        await expect(list.filterLabel('sort.label'), `[Expected 4] The toolbar has ${t('sort.label')}`).toBeVisible();
        await expect(list.sortSelect, `[Expected 4] ${t('sort.label')} has a choice list`).toBeVisible();
        await expect(list.toolbarButtons.locator(':scope > *'), '[Expected 4] The toolbar has exactly 6 buttons').toHaveCount(6);
        for (const key of ['btn.incomingRequest', 'btn.uploadIncomingExcel', 'btn.adjustStock', 'btn.uploadAdjustmentExcel', 'btn.convertStock', 'btn.warehouseDetail'] as const) {
          await expect(list.toolbarButtons.getByText(t(key), { exact: true }), `[Expected 4] Toolbar button ${t(key)} is shown`).toBeVisible();
        }
        await expect(list.card.getByText('페이지당', { exact: true }), '[Expected 4] 페이지당 (Rows per page) is in the pagination bar').toBeVisible();
        const tableBox = await list.table.boundingBox();
        const pagerBox = await list.card.getByText('페이지당', { exact: true }).boundingBox();
        expect(!!tableBox && !!pagerBox && pagerBox.y > tableBox.y + tableBox.height - 1, '[Expected 4] 페이지당 sits below the table').toBe(true);
      });

      await step(`Act: Step 5 — Look over the whole screen for the 3 SKU create buttons and SKU 생성 업로드 ${sfx}`, async () => {
        await expect(list.table, 'The list screen is fully shown').toBeVisible();
      });

      await step(`Assert: Expected 5 — None of 현물 SKU 생성, 디지털 SKU 생성, set SKU 생성, SKU 생성 업로드 is on this screen ${sfx}`, async () => {
        for (const key of ['master.create.physical', 'master.create.digital', 'master.create.set', 'master.btn.uploadSkuExcel'] as const) {
          await expect(page.getByText(t(key), { exact: true }), `[Expected 5] ${t(key)} is not on the stock screen`).toHaveCount(0);
        }
      });
    }
  });

  test('TC_US134_08 — The new SKU menu group has exactly 3 items and each opens a list of that SKU type', async ({ page, world, stockListPage: list, skuMasterPage }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_08',
      'Medium',
      TAGS,
      `Under 물류 관리 the menu shows 재고 관리 plus a new group SKU 마스터 관리 with 현물 / set / 디지털 SKU 마스터 관리; the first item opens /commerce/product-stock/sku-master/physical listing only physical SKUs, and a product code opens the physical edit route. Observed on dev 05/10: 물류 관리 holds only 발주 관리 and 재고 관리 — the sku-master routes exist but have no menu item, so the list is opened by URL for Steps 4–5. ${WORLD_NOTE}`,
    );
    let children: string[] = [];
    let opened = false;

    await step('Arrange: Pre-condition 1–2 — Logged in with write access, physical / set / digital SKUs exist', async () => {
      expect(world.sku('SKU0001').type, 'The demo world holds a physical SKU').toBe('PHYSICAL');
      expect(world.sku('SKU0007').type, 'The demo world holds a set SKU').toBe('MIXED');
      expect(world.sku('SKU0006').type, 'The demo world holds a digital SKU').toBe('DIGITAL');
    });

    await step('Act: Step 1 — Open the left menu and expand the group 물류 관리 (Logistics management)', async () => {
      await list.openFromSidebar();
      children = await list.sidebarChildren('물류 관리');
    });

    await step('Assert: Expected 1 — 물류 관리 shows 재고 관리 and one new group', async () => {
      expect(children, '[Expected 1] 물류 관리 holds 재고 관리 (Stock management)').toContain('재고 관리');
      expect(children, '[Expected 1] 물류 관리 holds the new group SKU 마스터 관리').toContain('SKU 마스터 관리');
    });

    let groupItems: string[] = [];
    await step('Act: Step 2 — Read the name of the new group and count its items', async () => {
      const group = list.sidebarLink('SKU 마스터 관리');
      if (await group.isVisible()) {
        await list.click(group, 'SKU 마스터 관리 group in the sidebar');
        groupItems = await list.sidebarChildren('SKU 마스터 관리');
      }
    });

    await step('Assert: Expected 2 — The new group is SKU 마스터 관리 with exactly 3 items', async () => {
      await expect(list.sidebarLink('SKU 마스터 관리'), '[Expected 2] The new group is called SKU 마스터 관리 (SKU master management)').toBeVisible();
      expect(groupItems.length, '[Expected 2] SKU 마스터 관리 has exactly 3 items').toBe(3);
    });

    await step('Act: Step 3 — Read the names of the 3 items one by one', async () => {
      expect(groupItems, 'The item names are read from the menu').toBeDefined();
    });

    await step('Assert: Expected 3 — The 3 items are 현물 SKU 마스터 관리, set SKU 마스터 관리, 디지털 SKU 마스터 관리', async () => {
      for (const name of ['현물 SKU 마스터 관리', 'set SKU 마스터 관리', '디지털 SKU 마스터 관리']) {
        expect(groupItems, `[Expected 3] The group holds ${name}`).toContain(name);
      }
    });

    let physicalTypes: string[] = [];
    await step('Act: Step 4 — Click the first item and read the list that opens, and the page address', async () => {
      const first = list.sidebarLink('현물 SKU 마스터 관리');
      if (await first.isVisible()) {
        await list.click(first, '현물 SKU 마스터 관리 menu item');
        opened = true;
      } else {
        await skuMasterPage.open('physical');
      }
      await skuMasterPage.search('SKU_GROUP_CODE_NAME', world.keyword);
      const kindIndex = (await skuMasterPage.headerTexts()).indexOf('SKU 종류');
      physicalTypes = kindIndex < 0 ? [] : (await skuMasterPage.bodyRows.locator(`td:nth-child(${kindIndex + 1})`).allInnerTexts()).map((text) => text.trim());
    });

    await step('Assert: Expected 4 — The list opens at /commerce/product-stock/sku-master/physical and shows only physical SKUs', async () => {
      expect(opened, '[Expected 4] The list is opened from the 현물 SKU 마스터 관리 menu item').toBe(true);
      await expect(page, '[Expected 4] The address is /commerce/product-stock/sku-master/physical').toHaveURL(/\/commerce\/product-stock\/sku-master\/physical(\?|$)/);
      for (const key of ['SKU0001', 'SKU0002', 'SKU0003'] as const) {
        await expect(skuMasterPage.row(world.sku(key).skuCode), `[Expected 4] Physical SKU ${world.sku(key).skuCode} is listed`).toBeVisible();
      }
      for (const key of ['SKU0006', 'SKU0010', 'SKU0007', 'SKU0012'] as const) {
        await expect(skuMasterPage.row(world.sku(key).skuCode), `[Expected 4] ${world.sku(key).type} SKU ${world.sku(key).skuCode} is not listed on the physical list`).toHaveCount(0);
      }
      expect(physicalTypes.length, '[Expected 4] The physical list shows rows').toBeGreaterThan(0);
    });

    await step('Act: Step 5 — Click the 상품코드 (Product code) of one row in that list', async () => {
      const sku = world.sku('SKU0001');
      await skuMasterPage.click(skuMasterPage.row(sku.skuCode).getByRole('link', { name: sku.groupCode }), `product code ${sku.groupCode}`);
    });

    await step('Assert: Expected 5 — The physical edit screen opens at /commerce/product-stock/stock/physical/edit?skuGroupId=<group id>', async () => {
      await expect(page, `[Expected 5] The address is the physical edit route of SKU group ${world.sku('SKU0001').groupId}`).toHaveURL(
        new RegExp(`/commerce/product-stock/stock/physical/edit\\?skuGroupId=${world.sku('SKU0001').groupId}(&|$)`),
      );
    });
  });
});
