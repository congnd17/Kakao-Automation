import { test, expect } from '@fixtures/territory.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { isClipped } from '@utils/layout';
import { TERRITORY_TEXT, NORMAL_FLAGS, parseCounter, pickSeededCountry, toSeoulMinute } from '@utils/territory.data';
import { getAccountDisplayName } from '@utils/auth-token';

/**
 * US089 — nhóm [List]: sắp xếp, tìm kiếm, bộ lọc, reset, phân trang, bộ đếm, trạng thái không kết quả.
 * Nguồn TC: input/TESTCASE_US089_v3.1.md (Steps N / Expected N → `Act: Step N` / `Assert: Expected N`). Kỳ vọng assert theo TC;
 * ý về chữ của bộ đếm dùng `expect.soft` để một chỗ lệch chữ không che các ý khác.
 * Dev dùng chung có người khác sửa (29/09) → tiền điều kiện "seed chưa ai sửa" không giữ được: kỳ vọng của bộ lọc tính từ
 * register (API) lúc Arrange; TC cần cờ cụ thể (JP, KR, AE) thì đưa về đúng cờ qua `territoryState` và khôi phục ở teardown.
 * Màn không có mục menu → mở bằng URL `/commerce/territories` (Deviation chung, xem TC_US089_11).
 */
const TAGS = ['ui', 'territory', 'territory-list'];
const EN = TERRITORY_TEXT.en;
const DATA = 'Data: read-only — no row is changed.';
const TOTAL_FORM = /^Total \d+ countries · showing \d+-\d+$/;
const MATCHING_FORM = /^Matching filters: \d+ · showing \d+-\d+$/;

