import { test, expect } from '@fixtures/base.fixture';
import { makeStep } from '@utils/step';
import { skipTc, tcMeta } from '@utils/tc-meta';
import { isClipped } from '@utils/layout';
import { getAccountDisplayName } from '@utils/auth-token';
import { BIZ_PARTNER, BUCKET_SUFFIXES, VIRTUAL_LABEL, WH_TEXT, warehouseName } from '@utils/warehouse.data';
import { FIELD } from '@pages/warehouse-form.page';
import { WarehouseApi } from '@api/warehouse.api';

/**
 * Màn chi tiết/sửa 창고 (US069) — sửa field, khoá field bất biến, panel 상태 및 작업, 비활성화/재활성화/삭제, bucket chỉ đọc,
 * toast/dialog tiếng Hàn. Nguồn TC: input/US069_TestCases_EN_v1.20.md — mỗi dòng Steps N / Expected N map đúng 1 step
 * `Act: Step N` / `Assert: Expected N`. TC lệch UI thật → assert theo UI, ghi "Deviation from TC" (quyết định 28/09).
 *
 * Dữ liệu: mỗi test tự tạo warehouse `auto_US069_<TC>_<timestamp>` qua API (kèm 5 bucket) và xoá ở teardown.
 * 저장 trên màn sửa quay về 창고 목록 (verify 28/09) — bước "mở 변경 이력" mở lại màn chi tiết trước.
 */
const TAGS = ['ui', 'warehouse', 'warehouse-detail'];
const DEVIATION_DIALOG_TITLE = (verb: string) => `the dialog title reads "창고를 ${verb}할까요?" (TC: "이 창고를 ${verb}할까요?")`;
const DEVIATION_NO_CASCADE_LINE =
  'the dialog shows NO second body line "이 창고에 속한 시스템 관리 창고 {n}개도 함께 …됩니다." — the detail API does not return ' +
  'virtualWarehouseCount, which the page needs to render it (verified 28/09); reported to the BA/dev as a gap';
const STOCK_REASON =
  'needs stock records in the warehouse — the TC does not say how they are produced and dev offers no UI/API to create stock (only ' +
  'request/complete/cancel of existing inbound rows of real warehouses — verified 28/09).';
const STORE_REASON =
  'needs a store (US056) linked to the warehouse — the store register has no screen on dev and neither the TC nor the frontend gives the ' +
  'POST /api/v1/stores contract (required fields / values), so the store cannot be created without guessing (verified 28/09).';
const ACCOUNT_REASON = 'no account with MASTER_DATA read-only or without MASTER_DATA exists for this suite (decision 28/09).';

/** Mốc thời gian API (UTC) → chuỗi KST `YYYY-MM-DD HH:mm` như UI hiển thị. */
function toKst(iso: string): string {
  const kst = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return kst.toISOString().slice(0, 16).replace('T', ' ');
}

async function statusesOfFamily(api: WarehouseApi, parent: { id: number; name: string }): Promise<{ parent: string; buckets: string[] }> {
  const buckets = await api.bucketsOf(parent);
  return { parent: (await api.get(parent.id)).body.status, buckets: buckets.map((b) => b.status) };
}

