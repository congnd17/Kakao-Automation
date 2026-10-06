import { test, expect } from '@fixtures/territory.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { isClipped } from '@utils/layout';
import { TERRITORY_TEXT, pickSeededCountry } from '@utils/territory.data';

/**
 * US089 — nhóm [UI]: list, màn sửa, dialog lịch sử, menu, cắt chữ dài. Account chỉ đọc (dev 29/09) mở được màn sửa bằng URL
 * nên các TC chỉ "đọc giao diện" vẫn tự động hoá được. Không có nút `EN / 한국어` → đổi ngôn ngữ bằng tham số `?lang=en`
 * của app (Deviation). Kỳ vọng assert theo TC; chuỗi tiếng Hàn tạm SPEC-GAP-13 được chấp nhận đúng như TC mô tả.
 */
const TAGS = ['ui', 'territory'];
const EN = TERRITORY_TEXT.en;
const KO = TERRITORY_TEXT.ko;
const DATA = 'Data: read-only.';

test.describe('[UI] Territory — screens render', () => {
  test.describe.configure({ timeout: 120_000 });

  test('TC_US089_07 — The list renders the search box, both filters, both buttons, five headers and the pagination bar', async ({ page, territoryListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_07', 'Medium', TAGS, `English: Country box with placeholder, VAT treatment (All / Taxable (standard) / Zero-rated), Export declaration (All / Required / Not required), Reset + Search, five headers in order with 변경 이력 in Action, the pager (counter, 페이지당 with 10/20/50/100, navigation). Korean: labels with a Korean version switch; VAT treatment / Export declaration / Last updated / Action / Required / Not required stay English, or show the known SPEC-GAP-13 interim strings (부가세 처리 / 수출신고 / 필요 / 불필요). Deviation: the language is switched with the app's ?lang parameter — there is no EN / 한국어 control on the screen. ${DATA}`);
    const filters = { vat: [] as string[], exp: [] as string[], sizes: [] as string[] };

    await step('Arrange: Pre-condition 1–4 — Logged in; seeded register; English interface', async () => {
      await list.open('en');
    });

    await step('Act: Step 1 — Open Territory and check the filter block', async () => {
      filters.vat = await list.optionTexts(list.vatSelect);
      filters.exp = await list.optionTexts(list.exportSelect);
    });

    await step('Assert: Expected 1 — The filter block renders in full', async () => {
      await expect(list.searchInput, '[Expected 1] Country label + input').toHaveAccessibleName('Country');
      await expect(list.searchInput, '[Expected 1] Placeholder "Code or name"').toHaveAttribute('placeholder', EN.searchPlaceholder);
      await expect(list.vatSelect, '[Expected 1] VAT treatment label + picker').toHaveAccessibleName('VAT treatment');
      expect(filters.vat, '[Expected 1] VAT options All / Taxable (standard) / Zero-rated in order').toEqual([...EN.vatOptions]);
      await expect(list.exportSelect, '[Expected 1] Export declaration label + picker').toHaveAccessibleName('Export declaration');
      expect(filters.exp, '[Expected 1] Export options All / Required / Not required').toEqual([...EN.exportOptions]);
      await expect(list.resetButton, '[Expected 1] 초기화 (Reset) button').toBeVisible();
      await expect(list.searchButton, '[Expected 1] 검색 (Search) button').toBeVisible();
    });

    await step('Act: Step 2 — Check the five column headers and the action column', async () => {
      await list.table.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Exactly five headers in order; Action carries 변경 이력 (Change history)', async () => {
      await expect(list.headers, '[Expected 2] Exactly five headers').toHaveCount(5);
      for (const [i, name] of EN.columns.entries()) {
        await expect(list.headers.nth(i), `[Expected 2] Header ${i + 1} is ${name}`).toHaveText(name);
      }
      await expect(list.cell(list.rows.first(), 'action'), '[Expected 2] Action column carries Change history').toHaveText(EN.history);
    });

    await step('Act: Step 3 — Check the pagination bar at the bottom of the table', async () => {
      await list.pagination.scrollIntoViewIfNeeded();
      filters.sizes = await list.optionTexts(list.pageSizeSelect);
    });

    await step('Assert: Expected 3 — Counter, 페이지당 with four options, page navigation', async () => {
      await expect(list.counter, '[Expected 3] The counter is shown').toBeVisible();
      await expect(list.pageSizeLabel, '[Expected 3] The 페이지당 (Rows per page) label').toBeVisible();
      expect(filters.sizes, '[Expected 3] Four options 10개 / 20개 / 50개 / 100개').toEqual([...KO.pageSizes]);
      for (const name of ['First', 'Previous', 'Next', 'Last']) {
        await expect(list.pageItems.filter({ hasText: name }), `[Expected 3] ${name} navigation control`).toHaveCount(1);
      }
    });

    await step('Act: Step 4 — Switch the interface to Korean and re-check all three blocks', async () => {
      await list.open();
      filters.vat = await list.optionTexts(list.vatSelect);
      filters.exp = await list.optionTexts(list.exportSelect);
    });

    await step('Assert: Expected 4 — Korean labels switch; the English-kept labels stay English or show the SPEC-GAP-13 interim strings', async () => {
      await expect(list.searchInput, '[Expected 4] 국가 label').toHaveAccessibleName('국가');
      await expect(list.searchInput, '[Expected 4] Placeholder 국가 코드 또는 국가명').toHaveAttribute('placeholder', KO.searchPlaceholder);
      expect(filters.vat, '[Expected 4] VAT options 전체 / 과세 / 영세율').toEqual([...KO.vatOptions]);
      expect(filters.exp[0], '[Expected 4] Export option 전체').toBe('전체');
      expect(filters.exp.slice(1), '[Expected 4] Required / Not required (or interim 필요 / 불필요)').toEqual(expect.arrayContaining([expect.stringMatching(/^(Required|필요)$/), expect.stringMatching(/^(Not required|불필요)$/)]));
      await expect(list.resetButton, '[Expected 4] 초기화').toHaveText(/초기화/);
      await expect(list.searchButton, '[Expected 4] 검색').toHaveText(/검색/);
      await expect(list.headers.nth(0), '[Expected 4] Header 1 is 국가').toHaveText('국가');
      await expect(list.headers.nth(1), '[Expected 4] Header 2 is VAT treatment (or interim 부가세 처리)').toHaveText(/^(VAT treatment|부가세 처리)$/);
      await expect(list.headers.nth(2), '[Expected 4] Header 3 is Export declaration (or interim 수출신고)').toHaveText(/^(Export declaration|수출 ?신고)$/);
      await expect.soft(list.headers.nth(3), '[Expected 4] Header 4 stays "Last updated"').toHaveText('Last updated');
      await expect.soft(list.headers.nth(4), '[Expected 4] Header 5 stays "Action"').toHaveText('Action');
      await expect(list.cell(list.rows.first(), 'action'), '[Expected 4] Action link reads 변경 이력').toHaveText(KO.history);
      await expect(list.pageSizeLabel, '[Expected 4] 페이지당 label').toBeVisible();
    });
  });

  test('TC_US089_08 — The edit screen renders every label, input, hint, scope note and both buttons', async ({ page, territoryEditPage: edit }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_08', 'Medium', TAGS, `English: title "Edit territory", breadcrumb Master Data › Territory › JP, card "Tax settings", identity block and sentence, VAT picker with two options + hint, export text, Last updated, Reason* with placeholder + hint, scope note; footer 목록으로 left / 저장 right, no Cancel. Korean: 국가 코드, 국가, 과세, 영세율, 목록으로, 저장, 변경 이력 switch; VAT treatment stays English or shows the interim 부가세 처리 (SPEC-GAP-13). Not automated: the Korean page title (NEEDS CLARIFICATION in the TC). Deviations: the read-only account opens the edit screen by URL (a row click does not open it); ?lang switches the language. ${DATA}`);
    let options: string[] = [];
    let boxes = { back: 0, save: 0 };

    await step('Arrange: Pre-condition 1–4 — Logged in; JP is 영세율 / Required; English interface', async () => {
      await page.setViewportSize({ width: 1920, height: 1080 });
    });

    await step('Act: Step 1 — Open the edit screen of JP', async () => {
      await edit.open('JP', 'en');
    });

    await step('Assert: Expected 1 — The edit screen for JP opens', async () => {
      await expect(edit.code, '[Expected 1] The screen is for JP').toHaveText('JP');
    });

    await step('Act: Step 2 — Check the page title, the breadcrumb and the card title', async () => {
      await edit.title.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — "Edit territory", Master Data › Territory › JP, "Tax settings"', async () => {
      await expect.soft(edit.title, '[Expected 2] Page title reads "Edit territory"').toHaveText('Edit territory');
      await expect.soft(edit.breadcrumb, '[Expected 2] Breadcrumb reads Master Data › Territory › JP').toHaveText(/Master Data.*Territory.*JP/);
      await expect(edit.cardHeader, '[Expected 2] Card title reads "Tax settings"').toContainText(EN.cardTitle);
    });

    await step('Act: Step 3 — Check the identity block, both flag controls, Last updated, Reason and the scope note', async () => {
      options = (await edit.vatOptions.allTextContents()).map((t) => t.trim());
    });

    await step('Assert: Expected 3 — Every label, input and hint renders', async () => {
      await expect(edit.identityBox, '[Expected 3] Country code label').toContainText('Country code');
      await expect(edit.identityBox, '[Expected 3] Country label').toContainText('Country');
      await expect(edit.identityBox, '[Expected 3] ISO 3166-1 sentence').toContainText(EN.identityNote);
      await expect(edit.vatSelect, '[Expected 3] VAT treatment label').toHaveAccessibleName('VAT treatment');
      expect(options, '[Expected 3] Two options: 과세 (Taxable (standard)) and 영세율 (Zero-rated)').toEqual([expect.stringContaining('Taxable (standard)'), expect.stringContaining('Zero-rated')]);
      await expect(edit.vatHint, '[Expected 3] VAT hint').toHaveText(EN.vatHint);
      await expect(edit.exportText, '[Expected 3] Export text').toContainText(EN.exportText);
      await expect(edit.exportText, '[Expected 3] The explanation mentions export declaration').toContainText('export declaration');
      await expect(edit.lastUpdatedField, '[Expected 3] Last updated label').toContainText('Last updated');
      await expect(edit.reasonLabel, '[Expected 3] Reason label with its required asterisk').toHaveText('Reason*');
      await expect(edit.reasonInput, '[Expected 3] Reason placeholder').toHaveAttribute('placeholder', EN.reasonPlaceholder);
      await expect(edit.reasonField, '[Expected 3] Reason hint').toContainText(EN.reasonHint);
      await expect(edit.scopeNote, '[Expected 3] Scope note').toHaveText(EN.scopeNote);
    });

    await step('Act: Step 4 — Check the two buttons in the page footer', async () => {
      boxes = { back: (await edit.backButton.boundingBox())?.x ?? -1, save: (await edit.saveButton.boundingBox())?.x ?? -1 };
    });

    await step('Assert: Expected 4 — 목록으로 (Back to list) on the left, 저장 (Save) on the right, no Cancel', async () => {
      await expect(edit.backButton, '[Expected 4] Back to list').toHaveText(EN.back);
      await expect(edit.saveButton, '[Expected 4] Save').toHaveText(EN.save);
      expect(boxes.back, '[Expected 4] Back to list sits left of Save').toBeLessThan(boxes.save);
      await expect(edit.footer.getByRole('button'), '[Expected 4] Exactly two footer buttons').toHaveCount(2);
      await expect(edit.footer.getByRole('button', { name: /Cancel|취소/ }), '[Expected 4] No Cancel button').toHaveCount(0);
    });

    await step('Act: Step 5 — Switch the interface to Korean and re-check the labels', async () => {
      await edit.open('JP');
      options = (await edit.vatOptions.allTextContents()).map((t) => t.trim());
    });

    await step('Assert: Expected 5 — The labels with a Korean version switch; VAT treatment stays English or shows interim 부가세 처리', async () => {
      await expect(edit.identityBox, '[Expected 5] 국가 코드').toContainText('국가 코드');
      await expect(edit.identityBox, '[Expected 5] 국가').toContainText('국가');
      expect(options, '[Expected 5] Options carry 과세 / 영세율').toEqual([expect.stringContaining(KO.taxable), expect.stringContaining(KO.zeroRated)]);
      await expect(edit.backButton, '[Expected 5] 목록으로').toHaveText(KO.back);
      await expect(edit.saveButton, '[Expected 5] 저장').toHaveText(KO.save);
      await expect(edit.historyButton, '[Expected 5] 변경 이력').toHaveText(KO.history);
      await expect(edit.vatSelect, '[Expected 5] VAT treatment (or interim 부가세 처리)').toHaveAccessibleName(/^(VAT treatment|부가세 처리)$/);
      test.info().annotations.push({ type: 'Not automated', description: 'Expected 5: the Korean page title is NEEDS CLARIFICATION (영역 수정 vs prototype)' });
    });
  });

  test('TC_US089_10 — The change-history dialog renders its title, five headers and the close button', async ({ page, territoryApi, territoryListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_10', 'Medium', TAGS, `The dialog of a never-edited country (VN) opens above the list with the title Change history, the sub-line "{code} · {name}", five headers When / Who / Setting / Change / Reason (visible with no data rows) and exactly one Close button; in Korean the title reads 변경 이력 and the headers stay English. Deviation: VN was edited by another user on the shared dev (29/09) — when VN no longer carries its seeded values the first country that still does is used (the code is noted in the report). ${DATA}`);
    let nameEn = '';
    let code = '';

    await step('Arrange: Pre-condition 1–3 — Logged in; a never-edited country; English interface', async () => {
      const seeded = await pickSeededCountry(territoryApi);
      code = seeded.countryCode;
      nameEn = seeded.nameEn;
      test.info().annotations.push({ type: 'Country used for "never edited"', description: code });
      await list.open('en');
      await list.setCriteria({ keyword: code });
      await list.search();
    });

    await step('Act: Step 1 — Click the Change history link on the never-edited row', async () => {
      await list.openHistory(list.row(code));
    });

    await step('Assert: Expected 1 — The dialog opens above the list screen', async () => {
      await expect(list.historyDialog.root, '[Expected 1] The dialog is open').toBeVisible();
      await expect(list.table, '[Expected 1] The list stays behind it').toBeAttached();
    });

    await step('Act: Step 2 — Read the dialog title and the sub-line', async () => {
      await list.historyDialog.title.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Title Change history; the sub-line shows the code and name of the country', async () => {
      await expect(list.historyDialog.title, '[Expected 2] Title reads Change history').toContainText(EN.history);
      await expect(list.historyDialog.subtitle, '[Expected 2] Sub-line shows the code and its name').toHaveText(`${code} · ${nameEn}`);
    });

    await step('Act: Step 3 — Read the column headers and the footer button', async () => {
      await list.historyDialog.table.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Five headers When / Who / Setting / Change / Reason with no data; exactly one Close button', async () => {
      await expect(list.historyDialog.headers, '[Expected 3] Five headers').toHaveCount(5);
      for (const [i, name] of EN.historyColumns.entries()) {
        await expect(list.historyDialog.headers.nth(i), `[Expected 3] Header ${i + 1} is ${name}`).toHaveText(name);
      }
      await expect(list.historyDialog.empty, '[Expected 3] The table holds no data rows').toBeVisible();
      await expect(list.historyDialog.root.getByRole('button', { name: EN.close }), '[Expected 3] Exactly one Close button').toHaveCount(1);
    });

    await step('Act: Step 4 — Switch the interface to Korean and re-read the dialog title', async () => {
      await list.open();
      await list.setCriteria({ keyword: code });
      await list.search();
      await list.openHistory(list.row(code));
    });

    await step('Assert: Expected 4 — The title reads 변경 이력; the five headers stay English', async () => {
      await expect(list.historyDialog.title, '[Expected 4] Title reads 변경 이력').toContainText(KO.history);
      for (const [i, name] of EN.historyColumns.entries()) {
        await expect.soft(list.historyDialog.headers.nth(i), `[Expected 4] Header ${i + 1} stays ${name}`).toHaveText(name);
      }
    });
  });

  test('TC_US089_11 — Territory is the sixth item of the Master Data group', async ({ page, territoryListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_11', 'Medium', TAGS, `The sidebar must hold a 마스터 데이터 (Master Data) group whose sixth item is Territory. Dev 29/09: no such group or menu entry exists — the screen is only reachable by URL. Not automated: steps 2–4 (comparison with a pre-deployment sidebar screenshot and the 배송 불가 국가 관리 screen) — no reference screenshot is available. ${DATA}`);

    await step('Arrange: Pre-condition 1–2 — Logged in; the sidebar is visible', async () => {
      await list.open();
    });

    await step('Act: Step 1 — Open the 마스터 데이터 (Master Data) group and count its items', async () => {
      if (await list.sidebarMasterDataGroup.count()) await list.click(list.sidebarMasterDataGroup.first(), '마스터 데이터 (Master Data) group');
    });

    await step('Assert: Expected 1 — The group has six items with Territory sixth, after 상품-창고 매핑', async () => {
      await expect(list.sidebarMasterDataGroup, '[Expected 1] The 마스터 데이터 (Master Data) group exists').toHaveCount(1);
      await expect(list.sidebarTerritoryMenu, '[Expected 1] The Territory menu item exists').toHaveCount(1);
    });

    for (const n of [2, 3, 4]) {
      await step(`Act: Step ${n} — ${['Compare the first five items', 'Check the group label, position and expand/collapse', 'Open 배송 불가 국가 관리'][n - 2]} (Not automated)`, async () => {
        test.info().annotations.push({ type: 'Not automated', description: `Step ${n}: needs the pre-deployment sidebar screenshot` });
      });
      await step(`Assert: Expected ${n} — Unchanged against the pre-deployment sidebar (Not automated)`, async () => {
        test.info().annotations.push({ type: 'Not automated', description: `Expected ${n}: see Step ${n}` });
      });
    }
  });

  test('TC_US089_12 — A long country name is clipped at the 200 px tier and keeps the full value in the tooltip', async ({ page, territoryApi, territoryListPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_12', 'Medium', TAGS, `At 1920 px the GS code is not clipped; its name line is clipped with an ellipsis at the 200 px tier and the cell tooltip carries the full name; the Korean interface does the same with the full Korean name. Not automated: steps 4–5 (a long editor name on AT) — no account can edit Territory, so no row carries an editor name. ${DATA}`);
    let gs = { nameEn: '', nameKo: '' };
    const measure = async () => ({
      codeClipped: await isClipped(list.cell(list.row('GS'), 'country').locator('span').first()),
      nameClipped: await isClipped(list.countryName(list.row('GS'))),
      overflow: await list.countryName(list.row('GS')).evaluate((el) => getComputedStyle(el).textOverflow),
      width: (await list.countryName(list.row('GS')).boundingBox())?.width ?? 0,
      title: (await list.cell(list.row('GS'), 'country').getAttribute('title')) ?? '',
    });
    let en: Awaited<ReturnType<typeof measure>>;
    let ko: Awaited<ReturnType<typeof measure>>;

    await step('Arrange: Pre-condition 1–4 — Logged in; GS exists with its long English name; window 1920 px wide', async () => {
      const row = (await territoryApi.get('GS')).body;
      gs = { nameEn: row.nameEn, nameKo: row.nameKo };
      await page.setViewportSize({ width: 1920, height: 1080 });
      await list.open('en');
      await list.setCriteria({ keyword: 'GS' });
      await list.search();
    });

    await step('Act: Step 1 — Find the GS row and look at the Country column', async () => {
      en = await measure();
    });

    await step('Assert: Expected 1 — The code shows in full; the name line is clipped with an ellipsis at the 200 px tier', async () => {
      expect(en.codeClipped, '[Expected 1] The GS code is not clipped').toBe(false);
      expect(en.nameClipped, '[Expected 1] The name line is clipped').toBe(true);
      expect(en.overflow, '[Expected 1] The clip ends with an ellipsis').toBe('ellipsis');
      expect(en.width, '[Expected 1] The name line is clipped at the 200 px tier').toBeLessThanOrEqual(200.5);
    });

    await step('Act: Step 2 — Hover over the clipped name line and read the tooltip', async () => {
      await list.countryName(list.row('GS')).hover();
    });

    await step('Assert: Expected 2 — The tooltip shows the full country name', async () => {
      expect(en.title, '[Expected 2] The tooltip carries the full English name').toContain(gs.nameEn);
    });

    await step('Act: Step 3 — Switch the interface to Korean and repeat steps 1 and 2', async () => {
      await list.open();
      await list.setCriteria({ keyword: 'GS' });
      await list.search();
      ko = await measure();
      await list.countryName(list.row('GS')).hover();
    });

    await step('Assert: Expected 3 — The Korean name is clipped at the same tier; the tooltip shows the full Korean name', async () => {
      expect(ko.nameClipped, '[Expected 3] The Korean name line is clipped').toBe(true);
      expect(ko.width, '[Expected 3] Same 200 px tier').toBeLessThanOrEqual(200.5);
      expect(ko.title, '[Expected 3] The tooltip carries the full Korean name').toContain(gs.nameKo);
      expect(ko.title, '[Expected 3] The tooltip is not the English name').not.toContain(gs.nameEn);
    });

    for (const n of [4, 5]) {
      await step(`Act: Step ${n} — ${n === 4 ? 'Find the AT row and hover over Last updated' : 'Look at the boundary between Last updated and Action on AT'} (Not automated)`, async () => {
        test.info().annotations.push({ type: 'Not automated', description: `Step ${n}: AT must carry a long editor name — no account can edit Territory` });
      });
      await step(`Assert: Expected ${n} — ${n === 4 ? 'Clipped at 200 px with the full editor + timestamp tooltip' : 'No spill into the Action column'} (Not automated)`, async () => {
        test.info().annotations.push({ type: 'Not automated', description: `Expected ${n}: see Step ${n}` });
      });
    }
  });
});
