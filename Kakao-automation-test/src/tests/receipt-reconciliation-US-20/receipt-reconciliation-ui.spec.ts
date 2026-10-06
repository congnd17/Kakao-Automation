import { test, expect } from '@fixtures/receipt-reconciliation.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { GROUP_COLUMNS, STATUS_OPTIONS, currentPeriod, kstToday, minusMonths, recentPeriods } from '@utils/receipt-reconciliation.data';

/**
 * US020 — nhóm [UI] chạy được trên dev (30/09). Nguồn TC: input/Test_Cases_US020_EN_v4.md
 * (Steps N / Expected N → `Act: Step N` / `Assert: Expected N`). Kỳ vọng assert theo TC; chỗ UI khác TC ghi trong description.
 * Pre-condition chung của suite (kỳ tồn kho `2026-09` Open do US093 seed, luật kỳ ở US064) là trạng thái môi trường —
 * không có màn nào để kiểm, gộp 1 step Arrange. Màn không có mục sidebar (verify 30/09) → mở bằng URL.
 */
const TAGS = ['ui', 'receipt-reconciliation'];
const DATA = 'Data: read-only — nothing is saved.';
const SUITE_PRE = 'Arrange: Pre-condition 1–3 — Logged in (every role is the same on the system), inventory period open, period rule seeded';

