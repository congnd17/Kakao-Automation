import { test } from '@fixtures/fee-rate.fixture';
import { Locator, Page } from '@playwright/test';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { Observations } from '@utils/observations';
import { hasHorizontalPageScroll, isClipped, setPageZoom } from '@utils/layout';
import { KEY, inDays } from '@utils/fee-rate.data';

/**
 * US078 — nhóm [Responsive]: độ rộng trong phạm vi Test Strategy (1366×768 → 1920×1080) và zoom 80 % / 125 %.
 * Nguồn TC: input/TESTCASE_US078_v2.md (Steps N / Expected N → `Act: Step N` / `Assert: Expected N`). Mỗi dòng TC đi qua nhiều
 * độ rộng → đo ở từng độ rộng trong `Act`, assert toàn bộ trong `Assert` (Observations — reporting_rules.md mục 2).
 * Không tự động hoá được: "chữ không chồng lấn / đọc được" (cảm quan) — ghi Not automated trong description.
 */
const TAGS = ['ui', 'fee-rate', 'fee-rate-responsive'];
const DATA = 'Data: an automation-owned contract created through the API (contracts cannot be deleted); pending requests are withdrawn in teardown.';
const HEIGHT = { 1920: 1080, 1698: 955, 1498: 843, 1366: 768 } as Record<number, number>;

/** Khung cuộn ngang của bảng: phần tử tổ tiên gần nhất có overflow-x auto/scroll. */
async function scrollContainerOf(table: Locator): Promise<{ found: boolean; containsTable: boolean }> {
  return table.evaluate((el) => {
    let node = el.parentElement;
    while (node && node !== document.body) {
      const overflow = getComputedStyle(node).overflowX;
      if (overflow === 'auto' || overflow === 'scroll') return { found: true, containsTable: node.contains(el) };
      node = node.parentElement;
    }
    return { found: false, containsTable: false };
  });
}

async function dialogSideSpace(dialog: Locator, page: Page): Promise<{ left: number; right: number }> {
  const box = await dialog.locator('.modal-content').boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  return { left: box?.x ?? -1, right: box ? width - (box.x + box.width) : -1 };
}

