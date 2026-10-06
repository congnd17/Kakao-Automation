import { test, expect } from '@fixtures/receipt-reconciliation.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { RR_TEXT, currentPeriod, periodBounds } from '@utils/receipt-reconciliation.data';

/**
 * US020 — nhóm [List] chạy được trên dev (30/09). Nguồn TC: input/Test_Cases_US020_EN_v4.md.
 * Số liệu seed của TC (3 phiếu / 1 chứng từ, `BP-0001`) không tồn tại trên dev dùng chung → kỳ vọng số đếm lấy từ
 * `GET /reconciliation-groups/counts` lúc Arrange (cùng nguồn màn dùng). TC nói "the period" là khoảng ngày; UI tách
 * 기간* (tháng) và 입고일 기준 (khoảng ngày) → test chọn tháng rồi gõ khoảng ngày (Deviation ghi ở từng test).
 */
const TAGS = ['list', 'receipt-reconciliation'];
const DATA = 'Data: read-only — nothing is saved.';
const SUITE_PRE = 'Arrange: Pre-condition 1–3 — Logged in (every role is the same on the system), inventory period open, period rule seeded';
const PERIOD_DEVIATION = 'Deviation from TC: the TC calls the date range "the period"; the UI splits it into the 기간* month selector and the 입고일 기준 date range — the test picks the month and types the range.';

