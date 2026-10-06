import { Locator, Page, Response, expect } from '@playwright/test';
import { FeeReviewListPage } from '@pages/fee-review.page';
import { FR_EN, FR_KO } from '@utils/fee-review.i18n';

/**
 * Bổ sung cho `FeeReviewListPage` / `BasisDialog` dùng riêng nhóm TC [Fee Resolution] + [Why This Rate] (TC_US079_57–83).
 * Locator lấy từ recon `.playwright-mcp/v1-recon/02..06-basis-*.yml` (01/10):
 * - khối trả lời (answer block) = cha của câu giải thích (trace.why*) — chứa rate, nhãn nguồn (계약 행 / 수정본 적용) và cặp 계약 / 정책 / 적용 시작일;
 * - khối 현재 지정된 행 = ông của tiêu đề (tiêu đề + cờ 일치/불일치/지정 없음 nằm chung 1 div, cặp giá trị + câu ghi chú là anh em của div đó);
 * - dòng ứng viên "적용|미적용 계약 <id> [부속계약] · NORMAL · 9.00% · 적용 시작일 …".
 * Locator đánh dấu UNVERIFIED: phần tử TC/prototype mô tả nhưng build dev 01/10 KHÔNG có (slot 기본/프로모션, badge 직접 입력 trong panel…).
 */
const esc = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const either = (key: keyof typeof FR_KO): RegExp => new RegExp(`^\\s*(${esc(FR_KO[key])}|${esc(FR_EN[key])})\\s*$`);
/** Mẫu i18n có tham số {x} → regex khớp mọi giá trị tham số. */
const template = (text: string): string => esc(text).replace(/\\\{\w+\\\}/g, '.+');

/**
 * Chuỗi TC v1 (`input/TESTCASE_US079_v1.md`, SRS v1.8 / prototype v1.3) KHÔNG có trong bundle dev 01/10 — spec assert theo TC,
 * các assertion dùng chuỗi này dự kiến FAIL cho tới khi build cập nhật. Tách khỏi FR_KO (chuỗi thật của app).
 */
export const RES_TC = {
  /** TC_US079_79 E3 — missingKeyPart = NO_BINDING. */
  noBindingKo: '이 상품은 어떤 계약에도 연결되어 있지 않아 적용할 수수료 행이 없습니다. 수정이 아니라 계약 등록이 필요합니다.',
  /** TC_US079_79 E5 — missingKeyPart = NO_ROW_FOR_KEY. */
  noRowForKeyKo: '계약에 이 상품의 수수료 카테고리·판매유형에 해당하는 수수료 행이 없습니다. 「수정」에서 계약이 요율을 매기는 카테고리를 선택하거나, 계약 수정을 요청해 주세요.',
  /** TC_US079_79 E6 — missingKeyPart = NOT_VALID_ON_DATE. */
  notValidOnDateKo: '이 키에 해당하는 수수료 행은 있지만, 주문일에 유효한 행이 없습니다. 계약 담당자에게 행의 적용 기간 확인을 요청해 주세요.',
  /** TC_US079_80 E3 — khối tie riêng (BR-8.V6). */
  tieTitleKo: '동순위 수수료 행 중복',
  tieBodyKo: '이 상품에 같은 순위의 수수료 행이 둘 이상 있어 시스템이 하나를 고르지 않습니다. 계약 담당자에게 중복 정리를 요청해 주세요.',
  /** TC_US079_69 / 70 / 77 — nhãn slot của khối 현재 지정된 행 theo prototype v1.3. */
  slotDefault: '기본 수수료',
  slotPromotion: '프로모션 수수료',
  slotCompared: '대조 대상',
  slotFeeId: '수수료ID',
  slotRowStatus: '행 상태',
} as const;

