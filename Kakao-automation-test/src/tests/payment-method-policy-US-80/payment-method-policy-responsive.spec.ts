import { test, expect } from '@fixtures/base.fixture';
import { allure } from 'allure-playwright';
import { makeStep } from '@utils/step';
import { Labeled, Observations } from '@utils/observations';
import { hasHorizontalPageScroll, isClipped, isInsideContainerWidth, isWithinViewportWidth, scrollsInside, setPageZoom } from '@utils/layout';
import { PaymentMethodPolicyListPage } from '@pages/payment-method-policy-list.page';
import { PaymentMethodPolicyFormPage } from '@pages/payment-method-policy-form.page';
import { LIVE_ROW, SEED_ROW, formatChannelKey, liveRow } from '@utils/payment-method-policy.data';

/**
 * Responsive 결제수단 정책 (US080) — 1920×1080 / 1366×768 và zoom 100/80/125%. Nguồn TC: input/Test_Cases_US080_EN_v1.md —
 * mỗi dòng Steps N / Expected N map đúng 1 step `Act: Step N` / `Assert: Expected N`. Dòng TC trải qua nhiều màn hình
 * → ghi nhận trong Act, assert trong Assert (Observations). TC lệch UI → assert theo UI (quyết định 28/09); TC_077/079
 * giữ quyết định "accepted behaviour" ngày 26/09 (tràn được chứa trong vùng cuộn riêng). Chỉ đọc — không lưu gì.
 */
const DESKTOP = { width: 1920, height: 1080 };
const LAPTOP = { width: 1366, height: 768 };
const LIST_COLUMNS = ['PG', '결제수단', '거래금액 통화', '환율 적용 방식', '정산 주기', '최종 수정', '작업'];
const LIST_FILTERS = ['PG', '결제수단', '거래금액 통화', '환율 적용 방식'];

function listElements(list: PaymentMethodPolicyListPage): Labeled[] {
  return [
    ...LIST_COLUMNS.map((name) => ({ name: `column ${name}`, locator: list.columnHeader(name) })),
    ...LIST_FILTERS.map((name) => ({ name: `filter ${name}`, locator: list.filterLabel(name) })),
    { name: '검색 (Search) button', locator: list.searchButton },
    { name: '초기화 (Reset) button', locator: list.resetButton },
    { name: '정책 추가 (Add policy) button', locator: list.addPolicyButton },
    { name: 'pager total', locator: list.pagerTotalText },
    { name: 'pager 페이지당', locator: list.pageSizeSelect },
    { name: 'pager buttons', locator: list.activePageItem },
  ];
}

function formElements(form: PaymentMethodPolicyFormPage, mode: 'create' | 'edit'): Labeled[] {
  const common: Labeled[] = [
    { name: '채널 키 panel', locator: form.channelKeyPanelTitle },
    { name: '환율 적용 방식', locator: form.strategySelect },
    { name: '정산 주기', locator: form.cycleTypeSelect },
    { name: '지연일수', locator: form.lagInput },
    { name: '이것이 의미하는 바 block', locator: form.whatThisMeansTitle },
    { name: '목록으로 button', locator: form.backToListButton },
    { name: '저장 button', locator: form.saveButton },
  ];
  return mode === 'create'
    ? [...common, { name: 'PG', locator: form.pgSelect }, { name: '결제수단', locator: form.methodSelect }, { name: '거래금액 통화', locator: form.currencySelect }, { name: '기준 요일', locator: form.anchorSelect }]
    : [...common, { name: 'key PG (plain text)', locator: form.keyPlainValue('PG') }, { name: '변경 이력 button', locator: form.historyButton }];
}

function formHints(form: PaymentMethodPolicyFormPage, mode: 'create' | 'edit'): Labeled[] {
  const hints: Labeled[] = [
    { name: '환율 적용 방식 hint', locator: form.hintFor(form.strategySelect) },
    { name: '정산 주기 hint', locator: form.hintFor(form.cycleTypeSelect) },
    { name: '지연일수 hint', locator: form.lagHint },
  ];
  return mode === 'create'
    ? [...hints, { name: 'PG hint', locator: form.hintFor(form.pgSelect) }, { name: '결제수단 hint', locator: form.hintFor(form.methodSelect) }, { name: '거래금액 통화 hint', locator: form.hintFor(form.currencySelect) }]
    : [...hints, { name: 'key lock hint', locator: form.channelKeyLockedHint }];
}

