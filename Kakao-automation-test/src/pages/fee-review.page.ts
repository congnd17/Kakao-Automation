import { Download, Locator, Page, Response, expect, test } from '@playwright/test';
import { BasePage } from './base.page';
import { FR_EN, FR_KO } from '@utils/fee-review.i18n';

/**
 * Màn 정산 수수료 확인·수정 (US079) — `/commerce/settlement-fee-review?cycleId=&bucket=&page=` (+ `lang=en`).
 * Màn KHÔNG gắn id cho phần tử nào (verify DOM qua Playwright MCP 29/09) → locator theo role / nhãn / chữ UI (nguồn chữ:
 * `@utils/fee-review.i18n`, trích từ bundle). Mỗi locator dùng regex "KO|EN" để chạy được ở cả 2 ngôn ngữ.
 * Dialog là modal react-bootstrap: `getByRole('dialog')` lọc theo tiêu đề.
 */
const either = (key: keyof typeof FR_KO): RegExp => new RegExp(`^\\s*(${esc(FR_KO[key])}|${esc(FR_EN[key])})\\s*$`);
function esc(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Cột của bảng chính (0 = checkbox). */
export const LIST_COL = { productId: 1, productName: 2, category: 3, rate: 4, status: 5, compare: 6, actions: 7 } as const;

export class FeeReviewListPage extends BasePage {
  /** Tiêu đề thẻ nội dung (card title) — dev 29/09 hiển thị đúng 정산 수수료 확인·수정. */
  readonly pageTitle = this.page.getByText(either('page.cardTitle')).first();
  /** Tiêu đề trang (h4) ở dải header — dev 29/09 hiển thị tên route "Settlement-fee-review". */
  readonly pageHeading = this.page.getByRole('heading', { level: 4 });
  readonly breadcrumb = this.page.getByRole('navigation', { name: 'breadcrumb' });
  /** Nhóm menu 정산 관리 và mục 정산 수수료 확인·수정 — dev 29/09: nhóm chỉ có "정산 데이터 다운로드". */
  readonly menuGroup = this.page.getByRole('link', { name: /^정산 관리|^Settlement management/ }).first();
  readonly menuItem = this.page.locator('aside').getByRole('link', { name: either('nav.feeReview') });
  readonly cycleLabel = this.page.getByText(either('filter.cycle'));
  readonly cycleSelect = this.cycleLabel.locator('xpath=..').locator('select');
  readonly keywordLabel = this.page.getByText(either('filter.keyword'));
  readonly keywordInput = this.page.getByPlaceholder(either('filter.keywordPlaceholder'));
  /** Dropdown "검색 조건" (상품명 / 상품ID / 수수료 카테고리 / 계약) theo TC — dev 29/09 KHÔNG có (chỉ có ô 검색어). */
  /**
   * Dropdown 검색 조건 (상품명 / 상품ID / 수수료 카테고리 / 계약) — chỉ khớp select có option 상품ID. Dev 01/10 KHÔNG có dropdown này;
   * locator cũ (select bất kỳ trong khung tổ tiên ô 검색어) khớp nhầm select cycle / số dòng → selectOption timeout (run 02/10).
   */
  readonly searchConditionSelect = this.page.locator('select').filter({ has: this.page.locator('option', { hasText: /^\s*(상품ID|Product ID)\s*$/ }) });
  readonly resetButton = this.page.getByRole('button', { name: /^(초기화|Reset)$/ });
  readonly searchButton = this.page.getByRole('button', { name: /^(검색|Search)$/ });
  readonly provisionalBanner = this.page.getByRole('alert').filter({ hasText: new RegExp(`${esc(FR_KO['bnr.provisionalTitle'])}|${esc(FR_EN['bnr.provisionalTitle'])}`) });
  readonly coverageBanner = this.page.getByRole('alert').filter({ hasText: new RegExp(`${esc(FR_KO['bnr.coverageTitle'])}|${esc(FR_EN['bnr.coverageTitle'])}`) });
  readonly partitionCaption = this.page.getByText(either('strip.partition'));
  readonly sliceCaption = this.page.getByText(either('strip.slice'));
  readonly partitionGroup = this.partitionCaption.locator('xpath=..');
  readonly sliceGroup = this.sliceCaption.locator('xpath=..');
  readonly submitButton = this.page.getByRole('button', { name: either('btn.submitSelected') });
  /** Vỏ bọc nút 선택 일괄 상신 mang tooltip (thuộc tính title) lý do disabled. */
  readonly submitWrapper = this.submitButton.locator('xpath=..');
  readonly resolvedAtLabel = this.page.getByText(/^(산정 시각 .+ — 열 때마다 새로 산정됩니다|Resolved at .+ — recomputed on every open|마감된 기간 — 요율이 확정·스탬프되었습니다|Closed period — rates are fixed and stamped)$/);
  readonly table = this.page.getByRole('table').first();
  readonly headers = this.table.getByRole('columnheader');
  readonly rows = this.table.locator('tbody tr');
  readonly headerCheckbox = this.page.getByRole('checkbox', { name: either('a11y.selectAllOnPage') });
  readonly counter = this.page.getByText(/^총 \d+개의 (상품|products) 중 \d+-\d+개 표시$/);
  readonly pageSizeSelect = this.page.locator('select').filter({ hasText: '100개' }).first();
  readonly pagination = this.page.locator('ul.pagination');
  readonly reportButton = this.page.getByRole('button', { name: either('btn.report') });
  readonly exportButton = this.page.getByRole('button', { name: either('btn.exportList') });
  readonly loading = this.page.getByText(/^(불러오는 중\.\.\.|Loading\.\.\.)$/);
  readonly emptyTitle = this.page.getByText(either('empty.title'));
  readonly emptySubtitle = this.page.getByText(either('empty.subtitle'));
  readonly emptyCta = this.page.getByRole('button', { name: either('empty.cta') });
  readonly noSettlementData = this.page.getByText(either('errCode.noSettlementData'));

  readonly basis = new BasisDialog(this.page);
  readonly correct = new CorrectDialog(this.page);
  readonly history = new HistoryDialog(this.page);
  readonly report = new ReportDialog(this.page);
  readonly exporter = new ExportDialog(this.page);
  readonly withdraw = new WithdrawDialog(this.page);

  constructor(page: Page) {
    super(page);
  }

  /** Mở màn (mặc định: cycle mặc định của app). `cycleId` / `bucket` đi qua query như app tự ghi URL. */
  async open(options: { cycleId?: number; bucket?: 'ALL' | 'EXC' | 'NC' | 'PROV' | 'FIXED' | 'OK' | 'NF' | 'AMB' | 'DIFF' | 'SRCDIFF'; lang?: 'en'; pageSize?: '10' | '20' | '50' | '100' } = {}): Promise<void> {
    const params = new URLSearchParams();
    if (options.cycleId) params.set('cycleId', String(options.cycleId));
    if (options.cycleId) params.set('page', '0');
    if (options.bucket) params.set('bucket', options.bucket);
    if (options.lang) params.set('lang', options.lang);
    const query = params.toString();
    await this.untilListed(() => this.goto(`/commerce/settlement-fee-review${query ? `?${query}` : ''}`));
    // Mặc định 100 dòng/trang để mọi fixture nằm trên 1 trang (trang 10 dòng đẩy P14 sang trang 2 — lần chạy 29/09).
    if ((options.pageSize ?? '100') !== '10' && (await this.pageSizeSelect.count())) await this.setPageSize(options.pageSize ?? '100');
  }

  /** Chạy `action` và chờ lượt GET products của nó + bảng vẽ xong. */
  async untilListed(action: () => Promise<void>): Promise<Response> {
    const listed = this.page.waitForResponse((r) => r.request().method() === 'GET' && /\/api\/v1\/fee-review\/cycles\/\d+\/products\?/.test(r.url()), { timeout: 30_000 });
    await action();
    const response = await listed;
    await expect(this.loading, 'The fee review list finishes loading').toHaveCount(0, { timeout: 20_000 });
    return response;
  }

  chip(key: 'bucket.ALL' | 'bucket.EXC' | 'bucket.NC' | 'bucket.PROV' | 'bucket.FIXED' | 'bucket.OK' | 'bucket.NF' | 'bucket.AMB' | 'bucket.DIFF' | 'bucket.SRCDIFF'): Locator {
    return this.page.getByRole('button', { name: new RegExp(`^(\\d+|—) (${esc(FR_KO[key])}|${esc(FR_EN[key])})$`) });
  }

  /** Số trên chip (span đầu tiên của nút). */
  async chipCount(chip: Locator): Promise<number> {
    return Number(((await chip.locator('span').first().textContent()) ?? '').trim());
  }

  /** Bấm chip; chip đang được chọn thì bỏ qua (bấm lại không gửi request — lần chạy 29/09). */
  async clickChip(chip: Locator): Promise<void> {
    if ((await chip.getAttribute('aria-pressed')) === 'true') return;
    await this.untilListed(() => this.click(chip, 'Summary chip'));
  }

  /** Đổi cycle. Cycle chưa có dữ liệu tính phí có thể không gọi lại GET products (lần chạy 29/09) → chờ tối đa 10s rồi chỉ chờ hết loading. */
  async selectCycle(label: string): Promise<void> {
    const listed = this.page.waitForResponse((r) => r.request().method() === 'GET' && /\/api\/v1\/fee-review\/cycles\/\d+\/products\?/.test(r.url()), { timeout: 10_000 }).catch(() => null);
    await this.cycleSelect.selectOption({ label });
    await listed;
    await expect(this.loading, 'The fee review list finishes loading').toHaveCount(0, { timeout: 20_000 });
  }

  async search(keyword: string): Promise<void> {
    await this.keywordInput.fill(keyword);
    await this.searchOrReload();
  }

  /**
   * Bấm 검색 và chờ GET products. Run 02/10: bấm 검색 với ĐÚNG bộ lọc đang áp dụng thì app không gửi lại request (23 TC
   * timeout 30s) → chờ tối đa 10s; không có request thì tải lại trang (dữ liệu mới nhất) và ghi annotation vào report.
   * Bước nào TC yêu cầu assert "query chạy lại" thì dùng `untilListed()` (chờ chặt) thay cho hàm này.
   */
  async searchOrReload(): Promise<void> {
    const listed = this.page.waitForResponse((r) => r.request().method() === 'GET' && /\/api\/v1\/fee-review\/cycles\/\d+\/products\?/.test(r.url()), { timeout: 10_000 }).catch(() => null);
    await this.click(this.searchButton, '검색 (Search) button');
    if (!(await listed)) {
      test.info().annotations.push({ type: 'Observed', description: '검색 (Search) with the filter already applied sent no request — the page was reloaded to read fresh data' });
      await this.untilListed(async () => {
        await this.page.reload();
      });
    }
    await expect(this.loading, 'The fee review list finishes loading').toHaveCount(0, { timeout: 20_000 });
  }

  async reset(): Promise<void> {
    await this.untilListed(() => this.click(this.resetButton, '초기화 (Reset) button'));
  }

  /** Dòng của sản phẩm; `index` chọn dòng thứ n khi sản phẩm có 2 chính sách (P01). */
  row(productId: string, index = 0): Locator {
    return this.rows.filter({ has: this.page.getByRole('cell', { name: productId, exact: true }) }).nth(index);
  }

  cell(row: Locator, column: keyof typeof LIST_COL): Locator {
    return row.locator('td').nth(LIST_COL[column]);
  }

  rowButton(row: Locator, key: 'btn.basis' | 'btn.correct' | 'btn.withdraw' | 'btn.history'): Locator {
    return row.getByRole('button', { name: either(key) });
  }

  rowCheckbox(row: Locator): Locator {
    return row.getByRole('checkbox');
  }

  /** Mã sản phẩm của mọi dòng trên trang hiện tại. */
  async productIds(): Promise<string[]> {
    return (await this.rows.locator(`td:nth-child(${LIST_COL.productId + 1})`).allTextContents()).map((t) => t.trim()).filter(Boolean);
  }

  async openBasis(row: Locator): Promise<void> {
    await this.click(this.rowButton(row, 'btn.basis'), '근거 (Basis) button');
    await this.basis.waitLoaded();
  }

  async openCorrect(row: Locator): Promise<void> {
    await this.click(this.rowButton(row, 'btn.correct'), '수정 (Correct) button');
    await this.correct.waitLoaded();
  }

  async openHistory(row: Locator): Promise<void> {
    await this.click(this.rowButton(row, 'btn.history'), '이력 (History) button');
    await this.history.waitLoaded();
  }

  async openWithdraw(row: Locator): Promise<void> {
    await this.click(this.rowButton(row, 'btn.withdraw'), '회수 (Withdraw) button');
    await expect(this.withdraw.root, 'The withdraw confirmation opens').toBeVisible();
  }

  async openReport(): Promise<void> {
    await this.click(this.reportButton, '이번 기 수정 내역 (Changes this period) button');
    await this.report.waitLoaded();
  }

  async openExport(): Promise<void> {
    await this.click(this.exportButton, '목록 내보내기 (Export list) button');
    await expect(this.exporter.root, 'The export dialog opens').toBeVisible();
  }

  /** Đổi 페이지당; đã đúng giá trị thì bỏ qua (chọn lại cùng option không gửi request). */
  async setPageSize(size: '10' | '20' | '50' | '100'): Promise<void> {
    if (((await this.pageSizeSelect.locator('option:checked').textContent()) ?? '').trim() === `${size}개`) return;
    await this.untilListed(() => this.pageSizeSelect.selectOption({ label: `${size}개` }).then(() => undefined));
  }

  async goToPage(label: string | RegExp): Promise<void> {
    await this.untilListed(() => this.click(this.pagination.getByRole('button', { name: label }), `Pagination "${label}"`));
  }

  /** Bấm 선택 일괄 상신 và chờ POST submit trả về. */
  async submitSelected(): Promise<Response> {
    const submitted = this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/fee-review\/corrections\/submit$/.test(r.url()));
    await this.click(this.submitButton, '선택 일괄 상신 (Submit selected) button');
    return submitted;
  }

  toast(text: string | RegExp): Locator {
    return this.page.getByText(text).last();
  }

  /** Tooltip react-bootstrap đang mở (hover ô bị cắt / pill trạng thái). */
  get tooltip(): Locator {
    return this.page.getByRole('tooltip');
  }

  /** Vỏ bọc nút 수정 mang lý do disabled (thuộc tính title) — verify DOM 29/09. */
  correctWrapper(row: Locator): Locator {
    return this.rowButton(row, 'btn.correct').locator('xpath=..');
  }

  /** Dòng thứ 2 (giá trị đề xuất mờ "→ …") của ô category / rate khi correction chưa có hiệu lực. */
  secondLine(cell: Locator): Locator {
    return cell.locator('div.small');
  }

  /** Các pill trong ô 산정 상태: [trạng thái산정, trạng thái correction?]. */
  statusPills(row: Locator): Locator {
    return this.cell(row, 'status').locator('.badge');
  }

  async bodyText(): Promise<string> {
    return this.page.locator('body').innerText();
  }
}