export class ResolutionPage {
  /** Badge 적용 / 미적용 ở đầu dòng ứng viên ("미적용" bắt đầu bằng 미 → `^적용` không khớp nhầm dòng 미적용). */
  static readonly APPLIED = new RegExp(`^\\s*(${esc(FR_KO['trace.candWin'])}|${esc(FR_EN['trace.candWin'])})`);
  static readonly NOT_APPLIED = new RegExp(`^\\s*(${esc(FR_KO['trace.candOut'])}|${esc(FR_EN['trace.candOut'])})`);

  constructor(
    private readonly page: Page,
    readonly list: FeeReviewListPage,
  ) {}

  /** Câu giải thích dưới rate (계약 행 / 수정본 / 직접 입력 / chưa giải được) — verify 01/10 (whyContract, whyUnresolved). */
  get answerSentence(): Locator {
    const keys = ['trace.whyContract', 'trace.whyUnresolved', 'trace.whyTyped', 'trace.whyCorrected'] as const;
    return this.list.basis.root.getByText(new RegExp(`^(${keys.flatMap((k) => [template(FR_KO[k]), template(FR_EN[k])]).join('|')})$`));
  }

  /** Khối trả lời đầu dialog: rate + nhãn nguồn + câu giải thích + cặp 계약 / 정책 / 적용 시작일. */
  get answerBlock(): Locator {
    return this.answerSentence.locator('xpath=..');
  }

  /** Nhãn nguồn cạnh rate: 계약 행 (from a contract row) / 수정본 적용 (from a correction). */
  sourceLabel(key: 'trace.fromContract' | 'trace.fromCorrection'): Locator {
    return this.answerBlock.getByText(either(key));
  }

  /** Giá trị cặp nhãn trong khối trả lời (계약 / 정책 / 적용 시작일). */
  answerValue(key: 'trace.kvContract' | 'trace.kvPolicy' | 'trace.kvEffective'): Locator {
    return this.list.basis.value(this.answerBlock, FR_KO[key]);
  }

  /** Badge 직접 입력 (Hand-keyed) trong khối trả lời — UNVERIFIED (recon không có rate nhập tay đã duyệt). */
  get answerHandKeyedBadge(): Locator {
    return this.answerBlock.getByText(either('lbl.handKeyed'));
  }

  /** Khối 현재 지정된 행 (Currently assigned): tiêu đề + cờ, cặp giá trị, câu ghi chú. */
  get assignedBlock(): Locator {
    return this.list.basis.root.getByText(either('trace.assignedTitle')).locator('xpath=../..');
  }

  /** Cờ 일치 / 불일치 / 지정 없음 cạnh tiêu đề 현재 지정된 행. */
  get assignedFlag(): Locator {
    return this.list.basis.root.getByText(either('trace.assignedTitle')).locator('xpath=following-sibling::*[1]');
  }

  /** Giá trị 지정된 행 (Assigned row) / 수수료 카테고리 trong khối 현재 지정된 행. */
  assignedValue(key: 'trace.kvAssignedRow' | 'trace.kvCategory'): Locator {
    return this.list.basis.value(this.assignedBlock, FR_KO[key]);
  }

  /** Slot 기본 수수료 / 프로모션 수수료 theo prototype — UNVERIFIED (build dev 01/10 không vẽ slot). */
  slot(name: typeof RES_TC.slotDefault | typeof RES_TC.slotPromotion): Locator {
    return this.assignedBlock.getByText(name, { exact: true }).locator('xpath=..');
  }

  /** Giá trị trong 1 slot (수수료ID / 행 상태) — UNVERIFIED. */
  slotValue(slot: Locator, label: typeof RES_TC.slotFeeId | typeof RES_TC.slotRowStatus): Locator {
    return slot.getByText(label, { exact: true }).locator('xpath=following-sibling::*[1]');
  }

  /** Khối cảnh báo tie riêng theo TC (동순위 수수료 행 중복) — UNVERIFIED (build xếp tie vào 적용 가능한 행 없음). */
  get tieBlock(): Locator {
    return this.list.basis.root.getByText(RES_TC.tieTitleKo, { exact: true }).locator('xpath=..');
  }