test.describe('[List] Receipt reconciliation — filters, banner, empty states', () => {
  test('TC_US020_040 — The ungrouped banner shows both counts correctly', async ({ page, reconApi, reconListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US020_040', 'Medium', TAGS, `The banner above the group table reads the ungrouped receipt and document counts of the period, each sentence on a line of its own. Deviation from TC: the TC seeds 3 receipts + 1 document; dev holds other figures (no US003 document) — the expected counts are read from GET /reconciliation-groups/counts. ${DATA}`);
    let counts = { ungroupedReceiptCount: 0, ungroupedDocumentCount: 0 };
    let lines: Array<{ text: string; display: string }> = [];

    await step(`${SUITE_PRE}; pre-condition 4 — ungrouped receipts / documents of ${currentPeriod()} read from the API`, async () => {
      counts = await reconApi.counts(currentPeriod());
      test.skip(counts.ungroupedReceiptCount + counts.ungroupedDocumentCount === 0, `No ungrouped receipt or document in ${currentPeriod()} on dev — the banner has nothing to report`);
    });

    await step('Act: Step 1 — Open 입고 대사 (Receipt reconciliation)', async () => {
      await list.open();
      lines = await list.bannerLines();
    });

    await step('Assert: Expected 1 — The banner renders both counts correctly, each sentence on its own line', async () => {
      await expect.soft(list.ungroupedBanner, '[Expected 1] The banner renders above the group table').toBeVisible();
      await expect.soft(list.ungroupedBanner, `[Expected 1] Receipts ${counts.ungroupedReceiptCount} and documents ${counts.ungroupedDocumentCount}`).toContainText(RR_TEXT.ungroupedBanner(counts.ungroupedReceiptCount, counts.ungroupedDocumentCount));
      expect.soft(lines.length, '[Expected 1] The banner holds at least one sentence line').toBeGreaterThan(0);
      for (const [index, line] of lines.entries()) {
        expect.soft(line.display, `[Expected 1] Sentence ${index + 1} sits on a line of its own`).toBe('block');
        expect.soft(line.text.match(/다\./g)?.length ?? 0, `[Expected 1] Line ${index + 1} holds exactly one sentence`).toBe(1);
      }
      const box = [await list.ungroupedBanner.boundingBox(), await list.groupTable.boundingBox()];
      expect(box[0] && box[1] && box[0].y < box[1].y, '[Expected 1] The banner sits above the group table').toBe(true);
    });
  });

  test('TC_US020_046 — From the list into Build group and out via Cancel — nothing is created', async ({ page, reconApi, reconListPage: list, reconBuildPage: build }) => {
    const step = makeStep(page);
    await tcMeta('TC_US020_046', 'Medium', TAGS, `The list opens, 대사 묶음 만들기 opens the build screen, and its back button (대사 묶음 목록으로 on the UI, 목록으로 in the TC) returns to the list with the group count of the period unchanged. Deviation from TC: pre-condition 4's collected document does not exist on dev — the flow does not select anything. ${DATA}`);
    let before = 0;

    await step(`${SUITE_PRE}; pre-condition 4 — group count of ${currentPeriod()} noted`, async () => {
      before = (await reconApi.counts(currentPeriod())).groupCount;
    });

    await step('Act: Step 1 — Open 입고 대사 (Receipt reconciliation)', async () => {
      await list.open();
    });

    await step('Assert: Expected 1 — The list opens', async () => {
      await expect(list.groupTable, '[Expected 1] The group list is visible').toBeVisible();
    });

    await step('Act: Step 2 — Click 대사 묶음 만들기 (Build group)', async () => {
      await list.openBuildGroup();
    });

    await step('Assert: Expected 2 — The build screen opens', async () => {
      await build.waitLoaded();
      await expect(build.createButton, '[Expected 2] The build screen shows 대사 묶음 생성 (Create group)').toBeVisible();
    });

    await step('Act: Step 3 — Click 목록으로 (Back to list)', async () => {
      await build.click(build.backButton, '대사 묶음 목록으로 (Back to list) button');
      await list.waitLoaded();
    });

    await step('Assert: Expected 3 — The screen returns to the list and no group is created', async () => {
      await expect.soft(page, '[Expected 3] The list address is shown again').toHaveURL(/\/receipt-reconciliation(\?.*)?$/);
      await expect.soft(list.groupTable, '[Expected 3] The group list is visible').toBeVisible();
      expect((await reconApi.counts(currentPeriod())).groupCount, '[Expected 3] No group is created').toBe(before);
    });
  });

  test('TC_US020_051 — Search refuses a period whose start is after its end, and the applied set is UNCHANGED', async ({ page, reconListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US020_051', 'Medium', TAGS, `Typing start 2026-09-30 and end 2026-09-01 then 검색 shows 종료일은 시작일보다 빠를 수 없습니다. and leaves the rows on screen unchanged. ${PERIOD_DEVIATION} ${DATA}`);
    let values: [string, string] = ['', ''];
    let rowsBefore: string[] = [];

    await step(SUITE_PRE, async () => {
      await expect(page, 'Session is open').not.toHaveURL(/login/);
    });

    await step('Act: Step 1 — Open 입고 대사 (Receipt reconciliation)', async () => {
      await list.open();
      rowsBefore = await list.groupRows.allInnerTexts();
    });

    await step('Assert: Expected 1 — The list opens', async () => {
      await expect(list.groupTable, '[Expected 1] The group list is visible').toBeVisible();
    });

    await step('Act: Step 2 — Enter start 2026-09-30 and end 2026-09-01', async () => {
      await list.enterPeriod('2026-09', '2026-09-30', '2026-09-01');
      values = await list.dateValues();
    });

    await step('Assert: Expected 2 — Both date fields take the values entered', async () => {
      expect.soft(values[0], '[Expected 2] Start date holds 2026-09-30').toBe('2026-09-30');
      expect(values[1], '[Expected 2] End date holds 2026-09-01').toBe('2026-09-01');
    });

    await step('Act: Step 3 — Click 검색 (Search)', async () => {
      await list.search();
    });

    await step('Assert: Expected 3 — The range message renders and the result set is UNCHANGED', async () => {
      await expect.soft(page.getByText(RR_TEXT.rangeInvalid), `[Expected 3] "${RR_TEXT.rangeInvalid}" renders`).toBeVisible();
      expect(await list.groupRows.allInnerTexts(), '[Expected 3] The rows on screen are unchanged').toEqual(rowsBefore);
    });
  });

  test('TC_US020_054 — The end-date picker cannot select a date before the start date (minDate)', async ({ page, reconListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US020_054', 'Medium', TAGS, `With start 2026-09-15, the end-date picker opens on September 2026 with days 1–14 disabled, days 15 onward selectable, and no way back to an earlier month. ${DATA}`);
    let start = '';
    let disabled: number[] = [];
    let enabled: number[] = [];

    await step(SUITE_PRE, async () => {
      await expect(page, 'Session is open').not.toHaveURL(/login/);
    });

    await step('Act: Step 1 — Open 입고 대사 (Receipt reconciliation)', async () => {
      await list.open();
    });

    await step('Assert: Expected 1 — The list opens', async () => {
      await expect(list.receivedFrom, '[Expected 1] The start date field is visible').toBeVisible();
    });

    await step('Act: Step 2 — Enter start 2026-09-15', async () => {
      await list.typeDate(list.receivedFrom, '2026-09-15', 'the start date field');
      start = await list.receivedFrom.inputValue();
    });

    await step('Assert: Expected 2 — The start field takes 2026-09-15', async () => {
      expect(start, '[Expected 2] Start date holds 2026-09-15').toBe('2026-09-15');
    });

    await step('Act: Step 3 — Open the end-date picker', async () => {
      await list.click(list.receivedTo, 'the end date field');
      await expect(list.datePicker, 'The end-date picker opens').toBeVisible();
      disabled = await list.disabledDaysInPicker();
      enabled = await list.enabledDaysInPicker();
    });

    await step('Assert: Expected 3 — Every date before 2026-09-15 is disabled', async () => {
      await expect.soft(list.pickerMonth, '[Expected 3] The picker shows September 2026').toHaveText('September 2026');
      expect.soft(disabled, '[Expected 3] Days 1–14 of September are disabled').toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
      expect.soft(enabled[0], '[Expected 3] The first selectable day is the 15th').toBe(15);
      await expect(list.previousMonthButton, '[Expected 3] No navigation back to an earlier month').toHaveCount(0);
    });
  });

  for (const tc of [
    { id: 'TC_US020_055', priority: 'Low' as const, title: 'A period with no group renders the Empty State', period: '2026-02' },
    { id: 'TC_US020_058', priority: 'Low' as const, title: 'An empty list renders `조회 결과가 없습니다.`', period: '2026-01' },
  ]) {
    test(`${tc.id} — ${tc.title}`, async ({ page, reconApi, reconListPage: list }) => {
      const step = makeStep(page);
      const { from, to } = periodBounds(tc.period);
      await tcMeta(tc.id, tc.priority, TAGS, `Searching ${from} → ${to} renders ${RR_TEXT.noRows} in the group table. ${PERIOD_DEVIATION} ${DATA}`);

      await step(`${SUITE_PRE}; pre-condition 4 — period ${tc.period} holds no group`, async () => {
        test.skip((await reconApi.counts(tc.period)).groupCount > 0, `Period ${tc.period} now holds a group on dev — the pre-condition "no group" does not hold`);
      });

      await step('Act: Step 1 — Open 입고 대사 (Receipt reconciliation)', async () => {
        await list.open();
      });

      await step('Assert: Expected 1 — The list opens', async () => {
        await expect(list.groupTable, '[Expected 1] The group list is visible').toBeVisible();
      });

      await step(`Act: Step 2 — Enter the period ${from} to ${to} and click 검색 (Search)`, async () => {
        await list.enterPeriod(tc.period, from, to);
        await list.search();
      });

      await step(`Assert: Expected 2 — The group table renders ${RR_TEXT.noRows}`, async () => {
        await expect(list.noRowsMessage, `[Expected 2] "${RR_TEXT.noRows}" (No results.) renders in the group table`).toHaveText(RR_TEXT.noRows);
      });
    });
  }

  test('TC_US020_061 — The ungrouped banner counts by PERIOD and is NOT narrowed by the filter date range', async ({ page, reconApi, reconListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US020_061', 'Medium', TAGS, `Searching 2026-09-01 → 2026-09-10 narrows the group table to that range while the banner keeps the counts of the whole period. Deviation from TC: the TC seeds 3 receipts (09-02 / 09-15 / 09-28) + 1 document — dev figures are read from GET /reconciliation-groups/counts. ${PERIOD_DEVIATION} ${DATA}`);
    const period = currentPeriod();
    let banner = '';
    let rowsInRange: string[] = [];

    await step(`${SUITE_PRE}; pre-condition 4–5 — ungrouped receipts of ${period} read from the API`, async () => {
      const counts = await reconApi.counts(period);
      test.skip(counts.ungroupedReceiptCount === 0, `No ungrouped receipt in ${period} on dev — the banner has nothing to report`);
      banner = RR_TEXT.ungroupedBanner(counts.ungroupedReceiptCount, counts.ungroupedDocumentCount);
    });

    await step('Act: Step 1 — Open 입고 대사 (Receipt reconciliation)', async () => {
      await list.open();
    });

    await step('Assert: Expected 1 — The banner reads the receipt and document counts of the period', async () => {
      await expect(list.ungroupedBanner, `[Expected 1] Banner: ${banner}`).toContainText(banner);
    });

    await step(`Act: Step 2 — Enter the period ${period}-01 to ${period}-10 and click 검색 (Search)`, async () => {
      await list.enterPeriod(period, `${period}-01`, `${period}-10`);
      await list.search();
      rowsInRange = await list.groupRowTexts();
    });

    await step('Assert: Expected 2 — The table narrows to the range, the banner STILL reads the same counts', async () => {
      const inRange = (await reconApi.listGroups<{ paging: { totalCount: number } }>({ period, receivedFrom: `${period}-01`, receivedTo: `${period}-10`, page: '0', size: '10' })).body.paging.totalCount;
      expect.soft(rowsInRange.length, '[Expected 2] The group table holds only the groups of the date range').toBe(Math.min(inRange, 10));
      await expect(list.ungroupedBanner, `[Expected 2] The banner still reads: ${banner}`).toContainText(banner);
    });
  });

  test('TC_US020_062 — The ungrouped banner is NOT narrowed by the biz-partner filter', async ({ page, reconApi, reconListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US020_062', 'Medium', TAGS, `Typing one partner code and searching narrows the group table to that partner while the banner keeps the counts of the whole period. Deviation from TC: BP-0001 and the 3-partner seed do not exist on dev — the code is the biz-partner id of a real ungrouped receipt, counts come from GET /reconciliation-groups/counts. ${DATA}`);
    const period = currentPeriod();
    let banner = '';
    let partnerCode = '';
    let rows: string[] = [];

    await step(`${SUITE_PRE}; pre-condition 4–5 — ungrouped receipts of ${period} and one of their partners`, async () => {
      const counts = await reconApi.counts(period);
      const receipt = (await reconApi.buildReceipts(period)).find((candidate) => candidate.selectable);
      test.skip(counts.ungroupedReceiptCount === 0 || !receipt, `No ungrouped receipt in ${period} on dev`);
      banner = RR_TEXT.ungroupedBanner(counts.ungroupedReceiptCount, counts.ungroupedDocumentCount);
      partnerCode = String(receipt?.bizPartnerId);
    });

    // TC có 2 dòng Steps nhưng 1 dòng Expected (kết quả sau Step 2) → Step 1 không có Assert riêng.
    await step('Act: Step 1 — Open 입고 대사 (Receipt reconciliation)', async () => {
      await list.open();
      await expect(list.ungroupedBanner, `Banner before filtering: ${banner}`).toContainText(banner);
    });

    await step(`Act: Step 2 — Type ${partnerCode} into the 비즈파트너 (Biz partner) field and click 검색 (Search)`, async () => {
      await list.typePartner(partnerCode);
      await list.search();
      rows = await list.groupRowTexts();
    });

    await step(`Assert: Expected 1 — Only groups of ${partnerCode} are listed, the banner STILL reads the same counts`, async () => {
      const partnerGroups = (await reconApi.listGroups<{ paging: { totalCount: number } }>({ period, keyword: partnerCode, page: '0', size: '10' })).body.paging.totalCount;
      expect.soft(rows.length, '[Expected 1] The group table holds only the groups of the typed partner').toBe(Math.min(partnerGroups, 10));
      await expect(list.ungroupedBanner, `[Expected 1] The banner still reads: ${banner}`).toContainText(banner);
    });
  });

  test('TC_US020_063 — An empty list renders `불일치 항목이 없습니다.`', async ({ page, reconApi, reconListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US020_063', 'Low', TAGS, `With no open mismatch line in the period, the 불일치 목록 table renders ${RR_TEXT.noMismatches}. Deviation from TC: pre-condition 4's Matched group cannot be built on dev (no US003 document) — only pre-condition 5 (no open mismatch) matters for the expectation. ${DATA}`);
    const period = currentPeriod();

    await step(`${SUITE_PRE}; pre-condition 5 — ${period} holds no open mismatch line`, async () => {
      test.skip((await reconApi.counts(period)).openMismatchCount > 0, `${period} holds open mismatch lines on dev — pre-condition 5 does not hold`);
    });

    await step('Act: Step 1 — Open 입고 대사 (Receipt reconciliation)', async () => {
      await list.open();
    });

    await step('Assert: Expected 1 — The list opens', async () => {
      await expect(list.mismatchesTab, '[Expected 1] The list opens with the 불일치 목록 tab').toBeVisible();
    });

    await step('Act: Step 2 — Open the 불일치 목록 (Mismatches) tab', async () => {
      await list.openMismatches();
    });

    await step(`Assert: Expected 2 — The table renders ${RR_TEXT.noMismatches}`, async () => {
      await expect(list.mismatchTable, `[Expected 2] "${RR_TEXT.noMismatches}" (No mismatches.) renders`).toContainText(RR_TEXT.noMismatches);
    });
  });
});