/** Dialog 요율 산정 근거 (Why this rate). */
export class BasisDialog {
  readonly root: Locator;
  readonly title: Locator;
  readonly productLine: Locator;
  readonly evidenceToggle: Locator;
  readonly closeButton: Locator;

  constructor(page: Page) {
    this.root = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: either('trace.title') }) });
    this.title = this.root.getByRole('heading', { level: 5 });
    this.productLine = this.root.getByRole('paragraph').first();
    this.evidenceToggle = this.root.getByRole('button', { name: new RegExp(`${esc(FR_KO['trace.evidence'])}|${esc(FR_EN['trace.evidence'])}`) });
    this.closeButton = this.root.locator('.modal-footer').getByRole('button', { name: either('btn.close') });
  }

  async waitLoaded(): Promise<void> {
    await expect(this.root, 'The Why this rate dialog opens').toBeVisible();
    await expect(this.root.getByText(/불러오는 중|Loading/), 'The rate basis finishes loading').toHaveCount(0);
  }

  /** Khối nội dung đứng ngay dưới nhãn (VD 도출된 키, 검토된 수수료 행, 우선순위 적용 단계, 현재 지정된 행). */
  section(key: 'trace.keyTitle' | 'trace.candTitle' | 'trace.ladderTitle' | 'trace.assignedTitle' | 'trace.noRowTitle' | 'trace.bracketTitle' | 'trace.overrideTitle'): Locator {
    return this.root.getByText(either(key)).locator('xpath=..');
  }

  /** Giá trị của cặp nhãn → giá trị trong 1 khối (VD 수수료 카테고리 → 음반). */
  value(scope: Locator, label: string | RegExp): Locator {
    return scope.getByText(label, { exact: typeof label === 'string' }).locator('xpath=following-sibling::*[1]');
  }

  /** Số liệu lớn ở đầu dialog (rate đang hiệu lực, hoặc "—") — verify DOM 01/10: `span.fw-bold` đầu tiên của thân dialog. */
  get headlineRate(): Locator {
    return this.root.locator('.modal-body span.fw-bold').first();
  }

  /** Từng dòng ứng viên trong 검토된 수수료 행: badge 적용/미적용 + "계약 … · NORMAL · 9.00% · 적용 시작일 …" (verify 01/10). */
  get candidateRows(): Locator {
    return this.section('trace.candTitle').locator('div.small.py-1');
  }

  /** Từng bậc trong 우선순위 적용 단계: số thứ tự + tên bậc + dòng mô tả (VD "여기서 결정됨") — verify 01/10. */
  get ladderSteps(): Locator {
    return this.section('trace.ladderTitle').locator('div.d-flex.gap-2.small');
  }

  async expandEvidence(): Promise<void> {
    if ((await this.evidenceToggle.getAttribute('aria-expanded')) !== 'true') await this.evidenceToggle.click();
    await expect(this.section('trace.keyTitle'), 'The reasoning panels are shown').toBeVisible();
  }

  async close(): Promise<void> {
    await this.closeButton.click();
    await expect(this.root, 'The Why this rate dialog closes').toHaveCount(0);
  }
}

