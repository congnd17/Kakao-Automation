import { Request } from '@playwright/test';
import { test, expect } from '@fixtures/stock.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { StockColumnKey } from '@pages/stock-list.page';
import { StockUiPage } from '@pages/stock-ui.page';
import { SKU_LIST_ROUTE, STOCK_LIST_ROUTE, SkuSaveCapture, StockSkuSetPage } from '@pages/stock-sku-set.page';
import { stx } from '@utils/stock.i18n';
import { WORLD_NOTE, stockTags } from '@utils/stock-spec';
import { StockWorld, WorldSku, uniqueCode } from '@utils/stock.data';
import { stockDb } from '@utils/stock-db';
import { Observations } from '@utils/observations';
import type { SkuListRow, SkuType, StockApi } from '@api/stock.api';

/**
 * US134 — [Set SKU Form] TC_143–161, [SKU Master List] TC_162, [Digital SKU Form] TC_163–173.
 * Nguồn TC: SCRATCH/us134/TC_US134_<n>.txt (Steps N / Expected N → `Act: Step N` / `Assert: Expected N`).
 * Hành vi form verify theo bundle frontend (`Rue` set form, `Tue` digital form, `j8t` dialog SKU 검색, `Zq` 4 trường chung)
 * + recon out/pg-stock_set_create.*, pg-stock_digital_create.*, pg-sku-master_*. Kỳ vọng assert theo TC; chỗ UI khác TC
 * ghi trong description. SKU lưu qua form dùng mã `uniqueCode(world.tag, …)` và được đăng ký dọn ở afterEach.
 */
const SET_TAGS = stockTags('sku-set');
const MASTER_TAGS = stockTags('sku-master');
const DIGITAL_TAGS = stockTags('sku-digital');

/** 10 cột số lượng của bảng 재고 목록 (전체재고 … 미확보 출고수량). */
const QTY_COLUMNS: StockColumnKey[] = [
  'col.totalQuantity', 'col.reservedQuantity', 'col.availableQuantity', 'col.csQuantity', 'col.csOrderableQuantity',
  'col.pendingAllocationQuantity', 'col.orderableQuantity', 'col.incomingQuantity', 'col.insufficientQuantity', 'col.unconfirmedQuantity',
];

/** Câu chuẩn về vai SKU thành phần: SKU0009 của world là 구성품 (PARTS) nên SKU0003 (본품) đóng vai DEMO-SKU-0009. */
const COMPONENT_NOTE =
  'Set components: DEMO-SKU-0001 is the world SKU0001 (본품); the TC role "DEMO-SKU-0009, a 본품 (Main item)" is played by the world SKU0003 (본품, same partner), because the world SKU0009 is kind 구성품 (PARTS).';

/** Mã 상품코드 mà test có thể lưu qua form — đăng ký dọn ở afterEach (trackGroupCode chỉ tìm thấy sau khi đã lưu). */
const pendingCodes: string[] = [];

function remember(code: string): string {
  pendingCodes.push(code);
  return code;
}

function ownName(world: StockWorld, label: string): string {
  return `${world.tag} ${label}`;
}

/** Dòng SKU của 1 nhóm theo 상품코드 (GET /skus, khớp tuyệt đối) — GET /skus không truyền `type` chỉ trả SKU 현물, nên luôn truyền type. */
async function groupRows(stockApi: StockApi, code: string, type: SkuType): Promise<SkuListRow[]> {
  const { body } = await stockApi.skus({ type, searchType: 'SKU_GROUP_CODE', keyword: code });
  return body.items.filter((item) => item.skuGroupCode === code);
}

function serverMessage(capture: { body: SkuSaveCapture['body'] }): string {
  return String(capture.body.message ?? capture.body.detail ?? '');
}

const ko = (key: Parameters<typeof stx>[0]) => stx(key, 'ko');

test.afterEach(async ({ world }) => {
  for (const code of pendingCodes.splice(0)) await world.trackGroupCode(code);
});

