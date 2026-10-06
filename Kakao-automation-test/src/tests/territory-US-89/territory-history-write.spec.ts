import { test, expect } from '@fixtures/territory.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { isClipped } from '@utils/layout';
import { getAccountDisplayName } from '@utils/auth-token';
import { TERRITORY_TEXT, NORMAL_FLAGS, toSeoulMinute, type TerritoryFlags } from '@utils/territory.data';
import type { TerritoryApi } from '@api/territory.api';

/**
 * US089 — nhóm [History] cần bản ghi lịch sử mới. Bản ghi tiền điều kiện ("JP has been edited …") tạo qua API ở Arrange;
 * bản ghi của bước TC tạo qua UI. Dev dùng chung có sẵn bản ghi cũ + người khác sửa cùng lúc → assert trên các bản ghi
 * test vừa tạo (nằm trên cùng) và số bản ghi trước / sau. Teardown ghi trả cờ gốc.
 */
const TAGS = ['history', 'territory'];
const KO = TERRITORY_TEXT.ko;
const EN = TERRITORY_TEXT.en;
const DATA = 'Data: the country is edited (UI / API) and restored to its original values in teardown (shared dev).';
const JP_NORMAL = NORMAL_FLAGS('JP');
const STRUCK = /line-through/;

/** Ghi 1 thay đổi qua API (đảo VAT so với hiện tại) với `reason` — tạo bản ghi tiền điều kiện. */
async function editViaApi(api: TerritoryApi, code: string, reason: string, flags?: TerritoryFlags): Promise<void> {
  const row = (await api.get(code)).body;
  const next = flags ?? { vat: row.vatTreatment === 'ZERO_RATED' ? 'TAXABLE_STANDARD' : 'ZERO_RATED', exportRequired: row.exportDeclarationRequired };
  const { status } = await api.update(code, { vatTreatment: next.vat, exportDeclarationRequired: next.exportRequired, reason, version: row.version });
  if (status !== 200) throw new Error(`Pre-condition edit of ${code} failed (status ${status})`);
}

