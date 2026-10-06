import { Route } from '@playwright/test';
import { test, expect } from '@fixtures/territory.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { getAccountDisplayName } from '@utils/auth-token';
import { TERRITORY_TEXT, NORMAL_FLAGS, parseCounter, toSeoulMinute } from '@utils/territory.data';

/**
 * US089 — luồng lưu trên màn Edit territory (account có quyền ghi từ 29/09). Mỗi test đưa quốc gia TC ghi về đúng tiền
 * điều kiện cờ qua API (`territoryState.prepare`) và teardown ghi trả giá trị gốc. Lịch sử append-only và dev có người
 * khác sửa cùng lúc → ý "chưa có lịch sử" assert tương đối: số bản ghi tăng đúng 1, bản ghi mới nằm trên cùng.
 * Màn không có mục menu (TC_US089_11) → mở list bằng URL; click dòng để vào màn sửa.
 */
const TAGS = ['edit', 'territory', 'save'];
const KO = TERRITORY_TEXT.ko;
const DATA = 'Data: the country is edited through the UI and restored to its original values in teardown (shared dev).';
const JP_NORMAL = NORMAL_FLAGS('JP');
const STRUCK = /line-through/;

test.describe('[Edit] Territory — saving changes', () => {
  test.describe.configure({ timeout: 150_000 });

  test('TC_US089_01 — An ADMIN can open the screen, open a row and save a change', async ({ page, territoryState, territoryListPage: list, territoryEditPage: edit }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_01', 'High', TAGS, `An ADMIN opens Territory, clicks the JP row, changes VAT treatment to 과세, types the reason (저장 enables only then), saves and sees the toast 변경 사항이 저장되었습니다. with the list showing JP 과세. Deviation: there is no 마스터 데이터 menu entry (TC_US089_11) — the step-1 menu check is asserted softly and the screen is opened by URL. ${DATA}`);
    let status = 0;

    await step('Arrange: Pre-condition 1–2 — ADMIN with write access; JP is 영세율 / Required', async () => {
      await territoryState.prepare('JP', JP_NORMAL);
    });

    await step('Act: Step 1 — Open 마스터 데이터 (Master Data) › Territory', async () => {
      await list.open();
    });

    await step('Assert: Expected 1 — The list opens; breadcrumb 마스터 데이터 › Territory', async () => {
      await expect(list.table, '[Expected 1] The country list is shown').toBeVisible();
      await expect.soft(list.sidebarTerritoryMenu, '[Expected 1] A Territory menu item exists in the sidebar').toHaveCount(1);
      await expect.soft(list.breadcrumb, '[Expected 1] Breadcrumb reads 마스터 데이터 (Master Data) › Territory').toHaveText(/마스터 데이터.*Territory/);
    });

    await step('Act: Step 2 — Click anywhere on the JP row', async () => {
      await list.setCriteria({ keyword: 'JP' });
      await list.search();
      await list.openRow('JP');
    });

    await step('Assert: Expected 2 — The Edit territory screen for JP opens pre-filled', async () => {
      await expect(edit.code, '[Expected 2] The screen is for JP').toHaveText('JP');
      await expect(edit.vatSelect, '[Expected 2] VAT treatment pre-filled with 영세율').toHaveValue('ZERO_RATED');
      await expect(edit.exportCheckbox, '[Expected 2] Export declaration pre-filled as ticked').toBeChecked();
    });

    await step('Act: Step 3 — Change the VAT treatment picker to 과세 (Taxable (standard))', async () => {
      await edit.vatSelect.selectOption('TAXABLE_STANDARD');
    });

    await step('Assert: Expected 3 — The picker takes the value; 저장 is still disabled (no reason yet)', async () => {
      await expect(edit.vatSelect, '[Expected 3] Picker at 과세').toHaveValue('TAXABLE_STANDARD');
      await expect(edit.saveButton, '[Expected 3] 저장 (Save) is still disabled').toBeDisabled();
    });

    await step('Act: Step 4 — Type the reason "KE Finance confirmed JP is taxable for the 26.09 cycle"', async () => {
      await edit.reasonInput.fill('KE Finance confirmed JP is taxable for the 26.09 cycle');
    });

    await step('Assert: Expected 4 — 저장 (Save) becomes enabled', async () => {
      await expect(edit.saveButton, '[Expected 4] 저장 (Save) is enabled').toBeEnabled();
    });

    await step('Act: Step 5 — Click 저장 (Save), then Confirm and save', async () => {
      await edit.openConfirm();
      status = (await edit.confirmSave()).status();
    });

    await step('Assert: Expected 5 — Saved; toast shown; back on the list with JP reading 과세', async () => {
      expect(status, '[Expected 5] The save succeeds').toBe(200);
      await expect(edit.savedToast(), '[Expected 5] Toast 변경 사항이 저장되었습니다.').toBeVisible();
      await expect(page, '[Expected 5] The screen returns to the list').toHaveURL(/\/commerce\/territories(\?|$)/);
      await list.setCriteria({ keyword: 'JP' });
      await list.search();
      await expect(list.cell(list.row('JP'), 'vat'), '[Expected 5] The JP row shows 과세').toHaveText(KO.taxable);
    });
  });

  test('TC_US089_09 — The confirmation dialog renders its title, the difference table, both warning areas and both buttons', async ({ page, territoryApi, territoryState, territoryEditPage: edit }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_09', 'Medium', TAGS, `With JP set from 영세율 to 과세 the dialog reads 이 변경을 적용할까요? (Apply this change?) with the sub-line "JP · 일본", one VAT treatment diff row (old struck through → new bold), the amber deviation area visible and the red conflict area hidden, and the footer Back (left) / Confirm and save (right) with no corner X. Nothing is saved — the dialog is left with Back. Data: JP is prepared to 영세율 / Required and restored in teardown.`);
    let nameKo = '';
    let boxes = { back: 0, confirm: 0 };

    await step('Arrange: Pre-condition 1–2 — ADMIN; JP is 영세율 / Required', async () => {
      nameKo = (await territoryState.prepare('JP', JP_NORMAL)).nameKo;
      expect((await territoryApi.get('JP')).body.vatTreatment, 'Pre-condition: JP is zero-rated').toBe('ZERO_RATED');
    });

    await step('Act: Step 1 — Open JP, change VAT treatment to 과세 and type the reason', async () => {
      await edit.open('JP');
      await edit.vatSelect.selectOption('TAXABLE_STANDARD');
      await edit.reasonInput.fill('Check the confirmation dialog layout');
    });

    await step('Assert: Expected 1 — The form takes both values; 저장 (Save) is enabled', async () => {
      await expect(edit.vatSelect, '[Expected 1] Picker at 과세').toHaveValue('TAXABLE_STANDARD');
      await expect(edit.saveButton, '[Expected 1] 저장 (Save) is enabled').toBeEnabled();
    });

    await step('Act: Step 2 — Click 저장 (Save) and read the dialog title and sub-line', async () => {
      await edit.openConfirm();
    });

    await step('Assert: Expected 2 — Title 이 변경을 적용할까요? (Apply this change?) with the sub-line "JP · 일본"', async () => {
      await expect(edit.confirmDialog.title, '[Expected 2] Title reads 이 변경을 적용할까요?').toContainText('이 변경을 적용할까요?');
      await expect(edit.confirmDialog.subtitle, '[Expected 2] Sub-line shows the code and name').toHaveText(`JP · ${nameKo}`);
    });

    await step('Act: Step 3 — Read the difference table', async () => {
      await edit.confirmDialog.diffRows.first().scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — One VAT treatment row: old struck through, an arrow, new in bold', async () => {
      const row = edit.confirmDialog.diffRows.first();
      await expect(edit.confirmDialog.diffRows, '[Expected 3] Exactly one diff row').toHaveCount(1);
      await expect(edit.confirmDialog.diffKey(row), '[Expected 3] The row is VAT treatment (부가세 처리)').toHaveText(/^(VAT treatment|부가세 처리)$/);
      await expect(edit.confirmDialog.diffOld(row), '[Expected 3] Old value 영세율').toHaveText(KO.zeroRated);
      await expect(edit.confirmDialog.diffOld(row), '[Expected 3] The old value is struck through').toHaveCSS('text-decoration-line', STRUCK);
      await expect(row, '[Expected 3] An arrow sits between old and new').toContainText('→');
      await expect(edit.confirmDialog.diffNew(row), '[Expected 3] New value 과세 in bold').toHaveText(KO.taxable);
    });

    await step('Act: Step 4 — Look at the amber and the red warning areas', async () => {
      await edit.confirmDialog.content.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — The amber deviation area is visible; the red conflict area is hidden', async () => {
      await expect(edit.confirmDialog.deviation, '[Expected 4] The amber deviation area is visible').toBeVisible();
      await expect(edit.confirmDialog.conflict, '[Expected 4] The red conflict area is hidden').toHaveCount(0);
    });

    await step('Act: Step 5 — Read the two buttons in the dialog footer', async () => {
      boxes = { back: (await edit.confirmDialog.backButton.boundingBox())?.x ?? -1, confirm: (await edit.confirmDialog.confirmButton.boundingBox())?.x ?? -1 };
    });

    await step('Assert: Expected 5 — Back on the left, Confirm and save on the right; no corner X', async () => {
      await expect(edit.confirmDialog.backButton, '[Expected 5] Back (뒤로)').toHaveText('뒤로');
      await expect(edit.confirmDialog.confirmButton, '[Expected 5] Confirm and save (확인 후 저장)').toHaveText('확인 후 저장');
      expect(boxes.back, '[Expected 5] Back sits left of Confirm and save').toBeLessThan(boxes.confirm);
      await expect(edit.confirmDialog.cornerClose, '[Expected 5] No X close button').toHaveCount(0);
      await edit.confirmDialog.back();
    });
  });

  test('TC_US089_20 — Clicking anywhere on a row opens the edit screen pre-filled with an empty reason and 저장 disabled', async ({ page, territoryState, territoryListPage: list, territoryEditPage: edit }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_20', 'High', TAGS, `Hovering JP shows a pointer and a changed row background; clicking the Last updated cell opens Edit territory as its own screen; breadcrumb Master Data › Territory › JP (soft — dev reads Commerce › Territories › JP › Edit); JP with both names; 영세율, ticked, empty reason; 저장 disabled. Deviation: "never edited" cannot be guaranteed on the shared dev — JP is prepared to its TC flags instead. Data: JP prepared to 영세율 / Required, restored in teardown; nothing saved.`);
    let cursor = '';
    let background = { before: '', after: '' };

    await step('Arrange: Pre-condition 1–2 — ADMIN; JP is 영세율 / Required', async () => {
      await territoryState.prepare('JP', JP_NORMAL);
      await list.open();
      await list.setCriteria({ keyword: 'JP' });
      await list.search();
    });

    await step('Act: Step 1 — Hover over the JP row and watch the cursor and the row background', async () => {
      // Nền hover có thể nằm trên <tr> hoặc <td> → đo cả hai ("tr | td").
      const cell = list.cell(list.row('JP'), 'updated');
      const bg = () => cell.evaluate((el) => `${getComputedStyle(el.parentElement as Element).backgroundColor} | ${getComputedStyle(el).backgroundColor}`);
      await list.searchInput.hover();
      background.before = await bg();
      await list.row('JP').hover();
      await expect.poll(bg, { timeout: 3_000 }).not.toBe(background.before).catch(() => undefined);
      background.after = await bg();
      cursor = await cell.evaluate((el) => getComputedStyle(el).cursor);
    });

    await step('Assert: Expected 1 — A pointing hand and a changed row background', async () => {
      expect(cursor, '[Expected 1] The cursor is a pointing hand').toBe('pointer');
      expect(background.after, '[Expected 1] The row background changes on hover').not.toBe(background.before);
    });

    await step('Act: Step 2 — Click the Last updated cell of the JP row', async () => {
      await list.openRow('JP');
    });

    await step('Assert: Expected 2 — Edit territory opens as its own screen, not a dialog or inline edit', async () => {
      await expect(page, '[Expected 2] A screen of its own').toHaveURL(/\/commerce\/territories\/JP\/edit/);
      await expect(edit.confirmDialog.root, '[Expected 2] Not a dialog').toHaveCount(0);
    });

    await step('Act: Step 3 — Read the breadcrumb and the code and name block', async () => {
      await edit.identityBox.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Breadcrumb Master Data › Territory › JP; the block shows JP and both names', async () => {
      await expect.soft(edit.breadcrumb, '[Expected 3] Breadcrumb reads 마스터 데이터 (Master Data) › Territory › JP').toHaveText(/마스터 데이터.*Territory.*JP/);
      await expect(edit.code, '[Expected 3] Code JP').toHaveText('JP');
      await expect(edit.nameEn, '[Expected 3] English name').toHaveText('Japan');
      await expect(edit.nameKo, '[Expected 3] Korean name').toHaveText('일본');
    });

    await step('Act: Step 4 — Read the picker, the checkbox and the Reason box', async () => {
      await edit.vatSelect.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — 영세율, ticked, and a completely empty Reason box', async () => {
      await expect(edit.vatSelect, '[Expected 4] Picker at 영세율').toHaveValue('ZERO_RATED');
      await expect(edit.exportCheckbox, '[Expected 4] Checkbox ticked').toBeChecked();
      await expect(edit.reasonInput, '[Expected 4] Reason box empty').toHaveValue('');
    });

    await step('Act: Step 5 — Look at 저장 (Save)', async () => {
      await edit.saveButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 5 — 저장 (Save) is disabled', async () => {
      await expect(edit.saveButton, '[Expected 5] 저장 (Save) is disabled').toBeDisabled();
    });
  });

  test('TC_US089_36 — Changing the VAT treatment to the expected value saves end to end with no deviation warning', async ({ page, territoryState, territoryListPage: list, territoryEditPage: edit }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_36', 'Critical', TAGS, `JP prepared to 과세 / Required; changing it back to 영세율 shows a one-row diff (과세 struck → 영세율 bold), no export row, no deviation warning; Confirm and save closes the dialog, the toast shows bottom-centre and the list shows JP 영세율 with the editing account and save time in Last updated. ${DATA}`);
    const account = getAccountDisplayName('submitter');
    let patches = 0;
    let savedAt = '';
    let toastBox: { x: number; y: number; width: number; height: number } | null = null;

    await step('Arrange: Pre-condition 1–2 — ADMIN; JP is 과세 / Required', async () => {
      await territoryState.prepare('JP', { vat: 'TAXABLE_STANDARD', exportRequired: true });
      page.on('request', (r) => {
        if (r.method() === 'PATCH' && /\/api\/v1\/territories\/JP$/.test(r.url())) patches += 1;
      });
      await list.open();
      await list.setCriteria({ keyword: 'JP' });
      await list.search();
    });

    await step('Act: Step 1 — Open JP and change VAT treatment to 영세율, leaving the checkbox', async () => {
      await list.openRow('JP');
      await edit.vatSelect.selectOption('ZERO_RATED');
    });

    await step('Assert: Expected 1 — The picker takes 영세율; 저장 is still disabled', async () => {
      await expect(edit.vatSelect, '[Expected 1] Picker at 영세율').toHaveValue('ZERO_RATED');
      await expect(edit.saveButton, '[Expected 1] 저장 (Save) is disabled').toBeDisabled();
    });

    await step('Act: Step 2 — Type the reason and click 저장 (Save)', async () => {
      await edit.reasonInput.fill('Return JP to zero-rated per the standard');
      await expect(edit.saveButton, '저장 is enabled').toBeEnabled();
      await edit.openConfirm();
    });

    await step('Assert: Expected 2 — The dialog opens with the code and name; nothing written yet', async () => {
      await expect(edit.confirmDialog.subtitle, '[Expected 2] Sub-line shows JP · 일본').toHaveText('JP · 일본');
      expect(patches, '[Expected 2] No write has been sent yet').toBe(0);
    });

    await step('Act: Step 3 — Read the difference table and the warning area', async () => {
      await edit.confirmDialog.diffRows.first().scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — One VAT row 과세 struck → 영세율 bold; no export row; no deviation warning', async () => {
      const row = edit.confirmDialog.diffRows.first();
      await expect(edit.confirmDialog.diffRows, '[Expected 3] Exactly one diff row (no export row)').toHaveCount(1);
      await expect(edit.confirmDialog.diffKey(row), '[Expected 3] The row is VAT treatment').toHaveText(/^(VAT treatment|부가세 처리)$/);
      await expect(edit.confirmDialog.diffOld(row), '[Expected 3] Old 과세').toHaveText(KO.taxable);
      await expect(edit.confirmDialog.diffOld(row), '[Expected 3] Old value struck through').toHaveCSS('text-decoration-line', STRUCK);
      await expect(edit.confirmDialog.diffNew(row), '[Expected 3] New 영세율 in bold').toHaveText(KO.zeroRated);
      await expect(edit.confirmDialog.deviation, '[Expected 3] No deviation warning').toHaveCount(0);
    });

    await step('Act: Step 4 — Click Confirm and save', async () => {
      const response = await edit.confirmSave();
      expect(response.status(), 'The write succeeds').toBe(200);
      savedAt = new Date().toISOString();
    });

    await step('Assert: Expected 4 — The dialog closes and the write is performed', async () => {
      await expect(edit.confirmDialog.root, '[Expected 4] The dialog closes').toHaveCount(0);
      expect(patches, '[Expected 4] Exactly one write').toBe(1);
    });

    await step('Act: Step 5 — Watch the screen after the save and read the JP row', async () => {
      await expect(edit.savedToast(), 'The toast appears').toBeVisible();
      toastBox = await edit.savedToast().boundingBox();
      await list.setCriteria({ keyword: 'JP' });
      await list.search();
    });

    await step('Assert: Expected 5 — Toast bottom-centre; back on the list; JP 영세율 with the editor and save time', async () => {
      const viewport = page.viewportSize() ?? { width: 1920, height: 1080 };
      expect(toastBox, '[Expected 5] The toast was measured').not.toBeNull();
      expect.soft(Math.abs((toastBox?.x ?? 0) + (toastBox?.width ?? 0) / 2 - viewport.width / 2), '[Expected 5] The toast is horizontally centred').toBeLessThan(40);
      expect.soft(toastBox?.y ?? 0, '[Expected 5] The toast sits in the bottom half').toBeGreaterThan(viewport.height / 2);
      await expect(page, '[Expected 5] The screen returned to the list').toHaveURL(/\/commerce\/territories(\?|$)/);
      await expect(list.cell(list.row('JP'), 'vat'), '[Expected 5] JP shows 영세율').toHaveText(KO.zeroRated);
      await expect(list.cell(list.row('JP'), 'updated'), '[Expected 5] Last updated shows the editing account').toContainText(account);
      await expect(list.cell(list.row('JP'), 'updated'), '[Expected 5] Last updated shows the save time').toContainText(toSeoulMinute(savedAt).slice(0, 10));
    });
  });

  test('TC_US089_37 — Changing only the export declaration saves and the confirmation lists that row alone', async ({ page, territoryState, territoryListPage: list, territoryEditPage: edit }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_37', 'High', TAGS, `Unticking JP's export declaration shows a single Export declaration diff row (Required struck → Not required bold, or the interim 필요 → 불필요) and no VAT row; the save shows the toast and the list reads JP 불필요 / 영세율. ${DATA}`);
    let status = 0;

    await step('Arrange: Pre-condition 1–2 — ADMIN; JP is 영세율 / Required', async () => {
      await territoryState.prepare('JP', JP_NORMAL);
      await edit.open('JP');
    });

    await step('Act: Step 1 — Untick the Export declaration checkbox, leaving the picker', async () => {
      await edit.exportCheckbox.uncheck();
    });

    await step('Assert: Expected 1 — The checkbox is unticked; 저장 is still disabled', async () => {
      await expect(edit.exportCheckbox, '[Expected 1] Unticked').not.toBeChecked();
      await expect(edit.saveButton, '[Expected 1] 저장 (Save) is disabled').toBeDisabled();
    });

    await step('Act: Step 2 — Type the reason and click 저장 (Save)', async () => {
      await edit.reasonInput.fill('JP is picked up at the venue so no declaration is needed');
      await expect(edit.saveButton, '저장 is enabled').toBeEnabled();
      await edit.openConfirm();
    });

    await step('Assert: Expected 2 — The Apply this change? dialog opens', async () => {
      await expect(edit.confirmDialog.title, '[Expected 2] The confirmation dialog is open').toContainText('이 변경을 적용할까요?');
    });

    await step('Act: Step 3 — Read the difference table', async () => {
      await edit.confirmDialog.diffRows.first().scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Exactly one Export declaration row; no VAT row', async () => {
      const row = edit.confirmDialog.diffRows.first();
      await expect(edit.confirmDialog.diffRows, '[Expected 3] Exactly one diff row').toHaveCount(1);
      await expect(edit.confirmDialog.diffKey(row), '[Expected 3] The row is Export declaration').toHaveText(/^(Export declaration|수출 ?신고)$/);
      await expect(edit.confirmDialog.diffOld(row), '[Expected 3] Old Required struck through').toHaveText(/^(Required|필요)$/);
      await expect(edit.confirmDialog.diffOld(row), '[Expected 3] The old value is struck through').toHaveCSS('text-decoration-line', STRUCK);
      await expect(edit.confirmDialog.diffNew(row), '[Expected 3] New Not required in bold').toHaveText(/^(Not required|불필요)$/);
    });

    await step('Act: Step 4 — Click Confirm and save and read the JP row on the list', async () => {
      status = (await edit.confirmSave()).status();
      await expect(edit.savedToast(), 'The toast appears').toBeVisible();
      await list.setCriteria({ keyword: 'JP' });
      await list.search();
    });

    await step('Assert: Expected 4 — Saved; toast; JP shows Not required and still 영세율', async () => {
      expect(status, '[Expected 4] The save succeeds').toBe(200);
      await expect(list.cell(list.row('JP'), 'export'), '[Expected 4] JP shows Not required').toHaveText(/^(Not required|불필요)$/);
      await expect(list.cell(list.row('JP'), 'vat'), '[Expected 4] VAT still 영세율').toHaveText(KO.zeroRated);
    });
  });

  test('TC_US089_38 — Changing both flags in one save produces a two-row confirmation and exactly one history record', async ({ page, territoryApi, territoryState, territoryListPage: list, territoryEditPage: edit }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_38', 'High', TAGS, `AT prepared to 영세율 / Required; switching both flags gives a two-row diff and one save that adds exactly ONE history record (one author, one reason, two changed fields). Deviations: "no history record yet" cannot hold on the shared dev — the record count is compared before / after; the history store is read through the API. ${DATA}`);
    const reason = 'KE Finance confirmed AT is taxable and needs no declaration';
    let before = 0;
    let status = 0;

    await step('Arrange: Pre-condition 1–3 — ADMIN; AT is 영세율 / Required; history count read', async () => {
      await territoryState.prepare('AT', NORMAL_FLAGS('AT'));
      before = (await territoryApi.history('AT')).length;
      await edit.open('AT');
    });

    await step('Act: Step 1 — Change VAT treatment to 과세 and untick Export declaration', async () => {
      await edit.vatSelect.selectOption('TAXABLE_STANDARD');
      await edit.exportCheckbox.uncheck();
    });

    await step('Assert: Expected 1 — Both flags take their new values', async () => {
      await expect(edit.vatSelect, '[Expected 1] Picker at 과세').toHaveValue('TAXABLE_STANDARD');
      await expect(edit.exportCheckbox, '[Expected 1] Unticked').not.toBeChecked();
    });

    await step('Act: Step 2 — Type the reason and click 저장 (Save)', async () => {
      await edit.reasonInput.fill(reason);
      await edit.openConfirm();
    });

    await step('Assert: Expected 2 — 저장 was enabled and the dialog opens', async () => {
      await expect(edit.confirmDialog.confirmButton, '[Expected 2] The confirmation dialog is open').toBeVisible();
    });

    await step('Act: Step 3 — Read the difference table', async () => {
      await edit.confirmDialog.diffRows.first().scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Exactly two rows, VAT treatment and Export declaration, old struck → new bold', async () => {
      await expect(edit.confirmDialog.diffRows, '[Expected 3] Exactly two rows').toHaveCount(2);
      await expect(edit.confirmDialog.diffKey(edit.confirmDialog.diffRows.nth(0)), '[Expected 3] Row 1 is VAT treatment').toHaveText(/^(VAT treatment|부가세 처리)$/);
      await expect(edit.confirmDialog.diffKey(edit.confirmDialog.diffRows.nth(1)), '[Expected 3] Row 2 is Export declaration').toHaveText(/^(Export declaration|수출 ?신고)$/);
      for (const i of [0, 1]) {
        await expect(edit.confirmDialog.diffOld(edit.confirmDialog.diffRows.nth(i)), `[Expected 3] Row ${i + 1} old value struck through`).toHaveCSS('text-decoration-line', STRUCK);
        await expect(edit.confirmDialog.diffNew(edit.confirmDialog.diffRows.nth(i)), `[Expected 3] Row ${i + 1} new value in bold`).toBeVisible();
      }
    });

    await step('Act: Step 4 — Click Confirm and save', async () => {
      status = (await edit.confirmSave()).status();
      await expect(page, 'Back on the list').toHaveURL(/\/commerce\/territories(\?|$)/);
      await list.setCriteria({ keyword: 'AT' });
      await list.search();
    });

    await step('Assert: Expected 4 — Saved; the AT row shows both new values', async () => {
      expect(status, '[Expected 4] The save succeeds').toBe(200);
      await expect(list.cell(list.row('AT'), 'vat'), '[Expected 4] AT shows 과세').toHaveText(KO.taxable);
      await expect(list.cell(list.row('AT'), 'export'), '[Expected 4] AT shows Not required').toHaveText(/^(Not required|불필요)$/);
    });

    await step('Act: Step 5 — Read the change history of AT (API) and count the new records', async () => {
      await list.table.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 5 — Exactly ONE new record with one author, one reason and two changed fields', async () => {
      const history = await territoryApi.history('AT');
      expect(history.length - before, '[Expected 5] Exactly one new record').toBe(1);
      expect(history[0].reason, '[Expected 5] One reason').toBe(reason);
      expect(history[0].changedBy, '[Expected 5] One author').toBe(getAccountDisplayName('submitter'));
      expect(history[0].changes.map((c) => c.field).sort(), '[Expected 5] Two changed fields').toEqual(['exportDeclarationRequired', 'vatTreatment']);
    });
  });

  test('TC_US089_39 — KR can be set to zero-rated and a country other than KR to taxable', async ({ page, territoryState, territoryListPage: list, territoryEditPage: edit }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_39', 'High', TAGS, `KR → 영세율 and JP → 과세 each show a deviation warning with Confirm and save still enabled, and both save; KR can then be given a declaration (Required) — no combination is refused for being unusual. Data: KR and JP are edited and both restored in teardown (shared dev).`);
    const saved: Record<number, number> = {};

    const openCountry = async (code: string) => {
      await list.open();
      await list.setCriteria({ keyword: code });
      await list.search();
      await list.openRow(code);
    };
    const readRow = async (code: string) => {
      await list.setCriteria({ keyword: code });
      await list.search();
    };

    await step('Arrange: Pre-condition 1–3 — ADMIN; KR is 과세 / Not required; JP is 영세율 / Required', async () => {
      await territoryState.prepare('KR', NORMAL_FLAGS('KR'));
      await territoryState.prepare('JP', JP_NORMAL);
    });

    await step('Act: Step 1 — Open KR, set 영세율, type the reason and click 저장 (Save)', async () => {
      await openCountry('KR');
      await edit.vatSelect.selectOption('ZERO_RATED');
      await edit.reasonInput.fill('KE Finance asked to set KR to zero-rated');
      await edit.openConfirm();
    });

    await step('Assert: Expected 1 — A deviation warning; Confirm and save still enabled', async () => {
      await expect(edit.confirmDialog.deviation, '[Expected 1] Deviation warning shown').toBeVisible();
      await expect(edit.confirmDialog.confirmButton, '[Expected 1] Confirm and save enabled').toBeEnabled();
    });

    await step('Act: Step 2 — Click Confirm and save and read the KR row', async () => {
      saved[2] = (await edit.confirmSave()).status();
      await readRow('KR');
    });

    await step('Assert: Expected 2 — Saved; KR shows 영세율', async () => {
      expect(saved[2], '[Expected 2] The save succeeds').toBe(200);
      await expect(list.cell(list.row('KR'), 'vat'), '[Expected 2] KR shows 영세율').toHaveText(KO.zeroRated);
    });

    await step('Act: Step 3 — Open JP, set 과세, type the reason and click 저장 (Save)', async () => {
      await readRow('JP');
      await list.openRow('JP');
      await edit.vatSelect.selectOption('TAXABLE_STANDARD');
      await edit.reasonInput.fill('KE Finance confirmed JP is taxable for the 26.09 cycle');
      await edit.openConfirm();
    });

    await step('Assert: Expected 3 — A deviation warning; Confirm and save still enabled', async () => {
      await expect(edit.confirmDialog.deviation, '[Expected 3] Deviation warning shown').toBeVisible();
      await expect(edit.confirmDialog.confirmButton, '[Expected 3] Confirm and save enabled').toBeEnabled();
    });

    await step('Act: Step 4 — Click Confirm and save and read the JP row', async () => {
      saved[4] = (await edit.confirmSave()).status();
      await readRow('JP');
    });

    await step('Assert: Expected 4 — Saved; JP shows 과세', async () => {
      expect(saved[4], '[Expected 4] The save succeeds').toBe(200);
      await expect(list.cell(list.row('JP'), 'vat'), '[Expected 4] JP shows 과세').toHaveText(KO.taxable);
    });

    await step('Act: Step 5 — Open KR again, tick Export declaration, type the reason and save', async () => {
      await readRow('KR');
      await list.openRow('KR');
      saved[5] = (await edit.saveChange({ exportRequired: true, reason: 'KR needs a declaration under the new business rule' })).status();
      await readRow('KR');
    });

    await step('Assert: Expected 5 — Saved; KR shows Required — no combination is refused', async () => {
      expect(saved[5], '[Expected 5] The save succeeds').toBe(200);
      await expect(list.cell(list.row('KR'), 'export'), '[Expected 5] KR shows Required').toHaveText(/^(Required|필요)$/);
    });
  });

  test('TC_US089_40 — 저장 enables only when a flag changed and the reason is long enough', async ({ page, territoryState, territoryEditPage: edit }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_40', 'High', TAGS, `On JP: 저장 disabled with nothing changed, with only a reason, with only a flag, with a flag + "ok"; enabled with a flag + a full reason; disabled again when the flag returns to the stored value; enabled again when the other flag changes. Data: JP prepared to 영세율 / Required and restored in teardown; nothing is saved.`);
    const checks: Array<{ n: number; title: string; run: () => Promise<void>; enabled: boolean; why: string }> = [
      { n: 1, title: 'Look at 저장 (Save) before doing anything', run: async () => undefined, enabled: false, why: 'no flag changed and no reason' },
      { n: 2, title: 'Type a valid reason without touching either flag', run: () => edit.reasonInput.fill('Valid reason longer than ten characters'), enabled: false, why: 'no flag has changed' },
      { n: 3, title: 'Clear the reason and change VAT treatment to 과세', run: async () => { await edit.reasonInput.fill(''); await edit.vatSelect.selectOption('TAXABLE_STANDARD'); }, enabled: false, why: 'there is no reason' },
      { n: 4, title: 'Keep the flag and type "ok"', run: () => edit.reasonInput.fill('ok'), enabled: false, why: 'the reason is only 2 characters' },
      { n: 5, title: 'Type the full reason', run: () => edit.reasonInput.fill('KE Finance confirmed JP is taxable for the 26.09 cycle'), enabled: true, why: 'both conditions are satisfied' },
      { n: 6, title: 'Change VAT treatment back to 영세율, keeping the reason', run: () => edit.vatSelect.selectOption('ZERO_RATED').then(() => undefined), enabled: false, why: 'nothing differs from the stored value' },
      { n: 7, title: 'Untick Export declaration, keeping the reason', run: () => edit.exportCheckbox.uncheck(), enabled: true, why: 'the second flag changing also satisfies the condition' },
    ];

    await step('Arrange: Pre-condition 1–2 — ADMIN; JP is 영세율 / Required', async () => {
      await territoryState.prepare('JP', JP_NORMAL);
      await edit.open('JP');
    });

    for (const check of checks) {
      await step(`Act: Step ${check.n} — ${check.title}`, check.run);
      await step(`Assert: Expected ${check.n} — 저장 (Save) is ${check.enabled ? 'enabled' : 'disabled'} — ${check.why}`, async () => {
        if (check.enabled) await expect(edit.saveButton, `[Expected ${check.n}] 저장 (Save) is enabled`).toBeEnabled();
        else await expect(edit.saveButton, `[Expected ${check.n}] 저장 (Save) is disabled`).toBeDisabled();
      });
    }
  });

  test('TC_US089_41 — The deviation warning names only the changed fields, joins several with a mid-dot and never blocks', async ({ page, territoryState, territoryEditPage: edit }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_41', 'High', TAGS, `AE → 과세 warns "AE에는 일반적이지 않은 값입니다 — VAT treatment: Taxable (standard)." (the build may show the interim labels 부가세 처리: 과세 — SPEC-GAP-13) without mentioning Export declaration; after changing the declaration too the warning names both joined by " · "; Confirm and save stays enabled and saves; KR → 영세율 warns in the opposite direction. Deviation: AE keeps its declaration ticked by default, so step 3 unticks it to make it differ from the stored value. Data: AE is saved and KR is left unsaved; both restored in teardown.`);
    const lines: Record<number, string> = {};
    let status = 0;
    const VAT_LABEL = '(VAT treatment|부가세 처리)';
    const EXPORT_LABEL = '(Export declaration|수출 ?신고)';

    await step('Arrange: Pre-condition 1–3 — ADMIN; AE is 영세율 / Required; KR is 과세 / Not required', async () => {
      await territoryState.prepare('AE', NORMAL_FLAGS('AE'));
      await territoryState.prepare('KR', NORMAL_FLAGS('KR'));
      await edit.open('AE');
    });

    await step('Act: Step 1 — Change AE VAT treatment to 과세, leaving the checkbox', async () => {
      await edit.vatSelect.selectOption('TAXABLE_STANDARD');
    });

    await step('Assert: Expected 1 — The picker takes the new value', async () => {
      await expect(edit.vatSelect, '[Expected 1] Picker at 과세').toHaveValue('TAXABLE_STANDARD');
    });

    await step('Act: Step 2 — Type the reason, click 저장 (Save) and read the warning', async () => {
      await edit.reasonInput.fill('KE Finance confirmed AE is taxable for the 26.09 cycle');
      await edit.openConfirm();
      lines[2] = ((await edit.confirmDialog.deviation.textContent()) ?? '').trim();
    });

    await step('Assert: Expected 2 — One line naming only VAT treatment, no statistic', async () => {
      expect(lines[2], '[Expected 2] "AE에는 일반적이지 않은 값입니다 — VAT treatment: Taxable (standard)."').toMatch(new RegExp(`^AE에는 일반적이지 않은 값입니다 — ${VAT_LABEL}: (Taxable \\(standard\\)|과세)\\.$`));
      expect(lines[2], '[Expected 2] Export declaration is not mentioned').not.toMatch(new RegExp(EXPORT_LABEL));
      expect(lines[2], '[Expected 2] No statistic is printed').not.toMatch(/\d+ ?%|\d+개/);
    });

    await step('Act: Step 3 — Back, change the Export declaration too, click 저장 (Save) again', async () => {
      await edit.confirmDialog.back();
      await edit.exportCheckbox.uncheck();
      await edit.openConfirm();
      lines[3] = ((await edit.confirmDialog.deviation.textContent()) ?? '').trim();
    });

    await step('Assert: Expected 3 — Both fields named, joined by a mid-dot', async () => {
      expect(lines[3], '[Expected 3] VAT treatment and Export declaration joined by " · "').toMatch(new RegExp(`${VAT_LABEL}: [^·]+ · ${EXPORT_LABEL}: `));
    });

    await step('Act: Step 4 — Look at Confirm and save, then click it', async () => {
      await expect(edit.confirmDialog.confirmButton, 'Confirm and save is enabled').toBeEnabled();
      status = (await edit.confirmSave()).status();
    });

    await step('Assert: Expected 4 — Still enabled; the save succeeds — the warning never blocks', async () => {
      expect(status, '[Expected 4] The save succeeds').toBe(200);
      await expect(edit.savedToast(), '[Expected 4] The saved toast').toBeVisible();
    });

    await step('Act: Step 5 — Open KR, set 영세율, type the reason, click 저장 (Save) and read the warning', async () => {
      await edit.open('KR');
      await edit.vatSelect.selectOption('ZERO_RATED');
      await edit.reasonInput.fill('Check the warning wording for the KR row');
      await edit.openConfirm();
      lines[5] = ((await edit.confirmDialog.deviation.textContent()) ?? '').trim();
    });

    await step('Assert: Expected 5 — "KR에는 일반적이지 않은 값입니다 — VAT treatment: Zero-rated."', async () => {
      expect(lines[5], '[Expected 5] The KR warning runs in the opposite direction').toMatch(new RegExp(`^KR에는 일반적이지 않은 값입니다 — ${VAT_LABEL}: (Zero-rated|영세율)\\.$`));
      await edit.confirmDialog.back();
    });
  });

  test('TC_US089_47 — The reason box is empty every time the screen opens from the list', async ({ page, territoryApi, territoryState, territoryListPage: list, territoryEditPage: edit }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_47', 'Medium', TAGS, `After saving JP with a reason, reopening JP from the list (twice) shows an empty Reason box, while the change history keeps exactly the saved reason. Deviation: "no history record yet" does not hold on the shared dev — the newest record is read. ${DATA}`);
    const reason = 'KE Finance confirmed JP is taxable for the 26.09 cycle';
    let status = 0;
    const reopen = async () => {
      await list.setCriteria({ keyword: 'JP' });
      await list.search();
      await list.openRow('JP');
    };

    await step('Arrange: Pre-condition 1–2 — ADMIN; JP is 영세율', async () => {
      await territoryState.prepare('JP', JP_NORMAL);
      await list.open();
    });

    await step('Act: Step 1 — Open JP, set 과세, type the reason, 저장 and Confirm and save', async () => {
      await reopen();
      status = (await edit.saveChange({ vat: 'TAXABLE_STANDARD', reason })).status();
    });

    await step('Assert: Expected 1 — The save succeeds and the screen returns to the list', async () => {
      expect(status, '[Expected 1] The save succeeds').toBe(200);
      await expect(page, '[Expected 1] Back on the list').toHaveURL(/\/commerce\/territories(\?|$)/);
    });

    await step('Act: Step 2 — Click the JP row again and read the Reason box', async () => {
      await reopen();
    });

    await step('Assert: Expected 2 — The Reason box is completely empty', async () => {
      await expect(edit.reasonInput, '[Expected 2] Reason empty').toHaveValue('');
    });

    await step('Act: Step 3 — 목록으로 (Back to list), click JP once more and re-read the Reason box', async () => {
      await edit.click(edit.backButton, '목록으로 (Back to list) button');
      await reopen();
    });

    await step('Assert: Expected 3 — Still completely empty', async () => {
      await expect(edit.reasonInput, '[Expected 3] Reason empty').toHaveValue('');
    });

    await step('Act: Step 4 — Open the JP change history', async () => {
      await edit.click(edit.backButton, '목록으로 (Back to list) button');
      await list.setCriteria({ keyword: 'JP' });
      await list.search();
      await list.openHistory(list.row('JP'));
    });

    await step('Assert: Expected 4 — The history shows exactly the reason typed in step 1', async () => {
      await expect(list.historyDialog.cell(list.historyDialog.rows.first(), 'reason'), '[Expected 4] Newest record carries the reason').toHaveText(reason);
      expect((await territoryApi.history('JP'))[0].reason, '[Expected 4] Stored in full').toBe(reason);
    });
  });

  test('TC_US089_48 — The six reason-length boundary points 9, 10, 11, 254, 255 and 256', async ({ page, territoryApi, territoryState, territoryEditPage: edit }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_48', 'Medium', TAGS, `With JP → 과세: 9 characters keeps 저장 disabled; 10, 11 and 254 enable it; 255 is accepted and saves with the toast; a 256-character paste keeps only 255; "   Reason 123   " still enables 저장 (trimmed to 10). ${DATA}`);
    const A = (n: number) => 'A'.repeat(n);
    let saved = 0;

    await step('Arrange: Pre-condition 1–2 — ADMIN; JP is 영세율 / Required', async () => {
      await territoryState.prepare('JP', JP_NORMAL);
      await edit.open('JP');
    });

    await step('Act: Step 1 — Change VAT treatment to 과세', async () => {
      await edit.vatSelect.selectOption('TAXABLE_STANDARD');
    });

    await step('Assert: Expected 1 — The picker takes the value; 저장 is disabled', async () => {
      await expect(edit.vatSelect, '[Expected 1] Picker at 과세').toHaveValue('TAXABLE_STANDARD');
      await expect(edit.saveButton, '[Expected 1] 저장 (Save) is disabled').toBeDisabled();
    });

    for (const [n, text, enabled] of [[2, 'Reason 12', false], [3, 'Reason 123', true], [4, 'Reason 1234', true]] as const) {
      await step(`Act: Step ${n} — Type the ${text.length}-character string "${text}"`, () => edit.reasonInput.fill(text));
      await step(`Assert: Expected ${n} — 저장 (Save) is ${enabled ? 'enabled' : 'still disabled'}`, async () => {
        if (enabled) await expect(edit.saveButton, `[Expected ${n}] 저장 enabled at ${text.length} characters`).toBeEnabled();
        else await expect(edit.saveButton, `[Expected ${n}] 저장 disabled at ${text.length} characters`).toBeDisabled();
      });
    }

    await step('Act: Step 5 — Paste a 254-character string of A', () => edit.reasonInput.fill(A(254)));
    await step('Assert: Expected 5 — All 254 characters accepted; 저장 enabled', async () => {
      await expect(edit.reasonInput, '[Expected 5] 254 characters accepted').toHaveValue(A(254));
      await expect(edit.saveButton, '[Expected 5] 저장 enabled').toBeEnabled();
    });

    await step('Act: Step 6 — Paste a 255-character string of A, then 저장 and Confirm and save', async () => {
      await edit.reasonInput.fill(A(255));
      await expect(edit.reasonInput, '255 characters accepted').toHaveValue(A(255));
      await expect(edit.saveButton, '저장 enabled at 255').toBeEnabled();
      await edit.openConfirm();
      saved = (await edit.confirmSave()).status();
    });

    await step('Assert: Expected 6 — The save at exactly 255 succeeds with the toast', async () => {
      expect(saved, '[Expected 6] The save succeeds').toBe(200);
      await expect(edit.savedToast(), '[Expected 6] The saved toast').toBeVisible();
      expect((await territoryApi.history('JP'))[0].reason, '[Expected 6] All 255 characters stored').toBe(A(255));
    });

    await step('Act: Step 7 — Paste a 256-character string of A and count the accepted characters', async () => {
      await edit.open('JP');
      await edit.reasonInput.fill('');
      await edit.reasonInput.focus();
      await page.keyboard.insertText(A(256));
    });

    await step('Assert: Expected 7 — Only the first 255 characters are accepted', async () => {
      expect((await edit.reasonInput.inputValue()).length, '[Expected 7] The box holds 255 characters').toBe(255);
    });

    await step('Act: Step 8 — Type "   Reason 123   " (10 characters padded with spaces)', async () => {
      await edit.vatSelect.selectOption('ZERO_RATED');
      await edit.reasonInput.fill('   Reason 123   ');
    });

    await step('Assert: Expected 8 — 저장 is enabled — the padding is trimmed before counting', async () => {
      await expect(edit.saveButton, '[Expected 8] 저장 enabled').toBeEnabled();
    });
  });

  test('TC_US089_52 — The multi-line reason box: line breaks, an HTML tag and line breaks toward the minimum', async ({ page, territoryApi, territoryState, territoryListPage: list, territoryEditPage: edit }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_52', 'Medium', TAGS, `A two-line reason shows two lines in the box; Expected 3 and 5 are NEEDS CLARIFICATION — the test records whether the line break survives the save and whether "abcd" + six line breaks enables 저장; Expected 4 must hold: "<b>bold text</b>" reads back as plain text, never rendered bold. ${DATA}`);
    const observed: string[] = [];
    let lineCount = 0;

    const openJp = async () => {
      await list.open();
      await list.setCriteria({ keyword: 'JP' });
      await list.search();
      await list.openRow('JP');
    };

    await step('Arrange: Pre-condition 1–2 — ADMIN; JP is 영세율', async () => {
      await territoryState.prepare('JP', JP_NORMAL);
      await openJp();
    });

    await step('Act: Step 1 — Change VAT treatment to 과세', async () => {
      await edit.vatSelect.selectOption('TAXABLE_STANDARD');
    });

    await step('Assert: Expected 1 — The picker takes the new value', async () => {
      await expect(edit.vatSelect, '[Expected 1] Picker at 과세').toHaveValue('TAXABLE_STANDARD');
    });

    await step('Act: Step 2 — Type "First line", Enter, "Second line" and look at the input', async () => {
      await edit.reasonInput.fill('');
      await edit.reasonInput.pressSequentially('First line');
      await edit.reasonInput.press('Enter');
      await edit.reasonInput.pressSequentially('Second line');
      lineCount = (await edit.reasonInput.inputValue()).split('\n').length;
    });

    await step('Assert: Expected 2 — The input displays two distinct lines', async () => {
      expect(lineCount, '[Expected 2] Two lines in the box').toBe(2);
    });

    await step('Act: Step 3 — Save, open the change history and read the Reason column', async () => {
      await edit.openConfirm();
      await edit.confirmSave();
      await list.setCriteria({ keyword: 'JP' });
      await list.search();
      await list.openHistory(list.row('JP'));
      const stored = (await territoryApi.history('JP'))[0].reason;
      const shown = (await list.historyDialog.cell(list.historyDialog.rows.first(), 'reason').innerText()).trim();
      observed.push(`stored=${JSON.stringify(stored)}`, `shown=${JSON.stringify(shown)}`);
      await list.historyDialog.close();
    });

    await step('Assert: Expected 3 — NEEDS CLARIFICATION: record whether the line break is kept', async () => {
      test.info().annotations.push({ type: 'Observed (Expected 3)', description: observed.join('; ') });
      expect(observed.join(' '), '[Expected 3] The saved reason carries both lines').toMatch(/First line[\s\S]*Second line/);
    });

    await step('Act: Step 4 — Open JP again, save the reason "<b>bold text</b>" and re-read the history', async () => {
      await list.openRow('JP');
      await edit.saveChange({ vat: 'ZERO_RATED', reason: '<b>bold text</b>' });
      await list.setCriteria({ keyword: 'JP' });
      await list.search();
      await list.openHistory(list.row('JP'));
    });

    await step('Assert: Expected 4 — The string shows as plain text, not rendered bold', async () => {
      const cell = list.historyDialog.cell(list.historyDialog.rows.first(), 'reason');
      await expect(cell, '[Expected 4] The tag reads back literally').toHaveText('<b>bold text</b>');
      await expect(cell.locator('b'), '[Expected 4] No <b> element is rendered').toHaveCount(0);
      await list.historyDialog.close();
    });

    await step('Act: Step 5 — Open JP, type "abcd" then six line breaks and look at 저장 (Save)', async () => {
      await list.openRow('JP');
      await edit.vatSelect.selectOption('TAXABLE_STANDARD');
      await edit.reasonInput.fill('abcd\n\n\n\n\n\n');
      observed.push(`abcd+6 line breaks → 저장 enabled: ${await edit.saveButton.isEnabled()}`);
    });

    await step('Assert: Expected 5 — NEEDS CLARIFICATION: record the real state of 저장 (Save)', async () => {
      test.info().annotations.push({ type: 'Observed (Expected 5)', description: observed[observed.length - 1] });
      expect(observed[observed.length - 1], '[Expected 5] The state of 저장 is recorded').toMatch(/저장 enabled: (true|false)$/);
    });
  });

  test('TC_US089_53 — A Korean / special-character reason is stored verbatim and rendered back unchanged', async ({ page, territoryApi, territoryState, territoryListPage: list, territoryEditPage: edit }) => {
    const step = makeStep(page);
    const korean = 'KE 재무팀이 26.09 마감에 대해 과세로 확인했습니다';
    const mixed = 'KE Finance 확인 — AT & JP: 과세 (100% standard rate)';
    await tcMeta('TC_US089_53', 'Medium', TAGS, `JP saved with a Korean-only reason and AT with a mixed-character reason; both history dialogs and the stored records (API) read back character for character. Data: JP and AT edited and restored in teardown (shared dev).`);
    const status: Record<string, number> = {};

    const openRow = async (code: string) => {
      await list.open();
      await list.setCriteria({ keyword: code });
      await list.search();
      await list.openRow(code);
    };
    const openHistory = async (code: string) => {
      await list.setCriteria({ keyword: code });
      await list.search();
      await list.openHistory(list.row(code));
    };

    await step('Arrange: Pre-condition 1–3 — ADMIN; JP and AT are 영세율', async () => {
      await territoryState.prepare('JP', JP_NORMAL);
      await territoryState.prepare('AT', NORMAL_FLAGS('AT'));
    });

    await step('Act: Step 1 — Save JP → 과세 with the Korean-only reason', async () => {
      await openRow('JP');
      await edit.vatSelect.selectOption('TAXABLE_STANDARD');
      await edit.reasonInput.fill(korean);
      await expect(edit.saveButton, '저장 is enabled for the Korean reason').toBeEnabled();
      await edit.openConfirm();
      status.JP = (await edit.confirmSave()).status();
    });

    await step('Assert: Expected 1 — The save succeeds; 저장 was not disabled', async () => {
      expect(status.JP, '[Expected 1] The save succeeds').toBe(200);
    });

    await step('Act: Step 2 — Save AT → 과세 with the mixed-character reason', async () => {
      await openRow('AT');
      status.AT = (await edit.saveChange({ vat: 'TAXABLE_STANDARD', reason: mixed })).status();
    });

    await step('Assert: Expected 2 — The save succeeds', async () => {
      expect(status.AT, '[Expected 2] The save succeeds').toBe(200);
    });

    await step('Act: Step 3 — Open the JP change history and read the Reason column', async () => {
      await openHistory('JP');
    });

    await step('Assert: Expected 3 — The Korean string exactly as typed', async () => {
      await expect(list.historyDialog.cell(list.historyDialog.rows.first(), 'reason'), '[Expected 3] Korean reason verbatim').toHaveText(korean);
      await list.historyDialog.close();
    });

    await step('Act: Step 4 — Open the AT change history and read the Reason column', async () => {
      await openHistory('AT');
    });

    await step('Assert: Expected 4 — The mixed string exactly as typed', async () => {
      await expect(list.historyDialog.cell(list.historyDialog.rows.first(), 'reason'), '[Expected 4] Mixed reason verbatim').toHaveText(mixed);
    });

    await step('Act: Step 5 — Read both stored reasons (API) and compare them', async () => {
      await list.historyDialog.close();
    });

    await step('Assert: Expected 5 — Both stored reasons match character for character', async () => {
      expect((await territoryApi.history('JP'))[0].reason, '[Expected 5] JP stored reason').toBe(korean);
      expect((await territoryApi.history('AT'))[0].reason, '[Expected 5] AT stored reason').toBe(mixed);
    });
  });

  test('TC_US089_54 — Back and Esc on the confirmation return to the form keeping every entered value', async ({ page, territoryState, territoryEditPage: edit }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_54', 'Medium', TAGS, 'With JP set to 과세, unticked and a reason typed, Back closes the confirmation and keeps all three values; Esc must behave exactly like Back. Data: JP prepared to 영세율 / Required and restored in teardown; nothing is saved.');
    const reason = 'KE Finance confirmed JP is taxable for the 26.09 cycle';
    let escClosed = false;
    const keepsValues = async (n: number) => {
      await expect(edit.vatSelect, `[Expected ${n}] Picker still 과세`).toHaveValue('TAXABLE_STANDARD');
      await expect(edit.exportCheckbox, `[Expected ${n}] Checkbox still unticked`).not.toBeChecked();
      await expect(edit.reasonInput, `[Expected ${n}] Reason still typed`).toHaveValue(reason);
    };

    await step('Arrange: Pre-condition 1–2 — ADMIN; JP is 영세율 / Required', async () => {
      await territoryState.prepare('JP', JP_NORMAL);
      await edit.open('JP');
    });

    await step('Act: Step 1 — Set 과세, untick the declaration and type the reason', async () => {
      await edit.vatSelect.selectOption('TAXABLE_STANDARD');
      await edit.exportCheckbox.uncheck();
      await edit.reasonInput.fill(reason);
    });

    await step('Assert: Expected 1 — All three values entered; 저장 enabled', async () => {
      await keepsValues(1);
      await expect(edit.saveButton, '[Expected 1] 저장 enabled').toBeEnabled();
    });

    await step('Act: Step 2 — Click 저장 (Save), then Back', async () => {
      await edit.openConfirm();
      await edit.confirmDialog.back();
    });

    await step('Assert: Expected 2 — The dialog closes; back on Edit territory', async () => {
      await expect(edit.confirmDialog.root, '[Expected 2] Dialog closed').toHaveCount(0);
      await expect(edit.code, '[Expected 2] Still on the JP edit screen').toHaveText('JP');
    });

    await step('Act: Step 3 — Re-read the picker, the checkbox and the Reason box', async () => {
      await edit.vatSelect.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — All three values kept', async () => {
      await keepsValues(3);
    });

    await step('Act: Step 4 — Click 저장 (Save) again, then press Esc', async () => {
      await edit.openConfirm();
      escClosed = await edit.confirmDialog.closeByEscape();
      if (!escClosed) await edit.confirmDialog.back();
    });

    await step('Assert: Expected 4 — Esc behaves exactly like Back and closes the dialog', async () => {
      expect(escClosed, '[Expected 4] Esc closes the confirmation dialog').toBe(true);
    });

    await step('Act: Step 5 — Re-read the three values once more', async () => {
      await edit.vatSelect.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 5 — All three values still unchanged', async () => {
      await keepsValues(5);
    });
  });

  test('TC_US089_55 — The ways to close the confirmation dialog and its state when reopened', async ({ page, territoryState, territoryEditPage: edit }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_55', 'Medium', TAGS, 'The JP confirmation has no corner X and no Cancel; clicking the overlay closes it keeping the form; reopening shows the same one-row diff with the conflict area hidden; after also changing the declaration the diff is rebuilt with two rows. Data: JP prepared to 영세율 / Required and restored in teardown; nothing is saved.');
    const reason = 'Check the ways to close the confirmation dialog';
    let overlayClosed = false;

    await step('Arrange: Pre-condition 1–2 — ADMIN; JP is 영세율 / Required', async () => {
      await territoryState.prepare('JP', JP_NORMAL);
      await edit.open('JP');
    });

    await step('Act: Step 1 — Set 과세, type the reason and click 저장 (Save)', async () => {
      await edit.vatSelect.selectOption('TAXABLE_STANDARD');
      await edit.reasonInput.fill(reason);
      await edit.openConfirm();
    });

    await step('Assert: Expected 1 — The dialog opens with a one-row difference table', async () => {
      await expect(edit.confirmDialog.diffRows, '[Expected 1] One diff row').toHaveCount(1);
    });

    await step('Act: Step 2 — Check the corners for an X and the footer for Cancel', async () => {
      await edit.confirmDialog.content.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — No X, no Cancel — only Back and Confirm and save', async () => {
      await expect(edit.confirmDialog.cornerClose, '[Expected 2] No X close button').toHaveCount(0);
      await expect(edit.confirmDialog.content.getByRole('button'), '[Expected 2] Exactly two buttons').toHaveCount(2);
      await expect(edit.confirmDialog.backButton, '[Expected 2] Back').toBeVisible();
      await expect(edit.confirmDialog.confirmButton, '[Expected 2] Confirm and save').toBeVisible();
    });

    await step('Act: Step 3 — Click the dimmed overlay outside the dialog', async () => {
      overlayClosed = await edit.confirmDialog.closeByOverlay();
      if (!overlayClosed) await edit.confirmDialog.back();
    });

    await step('Assert: Expected 3 — The dialog closes; the form keeps 과세 and the reason', async () => {
      expect(overlayClosed, '[Expected 3] The overlay click closes the dialog').toBe(true);
      await expect(edit.vatSelect, '[Expected 3] Picker still 과세').toHaveValue('TAXABLE_STANDARD');
      await expect(edit.reasonInput, '[Expected 3] Reason kept').toHaveValue(reason);
    });

    await step('Act: Step 4 — Click 저장 (Save) to reopen and read the diff and the warning area', async () => {
      await edit.openConfirm();
    });

    await step('Assert: Expected 4 — Same one VAT row; conflict area hidden', async () => {
      await expect(edit.confirmDialog.diffRows, '[Expected 4] One diff row').toHaveCount(1);
      await expect(edit.confirmDialog.diffKey(edit.confirmDialog.diffRows.first()), '[Expected 4] The row is VAT treatment').toHaveText(/^(VAT treatment|부가세 처리)$/);
      await expect(edit.confirmDialog.conflict, '[Expected 4] No conflict warning').toHaveCount(0);
    });

    await step('Act: Step 5 — Back, change the declaration too and click 저장 (Save) again', async () => {
      await edit.confirmDialog.back();
      await edit.exportCheckbox.uncheck();
      await edit.openConfirm();
    });

    await step('Assert: Expected 5 — The diff is rebuilt with two rows', async () => {
      await expect(edit.confirmDialog.diffRows, '[Expected 5] Two diff rows').toHaveCount(2);
      await edit.confirmDialog.back();
    });
  });

  test('TC_US089_56 — Both back-to-list controls keep the page and filters and discard unsaved entries', async ({ page, territoryListPage: list, territoryEditPage: edit }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_56', 'Medium', TAGS, `From page 2 of the Required list, the header back control and 목록으로 both return straight to page 2 with Required kept and no prompt; reopening shows an empty reason and the stored flags. Deviation: the header band has no back control left of the title (DOM 29/09) — the breadcrumb "Territories" link is used as the header control and its position is checked softly; the Matching-filters counter wording is soft (see TC_US089_27). Data: nothing is saved.`);
    let code = '';
    let stored = { vat: '', exp: false };
    const listState = async () => ({ from: parseCounter(((await list.counter.textContent()) ?? '').trim())?.from, filter: await list.exportSelect.inputValue() });

    await step('Arrange: Pre-condition 1–2 — ADMIN; every ISO code has a row', async () => {
      await list.open();
    });

    await step('Act: Step 1 — Export declaration = Required, Search, move to page 2', async () => {
      await list.setCriteria({ exportFlag: 'true' });
      await list.search();
      await list.goToPage('2');
    });

    await step('Assert: Expected 1 — Filtered on Required and showing page 2', async () => {
      expect(await listState(), '[Expected 1] Page 2 of the Required result').toEqual({ from: 11, filter: 'true' });
    });

    await step('Act: Step 2 — Click a row on page 2, change the VAT picker and type the reason', async () => {
      code = (await list.codes())[0];
      await list.openRow(code);
      stored = { vat: await edit.vatSelect.inputValue(), exp: await edit.exportCheckbox.isChecked() };
      await edit.vatSelect.selectOption(stored.vat === 'ZERO_RATED' ? 'TAXABLE_STANDARD' : 'ZERO_RATED');
      await edit.reasonInput.fill('These entries will be discarded on going back to the list');
    });

    await step('Assert: Expected 2 — The edit screen takes both values', async () => {
      await expect(edit.vatSelect, '[Expected 2] Picker changed').not.toHaveValue(stored.vat);
      await expect(edit.reasonInput, '[Expected 2] Reason typed').not.toHaveValue('');
    });

    await step('Act: Step 3 — Click the back control in the page header band', async () => {
      const [link, title] = [await edit.headerBackLink.boundingBox(), await edit.title.boundingBox()];
      expect.soft((link?.x ?? 0) < (title?.x ?? 0), 'The header back control sits to the left of the title').toBe(true);
      await list.untilListed(() => edit.click(edit.headerBackLink, 'Header back control (breadcrumb Territories)'));
    });

    await step('Assert: Expected 3 — Back on the list immediately, no dialog about unsaved data', async () => {
      await expect(page, '[Expected 3] Back on the list').toHaveURL(/\/commerce\/territories(\?|$)/);
      await expect(edit.confirmDialog.root, '[Expected 3] No prompt').toHaveCount(0);
    });

    await step('Act: Step 4 — Look at the page, the Export declaration picker and the counter', async () => {
      await list.pagination.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — Still page 2, Required kept, Matching-filters counter', async () => {
      expect(await listState(), '[Expected 4] Page 2 and Required kept').toEqual({ from: 11, filter: 'true' });
      await expect.soft(list.counter, '[Expected 4] Counter reads "Matching filters: {n} · showing {a}-{b}"').toHaveText(/^Matching filters: \d+ · showing \d+-\d+$/);
    });

    await step('Act: Step 5 — Reopen the row, type a reason, click 목록으로 and reopen once more', async () => {
      await list.openRow(code);
      await edit.reasonInput.fill('Another discarded reason');
      await list.untilListed(() => edit.click(edit.backButton, '목록으로 (Back to list) button'));
      expect(await listState(), 'Footer control: page 2 and Required kept').toEqual({ from: 11, filter: 'true' });
      await list.openRow(code);
    });

    await step('Assert: Expected 5 — Same page and filter; reopening shows an empty reason and the stored flags', async () => {
      await expect(edit.reasonInput, '[Expected 5] Reason empty').toHaveValue('');
      await expect(edit.vatSelect, '[Expected 5] VAT back at the stored value').toHaveValue(stored.vat);
      await expect(edit.exportCheckbox, '[Expected 5] Declaration back at the stored value').toBeChecked({ checked: stored.exp });
    });
  });

  test('TC_US089_60 — The confirm button is disabled while the request is in flight so a double click writes once', async ({ page, territoryApi, territoryState, territoryEditPage: edit }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_60', 'High', TAGS, `The JP save request is held in flight (network interception instead of throttling); Confirm and save disables immediately, a second click sends no second request, exactly one new history record is created and the version grows by exactly one. Deviation: "no history record yet" → the record count is compared before / after. ${DATA}`);
    let held: Route | undefined;
    let patches = 0;
    let before = { history: 0, version: 0 };

    await step('Arrange: Pre-condition 1–4 — ADMIN; JP is 영세율; the save request is held in flight', async () => {
      const row = await territoryState.prepare('JP', JP_NORMAL);
      before = { history: (await territoryApi.history('JP')).length, version: row.version };
      await page.route(/\/api\/v1\/territories\/JP$/, async (route) => {
        if (route.request().method() !== 'PATCH') return route.continue();
        patches += 1;
        held = route;
      });
      await edit.open('JP');
    });

    await step('Act: Step 1 — Set 과세, type the reason and click 저장 (Save)', async () => {
      await edit.vatSelect.selectOption('TAXABLE_STANDARD');
      await edit.reasonInput.fill('Check the double-click guard on Confirm and save');
      await edit.openConfirm();
    });

    await step('Assert: Expected 1 — The dialog opens with a one-row difference table', async () => {
      await expect(edit.confirmDialog.diffRows, '[Expected 1] One diff row').toHaveCount(1);
    });

    await step('Act: Step 2 — Click Confirm and save once and watch the button', async () => {
      await edit.click(edit.confirmDialog.confirmButton, '확인 후 저장 (Confirm and save) button');
      await expect.poll(() => patches, { message: 'The save request was sent' }).toBe(1);
    });

    await step('Assert: Expected 2 — Confirm and save becomes disabled while the request runs', async () => {
      await expect(edit.confirmDialog.confirmButton, '[Expected 2] Disabled while in flight').toBeDisabled();
    });

    await step('Act: Step 3 — Click Confirm and save a second time while the request is running', async () => {
      await edit.confirmDialog.confirmButton.click({ force: true });
    });

    await step('Assert: Expected 3 — No second request is sent', async () => {
      expect(patches, '[Expected 3] Still exactly one request').toBe(1);
    });

    await step('Act: Step 4 — Let the request finish and read the JP history (API)', async () => {
      const done = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/api\/v1\/territories\/JP$/.test(r.url()));
      await held?.continue();
      expect((await done).status(), 'The save succeeds').toBe(200);
      await page.unroute(/\/api\/v1\/territories\/JP$/);
    });

    await step('Assert: Expected 4 — Exactly ONE new history record', async () => {
      expect((await territoryApi.history('JP')).length - before.history, '[Expected 4] One new record').toBe(1);
    });

    await step('Act: Step 5 — Read the JP version (API)', async () => {
      await expect(edit.savedToast(), 'The saved toast').toBeVisible();
    });

    await step('Assert: Expected 5 — The version grew by exactly one', async () => {
      expect((await territoryApi.get('JP')).body.version - before.version, '[Expected 5] Version +1').toBe(1);
    });
  });
});
