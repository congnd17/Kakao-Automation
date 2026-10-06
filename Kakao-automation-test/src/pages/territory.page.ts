import { Page, Locator, Response, expect, test } from '@playwright/test';
import { BasePage } from './base.page';

/**
 * Territory (US089) — list `/commerce/territories`, màn sửa `/commerce/territories/{code}/edit`, dialog 변경 이력.
 * Locator dùng id ổn định của app (verify DOM thật 29/09). Không có mục menu nào dẫn tới màn (verify 29/09) → mở bằng URL.
 * Ngôn ngữ giao diện: mặc định tiếng Hàn, `?lang=en` → tiếng Anh (tham số ngôn ngữ của app; không có nút EN / 한국어 trên màn).
 */
/**
 * Tên của mọi control thao tác đang hiển thị trên màn + dialog đang mở, BỎ QUA khung app (sidebar / top bar / breadcrumb:
 * `nav, aside, header`) — dev không có landmark `main` (verify 29/09).
 */
async function visibleControlNames(page: Page): Promise<string[]> {
  return page.locator('button, a, [role="button"], [role="menuitem"]').evaluateAll((els) =>
    els
      .filter((el) => !el.closest('nav, aside, header') && (el as HTMLElement).offsetParent !== null)
      .map((el) => (el.getAttribute('aria-label') ?? (el as HTMLElement).innerText ?? '').trim()),
  );
}

export class TerritoryListPage extends BasePage {
  readonly title = this.page.getByRole('heading', { level: 4 });
  readonly breadcrumb = this.page.getByRole('navigation', { name: 'breadcrumb' });
  readonly readOnlyNotice = this.page.locator('#msg_view_only');
  readonly searchInput = this.page.locator('#inp_country');
  readonly vatSelect = this.page.locator('#sel_vat_treatment');
  readonly exportSelect = this.page.locator('#sel_export_req');
  readonly resetButton = this.page.locator('#btn_reset');
  readonly searchButton = this.page.locator('#btn_search');
  readonly table = this.page.locator('#tbl_territory');
  /** Khung cuộn riêng của bảng (`.table-responsive`) — bảng giữ min-width nên tràn ngang nằm trong khung này. */
  readonly tableContainer = this.table.locator('xpath=..');
  readonly headers = this.table.locator('thead th');
  readonly rows = this.table.locator('tbody tr');
  readonly counter = this.page.locator('span.text-muted', { hasText: /개 표시|showing/ });
  readonly pageSizeSelect = this.page.locator('select.form-select-sm');
  readonly pageSizeLabel = this.page.getByText(/^\s*(페이지당|Rows per page)\s*$/);
  readonly pagination = this.page.locator('ul.pagination');
  readonly pageItems = this.pagination.locator('li.page-item');
  readonly noResults = this.rows.first().locator('td[colspan]');
  readonly historyDialog = new TerritoryHistoryDialog(this.page);
  /** Nhóm menu 마스터 데이터 + mục Territory theo TC — dev 29/09 KHÔNG có (sidebar chỉ có nhóm COMMERCE…). */
  readonly sidebarMasterDataGroup = this.page.getByRole('link', { name: /마스터 데이터/ });
  readonly sidebarTerritoryMenu = this.page.getByRole('link', { name: /^Territory$/ });

  constructor(page: Page) {
    super(page);
  }

  /** Mở list; `lang = 'en'` → giao diện tiếng Anh. Chờ đúng lượt GET list trả về. */
  async open(lang?: 'en'): Promise<void> {
    await this.untilListed(() => this.goto(`/commerce/territories${lang ? '?lang=en' : ''}`));
    await expect(this.rows.first(), 'The territory table has loaded').toBeVisible();
  }

  /** Chạy `action` và chờ lượt GET /api/v1/territories?… mà nó gây ra (bảng render lại sau response). */
  async untilListed(action: () => Promise<void>): Promise<Response> {
    const listed = this.page.waitForResponse((r) => r.request().method() === 'GET' && /\/api\/v1\/territories\?/.test(r.url()));
    await action();
    const response = await listed;
    await this.page.waitForLoadState('networkidle');
    return response;
  }

  /** Nhập ô 국가 + chọn bộ lọc (chưa áp dụng). Giá trị `vat`/`exportFlag` là value của option ('' = 전체). */
  async setCriteria(criteria: { keyword?: string; vat?: '' | 'TAXABLE_STANDARD' | 'ZERO_RATED'; exportFlag?: '' | 'true' | 'false' }): Promise<void> {
    await test.step('Set the search criteria', async () => {
      if (criteria.keyword !== undefined) await this.searchInput.fill(criteria.keyword);
      if (criteria.vat !== undefined) await this.vatSelect.selectOption(criteria.vat);
      if (criteria.exportFlag !== undefined) await this.exportSelect.selectOption(criteria.exportFlag);
    });
  }