test.describe('[Responsive] Fee rate screens at the supported desktop sizes', () => {
  test.describe.configure({ timeout: 180_000 });

  test('TC_US078_89 — The Fee Information tab reads correctly at every width in scope, with the table scrolling inside its own box', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    const obs = new Observations(page);
    const widths = [1920, 1698, 1498, 1366];
    await tcMeta('TC_US078_89', 'Medium', TAGS, `At 1920 / 1698 / 1498 / 1366 px the fee table scrolls horizontally inside its own container and the page itself never scrolls sideways. Out of scope: the 390 px width BR-UI-1.V1 asks for (Test Strategy range starts at 1366×768 — spec/Test-Strategy conflict noted in the TC). ${DATA}`);
    let contract = { id: 0 };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the contract has its usual fee rows', async () => {
      contract = await feeRateContracts.create('TC_US078_89', 'RUNNING');
    });

    await step('Act: Step 1 — Open the Fee Information tab at 1920, 1698, 1498 and 1366 px, checking the page at each width', async () => {
      await fee.open(contract.id);
      for (const width of widths) {
        await page.setViewportSize({ width, height: HEIGHT[width] });
        const table = fee.feePanel.locator('table');
        const container = await scrollContainerOf(table);
        await obs.record(`[Expected 1] ${width}px: the fee table sits in its own horizontal scroll container`, async () => container.found && container.containsTable);
        await obs.record(`[Expected 1] ${width}px: the page does not scroll sideways`, async () => !(await hasHorizontalPageScroll(page)));
        await obs.screenshot(`Fee Information tab at ${width}px`);
      }
      await page.setViewportSize({ width: 1920, height: 1080 });
    });

    await step('Assert: Expected 1 — At every width the table scrolls inside its container and the page never scrolls sideways', async () => {
      obs.assertAll();
    });
  });

  test('TC_US078_90 — The Change fee rate dialog reads correctly at every width in scope', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    const obs = new Observations(page);
    await tcMeta('TC_US078_90', 'Medium', TAGS, `At 1920 and 1366 px the Change rate dialog keeps at least 32 px of space on both sides and never touches the screen edges. ${DATA}`);
    let contract = { id: 0 };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the MD row is Active', async () => {
      contract = await feeRateContracts.create('TC_US078_90', 'RUNNING');
    });

    await step('Act: Step 1 — Open the Change rate dialog and set the width to 1920 and 1366 px', async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD));
      for (const width of [1920, 1366]) {
        await page.setViewportSize({ width, height: HEIGHT[width] });
        const space = await dialogSideSpace(fee.changeDialog.root, page);
        await obs.record(`[Expected 1] ${width}px: at least 32px on the left (${space.left}px)`, async () => space.left >= 32);
        await obs.record(`[Expected 1] ${width}px: at least 32px on the right (${space.right}px)`, async () => space.right >= 32);
        await obs.screenshot(`Change rate dialog at ${width}px`);
      }
      await page.setViewportSize({ width: 1920, height: 1080 });
    });

    await step('Assert: Expected 1 — At every width the dialog keeps ≥ 32 px on both sides', async () => {
      obs.assertAll();
    });
  });

  test('TC_US078_91 — The History and Withdraw dialogs read correctly at every width in scope', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    const history = new Observations(page);
    const withdraw = new Observations(page);
    await tcMeta('TC_US078_91', 'Medium', TAGS, `At 1920 and 1366 px the History dialog's table scrolls inside its own container and the page does not scroll sideways; the Withdraw dialog gives the same result. ${DATA}`);
    let contract = { id: 0 };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; MD has history to show; Fan Club has a pending request', async () => {
      contract = await feeRateContracts.create('TC_US078_91', 'RUNNING');
      await feeRateContracts.submit(contract.id, KEY.MD, { changeKind: 'CORRECTION', commission: '8', changeReason: 'History for the responsive check' });
      await feeRateContracts.submit(contract.id, KEY.FANCLUB, { changeKind: 'RATE_CHANGE', commission: '6.5', effectiveFrom: inDays(3), changeReason: 'Pending request for the withdraw dialog' });
    });

    await step('Act: Step 1 — Open the History dialog and set the width to 1920 and 1366 px', async () => {
      await fee.openEdit(contract.id);
      await fee.openHistory(fee.row(KEY.MD));
      for (const width of [1920, 1366]) {
        await page.setViewportSize({ width, height: HEIGHT[width] });
        const container = await scrollContainerOf(fee.historyDialog.root.locator('table'));
        await history.record(`[Expected 1] ${width}px: the history table scrolls inside its own container`, async () => container.found && container.containsTable);
        await history.record(`[Expected 1] ${width}px: the page does not scroll sideways`, async () => !(await hasHorizontalPageScroll(page)));
        await history.screenshot(`History dialog at ${width}px`);
      }
    });

    await step('Assert: Expected 1 — The history table scrolls inside its container; the page does not scroll sideways', async () => {
      history.assertAll();
    });

    await step('Act: Step 2 — Close it, open the Withdraw dialog and repeat the same widths', async () => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await fee.historyDialog.close();
      await fee.openWithdraw(fee.row(KEY.FANCLUB));
      for (const width of [1920, 1366]) {
        await page.setViewportSize({ width, height: HEIGHT[width] });
        await withdraw.record(`[Expected 2] ${width}px: the Withdraw dialog content is not clipped`, async () => !(await isClipped(fee.withdrawDialog.root.locator('.modal-body'))));
        await withdraw.record(`[Expected 2] ${width}px: the page does not scroll sideways`, async () => !(await hasHorizontalPageScroll(page)));
        await withdraw.screenshot(`Withdraw dialog at ${width}px`);
      }
      await page.setViewportSize({ width: 1920, height: 1080 });
    });

    await step('Assert: Expected 2 — Same result for the Withdraw dialog', async () => {
      withdraw.assertAll();
      await fee.withdrawDialog.cancelButton.click();
    });
  });

  test('TC_US078_92 — The approval queue reads correctly at every width in scope', async ({ page, changeApprovalQueuePage: queue }) => {
    const step = makeStep(page);
    const obs = new Observations(page);
    await tcMeta('TC_US078_92', 'Medium', TAGS, 'At 1920 and 1366 px the 변경 승인 page never scrolls sideways. Data: read-only — uses the pending items already in the queue.');

    await step('Arrange: Pre-condition 1–2 — Logged in as APPROVER; 변경 승인 has at least one pending item', async () => {
      await queue.open();
    });

    await step('Act: Step 1 — Open 변경 승인 and set the width to 1920 and 1366 px', async () => {
      for (const width of [1920, 1366]) {
        await page.setViewportSize({ width, height: HEIGHT[width] });
        await obs.record(`[Expected 1] ${width}px: the page does not scroll sideways`, async () => !(await hasHorizontalPageScroll(page)));
        await obs.screenshot(`변경 승인 at ${width}px`);
      }
      await page.setViewportSize({ width: 1920, height: 1080 });
    });

    await step('Assert: Expected 1 — At every width the page never scrolls sideways', async () => {
      obs.assertAll();
    });
  });

  test('TC_US078_99 — The Fee Information tab and the Change fee rate dialog read correctly at 80 % and 125 % zoom', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    const zoom80 = new Observations(page);
    const zoom125 = new Observations(page);
    await tcMeta('TC_US078_99', 'Low', TAGS, `At 80 % and 125 % zoom (CSS zoom — Playwright has no browser-zoom API) the tab's buttons and the dialog's controls are not clipped and the dialog keeps space on both sides. Not automated: "no overlapping text" (visual judgement — checked on the attached screenshots). ${DATA}`);
    let contract = { id: 0 };

    const measure = async (obs: Observations, percent: number, tag: string) => {
      await setPageZoom(page, percent);
      await obs.record(`${tag} ${percent} %: the fee tab's action buttons are not clipped`, async () => !(await isClipped(fee.cell(fee.row(KEY.MD), 'action'))));
      await obs.screenshot(`Fee Information tab at ${percent} % zoom`);
      await fee.openChangeDialog(fee.row(KEY.MD));
      await obs.record(`${tag} ${percent} %: the dialog footer buttons are not clipped`, async () => !(await isClipped(fee.changeDialog.root.locator('.modal-footer'))));
      const space = await dialogSideSpace(fee.changeDialog.root, page);
      await obs.record(`${tag} ${percent} %: the dialog keeps space on both sides (${space.left}px / ${space.right}px)`, async () => space.left > 0 && space.right > 0);
      await obs.screenshot(`Change rate dialog at ${percent} % zoom`);
      await fee.changeDialog.cancelButton.click();
      await setPageZoom(page, 100);
    };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the MD row is Active', async () => {
      contract = await feeRateContracts.create('TC_US078_99', 'RUNNING');
      await fee.openEdit(contract.id);
    });

    await step('Act: Step 1 — Set zoom to 80 %, open the Fee Information tab, then the Change rate dialog', async () => {
      await measure(zoom80, 80, '[Expected 1]');
    });

    await step('Assert: Expected 1 — At 80 % the tab and the dialog render with no clipped control', async () => {
      zoom80.assertAll();
    });

    await step('Act: Step 2 — Repeat at 125 % zoom', async () => {
      await measure(zoom125, 125, '[Expected 2]');
    });

    await step('Assert: Expected 2 — At 125 % no clipped control and the dialog still keeps space on both sides', async () => {
      zoom125.assertAll();
    });
  });
});

