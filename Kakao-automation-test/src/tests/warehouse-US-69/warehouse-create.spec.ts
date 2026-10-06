import { Page } from '@playwright/test';
import { test, expect } from '@fixtures/base.fixture';
import { makeStep } from '@utils/step';
import { skipTc, tcMeta } from '@utils/tc-meta';
import { BIZ_PARTNER, WH_TEXT, warehouseName } from '@utils/warehouse.data';
import { FIELD, WarehouseFormPage } from '@pages/warehouse-form.page';
import { WarehouseApi } from '@api/warehouse.api';

/**
 * Form 창고 등록 (US069) — hiển thị field, validate, tự tính 분류, lưu. Nguồn TC: input/US069_TestCases_EN_v1.20.md —
 * mỗi dòng Steps N / Expected N map đúng 1 step `Act: Step N` / `Assert: Expected N`. TC lệch UI thật → assert theo UI,
 * ghi "Deviation from TC" trong description (quyết định 28/09).
 *
 * Dữ liệu: warehouse tạo qua UI được đăng ký dọn theo tên (`warehouseCleanup.trackName`) TRƯỚC khi bấm 저장 và bị xoá ở
 * teardown kèm 5 bucket. Validate phía client chặn request — "không lưu" được kiểm bằng việc không có POST nào được gửi.
 * Trên dev chỉ provider CJ대한통운(EgFlex) đang ACTIVE → 물류사 유형 của WMS không có CJ대한통운 (DT); TC cần DT bị skip.
 */
const TAGS = ['ui', 'warehouse', 'warehouse-create'];
const DT_UNAVAILABLE =
  'the 3PL provider CJ대한통운 (CJ Logistics DT) is not offered by the 물류사 유형 list on dev — only providers registered ACTIVE in 물류 제공업체 ' +
  'are listed (verified 28/09: the WMS list holds only CJ대한통운(EgFlex)); enabling the DT provider is outside this US and is not done on a shared environment.';
const ALLOWED_LATIN = /WMS|B2B|EgFlex|CJ|JSON|DT|3PL|WH\d+|CH\d+|WH-DEST-01_PARCEL|CUST\d+|\([A-Z]{2}\)/g;

/** Đếm request ghi (POST / PATCH) tới register 창고 — chứng minh validate client chặn lưu. */
function watchWarehouseWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/v1\/warehouses(\/\d+)?$/.test(request.url()) && ['POST', 'PATCH'].includes(request.method())) writes.push(`${request.method()} ${request.url()}`);
  });
  return writes;
}

/** Field bắt buộc tối thiểu hợp lệ (trừ 창고 유형) — mỗi test chỉ bỏ trống / đổi field mình kiểm. */
async function fillRequired(form: WarehouseFormPage, name: string, skip: Array<'bizPartner' | 'name' | 'addr' | 'zipCode' | 'number'> = []): Promise<void> {
  await form.fill({
    bizPartner: skip.includes('bizPartner') ? undefined : BIZ_PARTNER.name,
    name: skip.includes('name') ? undefined : name,
    addr: skip.includes('addr') ? undefined : 'Automation street 1',
    zipCode: skip.includes('zipCode') ? undefined : '21500',
    number: skip.includes('number') ? undefined : '032-1234-5678',
  });
}

/** Bấm 저장 trên form hợp lệ, chờ quay về list; trả chi tiết warehouse vừa tạo (tra theo tên qua API). */
async function saveNew(form: WarehouseFormPage, api: WarehouseApi, name: string) {
  const response = await form.saveAndWait();
  expect(response.status(), 'The create request is accepted').toBe(201);
  await expect(form.toast(WH_TEXT.toastCreated)).toBeVisible();
  const row = (await api.listAll({ name })).find((w) => w.name === name && !w.virtual);
  if (!row) throw new Error(`Created warehouse "${name}" not found through the API`);
  return (await api.get(row.id)).body;
}

async function expectRequiredMarker(form: WarehouseFormPage, label: string, tag: string): Promise<void> {
  await expect(form.fieldLabel(label), `${tag} ${label.replace(' *', '')} carries the mandatory marker (*)`).toHaveText(/ \*$/);
}

