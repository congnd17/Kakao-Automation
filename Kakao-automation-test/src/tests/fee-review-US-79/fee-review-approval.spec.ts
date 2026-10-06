import type { Locator } from '@playwright/test';
import type { RowDataPacket } from 'mysql2/promise';
import { test, expect } from '@fixtures/fee-review-v1.fixture';
import { makeStep } from '@utils/step';
import { skipTc, tcMeta } from '@utils/tc-meta';
import { getAccountDisplayName, hasCredentials } from '@utils/auth-token';
import { switchAccount } from '@utils/switch-account';
import { FR_KO, frFormat } from '@utils/fee-review.i18n';
import { family, product, reasonOf } from '@utils/fee-review-v1.data';
import { feeReviewDb } from '@utils/fee-review-db';
import type { CategoryKey, SaleTypeKey, Seeded } from '@utils/fee-review-seed';
import type { FeeReviewApi, SaveCorrectionBody } from '@api/fee-review.api';
import type { FeeRateApi } from '@api/fee-rate.api';
import type { ChangeApprovalQueuePage } from '@pages/change-approval-queue.page';
import type { FeeReviewListPage } from '@pages/fee-review.page';
import { FeeReviewRowExtras, FeeRuleApprovalPage } from '@pages/fee-review-v1/approval.page';
import { Observations } from '@utils/observations';

/**
 * US079 v1 — nhóm [Change Approval] (TC_US079_126–141) + [Retirement] (TC_US079_142–150). Nguồn: input/TESTCASE_US079_v1.md.
 * TOKEN_A = account `submitter` (maker, browser mặc định); TOKEN_B = account `approver` (phiên thứ 2 qua `secondSession`
 * hoặc đổi phiên bằng `switchAccount` khi chỉ user B thao tác UI). Dữ liệu dựng bằng `seedData` (API + SQL) và tự dọn.
 * Nhãn hàng đợi trên dev (recon 12): 변경 요약 → 원장 / 대상 레코드 / 변경 유형 / 기안자 / 제출 일시, 사유 (기안자), 변경 내용 →
 * 제안 값 / 기준값; TC gọi trường giá trị đang hiệu lực là 직전 승인 값 → assert theo TC, ghi Deviation.
 */
const TAGS = ['fee-review', 'fee-review-v1', 'change-approval'];
const TAGS_RET = ['fee-review', 'fee-review-v1', 'retirement'];
const REGISTER = 'FEE_RULE';
const DATA = 'Data: contracts, fee rows and cycles are created through the API per the TC pre-conditions and stay (no delete API); the TC products, corrections, Fee Rule approval records and history rows are deleted by SQL in teardown.';
const DEV_REASON = 'Deviation: every maker reason carries the traceable prefix "[AUTO-US079] <TC> <timestamp> — " before the TC text (the queue is shared, so the record is matched by its reason).';
const DEV_YEAR = 'Deviation: cycles are allocated in the next free month from 2100 on instead of the TC year Y = 2100 + 200 × RUN + N (the TC "<Y>-03" / "<Y>-06" / "<Y>-08" cycles are the seeded CY_MAIN / CY_CLOSE / CY_NEXT).';
const DEV_PREV = 'Deviation: the dev queue detail labels the value in force 기준값 (with "직전 활성 레코드 없음") — the TC label 직전 승인 값 is asserted and is expected to fail until the build matches.';
const APPROVER_MISSING = 'The approver account (TOKEN_B, APPROVER_*) is not configured in .env';
/** Nhãn hàng đợi theo TC (dev hiển thị 기준값 cho giá trị đang hiệu lực — recon 12). */
const Q_PREV = '직전 승인 값';
const Q_PROPOSED = '제안 값';
const SYSTEM_RE = /SYSTEM|시스템/i;
/** Ba bucket của impact summary theo TC. */
const BUCKETS = ['Not yet settled', 'Settled, period still open', 'Settled, period closed'];

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const startsWith = (text: string): RegExp => new RegExp(`^\\s*${esc(text)}`);
const day = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10));
const json = (v: unknown): Record<string, unknown> => (typeof v === 'string' && v ? (JSON.parse(v) as Record<string, unknown>) : {});
const num = (v: unknown): number => Number(v);

/** `<cycleId>/<productId>/<policy>` — target_ref của bản ghi Fee Rule. */
function targetRef(s: Seeded, code: string, cycle = 'CY_MAIN', policy = 'NORMAL'): string {
  return `${s.cycles[cycle].id}/${s.products[code]}/${policy}`;
}

/** SELECT chỉ đọc trên schema settlement (cột verify bằng SHOW COLUMNS 01/10). */
const db = {
  async correction(id: string | number): Promise<RowDataPacket> {
    return (await feeReviewDb.query<RowDataPacket[]>('SELECT * FROM fee_correction WHERE id = ?', [id]))[0];
  },
  async corrections(productId: string): Promise<RowDataPacket[]> {
    return feeReviewDb.query<RowDataPacket[]>('SELECT * FROM fee_correction WHERE product_id = ? ORDER BY id', [productId]);
  },
  async approval(id: number): Promise<RowDataPacket> {
    return (await feeReviewDb.query<RowDataPacket[]>('SELECT * FROM change_approval WHERE id = ?', [id]))[0];
  },
  async approvals(ref: string): Promise<RowDataPacket[]> {
    return feeReviewDb.query<RowDataPacket[]>("SELECT * FROM change_approval WHERE target_type = 'FEE_RULE' AND target_ref = ? ORDER BY id", [ref]);
  },
  async history(correctionId: string | number): Promise<RowDataPacket[]> {
    return feeReviewDb.query<RowDataPacket[]>('SELECT * FROM fee_correction_history WHERE correction_id = ? ORDER BY at DESC, id DESC', [correctionId]);
  },
  async auditMark(): Promise<number> {
    return num((await feeReviewDb.query<RowDataPacket[]>('SELECT COALESCE(MAX(id), 0) AS id FROM audit_log'))[0].id);
  },
  async audit(sinceId: number, entityIds: string[]): Promise<RowDataPacket[]> {
    if (!entityIds.length) return [];
    return feeReviewDb.query<RowDataPacket[]>("SELECT * FROM audit_log WHERE id > ? AND entity IN ('FeeCorrection', 'ChangeApproval') AND entity_id IN (?) ORDER BY ts, id", [sinceId, entityIds]);
  },
  async retireAudit(correctionId: string | number): Promise<RowDataPacket[]> {
    return feeReviewDb.query<RowDataPacket[]>("SELECT * FROM audit_log WHERE entity = 'FeeCorrection' AND action = 'fee_correction.retire' AND entity_id = ?", [String(correctionId)]);
  },
  async openCyclesAfter(date: string): Promise<RowDataPacket[]> {
    return feeReviewDb.query<RowDataPacket[]>("SELECT id, period_start, period_end, status FROM settlement_cycle WHERE status = 'OPEN' AND period_start > ?", [date]);
  },
  /** UPDATE fee_review_fixture_product (giả lập commerce đổi gán) — trả số dòng bị đổi (TC: "1 row updated"). */
  async setProduct(productId: string, fields: { categoryId?: number | null; defaultSlot?: number | null; promotionSlot?: number | null }): Promise<number> {
    const columns = { categoryId: 'category_id', defaultSlot: 'default_slot_fee_row_id', promotionSlot: 'promotion_slot_fee_row_id' } as const;
    const entries = Object.entries(fields) as Array<[keyof typeof columns, number | null]>;
    return feeReviewDb.execute(`UPDATE fee_review_fixture_product SET ${entries.map(([k]) => `${columns[k]} = ?`).join(', ')} WHERE product_id = ?`, [...entries.map(([, v]) => v), productId]);
  },
};

const tier1 = (s: Seeded, category: CategoryKey, reason: string): SaveCorrectionBody => ({ policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category[category], reason });
const tier2 = (rate: string, reason: string): SaveCorrectionBody => ({ policy: 'NORMAL', tier: 'RATE_OVERRIDE', overrideRate: rate, reason });

/** Lưu correction qua API (pre-condition "Save draft") — trả correctionId. */
async function saveCorrection(api: FeeReviewApi, s: Seeded, code: string, body: SaveCorrectionBody, cycle = 'CY_MAIN'): Promise<{ id: string; state?: string }> {
  const { status, body: saved } = await api.save(s.cycles[cycle].id, s.products[code], body);
  expect(status, `Pre-condition: the correction on ${code} is saved`).toBeLessThan(300);
  expect(saved.correctionId, `Pre-condition: the save of ${code} returns a correctionId`).toBeTruthy();
  return { id: String(saved.correctionId), state: saved.state };
}

async function submitIds(api: FeeReviewApi, ids: string[]): Promise<void> {
  expect((await api.submit(ids)).status, 'Pre-condition: the corrections are submitted (HTTP 200)').toBe(200);
}

/** Bản ghi Fee Rule mới nhất của target_ref (DB — hàng đợi dùng chung có hàng trăm bản ghi). */
async function approvalIdOf(ref: string): Promise<number> {
  const rows = await db.approvals(ref);
  expect(rows.length, `A Fee Rule approval record exists for ${ref}`).toBeGreaterThan(0);
  return num(rows[rows.length - 1].id);
}

async function approveApi(api: FeeReviewApi, id: number): Promise<void> {
  expect((await api.approve(id)).status, `Pre-condition: record #${id} is approved by TOKEN_B (HTTP 200)`).toBe(200);
}

/** Lưu + gửi duyệt 1 correction → { correctionId, approvalId }. */
async function pendingCorrection(api: FeeReviewApi, s: Seeded, code: string, body: SaveCorrectionBody, cycle = 'CY_MAIN'): Promise<{ id: string; approvalId: number }> {
  const { id } = await saveCorrection(api, s, code, body, cycle);
  await submitIds(api, [id]);
  return { id, approvalId: await approvalIdOf(targetRef(s, code, cycle)) };
}

/** Thêm fee row vào contract (body nguyên văn TC) — response `{ newRowId, changeApprovalId }`. */
async function addRow(contracts: FeeRateApi, s: Seeded, contract: string, key: { category: CategoryKey; saleType: SaleTypeKey }, commission: number, effectiveFrom: string, changeReason: string) {
  return contracts.addFeeRow<{ newRowId?: number; id?: number; changeApprovalId?: number | null }>(s.family.contracts[contract], {
    key: { categoryId: s.master.category[key.category], saleTypeId: s.master.saleType[key.saleType], policy: 'NORMAL' },
    commissionType: 'PERCENT',
    commission,
    effectiveFrom,
    pgCommissionRate: 3,
    feeBase: 'PRODUCT_PRICE',
    pgFeeBase: 'PRODUCT_PRICE',
    changeReason,
  });
}

/** Mở màn với cycle, chip 기간 내 판매 상품 và từ khoá (mặc định = mã sản phẩm). */
async function openRow(list: FeeReviewListPage, cycleId: number, keyword: string, options: { bucket?: 'ALL' | 'SRCDIFF'; pageSize?: '20' | '100' } = {}): Promise<void> {
  await list.open({ cycleId, bucket: options.bucket ?? 'ALL', pageSize: options.pageSize });
  await list.search(keyword);
}

/** Sửa qua UI: 수정 → chọn category Tier 1 → nhập lý do → 저장. Trả correctionId từ response. */
async function correctInUi(list: FeeReviewListPage, productId: string, category: string, reason: string): Promise<string> {
  await list.openCorrect(list.row(productId));
  await list.correct.pickCategory(category);
  await list.correct.reasonInput.fill(reason);
  const response = await list.correct.save();
  const body = (await response.json().catch(() => ({}))) as { correctionId?: string };
  return String(body.correctionId ?? '');
}

async function submitInUi(list: FeeReviewListPage, productId: string): Promise<void> {
  await list.rowCheckbox(list.row(productId)).check();
  await list.submitSelected();
}

async function openRecord(queue: ChangeApprovalQueuePage, changeApprovalId: number, reason: string, requester: 'submitter' | 'approver' = 'submitter'): Promise<void> {
  await queue.openRequest({ register: REGISTER, requester: getAccountDisplayName(requester), changeApprovalId, reason });
}

/** Ô category / rate: dòng chính bắt đầu bằng `main`; dòng 2 mờ chứa `proposed` (null = không có dòng 2). */
async function expectLines(list: FeeReviewListPage, row: Locator, column: 'category' | 'rate', main: string, proposed: string | null, tag: string): Promise<void> {
  const cell = list.cell(row, column);
  await expect.soft(cell, `${tag} ${column} main line reads ${main}`).toHaveText(startsWith(main));
  if (proposed === null) await expect.soft(list.secondLine(cell), `${tag} ${column}: no dimmed second line`).toHaveCount(0);
  else await expect.soft(list.secondLine(cell), `${tag} ${column}: ${proposed} proposed beneath`).toContainText(proposed);
}

async function expectPills(list: FeeReviewListPage, row: Locator, first: string | null, second: string | null, tag: string): Promise<void> {
  if (first !== null) await expect.soft(list.statusPills(row).nth(0), `${tag} first pill reads ${first}`).toHaveText(first);
  if (second !== null) await expect.soft(list.statusPills(row).nth(1), `${tag} second pill reads ${second}`).toHaveText(second);
}

