import { test, expect } from '@fixtures/base.fixture';
import { makeStep } from '@utils/step';
import { skipTc, tcMeta } from '@utils/tc-meta';
import { hasHorizontalPageScroll, isClipped } from '@utils/layout';
import { getAccountDisplayName, hasCredentials } from '@utils/auth-token';
import { switchAccount } from '@utils/switch-account';
import { WH_TEXT, warehouseName } from '@utils/warehouse.data';
import { WarehouseApi } from '@api/warehouse.api';

/**
 * Dialog 변경 이력 của 창고 (US069 BR-10) — bố cục, nhãn, bản ghi Created/Updated, allow-list, thứ tự, snapshot khi mở.
 * Nguồn TC: input/US069_TestCases_EN_v1.20.md — mỗi dòng Steps N / Expected N map đúng 1 step `Act: Step N` /
 * `Assert: Expected N`. TC lệch UI thật → assert theo UI, ghi "Deviation from TC" (quyết định 28/09).
 *
 * Dữ liệu: mỗi test tự tạo warehouse `auto_US069_<TC>_<timestamp>` và xoá ở teardown. "Phiên B / admin khác" sửa cùng
 * warehouse được mô phỏng bằng 1 lần ghi qua API (cùng backend, cùng version check); TC cần danh tính admin khác dùng account
 * approver qua switchAccount.
 * Ô 변경 내용 xếp chồng mỗi field 1 dòng `span.d-block`, giá trị cũ trong `<s>`, giá trị mới trong `<b>` (verify 28/09).
 */
const TAGS = ['ui', 'warehouse', 'warehouse-history'];

/** Sửa field qua API trên bản mới nhất — mô phỏng lần lưu của phiên/admin khác. */
async function apiSave(api: WarehouseApi, id: number, patch: Parameters<typeof WarehouseApi.toUpdateBody>[1]): Promise<void> {
  const latest = (await api.get(id)).body;
  const result = await api.update(id, WarehouseApi.toUpdateBody(latest, patch));
  if (result.status !== 200) throw new Error(`Test data setup failed — PATCH returned ${result.status}: ${JSON.stringify(result.body)}`);
}

