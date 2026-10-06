import { test, expect } from '@fixtures/stock.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { StockListPage } from '@pages/stock-list.page';
import { CellTruncation, StockUiPage } from '@pages/stock-ui.page';
import { STOCK_LANGS, StockTextKey, stx } from '@utils/stock.i18n';
import { LANG_SUFFIX, WORLD_NOTE, stockTags } from '@utils/stock-spec';
import { StockWorld, WorldSku, uniqueCode } from '@utils/stock.data';
import { Observations } from '@utils/observations';
import { hasHorizontalPageScroll, isClipped, isInsideContainerWidth, scrollsInside } from '@utils/layout';

/**
 * US134 — nhóm [UI] form SKU + dialog + layout list (TC_US134_09–21). Nguồn TC: input/US134_TestCase_EN_v18.md
 * (Steps N / Expected N → `Act: Step N` / `Assert: Expected N`; TC ghi "run in Korean, then English" → chạy trọn chuỗi
 * 2 lượt, hậu tố (Korean)/(English)). Kỳ vọng assert theo TC; chỗ UI khác TC ghi trong description.
 */
const TAGS = stockTags('ui');

/** Lọc list về đúng 12 dòng world và hiện hết trên 1 trang (mặc định 10 dòng/trang). */
async function showWorldRows(list: StockListPage, world: StockWorld): Promise<void> {
  await list.search('SKU_GROUP_NAME', world.keyword);
  await list.choosePageSize(20);
}

