import { ContractCommissionBody, ContractCreateBody, CommissionPolicy, CommissionType, FeeRateApi, SubmitChangeBody, SubmitChangeResult } from '@api/fee-rate.api';

/**
 * Dữ liệu test US078 (Fee rate + effective dating). Môi trường dev DÙNG CHUNG — quyết định 28/09:
 * - Mỗi test tự tạo contract riêng tên `[AUTO-US078] <TC> <timestamp>` qua API. Contract KHÔNG xoá được (API chỉ có
 *   GET/PATCH) → nằm lại vĩnh viễn trên dev; mọi thay đổi phí chỉ đụng contract của automation.
 * - Account: `approver` (dungbd.fpt) là ADMIN + người duyệt mặc định. Từ 30/09 TC maker ≠ checker gửi bằng `submitter`
 *   (anhdtv2.fpt) qua fixture `submitterContracts`, dungbd.fpt duyệt / từ chối.
 * - Teardown rút lại (회수) mọi đơn còn 승인 대기 trên contract đã tạo — hàng đợi 변경 승인 không bị rác.
 */

/** Dữ liệu tham chiếu (master data, chỉ đọc) — id lấy từ GET /contracts/values + contract mẫu trên dev, verify 28/09. */
export const CONTRACT_REF = {
  bizPartnerId: 1771579487807,
  artists: [{ id: 1, name: '[T079] artist' }],
  labelTypeId: 437015115163968,
  businessModelTypeId: 437015116187968,
  ipDomain: 'k-pop',
  approvalUrl: 'https://approval.example.com/auto-us078',
} as const;

/** Khoá TC → category thật trên dev (nhãn UI tiếng Hàn). TC dùng tên tiếng Anh; dev không có "Fan Club + Kit" riêng → 팬클럽 키트. */
export const CATEGORY = {
  MD: { id: 437015117957440, label: 'MD' },
  ALBUM: { id: 437015117441344, label: '음반' },
  FANCLUB: { id: 437015118088512, label: '팬클럽' },
  FANCLUB_KIT: { id: 437015117556032, label: '팬클럽 키트' },
  MD_CONSIGNMENT: { id: 437015117719872, label: 'MD - 입점사 제작' },
  MD_PURCHASE: { id: 437015118211392, label: 'MD - 입점사 매입' },
} as const;

/** "Self-sales" của TC = 전체 위탁 (bundle map SELF → 전체위탁); "Consignment" = 부분 위탁. */
export const SALE_TYPE = {
  SELF: { id: 437015118367040, label: '전체 위탁' },
  CONSIGNMENT: { id: 437015118620992, label: '부분 위탁' },
  PURCHASE: { id: 437015118498112, label: '사입' },
} as const;

export const POLICY_LABEL: Record<CommissionPolicy, string> = { NORMAL: '일반', PROMOTION: '프로모션' };

export type CategoryKey = keyof typeof CATEGORY;
export type SaleTypeKey = keyof typeof SALE_TYPE;

/** Khoá 1 fee row = (category, sale type, policy) — đúng cách màn hình gọi tên dòng "MD · 전체 위탁 · 일반". */
export interface FeeKey {
  category: CategoryKey;
  saleType: SaleTypeKey;
  policy?: CommissionPolicy;
}

export const keyLabel = (key: FeeKey): string => `${CATEGORY[key.category].label} · ${SALE_TYPE[key.saleType].label} · ${POLICY_LABEL[key.policy ?? 'NORMAL']}`;

export const KEY = {
  MD: { category: 'MD', saleType: 'SELF' },
  ALBUM: { category: 'ALBUM', saleType: 'SELF' },
  FANCLUB: { category: 'FANCLUB', saleType: 'CONSIGNMENT' },
  FIXED: { category: 'FANCLUB_KIT', saleType: 'SELF' },
  GUARANTEE: { category: 'MD_PURCHASE', saleType: 'PURCHASE' },
  MD_CONSIGNMENT: { category: 'MD', saleType: 'CONSIGNMENT' },
  MD_PROMO: { category: 'MD', saleType: 'CONSIGNMENT', policy: 'PROMOTION' },
} as const satisfies Record<string, FeeKey>;