  async search(): Promise<Response> {
    return this.untilListed(() => this.click(this.searchButton, '검색 (Search) button'));
  }

  async reset(): Promise<Response> {
    return this.untilListed(() => this.click(this.resetButton, '초기화 (Reset) button'));
  }

  /** Dòng của quốc gia `code` (ô 국가 bắt đầu bằng mã). */
  row(code: string): Locator {
    return this.rows.filter({ has: this.page.locator('td:first-child > span:first-child', { hasText: new RegExp(`^${code}$`) }) });
  }

  /** Dòng tên quốc gia (dưới mã) trong ô 국가; tooltip đầy đủ nằm ở thuộc tính `title` của ô. */
  countryName(row: Locator): Locator {
    return this.cell(row, 'country').locator('span:nth-child(2)');
  }

  cell(row: Locator, column: 'country' | 'vat' | 'export' | 'updated' | 'action'): Locator {
    const index = { country: 1, vat: 2, export: 3, updated: 4, action: 5 }[column];
    return row.locator(`td:nth-child(${index})`);
  }

  async controlNames(): Promise<string[]> {
    return visibleControlNames(this.page);
  }

  /** Nhãn các option của một picker trên màn (theo đúng thứ tự). */
  async optionTexts(select: Locator): Promise<string[]> {
    return (await select.locator('option').allTextContents()).map((t) => t.trim());
  }

  /** Mã quốc gia của mọi dòng trên trang hiện tại. */
  async codes(): Promise<string[]> {
    return this.rows.locator('td:first-child > span:first-child').allTextContents();
  }

  pageButton(label: string | RegExp): Locator {
    return this.pagination.getByRole('button', { name: label });
  }

  async goToPage(label: string | RegExp): Promise<void> {
    await this.untilListed(() => this.click(this.pageButton(label), `Pagination "${label}" button`));
  }

  /** Đổi 페이지당; đã đúng giá trị thì bỏ qua (chọn lại cùng option không gửi request → chờ response sẽ timeout). */
  async setPageSize(size: '10' | '20' | '50' | '100'): Promise<void> {
    if ((await this.pageSizeSelect.inputValue()) === size) return;
    await this.untilListed(() => this.pageSizeSelect.selectOption(size).then(() => undefined));
  }

  async openHistory(row: Locator): Promise<void> {
    await this.click(row.getByRole('button', { name: /변경 이력|Change history/ }), '변경 이력 (Change history) button');
    await this.historyDialog.waitLoaded();
  }

  /** Mở màn sửa bằng click dòng (account có quyền ghi) — bấm ô Last updated, vị trí không phải link. */
  async openRow(code: string): Promise<void> {
    await this.click(this.cell(this.row(code), 'updated'), `${code} row (Last updated cell)`);
    await expect(this.page.locator('#txt_ro_code'), `The edit screen of ${code} opens`).toHaveText(code);
  }
}

/** Dialog 변경 이력 (Change history). */
export class TerritoryHistoryDialog {
  readonly root: Locator;
  /** Khung dialog thật (`.modal-content`) — `root` là lớp `.modal` phủ toàn màn. */
  readonly content: Locator;
  /** Khung cuộn riêng bao quanh bảng lịch sử. */
  readonly tableScroller: Locator;
  readonly title: Locator;
  readonly subtitle: Locator;
  readonly table: Locator;
  readonly headers: Locator;
  readonly rows: Locator;
  readonly empty: Locator;
  readonly closeButton: Locator;

  constructor(private readonly page: Page) {
    this.root = page.getByRole('dialog').filter({ has: page.locator('#tbl_history') });
    this.content = this.root.locator('.modal-content');
    this.tableScroller = page.locator('#tbl_history').locator('xpath=..');
    this.title = this.root.locator('.modal-title');
    this.subtitle = this.root.locator('#txt_hist_sub');
    this.table = this.root.locator('#tbl_history');
    this.headers = this.table.locator('thead th');
    this.rows = this.table.locator('tbody tr');
    this.empty = this.root.locator('#msg_history_empty');
    this.closeButton = this.root.locator('#btn_close_history');
  }

  async waitLoaded(): Promise<void> {
    await expect(this.root, 'The change history dialog opens').toBeVisible();
    await expect(this.root.getByText(/불러오는 중|Loading/), 'The change history finishes loading').toHaveCount(0);
  }

  async close(): Promise<void> {
    await this.closeButton.click();
    await expect(this.root, 'The change history dialog closes').toHaveCount(0);
  }