test.describe('[Set SKU Form] set SKU create / edit form', () => {
  test('TC_US134_143 — The set SKU create screen opens straight from its address with its title, lit menu item and breadcrumb', async ({ page, skuFormPage: form }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form);
    await tcMeta(
      'TC_US134_143',
      'Medium',
      SET_TAGS,
      'Typing /commerce/product-stock/stock/set/create opens the set SKU form directly, the card title reads set SKU (its text is "set SKU"; CSS capitalises the first letter on screen, so it is rendered "Set SKU" — the gloss the TC gives), the left menu lights 재고 관리 inside 물류 관리 and the breadcrumb reads 물류 관리 › 재고 관리 › 생성. Per the recon of 05/10 the breadcrumb is route-based (Commerce › Product-stock › Stock › Set › Create), so Expected 4 is expected to fail until the breadcrumb is aligned with the TC.',
    );
    let title = '';
    let crumbs: string[] = [];

    await step('Arrange: Pre-condition 1–2 — Logged in with write access; the browser is on another screen, not on the stock list', async () => {
      await form.goto('/dashboards/main');
      await expect(page, 'The browser starts away from the stock list').not.toHaveURL(STOCK_LIST_ROUTE);
    });

    await step('Act: Step 1 — Type /commerce/product-stock/stock/set/create into the address bar and load the page', async () => {
      await form.openCreate('set');
    });

    await step('Assert: Expected 1 — The set SKU screen opens without going through the list first', async () => {
      await expect(page, '[Expected 1] The address is the set create route').toHaveURL(/\/commerce\/product-stock\/stock\/set\/create(\?|$)/);
      await expect(form.card, '[Expected 1] The set SKU form is shown').toBeVisible();
      await expect(form.modeBadge, `[Expected 1] The form is in ${ko('skuForm.mode.create')} mode`).toHaveText(ko('skuForm.mode.create'));
    });

    await step('Act: Step 2 — Read the page title', async () => {
      title = ((await form.cardTitle.textContent()) ?? '').trim();
    });

    await step('Assert: Expected 2 — The page title shows set SKU', async () => {
      expect(title, `[Expected 2] The title is ${ko('skuForm.title.set')}`).toBe(ko('skuForm.title.set'));
    });

    await step('Act: Step 3 — Look at the left menu and read which item is lit', async () => {
      await expect(page.locator('aside'), 'The left menu is shown').toBeVisible();
    });

    await step('Assert: Expected 3 — The left menu lights 재고 관리 inside the 물류 관리 group', async () => {
      await expect(ui.activeSidebarItem('재고 관리'), '[Expected 3] 재고 관리 (Stock management) is the lit menu item').toHaveCount(1);
      await expect(ui.activeSidebarItem('물류 관리'), '[Expected 3] The lit item sits inside the lit 물류 관리 (Logistics management) group').toHaveCount(1);
    });

    await step('Act: Step 4 — Read the breadcrumb', async () => {
      crumbs = await ui.breadcrumbTexts();
    });

    await step('Assert: Expected 4 — The breadcrumb reads 물류 관리 › 재고 관리 › 생성', async () => {
      expect(crumbs, '[Expected 4] The breadcrumb reads 물류 관리 › 재고 관리 › 생성').toEqual(['물류 관리', '재고 관리', '생성']);
    });
  });

  test('TC_US134_144 — Create on the set SKU master opens the set route and the SKU type is fixed to MIXED', async ({ page, world, skuFormPage: form, skuMasterPage: master }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form);
    const stockUi = new StockUiPage(page);
    await tcMeta(
      'TC_US134_144',
      'Medium',
      SET_TAGS,
      `The set SKU master list opens from 물류 관리 › SKU 마스터 관리 › set SKU 마스터 관리, its create action opens /commerce/product-stock/stock/set/create, SKU 유형 shows Set and is disabled, and a valid save sends type MIXED (not the label Set). Observed on dev 05/10: the SKU 마스터 관리 menu group does not exist (the route works by URL), so the menu part of Expected 1 is a soft failure and the list is opened by URL. ${COMPONENT_NOTE} ${WORLD_NOTE}`,
    );
    let viaMenu = false;
    let changed = false;
    let save: SkuSaveCapture | undefined;
    const code = uniqueCode(world.tag, 'S144');

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; the SKU master group is expected in the sidebar; network capture ready', async () => {
      expect(world.sku('SKU0001').usageType, 'Component DEMO-SKU-0001 is a main item').toBe('MAIN');
    });

    await step('Act: Step 1 — Open 물류 관리 › SKU 마스터 관리 › set SKU 마스터 관리', async () => {
      viaMenu = await stockUi.openMasterFromMenu('set');
    });

    await step('Assert: Expected 1 — The set SKU master list opens', async () => {
      expect.soft(viaMenu, '[Expected 1] The list is opened from the set SKU 마스터 관리 menu item').toBe(true);
      await expect(page, '[Expected 1] The set SKU master list is open').toHaveURL(/\/commerce\/product-stock\/sku-master\/set(\?|$)/);
      await expect(master.table, '[Expected 1] The set SKU master table is shown').toBeVisible();
    });

    await step('Act: Step 2 — Click the create action and read the page address', async () => {
      await stockUi.clickMasterCreate('set', 'ko');
      await expect(form.cardTitle, 'The set form loads').toBeVisible({ timeout: 30_000 });
    });

    await step('Assert: Expected 2 — The address is /commerce/product-stock/stock/set/create', async () => {
      await expect(page, '[Expected 2] The address is /commerce/product-stock/stock/set/create').toHaveURL(/\/commerce\/product-stock\/stock\/set\/create(\?|$)/);
    });

    await step('Act: Step 3 — Read SKU 유형 (SKU type) and try to change it', async () => {
      changed = await form.skuTypeSelect.selectOption({ index: 0 }, { timeout: 3_000 }).then(() => true).catch(() => false);
    });

    await step('Assert: Expected 3 — SKU 유형 shows Set and is disabled, so it cannot be changed', async () => {
      await expect(form.skuTypeSelect.locator('option').first(), `[Expected 3] SKU 유형 shows ${ko('skuType.MIXED')}`).toHaveText(ko('skuType.MIXED'));
      await expect(form.skuTypeSelect, '[Expected 3] SKU 유형 is disabled').toBeDisabled();
      expect(changed, '[Expected 3] SKU 유형 cannot be changed').toBe(false);
    });

    await step('Act: Step 4 — Save a valid set and read the SKU type the create request carries', async () => {
      await ui.fillCommon({ partnerId: world.partners.A.id, code, name: ownName(world, 'TC144 Set') });
      await ui.addComponents([{ code: world.sku('SKU0001').skuCode, quantity: '1' }, { code: world.sku('SKU0003').skuCode, quantity: '1' }]);
      await ui.checkCode();
      remember(code);
      save = await ui.saveCapture();
    });

    await step('Assert: Expected 4 — The request carries the value MIXED, not the label Set', async () => {
      expect(save?.status, '[Expected 4] The valid set is saved').toBeLessThan(300);
      expect(save?.requestBody.type, '[Expected 4] The create request carries SKU type MIXED').toBe('MIXED');
      expect(save?.requestBody.type, '[Expected 4] The create request does not carry the label Set').not.toBe('Set');
    });
  });

  test('TC_US134_145 — A new set SKU has no status field, is stored as SALE and shows on Stock Management as Set', async ({ page, world, stockApi, skuFormPage: form }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form);
    await tcMeta(
      'TC_US134_145',
      'Critical',
      SET_TAGS,
      `The set create form has no 상태 / 판매상태 field; saving Demo Partner A + a fresh product code (role DEMO-PC-918) + "Demo Set New" with DEMO-SKU-0001 × 1 and DEMO-SKU-0009 × 1 sends no status field, opens the Stock Management list, the SKU group reads back with status SALE, and the Stock Management row shows the product code, SKU 유형 Set and a disabled tick box. Per the frontend bundle a form opened by its address returns to /commerce/product-stock/sku-master/set after saving (the stock list only when opened from it), and GET /sku-groups/{id} carries no status field — Expected 4 (list) and 5 are expected to fail. ${COMPONENT_NOTE} ${WORLD_NOTE}`,
    );
    const code = uniqueCode(world.tag, 'S145');
    const name = ownName(world, 'Demo Set New');
    const c1 = world.sku('SKU0001');
    const c2 = world.sku('SKU0003');
    let check: Awaited<ReturnType<StockSkuSetPage['checkCode']>> | undefined;
    let save: SkuSaveCapture | undefined;
    let stored: Record<string, unknown> = {};
    let created: SkuListRow | undefined;

    await step('Arrange: Pre-condition 1–5 — Logged in with write access; a fresh product code; main-item components DEMO-SKU-0001 / 0009; network capture ready', async () => {
      expect((await stockApi.checkSkuGroupCode(code)).body.ids, 'The product code is not in use').toEqual([]);
    });

    await step('Act: Step 1 — Open set SKU 생성 and check the form for a 상태 or 판매상태 field', async () => {
      await form.openCreate('set');
    });

    await step('Assert: Expected 1 — No 상태 or 판매상태 field is displayed', async () => {
      for (const label of ['상태', '판매상태']) {
        await expect(form.card.locator('label.form-label', { hasText: new RegExp(`^${label}\\*?$`) }), `[Expected 1] No ${label} field on the form`).toHaveCount(0);
      }
    });

    await step('Act: Step 2 — Enter all test data and add DEMO-SKU-0001 and DEMO-SKU-0009 with 구성 개수 1 on each', async () => {
      await ui.fillCommon({ partnerId: world.partners.A.id, code, name });
      await ui.addComponents([{ code: c1.skuCode, quantity: '1' }, { code: c2.skuCode, quantity: '1' }]);
    });

    await step('Assert: Expected 2 — The form accepts every value and both components are added', async () => {
      await expect(form.bizPartnerSelect, '[Expected 2] 비즈파트너 holds Demo Partner A').toHaveValue(String(world.partners.A.id));
      await expect(form.skuGroupCodeInput, '[Expected 2] 상품코드 holds the typed code').toHaveValue(code);
      await expect(form.skuGroupCodeNameInput, '[Expected 2] 상품코드명 holds Demo Set New').toHaveValue(name);
      for (const sku of [c1, c2]) {
        await expect(ui.componentRow(sku.skuCode), `[Expected 2] Component ${sku.skuCode} is added`).toBeVisible();
        await expect(ui.quantityInput(ui.componentRow(sku.skuCode)), `[Expected 2] Component ${sku.skuCode} has 구성 개수 1`).toHaveValue('1');
      }
    });

    await step('Act: Step 3 — Complete 상품코드 중복확인', async () => {
      check = await ui.checkCode();
    });

    await step('Assert: Expected 3 — The product code duplicate check passes', async () => {
      expect(check?.status, '[Expected 3] The duplicate check answers 200').toBe(200);
      expect(check?.body.ids, '[Expected 3] The product code is reported free').toEqual([]);
      await expect(form.skuGroupCodeInput, '[Expected 3] The checked product code locks').toHaveJSProperty('readOnly', true);
    });

    await step('Act: Step 4 — Click 저장 and inspect the create request', async () => {
      remember(code);
      save = await ui.saveCapture();
    });

    await step('Assert: Expected 4 — Save succeeds, the request carries no status field and the Stock Management list opens', async () => {
      expect(save?.status, '[Expected 4] Save succeeds').toBeLessThan(300);
      expect(Object.keys(save?.requestBody ?? {}), '[Expected 4] The create request carries no status field').not.toContain('status');
      await expect.soft(page, '[Expected 4] The Stock Management list opens').toHaveURL(STOCK_LIST_ROUTE, { timeout: 30_000 });
    });

    await step('Act: Step 5 — Read the new SKU group back from the SKU read endpoint and check its status', async () => {
      created = (await groupRows(stockApi, code, 'MIXED'))[0];
      expect(created, 'The new SKU group is found by its product code').toBeDefined();
      stored = (await stockApi.skuGroup<Record<string, unknown>>(created?.skuGroupId ?? 0)).body ?? {};
    });

    await step('Assert: Expected 5 — The stored status is SALE', async () => {
      expect.soft(stored.status, '[Expected 5] The SKU group read back has status SALE').toBe('SALE');
    });

    let row = page.locator('tbody tr').first();
    await step('Act: Step 6 — On 재고 관리, search by 상품코드 for the new code and check the new row', async () => {
      row = await ui.findStockRow(code, created?.skuId ?? 0);
    });

    await step('Assert: Expected 6 — The row shows the product code, SKU 유형 Set and a disabled selection checkbox', async () => {
      await expect(row, '[Expected 6] The new set row is listed').toBeVisible();
      await expect(ui.list.cell(row, 'col.skuGroupCode'), '[Expected 6] The row shows the new product code').toHaveText(code);
      await expect(ui.list.cell(row, 'col.skuType'), `[Expected 6] SKU 유형 is ${ko('skuType.MIXED')}`).toHaveText(ko('skuType.MIXED'));
      await expect(ui.list.checkbox(row), '[Expected 6] The selection checkbox is disabled').toBeDisabled();
    });
  });

  test('TC_US134_146 — The SET 설정 table has exactly 4 columns and no allocation ratio, in create and edit mode', async ({ page, world, skuFormPage: form }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form);
    await tcMeta(
      'TC_US134_146',
      'Medium',
      SET_TAGS,
      `In create mode with 2 components the SET 설정 table shows exactly SKU 코드 · SKU명 · 구성 개수 · 삭제, each row holds 1 code, 1 name, 1 quantity box and 1 delete button, no 배분비율 / Allocation ratio exists anywhere, and the edit screen of an existing set group (role DEMO-PC-002 = the world set SKU0007) shows the same 4 headers. ${COMPONENT_NOTE} ${WORLD_NOTE}`,
    );
    const headerKeys = ['skuForm.col.skuCode', 'skuForm.col.skuName', 'skuForm.col.quantity', 'skuForm.col.delete'] as const;
    const parts = [world.sku('SKU0001'), world.sku('SKU0003')];
    let headers: string[] = [];
    let editHeaders: string[] = [];

    await step('Arrange: Pre-condition 1–2 — The set SKU screen is open in create mode with DEMO-SKU-0001 and DEMO-SKU-0009 added', async () => {
      await form.openCreate('set');
      await ui.addComponents(parts.map((sku) => ({ code: sku.skuCode })));
    });

    await step('Act: Step 1 — Read the column headers of the SET 설정 table and count them', async () => {
      headers = (await ui.componentHeaders.allTextContents()).map((text) => text.trim());
    });

    await step('Assert: Expected 1 — Exactly 4 headers: SKU 코드, SKU명, 구성 개수, 삭제', async () => {
      expect(headers.length, '[Expected 1] The table has exactly 4 headers').toBe(4);
      headerKeys.forEach((key, index) => expect(headers[index], `[Expected 1] Header ${index + 1} is ${ko(key)}`).toBe(ko(key)));
    });

    await step('Act: Step 2 — Read the cells of the 2 component rows', async () => {
      await expect(ui.componentRows, 'Both component rows are shown').toHaveCount(2);
    });

    await step('Assert: Expected 2 — Each row shows 1 SKU code, 1 SKU name, 1 quantity box and 1 delete button, nothing else', async () => {
      for (const sku of parts) {
        const row = ui.componentRow(sku.skuCode);
        await expect(row.locator('td'), `[Expected 2] Row ${sku.skuCode} has exactly 4 cells`).toHaveCount(4);
        await expect(row.locator('td').nth(0), `[Expected 2] Row ${sku.skuCode} shows its SKU code`).toHaveText(sku.skuCode);
        await expect(row.locator('td').nth(1), `[Expected 2] Row ${sku.skuCode} shows its SKU name`).toHaveText(sku.skuName);
        await expect(row.locator('td').nth(2).locator('input'), `[Expected 2] Row ${sku.skuCode} has 1 quantity box`).toHaveCount(1);
        await expect(row.locator('td').nth(3).getByRole('button'), `[Expected 2] Row ${sku.skuCode} has 1 delete button`).toHaveCount(1);
        await expect(row.locator('input, select, textarea, button'), `[Expected 2] Row ${sku.skuCode} holds no other control`).toHaveCount(2);
      }
    });

    await step('Act: Step 3 — Scan the whole form for any column or field called 배분비율 or Allocation ratio', async () => {
      await expect(form.card, 'The whole form is shown').toBeVisible();
    });

    await step('Assert: Expected 3 — No such column or field anywhere on the form', async () => {
      await expect(page.getByText(/배분비율/), '[Expected 3] No 배분비율 on the form').toHaveCount(0);
      await expect(page.getByText(/Allocation ratio/i), '[Expected 3] No Allocation ratio on the form').toHaveCount(0);
    });

    await step('Act: Step 4 — Open the edit screen of the existing set group and count the column headers again', async () => {
      await form.openEdit('set', world.sku('SKU0007').groupId);
      await expect(ui.componentRows.first(), 'The saved components are loaded').toBeVisible();
      editHeaders = (await ui.componentHeaders.allTextContents()).map((text) => text.trim());
    });

    await step('Assert: Expected 4 — The edit screen shows the same 4 headers', async () => {
      expect(editHeaders.length, '[Expected 4] The edit table has exactly 4 headers').toBe(4);
      headerKeys.forEach((key, index) => expect(editHeaders[index], `[Expected 4] Edit header ${index + 1} is ${ko(key)}`).toBe(ko(key)));
    });
  });

  test('TC_US134_147 — 추가 exists only in create mode and the component quantities are read-only in edit mode', async ({ page, world, skuFormPage: form, skuSearchDialog: dialog }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form, dialog);
    await tcMeta(
      'TC_US134_147',
      'Medium',
      SET_TAGS,
      `The create screen has 추가 below the SET 설정 table and it opens SKU 검색; the edit screen of a saved set group (role DEMO-PC-002 = the world set SKU0007, 2 parts) has no 추가 and its 구성 개수 boxes are read-only. ${WORLD_NOTE}`,
    );
    let addBelow = false;
    const quantities: Array<{ before: string; after: string; readOnly: boolean }> = [];

    await step('Arrange: Pre-condition 1–2 — Logged in with write access; set group DEMO-PC-002 has 2 saved parts', async () => {
      expect((await world.api.skuGroup(world.sku('SKU0007').groupId)).body.bundles?.length, 'The set group has 2 saved parts').toBe(2);
    });

    await step('Act: Step 1 — Open set SKU 생성 and look under the SET 설정 table', async () => {
      await form.openCreate('set');
      const table = await form.linesTable.boundingBox();
      const button = await ui.addComponentButton.boundingBox();
      addBelow = !!table && !!button && button.y >= table.y + table.height - 1;
    });

    await step('Assert: Expected 1 — There is a 추가 button under the table', async () => {
      await expect(ui.addComponentButton, `[Expected 1] ${ko('skuForm.btn.add')} is shown`).toBeVisible();
      expect(addBelow, `[Expected 1] ${ko('skuForm.btn.add')} sits under the ${ko('skuForm.section.set')} table`).toBe(true);
    });

    await step('Act: Step 2 — Click 추가 there', async () => {
      await form.click(ui.addComponentButton, `${ko('skuForm.btn.add')} button`);
    });

    await step('Assert: Expected 2 — The SKU 검색 dialog opens', async () => {
      await expect(dialog.root, `[Expected 2] The ${ko('skuSearch.title')} dialog opens`).toBeVisible();
    });

    await step('Act: Step 3 — Open the edit screen of DEMO-PC-002 and look under the SET 설정 table', async () => {
      await form.openEdit('set', world.sku('SKU0007').groupId);
      await expect(ui.componentRows, 'The 2 saved parts are loaded').toHaveCount(2);
    });

    await step('Assert: Expected 3 — There is no 추가 button under the table', async () => {
      await expect(ui.addComponentButton, `[Expected 3] No ${ko('skuForm.btn.add')} button in edit mode`).toHaveCount(0);
    });

    await step('Act: Step 4 — Look at the 구성 개수 fields on the edit screen and try to change them', async () => {
      for (const row of await ui.componentRows.all()) {
        const input = ui.quantityInput(row);
        const before = await input.inputValue();
        await input.press('End').catch(() => undefined);
        await input.pressSequentially('5', { timeout: 3_000 }).catch(() => undefined);
        quantities.push({ before, after: await input.inputValue(), readOnly: await input.evaluate((el) => (el as HTMLInputElement).readOnly) });
      }
    });

    await step('Assert: Expected 4 — The component quantity fields are read-only in edit mode', async () => {
      expect(quantities.length, '[Expected 4] Both quantity fields were read').toBe(2);
      quantities.forEach((q, index) => {
        expect(q.readOnly, `[Expected 4] Quantity field ${index + 1} is read-only`).toBe(true);
        expect(q.after, `[Expected 4] Quantity field ${index + 1} takes no change`).toBe(q.before);
      });
    });
  });

  test('TC_US134_148 — Set components can be added only through SKU Search; code and name cells take no typing', async ({ page, world, skuFormPage: form, skuSearchDialog: dialog }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form, dialog);
    await tcMeta(
      'TC_US134_148',
      'Medium',
      SET_TAGS,
      `With an empty SET 설정 table the SKU 코드 and SKU명 cells are not input fields; 추가 → SKU 검색 → tick DEMO-SKU-0001 → 추가 closes the dialog and adds 1 row with the code and name as read-only text and an empty editable 구성 개수 box. ${WORLD_NOTE}`,
    );
    const sku = world.sku('SKU0001');
    const editable = (column: number) => form.linesTable.locator(`tbody td:nth-child(${column})`).locator('input, textarea, select, [contenteditable="true"]');
    let codeEditors = -1;
    let nameEditors = -1;

    await step('Arrange: Pre-condition 1–2 — The set SKU screen is open in create mode with an empty SET 설정 table', async () => {
      await form.openCreate('set');
      await expect(ui.emptyRow, 'The SET 설정 table is empty').toBeVisible();
    });

    await step('Act: Step 1 — Try to type a SKU code straight into the SKU 코드 cell of the part table', async () => {
      codeEditors = await editable(1).count();
    });

    await step('Assert: Expected 1 — The cell takes no typing; it is not an input field', async () => {
      expect(codeEditors, `[Expected 1] The ${ko('skuForm.col.skuCode')} column holds no input field`).toBe(0);
    });

    await step('Act: Step 2 — Try to type a SKU name straight into the SKU명 cell', async () => {
      nameEditors = await editable(2).count();
    });

    await step('Assert: Expected 2 — The cell takes no typing', async () => {
      expect(nameEditors, `[Expected 2] The ${ko('skuForm.col.skuName')} column holds no input field`).toBe(0);
    });

    await step('Act: Step 3 — Click 추가, find DEMO-SKU-0001 in SKU 검색, tick it and click 추가 inside the dialog', async () => {
      await ui.openSearch();
      await ui.tickByCode([sku.skuCode]);
      await form.click(dialog.addButton, `${ko('skuSearch.btn.add')} button inside the dialog`);
    });

    await step('Assert: Expected 3 — The dialog closes and 1 part row is added', async () => {
      await expect(dialog.root, '[Expected 3] The SKU search dialog closes').toBeHidden();
      await expect(ui.componentRows, '[Expected 3] Exactly 1 part row is added').toHaveCount(1);
    });

    await step('Act: Step 4 — Read the new part row', async () => {
      await expect(ui.componentRow(sku.skuCode), 'The new row is shown').toBeVisible();
    });

    await step('Assert: Expected 4 — Code and name are read-only text; 구성 개수 is 1 editable empty field', async () => {
      const row = ui.componentRow(sku.skuCode);
      await expect(row.locator('td').nth(0), '[Expected 4] The row shows the SKU code').toHaveText(sku.skuCode);
      await expect(row.locator('td').nth(0).locator('input, textarea'), '[Expected 4] The SKU code is read-only text').toHaveCount(0);
      await expect(row.locator('td').nth(1), '[Expected 4] The row shows the SKU name').toHaveText(sku.skuName);
      await expect(row.locator('td').nth(1).locator('input, textarea'), '[Expected 4] The SKU name is read-only text').toHaveCount(0);
      await expect(ui.quantityInput(row), '[Expected 4] There is exactly 1 구성 개수 field').toHaveCount(1);
      await expect(ui.quantityInput(row), '[Expected 4] 구성 개수 is editable').toBeEditable();
      await expect(ui.quantityInput(row), '[Expected 4] 구성 개수 is left empty').toHaveValue('');
    });
  });

  test('TC_US134_149 — SKU Search offers 2 search fields and returns and adds only physical SKUs', async ({ page, world, skuFormPage: form, skuSearchDialog: dialog }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form, dialog);
    const stockUi = new StockUiPage(page);
    await tcMeta(
      'TC_US134_149',
      'Medium',
      SET_TAGS,
      'The SKU 검색 dialog has exactly 2 search fields (SKU명 default, SKU 코드); a SKU명 search on the shared keyword lists the 3 physical SKUs and not the set SKU; every result row reads 현물; ticking 2 and clicking 추가 adds 2 rows with an empty 구성 개수. Data: the test creates its own SKUs whose names share the keyword "<tag> TC149 Demo Album" — physical 2-option group (roles DEMO-SKU-0001 / 0002), physical single (role DEMO-SKU-0009), digital (role DEMO-SKU-0006) and a set of them (role DEMO-SKU-0007).',
    );
    const keyword = ownName(world, 'TC149 Demo Album');
    let album: WorldSku[] = [];
    let keyring: WorldSku | undefined;
    let digital: WorldSku | undefined;
    let set: WorldSku | undefined;
    let fields: string[] = [];
    let types: string[] = [];

    await step('Arrange: Pre-condition 1–3 — The set create screen is open; physical, digital and set SKUs share the keyword Demo Album', async () => {
      album = await world.createPhysicalSku('P149', { partner: world.partners.A, manufacturer: world.manufacturers.M1, groupName: keyword, lines: [{ option: 'A' }, { option: 'B' }] });
      [keyring] = await world.createPhysicalSku('K149', { partner: world.partners.A, manufacturer: world.manufacturers.M1, groupName: `${keyword} Keyring` });
      digital = await world.createDigitalSku('D149', world.partners.A, `${keyword} Digital`);
      set = await world.createSetSku('S149', world.partners.A, [{ sku: album[0], quantity: 1 }, { sku: keyring, quantity: 1 }], `${keyword} Set`);
      await form.openCreate('set');
    });

    await step('Act: Step 1 — Click 추가 and read the choices in 검색조건 of the SKU 검색 dialog', async () => {
      await ui.openSearch();
      fields = await stockUi.optionTexts(dialog.searchFieldSelect);
    });

    await step('Assert: Expected 1 — 검색조건 has exactly 2 choices: SKU명 (default) and SKU 코드', async () => {
      expect(fields, `[Expected 1] The choices are exactly ${ko('skuSearch.field.SKU_NAME')}, ${ko('skuSearch.field.SKU_CODE')}`).toEqual([ko('skuSearch.field.SKU_NAME'), ko('skuSearch.field.SKU_CODE')]);
      await expect(dialog.searchFieldSelect, `[Expected 1] ${ko('skuSearch.field.SKU_NAME')} is the default`).toHaveValue('SKU_NAME');
    });

    await step('Act: Step 2 — Type Demo Album into 검색어 with 검색조건 on SKU명 and click 검색', async () => {
      await dialog.search('SKU_NAME', keyword);
    });

    await step('Assert: Expected 2 — The results list the 3 physical SKUs and not the set SKU', async () => {
      for (const sku of [...album, keyring as WorldSku]) {
        await expect(dialog.row(sku.skuCode), `[Expected 2] Physical SKU ${sku.skuCode} is listed`).toBeVisible();
      }
      await expect(dialog.row(set?.skuCode ?? ''), `[Expected 2] Set SKU ${set?.skuCode} is not listed`).toHaveCount(0);
    });

    await step('Act: Step 3 — Read the SKU 유형 value of every result row', async () => {
      types = await ui.dialogTypes();
    });

    await step('Assert: Expected 3 — Every result row shows 현물; no 디지털 row and no Set row', async () => {
      expect(types.length, '[Expected 3] The search returned rows').toBeGreaterThan(0);
      for (const sku of [...album, keyring as WorldSku]) {
        await expect(dialog.row(sku.skuCode).locator('td').nth(3), `[Expected 3] ${sku.skuCode} shows ${ko('skuType.PHYSICAL')}`).toHaveText(ko('skuType.PHYSICAL'));
      }
      expect(types.every((type) => type === ko('skuType.PHYSICAL')), `[Expected 3] Every result row shows ${ko('skuType.PHYSICAL')}`).toBe(true);
      expect(types, `[Expected 3] No ${ko('skuType.DIGITAL')} row`).not.toContain(ko('skuType.DIGITAL'));
      expect(types, `[Expected 3] No ${ko('skuType.MIXED')} row`).not.toContain(ko('skuType.MIXED'));
      await expect(dialog.row(digital?.skuCode ?? ''), `[Expected 3] Digital SKU ${digital?.skuCode} is not listed`).toHaveCount(0);
    });

    await step('Act: Step 4 — Tick DEMO-SKU-0001 and DEMO-SKU-0009, click 추가 inside the dialog, then read the part rows', async () => {
      await ui.dialogCheckbox(album[0].skuCode).check();
      await ui.dialogCheckbox((keyring as WorldSku).skuCode).check();
      await ui.confirmDialog();
    });

    await step('Assert: Expected 4 — 2 part rows are added, 1 per ticked SKU, each with an empty 구성 개수', async () => {
      await expect(ui.componentRows, '[Expected 4] Exactly 2 part rows are added').toHaveCount(2);
      for (const sku of [album[0], keyring as WorldSku]) {
        await expect(ui.componentRow(sku.skuCode), `[Expected 4] A row is added for ${sku.skuCode}`).toBeVisible();
        await expect(ui.quantityInput(ui.componentRow(sku.skuCode)), `[Expected 4] 구성 개수 of ${sku.skuCode} is empty`).toHaveValue('');
      }
    });
  });

  test('TC_US134_150 — 구성 개수 is required, digits only, capped at 1,000 and read-only in edit mode', async ({ page, world, skuFormPage: form, skuSearchDialog: dialog }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form, dialog);
    await tcMeta(
      'TC_US134_150',
      'Medium',
      SET_TAGS,
      `With 1 part and valid other fields, an empty 구성 개수 keeps 저장 disabled; 1000 saves and returns to the list; on a new set screen 1001 is not kept and never sent, and 1.5 is refused; in edit mode (role DEMO-PC-002 = the world set SKU0007) the quantity is read-only. Per the frontend bundle 저장 is NOT disabled by an empty quantity (only by an empty table or an unchecked product code — the Save-time message 구성 개수를 입력해주세요 answers it), so Expected 1 is expected to fail; the quantity box keeps digits only (max 4) and refuses a value above 1000 while typing (typing 1001 leaves 100, typing 1.5 leaves 15). "Returns to the list" accepts the stock list or the set SKU master list. ${WORLD_NOTE}`,
    );
    const sku = world.sku('SKU0001');
    const code1 = uniqueCode(world.tag, 'S150A');
    const code2 = uniqueCode(world.tag, 'S150B');
    let saveDisabled = false;
    let save: SkuSaveCapture | undefined;
    let value1001 = '';
    let value15 = '';
    const sent: Array<Record<string, unknown>> = [];
    const quantities: Array<{ before: string; after: string; readOnly: boolean }> = [];

    await step('Arrange: Pre-condition 1–4 — The set create screen has 1 part DEMO-SKU-0001 and valid values in every other required field', async () => {
      await ui.openReadyCreate('set', { partnerId: world.partners.A.id, code: code1, name: ownName(world, 'TC150 Set') });
      await ui.addComponents([{ code: sku.skuCode }]);
    });

    await step('Act: Step 1 — Leave 구성 개수 empty and read the state of 저장', async () => {
      saveDisabled = await form.saveButton.isDisabled();
    });

    await step('Assert: Expected 1 — 저장 is disabled', async () => {
      await expect(ui.quantityInput(ui.componentRow(sku.skuCode)), '[Expected 1] 구성 개수 is empty').toHaveValue('');
      expect.soft(saveDisabled, `[Expected 1] ${ko('btn.save')} is disabled while 구성 개수 is empty`).toBe(true);
    });

    await step('Act: Step 2 — Type 1000 into 구성 개수 and click 저장', async () => {
      await ui.quantityInput(ui.componentRow(sku.skuCode)).pressSequentially('1000');
      remember(code1);
      save = await ui.saveCapture();
    });

    await step('Assert: Expected 2 — The save goes through and returns to the list', async () => {
      expect(save?.status, '[Expected 2] The set with 구성 개수 1000 is saved').toBeLessThan(300);
      expect((save?.requestBody.bundles as Array<{ quantity: number }> | undefined)?.[0]?.quantity, '[Expected 2] The request carries 구성 개수 1000').toBe(1000);
      await expect(page, '[Expected 2] The form returns to the list').toHaveURL(SKU_LIST_ROUTE, { timeout: 30_000 });
    });

    await step('Act: Step 3 — Open a new set screen, add 1 part, type 1001, click 저장, then try typing 1.5', async () => {
      await ui.openReadyCreate('set', { partnerId: world.partners.A.id, code: code2, name: ownName(world, 'TC150 Set 1001') });
      await ui.addComponents([{ code: sku.skuCode }]);
      const quantity = ui.quantityInput(ui.componentRow(sku.skuCode));
      await quantity.pressSequentially('1001');
      value1001 = await quantity.inputValue();
      const onRequest = (request: Request) => {
        if (new URL(request.url()).pathname === '/api/v1/skus' && request.method() === 'POST') sent.push((request.postDataJSON() ?? {}) as Record<string, unknown>);
      };
      page.on('request', onRequest);
      remember(code2);
      await form.click(form.saveButton, `${ko('btn.save')} button`);
      await ui.waitForAnswer();
      page.off('request', onRequest);
      if (!/\/stock\/set\/create/.test(page.url())) {
        await form.openCreate('set');
        await ui.addComponents([{ code: sku.skuCode }]);
      }
      const retry = ui.quantityInput(ui.componentRow(sku.skuCode));
      await retry.fill('');
      await retry.pressSequentially('1.5');
      value15 = await retry.inputValue();
    });

    await step('Assert: Expected 3 — 1001 is blocked and 1.5 is refused', async () => {
      expect(value1001, '[Expected 3] The field does not keep 1001').not.toBe('1001');
      const quantitiesSent = sent.flatMap((body) => ((body.bundles as Array<{ quantity: number }> | undefined) ?? []).map((bundle) => bundle.quantity));
      expect(quantitiesSent, '[Expected 3] No save request carries 구성 개수 1001').not.toContain(1001);
      expect(value15, '[Expected 3] The field does not accept 1.5').not.toBe('1.5');
    });

    await step('Act: Step 4 — Open the edit screen of DEMO-PC-002 and try to change a 구성 개수 value', async () => {
      await form.openEdit('set', world.sku('SKU0007').groupId);
      await expect(ui.componentRows.first(), 'The saved parts are loaded').toBeVisible();
      const input = ui.quantityInput(ui.componentRows.first());
      const before = await input.inputValue();
      await input.press('End').catch(() => undefined);
      await input.pressSequentially('7', { timeout: 3_000 }).catch(() => undefined);
      quantities.push({ before, after: await input.inputValue(), readOnly: await input.evaluate((el) => (el as HTMLInputElement).readOnly) });
    });

    await step('Assert: Expected 4 — The field is read-only and takes no change', async () => {
      expect(quantities[0]?.readOnly, '[Expected 4] 구성 개수 is read-only in edit mode').toBe(true);
      expect(quantities[0]?.after, '[Expected 4] 구성 개수 takes no change').toBe(quantities[0]?.before);
    });
  });

  test('TC_US134_151 — 저장 is blocked once no component SKU remains, and works again after adding 2', async ({ page, world, skuFormPage: form, skuSearchDialog: dialog }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form, dialog);
    await tcMeta(
      'TC_US134_151',
      'High',
      SET_TAGS,
      `Deleting DEMO-SKU-0009 leaves 1 row (DEMO-SKU-0001), deleting DEMO-SKU-0001 empties the table and 저장 becomes disabled; adding both again with 구성 개수 1 and saving goes through and returns to the list (stock list or set SKU master list). ${COMPONENT_NOTE} ${WORLD_NOTE}`,
    );
    const c1 = world.sku('SKU0001');
    const c2 = world.sku('SKU0003');
    const code = uniqueCode(world.tag, 'S151');
    let left: string[] = [];
    let save: SkuSaveCapture | undefined;

    await step('Arrange: Pre-condition 1–3 — The set create screen holds DEMO-SKU-0001 and DEMO-SKU-0009 and valid values in every other field', async () => {
      await ui.openReadyCreate('set', { partnerId: world.partners.A.id, code, name: ownName(world, 'TC151 Set') });
      await ui.addComponents([{ code: c1.skuCode, quantity: '1' }, { code: c2.skuCode, quantity: '1' }]);
    });

    await step('Act: Step 1 — Click 삭제 on the DEMO-SKU-0009 part and count the rows left', async () => {
      await form.click(ui.deleteButton(ui.componentRow(c2.skuCode)), `${ko('skuForm.btn.delete')} button of ${c2.skuCode}`);
      left = await ui.componentCodes();
    });

    await step('Assert: Expected 1 — One row is left, DEMO-SKU-0001', async () => {
      expect(left, `[Expected 1] Only ${c1.skuCode} is left`).toEqual([c1.skuCode]);
    });

    await step('Act: Step 2 — Click 삭제 on the DEMO-SKU-0001 part and count the rows left', async () => {
      await form.click(ui.deleteButton(ui.componentRow(c1.skuCode)), `${ko('skuForm.btn.delete')} button of ${c1.skuCode}`);
    });

    await step('Assert: Expected 2 — The table is empty', async () => {
      await expect(ui.componentRows, '[Expected 2] No part row is left').toHaveCount(0);
      await expect(ui.emptyRow, `[Expected 2] The table shows ${ko('skuForm.err.setEmpty')}`).toBeVisible();
    });

    await step('Act: Step 3 — Read the state of 저장', async () => {
      await expect(form.saveButton, 'The save button is shown').toBeVisible();
    });

    await step('Assert: Expected 3 — 저장 is disabled', async () => {
      await expect(form.saveButton, `[Expected 3] ${ko('btn.save')} is disabled with no component`).toBeDisabled();
    });

    await step('Act: Step 4 — Add DEMO-SKU-0001 and DEMO-SKU-0009 again with 구성 개수 1 each and click 저장', async () => {
      await ui.addComponents([{ code: c1.skuCode, quantity: '1' }, { code: c2.skuCode, quantity: '1' }]);
      remember(code);
      save = await ui.saveCapture();
    });

    await step('Assert: Expected 4 — The save goes through and returns to the list', async () => {
      expect(save?.status, '[Expected 4] The set is saved').toBeLessThan(300);
      await expect(page, '[Expected 4] The form returns to the list').toHaveURL(SKU_LIST_ROUTE, { timeout: 30_000 });
    });
  });

  test('TC_US134_152 — SKU Search filters on SKU type only: digital and set SKUs are hidden, a 구성품 SKU is offered', async ({ page, world, skuFormPage: form, skuSearchDialog: dialog }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form, dialog);
    await tcMeta(
      'TC_US134_152',
      'Medium',
      SET_TAGS,
      `Searching SKU 코드 in the SKU 검색 dialog lists and lets you tick DEMO-SKU-0001 (physical, 본품), hides DEMO-SKU-0006 (digital) and DEMO-SKU-0007 (set), and lists and lets you tick a physical 구성품 SKU (role DEMO-SKU-COMP-001, created by the test). Per the frontend bundle the dialog asks GET /skus with type=PHYSICAL&bundleableOnly=true, and the run of 05/10 confirmed that the server also leaves out the 구성품 (PARTS) SKU (검색 결과가 없습니다.): the search filters on SKU kind as well, so Expected 4 fails (TC ≠ UI, to be confirmed by BA). ${WORLD_NOTE}`,
    );
    let component: WorldSku | undefined;
    const results: Record<string, { count: number; ticked: boolean }> = {};

    const searchAndTick = async (code: string, tick: boolean) => {
      await dialog.search('SKU_CODE', code);
      await expect(dialog.rows.first(), 'The result table is refreshed').toBeVisible();
      const count = await dialog.row(code).count();
      let ticked = false;
      if (tick && count > 0) {
        await ui.dialogCheckbox(code).check();
        ticked = await ui.dialogCheckbox(code).isChecked();
      }
      results[code] = { count, ticked };
    };

    await step('Arrange: Pre-condition 1–3 — The set create form is open; DEMO-SKU-0001, 0006, 0007 and a physical 구성품 SKU exist', async () => {
      [component] = await world.createPhysicalSku('Q152', { partner: world.partners.A, manufacturer: world.manufacturers.M1, usageType: 'PARTS', groupName: ownName(world, 'TC152 Component') });
      await form.openCreate('set');
    });

    await step('Act: Step 1 — Click 추가, select SKU 코드 and search for DEMO-SKU-0001', async () => {
      await ui.openSearch();
      await searchAndTick(world.sku('SKU0001').skuCode, true);
    });

    await step('Assert: Expected 1 — DEMO-SKU-0001 is displayed and can be selected as a set component', async () => {
      expect(results[world.sku('SKU0001').skuCode].count, `[Expected 1] ${world.sku('SKU0001').skuCode} is displayed`).toBe(1);
      expect(results[world.sku('SKU0001').skuCode].ticked, `[Expected 1] ${world.sku('SKU0001').skuCode} can be ticked`).toBe(true);
    });

    await step('Act: Step 2 — Search for DEMO-SKU-0006', async () => {
      await searchAndTick(world.sku('SKU0006').skuCode, false);
    });

    await step('Assert: Expected 2 — DEMO-SKU-0006 (digital) is not displayed', async () => {
      expect(results[world.sku('SKU0006').skuCode].count, `[Expected 2] Digital SKU ${world.sku('SKU0006').skuCode} is not displayed`).toBe(0);
    });

    await step('Act: Step 3 — Search for DEMO-SKU-0007', async () => {
      await searchAndTick(world.sku('SKU0007').skuCode, false);
    });

    await step('Assert: Expected 3 — DEMO-SKU-0007 (set) is not displayed', async () => {
      expect(results[world.sku('SKU0007').skuCode].count, `[Expected 3] Set SKU ${world.sku('SKU0007').skuCode} is not displayed`).toBe(0);
    });

    await step('Act: Step 4 — Search for DEMO-SKU-COMP-001', async () => {
      await searchAndTick((component as WorldSku).skuCode, true);
    });

    await step('Assert: Expected 4 — The 구성품 SKU is displayed and can be ticked (filter on SKU type only)', async () => {
      const code = (component as WorldSku).skuCode;
      expect(results[code].count, `[Expected 4] 구성품 SKU ${code} is displayed`).toBe(1);
      expect(results[code].ticked, `[Expected 4] 구성품 SKU ${code} can be ticked`).toBe(true);
    });
  });

  test('TC_US134_153 — SKU Search is paginated by 10 and reaches a match on the second page', async ({ page, world, stockApi, skuFormPage: form, skuSearchDialog: dialog }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form, dialog);
    await tcMeta(
      'TC_US134_153',
      'Medium',
      SET_TAGS,
      'A SKU명 search on a keyword shared by 12 physical SKUs shows 10 rows and a pager (총 12개의 SKU 중 1-10개 표시 + page buttons, as on the stock list); page 2 lists a SKU that was not on page 1, and ticking it + 추가 adds it as a component row. Data: the test creates 1 physical group "<tag> TC153 Demo" with 12 option lines; the SKU that sorts onto page 2 is read from GET /skus (page 1, size 10) before the search.',
    );
    const keyword = ownName(world, 'TC153');
    let target: WorldSku | undefined;
    let rowCount = 0;
    let onFirstPage = -1;

    await step('Arrange: Pre-condition 1–4 — 12 physical SKUs share a keyword, one sorts onto page 2; the set create form is open', async () => {
      const lines = Array.from({ length: 12 }, (_, index) => ({ option: `O${String(index + 1).padStart(2, '0')}`, skuCode: uniqueCode(world.tag, `T53L${index}`) }));
      const skus = await world.createPhysicalSku('T53', { partner: world.partners.A, manufacturer: world.manufacturers.M1, groupName: `${keyword} Demo`, lines });
      const secondPage = (await stockApi.skus({ type: 'PHYSICAL', searchType: 'SKU_NAME', keyword, page: 1, size: 10 })).body.items;
      target = skus.find((sku) => sku.skuId === secondPage[0]?.skuId);
      expect(target, 'One of the 12 SKUs sorts onto the second page').toBeDefined();
      await form.openCreate('set');
    });

    await step('Act: Step 1 — Click 추가, search on the keyword and count the rows in the result table', async () => {
      await ui.openSearch();
      await dialog.search('SKU_NAME', keyword);
      await expect(dialog.rows.first(), 'The results are shown').toBeVisible();
      rowCount = await dialog.rows.count();
      onFirstPage = await dialog.row((target as WorldSku).skuCode).count();
    });

    await step('Assert: Expected 1 — The table shows 10 rows', async () => {
      expect(rowCount, '[Expected 1] The first page shows 10 rows').toBe(10);
    });

    await step('Act: Step 2 — Look below the table for a paging control', async () => {
      await dialog.pagination.scrollIntoViewIfNeeded().catch(() => undefined);
    });

    await step('Assert: Expected 2 — A paging control is present and behaves as the stock list one', async () => {
      await expect(dialog.pagination, '[Expected 2] A paging control is below the table').toBeVisible();
      await expect(dialog.root.getByText('총 12개의 SKU 중 1-10개 표시', { exact: true }), '[Expected 2] The pager reads 총 12개의 SKU 중 1-10개 표시 as on the stock list').toBeVisible();
      await expect(dialog.pagination.getByRole('button', { name: '2', exact: true }), '[Expected 2] The pager offers page 2').toBeVisible();
    });

    await step('Act: Step 3 — Go to page 2 and find the SKU that was not on page 1', async () => {
      const response = page.waitForResponse((res) => res.url().includes('/api/v1/skus?') && res.url().includes('page=1'));
      await form.click(dialog.pagination.getByRole('button', { name: '2', exact: true }), 'page 2 of the SKU search');
      await response;
    });

    await step('Assert: Expected 3 — Page 2 opens and the SKU is listed', async () => {
      expect(onFirstPage, `[Expected 3] ${(target as WorldSku).skuCode} was not on page 1`).toBe(0);
      await expect(dialog.root.getByText('총 12개의 SKU 중 11-12개 표시', { exact: true }), '[Expected 3] Page 2 is open').toBeVisible();
      await expect(dialog.row((target as WorldSku).skuCode), `[Expected 3] ${(target as WorldSku).skuCode} is listed on page 2`).toBeVisible();
    });

    await step('Act: Step 4 — Tick it and click 추가 inside the dialog', async () => {
      await ui.dialogCheckbox((target as WorldSku).skuCode).check();
      await ui.confirmDialog();
    });

    await step('Assert: Expected 4 — It is added to the SET 설정 table as a component row', async () => {
      await expect(ui.componentRows, '[Expected 4] Exactly 1 component row is added').toHaveCount(1);
      await expect(ui.componentRow((target as WorldSku).skuCode), `[Expected 4] ${(target as WorldSku).skuCode} is the added component`).toBeVisible();
    });
  });

  test('TC_US134_154 — 취소 closes SKU Search without adding the ticked SKUs', async ({ page, world, skuFormPage: form, skuSearchDialog: dialog }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form, dialog);
    await tcMeta(
      'TC_US134_154',
      'Medium',
      SET_TAGS,
      `With DEMO-SKU-0001 already in the SET 설정 table, searching a keyword, ticking 2 results and clicking 취소 closes the dialog and leaves the table with exactly its 1 component. Data: the 2 findable SKUs are a 2-option physical group "<tag> TC154 Demo" created by the test. ${WORLD_NOTE}`,
    );
    const existing = world.sku('SKU0001');
    const keyword = ownName(world, 'TC154');
    let found: WorldSku[] = [];
    let before: string[] = [];
    let after: string[] = [];

    await step('Arrange: Pre-condition 1–3 — The set create screen holds 1 component; 2 physical SKUs are findable by a keyword', async () => {
      found = await world.createPhysicalSku('P154', { partner: world.partners.A, manufacturer: world.manufacturers.M1, groupName: `${keyword} Demo`, lines: [{ option: 'A' }, { option: 'B' }] });
      await form.openCreate('set');
      await ui.addComponents([{ code: existing.skuCode }]);
    });

    await step('Act: Step 1 — Note which components the SET 설정 table already holds', async () => {
      before = await ui.componentCodes();
    });

    await step('Assert: Expected 1 — The table holds its 1 existing component', async () => {
      expect(before, `[Expected 1] The table holds only ${existing.skuCode}`).toEqual([existing.skuCode]);
    });

    await step('Act: Step 2 — Click 추가, search on the keyword and tick 2 results', async () => {
      await ui.openSearch();
      await dialog.search('SKU_NAME', keyword);
      for (const sku of found) await ui.dialogCheckbox(sku.skuCode).check();
    });

    await step('Assert: Expected 2 — The dialog lists the matches and both rows are ticked', async () => {
      for (const sku of found) {
        await expect(dialog.row(sku.skuCode), `[Expected 2] ${sku.skuCode} is listed`).toBeVisible();
        await expect(ui.dialogCheckbox(sku.skuCode), `[Expected 2] ${sku.skuCode} is ticked`).toBeChecked();
      }
    });

    await step('Act: Step 3 — Click 취소', async () => {
      await form.click(dialog.cancelButton, `${ko('btn.cancel')} button of the dialog`);
    });

    await step('Assert: Expected 3 — The dialog closes', async () => {
      await expect(dialog.root, '[Expected 3] The SKU search dialog closes').toBeHidden();
    });

    await step('Act: Step 4 — Read the SET 설정 table', async () => {
      after = await ui.componentCodes();
    });

    await step('Assert: Expected 4 — The table is unchanged: exactly the 1 starting component, neither ticked SKU added', async () => {
      expect(after, `[Expected 4] The table still holds exactly ${existing.skuCode}`).toEqual([existing.skuCode]);
      for (const sku of found) expect(after, `[Expected 4] Ticked SKU ${sku.skuCode} is not added`).not.toContain(sku.skuCode);
    });
  });

  test('TC_US134_155 — 저장 is rejected with WH-SKU_NOT_FOUND when a component SKU is deleted after selection', async ({ page, world, skuFormPage: form, skuSearchDialog: dialog }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form, dialog);
    await tcMeta(
      'TC_US134_155',
      'Medium',
      SET_TAGS,
      'With a component added (role DEMO-SKU-0009: a physical 본품 SKU created by the test) and 구성 개수 1, soft-deleting that SKU in the database while the form stays open changes nothing on the form; 중복확인 + 저장 is rejected with WH-SKU_NOT_FOUND: SKU를 찾을 수 없습니다. - id: <the real SKU id>, and the form stays open with every typed value. The soft delete is a DB fixture (sku.deleted_at) on the test\'s own SKU. Per the frontend bundle the page alert shows the server message only (no code prefix), so the "WH-SKU_NOT_FOUND:" part of Expected 3 may fail; the error code is also checked on the response.',
    );
    const code = uniqueCode(world.tag, 'S155');
    const name = ownName(world, 'TC155 Set');
    let part: WorldSku | undefined;
    let save: SkuSaveCapture | undefined;

    await step('Arrange: Pre-condition 1–4 — The set create form is open with the common fields filled; the component SKU exists in SKU 검색', async () => {
      [part] = await world.createPhysicalSku('P155', { partner: world.partners.A, manufacturer: world.manufacturers.M1, groupName: ownName(world, 'TC155 Part') });
      await form.openCreate('set');
      await ui.fillCommon({ partnerId: world.partners.A.id, code, name });
    });

    await step('Act: Step 1 — Add DEMO-SKU-0009 as a part and type 구성 개수 1', async () => {
      await ui.addComponents([{ code: (part as WorldSku).skuCode, quantity: '1' }]);
    });

    await step('Assert: Expected 1 — The part row is added', async () => {
      await expect(ui.componentRow((part as WorldSku).skuCode), '[Expected 1] The part row is added').toBeVisible();
    });

    await step('Act: Step 2 — Soft-delete DEMO-SKU-0009 in the database while this form stays open', async () => {
      await stockDb.softDeleteSku((part as WorldSku).skuId);
    });

    await step('Assert: Expected 2 — Nothing on the form changes', async () => {
      await expect(ui.componentRows, '[Expected 2] The form still holds 1 part row').toHaveCount(1);
      await expect(ui.quantityInput(ui.componentRow((part as WorldSku).skuCode)), '[Expected 2] 구성 개수 still reads 1').toHaveValue('1');
      await expect(form.skuGroupCodeNameInput, '[Expected 2] 상품코드명 is unchanged').toHaveValue(name);
    });

    await step('Act: Step 3 — Click 중복확인 and then 저장', async () => {
      await ui.checkCode();
      remember(code);
      save = await ui.saveCapture();
    });

    await step('Assert: Expected 3 — The save is rejected with WH-SKU_NOT_FOUND: SKU를 찾을 수 없습니다. - id: <deleted SKU id>', async () => {
      const id = (part as WorldSku).skuId;
      expect(save?.status, '[Expected 3] The save is rejected').toBeGreaterThanOrEqual(400);
      expect(save?.body.code, '[Expected 3] The error code is WH-SKU_NOT_FOUND').toBe('WH-SKU_NOT_FOUND');
      expect(serverMessage(save as SkuSaveCapture), `[Expected 3] The message names the real id ${id}`).toContain(`SKU를 찾을 수 없습니다. - id: ${id}`);
      await expect(ui.formAlert, `[Expected 3] The screen shows WH-SKU_NOT_FOUND: SKU를 찾을 수 없습니다. - id: ${id}`).toContainText(`WH-SKU_NOT_FOUND: SKU를 찾을 수 없습니다. - id: ${id}`);
    });

    await step('Act: Step 4 — See whether the form is still open', async () => {
      await expect(form.card, 'The form card is shown').toBeVisible();
    });

    await step('Assert: Expected 4 — The form is still open and keeps every typed value', async () => {
      await expect(page, '[Expected 4] The set create form is still open').toHaveURL(/\/commerce\/product-stock\/stock\/set\/create/);
      await expect(form.bizPartnerSelect, '[Expected 4] 비즈파트너 is kept').toHaveValue(String(world.partners.A.id));
      await expect(form.skuGroupCodeInput, '[Expected 4] 상품코드 is kept').toHaveValue(code);
      await expect(form.skuGroupCodeNameInput, '[Expected 4] 상품코드명 is kept').toHaveValue(name);
      await expect(ui.quantityInput(ui.componentRow((part as WorldSku).skuCode)), '[Expected 4] The part row and its 구성 개수 1 are kept').toHaveValue('1');
    });
  });

  test('TC_US134_156 — The 3 rejection reasons of WH-SKU_INVALID_COMPONENTS_TO_BUNDLE (diversity, SKU type, SKU kind)', async ({ page, world, stockApi, skuFormPage: form, skuSearchDialog: dialog }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form, dialog);
    await tcMeta(
      'TC_US134_156',
      'Medium',
      SET_TAGS,
      `A set of only DEMO-SKU-0001 × 1 is turned down with WH-SKU_INVALID_COMPONENTS_TO_BUNDLE and the diversity / total-quantity detail (SKU 개수: 1, 총 수량: 1); a direct POST /skus (same session account) with DEMO-SKU-0001 × 1 + DEMO-SKU-0006 (digital) × 1 gets the same code with the SKU-type detail; DEMO-SKU-0001 × 1 + a 구성품 SKU × 1 on the form gets the same code with the MAIN/GIVEAWAY-only detail. Role DEMO-SKU-0013 (physical 구성품) is a SKU created by the test. Messages are read from the save response (the screen shows the same server message). Deviation seen on 05/10 (same cause as TC_US134_152): SKU 검색 asks bundleableOnly=true and does not offer the 구성품 SKU, so it cannot be added on the form — this is recorded as a soft failure in Step 5 and the same set (DEMO-SKU-0001 × 1 + the 구성품 SKU × 1) is then sent straight to POST /skus with the session account, so Expected 5–6 still check the server rule. ${WORLD_NOTE}`,
    );
    const code = uniqueCode(world.tag, 'S156');
    const apiCode = uniqueCode(world.tag, 'A156');
    const kindCode = uniqueCode(world.tag, 'K156');
    let parts: WorldSku | undefined;
    let first: SkuSaveCapture | undefined;
    let direct: { status: number; body: SkuSaveCapture['body'] } | undefined;
    let third: SkuSaveCapture | undefined;

    await step('Arrange: Pre-condition 1–4 — DEMO-SKU-0001 (본품), DEMO-SKU-0006 (digital) and a 구성품 SKU exist; the set create form has valid common fields', async () => {
      [parts] = await world.createPhysicalSku('Q156', { partner: world.partners.A, manufacturer: world.manufacturers.M1, usageType: 'PARTS', groupName: ownName(world, 'TC156 Component') });
      await ui.openReadyCreate('set', { partnerId: world.partners.A.id, code, name: ownName(world, 'TC156 Set') });
    });

    await step('Act: Step 1 — Add DEMO-SKU-0001 as the only component with 구성 개수 1, then click 저장', async () => {
      await ui.addComponents([{ code: world.sku('SKU0001').skuCode, quantity: '1' }]);
      remember(code);
      first = await ui.saveCapture();
    });

    await step('Assert: Expected 1 — The save is turned down and the form stays open', async () => {
      expect(first?.status, '[Expected 1] The save is turned down').toBeGreaterThanOrEqual(400);
      await expect(page, '[Expected 1] The form stays open').toHaveURL(/\/commerce\/product-stock\/stock\/set\/create/);
    });

    await step('Act: Step 2 — Read the error code and the message', async () => {
      await ui.formAlert.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
    });

    await step('Assert: Expected 2 — WH-SKU_INVALID_COMPONENTS_TO_BUNDLE with the diversity / total-quantity detail', async () => {
      const message = serverMessage(first as SkuSaveCapture);
      expect(first?.body.code, '[Expected 2] The error code is WH-SKU_INVALID_COMPONENTS_TO_BUNDLE').toBe('WH-SKU_INVALID_COMPONENTS_TO_BUNDLE');
      expect(message, '[Expected 2] The outer message is 유효하지 않은 구성 요소입니다. {detail}').toContain('유효하지 않은 구성 요소입니다.');
      expect(message, '[Expected 2] The detail reads 최소 {minDiversity}개 이상의 서로 다른 SKU를 묶거나, 총 수량이 {minQuantity}개 이상이어야 합니다.').toMatch(/최소 \d+개 이상의 서로 다른 SKU를 묶거나, 총 수량이 \d+개 이상이어야 합니다\./);
      expect(message, '[Expected 2] The detail ends with - SKU 개수: 1, 총 수량: 1').toContain('- SKU 개수: 1, 총 수량: 1');
    });

    await step('Act: Step 3 — Send the set create call straight to the server with DEMO-SKU-0001 × 1 and DEMO-SKU-0006 × 1', async () => {
      remember(apiCode);
      const result = await stockApi.createSku<SkuSaveCapture['body']>({
        type: 'MIXED',
        bizPartnerId: world.partners.A.id,
        group: { code: apiCode, name: ownName(world, 'TC156 Direct') },
        bundles: [{ skuId: world.sku('SKU0001').skuId, quantity: 1 }, { skuId: world.sku('SKU0006').skuId, quantity: 1 }],
      });
      direct = { status: result.status, body: (result.body ?? {}) as SkuSaveCapture['body'] };
    });

    await step('Assert: Expected 3 — The call is turned down with the same error code', async () => {
      expect(direct?.status, '[Expected 3] The direct call is turned down').toBeGreaterThanOrEqual(400);
      expect(direct?.body.code, '[Expected 3] The error code is WH-SKU_INVALID_COMPONENTS_TO_BUNDLE').toBe('WH-SKU_INVALID_COMPONENTS_TO_BUNDLE');
    });

    await step('Act: Step 4 — Read the message', async () => {
      expect(direct, 'The direct call answered').toBeDefined();
    });

    await step('Assert: Expected 4 — The detail reads 묶을 수 없는 유형의 SKU 입니다. - skuType: {type}', async () => {
      const message = serverMessage(direct as { body: SkuSaveCapture['body'] });
      expect(message, '[Expected 4] The outer message is 유효하지 않은 구성 요소입니다.').toContain('유효하지 않은 구성 요소입니다.');
      expect(message, '[Expected 4] The detail reads 묶을 수 없는 유형의 SKU 입니다. - skuType: DIGITAL').toContain('묶을 수 없는 유형의 SKU 입니다. - skuType: DIGITAL');
    });

    await step('Act: Step 5 — On the form keep DEMO-SKU-0001 × 1, add DEMO-SKU-0013 (구성품) × 1 and click 저장', async () => {
      const partCode = (parts as WorldSku).skuCode;
      await ui.openSearch();
      await dialog.search('SKU_CODE', partCode);
      await expect(dialog.rows.first(), 'The result table is refreshed').toBeVisible();
      const offered = (await dialog.row(partCode).count()) > 0;
      expect.soft(offered, `SKU search offers the 구성품 SKU ${partCode} so it can be added on the form (TC_US134_152: the search filters on SKU type only)`).toBe(true);
      if (offered) {
        await ui.dialogCheckbox(partCode).check();
        await ui.confirmDialog();
        await ui.quantityInput(ui.componentRow(partCode)).fill('1');
        third = await ui.saveCapture();
        return;
      }
      await form.click(dialog.cancelButton, `${ko('btn.cancel')} button of the SKU search dialog`);
      await expect(dialog.root, 'The SKU search dialog closes').toBeHidden();
      remember(kindCode);
      const bundles = [{ skuId: world.sku('SKU0001').skuId, quantity: 1 }, { skuId: (parts as WorldSku).skuId, quantity: 1 }];
      const requestBody = { type: 'MIXED', bizPartnerId: world.partners.A.id, group: { code: kindCode, name: ownName(world, 'TC156 Kind') }, bundles };
      const result = await stockApi.createSku<SkuSaveCapture['body']>(requestBody);
      third = { requestBody, status: result.status, body: (result.body ?? {}) as SkuSaveCapture['body'] };
    });

    await step('Assert: Expected 5 — The save is turned down with the same error code', async () => {
      expect(third?.status, '[Expected 5] The save is turned down').toBeGreaterThanOrEqual(400);
      expect(third?.body.code, '[Expected 5] The error code is WH-SKU_INVALID_COMPONENTS_TO_BUNDLE').toBe('WH-SKU_INVALID_COMPONENTS_TO_BUNDLE');
    });

    await step('Act: Step 6 — Read the message', async () => {
      await ui.formAlert.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
    });

    await step('Assert: Expected 6 — The detail reads 본품(MAIN) 또는 사은품(GIVEAWAY) 용도만 묶을 수 있습니다. - usageType: {usageType}', async () => {
      const message = serverMessage(third as SkuSaveCapture);
      expect(message, '[Expected 6] The outer message is 유효하지 않은 구성 요소입니다.').toContain('유효하지 않은 구성 요소입니다.');
      expect(message, '[Expected 6] The detail reads 본품(MAIN) 또는 사은품(GIVEAWAY) 용도만 묶을 수 있습니다. - usageType: PARTS').toContain('본품(MAIN) 또는 사은품(GIVEAWAY) 용도만 묶을 수 있습니다. - usageType: PARTS');
    });
  });

  test('TC_US134_157 — A set is accepted at the minimum of each bundle branch (1 SKU × 2, or 2 SKUs × 1)', async ({ page, world, skuFormPage: form, skuSearchDialog: dialog }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form, dialog);
    await tcMeta(
      'TC_US134_157',
      'Critical',
      SET_TAGS,
      `A set of only DEMO-SKU-0001 with 구성 개수 2 (single-SKU quantity branch) and a set of DEMO-SKU-0001 × 1 + DEMO-SKU-0009 × 1 (diversity branch), both for Demo Partner A with fresh product codes (roles DEMO-PC-920 / 921), save and return to the list (stock list or set SKU master list). ${COMPONENT_NOTE} ${WORLD_NOTE}`,
    );
    const codeA = uniqueCode(world.tag, 'S157A');
    const codeB = uniqueCode(world.tag, 'S157B');
    let saveA: SkuSaveCapture | undefined;
    let saveB: SkuSaveCapture | undefined;

    await step('Arrange: Pre-condition 1–4 — Fresh product codes; DEMO-SKU-0001 and DEMO-SKU-0009 are 본품; partner Demo Partner A', async () => {
      expect(world.sku('SKU0001').usageType, 'DEMO-SKU-0001 is a main item').toBe('MAIN');
      expect(world.sku('SKU0003').usageType, 'The second component is a main item').toBe('MAIN');
    });

    await step('Act: Step 1 — Create set 데모 세트 A with only DEMO-SKU-0001 × 2, pass 중복확인 and click 저장', async () => {
      await ui.openReadyCreate('set', { partnerId: world.partners.A.id, code: codeA, name: ownName(world, '데모 세트 A') });
      await ui.addComponents([{ code: world.sku('SKU0001').skuCode, quantity: '2' }]);
      remember(codeA);
      saveA = await ui.saveCapture();
    });

    await step('Assert: Expected 1 — The save goes through and returns to the list', async () => {
      expect(saveA?.status, '[Expected 1] Set A (1 SKU × 2) is saved').toBeLessThan(300);
      await expect(page, '[Expected 1] The form returns to the list').toHaveURL(SKU_LIST_ROUTE, { timeout: 30_000 });
    });

    await step('Act: Step 2 — Create set Demo Set B with DEMO-SKU-0001 × 1 and DEMO-SKU-0009 × 1, pass 중복확인 and click 저장', async () => {
      await ui.openReadyCreate('set', { partnerId: world.partners.A.id, code: codeB, name: ownName(world, 'Demo Set B') });
      await ui.addComponents([{ code: world.sku('SKU0001').skuCode, quantity: '1' }, { code: world.sku('SKU0003').skuCode, quantity: '1' }]);
      remember(codeB);
      saveB = await ui.saveCapture();
    });

    await step('Assert: Expected 2 — The save goes through and returns to the list', async () => {
      expect(saveB?.status, '[Expected 2] Set B (2 SKUs × 1) is saved').toBeLessThan(300);
      await expect(page, '[Expected 2] The form returns to the list').toHaveURL(SKU_LIST_ROUTE, { timeout: 30_000 });
    });
  });

  test('TC_US134_158 — The set form product code duplicate check on the unpressed, duplicate and clean paths', async ({ page, world, skuFormPage: form, skuSearchDialog: dialog }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form, dialog);
    await tcMeta(
      'TC_US134_158',
      'High',
      SET_TAGS,
      `On the set create form (partner, name and 1 component filled) a fresh code typed without 중복확인 keeps 저장 disabled; the existing code (role DEMO-PC-002 = the world set SKU0007 group code) answers HTTP 200 with a non-empty ids array, no error code, shows 이미 등록된 상품코드입니다. and leaves the field editable; a fresh code (role DEMO-PC-919) answers an empty ids array, locks the field and makes 저장 reachable. Nothing is saved. ${WORLD_NOTE}`,
    );
    const fresh = uniqueCode(world.tag, 'S158');
    const existing = world.sku('SKU0007').groupCode;
    let duplicate: Awaited<ReturnType<StockSkuSetPage['checkCode']>> | undefined;
    let clean: Awaited<ReturnType<StockSkuSetPage['checkCode']>> | undefined;
    let typed = '';

    await step('Arrange: Pre-condition 1–4 — Existing and fresh product codes; the set create form has 비즈파트너, 상품코드명 and 1 component', async () => {
      await form.openCreate('set');
      await ui.fillCommon({ partnerId: world.partners.A.id, name: ownName(world, 'TC158 Set') });
      await ui.addComponents([{ code: world.sku('SKU0001').skuCode, quantity: '2' }]);
    });

    await step('Act: Step 1 — Type the fresh code into 상품코드 WITHOUT pressing 중복확인', async () => {
      await form.skuGroupCodeInput.pressSequentially(fresh);
    });

    await step('Assert: Expected 1 — The value is typed', async () => {
      await expect(form.skuGroupCodeInput, '[Expected 1] 상품코드 holds the typed value').toHaveValue(fresh);
    });

    await step('Act: Step 2 — Read the state of 저장', async () => {
      await expect(form.saveButton, 'The save button is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — 저장 is disabled', async () => {
      await expect(form.saveButton, `[Expected 2] ${ko('btn.save')} is disabled while the duplicate check is outstanding`).toBeDisabled();
    });

    await step('Act: Step 3 — Replace the value with the existing code, click 중복확인 and read the response and the message', async () => {
      await form.skuGroupCodeInput.fill(existing);
      duplicate = await ui.checkCode();
    });

    await step('Assert: Expected 3 — HTTP 200, a non-empty ids array, no error code; the screen shows 이미 등록된 상품코드입니다.', async () => {
      expect(duplicate?.status, '[Expected 3] The check answers HTTP 200').toBe(200);
      expect((duplicate?.body.ids ?? []).length, '[Expected 3] The ids array is not empty').toBeGreaterThan(0);
      expect(duplicate?.body.code, '[Expected 3] The response raises no error code').toBeUndefined();
      await expect(form.fieldError('skuForm.field.skuGroupCode'), `[Expected 3] The screen shows ${ko('skuForm.err.codeDuplicated')}`).toHaveText(ko('skuForm.err.codeDuplicated'));
    });

    await step('Act: Step 4 — Try to type into 상품코드', async () => {
      await form.skuGroupCodeInput.press('End');
      await form.skuGroupCodeInput.pressSequentially('X', { timeout: 3_000 }).catch(() => undefined);
      typed = await form.skuGroupCodeInput.inputValue();
    });

    await step('Assert: Expected 4 — The field is still enabled and editable', async () => {
      await expect(form.skuGroupCodeInput, '[Expected 4] 상품코드 is enabled').toBeEnabled();
      await expect(form.skuGroupCodeInput, '[Expected 4] 상품코드 is not read-only').toHaveJSProperty('readOnly', false);
      expect(typed, '[Expected 4] 상품코드 takes the typed character').toBe(`${existing}X`);
    });

    await step('Act: Step 5 — Replace it with the fresh code, click 중복확인 again and read the field state', async () => {
      await form.skuGroupCodeInput.fill(fresh);
      clean = await ui.checkCode();
    });

    await step('Assert: Expected 5 — An empty ids array, the field locks and 저장 becomes reachable', async () => {
      expect(clean?.body.ids, '[Expected 5] The check answers an empty ids array').toEqual([]);
      await expect(form.skuGroupCodeInput, '[Expected 5] 상품코드 locks').toHaveJSProperty('readOnly', true);
      await expect(form.saveButton, `[Expected 5] ${ko('btn.save')} becomes reachable`).toBeEnabled();
    });
  });

  test('TC_US134_159 — Several components are added in one pass of SKU Search', async ({ page, world, skuFormPage: form, skuSearchDialog: dialog }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form, dialog);
    await tcMeta(
      'TC_US134_159',
      'Medium',
      SET_TAGS,
      'Clicking 추가 opens SKU 검색; ticking 3 physical 본품 SKUs on one page and clicking 추가 closes the dialog and adds 3 rows in one pass, one per ticked SKU, each with a blank editable 구성 개수. Data: the 3 SKUs are a 3-option physical group "<tag> TC159 Demo" created by the test.',
    );
    const keyword = ownName(world, 'TC159');
    let skus: WorldSku[] = [];

    await step('Arrange: Pre-condition 1–3 — 3 physical 본품 SKUs are findable; the set create form has an empty SET 설정 table', async () => {
      skus = await world.createPhysicalSku('P159', { partner: world.partners.A, manufacturer: world.manufacturers.M1, groupName: `${keyword} Demo`, lines: [{ option: 'A' }, { option: 'B' }, { option: 'C' }] });
      await form.openCreate('set');
      await expect(ui.emptyRow, 'The SET 설정 table is empty').toBeVisible();
    });

    await step('Act: Step 1 — Click 추가 under the SET 설정 table', async () => {
      await form.click(ui.addComponentButton, `${ko('skuForm.btn.add')} button`);
    });

    await step('Assert: Expected 1 — The SKU 검색 dialog opens', async () => {
      await expect(dialog.root, `[Expected 1] The ${ko('skuSearch.title')} dialog opens`).toBeVisible();
    });

    await step('Act: Step 2 — Tick 3 SKUs in the dialog', async () => {
      await dialog.search('SKU_NAME', keyword);
      for (const sku of skus) await ui.dialogCheckbox(sku.skuCode).check();
    });

    await step('Assert: Expected 2 — All 3 are ticked', async () => {
      for (const sku of skus) await expect(ui.dialogCheckbox(sku.skuCode), `[Expected 2] ${sku.skuCode} is ticked`).toBeChecked();
    });

    await step('Act: Step 3 — Click 추가 inside the dialog', async () => {
      await form.click(dialog.addButton, `${ko('skuSearch.btn.add')} button inside the dialog`);
    });

    await step('Assert: Expected 3 — The dialog closes', async () => {
      await expect(dialog.root, '[Expected 3] The SKU search dialog closes').toBeHidden();
    });

    await step('Act: Step 4 — Read the SET 설정 table', async () => {
      await expect(ui.componentRows.first(), 'The component rows are shown').toBeVisible();
    });

    await step('Assert: Expected 4 — 3 part rows are added in one pass, one per ticked SKU', async () => {
      await expect(ui.componentRows, '[Expected 4] Exactly 3 part rows are added').toHaveCount(3);
      for (const sku of skus) await expect(ui.componentRow(sku.skuCode), `[Expected 4] A row is added for ${sku.skuCode}`).toBeVisible();
    });

    await step('Act: Step 5 — Read the 구성 개수 cell of each new row', async () => {
      await expect(ui.quantityInput(ui.componentRows.first()), 'The quantity cells are shown').toBeVisible();
    });

    await step('Assert: Expected 5 — Each quantity cell is blank and editable', async () => {
      for (const sku of skus) {
        await expect(ui.quantityInput(ui.componentRow(sku.skuCode)), `[Expected 5] 구성 개수 of ${sku.skuCode} is blank`).toHaveValue('');
        await expect(ui.quantityInput(ui.componentRow(sku.skuCode)), `[Expected 5] 구성 개수 of ${sku.skuCode} is editable`).toBeEditable();
      }
    });
  });

  test('TC_US134_160 — Clicking the product code of a set row opens the set edit route', async ({ page, world, skuFormPage: form }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form);
    const set = world.sku('SKU0007');
    await tcMeta(
      'TC_US134_160',
      'Medium',
      SET_TAGS,
      `On 재고 관리 the set row (role DEMO-PC-002 = the world set SKU0007, 2 saved components) shows SKU 유형 Set; its 상품코드 is a link that opens /commerce/product-stock/stock/set/edit?skuGroupId=<id> with the breadcrumb … › Stock management › Edit and the set form listing both components with their quantities. Per the recon of 05/10 the breadcrumb is route-based (… › Stock › Set › Edit), so the breadcrumb part of Expected 3 is expected to fail. ${WORLD_NOTE}`,
    );
    let row = page.locator('tbody tr').first();
    let linkCount = 0;
    let crumbs: string[] = [];

    await step('Arrange: Pre-condition 1–3 — The set group exists with 2 saved components, is visible on 재고 관리 and its skuGroupId is known', async () => {
      expect(set.type, 'The world SKU0007 is a set SKU').toBe('MIXED');
    });

    await step('Act: Step 1 — Open 재고 관리 and find the set row', async () => {
      row = await ui.findStockRow(set.groupCode, set.skuId);
    });

    await step('Assert: Expected 1 — The row is listed with SKU 유형 Set', async () => {
      await expect(row, '[Expected 1] The set row is listed').toBeVisible();
      await expect(ui.list.cell(row, 'col.skuType'), `[Expected 1] SKU 유형 is ${ko('skuType.MIXED')}`).toHaveText(ko('skuType.MIXED'));
    });

    await step('Act: Step 2 — Click its 상품코드 link', async () => {
      const link = ui.list.cell(row, 'col.skuGroupCode').getByRole('link', { name: set.groupCode, exact: true });
      linkCount = await link.count();
      await form.click(link, `product code ${set.groupCode}`);
      await expect(form.cardTitle, 'The SKU form loads').toBeVisible({ timeout: 30_000 });
    });

    await step('Assert: Expected 2 — The form opens; the product code is a link, not plain text', async () => {
      expect(linkCount, '[Expected 2] The product code is a link').toBe(1);
      await expect(form.card, '[Expected 2] The form opens').toBeVisible();
    });

    await step('Act: Step 3 — Read the page address and the breadcrumb', async () => {
      await expect(ui.componentRows.first(), 'The saved values are loaded').toBeVisible({ timeout: 30_000 });
      crumbs = await ui.breadcrumbTexts();
    });

    await step('Assert: Expected 3 — /commerce/product-stock/stock/set/edit?skuGroupId=…; breadcrumb … › Stock management › Edit; the Set form', async () => {
      await expect(page, '[Expected 3] The address is the set edit route of this group').toHaveURL(new RegExp(`/commerce/product-stock/stock/set/edit\\?skuGroupId=${set.groupId}(&|$)`));
      expect.soft(crumbs.slice(-2), '[Expected 3] The breadcrumb ends … › 재고 관리 (Stock management) › 수정 (Edit)').toEqual(['재고 관리', ko('skuForm.mode.edit')]);
      await expect(form.cardTitle, `[Expected 3] The form is the ${ko('skuForm.title.set')} form, not the physical one`).toHaveText(ko('skuForm.title.set'));
    });

    await step('Act: Step 4 — Read the SET 설정 table', async () => {
      await expect(ui.componentRows.first(), 'The SET 설정 table is shown').toBeVisible();
    });

    await step('Assert: Expected 4 — Both saved components are listed with their quantities', async () => {
      await expect(ui.componentRows, '[Expected 4] The table lists 2 components').toHaveCount(2);
      for (const key of ['SKU0001', 'SKU0009'] as const) {
        const component = ui.componentRow(world.sku(key).skuCode);
        await expect(component, `[Expected 4] Component ${world.sku(key).skuCode} is listed`).toBeVisible();
        await expect(ui.quantityInput(component), `[Expected 4] Component ${world.sku(key).skuCode} shows quantity 1`).toHaveValue('1');
      }
    });
  });

  test('TC_US134_161 — In edit mode the set form locks 비즈파트너, 상품코드 and SKU 유형 and keeps 상품코드명 editable', async ({ page, world, skuFormPage: form }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form);
    const set = world.sku('SKU0007');
    await tcMeta(
      'TC_US134_161',
      'Medium',
      SET_TAGS,
      `The edit form of the set group (role DEMO-PC-002 = the world set SKU0007) shows the 4 common fields and the SET 설정 table; 비즈파트너 is locked with 생성 후 수정 불가능합니다 on its row (in edit and in create mode), 상품코드 is read-only, SKU 유형 is disabled, 상품코드명 is editable and 삭제 of a saved component row is disabled. Nothing is saved. Per the frontend bundle the 삭제 button of a saved component is not disabled in edit mode, so that part of Expected 5 is expected to fail. ${WORLD_NOTE}`,
    );
    const note = { edit: false, editSameRow: false, create: false, partnerChanged: false };
    let codeTyped = '';
    let typeChanged = false;
    let nameValue = '';
    const newName = `${set.groupName} edited`;

    await step('Arrange: Pre-condition 1–2 — The set group exists with 2 saved components', async () => {
      expect(set.type, 'The world SKU0007 is a set SKU').toBe('MIXED');
    });

    await step('Act: Step 1 — Open the set group in edit mode', async () => {
      await form.openEdit('set', set.groupId);
    });

    await step('Assert: Expected 1 — The edit form opens with the 4 common fields and the SET 설정 table', async () => {
      await expect(form.modeBadge, `[Expected 1] The form is in ${ko('skuForm.mode.edit')} mode`).toHaveText(ko('skuForm.mode.edit'));
      for (const key of ['skuForm.field.skuType', 'skuForm.field.bizPartner', 'skuForm.field.skuGroupCode', 'skuForm.field.skuGroupCodeName'] as const) {
        await expect(form.label(key), `[Expected 1] Field ${ko(key)} is shown`).toBeVisible();
      }
      await expect(form.card.locator('div.fw-semibold', { hasText: ko('skuForm.section.set') }), `[Expected 1] The ${ko('skuForm.section.set')} section is shown`).toBeVisible();
      await expect(ui.componentRows, `[Expected 1] The ${ko('skuForm.section.set')} table lists the saved components`).toHaveCount(2);
    });

    await step('Act: Step 2 — Try to change 비즈파트너 and read the note on its row (edit, then create mode)', async () => {
      note.partnerChanged = await form.bizPartnerSelect.selectOption({ index: 0 }, { timeout: 3_000 }).then(() => true).catch(() => false);
      note.edit = await form.bizPartnerLockNote.isVisible();
      const fieldBox = await form.field('skuForm.field.bizPartner').boundingBox();
      const noteBox = await form.bizPartnerLockNote.boundingBox();
      note.editSameRow = !!fieldBox && !!noteBox && noteBox.y >= fieldBox.y && noteBox.y + noteBox.height <= fieldBox.y + fieldBox.height + 1;
      await form.openCreate('set');
      note.create = await form.bizPartnerLockNote.isVisible();
      await form.openEdit('set', set.groupId);
    });

    await step('Assert: Expected 2 — 비즈파트너 is locked and 생성 후 수정 불가능합니다 is shown on its row, in both modes', async () => {
      await expect(form.bizPartnerSelect, '[Expected 2] 비즈파트너 is locked').toBeDisabled();
      expect(note.partnerChanged, '[Expected 2] 비즈파트너 cannot be changed').toBe(false);
      expect(note.edit, `[Expected 2] ${ko('skuForm.lockNotice')} is shown in edit mode`).toBe(true);
      expect(note.editSameRow, `[Expected 2] ${ko('skuForm.lockNotice')} sits on the 비즈파트너 row`).toBe(true);
      expect(note.create, `[Expected 2] ${ko('skuForm.lockNotice')} is shown in create mode too`).toBe(true);
    });

    await step('Act: Step 3 — Try to change 상품코드', async () => {
      await form.skuGroupCodeInput.press('End').catch(() => undefined);
      await form.skuGroupCodeInput.pressSequentially('X', { timeout: 3_000 }).catch(() => undefined);
      codeTyped = await form.skuGroupCodeInput.inputValue();
    });

    await step('Assert: Expected 3 — 상품코드 is read-only', async () => {
      await expect(form.skuGroupCodeInput, '[Expected 3] 상품코드 is read-only').toHaveJSProperty('readOnly', true);
      expect(codeTyped, '[Expected 3] 상품코드 takes no change').toBe(set.groupCode);
    });

    await step('Act: Step 4 — Try to change SKU 유형', async () => {
      typeChanged = await form.skuTypeSelect.selectOption({ index: 0 }, { timeout: 3_000 }).then(() => true).catch(() => false);
    });

    await step('Assert: Expected 4 — SKU 유형 is disabled, as in create mode', async () => {
      await expect(form.skuTypeSelect, '[Expected 4] SKU 유형 is disabled').toBeDisabled();
      expect(typeChanged, '[Expected 4] SKU 유형 cannot be changed').toBe(false);
    });

    await step('Act: Step 5 — Try to change 상품코드명, then read the 삭제 control on a saved component row', async () => {
      await form.skuGroupCodeNameInput.fill(newName);
      nameValue = await form.skuGroupCodeNameInput.inputValue();
    });

    await step('Assert: Expected 5 — 상품코드명 is editable and 삭제 of a saved component row is disabled', async () => {
      expect(nameValue, '[Expected 5] 상품코드명 takes the new value').toBe(newName);
      await expect(ui.deleteButton(ui.componentRows.first()), `[Expected 5] ${ko('skuForm.btn.delete')} of a saved component is disabled`).toBeDisabled();
    });
  });
});