/** Chuỗi UI tiếng Hàn — nguồn: dictionary `feeRateChange.*` / `contracts.*` của bundle + DOM thật (28/09). */
export const FEE_TEXT = {
  tab: '수수료 정보',
  columns: ['번호', '카테고리', '판매유형', '정책', '유형', '기준금액 · VAT (수수료 / PG)', 'VAT 포함 (수수료 / PG)', 'PG 수수료(%)', '수수료', '적용 시작일', '프로모션 기간', '승인 상태', '상태', '작업'],
  columnsEn: ['No', 'Category', 'Sales type', 'Policy', 'Type', 'Fee base · VAT (fee / PG)', 'VAT incl. (fee / PG)', 'PG Fee (%)', 'Fee', 'Effective from', 'Promotion period', 'Approval', 'Status', 'Action'],
  approval: { DRAFT: '작성 중', PENDING: '승인 대기', APPLIED: '적용됨', SUPERSEDED: '대체됨' },
  approvalAllowed: ['작성 중', '승인 대기', '적용됨', '대체됨', '반려됨'],
  statusActive: '활성',
  statusInactive: '비활성',
  btnChangeRate: '요율 수정',
  btnChangeAmount: '금액 수정',
  btnHistory: '변경 이력',
  btnWithdraw: '회수',
  btnDiscardDraft: '초안 삭제',
  markReturned: '반려됨',
  btnDeactivate: '비활성',
  btnAdd: '추가',
  markWithdrawn: '회수됨',
  complexNote: '요율은 정산 규칙에서 설정됩니다',
  until: (date: string) => `${date}까지`,
  contractEnd: '(계약 종료)',
  pendingExists: '이 행에는 이미 승인 대기 중인 기안이 있습니다.',
  backdatedOnHeldKey: '이 항목에는 이미 수수료 행이 있어 적용 시작일을 앞당길 수 없습니다. 정정으로 제출해 주세요.',
  periodShortened: (n: number) => `계약 기간을 줄이면 수수료 행 ${n}건이 적용 대상 주문을 잃게 됩니다. 해당 행을 먼저 조정해 주세요.`,
  submittedForApproval: '승인 요청되었습니다. 승인 전까지 수수료 행은 변경되지 않습니다.',
  appliedNoGate: '계약 기간이 아직 시작되지 않아 승인 없이 바로 적용되었습니다. 변경 이력은 그대로 남습니다.',
  withdrawnDone: '회수되었습니다. 수수료 행은 변경되지 않았습니다.',
  addSubmitted: '새 수수료 행은 승인 대기로 제출되었습니다.',
  deactivateSubmitted: '비활성 기안이 제출되었습니다. 승인 전까지 행은 그대로 적용됩니다.',
  reactivatedAsNewRow: '비활성 행을 바탕으로 새 행이 추가되었습니다. 적용 시작일을 입력한 뒤 저장해 주세요. 비활성 행은 이력으로 남습니다.',
  dialog: {
    titleRate: '수수료 요율 수정',
    titleAmount: '수수료 금액 수정',
    rowLabel: '수수료 행',
    currentRate: '현재 요율',
    currentAmount: '현재 금액',
    currentEf: '현재 적용 시작일',
    question: '이 수정은 어느 쪽입니까?',
    correctionHead: '정정 — 처음부터 잘못 등록된 요율',
    changeHead: '변경 — 특정 일자부터 요율이 실제로 바뀜',
    newPercent: '새 요율 (%)',
    newAmount: '새 금액 (원)',
    ratePlaceholder: '예: 8.5',
    amountPlaceholder: '예: 4400',
    effectiveFrom: '적용 시작일',
    datePlaceholder: 'YYYY-MM-DD',
    reason: '사유 (필수)',
    reasonPlaceholder: '예: 2026-09-10 체결된 부속계약서로 요율이 9 %로 인상됨',
    hintCorrect: (ef: string) => `비워 두면 기존 적용 시작일(${ef})을 유지합니다. 날짜 자체가 잘못 입력된 경우에만 여기서 정정해 주세요.`,
    hintChange: '이 날짜부터의 주문에만 새 요율이 적용됩니다.',
    impact: '영향 범위',
    notComputable: '산출 불가',
    impactPick: '구분을 먼저 선택해 주세요.',
    impactChangeDetail: (ef: string) => `${ef} 이전 주문은 기존 요율을 유지하고, 그 이후 주문부터 새 요율이 적용됩니다. 기존 행은 마감되고 새 행이 추가됩니다.`,
    reasonRequired: '사유는 필수이며 200자 이내로 입력해 주세요.',
    rateRange: '0에서 100 사이의 요율을 입력해 주세요.',
    gateTitle: '이 계약은 아직 승인이 필요하지 않습니다',
    submit: '승인 요청',
    apply: '적용',
    cancel: '취소',
  },
  check: {
    backdatedTitle: '적용 시작일이 과거입니다',
    backdated: '요율 변경은 과거 날짜로 시작할 수 없습니다. 처음부터 잘못 등록된 요율이라면 정정으로 제출해 주세요.',
    tooEarly: (date: string) => `더 늦은 적용 시작일이 필요합니다. 이 항목의 최신 행은 ${date}부터 적용됩니다.`,
    reorderBoth: (prev: string, next: string) => `정정한 적용 시작일은 ${prev} 이후, ${next} 이전이어야 합니다.`,
    beforeStart: (date: string) => `이 수수료 행은 어떤 주문에도 적용되지 않습니다. 계약 기간과 프로모션 기간 안의 적용 시작일을 입력해 주세요 — 계약 시작일은 ${date}입니다.`,
    noCoveragePromo: (date: string) => `이 수수료 행은 어떤 주문에도 적용되지 않습니다. 계약 기간과 프로모션 기간 안의 적용 시작일을 입력해 주세요 — 프로모션 기간 종료일은 ${date}입니다.`,
    gapByRow: (from: string, to: string, row: string, rate: string) => `${from}부터 ${to}까지의 주문은 이 행이 아니라 ${row}(${rate})로 계산됩니다. 계속할까요?`,
    gapNone: (from: string, to: string) => `${from}부터 ${to}까지의 주문은 적용할 수수료 행이 없어 정산에서 보류됩니다. 계속할까요?`,
  },
  history: {
    title: '수수료율 변경 이력',
    columns: ['시점', '수행자', '항목', '변경 내용', '사유'],
    columnsEn: ['When', 'Who', 'Setting', 'Change', 'Reason'],
    fieldRate: '수수료율',
    footer: '승인된 기안만 수수료 행을 변경합니다. 반려·회수된 기안은 이력에 남지만 값은 바뀌지 않았습니다.',
    emptyTitle: '아직 변경 이력이 없습니다',
    emptySub: '이 수수료 행은 등록된 뒤 변경된 적이 없습니다.',
    pending: '승인 대기',
  },
  withdraw: {
    title: '승인 요청 회수',
    labels: ['요청 번호', '수수료 행', '변경 유형', '직전 승인값', '요청값', '기안자', '사유'],
    notice: '회수해도 수수료 행은 변경되지 않습니다. 회수는 반려와 다른 사건으로 이력에 남으며, 사유는 필요하지 않습니다. 회수 후 다시 기안할 수 있습니다.',
  },
  reasonDialog: {
    deactivateTitle: '수수료 행 비활성화',
    deactivateBody: (row: string) => `${row} 행의 비활성화를 요청합니다. 승인되기 전까지는 계속 주문에 적용됩니다.`,
    addTitle: '운영 중인 계약에 수수료 행 추가',
  },
  trail: {
    title: '수수료율 수정 이력',
    columns: ['시점', '구분', '수수료 행', '수수료 (전 → 후)', '적용 시작일', '영향 주문 라인', '정산 차액', '수행자', '사유'],
    empty: '수수료율 수정 이력이 없습니다.',
  },
  queue: {
    register: 'Fee Rate',
    registerOptions: ['전체', '환율 원장', '쿠폰 분담 관리', 'Fee Rate', 'Fee Rule', '결제수단 정책'],
  },
} as const;