test.describe('[Create] 창고 등록 form — fields, validation, category and save', () => {
  test.describe.configure({ timeout: 120_000 });

  test('TC_US069_016 — 거래처 (Biz partner) field on the create screen', async ({ page, warehouseFormPage: form }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_016', 'Low', TAGS, '거래처 is displayed with the (*) marker, blank by default with placeholder "— 거래처 선택 —", and lists the biz partners. Deviation from TC: the dev biz partners differ from the TC examples (Kakao Entertainment · PlayWiz · Samsung Lions); the test asserts a non-empty list that contains the automation partner.');

    await step('Arrange: Pre-condition 1 — ADMIN opens 창고 등록', async () => {
      await form.openCreate();
    });

    await step('Act: Step 1 — Observe the 거래처 field', async () => {
      await form.bizPartnerSelect.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — Displayed, marked mandatory, blank with placeholder "— 거래처 선택 —"', async () => {
      await expect(form.bizPartnerSelect, '[Expected 1] 거래처 is displayed').toBeVisible();
      await expectRequiredMarker(form, FIELD.bizPartner, '[Expected 1]');
      await expect(form.bizPartnerSelect, '[Expected 1] 거래처 is blank by default').toHaveValue('');
      await expect(form.bizPartnerSelect.locator('option:checked'), '[Expected 1] Placeholder reads "— 거래처 선택 —"').toHaveText('— 거래처 선택 —');
    });

    await step('Act: Step 2 — Open the 거래처 selection list', async () => {
      await form.bizPartnerSelect.focus();
    });

    await step('Assert: Expected 2 — The biz partner list is displayed', async () => {
      expect(await form.bizPartnerSelect.locator('option').count(), '[Expected 2] The list holds biz partners besides the placeholder').toBeGreaterThan(1);
      await expect(form.bizPartnerSelect.locator('option', { hasText: BIZ_PARTNER.name }), `[Expected 2] ${BIZ_PARTNER.name} is listed`).toHaveCount(1);
    });
  });

  test('TC_US069_017 — 거래처 is required', async ({ page, warehouseFormPage: form }) => {
    const step = makeStep(page);
    const writes = watchWarehouseWrites(page);
    await tcMeta('TC_US069_017', 'High', TAGS, 'Saving without a 거래처 is blocked: the field is highlighted with "거래처를 선택하세요." and nothing is sent to the server.');

    await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록', async () => {
      await form.openCreate();
    });

    await step('Act: Step 1 — Do not choose a 거래처', async () => {
      await expect(form.bizPartnerSelect).toHaveValue('');
    });

    await step('Act: Step 2 — Enter the remaining required fields with valid values (판매자 물류)', async () => {
      await fillRequired(form, warehouseName('TC_US069_017'), ['bizPartner']);
      await form.typeSelect.selectOption({ label: WH_TEXT.typeSupplier });
    });

    await step('Act: Step 3 — Click 저장 (Save)', async () => {
      await form.saveExpectingValidation();
    });

    await step('Assert: Expected 3 — Not saved; 거래처 is highlighted with "거래처를 선택하세요."', async () => {
      await expect(form.bizPartnerSelect, '[Expected 3] 거래처 is highlighted').toHaveClass(/is-invalid/);
      await expect(form.fieldError(FIELD.bizPartner), '[Expected 3] Error "거래처를 선택하세요." is shown').toHaveText(WH_TEXT.validBizPartner);
      expect(writes, '[Expected 3] No create request is sent').toEqual([]);
      await expect(page, '[Expected 3] The create screen stays open').toHaveURL(/\/create$/);
    });
  });

  test('TC_US069_018 — The selected 거래처 is saved and displayed', async ({ page, warehouseFormPage: form, warehouseListPage: list, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_018', 'Critical', TAGS, 'The 거래처 chosen on create is saved and shown on both the list and the Detail/Edit screen. Data: the warehouse created through the UI is deleted afterwards.');
    const name = warehouseName('TC_US069_018');
    let id = 0;

    await step('Arrange: Pre-condition 1 — ADMIN has valid creation data and is on 창고 등록', async () => {
      await form.openCreate();
      warehouseCleanup.trackName(name);
    });

    await step(`Act: Step 1 — Choose 거래처 = ${BIZ_PARTNER.name}`, async () => {
      await form.bizPartnerSelect.selectOption({ label: BIZ_PARTNER.name });
    });

    await step('Act: Step 2 — Enter valid data and click 저장', async () => {
      await fillRequired(form, name, ['bizPartner']);
      await form.typeSelect.selectOption({ label: WH_TEXT.typeSupplier });
      id = (await saveNew(form, warehouseApi, name)).id;
    });

    let listPartner = '';
    await step('Act: Step 3 — Find the warehouse on 창고 목록, then reopen it in Detail/Edit', async () => {
      await list.open({ keyword: name });
      listPartner = (await (await list.cell(list.rowByName(name), '거래처')).textContent())?.trim() ?? '';
      await form.open(id);
    });

    await step('Assert: Expected 3 — 거래처 is saved and displayed on the list and on Detail/Edit', async () => {
      expect(listPartner, `[Expected 3] The list row reads ${BIZ_PARTNER.name}`).toBe(BIZ_PARTNER.name);
      await expect(form.bizPartnerSelect.locator('option:checked'), `[Expected 3] Detail/Edit shows ${BIZ_PARTNER.name}`).toHaveText(BIZ_PARTNER.name);
      expect(String((await warehouseApi.get(id)).body.bizPartnerId), '[Expected 3] The stored biz partner id matches').toBe(BIZ_PARTNER.id);
    });
  });

  test('TC_US069_020 — 창고명 (Warehouse name) field on the create screen', async ({ page, warehouseFormPage: form }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_020', 'Low', TAGS, '창고명 is displayed with the (*) marker, blank by default, placeholder "예: 인천 물류센터".');

    await step('Arrange: Pre-condition 1 — ADMIN opens 창고 등록', async () => {
      await form.openCreate();
    });

    await step('Act: Step 1 — Observe the 창고명 field', async () => {
      await form.nameInput.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — Displayed, marked mandatory, blank with placeholder "예: 인천 물류센터"', async () => {
      await expect(form.nameInput, '[Expected 1] 창고명 is displayed').toBeVisible();
      await expectRequiredMarker(form, FIELD.name, '[Expected 1]');
      await expect(form.nameInput, '[Expected 1] 창고명 is blank by default').toHaveValue('');
      await expect(form.nameInput, '[Expected 1] Placeholder reads "예: 인천 물류센터"').toHaveAttribute('placeholder', '예: 인천 물류센터');
    });
  });

  test('TC_US069_021 — 창고명 is required', async ({ page, warehouseFormPage: form }) => {
    const step = makeStep(page);
    const writes = watchWarehouseWrites(page);
    await tcMeta('TC_US069_021', 'High', TAGS, 'Saving with a blank 창고명 is blocked: the field is highlighted with "창고명을 입력하세요." and nothing is sent.');

    await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록', async () => {
      await form.openCreate();
    });

    await step('Act: Step 1 — Leave 창고명 blank', async () => {
      await expect(form.nameInput).toHaveValue('');
    });

    await step('Act: Step 2 — Enter the remaining required fields with valid values', async () => {
      await fillRequired(form, '', ['name']);
      await form.typeSelect.selectOption({ label: WH_TEXT.typeSupplier });
    });

    await step('Act: Step 3 — Click 저장 (Save)', async () => {
      await form.saveExpectingValidation();
    });

    await step('Assert: Expected 3 — Not saved; 창고명 is highlighted with "창고명을 입력하세요."', async () => {
      await expect(form.nameInput, '[Expected 3] 창고명 is highlighted').toHaveClass(/is-invalid/);
      await expect(form.fieldError(FIELD.name), '[Expected 3] Error "창고명을 입력하세요." is shown').toHaveText(WH_TEXT.validName);
      expect(writes, '[Expected 3] No create request is sent').toEqual([]);
    });
  });

  test('TC_US069_022 — A valid 창고명 is saved and displayed', async ({ page, warehouseFormPage: form, warehouseListPage: list, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_022', 'Critical', TAGS, 'A valid 창고명 (< 100 characters) is saved and shown on both the list and Detail/Edit. Data: the created warehouse is deleted afterwards.');
    const name = warehouseName('TC_US069_022', '창고 테스트');
    let id = 0;

    await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록', async () => {
      await form.openCreate();
      warehouseCleanup.trackName(name);
    });

    await step('Act: Step 1 — Enter a valid 창고명 shorter than 100 characters', async () => {
      await form.nameInput.fill(name);
    });

    await step('Act: Step 2 — Save the warehouse with all valid data', async () => {
      await fillRequired(form, name);
      await form.typeSelect.selectOption({ label: WH_TEXT.typeSupplier });
      id = (await saveNew(form, warehouseApi, name)).id;
    });

    let listed = 0;
    await step('Act: Step 3 — Open 창고 목록 and the Detail/Edit screen to check', async () => {
      await list.open({ keyword: name });
      listed = await list.rowByName(name).count();
      await form.open(id);
    });

    await step('Assert: Expected 3 — 창고명 is saved and displayed on the list and Detail/Edit', async () => {
      expect(listed, '[Expected 3] The list shows the exact 창고명').toBe(1);
      await expect(form.nameInput, '[Expected 3] Detail/Edit shows the exact 창고명').toHaveValue(name);
    });
  });

  test('TC_US069_023 — 창고명 is limited to 100 characters', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_023', 'Medium', TAGS, 'Typing 101 characters into 창고명 keeps only the first 100, and saving succeeds with that value. Data: the created warehouse is deleted afterwards.');
    const typed = warehouseName('TC_US069_023').padEnd(101, 'N');
    const kept = typed.slice(0, 100);
    let savedName = '';

    await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록', async () => {
      await form.openCreate();
      warehouseCleanup.trackName(kept);
    });

    await step('Act: Step 1 — Enter exactly 101 characters into 창고명 and the remaining valid data', async () => {
      await fillRequired(form, typed);
      await form.typeSelect.selectOption({ label: WH_TEXT.typeSupplier });
    });

    await step('Assert: Expected 1 — The value is truncated to 100 characters', async () => {
      await expect(form.nameInput, '[Expected 1] 창고명 keeps exactly the first 100 characters').toHaveValue(kept);
    });

    await step('Act: Step 2 — Click 저장 (Save)', async () => {
      savedName = (await saveNew(form, warehouseApi, kept)).name;
    });

    await step('Assert: Expected 2 — Saved successfully with the value as entered (100 characters)', async () => {
      expect(savedName, '[Expected 2] The stored 창고명 is the 100-character value').toBe(kept);
    });
  });

  test('TC_US069_024 — A spaces-only 창고명 does not break the UI and is rejected', async ({ page, warehouseFormPage: form }) => {
    const step = makeStep(page);
    const writes = watchWarehouseWrites(page);
    await tcMeta('TC_US069_024', 'Low', TAGS, 'A 창고명 of spaces only keeps the form intact and, on 저장, shows "창고명을 입력하세요." without creating a warehouse.');

    await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록 with the other required fields valid', async () => {
      await form.openCreate();
      await fillRequired(form, '', ['name']);
      await form.typeSelect.selectOption({ label: WH_TEXT.typeSupplier });
    });

    await step('Act: Step 1 — Enter only spaces into 창고명', async () => {
      await form.nameInput.fill('     ');
    });

    await step('Assert: Expected 1 — The interface does not break', async () => {
      await expect(form.nameInput, '[Expected 1] The 창고명 input is still usable').toBeEditable();
      await expect(form.saveButton, '[Expected 1] 저장 is still available').toBeEnabled();
      await expect(form.pageError, '[Expected 1] No error banner is shown').toHaveCount(0);
    });

    await step('Act: Step 2 — Click 저장 (Save)', async () => {
      await form.saveExpectingValidation();
    });

    await step('Act: Step 3 — Observe the UI and the data after the operation', async () => {
      await form.fieldError(FIELD.name).scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — "창고명을 입력하세요." is shown and no warehouse is created', async () => {
      await expect(form.fieldError(FIELD.name), '[Expected 3] Error "창고명을 입력하세요." is shown').toHaveText(WH_TEXT.validName);
      expect(writes, '[Expected 3] No create request is sent').toEqual([]);
    });
  });

  test('TC_US069_025 — 창고 유형 (Warehouse type) field on the create screen', async ({ page, warehouseFormPage: form }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_025', 'Low', TAGS, '창고 유형 is displayed with the (*) marker, blank with placeholder "— 창고 유형 선택 —", and offers exactly 판매자 물류 and 플랫폼 물류.');

    await step('Arrange: Pre-condition 1 — ADMIN opens 창고 등록', async () => {
      await form.openCreate();
    });

    await step('Act: Step 1 — Observe the 창고 유형 field', async () => {
      await form.typeSelect.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — Displayed, marked mandatory, blank with placeholder "— 창고 유형 선택 —"', async () => {
      await expect(form.typeSelect, '[Expected 1] 창고 유형 is displayed').toBeVisible();
      await expectRequiredMarker(form, FIELD.type, '[Expected 1]');
      await expect(form.typeSelect, '[Expected 1] 창고 유형 is blank by default').toHaveValue('');
      await expect(form.typeSelect.locator('option:checked'), '[Expected 1] Placeholder reads "— 창고 유형 선택 —"').toHaveText('— 창고 유형 선택 —');
    });

    await step('Act: Step 2 — Open the 창고 유형 selection list', async () => {
      await form.typeSelect.focus();
    });

    await step('Assert: Expected 2 — Exactly two options: 판매자 물류 and 플랫폼 물류', async () => {
      await expect(form.typeSelect.locator('option:not([value=""])'), '[Expected 2] Options read 판매자 물류 · 플랫폼 물류').toHaveText([WH_TEXT.typeSupplier, WH_TEXT.typePlatform]);
    });
  });

  test('TC_US069_026 — 창고 유형 is required', async ({ page, warehouseFormPage: form }) => {
    const step = makeStep(page);
    const writes = watchWarehouseWrites(page);
    await tcMeta('TC_US069_026', 'High', TAGS, 'Saving without a 창고 유형 is blocked with "창고 유형을 선택하세요." and nothing is sent. Deviation from TC: Expected 1 ("does not allow saving") can only be observed once 저장 is clicked, so it is asserted after Step 3, together with Expected 3.');

    await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록', async () => {
      await form.openCreate();
    });

    await step('Act: Step 1 — Do not select a 창고 유형', async () => {
      await expect(form.typeSelect).toHaveValue('');
    });

    await step('Act: Step 2 — Enter the remaining required fields with valid values', async () => {
      await fillRequired(form, warehouseName('TC_US069_026'));
    });

    await step('Act: Step 3 — Click 저장 (Save)', async () => {
      await form.saveExpectingValidation();
    });

    await step('Assert: Expected 1 — The system does not allow saving', async () => {
      expect(writes, '[Expected 1] No create request is sent').toEqual([]);
      await expect(page, '[Expected 1] The create screen stays open').toHaveURL(/\/create$/);
    });

    await step('Assert: Expected 3 — 창고 유형 is highlighted with "창고 유형을 선택하세요."', async () => {
      await expect(form.typeSelect, '[Expected 3] 창고 유형 is highlighted').toHaveClass(/is-invalid/);
      await expect(form.fieldError(FIELD.type), '[Expected 3] Error "창고 유형을 선택하세요." is shown').toHaveText(WH_TEXT.validType);
    });
  });

  test('TC_US069_027 — Fields shown for 판매자 물류 (Supplier warehouse)', async ({ page, warehouseFormPage: form }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_027', 'Medium', TAGS, 'With 판매자 물류 the form shows 국가, 도시, 우편번호, 전화번호, 분류 (자동), 거리(상세) 주소, 주/도 and 추가 주소, and hides 물류 유형 and 물류사 유형.');
    const shown = [FIELD.country, FIELD.city, FIELD.zipCode, FIELD.phone, FIELD.category, FIELD.addr, FIELD.state, FIELD.detailAddr];

    await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록', async () => {
      await form.openCreate();
    });

    await step('Act: Step 1 — Select 창고 유형 = 판매자 물류 (Supplier warehouse)', async () => {
      await form.typeSelect.selectOption({ label: WH_TEXT.typeSupplier });
    });

    await step('Assert: Expected 1 — Address/phone/category fields shown; 물류 유형 and 물류사 유형 hidden', async () => {
      for (const label of shown) await expect(form.field(label), `[Expected 1] ${label} is displayed`).toBeVisible();
      await expect(form.field(FIELD.logisticsType), '[Expected 1] 물류 유형 is not displayed').toHaveCount(0);
      await expect(form.field(FIELD.channel), '[Expected 1] 물류사 유형 is not displayed').toHaveCount(0);
    });
  });

  test('TC_US069_028 — Logistics fields shown for 플랫폼 물류 (Platform warehouse)', async ({ page, warehouseFormPage: form }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_028', 'Medium', TAGS, 'With 플랫폼 물류 the form shows the address/phone/category fields and, in addition, 물류 유형 and 물류사 유형.');
    const shown = [FIELD.country, FIELD.city, FIELD.zipCode, FIELD.phone, FIELD.category, FIELD.addr, FIELD.state, FIELD.detailAddr, FIELD.logisticsType, FIELD.channel];

    await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록', async () => {
      await form.openCreate();
    });

    await step('Act: Step 1 — Select 창고 유형 = 플랫폼 물류 (Platform warehouse)', async () => {
      await form.typeSelect.selectOption({ label: WH_TEXT.typePlatform });
    });

    await step('Assert: Expected 1 — All fields incl. 물류 유형 and 물류사 유형 are displayed', async () => {
      for (const label of shown) await expect(form.field(label), `[Expected 1] ${label} is displayed`).toBeVisible();
    });
  });

  test('TC_US069_030 — Create a 판매자 물류 (Supplier) warehouse successfully', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_030', 'Critical', TAGS, 'A Supplier warehouse shows 분류 = "—" and is created with the success toast and 상태 = 활성. Data: the created warehouse is deleted afterwards.');
    const name = warehouseName('TC_US069_030');
    let status = '';

    await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록', async () => {
      await form.openCreate();
      warehouseCleanup.trackName(name);
    });

    await step(`Act: Step 1 — Select 거래처 = ${BIZ_PARTNER.name}`, async () => {
      await form.bizPartnerSelect.selectOption({ label: BIZ_PARTNER.name });
    });

    await step('Act: Step 2 — Enter a valid 창고명, 국가 (default 대한민국) and 거리(상세) 주소', async () => {
      await form.fill({ name, addr: 'Automation street 30' });
    });

    await step('Act: Step 3 — Select 창고 유형 = 판매자 물류 (Supplier warehouse)', async () => {
      await form.typeSelect.selectOption({ label: WH_TEXT.typeSupplier });
    });

    await step('Assert: Expected 3 — 분류 reads "—"', async () => {
      await expect(form.categoryInput, '[Expected 3] 분류 reads "—"').toHaveValue(WH_TEXT.none);
    });

    await step('Act: Step 4 — Enter the other required fields and click 저장', async () => {
      await form.fill({ zipCode: '21500', number: '032-1234-5678' });
      status = (await saveNew(form, warehouseApi, name)).status;
    });

    await step('Assert: Expected 4 — Success message shown and the warehouse is 활성 (Active)', async () => {
      await expect(form.toast(WH_TEXT.toastCreated), '[Expected 4] Toast "창고가 등록되었습니다 — 즉시 적용됩니다." is shown').toBeVisible();
      expect(status, '[Expected 4] The warehouse is created with 상태 = ACTIVE').toBe('ACTIVE');
    });
  });

  test('TC_US069_031 — Switching 플랫폼 물류 → 판매자 물류 clears the logistics data', async ({ page, warehouseFormPage: form }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US069_031',
      'High',
      TAGS,
      'After entering 물류 유형, 물류사 유형 and the CJ codes on a Platform warehouse, switching to 판매자 물류 hides those fields, clears their ' +
        'values and recalculates 분류 to "—". Deviation from TC: Expected 1 repeats Expected 3 verbatim; after Step 1 (select 플랫폼 물류) the ' +
        'real screen SHOWS the Platform fields, which is what Expected 1 asserts. "Values cleared" is checked by switching back to 플랫폼 물류 ' +
        'within Step 3 and reading the now-empty fields.',
    );
    const seen = { labelsAsSupplier: [] as string[], categoryAsSupplier: '', logisticsTypeBack: '', channelBack: '' };

    await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록', async () => {
      await form.openCreate();
    });

    await step('Act: Step 1 — Select 창고 유형 = 플랫폼 물류 (Platform warehouse)', async () => {
      await form.typeSelect.selectOption({ label: WH_TEXT.typePlatform });
    });

    await step('Assert: Expected 1 — The Platform fields 물류 유형 and 물류사 유형 are displayed (see Deviation)', async () => {
      await expect(form.logisticsTypeSelect, '[Expected 1] 물류 유형 is displayed').toBeVisible();
      await expect(form.channelSelect, '[Expected 1] 물류사 유형 is displayed').toBeVisible();
    });

    await step('Act: Step 2 — Enter 물류 유형 = WMS, 물류사 유형 = CJ대한통운(EgFlex) and the CJ codes', async () => {
      await form.fill({ logisticsType: 'WMS', channel: WH_TEXT.channelEgFlex, cjWarehouseCode: 'A12', cjChannelCode: 'CH01' });
      await expect(form.categoryInput).toHaveValue(WH_TEXT.categoryCj);
    });

    await step('Act: Step 3 — Change 창고 유형 to 판매자 물류 (Supplier warehouse)', async () => {
      await form.typeSelect.selectOption({ label: WH_TEXT.typeSupplier });
      seen.labelsAsSupplier = await form.visibleFieldLabels();
      seen.categoryAsSupplier = await form.categoryInput.inputValue();
      await form.typeSelect.selectOption({ label: WH_TEXT.typePlatform });
      seen.logisticsTypeBack = await form.logisticsTypeSelect.inputValue();
      seen.channelBack = await form.channelSelect.inputValue();
      await form.typeSelect.selectOption({ label: WH_TEXT.typeSupplier });
    });

    await step('Assert: Expected 3 — Platform/CJ fields hidden, their values cleared, 분류 recalculated to "—"', async () => {
      for (const label of [FIELD.logisticsType, FIELD.channel, FIELD.cjWarehouseCode, FIELD.cjChannelCode, FIELD.logisticsInfo]) {
        expect(seen.labelsAsSupplier, `[Expected 3] ${label} is hidden`).not.toContain(label);
      }
      expect(seen.categoryAsSupplier, '[Expected 3] 분류 is recalculated to "—"').toBe(WH_TEXT.none);
      expect(seen.logisticsTypeBack, '[Expected 3] 물류 유형 value was cleared').toBe('');
      expect(seen.channelBack, '[Expected 3] 물류사 유형 value was cleared').toBe('');
    });
  });

  test('TC_US069_032 — 국가 (Country) field display and option list', async ({ page, warehouseFormPage: form }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US069_032',
      'Medium',
      TAGS,
      '국가 is displayed with the (*) marker and defaults to 대한민국 (KR). The list holds 249 countries: 대한민국, 미국, 일본, 중국, 대만, 홍콩, ' +
        '인도네시아 and 브라질 are pinned at the top, the rest follow Korean alphabetical order; typing "viet" shows 베트남 (Viet Nam).',
    );
    const PINNED = ['KR', 'US', 'JP', 'CN', 'TW', 'HK', 'ID', 'BR'];
    let options: string[] = [];
    let restSorted = false;

    await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록', async () => {
      await form.openCreate();
    });

    await step('Act: Step 1 — Observe the 국가 field', async () => {
      await form.countryCombo.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — Displayed, marked mandatory, default 대한민국 (KR)', async () => {
      await expect(form.field(FIELD.country), '[Expected 1] 국가 is displayed').toBeVisible();
      await expectRequiredMarker(form, FIELD.country, '[Expected 1]');
      await expect(form.countryValue, '[Expected 1] Default value is 대한민국 (KR)').toHaveText(/대한민국 \(KR\)/);
    });

    await step('Act: Step 2 — Open the 국가 selection list', async () => {
      await form.openCountryMenu();
      options = await form.countryMenu.getByRole('option').allInnerTexts();
      restSorted = await page.evaluate((labels) => {
        const collator = new Intl.Collator('ko', { usage: 'sort', sensitivity: 'base', numeric: true, ignorePunctuation: true });
        const names = labels.map((l) => l.replace(/^\S+\s/, '').replace(/\s\([A-Z]{2}\)$/, ''));
        return names.every((n, i) => i === 0 || collator.compare(names[i - 1], n) <= 0);
      }, options.slice(PINNED.length));
    });

    await step('Assert: Expected 2 — 249 countries, the 8 pinned first, the rest in Korean alphabetical order', async () => {
      expect(options.length, '[Expected 2] The list holds 249 countries').toBe(249);
      PINNED.forEach((code, i) => expect(options[i], `[Expected 2] Position ${i + 1} is pinned country ${code}`).toMatch(new RegExp(`\\(${code}\\)$`)));
      expect(restSorted, '[Expected 2] The remaining countries follow Korean alphabetical order').toBe(true);
    });

    await step('Act: Step 3 — Type "viet" to search', async () => {
      await form.countryCombo.fill('viet');
    });

    await step('Assert: Expected 3 — The list shows 베트남 (Viet Nam)', async () => {
      await expect(form.countryMenu.getByRole('option'), '[Expected 3] Only 베트남 (VN) matches "viet"').toHaveText([/베트남 \(VN\)$/]);
    });
  });

  test('TC_US069_033 — 국가 is required and cannot be cleared', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_033', 'High', TAGS, '국가 cannot be cleared (it always holds a valid value, default 대한민국), so 저장 succeeds with the default. Data: the created warehouse is deleted afterwards.');
    const name = warehouseName('TC_US069_033');
    let country = '';

    await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록', async () => {
      await form.openCreate();
      warehouseCleanup.trackName(name);
    });

    await step('Act: Step 1 — Try to delete the 국가 value (Backspace in the field)', async () => {
      await form.countryCombo.click();
      await form.countryCombo.press('Backspace');
      await page.keyboard.press('Escape');
    });

    await step('Assert: Expected 1 — 국가 cannot be cleared', async () => {
      await expect(form.countryValue, '[Expected 1] 국가 still reads 대한민국 (KR)').toHaveText(/대한민국 \(KR\)/);
    });

    await step('Act: Step 2 — Enter valid data for the remaining fields', async () => {
      await fillRequired(form, name);
      await form.typeSelect.selectOption({ label: WH_TEXT.typeSupplier });
    });

    await step('Act: Step 3 — Click 저장 (Save)', async () => {
      country = (await saveNew(form, warehouseApi, name)).country;
    });

    await step('Assert: Expected 3 — 국가 keeps its valid default and 저장 succeeds', async () => {
      await expect(form.toast(WH_TEXT.toastCreated), '[Expected 3] The create succeeds').toBeVisible();
      expect(country, '[Expected 3] The stored 국가 is KR').toBe('KR');
    });
  });

  test('TC_US069_034 — 거리(상세) 주소 (Address) field display', async ({ page, warehouseFormPage: form }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_034', 'Low', TAGS, '거리(상세) 주소 is displayed with the (*) marker, blank by default, placeholder "예: 테헤란로 123".');

    await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록', async () => {
      await form.openCreate();
    });

    await step('Act: Step 1 — Observe the 거리(상세) 주소 field', async () => {
      await form.addrInput.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — Displayed, marked mandatory, blank with placeholder "예: 테헤란로 123"', async () => {
      await expect(form.addrInput, '[Expected 1] 거리(상세) 주소 is displayed').toBeVisible();
      await expectRequiredMarker(form, FIELD.addr, '[Expected 1]');
      await expect(form.addrInput, '[Expected 1] Blank by default').toHaveValue('');
      await expect(form.addrInput, '[Expected 1] Placeholder reads "예: 테헤란로 123"').toHaveAttribute('placeholder', '예: 테헤란로 123');
    });
  });

  test('TC_US069_035 — 거리(상세) 주소 is required', async ({ page, warehouseFormPage: form }) => {
    const step = makeStep(page);
    const writes = watchWarehouseWrites(page);
    await tcMeta('TC_US069_035', 'High', TAGS, 'Saving with a blank address is blocked with "주소를 입력하세요." and nothing is sent.');

    await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록', async () => {
      await form.openCreate();
    });

    await step('Act: Step 1 — Leave the address blank', async () => {
      await expect(form.addrInput).toHaveValue('');
    });

    await step('Act: Step 2 — Enter valid data for the remaining fields', async () => {
      await fillRequired(form, warehouseName('TC_US069_035'), ['addr']);
      await form.typeSelect.selectOption({ label: WH_TEXT.typeSupplier });
    });

    await step('Act: Step 3 — Click 저장 (Save)', async () => {
      await form.saveExpectingValidation();
    });

    await step('Assert: Expected 3 — Not saved; error "주소를 입력하세요."', async () => {
      await expect(form.fieldError(FIELD.addr), '[Expected 3] Error "주소를 입력하세요." is shown').toHaveText(WH_TEXT.validAddr);
      expect(writes, '[Expected 3] No create request is sent').toEqual([]);
    });
  });

  test('TC_US069_036 — 국가 and 거리(상세) 주소 are saved and displayed', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_036', 'Critical', TAGS, 'A chosen 국가 (일본 JP) and address are saved and shown again on Detail/Edit. Data: the created warehouse is deleted afterwards.');
    const name = warehouseName('TC_US069_036');
    const address = 'Shibuya 1-2-3';
    let saved = { id: 0, country: '', addr: '' };

    await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록 with the other fields valid', async () => {
      await form.openCreate();
      warehouseCleanup.trackName(name);
      await fillRequired(form, name, ['addr']);
      await form.typeSelect.selectOption({ label: WH_TEXT.typeSupplier });
    });

    await step('Act: Step 1 — Select a valid 국가 (일본 JP)', async () => {
      await form.selectCountry('일본', /일본 \(JP\)$/);
    });

    await step('Act: Step 2 — Enter a valid 거리(상세) 주소', async () => {
      await form.addrInput.fill(address);
    });

    await step('Act: Step 3 — Click 저장 (Save)', async () => {
      saved = await saveNew(form, warehouseApi, name);
    });

    await step('Assert: Expected 3 — 국가 and 거리(상세) 주소 are saved', async () => {
      expect(saved.country, '[Expected 3] Stored 국가 is JP').toBe('JP');
      expect(saved.addr, `[Expected 3] Stored address is "${address}"`).toBe(address);
    });

    await step('Act: Step 4 — Reopen the Warehouse Detail/Edit screen', async () => {
      await form.open(saved.id);
    });

    await step('Assert: Expected 4 — 국가 and 거리(상세) 주소 are displayed correctly', async () => {
      await expect(form.countryValue, '[Expected 4] 국가 reads 일본 (JP)').toHaveText(/일본 \(JP\)/);
      await expect(form.addrInput, `[Expected 4] Address reads "${address}"`).toHaveValue(address);
    });
  });

  for (const optional of [
    { tc: 'TC_US069_037', label: FIELD.city, name: '도시 (City)', placeholder: '예: 인천', input: (f: WarehouseFormPage) => f.cityInput, key: 'city' as const },
    { tc: 'TC_US069_038', label: FIELD.state, name: '주/도 (State/Province)', placeholder: '예: 인천광역시', input: (f: WarehouseFormPage) => f.stateInput, key: 'stateOrProvince' as const },
    { tc: 'TC_US069_042', label: FIELD.detailAddr, name: '추가 주소 (Detail address)', placeholder: '예: 3동 2층', input: (f: WarehouseFormPage) => f.detailAddrInput, key: 'detailAddr' as const },
  ]) {
    test(`${optional.tc} — ${optional.name} is optional`, async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
      const step = makeStep(page);
      await tcMeta(optional.tc, 'Medium', TAGS, `${optional.name} is displayed blank with placeholder "${optional.placeholder}" and no mandatory marker, and saving with it blank succeeds. Data: the created warehouse is deleted afterwards.`);
      const name = warehouseName(optional.tc);
      let stored: unknown = 'unset';

      await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록', async () => {
        await form.openCreate();
        warehouseCleanup.trackName(name);
      });

      await step(`Act: Step 1 — Observe the ${optional.name} field`, async () => {
        await optional.input(form).scrollIntoViewIfNeeded();
      });

      await step(`Assert: Expected 1 — ${optional.name} is displayed, blank, placeholder "${optional.placeholder}"`, async () => {
        await expect(optional.input(form), `[Expected 1] ${optional.name} is displayed`).toBeVisible();
        await expect(form.fieldLabel(optional.label), `[Expected 1] ${optional.name} has no mandatory marker`).toHaveText(optional.label);
        await expect(optional.input(form), '[Expected 1] Blank by default').toHaveValue('');
        await expect(optional.input(form), `[Expected 1] Placeholder reads "${optional.placeholder}"`).toHaveAttribute('placeholder', optional.placeholder);
      });

      await step(`Act: Step 2 — Leave ${optional.name} blank`, async () => {
        await optional.input(form).fill('');
      });

      await step('Act: Step 3 — Enter the required fields with valid values', async () => {
        await fillRequired(form, name);
        await form.typeSelect.selectOption({ label: WH_TEXT.typeSupplier });
      });

      await step('Act: Step 4 — Click 저장 (Save)', async () => {
        stored = (await saveNew(form, warehouseApi, name))[optional.key];
      });

      await step(`Assert: Expected 4 — Save succeeds with ${optional.name} blank`, async () => {
        await expect(form.toast(WH_TEXT.toastCreated), '[Expected 4] The create succeeds').toBeVisible();
        expect(stored ?? null, `[Expected 4] ${optional.name} is stored empty`).toBeNull();
      });
    });
  }

  test('TC_US069_039 — 우편번호 (Zip code) is required', async ({ page, warehouseFormPage: form }) => {
    const step = makeStep(page);
    const writes = watchWarehouseWrites(page);
    await tcMeta('TC_US069_039', 'High', TAGS, '우편번호 is displayed with the (*) marker, blank, placeholder "예: 21500"; saving it blank is blocked with "우편번호를 입력하세요."');

    await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록', async () => {
      await form.openCreate();
    });

    await step('Act: Step 1 — Observe the 우편번호 field', async () => {
      await form.zipCodeInput.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — Displayed, marked mandatory, blank with placeholder "예: 21500"', async () => {
      await expect(form.zipCodeInput, '[Expected 1] 우편번호 is displayed').toBeVisible();
      await expectRequiredMarker(form, FIELD.zipCode, '[Expected 1]');
      await expect(form.zipCodeInput, '[Expected 1] Blank by default').toHaveValue('');
      await expect(form.zipCodeInput, '[Expected 1] Placeholder reads "예: 21500"').toHaveAttribute('placeholder', '예: 21500');
    });

    await step('Act: Step 2 — Leave the zip code blank', async () => {
      await form.zipCodeInput.fill('');
    });

    await step('Act: Step 3 — Enter the required fields with valid values', async () => {
      await fillRequired(form, warehouseName('TC_US069_039'), ['zipCode']);
      await form.typeSelect.selectOption({ label: WH_TEXT.typeSupplier });
    });

    await step('Act: Step 4 — Click 저장 (Save)', async () => {
      await form.saveExpectingValidation();
    });

    await step('Assert: Expected 4 — Not saved; error "우편번호를 입력하세요."', async () => {
      await expect(form.fieldError(FIELD.zipCode), '[Expected 4] Error "우편번호를 입력하세요." is shown').toHaveText(WH_TEXT.validZipCode);
      expect(writes, '[Expected 4] No create request is sent').toEqual([]);
    });
  });

  test('TC_US069_040 — 전화번호 (Phone) is mandatory', async ({ page, warehouseFormPage: form }) => {
    const step = makeStep(page);
    const writes = watchWarehouseWrites(page);
    await tcMeta('TC_US069_040', 'High', TAGS, '전화번호 shows 국가번호 (+82) + number (blank, placeholder "예: 032-1234-5678") with the (*) marker and the separate-values hint; a blank 국가번호 is rejected with "국가번호를 입력하세요." and a blank number with "전화번호를 입력하세요."');

    await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록', async () => {
      await form.openCreate();
    });

    await step('Act: Step 1 — Observe the 전화번호 field', async () => {
      await form.numberInput.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — 국가번호 (+82) + number field, marker, placeholder and hint', async () => {
      await expect(form.callingCodeInput, '[Expected 1] 국가번호 input is displayed').toBeVisible();
      await expect(form.numberInput, '[Expected 1] Number input is displayed').toBeVisible();
      await expectRequiredMarker(form, FIELD.phone, '[Expected 1]');
      await expect(form.callingCodeInput, '[Expected 1] 국가번호 defaults to +82').toHaveValue('+82');
      await expect(form.numberInput, '[Expected 1] Number is blank by default').toHaveValue('');
      await expect(form.numberInput, '[Expected 1] Placeholder reads "예: 032-1234-5678"').toHaveAttribute('placeholder', '예: 032-1234-5678');
      await expect(form.fieldHint(FIELD.phone), '[Expected 1] The separate-values hint is shown').toHaveText(WH_TEXT.hintPhone);
    });

    await step('Act: Step 2 — Blank 국가번호, enter the other required fields and click 저장', async () => {
      await fillRequired(form, warehouseName('TC_US069_040'));
      await form.typeSelect.selectOption({ label: WH_TEXT.typeSupplier });
      await form.callingCodeInput.fill('');
      await form.saveExpectingValidation();
    });

    await step('Assert: Expected 2 — Not saved; error "국가번호를 입력하세요."', async () => {
      await expect(form.fieldError(FIELD.phone), '[Expected 2] Error "국가번호를 입력하세요." is shown').toHaveText(WH_TEXT.validCallingCode);
      expect(writes, '[Expected 2] No create request is sent').toEqual([]);
    });

    await step('Act: Step 3 — Restore 국가번호, blank the phone number and click 저장', async () => {
      await form.callingCodeInput.fill('+82');
      await form.numberInput.fill('');
      await form.saveExpectingValidation();
    });

    await step('Assert: Expected 3 — Not saved; error "전화번호를 입력하세요."', async () => {
      await expect(form.fieldError(FIELD.phone), '[Expected 3] Error "전화번호를 입력하세요." is shown').toHaveText(WH_TEXT.validNumber);
      expect(writes, '[Expected 3] No create request is sent').toEqual([]);
    });
  });

  test('TC_US069_041 — The phone number is normalised on save', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_041', 'Critical', TAGS, '국가번호 "84" is saved as "+84" and number "012-1234-5678" as "01212345678" (hyphens removed). Data: the created warehouse is deleted afterwards.');
    const name = warehouseName('TC_US069_041');
    let saved = { callingCode: '', number: '' };

    await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록', async () => {
      await form.openCreate();
      warehouseCleanup.trackName(name);
    });

    await step('Act: Step 1 — Enter 국가번호 without "+": 84', async () => {
      await form.callingCodeInput.fill('84');
    });

    await step('Act: Step 2 — Enter the number with hyphens: 012-1234-5678', async () => {
      await form.numberInput.fill('012-1234-5678');
    });

    await step('Act: Step 3 — Enter the required fields with valid values', async () => {
      await form.fill({ bizPartner: BIZ_PARTNER.name, name, addr: 'Automation street 41', zipCode: '21500' });
      await form.typeSelect.selectOption({ label: WH_TEXT.typeSupplier });
    });

    await step('Act: Step 4 — Click 저장 (Save)', async () => {
      saved = await saveNew(form, warehouseApi, name);
    });

    await step('Assert: Expected 4 — Saved as "+84" and "01212345678"', async () => {
      expect(saved.callingCode, '[Expected 4] "+" is added to 국가번호: 84 → +84').toBe('+84');
      expect(saved.number, '[Expected 4] Hyphens are removed: 012-1234-5678 → 01212345678').toBe('01212345678');
    });
  });

  test('TC_US069_043 — Entered optional fields are saved', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_043', 'Medium', TAGS, '도시, 주/도, 우편번호, 추가 주소 and 전화번호 entered on create are saved and shown again on Detail/Edit. Data: the created warehouse is deleted afterwards.');
    const name = warehouseName('TC_US069_043');
    const values = { city: '인천', state: '인천광역시', zipCode: '21543', detailAddr: '3동 2층', number: '0327654321' };
    let id = 0;

    await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록 with the other required fields valid', async () => {
      await form.openCreate();
      warehouseCleanup.trackName(name);
      await form.fill({ bizPartner: BIZ_PARTNER.name, name, addr: 'Automation street 43' });
      await form.typeSelect.selectOption({ label: WH_TEXT.typeSupplier });
    });

    await step('Act: Step 1 — Enter 도시, 주/도, 우편번호, 추가 주소 and 전화번호', async () => {
      await form.fill(values);
    });

    await step('Act: Step 2 — Click 저장 (Save)', async () => {
      id = (await saveNew(form, warehouseApi, name)).id;
    });

    await step('Act: Step 3 — Reopen the Warehouse Detail/Edit screen', async () => {
      await form.open(id);
    });

    await step('Assert: Expected 3 — Every entered value is saved and displayed', async () => {
      await expect(form.cityInput, '[Expected 3] 도시 is displayed').toHaveValue(values.city);
      await expect(form.stateInput, '[Expected 3] 주/도 is displayed').toHaveValue(values.state);
      await expect(form.zipCodeInput, '[Expected 3] 우편번호 is displayed').toHaveValue(values.zipCode);
      await expect(form.detailAddrInput, '[Expected 3] 추가 주소 is displayed').toHaveValue(values.detailAddr);
      await expect(form.numberInput, '[Expected 3] 전화번호 is displayed').toHaveValue(values.number);
    });
  });

  test('TC_US069_044 — 물류 유형 (Logistics type) shown for 플랫폼 물류', async ({ page, warehouseFormPage: form }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_044', 'Medium', TAGS, '물류 유형 is displayed with the (*) marker, blank with placeholder "— 물류 유형 선택 —", and offers exactly WMS · 현장 수령지 · 매장 · 일반.');

    await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록 with 창고 유형 = 플랫폼 물류', async () => {
      await form.openCreate();
      await form.typeSelect.selectOption({ label: WH_TEXT.typePlatform });
    });

    await step('Act: Step 1 — Observe the 물류 유형 field', async () => {
      await form.logisticsTypeSelect.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — Displayed, marked mandatory, blank with placeholder "— 물류 유형 선택 —"', async () => {
      await expect(form.logisticsTypeSelect, '[Expected 1] 물류 유형 is displayed').toBeVisible();
      await expectRequiredMarker(form, FIELD.logisticsType, '[Expected 1]');
      await expect(form.logisticsTypeSelect, '[Expected 1] Blank by default').toHaveValue('');
      await expect(form.logisticsTypeSelect.locator('option:checked'), '[Expected 1] Placeholder reads "— 물류 유형 선택 —"').toHaveText('— 물류 유형 선택 —');
    });

    await step('Act: Step 2 — Check the 물류 유형 list', async () => {
      await form.logisticsTypeSelect.focus();
    });

    await step('Assert: Expected 2 — The fixed list is WMS · 현장 수령지 · 매장 · 일반', async () => {
      await expect(form.logisticsTypeSelect.locator('option:not([value=""])'), '[Expected 2] Options read WMS · 현장 수령지 · 매장 · 일반').toHaveText(['WMS', '현장 수령지', '매장', '일반']);
    });
  });

  test('TC_US069_045 — 물류 유형 is required', async ({ page, warehouseFormPage: form }) => {
    const step = makeStep(page);
    const writes = watchWarehouseWrites(page);
    await tcMeta('TC_US069_045', 'High', TAGS, 'A Platform warehouse without 물류 유형 cannot be saved: "물류 유형을 선택하세요." is shown and nothing is sent.');

    await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록 with 창고 유형 = 플랫폼 물류', async () => {
      await form.openCreate();
      await form.typeSelect.selectOption({ label: WH_TEXT.typePlatform });
    });

    await step('Act: Step 1 — Leave 물류 유형 blank', async () => {
      await expect(form.logisticsTypeSelect).toHaveValue('');
    });

    await step('Act: Step 2 — Enter valid data for the remaining fields', async () => {
      await fillRequired(form, warehouseName('TC_US069_045'));
    });

    await step('Act: Step 3 — Click 저장 (Save)', async () => {
      await form.saveExpectingValidation();
    });

    await step('Assert: Expected 3 — Not saved; error "물류 유형을 선택하세요."', async () => {
      await expect(form.fieldError(FIELD.logisticsType), '[Expected 3] Error "물류 유형을 선택하세요." is shown').toHaveText(WH_TEXT.validLogisticsType);
      expect(writes, '[Expected 3] No create request is sent').toEqual([]);
    });
  });

  test('TC_US069_046 — Create a 플랫폼 물류 warehouse with 물류 유형 = WMS', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US069_046',
      'Critical',
      TAGS,
      'A Platform WMS warehouse with a 3PL connection and 물류사 연동 정보 (JSON) is created 활성 with 분류 = CJ 창고 and every value saved. ' +
        `Deviation from TC: Step 3 selects CJ대한통운(EgFlex) instead of CJ대한통운 (DT) — ${DT_UNAVAILABLE} EgFlex also needs 물류 채널 ` +
        'code, entered in Step 5. Data: the created warehouse is deleted afterwards.',
    );
    const name = warehouseName('TC_US069_046');
    const info = '{"WH-DEST-01_PARCEL":"CUST0098"}';
    let saved: Awaited<ReturnType<typeof saveNew>> | undefined;

    await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록', async () => {
      await form.openCreate();
      warehouseCleanup.trackName(name);
    });

    await step('Act: Step 1 — Select 창고 유형 = 플랫폼 물류', async () => {
      await form.typeSelect.selectOption({ label: WH_TEXT.typePlatform });
    });

    await step('Act: Step 2 — Select 물류 유형 = WMS', async () => {
      await form.logisticsTypeSelect.selectOption({ label: 'WMS' });
    });

    await step('Act: Step 3 — Select 물류사 유형 = CJ대한통운(EgFlex) (see Deviation)', async () => {
      await form.channelSelect.selectOption({ label: WH_TEXT.channelEgFlex });
    });

    await step('Act: Step 4 — Fill 물류사 연동 정보 (JSON)', async () => {
      await form.logisticsInfoInput.fill(info);
    });

    await step('Act: Step 5 — Fill all mandatory fields and click 저장', async () => {
      await fillRequired(form, name);
      await form.fill({ cjWarehouseCode: 'A12', cjChannelCode: 'CH01' });
      saved = await saveNew(form, warehouseApi, name);
    });

    await step('Assert: Expected 5 — Created 활성 with 분류 = CJ 창고 and every value saved', async () => {
      expect(saved!.status, '[Expected 5] 상태 is ACTIVE').toBe('ACTIVE');
      expect(saved!.category, '[Expected 5] 분류 is CJ_WAREHOUSE (CJ 창고)').toBe('CJ_WAREHOUSE');
      expect(saved!.logisticsType, '[Expected 5] 물류 유형 is WMS').toBe('WMS');
      expect(saved!.logisticsChannelType, '[Expected 5] 물류사 유형 is CJ_LOGISTICS').toBe('CJ_LOGISTICS');
      expect(saved!.logisticsChannelWarehouseCode, '[Expected 5] 물류사 창고 코드 is saved').toBe('A12');
      expect(saved!.logisticsChannelCode, '[Expected 5] 물류 채널 코드 is saved').toBe('CH01');
      expect(saved!.logisticsChannelInfo, '[Expected 5] 물류사 연동 정보 (JSON) is saved').toBe(info);
      expect(saved!.addr, '[Expected 5] Address is saved').toBe('Automation street 1');
    });
  });

  for (const combo of [
    { tc: 'TC_US069_047', type: '일반', label: 'General (일반)', category: 'GENERAL_WAREHOUSE', categoryText: WH_TEXT.categoryGeneral, deviation: '' },
    { tc: 'TC_US069_048', type: '현장 수령지', label: 'Pickup location (현장 수령지)', category: 'PICKUP_LOCATION', categoryText: WH_TEXT.categoryPickup, deviation: '' },
    { tc: 'TC_US069_049', type: '매장', label: 'Store (매장)', category: 'STORE_WAREHOUSE', categoryText: WH_TEXT.categoryStore, deviation: ' Deviation from TC: 분류 reads "매장 창고" (Store warehouse), not "매장".' },
  ]) {
    test(`${combo.tc} — Create a 플랫폼 물류 warehouse with 물류 유형 = ${combo.label}`, async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
      const step = makeStep(page);
      await tcMeta(combo.tc, 'Critical', TAGS, `A Platform warehouse with 물류 유형 = ${combo.type} (3PL fixed to 연동 없음) is created 활성 with 분류 = ${combo.categoryText}.${combo.deviation} Data: the created warehouse is deleted afterwards.`);
      const name = warehouseName(combo.tc);
      let saved: Awaited<ReturnType<typeof saveNew>> | undefined;
      let categoryShown = '';
      const isGeneral = combo.tc === 'TC_US069_047';

      await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록', async () => {
        await form.openCreate();
        warehouseCleanup.trackName(name);
      });

      await step('Act: Step 1 — Select 창고 유형 = 플랫폼 물류', async () => {
        await form.typeSelect.selectOption({ label: WH_TEXT.typePlatform });
      });

      await step(`Act: Step 2 — Select 물류 유형 = ${combo.type}`, async () => {
        await form.logisticsTypeSelect.selectOption({ label: combo.type });
        categoryShown = await form.categoryInput.inputValue();
      });

      if (isGeneral) {
        await step('Act: Step 3 — Keep 물류사 유형 = 연동 없음 (No 3PL connection)', async () => {
          await expect(form.channelSelect.locator('option:checked')).toHaveText(WH_TEXT.channelNone);
        });
      }

      await step(`Act: Step ${isGeneral ? 4 : 3} — Click 저장 with valid data`, async () => {
        await fillRequired(form, name);
        saved = await saveNew(form, warehouseApi, name);
      });

      await step(`Assert: Expected ${isGeneral ? 4 : 3} — Created 활성 with 분류 = ${combo.categoryText}`, async () => {
        const tag = `[Expected ${isGeneral ? 4 : 3}]`;
        expect(categoryShown, `${tag} The form computed 분류 = ${combo.categoryText}`).toBe(combo.categoryText);
        expect(saved!.category, `${tag} Stored 분류 is ${combo.category}`).toBe(combo.category);
        expect(saved!.status, `${tag} 상태 is ACTIVE`).toBe('ACTIVE');
        expect(saved!.logisticsChannelType, `${tag} 물류사 유형 is NONE`).toBe('NONE');
      });
    });
  }

  test('TC_US069_051 — The 물류사 유형 list follows the 물류 유형', async ({ page, warehouseFormPage: form }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US069_051',
      'High',
      TAGS,
      'For WMS the 3PL list shows the placeholder "— 물류사 유형 선택 —" and the CJ providers; for 현장 수령지, 일반 and 매장 the system selects ' +
        `연동 없음 and locks the field. Deviation from TC: the WMS list offers only CJ대한통운(EgFlex) — ${DT_UNAVAILABLE}`,
    );
    const locked: Record<string, { value: string; disabled: boolean }> = {};

    await step('Arrange: Pre-condition 1 — ADMIN is creating a warehouse', async () => {
      await form.openCreate();
    });

    await step('Act: Step 1 — Select 창고 유형 = 플랫폼 물류', async () => {
      await form.typeSelect.selectOption({ label: WH_TEXT.typePlatform });
    });

    await step('Act: Step 2 — Select 물류 유형 = WMS and open 물류사 유형', async () => {
      await form.logisticsTypeSelect.selectOption({ label: 'WMS' });
      await form.channelSelect.focus();
    });

    await step('Assert: Expected 2 — Placeholder "— 물류사 유형 선택 —" and the CJ provider list', async () => {
      await expect(form.channelSelect.locator('option:checked'), '[Expected 2] Placeholder reads "— 물류사 유형 선택 —"').toHaveText('— 물류사 유형 선택 —');
      await expect(form.channelSelect.locator('option:not([value=""])'), '[Expected 2] The list offers CJ대한통운(EgFlex) (DT not offered — Deviation)').toHaveText([WH_TEXT.channelEgFlex]);
      await expect(form.channelSelect, '[Expected 2] 물류사 유형 is selectable').toBeEnabled();
    });

    for (const [n, type] of [[3, '현장 수령지'], [4, '일반'], [5, '매장']] as const) {
      await step(`Act: Step ${n} — Select 물류 유형 = ${type} and observe 물류사 유형`, async () => {
        await form.logisticsTypeSelect.selectOption({ label: type });
        locked[type] = { value: (await form.channelSelect.locator('option:checked').textContent())?.trim() ?? '', disabled: await form.channelSelect.isDisabled() };
      });

      await step(`Assert: Expected ${n} — 연동 없음 is selected automatically and the field is locked`, async () => {
        expect(locked[type].value, `[Expected ${n}] 물류사 유형 reads 연동 없음`).toBe(WH_TEXT.channelNone);
        expect(locked[type].disabled, `[Expected ${n}] 물류사 유형 is locked`).toBe(true);
      });
    }
  });

  test('TC_US069_052 — CJ대한통운(EgFlex) shows and requires both CJ codes', async ({ page, warehouseFormPage: form }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_052', 'Medium', TAGS, 'With WMS + CJ대한통운(EgFlex) both 물류사 창고 코드 and 물류 채널 코드 are displayed and required (marked *), and 물류사 연동 정보 (JSON) is displayed as an optional free-form field.');

    await step('Arrange: Pre-condition 1 — ADMIN is creating a 플랫폼 물류 warehouse', async () => {
      await form.openCreate();
      await form.typeSelect.selectOption({ label: WH_TEXT.typePlatform });
    });

    await step('Act: Step 1 — Select 물류 유형 = WMS', async () => {
      await form.logisticsTypeSelect.selectOption({ label: 'WMS' });
    });

    await step('Act: Step 2 — Select 물류사 유형 = CJ대한통운(EgFlex)', async () => {
      await form.channelSelect.selectOption({ label: WH_TEXT.channelEgFlex });
    });

    await step('Act: Step 3 — Observe 물류사 창고 코드 and 물류 채널 코드', async () => {
      await form.cjWarehouseCodeInput.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Both CJ codes are displayed and required', async () => {
      await expect(form.cjWarehouseCodeInput, '[Expected 3] 물류사 창고 코드 is displayed').toBeVisible();
      await expectRequiredMarker(form, FIELD.cjWarehouseCode, '[Expected 3]');
      await expect(form.cjChannelCodeInput, '[Expected 3] 물류 채널 코드 is displayed').toBeVisible();
      await expectRequiredMarker(form, FIELD.cjChannelCode, '[Expected 3]');
    });

    await step('Act: Step 4 — Observe 물류사 연동 정보 (JSON)', async () => {
      await form.logisticsInfoInput.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — 물류사 연동 정보 (JSON) is displayed and optional free form', async () => {
      await expect(form.logisticsInfoInput, '[Expected 4] 물류사 연동 정보 (JSON) is displayed').toBeVisible();
      await expect(form.fieldLabel(FIELD.logisticsInfo), '[Expected 4] It has no mandatory marker').toHaveText(FIELD.logisticsInfo);
      await expect(form.logisticsInfoInput, '[Expected 4] It accepts free-form text').toBeEditable();
    });
  });

  for (const dt of [
    { tc: 'TC_US069_053', priority: 'Medium' as const, title: 'CJ대한통운 (DT) only displays 물류사 창고 코드', description: 'With WMS + CJ대한통운 (DT) only 물류사 창고 코드 is displayed (required) and 물류 채널 코드 is hidden; 물류사 연동 정보 (JSON) stays optional.' },
    { tc: 'TC_US069_056', priority: 'High' as const, title: 'Switching EgFlex → DT clears and hides 물류 채널 코드', description: 'Switching the 3PL connection from EgFlex to DT clears and hides 물류 채널 코드 while 물류사 창고 코드 stays required.' },
    { tc: 'TC_US069_059', priority: 'High' as const, title: 'CJ대한통운 (DT) requires 물류사 창고 코드', description: 'With DT, saving without 물류사 창고 코드 is blocked with "물류사 창고 코드를 입력하세요."' },
    { tc: 'TC_US069_089', priority: 'High' as const, title: 'Switching DT → EgFlex displays and requires 물류 채널 코드', description: 'Switching from DT to EgFlex shows 물류 채널 코드 as a required field and blocks saving while it is blank.' },
  ]) {
    test(`${dt.tc} — ${dt.title}`, async () => {
      await skipTc(dt.tc, dt.priority, TAGS, dt.description, DT_UNAVAILABLE);
    });
  }

  for (const code of [
    { tc: 'TC_US069_054', label: FIELD.cjWarehouseCode, name: '물류사 창고 코드 (CJ warehouse code)', placeholder: '예: WH01', input: (f: WarehouseFormPage) => f.cjWarehouseCodeInput },
    { tc: 'TC_US069_055', label: FIELD.cjChannelCode, name: '물류 채널 코드 (CJ channel code)', placeholder: '예: CH01', input: (f: WarehouseFormPage) => f.cjChannelCodeInput },
  ]) {
    test(`${code.tc} — Display of ${code.name}`, async ({ page, warehouseFormPage: form }) => {
      const step = makeStep(page);
      await tcMeta(code.tc, 'Low', TAGS, `${code.name} is displayed with the (*) marker, blank by default, placeholder "${code.placeholder}".`);

      await step(`Arrange: Pre-condition 1 — ADMIN is creating a 플랫폼 물류 warehouse and ${code.name} is displayed (WMS + CJ대한통운(EgFlex))`, async () => {
        await form.openCreate();
        await form.fill({ type: WH_TEXT.typePlatform, logisticsType: 'WMS', channel: WH_TEXT.channelEgFlex });
      });

      await step(`Act: Step 1 — Observe the ${code.name} field`, async () => {
        await code.input(form).scrollIntoViewIfNeeded();
      });

      await step(`Assert: Expected 1 — Displayed, marked mandatory, blank with placeholder "${code.placeholder}"`, async () => {
        await expect(code.input(form), `[Expected 1] ${code.name} is displayed`).toBeVisible();
        await expectRequiredMarker(form, code.label, '[Expected 1]');
        await expect(code.input(form), '[Expected 1] Blank by default').toHaveValue('');
        await expect(code.input(form), `[Expected 1] Placeholder reads "${code.placeholder}"`).toHaveAttribute('placeholder', code.placeholder);
      });
    });
  }

  test('TC_US069_057 — CJ대한통운(EgFlex) requires 물류사 창고 코드', async ({ page, warehouseFormPage: form }) => {
    const step = makeStep(page);
    const writes = watchWarehouseWrites(page);
    await tcMeta('TC_US069_057', 'High', TAGS, 'With EgFlex, saving with a blank 물류사 창고 코드 is blocked with "물류사 창고 코드를 입력하세요."');

    await step('Arrange: Pre-condition 1 — ADMIN is creating 플랫폼 물류 + WMS with the other required fields valid', async () => {
      await form.openCreate();
      await fillRequired(form, warehouseName('TC_US069_057'));
      await form.fill({ type: WH_TEXT.typePlatform, logisticsType: 'WMS' });
    });

    await step('Act: Step 1 — Select 물류사 유형 = CJ대한통운(EgFlex)', async () => {
      await form.channelSelect.selectOption({ label: WH_TEXT.channelEgFlex });
      await form.cjChannelCodeInput.fill('CH01');
    });

    await step('Act: Step 2 — Leave 물류사 창고 코드 blank', async () => {
      await form.cjWarehouseCodeInput.fill('');
    });

    await step('Act: Step 3 — Click 저장 (Save)', async () => {
      await form.saveExpectingValidation();
    });

    await step('Assert: Expected 3 — Not saved; error "물류사 창고 코드를 입력하세요."', async () => {
      await expect(form.fieldError(FIELD.cjWarehouseCode), '[Expected 3] Error "물류사 창고 코드를 입력하세요." is shown').toHaveText(WH_TEXT.validCjWarehouseCode);
      expect(writes, '[Expected 3] No create request is sent').toEqual([]);
    });
  });

  test('TC_US069_058 — CJ대한통운(EgFlex) requires 물류 채널 코드', async ({ page, warehouseFormPage: form }) => {
    const step = makeStep(page);
    const writes = watchWarehouseWrites(page);
    await tcMeta('TC_US069_058', 'High', TAGS, 'With EgFlex, saving with a blank 물류 채널 코드 is blocked. Deviation from TC: the message reads "물류 채널 코드를 입력하세요." (TC: "EgFlex 연동은 물류 채널 코드가 필요합니다.").');

    await step('Arrange: Pre-condition 1 — ADMIN is creating 플랫폼 물류 + WMS with the other required fields valid', async () => {
      await form.openCreate();
      await fillRequired(form, warehouseName('TC_US069_058'));
      await form.fill({ type: WH_TEXT.typePlatform, logisticsType: 'WMS' });
    });

    await step('Act: Step 1 — Select 물류사 유형 = CJ대한통운(EgFlex)', async () => {
      await form.channelSelect.selectOption({ label: WH_TEXT.channelEgFlex });
    });

    await step('Act: Step 2 — Enter 물류사 창고 코드', async () => {
      await form.cjWarehouseCodeInput.fill('A12');
    });

    await step('Act: Step 3 — Leave 물류 채널 코드 blank', async () => {
      await form.cjChannelCodeInput.fill('');
    });

    await step('Act: Step 4 — Click 저장 (Save)', async () => {
      await form.saveExpectingValidation();
    });

    await step('Assert: Expected 4 — Not saved; the 물류 채널 코드 error is shown', async () => {
      await expect(form.fieldError(FIELD.cjChannelCode), '[Expected 4] Error "물류 채널 코드를 입력하세요." is shown (Deviation)').toHaveText(WH_TEXT.validCjChannelCode);
      expect(writes, '[Expected 4] No create request is sent').toEqual([]);
    });
  });

  test('TC_US069_060 — 분류 (Category) is calculated for each valid combination', async ({ page, warehouseFormPage: form }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US069_060',
      'Critical',
      TAGS,
      '분류 reads "—" for 판매자 물류 and for WMS without a 3PL, 일반 창고 for 일반, 현장 수령지 for 현장 수령지, CJ 창고 for WMS + EgFlex and ' +
        `매장 창고 for 매장. Not automated: Step/Expected 6 (WMS + CJ대한통운 (DT) → CJ 대구 창고) — ${DT_UNAVAILABLE}`,
    );
    const category = () => form.categoryInput;
    const combos: Array<{ n: number; act: string; expected: string; text: string; run: () => Promise<void> }> = [
      { n: 1, act: 'Select 판매자 물류', expected: '"—"', text: WH_TEXT.none, run: () => form.typeSelect.selectOption({ label: WH_TEXT.typeSupplier }).then(() => undefined) },
      { n: 2, act: 'Select 플랫폼 물류 + 일반 + 연동 없음', expected: '"일반 창고"', text: WH_TEXT.categoryGeneral, run: () => form.fill({ type: WH_TEXT.typePlatform, logisticsType: '일반' }) },
      { n: 3, act: 'Select 플랫폼 물류 + 현장 수령지 + 연동 없음', expected: '"현장 수령지"', text: WH_TEXT.categoryPickup, run: () => form.fill({ logisticsType: '현장 수령지' }) },
      { n: 4, act: 'Select 플랫폼 물류 + WMS with no 물류사 유형', expected: '"—"', text: WH_TEXT.none, run: () => form.fill({ logisticsType: 'WMS' }) },
      { n: 5, act: 'Select 플랫폼 물류 + WMS + CJ대한통운(EgFlex)', expected: 'CJ 창고', text: WH_TEXT.categoryCj, run: () => form.fill({ channel: WH_TEXT.channelEgFlex }) },
    ];

    await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록', async () => {
      await form.openCreate();
    });

    for (const combo of combos) {
      await step(`Act: Step ${combo.n} — ${combo.act}`, combo.run);
      await step(`Assert: Expected ${combo.n} — 분류 displays ${combo.expected}`, async () => {
        await expect(category(), `[Expected ${combo.n}] 분류 reads ${combo.expected}`).toHaveValue(combo.text);
      });
    }

    await step('Act: Step 6 — Select 플랫폼 물류 + WMS + CJ대한통운 (DT) (not offered on dev — see description)', async () => {
      await expect(form.channelSelect.locator('option', { hasText: exactOption(WH_TEXT.channelDt) })).toHaveCount(0);
    });

    // Expected 6 (CJ 대구 창고) không tự động hoá được: provider DT không có trong list trên dev — ghi Not automated ở description.
    await step('Assert: Expected 6 — 분류 displays CJ 대구 창고 (Not automated — DT provider not offered)', async () => {
      test.info().annotations.push({ type: 'Not automated', description: `Expected 6: ${DT_UNAVAILABLE}` });
    });

    await step('Act: Step 7 — Select 플랫폼 물류 + 매장 + 연동 없음', async () => {
      await form.fill({ logisticsType: '매장' });
    });

    await step('Assert: Expected 7 — 분류 displays "매장 창고"', async () => {
      await expect(category(), '[Expected 7] 분류 reads 매장 창고').toHaveValue(WH_TEXT.categoryStore);
    });
  });

  test('TC_US069_061 — 분류 cannot be entered manually', async ({ page, warehouseFormPage: form }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_061', 'Medium', TAGS, '분류 is computed by the system and read-only: focusing and typing into it does not change its value.');

    await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록 (플랫폼 물류 + 일반 → 분류 = 일반 창고)', async () => {
      await form.openCreate();
      await form.fill({ type: WH_TEXT.typePlatform, logisticsType: '일반' });
    });

    await step('Act: Step 1 — Observe the 분류 field', async () => {
      await form.categoryInput.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — 분류 is calculated and read-only', async () => {
      await expect(form.categoryInput, '[Expected 1] 분류 holds the calculated value').toHaveValue(WH_TEXT.categoryGeneral);
      await expect(form.categoryInput, '[Expected 1] 분류 is read-only').toHaveAttribute('readonly', '');
      await expect(form.fieldHint(FIELD.category), '[Expected 1] The auto-calculation hint is shown').toHaveText(WH_TEXT.hintCategoryAuto);
    });

    await step('Act: Step 2 — Try focusing and typing into 분류', async () => {
      await form.categoryInput.focus();
      await page.keyboard.type('MANUAL');
    });

    await step('Assert: Expected 2 — The user cannot enter or edit 분류', async () => {
      await expect(form.categoryInput, '[Expected 2] 분류 is unchanged after typing').toHaveValue(WH_TEXT.categoryGeneral);
      await expect(form.categoryInput, '[Expected 2] 분류 is not editable').not.toBeEditable();
    });
  });

  test('TC_US069_062 — 저장 creates the warehouse 활성 immediately and writes one Created record', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_062', 'Critical', TAGS, '저장 creates the warehouse immediately with 상태 = 활성 (no draft / pending), shows the success toast, and 변경 이력 holds exactly one 생성 record. Data: the created warehouse is deleted afterwards.');
    const name = warehouseName('TC_US069_062');
    let saved: Awaited<ReturnType<typeof saveNew>> | undefined;
    let rows: string[][] = [];

    await step('Arrange: Pre-condition 1 — 창고 등록 holds valid data', async () => {
      await form.openCreate();
      warehouseCleanup.trackName(name);
      await fillRequired(form, name);
      await form.typeSelect.selectOption({ label: WH_TEXT.typeSupplier });
    });

    await step('Act: Step 1 — Click 저장 (Save)', async () => {
      saved = await saveNew(form, warehouseApi, name);
    });

    await step('Assert: Expected 1 — Created immediately with 상태 = 활성', async () => {
      expect(saved!.status, '[Expected 1] 상태 is ACTIVE right after saving').toBe('ACTIVE');
    });

    await step('Act: Step 2 — Observe the notification and the new warehouse', async () => {
      await form.toast(WH_TEXT.toastCreated).scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — The success message is displayed', async () => {
      await expect(form.toast(WH_TEXT.toastCreated), '[Expected 2] Toast "창고가 등록되었습니다 — 즉시 적용됩니다." is shown').toBeVisible();
    });

    await step('Act: Step 3 — Open 변경 이력 (Change history) of the created warehouse', async () => {
      await form.open(saved!.id);
      await form.openHistory();
      rows = await form.readHistoryRows();
    });

    await step('Assert: Expected 3 — Exactly one 생성 (Created) record', async () => {
      expect(rows.length, '[Expected 3] Exactly one history record').toBe(1);
      expect(rows[0][2], '[Expected 3] The record is the 생성 chip').toBe(WH_TEXT.historyCreatedChip);
    });
  });

  for (const lock of [
    { tc: 'TC_US069_083', type: '현장 수령지', label: 'Pickup location (현장 수령지)' },
    { tc: 'TC_US069_084', type: '일반', label: 'General (일반)' },
    { tc: 'TC_US069_085', type: '매장', label: 'Store (매장)' },
  ]) {
    test(`${lock.tc} — The ${lock.label} + CJ combination cannot be created`, async ({ page, warehouseFormPage: form }) => {
      const step = makeStep(page);
      await tcMeta(
        lock.tc,
        'Medium',
        TAGS,
        `With 물류 유형 = ${lock.type} the 물류사 유형 is locked to 연동 없음 and offers no CJ provider, so the combination cannot be created. ` +
          'Deviation from TC: Expected 1 describes the state after the 물류 유형 is chosen, so it is asserted after Step 2.',
      );
      let options: string[] = [];

      await step('Arrange: Pre-condition 1 — ADMIN is creating a warehouse', async () => {
        await form.openCreate();
      });

      await step('Act: Step 1 — Select 창고 유형 = 플랫폼 물류', async () => {
        await form.typeSelect.selectOption({ label: WH_TEXT.typePlatform });
      });

      await step(`Act: Step 2 — Select 물류 유형 = ${lock.type}`, async () => {
        await form.logisticsTypeSelect.selectOption({ label: lock.type });
      });

      await step('Assert: Expected 1 — 물류사 유형 is locked to 연동 없음', async () => {
        await expect(form.channelSelect.locator('option:checked'), '[Expected 1] 물류사 유형 reads 연동 없음').toHaveText(WH_TEXT.channelNone);
        await expect(form.channelSelect, '[Expected 1] 물류사 유형 is disabled').toBeDisabled();
      });

      await step('Act: Step 3 — Observe 물류사 유형 and try to change it to a CJ connection', async () => {
        options = (await form.channelSelect.locator('option').allTextContents()).map((o) => o.trim());
      });

      await step('Assert: Expected 3 — No CJ provider can be selected', async () => {
        expect(options, '[Expected 3] Only 연동 없음 is offered').toEqual([WH_TEXT.channelNone]);
        expect(options, '[Expected 3] CJ대한통운(EgFlex) cannot be selected').not.toContain(WH_TEXT.channelEgFlex);
        expect(options, '[Expected 3] CJ대한통운 (DT) cannot be selected').not.toContain(WH_TEXT.channelDt);
        await expect(form.channelSelect, '[Expected 3] The field stays locked').toBeDisabled();
      });
    });
  }

  test('TC_US069_086 — The WMS + 연동 없음 combination cannot be created', async ({ page, warehouseFormPage: form }) => {
    const step = makeStep(page);
    const writes = watchWarehouseWrites(page);
    await tcMeta(
      'TC_US069_086',
      'High',
      TAGS,
      'For WMS the 3PL list does not offer 연동 없음, and saving without a 3PL connection is blocked with "물류사 유형을 선택하세요.". Deviation from ' +
        'TC: Expected 1 describes the WMS 3PL list, so it is asserted after Step 3 (open the list).',
    );
    let options: string[] = [];

    await step('Arrange: Pre-condition 1 — ADMIN is creating a warehouse with the other required fields valid', async () => {
      await form.openCreate();
      await fillRequired(form, warehouseName('TC_US069_086'));
    });

    await step('Act: Step 1 — Select 창고 유형 = 플랫폼 물류', async () => {
      await form.typeSelect.selectOption({ label: WH_TEXT.typePlatform });
    });

    await step('Act: Step 2 — Select 물류 유형 = WMS', async () => {
      await form.logisticsTypeSelect.selectOption({ label: 'WMS' });
    });

    await step('Act: Step 3 — Open 물류사 유형 and check the options', async () => {
      await form.channelSelect.focus();
      options = (await form.channelSelect.locator('option').allTextContents()).map((o) => o.trim());
    });

    await step('Assert: Expected 1 — 연동 없음 does not appear in the WMS list', async () => {
      expect(options, '[Expected 1] 연동 없음 is not offered for WMS').not.toContain(WH_TEXT.channelNone);
    });

    await step('Act: Step 4 — Try saving with no 3PL connection selected', async () => {
      await form.saveExpectingValidation();
    });

    await step('Assert: Expected 4 — Not saved until a CJ connection is selected', async () => {
      await expect(form.fieldError(FIELD.channel), '[Expected 4] Error "물류사 유형을 선택하세요." is shown').toHaveText(WH_TEXT.validChannel);
      expect(writes, '[Expected 4] No create request is sent').toEqual([]);
    });
  });

  test('TC_US069_091 — Korean UI of the create and Detail/Edit screens', async ({ page, warehouseFormPage: form, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US069_091',
      'Medium',
      [...TAGS, 'i18n'],
      'Labels, placeholders, dropdown options and actions of 창고 등록 and Detail/Edit read in Korean; the only Latin text is proper names / ' +
        'codes (WMS, EgFlex, DT, CJ, JSON, example codes like WH01, country codes). Biz partner and country option lists are data and are ' +
        'excluded. Not automated: "terminology is consistent" (editorial judgement). Data: an automation-owned WMS warehouse is created and ' +
        'deleted afterwards.',
    );
    const collect = async (): Promise<string[]> => {
      const card = form.formCard;
      return [
        ...(await card.locator('label').allTextContents()),
        ...(await card.locator('input[placeholder]').evaluateAll((els) => els.map((e) => e.getAttribute('placeholder') ?? ''))),
        ...(await card.locator('select').evaluateAll((selects) => selects.slice(1).flatMap((s) => Array.from((s as HTMLSelectElement).options).map((o) => o.text)))),
        ...(await page.locator('div.main-content').getByRole('button').allInnerTexts()),
        ...(await card.locator('.small.text-muted').allTextContents()),
      ].map((t) => t.trim()).filter(Boolean);
    };
    let createTexts: string[] = [];
    let detailTexts: string[] = [];
    let id = 0;

    await step('Arrange: Pre-condition 1 — ADMIN is logged in with 한국어 (automation-owned WMS warehouse available)', async () => {
      id = (await warehouseCleanup.create('PLATFORM_WMS_EGFLEX', 'TC_US069_091')).id;
    });

    await step('Act: Step 1 — Open 창고 등록 (플랫폼 물류 + WMS + EgFlex to reveal every field)', async () => {
      await form.openCreate();
      await form.fill({ type: WH_TEXT.typePlatform, logisticsType: 'WMS', channel: WH_TEXT.channelEgFlex });
      createTexts = await collect();
    });

    await step('Assert: Expected 1 — The 창고 등록 screen opens', async () => {
      await expect(form.cardHeader, '[Expected 1] Card title reads 창고 등록').toHaveText('창고 등록');
    });

    await step('Act: Step 2 — Open one warehouse on the Detail/Edit screen', async () => {
      await form.open(id);
      detailTexts = [...(await collect()), ...(await form.panel.locator('li span.text-muted').allTextContents())];
    });

    await step('Assert: Expected 2 — The Detail/Edit screen opens the selected warehouse', async () => {
      await expect(page, '[Expected 2] URL carries the warehouse ID').toHaveURL(new RegExp(`/${id}$`));
      await expect(form.panelTitle, '[Expected 2] Status & actions panel is shown').toBeVisible();
    });

    await step('Act: Step 3 — Observe labels, placeholders, dropdowns and actions on both screens', async () => {
      await form.formCard.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Everything reads in Korean except proper names and codes', async () => {
      for (const [screen, texts] of [['create', createTexts], ['detail', detailTexts]] as const) {
        expect(texts.length, `[Expected 3] Texts were collected on the ${screen} screen`).toBeGreaterThan(10);
        for (const text of texts) {
          expect(text.replace(ALLOWED_LATIN, ''), `[Expected 3] ${screen}: "${text}" has no unexpected English`).not.toMatch(/[A-Za-z]/);
        }
      }
    });
  });

  test('TC_US069_092 — Korean validation messages', async ({ page, warehouseFormPage: form }) => {
    const step = makeStep(page);
    const writes = watchWarehouseWrites(page);
    await tcMeta(
      'TC_US069_092',
      'High',
      [...TAGS, 'i18n'],
      'The validation messages read in Korean: 거래처를 선택하세요., 창고명을 입력하세요., 창고 유형을 선택하세요., 주소를 입력하세요.; ' +
        '물류 유형을 선택하세요.; 물류사 창고 코드를 입력하세요. and the 물류 채널 코드 message. Deviation from TC: the channel-code message reads ' +
        '"물류 채널 코드를 입력하세요." (TC: "EgFlex 연동은 물류 채널 코드가 필요합니다.").',
    );

    await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록 with 한국어', async () => {
      await form.openCreate();
    });

    await step('Act: Step 1 — Leave the basic required fields blank and click 저장', async () => {
      await form.saveExpectingValidation();
    });

    await step('Assert: Expected 1 — Not saved; the basic messages read in Korean', async () => {
      await expect(form.fieldError(FIELD.bizPartner), '[Expected 1] 거래처를 선택하세요.').toHaveText(WH_TEXT.validBizPartner);
      await expect(form.fieldError(FIELD.name), '[Expected 1] 창고명을 입력하세요.').toHaveText(WH_TEXT.validName);
      await expect(form.fieldError(FIELD.type), '[Expected 1] 창고 유형을 선택하세요.').toHaveText(WH_TEXT.validType);
      await expect(form.fieldError(FIELD.addr), '[Expected 1] 주소를 입력하세요.').toHaveText(WH_TEXT.validAddr);
      expect(writes, '[Expected 1] No create request is sent').toEqual([]);
    });

    await step('Act: Step 2 — Select 플랫폼 물류, leave 물류 유형 blank and click 저장', async () => {
      await form.typeSelect.selectOption({ label: WH_TEXT.typePlatform });
      await form.saveExpectingValidation();
    });

    await step('Assert: Expected 2 — Not saved; "물류 유형을 선택하세요." is shown', async () => {
      await expect(form.fieldError(FIELD.logisticsType), '[Expected 2] 물류 유형을 선택하세요.').toHaveText(WH_TEXT.validLogisticsType);
      expect(writes, '[Expected 2] No create request is sent').toEqual([]);
    });

    await step('Act: Step 3 — Select WMS + CJ대한통운(EgFlex), leave the CJ codes blank and click 저장', async () => {
      await form.fill({ logisticsType: 'WMS', channel: WH_TEXT.channelEgFlex });
      await form.saveExpectingValidation();
    });

    await step('Assert: Expected 3 — Not saved; both CJ code messages read in Korean', async () => {
      await expect(form.fieldError(FIELD.cjWarehouseCode), '[Expected 3] 물류사 창고 코드를 입력하세요.').toHaveText(WH_TEXT.validCjWarehouseCode);
      await expect(form.fieldError(FIELD.cjChannelCode), '[Expected 3] 물류 채널 코드를 입력하세요. (Deviation)').toHaveText(WH_TEXT.validCjChannelCode);
      for (const message of await form.formCard.locator('.invalid-feedback').allTextContents()) {
        expect(message, `[Expected 3] "${message}" has no English text`).not.toMatch(/[A-Za-z]/);
      }
      expect(writes, '[Expected 3] No create request is sent').toEqual([]);
    });
  });

  test('TC_US069_095 — Korean data is saved, displayed and searchable', async ({ page, warehouseFormPage: form, warehouseListPage: list, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_095', 'High', [...TAGS, 'i18n'], 'A Korean 창고명 ("…인천 물류센터") and Korean address are accepted, saved intact, displayed on the list and Detail/Edit, found by the keyword 인천, and still correct after refresh. Data: the created warehouse is deleted afterwards (the name keeps the traceable auto_ prefix).');
    const name = `${warehouseName('TC_US069_095')} 인천 물류센터`;
    const address = '인천광역시 중구 공항로 272';
    let id = 0;

    await step('Arrange: Pre-condition 1 — ADMIN is on 창고 등록 with 한국어', async () => {
      await form.openCreate();
      warehouseCleanup.trackName(name);
    });

    await step('Act: Step 1 — Enter 창고명 "… 인천 물류센터" and a Korean address', async () => {
      await fillRequired(form, name, ['addr']);
      await form.typeSelect.selectOption({ label: WH_TEXT.typeSupplier });
      await form.addrInput.fill(address);
    });

    await step('Assert: Expected 1 — The fields accept Korean characters without encoding errors', async () => {
      await expect(form.nameInput, '[Expected 1] 창고명 holds the Korean text intact').toHaveValue(name);
      await expect(form.addrInput, '[Expected 1] The address holds the Korean text intact').toHaveValue(address);
    });

    const onDetail = { name: '', addr: '' };
    await step('Act: Step 2 — Save the warehouse, reopen it on Detail/Edit, then find it on the list', async () => {
      id = (await saveNew(form, warehouseApi, name)).id;
      await form.open(id);
      onDetail.name = await form.nameInput.inputValue();
      onDetail.addr = await form.addrInput.inputValue();
      await list.open({ keyword: name });
    });

    await step('Assert: Expected 2 — The Korean name and address are intact on Detail/Edit and the list', async () => {
      expect(onDetail.name, '[Expected 2] Detail/Edit shows the Korean name').toBe(name);
      expect(onDetail.addr, '[Expected 2] Detail/Edit shows the Korean address').toBe(address);
      await expect(list.rowByName(name), '[Expected 2] The list shows the Korean name').toBeVisible();
    });

    await step('Act: Step 3 — Search the list with the keyword 인천', async () => {
      await list.open({ size: '100' });
      await list.search({ keyword: '인천' });
    });

    await step('Assert: Expected 3 — Only warehouses whose name contains 인천 are returned', async () => {
      const names = await list.columnValues('창고명');
      expect(names.length, '[Expected 3] Rows are returned').toBeGreaterThan(0);
      for (const shown of names) expect(shown, `[Expected 3] "${shown}" contains 인천`).toContain('인천');
      expect(names, '[Expected 3] The new warehouse is returned').toContain(name);
    });

    await step('Act: Step 4 — Refresh and reopen the warehouse', async () => {
      await page.reload();
      await list.waitForListLoaded();
      await list.rowByName(name).click();
      await form.waitForDetailLoaded();
    });

    await step('Assert: Expected 4 — The Korean data still displays correctly', async () => {
      await expect(form.nameInput, '[Expected 4] The Korean name is intact after refresh').toHaveValue(name);
      await expect(form.addrInput, '[Expected 4] The Korean address is intact after refresh').toHaveValue(address);
    });
  });
});

function exactOption(text: string): RegExp {
  return new RegExp(`^${text}$`);
}