test.describe('[List] Territory list — sort, search, filters, paging', () => {
  test.describe.configure({ timeout: 120_000 });

  test('TC_US089_19 — The table loads sorted by country code A to Z with no pinned exception and no sortable column', async ({ page, territoryApi, territoryListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_19', 'Medium', TAGS, `The first ten codes on page 1 are strictly A→Z; KR sits in its alphabetical place among the K codes (not pinned on page 1); clicking any of the five headers changes nothing (no sort, no arrow, no pointer). Deviation from TC: KR is located on the 100-rows page that holds it instead of paging by hand. ${DATA}`);
    let firstTen: string[] = [];
    let krNeighbours = { page: [] as string[], index: -1 };
    let before: string[] = [];
    let after: string[] = [];
    const headerCursors: string[] = [];

    await step('Arrange: Pre-condition 1–2 — Logged in; the table holds a row for every ISO code', async () => {
      expect((await territoryApi.list()).body.paging.totalCount, 'The register holds the seeded rows').toBeGreaterThan(200);
    });

    await step('Act: Step 1 — Open Territory and read the country codes of the first ten rows on page 1', async () => {
      await list.open();
      firstTen = await list.codes();
    });

    await step('Assert: Expected 1 — The ten codes are in strictly ascending A-to-Z order', async () => {
      expect(firstTen, '[Expected 1] Ten rows on page 1').toHaveLength(10);
      expect(firstTen, '[Expected 1] Codes are strictly ascending').toEqual([...firstTen].sort());
      expect(new Set(firstTen).size, '[Expected 1] No code repeats').toBe(10);
    });

    await step('Act: Step 2 — Search KR to confirm it exists, reset, then page to where the K codes appear', async () => {
      await list.setCriteria({ keyword: 'KR' });
      await list.search();
      await expect(list.row('KR'), 'KR exists').toBeVisible();
      await list.reset();
      await list.setPageSize('100');
      const all = (await territoryApi.all()).map((t) => t.countryCode).sort();
      const target = Math.floor(all.indexOf('KR') / 100) + 1;
      if (target > 1) await list.goToPage(new RegExp(`^${target}$`));
      await expect(list.row('KR'), 'The page holding KR is shown').toHaveCount(1);
      const codes = await list.codes();
      krNeighbours = { page: codes, index: codes.indexOf('KR') };
    });

    await step('Assert: Expected 2 — KR sits in its alphabetical position among the K codes, not pinned to page 1', async () => {
      expect(krNeighbours.index, '[Expected 2] KR is found on a page').toBeGreaterThanOrEqual(0);
      expect(krNeighbours.page, '[Expected 2] The page holding KR is sorted A→Z').toEqual([...krNeighbours.page].sort());
      expect(firstTen, '[Expected 2] KR is not pinned to the top of page 1').not.toContain('KR');
    });

    await step('Act: Step 3 — Click each of the five column headers in turn', async () => {
      await list.setPageSize('10');
      before = await list.codes();
      for (let i = 0; i < 5; i++) {
        headerCursors.push(await list.headers.nth(i).evaluate((th) => getComputedStyle(th).cursor));
        await list.headers.nth(i).click();
      }
      after = await list.codes();
    });

    await step('Assert: Expected 3 — No header reacts: order unchanged, no sort arrow, cursor unchanged', async () => {
      expect(after, '[Expected 3] The row order does not change').toEqual(before);
      for (let i = 0; i < 5; i++) {
        await expect(list.headers.nth(i), `[Expected 3] Header ${i + 1} carries no sort state`).not.toHaveAttribute('aria-sort', /./);
        expect(headerCursors[i], `[Expected 3] Header ${i + 1} cursor is not a pointer`).not.toBe('pointer');
      }
    });
  });

  test('TC_US089_21 — Clicking the history link opens only the dialog and does not navigate to the edit screen', async ({ page, territoryListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_21', 'High', TAGS, `Clicking 변경 이력 on the JP row opens only the history dialog; the list stays behind it with an unchanged address; Close returns to the same list page and filters. Deviation from TC: JP has no history record on dev yet (read-only suite) — the dialog behaviour does not depend on it. ${DATA}`);
    let address = '';

    await step('Arrange: Pre-condition 1–2 — Logged in; the JP row is listed', async () => {
      await list.open();
      await list.setCriteria({ keyword: 'JP' });
      await list.search();
    });

    await step('Act: Step 1 — Note the current page address', async () => {
      address = page.url();
    });

    await step('Assert: Expected 1 — The list address is noted for comparison', async () => {
      expect(address, '[Expected 1] The list address is noted').toMatch(/\/commerce\/territories/);
    });

    await step('Act: Step 2 — Click exactly on the 변경 이력 (Change history) link of the JP row', async () => {
      await list.openHistory(list.row('JP'));
    });

    await step('Assert: Expected 2 — The Change history dialog for JP opens', async () => {
      await expect(list.historyDialog.subtitle, '[Expected 2] The dialog is for JP').toContainText('JP');
    });

    await step('Act: Step 3 — Look behind the dialog and re-read the page address', async () => {
      await list.table.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — The list is still behind the dialog; the address is unchanged', async () => {
      await expect(list.table, '[Expected 3] The country list is still behind the dialog').toBeVisible();
      expect(page.url(), '[Expected 3] The address is unchanged').toBe(address);
    });

    await step('Act: Step 4 — Click Close in the dialog footer', async () => {
      await list.historyDialog.close();
    });

    await step('Assert: Expected 4 — The dialog closes; the list keeps the same page and filters', async () => {
      await expect(list.searchInput, '[Expected 4] The applied search is kept').toHaveValue('JP');
      await expect(list.row('JP'), '[Expected 4] The same result is shown').toBeVisible();
      expect(page.url(), '[Expected 4] Same page and filters').toBe(address);
    });
  });

  test('TC_US089_23 — The search matches code, English and Korean names case-insensitively; Enter equals Search', async ({ page, territoryListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_23', 'Medium', TAGS, `With the English interface, "kr" (code), "korea" (English name) and "대한민국" (Korean name) all return KR, and Enter in the box gives the same result as 검색. ${DATA}`);
    const results: Record<string, string[]> = {};

    await step('Arrange: Pre-condition 1–3 — Logged in; KR is "South Korea" / "대한민국"; interface in English', async () => {
      await list.open('en');
    });

    const runs: Array<{ n: number; keyword: string; title: string; enter?: boolean }> = [
      { n: 1, keyword: 'kr', title: 'Type "kr" in lower case and click Search' },
      { n: 2, keyword: 'korea', title: 'Reset, type "korea" and click Search' },
      { n: 3, keyword: '대한민국', title: 'Reset, type "대한민국" and click Search' },
      { n: 4, keyword: 'KR', title: 'Reset, type "KR" and press Enter instead of clicking the button', enter: true },
    ];
    for (const run of runs) {
      await step(`Act: Step ${run.n} — ${run.title}`, async () => {
        if (run.n > 1) await list.reset();
        await list.setCriteria({ keyword: run.keyword });
        if (run.enter) await list.untilListed(() => list.searchInput.press('Enter'));
        else await list.search();
        results[run.n] = await list.codes();
      });

      await step(`Assert: Expected ${run.n} — ${run.n === 4 ? 'The result is identical to step 1' : 'The result contains the KR row'}`, async () => {
        expect(results[run.n], `[Expected ${run.n}] KR is returned`).toContain('KR');
        if (run.n === 4) expect(results[4], '[Expected 4] Enter gives the same result as clicking Search in step 1').toEqual(results[1]);
      });
    }
  });

  for (const filter of [
    {
      tc: 'TC_US089_24',
      name: 'VAT treatment',
      select: 'vat' as const,
      col: 'vat' as const,
      first: { value: 'TAXABLE_STANDARD' as const, label: 'Taxable (standard)', other: 'Zero-rated' },
      second: { value: 'ZERO_RATED' as const, label: 'Zero-rated', other: 'Taxable (standard)' },
    },
    {
      tc: 'TC_US089_25',
      name: 'Export declaration',
      select: 'export' as const,
      col: 'export' as const,
      first: { value: 'true' as const, label: 'Required', other: 'Not required' },
      second: { value: 'false' as const, label: 'Not required', other: 'Required' },
    },
  ]) {
    test(`${filter.tc} — The ${filter.name} filter narrows the list correctly for all three options`, async ({ page, territoryApi, territoryListPage: list }) => {
      const step = makeStep(page);
      await tcMeta(filter.tc, 'Medium', TAGS, `${filter.name} = ${filter.first.label} shows only ${filter.first.label} rows, = ${filter.second.label} only ${filter.second.label} rows, = All every row with the "Total {n} countries" counter. Deviation: other users edit rows on the shared dev, so "KR is the only differing row" cannot hold — each result is compared with the register (API) read in Arrange. ${DATA}`);
      const seen: Record<number, { values: string[]; codes: string[]; counter: string }> = {};
      let expected = { first: [] as string[], second: [] as string[] };
      const apply = async (value: string) => {
        if (filter.select === 'vat') await list.setCriteria({ vat: value as '' | 'TAXABLE_STANDARD' | 'ZERO_RATED' });
        else await list.setCriteria({ exportFlag: value as '' | 'true' | 'false' });
        await list.search();
        await list.setPageSize('100');
        return { values: (await list.rows.locator(`td:nth-child(${filter.col === 'vat' ? 2 : 3})`).allTextContents()).map((v) => v.trim()), codes: await list.codes(), counter: ((await list.counter.textContent()) ?? '').trim() };
      };

      await step('Arrange: Pre-condition 1–2 — Logged in; the register is read for the expected results', async () => {
        const all = await territoryApi.all();
        const matches = (value: string) => all.filter((t) => (filter.select === 'vat' ? t.vatTreatment : String(t.exportDeclarationRequired)) === value).map((t) => t.countryCode).sort();
        expected = { first: matches(filter.first.value), second: matches(filter.second.value) };
        await list.open('en');
      });

      await step(`Act: Step 1 — Change the ${filter.name} picker to ${filter.first.label} and click Search`, async () => {
        seen[1] = await apply(filter.first.value);
      });

      await step(`Assert: Expected 1 — Only ${filter.first.label} rows are shown`, async () => {
        expect(seen[1].values.every((v) => v === filter.first.label), `[Expected 1] Every row reads ${filter.first.label}`).toBe(true);
        expect(seen[1].codes, '[Expected 1] Exactly the register rows with that value').toEqual(expected.first.slice(0, 100));
      });

      await step(`Act: Step 2 — Reset, change the picker to ${filter.second.label} and click Search`, async () => {
        await list.reset();
        seen[2] = await apply(filter.second.value);
      });

      await step(`Assert: Expected 2 — Only ${filter.second.label} rows are shown`, async () => {
        expect(seen[2].values.every((v) => v === filter.second.label), `[Expected 2] Every row reads ${filter.second.label}`).toBe(true);
        expect(seen[2].codes, '[Expected 2] Exactly the register rows with that value').toEqual(expected.second.slice(0, 100));
      });

      await step('Act: Step 3 — Reset, leave the picker at All and click Search', async () => {
        await list.reset();
        seen[3] = await apply('');
      });

      await step('Assert: Expected 3 — Every row again, both values, counter back to the "Total {n} countries" form', async () => {
        expect(seen[3].values, `[Expected 3] ${filter.first.label} rows are back`).toContain(filter.first.label);
        expect(seen[3].values, `[Expected 3] ${filter.second.label} rows are back`).toContain(filter.second.label);
        expect.soft(seen[3].counter, '[Expected 3] Counter reads "Total {n} countries · showing {a}-{b}"').toMatch(TOTAL_FORM);
      });
    });
  }

  test('TC_US089_27 — The table does not change while typing or changing filters, only on Search', async ({ page, territoryState, territoryListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_27', 'Medium', TAGS, `Typing KR, choosing 과세 and choosing Not required leave the table as it was (same first row, counter and row count); only 검색 re-runs it, showing only matching rows (KR among them) with the "Matching filters: {n} · showing {a}-{b}" counter (soft). Data: KR is put back to its seeded flags if another user changed it, and restored in teardown.`);
    let baseline = { first: '', counter: '', count: 0 };
    const snapshot = async () => ({ first: (await list.codes())[0], counter: ((await list.counter.textContent()) ?? '').trim(), count: await list.rows.count() });
    let requests = 0;
    let final: string[] = [];

    await step('Arrange: Pre-condition 1–2 — Logged in; the table is unfiltered on page 1', async () => {
      await territoryState.prepare('KR', NORMAL_FLAGS('KR'));
      await list.open('en');
      page.on('request', (r) => {
        if (r.method() === 'GET' && /\/api\/v1\/territories\?/.test(r.url())) requests += 1;
      });
    });

    await step('Act: Step 1 — Note the first-row code and the counter', async () => {
      baseline = await snapshot();
      requests = 0;
    });

    await step('Assert: Expected 1 — The first-row code and the counter are noted', async () => {
      expect(baseline.first, '[Expected 1] The first row code is noted').toMatch(/^[A-Z]{2}$/);
      expect(baseline.counter, '[Expected 1] The counter is noted').not.toBe('');
    });

    const edits: Array<{ n: number; title: string; run: () => Promise<void> }> = [
      { n: 2, title: 'Type KR into the Country box without clicking anything else', run: () => list.setCriteria({ keyword: 'KR' }) },
      { n: 3, title: 'Change VAT treatment to Taxable (standard) without clicking anything else', run: () => list.setCriteria({ vat: 'TAXABLE_STANDARD' }) },
      { n: 4, title: 'Change Export declaration to Not required without clicking anything else', run: () => list.setCriteria({ exportFlag: 'false' }) },
    ];
    for (const edit of edits) {
      await step(`Act: Step ${edit.n} — ${edit.title}`, edit.run);
      await step(`Assert: Expected ${edit.n} — The table is unchanged from step 1`, async () => {
        expect(await snapshot(), `[Expected ${edit.n}] Same first row, counter and row count`).toEqual(baseline);
        expect(requests, `[Expected ${edit.n}] No list request was sent`).toBe(0);
      });
    }

    await step('Act: Step 5 — Click Search', async () => {
      await list.search();
      final = await list.codes();
    });

    await step('Assert: Expected 5 — Only now the table changes to rows satisfying all three conditions, with the Matching-filters counter', async () => {
      expect(final, '[Expected 5] The table now shows only KR (the row matching all three)').toEqual(['KR']);
      expect.soft(((await list.counter.textContent()) ?? '').trim(), '[Expected 5] Counter reads "Matching filters: {n} · showing {a}-{b}"').toMatch(MATCHING_FORM);
    });
  });

  test('TC_US089_28 — Reset clears typed and applied conditions, returns to page 1 and re-runs the query by itself', async ({ page, territoryApi, territoryListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_28', 'Medium', TAGS, `After "A" + Required and moving to page 2, typing an extra "B" does not re-run the table; 초기화 empties the box, resets Export declaration to All and re-runs by itself to page 1 of every row with the "Total {n} countries" counter. ${DATA}`);
    let total = 0;
    let page2 = '';

    await step('Arrange: Pre-condition 1–2 — Logged in; every ISO code has a row', async () => {
      total = (await territoryApi.list()).body.paging.totalCount;
      await list.open('en');
    });

    await step('Act: Step 1 — Type A, change Export declaration to Required and click Search', async () => {
      await list.setCriteria({ keyword: 'A', exportFlag: 'true' });
      await list.search();
    });

    await step('Assert: Expected 1 — The table re-filters on both conditions; the counter changes to the Matching-filters form', async () => {
      const counter = parseCounter(((await list.counter.textContent()) ?? '').trim());
      expect(counter?.total ?? total, '[Expected 1] The filtered total is below the full register').toBeLessThan(total);
      expect.soft(((await list.counter.textContent()) ?? '').trim(), '[Expected 1] Counter reads "Matching filters: {n} · showing {a}-{b}"').toMatch(MATCHING_FORM);
    });

    await step('Act: Step 2 — Move to page 2 of the result', async () => {
      await list.goToPage('2');
      page2 = ((await list.counter.textContent()) ?? '').trim();
    });

    await step('Assert: Expected 2 — The table shows page 2 of the filtered result', async () => {
      expect(parseCounter(page2)?.from, '[Expected 2] Page 2 starts at row 11').toBe(11);
    });

    await step('Act: Step 3 — Type an extra B into the Country box without clicking Search', async () => {
      await list.searchInput.press('End');
      await list.searchInput.pressSequentially('B');
    });

    await step('Assert: Expected 3 — The input shows AB but the table has not changed', async () => {
      await expect(list.searchInput, '[Expected 3] The input shows AB').toHaveValue('AB');
      expect(((await list.counter.textContent()) ?? '').trim(), '[Expected 3] The table is unchanged').toBe(page2);
    });

    await step('Act: Step 4 — Click Reset', async () => {
      await list.reset();
    });

    await step('Assert: Expected 4 — The Country box is empty and Export declaration is back to All', async () => {
      await expect(list.searchInput, '[Expected 4] The Country box is empty').toHaveValue('');
      await expect(list.exportSelect, '[Expected 4] Export declaration is back to All').toHaveValue('');
    });

    await step('Act: Step 5 — Look at the table right after step 4, without clicking any other button', async () => {
      await list.table.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 5 — The table re-ran by itself: every row from page 1 with the "Total {n} countries" counter', async () => {
      const counter = parseCounter(((await list.counter.textContent()) ?? '').trim());
      expect(counter, '[Expected 5] Every row, page 1').toEqual({ total, from: 1, to: 10 });
      expect.soft(((await list.counter.textContent()) ?? '').trim(), '[Expected 5] Counter reads "Total {n} countries · showing {a}-{b}"').toMatch(TOTAL_FORM);
    });
  });

  test('TC_US089_29 — All four page sizes apply immediately, return to page 1 and keep the applied filters', async ({ page, territoryListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_29', 'Medium', TAGS, `With Export declaration = Required on page 3, changing 페이지당 to 20 / 50 / 100 / 10 reloads immediately, returns to page 1 and keeps only Required rows; the counter stays in the Matching-filters form. ${DATA}`);
    const seen: Record<number, { rows: number; from: number | undefined; allRequired: boolean; counter: string }> = {};
    const read = async () => {
      const counter = ((await list.counter.textContent()) ?? '').trim();
      const values = (await list.rows.locator('td:nth-child(3)').allTextContents()).map((v) => v.trim());
      return { rows: await list.rows.count(), from: parseCounter(counter)?.from, allRequired: values.every((v) => v === 'Required'), counter };
    };

    await step('Arrange: Pre-condition 1–2 — Logged in; every ISO code has a row', async () => {
      await list.open('en');
    });

    await step('Act: Step 1 — Export declaration = Required, click Search, then move to page 3', async () => {
      await list.setCriteria({ exportFlag: 'true' });
      await list.search();
      await list.goToPage('3');
      seen[1] = await read();
    });

    await step('Assert: Expected 1 — The table filters on Required and shows page 3', async () => {
      expect(seen[1].from, '[Expected 1] Page 3 starts at row 21').toBe(21);
      expect(seen[1].allRequired, '[Expected 1] Only Required rows').toBe(true);
    });

    for (const [n, size] of [[2, '20'], [3, '50'], [4, '100'], [5, '10']] as const) {
      await step(`Act: Step ${n} — Change 페이지당 (Rows per page) to ${size}개 (${size})`, async () => {
        await list.setPageSize(size);
        seen[n] = await read();
      });

      await step(`Assert: Expected ${n} — ${size} rows from page 1, still only Required rows`, async () => {
        expect(seen[n].rows, `[Expected ${n}] ${size} rows are shown`).toBe(Number(size));
        expect(seen[n].from, `[Expected ${n}] Back to page 1`).toBe(1);
        expect(seen[n].allRequired, `[Expected ${n}] Still only Required rows`).toBe(true);
        if (n === 2) expect.soft(seen[n].counter, '[Expected 2] Counter stays "Matching filters: {n} · showing {a}-{b}"').toMatch(MATCHING_FORM);
        if (n === 5) await expect(list.exportSelect, '[Expected 5] Export declaration still holds Required').toHaveValue('true');
      });
    }
  });

  test('TC_US089_30 — The page-navigation controls and the five-page ellipsis jump navigate correctly', async ({ page, territoryListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_30', 'Medium', TAGS, `On page 1 First / Previous are disabled; page 3 highlights 3; Next → 4, Previous → 3; the ellipsis jumps five pages (3 → 8); Last disables both forward buttons, First both backward buttons. ${DATA}`);
    const current = () => list.pagination.locator('li.page-item.active');
    const disabled = (label: string) => list.pagination.locator('li.page-item.disabled').filter({ hasText: label });
    const from = async () => parseCounter(((await list.counter.textContent()) ?? '').trim())?.from;

    await step('Arrange: Pre-condition 1–2 — Logged in; at 10 rows per page there are more than 5 pages', async () => {
      await list.open();
    });

    await step('Act: Step 1 — Look at the first two pagination buttons on page 1', async () => {
      await list.pagination.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — First and Previous are both disabled on page 1', async () => {
      await expect(disabled('First'), '[Expected 1] First is disabled').toHaveCount(1);
      await expect(disabled('Previous'), '[Expected 1] Previous is disabled').toHaveCount(1);
    });

    await step('Act: Step 2 — Click page number 3', async () => {
      await list.goToPage(/^3\s*$/);
    });

    await step('Assert: Expected 2 — Page 3 is shown and highlighted', async () => {
      await expect(current(), '[Expected 2] 3 is the current page').toContainText('3');
      expect(await from(), '[Expected 2] Page 3 starts at row 21').toBe(21);
    });

    await step('Act: Step 3 — Click Next, then Previous', async () => {
      await list.goToPage('Next');
      expect(await from(), 'Next moved to page 4').toBe(31);
      await list.goToPage('Previous');
    });

    await step('Assert: Expected 3 — The table moved to page 4 then back to page 3', async () => {
      await expect(current(), '[Expected 3] Back on page 3').toContainText('3');
    });

    await step('Act: Step 4 — Click the ellipsis to the right of the page numbers', async () => {
      await list.goToPage('...');
    });

    await step('Assert: Expected 4 — The table jumps to page 8 (five pages)', async () => {
      await expect(current(), '[Expected 4] Page 8 is current').toContainText('8');
      expect(await from(), '[Expected 4] Page 8 starts at row 71').toBe(71);
    });

    await step('Act: Step 5 — Click Last, then First', async () => {
      await list.goToPage('Last');
      await expect(disabled('Next'), 'On the last page Next is disabled').toHaveCount(1);
      await expect(disabled('Last'), 'On the last page Last is disabled').toHaveCount(1);
      await list.goToPage('First');
    });

    await step('Assert: Expected 5 — Last disabled both forward buttons; First returns to page 1 with both backward buttons disabled', async () => {
      expect(await from(), '[Expected 5] Back on page 1').toBe(1);
      await expect(disabled('First'), '[Expected 5] First is disabled').toHaveCount(1);
      await expect(disabled('Previous'), '[Expected 5] Previous is disabled').toHaveCount(1);
    });
  });

  test('TC_US089_31 — Both counter wordings: unfiltered and filtered', async ({ page, territoryApi, territoryListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_31', 'Medium', TAGS, `Unfiltered the counter reads "Total {n} countries · showing {a}-{b}" with {n} = the register size; filtered ("A") it reads "Matching filters: {n} · showing {a}-{b}"; after Reset the first form returns. ${DATA}`);
    let total = 0;
    const counters: string[] = [];

    await step('Arrange: Pre-condition 1–3 — Logged in; every ISO code has a row; 10 rows per page', async () => {
      total = (await territoryApi.list()).body.paging.totalCount;
      await list.open('en');
    });

    await step('Act: Step 1 — Read the counter with no filter applied', async () => {
      counters[1] = ((await list.counter.textContent()) ?? '').trim();
    });

    await step('Assert: Expected 1 — "Total {n} countries · showing {a}-{b}" with {n} = the register size', async () => {
      expect(parseCounter(counters[1])?.total ?? Number(/Total (\d+)/.exec(counters[1])?.[1]), '[Expected 1] {n} equals the register size').toBe(total);
      expect.soft(counters[1], '[Expected 1] Reads "Total {n} countries · showing {a}-{b}"').toMatch(TOTAL_FORM);
    });

    await step('Act: Step 2 — Type A, click Search and re-read the counter', async () => {
      await list.setCriteria({ keyword: 'A' });
      await list.search();
      counters[2] = ((await list.counter.textContent()) ?? '').trim();
    });

    await step('Assert: Expected 2 — The counter changes to "Matching filters: {n} · showing {a}-{b}"', async () => {
      expect(counters[2], '[Expected 2] The counter changed').not.toBe(counters[1]);
      expect.soft(counters[2], '[Expected 2] Reads "Matching filters: {n} · showing {a}-{b}"').toMatch(MATCHING_FORM);
    });

    await step('Act: Step 3 — Click Reset and read the counter once more', async () => {
      await list.reset();
      counters[3] = ((await list.counter.textContent()) ?? '').trim();
    });

    await step('Assert: Expected 3 — Back to the "Total {n} countries" form with the same number as step 1', async () => {
      expect(counters[3], '[Expected 3] Same counter as step 1').toBe(counters[1]);
    });
  });

  test('TC_US089_32 — The VAT badge and the export cell render in the displayed language and are never clipped', async ({ page, territoryApi, territoryState, territoryListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_32', 'Medium', TAGS, `English: KR reads Taxable (standard) / Not required, JP Zero-rated / Required (Required emphasised); Korean: the VAT badge switches to 과세 / 영세율 and the export cell stays English or shows the known interim 필요 / 불필요 (SPEC-GAP-13); neither column is clipped; the stored values are codes. Deviation from TC: step 4 reads the coded values through the API instead of the DB. Data: KR and JP are put back to their TC flags if another user changed them, and restored in teardown.`);
    const en: Record<string, { vat: string; exp: string }> = {};
    const ko: Record<string, { vat: string; exp: string }> = {};
    let weights = { required: '', notRequired: '' };
    let clipped: string[] = [];
    let stored = { vat: '', exp: '' as unknown };
    const read = async (code: string) => ({ vat: ((await list.cell(list.row(code), 'vat').textContent()) ?? '').trim(), exp: ((await list.cell(list.row(code), 'export').textContent()) ?? '').trim() });

    await step('Arrange: Pre-condition 1–4 — Logged in; KR taxable / not required; JP zero-rated / required; English interface', async () => {
      await territoryState.prepare('KR', NORMAL_FLAGS('KR'));
      await territoryState.prepare('JP', NORMAL_FLAGS('JP'));
      await list.open('en');
      await list.setPageSize('100');
      await list.goToPage('2');
    });

    await step('Act: Step 1 — Read the VAT treatment and Export declaration columns of KR and JP', async () => {
      en.KR = await read('KR');
      en.JP = await read('JP');
      weights = {
        required: await list.cell(list.row('JP'), 'export').locator('span').evaluate((e) => getComputedStyle(e).fontWeight),
        notRequired: await list.cell(list.row('KR'), 'export').locator('span').evaluate((e) => getComputedStyle(e).fontWeight),
      };
    });

    await step('Assert: Expected 1 — KR Taxable (standard) / Not required; JP Zero-rated / Required, with Required emphasised', async () => {
      expect(en.KR, '[Expected 1] KR reads Taxable (standard) / Not required').toEqual({ vat: 'Taxable (standard)', exp: 'Not required' });
      expect(en.JP, '[Expected 1] JP reads Zero-rated / Required').toEqual({ vat: 'Zero-rated', exp: 'Required' });
      expect(Number(weights.required), '[Expected 1] Required is emphasised (bolder than Not required)').toBeGreaterThan(Number(weights.notRequired));
    });

    await step('Act: Step 2 — Switch the interface to Korean and re-read the two columns on the same rows', async () => {
      await list.open();
      await list.setPageSize('100');
      await list.goToPage('2');
      ko.KR = await read('KR');
      ko.JP = await read('JP');
    });

    await step('Assert: Expected 2 — The VAT badge reads 과세 / 영세율; Required / Not required stay English (or the known interim 필요 / 불필요)', async () => {
      expect(ko.KR.vat, '[Expected 2] KR VAT badge reads 과세').toBe('과세');
      expect(ko.JP.vat, '[Expected 2] JP VAT badge reads 영세율').toBe('영세율');
      expect(ko.KR.exp, '[Expected 2] KR export reads Not required (or the known interim 불필요)').toMatch(/^(Not required|불필요)$/);
      expect(ko.JP.exp, '[Expected 2] JP export reads Required (or the known interim 필요)').toMatch(/^(Required|필요)$/);
    });

    await step('Act: Step 3 — Check whether the two columns are clipped on any row', async () => {
      clipped = [];
      for (let i = 0; i < (await list.rows.count()); i++) {
        for (const col of ['vat', 'export'] as const) {
          if (await isClipped(list.cell(list.rows.nth(i), col))) clipped.push(`${(await list.codes())[i]}:${col}`);
        }
      }
    });

    await step('Assert: Expected 3 — Neither column is clipped on any row', async () => {
      expect(clipped, '[Expected 3] No VAT / export cell is clipped').toEqual([]);
    });

    await step('Act: Step 4 — Read the stored values of the two columns on the KR row (API)', async () => {
      const kr = (await territoryApi.get('KR')).body;
      stored = { vat: kr.vatTreatment, exp: kr.exportDeclarationRequired };
    });

    await step('Assert: Expected 4 — A coded value is stored, not a translated label', async () => {
      expect(stored.vat, '[Expected 4] VAT treatment is stored as a code').toBe('TAXABLE_STANDARD');
      expect(stored.exp, '[Expected 4] Export declaration is stored as a flag').toBe(false);
    });
  });

  test('TC_US089_33 — The last-updated column shows the right content for a never-edited and an edited row', async ({ page, territoryApi, territoryState, territoryListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_33', 'Medium', TAGS, `A never-edited row shows "Seeded default" above the seed timestamp; JP, edited by the ADMIN account (API, pre-condition), shows the editor above the edit timestamp; the timestamp reads YYYY-MM-DD HH:mm in Seoul time. Deviation: VN was edited by another user on the shared dev — the first country still carrying its seeded values is used when VN no longer qualifies (the code actually used is noted in the report). Data: JP is edited once through the API and restored in teardown.`);
    let seeded = { code: '', seoul: '' };
    let jp = { by: '', seoul: '' };
    const lines: Record<string, string[]> = {};
    // Dòng đã sửa: tên người sửa không nằm trong <span> như dòng seed → tách [dòng trên, timestamp] từ chữ hiển thị của ô.
    const readLines = async (code: string) => {
      const text = (await list.cell(list.row(code), 'updated').innerText()).replace(/\s+/g, ' ').trim();
      const m = /^(.*?)\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})$/.exec(text);
      return m ? [m[1], m[2]] : [text];
    };

    await step('Arrange: Pre-condition 1–3 — A never-edited country; JP edited once by an ADMIN', async () => {
      const row = await pickSeededCountry(territoryApi);
      seeded = { code: row.countryCode, seoul: toSeoulMinute(row.updatedAt) };
      const before = await territoryState.prepare('JP', NORMAL_FLAGS('JP'));
      await territoryApi.update('JP', { vatTreatment: 'TAXABLE_STANDARD', exportDeclarationRequired: before.exportDeclarationRequired, reason: 'Automation pre-condition — JP edited once for TC_US089_33', version: before.version });
      const edited = (await territoryApi.get('JP')).body;
      jp = { by: edited.updatedBy ?? '', seoul: toSeoulMinute(edited.updatedAt) };
      await list.open('en');
    });

    await step('Act: Step 1 — Find the never-edited row and read the Last updated column', async () => {
      await list.setCriteria({ keyword: seeded.code });
      await list.search();
      lines.seeded = await readLines(seeded.code);
      test.info().annotations.push({ type: 'Country used for "never edited"', description: seeded.code });
    });

    await step('Assert: Expected 1 — "Seeded default" on the upper line and the seed timestamp on the lower line', async () => {
      expect(lines.seeded[0], '[Expected 1] Upper line reads Seeded default').toBe(EN.seeded);
      expect(lines.seeded[1], '[Expected 1] Lower line holds the seed timestamp').toBe(seeded.seoul);
    });

    await step('Act: Step 2 — Find the JP row and read the Last updated column', async () => {
      await list.setCriteria({ keyword: 'JP' });
      await list.search();
      lines.jp = await readLines('JP');
    });

    await step('Assert: Expected 2 — The editing account on the upper line and the edit timestamp on the lower line', async () => {
      expect(lines.jp[0], '[Expected 2] Upper line is the editing account').toBe(getAccountDisplayName('submitter'));
      expect(jp.by, '[Expected 2] The register records the same editor').toBe(getAccountDisplayName('submitter'));
      expect(lines.jp[1], '[Expected 2] Lower line is the edit timestamp').toBe(jp.seoul);
    });

    await step('Act: Step 3 — Compare the timestamp format against Seoul time', async () => {
      await list.cell(list.row('JP'), 'updated').scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — The timestamp is exactly YYYY-MM-DD HH:mm in Seoul time', async () => {
      expect(lines.jp[1], '[Expected 3] Format YYYY-MM-DD HH:mm').toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      expect(lines.jp[1], '[Expected 3] Seoul time of the stored UTC timestamp').toBe(jp.seoul);
    });
  });

  test('TC_US089_26 — A search term plus both filters returns only rows satisfying every condition', async ({ page, territoryApi, territoryState, territoryListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_26', 'Medium', TAGS, `With AE changed to 과세 (Required kept), "A" + 과세 + Required returns only rows satisfying all three and includes AE (counter in the Matching-filters form, soft); switching Export declaration to Not required drops AE; Reset + Search shows every row with the "Total {n} countries" counter (soft). Deviation: other users edit rows on the shared dev — each result is checked row by row instead of assuming only AE matches. Data: AE is set to 과세 through the API and restored in teardown.`);
    let rows: Array<{ code: string; name: string; vat: string; exp: string }> = [];
    let total = 0;
    const read = async () => {
      const out: typeof rows = [];
      for (let i = 0; i < (await list.rows.count()); i++) {
        const row = list.rows.nth(i);
        out.push({
          code: ((await list.cell(row, 'country').locator('span').first().textContent()) ?? '').trim(),
          name: ((await list.cell(row, 'country').getAttribute('title')) ?? '').trim(),
          vat: ((await list.cell(row, 'vat').textContent()) ?? '').trim(),
          exp: ((await list.cell(row, 'export').textContent()) ?? '').trim(),
        });
      }
      return out;
    };

    await step('Arrange: Pre-condition 1–3 — AE changed to 과세 while keeping Required', async () => {
      await territoryState.prepare('AE', { vat: 'TAXABLE_STANDARD', exportRequired: true });
      total = (await territoryApi.list()).body.paging.totalCount;
      await list.open('en');
    });

    await step('Act: Step 1 — Type A, VAT treatment = Taxable (standard), Export declaration = Required, Search', async () => {
      await list.setCriteria({ keyword: 'A', vat: 'TAXABLE_STANDARD', exportFlag: 'true' });
      await list.search();
      await list.setPageSize('100');
    });

    await step('Assert: Expected 1 — The table re-filters; the counter reads "Matching filters: {n} · showing {a}-{b}"', async () => {
      expect(parseCounter(((await list.counter.textContent()) ?? '').trim())?.total ?? 0, '[Expected 1] Fewer rows than the full register').toBeLessThan(total);
      await expect.soft(list.counter, '[Expected 1] Counter in the Matching-filters form').toHaveText(MATCHING_FORM);
    });

    await step('Act: Step 2 — Check every row in the result against all three conditions', async () => {
      rows = await read();
    });

    await step('Assert: Expected 2 — Every row contains A, is Taxable (standard) and Required; AE is present', async () => {
      for (const row of rows) {
        expect(`${row.code} ${row.name}`.toUpperCase(), `[Expected 2] ${row.code} contains "A"`).toContain('A');
        expect(row.vat, `[Expected 2] ${row.code} is Taxable (standard)`).toBe('Taxable (standard)');
        expect(row.exp, `[Expected 2] ${row.code} is Required`).toMatch(/^(Required|필요)$/);
      }
      expect(rows.map((r) => r.code), '[Expected 2] AE is present').toContain('AE');
    });

    await step('Act: Step 3 — Change only Export declaration to Not required and Search', async () => {
      await list.setCriteria({ exportFlag: 'false' });
      await list.search();
      rows = await read();
    });

    await step('Assert: Expected 3 — AE disappears from the result', async () => {
      expect(rows.map((r) => r.code), '[Expected 3] AE is dropped').not.toContain('AE');
    });

    await step('Act: Step 4 — Click Reset, then Search', async () => {
      await list.reset();
      await list.search();
    });

    await step('Assert: Expected 4 — Every row again; counter back to "Total {n} countries · showing {a}-{b}"', async () => {
      expect(parseCounter(((await list.counter.textContent()) ?? '').trim())?.total, '[Expected 4] Every row').toBe(total);
      await expect.soft(list.counter, '[Expected 4] Counter in the Total form').toHaveText(TOTAL_FORM);
    });
  });

  test('TC_US089_34 — The no-results state keeps the headers and the pagination bar with the counter at zero', async ({ page, territoryListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_34', 'Medium', TAGS, `Searching ZZZZ replaces the body with "조건에 맞는 결과가 없습니다" plus the second line kept in English ("${EN.noResultsHint}"); the five headers stay, the pagination bar stays with "Matching filters: 0 · showing 0-0" and a single disabled page; 초기화 shows every row from page 1. ${DATA}`);
    let body = '';

    await step('Arrange: Pre-condition 1–2 — Logged in; every ISO code has a row', async () => {
      await list.open();
    });

    await step('Act: Step 1 — Type ZZZZ into the Country box and click Search', async () => {
      await list.setCriteria({ keyword: 'ZZZZ' });
      await list.search();
    });

    await step('Assert: Expected 1 — No row matches', async () => {
      await expect(list.rows.filter({ has: page.locator('td:nth-child(2)') }), '[Expected 1] No data row matches').toHaveCount(0);
    });

    await step('Act: Step 2 — Read the content of the table body', async () => {
      body = ((await list.noResults.innerText()) ?? '').trim();
    });

    await step('Assert: Expected 2 — The body reads 조건에 맞는 결과가 없습니다 plus the English second line', async () => {
      expect(body, '[Expected 2] First line 조건에 맞는 결과가 없습니다').toContain(TERRITORY_TEXT.ko.noResults);
      expect.soft(body, '[Expected 2] Second line kept in English').toContain(EN.noResultsHint);
    });

    await step('Act: Step 3 — Look at the column header area and the pagination bar area', async () => {
      await list.table.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Five headers visible; the pagination bar stays with "Matching filters: 0 · showing 0-0" and one disabled page', async () => {
      await expect(list.headers, '[Expected 3] All five headers stay visible').toHaveCount(5);
      await expect.soft(list.pagination, '[Expected 3] The pagination bar stays').toBeVisible();
      await expect.soft(list.counter, '[Expected 3] Counter reads "Matching filters: 0 · showing 0-0"').toHaveText('Matching filters: 0 · showing 0-0');
    });

    await step('Act: Step 4 — Click Reset', async () => {
      await list.reset();
    });

    await step('Assert: Expected 4 — Every row again from page 1', async () => {
      expect(parseCounter(((await list.counter.textContent()) ?? '').trim())?.from, '[Expected 4] Page 1 of every row').toBe(1);
      await expect(list.rows, '[Expected 4] Ten rows are back').toHaveCount(10);
    });
  });

  test('TC_US089_35 — The search accepts special characters, whitespace-only and a very long string without a system error', async ({ page, territoryListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_35', 'Medium', TAGS, `"%", "' OR 1=1 --" and a 500-character "A…" return no rows with the no-results line and no system error; three spaces are trimmed and show every row; "   kr   " returns KR. ${DATA}`);
    const cases: Array<{ n: number; keyword: string; title: string; expect: 'none' | 'all' | 'KR' }> = [
      { n: 1, keyword: '%', title: 'Type % and click Search', expect: 'none' },
      { n: 2, keyword: "' OR 1=1 --", title: "Reset, type ' OR 1=1 -- and click Search", expect: 'none' },
      { n: 3, keyword: 'A'.repeat(500), title: 'Reset, paste a 500-character string of A and click Search', expect: 'none' },
      { n: 4, keyword: '   ', title: 'Reset, type three spaces and click Search', expect: 'all' },
      { n: 5, keyword: '   kr   ', title: 'Reset, type "   kr   " and click Search', expect: 'KR' },
    ];
    const statuses: Record<number, number> = {};

    await step('Arrange: Pre-condition 1–2 — Logged in; every ISO code has a row', async () => {
      await list.open();
    });

    for (const c of cases) {
      await step(`Act: Step ${c.n} — ${c.title}`, async () => {
        if (c.n > 1) await list.reset();
        await list.searchInput.fill(c.keyword);
        statuses[c.n] = (await list.search()).status();
      });

      await step(`Assert: Expected ${c.n} — ${c.expect === 'none' ? 'No row matches; no system error, the screen still responds' : c.expect === 'all' ? 'The string is trimmed away — every row' : 'The padding is trimmed — KR is returned'}`, async () => {
        expect(statuses[c.n], `[Expected ${c.n}] No system error (5xx) from the list request`).toBeLessThan(500);
        await expect(list.table, `[Expected ${c.n}] The screen does not go blank`).toBeVisible();
        if (c.expect === 'none') await expect(list.noResults, `[Expected ${c.n}] The no-results line is shown`).toContainText(TERRITORY_TEXT.ko.noResults);
        if (c.expect === 'all') expect(parseCounter(((await list.counter.textContent()) ?? '').trim())?.total, `[Expected ${c.n}] Every row is shown`).toBeGreaterThan(200);
        if (c.expect === 'KR') expect(await list.codes(), `[Expected ${c.n}] KR is returned`).toContain('KR');
      });
    }
  });
});