test.describe('[SKU Master List] SKU master routes', () => {
  test('TC_US134_162 — Each of the 3 SKU master routes lists only its own SKU type and a product code opens the shared edit route', async ({ page, world, stockListPage: list, skuMasterPage: master }) => {
    const step = makeStep(page);
    const stockUi = new StockUiPage(page);
    const obs = new Observations(page);
    await tcMeta(
      'TC_US134_162',
      'High',
      MASTER_TAGS,
      `물류 관리 › SKU 마스터 관리 › 현물 / set / 디지털 SKU 마스터 관리 open /commerce/product-stock/sku-master/physical, /set and /digital, each listing only its own SKU type (checked on the demo world: 8 physical, 2 set, 2 digital groups — roles DEMO-PC-001 / 002 / 004); a product code on the physical master opens /commerce/product-stock/stock/physical/edit?skuGroupId=… — the same address as the 재고 관리 link; the sidebar is the only entry point and every route starts with /commerce. Observed on dev 05/10: the SKU 마스터 관리 menu group does not exist (the routes work by URL), so the menu parts of Expected 1, 3 and 5 are expected to fail; the lists are then opened by URL. ${WORLD_NOTE}`,
    );
    const physical = ['SKU0001', 'SKU0002', 'SKU0003', 'SKU0004', 'SKU0005', 'SKU0008', 'SKU0009', 'SKU0011'];
    const byKind: Record<'set' | 'digital', string[]> = { set: ['SKU0007', 'SKU0012'], digital: ['SKU0006', 'SKU0010'] };
    const all = [...physical, ...byKind.set, ...byKind.digital];
    const routes: string[] = [];
    let viaMenu = false;
    let stockHref: string | null = null;
    let otherEntries = -1;
    let sidebarGroup = 0;
    const listed = (code: string) => master.row(code).waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);

    await step('Arrange: Pre-condition 1–2 — Logged in with write access; the catalogue holds physical, set and digital SKU groups', async () => {
      expect(world.sku('SKU0001').type, 'The world holds a physical group').toBe('PHYSICAL');
      expect(world.sku('SKU0007').type, 'The world holds a set group').toBe('MIXED');
      expect(world.sku('SKU0006').type, 'The world holds a digital group').toBe('DIGITAL');
    });

    await step('Act: Step 1 — Open 물류 관리 › SKU 마스터 관리 › 현물 SKU 마스터 관리', async () => {
      viaMenu = await stockUi.openMasterFromMenu('physical');
      routes.push(new URL(page.url()).pathname);
    });

    await step('Assert: Expected 1 — The list opens', async () => {
      expect.soft(viaMenu, '[Expected 1] The list is opened from the 현물 SKU 마스터 관리 menu item').toBe(true);
      await expect(master.table, '[Expected 1] The physical SKU master list is shown').toBeVisible();
    });

    await step('Act: Step 2 — Read the page address and the rows listed', async () => {
      await master.search('SKU_GROUP_CODE_NAME', world.keyword);
    });

    await step('Assert: Expected 2 — The address is /commerce/product-stock/sku-master/physical and only physical SKU groups are listed', async () => {
      await expect(page, '[Expected 2] The address is /commerce/product-stock/sku-master/physical').toHaveURL(/\/commerce\/product-stock\/sku-master\/physical(\?|$)/);
      for (const key of physical) await expect(master.row(world.sku(key).skuCode), `[Expected 2] Physical SKU ${world.sku(key).skuCode} is listed`).toBeVisible();
      for (const key of [...byKind.set, ...byKind.digital]) {
        await expect(master.row(world.sku(key).skuCode), `[Expected 2] ${world.sku(key).type} SKU ${world.sku(key).skuCode} is not listed`).toHaveCount(0);
      }
    });

    await step('Act: Step 3 — Do the same for set SKU 마스터 관리 and 디지털 SKU 마스터 관리', async () => {
      for (const kind of ['set', 'digital'] as const) {
        const fromMenu = await stockUi.openMasterFromMenu(kind);
        routes.push(new URL(page.url()).pathname);
        await obs.record(`[Expected 3] The ${kind} SKU master list is opened from its menu item`, async () => fromMenu);
        await obs.record(`[Expected 3] The address is /commerce/product-stock/sku-master/${kind}`, async () => new RegExp(`/commerce/product-stock/sku-master/${kind}(\\?|$)`).test(page.url()));
        await master.search('SKU_GROUP_CODE_NAME', world.keyword);
        for (const key of byKind[kind]) await obs.record(`[Expected 3] The ${kind} list shows ${world.sku(key).skuCode}`, () => listed(world.sku(key).skuCode));
        for (const key of all.filter((k) => !byKind[kind].includes(k))) {
          await obs.record(`[Expected 3] The ${kind} list does not show ${world.sku(key).type} SKU ${world.sku(key).skuCode}`, async () => (await master.row(world.sku(key).skuCode).count()) === 0);
        }
        await obs.screenshot(`${kind} SKU master list`);
      }
    });

    await step('Assert: Expected 3 — /sku-master/set and /sku-master/digital list only set and only digital SKU groups', async () => {
      obs.assertAll();
    });

    await step('Act: Step 4 — Back on 현물 SKU 마스터 관리, click the 상품코드 DEMO-PC-001 and read the address it opens', async () => {
      const sku = world.sku('SKU0001');
      await list.open('ko');
      await list.search('SKU_GROUP_NAME', world.keyword);
      stockHref = await list.cell(list.row(sku.skuCode), 'col.skuGroupCode').getByRole('link').getAttribute('href');
      await master.open('physical');
      await master.search('SKU_GROUP_CODE_NAME', world.keyword);
      await master.click(master.row(sku.skuCode).getByRole('link', { name: sku.groupCode, exact: true }), `product code ${sku.groupCode}`);
      await page.waitForURL(/\/commerce\/product-stock\/stock\/physical\/edit/);
      routes.push(new URL(page.url()).pathname);
    });

    await step('Assert: Expected 4 — The edit form opens at /commerce/product-stock/stock/physical/edit?skuGroupId=…, the same address as from 재고 관리', async () => {
      const sku = world.sku('SKU0001');
      await expect(page, '[Expected 4] The physical edit route of the group opens').toHaveURL(new RegExp(`/commerce/product-stock/stock/physical/edit\\?skuGroupId=${sku.groupId}(&|$)`));
      const opened = new URL(page.url());
      expect(`${opened.pathname}${opened.search}`, '[Expected 4] The address equals the one the 재고 관리 product code link opens').toBe(stockHref);
    });

    await step('Act: Step 5 — Look for any other way into this screen besides the sidebar', async () => {
      await list.openFromSidebar();
      sidebarGroup = await list.sidebarLink('SKU 마스터 관리').count();
      otherEntries = await page.locator('.main-content').locator('a[href*="/sku-master"]').count();
    });

    await step('Assert: Expected 5 — The sidebar is the only entry point and every route starts with /commerce', async () => {
      expect(sidebarGroup, '[Expected 5] The sidebar offers the SKU 마스터 관리 entry').toBeGreaterThan(0);
      expect(otherEntries, '[Expected 5] No other link into the SKU master screens on 재고 관리').toBe(0);
      for (const route of routes) expect(route.split('/')[1], `[Expected 5] Route ${route} starts with /commerce`).toBe('commerce');
    });
  });
});