/** Dialog 수수료 산정 수정 (Correct fee resolution). */
export class CorrectDialog {
  readonly root: Locator;
  readonly title: Locator;
  readonly productLine: Locator;
  readonly fromContract: Locator;
  readonly tier1Label: Locator;
  readonly tier1Select: Locator;
  readonly deltaHead: Locator;
  readonly deltaPanel: Locator;
  readonly tier2Label: Locator;
  readonly tier2Input: Locator;
  readonly tier2Lock: Locator;
  readonly rateError: Locator;
  readonly reasonLabel: Locator;
  readonly reasonInput: Locator;
  readonly counter: Locator;
  readonly discardButton: Locator;
  readonly cancelButton: Locator;
  readonly saveButton: Locator;
  readonly cornerClose: Locator;

  constructor(private readonly page: Page) {
    this.root = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: either('fix.title') }) });
    this.title = this.root.getByRole('heading', { level: 5 });
    this.productLine = this.root.getByRole('paragraph').first();
    this.fromContract = this.root.getByText(either('fix.fromContractTitle')).locator('xpath=..');
    this.tier1Label = this.root.getByText(either('fix.tier1Label'));
    this.tier1Select = this.tier1Label.locator('xpath=..').locator('select');
    this.deltaHead = this.root.getByText(
      new RegExp(`^(${['fix.deltaZeroHead', 'fix.deltaChgHead', 'fix.deltaT2Head', 'fix.deltaNoneHead'].flatMap((k) => [esc(FR_KO[k as keyof typeof FR_KO]), esc(FR_EN[k as keyof typeof FR_EN])]).join('|')})$`),
    );
    this.deltaPanel = this.deltaHead.locator('xpath=..');
    this.tier2Label = this.root.getByText(either('fix.tier2Label'));
    this.tier2Input = this.tier2Label.locator('xpath=..').locator('input');
    this.tier2Lock = this.root.getByText(either('fix.tier2Lock'));
    this.rateError = this.root.getByText(either('fix.rateInvalid'));
    this.reasonLabel = this.root.getByText(/^(수정 사유 \(필수\)|Reason \(required\)|수수료 산정 근거 \(필수\)|Basis for this rate \(required\))$/);
    this.reasonInput = this.root.getByRole('textbox', { name: /^(왜 수정하는지 입력하세요|Why is this being corrected\?|이 요율을 어떻게 정했는지 입력하세요|How was this rate arrived at\?)$/ });
    this.counter = this.root.getByText(/^\d+ \/ 200$/);
    this.discardButton = this.root.getByRole('button', { name: either('fix.discard') });
    this.cancelButton = this.root.getByRole('button', { name: /^(취소|Cancel)$/ });
    this.saveButton = this.root.getByRole('button', { name: either('fix.save') });
    this.cornerClose = this.root.getByRole('button', { name: 'Close' });
  }

  async waitLoaded(): Promise<void> {
    await expect(this.root, 'The Correct fee resolution dialog opens').toBeVisible();
    await expect(this.root.getByText(/불러오는 중|Loading/), 'The correction options finish loading').toHaveCount(0);
  }

  /** Giá trị của nhãn trong khối 계약에서 산정된 값. */
  contractValue(key: 'fix.kvCategory' | 'fix.kvRate' | 'fix.kvStatus'): Locator {
    return this.fromContract.getByText(either(key)).locator('xpath=following-sibling::*[1]');
  }

  async optionTexts(): Promise<string[]> {
    return (await this.tier1Select.locator('option').allTextContents()).map((t) => t.trim());
  }

  /** Chọn category theo tên (option "{tên} (…)"). */
  async pickCategory(name: string): Promise<void> {
    const label = (await this.optionTexts()).find((t) => t === name || t.startsWith(`${name} (`));
    if (!label) throw new Error(`Category "${name}" is not offered in the Tier 1 dropdown`);
    await this.tier1Select.selectOption({ label });
  }

  /** Bấm 저장 và chờ POST corrections trả về (response lỗi cũng được trả để TC kiểm). */
  async save(): Promise<Response> {
    const saved = this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/fee-review\/cycles\/\d+\/products\/[^/]+\/corrections$/.test(r.url()));
    await test.step('Click 저장 (Save) in the Correct dialog', () => this.saveButton.click());
    return saved;
  }

  async cancel(): Promise<void> {
    await this.cancelButton.click();
    await expect(this.root, 'The Correct dialog closes').toHaveCount(0);
  }

  message(text: string | RegExp): Locator {
    return this.root.getByText(text);
  }
}

