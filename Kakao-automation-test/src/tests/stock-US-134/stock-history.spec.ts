import { test, expect } from '@fixtures/stock.fixture';
import type { StockApi } from '@api/stock.api';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { ownGroupName, seedIncoming } from '@pages/stock-calculation.page';
import {
  ADJUST_URL, CONVERT_URL, HISTORY_DATE_PATTERN, HistoryLine, IP_PATTERN, SaveOutcome, StockAdjustmentPage,
  annotateIncoming, daeguOf, kstTimestamp, minutesAgo, ownSkuLines, ownStockSku, seedAdjustmentUsages, seedOutgoing, seedUsage,
} from '@pages/stock-adjustment.page';
import { STOCK_LANGS, StockLang, StockTextKey, stx } from '@utils/stock.i18n';
import { LANG_SUFFIX, stockTags } from '@utils/stock-spec';
import { DB_ACTOR, stockDb } from '@utils/stock-db';
import type { StockWorld, WorldSku, WorldWarehouse } from '@utils/stock.data';
import { getAccountDisplayName } from '@utils/auth-token';
import { env } from '@utils/env.config';

/**
 * US134 — nhóm [Stock History] (TC_US134_296–312): dialog 재고이력 của 1 cặp SKU × kho. Nguồn TC: SCRATCH/us134/TC_US134_<n>.txt
 * (Steps N / Expected N → `Act: Step N` / `Assert: Expected N`; TC ghi "Korean, then English" → chạy trọn chuỗi 2 lượt).
 * Biến động: 조정 thật (API / UI) trên SKU riêng của test; 입고 / 출고 do hệ thống khác ghi → chèn `stock_usage` bằng DB
 * cho tồn kho của SKU riêng. Kỳ vọng assert theo TC; chỗ UI khác TC ghi trong description.
 */
const TAGS = stockTags('stock-history');
const ko = (key: StockTextKey) => stx(key, 'ko');
const REGISTERED = ko('msg.registered');
const HEADER_KEYS = [
  'history.col.date', 'history.col.refType', 'history.col.detailType', 'history.col.refId', 'history.col.note',
  'history.col.before', 'history.col.change', 'history.col.after', 'history.col.operator', 'history.col.operatorIp',
] as const;
const OWN_NOTE =
  'Data: the DEMO-SKU rows of the shared world must keep an untouched history, so the test creates its own physical SKU (Partner A, manufacturer M1) in the automation warehouses, seeds the TC stock buckets through the DB and writes the movements the TC needs on it; the TC SKU codes / names map onto that SKU.';
const FIXTURE_NOTE =
  'Inbound / outbound movements cannot be raised from this admin (they come from the CJ / order flows), so they are stock_usage rows inserted by DB fixture on the own stock row (created_by automation-US134).';
const DAEGU_NOTE = 'CJ Daegu warehouse = the automation CJ Daegu copy (the automation General warehouse when dev cannot build a CJ_LOGISTICS_DT warehouse).';

/** Dòng ngữ cảnh chuẩn "SKU명 : … / SKU코드 : … / 창고 : …". */
function contextLine(sku: WorldSku, warehouse: { name: string }, lang: StockLang = 'ko'): string {
  return `${stx('history.skuName', lang)} : ${sku.skuName} / ${stx('history.skuCode', lang)} : ${sku.skuCode} / ${stx('history.warehouse', lang)} : ${warehouse.name}`;
}

/** Ghi 1 biến động 조정 thật qua API (đúng lời gọi dialog gửi) — trả về id phiếu 조정 (= số chứng từ). */
async function apiAdjustment(stockApi: StockApi, sku: WorldSku, warehouse: { id: number }, note: string, quantity = 1): Promise<string> {
  const result = await stockApi.createAdjustments({ items: [{ skuId: sku.skuId, warehouseId: warehouse.id, adjustingQuantity: quantity, modifyType: 'ADD', reason: 'ADJUSTMENT', note }] });
  if (result.status >= 300) throw new Error(`Test data setup failed — POST /adjustments returned ${result.status}: ${JSON.stringify(result.body)}`);
  return String((await stockDb.adjustments(sku.skuId, warehouse.id))[0].id);
}

/** SKU riêng ở CJ Incheon Aam có đúng 1 biến động 입고, 1 출고 (fixture DB) và 1 조정 (API, mới nhất). */
async function threeKinds(world: StockWorld, stockApi: StockApi, label: string) {
  const cj = world.warehouses.CJ;
  const sku = await ownStockSku(world, label, cj.id, { available: 100 });
  const incomingId = await seedIncoming(sku, cj.id, { type: 'PURCHASE_ORDER', status: 'REGISTERED', quantity: 5 });
  await seedUsage(sku, cj.id, { refType: 'INCOMING', type: 'INCOMING_COMPLETED', refId: incomingId, before: 95, delta: 5, after: 100, createdAt: minutesAgo(3) });
  const deliveryCode = `DLV${sku.skuCode}`;
  const outgoingId = await seedUsage(sku, cj.id, { refType: 'OUTGOING', type: 'OUTGOING_COMPLETED', before: 100, delta: -2, after: 98, memo: deliveryCode, createdAt: minutesAgo(2) });
  const adjustmentNote = `Adjustment note ${world.tag}`;
  const adjustmentId = await apiAdjustment(stockApi, sku, cj, adjustmentNote);
  return { cj, sku, incomingId: String(incomingId), incomingNote: `${DB_ACTOR.by} ${sku.skuCode}`, outgoingId: String(outgoingId), deliveryCode, adjustmentId, adjustmentNote };
}

const lineOf = (lines: HistoryLine[], refId: string): HistoryLine | undefined => lines.find((line) => line.refId === refId);