test.describe('[Change Approval / Retirement] Fee rule records and automatic retirement (US079 v1)', () => {
  test.describe.configure({ timeout: 360_000 });

  test('TC_US079_126 — A submitted correction appears as a Fee rule record carrying every required field', async ({ page, seedData, feeReviewApi, approvalQueuePage: queue }) => {
    test.skip(!hasCredentials('approver'), APPROVER_MISSING);
    const step = makeStep(page);
    const approval = new FeeRuleApprovalPage(page, queue);
    const reason = reasonOf('TC_US079_126', '카테고리 오매핑 정정 — 부속계약 1 기준');
    await tcMeta('TC_US079_126', 'High', TAGS, `User B opens 변경 승인 → 원장 수수료 규칙 and the P14 record (pending tier-1 correction A 12.50% → B 9.00%): the queue lists it with cycle, product, policy NORMAL, tier 1 and maker user A; 변경 요약 shows 원장, 대상 레코드, 변경 유형 신규, 기안자, 사유, ${Q_PREV} A 12.50% and 제안 값 B 9.00%; the change_approval row carries FEE_RULE, target_ref, target_row_ref X/1, NEW, PENDING, requested_by A, prev / requested values. ${DEV_PREV} Deviation: the queue item shows no tier — "tier 1" is asserted on the item and is expected to fail. ${DEV_REASON} ${DEV_YEAR} ${DATA}`);
    let s!: Seeded;
    let x = '';
    let ca1 = 0;
    let options: string[] = [];
    let record!: RowDataPacket;

    await step('Arrange: Pre-condition 1–13 — ROOT (R_A) + ANNEX1 (R_B9), CY_MAIN, P14 with a submitted tier-1 correction A → B; user B on 변경 승인', async () => {
      s = await seedData({ tc: 126, contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      ({ id: x, approvalId: ca1 } = await pendingCorrection(feeReviewApi, s, 'P14', tier1(s, 'B', reason)));
      const row = await feeReviewApi.row(s.cycles.CY_MAIN.id, s.products.P14);
      expect(row.inForceRate, 'Pre-condition: P14 is in force at 12.50').toContain('12.50');
      expect(row.correction?.state, 'Pre-condition: the correction is PENDING').toBe('PENDING');
      await switchAccount(page, 'approver');
    });

    await step('Act: Step 1 — Open 정산 관리 › 변경 승인 (Change Approval)', async () => {
      await queue.open();
    });

    await step('Assert: Expected 1 — 승인 대기 목록 (Approval Queue) opens', async () => {
      await expect(approval.queueTitle, '[Expected 1] 승인 대기 목록 (Approval Queue) is shown').toBeVisible();
    });

    await step('Act: Step 2 — Open the 원장 (Register) filter', async () => {
      await queue.registerFilterSelect.focus();
      options = (await approval.registerOptions.allTextContents()).map((t) => t.trim());
    });

    await step('Assert: Expected 2 — The options include 수수료 규칙 (Fee Rule); no separate register for fee resolution', async () => {
      expect.soft(options, '[Expected 2] 수수료 규칙 (Fee Rule) is offered').toContain('수수료 규칙');
      expect.soft(options.filter((o) => /정산 수수료|수수료 산정|fee review|fee resolution/i.test(o)), '[Expected 2] No separate register type for fee resolution').toEqual([]);
    });

    await step('Act: Step 3 — Select 수수료 규칙 (Fee Rule)', async () => {
      await queue.showRegister(REGISTER);
    });

    await step('Assert: Expected 3 — The queue lists the P14 record with cycle, product, policy NORMAL, tier 1 and maker user A', async () => {
      const item = approval.item(s.products.P14);
      await expect(item, '[Expected 3] The P14 record is listed').toHaveCount(1);
      await expect.soft(item, '[Expected 3] Cycle').toContainText(new RegExp(`${esc(s.cycles.CY_MAIN.label)}|${s.cycles.CY_MAIN.id}`));
      await expect.soft(item, '[Expected 3] Product').toContainText(s.products.P14);
      await expect.soft(item, '[Expected 3] Policy NORMAL').toContainText('NORMAL');
      await expect.soft(item, '[Expected 3] Tier 1').toContainText(/1단계|tier 1/i);
      await expect.soft(item, '[Expected 3] Maker user A').toContainText(getAccountDisplayName('submitter'));
    });

    await step('Act: Step 4 — Click the record of P14', async () => {
      await openRecord(queue, ca1, reason);
    });

    await step('Assert: Expected 4 — 변경 요약 shows every field of the record', async () => {
      await expect.soft(queue.panelValue('원장'), '[Expected 4] 원장 (Register) = 수수료 규칙').toHaveText('수수료 규칙');
      await expect.soft(queue.panelValue('대상 레코드'), '[Expected 4] 대상 레코드: cycle').toContainText(String(s.cycles.CY_MAIN.id));
      await expect.soft(queue.panelValue('대상 레코드'), '[Expected 4] 대상 레코드: product').toContainText(s.products.P14);
      await expect.soft(queue.panelValue('대상 레코드'), '[Expected 4] 대상 레코드: policy NORMAL').toContainText('NORMAL');
      await expect.soft(queue.panelValue('변경 유형'), '[Expected 4] 변경 유형 (Change type) = 신규').toHaveText('신규');
      await expect.soft(queue.panelValue('기안자'), '[Expected 4] 기안자 (Maker) = user A').toHaveText(getAccountDisplayName('submitter'));
      await expect.soft(queue.reasonBlock, '[Expected 4] 사유 (기안자) = the maker reason').toHaveText(reason);
      await expect.soft(queue.panelValue(Q_PREV), `[Expected 4] ${Q_PREV}: category A (${s.master.categoryName.A})`).toContainText(s.master.categoryName.A);
      await expect.soft(queue.panelValue(Q_PREV), `[Expected 4] ${Q_PREV}: 12.50%`).toContainText('12.50');
      await expect.soft(queue.panelValue(Q_PROPOSED), `[Expected 4] ${Q_PROPOSED}: category B (${s.master.categoryName.B})`).toContainText(`→ ${s.master.categoryName.B}`);
      await expect.soft(queue.panelValue(Q_PROPOSED), `[Expected 4] ${Q_PROPOSED}: 9.00%`).toContainText('→ 9.00');
    });

    await step('Act: Step 5 — Read the change_approval row of CA1', async () => {
      record = await db.approval(ca1);
    });

    await step('Assert: Expected 5 — One FEE_RULE row with target_ref, target_row_ref X/1, NEW, PENDING, user A, prev / requested values', async () => {
      expect.soft(record.target_type, '[Expected 5] target_type = FEE_RULE').toBe('FEE_RULE');
      expect.soft(record.target_ref, '[Expected 5] target_ref = <CY_MAIN>/<P14>/NORMAL').toBe(targetRef(s, 'P14'));
      expect.soft(record.target_row_ref, '[Expected 5] target_row_ref = X/1').toBe(`${x}/1`);
      expect.soft(record.change_type, '[Expected 5] change_type = NEW').toBe('NEW');
      expect.soft(record.approval_status, '[Expected 5] approval_status = PENDING').toBe('PENDING');
      expect.soft(record.requested_by, '[Expected 5] requested_by = user A').toBe(getAccountDisplayName('submitter'));
      expect.soft(json(record.prev_value).rate, '[Expected 5] prev_value rate "12.50"').toBe('12.50');
      expect.soft(json(record.requested_value).categoryName, '[Expected 5] requested_value category B').toBe(s.master.categoryName.B);
      expect.soft(json(record.requested_value).rate, '[Expected 5] requested_value rate "9.00"').toBe('9.00');
    });
  });

  test('TC_US079_127 — The impact shows not yet computable with a zero count and all three buckets named', async ({ page, seedData, feeReviewApi, approvalQueuePage: queue }) => {
    test.skip(!hasCredentials('approver'), APPROVER_MISSING);
    const step = makeStep(page);
    const reason = reasonOf('TC_US079_127', 'Wrong category mapped in commerce');
    await tcMeta('TC_US079_127', 'High', TAGS, `On the P14 Fee Rule record (234 sale lines) the 영향 미리보기 block reads 영향 건수 = 아직 산출할 수 없음 (never a bare 0), names the three buckets "${BUCKETS.join('" · "')}", says the counts cannot be produced until the settlement engine ships and shows no figure (234 is not shown); the DB row holds impact_count 0, impact_status NOT_COMPUTABLE and the same summary. Deviation: the dev summary words the buckets "lines not yet settled / settled with the period open / settled with the period closed" — the TC names are asserted (two expected to fail). ${DEV_REASON} ${DEV_YEAR} ${DATA}`);
    let s!: Seeded;
    let ca1 = 0;
    let record!: RowDataPacket;

    await step('Arrange: Pre-condition 1–13 — P14 (234 sale lines) with a submitted tier-1 correction; user B on 변경 승인', async () => {
      s = await seedData({ tc: 127, contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      ({ approvalId: ca1 } = await pendingCorrection(feeReviewApi, s, 'P14', tier1(s, 'B', reason)));
      expect((await db.approval(ca1)).approval_status, 'Pre-condition: CA1 is PENDING').toBe('PENDING');
      await switchAccount(page, 'approver');
    });

    await step('Act: Step 1 — Open 변경 승인, set 원장 = 수수료 규칙 and click the P14 record', async () => {
      await openRecord(queue, ca1, reason);
    });

    await step('Assert: Expected 1 — Panel 변경 요약 opens for the P14 record', async () => {
      await expect(queue.changeSummaryHeading, '[Expected 1] 변경 요약 (Change summary) is shown').toBeVisible();
      await expect(queue.panelValue('대상 레코드'), '[Expected 1] The panel is the P14 record').toContainText(s.products.P14);
    });

    await step('Act: Step 2 — Read block 영향 미리보기 (Impact preview)', async () => {
      await queue.impactSection.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Not yet computable beside the count, three buckets named, the engine sentence, no figure', async () => {
      await expect.soft(queue.panelValue('영향 건수'), '[Expected 2] 영향 건수 reads 아직 산출할 수 없음').toContainText('아직 산출할 수 없음');
      await expect.soft(queue.panelValue('영향 건수'), '[Expected 2] 영향 건수 is never a bare 0').not.toHaveText(/^\s*0\s*$/);
      for (const bucket of BUCKETS) await expect.soft(queue.impactSection, `[Expected 2] The summary names bucket "${bucket}"`).toContainText(new RegExp(esc(bucket), 'i'));
      await expect.soft(queue.impactSection, '[Expected 2] The counts cannot be produced until the settlement engine ships').toContainText(/cannot be produced until the settlement engine ships/i);
      await expect.soft(queue.impactSection, '[Expected 2] No figure against any bucket').not.toContainText(/\d/);
      await expect.soft(queue.impactSection, '[Expected 2] The 234 sale lines are not shown as the impact').not.toContainText('234');
    });

    await step('Act: Step 3 — Read impact_count, impact_status, impact_summary of CA1', async () => {
      record = await db.approval(ca1);
    });

    await step('Assert: Expected 3 — impact_count 0, NOT_COMPUTABLE, the summary holds the three buckets and the sentence', async () => {
      expect.soft(num(record.impact_count), '[Expected 3] impact_count = 0').toBe(0);
      expect.soft(record.impact_status, '[Expected 3] impact_status = NOT_COMPUTABLE').toBe('NOT_COMPUTABLE');
      for (const bucket of BUCKETS) expect.soft(String(record.impact_summary), `[Expected 3] impact_summary names "${bucket}"`).toMatch(new RegExp(esc(bucket), 'i'));
      expect.soft(String(record.impact_summary), '[Expected 3] impact_summary carries the not-computable sentence').toMatch(/cannot be produced until the settlement engine ships/i);
    });
  });

  test('TC_US079_128 — The current value sent is the value in force and not a pending draft', async ({ page, seedData, feeReviewApi, approverFeeReviewApi, feeReviewPage: list, secondSession }) => {
    const step = makeStep(page);
    const reason1 = reasonOf('TC_US079_128', 'Wrong category mapped in commerce');
    const reason2 = reasonOf('TC_US079_128', '요율 재확인 — 카테고리 E 적용 요청');
    await tcMeta('TC_US079_128', 'Medium', TAGS, `P14 is in force at B 9.00% through an approved correction (contract alone resolves A 12.50%). User A corrects it to category E (PROMOTION row 9.50%) and submits; on the new record 직전 승인 값 is B 9.00% — not A 12.50% nor the draft's E 9.50% — and 제안 값 is E 9.50%; the change_approval row matches. ${DEV_PREV} ${DEV_REASON} ${DEV_YEAR} ${DATA}`);
    let s!: Seeded;
    let b!: Awaited<ReturnType<typeof secondSession>>;
    let newId = 0;
    let record!: RowDataPacket;
    const row = () => list.row(s.products.P14);

    await step('Arrange: Pre-condition 1–14 — ROOT (R_A, R_E11, R_PROMO) + ANNEX1 (R_B9); P14 in force at B 9.00% through an approved correction', async () => {
      s = await seedData({ tc: 128, contracts: family({ ROOT: ['R_A', 'R_E11', 'R_PROMO'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      const { approvalId } = await pendingCorrection(feeReviewApi, s, 'P14', tier1(s, 'B', reason1));
      await approveApi(approverFeeReviewApi, approvalId);
      const listed = await feeReviewApi.row(s.cycles.CY_MAIN.id, s.products.P14);
      expect(listed.correction?.state, 'Pre-condition: the correction is APPROVED').toBe('APPROVED');
      expect(listed.inForceRate, 'Pre-condition: B 9.00 is in force').toContain('9.00');
      b = await secondSession('approver');
    });
    const stepB = makeStep(b.page);

    await step('Act: Step 1 — Open the fee review screen, select CY_MAIN and find the P14 row', async () => {
      await openRow(list, s.cycles.CY_MAIN.id, s.products.P14);
    });

    await step('Assert: Expected 1 — B (팬클럽 키트) and 9.00% on one line each, second pill 승인됨 — 적용', async () => {
      await expectLines(list, row(), 'category', s.master.categoryName.B, null, '[Expected 1]');
      await expectLines(list, row(), 'rate', '9.00%', null, '[Expected 1]');
      await expectPills(list, row(), null, FR_KO['state.APPROVED'], '[Expected 1]');
    });

    await step('Act: Step 2 — Click 수정, pick category E (FANCLUB), type the reason and click 저장', async () => {
      await correctInUi(list, s.products.P14, s.master.categoryName.E, reason2);
    });

    await step('Assert: Expected 2 — The dialog closes and the toast "승인 요청으로 상신되었습니다. 요율이 변경됩니다." shows', async () => {
      await expect.soft(list.correct.root, '[Expected 2] The Correct dialog closes').toHaveCount(0);
      await expect.soft(list.toast(FR_KO['fix.savedDraft']), '[Expected 2] Toast: correction submitted for approval — the rate changed').toBeVisible();
    });

    await step('Act: Step 3 — Read the P14 row', async () => {
      await row().scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — B 9.00% stays the main line, E 9.50% dimmed beneath, pill 수정됨 — 미상신', async () => {
      await expectLines(list, row(), 'category', s.master.categoryName.B, s.master.categoryName.E, '[Expected 3]');
      await expectLines(list, row(), 'rate', '9.00%', '9.50%', '[Expected 3]');
      await expectPills(list, row(), null, FR_KO['state.DRAFT'], '[Expected 3]');
    });

    await step('Act: Step 4 — Tick the P14 row and click 선택 일괄 상신', async () => {
      await submitInUi(list, s.products.P14);
    });

    await step('Assert: Expected 4 — Toast "수정 1건을 승인 요청으로 상신했습니다." and pill 승인 대기', async () => {
      await expect.soft(list.toast(frFormat(FR_KO['msg.submitted'], { n: 1 })), '[Expected 4] Toast: 1 correction submitted for approval').toBeVisible();
      await expectPills(list, row(), null, FR_KO['state.PENDING'], '[Expected 4]');
    });

    await stepB('Act: Step 5 — As user B open 변경 승인 → 수수료 규칙 and the new P14 record', async () => {
      newId = await approvalIdOf(targetRef(s, 'P14'));
      await openRecord(b.queue, newId, reason2);
    });

    await stepB('Assert: Expected 5 — 직전 승인 값 = B 9.00% (not A 12.50%, not E 9.50%); 제안 값 = E 9.50%', async () => {
      await expect.soft(b.queue.panelValue(Q_PREV), `[Expected 5] ${Q_PREV}: category B`).toContainText(s.master.categoryName.B);
      await expect.soft(b.queue.panelValue(Q_PREV), `[Expected 5] ${Q_PREV}: 9.00%`).toContainText('9.00');
      await expect.soft(b.queue.panelValue(Q_PREV), `[Expected 5] ${Q_PREV}: not the contract's 12.50%`).not.toContainText('12.50');
      await expect.soft(b.queue.panelValue(Q_PREV), `[Expected 5] ${Q_PREV}: not the draft's 9.50%`).not.toContainText('9.50');
      await expect.soft(b.queue.panelValue(Q_PROPOSED), `[Expected 5] ${Q_PROPOSED}: category E`).toContainText(`→ ${s.master.categoryName.E}`);
      await expect.soft(b.queue.panelValue(Q_PROPOSED), `[Expected 5] ${Q_PROPOSED}: 9.50%`).toContainText('→ 9.50');
    });

    await step('Act: Step 6 — Read prev_value and requested_value of the newest P14 record', async () => {
      record = await db.approval(newId);
    });

    await step('Assert: Expected 6 — prev_value rate "9.00"; requested_value category E rate "9.50"', async () => {
      expect.soft(json(record.prev_value).rate, '[Expected 6] prev_value rate "9.00"').toBe('9.00');
      expect.soft(json(record.requested_value).categoryName, '[Expected 6] requested_value category E').toBe(s.master.categoryName.E);
      expect.soft(json(record.requested_value).rate, '[Expected 6] requested_value rate "9.50"').toBe('9.50');
    });
  });

  test('TC_US079_129 — Approving puts the correction in force as Approved — applied on every view', async ({ page, seedData, feeReviewApi, feeReviewPage: list, secondSession }) => {
    test.skip(!hasCredentials('approver'), APPROVER_MISSING);
    const step = makeStep(page);
    const reason = reasonOf('TC_US079_129', 'Wrong category mapped in commerce');
    await tcMeta('TC_US079_129', 'Critical', TAGS, `User B approves the pending P14 correction A 12.50% → B 9.00% (confirm dialog text checked, toast, record leaves the queue); for user A the row reads 산정 완료 + 승인됨 — 적용 with B / 9.00% on one line, no 회수, and counts under 이번 기 수정됨; 근거 shows 9.00% 수정본 적용 while the contract still resolves A 12.50%; the period report and 변경 이력 show the approval and both change lines; the DB shows APPROVED, decided_by / approved_by user B, pending_key NULL, effective_from unchanged. Deviation: "counts in chip 이번 기 수정됨" is read through the list API (bucket CORRECTED_THIS_PERIOD) so the step does not change the screen. ${DEV_REASON} ${DEV_YEAR} ${DATA}`);
    let s!: Seeded;
    let b!: Awaited<ReturnType<typeof secondSession>>;
    let approval!: FeeRuleApprovalPage;
    let x = '';
    let ca1 = 0;
    let effectiveFrom = '';
    let after: { correction?: RowDataPacket; record?: RowDataPacket } = {};
    const row = () => list.row(s.products.P14);

    await step('Arrange: Pre-condition 1–13 — P14 with a pending tier-1 correction A → B; user B on 변경 승인, user A on a second browser', async () => {
      s = await seedData({ tc: 129, contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      ({ id: x, approvalId: ca1 } = await pendingCorrection(feeReviewApi, s, 'P14', tier1(s, 'B', reason)));
      const correction = await db.correction(x);
      expect(correction.state, 'Pre-condition: X is PENDING').toBe('PENDING');
      expect(num(correction.change_approval_id), 'Pre-condition: X points to CA1').toBe(ca1);
      effectiveFrom = day(correction.effective_from);
      b = await secondSession('approver');
      approval = new FeeRuleApprovalPage(b.page, b.queue);
    });
    const stepB = makeStep(b.page);

    await stepB('Act: Step 1 — As user B open 변경 승인, set 원장 = 수수료 규칙 and click the P14 record', async () => {
      await openRecord(b.queue, ca1, reason);
    });

    await stepB('Assert: Expected 1 — The record opens with 승인 and 반려… enabled', async () => {
      await expect.soft(b.queue.approveButton, '[Expected 1] 승인 (Approve) is enabled').toBeEnabled();
      await expect.soft(b.queue.rejectButton, '[Expected 1] 반려… (Reject…) is enabled').toBeEnabled();
    });

    await stepB('Act: Step 2 — Click 승인 (Approve)', async () => {
      await b.queue.click(b.queue.approveButton, '승인 (Approve) button');
    });

    await stepB('Assert: Expected 2 — Dialog 승인 확인 opens with the supersede text', async () => {
      await expect(b.queue.approveDialog, '[Expected 2] 승인 확인 (Confirm approval) opens').toBeVisible();
      await expect.soft(b.queue.approveDialog, '[Expected 2] Text "이 변경을 승인하시겠습니까? 동일 키의 다른 활성 레코드는 자동으로 대체됩니다."').toContainText('이 변경을 승인하시겠습니까? 동일 키의 다른 활성 레코드는 자동으로 대체됩니다.');
    });

    await stepB('Act: Step 3 — Confirm the dialog', async () => {
      await b.queue.click(b.queue.approveDialogConfirmButton, '승인 button on the 승인 확인 dialog');
    });

    await stepB('Assert: Expected 3 — Toast 승인되었습니다 and the record leaves the pending list', async () => {
      await expect.soft(b.queue.approvedToast, '[Expected 3] Toast 승인되었습니다 (Approved)').toBeVisible();
      await expect.soft(approval.item(s.products.P14), '[Expected 3] The record leaves the pending list').toHaveCount(0);
    });

    await step('Act: Step 4 — As user A open the fee review screen, CY_MAIN, chip 기간 내 판매 상품, find the P14 row', async () => {
      await openRow(list, s.cycles.CY_MAIN.id, s.products.P14);
    });

    await step('Assert: Expected 4 — 산정 완료 + 승인됨 — 적용, B / 9.00% on one line, no 회수, counted under 이번 기 수정됨', async () => {
      await expectPills(list, row(), FR_KO['status.RESOLVED'], FR_KO['state.APPROVED'], '[Expected 4]');
      await expectLines(list, row(), 'category', s.master.categoryName.B, null, '[Expected 4]');
      await expectLines(list, row(), 'rate', '9.00%', null, '[Expected 4]');
      await expect.soft(list.rowButton(row(), 'btn.withdraw'), '[Expected 4] 회수 (Withdraw) is not shown').toHaveCount(0);
      const corrected = await feeReviewApi.products(s.cycles.CY_MAIN.id, { bucket: 'CORRECTED_THIS_PERIOD', keyword: s.products.P14 });
      expect.soft(corrected.content.map((r) => r.productId), '[Expected 4] The row counts in chip 이번 기 수정됨 (Corrected this period)').toContain(s.products.P14);
    });

    await step('Act: Step 5 — Click 근거 (Basis) on the P14 row', async () => {
      await list.openBasis(row());
    });

    await step('Assert: Expected 5 — 9.00% marked 수정본 적용 with category B; the contract itself still resolves A 12.50%', async () => {
      const extras = new FeeReviewRowExtras(page, list);
      await expect.soft(list.basis.headlineRate, '[Expected 5] The rate in force is 9.00%').toHaveText('9.00%');
      await expect.soft(extras.basisSource('trace.fromCorrection'), '[Expected 5] Marked 수정본 적용 (from a correction)').toBeVisible();
      await expect.soft(list.basis.root, '[Expected 5] Category B').toContainText(s.master.categoryName.B);
      await expect.soft(extras.basisOverridePanel, '[Expected 5] The contract itself still resolves A').toContainText(s.master.categoryName.A);
      await expect.soft(extras.basisOverridePanel, '[Expected 5] The contract itself still resolves 12.50%').toContainText('12.50%');
    });

    await step('Act: Step 6 — Close the panel, click 이번 기 수정 내역 and find the P14 row', async () => {
      await list.basis.close();
      await list.openReport();
      await list.report.showLatest();
    });

    await step('Assert: Expected 6 — 승인 = 승인됨 — 적용 and 요율 변동 12.50% → 9.00%', async () => {
      const reportRow = list.report.rows.filter({ hasText: s.products.P14 }).last();
      await expect.soft(list.report.cell(reportRow, 'approval'), '[Expected 6] 승인 (Approval) = 승인됨 — 적용').toContainText(FR_KO['state.APPROVED']);
      await expect.soft(list.report.cell(reportRow, 'rate'), '[Expected 6] 요율 변동 (Rate change) 12.50% → 9.00%').toContainText(/12\.50%?\s*→\s*9\.00%?/);
    });

    await step('Act: Step 7 — Close the report and click 이력 (History) on the P14 row', async () => {
      await list.report.close();
      await list.openHistory(row());
    });

    await step('Assert: Expected 7 — One entry, outcome approved, two change lines A → B and 12.50% → 9.00%', async () => {
      await expect.soft(list.history.rows, '[Expected 7] One entry for the submission').toHaveCount(1);
      const entry = list.history.rows.first();
      await expect.soft(list.history.cell(entry, 'change'), '[Expected 7] Outcome approved').toContainText(/승인됨/);
      await expect.soft(list.history.cell(entry, 'setting'), '[Expected 7] Change line 수수료 카테고리 (Fee category)').toContainText(FR_KO['hist.fieldCategory']);
      await expect.soft(list.history.cell(entry, 'setting'), '[Expected 7] Change line 수수료율 (Fee rate)').toContainText(FR_KO['hist.fieldRate']);
      await expect.soft(list.history.cell(entry, 'change'), '[Expected 7] Fee category A → B').toContainText(`${s.master.categoryName.A} → ${s.master.categoryName.B}`);
      await expect.soft(list.history.cell(entry, 'change'), '[Expected 7] Fee rate 12.50% → 9.00%').toContainText(/12\.50%?\s*→\s*9\.00%?/);
    });

    await step('Act: Step 8 — Read fee_correction X and change_approval CA1', async () => {
      after = { correction: await db.correction(x), record: await db.approval(ca1) };
    });

    await step('Assert: Expected 8 — X APPROVED, decided_by B, pending_key NULL, effective_from unchanged; CA1 APPROVED by B', async () => {
      expect.soft(after.correction?.state, '[Expected 8] X state = APPROVED').toBe('APPROVED');
      expect.soft(after.correction?.decided_by, '[Expected 8] X decided_by = user B').toBe(getAccountDisplayName('approver'));
      expect.soft(after.correction?.pending_key ?? null, '[Expected 8] X pending_key = NULL').toBeNull();
      expect.soft(day(after.correction?.effective_from), '[Expected 8] X effective_from unchanged').toBe(effectiveFrom);
      expect.soft(after.record?.approval_status, '[Expected 8] CA1 approval_status = APPROVED').toBe('APPROVED');
      expect.soft(after.record?.approved_by, '[Expected 8] CA1 approved_by = user B').toBe(getAccountDisplayName('approver'));
    });
  });
  test('TC_US079_130 — Rejecting needs a reason and returns the correction as Rejected — fix and resubmit', async ({ page, seedData, feeReviewApi, approverFeeReviewApi, feeReviewPage: list, secondSession }) => {
    const step = makeStep(page);
    const reason = reasonOf('TC_US079_130', 'Wrong category mapped in commerce');
    const rejectText = '부속계약 1 기준 B 카테고리가 맞습니다 — 다시 확인해 주세요';
    await tcMeta('TC_US079_130', 'Critical', TAGS, `User B opens 반려… on the pending P03 correction B 9.00% → A 12.50%: the dialog shows 반려 사유 (필수), placeholder "기안자가 무엇을 고쳐야 하는지 적어주세요" and 0/200; a blank reason is refused (CHG-1003) and the record stays pending; 201 characters are cut to 200 (200/200); a real reason rejects it (toast 반려되었습니다). User A then sees 반려됨 — 수정 후 재상신 with B 9.00% in force, A 12.50% proposed and the reason in the pill tooltip; 변경 이력 shows the maker reason, a separate 반려 사유 block with user B and the proposed value struck through; the DB matches. Deviation: the UI blocks a blank reason client-side, so CHG-1003 is read from a direct reject call with a blank reason inside Step 3. Build note (TC remark): the dev placeholder reads "예: 08-16에 이미 승인된 환율과 중복" — the TC placeholder is asserted and expected to fail. ${DEV_REASON} ${DEV_YEAR} ${DATA}`);
    let s!: Seeded;
    let b!: Awaited<ReturnType<typeof secondSession>>;
    let approval!: FeeRuleApprovalPage;
    let y = '';
    let ca2 = 0;
    let blank = { status: 0, body: '' };
    let after: { correction?: RowDataPacket; history: RowDataPacket[] } = { history: [] };
    const extras = new FeeReviewRowExtras(page, list);
    const row = () => list.row(s.products.P03);

    await step('Arrange: Pre-condition 1–13 — ROOT (R_A, R_B10) + ANNEX1 (R_B9); P03 with a pending tier-1 correction B → A; user B and user A sessions', async () => {
      s = await seedData({ tc: 130, contracts: family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P03', [{ cycle: 'CY_MAIN', saleLines: 10 }])] });
      ({ id: y, approvalId: ca2 } = await pendingCorrection(feeReviewApi, s, 'P03', tier1(s, 'A', reason)));
      const listed = await feeReviewApi.row(s.cycles.CY_MAIN.id, s.products.P03);
      expect(listed.inForceRate, 'Pre-condition: B 9.00 is in force').toContain('9.00');
      expect(listed.correction?.state, 'Pre-condition: the correction is PENDING').toBe('PENDING');
      b = await secondSession('approver');
      approval = new FeeRuleApprovalPage(b.page, b.queue);
    });
    const stepB = makeStep(b.page);

    await stepB('Act: Step 1 — As user B open 변경 승인, set 원장 = 수수료 규칙 and click the P03 record', async () => {
      await openRecord(b.queue, ca2, reason);
    });

    await stepB('Assert: Expected 1 — The record opens with 반려… enabled', async () => {
      await expect(b.queue.rejectButton, '[Expected 1] 반려… (Reject…) is enabled').toBeEnabled();
    });

    await stepB('Act: Step 2 — Click 반려… (Reject…)', async () => {
      await b.queue.openRejectDialog();
    });

    await stepB('Assert: Expected 2 — Dialog 반려 확정 with 반려 사유 (필수), the TC placeholder and counter 0/200', async () => {
      await expect.soft(b.queue.rejectDialog, '[Expected 2] Dialog 반려 확정 (Confirm rejection) opens').toBeVisible();
      await expect.soft(approval.rejectReasonLabel, '[Expected 2] Field 반려 사유 (필수) (Rejection reason (required))').toHaveText(/^\s*반려 사유 \(필수\)\s*$/);
      await expect.soft(b.queue.rejectReasonInput, '[Expected 2] Placeholder 기안자가 무엇을 고쳐야 하는지 적어주세요').toHaveAttribute('placeholder', '기안자가 무엇을 고쳐야 하는지 적어주세요');
      await expect.soft(approval.rejectCounter, '[Expected 2] Counter 0/200').toHaveText(/^\s*0\s*\/\s*200\s*$/);
    });

    await stepB('Act: Step 3 — Leave the reason empty and click 반려 확정 (Confirm rejection)', async () => {
      await b.queue.confirmReject();
      const res = await approverFeeReviewApi.reject(ca2, '');
      blank = { status: res.status, body: JSON.stringify(res.body) };
    });

    await stepB('Assert: Expected 3 — Refused with CHG-1003; the dialog stays open; the record stays pending', async () => {
      expect.soft(blank.body, '[Expected 3] A blank reason is refused with error code CHG-1003').toContain('CHG-1003');
      await expect.soft(b.queue.rejectDialog, '[Expected 3] The dialog stays open').toBeVisible();
      expect.soft((await db.approval(ca2)).approval_status, '[Expected 3] The record stays pending').toBe('PENDING');
    });

    await stepB("Act: Step 4 — Paste a 201-character string of repeated 'A' into the reason field", async () => {
      await b.queue.rejectReasonInput.fill('A'.repeat(201));
    });

    await stepB('Assert: Expected 4 — The field keeps only 200 characters and the counter reads 200/200', async () => {
      expect.soft((await b.queue.rejectReasonInput.inputValue()).length, '[Expected 4] The field keeps only 200 characters').toBe(200);
      await expect.soft(approval.rejectCounter, '[Expected 4] Counter 200/200').toHaveText(/^\s*200\s*\/\s*200\s*$/);
    });

    await stepB('Act: Step 5 — Clear the field, type the rejection reason and click 반려 확정', async () => {
      await b.queue.rejectReasonInput.fill('');
      await b.queue.confirmReject(rejectText);
    });

    await stepB('Assert: Expected 5 — The dialog closes and the toast 반려되었습니다 shows', async () => {
      await expect.soft(b.queue.rejectDialog, '[Expected 5] The dialog closes').toHaveCount(0);
      await expect.soft(b.queue.rejectedToast, '[Expected 5] Toast 반려되었습니다 (Rejected)').toBeVisible();
    });

    await step('Act: Step 6 — As user A open the fee review screen, CY_MAIN, find the P03 row and hover its second pill', async () => {
      await openRow(list, s.cycles.CY_MAIN.id, s.products.P03);
      await list.statusPills(row()).nth(1).hover();
    });

    await step('Assert: Expected 6 — 반려됨 — 수정 후 재상신, B 9.00% in force with A 12.50% beneath, tooltip with the approver reason', async () => {
      await expectPills(list, row(), null, FR_KO['state.REJECTED'], '[Expected 6]');
      await expectLines(list, row(), 'category', s.master.categoryName.B, s.master.categoryName.A, '[Expected 6]');
      await expectLines(list, row(), 'rate', '9.00%', '12.50%', '[Expected 6]');
      await expect.soft(extras.tooltip, '[Expected 6] The pill tooltip shows the approver reason').toContainText(rejectText);
    });

    await step('Act: Step 7 — Click 이력 (History) on the P03 row', async () => {
      await list.openHistory(row());
    });

    await step('Assert: Expected 7 — Maker reason, a separate 반려 사유 block with user B, the proposed value struck through', async () => {
      const entry = list.history.rows.filter({ hasText: reason }).first();
      await expect.soft(list.history.cell(entry, 'reason'), "[Expected 7] The submitter's reason").toContainText(reason);
      await expect.soft(extras.historyRejectBlock(entry), '[Expected 7] 반려 사유 (Reject reason) block holds the approver reason').toContainText(rejectText);
      await expect.soft(extras.historyRejectBlock(entry), '[Expected 7] 반려 사유 block names user B').toContainText(getAccountDisplayName('approver'));
      expect.soft(await extras.hasStrikeThrough(list.history.cell(entry, 'change')).catch(() => false), '[Expected 7] The proposed value is struck through').toBe(true);
    });

    await step('Act: Step 8 — Read fee_correction Y and its history rows', async () => {
      after = { correction: await db.correction(y), history: await db.history(y) };
    });

    await step('Assert: Expected 8 — Y REJECTED with the approver reason, REJECTED cause, submission 2, user B, no pending key; history row 1 separate fields', async () => {
      expect.soft(after.correction?.state, '[Expected 8] state = REJECTED').toBe('REJECTED');
      expect.soft(after.correction?.rejection_reason, '[Expected 8] rejection_reason = the approver text').toBe(rejectText);
      expect.soft(after.correction?.last_return_cause, '[Expected 8] last_return_cause = REJECTED').toBe('REJECTED');
      expect.soft(num(after.correction?.submission_no), '[Expected 8] submission_no = 2').toBe(2);
      expect.soft(after.correction?.decided_by, '[Expected 8] decided_by = user B').toBe(getAccountDisplayName('approver'));
      expect.soft(after.correction?.pending_key ?? null, '[Expected 8] pending_key = NULL').toBeNull();
      const first = after.history.find((h) => num(h.submission_no) === 1);
      expect.soft(first?.outcome, '[Expected 8] History submission 1: outcome = REJECTED').toBe('REJECTED');
      expect.soft(first?.reason, '[Expected 8] History submission 1: reason = the maker reason').toBe(reason);
      expect.soft(first?.reject_reason, '[Expected 8] History submission 1: reject_reason = the approver text').toBe(rejectText);
    });
  });

  test('TC_US079_131 — Resubmitting after a rejection creates a new approval record', async ({ page, seedData, feeReviewApi, approverFeeReviewApi, feeReviewPage: list, secondSession }) => {
    const step = makeStep(page);
    const reason1 = reasonOf('TC_US079_131', 'Wrong category mapped in commerce');
    const reason2 = reasonOf('TC_US079_131', '반려 의견 반영 — 루트 계약 기준 A 카테고리로 재상신');
    const rejectText = '부속계약 1 기준 B 카테고리가 맞습니다 — 다시 확인해 주세요';
    await tcMeta('TC_US079_131', 'High', TAGS, `The rejected P03 correction Y (B → A) is reopened with category A, 12.50% and the earlier reason, saved with a new reason and resubmitted: one new pending Fee Rule record (target_row_ref Y/2) carries the new reason while CA2 (Y/1) keeps its rejection; 변경 이력 shows both submissions; Y is PENDING, submission_no 2, linked to the new record with rejection fields cleared. Deviation: on dev a rejected record keeps approval_status DRAFT with last_decision REJECTED — "keeps its rejection" accepts either column. ${DEV_REASON} ${DEV_YEAR} ${DATA}`);
    let s!: Seeded;
    let b!: Awaited<ReturnType<typeof secondSession>>;
    let approval!: FeeRuleApprovalPage;
    let y = '';
    let ca2 = 0;
    let newId = 0;
    let records: RowDataPacket[] = [];
    let corrections: RowDataPacket[] = [];
    const extras = new FeeReviewRowExtras(page, list);
    const row = () => list.row(s.products.P03);

    await step('Arrange: Pre-condition 1–14 — P03 correction Y (B → A) submitted and rejected by user B', async () => {
      s = await seedData({ tc: 131, contracts: family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P03', [{ cycle: 'CY_MAIN', saleLines: 10 }])] });
      ({ id: y, approvalId: ca2 } = await pendingCorrection(feeReviewApi, s, 'P03', tier1(s, 'A', reason1)));
      expect((await approverFeeReviewApi.reject(ca2, rejectText)).status, 'Pre-condition: CA2 is rejected by user B').toBe(200);
      expect((await db.correction(y)).state, 'Pre-condition: Y is REJECTED').toBe('REJECTED');
      b = await secondSession('approver');
      approval = new FeeRuleApprovalPage(b.page, b.queue);
    });
    const stepB = makeStep(b.page);

    await step('Act: Step 1 — Open the fee review screen, CY_MAIN, find the P03 row and click 수정 (Correct)', async () => {
      await openRow(list, s.cycles.CY_MAIN.id, s.products.P03);
      await list.openCorrect(row());
    });

    await step('Assert: Expected 1 — The dialog opens on Y with category A (음반), 12.50% and the earlier reason', async () => {
      await expect.soft(list.correct.root, '[Expected 1] 수수료 산정 수정 (Correct fee resolution) opens').toBeVisible();
      await expect.soft(list.correct.tier1Select.locator('option:checked'), `[Expected 1] Category A (${s.master.categoryName.A}) is selected`).toHaveText(startsWith(s.master.categoryName.A));
      await expect.soft(list.correct.root, '[Expected 1] Rate 12.50%').toContainText('12.50%');
      await expect.soft(list.correct.reasonInput, '[Expected 1] The earlier reason is filled in').toHaveValue(reason1);
    });

    await step('Act: Step 2 — Keep category A, replace the reason and click 저장 (Save)', async () => {
      await list.correct.reasonInput.fill(reason2);
      await list.correct.save();
    });

    await step('Assert: Expected 2 — Toast "승인 요청으로 상신되었습니다. 요율이 변경됩니다." and pill 수정됨 — 미상신', async () => {
      await expect.soft(list.toast(FR_KO['fix.savedDraft']), '[Expected 2] Toast: correction submitted for approval — the rate changed').toBeVisible();
      await expectPills(list, row(), null, FR_KO['state.DRAFT'], '[Expected 2]');
    });

    await step('Act: Step 3 — Tick the P03 row and click 선택 일괄 상신', async () => {
      await submitInUi(list, s.products.P03);
    });

    await step('Assert: Expected 3 — Toast "수정 1건을 승인 요청으로 상신했습니다." and pill 승인 대기', async () => {
      await expect.soft(list.toast(frFormat(FR_KO['msg.submitted'], { n: 1 })), '[Expected 3] Toast: 1 correction submitted for approval').toBeVisible();
      await expectPills(list, row(), null, FR_KO['state.PENDING'], '[Expected 3]');
    });

    await stepB('Act: Step 4 — As user B open 변경 승인 with 원장 = 수수료 규칙', async () => {
      newId = await approvalIdOf(targetRef(s, 'P03'));
      await openRecord(b.queue, newId, reason2);
    });

    await stepB('Assert: Expected 4 — One new pending P03 record with 사유 (기안자) = the new reason', async () => {
      await expect.soft(approval.item(s.products.P03), '[Expected 4] One pending P03 record is listed').toHaveCount(1);
      await expect.soft(b.queue.reasonBlock, '[Expected 4] 사유 (기안자) = the new reason').toHaveText(reason2);
      expect.soft(newId, '[Expected 4] The record is new (not CA2)').not.toBe(ca2);
    });

    await step('Act: Step 5 — Read the change_approval rows of the P03 key', async () => {
      records = await db.approvals(targetRef(s, 'P03'));
    });

    await step('Assert: Expected 5 — Two rows: CA2 (Y/1) keeps its rejection; a new id (Y/2) PENDING', async () => {
      expect.soft(records.length, '[Expected 5] Two rows').toBe(2);
      const first = records.find((r) => num(r.id) === ca2);
      const second = records.find((r) => num(r.id) !== ca2);
      expect.soft(first?.target_row_ref, '[Expected 5] CA2 target_row_ref = Y/1').toBe(`${y}/1`);
      expect.soft([first?.approval_status, first?.last_decision], '[Expected 5] CA2 keeps its rejection').toContain('REJECTED');
      expect.soft(second?.target_row_ref, '[Expected 5] New record target_row_ref = Y/2').toBe(`${y}/2`);
      expect.soft(second?.approval_status, '[Expected 5] New record approval_status = PENDING').toBe('PENDING');
    });

    await step('Act: Step 6 — As user A click 이력 (History) on the P03 row', async () => {
      await list.openHistory(row());
    });

    await step('Assert: Expected 6 — Both submissions: the first rejected with its 반려 사유, the second awaiting approval with the new reason', async () => {
      await expect.soft(list.history.rows, '[Expected 6] Two submissions are listed').toHaveCount(2);
      const first = list.history.rows.filter({ hasText: reason1 }).first();
      const second = list.history.rows.filter({ hasText: reason2 }).first();
      await expect.soft(list.history.cell(first, 'change'), '[Expected 6] The first submission is rejected').toContainText(FR_KO['state.REJECTED']);
      await expect.soft(extras.historyRejectBlock(first), '[Expected 6] The first submission carries its 반려 사유').toContainText(rejectText);
      await expect.soft(list.history.cell(second, 'change'), '[Expected 6] The second submission awaits approval').toContainText(FR_KO['state.PENDING']);
      await expect.soft(list.history.cell(second, 'reason'), '[Expected 6] The second submission carries the new reason').toContainText(reason2);
    });

    await step('Act: Step 7 — Read the fee_correction rows of P03 in CY_MAIN', async () => {
      corrections = await db.corrections(s.products.P03);
    });

    await step('Assert: Expected 7 — One row Y: PENDING, submission_no 2, linked to the new record, rejection fields NULL', async () => {
      expect.soft(corrections.length, '[Expected 7] One row').toBe(1);
      const c = corrections[0];
      expect.soft(String(c?.id), '[Expected 7] id = Y').toBe(y);
      expect.soft(c?.state, '[Expected 7] state = PENDING').toBe('PENDING');
      expect.soft(num(c?.submission_no), '[Expected 7] submission_no = 2').toBe(2);
      expect.soft(num(c?.change_approval_id), '[Expected 7] change_approval_id = the new record id').toBe(newId);
      expect.soft(c?.rejection_reason ?? null, '[Expected 7] rejection_reason = NULL').toBeNull();
      expect.soft(c?.decided_by ?? null, '[Expected 7] decided_by = NULL').toBeNull();
      expect.soft(c?.last_return_cause ?? null, '[Expected 7] last_return_cause = NULL').toBeNull();
    });
  });

  test('TC_US079_132 — The submitter cannot approve their own correction', async ({ page, seedData, approverFeeReviewApi, feeReviewPage: list, approvalQueuePage: queue }) => {
    const step = makeStep(page);
    const reason = reasonOf('TC_US079_132', 'Category D has no contract row — map to A');
    await tcMeta('TC_US079_132', 'Critical', TAGS, `User B saves (API) and submits (UI) a tier-1 correction D → A on P06, then opens it on 변경 승인: 기안자 = user B, 승인 / 반려… are disabled with the hint "본인이 제출한 변경은 승인할 수 없습니다."; a direct approve call by user B is refused with CHG-1002; the correction stays PENDING and the record PENDING with no decider. ${DEV_REASON} ${DEV_YEAR} ${DATA}`);
    let s!: Seeded;
    let v = '';
    let caId = 0;
    let refused = { status: 0, body: '' };
    let after: { correction?: RowDataPacket; record?: RowDataPacket } = {};
    const row = () => list.row(s.products.P06);

    await step('Arrange: Pre-condition 1–11 — ROOT (R_A); P06 (category D, no row) with a draft V saved by user B; browser logged in as user B', async () => {
      s = await seedData({ tc: 132, contracts: family({ ROOT: ['R_A'] }), cycles: ['CY_MAIN'], products: [product('P06', [{ cycle: 'CY_MAIN', saleLines: 5 }])] });
      ({ id: v } = await saveCorrection(approverFeeReviewApi, s, 'P06', tier1(s, 'A', reason)));
      const correction = await db.correction(v);
      expect(correction.state, 'Pre-condition: V is DRAFT').toBe('DRAFT');
      await switchAccount(page, 'approver');
    });

    await step('Act: Step 1 — As user B open the fee review screen, CY_MAIN, tick P06 and click 선택 일괄 상신', async () => {
      await openRow(list, s.cycles.CY_MAIN.id, s.products.P06);
      await submitInUi(list, s.products.P06);
    });

    await step('Assert: Expected 1 — Toast "수정 1건을 승인 요청으로 상신했습니다." and the P06 row reads 승인 대기', async () => {
      await expect.soft(list.toast(frFormat(FR_KO['msg.submitted'], { n: 1 })), '[Expected 1] Toast: 1 correction submitted for approval').toBeVisible();
      await expectPills(list, row(), null, FR_KO['state.PENDING'], '[Expected 1]');
    });

    await step('Act: Step 2 — As user B open 변경 승인, 원장 = 수수료 규칙, and click the P06 record', async () => {
      caId = await approvalIdOf(targetRef(s, 'P06'));
      await openRecord(queue, caId, reason, 'approver');
    });

    await step('Assert: Expected 2 — 기안자 = user B; 승인 and 반려… disabled with the self-approval hint', async () => {
      await expect.soft(queue.panelValue('기안자'), '[Expected 2] 기안자 (Maker) = user B').toHaveText(getAccountDisplayName('approver'));
      await expect.soft(queue.approveButton, '[Expected 2] 승인 (Approve) is disabled').toBeDisabled();
      await expect.soft(queue.rejectButton, '[Expected 2] 반려… (Reject…) is disabled').toBeDisabled();
      await expect.soft(queue.selfApprovalMessage, '[Expected 2] Hint 본인이 제출한 변경은 승인할 수 없습니다.').toBeVisible();
    });

    await step('Act: Step 3 — As user B call POST /change-approvals/{id}/approve', async () => {
      const res = await approverFeeReviewApi.approve(caId);
      refused = { status: res.status, body: JSON.stringify(res.body) };
    });

    await step('Assert: Expected 3 — The approval is refused with error code CHG-1002', async () => {
      expect.soft(refused.status, '[Expected 3] The approval is refused (4xx)').toBeGreaterThanOrEqual(400);
      expect.soft(refused.body, '[Expected 3] Error code CHG-1002').toContain('CHG-1002');
    });

    await step('Act: Step 4 — Read fee_correction V and the change_approval record', async () => {
      after = { correction: await db.correction(v), record: await db.approval(caId) };
    });

    await step('Assert: Expected 4 — V PENDING with no decider; the record PENDING with no approver', async () => {
      expect.soft(after.correction?.state, '[Expected 4] V state = PENDING').toBe('PENDING');
      expect.soft(after.correction?.decided_by ?? null, '[Expected 4] V decided_by = NULL').toBeNull();
      expect.soft(after.record?.approval_status, '[Expected 4] Record approval_status = PENDING').toBe('PENDING');
      expect.soft(after.record?.approved_by ?? null, '[Expected 4] Record approved_by = NULL').toBeNull();
    });
  });

  test('TC_US079_133 — Approving a correction whose cycle has closed applies it from the next open cycle only', async ({ page, seedData, feeReviewApi, feeReviewPage: list, secondSession }) => {
    test.skip(!hasCredentials('approver'), APPROVER_MISSING);
    const step = makeStep(page);
    await tcMeta('TC_US079_133', 'Critical', TAGS, `A correction B → A on P03 is saved and submitted in CY_CLOSE, then CY_CLOSE is closed: the row still reads 승인 대기 with B 9.00% (no provisional banner); the record stays pending and its impact names the raised-in cycle and the applies-from cycle; after approval the correction is APPROVED in CY_CLOSE with effective_from = first day of CY_NEXT, and CY_CLOSE still shows B 9.00%. Expected to FAIL (TC build note DEV-42): impact_summary is written at submit only, so the closed-cycle sentence of Expected 5 is missing. Not automated: "no adjustment line is raised" — no adjustment ledger exists on this build. Deviation: the "reload" steps reopen the screen. ${DEV_REASON} ${DEV_YEAR} ${DATA}`);
    let s!: Seeded;
    let b!: Awaited<ReturnType<typeof secondSession>>;
    let reason = '';
    let z = '';
    let caId = 0;
    let closed = { status: 0, cycle: '' };
    let correction!: RowDataPacket;
    const row = () => list.row(s.products.P03);

    await step('Arrange: Pre-condition 1–12 — ROOT (R_A, R_B10) + ANNEX1 (R_B9); CY_CLOSE and CY_NEXT open; P03 in CY_CLOSE resolves B 9.00%', async () => {
      s = await seedData({ tc: 133, private: true, contracts: family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9'] }), cycles: ['CY_CLOSE', 'CY_NEXT'], products: [product('P03', [{ cycle: 'CY_CLOSE', saleLines: 10 }])] });
      reason = reasonOf('TC_US079_133', `Wrong category mapped in commerce (${s.cycles.CY_CLOSE.label})`);
      const between = (await db.openCyclesAfter(s.cycles.CY_CLOSE.periodEnd)).filter((c) => day(c.period_start) < s.cycles.CY_NEXT.periodStart);
      expect(between, 'Pre-condition: CY_NEXT is the oldest OPEN cycle after CY_CLOSE').toEqual([]);
      const listed = await feeReviewApi.row(s.cycles.CY_CLOSE.id, s.products.P03);
      expect(listed.inForceRate, 'Pre-condition: B 9.00 is in force').toContain('9.00');
      b = await secondSession('approver');
    });
    const stepB = makeStep(b.page);

    await step('Act: Step 1 — Open the screen on CY_CLOSE, click 수정 on P03, pick category A, type the reason and click 저장', async () => {
      await openRow(list, s.cycles.CY_CLOSE.id, s.products.P03);
      z = await correctInUi(list, s.products.P03, s.master.categoryName.A, reason);
    });

    await step('Assert: Expected 1 — Toast "승인 요청으로 상신되었습니다. 요율이 변경됩니다." and pill 수정됨 — 미상신', async () => {
      await expect.soft(list.toast(FR_KO['fix.savedDraft']), '[Expected 1] Toast: correction submitted for approval — the rate changed').toBeVisible();
      await expectPills(list, row(), null, FR_KO['state.DRAFT'], '[Expected 1]');
    });

    await step('Act: Step 2 — Tick the P03 row and click 선택 일괄 상신', async () => {
      await submitInUi(list, s.products.P03);
    });

    await step('Assert: Expected 2 — Toast "수정 1건을 승인 요청으로 상신했습니다." and pill 승인 대기', async () => {
      await expect.soft(list.toast(frFormat(FR_KO['msg.submitted'], { n: 1 })), '[Expected 2] Toast: 1 correction submitted for approval').toBeVisible();
      await expectPills(list, row(), null, FR_KO['state.PENDING'], '[Expected 2]');
    });

    await step('Act: Step 3 — Close CY_CLOSE with POST /settlement-cycles/CY_CLOSE/close', async () => {
      closed.status = (await feeReviewApi.closeCycle(s.cycles.CY_CLOSE.id)).status;
      closed.cycle = (await feeReviewApi.cycles()).find((c) => c.cycleId === s.cycles.CY_CLOSE.id)?.status ?? '';
    });

    await step('Assert: Expected 3 — HTTP 200; CY_CLOSE status = CLOSED', async () => {
      expect.soft(closed.status, '[Expected 3] HTTP 200').toBe(200);
      expect.soft(closed.cycle, '[Expected 3] CY_CLOSE status = CLOSED').toBe('CLOSED');
    });

    await step('Act: Step 4 — Reload the screen on CY_CLOSE and read the P03 row', async () => {
      await openRow(list, s.cycles.CY_CLOSE.id, s.products.P03);
    });

    await step('Assert: Expected 4 — No provisional banner; P03 still 승인 대기 with B 9.00% in force', async () => {
      await expect.soft(list.provisionalBanner, '[Expected 4] The provisional banner is gone').toHaveCount(0);
      await expectPills(list, row(), null, FR_KO['state.PENDING'], '[Expected 4]');
      await expect.soft(list.cell(row(), 'category'), '[Expected 4] B in force').toHaveText(startsWith(s.master.categoryName.B));
      await expect.soft(list.cell(row(), 'rate'), '[Expected 4] 9.00% in force').toHaveText(startsWith('9.00%'));
    });

    await stepB('Act: Step 5 — As user B open 변경 승인 → 수수료 규칙, click the P03 record of CY_CLOSE and read 영향 미리보기', async () => {
      caId = await approvalIdOf(targetRef(s, 'P03', 'CY_CLOSE'));
      await openRecord(b.queue, caId, reason);
      await b.queue.impactAnySection.scrollIntoViewIfNeeded();
    });

    await stepB('Assert: Expected 5 — Still pending; the impact names the raised-in cycle (closed) and the applies-from cycle', async () => {
      expect.soft((await db.approval(caId)).approval_status, '[Expected 5] The record is still pending').toBe('PENDING');
      await expect.soft(b.queue.impactAnySection, `[Expected 5] "Raised in ${s.cycles.CY_CLOSE.label}, which has closed; applies from ${s.cycles.CY_NEXT.label}"`).toContainText(
        new RegExp(`Raised in ${esc(s.cycles.CY_CLOSE.label)}.*closed.*applies from ${esc(s.cycles.CY_NEXT.label)}`, 'i'),
      );
    });

    await stepB('Act: Step 6 — Click 승인 and confirm the dialog', async () => {
      await b.queue.approve();
    });

    await stepB('Assert: Expected 6 — Toast 승인되었습니다 shows', async () => {
      await expect(b.queue.approvedToast, '[Expected 6] Toast 승인되었습니다 (Approved)').toBeVisible();
    });

    await step('Act: Step 7 — Read state, effective_from and settlement_cycle_id of Z', async () => {
      correction = z ? await db.correction(z) : (await db.corrections(s.products.P03))[0];
    });

    await step('Assert: Expected 7 — APPROVED, cycle CY_CLOSE, effective_from = first day of CY_NEXT', async () => {
      expect.soft(correction?.state, '[Expected 7] state = APPROVED').toBe('APPROVED');
      expect.soft(num(correction?.settlement_cycle_id), '[Expected 7] settlement_cycle_id = CY_CLOSE').toBe(s.cycles.CY_CLOSE.id);
      expect.soft(day(correction?.effective_from), '[Expected 7] effective_from = first day of CY_NEXT').toBe(s.cycles.CY_NEXT.periodStart);
    });

    await step('Act: Step 8 — As user A reload CY_CLOSE and read the P03 row', async () => {
      await openRow(list, s.cycles.CY_CLOSE.id, s.products.P03);
    });

    await step('Assert: Expected 8 — The closed cycle keeps B (팬클럽 키트) 9.00% in force', async () => {
      await expect.soft(list.cell(row(), 'category'), '[Expected 8] B stays in force').toHaveText(startsWith(s.master.categoryName.B));
      await expect.soft(list.cell(row(), 'rate'), '[Expected 8] 9.00% stays in force').toHaveText(startsWith('9.00%'));
    });
  });

  test('TC_US079_134 — Approval is refused when no later cycle is open', async ({ page, seedData, feeReviewApi, feeReviewPage: list, secondSession }) => {
    test.skip(!hasCredentials('approver'), APPROVER_MISSING);
    const step = makeStep(page);
    await tcMeta('TC_US079_134', 'High', TAGS, `A correction A → B on P14 is saved and submitted in CY_CLOSE; with no OPEN cycle after CY_CLOSE the cycle is closed and user B approves on 변경 승인: the approval is refused with STL-1016 "${FR_KO['errCode.noOpenCycle']}", the record stays pending, the correction stays PENDING with effective_from unchanged and the row still reads 승인 대기 with A 12.50%. The environment check of pre-condition 10 runs in the Arrange and again in Step 3; if a later OPEN cycle exists the test is skipped (the TC asks for a local DB then). Deviation: the "reload" step reopens the screen. ${DEV_REASON} ${DEV_YEAR} ${DATA}`);
    let s!: Seeded;
    let b!: Awaited<ReturnType<typeof secondSession>>;
    let approval!: FeeRuleApprovalPage;
    let reason = '';
    let caId = 0;
    let effectiveFrom = '';
    let check = { later: -1, status: 0, cycle: '' };
    let after: { correction?: RowDataPacket; record?: RowDataPacket } = {};
    const row = () => list.row(s.products.P14);

    await step('Arrange: Pre-condition 1–12 — ROOT (R_A) + ANNEX1 (R_B9); CY_CLOSE open with no later OPEN cycle; P14 resolves A 12.50%', async () => {
      s = await seedData({ tc: 134, private: true, contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }), cycles: ['CY_CLOSE'], products: [product('P14', [{ cycle: 'CY_CLOSE', saleLines: 5 }])] });
      reason = reasonOf('TC_US079_134', '마감 후 승인 확인 — 다음 주기 없음');
      const later = await db.openCyclesAfter(s.cycles.CY_CLOSE.periodEnd);
      test.skip(later.length > 0, `Environment requirement STL-1016: ${later.length} OPEN cycle(s) start after ${s.cycles.CY_CLOSE.periodEnd} on the shared DB — run this TC on a local DB`);
      const listed = await feeReviewApi.row(s.cycles.CY_CLOSE.id, s.products.P14);
      expect(listed.inForceRate, 'Pre-condition: A 12.50 is in force').toContain('12.50');
      b = await secondSession('approver');
      approval = new FeeRuleApprovalPage(b.page, b.queue);
    });
    const stepB = makeStep(b.page);

    await step('Act: Step 1 — Open the screen on CY_CLOSE, click 수정 on P14, pick category B, type the reason and click 저장', async () => {
      await openRow(list, s.cycles.CY_CLOSE.id, s.products.P14);
      await correctInUi(list, s.products.P14, s.master.categoryName.B, reason);
    });

    await step('Assert: Expected 1 — Toast "승인 요청으로 상신되었습니다. 요율이 변경됩니다." and pill 수정됨 — 미상신', async () => {
      await expect.soft(list.toast(FR_KO['fix.savedDraft']), '[Expected 1] Toast: correction submitted for approval — the rate changed').toBeVisible();
      await expectPills(list, row(), null, FR_KO['state.DRAFT'], '[Expected 1]');
    });

    await step('Act: Step 2 — Tick the P14 row and click 선택 일괄 상신', async () => {
      await submitInUi(list, s.products.P14);
    });

    await step('Assert: Expected 2 — Toast "수정 1건을 승인 요청으로 상신했습니다." and pill 승인 대기', async () => {
      await expect.soft(list.toast(frFormat(FR_KO['msg.submitted'], { n: 1 })), '[Expected 2] Toast: 1 correction submitted for approval').toBeVisible();
      await expectPills(list, row(), null, FR_KO['state.PENDING'], '[Expected 2]');
    });

    await step('Act: Step 3 — Run the environment check, then close CY_CLOSE', async () => {
      check.later = (await db.openCyclesAfter(s.cycles.CY_CLOSE.periodEnd)).length;
      effectiveFrom = day((await db.corrections(s.products.P14))[0]?.effective_from);
      check.status = (await feeReviewApi.closeCycle(s.cycles.CY_CLOSE.id)).status;
      check.cycle = (await feeReviewApi.cycles()).find((c) => c.cycleId === s.cycles.CY_CLOSE.id)?.status ?? '';
    });

    await step('Assert: Expected 3 — HTTP 200; CY_CLOSE status = CLOSED', async () => {
      expect.soft(check.later, 'Environment check: no OPEN cycle after CY_CLOSE (0 rows)').toBe(0);
      expect.soft(check.status, '[Expected 3] HTTP 200').toBe(200);
      expect.soft(check.cycle, '[Expected 3] CY_CLOSE status = CLOSED').toBe('CLOSED');
    });

    await stepB('Act: Step 4 — As user B open the P14 record of CY_CLOSE on 변경 승인, click 승인 and confirm', async () => {
      caId = await approvalIdOf(targetRef(s, 'P14', 'CY_CLOSE'));
      await openRecord(b.queue, caId, reason);
      await b.queue.approve();
    });

    await stepB('Assert: Expected 4 — Refused with STL-1016 text; the record stays pending in the queue', async () => {
      await expect.soft(approval.message(FR_KO['errCode.noOpenCycle']), `[Expected 4] STL-1016: ${FR_KO['errCode.noOpenCycle']}`).toBeVisible();
      await expect.soft(b.queue.approvedToast, '[Expected 4] No 승인되었습니다 toast').toHaveCount(0);
      expect.soft((await db.approval(caId)).approval_status, '[Expected 4] The record stays pending').toBe('PENDING');
    });

    await step('Act: Step 5 — Read the correction and the change_approval record of P14 in CY_CLOSE', async () => {
      after = { correction: (await db.corrections(s.products.P14))[0], record: await db.approval(caId) };
    });

    await step('Assert: Expected 5 — Correction PENDING with effective_from unchanged; approval_status PENDING', async () => {
      expect.soft(after.correction?.state, '[Expected 5] state = PENDING').toBe('PENDING');
      expect.soft(day(after.correction?.effective_from), '[Expected 5] effective_from unchanged (no date invented)').toBe(effectiveFrom);
      expect.soft(after.record?.approval_status, '[Expected 5] approval_status = PENDING').toBe('PENDING');
    });

    await step('Act: Step 6 — As user A reload CY_CLOSE and read the P14 row', async () => {
      await openRow(list, s.cycles.CY_CLOSE.id, s.products.P14);
    });

    await step('Assert: Expected 6 — Still 승인 대기 with A 12.50% in force', async () => {
      await expectPills(list, row(), null, FR_KO['state.PENDING'], '[Expected 6]');
      await expect.soft(list.cell(row(), 'category'), '[Expected 6] A in force').toHaveText(startsWith(s.master.categoryName.A));
      await expect.soft(list.cell(row(), 'rate'), '[Expected 6] 12.50% in force').toHaveText(startsWith('12.50%'));
    });
  });

  test('TC_US079_135 — A pending correction is never retired automatically', async ({ page, seedData, feeReviewApi, contractsApi, approverContractsApi, feeReviewPage: list, secondSession }) => {
    const step = makeStep(page);
    const reasonT = reasonOf('TC_US079_135', '유사 계약 요율 적용');
    const reasonX = reasonOf('TC_US079_135', 'Wrong category mapped in commerce');
    await tcMeta('TC_US079_135', 'High', TAGS, `With a pending hand-keyed 6.75% on P10 (no A × ST2 row) and a pending tier-1 A → B on P14, a contract row A × ST2 8.00 is added and approved and commerce moves P14 to B: on two reads P10 shows 8.00% from the contract with 6.75% 직접 입력 proposed and 승인 대기, P14 stays 승인 대기; neither correction is retired (no SYSTEM history, no retire audit). Once user B approves T, P10 reads 8.00% with 자동 해제 — 더 이상 불필요. Deviation: Step 6 approves CA_T on 변경 승인 (UI) instead of the API call so the toast of Expected 6 can be observed. ${DEV_REASON} ${DEV_YEAR} ${DATA}`);
    let s!: Seeded;
    let b!: Awaited<ReturnType<typeof secondSession>>;
    let t = '';
    let x = '';
    let caT = 0;
    let addRes = { status: 0, newRowId: 0, changeApprovalId: 0 };
    let approveStatus = 0;
    let updated = 0;
    let after: { corrections: RowDataPacket[]; system: RowDataPacket[]; audit: RowDataPacket[] } = { corrections: [], system: [], audit: [] };
    const obs = new Observations(page);
    const prefix = () => `T079-${s.run}-135-`;

    await step('Arrange: Pre-condition 1–14 — ROOT (R_A) + ANNEX1 (R_B9); P10 (A × ST2, no row) and P14; T (6.75 hand-keyed) and X (A → B) both pending', async () => {
      s = await seedData({ tc: 135, private: true, contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P10', [{ cycle: 'CY_MAIN', saleLines: 5 }]), product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      ({ id: t } = await saveCorrection(feeReviewApi, s, 'P10', tier2('6.75', reasonT)));
      ({ id: x } = await saveCorrection(feeReviewApi, s, 'P14', tier1(s, 'B', reasonX)));
      await submitIds(feeReviewApi, [t, x]);
      caT = await approvalIdOf(targetRef(s, 'P10'));
      await approvalIdOf(targetRef(s, 'P14'));
      expect((await contractsApi.feeRows(s.family.contracts.ROOT)).some((r) => r.saleTypeId === s.master.saleType.ST2), 'Pre-condition: C_ROOT has no ST2 row').toBe(false);
      b = await secondSession('approver');
    });
    const stepB = makeStep(b.page);

    await step('Act: Step 1 — As user A add fee row A × ST2 NORMAL 8.00 to C_ROOT', async () => {
      const res = await addRow(contractsApi, s, 'ROOT', { category: 'A', saleType: 'ST2' }, 8, '2020-01-01', `[T079-${s.run}-135] R_A8`);
      addRes = { status: res.status, newRowId: num(res.body?.newRowId ?? res.body?.id), changeApprovalId: num(res.body?.changeApprovalId) };
    });

    await step('Assert: Expected 1 — HTTP 201; the new row is pending approval', async () => {
      expect.soft(addRes.status, '[Expected 1] HTTP 201').toBe(201);
      expect.soft(addRes.changeApprovalId, '[Expected 1] The new row is pending approval (a change approval id is returned)').toBeGreaterThan(0);
    });

    await step('Act: Step 2 — As user B approve CA_ROW', async () => {
      approveStatus = (await approverContractsApi.approve(addRes.changeApprovalId)).status;
    });

    await step('Assert: Expected 2 — The fee row is approved; C_ROOT lists A × ST2 NORMAL 8.00 ACTIVE', async () => {
      expect.soft(approveStatus, '[Expected 2] The fee row is approved (HTTP 200)').toBe(200);
      const rows = await contractsApi.feeRows(s.family.contracts.ROOT);
      const added = rows.find((r) => r.categoryId === s.master.category.A && r.saleTypeId === s.master.saleType.ST2 && r.policy === 'NORMAL');
      expect.soft(Number(added?.commission), '[Expected 2] A × ST2 NORMAL row at 8.00').toBe(8);
      expect.soft(added?.status, '[Expected 2] The row is ACTIVE').toBe('ACTIVE');
    });

    await step('Act: Step 3 — UPDATE P14 to category B / slot R_B9', async () => {
      updated = await db.setProduct(s.products.P14, { categoryId: s.master.category.B, defaultSlot: s.family.rows.R_B9 });
    });

    await step('Assert: Expected 3 — 1 row updated', async () => {
      expect(updated, '[Expected 3] 1 row updated').toBe(1);
    });

    await step('Act: Step 4 — Open CY_MAIN, chip 기간 내 판매 상품, read P10 and P14, then reload once more', async () => {
      for (const read of [1, 2]) {
        await openRow(list, s.cycles.CY_MAIN.id, prefix());
        const p10 = list.row(s.products.P10);
        const p14 = list.row(s.products.P14);
        const rate = list.cell(p10, 'rate');
        await obs.record(`[Expected 4] Read ${read}: P10 reads 8.00% from the contract`, async () => startsWith('8.00%').test((await rate.textContent()) ?? ''));
        await obs.record(`[Expected 4] Read ${read}: P10 shows 6.75% proposed beneath`, async () => ((await list.secondLine(rate).textContent()) ?? '').includes('6.75%'));
        await obs.record(`[Expected 4] Read ${read}: P10 proposal is marked 직접 입력 (Hand-keyed)`, async () => ((await rate.textContent()) ?? '').includes(FR_KO['lbl.handKeyed']));
        await obs.record(`[Expected 4] Read ${read}: P10 second pill 승인 대기`, async () => ((await list.statusPills(p10).nth(1).textContent()) ?? '').trim() === FR_KO['state.PENDING']);
        await obs.record(`[Expected 4] Read ${read}: P14 second pill 승인 대기`, async () => ((await list.statusPills(p14).nth(1).textContent()) ?? '').trim() === FR_KO['state.PENDING']);
        if (read === 1) await obs.screenshot('Act: Step 4 — first read');
      }
    });

    await step('Assert: Expected 4 — On both reads P10 reads 8.00% with 6.75% 직접 입력 proposed and 승인 대기; P14 stays 승인 대기', async () => {
      obs.assertAll();
    });

    await step('Act: Step 5 — Read T and X, their SYSTEM history rows and fee_correction.retire audit rows', async () => {
      after = {
        corrections: await feeReviewDb.query<RowDataPacket[]>('SELECT id, state, retired_at FROM fee_correction WHERE id IN (?)', [[t, x]]),
        system: await feeReviewDb.query<RowDataPacket[]>("SELECT * FROM fee_correction_history WHERE correction_id IN (?) AND who = 'SYSTEM'", [[t, x]]),
        audit: await feeReviewDb.query<RowDataPacket[]>("SELECT * FROM audit_log WHERE action = 'fee_correction.retire' AND entity_id IN (?)", [[t, x]]),
      };
    });

    await step('Assert: Expected 5 — T and X PENDING with no retired_at; no SYSTEM history; no retire audit', async () => {
      for (const id of [t, x]) {
        const c = after.corrections.find((r) => String(r.id) === id);
        expect.soft(c?.state, `[Expected 5] ${id === t ? 'T' : 'X'} state = PENDING`).toBe('PENDING');
        expect.soft(c?.retired_at ?? null, `[Expected 5] ${id === t ? 'T' : 'X'} retired_at = NULL`).toBeNull();
      }
      expect.soft(after.system.length, '[Expected 5] No SYSTEM history row').toBe(0);
      expect.soft(after.audit.length, '[Expected 5] No fee_correction.retire audit row').toBe(0);
    });

    await stepB('Act: Step 6 — As user B approve the P10 Fee Rule record CA_T', async () => {
      await openRecord(b.queue, caT, reasonT);
      await b.queue.approve();
    });

    await stepB('Assert: Expected 6 — Toast 승인되었습니다 shows', async () => {
      await expect(b.queue.approvedToast, '[Expected 6] Toast 승인되었습니다 (Approved)').toBeVisible();
    });

    await step('Act: Step 7 — As user A reload the list and read the P10 row', async () => {
      await openRow(list, s.cycles.CY_MAIN.id, s.products.P10);
    });

    await step('Assert: Expected 7 — P10 reads 8.00% from the contract with 자동 해제 — 더 이상 불필요', async () => {
      const p10 = list.row(s.products.P10);
      await expect.soft(list.cell(p10, 'rate'), '[Expected 7] P10 reads 8.00% from the contract').toHaveText(startsWith('8.00%'));
      await expectPills(list, p10, null, FR_KO['state.RETIRED'], '[Expected 7]');
    });
  });

  test('TC_US079_136 — A contract change while pending refreshes the value in force and keeps the requested value', async ({ page, seedData, feeReviewApi, contractsApi, approverContractsApi, feeReviewPage: list, secondSession }) => {
    const step = makeStep(page);
    const reason = reasonOf('TC_US079_136', 'Wrong category mapped in commerce');
    await tcMeta('TC_US079_136', 'Medium', TAGS, `While the P14 correction A → B is pending, a contract row A × ST1 13.00 effective from the 15th of CY_MAIN is added and approved: the row shows A 13.00% in force (refreshed) with B 9.00% still proposed and 승인 대기; 근거 shows 13.00% from R_A2; the queue's 직전 승인 값 reads A 13.00% and 제안 값 B 9.00%; requested value and the correction stay B 9.00 PENDING. Expected to FAIL (TC build note DEV-41a): the record keeps the value captured at save, so 직전 승인 값 may read 12.50%. ${DEV_PREV} Not automated: "for the whole cycle" beyond the winning row — the fixture has one resolution date (the cycle's last day). ${DEV_REASON} ${DEV_YEAR} ${DATA}`);
    let s!: Seeded;
    let b!: Awaited<ReturnType<typeof secondSession>>;
    let ca1 = 0;
    let x = '';
    let addRes = { status: 0, newRowId: 0, changeApprovalId: 0 };
    let approveStatus = 0;
    let after: { record?: RowDataPacket; correction?: RowDataPacket } = {};
    const row = () => list.row(s.products.P14);

    await step('Arrange: Pre-condition 1–13 — ROOT (R_A) + ANNEX1 (R_B9); P14 with a pending tier-1 correction A → B', async () => {
      s = await seedData({ tc: 136, private: true, contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      ({ id: x, approvalId: ca1 } = await pendingCorrection(feeReviewApi, s, 'P14', tier1(s, 'B', reason)));
      const rows = await contractsApi.feeRows(s.family.contracts.ROOT);
      expect(rows.filter((r) => r.categoryId === s.master.category.A && r.saleTypeId === s.master.saleType.ST1).length, 'Pre-condition: only R_A on A × ST1').toBe(1);
      b = await secondSession('approver');
    });
    const stepB = makeStep(b.page);

    await step('Act: Step 1 — As user A add fee row A × ST1 NORMAL 13.00 effective from the 15th of CY_MAIN', async () => {
      const res = await addRow(contractsApi, s, 'ROOT', { category: 'A', saleType: 'ST1' }, 13, `${s.cycles.CY_MAIN.label}-15`, `[T079-${s.run}-136] R_A2`);
      addRes = { status: res.status, newRowId: num(res.body?.newRowId ?? res.body?.id), changeApprovalId: num(res.body?.changeApprovalId) };
    });

    await step('Assert: Expected 1 — HTTP 201; the new row is pending approval', async () => {
      expect.soft(addRes.status, '[Expected 1] HTTP 201').toBe(201);
      expect.soft(addRes.changeApprovalId, '[Expected 1] The new row is pending approval').toBeGreaterThan(0);
    });

    await step('Act: Step 2 — As user B approve CA_ROW', async () => {
      approveStatus = (await approverContractsApi.approve(addRes.changeApprovalId)).status;
    });

    await step('Assert: Expected 2 — The fee row is approved and R_A2 is ACTIVE', async () => {
      expect.soft(approveStatus, '[Expected 2] The fee row is approved (HTTP 200)').toBe(200);
      const added = (await contractsApi.feeRows(s.family.contracts.ROOT)).find((r) => r.categoryId === s.master.category.A && Number(r.commission) === 13);
      expect.soft(added?.status, '[Expected 2] R_A2 is ACTIVE').toBe('ACTIVE');
    });

    await step('Act: Step 3 — As user A open CY_MAIN and read the P14 row', async () => {
      await openRow(list, s.cycles.CY_MAIN.id, s.products.P14);
    });

    await step('Assert: Expected 3 — A (음반) 13.00% in force as the main line, B 9.00% proposed beneath, pill 승인 대기', async () => {
      await expectLines(list, row(), 'category', s.master.categoryName.A, s.master.categoryName.B, '[Expected 3]');
      await expectLines(list, row(), 'rate', '13.00%', '9.00%', '[Expected 3]');
      await expectPills(list, row(), null, FR_KO['state.PENDING'], '[Expected 3]');
    });

    await step('Act: Step 4 — Click 근거 (Basis) on the P14 row', async () => {
      await list.openBasis(row());
      await list.basis.expandEvidence();
    });

    await step('Assert: Expected 4 — The panel shows 13.00% from R_A2', async () => {
      const extras = new FeeReviewRowExtras(page, list);
      await expect.soft(list.basis.headlineRate, '[Expected 4] 13.00% in force').toHaveText('13.00%');
      await expect.soft(extras.basisSource('trace.fromContract'), '[Expected 4] From a contract row').toBeVisible();
      await expect.soft(list.basis.candidateRows.filter({ hasText: '13.00%' }), '[Expected 4] R_A2 (13.00%) is the winning row').toHaveText([/^\s*적용/]);
    });

    await stepB('Act: Step 5 — As user B open 변경 승인 → 수수료 규칙 and click the P14 record', async () => {
      await openRecord(b.queue, ca1, reason);
    });

    await stepB('Assert: Expected 5 — 직전 승인 값 = A (음반) 13.00%; 제안 값 = B (팬클럽 키트) 9.00%', async () => {
      await expect.soft(b.queue.panelValue(Q_PREV), `[Expected 5] ${Q_PREV}: category A`).toContainText(s.master.categoryName.A);
      await expect.soft(b.queue.panelValue(Q_PREV), `[Expected 5] ${Q_PREV}: 13.00% (refreshed)`).toContainText('13.00');
      await expect.soft(b.queue.panelValue(Q_PROPOSED), `[Expected 5] ${Q_PROPOSED}: category B`).toContainText(`→ ${s.master.categoryName.B}`);
      await expect.soft(b.queue.panelValue(Q_PROPOSED), `[Expected 5] ${Q_PROPOSED}: 9.00%`).toContainText('→ 9.00');
    });

    await step('Act: Step 6 — Read change_approval CA1 and fee_correction X', async () => {
      after = { record: await db.approval(ca1), correction: await db.correction(x) };
    });

    await step('Assert: Expected 6 — requested B 9.00, PENDING; X category B, rate_after 9.00, PENDING', async () => {
      expect.soft(json(after.record?.requested_value).categoryName, '[Expected 6] requested_value category B').toBe(s.master.categoryName.B);
      expect.soft(json(after.record?.requested_value).rate, '[Expected 6] requested_value rate "9.00"').toBe('9.00');
      expect.soft(after.record?.approval_status, '[Expected 6] approval_status = PENDING').toBe('PENDING');
      expect.soft(num(after.correction?.category_id), '[Expected 6] X category B').toBe(s.master.category.B);
      expect.soft(Number(after.correction?.rate_after), '[Expected 6] X rate_after 9.00').toBe(9);
      expect.soft(after.correction?.state, '[Expected 6] X state = PENDING').toBe('PENDING');
    });
  });

  test('TC_US079_137 — A pending correction does not block closing the cycle', async ({ page, seedData, feeReviewApi, feeReviewPage: list, secondSession }) => {
    test.skip(!hasCredentials('approver'), APPROVER_MISSING);
    const step = makeStep(page);
    const reason = reasonOf('TC_US079_137', 'Wrong category mapped in commerce');
    await tcMeta('TC_US079_137', 'Medium', TAGS, `With correction Z (P03 B → A) pending in CY_CLOSE, closing CY_CLOSE succeeds (HTTP 200, CLOSED); the screen on CY_CLOSE shows no provisional banner, the label "마감된 기간 — 요율이 확정·스탬프되었습니다" and P03 still 승인 대기; on 변경 승인 the P03 record is still pending with 승인 enabled. ${DEV_REASON} ${DEV_YEAR} ${DATA}`);
    let s!: Seeded;
    let b!: Awaited<ReturnType<typeof secondSession>>;
    let approval!: FeeRuleApprovalPage;
    let z = '';
    let caz = 0;
    let state = '';
    let closeStatus = 0;
    let cycleStatus = '';

    await step('Arrange: Pre-condition 1–14 — ROOT (R_A, R_B10) + ANNEX1 (R_B9); CY_CLOSE open; P03 correction Z (B → A) pending', async () => {
      s = await seedData({ tc: 137, private: true, contracts: family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9'] }), cycles: ['CY_CLOSE'], products: [product('P03', [{ cycle: 'CY_CLOSE', saleLines: 10 }])] });
      ({ id: z, approvalId: caz } = await pendingCorrection(feeReviewApi, s, 'P03', tier1(s, 'A', reason), 'CY_CLOSE'));
      b = await secondSession('approver');
      approval = new FeeRuleApprovalPage(b.page, b.queue);
    });
    const stepB = makeStep(b.page);

    await step('Act: Step 1 — Read the state of Z', async () => {
      state = (await db.correction(z)).state;
    });

    await step('Assert: Expected 1 — PENDING', async () => {
      expect(state, '[Expected 1] Z is PENDING').toBe('PENDING');
    });

    await step('Act: Step 2 — Call POST /settlement-cycles/CY_CLOSE/close', async () => {
      closeStatus = (await feeReviewApi.closeCycle(s.cycles.CY_CLOSE.id)).status;
    });

    await step('Assert: Expected 2 — HTTP 200 — the close is not blocked by the pending correction', async () => {
      expect(closeStatus, '[Expected 2] HTTP 200').toBe(200);
    });

    await step('Act: Step 3 — Call GET /settlement-cycles and read CY_CLOSE', async () => {
      cycleStatus = (await feeReviewApi.cycles()).find((c) => c.cycleId === s.cycles.CY_CLOSE.id)?.status ?? '';
    });

    await step('Assert: Expected 3 — CY_CLOSE status = CLOSED', async () => {
      expect(cycleStatus, '[Expected 3] CY_CLOSE status = CLOSED').toBe('CLOSED');
    });

    await step('Act: Step 4 — Open the fee review screen and select CY_CLOSE', async () => {
      await openRow(list, s.cycles.CY_CLOSE.id, s.products.P03);
    });

    await step('Assert: Expected 4 — No provisional banner, the closed-period label, P03 still 승인 대기', async () => {
      await expect.soft(list.provisionalBanner, '[Expected 4] The provisional banner is gone').toHaveCount(0);
      await expect.soft(list.resolvedAtLabel, '[Expected 4] Label 마감된 기간 — 요율이 확정·스탬프되었습니다').toHaveText('마감된 기간 — 요율이 확정·스탬프되었습니다');
      await expectPills(list, list.row(s.products.P03), null, FR_KO['state.PENDING'], '[Expected 4]');
    });

    await stepB('Act: Step 5 — As user B open 변경 승인 with 원장 = 수수료 규칙', async () => {
      await openRecord(b.queue, caz, reason);
    });

    await stepB('Assert: Expected 5 — The P03 record of CY_CLOSE is still listed as pending and 승인 is enabled', async () => {
      await expect.soft(approval.item(s.products.P03), '[Expected 5] The P03 record is listed').toHaveCount(1);
      await expect.soft(approval.item(s.products.P03), '[Expected 5] The record is still pending').toContainText(FR_KO['state.PENDING']);
      await expect.soft(b.queue.approveButton, '[Expected 5] 승인 (Approve) is enabled').toBeEnabled();
    });
  });

  test('TC_US079_138 — Fee rule records leave the other three register types unchanged', async ({ page, seedData, feeReviewApi, contractsApi, approvalQueuePage: queue }) => {
    test.skip(!hasCredentials('approver'), APPROVER_MISSING);
    const step = makeStep(page);
    const approval = new FeeRuleApprovalPage(page, queue);
    const reason = reasonOf('TC_US079_138', 'Wrong category mapped in commerce');
    await tcMeta('TC_US079_138', 'Medium', TAGS, `With a pending Fee Rule record (P14) and a pending Fee Rate record (new row R_D on C_ROOT), each 원장 filter (수수료율, 환율 원장, 쿠폰 분담 관리, 수수료 규칙) lists only its own records and opens its own detail with decision buttons; approving R_D on 수수료율 activates R_D and leaves the Fee Rule record PENDING. Deviation: no FX Rate record is created (the framework has no FX API client and an FX submission cannot be cleaned from the shared dev) — like the Coupon Burden step, an existing pending FX record is used; when a register has no pending record the step checks the filter only and notes it. ${DEV_PREV} ${DEV_REASON} ${DEV_YEAR} ${DATA}`);
    let s!: Seeded;
    let ca1 = 0;
    let caRow = 0;
    let rowId = 0;
    const rowReason = () => `[T079-${s.run}-138] R_D`;
    const seen: Record<string, { texts: string[]; opened: boolean }> = {};
    let after: { status?: string; record?: RowDataPacket } = {};

    /** Lọc 원장 và mở dòng đầu tiên (nếu có) — register không thuộc test, chỉ đọc. */
    const browse = async (label: string): Promise<void> => {
      await approval.selectRegister(label);
      const texts = await approval.itemTexts();
      if (texts.length) {
        await queue.queueItems.first().click();
        await expect(queue.changeSummaryHeading, `The ${label} detail panel opens`).toBeVisible();
      }
      seen[label] = { texts, opened: texts.length > 0 };
    };
    const assertBrowsed = async (label: string, n: number): Promise<void> => {
      const { texts, opened } = seen[label];
      if (!opened) {
        test.info().annotations.push({ type: 'Not automated', description: `[Expected ${n}] No pending ${label} record exists on the environment — only the filter was checked.` });
        return;
      }
      expect.soft(texts.filter((t) => !t.startsWith(label)), `[Expected ${n}] Only ${label} records are listed`).toEqual([]);
      await expect.soft(queue.panelValue('원장'), `[Expected ${n}] The detail shows its own register ${label}`).toHaveText(label);
      await expect.soft(queue.approveButton, `[Expected ${n}] 승인 (Approve) is offered`).toBeVisible();
      await expect.soft(queue.rejectButton, `[Expected ${n}] 반려… (Reject…) is offered`).toBeVisible();
    };

    await step('Arrange: Pre-condition 1–16 — Pending Fee Rule record on P14 and pending Fee Rate row R_D on C_ROOT; user B on 변경 승인', async () => {
      s = await seedData({ tc: 138, private: true, contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      ({ approvalId: ca1 } = await pendingCorrection(feeReviewApi, s, 'P14', tier1(s, 'B', reason)));
      const res = await addRow(contractsApi, s, 'ROOT', { category: 'D', saleType: 'ST1' }, 12.5, '2020-01-01', rowReason());
      expect(res.status, 'Pre-condition: R_D is added (HTTP 201)').toBe(201);
      rowId = num(res.body?.newRowId ?? res.body?.id);
      caRow = num(res.body?.changeApprovalId);
      expect(caRow, 'Pre-condition: R_D awaits approval').toBeGreaterThan(0);
      await switchAccount(page, 'approver');
    });

    await step('Act: Step 1 — Set 원장 = 수수료율 (Fee Rate) and click the R_D record', async () => {
      await queue.openRequest({ register: '수수료율', requester: getAccountDisplayName('submitter'), changeApprovalId: caRow, reason: rowReason() });
      seen['수수료율'] = { texts: await approval.itemTexts(), opened: true };
    });

    await step('Assert: Expected 1 — Only Fee Rate records, no T079 Fee Rule record; R_D shows its own fields with 승인 / 반려… enabled', async () => {
      const texts = seen['수수료율'].texts;
      expect.soft(texts.filter((t) => !t.startsWith('수수료율')), '[Expected 1] Only Fee Rate records are listed').toEqual([]);
      expect.soft(texts.filter((t) => t.includes(`T079-${s.run}-138-`)), '[Expected 1] No T079 Fee Rule record appears').toEqual([]);
      await expect.soft(queue.panelValue(Q_PREV), `[Expected 1] ${Q_PREV} = — (신규 수수료 행)`).toHaveText('— (신규 수수료 행)');
      await expect.soft(queue.approveButton, '[Expected 1] 승인 (Approve) is enabled').toBeEnabled();
      await expect.soft(queue.rejectButton, '[Expected 1] 반려… (Reject…) is enabled').toBeEnabled();
    });

    await step('Act: Step 2 — Set 원장 = 환율 원장 (FX Rate) and click a pending record', async () => {
      await browse('환율 원장');
    });

    await step('Assert: Expected 2 — Only FX Rate records; the detail opens with its own fields and decision buttons', async () => {
      await assertBrowsed('환율 원장', 2);
    });

    await step('Act: Step 3 — Set 원장 = 쿠폰 분담 관리 (Coupon Burden) and click a pending record', async () => {
      await browse('쿠폰 분담 관리');
    });

    await step('Assert: Expected 3 — Only Coupon Burden records; the detail opens with its own fields and decision buttons', async () => {
      await assertBrowsed('쿠폰 분담 관리', 3);
    });

    await step('Act: Step 4 — Set 원장 = 수수료 규칙 (Fee Rule)', async () => {
      await queue.showRegister(REGISTER);
      seen['수수료 규칙'] = { texts: await approval.itemTexts(), opened: false };
    });

    await step('Assert: Expected 4 — Only Fee Rule records, including the P14 record', async () => {
      expect.soft(seen['수수료 규칙'].texts.filter((t) => !t.startsWith('수수료 규칙')), '[Expected 4] Only Fee Rule records are listed').toEqual([]);
      await expect.soft(approval.item(s.products.P14), '[Expected 4] The P14 record is listed').toHaveCount(1);
    });

    await step('Act: Step 5 — Set 원장 = 수수료율, open the R_D record, click 승인 and confirm', async () => {
      await queue.openRequest({ register: '수수료율', requester: getAccountDisplayName('submitter'), changeApprovalId: caRow, reason: rowReason() });
      await queue.approve();
    });

    await step('Assert: Expected 5 — Toast 승인되었습니다 shows', async () => {
      await expect(queue.approvedToast, '[Expected 5] Toast 승인되었습니다 (Approved)').toBeVisible();
    });

    await step('Act: Step 6 — Read the C_ROOT fee rows and change_approval CA1', async () => {
      after = { status: (await contractsApi.feeRows(s.family.contracts.ROOT)).find((r) => r.id === rowId || (r.categoryId === s.master.category.D && Number(r.commission) === 12.5))?.status, record: await db.approval(ca1) };
    });

    await step('Assert: Expected 6 — R_D is ACTIVE; CA1 is still PENDING', async () => {
      expect.soft(after.status, '[Expected 6] R_D is ACTIVE').toBe('ACTIVE');
      expect.soft(after.record?.approval_status, '[Expected 6] CA1 is still PENDING').toBe('PENDING');
    });
  });

  test('TC_US079_139 — The approver can clear a correction left pending by a submitter who left', async ({ page, seedData, feeReviewApi, approverFeeReviewApi, feeReviewPage: list, approvalQueuePage: queue }) => {
    const step = makeStep(page);
    const approval = new FeeRuleApprovalPage(page, queue);
    const extras = new FeeReviewRowExtras(page, list);
    const reason = reasonOf('TC_US079_139', 'Wrong category mapped in commerce');
    const rejectText = '기안자 퇴사로 더 이상 담당하지 않음 — 필요 시 다른 담당자가 다시 올려 주세요';
    await tcMeta('TC_US079_139', 'Low', TAGS, `User A (treated as gone) left correction X on P14 pending: user B cannot withdraw it (HTTP 403 STL-1013, X stays pending) but can reject it on 변경 승인 (기안자 = user A, buttons enabled, toast, record leaves the list); the row then reads 반려됨 — 수정 후 재상신, 변경 이력 shows the 반려 사유 block with user B and X is REJECTED with pending_key NULL. Deviation: no read-only account (user R) exists — Steps 4–5 are read as user B. Not automated: "수정 / 회수 are not rendered for the read grant" (needs the read-only account) and the STL-1013 message text (FE locale text; a direct API call returns the code). ${DEV_REASON} ${DEV_YEAR} ${DATA}`);
    let s!: Seeded;
    let x = '';
    let ca1 = 0;
    let withdraw = { status: 0, body: '' };
    let after!: RowDataPacket;
    const row = () => list.row(s.products.P14);

    await step('Arrange: Pre-condition 1–14 — P14 with a correction X pending, submitted by user A; user B on 변경 승인', async () => {
      s = await seedData({ tc: 139, contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      ({ id: x, approvalId: ca1 } = await pendingCorrection(feeReviewApi, s, 'P14', tier1(s, 'B', reason)));
      expect((await db.correction(x)).submitted_by, 'Pre-condition: X submitted by user A').toBe(getAccountDisplayName('submitter'));
      await switchAccount(page, 'approver');
    });

    await step('Act: Step 1 — As user B call POST /fee-review/corrections/X/withdraw', async () => {
      const res = await approverFeeReviewApi.withdraw(x);
      withdraw = { status: res.status, body: JSON.stringify(res.body) };
    });

    await step('Assert: Expected 1 — HTTP 403 STL-1013; X stays pending', async () => {
      expect.soft(withdraw.status, '[Expected 1] HTTP 403').toBe(403);
      expect.soft(withdraw.body, '[Expected 1] Error code STL-1013').toContain('STL-1013');
      expect.soft((await db.correction(x)).state, '[Expected 1] X stays pending').toBe('PENDING');
    });

    await step('Act: Step 2 — Open 변경 승인, set 원장 = 수수료 규칙 and click the P14 record', async () => {
      await openRecord(queue, ca1, reason);
    });

    await step('Assert: Expected 2 — 기안자 = user A with 승인 and 반려… enabled for user B', async () => {
      await expect.soft(queue.panelValue('기안자'), '[Expected 2] 기안자 (Maker) = user A').toHaveText(getAccountDisplayName('submitter'));
      await expect.soft(queue.approveButton, '[Expected 2] 승인 (Approve) is enabled').toBeEnabled();
      await expect.soft(queue.rejectButton, '[Expected 2] 반려… (Reject…) is enabled').toBeEnabled();
    });

    await step('Act: Step 3 — Click 반려…, type the reason and click 반려 확정', async () => {
      await queue.openRejectDialog();
      await queue.confirmReject(rejectText);
    });

    await step('Assert: Expected 3 — Toast 반려되었습니다 and the record leaves the pending list', async () => {
      await expect.soft(queue.rejectedToast, '[Expected 3] Toast 반려되었습니다 (Rejected)').toBeVisible();
      await expect.soft(approval.item(s.products.P14), '[Expected 3] The record leaves the pending list').toHaveCount(0);
    });

    await step('Act: Step 4 — Open the fee review screen on CY_MAIN and read the P14 row', async () => {
      await openRow(list, s.cycles.CY_MAIN.id, s.products.P14);
    });

    await step('Assert: Expected 4 — The P14 row reads 반려됨 — 수정 후 재상신', async () => {
      await expectPills(list, row(), null, FR_KO['state.REJECTED'], '[Expected 4]');
    });

    await step('Act: Step 5 — Click 이력 (History) on the P14 row', async () => {
      await list.openHistory(row());
    });

    await step('Assert: Expected 5 — 변경 이력 shows the approver reason in its own 반려 사유 block with user B', async () => {
      const entry = list.history.rows.filter({ hasText: reason }).first();
      await expect.soft(extras.historyRejectBlock(entry), '[Expected 5] 반려 사유 block holds the approver reason').toContainText(rejectText);
      await expect.soft(extras.historyRejectBlock(entry), '[Expected 5] 반려 사유 block names user B').toContainText(getAccountDisplayName('approver'));
    });

    await step('Act: Step 6 — Read state, pending_key and rejection_reason of X', async () => {
      after = await db.correction(x);
    });

    await step('Assert: Expected 6 — REJECTED, pending_key NULL, rejection_reason = the text of Step 3', async () => {
      expect.soft(after.state, '[Expected 6] state = REJECTED').toBe('REJECTED');
      expect.soft(after.pending_key ?? null, '[Expected 6] pending_key = NULL (the product is free for a new correction)').toBeNull();
      expect.soft(after.rejection_reason, '[Expected 6] rejection_reason = the text of Step 3').toBe(rejectText);
    });
  });

  test('TC_US079_140 — A rejection notifies the submitter and an approval sends no notification', async () => {
    await skipTc(
      'TC_US079_140',
      'Medium',
      TAGS,
      'Approving the P14 record sends user A no notification; rejecting the P03 record sends user A one Change Request Rejected notification.',
      'Needs US092 notification delivery (notification bell / list, type Change Request Rejected) — not built on this environment (TC pre-condition 14: "not producible on this build"), so the notification checks of Expected 2 and 4 cannot be observed.',
    );
  });

  test('TC_US079_141 — Every save, submit, withdrawal, retirement and decision leaves an audit entry', async ({ page, seedData, feeReviewApi, feeReviewPage: list, secondSession }) => {
    test.skip(!hasCredentials('approver'), APPROVER_MISSING);
    const step = makeStep(page);
    const reasonP14 = reasonOf('TC_US079_141', '감사 로그 확인용 정정');
    const reasonP03 = reasonOf('TC_US079_141', 'Wrong category mapped in commerce');
    const rejectText = 'Wrong category — re-check the annex';
    await tcMeta('TC_US079_141', 'High', TAGS, `Save, submit, withdraw, resubmit, approve, retirement (two reads) on P14 and submit + reject on P03 each leave one audit_log entry, in order, with actor and time: fee_correction.save / submit (A), change_approval.withdraw (A), fee_correction.submit (A), change_approval.approve (B), fee_correction.retire (SYSTEM, exactly one), fee_correction.submit (A, P03), change_approval.reject (B). Deviation: on the shared DB the audit query is narrowed to the entity ids of this TC's corrections and approval records, and "TC start time" is the audit_log id high-water mark taken after the setup. ${DEV_REASON} ${DEV_YEAR} ${DATA}`);
    let s!: Seeded;
    let b!: Awaited<ReturnType<typeof secondSession>>;
    let mark = 0;
    let rows: RowDataPacket[] = [];
    const obs = new Observations(page);
    const prefix = () => `T079-${s.run}-141-`;
    const p14 = () => list.row(s.products.P14);

    await step('Arrange: Pre-condition 1–13 — ROOT (R_A, R_B10) + ANNEX1 (R_B9); P14 resolved A 12.50%, P03 with a draft Y (B → A); audit start noted', async () => {
      s = await seedData({ tc: 141, contracts: family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }]), product('P03', [{ cycle: 'CY_MAIN', saleLines: 10 }])] });
      await saveCorrection(feeReviewApi, s, 'P03', tier1(s, 'A', reasonP03));
      expect((await feeReviewApi.row(s.cycles.CY_MAIN.id, s.products.P14)).correction ?? null, 'Pre-condition: P14 has no correction').toBeNull();
      mark = await db.auditMark();
      b = await secondSession('approver');
    });
    const stepB = makeStep(b.page);

    await step('Act: Step 1 — Open CY_MAIN, click 수정 on P14, pick category B, type the reason and click 저장', async () => {
      await openRow(list, s.cycles.CY_MAIN.id, prefix());
      await correctInUi(list, s.products.P14, s.master.categoryName.B, reasonP14);
    });

    await step('Assert: Expected 1 — Toast "승인 요청으로 상신되었습니다. 요율이 변경됩니다." shows', async () => {
      await expect(list.toast(FR_KO['fix.savedDraft']), '[Expected 1] Toast: correction submitted for approval — the rate changed').toBeVisible();
    });

    await step('Act: Step 2 — Tick P14 and click 선택 일괄 상신', async () => {
      await submitInUi(list, s.products.P14);
    });

    await step('Assert: Expected 2 — The P14 pill reads 승인 대기', async () => {
      await expectPills(list, p14(), null, FR_KO['state.PENDING'], '[Expected 2]');
    });

    await step('Act: Step 3 — Click 회수 (Withdraw) on P14 and confirm 회수', async () => {
      await list.openWithdraw(p14());
      await list.withdraw.confirm();
    });

    await step('Assert: Expected 3 — Toast "수정 건을 회수했습니다. …" shows', async () => {
      await expect(list.toast(FR_KO['withdraw.done']), '[Expected 3] Toast: correction withdrawn').toBeVisible();
    });

    await step('Act: Step 4 — Tick P14 and click 선택 일괄 상신 again', async () => {
      await submitInUi(list, s.products.P14);
    });

    await step('Assert: Expected 4 — The P14 pill reads 승인 대기', async () => {
      await expectPills(list, p14(), null, FR_KO['state.PENDING'], '[Expected 4]');
    });

    await stepB('Act: Step 5 — As user B approve the P14 Fee Rule record on 변경 승인', async () => {
      await openRecord(b.queue, await approvalIdOf(targetRef(s, 'P14')), reasonP14);
      await b.queue.approve();
    });

    await stepB('Assert: Expected 5 — Toast 승인되었습니다 shows', async () => {
      await expect(b.queue.approvedToast, '[Expected 5] Toast 승인되었습니다 (Approved)').toBeVisible();
    });

    await step('Act: Step 6 — UPDATE P14 to category B / slot R_B9, then reload the list twice', async () => {
      expect(await db.setProduct(s.products.P14, { categoryId: s.master.category.B, defaultSlot: s.family.rows.R_B9 }), 'One fixture row updated').toBe(1);
      for (const read of [1, 2]) {
        await openRow(list, s.cycles.CY_MAIN.id, prefix());
        await obs.record(`[Expected 6] Read ${read}: P14 pill reads 자동 해제 — 더 이상 불필요`, async () => ((await list.statusPills(p14()).nth(1).textContent()) ?? '').trim() === FR_KO['state.RETIRED']);
        if (read === 1) await obs.screenshot('Act: Step 6 — first read');
      }
    });

    await step('Assert: Expected 6 — The P14 pill reads 자동 해제 — 더 이상 불필요 on both reads', async () => {
      obs.assertAll();
    });

    await step('Act: Step 7 — As user A submit P03; as user B reject the P03 record with the reason', async () => {
      await submitInUi(list, s.products.P03);
      await openRecord(b.queue, await approvalIdOf(targetRef(s, 'P03')), reasonP03);
      await b.queue.openRejectDialog();
      await b.queue.confirmReject(rejectText);
    });

    await stepB('Assert: Expected 7 — Toast 반려되었습니다 shows', async () => {
      await expect(b.queue.rejectedToast, '[Expected 7] Toast 반려되었습니다 (Rejected)').toBeVisible();
    });

    await step('Act: Step 8 — Read the audit_log entries of FeeCorrection / ChangeApproval since the TC start', async () => {
      const corrections = [...(await db.corrections(s.products.P14)), ...(await db.corrections(s.products.P03))].map((r) => String(r.id));
      const approvals = [...(await db.approvals(targetRef(s, 'P14'))), ...(await db.approvals(targetRef(s, 'P03')))].map((r) => String(r.id));
      rows = await db.audit(mark, [...corrections, ...approvals]);
      await test.info().attach('audit_log rows', { body: JSON.stringify(rows.map((r) => ({ ts: r.ts, actor: r.actor, action: r.action, entity: r.entity, entity_id: r.entity_id })), null, 2), contentType: 'application/json' });
    });

    await step('Assert: Expected 8 — The eight entries in order, each with actor and time', async () => {
      const a = getAccountDisplayName('submitter');
      const bName = getAccountDisplayName('approver');
      const expected = [
        ['fee_correction.save', a],
        ['fee_correction.submit', a],
        ['change_approval.withdraw', a],
        ['fee_correction.submit', a],
        ['change_approval.approve', bName],
        ['fee_correction.retire', 'SYSTEM'],
        ['fee_correction.submit', a],
        ['change_approval.reject', bName],
      ];
      expect.soft(rows.map((r) => r.action), '[Expected 8] Audit actions in order (one retire row although the list was read twice)').toEqual(expected.map(([action]) => action));
      for (const [i, [action, actor]] of expected.entries()) {
        expect.soft(rows[i]?.actor, `[Expected 8] Entry ${i + 1} ${action}: actor ${actor}`).toBe(actor);
        expect.soft(rows[i]?.ts ?? null, `[Expected 8] Entry ${i + 1} ${action}: has a time`).not.toBeNull();
      }
    });
  });

  test('TC_US079_142 — A hand-keyed rate retires itself once a contract row prices the key', async ({ page, seedData, feeReviewApi, approverFeeReviewApi, contractsApi, approverContractsApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    const extras = new FeeReviewRowExtras(page, list);
    const reason = reasonOf('TC_US079_142', 'Side letter rate agreed with the label');
    await tcMeta('TC_US079_142', 'High', TAGS_RET, `P10 (A × ST2, no contract row) is in force at a hand-keyed 6.75% (approved): the row shows 6.75% 직접 입력 with 적용 행 없음 + 승인됨 — 적용. After row R_A8 (A × ST2 8.00) is added and approved, re-running the query shows 8.00% on one line without the badge, 산정 완료 + 자동 해제 — 더 이상 불필요; 근거 shows 8.00% from 계약 행 R_A8 of C_ROOT, NORMAL, with no correction panel; 변경 이력's top entry is by system (6.75% → 8.00%, a plain-words reason) with user A's entry below; the DB shows Y2 RETIRED (not deleted) with a SYSTEM history row. Deviation: "press Enter in 검색어" is done with the 검색 (Search) button. ${DEV_REASON} ${DEV_YEAR} ${DATA}`);
    let s!: Seeded;
    let y2 = '';
    let rowA8 = { status: 0, newRowId: 0, approve: 0 };
    let after: { correction?: RowDataPacket; history: RowDataPacket[] } = { history: [] };
    const row = () => list.row(s.products.P10);

    await step('Arrange: Pre-condition 1–14 — ROOT (R_A); P10 (A × ST2) in force at an approved hand-keyed 6.75%', async () => {
      s = await seedData({ tc: 142, private: true, contracts: family({ ROOT: ['R_A'] }), cycles: ['CY_MAIN'], products: [product('P10', [{ cycle: 'CY_MAIN', saleLines: 86 }])] });
      const pending = await pendingCorrection(feeReviewApi, s, 'P10', tier2('6.75', reason));
      y2 = pending.id;
      await approveApi(approverFeeReviewApi, pending.approvalId);
      const listed = await feeReviewApi.row(s.cycles.CY_MAIN.id, s.products.P10);
      expect(listed.inForceRate, 'Pre-condition: 6.75 in force').toContain('6.75');
      expect(listed.rateHandKeyed, 'Pre-condition: the rate is hand-keyed').toBe(true);
      expect(listed.correction?.state, 'Pre-condition: the correction is APPROVED').toBe('APPROVED');
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN, bucket 기간 내 판매 상품, keyword P10', async () => {
      await openRow(list, s.cycles.CY_MAIN.id, s.products.P10);
    });

    await step('Assert: Expected 1 — 6.75% with 직접 입력; pills 적용 행 없음 and 승인됨 — 적용', async () => {
      await expect.soft(list.cell(row(), 'rate'), '[Expected 1] Rate 6.75%').toContainText('6.75%');
      await expect.soft(extras.handKeyedBadge(row()), '[Expected 1] Badge 직접 입력 (Hand-keyed)').toBeVisible();
      await expectPills(list, row(), FR_KO['status.NO_ROW'], FR_KO['state.APPROVED'], '[Expected 1]');
    });

    await step('Act: Step 2 — Add row R_A8 (A × ST2 8.00) to C_ROOT and approve it as user B, without reloading the list', async () => {
      const res = await addRow(contractsApi, s, 'ROOT', { category: 'A', saleType: 'ST2' }, 8, '2020-01-01', `[T079-${s.run}-142] R_A8`);
      rowA8 = { status: res.status, newRowId: num(res.body?.newRowId ?? res.body?.id), approve: (await approverContractsApi.approve(num(res.body?.changeApprovalId))).status };
    });

    await step('Assert: Expected 2 — C_ROOT lists R_A8 (A, ST2, 8.00) ACTIVE', async () => {
      expect.soft(rowA8.approve, 'R_A8 is approved (HTTP 200)').toBe(200);
      const added = (await contractsApi.feeRows(s.family.contracts.ROOT)).find((r) => r.categoryId === s.master.category.A && r.saleTypeId === s.master.saleType.ST2);
      expect.soft(added, '[Expected 2] R_A8 is listed').toBeTruthy();
      expect.soft(Number(added?.commission), '[Expected 2] R_A8 rate 8.00').toBe(8);
      expect.soft(added?.status, '[Expected 2] R_A8 is ACTIVE').toBe('ACTIVE');
    });

    await step('Act: Step 3 — Re-run the keyword query', async () => {
      await list.search(s.products.P10);
    });

    await step('Assert: Expected 3 — 8.00% on one line without the badge; pills 산정 완료 and 자동 해제 — 더 이상 불필요', async () => {
      await expectLines(list, row(), 'rate', '8.00%', null, '[Expected 3]');
      await expect.soft(extras.handKeyedBadge(row()), '[Expected 3] No 직접 입력 badge').toHaveCount(0);
      await expectPills(list, row(), FR_KO['status.RESOLVED'], FR_KO['state.RETIRED'], '[Expected 3]');
    });

    await step('Act: Step 4 — Click 근거 (Basis) on the P10 row', async () => {
      await list.openBasis(row());
      await list.basis.expandEvidence();
    });

    await step('Assert: Expected 4 — 8.00% from 계약 행 R_A8 of C_ROOT, NORMAL; no correction-in-force panel', async () => {
      await expect.soft(list.basis.headlineRate, '[Expected 4] Rate 8.00%').toHaveText('8.00%');
      await expect.soft(extras.basisSource('trace.fromContract'), '[Expected 4] Taken from 계약 행 (a contract row)').toBeVisible();
      await expect.soft(extras.basisContract, '[Expected 4] Contract C_ROOT').toHaveText(String(s.family.contracts.ROOT));
      await expect.soft(list.basis.candidateRows.filter({ hasText: '8.00%' }), '[Expected 4] R_A8 (8.00%, NORMAL) is the winning row').toHaveText([/^\s*적용.*NORMAL/]);
      await expect.soft(list.basis.root.getByText(FR_KO['trace.overrideTitle']), '[Expected 4] No panel saying a correction is in force').toHaveCount(0);
    });

    await step('Act: Step 5 — Close the dialog and click 이력 (History) on the P10 row', async () => {
      await list.basis.close();
      await list.openHistory(row());
    });

    await step("Assert: Expected 5 — Top entry by system, 6.75% → 8.00%, a plain-words reason; user A's entry below", async () => {
      const top = list.history.rows.first();
      await expect.soft(list.history.cell(top, 'who'), '[Expected 5] Who = system').toHaveText(SYSTEM_RE);
      await expect.soft(list.history.cell(top, 'change'), '[Expected 5] 수수료율 (Fee rate) 6.75% → 8.00%').toContainText(/6\.75%?\s*→\s*8\.00%?/);
      await expect.soft(list.history.cell(top, 'reason'), '[Expected 5] The reason says a contract row now prices this key').toContainText(/계약|contract/i);
      await expect.soft(list.history.rows.nth(1), "[Expected 5] User A's earlier hand-keyed entry is still listed below").toContainText(getAccountDisplayName('submitter'));
    });

    await step('Act: Step 6 — Read Y2 and its history rows', async () => {
      after = { correction: await db.correction(y2), history: await db.history(y2) };
    });

    await step('Assert: Expected 6 — Y2 RETIRED with retired_at, not deleted; newest history row SYSTEM / RETIRED / 6.75 → 8.00', async () => {
      expect.soft(after.correction, '[Expected 6] Y2 is not deleted').toBeTruthy();
      expect.soft(after.correction?.state, '[Expected 6] Y2 state = RETIRED').toBe('RETIRED');
      expect.soft(after.correction?.retired_at ?? null, '[Expected 6] Y2 retired_at is set').not.toBeNull();
      const newest = after.history[0];
      expect.soft(newest?.who, '[Expected 6] Newest history row who = SYSTEM').toBe('SYSTEM');
      expect.soft(newest?.outcome, '[Expected 6] Newest history row outcome = RETIRED').toBe('RETIRED');
      expect.soft(Number(newest?.rate_before), '[Expected 6] rate_before 6.75').toBe(6.75);
      expect.soft(Number(newest?.rate_after), '[Expected 6] rate_after 8.00').toBe(8);
    });
  });

  test('TC_US079_143 — A tier-1 correction retires itself once commerce assigns the corrected category', async ({ page, seedData, feeReviewApi, approverFeeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    const extras = new FeeReviewRowExtras(page, list);
    const reason = reasonOf('TC_US079_143', '카테고리 오매핑 정정');
    await tcMeta('TC_US079_143', 'High', TAGS_RET, `P14 is in force at B 9.00% through an approved tier-1 correction while commerce holds A (원천 수정 필요 lists it, count 1). Once the fixture is moved to B / R_B9, re-running the query shows B 9.00% on one line, 산정 완료 + 자동 해제 — 더 이상 불필요 and 일치; 근거 shows 9.00% from 계약 행 R_B9 of C_ANNEX1 with commerce's category B in the key and no correction panel; 변경 이력's top entry is by system with a plain-words reason above user A's A → B entry; 원천 수정 필요 no longer lists P14 (count 0); the DB shows X RETIRED with one SYSTEM / RETIRED history row. Deviation: "press Enter in 검색어" is done with the 검색 (Search) button. ${DEV_REASON} ${DEV_YEAR} ${DATA}`);
    let s!: Seeded;
    let x = '';
    let before = -1;
    let afterCount = -1;
    let updated = 0;
    let after: { correction?: RowDataPacket; history: RowDataPacket[] } = { history: [] };
    const row = () => list.row(s.products.P14);
    const srcChip = () => list.chip('bucket.SRCDIFF');

    await step('Arrange: Pre-condition 1–15 — ROOT (R_A) + ANNEX1 (R_B9); P14 in force at B 9.00% through an approved correction, commerce still A (private cycle)', async () => {
      s = await seedData({ tc: 143, private: true, contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      const pending = await pendingCorrection(feeReviewApi, s, 'P14', tier1(s, 'B', reason));
      x = pending.id;
      await approveApi(approverFeeReviewApi, pending.approvalId);
      const listed = await feeReviewApi.row(s.cycles.CY_MAIN.id, s.products.P14);
      expect(listed.inForceRate, 'Pre-condition: 9.00 in force').toContain('9.00');
      expect(listed.problems, 'Pre-condition: SOURCE_NEEDS_FIXING').toContain('SOURCE_NEEDS_FIXING');
    });

    await step('Act: Step 1 — Open CY_MAIN, click bucket 원천 수정 필요 (Source needs fixing) and note its count', async () => {
      await list.open({ cycleId: s.cycles.CY_MAIN.id, bucket: 'SRCDIFF' });
      before = await list.chipCount(srcChip());
    });

    await step('Assert: Expected 1 — P14 is listed under Source needs fixing; the count is 1', async () => {
      await expect.soft(row(), '[Expected 1] P14 is listed under 원천 수정 필요').toBeVisible();
      expect.soft(before, '[Expected 1] The count is 1').toBe(1);
    });

    await step('Act: Step 2 — Click bucket 기간 내 판매 상품 and search P14', async () => {
      await list.clickChip(list.chip('bucket.ALL'));
      await list.search(s.products.P14);
    });

    await step('Assert: Expected 2 — Category B, 9.00%, pills 산정 완료 and 승인됨 — 적용, comparison 불일치', async () => {
      await expect.soft(list.cell(row(), 'category'), '[Expected 2] Category B').toHaveText(startsWith(s.master.categoryName.B));
      await expect.soft(list.cell(row(), 'rate'), '[Expected 2] Rate 9.00%').toHaveText(startsWith('9.00%'));
      await expectPills(list, row(), FR_KO['status.RESOLVED'], FR_KO['state.APPROVED'], '[Expected 2]');
      await expect.soft(list.cell(row(), 'compare'), '[Expected 2] Comparison 불일치 (Mismatch)').toHaveText(FR_KO['compare.MISMATCH']);
    });

    await step('Act: Step 3 — Simulate commerce fixing its assignment: UPDATE P14 to category B / slot R_B9', async () => {
      updated = await db.setProduct(s.products.P14, { categoryId: s.master.category.B, defaultSlot: s.family.rows.R_B9 });
    });

    await step('Assert: Expected 3 — 1 row updated', async () => {
      expect(updated, '[Expected 3] 1 row updated').toBe(1);
    });

    await step('Act: Step 4 — Re-run the keyword query', async () => {
      await list.search(s.products.P14);
    });

    await step('Assert: Expected 4 — B and 9.00% on one line each, pills 산정 완료 and 자동 해제, comparison 일치', async () => {
      await expectLines(list, row(), 'category', s.master.categoryName.B, null, '[Expected 4]');
      await expectLines(list, row(), 'rate', '9.00%', null, '[Expected 4]');
      await expectPills(list, row(), FR_KO['status.RESOLVED'], FR_KO['state.RETIRED'], '[Expected 4]');
      await expect.soft(list.cell(row(), 'compare'), '[Expected 4] Comparison 일치 (Matches)').toHaveText(FR_KO['compare.MATCHES']);
    });

    await step('Act: Step 5 — Click 근거 (Basis) on the P14 row', async () => {
      await list.openBasis(row());
      await list.basis.expandEvidence();
    });

    await step("Assert: Expected 5 — 9.00% from 계약 행 R_B9 of C_ANNEX1; the key uses commerce's category B; no correction panel", async () => {
      await expect.soft(list.basis.headlineRate, '[Expected 5] Rate 9.00%').toHaveText('9.00%');
      await expect.soft(extras.basisSource('trace.fromContract'), '[Expected 5] From 계약 행 (a contract row)').toBeVisible();
      await expect.soft(extras.basisContract, '[Expected 5] Row R_B9 of C_ANNEX1').toHaveText(String(s.family.contracts.ANNEX1));
      await expect.soft(list.basis.value(list.basis.section('trace.keyTitle'), FR_KO['trace.kvCategory']), "[Expected 5] The key uses commerce's category B").toHaveText(s.master.categoryName.B);
      await expect.soft(list.basis.root.getByText(FR_KO['trace.overrideTitle']), '[Expected 5] No panel saying a correction is in force').toHaveCount(0);
    });

    await step('Act: Step 6 — Close the dialog and click 이력 (History) on the P14 row', async () => {
      await list.basis.close();
      await list.openHistory(row());
    });

    await step("Assert: Expected 6 — Top entry by system with a plain-words reason; user A's A → B entry below", async () => {
      const top = list.history.rows.first();
      await expect.soft(list.history.cell(top, 'who'), '[Expected 6] Who = system').toHaveText(SYSTEM_RE);
      await expect.soft(list.history.cell(top, 'reason'), '[Expected 6] The reason says commerce now assigns the corrected category').toContainText(/커머스|commerce/i);
      const userEntry = list.history.rows.nth(1);
      await expect.soft(userEntry, "[Expected 6] User A's entry is below").toContainText(getAccountDisplayName('submitter'));
      await expect.soft(userEntry, "[Expected 6] User A's entry A → B").toContainText(`${s.master.categoryName.A} → ${s.master.categoryName.B}`);
    });

    await step('Act: Step 7 — Close the dialog, clear the keyword and click bucket 원천 수정 필요', async () => {
      await list.history.close();
      await list.search('');
      await list.clickChip(srcChip());
      afterCount = await list.chipCount(srcChip());
    });

    await step('Assert: Expected 7 — Source needs fixing no longer lists P14; its count is 0, one lower than in Step 1', async () => {
      await expect.soft(row(), '[Expected 7] P14 is no longer listed').toHaveCount(0);
      expect.soft(afterCount, '[Expected 7] The count is 0').toBe(0);
      expect.soft(afterCount, '[Expected 7] One lower than in Step 1').toBe(before - 1);
    });

    await step('Act: Step 8 — Read X and its history rows', async () => {
      after = { correction: await db.correction(x), history: await db.history(x) };
    });

    await step('Assert: Expected 8 — X RETIRED with retired_at; one SYSTEM / RETIRED history row', async () => {
      expect.soft(after.correction?.state, '[Expected 8] X state = RETIRED').toBe('RETIRED');
      expect.soft(after.correction?.retired_at ?? null, '[Expected 8] retired_at is set').not.toBeNull();
      expect.soft(after.history.filter((h) => h.who === 'SYSTEM' && h.outcome === 'RETIRED').length, '[Expected 8] One history row who = SYSTEM, outcome = RETIRED').toBe(1);
    });
  });

  test('TC_US079_144 — Retirement is written once when several reads see the condition together', async ({ page, seedData, feeReviewApi, approverFeeReviewApi, contractsApi, approverContractsApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    const reason = reasonOf('TC_US079_144', 'Side letter rate agreed with the label');
    await tcMeta('TC_US079_144', 'High', TAGS_RET, `P10's approved hand-keyed 6.75% becomes unnecessary when row R_A8 is added and approved; 7 reads sent in parallel (list ×2, trace, correction-options, history, period corrections, CSV export) all return 200; Y2 is RETIRED once (retired_at set, version + 1), with exactly one SYSTEM history row, one retirement audit entry and one system entry in 변경 이력. Deviation: the parallel requests are sent with Promise.all through the API client instead of curl. ${DEV_YEAR} ${DATA}`);
    let s!: Seeded;
    let y2 = '';
    let version = 0;
    let statuses: number[] = [];
    let after: { correction?: RowDataPacket; system: number; audit: number } = { system: -1, audit: -1 };

    await step('Arrange: Pre-condition 1–16 — ROOT (R_A); P10 in force at an approved hand-keyed 6.75%; version noted', async () => {
      s = await seedData({ tc: 144, private: true, contracts: family({ ROOT: ['R_A'] }), cycles: ['CY_MAIN'], products: [product('P10', [{ cycle: 'CY_MAIN', saleLines: 86 }])] });
      const pending = await pendingCorrection(feeReviewApi, s, 'P10', tier2('6.75', reason));
      y2 = pending.id;
      await approveApi(approverFeeReviewApi, pending.approvalId);
      expect((await feeReviewApi.row(s.cycles.CY_MAIN.id, s.products.P10)).inForceRate, 'Pre-condition: 6.75 in force').toContain('6.75');
      version = num((await db.correction(y2)).version);
    });

    await step('Act: Step 1 — Add row R_A8 to C_ROOT and approve it as user B', async () => {
      const res = await addRow(contractsApi, s, 'ROOT', { category: 'A', saleType: 'ST2' }, 8, '2020-01-01', `[T079-${s.run}-144] R_A8`);
      expect(res.status, 'R_A8 is added (HTTP 201)').toBe(201);
      expect((await approverContractsApi.approve(num(res.body?.changeApprovalId))).status, 'R_A8 is approved (HTTP 200)').toBe(200);
    });

    await step('Assert: Expected 1 — R_A8 reads ACTIVE', async () => {
      const added = (await contractsApi.feeRows(s.family.contracts.ROOT)).find((r) => r.categoryId === s.master.category.A && r.saleTypeId === s.master.saleType.ST2);
      expect(added?.status, '[Expected 1] R_A8 is ACTIVE').toBe('ACTIVE');
    });

    await step('Act: Step 2 — Send the 7 reads of CY_MAIN / P10 in parallel as user A', async () => {
      const cycleId = s.cycles.CY_MAIN.id;
      const productId = s.products.P10;
      const first = feeReviewApi.exchanges.length;
      await Promise.all([
        feeReviewApi.products(cycleId, { keyword: productId }),
        feeReviewApi.products(cycleId, { keyword: productId }),
        feeReviewApi.trace(cycleId, productId),
        feeReviewApi.options(cycleId, productId),
        feeReviewApi.history(cycleId, productId),
        feeReviewApi.periodCorrections(cycleId),
        feeReviewApi.exportCsv(cycleId, 'products'),
      ]);
      statuses = feeReviewApi.exchanges.slice(first).map((e) => e.status);
      await test.info().attach('parallel_reads', { body: JSON.stringify(feeReviewApi.exchanges.slice(first).map((e) => ({ request: e.request, status: e.status })), null, 2), contentType: 'application/json' });
    });

    await step('Assert: Expected 2 — Every request returns HTTP 200; none fails with a conflict or a server error', async () => {
      expect.soft(statuses.length, '[Expected 2] Seven requests were sent').toBe(7);
      expect.soft(statuses.filter((code) => code !== 200), '[Expected 2] Every request returns HTTP 200').toEqual([]);
    });

    await step('Act: Step 3 — Read state, retired_at and version of Y2', async () => {
      after.correction = await db.correction(y2);
    });

    await step('Assert: Expected 3 — RETIRED, one retired_at, version = noted + 1', async () => {
      expect.soft(after.correction?.state, '[Expected 3] state = RETIRED').toBe('RETIRED');
      expect.soft(after.correction?.retired_at ?? null, '[Expected 3] retired_at holds one timestamp').not.toBeNull();
      expect.soft(num(after.correction?.version), '[Expected 3] version = noted value + 1 (one update only)').toBe(version + 1);
    });

    await step('Act: Step 4 — Count the SYSTEM history rows of Y2', async () => {
      after.system = (await db.history(y2)).filter((h) => h.who === 'SYSTEM').length;
    });

    await step('Assert: Expected 4 — Count = 1', async () => {
      expect(after.system, '[Expected 4] One SYSTEM history row').toBe(1);
    });

    await step('Act: Step 5 — Count the retirement audit entries of Y2', async () => {
      after.audit = (await db.retireAudit(y2)).length;
    });

    await step('Assert: Expected 5 — Exactly one retirement audit entry exists for Y2', async () => {
      expect(after.audit, '[Expected 5] One fee_correction.retire audit entry').toBe(1);
    });

    await step('Act: Step 6 — Open CY_MAIN, bucket 기간 내 판매 상품, keyword P10, then click 이력 (History)', async () => {
      await openRow(list, s.cycles.CY_MAIN.id, s.products.P10);
      await list.openHistory(list.row(s.products.P10));
    });

    await step('Assert: Expected 6 — 변경 이력 shows exactly one entry by system for the retirement', async () => {
      await expect(list.history.rows.filter({ has: page.locator('td:nth-child(2)', { hasText: SYSTEM_RE }) }), '[Expected 6] Exactly one entry by system').toHaveCount(1);
    });
  });

  test('TC_US079_145 — A retired correction never applies again when commerce later moves to another category', async ({ page, seedData, feeReviewApi, approverFeeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    const reason = reasonOf('TC_US079_145', '카테고리 오매핑 정정');
    await tcMeta('TC_US079_145', 'High', TAGS_RET, `P14's tier-1 correction A → B was approved and retired when commerce assigned B. When commerce then moves P14 to C (two tied C rows R_C20 / R_C22) the row reads 중복 적용 with no rate, the retired B 9.00% does not come back and the pill stays 자동 해제; 근거 shows the tie heading "동순위 수수료 행 중복" with commerce's category C in the key and no correction panel; P14 is listed under 확인 필요; 수정 opens as a new correction with nothing prefilled and closes with nothing saved; X stays RETIRED with the same retired_at and no new history row. Deviation: the dev 근거 headline for a tie reads 적용 가능한 행 없음 — the TC heading is asserted and expected to fail. Deviation: "press Enter in 검색어" is done with the 검색 (Search) button. ${DEV_REASON} ${DEV_YEAR} ${DATA}`);
    let s!: Seeded;
    let x = '';
    let retiredAt = 0;
    let historyCount = 0;
    let updated = 0;
    const dialog = { reason: '', selected: '', closed: false, corrections: 0 };
    let after: { correction?: RowDataPacket; history: number } = { history: -1 };
    const row = () => list.row(s.products.P14);

    await step('Arrange: Pre-condition 1–17 — ROOT (R_A) + ANNEX1 (R_B9, R_C20) + ANNEX2 (R_C22); P14 correction A → B approved, then retired once commerce assigned B', async () => {
      s = await seedData({ tc: 145, contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9', 'R_C20'], ANNEX2: ['R_C22'] }), cycles: ['CY_MAIN'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      const pending = await pendingCorrection(feeReviewApi, s, 'P14', tier1(s, 'B', reason));
      x = pending.id;
      await approveApi(approverFeeReviewApi, pending.approvalId);
      expect(await db.setProduct(s.products.P14, { categoryId: s.master.category.B, defaultSlot: s.family.rows.R_B9 }), 'Pre-condition: commerce assigns B (1 row)').toBe(1);
      const listed = await feeReviewApi.row(s.cycles.CY_MAIN.id, s.products.P14);
      expect(listed.correction?.state, 'Pre-condition: the read retires X').toBe('RETIRED');
      const c = await db.correction(x);
      retiredAt = new Date(c.retired_at).getTime();
      historyCount = (await db.history(x)).length;
    });

    await step('Act: Step 1 — Open CY_MAIN, bucket 기간 내 판매 상품, keyword P14', async () => {
      await openRow(list, s.cycles.CY_MAIN.id, s.products.P14);
    });

    await step('Assert: Expected 1 — Category B, 9.00%, pills 산정 완료 and 자동 해제 — 더 이상 불필요', async () => {
      await expect.soft(list.cell(row(), 'category'), '[Expected 1] Category B').toHaveText(startsWith(s.master.categoryName.B));
      await expect.soft(list.cell(row(), 'rate'), '[Expected 1] Rate 9.00%').toHaveText(startsWith('9.00%'));
      await expectPills(list, row(), FR_KO['status.RESOLVED'], FR_KO['state.RETIRED'], '[Expected 1]');
    });

    await step('Act: Step 2 — Simulate commerce moving to category C: UPDATE P14 to C with no default slot', async () => {
      updated = await db.setProduct(s.products.P14, { categoryId: s.master.category.C, defaultSlot: null });
    });

    await step('Assert: Expected 2 — 1 row updated', async () => {
      expect(updated, '[Expected 2] 1 row updated').toBe(1);
    });

    await step('Act: Step 3 — Re-run the keyword query', async () => {
      await list.search(s.products.P14);
    });

    await step('Assert: Expected 3 — 중복 적용 with no rate; the retired B 9.00% is not applied again; the pill still reads Retired', async () => {
      await expect.soft(list.statusPills(row()).nth(0), '[Expected 3] First pill 중복 적용 (Ambiguous)').toHaveText(FR_KO['status.AMBIGUOUS']);
      await expect.soft(list.cell(row(), 'rate'), '[Expected 3] No rate').not.toContainText('%');
      await expect.soft(list.cell(row(), 'category'), "[Expected 3] The retired correction's category B is not applied").not.toHaveText(startsWith(s.master.categoryName.B));
      await expect.soft(list.cell(row(), 'rate'), "[Expected 3] The retired correction's 9.00% is not applied").not.toContainText('9.00');
      await expect.soft(list.statusPills(row()).nth(1), '[Expected 3] Second pill still reads 자동 해제 — 더 이상 불필요').toHaveText(FR_KO['state.RETIRED']);
    });

    await step('Act: Step 4 — Click 근거 (Basis) on the P14 row', async () => {
      await list.openBasis(row());
      await list.basis.expandEvidence();
    });

    await step("Assert: Expected 4 — Heading 동순위 수수료 행 중복; the key uses commerce's category C; no correction panel", async () => {
      await expect.soft(list.basis.root.getByText('동순위 수수료 행 중복'), '[Expected 4] Heading 동순위 수수료 행 중복 (Two fee rows tie)').toBeVisible();
      await expect.soft(list.basis.value(list.basis.section('trace.keyTitle'), FR_KO['trace.kvCategory']), "[Expected 4] The key uses commerce's category C").toHaveText(s.master.categoryName.C);
      await expect.soft(list.basis.root.getByText(FR_KO['trace.overrideTitle']), '[Expected 4] No panel saying a correction is in force').toHaveCount(0);
    });

    await step('Act: Step 5 — Close the dialog and click bucket 확인 필요 (Needs review), keeping the keyword', async () => {
      await list.basis.close();
      await list.clickChip(list.chip('bucket.EXC'));
    });

    await step('Assert: Expected 5 — P14 is listed under Needs review', async () => {
      await expect(row(), '[Expected 5] P14 is listed under 확인 필요').toBeVisible();
    });

    await step('Act: Step 6 — Click 수정 (Correct) on the P14 row, then close the dialog with X without saving', async () => {
      await list.openCorrect(row());
      dialog.reason = await list.correct.reasonInput.inputValue();
      dialog.selected = ((await list.correct.tier1Select.locator('option:checked').textContent()) ?? '').trim();
      await list.correct.cornerClose.click();
      dialog.closed = await list.correct.root.waitFor({ state: 'detached', timeout: 10_000 }).then(() => true, () => false);
      dialog.corrections = (await db.corrections(s.products.P14)).length;
    });

    await step('Assert: Expected 6 — Opens as a new correction with nothing prefilled; X closes it with nothing saved', async () => {
      expect.soft(dialog.reason, '[Expected 6] The reason box is empty').toBe('');
      expect.soft(dialog.selected, '[Expected 6] Nothing from the retired correction (category B) is filled in').not.toMatch(startsWith(s.master.categoryName.B));
      expect.soft(dialog.closed, '[Expected 6] X closes the dialog').toBe(true);
      expect.soft(dialog.corrections, '[Expected 6] Nothing is saved (only the retired correction exists)').toBe(1);
    });

    await step('Act: Step 7 — Read X and count its history rows', async () => {
      after = { correction: await db.correction(x), history: (await db.history(x)).length };
    });

    await step('Assert: Expected 7 — X stays RETIRED with the same retired_at; no history row was added', async () => {
      expect.soft(after.correction?.state, '[Expected 7] X state stays RETIRED').toBe('RETIRED');
      expect.soft(new Date(after.correction?.retired_at).getTime(), '[Expected 7] Same retired_at').toBe(retiredAt);
      expect.soft(after.history, '[Expected 7] No history row was added').toBe(historyCount);
    });
  });

  test('TC_US079_146 — A correction in force carries into the next cycle and a new commerce load does not overwrite it', async ({ page, seedData, feeReviewApi, approverFeeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    const extras = new FeeReviewRowExtras(page, list);
    const reason = reasonOf('TC_US079_146', 'Wrong category mapped in commerce');
    await tcMeta('TC_US079_146', 'High', TAGS_RET, `P14's approved tier-1 correction A → B (CY_MAIN) also applies in CY_NEXT; after a new commerce load (DELETE + INSERT of the fixture row with A / R_A) CY_NEXT still shows B 9.00% with 불일치, lists P14 under 이번 기 수정됨, 근거 shows the 수정본이 적용 중입니다 panel with who corrected it, the time and the contract value A 12.50%, 수정 is enabled and opens for the CY_NEXT key, and X stays APPROVED. Deviation: the cycle change of Step 2 opens CY_NEXT by URL (cycleId) instead of the dropdown. Deviation: "press Enter in 검색어" is done with the 검색 (Search) button. ${DEV_REASON} ${DEV_YEAR} ${DATA}`);
    let s!: Seeded;
    let x = '';
    const load = { deleted: 0, inserted: 0 };
    const correct = { enabled: false, optionsUrl: '' };
    let after!: RowDataPacket;
    const row = () => list.row(s.products.P14);

    await step('Arrange: Pre-condition 1–16 — ROOT (R_A) + ANNEX1 (R_B9); CY_MAIN and CY_NEXT; P14 in force at B 9.00% in both through an approved correction', async () => {
      s = await seedData({ tc: 146, contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN', 'CY_NEXT'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }, { cycle: 'CY_NEXT', saleLines: 5 }])] });
      const pending = await pendingCorrection(feeReviewApi, s, 'P14', tier1(s, 'B', reason));
      x = pending.id;
      await approveApi(approverFeeReviewApi, pending.approvalId);
      expect((await feeReviewApi.row(s.cycles.CY_MAIN.id, s.products.P14)).inForceRate, 'Pre-condition: 9.00 in force in CY_MAIN').toContain('9.00');
      expect((await feeReviewApi.row(s.cycles.CY_NEXT.id, s.products.P14)).inForceRate, 'Pre-condition: 9.00 in force in CY_NEXT').toContain('9.00');
    });

    await step('Act: Step 1 — Open CY_MAIN, bucket 기간 내 판매 상품, keyword P14', async () => {
      await openRow(list, s.cycles.CY_MAIN.id, s.products.P14);
    });

    await step('Assert: Expected 1 — Category B, 9.00%, pill 승인됨 — 적용', async () => {
      await expect.soft(list.cell(row(), 'category'), '[Expected 1] Category B').toHaveText(startsWith(s.master.categoryName.B));
      await expect.soft(list.cell(row(), 'rate'), '[Expected 1] Rate 9.00%').toHaveText(startsWith('9.00%'));
      await expectPills(list, row(), null, FR_KO['state.APPROVED'], '[Expected 1]');
    });

    await step('Act: Step 2 — Change 정산 주기 to CY_NEXT, bucket 기간 내 판매 상품, keyword P14', async () => {
      await openRow(list, s.cycles.CY_NEXT.id, s.products.P14);
    });

    await step('Assert: Expected 2 — In CY_NEXT category B and 9.00% from the correction, pill 승인됨 — 적용', async () => {
      await expect.soft(list.cell(row(), 'category'), '[Expected 2] Category B').toHaveText(startsWith(s.master.categoryName.B));
      await expect.soft(list.cell(row(), 'rate'), '[Expected 2] Rate 9.00%').toHaveText(startsWith('9.00%'));
      await expectPills(list, row(), null, FR_KO['state.APPROVED'], '[Expected 2]');
    });

    await step('Act: Step 3 — Simulate a new commerce load: DELETE then INSERT the P14 fixture row (A / R_A)', async () => {
      load.deleted = await feeReviewDb.execute('DELETE FROM fee_review_fixture_product WHERE product_id = ?', [s.products.P14]);
      load.inserted = await feeReviewDb.execute(
        'INSERT INTO fee_review_fixture_product (product_id, product_name, contract_id, category_id, sale_type_id, default_slot_fee_row_id, promotion_slot_fee_row_id) VALUES (?, ?, ?, ?, ?, ?, NULL)',
        [s.products.P14, '[T079] P14', s.family.contracts.ROOT, s.master.category.A, s.master.saleType.ST1, s.family.rows.R_A],
      );
    });

    await step('Assert: Expected 3 — Delete and insert succeed', async () => {
      expect.soft(load.deleted, '[Expected 3] Delete succeeds (1 row)').toBe(1);
      expect.soft(load.inserted, '[Expected 3] Insert succeeds (1 row)').toBe(1);
    });

    await step('Act: Step 4 — Re-run the keyword query', async () => {
      await list.search(s.products.P14);
    });

    await step('Assert: Expected 4 — CY_NEXT still shows B and 9.00% (not A / 12.50%); comparison 불일치', async () => {
      await expect.soft(list.cell(row(), 'category'), '[Expected 4] Category B (not A)').toHaveText(startsWith(s.master.categoryName.B));
      await expect.soft(list.cell(row(), 'rate'), '[Expected 4] Rate 9.00% (not 12.50%)').toHaveText(startsWith('9.00%'));
      await expect.soft(list.cell(row(), 'compare'), '[Expected 4] Comparison 불일치 (Mismatch)').toHaveText(FR_KO['compare.MISMATCH']);
    });

    await step('Act: Step 5 — Click bucket 이번 기 수정됨 (Corrected this period), keeping the keyword', async () => {
      await list.clickChip(list.chip('bucket.FIXED'));
    });

    await step('Assert: Expected 5 — P14 is listed under Corrected this period', async () => {
      await expect(row(), '[Expected 5] P14 is listed under 이번 기 수정됨').toBeVisible();
    });

    await step('Act: Step 6 — Click 근거 (Basis) on the P14 row', async () => {
      await list.openBasis(row());
    });

    await step('Assert: Expected 6 — Panel 수정본이 적용 중입니다 with who corrected it and the approval time; the contract still resolves A 12.50%', async () => {
      await expect.soft(extras.basisOverridePanel, '[Expected 6] Panel 수정본이 적용 중입니다 (A correction is in force)').toBeVisible();
      await expect.soft(extras.basisOverridePanel, '[Expected 6] Who corrected it').toContainText(getAccountDisplayName('submitter'));
      await expect.soft(extras.basisOverridePanel, '[Expected 6] The approval time').toContainText(/\d{4}-\d{2}-\d{2}/);
      await expect.soft(extras.basisOverridePanel, '[Expected 6] The contract itself still resolves category A').toContainText(s.master.categoryName.A);
      await expect.soft(extras.basisOverridePanel, '[Expected 6] The contract itself still resolves 12.50%').toContainText('12.50%');
    });

    await step('Act: Step 7 — Close the dialog, click 수정 (Correct) on the P14 row, then close the dialog with X', async () => {
      await list.basis.close();
      correct.enabled = await list.rowButton(row(), 'btn.correct').isEnabled();
      const options = page.waitForResponse((r) => /\/correction-options\?/.test(r.url()), { timeout: 15_000 }).catch(() => null);
      await list.openCorrect(row());
      correct.optionsUrl = (await options)?.url() ?? '';
      await list.correct.cornerClose.click();
    });

    await step('Assert: Expected 7 — 수정 is enabled and 수수료 산정 수정 opens for the CY_NEXT key', async () => {
      expect.soft(correct.enabled, '[Expected 7] 수정 (Correct) is enabled').toBe(true);
      expect.soft(correct.optionsUrl, '[Expected 7] The dialog opens for the CY_NEXT key').toContain(`/cycles/${s.cycles.CY_NEXT.id}/products/${encodeURIComponent(s.products.P14)}/`);
    });

    await step('Act: Step 8 — Read state and retired_at of X', async () => {
      after = await db.correction(x);
    });

    await step('Assert: Expected 8 — X APPROVED, retired_at NULL', async () => {
      expect.soft(after.state, '[Expected 8] X state = APPROVED').toBe('APPROVED');
      expect.soft(after.retired_at ?? null, '[Expected 8] retired_at = NULL').toBeNull();
    });
  });

  test('TC_US079_147 — Retiring the newest correction does not bring an older correction on the same key back into force', async ({ page, seedData, feeReviewApi, approverFeeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    const extras = new FeeReviewRowExtras(page, list);
    const reason1 = reasonOf('TC_US079_147', '카테고리 오매핑 정정');
    const reason2 = reasonOf('TC_US079_147', 'Promotion category confirmed by the label');
    await tcMeta('TC_US079_147', 'High', TAGS_RET, `P14 is in force at B 9.00% (approved X1). A newer correction X2 to category E (PROMOTION row 9.50%) is saved, submitted and approved; when commerce then assigns E itself X2 retires and the row shows E 9.50% from commerce's value, 산정 완료 + 자동 해제, 일치 — the older X1 (B 9.00%) does not come back; 근거 shows 9.50% from 계약 행 R_PROMO with no correction panel. Expected to FAIL (TC build note): the in-force correction is picked by highest effectiveFrom / id, so X1 comes back. Deviation: "press Enter in 검색어" is done with the 검색 (Search) button. ${DEV_REASON} ${DEV_YEAR} ${DATA}`);
    let s!: Seeded;
    let x2Approval = { id: 0, status: 0 };
    let updated = 0;
    let corrections: RowDataPacket[] = [];
    const row = () => list.row(s.products.P14);

    await step('Arrange: Pre-condition 1–15 — ROOT (R_A, R_PROMO, R_E11) + ANNEX1 (R_B9); P14 in force at B 9.00% through approved X1', async () => {
      s = await seedData({ tc: 147, contracts: family({ ROOT: ['R_A', 'R_PROMO', 'R_E11'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      const pending = await pendingCorrection(feeReviewApi, s, 'P14', tier1(s, 'B', reason1));
      await approveApi(approverFeeReviewApi, pending.approvalId);
      const listed = await feeReviewApi.row(s.cycles.CY_MAIN.id, s.products.P14);
      expect(listed.inForceRate, 'Pre-condition: 9.00 in force').toContain('9.00');
      expect(listed.correction?.state, 'Pre-condition: X1 is APPROVED').toBe('APPROVED');
    });

    await step('Act: Step 1 — Open CY_MAIN, bucket 기간 내 판매 상품, keyword P14', async () => {
      await openRow(list, s.cycles.CY_MAIN.id, s.products.P14);
    });

    await step('Assert: Expected 1 — Category B, 9.00%, pill 승인됨 — 적용', async () => {
      await expect.soft(list.cell(row(), 'category'), '[Expected 1] Category B').toHaveText(startsWith(s.master.categoryName.B));
      await expect.soft(list.cell(row(), 'rate'), '[Expected 1] Rate 9.00%').toHaveText(startsWith('9.00%'));
      await expectPills(list, row(), null, FR_KO['state.APPROVED'], '[Expected 1]');
    });

    await step('Act: Step 2 — Click 수정, pick category E in Tier 1, type the reason and click 저장', async () => {
      await correctInUi(list, s.products.P14, s.master.categoryName.E, reason2);
    });

    await step('Assert: Expected 2 — Toast "승인 요청으로 상신되었습니다. 요율이 변경됩니다."; pill 수정됨 — 미상신; E 9.50% dimmed under B 9.00%', async () => {
      await expect.soft(list.toast(FR_KO['fix.savedDraft']), '[Expected 2] Toast: correction submitted for approval — the rate changed').toBeVisible();
      await expectPills(list, row(), null, FR_KO['state.DRAFT'], '[Expected 2]');
      await expectLines(list, row(), 'category', s.master.categoryName.B, s.master.categoryName.E, '[Expected 2]');
      await expectLines(list, row(), 'rate', '9.00%', '9.50%', '[Expected 2]');
    });

    await step('Act: Step 3 — Tick the P14 row and click 선택 일괄 상신', async () => {
      await submitInUi(list, s.products.P14);
    });

    await step('Assert: Expected 3 — Toast "수정 1건을 승인 요청으로 상신했습니다."; pill 승인 대기', async () => {
      await expect.soft(list.toast(frFormat(FR_KO['msg.submitted'], { n: 1 })), '[Expected 3] Toast: 1 correction submitted for approval').toBeVisible();
      await expectPills(list, row(), null, FR_KO['state.PENDING'], '[Expected 3]');
    });

    await step('Act: Step 4 — As user B find the new PENDING P14 record and approve it (X2)', async () => {
      x2Approval.id = await approvalIdOf(targetRef(s, 'P14'));
      x2Approval.status = (await approverFeeReviewApi.approve(x2Approval.id)).status;
    });

    await step('Assert: Expected 4 — HTTP 200, record approved', async () => {
      expect.soft(x2Approval.status, '[Expected 4] HTTP 200').toBe(200);
      expect.soft((await db.approval(x2Approval.id)).approval_status, '[Expected 4] The record is approved').toBe('APPROVED');
    });

    await step('Act: Step 5 — As user A re-run the keyword query', async () => {
      await list.search(s.products.P14);
    });

    await step('Assert: Expected 5 — Category E, 9.50% on one line, pill 승인됨 — 적용', async () => {
      await expectLines(list, row(), 'category', s.master.categoryName.E, null, '[Expected 5]');
      await expectLines(list, row(), 'rate', '9.50%', null, '[Expected 5]');
      await expectPills(list, row(), null, FR_KO['state.APPROVED'], '[Expected 5]');
    });

    await step('Act: Step 6 — Simulate commerce assigning E: UPDATE P14 to E, no default slot, promotion slot R_PROMO', async () => {
      updated = await db.setProduct(s.products.P14, { categoryId: s.master.category.E, defaultSlot: null, promotionSlot: s.family.rows.R_PROMO });
    });

    await step('Assert: Expected 6 — 1 row updated', async () => {
      expect(updated, '[Expected 6] 1 row updated').toBe(1);
    });

    await step('Act: Step 7 — Re-run the keyword query', async () => {
      await list.search(s.products.P14);
    });

    await step("Assert: Expected 7 — E 9.50% from commerce, 산정 완료 + 자동 해제, 일치; the older B 9.00% does not come back", async () => {
      await expect.soft(list.cell(row(), 'category'), '[Expected 7] Category E').toHaveText(startsWith(s.master.categoryName.E));
      await expect.soft(list.cell(row(), 'rate'), '[Expected 7] Rate 9.50%').toHaveText(startsWith('9.50%'));
      await expectPills(list, row(), FR_KO['status.RESOLVED'], FR_KO['state.RETIRED'], '[Expected 7]');
      await expect.soft(list.cell(row(), 'compare'), '[Expected 7] Comparison 일치 (Matches)').toHaveText(FR_KO['compare.MATCHES']);
      await expect.soft(list.cell(row(), 'rate'), "[Expected 7] The older correction's 9.00% does not come back").not.toContainText('9.00');
      await expect.soft(list.cell(row(), 'category'), "[Expected 7] The older correction's category B does not come back").not.toContainText(s.master.categoryName.B);
    });

    await step('Act: Step 8 — Click 근거 (Basis) on the P14 row', async () => {
      await list.openBasis(row());
    });

    await step('Assert: Expected 8 — 9.50% from 계약 행 R_PROMO; no correction panel', async () => {
      await expect.soft(list.basis.headlineRate, '[Expected 8] Rate 9.50%').toHaveText('9.50%');
      await expect.soft(extras.basisSource('trace.fromContract'), '[Expected 8] From 계약 행 (a contract row)').toBeVisible();
      await expect.soft(extras.basisContract, '[Expected 8] Row R_PROMO of C_ROOT').toHaveText(String(s.family.contracts.ROOT));
      await expect.soft(list.basis.root.getByText(FR_KO['trace.overrideTitle']), '[Expected 8] No panel saying a correction is in force').toHaveCount(0);
    });

    await step('Act: Step 9 — Read the fee_correction rows of P14', async () => {
      corrections = await db.corrections(s.products.P14);
    });

    await step('Assert: Expected 9 — X2 RETIRED; X1 not in force (the list rate is 9.50%, not 9.00%)', async () => {
      const x2 = corrections[corrections.length - 1];
      expect.soft(x2?.state, '[Expected 9] X2 state = RETIRED').toBe('RETIRED');
      expect.soft((await feeReviewApi.row(s.cycles.CY_MAIN.id, s.products.P14)).inForceRate, '[Expected 9] X1 is not in force — the rate is 9.50').toContain('9.50');
    });
  });

  test('TC_US079_148 — A tier-1 correction to the category commerce already holds is handled without a silent apply-and-retire', async ({ page, seedData, feeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    const reason1 = reasonOf('TC_US079_148', 'Wrong category mapped in commerce');
    const reason2 = reasonOf('TC_US079_148', '커머스 지정 카테고리로 되돌림');
    await tcMeta('TC_US079_148', 'Medium', TAGS_RET, `P05 (commerce A, no slot) carries an applied no-rate-change correction to D (12.50%, 적용됨 (요율 변동 없음)). Correcting it back to A — the category commerce already holds — shows the delta "요율 그대로 — 승인 불필요" (applies at once, appears on the period report). Not automated: Expected 3–5 are ⚠ TBC in the TC (SRS silent; the build saves 적용됨 (요율 변동 없음) then retires on the next read) — the observed save response, row pill and report row are recorded as annotations without a pass/fail verdict. ${DEV_REASON} ${DEV_YEAR} ${DATA}`);
    let s!: Seeded;
    let saveStatus = 0;
    const row = () => list.row(s.products.P05);
    const observe = (n: number, what: string) => test.info().annotations.push({ type: 'Not automated (TBC)', description: `[Expected ${n}] Observed: ${what}` });

    await step('Arrange: Pre-condition 1–11 — ROOT (R_A, R_D); P05 (commerce A, no slot) with an applied correction to D (no rate change)', async () => {
      s = await seedData({ tc: 148, contracts: family({ ROOT: ['R_A', 'R_D'] }), cycles: ['CY_MAIN'], products: [product('P05', [{ cycle: 'CY_MAIN', saleLines: 151 }])] });
      const saved = await saveCorrection(feeReviewApi, s, 'P05', tier1(s, 'D', reason1));
      expect(saved.state, 'Pre-condition: X5 is APPLIED (no approval record)').toBe('APPLIED');
    });

    await step('Act: Step 1 — Open CY_MAIN, bucket 기간 내 판매 상품, keyword P05', async () => {
      await openRow(list, s.cycles.CY_MAIN.id, s.products.P05);
    });

    await step('Assert: Expected 1 — Category D, 12.50%, pill 적용됨 (요율 변동 없음)', async () => {
      await expect.soft(list.cell(row(), 'category'), '[Expected 1] Category D').toHaveText(startsWith(s.master.categoryName.D));
      await expect.soft(list.cell(row(), 'rate'), '[Expected 1] Rate 12.50%').toHaveText(startsWith('12.50%'));
      await expectPills(list, row(), null, FR_KO['state.APPLIED'], '[Expected 1]');
    });

    await step('Act: Step 2 — Click 수정, pick category A (the category commerce already holds) and type the reason', async () => {
      await list.openCorrect(row());
      await list.correct.pickCategory(s.master.categoryName.A);
      await list.correct.reasonInput.fill(reason2);
    });

    await step('Assert: Expected 2 — The delta panel states the rate does not move, so it applies immediately and appears on the period report', async () => {
      await expect.soft(list.correct.deltaHead, '[Expected 2] The rate does not move — no approval needed').toHaveText(FR_KO['fix.deltaZeroHead']);
      await expect.soft(list.correct.deltaPanel, '[Expected 2] It appears on the period report (이번 기 수정 내역)').toContainText(FR_KO['btn.report']);
    });

    await step('Act: Step 3 — Click 저장 (Save)', async () => {
      saveStatus = (await list.correct.save()).status();
    });

    await step('Assert: Expected 3 — ⚠ TBC (SRS silent) — observation recorded, not automated', async () => {
      observe(3, `save HTTP ${saveStatus}`);
    });

    await step('Act: Step 4 — Re-run the keyword query', async () => {
      await list.search(s.products.P05);
    });

    await step('Assert: Expected 4 — ⚠ TBC (SRS silent) — observation recorded, not automated', async () => {
      observe(4, `P05 pills "${(await list.statusPills(row()).allTextContents()).join(' | ')}"`);
    });

    await step('Act: Step 5 — Click 이번 기 수정 내역 (Changes this period)', async () => {
      await list.openReport();
      await list.report.showLatest();
    });

    await step('Assert: Expected 5 — ⚠ TBC (SRS silent) — observation recorded, not automated', async () => {
      observe(5, `report rows for P05: ${(await list.report.rows.filter({ hasText: s.products.P05 }).allTextContents()).map((t) => t.trim()).join(' || ')}`);
    });
  });

  test('TC_US079_149 — Retirement creates no approval record and is attributed to the system', async ({ page, seedData, feeReviewApi, approverFeeReviewApi, contractsApi, approverContractsApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    const reason = reasonOf('TC_US079_149', 'Side letter rate agreed with the label');
    await tcMeta('TC_US079_149', 'Medium', TAGS_RET, `P10's approved hand-keyed 6.75% has exactly one FEE_RULE record (APPROVED, requested by user A, approved by user B). After row R_A8 is added and approved, P10 reads 자동 해제 — 더 이상 불필요 while the record list is unchanged (still one record, APPROVED, no returnedCause, no new record); 변경 이력's top entry is by system; the DB keeps change_approval_id and decided_by user B on Y2, with a SYSTEM history row and a SYSTEM audit actor. Note: approvedBy / returnedCause are read from the change-approvals list items (field names mirror the DB columns — UNVERIFIED on the API). ${DEV_REASON} ${DEV_YEAR} ${DATA}`);
    let s!: Seeded;
    let y2 = '';
    let ca1 = 0;
    let first: Array<Record<string, unknown>> = [];
    let second: Array<Record<string, unknown>> = [];
    let rowStatus = '';
    let after: { correction?: RowDataPacket; history: RowDataPacket[]; audit: RowDataPacket[] } = { history: [], audit: [] };
    const ofP10 = async () => (await approverFeeReviewApi.feeRuleApprovals()).map((a) => a as unknown as Record<string, unknown>).filter((a) => JSON.stringify(a).includes(targetRef(s, 'P10')));

    await step('Arrange: Pre-condition 1–14 — ROOT (R_A); P10 in force at an approved hand-keyed 6.75%', async () => {
      s = await seedData({ tc: 149, private: true, contracts: family({ ROOT: ['R_A'] }), cycles: ['CY_MAIN'], products: [product('P10', [{ cycle: 'CY_MAIN', saleLines: 86 }])] });
      ({ id: y2, approvalId: ca1 } = await pendingCorrection(feeReviewApi, s, 'P10', tier2('6.75', reason)));
      await approveApi(approverFeeReviewApi, ca1);
      expect((await feeReviewApi.row(s.cycles.CY_MAIN.id, s.products.P10)).inForceRate, 'Pre-condition: 6.75 in force').toContain('6.75');
    });

    await step('Act: Step 1 — As user B call GET /change-approvals?targetType=FEE_RULE and find the P10 records', async () => {
      first = await ofP10();
    });

    await step('Assert: Expected 1 — Exactly one FEE_RULE record for P10: APPROVED, requested by user A, approved by user B', async () => {
      expect.soft(first.length, '[Expected 1] Exactly one record').toBe(1);
      expect.soft(first[0]?.approvalStatus, '[Expected 1] approvalStatus APPROVED').toBe('APPROVED');
      expect.soft(first[0]?.requestedBy, '[Expected 1] Requested by user A').toBe(getAccountDisplayName('submitter'));
      expect.soft(first[0]?.approvedBy, '[Expected 1] Approved by user B').toBe(getAccountDisplayName('approver'));
    });

    await step('Act: Step 2 — Add row R_A8 to C_ROOT and approve it as user B', async () => {
      const res = await addRow(contractsApi, s, 'ROOT', { category: 'A', saleType: 'ST2' }, 8, '2020-01-01', `[T079-${s.run}-149] R_A8`);
      expect(res.status, 'R_A8 is added (HTTP 201)').toBe(201);
      expect((await approverContractsApi.approve(num(res.body?.changeApprovalId))).status, 'R_A8 is approved (HTTP 200)').toBe(200);
      rowStatus = (await contractsApi.feeRows(s.family.contracts.ROOT)).find((r) => r.categoryId === s.master.category.A && r.saleTypeId === s.master.saleType.ST2)?.status ?? '';
    });

    await step('Assert: Expected 2 — R_A8 is ACTIVE', async () => {
      expect(rowStatus, '[Expected 2] R_A8 is ACTIVE').toBe('ACTIVE');
    });

    await step('Act: Step 3 — As user A open CY_MAIN, bucket 기간 내 판매 상품, keyword P10', async () => {
      await openRow(list, s.cycles.CY_MAIN.id, s.products.P10);
    });

    await step('Assert: Expected 3 — The P10 row shows pill 자동 해제 — 더 이상 불필요', async () => {
      await expectPills(list, list.row(s.products.P10), null, FR_KO['state.RETIRED'], '[Expected 3]');
    });

    await step('Act: Step 4 — Repeat the call of Step 1', async () => {
      second = await ofP10();
    });

    await step('Assert: Expected 4 — Still exactly one record, unchanged: APPROVED, returnedCause empty; no new record', async () => {
      expect.soft(second.length, '[Expected 4] Still exactly one record (no new record)').toBe(1);
      expect.soft(second[0]?.id, '[Expected 4] The same record').toBe(first[0]?.id);
      expect.soft(second[0]?.approvalStatus, '[Expected 4] Still APPROVED').toBe('APPROVED');
      expect.soft(second[0]?.returnedCause ?? null, '[Expected 4] returnedCause empty (not WITHDRAWN)').toBeNull();
    });

    await step('Act: Step 5 — Click 이력 (History) on the P10 row', async () => {
      await list.openHistory(list.row(s.products.P10));
    });

    await step('Assert: Expected 5 — Top entry Who = system — neither user A nor user B', async () => {
      const who = list.history.cell(list.history.rows.first(), 'who');
      await expect.soft(who, '[Expected 5] Who = system').toHaveText(SYSTEM_RE);
      await expect.soft(who, '[Expected 5] Not user A').not.toHaveText(getAccountDisplayName('submitter'));
      await expect.soft(who, '[Expected 5] Not user B').not.toHaveText(getAccountDisplayName('approver'));
    });

    await step('Act: Step 6 — Read Y2, its history and its retirement audit entry', async () => {
      after = { correction: await db.correction(y2), history: await db.history(y2), audit: await db.retireAudit(y2) };
    });

    await step('Assert: Expected 6 — Y2 RETIRED, change_approval_id unchanged, decided_by user B; SYSTEM history row; SYSTEM audit actor', async () => {
      expect.soft(after.correction?.state, '[Expected 6] Y2 state = RETIRED').toBe('RETIRED');
      expect.soft(num(after.correction?.change_approval_id), '[Expected 6] change_approval_id unchanged').toBe(ca1);
      expect.soft(after.correction?.decided_by, '[Expected 6] decided_by still user B').toBe(getAccountDisplayName('approver'));
      expect.soft(after.history.find((h) => h.outcome === 'RETIRED')?.who, '[Expected 6] The retirement history row has who = SYSTEM').toBe('SYSTEM');
      expect.soft(after.audit.map((a) => a.actor), '[Expected 6] The retirement audit entry names the system, no person').toEqual(['SYSTEM']);
    });
  });

  test('TC_US079_150 — A draft or rejected correction is not retired even when the condition is met', async ({ page, seedData, feeReviewApi, approverFeeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    const reasonX = reasonOf('TC_US079_150', '카테고리 오매핑 정정');
    const reasonY = reasonOf('TC_US079_150', 'Wrong category mapped in commerce');
    await tcMeta('TC_US079_150', 'Medium', TAGS_RET, `P14 carries a never-submitted draft X (A → B) and P03 a rejected correction Y (B → A). After commerce is made to hold each correction's category, re-reading the list keeps P14 수정됨 — 미상신 and P03 반려됨 — 수정 후 재상신 with their proposal lines and no 자동 해제; P14 has no history, P03 only user A's rejected entry and no system entry; X stays DRAFT and Y REJECTED with no retired_at and no SYSTEM history. Deviation: the shared cycle lists many products, so the list is also filtered by this TC's product prefix; the re-query of Step 3 uses the 검색 (Search) button because clicking the already-selected chip sends no request. ${DEV_REASON} ${DEV_YEAR} ${DATA}`);
    let s!: Seeded;
    let x = '';
    let y = '';
    let updated = 0;
    const history = { p14Rows: -1, p14Empty: false };
    let after: { corrections: RowDataPacket[]; system: RowDataPacket[] } = { corrections: [], system: [] };
    const prefix = () => `T079-${s.run}-150-`;
    const p14 = () => list.row(s.products.P14);
    const p03 = () => list.row(s.products.P03);

    await step('Arrange: Pre-condition 1–15 — ROOT (R_A, R_B10) + ANNEX1 (R_B9); P14 draft X (A → B); P03 correction Y (B → A) rejected', async () => {
      s = await seedData({ tc: 150, contracts: family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P03', [{ cycle: 'CY_MAIN', saleLines: 77 }]), product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      ({ id: x } = await saveCorrection(feeReviewApi, s, 'P14', tier1(s, 'B', reasonX)));
      const pending = await pendingCorrection(feeReviewApi, s, 'P03', tier1(s, 'A', reasonY));
      y = pending.id;
      expect((await approverFeeReviewApi.reject(pending.approvalId, 'Contract evidence missing')).status, 'Pre-condition: Y is rejected by user B').toBe(200);
      expect((await db.correction(y)).state, 'Pre-condition: Y is REJECTED').toBe('REJECTED');
    });

    await step('Act: Step 1 — Open CY_MAIN, bucket 기간 내 판매 상품, rows per page 20', async () => {
      await openRow(list, s.cycles.CY_MAIN.id, prefix(), { pageSize: '20' });
    });

    await step('Assert: Expected 1 — P14 수정됨 — 미상신 with B 9.00% proposed; P03 반려됨 — 수정 후 재상신 with A 12.50% proposed', async () => {
      await expectPills(list, p14(), null, FR_KO['state.DRAFT'], '[Expected 1] P14');
      await expect.soft(list.secondLine(list.cell(p14(), 'category')), '[Expected 1] P14 proposal category B').toContainText(s.master.categoryName.B);
      await expect.soft(list.secondLine(list.cell(p14(), 'rate')), '[Expected 1] P14 proposal 9.00%').toContainText('9.00%');
      await expectPills(list, p03(), null, FR_KO['state.REJECTED'], '[Expected 1] P03');
      await expect.soft(list.secondLine(list.cell(p03(), 'category')), '[Expected 1] P03 proposal category A').toContainText(s.master.categoryName.A);
      await expect.soft(list.secondLine(list.cell(p03(), 'rate')), '[Expected 1] P03 proposal 12.50%').toContainText('12.50%');
    });

    await step("Act: Step 2 — Make commerce hold each correction's category (P14 → B / R_B9, P03 → A / R_A)", async () => {
      updated = (await db.setProduct(s.products.P14, { categoryId: s.master.category.B, defaultSlot: s.family.rows.R_B9 })) + (await db.setProduct(s.products.P03, { categoryId: s.master.category.A, defaultSlot: s.family.rows.R_A }));
    });

    await step('Assert: Expected 2 — 2 rows updated', async () => {
      expect(updated, '[Expected 2] 2 rows updated').toBe(2);
    });

    await step('Act: Step 3 — Re-run the query', async () => {
      await list.search(prefix());
    });

    await step('Assert: Expected 3 — P14 still 수정됨 — 미상신, P03 still 반려됨; no 자동 해제; both keep their proposal line', async () => {
      await expectPills(list, p14(), null, FR_KO['state.DRAFT'], '[Expected 3] P14');
      await expectPills(list, p03(), null, FR_KO['state.REJECTED'], '[Expected 3] P03');
      await expect.soft(list.cell(p14(), 'status'), '[Expected 3] P14 is not retired').not.toContainText(FR_KO['state.RETIRED']);
      await expect.soft(list.cell(p03(), 'status'), '[Expected 3] P03 is not retired').not.toContainText(FR_KO['state.RETIRED']);
      await expect.soft(list.secondLine(list.cell(p14(), 'rate')), '[Expected 3] P14 still carries its proposal line').toHaveCount(1);
      await expect.soft(list.secondLine(list.cell(p03(), 'rate')), '[Expected 3] P03 still carries its proposal line').toHaveCount(1);
    });

    await step('Act: Step 4 — Click 이력 on P14, close it, then click 이력 on P03', async () => {
      await list.openHistory(p14());
      history.p14Rows = await list.history.rows.filter({ has: page.locator('td:nth-child(2)') }).count();
      history.p14Empty = await list.history.empty.isVisible();
      await list.history.close();
      await list.openHistory(p03());
    });

    await step("Assert: Expected 4 — P14 has no entry; P03 holds only user A's rejected entry; no entry by system", async () => {
      expect.soft(history.p14Rows, '[Expected 4] P14 history has no entry (never submitted)').toBe(0);
      expect.soft(history.p14Empty, '[Expected 4] P14 shows the empty-history message').toBe(true);
      await expect.soft(list.history.rows, "[Expected 4] P03 holds only one entry").toHaveCount(1);
      await expect.soft(list.history.cell(list.history.rows.first(), 'who'), "[Expected 4] P03's entry is user A's").toHaveText(getAccountDisplayName('submitter'));
      await expect.soft(list.history.cell(list.history.rows.first(), 'change'), "[Expected 4] P03's entry is rejected").toContainText(FR_KO['state.REJECTED']);
      await expect.soft(list.history.rows.filter({ has: page.locator('td:nth-child(2)', { hasText: SYSTEM_RE }) }), '[Expected 4] No entry by system').toHaveCount(0);
    });

    await step('Act: Step 5 — Read X and Y and count their SYSTEM history rows', async () => {
      after = {
        corrections: await feeReviewDb.query<RowDataPacket[]>('SELECT id, state, retired_at FROM fee_correction WHERE id IN (?)', [[x, y]]),
        system: await feeReviewDb.query<RowDataPacket[]>("SELECT id FROM fee_correction_history WHERE correction_id IN (?) AND who = 'SYSTEM'", [[x, y]]),
      };
    });

    await step('Assert: Expected 5 — X DRAFT, Y REJECTED, retired_at NULL on both; count = 0', async () => {
      const cx = after.corrections.find((r) => String(r.id) === x);
      const cy = after.corrections.find((r) => String(r.id) === y);
      expect.soft(cx?.state, '[Expected 5] X state = DRAFT').toBe('DRAFT');
      expect.soft(cy?.state, '[Expected 5] Y state = REJECTED').toBe('REJECTED');
      expect.soft(cx?.retired_at ?? null, '[Expected 5] X retired_at = NULL').toBeNull();
      expect.soft(cy?.retired_at ?? null, '[Expected 5] Y retired_at = NULL').toBeNull();
      expect.soft(after.system.length, '[Expected 5] SYSTEM history count = 0').toBe(0);
    });
  });
});
