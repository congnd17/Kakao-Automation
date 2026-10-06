import { test, expect } from '@fixtures/territory.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { Observations } from '@utils/observations';
import { hasHorizontalPageScroll, isClipped, isWithinViewportWidth, scrollsInside } from '@utils/layout';
import { NORMAL_FLAGS } from '@utils/territory.data';

/**
 * US089 — nhóm [Responsive]. Đo hình học bằng `@utils/layout`. Phần khung app (top bar, thông tin account, sidebar trượt,
 * nút hamburger) chưa được recon trên dev → ghi Not automated, không đoán locator. Dialog xác nhận mở được từ 29/09
 * (account có quyền ghi) — test chỉ đo rồi bấm Back, không lưu.
 */
const TAGS = ['responsive', 'territory'];
const HEIGHT = 900;
const DATA = 'Data: read-only — nothing is saved.';

test.describe('[Responsive] Territory screens at narrow widths', () => {
  test.describe.configure({ timeout: 180_000 });

  test('TC_US089_79 — The list screen at 1699, 1499, 1279 and 767 px never scrolls the page horizontally', async ({ page, territoryListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_79', 'Medium', TAGS, `At every width the table stays visible inside the viewport; at 767 px the filter block reflows into two columns and the Country name clip tier drops to 150 px; at all four widths the page has no horizontal scrollbar while the table container scrolls horizontally (min-width 920 px). Not automated: the top-bar secondary / account information (steps 1–2) and the sidebar slide-out with hamburger and backdrop (step 3) — the app shell was not recon'd and its locators are not verified. ${DATA}`);
    const obs = new Observations(page);
    const widths = [1699, 1499, 1279, 767];
    let narrow = { sameRow: false, nextRow: false, nameWidth: 0 };

    const at = async (width: number) => {
      await page.setViewportSize({ width, height: HEIGHT });
      await list.open();
    };

    await step('Arrange: Pre-condition 1–3 — Logged in; seeded register; breakpoints from the prototype', async () => {
      await list.open();
    });

    await step('Act: Step 1 — Set the window width to 1699 px', async () => {
      await at(1699);
    });

    await step('Assert: Expected 1 — The layout shrinks and the table stays readable (top-bar secondary info: Not automated)', async () => {
      await expect(list.table, '[Expected 1] The table is visible').toBeVisible();
      expect(await isWithinViewportWidth(list.tableContainer, page), '[Expected 1] The table container fits the window').toBe(true);
      test.info().annotations.push({ type: 'Not automated', description: 'Expected 1: the hidden secondary information of the top bar (app shell not recon\'d)' });
    });

    await step('Act: Step 2 — Set the width to 1499 px and look at the top navigation bar', async () => {
      await at(1499);
    });

    await step('Assert: Expected 2 — The account information of the top bar is hidden (Not automated)', async () => {
      await expect(list.table, 'The table is still visible').toBeVisible();
      test.info().annotations.push({ type: 'Not automated', description: 'Expected 2: top-bar account information (app shell not recon\'d)' });
    });

    await step('Act: Step 3 — Set the width to 1279 px and look at the left sidebar', async () => {
      await at(1279);
    });

    await step('Assert: Expected 3 — The sidebar turns into a slide-out panel with a hamburger (Not automated)', async () => {
      await expect(list.table, 'The table is still visible').toBeVisible();
      test.info().annotations.push({ type: 'Not automated', description: 'Expected 3: sidebar slide-out, hamburger and backdrop (app shell not recon\'d)' });
    });

    await step('Act: Step 4 — Set the width to 767 px and look at the filter block and the Country clip width', async () => {
      await at(767);
      await list.setCriteria({ keyword: 'GS' });
      await list.search();
      const [search, vat, exp] = [await list.searchInput.boundingBox(), await list.vatSelect.boundingBox(), await list.exportSelect.boundingBox()];
      narrow = {
        sameRow: !!search && !!vat && Math.abs(search.y - vat.y) < 2,
        nextRow: !!search && !!exp && exp.y > search.y + search.height,
        nameWidth: (await list.countryName(list.row('GS')).boundingBox())?.width ?? 0,
      };
    });

    await step('Assert: Expected 4 — Two-column filter block; the Country clip tier drops to 150 px', async () => {
      expect(narrow.sameRow, '[Expected 4] Country and VAT treatment share the first row (two columns)').toBe(true);
      expect(narrow.nextRow, '[Expected 4] Export declaration wraps to the next row').toBe(true);
      expect(await isWithinViewportWidth(list.searchInput, page), '[Expected 4] The inputs stay inside the window').toBe(true);
      expect(narrow.nameWidth, '[Expected 4] The Country name is clipped at the 150 px tier').toBeGreaterThan(0);
      expect(narrow.nameWidth, '[Expected 4] The Country name is clipped at the 150 px tier').toBeLessThanOrEqual(150.5);
    });

    await step('Act: Step 5 — At all four widths check the page and the table-container horizontal scrollbars', async () => {
      for (const width of widths) {
        await at(width);
        await obs.record(`${width}px: the page has no horizontal scrollbar`, async () => !(await hasHorizontalPageScroll(page)));
        await obs.record(`${width}px: the table container scrolls horizontally (min-width 920 px)`, () => scrollsInside(list.tableContainer, 'x'));
        await obs.screenshot(`${width}px list`);
      }
    });

    await step('Assert: Expected 5 — No page scrollbar at any width; the table container has its own', async () => {
      obs.assertAll();
    });
  });

  test('TC_US089_80 — The edit screen and both dialogs at 1279 and 767 px never scroll the page horizontally', async ({ page, territoryState, territoryEditPage: edit }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_80', 'Medium', TAGS, 'At 1279 px the JP edit form fits and both footer buttons stay visible and clickable; the Apply this change? dialog is 520 px wide and does not overflow; the history dialog is 860 px wide with the table scrolling inside its container; at 767 px both dialogs are exactly window − 32 px; no page scrollbar on any screen. Data: JP is prepared to its TC flags if another user changed them and restored in teardown; nothing is saved (the confirmation is left with Back).');
    const obs = new Observations(page);
    const widths: Record<string, number> = {};
    let tableScrolls = false;
    const measure = async (tag: string) => {
      widths[`${tag} confirm`] = Math.round((await edit.confirmDialog.content.boundingBox())?.width ?? 0);
      await obs.record(`${tag}: the confirmation content does not overflow`, async () => !(await isClipped(edit.confirmDialog.content)));
      await obs.record(`${tag}: the confirmation fits the window`, () => isWithinViewportWidth(edit.confirmDialog.content, page));
      await obs.record(`${tag} edit + confirmation: no page horizontal scrollbar`, async () => !(await hasHorizontalPageScroll(page)));
      await obs.screenshot(`${tag} confirmation dialog`);
    };
    const openConfirm = async () => {
      await edit.exportCheckbox.uncheck();
      await edit.reasonInput.fill('Check the dialogs at a narrow viewport');
      await edit.openConfirm();
    };
    const openHistory = async (tag: string) => {
      await edit.click(edit.historyButton, '변경 이력 (Change history) button');
      await edit.historyDialog.waitLoaded();
      widths[`${tag} history`] = Math.round((await edit.historyDialog.content.boundingBox())?.width ?? 0);
      await obs.record(`${tag} history: the dialog fits the window`, () => isWithinViewportWidth(edit.historyDialog.content, page));
      await obs.record(`${tag} edit + history: no page horizontal scrollbar`, async () => !(await hasHorizontalPageScroll(page)));
      await obs.screenshot(`${tag} history dialog`);
    };

    await step('Arrange: Pre-condition 1–3 — ADMIN; JP exists; breakpoints from the prototype', async () => {
      await territoryState.prepare('JP', NORMAL_FLAGS('JP'));
      await page.setViewportSize({ width: 1279, height: HEIGHT });
    });

    await step('Act: Step 1 — At 1279 px open the JP edit screen and look at the form and the footer', async () => {
      await edit.open('JP');
      await obs.record('1279px edit: no page horizontal scrollbar', async () => !(await hasHorizontalPageScroll(page)));
    });

    await step('Assert: Expected 1 — The fields fit and both footer buttons stay visible and clickable', async () => {
      expect(await isWithinViewportWidth(edit.reasonInput, page), '[Expected 1] The form fits the window').toBe(true);
      for (const [name, button] of [['목록으로', edit.backButton], ['저장', edit.saveButton]] as const) {
        await expect(button, `[Expected 1] ${name} is visible`).toBeVisible();
        expect(await isWithinViewportWidth(button, page), `[Expected 1] ${name} fits the window`).toBe(true);
      }
      await expect(edit.backButton, '[Expected 1] 목록으로 is clickable').toBeEnabled();
    });

    await step('Act: Step 2 — Change one flag, type the reason, click 저장 and measure the confirmation dialog', async () => {
      await openConfirm();
      await measure('1279px');
    });

    await step('Assert: Expected 2 — The confirmation dialog is 520 px wide and its content does not overflow', async () => {
      expect(widths['1279px confirm'], '[Expected 2] 520 px wide').toBe(520);
      expect(await isClipped(edit.confirmDialog.content), '[Expected 2] The content does not overflow').toBe(false);
    });

    await step('Act: Step 3 — Click Back, then open the history dialog and measure it', async () => {
      await edit.confirmDialog.back();
      await openHistory('1279px');
      tableScrolls = await scrollsInside(edit.historyDialog.tableScroller, 'x');
      await edit.historyDialog.close();
    });

    await step('Assert: Expected 3 — The history dialog is 860 px wide; its table scrolls inside its container', async () => {
      expect(widths['1279px history'], '[Expected 3] 860 px wide').toBe(860);
      expect.soft(tableScrolls, '[Expected 3] The history table scrolls horizontally inside its container (min-width 760 px)').toBe(true);
    });

    await step('Act: Step 4 — At 767 px repeat: the edit screen, the confirmation dialog, the history dialog', async () => {
      await page.setViewportSize({ width: 767, height: HEIGHT });
      await edit.open('JP');
      await obs.record('767px edit: no page horizontal scrollbar', async () => !(await hasHorizontalPageScroll(page)));
      await openConfirm();
      await measure('767px');
      await edit.confirmDialog.back();
      await openHistory('767px');
      await edit.historyDialog.close();
    });

    await step('Assert: Expected 4 — Both dialogs are exactly window − 32 px (735 px) and neither overflows', async () => {
      expect(widths['767px confirm'], '[Expected 4] Confirmation 767 − 32 = 735 px').toBe(735);
      expect(widths['767px history'], '[Expected 4] History 767 − 32 = 735 px').toBe(735);
    });

    await step('Act: Step 5 — At both widths and on all three screens check the page horizontal scrollbar', async () => {
      await page.setViewportSize({ width: 1920, height: 1080 });
    });

    await step('Assert: Expected 5 — No page horizontal scrollbar on any screen at either width', async () => {
      obs.assertAll();
    });
  });
});
