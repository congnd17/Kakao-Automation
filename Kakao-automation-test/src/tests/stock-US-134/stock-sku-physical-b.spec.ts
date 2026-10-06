import { test, expect } from '@fixtures/stock.fixture';
import type { Locator, Page } from '@playwright/test';
import { makeStep } from '@utils/step';
import { skipTc, tcMeta } from '@utils/tc-meta';
import { stx } from '@utils/stock.i18n';
import { WORLD_NOTE, stockTags } from '@utils/stock-spec';
import { StockWorld, WorldManufacturer, WorldPartner, WorldSku, uniqueCode } from '@utils/stock.data';
import { stockDb } from '@utils/stock-db';
import type { SkuUsageType } from '@api/stock.api';
import { StockUiPage } from '@pages/stock-ui.page';
import {
  PhysicalFormData,
  PhysicalSkuFormB,
  SaveAttempt,
  TC_DEFAULTS,
  dbColumn,
  exportCell,
  findPartnersWithoutManufacturer,
  groupIdOf,
} from '@pages/stock-sku-physical-b.page';

/**
 * US134 — nhóm [Physical SKU Form] TC_US134_118–140 + [SKU Forms] TC_141–142. Nguồn TC: SCRATCH/us134/TC_US134_<n>.txt
 * (Steps N / Expected N → `Act: Step N` / `Assert: Expected N`). Kỳ vọng assert theo TC; chỗ UI khác TC ghi trong description.
 * TC lưu SKU dùng mã riêng `uniqueCode(world.tag, …)` (đăng ký dọn bằng `world.trackGroupCode` sau khi lưu); TC sửa SKU dùng
 * nhóm SKU do test tự tạo, không đụng 12 dòng world dùng chung. Hành vi client (khoá 저장, lọc ký tự, giới hạn độ dài) đọc
 * từ bundle frontend 05/10/2026 (Nue / y8t / g8t / C8t / Aue).
 */
const TAGS = stockTags('sku-physical');
const FORM_TAGS = stockTags('sku-forms');
const t = (key: Parameters<typeof stx>[0]) => stx(key, 'ko');
const LIST_URL = /\/commerce\/product-stock\/(stock|sku-master\/physical)(\?|$)/;
const STOCK_LIST_URL = /\/commerce\/product-stock\/stock(\?|$)/;
const EXPORT_COLUMN = /수출용|export/i;
const FOC = '(FREE OF CHARGE) ';

/** Bộ mã duy nhất (상품코드 / SKU 코드 / 바코드) cho 1 lần lưu — nhãn ≤ 6 ký tự để còn chỗ cho số thứ tự. */
function codes(world: StockWorld, label: string): { groupCode: string; skuCode: string; barcode: string } {
  return { groupCode: uniqueCode(world.tag, `${label}P`), skuCode: uniqueCode(world.tag, `${label}S`), barcode: uniqueCode(world.tag, `${label}B`) };
}

/** Bộ data TC chung (Demo Partner A, 본품, 옵션없음, 12000, 250, 100/80/30, 6109101000, CD, Demo Manufacturer 1, 대한민국). */
function formData(world: StockWorld, label: string, overrides: Partial<PhysicalFormData> = {}, line: { skuName?: string; exportSkuName?: string } = {}): PhysicalFormData {
  const c = codes(world, label);
  return {
    partnerId: world.partners.A.id,
    groupCode: c.groupCode,
    groupName: `${world.tag} ${label} Demo Test Product`,
    usageType: 'MAIN',
    lines: [{ skuCode: c.skuCode, barcode: c.barcode, exportSkuName: line.exportSkuName ?? TC_DEFAULTS.exportSkuName, skuName: line.skuName }],
    manufacturerId: world.manufacturers.M1.id,
    ...overrides,
  };
}

/** Đăng ký dọn các nhóm SKU do form tạo ra (tra theo 상품코드 — gọi SAU khi lưu). */
async function trackCodes(world: StockWorld, groupCodes: string[]): Promise<void> {
  for (const code of groupCodes) await world.trackGroupCode(code);
}

const accepted = (attempt: SaveAttempt | null): boolean => !!attempt && attempt.sent && attempt.status !== null && attempt.status < 300;
const blocked = (attempt: SaveAttempt | null): boolean => !!attempt && !accepted(attempt);
const message = (attempt: SaveAttempt | null): string => String(attempt?.body?.message ?? attempt?.body?.detail ?? '');
const errorCode = (attempt: SaveAttempt | null): string => String(attempt?.body?.code ?? '');
const REQUIRED_NOTE =
  'Observed in the frontend bundle 05/10: 저장 stays disabled only until both duplicate checks pass (create) / until something changed and the barcode check passed (edit); an empty required field is reported on click with the toast 필수항목을 입력해주세요. and the field message under the field — the NEEDS CLARIFICATION step is asserted on whichever branch the build shows (disabled 저장, or the message).';

/** Mở form tạo 현물 mới, điền bộ data TC và qua 2 bước 중복확인. */
async function openFilledCreate(form: PhysicalSkuFormB, data: PhysicalFormData): Promise<void> {
  await form.openCreate('physical');
  await form.fillForm(data);
  await form.passBothChecks();
}

const onCreateForm = (page: Page): boolean => page.url().includes('/physical/create');

/**
 * Assert 1 lần lưu bị chặn vì thiếu trường bắt buộc (TC "NEEDS CLARIFICATION"): luôn kiểm bị chặn; nhánh 저장 còn bật →
 * kiểm thông báo dưới trường (và toast 필수항목을 입력해주세요. khi TC nêu).
 */
async function expectRequiredBlock(
  attempt: SaveAttempt | null,
  n: number,
  what: string,
  fieldMessage: { error: Locator; text: string } | null,
  requiredToast: boolean,
): Promise<void> {
  expect(blocked(attempt), `[Expected ${n}] Saving is blocked while ${what} is empty`).toBe(true);
  if (attempt?.disabled) return;
  if (requiredToast) expect(attempt?.toast, `[Expected ${n}] Pressing 저장 shows ${t('msg.requiredFields')}`).toBe(t('msg.requiredFields'));
  if (fieldMessage) await expect(fieldMessage.error, `[Expected ${n}] ${what} shows ${fieldMessage.text}`).toHaveText(fieldMessage.text);
}