test.describe('[UI] Stock management — SKU forms, dialogs and list layout', () => {
  test.describe.configure({ timeout: 180_000 });

  test('TC_US134_09 — The physical SKU form shows every field, the line table, units, hints and 2 bottom buttons', async ({ page, skuFormPage: form }) => {
    const step = makeStep(page);
    const ui = new StockUiPage(page);
    await tcMeta(
      'TC_US134_09',
      'Medium',
      TAGS,
      'The physical SKU create form shows the 10 fields 비즈파트너 · 상품코드 · 상품코드명 · SKU 유형 · SKU 종류 · 옵션 설정 · 공급원가 · HS 코드 · 제조사 · 원산지, the SKU line table SKU 코드 · SKU명 · 수출용 SKU명 · 바코드 · 삭제 with 옵션있음, the units g / mm×3, the hints of 수출용 SKU명 and 상품 간단 설명, and only 목록으로 + 저장 at the bottom — in Korean, then in English. Observed on dev 05/10: HS 코드 / 제조사 / 원산지 sit below the line table rather than in the top block — each field is asserted by its label wherever it is.',
    );

    await step('Arrange: Pre-condition 1–3 — Logged in with write access, the 현물 SKU screen opens in create mode', async () => {
      await form.openCreate('physical');
      await expect(form.modeBadge, 'The form is in create mode').toHaveText(stx('skuForm.mode.create', 'ko'));
    });

    for (const lang of STOCK_LANGS) {
      const t = (key: StockTextKey) => stx(key, lang);
      const sfx = LANG_SUFFIX[lang];
      let lineHeaders: string[] = [];

      await step(`Act: Step 1 — Read the label of every field in the top part of the screen ${sfx}`, async () => {
        await form.openCreate('physical', lang);
      });

      await step(`Assert: Expected 1 — The 10 fields 비즈파트너 … 원산지 are shown ${sfx}`, async () => {
        for (const key of ['skuForm.field.bizPartner', 'skuForm.field.skuGroupCode', 'skuForm.field.skuGroupCodeName', 'skuForm.field.skuType', 'skuForm.field.usageType'] as const) {
          await expect(form.label(key), `[Expected 1] Field ${t(key)} is shown`).toBeVisible();
        }
        await expect(ui.formSection(t('skuForm.section.option')), `[Expected 1] Field ${t('skuForm.section.option')} is shown`).toBeVisible();
        for (const key of ['skuForm.field.price', 'skuForm.field.hsCode', 'skuForm.field.manufacturer', 'skuForm.field.countryOfOrigin'] as const) {
          await expect(form.label(key), `[Expected 1] Field ${t(key)} is shown`).toBeVisible();
        }
      });

      await step(`Act: Step 2 — Set 옵션 설정 to 옵션있음 and read the SKU line table headers ${sfx}`, async () => {
        await form.optionHas.check();
        await expect(form.optionHas, '옵션있음 (Has options) is selected').toBeChecked();
        lineHeaders = await ui.headerTexts(form.lineHeaders);
      });

      await step(`Assert: Expected 2 — The line table has SKU 코드, SKU명, 수출용 SKU명, 바코드, 삭제 ${sfx}`, async () => {
        for (const key of ['skuForm.col.skuCode', 'skuForm.col.skuName', 'skuForm.col.exportSkuName', 'skuForm.col.barcode', 'skuForm.col.delete'] as const) {
          expect(lineHeaders, `[Expected 2] The SKU line table has the column ${t(key)}`).toContain(t(key));
        }
      });

      await step(`Act: Step 3 — Read the label and the unit text of 중량 and 부피 ${sfx}`, async () => {
        await expect(form.label('skuForm.field.weight'), `${t('skuForm.field.weight')} is shown`).toBeVisible();
      });

      await step(`Assert: Expected 3 — 중량 has the unit g; 부피 has 3 boxes, each with its own mm unit ${sfx}`, async () => {
        await expect(form.field('skuForm.field.weight').locator('.input-group-text'), `[Expected 3] ${t('skuForm.field.weight')} has the unit g next to the box`).toHaveText(['g']);
        await expect(form.label('skuForm.field.volume'), `[Expected 3] Field ${t('skuForm.field.volume')} is shown`).toBeVisible();
        const volume = form.field('skuForm.field.volume');
        await expect(volume.locator('input'), `[Expected 3] ${t('skuForm.field.volume')} has 3 boxes`).toHaveCount(3);
        await expect(volume.locator('.input-group-text'), `[Expected 3] Each of the 3 ${t('skuForm.field.volume')} boxes has its own mm unit`).toHaveText(['mm', 'mm', 'mm']);
        for (const box of [form.widthInput, form.depthInput, form.heightInput]) {
          await expect(box.locator('xpath=following-sibling::*[1]'), `[Expected 3] The unit mm sits right next to the ${await box.getAttribute('placeholder')} box`).toHaveText('mm');
        }
      });

      await step(`Act: Step 4 — Read the hints inside 수출용 SKU명 and 상품 간단 설명 ${sfx}`, async () => {
        await expect(form.lineRows.first(), 'The first SKU line is shown').toBeVisible();
      });

      await step(`Assert: Expected 4 — The 2 hints read ${t('skuForm.ph.exportSkuName')} / ${t('skuForm.ph.description')} ${sfx}`, async () => {
        await expect(form.lineRows.first().getByPlaceholder(t('skuForm.ph.exportSkuName'), { exact: true }), `[Expected 4] The export SKU name box shows the hint ${t('skuForm.ph.exportSkuName')}`).toBeVisible();
        await expect(form.descriptionInput, `[Expected 4] The short description box shows the hint ${t('skuForm.ph.description')}`).toHaveAttribute('placeholder', t('skuForm.ph.description'));
      });

      await step(`Act: Step 5 — Read the 2 buttons at the bottom of the screen ${sfx}`, async () => {
        await expect(ui.formFooter, 'The bottom button bar is shown').toBeVisible();
      });

      await step(`Assert: Expected 5 — The 2 buttons are 목록으로 and 저장 ${sfx}`, async () => {
        await expect(ui.formFooter.getByRole('button'), '[Expected 5] The bottom bar has exactly 2 buttons').toHaveCount(2);
        await expect(ui.formFooter.getByRole('button', { name: new RegExp(t('skuForm.btn.backToList')) }), `[Expected 5] ${t('skuForm.btn.backToList')} is at the bottom`).toBeVisible();
        await expect(ui.formFooter.getByRole('button', { name: new RegExp(t('btn.save')) }), `[Expected 5] ${t('btn.save')} is at the bottom`).toBeVisible();
      });
    }
  });

  test('TC_US134_10 — The digital SKU form has only the 4 shared fields', async ({ page, skuFormPage: form }) => {
    const step = makeStep(page);
    const ui = new StockUiPage(page);
    await tcMeta(
      'TC_US134_10',
      'Medium',
      TAGS,
      'Opened from 디지털 SKU 마스터 관리 › create, the digital SKU form is titled 디지털 SKU and has exactly 4 fields (SKU 유형 locked to 디지털, 비즈파트너 with the lock note, 상품코드 with 중복확인, 상품코드명) with their hints, none of 창고 / 중량 / 부피 / HS 코드 / 제조사 / 원산지, and 목록으로 + 저장 with no 바코드 중복확인 — in Korean, then in English. Observed on dev 05/10: the SKU 마스터 관리 menu group does not exist, so the digital SKU master list is opened by URL before clicking its create button (디지털 SKU 생성).',
    );

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; the screen is opened in create mode from the list', async () => {
      expect(STOCK_LANGS, 'The TC runs in Korean, then in English').toEqual(['ko', 'en']);
    });

    for (const lang of STOCK_LANGS) {
      const t = (key: StockTextKey) => stx(key, lang);
      const sfx = LANG_SUFFIX[lang];

      await step(`Act: Step 1 — Open 디지털 SKU 마스터 관리 from the left menu and click its create button ${sfx}`, async () => {
        await ui.openMasterFromMenu('digital', lang);
        await ui.clickMasterCreate('digital', lang);
        form.kind = 'digital';
        form.lang = lang;
      });

      await step(`Assert: Expected 1 — The screen opens with the page title ${t('skuForm.title.digital')} ${sfx}`, async () => {
        await expect(form.cardTitle, `[Expected 1] The page title is ${t('skuForm.title.digital')}`).toHaveText(t('skuForm.title.digital'));
      });

      await step(`Act: Step 2 — Read the page title, every field label and the hints of 상품코드 and 상품코드명 ${sfx}`, async () => {
        await expect(form.skuGroupCodeInput, `${t('skuForm.field.skuGroupCode')} box is shown`).toBeVisible();
      });

      await step(`Assert: Expected 2 — Exactly 4 fields: SKU 유형 (locked, 디지털), 비즈파트너 (lock note), 상품코드 (중복확인), 상품코드명, with the 2 hints ${sfx}`, async () => {
        await expect(ui.formLabels, '[Expected 2] The screen has exactly 4 fields').toHaveCount(4);
        await expect(form.label('skuForm.field.skuType'), `[Expected 2] Field ${t('skuForm.field.skuType')} is shown`).toBeVisible();
        await expect(form.skuTypeSelect, `[Expected 2] ${t('skuForm.field.skuType')} is locked`).toBeDisabled();
        await expect(ui.selectedOption(form.skuTypeSelect), `[Expected 2] ${t('skuForm.field.skuType')} is set to ${t('skuType.DIGITAL')}`).toHaveText(t('skuType.DIGITAL'));
        await expect(form.label('skuForm.field.bizPartner'), `[Expected 2] Field ${t('skuForm.field.bizPartner')} is shown`).toBeVisible();
        await expect(form.bizPartnerLockNote, `[Expected 2] ${t('skuForm.field.bizPartner')} has the note ${t('skuForm.lockNotice')}`).toBeVisible();
        await expect(form.label('skuForm.field.skuGroupCode'), `[Expected 2] Field ${t('skuForm.field.skuGroupCode')} is shown`).toBeVisible();
        await expect(form.checkCodeButton, `[Expected 2] ${t('skuForm.field.skuGroupCode')} has a ${t('skuForm.btn.checkCode')} button`).toBeVisible();
        await expect(form.label('skuForm.field.skuGroupCodeName'), `[Expected 2] Field ${t('skuForm.field.skuGroupCodeName')} is shown`).toBeVisible();
        await expect(form.skuGroupCodeInput, `[Expected 2] The ${t('skuForm.field.skuGroupCode')} box shows the hint ${t('skuForm.ph.skuGroupCode')}`).toHaveAttribute('placeholder', t('skuForm.ph.skuGroupCode'));
        await expect(form.skuGroupCodeNameInput, `[Expected 2] The ${t('skuForm.field.skuGroupCodeName')} box shows the hint ${t('skuForm.ph.skuGroupCodeName')}`).toHaveAttribute('placeholder', t('skuForm.ph.skuGroupCodeName'));
      });

      await step(`Act: Step 3 — Look for 창고, 중량, 부피, HS 코드, 제조사 and 원산지 on the screen ${sfx}`, async () => {
        await expect(form.card, 'The form is fully shown').toBeVisible();
      });

      await step(`Assert: Expected 3 — None of those 6 fields is there ${sfx}`, async () => {
        await expect(ui.formLabel(t('filter.warehouse')), `[Expected 3] There is no ${t('filter.warehouse')} field`).toHaveCount(0);
        for (const key of ['skuForm.field.weight', 'skuForm.field.volume', 'skuForm.field.hsCode', 'skuForm.field.manufacturer', 'skuForm.field.countryOfOrigin'] as const) {
          await expect(ui.formLabel(t(key)), `[Expected 3] There is no ${t(key)} field`).toHaveCount(0);
        }
      });

      await step(`Act: Step 4 — Read the 2 buttons at the bottom of the page ${sfx}`, async () => {
        await expect(ui.formFooter, 'The bottom button bar is shown').toBeVisible();
      });

      await step(`Assert: Expected 4 — 목록으로 and 저장 at the bottom; no 바코드 중복확인 anywhere ${sfx}`, async () => {
        await expect(ui.formFooter.getByRole('button'), '[Expected 4] The bottom bar has exactly 2 buttons').toHaveCount(2);
        await expect(ui.formFooter.getByRole('button', { name: new RegExp(t('skuForm.btn.backToList')) }), `[Expected 4] ${t('skuForm.btn.backToList')} is at the bottom`).toBeVisible();
        await expect(ui.formFooter.getByRole('button', { name: new RegExp(t('btn.save')) }), `[Expected 4] ${t('btn.save')} is at the bottom`).toBeVisible();
        await expect(ui.pageButton(t('skuForm.btn.checkBarcode')), `[Expected 4] There is no ${t('skuForm.btn.checkBarcode')} button on the screen`).toHaveCount(0);
      });
    }
  });

  test('TC_US134_11 — The set SKU form has the 4 shared fields and a 4-column SET configuration table', async ({ page, skuFormPage: form }) => {
    const step = makeStep(page);
    const ui = new StockUiPage(page);
    await tcMeta(
      'TC_US134_11',
      'Medium',
      TAGS,
      'Opened from set SKU 마스터 관리 › create, the set SKU form opens at /commerce/product-stock/stock/set/create titled set SKU, has the 4 shared fields with SKU 유형 locked to Set and the 2 hints, a SET 설정 table with exactly SKU 코드 · SKU명 · 구성 개수 · 삭제 and 추가 below it, 목록으로 + 저장, and no 배분비율 / Allocation ratio column — in Korean, then in English. Observed on dev 05/10: the SKU 마스터 관리 menu group does not exist, so the set SKU master list is opened by URL before clicking its create button.',
    );

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; the screen is opened in create mode from the list', async () => {
      expect(STOCK_LANGS, 'The TC runs in Korean, then in English').toEqual(['ko', 'en']);
    });

    for (const lang of STOCK_LANGS) {
      const t = (key: StockTextKey) => stx(key, lang);
      const sfx = LANG_SUFFIX[lang];
      let setHeaders: string[] = [];

      await step(`Act: Step 1 — Open set SKU 마스터 관리 from the left menu and click its create button ${sfx}`, async () => {
        await ui.openMasterFromMenu('set', lang);
        await ui.clickMasterCreate('set', lang);
        form.kind = 'set';
        form.lang = lang;
      });

      await step(`Assert: Expected 1 — The screen opens at /commerce/product-stock/stock/set/create titled ${t('skuForm.title.set')} ${sfx}`, async () => {
        await expect(page, '[Expected 1] The address is /commerce/product-stock/stock/set/create').toHaveURL(/\/commerce\/product-stock\/stock\/set\/create(\?|$)/);
        await expect(form.cardTitle, `[Expected 1] The page title is ${t('skuForm.title.set')}`).toHaveText(t('skuForm.title.set'));
      });

      await step(`Act: Step 2 — Read the page title, every field label in the top block and the 2 hints ${sfx}`, async () => {
        await expect(form.skuGroupCodeInput, `${t('skuForm.field.skuGroupCode')} box is shown`).toBeVisible();
      });

      await step(`Assert: Expected 2 — The same 4 fields as the digital screen, SKU 유형 locked to Set, and the 2 hints ${sfx}`, async () => {
        await expect(ui.formLabels, '[Expected 2] The top block has exactly 4 fields').toHaveCount(4);
        for (const key of ['skuForm.field.skuType', 'skuForm.field.bizPartner', 'skuForm.field.skuGroupCode', 'skuForm.field.skuGroupCodeName'] as const) {
          await expect(form.label(key), `[Expected 2] Field ${t(key)} is shown`).toBeVisible();
        }
        await expect(form.skuTypeSelect, `[Expected 2] ${t('skuForm.field.skuType')} is locked`).toBeDisabled();
        await expect(ui.selectedOption(form.skuTypeSelect), `[Expected 2] ${t('skuForm.field.skuType')} is set to ${t('skuType.MIXED')}`).toHaveText(t('skuType.MIXED'));
        await expect(form.skuGroupCodeInput, `[Expected 2] The ${t('skuForm.field.skuGroupCode')} box shows the hint ${t('skuForm.ph.skuGroupCode')}`).toHaveAttribute('placeholder', t('skuForm.ph.skuGroupCode'));
        await expect(form.skuGroupCodeNameInput, `[Expected 2] The ${t('skuForm.field.skuGroupCodeName')} box shows the hint ${t('skuForm.ph.skuGroupCodeName')}`).toHaveAttribute('placeholder', t('skuForm.ph.skuGroupCodeName'));
      });

      await step(`Act: Step 3 — Read and count the column headers of the SET 설정 table ${sfx}`, async () => {
        await expect(ui.formSection(t('skuForm.section.set')), `The ${t('skuForm.section.set')} block is shown`).toBeVisible();
        setHeaders = await ui.headerTexts(form.lineHeaders);
      });

      await step(`Assert: Expected 3 — Exactly 4 headers SKU 코드, SKU명, 구성 개수, 삭제 with 추가 below ${sfx}`, async () => {
        expect(setHeaders.length, `[Expected 3] The ${t('skuForm.section.set')} table has exactly 4 headers`).toBe(4);
        (['skuForm.col.skuCode', 'skuForm.col.skuName', 'skuForm.col.quantity', 'skuForm.col.delete'] as const).forEach((key, index) => {
          expect(setHeaders[index], `[Expected 3] Header ${index + 1} is ${t(key)}`).toBe(t(key));
        });
        await expect(form.addButton, `[Expected 3] ${t('skuForm.btn.add')} is shown`).toBeVisible();
        const [tableBox, addBox] = [await form.linesTable.boundingBox(), await form.addButton.boundingBox()];
        expect(!!tableBox && !!addBox && addBox.y >= tableBox.y + tableBox.height - 1, `[Expected 3] ${t('skuForm.btn.add')} sits below the table`).toBe(true);
      });

      await step(`Act: Step 4 — Read the 2 bottom buttons and look for a 배분비율 / Allocation ratio column ${sfx}`, async () => {
        await expect(ui.formFooter, 'The bottom button bar is shown').toBeVisible();
      });

      await step(`Assert: Expected 4 — 목록으로 and 저장 at the bottom; no 배분비율 / Allocation ratio column ${sfx}`, async () => {
        await expect(ui.formFooter.getByRole('button'), '[Expected 4] The bottom bar has exactly 2 buttons').toHaveCount(2);
        await expect(ui.formFooter.getByRole('button', { name: new RegExp(t('skuForm.btn.backToList')) }), `[Expected 4] ${t('skuForm.btn.backToList')} is at the bottom`).toBeVisible();
        await expect(ui.formFooter.getByRole('button', { name: new RegExp(t('btn.save')) }), `[Expected 4] ${t('btn.save')} is at the bottom`).toBeVisible();
        await expect(page.getByText(/배분비율|Allocation ratio/i), '[Expected 4] There is no 배분비율 / Allocation ratio column').toHaveCount(0);
      });
    }
  });

  test('TC_US134_12 — The Inbound Request dialog shows its date, 6 SKU columns, 4 fields, 3 inbound types and the Other block', async ({ page, world, stockListPage: list, incomingDialog: dialog }) => {
    const step = makeStep(page);
    const ui = new StockUiPage(page);
    await tcMeta(
      'TC_US134_12',
      'Medium',
      TAGS,
      `Ticking DEMO-SKU-0001 (CJ Incheon Aam) and clicking 입고 요청 opens a dialog showing 입고 요청일: <today>, the 6 SKU 정보 headers, the 4 입고 정보 fields, exactly 3 inbound types with 발주 as default, the required 기타 사유 box + hint + note when 기타 is chosen, and 취소 + 저장 — in Korean, then in English. Observed on dev 05/10: 입고구분 is a group of 3 radio buttons, not a drop-down list — its choices are read from the radio labels. ${WORLD_NOTE}`,
    );
    const sku = world.sku('SKU0001');
    const warehouse = world.warehouses.CJ;

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; DEMO-SKU-0001 has a physical stock row in CJ Incheon Aam', async () => {
      expect(world.row('SKU0001', warehouse).buckets.available, 'DEMO-SKU-0001 has stock in CJ Incheon Aam').toBeGreaterThan(0);
    });

    for (const lang of STOCK_LANGS) {
      const t = (key: StockTextKey) => stx(key, lang);
      const sfx = LANG_SUFFIX[lang];
      let today = '';
      let headers: string[] = [];

      await step(`Act: Step 1 — Tick DEMO-SKU-0001, click 입고 요청 and read the top of the dialog ${sfx}`, async () => {
        await list.open(lang);
        await showWorldRows(list, world);
        await list.tick(list.row(sku.skuCode, warehouse.name), `${sku.skuCode} @ ${warehouse.name}`);
        await list.clickToolbar('btn.incomingRequest');
        await dialog.waitOpen(lang);
        today = await ui.browserToday();
      });

      await step(`Assert: Expected 1 — The top shows ${t('incoming.requestDate')}: with today's date ${sfx}`, async () => {
        await expect(dialog.requestDateText, `[Expected 1] The top shows ${t('incoming.requestDate')}: ${today}`).toHaveText(`${t('incoming.requestDate')}: ${today}`);
      });

      await step(`Act: Step 2 — Read the 6 column headers of the SKU 정보 table ${sfx}`, async () => {
        await expect(dialog.skuSectionTitle, `The ${t('incoming.skuSection')} block is shown`).toBeVisible();
        headers = await ui.headerTexts(dialog.headerCells);
      });

      await step(`Assert: Expected 2 — The 6 headers are SKU ID, SKU 종류, SKU명, 공급가, 요청 수량, 메모 ${sfx}`, async () => {
        expect(headers.length, '[Expected 2] The SKU table has 6 headers').toBe(6);
        (['incoming.col.skuId', 'incoming.col.skuKind', 'incoming.col.skuName', 'incoming.col.supplyPrice', 'incoming.col.quantity', 'incoming.col.memo'] as const).forEach((key, index) => {
          expect(headers[index], `[Expected 2] Header ${index + 1} is ${t(key)}`).toBe(t(key));
        });
      });

      await step(`Act: Step 3 — Read the labels of the 4 fields in the 입고 정보 block ${sfx}`, async () => {
        await expect(dialog.infoSectionTitle, `The ${t('incoming.infoSection')} block is shown`).toBeVisible();
      });

      await step(`Assert: Expected 3 — The 4 fields are 입고지, 입고 예정일, 입고구분, 제조사 ${sfx}`, async () => {
        await expect(dialog.body.locator('.row label.form-label'), `[Expected 3] The ${t('incoming.infoSection')} block has 4 fields`).toHaveCount(4);
        for (const key of ['incoming.field.warehouse', 'incoming.field.expectedDate', 'incoming.field.type', 'incoming.field.manufacturer'] as const) {
          await expect(dialog.fieldLabel(key), `[Expected 3] Field ${t(key)} is shown`).toBeVisible();
        }
      });

      let typeLabels: string[] = [];
      await step(`Act: Step 4 — Open the 입고구분 choices and read every choice ${sfx}`, async () => {
        typeLabels = (await dialog.typeLabels.allTextContents()).map((text) => text.trim());
      });

      await step(`Assert: Expected 4 — Exactly 3 choices: 발주 (default), 재고이동입고, 기타 ${sfx}`, async () => {
        expect(typeLabels.length, `[Expected 4] ${t('incoming.field.type')} has exactly 3 choices`).toBe(3);
        (['incomingType.PURCHASE_ORDER', 'incomingType.TRANSFER', 'incomingType.ETC'] as const).forEach((key, index) => {
          expect(typeLabels[index], `[Expected 4] Choice ${index + 1} is ${t(key)}`).toBe(t(key));
        });
        await expect(dialog.typeRadio('PURCHASE_ORDER'), `[Expected 4] ${t('incomingType.PURCHASE_ORDER')} is the default`).toBeChecked();
      });

      await step(`Act: Step 5 — Choose 기타 and read the part that appears ${sfx}`, async () => {
        await dialog.typeRadio('ETC').check();
      });

      await step(`Assert: Expected 5 — The required 기타 사유 box with its hint and the note appear ${sfx}`, async () => {
        await expect(dialog.fieldLabel('incoming.field.etcNote'), `[Expected 5] The box ${t('incoming.field.etcNote')} is shown`).toBeVisible();
        await expect(dialog.fieldLabel('incoming.field.etcNote').locator('.text-danger'), `[Expected 5] ${t('incoming.field.etcNote')} is marked required (*)`).toHaveText('*');
        await expect(dialog.etcNote, `[Expected 5] The box shows the hint ${t('incoming.field.etcNotePlaceholder')}`).toBeVisible();
        await expect(dialog.etcNotice, `[Expected 5] The note ${t('incoming.etcNotExpected')} is shown`).toBeVisible();
      });

      await step(`Act: Step 6 — Read the 2 buttons at the bottom of the dialog ${sfx}`, async () => {
        await expect(dialog.footer, 'The dialog footer is shown').toBeVisible();
      });

      await step(`Assert: Expected 6 — The 2 buttons are 취소 and 저장 ${sfx}`, async () => {
        await expect(dialog.footerButtons, '[Expected 6] The footer has exactly 2 buttons').toHaveCount(2);
        await expect(dialog.cancelButton, `[Expected 6] ${t('btn.cancel')} is at the bottom`).toBeVisible();
        await expect(dialog.saveButton, `[Expected 6] ${t('btn.save')} is at the bottom`).toBeVisible();
      });
    }
  });

  test('TC_US134_13 — The Stock Adjustment dialog shows one line per row, 8 columns, 6 reasons and 2 buttons', async ({ page, world, stockListPage: list, adjustmentDialog: dialog }) => {
    const step = makeStep(page);
    const ui = new StockUiPage(page);
    const second = world.warehouses.DAEGU ? world.row('SKU0003', world.warehouses.DAEGU) : world.row('SKU0009', world.warehouses.CJ);
    const first = world.row('SKU0001', world.warehouses.CJ);
    await tcMeta(
      'TC_US134_13',
      'Medium',
      TAGS,
      `Ticking DEMO-SKU-0001 (CJ Incheon Aam) and DEMO-SKU-0003 (CJ Daegu warehouse) and clicking 재고 조정 opens a dialog with 2 lines, exactly 8 headers, the 조정사유 hint + 6 reasons, and 취소 + 저장 — in Korean, then in English.${world.warehouses.DAEGU ? '' : ` CJ Daegu warehouse could not be built (${world.daeguUnavailableReason}); the second row is DEMO-SKU-0009 in CJ Incheon Aam instead.`} ${WORLD_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; 2 physical stock rows with a warehouse exist', async () => {
      for (const row of [first, second]) {
        expect(row.sku.type, `${row.sku.skuCode} is a physical SKU`).toBe('PHYSICAL');
        expect(row.warehouse.name, `${row.sku.skuCode} has a warehouse`).toBeTruthy();
      }
    });

    for (const lang of STOCK_LANGS) {
      const t = (key: StockTextKey) => stx(key, lang);
      const sfx = LANG_SUFFIX[lang];
      let headers: string[] = [];
      let reasons: string[] = [];

      await step(`Act: Step 1 — Open 재고 관리, tick DEMO-SKU-0001 and DEMO-SKU-0003, then click 재고 조정 ${sfx}`, async () => {
        await list.open(lang);
        await showWorldRows(list, world);
        for (const row of [first, second]) await list.tick(list.row(row.sku.skuCode, row.warehouse.name), `${row.sku.skuCode} @ ${row.warehouse.name}`);
        await list.clickToolbar('btn.adjustStock');
        await dialog.waitOpen(lang);
      });

      await step(`Assert: Expected 1 — The dialog opens with 2 lines, one per stock row ${sfx}`, async () => {
        await expect(dialog.rows, '[Expected 1] The dialog has 2 lines').toHaveCount(2);
        for (const row of [first, second]) {
          await expect(dialog.rows.filter({ hasText: row.sku.skuCode }).filter({ hasText: row.warehouse.name }), `[Expected 1] One line is ${row.sku.skuCode} @ ${row.warehouse.name}`).toHaveCount(1);
        }
      });

      await step(`Act: Step 2 — Read and count the table column headers ${sfx}`, async () => {
        headers = await ui.headerTexts(dialog.headerCells);
      });

      await step(`Assert: Expected 2 — Exactly 8 headers SKU 코드 … 비고 ${sfx}`, async () => {
        expect(headers.length, '[Expected 2] The table has exactly 8 headers').toBe(8);
        (['adjust.col.skuCode', 'adjust.col.skuName', 'adjust.col.warehouse', 'adjust.col.totalQuantity', 'adjust.col.quantity', 'adjust.col.modifyType', 'adjust.col.reason', 'adjust.col.note'] as const).forEach((key, index) => {
          expect(headers[index], `[Expected 2] Header ${index + 1} is ${t(key)}`).toBe(t(key));
        });
      });

      await step(`Act: Step 3 — Read the choices of 조정사유 on the first line ${sfx}`, async () => {
        reasons = await ui.optionTexts(dialog.reasonSelect(0));
      });

      await step(`Assert: Expected 3 — The hint ${t('reason.placeholder')} and 6 values 조정, 불일치, 파손, 분실, 실사, 기타 ${sfx}`, async () => {
        await expect(ui.selectedOption(dialog.reasonSelect(0)), `[Expected 3] The reason list shows the hint ${t('reason.placeholder')}`).toHaveText(t('reason.placeholder'));
        expect(reasons.length, '[Expected 3] The reason list has the hint + 6 values').toBe(7);
        (['reason.ADJUSTMENT', 'reason.DISCREPANCY', 'reason.DAMAGED', 'reason.LOST', 'reason.TAKING', 'reason.ETC'] as const).forEach((key, index) => {
          expect(reasons[index + 1], `[Expected 3] Reason ${index + 1} is ${t(key)}`).toBe(t(key));
        });
      });

      await step(`Act: Step 4 — Read the 2 buttons at the bottom of the dialog ${sfx}`, async () => {
        await expect(dialog.footer, 'The dialog footer is shown').toBeVisible();
      });

      await step(`Assert: Expected 4 — The bottom has 취소 and 저장 ${sfx}`, async () => {
        await expect(dialog.footerButtons, '[Expected 4] The footer has exactly 2 buttons').toHaveCount(2);
        await expect(dialog.cancelButton, `[Expected 4] ${t('btn.cancel')} is at the bottom`).toBeVisible();
        await expect(dialog.saveButton, `[Expected 4] ${t('btn.save')} is at the bottom`).toBeVisible();
      });
    }
  });

  test('TC_US134_14 — The Stock Conversion dialog shows the type list with 5 types, the CS note, 8 columns and 2 buttons', async ({ page, world, stockListPage: list, conversionDialog: dialog }) => {
    const step = makeStep(page);
    const ui = new StockUiPage(page);
    const row = world.row('SKU0001', world.warehouses.CJ);
    await tcMeta(
      'TC_US134_14',
      'Medium',
      TAGS,
      `Ticking DEMO-SKU-0001 (CJ Incheon Aam, CS 관리함) and clicking 재고 전환 opens a dialog with the list 전환 구분 starting at 선택, exactly 5 conversion types written in full, the CS note above the table, the 8 headers and 취소 + 저장 — in Korean, then in English. Observed in the frontend bundle 05/10: the first header of this dialog is written SKU코드 (no space) while the TC writes SKU 코드 — asserted as the TC writes it. ${WORLD_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; DEMO-SKU-0001 in CJ Incheon Aam is CS managed', async () => {
      expect(row.buckets.csManaged, 'DEMO-SKU-0001 @ CJ Incheon Aam is CS managed (관리함)').toBe(true);
    });

    for (const lang of STOCK_LANGS) {
      const t = (key: StockTextKey) => stx(key, lang);
      const sfx = LANG_SUFFIX[lang];
      let policies: string[] = [];
      let headers: string[] = [];

      await step(`Act: Step 1 — Tick DEMO-SKU-0001, click 재고 전환 and read the label and starting value of the list ${sfx}`, async () => {
        await list.open(lang);
        await showWorldRows(list, world);
        await list.tick(list.row(row.sku.skuCode, row.warehouse.name), `${row.sku.skuCode} @ ${row.warehouse.name}`);
        await list.clickToolbar('btn.convertStock');
        await dialog.waitOpen(lang);
      });

      await step(`Assert: Expected 1 — The list is labelled ${t('convert.policyLabel')} and shows ${t('convert.policyPlaceholder')} ${sfx}`, async () => {
        await expect(dialog.policyLabel, `[Expected 1] The list is labelled ${t('convert.policyLabel')}`).toBeVisible();
        await expect(dialog.policySelect, `[Expected 1] The list starts empty`).toHaveValue('');
        await expect(ui.selectedOption(dialog.policySelect), `[Expected 1] The list shows the hint ${t('convert.policyPlaceholder')}`).toHaveText(t('convert.policyPlaceholder'));
      });

      await step(`Act: Step 2 — Open the list and read each choice in full ${sfx}`, async () => {
        policies = (await dialog.policySelect.locator('option:not([value=""])').allTextContents()).map((text) => text.trim());
      });

      await step(`Assert: Expected 2 — Exactly 5 choices, each written in full ${sfx}`, async () => {
        expect(policies.length, '[Expected 2] There are exactly 5 conversion types').toBe(5);
        (['policy.SECURE_CS', 'policy.RELEASE_CS', 'policy.SECURE_HOLD', 'policy.RELEASE_HOLD', 'policy.SCRAP_DEFECTIVE'] as const).forEach((key, index) => {
          expect(policies[index], `[Expected 2] Choice ${index + 1} is ${t(key)}`).toBe(t(key));
        });
      });

      await step(`Act: Step 3 — Read the note above the table ${sfx}`, async () => {
        await expect(dialog.table, 'The conversion table is shown').toBeVisible();
      });

      await step(`Assert: Expected 3 — The note ${t('convert.notice')} is shown above the table ${sfx}`, async () => {
        await expect(dialog.notice, `[Expected 3] The note ${t('convert.notice')} is shown`).toBeVisible();
        const [noteBox, tableBox] = [await dialog.notice.boundingBox(), await dialog.table.boundingBox()];
        expect(!!noteBox && !!tableBox && noteBox.y + noteBox.height <= tableBox.y + 1, '[Expected 3] The note sits above the table').toBe(true);
      });

      await step(`Act: Step 4 — Read the 8 table column headers ${sfx}`, async () => {
        headers = await ui.headerTexts(dialog.headerCells);
      });

      await step(`Assert: Expected 4 — The 8 headers SKU 코드 … 메모 ${sfx}`, async () => {
        expect(headers.length, '[Expected 4] The table has 8 headers').toBe(8);
        const expected = [lang === 'ko' ? 'SKU 코드' : 'SKU code', ...(['convert.col.skuName', 'convert.col.warehouse', 'convert.col.fromQty', 'convert.col.toQty', 'convert.col.quantity', 'convert.col.afterQty', 'convert.col.memo'] as const).map((key) => t(key))];
        expected.forEach((name, index) => {
          expect(headers[index], `[Expected 4] Header ${index + 1} is ${name}`).toBe(name);
        });
      });

      await step(`Act: Step 5 — Read the 2 buttons at the bottom of the dialog ${sfx}`, async () => {
        await expect(dialog.footer, 'The dialog footer is shown').toBeVisible();
      });

      await step(`Assert: Expected 5 — The 2 buttons are 취소 and 저장 ${sfx}`, async () => {
        await expect(dialog.footerButtons, '[Expected 5] The footer has exactly 2 buttons').toHaveCount(2);
        await expect(dialog.cancelButton, `[Expected 5] ${t('btn.cancel')} is at the bottom`).toBeVisible();
        await expect(dialog.saveButton, `[Expected 5] ${t('btn.save')} is at the bottom`).toBeVisible();
      });
    }
  });

  test('TC_US134_15 — The Per-Warehouse Detail dialog shows one line per row, the note, 5 columns, 2 choices and 2 buttons', async ({ page, world, stockListPage: list, warehouseDetailDialog: dialog }) => {
    const step = makeStep(page);
    const ui = new StockUiPage(page);
    const managed = world.row('SKU0001', world.warehouses.CJ);
    const unmanaged = world.row('SKU0002', world.warehouses.CJ);
    await tcMeta(
      'TC_US134_15',
      'Medium',
      TAGS,
      `Ticking DEMO-SKU-0001 (CS 관리함) and DEMO-SKU-0002 (CS 관리안함), both in CJ Incheon Aam, and clicking 창고별 상세 opens a dialog with 2 lines, the per-stock-unit note, exactly 5 headers, the choices 관리함 / 관리안함 on the first line and 취소 + 저장 — in Korean, then in English. Observed on dev 05/10: CS재고 관리여부 is a pair of radio buttons per line, not a drop-down list — its 2 choices are read from the radio labels. ${WORLD_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; DEMO-SKU-0001 (managed) and DEMO-SKU-0002 (not managed) in a CJ warehouse', async () => {
      expect(managed.buckets.csManaged, 'DEMO-SKU-0001 is CS managed').toBe(true);
      expect(unmanaged.buckets.csManaged, 'DEMO-SKU-0002 is not CS managed').toBe(false);
      expect(world.warehouses.CJ.category, 'Both rows are in a CJ warehouse').toBe('CJ_WAREHOUSE');
    });

    for (const lang of STOCK_LANGS) {
      const t = (key: StockTextKey) => stx(key, lang);
      const sfx = LANG_SUFFIX[lang];
      let headers: string[] = [];
      let choices: string[] = [];

      await step(`Act: Step 1 — Open 재고 관리, tick DEMO-SKU-0001 and DEMO-SKU-0002, then click 창고별 상세 ${sfx}`, async () => {
        await list.open(lang);
        await showWorldRows(list, world);
        for (const row of [managed, unmanaged]) await list.tick(list.row(row.sku.skuCode, row.warehouse.name), `${row.sku.skuCode} @ ${row.warehouse.name}`);
        await list.clickToolbar('btn.warehouseDetail');
        await dialog.waitOpen(lang);
      });

      await step(`Assert: Expected 1 — The dialog opens with 2 lines, one per stock row ${sfx}`, async () => {
        await expect(dialog.rows, '[Expected 1] The dialog has 2 lines').toHaveCount(2);
        for (const row of [managed, unmanaged]) {
          await expect(dialog.rows.filter({ hasText: row.sku.skuCode }), `[Expected 1] One line is ${row.sku.skuCode}`).toHaveCount(1);
        }
      });

      await step(`Act: Step 2 — Read the note above the table ${sfx}`, async () => {
        await expect(dialog.table, 'The table is shown').toBeVisible();
      });

      await step(`Assert: Expected 2 — The note ${t('whdetail.notice')} is shown ${sfx}`, async () => {
        await expect(dialog.notice, `[Expected 2] The note ${t('whdetail.notice')} is shown`).toBeVisible();
        const [noteBox, tableBox] = [await dialog.notice.boundingBox(), await dialog.table.boundingBox()];
        expect(!!noteBox && !!tableBox && noteBox.y + noteBox.height <= tableBox.y + 1, '[Expected 2] The note sits above the table').toBe(true);
      });

      await step(`Act: Step 3 — Read and count the table column headers ${sfx}`, async () => {
        headers = await ui.headerTexts(dialog.headerCells);
      });

      await step(`Assert: Expected 3 — Exactly 5 headers SKU 코드, SKU명, 창고, CS재고(가용재고), CS재고 관리여부 ${sfx}`, async () => {
        expect(headers.length, '[Expected 3] The table has exactly 5 headers').toBe(5);
        (['whdetail.col.skuCode', 'whdetail.col.skuName', 'whdetail.col.warehouse', 'whdetail.col.csQuantity', 'whdetail.col.csStockManaged'] as const).forEach((key, index) => {
          expect(headers[index], `[Expected 3] Header ${index + 1} is ${t(key)}`).toBe(t(key));
        });
      });

      await step(`Act: Step 4 — Read the 2 choices on the first line and the 2 bottom buttons ${sfx}`, async () => {
        choices = (await dialog.rows.first().locator('label.form-check-label, option').allTextContents()).map((text) => text.trim());
      });

      await step(`Assert: Expected 4 — The choices are 관리함 and 관리안함; the bottom has 취소 and 저장 ${sfx}`, async () => {
        for (const key of ['csManaged.MANAGED', 'csManaged.UNMANAGED'] as const) {
          expect(choices, `[Expected 4] The first line offers ${t(key)}`).toContain(t(key));
        }
        expect(choices.length, '[Expected 4] The first line offers exactly 2 choices').toBe(2);
        await expect(dialog.footerButtons, '[Expected 4] The footer has exactly 2 buttons').toHaveCount(2);
        await expect(dialog.cancelButton, `[Expected 4] ${t('btn.cancel')} is at the bottom`).toBeVisible();
        await expect(dialog.saveButton, `[Expected 4] ${t('btn.save')} is at the bottom`).toBeVisible();
      });
    }
  });

  test('TC_US134_16 — The Stock History dialog shows the context line, 10 columns with its own voucher column, export and close', async ({ page, world, stockApi, stockListPage: list, stockHistoryDialog: dialog }) => {
    const step = makeStep(page);
    const ui = new StockUiPage(page);
    await tcMeta(
      'TC_US134_16',
      'Medium',
      TAGS,
      `The 재고이력 button of a physical stock row in CJ Incheon Aam with one recorded movement opens a dialog whose context line reads SKU명 : … / SKU코드 : … / 창고 : …, with exactly 10 headers in the TC order, the voucher number (번호) in its own 4th column between 상세구분 and 비고, an 엑셀 다운로드 button and a 닫기 button — in Korean, then in English. Data: DEMO-SKU-0001 of the shared world must keep an untouched history for other tests, so the test creates its own physical SKU in the CJ Incheon Aam copy and records one movement on it (a stock adjustment +1 through the API); the context line is checked against that SKU. ${WORLD_NOTE}`,
    );
    const warehouse = world.warehouses.CJ;
    let sku = world.sku('SKU0001');
    let voucher = '';

    await step('Arrange: Pre-condition 1–3 — A physical stock row in CJ Incheon Aam with one recorded movement', async () => {
      [sku] = await world.createPhysicalSku('TC16', { partner: world.partners.A, manufacturer: world.manufacturers.M1 });
      await world.seedStock(sku, warehouse, { available: 10, csManaged: false });
      const adjusted = await stockApi.createAdjustments({ items: [{ skuId: sku.skuId, warehouseId: warehouse.id, adjustingQuantity: 1, modifyType: 'ADD', reason: 'ADJUSTMENT', note: `TC16 ${world.tag}` }] });
      expect(adjusted.status, 'The stock adjustment that records the movement is accepted').toBeLessThan(300);
      const usages = await stockApi.stockUsages(sku.skuId, warehouse.id);
      expect(usages.body.items.length, 'The stock row has at least one recorded movement').toBeGreaterThan(0);
      voucher = String(usages.body.items[0].refId);
    });

    for (const lang of STOCK_LANGS) {
      const t = (key: StockTextKey) => stx(key, lang);
      const sfx = LANG_SUFFIX[lang];
      let context = '';
      let headers: string[] = [];

      await step(`Act: Step 1 — Click 재고이력 on the row and read the context line at the top ${sfx}`, async () => {
        await list.open(lang);
        await list.search('SKU_CODE', sku.skuCode);
        await list.openHistory(list.row(sku.skuCode, warehouse.name));
        await dialog.waitOpen(lang);
        await dialog.waitLoaded();
        context = ((await dialog.contextLine.textContent()) ?? '').replace(/\s+/g, ' ').trim();
      });

      await step(`Assert: Expected 1 — The context line reads SKU명 : <name> / SKU코드 : <code> / 창고 : <warehouse> ${sfx}`, async () => {
        expect(context, '[Expected 1] The context line names the SKU, its code and the warehouse').toBe(
          `${t('history.skuName')} : ${sku.skuName} / ${t('history.skuCode')} : ${sku.skuCode} / ${t('history.warehouse')} : ${warehouse.name}`,
        );
      });

      await step(`Act: Step 2 — Count the column headers and read each one ${sfx}`, async () => {
        headers = await ui.headerTexts(dialog.headerCells);
      });

      await step(`Assert: Expected 2 — Exactly 10 headers in the TC order ${sfx}`, async () => {
        expect(headers.length, '[Expected 2] There are exactly 10 headers').toBe(10);
        (['history.col.date', 'history.col.refType', 'history.col.detailType', 'history.col.refId', 'history.col.note', 'history.col.before', 'history.col.change', 'history.col.after', 'history.col.operator', 'history.col.operatorIp'] as const).forEach((key, index) => {
          expect(headers[index], `[Expected 2] Header ${index + 1} is ${t(key)}`).toBe(t(key));
        });
      });

      let cells: string[] = [];
      await step(`Act: Step 3 — Check whether the document number is in its own column or inside 비고 ${sfx}`, async () => {
        cells = (await dialog.rows.first().locator('td').allTextContents()).map((text) => text.trim());
      });

      await step(`Assert: Expected 3 — The number is in its own 4th column 번호, between 상세구분 and 비고, not joined onto 비고 ${sfx}`, async () => {
        expect(headers.indexOf(t('history.col.refId')), `[Expected 3] ${t('history.col.refId')} is the 4th column`).toBe(3);
        expect(headers[2], `[Expected 3] ${t('history.col.detailType')} is just before ${t('history.col.refId')}`).toBe(t('history.col.detailType'));
        expect(headers[4], `[Expected 3] ${t('history.col.note')} is just after ${t('history.col.refId')}`).toBe(t('history.col.note'));
        expect(cells.length, '[Expected 3] The movement line has 10 cells').toBe(10);
        expect(cells[3], `[Expected 3] The ${t('history.col.refId')} cell holds the document number ${voucher}`).toBe(voucher);
        expect(cells[4], `[Expected 3] The ${t('history.col.note')} cell does not carry the document number`).not.toContain(voucher);
      });

      await step(`Act: Step 4 — Read the export button and the button at the bottom of the dialog ${sfx}`, async () => {
        await expect(dialog.footer, 'The dialog footer is shown').toBeVisible();
      });

      await step(`Assert: Expected 4 — There is an 엑셀 다운로드 button and a 닫기 button ${sfx}`, async () => {
        await expect(dialog.exportButton, `[Expected 4] ${t('btn.exportStockExcel')} is shown`).toBeVisible();
        await expect(dialog.footer.getByRole('button', { name: new RegExp(t('btn.close')) }), `[Expected 4] ${t('btn.close')} is at the bottom`).toBeVisible();
      });
    }
  });

  test('TC_US134_17 — The SKU Search dialog shows 2 search fields, the keyword hint, 4 result columns and 2 buttons', async ({ page, world, skuFormPage: form, skuSearchDialog: dialog }) => {
    const step = makeStep(page);
    const ui = new StockUiPage(page);
    await tcMeta(
      'TC_US134_17',
      'Medium',
      TAGS,
      `추가 below the SET 설정 table opens the SKU 검색 dialog with exactly 2 search fields (SKU명 default, SKU 코드), the keyword box 검색어 with its hint, the result headers tick box · SKU 코드 · SKU명 · SKU 유형 after a search, and 취소 + 추가 — in Korean, then in English. The TC keyword DEMO-SKU is mapped onto the run tag that starts every demo SKU code. ${WORLD_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; the set SKU screen is open in create mode', async () => {
      await form.openCreate('set');
      await expect(form.modeBadge, 'The set form is in create mode').toHaveText(stx('skuForm.mode.create', 'ko'));
    });

    for (const lang of STOCK_LANGS) {
      const t = (key: StockTextKey) => stx(key, lang);
      const sfx = LANG_SUFFIX[lang];
      let fields: string[] = [];
      let headers: string[] = [];

      await step(`Act: Step 1 — On the set SKU screen, click 추가 below the SET 설정 table ${sfx}`, async () => {
        await form.openCreate('set', lang);
        await form.click(form.addButton, `${t('skuForm.btn.add')} button below the ${t('skuForm.section.set')} table`);
        await dialog.waitOpen(lang);
      });

      await step(`Assert: Expected 1 — The ${t('skuSearch.title')} dialog opens ${sfx}`, async () => {
        await expect(dialog.root.locator('.modal-title'), `[Expected 1] The dialog title is ${t('skuSearch.title')}`).toHaveText(t('skuSearch.title'));
      });

      await step(`Act: Step 2 — Read the dialog title, the field list and its choices, and the keyword hint ${sfx}`, async () => {
        fields = await ui.optionTexts(dialog.searchFieldSelect);
      });

      await step(`Assert: Expected 2 — Exactly 2 choices SKU명 (default) and SKU 코드; keyword box 검색어 with its hint ${sfx}`, async () => {
        expect(fields, `[Expected 2] The list has exactly 2 choices: ${t('skuSearch.field.SKU_NAME')}, ${t('skuSearch.field.SKU_CODE')}`).toEqual([t('skuSearch.field.SKU_NAME'), t('skuSearch.field.SKU_CODE')]);
        await expect(dialog.searchFieldSelect, `[Expected 2] ${t('skuSearch.field.SKU_NAME')} is the default`).toHaveValue('SKU_NAME');
        await expect(dialog.root.getByText(t('skuSearch.keyword'), { exact: true }), `[Expected 2] The keyword box is labelled ${t('skuSearch.keyword')}`).toBeVisible();
        await expect(dialog.keywordInput, `[Expected 2] The keyword box shows the hint ${t('filter.searchPlaceholder')}`).toHaveAttribute('placeholder', t('filter.searchPlaceholder'));
      });

      await step(`Act: Step 3 — Type the demo SKU code prefix, click 검색 and read the result headers ${sfx}`, async () => {
        await dialog.search('SKU_CODE', world.tag);
        await expect(dialog.rows.first(), 'The search returns result lines').toBeVisible();
        headers = await ui.headerTexts(dialog.headerCells);
      });

      await step(`Assert: Expected 3 — 4 headers: an unlabelled tick box, SKU 코드, SKU명, SKU 유형 ${sfx}`, async () => {
        expect(headers.length, '[Expected 3] The result table has 4 headers').toBe(4);
        expect(headers[0], '[Expected 3] Header 1 has no label').toBe('');
        await expect(dialog.rows.first().locator('td').first().locator('input[type="checkbox"]'), '[Expected 3] Column 1 holds a tick box').toBeVisible();
        (['skuSearch.col.skuCode', 'skuSearch.col.skuName', 'skuSearch.col.skuType'] as const).forEach((key, index) => {
          expect(headers[index + 1], `[Expected 3] Header ${index + 2} is ${t(key)}`).toBe(t(key));
        });
      });

      await step(`Act: Step 4 — Read the 2 buttons at the bottom of the dialog ${sfx}`, async () => {
        await expect(dialog.root.locator('.modal-footer'), 'The dialog footer is shown').toBeVisible();
      });

      await step(`Assert: Expected 4 — The bottom has 취소 and 추가 ${sfx}`, async () => {
        await expect(dialog.root.locator('.modal-footer').getByRole('button'), '[Expected 4] The footer has exactly 2 buttons').toHaveCount(2);
        await expect(dialog.cancelButton, `[Expected 4] ${t('btn.cancel')} is at the bottom`).toBeVisible();
        await expect(dialog.addButton, `[Expected 4] ${t('skuSearch.btn.add')} is at the bottom`).toBeVisible();
      });
    }
  });

  test('TC_US134_18 — The physical SKU master list shows its address, 6 search fields, 7 columns and its buttons', async ({ page, world, skuMasterPage: master }) => {
    const step = makeStep(page);
    const ui = new StockUiPage(page);
    await tcMeta(
      'TC_US134_18',
      'Medium',
      TAGS,
      `Clicking 물류 관리 › SKU 마스터 관리 › 현물 SKU 마스터 관리 opens /commerce/product-stock/sku-master/physical with 6 search fields in order (no SKU ID), the keyword hint, exactly 7 headers (no stock quantity column) and the buttons 검색 · 초기화 · SKU 생성 업로드 · create — in Korean, then in English. The keyword hint has no Korean text in the SRS: the screen's own hint (검색어를 입력해주세요. / Enter a search term.) is asserted per language. Observed on dev 05/10: the SKU 마스터 관리 menu group does not exist (the list route works by URL), so Expected 1 fails on the menu. ${WORLD_NOTE}`,
    );

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; physical SKUs DEMO-SKU-0001 and DEMO-SKU-0002 exist', async () => {
      for (const key of ['SKU0001', 'SKU0002'] as const) expect(world.sku(key).type, `${world.sku(key).skuCode} is a physical SKU`).toBe('PHYSICAL');
    });

    for (const lang of STOCK_LANGS) {
      const t = (key: StockTextKey) => stx(key, lang);
      const sfx = LANG_SUFFIX[lang];
      let viaMenu = false;
      let fields: string[] = [];
      let headers: string[] = [];

      await step(`Act: Step 1 — Open 물류 관리 › SKU 마스터 관리 › 현물 SKU 마스터 관리 from the left menu ${sfx}`, async () => {
        viaMenu = await ui.openMasterFromMenu('physical', lang);
      });

      await step(`Assert: Expected 1 — The SKU master list opens ${sfx}`, async () => {
        expect.soft(viaMenu, '[Expected 1] The list is opened from the 현물 SKU 마스터 관리 menu item').toBe(true);
        await expect(master.table, '[Expected 1] The SKU master list is shown').toBeVisible();
      });

      await step(`Act: Step 2 — Read the page address ${sfx}`, async () => {
        await expect(master.table, 'The list is shown').toBeVisible();
      });

      await step(`Assert: Expected 2 — The address is /commerce/product-stock/sku-master/physical ${sfx}`, async () => {
        await expect(page, '[Expected 2] The address is /commerce/product-stock/sku-master/physical').toHaveURL(/\/commerce\/product-stock\/sku-master\/physical(\?|$)/);
      });

      await step(`Act: Step 3 — Open the search condition list, read every choice and the keyword hint ${sfx}`, async () => {
        fields = await ui.optionTexts(master.searchFieldSelect);
      });

      await step(`Assert: Expected 3 — 6 choices in order (상품코드명 default … HS CODE, no SKU ID) and the keyword hint ${sfx}`, async () => {
        expect(fields.length, '[Expected 3] The list has 6 choices').toBe(6);
        (['skuSearchType.SKU_GROUP_CODE_NAME', 'skuSearchType.SKU_GROUP_CODE', 'skuSearchType.SKU_NAME', 'skuSearchType.SKU_CODE', 'skuSearchType.BARCODE', 'skuSearchType.HS_CODE'] as const).forEach((key, index) => {
          expect(fields[index], `[Expected 3] Choice ${index + 1} is ${t(key)}`).toBe(t(key));
        });
        await expect(master.searchFieldSelect, `[Expected 3] ${t('skuSearchType.SKU_GROUP_CODE_NAME')} is the default`).toHaveValue('SKU_GROUP_CODE_NAME');
        expect(fields, `[Expected 3] There is no ${t('searchField.SKU_ID')} choice`).not.toContain(t('searchField.SKU_ID'));
        await expect(master.keywordInput, `[Expected 3] The keyword box shows the hint ${t('filter.searchPlaceholder')}`).toHaveAttribute('placeholder', t('filter.searchPlaceholder'));
      });

      await step(`Act: Step 4 — Read the table column headers from left to right ${sfx}`, async () => {
        headers = await ui.headerTexts(master.headerCells);
      });

      await step(`Assert: Expected 4 — Exactly 7 headers 상품코드 … 생성일, no stock quantity column ${sfx}`, async () => {
        expect(headers.length, '[Expected 4] The table has exactly 7 headers').toBe(7);
        (['col.skuGroupCode', 'col.skuName', 'col.skuCode', 'col.barcode', 'master.col.skuKind', 'col.bizPartner', 'col.createdAt'] as const).forEach((key, index) => {
          expect(headers[index], `[Expected 4] Header ${index + 1} is ${t(key)}`).toBe(t(key));
        });
        for (const key of ['col.totalQuantity', 'col.availableQuantity', 'col.reservedQuantity', 'col.orderableQuantity'] as const) {
          expect(headers, `[Expected 4] There is no stock quantity column ${t(key)}`).not.toContain(t(key));
        }
      });

      await step(`Act: Step 5 — Read the buttons on the screen ${sfx}`, async () => {
        await expect(master.card, 'The list card is shown').toBeVisible();
      });

      await step(`Assert: Expected 5 — 검색, 초기화, SKU 생성 업로드 and a create button ${sfx}`, async () => {
        await expect(master.searchButton, `[Expected 5] ${t('btn.search')} is shown`).toBeVisible();
        await expect(master.resetButton, `[Expected 5] ${t('btn.reset')} is shown`).toBeVisible();
        await expect(master.uploadButton, `[Expected 5] ${t('master.btn.uploadSkuExcel')} is shown`).toHaveText(new RegExp(`${t('master.btn.uploadSkuExcel')}\\s*$`));
        await expect(ui.masterCreateLink('physical', lang), `[Expected 5] The create button ${t('master.create.physical')} is shown`).toBeVisible();
      });
    }
  });

  test('TC_US134_19 — A 150-character SKU name is cut with three dots and shows in full on hover, at 1920 and 390 wide', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const ui = new StockUiPage(page);
    await tcMeta(
      'TC_US134_19',
      'Medium',
      TAGS,
      'On 재고 관리 a 150-character SKU name (English ABCDEFGHIJ×15 and Korean 가나다라마바사아자차×15) is cut at 400 px with three dots in a 1920-wide window and at 220 px in a 390-wide window, the hover text shows all 150 characters, and the SKU코드 / 바코드 cells of the same row show their full values without dots. Data: DEMO-SKU-0001 of the shared world must keep its name for other tests, so the test creates 2 physical SKUs of its own (one per language value) whose product code name — and so SKU name — is the 150-character string, each with stock in the CJ Incheon Aam copy; their SKU code / barcode are the run-unique codes instead of DEMO-SKU-0001 / DEMO-BC-0001. The hover text is read from the cell title attribute or an open tooltip. Observed in the recon DOM 05/10: the SKU명 cell is a plain table cell in a text-nowrap table (no clip-lg class), so the truncation checks are expected to fail until the prototype width is implemented.',
    );
    const warehouse = world.warehouses.CJ;
    const values = [
      { label: 'English', name: 'ABCDEFGHIJ'.repeat(15), suffix: 'E' },
      { label: 'Korean', name: '가나다라마바사아자차'.repeat(15), suffix: 'K' },
    ];
    const rows: Array<{ label: string; name: string; sku: WorldSku }> = [];
    const wide = new Map<string, CellTruncation>();
    const narrow = new Map<string, CellTruncation>();
    const hoverWide = new Map<string, string | null>();
    const hoverNarrow = new Map<string, string | null>();
    const codeCells = new Map<string, { skuCode: CellTruncation; barcode: CellTruncation }>();

    await step('Arrange: Pre-condition 1–4 — Physical stock rows in CJ Incheon Aam whose SKU name is the 150-character English / Korean string; window 1920 wide', async () => {
      for (const value of values) {
        const [sku] = await world.createPhysicalSku(`TC19${value.suffix}`, {
          partner: world.partners.A,
          manufacturer: world.manufacturers.M1,
          groupName: value.name,
          lines: [{ skuCode: uniqueCode(world.tag, `T19SKU${value.suffix}`), barcode: uniqueCode(world.tag, `T19BAR${value.suffix}`) }],
        });
        await world.seedStock(sku, warehouse, { available: 10, csManaged: false });
        expect(value.name.length, `The ${value.label} test value has 150 characters`).toBe(150);
        expect(sku.skuName, `The ${value.label} SKU name holds the 150-character string`).toContain(value.name);
        rows.push({ label: value.label, name: value.name, sku });
      }
      expect(page.viewportSize()?.width, 'The window is 1920 wide').toBe(1920);
    });

    await step('Act: Step 1 — Open 재고 관리 and read the SKU명 cell of the long-name rows in the 1920-wide window', async () => {
      await list.open();
      await list.search('SKU_CODE', `${world.tag}T19SKU`);
      for (const row of rows) wide.set(row.label, await ui.truncation(list.cell(list.row(row.sku.skuCode, warehouse.name), 'col.skuName')));
    });

    await step('Assert: Expected 1 — The cell is cut at 400 pixels and ends with three dots', async () => {
      for (const row of rows) {
        const cell = wide.get(row.label)!;
        expect.soft(cell.ellipsis, `[Expected 1] The ${row.label} SKU name cell ends with three dots`).toBe(true);
        expect.soft(cell.truncated, `[Expected 1] The ${row.label} SKU name is cut`).toBe(true);
        expect.soft(Math.abs(cell.width - 400), `[Expected 1] The ${row.label} SKU name cell is cut at 400 px (measured ${cell.width.toFixed(1)} px)`).toBeLessThanOrEqual(2);
      }
    });

    await step('Act: Step 2 — Hover the mouse over the SKU명 cell and read the text that appears', async () => {
      for (const row of rows) hoverWide.set(row.label, await ui.hoverText(list.cell(list.row(row.sku.skuCode, warehouse.name), 'col.skuName')));
    });

    await step('Assert: Expected 2 — The hover text shows all 150 characters, for both the English and the Korean value', async () => {
      for (const row of rows) {
        const text = hoverWide.get(row.label) ?? '';
        expect.soft(text, `[Expected 2] The hover text of the ${row.label} value is the full SKU name`).toBe(row.sku.skuName);
        expect.soft(text, `[Expected 2] The hover text of the ${row.label} value holds all 150 characters`).toContain(row.name);
      }
    });

    await step('Act: Step 3 — Read the SKU코드 and 바코드 cells of the same rows', async () => {
      for (const row of rows) {
        const tableRow = list.row(row.sku.skuCode, warehouse.name);
        codeCells.set(row.label, { skuCode: await ui.truncation(list.cell(tableRow, 'col.skuCode')), barcode: await ui.truncation(list.cell(tableRow, 'col.barcode')) });
      }
    });

    await step('Assert: Expected 3 — Both cells show their full values with no three dots', async () => {
      for (const row of rows) {
        const cells = codeCells.get(row.label)!;
        expect(cells.skuCode.text, `[Expected 3] The ${row.label} row shows the full SKU code ${row.sku.skuCode}`).toBe(row.sku.skuCode);
        expect(cells.skuCode.ellipsis || cells.skuCode.truncated, `[Expected 3] The ${row.label} SKU code cell has no three dots`).toBe(false);
        expect(cells.barcode.text, `[Expected 3] The ${row.label} row shows the full barcode ${row.sku.barcode}`).toBe(row.sku.barcode);
        expect(cells.barcode.ellipsis || cells.barcode.truncated, `[Expected 3] The ${row.label} barcode cell has no three dots`).toBe(false);
      }
    });

    await step('Act: Step 4 — Shrink the window to 390 and read the SKU명 cell again', async () => {
      await ui.resizeWidth(390);
      for (const row of rows) {
        const cell = list.cell(list.row(row.sku.skuCode, warehouse.name), 'col.skuName');
        await cell.scrollIntoViewIfNeeded();
        narrow.set(row.label, await ui.truncation(cell));
        hoverNarrow.set(row.label, await ui.hoverText(cell));
      }
    });

    await step('Assert: Expected 4 — The cell is cut at 220 pixels, still ends with three dots, and hovering still shows the full text', async () => {
      for (const row of rows) {
        const cell = narrow.get(row.label)!;
        expect.soft(cell.ellipsis, `[Expected 4] The ${row.label} SKU name cell still ends with three dots`).toBe(true);
        expect.soft(cell.truncated, `[Expected 4] The ${row.label} SKU name is cut`).toBe(true);
        expect.soft(Math.abs(cell.width - 220), `[Expected 4] The ${row.label} SKU name cell is cut at 220 px (measured ${cell.width.toFixed(1)} px)`).toBeLessThanOrEqual(2);
        expect.soft(hoverNarrow.get(row.label) ?? '', `[Expected 4] Hovering the ${row.label} value still shows the full text`).toBe(row.sku.skuName);
      }
    });
  });

  test('TC_US134_20 — Longest values stay inside their cells, the table scrolls in its own frame and the page never scrolls sideways', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const ui = new StockUiPage(page);
    await tcMeta(
      'TC_US134_20',
      'Medium',
      TAGS,
      'Stock rows holding the longest allowed values (상품코드 / SKU코드 / 바코드 20 characters, SKU명 150 characters in Korean and in English) keep every cell inside its own column without text overlapping the next cell, the table scrolls sideways inside its own frame up to the readable 재고이력 column, the page has no sideways scrollbar at 1920, 1280 or 390 wide, and at 390 the cells are cut shorter yet still do not overlap. Data: the test creates its own 2 physical SKUs with run-unique 20-character codes (in place of DEMO-PC-000000000001 / DEMO-SKU-00000000001 / DEMO-BC-000000000001) and stock in the CJ Incheon Aam copy. "Cut shorter" is measured as a narrower SKU명 cell at 390 than at 1920; visual overlap is measured as text running past its cell edge or a cell box crossing the next one.',
    );
    const warehouse = world.warehouses.CJ;
    const values = [
      { label: 'Korean', name: '가나다라마바사아자차'.repeat(15), suffix: 'K' },
      { label: 'English', name: 'ABCDEFGHIJ'.repeat(15), suffix: 'E' },
    ];
    const rows: Array<{ label: string; skuCode: string }> = [];
    const overflowWide = new Map<string, number[]>();
    const overflowNarrow = new Map<string, number[]>();
    const nameWide = new Map<string, CellTruncation>();
    const nameNarrow = new Map<string, CellTruncation>();
    const pageScroll = new Observations(page);
    let frameScrolls = false;
    let lastHeaderInside = false;
    let lastCellInside = false;
    let lastHeaderClipped = true;

    await step('Arrange: Pre-condition 1–4 — Stock rows whose 상품코드, SKU코드 and 바코드 hold 20 characters and SKU명 150 characters; window 1920 wide', async () => {
      for (const value of values) {
        const [sku] = await world.createPhysicalSku(`TC20${value.suffix}`, {
          partner: world.partners.A,
          manufacturer: world.manufacturers.M1,
          groupCode: uniqueCode(world.tag, `T20PCD${value.suffix}`),
          groupName: value.name,
          lines: [{ skuCode: uniqueCode(world.tag, `T20SKU${value.suffix}`), barcode: uniqueCode(world.tag, `T20BAR${value.suffix}`) }],
        });
        await world.seedStock(sku, warehouse, { available: 10, csManaged: false });
        expect(sku.groupCode.length, `The ${value.label} product code has 20 characters`).toBe(20);
        expect(sku.skuCode.length, `The ${value.label} SKU code has 20 characters`).toBe(20);
        expect(sku.barcode?.length, `The ${value.label} barcode has 20 characters`).toBe(20);
        expect(sku.skuName, `The ${value.label} SKU name holds the 150-character string`).toContain(value.name);
        rows.push({ label: value.label, skuCode: sku.skuCode });
      }
      expect(page.viewportSize()?.width, 'The window is 1920 wide').toBe(1920);
    });

    await step('Act: Step 1 — Open 재고 관리 in the 1920-wide window and read the rows holding the longest values', async () => {
      await list.open();
      await list.search('SKU_CODE', `${world.tag}T20SKU`);
      for (const row of rows) {
        const tableRow = list.row(row.skuCode, warehouse.name);
        await expect(tableRow, `The ${row.label} long-value row is listed`).toBeVisible();
        overflowWide.set(row.label, await ui.overflowingCells(tableRow));
        nameWide.set(row.label, await ui.truncation(list.cell(tableRow, 'col.skuName')));
      }
    });

    await step('Assert: Expected 1 — Every cell stays inside its own column and no text overlaps the next cell', async () => {
      for (const row of rows) {
        expect(overflowWide.get(row.label), `[Expected 1] No cell of the ${row.label} row spills over or overlaps the next cell (column indexes listed)`).toEqual([]);
      }
    });

    await step('Act: Step 2 — Scroll the table right to the last column 재고이력', async () => {
      const frame = ui.tableFrame(list.table);
      frameScrolls = await scrollsInside(frame, 'x');
      await ui.scrollFrameToEnd(frame);
      lastHeaderInside = await isInsideContainerWidth(list.headerCells.last(), frame);
      lastCellInside = await isInsideContainerWidth(list.cell(list.row(rows[0].skuCode, warehouse.name), 'col.stockHistory'), frame);
      lastHeaderClipped = await isClipped(list.headerCells.last());
    });

    await step('Assert: Expected 2 — The table scrolls sideways inside its own frame and the last column can be read in full', async () => {
      expect(frameScrolls, '[Expected 2] The table scrolls sideways inside its own frame').toBe(true);
      await expect(list.headerCells.last(), `[Expected 2] The last column is ${stx('col.stockHistory', 'ko')}`).toHaveText(stx('col.stockHistory', 'ko'));
      expect(lastHeaderInside, `[Expected 2] The ${stx('col.stockHistory', 'ko')} header is fully inside the frame after scrolling`).toBe(true);
      expect(lastHeaderClipped, `[Expected 2] The ${stx('col.stockHistory', 'ko')} header text is not cut`).toBe(false);
      expect(lastCellInside, `[Expected 2] The ${stx('col.stockHistory', 'ko')} button of the row is fully inside the frame`).toBe(true);
    });

    await step('Act: Step 3 — Check for a sideways page scrollbar at 1920, 1280 and 390 wide', async () => {
      for (const width of [1920, 1280, 390]) {
        await ui.resizeWidth(width);
        await expect(list.table, `The list is shown at ${width} wide`).toBeVisible();
        await pageScroll.record(`[Expected 3] The page has no sideways scrollbar at ${width} wide`, async () => !(await hasHorizontalPageScroll(page)));
        await pageScroll.screenshot(`Window ${width} wide`);
      }
    });

    await step('Assert: Expected 3 — The whole page has no sideways scrollbar at 1920, 1280 or 390', async () => {
      pageScroll.assertAll();
    });

    await step('Act: Step 4 — Repeat step 1 in a 390-wide window', async () => {
      await ui.resizeWidth(390);
      for (const row of rows) {
        const tableRow = list.row(row.skuCode, warehouse.name);
        overflowNarrow.set(row.label, await ui.overflowingCells(tableRow));
        nameNarrow.set(row.label, await ui.truncation(list.cell(tableRow, 'col.skuName')));
      }
    });

    await step('Assert: Expected 4 — The cells are cut shorter to suit the narrow window but still do not overlap', async () => {
      for (const row of rows) {
        const [before, after] = [nameWide.get(row.label)!, nameNarrow.get(row.label)!];
        expect.soft(after.width, `[Expected 4] The ${row.label} SKU name cell is cut shorter at 390 (${after.width.toFixed(1)} px) than at 1920 (${before.width.toFixed(1)} px)`).toBeLessThan(before.width);
        expect.soft(after.truncated, `[Expected 4] The ${row.label} SKU name is cut at 390 wide`).toBe(true);
        expect(overflowNarrow.get(row.label), `[Expected 4] No cell of the ${row.label} row overlaps the next cell at 390 wide (column indexes listed)`).toEqual([]);
      }
    });
  });

  test('TC_US134_21 — Each SKU create form has exactly one return action, 목록으로, and no Back to stock management link', async ({ page }) => {
    const step = makeStep(page);
    const ui = new StockUiPage(page);
    const back = stx('skuForm.btn.backToList', 'ko');
    await tcMeta(
      'TC_US134_21',
      'Medium',
      TAGS,
      'Opened in create mode from its SKU master list, each of the physical, digital and set SKU forms has exactly one button that leaves the screen for the list — 목록으로 at the bottom of the page — and no "Back to stock management" link above the form. Return actions are counted inside the form card (buttons / links named 목록 / back / list / return); the breadcrumb path above the card (Commerce › Product-stock › Stock › <kind> › Create) is site navigation, not a form button. Observed on dev 05/10: the SKU 마스터 관리 menu group does not exist, so each SKU master list is opened by URL before clicking its create button.',
    );
    const found: Record<'physical' | 'digital' | 'set', { returns: number; backVisible: boolean; links: number }> = {
      physical: { returns: -1, backVisible: false, links: -1 },
      digital: { returns: -1, backVisible: false, links: -1 },
      set: { returns: -1, backVisible: false, links: -1 },
    };
    const inspect = async (kind: 'physical' | 'digital' | 'set') => {
      found[kind].returns = await ui.formReturnActions.count();
      found[kind].backVisible = await ui.formFooter.getByRole('button', { name: new RegExp(back) }).isVisible();
    };
    const lookForLink = async (kind: 'physical' | 'digital' | 'set') => {
      found[kind].links = (await ui.backToStockLink.count()) + (await page.getByText(/back to stock management/i).count());
    };

    await step('Arrange: Pre-condition 1–2 — Logged in with write access; no SKU is being edited, each screen opens in create mode from the list', async () => {
      expect(page.url(), 'No SKU edit screen is open').not.toContain('/edit');
    });

    await step('Act: Step 1 — Open the physical SKU create screen from 현물 SKU 마스터 관리 and count the buttons that return to the list', async () => {
      await ui.openMasterFromMenu('physical');
      await ui.clickMasterCreate('physical', 'ko');
      await inspect('physical');
    });

    await step(`Assert: Expected 1 — Exactly 1 such button — ${back} at the bottom of the page`, async () => {
      expect(found.physical.returns, '[Expected 1] The physical SKU screen has exactly 1 button back to the list').toBe(1);
      expect(found.physical.backVisible, `[Expected 1] That button is ${back} at the bottom of the page`).toBe(true);
    });

    await step('Act: Step 2 — Look above the form for a text link saying Back to stock management', async () => {
      await lookForLink('physical');
    });

    await step('Assert: Expected 2 — There is no Back to stock management link on the screen', async () => {
      expect(found.physical.links, '[Expected 2] There is no Back to stock management link on the physical SKU screen').toBe(0);
    });

    await step('Act: Step 3 — Repeat steps 1 and 2 on the digital SKU create screen opened from 디지털 SKU 마스터 관리', async () => {
      await ui.openMasterFromMenu('digital');
      await ui.clickMasterCreate('digital', 'ko');
      await inspect('digital');
      await lookForLink('digital');
    });

    await step(`Assert: Expected 3 — The digital SKU screen also has exactly 1 way out, ${back}, with no back link above`, async () => {
      expect(found.digital.returns, '[Expected 3] The digital SKU screen has exactly 1 button back to the list').toBe(1);
      expect(found.digital.backVisible, `[Expected 3] That button is ${back}`).toBe(true);
      expect(found.digital.links, '[Expected 3] There is no back link above the digital SKU form').toBe(0);
    });

    await step('Act: Step 4 — Repeat steps 1 and 2 on the set SKU create screen opened from set SKU 마스터 관리', async () => {
      await ui.openMasterFromMenu('set');
      await ui.clickMasterCreate('set', 'ko');
      await inspect('set');
      await lookForLink('set');
    });

    await step(`Assert: Expected 4 — The set SKU screen also has exactly 1 way out, ${back}, with no back link above`, async () => {
      expect(found.set.returns, '[Expected 4] The set SKU screen has exactly 1 button back to the list').toBe(1);
      expect(found.set.backVisible, `[Expected 4] That button is ${back}`).toBe(true);
      expect(found.set.links, '[Expected 4] There is no back link above the set SKU form').toBe(0);
    });
  });
});
