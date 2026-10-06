import { test, expect } from '@fixtures/fee-review.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { Observations } from '@utils/observations';
import { hasHorizontalPageScroll, isWithinViewportWidth, scrollsInside } from '@utils/layout';
import { getValidSession, toSessionCookies, UI_SESSION_BUFFER_MS } from '@utils/auth-token';
import { env } from '@utils/env.config';
import { CYCLE, FIXTURE, RATE_MOVING, autoReason } from '@utils/fee-review.data';
import type { Locator, Page } from '@playwright/test';
import { FeeReviewListPage } from '@pages/fee-review.page';

/**
 * US079 — nhóm [Responsive]. Đo hình học bằng `@utils/layout`. Khung app (meta info, nav, user info, sidebar dạng drawer, nút
 * burger, dải badge) chưa được recon cho màn này → ghi Not automated, không đoán locator. Kích thước tap 44px đo trên context
 * giả lập cảm ứng (hasTouch + isMobile, cùng phiên đăng nhập như `secondSession`).
 */
const TAGS = ['responsive', 'fee-review'];
const DEV = `Deviation: the TC's prototype seed does not exist on dev — cycle ${CYCLE.label} with the T079 fixtures is used.`;
const WIDTHS = [1698, 1498, 1278, 766];
const HEIGHT = 900;
const TAP_MIN = 44;

/** Đưa phần tử vào tầm nhìn (cuộn trang / vùng cuộn riêng) rồi kiểm nằm trọn bề ngang viewport — "reachable". */
async function reachable(locator: Locator, page: Page): Promise<boolean> {
  await locator.scrollIntoViewIfNeeded({ timeout: 5_000 });
  return (await locator.isVisible()) && (await isWithinViewportWidth(locator, page));
}