test.describe('[History] 창고 변경 이력 dialog', () => {
  test.describe.configure({ timeout: 120_000 });

  test('TC_US069_109 — Change history dialog layout, columns and close control', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_109', 'High', TAGS, 'The dialog opens over the form with title 변경 이력 and "{id} · {name}", exactly four columns (변경 일시 · 변경자 · 항목 · 변경 내용) with no reason column, a close button, and no action on any record row. Data: an automation-owned warehouse with one update is created and deleted afterwards.');
    let wh = { id: 0, name: '' };

    await step('Arrange: Pre-condition 1 — A non-virtual warehouse with at least one change record (automation-owned)', async () => {
      wh = await warehouseCleanup.create('SUPPLIER', 'TC_US069_109');
      await apiSave(warehouseApi, wh.id, { city: 'History city' });
    });

    await step('Act: Step 1 — Open Warehouse Detail/Edit', async () => {
      await form.open(wh.id);
    });

    await step('Act: Step 2 — Click 변경 이력 (Change history)', async () => {
      await form.openHistory();
    });

    await step('Assert: Expected 2 — The dialog opens over the form', async () => {
      await expect(form.historyDialog, '[Expected 2] The 변경 이력 dialog is open').toBeVisible();
      await expect(form.nameInput, '[Expected 2] The form stays behind the dialog').toHaveValue(wh.name);
    });

    await step('Act: Step 3 — Observe the dialog title, the table columns and the controls', async () => {
      await form.historyDialog.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Title with "{id} · {name}", exactly four columns, no reason column, a close button', async () => {
      await expect(form.historyDialog.locator('.modal-title'), '[Expected 3] Title reads 변경 이력').toContainText(WH_TEXT.historyTitle);
      await expect(form.historySubtitle, '[Expected 3] "{id} · {name}" is shown beside the title').toHaveText(`${wh.id} · ${wh.name}`);
      await expect(form.historyHeaders, '[Expected 3] Exactly four columns 변경 일시 · 변경자 · 항목 · 변경 내용').toHaveText(WH_TEXT.historyHeaders);
      await expect(form.historyHeaders.filter({ hasText: /사유|Reason/ }), '[Expected 3] There is no reason column').toHaveCount(0);
      await expect(form.historyCloseButton, '[Expected 3] A close button is displayed').toBeVisible();
    });

    await step('Act: Step 4 — Try to edit or delete a record row', async () => {
      await form.historyRows.first().click();
    });

    await step('Assert: Expected 4 — No row action exists; the log is append-only', async () => {
      await expect(form.historyRows.locator('button, a, input, select, textarea, [contenteditable="true"]'), '[Expected 4] No record row offers an action').toHaveCount(0);
      expect((await form.readHistoryRows()).length, '[Expected 4] The records are unchanged after clicking a row').toBe(2);
    });
  });

  test('TC_US069_110 — Korean labels of the change history dialog', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_110', 'Medium', [...TAGS, 'i18n'], 'Title 변경 이력, headers 변경 일시 · 변경자 · 항목 · 변경 내용 and the first-record chip 생성 read in Korean, nothing clipped. Not automated: the over-100 note and the empty-state note are not reachable on a fresh warehouse here (they are covered by TC_US069_121 / skipped TC_US069_120). Data: an automation-owned warehouse is created and deleted afterwards.');
    let id = 0;

    await step('Arrange: Pre-condition 1–2 — ADMIN with 한국어; a non-virtual warehouse with change records (automation-owned)', async () => {
      id = (await warehouseCleanup.create('SUPPLIER', 'TC_US069_110')).id;
      await apiSave(warehouseApi, id, { city: '인천' });
      await form.open(id);
    });

    await step('Act: Step 1 — Open 변경 이력 (Change history)', async () => {
      await form.openHistory();
    });

    await step('Act: Step 2 — Observe the dialog title and the four column headers', async () => {
      await form.historyHeaders.first().scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — 변경 이력 and 변경 일시 · 변경자 · 항목 · 변경 내용, no English header', async () => {
      await expect(form.historyDialog.locator('.modal-title'), '[Expected 2] Title reads 변경 이력').toContainText(WH_TEXT.historyTitle);
      await expect(form.historyHeaders, '[Expected 2] The four Korean headers').toHaveText(WH_TEXT.historyHeaders);
      for (const header of await form.historyHeaders.allTextContents()) expect(header, `[Expected 2] "${header}" has no English`).not.toMatch(/[A-Za-z]/);
    });

    await step('Act: Step 3 — Observe the first record chip', async () => {
      await form.historyRows.last().scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — The first record chip reads 생성', async () => {
      await expect(form.historyRows.last().locator('.badge'), '[Expected 3] Chip reads 생성').toHaveText(WH_TEXT.historyCreatedChip);
    });

    await step('Act: Step 4 — Observe the over-100 note and the empty-state note if reachable', async () => {
      await form.historyDialog.locator('.modal-body').scrollIntoViewIfNeeded();
    });

    // Ghi chú over-100 / empty state không đạt tới được trên warehouse mới — Not automated (xem description).
    await step('Assert: Expected 4 — Notes readable, nothing clipped (notes themselves Not automated — not reachable)', async () => {
      expect(await isClipped(form.historyDialog.locator('.modal-header')), '[Expected 4] The title is not clipped').toBe(false);
      expect(await isClipped(form.historyDialog.locator('thead')), '[Expected 4] The headers are not clipped').toBe(false);
    });
  });

  test('TC_US069_111 — Create writes exactly one 생성 record as the first entry', async ({ page, warehouseFormPage: form, warehouseListPage: list, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_111', 'Critical', TAGS, 'A warehouse created on the UI has exactly one history record: the 생성 chip with 변경일시 and 변경자 filled and 변경 내용 "—". Data: the created warehouse is deleted afterwards.');
    const name = warehouseName('TC_US069_111');
    let id = 0;
    let rows: string[][] = [];

    await step('Arrange: Pre-condition 1 — ADMIN can create a warehouse', async () => {
      await form.openCreate();
      warehouseCleanup.trackName(name);
    });

    await step('Act: Step 1 — Create a new warehouse with valid data and click 저장', async () => {
      await form.fill({ bizPartner: '카카오엔터테인먼트 테스트', name, type: WH_TEXT.typeSupplier, addr: 'Automation street 111', zipCode: '21500', number: '0321234567' });
      await form.saveAndWait();
      await list.waitForListLoaded();
      id = (await warehouseApi.listAll({ name })).find((w) => w.name === name && !w.virtual)!.id;
    });

    await step('Act: Step 2 — Open its Warehouse Detail/Edit', async () => {
      await form.open(id);
    });

    await step('Act: Step 3 — Click 변경 이력 (Change history)', async () => {
      await form.openHistory();
      rows = await form.readHistoryRows();
    });

    await step('Assert: Expected 3 — Exactly one 생성 record, 변경일시 and 변경자 filled, 변경 내용 "—"', async () => {
      expect(rows.length, '[Expected 3] Exactly one record').toBe(1);
      expect(rows[0][0], '[Expected 3] 변경 일시 is filled (YYYY-MM-DD HH:mm)').toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      expect(rows[0][1], '[Expected 3] 변경자 is the acting admin').toBe(getAccountDisplayName('submitter'));
      expect(rows[0][2], '[Expected 3] The record is the 생성 chip').toBe(WH_TEXT.historyCreatedChip);
      expect(rows[0][3], '[Expected 3] 변경 내용 reads "—"').toBe(WH_TEXT.none);
    });
  });

  test('TC_US069_112 — One save that changes several fields produces exactly one record', async ({ page, warehouseFormPage: form, warehouseListPage: list, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_112', 'Critical', TAGS, 'Changing 창고명 and 전화번호 in one save adds exactly ONE record whose 항목 cell has two lines (창고명, 전화번호) aligned with two 변경 내용 lines, each old value struck through and new value bold. Data: an automation-owned warehouse is created and deleted afterwards.');
    let wh = { id: 0, name: '', callingCode: '', number: '' };
    const newName = warehouseName('TC_US069_112', 'renamed');
    let rows: string[][] = [];

    await step('Arrange: Pre-condition 1 — A non-virtual warehouse with a known 창고명 and 전화번호 (automation-owned)', async () => {
      wh = await warehouseCleanup.create('SUPPLIER', 'TC_US069_112');
    });

    await step('Act: Step 1 — Open the Warehouse Detail/Edit', async () => {
      await form.open(wh.id);
    });

    await step('Act: Step 2 — In the same edit, change both 창고명 and 전화번호', async () => {
      await form.nameInput.fill(newName);
      await form.numberInput.fill('010-5555-1212');
    });

    await step('Act: Step 3 — Click 저장 (Save)', async () => {
      await form.saveAndWait();
      await list.waitForListLoaded();
    });

    await step('Act: Step 4 — Open 변경 이력 (Change history)', async () => {
      await form.open(wh.id);
      await form.openHistory();
      rows = await form.readHistoryRows();
    });

    await step('Assert: Expected 4 — One new record with two aligned lines, old struck through and new bold', async () => {
      expect(rows.length, '[Expected 4] Exactly one new record (Created + 1)').toBe(2);
      const settings = form.historyRows.first().locator('td').nth(2).locator('span.d-block');
      const changes = form.historyChangeCell(0).locator('span.d-block');
      await expect(settings, '[Expected 4] 항목 has two lines: 창고명, 전화번호').toHaveText(['창고명', '전화번호']);
      await expect(changes, '[Expected 4] 변경 내용 has two lines aligned with 항목').toHaveCount(2);
      await expect(changes.nth(0).locator('s'), '[Expected 4] Line 1 old name is struck through').toHaveText(wh.name);
      await expect(changes.nth(0).locator('b'), '[Expected 4] Line 1 new name is bold').toHaveText(newName);
      await expect(changes.nth(1).locator('s'), '[Expected 4] Line 2 old phone is struck through').toHaveText(`${wh.callingCode} ${wh.number}`);
      await expect(changes.nth(1).locator('b'), '[Expected 4] Line 2 new phone is bold').toHaveText(`${wh.callingCode} 01055551212`);
    });
  });

  test('TC_US069_113 — 항목 shows the screen field label, never a DB column or change type', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_113', 'High', TAGS, 'The 항목 (Setting) column reads the Detail/Edit labels — 창고명 and 거리(상세) 주소 — never "name" / "addr" / "address" nor "UPDATED" / "CREATED". Data: an automation-owned warehouse with one 창고명 and one address update is created and deleted afterwards.');
    let id = 0;
    let settings: string[] = [];

    await step('Arrange: Pre-condition 1 — A warehouse with one update on 창고명 and one on 거리(상세) 주소 (automation-owned)', async () => {
      const wh = await warehouseCleanup.create('SUPPLIER', 'TC_US069_113');
      id = wh.id;
      await apiSave(warehouseApi, id, { name: `${wh.name}_2` });
      await apiSave(warehouseApi, id, { addr: 'Automation street 113' });
      await form.open(id);
    });

    await step('Act: Step 1 — Open 변경 이력 (Change history)', async () => {
      await form.openHistory();
    });

    await step('Act: Step 2 — Observe the 항목 column of every record', async () => {
      settings = (await form.readHistoryRows()).map((row) => row[2]);
    });

    await step('Assert: Expected 2 — Screen labels only, never a column name or change type', async () => {
      expect(settings, '[Expected 2] The address record reads 거리(상세) 주소').toContain('거리(상세) 주소');
      expect(settings, '[Expected 2] The name record reads 창고명').toContain('창고명');
      for (const setting of settings) {
        expect(setting, `[Expected 2] "${setting}" is not a DB column name`).not.toMatch(/^(name|addr|address)$/i);
        expect(setting, `[Expected 2] "${setting}" is not a change type`).not.toMatch(/UPDATED|CREATED/);
      }
    });
  });

  test('TC_US069_114 — A status change is rendered as a label, not a raw enum', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_114', 'High', TAGS, 'The status record reads 활성 → 비활성 with the old value struck through and the new one bold — never active → inactive or ACTIVE → INACTIVE. Data: an automation-owned warehouse is deactivated once and deleted afterwards.');
    let id = 0;
    let index = -1;

    await step('Arrange: Pre-condition 1 — A warehouse deactivated at least once (automation-owned)', async () => {
      id = (await warehouseCleanup.create('SUPPLIER', 'TC_US069_114')).id;
      await warehouseApi.deactivate(id, (await warehouseApi.get(id)).body.version);
      await form.open(id);
    });

    await step('Act: Step 1 — Open 변경 이력 (Change history)', async () => {
      await form.openHistory();
    });

    await step('Act: Step 2 — Locate the record for the status change', async () => {
      index = (await form.readHistoryRows()).findIndex((row) => row[2] === '상태');
    });

    await step('Act: Step 3 — Observe the 변경 내용 cell', async () => {
      await form.historyChangeCell(Math.max(index, 0)).scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — 활성 → 비활성 as labels, old struck through, new bold', async () => {
      expect(index, '[Expected 3] A status record exists').toBeGreaterThanOrEqual(0);
      await expect(form.historyChangeCell(index), '[Expected 3] The cell reads 활성 → 비활성').toHaveText('활성 → 비활성');
      await expect(form.historyChangeCell(index).locator('s'), '[Expected 3] 활성 is struck through').toHaveText(WH_TEXT.statusActive);
      await expect(form.historyChangeCell(index).locator('b'), '[Expected 3] 비활성 is bold').toHaveText(WH_TEXT.statusInactive);
      await expect(form.historyChangeCell(index), '[Expected 3] No raw enum value is shown').not.toContainText(/active|ACTIVE|inactive|INACTIVE/);
    });
  });

  test('TC_US069_115 — Every field in the allow-list is recorded', async ({ page, warehouseFormPage: form, warehouseListPage: list, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US069_115',
      'Critical',
      TAGS,
      'Separate saves of 창고명, 도시, 전화번호, the deactivation and 물류사 창고 코드 (A12 → A21) each produce one record with the right before/after ' +
        'values; the CJ code record reads 항목 = 물류사 창고 코드, ~~A12~~ → **A21**. Not automated: Step 6 and its record (3PL connection ' +
        'CJ대한통운(EgFlex) → 연동 없음) — for a WMS warehouse 물류사 유형 does not offer 연동 없음 and the API rejects WMS + NONE with ' +
        'WH-WAREHOUSE_INVALID_LOGISTICS_COMBINATION (verified 28/09, see TC_US069_170), so that change cannot be made on any client. ' +
        'Deviation from TC: the city record reads 항목 = 도시 (TC: "Address (City)"). Data: an automation-owned WMS warehouse is created and deleted afterwards.',
    );
    let wh = { id: 0, name: '', callingCode: '', number: '' };
    let rows: string[][] = [];
    const saveOnUi = async (fill: () => Promise<void>) => {
      await form.open(wh.id);
      await fill();
      await form.saveAndWait();
      await list.waitForListLoaded();
    };

    await step('Arrange: Pre-condition 1 — A non-virtual warehouse exists (automation-owned WMS · EgFlex, 물류사 창고 코드 = A12)', async () => {
      wh = await warehouseCleanup.create('PLATFORM_WMS_EGFLEX', 'TC_US069_115');
    });

    await step('Act: Step 1 — Change 창고명 only and click 저장', async () => {
      await saveOnUi(() => form.nameInput.fill(`${wh.name}_n`));
    });

    await step('Act: Step 2 — Change 도시 only and click 저장', async () => {
      await saveOnUi(() => form.cityInput.fill('Allow city'));
    });

    await step('Act: Step 3 — Change 전화번호 only and click 저장', async () => {
      await saveOnUi(() => form.numberInput.fill('0317778888'));
    });

    await step('Act: Step 4 — Deactivate the warehouse', async () => {
      await form.open(wh.id);
      await form.openDeactivateDialog();
      await form.confirmDeactivate();
      await expect(form.reactivateButton).toBeVisible();
    });

    await step('Act: Step 5 — Change 물류사 창고 코드 from "A12" to "A21" and click 저장', async () => {
      await saveOnUi(() => form.cjWarehouseCodeInput.fill('A21'));
    });

    // Step 6 (EgFlex → 연동 없음) không thực hiện được trên WMS — Not automated (xem description).
    await step('Act: Step 6 — Change 물류사 유형 from CJ대한통운(EgFlex) to 연동 없음 (not offered for WMS — Not automated)', async () => {
      await form.open(wh.id);
      await expect(form.channelSelect.locator('option', { hasText: /^연동 없음$/ })).toHaveCount(0);
    });

    await step('Act: Step 7 — Open 변경 이력 (Change history)', async () => {
      await form.openHistory();
      rows = await form.readHistoryRows();
    });

    await step('Assert: Expected 7 — One record per save with the right before/after values', async () => {
      const updates = rows.slice(0, -1).reverse();
      expect(updates.length, '[Expected 7] Five automatable saves produced five records (Step 6 Not automated)').toBe(5);
      expect(updates.map((row) => row[2]), '[Expected 7] 항목 of the five records in save order').toEqual(['창고명', '도시', '전화번호', '상태', '물류사 창고 코드']);
      expect(updates[0][3], '[Expected 7] 창고명 before → after').toBe(`${wh.name} → ${wh.name}_n`);
      expect(updates[1][3], '[Expected 7] 도시 — → after (City IS recorded)').toContain('Allow city');
      expect(updates[2][3], '[Expected 7] 전화번호 before → after').toBe(`${wh.callingCode} ${wh.number} → ${wh.callingCode} 0317778888`);
      expect(updates[3][3], '[Expected 7] 상태 활성 → 비활성').toBe('활성 → 비활성');
      expect(updates[4][3], '[Expected 7] 물류사 창고 코드 A12 → A21').toBe('A12 → A21');
      await expect(form.historyChangeCell(0).locator('s'), '[Expected 7] A12 is struck through').toHaveText('A12');
      await expect(form.historyChangeCell(0).locator('b'), '[Expected 7] A21 is bold').toHaveText('A21');
    });
  });

  test('TC_US069_116 — Fields outside the allow-list are never recorded', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_116', 'Medium', TAGS, 'After several saves no record or stacked line refers to 물류 유형, the row version, created/updated timestamps or the reference counts. Deviation from TC: the reference counts of an automation-owned warehouse stay 0 (changing them needs other modules\' data), so the check covers saves of every editable field plus a status round trip. Data: an automation-owned warehouse is created and deleted afterwards.');
    let id = 0;
    let lines: string[] = [];

    await step('Arrange: Pre-condition 1 — A warehouse saved several times (automation-owned)', async () => {
      id = (await warehouseCleanup.create('PLATFORM_WMS_EGFLEX', 'TC_US069_116')).id;
      await apiSave(warehouseApi, id, { city: 'C1', stateOrProvince: 'S1', detailAddr: 'D1' });
      await apiSave(warehouseApi, id, { zipCode: '11111', logisticsChannelCode: 'CH02', logisticsChannelInfo: '{"A":"B"}' });
      await warehouseApi.deactivate(id, (await warehouseApi.get(id)).body.version);
      await warehouseApi.reactivate(id, (await warehouseApi.get(id)).body.version);
      await form.open(id);
    });

    await step('Act: Step 1 — Open 변경 이력 (Change history)', async () => {
      await form.openHistory();
    });

    await step('Act: Step 2 — Inspect every record and every stacked line', async () => {
      lines = await form.historyRows.locator('td:nth-child(3) span.d-block, td:nth-child(3)').allInnerTexts();
    });

    await step('Assert: Expected 2 — No line refers to 물류 유형, the version, timestamps or reference counts', async () => {
      expect(lines.length, '[Expected 2] Records were inspected').toBeGreaterThan(3);
      for (const forbidden of ['물류 유형', 'version', '버전', '등록일시', 'createdAt', 'updatedAt', '연결된 재고 기록', '연결된 매장', '연결된 상품-창고 매핑']) {
        expect(lines.join('\n'), `[Expected 2] No line refers to "${forbidden}"`).not.toContain(forbidden);
      }
    });
  });

  test('TC_US069_117 — 거래처 never appears as a diff line', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_117', 'Medium', TAGS, 'No record after 생성 carries a 거래처 before/after line (the column is not updatable). Not automated: Expected 2 — the Created snapshot content is not exposed by the dialog (its 변경 내용 reads "—") nor by the history API (changes = []), so "the snapshot contains 거래처" cannot be observed. Data: an automation-owned warehouse edited twice is deleted afterwards.');
    let id = 0;
    let rows: string[][] = [];

    await step('Arrange: Pre-condition 1 — A warehouse created on this system and edited at least once (automation-owned)', async () => {
      id = (await warehouseCleanup.create('SUPPLIER', 'TC_US069_117')).id;
      await apiSave(warehouseApi, id, { city: 'Partner city' });
      await apiSave(warehouseApi, id, { zipCode: '22222' });
      await form.open(id);
    });

    await step('Act: Step 1 — Open 변경 이력 (Change history)', async () => {
      await form.openHistory();
      rows = await form.readHistoryRows();
    });

    await step('Act: Step 2 — Inspect the 생성 (Created) record', async () => {
      await form.historyRows.last().scrollIntoViewIfNeeded();
    });

    // Snapshot của bản ghi 생성 không hiển thị trên UI/API — Not automated (xem description).
    await step('Assert: Expected 2 — The Created record is present (its snapshot content is Not automated)', async () => {
      expect(rows[rows.length - 1][2], '[Expected 2] The oldest record is 생성').toBe(WH_TEXT.historyCreatedChip);
    });

    await step('Act: Step 3 — Inspect every later record', async () => {
      await form.historyRows.first().scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — No later record carries a 거래처 line', async () => {
      for (const row of rows.slice(0, -1)) expect(row[2], `[Expected 3] Record "${row[2]}" has no 거래처 line`).not.toContain('거래처');
    });
  });

  test('TC_US069_118 — A save that changes nothing writes no record', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_118', 'High', TAGS, 'With no field changed, 저장 is a no-op and the record count stays the same. Deviation from TC: 저장 is disabled while nothing differs from the stored record, so the "save" is a no-op by construction — the test clicks it (force) and checks no PATCH is sent and the count is unchanged. Data: an automation-owned warehouse is created and deleted afterwards.');
    let id = 0;
    let before = 0;
    let after = 0;
    const writes: string[] = [];

    await step('Arrange: Pre-condition 1 — A non-virtual warehouse with at least one history record (automation-owned)', async () => {
      id = (await warehouseCleanup.create('SUPPLIER', 'TC_US069_118')).id;
      await apiSave(warehouseApi, id, { city: 'Noop city' });
      await form.open(id);
      page.on('request', (r) => r.method() === 'PATCH' && writes.push(r.url()));
    });

    await step('Act: Step 1 — Open 변경 이력 and note the number of records', async () => {
      await form.openHistory();
      before = (await form.readHistoryRows()).length;
    });

    await step('Act: Step 2 — Close the dialog', async () => {
      await form.closeHistory();
    });

    await step('Act: Step 3 — Click 저장 without changing any field', async () => {
      await form.saveButton.click({ force: true });
    });

    await step('Assert: Expected 3 — The save is a no-op without error', async () => {
      await expect(form.saveButton, '[Expected 3] 저장 is disabled with nothing to save').toBeDisabled();
      expect(writes, '[Expected 3] No update request is sent').toEqual([]);
      await expect(form.pageError, '[Expected 3] No error is shown').toHaveCount(0);
    });

    await step('Act: Step 4 — Open 변경 이력 again and count the records', async () => {
      await form.openHistory();
      after = (await form.readHistoryRows()).length;
    });

    await step('Assert: Expected 4 — The number of records is unchanged', async () => {
      expect(after, '[Expected 4] No new record was written').toBe(before);
    });
  });

  test('TC_US069_119 — Deactivate / Reactivate write an ordinary UPDATED record on 상태', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_119', 'High', TAGS, 'Each lifecycle action adds ONE ordinary record on 상태 — 활성 → 비활성, then 비활성 → 활성 — with no separate event type or screen, and no record is written for the 5 buckets in either direction. Data: an automation-owned warehouse is created and deleted afterwards.');
    let parent = { id: 0, name: '' };
    let afterDeactivate: string[][] = [];
    let afterReactivate: string[][] = [];
    let bucketRecords = -1;

    await step('Arrange: Pre-condition 1 — Active warehouse with 0 references and its 5 buckets (automation-owned)', async () => {
      parent = await warehouseCleanup.create('SUPPLIER', 'TC_US069_119');
      await form.open(parent.id);
    });

    await step('Act: Step 1 — Click 창고 비활성화 and confirm in the dialog', async () => {
      await form.openDeactivateDialog();
      await form.confirmDeactivate();
      await expect(form.reactivateButton).toBeVisible();
    });

    await step('Act: Step 2 — Open 변경 이력 (Change history)', async () => {
      await form.openHistory();
    });

    await step('Act: Step 3 — Observe the newest record', async () => {
      afterDeactivate = await form.readHistoryRows();
      await form.closeHistory();
    });

    await step('Assert: Expected 2/3 — One ordinary record on 상태: 활성 → 비활성', async () => {
      expect(afterDeactivate.length, '[Expected 2/3] Exactly one new record').toBe(2);
      expect(afterDeactivate[0][2], '[Expected 2/3] It is on 상태 — no separate event type').toBe('상태');
      expect(afterDeactivate[0][3], '[Expected 2/3] It reads 활성 → 비활성').toBe('활성 → 비활성');
    });

    await step('Act: Step 4 — Click 재활성화 (Reactivate)', async () => {
      await form.reactivate();
      await expect(form.deactivateButton).toBeVisible();
    });

    await step('Act: Step 5 — Open 변경 이력 (Change history)', async () => {
      await form.openHistory();
    });

    await step('Act: Step 6 — Observe the newest record', async () => {
      afterReactivate = await form.readHistoryRows();
      const buckets = await warehouseApi.bucketsOf(parent);
      bucketRecords = (await Promise.all(buckets.map((b) => warehouseApi.history(b.id)))).flat().length;
    });

    await step('Assert: Expected 5/6 — One ordinary record 비활성 → 활성, none for the buckets', async () => {
      expect(afterReactivate.length, '[Expected 5/6] Exactly one more record').toBe(3);
      expect(afterReactivate[0][2], '[Expected 5/6] It is on 상태, recorded like Deactivate').toBe('상태');
      expect(afterReactivate[0][3], '[Expected 5/6] It reads 비활성 → 활성').toBe('비활성 → 활성');
      expect(afterReactivate[0][3], '[Expected 5/6] It does not enumerate the buckets').not.toContain(' - ');
      expect(bucketRecords, '[Expected 5/6] No history record exists for the 5 buckets').toBe(0);
    });
  });

  test('TC_US069_120 — Empty state when a warehouse has no history record', async () => {
    await skipTc(
      'TC_US069_120',
      'Medium',
      TAGS,
      'A warehouse with no history record shows the four headers above "변경 이력이 없습니다" and the pre-module explanation, not an error.',
      'the pre-condition needs a controlled data-fix (a warehouse row without any history record); every warehouse created through the API starts with its Created record, and the log must not be edited.',
    );
  });

  test('TC_US069_121 — Only the 100 most recent records are loaded, with no pagination', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    test.setTimeout(240_000);
    const step = makeStep(page);
    await tcMeta('TC_US069_121', 'Medium', TAGS, 'With more than 100 records the dialog shows exactly the 100 most recent and the note "최근 변경 100건을 표시합니다." under the table, with no pagination. Data: an automation-owned warehouse receives 101 API updates (102 records) and is deleted afterwards.');
    let id = 0;
    let rows: string[][] = [];

    await step('Arrange: Pre-condition 1 — A warehouse with more than 100 history records (automation-owned, 101 updates via API)', async () => {
      id = (await warehouseCleanup.create('SUPPLIER', 'TC_US069_121')).id;
      for (let i = 1; i <= 101; i += 1) await apiSave(warehouseApi, id, { city: `City ${i}` });
      await form.open(id);
    });

    await step('Act: Step 1 — Open 변경 이력 (Change history)', async () => {
      await form.openHistory();
    });

    await step('Act: Step 2 — Count the records and scroll to the bottom of the table', async () => {
      rows = await form.readHistoryRows();
      await form.historyRows.last().scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Exactly the 100 most recent records and the note "최근 변경 100건을 표시합니다."', async () => {
      expect(rows.length, '[Expected 2] Exactly 100 records are displayed').toBe(100);
      expect(rows[0][3], '[Expected 2] The newest record (update 101) is first').toContain('City 101');
      expect(rows[99][3], '[Expected 2] The 100th record is update 2 — the two oldest are not loaded').toContain('City 2');
      await expect(form.historyDialog.getByText('최근 변경 100건을 표시합니다.', { exact: true }), '[Expected 2] The over-100 note is shown').toBeVisible();
      await expect(form.historyDialog.locator('.pagination'), '[Expected 2] There is no pagination inside the dialog').toHaveCount(0);
    });
  });

  test('TC_US069_122 — Records are sorted newest first by record order', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_122', 'Medium', TAGS, 'Two saves made within the same minute are listed newest first (save B above save A) and 변경 일시 uses YYYY-MM-DD HH:mm. Data: an automation-owned warehouse is created and deleted afterwards.');
    let id = 0;
    let rows: string[][] = [];

    await step('Arrange: Pre-condition 1 — A warehouse on which two saves can be made within one minute (automation-owned)', async () => {
      id = (await warehouseCleanup.create('SUPPLIER', 'TC_US069_122')).id;
    });

    await step('Act: Step 1 — Perform save A, then save B, less than a minute apart', async () => {
      await apiSave(warehouseApi, id, { city: 'Save A' });
      await apiSave(warehouseApi, id, { city: 'Save B' });
      await form.open(id);
    });

    await step('Act: Step 2 — Open 변경 이력 (Change history)', async () => {
      await form.openHistory();
    });

    await step('Act: Step 3 — Observe the order of the two newest records and the 변경 일시 format', async () => {
      rows = await form.readHistoryRows();
    });

    await step('Assert: Expected 2/3 — Save B is above save A; 변경 일시 is YYYY-MM-DD HH:mm', async () => {
      expect(rows[0][3], '[Expected 2/3] The top record is save B').toContain('Save B');
      expect(rows[1][3], '[Expected 2/3] Save A is directly below').toContain('Save A');
      for (const row of rows) expect(row[0], `[Expected 2/3] "${row[0]}" uses YYYY-MM-DD HH:mm`).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });
  });

  test('TC_US069_123 — The dialog is a snapshot taken when it opens', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_123', 'Medium', TAGS, 'An open history dialog is not refreshed when another admin saves; reopening shows the new record; saving the stale form behind it is refused with 409 and the 저장 충돌 dialog. Deviation from TC: session B is an API save on the same warehouse (same backend and version check); session A has typed a 도시 before opening the dialog so that its 저장 is enabled. Data: an automation-owned warehouse is created and deleted afterwards.');
    let id = 0;
    const seen = { before: 0, stillOpen: 0, reopened: [] as string[][], saveStatus: 0 };

    await step('Arrange: Pre-condition 1 — Two sessions on the same warehouse (session A = this browser with an unsaved 도시)', async () => {
      id = (await warehouseCleanup.create('SUPPLIER', 'TC_US069_123')).id;
      await form.open(id);
      await form.cityInput.fill('Session A city');
    });

    await step('Act: Step 1 — Session A: open 변경 이력 and keep it open', async () => {
      await form.openHistory();
      seen.before = (await form.readHistoryRows()).length;
    });

    await step('Act: Step 2 — Session B: change a field on the same warehouse and save', async () => {
      await apiSave(warehouseApi, id, { zipCode: '23232' });
    });

    await step('Act: Step 3 — Session A: observe the open dialog without closing it', async () => {
      seen.stillOpen = (await form.readHistoryRows()).length;
    });

    await step('Assert: Expected 3 — The open dialog is unchanged (no refresh, no warning)', async () => {
      expect(seen.stillOpen, '[Expected 3] The record count is unchanged while open').toBe(seen.before);
      await expect(form.historyDialog.getByText(/다른 사용자|변경했습니다/), '[Expected 3] No warning about the other save').toHaveCount(0);
    });

    await step('Act: Step 4 — Session A: close the dialog and reopen it', async () => {
      await form.closeHistory();
      await form.openHistory();
      seen.reopened = await form.readHistoryRows();
    });

    await step('Assert: Expected 4 — The record written by session B is displayed', async () => {
      expect(seen.reopened.length, '[Expected 4] One more record after reopening').toBe(seen.before + 1);
      expect(seen.reopened[0][2], '[Expected 4] The new record is session B\'s 우편번호 change').toBe('우편번호');
    });

    await step('Act: Step 5 — Session A: close the dialog, then click 저장 on the stale form behind it', async () => {
      await form.closeHistory();
      seen.saveStatus = (await form.saveAndWait()).status();
    });

    await step('Assert: Expected 5 — Session A\'s save is refused with 409 and the 저장 충돌 dialog opens', async () => {
      expect(seen.saveStatus, '[Expected 5] HTTP 409').toBe(409);
      await expect(form.conflictDialog, '[Expected 5] The 저장 충돌 dialog opens').toBeVisible();
    });
  });

  test('TC_US069_124 — Closing the change history dialog preserves the form behind', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_124', 'Medium', TAGS, 'Closing the dialog with the close button, with Esc, or by clicking outside all behave the same; afterwards the form keeps its mode and the typed 창고명 / 도시 values, still unsaved. Data: an automation-owned warehouse is created and deleted afterwards.');
    let wh = { id: 0, name: '' };
    const typed = { name: '', city: 'Unsaved city' };
    const after: Array<{ how: string; name: string; city: string; dialog: number }> = [];
    const snapshot = async (how: string) => after.push({ how, name: await form.nameInput.inputValue(), city: await form.cityInput.inputValue(), dialog: await form.historyDialog.count() });

    await step('Arrange: Pre-condition 1 — A non-virtual warehouse exists (automation-owned)', async () => {
      wh = await warehouseCleanup.create('SUPPLIER', 'TC_US069_124');
      typed.name = `${wh.name}_unsaved`;
    });

    await step('Act: Step 1 — Open Detail/Edit and type new 창고명 and 도시 without saving', async () => {
      await form.open(wh.id);
      await form.nameInput.fill(typed.name);
      await form.cityInput.fill(typed.city);
    });

    await step('Act: Step 2 — Click 변경 이력, then close it with the close button', async () => {
      await form.openHistory();
      await form.closeHistory();
      await snapshot('close button');
    });

    await step('Act: Step 3 — Reopen the dialog and close it with the Esc key', async () => {
      await form.openHistory();
      await page.keyboard.press('Escape');
      await expect(form.historyDialog).toHaveCount(0);
      await snapshot('Esc key');
    });

    await step('Act: Step 4 — Reopen the dialog and close it by clicking outside', async () => {
      await form.openHistory();
      await page.mouse.click(8, 540);
      await expect(form.historyDialog).toHaveCount(0);
      await snapshot('outside click');
    });

    await step('Assert: Expected 2/3/4 — Every close method keeps the mode and the unsaved values', async () => {
      for (const s of after) {
        expect(s.dialog, `[Expected 2/3/4] ${s.how}: the dialog is closed`).toBe(0);
        expect(s.name, `[Expected 2/3/4] ${s.how}: 창고명 keeps the typed value`).toBe(typed.name);
        expect(s.city, `[Expected 2/3/4] ${s.how}: 도시 keeps the typed value`).toBe(typed.city);
      }
      await expect(form.saveButton, '[Expected 2/3/4] Still in edit mode with unsaved changes (저장 enabled)').toBeEnabled();
      expect((await warehouseApi.get(wh.id)).body.name, '[Expected 2/3/4] Nothing was saved').toBe(wh.name);
    });
  });

  test('TC_US069_125 — 변경자 records the acting admin, never SYSTEM', async ({ page, warehouseFormPage: form, warehouseListPage: list, warehouseCleanup }) => {
    test.skip(!hasCredentials('approver'), 'Second admin (approver) account is not configured — set APPROVER_OKTA_REFRESH_TOKEN in .env');
    const step = makeStep(page);
    await tcMeta('TC_US069_125', 'Critical', TAGS, 'Admin A (submitter account) and admin B (approver account) each save a change; 변경자 shows A on the first record and B on the second, never SYSTEM. Accounts are switched on the same tab. Data: an automation-owned warehouse is created and deleted afterwards.');
    let id = 0;
    let rows: string[][] = [];
    const saveCity = async (city: string) => {
      await form.open(id);
      await form.cityInput.fill(city);
      await form.saveAndWait();
      await list.waitForListLoaded();
    };

    await step('Arrange: Pre-condition 1 — Two admin accounts with MASTER_DATA writable (submitter = A, approver = B)', async () => {
      id = (await warehouseCleanup.create('SUPPLIER', 'TC_US069_125')).id;
    });

    await step('Act: Step 1 — Admin A changes a field and saves', async () => {
      await saveCity('Admin A city');
    });

    await step('Act: Step 2 — Admin B changes another field on the same warehouse and saves', async () => {
      await switchAccount(page, 'approver');
      await form.open(id);
      await form.zipCodeInput.fill('25252');
      await form.saveAndWait();
      await list.waitForListLoaded();
    });

    await step('Act: Step 3 — Open 변경 이력 and inspect 변경자 of both records', async () => {
      await form.open(id);
      await form.openHistory();
      rows = await form.readHistoryRows();
    });

    await step('Assert: Expected 3 — 변경자 shows admin A then admin B, never SYSTEM', async () => {
      expect(rows[1][1], '[Expected 3] The first change is by admin A').toBe(getAccountDisplayName('submitter'));
      expect(rows[0][1], '[Expected 3] The second change is by admin B').toBe(getAccountDisplayName('approver'));
      for (const row of rows) expect(row[1], '[Expected 3] 변경자 is never SYSTEM').not.toMatch(/SYSTEM/i);
    });
  });

  test('TC_US069_126 — History is written for both warehouse subclasses', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_126', 'High', TAGS, 'Both a Platform and a Supplier warehouse show their 생성 and update records in the dialog. Not automated: Expected 4 (both stored under domainType = warehouse) needs the history store at the data layer. Data: two automation-owned warehouses are created and deleted afterwards.');
    let platform = 0;
    let supplier = 0;
    const seen: Record<string, string[][]> = {};

    await step('Arrange: Pre-condition 1 — Platform and Supplier warehouses can be created', async () => {
      await form.goto('/');
    });

    await step('Act: Step 1 — Create and then edit a 플랫폼 물류 warehouse', async () => {
      platform = (await warehouseCleanup.create('PLATFORM_GENERAL', 'TC_US069_126', { name: warehouseName('TC_US069_126', 'P') })).id;
      await apiSave(warehouseApi, platform, { city: 'Platform city' });
    });

    await step('Act: Step 2 — Create and then edit a 판매자 물류 warehouse', async () => {
      supplier = (await warehouseCleanup.create('SUPPLIER', 'TC_US069_126', { name: warehouseName('TC_US069_126', 'S') })).id;
      await apiSave(warehouseApi, supplier, { city: 'Supplier city' });
    });

    await step('Act: Step 3 — Open 변경 이력 on each of them', async () => {
      for (const [label, id] of [['platform', platform], ['supplier', supplier]] as const) {
        await form.open(id);
        await form.openHistory();
        seen[label] = await form.readHistoryRows();
      }
    });

    await step('Assert: Expected 3 — Both warehouses show their Created and Updated records', async () => {
      for (const label of ['platform', 'supplier']) {
        expect(seen[label].length, `[Expected 3] ${label}: 생성 + 1 update`).toBe(2);
        expect(seen[label][1][2], `[Expected 3] ${label}: the first record is 생성`).toBe(WH_TEXT.historyCreatedChip);
        expect(seen[label][0][2], `[Expected 3] ${label}: the update is on 도시`).toBe('도시');
      }
    });

    await step('Act: Step 4 — Inspect the stored history records at the data layer (Not automated)', async () => {
      await form.historyDialog.scrollIntoViewIfNeeded();
    });

    // domainType ở tầng dữ liệu không đọc được qua UI/API — Not automated (xem description).
    await step('Assert: Expected 4 — Both stored under domainType = warehouse (Not automated — data layer)', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Expected 4: history domainType is only visible in the database.' });
    });
  });

  test('TC_US069_127 — A DELETED record is written before the row is removed', async () => {
    await skipTc('TC_US069_127', 'High', TAGS, 'Deleting a warehouse writes a DELETED history record with the pre-delete snapshot, readable only on the US004 screen.', 'the record is only readable in the history store (data layer) or on the US004 audit screen, which is outside this US; the deleted warehouse has no Detail screen or API history left to read.');
  });

  test('TC_US069_128 — The change history dialog is responsive and never clips its content', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_128', 'Low', [...TAGS, 'responsive'], 'The history dialog is min(860px, viewport − 32px) wide — wider than the 500px confirm dialogs; below that width the page never scrolls horizontally (the table sits in its own horizontal scroll container) and long 항목 / 변경 내용 values wrap instead of being clipped. Data: an automation-owned warehouse with a 100-character rename is created and deleted afterwards.');
    let id = 0;
    const seen = { wide: 0, confirm: 0, narrow: 0, narrowViewport: 800, pageScroll: true, tableScrollable: '', clipped: true, wraps: false };

    await step('Arrange: Pre-condition 1 — A warehouse whose records hold long values (automation-owned, 100-character rename)', async () => {
      const wh = await warehouseCleanup.create('SUPPLIER', 'TC_US069_128');
      id = wh.id;
      await apiSave(warehouseApi, id, { name: `${wh.name}_`.padEnd(100, 'L') });
      await form.open(id);
    });

    await step('Act: Step 1 — Open 변경 이력 on a wide window and compare its width with the confirm dialogs', async () => {
      await form.openHistory();
      seen.wide = (await form.historyDialog.locator('.modal-dialog').boundingBox())!.width;
      await form.closeHistory();
      await form.openDeactivateDialog();
      seen.confirm = (await form.dialog.locator('.modal-dialog').boundingBox())!.width;
      await form.click(form.dialogCancelButton, '취소 (Cancel) button in the dialog');
    });

    await step('Assert: Expected 1 — The dialog is 860px wide on a wide window, wider than the confirm dialogs', async () => {
      expect(Math.round(seen.wide), '[Expected 1] Width is min(860, 1920 − 32) = 860px').toBe(860);
      expect(seen.wide, '[Expected 1] Wider than the confirm dialogs').toBeGreaterThan(seen.confirm);
    });

    await step(`Act: Step 2 — Reduce the browser width below the dialog width (${seen.narrowViewport}px)`, async () => {
      await page.setViewportSize({ width: seen.narrowViewport, height: 900 });
      await form.openHistory();
      seen.narrow = (await form.historyDialog.locator('.modal-dialog').boundingBox())!.width;
    });

    await step('Act: Step 3 — Observe the dialog, the table and the page', async () => {
      seen.pageScroll = await hasHorizontalPageScroll(page);
      seen.tableScrollable = await form.historyDialog.locator('table').evaluate((t) => getComputedStyle(t.parentElement!).overflowX);
    });

    await step('Assert: Expected 3 — The page never scrolls horizontally; the table has its own horizontal scroll', async () => {
      expect(Math.round(seen.narrow), `[Expected 3] Width is ${seen.narrowViewport} − 32px`).toBe(seen.narrowViewport - 32);
      expect(seen.pageScroll, '[Expected 3] The page has no horizontal scrollbar').toBe(false);
      expect(['auto', 'scroll'], '[Expected 3] The table container scrolls horizontally').toContain(seen.tableScrollable);
    });

    await step('Act: Step 4 — Observe a record whose 항목 / 변경 내용 value is long', async () => {
      const cell = form.historyChangeCell(0);
      seen.clipped = await isClipped(cell);
      seen.wraps = await cell.evaluate((el) => el.getBoundingClientRect().height > parseFloat(getComputedStyle(el).lineHeight || '20') * 1.5);
    });

    await step('Assert: Expected 4 — The long values wrap and are never clipped', async () => {
      expect(seen.clipped, '[Expected 4] The 변경 내용 cell is not clipped').toBe(false);
      expect(seen.wraps, '[Expected 4] The long value wraps onto several lines').toBe(true);
    });
  });
});
