import type { Locator, Page } from '@playwright/test';
import { test, expect } from '@fixtures/stock.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { StockTextKey, stx } from '@utils/stock.i18n';
import { WORLD_NOTE, stockTags } from '@utils/stock-spec';
import { exportName } from '@utils/stock.data';
import type { StockWorld, WorldStockRow } from '@utils/stock.data';
import { Observations } from '@utils/observations';
import { hasHorizontalPageScroll, isClipped, isInsideContainerWidth, scrollsInside } from '@utils/layout';
import { StockCalculationPage } from '@pages/stock-calculation.page';
import { StockUiPage } from '@pages/stock-ui.page';
import type { SkuFormKind, SkuMasterListPage } from '@pages/sku-form.page';
import { ResponsiveLayout } from '@pages/stock-warehouse-detail.page';

/**
 * US134 — nhóm [Responsive] (TC_US134_434–438): list 재고 관리, 3 form SKU, các dialog và 3 list SKU master ở 5 bề rộng
 * 1920 / 1680 / 1440 / 1200 / 390. Mỗi dòng Steps đi qua nhiều bề rộng / màn hình → `Act: Step N` ghi nhận từng ý bằng
 * `Observations` (+ ảnh từng bề rộng), `Assert: Expected N` assert toàn bộ (soft). Không lưu gì — mọi dialog đóng bằng 취소.
 */
const TAGS = stockTags('responsive');
const WIDTHS = [1920, 1680, 1440, 1200, 390] as const;
const NARROW = 390;
const KO = (key: StockTextKey) => stx(key, 'ko');
const LAYOUT_NOTE =
  'Not automated: visual polish (spacing, colours, how pleasant the wrap looks) and reading the open native drop-down list — the drop-down is checked through its option texts. Viewport height is 1080 for desktop widths and 844 at 390.';

type Closable = { root: Locator; clickCancel: () => Promise<void>; confirmClose: Locator; confirmDiscard: () => Promise<void> };

/** Đóng dialog bằng 취소 (xác nhận nếu được hỏi) — không lưu gì. */
async function closeDialog(dialog: Closable): Promise<void> {
  if ((await dialog.root.count()) === 0) return;
  await dialog.clickCancel();
  await expect(async () => {
    if (await dialog.confirmClose.isVisible()) await dialog.confirmDiscard();
    await expect(dialog.root).toHaveCount(0, { timeout: 1_000 });
  }, 'The dialog closes').toPass({ timeout: 15_000 });
}

/** Ghi nhận "có thể đọc trọn": hiển thị, tới được trong bề ngang viewport và không bị cắt chữ. */
async function recordReadable(obs: Observations, layout: ResponsiveLayout, name: string, locator: Locator): Promise<void> {
  await obs.record(`${name} can be reached on screen`, () => layout.reachable(locator));
  await obs.record(`${name} is not cut off`, async () => !(await isClipped(locator)));
}

/** Ghi nhận mọi ô tiêu đề của bảng: tới được và không bị cắt. */
async function recordHeaders(obs: Observations, layout: ResponsiveLayout, tag: string, headers: Locator, expected: number): Promise<void> {
  await obs.record(`${tag} the table has ${expected} column headers`, async () => (await headers.count()) === expected);
  const count = await headers.count();
  for (let index = 0; index < count; index += 1) {
    const name = ((await headers.nth(index).textContent()) ?? '').trim() || '(tick box)';
    await recordReadable(obs, layout, `${tag} header "${name}"`, headers.nth(index));
  }
}

/** Bảng cuộn ngang trong khung riêng, cuộn tới cột cuối thì cột cuối vào được màn, trang không có thanh cuộn ngang. */
async function recordTableScroll(obs: Observations, layout: ResponsiveLayout, ui: StockUiPage, page: Page, tag: string, table: Locator): Promise<void> {
  const frame = ui.tableFrame(table);
  await obs.record(`${tag} the table scrolls sideways inside its own frame`, () => scrollsInside(frame, 'x'));
  await layout.scrollToEnd(frame);
  await obs.record(`${tag} the last column can be reached after scrolling the frame`, () => layout.reachable(table.locator('thead th').last()));
  await obs.record(`${tag} the whole page has no sideways scrollbar`, async () => !(await hasHorizontalPageScroll(page)));
}

