import { test, expect } from '@fixtures/territory.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { getAccountDisplayName } from '@utils/auth-token';
import { TERRITORY_TEXT, NORMAL_FLAGS, pickSeededCountry, toSeoulMinute } from '@utils/territory.data';

/**
 * US089 — nhóm [Edit]: hiển thị, validate và các control của màn sửa. Account có quyền ghi từ 29/09. Quốc gia TC ghi
 * được đưa về đúng cờ tiền điều kiện qua `territoryState` và khôi phục ở teardown; chỉ TC_57 bước 6 thực sự lưu.
 */
const TAGS = ['edit', 'territory'];
const EN = TERRITORY_TEXT.en;
const KO = TERRITORY_TEXT.ko;
const DEVIATION = 'Deviation: the edit screen is opened by its URL (no Territory menu entry — TC_US089_11).';
const DATA = 'Data: the TC flags are prepared if another user changed them and restored in teardown; nothing is saved.';
const RECALCULATE = /recalculat|reprice|repost|재계산|재정산/i;

test.describe('[Edit] Territory edit screen', () => {
  test.describe.configure({ timeout: 120_000 });

  test('TC_US089_42 — The country code and both names are read-only text shown together in either language', async ({ page, territoryApi, territoryEditPage: edit }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_42', 'Medium', TAGS, `The KR block shows 국가 코드 KR, 국가 with South Korea above 대한민국 in muted type, and the ISO 3166-1 sentence; neither spot accepts typing and both are panel text, not locked inputs; both names still show in Korean. ${DEVIATION} ${DATA}`);
    let kr = { nameEn: '', nameKo: '' };
    let colors = { en: '', ko: '' };
    let tags: string[] = [];

    await step('Arrange: Pre-condition 1–3 — Logged in; KR is South Korea / 대한민국; English interface', async () => {
      const row = (await territoryApi.get('KR')).body;
      kr = { nameEn: row.nameEn, nameKo: row.nameKo };
    });

    await step('Act: Step 1 — Open the edit screen of KR', async () => {
      await edit.open('KR', 'en');
    });

    await step('Assert: Expected 1 — The Edit territory screen for KR opens', async () => {
      await expect(edit.code, '[Expected 1] The screen is for KR').toHaveText('KR');
    });

    await step('Act: Step 2 — Read the code and name block with the sentence below it', async () => {
      colors = {
        en: await edit.nameEn.evaluate((el) => getComputedStyle(el).color),
        ko: await edit.nameKo.evaluate((el) => getComputedStyle(el).color),
      };
    });

    await step('Assert: Expected 2 — Code KR, South Korea above 대한민국 in muted type, and the ISO sentence', async () => {
      await expect(edit.identityBox, '[Expected 2] 국가 코드 (Country code) label').toContainText('Country code');
      await expect(edit.code, '[Expected 2] Value KR').toHaveText('KR');
      await expect(edit.nameEn, '[Expected 2] Upper line South Korea').toHaveText(kr.nameEn);
      await expect(edit.nameKo, '[Expected 2] Lower line 대한민국').toHaveText(kr.nameKo);
      const [en, ko] = [await edit.nameEn.boundingBox(), await edit.nameKo.boundingBox()];
      expect(en && ko && ko.y > en.y, '[Expected 2] 대한민국 sits on the line below South Korea').toBe(true);
      expect(colors.ko, '[Expected 2] 대한민국 is in muted type').not.toBe(colors.en);
      await expect(edit.identityBox, '[Expected 2] The ISO 3166-1 sentence').toContainText(EN.identityNote);
    });

    await step('Act: Step 3 — Click the code display and the name display and type a character', async () => {
      await edit.code.click();
      await page.keyboard.type('X');
      await edit.nameEn.click();
      await page.keyboard.type('X');
      tags = [
        await edit.code.evaluate((el) => `${el.tagName}:${(el as HTMLElement).isContentEditable}`),
        await edit.nameEn.evaluate((el) => `${el.tagName}:${(el as HTMLElement).isContentEditable}`),
      ];
    });

    await step('Assert: Expected 3 — Nothing can be typed; both are panel text, not locked input boxes', async () => {
      await expect(edit.code, '[Expected 3] The code is unchanged').toHaveText('KR');
      await expect(edit.nameEn, '[Expected 3] The name is unchanged').toHaveText(kr.nameEn);
      for (const tag of tags) expect(tag, '[Expected 3] Displayed as text, not an input / editable box').toMatch(/^(?!INPUT|TEXTAREA|SELECT)[A-Z0-9]+:false$/);
      await expect(edit.identityBox.locator('input, textarea'), '[Expected 3] No input box inside the identity block').toHaveCount(0);
    });

    await step('Act: Step 4 — Switch the interface to Korean and look at the block again', async () => {
      await edit.open('KR');
    });

    await step('Assert: Expected 4 — Both names still show at the same time', async () => {
      await expect(edit.nameEn, '[Expected 4] South Korea still shows').toHaveText(kr.nameEn);
      await expect(edit.nameKo, '[Expected 4] 대한민국 still shows').toHaveText(kr.nameKo);
    });
  });

  test('TC_US089_44 — The VAT picker has exactly two options and the declaration checkbox moves independently', async ({ page, territoryState, territoryEditPage: edit }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_44', 'Medium', TAGS, `JP opens with 영세율 selected and the checkbox ticked (the stored values); the picker has exactly two options with no blank; changing the picker leaves the checkbox alone and unticking the checkbox leaves the picker alone. ${DEVIATION} ${DATA}`);
    let options: string[] = [];
    let stored = { vat: '', exp: false };

    await step('Arrange: Pre-condition 1–2 — Logged in; JP is 영세율 / Required', async () => {
      const jp = await territoryState.prepare('JP', NORMAL_FLAGS('JP'));
      stored = { vat: jp.vatTreatment, exp: jp.exportDeclarationRequired };
    });

    await step('Act: Step 1 — Open the edit screen of JP and read the picker and the checkbox', async () => {
      await edit.open('JP');
    });

    await step('Assert: Expected 1 — 영세율 selected and the checkbox ticked, matching the stored values', async () => {
      await expect(edit.vatSelect, '[Expected 1] Picker at 영세율 (the stored value)').toHaveValue(stored.vat);
      expect(stored.vat, '[Expected 1] The stored value is 영세율').toBe('ZERO_RATED');
      await expect(edit.exportCheckbox, '[Expected 1] Checkbox ticked (the stored value)').toBeChecked({ checked: stored.exp });
      expect(stored.exp, '[Expected 1] The stored value is Required').toBe(true);
    });

    await step('Act: Step 2 — Open the VAT treatment dropdown and count the options', async () => {
      options = await edit.vatOptions.evaluateAll((els) => els.map((o) => `${(o as HTMLOptionElement).value}|${o.textContent?.trim()}`));
    });

    await step('Assert: Expected 2 — Exactly two options 과세 and 영세율; no blank option', async () => {
      expect(options, '[Expected 2] Exactly two options').toHaveLength(2);
      expect(options[0], '[Expected 2] Option 1 is 과세 (Taxable (standard))').toMatch(/^TAXABLE_STANDARD\|.*과세/);
      expect(options[1], '[Expected 2] Option 2 is 영세율 (Zero-rated)').toMatch(/^ZERO_RATED\|.*영세율/);
      expect(options.some((o) => o.startsWith('|')), '[Expected 2] No blank option').toBe(false);
    });

    await step('Act: Step 3 — Select 과세 (Taxable (standard)) and look at the checkbox', async () => {
      await edit.vatSelect.selectOption('TAXABLE_STANDARD');
    });

    await step('Assert: Expected 3 — The checkbox stays ticked', async () => {
      await expect(edit.exportCheckbox, '[Expected 3] Still ticked').toBeChecked();
    });

    await step('Act: Step 4 — Untick the checkbox and look at the picker', async () => {
      await edit.exportCheckbox.uncheck();
    });

    await step('Assert: Expected 4 — The picker stays at 과세', async () => {
      await expect(edit.vatSelect, '[Expected 4] Still 과세').toHaveValue('TAXABLE_STANDARD');
    });

    await step('Act: Step 5 — Select 영세율 again and look at the checkbox', async () => {
      await edit.vatSelect.selectOption('ZERO_RATED');
    });

    await step('Assert: Expected 5 — The checkbox is still unticked — the two flags move independently', async () => {
      await expect(edit.exportCheckbox, '[Expected 5] Still unticked').not.toBeChecked();
    });
  });

  test('TC_US089_46 — The last-updated line on the edit screen for a never-edited and an edited country', async ({ page, territoryApi, territoryState, territoryListPage: list, territoryEditPage: edit }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_46', 'Medium', TAGS, `A never-edited country shows "Seeded default · {seed timestamp} — no one has changed this country yet."; JP, edited once by the ADMIN account (API, pre-condition), shows "{account} · {timestamp}"; the timestamp is YYYY-MM-DD HH:mm in Seoul time. Deviation: VN was edited by another user on the shared dev — the first country still carrying its seeded values is used when VN no longer qualifies (the code is noted in the report). Data: JP is edited once through the API and restored in teardown.`);
    let seeded = { code: '', seoul: '' };
    let jpSeoul = '';
    const line: Record<string, string> = {};

    await step('Arrange: Pre-condition 1–3 — A never-edited country; JP edited once by an ADMIN', async () => {
      const row = await pickSeededCountry(territoryApi);
      seeded = { code: row.countryCode, seoul: toSeoulMinute(row.updatedAt) };
      test.info().annotations.push({ type: 'Country used for "never edited"', description: seeded.code });
      const before = await territoryState.prepare('JP', NORMAL_FLAGS('JP'));
      await territoryApi.update('JP', { vatTreatment: 'TAXABLE_STANDARD', exportDeclarationRequired: before.exportDeclarationRequired, reason: 'Automation pre-condition — JP edited once for TC_US089_46', version: before.version });
      jpSeoul = toSeoulMinute((await territoryApi.get('JP')).body.updatedAt);
    });

    await step('Act: Step 1 — Open the never-edited country and read the Last updated line', async () => {
      await edit.open(seeded.code, 'en');
      line.seeded = ((await edit.lastUpdated.textContent()) ?? '').trim();
    });

    await step('Assert: Expected 1 — Seeded default with the seed timestamp and "no one has changed this country yet"', async () => {
      expect(line.seeded, '[Expected 1] Seeded default · {seed timestamp} — explanation').toBe(`${EN.seeded} · ${seeded.seoul} — no one has changed this country yet.`);
    });

    await step('Act: Step 2 — 목록으로 (Back to list), open JP and read the Last updated line', async () => {
      await edit.click(edit.backButton, 'Back to list button');
      await list.setCriteria({ keyword: 'JP' });
      await list.search();
      await list.openRow('JP');
      line.jp = ((await edit.lastUpdated.textContent()) ?? '').trim();
    });

    await step('Assert: Expected 2 — The editing account and the edit timestamp separated by a mid-dot', async () => {
      expect(line.jp, '[Expected 2] {account} · {timestamp}').toBe(`${getAccountDisplayName('submitter')} · ${jpSeoul}`);
    });

    await step('Act: Step 3 — Compare the timestamp format against Seoul time', async () => {
      await edit.lastUpdated.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Exactly YYYY-MM-DD HH:mm in Seoul time', async () => {
      expect(line.jp.split(' · ')[1], '[Expected 3] Format YYYY-MM-DD HH:mm').toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      expect(line.jp.split(' · ')[1], '[Expected 3] Seoul time of the stored UTC timestamp').toBe(jpSeoul);
    });
  });

  test('TC_US089_49 — Two distinct inline messages under the reason box for empty and for too short', async ({ page, territoryState, territoryEditPage: edit }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_49', 'Medium', TAGS, `On JP after choosing 과세: 저장 stays disabled; an empty reason shows 사유를 입력하세요. with focus back in the box; "ok" shows the short message counting 2 characters; ten spaces are trimmed to the empty message; a full reason removes the message and enables 저장. ${DEVIATION} ${DATA}`);

    await step('Arrange: Pre-condition 1–2 — Logged in; JP is 영세율 / Required', async () => {
      await territoryState.prepare('JP', NORMAL_FLAGS('JP'));
      await edit.open('JP');
    });

    await step('Act: Step 1 — Change the VAT treatment picker to 과세 (Taxable (standard))', async () => {
      await edit.vatSelect.selectOption('TAXABLE_STANDARD');
    });

    await step('Assert: Expected 1 — The picker takes the new value; 저장 (Save) is still disabled', async () => {
      await expect(edit.vatSelect, '[Expected 1] Picker at 과세').toHaveValue('TAXABLE_STANDARD');
      await expect(edit.saveButton, '[Expected 1] 저장 (Save) is disabled').toBeDisabled();
    });

    await step('Act: Step 2 — Leave the Reason box empty and look beneath the input', async () => {
      await edit.reasonInput.focus();
      await edit.reasonInput.blur();
    });

    await step('Assert: Expected 2 — 사유를 입력하세요. appears beneath the input and focus returns to the box', async () => {
      await expect(edit.reasonMessage(KO.reasonEmpty), '[Expected 2] 사유를 입력하세요. (Enter a reason before saving.)').toBeVisible();
      await expect.soft(edit.reasonInput, '[Expected 2] Focus returns to the Reason box').toBeFocused();
    });

    await step('Act: Step 3 — Type "ok" into the Reason box', async () => {
      await edit.reasonInput.fill('ok');
    });

    await step('Assert: Expected 3 — The message counts the real 2 characters', async () => {
      await expect(edit.reasonMessage(KO.reasonShort(2)), '[Expected 3] 사유는 최소 10자 이상이어야 합니다 — 현재 2자.').toBeVisible();
      await expect(edit.reasonMessage(KO.reasonEmpty), '[Expected 3] The empty message is replaced').toHaveCount(0);
    });

    await step('Act: Step 4 — Type ten consecutive spaces into the Reason box', async () => {
      await edit.reasonInput.fill(' '.repeat(10));
    });

    await step('Assert: Expected 4 — The string is trimmed to 0, so the empty message shows', async () => {
      await expect(edit.reasonMessage(KO.reasonEmpty), '[Expected 4] 사유를 입력하세요.').toBeVisible();
    });

    await step('Act: Step 5 — Type a full reason into the Reason box', async () => {
      await edit.reasonInput.fill('KE Finance confirmed JP is taxable for the 26.09 cycle');
    });

    await step('Assert: Expected 5 — The message disappears and 저장 (Save) becomes enabled', async () => {
      await expect(edit.reasonMessage(/사유를 입력하세요|사유는 최소/), '[Expected 5] No message beneath the input').toHaveCount(0);
      await expect(edit.saveButton, '[Expected 5] 저장 (Save) is enabled').toBeEnabled();
    });
  });

  test('TC_US089_57 — No cancel, create, delete or closed-cycle recalculate control on either screen', async ({ page, territoryState, territoryListPage: list, territoryEditPage: edit }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_57', 'Medium', TAGS, `The list has no create control; the Action column carries only 변경 이력; the edit footer has only 목록으로 + 저장 (no Cancel); the form has no delete control; neither screen nor the history dialog offers a recalculate / reprice / repost control. Step 6 saves JP (영세율 → 과세) and reads the toast and the scope note: neither claims a posted difference. ${DEVIATION} Data: JP is saved once and restored in teardown (shared dev).`);
    let listControls: string[] = [];
    let editControls: string[] = [];
    let dialogControls: string[] = [];
    let scope = '';

    await step('Arrange: Pre-condition 1–3 — Logged in; seeded register', async () => {
      await list.open();
    });

    await step('Act: Step 1 — Scan the list screen above the table, beside the title and below the table', async () => {
      listControls = await list.controlNames();
    });

    await step('Assert: Expected 1 — No control to create or register a country', async () => {
      expect(listControls.filter((n) => /create|register|add|new|등록|추가/i.test(n)), '[Expected 1] No create control').toEqual([]);
    });

    await step('Act: Step 2 — Scan the Action column and the full row contents', async () => {
      await list.rows.first().hover();
    });

    await step('Assert: Expected 2 — Exactly one action, 변경 이력 (Change history)', async () => {
      const first = list.rows.first();
      await expect(first.getByRole('button'), '[Expected 2] Exactly one control on the row').toHaveCount(1);
      await expect(list.cell(first, 'action').getByRole('button'), '[Expected 2] It is 변경 이력').toHaveText(KO.history);
    });

    await step('Act: Step 3 — Open the edit screen and scan the footer and the header band', async () => {
      await edit.open('JP');
    });

    await step('Assert: Expected 3 — Only 목록으로 and 저장; no Cancel', async () => {
      await expect(edit.footer.getByRole('button'), '[Expected 3] Two footer buttons').toHaveCount(2);
      await expect(edit.backButton, '[Expected 3] 목록으로').toHaveText(KO.back);
      await expect(edit.saveButton, '[Expected 3] 저장').toHaveText(KO.save);
    });

    await step('Act: Step 4 — Scan the entire form body', async () => {
      editControls = await edit.controlNames();
    });

    await step('Assert: Expected 4 — No delete-country control on the form', async () => {
      expect(editControls.filter((n) => /delete|remove|삭제/i.test(n)), '[Expected 4] No delete control').toEqual([]);
    });

    await step('Act: Step 5 — Scan both screens and the history dialog for recalculate / reprice / repost controls', async () => {
      await edit.click(edit.historyButton, '변경 이력 (Change history) button');
      await edit.historyDialog.waitLoaded();
      dialogControls = await edit.controlNames();
      await edit.historyDialog.close();
    });

    await step('Assert: Expected 5 — No such control or wording on either screen', async () => {
      for (const [where, names] of [['list', listControls], ['edit', editControls], ['history dialog', dialogControls]] as const) {
        expect(names.filter((n) => RECALCULATE.test(n)), `[Expected 5] No recalculate control on the ${where}`).toEqual([]);
      }
    });

    await step('Act: Step 6 — Change a flag on JP, save, then read the toast and the scope note', async () => {
      await territoryState.prepare('JP', NORMAL_FLAGS('JP'));
      await edit.open('JP', 'en');
      scope = ((await edit.scopeNote.textContent()) ?? '').trim();
      const response = await edit.saveChange({ vat: 'TAXABLE_STANDARD', reason: 'Check the toast and scope note wording after a save' });
      expect(response.status(), 'The save succeeds').toBe(200);
    });

    await step('Assert: Expected 6 — The toast and the scope note claim no posted difference', async () => {
      await expect(edit.savedToast('en'), '[Expected 6] Toast reads only "Changes saved. Applies to the open cycle onward."').toBeVisible();
      expect(scope, '[Expected 6] The scope note reads only the open-cycle sentence').toBe(EN.scopeNote);
    });
  });

  test('TC_US089_67 — Opening the history from the edit screen and closing it keeps the in-progress entries', async ({ page, territoryApi, territoryEditPage: edit }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_67', 'Medium', TAGS, `On JP a changed picker and a typed reason survive opening 변경 이력 from the card title and closing it; the dialog sub-line is for JP and closing returns to the edit screen, not the list. Deviation: JP has no history record on dev (read-only suite) — the dialog behaviour does not depend on it. ${DEVIATION} ${DATA}`);
    const reason = 'Check entries survive opening the history dialog';
    let nameKo = '';

    await step('Arrange: Pre-condition 1–2 — Logged in; JP exists', async () => {
      nameKo = (await territoryApi.get('JP')).body.nameKo;
      await edit.open('JP');
    });

    await step('Act: Step 1 — Change the VAT treatment picker and type the reason', async () => {
      await edit.vatSelect.selectOption('TAXABLE_STANDARD');
      await edit.reasonInput.fill(reason);
    });

    await step('Assert: Expected 1 — The form takes both values', async () => {
      await expect(edit.vatSelect, '[Expected 1] Picker at 과세').toHaveValue('TAXABLE_STANDARD');
      await expect(edit.reasonInput, '[Expected 1] Reason typed').toHaveValue(reason);
    });

    await step('Act: Step 2 — Click the 변경 이력 (Change history) button at the right of the card title', async () => {
      await edit.click(edit.historyButton, '변경 이력 (Change history) button');
      await edit.historyDialog.waitLoaded();
    });

    await step('Assert: Expected 2 — The dialog opens above the edit screen', async () => {
      await expect(edit.historyDialog.content, '[Expected 2] The dialog is open').toBeVisible();
      await expect(edit.code, '[Expected 2] The edit screen stays behind it').toBeAttached();
    });

    await step('Act: Step 3 — Read the sub-line beneath the dialog title', async () => {
      await edit.historyDialog.subtitle.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — The sub-line shows JP, not another country', async () => {
      await expect(edit.historyDialog.subtitle, '[Expected 3] Sub-line is for JP').toHaveText(`JP · ${nameKo}`);
    });

    await step('Act: Step 4 — Click Close in the dialog footer', async () => {
      await edit.historyDialog.close();
    });

    await step('Assert: Expected 4 — The screen returns to Edit territory, not the list', async () => {
      await expect(page, '[Expected 4] Still on the edit address').toHaveURL(/\/commerce\/territories\/JP\/edit/);
      await expect(edit.code, '[Expected 4] The edit form is shown').toHaveText('JP');
    });

    await step('Act: Step 5 — Re-read the picker and the Reason box', async () => {
      await edit.vatSelect.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 5 — Both still hold the values from step 1', async () => {
      await expect(edit.vatSelect, '[Expected 5] Picker still at 과세').toHaveValue('TAXABLE_STANDARD');
      await expect(edit.reasonInput, '[Expected 5] Reason still typed').toHaveValue(reason);
    });
  });
});