/** Dialog 변경 이력 (Change history). */
export class HistoryDialog {
  readonly root: Locator;
  readonly title: Locator;
  readonly productLine: Locator;
  readonly headers: Locator;
  readonly rows: Locator;
  readonly footer: Locator;
  readonly empty: Locator;
  readonly closeButton: Locator;

  constructor(page: Page) {
    this.root = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: either('hist.title') }) });
    this.title = this.root.getByRole('heading', { level: 5 });
    this.productLine = this.root.getByText(/^(상품|Product): /);
    this.headers = this.root.locator('thead th');
    this.rows = this.root.locator('tbody tr');
    this.footer = this.root.getByText(either('hist.footer'));
    this.empty = this.root.getByText(either('hist.empty'));
    this.closeButton = this.root.locator('.modal-footer').getByRole('button', { name: either('btn.close') });
  }

  async waitLoaded(): Promise<void> {
    await expect(this.root, 'The change history dialog opens').toBeVisible();
    await expect(this.root.getByText(/불러오는 중|Loading/), 'The change history finishes loading').toHaveCount(0);
  }

  cell(row: Locator, column: 'when' | 'who' | 'setting' | 'change' | 'reason'): Locator {
    return row.locator('td').nth({ when: 0, who: 1, setting: 2, change: 3, reason: 4 }[column]);
  }

  async close(): Promise<void> {
    await this.closeButton.click();
    await expect(this.root, 'The change history dialog closes').toHaveCount(0);
  }
}

