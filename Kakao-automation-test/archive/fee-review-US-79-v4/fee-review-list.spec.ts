import { test, expect } from '@fixtures/fee-review.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { FR_EN, FR_KO } from '@utils/fee-review.i18n';
import { CYCLE, CLOSED_CYCLE, EMPTY_OPEN_CYCLE, OLDEST_OPEN_CYCLE, FIXTURE, RATE_MOVING, autoReason, baseline, movingCategory } from '@utils/fee-review.data';
import type { FeeReviewListPage } from '@pages/fee-review.page';
import type { Bucket, FeeReviewApi, FeeReviewPage, Problem } from '@api/fee-review.api';

/**
 * US079 — nhóm [List]: cycle, tìm kiếm, chip, phân nhóm bucket, cột trạng thái / đối chiếu, empty state, nhãn cập nhật.
 * Fixture T079 trong cycle 2026-10 thay cho seed prototype (Deviation chung — `@utils/fee-review.data`). Assert theo TC.
 */
const TAGS = ['list', 'fee-review'];
const DEV = `Deviation: the TC's prototype seed does not exist on dev — the T079 fixture with the same scenario in cycle ${CYCLE.label} is used (see fee-review.data.ts).`;
const READ = 'Data: read-only.';
const SCOPE = ['bucket.EXC', 'bucket.NC', 'bucket.PROV', 'bucket.FIXED', 'bucket.OK'] as const;

/** 10 chip tóm tắt: 기간 내 판매 상품 + 5 bucket phạm vi + 4 chip theo loại vấn đề. */
const ALL_CHIPS = ['bucket.ALL', ...SCOPE, 'bucket.NF', 'bucket.AMB', 'bucket.DIFF', 'bucket.SRCDIFF'] as const;
type ChipKey = (typeof ALL_CHIPS)[number];
/** Chip → tham số lọc của GET products (cùng endpoint màn hình gọi). */
const CHIP_QUERY: Record<ChipKey, { bucket?: Bucket; problem?: Problem }> = {
  'bucket.ALL': {},
  'bucket.EXC': { bucket: 'NEEDS_REVIEW' },
  'bucket.NC': { bucket: 'NOT_COMPUTABLE' },
  'bucket.PROV': { bucket: 'PROVISIONAL' },
  'bucket.FIXED': { bucket: 'CORRECTED_THIS_PERIOD' },
  'bucket.OK': { bucket: 'RESOLVED_CLEANLY' },
  'bucket.NF': { problem: 'NO_ROW' },
  'bucket.AMB': { problem: 'AMBIGUOUS' },
  'bucket.DIFF': { problem: 'ASSIGNED_NE_RESOLVED' },
  'bucket.SRCDIFF': { problem: 'SOURCE_NEEDS_FIXING' },
};
/** Chip → số đếm API trả cho cả cycle. */
const CHIP_COUNT: Record<ChipKey, (p: FeeReviewPage) => number> = {
  'bucket.ALL': (p) => p.buckets.total,
  'bucket.EXC': (p) => p.buckets.needsReview,
  'bucket.NC': (p) => p.buckets.notComputable,
  'bucket.PROV': (p) => p.buckets.provisional,
  'bucket.FIXED': (p) => p.buckets.correctedThisPeriod,
  'bucket.OK': (p) => p.buckets.resolvedCleanly,
  'bucket.NF': (p) => p.problems.noRow,
  'bucket.AMB': (p) => p.problems.ambiguous,
  'bucket.DIFF': (p) => p.problems.assignedNeResolved,
  'bucket.SRCDIFF': (p) => p.problems.sourceNeedsFixing,
};

const uniq = (ids: string[]): string[] => [...new Set(ids)].sort();
const esc = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Mọi mã sản phẩm trong bucket đang chọn (trang 100 dòng). */
async function idsOf(list: FeeReviewListPage): Promise<string[]> {
  await list.setPageSize('100');
  return list.productIds();
}

/** Số trên cả 10 chip. */
async function chipCounts(list: FeeReviewListPage): Promise<Record<ChipKey, number>> {
  const counts = {} as Record<ChipKey, number>;
  for (const key of ALL_CHIPS) counts[key] = await list.chipCount(list.chip(key));
  return counts;
}

/** Mã sản phẩm (không trùng) API trả cho 1 tổ hợp chip + từ khoá — baseline đọc lúc chạy, không viết cứng. */
async function apiIds(api: FeeReviewApi, key: ChipKey, keyword?: string): Promise<string[]> {
  return uniq((await api.products(CYCLE.id, { ...CHIP_QUERY[key], keyword })).content.map((r) => r.productId));
}

/** Tổng trên pager "총 N개의 상품 중 a-b개 표시"; cycle rỗng không vẽ pager → trả null. */
async function pagerTotal(list: FeeReviewListPage): Promise<number | null> {
  if (!(await list.counter.count())) return null;
  return Number(/(\d+)/.exec(await list.counter.innerText())?.[1] ?? NaN);
}

