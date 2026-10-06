import type { Locator } from '@playwright/test';
import type { RowDataPacket } from 'mysql2/promise';
import { test, expect } from '@fixtures/fee-review-v1.fixture';
import { makeApiStep, makeStep } from '@utils/step';
import { Observations } from '@utils/observations';
import { skipTc, tcMeta } from '@utils/tc-meta';
import { FR_KO, FR_TC } from '@utils/fee-review.i18n';
import { getAccountDisplayName } from '@utils/auth-token';
import { family, product, reasonOf, row } from '@utils/fee-review-v1.data';
import { RUN } from '@utils/fee-review-seed';
import type { ContractDef, Seeded } from '@utils/fee-review-seed';
import { feeReviewDb } from '@utils/fee-review-db';
import { RES_TC, ResolutionPage } from '@pages/fee-review-v1/resolution.page';
import type { FeeReviewListPage } from '@pages/fee-review.page';
import type { FeeReviewApi, Policy, SaveCorrectionBody } from '@api/fee-review.api';
import type { FeeRateApi } from '@api/fee-rate.api';

/**
 * US079 v1 — nhóm [Fee Resolution] + [Why This Rate] (TC_US079_57–83, nguồn `input/TESTCASE_US079_v1.md`).
 * Dữ liệu dựng đúng pre-condition của từng TC qua `seedData` (họ contract dùng chung trong RUN theo chữ ký; TC sửa contract /
 * đóng cycle → `private: true`). Assert theo TC; chỗ build dev 01/10 khác TC ghi "Deviation" trong description và dự kiến FAIL.
 * Trường API (decidingTier, missingKeyPart, emptyRateCause…) assert qua GET trace / products trong step Assert tương ứng.
 */
const TAGS = ['fee-review', 'resolution'];
const BASIS_TAGS = ['fee-review', 'why-this-rate'];
const PARTNER = 1771579487807;
const PARTNER2 = 1771579487808;
const DEV =
  'Deviation: CY_MAIN is the next free month from 2100 on (seed rule) instead of <Y>-03, so a TC date "<Y>-03-15" is day 15 of that month; the prototype 검색 조건 (Search condition) dropdown is not on dev, so only the 검색어 (Keyword) box is used.';
const DATA = 'Data: contracts and cycles created for the TC stay (no delete API); products, targets, corrections and approvals under the TC prefix are deleted in teardown.';
/** Ô rate / category "trống" — UI vẽ dấu gạch "—". */
const EMPTY = /^\s*—?\s*$/;

interface Candidate {
  feeRowId?: number | string;
  contractId?: number | string;
  rate?: string | null;
  won?: boolean;
  annex?: boolean;
}

/** Response GET …/trace — tên trường theo TC (verify qua API lúc chạy). */
interface Trace {
  status?: string;
  inForceRate?: string | null;
  inForceCategory?: string | null;
  basisContractId?: number | string | null;
  basisEffectiveFrom?: string | null;
  decidingTier?: string | null;
  candidates?: Candidate[];
  emptyRateCause?: string | null;
  missingKeyPart?: string | null;
  contractFamilyId?: number | string | null;
  verdict?: string;
  assignedFeeRowId?: number | string | null;
  assignedCategory?: string | null;
  problems?: string[];
  rateFromCorrection?: boolean;
  rateHandKeyed?: boolean;
  derivedKey?: { fromCorrection?: boolean; category?: string };
  contractResolvesTo?: { category?: string; rate?: string } | null;
}

async function traceOf(api: FeeReviewApi, cycleId: number, productId: string, policy: Policy = 'NORMAL'): Promise<{ status: number; body: Trace }> {
  const { status, body } = await api.trace(cycleId, productId, policy);
  return { status, body: (body ?? {}) as Trace };
}

const id = (v: unknown): string => String(v ?? '');
const candidateOf = (trace: Trace, feeRowId: number): Candidate | undefined => (trace.candidates ?? []).find((c) => id(c.feeRowId) === id(feeRowId));

/** Pre-condition "Verify: GET …/products?keyword=T079-<RUN>-N" — tổng số dòng + trạng thái từng sản phẩm. */
async function verifySeed(
  api: FeeReviewApi,
  s: Seeded,
  pre: number,
  total: number,
  rows: Array<{ code: string; policy?: Policy; status?: string; rate?: string | null; verdict?: string }>,
  cycle = 'CY_MAIN',
): Promise<void> {
  const listed = await api.products(s.cycles[cycle].id, { keyword: s.prefix });
  expect(listed.totalElements, `[Pre-condition ${pre}] ${total} row(s) listed for ${s.prefix}`).toBe(total);
  for (const r of rows) {
    const found = listed.content.find((x) => x.productId === `${s.prefix}${r.code}` && x.policy === (r.policy ?? 'NORMAL'));
    expect(found, `[Pre-condition ${pre}] ${r.code} ${r.policy ?? 'NORMAL'} is listed`).toBeDefined();
    if (r.status) expect.soft(found?.status, `[Pre-condition ${pre}] ${r.code} status ${r.status}`).toBe(r.status);
    if (r.rate !== undefined) expect.soft(found?.inForceRate ?? null, `[Pre-condition ${pre}] ${r.code} inForceRate ${r.rate}`).toBe(r.rate);
    if (r.verdict) expect.soft(found?.verdict, `[Pre-condition ${pre}] ${r.code} verdict ${r.verdict}`).toBe(r.verdict);
  }
}

/** Expected "The list of CY_MAIN opens with every product sold in the cycle". */
async function expectCycleOpened(list: FeeReviewListPage, api: FeeReviewApi, cycle: { id: number; label: string }, n = 1, chip: 'bucket.ALL' | 'bucket.NF' = 'bucket.ALL'): Promise<void> {
  await expect.soft(list.cycleSelect.locator('option:checked'), `[Expected ${n}] 정산 주기 (Settlement cycle) = ${cycle.label}`).toHaveText(cycle.label);
  await expect.soft(list.chip(chip), `[Expected ${n}] The ${FR_KO[chip]} chip is selected`).toHaveAttribute('aria-pressed', 'true');
  const total = (await api.products(cycle.id, chip === 'bucket.NF' ? { problem: 'NO_ROW' } : {})).totalElements;
  await expect.soft(list.counter, `[Expected ${n}] The list holds every product of the cycle (${total})`).toContainText(`총 ${total}개`);
}

/** Tắt 1 fee row qua API status; gated → TOKEN_B duyệt. Trả về HTTP status của từng lệnh (status, approve). */
async function deactivate(maker: FeeRateApi, approver: FeeRateApi, contractId: number, rowId: number, reason: string): Promise<number[]> {
  const changed = await maker.setStatus(contractId, rowId, 'INACTIVE', reason);
  const statuses = [changed.status];
  if (changed.body?.gated && changed.body.changeApprovalId) statuses.push((await approver.approve(changed.body.changeApprovalId)).status);
  return statuses;
}

/** Pre-condition "Save draft → Submit → Approve" của correction (TOKEN_A lưu + gửi, TOKEN_B duyệt). */
async function approvedCorrection(maker: FeeReviewApi, approver: FeeReviewApi, cycleId: number, productId: string, body: SaveCorrectionBody): Promise<void> {
  const saved = await maker.save(cycleId, productId, body);
  expect(saved.status, '[Pre-condition] The draft correction is saved (201)').toBe(201);
  expect(saved.body.state, '[Pre-condition] The saved correction is DRAFT').toBe('DRAFT');
  expect((await maker.submit([saved.body.correctionId ?? ''])).status, '[Pre-condition] The correction is submitted (200)').toBe(200);
  const approval = (await maker.feeRuleApprovals()).find((a) => JSON.stringify(a).includes(productId));
  expect(approval, '[Pre-condition] A Fee Rule approval record exists for the correction').toBeDefined();
  expect((await approver.approve(approval?.id ?? 0)).status, '[Pre-condition] TOKEN_B approves the correction (200)').toBe(200);
}

async function countOf(sql: string, params: unknown[]): Promise<number> {
  const [first] = await feeReviewDb.query<RowDataPacket[]>(sql, params);
  return Number(first?.n ?? 0);
}

/** Đọc "rate" từ cột prev_value / requested_value của change_approval (JSON hoặc chuỗi). */
function storedRate(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && 'rate' in parsed) return Number(parsed.rate);
  } catch {
    // Không phải JSON → đọc theo mẫu "rate: 12.50".
  }
  const match = /rate"?\s*[:=]\s*"?([\d.]+)/i.exec(text);
  return match ? Number(match[1]) : Number.NaN;
}

async function topOf(locator: Locator): Promise<number> {
  return (await locator.boundingBox())?.y ?? Number.NaN;
}

/** Ngày hiện tại theo giờ KST (màn hiển thị giờ Hàn). */
const kstDate = (): string => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);

