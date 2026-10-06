import { Locator } from '@playwright/test';
import { test, expect } from '@fixtures/purchase-order.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { PO_KO } from '@utils/purchase-order.i18n';
import { LIST_COLUMNS, QUICK_RANGES } from '@pages/purchase-order-list.page';
import { GRN_COLUMNS, LINE_COLUMNS } from '@pages/purchase-order-form.page';
import { toPoUpdateBody, UI_REASONS } from '@utils/purchase-order.data';

/**
 * Hiển thị màn 발주 관리 (US105) — list, form, dialog, badge. Nguồn: input/US105_TestCase_EN_v17.md. Mỗi dòng Steps N /
 * Expected N ↔ đúng 1 step `Act: Step N` / `Assert: Expected N`. TC lệch UI → assert đúng điều TC ghi (automation_rules
 * 6.1 bước 3) và báo lại cho BA. Dữ liệu: PO trên kho automation của lần chạy (fixture `poData`, tự dọn).
 */
const TAGS = ['ui', 'purchase-order'];

/** Phần tử con của 1 wrapper field ngoài label + control = text giải thích (helper text). */
async function helperTexts(wrapper: Locator): Promise<string[]> {
  return wrapper.evaluate((el) =>
    Array.from(el.querySelectorAll('small, .form-text, p, .text-muted:not(label):not(.badge)'))
      .map((node) => (node.textContent ?? '').trim())
      .filter((text) => text.length > 0),
  );
}