/** Dialog 이번 기 수정 내역 (Changes this period). */
export class ReportDialog {
  readonly root: Locator;
  readonly title: Locator;
  readonly intro: Locator;
  readonly headers: Locator;
  readonly rows: Locator;
  readonly counter: Locator;
  readonly pageSizeSelect: Locator;
  readonly tableScroller: Locator;
  readonly exportButton: Locator;
  readonly closeButton: Locator;

  constructor(page: Page) {
    this.root = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: either('report.title') }) });
    this.title = this.root.getByRole('heading', { level: 5 });
    this.intro = this.root.getByText(either('report.intro'));
    this.headers = this.root.locator('th');
    this.rows = this.root.locator('tbody tr');
    this.counter = this.root.getByText(/^총 \d+개의 (건|corrections) 중 \d+-\d+개 표시$/);
    this.pageSizeSelect = this.root.locator('select');
    this.tableScroller = this.root.locator('.table-responsive');
    this.exportButton = this.root.locator('.modal-footer').getByRole('button', { name: either('report.export') });
    this.closeButton = this.root.locator('.modal-footer').getByRole('button', { name: either('btn.close') });
  }

  async waitLoaded(): Promise<void> {
    await expect(this.root, 'The Changes this period dialog opens').toBeVisible();
    await expect(this.root.getByText(/불러오는 중|Loading/), 'The period report finishes loading').toHaveCount(0);
  }

  /**
   * Báo cáo xếp cũ nhất trước, mặc định 10 dòng/trang (dev 01/10: 199 bản ghi) → correction test vừa tạo nằm ở trang cuối.
   * Đặt 100 dòng/trang rồi sang trang Last (nếu có) để `rows` chứa các bản ghi mới nhất.
   */
  async showLatest(): Promise<void> {
    await this.pageSizeSelect.selectOption({ label: '100개' });
    await this.waitLoaded();
    const last = this.root.getByRole('button', { name: 'Last' });
    if ((await last.count()) > 0 && (await last.isEnabled())) {
      await last.click();
      await this.waitLoaded();
    }
  }

  cell(row: Locator, column: 'productId' | 'change' | 'rate' | 'tier' | 'approval' | 'who' | 'when' | 'reason'): Locator {
    return row.locator('td').nth({ productId: 0, change: 1, rate: 2, tier: 3, approval: 4, who: 5, when: 6, reason: 7 }[column]);
  }

  async close(): Promise<void> {
    await this.closeButton.click();
    await expect(this.root, 'The Changes this period dialog closes').toHaveCount(0);
  }
}

