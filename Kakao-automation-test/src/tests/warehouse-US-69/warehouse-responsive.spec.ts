import { test } from '@fixtures/base.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { Observations } from '@utils/observations';
import { hasHorizontalPageScroll, isClipped, isWithinViewport, isWithinViewportWidth } from '@utils/layout';

/**
 * Bố cục 창고 관리 (US069 TC_082) ở các độ phân giải desktop. Nguồn TC: input/US069_TestCases_EN_v1.20.md — Steps /
 * Expected map 1-1 với step `Act: Step N` / `Assert: Expected N`; mỗi độ phân giải đi qua list, form và dialog nên dùng mẫu
 * "ghi nhận trong Act → assert trong Assert" (Observations). Dữ liệu: 1 warehouse automation-owned (xoá ở teardown) để mở
 * màn chi tiết và dialog 비활성화 (chỉ mở rồi 취소, không đổi trạng thái).
 */
const TAGS = ['ui', 'warehouse', 'responsive'];
const RESOLUTIONS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
];

test.describe('[Responsive] 창고 관리 layout at supported desktop sizes', () => {
  test.describe.configure({ timeout: 120_000 });

  test('TC_US069_082 — Layout at supported screen sizes', async ({ page, warehouseListPage: list, warehouseFormPage: form, warehouseCleanup }) => {
    test.setTimeout(180_000);
    const step = makeStep(page);
    const obs = new Observations(page);
    await tcMeta(
      'TC_US069_082',
      'Low',
      TAGS,
      'At 1366×768, 1440×900, 1920×1080 and 2560×1440 the menu, filters, table, pager, create/edit form, the 상태 및 작업 pane and the ' +
        'deactivate dialog stay visible and usable: inside the viewport width, not clipped, no horizontal page scroll; the table adapts ' +
        'inside its own container. Not automated: "no overlap" and "adjusts appropriately" beyond these measurements (visual judgement). ' +
        'Data: an automation-owned warehouse is created and deleted afterwards.',
    );
    let id = 0;

    await step('Arrange: Pre-condition 1 — The responsive scope is desktop web (automation-owned warehouse available)', async () => {
      id = (await warehouseCleanup.create('PLATFORM_WMS_EGFLEX', 'TC_US069_082')).id;
    });

    await step('Act: Step 1 — Open 창고 관리 on a desktop browser', async () => {
      await list.openFromSidebar();
    });

    await step('Act: Step 2 — Resize the window to 1366×768, 1440×900, 1920×1080 and 2560×1440', async () => {
      for (const { width, height } of RESOLUTIONS) {
        const tag = `${width}×${height}:`;
        await page.setViewportSize({ width, height });
        await list.open();
        // Sidebar render lại sau khi đổi viewport (verify 29/09: đo ngay lúc đó cho kết quả "không hiển thị" giả) — chờ trước khi đo.
        await list.sidebarWarehouseMenu.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
        for (const [name, locator] of [
          ['창고 관리 menu', list.sidebarWarehouseMenu],
          ['창고 등록 button', list.addWarehouseButton],
          ['창고명 검색 input', list.searchByNameInput],
          ['거래처 filter', list.bizPartnerSelect],
          ['유형 filter', list.typeSelect],
          ['상태 filter', list.statusSelect],
          ['초기화 button', list.resetButton],
          ['검색 button', list.searchButton],
          ['warehouse table', list.table],
          ['페이지당 selector', list.pageSizeSelect],
        ] as const) {
          await obs.record(`${tag} list — ${name} is visible`, () => locator.isVisible());
          await obs.record(`${tag} list — ${name} fits the viewport width`, () => isWithinViewportWidth(locator, page));
        }
        await obs.record(`${tag} list — the pager text is not clipped`, async () => !(await isClipped(list.pagerTotalText)));
        await obs.record(`${tag} list — no horizontal page scroll`, async () => !(await hasHorizontalPageScroll(page)));
        await obs.screenshot(`${tag} list`);

        await form.open(id);
        for (const [name, locator] of [
          ['창고명 input', form.nameInput],
          ['저장 button', form.saveButton],
          ['상태 및 작업 pane', form.panel],
          ['창고 비활성화 button', form.deactivateButton],
          ['창고 삭제 button', form.deleteButton],
        ] as const) {
          await obs.record(`${tag} detail — ${name} is visible`, () => locator.isVisible());
          await obs.record(`${tag} detail — ${name} fits the viewport width`, () => isWithinViewportWidth(locator, page));
        }
        await obs.record(`${tag} detail — no horizontal page scroll`, async () => !(await hasHorizontalPageScroll(page)));
        await form.openDeactivateDialog();
        await obs.record(`${tag} dialog — the deactivate dialog fits the viewport`, () => isWithinViewport(form.dialog.locator('.modal-content'), page));
        await obs.record(`${tag} dialog — its text is not clipped`, async () => !(await isClipped(form.dialog.locator('.modal-body'))));
        await obs.screenshot(`${tag} detail + dialog`);
        await form.click(form.dialogCancelButton, '취소 (Cancel) button in the dialog');
      }
    });

    await step('Act: Step 3 — Observe menus, filters, tables, forms, dialogs and scrolling', async () => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await list.open();
    });

    await step('Assert: Expected 3 — Every main control stays visible and usable at every tested size', async () => {
      obs.assertAll();
    });
  });
});