  /** Dòng "키를 사람이 고쳤습니다" (The key was set by a person) trong 도출된 키. */
  get keySetByPerson(): Locator {
    return this.list.basis.root.getByText(new RegExp(`${esc(FR_KO['trace.keySetByPerson'])}|${esc(FR_EN['trace.keySetByPerson'])}`));
  }

  /** Dòng ứng viên theo contract + rate (rate dạng "9.00"). */
  candidate(contractId: number, rate: string): Locator {
    return this.list.basis.candidateRows.filter({ hasText: `${contractId}` }).filter({ hasText: ` ${rate}%` });
  }

  /** Bậc mang nhãn 여기서 결정됨 (Decided here). */
  get decidingStep(): Locator {
    return this.list.basis.ladderSteps.filter({ hasText: new RegExp(`${esc(FR_KO['trace.decidedHere'])}|${esc(FR_EN['trace.decidedHere'])}`) });
  }

  /** 3 panel lập luận dưới 어떻게 결정됐는지 보기. */
  reasoning(): Array<{ name: string; locator: Locator }> {
    return [
      { name: '도출된 키 (Derived key)', locator: this.list.basis.section('trace.keyTitle') },
      { name: '검토된 수수료 행 (Rows considered)', locator: this.list.basis.section('trace.candTitle') },
      { name: '우선순위 적용 단계 (Precedence applied)', locator: this.list.basis.section('trace.ladderTitle') },
    ];
  }

  /**
   * TC: "Select 검색 조건 = 상품ID, type … and click 검색". Dropdown 검색 조건 chỉ có trên prototype — dev 29/09 chỉ có ô 검색어
   * → có dropdown thì chọn 상품ID, không có thì chỉ gõ từ khoá (UI có điều kiện, Deviation ghi ở description).
   */
  async searchByProductId(productId: string): Promise<Response> {
    if ((await this.list.searchConditionSelect.count()) > 0) await this.list.searchConditionSelect.selectOption({ label: '상품ID' });
    await this.list.keywordInput.fill(productId);
    return this.list.untilListed(() => this.list.click(this.list.searchButton, '검색 (Search) button'));
  }

  /** Mở cycle qua URL rồi bấm chip (mặc định 기간 내 판매 상품). */
  async openCycle(cycleId: number, chip: Parameters<FeeReviewListPage['chip']>[0] = 'bucket.ALL'): Promise<void> {
    await this.list.open({ cycleId });
    await this.list.clickChip(this.list.chip(chip));
  }

  /** Tải lại trang và chờ lượt GET products mới. */
  async reload(): Promise<Response> {
    return this.list.untilListed(() => this.page.reload().then(() => undefined));
  }

  /**
   * Mở 근거 và trả về thời gian (ms) tới khi nội dung hiện + thời gian request trace kết thúc. `withReasoning` = chờ thêm
   * panel 도출된 키 (sản phẩm tie / không có dòng mở sẵn phần lập luận).
   */
  async timedBasis(row: Locator, withReasoning = false): Promise<{ renderMs: number; traceMs: number }> {
    const traced = this.page.waitForResponse((r) => r.request().method() === 'GET' && /\/fee-review\/cycles\/\d+\/products\/[^/]+\/trace\?/.test(r.url()));
    const started = Date.now();
    await this.list.rowButton(row, 'btn.basis').click();
    await expect(this.list.basis.headlineRate, 'The headline of Why this rate is rendered').toBeVisible();
    await this.list.basis.waitLoaded();
    if (withReasoning) await expect(this.list.basis.section('trace.keyTitle'), 'The auto-expanded reasoning is rendered').toBeVisible();
    const renderMs = Date.now() - started;
    const response = await traced;
    // responseEnd tính từ lúc request bắt đầu (startTime); -1 khi trình duyệt không cung cấp timing → dùng thời gian render.
    const { responseEnd } = response.request().timing();
    return { renderMs, traceMs: responseEnd >= 0 ? responseEnd : renderMs };
  }
}