/** Dialog 내보내기 (Export) — mở từ 목록 내보내기 hoặc từ nút 내보내기 của báo cáo kỳ. */
export class ExportDialog {
  readonly root: Locator;
  readonly title: Locator;
  readonly scope: Locator;
  readonly radios: Locator;
  readonly fileName: Locator;
  readonly cancelButton: Locator;
  readonly downloadButton: Locator;

  constructor(private readonly page: Page) {
    this.root = page.getByRole('dialog').filter({ has: page.getByText(either('export.scopeTitle')) });
    this.title = this.root.getByRole('heading', { level: 5 });
    this.scope = this.root.getByText(either('export.scopeTitle')).locator('xpath=..');
    this.radios = this.root.locator('input[type="radio"]');
    this.fileName = this.root.getByText(/\.(xlsx|csv)$/);
    this.cancelButton = this.root.locator('.modal-footer').getByRole('button', { name: /^(취소|Cancel)$/ });
    this.downloadButton = this.root.locator('.modal-footer').getByRole('button', { name: /^(내려받기|Download|내려받는 중|Downloading)$/ });
  }

  /** Câu phạm vi của chế độ báo cáo kỳ ("이번 기의 모든 수정 내역 — …") — verify 01/10: chỉ có 정산 주기 + 행 수, không có 필터. */
  get scopeReportNote(): Locator {
    return this.scope.getByText(either('export.scopeReport'));
  }