test.describe('[List] Settlement fee review list', () => {
  // Baseline P14 đọc lúc chạy — fixture dùng chung bị lệch (30/09), không viết cứng danh mục.
  const P14 = { original: undefined as string | undefined, moving: '', other: '' };
  test.beforeEach(async ({ feeReviewApi }) => {
    Object.assign(P14, await baseline(feeReviewApi, FIXTURE.forSave));
  });

  test.describe.configure({ timeout: 150_000 });

  test('TC_US079_17 — The screen opens on the oldest open cycle with Needs review selected and the row count equals the product count', async ({ page, feeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_17', 'High', TAGS, `A fresh navigation selects the oldest open cycle and the 확인 필요 chip, and the pagination total equals the product count of the cycle (read through the API instead of US008's set). Deviation: on dev the oldest open cycle is ${OLDEST_OPEN_CYCLE.label} (the TC names 2026-08). Deviation: the pager counts the rows of the selected chip (확인 필요), so on a cycle with data it can differ from the product count — the TC assertion is kept; an empty cycle draws no pager and is read as 0. Not automated: "every listed product has at least one sale line in the set" — US008's settlement-target set is not readable from this suite. ${READ}`);
    let oldest = '';
    let expectedTotal = 0;
    let shownTotal: number | null = null;

    await step('Arrange: Pre-condition 1–2 — Write grant; the open cycles are read', async () => {
      const cycles = await feeReviewApi.cycles();
      oldest = cycles.filter((c) => c.status === 'OPEN').map((c) => c.label).sort()[0];
      const id = cycles.find((c) => c.label === oldest)?.cycleId ?? 0;
      expectedTotal = (await feeReviewApi.products(id)).buckets.total;
    });

    await step('Act: Step 1 — Open the screen with no prior state and read the cycle selector', async () => {
      await list.open();
    });

    await step('Assert: Expected 1 — The oldest open cycle is selected by default', async () => {
      await expect(list.cycleSelect.locator('option:checked'), `[Expected 1] ${oldest} is selected`).toHaveText(oldest);
    });

    await step('Act: Step 2 — Read the selected bucket chip', async () => {
      await list.chip('bucket.EXC').scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — 확인 필요 (Needs review) is selected', async () => {
      await expect(list.chip('bucket.EXC'), '[Expected 2] 확인 필요 is pressed').toHaveAttribute('aria-pressed', 'true');
    });

    await step("Act: Step 3 — Read the pagination total and compare it against the cycle's product count", async () => {
      shownTotal = await pagerTotal(list);
      if (shownTotal === null) test.info().annotations.push({ type: 'Observed', description: `No pager is drawn on ${oldest} — read as 0` });
    });

    await step('Assert: Expected 3 — The pagination total equals the product count of the cycle', async () => {
      expect(shownTotal ?? 0, '[Expected 3] The pagination total equals the cycle product count').toBe(expectedTotal);
    });
  });

  test('TC_US079_18 — Changing the cycle re-runs the query, redraws the buckets, toggles the provisional banner and changes no cycle status', async ({ page, feeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_18', 'Medium', TAGS, `Switching from the open ${CYCLE.label} to the closed ${CLOSED_CYCLE.label} re-runs the query without Search and redraws every chip; the provisional banner disappears for the closed cycle and returns for the open one; the closed cycle stays CLOSED. Deviation: dev's closed cycle ${CLOSED_CYCLE.label} holds no data (the TC names 2026-07 with data). Each of the ten chips is compared with the API count of the new cycle. ${READ}`);
    let before = {} as Record<ChipKey, number>;
    let after = {} as Record<ChipKey, number>;
    let closedApi: FeeReviewPage;
    let requests = 0;
    let bannerClosed = -1;

    await step('Arrange: Pre-condition 1–2 — An open and a closed cycle exist', async () => {
      closedApi = await feeReviewApi.products(CLOSED_CYCLE.id);
      await list.open({ cycleId: CYCLE.id });
      before = await chipCounts(list);
    });

    await step(`Act: Step 1 — Switch the cycle selector to ${CLOSED_CYCLE.label}`, async () => {
      page.on('request', (r) => {
        if (/\/fee-review\/cycles\/\d+\/products\?/.test(r.url())) requests += 1;
      });
      await list.selectCycle(CLOSED_CYCLE.label);
      after = await chipCounts(list);
    });

    await step('Assert: Expected 1 — The query re-runs immediately and every bucket count is redrawn', async () => {
      expect(requests, '[Expected 1] The list query re-ran without pressing Search').toBeGreaterThan(0);
      for (const key of ALL_CHIPS) expect.soft(after[key], `[Expected 1] ${FR_KO[key]} is redrawn for ${CLOSED_CYCLE.label}`).toBe(CHIP_COUNT[key](closedApi));
      expect(after, '[Expected 1] The chip counts are redrawn for the new cycle').not.toEqual(before);
    });

    await step('Act: Step 2 — Note the bucket counts and the provisional banner before and after (closed, then the open cycle reselected)', async () => {
      bannerClosed = await list.provisionalBanner.count();
      await list.selectCycle(CYCLE.label);
    });

    await step('Assert: Expected 2 — The banner is gone for the closed cycle and back for the open one', async () => {
      expect(bannerClosed, '[Expected 2] No provisional banner on the closed cycle').toBe(0);
      await expect(list.provisionalBanner, '[Expected 2] The banner returns on the open cycle').toBeVisible();
    });

    await step(`Act: Step 3 — Back on ${CYCLE.label}, re-select ${CLOSED_CYCLE.label} and check its own status after the visit`, async () => {
      await list.selectCycle(CLOSED_CYCLE.label);
    });

    await step('Assert: Expected 3 — The closed cycle is still closed, not reopened by this screen', async () => {
      expect((await feeReviewApi.cycles()).find((c) => c.cycleId === CLOSED_CYCLE.id)?.status, '[Expected 3] Still CLOSED').toBe('CLOSED');
      await expect(list.resolvedAtLabel, '[Expected 3] The screen still reads the cycle as closed').toHaveText(FR_KO['lbl.resolvedAtClosed']);
    });
  });

  test('TC_US079_19 — The cycle selector stores the cycle identifier and not the displayed YYYY-MM label, and a correction saved in that cycle is keyed to it', async ({ page, feeReviewApi, feeReviewState, feeReviewPage: list }) => {
    const step = makeStep(page);
    const reason = autoReason('TC_US079_19', 'keyed to the selected cycle');
    await tcMeta('TC_US079_19', 'High', TAGS, `A correction saved on ${FIXTURE.forSave} while ${CYCLE.label} is selected is keyed to that cycle's identifier: after it is submitted it shows on ${CYCLE.label}'s Changes this period, disappears on ${CLOSED_CYCLE.label}'s and reappears only when ${CYCLE.label} is reselected. Deviations: no same-rate category exists on dev, so a rate-moving category is used and the draft is submitted (a draft is not listed on the report); the cycle identifier is also checked on the API request. ${DEV} Data: the correction is withdrawn and discarded in teardown.`);
    let requestCycle = '';

    await step('Arrange: Pre-condition 1–2 — The open cycle is selected; the product is listed', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      page.on('request', (r) => {
        const m = /\/fee-review\/cycles\/(\d+)\/products\/[^/]+\/corrections$/.exec(r.url());
        if (m && r.method() === 'POST') requestCycle = m[1];
      });
    });

    await step('Act: Step 1 — Open 수정, pick a category, type a reason and save while the cycle is selected', async () => {
      await list.openCorrect(list.row(FIXTURE.forSave));
      await list.correct.pickCategory(P14.moving);
      await list.correct.reasonInput.fill(reason);
      expect((await list.correct.save()).status(), 'The save succeeds').toBeLessThan(300);
      const id = await feeReviewState.trackRow(feeReviewApi, FIXTURE.forSave, 'NORMAL', P14.original);
      if (id) await feeReviewApi.submit([id]);
    });

    await step(`Assert: Expected 1 — The correction saves against ${CYCLE.label}`, async () => {
      expect(requestCycle, '[Expected 1] Saved against the selected cycle identifier').toBe(String(CYCLE.id));
    });

    await step('Act: Step 2 — Confirm on the change report that the correction is keyed to this cycle', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await list.openReport();
      await list.report.showLatest();
    });

    await step('Assert: Expected 2 — Listed on this cycle; gone on another cycle; back only when this cycle is reselected', async () => {
      const mine = list.report.rows.filter({ hasText: reason.slice(0, 40) });
      await expect(mine, `[Expected 2] Listed on ${CYCLE.label}`).toHaveCount(1);
      await list.report.close();
      await list.selectCycle(CLOSED_CYCLE.label);
      await list.openReport();
      await list.report.showLatest();
      await expect(mine, `[Expected 2] Not listed on ${CLOSED_CYCLE.label}`).toHaveCount(0);
      await list.report.close();
      await list.selectCycle(CYCLE.label);
      await list.openReport();
      await list.report.showLatest();
      await expect(mine, `[Expected 2] Listed again once ${CYCLE.label} is reselected`).toHaveCount(1);
      await list.report.close();
    });
  });

  test('TC_US079_20 — All four search conditions match on command only and Reset clears the criteria, returns to Needs review and re-runs the query', async ({ page, feeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_20', 'Medium', TAGS, `Typing changes nothing until Search; product name, product ID, fee category and contract each narrow the list; Reset clears everything, returns to 확인 필요 and re-runs the query. Deviation: dev has no search-condition dropdown (only the keyword box — asserted softly), so every step types into the keyword box and "the search condition is cleared" is not automated; the TC's Lightstick / 900318 / BM매입_응원봉 / C-001 are replaced by fixture values (annex / ${FIXTURE.promotionWins} / the annex product's in-force category read at run time / the P02 contract id). ${READ}`);
    let before: string[] = [];
    let contractId = '';
    let category = '';
    let rerunStatus = 0;
    const results: Record<number, string[]> = {};

    await step('Arrange: Pre-condition 1–2 — The open cycle lists the fixtures', async () => {
      contractId = String((await feeReviewApi.trace(CYCLE.id, FIXTURE.resolvedAnnex)).body.basisContractId ?? '');
      // Danh mục đang hiệu lực của P02 đọc lúc chạy — fixture dùng chung bị lệch (01/10: 팬클럽 키트 → 음반).
      category = (await feeReviewApi.row(CYCLE.id, FIXTURE.resolvedAnnex)).inForceCategory ?? '';
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await list.setPageSize('100');
      before = await list.productIds();
    });

    await step('Act: Step 1 — Condition 상품명, type "annex" without pressing Search', async () => {
      await expect.soft(list.searchConditionSelect, 'The search-condition dropdown exists').toHaveCount(1);
      await list.keywordInput.fill('annex row wins');
    });

    await step('Assert: Expected 1 — The list does not change while typing', async () => {
      expect(await list.productIds(), '[Expected 1] Still the unfiltered set').toEqual(before);
    });

    await step('Act: Step 2 — Press 검색 (Search)', async () => {
      await list.untilListed(() => list.searchButton.click());
      results[2] = uniq(await list.productIds());
    });

    await step('Assert: Expected 2 — Only the product whose name matches is shown', async () => {
      expect(results[2], '[Expected 2] Only the annex product').toEqual([FIXTURE.resolvedAnnex]);
    });

    const conditions: Array<[number, string, string, (ids: string[]) => void]> = [
      [3, FIXTURE.promotionWins, 'Condition 상품ID, type the product ID, press Search', (ids) => expect(ids, '[Expected 3] Only that product').toEqual([FIXTURE.promotionWins])],
      [4, category, `Condition 수수료 카테고리, type ${category}, press Search`, (ids) => expect(ids, '[Expected 4] Products under that category, including the annex product').toContain(FIXTURE.resolvedAnnex)],
      [5, contractId, 'Condition 계약, type the contract, press Search', (ids) => expect(ids, '[Expected 5] Products under that contract').toContain(FIXTURE.resolvedAnnex)],
    ];
    for (const [n, keyword, title, check] of conditions) {
      await step(`Act: Step ${n} — ${title}`, async () => {
        await list.search(keyword);
        results[n] = uniq(await list.productIds());
      });
      await step(`Assert: Expected ${n} — The list narrows on that condition`, async () => {
        check(results[n]);
      });
    }

    await step('Act: Step 6 — Click 초기화 (Reset)', async () => {
      const relisted = page.waitForResponse((r) => r.request().method() === 'GET' && /\/fee-review\/cycles\/\d+\/products\?/.test(r.url()));
      await list.reset();
      rerunStatus = (await relisted).status();
    });

    await step('Assert: Expected 6 — Criteria cleared, bucket back to 확인 필요, list re-run', async () => {
      await expect(list.keywordInput, '[Expected 6] Keyword cleared').toHaveValue('');
      await expect(list.chip('bucket.EXC'), '[Expected 6] Bucket back to 확인 필요').toHaveAttribute('aria-pressed', 'true');
      expect(rerunStatus, '[Expected 6] The list query re-ran successfully').toBeLessThan(300);
    });
  });

  test('TC_US079_21 — A keyword combines with a bucket chip and switching the cycle keeps both applied', async ({ page, feeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_21', 'Medium', TAGS, `With keyword "T079" applied, every matching product is listed; per BR-UI-1.V3 (SRS v1.8, closes SPEC-GAP-22) clicking 적용 행 없음 shows only the products matching both the keyword and the bucket and does not clear the keyword; switching the cycle and back keeps the keyword and the chip, and the list does not revert to the unfiltered view. The expected product sets are read from the API at run time. ${DEV} "T079" replaces "SMBM". ${READ}`);
    const keyword = 'T079';
    let expectedKeyword: string[] = [];
    let expectedBoth: string[] = [];
    let afterSearch: string[] = [];
    let afterChip: string[] = [];
    let afterSwitch: string[] = [];

    await step('Arrange: Pre-condition 1–2 — The open cycle lists mismatch and no-row products', async () => {
      expectedKeyword = await apiIds(feeReviewApi, 'bucket.ALL', keyword);
      expectedBoth = await apiIds(feeReviewApi, 'bucket.NF', keyword);
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step(`Act: Step 1 — Type "${keyword}" and press Search`, async () => {
      await list.search(keyword);
      afterSearch = uniq(await idsOf(list));
    });

    await step(`Assert: Expected 1 — Every product whose name contains ${keyword} is listed`, async () => {
      // P99 không có tên (—) nhưng mã chứa T079 → kiểm "mã + tên" chứa từ khoá.
      for (const text of await list.rows.evaluateAll((trs) => trs.map((tr) => `${tr.children[1]?.textContent ?? ''} ${tr.children[2]?.textContent ?? ''}`))) expect(text, `[Expected 1] The product matches ${keyword}`).toContain(keyword);
      expect(afterSearch, `[Expected 1] Every product matching ${keyword} is listed`).toEqual(expectedKeyword);
    });

    await step('Act: Step 2 — Click 적용 행 없음 while the keyword is still applied', async () => {
      await list.clickChip(list.chip('bucket.NF'));
      afterChip = uniq(await idsOf(list));
    });

    await step('Assert: Expected 2 — Per BR-UI-1.V3 only products matching both the keyword and the bucket are shown; the keyword is not cleared', async () => {
      await expect(list.keywordInput, '[Expected 2] The keyword is not cleared').toHaveValue(keyword);
      await expect(list.chip('bucket.NF'), '[Expected 2] The 적용 행 없음 chip is applied').toHaveAttribute('aria-pressed', 'true');
      expect(afterChip, '[Expected 2] Only the products matching both the keyword and 적용 행 없음').toEqual(expectedBoth);
    });

    await step('Act: Step 3 — Switch the cycle away and back without clearing the keyword or the chip', async () => {
      await list.selectCycle(CLOSED_CYCLE.label);
      await list.selectCycle(CYCLE.label);
      afterSwitch = uniq(await idsOf(list));
    });

    await step('Assert: Expected 3 — The keyword and the chip are still applied; the list does not revert to the unfiltered view', async () => {
      await expect(list.keywordInput, '[Expected 3] The keyword is still applied').toHaveValue(keyword);
      await expect(list.chip('bucket.NF'), '[Expected 3] The chip is still applied').toHaveAttribute('aria-pressed', 'true');
      expect(afterSwitch, '[Expected 3] The list still matches both the keyword and the chip').toEqual(expectedBoth);
    });
  });

  test('TC_US079_22 — Changing the page and the rows-per-page applies immediately', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_22', 'Medium', TAGS, `On the 13-product cycle (기간 내 판매 상품): 20개 reflows immediately to all rows; back at 10개 the next page shows the remaining rows immediately. ${DEV} ${READ}`);
    let firstPage: string[] = [];

    await step('Arrange: Pre-condition 1–2 — The cycle holds more products than one 10-row page', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL', pageSize: '10' });
      firstPage = await list.productIds();
      expect(firstPage, 'Pre-condition: a full first page').toHaveLength(10);
    });

    await step('Act: Step 1 — Change 페이지당 from 10개 to 20개', async () => {
      await list.setPageSize('20');
    });

    await step('Assert: Expected 1 — The list reflows to the new page size immediately', async () => {
      expect((await list.productIds()).length, '[Expected 1] More than 10 rows now').toBeGreaterThan(10);
    });

    await step('Act: Step 2 — Back to 10개, click the next-page control', async () => {
      await list.setPageSize('10');
      await list.goToPage('Next');
    });

    await step("Assert: Expected 2 — The next page's rows are shown immediately", async () => {
      const second = await list.productIds();
      expect(second.length, '[Expected 2] The second page has rows').toBeGreaterThan(0);
      expect(second.some((id) => firstPage.includes(id)) && second.every((id) => firstPage.includes(id)), '[Expected 2] Different rows from page 1').toBe(false);
    });
  });

  test('TC_US079_23 — The five buckets after the total add up to the total and no product appears in two of them', async ({ page, feeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_23', 'High', TAGS, `기간 내 판매 상품 shows the cycle total (compared with the API product count read at run time); 확인 필요 + 구간형 요율 — 산정 전 + 잠정 적용 + 이번 기 수정됨 + 정상 equals it; no product ID appears in two of the five buckets. ${DEV} ${READ}`);
    let apiTotal = 0;
    let total = 0;
    let sum = 0;
    const seen = new Map<string, string>();
    const duplicates: string[] = [];

    await step('Arrange: Pre-condition 1–2 — The open cycle with its full set', async () => {
      apiTotal = (await feeReviewApi.products(CYCLE.id)).buckets.total;
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Read the 기간 내 판매 상품 total', async () => {
      total = await list.chipCount(list.chip('bucket.ALL'));
    });

    await step('Assert: Expected 1 — The total product count of the cycle', async () => {
      expect(total, '[Expected 1] A total is displayed').toBeGreaterThan(0);
      expect(total, '[Expected 1] 기간 내 판매 상품 equals the product count of the cycle').toBe(apiTotal);
    });

    await step('Act: Step 2 — Read the five buckets and sum them', async () => {
      for (const key of SCOPE) sum += await list.chipCount(list.chip(key));
    });

    await step('Assert: Expected 2 — The five buckets sum to the total', async () => {
      expect(sum, '[Expected 2] Sum of the five buckets equals the total').toBe(total);
    });

    await step('Act: Step 3 — Open each of the five buckets and list their products', async () => {
      for (const key of SCOPE) {
        await list.clickChip(list.chip(key));
        for (const id of await idsOf(list)) {
          if (seen.has(id) && seen.get(id) !== key) duplicates.push(`${id} in ${seen.get(id)} and ${key}`);
          seen.set(id, key);
        }
      }
    });

    await step('Assert: Expected 3 — No product appears in more than one of the five buckets', async () => {
      expect(duplicates, '[Expected 3] No product in two buckets').toEqual([]);
    });
  });

  test('TC_US079_24 — Each product lands in the first bucket whose condition it meets', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_24', 'High', TAGS, `Not computable ${FIXTURE.notComputable} (26010), needs-review ${FIXTURE.ambiguous} (900318's role), corrected ${FIXTURE.approvedTwoPolicies} (900190), resolved cleanly ${FIXTURE.resolvedAnnex} (900412) each land in their own bucket and nowhere else. Not automated: step 4 (Provisional) — no provisional product on dev. ${DEV} ${READ}`);
    const where: Record<string, string[]> = {};
    const collect = async () => {
      for (const key of SCOPE) {
        await list.clickChip(list.chip(key));
        for (const id of await idsOf(list)) where[id] = [...(where[id] ?? []), key];
      }
    };

    await step('Arrange: Pre-condition 1–2 — The cycle holds one product of each scenario', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await collect();
    });

    const cases: Array<[number, string, (typeof SCOPE)[number] | null, string]> = [
      [1, FIXTURE.notComputable, 'bucket.NC', 'Not computable yet'],
      [2, FIXTURE.ambiguous, 'bucket.EXC', 'Needs review'],
      [3, FIXTURE.approvedTwoPolicies, 'bucket.FIXED', 'Corrected this period'],
      [4, '', null, 'Provisional'],
      [5, FIXTURE.resolvedAnnex, 'bucket.OK', 'Resolved cleanly'],
    ];
    for (const [n, id, key, name] of cases) {
      await step(`Act: Step ${n} — Open ${name} and look for ${id || 'the provisional product'}`, async () => {
        if (!key) test.info().annotations.push({ type: 'Not automated', description: `Step ${n}: no provisional product on dev` });
      });
      await step(`Assert: Expected ${n} — ${id || 'The provisional product'} lands in ${name} and nowhere else`, async () => {
        if (key) expect([...new Set(where[id] ?? [])], `[Expected ${n}] ${id} only in ${FR_KO[key]}`).toEqual([key]);
      });
    }
  });

  test('TC_US079_25 — A product whose correction was rejected needs review again and is not also counted as corrected', async ({ page, feeReviewApi, approverFeeReviewApi, feeReviewState, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_25', 'High', TAGS, `A correction on ${FIXTURE.forSave} submitted and rejected by the approver account puts the product back in 확인 필요 and not in 이번 기 수정됨. ${DEV} The rejected correction is created through the API. Data: the rejected correction is discarded in teardown.`);
    let needs: string[] = [];

    await step('Arrange: Pre-condition 1–2 — The product carries a correction already Rejected', async () => {
      const { approval } = await feeReviewState.pending(feeReviewApi, FIXTURE.forSave, RATE_MOVING, autoReason('TC_US079_25', 'to be rejected'));
      expect((await approverFeeReviewApi.reject(approval.id, autoReason('TC_US079_25', 'rejected for the bucket check'))).status, 'The approver rejects').toBeLessThan(300);
      await list.open({ cycleId: CYCLE.id });
    });

    await step('Act: Step 1 — Open 확인 필요 and look for the product', async () => {
      needs = await idsOf(list);
    });

    await step('Assert: Expected 1 — The product appears in Needs review', async () => {
      expect(needs, '[Expected 1] In 확인 필요').toContain(FIXTURE.forSave);
    });

    await step('Act: Step 2 — Open 이번 기 수정됨 and look for it there too', async () => {
      await list.clickChip(list.chip('bucket.FIXED'));
    });

    await step('Assert: Expected 2 — It does not also appear in Corrected this period', async () => {
      expect(await idsOf(list), '[Expected 2] Not in 이번 기 수정됨').not.toContain(FIXTURE.forSave);
    });
  });

  test('TC_US079_26 — A provisional product and a corrected product are not counted as needing review', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_26', 'Medium', TAGS, `The corrected ${FIXTURE.approvedTwoPolicies} (900190) is not in 확인 필요. Not automated: the provisional half (870455) — no provisional product on dev. ${DEV} ${READ}`);
    let needs: string[] = [];

    await step('Arrange: Pre-condition 1–2 — A corrected product is present', async () => {
      await list.open({ cycleId: CYCLE.id });
      test.info().annotations.push({ type: 'Not automated', description: 'Provisional product: none on dev' });
    });

    await step('Act: Step 1 — Open 확인 필요 and look for the provisional and the corrected product', async () => {
      needs = await idsOf(list);
    });

    await step('Assert: Expected 1 — Neither appears in Needs review', async () => {
      expect(needs, '[Expected 1] The corrected product is excluded').not.toContain(FIXTURE.approvedTwoPolicies);
    });
  });

  test('TC_US079_27 — A Not computable product is not counted as needing review', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_27', 'High', TAGS, `${FIXTURE.notComputable} (Not computable, replaces 26010) never appears in 확인 필요. Not automated: step 2 (working every other reviewable product down to 0) — it would mean correcting the other testers' fixtures. ${DEV} ${READ}`);
    let needs: string[] = [];

    await step('Arrange: Pre-condition 1–2 — A Not computable product is present', async () => {
      await list.open({ cycleId: CYCLE.id });
    });

    await step('Act: Step 1 — Open 확인 필요 with the Not computable product present', async () => {
      needs = await idsOf(list);
    });

    await step('Assert: Expected 1 — The Not computable product never appears in Needs review', async () => {
      expect(needs, '[Expected 1] Not in 확인 필요').not.toContain(FIXTURE.notComputable);
    });

    await step('Act: Step 2 — Work through every other reviewable product (Not automated)', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Step 2: needs correcting every other shared fixture' });
    });

    await step('Assert: Expected 2 — 확인 필요 reaches 0 while the bracket product stays (Not automated)', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Expected 2: see Step 2' });
    });
  });

  test('TC_US079_29 — Selecting each of the ten buckets filters the list to exactly the products counted in it while the counts stay on the whole cycle', async ({ page, feeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    const keyword = 'annex';
    await tcMeta('TC_US079_29', 'Medium', TAGS, `With no keyword, clicking each of the ten chips shows as many rows as the chip counts and exactly the products the API lists for it; any 지정 없음 (Not assigned) product also lands in 지정 ↔ 산정 불일치. With keyword "${keyword}" applied the ten chip counts stay those of the whole cycle, while the row list narrows to products matching both the keyword and the selected chip (BR-UI-1.V3) — checked on 기간 내 판매 상품 and 확인 필요. Expected product sets are read from the API at run time. ${DEV} "${keyword}" replaces "Lightstick". ${READ}`);
    let baseline = {} as Record<ChipKey, number>;
    let filtered = {} as Record<ChipKey, number>;
    const shown = {} as Record<ChipKey, number>;
    const shownIds = {} as Record<ChipKey, string[]>;
    const expectedIds = {} as Record<ChipKey, string[]>;
    let notAssigned: string[] = [];
    let expectedAll: string[] = [];
    let expectedExc: string[] = [];
    let narrowedAll: string[] = [];
    let narrowedExc: string[] = [];

    await step('Arrange: Pre-condition 1–2 — The open cycle with its full set, no search condition applied', async () => {
      for (const key of ALL_CHIPS) expectedIds[key] = await apiIds(feeReviewApi, key);
      expectedAll = await apiIds(feeReviewApi, 'bucket.ALL', keyword);
      expectedExc = await apiIds(feeReviewApi, 'bucket.EXC', keyword);
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      baseline = await chipCounts(list);
      const compare = await list.rows.evaluateAll((trs) => trs.map((tr) => [tr.children[1]?.textContent?.trim() ?? '', tr.children[6]?.textContent?.trim() ?? '']));
      notAssigned = uniq(compare.filter(([, c]) => c === FR_KO['compare.NOT_ASSIGNED'] || c === FR_EN['compare.NOT_ASSIGNED']).map(([id]) => id));
    });

    await step('Act: Step 1 — With no keyword active, click each of the 10 chips and count the rows shown', async () => {
      for (const key of ALL_CHIPS) {
        await list.clickChip(list.chip(key));
        const ids = await idsOf(list);
        shown[key] = ids.length;
        shownIds[key] = uniq(ids);
      }
    });

    await step('Assert: Expected 1 — Each chip shows exactly the products it counts', async () => {
      for (const key of ALL_CHIPS) {
        expect.soft(shown[key], `[Expected 1] ${FR_KO[key]} shows ${baseline[key]} rows`).toBe(baseline[key]);
        expect.soft(shownIds[key], `[Expected 1] ${FR_KO[key]} shows exactly its products — no more, no fewer`).toEqual(expectedIds[key]);
      }
      expect.soft(notAssigned.filter((id) => !shownIds['bucket.DIFF'].includes(id)), '[Expected 1] Every 지정 없음 product also lands in 지정 ↔ 산정 불일치').toEqual([]);
    });

    await step(`Act: Step 2 — Apply keyword "${keyword}", press Search and read every chip count again`, async () => {
      await list.clickChip(list.chip('bucket.ALL'));
      await list.search(keyword);
      filtered = await chipCounts(list);
      narrowedAll = uniq(await idsOf(list));
      await list.clickChip(list.chip('bucket.EXC'));
      narrowedExc = uniq(await idsOf(list));
    });

    await step('Assert: Expected 2 — Chip counts are unaffected by the keyword; the rows match both the keyword and the selected chip', async () => {
      for (const key of ALL_CHIPS) expect.soft(filtered[key], `[Expected 2] ${FR_KO[key]} still counts the whole cycle`).toBe(baseline[key]);
      expect.soft(narrowedAll, `[Expected 2] 기간 내 판매 상품 + "${keyword}" lists only the matching products`).toEqual(expectedAll);
      expect.soft(narrowedExc, `[Expected 2] 확인 필요 + "${keyword}" lists only products matching both`).toEqual(expectedExc);
      await expect(list.keywordInput, '[Expected 2] The keyword stays applied when a chip is picked').toHaveValue(keyword);
    });
  });

  test('TC_US079_30 — The rate and category columns show a second line only while a correction has not taken effect', async ({ page, feeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_30', 'High', TAGS, `A product whose correction has not taken effect (${FIXTURE.mismatchWithDraft}, draft — replaces 880021 pending) shows the in-force value first and the proposed value dimmed on a second line in both cells; a product whose correction is applied (${FIXTURE.approvedTwoPolicies}, approved — replaces 900190) shows exactly one line in both cells of every policy row. The in-force primary value is read from the API at run time (not the TC's dash/5.60%/BM제작MD); the proposed value is checked as a non-empty value different from the in-force one (the API row does not expose the draft's proposal). ${DEV} ${READ}`);
    let inForce = { category: '—', rate: '—' };
    const lines: Record<'category' | 'rate', { primary: string; second: string }> = { category: { primary: '', second: '' }, rate: { primary: '', second: '' } };

    await step('Arrange: Pre-condition 1–2 — One correction not yet in effect, one already applied', async () => {
      const r = await feeReviewApi.row(CYCLE.id, FIXTURE.mismatchWithDraft);
      inForce = { category: r.inForceCategory ?? '—', rate: r.inForceRate ? `${r.inForceRate}%` : '—' };
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Read the category and rate cells of the not-yet-effective product', async () => {
      const row = list.row(FIXTURE.mismatchWithDraft);
      await row.scrollIntoViewIfNeeded();
      for (const col of ['category', 'rate'] as const) {
        const cell = list.cell(row, col);
        const second = (await list.secondLine(cell).count()) ? (await list.secondLine(cell).innerText()).trim() : '';
        lines[col] = { primary: (await cell.innerText()).replace(second, '').trim(), second };
      }
    });

    await step('Assert: Expected 1 — In-force value first; the proposed value dimmed with an arrow on a second line', async () => {
      const row = list.row(FIXTURE.mismatchWithDraft);
      for (const col of ['category', 'rate'] as const) {
        await expect(list.secondLine(list.cell(row, col)), `[Expected 1] ${col}: a dimmed second line with an arrow`).toHaveText(/^→ \S/);
        await expect(list.secondLine(list.cell(row, col)), `[Expected 1] ${col}: the second line is dimmed`).toHaveClass(/text-muted/);
        expect(lines[col].primary, `[Expected 1] ${col}: the in-force value ${inForce[col]} is the primary line`).toMatch(new RegExp(`^${esc(inForce[col])}`));
        expect(lines[col].second.replace(/^→\s*/, ''), `[Expected 1] ${col}: the second line carries the proposed value, not the in-force one`).not.toBe(inForce[col]);
      }
    });

    await step('Act: Step 2 — Read the same two cells of the applied product', async () => {
      await list.row(FIXTURE.approvedTwoPolicies).scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Exactly one line in each cell', async () => {
      const policyRows = await list.rows.filter({ has: page.getByRole('cell', { name: FIXTURE.approvedTwoPolicies, exact: true }) }).count();
      expect(policyRows, '[Expected 2] The applied product is listed').toBeGreaterThan(0);
      for (let i = 0; i < policyRows; i++) {
        for (const col of ['category', 'rate'] as const) await expect(list.secondLine(list.cell(list.row(FIXTURE.approvedTwoPolicies, i), col)), `[Expected 2] Row ${i + 1} ${col}: no second line`).toHaveCount(0);
      }
    });
  });

  test('TC_US079_31 — The status column stacks the resolution pill and, only with a correction, the correction-state pill', async ({ page, feeReviewApi, approverFeeReviewApi, feeReviewState, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_31', 'Medium', TAGS, `Resolution pills: 산정 완료 (${FIXTURE.resolvedAnnex}), 중복 적용 (${FIXTURE.ambiguous}), 적용 행 없음 (${FIXTURE.tier2Open}), 구간형 요율 — 산정 전 (${FIXTURE.notComputable}); products without a correction show one pill; correction pills: 승인됨 — 적용 (${FIXTURE.approvedTwoPolicies}), 승인 대기 (${FIXTURE.forSave}, created), 반려됨 — 수정 후 재상신 (${FIXTURE.promotionWins}, created and rejected). Deviations: no provisional product (잠정 적용 not automated); no same-rate correction, so 적용됨 (요율 변동 없음) is replaced by 승인됨 — 적용 on the approved fixture. ${DEV} Data: the pending and rejected corrections are cleaned up in teardown.`);

    await step('Arrange: Pre-condition 1–2 — One product per status; a pending and a rejected correction are created', async () => {
      await feeReviewState.pending(feeReviewApi, FIXTURE.forSave, RATE_MOVING, autoReason('TC_US079_31', 'pending pill'));
      const { approval } = await feeReviewState.pending(feeReviewApi, FIXTURE.promotionWins, RATE_MOVING, autoReason('TC_US079_31', 'to be rejected'), 'PROMOTION');
      await approverFeeReviewApi.reject(approval.id, autoReason('TC_US079_31', 'rejected pill'));
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await list.setPageSize('100');
    });

    await step('Act: Step 1 — Read the status column for one product of each resolution status', async () => {
      await list.row(FIXTURE.resolvedAnnex).scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — Each first pill reads exactly one resolution status', async () => {
      for (const [id, key] of [[FIXTURE.resolvedAnnex, 'status.RESOLVED'], [FIXTURE.ambiguous, 'status.AMBIGUOUS'], [FIXTURE.tier2Open, 'status.NO_ROW'], [FIXTURE.notComputable, 'status.NOT_COMPUTABLE']] as const) {
        await expect(list.statusPills(list.row(id)).first(), `[Expected 1] ${id} reads ${FR_KO[key]}`).toHaveText(FR_KO[key]);
      }
      test.info().annotations.push({ type: 'Not automated', description: 'Expected 1: 잠정 적용 — no provisional product on dev' });
    });

    await step('Act: Step 2 — Read the status column of products without a correction', async () => {
      await list.row(FIXTURE.tier2Open).scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Only the resolution pill, no second line', async () => {
      for (const id of [FIXTURE.resolvedAnnex, FIXTURE.tier2Open]) await expect(list.statusPills(list.row(id)), `[Expected 2] ${id}: one pill`).toHaveCount(1);
    });

    await step('Act: Step 3 — Read the second pill of the products carrying a correction', async () => {
      await list.row(FIXTURE.forSave).scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — 승인됨 — 적용 / 승인 대기 / 반려됨 — 수정 후 재상신', async () => {
      await expect(list.statusPills(list.row(FIXTURE.approvedTwoPolicies)).nth(1), '[Expected 3] Approved pill').toHaveText(FR_KO['state.APPROVED']);
      await expect(list.statusPills(list.row(FIXTURE.forSave)).nth(1), '[Expected 3] 승인 대기').toHaveText(FR_KO['state.PENDING']);
      await expect(list.statusPills(list.row(FIXTURE.promotionWins)).nth(1), '[Expected 3] 반려됨 — 수정 후 재상신').toHaveText(FR_KO['state.REJECTED']);
    });
  });

  test('TC_US079_32 — The rejection reason is not rendered in the status cell and is reachable from the pill tooltip', async ({ page, feeReviewApi, approverFeeReviewApi, feeReviewState, feeReviewPage: list }) => {
    const step = makeStep(page);
    const rejectReason = autoReason('TC_US079_32', '번들 구성품이 아니라 단품 판매 건입니다. 공연MD 유지해 주세요.');
    await tcMeta('TC_US079_32', 'Low', TAGS, `A rejected correction on ${FIXTURE.forSave} (replaces 900318) shows only the short pill in the status cell; hovering the pill shows the reject reason; History shows it in its own block. ${DEV} Data: the rejected correction is discarded in teardown.`);

    await step('Arrange: Pre-condition 1–2 — A correction rejected with a reason', async () => {
      const { approval } = await feeReviewState.pending(feeReviewApi, FIXTURE.forSave, RATE_MOVING, autoReason('TC_US079_32', 'to be rejected'));
      await approverFeeReviewApi.reject(approval.id, rejectReason);
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Read the status cell text', async () => {
      await list.row(FIXTURE.forSave).scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — Only the short pill text, no reason paragraph', async () => {
      await expect(list.cell(list.row(FIXTURE.forSave), 'status'), '[Expected 1] No reject reason inline').not.toContainText(rejectReason.slice(-20));
    });

    await step('Act: Step 2 — Hover the correction-state pill', async () => {
      await list.statusPills(list.row(FIXTURE.forSave)).nth(1).hover();
    });

    await step('Assert: Expected 2 — The tooltip shows the reject reason', async () => {
      await expect(list.tooltip, '[Expected 2] Tooltip carries the reject reason').toContainText(rejectReason.slice(-30));
    });

    await step('Act: Step 3 — Open 이력 (History)', async () => {
      await list.openHistory(list.row(FIXTURE.forSave));
    });

    await step('Assert: Expected 3 — History shows the reject reason in its own block', async () => {
      await expect(list.history.root.getByText(FR_KO['hist.rejectReason']), '[Expected 3] 반려 사유 block').toBeVisible();
      await expect(list.history.root, '[Expected 3] The reject reason text').toContainText(rejectReason.slice(-30));
      await list.history.close();
    });
  });

  test('TC_US079_33 — The assignment comparison reads Matches, Mismatch, Not assigned or a dash on fee-row identity, comparing only the slot whose policy matches the winning row', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_33', 'High', TAGS, `${FIXTURE.resolvedAnnex} reads 일치, ${FIXTURE.mismatchWithDraft} reads 불일치 with the assigned row shown in Why this rate, and ${FIXTURE.promotionWins}'s comparison is made on its 프로모션 slot only — the 기본 slot is not named in the compared block. Deviation: if the panel lists both slots, the "기본 not compared" assertion fails and needs BA confirmation. ${DEV} ${READ}`);

    await step('Arrange: Pre-condition 1–2 — Matching, mismatching and promotion-winning products', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Read the 지정 대조 column of the three products', async () => {
      await list.row(FIXTURE.promotionWins).scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — The matching product reads 일치 (same fee row)', async () => {
      await expect(list.cell(list.row(FIXTURE.resolvedAnnex), 'compare'), '[Expected 1] 일치 (Matches)').toHaveText(FR_KO['compare.MATCHES']);
    });

    await step('Assert: Expected 2 — The mismatching product reads 불일치 and its assigned row is shown in the reason panel', async () => {
      await expect(list.cell(list.row(FIXTURE.mismatchWithDraft), 'compare'), '[Expected 2] 불일치 (Mismatch)').toHaveText(FR_KO['compare.MISMATCH']);
      await list.openBasis(list.row(FIXTURE.mismatchWithDraft));
      await expect(list.basis.value(list.basis.root, FR_KO['trace.kvAssignedRow']), '[Expected 2] The assigned row itself is shown').not.toHaveText('—');
      await list.basis.close();
    });

    await step('Act: Step 2 — Open 근거 on the promotion-winning product and read which slot was compared', async () => {
      await list.openBasis(list.row(FIXTURE.promotionWins));
    });

    await step('Assert: Expected 3 — The comparison is made on the 프로모션 slot, not the 기본 slot', async () => {
      await expect(list.basis.section('trace.assignedTitle'), '[Expected 3] The compared slot reads 일치 on the promotion row').toContainText(FR_KO['trace.flagOk']);
      await expect.soft(list.basis.section('trace.assignedTitle'), '[Expected 3] The promotion slot (프로모션 / PROMOTION) is named').toContainText(/프로모션|PROMOTION/);
      await expect.soft(list.basis.section('trace.assignedTitle'), '[Expected 3] The 기본 (default / NORMAL) slot is not compared').not.toContainText(/기본|NORMAL/);
      await list.basis.close();
    });
  });

  test('TC_US079_34 — A product sold under two policies produces two independent rows', async ({ page, feeReviewApi, feeReviewState, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_34', 'Medium', TAGS, `${FIXTURE.approvedTwoPolicies} (NORMAL + PROMOTION) shows two rows; correcting one leaves the other policy's resolution and correction state untouched. ${DEV} Data: the new draft is discarded in teardown.`);
    let before: Awaited<ReturnType<typeof feeReviewApi.row>>;

    await step('Arrange: Pre-condition 1–2 — A product sold under NORMAL and PROMOTION in the cycle', async () => {
      before = await feeReviewApi.row(CYCLE.id, FIXTURE.approvedTwoPolicies, 'PROMOTION');
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Search the list for that product ID', async () => {
      await list.search(FIXTURE.approvedTwoPolicies);
    });

    await step('Assert: Expected 1 — Two separate rows, one per policy', async () => {
      await expect(list.rows, '[Expected 1] Two rows').toHaveCount(2);
    });

    await step('Act: Step 2 — Correct the NORMAL row and check the other row', async () => {
      const id = await feeReviewState.draft(feeReviewApi, FIXTURE.approvedTwoPolicies, RATE_MOVING, autoReason('TC_US079_34', 'NORMAL row only'), 'NORMAL');
      expect(id, 'A draft was saved on the NORMAL row').toBeTruthy();
    });

    await step("Assert: Expected 2 — The other policy's resolution and correction state are untouched", async () => {
      const after = await feeReviewApi.row(CYCLE.id, FIXTURE.approvedTwoPolicies, 'PROMOTION');
      expect({ cat: after.inForceCategory, rate: after.inForceRate, state: after.correction?.state }, '[Expected 2] PROMOTION row unchanged').toEqual({ cat: before.inForceCategory, rate: before.inForceRate, state: before.correction?.state });
      expect((await feeReviewApi.row(CYCLE.id, FIXTURE.approvedTwoPolicies, 'NORMAL')).correction?.state, 'The NORMAL row now holds the draft').toBe('DRAFT');
    });
  });

  test('TC_US079_35 — A cycle holding no products shows the empty state with every bucket reading zero', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_35', 'Medium', TAGS, `Selecting an empty cycle shows "이 기간에 해당하는 상품이 없습니다" with its subtitle and the 필터 초기화 call to action, and all ten chips read 0. Deviation: ${OLDEST_OPEN_CYCLE.label} is the empty cycle used. ${READ}`);
    const counts: number[] = [];

    await step('Arrange: Pre-condition 1–2 — A cycle with no products', async () => {
      await list.open({ cycleId: CYCLE.id });
    });

    await step('Act: Step 1 — Select that cycle', async () => {
      await list.selectCycle(OLDEST_OPEN_CYCLE.label);
      for (const key of ['bucket.ALL', ...SCOPE, 'bucket.NF', 'bucket.AMB', 'bucket.DIFF', 'bucket.SRCDIFF'] as const) counts.push(await list.chipCount(list.chip(key)));
    });

    await step('Assert: Expected 1 — The empty state with title, subtitle and the Reset filter call to action', async () => {
      await expect(list.emptyTitle, '[Expected 1] Empty-state title').toBeVisible();
      await expect(list.emptySubtitle, '[Expected 1] Empty-state subtitle').toBeVisible();
      await expect(list.emptyCta, '[Expected 1] 필터 초기화 call to action').toBeVisible();
    });

    await step('Assert: Expected 2 — Every one of the ten summary chips reads 0', async () => {
      expect(counts, '[Expected 2] All ten chips read 0').toEqual(new Array(10).fill(0));
    });
  });

  test('TC_US079_36 — A filter that excludes every row shows the same empty state and Reset filter clears it', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_36', 'Medium', TAGS, `Searching a product ID that does not exist (999999) shows the empty state; 필터 초기화 clears the keyword and returns to the unfiltered 확인 필요 view (pager total = the 확인 필요 count). Deviation: dev has no search-condition dropdown, so 999999 is typed into the keyword box without picking 상품ID. ${DEV} ${READ}`);

    await step('Arrange: Pre-condition 1–2 — The open cycle holds products', async () => {
      await list.open({ cycleId: CYCLE.id });
    });

    await step('Act: Step 1 — Type 999999 and press Search', async () => {
      await list.search('999999');
    });

    await step('Assert: Expected 1 — The same empty-state title, subtitle and call to action', async () => {
      await expect(list.emptyTitle, '[Expected 1] Title').toBeVisible();
      await expect(list.emptySubtitle, '[Expected 1] Subtitle covering both causes').toBeVisible();
      await expect(list.emptyCta, '[Expected 1] 필터 초기화').toBeVisible();
    });

    await step('Act: Step 2 — Click 필터 초기화 (Reset filter)', async () => {
      await list.untilListed(() => list.emptyCta.click());
    });

    await step('Assert: Expected 2 — The keyword is cleared and the view returns to the unfiltered 확인 필요 list', async () => {
      await expect(list.keywordInput, '[Expected 2] Keyword cleared').toHaveValue('');
      await expect(list.chip('bucket.EXC'), '[Expected 2] 확인 필요 selected').toHaveAttribute('aria-pressed', 'true');
      expect(await pagerTotal(list), '[Expected 2] The list is unfiltered — the pager total equals the 확인 필요 count').toBe(await list.chipCount(list.chip('bucket.EXC')));
    });
  });

  test('TC_US079_37 — A cycle with no settlement-target set yet shows the empty state naming the cause', async ({ page, feeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_37', 'Medium', TAGS, `Selecting an open cycle that has no settlement data yet shows STL-1014 "이 주기에는 아직 정산 데이터가 없습니다. 데이터 적재·계산이 끝나면 목록이 표시됩니다." — distinct from the plain empty state. Deviation: ${EMPTY_OPEN_CYCLE.label} (open, no data on dev) is used; the API's emptyStateCode is recorded. ${READ}`);
    let code = '';

    await step('Arrange: Pre-condition 1–2 — A selectable cycle without a settlement-target set', async () => {
      code = String((await feeReviewApi.products(EMPTY_OPEN_CYCLE.id)).emptyStateCode ?? 'none');
      test.info().annotations.push({ type: 'Observed', description: `emptyStateCode for ${EMPTY_OPEN_CYCLE.label} = ${code}` });
      await list.open({ cycleId: CYCLE.id });
    });

    await step('Act: Step 1 — Select that cycle', async () => {
      await list.selectCycle(EMPTY_OPEN_CYCLE.label);
    });

    await step('Assert: Expected 1 — The empty state names the cause (STL-1014)', async () => {
      await expect(list.noSettlementData, '[Expected 1] STL-1014 message').toBeVisible();
    });

    await step('Assert: Expected 2 — It is distinct from the plain empty state', async () => {
      await expect(list.noSettlementData, '[Expected 2] The cause is named, not the generic subtitle only').not.toHaveText(FR_KO['empty.subtitle']);
    });
  });

  test('TC_US079_39 — The computed-at label is plain text, and a closed cycle reads as fixed and stamped', async ({ page, feeReviewApi, feeReviewState, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_39', 'Medium', TAGS, `After correcting ${FIXTURE.forSave} and reopening (no recalculate control), the new rate shows and the label reads "산정 시각 … — 열 때마다 새로 산정됩니다" as plain text; on the closed ${CLOSED_CYCLE.label} the label reads "마감된 기간 — 요율이 확정·스탬프되었습니다". Deviation: the correction is a draft (rate-moving — no same-rate category on dev), so the new rate shows as the proposed second line; the category and its rate are picked at run time (shared fixture drift). Not automated: "the stamped rates do not change even if the underlying contract data changes afterward" — contracts cannot be changed from this suite. ${DEV} Data: the draft is discarded in teardown.`);
    let newRate = '';

    await step('Arrange: Pre-condition 1–2 — An open and a closed cycle; the product is resolved', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Correct the category, then reopen the screen without any recalculate control', async () => {
      const category = await movingCategory(feeReviewApi, FIXTURE.forSave);
      newRate = `${(await feeReviewApi.options(CYCLE.id, FIXTURE.forSave)).categories.find((c) => c.categoryName === category)?.rate ?? ''}%`;
      await feeReviewState.draft(feeReviewApi, FIXTURE.forSave, category, autoReason('TC_US079_39', 'label check'));
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Assert: Expected 1 — The new rate appears; the label states it is recomputed on every open, as plain text', async () => {
      await expect(page.getByRole('button', { name: /재계산|재산정|다시 산정|Recalculate|Recompute/ }), '[Expected 1] No recalculate control is needed or offered').toHaveCount(0);
      await expect(list.cell(list.row(FIXTURE.forSave), 'rate'), `[Expected 1] The new rate ${newRate} appears`).toContainText(newRate);
      await expect(list.resolvedAtLabel, '[Expected 1] Recomputed-on-every-open label').toHaveText(/열 때마다 새로 산정됩니다/);
      expect(await list.resolvedAtLabel.evaluate((el) => el.tagName), '[Expected 1] Plain text, no input frame').not.toMatch(/INPUT|TEXTAREA/);
    });

    await step('Act: Step 2 — Switch to the closed cycle and read the label', async () => {
      await list.selectCycle(CLOSED_CYCLE.label);
    });

    await step('Assert: Expected 2 — The label reads fixed and stamped', async () => {
      await expect(list.resolvedAtLabel, '[Expected 2] Closed-period label').toHaveText(FR_KO['lbl.resolvedAtClosed']);
    });
  });

  test('TC_US079_40 — No screen action writes a resolved rate into storage and nothing is written back to commerce', async ({ page, feeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_40', 'Medium', TAGS, `Opening and closing 근거 on ${FIXTURE.mismatchWithDraft} several times and reopening the list sends no write request and leaves the row exactly as the register reports it. Not automated: step 2 (the commerce fee-mapping screen after a save) — that screen is outside this suite. ${DEV} ${READ}`);
    let before = '';
    let writes = 0;

    await step('Arrange: Pre-condition 1–2 — A mismatch product', async () => {
      before = JSON.stringify(await feeReviewApi.row(CYCLE.id, FIXTURE.mismatchWithDraft));
      page.on('request', (r) => {
        if (r.method() !== 'GET' && /\/api\/v1\//.test(r.url())) writes += 1;
      });
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Open and close 근거 several times and reopen the list', async () => {
      for (let i = 0; i < 3; i++) {
        await list.openBasis(list.row(FIXTURE.mismatchWithDraft));
        await list.basis.close();
      }
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Assert: Expected 1 — Nothing is written; the rate is recomputed the same way on every read', async () => {
      expect(writes, '[Expected 1] No write request was sent').toBe(0);
      expect(JSON.stringify(await feeReviewApi.row(CYCLE.id, FIXTURE.mismatchWithDraft)), '[Expected 1] The row reads the same').toBe(before);
    });

    await step('Act: Step 2 — Check the commerce fee-mapping screen after a save (Not automated)', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Step 2: the commerce fee-mapping screen is outside this suite' });
    });

    await step("Assert: Expected 2 — Commerce keeps its own assignment (Not automated)", async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Expected 2: see Step 2' });
    });
  });
});
