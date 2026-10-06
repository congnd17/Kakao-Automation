import { test, expect } from '@fixtures/base.fixture';
import { allure } from 'allure-playwright';
import { makeStep } from '@utils/step';
import { Observations } from '@utils/observations';
import { ChannelKey, PaymentMethodPolicy } from '@api/payment-method-policy.api';
import { LIVE_ROW, METHOD_CODES, SEED_ROW as SEED_KEY } from '@utils/payment-method-policy.data';

/**
 * Màn danh sách 결제수단 정책 (US080). Nguồn TC: input/Test_Cases_US080_EN_v1.md — mỗi dòng Steps N / Expected N
 * map đúng 1 step `Act: Step N` / `Assert: Expected N`. TC lệch UI thật → assert theo UI, ghi "Deviation from TC"
 * trong description (quyết định của user 28/09).
 *
 * Register dùng chung giờ có nhiều hơn 7 dòng seed (dòng do automation tạo, không xoá được — BR-18) → mọi con số
 * TC ghi cứng (7 dòng, 3 dòng EXIMBAY·USD…) được tính động từ API ở Arrange rồi đối chiếu với bảng trên UI.
 * Chỉ đọc — không tạo/sửa dữ liệu.
 */
const asRow = (key: ChannelKey) => ({ pg: key.pgCode, method: key.paymentMethodCode, currency: key.currency });
const SEED_ROW = asRow(SEED_KEY);
/** Dòng automation sở hữu, đã sửa nhiều lần (có bản ghi lịch sử) — TC_015 gốc chỉ cần "a row edited at least once". */
const EDITED_ROW = asRow(LIVE_ROW);
const DEVIATION_PG_LABEL = 'Deviation from TC: the PG filter is labelled "PG" on the UI, not "결제관리".';
const DEVIATION_SEED_COUNT =
  'Deviation from TC: the shared register now holds more than the 7 seed rows, so expected row counts are read from the API.';

