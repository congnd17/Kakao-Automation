import { test, expect } from '@fixtures/territory.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { getAccountDisplayName } from '@utils/auth-token';
import { TERRITORY_TEXT, NORMAL_FLAGS } from '@utils/territory.data';

/**
 * US089 — hai ADMIN cùng lúc: browser một = congnd17.fpt (page mặc định), browser hai = dungbd.fpt (`secondAdmin`,
 * context riêng). Cả hai có quyền ghi từ 29/09. Ảnh theo step chụp browser một; browser hai đính kèm ảnh cuối riêng.
 */
const TAGS = ['edit', 'territory', 'concurrency'];
const KO = TERRITORY_TEXT.ko;
const DATA = 'Data: JP / AT are edited through the UI and restored to their original values in teardown (shared dev).';
const JP_NORMAL = NORMAL_FLAGS('JP');

test.describe('[Edit] Territory — two admins at once', () => {
  test.describe.configure({ timeout: 180_000 });

  test('TC_US089_22 — The edit screen re-reads the current values and version instead of the list values', async ({ page, territoryState, territoryListPage: list, territoryEditPage: edit, secondAdmin }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_22', 'High', TAGS, `Browser one keeps the list open (JP 영세율) while browser two (second ADMIN) saves JP → 과세; browser one still shows 영세율 until reload, but opening JP on browser one shows the latest 과세. ${DATA}`);
    let status = 0;

    await step('Arrange: Pre-condition 1–3 — Two ADMIN browsers; JP is 영세율 / Required', async () => {
      await territoryState.prepare('JP', JP_NORMAL);
    });

    await step('Act: Step 1 — On browser one open Territory and leave the list untouched', async () => {
      await list.open();
      await list.setCriteria({ keyword: 'JP' });
      await list.search();
    });

    await step('Assert: Expected 1 — The list shows JP with 영세율', async () => {
      await expect(list.cell(list.row('JP'), 'vat'), '[Expected 1] JP shows 영세율').toHaveText(KO.zeroRated);
    });

    await step('Act: Step 2 — On browser two open JP, set 과세 with the reason and save', async () => {
      await secondAdmin.edit.open('JP');
      status = (await secondAdmin.edit.saveChange({ vat: 'TAXABLE_STANDARD', reason: 'Changed from the second browser to test the re-read' })).status();
      await secondAdmin.list.setCriteria({ keyword: 'JP' });
      await secondAdmin.list.search();
    });

    await step('Assert: Expected 2 — Browser two saves and its list shows JP 과세', async () => {
      expect(status, '[Expected 2] Browser two saves').toBe(200);
      await expect(secondAdmin.list.cell(secondAdmin.list.row('JP'), 'vat'), '[Expected 2] Browser two shows 과세').toHaveText(KO.taxable);
    });

    await step('Act: Step 3 — On browser one, without refreshing, read the JP VAT column', async () => {
      await list.row('JP').scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Browser one still shows the old 영세율', async () => {
      await expect(list.cell(list.row('JP'), 'vat'), '[Expected 3] Still 영세율 (not reloaded)').toHaveText(KO.zeroRated);
    });

    await step('Act: Step 4 — On browser one click the JP row', async () => {
      await list.openRow('JP');
    });

    await step('Assert: Expected 4 — The Edit territory screen for JP opens', async () => {
      await expect(edit.code, '[Expected 4] The JP edit screen').toHaveText('JP');
    });

    await step('Act: Step 5 — Read the VAT treatment picker', async () => {
      await edit.vatSelect.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 5 — The picker shows the latest 과세', async () => {
      await expect(edit.vatSelect, '[Expected 5] Latest value 과세, not the stale list value').toHaveValue('TAXABLE_STANDARD');
    });
  });

  test('TC_US089_61 — A save against a stale version is refused, the dialog stays open and the reason is not recorded', async ({ page, territoryApi, territoryState, territoryEditPage: edit, secondAdmin }) => {
    const step = makeStep(page);
    const first = 'First admin sets JP to taxable';
    const second = 'Second admin changes the JP declaration flag';
    await tcMeta('TC_US089_61', 'Critical', TAGS, `Both admins open JP on the same version; browser one saves; browser two's save is refused with TER-1001 (수정하는 동안 다른 사용자가 이 국가를 변경했습니다. …), the dialog stays open with a red blocking warning, Confirm and save disabled and Back enabled; Back keeps the entries; exactly one new history record carrying the first reason. Deviation: "no history record yet" → the record count is compared before / after. ${DATA}`);
    let history = 0;
    let versions = { one: '', two: '' };
    let refused = { status: 0, body: '' };
    let tones = { conflict: '', deviation: '' };

    await step('Arrange: Pre-condition 1–3 — Two ADMIN browsers; JP is 영세율 / Required', async () => {
      await territoryState.prepare('JP', JP_NORMAL);
      history = (await territoryApi.history('JP')).length;
    });

    await step('Act: Step 1 — On both browsers open the JP edit screen', async () => {
      const read = (p: typeof page) => p.waitForResponse((r) => r.request().method() === 'GET' && /\/api\/v1\/territories\/JP$/.test(r.url()));
      const [one] = await Promise.all([read(page), edit.open('JP')]);
      const [two] = await Promise.all([read(secondAdmin.page), secondAdmin.edit.open('JP')]);
      versions = { one: String(((await one.json()) as { version: number }).version), two: String(((await two.json()) as { version: number }).version) };
    });

    await step('Assert: Expected 1 — Both screens carry the same version', async () => {
      expect(versions.two, '[Expected 1] Same version on both browsers').toBe(versions.one);
    });

    await step('Act: Step 2 — On browser one set 과세, type the reason and Confirm and save', async () => {
      const response = await edit.saveChange({ vat: 'TAXABLE_STANDARD', reason: first });
      expect(response.status(), 'Browser one saves').toBe(200);
    });

    await step('Assert: Expected 2 — Browser one saves and returns to the list', async () => {
      await expect(page, '[Expected 2] Back on the list').toHaveURL(/\/commerce\/territories(\?|$)/);
    });

    await step('Act: Step 3 — On browser two untick the declaration, type the reason and Confirm and save', async () => {
      const response = await secondAdmin.edit.saveChange({ exportRequired: false, reason: second });
      refused = { status: response.status(), body: await response.text() };
    });

    await step('Assert: Expected 3 — Browser two is refused with TER-1001; nothing written', async () => {
      expect(refused.status, '[Expected 3] The save is refused (4xx)').toBeGreaterThanOrEqual(400);
      expect(refused.body, '[Expected 3] Error code TER-1001').toContain('TER-1001');
      await expect(secondAdmin.edit.confirmDialog.conflict, '[Expected 3] The TER-1001 message is shown').toContainText('수정하는 동안 다른 사용자가 이 국가를 변경했습니다.');
    });

    await step('Act: Step 4 — Look at the dialog and its two buttons on browser two', async () => {
      tones = {
        // Tông màu của khối cảnh báo = chữ + nền + viền (+ icon) — đo cả 4, chữ có thể là màu tối trên nền đỏ nhạt.
        conflict: await secondAdmin.edit.confirmDialog.conflict.evaluate((el) => { const c = getComputedStyle(el); const icon = el.querySelector('svg'); return [c.color, c.backgroundColor, c.borderLeftColor, icon ? getComputedStyle(icon).color : ''].join(' | '); }),
        deviation: await secondAdmin.edit.confirmDialog.deviation.evaluate((el) => { const c = getComputedStyle(el); return [c.color, c.backgroundColor, c.borderLeftColor].join(' | '); }).catch(() => ''),
      };
    });

    await step('Assert: Expected 4 — The dialog stays open in a red tone; Confirm and save disabled, Back enabled', async () => {
      await expect(secondAdmin.edit.confirmDialog.root, '[Expected 4] The dialog stays open').toBeVisible();
      const reddish = tones.conflict.split(' | ').some((c) => { const [r, g, b, a] = (c.match(/[\d.]+/g) ?? []).map(Number); return (a === undefined || a > 0) && r > 150 && r > g + 40 && r > b + 40; });
      expect(reddish, `[Expected 4] The conflict warning is in a red tone (${tones.conflict})`).toBe(true);
      if (tones.deviation) expect(tones.conflict, '[Expected 4] Differs from the amber deviation tone').not.toBe(tones.deviation);
      await expect(secondAdmin.edit.confirmDialog.confirmButton, '[Expected 4] Confirm and save disabled').toBeDisabled();
      await expect(secondAdmin.edit.confirmDialog.backButton, '[Expected 4] Back enabled').toBeEnabled();
    });

    await step('Act: Step 5 — Click Back on browser two and read the Reason box and the checkbox', async () => {
      await secondAdmin.edit.confirmDialog.back();
    });

    await step('Assert: Expected 5 — The checkbox still unticked and the Reason box still holds the typed string', async () => {
      await expect(secondAdmin.edit.exportCheckbox, '[Expected 5] Still unticked').not.toBeChecked();
      await expect(secondAdmin.edit.reasonInput, '[Expected 5] Reason kept').toHaveValue(second);
    });

    await step('Act: Step 6 — Read the JP change history (API)', async () => {
      await page.waitForLoadState();
    });

    await step("Assert: Expected 6 — Exactly one new record with the first admin's reason; the second reason is absent", async () => {
      const records = await territoryApi.history('JP');
      expect(records.length - history, '[Expected 6] Exactly one new record').toBe(1);
      expect(records[0].reason, "[Expected 6] It carries the first admin's reason").toBe(first);
      expect(records.some((r) => r.reason === second), "[Expected 6] The second admin's reason is not stored").toBe(false);
    });
  });

  test('TC_US089_62 — Two admins editing two different countries at the same time both save', async ({ page, territoryApi, territoryState, territoryEditPage: edit, secondAdmin }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_62', 'High', TAGS, `Browser one edits JP and browser two edits AT at the same time; both save (toast, back to list) with no conflict, and each country gets exactly one new history record carrying its own editor's reason. Deviation: "no history record yet" → counts compared before / after. ${DATA}`);
    const reasons = { JP: 'First admin sets JP to taxable', AT: 'Second admin sets AT to taxable' };
    let before = { JP: 0, AT: 0 };
    let statusTwo = 0;
    let statusOne = 0;

    await step('Arrange: Pre-condition 1–3 — Two ADMIN browsers; JP and AT are 영세율', async () => {
      await territoryState.prepare('JP', JP_NORMAL);
      await territoryState.prepare('AT', NORMAL_FLAGS('AT'));
      before = { JP: (await territoryApi.history('JP')).length, AT: (await territoryApi.history('AT')).length };
    });

    await step('Act: Step 1 — Browser one opens JP; browser two opens AT', async () => {
      await edit.open('JP');
      await secondAdmin.edit.open('AT');
    });

    await step('Assert: Expected 1 — Two edit screens for two countries are open at once', async () => {
      await expect(edit.code, '[Expected 1] Browser one on JP').toHaveText('JP');
      await expect(secondAdmin.edit.code, '[Expected 1] Browser two on AT').toHaveText('AT');
    });

    await step('Act: Step 2 — On both browsers set 과세 and type the reasons', async () => {
      await edit.vatSelect.selectOption('TAXABLE_STANDARD');
      await edit.reasonInput.fill(reasons.JP);
      await secondAdmin.edit.vatSelect.selectOption('TAXABLE_STANDARD');
      await secondAdmin.edit.reasonInput.fill(reasons.AT);
    });

    await step('Assert: Expected 2 — Both forms take their values; 저장 enabled on both', async () => {
      await expect(edit.saveButton, '[Expected 2] 저장 enabled on browser one').toBeEnabled();
      await expect(secondAdmin.edit.saveButton, '[Expected 2] 저장 enabled on browser two').toBeEnabled();
    });

    await step('Act: Step 3 — 저장 then Confirm and save on browser one', async () => {
      await edit.openConfirm();
      statusOne = (await edit.confirmSave()).status();
    });

    await step('Assert: Expected 3 — Browser one saves, shows the toast and returns to the list', async () => {
      expect(statusOne, '[Expected 3] Browser one saves').toBe(200);
      await expect(edit.savedToast(), '[Expected 3] Saved toast').toBeVisible();
      await expect(page, '[Expected 3] Back on the list').toHaveURL(/\/commerce\/territories(\?|$)/);
    });

    await step('Act: Step 4 — 저장 then Confirm and save on browser two', async () => {
      await secondAdmin.edit.openConfirm();
      statusTwo = (await secondAdmin.edit.confirmSave()).status();
    });

    await step('Assert: Expected 4 — Browser two also saves with no conflict warning', async () => {
      expect(statusTwo, '[Expected 4] Browser two saves').toBe(200);
      await expect(secondAdmin.edit.confirmDialog.conflict, '[Expected 4] No conflict warning').toHaveCount(0);
      await expect(secondAdmin.edit.savedToast(), '[Expected 4] Saved toast on browser two').toBeVisible();
    });

    await step('Act: Step 5 — Read the change history of JP and AT (API)', async () => {
      await page.waitForLoadState();
    });

    await step('Assert: Expected 5 — Each country has exactly one new record with its own editor and reason', async () => {
      const [jp, at] = [await territoryApi.history('JP'), await territoryApi.history('AT')];
      expect(jp.length - before.JP, '[Expected 5] One new JP record').toBe(1);
      expect(at.length - before.AT, '[Expected 5] One new AT record').toBe(1);
      expect({ who: jp[0].changedBy, reason: jp[0].reason }, '[Expected 5] JP record').toEqual({ who: getAccountDisplayName('submitter'), reason: reasons.JP });
      expect({ who: at[0].changedBy, reason: at[0].reason }, '[Expected 5] AT record').toEqual({ who: getAccountDisplayName('approver'), reason: reasons.AT });
    });
  });
});
