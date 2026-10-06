import { test, expect } from '@fixtures/receipt-reconciliation.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { hasHorizontalPageScroll } from '@utils/layout';
import { GROUP_COLUMNS } from '@utils/receipt-reconciliation.data';

/**
 * US020 — nhóm [Responsive] chạy được trên dev (30/09): màn danh sách nhóm ở 1920×1080 và 1366×768, zoom 100%.
 * Các TC responsive của màn chi tiết / overlay (279–282) nằm trong blocked spec — chưa dựng được nhóm nào.
 * Pre-condition 4 (nhóm RG-2026-09-0007) không dựng được khi dev chưa có chứng từ US003 → chạy với bảng hiện có.
 */
const TAGS = ['responsive', 'receipt-reconciliation'];
const DATA = 'Data: read-only — nothing is saved.';
const DEVIATION = 'Deviation from TC: pre-condition 4 (a Matched group) cannot be built on dev when no US003 document exists — the layout is measured on the table as it is.';

test.describe('[Responsive] Receipt reconciliation — group list', () => {
  test('TC_US020_277 — The group list at 1920x1080 has no page-level horizontal scroll', async ({ page, reconListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US020_277', 'Medium', TAGS, `At 1920×1080 (100% zoom) the group table shows all 9 columns and the page has no horizontal scrollbar. ${DEVIATION} ${DATA}`);
    let headers: string[] = [];
    let pageScroll = true;

    await step('Arrange: Pre-condition 1–5 — Logged in, period seeded, window 1920×1080 at 100% zoom', async () => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      expect(page.viewportSize(), 'The window is 1920×1080').toEqual({ width: 1920, height: 1080 });
    });

    await step('Act: Step 1 — Open 입고 대사 (Receipt reconciliation)', async () => {
      await list.open();
      headers = (await list.groupHeaders.allTextContents()).map((text) => text.trim());
      pageScroll = await hasHorizontalPageScroll(page);
    });

    await step('Assert: Expected 1 — All 9 columns are shown and the page has NO horizontal scrollbar', async () => {
      for (const name of GROUP_COLUMNS) {
        await expect.soft(list.groupHeaders.filter({ hasText: name }).first(), `[Expected 1] Column ${name} is visible`).toBeVisible();
      }
      expect.soft(headers, '[Expected 1] All 9 columns are present').toHaveLength(9);
      expect(pageScroll, '[Expected 1] No horizontal scrollbar at page level').toBe(false);
    });
  });

  test('TC_US020_278 — The group list at 1366x768 has no page-level horizontal scroll', async ({ page, reconListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US020_278', 'Medium', TAGS, `At 1366×768 (100% zoom) the page has no horizontal scrollbar. ${DEVIATION} ${DATA}`);
    let pageScroll = true;

    await step('Arrange: Pre-condition 1–5 — Logged in, period seeded, window 1366×768 at 100% zoom', async () => {
      await page.setViewportSize({ width: 1366, height: 768 });
      expect(page.viewportSize(), 'The window is 1366×768').toEqual({ width: 1366, height: 768 });
    });

    await step('Act: Step 1 — Open 입고 대사 (Receipt reconciliation)', async () => {
      await list.open();
      pageScroll = await hasHorizontalPageScroll(page);
    });

    await step('Assert: Expected 1 — The page has NO horizontal scrollbar at page level', async () => {
      expect(pageScroll, '[Expected 1] No horizontal scrollbar at page level').toBe(false);
    });
  });
});