test.describe('[Digital SKU Form] digital SKU create / edit form', () => {
  test('TC_US134_163 — Only the product code duplicate check is required before saving a digital SKU', async ({ page, world, skuFormPage: form }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form);
    await tcMeta(
      'TC_US134_163',
      'Medium',
      DIGITAL_TAGS,
      `The digital create form has no 바코드 중복확인 button; with the 4 fields filled (Demo Partner A, a fresh code for role DEMO-PC-915, "Demo Digital Test") 저장 stays disabled until 중복확인 passes, then the save succeeds and the list opens (stock list or digital SKU master list); the edit screen of a digital group (role DEMO-PC-004 = the world SKU0006) keeps 저장 disabled until 상품코드명 changes, with no barcode check. The edit is not saved. ${WORLD_NOTE}`,
    );
    const code = uniqueCode(world.tag, 'D163');
    let check: Awaited<ReturnType<StockSkuSetPage['checkCode']>> | undefined;
    let save: SkuSaveCapture | undefined;
    const editSave = { before: false, after: true };

    await step('Arrange: Pre-condition 1–4 — A fresh product code; a digital group exists for the edit half', async () => {
      expect(world.sku('SKU0006').type, 'The world SKU0006 is a digital SKU').toBe('DIGITAL');
    });

    await step('Act: Step 1 — Open 디지털 SKU 생성 and look all over the form for a 바코드 중복확인 button', async () => {
      await form.openCreate('digital');
    });

    await step('Assert: Expected 1 — No 바코드 중복확인 button is displayed', async () => {
      await expect(page.getByRole('button', { name: /바코드 중복확인/ }), `[Expected 1] No ${ko('skuForm.btn.checkBarcode')} button on the form`).toHaveCount(0);
    });

    await step('Act: Step 2 — Fill the 4 fields with the test data and read the state of 저장', async () => {
      await ui.fillCommon({ partnerId: world.partners.A.id, code, name: ownName(world, 'Demo Digital Test') });
    });

    await step('Assert: Expected 2 — 저장 is disabled', async () => {
      await expect(form.saveButton, `[Expected 2] ${ko('btn.save')} is disabled`).toBeDisabled();
    });

    await step('Act: Step 3 — Click 중복확인 and then 저장', async () => {
      check = await ui.checkCode();
      remember(code);
      save = await ui.saveCapture();
    });

    await step('Assert: Expected 3 — The duplicate check passes, the save succeeds and the list opens', async () => {
      expect(check?.body.ids, '[Expected 3] The product code duplicate check passes').toEqual([]);
      expect(save?.status, '[Expected 3] The save succeeds').toBeLessThan(300);
      await expect(page, '[Expected 3] The list opens').toHaveURL(SKU_LIST_ROUTE, { timeout: 30_000 });
    });

    await step('Act: Step 4 — Open the digital group edit screen, read 저장, change 상품코드명 and read it again', async () => {
      await form.openEdit('digital', world.sku('SKU0006').groupId);
      editSave.before = await form.saveButton.isDisabled();
      await form.skuGroupCodeNameInput.fill(`${world.sku('SKU0006').groupName} edited`);
      editSave.after = await form.saveButton.isDisabled();
    });

    await step('Assert: Expected 4 — 저장 is disabled with no change and enabled after 상품코드명 changes; no barcode check', async () => {
      expect(editSave.before, `[Expected 4] ${ko('btn.save')} is disabled when nothing has changed`).toBe(true);
      expect(editSave.after, `[Expected 4] ${ko('btn.save')} is enabled after 상품코드명 changes`).toBe(false);
      await expect(page.getByRole('button', { name: /바코드 중복확인/ }), '[Expected 4] No barcode duplicate check is required in edit mode').toHaveCount(0);
    });
  });

  test('TC_US134_164 — A new digital SKU has no status field, is stored as SALE and shows on Stock Management as 디지털 with dashes', async ({ page, world, stockApi, skuFormPage: form }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form);
    await tcMeta(
      'TC_US134_164',
      'Critical',
      DIGITAL_TAGS,
      'The digital create form has no 상태 / 판매상태 field; saving Demo Partner A + a fresh code (role DEMO-PC-917) + "Demo Digital New" sends no status field and opens the Stock Management list, the group reads back with status SALE, and the Stock Management row shows the product code, SKU 유형 디지털, a dash in all 10 stock quantity cells and a disabled tick box. Per the frontend bundle a form opened by its address returns to /commerce/product-stock/sku-master/digital after saving, and GET /sku-groups/{id} carries no status field — Expected 4 (list) and 5 are expected to fail.',
    );
    const code = uniqueCode(world.tag, 'D164');
    const name = ownName(world, 'Demo Digital New');
    let check: Awaited<ReturnType<StockSkuSetPage['checkCode']>> | undefined;
    let save: SkuSaveCapture | undefined;
    let stored: Record<string, unknown> = {};
    let created: SkuListRow | undefined;
    let row = page.locator('tbody tr').first();

    await step('Arrange: Pre-condition 1–4 — A fresh product code and the test data; network capture ready', async () => {
      expect((await stockApi.checkSkuGroupCode(code)).body.ids, 'The product code is not in use').toEqual([]);
    });

    await step('Act: Step 1 — Open 디지털 SKU 생성 and check the form for a 상태 or 판매상태 field', async () => {
      await form.openCreate('digital');
    });

    await step('Assert: Expected 1 — No 상태 or 판매상태 field is displayed', async () => {
      for (const label of ['상태', '판매상태']) {
        await expect(form.card.locator('label.form-label', { hasText: new RegExp(`^${label}\\*?$`) }), `[Expected 1] No ${label} field on the form`).toHaveCount(0);
      }
    });

    await step('Act: Step 2 — Enter all test data', async () => {
      await ui.fillCommon({ partnerId: world.partners.A.id, code, name });
    });

    await step('Assert: Expected 2 — The form accepts all entered values', async () => {
      await expect(form.bizPartnerSelect, '[Expected 2] 비즈파트너 holds Demo Partner A').toHaveValue(String(world.partners.A.id));
      await expect(form.skuGroupCodeInput, '[Expected 2] 상품코드 holds the typed code').toHaveValue(code);
      await expect(form.skuGroupCodeNameInput, '[Expected 2] 상품코드명 holds Demo Digital New').toHaveValue(name);
    });

    await step('Act: Step 3 — Complete 상품코드 중복확인', async () => {
      check = await ui.checkCode();
    });

    await step('Assert: Expected 3 — The product code duplicate check passes', async () => {
      expect(check?.status, '[Expected 3] The duplicate check answers 200').toBe(200);
      expect(check?.body.ids, '[Expected 3] The product code is reported free').toEqual([]);
      await expect(form.skuGroupCodeInput, '[Expected 3] The checked product code locks').toHaveJSProperty('readOnly', true);
    });

    await step('Act: Step 4 — Click 저장 and inspect the create request', async () => {
      remember(code);
      save = await ui.saveCapture();
    });

    await step('Assert: Expected 4 — Save succeeds, the request carries no status field and the Stock Management list opens', async () => {
      expect(save?.status, '[Expected 4] Save succeeds').toBeLessThan(300);
      expect(Object.keys(save?.requestBody ?? {}), '[Expected 4] The create request carries no status field').not.toContain('status');
      await expect.soft(page, '[Expected 4] The Stock Management list opens').toHaveURL(STOCK_LIST_ROUTE, { timeout: 30_000 });
    });

    await step('Act: Step 5 — Read the new SKU group back from the SKU read endpoint and check its status', async () => {
      created = (await groupRows(stockApi, code, 'DIGITAL'))[0];
      expect(created, 'The new SKU group is found by its product code').toBeDefined();
      stored = (await stockApi.skuGroup<Record<string, unknown>>(created?.skuGroupId ?? 0)).body ?? {};
    });

    await step('Assert: Expected 5 — The stored status is SALE', async () => {
      expect.soft(stored.status, '[Expected 5] The SKU group read back has status SALE').toBe('SALE');
    });

    await step('Act: Step 6 — On 재고 관리, search by 상품코드 for the new code and check the new row', async () => {
      row = await ui.findStockRow(code, created?.skuId ?? 0);
    });

    await step('Assert: Expected 6 — Product code, SKU 유형 디지털, a dash in every stock quantity cell, disabled checkbox', async () => {
      await expect(row, '[Expected 6] The new digital row is listed').toBeVisible();
      await expect(ui.list.cell(row, 'col.skuGroupCode'), '[Expected 6] The row shows the new product code').toHaveText(code);
      await expect(ui.list.cell(row, 'col.skuType'), `[Expected 6] SKU 유형 is ${ko('skuType.DIGITAL')}`).toHaveText(ko('skuType.DIGITAL'));
      for (const column of QTY_COLUMNS) await expect(ui.list.cell(row, column), `[Expected 6] ${ko(column)} shows a dash`).toHaveText('-');
      await expect(ui.list.checkbox(row), '[Expected 6] The selection checkbox is disabled').toBeDisabled();
    });
  });

  test('TC_US134_165 — Create on the digital SKU master opens the digital route and the SKU type is fixed', async ({ page, world, skuFormPage: form, skuMasterPage: master }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form);
    const stockUi = new StockUiPage(page);
    await tcMeta(
      'TC_US134_165',
      'Medium',
      DIGITAL_TAGS,
      `The digital SKU master list opens from 물류 관리 › SKU 마스터 관리 › 디지털 SKU 마스터 관리, its create action opens /commerce/product-stock/stock/digital/create, SKU 유형 is fixed to 디지털 and disabled in create and edit mode (edit checked on the world digital SKU0006 group), and the breadcrumb ends in the create step of the digital form. Observed on dev 05/10: the SKU 마스터 관리 menu group does not exist, so the menu part of Expected 1 is a soft failure and the list is opened by URL. ${WORLD_NOTE}`,
    );
    let viaMenu = false;
    const type = { createDisabled: false, createText: '', changed: true, editDisabled: false, editText: '' };
    let crumbs: string[] = [];

    await step('Arrange: Pre-condition 1–2 — Logged in with write access; the SKU master group is expected in the sidebar', async () => {
      expect(world.sku('SKU0006').type, 'A digital group exists for the edit-mode check').toBe('DIGITAL');
    });

    await step('Act: Step 1 — Open 물류 관리 › SKU 마스터 관리 › 디지털 SKU 마스터 관리', async () => {
      viaMenu = await stockUi.openMasterFromMenu('digital');
    });

    await step('Assert: Expected 1 — The digital SKU master list opens', async () => {
      expect.soft(viaMenu, '[Expected 1] The list is opened from the 디지털 SKU 마스터 관리 menu item').toBe(true);
      await expect(page, '[Expected 1] The digital SKU master list is open').toHaveURL(/\/commerce\/product-stock\/sku-master\/digital(\?|$)/);
      await expect(master.table, '[Expected 1] The digital SKU master table is shown').toBeVisible();
    });

    await step('Act: Step 2 — Click the create action and read the page address', async () => {
      await stockUi.clickMasterCreate('digital', 'ko');
      await expect(form.cardTitle, 'The digital form loads').toBeVisible({ timeout: 30_000 });
    });

    await step('Assert: Expected 2 — The address is /commerce/product-stock/stock/digital/create', async () => {
      await expect(page, '[Expected 2] The address is /commerce/product-stock/stock/digital/create').toHaveURL(/\/commerce\/product-stock\/stock\/digital\/create(\?|$)/);
    });

    await step('Act: Step 3 — Read SKU 유형 and try to change it (create mode, then edit mode)', async () => {
      type.changed = await form.skuTypeSelect.selectOption({ index: 0 }, { timeout: 3_000 }).then(() => true).catch(() => false);
      type.createDisabled = await form.skuTypeSelect.isDisabled();
      type.createText = (await form.skuTypeSelect.locator('option').first().innerText()).trim();
      await form.openEdit('digital', world.sku('SKU0006').groupId);
      type.editDisabled = await form.skuTypeSelect.isDisabled();
      type.editText = (await form.skuTypeSelect.locator('option').first().innerText()).trim();
      await form.openCreate('digital');
    });

    await step('Assert: Expected 3 — SKU 유형 is fixed to 디지털, cannot be changed and is disabled in create and edit mode', async () => {
      expect(type.createText, `[Expected 3] SKU 유형 shows ${ko('skuType.DIGITAL')} in create mode`).toBe(ko('skuType.DIGITAL'));
      expect(type.createDisabled, '[Expected 3] SKU 유형 is disabled in create mode').toBe(true);
      expect(type.changed, '[Expected 3] SKU 유형 cannot be changed').toBe(false);
      expect(type.editText, `[Expected 3] SKU 유형 shows ${ko('skuType.DIGITAL')} in edit mode`).toBe(ko('skuType.DIGITAL'));
      expect(type.editDisabled, '[Expected 3] SKU 유형 is disabled in edit mode').toBe(true);
    });

    await step('Act: Step 4 — Read the breadcrumb', async () => {
      crumbs = await ui.breadcrumbTexts();
    });

    await step('Assert: Expected 4 — The breadcrumb ends in the create step of this form', async () => {
      expect(crumbs[crumbs.length - 1], '[Expected 4] The breadcrumb ends in the create step').toMatch(/^(생성|Create)$/);
      expect(crumbs[crumbs.length - 2], '[Expected 4] The step before it is the digital form').toMatch(/^(디지털|Digital)/);
    });
  });

  test('TC_US134_166 — The digital form product code duplicate check on the unpressed, duplicate and clean paths', async ({ page, world, skuFormPage: form }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form);
    await tcMeta(
      'TC_US134_166',
      'High',
      DIGITAL_TAGS,
      `On the digital create form (partner and name filled) a fresh code typed without 중복확인 keeps 저장 disabled; the existing code (role DEMO-PC-004 = the world digital SKU0006 group code) answers HTTP 200 with a non-empty ids array, no error code, shows 이미 등록된 상품코드입니다. and leaves the field editable; a fresh code (role DEMO-PC-916) answers an empty ids array, locks the field and enables 저장. Nothing is saved. ${WORLD_NOTE}`,
    );
    const fresh = uniqueCode(world.tag, 'D166');
    const existing = world.sku('SKU0006').groupCode;
    let duplicate: Awaited<ReturnType<StockSkuSetPage['checkCode']>> | undefined;
    let clean: Awaited<ReturnType<StockSkuSetPage['checkCode']>> | undefined;
    let typed = '';

    await step('Arrange: Pre-condition 1–4 — Existing and fresh product codes; the digital create form has 비즈파트너 and 상품코드명 filled', async () => {
      await form.openCreate('digital');
      await ui.fillCommon({ partnerId: world.partners.A.id, name: ownName(world, 'TC166 Digital') });
    });

    await step('Act: Step 1 — Type the fresh code into 상품코드 WITHOUT pressing 중복확인', async () => {
      await form.skuGroupCodeInput.pressSequentially(fresh);
    });

    await step('Assert: Expected 1 — The value is typed', async () => {
      await expect(form.skuGroupCodeInput, '[Expected 1] 상품코드 holds the typed value').toHaveValue(fresh);
    });

    await step('Act: Step 2 — Read the state of 저장', async () => {
      await expect(form.saveButton, 'The save button is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — 저장 is disabled', async () => {
      await expect(form.saveButton, `[Expected 2] ${ko('btn.save')} is disabled while the duplicate check is outstanding`).toBeDisabled();
    });

    await step('Act: Step 3 — Replace the value with the existing code, click 중복확인 and read the response and the message', async () => {
      await form.skuGroupCodeInput.fill(existing);
      duplicate = await ui.checkCode();
    });

    await step('Assert: Expected 3 — HTTP 200, a non-empty ids array, no error code; the screen shows 이미 등록된 상품코드입니다.', async () => {
      expect(duplicate?.status, '[Expected 3] The check answers HTTP 200').toBe(200);
      expect((duplicate?.body.ids ?? []).length, '[Expected 3] The ids array is not empty').toBeGreaterThan(0);
      expect(duplicate?.body.code, '[Expected 3] The response raises no error code').toBeUndefined();
      await expect(form.fieldError('skuForm.field.skuGroupCode'), `[Expected 3] The screen shows ${ko('skuForm.err.codeDuplicated')}`).toHaveText(ko('skuForm.err.codeDuplicated'));
    });

    await step('Act: Step 4 — Try to type into 상품코드', async () => {
      await form.skuGroupCodeInput.press('End');
      await form.skuGroupCodeInput.pressSequentially('X', { timeout: 3_000 }).catch(() => undefined);
      typed = await form.skuGroupCodeInput.inputValue();
    });

    await step('Assert: Expected 4 — The field is still enabled and editable', async () => {
      await expect(form.skuGroupCodeInput, '[Expected 4] 상품코드 is enabled').toBeEnabled();
      await expect(form.skuGroupCodeInput, '[Expected 4] 상품코드 is not read-only').toHaveJSProperty('readOnly', false);
      expect(typed, '[Expected 4] 상품코드 takes the typed character').toBe(`${existing}X`);
    });

    await step('Act: Step 5 — Replace it with the fresh code, click 중복확인 again and read the field state', async () => {
      await form.skuGroupCodeInput.fill(fresh);
      clean = await ui.checkCode();
    });

    await step('Assert: Expected 5 — An empty ids array, the field locks and 저장 becomes enabled', async () => {
      expect(clean?.body.ids, '[Expected 5] The check answers an empty ids array').toEqual([]);
      await expect(form.skuGroupCodeInput, '[Expected 5] 상품코드 locks').toHaveJSProperty('readOnly', true);
      await expect(form.saveButton, `[Expected 5] ${ko('btn.save')} becomes enabled`).toBeEnabled();
    });
  });

  test('TC_US134_167 — All 3 editable digital fields are required before 저장', async ({ page, world, skuFormPage: form }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form);
    await tcMeta(
      'TC_US134_167',
      'Medium',
      DIGITAL_TAGS,
      'On an empty digital create form 저장 is disabled; with only 비즈파트너 it stays disabled and SKU 유형 is disabled and pre-set to 디지털; with a fresh 상품코드 (role DEMO-PC-922) checked it is still disabled because 상품코드명 is empty; with 상품코드명 filled the save succeeds and the list opens (stock list or digital SKU master list). Per the frontend bundle the digital 저장 is disabled only until the duplicate check passes (empty fields are answered by a Save-time message), so Expected 3 is expected to fail.',
    );
    const code = uniqueCode(world.tag, 'D167');
    let save: SkuSaveCapture | undefined;
    const state = { empty: false, partnerOnly: false, coded: false };

    await step('Arrange: Pre-condition 1–3 — The digital create form is open and empty; a fresh product code', async () => {
      await form.openCreate('digital');
    });

    await step('Act: Step 1 — With every field empty, read the state of 저장', async () => {
      state.empty = await form.saveButton.isDisabled();
    });

    await step('Assert: Expected 1 — 저장 is disabled', async () => {
      expect(state.empty, `[Expected 1] ${ko('btn.save')} is disabled with every field empty`).toBe(true);
    });

    await step('Act: Step 2 — Fill 비즈파트너 only, then read the state of 저장 and of SKU 유형', async () => {
      await ui.fillCommon({ partnerId: world.partners.A.id });
      state.partnerOnly = await form.saveButton.isDisabled();
    });

    await step('Assert: Expected 2 — 저장 is still disabled; SKU 유형 is disabled and pre-set to 디지털', async () => {
      expect(state.partnerOnly, `[Expected 2] ${ko('btn.save')} is still disabled`).toBe(true);
      await expect(form.skuTypeSelect, '[Expected 2] SKU 유형 is disabled').toBeDisabled();
      await expect(form.skuTypeSelect.locator('option').first(), `[Expected 2] SKU 유형 is pre-set to ${ko('skuType.DIGITAL')}`).toHaveText(ko('skuType.DIGITAL'));
    });

    await step('Act: Step 3 — Fill 상품코드 as well, pass 중복확인, then read the state of 저장', async () => {
      await ui.fillCommon({ code });
      await ui.checkCode();
      state.coded = await form.saveButton.isDisabled();
    });

    await step('Assert: Expected 3 — 저장 is still disabled because 상품코드명 is empty', async () => {
      await expect(form.skuGroupCodeNameInput, '[Expected 3] 상품코드명 is still empty').toHaveValue('');
      expect.soft(state.coded, `[Expected 3] ${ko('btn.save')} is still disabled while 상품코드명 is empty`).toBe(true);
    });

    await step('Act: Step 4 — Fill 상품코드명 and click 저장', async () => {
      await ui.fillCommon({ name: ownName(world, 'TC167 Digital') });
      remember(code);
      save = await ui.saveCapture();
    });

    await step('Assert: Expected 4 — The save succeeds and the list opens', async () => {
      expect(save?.status, '[Expected 4] The save succeeds').toBeLessThan(300);
      await expect(page, '[Expected 4] The list opens').toHaveURL(SKU_LIST_ROUTE, { timeout: 30_000 });
    });
  });

  test('TC_US134_168 — 상품코드 keeps letters, digits, _ and - only and at most 20 characters, on typing and on paste', async ({ page, skuFormPage: form }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_168',
      'Medium',
      DIGITAL_TAGS,
      'On the digital create form 상품코드 accepts DEMO-PC-001 in full; a space, 데모 and 🎁 typed after it are not accepted; pasting DEMO PC 001 drops the spaces; typing the 21-character DEMO-PC-9999999999999 leaves 20 characters. The paste is simulated with keyboard.insertText (one input event carrying the whole value, as a paste does) — the OS clipboard is not used. Nothing is saved, so the TC values are typed as given.',
    );
    const values = { valid: '', space: '', korean: '', emoji: '', pasted: '', long: '' };

    await step('Arrange: Pre-condition 1–3 — The digital create form is open', async () => {
      await form.openCreate('digital');
    });

    await step('Act: Step 1 — Type DEMO-PC-001 into 상품코드 and read what is accepted', async () => {
      await form.skuGroupCodeInput.pressSequentially('DEMO-PC-001');
      values.valid = await form.skuGroupCodeInput.inputValue();
    });

    await step('Assert: Expected 1 — The value is accepted in full', async () => {
      expect(values.valid, '[Expected 1] DEMO-PC-001 is accepted in full (letters, digits, underscore and hyphen are allowed)').toBe('DEMO-PC-001');
    });

    await step('Act: Step 2 — Type a space, then 데모, then 🎁', async () => {
      await form.skuGroupCodeInput.press('End');
      await form.skuGroupCodeInput.pressSequentially(' ');
      values.space = await form.skuGroupCodeInput.inputValue();
      await form.skuGroupCodeInput.pressSequentially('데모');
      values.korean = await form.skuGroupCodeInput.inputValue();
      await form.skuGroupCodeInput.pressSequentially('🎁');
      values.emoji = await form.skuGroupCodeInput.inputValue();
    });

    await step('Assert: Expected 2 — None of the three is accepted while typing', async () => {
      expect(values.space, '[Expected 2] The space is not accepted').toBe('DEMO-PC-001');
      expect(values.korean, '[Expected 2] 데모 is not accepted').toBe('DEMO-PC-001');
      expect(values.emoji, '[Expected 2] 🎁 is not accepted').toBe('DEMO-PC-001');
    });

    await step('Act: Step 3 — Paste the value with spaces DEMO PC 001', async () => {
      await form.skuGroupCodeInput.fill('');
      await form.skuGroupCodeInput.focus();
      await page.keyboard.insertText('DEMO PC 001');
      values.pasted = await form.skuGroupCodeInput.inputValue();
    });

    await step('Assert: Expected 3 — The spaces are rejected on paste too', async () => {
      expect(values.pasted, '[Expected 3] The pasted value keeps no space').not.toContain(' ');
      expect(values.pasted, '[Expected 3] The allowed characters of the pasted value are kept').toBe('DEMOPC001');
    });

    await step('Act: Step 4 — Type the 21-character value DEMO-PC-9999999999999 and read the field', async () => {
      await form.skuGroupCodeInput.fill('');
      await form.skuGroupCodeInput.pressSequentially('DEMO-PC-9999999999999');
      values.long = await form.skuGroupCodeInput.inputValue();
    });

    await step('Assert: Expected 4 — The field holds 20 characters', async () => {
      expect(values.long.length, '[Expected 4] The field holds 20 characters').toBe(20);
      expect(values.long, '[Expected 4] The field holds the first 20 characters typed').toBe('DEMO-PC-999999999999');
    });
  });

  test('TC_US134_169 — 상품코드명 takes at most 150 characters, refuses an emoji and saves a Korean value', async ({ page, world, skuFormPage: form }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form);
    await tcMeta(
      'TC_US134_169',
      'Medium',
      DIGITAL_TAGS,
      'On the digital create form (partner + a fresh checked code) 상품코드명 accepts 150 × A, refuses a 151st A, refuses the emoji of "Demo Digital 🎁" (field and any save request carry no emoji) and saves the Korean value 데모 디지털 상품 (stock list or digital SKU master list opens). Per the frontend bundle the emoji is stripped while typing, so trying to save "Demo Digital 🎁" may save the name without it; Step 4 then reopens a new create form with another fresh code.',
    );
    const code1 = uniqueCode(world.tag, 'D169A');
    const code2 = uniqueCode(world.tag, 'D169B');
    const values = { full: '', extended: '', emoji: '' };
    const sent: Array<Record<string, unknown>> = [];
    let save: SkuSaveCapture | undefined;

    await step('Arrange: Pre-condition 1–3 — The digital create form is open with 비즈파트너 and a checked fresh 상품코드', async () => {
      await ui.openReadyCreate('digital', { partnerId: world.partners.A.id, code: code1, name: '' });
    });

    await step('Act: Step 1 — Enter the 150-character value in 상품코드명 and read the field', async () => {
      await form.skuGroupCodeNameInput.fill('A'.repeat(150));
      values.full = await form.skuGroupCodeNameInput.inputValue();
    });

    await step('Assert: Expected 1 — All 150 characters are accepted', async () => {
      expect(values.full.length, '[Expected 1] All 150 characters are accepted').toBe(150);
    });

    await step('Act: Step 2 — Try to extend it to 151 characters by typing one more A', async () => {
      await form.skuGroupCodeNameInput.press('End');
      await form.skuGroupCodeNameInput.pressSequentially('A');
      values.extended = await form.skuGroupCodeNameInput.inputValue();
    });

    await step('Assert: Expected 2 — The 151st character is not accepted', async () => {
      expect(values.extended.length, '[Expected 2] The field still holds 150 characters').toBe(150);
    });

    await step('Act: Step 3 — Enter the emoji value Demo Digital 🎁 and try to save', async () => {
      await form.skuGroupCodeNameInput.fill('');
      await form.skuGroupCodeNameInput.pressSequentially('Demo Digital 🎁');
      values.emoji = await form.skuGroupCodeNameInput.inputValue();
      const onRequest = (request: Request) => {
        if (new URL(request.url()).pathname === '/api/v1/skus' && request.method() === 'POST') sent.push((request.postDataJSON() ?? {}) as Record<string, unknown>);
      };
      page.on('request', onRequest);
      remember(code1);
      await form.click(form.saveButton, `${ko('btn.save')} button`);
      await ui.waitForAnswer();
      page.off('request', onRequest);
    });

    await step('Assert: Expected 3 — The emoji is refused', async () => {
      expect(values.emoji, '[Expected 3] The field does not keep the emoji').not.toContain('🎁');
      for (const body of sent) expect(JSON.stringify(body.group ?? {}), '[Expected 3] No save request carries the emoji').not.toContain('🎁');
    });

    await step('Act: Step 4 — Enter the Korean value 데모 디지털 상품 and save', async () => {
      if (!/\/stock\/digital\/create/.test(page.url())) {
        await ui.openReadyCreate('digital', { partnerId: world.partners.A.id, code: code2, name: '' });
        remember(code2);
      }
      await form.skuGroupCodeNameInput.fill('데모 디지털 상품');
      save = await ui.saveCapture();
    });

    await step('Assert: Expected 4 — The save succeeds', async () => {
      expect(save?.status, '[Expected 4] The save with 데모 디지털 상품 succeeds').toBeLessThan(300);
      expect((save?.requestBody.group as { name?: string } | undefined)?.name, '[Expected 4] The saved name is 데모 디지털 상품').toBe('데모 디지털 상품');
      await expect(page, '[Expected 4] The list opens').toHaveURL(SKU_LIST_ROUTE, { timeout: 30_000 });
    });
  });

  test('TC_US134_170 — Clicking the product code of a digital row opens the digital edit route', async ({ page, world, skuFormPage: form }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form);
    const digital = world.sku('SKU0006');
    await tcMeta(
      'TC_US134_170',
      'Medium',
      DIGITAL_TAGS,
      `On 재고 관리 the digital row (role DEMO-PC-004 = the world digital SKU0006) shows SKU 유형 디지털; its 상품코드 is a link that opens /commerce/product-stock/stock/digital/edit?skuGroupId=<id> with the breadcrumb … › Stock management › Edit and the digital form holding the group's current partner, code and name. Per the recon of 05/10 the breadcrumb is route-based (… › Stock › Digital › Edit), so the breadcrumb part of Expected 3 is expected to fail. ${WORLD_NOTE}`,
    );
    let row = page.locator('tbody tr').first();
    let linkCount = 0;
    let crumbs: string[] = [];

    await step('Arrange: Pre-condition 1–3 — The digital group exists, is visible on 재고 관리 and its skuGroupId is known', async () => {
      expect(digital.type, 'The world SKU0006 is a digital SKU').toBe('DIGITAL');
    });

    await step('Act: Step 1 — Open 재고 관리 and find the digital row', async () => {
      row = await ui.findStockRow(digital.groupCode, digital.skuId);
    });

    await step('Assert: Expected 1 — The row is listed with SKU 유형 디지털', async () => {
      await expect(row, '[Expected 1] The digital row is listed').toBeVisible();
      await expect(ui.list.cell(row, 'col.skuType'), `[Expected 1] SKU 유형 is ${ko('skuType.DIGITAL')}`).toHaveText(ko('skuType.DIGITAL'));
    });

    await step('Act: Step 2 — Click its 상품코드 link', async () => {
      const link = ui.list.cell(row, 'col.skuGroupCode').getByRole('link', { name: digital.groupCode, exact: true });
      linkCount = await link.count();
      await form.click(link, `product code ${digital.groupCode}`);
      await expect(form.cardTitle, 'The SKU form loads').toBeVisible({ timeout: 30_000 });
    });

    await step('Assert: Expected 2 — The form opens; the product code is a link, not plain text', async () => {
      expect(linkCount, '[Expected 2] The product code is a link').toBe(1);
      await expect(form.card, '[Expected 2] The form opens').toBeVisible();
    });

    await step('Act: Step 3 — Read the page address and the breadcrumb', async () => {
      await expect(form.skuGroupCodeInput, 'The saved values are loaded').not.toHaveValue('', { timeout: 30_000 });
      crumbs = await ui.breadcrumbTexts();
    });

    await step('Assert: Expected 3 — /commerce/product-stock/stock/digital/edit?skuGroupId=…; breadcrumb … › Stock management › Edit; the Digital form', async () => {
      await expect(page, '[Expected 3] The address is the digital edit route of this group').toHaveURL(new RegExp(`/commerce/product-stock/stock/digital/edit\\?skuGroupId=${digital.groupId}(&|$)`));
      expect.soft(crumbs.slice(-2), '[Expected 3] The breadcrumb ends … › 재고 관리 (Stock management) › 수정 (Edit)').toEqual(['재고 관리', ko('skuForm.mode.edit')]);
      await expect(form.cardTitle, `[Expected 3] The form is the ${ko('skuForm.title.digital')} form, not the physical one`).toHaveText(ko('skuForm.title.digital'));
    });

    await step('Act: Step 4 — Read the values the form loaded', async () => {
      await expect(form.skuGroupCodeNameInput, 'The name is loaded').toBeVisible();
    });

    await step('Assert: Expected 4 — The form shows the group current values', async () => {
      await expect(form.bizPartnerSelect, '[Expected 4] 비즈파트너 shows the group partner').toHaveValue(String(digital.partner.id));
      await expect(form.skuGroupCodeInput, '[Expected 4] 상품코드 shows the group code').toHaveValue(digital.groupCode);
      await expect(form.skuGroupCodeNameInput, '[Expected 4] 상품코드명 shows the group name').toHaveValue(digital.groupName);
    });
  });

  test('TC_US134_171 — In edit mode the digital form locks 비즈파트너, 상품코드 and SKU 유형 and keeps 상품코드명 editable', async ({ page, world, skuFormPage: form }) => {
    const step = makeStep(page);
    const digital = world.sku('SKU0006');
    await tcMeta(
      'TC_US134_171',
      'Medium',
      DIGITAL_TAGS,
      `The edit form of the digital group (role DEMO-PC-004 = the world digital SKU0006) shows 4 fields; 비즈파트너 is locked with 생성 후 수정 불가능합니다 on its row, 상품코드 is read-only, SKU 유형 is disabled (as in create mode) and 상품코드명 is editable. Nothing is saved. ${WORLD_NOTE}`,
    );
    const note = { visible: false, sameRow: false, partnerChanged: true };
    let codeTyped = '';
    let typeChanged = true;
    let nameValue = '';
    const newName = `${digital.groupName} edited`;

    await step('Arrange: Pre-condition 1–2 — The digital group exists', async () => {
      expect(digital.type, 'The world SKU0006 is a digital SKU').toBe('DIGITAL');
    });

    await step('Act: Step 1 — Open the digital group in edit mode', async () => {
      await form.openEdit('digital', digital.groupId);
    });

    await step('Assert: Expected 1 — The edit form opens with 4 fields', async () => {
      await expect(form.modeBadge, `[Expected 1] The form is in ${ko('skuForm.mode.edit')} mode`).toHaveText(ko('skuForm.mode.edit'));
      await expect(form.card.locator('label.form-label'), '[Expected 1] The form has exactly 4 fields').toHaveCount(4);
      for (const key of ['skuForm.field.skuType', 'skuForm.field.bizPartner', 'skuForm.field.skuGroupCode', 'skuForm.field.skuGroupCodeName'] as const) {
        await expect(form.label(key), `[Expected 1] Field ${ko(key)} is shown`).toBeVisible();
      }
    });

    await step('Act: Step 2 — Try to change 비즈파트너 and read the note on its row', async () => {
      note.partnerChanged = await form.bizPartnerSelect.selectOption({ index: 0 }, { timeout: 3_000 }).then(() => true).catch(() => false);
      note.visible = await form.bizPartnerLockNote.isVisible();
      const fieldBox = await form.field('skuForm.field.bizPartner').boundingBox();
      const noteBox = await form.bizPartnerLockNote.boundingBox();
      note.sameRow = !!fieldBox && !!noteBox && noteBox.y >= fieldBox.y && noteBox.y + noteBox.height <= fieldBox.y + fieldBox.height + 1;
    });

    await step('Assert: Expected 2 — 비즈파트너 is locked and 생성 후 수정 불가능합니다 is shown on the same row', async () => {
      await expect(form.bizPartnerSelect, '[Expected 2] 비즈파트너 is locked').toBeDisabled();
      expect(note.partnerChanged, '[Expected 2] 비즈파트너 cannot be changed').toBe(false);
      expect(note.visible, `[Expected 2] ${ko('skuForm.lockNotice')} is shown`).toBe(true);
      expect(note.sameRow, `[Expected 2] ${ko('skuForm.lockNotice')} sits on the 비즈파트너 row`).toBe(true);
    });

    await step('Act: Step 3 — Try to change 상품코드', async () => {
      await form.skuGroupCodeInput.press('End').catch(() => undefined);
      await form.skuGroupCodeInput.pressSequentially('X', { timeout: 3_000 }).catch(() => undefined);
      codeTyped = await form.skuGroupCodeInput.inputValue();
    });

    await step('Assert: Expected 3 — 상품코드 is read-only', async () => {
      await expect(form.skuGroupCodeInput, '[Expected 3] 상품코드 is read-only').toHaveJSProperty('readOnly', true);
      expect(codeTyped, '[Expected 3] 상품코드 takes no change').toBe(digital.groupCode);
    });

    await step('Act: Step 4 — Try to change SKU 유형', async () => {
      typeChanged = await form.skuTypeSelect.selectOption({ index: 0 }, { timeout: 3_000 }).then(() => true).catch(() => false);
    });

    await step('Assert: Expected 4 — SKU 유형 is disabled, as in create mode', async () => {
      await expect(form.skuTypeSelect, '[Expected 4] SKU 유형 is disabled').toBeDisabled();
      expect(typeChanged, '[Expected 4] SKU 유형 cannot be changed').toBe(false);
    });

    await step('Act: Step 5 — Try to change 상품코드명', async () => {
      await form.skuGroupCodeNameInput.fill(newName);
      nameValue = await form.skuGroupCodeNameInput.inputValue();
    });

    await step('Assert: Expected 5 — 상품코드명 is editable', async () => {
      await expect(form.skuGroupCodeNameInput, '[Expected 5] 상품코드명 is editable').toBeEditable();
      expect(nameValue, '[Expected 5] 상품코드명 takes the new value').toBe(newName);
    });
  });

  test('TC_US134_172 — A digital SKU carries no warehouse and its row cannot be picked for the stock actions', async ({ page, world, stockApi, skuFormPage: form }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form);
    await tcMeta(
      'TC_US134_172',
      'Medium',
      DIGITAL_TAGS,
      'The digital create form has no 창고, 중량, 부피, HS 코드, 제조사 or 원산지 field; a digital SKU saved through the form appears on 재고 관리 with no warehouse in 창고 (shown as -); its tick box is shown but disabled, so 입고 요청, 재고 조정, 재고 전환 and 창고별 상세 each answer the no-selection guard instead of opening a dialog.',
    );
    const code = uniqueCode(world.tag, 'D172');
    const absent = ['창고', ko('skuForm.field.weight'), ko('skuForm.field.volume'), ko('skuForm.field.hsCode'), ko('skuForm.field.manufacturer'), ko('skuForm.field.countryOfOrigin')];
    const actions = ['btn.incomingRequest', 'btn.adjustStock', 'btn.convertStock', 'btn.warehouseDetail'] as const;
    let save: SkuSaveCapture | undefined;
    let created: SkuListRow | undefined;
    let row = page.locator('tbody tr').first();
    let ticked = true;
    const guarded: Record<string, { guard: boolean; dialog: number }> = {};

    await step('Arrange: Pre-condition 1–2 — Logged in with write access; digital SKUs appear on 재고 관리', async () => {
      expect(world.sku('SKU0006').type, 'The world holds a digital SKU').toBe('DIGITAL');
    });

    await step('Act: Step 1 — Open the digital create form and look for a 창고 field', async () => {
      await form.openCreate('digital');
    });

    await step('Assert: Expected 1 — No 창고 field, and none of 중량, 부피, HS 코드, 제조사, 원산지', async () => {
      for (const label of absent) {
        await expect(form.card.locator('label.form-label', { hasText: new RegExp(`^${label}\\*?$`) }), `[Expected 1] No ${label} field on the digital form`).toHaveCount(0);
      }
    });

    await step('Act: Step 2 — Save a digital SKU and find its row on 재고 관리', async () => {
      await ui.fillCommon({ partnerId: world.partners.A.id, code, name: ownName(world, 'TC172 Digital') });
      await ui.checkCode();
      remember(code);
      save = await ui.saveCapture();
      created = (await groupRows(stockApi, code, 'DIGITAL'))[0];
      expect(created, 'The new digital SKU is found by its product code').toBeDefined();
      row = await ui.findStockRow(code, created?.skuId ?? 0);
    });

    await step('Assert: Expected 2 — The SKU is created and appears on the list', async () => {
      expect(save?.status, '[Expected 2] The digital SKU is created').toBeLessThan(300);
      await expect(row, '[Expected 2] The new digital SKU appears on 재고 관리').toBeVisible();
    });

    await step('Act: Step 3 — Read the 창고 column on that row', async () => {
      await expect(ui.list.cell(row, 'col.warehouse'), 'The 창고 cell is shown').toBeVisible();
    });

    await step('Assert: Expected 3 — The 창고 column carries no warehouse for this row', async () => {
      await expect(ui.list.cell(row, 'col.warehouse'), '[Expected 3] 창고 carries no warehouse (blank or -)').toHaveText(/^-?$/);
    });

    await step('Act: Step 4 — Try to tick the selection checkbox of the digital row, then try each stock action', async () => {
      await ui.list.checkbox(row).click({ force: true, timeout: 5_000 }).catch(() => undefined);
      ticked = await ui.list.checkbox(row).isChecked();
      for (const key of actions) {
        await ui.list.clickToolbar(key);
        const guard = await ui.list.guardAlert.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false);
        guarded[key] = { guard, dialog: await page.locator('.modal.show').count() };
        if (guarded[key].dialog > 0) await page.keyboard.press('Escape');
      }
    });

    await step('Assert: Expected 4 — The checkbox is shown but disabled, so the row cannot be picked for 입고 요청, 재고 조정, 재고 전환 or 창고별 상세', async () => {
      await expect(ui.list.checkbox(row), '[Expected 4] The checkbox is shown').toBeVisible();
      await expect(ui.list.checkbox(row), '[Expected 4] The checkbox is disabled').toBeDisabled();
      expect(ticked, '[Expected 4] The digital row cannot be ticked').toBe(false);
      for (const key of actions) {
        expect(guarded[key].guard && guarded[key].dialog === 0, `[Expected 4] ${ko(key)} cannot take the digital row (no-selection guard, no dialog)`).toBe(true);
      }
    });
  });

  test('TC_US134_173 — A digital SKU has no stock record: dashes, unlike the zeros of an existing empty stock record', async ({ page, world, skuFormPage: form }) => {
    const step = makeStep(page);
    const ui = new StockSkuSetPage(page, form);
    await tcMeta(
      'TC_US134_173',
      'Medium',
      DIGITAL_TAGS,
      `On 재고 관리 the digital row (role DEMO-PC-004 = the world digital SKU0006) shows a dash in all 10 stock quantity cells, a physical row whose stock record exists at 0 (a physical SKU created by the test with a stock record seeded at 0 in CJ Incheon Aam, CS-managed) shows 0 in those cells, the two differ cell by cell, and the 재고이력 cell of the digital row is empty. Per the frontend bundle a row without a warehouse shows "-" in 재고이력 (no button), so the "empty" part of Expected 4 may fail; the absence of the history button is also checked. Environment (run of 05/10): the order-derived 할당대기재고 cell of the freshly created physical row shows 5 although every stock bucket is 0 — the figure comes from the interim commerce-order mock (KakaoEnt BRZ-14801 not deployed), not from the stock record, so that cell of Expected 2 fails until the mock is removed. ${WORLD_NOTE}`,
    );
    const digital = world.sku('SKU0006');
    let physical: WorldSku | undefined;
    let digitalCells: string[] = [];
    let physicalCells: string[] = [];
    let differs: boolean[] = [];
    let history = { text: '', buttons: -1 };
    const readCells = async (groupCode: string, skuId: number) => {
      const row = await ui.findStockRow(groupCode, skuId);
      await expect(row, `The row of ${groupCode} is listed`).toBeVisible();
      const cells: string[] = [];
      for (const column of QTY_COLUMNS) cells.push(await ui.list.cellText(row, column));
      return cells;
    };

    await step('Arrange: Pre-condition 1–3 — A digital SKU is on 재고 관리; a physical SKU has a stock record at 0', async () => {
      [physical] = await world.createPhysicalSku('P173', { partner: world.partners.A, manufacturer: world.manufacturers.M1, groupName: ownName(world, 'TC173 Zero stock') });
      await world.seedStock(physical, world.warehouses.CJ, { available: 0, csManaged: true });
    });

    await step('Act: Step 1 — Find the digital row and read all 10 numeric stock cells', async () => {
      digitalCells = await readCells(digital.groupCode, digital.skuId);
    });

    await step('Assert: Expected 1 — All 10 cells display a dash', async () => {
      QTY_COLUMNS.forEach((column, index) => expect(digitalCells[index], `[Expected 1] ${ko(column)} of the digital row is a dash`).toBe('-'));
    });

    await step('Act: Step 2 — Read the same 10 cells on the physical row whose stock record exists but is 0', async () => {
      physicalCells = await readCells((physical as WorldSku).groupCode, (physical as WorldSku).skuId);
    });

    await step('Assert: Expected 2 — The physical row displays 0 in those cells, not a dash', async () => {
      QTY_COLUMNS.forEach((column, index) => expect.soft(physicalCells[index], `[Expected 2] ${ko(column)} of the physical row is 0`).toBe('0'));
    });

    await step('Act: Step 3 — Compare the two rows', async () => {
      differs = QTY_COLUMNS.map((_, index) => digitalCells[index] !== physicalCells[index]);
    });

    await step('Assert: Expected 3 — The two differ: a dash means no stock record, 0 means a record with a zero value', async () => {
      QTY_COLUMNS.forEach((column, index) => {
        expect(differs[index], `[Expected 3] ${ko(column)} differs between the digital (${digitalCells[index]}) and the physical (${physicalCells[index]}) row`).toBe(true);
      });
    });

    await step('Act: Step 4 — Read the 재고이력 cell on the digital row', async () => {
      const row = await ui.findStockRow(digital.groupCode, digital.skuId);
      const cell = ui.list.cell(row, 'col.stockHistory');
      history = { text: (await cell.innerText()).trim(), buttons: await cell.getByRole('button').count() };
    });

    await step('Assert: Expected 4 — The 재고이력 cell is empty: there is no stock row to show history for', async () => {
      expect(history.buttons, `[Expected 4] The digital row has no ${ko('btn.stockHistory')} button`).toBe(0);
      expect(history.text, '[Expected 4] The 재고이력 cell is empty').toBe('');
    });
  });
});