test.describe('[Physical SKU Form] Physical SKU create / edit form rules', () => {
  test('TC_US134_118 — An HS code with dots is rejected by the direct create call and by the SKU creation upload', async () => {
    await skipTc(
      'TC_US134_118',
      'Medium',
      TAGS,
      'A create-SKU call sent straight to the server with HS code 6109.10.00 is rejected and creates nothing; the same HS code in a create-SKU workbook uploaded through SKU 생성 업로드 is rejected with EXL-4000 (row {n} not valid) and creates nothing.',
      'Steps 3–4 need a valid 20-column SKU-creation workbook: the 20 header names are not published (TC_US134_388 remark: "take a valid workbook from the build\'s own upload row"), the build offers no template download, and the frontend bundle holds no column list — a workbook built on guessed headers would be rejected for its header, not for the HS code. Provide a valid workbook (or its header row) to automate this TC.',
    );
  });

  test('TC_US134_119 — A legacy HS code is shown as stored and blocks saving until it has 10 digits and an export name', async ({ page, world, stockApi, stockListPage: list }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormB(page);
    await tcMeta(
      'TC_US134_119',
      'Medium',
      TAGS,
      `An old physical SKU group (HS code 6109.10.00, empty 수출용 SKU명 — staged by DB writes on a group the test creates) opens from 재고 관리 with the HS code shown exactly as stored; saving after a product-code-name change is blocked with the 10-digit HS message and the empty export name is refused; 610910100 is still blocked; 6109101000 + CS_ 2026 SPRING saves and returns to the list. Per the frontend bundle only the first message is toasted, the other errors show under their fields. ${WORLD_NOTE}`,
    );
    let legacy!: WorldSku;
    let attempt3: SaveAttempt | null = null;
    let attempt4: SaveAttempt | null = null;
    let attempt5: SaveAttempt | null = null;

    await step('Arrange: Pre-condition 1–2 — Logged in with write access; an old SKU group with HS code 6109.10.00 and an empty export SKU name exists', async () => {
      [legacy] = await world.createPhysicalSku('TC119', { partner: world.partners.A, manufacturer: world.manufacturers.M1, groupName: `${world.tag} TC119 Legacy product` });
      let hsWrites = 0;
      for (const [table, id] of [['sku_group', legacy.groupId], ['sku', legacy.skuId]] as const) {
        const column = await dbColumn(table, /^hs_?code$/i);
        if (column) hsWrites += await stockDb.exec(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, ['6109.10.00', id]);
      }
      expect(hsWrites, 'The legacy HS code 6109.10.00 is written to the own SKU group').toBeGreaterThan(0);
      const exportColumn = await dbColumn('sku', /export/i);
      expect(exportColumn, 'The sku table holds an export SKU name column').not.toBeNull();
      await stockDb.exec(`UPDATE sku SET ${exportColumn} = '' WHERE id = ?`, [legacy.skuId]);
      const detail = (await stockApi.skuGroup(legacy.groupId)).body;
      expect(detail.hsCode, 'The SKU group now reads HS code 6109.10.00').toBe('6109.10.00');
      expect(detail.skus[0]?.exportSkuName ?? '', 'The SKU line now has no export SKU name').toBe('');
    });

    await step('Act: Step 1 — Open 재고 관리 (Stock management) and open the edit screen of that old SKU group', async () => {
      await form.openEditFromList(list, legacy.groupCode, legacy.skuCode);
    });

    await step('Assert: Expected 1 — The edit screen opens normally', async () => {
      await expect(form.cardTitle, `[Expected 1] The card title is ${t('skuForm.title.physical')}`).toHaveText(t('skuForm.title.physical'));
      await expect(form.modeBadge, `[Expected 1] The mode badge is ${t('skuForm.mode.edit')}`).toHaveText(t('skuForm.mode.edit'));
      await expect(form.skuGroupCodeInput, `[Expected 1] The form shows product code ${legacy.groupCode}`).toHaveValue(legacy.groupCode);
    });

    await step('Act: Step 2 — Read the value in the HS 코드 (HS code) field', async () => {
      await expect(form.hsCodeInput, 'The HS code field is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — The field shows 6109.10.00 exactly as stored', async () => {
      await expect(form.hsCodeInput, '[Expected 2] The HS code field shows 6109.10.00 — not cleared, cut or padded').toHaveValue('6109.10.00');
    });

    await step('Act: Step 3 — Change only 상품코드명 (Product code name), click 바코드 중복확인 (Barcode duplicate check) and 저장 (Save)', async () => {
      await form.skuGroupCodeNameInput.fill(`${legacy.groupName} rev`);
      await form.passBarcodeCheck();
      attempt3 = await form.attemptSave();
    });

    await step('Assert: Expected 3 — Saving is blocked: the 10-digit HS message is shown and the empty export SKU name is refused', async () => {
      expect(blocked(attempt3), '[Expected 3] Saving is blocked although only the product code name changed').toBe(true);
      await expect(form.fieldError('skuForm.field.hsCode'), `[Expected 3] The HS code shows ${t('skuForm.err.hsCode')}`).toHaveText(t('skuForm.err.hsCode'));
      await expect(form.lineInput(0, 'exportSkuName'), '[Expected 3] The empty export SKU name is refused (marked invalid)').toHaveClass(/is-invalid/);
      await expect(form.lineExportError(0), '[Expected 3] The empty export SKU name shows an error message').toBeVisible();
    });

    await step('Act: Step 4 — Change the HS code field to 610910100 and click 저장 (Save)', async () => {
      await form.hsCodeInput.fill('610910100');
      attempt4 = await form.attemptSave();
    });

    await step('Assert: Expected 4 — Saving is blocked with HS 코드는 숫자 10자리로 입력해주세요.', async () => {
      expect(blocked(attempt4), '[Expected 4] Saving a 9-digit HS code is blocked').toBe(true);
      await expect(form.fieldError('skuForm.field.hsCode'), `[Expected 4] The HS code shows ${t('skuForm.err.hsCode')}`).toHaveText(t('skuForm.err.hsCode'));
    });

    await step('Act: Step 5 — Change HS 코드 to 6109101000, type CS_ 2026 SPRING into 수출용 SKU명 and click 저장 (Save)', async () => {
      await form.hsCodeInput.fill('6109101000');
      await form.lineInput(0, 'exportSkuName').fill(TC_DEFAULTS.exportSkuName);
      attempt5 = await form.attemptSave();
    });

    await step('Assert: Expected 5 — The save goes through and returns to the list', async () => {
      expect(accepted(attempt5), `[Expected 5] The save goes through (HTTP ${attempt5?.status ?? 'not sent'} ${message(attempt5)})`).toBe(true);
      await expect(page, '[Expected 5] The browser returns to the stock list').toHaveURL(STOCK_LIST_URL, { timeout: 30_000 });
    });
  });

  test('TC_US134_120 — The export SKU name takes only the allowed characters and at most 150 of them', async ({ page, world, stockApi, skuFormPage }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormB(page);
    await tcMeta(
      'TC_US134_120',
      'Medium',
      TAGS,
      `On the physical create form (옵션있음, every other field filled, both duplicate checks passed) the 수출용 SKU명 field next to SKU명 has its label and hint, takes CS_ 2026 SPRING and the full set of allowed marks; Korean text and an emoji are refused with the allowed-characters message and the cursor goes to the field; 150 characters save and 151 are refused with the 150-character message. Observed in the frontend bundle 05/10: the field silently strips every character outside A–Z a–z 0–9 space _ ( ) [ ] - . , while typing (Korean becomes blanks → the 10-character minimum message instead; "Demo Album 🎵" becomes the valid "Demo Album" and saves) and caps the input at 150 characters, so a 151st character cannot be typed — the 151 attempt is made on the edit screen of the 150-character record. No focus move is coded on a failed save. ${WORLD_NOTE}`,
    );
    const saved: string[] = [];
    const exportInput = form.lineInput(0, 'exportSkuName');
    const value150 = TC_DEFAULTS.exportSkuName.padEnd(150, 'X');
    const korean = '데모 앨범 스프링 에디션';
    const emoji = 'Demo Album 🎵';
    const marks = 'AB_1 (2) [3] - 4 . 5 , 6';
    let headers: string[] = [];
    const round4: Array<{ typed: string; kept: string; attempt: SaveAttempt; error: string | null; focused: boolean }> = [];
    let attempt150: SaveAttempt | null = null;
    let attempt151: SaveAttempt | null = null;
    let value151 = '';
    let focused151 = false;
    let error151: string | null = null;

    const openFilledForm = async (label: string): Promise<void> => {
      const data = formData(world, label, { hasOption: true }, { skuName: 'Type A', exportSkuName: '' });
      saved.push(data.groupCode);
      await form.openCreate('physical');
      await form.fillForm(data);
      await form.passBothChecks();
    };
    const errorText = async (): Promise<string | null> => ((await form.lineExportError(0).count()) > 0 ? (await form.lineExportError(0).innerText()).trim() : null);
    const isFocused = async (): Promise<boolean> => exportInput.evaluate((el) => el === document.activeElement).catch(() => false);

    try {
      await step('Arrange: Pre-condition 1–3 — Create form open with 옵션있음, every other field filled and both duplicate checks passed', async () => {
        expect(skuFormPage, 'The shared SKU form fixture is available').toBeDefined();
        await openFilledForm('T120A');
      });

      await step('Act: Step 1 — Read the label and the placeholder of the 수출용 SKU명 (Export SKU name) field on the SKU line', async () => {
        headers = await form.lineHeaderTexts();
      });

      await step('Assert: Expected 1 — Label 수출용 SKU명, hint 수출용 SKU명을 입력해주세요, field next to SKU명', async () => {
        expect(headers, `[Expected 1] The SKU line has the column ${t('skuForm.col.exportSkuName')}`).toContain(t('skuForm.col.exportSkuName'));
        await expect(exportInput, `[Expected 1] The hint is ${t('skuForm.ph.exportSkuName')}`).toHaveAttribute('placeholder', t('skuForm.ph.exportSkuName'));
        expect(headers.indexOf(t('skuForm.col.exportSkuName')), `[Expected 1] ${t('skuForm.col.exportSkuName')} sits right after ${t('skuForm.col.skuName')}`).toBe(headers.indexOf(t('skuForm.col.skuName')) + 1);
      });

      await step('Act: Step 2 — Type CS_ 2026 SPRING into that field', async () => {
        await exportInput.fill(TC_DEFAULTS.exportSkuName);
      });

      await step('Assert: Expected 2 — The field accepts CS_ 2026 SPRING', async () => {
        await expect(exportInput, '[Expected 2] The field holds CS_ 2026 SPRING').toHaveValue(TC_DEFAULTS.exportSkuName);
      });

      await step('Act: Step 3 — Clear it and type the value with the full set of allowed marks', async () => {
        await exportInput.fill('');
        await exportInput.fill(marks);
      });

      await step('Assert: Expected 3 — The field accepts the complete value with _ ( ) [ ] - . ,', async () => {
        await expect(exportInput, `[Expected 3] The field holds "${marks}" in full`).toHaveValue(marks);
      });

      await step('Act: Step 4 — Type 데모 앨범 스프링 에디션 and click 저장 (Save); then replace it with Demo Album 🎵 and click 저장 (Save)', async () => {
        for (const typed of [korean, emoji]) {
          if (!page.url().includes('/physical/create')) await openFilledForm('T120B');
          await exportInput.fill('');
          await exportInput.fill(typed);
          const kept = await exportInput.inputValue();
          const attempt = await form.attemptSave();
          round4.push({ typed, kept, attempt, error: accepted(attempt) ? null : await errorText(), focused: accepted(attempt) ? false : await isFocused() });
        }
      });

      await step('Assert: Expected 4 — Each save is blocked with the allowed-characters message and the cursor jumps into the field', async () => {
        for (const round of round4) {
          expect(blocked(round.attempt), `[Expected 4] Saving "${round.typed}" is blocked (field kept "${round.kept}")`).toBe(true);
          expect(round.error, `[Expected 4] Saving "${round.typed}" shows ${t('skuForm.err.exportChars')}`).toBe(t('skuForm.err.exportChars'));
          expect(round.focused, `[Expected 4] After saving "${round.typed}" the cursor is in the export SKU name field`).toBe(true);
        }
      });

      await step('Act: Step 5 — Type the 150-character value and click 저장 (Save); then add 1 character (151) and click 저장 (Save)', async () => {
        if (!page.url().includes('/physical/create')) await openFilledForm('T120C');
        await exportInput.fill(value150);
        attempt150 = await form.attemptSave();
        if (accepted(attempt150)) {
          const groupId = await groupIdOf(stockApi, saved[saved.length - 1]);
          expect(groupId, 'The 150-character record can be found to reopen it').not.toBeNull();
          await form.openEdit('physical', groupId as number);
          await form.passBarcodeCheck();
        }
        await exportInput.press('End');
        await exportInput.pressSequentially('Y');
        value151 = await exportInput.inputValue();
        attempt151 = await form.attemptSave();
        error151 = accepted(attempt151) ? null : await errorText();
        focused151 = await isFocused();
      });

      await step('Assert: Expected 5 — 150 characters save; 151 are blocked with the 150-character message and the cursor jumps into the field', async () => {
        expect(accepted(attempt150), `[Expected 5] The 150-character value saves (HTTP ${attempt150?.status ?? 'not sent'} ${message(attempt150)})`).toBe(true);
        expect(blocked(attempt151), `[Expected 5] Saving the 151-character value is blocked (field holds ${value151.length} characters)`).toBe(true);
        expect(error151, `[Expected 5] The 151-character value shows ${t('skuForm.err.exportTooLong')}`).toBe(t('skuForm.err.exportTooLong'));
        expect(focused151, '[Expected 5] The cursor jumps into the export SKU name field').toBe(true);
      });
    } finally {
      await trackCodes(world, saved);
    }
  });

  test('TC_US134_121 — The FREE OF CHARGE prefix is added to the export SKU name of components and giveaways only', async ({ page, world, stockApi, stockListPage: list }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormB(page);
    await tcMeta(
      'TC_US134_121',
      'Medium',
      TAGS,
      `Three physical SKUs saved from the create form with the same export SKU name CS_ 2026 SPRING and SKU 종류 본품 / 구성품 / 사은품: the edit screen of the 본품 shows no prefix; for 구성품 and 사은품 the input keeps the typed text and the line shows the prefixed value "(FREE OF CHARGE) CS_ 2026 SPRING" (the bundle renders it as a grey line under the input — the TC leaves the element open, so that line is checked); the stock export (엑셀 다운로드 on 재고 관리 filtered by the 3 product code names) carries the prefix for 구성품 / 사은품 only. ${WORLD_NOTE}`,
    );
    const kinds: SkuUsageType[] = ['MAIN', 'PARTS', 'GIVEAWAY'];
    const label = `${world.tag} FOC121`;
    const rounds: Array<{ kind: SkuUsageType; data: PhysicalFormData; attempt: SaveAttempt | null; input: string; preview: string | null }> = [];
    let exportRows: string[][] = [];

    const saveKind = async (kind: SkuUsageType): Promise<void> => {
      const data = formData(world, `F121${kind[0]}`, { usageType: kind, groupName: `${label} ${kind} product` });
      const round = { kind, data, attempt: null as SaveAttempt | null, input: '', preview: null as string | null };
      rounds.push(round);
      await form.openCreate('physical');
      await form.fillForm(data);
      await form.passBothChecks();
      round.attempt = await form.attemptSave();
      if (!accepted(round.attempt)) return;
      const groupId = await groupIdOf(stockApi, data.groupCode);
      expect(groupId, `The saved ${kind} SKU group can be found`).not.toBeNull();
      await form.openEdit('physical', groupId as number);
      round.input = await form.lineInput(0, 'exportSkuName').inputValue();
      round.preview = (await form.lineExportPreview(0).count()) > 0 ? (await form.lineExportPreview(0).innerText()).trim() : null;
    };
    const roundOf = (kind: SkuUsageType) => rounds.find((round) => round.kind === kind);

    try {
      await step('Arrange: Pre-condition 1–3 — Create form data: Demo Partner A, 옵션없음, every other field filled, own codes per SKU, export SKU name CS_ 2026 SPRING', async () => {
        expect(world.manufacturers.M1.id, 'Demo Manufacturer 1 of Demo Partner A is available').toBeGreaterThan(0);
      });

      await step('Act: Step 1 — Set SKU 종류 to 본품 (Main item), type CS_ 2026 SPRING, save, then read the value shown on the edit screen', async () => {
        await saveKind('MAIN');
      });

      await step('Assert: Expected 1 — The value shows CS_ 2026 SPRING with no prefix', async () => {
        const round = roundOf('MAIN');
        expect(accepted(round?.attempt ?? null), '[Expected 1] The 본품 SKU is saved').toBe(true);
        expect(round?.input, '[Expected 1] The export SKU name field shows CS_ 2026 SPRING').toBe(TC_DEFAULTS.exportSkuName);
        expect(round?.preview, '[Expected 1] No (FREE OF CHARGE) prefixed value is shown for 본품').toBeNull();
      });

      await step('Act: Step 2 — Create a new SKU with SKU 종류 구성품 (Component), the same export name, save, then read the value shown', async () => {
        await saveKind('PARTS');
      });

      await step('Assert: Expected 2 — The input keeps the typed text and the shown value carries the FREE OF CHARGE prefix', async () => {
        const round = roundOf('PARTS');
        expect(accepted(round?.attempt ?? null), '[Expected 2] The 구성품 SKU is saved').toBe(true);
        expect(round?.input, '[Expected 2] The input keeps the typed CS_ 2026 SPRING').toBe(TC_DEFAULTS.exportSkuName);
        expect(round?.preview, '[Expected 2] The shown value is (FREE OF CHARGE) CS_ 2026 SPRING').toBe(`${FOC}${TC_DEFAULTS.exportSkuName}`);
      });

      await step('Act: Step 3 — Create a new SKU with SKU 종류 사은품 (Giveaway), the same export name, save, then read the value shown', async () => {
        await saveKind('GIVEAWAY');
      });

      await step('Assert: Expected 3 — The input keeps the typed text and the shown value carries the FREE OF CHARGE prefix', async () => {
        const round = roundOf('GIVEAWAY');
        expect(accepted(round?.attempt ?? null), '[Expected 3] The 사은품 SKU is saved').toBe(true);
        expect(round?.input, '[Expected 3] The input keeps the typed CS_ 2026 SPRING').toBe(TC_DEFAULTS.exportSkuName);
        expect(round?.preview, '[Expected 3] The shown value is (FREE OF CHARGE) CS_ 2026 SPRING').toBe(`${FOC}${TC_DEFAULTS.exportSkuName}`);
      });

      await step('Act: Step 4 — Export the data of all 3 SKUs and read the export SKU name column', async () => {
        await list.open();
        await list.search('SKU_GROUP_NAME', label);
        exportRows = await form.downloadStockExport(list);
      });

      await step('Assert: Expected 4 — The file has the prefix for 구성품 and 사은품, and not for 본품', async () => {
        expect(exportRows.length, '[Expected 4] The exported file has a header and data rows').toBeGreaterThan(1);
        for (const kind of kinds) {
          const round = roundOf(kind);
          const cell = exportCell(exportRows, round?.data.lines[0].skuCode ?? '', EXPORT_COLUMN);
          expect(cell.header, `[Expected 4] The exported file has a 수출용 SKU명 (Export SKU name) column (headers: ${(exportRows[0] ?? []).join(' | ')})`).not.toBeNull();
          const expected = kind === 'MAIN' ? TC_DEFAULTS.exportSkuName : `${FOC}${TC_DEFAULTS.exportSkuName}`;
          expect(cell.value, `[Expected 4] The ${kind} SKU exports ${expected}`).toBe(expected);
        }
      });
    } finally {
      await trackCodes(world, rounds.map((round) => round.data.groupCode));
    }
  });

  test('TC_US134_122 — The FREE OF CHARGE prefix is not stored: changing the stored kind to 본품 drops it from the export', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormB(page);
    await tcMeta(
      'TC_US134_122',
      'High',
      TAGS,
      `A 사은품 (GIVEAWAY) physical SKU created by the test with export SKU name CS_ 2026 SPRING: the DB column holds CS_ 2026 SPRING, the edit input shows CS_ 2026 SPRING; after the stored SKU kind is switched to MAIN by a DB write (the radio is locked on edit) the reloaded edit screen shows 본품, the stock export (엑셀 다운로드 filtered by its product code) carries CS_ 2026 SPRING with no prefix, and the DB value is unchanged. ${WORLD_NOTE}`,
    );
    let sku!: WorldSku;
    let exportColumn: string | null = null;
    let stored1: string | null = null;
    let stored5: string | null = null;
    let input2 = '';
    let usageWrites = 0;
    let exportRows: string[][] = [];
    const storedExport = async (): Promise<string | null> => {
      const [row] = await stockDb.query(`SELECT ${exportColumn} AS value FROM sku WHERE id = ?`, [sku.skuId]);
      return row ? String(row.value) : null;
    };

    await step('Arrange: Pre-condition 1–2 — Logged in with write access; a 사은품 (Giveaway) SKU with export SKU name CS_ 2026 SPRING exists', async () => {
      [sku] = await world.createPhysicalSku('TC122', {
        partner: world.partners.A,
        manufacturer: world.manufacturers.M1,
        usageType: 'GIVEAWAY',
        groupName: `${world.tag} TC122 Giveaway product`,
        lines: [{ exportSkuName: TC_DEFAULTS.exportSkuName }],
      });
      exportColumn = await dbColumn('sku', /export/i);
      expect(exportColumn, 'The sku table holds an export SKU name column').not.toBeNull();
    });

    await step('Act: Step 1 — Read the stored database value of the export SKU name field', async () => {
      stored1 = await storedExport();
    });

    await step('Assert: Expected 1 — The stored value is CS_ 2026 SPRING', async () => {
      expect(stored1, '[Expected 1] The DB holds CS_ 2026 SPRING without the (FREE OF CHARGE) prefix').toBe(TC_DEFAULTS.exportSkuName);
    });

    await step('Act: Step 2 — Open the edit screen of that SKU and read the value shown in the input field', async () => {
      await form.openEdit('physical', sku.groupId);
      input2 = await form.lineInput(0, 'exportSkuName').inputValue();
    });

    await step('Assert: Expected 2 — The input field shows CS_ 2026 SPRING, not the prefixed version', async () => {
      expect(input2, '[Expected 2] The export SKU name input shows CS_ 2026 SPRING (no prefix joined on)').toBe(TC_DEFAULTS.exportSkuName);
    });

    await step('Act: Step 3 — Change the stored SKU kind from GIVEAWAY to MAIN in the database (export name untouched) and reload the edit screen', async () => {
      for (const table of ['sku_group', 'sku'] as const) {
        const column = await dbColumn(table, /usage/i);
        if (column) usageWrites += await stockDb.exec(`UPDATE ${table} SET ${column} = 'MAIN' WHERE id = ?`, [table === 'sku' ? sku.skuId : sku.groupId]);
      }
      await form.openEdit('physical', sku.groupId);
    });

    await step('Assert: Expected 3 — The edit screen reloads and SKU 종류 (SKU kind) shows 본품 (Main item)', async () => {
      expect(usageWrites, '[Expected 3] The stored SKU kind was switched to MAIN in the DB').toBeGreaterThan(0);
      await expect(form.cardTitle, `[Expected 3] The edit screen reloads (${t('skuForm.title.physical')})`).toHaveText(t('skuForm.title.physical'));
      await expect(form.usageRadio('MAIN'), '[Expected 3] SKU 종류 shows 본품 (Main item)').toBeChecked();
    });

    await step('Act: Step 4 — Export the data of that SKU and read the export SKU name column', async () => {
      await list.open();
      await list.search('SKU_GROUP_CODE', sku.groupCode);
      exportRows = await form.downloadStockExport(list);
    });

    await step('Assert: Expected 4 — The exported value is CS_ 2026 SPRING with no prefix', async () => {
      const cell = exportCell(exportRows, sku.skuCode, EXPORT_COLUMN);
      expect(cell.header, `[Expected 4] The exported file has a 수출용 SKU명 (Export SKU name) column (headers: ${(exportRows[0] ?? []).join(' | ')})`).not.toBeNull();
      expect(cell.value, '[Expected 4] The exported export SKU name is CS_ 2026 SPRING with no (FREE OF CHARGE) prefix').toBe(TC_DEFAULTS.exportSkuName);
    });

    await step('Act: Step 5 — Read the stored database value again', async () => {
      stored5 = await storedExport();
    });

    await step('Assert: Expected 5 — The stored value is still CS_ 2026 SPRING, unchanged', async () => {
      expect(stored5, '[Expected 5] The DB value is still CS_ 2026 SPRING').toBe(TC_DEFAULTS.exportSkuName);
    });
  });

  test('TC_US134_123 — Saving is blocked while the export SKU name is shorter than 10 characters', async ({ page, world }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormB(page);
    await tcMeta(
      'TC_US134_123',
      'Medium',
      TAGS,
      `On the physical create form (every other field filled, both duplicate checks passed) with SKU 종류 사은품: export SKU name CS2026 (6) and CS_ 2026A (9) are blocked with 수출용 SKU명은 10자 이상 입력해주세요. and the cursor goes to the field; CS_ 2026AB (exactly 10) saves — the (FREE OF CHARGE) prefix does not count. Observed in the frontend bundle 05/10: the message is toasted and shown under the field; no focus move is coded on a failed save. ${WORLD_NOTE}`,
    );
    const data = formData(world, 'T123', { usageType: 'GIVEAWAY' }, { exportSkuName: '' });
    const exportInput = form.lineInput(0, 'exportSkuName');
    let attempt1: SaveAttempt | null = null;
    let attempt3: SaveAttempt | null = null;
    let attempt4: SaveAttempt | null = null;
    let error2: string | null = null;
    let error3: string | null = null;
    let focused2 = false;
    const errorText = async (): Promise<string | null> => ((await form.lineExportError(0).count()) > 0 ? (await form.lineExportError(0).innerText()).trim() : null);

    await step('Arrange: Pre-condition 1–3 — Create form open with every other field filled (Demo Partner A, 옵션없음, …) and both duplicate checks passed', async () => {
      await world.trackGroupCode(data.groupCode);
      await openFilledCreate(form, data);
    });

    await step('Act: Step 1 — Set SKU 종류 (SKU kind) to 사은품 (Giveaway), type CS2026 into 수출용 SKU명 and click 저장 (Save)', async () => {
      await form.usageRadio('GIVEAWAY').check();
      await exportInput.fill('CS2026');
      attempt1 = await form.attemptSave();
    });

    await step('Assert: Expected 1 — Saving is blocked', async () => {
      expect(blocked(attempt1), '[Expected 1] Saving a 6-character export SKU name is blocked').toBe(true);
    });

    await step('Act: Step 2 — Read the message that appears and see where the cursor jumps', async () => {
      error2 = await errorText();
      focused2 = await exportInput.evaluate((el) => el === document.activeElement);
    });

    await step('Assert: Expected 2 — The message shows 수출용 SKU명은 10자 이상 입력해주세요. and the cursor jumps into the export SKU name field', async () => {
      expect(attempt1?.toast, `[Expected 2] The message ${t('skuForm.err.exportTooShort')} is shown`).toBe(t('skuForm.err.exportTooShort'));
      expect(error2, `[Expected 2] The export SKU name field shows ${t('skuForm.err.exportTooShort')}`).toBe(t('skuForm.err.exportTooShort'));
      expect(focused2, '[Expected 2] The cursor is in the export SKU name field').toBe(true);
    });

    await step('Act: Step 3 — Change it to CS_ 2026A (9 characters) and click 저장 (Save)', async () => {
      await exportInput.fill('CS_ 2026A');
      attempt3 = await form.attemptSave();
      error3 = accepted(attempt3) ? null : await errorText();
    });

    await step('Assert: Expected 3 — Saving is still blocked with the same message', async () => {
      expect(blocked(attempt3), '[Expected 3] Saving a 9-character export SKU name is blocked').toBe(true);
      expect(attempt3?.toast, `[Expected 3] The message is again ${t('skuForm.err.exportTooShort')}`).toBe(t('skuForm.err.exportTooShort'));
      expect(error3, `[Expected 3] The field shows ${t('skuForm.err.exportTooShort')}`).toBe(t('skuForm.err.exportTooShort'));
    });

    await step('Act: Step 4 — Change it to CS_ 2026AB (exactly 10 characters) and click 저장 (Save)', async () => {
      await exportInput.fill('CS_ 2026AB');
      attempt4 = await form.attemptSave();
    });

    await step('Assert: Expected 4 — The save goes through at the lower limit', async () => {
      expect(accepted(attempt4), `[Expected 4] A 10-character export SKU name saves (HTTP ${attempt4?.status ?? 'not sent'} ${message(attempt4)})`).toBe(true);
    });
  });

  test('TC_US134_124 — A save naming a biz partner id that does not exist is turned down with WH-BIZ_PARTNER_NOT_FOUND', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormB(page);
    const missingId = 999999999999999;
    await tcMeta(
      'TC_US134_124',
      'Medium',
      TAGS,
      `The physical SKU form filled with Demo Partner A saves; the same create payload sent straight to POST /api/v1/skus with bizPartnerId ${missingId} (own unused codes, so only the partner differs) is turned down with WH-BIZ_PARTNER_NOT_FOUND "비즈파트너를 찾을 수 없습니다. - id: ${missingId}" and creates no SKU. ${WORLD_NOTE}`,
    );
    const data = formData(world, 'T124', { groupName: `${world.tag} T124 Demo Physical 930` }, { exportSkuName: 'Demo Export Name 930' });
    const direct = codes(world, 'T124D');
    let attempt1: SaveAttempt | null = null;
    let result: { status: number; body: Record<string, unknown> | null } = { status: 0, body: null };
    let createdId: number | null = null;

    await step('Arrange: Pre-condition 1–3 — Demo Partner A exists, id 999999999999999 belongs to no partner; the form is filled with unused codes and both checks passed', async () => {
      await world.trackGroupCode(data.groupCode);
      await world.trackGroupCode(direct.groupCode);
      const partners = await stockApi.bizPartners();
      expect(partners.some((partner) => partner.id === missingId), `Biz partner id ${missingId} does not exist`).toBe(false);
      await openFilledCreate(form, data);
    });

    await step('Act: Step 1 — Save the physical SKU form with 비즈파트너 (Biz partner) set to Demo Partner A and read the result', async () => {
      attempt1 = await form.attemptSave();
    });

    await step('Assert: Expected 1 — The save goes through', async () => {
      expect(accepted(attempt1), `[Expected 1] The save with Demo Partner A goes through (HTTP ${attempt1?.status ?? 'not sent'} ${message(attempt1)})`).toBe(true);
    });

    await step('Act: Step 2 — Send the same save straight to the server with the biz partner id 999999999999999', async () => {
      const sent = (attempt1?.requestBody ?? {}) as Record<string, unknown>;
      const lines = (sent.skus as Array<Record<string, unknown>> | undefined) ?? [];
      const response = await stockApi.createSku({
        ...sent,
        bizPartnerId: missingId,
        group: { code: direct.groupCode, name: `${world.tag} T124 Demo Physical 930 direct` },
        skus: lines.map((line) => ({ ...line, skuCode: direct.skuCode, barcode: direct.barcode })),
      });
      result = { status: response.status, body: response.body as Record<string, unknown> | null };
    });

    await step('Assert: Expected 2 — The save is turned down', async () => {
      expect(result.status, `[Expected 2] The direct save is turned down (HTTP ${result.status})`).toBeGreaterThanOrEqual(400);
    });

    await step('Act: Step 3 — Read the code and the message that come back', async () => {
      expect(result.body, 'The error response has a body').not.toBeNull();
    });

    await step('Assert: Expected 3 — The code is WH-BIZ_PARTNER_NOT_FOUND and the message names the real id', async () => {
      expect(String(result.body?.code ?? ''), '[Expected 3] The code is WH-BIZ_PARTNER_NOT_FOUND').toBe('WH-BIZ_PARTNER_NOT_FOUND');
      expect(String(result.body?.message ?? result.body?.detail ?? ''), `[Expected 3] The message is 비즈파트너를 찾을 수 없습니다. - id: ${missingId}`).toBe(`비즈파트너를 찾을 수 없습니다. - id: ${missingId}`);
    });

    await step('Act: Step 4 — Check whether a SKU was created', async () => {
      createdId = await groupIdOf(stockApi, direct.groupCode);
    });

    await step('Assert: Expected 4 — No SKU is created', async () => {
      expect(createdId, `[Expected 4] No SKU group ${direct.groupCode} exists after the turned-down call`).toBeNull();
    });
  });

  test('TC_US134_125 — A save is turned down when product code name + space + SKU name pass 150 characters', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormB(page);
    await tcMeta(
      'TC_US134_125',
      'Medium',
      TAGS,
      `On the edit screen of an own 옵션있음 physical SKU group whose product code name is 100 characters: an SKU name of 49 characters (stored 100 + 1 + 49 = 150) saves; 50 characters (stored 151) is turned down with WH-SKU_NAME_TOO_LONG "SKU명은 상품코드명을 포함해 150자 이하로 입력해주세요. - length: 151", although the 50-character SKU name alone is within its own 150-character limit; the stored name stays at 150 characters. ${WORLD_NOTE}`,
    );
    const groupName = `${world.tag} TC125 `.padEnd(100, 'N');
    const name49 = 'Size '.padEnd(49, 'L');
    const name50 = `${name49}X`;
    let sku!: WorldSku;
    let attempt1: SaveAttempt | null = null;
    let attempt2: SaveAttempt | null = null;
    let field4 = '';
    let stored4 = '';

    await step('Arrange: Pre-condition 1–3 — An own product code with a 100-character product code name (옵션있음, 1 SKU line)', async () => {
      [sku] = await world.createPhysicalSku('TC125', { partner: world.partners.A, manufacturer: world.manufacturers.M1, groupName, lines: [{ option: 'A', exportSkuName: TC_DEFAULTS.exportSkuName }] });
      expect(groupName.length, 'The product code name is 100 characters').toBe(100);
    });

    await step('Act: Step 1 — Open the form on that product code, type a 49-character SKU명 (stored 150) and click 저장 (Save)', async () => {
      await form.openEdit('physical', sku.groupId);
      await form.lineInput(0, 'skuName').fill(name49);
      await form.passBarcodeCheck();
      attempt1 = await form.attemptSave();
    });

    await step('Assert: Expected 1 — The save goes through: exactly at the limit is accepted', async () => {
      expect(accepted(attempt1), `[Expected 1] The 150-character stored name saves (HTTP ${attempt1?.status ?? 'not sent'} ${message(attempt1)})`).toBe(true);
    });

    await step('Act: Step 2 — Change the SKU명 (SKU name) to 50 characters (stored 151) and click 저장 (Save)', async () => {
      await form.openEdit('physical', sku.groupId);
      await form.lineInput(0, 'skuName').fill(name50);
      await form.passBarcodeCheck();
      attempt2 = await form.attemptSave();
    });

    await step('Assert: Expected 2 — The save is turned down', async () => {
      expect(blocked(attempt2), `[Expected 2] The 151-character stored name is turned down (HTTP ${attempt2?.status ?? 'not sent'})`).toBe(true);
    });

    await step('Act: Step 3 — Read the code and the message that come back', async () => {
      expect(attempt2?.sent, 'The save reached the server and came back with an answer').toBe(true);
    });

    await step('Assert: Expected 3 — The code is WH-SKU_NAME_TOO_LONG and the message carries length: 151', async () => {
      expect(errorCode(attempt2), '[Expected 3] The code is WH-SKU_NAME_TOO_LONG').toBe('WH-SKU_NAME_TOO_LONG');
      expect(message(attempt2), '[Expected 3] The message is SKU명은 상품코드명을 포함해 150자 이하로 입력해주세요. - length: 151').toBe('SKU명은 상품코드명을 포함해 150자 이하로 입력해주세요. - length: 151');
    });

    await step('Act: Step 4 — Read the SKU명 (SKU name) field and check whether it alone was over any limit', async () => {
      field4 = await form.lineInput(0, 'skuName').inputValue();
      stored4 = (await stockApi.skuGroup(sku.groupId)).body.skus[0]?.skuName ?? '';
    });

    await step('Assert: Expected 4 — The 50-character SKU name alone is within its limit, so the rejection is for the composed name; no 151-character name is stored', async () => {
      expect(field4.length, '[Expected 4] The SKU name field holds the 50 typed characters').toBe(50);
      expect(field4.length, '[Expected 4] The SKU name alone is within its own 150-character limit').toBeLessThanOrEqual(150);
      expect(stored4.length, `[Expected 4] The stored name is not 151 characters (stored "${stored4.slice(0, 30)}…" = ${stored4.length})`).toBe(150);
    });
  });

  test('TC_US134_126 — The short product description is required and takes at most 50 characters', async ({ page, world }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormB(page);
    await tcMeta(
      'TC_US134_126',
      'Medium',
      TAGS,
      `On the physical create form (every other field filled): the 상품 간단 설명 placeholder reads 상품 간단 설명은 영문으로 간단히 기입합니다. (예: CD, clothing, cup 등); with the field empty and both checks passed saving is blocked; the field takes 50 characters and refuses the 51st; CD saves and returns to the list. ${REQUIRED_NOTE} ${WORLD_NOTE}`,
    );
    const data = formData(world, 'T126', { description: '' });
    const value50 = 'Demo short product description filler text 1234567';
    let placeholder: string | null = null;
    let attempt2: SaveAttempt | null = null;
    let value3 = '';
    let attempt4: SaveAttempt | null = null;

    await step('Arrange: Pre-condition 1–3 — Create form open with every other field filled (Demo Partner A, 본품, 옵션없음, …)', async () => {
      await world.trackGroupCode(data.groupCode);
      await form.openCreate('physical');
      await form.fillForm(data);
      await form.descriptionInput.fill('');
    });

    await step('Act: Step 1 — Read the placeholder text in the 상품 간단 설명 (Short product description) field', async () => {
      placeholder = await form.descriptionInput.getAttribute('placeholder');
    });

    await step('Assert: Expected 1 — The placeholder shows 상품 간단 설명은 영문으로 간단히 기입합니다. (예: CD, clothing, cup 등)', async () => {
      expect(placeholder, `[Expected 1] The placeholder is ${t('skuForm.ph.description')}`).toBe(t('skuForm.ph.description'));
    });

    await step('Act: Step 2 — Leave the field empty, press both duplicate-check buttons and try to click 저장 (Save)', async () => {
      await form.passBothChecks();
      attempt2 = await form.attemptSave();
    });

    await step('Assert: Expected 2 — Saving is blocked (disabled 저장, or the required-field message)', async () => {
      await expectRequiredBlock(attempt2, 2, 'the short product description', { error: form.fieldError('skuForm.field.description'), text: t('skuForm.err.description') }, true);
    });

    await step('Act: Step 3 — Type the 50-character value, then try to type 1 more character', async () => {
      await form.descriptionInput.fill(value50);
      await form.descriptionInput.press('End');
      await form.descriptionInput.pressSequentially('8');
      value3 = await form.descriptionInput.inputValue();
    });

    await step('Assert: Expected 3 — The field takes all 50 characters and stops at 50', async () => {
      expect(value3, '[Expected 3] The field holds the full 50-character value and not the 51st character').toBe(value50);
    });

    await step('Act: Step 4 — Replace it with CD and click 저장 (Save)', async () => {
      await form.descriptionInput.fill(TC_DEFAULTS.description);
      attempt4 = await form.attemptSave();
    });

    await step('Assert: Expected 4 — The save goes through and returns to the list', async () => {
      expect(accepted(attempt4), `[Expected 4] The save goes through (HTTP ${attempt4?.status ?? 'not sent'} ${message(attempt4)})`).toBe(true);
      await expect(page, '[Expected 4] The browser returns to the list').toHaveURL(LIST_URL, { timeout: 30_000 });
    });
  });

  test('TC_US134_127 — The supply cost takes whole numbers from 0 up to 99,999,999', async ({ page, world, stockApi, stockListPage: list }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormB(page);
    await tcMeta(
      'TC_US134_127',
      'Medium',
      TAGS,
      `Physical create form, own codes per save: 공급원가 99999999 saves and reads back 99999999; 100000000 is blocked and nothing is created; the field refuses the decimal point of 1000.50; 0 saves; -1 loses its minus sign or is blocked without a record. Observed in the frontend bundle 05/10: the field keeps digits only and cuts the input at 8 digits, so "100000000" becomes 10000000 (a valid value that saves) and "-1" becomes 1. ${WORLD_NOTE}`,
    );
    const dataMax = formData(world, 'T127A', { price: '99999999' });
    const dataOver = formData(world, 'T127B', { price: '100000000' });
    const dataZero = formData(world, 'T127C', { price: '0' });
    const dataMinus = formData(world, 'T127D', { price: '-1' });
    const dataDecimal = formData(world, 'T127E');
    let attempt1: SaveAttempt | null = null;
    let price2 = '';
    let attempt3: SaveAttempt | null = null;
    let created3: number | null = null;
    let value4 = '';
    let attempt5: SaveAttempt | null = null;
    let value6 = '';
    let attempt6: SaveAttempt | null = null;
    let created6: number | null = null;

    await step('Arrange: Pre-condition 1–3 — Create form data: Demo Partner A, 본품, 옵션없음, every other field filled, own unused codes per save', async () => {
      for (const data of [dataMax, dataOver, dataZero, dataMinus, dataDecimal]) await world.trackGroupCode(data.groupCode);
    });

    await step('Act: Step 1 — Type 99999999 into 공급원가 (Supply cost), press both duplicate-check buttons and click 저장 (Save)', async () => {
      await openFilledCreate(form, dataMax);
      attempt1 = await form.attemptSave();
    });

    await step('Assert: Expected 1 — The save goes through and returns to the list', async () => {
      expect(accepted(attempt1), `[Expected 1] 99999999 saves (HTTP ${attempt1?.status ?? 'not sent'} ${message(attempt1)})`).toBe(true);
      await expect(page, '[Expected 1] The browser returns to the list').toHaveURL(LIST_URL, { timeout: 30_000 });
    });

    await step('Act: Step 2 — Go back to the list, open that record again and read 공급원가 (Supply cost)', async () => {
      await form.openEditFromList(list, dataMax.groupCode, dataMax.lines[0].skuCode);
      price2 = await form.priceInput.inputValue();
    });

    await step('Assert: Expected 2 — The field shows 99999999', async () => {
      expect(price2, '[Expected 2] The supply cost reads back 99999999').toBe('99999999');
    });

    await step('Act: Step 3 — Open another create screen, type 100000000 into 공급원가, fill the rest, press both checks and click 저장 (Save)', async () => {
      await openFilledCreate(form, dataOver);
      attempt3 = await form.attemptSave();
      created3 = await groupIdOf(stockApi, dataOver.groupCode);
    });

    await step('Assert: Expected 3 — Saving is blocked and the record is not created', async () => {
      expect(blocked(attempt3), `[Expected 3] Saving 100000000 is blocked (request sent: ${JSON.stringify(attempt3?.requestBody?.price ?? null)})`).toBe(true);
      expect(created3, `[Expected 3] No record ${dataOver.groupCode} is created`).toBeNull();
    });

    await step('Act: Step 4 — Type the decimal value 1000.50 into 공급원가 (Supply cost)', async () => {
      if (!onCreateForm(page)) await openFilledCreate(form, dataDecimal);
      await form.priceInput.fill('');
      await form.priceInput.pressSequentially('1000.50');
      value4 = await form.priceInput.inputValue();
    });

    await step('Assert: Expected 4 — The field does not take the decimal point', async () => {
      expect(value4, `[Expected 4] The supply cost field holds no decimal point (holds "${value4}")`).not.toContain('.');
    });

    await step('Act: Step 5 — Open another create screen, type 0 into 공급원가, fill the rest, press both checks and click 저장 (Save)', async () => {
      await openFilledCreate(form, dataZero);
      attempt5 = await form.attemptSave();
    });

    await step('Assert: Expected 5 — The save goes through: 0 is accepted for a free item', async () => {
      expect(accepted(attempt5), `[Expected 5] Supply cost 0 saves (HTTP ${attempt5?.status ?? 'not sent'} ${message(attempt5)})`).toBe(true);
    });

    await step('Act: Step 6 — Open another create screen, type -1 into 공급원가, fill the rest, press both checks and click 저장 (Save)', async () => {
      await openFilledCreate(form, dataMinus);
      value6 = await form.priceInput.inputValue();
      attempt6 = await form.attemptSave();
      created6 = await groupIdOf(stockApi, dataMinus.groupCode);
    });

    await step('Assert: Expected 6 — The minus sign is not taken, or saving is blocked and the record is not created', async () => {
      const minusRefused = !value6.includes('-');
      const blockedNoRecord = blocked(attempt6) && created6 === null;
      expect(minusRefused || blockedNoRecord, `[Expected 6] The minus sign is refused (field "${value6}") or the save is blocked without a record (created: ${created6 !== null})`).toBe(true);
    });
  });

  test('TC_US134_128 — The weight is required, numeric, shows the unit g and is capped at 10,000,000', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormB(page);
    await tcMeta(
      'TC_US134_128',
      'Medium',
      TAGS,
      `Physical create form: the 중량 label carries the unit text g beside the field; an empty weight with both checks passed is blocked; 10000000 saves and returns to the list; on a new form 10000001 is rejected (nothing saved) and the letters abc are refused. Observed in the frontend bundle 05/10: a value above 10000000 is refused at input (the field keeps its previous value), letters are stripped. ${REQUIRED_NOTE} ${WORLD_NOTE}`,
    );
    const data = formData(world, 'T128A', { weight: '' });
    const dataOver = formData(world, 'T128B', { weight: '' });
    let label1 = '';
    let units1: string[] = [];
    let attempt2: SaveAttempt | null = null;
    let attempt3: SaveAttempt | null = null;
    let kept4 = '';
    let attempt4: SaveAttempt | null = null;
    let created4: number | null = null;
    let letters4 = '';

    await step('Arrange: Pre-condition 1–3 — Create form open with every other field filled (Demo Partner A, 본품, 옵션없음, …)', async () => {
      await world.trackGroupCode(data.groupCode);
      await world.trackGroupCode(dataOver.groupCode);
      await form.openCreate('physical');
      await form.fillForm(data);
    });

    await step('Act: Step 1 — Read the label and the text printed just to the right of the 중량 (Weight) field', async () => {
      label1 = ((await form.label('skuForm.field.weight').textContent()) ?? '').replace(/\*$/, '').trim();
      units1 = (await form.unitTexts(form.field('skuForm.field.weight')).allTextContents()).map((text) => text.trim());
    });

    await step('Assert: Expected 1 — The label shows 중량 (Weight) and the unit g is printed beside the field as text', async () => {
      expect(label1, `[Expected 1] The label is ${t('skuForm.field.weight')}`).toBe(t('skuForm.field.weight'));
      expect(units1, '[Expected 1] The unit text g is printed beside the weight field').toEqual(['g']);
    });

    await step('Act: Step 2 — Leave 중량 (Weight) empty, press both duplicate-check buttons and try to click 저장 (Save)', async () => {
      await form.passBothChecks();
      attempt2 = await form.attemptSave();
    });

    await step('Assert: Expected 2 — Saving is blocked (disabled 저장, or the required-field message)', async () => {
      await expectRequiredBlock(attempt2, 2, 'the weight', { error: form.fieldError('skuForm.field.weight'), text: t('skuForm.err.weight') }, true);
    });

    await step('Act: Step 3 — Type 10000000 into 중량 (Weight), fill the rest and click 저장 (Save)', async () => {
      await form.weightInput.fill('10000000');
      attempt3 = await form.attemptSave();
    });

    await step('Assert: Expected 3 — The save goes through and returns to the list', async () => {
      expect(accepted(attempt3), `[Expected 3] Weight 10000000 saves (HTTP ${attempt3?.status ?? 'not sent'} ${message(attempt3)})`).toBe(true);
      await expect(page, '[Expected 3] The browser returns to the list').toHaveURL(LIST_URL, { timeout: 30_000 });
    });

    await step('Act: Step 4 — Open another create screen, type 10000001 into 중량 (Weight), then try typing abc', async () => {
      await openFilledCreate(form, dataOver);
      await form.weightInput.fill('10000001');
      kept4 = await form.weightInput.inputValue();
      attempt4 = await form.attemptSave();
      created4 = await groupIdOf(stockApi, dataOver.groupCode);
      if (onCreateForm(page)) {
        await form.weightInput.fill('');
        await form.weightInput.pressSequentially('abc');
        letters4 = await form.weightInput.inputValue();
      }
    });

    await step('Assert: Expected 4 — 10000001 is rejected when saved and the field does not take the letters abc', async () => {
      expect(blocked(attempt4), `[Expected 4] Saving weight 10000001 is rejected (field held "${kept4}")`).toBe(true);
      expect(created4, `[Expected 4] No record ${dataOver.groupCode} is created`).toBeNull();
      expect(letters4, '[Expected 4] The weight field does not take the letters abc').not.toMatch(/[a-z]/i);
    });
  });

  test('TC_US134_129 — The three volume fields are required, show mm each and refuse a value above the maximum', async ({ page, world }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormB(page);
    await tcMeta(
      'TC_US134_129',
      'Medium',
      TAGS,
      `Physical create form: the 부피 block has 3 inputs (가로 / 세로 / 높이) each with its own mm unit text; all 3 empty with both checks passed → blocked with the 3 messages 가로를 입력해주세요 / 세로를 입력해주세요 / 높이를 입력해주세요 (where messages are shown); only 가로 filled → blocked with only the 세로 and 높이 messages; 100 / 80 / 30 saves; on a new form 10000001 in 가로 is refused. Observed in the frontend bundle 05/10: the block renders ONE message line (the first missing of width → depth → height). ${REQUIRED_NOTE} ${WORLD_NOTE}`,
    );
    const data = formData(world, 'T129A', { volume: ['', '', ''] });
    const dataNew = formData(world, 'T129B', { volume: ['', '80', '30'] });
    const volumeField = form.field('skuForm.field.volume');
    const volumeMessage = (key: 'skuForm.err.width' | 'skuForm.err.depth' | 'skuForm.err.height') => volumeField.getByText(t(key), { exact: true });
    let label1 = '';
    let inputs1 = 0;
    let units1: string[] = [];
    let attempt2: SaveAttempt | null = null;
    let attempt3: SaveAttempt | null = null;
    let attempt4: SaveAttempt | null = null;
    let width4 = '';

    await step('Arrange: Pre-condition 1–3 — Create form open with every other field filled (Demo Partner A, 본품, 옵션없음, …)', async () => {
      await world.trackGroupCode(data.groupCode);
      await world.trackGroupCode(dataNew.groupCode);
      await form.openCreate('physical');
      await form.fillForm(data);
    });

    await step('Act: Step 1 — Read the label and count the input fields and the unit texts in the 부피 (Volume) block', async () => {
      label1 = ((await form.label('skuForm.field.volume').textContent()) ?? '').replace(/\*$/, '').trim();
      inputs1 = await form.volumeGroup.locator('input').count();
      units1 = (await form.unitTexts(form.volumeGroup).allTextContents()).map((text) => text.trim());
    });

    await step('Assert: Expected 1 — The label shows 부피 (Volume) with 3 fields for width, depth and height, each with its own mm unit text', async () => {
      expect(label1, `[Expected 1] The label is ${t('skuForm.field.volume')}`).toBe(t('skuForm.field.volume'));
      expect(inputs1, '[Expected 1] The volume block has 3 input fields').toBe(3);
      await expect(form.widthInput, `[Expected 1] The width field (${t('skuForm.ph.width')}) is shown`).toBeVisible();
      await expect(form.depthInput, `[Expected 1] The depth field (${t('skuForm.ph.depth')}) is shown`).toBeVisible();
      await expect(form.heightInput, `[Expected 1] The height field (${t('skuForm.ph.height')}) is shown`).toBeVisible();
      expect(units1, '[Expected 1] Each of the 3 fields has its own mm unit text').toEqual(['mm', 'mm', 'mm']);
    });

    await step('Act: Step 2 — Leave all 3 fields empty, press both duplicate-check buttons and try to click 저장 (Save)', async () => {
      await form.passBothChecks();
      attempt2 = await form.attemptSave();
    });

    await step('Assert: Expected 2 — Saving is blocked; where messages are shown, 가로 / 세로 / 높이를 입력해주세요 appear', async () => {
      expect(blocked(attempt2), '[Expected 2] Saving is blocked while the 3 volume fields are empty').toBe(true);
      if (!attempt2?.disabled) {
        await expect(volumeMessage('skuForm.err.width'), `[Expected 2] ${t('skuForm.err.width')} is shown`).toBeVisible();
        await expect(volumeMessage('skuForm.err.depth'), `[Expected 2] ${t('skuForm.err.depth')} is shown`).toBeVisible();
        await expect(volumeMessage('skuForm.err.height'), `[Expected 2] ${t('skuForm.err.height')} is shown`).toBeVisible();
      }
    });

    await step('Act: Step 3 — Type 100 into the first field only, leave the other 2 empty, and try to click 저장 (Save)', async () => {
      await form.widthInput.fill('100');
      attempt3 = await form.attemptSave();
    });

    await step('Assert: Expected 3 — Saving is blocked; where messages are shown, only the depth and height messages appear', async () => {
      expect(blocked(attempt3), '[Expected 3] Saving is blocked while depth and height are empty').toBe(true);
      if (!attempt3?.disabled) {
        await expect(volumeMessage('skuForm.err.width'), `[Expected 3] ${t('skuForm.err.width')} is no longer shown`).toHaveCount(0);
        await expect(volumeMessage('skuForm.err.depth'), `[Expected 3] ${t('skuForm.err.depth')} is shown`).toBeVisible();
        await expect(volumeMessage('skuForm.err.height'), `[Expected 3] ${t('skuForm.err.height')} is shown`).toBeVisible();
      }
    });

    await step('Act: Step 4 — Fill all 3 with 100, 80 and 30 and click 저장 (Save), then open a new screen and type 10000001 into the first field', async () => {
      await form.widthInput.fill('100');
      await form.depthInput.fill('80');
      await form.heightInput.fill('30');
      attempt4 = await form.attemptSave();
      await form.openCreate('physical');
      await form.fillForm(dataNew);
      await form.widthInput.fill('10000001');
      width4 = await form.widthInput.inputValue();
    });

    await step('Assert: Expected 4 — The save goes through, and on the new screen 10000001 is rejected', async () => {
      expect(accepted(attempt4), `[Expected 4] Volume 100 / 80 / 30 saves (HTTP ${attempt4?.status ?? 'not sent'} ${message(attempt4)})`).toBe(true);
      expect(width4, '[Expected 4] The width field does not take 10000001').not.toBe('10000001');
    });
  });

  test('TC_US134_130 — Each required field shows its own message when it is cleared and 저장 is pressed', async ({ page, world }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormB(page);
    await tcMeta(
      'TC_US134_130',
      'Medium',
      TAGS,
      `Physical create form with every field filled and both duplicate checks passed; one field cleared per round: 비즈파트너 → 비즈파트너를 선택해주세요, 상품코드명 → 상품코드명을 입력해주세요, 제조사 → 제조사를 선택해주세요, 원산지 → 원산지를 선택해주세요 — each save blocked. Observed 05/10: the 원산지 react-select has no clear control (not clearable by keyboard either); when the chosen country cannot be cleared the round runs on a fresh form where 원산지 was never chosen (same data, both checks passed again). ${REQUIRED_NOTE} ${WORLD_NOTE}`,
    );
    const data = formData(world, 'T130');
    const attempts: Array<SaveAttempt | null> = [null, null, null, null];
    let countryCleared = false;

    await step('Arrange: Pre-condition 1–3 — Create form open with every field filled (Demo Partner A, 본품, 옵션없음, …) and both duplicate checks passed', async () => {
      await world.trackGroupCode(data.groupCode);
      await openFilledCreate(form, data);
    });

    await step('Act: Step 1 — Clear 비즈파트너 (Biz partner) and try to click 저장 (Save)', async () => {
      await form.clearPartner();
      attempts[0] = await form.attemptSave();
    });

    await step('Assert: Expected 1 — Saving is blocked (disabled 저장, or 비즈파트너를 선택해주세요)', async () => {
      await expectRequiredBlock(attempts[0], 1, 'the biz partner', { error: form.fieldError('skuForm.field.bizPartner'), text: t('skuForm.err.bizPartner') }, false);
    });

    await step('Act: Step 2 — Fill the biz partner again, clear 상품코드명 (Product code name) and try to click 저장 (Save)', async () => {
      await form.choosePartnerAndWaitManufacturers(world.partners.A.id);
      await form.chooseManufacturerId(world.manufacturers.M1.id);
      await form.skuGroupCodeNameInput.fill('');
      attempts[1] = await form.attemptSave();
    });

    await step('Assert: Expected 2 — Saving is blocked (disabled 저장, or 상품코드명을 입력해주세요)', async () => {
      await expectRequiredBlock(attempts[1], 2, 'the product code name', { error: form.fieldError('skuForm.field.skuGroupCodeName'), text: t('skuForm.err.skuGroupCodeName') }, false);
    });

    await step('Act: Step 3 — Fill the product code name again, clear 제조사 (Manufacturer) and try to click 저장 (Save)', async () => {
      await form.skuGroupCodeNameInput.fill(data.groupName);
      await form.clearManufacturer();
      attempts[2] = await form.attemptSave();
    });

    await step('Assert: Expected 3 — Saving is blocked (disabled 저장, or 제조사를 선택해주세요)', async () => {
      await expectRequiredBlock(attempts[2], 3, 'the manufacturer', { error: form.fieldError('skuForm.field.manufacturer'), text: t('skuForm.err.manufacturer') }, false);
    });

    await step('Act: Step 4 — Fill the manufacturer again, clear 원산지 (Country of origin) and try to click 저장 (Save)', async () => {
      await form.chooseManufacturerId(world.manufacturers.M1.id);
      await form.tryClearCountry();
      countryCleared = (await form.countryValue.count()) === 0;
      if (!countryCleared) await openFilledCreate(form, { ...data, country: '' });
      attempts[3] = await form.attemptSave();
    });

    await step('Assert: Expected 4 — Saving is blocked (disabled 저장, or 원산지를 선택해주세요)', async () => {
      await expectRequiredBlock(attempts[3], 4, `the country of origin (${countryCleared ? 'cleared' : 'never chosen — the chosen value cannot be cleared'})`, { error: form.fieldError('skuForm.field.countryOfOrigin'), text: t('skuForm.err.countryOfOrigin') }, false);
    });
  });

  test('TC_US134_131 — The manufacturer dropdown lists the partner manufacturers in name order and blocks saving when none is chosen', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormB(page);
    await tcMeta(
      'TC_US134_131',
      'Medium',
      TAGS,
      `Scenario A: a real dev biz partner without manufacturers gets 2 own manufacturers "Demo Manufacturer 2" then "Demo Manufacturer 1" (DB, inserted in that order so an id order differs from the name order); its 제조사 dropdown offers exactly Demo Manufacturer 1, Demo Manufacturer 2 in ascending name order, and no 제조사 추가 / 제조사 생성 action exists. Scenario B: another partner without manufacturers — the dropdown holds only the placeholder 제조사를 선택해주세요; with every other field filled and both duplicate checks passed, saving is blocked. The native <select> list is read through its options (the OS drop-down itself is not captured). ${REQUIRED_NOTE} ${WORLD_NOTE}`,
    );
    let partnerA!: WorldPartner;
    let partnerEmpty!: WorldPartner;
    let maker1!: WorldManufacturer;
    let maker2!: WorldManufacturer;
    let options3: string[] = [];
    let actions4 = 0;
    let options6: string[] = [];
    let attempt10: SaveAttempt | null = null;
    const data = formData(world, 'T131', { partnerId: null, manufacturerId: null });

    await step('Arrange: Pre-condition 1–4 — Scenario A partner with Demo Manufacturer 1 / 2, scenario B partner with no manufacturer, other field values ready', async () => {
      [partnerA, partnerEmpty] = await findPartnersWithoutManufacturer(stockApi, 2, [world.partners.A.id, world.partners.B.id]);
      maker2 = await world.createManufacturer(partnerA, 'Demo Manufacturer 2');
      maker1 = await world.createManufacturer(partnerA, 'Demo Manufacturer 1');
      await world.trackGroupCode(data.groupCode);
    });

    await step('Act: Step 1 — Open 현물 SKU 생성 (Create Physical SKU)', async () => {
      await form.openCreate('physical');
    });

    await step('Assert: Expected 1 — The 현물 SKU 생성 screen opens', async () => {
      await expect(form.cardTitle, `[Expected 1] The card title is ${t('skuForm.title.physical')}`).toHaveText(t('skuForm.title.physical'));
      await expect(form.modeBadge, `[Expected 1] The mode badge is ${t('skuForm.mode.create')}`).toHaveText(t('skuForm.mode.create'));
    });

    await step('Act: Step 2 — Open the 제조사 (Manufacturer) dropdown (scenario A biz partner chosen)', async () => {
      await form.choosePartnerAndWaitManufacturers(partnerA.id);
      await expect(form.manufacturerSelect.locator('option'), 'The manufacturer list of the scenario A partner is rendered').toHaveCount(3);
      await form.manufacturerSelect.focus();
    });

    await step('Assert: Expected 2 — The 제조사 dropdown opens', async () => {
      await expect(form.manufacturerSelect, '[Expected 2] The manufacturer dropdown is shown').toBeVisible();
      await expect(form.manufacturerSelect, '[Expected 2] The manufacturer dropdown can be used').toBeEnabled();
    });

    await step('Act: Step 3 — Verify the available manufacturer options', async () => {
      options3 = await form.manufacturerOptionTexts();
    });

    await step('Assert: Expected 3 — The dropdown shows Demo Manufacturer 1 and Demo Manufacturer 2 in ascending name order', async () => {
      expect(options3.length, `[Expected 3] Exactly 2 manufacturers are offered (${options3.join(' | ')})`).toBe(2);
      expect(options3[0]?.startsWith(maker1.name), `[Expected 3] Demo Manufacturer 1 is offered first (${options3[0]})`).toBe(true);
      expect(options3[1]?.startsWith(maker2.name), `[Expected 3] Demo Manufacturer 2 is offered second (${options3[1]})`).toBe(true);
    });

    await step('Act: Step 4 — Check whether the screen provides any 제조사 추가 (Add) or 제조사 생성 (Create manufacturer) action', async () => {
      actions4 = await form.addManufacturerActions.count();
    });

    await step('Assert: Expected 4 — No 제조사 추가 or 제조사 생성 action is displayed', async () => {
      expect(actions4, '[Expected 4] No add / create manufacturer action is on the screen').toBe(0);
    });

    await step('Act: Step 5 — Re-open 현물 SKU 생성 when no manufacturer data exists (scenario B biz partner)', async () => {
      await form.openCreate('physical');
      await form.choosePartnerAndWaitManufacturers(partnerEmpty.id);
    });

    await step('Assert: Expected 5 — The screen opens with an empty manufacturer source', async () => {
      await expect(form.cardTitle, `[Expected 5] The card title is ${t('skuForm.title.physical')}`).toHaveText(t('skuForm.title.physical'));
      await expect(form.bizPartnerSelect, '[Expected 5] The scenario B biz partner (no manufacturer) is chosen').toHaveValue(String(partnerEmpty.id));
    });

    await step('Act: Step 6 — Open the 제조사 (Manufacturer) dropdown again', async () => {
      await form.manufacturerSelect.focus();
      options6 = await form.optionTexts(form.manufacturerSelect);
    });

    await step('Assert: Expected 6 — The dropdown has no selectable manufacturer and shows only the placeholder 제조사를 선택해주세요', async () => {
      expect(options6, `[Expected 6] Only the placeholder ${t('skuForm.ph.manufacturer')} is listed`).toEqual([t('skuForm.ph.manufacturer')]);
    });

    await step('Act: Step 7 — Complete all remaining required fields', async () => {
      await form.fillForm(data);
    });

    await step('Assert: Expected 7 — All required fields other than 제조사 are completed', async () => {
      await expect(form.skuGroupCodeInput, '[Expected 7] The product code is filled').toHaveValue(data.groupCode);
      await expect(form.skuGroupCodeNameInput, '[Expected 7] The product code name is filled').toHaveValue(data.groupName);
      await expect(form.usageRadio('MAIN'), '[Expected 7] SKU 종류 본품 is chosen').toBeChecked();
      await expect(form.priceInput, '[Expected 7] The supply cost is filled').toHaveValue(TC_DEFAULTS.price);
      await expect(form.lineInput(0, 'skuCode'), '[Expected 7] The SKU code is filled').toHaveValue(data.lines[0].skuCode);
      await expect(form.lineInput(0, 'exportSkuName'), '[Expected 7] The export SKU name is filled').toHaveValue(TC_DEFAULTS.exportSkuName);
      await expect(form.lineInput(0, 'barcode'), '[Expected 7] The barcode is filled').toHaveValue(data.lines[0].barcode);
      await expect(form.weightInput, '[Expected 7] The weight is filled').toHaveValue(TC_DEFAULTS.weight);
      await expect(form.widthInput, '[Expected 7] The width is filled').toHaveValue(TC_DEFAULTS.volume[0]);
      await expect(form.depthInput, '[Expected 7] The depth is filled').toHaveValue(TC_DEFAULTS.volume[1]);
      await expect(form.heightInput, '[Expected 7] The height is filled').toHaveValue(TC_DEFAULTS.volume[2]);
      await expect(form.hsCodeInput, '[Expected 7] The HS code is filled').toHaveValue(TC_DEFAULTS.hsCode);
      await expect(form.descriptionInput, '[Expected 7] The short description is filled').toHaveValue(TC_DEFAULTS.description);
      await expect(form.countryValue, '[Expected 7] The country of origin is 대한민국 (Korea)').toContainText('(KR)');
    });

    await step('Act: Step 8 — Complete 상품코드 중복확인 (Product code duplicate check)', async () => {
      await form.checkCode();
    });

    await step('Assert: Expected 8 — The product code duplicate check passes', async () => {
      await expect(form.skuGroupCodeInput, '[Expected 8] The product code is locked once the check passes').toHaveAttribute('readonly', '', { timeout: 15_000 });
    });

    await step('Act: Step 9 — Complete 바코드 중복확인 (Barcode duplicate check)', async () => {
      await form.checkBarcode();
    });

    await step('Assert: Expected 9 — The barcode duplicate check passes', async () => {
      await expect(form.useOtherBarcodeButton, `[Expected 9] The barcode check turns into ${t('skuForm.btn.useOtherBarcode')}`).toBeVisible({ timeout: 15_000 });
    });

    await step('Act: Step 10 — Try to click 저장 (Save) without selecting a manufacturer', async () => {
      attempt10 = await form.attemptSave();
    });

    await step('Assert: Expected 10 — Saving is blocked (disabled 저장, or 제조사를 선택해주세요)', async () => {
      await expectRequiredBlock(attempt10, 10, 'the manufacturer', { error: form.fieldError('skuForm.field.manufacturer'), text: t('skuForm.err.manufacturer') }, false);
    });
  });

  test('TC_US134_132 — The manufacturer list follows the chosen biz partner and sorts without regard to letter case', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormB(page);
    await tcMeta(
      'TC_US134_132',
      'Medium',
      TAGS,
      `Two real dev biz partners without manufacturers play Demo Partner A / B; own manufacturers (DB) "Zenith" then "apex" for A and "Demo Manufacturer 3" for B (names carry the run tag as a common prefix). With A chosen only apex and Zenith are offered, apex first (a case-sensitive sort would put Zenith first), each label carrying the business-registration number in brackets; with B chosen only Demo Manufacturer 3 is offered. The label format (name + "(registration no.)") is the frontend's — the TC marks it NEEDS CLARIFICATION. ${WORLD_NOTE}`,
    );
    let partnerA!: WorldPartner;
    let partnerB!: WorldPartner;
    let apex!: WorldManufacturer;
    let zenith!: WorldManufacturer;
    let maker3!: WorldManufacturer;
    let options1: string[] = [];
    let options2: string[] = [];
    const carriesRegistration = (label: string | undefined, maker: WorldManufacturer) => !!label && label.startsWith(`${maker.name} (`) && /\(\s*[^()]+\s*\)$/.test(label);

    await step('Arrange: Pre-condition 1–2 — Fixture manufacturers apex and Zenith belong to Demo Partner A; Demo Manufacturer 3 to Demo Partner B', async () => {
      [partnerA, partnerB] = await findPartnersWithoutManufacturer(stockApi, 2, [world.partners.A.id, world.partners.B.id]);
      zenith = await world.createManufacturer(partnerA, 'Zenith');
      apex = await world.createManufacturer(partnerA, 'apex');
      maker3 = await world.createManufacturer(partnerB, 'Demo Manufacturer 3');
    });

    await step('Act: Step 1 — Open 현물 SKU 생성, set 비즈파트너 to Demo Partner A and open 제조사 (Manufacturer)', async () => {
      await form.openCreate('physical');
      await form.choosePartnerAndWaitManufacturers(partnerA.id);
      await expect(form.manufacturerSelect.locator(`option[value="${apex.id}"]`), 'The manufacturers of Demo Partner A are rendered').toHaveCount(1);
      await form.manufacturerSelect.focus();
      options1 = await form.manufacturerOptionTexts();
    });

    await step('Assert: Expected 1 — Only apex and Zenith are offered, apex first, each label with the business-registration number', async () => {
      expect(options1.length, `[Expected 1] Only 2 manufacturers are offered (${options1.join(' | ')})`).toBe(2);
      expect(options1[0]?.startsWith(apex.name), `[Expected 1] apex is offered first (${options1[0]})`).toBe(true);
      expect(options1[1]?.startsWith(zenith.name), `[Expected 1] Zenith is offered second (${options1[1]})`).toBe(true);
      expect(carriesRegistration(options1[0], apex), `[Expected 1] The apex label carries the business-registration number (${options1[0]})`).toBe(true);
      expect(carriesRegistration(options1[1], zenith), `[Expected 1] The Zenith label carries the business-registration number (${options1[1]})`).toBe(true);
    });

    await step('Act: Step 2 — Change 비즈파트너 to Demo Partner B and open 제조사 (Manufacturer) again', async () => {
      await form.choosePartnerAndWaitManufacturers(partnerB.id);
      await expect(form.manufacturerSelect.locator(`option[value="${maker3.id}"]`), 'The manufacturers of Demo Partner B are rendered').toHaveCount(1);
      await form.manufacturerSelect.focus();
      options2 = await form.manufacturerOptionTexts();
    });

    await step('Assert: Expected 2 — Only Demo Manufacturer 3 is offered', async () => {
      expect(options2.length, `[Expected 2] Only 1 manufacturer is offered (${options2.join(' | ')})`).toBe(1);
      expect(options2[0]?.startsWith(maker3.name), `[Expected 2] Demo Manufacturer 3 is the one offered (${options2[0]})`).toBe(true);
    });
  });

  test('TC_US134_133 — Saving is rejected with WH-MANUFACTURER_NOT_FOUND when the chosen manufacturer is deleted after the form loaded', async ({ page, world }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormB(page);
    await tcMeta(
      'TC_US134_133',
      'Medium',
      TAGS,
      `An own manufacturer "Demo Manufacturer 2" of Demo Partner A (DB) is chosen on the filled physical create form, then deleted in the DB while the form stays open (the Partner System has no delete screen here — the DB delete plays it); the form keeps showing it; 저장 after both duplicate checks is rejected with WH-MANUFACTURER_NOT_FOUND "제조사를 찾을 수 없습니다. - id: {id}" with the real id, shown in the page error, and the form stays open. Not automated: whether the entered values are kept (NEEDS CLARIFICATION in the TC). ${WORLD_NOTE}`,
    );
    let maker!: WorldManufacturer;
    let data!: PhysicalFormData;
    let remaining = -1;
    let attempt3: SaveAttempt | null = null;
    const expectedMessage = () => `제조사를 찾을 수 없습니다. - id: ${maker.id}`;

    await step('Arrange: Pre-condition 1–4 — 현물 SKU 생성 open; Demo Manufacturer 2 exists for Demo Partner A; other field values ready', async () => {
      maker = await world.createManufacturer(world.partners.A, 'Demo Manufacturer 2');
      data = formData(world, 'T133', { manufacturerId: maker.id });
      await world.trackGroupCode(data.groupCode);
      await form.openCreate('physical');
    });

    await step('Act: Step 1 — Complete all required fields and select Demo Manufacturer 2 from 제조사 (Manufacturer)', async () => {
      await form.fillForm(data);
    });

    await step('Assert: Expected 1 — The form accepts all values and shows Demo Manufacturer 2 as the selected manufacturer', async () => {
      await expect(form.skuGroupCodeInput, '[Expected 1] The product code is filled').toHaveValue(data.groupCode);
      await expect(form.skuGroupCodeNameInput, '[Expected 1] The product code name is filled').toHaveValue(data.groupName);
      await expect(form.manufacturerSelect, '[Expected 1] Demo Manufacturer 2 is the selected manufacturer').toHaveValue(String(maker.id));
      await expect(form.selectedManufacturer, `[Expected 1] The manufacturer field shows ${maker.name}`).toContainText(maker.name);
    });

    await step('Act: Step 2 — While the form stays open, delete Demo Manufacturer 2 (DB delete playing the Partner System)', async () => {
      await stockDb.deleteManufacturer(maker.id);
      remaining = (await stockDb.query('SELECT id FROM manufacturer WHERE id = ?', [maker.id])).length;
    });

    await step('Assert: Expected 2 — The form remains open and still shows Demo Manufacturer 2', async () => {
      expect(remaining, 'Demo Manufacturer 2 is gone from the manufacturer table').toBe(0);
      await expect(page, '[Expected 2] The create form stays open').toHaveURL(/\/physical\/create/);
      await expect(form.selectedManufacturer, `[Expected 2] The manufacturer field still shows ${maker.name}`).toContainText(maker.name);
    });

    await step('Act: Step 3 — Complete both duplicate checks, then click 저장 (Save)', async () => {
      await form.passBothChecks();
      attempt3 = await form.attemptSave();
    });

    await step('Assert: Expected 3 — The save is rejected with WH-MANUFACTURER_NOT_FOUND: 제조사를 찾을 수 없습니다. - id: {id}', async () => {
      expect(blocked(attempt3), `[Expected 3] The save is rejected (HTTP ${attempt3?.status ?? 'not sent'})`).toBe(true);
      expect(errorCode(attempt3), '[Expected 3] The code is WH-MANUFACTURER_NOT_FOUND').toBe('WH-MANUFACTURER_NOT_FOUND');
      expect(message(attempt3), `[Expected 3] The message is ${expectedMessage()}`).toBe(expectedMessage());
      await expect(form.pageAlert, `[Expected 3] The screen displays ${expectedMessage()}`).toContainText(expectedMessage());
    });

    await step('Act: Step 4 — Check the form after the save is rejected', async () => {
      await expect(form.card, 'The form card is still rendered').toBeVisible();
    });

    await step('Assert: Expected 4 — The form stays open', async () => {
      await expect(page, '[Expected 4] The browser is still on the create form').toHaveURL(/\/physical\/create/);
      await expect(form.cardTitle, `[Expected 4] The form ${t('skuForm.title.physical')} stays open`).toHaveText(t('skuForm.title.physical'));
    });
  });

  test('TC_US134_134 — A SKU group deleted while its edit form is open can be neither saved nor reopened', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormB(page);
    await tcMeta(
      'TC_US134_134',
      'Medium',
      TAGS,
      `An own physical SKU group (playing DEMO-PC-001) opened from 재고 관리 is soft-deleted in sku_group (DB fixture, as the TC prescribes) while the edit form stays open: the form does not change; 저장 after a product-code-name change and the barcode check is rejected with WH-SKU_GROUP_NOT_FOUND "SKU 그룹을 찾을 수 없습니다. - id: {id}"; the browser goes back to the stock list; the same edit address loaded in a new tab does not open the form and shows the same message. Observed in the frontend bundle 05/10: a rejected save keeps the form open with the page error (no redirect); a failed load toasts the error and redirects to the list. ${WORLD_NOTE}`,
    );
    let sku!: WorldSku;
    let editUrl = '';
    let deletedAt: unknown = null;
    let attempt3: SaveAttempt | null = null;
    let tabUrl = '';
    let tabToast = false;
    const expectedMessage = () => `SKU 그룹을 찾을 수 없습니다. - id: ${sku.groupId}`;

    await step('Arrange: Pre-condition 1–3 — Logged in with write access; an own physical SKU group that opens in edit mode', async () => {
      [sku] = await world.createPhysicalSku('TC134', { partner: world.partners.A, manufacturer: world.manufacturers.M1, groupName: `${world.tag} TC134 Demo Album` });
    });

    await step('Act: Step 1 — Open 재고 관리 and click the 상품코드 (Product code) link on the SKU row to open the edit screen', async () => {
      await form.openEditFromList(list, sku.groupCode, sku.skuCode);
      editUrl = page.url();
    });

    await step('Assert: Expected 1 — The edit screen opens', async () => {
      await expect(form.modeBadge, `[Expected 1] The mode badge is ${t('skuForm.mode.edit')}`).toHaveText(t('skuForm.mode.edit'));
      await expect(form.skuGroupCodeInput, `[Expected 1] The form shows product code ${sku.groupCode}`).toHaveValue(sku.groupCode);
    });

    await step('Act: Step 2 — Soft-delete the SKU group in the database while this form stays open', async () => {
      await stockDb.softDeleteSkuGroup(sku.groupId);
      deletedAt = (await stockDb.skuGroup(sku.groupId))?.deleted_at ?? null;
    });

    await step('Assert: Expected 2 — Nothing on the form changes', async () => {
      expect(deletedAt, 'The SKU group now carries deleted_at').not.toBeNull();
      await expect(page, '[Expected 2] The edit address is unchanged').toHaveURL(editUrl);
      await expect(form.skuGroupCodeNameInput, '[Expected 2] The product code name still shows the saved value').toHaveValue(sku.groupName);
      await expect(form.skuGroupCodeInput, '[Expected 2] The product code still shows the saved value').toHaveValue(sku.groupCode);
    });

    await step('Act: Step 3 — Change 상품코드명, click 바코드 중복확인 (Barcode duplicate check) and then 저장 (Save)', async () => {
      await form.skuGroupCodeNameInput.fill(`${sku.groupName} rev`);
      await form.passBarcodeCheck();
      attempt3 = await form.attemptSave();
    });

    await step('Assert: Expected 3 — The save is rejected with WH-SKU_GROUP_NOT_FOUND: SKU 그룹을 찾을 수 없습니다. - id: {id}', async () => {
      expect(blocked(attempt3), `[Expected 3] The save is rejected (HTTP ${attempt3?.status ?? 'not sent'})`).toBe(true);
      expect(errorCode(attempt3), '[Expected 3] The code is WH-SKU_GROUP_NOT_FOUND').toBe('WH-SKU_GROUP_NOT_FOUND');
      expect(message(attempt3), `[Expected 3] The message is ${expectedMessage()}`).toBe(expectedMessage());
      await expect(form.pageAlert, `[Expected 3] The screen displays ${expectedMessage()}`).toContainText(expectedMessage());
    });

    await step('Act: Step 4 — See where the browser ends up', async () => {
      await page.waitForURL(STOCK_LIST_URL, { timeout: 15_000 }).catch(() => undefined);
    });

    await step('Assert: Expected 4 — The browser goes back to the stock list', async () => {
      await expect(page, '[Expected 4] The browser is on the stock list').toHaveURL(STOCK_LIST_URL);
    });

    await step('Act: Step 5 — Copy the same edit address into a new tab and load it', async () => {
      const tab = await page.context().newPage();
      try {
        const tabForm = new PhysicalSkuFormB(tab);
        await tab.setViewportSize({ width: 1920, height: 1080 });
        await tab.goto(editUrl);
        tabToast = await tabForm.toast(expectedMessage()).first().waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false);
        await tab.waitForURL(LIST_URL, { timeout: 30_000 }).catch(() => undefined);
        tabUrl = tab.url();
        await test.info().attach('New tab after loading the edit address', { body: await tab.screenshot({ fullPage: true }), contentType: 'image/png' });
      } finally {
        await tab.close();
      }
    });

    await step('Assert: Expected 5 — The form does not open and shows the same rejection message', async () => {
      expect(tabUrl, '[Expected 5] The new tab does not stay on the edit form').not.toContain('/physical/edit');
      expect(tabToast, `[Expected 5] The new tab shows ${expectedMessage()}`).toBe(true);
    });
  });

  test('TC_US134_135 — 목록으로 leaves at once when nothing is typed, and confirms before discarding typed input', async ({ page, world, stockApi, stockListPage: list }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormB(page);
    await tcMeta(
      'TC_US134_135',
      'Medium',
      TAGS,
      `Physical create form: 목록으로 with nothing typed goes to the list with no dialog; after typing the product code name "<tag> T135 Demo Test Product" 목록으로 opens the confirm 작성된 항목을 등록하지 않고, 목록으로 이동할까요?; 취소 keeps the form and the typed name; 목록으로 again + confirm discards it — the list opens and no record with that name exists (checked on 재고 관리 by 상품코드명 and through the SKU API). ${WORLD_NOTE}`,
    );
    const name = `${world.tag} T135 Demo Test Product`;
    let dialog1 = -1;
    let dialogText3 = '';
    let rows4 = -1;
    let url4 = '';

    await step('Arrange: Pre-condition 1–3 — 현물 SKU 생성 open in create mode with nothing typed', async () => {
      await form.openCreate('physical');
    });

    await step('Act: Step 1 — Click 목록으로 (Back to list) with nothing typed', async () => {
      await form.click(form.backButton, `${t('skuForm.btn.backToList')} button`);
      await page.waitForURL(LIST_URL, { timeout: 30_000 });
      dialog1 = await form.leaveConfirm.count();
    });

    await step('Assert: Expected 1 — The form closes and the list opens, with no dialog', async () => {
      await expect(page, '[Expected 1] The list opens').toHaveURL(LIST_URL);
      expect(dialog1, '[Expected 1] No confirm dialog was shown').toBe(0);
    });

    await step('Act: Step 2 — Open the form again, type Demo Test Product into 상품코드명 and click 목록으로', async () => {
      await form.openCreate('physical');
      await form.skuGroupCodeNameInput.fill(name);
      await form.click(form.backButton, `${t('skuForm.btn.backToList')} button`);
    });

    await step('Assert: Expected 2 — A confirm dialog opens', async () => {
      await expect(form.leaveConfirm, '[Expected 2] The leave confirm dialog opens').toBeVisible();
    });

    await step('Act: Step 3 — Read the dialog, then choose the option that cancels leaving', async () => {
      dialogText3 = (await form.leaveConfirm.innerText()).trim();
      await form.click(form.leaveCancelButton, `${t('btn.cancel')} button of the confirm`);
    });

    await step('Assert: Expected 3 — The dialog shows 작성된 항목을 등록하지 않고, 목록으로 이동할까요? and the form stays open with the typed name', async () => {
      expect(dialogText3, `[Expected 3] The dialog shows ${t('skuForm.msg.leaveConfirm')}`).toContain(t('skuForm.msg.leaveConfirm'));
      await expect(form.leaveConfirm, '[Expected 3] The dialog closes after cancelling').toHaveCount(0);
      await expect(page, '[Expected 3] The form stays open').toHaveURL(/\/physical\/create/);
      await expect(form.skuGroupCodeNameInput, '[Expected 3] The typed product code name is still in the field').toHaveValue(name);
    });

    await step('Act: Step 4 — Click 목록으로 again, confirm leaving, then look for Demo Test Product on the list', async () => {
      await form.click(form.backButton, `${t('skuForm.btn.backToList')} button`);
      await form.click(form.leaveConfirmButton, `${t('skuForm.btn.backToList')} button of the confirm`);
      await page.waitForURL(LIST_URL, { timeout: 30_000 }).catch(() => undefined);
      url4 = page.url();
      await list.open();
      await list.search('SKU_GROUP_NAME', name);
      rows4 = ((await stockApi.skus({ searchType: 'SKU_GROUP_CODE_NAME', keyword: name })).body.items ?? []).length;
    });

    await step('Assert: Expected 4 — The form is thrown away, the list opens and no record named Demo Test Product is there', async () => {
      expect(url4, '[Expected 4] Confirming leaves the form and opens the list').toMatch(LIST_URL);
      await expect(list.noResultsRow(), `[Expected 4] The stock list finds no record named "${name}"`).toBeVisible();
      expect(rows4, `[Expected 4] No SKU named "${name}" exists`).toBe(0);
    });
  });

  test('TC_US134_136 — In edit mode 저장 turns usable only after a change and a passed barcode duplicate check', async ({ page, world }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormB(page);
    await tcMeta(
      'TC_US134_136',
      'Medium',
      TAGS,
      `Edit screen of an own physical SKU group with 2 saved SKU lines (playing DEMO-PC-001): 저장 is greyed out on load and after only changing 상품코드명 to "… rev3", turns usable after 바코드 중복확인, and the save goes through and returns to the list. ${WORLD_NOTE}`,
    );
    let sku!: WorldSku;
    let attempt4: SaveAttempt | null = null;

    await step('Arrange: Pre-condition 1–2 — An own physical SKU group with 2 saved SKU lines', async () => {
      [sku] = await world.createPhysicalSku('TC136', {
        partner: world.partners.A,
        manufacturer: world.manufacturers.M1,
        groupName: `${world.tag} TC136 Demo Album [Vol.1]`,
        lines: [{ option: 'Photocard (Type A)' }, { option: 'Photocard (Type B)' }],
      });
    });

    await step('Act: Step 1 — Open the edit screen and read the state of 저장 (Save) before touching anything', async () => {
      await form.openEdit('physical', sku.groupId);
      await expect(form.lineRows, 'Both saved SKU lines are shown').toHaveCount(2);
    });

    await step('Assert: Expected 1 — The Save button is greyed out', async () => {
      await expect(form.saveButton, '[Expected 1] 저장 is disabled on load').toBeDisabled();
    });

    await step('Act: Step 2 — Change 상품코드명 (Product code name) to Demo Album [Vol.1] rev3 and read the state of 저장 (Save)', async () => {
      await form.skuGroupCodeNameInput.fill(`${sku.groupName} rev3`);
    });

    await step('Assert: Expected 2 — The Save button is still greyed out', async () => {
      await expect(form.saveButton, '[Expected 2] 저장 is still disabled after only the name changed').toBeDisabled();
    });

    await step('Act: Step 3 — Click 바코드 중복확인 (Barcode duplicate check) and read the state of 저장 (Save)', async () => {
      await form.passBarcodeCheck();
    });

    await step('Assert: Expected 3 — The Save button turns usable', async () => {
      await expect(form.saveButton, '[Expected 3] 저장 is enabled after the barcode check').toBeEnabled();
    });

    await step('Act: Step 4 — Click 저장 (Save)', async () => {
      attempt4 = await form.attemptSave();
    });

    await step('Assert: Expected 4 — The save goes through and returns to the list', async () => {
      expect(accepted(attempt4), `[Expected 4] The save goes through (HTTP ${attempt4?.status ?? 'not sent'} ${message(attempt4)})`).toBe(true);
      await expect(page, '[Expected 4] The browser returns to the list').toHaveURL(LIST_URL, { timeout: 30_000 });
    });
  });

  test('TC_US134_137 — In create mode 저장 turns usable only after the required fields and both duplicate checks', async ({ page, world }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormB(page);
    await tcMeta(
      'TC_US134_137',
      'Medium',
      TAGS,
      `Physical create form, nothing saved: 저장 is disabled on the empty form, after every required field but 원산지, after 원산지 too, and after only the product code check; it becomes enabled only once the barcode check also passes. ${WORLD_NOTE}`,
    );
    const data = formData(world, 'T137', { country: '' });
    let afterCode: boolean | null = null;
    let afterBarcode: boolean | null = null;

    await step('Arrange: Pre-condition 1–3 — 현물 SKU 생성 open with nothing typed; valid values and unused codes ready', async () => {
      await world.trackGroupCode(data.groupCode);
      await form.openCreate('physical');
    });

    await step('Act: Step 1 — Read the state of 저장 (Save) on the empty form', async () => {
      await expect(form.skuGroupCodeInput, 'The form is empty').toHaveValue('');
    });

    await step('Assert: Expected 1 — 저장 is disabled', async () => {
      await expect(form.saveButton, '[Expected 1] 저장 is disabled on the empty form').toBeDisabled();
    });

    await step('Act: Step 2 — Fill every required field except 원산지 (Country of origin) and read the state of 저장', async () => {
      await form.fillForm(data);
    });

    await step('Assert: Expected 2 — 저장 remains disabled', async () => {
      await expect(form.saveButton, '[Expected 2] 저장 stays disabled without 원산지').toBeDisabled();
    });

    await step('Act: Step 3 — Fill 원산지 (Country of origin) too and read the state of 저장', async () => {
      await form.chooseCountry(TC_DEFAULTS.country);
    });

    await step('Assert: Expected 3 — 저장 remains disabled', async () => {
      await expect(form.countryValue, 'The country of origin is chosen').toContainText('(KR)');
      await expect(form.saveButton, '[Expected 3] 저장 stays disabled before the duplicate checks').toBeDisabled();
    });

    await step('Act: Step 4 — Click 중복확인 and read 저장, then click 바코드 중복확인 and read it again', async () => {
      await form.passCodeCheck();
      afterCode = await form.saveButton.isEnabled();
      await form.passBarcodeCheck();
      await expect(form.saveButton, 'The save button settles after the barcode check').toBeVisible();
      afterBarcode = await form.saveButton.isEnabled();
    });

    await step('Assert: Expected 4 — 저장 stays disabled after only the product code check and is enabled once the barcode check also passes', async () => {
      expect(afterCode, '[Expected 4] 저장 is still disabled after only the product code check').toBe(false);
      expect(afterBarcode, '[Expected 4] 저장 is enabled after the barcode check passes as well').toBe(true);
    });
  });

  test('TC_US134_138 — A new physical SKU is created without a status field and shows on 재고 관리 with dashes', async ({ page, world, stockApi, stockListPage: list }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormB(page);
    const ui = new StockUiPage(page);
    await tcMeta(
      'TC_US134_138',
      'Critical',
      TAGS,
      `Physical create form (own unused codes, Demo Partner A, 본품, 옵션없음, CS_ 2026 SPRING, 12000, 250, 100/80/30, 6109101000, CD, Demo Manufacturer 1, 대한민국): no 상태 / 판매상태 field; both checks pass; the POST /api/v1/skus body carries no status field and the save goes through to the Stock Management list; 재고 관리 searched by 상품코드 shows the product code, SKU code, barcode, SKU 유형 현물 and a dash in every stock quantity cell. Observed in the frontend bundle 05/10: a create form opened from 현물 SKU 생성 (SKU master) returns to the SKU master list, not to 재고 관리. ${WORLD_NOTE}`,
    );
    const data = formData(world, 'T138', { groupName: `${world.tag} T138 Demo Physical New` });
    const quantityColumns = [
      'col.totalQuantity', 'col.reservedQuantity', 'col.availableQuantity', 'col.csQuantity', 'col.csOrderableQuantity', 'col.pendingAllocationQuantity',
      'col.orderableQuantity', 'col.incomingQuantity', 'col.insufficientQuantity', 'col.unconfirmedQuantity',
    ] as const;
    let labels1: string[] = [];
    let attempt4: SaveAttempt | null = null;

    await step('Arrange: Pre-condition 1–4 — Product code and barcode not in use; test data ready; network capture armed', async () => {
      await world.trackGroupCode(data.groupCode);
      expect((await stockApi.checkSkuGroupCode(data.groupCode)).body.ids, `Product code ${data.groupCode} is not in use`).toEqual([]);
      expect((await stockApi.checkSkuDuplication({ skuCodes: [data.lines[0].skuCode], barcodes: [data.lines[0].barcode] })).body.ids, 'SKU code and barcode are not in use').toEqual([]);
    });

    await step('Act: Step 1 — Open 현물 SKU 생성 and check the form for a 상태 (Status) or 판매상태 (Sales status) field', async () => {
      await form.openCreate('physical');
      labels1 = await ui.headerTexts(ui.formLabels);
    });

    await step('Assert: Expected 1 — No 상태 (Status) or 판매상태 (Sales status) field is displayed', async () => {
      expect(labels1.filter((label) => /^상태$/.test(label)), `[Expected 1] No 상태 (Status) field (labels: ${labels1.join(' | ')})`).toEqual([]);
      expect(labels1.filter((label) => /^판매\s*상태$/.test(label)), '[Expected 1] No 판매상태 (Sales status) field').toEqual([]);
    });

    await step('Act: Step 2 — Enter all test data', async () => {
      await form.fillForm(data);
    });

    await step('Assert: Expected 2 — The form accepts all entered values', async () => {
      await expect(form.bizPartnerSelect, '[Expected 2] 비즈파트너 is Demo Partner A').toHaveValue(String(world.partners.A.id));
      await expect(form.usageRadio('MAIN'), '[Expected 2] SKU 종류 is 본품').toBeChecked();
      await expect(form.optionNone, '[Expected 2] 옵션 설정 is 옵션없음').toBeChecked();
      await expect(form.skuGroupCodeInput, '[Expected 2] The product code is accepted').toHaveValue(data.groupCode);
      await expect(form.skuGroupCodeNameInput, '[Expected 2] The product code name is accepted').toHaveValue(data.groupName);
      await expect(form.lineInput(0, 'skuCode'), '[Expected 2] The SKU code is accepted').toHaveValue(data.lines[0].skuCode);
      await expect(form.lineInput(0, 'barcode'), '[Expected 2] The barcode is accepted').toHaveValue(data.lines[0].barcode);
      await expect(form.lineInput(0, 'exportSkuName'), '[Expected 2] The export SKU name is accepted').toHaveValue(TC_DEFAULTS.exportSkuName);
      await expect(form.priceInput, '[Expected 2] The supply cost is accepted').toHaveValue(TC_DEFAULTS.price);
      await expect(form.weightInput, '[Expected 2] The weight is accepted').toHaveValue(TC_DEFAULTS.weight);
      await expect(form.widthInput, '[Expected 2] The width is accepted').toHaveValue(TC_DEFAULTS.volume[0]);
      await expect(form.depthInput, '[Expected 2] The depth is accepted').toHaveValue(TC_DEFAULTS.volume[1]);
      await expect(form.heightInput, '[Expected 2] The height is accepted').toHaveValue(TC_DEFAULTS.volume[2]);
      await expect(form.hsCodeInput, '[Expected 2] The HS code is accepted').toHaveValue(TC_DEFAULTS.hsCode);
      await expect(form.descriptionInput, '[Expected 2] The short description is accepted').toHaveValue(TC_DEFAULTS.description);
      await expect(form.manufacturerSelect, '[Expected 2] The manufacturer is Demo Manufacturer 1').toHaveValue(String(world.manufacturers.M1.id));
      await expect(form.countryValue, '[Expected 2] The country of origin is 대한민국 (Korea)').toContainText('(KR)');
    });

    await step('Act: Step 3 — Complete 상품코드 중복확인 and 바코드 중복확인', async () => {
      await form.checkCode();
      await form.checkBarcode();
    });

    await step('Assert: Expected 3 — Both duplicate checks pass', async () => {
      await expect(form.skuGroupCodeInput, '[Expected 3] The product code check passes (field locked)').toHaveAttribute('readonly', '', { timeout: 15_000 });
      await expect(form.useOtherBarcodeButton, `[Expected 3] The barcode check passes (${t('skuForm.btn.useOtherBarcode')} shown)`).toBeVisible({ timeout: 15_000 });
    });

    await step('Act: Step 4 — Click 저장 (Save) and inspect the create request', async () => {
      attempt4 = await form.attemptSave();
    });

    await step('Assert: Expected 4 — Save succeeds, the create request carries no status field, and the Stock Management list opens', async () => {
      expect(accepted(attempt4), `[Expected 4] The save succeeds (HTTP ${attempt4?.status ?? 'not sent'} ${message(attempt4)})`).toBe(true);
      const body = attempt4?.requestBody ?? {};
      expect(Object.keys(body).filter((key) => /status/i.test(key)), `[Expected 4] The create request has no status field (keys: ${Object.keys(body).join(', ')})`).toEqual([]);
      const lines = (body.skus as Array<Record<string, unknown>> | undefined) ?? [];
      expect(lines.flatMap((line) => Object.keys(line)).filter((key) => /status/i.test(key)), '[Expected 4] The SKU lines of the request carry no status field').toEqual([]);
      await expect(page, '[Expected 4] The Stock Management list opens').toHaveURL(STOCK_LIST_URL, { timeout: 30_000 });
    });

    await step('Act: Step 5 — On 재고 관리, search by 상품코드 (Product code) and check the new row', async () => {
      await list.open();
      await list.search('SKU_GROUP_CODE', data.groupCode);
    });

    await step('Assert: Expected 5 — The row shows the product code, SKU code, barcode, SKU 유형 현물 and a dash in every stock quantity cell', async () => {
      const row = list.row(data.lines[0].skuCode);
      await expect(row, `[Expected 5] The row of ${data.lines[0].skuCode} is listed`).toBeVisible();
      await expect(list.cell(row, 'col.skuGroupCode'), `[Expected 5] 상품코드 is ${data.groupCode}`).toHaveText(data.groupCode);
      await expect(list.cell(row, 'col.skuCode'), `[Expected 5] SKU코드 is ${data.lines[0].skuCode}`).toHaveText(data.lines[0].skuCode);
      await expect(list.cell(row, 'col.barcode'), `[Expected 5] 바코드 is ${data.lines[0].barcode}`).toHaveText(data.lines[0].barcode);
      await expect(list.cell(row, 'col.skuType'), `[Expected 5] SKU 유형 is ${stx('skuType.PHYSICAL', 'ko')}`).toHaveText(stx('skuType.PHYSICAL', 'ko'));
      for (const column of quantityColumns) await expect(list.cell(row, column), `[Expected 5] ${stx(column, 'ko')} shows a dash`).toHaveText('-');
    });
  });

  test('TC_US134_139 — Korean product code name and SKU name are stored and shown unchanged', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormB(page);
    await tcMeta(
      'TC_US134_139',
      'Medium',
      TAGS,
      `Physical create form with 옵션있음, product code name "<tag> 데모 앨범 볼륨1" (run tag in front for traceability) and SKU name 포토카드 타입A: both fields take the Korean text; the save returns to the list; 재고 관리 searched by 상품코드 shows the SKU명 "<tag> 데모 앨범 볼륨1 포토카드 타입A" intact (no ? and no replacement boxes); the edit screen shows the product code name unchanged. ${WORLD_NOTE}`,
    );
    const groupName = `${world.tag} 데모 앨범 볼륨1`;
    const data = formData(world, 'T139', { hasOption: true, groupName }, { skuName: '포토카드 타입A' });
    let attempt2: SaveAttempt | null = null;
    let cell3 = '';
    let name4 = '';

    await step('Arrange: Pre-condition 1–3 — Product code and barcode not in use; Korean test data ready', async () => {
      await world.trackGroupCode(data.groupCode);
    });

    await step('Act: Step 1 — Open 현물 SKU 생성, set 옵션 설정 to 옵션있음 and fill every field with the test data', async () => {
      await form.openCreate('physical');
      await form.fillForm(data);
    });

    await step('Assert: Expected 1 — Both fields take the Korean values', async () => {
      await expect(form.skuGroupCodeNameInput, `[Expected 1] 상품코드명 holds ${groupName}`).toHaveValue(groupName);
      await expect(form.lineInput(0, 'skuName'), '[Expected 1] SKU명 holds 포토카드 타입A').toHaveValue('포토카드 타입A');
    });

    await step('Act: Step 2 — Press both duplicate-check buttons and click 저장 (Save)', async () => {
      await form.passBothChecks();
      attempt2 = await form.attemptSave();
    });

    await step('Assert: Expected 2 — The save goes through and returns to the list', async () => {
      expect(accepted(attempt2), `[Expected 2] The save goes through (HTTP ${attempt2?.status ?? 'not sent'} ${message(attempt2)})`).toBe(true);
      await expect(page, '[Expected 2] The browser returns to the list').toHaveURL(LIST_URL, { timeout: 30_000 });
    });

    await step('Act: Step 3 — Go back to the list, search by 상품코드 and read the SKU명 cell character by character', async () => {
      await list.open();
      await list.search('SKU_GROUP_CODE', data.groupCode);
      cell3 = await list.cellText(list.row(data.lines[0].skuCode), 'col.skuName');
    });

    await step('Assert: Expected 3 — The cell shows 데모 앨범 볼륨1 포토카드 타입A with every Korean character intact', async () => {
      expect(cell3, `[Expected 3] The SKU명 cell is "${groupName} 포토카드 타입A"`).toBe(`${groupName} 포토카드 타입A`);
      expect(cell3, '[Expected 3] The cell has no question marks').not.toContain('?');
      expect(cell3, '[Expected 3] The cell has no empty boxes (replacement characters)').not.toMatch(/[�□]/);
    });

    await step('Act: Step 4 — Open the edit screen of that record and read 상품코드명 (Product code name)', async () => {
      await form.openEditFromList(list, data.groupCode, data.lines[0].skuCode);
      name4 = await form.skuGroupCodeNameInput.inputValue();
    });

    await step('Assert: Expected 4 — The field shows 데모 앨범 볼륨1 unchanged', async () => {
      expect(name4, `[Expected 4] 상품코드명 shows ${groupName} unchanged`).toBe(groupName);
    });
  });

  test('TC_US134_140 — Editable fields are saved on edit while the locked fields stay unchanged', async ({ page, world, stockListPage: list }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormB(page);
    await tcMeta(
      'TC_US134_140',
      'Critical',
      TAGS,
      `An own physical SKU group (playing DEMO-PC-001: Demo Partner A, "<tag> TC140 Demo Album [Vol.1]", 12000, 본품, 옵션있음, HS 6109101000, CS_ 2026 SPRING, line Photocard (Type A)) opened from 재고 관리: card title 현물 SKU, badge 수정, saved values shown; 상품코드명 → "… Reissue" and 공급원가 → 13500 are accepted; the barcode check passes and the save goes through; the SKU row then shows SKU명 "<new name> Photocard (Type A)"; reopened, 비즈파트너, 상품코드, SKU 종류 and 옵션 설정 are unchanged. ${WORLD_NOTE}`,
    );
    const groupName = `${world.tag} TC140 Demo Album [Vol.1]`;
    const newName = `${groupName} Reissue`;
    let sku!: WorldSku;
    let attempt3: SaveAttempt | null = null;
    let skuName3 = '';

    await step('Arrange: Pre-condition 1–5 — An own physical SKU group with Demo Partner A, 12000, 본품, 옵션있음, HS 6109101000, CS_ 2026 SPRING on every line', async () => {
      [sku] = await world.createPhysicalSku('TC140', {
        partner: world.partners.A,
        manufacturer: world.manufacturers.M1,
        groupName,
        usageType: 'MAIN',
        price: 12000,
        hsCode: TC_DEFAULTS.hsCode,
        lines: [{ option: 'Photocard (Type A)', exportSkuName: TC_DEFAULTS.exportSkuName }, { option: 'Photocard (Type B)', exportSkuName: TC_DEFAULTS.exportSkuName }],
      });
    });

    await step('Act: Step 1 — Open 재고 관리, find the SKU and click its 상품코드 (Product code) to open the edit screen', async () => {
      await form.openEditFromList(list, sku.groupCode, sku.skuCode);
    });

    await step('Assert: Expected 1 — The form opens with card title 현물 SKU, badge 수정 and the saved values', async () => {
      await expect(form.cardTitle, `[Expected 1] The card title is ${t('skuForm.title.physical')}`).toHaveText(t('skuForm.title.physical'));
      await expect(form.modeBadge, `[Expected 1] The mode badge is ${t('skuForm.mode.edit')}`).toHaveText(t('skuForm.mode.edit'));
      await expect(form.skuGroupCodeInput, `[Expected 1] 상품코드 shows ${sku.groupCode}`).toHaveValue(sku.groupCode);
      await expect(form.skuGroupCodeNameInput, `[Expected 1] 상품코드명 shows ${groupName}`).toHaveValue(groupName);
      await expect(form.priceInput, '[Expected 1] 공급원가 shows 12000').toHaveValue('12000');
      await expect(form.bizPartnerSelect, '[Expected 1] 비즈파트너 shows Demo Partner A').toHaveValue(String(world.partners.A.id));
      await expect(form.lineInput(0, 'skuName'), '[Expected 1] The first line shows SKU명 Photocard (Type A)').toHaveValue('Photocard (Type A)');
    });

    await step('Act: Step 2 — Change 상품코드명 to Demo Album [Vol.1] Reissue and 공급원가 to 13500', async () => {
      await form.skuGroupCodeNameInput.fill(newName);
      await form.priceInput.fill('13500');
    });

    await step('Assert: Expected 2 — Both editable fields accept the new values', async () => {
      await expect(form.skuGroupCodeNameInput, `[Expected 2] 상품코드명 holds ${newName}`).toHaveValue(newName);
      await expect(form.priceInput, '[Expected 2] 공급원가 holds 13500').toHaveValue('13500');
    });

    await step('Act: Step 3 — Complete 바코드 중복확인, click 저장 (Save), then search for the product code on 재고 관리', async () => {
      await form.checkBarcode();
      await expect(form.useOtherBarcodeButton, 'The barcode check result is shown').toBeVisible({ timeout: 15_000 });
      attempt3 = await form.attemptSave();
      await list.open();
      await list.search('SKU_GROUP_CODE', sku.groupCode);
      skuName3 = await list.cellText(list.row(sku.skuCode), 'col.skuName');
    });

    await step('Assert: Expected 3 — The duplicate check passes, Save succeeds, and the row shows SKU명 "Demo Album [Vol.1] Reissue Photocard (Type A)"', async () => {
      expect(accepted(attempt3), `[Expected 3] The save succeeds (HTTP ${attempt3?.status ?? 'not sent'} ${message(attempt3)})`).toBe(true);
      expect(skuName3, `[Expected 3] The SKU row shows ${newName} Photocard (Type A)`).toBe(`${newName} Photocard (Type A)`);
    });

    await step('Act: Step 4 — Open the edit screen again and check 비즈파트너, 상품코드, SKU 종류 and 옵션 설정', async () => {
      await form.openEditFromList(list, sku.groupCode, sku.skuCode);
    });

    await step('Assert: Expected 4 — The locked fields remain unchanged: Demo Partner A, the product code, 본품 and 옵션있음', async () => {
      await expect(form.bizPartnerSelect, '[Expected 4] 비즈파트너 is still Demo Partner A').toHaveValue(String(world.partners.A.id));
      await expect(form.bizPartnerSelect, '[Expected 4] 비즈파트너 is locked').toBeDisabled();
      await expect(form.skuGroupCodeInput, `[Expected 4] 상품코드 is still ${sku.groupCode}`).toHaveValue(sku.groupCode);
      await expect(form.usageRadio('MAIN'), '[Expected 4] SKU 종류 is still 본품').toBeChecked();
      await expect(form.optionHas, '[Expected 4] 옵션 설정 is still 옵션있음').toBeChecked();
    });
  });
});