  /** Đóng bằng phím Esc — trả về dialog đã đóng hay chưa (TC kiểm cả trường hợp không đóng). */
  async closeByEscape(): Promise<boolean> {
    await this.page.keyboard.press('Escape');
    return this.root.waitFor({ state: 'detached', timeout: 5_000 }).then(() => true, () => false);
  }

  /** Bấm lên lớp phủ mờ bên ngoài khung dialog (góc trên trái của `.modal`). */
  async closeByOverlay(): Promise<boolean> {
    await this.root.click({ position: { x: 5, y: 5 } });
    return this.root.waitFor({ state: 'detached', timeout: 5_000 }).then(() => true, () => false);
  }

  cell(row: Locator, column: 'when' | 'who' | 'setting' | 'change' | 'reason'): Locator {
    return row.locator('td').nth({ when: 0, who: 1, setting: 2, change: 3, reason: 4 }[column]);
  }

  /** Các dòng xếp chồng trong ô Setting / Change (mỗi trường đổi = 1 dòng `span`). */
  lines(cell: Locator): Locator {
    return cell.locator(':scope > span');
  }

  /** Trong 1 dòng của ô Change: giá trị cũ (gạch ngang) và giá trị mới (in đậm). */
  oldValue(line: Locator): Locator {
    return line.locator('span');
  }

  newValue(line: Locator): Locator {
    return line.locator('b');
  }

  /** Nội dung các bản ghi đang hiển thị (trên xuống dưới) — dòng rỗng (colspan) bị bỏ qua. */
  async records(): Promise<Array<{ when: string; who: string; setting: string; change: string; reason: string }>> {
    return this.rows.evaluateAll((trs) =>
      trs
        .filter((tr) => tr.querySelectorAll('td').length >= 5)
        .map((tr) => {
          const td = Array.from(tr.querySelectorAll('td')).map((c) => (c as HTMLElement).innerText.replace(/ /g, ' ').trim());
          return { when: td[0], who: td[1], setting: td[2], change: td[3], reason: td[4] };
        }),
    );
  }

  /** Control nhập liệu / thao tác bên trong bảng lịch sử (bảng append-only phải không có). */
  editableControls(): Locator {
    return this.table.locator('input, textarea, select, button, a, [contenteditable="true"], [role="menu"]');
  }
}

/** Dialog xác nhận `이 변경을 적용할까요? / Apply this change?` (id verify DOM 29/09). Modal `backdrop: static`. */
export class TerritoryConfirmDialog {
  readonly root: Locator;
  readonly content: Locator;
  readonly title: Locator;
  readonly subtitle: Locator;
  readonly diffRows: Locator;
  readonly deviation: Locator;
  readonly conflict: Locator;
  readonly saveError: Locator;
  readonly backButton: Locator;
  readonly confirmButton: Locator;
  readonly cornerClose: Locator;

  constructor(private readonly page: Page) {
    this.root = page.getByRole('dialog').filter({ has: page.locator('#btn_confirm_save') });
    this.content = this.root.locator('.modal-content');
    this.title = this.root.locator('.modal-title');
    this.subtitle = this.root.locator('#txt_confirm_sub');
    this.diffRows = this.root.locator('#txt_change_diff > div');
    this.deviation = this.root.locator('#msg_deviation');
    this.conflict = this.root.locator('#msg_conflict');
    this.saveError = this.root.locator('#msg_save_error');
    this.backButton = this.root.locator('#btn_back_confirm');
    this.confirmButton = this.root.locator('#btn_confirm_save');
    this.cornerClose = this.root.locator('.btn-close');
  }

  /** 1 dòng diff: nhãn trường, giá trị cũ (gạch ngang), giá trị mới (in đậm). */
  diffKey(row: Locator): Locator {
    return row.locator('span').first();
  }

  diffOld(row: Locator): Locator {
    return row.locator('span').nth(1);
  }

  diffNew(row: Locator): Locator {
    return row.locator('b');
  }

  async back(): Promise<void> {
    await this.backButton.click();
    await expect(this.root, 'The confirmation dialog closes').toHaveCount(0);
  }

  /** Esc / bấm lớp phủ — trả về dialog đã đóng hay chưa (TC kiểm cả trường hợp không đóng). */
  async closeByEscape(): Promise<boolean> {
    await this.page.keyboard.press('Escape');
    return this.root.waitFor({ state: 'detached', timeout: 5_000 }).then(() => true, () => false);
  }

  async closeByOverlay(): Promise<boolean> {
    await this.root.click({ position: { x: 5, y: 5 } });
    return this.root.waitFor({ state: 'detached', timeout: 5_000 }).then(() => true, () => false);
  }
}

