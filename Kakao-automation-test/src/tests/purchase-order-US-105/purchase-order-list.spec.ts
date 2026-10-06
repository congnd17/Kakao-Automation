import { test, expect } from '@fixtures/purchase-order.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { PO_KO } from '@utils/purchase-order.i18n';
import { PurchaseOrderApi } from '@api/purchase-order.api';
import { PoData, seoulToday, SUPPLIER } from '@utils/purchase-order.data';
import { QUICK_RANGES } from '@pages/purchase-order-list.page';

/**
 * Màn 발주 목록 (US105) — tìm kiếm, filter, phân trang, sắp xếp. TC cần "đúng N PO của 1 공급처" dùng 1 공급처 ACTIVE chưa
 * có PO nào trên dev (tra lúc chạy) để số đếm không lẫn dữ liệu của người khác; TC cần "chỉ PO trạng thái X" lọc thêm theo
 * kho automation của lần chạy. Mọi PO do test tạo bị dọn ở teardown (fixture `poData`).
 */
const TAGS = ['list', 'purchase-order'];

/** 공급처 ACTIVE có tên duy nhất và chưa có PO nào khớp tìm kiếm theo tên — dùng cho TC đếm số dòng. */
async function freshSupplier(api: PurchaseOrderApi): Promise<{ id: number; name: string }> {
  const partners = (await api.bizPartners()).filter((p) => p.contractStatus === 'ACTIVE' && p.companyNames.ko);
  for (const partner of partners) {
    const name = partner.companyNames.ko as string;
    if (partners.filter((p) => (p.companyNames.ko ?? '').includes(name) || (p.companyNames.en ?? '').includes(name)).length > 1) continue;
    const { body } = await api.list({ searchType: 'SUPPLIER', keyword: name }, 0, 10);
    if (body.paging.totalCount === 0) return { id: partner.id, name };
  }
  throw new Error('Test data setup failed — no ACTIVE supplier without purchase orders is left on dev');
}

async function draftsFor(poData: PoData, supplierId: number, count: number, orderDate?: string): Promise<string[]> {
  const numbers: string[] = [];
  for (let i = 0; i < count; i += 1) numbers.push((await poData.createDraft([{}], { supplierId, ...(orderDate ? { orderDate } : {}) })).poNo);
  return numbers;
}

