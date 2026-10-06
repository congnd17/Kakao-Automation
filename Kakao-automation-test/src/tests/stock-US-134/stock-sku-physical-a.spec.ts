import { test, expect } from '@fixtures/stock.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { StockTextKey, stx } from '@utils/stock.i18n';
import { WORLD_NOTE, stockTags } from '@utils/stock-spec';
import { StockWorld, WorldSku, uniqueCode, uniqueHsCode } from '@utils/stock.data';
import type { SkuGroupDetail, SkuUsageType } from '@api/stock.api';
import { PhysicalCommonValues, PhysicalSkuFormPage } from '@pages/stock-sku-physical.page';

/**
 * US134 — nhóm [Physical SKU Form] phần A (TC_US134_93 … 117): khoá trường ở màn sửa, server chặn đổi loại, route sửa + trail,
 * dòng SKU đã lưu không xoá được, 중복확인 상품코드 / 바코드, quy tắc 바코드 중복확인, 다른 바코드 사용, điều kiện chặn 저장,
 * 옵션 설정, nút 추가, ghép SKU명, quy tắc ký tự / độ dài của mã + tên, HS 코드 10 số.
 * Hành vi form đối chiếu bundle (`Nue` / `t8` / `C8t` / `y8t`): mã chỉ nhận [A-Za-z0-9_-] tối đa 20, tên bỏ emoji tối đa 150,
 * HS chỉ nhận số tối đa 10; 저장 tắt khi (tạo) chưa qua 2 bước 중복확인 / (sửa) chưa đổi gì hoặc chưa qua 바코드 중복확인.
 * TC ghi tay mã DEMO-PC-9xx / DEMO-SKU-9xx / DEMO-BC-9xx → mã duy nhất `uniqueCode(world.tag, …)`; SKU tạo qua form được
 * đăng ký dọn bằng `world.trackGroupCode` (gọi SAU khi lưu — tra id theo 상품코드). TC sửa có lưu dùng nhóm SKU riêng.
 */
const TAGS = stockTags('sku-physical');
const t = (key: StockTextKey) => stx(key, 'ko');
const EXPORT_NAME = 'CS_ 2026 SPRING';
const LIST_AFTER_CREATE = /\/commerce\/product-stock\/sku-master\/physical(\?|$)/;
const LIST_AFTER_EDIT = /\/commerce\/product-stock\/stock(\?|$)/;
const CODE_NOTE =
  'The TC literal codes (DEMO-PC-9xx / DEMO-SKU-9xx / DEMO-BC-9xx) are replaced by unique run codes built from the run tag (T134…) so repeated runs never collide; SKUs saved through the form are removed at teardown.';
const LOCK_NOTE =
  'Observed in the build: locked code inputs carry readonly (grey bg-light), not the disabled attribute — "disabled / does not accept input" is asserted as "not editable".';

/** Bộ mã duy nhất của 1 TC (≤ 20 ký tự). */
function codes(world: StockWorld, label: string): { groupCode: string; skuCode: string; barcode: string } {
  return { groupCode: uniqueCode(world.tag, `${label}P`), skuCode: uniqueCode(world.tag, `${label}S`), barcode: uniqueCode(world.tag, `${label}B`) };
}

/** Dữ liệu chung hợp lệ của TC (Demo Partner A, 본품, 12000, 250 g, 100 / 80 / 30, CD, Demo Manufacturer 1, 대한민국). */
function commonValues(world: StockWorld, groupCode: string, groupName = 'Demo Test Product', hsCode: string | undefined = uniqueHsCode()): PhysicalCommonValues {
  return { partner: world.partners.A, manufacturer: world.manufacturers.M1, groupCode, groupName, usageType: 'MAIN', price: '12000', weight: '250', volume: ['100', '80', '30'], hsCode, description: 'CD' };
}

/** Body PATCH /skus/{id} như form sửa gửi (`zqt(jue(...))`), với SKU 유형 / SKU 종류 tuỳ chọn. */
function editBody(detail: SkuGroupDetail, type: string, usageType: SkuUsageType): Record<string, unknown> {
  return {
    type,
    groupName: detail.groupName,
    usageType,
    price: detail.price,
    skus: detail.skus.map((line) => ({ skuId: line.skuId, name: '', skuCode: line.skuCode, exportSkuName: line.exportSkuName ?? '', barcode: line.barcode ?? '' })),
    weight: detail.weight,
    width: detail.width,
    length: detail.length,
    height: detail.height,
    hsCode: detail.hsCode,
    description: detail.description,
    manufacturerId: detail.manufacturerId,
    countryOfOrigin: detail.countryOfOrigin,
  };
}

/** Text lỗi của body Problem Details (message / detail / title). */
function errorText(body: unknown): string {
  const error = (body ?? {}) as { message?: string; detail?: string; title?: string };
  return [error.message, error.detail, error.title].filter(Boolean).join(' | ');
}

function errorCode(body: unknown): string | undefined {
  return ((body ?? {}) as { code?: string }).code;
}

