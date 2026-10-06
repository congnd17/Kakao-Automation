import { test, expect } from '@fixtures/territory.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { TERRITORY_TEXT, NORMAL_FLAGS, parseCounter, pickSeededCountry } from '@utils/territory.data';

/**
 * US089 — nhóm [History] chỉ đọc: dialog không có thao tác trên dòng, 3 cách đóng, trạng thái rỗng.
 * Dev dùng chung có người khác sửa (29/09): JP được đưa về cờ TC (Required) qua `territoryState` và khôi phục ở teardown;
 * quốc gia "chưa từng sửa" chọn lúc chạy (`pickSeededCountry`).
 */
const TAGS = ['history', 'territory'];
const EN = TERRITORY_TEXT.en;
const DATA = 'Data: read-only.';

test.describe('[History] Territory change-history dialog', () => {
  test.describe.configure({ timeout: 120_000 });

  test('TC_US089_75 — The dialog offers no row action and all three closing methods return to the same list state', async ({ page, territoryState, territoryListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_75', 'Medium', TAGS, `With the list on page 2 and Export declaration = Required, the JP dialog has no edit / delete / action control, a double-click enters no inline edit, and Close, Esc and a click on the overlay each close it keeping page 2 and the filter. Deviation: page 2 is taken at 100 rows per page so that it holds JP. Data: JP is put back to Required if another user changed it and restored in teardown; nothing else is written.`);
    const state = async () => ({ from: parseCounter(((await list.counter.textContent()) ?? '').trim())?.from, filter: await list.exportSelect.inputValue() });
    const expected = { from: 101, filter: 'true' };
    let closed = { esc: false, overlay: false };

    await step('Arrange: Pre-condition 1–3 — The list is on page 2 with Export declaration = Required', async () => {
      await territoryState.prepare('JP', NORMAL_FLAGS('JP'));
      await list.open();
      await list.setCriteria({ exportFlag: 'true' });
      await list.search();
      await list.setPageSize('100');
      await list.goToPage('2');
      await expect(list.row('JP'), 'Pre-condition: JP is on page 2 of the Required result').toHaveCount(1);
    });

    await step('Act: Step 1 — Open the JP dialog and scan each history row for controls', async () => {
      await list.openHistory(list.row('JP'));
    });

    await step('Assert: Expected 1 — No edit, delete, action icon or hidden menu on any row', async () => {
      await expect(list.historyDialog.editableControls(), '[Expected 1] No control inside the history table').toHaveCount(0);
    });

    await step('Act: Step 2 — Double-click a cell of the history table', async () => {
      await list.historyDialog.rows.first().locator('td').first().dblclick();
    });

    await step('Assert: Expected 2 — No inline edit mode; the cell stays static text', async () => {
      await expect(list.historyDialog.editableControls(), '[Expected 2] No input appeared').toHaveCount(0);
    });

    await step('Act: Step 3 — Click Close and look at the screen behind', async () => {
      await list.historyDialog.close();
    });

    await step('Assert: Expected 3 — The list is still on page 2 with Export declaration at Required', async () => {
      expect(await state(), '[Expected 3] Same page and filter').toEqual(expected);
    });

    await step('Act: Step 4 — Reopen the dialog from the JP row and press Esc', async () => {
      await list.openHistory(list.row('JP'));
      closed.esc = await list.historyDialog.closeByEscape();
    });

    await step('Assert: Expected 4 — Esc closes the dialog like Close; same page and filter', async () => {
      expect(closed.esc, '[Expected 4] Esc closes the dialog').toBe(true);
      expect(await state(), '[Expected 4] Same page and filter').toEqual(expected);
    });

    await step('Act: Step 5 — Reopen the dialog and click on the dimmed overlay outside it', async () => {
      if (!closed.esc) await list.historyDialog.close();
      await list.openHistory(list.row('JP'));
      closed = { ...closed, overlay: await list.historyDialog.closeByOverlay() };
    });

    await step('Assert: Expected 5 — The overlay click closes the dialog; same page and filter', async () => {
      expect(closed.overlay, '[Expected 5] Clicking outside closes the dialog').toBe(true);
      expect(await state(), '[Expected 5] Same page and filter').toEqual(expected);
    });
  });

  test('TC_US089_76 — A never-edited country shows the no-changes message with the headers still visible', async ({ page, territoryApi, territoryListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_76', 'Medium', TAGS, `With the English interface the dialog of a never-edited country (VN) shows "${EN.historyEmptyTitle}" and "${EN.historyEmptyBody}", the five headers When / Who / Setting / Change / Reason stay visible, and its row reads Seeded default in Last updated. Deviation: VN was edited by another user on the shared dev (29/09) — when VN no longer carries its seeded values the first country that still does is used (the code is noted in the report). ${DATA}`);
    let lastUpdated = '';
    let code = '';

    await step('Arrange: Pre-condition 1–2 — Logged in; a never-edited country', async () => {
      code = (await pickSeededCountry(territoryApi)).countryCode;
      test.info().annotations.push({ type: 'Country used for "never edited"', description: code });
      expect(await territoryApi.history(code), 'Pre-condition: the country has no history record').toHaveLength(0);
      await list.open('en');
      await list.setCriteria({ keyword: code });
      await list.search();
    });

    await step('Act: Step 1 — Click the Change history link on the never-edited row', async () => {
      await list.openHistory(list.row(code));
    });

    await step('Assert: Expected 1 — The Change history dialog opens for that country', async () => {
      await expect(list.historyDialog.subtitle, '[Expected 1] The dialog is for that country').toContainText(code);
    });

    await step('Act: Step 2 — Read the dialog body', async () => {
      await list.historyDialog.empty.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — "No changes yet" then the seeded sentence', async () => {
      await expect(list.historyDialog.empty, '[Expected 2] First line No changes yet').toContainText(EN.historyEmptyTitle);
      await expect(list.historyDialog.empty, '[Expected 2] Second line').toContainText(EN.historyEmptyBody);
    });

    await step('Act: Step 3 — Look at the column header area', async () => {
      await list.historyDialog.table.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — All five headers are still visible', async () => {
      for (const [i, name] of EN.historyColumns.entries()) {
        await expect(list.historyDialog.headers.nth(i), `[Expected 3] Header ${name} is visible`).toBeVisible();
        await expect(list.historyDialog.headers.nth(i), `[Expected 3] Header ${i + 1} is ${name}`).toHaveText(name);
      }
    });

    await step('Act: Step 4 — Close the dialog and read Last updated on the never-edited row', async () => {
      await list.historyDialog.close();
      lastUpdated = ((await list.cell(list.row(code), 'updated').locator('span').first().textContent()) ?? '').trim();
    });

    await step('Assert: Expected 4 — The row shows Seeded default', async () => {
      expect(lastUpdated, '[Expected 4] Last updated reads Seeded default').toBe(EN.seeded);
    });
  });
});