/**
 * "Not computable" của impact: dialog ghi badge "산출 불가", hàng đợi 변경 승인 ghi "아직 산출할 수 없음" (verify 29/09) —
 * cùng nghĩa, khác chữ.
 */
export const QUEUE_NOT_COMPUTABLE = /산출 불가|산출할 수 없음|not computable|not_computable/i;

/** Hôm nay theo giờ Hàn (KST) — BR-22.V1: server tính "hôm nay" theo KST, không theo đồng hồ máy chạy test. */
export function kstToday(): string {
  return new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** Cộng/trừ ngày trên chuỗi YYYY-MM-DD — TC ghi ngày gửi thay đổi dạng "today + N days" (standing rule 3). */
export function addDays(ymd: string, days: number): string {
  const date = new Date(`${ymd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export const inDays = (days: number): string => addDays(kstToday(), days);
const kstStartIso = (ymd: string) => new Date(`${ymd}T00:00:00+09:00`).toISOString();
const kstEndIso = (ymd: string) => new Date(`${ymd}T23:59:59.999+09:00`).toISOString();

/** Tên traceable — nhìn vào list contract biết ngay TC nào tạo. */
export function contractName(tcId: string): string {
  return `[AUTO-US078] ${tcId.replace(/^TC_US078_/, 'TC_')} ${Date.now()}`;
}

export interface FeeRowSpec extends FeeKey {
  type?: CommissionType;
  commission?: number;
  promotion?: { from: string; to: string };
  status?: 'ACTIVE' | 'INACTIVE';
}

function toCommission(row: FeeRowSpec): ContractCommissionBody {
  return {
    categoryId: CATEGORY[row.category].id,
    saleTypeId: SALE_TYPE[row.saleType].id,
    commissionPolicy: row.policy ?? 'NORMAL',
    commissionType: row.type ?? 'PERCENT',
    commission: row.commission ?? 0,
    pgCommissionRate: 3,
    status: row.status ?? 'ACTIVE',
    vatIncluded: true,
    pgVatIncluded: true,
    pgOverrides: {},
    feeBase: 'PRODUCT_PRICE',
    feeBaseVatIncluded: true,
    pgFeeBase: 'PRODUCT_PRICE',
    pgFeeBaseVatIncluded: true,
    ...(row.promotion ? { startAt: kstStartIso(row.promotion.from), endAt: kstEndIso(row.promotion.to) } : {}),
  };
}

/** Body `POST /contracts/{id}/fee-rows` — cùng shape hàm dựng body thêm dòng của bundle (29/09). */
export function addRowBody(row: FeeRowSpec & { effectiveFrom: string }, reason: string, rateOrigin: 'FROM_CONTRACT' | 'KEYED_BY_HAND' = 'FROM_CONTRACT'): Record<string, unknown> {
  return {
    key: { categoryId: CATEGORY[row.category].id, saleTypeId: SALE_TYPE[row.saleType].id, policy: row.policy ?? 'NORMAL' },
    commissionType: row.type ?? 'PERCENT',
    commission: String(row.commission ?? 0),
    effectiveFrom: row.effectiveFrom,
    pgCommissionRate: '0',
    rateOrigin,
    changeReason: reason,
    vatIncluded: true,
    feeBase: 'PRODUCT_PRICE',
    feeBaseVatIncluded: true,
    ...(row.promotion ? { promotionFrom: row.promotion.from, promotionTo: row.promotion.to } : {}),
  };
}

/** Mục mới nhất của lịch sử fee row (id tăng dần theo thời gian tạo). */
export function latestChange<T extends { id: number }>(changes: T[]): T {
  return [...changes].sort((a, b) => b.id - a.id)[0];
}

/**
 * Loại contract theo trạng thái thời gian — quyết định cổng duyệt (BR-3.V1 / V2):
 * - RUNNING: đang chạy (2026-01-01 → ≥ 120 ngày sau hôm nay) → mọi thay đổi phí chờ duyệt.
 * - NOT_STARTED: bắt đầu từ ngày mai → thay đổi áp dụng ngay, không cần duyệt (dùng dựng dòng "đã đổi" khi không có
 *   người duyệt thứ hai).
 * - ENDED: 2020-01-01 → 2020-12-31 → áp dụng ngay (Component 84, TC_93/94).
 */
export type ContractTiming = 'RUNNING' | 'NOT_STARTED' | 'ENDED';

export function contractPeriod(timing: ContractTiming): { start: string; end: string } {
  if (timing === 'NOT_STARTED') return { start: inDays(1), end: inDays(270) };
  if (timing === 'ENDED') return { start: '2020-01-01', end: '2020-12-31' };
  const end = inDays(120) > '2026-12-31' ? inDays(120) : '2026-12-31';
  return { start: '2026-01-01', end };
}

/** Bộ fee row mặc định cho contract đang chạy — tương đương seed của TC (`MD 10 %`, `Album 8 %`, `Fan Club 7 %`). */
export const DEFAULT_ROWS: FeeRowSpec[] = [
  { ...KEY.MD, commission: 10 },
  { ...KEY.ALBUM, commission: 8 },
  { ...KEY.FANCLUB, commission: 7 },
];

export interface CreatedContract {
  id: number;
  code: string;
  name: string;
  start: string;
  end: string;
}

/**
 * Tạo contract automation qua API và theo dõi để teardown rút lại mọi đơn còn chờ (fixture `feeRateContracts`).
 */
export class FeeRateContracts {
  private readonly created: number[] = [];

  constructor(private readonly api: FeeRateApi) {}

  async create(
    tcId: string,
    timing: ContractTiming,
    rows: FeeRowSpec[] = DEFAULT_ROWS,
    overrides: Partial<ContractCreateBody> = {},
  ): Promise<CreatedContract> {
    const period = contractPeriod(timing);
    const name = contractName(tcId);
    const body: ContractCreateBody = {
      bizPartnerId: CONTRACT_REF.bizPartnerId,
      artists: [...CONTRACT_REF.artists],
      contractName: name,
      labelTypeId: CONTRACT_REF.labelTypeId,
      businessModelTypeId: CONTRACT_REF.businessModelTypeId,
      regionType: 'DOMESTIC',
      ipDomains: [CONTRACT_REF.ipDomain],
      contractStartAt: kstStartIso(period.start),
      contractEndAt: kstEndIso(period.end),
      internalApproveDocumentUrl: CONTRACT_REF.approvalUrl,
      commissions: rows.map(toCommission),
      ...overrides,
    };
    const created = await this.api.createContract(body);
    if (created.status !== 201) {
      throw new Error(`Test data setup failed — POST /contracts returned ${created.status}: ${JSON.stringify(created.body)}`);
    }
    this.created.push(created.body.id);
    const detail = (await this.api.getContract(created.body.id)).body;
    return { id: detail.id, code: detail.code, name, start: period.start, end: period.end };
  }

  /** id fee row theo khoá (và ngày bắt đầu nếu cùng khoá có nhiều dòng). */
  async rowId(contractId: number, key: FeeKey, effectiveFrom?: string): Promise<number> {
    const rows = await this.api.feeRows(contractId);
    const match = rows.find(
      (row) =>
        row.categoryId === CATEGORY[key.category].id &&
        row.saleTypeId === SALE_TYPE[key.saleType].id &&
        row.policy === (key.policy ?? 'NORMAL') &&
        (effectiveFrom === undefined || row.effectiveFrom === effectiveFrom),
    );
    if (!match) throw new Error(`Test data setup failed — no fee row ${keyLabel(key)} on contract ${contractId}`);
    return match.id;
  }

  /** Dựng tiền điều kiện "dòng có đơn 정정 / 변경" qua API — trên contract chưa bắt đầu đơn được áp dụng ngay (gated = false). */
  async submit(contractId: number, key: FeeKey, body: SubmitChangeBody, effectiveFrom?: string): Promise<SubmitChangeResult> {
    const rowId = await this.rowId(contractId, key, effectiveFrom);
    const result = await this.api.submitChange(contractId, rowId, body);
    if (result.status !== 201) {
      throw new Error(`Test data setup failed — POST …/fee-rows/${rowId}/changes returned ${result.status}: ${JSON.stringify(result.body)}`);
    }
    return result.body;
  }

  /** Dựng tiền điều kiện "dòng đã chuyển 비활성" qua API (trên contract đang chạy → đơn chờ duyệt). */
  async deactivate(contractId: number, key: FeeKey, reason: string, effectiveFrom?: string): Promise<SubmitChangeResult> {
    const rowId = await this.rowId(contractId, key, effectiveFrom);
    const result = await this.api.setStatus(contractId, rowId, 'INACTIVE', reason);
    if (result.status !== 200) {
      throw new Error(`Test data setup failed — PUT …/fee-rows/${rowId}/status returned ${result.status}: ${JSON.stringify(result.body)}`);
    }
    return result.body;
  }

  async withdraw(contractId: number, key: FeeKey, changeId: number): Promise<void> {
    const rowId = await this.rowId(contractId, key);
    const result = await this.api.withdrawChange(contractId, rowId, changeId);
    if (result.status >= 300) throw new Error(`Test data setup failed — withdraw returned ${result.status}: ${JSON.stringify(result.body)}`);
  }

  /**
   * Thêm 1 dòng qua endpoint thêm dòng (`POST …/fee-rows`) — body cùng shape màn hình gửi (bundle 29/09). Trên contract
   * chưa bắt đầu dòng được áp dụng ngay; trên contract đang chạy dòng chờ duyệt. Dùng dựng dòng `rateOrigin = KEYED_BY_HAND`.
   */
  async addRow(contractId: number, row: FeeRowSpec & { effectiveFrom: string }, reason: string, rateOrigin: 'FROM_CONTRACT' | 'KEYED_BY_HAND' = 'FROM_CONTRACT'): Promise<SubmitChangeResult> {
    const result = await this.api.addFeeRow(contractId, addRowBody(row, reason, rateOrigin));
    if (result.status >= 300) throw new Error(`Test data setup failed — POST …/fee-rows returned ${result.status}: ${JSON.stringify(result.body)}`);
    return result.body;
  }

  /** Rút lại mọi đơn còn 승인 대기 trên các contract đã tạo — contract không xoá được, nhưng hàng đợi duyệt phải sạch. */
  async dispose(): Promise<void> {
    for (const contractId of this.created) {
      for (const row of await this.api.feeRows(contractId)) {
        for (const change of await this.api.history(contractId, row.id)) {
          if (change.status === 'PENDING') await this.api.withdrawChange(contractId, row.id, change.id);
        }
      }
    }
  }
}