test.describe('[History] Territory — records written by a save', () => {
  test.describe.configure({ timeout: 150_000 });

  test('TC_US089_13 — The history reason column wraps a 255-character reason, is never clipped and keeps it in the tooltip', async ({ page, territoryApi, territoryState, territoryListPage: list }) => {
    const step = makeStep(page);
    const reason = 'A'.repeat(255);
    await tcMeta('TC_US089_13', 'Medium', TAGS, `JP saved with a 255 × "A" reason (API, pre-condition); in the JP history the newest Reason cell shows all 255 characters wrapped inside the cell, not clipped, with no ellipsis, and its tooltip carries the same 255 characters. ${DATA}`);
    let shown = '';
    let clipped = true;
    let overflow = '';
    let height = { cell: 0, line: 0 };
    let title = '';

    await step('Arrange: Pre-condition 1–2 — JP saved once with a 255-character reason of "A"', async () => {
      await territoryState.prepare('JP', JP_NORMAL);
      await editViaApi(territoryApi, 'JP', reason);
    });

    await step('Act: Step 1 — Open the JP change history', async () => {
      await list.open();
      await list.setCriteria({ keyword: 'JP' });
      await list.search();
      await list.openHistory(list.row('JP'));
    });

    await step('Assert: Expected 1 — The dialog shows the record just created', async () => {
      await expect(list.historyDialog.cell(list.historyDialog.rows.first(), 'reason'), '[Expected 1] The newest record carries the 255-character reason').toHaveText(reason);
    });

    await step('Act: Step 2 — Look at the Reason cell of that record', async () => {
      const cell = list.historyDialog.cell(list.historyDialog.rows.first(), 'reason');
      shown = (await cell.innerText()).replace(/\s/g, '');
      clipped = await isClipped(cell);
      overflow = await cell.evaluate((el) => getComputedStyle(el).textOverflow);
      height = await cell.evaluate((el) => ({ cell: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight) || 20 }));
    });

    await step('Assert: Expected 2 — All 255 characters, wrapping inside the cell, not clipped, no ellipsis', async () => {
      expect(shown, '[Expected 2] All 255 characters displayed').toBe(reason);
      expect(clipped, '[Expected 2] Not clipped').toBe(false);
      expect(overflow, '[Expected 2] No ellipsis').not.toBe('ellipsis');
      expect(height.cell, '[Expected 2] The text wraps onto several lines').toBeGreaterThan(height.line * 1.5);
    });

    await step('Act: Step 3 — Hover over the Reason cell and read the tooltip', async () => {
      const cell = list.historyDialog.cell(list.historyDialog.rows.first(), 'reason');
      await cell.hover();
      title = (await cell.getAttribute('title')) ?? '';
    });

    await step('Assert: Expected 3 — The tooltip shows exactly the same 255 characters', async () => {
      expect(title, '[Expected 3] Tooltip = the 255-character reason').toBe(reason);
    });
  });

  test('TC_US089_69 — The history lists newest first with all five columns and never shows the version', async ({ page, territoryApi, territoryState, territoryListPage: list }) => {
    const step = makeStep(page);
    const reasons = ['History order check — first edit', 'History order check — second edit', 'History order check — third edit'];
    await tcMeta('TC_US089_69', 'Medium', TAGS, `JP edited three times (API) with three reasons; the dialog shows the five columns, the third edit on top and the first below it, Setting / Change on top (old struck → new bold), no version anywhere, and each record its own reason. Deviation: the three edits are made back to back instead of one minute apart (no hard waits) — the order is checked by the records' reasons. ${DATA}`);
    let texts = '';

    await step('Arrange: Pre-condition 1–2 — JP edited three times with different reasons', async () => {
      await territoryState.prepare('JP', JP_NORMAL);
      for (const reason of reasons) await editViaApi(territoryApi, 'JP', reason);
    });

    await step('Act: Step 1 — Open the JP change history', async () => {
      await list.open();
      await list.setCriteria({ keyword: 'JP' });
      await list.search();
      await list.openHistory(list.row('JP'));
    });

    await step('Assert: Expected 1 — Five columns When / Who / Setting / Change / Reason', async () => {
      for (const [i, name] of KO.historyColumns.entries()) {
        await expect(list.historyDialog.headers.nth(i), `[Expected 1] Column ${i + 1} is ${name} (${EN.historyColumns[i]})`).toHaveText(name);
      }
      await expect(list.historyDialog.headers, '[Expected 1] Exactly five columns').toHaveCount(5);
    });

    await step('Act: Step 2 — Read the order of the three records', async () => {
      texts = (await list.historyDialog.records()).slice(0, 3).map((r) => r.reason).join(' | ');
    });

    await step('Assert: Expected 2 — The most recent edit on top, the oldest at the bottom', async () => {
      expect(texts, '[Expected 2] Newest first').toBe([...reasons].reverse().join(' | '));
    });

    await step('Act: Step 3 — Read Setting and Change of the topmost record', async () => {
      await list.historyDialog.rows.first().scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Setting names the field; Change shows old struck through → new bold', async () => {
      const top = list.historyDialog.rows.first();
      const line = list.historyDialog.lines(list.historyDialog.cell(top, 'change')).first();
      await expect(list.historyDialog.cell(top, 'setting'), '[Expected 3] Setting is VAT treatment').toHaveText(/^(VAT treatment|부가세 처리)$/);
      await expect(list.historyDialog.oldValue(line), '[Expected 3] Old value struck through').toHaveCSS('text-decoration-line', STRUCK);
      await expect(list.historyDialog.newValue(line), '[Expected 3] New value in bold').toBeVisible();
    });

    await step('Act: Step 4 — Scan every column for a version mention', async () => {
      texts = (await list.historyDialog.table.innerText()).toLowerCase();
    });

    await step('Assert: Expected 4 — No column or line mentions the version', async () => {
      expect(texts, '[Expected 4] No "version" mention').not.toMatch(/version|버전/);
    });

    await step('Act: Step 5 — Read the Reason column of the three records', async () => {
      texts = (await list.historyDialog.records()).slice(0, 3).map((r) => r.reason).join(' | ');
    });

    await step('Assert: Expected 5 — Each record shows exactly its own reason', async () => {
      const top3 = texts.split(' | ');
      expect(top3, '[Expected 5] Reasons match their own saves').toEqual([...reasons].reverse());
    });
  });

  test('TC_US089_70 — A save that changed both flags shows two stacked lines and the reason once', async ({ page, territoryApi, territoryState, territoryListPage: list, territoryEditPage: edit }) => {
    const step = makeStep(page);
    const reason = 'KE Finance confirmed AT is taxable and needs no declaration';
    await tcMeta('TC_US089_70', 'Medium', TAGS, `AT saved with both flags changed adds ONE history row whose Setting shows two stacked lines (VAT treatment, Export declaration), Change two aligned lines (old struck → new bold) and Reason printed once. Deviation: "no history record yet" → the record count grows by one. ${DATA}`);
    let before = 0;
    let status = 0;

    await step('Arrange: Pre-condition 1–2 — ADMIN; AT is 영세율 / Required', async () => {
      await territoryState.prepare('AT', NORMAL_FLAGS('AT'));
      before = (await territoryApi.history('AT')).length;
      await edit.open('AT');
    });

    await step('Act: Step 1 — Set 과세 and untick Export declaration', async () => {
      await edit.vatSelect.selectOption('TAXABLE_STANDARD');
      await edit.exportCheckbox.uncheck();
    });

    await step('Assert: Expected 1 — Both flags take their new values', async () => {
      await expect(edit.vatSelect, '[Expected 1] Picker at 과세').toHaveValue('TAXABLE_STANDARD');
      await expect(edit.exportCheckbox, '[Expected 1] Unticked').not.toBeChecked();
    });

    await step('Act: Step 2 — Type the reason and save', async () => {
      await edit.reasonInput.fill(reason);
      await edit.openConfirm();
      status = (await edit.confirmSave()).status();
    });

    await step('Assert: Expected 2 — Saved; back on the list', async () => {
      expect(status, '[Expected 2] The save succeeds').toBe(200);
      await expect(page, '[Expected 2] Back on the list').toHaveURL(/\/commerce\/territories(\?|$)/);
    });

    await step('Act: Step 3 — Open the AT change history and count the rows', async () => {
      await list.setCriteria({ keyword: 'AT' });
      await list.search();
      await list.openHistory(list.row('AT'));
    });

    await step('Assert: Expected 3 — Exactly ONE new row for that save', async () => {
      expect((await list.historyDialog.records()).length - before, '[Expected 3] One new row').toBe(1);
      await expect(list.historyDialog.cell(list.historyDialog.rows.first(), 'reason'), '[Expected 3] The top row is this save').toHaveText(reason);
    });

    await step('Act: Step 4 — Read Setting and Change of that row', async () => {
      await list.historyDialog.rows.first().scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — Two stacked Setting lines and two aligned Change lines, old struck → new bold', async () => {
      const top = list.historyDialog.rows.first();
      const settings = list.historyDialog.lines(list.historyDialog.cell(top, 'setting'));
      const changes = list.historyDialog.lines(list.historyDialog.cell(top, 'change'));
      await expect(settings, '[Expected 4] Two Setting lines').toHaveCount(2);
      await expect(settings.nth(0), '[Expected 4] Line 1 VAT treatment').toHaveText(/^(VAT treatment|부가세 처리)$/);
      await expect(settings.nth(1), '[Expected 4] Line 2 Export declaration').toHaveText(/^(Export declaration|수출 ?신고)$/);
      await expect(changes, '[Expected 4] Two Change lines').toHaveCount(2);
      for (const i of [0, 1]) {
        await expect(list.historyDialog.oldValue(changes.nth(i)), `[Expected 4] Change line ${i + 1} old struck through`).toHaveCSS('text-decoration-line', STRUCK);
        await expect(list.historyDialog.newValue(changes.nth(i)), `[Expected 4] Change line ${i + 1} new in bold`).toBeVisible();
        const [s, c] = [await settings.nth(i).boundingBox(), await changes.nth(i).boundingBox()];
        expect(Math.abs((s?.y ?? 0) - (c?.y ?? 99)), `[Expected 4] Line ${i + 1} aligned with its Setting line`).toBeLessThan(4);
      }
    });

    await step('Act: Step 5 — Read the Reason column of that row', async () => {
      await list.historyDialog.cell(list.historyDialog.rows.first(), 'reason').scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 5 — The reason is printed exactly once', async () => {
      const text = await list.historyDialog.cell(list.historyDialog.rows.first(), 'reason').innerText();
      expect(text.split(reason).length - 1, '[Expected 5] The reason appears once').toBe(1);
    });
  });

  test("TC_US089_71 — History labels render in the reader's language", async ({ page, territoryApi, territoryState, territoryListPage: list, territoryEditPage: edit }) => {
    const step = makeStep(page);
    const reason = 'Saved in the Korean interface to test reading it back';
    await tcMeta('TC_US089_71', 'Medium', TAGS, `A JP save made in Korean reads "영세율 → 과세" in the Korean history and "Zero-rated → Taxable (standard)" in the English one; the stored record keeps coded values (ZERO_RATED → TAXABLE_STANDARD). Deviation: the language is switched with ?lang — there is no EN / 한국어 control. ${DATA}`);
    let status = 0;
    const topChange = async () => list.historyDialog.cell(list.historyDialog.rows.first(), 'change');

    await step('Arrange: Pre-condition 1–3 — ADMIN; JP is 영세율', async () => {
      await territoryState.prepare('JP', JP_NORMAL);
    });

    await step('Act: Step 1 — In the Korean interface open JP, set 과세, type the reason and save', async () => {
      await edit.open('JP');
      status = (await edit.saveChange({ vat: 'TAXABLE_STANDARD', reason })).status();
    });

    await step('Assert: Expected 1 — The save succeeds', async () => {
      expect(status, '[Expected 1] The save succeeds').toBe(200);
    });

    await step('Act: Step 2 — Open 변경 이력 and read the Change column of the new record', async () => {
      await list.setCriteria({ keyword: 'JP' });
      await list.search();
      await list.openHistory(list.row('JP'));
    });

    await step('Assert: Expected 2 — 영세율 → 과세 in Korean', async () => {
      await expect(list.historyDialog.cell(list.historyDialog.rows.first(), 'reason'), 'The top record is this save').toHaveText(reason);
      await expect(await topChange(), '[Expected 2] 영세율 → 과세').toHaveText(/^영세율\s*→\s*과세$/);
    });

    await step('Act: Step 3 — Switch to English and reopen the JP change history', async () => {
      await list.historyDialog.close();
      await list.open('en');
      await list.setCriteria({ keyword: 'JP' });
      await list.search();
      await list.openHistory(list.row('JP'));
    });

    await step('Assert: Expected 3 — The same record reads Zero-rated → Taxable (standard)', async () => {
      await expect(list.historyDialog.cell(list.historyDialog.rows.first(), 'reason'), 'Same record').toHaveText(reason);
      await expect(await topChange(), '[Expected 3] Zero-rated → Taxable (standard)').toHaveText(/^Zero-rated\s*→\s*Taxable \(standard\)$/);
    });

    await step('Act: Step 4 — Read the stored before / after values (API)', async () => {
      await list.historyDialog.close();
    });

    await step('Assert: Expected 4 — Coded values are stored, not translated labels', async () => {
      const record = (await territoryApi.history('JP'))[0];
      expect(record.reason, 'The newest record is this save').toBe(reason);
      expect(record.changes, '[Expected 4] Coded before / after').toEqual([{ field: 'vatTreatment', before: 'ZERO_RATED', after: 'TAXABLE_STANDARD' }]);
    });
  });

  test('TC_US089_72 — The Who column carries the account that made the change, never SYSTEM', async ({ page, territoryApi, territoryState, territoryListPage: list, territoryEditPage: edit, secondAdmin }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_72', 'High', TAGS, `A JP save by the first ADMIN shows its login in Who (never SYSTEM) and the stored actor matches; a second edit by the second ADMIN shows the other login, so the two records carry two different names. Deviation: the TC's admin.qc01 / admin.qc02 are the two dev accounts (names read from the session at run time). ${DATA}`);
    const [one, two] = [getAccountDisplayName('submitter'), getAccountDisplayName('approver')];
    let status = 0;

    await step('Arrange: Pre-condition 1–3 — Two ADMIN accounts; JP is 영세율', async () => {
      await territoryState.prepare('JP', JP_NORMAL);
    });

    await step('Act: Step 1 — As the first ADMIN open JP, set 과세 with the reason and save', async () => {
      await edit.open('JP');
      status = (await edit.saveChange({ vat: 'TAXABLE_STANDARD', reason: 'Check the Who column in the change history' })).status();
    });

    await step('Assert: Expected 1 — Saved; back on the list', async () => {
      expect(status, '[Expected 1] The save succeeds').toBe(200);
      await expect(page, '[Expected 1] Back on the list').toHaveURL(/\/commerce\/territories(\?|$)/);
    });

    await step('Act: Step 2 — Open the JP history and read Who of the new record', async () => {
      await list.setCriteria({ keyword: 'JP' });
      await list.search();
      await list.openHistory(list.row('JP'));
    });

    await step('Assert: Expected 2 — Who shows the first account, not SYSTEM', async () => {
      await expect(list.historyDialog.cell(list.historyDialog.rows.first(), 'who'), `[Expected 2] Who is ${one}`).toHaveText(one);
    });

    await step('Act: Step 3 — Read the stored actor of that record (API)', async () => {
      await list.historyDialog.close();
    });

    await step('Assert: Expected 3 — The stored actor is the logged-in account', async () => {
      const record = (await territoryApi.history('JP'))[0];
      expect(record.changedBy, '[Expected 3] Stored actor').toBe(one);
      expect(record.changedBy, '[Expected 3] Not SYSTEM').not.toBe('SYSTEM');
    });

    await step('Act: Step 4 — As the second ADMIN edit JP again, then re-read Who of both records', async () => {
      await secondAdmin.edit.open('JP');
      await secondAdmin.edit.saveChange({ vat: 'ZERO_RATED', reason: 'Second edit by a different account' });
      await list.open();
      await list.setCriteria({ keyword: 'JP' });
      await list.search();
      await list.openHistory(list.row('JP'));
    });

    await step('Assert: Expected 4 — Two different names matching each editor; none empty, none SYSTEM', async () => {
      const [newest, older] = (await list.historyDialog.records()).slice(0, 2);
      expect(newest, '[Expected 4] Newest record by the second account').toMatchObject({ who: two, reason: 'Second edit by a different account' });
      expect(older, '[Expected 4] Older record by the first account').toMatchObject({ who: one, reason: 'Check the Who column in the change history' });
    });
  });

  test('TC_US089_73 — Timestamps display in Seoul time and same-second saves order by record id', async ({ page, territoryApi, territoryState, territoryListPage: list, territoryEditPage: edit }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_73', 'Medium', TAGS, `A JP save shows When as YYYY-MM-DD HH:mm in Seoul time, stored in UTC nine hours behind; two back-to-back saves (API) "Save A / Save B within the same second" are listed B above A and B's record id is greater. Deviations: the stored value is read through the API; "within the same second" is attempted with two consecutive API calls — when the two land in different seconds this is recorded as an observation, and the id ordering is still asserted. ${DATA}`);
    let when = '';
    let storedAt = '';
    let ab: Array<{ id: number | string; changedAt: string; reason: string }> = [];

    await step('Arrange: Pre-condition 1–4 — ADMIN; JP is 영세율', async () => {
      await territoryState.prepare('JP', JP_NORMAL);
    });

    await step('Act: Step 1 — Edit JP once with the reason, open the history and read When', async () => {
      await edit.open('JP');
      await edit.saveChange({ vat: 'TAXABLE_STANDARD', reason: 'First save to check the timestamp format' });
      await list.setCriteria({ keyword: 'JP' });
      await list.search();
      await list.openHistory(list.row('JP'));
      when = (await list.historyDialog.cell(list.historyDialog.rows.first(), 'when').innerText()).trim();
    });

    await step('Assert: Expected 1 — When is exactly YYYY-MM-DD HH:mm', async () => {
      expect(when, '[Expected 1] Format YYYY-MM-DD HH:mm').toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });

    await step('Act: Step 2 — Read the stored timestamp of that record (API)', async () => {
      storedAt = (await territoryApi.history('JP'))[0].changedAt;
    });

    await step('Assert: Expected 2 — Stored in UTC, nine hours behind the displayed time', async () => {
      expect(storedAt, '[Expected 2] Stored as UTC').toMatch(/Z$|\+00:00$/);
      expect(when, '[Expected 2] Displayed = stored + 9 h (Seoul)').toBe(toSeoulMinute(storedAt));
    });

    await step('Act: Step 3 — Produce two consecutive saves "Save A" / "Save B" within the same second (API)', async () => {
      await list.historyDialog.close();
      await editViaApi(territoryApi, 'JP', 'Save A within the same second');
      await editViaApi(territoryApi, 'JP', 'Save B within the same second');
      ab = (await territoryApi.history('JP')).slice(0, 2);
    });

    await step('Assert: Expected 3 — Both records carry the same timestamp to the second', async () => {
      expect(ab.map((r) => r.reason), 'Both saves were recorded').toEqual(['Save B within the same second', 'Save A within the same second']);
      // Hai lời gọi API liên tiếp không đảm bảo cùng giây (không có cách ép thời gian trên dev) → ghi nhận quan sát; thứ tự theo id vẫn được assert ở Expected 4–5.
      const sameSecond = ab[0].changedAt.slice(0, 19) === ab[1].changedAt.slice(0, 19);
      test.info().annotations.push({ type: 'Observed (Expected 3)', description: `Save A ${ab[1].changedAt} / Save B ${ab[0].changedAt} — same second: ${sameSecond}` });
      if (sameSecond) expect(ab[0].changedAt.slice(0, 19), '[Expected 3] Same second').toBe(ab[1].changedAt.slice(0, 19));
    });

    await step('Act: Step 4 — Reopen the history and read the order of the two records', async () => {
      await list.open();
      await list.setCriteria({ keyword: 'JP' });
      await list.search();
      await list.openHistory(list.row('JP'));
    });

    await step('Assert: Expected 4 — Save B above, Save A below', async () => {
      const [first, second] = (await list.historyDialog.records()).slice(0, 2);
      expect([first.reason, second.reason], '[Expected 4] B above A').toEqual(['Save B within the same second', 'Save A within the same second']);
    });

    await step('Act: Step 5 — Compare the identifiers of the two records (API)', async () => {
      await list.historyDialog.close();
    });

    await step('Assert: Expected 5 — Record B has the greater id', async () => {
      expect(BigInt(ab[0].id) > BigInt(ab[1].id), '[Expected 5] id(B) > id(A)').toBe(true);
    });
  });

  test('TC_US089_74 — The reason column shows the typed string verbatim', async ({ page, territoryState, territoryListPage: list, territoryEditPage: edit }) => {
    const step = makeStep(page);
    const first = 'KE Finance confirmed JP is taxable for the 26.09 settlements';
    const second = 'Second edit with a completely different reason';
    await tcMeta('TC_US089_74', 'Medium', TAGS, `JP saved with a 60-character reason shows it verbatim in the history; a second edit with another reason shows each reason on its own record. ${DATA}`);
    let status = 0;
    let shown = '';
    const openHistory = async () => {
      await list.setCriteria({ keyword: 'JP' });
      await list.search();
      await list.openHistory(list.row('JP'));
    };

    await step('Arrange: Pre-condition 1–2 — ADMIN; JP is 영세율', async () => {
      await territoryState.prepare('JP', JP_NORMAL);
      expect(first, 'The TC reason is exactly 60 characters').toHaveLength(60);
    });

    await step('Act: Step 1 — Open JP, set 과세, type the 60-character reason and save', async () => {
      await edit.open('JP');
      status = (await edit.saveChange({ vat: 'TAXABLE_STANDARD', reason: first })).status();
    });

    await step('Assert: Expected 1 — Saved; back on the list', async () => {
      expect(status, '[Expected 1] The save succeeds').toBe(200);
      await expect(page, '[Expected 1] Back on the list').toHaveURL(/\/commerce\/territories(\?|$)/);
    });

    await step('Act: Step 2 — Open the JP history and read the Reason column', async () => {
      await openHistory();
      shown = (await list.historyDialog.records())[0].reason;
    });

    await step('Assert: Expected 2 — The new record shows the reason', async () => {
      expect(shown, '[Expected 2] The reason is shown').not.toBe('');
    });

    await step('Act: Step 3 — Compare the displayed string with the typed one', async () => {
      await list.historyDialog.cell(list.historyDialog.rows.first(), 'reason').scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Character for character identical', async () => {
      expect(shown, '[Expected 3] Verbatim').toBe(first);
    });

    await step('Act: Step 4 — Edit JP again with a different reason and re-read both records', async () => {
      await list.historyDialog.close();
      await list.openRow('JP');
      await edit.saveChange({ vat: 'ZERO_RATED', reason: second });
      await openHistory();
    });

    await step('Assert: Expected 4 — Each record shows its own reason', async () => {
      const [newest, older] = (await list.historyDialog.records()).slice(0, 2);
      expect([newest.reason, older.reason], '[Expected 4] Own reasons').toEqual([second, first]);
    });
  });

  test('TC_US089_78 — The dialog from a list row and from the edit screen shows the same content', async ({ page, territoryApi, territoryState, territoryListPage: list, territoryEditPage: edit }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_78', 'Medium', TAGS, `The JP dialog opened from the list and from the edit screen shows the same sub-line, record count and column content; the AT dialog then binds to AT with its own records. Deviation: on the shared dev JP and AT carry more records than the TC's two / one — the dialogs are compared with each other and with the API count. Data: JP is edited twice and AT once through the API (pre-condition) and both are restored in teardown.`);
    let fromList: Awaited<ReturnType<typeof list.historyDialog.records>> = [];
    let fromEdit: typeof fromList = [];
    let subs = { list: '', edit: '' };

    await step('Arrange: Pre-condition 1–3 — JP edited twice and AT once', async () => {
      await territoryState.prepare('JP', JP_NORMAL);
      await territoryState.prepare('AT', NORMAL_FLAGS('AT'));
      await editViaApi(territoryApi, 'JP', 'Dialog comparison — JP first edit');
      await editViaApi(territoryApi, 'JP', 'Dialog comparison — JP second edit');
      await editViaApi(territoryApi, 'AT', 'Dialog comparison — AT edit');
    });

    await step('Act: Step 1 — Open the JP history from the list; note the sub-line, count and content', async () => {
      await list.open();
      await list.setCriteria({ keyword: 'JP' });
      await list.search();
      await list.openHistory(list.row('JP'));
      subs.list = ((await list.historyDialog.subtitle.textContent()) ?? '').trim();
      fromList = await list.historyDialog.records();
    });

    await step('Assert: Expected 1 — The sub-line carries JP; the records match the register', async () => {
      expect(subs.list, '[Expected 1] Sub-line JP · 일본').toBe('JP · 일본');
      expect(fromList.length, '[Expected 1] Record count matches the register').toBe((await territoryApi.history('JP')).length);
      expect(fromList.slice(0, 2).map((r) => r.reason), '[Expected 1] The two edits are on top').toEqual(['Dialog comparison — JP second edit', 'Dialog comparison — JP first edit']);
    });

    await step('Act: Step 2 — Close, open the JP edit screen and click 변경 이력 by the card title', async () => {
      await list.historyDialog.close();
      await list.openRow('JP');
      await edit.click(edit.historyButton, '변경 이력 (Change history) button');
      await edit.historyDialog.waitLoaded();
    });

    await step('Assert: Expected 2 — The dialog opens from the edit screen', async () => {
      await expect(edit.historyDialog.content, '[Expected 2] Dialog open').toBeVisible();
    });

    await step('Act: Step 3 — Compare sub-line, count and content with step 1', async () => {
      subs.edit = ((await edit.historyDialog.subtitle.textContent()) ?? '').trim();
      fromEdit = await edit.historyDialog.records();
    });

    await step('Assert: Expected 3 — Identical sub-line, count and content', async () => {
      expect(subs.edit, '[Expected 3] Same sub-line').toBe(subs.list);
      expect(fromEdit, '[Expected 3] Same records').toEqual(fromList);
    });

    await step('Act: Step 4 — Close, 목록으로 and open the AT history from the list', async () => {
      await edit.historyDialog.close();
      await edit.click(edit.backButton, '목록으로 (Back to list) button');
      await list.setCriteria({ keyword: 'AT' });
      await list.search();
      await list.openHistory(list.row('AT'));
    });

    await step("Assert: Expected 4 — The dialog binds to AT with AT's own records", async () => {
      await expect(list.historyDialog.subtitle, '[Expected 4] Sub-line AT · 오스트리아').toHaveText('AT · 오스트리아');
      const at = await list.historyDialog.records();
      expect(at.length, '[Expected 4] Record count matches the AT register').toBe((await territoryApi.history('AT')).length);
      expect(at[0].reason, "[Expected 4] AT's own newest record").toBe('Dialog comparison — AT edit');
    });
  });
});