test.describe('[Responsive] Stock management — screens and dialogs at 1920 / 1680 / 1440 / 1200 / 390 px', () => {
  test('TC_US134_434 — The stock list keeps its layout when the screen is resized to each width', async ({ page, world }) => {
    const step = makeStep(page);
    const list = new StockCalculationPage(page);
    const ui = new StockUiPage(page);
    const layout = new ResponsiveLayout(page);
    await tcMeta(
      'TC_US134_434',
      'Medium',
      TAGS,
      `The stock list (filtered to the 12 demo rows so all 22 columns hold data) is read at 1920, 1680, 1440, 1200 and 390 px: full layout with the 5 filter fields on 1 line at 1920; the top-bar extra block (the login-expiry timer) hidden at 1680; the user block hidden and the top navigation (Common | Account | …) narrower at 1440; at 1200 the left menu off screen, the top navigation hidden and the 3-line button sliding the menu in over a dimmed backdrop; at 390 the filter fields 2 per line (2-2-1) without overflow or overlap, the toolbar stacked (정렬 on top at full width, then the 6 buttons 2 per line, each about half wide) and the table scrolling inside its frame; no page-wide sideways scrollbar at any width. The host header blocks are mapped onto the admin template DOM (see ResponsiveLayout); the TC wording comes from prototype v1.2. Deviations TC ≠ UI observed in the 06/10 run (the host admin template does not apply the prototype breakpoints), kept as the TC states: at 1680 the login-expiry timer stays shown; at 1440 the user block stays shown and the top navigation keeps its width; at 1200 the left menu and the top navigation stay on screen, so no slide-in over a backdrop; at 390 the filter fields do not wrap 2-2-1 and 창고 / 비즈파트너 overflow the filter block, the toolbar does not stack into a column and 정렬 / the 6 action buttons are not stretched. ${LAYOUT_NOTE} ${WORLD_NOTE}`,
    );
    const obs = Array.from({ length: 5 }, () => new Observations(page));
    const fields = () => list.filterRow.locator(':scope > div').all();
    let navWidth1680 = 0;

    const recordAreas = async (o: Observations, tag: string) => {
      const areas: Array<[string, Locator]> = [['the top bar', layout.topBar], ['the left menu', layout.leftMenu], ['the 5-field filter block', list.filterRow], ['the toolbar', list.toolbar], ['the table', list.table]];
      for (const [name, locator] of areas) await o.record(`${tag} ${name} is shown`, () => locator.isVisible());
    };
    const noPageScroll = (o: Observations, tag: string) => o.record(`${tag} the whole page has no sideways scrollbar`, async () => !(await hasHorizontalPageScroll(page)));

    await step('Arrange: Pre-condition 1–3 — Stock data exists so all 22 columns are displayed; widths 1920, 1680, 1440, 1200, 390', async () => {
      await layout.resize(1920);
      await list.openWorld(world);
      expect((await list.headerTexts()).length, 'All 22 columns are displayed').toBe(22);
    });

    await step('Act: Step 1 — At 1920 read the top bar, the left menu, the 5-field filter block, the toolbar and the table', async () => {
      const tag = '[Expected 1] 1920 px:';
      await recordAreas(obs[0], tag);
      await obs[0].record(`${tag} the left menu is on screen`, () => layout.onScreen(layout.leftMenu));
      await obs[0].record(`${tag} the top navigation bar is shown`, () => layout.onScreen(layout.topNav));
      await obs[0].record(`${tag} the user block is shown`, () => layout.onScreen(layout.userBlock));
      await obs[0].record(`${tag} the extra information block is shown`, () => layout.onScreen(layout.extraInfo));
      await obs[0].record(`${tag} all 5 filter fields are on 1 line`, async () => JSON.stringify(await layout.lineCounts(await fields())) === '[5]');
      await noPageScroll(obs[0], tag);
    });

    await step('Assert: Expected 1 — Full desktop layout, the 5 filter fields on 1 line, no page-wide sideways scrollbar', async () => {
      obs[0].assertAll();
    });

    await step('Act: Step 2 — Pull in to 1680 and read those same areas', async () => {
      const tag = '[Expected 2] 1680 px:';
      await layout.resize(1680);
      await obs[1].record(`${tag} the extra information block of the top bar is hidden`, async () => !(await layout.onScreen(layout.extraInfo)));
      await recordAreas(obs[1], tag);
      await obs[1].record(`${tag} the user block is still shown`, () => layout.onScreen(layout.userBlock));
      await obs[1].record(`${tag} the top navigation bar is still shown`, () => layout.onScreen(layout.topNav));
      await obs[1].record(`${tag} the left menu is still on screen`, () => layout.onScreen(layout.leftMenu));
      navWidth1680 = await layout.width(layout.topNav);
      await noPageScroll(obs[1], tag);
    });

    await step('Assert: Expected 2 — The extra information block is hidden, everything else stays, no page-wide sideways scrollbar', async () => {
      obs[1].assertAll();
    });

    await step('Act: Step 3 — Pull in to 1440 and read those same areas', async () => {
      const tag = '[Expected 3] 1440 px:';
      await layout.resize(1440);
      await obs[2].record(`${tag} the user block of the top bar is hidden`, async () => !(await layout.onScreen(layout.userBlock)));
      await obs[2].record(`${tag} the extra information block stays hidden`, async () => !(await layout.onScreen(layout.extraInfo)));
      await obs[2].record(`${tag} the top navigation bar is still shown`, () => layout.onScreen(layout.topNav));
      await obs[2].record(`${tag} the top navigation bar is narrower than at 1680 px`, async () => (await layout.width(layout.topNav)) < navWidth1680);
      await recordAreas(obs[2], tag);
      await noPageScroll(obs[2], tag);
    });

    await step('Assert: Expected 3 — The user block is hidden too, the top navigation narrows, no page-wide sideways scrollbar', async () => {
      obs[2].assertAll();
    });

    await step('Act: Step 4 — Pull in to 1200, read those same areas, then click the 3-line button', async () => {
      const tag = '[Expected 4] 1200 px:';
      await layout.resize(1200);
      await obs[3].record(`${tag} the left menu slides off screen`, async () => !(await layout.onScreen(layout.leftMenu)));
      await obs[3].record(`${tag} the top navigation bar is hidden`, async () => !(await layout.onScreen(layout.topNav)));
      await obs[3].record(`${tag} the 3-line button is shown and enabled`, async () => (await layout.hamburger.isVisible()) && (await layout.hamburger.isEnabled()));
      await obs[3].screenshot('1200 px — before clicking the 3-line button');
      await layout.hamburger.click();
      await obs[3].record(`${tag} clicking the 3-line button slides the menu in`, async () => {
        await expect.poll(() => layout.onScreen(layout.leftMenu), { timeout: 5_000 }).toBe(true);
        return true;
      });
      await obs[3].record(`${tag} the menu slides in over a dimmed backdrop`, () => layout.backdrop.isVisible());
      await noPageScroll(obs[3], tag);
    });

    await step('Assert: Expected 4 — The menu slides off, the top navigation is hidden, the 3-line button slides the menu in over a backdrop', async () => {
      obs[3].assertAll();
    });

    await step('Act: Step 5 — Pull in to 390, read how the 5 filter fields wrap, read the toolbar, then scroll the table to its last column', async () => {
      const tag = '[Expected 5] 390 px:';
      if (await layout.backdrop.isVisible()) await layout.backdrop.click({ force: true });
      await layout.resize(NARROW);
      const items = await fields();
      await obs[4].record(`${tag} the 5 filter fields wrap 2 per line with the odd one on its own (2-2-1)`, async () => JSON.stringify(await layout.lineCounts(items)) === '[2,2,1]');
      for (const [index, field] of items.entries()) {
        await obs[4].record(`${tag} filter field ${index + 1} does not overflow the filter block`, () => isInsideContainerWidth(field, list.filterRow));
        if (index < 4) await obs[4].record(`${tag} filter field ${index + 1} fills its half of the line`, async () => (await layout.widthRatio(field, list.filterRow)) >= 0.4);
      }
      await obs[4].record(`${tag} no filter field overlaps another`, async () => !(await layout.anyOverlap(items)));
      const sortBlock = list.toolbar.locator(':scope > *').first();
      const buttons = await list.toolbarButtons.locator(':scope > *').all();
      await obs[4].record(`${tag} the toolbar stacks into a column`, async () => (await layout.flexDirection(list.toolbar)) === 'column');
      await obs[4].record(`${tag} the ${KO('sort.label')} (Sort) field is on top of the buttons`, async () => {
        const [sort, acts] = [await sortBlock.boundingBox(), await list.toolbarButtons.boundingBox()];
        return !!sort && !!acts && sort.y + sort.height <= acts.y + 1;
      });
      await obs[4].record(`${tag} the ${KO('sort.label')} (Sort) field is stretched to the width`, async () => (await layout.widthRatio(sortBlock, list.toolbar)) >= 0.95);
      await obs[4].record(`${tag} the toolbar has 6 action buttons`, async () => buttons.length === 6);
      await obs[4].record(`${tag} the 6 action buttons sit 2 per line`, async () => JSON.stringify(await layout.lineCounts(buttons)) === '[2,2,2]');
      for (const button of buttons) {
        const name = ((await button.textContent()) ?? '').trim();
        await obs[4].record(`${tag} action button "${name}" is stretched to fill its half`, async () => (await layout.widthRatio(button, list.toolbarButtons)) >= 0.4);
      }
      await recordTableScroll(obs[4], layout, ui, page, tag, list.table);
    });

    await step('Assert: Expected 5 — Filters 2 per line without overflow or overlap; toolbar stacked; the table scrolls inside its frame, no page scrollbar', async () => {
      obs[4].assertAll();
    });
  });

  test('TC_US134_435 — The 3 SKU form screens resize without cutting off any field at each width', async ({ page, world, skuFormPage: form }) => {
    const step = makeStep(page);
    const ui = new StockUiPage(page);
    const layout = new ResponsiveLayout(page);
    await tcMeta(
      'TC_US134_435',
      'Medium',
      TAGS,
      'At 1920, 1680, 1440, 1200 and 390 px the create screens are read: physical (every field label and control, the g unit of 중량, the 3 mm units of 부피, the 5 columns of the SKU line table with 옵션있음, 목록으로 and 저장), digital (4 fields + 2 foot buttons) and set (4 fields, the 4 columns of the SET 설정 table, 2 foot buttons); at 390 the 수출용 SKU명 box still takes typing and none of the 3 screens has a page-wide sideways scrollbar. "Read in full" = shown, reachable inside the viewport width and not cut off (scrollWidth ≤ clientWidth). Nothing is saved. ' +
        LAYOUT_NOTE,
    );
    const obs = Array.from({ length: 5 }, () => new Observations(page));
    let typed = '';

    const recordForm = async (o: Observations, tag: string, fieldCount?: number) => {
      const labels = await ui.formLabels.all();
      if (fieldCount !== undefined) await o.record(`${tag} the screen has ${fieldCount} fields`, async () => labels.length === fieldCount);
      for (const label of labels) await recordReadable(o, layout, `${tag} field label "${((await label.textContent()) ?? '').trim()}"`, label);
      await recordReadable(o, layout, `${tag} ${KO('skuForm.btn.backToList')} (Back to list)`, form.backButton);
      await recordReadable(o, layout, `${tag} ${KO('btn.save')} (Save)`, form.saveButton);
    };

    await step('Arrange: Pre-condition 1–3 — The physical, digital and set SKU create screens open; widths 1920, 1680, 1440, 1200, 390', async () => {
      await layout.resize(1920);
      await form.openCreate('physical');
    });

    await step('Act: Step 1 — At each width open the create physical SKU screen and read every field, the units, the 5 line columns and the 2 foot buttons', async () => {
      for (const width of WIDTHS) {
        const tag = `[Expected 1] ${width} px physical:`;
        await layout.resize(width);
        await form.openCreate('physical');
        await form.optionHas.check();
        await recordForm(obs[0], tag);
        const controls = await form.card.locator('input.form-control, select.form-select').all();
        for (const [index, control] of controls.entries()) await obs[0].record(`${tag} field control ${index + 1} can be reached on screen`, () => layout.reachable(control));
        await recordReadable(obs[0], layout, `${tag} the g unit of ${KO('skuForm.field.weight')}`, form.field('skuForm.field.weight').locator('.input-group-text'));
        const mm = form.field('skuForm.field.volume').locator('.input-group-text');
        await obs[0].record(`${tag} ${KO('skuForm.field.volume')} shows 3 mm units`, async () => (await mm.count()) === 3);
        for (let index = 0; index < 3; index += 1) await recordReadable(obs[0], layout, `${tag} mm unit ${index + 1} of ${KO('skuForm.field.volume')}`, mm.nth(index));
        await recordHeaders(obs[0], layout, `${tag}`, form.lineHeaders, 5);
        await obs[0].screenshot(`Physical SKU screen at ${width} px`);
      }
    });

    await step('Assert: Expected 1 — At every width every label and value reads in full, g and the 3 mm units show, 목록으로 and 저장 can be reached', async () => {
      obs[0].assertAll();
    });

    await step('Act: Step 2 — At 390 read the 수출용 SKU명 (Export SKU name) column on its own and type into it', async () => {
      const tag = '[Expected 2] 390 px:';
      const box = form.lineInput(0, 'exportSkuName');
      await recordReadable(obs[1], layout, `${tag} the ${KO('skuForm.col.exportSkuName')} box`, box);
      await recordReadable(obs[1], layout, `${tag} the ${KO('skuForm.col.exportSkuName')} column header`, form.lineHeaders.filter({ hasText: KO('skuForm.col.exportSkuName') }).first());
      typed = exportName(world.tag);
      await box.fill(typed);
      await obs[1].record(`${tag} the ${KO('skuForm.col.exportSkuName')} box takes typing`, async () => (await box.inputValue()) === typed);
    });

    await step('Assert: Expected 2 — The 수출용 SKU명 column can still be read and still takes typing', async () => {
      obs[1].assertAll();
    });

    await step('Act: Step 3 — At each width open the create digital SKU screen and read the 4 fields and the 2 foot buttons', async () => {
      for (const width of WIDTHS) {
        await layout.resize(width);
        await form.openCreate('digital');
        await recordForm(obs[2], `[Expected 3] ${width} px digital:`, 4);
        await obs[2].screenshot(`Digital SKU screen at ${width} px`);
      }
    });

    await step('Assert: Expected 3 — At every width all 4 fields and the 2 foot buttons read in full', async () => {
      obs[2].assertAll();
    });

    await step('Act: Step 4 — At each width open the create set SKU screen and read the 4 fields, the 4 set columns and the 2 foot buttons', async () => {
      for (const width of WIDTHS) {
        const tag = `[Expected 4] ${width} px set:`;
        await layout.resize(width);
        await form.openCreate('set');
        await recordForm(obs[3], tag, 4);
        await recordHeaders(obs[3], layout, tag, form.lineHeaders, 4);
        await obs[3].screenshot(`Set SKU screen at ${width} px`);
      }
    });

    await step('Assert: Expected 4 — At every width all 4 fields, the 4 table columns and the 2 foot buttons read in full', async () => {
      obs[3].assertAll();
    });

    await step('Act: Step 5 — At 390 check all 3 screens for a page-wide sideways scrollbar', async () => {
      await layout.resize(NARROW);
      for (const kind of ['physical', 'digital', 'set'] as const) {
        await form.openCreate(kind);
        await obs[4].record(`[Expected 5] 390 px ${kind}: the whole page has no sideways scrollbar`, async () => !(await hasHorizontalPageScroll(page)));
      }
    });

    await step('Assert: Expected 5 — None of the 3 screens gives the whole page a sideways scrollbar', async () => {
      obs[4].assertAll();
    });
  });

  test('TC_US134_436 — The 3 widest dialogs fit and scroll inside their own frame at each width', async ({ page, world, conversionDialog, stockHistoryDialog, adjustmentDialog }) => {
    const step = makeStep(page);
    const list = new StockCalculationPage(page);
    const ui = new StockUiPage(page);
    const layout = new ResponsiveLayout(page);
    const first = world.row('SKU0001', world.warehouses.CJ);
    const second = world.warehouses.DAEGU ? world.row('SKU0003', world.warehouses.DAEGU) : world.row('SKU0002', world.warehouses.CJ);
    const defective = world.bucket(world.warehouses.CJ, '불량');
    await tcMeta(
      'TC_US134_436',
      'Medium',
      TAGS,
      `At 1920, 1680, 1440, 1200 and 390 px: 재고 전환 for DEMO-SKU-0001 + DEMO-SKU-0003 (8 headers, the 5 policies written in full, the fixed CS note, 취소/저장 reachable, the dialog inside the screen); at 390 with 불량 처리 the destination (defective) warehouse name ${defective.name} must be readable and the table scrolls inside the dialog; 재고이력 of DEMO-SKU-0001 (10 headers, 엑셀 다운로드 downloads, 닫기 closes); 재고 조정 for DEMO-SKU-0001 inside the screen minus 16 px per side with 취소/저장 reachable and the table scrolling inside at 390; never a page-wide sideways scrollbar. Observed in the bundle: with 불량 처리 the dialog only shows a generic notice (${KO('convert.crossWarehouseNotice')}) and "-" in the destination columns — the destination name is asserted as the TC states. Also observed in the 06/10 run: at 390 the 재고 조정 dialog keeps the Bootstrap side margin of about 8 px instead of 16 px (deviation, asserted as the TC states). Data: the demo DEMO-SKU-0003 row is not CS managed and DEMO-SKU-0001 has no recorded movement in the demo world; neither changes the layout under test (an empty history still shows its 10 headers). ${world.warehouses.DAEGU ? '' : 'No CJ Daegu warehouse could be built, DEMO-SKU-0002 (CJ Incheon Aam) is the 2nd row. '}Nothing is saved. ${LAYOUT_NOTE} ${WORLD_NOTE}`,
    );
    const obs = Array.from({ length: 6 }, () => new Observations(page));
    const rowOf = (row: WorldStockRow) => list.row(row.sku.skuCode, row.warehouse.name);
    const policies = (['policy.SECURE_CS', 'policy.RELEASE_CS', 'policy.SECURE_HOLD', 'policy.RELEASE_HOLD', 'policy.SCRAP_DEFECTIVE'] as const).map(KO);

    const openConversion = async (width: number) => {
      await layout.resize(width);
      await list.openWorld(world);
      for (const row of [first, second]) await list.checkbox(rowOf(row)).check();
      await list.clickToolbar('btn.convertStock');
      await conversionDialog.waitOpen('ko');
    };
    const openHistory = async (width: number) => {
      await layout.resize(width);
      await list.openWorld(world);
      await list.openHistory(rowOf(first));
      await stockHistoryDialog.waitOpen('ko');
      await stockHistoryDialog.waitLoaded();
    };

    await step('Arrange: Pre-condition 1–4 — DEMO-SKU-0001 and DEMO-SKU-0003 in CJ warehouses; widths 1920, 1680, 1440, 1200, 390', async () => {
      await layout.resize(1920);
      await list.openWorld(world);
      await expect(rowOf(first), 'DEMO-SKU-0001 is listed').toBeVisible();
      await expect(rowOf(second), 'The 2nd row is listed').toBeVisible();
    });

    await step('Act: Step 1 — At each width tick both rows, open 재고 전환 and read the 8 headers, the 5 policies and the 2 foot buttons', async () => {
      for (const width of WIDTHS) {
        const tag = `[Expected 1] ${width} px:`;
        await openConversion(width);
        await obs[0].record(`${tag} the dialog fits on screen`, () => layout.fitsWithMargin(conversionDialog.root.locator('.modal-content'), 0));
        await recordHeaders(obs[0], layout, tag, conversionDialog.headerCells, 8);
        const options = (await conversionDialog.policySelect.locator('option:not([value=""])').allTextContents()).map((text) => text.trim());
        for (const policy of policies) await obs[0].record(`${tag} ${KO('convert.policyLabel')} offers "${policy}" in full`, async () => options.includes(policy));
        await obs[0].record(`${tag} ${KO('convert.policyLabel')} can be reached`, () => layout.reachable(conversionDialog.policySelect));
        await recordReadable(obs[0], layout, `${tag} the fixed notice`, conversionDialog.notice);
        await recordReadable(obs[0], layout, `${tag} ${KO('btn.cancel')} (Cancel)`, conversionDialog.cancelButton);
        await recordReadable(obs[0], layout, `${tag} ${KO('btn.save')} (Save)`, conversionDialog.saveButton);
        await obs[0].screenshot(`재고 전환 at ${width} px`);
        await closeDialog(conversionDialog);
      }
    });

    await step('Assert: Expected 1 — The dialog fits, all 5 policies read in full, the notice reads, 취소 and 저장 can be reached', async () => {
      obs[0].assertAll();
    });

    await step('Act: Step 2 — At 390 pick 불량 처리 (보류재고 → 불량) and read the destination warehouse name', async () => {
      const tag = '[Expected 2] 390 px:';
      await openConversion(NARROW);
      await conversionDialog.choosePolicy('SCRAP_DEFECTIVE');
      const name = conversionDialog.body.getByText(defective.name).first();
      await obs[1].record(`${tag} the destination warehouse name ${defective.name} is shown`, () => name.isVisible());
      await obs[1].record(`${tag} the destination warehouse name can be read in full`, async () => (await layout.reachable(name)) && !(await isClipped(name)));
      await recordReadable(obs[1], layout, `${tag} the defective-move notice`, conversionDialog.crossWarehouseNotice);
    });

    await step('Assert: Expected 2 — The destination warehouse name can be read in full at the narrowest width', async () => {
      obs[1].assertAll();
    });

    await step('Act: Step 3 — At 390 scroll the conversion table to its last column and check the page for a sideways scrollbar', async () => {
      await recordTableScroll(obs[2], layout, ui, page, '[Expected 3] 390 px:', conversionDialog.table);
    });

    await step('Assert: Expected 3 — The table scrolls sideways inside the dialog and the page has no sideways scrollbar', async () => {
      obs[2].assertAll();
    });

    await step('Act: Step 4 — At each width open 재고이력 on DEMO-SKU-0001 and read the 10 headers, the export button and 닫기', async () => {
      await closeDialog(conversionDialog);
      for (const width of WIDTHS) {
        const tag = `[Expected 4] ${width} px:`;
        await openHistory(width);
        await recordHeaders(obs[3], layout, tag, stockHistoryDialog.headerCells, 10);
        await obs[3].record(`${tag} ${KO('btn.exportStockExcel')} (Export) still works`, async () => {
          if (!(await layout.reachable(stockHistoryDialog.exportButton))) return false;
          const download = page.waitForEvent('download', { timeout: 30_000 });
          await stockHistoryDialog.exportButton.click();
          return !!(await download).suggestedFilename();
        });
        await obs[3].screenshot(`재고이력 at ${width} px`);
        await obs[3].record(`${tag} ${KO('btn.close')} (Close) still works`, async () => {
          if (!(await layout.reachable(stockHistoryDialog.closeButton))) return false;
          await stockHistoryDialog.close();
          await expect(stockHistoryDialog.root).toHaveCount(0);
          return true;
        });
      }
    });

    await step('Assert: Expected 4 — At every width all 10 headers can be reached and the export button and 닫기 still work', async () => {
      obs[3].assertAll();
    });

    await step('Act: Step 5 — At 390 scroll the history table to its last column and check the page for a sideways scrollbar', async () => {
      await openHistory(NARROW);
      await recordTableScroll(obs[4], layout, ui, page, '[Expected 5] 390 px:', stockHistoryDialog.table);
    });

    await step('Assert: Expected 5 — The table scrolls sideways inside the dialog and the page has no sideways scrollbar', async () => {
      obs[4].assertAll();
    });

    await step('Act: Step 6 — At each width tick DEMO-SKU-0001, open 재고 조정, read every header and the 2 foot buttons; at 390 scroll its table', async () => {
      if ((await stockHistoryDialog.root.count()) > 0) await stockHistoryDialog.close();
      for (const width of WIDTHS) {
        const tag = `[Expected 6] ${width} px:`;
        await layout.resize(width);
        await list.openWorld(world);
        await list.checkbox(rowOf(first)).check();
        await list.clickToolbar('btn.adjustStock');
        await adjustmentDialog.waitOpen('ko');
        await obs[5].record(`${tag} the dialog fits within the screen minus 16 px on each side`, () => layout.fitsWithMargin(adjustmentDialog.root.locator('.modal-content'), 16));
        await recordHeaders(obs[5], layout, tag, adjustmentDialog.headerCells, 8);
        await recordReadable(obs[5], layout, `${tag} ${KO('btn.cancel')} (Cancel)`, adjustmentDialog.cancelButton);
        await recordReadable(obs[5], layout, `${tag} ${KO('btn.save')} (Save)`, adjustmentDialog.saveButton);
        if (width === NARROW) await recordTableScroll(obs[5], layout, ui, page, tag, adjustmentDialog.table);
        await obs[5].screenshot(`재고 조정 at ${width} px`);
        await closeDialog(adjustmentDialog);
      }
    });

    await step('Assert: Expected 6 — The dialog fits within the screen minus 16 px, 취소/저장 reachable; at 390 the table scrolls inside, no page scrollbar', async () => {
      obs[5].assertAll();
    });
  });

  test('TC_US134_437 — The inbound request, per-warehouse detail and SKU search dialogs fit each width', async ({ page, world, incomingDialog, warehouseDetailDialog, skuFormPage: form, skuSearchDialog }) => {
    const step = makeStep(page);
    const list = new StockCalculationPage(page);
    const ui = new StockUiPage(page);
    const layout = new ResponsiveLayout(page);
    const first = world.row('SKU0001', world.warehouses.CJ);
    await tcMeta(
      'TC_US134_437',
      'Low',
      TAGS,
      `At 1920, 1680, 1440, 1200 and 390 px the 입고 요청 dialog (4 fields, the line table, 취소/저장) and the 창고별 상세 dialog (table, 취소/저장) for DEMO-SKU-0001 in CJ Incheon Aam, and the SKU 검색 dialog of the set SKU create screen (search row, result table, 취소/추가), each fit within the screen minus 16 px per side (prototype rule max-width min(900px, 100vw − 32px)) with every field and foot button reachable; at 390 each table scrolls sideways inside its dialog and the page has no sideways scrollbar. Deviation TC ≠ UI observed in the 06/10 run: at 390 all 3 dialogs keep the Bootstrap side margin of about 8 px, not the 16 px of the prototype rule — asserted as the TC states. Nothing is saved. ${LAYOUT_NOTE} ${WORLD_NOTE}`,
    );
    const obs = Array.from({ length: 4 }, () => new Observations(page));
    const row = () => list.row(first.sku.skuCode, first.warehouse.name);

    const openIncoming = async (width: number) => {
      await layout.resize(width);
      await list.openWorld(world);
      await list.checkbox(row()).check();
      await list.clickToolbar('btn.incomingRequest');
      await incomingDialog.waitOpen('ko');
    };
    const openDetail = async (width: number) => {
      await layout.resize(width);
      await list.openWorld(world);
      await list.checkbox(row()).check();
      await list.clickToolbar('btn.warehouseDetail');
      await warehouseDetailDialog.waitOpen('ko');
    };
    const openSkuSearch = async (width: number) => {
      await layout.resize(width);
      await form.openCreate('set');
      await form.click(form.addButton, `${KO('skuForm.btn.add')} button below the set table`);
      await skuSearchDialog.waitOpen('ko');
      await skuSearchDialog.search('SKU_CODE', world.tag);
    };
    const closeSkuSearch = async () => {
      if ((await skuSearchDialog.root.count()) === 0) return;
      await skuSearchDialog.cancelButton.click();
      await expect(skuSearchDialog.root, 'The SKU search dialog closes').toHaveCount(0);
    };
    const fits = (o: Observations, tag: string, root: Locator) => o.record(`${tag} the dialog fits within the screen minus 16 px on each side`, () => layout.fitsWithMargin(root.locator('.modal-content'), 16));

    await step('Arrange: Pre-condition 1–3 — DEMO-SKU-0001 in CJ Incheon Aam; widths 1920, 1680, 1440, 1200, 390', async () => {
      await layout.resize(1920);
      await list.openWorld(world);
      await expect(row(), 'DEMO-SKU-0001 is listed').toBeVisible();
    });

    await step('Act: Step 1 — At each width tick DEMO-SKU-0001, open 입고 요청 and read every field, the line table and the foot buttons', async () => {
      for (const width of WIDTHS) {
        const tag = `[Expected 1] ${width} px 입고 요청:`;
        await openIncoming(width);
        await fits(obs[0], tag, incomingDialog.root);
        for (const key of ['incoming.field.warehouse', 'incoming.field.expectedDate', 'incoming.field.type', 'incoming.field.manufacturer'] as const) {
          await recordReadable(obs[0], layout, `${tag} field ${KO(key)}`, incomingDialog.fieldLabel(key));
        }
        await obs[0].record(`${tag} the destination select can be reached`, () => layout.reachable(incomingDialog.warehouseSelect));
        await obs[0].record(`${tag} the expected date box can be reached`, () => layout.reachable(incomingDialog.expectedDateInput));
        await recordHeaders(obs[0], layout, tag, incomingDialog.headerCells, await incomingDialog.headerCells.count());
        await recordReadable(obs[0], layout, `${tag} ${KO('btn.cancel')} (Cancel)`, incomingDialog.cancelButton);
        await recordReadable(obs[0], layout, `${tag} ${KO('btn.save')} (Save)`, incomingDialog.saveButton);
        await obs[0].screenshot(`입고 요청 at ${width} px`);
        await closeDialog(incomingDialog);
      }
    });

    await step('Assert: Expected 1 — At every width the dialog fits within the screen minus 16 px and every field and foot button can be reached', async () => {
      obs[0].assertAll();
    });

    await step('Act: Step 2 — At each width open 창고별 상세 for the same row and read the table and the foot buttons', async () => {
      for (const width of WIDTHS) {
        const tag = `[Expected 2] ${width} px 창고별 상세:`;
        await openDetail(width);
        await fits(obs[1], tag, warehouseDetailDialog.root);
        await recordHeaders(obs[1], layout, tag, warehouseDetailDialog.headerCells, 5);
        await obs[1].record(`${tag} the CS stock managed choices can be reached`, () => layout.reachable(warehouseDetailDialog.rows.first().locator('input[type="radio"]').last()));
        await recordReadable(obs[1], layout, `${tag} ${KO('btn.cancel')} (Cancel)`, warehouseDetailDialog.cancelButton);
        await recordReadable(obs[1], layout, `${tag} ${KO('btn.save')} (Save)`, warehouseDetailDialog.saveButton);
        await obs[1].screenshot(`창고별 상세 at ${width} px`);
        await closeDialog(warehouseDetailDialog);
      }
    });

    await step('Assert: Expected 2 — Same as Expected 1 for 창고별 상세', async () => {
      obs[1].assertAll();
    });

    await step('Act: Step 3 — At each width open the set SKU screen, open SKU 검색 and read the search row, the result table and the foot buttons', async () => {
      for (const width of WIDTHS) {
        const tag = `[Expected 3] ${width} px SKU 검색:`;
        await openSkuSearch(width);
        await fits(obs[2], tag, skuSearchDialog.root);
        await obs[2].record(`${tag} the search field select can be reached`, () => layout.reachable(skuSearchDialog.searchFieldSelect));
        await obs[2].record(`${tag} the keyword box can be reached`, () => layout.reachable(skuSearchDialog.keywordInput));
        await recordReadable(obs[2], layout, `${tag} ${KO('btn.search')} (Search)`, skuSearchDialog.searchButton);
        await recordHeaders(obs[2], layout, tag, skuSearchDialog.headerCells, 4);
        await recordReadable(obs[2], layout, `${tag} ${KO('btn.cancel')} (Cancel)`, skuSearchDialog.cancelButton);
        await recordReadable(obs[2], layout, `${tag} ${KO('skuSearch.btn.add')} (Add)`, skuSearchDialog.addButton);
        await obs[2].screenshot(`SKU 검색 at ${width} px`);
        await closeSkuSearch();
      }
    });

    await step('Assert: Expected 3 — Same as Expected 1 for SKU 검색', async () => {
      obs[2].assertAll();
    });

    await step("Act: Step 4 — At 390 scroll each dialog's table to its last column and check the page for a sideways scrollbar", async () => {
      await openIncoming(NARROW);
      await recordTableScroll(obs[3], layout, ui, page, '[Expected 4] 390 px 입고 요청:', incomingDialog.table);
      await obs[3].screenshot('입고 요청 at 390 px, table scrolled');
      await closeDialog(incomingDialog);
      await openDetail(NARROW);
      await recordTableScroll(obs[3], layout, ui, page, '[Expected 4] 390 px 창고별 상세:', warehouseDetailDialog.table);
      await obs[3].screenshot('창고별 상세 at 390 px, table scrolled');
      await closeDialog(warehouseDetailDialog);
      await openSkuSearch(NARROW);
      await recordTableScroll(obs[3], layout, ui, page, '[Expected 4] 390 px SKU 검색:', skuSearchDialog.table);
    });

    await step('Assert: Expected 4 — Each table scrolls sideways inside its dialog and the page has no sideways scrollbar', async () => {
      obs[3].assertAll();
    });
  });

  test('TC_US134_438 — The 3 SKU master list screens resize at each width', async ({ page, world, skuMasterPage: master, skuFormPage: form }) => {
    const step = makeStep(page);
    const ui = new StockUiPage(page);
    const layout = new ResponsiveLayout(page);
    await tcMeta(
      'TC_US134_438',
      'Medium',
      TAGS,
      `현물 SKU 마스터 관리 is read at 1920 (left menu, filter block, toolbar, table, no page scrollbar), at 1680 / 1440 / 1200 (no page scrollbar; at 1200 the left menu off screen and the 3-line button sliding it in) and at 390 (filter controls wrapped onto several lines without overflow, the table scrolling inside its frame, no page scrollbar); at 390 a product code opens the SKU edit screen that reads in full; set and 디지털 SKU 마스터 관리 are read the same way at all 5 widths. Observed on dev 05/10: the 3 lists have no menu item, so they are opened by URL; the filter block holds 1 field (검색조건 = select + keyword box) and its action row (초기화 · 검색 · SKU 생성 업로드) is read as the toolbar. Deviations TC ≠ UI observed in the 06/10 run (host admin template breakpoints), kept as the TC states: at 1200 the left menu stays on screen on all 3 lists; at 390 the 검색조건 select and keyword box stay on 1 line and the keyword box overflows the card. The edit screen is opened on DEMO-SKU-0001 of the demo world and never saved. ${LAYOUT_NOTE} ${WORLD_NOTE}`,
    );
    const obs = Array.from({ length: 5 }, () => new Observations(page));
    const filterBlock = master.card.locator('.border-bottom.pb-3.mb-3').first();
    const toolbar = filterBlock.locator('.justify-content-end').first();

    const readAt = async (o: Observations, kind: SkuFormKind, width: number, expected: number) => {
      const tag = `[Expected ${expected}] ${width} px ${kind}:`;
      await layout.resize(width);
      await master.open(kind);
      if (width === 1920) {
        for (const [name, locator] of [['the left menu', layout.leftMenu], ['the filter block', filterBlock], ['the toolbar', toolbar], ['the table', master.table]] as const) {
          await o.record(`${tag} ${name} is shown`, () => layout.onScreen(locator));
        }
      }
      if (width === 1200) {
        await o.record(`${tag} the left menu slides off screen`, async () => !(await layout.onScreen(layout.leftMenu)));
        await o.record(`${tag} the 3-line button can be clicked`, async () => (await layout.hamburger.isVisible()) && (await layout.hamburger.isEnabled()));
        await layout.hamburger.click();
        await o.record(`${tag} clicking the 3-line button slides the menu in`, async () => {
          await expect.poll(() => layout.onScreen(layout.leftMenu), { timeout: 5_000 }).toBe(true);
          return true;
        });
        if (await layout.backdrop.isVisible()) await layout.backdrop.click({ force: true });
      }
      if (width === NARROW) {
        const controls = await filterBlock.locator('select, input[type="text"]').all();
        await o.record(`${tag} the filter fields wrap onto several lines`, async () => (await layout.lineCounts(controls)).length > 1);
        for (const [index, control] of controls.entries()) await o.record(`${tag} filter control ${index + 1} does not overflow`, () => isInsideContainerWidth(control, master.card));
        await recordTableScroll(o, layout, ui, page, tag, master.table);
      } else {
        await o.record(`${tag} the whole page has no sideways scrollbar`, async () => !(await hasHorizontalPageScroll(page)));
      }
      await o.screenshot(`${kind} SKU master at ${width} px`);
    };

    await step('Arrange: Pre-condition 1–4 — The physical, set and digital SKU master lists are reachable; widths 1920, 1680, 1440, 1200, 390', async () => {
      await layout.resize(1920);
      await master.open('physical');
    });

    await step('Act: Step 1 — At 1920 open 현물 SKU 마스터 관리 and read the left menu, the filter block, the toolbar and the table', async () => {
      await readAt(obs[0], 'physical', 1920, 1);
    });

    await step('Assert: Expected 1 — Full desktop layout and no page-wide sideways scrollbar', async () => {
      obs[0].assertAll();
    });

    await step('Act: Step 2 — Pull in to 1680, then 1440, then 1200, clicking the 3-line button at 1200', async () => {
      for (const width of [1680, 1440, 1200]) await readAt(obs[1], 'physical', width, 2);
      await obs[1].record('[Expected 2] 1200 px physical: the whole page has no sideways scrollbar after the menu slides in', async () => !(await hasHorizontalPageScroll(page)));
    });

    await step('Assert: Expected 2 — At 1200 the menu slides off and the 3-line button slides it in; no page scrollbar at all 3 steps', async () => {
      obs[1].assertAll();
    });

    await step('Act: Step 3 — Pull in to 390, read how the filter fields wrap and scroll the table to its last column', async () => {
      await readAt(obs[2], 'physical', NARROW, 3);
    });

    await step('Assert: Expected 3 — Filter fields wrap without overflow, the table scrolls inside its frame, no page scrollbar', async () => {
      obs[2].assertAll();
    });

    await step('Act: Step 4 — At 390 click a row to open the SKU edit screen and read that screen', async () => {
      await openOwnEdit(master, world);
      await obs[3].record('[Expected 4] 390 px: the SKU edit screen opens', async () => /\/commerce\/product-stock\/stock\/physical\/edit\?skuGroupId=/.test(page.url()));
      await expect(form.cardTitle, 'The SKU edit screen loads').toBeVisible({ timeout: 30_000 });
      for (const label of await ui.formLabels.all()) await recordReadable(obs[3], layout, `[Expected 4] 390 px edit: field label "${((await label.textContent()) ?? '').trim()}"`, label);
      await recordReadable(obs[3], layout, `[Expected 4] 390 px edit: ${KO('skuForm.btn.backToList')} (Back to list)`, form.backButton);
      await recordReadable(obs[3], layout, `[Expected 4] 390 px edit: ${KO('btn.save')} (Save)`, form.saveButton);
      await obs[3].record('[Expected 4] 390 px edit: the whole page has no sideways scrollbar', async () => !(await hasHorizontalPageScroll(page)));
    });

    await step('Assert: Expected 4 — The SKU edit screen opens and can be read in full at 390', async () => {
      obs[3].assertAll();
    });

    await step('Act: Step 5 — Repeat steps 1 to 3 with set SKU 마스터 관리 and 디지털 SKU 마스터 관리', async () => {
      for (const kind of ['set', 'digital'] as const) {
        for (const width of WIDTHS) await readAt(obs[4], kind, width, 5);
      }
    });

    await step('Assert: Expected 5 — The other 2 screens behave the same way at all 5 widths', async () => {
      obs[4].assertAll();
    });
  });
});

/** Trên list SKU master đang mở (bề rộng hiện tại), lọc về DEMO-SKU-0001 và bấm 상품코드 để mở màn sửa. */
async function openOwnEdit(master: SkuMasterListPage, world: StockWorld): Promise<void> {
  const sku = world.sku('SKU0001');
  await master.open('physical');
  await master.search('SKU_GROUP_CODE_NAME', world.keyword);
  await master.click(master.row(sku.skuCode).getByRole('link', { name: sku.groupCode }), `product code ${sku.groupCode}`);
}