test.describe('[Stock History] Stock management — stock history dialog', () => {
  test('TC_US134_296 — The context line names the SKU name, SKU code and warehouse of the pair just clicked', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_296',
      'Medium',
      TAGS,
      `The same SKU (named "… Photocard (Type A)") in CJ Incheon Aam and CJ Daegu, each with 1 movement: the 재고이력 context line reads SKU명 : <name> / SKU코드 : <code> / 창고 : CJ Incheon Aam for the first row and the same name / code with 창고 : CJ Daegu warehouse for the second. ${OWN_NOTE} ${DAEGU_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const daegu = daeguOf(world);
    const sku = await ownStockSku(world, 'H296', cj.id, { available: 10 }, 'Photocard (Type A)');
    await stockDb.upsertStock(sku.skuId, daegu.id, { available: 20 });
    let first = '';
    let second = '';

    await step('Arrange: Pre-condition 1–3 — Own SKU in CJ Incheon Aam and CJ Daegu warehouse, each pair with 1 movement', async () => {
      for (const warehouse of [cj, daegu]) await apiAdjustment(stockApi, sku, warehouse, `TC296 ${world.tag}`);
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Click 재고이력 (Stock history) on the CJ Incheon Aam row', async () => {
      await list.openHistoryOf(list.row(sku.skuCode, cj.name), 'ko');
    });

    await step('Assert: Expected 1 — The dialog opens', async () => {
      await expect(list.history.root, '[Expected 1] The stock history dialog is open').toBeVisible();
    });

    await step('Act: Step 2 — Read the context line at the top of the dialog', async () => {
      first = await list.historyContext();
    });

    await step('Assert: Expected 2 — The line names the SKU name, the SKU code and CJ Incheon Aam', async () => {
      expect(first, '[Expected 2] The context line names the SKU name').toContain(sku.skuName);
      expect(first, '[Expected 2] The context line names the SKU code').toContain(sku.skuCode);
      expect(first, '[Expected 2] The context line reads SKU명 : … / SKU코드 : … / 창고 : CJ Incheon Aam').toBe(contextLine(sku, cj));
    });

    await step('Act: Step 3 — Close the dialog and click 재고이력 on the CJ Daegu warehouse row', async () => {
      await list.closeHistory();
      await list.openHistoryOf(list.row(sku.skuCode, daegu.name), 'ko');
    });

    await step('Assert: Expected 3 — The dialog opens again', async () => {
      await expect(list.history.root, '[Expected 3] The stock history dialog is open').toBeVisible();
    });

    await step('Act: Step 4 — Read the context line again', async () => {
      second = await list.historyContext();
    });

    await step('Assert: Expected 4 — Same SKU name and code, the warehouse part now says CJ Daegu warehouse', async () => {
      expect(second, '[Expected 4] The context line reads the same SKU with 창고 : CJ Daegu warehouse').toBe(contextLine(sku, daegu));
      expect(second, '[Expected 4] The warehouse part changed with the clicked pair').not.toContain(`: ${cj.name}`);
    });
  });

  test('TC_US134_297 — The movement table shows exactly its 10 columns with the voucher number in its own 4th column', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_297',
      'Medium',
      TAGS,
      `재고이력 shows exactly 10 headers 날짜 · 구분 · 상세구분 · 번호 · 비고 · 변경전 수량 · 변경수량 · 변경 후 수량 · 작업자 · 작업자 ip (EN: Date · Type · Detail type · Voucher no. · Remarks · Quantity before · Change quantity · Quantity after · Operator · Operator IP), no 11th SKU / warehouse column, and the document number sits in its own 4th column 번호 between 상세구분 and 비고 — in Korean, then in English. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'H297', cj.id, { available: 10 });
    let voucher = '';

    await step('Arrange: Pre-condition 1–3 — Own row in CJ Incheon Aam with 1 movement; run in Korean then English', async () => {
      voucher = await apiAdjustment(stockApi, sku, cj, `TC297 ${world.tag}`);
    });

    for (const lang of STOCK_LANGS) {
      const t = (key: StockTextKey) => stx(key, lang);
      const sfx = LANG_SUFFIX[lang];
      let headers: string[] = [];
      let cells: string[] = [];

      await step(`Act: Step 1 — Click 재고이력 (Stock history) on the row ${sfx}`, async () => {
        await list.open(lang);
        await list.findSku(sku);
        await list.openHistoryOf(list.row(sku.skuCode, cj.name), lang);
      });

      await step(`Assert: Expected 1 — The dialog opens ${sfx}`, async () => {
        await expect(list.history.root, '[Expected 1] The stock history dialog is open').toBeVisible();
      });

      await step(`Act: Step 2 — Read the column headers from left to right and count them ${sfx}`, async () => {
        headers = await list.history.headerTexts();
      });

      await step(`Assert: Expected 2 — Exactly 10 headers in the TC order ${sfx}`, async () => {
        expect(headers.length, '[Expected 2] There are exactly 10 headers').toBe(10);
        HEADER_KEYS.forEach((key, index) => expect(headers[index], `[Expected 2] Header ${index + 1} is ${t(key)}`).toBe(t(key)));
      });

      await step(`Act: Step 3 — Look for an eleventh column such as a repeated SKU or warehouse column ${sfx}`, async () => {
        cells = (await list.history.rows.first().locator('td').allTextContents()).map((text) => text.trim());
      });

      await step(`Assert: Expected 3 — No eleventh column; SKU and warehouse are named once, in the context line ${sfx}`, async () => {
        expect(cells.length, '[Expected 3] A movement line has exactly 10 cells').toBe(10);
        for (const key of ['history.skuName', 'history.skuCode', 'history.warehouse', 'adjust.col.skuCode', 'adjust.col.warehouse'] as const) {
          expect(headers, `[Expected 3] No ${t(key)} column inside the table`).not.toContain(t(key));
        }
        expect(await list.historyContext(), '[Expected 3] The context line names the SKU and the warehouse').toBe(contextLine(sku, cj, lang));
      });

      await step(`Act: Step 4 — Check whether the document number is in its own column or joined into 비고 ${sfx}`, async () => {
        expect(cells.length, 'The movement cells are read').toBeGreaterThan(0);
      });

      await step(`Assert: Expected 4 — The number is in its own 4th column 번호 between 상세구분 and 비고 ${sfx}`, async () => {
        expect(headers[3], `[Expected 4] The 4th column is ${t('history.col.refId')}`).toBe(t('history.col.refId'));
        expect(headers[2], `[Expected 4] ${t('history.col.detailType')} is just before it`).toBe(t('history.col.detailType'));
        expect(headers[4], `[Expected 4] ${t('history.col.note')} is just after it`).toBe(t('history.col.note'));
        expect(cells[3], `[Expected 4] The 번호 cell holds the document number ${voucher}`).toBe(voucher);
        expect(cells[4], '[Expected 4] The 비고 cell does not carry the document number').not.toContain(voucher);
      });
    }
  });

  test('TC_US134_298 — The document number is shown for inbound, outbound and adjustment movements', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_298',
      'High',
      TAGS,
      `A pair with 1 inbound, 1 outbound and 1 adjustment movement shows the 3 movements; the 번호 cell holds the inbound request id, the outbound order id and the adjustment id respectively, so all 3 types can show a document number. ${OWN_NOTE} ${FIXTURE_NOTE} The inbound movement points at an inbound request inserted for the own SKU; the outbound order id is a fixture id.`,
    );
    const list = new StockAdjustmentPage(page);
    let seeds: Awaited<ReturnType<typeof threeKinds>> | undefined;
    let lines: HistoryLine[] = [];

    await step('Arrange: Pre-condition 1–2 — Own row in CJ Incheon Aam with 1 inbound, 1 outbound and 1 adjustment movement', async () => {
      seeds = await threeKinds(world, stockApi, 'H298');
      await list.open('ko');
      await list.findSku(seeds.sku);
    });
    const s = seeds as Awaited<ReturnType<typeof threeKinds>>;

    await step('Act: Step 1 — Click 재고이력 (Stock history) on the row', async () => {
      await list.openHistoryOf(list.row(s.sku.skuCode, s.cj.name), 'ko');
      lines = await list.historyLines();
    });

    await step('Assert: Expected 1 — The dialog opens and shows all 3 movements', async () => {
      expect(lines.length, '[Expected 1] The dialog shows 3 movements').toBe(3);
      for (const key of ['usageRef.INCOMING', 'usageRef.OUTGOING', 'usageRef.ADJUSTMENT'] as const) {
        expect(lines.map((line) => line.refType), `[Expected 1] A ${ko(key)} movement is listed`).toContain(ko(key));
      }
    });

    const voucher = { inbound: '', outbound: '', adjustment: '' };
    await step('Act: Step 2 — Read the 번호 (Voucher no.) cell of the inbound movement', async () => {
      voucher.inbound = lines.find((line) => line.refType === ko('usageRef.INCOMING'))?.refId ?? '';
    });

    await step('Assert: Expected 2 — The cell shows the number of the inbound request that created the row', async () => {
      expect(voucher.inbound, '[Expected 2] The inbound 번호 is the inbound request id').toBe(s.incomingId);
    });

    await step('Act: Step 3 — Read the 번호 cell of the outbound movement', async () => {
      voucher.outbound = lines.find((line) => line.refType === ko('usageRef.OUTGOING'))?.refId ?? '';
    });

    await step('Assert: Expected 3 — The cell shows the number of the outbound order that created the row', async () => {
      expect(voucher.outbound, '[Expected 3] The outbound 번호 is the outbound order id').toBe(s.outgoingId);
    });

    await step('Act: Step 4 — Read the 번호 cell of the adjustment movement', async () => {
      voucher.adjustment = lines.find((line) => line.refType === ko('usageRef.ADJUSTMENT'))?.refId ?? '';
    });

    await step('Assert: Expected 4 — The cell shows the number of the adjustment that created the row', async () => {
      expect(voucher.adjustment, '[Expected 4] The adjustment 번호 is the adjustment id').toBe(s.adjustmentId);
    });

    let withNumber = 0;
    await step('Act: Step 5 — Count how many of the 3 types show a document number', async () => {
      withNumber = Object.values(voucher).filter((value) => /^\d+$/.test(value)).length;
    });

    await step('Assert: Expected 5 — All 3 types can show a document number', async () => {
      expect(withNumber, '[Expected 5] Inbound, outbound and adjustment all show a document number').toBe(3);
    });
  });

  test('TC_US134_299 — The inbound id text is taken out of the remarks cell now that the voucher column exists', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_299',
      'Medium',
      TAGS,
      `On a pair with 1 inbound, 1 outbound and 1 adjustment movement: the inbound 비고 no longer holds "입고ID:", the inbound document number appears once (in 번호) and 비고 holds only the outside reference code and the inbound note; the outbound 비고 keeps the delivery code at the end; the adjustment 비고 keeps the reason and the note. ${OWN_NOTE} ${FIXTURE_NOTE} The server builds 비고 from the source documents, not from the stock_usage memo (real dev rows: inbound "입고외부연동ID:{outside ref}/{…}", outbound "배송/현장수령ID:{shipping id}"), so the fixture inbound gets an outside reference code (external_ref_id) and its note on both the request and the SKU line (note + item memo "automation-US134 <SKU code>"), and the fixture outbound gets its own outgoing record whose shipping id is the delivery code (removed at the end of the test).`,
    );
    const list = new StockAdjustmentPage(page);
    let seeds: Awaited<ReturnType<typeof threeKinds>> | undefined;
    let lines: HistoryLine[] = [];
    let externalRef = '';
    let deliveryCode = '';
    let removeOutgoing: (() => Promise<void>) | undefined;

    try {
      await step('Arrange: Pre-condition 1–2 — Own row with 1 inbound, 1 outbound and 1 adjustment movement with a note', async () => {
        seeds = await threeKinds(world, stockApi, 'H299');
        externalRef = `EXT${seeds.sku.skuCode}`;
        await annotateIncoming(seeds.incomingId, seeds.sku.skuId, externalRef, seeds.incomingNote);
        const outgoing = await seedOutgoing(seeds.sku, seeds.cj.id, seeds.outgoingId);
        deliveryCode = outgoing.shippingId;
        removeOutgoing = outgoing.remove;
        await list.open('ko');
        await list.findSku(seeds.sku);
      });
      const s = seeds as Awaited<ReturnType<typeof threeKinds>>;

      await step('Act: Step 1 — Click 재고이력 (Stock history) on the row', async () => {
        await list.openHistoryOf(list.row(s.sku.skuCode, s.cj.name), 'ko');
        lines = await list.historyLines();
      });

      await step('Assert: Expected 1 — The dialog opens and shows all 3 movements', async () => {
        expect(lines.length, '[Expected 1] The dialog shows 3 movements').toBe(3);
      });

      let inbound: HistoryLine | undefined;
      await step('Act: Step 2 — Read the 비고 (Remarks) cell of the inbound movement and look for 입고ID:', async () => {
        inbound = lineOf(lines, s.incomingId);
      });

      await step('Assert: Expected 2 — The 비고 cell no longer has 입고ID:', async () => {
        expect(inbound, '[Expected 2] The inbound movement is listed').toBeDefined();
        expect(inbound?.note, '[Expected 2] The inbound 비고 has no 입고ID:').not.toContain('입고ID:');
      });

      await step('Act: Step 3 — Compare the 번호 (Voucher no.) with what is left in that row\'s 비고', async () => {
        expect(inbound?.refId, 'The inbound 번호 is read').toBeDefined();
      });

      await step('Assert: Expected 3 — The number appears once, in 번호; 비고 holds only the real remark of the inbound row', async () => {
        expect(inbound?.refId, '[Expected 3] The document number is in the 번호 column').toBe(s.incomingId);
        expect(inbound?.note, '[Expected 3] The document number is not repeated in 비고').not.toContain(s.incomingId);
        expect(inbound?.note, `[Expected 3] 비고 holds the outside reference code ${externalRef}`).toContain(externalRef);
        expect(inbound?.note, '[Expected 3] 비고 holds the note of the inbound request').toContain(s.incomingNote);
      });

      let outbound: HistoryLine | undefined;
      await step('Act: Step 4 — Read the 비고 cell of the outbound movement', async () => {
        outbound = lineOf(lines, s.outgoingId);
      });

      await step('Assert: Expected 4 — The outbound 비고 keeps the delivery code at the end', async () => {
        expect(outbound?.note ?? '', `[Expected 4] The outbound 비고 ends with the delivery code ${deliveryCode}`).toMatch(new RegExp(`${deliveryCode}$`));
      });

      let adjustment: HistoryLine | undefined;
      await step('Act: Step 5 — Read the 비고 cell of the adjustment movement', async () => {
        adjustment = lineOf(lines, s.adjustmentId);
      });

      await step('Assert: Expected 5 — The adjustment 비고 keeps the reason and the note', async () => {
        expect(adjustment?.note, '[Expected 5] The adjustment 비고 holds the reason 조정').toContain(ko('reason.ADJUSTMENT'));
        expect(adjustment?.note, '[Expected 5] The adjustment 비고 holds the note').toContain(s.adjustmentNote);
      });
    } finally {
      await removeOutgoing?.();
    }
  });

  test('TC_US134_300 — The date column shows seconds in Seoul time, newest first, whatever the browser time zone', async ({ page, browser, context, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_300',
      'Medium',
      TAGS,
      `3 movements written 10 minutes apart: 날짜 shows YYYY-MM-DD HH:mm:ss in Seoul time (UTC+9), newest at the top; a browser set to UTC shows the same Seoul timestamps; 생성일 on the list uses dots and no time part, so the formats differ on purpose. The 3 movements are stock_usage rows inserted by DB fixture at known UTC instants on the own stock row; the UTC browser is a second context of the same session. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'H300', cj.id, { available: 10 });
    const instants = [minutesAgo(30), minutesAgo(20), minutesAgo(10)];
    const row = list.row(sku.skuCode, cj.name);
    let dates: string[] = [];

    await step('Arrange: Pre-condition 1–2 — Own row in CJ Incheon Aam with 3 movements written at different times', async () => {
      for (const [index, createdAt] of instants.entries()) {
        await seedUsage(sku, cj.id, { refType: 'ADJUSTMENT', type: 'ADJUSTMENT_COMPLETED', before: 10 + index, delta: 1, after: 11 + index, memo: `ADJUSTMENT/TC300 ${index + 1}`, createdAt });
      }
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Click 재고이력 and read the 날짜 (Date) cell of the first row', async () => {
      await list.openHistoryOf(row, 'ko');
      dates = (await list.historyLines()).map((line) => line.date);
    });

    await step('Assert: Expected 1 — The cell shows year-month-day hour:minute:second, seconds included', async () => {
      expect(dates[0], '[Expected 1] The first date has the form YYYY-MM-DD HH:mm:ss').toMatch(HISTORY_DATE_PATTERN);
      expect(dates[0], '[Expected 1] The first date is the newest movement in Seoul time').toBe(kstTimestamp(instants[2]));
    });

    await step('Act: Step 2 — Read the 날짜 column from top to bottom', async () => {
      expect(dates.length, 'The dates are read').toBe(3);
    });

    await step('Assert: Expected 2 — The timestamps run from newest at the top to oldest at the bottom', async () => {
      expect(dates, '[Expected 2] The dates run newest first').toEqual([...instants].reverse().map(kstTimestamp));
    });

    let utcFirst = '';
    await step('Act: Step 3 — Change the browser time zone to UTC, open the dialog again and read the first 날짜 cell', async () => {
      const utc = await browser.newContext({ storageState: await context.storageState(), baseURL: env.baseURL, viewport: { width: 1920, height: 1080 }, timezoneId: 'UTC' });
      try {
        const other = new StockAdjustmentPage(await utc.newPage());
        await other.open('ko');
        await other.findSku(sku);
        await other.openHistoryOf(other.row(sku.skuCode, cj.name), 'ko');
        utcFirst = (await other.historyLines())[0]?.date ?? '';
        await test.info().attach('UTC browser — stock history', { body: await other.history.root.screenshot(), contentType: 'image/png' });
      } finally {
        await utc.close();
      }
    });

    await step('Assert: Expected 3 — The cell still shows the Seoul timestamp, not the UTC one', async () => {
      expect(utcFirst, '[Expected 3] The UTC browser shows the same Seoul timestamp').toBe(dates[0]);
      expect(utcFirst, '[Expected 3] The UTC wall-clock time is not shown').not.toBe(instants[2].toISOString().slice(0, 19).replace('T', ' '));
    });

    let createdAt = '';
    await step('Act: Step 4 — Compare the history date format with the 생성일 (Created date) format on the list', async () => {
      await list.closeHistory();
      createdAt = await list.cellText(row, 'col.createdAt');
    });

    await step('Assert: Expected 4 — History uses hyphens and a time part; 생성일 uses dots and no time part', async () => {
      expect(dates[0], '[Expected 4] The history date uses hyphens and a time part').toMatch(HISTORY_DATE_PATTERN);
      expect(createdAt, '[Expected 4] 생성일 uses dots and has no time part').toMatch(/^\d{4}\.\d{2}\.\d{2}$/);
    });
  });

  test('TC_US134_301 — The type column shows its own label for inbound, outbound and adjustment movements', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_301',
      'Medium',
      TAGS,
      `On a pair with 1 inbound, 1 outbound and 1 adjustment movement the 구분 cell reads 입고 / 출고 / 조정 (EN: Inbound / Outbound / Adjustment) — in Korean, then in English. ${OWN_NOTE} ${FIXTURE_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    let seeds: Awaited<ReturnType<typeof threeKinds>> | undefined;

    await step('Arrange: Pre-condition 1–3 — Own row with 1 inbound, 1 outbound and 1 adjustment movement; Korean then English', async () => {
      seeds = await threeKinds(world, stockApi, 'H301');
    });
    const s = seeds as Awaited<ReturnType<typeof threeKinds>>;

    for (const lang of STOCK_LANGS) {
      const t = (key: StockTextKey) => stx(key, lang);
      const sfx = LANG_SUFFIX[lang];
      let lines: HistoryLine[] = [];
      let type = '';

      await step(`Act: Step 1 — Click 재고이력 (Stock history) on the row ${sfx}`, async () => {
        await list.open(lang);
        await list.findSku(s.sku);
        await list.openHistoryOf(list.row(s.sku.skuCode, s.cj.name), lang);
        lines = await list.historyLines();
      });

      await step(`Assert: Expected 1 — The dialog opens and shows all 3 movements ${sfx}`, async () => {
        expect(lines.length, '[Expected 1] The dialog shows 3 movements').toBe(3);
      });

      await step(`Act: Step 2 — Read the 구분 (Type) cell of the inbound movement ${sfx}`, async () => {
        type = lineOf(lines, s.incomingId)?.refType ?? '';
      });

      await step(`Assert: Expected 2 — The cell shows ${t('usageRef.INCOMING')} ${sfx}`, async () => {
        expect(type, `[Expected 2] The inbound type reads ${t('usageRef.INCOMING')}`).toBe(t('usageRef.INCOMING'));
      });

      await step(`Act: Step 3 — Read the 구분 cell of the outbound movement ${sfx}`, async () => {
        type = lineOf(lines, s.outgoingId)?.refType ?? '';
      });

      await step(`Assert: Expected 3 — The cell shows ${t('usageRef.OUTGOING')} ${sfx}`, async () => {
        expect(type, `[Expected 3] The outbound type reads ${t('usageRef.OUTGOING')}`).toBe(t('usageRef.OUTGOING'));
      });

      await step(`Act: Step 4 — Read the 구분 cell of the adjustment movement ${sfx}`, async () => {
        type = lineOf(lines, s.adjustmentId)?.refType ?? '';
      });

      await step(`Assert: Expected 4 — The cell shows ${t('usageRef.ADJUSTMENT')} ${sfx}`, async () => {
        expect(type, `[Expected 4] The adjustment type reads ${t('usageRef.ADJUSTMENT')}`).toBe(t('usageRef.ADJUSTMENT'));
      });
    }
  });

  test('TC_US134_302 — The detail type column shows all 7 values with an English label', async ({ page, world }) => {
    const step = makeStep(page);
    const details = [
      { type: 'INCOMING_COMPLETED', refType: 'INCOMING' },
      { type: 'HOLD_INCOMING_COMPLETED', refType: 'INCOMING' },
      { type: 'OUTGOING_REQUESTED', refType: 'OUTGOING' },
      { type: 'OUTGOING_COMPLETED', refType: 'OUTGOING' },
      { type: 'OUTGOING_CANCELLED', refType: 'OUTGOING' },
      { type: 'OUTGOING_FAILED', refType: 'OUTGOING' },
      { type: 'ADJUSTMENT_COMPLETED', refType: 'ADJUSTMENT' },
    ] as const;
    await tcMeta(
      'TC_US134_302',
      'Medium',
      TAGS,
      `One movement of each of the 7 detail types shows 7 different 상세구분 values 입고완료 · 보류입고완료 · 출고요청 · 출고완료 · 출고취소 · 출고실패 · 조정완료; 보류입고완료 and 출고실패 appear in Korean and in English (On-hold inbound complete / Outbound failed); no 상세구분 cell is empty. The 7 movements are stock_usage rows inserted by DB fixture on the own stock row (only adjustments can be raised from this admin). ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'H302', cj.id, { available: 50 });
    const row = list.row(sku.skuCode, cj.name);
    let koLines: HistoryLine[] = [];
    let enLines: HistoryLine[] = [];

    await step('Arrange: Pre-condition 1–2 — Own row in CJ Incheon Aam with one movement of each of the 7 detail types', async () => {
      for (const [index, detail] of details.entries()) {
        await seedUsage(sku, cj.id, { refType: detail.refType, type: detail.type, before: 50, delta: 1, after: 51, createdAt: minutesAgo(details.length - index) });
      }
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Click 재고이력 (Stock history) on the row', async () => {
      await list.openHistoryOf(row, 'ko');
      koLines = await list.historyLines();
    });

    await step('Assert: Expected 1 — The dialog opens and shows all 7 movements', async () => {
      expect(koLines.length, '[Expected 1] The dialog shows 7 movements').toBe(7);
    });

    let values: string[] = [];
    await step('Act: Step 2 — Read the 상세구분 (Detail type) cell of every movement and list the different values', async () => {
      values = [...new Set(koLines.map((line) => line.detailType))];
    });

    await step('Assert: Expected 2 — Seven different values, one per detail type', async () => {
      expect(values.length, '[Expected 2] Seven different values appear').toBe(7);
      for (const detail of details) expect(values, `[Expected 2] ${ko(`usageType.${detail.type}`)} appears`).toContain(ko(`usageType.${detail.type}`));
    });

    await step('Act: Step 3 — Read the 2 added values on their own, in the Korean and in the English screen', async () => {
      await list.closeHistory();
      await list.open('en');
      await list.findSku(sku);
      await list.openHistoryOf(row, 'en');
      enLines = await list.historyLines();
    });

    await step('Assert: Expected 3 — 보류입고완료 and 출고실패 appear in both languages', async () => {
      for (const type of ['HOLD_INCOMING_COMPLETED', 'OUTGOING_FAILED'] as const) {
        expect(koLines.map((line) => line.detailType), `[Expected 3] ${ko(`usageType.${type}`)} appears on the Korean screen`).toContain(ko(`usageType.${type}`));
        expect(enLines.map((line) => line.detailType), `[Expected 3] ${stx(`usageType.${type}`, 'en')} appears on the English screen`).toContain(stx(`usageType.${type}`, 'en'));
      }
    });

    let empty: string[] = [];
    await step('Act: Step 4 — Check whether any 상세구분 (Detail type) cell is empty', async () => {
      empty = [...koLines, ...enLines].map((line) => line.detailType).filter((value) => value === '' || value === '-');
    });

    await step('Assert: Expected 4 — No 상세구분 cell is empty', async () => {
      expect(empty, '[Expected 4] No 상세구분 cell is empty').toHaveLength(0);
    });
  });

  test('TC_US134_303 — Scrap-as-defective writes one movement at the source warehouse and one at the defective warehouse', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_303',
      'High',
      TAGS,
      `재고 전환 불량 처리 (보류재고 → 불량) 5 on a CJ Incheon Aam row with on hold 10 shows 등록되었습니다; the newest movement reads 조정 · 불량처리 · -5 at CJ Incheon Aam and 조정 · 불량처리 · +5 at its DEFECTIVE (불량) bucket; the English label is recorded (NEEDS CLARIFICATION, attached as an annotation); both movements share one 번호 that matches no adjustment document. Each table also holds one ordinary adjustment (API, +1) to compare the voucher numbers with. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const defective = world.bucket(cj, '불량');
    const sku = await ownStockSku(world, 'H303', cj.id, { available: 50, hold: 10 });
    await stockDb.upsertStock(sku.skuId, defective.id, { available: 0, hold: 0 });
    const cjRow = list.row(sku.skuCode, cj.name);
    const defectiveRow = list.row(sku.skuCode, defective.name);
    let saved: SaveOutcome | undefined;
    let cjLines: HistoryLine[] = [];
    let defectiveLines: HistoryLine[] = [];
    const english: string[] = [];

    await step('Arrange: Pre-condition 1–3 — Own row in CJ Incheon Aam with on hold 10 and a row in its DEFECTIVE bucket', async () => {
      await apiAdjustment(stockApi, sku, cj, `TC303 CJ ${world.tag}`);
      await apiAdjustment(stockApi, sku, defective, `TC303 DEFECTIVE ${world.tag}`);
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Tick the CJ row, 재고 전환 with 불량 처리 (보류재고 → 불량), type 5 and click 저장 (Save)', async () => {
      await list.openConversion([cjRow]);
      await list.conversion.choosePolicy('SCRAP_DEFECTIVE');
      await list.conversion.fillLine(0, { quantity: '5' });
      saved = await list.save(list.conversion, CONVERT_URL);
    });

    await step('Assert: Expected 1 — The save goes through and shows 등록되었습니다 (Registered.)', async () => {
      expect(saved?.status, '[Expected 1] The conversion is accepted').toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 1] ${REGISTERED} appears`).toContainText(REGISTERED);
    });

    await step('Act: Step 2 — Open 재고이력 on the CJ row and read 구분, 상세구분 and 변경수량 of the newest movement', async () => {
      await list.openHistoryOf(cjRow, 'ko');
      cjLines = await list.historyLines();
    });

    await step('Assert: Expected 2 — 조정 (Adjustment) · 불량처리 · -5', async () => {
      expect(cjLines[0]?.refType, '[Expected 2] 구분 is 조정').toBe(ko('usageRef.ADJUSTMENT'));
      expect(cjLines[0]?.detailType, '[Expected 2] 상세구분 is 불량처리').toBe(ko('usageType.DEFECTIVE_SCRAPPED'));
      expect(cjLines[0]?.change, '[Expected 2] 변경수량 is -5').toBe('-5');
    });

    await step('Act: Step 3 — Close it, open 재고이력 on the DEFECTIVE row and read the same 3 cells', async () => {
      await list.closeHistory();
      await list.openHistoryOf(defectiveRow, 'ko');
      defectiveLines = await list.historyLines();
    });

    await step('Assert: Expected 3 — 조정 (Adjustment) · 불량처리 · +5', async () => {
      expect(defectiveLines[0]?.refType, '[Expected 3] 구분 is 조정').toBe(ko('usageRef.ADJUSTMENT'));
      expect(defectiveLines[0]?.detailType, '[Expected 3] 상세구분 is 불량처리').toBe(ko('usageType.DEFECTIVE_SCRAPPED'));
      expect(defectiveLines[0]?.change, '[Expected 3] 변경수량 is +5').toBe('+5');
    });

    await step('Act: Step 4 — Switch to English, reopen both dialogs and read the 상세구분 of the 2 movements', async () => {
      await list.closeHistory();
      await list.open('en');
      await list.findSku(sku);
      for (const row of [cjRow, defectiveRow]) {
        await list.openHistoryOf(row, 'en');
        english.push((await list.historyLines())[0]?.detailType ?? '');
        await list.closeHistory();
      }
      test.info().annotations.push({ type: 'TC_US134_303 Step 4 observed', description: `English 상세구분: "${english[0]}" (CJ) / "${english[1]}" (DEFECTIVE).` });
    });

    await step('Assert: Expected 4 — NEEDS CLARIFICATION: the English label is recorded', async () => {
      english.forEach((label, index) => expect(label, `[Expected 4] The English 상세구분 of movement ${index + 1} is shown`).not.toBe(''));
    });

    let adjustmentVouchers: string[] = [];
    await step('Act: Step 5 — Compare the 번호 of the 2 newest movements with the voucher numbers of the adjustment rows', async () => {
      adjustmentVouchers = [...cjLines, ...defectiveLines].filter((line) => line.detailType === ko('usageType.ADJUSTMENT_COMPLETED')).map((line) => line.refId);
      adjustmentVouchers.push(...(await stockDb.adjustments(sku.skuId)).map((record) => String(record.id)));
    });

    await step('Assert: Expected 5 — Both movements share one 번호 (the scrap id) that matches no adjustment document', async () => {
      expect(cjLines[0]?.refId, '[Expected 5] Both movements show the same 번호').toBe(defectiveLines[0]?.refId);
      expect(adjustmentVouchers.length, '[Expected 5] The tables hold adjustment rows to compare with').toBeGreaterThan(0);
      expect(adjustmentVouchers, '[Expected 5] The shared 번호 matches no adjustment document').not.toContain(cjLines[0]?.refId);
    });
  });

  test('TC_US134_304 — The change quantity and the before / after columns are shown correctly for each movement', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_304',
      'Medium',
      TAGS,
      `On a row with total = available = 120, an adjustment 증가 10 then 차감 4 (both 조정) save with 등록되었습니다; 재고이력 shows +10 (plus sign printed) with 120 → 130 and -4 with 130 → 126. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'H304', cj.id, { available: 120 });
    const row = list.row(sku.skuCode, cj.name);
    const saves: SaveOutcome[] = [];
    let lines: HistoryLine[] = [];

    await step('Arrange: Pre-condition 1–3 — Own row in CJ Incheon Aam with total 120 / available 120, other buckets 0', async () => {
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Open 재고 조정, save the increase of 10, then save the decrease of 4', async () => {
      for (const [quantity, modifyType] of [['10', 'ADD'], ['4', 'SUBTRACT']] as const) {
        await list.openAdjustment([row]);
        await list.adjustment.fillLine(0, { quantity, modifyType, reason: 'ADJUSTMENT' });
        saves.push(await list.save(list.adjustment, ADJUST_URL));
        await expect(list.lastToast(), `${REGISTERED} appears after the ${modifyType} save`).toContainText(REGISTERED);
      }
    });

    await step('Assert: Expected 1 — Both saves go through and show 등록되었습니다 (Registered.)', async () => {
      expect(saves.map((save) => save.status < 300), '[Expected 1] Both saves are accepted').toEqual([true, true]);
    });

    let increase: HistoryLine | undefined;
    let decrease: HistoryLine | undefined;
    await step('Act: Step 2 — Open 재고이력 and read the 변경수량 cell of the increase movement', async () => {
      await list.openHistoryOf(row, 'ko');
      lines = await list.historyLines();
      increase = lines[1];
    });

    await step('Assert: Expected 2 — The cell shows plus 10 with the plus sign printed', async () => {
      expect(increase?.change, '[Expected 2] The increase shows +10').toBe('+10');
    });

    await step('Act: Step 3 — Read the 변경수량 cell of the decrease movement', async () => {
      decrease = lines[0];
    });

    await step('Assert: Expected 3 — The cell shows minus 4', async () => {
      expect(decrease?.change, '[Expected 3] The decrease shows -4').toBe('-4');
    });

    await step('Act: Step 4 — Read 변경전 수량 and 변경 후 수량 on both movements', async () => {
      expect(lines.length, 'Both movements are listed').toBe(2);
    });

    await step('Assert: Expected 4 — Increase 120 → 130, decrease 130 → 126', async () => {
      expect(increase?.before, '[Expected 4] The increase starts at 120').toBe('120');
      expect(increase?.after, '[Expected 4] The increase ends at 130').toBe('130');
      expect(decrease?.before, '[Expected 4] The decrease starts at 130').toBe('130');
      expect(decrease?.after, '[Expected 4] The decrease ends at 126').toBe('126');
    });
  });

  test('TC_US134_305 — Before and after quantities are measured on the bucket each detail type moves', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_305',
      'Medium',
      TAGS,
      `On a row with total 130 / available 120 / on hold 10: an adjustment +10 (UI) takes total to 140 and its movement reads 130 → 140; an on-hold inbound completion of 5 reads 10 → 15 (on hold); an outbound request of 3 reads 130 → 127 (available); the numbers do not chain from one movement to the next. The on-hold inbound completion and the outbound request come from other stories, so they are raised by DB fixture (stock buckets updated + stock_usage row) as the TC allows; 보류재고 is not a list column and is read from the stock record. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'H305', cj.id, { available: 120, hold: 10 });
    const row = list.row(sku.skuCode, cj.name);
    let saved: SaveOutcome | undefined;
    let total = '';
    let lines: HistoryLine[] = [];

    await step('Arrange: Pre-condition 1–3 — Own row in CJ Incheon Aam with total 130, available 120, on hold 10', async () => {
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Save 재고 조정 10 · 증가 · 조정 and read 전체재고 on the reloaded row', async () => {
      await list.openAdjustment([row]);
      await list.adjustment.fillLine(0, { quantity: '10', modifyType: 'ADD', reason: 'ADJUSTMENT' });
      saved = await list.save(list.adjustment, ADJUST_URL);
      total = await list.cellText(row, 'col.totalQuantity');
    });

    await step('Assert: Expected 1 — 등록되었습니다 appears and 전체재고 shows 140', async () => {
      expect(saved?.status, '[Expected 1] The save is accepted').toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 1] ${REGISTERED} appears`).toContainText(REGISTERED);
      expect(total, '[Expected 1] Total stock shows 140').toBe('140');
    });

    let hold = -1;
    await step('Act: Step 2 — Raise the on-hold inbound completion of 5, then read 보류재고 (On-hold stock)', async () => {
      const adjustedAt = new Date((await stockDb.usages(sku.skuId, cj.id))[0].created_at);
      await stockDb.upsertStock(sku.skuId, cj.id, { available: 130, hold: 15 });
      await seedUsage(sku, cj.id, { refType: 'INCOMING', type: 'HOLD_INCOMING_COMPLETED', before: 10, delta: 5, after: 15, createdAt: new Date(adjustedAt.getTime() + 1_000) });
      await list.refreshSku(sku);
      hold = (await stockDb.stock(sku.skuId, cj.id))?.hold_quantity ?? -1;
    });

    await step('Assert: Expected 2 — 보류재고 (On-hold stock) shows 15', async () => {
      expect(hold, '[Expected 2] On-hold stock is 15').toBe(15);
    });

    const available = { before: '', after: '' };
    await step('Act: Step 3 — Read 가용재고, raise the outbound request of 3, then read 가용재고 again', async () => {
      available.before = await list.cellText(row, 'col.availableQuantity');
      const holdAt = new Date((await stockDb.usages(sku.skuId, cj.id))[0].created_at);
      await stockDb.upsertStock(sku.skuId, cj.id, { available: 127, hold: 15, reserved: 3 });
      await seedUsage(sku, cj.id, { refType: 'OUTGOING', type: 'OUTGOING_REQUESTED', before: 130, delta: -3, after: 127, createdAt: new Date(holdAt.getTime() + 1_000) });
      await list.refreshSku(sku);
      available.after = await list.cellText(row, 'col.availableQuantity');
    });

    await step('Assert: Expected 3 — 가용재고 falls by 3, from 130 to 127', async () => {
      expect(available.before, '[Expected 3] Available stock is 130 before the outbound request').toBe('130');
      expect(available.after, '[Expected 3] Available stock is 127 after the outbound request').toBe('127');
    });

    const byType = (type: string) => lines.find((line) => line.detailType === ko(`usageType.${type}` as StockTextKey));
    await step('Act: Step 4 — Open 재고이력 and read before / after of the 조정완료 (Adjustment complete) movement', async () => {
      await list.openHistoryOf(row, 'ko');
      lines = await list.historyLines();
    });

    await step('Assert: Expected 4 — 130 and 140, the total stock before and after step 1', async () => {
      expect(byType('ADJUSTMENT_COMPLETED')?.before, '[Expected 4] 조정완료 before is 130').toBe('130');
      expect(byType('ADJUSTMENT_COMPLETED')?.after, '[Expected 4] 조정완료 after is 140').toBe('140');
    });

    await step('Act: Step 5 — Read the same 2 cells on the 보류입고완료 (On-hold inbound complete) movement', async () => {
      expect(byType('HOLD_INCOMING_COMPLETED'), 'The 보류입고완료 movement is listed').toBeDefined();
    });

    await step('Assert: Expected 5 — 10 and 15, the on-hold stock before and after step 2', async () => {
      expect(byType('HOLD_INCOMING_COMPLETED')?.before, '[Expected 5] 보류입고완료 before is 10').toBe('10');
      expect(byType('HOLD_INCOMING_COMPLETED')?.after, '[Expected 5] 보류입고완료 after is 15').toBe('15');
    });

    await step('Act: Step 6 — Read the same 2 cells on the 출고요청 (Outbound requested) movement', async () => {
      expect(byType('OUTGOING_REQUESTED'), 'The 출고요청 movement is listed').toBeDefined();
    });

    await step('Assert: Expected 6 — 130 and 127, the available stock before and after step 3', async () => {
      expect(byType('OUTGOING_REQUESTED')?.before, '[Expected 6] 출고요청 before is 130').toBe('130');
      expect(byType('OUTGOING_REQUESTED')?.after, '[Expected 6] 출고요청 after is 127').toBe('127');
    });

    await step('Act: Step 7 — Compare the after of each movement with the before of the next newer movement', async () => {
      expect(lines.map((line) => line.detailType), 'The 3 movements run newest first').toEqual(['OUTGOING_REQUESTED', 'HOLD_INCOMING_COMPLETED', 'ADJUSTMENT_COMPLETED'].map((type) => ko(`usageType.${type}` as StockTextKey)));
    });

    await step('Assert: Expected 7 — The numbers do not chain (140 against 10, 15 against 130), as expected', async () => {
      expect(byType('ADJUSTMENT_COMPLETED')?.after, '[Expected 7] 조정완료 after (140) differs from 보류입고완료 before').not.toBe(byType('HOLD_INCOMING_COMPLETED')?.before);
      expect(byType('HOLD_INCOMING_COMPLETED')?.after, '[Expected 7] 보류입고완료 after (15) differs from 출고요청 before').not.toBe(byType('OUTGOING_REQUESTED')?.before);
    });
  });

  test('TC_US134_306 — Remarks, operator and operator IP show a dash when they are empty', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_306',
      'Medium',
      TAGS,
      `An operator-made movement (adjustment through the API with a note) shows a remark, an operator id and an IP address; a fixture movement with 비고 NULL, 작업자 '' and 작업자 ip '' shows a dash in all 3 cells — none is left blank. The fixture movement is a stock_usage row inserted by DB on the own stock row. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'H306', cj.id, { available: 50 });
    let operatorRef = '';
    let fixtureRef = '';
    let lines: HistoryLine[] = [];

    await step('Arrange: Pre-condition 1–2 — Own row with 1 operator movement with a remark and 1 fixture movement with empty remark / operator / IP', async () => {
      fixtureRef = String(await seedUsage(sku, cj.id, { refType: 'ADJUSTMENT', type: 'ADJUSTMENT_COMPLETED', before: 50, delta: 1, after: 51, memo: null, createdBy: '', createdIp: '', createdAt: minutesAgo(5) }));
      operatorRef = await apiAdjustment(stockApi, sku, cj, `Operator remark ${world.tag}`);
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Click 재고이력 (Stock history) on the row', async () => {
      await list.openHistoryOf(list.row(sku.skuCode, cj.name), 'ko');
      lines = await list.historyLines();
    });

    await step('Assert: Expected 1 — The dialog opens and shows both movements', async () => {
      expect(lineOf(lines, operatorRef), '[Expected 1] The operator movement is listed').toBeDefined();
      expect(lineOf(lines, fixtureRef), '[Expected 1] The fixture movement is listed').toBeDefined();
    });

    let made: HistoryLine | undefined;
    await step('Act: Step 2 — Read 비고, 작업자 and 작업자 ip on the operator-made movement', async () => {
      made = lineOf(lines, operatorRef);
    });

    await step('Assert: Expected 2 — All 3 cells have real values: a remark, an operator id and an IP address', async () => {
      expect(made?.note, '[Expected 2] 비고 holds the remark').toContain(`Operator remark ${world.tag}`);
      expect(made?.operator ?? '-', '[Expected 2] 작업자 holds an operator id').not.toMatch(/^-?$/);
      expect(made?.operatorIp ?? '', '[Expected 2] 작업자 ip holds an IP address').toMatch(IP_PATTERN);
    });

    let fixture: HistoryLine | undefined;
    await step('Act: Step 3 — Read the same 3 cells on the fixture movement', async () => {
      fixture = lineOf(lines, fixtureRef);
    });

    await step('Assert: Expected 3 — All 3 cells show a dash', async () => {
      expect(fixture?.note, '[Expected 3] 비고 shows a dash').toBe('-');
      expect(fixture?.operator, '[Expected 3] 작업자 shows a dash').toBe('-');
      expect(fixture?.operatorIp, '[Expected 3] 작업자 ip shows a dash').toBe('-');
    });

    let blanks: string[] = [];
    await step('Act: Step 4 — Check whether any of those 3 empty cells is left blank instead of showing a dash', async () => {
      blanks = fixture ? (['note', 'operator', 'operatorIp'] as const).filter((key) => fixture?.[key] === '') : ['note', 'operator', 'operatorIp'];
    });

    await step('Assert: Expected 4 — None of the 3 is left blank', async () => {
      expect(blanks, '[Expected 4] No empty cell is left blank').toHaveLength(0);
    });
  });

  test('TC_US134_307 — An adjustment made on this screen shows its remark, operator and IP in the history', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_307',
      'High',
      TAGS,
      `Saving 10 · 증가 · 실사 · "Demo quarterly count" on a row with total = available = 120 shows 등록되었습니다; the newest movement reads 조정 · 조정완료, 비고 "실사/Demo quarterly count", 작업자 = the logged-in account id (read from the session at run time), 작업자 ip = an IP address (the workstation IP is not known to the test, so its form is checked), and 120 · +10 · 130. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'H307', cj.id, { available: 120 });
    const row = list.row(sku.skuCode, cj.name);
    let saved: SaveOutcome | undefined;
    let newest: HistoryLine | undefined;

    await step('Arrange: Pre-condition 1–3 — Own row in CJ Incheon Aam with total 120 / available 120; test data 10 · 증가 · 실사 · Demo quarterly count', async () => {
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Tick the row, open 재고 조정, fill the test data and click 저장 (Save)', async () => {
      await list.openAdjustment([row]);
      await list.adjustment.fillLine(0, { quantity: '10', modifyType: 'ADD', reason: 'TAKING', note: 'Demo quarterly count' });
      saved = await list.save(list.adjustment, ADJUST_URL);
    });

    await step('Assert: Expected 1 — The save goes through and shows 등록되었습니다 (Registered.)', async () => {
      expect(saved?.status, '[Expected 1] The save is accepted').toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 1] ${REGISTERED} appears`).toContainText(REGISTERED);
    });

    await step('Act: Step 2 — Open 재고이력 and read 구분 and 상세구분 of the newest movement', async () => {
      await list.openHistoryOf(row, 'ko');
      newest = (await list.historyLines())[0];
    });

    await step('Assert: Expected 2 — 조정 (Adjustment) and 조정완료 (Adjustment complete)', async () => {
      expect(newest?.refType, '[Expected 2] 구분 is 조정').toBe(ko('usageRef.ADJUSTMENT'));
      expect(newest?.detailType, '[Expected 2] 상세구분 is 조정완료').toBe(ko('usageType.ADJUSTMENT_COMPLETED'));
    });

    await step('Act: Step 3 — Read its 비고 (Remarks) cell', async () => {
      expect(newest, 'The newest movement is read').toBeDefined();
    });

    await step('Assert: Expected 3 — The cell shows 실사/Demo quarterly count', async () => {
      expect(newest?.note, '[Expected 3] 비고 reads {reason}/{memo} = 실사/Demo quarterly count').toBe(`${ko('reason.TAKING')}/Demo quarterly count`);
    });

    await step('Act: Step 4 — Read its 작업자 (Operator) and 작업자 ip (Operator IP) cells', async () => {
      expect(newest, 'The newest movement is read').toBeDefined();
    });

    await step('Assert: Expected 4 — The logged-in account id and the workstation IP, not a dash and not a system account', async () => {
      expect(newest?.operator, '[Expected 4] 작업자 is the logged-in account').toContain(getAccountDisplayName('submitter'));
      expect(newest?.operator, '[Expected 4] 작업자 is not the automation fixture account').not.toBe(DB_ACTOR.by);
      expect(newest?.operatorIp ?? '', '[Expected 4] 작업자 ip is an IP address').toMatch(IP_PATTERN);
      expect(newest?.operatorIp, '[Expected 4] 작업자 ip is not a dash').not.toBe('-');
    });

    await step('Act: Step 5 — Read its 변경전 수량, 변경수량 and 변경 후 수량 cells', async () => {
      expect(newest, 'The newest movement is read').toBeDefined();
    });

    await step('Assert: Expected 5 — 120, +10 and 130', async () => {
      expect(newest?.before, '[Expected 5] 변경전 수량 is 120').toBe('120');
      expect(newest?.change, '[Expected 5] 변경수량 is +10').toBe('+10');
      expect(newest?.after, '[Expected 5] 변경 후 수량 is 130').toBe('130');
    });
  });

  test('TC_US134_308 — An empty table and no error are shown when the pair has no movements yet', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_308',
      'Medium',
      TAGS,
      `A stock row in CJ Daegu with no movement still has a 재고이력 button; the dialog shows the 10 headers with no data row, the context line names the SKU name, the SKU code and the warehouse, the 엑셀 다운로드 button is there, and there is no error. DEMO-SKU-0012 is a set SKU, which holds no stock of its own, so the pair is played by the test's own physical SKU with a stock row seeded by DB (the seed writes no movement). ${OWN_NOTE} ${DAEGU_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const daegu = daeguOf(world);
    const sku = await ownStockSku(world, 'H308', daegu.id, { available: 5 });
    const row = list.row(sku.skuCode, daegu.name);
    let headers: string[] = [];
    let lines: HistoryLine[] = [];
    let context = '';

    await step('Arrange: Pre-condition 1–2 — Own stock row in CJ Daegu warehouse with a 재고이력 button and no movement', async () => {
      await list.open('ko');
      await list.findSku(sku);
      await expect(row.getByRole('button', { name: new RegExp(ko('btn.stockHistory')) }), 'The row has a 재고이력 button').toBeVisible();
    });

    await step('Act: Step 1 — Click 재고이력 (Stock history) on the row', async () => {
      await list.openHistoryOf(row, 'ko');
    });

    await step('Assert: Expected 1 — The dialog opens', async () => {
      await expect(list.history.root, '[Expected 1] The stock history dialog is open').toBeVisible();
    });

    await step('Act: Step 2 — Read the table area', async () => {
      headers = await list.history.headerTexts();
      lines = await list.historyLines();
    });

    await step('Assert: Expected 2 — The column headers are still shown and there are no data rows', async () => {
      expect(headers.length, '[Expected 2] The 10 column headers are shown').toBe(10);
      expect(lines, '[Expected 2] There is no data row').toHaveLength(0);
    });

    await step('Act: Step 3 — Read the context line and the 엑셀 다운로드 (Excel download) button', async () => {
      context = await list.historyContext();
    });

    await step('Assert: Expected 3 — The context line names SKU name, SKU code and CJ Daegu warehouse; the download button is there', async () => {
      expect(context, '[Expected 3] The context line names the SKU name, the SKU code and the warehouse').toBe(contextLine(sku, daegu));
      await expect(list.history.exportButton, `[Expected 3] ${ko('btn.exportStockExcel')} is on the dialog`).toBeVisible();
    });

    await step('Act: Step 4 — Look for any error message or error state on the dialog', async () => {
      await expect(list.history.body, 'The dialog body is shown').toBeVisible();
    });

    await step('Assert: Expected 4 — There is no error message and no error state', async () => {
      await expect(list.history.body.locator('.alert-danger'), '[Expected 4] No error message is shown').toHaveCount(0);
      await expect(list.history.body.getByText(ko('msg.loadHistoryFailed')), '[Expected 4] No load error is shown').toHaveCount(0);
    });
  });

  test('TC_US134_309 — The dialog paging is separate from the list paging and returns to page 1 when reopened', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_309',
      'Medium',
      TAGS,
      `With the list on 10 rows per page over 2 pages: after moving the list to page 2 and back, the 재고이력 dialog opens on its page 1; its page 2 shows the next movements; after 닫기 the list stays on its page and the reopened dialog is back on page 1. Data: the test builds its own SKU group of 11 stocked SKUs (2 list pages) and gives the first-listed SKU 12 movements (stock_usage rows inserted by DB, 2 dialog pages). ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const lines = await ownSkuLines(world, 'H309', 11);
    for (const sku of lines) await stockDb.upsertStock(sku.skuId, cj.id, { available: 10 });
    let target = lines[0];
    const pages = { opened: '', second: '', secondLines: 0, list: '', reopened: '' };

    await step('Arrange: Pre-condition 1–3 — 2 list pages at 10 rows per page; the first-listed SKU has more than 1 page of history', async () => {
      const first = (await stockApi.stockStatus({ searchType: 'SKU_GROUP_NAME', keyword: ownGroupName(world, 'H309'), size: 10 })).body.items[0];
      target = lines.find((sku) => sku.skuId === first?.skuId) ?? lines[0];
      await seedAdjustmentUsages(target, cj.id, 12);
      await list.open('ko');
      await list.findGroup(world, 'H309');
      await expect(list.pagination.getByRole('button', { name: '2', exact: true }), 'The list has a page 2').toBeVisible();
    });

    await step('Act: Step 1 — Move the list to page 2, go back to page 1 and click 재고이력 on the SKU', async () => {
      await list.goToPage('2');
      await list.goToPage('1');
      await list.openHistoryOf(list.row(target.skuCode, cj.name), 'ko');
    });

    await step('Assert: Expected 1 — The dialog opens', async () => {
      await expect(list.history.root, '[Expected 1] The stock history dialog is open').toBeVisible();
    });

    await step("Act: Step 2 — Read which page the dialog's paging is on", async () => {
      pages.opened = await list.historyActivePage();
    });

    await step("Assert: Expected 2 — The dialog's paging is on page 1", async () => {
      expect(pages.opened, '[Expected 2] The dialog opens on page 1').toBe('1');
    });

    await step('Act: Step 3 — Move the dialog to page 2 of the history, then click 닫기 (Close)', async () => {
      await list.historyGoToPage('2');
      pages.second = await list.historyActivePage();
      pages.secondLines = (await list.historyLines()).length;
      await test.info().attach('History page 2', { body: await list.history.root.screenshot(), contentType: 'image/png' });
      await list.closeHistory();
    });

    await step('Assert: Expected 3 — The dialog showed the second page of movements', async () => {
      expect(pages.second, '[Expected 3] The dialog was on page 2').toBe('2');
      expect(pages.secondLines, '[Expected 3] Page 2 holds the remaining 2 movements').toBe(2);
    });

    await step('Act: Step 4 — Read which page the list is on, then reopen the same 재고이력 and read its page', async () => {
      pages.list = await list.listActivePage();
      await list.openHistoryOf(list.row(target.skuCode, cj.name), 'ko');
      pages.reopened = await list.historyActivePage();
    });

    await step('Assert: Expected 4 — The list is still on its page and the reopened dialog is back on page 1', async () => {
      expect(pages.list, '[Expected 4] The list is still on page 1').toBe('1');
      expect(pages.reopened, '[Expected 4] The reopened dialog is on page 1').toBe('1');
    });
  });

  test('TC_US134_310 — A different history is shown when the same SKU is opened in each warehouse', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_310',
      'High',
      TAGS,
      `Saving 1 · 증가 · 조정 · "Incheon only" on the CJ Incheon Aam row shows 등록되었습니다; its newest 비고 holds 조정 and Incheon only; the CJ Daegu row of the same SKU opens a dialog naming CJ Daegu warehouse with no movement whose 비고 contains Incheon only. ${OWN_NOTE} ${DAEGU_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const daegu = daeguOf(world);
    const sku = await ownStockSku(world, 'H310', cj.id, { available: 30 });
    await stockDb.upsertStock(sku.skuId, daegu.id, { available: 40 });
    let saved: SaveOutcome | undefined;
    let note = '';
    let daeguLines: HistoryLine[] = [];
    let context = '';

    await step('Arrange: Pre-condition 1–3 — Own SKU in CJ Incheon Aam and CJ Daegu; test data 1 · 증가 · 조정 · Incheon only', async () => {
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Tick the CJ Incheon Aam row, open 재고 조정 and save the test data', async () => {
      await list.openAdjustment([list.row(sku.skuCode, cj.name)]);
      await list.adjustment.fillLine(0, { quantity: '1', modifyType: 'ADD', reason: 'ADJUSTMENT', note: 'Incheon only' });
      saved = await list.save(list.adjustment, ADJUST_URL);
    });

    await step('Assert: Expected 1 — The save goes through and shows 등록되었습니다 (Registered.)', async () => {
      expect(saved?.status, '[Expected 1] The save is accepted').toBeLessThan(300);
      await expect(list.lastToast(), `[Expected 1] ${REGISTERED} appears`).toContainText(REGISTERED);
    });

    await step('Act: Step 2 — Click 재고이력 on the CJ Incheon Aam row and read the 비고 of the newest movement', async () => {
      await list.openHistoryOf(list.row(sku.skuCode, cj.name), 'ko');
      note = (await list.historyLines())[0]?.note ?? '';
    });

    await step('Assert: Expected 2 — The cell holds the reason 조정 and the memo Incheon only', async () => {
      expect(note, '[Expected 2] 비고 holds the reason 조정').toContain(ko('reason.ADJUSTMENT'));
      expect(note, '[Expected 2] 비고 holds the memo Incheon only').toContain('Incheon only');
    });

    await step('Act: Step 3 — Close the dialog and click 재고이력 on the CJ Daegu warehouse row', async () => {
      await list.closeHistory();
      await list.openHistoryOf(list.row(sku.skuCode, daegu.name), 'ko');
      context = await list.historyContext();
      daeguLines = await list.historyLines();
    });

    await step('Assert: Expected 3 — The dialog opens with a context line naming CJ Daegu warehouse', async () => {
      expect(context, '[Expected 3] The context line names CJ Daegu warehouse').toBe(contextLine(sku, daegu));
    });

    await step('Act: Step 4 — Look for any movement whose 비고 contains Incheon only', async () => {
      expect(daeguLines, 'The Daegu movements are read').toBeDefined();
    });

    await step('Assert: Expected 4 — No such movement is listed', async () => {
      expect(daeguLines.filter((line) => line.note.includes('Incheon only')), '[Expected 4] No movement of the Daegu pair mentions Incheon only').toHaveLength(0);
    });
  });

  test('TC_US134_311 — The history dialog closes with no question on Close and on a backdrop click', async ({ page, world }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_311',
      'Low',
      TAGS,
      `재고이력 moved to page 2 closes at once on 닫기 with no confirm box and also closes on a click on the grey backdrop; the 재고 조정 dialog with a typed value does NOT close on a backdrop click. Data: the own SKU gets 11 movements (stock_usage rows inserted by DB) so the history has a page 2. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'H311', cj.id, { available: 20 });
    const row = list.row(sku.skuCode, cj.name);

    await step('Arrange: Pre-condition 1–2 — Own row in CJ Incheon Aam with stock history movements over 2 pages', async () => {
      await seedAdjustmentUsages(sku, cj.id, 11);
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Open 재고이력, move to page 2 of the history, then click 닫기 (Close)', async () => {
      await list.openHistoryOf(row, 'ko');
      await list.historyGoToPage('2');
      await list.history.close();
    });

    await step('Assert: Expected 1 — The dialog closes at once', async () => {
      await list.history.expectClosed();
    });

    await step('Act: Step 2 — Look for any confirm dialog', async () => {
      await expect(list.table, 'The list is shown').toBeVisible();
    });

    await step('Assert: Expected 2 — No confirm dialog appears', async () => {
      await expect(page.locator('.modal.show'), '[Expected 2] No dialog of any kind is open').toHaveCount(0);
      await expect(page.getByText(ko('msg.closeWithoutSaving')), '[Expected 2] No close-without-saving question is shown').toHaveCount(0);
    });

    await step('Act: Step 3 — Open the dialog again and click the grey backdrop outside it', async () => {
      await list.openHistoryOf(row, 'ko');
      await list.history.root.click({ position: { x: 10, y: 10 } });
    });

    await step('Assert: Expected 3 — The dialog closes', async () => {
      await list.history.expectClosed();
    });

    await step('Act: Step 4 — Open 재고 조정 instead, type a value and click the backdrop outside it', async () => {
      await list.openAdjustment([row]);
      await list.adjustment.fillLine(0, { quantity: '5' });
      await list.adjustment.root.click({ position: { x: 10, y: 10 } });
    });

    await step('Assert: Expected 4 — The stock adjustment dialog does NOT close on a backdrop click', async () => {
      await expect(list.adjustment.root, '[Expected 4] The stock adjustment dialog stays open').toBeVisible();
      await expect(list.adjustment.quantityInput(0), '[Expected 4] The typed value is kept').toHaveValue('5');
    });
  });

  test('TC_US134_312 — Stock History is read-only and exposes no stock-changing action', async ({ page, world, stockApi }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US134_312',
      'Medium',
      TAGS,
      `재고이력 of a row with 1 movement offers only 엑셀 다운로드 and 닫기 (plus the page controls); no cell takes a change, there is no create / update / delete / 재고 조정 / 재고 전환 action, and after closing the stock quantities and the movement count are unchanged. The header ✕ is counted as a close control and the 페이지당 select as a page control. ${OWN_NOTE}`,
    );
    const list = new StockAdjustmentPage(page);
    const cj: WorldWarehouse = world.warehouses.CJ;
    const sku = await ownStockSku(world, 'H312', cj.id, { available: 50 });
    const row = list.row(sku.skuCode, cj.name);
    let baseline = { available: -1, physical: -1, usages: -1 };
    const readState = async () => {
      const stock = await stockDb.stock(sku.skuId, cj.id);
      return { available: stock?.available_quantity ?? -1, physical: stock?.physical_quantity ?? -1, usages: (await stockDb.usages(sku.skuId, cj.id)).length };
    };

    await step('Arrange: Pre-condition 1–3 — Own row with 1 movement; the stock quantities and movement count are recorded', async () => {
      await apiAdjustment(stockApi, sku, cj, `TC312 ${world.tag}`);
      baseline = await readState();
      await list.open('ko');
      await list.findSku(sku);
    });

    await step('Act: Step 1 — Click 재고이력 (Stock history) on the row', async () => {
      await list.openHistoryOf(row, 'ko');
    });

    await step('Assert: Expected 1 — The 재고이력 dialog opens for the selected stock row', async () => {
      expect(await list.historyContext(), '[Expected 1] The dialog is for the selected row').toBe(contextLine(sku, cj));
    });

    let buttons: string[] = [];
    let fields = { inputs: 0, selects: 0 };
    await step('Act: Step 2 — Inspect the context line, the movement rows and every control in the dialog', async () => {
      buttons = await list.history.root.locator('button').evaluateAll((all) =>
        all.filter((button) => !button.closest('.pagination') && !button.classList.contains('btn-close')).map((button) => (button.textContent ?? '').trim()),
      );
      fields = {
        inputs: await list.history.root.locator('input, textarea, [contenteditable="true"]').count(),
        selects: await list.history.root.locator('select').count(),
      };
    });

    await step('Assert: Expected 2 — The only controls are 엑셀 다운로드, 닫기 and the page controls', async () => {
      expect(buttons, '[Expected 2] The only buttons are 엑셀 다운로드 and 닫기').toEqual([ko('btn.exportStockExcel'), ko('btn.close')]);
      expect(fields.inputs, '[Expected 2] The dialog has no input field').toBe(0);
      expect(fields.selects, '[Expected 2] The only select is the 페이지당 page control').toBeLessThanOrEqual(1);
    });

    const cells = { before: [] as string[], after: [] as string[], editable: -1 };
    await step('Act: Step 3 — Click a movement row and try to change a displayed value', async () => {
      const first = list.history.rows.first();
      cells.before = (await first.locator('td').allTextContents()).map((text) => text.trim());
      await first.locator('td').nth(6).click();
      await page.keyboard.type('99');
      cells.after = (await first.locator('td').allTextContents()).map((text) => text.trim());
      cells.editable = await list.history.table.locator('input, select, textarea, [contenteditable="true"]').count();
    });

    await step('Assert: Expected 3 — No cell, field or row takes any change', async () => {
      expect(cells.after, '[Expected 3] The movement row is unchanged').toEqual(cells.before);
      expect(cells.editable, '[Expected 3] The table holds no editable field').toBe(0);
    });

    let actions = -1;
    await step('Act: Step 4 — Look for create, update, delete, 재고 조정 and 재고 전환 actions', async () => {
      actions = await list.history.root.getByRole('button', { name: new RegExp(`${ko('btn.adjustStock')}|${ko('btn.convertStock')}|${ko('btn.save')}|추가|등록|생성|수정|삭제|Create|Edit|Delete`) }).count();
    });

    await step('Assert: Expected 4 — There is no create, update, delete, 재고 조정 or 재고 전환 action in the dialog', async () => {
      expect(actions, '[Expected 4] The dialog offers no stock-changing action').toBe(0);
    });

    let after = { available: -2, physical: -2, usages: -2 };
    await step('Act: Step 5 — Close the dialog and read the stock quantities and the movement count again', async () => {
      await list.closeHistory();
      after = await readState();
    });

    await step('Assert: Expected 5 — Both stock quantities and the movement count are unchanged', async () => {
      expect(after.available, '[Expected 5] Available stock is unchanged').toBe(baseline.available);
      expect(after.physical, '[Expected 5] Total stock is unchanged').toBe(baseline.physical);
      expect(after.usages, '[Expected 5] The movement count is unchanged').toBe(baseline.usages);
    });
  });
});