test.describe('[Detail] 창고 Detail/Edit — edit, lifecycle actions, delete and read-only buckets', () => {
  test.describe.configure({ timeout: 120_000 });

  test('TC_US069_001 — A MASTER_DATA writable user has full access', async ({ page, warehouseListPage: list, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_001', 'Critical', [...TAGS, 'permission'], 'The writable ADMIN reaches the list, opens a warehouse, sees 창고 등록 / 저장 / 창고 비활성화 / 창고 삭제 visible and enabled (저장 once a field changes) and can save a change. Data: an automation-owned warehouse is created and deleted afterwards.');
    let id = 0;
    let name = '';
    let saveStatus = 0;

    await step('Arrange: Pre-condition 1 — The writable account is configured and an automation-owned warehouse exists', async () => {
      ({ id, name } = await warehouseCleanup.create('SUPPLIER', 'TC_US069_001'));
    });

    await step('Act: Step 1 — Log in with the writable account', async () => {
      await list.goto('/');
      await expect(page.getByRole('heading', { name: getAccountDisplayName('submitter') })).toBeVisible();
    });

    await step('Act: Step 2 — Open 창고 목록', async () => {
      await list.openFromSidebar();
    });

    await step('Assert: Expected 2 — The user can access 창고 목록', async () => {
      await expect(list.panelTitle, '[Expected 2] 창고 목록 is displayed').toBeVisible();
      await expect(list.tableRows.first(), '[Expected 2] Warehouse rows are listed').toBeVisible();
    });

    await step('Act: Step 3 — Open a warehouse detail record', async () => {
      await list.search({ keyword: name });
      await list.rowByName(name).click();
      await form.waitForDetailLoaded();
    });

    await step('Assert: Expected 3 — The user can open the warehouse detail', async () => {
      await expect(page, '[Expected 3] The detail route of the warehouse is open').toHaveURL(new RegExp(`/${id}$`));
      await expect(form.nameInput, '[Expected 3] The detail shows the warehouse').toHaveValue(name);
    });

    const actions = { deactivate: false, remove: false, save: false, add: false };
    await step('Act: Step 4 — Check the available actions (change 도시 and save, then back on the list)', async () => {
      actions.deactivate = await form.deactivateButton.isEnabled();
      actions.remove = await form.deleteButton.isEnabled();
      await form.cityInput.fill('Write access city');
      actions.save = await form.saveButton.isEnabled();
      saveStatus = (await form.saveAndWait()).status();
      await list.waitForListLoaded();
      actions.add = await list.addWarehouseButton.isEnabled();
    });

    await step('Assert: Expected 4 — 창고 등록, 저장, 창고 비활성화 and 창고 삭제 are visible and enabled; the write succeeds', async () => {
      expect(actions.add, '[Expected 4] 창고 등록 is visible and enabled').toBe(true);
      expect(actions.save, '[Expected 4] 저장 is enabled once a field changes').toBe(true);
      expect(actions.deactivate, '[Expected 4] 창고 비활성화 is visible and enabled').toBe(true);
      expect(actions.remove, '[Expected 4] 창고 삭제 is visible and enabled').toBe(true);
      expect(saveStatus, '[Expected 4] The save succeeded').toBe(200);
      expect((await warehouseApi.get(id)).body.city, '[Expected 4] The saved change is stored').toBe('Write access city');
    });
  });

  for (const lock of [
    { tc: 'TC_US069_019', priority: 'High' as const, title: '거래처 cannot be edited after creation', label: FIELD.bizPartner, value: BIZ_PARTNER.name, hint: WH_TEXT.hintBizPartnerLock, kind: 'SUPPLIER' as const },
    { tc: 'TC_US069_029', priority: 'High' as const, title: '창고 유형 cannot be edited after creation', label: FIELD.type, value: WH_TEXT.typeSupplier, hint: WH_TEXT.hintTypeLock, kind: 'SUPPLIER' as const },
    { tc: 'TC_US069_050', priority: 'High' as const, title: '물류 유형 cannot be edited after creation', label: FIELD.logisticsType, value: 'WMS', hint: WH_TEXT.hintLogisticsTypeLock, kind: 'PLATFORM_WMS_EGFLEX' as const },
  ]) {
    test(`${lock.tc} — ${lock.title}`, async ({ page, warehouseFormPage: form, warehouseCleanup }) => {
      const step = makeStep(page);
      await tcMeta(lock.tc, lock.priority, TAGS, `On Detail/Edit ${lock.label.replace(' *', '')} is disabled, keeps its current value (${lock.value}) and shows the lock hint. Data: an automation-owned warehouse is created and deleted afterwards.`);
      let id = 0;

      await step('Arrange: Pre-condition 1 — A warehouse has been created (automation-owned)', async () => {
        id = (await warehouseCleanup.create(lock.kind, lock.tc)).id;
      });

      await step('Act: Step 1 — Open the Detail/Edit screen of the created warehouse', async () => {
        await form.open(id);
      });

      await step(`Act: Step 2 — Observe the ${lock.label.replace(' *', '')} field`, async () => {
        await form.fieldControl(lock.label).scrollIntoViewIfNeeded();
      });

      await step(`Assert: Expected 2 — ${lock.label.replace(' *', '')} is disabled and still shows the current value`, async () => {
        await expect(form.fieldControl(lock.label), '[Expected 2] The field is disabled').toBeDisabled();
        await expect(form.fieldControl(lock.label).locator('option:checked'), `[Expected 2] The field still shows ${lock.value}`).toHaveText(lock.value);
        await expect(form.fieldHint(lock.label), '[Expected 2] The lock hint explains it cannot change').toHaveText(lock.hint);
      });
    });
  }

  test('TC_US069_064 — Detail/Edit displays the correct warehouse information', async ({ page, warehouseFormPage: form, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US069_064',
      'Medium',
      TAGS,
      'Detail/Edit shows 거래처, 창고 유형, 분류, the logistics / 3PL / CJ values, 상태, the created time, 연결된 재고 기록, 연결된 매장 and ' +
        '연결된 상품-창고 매핑, with 변경 이력 above the write actions. Deviation from TC: the created-time label reads 등록일시 (TC: 생성 일시). ' +
        'Not automated: that 연결된 재고 기록 spans the 5 buckets (needs stock data — see TC_075). Data: an automation-owned WMS warehouse is ' +
        'created and deleted afterwards.',
    );
    let detail: Awaited<ReturnType<typeof warehouseCleanup.create>> | undefined;

    await step('Arrange: Pre-condition 1 — A warehouse exists (automation-owned 플랫폼 물류 · WMS · EgFlex)', async () => {
      detail = await warehouseCleanup.create('PLATFORM_WMS_EGFLEX', 'TC_US069_064');
    });

    await step('Act: Step 1 — Open Warehouse Detail/Edit', async () => {
      await form.open(detail!.id);
    });

    await step('Act: Step 2 — Compare the form and the 상태 및 작업 pane', async () => {
      await form.panel.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Every value is displayed correctly and 변경 이력 sits above the write actions', async () => {
      await expect(form.bizPartnerSelect.locator('option:checked'), '[Expected 2] 거래처 is shown').toHaveText(BIZ_PARTNER.name);
      await expect(form.typeSelect.locator('option:checked'), '[Expected 2] 창고 유형 is shown').toHaveText(WH_TEXT.typePlatform);
      await expect(form.categoryInput, '[Expected 2] 분류 (form) is CJ 창고').toHaveValue(WH_TEXT.categoryCj);
      await expect(form.logisticsTypeSelect.locator('option:checked'), '[Expected 2] 물류 유형 is WMS').toHaveText('WMS');
      await expect(form.channelSelect.locator('option:checked'), '[Expected 2] 물류사 유형 is CJ대한통운(EgFlex)').toHaveText(WH_TEXT.channelEgFlex);
      await expect(form.cjWarehouseCodeInput, '[Expected 2] 물류사 창고 코드 is shown').toHaveValue(detail!.logisticsChannelWarehouseCode!);
      await expect(form.cjChannelCodeInput, '[Expected 2] 물류 채널 코드 is shown').toHaveValue(detail!.logisticsChannelCode!);
      await expect(form.panelValue('상태'), '[Expected 2] 상태 is 활성').toHaveText(WH_TEXT.statusActive);
      await expect(form.panelValue('물류사 유형'), '[Expected 2] Panel 물류사 유형 is shown').toHaveText(WH_TEXT.channelEgFlex);
      await expect(form.panelValue('분류'), '[Expected 2] Panel 분류 is shown').toHaveText(WH_TEXT.categoryCj);
      await expect(form.panelValue('등록일시'), '[Expected 2] Created time (등록일시) is shown in KST').toHaveText(toKst(detail!.createdAt));
      await expect(form.panelValue('연결된 재고 기록'), '[Expected 2] 연결된 재고 기록 is shown').toHaveText(String(detail!.linkedStockRecordCount));
      await expect(form.panelValue('연결된 매장'), '[Expected 2] 연결된 매장 is shown').toHaveText(String(detail!.linkedStoreCount));
      await expect(form.panelValue('연결된 상품-창고 매핑'), '[Expected 2] 연결된 상품-창고 매핑 is shown').toHaveText(/^\d+$/);
      const history = await form.historyButton.boundingBox();
      const deactivate = await form.deactivateButton.boundingBox();
      const remove = await form.deleteButton.boundingBox();
      expect(history!.y, '[Expected 2] 변경 이력 is above 창고 비활성화').toBeLessThan(deactivate!.y);
      expect(history!.y, '[Expected 2] 변경 이력 is above 창고 삭제').toBeLessThan(remove!.y);
    });
  });

  test('TC_US069_065 — Update editable fields on Detail/Edit', async ({ page, warehouseFormPage: form, warehouseListPage: list, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_065', 'Critical', TAGS, 'Editing 창고명 and saving succeeds with the save toast, and 변경 이력 shows one new UPDATED record for that field with the old value struck through and the new value in bold. Data: an automation-owned warehouse is created and deleted afterwards.');
    let original = { id: 0, name: '' };
    const newName = warehouseName('TC_US069_065', 'edited');
    let rows: string[][] = [];

    await step('Arrange: Pre-condition 1 — A non-virtual warehouse is available (automation-owned)', async () => {
      original = await warehouseCleanup.create('SUPPLIER', 'TC_US069_065');
    });

    await step('Act: Step 1 — Open Warehouse Detail/Edit', async () => {
      await form.open(original.id);
    });

    await step('Act: Step 2 — Edit an allowed field: 창고명', async () => {
      await form.nameInput.fill(newName);
    });

    await step('Act: Step 3 — Click 저장 (Save)', async () => {
      await form.saveAndWait();
      await list.waitForListLoaded();
    });

    await step('Assert: Expected 3 — The field is updated and the save toast is shown', async () => {
      await expect(form.toast(WH_TEXT.toastSaved), '[Expected 3] Toast "변경 사항이 저장되었습니다. 시스템 로그에 기록되었습니다." is shown').toBeVisible();
      expect((await warehouseApi.get(original.id)).body.name, '[Expected 3] 창고명 is updated').toBe(newName);
    });

    await step('Act: Step 4 — Open 변경 이력 (Change history)', async () => {
      await form.open(original.id);
      await form.openHistory();
      rows = await form.readHistoryRows();
    });

    await step('Assert: Expected 4 — One new UPDATED record for 창고명, old value struck through, new value bold', async () => {
      expect(rows.length, '[Expected 4] Created + one UPDATED record').toBe(2);
      expect(rows[0][2], '[Expected 4] The new record is on 창고명').toBe('창고명');
      await expect(form.historyChangeCell(0).locator('s'), '[Expected 4] The old value is struck through').toHaveText(original.name);
      await expect(form.historyChangeCell(0).locator('b'), '[Expected 4] The new value is bold').toHaveText(newName);
    });
  });

  test('TC_US069_066 — Updated data remains saved', async ({ page, warehouseFormPage: form, warehouseListPage: list, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_066', 'High', TAGS, 'After saving a change and returning to the list, reopening or refreshing Detail/Edit still shows the new value. Data: an automation-owned warehouse is created and deleted afterwards.');
    let id = 0;
    const city = `City ${Date.now()}`;
    const seen = { reopened: '', refreshed: '' };

    await step('Arrange: Pre-condition 1 — A warehouse is open on Detail/Edit with a changed 도시 (automation-owned)', async () => {
      id = (await warehouseCleanup.create('SUPPLIER', 'TC_US069_066')).id;
      await form.open(id);
      await form.cityInput.fill(city);
    });

    await step('Act: Step 1 — Save the change', async () => {
      await form.saveAndWait();
    });

    await step('Act: Step 2 — Return to 창고 목록', async () => {
      await list.waitForListLoaded();
    });

    await step('Act: Step 3 — Reopen Detail/Edit, then refresh the page', async () => {
      await form.open(id);
      seen.reopened = await form.cityInput.inputValue();
      await page.reload();
      await form.waitForDetailLoaded();
      seen.refreshed = await form.cityInput.inputValue();
    });

    await step('Assert: Expected 3 — The new value is kept after reopening and refreshing', async () => {
      expect(seen.reopened, '[Expected 3] 도시 shows the new value after reopening').toBe(city);
      expect(seen.refreshed, '[Expected 3] 도시 shows the new value after refreshing').toBe(city);
    });
  });

  test('TC_US069_067 — 분류 is read-only on Detail/Edit', async ({ page, warehouseFormPage: form, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_067', 'Medium', TAGS, 'On Detail/Edit 분류 shows the automatically calculated value and is read-only. Data: an automation-owned 일반 warehouse is created and deleted afterwards.');
    let id = 0;

    await step('Arrange: Pre-condition 1 — A warehouse has been created (automation-owned 플랫폼 물류 · 일반)', async () => {
      id = (await warehouseCleanup.create('PLATFORM_GENERAL', 'TC_US069_067')).id;
    });

    await step('Act: Step 1 — Open Warehouse Detail/Edit', async () => {
      await form.open(id);
    });

    await step('Act: Step 2 — Observe the 분류 field (and try typing into it)', async () => {
      await form.categoryInput.focus();
      await page.keyboard.type('MANUAL');
    });

    await step('Assert: Expected 2 — 분류 shows the calculated value and cannot be entered manually', async () => {
      await expect(form.categoryInput, '[Expected 2] 분류 is 일반 창고').toHaveValue(WH_TEXT.categoryGeneral);
      await expect(form.categoryInput, '[Expected 2] 분류 is read-only').toHaveAttribute('readonly', '');
    });
  });

  test('TC_US069_068 — 상태 and the three reference counts are read-only and counts never reach the history', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_068', 'Medium', TAGS, '상태, 연결된 재고 기록, 연결된 매장 and 연결된 상품-창고 매핑 are plain reference text on the pane; the history of a warehouse deactivated and reactivated records 상태 but never a count. Data: an automation-owned warehouse is created, toggled via API and deleted afterwards.');
    let id = 0;
    let history: string[][] = [];

    await step('Arrange: Pre-condition 1 — A warehouse has been created and deactivated/reactivated once (automation-owned)', async () => {
      id = (await warehouseCleanup.create('SUPPLIER', 'TC_US069_068')).id;
      await warehouseApi.deactivate(id, (await warehouseApi.get(id)).body.version);
      await warehouseApi.reactivate(id, (await warehouseApi.get(id)).body.version);
    });

    await step('Act: Step 1 — Open Warehouse Detail/Edit', async () => {
      await form.open(id);
    });

    await step('Act: Step 2 — Observe the 상태 및 작업 pane (and its change history)', async () => {
      await form.openHistory();
      history = await form.readHistoryRows();
      await form.closeHistory();
    });

    await step('Assert: Expected 2 — Values are reference-only and the counts are never in the history', async () => {
      for (const label of ['상태', '연결된 재고 기록', '연결된 매장', '연결된 상품-창고 매핑']) {
        await expect(form.panelValue(label), `[Expected 2] ${label} is displayed`).toBeVisible();
        await expect(form.panelValue(label).locator('input, select, textarea, [contenteditable="true"]'), `[Expected 2] ${label} cannot be edited`).toHaveCount(0);
      }
      const settings = history.map((row) => row[2]);
      expect(settings, '[Expected 2] 상태 IS recorded in the history').toContain('상태');
      for (const label of ['연결된 재고 기록', '연결된 매장', '연결된 상품-창고 매핑']) {
        expect(settings.join('\n'), `[Expected 2] ${label} is never written to the history`).not.toContain(label);
      }
    });
  });

  test('TC_US069_069 — The successful save notification', async ({ page, warehouseFormPage: form, warehouseListPage: list, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_069', 'Low', TAGS, 'Saving an edit (도시) shows "변경 사항이 저장되었습니다. 시스템 로그에 기록되었습니다." and 변경 이력 holds the matching UPDATED record. Data: an automation-owned warehouse is created and deleted afterwards.');
    let id = 0;
    let rows: string[][] = [];

    await step('Arrange: Pre-condition 1 — A non-virtual warehouse is available (automation-owned)', async () => {
      id = (await warehouseCleanup.create('SUPPLIER', 'TC_US069_069')).id;
      await form.open(id);
    });

    await step('Act: Step 1 — Update an editable field: 도시', async () => {
      await form.cityInput.fill('Log city');
    });

    await step('Act: Step 2 — Click 저장 (Save)', async () => {
      await form.saveAndWait();
      await list.waitForListLoaded();
    });

    await step('Assert: Expected 2 — "변경 사항이 저장되었습니다. 시스템 로그에 기록되었습니다." is shown', async () => {
      await expect(form.toast(WH_TEXT.toastSaved), '[Expected 2] The save toast is shown').toBeVisible();
    });

    await step('Act: Step 3 — Open 변경 이력 (Change history)', async () => {
      await form.open(id);
      await form.openHistory();
      rows = await form.readHistoryRows();
    });

    await step('Assert: Expected 3 — 변경 이력 contains the matching UPDATED record', async () => {
      expect(rows[0][2], '[Expected 3] The newest record is on 도시').toBe('도시');
      expect(rows[0][3], '[Expected 3] The record reads — → Log city').toContain('Log city');
    });
  });

  test('TC_US069_070 — An Active warehouse shows 창고 비활성화, not 재활성화', async ({ page, warehouseFormPage: form, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_070', 'Medium', TAGS, 'On an Active warehouse the pane shows 창고 비활성화 and does not show 재활성화. Data: an automation-owned warehouse is created and deleted afterwards.');
    let id = 0;

    await step('Arrange: Pre-condition 1 — The warehouse has 상태 = 활성 (automation-owned)', async () => {
      id = (await warehouseCleanup.create('SUPPLIER', 'TC_US069_070')).id;
    });

    await step('Act: Step 1 — Open the Detail/Edit screen of the Active warehouse', async () => {
      await form.open(id);
    });

    await step('Act: Step 2 — Observe the 상태 및 작업 pane', async () => {
      await form.panel.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — 창고 비활성화 is displayed and 재활성화 is not', async () => {
      await expect(form.deactivateButton, '[Expected 2] 창고 비활성화 is displayed').toBeVisible();
      await expect(form.reactivateButton, '[Expected 2] 재활성화 is not displayed').toHaveCount(0);
    });
  });

  test('TC_US069_071 — Deactivate a warehouse (cascades to its 5 buckets)', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    let parent = { id: 0, name: '' };
    await tcMeta(
      'TC_US069_071',
      'Critical',
      TAGS,
      'Deactivate opens the confirm dialog with 취소 / 비활성화; confirming closes it, turns the warehouse AND its 5 buckets 비활성 and shows ' +
        `the toast; 변경 이력 gets one UPDATED record on 상태 (활성 → 비활성) for the parent only. Deviation from TC: ${DEVIATION_DIALOG_TITLE('비활성화')}; ` +
        `${DEVIATION_NO_CASCADE_LINE}. Data: an automation-owned warehouse is created and deleted afterwards.`,
    );
    let rows: string[][] = [];
    let family = { parent: '', buckets: [] as string[] };
    let bucketHistory = 0;

    await step('Arrange: Pre-condition 1 — Active warehouse, 연결된 재고 기록 = 0 and 연결된 매장 = 0 (automation-owned)', async () => {
      parent = await warehouseCleanup.create('SUPPLIER', 'TC_US069_071');
      await form.open(parent.id);
    });

    await step('Act: Step 1 — Click 창고 비활성화 (Deactivate warehouse)', async () => {
      await form.openDeactivateDialog();
    });

    await step('Assert: Expected 1 — The deactivate dialog is displayed (see Deviation on title and the cascade line)', async () => {
      await expect(form.dialogTitle, '[Expected 1] Dialog title (Deviation: 창고를 비활성화할까요?)').toHaveText(WH_TEXT.deactivateTitle);
      await expect(form.dialogBodyLines.first(), '[Expected 1] The body names the warehouse and the consequence').toHaveText(WH_TEXT.deactivateBody(parent.name));
      await expect(form.dialog.getByText(WH_TEXT.cascadeDeactivate(5)), '[Expected 1] No cascade line is rendered (Deviation)').toHaveCount(0);
    });

    await step('Act: Step 2 — Observe the confirm dialog', async () => {
      await form.dialog.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — The dialog has 취소 and 비활성화', async () => {
      await expect(form.dialogCancelButton, '[Expected 2] 취소 (Cancel) is shown').toBeVisible();
      await expect(form.deactivateConfirmButton, '[Expected 2] 비활성화 (Deactivate) is shown').toBeVisible();
    });

    await step('Act: Step 3 — Click 비활성화 (Deactivate) in the dialog', async () => {
      await form.confirmDeactivate();
      await expect(form.reactivateButton).toBeVisible();
      family = await statusesOfFamily(warehouseApi, parent);
    });

    await step('Assert: Expected 3 — Dialog closed, the warehouse and its 5 buckets are 비활성, toast shown', async () => {
      await expect(form.dialog, '[Expected 3] The dialog is closed').toHaveCount(0);
      await expect(form.panelValue('상태'), '[Expected 3] 상태 reads 비활성').toHaveText(WH_TEXT.statusInactive);
      await expect(form.toast(WH_TEXT.toastDeactivated(parent.name)), '[Expected 3] The deactivation toast is shown').toBeVisible();
      expect(family.parent, '[Expected 3] The warehouse is INACTIVE').toBe('INACTIVE');
      expect(family.buckets, '[Expected 3] All 5 buckets are INACTIVE').toEqual(Array(5).fill('INACTIVE'));
    });

    await step('Act: Step 4 — Open 변경 이력 (Change history)', async () => {
      await form.openHistory();
      rows = await form.readHistoryRows();
      const buckets = await warehouseApi.bucketsOf(parent);
      bucketHistory = (await Promise.all(buckets.map((b) => warehouseApi.history(b.id)))).flat().length;
    });

    await step('Assert: Expected 4 — One UPDATED record on 상태 (활성 → 비활성) on the parent only', async () => {
      expect(rows.length, '[Expected 4] Created + one UPDATED record').toBe(2);
      expect(rows[0][2], '[Expected 4] The record is on 상태').toBe('상태');
      expect(rows[0][3], '[Expected 4] It reads 활성 → 비활성').toBe('활성 → 비활성');
      expect(bucketHistory, '[Expected 4] No history record is written for the buckets').toBe(0);
    });
  });

  test('TC_US069_072 — 취소 on the deactivate dialog keeps the status', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_072', 'Medium', TAGS, 'Cancelling the deactivate dialog closes it, the warehouse stays 활성 and no history record is written. Data: an automation-owned warehouse is created and deleted afterwards.');
    let id = 0;
    let rows: string[][] = [];

    await step('Arrange: Pre-condition 1 — Active warehouse with the deactivate dialog open (automation-owned)', async () => {
      id = (await warehouseCleanup.create('SUPPLIER', 'TC_US069_072')).id;
      await form.open(id);
      await form.openDeactivateDialog();
    });

    await step('Act: Step 1 — Click 취소 (Cancel)', async () => {
      await form.click(form.dialogCancelButton, '취소 (Cancel) button in the dialog');
    });

    await step('Act: Step 2 — Observe the status of the warehouse', async () => {
      await form.panel.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — The dialog closes and the warehouse stays 활성', async () => {
      await expect(form.dialog, '[Expected 2] The dialog is closed').toHaveCount(0);
      await expect(form.panelValue('상태'), '[Expected 2] 상태 still reads 활성').toHaveText(WH_TEXT.statusActive);
      expect((await warehouseApi.get(id)).body.status, '[Expected 2] Stored status is ACTIVE').toBe('ACTIVE');
    });

    await step('Act: Step 3 — Open 변경 이력 (Change history)', async () => {
      await form.openHistory();
      rows = await form.readHistoryRows();
    });

    await step('Assert: Expected 3 — No history record is written for the cancelled action', async () => {
      expect(rows.length, '[Expected 3] Only the Created record exists').toBe(1);
      expect(rows[0][2], '[Expected 3] That record is 생성').toBe(WH_TEXT.historyCreatedChip);
    });
  });

  test('TC_US069_073 — Reactivate a warehouse (no dialog, cascades to its buckets)', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_073', 'High', TAGS, '재활성화 turns the warehouse and its 5 buckets 활성 immediately without a confirm dialog and shows the toast; 변경 이력 gets one UPDATED record 비활성 → 활성 on the parent. Data: an automation-owned warehouse is created, deactivated via API and deleted afterwards.');
    let parent = { id: 0, name: '' };
    let rows: string[][] = [];
    let family = { parent: '', buckets: [] as string[] };
    let dialogsShown = 0;

    await step('Arrange: Pre-condition 1 — The warehouse has 상태 = 비활성 (automation-owned, deactivated via API)', async () => {
      parent = await warehouseCleanup.create('SUPPLIER', 'TC_US069_073');
      await warehouseApi.deactivate(parent.id, (await warehouseApi.get(parent.id)).body.version);
    });

    await step('Act: Step 1 — Open the Detail/Edit screen of the Inactive warehouse', async () => {
      await form.open(parent.id);
    });

    await step('Act: Step 2 — Click 재활성화 (Reactivate)', async () => {
      await form.reactivate();
      dialogsShown = await form.dialog.count();
      await expect(form.deactivateButton).toBeVisible();
      family = await statusesOfFamily(warehouseApi, parent);
    });

    await step('Assert: Expected 2 — 활성 immediately without a dialog, for the warehouse and its 5 buckets, with the toast', async () => {
      expect(dialogsShown, '[Expected 2] No confirm dialog is shown').toBe(0);
      await expect(form.panelValue('상태'), '[Expected 2] 상태 reads 활성').toHaveText(WH_TEXT.statusActive);
      await expect(form.toast(WH_TEXT.toastReactivated(parent.name)), '[Expected 2] The reactivation toast is shown').toBeVisible();
      expect(family.parent, '[Expected 2] The warehouse is ACTIVE').toBe('ACTIVE');
      expect(family.buckets, '[Expected 2] All 5 buckets are ACTIVE').toEqual(Array(5).fill('ACTIVE'));
    });

    await step('Act: Step 3 — Open 변경 이력 (Change history)', async () => {
      await form.openHistory();
      rows = await form.readHistoryRows();
    });

    await step('Assert: Expected 3 — One UPDATED record 비활성 → 활성 on the parent, recorded like Deactivate', async () => {
      expect(rows[0][2], '[Expected 3] The newest record is on 상태').toBe('상태');
      expect(rows[0][3], '[Expected 3] It reads 비활성 → 활성').toBe('비활성 → 활성');
      expect(rows[1][3], '[Expected 3] The deactivation before it reads 활성 → 비활성 — same format').toBe('활성 → 비활성');
    });
  });

  test('TC_US069_074 — 상태 persists after switching 활성/비활성', async ({ page, warehouseFormPage: form, warehouseListPage: list, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_074', 'High', TAGS, 'After a deactivation, refreshing or reopening Detail/Edit still shows 비활성. Data: an automation-owned warehouse is created, deactivated and deleted afterwards.');
    let id = 0;
    const seen = { refreshed: '', reopened: '' };

    await step('Arrange: Pre-condition 1 — The warehouse has just been deactivated (automation-owned)', async () => {
      id = (await warehouseCleanup.create('SUPPLIER', 'TC_US069_074')).id;
      await form.open(id);
      await form.openDeactivateDialog();
      await form.confirmDeactivate();
      await expect(form.reactivateButton).toBeVisible();
      expect((await warehouseApi.get(id)).body.status).toBe('INACTIVE');
    });

    await step('Act: Step 1 — Refresh the page, then go back to 창고 목록 and reopen the warehouse', async () => {
      await page.reload();
      await form.waitForDetailLoaded();
      seen.refreshed = (await form.panelValue('상태').textContent())?.trim() ?? '';
      await list.reloadingList(() => form.backToList());
      await form.open(id);
    });

    await step('Act: Step 2 — Observe the 상태', async () => {
      seen.reopened = (await form.panelValue('상태').textContent())?.trim() ?? '';
    });

    await step('Assert: Expected 2 — The new 상태 is kept after refreshing and reopening', async () => {
      expect(seen.refreshed, '[Expected 2] 상태 reads 비활성 after refresh').toBe(WH_TEXT.statusInactive);
      expect(seen.reopened, '[Expected 2] 상태 reads 비활성 after reopening').toBe(WH_TEXT.statusInactive);
      await expect(form.headerStatusBadge, '[Expected 2] The header badge reads 비활성').toHaveText(WH_TEXT.statusInactive);
    });
  });

  test('TC_US069_075 — 창고 삭제 is disabled when 연결된 재고 기록 > 0', async () => {
    await skipTc('TC_US069_075', 'Critical', TAGS, 'With stock records > 0 and stores = 0 the Delete button is disabled and the tooltip names only the stock cause.', STOCK_REASON);
  });

  test('TC_US069_076 — 창고 삭제 is enabled with no references and deletes the warehouse with its buckets', async ({ page, warehouseFormPage: form, warehouseListPage: list, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_076', 'Medium', TAGS, 'With all three counts = 0 the 창고 삭제 button is enabled; 영구 삭제 removes the warehouse and its 5 buckets, returns to 창고 목록 and none of the six rows is listed or readable any more (checked through the API instead of SQL). Data: the automation-owned warehouse is deleted by the test itself.');
    let parent = { id: 0, name: '' };
    let bucketIds: number[] = [];
    let after = { parent: 0, buckets: [] as number[], listed: -1 };

    await step('Arrange: Pre-condition 1 — Warehouse with 연결된 재고 기록 = 0, 연결된 매장 = 0, 연결된 상품-창고 매핑 = 0 (automation-owned)', async () => {
      parent = await warehouseCleanup.create('PLATFORM_GENERAL', 'TC_US069_076');
      bucketIds = (await warehouseApi.bucketsOf(parent)).map((b) => b.id);
    });

    await step('Act: Step 1 — Open Warehouse Detail/Edit', async () => {
      await form.open(parent.id);
    });

    await step('Act: Step 2 — Observe the 창고 삭제 (Delete warehouse) button', async () => {
      await form.deleteButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — 창고 삭제 is enabled', async () => {
      await expect(form.deleteButton, '[Expected 2] 창고 삭제 is enabled').toBeEnabled();
    });

    await step('Act: Step 3 — Click 창고 삭제 (Delete warehouse)', async () => {
      await form.openDeleteDialog();
    });

    await step('Act: Step 4 — Click 영구 삭제 (Delete permanently) in the dialog', async () => {
      await form.confirmDelete();
      await list.waitForListLoaded();
    });

    await step('Act: Step 5 — Check 창고 목록 again', async () => {
      await list.search({ keyword: parent.name });
      after = {
        parent: (await warehouseApi.get(parent.id)).status,
        buckets: await Promise.all(bucketIds.map(async (id) => (await warehouseApi.get(id)).status)),
        listed: await list.tableRows.count(),
      };
    });

    await step('Assert: Expected 5 — The warehouse and its 5 buckets are gone; the user is back on the list', async () => {
      await expect(page, '[Expected 5] The user is back on 창고 목록').toHaveURL(/\/commerce\/warehouses(\?.*)?$/);
      expect(after.listed, '[Expected 5] Neither the warehouse nor its buckets appear in the list').toBe(0);
      expect(after.parent, '[Expected 5] The warehouse no longer exists (404)').toBe(404);
      expect(after.buckets, '[Expected 5] None of the 5 buckets exists any more (404)').toEqual(Array(5).fill(404));
    });
  });

  test('TC_US069_077 — The confirm delete dialog', async ({ page, warehouseFormPage: form, warehouseCleanup }) => {
    const step = makeStep(page);
    let parent = { id: 0, name: '' };
    await tcMeta(
      'TC_US069_077',
      'Medium',
      TAGS,
      'The delete dialog explains the record can be deleted, that it cannot be undone and is recorded in the system log. Deviation from TC: ' +
        `${DEVIATION_DIALOG_TITLE('삭제')}; body line 1 reads "{name} 레코드는 참조하는 재고 기록이 없어 삭제할 수 있습니다. 이 작업은 되돌릴 수 없으며 ` +
        `시스템 로그에 기록됩니다." (TC wording differs slightly); ${DEVIATION_NO_CASCADE_LINE}. Data: an automation-owned warehouse is created ` +
        'and deleted afterwards (the dialog is cancelled).',
    );

    await step('Arrange: Pre-condition 1 — Warehouse with all three counts = 0 (automation-owned)', async () => {
      parent = await warehouseCleanup.create('SUPPLIER', 'TC_US069_077');
      await form.open(parent.id);
    });

    await step('Act: Step 1 — Click 창고 삭제 (Delete warehouse)', async () => {
      await form.openDeleteDialog();
    });

    await step('Act: Step 2 — Observe the confirm delete dialog', async () => {
      await form.dialog.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Title, body line 1 with the name, cannot-be-undone emphasis (see Deviation)', async () => {
      await expect(form.dialogTitle, '[Expected 2] Title (Deviation: 창고를 삭제할까요?)').toHaveText(WH_TEXT.deleteTitle);
      await expect(form.dialogBodyLines.first(), '[Expected 2] Body line 1 names the record and states it cannot be undone').toHaveText(WH_TEXT.deleteBody(parent.name));
      await expect(form.dialogBodyLines.first().locator('strong', { hasText: '되돌릴 수 없으며' }), '[Expected 2] "되돌릴 수 없으며" is emphasised').toBeVisible();
      await expect(form.dialog.getByText(WH_TEXT.cascadeDelete(5)), '[Expected 2] No cascade line is rendered (Deviation)').toHaveCount(0);
      await expect(form.deleteConfirmButton, '[Expected 2] 영구 삭제 is offered').toBeVisible();
    });
  });

  test('TC_US069_078 — 취소 on the delete dialog keeps the warehouse', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_078', 'High', TAGS, 'Cancelling the delete dialog closes it, the warehouse still exists and no history record is written. Data: an automation-owned warehouse is created and deleted afterwards.');
    let id = 0;
    let rows: string[][] = [];

    await step('Arrange: Pre-condition 1 — Warehouse with no references and the delete dialog open (automation-owned)', async () => {
      id = (await warehouseCleanup.create('SUPPLIER', 'TC_US069_078')).id;
      await form.open(id);
      await form.openDeleteDialog();
    });

    await step('Act: Step 1 — Click 취소 (Cancel)', async () => {
      await form.click(form.dialogCancelButton, '취소 (Cancel) button in the dialog');
    });

    await step('Act: Step 2 — Observe the warehouse on Detail/Edit', async () => {
      await form.panel.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — The dialog closes and the warehouse still exists', async () => {
      await expect(form.dialog, '[Expected 2] The dialog is closed').toHaveCount(0);
      await expect(page, '[Expected 2] Detail/Edit is still open').toHaveURL(new RegExp(`/${id}$`));
      expect((await warehouseApi.get(id)).status, '[Expected 2] The warehouse still exists').toBe(200);
    });

    await step('Act: Step 3 — Open 변경 이력 (Change history)', async () => {
      await form.openHistory();
      rows = await form.readHistoryRows();
    });

    await step('Assert: Expected 3 — No history record is written for the cancelled action', async () => {
      expect(rows.length, '[Expected 3] Only the Created record exists').toBe(1);
    });
  });

  test('TC_US069_080 — A virtual bucket is read-only', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US069_080',
      'High',
      TAGS,
      'Every field of a bucket is locked; the panel shows "System (virtual)" for 물류사 유형 and 분류; the bucket name follows ' +
        '"{parent name} - {type}". Deviation from TC: on the FORM 창고 유형 shows the stored type 플랫폼 물류 and 분류 shows "—" (only the panel ' +
        'reads System (virtual)); the name suffix is Korean — 매출대기 / 이동중 / 폐기 / 이슈격리 / 불량 (TC example: "CJ Daegu - In-transit"). ' +
        'Data: an automation-owned warehouse (5 buckets) is created and deleted afterwards.',
    );
    let parent = { id: 0, name: '' };
    let bucket = { id: 0, name: '' };

    await step('Arrange: Pre-condition 1 — A physical warehouse with its 5 provisioned buckets (automation-owned); pick its 이동중 (In-transit) bucket', async () => {
      parent = await warehouseCleanup.create('PLATFORM_WMS_EGFLEX', 'TC_US069_080');
      bucket = (await warehouseApi.bucketsOf(parent)).find((b) => b.name.endsWith(' - 이동중'))!;
    });

    await step('Act: Step 1 — Open the Detail/Edit screen of the bucket', async () => {
      await form.open(bucket.id);
    });

    await step('Act: Step 2 — Observe the warehouse information fields', async () => {
      await form.formCard.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Everything is locked, the panel reads System (virtual), the name follows the convention', async () => {
      const controls = form.formCard.locator('select, input:not([id^="react-select"]), textarea');
      const count = await controls.count();
      expect(count, '[Expected 2] The bucket form has fields').toBeGreaterThan(5);
      for (let i = 0; i < count; i += 1) {
        const control = controls.nth(i);
        const locked = await control.evaluate((el) => (el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly);
        expect(locked, `[Expected 2] Field ${i + 1} (${await control.evaluate((el) => el.closest('div.col-md-6, div.col-md-12')?.querySelector('label')?.textContent)}) is locked`).toBe(true);
      }
      // Bucket: ô 국가 bị khoá render thành chữ (không còn combobox — verify 29/09) → khoá = không còn control sửa được.
      await expect(form.field(FIELD.country).locator('input:not([disabled]), select:not([disabled])'), '[Expected 2] 국가 is locked (no editable control)').toHaveCount(0);
      await expect(form.field(FIELD.country), '[Expected 2] 국가 still shows its value').toContainText('대한민국 (KR)');
      await expect(form.panelValue('물류사 유형'), '[Expected 2] Panel 물류사 유형 reads System (virtual)').toHaveText(VIRTUAL_LABEL);
      await expect(form.panelValue('분류'), '[Expected 2] Panel 분류 reads System (virtual)').toHaveText(VIRTUAL_LABEL);
      await expect(form.nameInput, '[Expected 2] Name follows "{parent} - {type}"').toHaveValue(`${parent.name} - 이동중`);
    });
  });

  test('TC_US069_081 — A virtual bucket cannot be created, edited, deleted or toggled', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_081', 'Critical', TAGS, 'A bucket exposes no 저장, 창고 비활성화, 재활성화, 창고 삭제 or 변경 이력 action (the system note replaces them), and 창고 등록 offers no system-managed logistics type (Pending revenue / In-transit / Scrap / Quarantine / Defective), so a bucket cannot be created by hand. The API refusal of direct bucket writes is covered by TC_US069_172. Data: an automation-owned warehouse is created and deleted afterwards.');
    let bucketId = 0;
    const seen = { buttons: [] as string[], logisticsTypes: [] as string[] };

    await step('Arrange: Pre-condition 1 — A physical warehouse with its 5 provisioned buckets (automation-owned)', async () => {
      const parent = await warehouseCleanup.create('SUPPLIER', 'TC_US069_081');
      bucketId = (await warehouseApi.bucketsOf(parent))[0].id;
    });

    await step('Act: Step 1 — Open the Detail/Edit screen of the bucket', async () => {
      await form.open(bucketId);
    });

    await step('Act: Step 2 — Observe the 저장, 창고 비활성화, 재활성화, 창고 삭제 and 변경 이력 actions', async () => {
      seen.buttons = (await page.locator('div.main-content').getByRole('button').allInnerTexts()).map((t) => t.trim());
    });

    await step('Act: Step 3 — Open 창고 등록 and check the options to create a warehouse', async () => {
      await form.openCreate();
      await form.typeSelect.selectOption({ label: WH_TEXT.typePlatform });
      seen.logisticsTypes = (await form.logisticsTypeSelect.locator('option').allTextContents()).map((t) => t.trim());
    });

    await step('Assert: Expected 3 — The bucket has no write action and no bucket type can be created manually', async () => {
      for (const action of ['저장', '창고 비활성화', '재활성화', '창고 삭제', '변경 이력']) {
        expect(seen.buttons.some((b) => b.includes(action)), `[Expected 3] The bucket offers no ${action} action`).toBe(false);
      }
      for (const virtual of ['Pending revenue', 'In-transit', 'Scrap', 'Quarantine', 'Defective']) {
        expect(seen.logisticsTypes, `[Expected 3] 창고 등록 does not offer ${virtual}`).not.toContain(virtual);
      }
    });
  });

  test('TC_US069_093 — Korean toasts for create, update, deactivate, reactivate and delete', async ({ page, warehouseFormPage: form, warehouseListPage: list, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_093', 'Medium', [...TAGS, 'i18n'], 'Each action shows its Korean toast, carrying the warehouse name where applicable: 창고가 등록되었습니다 — 즉시 적용됩니다. / 변경 사항이 저장되었습니다. 시스템 로그에 기록되었습니다. / “{name}” 창고가 비활성화되었습니다. / “{name}” 창고가 재활성화되었습니다. / “{name}” 창고가 삭제되었습니다. 시스템 로그에 기록되었습니다. Data: the warehouse created in Step 1 is deleted in Step 4 (and by teardown if the test fails earlier).');
    const name = warehouseName('TC_US069_093');
    let id = 0;
    const toasts: Record<string, boolean> = {};

    await step('Arrange: Pre-condition 1 — ADMIN with 한국어 is on 창고 등록', async () => {
      await form.openCreate();
      warehouseCleanup.trackName(name);
    });

    await step('Act: Step 1 — Create a valid warehouse', async () => {
      await form.fill({ bizPartner: BIZ_PARTNER.name, name, type: WH_TEXT.typeSupplier, addr: 'Automation street 93', zipCode: '21500', number: '0321234567' });
      await form.saveAndWait();
      await list.waitForListLoaded();
      id = (await warehouseApi.listAll({ name })).find((w) => w.name === name && !w.virtual)!.id;
    });

    await step('Assert: Expected 1 — "창고가 등록되었습니다 — 즉시 적용됩니다." is shown', async () => {
      await expect(form.toast(WH_TEXT.toastCreated), '[Expected 1] The create toast is shown').toBeVisible();
    });

    await step('Act: Step 2 — Update the warehouse', async () => {
      await form.open(id);
      await form.cityInput.fill('Toast city');
      await form.saveAndWait();
      await list.waitForListLoaded();
    });

    await step('Assert: Expected 2 — "변경 사항이 저장되었습니다. 시스템 로그에 기록되었습니다." is shown', async () => {
      await expect(form.toast(WH_TEXT.toastSaved), '[Expected 2] The update toast is shown').toBeVisible();
    });

    await step('Act: Step 3 — Deactivate, then reactivate the warehouse', async () => {
      await form.open(id);
      await form.openDeactivateDialog();
      await form.confirmDeactivate();
      toasts.deactivated = await form.toast(WH_TEXT.toastDeactivated(name)).waitFor({ timeout: 10_000 }).then(() => true, () => false);
      await form.reactivate();
      toasts.reactivated = await form.toast(WH_TEXT.toastReactivated(name)).waitFor({ timeout: 10_000 }).then(() => true, () => false);
    });

    await step('Assert: Expected 3 — Both toasts read in Korean with the warehouse name', async () => {
      expect(toasts.deactivated, `[Expected 3] "“${name}” 창고가 비활성화되었습니다." was shown`).toBe(true);
      expect(toasts.reactivated, `[Expected 3] "“${name}” 창고가 재활성화되었습니다." was shown`).toBe(true);
    });

    await step('Act: Step 4 — Delete the warehouse (연결된 재고 기록 = 0)', async () => {
      await form.openDeleteDialog();
      await form.confirmDelete();
    });

    await step('Assert: Expected 4 — The delete toast reads in Korean with the warehouse name', async () => {
      await expect(form.toast(WH_TEXT.toastDeleted(name)), `[Expected 4] "“${name}” 창고가 삭제되었습니다. 시스템 로그에 기록되었습니다." is shown`).toBeVisible();
    });
  });

  test('TC_US069_094 — Korean dialogs: deactivate, delete, change history and save conflict', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    let parent = { id: 0, name: '' };
    await tcMeta(
      'TC_US069_094',
      'Medium',
      [...TAGS, 'i18n'],
      'The deactivate, delete, 변경 이력 and 저장 충돌 dialogs read in Korean with the right title, content and buttons. Deviation from TC: ' +
        `${DEVIATION_DIALOG_TITLE('비활성화')} / ${DEVIATION_DIALOG_TITLE('삭제')}; ${DEVIATION_NO_CASCADE_LINE}. The "second session" of Step 7 ` +
        'is an API write on the same warehouse. Not automated: the 변경 이력 empty state and the over-100 note (a fresh warehouse always has its ' +
        'Created record and fewer than 100 records — see TC_US069_120 / _121). Data: an automation-owned warehouse is created and deleted afterwards.',
    );

    await step('Arrange: Pre-condition 1 — ADMIN with 한국어; a warehouse eligible for deactivate and delete (automation-owned)', async () => {
      parent = await warehouseCleanup.create('SUPPLIER', 'TC_US069_094');
      await form.open(parent.id);
    });

    await step('Act: Step 1 — Open the 창고 비활성화 dialog', async () => {
      await form.openDeactivateDialog();
    });

    await step('Assert: Expected 1 — The deactivate dialog opens', async () => {
      await expect(form.dialog, '[Expected 1] The dialog is open').toBeVisible();
    });

    await step('Act: Step 2 — Observe title, content and buttons', async () => {
      await form.dialog.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Title, consequences with the name, 취소 / 비활성화 in Korean', async () => {
      await expect(form.dialogTitle, '[Expected 2] Title (Deviation: 창고를 비활성화할까요?)').toHaveText(WH_TEXT.deactivateTitle);
      await expect(form.dialogBodyLines.first(), '[Expected 2] Content states the consequence and the name').toHaveText(WH_TEXT.deactivateBody(parent.name));
      await expect(form.dialogCancelButton, '[Expected 2] 취소').toBeVisible();
      await expect(form.deactivateConfirmButton, '[Expected 2] 비활성화').toBeVisible();
      await expect(form.dialog.getByText(WH_TEXT.cascadeDeactivate(5)), '[Expected 2] No cascade line is rendered (Deviation)').toHaveCount(0);
    });

    await step('Act: Step 3 — Close it and open the 창고 삭제 dialog', async () => {
      await form.click(form.dialogCancelButton, '취소 (Cancel) button in the dialog');
      await form.openDeleteDialog();
    });

    await step('Assert: Expected 3 — The delete dialog opens', async () => {
      await expect(form.dialog, '[Expected 3] The dialog is open').toBeVisible();
    });

    await step('Act: Step 4 — Observe title, content and buttons', async () => {
      await form.dialog.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — Title, cannot-be-undone content, 취소 / 영구 삭제, nothing clipped', async () => {
      await expect(form.dialogTitle, '[Expected 4] Title (Deviation: 창고를 삭제할까요?)').toHaveText(WH_TEXT.deleteTitle);
      await expect(form.dialogBodyLines.first(), '[Expected 4] Content says it cannot be undone').toContainText('되돌릴 수 없으며');
      await expect(form.dialogCancelButton, '[Expected 4] 취소').toBeVisible();
      await expect(form.deleteConfirmButton, '[Expected 4] 영구 삭제').toBeVisible();
      expect(await isClipped(form.dialog.locator('.modal-content')), '[Expected 4] No dialog text is clipped').toBe(false);
      await expect(form.dialog.getByText(WH_TEXT.cascadeDelete(5)), '[Expected 4] No cascade line is rendered (Deviation)').toHaveCount(0);
    });

    await step('Act: Step 5 — Close it and open the 변경 이력 dialog', async () => {
      await form.click(form.dialogCancelButton, '취소 (Cancel) button in the dialog');
      await form.openHistory();
    });

    await step('Assert: Expected 5 — The 변경 이력 dialog opens', async () => {
      await expect(form.historyDialog, '[Expected 5] The dialog is open').toBeVisible();
    });

    await step('Act: Step 6 — Observe the title, the four headers, the Created chip and the notes', async () => {
      await form.historyDialog.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 6 — 변경 이력, 변경 일시 · 변경자 · 항목 · 변경 내용 and the 생성 chip', async () => {
      await expect(form.historyDialog.locator('.modal-title'), '[Expected 6] Title reads 변경 이력').toContainText(WH_TEXT.historyTitle);
      await expect(form.historyHeaders, '[Expected 6] The four Korean headers').toHaveText(WH_TEXT.historyHeaders);
      await expect(form.historyRows.last().locator('.badge'), '[Expected 6] The first record chip reads 생성').toHaveText(WH_TEXT.historyCreatedChip);
    });

    await step('Act: Step 7 — Trigger the 저장 충돌 dialog (another write lands first, then 저장)', async () => {
      await form.closeHistory();
      await form.cityInput.fill('Session A city');
      const latest = (await warehouseApi.get(parent.id)).body;
      await warehouseApi.update(parent.id, WarehouseApi.toUpdateBody(latest, { zipCode: '21999' }));
      await form.saveAndWait();
    });

    await step('Assert: Expected 7 — The 저장 충돌 dialog opens', async () => {
      await expect(form.conflictDialog, '[Expected 7] The conflict dialog is open').toBeVisible();
    });

    await step('Act: Step 8 — Observe the title, message, attribution line and the two buttons', async () => {
      await form.conflictDialog.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 8 — 저장 충돌, the message, "{name}님이 {time}에 변경했습니다", 다시 불러오기 and 덮어쓰기', async () => {
      await expect(form.conflictDialog.locator('.modal-title'), '[Expected 8] Title 저장 충돌').toHaveText(WH_TEXT.conflictTitle);
      await expect(form.conflictMessage, '[Expected 8] 이 창고는 다른 사용자가 변경했습니다.').toHaveText(WH_TEXT.conflictMessage);
      await expect(form.conflictAttribution, '[Expected 8] Attribution line').toHaveText(WH_TEXT.conflictAttribution(getAccountDisplayName('submitter')));
      await expect(form.conflictReloadButton, '[Expected 8] 다시 불러오기').toBeVisible();
      await expect(form.conflictOverwriteButton, '[Expected 8] 덮어쓰기').toBeVisible();
      const text = (await form.conflictDialog.innerText()).replace(getAccountDisplayName('submitter'), '');
      expect(text, '[Expected 8] No English string remains (the account name aside)').not.toMatch(/[A-Za-z]/);
    });
  });

  for (const skip of [
    { tc: 'TC_US069_096', priority: 'High' as const, title: '창고 비활성화 is disabled while an active store uses the warehouse', description: 'With an active store linked, 창고 비활성화 is disabled with the store-named tooltip.', reason: STORE_REASON },
    { tc: 'TC_US069_097', priority: 'High' as const, title: '창고 비활성화 is enabled while only an inactive store uses the warehouse', description: 'With only an inactive store linked, 창고 비활성화 is enabled with no blocking reason.', reason: STORE_REASON },
    { tc: 'TC_US069_098', priority: 'Medium' as const, title: 'Deactivate is re-checked server-side at the moment of the click', description: 'A store activated by another session between opening and confirming makes the deactivation fail naming the store.', reason: STORE_REASON },
    { tc: 'TC_US069_099', priority: 'Critical' as const, title: '창고 삭제 is disabled when 연결된 매장 > 0', description: 'With stores > 0 the Delete button is disabled and the tooltip names only the store cause.', reason: STORE_REASON },
    { tc: 'TC_US069_104', priority: 'Medium' as const, title: 'Write controls are disabled for a MASTER_DATA read-only user', description: 'A read-only user sees every write control disabled and 변경 이력 enabled.', reason: ACCOUNT_REASON },
    { tc: 'TC_US069_105', priority: 'Medium' as const, title: 'Users without MASTER_DATA cannot access the warehouse screens', description: 'A user without MASTER_DATA gets the authorization error (403) and sees no warehouse data.', reason: ACCOUNT_REASON },
    { tc: 'TC_US069_107', priority: 'High' as const, title: '변경 이력 is available to a MASTER_DATA read-only user', description: 'A read-only user can open 변경 이력 while every write action stays disabled.', reason: ACCOUNT_REASON },
  ]) {
    test(`${skip.tc} — ${skip.title}`, async () => {
      await skipTc(skip.tc, skip.priority, TAGS, skip.description, skip.reason);
    });
  }

  test('TC_US069_106 — 변경 이력 is shown on Detail/Edit above the write actions, not in create mode', async ({ page, warehouseFormPage: form, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_106', 'Medium', TAGS, 'On a non-virtual warehouse 변경 이력 is displayed above 창고 비활성화 / 창고 삭제 in a neutral (light) style; the create screen has no 변경 이력. Data: an automation-owned warehouse is created and deleted afterwards.');
    let id = 0;
    const seen = { createButtons: [] as string[] };

    await step('Arrange: Pre-condition 1–2 — A non-virtual warehouse exists and ADMIN is writable (automation-owned)', async () => {
      id = (await warehouseCleanup.create('SUPPLIER', 'TC_US069_106')).id;
    });

    await step('Act: Step 1 — Open the Detail/Edit screen of the non-virtual warehouse', async () => {
      await form.open(id);
    });

    await step('Act: Step 2 — Observe the 상태 및 작업 pane', async () => {
      await form.panel.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — 변경 이력 is displayed above the write actions in a neutral style', async () => {
      await expect(form.historyButton, '[Expected 2] 변경 이력 is displayed').toBeVisible();
      const [history, deactivate, remove] = await Promise.all([form.historyButton.boundingBox(), form.deactivateButton.boundingBox(), form.deleteButton.boundingBox()]);
      expect(history!.y, '[Expected 2] It sits above 창고 비활성화').toBeLessThan(deactivate!.y);
      expect(history!.y, '[Expected 2] It sits above 창고 삭제').toBeLessThan(remove!.y);
      await expect(form.historyButton, '[Expected 2] It uses the neutral light style').toHaveClass(/btn-light/);
      await expect(form.historyButton, '[Expected 2] It is not styled as a write action').not.toHaveClass(/btn-(primary|danger|secondary)\b/);
    });

    await step('Act: Step 3 — Open 창고 등록 and observe the same area', async () => {
      await form.openCreate();
      seen.createButtons = (await page.locator('div.main-content').getByRole('button').allInnerTexts()).map((t) => t.trim());
    });

    await step('Assert: Expected 3 — 변경 이력 is not displayed in create mode', async () => {
      expect(seen.createButtons.some((b) => b.includes('변경 이력')), '[Expected 3] No 변경 이력 button on the create screen').toBe(false);
      await expect(form.panel, '[Expected 3] The create screen has no 상태 및 작업 pane').toHaveCount(0);
    });
  });

  test('TC_US069_108 — 변경 이력 is absent on a virtual bucket', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_108', 'High', TAGS, 'A bucket\'s pane renders no 변경 이력 button at all (not merely disabled) — the whole actions block is replaced by the system-managed note; a non-virtual warehouse has the button. Data: an automation-owned warehouse is created and deleted afterwards.');
    let parent = { id: 0, name: '' };
    let bucketId = 0;
    let normalHasHistory = false;

    await step('Arrange: Pre-condition 1 — A physical warehouse exists; pick its 불량 (Defective) bucket (automation-owned)', async () => {
      parent = await warehouseCleanup.create('SUPPLIER', 'TC_US069_108');
      bucketId = (await warehouseApi.bucketsOf(parent)).find((b) => b.name.endsWith(` - ${BUCKET_SUFFIXES[4]}`))!.id;
    });

    await step('Act: Step 1 — Open the Detail/Edit screen of the bucket', async () => {
      await form.open(bucketId);
    });

    await step('Act: Step 2 — Observe the 상태 및 작업 pane', async () => {
      await form.panel.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — 변경 이력 is absent and the system note replaces the actions', async () => {
      await expect(form.historyButton, '[Expected 2] 변경 이력 is not rendered').toHaveCount(0);
      await expect(form.panelActionButtons, '[Expected 2] The pane renders no action button at all').toHaveCount(0);
      await expect(form.systemNote, '[Expected 2] The system-managed note is shown').toHaveText(WH_TEXT.systemNote);
    });

    await step('Act: Step 3 — Compare with the normal non-virtual warehouse', async () => {
      await form.open(parent.id);
      normalHasHistory = await form.historyButton.isVisible();
    });

    await step('Assert: Expected 3 — The non-virtual warehouse has 변경 이력', async () => {
      expect(normalHasHistory, '[Expected 3] 변경 이력 is present on the non-virtual warehouse').toBe(true);
    });
  });
});
