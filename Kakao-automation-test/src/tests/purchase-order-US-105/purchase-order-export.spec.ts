import * as fs from 'fs';
import { Download, Page } from '@playwright/test';
import { test, expect } from '@fixtures/purchase-order.fixture';
import { makeApiStep, makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { PO_KO } from '@utils/purchase-order.i18n';
import { readXlsxRows } from '@utils/xlsx-reader';
import { PurchaseOrderApi } from '@api/purchase-order.api';
import { PurchaseOrderListPage, LIST_COLUMNS } from '@pages/purchase-order-list.page';
import { PurchaseOrderFormPage } from '@pages/purchase-order-form.page';
import { PoData } from '@utils/purchase-order.data';

/**
 * Xuất Excel (US105) — file 1 PO (`GET /purchase-orders/{id}/excel`) và file danh sách (`GET /purchase-orders/excel`).
 * File được tải thật qua UI rồi đọc bằng `readXlsxRows` (zip + XML, không thêm thư viện). TC cần "đúng N PO" dùng 1 공급처
 * ACTIVE chưa có PO nào trên dev hoặc lọc theo kho automation để số đếm không lẫn dữ liệu người khác.
 */
const TAGS = ['export', 'purchase-order'];

async function download(page: Page, click: () => Promise<void>): Promise<{ file: Download; rows: string[][]; cells: string[] }> {
  const pending = page.waitForEvent('download');
  await click();
  const file = await pending;
  const rows = readXlsxRows(fs.readFileSync(await file.path()));
  return { file, rows, cells: rows.flat().map((cell) => cell.trim()).filter(Boolean) };
}

async function freshSupplier(api: PurchaseOrderApi): Promise<{ id: number; name: string }> {
  const partners = (await api.bizPartners()).filter((p) => p.contractStatus === 'ACTIVE' && p.companyNames.ko);
  for (const partner of partners.reverse()) {
    const name = partner.companyNames.ko as string;
    if (partners.filter((p) => (p.companyNames.ko ?? '').includes(name)).length > 1) continue;
    if ((await api.list({ searchType: 'SUPPLIER', keyword: name }, 0, 10)).body.paging.totalCount === 0) return { id: partner.id, name };
  }
  throw new Error('Test data setup failed — no ACTIVE supplier without purchase orders is left on dev');
}

async function singlePoExport(tc: 'TC_US105_109' | 'TC_US105_112', page: Page, poForm: PurchaseOrderFormPage, poData: PoData) {
  const step = makeStep(page);
  const rewritten = tc === 'TC_US105_112';
  await tcMeta(tc, 'High', TAGS, rewritten
    ? 'The file is named after the PO number (.xlsx); the header block carries exactly 발주번호 / 공급처 유형 / 공급처 / 제조사 / 발주일 / 입고 예정일 / 입고지 / 통화 with the Supplier printed "ko (en)"; the line section carries SKU 코드 / SKU 이름 / 바코드 / 소유구분 / 발주수량 / 단가 / 라인금액 and a total of 11,745,000; 입고수량 and 판매유형 are absent; no internal PO id, user id or status code.'
    : 'The file is named after the PO number (.xlsx); the general block carries PO no., Supplier, Supplier type, Manufacturer, Order date, Expected date, Inbound destination, Currency with the stored supplier snapshot; one line with SKU, Barcode, Owner, Sale type, Ordered qty, Unit price, Line amount and a total of 11,745,000; no internal PO id, user id or status code.');
  let po = await poData.createIssued([{ qty: 300, price: 39150, owner: 'OWN', saleType: 'PURCHASE' }]);
  let result: Awaited<ReturnType<typeof download>>;

  await step(`Arrange: Pre-condition 1–3 — PO A Issued, Biz partner 스타쉽 / STARSHIP, one line 300 × 39,150${rewritten ? ', 200 received' : ''}; PO number noted`, async () => {
    if (rewritten) {
      await poData.receive(po, 200, 0, 'ADJ_DISCREPANCY');
      po = await poData.read(po.id);
    }
    await poForm.openPo(po.id);
  });

  await step('Act: Step 1 — Open PO A and click 엑셀 다운로드', async () => {
    result = await download(page, () => poForm.excelButton.click());
  });
  await step('Assert: Expected 1 — The file is generated and downloaded', async () => {
    expect(result.rows.length, '[Expected 1] The workbook has content').toBeGreaterThan(0);
  });

  await step('Act: Step 2 — Check the name of the file downloaded', async () => undefined);
  await step('Assert: Expected 2 — The file name matches the PO number exactly, extension xlsx', async () => {
    expect(result.file.suggestedFilename(), '[Expected 2] {poNo}.xlsx').toBe(`${po.poNo}.xlsx`);
  });

  await step('Act: Step 3 — Open the file and compare the general information block', async () => undefined);
  await step('Assert: Expected 3 — Every header label and the supplier snapshot', async () => {
    const labels = ['발주번호', '공급처 유형', '공급처', '제조사', '발주일', '입고 예정일', '입고지', '통화'];
    for (const label of labels) expect(result.cells, `[Expected 3] Header ${label}`).toContain(label);
    expect(result.cells, '[Expected 3] PO number').toContain(po.poNo);
    if (rewritten) expect(result.cells, '[Expected 3] Supplier printed "ko (en)"').toContain('스타쉽엔터테인먼트 (STARSHIP ENTERTAINMENT)');
    else expect(result.cells.some((c) => c.includes('스타쉽엔터테인먼트')), '[Expected 3] Supplier name snapshot (ko first)').toBe(true);
  });

  await step('Act: Step 4 — Compare the line section and the total row', async () => undefined);
  await step('Assert: Expected 4 — The line columns and a PO amount total of 11,745,000', async () => {
    const lineLabels = rewritten ? ['SKU 코드', 'SKU 이름', '바코드', '소유구분', '발주수량', '단가', '라인금액'] : ['SKU', '바코드', '소유 주체', '판매유형', '발주 수량', '매입단가', '금액'];
    for (const label of lineLabels) expect(result.cells, `[Expected 4] Line column ${label}`).toContain(label);
    expect(result.cells.some((c) => c.replace(/[,\s]/g, '') === '11745000'), '[Expected 4] Total 11,745,000').toBe(true);
  });

  await step(`Act: Step 5 — Sweep the whole file for ${rewritten ? '입고수량, 판매유형 and ' : ''}internal identifiers`, async () => undefined);
  await step(`Assert: Expected 5 — ${rewritten ? '입고수량 and 판매유형 ABSENT; ' : ''}no PO id, user id or status code`, async () => {
    if (rewritten) {
      expect(result.cells, '[Expected 5] 입고수량 absent').not.toContain('입고수량');
      expect(result.cells, '[Expected 5] 판매유형 absent').not.toContain('판매유형');
    }
    expect(result.cells, '[Expected 5] No internal PO id').not.toContain(String(po.id));
    expect(result.cells.filter((c) => /\.fpt$/.test(c)), '[Expected 5] No user id').toEqual([]);
    expect(result.cells.filter((c) => /^(DRAFT|ISSUED|CLOSED|CANCELED)$/.test(c)), '[Expected 5] No status code').toEqual([]);
  });
}

test.describe('[Export] Excel — single PO and list downloads', () => {
  test.describe.configure({ timeout: 240_000 });

  test('TC_US105_109 — The single-PO Excel is named after the PO number and carries no internal identifier', async ({ page, poForm, poData }) => {
    await singlePoExport('TC_US105_109', page, poForm, poData);
  });

  test('TC_US105_112 — The single-PO Excel carries the rewritten column set and no internal identifier', async ({ page, poForm, poData }) => {
    await singlePoExport('TC_US105_112', page, poForm, poData);
  });

  test('TC_US105_111 — The list Excel exports the applied conditions, not the ones still being typed', async ({ page, poList, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_111', 'Medium', TAGS, 'Supplier A (three POs incl. a Draft and an Issued) searched → three rows; selecting Status Draft without searching keeps three rows; the list download is named purchase_orders.xlsx and holds exactly the three applied rows; it downloads directly (no reason dialog, no queue). Supplier A = an ACTIVE supplier with no PO on dev.');
    const supplier = await freshSupplier(poData.api);
    const numbers: string[] = [];
    let result: Awaited<ReturnType<typeof download>>;

    await step('Arrange: Pre-condition 1–2 — Exactly three POs of Supplier A, a Draft and an Issued among them', async () => {
      numbers.push((await poData.createDraft([{}], { supplierId: supplier.id })).poNo);
      numbers.push((await poData.createDraft([{}], { supplierId: supplier.id })).poNo);
      numbers.push((await poData.createIssued([{}], { supplierId: supplier.id })).poNo);
      await poList.open();
    });

    await step('Act: Step 1 — Search by Biz partner Supplier A and click 검색', async () => {
      await poList.searchBy(PO_KO['searchType.SUPPLIER'], supplier.name);
    });
    await step('Assert: Expected 1 — The table holds this supplier\'s three rows', async () => {
      await expect(poList.rows, '[Expected 1] Three rows').toHaveCount(3);
    });

    await step('Act: Step 2 — Also set Status to Draft but do not click 검색', async () => {
      await poList.statusSelect.selectOption('DRAFT');
    });
    await step('Assert: Expected 2 — The table still holds three rows', async () => {
      await expect(poList.rows, '[Expected 2] Still three').toHaveCount(3);
    });

    await step('Act: Step 3 — Click 엑셀 다운로드 on the list screen and observe the file name', async () => {
      result = await download(page, () => poList.excelButton.click());
    });
    await step('Assert: Expected 3 — The constant name purchase_orders.xlsx', async () => {
      expect(result.file.suggestedFilename(), '[Expected 3] purchase_orders.xlsx').toBe('purchase_orders.xlsx');
    });

    await step('Act: Step 4 — Open the file and count its rows', async () => undefined);
    await step('Assert: Expected 4 — Exactly the three applied rows; Status Draft never reached the file', async () => {
      for (const no of numbers) expect(result.cells, `[Expected 4] ${no} in the file`).toContain(no);
      expect(result.cells.filter((c) => /^PO-\d{8}-\d{3}$/.test(c)), '[Expected 4] Exactly three PO rows').toHaveLength(3);
    });

    await step('Act: Step 5 — Observe how the file is produced: reason dialog, queue or VDI gateway', async () => undefined);
    await step('Assert: Expected 5 — Direct, synchronous download: no reason dialog, no queue', async () => {
      await expect(page.locator('.modal.show'), '[Expected 5] No reason dialog').toHaveCount(0);
    });
  });

  test('TC_US105_113 — The list Excel button is disabled on an empty result; every role can download', async ({ page, poList, approverPage }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_113', 'Medium', TAGS, 'ZZZZ search → no rows and the no-results message; Excel download disabled; Reset makes it usable again; read roles can download; the button is disabled while the file is produced. Not automated: the SETTLEMENT_OPERATOR / MANAGER / AUDIT halves of step 4 — the APPROVER half runs as dungbd.fpt on browser 2.');
    const listB = new PurchaseOrderListPage(approverPage);
    let disabledWhileProducing = false;

    await step('Arrange: Pre-condition 1–3 — At least one PO exists; no PO number contains ZZZZ', async () => {
      await poList.open();
    });

    await step('Act: Step 1 — Type ZZZZ and click 검색', async () => {
      await poList.keywordInput.fill('ZZZZ');
      await poList.search();
    });
    await step('Assert: Expected 1 — No rows and the no-results message', async () => {
      await expect(poList.rows, '[Expected 1] No rows').toHaveCount(0);
      await expect(poList.noRowsMessage, '[Expected 1] Message').toBeVisible();
    });

    await step('Act: Step 2 — Observe the 엑셀 다운로드 button', async () => undefined);
    await step('Assert: Expected 2 — Excel download is disabled', async () => {
      await expect(poList.excelButton, '[Expected 2] Disabled').toBeDisabled();
    });

    await step('Act: Step 3 — Click 초기화 so the list has rows again and observe the button', async () => {
      const response = poList.waitForListRequest();
      await poList.resetButton.click();
      await response;
      await poList.waitForRows();
    });
    await step('Assert: Expected 3 — The button is usable again', async () => {
      await expect(poList.excelButton, '[Expected 3] Enabled').toBeEnabled();
    });

    let downloaded = '';
    await step('Act: Step 4 — Log in as the read roles in turn, open the list and click 엑셀 다운로드', async () => {
      await listB.open();
      const result = await download(approverPage, () => listB.excelButton.click());
      downloaded = result.file.suggestedFilename();
    });
    await step('Assert: Expected 4 — The download works for a read role (APPROVER; other roles Not automated)', async () => {
      expect(downloaded, '[Expected 4] A file is downloaded').toMatch(/\.xlsx$/);
    });

    await step('Act: Step 5 — Observe the button while the file is being produced', async () => {
      const pending = page.waitForEvent('download');
      await poList.excelButton.click();
      disabledWhileProducing = await poList.excelButton.isDisabled();
      await pending;
    });
    await step('Assert: Expected 5 — The button is disabled while the file is produced', async () => {
      expect(disabledWhileProducing, '[Expected 5] Disabled during production').toBe(true);
    });
  });

  test('TC_US105_115 — The list Excel holds every row matching the filter, not only the page, via GET /excel', async ({ page, poList, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_115', 'High', TAGS, 'Status Issued (on the automation warehouse) shows 10 rows on page 1 and the full total; the download is purchase_orders.xlsx through GET {purchase-orders}/excel with the list parameters; the file holds every matching row, not the 10 on screen; exactly the ten table columns; page 3 does not change the file. Deviation: 12 Issued POs are created instead of 47 — enough to exceed one page while keeping the shared environment small.');
    const count = 12;
    let requestUrl = '';
    let first: Awaited<ReturnType<typeof download>>;

    await step('Arrange: Pre-condition 1–3 — N POs in Issued alongside others; page size 10', async () => {
      for (let i = 0; i < count; i += 1) await poData.createIssued([{ qty: 5 }]);
      await poData.createDraft();
      await poList.open();
      await poList.warehouseSelect.selectOption({ label: poData.warehouse.name });
    });

    await step('Act: Step 1 — Set Status to Issued, click 검색 and observe the rows and the total line', async () => {
      await poList.statusSelect.selectOption('ISSUED');
      await poList.search();
    });
    await step('Assert: Expected 1 — First page of 10 rows; the total reports every match', async () => {
      await expect(poList.rows, '[Expected 1] 10 rows').toHaveCount(10);
      await expect(poList.pagerSummary, `[Expected 1] Total ${count}`).toContainText(`총 ${count}개`);
    });

    await step('Act: Step 2 — Click 엑셀 다운로드 and check the file name and the request path', async () => {
      page.on('request', (r) => r.url().includes('/purchase-orders/excel') && (requestUrl = r.url()));
      first = await download(page, () => poList.excelButton.click());
    });
    await step('Assert: Expected 2 — purchase_orders.xlsx via GET {purchase-orders}/excel with the list parameters', async () => {
      expect(first.file.suggestedFilename(), '[Expected 2] purchase_orders.xlsx').toBe('purchase_orders.xlsx');
      expect(new URL(requestUrl).pathname, '[Expected 2] /excel, not /download').toBe('/api/v1/purchase-orders/excel');
      expect(new URL(requestUrl).searchParams.get('status'), '[Expected 2] Same status parameter').toBe('ISSUED');
    });

    await step('Act: Step 3 — Open the file and count its data rows', async () => undefined);
    await step(`Assert: Expected 3 — Exactly ${count} data rows, not the 10 on screen`, async () => {
      expect(first.cells.filter((c) => /^PO-\d{8}-\d{3}$/.test(c)), `[Expected 3] ${count} rows`).toHaveLength(count);
    });

    await step('Act: Step 4 — Compare the file\'s column set with the table\'s', async () => undefined);
    await step('Assert: Expected 4 — Exactly the ten table columns, one row per PO', async () => {
      const header = first.rows.find((row) => row.includes(PO_KO['col.poList.poNo'])) ?? [];
      expect(header.filter(Boolean), '[Expected 4] The ten columns').toEqual([...LIST_COLUMNS]);
    });

    await step('Act: Step 5 — Go to the last page (page 2 — 12 rows span two pages), click 엑셀 다운로드 again and count the rows', async () => {
      await poList.pageButton('2').click();
      await poList.waitForRows();
      first = await download(page, () => poList.excelButton.click());
    });
    await step(`Assert: Expected 5 — Still exactly ${count} rows`, async () => {
      expect(first.cells.filter((c) => /^PO-\d{8}-\d{3}$/.test(c)), `[Expected 5] ${count} rows`).toHaveLength(count);
    });
  });

  test('TC_US105_142 — The list export refuses a result larger than 10,000 rows', async ({ poApi }) => {
    const step = makeApiStep(poApi);
    await tcMeta('TC_US105_142', 'Medium', [...TAGS, 'api'], 'A filter matching more than 10,000 POs is refused with PRC-1043 "검색 결과가 10,000건을 넘어 한 번에 내려받을 수 없습니다…" rather than a silently capped file; narrowing to fewer than 10,000 downloads normally.');
    const total = (await poApi.list({}, 0, 10)).body.paging.totalCount;
    test.skip(total <= 10_000, `needs more than 10,000 purchase orders matching the filter; dev holds ${total} (checked at run time) and creating 10,000 orders on the shared environment is out of scope`);
    let tooMany = { status: 0, body: null as unknown };
    let narrowed = { status: 0, body: null as unknown };

    await step('Arrange: Pre-condition 1–2 — The applied filter matches more than 10,000 purchase orders', async () => undefined);

    await step('Act: Step 1 — Call GET {purchase-orders}/excel with that filter', async () => {
      tooMany = await poApi.listExcel({});
    });
    await step('Assert: Expected 1 — Refused with PRC-1043 rather than a capped file', async () => {
      expect((tooMany.body as { code?: string }).code, '[Expected 1] PRC-1043').toBe('PRC-1043');
    });

    await step('Act: Step 2 — Read the message returned', async () => undefined);
    await step('Assert: Expected 2 — The more-than-10,000 sentence', async () => {
      expect(JSON.stringify(tooMany.body), '[Expected 2] PRC-1043 sentence').toContain(PO_KO['error.PRC-1043']);
    });

    await step('Act: Step 3 — Narrow the filter to a period with fewer than 10,000 orders and call it again', async () => {
      narrowed = await poApi.listExcel({ periodType: 'ORDER_DATE', periodFrom: new Date().toISOString().slice(0, 10), periodTo: new Date().toISOString().slice(0, 10) });
    });
    await step('Assert: Expected 3 — The file downloads normally', async () => {
      expect(narrowed.status, '[Expected 3] 200').toBe(200);
    });
  });
});