test.describe('[UI] 발주 관리 — screens, dialogs and badges', () => {
  test.describe.configure({ timeout: 180_000 });

  test('TC_US105_001 — INVENTORY_OPERATOR can create, issue, receive, cancel and close a PO', async ({ page, poList, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_001', 'High', [...TAGS, 'permission'], 'The 발주 관리 menu item sits next to the existing 입고 현황 and 출고/배송 관리 items; Create PO opens a Draft form; a Draft PO offers Save draft / Issue PO / Delete and an Issued PO with quantity outstanding offers Receive goods / Cancel PO / Close PO, all usable. Runs with the bypass account (congnd17.fpt), which holds the INVENTORY_OPERATOR permissions.');
    let draftNo = '';
    let issuedId = 0;

    await step('Arrange: Pre-condition 1–2 — Logged in as INVENTORY_OPERATOR; PO A in Draft and PO B in Issued with quantity outstanding', async () => {
      draftNo = (await poData.createDraft()).poNo;
      issuedId = (await poData.createIssued()).id;
      await poList.open();
    });

    const sidebar = page.getByRole('navigation').filter({ has: page.getByRole('link', { name: '발주 관리', exact: true }) }).first();
    await step('Act: Step 1 — Open the sidebar and go to 물류 관리 > 발주 관리', async () => {
      await sidebar.getByRole('link', { name: '발주 관리', exact: true }).click();
      await poList.heading.waitFor();
    });

    await step('Assert: Expected 1 — The menu item is shown; the existing items 입고 현황 and 출고/배송 관리 are untouched', async () => {
      const group = sidebar.getByRole('listitem').filter({ has: page.getByRole('link', { name: '발주 관리', exact: true }) }).last().locator('xpath=..');
      await expect(group.getByRole('link', { name: '발주 관리', exact: true }), '[Expected 1] 발주 관리 menu item is shown').toBeVisible();
      await expect(group.getByRole('link', { name: '입고 현황', exact: true }), '[Expected 1] Existing item 입고 현황 is still in the 물류 관리 group').toBeVisible();
      await expect(group.getByRole('link', { name: '출고/배송 관리', exact: true }), '[Expected 1] Existing item 출고/배송 관리 is still in the 물류 관리 group').toBeVisible();
    });

    await step('Act: Step 2 — Click 발주 등록 (Create PO)', async () => {
      await poList.createButton.click();
      await poForm.header.waitFor();
    });

    await step('Assert: Expected 2 — A new PO form opens in Draft status', async () => {
      await expect(page, '[Expected 2] The create route is open').toHaveURL(/\/purchase-orders\/create$/);
      await expect(poForm.statusBadge, '[Expected 2] Badge reads 작성 중 (Draft)').toHaveText(PO_KO['poStatus.DRAFT']);
    });

    await step('Act: Step 3 — Go back to the list, open PO A and observe the action row', async () => {
      await poForm.backToListButton.click();
      await poList.searchBy(PO_KO['searchType.PO_NO'], draftNo);
      await poList.openPo(draftNo);
      await poForm.header.waitFor();
    });

    await step('Assert: Expected 3 — Save draft, Issue PO and Delete are present and usable', async () => {
      for (const button of [poForm.saveDraftButton, poForm.issueButton, poForm.deleteButton]) {
        await expect(button, `[Expected 3] ${await button.innerText()} is present`).toBeVisible();
        await expect(button, `[Expected 3] ${await button.innerText()} is usable`).toBeEnabled();
      }
    });

    await step('Act: Step 4 — Open PO B and observe the action row', async () => {
      await poForm.openPo(issuedId);
    });

    await step('Assert: Expected 4 — Receive goods, Cancel PO and Close PO are present and enabled', async () => {
      for (const button of [poForm.receiveButton, poForm.cancelPoButton, poForm.closePoButton]) {
        await expect(button, `[Expected 4] ${await button.innerText()} is present`).toBeVisible();
        await expect(button, `[Expected 4] ${await button.innerText()} is enabled`).toBeEnabled();
      }
    });
  });

  test('TC_US105_009 — None of the six screens prints explanatory helper text', async ({ page, poList, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_009', 'Medium', TAGS, 'No helper text under any filter / form field, none under PO no. or the line table, no purchase-value passage in Receive goods, no red banner in the discrepancy dialog, no immutability text in Close PO, only title / headers / data in Change history; tooltips only on disabled elements while the Supplier and Inbound destination cells keep the full-value title (TR-1). Expected 7 has no step of its own — it is asserted after step 6.');
    let po = await poData.createIssued();

    await step('Arrange: Pre-condition 1–2 — INVENTORY_OPERATOR; PO A Issued with Receipt A in Exception', async () => {
      await poData.receive(po, 290, 0, 'ADJ_DISCREPANCY');
      po = await poData.read(po.id);
      await poList.open();
    });

    await step('Act: Step 1 — Open 발주 관리 and observe the filter area and the table', async () => {
      await poList.searchButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — No helper text under any field, Supplier type / Sale type included', async () => {
      for (const label of [PO_KO['text.searchByLabel'], PO_KO['text.keywordLabel'], PO_KO['text.statusLabel'], PO_KO['text.warehouseLabel'], PO_KO['text.ownershipLabel'], PO_KO['text.saleTypeLabel'], PO_KO['text.periodTypeLabel']]) {
        expect(await helperTexts(poList.field(label).locator('xpath=..')), `[Expected 1] No helper text under the ${label} filter`).toEqual([]);
      }
    });

    await step('Act: Step 2 — Click 발주 등록 and observe the general information block and the line table', async () => {
      await poList.createButton.click();
      await poForm.header.waitFor();
    });

    await step('Assert: Expected 2 — No text under PO no. or the line table; only labels and placeholders', async () => {
      for (const label of [PO_KO['text.poNoLabel'], PO_KO['text.supplierTypeLabel'], PO_KO['text.supplierLabel'], PO_KO['text.manufacturerLabel'], PO_KO['text.destinationLabel']]) {
        expect(await helperTexts(poForm.field(label).locator('xpath=..')), `[Expected 2] No helper text under ${label}`).toEqual([]);
      }
      const underTable = await poForm.lineTable.locator('xpath=following-sibling::*').allInnerTexts();
      expect(underTable.filter((text) => text.trim() && !text.includes(PO_KO['text.addLine'])), '[Expected 2] Nothing but the Add line button sits under the line table').toEqual([]);
    });

    const receive = poForm.receiveDialog();
    await step('Act: Step 3 — Open PO A, click 입고 검수 and observe all text in the dialog', async () => {
      const fresh = await poData.createIssued();
      await poForm.openPo(fresh.id);
      await poForm.receiveButton.click();
      await receive.waitOpen();
    });

    await step('Assert: Expected 3 — No passage explaining how the purchase value is recorded; only the calculation figures', async () => {
      const passages = await receive.root.locator('.modal-body p, .modal-body small, .modal-body .form-text').allInnerTexts();
      expect(passages.filter((text) => text.trim()), '[Expected 3] The receive dialog carries no explanatory passage').toEqual([]);
      await expect(receive.calcPanel, '[Expected 3] The calculation panel is shown').toBeVisible();
    });

    const resolve = poForm.resolveDialog();
    await step('Act: Step 4 — Close the dialog, click the Resolve link and observe the top of the dialog', async () => {
      await receive.cancelButton.click();
      await poForm.openPo(po.id);
      const [grn] = await poData.api.goodsReceipts(po.id);
      await poForm.openResolve(grn.grnNo);
    });

    await step('Assert: Expected 4 — No red banner at the top; only the Exception badge on the header', async () => {
      await expect(resolve.root.locator('.modal-body .alert-danger'), '[Expected 4] No red banner in the discrepancy dialog').toHaveCount(0);
      await expect(resolve.statusBadge, '[Expected 4] The header carries the 차이 발생 (Exception) badge').toHaveText(PO_KO['grnStatus.EXCEPTION']);
    });

    const reason = poForm.reasonDialog();
    await step('Act: Step 5 — Close the dialog, click 발주 종결 and observe the area under the reason input', async () => {
      await resolve.cancelButton.click();
      await poForm.closePoButton.click();
      await reason.waitOpen();
    });

    await step('Assert: Expected 5 — No text stating that the reason will not be editable', async () => {
      await expect(reason.root, '[Expected 5] No sentence says the action / reason cannot be undone or edited').not.toContainText(/되돌릴 수 없|수정할 수 없/);
    });

    const history = poForm.historyDialog();
    await step('Act: Step 6 — Close the dialog, click 변경 이력 and observe all text in the dialog', async () => {
      await reason.cancelButton.click();
      await poForm.historyButton.click();
      await history.waitOpen();
    });

    await step('Assert: Expected 6 — Change history carries only its title, column headers and data', async () => {
      await expect(history.title, '[Expected 6] Title is 변경 이력').toContainText(PO_KO['text.historyTitle']);
      const extras = await history.root.locator('.modal-body > :not(.table-responsive):not(.custom-thick-scrollbar)').allInnerTexts();
      expect(extras.filter((text) => text.trim()), '[Expected 6] No helper text outside the table').toEqual([]);
      await history.closeButton.click();
      // Expected 7 (không có dòng Steps riêng) — tooltip chỉ trên phần tử disabled; ô 공급처 / 입고지 giữ title (TR-1).
      await poList.open();
      const titled = await poList.table.locator('[title]').evaluateAll((nodes) => nodes.map((n) => (n.closest('td') as HTMLTableCellElement | null)?.cellIndex ?? -1));
      const allowed = [LIST_COLUMNS.indexOf(PO_KO['col.poList.supplier']), LIST_COLUMNS.indexOf(PO_KO['col.poList.destination'])];
      expect(titled.filter((index) => !allowed.includes(index)), '[Expected 7] No list cell other than Supplier / Inbound destination carries a tooltip').toEqual([]);
      await expect(poList.table.locator('tbody tr td:nth-child(3)[title]').first(), '[Expected 7] The Supplier cell keeps its full-value title attribute').toBeAttached();
    });
  });

  test('TC_US105_010 — The PO list screen renders every filter, column and button', async ({ page, poList, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_010', 'Medium', TAGS, 'Title, every filter with its default and options, the ten columns, Create PO / Excel download above the table, page size 10 and the pager below; the Supplier cell shows the stored name snapshot with its type label; same-day POs keep a stable id-DESC tie-break across a re-sort. Deviation noted: the list has no clickable column sort on dev — step 4 re-sorts by re-running the search.');
    const sameDay: string[] = [];

    await step('Arrange: Pre-condition 1–2 — INVENTORY_OPERATOR; POs exist in Draft and Issued (two raised the same day)', async () => {
      sameDay.push((await poData.createDraft()).poNo, (await poData.createDraft()).poNo);
      await poData.createIssued();
    });

    await step('Act: Step 1 — Open the 발주 관리 screen', async () => {
      await poList.open();
    });

    await step('Assert: Expected 1 — The screen title reads 발주 관리 (Purchase order management)', async () => {
      await expect(poList.heading, '[Expected 1] Title 발주 관리').toBeVisible();
    });

    await step('Act: Step 2 — Observe the filter area', async () => {
      await poList.searchTypeSelect.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Every filter element with its default and options', async () => {
      expect(await poList.optionLabels(poList.searchTypeSelect), '[Expected 2] Search type options PO no. / Biz partner / SKU code').toEqual([PO_KO['searchType.PO_NO'], PO_KO['searchType.SUPPLIER'], PO_KO['searchType.SKU_CODE']]);
      await expect(poList.searchTypeSelect, '[Expected 2] Search type defaults to PO no.').toHaveValue('PO_NO');
      await expect(poList.keywordInput, '[Expected 2] Keyword placeholder hints at the PO number format and the barcode').toHaveAttribute('placeholder', /PO-|바코드|barcode/i);
      expect(await poList.optionLabels(poList.statusSelect), '[Expected 2] Status: All + Draft, Issued, Closed, Canceled').toEqual([PO_KO['text.filterAll'], PO_KO['poStatus.DRAFT'], PO_KO['poStatus.ISSUED'], PO_KO['poStatus.CLOSED'], PO_KO['poStatus.CANCELED']]);
      await expect(poList.statusSelect, '[Expected 2] Status defaults to All').toHaveValue('');
      await expect(poList.warehouseSelect, '[Expected 2] Inbound destination defaults to All').toHaveValue('');
      expect(await poList.optionLabels(poList.warehouseSelect), '[Expected 2] Inbound destination excludes virtual buckets').not.toContain(`${poData.warehouse.name} - 불량`);
      expect(await poList.optionLabels(poList.ownerSelect), '[Expected 2] Owner: All + 자사 / 파트너').toEqual([PO_KO['text.filterAll'], '자사 재고', '파트너 재고']);
      expect(await poList.optionLabels(poList.saleTypeSelect), '[Expected 2] Sale type: All + 사입 / 라이선스 판매 / 전체위탁').toEqual([PO_KO['text.filterAll'], PO_KO['saleType.PURCHASE'], PO_KO['saleType.LICENSE'], PO_KO['saleType.SELF']]);
      await expect(poList.periodTypeSelect, '[Expected 2] Period type defaults to Order date').toHaveValue('ORDER_DATE');
      await expect(poList.periodFromInput, '[Expected 2] From placeholder YYYY-MM-DD').toHaveAttribute('placeholder', 'YYYY-MM-DD');
      await expect(poList.periodToInput, '[Expected 2] To placeholder YYYY-MM-DD').toHaveAttribute('placeholder', 'YYYY-MM-DD');
      for (const name of QUICK_RANGES) await expect(poList.quickRange(name), `[Expected 2] Quick-range button ${name}`).toBeVisible();
      await expect(poList.resetButton, '[Expected 2] Reset button').toBeVisible();
      await expect(poList.searchButton, '[Expected 2] Search button').toBeVisible();
    });

    await step('Act: Step 3 — Observe the table header and the pagination area', async () => {
      await poList.pagerSummary.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Ten columns, Create PO / Excel download above, page size 10 and the pager below, Supplier snapshot', async () => {
      for (const column of LIST_COLUMNS) await expect(poList.columnHeader(column), `[Expected 3] Column ${column}`).toBeVisible();
      await expect(poList.createButton, '[Expected 3] Create PO above the table').toBeVisible();
      await expect(poList.excelButton, '[Expected 3] Excel download above the table').toBeVisible();
      await expect(poList.pageSizeSelect, '[Expected 3] Page size defaults to 10').toHaveValue('10');
      await expect(poList.pager, '[Expected 3] Pager below the table').toBeVisible();
      await poList.searchBy(PO_KO['searchType.PO_NO'], sameDay[0]);
      const supplier = poList.cell(poList.rowByPoNo(sameDay[0]), PO_KO['col.poList.supplier']);
      await expect(supplier, '[Expected 3] Supplier cell shows the stored Korean name snapshot').toContainText('스타쉽엔터테인먼트');
      await expect(supplier, '[Expected 3] Supplier cell carries the supplier-type label').toContainText(PO_KO['supplierType.BIZ_PARTNER']);
      await expect(supplier, '[Expected 3] Supplier cell never shows the raw id').not.toHaveText(/^\d+$/);
    });

    let firstOrder: string[] = [];
    await step('Act: Step 4 — Sort by 발주일 (Order date) and observe two POs raised on the same day', async () => {
      await poList.keywordInput.fill('');
      await poList.warehouseSelect.selectOption({ label: poData.warehouse.name });
      await poList.search();
      firstOrder = (await poList.columnTexts(PO_KO['col.poList.poNo'])).filter((no) => sameDay.includes(no));
      await poList.search();
    });

    await step('Assert: Expected 4 — Same-day orders keep a stable relative order (id DESC); a PO appears once', async () => {
      const again = (await poList.columnTexts(PO_KO['col.poList.poNo'])).filter((no) => sameDay.includes(no));
      expect(again, '[Expected 4] The two same-day POs keep the same relative order across a re-sort').toEqual(firstOrder);
      expect(firstOrder, '[Expected 4] Tie broken on id DESC — the later-created PO comes first').toEqual([...sameDay].reverse());
      const all = await poList.columnTexts(PO_KO['col.poList.poNo']);
      expect(new Set(all).size, '[Expected 4] No PO appears twice in the list').toBe(all.length);
    });
  });

  test('TC_US105_011 — The PO form in create mode renders every field and the Draft action set', async ({ page, poList, poForm }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_011', 'Medium', TAGS, 'Draft badge; PO no. read-only (자동 발번); Supplier type mandatory defaulting to Biz partner; Supplier / Manufacturer / Inbound destination placeholders; Order date today; Expected inbound date empty; Currency KRW; empty line table with its message and nine columns; Add line, Save draft, Issue PO, Delete and Excel download present; no Change history before the first save.');

    await step('Arrange: Pre-condition 1–2 — INVENTORY_OPERATOR on the 발주 관리 screen', async () => {
      await poList.open();
    });

    await step('Act: Step 1 — Click 발주 등록 (Create PO)', async () => {
      await poList.createButton.click();
      await poForm.header.waitFor();
    });

    await step('Assert: Expected 1 — The form opens in Draft status with a Draft badge', async () => {
      await expect(poForm.statusBadge, '[Expected 1] Badge 작성 중 (Draft)').toHaveText(PO_KO['poStatus.DRAFT']);
    });

    await step('Act: Step 2 — Observe the general information block', async () => {
      await poForm.poNoInput.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Every general-information field with its default / placeholder', async () => {
      await expect(poForm.poNoInput, '[Expected 2] PO no. shows (자동 발번)').toHaveValue(PO_KO['text.poNoAuto']);
      await expect(poForm.poNoInput, '[Expected 2] PO no. is read-only').toHaveAttribute('readonly', '');
      expect(await poForm.optionLabels(poForm.supplierTypeSelect), '[Expected 2] Supplier type: Biz partner / Manufacturer').toEqual([PO_KO['supplierType.BIZ_PARTNER'], PO_KO['supplierType.MANUFACTURER']]);
      await expect(poForm.supplierTypeSelect, '[Expected 2] Supplier type defaults to Biz partner').toHaveValue('BIZ_PARTNER');
      await expect(poForm.field(PO_KO['text.supplierTypeLabel']).locator('xpath=preceding-sibling::label'), '[Expected 2] Supplier type carries the mandatory marker').toContainText('*');
      await expect(poForm.supplierSelect.locator('option:checked'), '[Expected 2] Supplier placeholder "— 공급처 선택 —"').toHaveText(PO_KO['text.supplierPlaceholder']);
      await expect(poForm.manufacturerSelect.locator('option:checked'), '[Expected 2] Manufacturer placeholder "— 선택 (임의) —"').toHaveText(PO_KO['text.manufacturerPlaceholder']);
      await expect(poForm.orderDateInput, '[Expected 2] Order date defaults to today').toHaveValue(new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }));
      await expect(poForm.expectedDateInput, '[Expected 2] Expected inbound date is empty').toHaveValue('');
      await expect(poForm.expectedDateInput, '[Expected 2] Expected inbound date placeholder YYYY-MM-DD').toHaveAttribute('placeholder', 'YYYY-MM-DD');
      await expect(poForm.destinationSelect.locator('option:checked'), '[Expected 2] Inbound destination placeholder "— 입고지 선택 —"').toHaveText(PO_KO['text.destinationPlaceholder']);
      await expect(poForm.currencySelect, '[Expected 2] Currency defaults to KRW').toHaveValue('KRW');
    });

    await step('Act: Step 3 — Observe the line table, the button group and the card header block', async () => {
      await poForm.addLineButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Empty line table, nine columns, the Draft buttons and no Change history yet', async () => {
      await expect(poForm.emptyLines, '[Expected 3] Empty-table message').toBeVisible();
      for (const column of LINE_COLUMNS.slice(1)) await expect(poForm.lineTable.getByRole('columnheader', { name: column, exact: true }), `[Expected 3] Line column ${column}`).toBeVisible();
      await expect(poForm.lineTable.locator('thead th').last(), '[Expected 3] An action column closes the header').toHaveText('');
      for (const button of [poForm.addLineButton, poForm.saveDraftButton, poForm.issueButton, poForm.deleteButton, poForm.excelButton]) {
        await expect(button, `[Expected 3] ${await button.innerText()} is present`).toBeVisible();
      }
      await expect(poForm.historyButton, '[Expected 3] Change history is not shown before the first save').toHaveCount(0);
    });
  });

  test('TC_US105_012 — The PO form in Issued status renders the receipt history and its action set', async ({ page, poForm, poData, approverPoApi }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_012', 'Medium', TAGS, 'Issued badge; the receipt history block with every column, an Exception badge, a Resolve link and the reason DISPLAY NAME (never the raw code); only Receive goods / Cancel PO / Close PO with their icons; Excel download and Change history side by side; the reason area shows 종결 사유 / 취소 사유 only when a reason was stored.');
    let po = await poData.createIssued();
    let closed = await poData.createIssued();
    let canceled = await poData.createIssued();

    await step('Arrange: Pre-condition 1–2 — PO A Issued with Receipt A in Exception (plus a Closed and a Canceled order)', async () => {
      await poData.receive(po, 290, 0, 'ADJ_DAMAGED', approverPoApi);
      po = await poData.read(po.id);
      await poData.api.close(closed.id, 'auto close reason 012', closed.version);
      await poData.api.cancel(canceled.id, 'auto cancel reason 012', canceled.version);
      closed = await poData.read(closed.id);
      canceled = await poData.read(canceled.id);
    });

    await step('Act: Step 1 — Open PO A', async () => {
      await poForm.openPo(po.id);
    });

    await step('Assert: Expected 1 — The status badge reads Issued', async () => {
      await expect(poForm.statusBadge, '[Expected 1] Badge 발주 완료 (Issued)').toHaveText(PO_KO['poStatus.ISSUED']);
    });

    await step('Act: Step 2 — Observe the receipt history block', async () => {
      await poForm.grnTable.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Every receipt column, Exception badge, Resolve link, reason display name', async () => {
      for (const column of GRN_COLUMNS) await expect(poForm.grnTable.getByRole('columnheader', { name: column, exact: true }), `[Expected 2] Receipt column ${column}`).toBeVisible();
      const row = poForm.grnRows.first();
      await expect(row.locator('.badge'), '[Expected 2] The receipt row carries the 차이 발생 (Exception) badge').toHaveText(PO_KO['grnStatus.EXCEPTION']);
      await expect(row.getByRole('button'), '[Expected 2] The row offers the 차이 처리 (Resolve) link').toHaveText(PO_KO['text.resolve']);
      const reasonCell = row.locator('td').nth(GRN_COLUMNS.indexOf(PO_KO['col.grnList.reason']));
      await expect(reasonCell, '[Expected 2] Reason shows the display name 파손').toHaveText('파손');
      await expect(reasonCell, '[Expected 2] Reason never shows the raw code').not.toContainText('ADJ_');
    });

    await step('Act: Step 3 — Observe the action row, the icon on each button and the card header block', async () => {
      await poForm.header.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Only Receive goods / Cancel PO / Close PO with icons; Excel download and Change history side by side', async () => {
      expect(await poForm.actionNames(), '[Expected 3] Action row holds exactly Receive goods, Cancel PO, Close PO').toEqual([PO_KO['text.receiveGoods'], PO_KO['text.cancelPo'], PO_KO['text.closePo']]);
      for (const absent of [poForm.saveDraftButton, poForm.issueButton, poForm.deleteButton]) await expect(absent, '[Expected 3] Draft-only buttons are absent').toHaveCount(0);
      for (const button of [poForm.receiveButton, poForm.cancelPoButton, poForm.closePoButton]) await expect(button.locator('i'), `[Expected 3] ${await button.innerText()} carries an icon`).toHaveCount(1);
      await expect(poForm.excelButton, '[Expected 3] Excel download in the header block').toBeVisible();
      await expect(poForm.historyButton, '[Expected 3] Change history in the header block').toBeVisible();
      const [excelBox, historyBox] = [await poForm.excelButton.boundingBox(), await poForm.historyButton.boundingBox()];
      expect(Math.abs((excelBox?.y ?? 0) - (historyBox?.y ?? -100)), '[Expected 3] Excel download and Change history sit side by side').toBeLessThan(5);
    });

    await step('Act: Step 4 — Open a Closed order and then a Canceled order, observing the reason area', async () => {
      await poForm.openPo(closed.id);
    });

    await step('Assert: Expected 4 — The reason area shows 종결 사유 on Closed and 취소 사유 on Canceled', async () => {
      await expect(page.getByText(PO_KO['text.closeReasonLabel'], { exact: true }), '[Expected 4] Closed order labels the reason 발주 종결 사유').toBeVisible();
      await expect(page.getByText('auto close reason 012'), '[Expected 4] Closed order shows the stored reason').toBeVisible();
      await poForm.openPo(canceled.id);
      await expect(page.getByText(PO_KO['text.cancelReasonLabel'], { exact: true }), '[Expected 4] Canceled order labels the reason 발주 취소 사유').toBeVisible();
      await expect(page.getByText('auto cancel reason 012'), '[Expected 4] Canceled order shows the stored reason').toBeVisible();
    });
  });

  test('TC_US105_013 — The Receive goods dialog renders every field, the note and the attachment panel', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_013', 'Medium', TAGS, 'Header with the PO number; Received date today, Received qty, Damaged qty 0, Accepted / Missing read-only, reason placeholder, Detailed reason, delivery-document panel with n / 10 counter, Save / Cancel; FIVE adjustment codes; the 290 / 5 calculation; 기타 makes Detailed reason mandatory; 파손 keeps it optional; Save without attachment refused PRC-1031; no purchase-value passage.');
    const po = await poData.createIssued([{ qty: 300, price: 39150 }]);
    const dialog = poForm.receiveDialog();

    await step('Arrange: Pre-condition 1–3 — PO A Issued with one line 300 × 39,150; reason master active', async () => {
      await poForm.openPo(po.id);
    });

    await step('Act: Step 1 — Open PO A and click 입고 검수 (Receive goods)', async () => {
      await poForm.openReceive();
    });

    await step('Assert: Expected 1 — The dialog opens and its header shows the PO number', async () => {
      await expect(dialog.title, '[Expected 1] Title 입고 검수').toContainText(PO_KO['text.receiveTitle']);
      await expect(dialog.poNoBadge, '[Expected 1] Header shows the PO number').toHaveText(po.poNo);
    });

    await step('Act: Step 2 — Observe the input fields', async () => {
      await dialog.receivedDate.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Every element of the dialog', async () => {
      await expect(dialog.receivedDate, '[Expected 2] Received date defaults to today').toHaveValue(new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }));
      await expect(dialog.receivedQty(), '[Expected 2] Received qty input').toBeEditable();
      await expect(dialog.damagedQty(), '[Expected 2] Damaged qty defaults to 0').toHaveValue('0');
      await expect(dialog.calcValue(PO_KO['text.calcToAvailable']), '[Expected 2] Accepted (가용재고) is a read-only figure').toBeVisible();
      await expect(dialog.table.getByRole('columnheader', { name: PO_KO['text.colMissingQty'] }), '[Expected 2] Missing (미입고 수량) is a read-only column').toBeVisible();
      await expect(dialog.reasonSelect.locator('option').first(), '[Expected 2] Reason placeholder "— 사유 선택 —"').toHaveText(PO_KO['text.reasonPlaceholder']);
      await expect(dialog.detailReasonInput, '[Expected 2] Detailed reason field').toBeVisible();
      await expect(dialog.attachLabel, '[Expected 2] Delivery-document panel with an n / 10 counter').toContainText('0 / 10');
      await expect(dialog.root.getByRole('button', { name: /Choose files|파일 선택/ }), '[Expected 2] A Choose files button').toBeVisible();
      await expect(dialog.saveButton, '[Expected 2] Save').toBeVisible();
      await expect(dialog.cancelButton, '[Expected 2] Cancel').toBeVisible();
    });

    await step('Act: Step 3 — Expand the 차이 사유 (Discrepancy reason) list', async () => {
      await dialog.reasonSelect.focus();
    });

    await step('Assert: Expected 3 — FIVE adjustment-group codes: 불일치, 파손, 분실, 기타, 실사', async () => {
      const names = (await dialog.reasonSelect.locator('option').allInnerTexts()).slice(1);
      for (const name of ['불일치', '파손', '분실', '기타', '실사']) expect(names, `[Expected 3] Reason ${name} is listed`).toContain(name);
      expect(names, '[Expected 3] No inbound-group code is listed').not.toContain('발주');
      expect(names, '[Expected 3] Exactly five codes').toHaveLength(5);
    });

    await step('Act: Step 4 — Enter 입고완료수량 290 and 파손 수량 5, then observe the calculation panel', async () => {
      await dialog.fillQuantities(290, 5);
    });

    await step('Assert: Expected 4 — Purchase 11,353,500 KRW, To available 285, To Defective 5, Still outstanding 10', async () => {
      await expect(dialog.calcValue(PO_KO['text.calcPurchaseAmount']), '[Expected 4] Purchase 11,353,500 KRW').toHaveText('11,353,500 KRW');
      await expect(dialog.calcValue(PO_KO['text.calcToAvailable']), '[Expected 4] To available stock 285').toHaveText('285');
      await expect(dialog.calcValue(PO_KO['text.calcToDefective']), '[Expected 4] To Defective 5').toHaveText('5');
      await expect(dialog.lineCell(0, 4), '[Expected 4] Still outstanding 10').toHaveText('10');
    });

    await step('Act: Step 5 — Set 차이 사유 to 기타 and observe the Detailed reason field', async () => {
      await dialog.reasonSelect.selectOption({ label: '기타' });
    });

    await step('Assert: Expected 5 — Detailed reason becomes mandatory with a * and the required placeholder', async () => {
      await expect(dialog.root.locator('label.form-label').filter({ hasText: PO_KO['text.detailReasonLabel'] }), '[Expected 5] Detailed reason label gains a *').toContainText('*');
      await expect(dialog.detailReasonInput, '[Expected 5] Placeholder switches to the required wording').toHaveAttribute('placeholder', PO_KO['text.detailReasonRequiredPlaceholder']);
    });

    await step('Act: Step 6 — Set 차이 사유 to 파손 and observe the Detailed reason field', async () => {
      await dialog.reasonSelect.selectOption({ label: '파손' });
    });

    await step('Assert: Expected 6 — Detailed reason stays optional', async () => {
      await expect(dialog.root.locator('label.form-label').filter({ hasText: PO_KO['text.detailReasonLabel'] }), '[Expected 6] No * on Detailed reason').not.toContainText('*');
      await expect(dialog.detailReasonInput, '[Expected 6] Optional placeholder').toHaveAttribute('placeholder', PO_KO['text.detailReasonPlaceholder']);
    });

    const writes: string[] = [];
    await step('Act: Step 7 — Observe the delivery-document panel and try to click Save with it empty', async () => {
      page.on('request', (r) => r.method() === 'POST' && r.url().includes('/goods-receipts') && writes.push(r.url()));
      await dialog.saveButton.click();
    });

    await step('Assert: Expected 7 — Save is refused with PRC-1031 "Attach at least one delivery document before saving."', async () => {
      await expect(dialog.root, '[Expected 7] PRC-1031 message is shown').toContainText(PO_KO['error.PRC-1031']);
      await expect(dialog.root, '[Expected 7] The dialog stays open').toBeVisible();
      expect((await poData.api.goodsReceipts(po.id)).length, '[Expected 7] No receipt is created').toBe(0);
    });

    await step('Act: Step 8 — Observe the remaining text in the dialog', async () => {
      await dialog.calcPanel.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 8 — No three-sentence passage explaining how the purchase value is recorded', async () => {
      await expect(dialog.root, '[Expected 8] No explanatory passage about the purchase value').not.toContainText(/매입금액은|purchase value is/i);
    });
  });

  test('TC_US105_014 — The discrepancy dialog renders every column, its buttons and Change history', async ({ page, poForm, poData, approverPoApi }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_014', 'Medium', TAGS, 'Exception badge, no red banner; columns SKU / Ordered / Received / Damaged / Discrepancy / Purchase amount with the reason, note, Approve discrepancy and Cancel; the reason list equals the Receive goods list; no component-74 message for a non-recorder approver; Edit disabled with the recorder-only tooltip, Reject enabled, Change history opens the receipt history. Runs as the bypass account; the receipt is recorded by dungbd.fpt.');
    let po = await poData.createIssued();
    let grnNo = '';
    const dialog = poForm.resolveDialog();

    await step('Arrange: Pre-condition 1–2 — PO A with Receipt A in Exception (290 / damaged 5) recorded by a different account', async () => {
      await poData.receive(po, 290, 5, 'ADJ_DAMAGED', approverPoApi);
      po = await poData.read(po.id);
      grnNo = (await poData.api.goodsReceipts(po.id))[0].grnNo;
      await poForm.openPo(po.id);
    });

    await step('Act: Step 1 — Open PO A and click the Resolve link', async () => {
      await poForm.openResolve(grnNo);
    });

    await step('Assert: Expected 1 — The dialog opens', async () => {
      await expect(dialog.title, '[Expected 1] Title 입고 차이 처리').toContainText(PO_KO['text.exceptionTitle']);
    });

    await step('Act: Step 2 — Observe the top of the dialog', async () => {
      await dialog.title.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Exception badge on the header; no red banner above the table', async () => {
      await expect(dialog.statusBadge, '[Expected 2] Exception badge').toHaveText(PO_KO['grnStatus.EXCEPTION']);
      await expect(dialog.root.locator('.modal-body .alert-danger'), '[Expected 2] No red banner').toHaveCount(0);
    });

    await step('Act: Step 3 — Observe the figures table', async () => {
      await dialog.table.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Columns and the reason / note / Approve discrepancy / Cancel below it', async () => {
      for (const column of [PO_KO['text.colSku'], PO_KO['text.colOrderedQty'], PO_KO['text.colReceivedQty'], PO_KO['text.colDamagedQty'], PO_KO['text.colDiscrepancy'], PO_KO['text.colPurchaseAmount']]) {
        await expect(dialog.table.getByRole('columnheader', { name: column, exact: true }), `[Expected 3] Column ${column}`).toBeVisible();
      }
      await expect(dialog.reasonSelect, '[Expected 3] Mandatory discrepancy reason').toBeVisible();
      await expect(dialog.noteInput, '[Expected 3] Note input').toBeVisible();
      await expect(dialog.approveButton, '[Expected 3] Approve discrepancy').toBeVisible();
      await expect(dialog.cancelButton, '[Expected 3] Cancel').toBeVisible();
    });

    let resolveReasons: string[] = [];
    await step('Act: Step 4 — Expand the 차이 사유 list and compare it with the Receive goods list', async () => {
      resolveReasons = (await dialog.reasonSelect.locator('option').allInnerTexts()).slice(1);
    });

    await step('Assert: Expected 4 — The list matches the four codes of the Receive goods dialog exactly', async () => {
      expect(resolveReasons, '[Expected 4] Exactly the four codes of the Receive goods dialog').toEqual(UI_REASONS.map((r) => r.name));
    });

    await step('Act: Step 5 — Observe the message area directly above the dialog button group', async () => {
      await dialog.root.locator('.modal-footer').scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 5 — No component-74 message is rendered', async () => {
      await expect(dialog.root, '[Expected 5] The identity-branch message is not shown').not.toContainText(PO_KO['error.PRC-1028']);
      await expect(dialog.root, '[Expected 5] The role-branch message is not shown').not.toContainText(PO_KO['error.PRC-1011']);
    });

    await step('Act: Step 6 — Observe the button row: Approve discrepancy, Edit, Reject receipt and Change history', async () => {
      await dialog.historyButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 6 — Edit disabled with its tooltip, Reject enabled, Change history opens the receipt history', async () => {
      await expect(dialog.editButton, '[Expected 6] Edit is rendered').toBeVisible();
      await expect(dialog.editButton, '[Expected 6] Edit is disabled for a non-recorder').toBeDisabled();
      await expect(dialog.editButton, '[Expected 6] Edit tooltip names the recorder-only rule').toHaveAttribute('title', PO_KO['error.PRC-1033']);
      await expect(dialog.rejectButton, '[Expected 6] Reject receipt is enabled').toBeEnabled();
      const history = page.waitForResponse((r) => /\/goods-receipts\/\d+\/history/.test(r.url()));
      await dialog.historyButton.click();
      expect((await history).status(), '[Expected 6] Change history reads the goodsreceipt history').toBe(200);
      await expect(poForm.historyDialog().title, '[Expected 6] The shared history dialog opens').toContainText(PO_KO['text.grnHistoryTitle']);
    });
  });

  test('TC_US105_015 — The reason dialog takes the right title from each of its three callers', async ({ page, poForm, poData, approverPoApi }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_015', 'Medium', TAGS, 'Cancel PO → "발주 취소 사유"; Close PO → "발주 종결 사유"; only the reason input with its placeholder and the confirm / cancel buttons, no immutability text; Reject receipt → "입고 반려 사유" with a mandatory reason CODE beside the explanation. The third caller runs with the bypass account against a receipt recorded by dungbd.fpt.');
    const poA = await poData.createIssued();
    let poB = await poData.createIssued();
    const reason = poForm.reasonDialog();

    await step('Arrange: Pre-condition 1–4 — PO A Issued, no receipt; PO B with Receipt B in Exception recorded by a different account', async () => {
      await poData.receive(poB, 290, 0, 'ADJ_DISCREPANCY', approverPoApi);
      poB = await poData.read(poB.id);
      await poForm.openPo(poA.id);
    });

    await step('Act: Step 1 — Open PO A, click 발주 취소, observe the title, then close it', async () => {
      await poForm.cancelPoButton.click();
      await reason.waitOpen();
    });

    await step('Assert: Expected 1 — The dialog title reads "Cancel reason"', async () => {
      await expect(reason.title, '[Expected 1] Title 발주 취소 사유').toHaveText(PO_KO['text.reasonTitleCancel']);
      await reason.cancelButton.click();
    });

    await step('Act: Step 2 — On the same PO click 발주 종결 and observe the dialog title', async () => {
      await poForm.closePoButton.click();
      await reason.waitOpen();
    });

    await step('Assert: Expected 2 — The dialog title reads "Close reason"', async () => {
      await expect(reason.title, '[Expected 2] Title 발주 종결 사유').toHaveText(PO_KO['text.reasonTitleClose']);
    });

    await step('Act: Step 3 — Observe the area under the reason input', async () => {
      await reason.reasonInput.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Only the reason input, placeholder and the two buttons; no immutability text', async () => {
      await expect(reason.reasonInput, '[Expected 3] Reason input placeholder').toHaveAttribute('placeholder', PO_KO['text.reasonInputPlaceholder']);
      await expect(reason.confirmButton, '[Expected 3] Confirm button').toBeVisible();
      await expect(reason.cancelButton, '[Expected 3] Cancel button').toBeVisible();
      await expect(reason.root, '[Expected 3] No text states the reason / action cannot be edited').not.toContainText(/되돌릴 수 없|수정할 수 없/);
      await reason.cancelButton.click();
    });

    await step('Act: Step 4 — Open PO B, click Reject receipt on the discrepancy dialog and observe the title and fields', async () => {
      await poForm.openPo(poB.id);
      const [grn] = await poData.api.goodsReceipts(poB.id);
      const resolve = await poForm.openResolve(grn.grnNo);
      await resolve.rejectButton.click();
      await reason.waitOpen();
    });

    await step('Assert: Expected 4 — Title "Reject reason" with a mandatory reason CODE beside the explanation', async () => {
      await expect(reason.title, '[Expected 4] Title 입고 반려 사유').toHaveText(PO_KO['text.reasonTitleGrnReject']);
      await expect(reason.reasonCodeSelect, '[Expected 4] A reason code field is present').toBeVisible();
      expect((await reason.reasonCodeSelect.locator('option').allInnerTexts()).slice(1), '[Expected 4] Reason codes come from the US062 adjustment master').toEqual(UI_REASONS.map((r) => r.name));
      await expect(reason.reasonInput, '[Expected 4] The free-text explanation is present alongside').toBeVisible();
    });
  });

  test('TC_US105_016 — The Change history dialog renders four columns and no Reason column', async ({ page, poForm, poData }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_016', 'Medium', TAGS, 'Change history sits next to Excel download outside the action row; the dialog opens over the form keeping its values; title with the PO number, exactly four columns 변경 일시 / 변경자 / 항목 / 변경 내용, newest first, not sortable, no per-row action; an order without history rows shows the headers and "변경 이력이 없습니다"; Esc, outside click and the close button all close it. Not automated: the empty-body message of Expected 4 — every saved PO already holds its CREATED row, so an order with no history row cannot be built.');
    const po = await poData.createDraft();
    const history = poForm.historyDialog();

    await step('Arrange: Pre-condition 1–2 — PO A saved and edited at least twice', async () => {
      for (const qty of [310, 320]) {
        const fresh = await poData.read(po.id);
        await poData.api.update(po.id, toPoUpdateBody(fresh, { lines: [{ ...fresh.lines[0], orderedQty: qty }] }));
      }
      await poForm.openPo(po.id);
    });

    await step('Act: Step 1 — Locate the 변경 이력 button in the card header block', async () => {
      await poForm.historyButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — Change history is shown next to Excel download, outside the action row', async () => {
      await expect(poForm.historyButton, '[Expected 1] Change history is shown').toBeVisible();
      await expect(poForm.actionRow.getByRole('button', { name: PO_KO['text.changeHistory'] }), '[Expected 1] It is not part of the action row').toHaveCount(0);
      await expect(poForm.excelButton.locator('xpath=following-sibling::button[1]'), '[Expected 1] It sits right after Excel download').toHaveText(PO_KO['text.changeHistory']);
    });

    let qtyBefore = '';
    await step('Act: Step 2 — Click 변경 이력', async () => {
      qtyBefore = await poForm.lineQty().inputValue();
      await poForm.openHistory();
    });

    await step('Assert: Expected 2 — The dialog opens over the form; the form keeps its mode and values', async () => {
      await expect(history.root, '[Expected 2] The dialog is open').toBeVisible();
      await expect(poForm.saveDraftButton, '[Expected 2] The form keeps its Draft mode underneath').toBeAttached();
      expect(await poForm.lineQty().inputValue(), '[Expected 2] The form keeps every value').toBe(qtyBefore);
    });

    await step('Act: Step 3 — Observe the dialog title and the table column headers', async () => {
      await history.table.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Title with PO number, exactly four columns, newest first, not sortable, no row action', async () => {
      await expect(history.title, '[Expected 3] Title 변경 이력').toContainText(PO_KO['text.historyTitle']);
      await expect(history.title, '[Expected 3] PO number beside the title').toContainText(po.poNo);
      expect(await history.headers(), '[Expected 3] Exactly four columns, no Reason column').toEqual([PO_KO['col.history.when'], PO_KO['col.history.who'], PO_KO['col.history.setting'], PO_KO['col.history.change']]);
      const when = await history.rows.locator('td:first-child').allInnerTexts();
      expect(when, '[Expected 3] Newest first').toEqual([...when].sort().reverse());
      await history.table.locator('thead th').first().click();
      expect(await history.rows.locator('td:first-child').allInnerTexts(), '[Expected 3] Clicking a header does not change the order').toEqual(when);
      await expect(history.rows.getByRole('button'), '[Expected 3] No per-row action').toHaveCount(0);
    });

    await step('Act: Step 4 — Observe the table body on an order with no history row', async () => {
      await history.closeButton.click();
      await poForm.openHistory();
    });

    await step('Assert: Expected 4 — The four column headers are still rendered (empty-body message: Not automated)', async () => {
      // Not automated: mọi PO đã lưu đều có sẵn dòng CREATED (최초 등록) và form chưa lưu không có nút 변경 이력 (TC_011)
      // → không dựng được "đơn không có dòng lịch sử" để thấy "변경 이력이 없습니다". Chỉ kiểm phần header của ý này.
      expect(await history.headers(), '[Expected 4] The four column headers are rendered').toEqual([PO_KO['col.history.when'], PO_KO['col.history.who'], PO_KO['col.history.setting'], PO_KO['col.history.change']]);
      await history.closeButton.click();
    });

    await step('Act: Step 5 — Close the dialog with Esc, by clicking outside, and with the close button', async () => {
      await poForm.openPo(po.id);
      await poForm.openHistory();
      await page.keyboard.press('Escape');
    });

    await step('Assert: Expected 5 — All three ways close the dialog and return to the form with its values', async () => {
      await expect(history.root, '[Expected 5] Esc closes the dialog').toBeHidden();
      await poForm.openHistory();
      await page.mouse.click(5, 5);
      await expect(history.root, '[Expected 5] An outside click closes the dialog').toBeHidden();
      await poForm.openHistory();
      await history.closeButton.click();
      await expect(history.root, '[Expected 5] The close button closes the dialog').toBeHidden();
      expect(await poForm.lineQty().inputValue(), '[Expected 5] The form keeps every value').toBe('320');
    });
  });

  test('TC_US105_017 — The PO status badges and the receipt status badges carry the right colour and wording', async ({ page, poList, poForm, poData, approverPoApi }) => {
    const step = makeStep(page);
    await tcMeta('TC_US105_017', 'Low', TAGS, 'Draft neutral, Issued green, Closed purple, Canceled red, no amber badge, never the status code; Exception red; Complete green; Rejected neutral grey with a View link opening read-only; a receipt for the exact quantity shows the info-blue Received badge.');
    const draft = await poData.createDraft();
    const issued = await poData.createIssued();
    const closed = await poData.createIssued();
    const canceled = await poData.createIssued();
    const exc = await poData.createIssued();
    const complete = await poData.createIssued();
    let rejected = await poData.createIssued();
    const exact = await poData.createIssued([{ qty: 10 }]);

    await step('Arrange: Pre-condition 1–2 — POs in all four statuses plus Exception, Complete and Rejected receipts', async () => {
      await poData.api.close(closed.id, 'auto 017', closed.version);
      await poData.api.cancel(canceled.id, 'auto 017', canceled.version);
      await poData.receive(exc, 290, 0, 'ADJ_DISCREPANCY');
      await poData.receive(complete, 100, 0);
      await poData.receive(rejected, 290, 0, 'ADJ_DISCREPANCY', approverPoApi);
      rejected = await poData.read(rejected.id);
      const [grn] = await poData.api.goodsReceipts(rejected.id);
      await poData.api.rejectReceipt(rejected.id, grn.id, 'ADJ_DISCREPANCY', 'auto 017', (await poData.api.goodsReceipt(rejected.id, grn.id)).body.version);
      await poList.open();
    });

    await step('Act: Step 1 — Observe the Status column on every row', async () => {
      await poList.warehouseSelect.selectOption({ label: poData.warehouse.name });
      await poList.pageSizeSelect.selectOption('100');
      await poList.search();
    });

    await step('Assert: Expected 1 — Four badges, one colour per status, no amber badge, never the code', async () => {
      const badge = (no: string) => poList.cell(poList.rowByPoNo(no), PO_KO['col.poList.status']).locator('.badge');
      await expect(badge(draft.poNo), '[Expected 1] Draft badge is neutral').toHaveClass(/bg-(secondary|light)/);
      await expect(badge(issued.poNo), '[Expected 1] Issued badge is green').toHaveClass(/bg-success/);
      await expect(badge(closed.poNo), '[Expected 1] Closed badge is purple').toHaveClass(/bg-(purple|indigo)/);
      await expect(badge(canceled.poNo), '[Expected 1] Canceled badge is red').toHaveClass(/bg-danger/);
      await expect(poList.table.locator('.badge.bg-warning'), '[Expected 1] No amber badge on this screen').toHaveCount(0);
      const statuses = await poList.columnTexts(PO_KO['col.poList.status']);
      expect(statuses.filter((s) => /DRAFT|ISSUED|CLOSED|CANCELED/.test(s)), '[Expected 1] No row shows the status code').toEqual([]);
    });

    await step('Act: Step 2 — Open the PO carrying the Exception receipt and observe the receipt badge', async () => {
      await poForm.openPo(exc.id);
    });

    await step('Assert: Expected 2 — The Exception badge is red', async () => {
      await expect(poForm.grnRows.first().locator('.badge'), '[Expected 2] Exception badge is red').toHaveClass(/bg-danger/);
    });

    await step('Act: Step 3 — Open the PO carrying the Complete receipt and observe the receipt badge', async () => {
      await poForm.openPo(complete.id);
    });

    await step('Assert: Expected 3 — The Complete badge is green', async () => {
      await expect(poForm.grnRows.first().locator('.badge'), '[Expected 3] Complete badge reads 입고 완료').toHaveText(PO_KO['grnStatus.COMPLETE']);
      await expect(poForm.grnRows.first().locator('.badge'), '[Expected 3] Complete badge is green').toHaveClass(/bg-success/);
    });

    await step('Act: Step 4 — Open the PO carrying the Rejected receipt and observe the badge and its link', async () => {
      await poForm.openPo(rejected.id);
    });

    await step('Assert: Expected 4 — Rejected badge neutral grey; the link reads View and opens read-only', async () => {
      const row = poForm.grnRows.first();
      await expect(row.locator('.badge'), '[Expected 4] Rejected badge reads 입고 반려').toHaveText(PO_KO['grnStatus.REJECTED']);
      await expect(row.locator('.badge'), '[Expected 4] Rejected badge is neutral grey, not red').toHaveClass(/bg-secondary/);
      await expect(row.getByRole('button'), '[Expected 4] The action-cell link reads View, not Resolve').not.toHaveText(PO_KO['text.resolve']);
      await row.getByRole('button').click();
      const dialog = poForm.resolveDialog();
      await expect(dialog.approveButton, '[Expected 4] The dialog opens read-only (no Approve discrepancy)').toHaveCount(0);
    });

    await step('Act: Step 5 — Record a receipt for the exact quantity on an Issued PO and observe the badge', async () => {
      await poData.receive(exact, 10, 0);
      await poForm.openPo(exact.id);
    });

    await step('Assert: Expected 5 — The Received badge is info-blue', async () => {
      await expect(poForm.grnRows.first().locator('.badge'), '[Expected 5] Badge reads 입고 등록 (Received)').toHaveText(PO_KO['grnStatus.RECEIVED']);
      await expect(poForm.grnRows.first().locator('.badge'), '[Expected 5] Received badge is info-blue').toHaveClass(/bg-info/);
    });
  });
});