test.describe('[UI] Receipt reconciliation — layout and labels', () => {
  test('TC_US020_016 — The Inventory ledger menu group shows the correct EN and KO labels', async ({ page, reconListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US020_016', 'Medium', TAGS, `The sidebar holds a 재고 원장 (Inventory ledger) group whose items are 입고 대사 then 재고 수불부, in that order. Observed on dev 30/09: the sidebar has no 재고 원장 group — the screen is reachable by URL only. ${DATA}`);
    let children: string[] = [];

    await step(SUITE_PRE, async () => {
      await list.open();
    });

    await step('Act: Step 1 — Open the 재고 원장 (Inventory ledger) menu group', async () => {
      await expect(list.menuGroup('재고 원장'), '[Step 1] The sidebar holds a 재고 원장 (Inventory ledger) menu group').toBeVisible();
      await list.click(list.menuGroup('재고 원장'), '재고 원장 (Inventory ledger) menu group');
      children = await list.menuChildren('재고 원장');
    });

    await step('Assert: Expected 1 — The group shows 입고 대사 and 재고 수불부, in that order', async () => {
      expect(children, '[Expected 1] The group lists exactly 입고 대사 (Receipt reconciliation) then 재고 수불부 (Inventory ledger list)').toEqual(['입고 대사', '재고 수불부']);
    });
  });

  test('TC_US020_017 — The group list shows all 9 columns in the correct order', async ({ page, reconApi, reconListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US020_017', 'Medium', TAGS, `The 입고 대사 목록 table header reads period · group no. · biz partner · receipts · documents · SKU lines · mismatches · difference · status (대사 기간 … 상태). Deviation from TC: pre-condition 4 (a Matched group) cannot be built on dev when no US003 document exists — the header row does not depend on it, so the case runs with or without a group. ${DATA}`);
    let headers: string[] = [];

    await step(`${SUITE_PRE}; pre-condition 4 — groups of the current period read from the API`, async () => {
      expect((await reconApi.counts(currentPeriod())).groupCount, 'The group count of the current period is readable').toBeGreaterThanOrEqual(0);
    });

    await step('Act: Step 1 — Open 입고 대사 (Receipt reconciliation)', async () => {
      await list.open();
      headers = (await list.groupHeaders.allTextContents()).map((text) => text.trim());
    });

    await step('Assert: Expected 1 — The table shows all 9 columns in order', async () => {
      await expect(list.groupTable, '[Expected 1] The 입고 대사 목록 (Reconciliation groups) table is visible').toBeVisible();
      for (const [index, name] of GROUP_COLUMNS.entries()) {
        expect.soft(headers[index], `[Expected 1] Column ${index + 1} is ${name}`).toBe(name);
      }
      expect(headers, '[Expected 1] Exactly 9 columns').toHaveLength(9);
    });
  });

  test('TC_US020_018 — Both tabs, Groups and Mismatches, render with a count badge', async ({ page, reconListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US020_018', 'Medium', TAGS, `Two tabs render — 대사 묶음 (Groups) and 불일치 목록 (Mismatches) — each with a numeric count badge. Observed on dev 30/09: the groups tab is labelled 입고 대사 목록, not 대사 묶음 (asserted as the TC names it). ${DATA}`);

    await step(SUITE_PRE, async () => {
      await expect(page, 'Session is open').not.toHaveURL(/login/);
    });

    await step('Act: Step 1 — Open 입고 대사 (Receipt reconciliation)', async () => {
      await list.open();
    });

    await step('Assert: Expected 1 — Two tabs 대사 묶음 and 불일치 목록 render, each with a count badge', async () => {
      await expect.soft(list.tab('대사 묶음'), '[Expected 1] A tab named 대사 묶음 (Groups) renders').toBeVisible();
      await expect.soft(list.mismatchesTab, '[Expected 1] The 불일치 목록 (Mismatches) tab renders').toContainText('불일치 목록');
      await expect.soft(list.groupsBadge, '[Expected 1] The groups tab carries a numeric count badge').toHaveText(/^\d+$/);
      await expect(list.mismatchesBadge, '[Expected 1] The mismatches tab carries a numeric count badge').toHaveText(/^\d+$/);
    });
  });

  test('TC_US020_019 — The six quick-range buttons fill the fields only and do not run the query', async ({ page, reconListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US020_019', 'Medium', TAGS, `The list opens with empty filters; 1개월 fills both date fields with the last month (today minus one month → today, KST) and sends no group query. Deviation from TC: the TC calls the date range the 기간 (Period) filter — on the UI it is 입고일 기준, next to a separate 기간* month selector. ${DATA}`);
    const groupQueries: string[] = [];
    let filled: [string, string] = ['', ''];

    await step(SUITE_PRE, async () => {
      await expect(page, 'Session is open').not.toHaveURL(/login/);
    });

    await step('Act: Step 1 — Open 입고 대사 (Receipt reconciliation)', async () => {
      await list.open();
    });

    await step('Assert: Expected 1 — The list opens with empty filters', async () => {
      await expect.soft(list.receivedFrom, '[Expected 1] Start date is empty').toHaveValue('');
      await expect.soft(list.receivedTo, '[Expected 1] End date is empty').toHaveValue('');
      await expect.soft(list.partnerInput, '[Expected 1] Biz partner is empty').toHaveValue('');
      expect(await list.selectedOption(list.statusSelect), '[Expected 1] Status is the all-value').toBe(STATUS_OPTIONS[0]);
    });

    await step('Act: Step 2 — Click the 1-month quick-range button', async () => {
      page.on('request', (request) => {
        if (request.url().includes('/reconciliation-groups?')) groupQueries.push(request.url());
      });
      await list.quickRange('1개월');
      await page.waitForLoadState('networkidle');
      filled = await list.dateValues();
    });

    await step('Assert: Expected 2 — Both date fields hold the last month and the group table is NOT reloaded', async () => {
      const today = kstToday();
      expect.soft(filled[0], '[Expected 2] Start date = today minus one month').toBe(minusMonths(today, 1));
      expect.soft(filled[1], '[Expected 2] End date = today').toBe(today);
      expect(groupQueries, '[Expected 2] No group query is sent — the results stay as they were').toEqual([]);
    });
  });

  test('TC_US020_020 — The status filter lists all six values in lifecycle order', async ({ page, reconListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US020_020', 'Medium', TAGS, `The 상태 (Status) dropdown lists exactly six values: 전체 first, then 대사 전 · 일치 · 불일치 · 해결됨 · 마감됨. ${DATA}`);
    let options: string[] = [];

    await step(SUITE_PRE, async () => {
      await expect(page, 'Session is open').not.toHaveURL(/login/);
    });

    await step('Act: Step 1 — Open 입고 대사 (Receipt reconciliation)', async () => {
      await list.open();
    });

    await step('Assert: Expected 1 — The list opens', async () => {
      await expect(list.groupTable, '[Expected 1] The group table is visible').toBeVisible();
    });

    await step('Act: Step 2 — Open the 상태 (Status) filter', async () => {
      await list.statusSelect.click();
      options = (await list.optionTexts(list.statusSelect)).map((text) => text.trim());
    });

    await step('Assert: Expected 2 — Exactly six values: the all-value, then the five statuses in lifecycle order', async () => {
      for (const [index, name] of STATUS_OPTIONS.entries()) {
        expect.soft(options[index], `[Expected 2] Option ${index + 1} is ${name}`).toBe(name);
      }
      expect(options, '[Expected 2] Exactly six values').toHaveLength(6);
    });
  });

  test('TC_US020_024 — The build screen shows two tables — ungrouped receipts and ungrouped documents', async ({ page, reconApi, reconListPage: list, reconBuildPage: build }) => {
    const step = makeStep(page);
    await tcMeta('TC_US020_024', 'Medium', TAGS, `The build screen shows 미대사 입고 전표 (with a 창고 column) and 미대사 증빙. Deviation from TC: pre-condition 4 needs 1 collected US003 document — dev holds none (the receipts exist). Not automated: "a document with conflicting figures shows 서로 다른 금액으로 두 번 업로드됨 in place of its checkbox" — no such document exists on dev. ${DATA}`);
    let receiptHeaders: string[] = [];

    await step(`${SUITE_PRE}; pre-condition 4 — ungrouped COMPLETE receipts of the current period`, async () => {
      const selectable = (await reconApi.buildReceipts(currentPeriod())).filter((receipt) => receipt.selectable);
      test.skip(selectable.length === 0, `No ungrouped COMPLETE receipt in ${currentPeriod()} on dev`);
    });

    await step('Act: Step 1 — Open 입고 대사 (Receipt reconciliation)', async () => {
      await list.open();
    });

    await step('Assert: Expected 1 — The list opens', async () => {
      await expect(list.buildGroupButton, '[Expected 1] The list opens with the Build group button').toBeVisible();
    });

    await step('Act: Step 2 — Click 대사 묶음 만들기 (Build group)', async () => {
      await list.openBuildGroup();
      await build.waitLoaded();
      receiptHeaders = (await build.receiptHeaders.allTextContents()).map((text) => text.trim());
    });

    await step('Assert: Expected 2 — Two tables 미대사 입고 전표 and 미대사 증빙; the receipt table carries a 창고 column', async () => {
      await expect.soft(build.receiptsHeading, '[Expected 2] 미대사 입고 전표 (Unreconciled receipts) table heading').toBeVisible();
      await expect.soft(build.receiptTable, '[Expected 2] The unreconciled receipts table is visible').toBeVisible();
      await expect.soft(build.documentsHeading, '[Expected 2] 미대사 증빙 (Unreconciled documents) table heading').toBeVisible();
      await expect.soft(build.documentTable, '[Expected 2] The unreconciled documents table is visible').toBeVisible();
      expect(receiptHeaders, '[Expected 2] The receipt table carries a 창고 (Warehouse) column').toContain('창고');
    });
  });

  test('TC_US020_033 — The period selector lists exactly 12 months, and an older month carried in the URL shows as one extra option', async ({ page, reconListPage: list, reconBuildPage: build }) => {
    const step = makeStep(page);
    await tcMeta('TC_US020_033', 'Medium', TAGS, `The 기간 selector lists the 12 months up to the current KST month, newest first; opening with period=2025-06 in the URL adds 2025-06 as one extra selected option; the Build group selector lists the same 12 months. Deviation from TC: pre-condition 4 fixes "today" in 2026-09 — the expected months are computed from the current KST month. ${DATA}`);
    const twelve = recentPeriods(12);
    let listOptions: string[] = [];
    let urlOptions: string[] = [];
    let urlSelected = '';
    let buildOptions: string[] = [];

    await step(`${SUITE_PRE}; pre-condition 4 — today falls in ${currentPeriod()}`, async () => {
      expect(twelve[0], 'The newest expected month is the current KST month').toBe(currentPeriod());
    });

    await step('Act: Step 1 — Open 입고 대사 (Receipt reconciliation)', async () => {
      await list.open();
    });

    await step('Assert: Expected 1 — The list opens', async () => {
      await expect(list.periodSelect, '[Expected 1] The 기간 (Period) selector is visible').toBeVisible();
    });

    await step('Act: Step 2 — Open 기간 (Period) on the filter bar', async () => {
      await list.periodSelect.click();
      listOptions = await list.optionTexts(list.periodSelect);
    });

    await step('Assert: Expected 2 — Exactly 12 yyyy-MM months, newest first', async () => {
      expect(listOptions, `[Expected 2] The 12 months ${twelve[0]} … ${twelve[11]}, newest first`).toEqual(twelve);
    });

    await step('Act: Step 3 — Reopen the screen from a URL carrying period=2025-06 and open 기간 (Period)', async () => {
      await list.open('?period=2025-06');
      urlOptions = await list.optionTexts(list.periodSelect);
      urlSelected = await list.selectedOption(list.periodSelect);
    });

    await step('Assert: Expected 3 — The same 12 months plus 2025-06 as one extra, selected option', async () => {
      expect.soft(urlOptions.filter((option) => option !== '2025-06'), '[Expected 3] The same 12 months are listed').toEqual(twelve);
      expect.soft(urlOptions.filter((option) => option === '2025-06'), '[Expected 3] 2025-06 appears exactly once as the extra option').toHaveLength(1);
      expect(urlSelected, '[Expected 3] 2025-06 is currently selected').toBe('2025-06');
    });

    await step('Act: Step 4 — Open 대사 묶음 만들기 (Build group) and open 기간 (Period)', async () => {
      await list.openBuildGroup();
      await build.waitLoaded();
      buildOptions = await build.periodOptions();
    });

    await step('Assert: Expected 4 — The same 12 months as the list selector', async () => {
      expect(buildOptions, '[Expected 4] One list for every period selector — the same 12 months').toEqual(twelve);
    });
  });
});