  scopeValue(key: 'export.period' | 'export.filter' | 'export.rows'): Locator {
    return this.scope.getByText(either(key)).locator('xpath=following-sibling::*[1]');
  }

  async chooseFormat(format: 'xlsx' | 'csv'): Promise<void> {
    await this.root.getByText(format === 'xlsx' ? 'Excel (.xlsx)' : 'CSV (.csv)', { exact: true }).click();
  }

  /** Bấm 내려받기 và chờ file tải về. */
  async download(): Promise<Download> {
    const downloaded = this.page.waitForEvent('download', { timeout: 30_000 });
    await test.step('Click 내려받기 (Download) in the Export dialog', () => this.downloadButton.click());
    return downloaded;
  }
}

/**
 * Dialog 승인 요청 회수 (Withdraw approval request) — verify DOM thật 30/09: tiêu đề là `div.modal-title` (KHÔNG phải heading
 * — locator heading cũ không bao giờ khớp); thân `.modal-body > div` = dòng sản phẩm `<p>` + câu thông báo.
 */
export class WithdrawDialog {
  readonly root: Locator;
  readonly title: Locator;
  readonly body: Locator;
  readonly productLine: Locator;
  readonly reasonField: Locator;
  readonly cancelButton: Locator;
  readonly confirmButton: Locator;

  constructor(private readonly page: Page) {
    this.root = page.getByRole('dialog').filter({ has: page.locator('.modal-title', { hasText: new RegExp(`^(${esc(FR_KO['withdraw.title'])}|${esc(FR_EN['withdraw.title'])})$`) }) });
    this.title = this.root.locator('.modal-title');
    // Câu thông báo nằm chung khối với dòng sản phẩm → assert bằng toContainText.
    this.body = this.root.locator('.modal-body > div').first();
    this.productLine = this.body.locator('p').first();
    this.reasonField = this.root.locator('textarea, input[type="text"]');
    this.cancelButton = this.root.getByRole('button', { name: /^(취소|Cancel)$/ });
    this.confirmButton = this.root.locator('.modal-footer').getByRole('button', { name: either('withdraw.confirm') });
  }

  async confirm(): Promise<Response> {
    const done = this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/fee-review\/corrections\/[^/]+\/withdraw$/.test(r.url()));
    await test.step('Confirm 회수 (Withdraw)', () => this.confirmButton.click());
    return done;
  }
}