test.describe('[List] 발주 목록 — search, filters, paging and sorting', () => {
  test.describe.configure({ timeout: 240_000 });

  test('TC_US105_019 — Search runs only on Search or Enter, across all three search types', async ({ page, poList, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_019', 'Medium', TAGS, 'Typing never re-runs the query; Search narrows to the matching PO numbers; Biz partner + Enter narrows to the supplier (ko or en snapshot, case-insensitive substring); SKU code + Enter (barcode) narrows to PO A.');
    const po = await poData.createDraft();
    let requests = 0;

    await step('Arrange: Pre-condition 1–2 — PO A for Supplier A (스타쉽엔터테인먼트) with a line for SKU A; PO number and barcode noted', async () => {
      await poList.open();
      page.on('request', (r) => /\/api\/v1\/purchase-orders\?/.test(r.url()) && (requests += 1));
    });

    let rowsBefore: string[] = [];
    await step('Act: Step 1 — Leave the search type at PO no. and type part of the PO A number progressively', async () => {
      rowsBefore = await poList.columnTexts(PO_KO['col.poList.poNo']);
      requests = 0;
      await poList.keywordInput.pressSequentially(po.poNo.slice(-6), { delay: 50 });
    });

    await step('Assert: Expected 1 — The table is unchanged; no query is re-run while typing', async () => {
      expect(requests, '[Expected 1] No list request is sent while typing').toBe(0);
      expect(await poList.columnTexts(PO_KO['col.poList.poNo']), '[Expected 1] The table is unchanged').toEqual(rowsBefore);
    });

    await step('Act: Step 2 — Click 검색 (Search)', async () => {
      await poList.search();
    });

    await step('Assert: Expected 2 — The table narrows to exactly the POs whose number matches', async () => {
      const numbers = await poList.columnTexts(PO_KO['col.poList.poNo']);
      expect(numbers, '[Expected 2] PO A is listed').toContain(po.poNo);
      expect(numbers.filter((no) => !no.includes(po.poNo.slice(-6))), '[Expected 2] Every row matches the typed string').toEqual([]);
    });

    await step('Act: Step 3 — Switch the search type to Biz partner, type part of the Supplier A name and press Enter', async () => {
      await poList.searchTypeSelect.selectOption({ label: PO_KO['searchType.SUPPLIER'] });
      await poList.keywordInput.fill('starship');
      const response = poList.waitForListRequest();
      await poList.keywordInput.press('Enter');
      await response;
      await poList.waitForRows();
    });

    await step('Assert: Expected 3 — The table narrows to the POs of Supplier A (ko OR en snapshot, case-insensitive)', async () => {
      const suppliers = await poList.columnTexts(PO_KO['col.poList.supplier']);
      expect(suppliers.length, '[Expected 3] Rows are returned').toBeGreaterThan(0);
      expect(suppliers.filter((s) => !/스타쉽|starship/i.test(s)), '[Expected 3] Every row belongs to the matching supplier').toEqual([]);
      expect(await poList.columnTexts(PO_KO['col.poList.poNo']), '[Expected 3] PO A is found through its English name').toContain(po.poNo);
    });

    await step('Act: Step 4 — Switch the search type to SKU code, type the SKU A barcode and press Enter', async () => {
      await poList.searchTypeSelect.selectOption({ label: PO_KO['searchType.SKU_CODE'] });
      await poList.keywordInput.fill(poData.warehouse.skus.A.barcode);
      await poList.warehouseSelect.selectOption({ label: poData.warehouse.name });
      const response = poList.waitForListRequest();
      await poList.keywordInput.press('Enter');
      await response;
      await poList.waitForRows();
    });

    await step('Assert: Expected 4 — The table narrows to PO A', async () => {
      expect(await poList.columnTexts(PO_KO['col.poList.poNo']), '[Expected 4] PO A is found by the SKU barcode').toContain(po.poNo);
    });
  });

  test('TC_US105_020 — Reset clears pending and applied values, returns to page 1 and re-runs the query', async ({ page, poList }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_020', 'Medium', TAGS, 'Issued filter applied; a keyword typed on page 2 has no effect until searched; Reset empties the keyword, puts Status back to All and shows every PO again on page 1 without clicking Search.');

    await step('Arrange: Pre-condition 1–2 — At least 12 POs across the four statuses (dev holds 29+)', async () => {
      await poList.open();
    });

    await step('Act: Step 1 — Set Status to Issued and click 검색', async () => {
      await poList.statusSelect.selectOption('ISSUED');
      await poList.search();
    });

    await step('Assert: Expected 1 — The table holds only Issued POs', async () => {
      const statuses = await poList.columnTexts(PO_KO['col.poList.status']);
      expect(statuses.length, '[Expected 1] Issued rows exist').toBeGreaterThan(0);
      expect(statuses.filter((s) => s.trim() !== PO_KO['poStatus.ISSUED']), '[Expected 1] Only Issued rows').toEqual([]);
    });

    let page2: string[] = [];
    await step('Act: Step 2 — Go to page 2, then type any keyword without clicking 검색', async () => {
      await poList.statusSelect.selectOption('');
      await poList.search();
      const response = poList.waitForListRequest();
      await poList.pageButton('2').click();
      await response;
      page2 = await poList.columnTexts(PO_KO['col.poList.poNo']);
      await poList.keywordInput.fill('ZZZZ-NOT-SEARCHED');
    });

    await step('Assert: Expected 2 — The keyword just typed has not affected the table', async () => {
      expect(await poList.columnTexts(PO_KO['col.poList.poNo']), '[Expected 2] Page 2 rows are unchanged').toEqual(page2);
    });

    await step('Act: Step 3 — Click 초기화 (Reset)', async () => {
      const response = poList.waitForListRequest();
      await poList.resetButton.click();
      await response;
      await poList.waitForRows();
    });

    await step('Assert: Expected 3 — Keyword empty, Status All, every PO shown on page 1 without Search', async () => {
      await expect(poList.keywordInput, '[Expected 3] Keyword is empty').toHaveValue('');
      await expect(poList.statusSelect, '[Expected 3] Status is back to All').toHaveValue('');
      await expect(poList.pagerSummary, '[Expected 3] Back on page 1').toContainText('중 1-');
    });
  });

  test('TC_US105_021 — The Status filter narrows for all four statuses; Issued is the month-end worklist', async ({ page, poList, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_021', 'Medium', TAGS, 'Status lists exactly All + Draft / Issued / Closed / Canceled; each status narrows to its own rows; Issued returns exactly the two short-delivered POs (a fully received PO closes itself). Rows are taken on the automation warehouse of the run so other users\' data does not count.');
    const issued1 = await poData.createIssued([{ qty: 300 }]);
    const issued2 = await poData.createIssued([{ qty: 200 }]);

    await step('Arrange: Pre-condition 1–2 — Two short-delivered Issued POs, one Draft, one Closed, one Canceled', async () => {
      await poData.receive(issued1, 100, 0);
      await poData.receive(issued2, 50, 0);
      await poData.createDraft();
      const toClose = await poData.createIssued();
      await poData.api.close(toClose.id, 'auto 021', toClose.version);
      const toCancel = await poData.createIssued();
      await poData.api.cancel(toCancel.id, 'auto 021', toCancel.version);
      await poList.open();
      await poList.warehouseSelect.selectOption({ label: poData.warehouse.name });
    });

    await step('Act: Step 1 — Expand the Status list and count its values', async () => {
      await poList.statusSelect.focus();
    });

    await step('Assert: Expected 1 — Exactly five entries; no Pending approval / Approved', async () => {
      expect(await poList.optionLabels(poList.statusSelect), '[Expected 1] All + four statuses').toEqual([PO_KO['text.filterAll'], PO_KO['poStatus.DRAFT'], PO_KO['poStatus.ISSUED'], PO_KO['poStatus.CLOSED'], PO_KO['poStatus.CANCELED']]);
    });

    await step('Act: Step 2 — Set Status to Draft and click 검색', async () => {
      await poList.statusSelect.selectOption('DRAFT');
      await poList.search();
    });

    await step('Assert: Expected 2 — The table holds only Draft POs', async () => {
      const statuses = await poList.columnTexts(PO_KO['col.poList.status']);
      expect(statuses.length, '[Expected 2] Draft rows exist').toBeGreaterThan(0);
      expect(statuses.filter((s) => s.trim() !== PO_KO['poStatus.DRAFT']), '[Expected 2] Only Draft rows').toEqual([]);
    });

    const passes: Record<string, string[]> = {};
    await step('Act: Step 3 — Select Closed and then Canceled in turn, clicking 검색 after each', async () => {
      for (const status of ['CLOSED', 'CANCELED'] as const) {
        await poList.statusSelect.selectOption(status);
        await poList.search();
        passes[status] = await poList.columnTexts(PO_KO['col.poList.status']);
      }
    });

    await step('Assert: Expected 3 — Each pass leaves exactly the POs of the status selected', async () => {
      for (const [status, label] of [['CLOSED', PO_KO['poStatus.CLOSED']], ['CANCELED', PO_KO['poStatus.CANCELED']]] as const) {
        expect(passes[status].length, `[Expected 3] ${label} rows exist`).toBeGreaterThan(0);
        expect(passes[status].filter((s) => s.trim() !== label), `[Expected 3] Only ${label} rows`).toEqual([]);
      }
    });

    await step('Act: Step 4 — Set Status to Issued, click 검색 and compare the Received column', async () => {
      await poList.statusSelect.selectOption('ISSUED');
      await poList.search();
    });

    await step('Assert: Expected 4 — Exactly the two Issued POs, both short of full receipt', async () => {
      expect((await poList.columnTexts(PO_KO['col.poList.poNo'])).sort(), '[Expected 4] Exactly the two Issued POs').toEqual([issued1.poNo, issued2.poNo].sort());
      const received = await poList.columnTexts(PO_KO['col.poList.receivedProgress']);
      for (const value of received) {
        const [got, of] = value.split('/').map((part) => Number(part.replace(/[^\d]/g, '')));
        expect(got < of, `[Expected 4] "${value}" is still short of full receipt`).toBe(true);
      }
    });
  });

  test('TC_US105_022 — The Inbound destination filter lists only non-virtual PLATFORM warehouses', async ({ page, poList, poData, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_022', 'Medium', TAGS, 'The list is sorted by name; SUPPLIER warehouses and every virtual bucket (PENDING_REVENUE / IN_TRANSIT / SCRAP / QUARANTINE / DEFECTIVE) are absent; selecting Warehouse A narrows to its POs. Warehouse A = the automation warehouse; Warehouse B = a SUPPLIER warehouse created for the test.');
    const po = await poData.createDraft();
    let supplierWarehouse = '';

    await step('Arrange: Pre-condition 1–2 — Warehouse A PLATFORM, Warehouse B SUPPLIER, plus the five virtual buckets', async () => {
      supplierWarehouse = (await warehouseCleanup.create('SUPPLIER', 'TC_US105_022')).name;
      await poList.open();
    });

    let options: string[] = [];
    await step('Act: Step 1 — Expand the 입고지 (Inbound destination) list in the filter area', async () => {
      options = (await poList.optionLabels(poList.warehouseSelect)).slice(1);
    });

    await step('Assert: Expected 1 — The list opens, sorted by name ascending', async () => {
      expect(options, '[Expected 1] Sorted by name ascending').toEqual([...options].sort((a, b) => a.localeCompare(b)));
    });

    await step('Act: Step 2 — Sweep every entry in the list', async () => {
      await poList.warehouseSelect.focus();
    });

    await step('Assert: Expected 2 — Warehouse B and every virtual-type warehouse are absent', async () => {
      expect(options, '[Expected 2] SUPPLIER Warehouse B is absent').not.toContain(supplierWarehouse);
      for (const bucket of ['매출대기', '이동중', '폐기', '이슈격리', '불량']) {
        expect(options, `[Expected 2] Virtual bucket ${bucket} of Warehouse A is absent`).not.toContain(`${poData.warehouse.name} - ${bucket}`);
      }
      expect(options, '[Expected 2] Warehouse A is listed').toContain(poData.warehouse.name);
    });

    await step('Act: Step 3 — Select Warehouse A and click 검색', async () => {
      await poList.warehouseSelect.selectOption({ label: poData.warehouse.name });
      await poList.search();
    });

    await step('Assert: Expected 3 — Only POs whose Inbound destination is Warehouse A', async () => {
      const destinations = await poList.columnTexts(PO_KO['col.poList.destination']);
      expect(destinations.filter((d) => d.trim() !== poData.warehouse.name), '[Expected 3] Only Warehouse A rows').toEqual([]);
      expect(await poList.columnTexts(PO_KO['col.poList.poNo']), '[Expected 3] The PO on Warehouse A is listed').toContain(po.poNo);
    });
  });

  test('TC_US105_023 — The Owner filter narrows the list for each of its two values', async ({ page, poList, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_023', 'Medium', TAGS, 'Owner lists exactly All + 자사 / 파트너 (no 위탁); 자사 returns only PO A, 파트너 only PO B (within the automation warehouse of the run).');
    const poA = await poData.createDraft([{ owner: 'OWN' }]);
    const poB = await poData.createDraft([{ owner: 'PARTNER' }]);

    await step('Arrange: Pre-condition 1–2 — PO A with an Owner 자사 line and PO B with an Owner 파트너 line', async () => {
      await poList.open();
      await poList.warehouseSelect.selectOption({ label: poData.warehouse.name });
    });

    await step('Act: Step 1 — Expand the 소유 주체 (Owner) list and count its values', async () => {
      await poList.ownerSelect.focus();
    });

    await step('Assert: Expected 1 — Exactly three entries: All, 자사, 파트너; no 위탁', async () => {
      expect(await poList.optionLabels(poList.ownerSelect), '[Expected 1] All + 자사 재고 + 파트너 재고').toEqual([PO_KO['text.filterAll'], '자사 재고', '파트너 재고']);
    });

    await step('Act: Step 2 — Set 소유 주체 to 자사 재고 and click 검색', async () => {
      await poList.ownerSelect.selectOption('OWN');
      await poList.search();
    });

    await step('Assert: Expected 2 — Only PO A, no PO carrying 파트너 alone', async () => {
      const numbers = await poList.columnTexts(PO_KO['col.poList.poNo']);
      expect(numbers, '[Expected 2] PO A is listed').toContain(poA.poNo);
      expect(numbers, '[Expected 2] PO B (파트너 only) is not listed').not.toContain(poB.poNo);
    });

    await step('Act: Step 3 — Set 소유 주체 to 파트너 재고 and click 검색', async () => {
      await poList.ownerSelect.selectOption('PARTNER');
      await poList.search();
    });

    await step('Assert: Expected 3 — Only PO B', async () => {
      const numbers = await poList.columnTexts(PO_KO['col.poList.poNo']);
      expect(numbers, '[Expected 3] PO B is listed').toContain(poB.poNo);
      expect(numbers, '[Expected 3] PO A is not listed').not.toContain(poA.poNo);
    });
  });

  test('TC_US105_024 — The Sale type filter narrows the list for each of its three values', async ({ page, poList, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_024', 'Medium', TAGS, 'Sale type lists All + 사입 / 라이선스 판매 / 전체위탁; each value returns only the POs holding a line of that sale type (within the automation warehouse of the run). The 라이선스 판매 PO is raised with Supplier type Manufacturer (BR-5).');
    const purchase = await poData.createDraft([{ saleType: 'PURCHASE' }]);
    const license = await poData.createDraft([{ saleType: 'LICENSE' }], { supplierType: 'MANUFACTURER', manufacturerId: 1 });
    const self = await poData.createDraft([{ saleType: 'SELF' }]);
    const byType = { PURCHASE: purchase.poNo, LICENSE: license.poNo, SELF: self.poNo } as const;

    await step('Arrange: Pre-condition 1–2 — Three POs, each with a line of a different Sale type', async () => {
      await poList.open();
      await poList.warehouseSelect.selectOption({ label: poData.warehouse.name });
    });

    await step('Act: Step 1 — Expand the 판매유형 (Sale type) list', async () => {
      await poList.saleTypeSelect.focus();
    });

    await step('Assert: Expected 1 — Exactly four entries: All + 사입 / 라이선스 판매 / 전체위탁', async () => {
      expect(await poList.optionLabels(poList.saleTypeSelect), '[Expected 1] All + three sale types').toEqual([PO_KO['text.filterAll'], PO_KO['saleType.PURCHASE'], PO_KO['saleType.LICENSE'], PO_KO['saleType.SELF']]);
    });

    const steps = [
      { n: 2, type: 'PURCHASE', label: PO_KO['saleType.PURCHASE'] },
      { n: 3, type: 'LICENSE', label: PO_KO['saleType.LICENSE'] },
      { n: 4, type: 'SELF', label: PO_KO['saleType.SELF'] },
    ] as const;
    for (const { n, type, label } of steps) {
      await step(`Act: Step ${n} — Set 판매유형 to ${label} and click 검색`, async () => {
        await poList.saleTypeSelect.selectOption(type);
        await poList.search();
      });

      await step(`Assert: Expected ${n} — Only POs with a ${label} line`, async () => {
        const numbers = await poList.columnTexts(PO_KO['col.poList.poNo']);
        expect(numbers, `[Expected ${n}] The ${label} PO is listed`).toContain(byType[type]);
        for (const other of Object.keys(byType).filter((key) => key !== type) as Array<keyof typeof byType>) {
          expect(numbers, `[Expected ${n}] The ${other} PO is not mixed in`).not.toContain(byType[other]);
        }
      });
    }
  });

  test('TC_US105_025 — Period type, the date range and the quick-range buttons only fill dates', async ({ page, poList, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_025', 'Medium', TAGS, 'Each of the six quick-range buttons fills From / To without re-running the query; the To calendar forbids a day before From; From = To is valid; switching Period type to 입고예정일 filters on the Expected date.');
    const expectedDay = seoulToday(20);
    const poA = await poData.createDraft([{}], { expectedDate: expectedDay });
    let requests = 0;

    await step('Arrange: Pre-condition 1–2 — POs spread over several dates, PO A with an Expected date different from its Order date', async () => {
      await poList.open();
      page.on('request', (r) => /\/api\/v1\/purchase-orders\?/.test(r.url()) && (requests += 1));
    });

    const filled: Array<{ name: string; from: string; to: string }> = [];
    await step('Act: Step 1 — Click each of the six quick-range buttons in turn and observe the table', async () => {
      requests = 0;
      for (const name of QUICK_RANGES) {
        await poList.quickRange(name).click();
        filled.push({ name, from: await poList.periodFromInput.inputValue(), to: await poList.periodToInput.inputValue() });
      }
    });

    await step('Assert: Expected 1 — From / To are filled after each click but the table does not change', async () => {
      for (const { name, from, to } of filled) {
        expect(from, `[Expected 1] ${name} fills From`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(to, `[Expected 1] ${name} fills To`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      expect(requests, '[Expected 1] No query is re-run by the quick-range buttons').toBe(0);
    });

    const from = seoulToday(-3);
    await step('Act: Step 2 — Enter a From date, then open the To calendar and try to pick the day before it', async () => {
      await poList.periodFromInput.fill(from);
      await poList.periodFromInput.press('Enter');
      await poList.periodToInput.click();
    });

    await step('Assert: Expected 2 — The calendar does not allow a day earlier than From', async () => {
      const dayBefore = new Date(`${from}T00:00:00`);
      dayBefore.setDate(dayBefore.getDate() - 1);
      const cell = page.locator('.react-datepicker__day:not(.react-datepicker__day--outside-month)', { hasText: new RegExp(`^${dayBefore.getDate()}$`) }).first();
      await expect(cell, '[Expected 2] The day before From is disabled').toHaveClass(/react-datepicker__day--disabled/);
      await page.keyboard.press('Escape');
    });

    await step('Act: Step 3 — Set To to the same day as From and click 검색', async () => {
      await poList.periodToInput.fill(from);
      await poList.periodToInput.press('Enter');
      await poList.search();
    });

    await step('Assert: Expected 3 — Only POs whose Order date is that exact day', async () => {
      const dates = await poList.columnTexts(PO_KO['col.poList.orderDate']);
      expect(dates.filter((d) => d.trim() !== from), '[Expected 3] Lower bound = upper bound is valid and exact').toEqual([]);
    });

    await step('Act: Step 4 — Switch Period type to 입고예정일, set a range containing only PO A\'s date and click 검색', async () => {
      await poList.periodTypeSelect.selectOption('EXPECTED_DATE');
      await poList.periodFromInput.fill(expectedDay);
      await poList.periodFromInput.press('Enter');
      await poList.periodToInput.fill(expectedDay);
      await poList.periodToInput.press('Enter');
      await poList.search();
    });

    await step('Assert: Expected 4 — The table filters on the Expected date and contains PO A', async () => {
      expect(await poList.columnTexts(PO_KO['col.poList.poNo']), '[Expected 4] PO A is listed').toContain(poA.poNo);
      const expected = await poList.columnTexts(PO_KO['col.poList.expectedDate']);
      expect(expected.filter((d) => d.trim() !== expectedDay), '[Expected 4] Every row has that Expected date').toEqual([]);
    });
  });

  test('TC_US105_026 — Page sizes, paging and sorting apply at once, keep the filters, stay stable on ties', async ({ page, poList, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_026', 'Medium', TAGS, 'Exactly 12 POs of Supplier A: 12 rows at 10 per page; 20 / 50 / 100 redraw at once with the same 12 rows; page 2 keeps the supplier filter; re-sorting keeps two same-day POs in the same relative order (order_date DESC, id DESC). Supplier A = an ACTIVE supplier with no PO on dev. Deviation noted: the list has no clickable Order-date header sort on dev — the re-sort is performed by re-running the query.');
    const supplier = await freshSupplier(poData.api);
    let sameDay: string[] = [];

    await step('Arrange: Pre-condition 1–2 — Exactly 12 POs of Supplier A, two sharing the same Order date', async () => {
      await draftsFor(poData, supplier.id, 10, seoulToday(-1));
      sameDay = await draftsFor(poData, supplier.id, 2, seoulToday(-2));
      await poList.open();
    });

    await step('Act: Step 1 — Set the search type to Biz partner, type the Supplier A name and click 검색', async () => {
      await poList.searchBy(PO_KO['searchType.SUPPLIER'], supplier.name);
    });

    await step('Assert: Expected 1 — 12 rows, 10 to a page by default', async () => {
      await expect(poList.pagerSummary, '[Expected 1] Total 12').toContainText('총 12개');
      await expect(poList.rows, '[Expected 1] 10 rows on page 1').toHaveCount(10);
    });

    const counts: Record<string, number> = {};
    await step('Act: Step 2 — Change the page size to 20, 50 and 100 in turn, then back to 10', async () => {
      for (const size of ['20', '50', '100', '10']) {
        const response = poList.waitForListRequest();
        await poList.pageSizeSelect.selectOption(size);
        await response;
        await poList.waitForRows();
        counts[size] = await poList.rows.count();
      }
    });

    await step('Assert: Expected 2 — Each change redraws at once with only this supplier\'s 12 rows', async () => {
      expect(counts, '[Expected 2] 20 / 50 / 100 show all 12 rows, 10 shows 10').toEqual({ 20: 12, 50: 12, 100: 12, 10: 10 });
    });

    await step('Act: Step 3 — Go to page 2', async () => {
      const response = poList.waitForListRequest();
      await poList.pageButton('2').click();
      await response;
      await poList.waitForRows();
    });

    await step('Assert: Expected 3 — Page 2 still holds only this supplier\'s POs', async () => {
      const suppliers = await poList.columnTexts(PO_KO['col.poList.supplier']);
      expect(suppliers.length, '[Expected 3] Page 2 holds the last 2 rows').toBe(2);
      expect(suppliers.filter((s) => !s.includes(supplier.name)), '[Expected 3] Only Supplier A rows').toEqual([]);
    });

    let firstPass: string[] = [];
    await step('Act: Step 4 — Reverse the Order-date sort, reverse it back, and compare the two same-day POs', async () => {
      firstPass = (await poList.columnTexts(PO_KO['col.poList.poNo'])).filter((no) => sameDay.includes(no));
      await poList.search();
      await poList.pageSizeSelect.selectOption('20');
      await poList.waitForRows();
    });

    await step('Assert: Expected 4 — The filters are kept and the same-day POs keep their relative order', async () => {
      const secondPass = (await poList.columnTexts(PO_KO['col.poList.poNo'])).filter((no) => sameDay.includes(no));
      expect(secondPass, '[Expected 4] Same relative order on every pass').toEqual(firstPass);
      expect(firstPass, '[Expected 4] id DESC — the later-created PO comes first').toEqual([...sameDay].reverse());
      await expect(poList.keywordInput, '[Expected 4] The applied supplier filter is kept').toHaveValue(supplier.name);
    });
  });

  test('TC_US105_027 — The Received column and the total line; Exception / Rejected receipts count as 0', async ({ page, poList, poForm, poData, approverPoApi }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_027', 'Medium', TAGS, 'PO A (300, one Exception receipt of 290) reads 0 / 300 with a grey bar; PO B (200 fully received) reads 200 / 200 with a full green bar; PO C (150, only receipt Rejected) reads 0 / 150 and its detail carries no gapQty / gapAmount; the total line follows "Total {n} items · showing {from}-{to}".');
    const poA = await poData.createIssued([{ qty: 300 }]);
    const poB = await poData.createIssued([{ qty: 200 }]);
    let poC = await poData.createIssued([{ qty: 150 }]);

    await step('Arrange: Pre-condition 1–2 — PO A with an Exception receipt 290, PO B fully received, PO C with a Rejected receipt', async () => {
      await poData.receive(poA, 290, 0, 'ADJ_DISCREPANCY');
      await poData.receive(poB, 200, 0);
      await poData.receive(poC, 140, 0, 'ADJ_DISCREPANCY', approverPoApi);
      poC = await poData.read(poC.id);
      const [grn] = await poData.api.goodsReceipts(poC.id);
      await poData.api.rejectReceipt(poC.id, grn.id, 'ADJ_DISCREPANCY', 'auto 027', (await poData.api.goodsReceipt(poC.id, grn.id)).body.version);
      await poList.open();
      await poList.warehouseSelect.selectOption({ label: poData.warehouse.name });
      await poList.pageSizeSelect.selectOption('100');
      await poList.search();
    });

    const received = (no: string) => poList.cell(poList.rowByPoNo(no), PO_KO['col.poList.receivedProgress']);
    await step('Act: Step 1 — Observe the Received column of PO A', async () => {
      await received(poA.poNo).scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — 0 / 300 with a grey bar; the Exception 290 is not added in', async () => {
      await expect(received(poA.poNo), '[Expected 1] Received reads 0 / 300').toHaveText(/^0 \/ 300/);
      await expect(received(poA.poNo).locator('.progress-bar'), '[Expected 1] Progress bar is grey').toHaveClass(/bg-secondary/);
    });

    await step('Act: Step 2 — Observe the Received column of PO B', async () => {
      await received(poB.poNo).scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — 200 / 200 with a full green bar', async () => {
      await expect(received(poB.poNo), '[Expected 2] Received reads 200 / 200').toHaveText(/^200 \/ 200/);
      await expect(received(poB.poNo).locator('.progress-bar'), '[Expected 2] Progress bar is green').toHaveClass(/bg-success/);
      await expect(received(poB.poNo).locator('.progress-bar'), '[Expected 2] Progress bar is full').toHaveAttribute('style', /width: 100%/);
    });

    let detailC: Record<string, unknown> = {};
    await step('Act: Step 3 — Observe the Received column of PO C and the shortfall read-outs on its detail', async () => {
      detailC = (await poData.api.get<Record<string, unknown>>(poC.id)).body;
      await poForm.openPo(poC.id);
      await poList.open();
      await poList.warehouseSelect.selectOption({ label: poData.warehouse.name });
      await poList.pageSizeSelect.selectOption('100');
      await poList.search();
    });

    await step('Assert: Expected 3 — 0 / 150; gapQty and gapAmount are ABSENT, not zero', async () => {
      await expect(received(poC.poNo), '[Expected 3] Received reads 0 / 150').toHaveText(/^0 \/ 150/);
      expect(detailC, '[Expected 3] gapQty is absent on PO C').not.toHaveProperty('gapQty');
      expect(detailC, '[Expected 3] gapAmount is absent on PO C').not.toHaveProperty('gapAmount');
    });

    await step('Act: Step 4 — Observe the total-count line under the table', async () => {
      await poList.pagerSummary.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — The total line follows the pattern against the real row count', async () => {
      const total = await poList.rows.count();
      await expect(poList.pagerSummary, '[Expected 4] "총 {n}개의 항목 중 1-{n}개 표시"').toHaveText(`총 ${total}개의 항목 중 1-${total}개 표시`);
    });
  });

  test('TC_US105_028 — The empty state when the search matches no row', async ({ page, poList }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_028', 'Medium', TAGS, 'Searching ZZZZ returns no row; the column headers stay, the no-result message shows and the total line reads Total 0 items · showing 0-0.');

    await step('Arrange: Pre-condition 1–2 — At least one PO exists; no PO number contains ZZZZ', async () => {
      await poList.open();
    });

    await step('Act: Step 1 — Type ZZZZ into the search input and click 검색', async () => {
      await poList.keywordInput.fill('ZZZZ');
      await poList.search();
    });

    await step('Assert: Expected 1 — The table holds no data row', async () => {
      await expect(poList.rows, '[Expected 1] No data row').toHaveCount(0);
    });

    await step('Act: Step 2 — Observe the table area and the total-count line', async () => {
      await poList.noRowsMessage.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Headers rendered, the no-result message, and Total 0 items · showing 0-0', async () => {
      await expect(poList.columnHeader(PO_KO['col.poList.poNo']), '[Expected 2] Column headers are still rendered').toBeVisible();
      await expect(poList.noRowsMessage, '[Expected 2] The no-result message').toHaveText(PO_KO['text.noRows']);
      await expect(poList.pagerSummary, '[Expected 2] Total 0 items · showing 0-0').toHaveText('총 0개의 항목 중 0-0개 표시');
    });
  });

  test('TC_US105_029 — Clicking a PO no. opens the order and Back restores filters, page and sort', async ({ page, poList, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_029', 'Medium', TAGS, 'Filtered by Supplier A and on page 2; clicking the first PO no. of page 2 opens that exact order in detail mode; 발주 목록으로 returns with the same filters, page 2 and the same order. Supplier A = an ACTIVE supplier with no PO on dev, given 12 Draft POs.');
    const supplier = await freshSupplier(poData.api);
    let clicked = '';
    let page2: string[] = [];

    await step('Arrange: Pre-condition 1–2 — Enough POs of Supplier A for two pages', async () => {
      await draftsFor(poData, supplier.id, 12);
      await poList.open();
    });

    await step('Act: Step 1 — Search by Biz partner Supplier A, click 검색 and go to page 2', async () => {
      await poList.searchBy(PO_KO['searchType.SUPPLIER'], supplier.name);
      const response = poList.waitForListRequest();
      await poList.pageButton('2').click();
      await response;
      await poList.waitForRows();
      page2 = await poList.columnTexts(PO_KO['col.poList.poNo']);
    });

    await step('Assert: Expected 1 — Filtered by this supplier and on page 2', async () => {
      await expect(poList.pagerSummary, '[Expected 1] Page 2 of the 12 rows').toContainText('11-12');
      const suppliers = await poList.columnTexts(PO_KO['col.poList.supplier']);
      expect(suppliers.filter((s) => !s.includes(supplier.name)), '[Expected 1] Only Supplier A rows').toEqual([]);
    });

    await step('Act: Step 2 — Click the PO number on the first row of page 2', async () => {
      clicked = page2[0];
      await poList.openPo(clicked);
      await poForm.header.waitFor();
    });

    await step('Assert: Expected 2 — The PO form for exactly the order clicked opens in detail mode', async () => {
      await expect(poForm.poNoInput, '[Expected 2] The clicked PO number is shown').toHaveValue(clicked);
      await expect(poForm.statusBadge, '[Expected 2] Detail mode of the saved order').toHaveText(PO_KO['poStatus.DRAFT']);
    });

    await step('Act: Step 3 — Click 발주 목록으로 (Back to purchase orders)', async () => {
      await poForm.backToListButton.click();
      await poList.waitForRows();
    });

    await step('Assert: Expected 3 — Same filters, still on page 2, sort order unchanged', async () => {
      await expect(poList.keywordInput, '[Expected 3] The supplier keyword is kept').toHaveValue(supplier.name);
      await expect(poList.searchTypeSelect, '[Expected 3] The search type is kept').toHaveValue('SUPPLIER');
      await expect(poList.pagerSummary, '[Expected 3] Still on page 2').toContainText('11-12');
      expect(await poList.columnTexts(PO_KO['col.poList.poNo']), '[Expected 3] Sort order unchanged').toEqual(page2);
    });
  });

  for (const tc of ['TC_US105_125', 'TC_US105_128'] as const) {
    test(`${tc} — A supplier is found by its Korean name and by its English name alike`, async ({ page, poList, poData }) => {
      const step = makeStep(page);
      await tcMeta(tc, 'High', TAGS, 'starship and 스타쉽 both find PO A (case-insensitive substring on either stored name); "An" returns PO B (안테나뮤직 / Antenna Music) once; PO C found by its English name; one box, no language selector. Not automated: the PO C clause — no ACTIVE supplier with an English name only exists on dev (checked 05/10/2026).');
      const poA = await poData.createDraft();
      const poB = await poData.createDraft([{}], { supplierId: 22 });

      await step('Arrange: Pre-condition 1–4 — PO A for 스타쉽엔터테인먼트 / STARSHIP, PO B for 안테나뮤직 / Antenna Music', async () => {
        await poList.open();
        await poList.warehouseSelect.selectOption({ label: poData.warehouse.name });
        await poList.searchTypeSelect.selectOption({ label: PO_KO['searchType.SUPPLIER'] });
      });

      await step('Act: Step 1 — Set the search type to Biz partner, type starship and click 검색', async () => {
        await poList.keywordInput.fill('starship');
        await poList.search();
      });

      await step('Assert: Expected 1 — PO A is found through the English name, case-insensitively', async () => {
        expect(await poList.columnTexts(PO_KO['col.poList.poNo']), '[Expected 1] PO A is found by "starship"').toContain(poA.poNo);
      });

      await step('Act: Step 2 — Clear the box, type 스타쉽 and click 검색', async () => {
        await poList.keywordInput.fill('스타쉽');
        await poList.search();
      });

      await step('Assert: Expected 2 — PO A is found again by the Korean name', async () => {
        expect(await poList.columnTexts(PO_KO['col.poList.poNo']), '[Expected 2] PO A is found by "스타쉽"').toContain(poA.poNo);
      });

      await step('Act: Step 3 — Clear the box, type An and click 검색', async () => {
        await poList.keywordInput.fill('An');
        await poList.search();
      });

      await step('Assert: Expected 3 — PO B is returned ONCE although both names match', async () => {
        const numbers = await poList.columnTexts(PO_KO['col.poList.poNo']);
        expect(numbers.filter((no) => no === poB.poNo), '[Expected 3] PO B appears exactly once').toHaveLength(1);
      });

      await step('Act: Step 4 — Clear the box, type part of the PO C supplier\'s English name and click 검색', async () => {
        await poList.keywordInput.fill(SUPPLIER.antenna.en.slice(0, 7));
        await poList.search();
      });

      await step('Assert: Expected 4 — The English name is searched (PO C clause: Not automated)', async () => {
        // Not automated: PO C (tên ko = null) — dev không có 공급처 ACTIVE nào chỉ có tên tiếng Anh. Kiểm phần còn lại của
        // ý: tên tiếng Anh được lưu và được tìm (PO B tìm thấy qua "Antenna").
        expect(await poList.columnTexts(PO_KO['col.poList.poNo']), '[Expected 4] An order is found through its English name').toContain(poB.poNo);
      });

      await step('Act: Step 5 — Observe whether the screen offers any way to choose a search language', async () => {
        await poList.searchTypeSelect.scrollIntoViewIfNeeded();
      });

      await step('Assert: Expected 5 — No language selector and no second field', async () => {
        await expect(poList.keywordInput, '[Expected 5] Exactly one keyword box').toHaveCount(1);
        expect(await poList.optionLabels(poList.searchTypeSelect), '[Expected 5] No language option in the search type').toEqual([PO_KO['searchType.PO_NO'], PO_KO['searchType.SUPPLIER'], PO_KO['searchType.SKU_CODE']]);
        await expect(page.getByRole('combobox', { name: /language|언어/i }), '[Expected 5] No language selector').toHaveCount(0);
      });
    });
  }
});