async function recordList(page: Page, list: FeeReviewListPage, obs: Observations, width: number): Promise<void> {
  await obs.record(`${width}px: no horizontal page scrollbar`, async () => !(await hasHorizontalPageScroll(page)));
  const row = list.row(FIXTURE.resolvedAnnex);
  for (const [name, locator] of [
    ['search: keyword box', list.keywordInput],
    ['search: 검색 button', list.searchButton],
    ['filter: 정산 주기 select', list.cycleSelect],
    ['chip 기간 내 판매 상품', list.chip('bucket.ALL')],
    ['chip 확인 필요', list.chip('bucket.EXC')],
    ['chip 이번 기 수정됨', list.chip('bucket.FIXED')],
    ['action: 근거 (Basis)', list.rowButton(row, 'btn.basis')],
    ['action: 수정 (Correct)', list.rowButton(row, 'btn.correct')],
    ['action: 이력 (History)', list.rowButton(row, 'btn.history')],
    ['submit: 선택 일괄 상신', list.submitButton],
    ['이번 기 수정 내역', list.reportButton],
    ['export: 목록 내보내기', list.exportButton],
  ] as const) {
    await obs.record(`${width}px: ${name} is reachable`, () => reachable(locator, page));
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await obs.screenshot(`${width}px list`);
}

test.describe('[Responsive] Settlement fee review at the real breakpoints', () => {
  test.describe.configure({ timeout: 240_000 });

  test('TC_US079_119 — The list reflows at each real breakpoint and keeps every function reachable', async ({ page, browser, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_119', 'Medium', TAGS, `At 1698 px everything stays reachable with no sideways page scroll; at 766 px the 정산 주기 and 검색어 filters each lay out at roughly half the viewport width and every function (search, filter, chips, row actions, export, submit) is still reachable; on a touch-emulated (coarse-pointer) context every visible button and pagination control is at least ${TAP_MIN} px tall. Not automated: the shell changes — meta info block (1698), nav padding + user info block (1498), sidebar drawer + burger + main nav links (1278), pill/badge row (766) — the app shell was not recon'd; "clipped cell widths shrink" at 766 px (visual). Deviation: the pointer is emulated (hasTouch + isMobile) rather than a real touch device. ${DEV} Data: read-only.`);
    const obs = new Map(WIDTHS.map((w) => [w, new Observations(page)] as const));
    let touchObs: Observations | undefined;
    let coarse = false;
    const filterRatio = { cycle: 0, keyword: 0 };

    const resize = async (width: number) => {
      await page.setViewportSize({ width, height: HEIGHT });
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    };

    await step('Arrange: Pre-condition 1–2 — The open cycle with data', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Resize the viewport to 1698px and check the layout', async () => {
      await resize(1698);
      await recordList(page, list, obs.get(1698) as Observations, 1698);
    });

    await step('Assert: Expected 1 — At 1698px the meta info block is hidden; everything else unchanged', async () => {
      (obs.get(1698) as Observations).assertAll();
      test.info().annotations.push({ type: 'Not automated', description: "Expected 1: the meta info block (build / login-expiry) is hidden — app shell not recon'd" });
    });

    await step('Act: Step 2 — Resize the viewport to 1498px', async () => {
      await resize(1498);
      await recordList(page, list, obs.get(1498) as Observations, 1498);
    });

    await step('Assert: Expected 2 — At 1498px nav padding shrinks and the user info block hides (Not automated)', async () => {
      test.info().annotations.push({ type: 'Not automated', description: "Expected 2: nav padding and the user info block — app shell not recon'd" });
    });

    await step('Act: Step 3 — Resize the viewport to 1278px', async () => {
      await resize(1278);
      await recordList(page, list, obs.get(1278) as Observations, 1278);
    });

    await step('Assert: Expected 3 — At 1278px the sidebar becomes a drawer opened by the burger; the main nav links hide (Not automated)', async () => {
      test.info().annotations.push({ type: 'Not automated', description: "Expected 3: sidebar drawer, burger control and main nav links — app shell not recon'd" });
    });

    await step('Act: Step 4 — Resize the viewport to 766px', async () => {
      await resize(766);
      await recordList(page, list, obs.get(766) as Observations, 766);
      const vw = page.viewportSize()?.width ?? 766;
      filterRatio.cycle = ((await list.cycleSelect.boundingBox())?.width ?? 0) / vw;
      filterRatio.keyword = ((await list.keywordInput.boundingBox())?.width ?? 0) / vw;
    });

    await step('Assert: Expected 4 — Filters at about half width each; every function still reachable', async () => {
      for (const [name, ratio] of Object.entries(filterRatio)) {
        expect.soft(ratio, `[Expected 4] The ${name} filter is roughly half the width (≥ 35%)`).toBeGreaterThanOrEqual(0.35);
        expect.soft(ratio, `[Expected 4] The ${name} filter is roughly half the width (≤ 65%)`).toBeLessThanOrEqual(0.65);
      }
      (obs.get(766) as Observations).assertAll();
      test.info().annotations.push({ type: 'Not automated', description: 'Expected 4: clipped cell widths shrink and the pill/badge row hides — visual / shell not recon\'d' });
    });

    await step('Act: Step 5 — On a coarse-pointer (touch-emulated) context check tap target sizes', async () => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      const context = await browser.newContext({ baseURL: env.baseURL, viewport: { width: 766, height: HEIGHT }, hasTouch: true, isMobile: true });
      try {
        await context.addCookies(toSessionCookies(await getValidSession('submitter', UI_SESSION_BUFFER_MS), env.baseURL));
        const touchPage = await context.newPage();
        const touchList = new FeeReviewListPage(touchPage);
        touchObs = new Observations(touchPage);
        await touchList.open({ cycleId: CYCLE.id, bucket: 'ALL', pageSize: '10' });
        coarse = await touchPage.evaluate(() => window.matchMedia('(pointer: coarse)').matches);
        const controls = [...(await touchPage.getByRole('button').all()), ...(await touchList.pagination.locator('a, button').all())];
        for (const [i, control] of controls.entries()) {
          if (!(await control.isVisible())) continue;
          const label = ((await control.getAttribute('aria-label')) ?? (await control.innerText())).trim().slice(0, 30) || `control #${i + 1}`;
          await touchObs.record(`Tap target "${label}" is at least ${TAP_MIN}px tall`, async () => ((await control.boundingBox())?.height ?? 0) >= TAP_MIN);
        }
        await touchObs.screenshot('coarse pointer 766px list');
      } finally {
        await context.close();
      }
    });

    await step('Assert: Expected 5 — On a coarse pointer every button and pagination control is at least 44px tappable', async () => {
      expect(coarse, '[Expected 5] The emulated context reports a coarse pointer').toBe(true);
      (touchObs as Observations).assertAll();
    });
  });

  test('TC_US079_120 — Each dialog opens and stays usable at each real breakpoint', async ({ page, feeReviewApi, feeReviewState, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_120', 'Medium', TAGS, `At 1698 / 1498 / 1278 / 766 px each dialog (Why this rate, Correct fee resolution, Change history, Withdraw confirmation, Changes this period, Export) opens inside the viewport width with every button reachable and no sideways page scroll; at 766 px the Changes this period table scrolls inside its own container and the page does not scroll sideways. ${DEV} A pending correction is created on ${FIXTURE.forSave} for the Withdraw dialog. Data: withdrawn and discarded in teardown; every dialog is closed without saving.`);
    const obs = new Observations(page);
    const report766 = { scrolls: false, pageScroll: true };

    await step('Arrange: Pre-condition 1–2 — The open cycle with data; a pending correction for the Withdraw dialog', async () => {
      await feeReviewState.pending(feeReviewApi, FIXTURE.forSave, RATE_MOVING, autoReason('TC_US079_120', 'withdraw dialog at breakpoints'));
    });

    await step('Act: Step 1 — At each breakpoint open each of the six dialogs in turn', async () => {
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: HEIGHT });
        await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
        const dialogs: Array<[string, () => Promise<void>, () => Promise<void>, typeof list.basis.root]> = [
          ['Why this rate', () => list.openBasis(list.row(FIXTURE.resolvedAnnex)), () => list.basis.close(), list.basis.root],
          ['Correct', () => list.openCorrect(list.row(FIXTURE.resolvedAnnex)), () => list.correct.cancel(), list.correct.root],
          ['History', () => list.openHistory(list.row(FIXTURE.approvedTwoPolicies)), () => list.history.close(), list.history.root],
          ['Withdraw', () => list.openWithdraw(list.row(FIXTURE.forSave)), () => list.withdraw.cancelButton.click(), list.withdraw.root],
          ['Changes this period', () => list.openReport(), () => list.report.close(), list.report.root],
          ['Export', () => list.openExport(), () => list.exporter.cancelButton.click(), list.exporter.root],
        ];
        for (const [name, open, close, root] of dialogs) {
          await open();
          const content = root.locator('.modal-content');
          await obs.record(`${width}px ${name}: fits the viewport width`, () => isWithinViewportWidth(content, page));
          for (const [i, button] of (await content.getByRole('button').all()).entries()) {
            if (!(await button.isVisible())) continue;
            const label = ((await button.getAttribute('aria-label')) ?? (await button.innerText())).trim().slice(0, 30) || `button #${i + 1}`;
            await obs.record(`${width}px ${name}: control "${label}" reachable`, () => reachable(button, page));
          }
          await obs.record(`${width}px ${name}: no page horizontal scroll`, async () => !(await hasHorizontalPageScroll(page)));
          if (width === 766 && name === 'Changes this period') {
            report766.scrolls = await scrollsInside(list.report.tableScroller, 'x');
            report766.pageScroll = await hasHorizontalPageScroll(page);
          }
          await obs.screenshot(`${width}px ${name}`);
          await close();
        }
      }
    });

    await step('Assert: Expected 1 — Every dialog stays fully usable at every breakpoint', async () => {
      obs.assertAll();
    });

    await step('Act: Step 2 — At 766px check the Changes this period table', async () => {
      await page.setViewportSize({ width: 1920, height: 1080 });
    });

    await step('Assert: Expected 2 — The report table scrolls inside its container; the page does not scroll sideways', async () => {
      expect(report766.scrolls, '[Expected 2] The report table scrolls horizontally inside its own container').toBe(true);
      expect(report766.pageScroll, '[Expected 2] The page itself does not scroll sideways at 766px').toBe(false);
    });
  });
});