async function recordFullyVisible(observations: Observations, items: Labeled[], tag: string): Promise<void> {
  for (const { name, locator } of items) {
    await observations.record(`${tag} ${name} is visible`, () => locator.isVisible());
    await observations.record(`${tag} ${name} is not clipped`, async () => !(await isClipped(locator)));
  }
}

test.describe('[Responsive] 결제수단 정책 at the supported resolutions and zoom levels', () => {
  test('TC_US080_077 — The list screen at 1366x768 and 1920x1080', async ({ page, paymentMethodPolicyListPage: list }) => {
    const step = makeStep(page);
    await allure.description(
      'At 1920×1080 every column, the filters, 검색 · 초기화 · 정책 추가 and the pager are fully visible with no horizontal ' +
        'scrollbar; at 1366×768 everything is still present and nothing is cut off. Deviations from TC: the UI has four ' +
        'filters (PG · 결제수단 · 거래금액 통화 · 환율 적용 방식; TC: "three"); at 1366×768 the table is wider than its card and ' +
        'scrolls inside its own container instead of truncating long text with a tooltip — accepted behaviour (26/09), ' +
        'asserted as "overflow contained, no page-level horizontal scrollbar". Not automated: "nothing overlaps".',
    );
    await allure.severity('normal');
    await allure.tags('regression', 'responsive', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_077');

    await step('Arrange: Pre-condition 1–3 — Logged in as ADMIN, register rows present, zoom 100%', async () => {
      await page.setViewportSize(DESKTOP);
    });

    await step('Act: Step 1 — Open the 결제수단 정책 screen at 1920×1080 and inspect the layout', async () => {
      await list.open();
    });

    await step('Assert: Expected 1 — Every column, filter, button and the pager fully visible; no horizontal scrollbar', async () => {
      for (const { name, locator } of listElements(list)) {
        await expect(locator, `[Expected 1] ${name} is visible`).toBeVisible();
        expect(await isClipped(locator), `[Expected 1] ${name} is not clipped`).toBe(false);
      }
      expect(await hasHorizontalPageScroll(page), '[Expected 1] No horizontal scrollbar on the page').toBe(false);
      expect(await scrollsInside(list.tableContainer, 'x'), '[Expected 1] The table fits its container at 1920 (no inner scroll)').toBe(false);
    });

    await step('Act: Step 2 — Resize the window to 1366×768 and inspect it again', async () => {
      await page.setViewportSize(LAPTOP);
      await list.waitForTableLoaded();
    });

    await step('Assert: Expected 2 — Everything still present, nothing cut off; table overflow stays inside its container', async () => {
      for (const { name, locator } of listElements(list)) {
        await expect(locator, `[Expected 2] ${name} is still present`).toBeVisible();
        if (!name.startsWith('column')) expect(await isClipped(locator), `[Expected 2] ${name} is not cut off`).toBe(false);
      }
      expect(await hasHorizontalPageScroll(page), '[Expected 2] No page-level horizontal scrollbar — overflow is contained').toBe(false);
    });
  });

  test('TC_US080_078 — The create/edit form at both supported resolutions', async ({ page, paymentMethodPolicyListPage: list, paymentMethodPolicyFormPage: form, policyApi }) => {
    const step = makeStep(page);
    const desktop = new Observations(page);
    const laptop = new Observations(page);
    let seedId = 0;
    await allure.description(
      'At 1920×1080 the create form and then the edit form (seed row) show the 채널 키 panel, the policy value fields, the ' +
        '이것이 의미하는 바 block and the footer buttons fully, with hints not clipped; at 1366×768 both modes still show ' +
        'everything, no field overflows its container and no button is pushed out of sight. Deviation from TC: the UI has ' +
        `four policy value fields (환율 적용 방식 · 정산 주기 · 기준 요일 · 지연일수; TC: "three"); the edit form of ${formatChannelKey(SEED_ROW)} ` +
        '(DAILY) has no 기준 요일 field by design. Read-only.',
    );
    await allure.severity('normal');
    await allure.tags('regression', 'responsive', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_078');

    const inspect = async (observations: Observations, tag: string) => {
      for (const mode of ['create', 'edit'] as const) {
        if (mode === 'create') await form.openCreate();
        else await form.open(seedId);
        await recordFullyVisible(observations, formElements(form, mode), `${tag} ${mode}:`);
        await recordFullyVisible(observations, formHints(form, mode), `${tag} ${mode}:`);
        for (const { name, locator } of formElements(form, mode)) {
          await observations.record(`${tag} ${mode}: ${name} does not overflow its container`, () => isInsideContainerWidth(locator, locator.locator('xpath=..')));
          await observations.record(`${tag} ${mode}: ${name} is not pushed out of sight`, () => isWithinViewportWidth(locator, page));
        }
        await observations.screenshot(`${tag} ${mode} form`);
      }
    };

    await step('Arrange: Pre-condition 1–3 — Logged in as ADMIN, seed row available, zoom 100%', async () => {
      seedId = (await policyApi.getByKey(SEED_ROW)).body.holder!.id;
      await page.setViewportSize(DESKTOP);
      await list.open();
    });

    await step('Act: Step 1 — Open the create form at 1920×1080, then the edit form, and inspect both layouts', async () => {
      await inspect(desktop, '[Expected 1] 1920×1080');
    });

    await step('Assert: Expected 1 — Key panel, value fields, 이것이 의미하는 바 and footer fully visible; hints not clipped', async () => {
      desktop.assertAll();
    });

    await step('Act: Step 2 — Resize the window to 1366×768 and inspect both modes again', async () => {
      await page.setViewportSize(LAPTOP);
      await inspect(laptop, '[Expected 2] 1366×768');
    });

    await step('Assert: Expected 2 — Everything still present; no field overflows, no button pushed out of sight', async () => {
      laptop.assertAll();
    });
  });

  test('TC_US080_079 — Both modals at both supported resolutions', async ({ page, paymentMethodPolicyFormPage: form, policyApi }) => {
    const step = makeStep(page);
    const desktop = new Observations(page);
    const laptop = new Observations(page);
    let rowId = 0;
    let lag = 0;
    await allure.description(
      `On ${formatChannelKey(LIVE_ROW)} (edited many times): at 1920×1080 the 변경 이력 dialog shows its five columns ` +
        'without clipping and the save-confirmation dialog shows the full 변경 내용 block with 뒤로 · 확인 및 저장; at ' +
        '1366×768 both dialogs fit the viewport width and their footer buttons stay clickable without horizontal scrolling. ' +
        'Deviation from TC (accepted 26/09): the history dialog with many records is taller than the viewport and scrolls ' +
        'inside the modal — asserted as "footer reachable, no horizontal scrolling" instead of "fits entirely". Nothing ' +
        'is saved — the confirmation dialog is closed with 뒤로.',
    );
    await allure.severity('minor');
    await allure.tags('regression', 'responsive', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_079');

    const inspect = async (observations: Observations, tag: string) => {
      await form.open(rowId);
      await form.openHistory();
      const headers = form.historyTable.locator('thead th');
      await observations.record(`${tag} history dialog shows five columns`, async () => (await headers.count()) === 5);
      for (let i = 0; i < 5; i++) {
        await observations.record(`${tag} history column ${i + 1} is not clipped`, async () => !(await isClipped(headers.nth(i))));
      }
      await observations.record(`${tag} history dialog fits the viewport width`, () => isWithinViewportWidth(form.historyDialog.locator('.modal-content'), page));
      await form.historyCloseButton.scrollIntoViewIfNeeded();
      await observations.record(`${tag} history 닫기 is clickable`, async () => (await form.historyCloseButton.isVisible()) && (await form.historyCloseButton.isEnabled()));
      await observations.record(`${tag} no horizontal scrolling with the history dialog`, async () => !(await hasHorizontalPageScroll(page)));
      await observations.screenshot(`${tag} 변경 이력 dialog`);
      await form.closeHistory();

      await form.fillPolicySettings({ lag: String((lag + 1) % 1000) });
      await form.save();
      await observations.record(`${tag} confirm dialog shows the 변경 내용 line`, () => form.confirmChangeLine('지연일수\\(일\\)').line.isVisible());
      await observations.record(`${tag} confirm dialog shows 뒤로`, () => form.confirmDialogBackButton.isVisible());
      await observations.record(`${tag} confirm dialog shows 확인 및 저장`, () => form.applyNowConfirmButton.isVisible());
      await observations.record(`${tag} confirm dialog fits the viewport width`, () => isWithinViewportWidth(form.confirmDialog.locator('.modal-content'), page));
      await observations.record(`${tag} 뒤로 is clickable without horizontal scrolling`, async () => (await isWithinViewportWidth(form.confirmDialogBackButton, page)) && (await form.confirmDialogBackButton.isEnabled()));
      await observations.record(`${tag} 확인 및 저장 is clickable without horizontal scrolling`, async () => (await isWithinViewportWidth(form.applyNowConfirmButton, page)) && (await form.applyNowConfirmButton.isEnabled()));
      await observations.screenshot(`${tag} confirmation dialog`);
      await form.backFromDialog();
    };

    await step(`Arrange: Pre-condition 1–3 — ${formatChannelKey(LIVE_ROW)} has history records; zoom 100%`, async () => {
      const row = await liveRow(policyApi);
      rowId = row.id;
      lag = row.cycleLagDays;
      await page.setViewportSize(DESKTOP);
    });

    await step('Act: Step 1 — At 1920×1080 open 변경 이력, then the save-confirmation dialog, and inspect both', async () => {
      await inspect(desktop, '[Expected 1] 1920×1080:');
    });

    await step('Assert: Expected 1 — History shows five unclipped columns; confirmation shows 변경 내용 and both buttons', async () => {
      desktop.assertAll();
    });

    await step('Act: Step 2 — Resize the window to 1366×768 and open both again', async () => {
      await page.setViewportSize(LAPTOP);
      await inspect(laptop, '[Expected 2] 1366×768:');
    });

    await step('Assert: Expected 2 — Both dialogs fit the viewport width; footer buttons clickable without horizontal scrolling', async () => {
      laptop.assertAll();
    });
  });

  test('TC_US080_080 — The list and form at 100%, 80% and 125% zoom', async ({ page, paymentMethodPolicyListPage: list, paymentMethodPolicyFormPage: form, policyApi }) => {
    const step = makeStep(page);
    const levels = { 100: new Observations(page), 80: new Observations(page), 125: new Observations(page) } as const;
    let seedId = 0;
    await allure.description(
      'At 1366×768, the list screen and the edit form (seed row) at zoom 100%, 80% and 125%: every element is shown with ' +
        'no page-level horizontal scrolling and the buttons stay clickable. Zoom is simulated with CSS zoom on <html> ' +
        '(Playwright has no real browser-zoom API). Not automated: "the text is still readable", "no empty area breaks the ' +
        'layout" and "nothing overlaps" (visual judgement). Read-only.',
    );
    await allure.severity('minor');
    await allure.tags('regression', 'responsive', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_080');

    const inspect = async (percent: 100 | 80 | 125, expectedNo: number) => {
      const observations = levels[percent];
      const tag = `[Expected ${expectedNo}] zoom ${percent}%`;
      await list.open();
      await setPageZoom(page, percent);
      for (const { name, locator } of listElements(list)) await observations.record(`${tag} list: ${name} is shown`, () => locator.isVisible());
      await observations.record(`${tag} list: no horizontal scrolling`, async () => !(await hasHorizontalPageScroll(page)));
      await observations.record(`${tag} list: 정책 추가 is clickable`, async () => (await list.addPolicyButton.isEnabled()) && (await isWithinViewportWidth(list.addPolicyButton, page)));
      await observations.screenshot(`${tag} list`);
      await form.open(seedId);
      await setPageZoom(page, percent);
      for (const { name, locator } of formElements(form, 'edit')) await observations.record(`${tag} form: ${name} is shown`, () => locator.isVisible());
      await observations.record(`${tag} form: no horizontal scrolling`, async () => !(await hasHorizontalPageScroll(page)));
      await observations.record(`${tag} form: 목록으로 is clickable`, async () => (await form.backToListButton.isEnabled()) && (await isWithinViewportWidth(form.backToListButton, page)));
      await observations.screenshot(`${tag} edit form`);
    };

    await step('Arrange: Pre-condition 1–3 — Logged in as ADMIN, register rows present, resolution 1366×768', async () => {
      seedId = (await policyApi.getByKey(SEED_ROW)).body.holder!.id;
      await page.setViewportSize(LAPTOP);
    });

    await step('Act: Step 1 — Open the list screen and the edit form at 100% zoom', async () => {
      await inspect(100, 1);
    });

    await step('Assert: Expected 1 — Both screens show every element, with no horizontal scrolling', async () => {
      levels[100].assertAll();
    });

    await step('Act: Step 2 — Change zoom to 80% and inspect both again', async () => {
      await inspect(80, 2);
    });

    await step('Assert: Expected 2 — Both screens still show every element (readability: Not automated)', async () => {
      levels[80].assertAll();
    });

    await step('Act: Step 3 — Change zoom to 125% and inspect both again', async () => {
      await inspect(125, 3);
    });

    await step('Assert: Expected 3 — Both screens still show every element and the buttons remain clickable', async () => {
      levels[125].assertAll();
    });
  });
});
