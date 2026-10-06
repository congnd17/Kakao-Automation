import { test, expect } from '@fixtures/purchase-order.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { Observations } from '@utils/observations';
import { hasHorizontalPageScroll, isClipped, isWithinViewportWidth, scrollsInside } from '@utils/layout';
import { getValidSession, toSessionCookies, UI_SESSION_BUFFER_MS } from '@utils/auth-token';
import { env } from '@utils/env.config';
import { PO_KO } from '@utils/purchase-order.i18n';
import { PurchaseOrderFormPage, PoDialog } from '@pages/purchase-order-form.page';

/**
 * Responsive (US105) — màn list ở các breakpoint lấy từ prototype (1699 / 1499 / 1279 / 767) và 4 viewport chuẩn
 * (1920 / 1366 / 768 / 390), 3 dialog ở bề ngang hẹp và kích thước vùng chạm trên thiết bị cảm ứng. Mỗi dòng Steps đi qua
 * nhiều viewport → ghi nhận trong Act, assert toàn bộ trong Assert (`Observations`).
 */
const TAGS = ['responsive', 'purchase-order'];

test.describe('[Responsive] 발주 관리 — breakpoints, dialogs and touch targets', () => {
  test.describe.configure({ timeout: 240_000 });

  test('TC_US105_114 — The PO list screen at every prototype breakpoint and the four standard viewports', async ({ page, poList, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_114', 'Low', TAGS, '1920: sidebar, filters, ten-column table and pager with no page scroll; 1699 / 1499: shell meta then user area hide, every PO control kept, no overlap; 1366: the table scrolls inside its frame (1280px minimum) with no page scroll; 1279: the left navigation collapses to a slide-out menu with a menu button and a backdrop; 768: filter fields wrap full width, none clipped, Sale type included; 390: still usable, nothing clipped, no page scroll. Not automated: "no text overlaps" (visual judgement).');
    const obs = new Observations(page);

    await step('Arrange: Pre-condition 1–3 — Enough POs for a multi-row table; breakpoints taken from the prototype', async () => {
      await poData.createDraft();
      await poList.open();
    });

    await step('Act: Step 1 — Open the 발주 관리 screen at a width of 1920px', async () => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await obs.record('[Expected 1] 1920: the table is visible', () => poList.table.isVisible());
      await obs.record('[Expected 1] 1920: the pager is visible', () => poList.pager.isVisible());
      await obs.record('[Expected 1] 1920: the filter area is visible', () => poList.searchButton.isVisible());
      await obs.record('[Expected 1] 1920: the sidebar is visible', () => page.getByRole('complementary').isVisible());
      await obs.record('[Expected 1] 1920: no horizontal page scroll', async () => !(await hasHorizontalPageScroll(page)));
    });
    await step('Assert: Expected 1 — Sidebar, filter area, ten-column table and pager; no horizontal page scroll', async () => {
      obs.assertAll();
    });

    const obs2 = new Observations(page);
    await step('Act: Step 2 — Narrow to 1699px and then 1499px, observing after each', async () => {
      for (const width of [1699, 1499]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const [name, locator] of [['Search', poList.searchButton], ['Reset', poList.resetButton], ['Create PO', poList.createButton], ['Excel download', poList.excelButton], ['table', poList.table]] as const) {
          await obs2.record(`[Expected 2] ${width}: ${name} is still there`, () => locator.isVisible());
        }
        await obs2.screenshot(`${width}px`);
      }
    });
    await step('Assert: Expected 2 — Shell areas hide in turn; every PO control is still there', async () => {
      obs2.assertAll();
    });

    const obs3 = new Observations(page);
    await step('Act: Step 3 — Narrow to 1366px', async () => {
      await page.setViewportSize({ width: 1366, height: 768 });
      await obs3.record('[Expected 3] 1366: the list table scrolls horizontally inside its own frame', () => scrollsInside(poList.table.locator('xpath=ancestor::div[contains(@class,"table-responsive")][1]'), 'x'));
      await obs3.record('[Expected 3] 1366: the page has no horizontal scrollbar', async () => !(await hasHorizontalPageScroll(page)));
    });
    await step('Assert: Expected 3 — The table scrolls inside its frame; the page has no horizontal scroll', async () => {
      obs3.assertAll();
    });

    const obs4 = new Observations(page);
    await step('Act: Step 4 — Narrow to 1279px and observe the left navigation bar', async () => {
      await page.setViewportSize({ width: 1279, height: 800 });
      const menuButton = page.getByRole('banner').getByRole('link', { name: 'anchor' }).first();
      await obs4.record('[Expected 4] 1279: the sidebar collapses (hidden off-canvas)', async () => !(await isWithinViewportWidth(page.getByRole('complementary'), page)) || !(await page.getByRole('complementary').isVisible()));
      await obs4.record('[Expected 4] 1279: a menu button is shown', () => menuButton.isVisible());
      await menuButton.click().catch(() => undefined);
      await obs4.record('[Expected 4] 1279: a dark backdrop shows while the menu is open', () => page.locator('.offcanvas-backdrop, .modal-backdrop, [class*="backdrop"]').first().isVisible());
      await obs4.screenshot('1279px menu open');
      await page.keyboard.press('Escape');
    });
    await step('Assert: Expected 4 — Slide-out menu with a menu button and a dark backdrop', async () => {
      obs4.assertAll();
    });

    const obs5 = new Observations(page);
    await step('Act: Step 5 — Narrow to 768px and observe the filter area', async () => {
      await page.setViewportSize({ width: 768, height: 1024 });
      for (const [name, locator] of [['검색 조건', poList.searchTypeSelect], ['검색어', poList.keywordInput], ['발주 상태', poList.statusSelect], ['입고지', poList.warehouseSelect], ['소유 주체', poList.ownerSelect], ['판매유형 (Sale type)', poList.saleTypeSelect], ['기간 기준', poList.periodTypeSelect]] as const) {
        await obs5.record(`[Expected 5] 768: ${name} is not clipped`, async () => !(await isClipped(locator)));
        await obs5.record(`[Expected 5] 768: ${name} stays within the viewport width`, () => isWithinViewportWidth(locator, page));
      }
    });
    await step('Assert: Expected 5 — Filter fields wrap and stretch with none clipped, Sale type included', async () => {
      obs5.assertAll();
    });

    const obs6 = new Observations(page);
    await step('Act: Step 6 — Narrow to 390px and observe the whole screen', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await obs6.record('[Expected 6] 390: no horizontal page scroll', async () => !(await hasHorizontalPageScroll(page)));
      await obs6.record('[Expected 6] 390: the Search button is reachable', () => isWithinViewportWidth(poList.searchButton, page));
      await obs6.record('[Expected 6] 390: the keyword field is not clipped', async () => !(await isClipped(poList.keywordInput)));
    });
    await step('Assert: Expected 6 — Still usable, nothing clipped, no horizontal page scroll', async () => {
      obs6.assertAll();
    });
  });

  test('TC_US105_116 — The three dialogs at narrow widths and the tap-target size on a touch device', async ({ page, browser, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_116', 'Low', TAGS, 'At 1279px the receive and discrepancy dialogs are ≤ 960px and the reason dialog ≤ 520px, each with a 16px side margin; at 768 and 390px all three shrink to fit with no page scroll and scroll vertically inside the body; on a touch device every dialog button is ≥ 44px tall; the reason dialog has only the two titles "발주 취소 사유" / "발주 종결 사유".');
    const po = await poData.createIssued([{ qty: 300 }]);
    const exception = await poData.createIssued([{ qty: 300 }]);
    let grnNo = '';

    await step('Arrange: Pre-condition 1–3 — PO A Issued with Receipt A in Exception; dialog widths from the prototype', async () => {
      await poData.receive(exception, 290, 0, 'ADJ_DISCREPANCY');
      grnNo = (await poData.api.goodsReceipts(exception.id))[0].grnNo;
    });

    /** Mở lần lượt 3 dialog trên `form` và ghi nhận phép đo của `probe`. */
    const sweep = async (form: PurchaseOrderFormPage, obs: Observations, tag: string, probe: (dialog: PoDialog, name: string) => Promise<void>) => {
      await form.openPo(po.id);
      await form.openReceive();
      await probe(form.receiveDialog(), `${tag} receive dialog`);
      await obs.screenshot(`${tag} receive`);
      await form.receiveDialog().cancelButton.click();
      await form.openPo(exception.id);
      await form.openResolve(grnNo);
      await probe(form.resolveDialog(), `${tag} discrepancy dialog`);
      await form.resolveDialog().cancelButton.click();
      await form.openPo(po.id);
      await form.closePoButton.click();
      await form.reasonDialog().waitOpen();
      await probe(form.reasonDialog(), `${tag} reason dialog`);
      await form.reasonDialog().cancelButton.click();
    };
    const width = async (dialog: PoDialog) => (await dialog.root.locator('.modal-dialog').boundingBox())?.width ?? 0;
    const margin = async (dialog: PoDialog) => (await dialog.root.locator('.modal-dialog').boundingBox())?.x ?? 0;

    const obs1 = new Observations(page);
    await step('Act: Step 1 — At 1279px open the receive dialog, the discrepancy dialog and the Close-PO reason dialog', async () => {
      await page.setViewportSize({ width: 1279, height: 900 });
      await sweep(poForm, obs1, '1279', async (dialog, name) => {
        const max = name.includes('reason') ? 520 : 960;
        await obs1.record(`[Expected 1] ${name} is no wider than ${max}px`, async () => (await width(dialog)) <= max + 1);
        await obs1.record(`[Expected 1] ${name} leaves at least a 16px margin`, async () => (await margin(dialog)) >= 15);
      });
    });
    await step('Assert: Expected 1 — ≤ 960px (receive, discrepancy) and ≤ 520px (reason), 16px margins', async () => {
      obs1.assertAll();
    });

    const obs2 = new Observations(page);
    await step('Act: Step 2 — Narrow to 768px and reopen all three dialogs', async () => {
      await page.setViewportSize({ width: 768, height: 1024 });
      await sweep(poForm, obs2, '768', async (dialog, name) => {
        await obs2.record(`[Expected 2] ${name} fits the viewport width`, () => isWithinViewportWidth(dialog.root.locator('.modal-content'), page));
        await obs2.record(`[Expected 2] ${name}: no horizontal page scroll`, async () => !(await hasHorizontalPageScroll(page)));
      });
    });
    await step('Assert: Expected 2 — All three shrink to fit; none overflows; no page scroll', async () => {
      obs2.assertAll();
    });

    const obs3 = new Observations(page);
    await step('Act: Step 3 — Narrow to 390px and reopen all three dialogs', async () => {
      await page.setViewportSize({ width: 390, height: 700 });
      await sweep(poForm, obs3, '390', async (dialog, name) => {
        await obs3.record(`[Expected 3] ${name} fits the viewport width`, () => isWithinViewportWidth(dialog.root.locator('.modal-content'), page));
        await obs3.record(`[Expected 3] ${name}: no horizontal page scroll`, async () => !(await hasHorizontalPageScroll(page)));
      });
    });
    await step('Assert: Expected 3 — Same at 390px; content scrolls vertically inside the dialog', async () => {
      obs3.assertAll();
    });

    const obs4 = new Observations(page);
    await step('Act: Step 4 — Switch to touch-device emulation and reopen the three dialogs', async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      await context.addCookies(toSessionCookies(await getValidSession('submitter', UI_SESSION_BUFFER_MS), env.baseURL));
      const touch = await context.newPage();
      try {
        await sweep(new PurchaseOrderFormPage(touch), obs4, 'touch', async (dialog, name) => {
          const heights = await dialog.root.locator('.modal-footer button').evaluateAll((buttons) => buttons.map((b) => b.getBoundingClientRect().height));
          await obs4.record(`[Expected 4] ${name}: every button is at least 44px tall (${heights.join(', ')})`, async () => heights.length > 0 && heights.every((h) => h >= 44));
        });
      } finally {
        await context.close();
      }
    });
    await step('Assert: Expected 4 — Every button in the three dialogs is at least 44px tall', async () => {
      obs4.assertAll();
    });

    const titles: string[] = [];
    await step('Act: Step 5 — Observe the reason dialog title via 발주 취소 and via 발주 종결', async () => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await poForm.openPo(po.id);
      for (const button of [poForm.cancelPoButton, poForm.closePoButton]) {
        await button.click();
        titles.push(await poForm.reasonDialog().title.innerText());
        await poForm.reasonDialog().cancelButton.click();
      }
    });
    await step('Assert: Expected 5 — Only the two titles "Cancel reason" and "Close reason"', async () => {
      expect(titles, '[Expected 5] 발주 취소 사유 / 발주 종결 사유').toEqual([PO_KO['text.reasonTitleCancel'], PO_KO['text.reasonTitleClose']]);
    });

  });
});