test.describe('[SKU Forms] Field sets and partner note of the three SKU forms', () => {
  const SHARED_FIELDS = ['skuForm.field.skuType', 'skuForm.field.bizPartner', 'skuForm.field.skuGroupCode', 'skuForm.field.skuGroupCodeName'] as const;
  const PHYSICAL_FIELDS = [
    ...SHARED_FIELDS, 'skuForm.field.usageType', 'skuForm.field.price', 'skuForm.field.weight', 'skuForm.field.volume', 'skuForm.field.hsCode',
    'skuForm.field.description', 'skuForm.field.manufacturer', 'skuForm.field.countryOfOrigin',
  ] as const;

  test('TC_US134_141 — The physical, digital and set create forms show three different field sets on three different paths', async ({ page }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormB(page);
    const ui = new StockUiPage(page);
    await tcMeta(
      'TC_US134_141',
      'Medium',
      FORM_TAGS,
      'The three create forms are opened in turn: 현물 has the 4 shared fields (SKU 유형, 비즈파트너, 상품코드 with 중복확인, 상품코드명) plus SKU 종류, 공급원가, 옵션 설정, the SKU line table with 수출용 SKU명, 중량, 부피, HS 코드, 상품 간단 설명, 제조사 and 원산지; 디지털 has only the 4 shared fields; set has the 4 shared fields plus the SET 설정 table; the 3 paths differ and the 3 field lists differ.',
    );
    const shared = SHARED_FIELDS.map((key) => t(key));
    const seen: Record<'physical' | 'digital' | 'set', { path: string; labels: string[]; checkCode: boolean; section: boolean; table: boolean; lineHeaders: string[] }> = {
      physical: { path: '', labels: [], checkCode: false, section: false, table: false, lineHeaders: [] },
      digital: { path: '', labels: [], checkCode: false, section: false, table: false, lineHeaders: [] },
      set: { path: '', labels: [], checkCode: false, section: false, table: false, lineHeaders: [] },
    };
    const record = async (kind: 'physical' | 'digital' | 'set'): Promise<void> => {
      await form.openCreate(kind);
      seen[kind] = {
        path: new URL(page.url()).pathname,
        labels: await ui.headerTexts(ui.formLabels),
        checkCode: await form.checkCodeButton.isVisible(),
        section: await ui.formSection(t(kind === 'set' ? 'skuForm.section.set' : 'skuForm.section.option')).isVisible(),
        table: await form.linesTable.isVisible(),
        lineHeaders: (await form.linesTable.isVisible()) ? await form.lineHeaderTexts() : [],
      };
    };

    await step('Arrange: Pre-condition 1–2 — Logged in with write access; the 3 create forms can be opened', async () => {
      expect(shared.length, 'The 4 shared field names are known').toBe(4);
    });

    await step('Act: Step 1 — Open 현물 SKU 생성 (Create physical SKU) and write down every field', async () => {
      await record('physical');
    });

    await step('Assert: Expected 1 — The physical screen has the 4 shared fields plus the physical-only fields and the SKU line table with 수출용 SKU명', async () => {
      for (const key of PHYSICAL_FIELDS) expect(seen.physical.labels, `[Expected 1] The physical form has the field ${t(key)}`).toContain(t(key));
      expect(seen.physical.checkCode, `[Expected 1] 상품코드 has the ${t('skuForm.btn.checkCode')} button`).toBe(true);
      expect(seen.physical.section, `[Expected 1] The physical form has the ${t('skuForm.section.option')} block`).toBe(true);
      expect(seen.physical.table, '[Expected 1] The physical form has the SKU line table').toBe(true);
      expect(seen.physical.lineHeaders, `[Expected 1] The SKU line table has the column ${t('skuForm.col.exportSkuName')}`).toContain(t('skuForm.col.exportSkuName'));
    });

    await step('Act: Step 2 — Open 디지털 SKU 생성 (Create digital SKU) and write down every field', async () => {
      await record('digital');
    });

    await step('Assert: Expected 2 — The digital screen has only the 4 shared fields', async () => {
      expect(seen.digital.labels, `[Expected 2] The digital form has exactly ${shared.join(', ')}`).toEqual(shared);
      expect(seen.digital.checkCode, `[Expected 2] 상품코드 has the ${t('skuForm.btn.checkCode')} button`).toBe(true);
      expect(seen.digital.table, '[Expected 2] The digital form has no table').toBe(false);
    });

    await step('Act: Step 3 — Open set SKU 생성 (Create set SKU) and write down every field', async () => {
      await record('set');
    });

    await step('Assert: Expected 3 — The set screen has the 4 shared fields plus the SET 설정 (Set configuration) table', async () => {
      expect(seen.set.labels, `[Expected 3] The set form has exactly the shared fields ${shared.join(', ')}`).toEqual(shared);
      expect(seen.set.checkCode, `[Expected 3] 상품코드 has the ${t('skuForm.btn.checkCode')} button`).toBe(true);
      expect(seen.set.section, `[Expected 3] The set form has the ${t('skuForm.section.set')} block`).toBe(true);
      expect(seen.set.table, `[Expected 3] The set form has the ${t('skuForm.section.set')} table`).toBe(true);
    });

    await step('Act: Step 4 — Compare the 3 page addresses and the 3 field lists', async () => {
      expect(Object.values(seen).every((screen) => screen.path !== ''), 'The 3 addresses were recorded').toBe(true);
    });

    await step('Assert: Expected 4 — The 3 page addresses are 3 different paths and the 3 field lists differ', async () => {
      const paths = Object.values(seen).map((screen) => screen.path);
      expect(new Set(paths).size, `[Expected 4] The 3 addresses differ (${paths.join(' | ')})`).toBe(3);
      const lists = (['physical', 'digital', 'set'] as const).map((kind) => JSON.stringify({ labels: seen[kind].labels, section: seen[kind].section, table: seen[kind].table, lineHeaders: seen[kind].lineHeaders }));
      expect(new Set(lists).size, '[Expected 4] The 3 field lists differ from each other').toBe(3);
    });
  });

  test('TC_US134_142 — The partner-locked note sits in the biz partner field on every SKU form and nowhere else', async ({ page, world }) => {
    const step = makeStep(page);
    const form = new PhysicalSkuFormB(page);
    await tcMeta(
      'TC_US134_142',
      'Low',
      FORM_TAGS,
      `The note 생성 후 수정 불가능합니다 is read inside the 비즈파트너 field area on 현물 SKU 생성, on the edit screen of the world physical group (playing DEMO-PC-001, opened read-only — nothing is saved), on 디지털 SKU 생성 and on set SKU 생성; on each of the 4 screens the sentence appears exactly once as text and in no alert / toast message bar. ${WORLD_NOTE}`,
    );
    const note = t('skuForm.lockNotice');
    const physicalGroup = () => world.sku('SKU0001').groupId;
    const screens: Array<{ name: string; open: () => Promise<void> }> = [
      { name: '현물 SKU 생성', open: () => form.openCreate('physical') },
      { name: '현물 SKU 수정', open: () => form.openEdit('physical', physicalGroup()) },
      { name: '디지털 SKU 생성', open: () => form.openCreate('digital') },
      { name: 'set SKU 생성', open: () => form.openCreate('set') },
    ];
    const step3: Array<{ name: string; inField: boolean }> = [];
    const step4: Array<{ name: string; texts: number; inField: number; bars: number }> = [];

    await step('Arrange: Pre-condition 1–2 — SKU groups of all 3 kinds exist (world: physical PC001, digital PC006, set PC007)', async () => {
      expect(world.sku('SKU0001').type, 'The world physical SKU group is available').toBe('PHYSICAL');
      expect(world.sku('SKU0006').type, 'The world digital SKU group is available').toBe('DIGITAL');
      expect(world.sku('SKU0007').type, 'The world set SKU group is available').toBe('MIXED');
    });

    await step('Act: Step 1 — Open 현물 SKU 생성 and read the line of text next to or under the 비즈파트너 field', async () => {
      await screens[0].open();
    });

    await step('Assert: Expected 1 — The note 생성 후 수정 불가능합니다 shows inside the partner field area', async () => {
      await expect(form.bizPartnerLockNote, `[Expected 1] ${note} is shown inside the biz partner field`).toBeVisible();
    });

    await step('Act: Step 2 — Open the edit screen of the physical group and read the same spot', async () => {
      await screens[1].open();
    });

    await step('Assert: Expected 2 — The same note shows in the same place in edit mode', async () => {
      await expect(form.modeBadge, `The edit screen is open (${t('skuForm.mode.edit')})`).toHaveText(t('skuForm.mode.edit'));
      await expect(form.bizPartnerLockNote, `[Expected 2] ${note} is shown inside the biz partner field in edit mode`).toBeVisible();
    });

    await step('Act: Step 3 — Open 디지털 SKU 생성 and then set SKU 생성, reading the same spot on each', async () => {
      for (const screen of screens.slice(2)) {
        await screen.open();
        step3.push({ name: screen.name, inField: await form.bizPartnerLockNote.isVisible() });
      }
    });

    await step('Assert: Expected 3 — The same note shows on both of the other screens', async () => {
      for (const screen of step3) expect(screen.inField, `[Expected 3] ${note} is shown inside the biz partner field of ${screen.name}`).toBe(true);
    });

    await step('Act: Step 4 — Scan the rest of each screen for the sentence as a separate message bar', async () => {
      for (const screen of screens) {
        await screen.open();
        step4.push({ name: screen.name, texts: await form.exactText(note).count(), inField: await form.bizPartnerLockNote.count(), bars: await form.messageBars(note).count() });
      }
    });

    await step('Assert: Expected 4 — The sentence turns up nowhere else as a separate message bar — it belongs to the partner field', async () => {
      for (const screen of step4) {
        expect(screen.texts, `[Expected 4] ${screen.name}: the sentence appears exactly once on the screen`).toBe(1);
        expect(screen.inField, `[Expected 4] ${screen.name}: that one appearance is inside the biz partner field`).toBe(1);
        expect(screen.bars, `[Expected 4] ${screen.name}: no alert / toast message bar carries the sentence`).toBe(0);
      }
    });
  });
});