test.describe('[Fee Resolution] Resolving the rate of a product', () => {
  test.describe.configure({ timeout: 300_000 });

  test('TC_US079_57 — A product with one matching contract row resolves to that row and rate', async ({ page, feeReviewApi, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const res = new ResolutionPage(page, list);
    await tcMeta('TC_US079_57', 'High', TAGS, `With ROOT holding only R_A (ALBUM × FULL_CONSIGNMENT, 12.50%), product P01 (slot R_A) resolves to R_A: the list shows category A, 12.50%, 산정 완료 and 일치; Why this rate shows 12.50% from 계약 행 with contract ROOT and effective date 2020-01-01; the trace names SINGLE_CANDIDATE with R_A as the only, winning candidate; no fee_correction row is written. ${DEV} ${DATA}`);
    let s!: Seeded;
    let pid = '';
    let trace: { status: number; body: Trace } = { status: 0, body: {} };
    let stored: RowDataPacket[] = [];

    await step('Arrange: Pre-condition 1–11 — ROOT with R_A 12.50%, cycle CY_MAIN, product P01 (slot R_A, 3 sale lines), verified RESOLVED / 12.50 / MATCHES', async () => {
      s = await seedData({ tc: 57, contracts: family({ ROOT: ['R_A'] }), cycles: ['CY_MAIN'], products: [product('P01', [{ cycle: 'CY_MAIN', saleLines: 3 }])] });
      pid = s.products.P01;
      await verifySeed(feeReviewApi, s, 9, 1, [{ code: 'P01', status: 'RESOLVED', rate: '12.50', verdict: 'MATCHES' }]);
    });

    await step('Act: Step 1 — Open 정산 수수료 확인·수정, select CY_MAIN and click chip 기간 내 판매 상품 (Products sold in period)', async () => {
      await res.openCycle(s.cycles.CY_MAIN.id);
    });

    await step('Assert: Expected 1 — The list of CY_MAIN opens with every product sold in the cycle', async () => {
      await expectCycleOpened(list, feeReviewApi, s.cycles.CY_MAIN);
    });

    await step('Act: Step 2 — Search the product ID of P01', async () => {
      await res.searchByProductId(pid);
    });

    await step('Assert: Expected 2 — The rows of P01 are shown', async () => {
      await expect(list.row(pid), `[Expected 2] The row of ${pid} is shown`).toBeVisible();
    });

    await step('Act: Step 3 — Read the NORMAL row of P01', async () => {
      await list.row(pid).scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Category A, 12.50%, 산정 완료 (Resolved), 일치 (Matches)', async () => {
      const r = list.row(pid);
      await expect.soft(list.cell(r, 'category'), `[Expected 3] 산정된 수수료 카테고리 = ${s.master.categoryName.A}`).toHaveText(s.master.categoryName.A);
      await expect.soft(list.cell(r, 'rate'), '[Expected 3] 산정 요율 = 12.50%').toHaveText('12.50%');
      await expect.soft(list.statusPills(r).first(), '[Expected 3] 산정 상태 = 산정 완료 (Resolved)').toHaveText(FR_KO['status.RESOLVED']);
      await expect.soft(list.cell(r, 'compare'), '[Expected 3] 지정 대조 = 일치 (Matches)').toHaveText(FR_KO['compare.MATCHES']);
    });

    await step('Act: Step 4 — Click 근거 (Basis) on that row', async () => {
      await list.openBasis(list.row(pid));
    });

    await step('Assert: Expected 4 — Why this rate opens with 12.50% from 계약 행, contract ROOT, effective from 2020-01-01', async () => {
      await expect.soft(list.basis.headlineRate, '[Expected 4] The rate 12.50%').toHaveText('12.50%');
      await expect.soft(res.sourceLabel('trace.fromContract'), '[Expected 4] 계약 행 (from a contract row)').toBeVisible();
      await expect.soft(res.answerValue('trace.kvContract'), `[Expected 4] 계약 (Contract) = C_ROOT ${s.family.contracts.ROOT}`).toHaveText(id(s.family.contracts.ROOT));
      await expect.soft(res.answerValue('trace.kvEffective'), '[Expected 4] 적용 시작일 (Effective from) = 2020-01-01').toHaveText('2020-01-01');
    });

    await step('Act: Step 5 — Call GET trace?policy=NORMAL for P01', async () => {
      await list.basis.close();
      trace = await traceOf(feeReviewApi, s.cycles.CY_MAIN.id, pid);
    });

    await step('Assert: Expected 5 — HTTP 200, RESOLVED 12.50 from ROOT on 2020-01-01, decidingTier SINGLE_CANDIDATE, one winning candidate R_A', async () => {
      expect(trace.status, '[Expected 5] HTTP 200').toBe(200);
      expect.soft(trace.body.status, '[Expected 5] status = RESOLVED').toBe('RESOLVED');
      expect.soft(trace.body.inForceRate, '[Expected 5] inForceRate = "12.50"').toBe('12.50');
      expect.soft(id(trace.body.basisContractId), '[Expected 5] basisContractId = C_ROOT').toBe(id(s.family.contracts.ROOT));
      expect.soft(trace.body.basisEffectiveFrom, '[Expected 5] basisEffectiveFrom = 2020-01-01').toBe('2020-01-01');
      expect.soft(trace.body.decidingTier, '[Expected 5] decidingTier = SINGLE_CANDIDATE').toBe('SINGLE_CANDIDATE');
      expect.soft(trace.body.candidates ?? [], '[Expected 5] candidates holds 1 item').toHaveLength(1);
      expect.soft(id(trace.body.candidates?.[0]?.feeRowId), '[Expected 5] The candidate is R_A').toBe(id(s.family.rows.R_A));
      expect.soft(trace.body.candidates?.[0]?.won, '[Expected 5] R_A won = true').toBe(true);
    });

    await step('Act: Step 6 — SELECT * FROM fee_correction for P01', async () => {
      stored = await feeReviewDb.query<RowDataPacket[]>('SELECT * FROM fee_correction WHERE product_id = ?', [pid]);
    });

    await step('Assert: Expected 6 — No row is returned: the resolution is not stored', async () => {
      expect(stored, '[Expected 6] fee_correction holds no row for P01').toHaveLength(0);
    });
  });

  test('TC_US079_58 — A promotion row beats a normal row valid on the same date', async ({ page, feeReviewApi, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const res = new ResolutionPage(page, list);
    await tcMeta('TC_US079_58', 'High', TAGS, `ROOT holds R_PROMO (FANCLUB, PROMOTION 9.50%, period 2020-01-01 → 9999-12-31) and R_E11 (NORMAL 11.00%) on the same key; P09 (PROMOTION target, promotion slot R_PROMO) resolves to 9.50%; the panel lists R_PROMO as 적용 and R_E11 as 미적용 and marks 정책 — PROMOTION이 NORMAL보다 우선 as 여기서 결정됨; the trace reads decidingTier POLICY. ${DEV} ${DATA}`);
    let s!: Seeded;
    let pid = '';
    let trace: { status: number; body: Trace } = { status: 0, body: {} };

    await step('Arrange: Pre-condition 1–11 — ROOT with R_PROMO 9.50 (PROMOTION) and R_E11 11.00 (NORMAL), product P09 with a PROMOTION target, verified RESOLVED 9.50 MATCHES', async () => {
      s = await seedData({ tc: 58, contracts: family({ ROOT: ['R_PROMO', 'R_E11'] }), cycles: ['CY_MAIN'], products: [product('P09', [{ cycle: 'CY_MAIN', saleLines: 49 }])] });
      pid = s.products.P09;
      await verifySeed(feeReviewApi, s, 9, 1, [{ code: 'P09', policy: 'PROMOTION', status: 'RESOLVED', rate: '9.50', verdict: 'MATCHES' }]);
    });

    await step('Act: Step 1 — Open the screen, select CY_MAIN and click chip 기간 내 판매 상품 (Products sold in period)', async () => {
      await res.openCycle(s.cycles.CY_MAIN.id);
    });

    await step('Assert: Expected 1 — The list of CY_MAIN opens with every product sold in the cycle', async () => {
      await expectCycleOpened(list, feeReviewApi, s.cycles.CY_MAIN);
    });

    await step('Act: Step 2 — Search the product ID of P09', async () => {
      await res.searchByProductId(pid);
    });

    await step('Assert: Expected 2 — The PROMOTION row of P09 is shown', async () => {
      await expect(list.row(pid), `[Expected 2] The PROMOTION row of ${pid} is shown`).toBeVisible();
    });

    await step('Act: Step 3 — Read the PROMOTION row of P09', async () => {
      await list.row(pid).scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — 산정 요율 = 9.50% and 산정 상태 = 산정 완료 (Resolved)', async () => {
      await expect.soft(list.cell(list.row(pid), 'rate'), '[Expected 3] 산정 요율 = 9.50%').toHaveText('9.50%');
      await expect.soft(list.statusPills(list.row(pid)).first(), '[Expected 3] 산정 상태 = 산정 완료 (Resolved)').toHaveText(FR_KO['status.RESOLVED']);
    });

    await step('Act: Step 4 — Click 근거 (Basis) on that row', async () => {
      await list.openBasis(list.row(pid));
    });

    await step('Assert: Expected 4 — Why this rate opens with 9.50%, 정책 = PROMOTION, 계약 = C_ROOT', async () => {
      await expect.soft(list.basis.headlineRate, '[Expected 4] The rate 9.50%').toHaveText('9.50%');
      await expect.soft(res.answerValue('trace.kvPolicy'), '[Expected 4] 정책 (Policy) = PROMOTION').toHaveText('PROMOTION');
      await expect.soft(res.answerValue('trace.kvContract'), '[Expected 4] 계약 (Contract) = C_ROOT').toHaveText(id(s.family.contracts.ROOT));
    });

    await step('Act: Step 5 — Click 어떻게 결정됐는지 보기 (How this was decided)', async () => {
      await list.basis.expandEvidence();
    });

    await step('Assert: Expected 5 — R_PROMO 9.50 applied, R_E11 11.00 not applied; 정책 — PROMOTION이 NORMAL보다 우선 is 여기서 결정됨', async () => {
      const root = s.family.contracts.ROOT;
      await expect.soft(res.candidate(root, '9.50'), '[Expected 5] R_PROMO 9.50 is 적용 (applied)').toHaveText(ResolutionPage.APPLIED);
      await expect.soft(res.candidate(root, '11.00'), '[Expected 5] R_E11 11.00 is 미적용 (not applied)').toHaveText(ResolutionPage.NOT_APPLIED);
      await expect.soft(res.decidingStep, '[Expected 5] 정책 — PROMOTION이 NORMAL보다 우선 (Policy — PROMOTION beats NORMAL) is 여기서 결정됨 (Decided here)').toContainText(FR_KO['trace.tierPOLICY']);
    });

    await step('Act: Step 6 — Call GET trace?policy=PROMOTION for P09', async () => {
      await list.basis.close();
      trace = await traceOf(feeReviewApi, s.cycles.CY_MAIN.id, pid, 'PROMOTION');
    });

    await step('Assert: Expected 6 — HTTP 200: RESOLVED, inForceRate "9.50", decidingTier POLICY, R_E11 won = false', async () => {
      expect(trace.status, '[Expected 6] HTTP 200').toBe(200);
      expect.soft(trace.body.status, '[Expected 6] status = RESOLVED').toBe('RESOLVED');
      expect.soft(trace.body.inForceRate, '[Expected 6] inForceRate = "9.50"').toBe('9.50');
      expect.soft(trace.body.decidingTier, '[Expected 6] decidingTier = POLICY').toBe('POLICY');
      expect.soft(candidateOf(trace.body, s.family.rows.R_E11)?.won, '[Expected 6] candidate R_E11 won = false').toBe(false);
    });
  });

  test('TC_US079_59 — The ranking then decides by contract hierarchy, later effective date and later contract start', async ({ page, feeReviewApi, contractsApi, approverContractsApi, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const res = new ResolutionPage(page, list);
    await tcMeta('TC_US079_59', 'High', TAGS, `P02 (category B) resolves to the annex row R_B9 9.00% over R_B10 10.00% (계층 decides); P09 (PROMOTION) resolves to R_PROMO22 22.00% of ANNEX2 (promotion period from the cycle start) over R_PROMO20 20.00% and R_PROMO 9.50% (더 늦은 계약 기간 시작일이 우선 decides); P01 resolves to R_A2 13.00% (effective from day 15 of the cycle, added and approved through the fee-row API) over R_A 12.50%. After the two promotion rows are deactivated P09 falls back to 9.50%. The TC notes the build may name SINGLE_CANDIDATE instead of EFFECTIVE_FROM for P01 (the older R_A drops out of its window) — the TC does not assert a tier for P01. ${DEV} ${DATA} The contract family is private to this TC (rows are added and deactivated).`);
    let s!: Seeded;
    let mid = '';
    const traces: Record<string, { status: number; body: Trace }> = {};
    let deactivated: number[] = [];

    await step('Arrange: Pre-condition 1–15 — ROOT (R_A, R_B10, R_PROMO), ANNEX1 (R_B9, R_PROMO20), ANNEX2 (R_PROMO22 from the cycle start), R_A2 13.00 added from day 15 and approved; products P01, P02, P09', async () => {
      s = await seedData({
        tc: 59,
        private: true,
        contracts: family({
          ROOT: ['R_A', 'R_B10', 'R_PROMO'],
          ANNEX1: ['R_B9', row('R_PROMO20', { category: 'E', policy: 'PROMOTION', rate: 20, period: { startAt: '2020-01-01T00:00:00Z', endAt: '9999-12-31T00:00:00Z' } })],
          ANNEX2: [row('R_PROMO22', { category: 'E', policy: 'PROMOTION', rate: 22, period: { startAt: '@CY_MAIN.startT00:00:00Z', endAt: '9999-12-31T00:00:00Z' } })],
        }),
        cycles: ['CY_MAIN'],
        products: [product('P01', [{ cycle: 'CY_MAIN', saleLines: 3 }]), product('P02', [{ cycle: 'CY_MAIN', saleLines: 40 }]), product('P09', [{ cycle: 'CY_MAIN', saleLines: 49 }])],
      });
      mid = `${s.cycles.CY_MAIN.label}-15`;
      const added = await contractsApi.addFeeRow<{ newRowId?: number; id?: number; changeApprovalId?: number }>(s.family.contracts.ROOT, {
        key: { categoryId: s.master.category.A, saleTypeId: s.master.saleType.ST1, policy: 'NORMAL' },
        commissionType: 'PERCENT',
        commission: 13,
        effectiveFrom: mid,
        // Body đúng TC (run 02/10: thiếu pg / feeBase → 400).
        pgCommissionRate: 3,
        feeBase: 'PRODUCT_PRICE',
        pgFeeBase: 'PRODUCT_PRICE',
        changeReason: '[T079] R_A2',
      });
      expect(added.status, '[Pre-condition 8] R_A2 is added (201)').toBe(201);
      const rowA2 = added.body.newRowId ?? added.body.id ?? 0;
      expect((await approverContractsApi.approve(added.body.changeApprovalId ?? 0)).status, '[Pre-condition 9] TOKEN_B approves R_A2 (200)').toBe(200);
      const a2 = (await contractsApi.feeRows(s.family.contracts.ROOT)).find((r) => r.id === rowA2);
      expect.soft(a2?.status, '[Pre-condition 9] R_A2 is ACTIVE').toBe('ACTIVE');
      expect.soft(a2?.effectiveFrom, `[Pre-condition 9] R_A2 is effective from ${mid}`).toBe(mid);
      await verifySeed(feeReviewApi, s, 13, 3, [
        { code: 'P02', rate: '9.00' },
        { code: 'P09', policy: 'PROMOTION', rate: '22.00' },
        { code: 'P01', rate: '13.00' },
      ]);
    });

    await step('Act: Step 1 — Open the screen, select CY_MAIN and click chip 기간 내 판매 상품 (Products sold in period)', async () => {
      await res.openCycle(s.cycles.CY_MAIN.id);
    });

    await step('Assert: Expected 1 — The list of CY_MAIN opens with every product sold in the cycle', async () => {
      await expectCycleOpened(list, feeReviewApi, s.cycles.CY_MAIN);
    });

    await step('Act: Step 2 — Search P02, open 근거 (Basis) and click 어떻게 결정됐는지 보기 (How this was decided)', async () => {
      await res.searchByProductId(s.products.P02);
      await list.openBasis(list.row(s.products.P02));
      await list.basis.expandEvidence();
    });

    await step('Assert: Expected 2 — 9.00% from C_ANNEX1; R_B9 (부속계약) applied, R_B10 not applied; 계층 — 부속계약이 본계약보다 우선 decides', async () => {
      await expect.soft(list.basis.headlineRate, '[Expected 2] The rate 9.00%').toHaveText('9.00%');
      await expect.soft(res.answerValue('trace.kvContract'), '[Expected 2] From C_ANNEX1').toHaveText(id(s.family.contracts.ANNEX1));
      const b9 = res.candidate(s.family.contracts.ANNEX1, '9.00');
      await expect.soft(b9, '[Expected 2] R_B9 9.00 is 적용 (applied)').toHaveText(ResolutionPage.APPLIED);
      await expect.soft(b9, '[Expected 2] R_B9 is tagged 부속계약 (Annex)').toContainText(FR_KO['trace.annex']);
      await expect.soft(res.candidate(s.family.contracts.ROOT, '10.00'), '[Expected 2] R_B10 10.00 is 미적용 (not applied)').toHaveText(ResolutionPage.NOT_APPLIED);
      await expect.soft(res.decidingStep, '[Expected 2] 계층 — 부속계약이 본계약보다 우선 (Hierarchy — annex beats parent) is 여기서 결정됨').toContainText(FR_KO['trace.tierHIERARCHY']);
    });

    await step('Act: Step 3 — Close the panel, search P09, open Basis on the PROMOTION row and expand the reasoning', async () => {
      await list.basis.close();
      await res.searchByProductId(s.products.P09);
      await list.openBasis(list.row(s.products.P09));
      await list.basis.expandEvidence();
    });

    await step('Assert: Expected 3 — 22.00% from C_ANNEX2; R_PROMO22 applied, R_PROMO20 and R_PROMO not applied; 더 늦은 계약 기간 시작일이 우선 decides', async () => {
      await expect.soft(list.basis.headlineRate, '[Expected 3] The rate 22.00%').toHaveText('22.00%');
      await expect.soft(res.answerValue('trace.kvContract'), '[Expected 3] From C_ANNEX2').toHaveText(id(s.family.contracts.ANNEX2));
      await expect.soft(res.candidate(s.family.contracts.ANNEX2, '22.00'), '[Expected 3] R_PROMO22 22.00 (C_ANNEX2) is applied').toHaveText(ResolutionPage.APPLIED);
      await expect.soft(res.candidate(s.family.contracts.ANNEX1, '20.00'), '[Expected 3] R_PROMO20 20.00 (C_ANNEX1) is not applied').toHaveText(ResolutionPage.NOT_APPLIED);
      await expect.soft(res.candidate(s.family.contracts.ROOT, '9.50'), '[Expected 3] R_PROMO 9.50 (C_ROOT) is not applied').toHaveText(ResolutionPage.NOT_APPLIED);
      await expect.soft(res.decidingStep, '[Expected 3] 더 늦은 계약 기간 시작일이 우선 (Later contract period start wins) is Decided here').toContainText(FR_KO['trace.tierPERIOD_FROM']);
    });

    await step('Act: Step 4 — Close the panel, search P01, open Basis on the NORMAL row and expand the reasoning', async () => {
      await list.basis.close();
      await res.searchByProductId(s.products.P01);
      await list.openBasis(list.row(s.products.P01));
      await list.basis.expandEvidence();
    });

    await step(`Assert: Expected 4 — 13.00% effective from day 15 of the cycle; R_A 12.50 (2020-01-01) is not applied`, async () => {
      await expect.soft(list.basis.headlineRate, '[Expected 4] The rate 13.00%').toHaveText('13.00%');
      await expect.soft(res.answerValue('trace.kvEffective'), `[Expected 4] 적용 시작일 (Effective from) = ${mid}`).toHaveText(mid);
      const a = res.candidate(s.family.contracts.ROOT, '12.50');
      await expect.soft(a, '[Expected 4] R_A 12.50 is not applied').toHaveText(ResolutionPage.NOT_APPLIED);
      await expect.soft(a, '[Expected 4] R_A is effective from 2020-01-01').toContainText('2020-01-01');
    });

    await step('Act: Step 5 — Call GET trace for P02 (NORMAL), P09 (PROMOTION) and P01 (NORMAL)', async () => {
      await list.basis.close();
      traces.P02 = await traceOf(feeReviewApi, s.cycles.CY_MAIN.id, s.products.P02);
      traces.P09 = await traceOf(feeReviewApi, s.cycles.CY_MAIN.id, s.products.P09, 'PROMOTION');
      traces.P01 = await traceOf(feeReviewApi, s.cycles.CY_MAIN.id, s.products.P01);
    });

    await step('Assert: Expected 5 — HTTP 200: P02 HIERARCHY / C_ANNEX1 / 9.00; P09 PERIOD_FROM / 22.00 / C_ANNEX2; P01 13.00 from day 15', async () => {
      for (const code of ['P02', 'P09', 'P01']) expect.soft(traces[code].status, `[Expected 5] ${code} trace HTTP 200`).toBe(200);
      expect.soft(traces.P02.body.decidingTier, '[Expected 5] P02 decidingTier = HIERARCHY').toBe('HIERARCHY');
      expect.soft(id(traces.P02.body.basisContractId), '[Expected 5] P02 basisContractId = C_ANNEX1').toBe(id(s.family.contracts.ANNEX1));
      expect.soft(traces.P02.body.inForceRate, '[Expected 5] P02 inForceRate = "9.00"').toBe('9.00');
      expect.soft(traces.P09.body.decidingTier, '[Expected 5] P09 decidingTier = PERIOD_FROM').toBe('PERIOD_FROM');
      expect.soft(traces.P09.body.inForceRate, '[Expected 5] P09 inForceRate = "22.00"').toBe('22.00');
      expect.soft(id(traces.P09.body.basisContractId), '[Expected 5] P09 basisContractId = C_ANNEX2').toBe(id(s.family.contracts.ANNEX2));
      expect.soft(traces.P01.body.inForceRate, '[Expected 5] P01 inForceRate = "13.00"').toBe('13.00');
      expect.soft(traces.P01.body.basisEffectiveFrom, `[Expected 5] P01 basisEffectiveFrom = ${mid}`).toBe(mid);
    });

    await step('Act: Step 6 — Deactivate R_PROMO20 and R_PROMO22 (TOKEN_B approves when gated) and search P09 again', async () => {
      deactivated = [
        ...(await deactivate(contractsApi, approverContractsApi, s.family.contracts.ANNEX1, s.family.rows.R_PROMO20, '[T079] remove promotion row')),
        ...(await deactivate(contractsApi, approverContractsApi, s.family.contracts.ANNEX2, s.family.rows.R_PROMO22, '[T079] remove promotion row')),
      ];
      await res.searchByProductId(s.products.P09);
    });

    await step('Assert: Expected 6 — Each status call and approval returns HTTP 200; the PROMOTION row of P09 is back to 9.50%', async () => {
      deactivated.forEach((status, i) => expect.soft(status, `[Expected 6] Status / approval call ${i + 1} returns HTTP 200`).toBe(200));
      await expect.soft(list.cell(list.row(s.products.P09), 'rate'), '[Expected 6] P09 PROMOTION is back to 9.50%').toHaveText('9.50%');
    });
  });

  test('TC_US079_60 — Two rows tied on every ranking step make the product Ambiguous with no rate', async ({ page, feeReviewApi, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const res = new ResolutionPage(page, list);
    await tcMeta('TC_US079_60', 'High', TAGS, `ROOT has no row; ANNEX1 (R_C20 20.00%) and ANNEX2 (R_C22 22.00%) price MD_CONSIGNMENT × FULL_CONSIGNMENT with the same dates, so P04 ties on every ranking step: the list reads 중복 적용 with an empty rate and 지정 없음; the panel shows no rate, lists both rows with neither applied and ends the ladder with 여전히 동순위 + its quarantine sentence; the trace reads AMBIGUOUS, inForceRate null, decidingTier null and two losing candidates. ${DEV} ${DATA}`);
    let s!: Seeded;
    let pid = '';
    let trace: { status: number; body: Trace } = { status: 0, body: {} };

    await step('Arrange: Pre-condition 1–13 — ROOT (no row), ANNEX1 R_C20 20.00, ANNEX2 R_C22 22.00, product P04 (no slot), verified AMBIGUOUS / null / NOT_ASSIGNED', async () => {
      s = await seedData({ tc: 60, contracts: family({ ROOT: [], ANNEX1: ['R_C20'], ANNEX2: ['R_C22'] }), cycles: ['CY_MAIN'], products: [product('P04', [{ cycle: 'CY_MAIN', saleLines: 114 }])] });
      pid = s.products.P04;
      await verifySeed(feeReviewApi, s, 11, 1, [{ code: 'P04', status: 'AMBIGUOUS', rate: null, verdict: 'NOT_ASSIGNED' }]);
    });

    await step('Act: Step 1 — Open the screen, select CY_MAIN and click chip 기간 내 판매 상품 (Products sold in period)', async () => {
      await res.openCycle(s.cycles.CY_MAIN.id);
    });

    await step('Assert: Expected 1 — The list of CY_MAIN opens with every product sold in the cycle', async () => {
      await expectCycleOpened(list, feeReviewApi, s.cycles.CY_MAIN);
    });

    await step('Act: Step 2 — Search the product ID of P04', async () => {
      await res.searchByProductId(pid);
    });

    await step('Assert: Expected 2 — The row of P04 is shown', async () => {
      await expect(list.row(pid), `[Expected 2] The row of ${pid} is shown`).toBeVisible();
    });

    await step('Act: Step 3 — Read the row of P04', async () => {
      await list.row(pid).scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — 중복 적용 (Ambiguous), empty rate, 지정 없음 (Not assigned)', async () => {
      const r = list.row(pid);
      await expect.soft(list.statusPills(r).first(), '[Expected 3] 산정 상태 = 중복 적용 (Ambiguous)').toHaveText(FR_KO['status.AMBIGUOUS']);
      await expect.soft(list.cell(r, 'rate'), '[Expected 3] 산정 요율 is empty').toHaveText(EMPTY);
      await expect.soft(list.cell(r, 'compare'), '[Expected 3] 지정 대조 = 지정 없음 (Not assigned)').toHaveText(FR_KO['compare.NOT_ASSIGNED']);
    });

    await step('Act: Step 4 — Click 근거 (Basis) on that row', async () => {
      await list.openBasis(list.row(pid));
    });

    await step('Assert: Expected 4 — Why this rate opens with no rate', async () => {
      await expect(list.basis.root, '[Expected 4] Why this rate is open').toBeVisible();
      await expect.soft(list.basis.headlineRate, '[Expected 4] No rate (—)').toHaveText(EMPTY);
    });

    await step('Act: Step 5 — Read the reasoning panels under 어떻게 결정됐는지 보기 (How this was decided)', async () => {
      await list.basis.expandEvidence();
    });

    await step('Assert: Expected 5 — R_C20 20.00 and R_C22 22.00 listed, neither applied; 여전히 동순위 with its quarantine sentence', async () => {
      await expect.soft(res.candidate(s.family.contracts.ANNEX1, '20.00'), '[Expected 5] R_C20 20.00 is listed, not applied').toHaveText(ResolutionPage.NOT_APPLIED);
      await expect.soft(res.candidate(s.family.contracts.ANNEX2, '22.00'), '[Expected 5] R_C22 22.00 is listed, not applied').toHaveText(ResolutionPage.NOT_APPLIED);
      await expect.soft(list.basis.candidateRows.filter({ hasText: ResolutionPage.APPLIED }), '[Expected 5] Neither row is marked 적용 (applied)').toHaveCount(0);
      const ladder = list.basis.section('trace.ladderTitle');
      await expect.soft(ladder, '[Expected 5] 여전히 동순위 (Still tied)').toContainText(FR_KO['trace.stillTied']);
      await expect.soft(ladder, '[Expected 5] 우선순위 마지막 단계에서 종료 — 추측하지 않고 이 라인을 보류(격리) 처리함').toContainText(FR_KO['trace.stillTiedDetail']);
    });

    await step('Act: Step 6 — Call GET trace?policy=NORMAL for P04', async () => {
      await list.basis.close();
      trace = await traceOf(feeReviewApi, s.cycles.CY_MAIN.id, pid);
    });

    await step('Assert: Expected 6 — HTTP 200: AMBIGUOUS, inForceRate null, decidingTier null, 2 candidates both won = false', async () => {
      expect(trace.status, '[Expected 6] HTTP 200').toBe(200);
      expect.soft(trace.body.status, '[Expected 6] status = AMBIGUOUS').toBe('AMBIGUOUS');
      expect.soft(trace.body.inForceRate ?? null, '[Expected 6] inForceRate = null').toBeNull();
      expect.soft(trace.body.decidingTier ?? null, '[Expected 6] decidingTier = null').toBeNull();
      expect.soft(trace.body.candidates ?? [], '[Expected 6] 2 candidates').toHaveLength(2);
      expect.soft((trace.body.candidates ?? []).every((c) => c.won === false), '[Expected 6] Both candidates won = false').toBe(true);
    });
  });

  test('TC_US079_61 — A provisional winning row settles at its rate as Provisional and is not quarantined', async () => {
    await skipTc(
      'TC_US079_61',
      'Medium',
      TAGS,
      'A winning fee row carrying a provisional fee should make the product 잠정 적용 (Provisional) at that row\'s rate, listed under the Provisional chip and not under 확인 필요 (Needs review).',
      'Pre-condition 4 cannot be produced on this build (DEV-30): no API or field marks a fee row as provisional, so the build never yields PROVISIONAL and the Provisional bucket always reads 0.',
    );
  });

  test('TC_US079_62 — A bracket, margin or running-guarantee row makes the product Not computable with no rate', async ({ page, feeReviewApi, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const res = new ResolutionPage(page, list);
    await tcMeta('TC_US079_62', 'High', TAGS, `CT3 holds a single MARGIN row R_CT3 for ALBUM × FULL_CONSIGNMENT; P21 reads 구간형 요율 — 산정 전 with an empty rate, is listed under the Not computable chip and not under 적용 행 없음, and the trace reads NOT_COMPUTABLE / null / emptyRateCause BRACKET with the R_CT3 candidate at rate null. Not automated: Steps 6, 7 and 9 switch the row type to TIERED_SLIDING / GUARANTEE_RUNNING and back with Mongo updateOne — the suite has no Mongo access, so the bracket and running-guarantee variants and the matchedCount / modifiedCount results are not checked; Step 6/7 still re-run the search on the UI and Step 8 re-reads the trace with the row still MARGIN. ${DEV} ${DATA}`);
    let s!: Seeded;
    let pid = '';
    let trace: { status: number; body: Trace } = { status: 0, body: {} };
    let retrace: { status: number; body: Trace } = { status: 0, body: {} };

    await step('Arrange: Pre-condition 1–11 — CT3 with the MARGIN row R_CT3, product P21 (1 sale line), verified NOT_COMPUTABLE with no rate', async () => {
      s = await seedData({ tc: 62, contracts: family({ CT3: [row('R_CT3', { category: 'A', type: 'MARGIN', rate: 30 })] }), cycles: ['CY_MAIN'], products: [product('P21', [{ cycle: 'CY_MAIN', saleLines: 1 }])] });
      pid = s.products.P21;
      await verifySeed(feeReviewApi, s, 9, 1, [{ code: 'P21', status: 'NOT_COMPUTABLE', rate: null }]);
    });

    await step('Act: Step 1 — Open the screen, select CY_MAIN and click chip 기간 내 판매 상품 (Products sold in period)', async () => {
      await res.openCycle(s.cycles.CY_MAIN.id);
    });

    await step('Assert: Expected 1 — The list of CY_MAIN opens with every product sold in the cycle', async () => {
      await expectCycleOpened(list, feeReviewApi, s.cycles.CY_MAIN);
    });

    await step('Act: Step 2 — Search P21 and read the row (row type MARGIN)', async () => {
      await res.searchByProductId(pid);
    });

    await step('Assert: Expected 2 — 구간형 요율 — 산정 전 (Not computable) and an empty rate', async () => {
      await expect.soft(list.statusPills(list.row(pid)).first(), '[Expected 2] 산정 상태 = 구간형 요율 — 산정 전 (Not computable)').toHaveText(FR_KO['status.NOT_COMPUTABLE']);
      await expect.soft(list.cell(list.row(pid), 'rate'), '[Expected 2] 산정 요율 is empty').toHaveText(EMPTY);
    });

    await step('Act: Step 3 — Click chip 구간형 요율 — 산정 전 (Not computable yet)', async () => {
      await list.clickChip(list.chip('bucket.NC'));
    });

    await step('Assert: Expected 3 — P21 is listed in this bucket', async () => {
      await expect(list.row(pid), '[Expected 3] P21 is listed under 구간형 요율 — 산정 전').toBeVisible();
    });

    await step('Act: Step 4 — Click chip 적용 행 없음 (No row applies)', async () => {
      await list.clickChip(list.chip('bucket.NF'));
    });

    await step('Assert: Expected 4 — P21 is not listed: Not computable is not No row applies', async () => {
      await expect(list.row(pid), '[Expected 4] P21 is not listed under 적용 행 없음').toHaveCount(0);
    });

    await step('Act: Step 5 — Call GET trace?policy=NORMAL for P21', async () => {
      trace = await traceOf(feeReviewApi, s.cycles.CY_MAIN.id, pid);
    });

    await step('Assert: Expected 5 — HTTP 200: NOT_COMPUTABLE, inForceRate null, emptyRateCause BRACKET, R_CT3 candidate with rate null', async () => {
      expect(trace.status, '[Expected 5] HTTP 200').toBe(200);
      expect.soft(trace.body.status, '[Expected 5] status = NOT_COMPUTABLE').toBe('NOT_COMPUTABLE');
      expect.soft(trace.body.inForceRate ?? null, '[Expected 5] inForceRate = null').toBeNull();
      expect.soft(trace.body.emptyRateCause, '[Expected 5] emptyRateCause = BRACKET').toBe('BRACKET');
      const ct3 = candidateOf(trace.body, s.family.rows.R_CT3);
      expect.soft(ct3, '[Expected 5] The C_CT3 row is in candidates').toBeDefined();
      expect.soft(ct3?.rate ?? null, '[Expected 5] The C_CT3 candidate has rate = null').toBeNull();
    });

    await step('Act: Step 6 — (Mongo update to TIERED_SLIDING not automated) click chip 기간 내 판매 상품 and search P21 again', async () => {
      await list.clickChip(list.chip('bucket.ALL'));
      await res.searchByProductId(pid);
    });

    await step('Assert: Expected 6 — Not automated: matchedCount / modifiedCount of the Mongo update and the bracket (TIERED_SLIDING) row state', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Expected 6 needs a Mongo updateOne on C_CT3 (TIERED_SLIDING) — no Mongo access in the suite.' });
    });

    await step('Act: Step 7 — (Mongo update to GUARANTEE_RUNNING not automated) search P21 again', async () => {
      await res.searchByProductId(pid);
    });

    await step('Assert: Expected 7 — Not automated: matchedCount / modifiedCount and the running-guarantee (GUARANTEE_RUNNING) row state', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Expected 7 needs a Mongo updateOne on C_CT3 (GUARANTEE_RUNNING) — no Mongo access in the suite.' });
    });

    await step('Act: Step 8 — Call GET trace?policy=NORMAL for P21 again', async () => {
      retrace = await traceOf(feeReviewApi, s.cycles.CY_MAIN.id, pid);
    });

    await step('Assert: Expected 8 — HTTP 200: NOT_COMPUTABLE, inForceRate null, emptyRateCause BRACKET', async () => {
      expect(retrace.status, '[Expected 8] HTTP 200').toBe(200);
      expect.soft(retrace.body.status, '[Expected 8] status = NOT_COMPUTABLE').toBe('NOT_COMPUTABLE');
      expect.soft(retrace.body.inForceRate ?? null, '[Expected 8] inForceRate = null').toBeNull();
      expect.soft(retrace.body.emptyRateCause, '[Expected 8] emptyRateCause = BRACKET').toBe('BRACKET');
    });

    await step('Act: Step 9 — (Mongo restore to MARGIN not automated — the row was never changed)', async () => {
      await list.row(pid).scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 9 — Not automated: modifiedCount of the restore; the C_CT3 row stays MARGIN', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Expected 9 needs a Mongo updateOne restoring MARGIN — the row was never switched because Steps 6–7 were not automated.' });
    });
  });

  test('TC_US079_63 — Each missing part of the key reports No row applies without guessing a category', async ({ page, feeReviewApi, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const res = new ResolutionPage(page, list);
    await tcMeta('TC_US079_63', 'High', TAGS, `Seven products each miss one part of the key — P12 / P99 no contract binding (P99 has a target row only), P05 no fee category (cleared in Step 1), P06 / P10 / P13 no row for the key (MD, PURCHASE, no sales type), P20 a contract that ended 2030-12-31 — and each reads 적용 행 없음 with an empty rate, P05 with no guessed category; the trace reads NO_ROW with no candidates and missingKeyPart NO_BINDING / NO_CATEGORY / NO_ROW_FOR_KEY / NOT_VALID_ON_DATE. Restoring P05's category brings it back to 산정 완료 12.50% outside the No row bucket. ${DEV} ${DATA}`);
    let s!: Seeded;
    const codes = ['P12', 'P99', 'P05', 'P06', 'P10', 'P13', 'P20'] as const;
    const pidOf = (code: string) => `${s.prefix}${code}`;
    const traces: Record<string, { status: number; body: Trace }> = {};
    let cleared = 0;
    let restored = 0;
    let p05InNoRow = -1;

    await step('Arrange: Pre-condition 1–13 — ROOT R_A, CT2 R_CT2 ending 2030-12-31, products P12 (no contract), P05, P06 (MD), P10 (PURCHASE), P13 (no sales type), P20 (CT2) and a target-only P99', async () => {
      s = await seedData({
        tc: 63,
        contracts: family({ ROOT: ['R_A'], CT2: { rows: [row('R_CT2', { category: 'A', rate: 12.5 })], endAt: '2030-12-31T00:00:00Z' } }),
        cycles: ['CY_MAIN'],
        products: [
          product('P12', [{ cycle: 'CY_MAIN', saleLines: 160 }]),
          product('P05', [{ cycle: 'CY_MAIN', saleLines: 151 }]),
          product('P06', [{ cycle: 'CY_MAIN', saleLines: 188 }]),
          product('P10', [{ cycle: 'CY_MAIN', saleLines: 86 }]),
          product('P13', [{ cycle: 'CY_MAIN', saleLines: 197 }]),
          product('P20', [{ cycle: 'CY_MAIN', saleLines: 1 }]),
        ],
      });
      await feeReviewDb.insertTargets([{ cycleId: s.cycles.CY_MAIN.id, productId: pidOf('P99'), policy: 'NORMAL', saleLineCount: 5 }]);
      await verifySeed(feeReviewApi, s, 11, 7, [
        { code: 'P05', status: 'RESOLVED', rate: '12.50' },
        ...['P12', 'P99', 'P06', 'P10', 'P13', 'P20'].map((code) => ({ code, status: 'NO_ROW' })),
      ]);
    });

    await step('Act: Step 1 — UPDATE fee_review_fixture_product SET category_id = NULL for P05', async () => {
      await feeReviewDb.updateProduct(pidOf('P05'), { categoryId: null });
      cleared = await countOf('SELECT COUNT(*) AS n FROM fee_review_fixture_product WHERE product_id = ? AND category_id IS NULL', [pidOf('P05')]);
    });

    await step('Assert: Expected 1 — 1 row updated', async () => {
      expect(cleared, '[Expected 1] 1 row of P05 now has no category').toBe(1);
    });

    await step('Act: Step 2 — Open the screen, select CY_MAIN and click chip 적용 행 없음 (No row applies)', async () => {
      await res.openCycle(s.cycles.CY_MAIN.id, 'bucket.NF');
    });

    await step('Assert: Expected 2 — The list of CY_MAIN opens on the No row applies bucket', async () => {
      await expectCycleOpened(list, feeReviewApi, s.cycles.CY_MAIN, 2, 'bucket.NF');
    });

    await step('Act: Step 3 — Read the rows of P12, P99, P05, P06, P10, P13 and P20', async () => {
      await list.row(pidOf('P20')).scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Each row reads 적용 행 없음 with an empty rate; P05 shows no category', async () => {
      for (const code of codes) {
        const r = list.row(pidOf(code));
        await expect.soft(list.statusPills(r).first(), `[Expected 3] ${code} 산정 상태 = 적용 행 없음 (No row applies)`).toHaveText(FR_KO['status.NO_ROW']);
        await expect.soft(list.cell(r, 'rate'), `[Expected 3] ${code} 산정 요율 is empty — no platform-wide rate`).toHaveText(EMPTY);
      }
      await expect.soft(list.cell(list.row(pidOf('P05')), 'category'), '[Expected 3] P05 shows no 산정된 수수료 카테고리 — none taken from the product name').toHaveText(EMPTY);
    });

    await step('Act: Step 4 — Call GET trace?policy=NORMAL for each of the 7 products', async () => {
      for (const code of codes) traces[code] = await traceOf(feeReviewApi, s.cycles.CY_MAIN.id, pidOf(code));
    });

    await step('Assert: Expected 4 — HTTP 200, NO_ROW, no candidates; missingKeyPart per product', async () => {
      const part: Record<string, string> = { P12: 'NO_BINDING', P99: 'NO_BINDING', P05: 'NO_CATEGORY', P06: 'NO_ROW_FOR_KEY', P10: 'NO_ROW_FOR_KEY', P13: 'NO_ROW_FOR_KEY', P20: 'NOT_VALID_ON_DATE' };
      for (const code of codes) {
        expect.soft(traces[code].status, `[Expected 4] ${code} HTTP 200`).toBe(200);
        expect.soft(traces[code].body.status, `[Expected 4] ${code} status = NO_ROW`).toBe('NO_ROW');
        expect.soft(traces[code].body.candidates ?? [], `[Expected 4] ${code} candidates = []`).toHaveLength(0);
        expect.soft(traces[code].body.missingKeyPart, `[Expected 4] ${code} missingKeyPart = ${part[code]}`).toBe(part[code]);
      }
    });

    await step('Act: Step 5 — UPDATE category_id = CAT_A for P05 and reload the list', async () => {
      await feeReviewDb.updateProduct(pidOf('P05'), { categoryId: s.master.category.A });
      restored = await countOf('SELECT COUNT(*) AS n FROM fee_review_fixture_product WHERE product_id = ? AND category_id = ?', [pidOf('P05'), s.master.category.A]);
      await res.reload();
      p05InNoRow = await list.row(pidOf('P05')).count();
      await list.clickChip(list.chip('bucket.ALL'));
    });

    await step('Assert: Expected 5 — P05 is back to 산정 완료 (Resolved) at 12.50% and leaves the No row applies bucket', async () => {
      expect.soft(restored, '[Expected 5] P05 carries category A again').toBe(1);
      expect.soft(p05InNoRow, '[Expected 5] P05 is no longer listed under 적용 행 없음').toBe(0);
      await expect.soft(list.statusPills(list.row(pidOf('P05'))).first(), '[Expected 5] P05 산정 상태 = 산정 완료 (Resolved)').toHaveText(FR_KO['status.RESOLVED']);
      await expect.soft(list.cell(list.row(pidOf('P05')), 'rate'), '[Expected 5] P05 산정 요율 = 12.50%').toHaveText('12.50%');
    });
  });

  test("TC_US079_64 — Only rows of the product's own contract family compete", async ({ page, feeReviewApi, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const res = new ResolutionPage(page, list);
    await tcMeta('TC_US079_64', 'High', TAGS, `ROOT (partner 1) prices ALBUM × FULL_CONSIGNMENT with R_A 12.50%; CT3 (MARGIN) and CT2 (ended 2030-12-31) price the same key under a second partner. P01 (ROOT) resolves to R_A alone, not Ambiguous; P21 (CT3) reads Not computable and P20 (CT2) No row applies with an empty rate — R_A of ROOT is never used across families. ${DEV} ${DATA}`);
    let s!: Seeded;
    const traces: Record<string, { status: number; body: Trace }> = {};
    const contracts: ContractDef[] = [
      ...family({ ROOT: ['R_A'] }),
      { key: 'CT3', partner: PARTNER2, rows: [row('R_CT3', { category: 'A', type: 'MARGIN', rate: 30 })] },
      { key: 'CT2', partner: PARTNER2, endAt: '2030-12-31T00:00:00Z', rows: [row('R_CT2', { category: 'A', rate: 12.5 })] },
    ];

    await step('Arrange: Pre-condition 1–13 — ROOT R_A (partner 1), CT3 MARGIN and CT2 ending 2030 (partner 2), products P01, P21, P20, verified RESOLVED / NOT_COMPUTABLE / NO_ROW', async () => {
      s = await seedData({
        tc: 64,
        contracts,
        cycles: ['CY_MAIN'],
        products: [product('P01', [{ cycle: 'CY_MAIN', saleLines: 3 }]), product('P21', [{ cycle: 'CY_MAIN', saleLines: 1 }]), product('P20', [{ cycle: 'CY_MAIN', saleLines: 1 }])],
      });
      await verifySeed(feeReviewApi, s, 11, 3, [
        { code: 'P01', status: 'RESOLVED' },
        { code: 'P21', status: 'NOT_COMPUTABLE' },
        { code: 'P20', status: 'NO_ROW' },
      ]);
    });

    await step('Act: Step 1 — Open the screen, select CY_MAIN and click chip 기간 내 판매 상품 (Products sold in period)', async () => {
      await res.openCycle(s.cycles.CY_MAIN.id);
    });

    await step('Assert: Expected 1 — The list of CY_MAIN opens with every product sold in the cycle', async () => {
      await expectCycleOpened(list, feeReviewApi, s.cycles.CY_MAIN);
    });

    await step('Act: Step 2 — Search P01 and read the NORMAL row', async () => {
      await res.searchByProductId(s.products.P01);
    });

    await step('Assert: Expected 2 — P01 reads 산정 완료 (Resolved) at 12.50%, not 중복 적용 (Ambiguous)', async () => {
      const r = list.row(s.products.P01);
      await expect.soft(list.statusPills(r).first(), '[Expected 2] 산정 상태 = 산정 완료 (Resolved), not 중복 적용').toHaveText(FR_KO['status.RESOLVED']);
      await expect.soft(list.cell(r, 'rate'), '[Expected 2] 산정 요율 = 12.50%').toHaveText('12.50%');
    });

    await step('Act: Step 3 — Click 근거 (Basis) and click 어떻게 결정됐는지 보기 (How this was decided)', async () => {
      await list.openBasis(list.row(s.products.P01));
      await list.basis.expandEvidence();
    });

    await step('Assert: Expected 3 — 검토된 수수료 행 lists R_A only; no row of C_CT3 or C_CT2', async () => {
      await expect.soft(list.basis.candidateRows, '[Expected 3] Exactly one row considered').toHaveCount(1);
      await expect.soft(res.candidate(s.family.contracts.ROOT, '12.50'), '[Expected 3] The row is R_A 12.50 of C_ROOT').toHaveCount(1);
      await expect.soft(list.basis.candidateRows.filter({ hasText: id(s.family.contracts.CT3) }), '[Expected 3] No row of C_CT3').toHaveCount(0);
      await expect.soft(list.basis.candidateRows.filter({ hasText: id(s.family.contracts.CT2) }), '[Expected 3] No row of C_CT2').toHaveCount(0);
    });

    await step('Act: Step 4 — Close the panel, search P21 and read the row', async () => {
      await list.basis.close();
      await res.searchByProductId(s.products.P21);
    });

    await step('Assert: Expected 4 — P21 reads 구간형 요율 — 산정 전 (Not computable); R_A of C_ROOT is not used', async () => {
      const r = list.row(s.products.P21);
      await expect.soft(list.statusPills(r).first(), '[Expected 4] 산정 상태 = 구간형 요율 — 산정 전 (Not computable)').toHaveText(FR_KO['status.NOT_COMPUTABLE']);
      await expect.soft(list.cell(r, 'rate'), '[Expected 4] No 12.50% from R_A of C_ROOT').toHaveText(EMPTY);
    });

    await step('Act: Step 5 — Search P20 and read the row', async () => {
      await res.searchByProductId(s.products.P20);
    });

    await step('Assert: Expected 5 — P20 reads 적용 행 없음 (No row applies) with an empty rate; R_A is not a fallback', async () => {
      const r = list.row(s.products.P20);
      await expect.soft(list.statusPills(r).first(), '[Expected 5] 산정 상태 = 적용 행 없음 (No row applies)').toHaveText(FR_KO['status.NO_ROW']);
      await expect.soft(list.cell(r, 'rate'), '[Expected 5] Empty rate — R_A of C_ROOT is not used as a fallback').toHaveText(EMPTY);
    });

    await step('Act: Step 6 — Call GET trace?policy=NORMAL for P01, P21 and P20', async () => {
      for (const code of ['P01', 'P21', 'P20']) traces[code] = await traceOf(feeReviewApi, s.cycles.CY_MAIN.id, s.products[code]);
    });

    await step('Assert: Expected 6 — HTTP 200: P01 [R_A] RESOLVED; P21 only the C_CT3 row NOT_COMPUTABLE; P20 [] NO_ROW', async () => {
      for (const code of ['P01', 'P21', 'P20']) expect.soft(traces[code].status, `[Expected 6] ${code} HTTP 200`).toBe(200);
      expect.soft((traces.P01.body.candidates ?? []).map((c) => id(c.feeRowId)), '[Expected 6] P01 candidates = [R_A]').toEqual([id(s.family.rows.R_A)]);
      expect.soft(traces.P01.body.status, '[Expected 6] P01 status = RESOLVED').toBe('RESOLVED');
      expect.soft((traces.P21.body.candidates ?? []).map((c) => id(c.feeRowId)), '[Expected 6] P21 candidates hold only the C_CT3 row').toEqual([id(s.family.rows.R_CT3)]);
      expect.soft(traces.P21.body.status, '[Expected 6] P21 status = NOT_COMPUTABLE').toBe('NOT_COMPUTABLE');
      expect.soft(traces.P20.body.candidates ?? [], '[Expected 6] P20 candidates = []').toHaveLength(0);
      expect.soft(traces.P20.body.status, '[Expected 6] P20 status = NO_ROW').toBe('NO_ROW');
    });
  });

  test('TC_US079_65 — Annex rows of the same family compete with the main contract rows', async ({ page, feeReviewApi, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const res = new ResolutionPage(page, list);
    await tcMeta('TC_US079_65', 'Medium', TAGS, `ROOT R_B10 10.00%, ANNEX1 R_B9 9.00%, ANNEX2 R_C22 only. P02 (bound to ROOT) sees both B rows — the derived key names the ROOT family, R_B9 (부속계약) is applied and the rate is 9.00%; re-binding P02 to ANNEX1 by SQL still lists R_B10 and R_B9 and gives 9.00% with contractFamilyId = C_ROOT. P02 is bound back to ROOT at the end. ${DEV} ${DATA}`);
    let s!: Seeded;
    let pid = '';
    let first: { status: number; body: Trace } = { status: 0, body: {} };
    let second: { status: number; body: Trace } = { status: 0, body: {} };
    let rebound = 0;

    await step('Arrange: Pre-condition 1–14 — ROOT R_B10, ANNEX1 R_B9, ANNEX2 R_C22 (no B row), product P02 (ROOT, slot R_B9), verified RESOLVED 9.00 MATCHES', async () => {
      s = await seedData({ tc: 65, contracts: family({ ROOT: ['R_B10'], ANNEX1: ['R_B9'], ANNEX2: ['R_C22'] }), cycles: ['CY_MAIN'], products: [product('P02', [{ cycle: 'CY_MAIN', saleLines: 40 }])] });
      pid = s.products.P02;
      await verifySeed(feeReviewApi, s, 12, 1, [{ code: 'P02', status: 'RESOLVED', rate: '9.00', verdict: 'MATCHES' }]);
    });

    await step('Act: Step 1 — Open the screen, select CY_MAIN and click chip 기간 내 판매 상품 (Products sold in period)', async () => {
      await res.openCycle(s.cycles.CY_MAIN.id);
    });

    await step('Assert: Expected 1 — The list of CY_MAIN opens with every product sold in the cycle', async () => {
      await expectCycleOpened(list, feeReviewApi, s.cycles.CY_MAIN);
    });

    await step('Act: Step 2 — Search P02, open 근거 (Basis) and click 어떻게 결정됐는지 보기 (How this was decided)', async () => {
      await res.searchByProductId(pid);
      await list.openBasis(list.row(pid));
      await list.basis.expandEvidence();
    });

    await step('Assert: Expected 2 — Derived key 계약 = C_ROOT family; R_B10 (C_ROOT) and R_B9 (부속계약) listed, R_B9 applied; rate 9.00%', async () => {
      await expect.soft(list.basis.value(list.basis.section('trace.keyTitle'), FR_KO['trace.kvContract']), '[Expected 2] 도출된 키 계약 (Contract) = C_ROOT family').toHaveText(id(s.family.contracts.ROOT));
      await expect.soft(res.candidate(s.family.contracts.ROOT, '10.00'), '[Expected 2] R_B10 10.00 (C_ROOT) is listed').toHaveCount(1);
      const b9 = res.candidate(s.family.contracts.ANNEX1, '9.00');
      await expect.soft(b9, '[Expected 2] R_B9 9.00 is tagged 부속계약 (Annex)').toContainText(FR_KO['trace.annex']);
      await expect.soft(b9, '[Expected 2] R_B9 is 적용 (applied)').toHaveText(ResolutionPage.APPLIED);
      await expect.soft(list.basis.headlineRate, '[Expected 2] rate = 9.00%').toHaveText('9.00%');
    });

    await step('Act: Step 3 — Call GET trace?policy=NORMAL for P02', async () => {
      first = await traceOf(feeReviewApi, s.cycles.CY_MAIN.id, pid);
    });

    await step('Assert: Expected 3 — HTTP 200: R_B9 (annex, won) and R_B10 (not annex, lost); contractFamilyId = C_ROOT', async () => {
      expect(first.status, '[Expected 3] HTTP 200').toBe(200);
      const b9 = candidateOf(first.body, s.family.rows.R_B9);
      const b10 = candidateOf(first.body, s.family.rows.R_B10);
      expect.soft(b9?.annex, '[Expected 3] R_B9 annex = true').toBe(true);
      expect.soft(b9?.won, '[Expected 3] R_B9 won = true').toBe(true);
      expect.soft(b10?.annex, '[Expected 3] R_B10 annex = false').toBe(false);
      expect.soft(b10?.won, '[Expected 3] R_B10 won = false').toBe(false);
      expect.soft(id(first.body.contractFamilyId), '[Expected 3] contractFamilyId = C_ROOT').toBe(id(s.family.contracts.ROOT));
    });

    await step('Act: Step 4 — UPDATE contract_id = C_ANNEX1 for P02, close the panel, search P02 again and open Basis', async () => {
      await feeReviewDb.updateProduct(pid, { contractId: s.family.contracts.ANNEX1 });
      await list.basis.close();
      await res.searchByProductId(pid);
      await list.openBasis(list.row(pid));
      await list.basis.expandEvidence();
    });

    await step('Assert: Expected 4 — The panel still lists R_B10 (C_ROOT) and R_B9 (C_ANNEX1) and shows 9.00%', async () => {
      await expect.soft(res.candidate(s.family.contracts.ROOT, '10.00'), '[Expected 4] R_B10 (C_ROOT) is still listed').toHaveCount(1);
      await expect.soft(res.candidate(s.family.contracts.ANNEX1, '9.00'), '[Expected 4] R_B9 (C_ANNEX1) is still listed').toHaveCount(1);
      await expect.soft(list.basis.headlineRate, '[Expected 4] The panel shows 9.00%').toHaveText('9.00%');
    });

    await step('Act: Step 5 — Call GET trace?policy=NORMAL for P02 again', async () => {
      await list.basis.close();
      second = await traceOf(feeReviewApi, s.cycles.CY_MAIN.id, pid);
    });

    await step('Assert: Expected 5 — HTTP 200: the same two candidates, inForceRate "9.00", contractFamilyId = C_ROOT', async () => {
      expect(second.status, '[Expected 5] HTTP 200').toBe(200);
      const ids = (second.body.candidates ?? []).map((c) => id(c.feeRowId)).sort();
      expect.soft(ids, '[Expected 5] The same two candidates R_B9 and R_B10').toEqual([id(s.family.rows.R_B9), id(s.family.rows.R_B10)].sort());
      expect.soft(second.body.inForceRate, '[Expected 5] inForceRate = "9.00"').toBe('9.00');
      expect.soft(id(second.body.contractFamilyId), '[Expected 5] contractFamilyId = C_ROOT').toBe(id(s.family.contracts.ROOT));
    });

    await step('Act: Step 6 — UPDATE contract_id = C_ROOT for P02', async () => {
      await feeReviewDb.updateProduct(pid, { contractId: s.family.contracts.ROOT });
      rebound = await countOf('SELECT COUNT(*) AS n FROM fee_review_fixture_product WHERE product_id = ? AND contract_id = ?', [pid, s.family.contracts.ROOT]);
    });

    await step('Assert: Expected 6 — 1 row updated; P02 is tied to C_ROOT again', async () => {
      expect(rebound, '[Expected 6] P02 is bound to C_ROOT again').toBe(1);
    });
  });

  test('TC_US079_66 — The list, the reason panel and the correction preview show the same rate', async ({ page, feeReviewApi, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const res = new ResolutionPage(page, list);
    const reason = reasonOf('TC_US079_66', '카테고리 오매핑 정정');
    await tcMeta('TC_US079_66', 'High', TAGS, `P14 (ROOT, ALBUM, slot R_A) shows 12.50% on the list, in Why this rate and in the Correct dialog's 계약에서 산정된 값; the category B option offers 9.00% (R_B9 of ANNEX1). Saving a tier-1 correction to B keeps 12.50% in force with 9.00% dimmed and the pill 수정됨 — 미상신; after 선택 일괄 상신 the pill reads 승인 대기 and 12.50% stays; the report row shows 12.50% → 9.00% and change_approval stores prev 12.50 / requested 9.00. Reason text is made traceable ([AUTO-US079] prefix + timestamp) around the TC wording. ${DEV} ${DATA}`);
    let s!: Seeded;
    let pid = '';
    let stored: RowDataPacket[] = [];

    await step('Arrange: Pre-condition 1–12 — ROOT R_A 12.50, ANNEX1 R_B9 9.00, product P14 (slot R_A, 234 sale lines), verified RESOLVED 12.50 MATCHES, no correction', async () => {
      s = await seedData({ tc: 66, contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      pid = s.products.P14;
      await verifySeed(feeReviewApi, s, 10, 1, [{ code: 'P14', status: 'RESOLVED', rate: '12.50', verdict: 'MATCHES' }]);
    });

    await step('Act: Step 1 — Open the screen, select CY_MAIN and click chip 기간 내 판매 상품 (Products sold in period)', async () => {
      await res.openCycle(s.cycles.CY_MAIN.id);
    });

    await step('Assert: Expected 1 — The list of CY_MAIN opens with every product sold in the cycle', async () => {
      await expectCycleOpened(list, feeReviewApi, s.cycles.CY_MAIN);
    });

    await step('Act: Step 2 — Search P14 and read the row', async () => {
      await res.searchByProductId(pid);
    });

    await step('Assert: Expected 2 — 산정 요율 = 12.50%', async () => {
      await expect(list.cell(list.row(pid), 'rate'), '[Expected 2] 산정 요율 = 12.50%').toHaveText('12.50%');
    });

    await step('Act: Step 3 — Click 근거 (Basis), read the rate', async () => {
      await list.openBasis(list.row(pid));
    });

    await step('Assert: Expected 3 — Why this rate shows 12.50%', async () => {
      await expect(list.basis.headlineRate, '[Expected 3] Why this rate shows 12.50%').toHaveText('12.50%');
    });

    await step('Act: Step 4 — Close the panel and click 수정 (Correct) on that row', async () => {
      await list.basis.close();
      await list.openCorrect(list.row(pid));
    });

    await step('Assert: Expected 4 — 계약에서 산정된 값 shows 12.50%; the option for category B shows 9.00%', async () => {
      await expect.soft(list.correct.contractValue('fix.kvRate'), '[Expected 4] 계약에서 산정된 값 산정 요율 = 12.50%').toHaveText('12.50%');
      const optionB = (await list.correct.optionTexts()).find((t) => t.startsWith(s.master.categoryName.B));
      expect.soft(optionB ?? '', `[Expected 4] The option for ${s.master.categoryName.B} shows 9.00%`).toContain('9.00%');
    });

    await step('Act: Step 5 — Pick category B, type the reason and click 저장 (Save)', async () => {
      await list.correct.pickCategory(s.master.categoryName.B);
      await list.correct.reasonInput.fill(reason);
      await list.correct.save();
      await expect(list.correct.root, 'The Correct dialog closes after saving').toHaveCount(0);
    });

    await step('Assert: Expected 5 — 12.50% stays in force with 9.00% dimmed beside it; second pill 수정됨 — 미상신', async () => {
      const rate = list.cell(list.row(pid), 'rate');
      await expect.soft(rate, '[Expected 5] 12.50% is still in force').toContainText('12.50%');
      await expect.soft(list.secondLine(rate), '[Expected 5] 9.00% is shown beside it').toContainText('9.00%');
      await expect.soft(list.statusPills(list.row(pid)).nth(1), '[Expected 5] Second pill = 수정됨 — 미상신 (Corrected — not submitted)').toHaveText(FR_KO['state.DRAFT']);
    });

    await step('Act: Step 6 — Tick the row of P14 and click 선택 일괄 상신 (Submit selected)', async () => {
      await list.rowCheckbox(list.row(pid)).check();
      const submitted = await list.submitSelected();
      expect(submitted.status(), 'POST corrections/submit succeeds').toBeLessThan(300);
    });

    await step('Assert: Expected 6 — Second pill 승인 대기 (Awaiting approval); 산정 요율 still 12.50%', async () => {
      await expect.soft(list.statusPills(list.row(pid)).nth(1), '[Expected 6] Second pill = 승인 대기 (Awaiting approval)').toHaveText(FR_KO['state.PENDING']);
      await expect.soft(list.cell(list.row(pid), 'rate'), '[Expected 6] 산정 요율 still shows 12.50%').toContainText('12.50%');
    });

    await step('Act: Step 7 — Click 이번 기 수정 내역 (Changes this period) and read the row of P14', async () => {
      await list.openReport();
      await list.report.showLatest();
    });

    await step('Assert: Expected 7 — The report row shows 요율 변동 (Rate change) 12.50% → 9.00%', async () => {
      const reportRow = list.report.rows.filter({ hasText: pid });
      await expect.soft(list.report.cell(reportRow.first(), 'rate'), '[Expected 7] 요율 변동 from 12.50% to 9.00%').toContainText(/12\.50%\s*→\s*9\.00%/);
    });

    await step('Act: Step 8 — SELECT prev_value, requested_value FROM change_approval for CY_MAIN / P14 / NORMAL', async () => {
      await list.report.close();
      stored = await feeReviewDb.query<RowDataPacket[]>('SELECT prev_value, requested_value FROM change_approval WHERE target_ref = ?', [`${s.cycles.CY_MAIN.id}/${pid}/NORMAL`]);
    });

    await step('Assert: Expected 8 — prev_value rate = 12.50 (the in-force figure), requested_value rate = 9.00', async () => {
      expect(stored, '[Expected 8] One approval record for P14').toHaveLength(1);
      expect.soft(storedRate(stored[0]?.prev_value), '[Expected 8] prev_value rate = 12.50').toBe(12.5);
      expect.soft(storedRate(stored[0]?.requested_value), '[Expected 8] requested_value rate = 9.00').toBe(9);
    });
  });

  test('TC_US079_67 — Resolving a page in one call gives the same result as resolving each product alone', async ({ feeReviewApi, seedData }) => {
    await tcMeta('TC_US079_67', 'Medium', TAGS, `API-only: 13 rows (P01 NORMAL + PROMOTION, P02, P03, P04, P05, P06, P09 PROMOTION, P10, P12, P13, P14 and the target-only P99) are listed in one call with 8 NEEDS_REVIEW and 5 RESOLVED_CLEANLY; each row's status, inForceRate, inForceCategory, basisContractId and verdict equal its own trace, and paging the list by 5 returns the same values. ${DEV} ${DATA}`);
    const step = makeApiStep(feeReviewApi);
    let s!: Seeded;
    let whole: Awaited<ReturnType<FeeReviewApi['products']>> | undefined;
    const traces = new Map<string, { status: number; body: Trace }>();
    const drift: string[] = [];
    const paged: Array<Record<string, unknown>> = [];
    const keyOf = (r: { productId?: unknown; policy?: unknown }) => `${String(r.productId)}/${String(r.policy)}`;
    const FIELDS = ['status', 'inForceRate', 'inForceCategory', 'basisContractId', 'verdict'] as const;
    const asRecord = (v: unknown): Record<string, unknown> => (v ?? {}) as Record<string, unknown>;

    await step('Arrange: Pre-condition 1–13 — ROOT (R_A, R_B10, R_PROMO, R_E11), ANNEX1 (R_B9, R_C20), ANNEX2 (R_C22), 12 products + target-only P99, no correction', async () => {
      s = await seedData({
        tc: 67,
        contracts: family({ ROOT: ['R_A', 'R_B10', 'R_PROMO', 'R_E11'], ANNEX1: ['R_B9', 'R_C20'], ANNEX2: ['R_C22'] }),
        cycles: ['CY_MAIN'],
        products: [
          product('P01', [{ cycle: 'CY_MAIN', saleLines: 3 }, { cycle: 'CY_MAIN', policy: 'PROMOTION', saleLines: 2 }]),
          product('P02', [{ cycle: 'CY_MAIN', saleLines: 40 }]),
          product('P03', [{ cycle: 'CY_MAIN', saleLines: 77 }]),
          product('P04', [{ cycle: 'CY_MAIN', saleLines: 114 }]),
          product('P05', [{ cycle: 'CY_MAIN', saleLines: 151 }]),
          product('P06', [{ cycle: 'CY_MAIN', saleLines: 188 }]),
          product('P09', [{ cycle: 'CY_MAIN', saleLines: 49 }]),
          product('P10', [{ cycle: 'CY_MAIN', saleLines: 86 }]),
          product('P12', [{ cycle: 'CY_MAIN', saleLines: 160 }]),
          product('P13', [{ cycle: 'CY_MAIN', saleLines: 197 }]),
          product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }]),
        ],
      });
      await feeReviewDb.insertTargets([{ cycleId: s.cycles.CY_MAIN.id, productId: `${s.prefix}P99`, policy: 'NORMAL', saleLineCount: 5 }]);
      await verifySeed(feeReviewApi, s, 12, 13, []);
    });

    await step('Act: Step 1 — GET products?keyword=T079-<RUN>-67&size=100', async () => {
      whole = await feeReviewApi.products(s.cycles.CY_MAIN.id, { keyword: s.prefix, size: 100 });
    });

    await step('Assert: Expected 1 — HTTP 200, totalElements 13: NEEDS_REVIEW 8, RESOLVED_CLEANLY 5', async () => {
      expect(whole?.totalElements, '[Expected 1] totalElements = 13').toBe(13);
      expect.soft(whole?.content.filter((r) => r.bucket === 'NEEDS_REVIEW').length, '[Expected 1] NEEDS_REVIEW = 8').toBe(8);
      expect.soft(whole?.content.filter((r) => r.bucket === 'RESOLVED_CLEANLY').length, '[Expected 1] RESOLVED_CLEANLY = 5').toBe(5);
    });

    await step('Act: Step 2 — GET trace?policy={policy} for each of the 13 rows', async () => {
      for (const r of whole?.content ?? []) traces.set(keyOf(r), await traceOf(feeReviewApi, s.cycles.CY_MAIN.id, r.productId, r.policy));
    });

    await step('Assert: Expected 2 — HTTP 200 for each call', async () => {
      expect(traces.size, '[Expected 2] One trace per listed row').toBe(13);
      for (const [key, t] of traces) expect.soft(t.status, `[Expected 2] ${key} trace HTTP 200`).toBe(200);
    });

    await step('Act: Step 3 — Compare status, inForceRate, inForceCategory, basisContractId and verdict of each row with its trace', async () => {
      for (const r of whole?.content ?? []) {
        const listed = asRecord(r);
        const traced = asRecord(traces.get(keyOf(r))?.body);
        for (const f of FIELDS) if (id(listed[f]) !== id(traced[f])) drift.push(`${keyOf(r)} ${f}: list "${id(listed[f])}" vs trace "${id(traced[f])}"`);
      }
    });

    await step('Assert: Expected 3 — All values identical for every row (e.g. P02 RESOLVED 9.00 MATCHES, P04 AMBIGUOUS null NOT_ASSIGNED, P09 RESOLVED 9.50 MATCHES, P12 NO_ROW null NOT_ASSIGNED)', async () => {
      expect.soft(drift, '[Expected 3] No field differs between the list and the trace').toEqual([]);
      const sample: Array<[string, Policy, string, string | null, string]> = [
        ['P02', 'NORMAL', 'RESOLVED', '9.00', 'MATCHES'],
        ['P04', 'NORMAL', 'AMBIGUOUS', null, 'NOT_ASSIGNED'],
        ['P09', 'PROMOTION', 'RESOLVED', '9.50', 'MATCHES'],
        ['P12', 'NORMAL', 'NO_ROW', null, 'NOT_ASSIGNED'],
      ];
      for (const [code, policy, status, rate, verdict] of sample) {
        const r = whole?.content.find((x) => x.productId === `${s.prefix}${code}` && x.policy === policy);
        expect.soft([r?.status, r?.inForceRate ?? null, r?.verdict], `[Expected 3] ${code} ${policy} = ${status} ${rate} ${verdict}`).toEqual([status, rate, verdict]);
      }
    });

    await step('Act: Step 4 — GET products?size=5 for page 0, 1 and 2', async () => {
      for (const p of [0, 1, 2]) paged.push(...(await feeReviewApi.products(s.cycles.CY_MAIN.id, { keyword: s.prefix, size: 5, page: p })).content.map(asRecord));
    });

    await step('Assert: Expected 4 — Every row has the same values as in step 1, whatever the page size', async () => {
      expect.soft(paged.length, '[Expected 4] The 3 pages hold the 13 rows').toBe(13);
      for (const r of paged) {
        const base = whole?.content.find((x) => keyOf(x) === keyOf(r));
        expect.soft(base, `[Expected 4] ${keyOf(r)} is also in the step 1 list`).toBeDefined();
        for (const f of FIELDS) expect.soft(id(r[f]), `[Expected 4] ${keyOf(r)} ${f} unchanged`).toBe(id(asRecord(base)[f]));
      }
    });
  });

  test('TC_US079_68 — The verdict reads Matches when commerce assigned the winning row', async ({ page, feeReviewApi, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const res = new ResolutionPage(page, list);
    await tcMeta('TC_US079_68', 'Medium', TAGS, `P01 (slot R_A, winner R_A) and P02 (slot R_B9, annex winner R_B9 over R_B10) both read 일치 on the list; the panel of P01 shows the flag 일치 with the note 지정된 행과 산정된 행이 같습니다.; the trace reads MATCHES with assignedFeeRowId R_A / R_B9. ${DEV} ${DATA}`);
    let s!: Seeded;
    const traces: Record<string, { status: number; body: Trace }> = {};

    await step('Arrange: Pre-condition 1–12 — ROOT (R_A, R_B10), ANNEX1 R_B9, products P01 (slot R_A) and P02 (slot R_B9), verified 12.50 / 9.00 MATCHES', async () => {
      s = await seedData({ tc: 68, contracts: family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P01', [{ cycle: 'CY_MAIN', saleLines: 3 }]), product('P02', [{ cycle: 'CY_MAIN', saleLines: 40 }])] });
      await verifySeed(feeReviewApi, s, 10, 2, [
        { code: 'P01', rate: '12.50', verdict: 'MATCHES' },
        { code: 'P02', rate: '9.00', verdict: 'MATCHES' },
      ]);
    });

    await step('Act: Step 1 — Open the screen, select CY_MAIN and click chip 기간 내 판매 상품 (Products sold in period)', async () => {
      await res.openCycle(s.cycles.CY_MAIN.id);
    });

    await step('Assert: Expected 1 — The list of CY_MAIN opens with every product sold in the cycle', async () => {
      await expectCycleOpened(list, feeReviewApi, s.cycles.CY_MAIN);
    });

    await step('Act: Step 2 — Search P01 and read the NORMAL row', async () => {
      await res.searchByProductId(s.products.P01);
    });

    await step('Assert: Expected 2 — 지정 대조 = 일치 (Matches)', async () => {
      await expect(list.cell(list.row(s.products.P01), 'compare'), '[Expected 2] 지정 대조 = 일치 (Matches)').toHaveText(FR_KO['compare.MATCHES']);
    });

    await step('Act: Step 3 — Click 근거 (Basis) and read 현재 지정된 행 (Currently assigned)', async () => {
      await list.openBasis(list.row(s.products.P01));
    });

    await step('Assert: Expected 3 — The flag reads 일치 (Matches) with the note 지정된 행과 산정된 행이 같습니다.', async () => {
      await expect.soft(res.assignedFlag, '[Expected 3] Flag = 일치 (Matches)').toHaveText(FR_KO['trace.flagOk']);
      await expect.soft(res.assignedBlock, '[Expected 3] Note "The assigned row and the resolved row are the same."').toContainText(FR_KO['trace.noteOk']);
    });

    await step('Act: Step 4 — Close the panel, search P02 and read the row', async () => {
      await list.basis.close();
      await res.searchByProductId(s.products.P02);
    });

    await step('Assert: Expected 4 — 지정 대조 = 일치 (Matches): the annex winner R_B9 is the assigned row', async () => {
      await expect(list.cell(list.row(s.products.P02), 'compare'), '[Expected 4] 지정 대조 = 일치 (Matches)').toHaveText(FR_KO['compare.MATCHES']);
    });

    await step('Act: Step 5 — Call GET trace?policy=NORMAL for P01 and P02', async () => {
      traces.P01 = await traceOf(feeReviewApi, s.cycles.CY_MAIN.id, s.products.P01);
      traces.P02 = await traceOf(feeReviewApi, s.cycles.CY_MAIN.id, s.products.P02);
    });

    await step('Assert: Expected 5 — HTTP 200: P01 MATCHES / assignedFeeRowId R_A; P02 MATCHES / assignedFeeRowId R_B9', async () => {
      for (const code of ['P01', 'P02']) expect.soft(traces[code].status, `[Expected 5] ${code} HTTP 200`).toBe(200);
      expect.soft(traces.P01.body.verdict, '[Expected 5] P01 verdict = MATCHES').toBe('MATCHES');
      expect.soft(id(traces.P01.body.assignedFeeRowId), '[Expected 5] P01 assignedFeeRowId = R_A').toBe(id(s.family.rows.R_A));
      expect.soft(traces.P02.body.verdict, '[Expected 5] P02 verdict = MATCHES').toBe('MATCHES');
      expect.soft(id(traces.P02.body.assignedFeeRowId), '[Expected 5] P02 assignedFeeRowId = R_B9').toBe(id(s.family.rows.R_B9));
    });
  });

  test('TC_US079_69 — A promotion winner is compared with the promotion slot only', async ({ page, feeReviewApi, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const res = new ResolutionPage(page, list);
    await tcMeta('TC_US079_69', 'Medium', TAGS, `P09 (PROMOTION target, promotion slot R_PROMO, no default slot) resolves to R_PROMO 9.50% and reads 일치; the panel shows 프로모션 수수료 = R_PROMO marked 대조 대상 and 기본 수수료 = 지정 없음 not compared; pointing the default slot at R_E11 by SQL keeps 일치 (the default slot is ignored); the slot is reset to NULL. Deviation: the dev panel renders no 기본 / 프로모션 slots (01/10, one 지정된 행 value only) — the slot assertions of Expected 3 are expected to fail. ${DEV} ${DATA}`);
    let s!: Seeded;
    let pid = '';
    let trace: { status: number; body: Trace } = { status: 0, body: {} };
    let reset = 0;

    await step('Arrange: Pre-condition 1–11 — ROOT (R_PROMO, R_E11), product P09 (promotion slot R_PROMO, PROMOTION target), verified RESOLVED 9.50 MATCHES', async () => {
      s = await seedData({ tc: 69, contracts: family({ ROOT: ['R_PROMO', 'R_E11'] }), cycles: ['CY_MAIN'], products: [product('P09', [{ cycle: 'CY_MAIN', saleLines: 49 }])] });
      pid = s.products.P09;
      await verifySeed(feeReviewApi, s, 9, 1, [{ code: 'P09', policy: 'PROMOTION', status: 'RESOLVED', rate: '9.50', verdict: 'MATCHES' }]);
    });

    await step('Act: Step 1 — Open the screen, select CY_MAIN and click chip 기간 내 판매 상품 (Products sold in period)', async () => {
      await res.openCycle(s.cycles.CY_MAIN.id);
    });

    await step('Assert: Expected 1 — The list of CY_MAIN opens with every product sold in the cycle', async () => {
      await expectCycleOpened(list, feeReviewApi, s.cycles.CY_MAIN);
    });

    await step('Act: Step 2 — Search P09 and read the PROMOTION row', async () => {
      await res.searchByProductId(pid);
    });

    await step('Assert: Expected 2 — 산정 요율 = 9.50% and 지정 대조 = 일치 (Matches)', async () => {
      await expect.soft(list.cell(list.row(pid), 'rate'), '[Expected 2] 산정 요율 = 9.50%').toHaveText('9.50%');
      await expect.soft(list.cell(list.row(pid), 'compare'), '[Expected 2] 지정 대조 = 일치 (Matches)').toHaveText(FR_KO['compare.MATCHES']);
    });

    await step('Act: Step 3 — Click 근거 (Basis) and read 현재 지정된 행 (Currently assigned)', async () => {
      await list.openBasis(list.row(pid));
    });

    await step('Assert: Expected 3 — 프로모션 수수료 holds R_PROMO, marked 대조 대상; 기본 수수료 reads 지정 없음, not compared; flag 일치', async () => {
      const promo = res.slot(RES_TC.slotPromotion);
      const dflt = res.slot(RES_TC.slotDefault);
      await expect.soft(promo, '[Expected 3] 프로모션 수수료 (Promotion fee) holds R_PROMO').toContainText(id(s.family.rows.R_PROMO));
      await expect.soft(promo, '[Expected 3] 프로모션 수수료 is marked 대조 대상 (compared)').toContainText(RES_TC.slotCompared);
      await expect.soft(dflt, '[Expected 3] 기본 수수료 (Default fee) reads 지정 없음 (Not assigned)').toContainText(FR_KO['trace.flagNone']);
      await expect.soft(dflt, '[Expected 3] 기본 수수료 is not marked compared').not.toContainText(RES_TC.slotCompared);
      await expect.soft(res.assignedFlag, '[Expected 3] Flag = 일치 (Matches)').toHaveText(FR_KO['trace.flagOk']);
    });

    await step('Act: Step 4 — UPDATE default_slot_fee_row_id = R_E11 for P09, close the panel and search P09 again', async () => {
      await feeReviewDb.updateProduct(pid, { defaultSlotFeeRowId: s.family.rows.R_E11 });
      await list.basis.close();
      await res.searchByProductId(pid);
    });

    await step('Assert: Expected 4 — The row still reads 일치 (Matches): the default slot R_E11 is ignored', async () => {
      await expect(list.cell(list.row(pid), 'compare'), '[Expected 4] 지정 대조 still 일치 (Matches)').toHaveText(FR_KO['compare.MATCHES']);
    });

    await step('Act: Step 5 — Call GET trace?policy=PROMOTION for P09', async () => {
      trace = await traceOf(feeReviewApi, s.cycles.CY_MAIN.id, pid, 'PROMOTION');
    });

    await step('Assert: Expected 5 — HTTP 200: verdict MATCHES, assignedFeeRowId R_PROMO', async () => {
      expect(trace.status, '[Expected 5] HTTP 200').toBe(200);
      expect.soft(trace.body.verdict, '[Expected 5] verdict = MATCHES').toBe('MATCHES');
      expect.soft(id(trace.body.assignedFeeRowId), '[Expected 5] assignedFeeRowId = R_PROMO').toBe(id(s.family.rows.R_PROMO));
    });

    await step('Act: Step 6 — UPDATE default_slot_fee_row_id = NULL for P09', async () => {
      await feeReviewDb.updateProduct(pid, { defaultSlotFeeRowId: null });
      reset = await countOf('SELECT COUNT(*) AS n FROM fee_review_fixture_product WHERE product_id = ? AND default_slot_fee_row_id IS NULL', [pid]);
    });

    await step('Assert: Expected 6 — 1 row updated; the default slot of P09 is NULL again', async () => {
      expect(reset, '[Expected 6] The default slot of P09 is NULL again').toBe(1);
    });
  });

  test('TC_US079_70 — A slot pointing at a retired fee row reads Mismatch and shows the assigned row', async ({ page, feeReviewApi, contractsApi, approverContractsApi, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const res = new ResolutionPage(page, list);
    await tcMeta('TC_US079_70', 'Medium', TAGS, `P03 (slot R_B10, winner R_B9 9.00%) reads 불일치; after R_B10 is deactivated through the fee-row status API (TOKEN_B approves if gated) the row still reads 불일치 at 9.00% and shows the assigned row R_B10; the panel's 기본 수수료 shows 수수료ID R_B10 / 행 상태 INACTIVE with the flag 불일치 and the inactive-row note; the products API reads MISMATCH, assignedFeeRowId R_B10, assignedCategory = inForceCategory, problem ASSIGNED_NE_RESOLVED. Deviation: the dev list row and panel show no slot / fee ID / row status (01/10) — "the row shows R_B10" and the 기본 수수료 assertions are expected to fail. ${DEV} ${DATA} The contract family is private to this TC; R_B10 stays INACTIVE (reactivating would add a new row).`);
    let s!: Seeded;
    let pid = '';
    let statuses: number[] = [];
    let api: Record<string, unknown> | undefined;
    let rowStatus: string | undefined;

    await step('Arrange: Pre-condition 1–12 — ROOT R_B10, ANNEX1 R_B9, product P03 (slot R_B10), verified RESOLVED 9.00 MISMATCH, no correction', async () => {
      s = await seedData({ tc: 70, private: true, contracts: family({ ROOT: ['R_B10'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P03', [{ cycle: 'CY_MAIN', saleLines: 77 }])] });
      pid = s.products.P03;
      await verifySeed(feeReviewApi, s, 10, 1, [{ code: 'P03', status: 'RESOLVED', rate: '9.00', verdict: 'MISMATCH' }]);
    });

    await step('Act: Step 1 — Open the screen, select CY_MAIN and click chip 기간 내 판매 상품 (Products sold in period)', async () => {
      await res.openCycle(s.cycles.CY_MAIN.id);
    });

    await step('Assert: Expected 1 — The list of CY_MAIN opens with every product sold in the cycle', async () => {
      await expectCycleOpened(list, feeReviewApi, s.cycles.CY_MAIN);
    });

    await step('Act: Step 2 — Search P03 and read the row', async () => {
      await res.searchByProductId(pid);
    });

    await step('Assert: Expected 2 — 산정 요율 = 9.00% and 지정 대조 = 불일치 (Mismatch)', async () => {
      await expect.soft(list.cell(list.row(pid), 'rate'), '[Expected 2] 산정 요율 = 9.00%').toHaveText('9.00%');
      await expect.soft(list.cell(list.row(pid), 'compare'), '[Expected 2] 지정 대조 = 불일치 (Mismatch)').toHaveText(FR_KO['compare.MISMATCH']);
    });

    await step('Act: Step 3 — Deactivate R_B10 (PUT …/fee-rows/R_B10/status INACTIVE; TOKEN_B approves when gated)', async () => {
      statuses = await deactivate(contractsApi, approverContractsApi, s.family.contracts.ROOT, s.family.rows.R_B10, '[T079] retire assigned row');
      rowStatus = (await contractsApi.feeRows(s.family.contracts.ROOT)).find((r) => r.id === s.family.rows.R_B10)?.status;
    });

    await step('Assert: Expected 3 — HTTP 200 (approval 200); R_B10 status = INACTIVE', async () => {
      statuses.forEach((status, i) => expect.soft(status, `[Expected 3] Call ${i + 1} returns HTTP 200`).toBe(200));
      expect.soft(rowStatus, '[Expected 3] fee-rows?includeInactive=true shows R_B10 INACTIVE').toBe('INACTIVE');
    });

    await step('Act: Step 4 — Search P03 again and read the row', async () => {
      await res.searchByProductId(pid);
    });

    await step('Assert: Expected 4 — Still 불일치 (Mismatch) at 9.00%; the row shows the assigned fee row R_B10', async () => {
      const r = list.row(pid);
      await expect.soft(list.cell(r, 'compare'), '[Expected 4] 지정 대조 still 불일치 (Mismatch)').toHaveText(FR_KO['compare.MISMATCH']);
      await expect.soft(list.cell(r, 'rate'), '[Expected 4] 산정 요율 still 9.00%').toHaveText('9.00%');
      await expect.soft(r, '[Expected 4] The row shows the assigned fee row R_B10').toContainText(id(s.family.rows.R_B10));
    });

    await step('Act: Step 5 — Click 근거 (Basis) and read 현재 지정된 행 (Currently assigned)', async () => {
      await list.openBasis(list.row(pid));
    });

    await step('Assert: Expected 5 — 기본 수수료: 수수료ID = R_B10, 행 상태 = INACTIVE; flag 불일치 with the inactive-row note', async () => {
      const dflt = res.slot(RES_TC.slotDefault);
      await expect.soft(res.slotValue(dflt, RES_TC.slotFeeId), '[Expected 5] 기본 수수료 수수료ID (Fee ID) = R_B10').toHaveText(id(s.family.rows.R_B10));
      await expect.soft(res.slotValue(dflt, RES_TC.slotRowStatus), '[Expected 5] 기본 수수료 행 상태 (Row status) = INACTIVE').toHaveText('INACTIVE');
      await expect.soft(res.assignedFlag, '[Expected 5] Flag = 불일치 (Mismatch)').toHaveText(FR_KO['trace.flagDiff']);
      await expect.soft(res.assignedBlock, '[Expected 5] Note: the assigned row may already be inactive — corrected on 「수수료 관리」').toContainText(FR_KO['trace.noteDiff']);
    });

    await step('Act: Step 6 — Call GET products?keyword=T079-<RUN>-70-P03', async () => {
      await list.basis.close();
      api = (await feeReviewApi.products(s.cycles.CY_MAIN.id, { keyword: pid })).content.find((r) => r.productId === pid) as unknown as Record<string, unknown> | undefined;
    });

    await step('Assert: Expected 6 — HTTP 200: MISMATCH, assignedFeeRowId R_B10, assignedCategory = inForceCategory (B), problems include ASSIGNED_NE_RESOLVED', async () => {
      expect(api, '[Expected 6] The P03 row is returned').toBeDefined();
      expect.soft(api?.verdict, '[Expected 6] verdict = MISMATCH').toBe('MISMATCH');
      expect.soft(id(api?.assignedFeeRowId), '[Expected 6] assignedFeeRowId = R_B10').toBe(id(s.family.rows.R_B10));
      expect.soft(api?.assignedCategory, '[Expected 6] assignedCategory = inForceCategory').toBe(api?.inForceCategory);
      expect.soft(api?.inForceCategory, `[Expected 6] inForceCategory = ${s.master.categoryName.B}`).toBe(s.master.categoryName.B);
      expect.soft((api?.problems as string[] | undefined) ?? [], '[Expected 6] problems include ASSIGNED_NE_RESOLVED').toContain('ASSIGNED_NE_RESOLVED');
    });

    await step('Act: Step 7 — Call GET contracts/C_ROOT/fee-rows?includeInactive=true', async () => {
      rowStatus = (await contractsApi.feeRows(s.family.contracts.ROOT)).find((r) => r.id === s.family.rows.R_B10)?.status;
    });

    await step('Assert: Expected 7 — R_B10 is still INACTIVE', async () => {
      expect(rowStatus, '[Expected 7] R_B10 is still INACTIVE').toBe('INACTIVE');
    });
  });

  test('TC_US079_71 — A product commerce assigned nothing reads Not assigned and not Mismatch', async ({ page, feeReviewApi, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const res = new ResolutionPage(page, list);
    await tcMeta('TC_US079_71', 'Medium', TAGS, `P05 (no slot, winner R_A 12.50%) reads 산정 완료 / 12.50% / 지정 없음 — not 불일치; the TC then expects P05 to be listed under the 지정 ↔ 산정 불일치 chip (asserted as written although it contradicts the title — flagged for BA review); the panel flag reads 지정 없음 with the note 커머스에 지정된 수수료 행이 없습니다.; the trace reads NOT_ASSIGNED with assignedFeeRowId null. ${DEV} ${DATA}`);
    let s!: Seeded;
    let pid = '';
    let trace: { status: number; body: Trace } = { status: 0, body: {} };

    await step('Arrange: Pre-condition 1–11 — ROOT R_A, product P05 (no slot, 151 sale lines), verified RESOLVED 12.50 NOT_ASSIGNED', async () => {
      s = await seedData({ tc: 71, contracts: family({ ROOT: ['R_A'] }), cycles: ['CY_MAIN'], products: [product('P05', [{ cycle: 'CY_MAIN', saleLines: 151 }])] });
      pid = s.products.P05;
      await verifySeed(feeReviewApi, s, 9, 1, [{ code: 'P05', status: 'RESOLVED', rate: '12.50', verdict: 'NOT_ASSIGNED' }]);
    });

    await step('Act: Step 1 — Open the screen, select CY_MAIN and click chip 기간 내 판매 상품 (Products sold in period)', async () => {
      await res.openCycle(s.cycles.CY_MAIN.id);
    });

    await step('Assert: Expected 1 — The list of CY_MAIN opens with every product sold in the cycle', async () => {
      await expectCycleOpened(list, feeReviewApi, s.cycles.CY_MAIN);
    });

    await step('Act: Step 2 — Search P05 and read the row', async () => {
      await res.searchByProductId(pid);
    });

    await step('Assert: Expected 2 — 산정 완료 (Resolved), 12.50%, 지정 없음 (Not assigned) — not 불일치 (Mismatch)', async () => {
      const r = list.row(pid);
      await expect.soft(list.statusPills(r).first(), '[Expected 2] 산정 상태 = 산정 완료 (Resolved)').toHaveText(FR_KO['status.RESOLVED']);
      await expect.soft(list.cell(r, 'rate'), '[Expected 2] 산정 요율 = 12.50%').toHaveText('12.50%');
      await expect.soft(list.cell(r, 'compare'), '[Expected 2] 지정 대조 = 지정 없음 (Not assigned), not 불일치').toHaveText(FR_KO['compare.NOT_ASSIGNED']);
    });

    await step('Act: Step 3 — Click chip 지정 ↔ 산정 불일치 (Assigned ≠ resolved)', async () => {
      await list.clickChip(list.chip('bucket.DIFF'));
    });

    await step('Assert: Expected 3 — P05 is listed in this bucket', async () => {
      await expect.soft(list.row(pid), '[Expected 3] P05 is listed under 지정 ↔ 산정 불일치 (as the TC states)').toBeVisible();
    });

    await step('Act: Step 4 — Click 근거 (Basis) on the row of P05 and read 현재 지정된 행 (Currently assigned)', async () => {
      // Nhánh theo trạng thái thật: P05 không nằm trong bucket DIFF → quay về 기간 내 판매 상품 để vẫn mở được 근거.
      if ((await list.row(pid).count()) === 0) await list.clickChip(list.chip('bucket.ALL'));
      await list.openBasis(list.row(pid));
    });

    await step('Assert: Expected 4 — Flag 지정 없음 (Not assigned) with the note 커머스에 지정된 수수료 행이 없습니다.', async () => {
      await expect.soft(res.assignedFlag, '[Expected 4] Flag = 지정 없음 (Not assigned)').toHaveText(FR_KO['trace.flagNone']);
      await expect.soft(res.assignedBlock, '[Expected 4] Note "Commerce holds no assigned fee row."').toContainText(FR_KO['trace.noteNone']);
    });

    await step('Act: Step 5 — Call GET trace?policy=NORMAL for P05', async () => {
      await list.basis.close();
      trace = await traceOf(feeReviewApi, s.cycles.CY_MAIN.id, pid);
    });

    await step('Assert: Expected 5 — HTTP 200: verdict NOT_ASSIGNED, assignedFeeRowId null', async () => {
      expect(trace.status, '[Expected 5] HTTP 200').toBe(200);
      expect.soft(trace.body.verdict, '[Expected 5] verdict = NOT_ASSIGNED').toBe('NOT_ASSIGNED');
      expect.soft(trace.body.assignedFeeRowId ?? null, '[Expected 5] assignedFeeRowId = null').toBeNull();
    });
  });

  test('TC_US079_72 — No screen action writes a resolved rate back to storage', async ({ page, feeReviewApi, contractsApi, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const res = new ResolutionPage(page, list);
    await tcMeta('TC_US079_72', 'Medium', TAGS, `Opening the list, Why this rate (P02), the Correct dialog without saving (P14), the history (P14), exporting the list and reloading write nothing: fee_correction / fee_correction_history counts, the fixture product rows and the contract commission values (id, rate, status) are the same before and after; the time label reads 산정 시각 {time} — 열 때마다 새로 산정됩니다 and moves forward on reload while the rates stay. Deviation: the TC reads the commission values with a Mongo find — the suite has no Mongo access, so GET /contracts/{id}/fee-rows?includeInactive=true (ROOT + ANNEX1) is used; the label shows minutes only, so "later" is checked on the products response computedAt and the label is checked not to go back. ${DEV} ${DATA}`);
    let s!: Seeded;
    const like = () => `${s.prefix}%`;
    type Snapshot = { corrections: number; history: number; products: string; commissions: string };
    let before: Snapshot | undefined;
    let after: Snapshot | undefined;
    let firstLabel = '';
    let firstAt = '';
    let secondAt = '';
    let fileName = '';
    const obs3 = new Observations(page);
    const obs4 = new Observations(page);
    const obs5 = new Observations(page);
    let correctionsAfterCancel = -1;

    const snapshot = async (): Promise<Snapshot> => ({
      corrections: await countOf('SELECT COUNT(*) AS n FROM fee_correction WHERE product_id LIKE ?', [like()]),
      history: await countOf('SELECT COUNT(*) AS n FROM fee_correction_history WHERE product_id LIKE ?', [like()]),
      products: JSON.stringify(await feeReviewDb.query<RowDataPacket[]>('SELECT * FROM fee_review_fixture_product WHERE product_id LIKE ? ORDER BY product_id', [like()])),
      commissions: JSON.stringify(
        (await Promise.all([s.family.contracts.ROOT, s.family.contracts.ANNEX1].map((c) => contractsApi.feeRows(c)))).flat().map((r) => ({ id: r.id, commission: r.commission, status: r.status })),
      ),
    });
    const labelTime = (text: string) => /(\d{1,2}:\d{2})/.exec(text)?.[1] ?? '';
    const computedAt = async (response: { json: () => Promise<unknown> }) => String(((await response.json()) as { computedAt?: string }).computedAt ?? '');

    await step('Arrange: Pre-condition 1–12 — ROOT R_A, ANNEX1 R_B9, products P02 (slot R_B9) and P14 (slot R_A), verified 9.00 / 12.50, no correction', async () => {
      s = await seedData({ tc: 72, contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P02', [{ cycle: 'CY_MAIN', saleLines: 40 }]), product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      await verifySeed(feeReviewApi, s, 10, 2, [
        { code: 'P02', rate: '9.00' },
        { code: 'P14', rate: '12.50' },
      ]);
    });

    await step('Act: Step 1 — Record fee_correction / history counts, the fixture product rows and the contract commission values', async () => {
      before = await snapshot();
    });

    await step('Assert: Expected 1 — Counts, product rows and commission values are noted', async () => {
      expect(before?.corrections, '[Expected 1] fee_correction count noted (0)').toBe(0);
      expect.soft(before?.history, '[Expected 1] fee_correction_history count noted (0)').toBe(0);
      expect.soft(JSON.parse(before?.products ?? '[]'), '[Expected 1] 2 product rows noted').toHaveLength(2);
      expect.soft(JSON.parse(before?.commissions ?? '[]'), '[Expected 1] Commission values of ROOT + ANNEX1 noted').toHaveLength(2);
    });

    await step('Act: Step 2 — Open the screen, select CY_MAIN, click chip 기간 내 판매 상품 and read the time label', async () => {
      firstAt = await computedAt(await list.untilListed(() => list.open({ cycleId: s.cycles.CY_MAIN.id })));
      await list.clickChip(list.chip('bucket.ALL'));
      firstLabel = ((await list.resolvedAtLabel.textContent()) ?? '').trim();
    });

    await step('Assert: Expected 2 — The label reads 산정 시각 {time} — 열 때마다 새로 산정됩니다 (Resolved at {time} — recomputed on every open)', async () => {
      await expect(list.resolvedAtLabel, '[Expected 2] 산정 시각 {time} — 열 때마다 새로 산정됩니다').toHaveText(/^산정 시각 \d{1,2}:\d{2} — 열 때마다 새로 산정됩니다$/);
    });

    await step('Act: Step 3 — Click 근거 (Basis) on P02 and close the panel', async () => {
      await list.openBasis(list.row(s.products.P02));
      await obs3.record('[Expected 3] Why this rate opened', () => list.basis.root.isVisible());
      await list.basis.close();
      await obs3.record('[Expected 3] Why this rate closed', async () => (await list.basis.root.count()) === 0);
    });

    await step('Assert: Expected 3 — The panel opens and closes', async () => {
      obs3.assertAll();
    });

    await step('Act: Step 4 — Click 수정 (Correct) on P14 and close the dialog without saving', async () => {
      await list.openCorrect(list.row(s.products.P14));
      await obs4.record('[Expected 4] The Correct dialog opened', () => list.correct.root.isVisible());
      await list.correct.cancel();
      await obs4.record('[Expected 4] The Correct dialog closed', async () => (await list.correct.root.count()) === 0);
      correctionsAfterCancel = await countOf('SELECT COUNT(*) AS n FROM fee_correction WHERE product_id LIKE ?', [like()]);
    });

    await step('Assert: Expected 4 — The dialog opens and closes; nothing is saved', async () => {
      obs4.assertAll();
      expect.soft(correctionsAfterCancel, '[Expected 4] Nothing is saved (fee_correction count unchanged)').toBe(before?.corrections);
    });

    await step('Act: Step 5 — Click 이력 (History) on P14 and close it', async () => {
      await list.openHistory(list.row(s.products.P14));
      await obs5.record('[Expected 5] The history dialog opened', () => list.history.root.isVisible());
      await list.history.close();
      await obs5.record('[Expected 5] The history dialog closed', async () => (await list.history.root.count()) === 0);
    });

    await step('Assert: Expected 5 — The history dialog opens and closes', async () => {
      obs5.assertAll();
    });

    await step('Act: Step 6 — Click 목록 내보내기 (Export list) and click 내려받기 (Download)', async () => {
      await list.openExport();
      fileName = (await list.exporter.download()).suggestedFilename();
    });

    await step('Assert: Expected 6 — The file downloads', async () => {
      expect(fileName, '[Expected 6] A file is downloaded').toMatch(/\.(xlsx|csv)$/);
    });

    await step('Act: Step 7 — Reload the screen and read the time label again', async () => {
      secondAt = await computedAt(await res.reload());
    });

    await step('Assert: Expected 7 — The time is later than in step 2; the rates are unchanged', async () => {
      expect.soft(secondAt > firstAt, `[Expected 7] Resolved again later (computedAt ${firstAt} → ${secondAt})`).toBe(true);
      const second = labelTime(((await list.resolvedAtLabel.textContent()) ?? '').trim());
      expect.soft(second >= labelTime(firstLabel), `[Expected 7] The label time does not go back (${labelTime(firstLabel)} → ${second})`).toBe(true);
      await expect.soft(list.cell(list.row(s.products.P02), 'rate'), '[Expected 7] P02 still 9.00%').toHaveText('9.00%');
      await expect.soft(list.cell(list.row(s.products.P14), 'rate'), '[Expected 7] P14 still 12.50%').toHaveText('12.50%');
    });

    await step('Act: Step 8 — Run the queries of step 1 again', async () => {
      after = await snapshot();
    });

    await step('Assert: Expected 8 — Same counts, product rows and commission values: no resolved rate was written anywhere', async () => {
      expect.soft(after?.corrections, '[Expected 8] Same fee_correction count').toBe(before?.corrections);
      expect.soft(after?.history, '[Expected 8] Same fee_correction_history count').toBe(before?.history);
      expect.soft(after?.products, '[Expected 8] Same fixture product rows').toBe(before?.products);
      expect.soft(after?.commissions, '[Expected 8] Same commission values').toBe(before?.commissions);
    });
  });

  test('TC_US079_73 — A closed cycle keeps showing its stamped rates after the contract changes', async ({ page, feeReviewApi, contractsApi, approverContractsApi, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const res = new ResolutionPage(page, list);
    await tcMeta('TC_US079_73', 'High', TAGS, `P03 (ROOT R_B10 10.00%, annex winner R_B9 9.00%) is listed only in CY_CLOSE; after closing CY_CLOSE the row shows 9.00% and the label 마감된 기간 — 요율이 확정·스탬프되었습니다; after R_B9 is deactivated the row and Why this rate must still show the stamped 9.00%, not 10.00%. Deviation (stated by the TC, DEV-35): US012 stamping is not built — a closed cycle re-resolves on every read, so Expected 5 is expected to fail (10.00%). Deviation: CY_MAIN, CY_CLOSE and CY_NEXT are consecutive free months instead of <Y>-03 / -06 / -08. ${DEV} ${DATA} Family and cycles are private to this TC; R_B9 stays INACTIVE.`);
    let s!: Seeded;
    let pid = '';
    let closed = 0;
    let cycleStatus: string | undefined;
    let statuses: number[] = [];
    let b9Status: string | undefined;

    await step('Arrange: Pre-condition 1–13 — ROOT R_B10, ANNEX1 R_B9, cycles CY_MAIN / CY_CLOSE / CY_NEXT (open), product P03 (slot R_B10) targeted in CY_CLOSE only, verified 9.00', async () => {
      s = await seedData({ tc: 73, private: true, contracts: family({ ROOT: ['R_B10'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN', 'CY_CLOSE', 'CY_NEXT'], products: [product('P03', [{ cycle: 'CY_CLOSE', saleLines: 77 }])] });
      pid = s.products.P03;
      await verifySeed(feeReviewApi, s, 11, 1, [{ code: 'P03', rate: '9.00' }], 'CY_CLOSE');
      const cycles = await feeReviewApi.cycles();
      for (const key of ['CY_CLOSE', 'CY_NEXT']) expect.soft(cycles.find((c) => c.cycleId === s.cycles[key].id)?.status, `[Pre-condition 11] ${key} is OPEN`).toBe('OPEN');
    });

    await step('Act: Step 1 — Open the screen, select CY_CLOSE, click 기간 내 판매 상품, search P03 and read the row', async () => {
      await res.openCycle(s.cycles.CY_CLOSE.id);
      await res.searchByProductId(pid);
    });

    await step('Assert: Expected 1 — The row of P03 shows 산정 요율 = 9.00%', async () => {
      await expect(list.cell(list.row(pid), 'rate'), '[Expected 1] 산정 요율 = 9.00%').toHaveText('9.00%');
    });

    await step('Act: Step 2 — POST settlement-cycles/CY_CLOSE/close', async () => {
      closed = (await feeReviewApi.closeCycle(s.cycles.CY_CLOSE.id)).status;
      cycleStatus = (await feeReviewApi.cycles()).find((c) => c.cycleId === s.cycles.CY_CLOSE.id)?.status;
    });

    await step('Assert: Expected 2 — HTTP 200; CY_CLOSE status = CLOSED', async () => {
      expect(closed, '[Expected 2] HTTP 200').toBe(200);
      expect.soft(cycleStatus, '[Expected 2] CY_CLOSE status = CLOSED').toBe('CLOSED');
    });

    await step('Act: Step 3 — Reload the screen, select CY_CLOSE, search P03 and read the row and the time label', async () => {
      await res.openCycle(s.cycles.CY_CLOSE.id);
      await res.searchByProductId(pid);
    });

    await step('Assert: Expected 3 — 9.00%; the label reads 마감된 기간 — 요율이 확정·스탬프되었습니다 (Closed period — rates are fixed and stamped)', async () => {
      await expect.soft(list.cell(list.row(pid), 'rate'), '[Expected 3] The row shows 9.00%').toHaveText('9.00%');
      await expect.soft(list.resolvedAtLabel, '[Expected 3] 마감된 기간 — 요율이 확정·스탬프되었습니다').toHaveText(FR_KO['lbl.resolvedAtClosed']);
    });

    await step('Act: Step 4 — Deactivate R_B9 after the close (TOKEN_B approves when gated)', async () => {
      statuses = await deactivate(contractsApi, approverContractsApi, s.family.contracts.ANNEX1, s.family.rows.R_B9, '[T079] change after close');
      b9Status = (await contractsApi.feeRows(s.family.contracts.ANNEX1)).find((r) => r.id === s.family.rows.R_B9)?.status;
    });

    await step('Assert: Expected 4 — HTTP 200 (approval 200); R_B9 status = INACTIVE', async () => {
      statuses.forEach((status, i) => expect.soft(status, `[Expected 4] Call ${i + 1} returns HTTP 200`).toBe(200));
      expect.soft(b9Status, '[Expected 4] R_B9 status = INACTIVE').toBe('INACTIVE');
    });

    await step('Act: Step 5 — Reload, select CY_CLOSE, search P03, read the row and click 근거 (Basis)', async () => {
      await res.openCycle(s.cycles.CY_CLOSE.id);
      await res.searchByProductId(pid);
      await list.openBasis(list.row(pid));
    });

    await step('Assert: Expected 5 — The row and Why this rate still show the stamped 9.00%, not 10.00%', async () => {
      await expect.soft(list.cell(list.row(pid), 'rate'), '[Expected 5] The row still shows the stamped 9.00%').toHaveText('9.00%');
      await expect.soft(list.basis.headlineRate, '[Expected 5] Why this rate still shows the stamped 9.00%, not 10.00%').toHaveText('9.00%');
    });

    await step('Act: Step 6 — GET contracts/C_ANNEX1/fee-rows?includeInactive=true', async () => {
      await list.basis.close();
      b9Status = (await contractsApi.feeRows(s.family.contracts.ANNEX1)).find((r) => r.id === s.family.rows.R_B9)?.status;
    });

    await step('Assert: Expected 6 — R_B9 is still INACTIVE', async () => {
      expect(b9Status, '[Expected 6] R_B9 is still INACTIVE').toBe('INACTIVE');
    });
  });

  test('TC_US079_74 — A winning fixed-amount fee row is shown as the SRS defines', async ({ page, feeReviewApi, contractsApi, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const res = new ResolutionPage(page, list);
    await tcMeta('TC_US079_74', 'Medium', TAGS, `CT4 holds one FIXED_UNIT row (500) for FANCLUB_KIT × FULL_CONSIGNMENT; P22 reads 산정 완료 with an empty rate (500 is never shown as a per cent), Why this rate shows no rate for the CT4 row, and the trace reads RESOLVED, inForceRate null, candidate rate null, emptyRateCause null. Deviation: the shared seed only builds PERCENT / MARGIN rows, so CT4 is created with the TC body through POST /contracts in Arrange and P22 is bound to it by SQL. ${DEV} ${DATA}`);
    let s!: Seeded;
    let pid = '';
    let ct4 = 0;
    let rowCt4 = 0;
    let trace: { status: number; body: Trace } = { status: 0, body: {} };

    await step('Arrange: Pre-condition 1–11 — CT4 with the FIXED_UNIT row R_CT4 (500), product P22 bound to CT4 (1 sale line), verified RESOLVED with no rate', async () => {
      s = await seedData({ tc: 74, contracts: [], cycles: ['CY_MAIN'], products: [product('P22', [{ cycle: 'CY_MAIN', saleLines: 1 }], { contract: null })] });
      pid = s.products.P22;
      const created = await contractsApi.createContractRaw({
        bizPartnerId: PARTNER,
        artists: [{ id: 1, name: '[T079] artist' }],
        contractName: `[T079-${RUN}-74] CT4`,
        contractSignedAt: null,
        contractStartAt: '2020-01-01T00:00:00Z',
        contractEndAt: '9999-12-31T00:00:00Z',
        internalApproveDocumentUrl: 'https://approval.example.com/T079',
        labelTypeId: s.master.label,
        businessModelTypeId: s.master.businessModel,
        regionType: 'DOMESTIC',
        commissions: [{ categoryId: s.master.category.B, saleTypeId: s.master.saleType.ST1, commissionPolicy: 'NORMAL', commissionType: 'FIXED_UNIT', commission: 500, pgCommissionRate: 0, status: 'ACTIVE' }],
      });
      expect(created.status, '[Pre-condition 4] CT4 is created (201)').toBe(201);
      ct4 = created.body.id;
      rowCt4 = (await contractsApi.feeRows(ct4)).find((r) => r.commissionType === 'FIXED_UNIT')?.id ?? 0;
      expect(rowCt4, '[Pre-condition 5] R_CT4 (FIXED_UNIT) exists').toBeGreaterThan(0);
      await feeReviewDb.updateProduct(pid, { contractId: ct4 });
      await verifySeed(feeReviewApi, s, 9, 1, [{ code: 'P22', status: 'RESOLVED', rate: null }]);
    });

    await step('Act: Step 1 — Open the screen, select CY_MAIN and click chip 기간 내 판매 상품 (Products sold in period)', async () => {
      await res.openCycle(s.cycles.CY_MAIN.id);
    });

    await step('Assert: Expected 1 — The list of CY_MAIN opens with every product sold in the cycle', async () => {
      await expectCycleOpened(list, feeReviewApi, s.cycles.CY_MAIN);
    });

    await step('Act: Step 2 — Search P22 and read the row', async () => {
      await res.searchByProductId(pid);
    });

    await step('Assert: Expected 2 — 산정 완료 (Resolved) with an empty rate — 500 is not shown as a per cent', async () => {
      const r = list.row(pid);
      await expect.soft(list.statusPills(r).first(), '[Expected 2] 산정 상태 = 산정 완료 (Resolved)').toHaveText(FR_KO['status.RESOLVED']);
      await expect.soft(list.cell(r, 'rate'), '[Expected 2] 산정 요율 is empty').toHaveText(EMPTY);
      await expect.soft(r, '[Expected 2] 500 is not shown as a per cent').not.toContainText('500%');
    });

    await step('Act: Step 3 — Click 근거 (Basis) on that row', async () => {
      await list.openBasis(list.row(pid));
      await list.basis.expandEvidence();
    });

    await step('Assert: Expected 3 — Why this rate shows no rate for the C_CT4 row', async () => {
      await expect.soft(list.basis.headlineRate, '[Expected 3] No rate in the panel').toHaveText(EMPTY);
      const row4 = list.basis.candidateRows.filter({ hasText: id(ct4) });
      await expect.soft(row4, '[Expected 3] The C_CT4 row is listed').toHaveCount(1);
      await expect.soft(row4, '[Expected 3] The C_CT4 row shows no rate').not.toContainText('%');
    });

    await step('Act: Step 4 — Call GET trace?policy=NORMAL for P22', async () => {
      await list.basis.close();
      trace = await traceOf(feeReviewApi, s.cycles.CY_MAIN.id, pid);
    });

    await step('Assert: Expected 4 — HTTP 200: RESOLVED, inForceRate null, the C_CT4 candidate rate null, emptyRateCause null', async () => {
      expect(trace.status, '[Expected 4] HTTP 200').toBe(200);
      expect.soft(trace.body.status, '[Expected 4] status = RESOLVED').toBe('RESOLVED');
      expect.soft(trace.body.inForceRate ?? null, '[Expected 4] inForceRate = null').toBeNull();
      expect.soft(candidateOf(trace.body, rowCt4)?.rate ?? null, '[Expected 4] The C_CT4 candidate has rate = null').toBeNull();
      expect.soft(trace.body.emptyRateCause ?? null, '[Expected 4] emptyRateCause = null').toBeNull();
    });
  });
});

test.describe('[Why This Rate] The reason panel', () => {
  test.describe.configure({ timeout: 300_000 });

  test('TC_US079_75 — The panel opens with the rate in force, its contract and effective date before the reasoning', async ({ page, feeReviewApi, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const res = new ResolutionPage(page, list);
    await tcMeta('TC_US079_75', 'High', BASIS_TAGS, `ROOT has no row and ANNEX1 holds R_B9 9.00%; for P02 the first block of Why this rate shows 9.00%, 계약 행, 계약 = C_ANNEX1, 정책 NORMAL, 적용 시작일 2020-01-01; 어떻게 결정됐는지 보기 is collapsed with no reasoning panel visible until clicked, then the three panels open below the answer block; the trace reads 9.00 / C_ANNEX1 / 2020-01-01 / rateFromCorrection false. ${DEV} ${DATA}`);
    let s!: Seeded;
    let pid = '';
    let trace: { status: number; body: Trace } = { status: 0, body: {} };

    await step('Arrange: Pre-condition 1–12 — ROOT (no row), ANNEX1 R_B9 9.00, product P02 (slot R_B9), verified RESOLVED 9.00, no correction', async () => {
      s = await seedData({ tc: 75, contracts: family({ ROOT: [], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P02', [{ cycle: 'CY_MAIN', saleLines: 40 }])] });
      pid = s.products.P02;
      await verifySeed(feeReviewApi, s, 10, 1, [{ code: 'P02', status: 'RESOLVED', rate: '9.00' }]);
    });

    await step('Act: Step 1 — Open the screen, select CY_MAIN and click chip 기간 내 판매 상품 (Products sold in period)', async () => {
      await res.openCycle(s.cycles.CY_MAIN.id);
    });

    await step('Assert: Expected 1 — The list of CY_MAIN opens with every product sold in the cycle', async () => {
      await expectCycleOpened(list, feeReviewApi, s.cycles.CY_MAIN);
    });

    await step('Act: Step 2 — Search the product ID of P02', async () => {
      await res.searchByProductId(pid);
    });

    await step('Assert: Expected 2 — The row of P02 is shown', async () => {
      await expect(list.row(pid), `[Expected 2] The row of ${pid} is shown`).toBeVisible();
    });

    await step('Act: Step 3 — Click 근거 (Basis) on the row of P02', async () => {
      await list.openBasis(list.row(pid));
    });

    await step('Assert: Expected 3 — The first block shows 9.00%, 계약 행, 계약 = C_ANNEX1, 정책 = NORMAL, 적용 시작일 = 2020-01-01', async () => {
      await expect.soft(list.basis.headlineRate, '[Expected 3] The rate 9.00%').toHaveText('9.00%');
      await expect.soft(res.sourceLabel('trace.fromContract'), '[Expected 3] 계약 행 (from a contract row)').toBeVisible();
      await expect.soft(res.answerValue('trace.kvContract'), '[Expected 3] 계약 (Contract) = C_ANNEX1').toHaveText(id(s.family.contracts.ANNEX1));
      await expect.soft(res.answerValue('trace.kvPolicy'), '[Expected 3] 정책 (Policy) = NORMAL').toHaveText('NORMAL');
      await expect.soft(res.answerValue('trace.kvEffective'), '[Expected 3] 적용 시작일 (Effective from) = 2020-01-01').toHaveText('2020-01-01');
    });

    await step('Act: Step 4 — Look at the block under the rate', async () => {
      await list.basis.evidenceToggle.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — How this was decided is collapsed; 도출된 키, 검토된 수수료 행 and 우선순위 적용 단계 are not visible', async () => {
      await expect.soft(list.basis.evidenceToggle, '[Expected 4] 어떻게 결정됐는지 보기 is collapsed').toHaveAttribute('aria-expanded', 'false');
      for (const { name, locator } of res.reasoning()) await expect.soft(locator, `[Expected 4] ${name} is not visible`).toBeHidden();
    });

    await step('Act: Step 5 — Click 어떻게 결정됐는지 보기 (How this was decided)', async () => {
      await list.basis.expandEvidence();
    });

    await step('Assert: Expected 5 — The three reasoning panels expand below the answer block', async () => {
      const answerTop = await topOf(res.answerBlock);
      for (const { name, locator } of res.reasoning()) {
        await expect.soft(locator, `[Expected 5] ${name} is visible`).toBeVisible();
        expect.soft((await topOf(locator)) > answerTop, `[Expected 5] ${name} is below the answer block`).toBe(true);
      }
    });

    await step('Act: Step 6 — Call GET trace?policy=NORMAL for P02', async () => {
      await list.basis.close();
      trace = await traceOf(feeReviewApi, s.cycles.CY_MAIN.id, pid);
    });

    await step('Assert: Expected 6 — HTTP 200: inForceRate "9.00", basisContractId C_ANNEX1, basisEffectiveFrom 2020-01-01, rateFromCorrection false', async () => {
      expect(trace.status, '[Expected 6] HTTP 200').toBe(200);
      expect.soft(trace.body.inForceRate, '[Expected 6] inForceRate = "9.00"').toBe('9.00');
      expect.soft(id(trace.body.basisContractId), '[Expected 6] basisContractId = C_ANNEX1').toBe(id(s.family.contracts.ANNEX1));
      expect.soft(trace.body.basisEffectiveFrom, '[Expected 6] basisEffectiveFrom = 2020-01-01').toBe('2020-01-01');
      expect.soft(trace.body.rateFromCorrection, '[Expected 6] rateFromCorrection = false').toBe(false);
    });
  });

  test('TC_US079_76 — The reasoning lists every candidate row, marks the winner and names the deciding step', async ({ page, feeReviewApi, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const res = new ResolutionPage(page, list);
    await tcMeta('TC_US079_76', 'Medium', BASIS_TAGS, `For P02 (ROOT R_B10 10.00%, ANNEX1 R_B9 9.00%) the derived key reads B / FULL_CONSIGNMENT / NORMAL / the ROOT family; R_B9 (부속계약) is applied and R_B10 not applied with the reason it was set aside, no row outside the ROOT family; the ladder lists 정책, 계층, 더 늦은 유효 시작일, 더 늦은 계약 기간 시작일 in that order with 계층 decided here; the trace reads HIERARCHY with the annex / won flags. Deviation: dev renders no not-applied reason and only the deciding ladder step (01/10) — those assertions are expected to fail. ${DEV} ${DATA}`);
    let s!: Seeded;
    let pid = '';
    let trace: { status: number; body: Trace } = { status: 0, body: {} };

    await step('Arrange: Pre-condition 1–12 — ROOT R_B10, ANNEX1 R_B9, product P02 (slot R_B9), verified RESOLVED 9.00', async () => {
      s = await seedData({ tc: 76, contracts: family({ ROOT: ['R_B10'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P02', [{ cycle: 'CY_MAIN', saleLines: 40 }])] });
      pid = s.products.P02;
      await verifySeed(feeReviewApi, s, 10, 1, [{ code: 'P02', status: 'RESOLVED', rate: '9.00' }]);
    });

    await step('Act: Step 1 — Open the screen, select CY_MAIN and click chip 기간 내 판매 상품 (Products sold in period)', async () => {
      await res.openCycle(s.cycles.CY_MAIN.id);
    });

    await step('Assert: Expected 1 — The list of CY_MAIN opens with every product sold in the cycle', async () => {
      await expectCycleOpened(list, feeReviewApi, s.cycles.CY_MAIN);
    });

    await step('Act: Step 2 — Search the product ID of P02', async () => {
      await res.searchByProductId(pid);
    });

    await step('Assert: Expected 2 — The row of P02 is shown', async () => {
      await expect(list.row(pid), `[Expected 2] The row of ${pid} is shown`).toBeVisible();
    });

    await step('Act: Step 3 — Click 근거 (Basis) and click 어떻게 결정됐는지 보기 (How this was decided)', async () => {
      await list.openBasis(list.row(pid));
      await list.basis.expandEvidence();
    });

    await step('Assert: Expected 3 — Why this rate opens with the three reasoning panels', async () => {
      for (const { name, locator } of res.reasoning()) await expect.soft(locator, `[Expected 3] ${name} is shown`).toBeVisible();
    });

    await step('Act: Step 4 — Read 도출된 키 (Derived key)', async () => {
      await list.basis.section('trace.keyTitle').scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — 수수료 카테고리 = B, 판매유형 = FULL_CONSIGNMENT, 정책 = NORMAL, 계약 = C_ROOT family', async () => {
      const key = list.basis.section('trace.keyTitle');
      await expect.soft(list.basis.value(key, FR_KO['trace.kvCategory']), `[Expected 4] 수수료 카테고리 = ${s.master.categoryName.B}`).toContainText(s.master.categoryName.B);
      await expect.soft(list.basis.value(key, FR_KO['trace.kvSale']), '[Expected 4] 판매유형 = FULL_CONSIGNMENT').toHaveText('FULL_CONSIGNMENT');
      await expect.soft(list.basis.value(key, FR_KO['trace.kvPolicy']), '[Expected 4] 정책 = NORMAL').toHaveText('NORMAL');
      await expect.soft(list.basis.value(key, FR_KO['trace.kvContract']), '[Expected 4] 계약 = C_ROOT family').toHaveText(id(s.family.contracts.ROOT));
    });

    await step('Act: Step 5 — Read 검토된 수수료 행 (Rows considered)', async () => {
      await list.basis.section('trace.candTitle').scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 5 — R_B9 (부속계약) applied; R_B10 not applied with a reason; no row outside the C_ROOT family', async () => {
      const b9 = res.candidate(s.family.contracts.ANNEX1, '9.00');
      await expect.soft(b9, '[Expected 5] R_B9 9.00 (C_ANNEX1) is marked 적용 (applied)').toHaveText(ResolutionPage.APPLIED);
      await expect.soft(b9, '[Expected 5] R_B9 is tagged 부속계약 (Annex)').toContainText(FR_KO['trace.annex']);
      const b10 = res.candidate(s.family.contracts.ROOT, '10.00');
      await expect.soft(b10, '[Expected 5] R_B10 10.00 (C_ROOT) is marked 미적용 (not applied)').toHaveText(ResolutionPage.NOT_APPLIED);
      // Phần còn lại sau badge + "계약 … · policy · rate · 적용 시작일 yyyy-mm-dd" = lý do bị loại.
      const reasonText = ((await b10.first().innerText().catch(() => '')) ?? '').replace(ResolutionPage.NOT_APPLIED, '').replace(/계약[\s\S]*?적용 시작일\s*\d{4}-\d{2}-\d{2}/, '').trim();
      expect.soft(reasonText, '[Expected 5] R_B10 shows the reason it was set aside').not.toBe('');
      const family = [id(s.family.contracts.ROOT), id(s.family.contracts.ANNEX1)];
      const texts = await list.basis.candidateRows.allInnerTexts();
      expect.soft(texts.every((t) => family.some((c) => t.includes(c))), '[Expected 5] No row of a contract outside the C_ROOT family is listed').toBe(true);
    });

    await step('Act: Step 6 — Read 우선순위 적용 단계 (Precedence applied)', async () => {
      await list.basis.section('trace.ladderTitle').scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 6 — Steps listed in order 정책, 계층, 더 늦은 유효 시작일, 더 늦은 계약 기간 시작일; Hierarchy is 여기서 결정됨', async () => {
      const texts = await list.basis.ladderSteps.allInnerTexts();
      const tiers = ['trace.tierPOLICY', 'trace.tierHIERARCHY', 'trace.tierEFFECTIVE_FROM', 'trace.tierPERIOD_FROM'] as const;
      const positions = tiers.map((k) => texts.findIndex((t) => t.includes(FR_KO[k])));
      tiers.forEach((k, i) => expect.soft(positions[i], `[Expected 6] ${FR_KO[k]} is listed`).toBeGreaterThanOrEqual(0));
      expect.soft(positions, '[Expected 6] The steps are listed in ladder order').toEqual([...positions].sort((a, b) => a - b));
      await expect.soft(res.decidingStep, '[Expected 6] 계층 — 부속계약이 본계약보다 우선 is 여기서 결정됨 (Decided here)').toContainText(FR_KO['trace.tierHIERARCHY']);
    });

    await step('Act: Step 7 — Call GET trace?policy=NORMAL for P02', async () => {
      await list.basis.close();
      trace = await traceOf(feeReviewApi, s.cycles.CY_MAIN.id, pid);
    });

    await step('Assert: Expected 7 — HTTP 200: decidingTier HIERARCHY; R_B9 annex / won, R_B10 not annex / lost', async () => {
      expect(trace.status, '[Expected 7] HTTP 200').toBe(200);
      expect.soft(trace.body.decidingTier, '[Expected 7] decidingTier = HIERARCHY').toBe('HIERARCHY');
      const b9 = candidateOf(trace.body, s.family.rows.R_B9);
      const b10 = candidateOf(trace.body, s.family.rows.R_B10);
      expect.soft([b9?.annex, b9?.won], '[Expected 7] R_B9 annex = true, won = true').toEqual([true, true]);
      expect.soft([b10?.annex, b10?.won], '[Expected 7] R_B10 annex = false, won = false').toEqual([false, false]);
    });
  });

  test('TC_US079_77 — The assignment section shows both slots and which one was compared', async ({ page, feeReviewApi, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const res = new ResolutionPage(page, list);
    await tcMeta('TC_US079_77', 'Medium', BASIS_TAGS, `현재 지정된 행 shows the 기본 수수료 and 프로모션 수수료 slots and marks the compared one: P02 (NORMAL winner R_B9) compares the default slot R_B9 → 일치; P09 (PROMOTION winner R_PROMO) compares the promotion slot R_PROMO → 일치; P04 (tie, no winner) compares the empty default slot → 지정 없음. Deviation (stated by the TC): the dev panel renders no slots (01/10) — the slot assertions are expected to fail; the verdict assertions run on the real flag. ${DEV} ${DATA}`);
    let s!: Seeded;
    const pidOf = (code: string) => s.products[code];

    await step('Arrange: Pre-condition 1–13 — ROOT (R_B10, R_PROMO), ANNEX1 (R_B9, R_C20), ANNEX2 R_C22, products P02 (slot R_B9), P09 (promo slot R_PROMO), P04 (no slot)', async () => {
      s = await seedData({
        tc: 77,
        contracts: family({ ROOT: ['R_B10', 'R_PROMO'], ANNEX1: ['R_B9', 'R_C20'], ANNEX2: ['R_C22'] }),
        cycles: ['CY_MAIN'],
        products: [product('P02', [{ cycle: 'CY_MAIN', saleLines: 40 }]), product('P09', [{ cycle: 'CY_MAIN', saleLines: 49 }]), product('P04', [{ cycle: 'CY_MAIN', saleLines: 114 }])],
      });
      await verifySeed(feeReviewApi, s, 11, 3, [
        { code: 'P02', rate: '9.00' },
        { code: 'P09', policy: 'PROMOTION', rate: '9.50' },
        { code: 'P04', status: 'AMBIGUOUS' },
      ]);
    });

    await step('Act: Step 1 — Open the screen, select CY_MAIN and click chip 기간 내 판매 상품 (Products sold in period)', async () => {
      await res.openCycle(s.cycles.CY_MAIN.id);
    });

    await step('Assert: Expected 1 — The list of CY_MAIN opens with every product sold in the cycle', async () => {
      await expectCycleOpened(list, feeReviewApi, s.cycles.CY_MAIN);
    });

    await step('Act: Step 2 — Search P02, click 근거 (Basis) and read 현재 지정된 행 (Currently assigned)', async () => {
      await res.searchByProductId(pidOf('P02'));
      await list.openBasis(list.row(pidOf('P02')));
    });

    await step('Assert: Expected 2 — 기본 수수료 holds R_B9 and is marked 대조 대상; 프로모션 수수료 reads 지정 없음; verdict 일치', async () => {
      const dflt = res.slot(RES_TC.slotDefault);
      const promo = res.slot(RES_TC.slotPromotion);
      await expect.soft(dflt, '[Expected 2] 기본 수수료 (Default fee) holds R_B9').toContainText(id(s.family.rows.R_B9));
      await expect.soft(dflt, '[Expected 2] 기본 수수료 is marked 대조 대상 (compared)').toContainText(RES_TC.slotCompared);
      await expect.soft(promo, '[Expected 2] 프로모션 수수료 (Promotion fee) reads 지정 없음 (Not assigned)').toContainText(FR_KO['trace.flagNone']);
      await expect.soft(res.assignedFlag, '[Expected 2] The verdict reads 일치 (Matches)').toHaveText(FR_KO['trace.flagOk']);
    });

    await step('Act: Step 3 — Close the panel, search P09, click Basis on the PROMOTION row and read Currently assigned', async () => {
      await list.basis.close();
      await res.searchByProductId(pidOf('P09'));
      await list.openBasis(list.row(pidOf('P09')));
    });

    await step('Assert: Expected 3 — Default fee 지정 없음, not compared; Promotion fee holds R_PROMO, compared; verdict Matches', async () => {
      const dflt = res.slot(RES_TC.slotDefault);
      const promo = res.slot(RES_TC.slotPromotion);
      await expect.soft(dflt, '[Expected 3] 기본 수수료 reads 지정 없음 (Not assigned)').toContainText(FR_KO['trace.flagNone']);
      await expect.soft(dflt, '[Expected 3] 기본 수수료 is not marked compared').not.toContainText(RES_TC.slotCompared);
      await expect.soft(promo, '[Expected 3] 프로모션 수수료 holds R_PROMO').toContainText(id(s.family.rows.R_PROMO));
      await expect.soft(promo, '[Expected 3] 프로모션 수수료 is marked 대조 대상 (compared)').toContainText(RES_TC.slotCompared);
      await expect.soft(res.assignedFlag, '[Expected 3] The verdict reads 일치 (Matches)').toHaveText(FR_KO['trace.flagOk']);
    });

    await step('Act: Step 4 — Close the panel, search P04, click Basis and read Currently assigned', async () => {
      await list.basis.close();
      await res.searchByProductId(pidOf('P04'));
      await list.openBasis(list.row(pidOf('P04')));
    });

    await step('Assert: Expected 4 — Both slots 지정 없음; Default fee marked compared; verdict 지정 없음 (Not assigned)', async () => {
      const dflt = res.slot(RES_TC.slotDefault);
      const promo = res.slot(RES_TC.slotPromotion);
      await expect.soft(dflt, '[Expected 4] 기본 수수료 reads 지정 없음').toContainText(FR_KO['trace.flagNone']);
      await expect.soft(promo, '[Expected 4] 프로모션 수수료 reads 지정 없음').toContainText(FR_KO['trace.flagNone']);
      await expect.soft(dflt, '[Expected 4] 기본 수수료 is marked 대조 대상 (compared)').toContainText(RES_TC.slotCompared);
      await expect.soft(res.assignedFlag, '[Expected 4] The verdict reads 지정 없음 (Not assigned)').toHaveText(FR_KO['trace.flagNone']);
    });
  });

  test('TC_US079_78 — A correction in force shows the corrected category with a marker and what the contract still resolves', async ({ page, feeReviewApi, approverFeeReviewApi, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const res = new ResolutionPage(page, list);
    const reason = reasonOf('TC_US079_78', '카테고리 오매핑 정정');
    await tcMeta('TC_US079_78', 'High', BASIS_TAGS, `P14 (ROOT R_A 12.50%) carries an approved tier-1 correction to category B (R_B9 9.00%): the row shows B / 9.00% / 승인됨 — 적용; the answer block shows 9.00% marked 수정본 적용 with category B and 수정됨; 수정본이 적용 중입니다 names the corrector (user A), the approval date/time and that the contract still resolves to A at 12.50%; the derived key shows B with 키를 사람이 고쳤습니다; the flag reads 불일치, never 일치; the trace reads fromCorrection true, contractResolvesTo A / 12.50, MISMATCH. Deviation (stated by the TC): the dev correction block shows no who / when (01/10) — those assertions are expected to fail. The approval time is checked on its KST date. Reason text is made traceable ([AUTO-US079] prefix). ${DEV} ${DATA}`);
    let s!: Seeded;
    let pid = '';
    let approvedOn = '';
    let trace: { status: number; body: Trace } = { status: 0, body: {} };

    await step('Arrange: Pre-condition 1–15 — ROOT R_A, ANNEX1 R_B9, product P14 (slot R_A); a tier-1 correction to B saved, submitted and approved by TOKEN_B; verified 9.00 / B', async () => {
      s = await seedData({ tc: 78, contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      pid = s.products.P14;
      await approvedCorrection(feeReviewApi, approverFeeReviewApi, s.cycles.CY_MAIN.id, pid, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.B, reason });
      approvedOn = kstDate();
      const r = await feeReviewApi.row(s.cycles.CY_MAIN.id, pid);
      expect.soft(r.inForceRate, '[Pre-condition 13] P14 inForceRate = "9.00"').toBe('9.00');
      expect.soft(r.inForceCategory, `[Pre-condition 13] P14 inForceCategory = ${s.master.categoryName.B}`).toBe(s.master.categoryName.B);
    });

    await step('Act: Step 1 — Open the screen, select CY_MAIN and click chip 기간 내 판매 상품 (Products sold in period)', async () => {
      await res.openCycle(s.cycles.CY_MAIN.id);
    });

    await step('Assert: Expected 1 — The list of CY_MAIN opens with every product sold in the cycle', async () => {
      await expectCycleOpened(list, feeReviewApi, s.cycles.CY_MAIN);
    });

    await step('Act: Step 2 — Search P14 and read the row', async () => {
      await res.searchByProductId(pid);
    });

    await step('Assert: Expected 2 — Category B, 9.00% and the second pill 승인됨 — 적용 (Approved — applied)', async () => {
      const r = list.row(pid);
      await expect.soft(list.cell(r, 'category'), `[Expected 2] 산정된 수수료 카테고리 = ${s.master.categoryName.B}`).toContainText(s.master.categoryName.B);
      await expect.soft(list.cell(r, 'rate'), '[Expected 2] 산정 요율 = 9.00%').toContainText('9.00%');
      await expect.soft(list.statusPills(r).nth(1), '[Expected 2] Second pill = 승인됨 — 적용 (Approved — applied)').toHaveText(FR_KO['state.APPROVED']);
    });

    await step('Act: Step 3 — Click 근거 (Basis) and read the answer block', async () => {
      await list.openBasis(list.row(pid));
    });

    await step('Assert: Expected 3 — 9.00% marked 수정본 적용 (from a correction), with category B and the marker 수정됨 (corrected)', async () => {
      await expect.soft(list.basis.headlineRate, '[Expected 3] The rate 9.00%').toHaveText('9.00%');
      await expect.soft(res.sourceLabel('trace.fromCorrection'), '[Expected 3] 수정본 적용 (from a correction)').toBeVisible();
      await expect.soft(res.answerBlock, `[Expected 3] Category ${s.master.categoryName.B}`).toContainText(s.master.categoryName.B);
      await expect.soft(res.answerBlock, '[Expected 3] The marker 수정됨 (corrected)').toContainText(FR_KO['trace.corrected']);
    });

    await step('Act: Step 4 — Read the correction block under the answer', async () => {
      await list.basis.section('trace.overrideTitle').scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — 수정본이 적용 중입니다: who (user A), when (TOKEN_B approval), and that the contract still resolves to A at 12.50%', async () => {
      const block = list.basis.section('trace.overrideTitle');
      await expect.soft(block, '[Expected 4] 수정본이 적용 중입니다 (A correction is in force) is shown').toBeVisible();
      await expect.soft(block, '[Expected 4] Who corrected it = user A').toContainText(getAccountDisplayName('submitter'));
      await expect.soft(block, `[Expected 4] When it was approved = ${approvedOn} hh:mm`).toContainText(new RegExp(`${approvedOn}\\s+\\d{2}:\\d{2}`));
      await expect.soft(block, `[Expected 4] The contract still resolves to ${s.master.categoryName.A}`).toContainText(s.master.categoryName.A);
      await expect.soft(block, '[Expected 4] … at 12.50%').toContainText('12.50%');
    });

    await step('Act: Step 5 — Click 어떻게 결정됐는지 보기 and read 도출된 키 (Derived key)', async () => {
      await list.basis.expandEvidence();
    });

    await step('Assert: Expected 5 — 수수료 카테고리 = B with 키를 사람이 고쳤습니다 (The key was set by a person)', async () => {
      await expect.soft(list.basis.value(list.basis.section('trace.keyTitle'), FR_KO['trace.kvCategory']), `[Expected 5] 수수료 카테고리 = ${s.master.categoryName.B}`).toContainText(s.master.categoryName.B);
      await expect.soft(res.keySetByPerson.first(), '[Expected 5] 키를 사람이 고쳤습니다 (The key was set by a person)').toBeVisible();
    });

    await step('Act: Step 6 — Read 현재 지정된 행 (Currently assigned)', async () => {
      await res.assignedBlock.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 6 — The flag reads 불일치 (Mismatch), never 일치 from the pre-correction key', async () => {
      await expect.soft(res.assignedFlag, '[Expected 6] Flag = 불일치 (Mismatch)').toHaveText(FR_KO['trace.flagDiff']);
      await expect.soft(res.assignedFlag, '[Expected 6] Never 일치 (Matches)').not.toHaveText(FR_KO['trace.flagOk']);
    });

    await step('Act: Step 7 — Call GET trace?policy=NORMAL for P14', async () => {
      await list.basis.close();
      trace = await traceOf(feeReviewApi, s.cycles.CY_MAIN.id, pid);
    });

    await step('Assert: Expected 7 — HTTP 200: derivedKey.fromCorrection true, derivedKey.category B, contractResolvesTo {A, "12.50"}, verdict MISMATCH', async () => {
      expect(trace.status, '[Expected 7] HTTP 200').toBe(200);
      expect.soft(trace.body.derivedKey?.fromCorrection, '[Expected 7] derivedKey.fromCorrection = true').toBe(true);
      expect.soft(trace.body.derivedKey?.category, '[Expected 7] derivedKey.category = B').toBe(s.master.categoryName.B);
      expect.soft(trace.body.contractResolvesTo?.category, '[Expected 7] contractResolvesTo.category = A').toBe(s.master.categoryName.A);
      expect.soft(trace.body.contractResolvesTo?.rate, '[Expected 7] contractResolvesTo.rate = "12.50"').toBe('12.50');
      expect.soft(trace.body.verdict, '[Expected 7] verdict = MISMATCH').toBe('MISMATCH');
    });
  });

  test('TC_US079_79 — Each missing key part shows its own sentence under No row applies', async ({ page, feeReviewApi, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const res = new ResolutionPage(page, list);
    await tcMeta('TC_US079_79', 'Medium', BASIS_TAGS, `Under 적용 가능한 행 없음 each missing key part shows its own BR-8.V5 sentence: P12 NO_BINDING, P05 NO_CATEGORY (category cleared in Step 1, restored in Step 7), P06 NO_ROW_FOR_KEY (MD), P20 NOT_VALID_ON_DATE (CT2 ended 2030-12-31); the four bodies differ and no ladder is left empty. Deviation (stated by the TC): dev still shows the v1.7 wording (01/10) — Expected 3–6 are expected to fail. ${DEV} ${DATA}`);
    let s!: Seeded;
    const pidOf = (code: string) => s.products[code];
    let cleared = 0;
    let restored = 0;
    const bodies: string[] = [];

    const openNoRow = async (code: string) => {
      if ((await list.basis.root.count()) > 0) await list.basis.close();
      await list.openBasis(list.row(pidOf(code)));
      bodies.push(((await list.basis.section('trace.noRowTitle').innerText().catch(() => '')) ?? '').trim());
    };
    const expectNoRow = async (n: number, code: string, sentence: string) => {
      const block = list.basis.section('trace.noRowTitle');
      await expect.soft(block, `[Expected ${n}] ${code}: heading 적용 가능한 행 없음 (No row applies)`).toBeVisible();
      await expect.soft(block, `[Expected ${n}] ${code}: body "${sentence}"`).toContainText(sentence);
    };

    await step('Arrange: Pre-condition 1–13 — ROOT R_A, CT2 R_CT2 ending 2030-12-31, products P12 (no contract), P05, P06 (MD), P20 (CT2), verified P05 RESOLVED 12.50 and the others NO_ROW', async () => {
      s = await seedData({
        tc: 79,
        contracts: family({ ROOT: ['R_A'], CT2: { rows: [row('R_CT2', { category: 'A', rate: 12.5 })], endAt: '2030-12-31T00:00:00Z' } }),
        cycles: ['CY_MAIN'],
        products: [product('P12', [{ cycle: 'CY_MAIN', saleLines: 160 }]), product('P05', [{ cycle: 'CY_MAIN', saleLines: 151 }]), product('P06', [{ cycle: 'CY_MAIN', saleLines: 188 }]), product('P20', [{ cycle: 'CY_MAIN', saleLines: 1 }])],
      });
      await verifySeed(feeReviewApi, s, 11, 4, [{ code: 'P05', status: 'RESOLVED', rate: '12.50' }, ...['P12', 'P06', 'P20'].map((code) => ({ code, status: 'NO_ROW' }))]);
    });

    await step('Act: Step 1 — UPDATE fee_review_fixture_product SET category_id = NULL for P05', async () => {
      await feeReviewDb.updateProduct(pidOf('P05'), { categoryId: null });
      cleared = await countOf('SELECT COUNT(*) AS n FROM fee_review_fixture_product WHERE product_id = ? AND category_id IS NULL', [pidOf('P05')]);
    });

    await step('Assert: Expected 1 — 1 row updated', async () => {
      expect(cleared, '[Expected 1] P05 has no category').toBe(1);
    });

    await step('Act: Step 2 — Open the screen, select CY_MAIN and click chip 적용 행 없음 (No row applies)', async () => {
      await res.openCycle(s.cycles.CY_MAIN.id, 'bucket.NF');
    });

    await step('Assert: Expected 2 — The No row applies bucket lists P12, P05, P06 and P20', async () => {
      await expect.soft(list.chip('bucket.NF'), '[Expected 2] The 적용 행 없음 chip is selected').toHaveAttribute('aria-pressed', 'true');
      for (const code of ['P12', 'P05', 'P06', 'P20']) await expect.soft(list.row(pidOf(code)), `[Expected 2] ${code} is listed`).toBeVisible();
    });

    await step('Act: Step 3 — Click 근거 (Basis) on P12 and read the warning block', async () => {
      await openNoRow('P12');
    });

    await step('Assert: Expected 3 — No row applies; body: not tied to any contract, needs a contract (NO_BINDING)', async () => {
      await expectNoRow(3, 'P12', RES_TC.noBindingKo);
    });

    await step('Act: Step 4 — Close the panel, click Basis on P05 and read the warning block', async () => {
      await openNoRow('P05');
    });

    await step('Assert: Expected 4 — No row applies; body: no fee category, pick one with Correct (NO_CATEGORY)', async () => {
      await expectNoRow(4, 'P05', FR_TC.noRowNoCategoryKo);
    });

    await step('Act: Step 5 — Close the panel, click Basis on P06 and read the warning block', async () => {
      await openNoRow('P06');
    });

    await step('Assert: Expected 5 — No row applies; body: the contract has no row for this category and sales type (NO_ROW_FOR_KEY)', async () => {
      await expectNoRow(5, 'P06', RES_TC.noRowForKeyKo);
    });

    await step('Act: Step 6 — Close the panel, click Basis on P20 and read the warning block', async () => {
      await openNoRow('P20');
    });

    await step('Assert: Expected 6 — No row applies; body: rows exist but none in effect on the order date (NOT_VALID_ON_DATE); the four bodies all differ, no empty ladder', async () => {
      await expectNoRow(6, 'P20', RES_TC.notValidOnDateKo);
      expect.soft(new Set(bodies).size, '[Expected 6] The four bodies are all different — no single shared sentence').toBe(4);
      await list.basis.expandEvidence();
      await expect.soft(list.basis.section('trace.ladderTitle'), '[Expected 6] No empty ladder (not a bare "—")').not.toHaveText(new RegExp(`^\\s*${FR_KO['trace.ladderTitle']}\\s*—\\s*$`));
    });

    await step('Act: Step 7 — UPDATE category_id = CAT_A for P05', async () => {
      await list.basis.close();
      await feeReviewDb.updateProduct(pidOf('P05'), { categoryId: s.master.category.A });
      restored = await countOf('SELECT COUNT(*) AS n FROM fee_review_fixture_product WHERE product_id = ? AND category_id = ?', [pidOf('P05'), s.master.category.A]);
    });

    await step('Assert: Expected 7 — 1 row updated; P05 is back to category A', async () => {
      expect(restored, '[Expected 7] P05 is back to category A').toBe(1);
    });
  });

  test('TC_US079_80 — A tie shows the Two fee rows tie block and opens the reasoning by itself', async ({ page, feeReviewApi, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const res = new ResolutionPage(page, list);
    await tcMeta('TC_US079_80', 'Medium', BASIS_TAGS, `P04 (R_C20 of ANNEX1 and R_C22 of ANNEX2 tie on every step) reads 중복 적용; Why this rate shows no rate and the tie block 동순위 수수료 행 중복 with its own body — not 적용 가능한 행 없음 — and the reasoning already expanded; the contrast product P02 (9.00%) shows no warning and a collapsed reasoning. Deviation (stated by the TC): dev files a tie under 적용 가능한 행 없음 with the v1.7 wording (01/10) — Expected 3 is expected to fail. ${DEV} ${DATA}`);
    let s!: Seeded;
    const pidOf = (code: string) => s.products[code];

    await step('Arrange: Pre-condition 1–13 — ROOT (no row), ANNEX1 (R_B9, R_C20), ANNEX2 R_C22, products P04 (tie) and P02 (slot R_B9), verified AMBIGUOUS / RESOLVED 9.00', async () => {
      s = await seedData({ tc: 80, contracts: family({ ROOT: [], ANNEX1: ['R_B9', 'R_C20'], ANNEX2: ['R_C22'] }), cycles: ['CY_MAIN'], products: [product('P04', [{ cycle: 'CY_MAIN', saleLines: 114 }]), product('P02', [{ cycle: 'CY_MAIN', saleLines: 40 }])] });
      await verifySeed(feeReviewApi, s, 11, 2, [
        { code: 'P04', status: 'AMBIGUOUS' },
        { code: 'P02', status: 'RESOLVED', rate: '9.00' },
      ]);
    });

    await step('Act: Step 1 — Open the screen, select CY_MAIN and click chip 기간 내 판매 상품 (Products sold in period)', async () => {
      await res.openCycle(s.cycles.CY_MAIN.id);
    });

    await step('Assert: Expected 1 — The list of CY_MAIN opens with every product sold in the cycle', async () => {
      await expectCycleOpened(list, feeReviewApi, s.cycles.CY_MAIN);
    });

    await step('Act: Step 2 — Search the product ID of P04', async () => {
      await res.searchByProductId(pidOf('P04'));
    });

    await step('Assert: Expected 2 — The row of P04 shows 중복 적용 (Ambiguous)', async () => {
      await expect(list.statusPills(list.row(pidOf('P04'))).first(), '[Expected 2] 중복 적용 (Ambiguous)').toHaveText(FR_KO['status.AMBIGUOUS']);
    });

    await step('Act: Step 3 — Click 근거 (Basis) on P04 and read the warning block', async () => {
      await list.openBasis(list.row(pidOf('P04')));
    });

    await step('Assert: Expected 3 — No rate; heading 동순위 수수료 행 중복 (Two fee rows tie), not 적용 가능한 행 없음; its own body', async () => {
      await expect.soft(list.basis.headlineRate, '[Expected 3] No rate').toHaveText(EMPTY);
      await expect.soft(res.tieBlock, '[Expected 3] Heading 동순위 수수료 행 중복 (Two fee rows tie)').toBeVisible();
      await expect.soft(list.basis.section('trace.noRowTitle'), '[Expected 3] Not 적용 가능한 행 없음 (No row applies)').toHaveCount(0);
      await expect.soft(res.tieBlock, `[Expected 3] Body "${RES_TC.tieBodyKo}"`).toContainText(RES_TC.tieBodyKo);
    });

    await step('Act: Step 4 — Without clicking anything, look below the warning block', async () => {
      await list.basis.evidenceToggle.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — 어떻게 결정됐는지 보기 is already expanded: 도출된 키, 검토된 수수료 행 and 우선순위 적용 단계 are visible', async () => {
      await expect.soft(list.basis.evidenceToggle, '[Expected 4] How this was decided is already expanded').toHaveAttribute('aria-expanded', 'true');
      for (const { name, locator } of res.reasoning()) await expect.soft(locator, `[Expected 4] ${name} is visible`).toBeVisible();
    });

    await step('Act: Step 5 — Close the panel, search P02 and click Basis on its row', async () => {
      await list.basis.close();
      await res.searchByProductId(pidOf('P02'));
      await list.openBasis(list.row(pidOf('P02')));
    });

    await step('Assert: Expected 5 — 9.00% with no warning block; How this was decided is collapsed', async () => {
      await expect.soft(list.basis.headlineRate, '[Expected 5] The rate 9.00%').toHaveText('9.00%');
      await expect.soft(list.basis.section('trace.noRowTitle'), '[Expected 5] No 적용 가능한 행 없음 block').toHaveCount(0);
      await expect.soft(res.tieBlock, '[Expected 5] No tie block').toHaveCount(0);
      await expect.soft(list.basis.evidenceToggle, '[Expected 5] How this was decided is collapsed').toHaveAttribute('aria-expanded', 'false');
    });
  });

  test('TC_US079_81 — A bracket rate shows the not-worked-out-yet block saying there is nothing to do', async ({ page, feeReviewApi, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const res = new ResolutionPage(page, list);
    await tcMeta('TC_US079_81', 'Medium', BASIS_TAGS, `P21 (CT3 with one MARGIN row) reads 구간형 요율 — 산정 전 with an empty rate; Why this rate shows no rate and the 구간형 요율 — 아직 산정 전 block with the full body (not 적용 가능한 행 없음), the reasoning already expanded with the CT3 row in 검토된 수수료 행, and no story id or release name anywhere in the panel. ${DEV} ${DATA}`);
    let s!: Seeded;
    let pid = '';
    let panelText = '';

    await step('Arrange: Pre-condition 1–11 — CT3 with the MARGIN row R_CT3, product P21 (1 sale line), verified NOT_COMPUTABLE with no rate', async () => {
      s = await seedData({ tc: 81, contracts: family({ CT3: [row('R_CT3', { category: 'A', type: 'MARGIN', rate: 30 })] }), cycles: ['CY_MAIN'], products: [product('P21', [{ cycle: 'CY_MAIN', saleLines: 1 }])] });
      pid = s.products.P21;
      await verifySeed(feeReviewApi, s, 9, 1, [{ code: 'P21', status: 'NOT_COMPUTABLE', rate: null }]);
    });

    await step('Act: Step 1 — Open the screen, select CY_MAIN and click chip 기간 내 판매 상품 (Products sold in period)', async () => {
      await res.openCycle(s.cycles.CY_MAIN.id);
    });

    await step('Assert: Expected 1 — The list of CY_MAIN opens with every product sold in the cycle', async () => {
      await expectCycleOpened(list, feeReviewApi, s.cycles.CY_MAIN);
    });

    await step('Act: Step 2 — Search the product ID of P21', async () => {
      await res.searchByProductId(pid);
    });

    await step('Assert: Expected 2 — The row shows 구간형 요율 — 산정 전 (Not computable) with an empty rate', async () => {
      await expect.soft(list.statusPills(list.row(pid)).first(), '[Expected 2] 구간형 요율 — 산정 전 (Not computable)').toHaveText(FR_KO['status.NOT_COMPUTABLE']);
      await expect.soft(list.cell(list.row(pid), 'rate'), '[Expected 2] Empty rate').toHaveText(EMPTY);
    });

    await step('Act: Step 3 — Click 근거 (Basis) on P21 and read the warning block', async () => {
      await list.openBasis(list.row(pid));
    });

    await step('Assert: Expected 3 — No rate; heading 구간형 요율 — 아직 산정 전, not 적용 가능한 행 없음; the full bracket body', async () => {
      await expect.soft(list.basis.headlineRate, '[Expected 3] No rate').toHaveText(EMPTY);
      const block = list.basis.section('trace.bracketTitle');
      await expect.soft(block, '[Expected 3] Heading 구간형 요율 — 아직 산정 전 (Bracket rate — not worked out yet)').toBeVisible();
      await expect.soft(list.basis.section('trace.noRowTitle'), '[Expected 3] Not 적용 가능한 행 없음 (No row applies)').toHaveCount(0);
      await expect.soft(block, '[Expected 3] The body says a row applies, the rate is a bracket, the system works it out, nothing to do here').toContainText(FR_KO['trace.bracketBody']);
    });

    await step('Act: Step 4 — Without clicking anything, look below the warning block', async () => {
      await list.basis.evidenceToggle.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — How this was decided is already expanded; the C_CT3 row is listed in 검토된 수수료 행', async () => {
      await expect.soft(list.basis.evidenceToggle, '[Expected 4] How this was decided is already expanded').toHaveAttribute('aria-expanded', 'true');
      await expect.soft(list.basis.candidateRows.filter({ hasText: id(s.family.contracts.CT3) }), '[Expected 4] The C_CT3 row is listed').toHaveCount(1);
    });

    await step('Act: Step 5 — Read the whole panel text for any story or release reference', async () => {
      panelText = await list.basis.root.innerText();
    });

    await step('Assert: Expected 5 — No story id (e.g. US140) or release name appears in the panel', async () => {
      expect.soft(panelText, '[Expected 5] No story id (USnnn)').not.toMatch(/\bUS\d{2,4}\b/);
      expect.soft(panelText, '[Expected 5] No release name').not.toMatch(/release|릴리즈|릴리스/i);
    });
  });

  test('TC_US079_82 — A hand-keyed rate in force shows the Hand-keyed badge in the panel', async ({ page, feeReviewApi, approverFeeReviewApi, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const res = new ResolutionPage(page, list);
    const reason = reasonOf('TC_US079_82', 'Rate agreed in the side letter with the partner');
    await tcMeta('TC_US079_82', 'Medium', BASIS_TAGS, `P10 (PURCHASE — no row of the ROOT family) carries an approved tier-2 hand-keyed rate 6.75%: the row shows 6.75% with the 직접 입력 badge and 승인됨 — 적용, the badge tooltip shows the basis; Why this rate shows 6.75% with the badge and 계약에 맞는 요율이 없어 직접 입력했고, 승인을 받았습니다., names no contract, and its badge tooltip shows the basis; the trace reads 6.75 / rateHandKeyed true / basisContractId null. Deviation (stated by the TC): the dev panel badge has no tooltip — Expected 5 is expected to fail. The basis text is made traceable ([AUTO-US079] prefix) around the TC wording. ${DEV} ${DATA}`);
    let s!: Seeded;
    let pid = '';
    let trace: { status: number; body: Trace } = { status: 0, body: {} };
    const badge = () => list.cell(list.row(pid), 'rate').getByText(FR_KO['lbl.handKeyed'], { exact: true });

    await step('Arrange: Pre-condition 1–15 — ROOT R_A (no PURCHASE row), product P10 (PURCHASE); a 6.75% hand-keyed correction saved, submitted and approved by TOKEN_B', async () => {
      s = await seedData({ tc: 82, contracts: family({ ROOT: ['R_A'] }), cycles: ['CY_MAIN'], products: [product('P10', [{ cycle: 'CY_MAIN', saleLines: 86 }])] });
      pid = s.products.P10;
      await approvedCorrection(feeReviewApi, approverFeeReviewApi, s.cycles.CY_MAIN.id, pid, { policy: 'NORMAL', tier: 'RATE_OVERRIDE', overrideRate: '6.75', reason });
      expect.soft((await feeReviewApi.row(s.cycles.CY_MAIN.id, pid)).inForceRate, '[Pre-condition 13] P10 inForceRate = "6.75"').toBe('6.75');
    });

    await step('Act: Step 1 — Open the screen, select CY_MAIN and click chip 기간 내 판매 상품 (Products sold in period)', async () => {
      await res.openCycle(s.cycles.CY_MAIN.id);
    });

    await step('Assert: Expected 1 — The list of CY_MAIN opens with every product sold in the cycle', async () => {
      await expectCycleOpened(list, feeReviewApi, s.cycles.CY_MAIN);
    });

    await step('Act: Step 2 — Search P10 and read the row', async () => {
      await res.searchByProductId(pid);
    });

    await step('Assert: Expected 2 — 6.75% with the badge 직접 입력 (Hand-keyed); second pill 승인됨 — 적용 (Approved — applied)', async () => {
      await expect.soft(list.cell(list.row(pid), 'rate'), '[Expected 2] 산정 요율 = 6.75%').toContainText('6.75%');
      await expect.soft(badge(), '[Expected 2] The badge 직접 입력 (Hand-keyed)').toBeVisible();
      await expect.soft(list.statusPills(list.row(pid)).nth(1), '[Expected 2] Second pill = 승인됨 — 적용 (Approved — applied)').toHaveText(FR_KO['state.APPROVED']);
    });

    await step('Act: Step 3 — Hover the badge next to the rate in the row', async () => {
      await badge().hover();
    });

    await step('Assert: Expected 3 — The tooltip shows the basis', async () => {
      await expect.soft(list.tooltip, '[Expected 3] The tooltip shows the basis text').toContainText(reason);
    });

    await step('Act: Step 4 — Click 근거 (Basis) and read the answer block', async () => {
      await list.openBasis(list.row(pid));
    });

    await step('Assert: Expected 4 — 6.75% with the badge 직접 입력 and the hand-keyed sentence; no contract named as the source', async () => {
      await expect.soft(list.basis.headlineRate, '[Expected 4] The rate 6.75%').toHaveText('6.75%');
      await expect.soft(res.answerHandKeyedBadge, '[Expected 4] The badge 직접 입력 (Hand-keyed)').toBeVisible();
      await expect.soft(res.answerBlock, '[Expected 4] "계약에 맞는 요율이 없어 직접 입력했고, 승인을 받았습니다."').toContainText(FR_KO['trace.whyTyped']);
      await expect.soft(res.answerValue('trace.kvContract'), '[Expected 4] No contract is named as the source').toHaveCount(0);
    });

    await step('Act: Step 5 — Hover the badge in the answer block', async () => {
      await res.answerHandKeyedBadge.hover({ timeout: 10_000 }).catch(() => undefined);
    });

    await step('Assert: Expected 5 — The tooltip shows the basis', async () => {
      await expect.soft(list.tooltip, '[Expected 5] The tooltip shows the basis text').toContainText(reason);
    });

    await step('Act: Step 6 — Call GET trace?policy=NORMAL for P10', async () => {
      await list.basis.close();
      trace = await traceOf(feeReviewApi, s.cycles.CY_MAIN.id, pid);
    });

    await step('Assert: Expected 6 — HTTP 200: inForceRate "6.75", rateHandKeyed true, basisContractId null', async () => {
      expect(trace.status, '[Expected 6] HTTP 200').toBe(200);
      expect.soft(trace.body.inForceRate, '[Expected 6] inForceRate = "6.75"').toBe('6.75');
      expect.soft(trace.body.rateHandKeyed, '[Expected 6] rateHandKeyed = true').toBe(true);
      expect.soft(trace.body.basisContractId ?? null, '[Expected 6] basisContractId = null').toBeNull();
    });
  });

  test('TC_US079_83 — The panel opens within 1 second', async ({ page, feeReviewApi, feeReviewPage: list, seedData }) => {
    const step = makeStep(page);
    const res = new ResolutionPage(page, list);
    await tcMeta('TC_US079_83', 'Medium', BASIS_TAGS, `Why this rate shows its content and the trace request ends within 1 second for P02 (5 opens) and once each for P04 (tie), P06 (no row) — including their auto-expanded reasoning — and P14. Timings are taken from the click to the rendered headline (plus the reasoning for P04 / P06) and from the trace request timing; each measurement is attached as an annotation. ${DEV} ${DATA}`);
    let s!: Seeded;
    const pidOf = (code: string) => s.products[code];
    const timings: Record<string, Array<{ renderMs: number; traceMs: number }>> = { first: [], repeat: [], others: [] };
    const note = (label: string, t: { renderMs: number; traceMs: number }) => test.info().annotations.push({ type: 'Observed', description: `${label}: rendered in ${t.renderMs} ms, trace ended in ${Math.round(t.traceMs)} ms` });
    const expectFast = (n: number, label: string, t: { renderMs: number; traceMs: number }) => {
      expect.soft(t.renderMs, `[Expected ${n}] ${label} shows its content within 1 second`).toBeLessThanOrEqual(1000);
      expect.soft(t.traceMs, `[Expected ${n}] ${label} trace request ends in under 1 second`).toBeLessThan(1000);
    };

    await step('Arrange: Pre-condition 1–13 — ROOT R_A, ANNEX1 (R_B9, R_C20), ANNEX2 R_C22, products P02, P04 (tie), P06 (MD, no row), P14, verified', async () => {
      s = await seedData({
        tc: 83,
        contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9', 'R_C20'], ANNEX2: ['R_C22'] }),
        cycles: ['CY_MAIN'],
        products: [product('P02', [{ cycle: 'CY_MAIN', saleLines: 40 }]), product('P04', [{ cycle: 'CY_MAIN', saleLines: 114 }]), product('P06', [{ cycle: 'CY_MAIN', saleLines: 188 }]), product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])],
      });
      await verifySeed(feeReviewApi, s, 11, 4, [
        { code: 'P02', status: 'RESOLVED', rate: '9.00' },
        { code: 'P04', status: 'AMBIGUOUS' },
        { code: 'P06', status: 'NO_ROW' },
        { code: 'P14', status: 'RESOLVED', rate: '12.50' },
      ]);
    });

    await step('Act: Step 1 — Open the screen, select CY_MAIN and click chip 기간 내 판매 상품 (Products sold in period)', async () => {
      await res.openCycle(s.cycles.CY_MAIN.id);
    });

    await step('Assert: Expected 1 — The list of CY_MAIN opens with every product sold in the cycle', async () => {
      await expectCycleOpened(list, feeReviewApi, s.cycles.CY_MAIN);
    });

    await step('Act: Step 2 — Search the product ID of P02', async () => {
      await res.searchByProductId(pidOf('P02'));
    });

    await step('Assert: Expected 2 — The row of P02 is shown', async () => {
      await expect(list.row(pidOf('P02')), '[Expected 2] The row of P02 is shown').toBeVisible();
    });

    await step('Act: Step 3 — Click 근거 (Basis) on P02 and time the content and the trace request', async () => {
      const t = await res.timedBasis(list.row(pidOf('P02')));
      timings.first.push(t);
      note('P02 open 1', t);
    });

    await step('Assert: Expected 3 — Content within 1 second; the trace request ends in under 1 second', async () => {
      expectFast(3, 'P02 open 1', timings.first[0]);
    });

    await step('Act: Step 4 — Close the panel and repeat step 3 four more times', async () => {
      for (let i = 2; i <= 5; i++) {
        await list.basis.close();
        const t = await res.timedBasis(list.row(pidOf('P02')));
        timings.repeat.push(t);
        note(`P02 open ${i}`, t);
      }
    });

    await step('Assert: Expected 4 — Each of the 4 opens is within 1 second', async () => {
      expect(timings.repeat, '[Expected 4] 4 more opens were measured').toHaveLength(4);
      timings.repeat.forEach((t, i) => expectFast(4, `P02 open ${i + 2}`, t));
    });

    await step('Act: Step 5 — Repeat step 3 once each for P04, P06 and P14', async () => {
      for (const code of ['P04', 'P06', 'P14']) {
        await list.basis.close();
        await res.searchByProductId(pidOf(code));
        const t = await res.timedBasis(list.row(pidOf(code)), code !== 'P14');
        timings.others.push(t);
        note(code, t);
      }
    });

    await step('Assert: Expected 5 — Each panel, including the auto-expanded reasoning of P04 and P06, opens within 1 second', async () => {
      expect(timings.others, '[Expected 5] P04, P06 and P14 were measured').toHaveLength(3);
      ['P04', 'P06', 'P14'].forEach((code, i) => expectFast(5, code, timings.others[i]));
      await list.basis.close();
    });
  });
});