/** Màn Edit territory — `/commerce/territories/{code}/edit`. */
export class TerritoryEditPage extends BasePage {
  readonly title = this.page.getByRole('heading', { level: 4 });
  readonly breadcrumb = this.page.getByRole('navigation', { name: 'breadcrumb' });
  readonly cardHeader = this.page.locator('.card-header').filter({ has: this.page.locator('#btn_history_detail') });
  readonly historyButton = this.page.locator('#btn_history_detail');
  readonly identityBox = this.page.locator('#txt_country_readonly');
  readonly code = this.page.locator('#txt_ro_code');
  readonly nameEn = this.page.locator('#txt_ro_name');
  readonly nameKo = this.page.locator('#txt_ro_name_ko');
  readonly vatSelect = this.page.locator('#sel_vat_edit');
  readonly vatOptions = this.vatSelect.locator('option');
  readonly vatHint = this.vatSelect.locator('xpath=following-sibling::span[1]');
  readonly exportCheckbox = this.page.locator('#chk_export_required');
  /** Nhãn bên phải checkbox (câu "export declaration number is required" + giải thích) — khác nhãn cột `.form-label`. */
  readonly exportText = this.page.locator('label[for="chk_export_required"]:not(.form-label)');
  readonly lastUpdated = this.page.locator('#txt_last_updated');
  /** Ô chứa nhãn "Last updated / 최종 수정" + dòng giá trị. */
  readonly lastUpdatedField = this.lastUpdated.locator('xpath=..');
  readonly reasonField = this.page.locator('#fld_reason');
  readonly reasonInput = this.page.locator('#inp_reason');
  readonly reasonLabel = this.page.locator('label[for="inp_reason"]');
  readonly scopeNote = this.page.locator('#txt_scope_hint');
  readonly backButton = this.page.locator('#btn_back_list');
  readonly saveButton = this.page.locator('#btn_save_edit');
  readonly footer = this.page.locator('#frm_foot');
  readonly historyDialog = new TerritoryHistoryDialog(this.page);
  readonly confirmDialog = new TerritoryConfirmDialog(this.page);
  /** Link "Territories" trên breadcrumb — control quay lại duy nhất ở dải header (không có nút back cạnh tiêu đề, DOM 29/09). */
  readonly headerBackLink = this.breadcrumb.getByRole('link', { name: 'Territories' });

  constructor(page: Page) {
    super(page);
  }

  savedToast(lang: 'ko' | 'en' = 'ko'): Locator {
    return this.page.getByText(lang === 'ko' ? '변경 사항이 저장되었습니다.' : 'Changes saved. Applies to the open cycle onward.', { exact: true });
  }

  /** Bấm 저장 → dialog xác nhận mở (chưa ghi gì). */
  async openConfirm(): Promise<void> {
    await this.click(this.saveButton, '저장 (Save) button');
    await expect(this.confirmDialog.confirmButton, 'The confirmation dialog opens').toBeVisible();
  }

  /** Bấm 확인 후 저장 và chờ lượt PATCH /api/v1/territories/{code} trả về. */
  async confirmSave(): Promise<Response> {
    const saved = this.page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/api\/v1\/territories\/[A-Z]{2}$/.test(r.url()));
    await this.click(this.confirmDialog.confirmButton, '확인 후 저장 (Confirm and save) button');
    return saved;
  }

  /** Luồng lưu đầy đủ trên màn đang mở: đổi cờ (nếu truyền), nhập lý do, 저장 → 확인 후 저장. Trả response PATCH. */
  async saveChange(change: { vat?: 'TAXABLE_STANDARD' | 'ZERO_RATED'; exportRequired?: boolean; reason: string }): Promise<Response> {
    return test.step(`Save the change with the reason "${change.reason.slice(0, 40)}"`, async () => {
      if (change.vat) await this.vatSelect.selectOption(change.vat);
      if (change.exportRequired !== undefined) await this.exportCheckbox.setChecked(change.exportRequired);
      await this.reasonInput.fill(change.reason);
      await this.openConfirm();
      return this.confirmSave();
    });
  }

  /** Mở màn sửa thẳng bằng URL (account chỉ đọc không mở được bằng click dòng) và chờ form tải xong. */
  async open(code: string, lang?: 'en'): Promise<void> {
    await this.goto(`/commerce/territories/${code}/edit${lang ? '?lang=en' : ''}`);
    await expect(this.code, `The edit screen of ${code} has loaded`).toHaveText(code);
  }

  async controlNames(): Promise<string[]> {
    return visibleControlNames(this.page);
  }

  /** Dòng thông báo inline dưới ô lý do (rỗng / quá ngắn). */
  reasonMessage(text: string | RegExp): Locator {
    return this.reasonField.getByText(text);
  }
}