test.describe('[Physical SKU Form] Physical SKU form — locks, duplicate checks and input rules (A)', () => {
  test.describe.configure({ timeout: 180_000 });

  test('TC_US134_93 — Partner, product code, SKU kind and option setting are locked when the form opens in edit mode', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormPage(page);
    const sku = world.sku('SKU0001');
    await tcMeta(
      'TC_US134_93',
      'Critical',
      TAGS,
      `Opened from the 상품코드 link of the DEMO-SKU-0001 row, the physical edit screen (title 현물 SKU, trail 재고 관리 › 수정) refuses a change of 비즈파트너, typing into 상품코드, and a change of SKU 종류 or 옵션 설정. The trail is the host breadcrumb above the card; on dev 05/10 the create screen shows the route-based trail Commerce › Product-stock › Stock › Physical › Create (English, from the URL), so 재고 관리 / 수정 are asserted as the TC states. ${LOCK_NOTE} Nothing is saved. ${WORLD_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–2 — Logged in with write access; DEMO-PC-001 belongs to Demo Partner A, SKU 종류 본품, 옵션 설정 옵션있음', async () => {
      expect(sku.partner.id, 'DEMO-PC-001 belongs to Demo Partner A').toBe(world.partners.A.id);
      expect(sku.usageType, 'DEMO-PC-001 has SKU kind 본품 (MAIN)').toBe('MAIN');
      await list.open();
    });

    await step('Act: Step 1 — Open 재고 관리 and click the 상품코드 (Product code) link on the DEMO-SKU-0001 row', async () => {
      await form.openEditFromList(list, sku.skuCode, sku.groupCode);
    });

    await step('Assert: Expected 1 — The edit screen opens with the title 현물 SKU and the trail 재고 관리 › 수정', async () => {
      await expect(page, '[Expected 1] The physical edit screen is open').toHaveURL(/\/commerce\/product-stock\/stock\/physical\/edit\?skuGroupId=/);
      await expect(form.cardTitle, `[Expected 1] The page title is ${t('skuForm.title.physical')}`).toHaveText(t('skuForm.title.physical'));
      await expect(form.breadcrumbItems.filter({ hasText: /^재고 관리$/ }), '[Expected 1] The trail holds 재고 관리 (Stock management)').toHaveCount(1);
      await expect(form.breadcrumbActive, '[Expected 1] The trail ends with 수정 (Edit)').toHaveText('수정');
    });

    await step('Act: Step 2 — Try to change 비즈파트너 (Biz partner) to Demo Partner B', async () => {
      await form.tryChangeSelect(form.bizPartnerSelect, `${t('skuForm.field.bizPartner')} to ${world.partners.B.nameKo}`);
    });

    await step('Assert: Expected 2 — The field does not take the change and still shows Demo Partner A', async () => {
      await expect(form.bizPartnerSelect, '[Expected 2] 비즈파트너 is switched off').toBeDisabled();
      await expect(form.bizPartnerSelect, `[Expected 2] 비즈파트너 still holds Demo Partner A (${world.partners.A.nameKo})`).toHaveValue(String(world.partners.A.id));
    });

    await step('Act: Step 3 — Try to type into 상품코드 (Product code)', async () => {
      await form.tryType(form.skuGroupCodeInput, 'X', t('skuForm.field.skuGroupCode'));
    });

    await step('Assert: Expected 3 — The field is read-only and takes no characters', async () => {
      await expect(form.skuGroupCodeInput, '[Expected 3] 상품코드 is read-only').not.toBeEditable();
      await expect(form.skuGroupCodeInput, `[Expected 3] 상품코드 still reads ${sku.groupCode}`).toHaveValue(sku.groupCode);
    });

    await step('Act: Step 4 — Try to change SKU 종류 (SKU kind) to 구성품 (Component)', async () => {
      await form.tryClick(form.usageRadio('PARTS'), 'the 구성품 (Component) radio button');
    });

    await step('Assert: Expected 4 — The radio button does not take the change and stays on 본품 (Main item)', async () => {
      await expect(form.usageRadio('PARTS'), '[Expected 4] 구성품 is switched off').toBeDisabled();
      await expect(form.usageRadio('PARTS'), '[Expected 4] 구성품 is not selected').not.toBeChecked();
      await expect(form.usageRadio('MAIN'), '[Expected 4] SKU 종류 stays on 본품').toBeChecked();
    });

    await step('Act: Step 5 — Try to change 옵션 설정 (Option setting) to 옵션없음 (No options)', async () => {
      await form.tryClick(form.optionNone, 'the 옵션없음 (No options) radio button');
    });

    await step('Assert: Expected 5 — The radio button does not take the change and stays on 옵션있음 (Has options)', async () => {
      await expect(form.optionNone, '[Expected 5] 옵션없음 is switched off').toBeDisabled();
      await expect(form.optionNone, '[Expected 5] 옵션없음 is not selected').not.toBeChecked();
      await expect(form.optionHas, '[Expected 5] 옵션 설정 stays on 옵션있음').toBeChecked();
    });
  });

  test('TC_US134_94 — The server rejects a save that changes SKU type or SKU kind', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormPage(page);
    let group: WorldSku[] = [];
    let detail!: SkuGroupDetail;
    let typeChange: { status: number; body: unknown } = { status: 0, body: null };
    let kindChange: { status: number; body: unknown } = { status: 0, body: null };
    let after!: SkuGroupDetail;
    await tcMeta(
      'TC_US134_94',
      'Medium',
      TAGS,
      `PATCH /skus/{skuGroupId} sent straight to the server (no UI path — the form locks both fields) with SKU type DIGITAL, then with PHYSICAL + SKU kind PARTS, is rejected with WH-SKU_IMMUTABLE_FIELD and the stored type / kind stay 현물 / 본품. The calls use a physical SKU group the test creates itself (stands in for DEMO-PC-001) so an accepted call could never alter the shared demo data. The SKU-kind sentence is not quoted word for word in the SRS (NEEDS CLARIFICATION) — Expected 2 checks the code plus a sentence naming SKU 종류 and the group id. ${CODE_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–3 — A PHYSICAL SKU group with SKU kind MAIN exists; calls go straight to the server with the automation session', async () => {
      group = await world.createPhysicalSku('P94', { partner: world.partners.A, manufacturer: world.manufacturers.M1, groupName: 'Demo Album [Vol.1]', usageType: 'MAIN' });
      detail = (await stockApi.skuGroup(group[0].groupId)).body;
      expect(detail.type, 'The SKU group is PHYSICAL').toBe('PHYSICAL');
      expect(detail.usageType, 'The SKU group has SKU kind MAIN').toBe('MAIN');
    });

    await step('Act: Step 1 — Send the SKU group update call with SKU type DIGITAL', async () => {
      typeChange = await stockApi.updateSku(group[0].groupId, editBody(detail, 'DIGITAL', 'MAIN'));
    });

    await step('Assert: Expected 1 — Rejected with WH-SKU_IMMUTABLE_FIELD: SKU 유형은 생성 후 수정할 수 없습니다. - skuGroupId: {id}, 저장된 유형: PHYSICAL, 요청한 유형: DIGITAL', async () => {
      expect(typeChange.status, '[Expected 1] The call is rejected (4xx)').toBeGreaterThanOrEqual(400);
      expect(errorCode(typeChange.body), '[Expected 1] The error code is WH-SKU_IMMUTABLE_FIELD').toBe('WH-SKU_IMMUTABLE_FIELD');
      expect(errorText(typeChange.body), '[Expected 1] The message names the real group id, the stored type PHYSICAL and the requested type DIGITAL').toContain(
        `SKU 유형은 생성 후 수정할 수 없습니다. - skuGroupId: ${group[0].groupId}, 저장된 유형: PHYSICAL, 요청한 유형: DIGITAL`,
      );
    });

    await step('Act: Step 2 — Send the same call with SKU type PHYSICAL and SKU kind PARTS', async () => {
      kindChange = await stockApi.updateSku(group[0].groupId, editBody(detail, 'PHYSICAL', 'PARTS'));
    });

    await step('Assert: Expected 2 — Rejected with WH-SKU_IMMUTABLE_FIELD, the same sentence naming SKU 종류 (SKU kind)', async () => {
      expect(kindChange.status, '[Expected 2] The call is rejected (4xx)').toBeGreaterThanOrEqual(400);
      expect(errorCode(kindChange.body), '[Expected 2] The error code is WH-SKU_IMMUTABLE_FIELD').toBe('WH-SKU_IMMUTABLE_FIELD');
      expect(errorText(kindChange.body), '[Expected 2] The message names SKU 종류 (SKU kind)').toContain('SKU 종류');
      expect(errorText(kindChange.body), '[Expected 2] The message carries the real group id').toContain(`skuGroupId: ${group[0].groupId}`);
    });

    await step('Act: Step 3 — Open the edit screen of the SKU group', async () => {
      await form.openEdit('physical', group[0].groupId);
      after = (await stockApi.skuGroup(group[0].groupId)).body;
    });

    await step('Assert: Expected 3 — SKU 유형 still shows 현물 (Physical) and SKU 종류 still shows 본품 (Main item)', async () => {
      await expect(form.skuTypeSelect.locator('option:checked'), '[Expected 3] SKU 유형 shows 현물').toHaveText('현물');
      await expect(form.usageRadio('MAIN'), '[Expected 3] SKU 종류 shows 본품').toBeChecked();
      expect(after.type, '[Expected 3] The stored SKU type is still PHYSICAL').toBe('PHYSICAL');
      expect(after.usageType, '[Expected 3] The stored SKU kind is still MAIN').toBe('MAIN');
    });
  });

  test('TC_US134_95 — The product code link opens the edit address with the SKU group id, and the trail is shown', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormPage(page);
    const sku = world.sku('SKU0001');
    let address = '';
    let otherCode = '';
    let otherAddress = '';
    await tcMeta(
      'TC_US134_95',
      'Medium',
      TAGS,
      `Clicking the 상품코드 link of DEMO-SKU-0001 leaves the list for /commerce/product-stock/stock/physical/edit?skuGroupId=<15-digit group id> (not the product code); the trail reads 재고 관리 › 수정, 상품코드 shows the code read-only, and the same address opened in a new tab loads the same SKU group. On dev 05/10 the host trail is route-based (Commerce › Product-stock › Stock › Physical › …), asserted as the TC states. ${WORLD_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–2 — Logged in with write access; DEMO-SKU-0001 belongs to the SKU group DEMO-PC-001', async () => {
      expect(sku.groupCode, 'DEMO-SKU-0001 has a product code').not.toBe('');
      await list.open();
    });

    await step('Act: Step 1 — Open 재고 관리 and click the 상품코드 (Product code) link on the DEMO-SKU-0001 row', async () => {
      await form.openEditFromList(list, sku.skuCode, sku.groupCode);
    });

    await step('Assert: Expected 1 — The screen leaves the list', async () => {
      await expect(page, '[Expected 1] The address is no longer the stock list').not.toHaveURL(LIST_AFTER_EDIT);
      await expect(list.selectAllCheckbox, '[Expected 1] The stock list table (with its tick-all box) is gone').toBeHidden();
    });

    await step('Act: Step 2 — Read the page address', async () => {
      address = page.url();
    });

    await step('Assert: Expected 2 — The address is /commerce/product-stock/stock/physical/edit?skuGroupId={15-digit id}, not the product code', async () => {
      const url = new URL(address);
      const id = url.searchParams.get('skuGroupId') ?? '';
      expect(url.pathname, '[Expected 2] The path is /commerce/product-stock/stock/physical/edit').toBe('/commerce/product-stock/stock/physical/edit');
      expect(id, '[Expected 2] skuGroupId is the SKU group id').toBe(String(sku.groupId));
      expect(id, '[Expected 2] skuGroupId is a 15-digit id').toMatch(/^\d{15}$/);
      expect(id, '[Expected 2] skuGroupId is not the product code').not.toBe(sku.groupCode);
    });

    await step('Act: Step 3 — Read the trail and the value in the 상품코드 (Product code) field', async () => {
      await expect(form.skuGroupCodeInput, 'The product code field is shown').toBeVisible();
    });

    await step('Assert: Expected 3 — The trail says 재고 관리 › 수정 and 상품코드 shows DEMO-PC-001 as read-only text', async () => {
      await expect(form.breadcrumbItems.filter({ hasText: /^재고 관리$/ }), '[Expected 3] The trail holds 재고 관리 (Stock management)').toHaveCount(1);
      await expect(form.breadcrumbActive, '[Expected 3] The trail ends with 수정 (Edit)').toHaveText('수정');
      await expect(form.skuGroupCodeInput, `[Expected 3] 상품코드 shows ${sku.groupCode}`).toHaveValue(sku.groupCode);
      await expect(form.skuGroupCodeInput, '[Expected 3] 상품코드 is read-only').not.toBeEditable();
    });

    await step('Act: Step 4 — Copy the page address, open it in a new tab and read the form', async () => {
      const tab = await page.context().newPage();
      try {
        const other = new PhysicalSkuFormPage(tab);
        await tab.goto(address);
        await expect(other.cardTitle, 'The form loads in the new tab').toBeVisible({ timeout: 30_000 });
        await expect(other.skuGroupCodeInput, 'The new tab finishes loading the saved values').not.toHaveValue('', { timeout: 30_000 });
        otherCode = await other.skuGroupCodeInput.inputValue();
        otherAddress = tab.url();
      } finally {
        await tab.close();
      }
    });

    await step('Assert: Expected 4 — The same SKU group opens in the new tab, so skuGroupId travels in the address', async () => {
      expect(otherCode, `[Expected 4] The new tab shows product code ${sku.groupCode}`).toBe(sku.groupCode);
      expect(new URL(otherAddress).searchParams.get('skuGroupId'), '[Expected 4] The new tab keeps the same skuGroupId').toBe(String(sku.groupId));
    });
  });

  test('TC_US134_96 — The SKU type field is a locked dropdown in create mode and in edit mode', async ({ page, world }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormPage(page);
    let hint: string | null = null;
    let control = { tag: '', disabled: false };
    await tcMeta(
      'TC_US134_96',
      'Medium',
      TAGS,
      `SKU 유형 cannot be changed on 현물 SKU 생성 nor on the edit screen of DEMO-PC-001, its hover hint is 생성 후 수정 불가능합니다, and the DOM shows a <select> carrying the disabled attribute (not plain text). The hint is the native title attribute of the select — the browser tooltip itself is not captured (Not automated: tooltip rendering). ${WORLD_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–2 — Logged in with write access; DEMO-PC-001 is of type 현물 (Physical)', async () => {
      expect(world.sku('SKU0001').type, 'DEMO-PC-001 is PHYSICAL').toBe('PHYSICAL');
    });

    await step('Act: Step 1 — Open 현물 SKU 생성 and try to change SKU 유형 (SKU type)', async () => {
      await form.openCreate('physical');
      await form.tryChangeSelect(form.skuTypeSelect, t('skuForm.field.skuType'));
    });

    await step('Assert: Expected 1 — The field does not take the change and still shows 현물 (Physical)', async () => {
      await expect(form.skuTypeSelect, '[Expected 1] SKU 유형 is switched off').toBeDisabled();
      await expect(form.skuTypeSelect.locator('option:checked'), '[Expected 1] SKU 유형 still shows 현물').toHaveText('현물');
    });

    await step('Act: Step 2 — Hover over SKU 유형 (SKU type) and read the hint', async () => {
      await form.skuTypeSelect.hover({ force: true });
      hint = await form.skuTypeSelect.getAttribute('title');
    });

    await step('Assert: Expected 2 — The hint shows 생성 후 수정 불가능합니다 (Cannot be changed after creation.)', async () => {
      expect(hint, '[Expected 2] The SKU 유형 hint reads 생성 후 수정 불가능합니다').toBe('생성 후 수정 불가능합니다');
    });

    await step('Act: Step 3 — Open the edit screen of DEMO-PC-001 and try to change SKU 유형 (SKU type)', async () => {
      await form.openEdit('physical', world.sku('SKU0001').groupId);
      await form.tryChangeSelect(form.skuTypeSelect, t('skuForm.field.skuType'));
    });

    await step('Assert: Expected 3 — The field does not take the change and still shows 현물 (Physical)', async () => {
      await expect(form.skuTypeSelect, '[Expected 3] SKU 유형 is switched off').toBeDisabled();
      await expect(form.skuTypeSelect.locator('option:checked'), '[Expected 3] SKU 유형 still shows 현물').toHaveText('현물');
    });

    await step("Act: Step 4 — Inspect the page's own code of SKU 유형 (SKU type)", async () => {
      control = await form.skuTypeSelect.evaluate((el) => ({ tag: el.tagName.toLowerCase(), disabled: el.hasAttribute('disabled') }));
    });

    await step('Assert: Expected 4 — It is a dropdown carrying the switched-off setting, not plain display text', async () => {
      expect(control.tag, '[Expected 4] SKU 유형 is a <select> dropdown').toBe('select');
      expect(control.disabled, '[Expected 4] The dropdown carries the disabled attribute').toBe(true);
    });
  });

  test('TC_US134_97 — Saved SKU lines cannot be deleted, while new lines can be deleted', async ({ page, world }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormPage(page);
    const first = world.sku('SKU0001');
    const second = world.sku('SKU0002');
    await tcMeta(
      'TC_US134_97',
      'High',
      TAGS,
      `On the edit screen of DEMO-PC-001 (옵션있음, saved lines DEMO-SKU-0001 / 0002) the 삭제 button of a saved line is switched off and clicking it keeps the line; a line added with 추가 has an active 삭제 that removes it. "Greyed out" is asserted as the disabled state (colour not measured). Nothing is saved. ${WORLD_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–2 — Logged in with write access; DEMO-PC-001 has 옵션있음 and 2 saved lines DEMO-SKU-0001 / 0002', async () => {
      expect(first.groupId, 'DEMO-SKU-0001 and DEMO-SKU-0002 share one SKU group').toBe(second.groupId);
    });

    await step('Act: Step 1 — Open the edit screen of DEMO-PC-001 and look at the 삭제 (Delete) button on the DEMO-SKU-0001 line', async () => {
      await form.openEdit('physical', first.groupId);
      await expect(form.lineInput(0, 'skuCode'), 'The first line is DEMO-SKU-0001').toHaveValue(first.skuCode);
    });

    await step('Assert: Expected 1 — The button is greyed out', async () => {
      await expect(form.lineDeleteButton(0), '[Expected 1] 삭제 on the DEMO-SKU-0001 line is switched off').toBeDisabled();
    });

    await step('Act: Step 2 — Try clicking that button', async () => {
      await form.tryClick(form.lineDeleteButton(0), `${t('skuForm.btn.delete')} on the DEMO-SKU-0001 line`);
    });

    await step('Assert: Expected 2 — Nothing happens and the line stays in the table', async () => {
      await expect(form.dataLines, '[Expected 2] The table still has 2 lines').toHaveCount(2);
      await expect(form.lineInput(0, 'skuCode'), '[Expected 2] DEMO-SKU-0001 is still the first line').toHaveValue(first.skuCode);
    });

    await step('Act: Step 3 — Click 추가 (Add) to add a new empty line and look at its 삭제 (Delete) button', async () => {
      await form.click(form.addButton, `${t('skuForm.btn.add')} button`);
    });

    await step('Assert: Expected 3 — The button on the new line is not greyed out', async () => {
      await expect(form.dataLines, '[Expected 3] A third line is added').toHaveCount(3);
      await expect(form.lineDeleteButton(2), '[Expected 3] 삭제 on the new line is active').toBeEnabled();
    });

    await step('Act: Step 4 — Click the 삭제 (Delete) button on the new line', async () => {
      await form.click(form.lineDeleteButton(2), `${t('skuForm.btn.delete')} on the new line`);
    });

    await step('Assert: Expected 4 — The new line is taken out of the table, only saved lines are protected', async () => {
      await expect(form.dataLines, '[Expected 4] The table is back to 2 lines').toHaveCount(2);
      await expect(form.lineInput(0, 'skuCode'), '[Expected 4] DEMO-SKU-0001 is still in the table').toHaveValue(first.skuCode);
      await expect(form.lineInput(1, 'skuCode'), '[Expected 4] DEMO-SKU-0002 is still in the table').toHaveValue(second.skuCode);
    });
  });

  test('TC_US134_98 — Both duplicate checks are required before a physical SKU can be created', async ({ page, world }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormPage(page);
    const data = codes(world, 'T98');
    const writes = form.recordSkuWrites();
    let blocked1 = { disabled: false, message: false };
    let blocked2 = { disabled: false, message: false };
    let codeCheck: { status: number; body: { ids?: unknown[] } | null } = { status: 0, body: null };
    let available = false;
    let saved: { status: number } = { status: 0 };
    await tcMeta(
      'TC_US134_98',
      'High',
      TAGS,
      `On 현물 SKU 생성 filled with valid data, 저장 is blocked until 중복확인 (product code) and then 바코드 중복확인 have both run; after both, 모든 바코드 사용 가능합니다. shows and the save returns to the list. NEEDS CLARIFICATION in the TC (disabled 저장 vs. a message): the steps accept either, the build disables 저장 (bundle: saveDisabled = !codeChecked || !barcodeChecked). HS code: a unique 10-digit value instead of 6109101000. ${CODE_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; the product code and barcode are unused; valid test data prepared', async () => {
      expect(data.groupCode.length, 'The product code fits 20 characters').toBeLessThanOrEqual(20);
    });

    await step('Act: Step 1 — Open 현물 SKU 생성, enter all test data and try 저장 without either duplicate check', async () => {
      await form.openCreate('physical');
      await form.fillCommon(commonValues(world, data.groupCode));
      await form.fillLine(0, { skuCode: data.skuCode, exportSkuName: EXPORT_NAME, barcode: data.barcode });
      const { disabled } = await form.trySave();
      blocked1 = { disabled, message: await form.toastOf('skuForm.err.codeCheckRequired').isVisible() };
    });

    await step('Assert: Expected 1 — Saving is blocked (a disabled 저장 or 상품코드 중복확인 버튼을 눌러주세요)', async () => {
      expect(blocked1.disabled || blocked1.message, '[Expected 1] 저장 is disabled or 상품코드 중복확인 버튼을 눌러주세요 is shown').toBe(true);
      expect(writes, '[Expected 1] No save call is sent').toHaveLength(0);
    });

    await step('Act: Step 2 — Click 중복확인 for 상품코드, then try 저장 again without the barcode check', async () => {
      codeCheck = await form.checkCodeWithResponse();
      const { disabled } = await form.trySave();
      blocked2 = { disabled, message: await form.toastOf('skuForm.err.barcodeCheckRequired').isVisible() };
    });

    await step('Assert: Expected 2 — The product code check passes and 상품코드 locks; saving is still blocked', async () => {
      expect(codeCheck.body?.ids ?? ['missing'], '[Expected 2] The product code check returns no duplicate').toHaveLength(0);
      await expect(form.groupCodeError, '[Expected 2] No product code error is shown').toBeHidden();
      await expect(form.skuGroupCodeInput, '[Expected 2] 상품코드 is locked').not.toBeEditable();
      expect(blocked2.disabled || blocked2.message, '[Expected 2] 저장 is disabled or 바코드 중복확인 버튼을 눌러주세요 is shown').toBe(true);
      expect(writes, '[Expected 2] No save call is sent').toHaveLength(0);
    });

    await step('Act: Step 3 — Click 바코드 중복확인, then click 저장 again', async () => {
      await form.checkBarcodeWithResponse();
      available = await form.seen(form.toastOf('skuForm.msg.barcodeAvailable'));
      try {
        saved = await form.saveWithResponse();
      } finally {
        await world.trackGroupCode(data.groupCode);
      }
    });

    await step('Assert: Expected 3 — 모든 바코드 사용 가능합니다. is shown, the save succeeds and the list is shown', async () => {
      expect(available, `[Expected 3] ${t('skuForm.msg.barcodeAvailable')} is shown`).toBe(true);
      expect(saved.status, '[Expected 3] The save call succeeds').toBeLessThan(300);
      await expect(page, '[Expected 3] The system returns to the list').toHaveURL(LIST_AFTER_CREATE);
    });
  });

  test('TC_US134_99 — Only the barcode check is required in edit mode', async ({ page, world, stockApi, stockListPage: list }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormPage(page);
    const writes = form.recordSkuWrites();
    let group: WorldSku[] = [];
    let blocked = { disabled: false, message: false };
    let state = { disabled: false, codeMessages: 0, barcodeMessage: false };
    let available = false;
    let saved: { status: number } = { status: 0 };
    let storedName = '';
    let reopened = { saveDisabled: false, checkVisible: false };
    await tcMeta(
      'TC_US134_99',
      'Medium',
      TAGS,
      `On the edit screen (opened from 재고 관리) a changed 상품코드명 cannot be saved before 바코드 중복확인 and no product-code check message appears; after the barcode check (모든 바코드 사용 가능합니다.) the save goes through; reopened with no change, 저장 stays greyed out. NEEDS CLARIFICATION in the TC (disabled 저장 vs. a message): either is accepted, the build disables 저장. The edit uses a 2-line 옵션있음 SKU group named Demo Album [Vol.1] that the test creates itself (stands in for DEMO-PC-001) because the save writes. ${CODE_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–2 — Logged in with write access; a SKU group with 2 saved lines named Demo Album [Vol.1] exists', async () => {
      group = await world.createPhysicalSku('P99', {
        partner: world.partners.A,
        manufacturer: world.manufacturers.M1,
        groupName: 'Demo Album [Vol.1]',
        lines: [{ option: 'Photocard (Type A)' }, { option: 'Photocard (Type B)' }],
      });
      expect(group, 'The SKU group has 2 saved lines').toHaveLength(2);
      await list.open();
    });

    await step('Act: Step 1 — Open the edit screen from 재고 관리, change 상품코드명 to Demo Album [Vol.1] rev2 and try 저장 without any duplicate check', async () => {
      await form.openEditFromList(list, group[0].skuCode, group[0].groupCode);
      await form.skuGroupCodeNameInput.fill('Demo Album [Vol.1] rev2');
      const { disabled } = await form.trySave();
      blocked = { disabled, message: await form.toastOf('skuForm.err.barcodeCheckRequired').isVisible() };
    });

    await step('Assert: Expected 1 — Saving is blocked', async () => {
      expect(blocked.disabled || blocked.message, '[Expected 1] 저장 is disabled or a barcode-check message stops the save').toBe(true);
      expect(writes, '[Expected 1] No save call is sent').toHaveLength(0);
    });

    await step('Act: Step 2 — Read the state of 저장 (Save) and any message that appears', async () => {
      state = {
        disabled: await form.saveButton.isDisabled(),
        codeMessages: await form.toastOf('skuForm.err.codeCheckRequired').count(),
        barcodeMessage: await form.toastOf('skuForm.err.barcodeCheckRequired').isVisible(),
      };
    });

    await step('Assert: Expected 2 — No product code duplicate-check message appears (disabled 저장 or 바코드 중복확인 버튼을 눌러주세요)', async () => {
      expect(state.codeMessages, `[Expected 2] ${t('skuForm.err.codeCheckRequired')} is not shown`).toBe(0);
      await expect(form.groupCodeError, '[Expected 2] No product code error sits under 상품코드').toBeHidden();
      expect(state.disabled || state.barcodeMessage, '[Expected 2] 저장 is disabled or 바코드 중복확인 버튼을 눌러주세요 is shown').toBe(true);
    });

    await step('Act: Step 3 — Click 바코드 중복확인 once, then click 저장 again', async () => {
      await form.checkBarcode();
      available = await form.seen(form.toastOf('skuForm.msg.barcodeAvailable'));
      saved = await form.saveWithResponse();
      storedName = (await stockApi.skuGroup(group[0].groupId)).body.groupName;
    });

    await step('Assert: Expected 3 — The check shows 모든 바코드 사용 가능합니다. and the save goes through', async () => {
      expect(available, `[Expected 3] ${t('skuForm.msg.barcodeAvailable')} is shown`).toBe(true);
      expect(saved.status, '[Expected 3] The save call succeeds').toBeLessThan(300);
      expect(storedName, '[Expected 3] The new product code name is stored').toBe('Demo Album [Vol.1] rev2');
      await expect(page, '[Expected 3] The system returns to the list').toHaveURL(LIST_AFTER_EDIT);
    });

    await step('Act: Step 4 — Open that same edit screen again, change nothing, and see whether 저장 can be used', async () => {
      await form.openEdit('physical', group[0].groupId);
      reopened = { saveDisabled: await form.saveButton.isDisabled(), checkVisible: await form.checkBarcodeButton.isVisible() };
    });

    await step('Assert: Expected 4 — 저장 is greyed out and the barcode check must still be completed', async () => {
      expect(reopened.saveDisabled, '[Expected 4] 저장 is greyed out').toBe(true);
      expect(reopened.checkVisible, '[Expected 4] 바코드 중복확인 is still waiting to be run').toBe(true);
    });
  });

  test('TC_US134_100 — The barcode check passes without calling the server while the lines are untouched', async ({ page, world }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormPage(page);
    const first = world.sku('SKU0001');
    const second = world.sku('SKU0002');
    const newBarcode = uniqueCode(world.tag, 'T100B');
    const checks = form.recordBarcodeChecks();
    let callsAfterUntouched = -1;
    let callsAfterChange = -1;
    await tcMeta(
      'TC_US134_100',
      'Medium',
      TAGS,
      `On the edit screen of DEMO-PC-001 with nothing changed, 바코드 중복확인 passes with 모든 바코드 사용 가능합니다. and sends no POST /skus/check-duplication; after the first line's barcode is changed (unique run value instead of DEMO-BC-0099) exactly 1 check call is sent. Observed: a passed check locks the barcode inputs, so Step 4 presses 다른 바코드 사용 before typing the new barcode. Nothing is saved. ${WORLD_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–2 — Logged in with write access; the network calls are recorded from a clean list', async () => {
      expect(checks, 'No duplicate-check call has been recorded yet').toHaveLength(0);
    });

    await step('Act: Step 1 — Open the edit screen of DEMO-PC-001 and change nothing', async () => {
      await form.openEdit('physical', first.groupId);
    });

    await step('Assert: Expected 1 — The form opens with both lines showing their saved barcodes', async () => {
      await expect(form.lineInput(0, 'barcode'), `[Expected 1] Line 1 shows its saved barcode ${first.barcode}`).toHaveValue(first.barcode ?? '');
      await expect(form.lineInput(1, 'barcode'), `[Expected 1] Line 2 shows its saved barcode ${second.barcode}`).toHaveValue(second.barcode ?? '');
    });

    await step('Act: Step 2 — Click 바코드 중복확인 (Barcode duplicate check)', async () => {
      await form.checkBarcode();
    });

    await step('Assert: Expected 2 — The check finishes', async () => {
      await expect(form.useOtherBarcodeButton, '[Expected 2] The check finished — 다른 바코드 사용 replaces the check button').toBeVisible();
    });

    await step('Act: Step 3 — Read the message that appears and the list of network calls', async () => {
      callsAfterUntouched = checks.length;
    });

    await step('Assert: Expected 3 — 모든 바코드 사용 가능합니다. is shown and no duplicate-check call is sent', async () => {
      await expect(form.toastOf('skuForm.msg.barcodeAvailable'), `[Expected 3] ${t('skuForm.msg.barcodeAvailable')} is shown`).toBeVisible();
      expect(callsAfterUntouched, '[Expected 3] No POST /skus/check-duplication call is sent').toBe(0);
    });

    await step('Act: Step 4 — Change the barcode of the first line, click 바코드 중복확인 again and read the list of calls', async () => {
      await form.useOtherBarcode();
      await form.lineInput(0, 'barcode').fill(newBarcode);
      await form.checkBarcodeWithResponse();
      callsAfterChange = checks.length;
    });

    await step('Assert: Expected 4 — This time 1 duplicate-check call is sent', async () => {
      expect(callsAfterChange, '[Expected 4] Exactly 1 POST /skus/check-duplication call is sent').toBe(1);
    });
  });

  test('TC_US134_101 — The barcode check sends only new or changed SKU lines', async ({ page, world }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormPage(page);
    const first = world.sku('SKU0001');
    const second = world.sku('SKU0002');
    const changedBarcode = uniqueCode(world.tag, 'T101C');
    const newSkuCode = uniqueCode(world.tag, 'T101S');
    const newBarcode = uniqueCode(world.tag, 'T101B');
    let payload: { skuCodes?: string[]; barcodes?: string[] } = {};
    await tcMeta(
      'TC_US134_101',
      'Medium',
      TAGS,
      `On the edit screen of DEMO-PC-001, after changing line 2's barcode and adding a third line, the POST /skus/check-duplication payload carries the changed barcode plus the new line's SKU code and barcode, and nothing of the untouched first line. Unique run values stand in for DEMO-BC-0098 / DEMO-SKU-901 / DEMO-BC-901. Nothing is saved. ${WORLD_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; DEMO-PC-001 has 2 saved lines with their barcodes; network calls are recorded', async () => {
      expect(first.barcode, 'DEMO-SKU-0001 has a barcode').toBeTruthy();
      expect(second.barcode, 'DEMO-SKU-0002 has a barcode').toBeTruthy();
    });

    await step('Act: Step 1 — Open the edit screen of DEMO-PC-001 and change the barcode of the second line, leaving the first line alone', async () => {
      await form.openEdit('physical', first.groupId);
      await form.lineInput(1, 'barcode').fill(changedBarcode);
    });

    await step('Assert: Expected 1 — The second line shows the new barcode', async () => {
      await expect(form.lineInput(1, 'barcode'), `[Expected 1] Line 2 shows ${changedBarcode}`).toHaveValue(changedBarcode);
      await expect(form.lineInput(0, 'barcode'), '[Expected 1] Line 1 keeps its saved barcode').toHaveValue(first.barcode ?? '');
    });

    await step('Act: Step 2 — Click 추가 (Add) and type a SKU code and barcode into the new line', async () => {
      await form.click(form.addButton, `${t('skuForm.btn.add')} button`);
      await form.fillLine(2, { skuCode: newSkuCode, barcode: newBarcode });
    });

    await step('Assert: Expected 2 — A third line is added carrying the values just typed', async () => {
      await expect(form.dataLines, '[Expected 2] The table has 3 lines').toHaveCount(3);
      await expect(form.lineInput(2, 'skuCode'), `[Expected 2] Line 3 holds SKU code ${newSkuCode}`).toHaveValue(newSkuCode);
      await expect(form.lineInput(2, 'barcode'), `[Expected 2] Line 3 holds barcode ${newBarcode}`).toHaveValue(newBarcode);
    });

    await step('Act: Step 3 — Click 바코드 중복확인 and read the data sent to the server', async () => {
      const request = page.waitForRequest((req) => req.method() === 'POST' && new URL(req.url()).pathname === '/api/v1/skus/check-duplication');
      await form.checkBarcode();
      payload = (await request).postDataJSON() ?? {};
    });

    await step('Assert: Expected 3 — The data has the changed barcode and the new line, and not the untouched first line', async () => {
      expect(payload.barcodes ?? [], `[Expected 3] The changed barcode ${changedBarcode} is sent`).toContain(changedBarcode);
      expect(payload.skuCodes ?? [], `[Expected 3] The new SKU code ${newSkuCode} is sent`).toContain(newSkuCode);
      expect(payload.barcodes ?? [], `[Expected 3] The new barcode ${newBarcode} is sent`).toContain(newBarcode);
      expect(payload.skuCodes ?? [], `[Expected 3] The untouched first line's SKU code ${first.skuCode} is not sent`).not.toContain(first.skuCode);
      expect(payload.barcodes ?? [], `[Expected 3] The untouched first line's barcode ${first.barcode} is not sent`).not.toContain(first.barcode);
    });
  });

  test('TC_US134_102 — Barcode fields lock after a passed check and unlock with Use another barcode', async ({ page, world }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormPage(page);
    const data = codes(world, 'T102');
    let check: { status: number; body: { ids?: unknown[] } | null } = { status: 0, body: null };
    let available = false;
    await tcMeta(
      'TC_US134_102',
      'Medium',
      TAGS,
      `On 현물 SKU 생성, a passed 바코드 중복확인 (모든 바코드 사용 가능합니다.) locks the line's SKU 코드 and 바코드, the check button turns into 다른 바코드 사용, and clicking it makes both fields editable again. ${LOCK_NOTE} Nothing is saved. ${CODE_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; the barcode is unused; SKU code / barcode test data prepared', async () => {
      await form.openCreate('physical');
    });

    await step('Act: Step 1 — Fill the SKU line with the test data and click 바코드 중복확인', async () => {
      await form.fillLine(0, { skuCode: data.skuCode, barcode: data.barcode });
      check = await form.checkBarcodeWithResponse();
      available = await form.seen(form.toastOf('skuForm.msg.barcodeAvailable'));
    });

    await step('Assert: Expected 1 — The barcode check passes and shows 모든 바코드 사용 가능합니다.', async () => {
      expect(check.body?.ids ?? ['missing'], '[Expected 1] The check finds no duplicate').toHaveLength(0);
      expect(available, `[Expected 1] ${t('skuForm.msg.barcodeAvailable')} is shown`).toBe(true);
    });

    await step('Act: Step 2 — Try to type into SKU 코드 (SKU code) and 바코드 (Barcode) on that line', async () => {
      await form.tryType(form.lineInput(0, 'skuCode'), 'X', `${t('skuForm.col.skuCode')} of line 1`);
      await form.tryType(form.lineInput(0, 'barcode'), 'X', `${t('skuForm.col.barcode')} of line 1`);
    });

    await step('Assert: Expected 2 — Both fields are locked and do not accept input', async () => {
      await expect(form.lineInput(0, 'skuCode'), '[Expected 2] SKU 코드 is locked').not.toBeEditable();
      await expect(form.lineInput(0, 'skuCode'), '[Expected 2] SKU 코드 took no character').toHaveValue(data.skuCode);
      await expect(form.lineInput(0, 'barcode'), '[Expected 2] 바코드 is locked').not.toBeEditable();
      await expect(form.lineInput(0, 'barcode'), '[Expected 2] 바코드 took no character').toHaveValue(data.barcode);
    });

    await step('Act: Step 3 — Read the button now sitting where the check button was', async () => {
      await expect(form.useOtherBarcodeButton.or(form.checkBarcodeButton), 'A barcode button is shown above the table').toBeVisible();
    });

    await step('Assert: Expected 3 — The button label is 다른 바코드 사용 (Use another barcode)', async () => {
      await expect(form.useOtherBarcodeButton, `[Expected 3] The button reads ${t('skuForm.btn.useOtherBarcode')}`).toBeVisible();
      await expect(form.checkBarcodeButton, `[Expected 3] ${t('skuForm.btn.checkBarcode')} is no longer shown`).toHaveCount(0);
    });

    await step('Act: Step 4 — Click 다른 바코드 사용 and try typing into those 2 fields again', async () => {
      await form.useOtherBarcode();
      await form.tryType(form.lineInput(0, 'skuCode'), 'X', `${t('skuForm.col.skuCode')} of line 1`);
      await form.tryType(form.lineInput(0, 'barcode'), 'X', `${t('skuForm.col.barcode')} of line 1`);
    });

    await step('Assert: Expected 4 — Both fields are enabled and editable again', async () => {
      await expect(form.lineInput(0, 'skuCode'), '[Expected 4] SKU 코드 is editable').toBeEditable();
      await expect(form.lineInput(0, 'skuCode'), '[Expected 4] SKU 코드 took the typed character').toHaveValue(`${data.skuCode}X`);
      await expect(form.lineInput(0, 'barcode'), '[Expected 4] 바코드 is editable').toBeEditable();
      await expect(form.lineInput(0, 'barcode'), '[Expected 4] 바코드 took the typed character').toHaveValue(`${data.barcode}X`);
    });
  });

  test('TC_US134_103 — A duplicate product code is rejected and the field stays editable', async ({ page, world }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormPage(page);
    const existing = world.sku('SKU0001').groupCode;
    const fresh = uniqueCode(world.tag, 'T103P');
    let duplicate: { status: number; body: { ids?: unknown[] } | null } = { status: 0, body: null };
    let clean: { status: number; body: { ids?: unknown[] } | null } = { status: 0, body: null };
    await tcMeta(
      'TC_US134_103',
      'Medium',
      TAGS,
      `On 현물 SKU 생성, 중복확인 of the product code of DEMO-PC-001 answers HTTP 200 with a non-empty ids array and the screen shows 이미 등록된 상품코드입니다. while 상품코드 stays editable; a fresh code (unique run value instead of DEMO-PC-903) answers an empty ids array and 상품코드 locks. ${LOCK_NOTE} Nothing is saved. ${WORLD_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; DEMO-PC-001 is already used by a SKU group', async () => {
      expect(existing, 'DEMO-PC-001 exists in the demo world').not.toBe('');
    });

    await step('Act: Step 1 — Open 현물 SKU 생성 and type DEMO-PC-001 into 상품코드 (Product code)', async () => {
      await form.openCreate('physical');
      await form.retype(form.skuGroupCodeInput, existing, t('skuForm.field.skuGroupCode'));
    });

    await step('Assert: Expected 1 — The product code field accepts the value', async () => {
      await expect(form.skuGroupCodeInput, `[Expected 1] 상품코드 holds ${existing}`).toHaveValue(existing);
    });

    await step('Act: Step 2 — Click 중복확인 (Duplicate check)', async () => {
      duplicate = await form.checkCodeWithResponse();
    });

    await step('Assert: Expected 2 — HTTP 200 with a non-empty ids array; the screen shows 이미 등록된 상품코드입니다.', async () => {
      expect(duplicate.status, '[Expected 2] The duplicate-check call answers HTTP 200').toBe(200);
      expect((duplicate.body?.ids ?? []).length, '[Expected 2] The ids array is not empty').toBeGreaterThan(0);
      await expect(form.groupCodeError, `[Expected 2] ${t('skuForm.err.codeDuplicated')} is shown`).toHaveText(t('skuForm.err.codeDuplicated'));
    });

    await step('Act: Step 3 — Try to type into 상품코드 (Product code)', async () => {
      await form.tryType(form.skuGroupCodeInput, 'X', t('skuForm.field.skuGroupCode'));
    });

    await step('Assert: Expected 3 — The product code field remains enabled and editable', async () => {
      await expect(form.skuGroupCodeInput, '[Expected 3] 상품코드 is editable').toBeEditable();
      await expect(form.skuGroupCodeInput, '[Expected 3] 상품코드 took the typed character').toHaveValue(`${existing}X`);
    });

    await step('Act: Step 4 — Replace the value with a fresh product code and click 중복확인 again', async () => {
      await form.retype(form.skuGroupCodeInput, fresh, t('skuForm.field.skuGroupCode'));
      clean = await form.checkCodeWithResponse();
    });

    await step('Assert: Expected 4 — The product code is replaced and the field locks after the check passes', async () => {
      await expect(form.skuGroupCodeInput, `[Expected 4] 상품코드 holds ${fresh}`).toHaveValue(fresh);
      expect(clean.body?.ids ?? ['missing'], '[Expected 4] The check finds no duplicate').toHaveLength(0);
      await expect(form.skuGroupCodeInput, '[Expected 4] 상품코드 is locked').not.toBeEditable();
    });
  });

  test('TC_US134_104 — A duplicate barcode is rejected and the field stays editable', async ({ page, world }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormPage(page);
    const taken = world.sku('SKU0001').barcode ?? '';
    const data = codes(world, 'T104');
    let duplicate: { status: number; body: { ids?: unknown[] } | null } = { status: 0, body: null };
    let clean: { status: number; body: { ids?: unknown[] } | null } = { status: 0, body: null };
    let edited = '';
    let after = { available: false, skuCodeLocked: false, barcodeLocked: false, swapped: false, skuCodeUnlocked: false, barcodeUnlocked: false };
    await tcMeta(
      'TC_US134_104',
      'Medium',
      TAGS,
      `On 현물 SKU 생성, 바코드 중복확인 with the barcode of DEMO-SKU-0001 answers HTTP 200 with a non-empty ids array and shows 이미 존재하는 바코드 입니다. - <barcode> while 바코드 stays editable; a fresh barcode (unique run value instead of DEMO-BC-904) answers an empty ids array, shows 모든 바코드 사용 가능합니다., locks SKU 코드 + 바코드, and 다른 바코드 사용 unlocks them. Step 3 proves the field is editable by deleting one character (the demo barcode already uses all 20 characters). ${LOCK_NOTE} Nothing is saved. ${WORLD_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; DEMO-SKU-0001 uses its barcode; test data prepared', async () => {
      expect(taken, 'DEMO-SKU-0001 has a barcode').not.toBe('');
      await form.openCreate('physical');
    });

    await step('Act: Step 1 — Fill the SKU line with the test data', async () => {
      await form.fillLine(0, { skuCode: data.skuCode, barcode: taken });
    });

    await step('Assert: Expected 1 — The SKU code and barcode fields accept both values', async () => {
      await expect(form.lineInput(0, 'skuCode'), `[Expected 1] SKU 코드 holds ${data.skuCode}`).toHaveValue(data.skuCode);
      await expect(form.lineInput(0, 'barcode'), `[Expected 1] 바코드 holds ${taken}`).toHaveValue(taken);
    });

    await step('Act: Step 2 — Click 바코드 중복확인 (Barcode duplicate check)', async () => {
      duplicate = await form.checkBarcodeWithResponse();
    });

    await step('Assert: Expected 2 — HTTP 200 with a non-empty ids array; the screen shows 이미 존재하는 바코드 입니다. - <barcode>', async () => {
      expect(duplicate.status, '[Expected 2] The duplicate-check call answers HTTP 200').toBe(200);
      expect((duplicate.body?.ids ?? []).length, '[Expected 2] The ids array is not empty').toBeGreaterThan(0);
      await expect(form.toast(`${t('skuForm.err.barcodeDuplicated')} - ${taken}`), `[Expected 2] ${t('skuForm.err.barcodeDuplicated')} - ${taken} is shown`).toBeVisible();
    });

    await step('Act: Step 3 — Try to type into the 바코드 (Barcode) field on that line', async () => {
      await form.lineInput(0, 'barcode').click();
      await page.keyboard.press('End');
      await page.keyboard.press('Backspace');
      edited = await form.lineInput(0, 'barcode').inputValue();
    });

    await step('Assert: Expected 3 — The barcode field remains enabled and editable', async () => {
      await expect(form.lineInput(0, 'barcode'), '[Expected 3] 바코드 is editable').toBeEditable();
      expect(edited, '[Expected 3] 바코드 took the key press').toBe(taken.slice(0, -1));
    });

    await step('Act: Step 4 — Replace the barcode with a fresh one and click 바코드 중복확인 again', async () => {
      await form.lineInput(0, 'barcode').fill(data.barcode);
      clean = await form.checkBarcodeWithResponse();
      after.available = await form.seen(form.toastOf('skuForm.msg.barcodeAvailable'));
      after.skuCodeLocked = !(await form.lineInput(0, 'skuCode').isEditable());
      after.barcodeLocked = !(await form.lineInput(0, 'barcode').isEditable());
      after.swapped = await form.useOtherBarcodeButton.isVisible();
      await form.useOtherBarcode();
      after.skuCodeUnlocked = await form.lineInput(0, 'skuCode').isEditable();
      after.barcodeUnlocked = await form.lineInput(0, 'barcode').isEditable();
    });

    await step('Assert: Expected 4 — Empty ids, 모든 바코드 사용 가능합니다., inputs lock, 다른 바코드 사용 appears and unlocks them', async () => {
      await expect(form.lineInput(0, 'barcode'), `[Expected 4] 바코드 holds ${data.barcode}`).toHaveValue(data.barcode);
      expect(clean.body?.ids ?? ['missing'], '[Expected 4] The check returns an empty ids array').toHaveLength(0);
      expect(after.available, `[Expected 4] ${t('skuForm.msg.barcodeAvailable')} is shown`).toBe(true);
      expect(after.skuCodeLocked, '[Expected 4] SKU 코드 locks after the check').toBe(true);
      expect(after.barcodeLocked, '[Expected 4] 바코드 locks after the check').toBe(true);
      expect(after.swapped, `[Expected 4] The button swaps itself for ${t('skuForm.btn.useOtherBarcode')}`).toBe(true);
      expect(after.skuCodeUnlocked, '[Expected 4] 다른 바코드 사용 unlocks SKU 코드').toBe(true);
      expect(after.barcodeUnlocked, '[Expected 4] 다른 바코드 사용 unlocks 바코드').toBe(true);
    });
  });

  test('TC_US134_105 — The barcode check rejects two new lines that share a barcode or a SKU code', async ({ page, world }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormPage(page);
    const sku921 = uniqueCode(world.tag, 'T105S');
    const sku922 = uniqueCode(world.tag, 'T105S');
    const bc921 = uniqueCode(world.tag, 'T105B');
    const bc922 = uniqueCode(world.tag, 'T105B');
    let barcodeClash = false;
    let skuClash = false;
    let available = false;
    await tcMeta(
      'TC_US134_105',
      'High',
      TAGS,
      `On 현물 SKU 생성 (옵션있음, 2 lines), 바코드 중복확인 is not clean when both new lines share a barcode (이미 존재하는 바코드 입니다. - <barcode>, inputs stay editable) or share a SKU code (이미 존재하는 SKU 입니다. - <code>), and is clean (모든 바코드 사용 가능합니다.) once both differ. Unique run values stand in for DEMO-SKU-921/922 and DEMO-BC-921/922. Bundle note: the form compares barcodes of its own lines client-side, while a shared SKU code is left to the server check. If a check passes unexpectedly, Step 3 presses 다른 바코드 사용 first to unlock the inputs. Nothing is saved. ${CODE_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–3 — Create mode with 옵션 설정 옵션있음 and 2 lines; the 4 codes are unused', async () => {
      await form.openCreate('physical');
      await form.optionHas.check();
      await form.click(form.addButton, `${t('skuForm.btn.add')} button`);
      await expect(form.dataLines, 'The table has 2 lines').toHaveCount(2);
    });

    await step('Act: Step 1 — Fill line 1 with SKU-921 / BC-921 and line 2 with SKU-922 / BC-921, then click 바코드 중복확인', async () => {
      await form.fillLine(0, { skuCode: sku921, barcode: bc921 });
      await form.fillLine(1, { skuCode: sku922, barcode: bc921 });
      await form.checkBarcode();
      barcodeClash = await form.seen(form.toast(`${t('skuForm.err.barcodeDuplicated')} - ${bc921}`));
    });

    await step('Assert: Expected 1 — The check is not clean and shows 이미 존재하는 바코드 입니다. - BC-921; the inputs stay editable', async () => {
      expect(barcodeClash, `[Expected 1] ${t('skuForm.err.barcodeDuplicated')} - ${bc921} is shown`).toBe(true);
      await expect(form.checkBarcodeButton, '[Expected 1] The check did not pass — 바코드 중복확인 is still shown').toBeVisible();
      for (const index of [0, 1]) {
        await expect(form.lineInput(index, 'skuCode'), `[Expected 1] SKU 코드 of line ${index + 1} stays editable`).toBeEditable();
        await expect(form.lineInput(index, 'barcode'), `[Expected 1] 바코드 of line ${index + 1} stays editable`).toBeEditable();
      }
    });

    await step('Act: Step 2 — Change line 2 to SKU-921 / BC-922 and click 바코드 중복확인', async () => {
      await form.fillLine(1, { skuCode: sku921, barcode: bc922 });
      await form.checkBarcode();
      skuClash = await form.seen(form.toast(`${t('skuForm.err.skuCodeDuplicated')} - ${sku921}`));
    });

    await step('Assert: Expected 2 — The check is not clean and shows 이미 존재하는 SKU 입니다. - SKU-921', async () => {
      expect(skuClash, `[Expected 2] ${t('skuForm.err.skuCodeDuplicated')} - ${sku921} is shown`).toBe(true);
      await expect(form.checkBarcodeButton, '[Expected 2] The check did not pass — 바코드 중복확인 is still shown').toBeVisible();
    });

    await step('Act: Step 3 — Change line 2 to SKU-922 / BC-922 and click 바코드 중복확인', async () => {
      if (await form.useOtherBarcodeButton.isVisible()) await form.useOtherBarcode();
      await form.fillLine(1, { skuCode: sku922, barcode: bc922 });
      await form.checkBarcode();
      available = await form.seen(form.toastOf('skuForm.msg.barcodeAvailable'));
    });

    await step('Assert: Expected 3 — The check shows 모든 바코드 사용 가능합니다.', async () => {
      expect(available, `[Expected 3] ${t('skuForm.msg.barcodeAvailable')} is shown`).toBe(true);
    });
  });

  test('TC_US134_106 — Save rejects a duplicate SKU code', async ({ page, world }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormPage(page);
    const data = codes(world, 'T106');
    const takenSku = world.sku('SKU0001').skuCode;
    const values = commonValues(world, data.groupCode);
    const message = `${t('skuForm.err.skuCodeDuplicated')} - ${takenSku}`;
    let codeCheck: { status: number; body: { ids?: unknown[] } | null } = { status: 0, body: null };
    let available = false;
    let saved: { status: number; body: Record<string, unknown> | null } | null = null;
    let line = { lockedAfterSave: false, unlocked: false };
    await tcMeta(
      'TC_US134_106',
      'Medium',
      TAGS,
      `On 현물 SKU 생성 filled with valid data but the SKU code of DEMO-SKU-0001, both duplicate checks pass and 저장 is rejected with WH-SKU_ALREADY_EXISTS (이미 존재하는 SKU 입니다. - <code>); the form stays open, SKU 코드 stays locked by the passed barcode check and becomes editable only after 다른 바코드 사용. Bundle note: 바코드 중복확인 also sends the new lines' SKU codes, so the build may already refuse the check in Step 2 — then Expected 2 fails and 저장 stays disabled. HS code: a unique 10-digit value instead of 6109101000. ${CODE_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; DEMO-SKU-0001 already uses that SKU code; test data prepared', async () => {
      expect(takenSku, 'DEMO-SKU-0001 has a SKU code').not.toBe('');
    });

    await step('Act: Step 1 — Open 현물 SKU 생성 and fill every field with the test data', async () => {
      await form.openCreate('physical');
      await form.fillCommon(values);
      await form.fillLine(0, { skuCode: takenSku, exportSkuName: EXPORT_NAME, barcode: data.barcode });
    });

    await step('Assert: Expected 1 — The form accepts all entered values', async () => {
      await expect(form.bizPartnerSelect, '[Expected 1] 비즈파트너 holds Demo Partner A').toHaveValue(String(world.partners.A.id));
      await expect(form.skuGroupCodeInput, '[Expected 1] 상품코드 holds the test value').toHaveValue(data.groupCode);
      await expect(form.skuGroupCodeNameInput, '[Expected 1] 상품코드명 holds Demo Test Product').toHaveValue('Demo Test Product');
      await expect(form.usageRadio('MAIN'), '[Expected 1] SKU 종류 is 본품').toBeChecked();
      await expect(form.optionNone, '[Expected 1] 옵션 설정 is 옵션없음').toBeChecked();
      await expect(form.priceInput, '[Expected 1] 공급원가 holds 12000').toHaveValue('12000');
      await expect(form.lineInput(0, 'skuCode'), `[Expected 1] SKU 코드 holds ${takenSku}`).toHaveValue(takenSku);
      await expect(form.lineInput(0, 'exportSkuName'), `[Expected 1] 수출용 SKU명 holds ${EXPORT_NAME}`).toHaveValue(EXPORT_NAME);
      await expect(form.lineInput(0, 'barcode'), '[Expected 1] 바코드 holds the test value').toHaveValue(data.barcode);
      await expect(form.weightInput, '[Expected 1] 중량 holds 250').toHaveValue('250');
      await expect(form.widthInput, '[Expected 1] 부피 width holds 100').toHaveValue('100');
      await expect(form.depthInput, '[Expected 1] 부피 depth holds 80').toHaveValue('80');
      await expect(form.heightInput, '[Expected 1] 부피 height holds 30').toHaveValue('30');
      await expect(form.hsCodeInput, '[Expected 1] HS 코드 holds 10 digits').toHaveValue(values.hsCode ?? '');
      await expect(form.descriptionInput, '[Expected 1] 상품 간단 설명 holds CD').toHaveValue('CD');
      await expect(form.manufacturerSelect, '[Expected 1] 제조사 holds Demo Manufacturer 1').toHaveValue(String(world.manufacturers.M1.id));
      await expect(form.field('skuForm.field.countryOfOrigin'), '[Expected 1] 원산지 shows 대한민국').toContainText('대한민국');
    });

    await step('Act: Step 2 — Click the product code 중복확인, then 바코드 중복확인', async () => {
      codeCheck = await form.checkCodeWithResponse();
      await form.checkBarcodeWithResponse();
      available = await form.seen(form.toastOf('skuForm.msg.barcodeAvailable'));
    });

    await step('Assert: Expected 2 — Both duplicate checks pass', async () => {
      expect(codeCheck.body?.ids ?? ['missing'], '[Expected 2] The product code check finds no duplicate').toHaveLength(0);
      await expect(form.skuGroupCodeInput, '[Expected 2] 상품코드 locks after its check').not.toBeEditable();
      expect(available, `[Expected 2] 바코드 중복확인 passes with ${t('skuForm.msg.barcodeAvailable')}`).toBe(true);
    });

    await step('Act: Step 3 — Click 저장 (Save)', async () => {
      try {
        if (await form.saveButton.isEnabled()) saved = await form.saveWithResponse();
      } finally {
        await world.trackGroupCode(data.groupCode);
      }
    });

    await step('Assert: Expected 3 — The save is rejected with WH-SKU_ALREADY_EXISTS: 이미 존재하는 SKU 입니다. - <SKU code>', async () => {
      expect(saved, '[Expected 3] 저장 could be clicked and sent the save call').not.toBeNull();
      expect(saved?.status ?? 0, '[Expected 3] The save call is rejected (4xx)').toBeGreaterThanOrEqual(400);
      expect(errorCode(saved?.body), '[Expected 3] The error code is WH-SKU_ALREADY_EXISTS').toBe('WH-SKU_ALREADY_EXISTS');
      await expect(form.pageAlert.filter({ hasText: message }).or(form.toast(message)), `[Expected 3] ${message} is shown`).toBeVisible();
    });

    await step('Act: Step 4 — Read the SKU 코드 (SKU code) field on that line', async () => {
      line.lockedAfterSave = !(await form.lineInput(0, 'skuCode').isEditable());
      if (await form.useOtherBarcodeButton.isVisible()) await form.useOtherBarcode();
      line.unlocked = await form.lineInput(0, 'skuCode').isEditable();
    });

    await step('Assert: Expected 4 — The form stays open; SKU 코드 is still locked and becomes editable only after 다른 바코드 사용', async () => {
      await expect(page, '[Expected 4] The create form stays open').toHaveURL(/\/commerce\/product-stock\/stock\/physical\/create/);
      expect(line.lockedAfterSave, '[Expected 4] SKU 코드 is still locked by the passed barcode check').toBe(true);
      expect(line.unlocked, `[Expected 4] SKU 코드 becomes editable after ${t('skuForm.btn.useOtherBarcode')}`).toBe(true);
    });
  });

  test('TC_US134_107 — Save is blocked when the product code check is missing', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormPage(page);
    const data = codes(world, 'T107');
    const writes = form.recordSkuWrites();
    let available = false;
    let blocked = { disabled: false, message: false };
    await tcMeta(
      'TC_US134_107',
      'Medium',
      TAGS,
      `On 현물 SKU 생성 filled with valid data and only 바코드 중복확인 run, 저장 is blocked and no record for the product code reaches the stock list. NEEDS CLARIFICATION in the TC (disabled 저장 vs. 상품코드 중복확인 버튼을 눌러주세요): either is accepted, the build disables 저장. HS code: a unique 10-digit value. ${CODE_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; product code and barcode unused; test data prepared', async () => {
      expect(data.groupCode, 'A fresh product code is prepared').toContain(world.tag);
    });

    await step('Act: Step 1 — Open 현물 SKU 생성 and fill every field with the test data', async () => {
      await form.openCreate('physical');
      await form.fillCommon(commonValues(world, data.groupCode));
      await form.fillLine(0, { skuCode: data.skuCode, exportSkuName: EXPORT_NAME, barcode: data.barcode });
    });

    await step('Assert: Expected 1 — The form accepts all entered values', async () => {
      await expect(form.skuGroupCodeInput, '[Expected 1] 상품코드 holds the test value').toHaveValue(data.groupCode);
      await expect(form.skuGroupCodeNameInput, '[Expected 1] 상품코드명 holds Demo Test Product').toHaveValue('Demo Test Product');
      await expect(form.lineInput(0, 'skuCode'), '[Expected 1] SKU 코드 holds the test value').toHaveValue(data.skuCode);
      await expect(form.lineInput(0, 'exportSkuName'), `[Expected 1] 수출용 SKU명 holds ${EXPORT_NAME}`).toHaveValue(EXPORT_NAME);
      await expect(form.lineInput(0, 'barcode'), '[Expected 1] 바코드 holds the test value').toHaveValue(data.barcode);
      await expect(form.manufacturerSelect, '[Expected 1] 제조사 holds Demo Manufacturer 1').toHaveValue(String(world.manufacturers.M1.id));
      await expect(form.field('skuForm.field.countryOfOrigin'), '[Expected 1] 원산지 shows 대한민국').toContainText('대한민국');
    });

    await step('Act: Step 2 — Click only 바코드 중복확인, leaving the product code check unpressed', async () => {
      await form.checkBarcodeWithResponse();
      available = await form.seen(form.toastOf('skuForm.msg.barcodeAvailable'));
    });

    await step('Assert: Expected 2 — The barcode duplicate check passes', async () => {
      expect(available, `[Expected 2] ${t('skuForm.msg.barcodeAvailable')} is shown`).toBe(true);
    });

    await step('Act: Step 3 — Try to click 저장 (Save)', async () => {
      try {
        const { disabled } = await form.trySave();
        blocked = { disabled, message: await form.toastOf('skuForm.err.codeCheckRequired').isVisible() };
      } finally {
        await world.trackGroupCode(data.groupCode);
      }
    });

    await step('Assert: Expected 3 — Saving is blocked (a disabled 저장 or 상품코드 중복확인 버튼을 눌러주세요)', async () => {
      expect(blocked.disabled || blocked.message, '[Expected 3] 저장 is disabled or 상품코드 중복확인 버튼을 눌러주세요 is shown').toBe(true);
      expect(writes, '[Expected 3] No save call is sent').toHaveLength(0);
    });

    await step('Act: Step 4 — Go back to the list and look for the product code', async () => {
      await list.open();
      await list.search('SKU_GROUP_CODE', data.groupCode);
    });

    await step('Assert: Expected 4 — No record for the product code appears in the list', async () => {
      await expect(list.table.getByRole('link', { name: data.groupCode, exact: true }), `[Expected 4] ${data.groupCode} is not in the list`).toHaveCount(0);
    });
  });

  test('TC_US134_108 — Save is blocked when the barcode check is missing', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormPage(page);
    const data = codes(world, 'T108');
    const writes = form.recordSkuWrites();
    let codeCheck: { status: number; body: { ids?: unknown[] } | null } = { status: 0, body: null };
    let blocked = { disabled: false, message: false };
    await tcMeta(
      'TC_US134_108',
      'Medium',
      TAGS,
      `On 현물 SKU 생성 filled with valid data and only the product code 중복확인 run (상품코드 locks), 저장 is blocked and no record for the product code reaches the stock list. NEEDS CLARIFICATION in the TC (disabled 저장 vs. 바코드 중복확인 버튼을 눌러주세요): either is accepted, the build disables 저장. ${LOCK_NOTE} HS code: a unique 10-digit value. ${CODE_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; product code and barcode unused; test data prepared', async () => {
      expect(data.groupCode, 'A fresh product code is prepared').toContain(world.tag);
    });

    await step('Act: Step 1 — Open 현물 SKU 생성 and fill every field with the test data', async () => {
      await form.openCreate('physical');
      await form.fillCommon(commonValues(world, data.groupCode));
      await form.fillLine(0, { skuCode: data.skuCode, exportSkuName: EXPORT_NAME, barcode: data.barcode });
    });

    await step('Assert: Expected 1 — The form accepts all entered values', async () => {
      await expect(form.skuGroupCodeInput, '[Expected 1] 상품코드 holds the test value').toHaveValue(data.groupCode);
      await expect(form.skuGroupCodeNameInput, '[Expected 1] 상품코드명 holds Demo Test Product').toHaveValue('Demo Test Product');
      await expect(form.lineInput(0, 'skuCode'), '[Expected 1] SKU 코드 holds the test value').toHaveValue(data.skuCode);
      await expect(form.lineInput(0, 'exportSkuName'), `[Expected 1] 수출용 SKU명 holds ${EXPORT_NAME}`).toHaveValue(EXPORT_NAME);
      await expect(form.lineInput(0, 'barcode'), '[Expected 1] 바코드 holds the test value').toHaveValue(data.barcode);
      await expect(form.manufacturerSelect, '[Expected 1] 제조사 holds Demo Manufacturer 1').toHaveValue(String(world.manufacturers.M1.id));
      await expect(form.field('skuForm.field.countryOfOrigin'), '[Expected 1] 원산지 shows 대한민국').toContainText('대한민국');
    });

    await step('Act: Step 2 — Click only the product code 중복확인 (Duplicate check)', async () => {
      codeCheck = await form.checkCodeWithResponse();
    });

    await step('Assert: Expected 2 — The product code check passes and the product code field locks', async () => {
      expect(codeCheck.body?.ids ?? ['missing'], '[Expected 2] The product code check finds no duplicate').toHaveLength(0);
      await expect(form.skuGroupCodeInput, '[Expected 2] 상품코드 is locked').not.toBeEditable();
    });

    await step('Act: Step 3 — Try to click 저장 (Save)', async () => {
      try {
        const { disabled } = await form.trySave();
        blocked = { disabled, message: await form.toastOf('skuForm.err.barcodeCheckRequired').isVisible() };
      } finally {
        await world.trackGroupCode(data.groupCode);
      }
    });

    await step('Assert: Expected 3 — Saving is blocked (a disabled 저장 or 바코드 중복확인 버튼을 눌러주세요)', async () => {
      expect(blocked.disabled || blocked.message, '[Expected 3] 저장 is disabled or 바코드 중복확인 버튼을 눌러주세요 is shown').toBe(true);
      expect(writes, '[Expected 3] No save call is sent').toHaveLength(0);
    });

    await step('Act: Step 4 — Go back to the list and look for the product code', async () => {
      await list.open();
      await list.search('SKU_GROUP_CODE', data.groupCode);
    });

    await step('Assert: Expected 4 — No record for the product code appears in the list', async () => {
      await expect(list.table.getByRole('link', { name: data.groupCode, exact: true }), `[Expected 4] ${data.groupCode} is not in the list`).toHaveCount(0);
    });
  });

  test('TC_US134_109 — The barcode check is blocked while a line misses its SKU code or barcode', async ({ page, world }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormPage(page);
    const checks = form.recordBarcodeChecks();
    const sku908 = uniqueCode(world.tag, 'T109S');
    const sku909 = uniqueCode(world.tag, 'T109S');
    const bc908 = uniqueCode(world.tag, 'T109B');
    const bc909 = uniqueCode(world.tag, 'T109B');
    let callsAfterIncomplete = -1;
    let available = false;
    await tcMeta(
      'TC_US134_109',
      'Medium',
      TAGS,
      `On 현물 SKU 생성 (옵션있음, 2 lines) with line 2's barcode left empty, 바코드 중복확인 does not finish, shows 상품코드와 바코드를 입력해주세요. and sends no POST /skus/check-duplication; once the barcode is typed the check runs and shows 모든 바코드 사용 가능합니다. Unique run values stand in for DEMO-SKU-908/909 and DEMO-BC-908/909. Nothing is saved. ${CODE_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–4 — Create mode with 옵션있음 and 2 lines; network calls are recorded; test data prepared', async () => {
      await form.openCreate('physical');
      await form.optionHas.check();
      await form.click(form.addButton, `${t('skuForm.btn.add')} button`);
      await expect(form.dataLines, 'The table has 2 lines').toHaveCount(2);
    });

    await step('Act: Step 1 — Fill the 2 lines with the test data', async () => {
      await form.fillLine(0, { skuCode: sku908, barcode: bc908 });
      await form.fillLine(1, { skuCode: sku909 });
    });

    await step('Assert: Expected 1 — The table shows both lines, the second with an empty barcode', async () => {
      await expect(form.dataLines, '[Expected 1] The table shows 2 lines').toHaveCount(2);
      await expect(form.lineInput(0, 'barcode'), '[Expected 1] Line 1 holds its barcode').toHaveValue(bc908);
      await expect(form.lineInput(1, 'skuCode'), '[Expected 1] Line 2 holds its SKU code').toHaveValue(sku909);
      await expect(form.lineInput(1, 'barcode'), '[Expected 1] Line 2 has an empty barcode').toHaveValue('');
    });

    await step('Act: Step 2 — Click 바코드 중복확인 (Barcode duplicate check)', async () => {
      await form.checkBarcode();
    });

    await step('Assert: Expected 2 — The check does not finish', async () => {
      await expect(form.checkBarcodeButton, '[Expected 2] 바코드 중복확인 is still shown').toBeVisible();
      await expect(form.useOtherBarcodeButton, `[Expected 2] ${t('skuForm.btn.useOtherBarcode')} does not appear`).toHaveCount(0);
    });

    await step('Act: Step 3 — Read the message that appears and the list of network calls', async () => {
      await expect(form.toasts.first(), 'A message appears').toBeVisible();
      callsAfterIncomplete = checks.length;
    });

    await step('Assert: Expected 3 — 상품코드와 바코드를 입력해주세요. is shown and no duplicate-check call is sent', async () => {
      await expect(form.toastOf('skuForm.err.barcodeIncomplete'), `[Expected 3] ${t('skuForm.err.barcodeIncomplete')} is shown`).toBeVisible();
      expect(callsAfterIncomplete, '[Expected 3] No POST /skus/check-duplication call is sent').toBe(0);
    });

    await step('Act: Step 4 — Type the barcode into line 2 and click 바코드 중복확인 again', async () => {
      await form.lineInput(1, 'barcode').fill(bc909);
      await form.checkBarcodeWithResponse();
      available = await form.seen(form.toastOf('skuForm.msg.barcodeAvailable'));
    });

    await step('Assert: Expected 4 — The check runs and shows 모든 바코드 사용 가능합니다.', async () => {
      expect(checks.length, '[Expected 4] The check call is sent this time').toBe(1);
      expect(available, `[Expected 4] ${t('skuForm.msg.barcodeAvailable')} is shown`).toBe(true);
    });
  });

  test('TC_US134_110 — The barcode check is blocked when no SKU line exists', async ({ page, world }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormPage(page);
    const data = codes(world, 'T110');
    let available = false;
    await tcMeta(
      'TC_US134_110',
      'Medium',
      TAGS,
      `On 현물 SKU 생성 (옵션있음) with the only line deleted, 바코드 중복확인 does not finish and shows the message SKU를 추가해주세요.; after 추가 and filling the new line the check runs and shows 모든 바코드 사용 가능합니다. The message is read from the toast (the empty table row carries the same words). Unique run values stand in for DEMO-SKU-910 / DEMO-BC-910. Nothing is saved. ${CODE_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–2 — Create mode with 옵션 설정 옵션있음', async () => {
      await form.openCreate('physical');
      await form.optionHas.check();
      await expect(form.dataLines, 'The table starts with 1 line').toHaveCount(1);
    });

    await step('Act: Step 1 — Delete the only SKU line with its own 삭제 (Delete) button', async () => {
      await form.click(form.lineDeleteButton(0), `${t('skuForm.btn.delete')} on line 1`);
    });

    await step('Assert: Expected 1 — The SKU line table is empty', async () => {
      await expect(form.dataLines, '[Expected 1] The table has no SKU line').toHaveCount(0);
      await expect(form.emptyLineRow, '[Expected 1] The table shows its empty row').toHaveText(t('skuForm.err.noSkuLine'));
    });

    await step('Act: Step 2 — Click 바코드 중복확인 (Barcode duplicate check)', async () => {
      await form.checkBarcode();
    });

    await step('Assert: Expected 2 — The check does not finish', async () => {
      await expect(form.checkBarcodeButton, '[Expected 2] 바코드 중복확인 is still shown').toBeVisible();
      await expect(form.useOtherBarcodeButton, `[Expected 2] ${t('skuForm.btn.useOtherBarcode')} does not appear`).toHaveCount(0);
    });

    await step('Act: Step 3 — Read the message that appears', async () => {
      await expect(form.toasts.first(), 'A message appears').toBeVisible();
    });

    await step('Assert: Expected 3 — The message shows SKU를 추가해주세요. (Please add a SKU.)', async () => {
      await expect(form.toastOf('skuForm.err.noSkuLine'), `[Expected 3] ${t('skuForm.err.noSkuLine')} is shown`).toBeVisible();
    });

    await step('Act: Step 4 — Click 추가 (Add), fill the new line, then click 바코드 중복확인 again', async () => {
      await form.click(form.addButton, `${t('skuForm.btn.add')} button`);
      await form.fillLine(0, { skuCode: data.skuCode, barcode: data.barcode });
      await form.checkBarcodeWithResponse();
      available = await form.seen(form.toastOf('skuForm.msg.barcodeAvailable'));
    });

    await step('Assert: Expected 4 — The check runs and shows 모든 바코드 사용 가능합니다.', async () => {
      expect(available, `[Expected 4] ${t('skuForm.msg.barcodeAvailable')} is shown`).toBe(true);
    });
  });

  test('TC_US134_111 — Option setting controls the SKU name column and the submitted value', async ({ page, world }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormPage(page);
    const data = codes(world, 'T111');
    let headers: string[] = [];
    let saved: { status: number; requestBody: Record<string, unknown> | null } = { status: 0, requestBody: null };
    const colCode = t('skuForm.col.skuCode');
    const colName = t('skuForm.col.skuName');
    const colExport = t('skuForm.col.exportSkuName');
    const colBarcode = t('skuForm.col.barcode');
    const colDelete = t('skuForm.col.delete');
    await tcMeta(
      'TC_US134_111',
      'Medium',
      TAGS,
      `On 현물 SKU 생성 the line table shows SKU 코드 · 수출용 SKU명 · 바코드 · 삭제 while 옵션없음, gains SKU명 between SKU 코드 and 수출용 SKU명 with 옵션있음, hides it again when switched back, and the POST /skus payload carries no SKU name for the line (the typed "Type A" is dropped). HS code: a unique 10-digit value. ${CODE_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–4 — Create mode with 옵션 설정 at its default 옵션없음; network calls are recorded; test data prepared', async () => {
      await form.openCreate('physical');
      await expect(form.optionNone, '옵션 설정 starts on 옵션없음').toBeChecked();
    });

    await step('Act: Step 1 — Read the column headers of the SKU line table while 옵션 설정 is 옵션없음', async () => {
      headers = await form.lineHeaderTexts();
    });

    await step('Assert: Expected 1 — SKU 코드, 수출용 SKU명, 바코드 and 삭제, with no SKU명 column', async () => {
      for (const name of [colCode, colExport, colBarcode, colDelete]) expect(headers, `[Expected 1] The table has the ${name} column`).toContain(name);
      expect(headers, `[Expected 1] The table has no ${colName} column`).not.toContain(colName);
      expect(headers, '[Expected 1] The columns read SKU 코드 · 수출용 SKU명 · 바코드 · 삭제').toEqual([colCode, colExport, colBarcode, colDelete]);
    });

    await step('Act: Step 2 — Change 옵션 설정 to 옵션있음 (Has options) and read the column headers again', async () => {
      await form.optionHas.check();
      headers = await form.lineHeaderTexts();
    });

    await step('Assert: Expected 2 — A SKU명 column sits between SKU 코드 and 수출용 SKU명', async () => {
      expect(headers, `[Expected 2] The table has a ${colName} column`).toContain(colName);
      expect(headers.indexOf(colName), `[Expected 2] ${colName} follows ${colCode}`).toBe(headers.indexOf(colCode) + 1);
      expect(headers.indexOf(colName), `[Expected 2] ${colName} precedes ${colExport}`).toBe(headers.indexOf(colExport) - 1);
    });

    await step('Act: Step 3 — Type "Type A" into SKU명, change 옵션 설정 back to 옵션없음 and read the column headers', async () => {
      await form.lineInput(0, 'skuName').fill('Type A');
      await form.optionNone.check();
      headers = await form.lineHeaderTexts();
    });

    await step('Assert: Expected 3 — The SKU명 column is hidden again', async () => {
      expect(headers, `[Expected 3] The ${colName} column is hidden`).not.toContain(colName);
    });

    await step('Act: Step 4 — Fill the remaining fields, press both duplicate checks, click 저장 and read the data sent', async () => {
      await form.fillCommon(commonValues(world, data.groupCode));
      await form.fillLine(0, { skuCode: data.skuCode, exportSkuName: EXPORT_NAME, barcode: data.barcode });
      await form.checkCodeWithResponse();
      await form.checkBarcodeWithResponse();
      await expect(form.toastOf('skuForm.msg.barcodeAvailable'), 'The barcode check passes').toBeVisible();
      try {
        saved = await form.saveWithResponse();
      } finally {
        await world.trackGroupCode(data.groupCode);
      }
    });

    await step('Assert: Expected 4 — The data sent has no SKU name value for the line; Type A is not sent', async () => {
      const lines = (saved.requestBody?.skus ?? []) as Array<{ name?: string }>;
      expect(lines, '[Expected 4] The payload carries the 1 SKU line').toHaveLength(1);
      expect(lines[0]?.name ?? '', '[Expected 4] The line has no SKU name value').toBe('');
      expect(JSON.stringify(saved.requestBody), '[Expected 4] "Type A" is not sent anywhere in the payload').not.toContain('Type A');
      expect(saved.status, '[Expected 4] The save call succeeds').toBeLessThan(300);
    });
  });

  test('TC_US134_112 — Add is blocked while Option setting is No options', async ({ page }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormPage(page);
    let count = -1;
    await tcMeta(
      'TC_US134_112',
      'Medium',
      TAGS,
      'On 현물 SKU 생성 with 옵션 설정 옵션없음 and 1 line, 추가 adds no line and shows 옵션설정 > 옵션없음으로 설정 시 1개의 SKU만 등록 가능합니다.; after switching to 옵션있음, 추가 adds a second line. Nothing is saved.',
    );

    await step('Arrange: Pre-condition 1–2 — Create mode with 옵션 설정 at its default 옵션없음 and exactly 1 line', async () => {
      await form.openCreate('physical');
      await expect(form.optionNone, '옵션 설정 starts on 옵션없음').toBeChecked();
    });

    await step('Act: Step 1 — Count the lines in the SKU line table', async () => {
      count = await form.dataLines.count();
    });

    await step('Assert: Expected 1 — The table has exactly 1 line', async () => {
      expect(count, '[Expected 1] The table has exactly 1 line').toBe(1);
    });

    await step('Act: Step 2 — Click 추가 (Add)', async () => {
      await form.click(form.addButton, `${t('skuForm.btn.add')} button`);
    });

    await step('Assert: Expected 2 — No line is added', async () => {
      await expect(form.dataLines, '[Expected 2] No line is added').toHaveCount(1);
    });

    await step('Act: Step 3 — Read the message that appears, then count the lines again', async () => {
      await expect(form.toasts.first(), 'A message appears').toBeVisible();
      count = await form.dataLines.count();
    });

    await step('Assert: Expected 3 — 옵션설정 > 옵션없음으로 설정 시 1개의 SKU만 등록 가능합니다. is shown and the table still has 1 line', async () => {
      await expect(form.toastOf('skuForm.err.singleLineOnly'), `[Expected 3] ${t('skuForm.err.singleLineOnly')} is shown`).toBeVisible();
      expect(count, '[Expected 3] The table still has 1 line').toBe(1);
    });

    await step('Act: Step 4 — Change 옵션 설정 to 옵션있음 (Has options) and click 추가 (Add)', async () => {
      await form.optionHas.check();
      await form.click(form.addButton, `${t('skuForm.btn.add')} button`);
    });

    await step('Assert: Expected 4 — A second line is added', async () => {
      await expect(form.dataLines, '[Expected 4] The table has 2 lines').toHaveCount(2);
    });
  });

  test('TC_US134_113 — Add creates an empty SKU line while Option setting is Has options', async ({ page, world }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormPage(page);
    const sku912 = uniqueCode(world.tag, 'T113S');
    let count = -1;
    await tcMeta(
      'TC_US134_113',
      'Medium',
      TAGS,
      `On 현물 SKU 생성 with 옵션있음 and 1 line holding a SKU code (unique run value instead of DEMO-SKU-912), each 추가 adds one empty line (SKU 코드, SKU명, 수출용 SKU명, 바코드 all empty) and keeps the first line's value; 2 more clicks give 4 lines. Nothing is saved. ${CODE_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–2 — Create mode with 옵션있음 and 1 line filled in with a SKU code', async () => {
      await form.openCreate('physical');
      await form.optionHas.check();
      await form.fillLine(0, { skuCode: sku912 });
    });

    await step('Act: Step 1 — Count the lines in the SKU line table', async () => {
      count = await form.dataLines.count();
    });

    await step('Assert: Expected 1 — The table has 1 line', async () => {
      expect(count, '[Expected 1] The table has 1 line').toBe(1);
    });

    await step('Act: Step 2 — Click 추가 (Add) below the table', async () => {
      await form.click(form.addButton, `${t('skuForm.btn.add')} button`);
    });

    await step('Assert: Expected 2 — A second line is added', async () => {
      await expect(form.dataLines, '[Expected 2] The table has 2 lines').toHaveCount(2);
    });

    await step('Act: Step 3 — Read the fields of the new line', async () => {
      await expect(form.lineInput(1, 'skuCode'), 'The new line is shown').toBeVisible();
    });

    await step('Assert: Expected 3 — Every field on the new line is empty and the first line still holds its SKU code', async () => {
      for (const column of ['skuCode', 'skuName', 'exportSkuName', 'barcode'] as const) {
        await expect(form.lineInput(1, column), `[Expected 3] ${column} of the new line is empty`).toHaveValue('');
      }
      await expect(form.lineInput(0, 'skuCode'), `[Expected 3] The first line still holds ${sku912}`).toHaveValue(sku912);
    });

    await step('Act: Step 4 — Click 추가 (Add) 2 more times and count the lines', async () => {
      await form.click(form.addButton, `${t('skuForm.btn.add')} button`);
      await form.click(form.addButton, `${t('skuForm.btn.add')} button`);
    });

    await step('Assert: Expected 4 — The table has 4 lines', async () => {
      await expect(form.dataLines, '[Expected 4] The table has 4 lines').toHaveCount(4);
    });
  });

  test('TC_US134_114 — The saved SKU name joins the product code name and the SKU name', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormPage(page);
    const data = codes(world, 'T114');
    const expectedHint =
      "실제 등록되는 SKU명은 '상품코드명 + SKU명'이 결합된 형태로 저장됩니다. 예: 상품코드명이 '후드집업', SKU명이 'S / M / L'인 경우 → 최종 SKU명은 후드집업 S, 후드집업 M, 후드집업 L로 저장됩니다.";
    const normalise = (text: string | null) => (text ?? '').replace(/["“”‘’]/g, "'").replace(/\s+/g, ' ').trim();
    let hint: string | null = null;
    let saved: { status: number } = { status: 0 };
    let cell = '';
    await tcMeta(
      'TC_US134_114',
      'High',
      TAGS,
      `On 현물 SKU 생성 the SKU명 header hint explains that the stored SKU name is "상품코드명 + SKU명"; saving product code name Demo Album [Vol.1] with SKU name Photocard (Type A) lists the SKU name Demo Album [Vol.1] Photocard (Type A) in 재고 관리. The SKU명 column only exists with 옵션있음, so Step 1 switches 옵션 설정 to 옵션있음 (the test data's option setting) before hovering. The hint is the native title attribute (compared with quotes and line breaks normalised — the UI wraps "상품코드명 + SKU명" in double quotes); the tooltip rendering itself is Not automated. HS code: a unique 10-digit value. ${CODE_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; product code and barcode unused; test data prepared', async () => {
      expect(data.barcode, 'A fresh barcode is prepared').toContain(world.tag);
    });

    await step('Act: Step 1 — Open 현물 SKU 생성 and hover over the SKU명 (SKU name) column header', async () => {
      await form.openCreate('physical');
      await form.optionHas.check();
      await form.skuNameHeaderHint.hover();
      hint = await form.skuNameHeaderHint.getAttribute('title');
    });

    await step("Assert: Expected 1 — The hint explains the stored SKU name is '상품코드명 + SKU명' with the 후드집업 S / M / L example", async () => {
      expect(normalise(hint), '[Expected 1] The SKU명 header hint has the TC wording').toBe(normalise(expectedHint));
    });

    await step('Act: Step 2 — Fill every field with the test data, press both duplicate checks and click 저장 (Save)', async () => {
      await form.fillCommon(commonValues(world, data.groupCode, 'Demo Album [Vol.1]'));
      await form.fillLine(0, { skuCode: data.skuCode, skuName: 'Photocard (Type A)', exportSkuName: EXPORT_NAME, barcode: data.barcode });
      await form.checkCodeWithResponse();
      await form.checkBarcodeWithResponse();
      await expect(form.toastOf('skuForm.msg.barcodeAvailable'), 'The barcode check passes').toBeVisible();
      try {
        saved = await form.saveWithResponse();
      } finally {
        await world.trackGroupCode(data.groupCode);
      }
    });

    await step('Assert: Expected 2 — The save goes through and returns to the list', async () => {
      expect(saved.status, '[Expected 2] The save call succeeds').toBeLessThan(300);
      await expect(page, '[Expected 2] The system returns to the list').toHaveURL(LIST_AFTER_CREATE);
    });

    await step('Act: Step 3 — Go back to the list, search by 상품코드 and read the SKU명 (SKU name) cell', async () => {
      await list.open();
      await list.search('SKU_GROUP_CODE', data.groupCode);
      cell = await list.cellText(list.row(data.skuCode), 'col.skuName');
    });

    await step('Assert: Expected 3 — The cell shows Demo Album [Vol.1] Photocard (Type A)', async () => {
      expect(cell, '[Expected 3] The SKU명 cell joins product code name and SKU name').toBe('Demo Album [Vol.1] Photocard (Type A)');
    });
  });

  test('TC_US134_115 — Product code, SKU code and barcode follow the character and length rules', async ({ page }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormPage(page);
    const VALUE_20 = 'DEMO-SKU-00000000012';
    const VALUE_21 = 'DEMO-SKU-000000000123';
    const values: Record<string, Record<string, string>> = {};
    const fields = () => [
      { name: t('skuForm.field.skuGroupCode'), input: form.skuGroupCodeInput },
      { name: t('skuForm.col.skuCode'), input: form.lineInput(0, 'skuCode') },
      { name: t('skuForm.col.barcode'), input: form.lineInput(0, 'barcode') },
    ];
    const enter = async (key: string, mode: 'type' | 'paste', text: string) => {
      values[key] = {};
      for (const field of fields()) {
        if (mode === 'type') await form.retype(field.input, text, field.name);
        else await form.pasteInto(field.input, text, field.name);
        values[key][field.name] = await field.input.inputValue();
      }
    };
    await tcMeta(
      'TC_US134_115',
      'Medium',
      TAGS,
      '상품코드, the line SKU 코드 and 바코드 on 현물 SKU 생성 drop spaces, @ and # whether typed or pasted (the filter strips the character and keeps the rest, e.g. DEMO SKU 0001 → DEMOSKU0001), take exactly 20 characters and stop there, and accept the underscore. Pasting uses the real clipboard (Ctrl+V). Nothing is saved.',
    );

    await step('Arrange: Pre-condition 1–3 — Create mode is open; the code test values are prepared', async () => {
      await form.openCreate('physical');
      expect(VALUE_20.length, 'The 20-character value has 20 characters').toBe(20);
      expect(VALUE_21.length, 'The 21-character value has 21 characters').toBe(21);
    });

    await step('Act: Step 1 — Type DEMO SKU 0001 into 상품코드, the line SKU 코드 and the line 바코드', async () => {
      await enter('space', 'type', 'DEMO SKU 0001');
    });

    await step('Assert: Expected 1 — None of the 3 fields takes a space; characters outside the set are blocked as typed', async () => {
      for (const field of fields()) {
        expect(values.space[field.name], `[Expected 1] ${field.name} took no space`).not.toContain(' ');
        expect(values.space[field.name], `[Expected 1] ${field.name} keeps only the allowed characters`).toBe('DEMOSKU0001');
      }
    });

    await step('Act: Step 2 — Type DEMO@SKU#0001 into the same 3 fields', async () => {
      await enter('symbols', 'type', 'DEMO@SKU#0001');
    });

    await step('Assert: Expected 2 — None of the 3 fields takes the at sign or the hash sign', async () => {
      for (const field of fields()) {
        expect(values.symbols[field.name], `[Expected 2] ${field.name} took no @`).not.toContain('@');
        expect(values.symbols[field.name], `[Expected 2] ${field.name} took no #`).not.toContain('#');
      }
    });

    await step('Act: Step 3 — Paste DEMO SKU 0001 from the clipboard into the same 3 fields', async () => {
      await enter('paste', 'paste', 'DEMO SKU 0001');
    });

    await step('Assert: Expected 3 — None of the 3 fields takes the pasted value with spaces', async () => {
      for (const field of fields()) {
        expect(values.paste[field.name], `[Expected 3] ${field.name} took no space from the paste`).not.toContain(' ');
        expect(values.paste[field.name], `[Expected 3] ${field.name} filters the paste by the typing rule`).toBe('DEMOSKU0001');
      }
    });

    await step('Act: Step 4 — Type the 20-character value into each of the 3 fields, then try the 21-character value', async () => {
      await enter('twenty', 'type', VALUE_20);
      await enter('twentyOne', 'type', VALUE_21);
    });

    await step('Assert: Expected 4 — Each field takes the full 20 characters and stops at 20 when a longer value is typed', async () => {
      for (const field of fields()) {
        expect(values.twenty[field.name], `[Expected 4] ${field.name} takes all 20 characters`).toBe(VALUE_20);
        expect(values.twentyOne[field.name], `[Expected 4] ${field.name} stops at 20 characters`).toBe(VALUE_21.slice(0, 20));
      }
    });

    await step('Act: Step 5 — Type DEMO_SKU_0001 into the same 3 fields', async () => {
      await enter('underscore', 'type', 'DEMO_SKU_0001');
    });

    await step('Assert: Expected 5 — Each of the 3 fields takes DEMO_SKU_0001 in full', async () => {
      for (const field of fields()) expect(values.underscore[field.name], `[Expected 5] ${field.name} takes the underscore`).toBe('DEMO_SKU_0001');
    });
  });

  test('TC_US134_116 — Product code name and SKU name follow the length and emoji rules', async ({ page }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormPage(page);
    const VALUE_150 = `Demo Album Vol.1 ${'abcdefghij'.repeat(15)}`.slice(0, 150);
    const EMOJI = 'Demo Album 🎵';
    const KOREAN = '데모 앨범 볼륨1 포토카드';
    const values: Record<string, Record<string, string>> = {};
    const fields = () => [
      { name: t('skuForm.field.skuGroupCodeName'), input: form.skuGroupCodeNameInput },
      { name: t('skuForm.col.skuName'), input: form.lineInput(0, 'skuName') },
    ];
    const record = async (key: string, action: (input: ReturnType<typeof fields>[number]) => Promise<void>) => {
      values[key] = {};
      for (const field of fields()) {
        await action(field);
        values[key][field.name] = await field.input.inputValue();
      }
    };
    await tcMeta(
      'TC_US134_116',
      'Medium',
      TAGS,
      '상품코드명 and the line SKU명 on 현물 SKU 생성 (옵션있음) take 150 characters and no more, refuse the emoji whether typed or pasted (the filter strips the emoji and keeps the rest), and take a Korean value. Pasting uses the real clipboard (Ctrl+V). Nothing is saved.',
    );

    await step('Arrange: Pre-condition 1–3 — Create mode with 옵션있음; the 150 / 151-character, Korean and emoji values are prepared', async () => {
      await form.openCreate('physical');
      await form.optionHas.check();
      expect(VALUE_150.length, 'The long value has exactly 150 characters').toBe(150);
    });

    await step('Act: Step 1 — Type the 150-character value into 상품코드명, then into the line SKU명', async () => {
      await record('full', (field) => form.retype(field.input, VALUE_150, field.name));
    });

    await step('Assert: Expected 1 — Both fields take all 150 characters', async () => {
      for (const field of fields()) expect(values.full[field.name], `[Expected 1] ${field.name} holds all 150 characters`).toBe(VALUE_150);
    });

    await step('Act: Step 2 — Try to type 1 more character into each field', async () => {
      await record('over', (field) => form.tryType(field.input, 'Z', field.name));
    });

    await step('Assert: Expected 2 — Neither field goes past 150 characters', async () => {
      for (const field of fields()) expect(values.over[field.name].length, `[Expected 2] ${field.name} stays at 150 characters`).toBe(150);
    });

    await step('Act: Step 3 — Type the emoji value into each field, then paste it from the clipboard into each field', async () => {
      await record('emojiTyped', (field) => form.retype(field.input, EMOJI, field.name));
      await record('emojiPasted', (field) => form.pasteInto(field.input, EMOJI, field.name));
    });

    await step('Assert: Expected 3 — Neither field takes the emoji, whether typed or pasted', async () => {
      for (const field of fields()) {
        expect(values.emojiTyped[field.name], `[Expected 3] ${field.name} refuses the typed emoji`).not.toContain('🎵');
        expect(values.emojiPasted[field.name], `[Expected 3] ${field.name} refuses the pasted emoji`).not.toContain('🎵');
      }
    });

    await step('Act: Step 4 — Type the Korean value into each field', async () => {
      await record('korean', (field) => form.retype(field.input, KOREAN, field.name));
    });

    await step('Assert: Expected 4 — Both fields take the Korean value', async () => {
      for (const field of fields()) expect(values.korean[field.name], `[Expected 4] ${field.name} takes ${KOREAN}`).toBe(KOREAN);
    });
  });

  test('TC_US134_117 — HS code accepts exactly 10 digits', async ({ page, world }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormPage(page);
    const data = codes(world, 'T117');
    const writes = form.recordSkuWrites();
    const validHs = uniqueHsCode();
    let dots = '';
    let letter = '';
    let ten = '';
    let eleven = '';
    let shortSave = { message: false, focused: false, writes: -1 };
    let saved: { status: number } = { status: 0 };
    await tcMeta(
      'TC_US134_117',
      'Medium',
      TAGS,
      `HS 코드 on 현물 SKU 생성 (every other field valid, both duplicate checks passed) drops dots and letters, takes 10 digits and stops there; 9 digits block 저장 with HS 코드는 숫자 10자리로 입력해주세요. and the cursor in HS 코드; 10 digits save and return to the list. Step 5 uses a unique 10-digit HS code instead of 6109101000. ${CODE_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–3 — Create mode with every other field filled and both duplicate checks passed', async () => {
      await form.openCreate('physical');
      await form.fillCommon(commonValues(world, data.groupCode, 'Demo Test Product', ''));
      await form.fillLine(0, { skuCode: data.skuCode, exportSkuName: EXPORT_NAME, barcode: data.barcode });
      await form.checkCodeWithResponse();
      await form.checkBarcodeWithResponse();
      await expect(form.toastOf('skuForm.msg.barcodeAvailable'), 'The barcode check passes').toBeVisible();
    });

    await step('Act: Step 1 — Type 6109.10.00 into HS 코드 (HS code)', async () => {
      await form.retype(form.hsCodeInput, '6109.10.00', t('skuForm.field.hsCode'));
      dots = await form.hsCodeInput.inputValue();
    });

    await step('Assert: Expected 1 — The field does not take the dots', async () => {
      expect(dots, '[Expected 1] HS 코드 took no dot').not.toContain('.');
      expect(dots, '[Expected 1] HS 코드 keeps the digits only').toBe('61091000');
    });

    await step('Act: Step 2 — Clear the field and type 610910100A', async () => {
      await form.retype(form.hsCodeInput, '610910100A', t('skuForm.field.hsCode'));
      letter = await form.hsCodeInput.inputValue();
    });

    await step('Assert: Expected 2 — The field does not take the letter A', async () => {
      expect(letter, '[Expected 2] HS 코드 took no letter').not.toContain('A');
      expect(letter, '[Expected 2] HS 코드 keeps the 9 digits').toBe('610910100');
    });

    await step('Act: Step 3 — Clear the field, type 6109101000 and try to type 1 more digit', async () => {
      await form.retype(form.hsCodeInput, '6109101000', t('skuForm.field.hsCode'));
      ten = await form.hsCodeInput.inputValue();
      await form.tryType(form.hsCodeInput, '1', t('skuForm.field.hsCode'));
      eleven = await form.hsCodeInput.inputValue();
    });

    await step('Assert: Expected 3 — The field takes all 10 digits and stops at 10', async () => {
      expect(ten, '[Expected 3] HS 코드 takes all 10 digits').toBe('6109101000');
      expect(eleven, '[Expected 3] Typing the 11th digit does nothing').toBe('6109101000');
    });

    await step('Act: Step 4 — Clear the field, type 610910100 and click 저장 (Save)', async () => {
      await form.retype(form.hsCodeInput, '610910100', t('skuForm.field.hsCode'));
      await form.trySave();
      shortSave = {
        message: await form.seen(form.toastOf('skuForm.err.hsCode'), 5_000),
        focused: await form.hsCodeInput.evaluate((el) => el === document.activeElement),
        writes: writes.length,
      };
    });

    await step('Assert: Expected 4 — Saving is blocked with HS 코드는 숫자 10자리로 입력해주세요. and the cursor jumps into the field', async () => {
      expect(shortSave.writes, '[Expected 4] No save call is sent').toBe(0);
      expect(shortSave.message, `[Expected 4] ${t('skuForm.err.hsCode')} is shown`).toBe(true);
      expect(shortSave.focused, '[Expected 4] The cursor is in HS 코드').toBe(true);
    });

    await step('Act: Step 5 — Change it to a valid 10-digit HS code and click 저장 (Save)', async () => {
      await form.retype(form.hsCodeInput, validHs, t('skuForm.field.hsCode'));
      try {
        saved = await form.saveWithResponse();
      } finally {
        await world.trackGroupCode(data.groupCode);
      }
    });

    await step('Assert: Expected 5 — The save goes through and returns to the list', async () => {
      expect(saved.status, '[Expected 5] The save call succeeds').toBeLessThan(300);
      await expect(page, '[Expected 5] The system returns to the list').toHaveURL(LIST_AFTER_CREATE);
    });
  });
});