test.describe('[List] 결제수단 정책 list screen', () => {
  test('TC_US080_004 — The policy list renders every label in Korean', async ({ page, paymentMethodPolicyListPage: list, policyApi }) => {
    const step = makeStep(page);
    await allure.description(
      'Open the 결제수단 정책 list and compare every label on screen against the UI Mapping: filters 결제수단 · 거래금액 ' +
        '통화 · 환율 적용 방식, buttons 검색 · 초기화 · 정책 추가, columns 정산 주기 · 최종 수정 · 작업, pager 페이지당. ' +
        `${DEVIATION_SEED_COUNT} Not automated: the English column of the UI Mapping (the UI only renders Korean).`,
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_004');

    let totalRows = 0;

    await step('Arrange: Pre-condition 1–3 — Logged in as ADMIN, register rows counted via API, UI in Korean', async () => {
      totalRows = (await policyApi.list({}, 1000)).body.totalElements;
    });

    await step('Act: Step 1 — Open the 결제수단 정책 (Payment Method Policy) screen', async () => {
      await list.open();
    });

    await step(`Assert: Expected 1 — The list screen opens with all ${totalRows} register rows`, async () => {
      await expect(list.dataRows.first(), '[Expected 1] The table shows policy rows').toBeVisible();
      await expect(list.pagerTotalText, `[Expected 1] Pager counts all ${totalRows} register rows`).toHaveText(
        new RegExp(`^총 ${totalRows}개의 항목 중`),
      );
    });

    await step('Act: Step 2 — Compare every label on screen against the UI Mapping', async () => {
      await list.pageSizeLabel.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Filters, buttons, columns and pager labels match verbatim', async () => {
      for (const label of ['결제수단', '거래금액 통화', '환율 적용 방식']) {
        await expect(list.filterLabel(label), `[Expected 2] Filter label ${label} is visible`).toBeVisible();
      }
      await expect(list.searchButton, '[Expected 2] 검색 (Search) button is visible').toBeVisible();
      await expect(list.resetButton, '[Expected 2] 초기화 (Reset) button is visible').toBeVisible();
      await expect(list.addPolicyButton, '[Expected 2] 정책 추가 (Add policy) button is visible').toBeVisible();
      for (const column of ['정산 주기', '최종 수정', '작업']) {
        await expect(list.columnHeader(column), `[Expected 2] Column ${column} is visible`).toBeVisible();
      }
      await expect(list.pageSizeLabel, '[Expected 2] Pager label 페이지당 (Per page) is visible').toBeVisible();
    });
  });

  test('TC_US080_010 — Combined filters return only rows matching every criterion', async ({ page, paymentMethodPolicyListPage: list, policyApi }) => {
    const step = makeStep(page);
    await allure.description(
      'Set PG = EXIMBAY and 거래금액 통화 = USD: the table does not change until 검색 is clicked; after 검색 it shows exactly ' +
        `the register rows carrying both EXIMBAY and USD — no row slips through on one condition. ${DEVIATION_PG_LABEL} ` +
        DEVIATION_SEED_COUNT,
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_010');

    let expectedRows = 0;
    let totalRows = 0;
    let firstColumnBefore: string[] = [];

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN, EXIMBAY · USD rows counted via API', async () => {
      totalRows = (await policyApi.list({}, 1000)).body.totalElements;
      expectedRows = (await policyApi.list({ pgCode: 'EXIMBAY', currency: 'USD' }, 1000)).body.totalElements;
      await list.open();
      firstColumnBefore = await list.columnTexts(1);
    });

    await step('Act: Step 1 — Set PG = EXIMBAY and 거래금액 통화 (Transaction currency) = USD', async () => {
      await list.fillFilters({ pg: 'EXIMBAY', currency: 'USD' });
    });

    await step('Assert: Expected 1 — The table has not changed; the two filters are still only in draft', async () => {
      await expect(list.pagerTotalText, '[Expected 1] Pager still counts every row').toHaveText(new RegExp(`^총 ${totalRows}개의 항목 중`));
      expect(await list.columnTexts(1), '[Expected 1] Rows on screen are unchanged').toEqual(firstColumnBefore);
    });

    await step('Act: Step 2 — Click 검색 (Search)', async () => {
      await list.clickSearch();
    });

    await step(`Assert: Expected 2 — Exactly ${expectedRows} rows, every one carrying EXIMBAY and USD`, async () => {
      await expect(list.dataRows, `[Expected 2] Table shows exactly ${expectedRows} rows`).toHaveCount(expectedRows);
      const pgs = await list.columnTexts(1);
      const currencies = await list.columnTexts(3);
      for (const [row, pg] of pgs.entries()) {
        expect(pg, `[Expected 2] Row ${row + 1} PG is EXIMBAY`).toBe('EXIMBAY');
        expect(currencies[row], `[Expected 2] Row ${row + 1} 거래금액 통화 is USD`).toBe('USD');
      }
    });
  });

  test('TC_US080_011 — Reset clears draft and applied filters and returns to page 1', async ({ page, paymentMethodPolicyListPage: list, policyApi }) => {
    const step = makeStep(page);
    await allure.description(
      'With PG = EXIMBAY applied, click 초기화: every filter returns to 전체, the table shows every register row again ' +
        `and the list is back on page 1 — without clicking 검색. ${DEVIATION_PG_LABEL} ${DEVIATION_SEED_COUNT}`,
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_011');

    let totalRows = 0;

    await step('Arrange: Pre-condition 1–3 — Logged in as ADMIN, list open with PG = EXIMBAY already applied', async () => {
      totalRows = (await policyApi.list({}, 1000)).body.totalElements;
      await list.open();
      await list.fillFilters({ pg: 'EXIMBAY' });
      await list.clickSearch();
    });

    await step('Act: Step 1 — Click 초기화 (Reset)', async () => {
      await list.clickReset();
    });

    await step('Assert: Expected 1 — Every filter is 전체, all rows are shown again, the list is on page 1', async () => {
      await expect(list.pgFilterSelect, '[Expected 1] PG filter is back to 전체 (All)').toHaveValue('');
      await expect(list.methodFilterSelect, '[Expected 1] 결제수단 filter is back to 전체 (All)').toHaveValue('');
      await expect(list.currencyFilterSelect, '[Expected 1] 거래금액 통화 filter is back to 전체 (All)').toHaveValue('');
      await expect(list.strategyFilterSelect, '[Expected 1] 환율 적용 방식 filter is back to 전체 (All)').toHaveValue('');
      await expect(list.pagerTotalText, `[Expected 1] Table shows all ${totalRows} rows again`).toHaveText(new RegExp(`^총 ${totalRows}개의 항목 중 1-`));
      await expect.poll(() => list.isOnFirstPage(), { message: '[Expected 1] List is on page 1' }).toBe(true);
    });
  });

  test('TC_US080_012 — Clicking a row opens the edit form directly', async ({
    page,
    paymentMethodPolicyListPage: list,
    paymentMethodPolicyFormPage: form,
    policyApi,
  }) => {
    const step = makeStep(page);
    await allure.description(
      'Click the body of the NICEPAY · CREDIT_CARD · KRW row (not the 작업 cell): the edit form opens straight away with ' +
        'the values pre-filled — no read-only detail screen in between. Read-only: the form is not saved.',
    );
    await allure.severity('critical');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_012');

    let seed: PaymentMethodPolicy | undefined;

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN, seed row NICEPAY · CREDIT_CARD · KRW read via API', async () => {
      seed = (await policyApi.getByKey({ pgCode: SEED_ROW.pg, paymentMethodCode: SEED_ROW.method, currency: SEED_ROW.currency })).body.holder;
      expect(seed, '[Pre-condition 2] Seed row NICEPAY · CREDIT_CARD · KRW exists').toBeDefined();
      await list.open();
      await list.searchKey(SEED_ROW.pg, SEED_ROW.method, SEED_ROW.currency);
    });

    await step('Act: Step 1 — Click the body of the NICEPAY · CREDIT_CARD · KRW row', async () => {
      await list.openRow(SEED_ROW.pg, SEED_ROW.method, SEED_ROW.currency);
    });

    await step('Assert: Expected 1 — The form opens straight into edit mode with the values pre-filled', async () => {
      await expect(page, '[Expected 1] Edit form of that row opens directly').toHaveURL(new RegExp(`/payment-method-policies/${seed!.id}$`));
      await expect(form.strategySelect, '[Expected 1] 환율 적용 방식 is pre-filled').toHaveValue(seed!.fxSourceStrategy);
      await expect(form.cycleTypeSelect, '[Expected 1] 정산 주기 is pre-filled').toHaveValue(seed!.cycleType);
      await expect(form.lagInput, '[Expected 1] 지연일수 is pre-filled').toHaveValue(String(seed!.cycleLagDays));
      await expect(form.lagInput, '[Expected 1] The form is editable — not a read-only detail screen').toBeEditable();
    });
  });

  test('TC_US080_013 — The PG filter applies only after Search is clicked', async ({ page, paymentMethodPolicyListPage: list, policyApi }) => {
    const step = makeStep(page);
    await allure.description(
      'Set PG = NICEPAY and click nothing else: the table still shows every row (no filter-as-you-type). After 검색 it ' +
        `shows exactly the NICEPAY rows and returns to page 1. ${DEVIATION_PG_LABEL} ${DEVIATION_SEED_COUNT}`,
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_013');

    let totalRows = 0;
    let nicepayRows = 0;

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN, NICEPAY rows counted via API, list open', async () => {
      totalRows = (await policyApi.list({}, 1000)).body.totalElements;
      nicepayRows = (await policyApi.list({ pgCode: 'NICEPAY' }, 1000)).body.totalElements;
      await list.open();
    });

    await step('Act: Step 1 — Set PG = NICEPAY and click nothing else', async () => {
      await list.fillFilters({ pg: 'NICEPAY' });
    });

    await step(`Assert: Expected 1 — The table still shows all ${totalRows} rows`, async () => {
      await expect(list.pagerTotalText, `[Expected 1] Pager still counts all ${totalRows} rows`).toHaveText(new RegExp(`^총 ${totalRows}개의 항목 중`));
    });

    await step('Act: Step 2 — Click 검색 (Search)', async () => {
      await list.clickSearch();
    });

    await step(`Assert: Expected 2 — Exactly the ${nicepayRows} NICEPAY rows, back on page 1`, async () => {
      await expect(list.pagerTotalText, `[Expected 2] Pager counts exactly ${nicepayRows} rows`).toHaveText(new RegExp(`^총 ${nicepayRows}개의 항목 중 1-`));
      for (const [row, pg] of (await list.columnTexts(1)).entries()) {
        expect(pg, `[Expected 2] Row ${row + 1} PG is NICEPAY`).toBe('NICEPAY');
      }
      await expect.poll(() => list.isOnFirstPage(), { message: '[Expected 2] List is on page 1' }).toBe(true);
    });
  });

  test('TC_US080_014 — The empty state appears when filters match no row', async ({ page, paymentMethodPolicyListPage: list, policyApi }) => {
    const step = makeStep(page);
    await allure.description(
      'Filter on a PG × 결제수단 pair that has no policy row: the table holds no rows and shows the empty state ' +
        '"조건에 맞는 정책이 없습니다" with its sub-line, and there is no create button inside that block. ' +
        'Deviation from TC: NICEPAY · ALIPAY now has automation-created rows, so the test picks an empty pair via the ' +
        'API; the sub-line on the UI reads "조건을 초기화하면 설정된 모든 채널을 볼 수 있습니다." (TC: "초기화를 눌러 등록된 모든 ' +
        `채널을 확인하세요."). ${DEVIATION_PG_LABEL}`,
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_014');

    let emptyPair = { pg: '', method: '' };

    await step('Arrange: Pre-condition 1–3 — Logged in as ADMIN, a PG × 결제수단 pair with no row picked via API, UI in Korean', async () => {
      const [rows, catalog] = [(await policyApi.list({}, 1000)).body.content, (await policyApi.getCatalog()).body];
      const pair = catalog.pgCodes
        .flatMap((pg) => catalog.paymentMethodCodes.map((method) => ({ pg, method })))
        .find(({ pg, method }) => !rows.some((row) => row.pgCode === pg && row.paymentMethodCode === method));
      expect(pair, '[Pre-condition 2] A PG × 결제수단 pair without any policy row exists').toBeDefined();
      emptyPair = pair!;
      await list.open();
    });

    await step(`Act: Step 1 — Set PG = ${emptyPair.pg}, 결제수단 = ${emptyPair.method}, click 검색 (Search)`, async () => {
      await list.fillFilters({ pg: emptyPair.pg, method: emptyPair.method });
      await list.clickSearch();
    });

    await step('Assert: Expected 1 — No rows; the empty state and its sub-line show; no create button inside the block', async () => {
      await expect(list.dataRows, '[Expected 1] The table holds no policy rows').toHaveCount(0);
      await expect(list.emptyStateTitle, '[Expected 1] Empty state "조건에 맞는 정책이 없습니다" is visible').toBeVisible();
      await expect(list.emptyStateSubLine, '[Expected 1] Empty state sub-line is visible').toBeVisible();
      await expect(list.emptyStateBlock.getByRole('button'), '[Expected 1] No create button inside the empty-state block').toHaveCount(0);
    });
  });

  test('TC_US080_015 — The Change history link opens the dialog without entering edit mode', async ({
    page,
    paymentMethodPolicyListPage: list,
    paymentMethodPolicyFormPage: form,
  }) => {
    const step = makeStep(page);
    await allure.description(
      'On a row that has been edited at least once, click the 변경 이력 link in its 작업 cell: the history dialog opens ' +
        'over the list; the URL and the background list are unchanged and the edit form does not open. Runs on the ' +
        'automation-owned row NICEPAY · KAKAO_PAY · KRW (edited many times).',
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_015');

    let listUrl = '';

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN, list filtered to the edited row NICEPAY · KAKAO_PAY · KRW', async () => {
      await list.open();
      await list.searchKey(EDITED_ROW.pg, EDITED_ROW.method, EDITED_ROW.currency);
      listUrl = page.url();
    });

    await step('Act: Step 1 — Click the 변경 이력 (Change history) link in that row\'s 작업 (Action) cell', async () => {
      const row = list.rowByKey(EDITED_ROW.pg, EDITED_ROW.method, EDITED_ROW.currency);
      await list.historyLinkInRow(row).click();
      await form.waitForHistoryLoaded();
    });

    await step('Assert: Expected 1 — The dialog opens over the list; URL and background unchanged; no edit form', async () => {
      await expect(form.historyDialog, '[Expected 1] 변경 이력 (Change history) dialog is open').toBeVisible();
      expect(page.url(), '[Expected 1] URL is unchanged').toBe(listUrl);
      await expect(list.rowByKey(EDITED_ROW.pg, EDITED_ROW.method, EDITED_ROW.currency), '[Expected 1] Background list row is still there').toHaveCount(1);
      await expect(form.lagInput, '[Expected 1] The edit form does not open').toHaveCount(0);
    });
  });

  test('TC_US080_016 — Paging and page size behave at first page, last page and on change', async ({ page, paymentMethodPolicyListPage: list, policyApi }) => {
    const step = makeStep(page);
    const observations = new Observations(page);
    await allure.description(
      'With page size 10 go to the last page: Next and Last are disabled and the pager reads "총 {n}개의 항목 중 {a}-{b}개 ' +
        '표시" with n = the real row count. Change page size to 20, 50 and 100: each change re-renders from page 1 with ' +
        `exactly that many rows (or all rows when fewer). ${DEVIATION_SEED_COUNT}`,
    );
    await allure.severity('minor');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_016');

    let totalRows = 0;

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN, register holds more rows than one page of 10', async () => {
      totalRows = (await policyApi.list({}, 1000)).body.totalElements;
      expect(totalRows, '[Pre-condition 2] Register holds more than 10 rows').toBeGreaterThan(10);
      await list.open();
    });

    await step('Act: Step 1 — Set 페이지당 (Per page) = 10 and go to the last page', async () => {
      await list.setPageSize('10');
      await list.goToPage('Last');
    });

    await step('Assert: Expected 1 — Next and Last are disabled; the pager shows the real range and total', async () => {
      const lastStart = Math.floor((totalRows - 1) / 10) * 10 + 1;
      await expect(list.pagerItem('Next'), '[Expected 1] Next-page button is disabled on the last page').toHaveClass(/disabled/);
      await expect(list.pagerItem('Last'), '[Expected 1] Last-page button is disabled on the last page').toHaveClass(/disabled/);
      await expect(list.pagerTotalText, `[Expected 1] Pager reads 총 ${totalRows}개의 항목 중 ${lastStart}-${totalRows}개 표시`).toHaveText(
        `총 ${totalRows}개의 항목 중 ${lastStart}-${totalRows}개 표시`,
      );
    });

    await step('Act: Step 2 — Change 페이지당 (Per page) to 20, then 50, then 100', async () => {
      for (const size of [20, 50, 100]) {
        await list.setPageSize(String(size));
        const shown = Math.min(size, totalRows);
        await observations.record(`[Expected 2] Page size ${size}: list is on page 1`, () => list.isOnFirstPage());
        await observations.record(`[Expected 2] Page size ${size}: exactly ${shown} rows are shown`, async () => (await list.dataRows.count()) === shown);
        await observations.record(`[Expected 2] Page size ${size}: pager reads 1-${shown}`, async () =>
          ((await list.pagerTotalText.textContent()) ?? '').includes(`총 ${totalRows}개의 항목 중 1-${shown}개 표시`),
        );
        await observations.screenshot(`Page size ${size}`);
      }
    });

    await step('Assert: Expected 2 — After each page-size change the list re-renders from page 1 with that many rows', async () => {
      observations.assertAll();
    });
  });

  test('TC_US080_017 — The Payment method filter offers all 9 codes plus All', async ({ page, paymentMethodPolicyListPage: list }) => {
    const step = makeStep(page);
    await allure.description('Open the 결제수단 filter: it holds exactly 10 entries — 전체 plus the 9 payment method codes.');
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_017');

    await step('Arrange: Pre-condition 1 — Logged in as ADMIN, list open', async () => {
      await list.open();
    });

    await step('Act: Step 1 — Open the 결제수단 (Payment method) dropdown', async () => {
      await list.methodFilterSelect.focus();
    });

    await step('Assert: Expected 1 — Exactly 10 entries: 전체 plus the 9 codes', async () => {
      await expect(list.methodFilterSelect.locator('option'), '[Expected 1] Dropdown holds exactly 10 entries').toHaveCount(10);
      await expect(list.methodFilterSelect.locator('option[value=""]'), '[Expected 1] Entry 전체 (All) is offered').toHaveText('전체');
      for (const code of METHOD_CODES) {
        await expect(list.methodFilterSelect.locator(`option[value="${code}"]`), `[Expected 1] Entry ${code} is offered`).toHaveText(code);
      }
    });
  });

  test('TC_US080_018 — Choosing a PG does not narrow the Payment method list', async ({ page, paymentMethodPolicyListPage: list }) => {
    const step = makeStep(page);
    await allure.description(
      'Count the 결제수단 entries, set PG = NICEPAY, count again: still exactly 10 — nothing is hidden, including ' +
        `CREDIT_CARD_GLOBAL (seeded only under EXIMBAY). ${DEVIATION_PG_LABEL}`,
    );
    await allure.severity('critical');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_018');

    let firstCount = 0;
    let secondCount = 0;

    await step('Arrange: Pre-condition 1 — Logged in as ADMIN, list open', async () => {
      await list.open();
    });

    await step('Act: Step 1 — Open the 결제수단 (Payment method) dropdown and count its entries', async () => {
      firstCount = await list.methodFilterSelect.locator('option').count();
    });

    await step('Assert: Expected 1 — The dropdown holds 10 entries', async () => {
      expect(firstCount, '[Expected 1] 결제수단 dropdown holds 10 entries').toBe(10);
    });

    await step('Act: Step 2 — Set PG = NICEPAY, reopen the 결제수단 dropdown and count again', async () => {
      await list.fillFilters({ pg: 'NICEPAY' });
      secondCount = await list.methodFilterSelect.locator('option').count();
    });

    await step('Assert: Expected 2 — Still exactly 10 entries, CREDIT_CARD_GLOBAL included', async () => {
      expect(secondCount, '[Expected 2] 결제수단 dropdown still holds exactly 10 entries').toBe(10);
      await expect(list.methodFilterSelect.locator('option[value="CREDIT_CARD_GLOBAL"]'), '[Expected 2] CREDIT_CARD_GLOBAL is still offered').toHaveCount(1);
    });
  });

  test('TC_US080_019 — The Currency filter offers KRW, USD and JPY', async ({ page, paymentMethodPolicyListPage: list }) => {
    const step = makeStep(page);
    await allure.description('Open the 거래금액 통화 filter: exactly 4 entries in order 전체 · KRW · USD · JPY — not all of ISO 4217.');
    await allure.severity('minor');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_019');

    await step('Arrange: Pre-condition 1 — Logged in as ADMIN, list open', async () => {
      await list.open();
    });

    await step('Act: Step 1 — Open the 거래금액 통화 (Transaction currency) dropdown', async () => {
      await list.currencyFilterSelect.focus();
    });

    await step('Assert: Expected 1 — Exactly 4 entries in order: 전체 · KRW · USD · JPY', async () => {
      const options = list.currencyFilterSelect.locator('option');
      await expect(options, '[Expected 1] Dropdown holds exactly 4 entries').toHaveCount(4);
      for (const [index, label] of ['전체', 'KRW', 'USD', 'JPY'].entries()) {
        await expect(options.nth(index), `[Expected 1] Entry ${index + 1} is ${label}`).toHaveText(label);
      }
    });
  });

  test('TC_US080_020 — The FX source filter offers exactly two values plus All', async ({ page, paymentMethodPolicyListPage: list }) => {
    const step = makeStep(page);
    await allure.description('Open the 환율 적용 방식 filter: exactly 3 entries — 전체 · 이미 KRW · 정산환율; no third value.');
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_020');

    await step('Arrange: Pre-condition 1 — Logged in as ADMIN, list open', async () => {
      await list.open();
    });

    await step('Act: Step 1 — Open the 환율 적용 방식 (FX source strategy) dropdown', async () => {
      await list.strategyFilterSelect.focus();
    });

    await step('Assert: Expected 1 — Exactly 3 entries: 전체 · 이미 KRW · 정산환율', async () => {
      const options = list.strategyFilterSelect.locator('option');
      await expect(options, '[Expected 1] Dropdown holds exactly 3 entries').toHaveCount(3);
      for (const [index, label] of ['전체', '이미 KRW', '정산환율'].entries()) {
        await expect(options.nth(index), `[Expected 1] Entry ${index + 1} is ${label}`).toHaveText(label);
      }
    });
  });

  test('TC_US080_021 — The fixed sort groups a channel\'s KRW and USD rows together', async ({ page, paymentMethodPolicyListPage: list, policyApi }) => {
    const step = makeStep(page);
    await allure.description(
      'The two seed rows EXIMBAY · CREDIT_CARD_GLOBAL · KRW (이미 KRW) and · USD (정산환율) sit next to each other in the ' +
        'fixed sort, differing only in currency and carrying different 환율 적용 방식 values; clicking the 정산 주기 ' +
        'header does not re-sort. Page size is raised to 100 so the whole register is on one page.',
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_021');

    let keysBefore: string[] = [];
    let keysAfter: string[] = [];
    const key = (pg: string, method: string, currency: string) => `${pg} · ${method} · ${currency}`;
    const readKeys = async () => {
      const [pgs, methods, currencies] = [await list.columnTexts(1), await list.columnTexts(2), await list.columnTexts(3)];
      return pgs.map((pg, i) => key(pg, methods[i], currencies[i]));
    };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN, both EXIMBAY · CREDIT_CARD_GLOBAL seed rows exist', async () => {
      for (const currency of ['KRW', 'USD']) {
        const { body } = await policyApi.getByKey({ pgCode: 'EXIMBAY', paymentMethodCode: 'CREDIT_CARD_GLOBAL', currency });
        expect(body.taken, `[Pre-condition 2] EXIMBAY · CREDIT_CARD_GLOBAL · ${currency} exists`).toBe(true);
      }
      await list.open();
      await list.setPageSize('100');
    });

    await step('Act: Step 1 — Open the list screen and read the row order', async () => {
      keysBefore = await readKeys();
    });

    await step('Assert: Expected 1 — The KRW and USD rows sit next to each other with different 환율 적용 방식', async () => {
      const krw = keysBefore.indexOf(key('EXIMBAY', 'CREDIT_CARD_GLOBAL', 'KRW'));
      const usd = keysBefore.indexOf(key('EXIMBAY', 'CREDIT_CARD_GLOBAL', 'USD'));
      expect(krw, '[Expected 1] EXIMBAY · CREDIT_CARD_GLOBAL · KRW is listed').toBeGreaterThanOrEqual(0);
      expect(usd, '[Expected 1] EXIMBAY · CREDIT_CARD_GLOBAL · USD is listed').toBeGreaterThanOrEqual(0);
      expect(Math.abs(krw - usd), '[Expected 1] The two rows sit next to each other').toBe(1);
      await expect(list.rowByKey('EXIMBAY', 'CREDIT_CARD_GLOBAL', 'KRW'), '[Expected 1] KRW row carries 이미 KRW').toContainText('이미 KRW');
      await expect(list.rowByKey('EXIMBAY', 'CREDIT_CARD_GLOBAL', 'USD'), '[Expected 1] USD row carries 정산환율').toContainText('정산환율');
    });

    await step('Act: Step 2 — Try clicking the 정산 주기 (Settlement cycle) column header', async () => {
      await list.columnHeader('정산 주기').click();
      keysAfter = await readKeys();
    });

    await step('Assert: Expected 2 — The order does not change', async () => {
      expect(keysAfter, '[Expected 2] Row order is unchanged — the user cannot re-sort').toEqual(keysBefore);
    });
  });

  test('TC_US080_022 — Long cell text is not cut off at the supported desktop width', async ({ page, paymentMethodPolicyListPage: list }) => {
    const step = makeStep(page);
    await allure.description(
      'Find the longest 정산 주기 (Settlement cycle) cell and hover it. Deviation from TC: at 1920×1080 the UI does not ' +
        'truncate cells with "…" and a tooltip — every cell renders its full text (the table scrolls inside its own ' +
        'container at narrower widths, see TC_US080_077). The test therefore asserts that the longest cell shows its full ' +
        'content without clipping and that the table does not overflow its container; no tooltip is expected.',
    );
    await allure.severity('normal');
    await allure.tags('regression', 'ui', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_022');

    let longestIndex = 0;

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN, list open with every row on one page', async () => {
      await list.open();
      await list.setPageSize('100');
    });

    await step('Act: Step 1 — Open the list screen and find the longest 정산 주기 (Settlement cycle) cell', async () => {
      const cycles = await list.columnTexts(5);
      longestIndex = cycles.reduce((best, text, i) => (text.length > cycles[best].length ? i : best), 0);
    });

    await step('Assert: Expected 1 — The cell shows its full text and does not widen the table past its container', async () => {
      const cell = list.dataRows.nth(longestIndex).locator('td:nth-child(5)');
      const clipped = await cell.evaluate((td) => Array.from(td.querySelectorAll('*')).concat(td).some((el) => el.scrollWidth > el.clientWidth));
      expect(clipped, '[Expected 1] The longest 정산 주기 cell is not cut off').toBe(false);
      const [tableBox, containerBox] = [await list.table.boundingBox(), await list.tableContainer.boundingBox()];
      expect(tableBox!.width, '[Expected 1] The table is not wider than its container').toBeLessThanOrEqual(containerBox!.width + 1);
    });

    await step('Act: Step 2 — Hover over that cell', async () => {
      await list.dataRows.nth(longestIndex).locator('td:nth-child(5)').hover();
    });

    await step('Assert: Expected 2 — The full content is readable (shown in the cell itself, no tooltip needed)', async () => {
      const cell = list.dataRows.nth(longestIndex).locator('td:nth-child(5)');
      await expect(cell, '[Expected 2] The cell is visible while hovered').toBeVisible();
      expect(await cell.getAttribute('title'), '[Expected 2] No truncation tooltip — the cell already shows everything').toBeNull();
    });
  });
});
