import type { Locator, Response } from '@playwright/test';
import type { RowDataPacket } from 'mysql2/promise';
import { test, expect } from '@fixtures/fee-review-v1.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { FR_KO, frFormat } from '@utils/fee-review.i18n';
import { family, product, reasonOf, row as rowDef, ProductCode } from '@utils/fee-review-v1.data';
import { feeReviewDb } from '@utils/fee-review-db';
import { isClipped } from '@utils/layout';
import { FeeReviewListBPage, ChipKey } from '@pages/fee-review-v1/list-b.page';
import type { FeeReviewListPage } from '@pages/fee-review.page';
import type { CorrectionOptions, FeeReviewApi, FeeReviewPage, FeeReviewRow, SaveCorrectionBody } from '@api/fee-review.api';
import type { FeeRateApi } from '@api/fee-rate.api';
import type { CategoryKey, ProductDef, RowDef, Seeded } from '@utils/fee-review-seed';

/**
 * US079 v1 — nhóm [List] phần B (TC_US079_38–56): nhãn 산정 시각, phân nhóm bucket / loại vấn đề, ô 2 dòng, pill trạng thái,
 * lý do khoá nút 수정, thứ tự nút 작업, định dạng tỷ lệ, hiệu năng 3.000 sản phẩm. Dữ liệu dựng theo pre-condition qua
 * `seedData` (API + MySQL, tự dọn theo tiền tố sản phẩm). Assert theo TC; TC ≠ UI → ghi Deviation trong description.
 */
const TAGS = ['list', 'fee-review', 'US079'];
const NAV =
  'Deviation: the screen is opened by URL (cycleId) instead of the sidebar + 정산 주기 selector — the sidebar has no fee review entry and switching the selector did not re-query the list on dev (01/10). Deviation: CY_MAIN is the next free month ≥ 2100, not <Y> = 2100 + 200 × RUN + N.';
const SHARED = 'Deviation: CY_MAIN is shared within the run, so the TC product prefix is typed in 검색어 (Keyword) to list only this TC’s rows.';
const PRIVATE = 'Data: own contracts + cycle (the TC reads cycle-wide counts or changes a contract); products and corrections are deleted by SQL in teardown, contracts/cycles stay (no delete API).';
const SHARED_DATA = 'Data: contracts reused within the run; products and corrections are deleted by SQL in teardown.';

/** Một lượt chạy = 1 dòng target / sale line như TC (sale_line_count = 1). */
const MAIN = [{ cycle: 'CY_MAIN', saleLines: 1 }];
const MAIN_BOTH = [{ cycle: 'CY_MAIN', saleLines: 1 }, { cycle: 'CY_MAIN', policy: 'PROMOTION' as const, saleLines: 1 }];

const F_A = family({ ROOT: ['R_A'] });
const F_A_B9 = family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] });
const F_AB_B9 = family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9'] });
const F_AB_B9_CT3 = family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9'], CT3: ['R_MARGIN'] });
const F_ABC = family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9', 'R_C20'], ANNEX2: ['R_C22'] });

const SCOPE: ChipKey[] = ['bucket.EXC', 'bucket.NC', 'bucket.PROV', 'bucket.FIXED', 'bucket.OK'];

const sorted = (ids: string[]): string[] => [...ids].sort();

/** Lưu correction qua API bằng TOKEN_A (pre-condition "Save draft" / "Save"). */
async function saveCorrection(api: FeeReviewApi, cycleId: number, productId: string, body: Omit<SaveCorrectionBody, 'policy'>): Promise<string> {
  const { status, body: saved } = await api.save(cycleId, productId, { policy: 'NORMAL', ...body });
  if (status >= 300 || !saved?.correctionId) throw new Error(`Save correction on ${productId} → ${status}: ${JSON.stringify(saved).slice(0, 200)}`);
  return saved.correctionId;
}

const tier1 = (s: Seeded, category: CategoryKey, reason: string): Omit<SaveCorrectionBody, 'policy'> => ({ tier: 'ASSIGNMENT', commissionCategoryId: s.master.category[category], reason });

/** Bản ghi 변경 승인 của 1 correction (= fee_correction.change_approval_id), phải có trong GET /change-approvals?targetType=FEE_RULE. */
async function approvalIdOf(api: FeeReviewApi, correctionId: string): Promise<number> {
  const [record] = await feeReviewDb.query<RowDataPacket[]>('SELECT change_approval_id FROM fee_correction WHERE id = ?', [correctionId]);
  const id = Number(record?.change_approval_id);
  if (!id) throw new Error(`fee_correction ${correctionId} carries no change_approval_id`);
  if (!(await api.feeRuleApprovals()).some((a) => a.id === id)) throw new Error(`Change approval ${id} is not listed under GET /change-approvals?targetType=FEE_RULE`);
  return id;
}

/** Submit (TOKEN_A) rồi duyệt từng correction (TOKEN_B). */
async function submitAndApprove(maker: FeeReviewApi, approver: FeeReviewApi, correctionIds: string[]): Promise<void> {
  const submitted = await maker.submit(correctionIds);
  if (submitted.status >= 300) throw new Error(`Submit ${correctionIds.join(', ')} → ${submitted.status}`);
  for (const id of correctionIds) {
    const approved = await approver.approve(await approvalIdOf(maker, id));
    if (approved.status !== 200) throw new Error(`Approve the change approval of ${id} → ${approved.status}`);
  }
}

/** Correction hiện tại của 1 dòng (đọc qua API sau thao tác UI). */
async function correctionIdOn(api: FeeReviewApi, cycleId: number, productId: string): Promise<string> {
  const id = (await api.row(cycleId, productId)).correction?.correctionId;
  if (!id) throw new Error(`${productId} carries no correction`);
  return id;
}

/** Body thêm fee row trên contract theo TC (POST /contracts/{id}/fee-rows). */
function feeRowBody(s: Seeded, category: CategoryKey, commission: number, effectiveFrom: string, label: string): Record<string, unknown> {
  return {
    key: { categoryId: s.master.category[category], saleTypeId: s.master.saleType.ST1, policy: 'NORMAL' },
    commissionType: 'PERCENT',
    commission,
    effectiveFrom,
    pgCommissionRate: 3,
    feeBase: 'PRODUCT_PRICE',
    pgFeeBase: 'PRODUCT_PRICE',
    changeReason: `[T079] ${label} ${s.prefix}`,
  };
}

/** Thêm fee row (TOKEN_A) và duyệt change approval của nó (TOKEN_B); trả id dòng mới. */
async function addApprovedRow(maker: FeeRateApi, approver: FeeRateApi, contractId: number, body: Record<string, unknown>): Promise<number> {
  const added = await maker.addFeeRow<{ newRowId?: number; id?: number; changeApprovalId?: number }>(contractId, body);
  if (added.status >= 300) throw new Error(`POST /contracts/${contractId}/fee-rows → ${added.status}: ${JSON.stringify(added.body).slice(0, 200)}`);
  const approved = await approver.approve(Number(added.body.changeApprovalId));
  if (approved.status !== 200) throw new Error(`Approve change approval ${added.body.changeApprovalId} → ${approved.status}`);
  return Number(added.body.newRowId ?? added.body.id);
}

/** Sửa 1 dòng bằng 1단계 trên UI (수정 → chọn category → lý do → 저장). */
async function correctInUi(list: FeeReviewListPage, row: Locator, categoryName: string, reason: string): Promise<Response> {
  await list.openCorrect(row);
  await list.correct.pickCategory(categoryName);
  await list.correct.reasonInput.fill(reason);
  const saved = await list.correct.save();
  await expect(list.correct.root, 'The Correct dialog closes after 저장 (Save)').toHaveCount(0);
  return saved;
}

/** Tick dòng rồi bấm 선택 일괄 상신. */
async function submitInUi(list: FeeReviewListPage, row: Locator): Promise<Response> {
  await list.rowCheckbox(row).check();
  return list.submitSelected();
}

async function correctionRecord(correctionId: string): Promise<RowDataPacket | undefined> {
  return (await feeReviewDb.query<RowDataPacket[]>('SELECT state, rejection_reason, retired_at FROM fee_correction WHERE id = ?', [correctionId]))[0];
}

function notAutomated(text: string): void {
  test.info().annotations.push({ type: 'Not automated', description: text });
}

test.describe('[List] Settlement fee review list — part B', () => {
  test.describe.configure({ timeout: 300_000 });

  test('TC_US079_38 — The computed-at time shows on the list and a contract change appears on reopen without recalculating', async ({ page, feeReviewPage: list, seedData, feeReviewApi, contractsApi, approverContractsApi }) => {
    const step = makeStep(page);
    const b = new FeeReviewListBPage(page, list);
    await tcMeta('TC_US079_38', 'High', TAGS, `The label 산정 시각 {time} — 열 때마다 새로 산정됩니다 shows the open time, moves forward on reopen, and a fee row added and approved on the contract (13% from mid-cycle) shows on the next open with no recalculate action and nothing stored in fee_correction. ${NAV} Deviation: "wait one minute" is a smart wait — the screen is reopened every 15 s until the minute changes (max 2 min). Deviation: "the current time" = the browser clock (HH:MM) read just before and after the open. ${PRIVATE}`);
    let s!: Seeded;
    let cy!: Seeded['cycles'][string];
    const clock: string[] = [];
    let first = '';
    let shown = '';
    let addedRowId = 0;
    let rowStatus = '';
    let stored = -1;
    const id = (code: string) => s.products[code];

    await step('Arrange: Pre-condition 1–11 — Contract ROOT (R_A 12.5%), cycle CY_MAIN, products P01 (NORMAL + PROMOTION), P05, P14, no correction', async () => {
      s = await seedData({ tc: 38, contracts: F_A, cycles: ['CY_MAIN'], private: true, products: [product('P01', MAIN_BOTH), product('P05', MAIN), product('P14', MAIN)] });
      cy = s.cycles.CY_MAIN;
      expect((await feeReviewApi.products(cy.id, { keyword: s.prefix })).totalElements, 'Pre-condition 9 — 4 rows seeded').toBe(4);
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN and click chip 기간 내 판매 상품 (Products sold in period)', async () => {
      clock.push(await b.browserClock());
      await b.show(cy.id);
      clock.push(await b.browserClock());
      await list.clickChip(list.chip('bucket.ALL'));
      first = await b.resolvedAtTime();
    });

    await step('Assert: Expected 1 — 산정 시각 {time} — 열 때마다 새로 산정됩니다 shows the current time as plain text; P01 rows show 12.50%', async () => {
      await expect(list.resolvedAtLabel, '[Expected 1] The resolved-at label reads 산정 시각 {time} — 열 때마다 새로 산정됩니다').toHaveText(frFormat(FR_KO['lbl.resolvedAtOpen'], { time: first }));
      expect(clock, '[Expected 1] {time} is the current time').toContain(first);
      expect(await list.resolvedAtLabel.evaluate((el) => el.closest('a, button, input, select') === null), '[Expected 1] The label is plain text (no link / control)').toBe(true);
      await expect(list.cell(list.row(id('P01'), 0), 'rate'), '[Expected 1] P01 first row shows 12.50%').toHaveText('12.50%');
      await expect(list.cell(list.row(id('P01'), 1), 'rate'), '[Expected 1] P01 second row shows 12.50%').toHaveText('12.50%');
    });

    await step('Act: Step 2 — Wait one minute and reopen the screen on CY_MAIN', async () => {
      await expect(async () => {
        clock.length = 0;
        clock.push(await b.browserClock());
        await b.show(cy.id);
        clock.push(await b.browserClock());
        shown = await b.resolvedAtTime();
        expect(shown).not.toBe(first);
      }, 'The screen is reopened until the minute has moved on').toPass({ timeout: 120_000, intervals: [15_000] });
    });

    await step('Assert: Expected 2 — The computed-at time moves forward to the reopen time', async () => {
      expect(shown, '[Expected 2] The computed-at time changed on reopen').not.toBe(first);
      expect(clock, '[Expected 2] The computed-at time is the reopen time').toContain(shown);
    });

    await step('Act: Step 3 — Add row R_A2 (13%, effective mid-cycle) on C_ROOT by API and approve it with TOKEN_B', async () => {
      addedRowId = await addApprovedRow(contractsApi, approverContractsApi, s.family.contracts.ROOT, feeRowBody(s, 'A', 13, `${cy.label}-15`, 'R_A2'));
      rowStatus = (await contractsApi.feeRows(s.family.contracts.ROOT)).find((r) => r.id === addedRowId)?.status ?? '';
    });

    await step('Assert: Expected 3 — GET /contracts/C_ROOT/fee-rows lists R_A2 with status ACTIVE', async () => {
      expect(rowStatus, '[Expected 3] R_A2 is listed with status ACTIVE').toBe('ACTIVE');
    });

    await step('Act: Step 4 — Reopen the screen on CY_MAIN, pressing no other control', async () => {
      await b.show(cy.id);
    });

    await step('Assert: Expected 4 — P01 (both rows) and P14 show 13.00% / 불일치, P05 13.00% / 지정 없음; 확인 필요 4, 정상 0', async () => {
      for (const [code, index] of [['P01', 0], ['P01', 1], ['P14', 0]] as const) {
        const row = list.row(id(code), index);
        await expect(list.cell(row, 'rate'), `[Expected 4] ${code} row ${index + 1} shows 13.00%`).toHaveText('13.00%');
        await expect(list.cell(row, 'compare'), `[Expected 4] ${code} row ${index + 1} shows 불일치 (Mismatch)`).toHaveText(FR_KO['compare.MISMATCH']);
      }
      await expect(list.cell(list.row(id('P05')), 'rate'), '[Expected 4] P05 shows 13.00%').toHaveText('13.00%');
      await expect(list.cell(list.row(id('P05')), 'compare'), '[Expected 4] P05 shows 지정 없음 (Not assigned)').toHaveText(FR_KO['compare.NOT_ASSIGNED']);
      await expect(b.chipNumber('bucket.EXC'), '[Expected 4] 확인 필요 (Needs review) reads 4').toHaveText('4');
      await expect(b.chipNumber('bucket.OK'), '[Expected 4] 정상 (Resolved cleanly) reads 0').toHaveText('0');
    });

    await step('Act: Step 5 — Count fee_correction rows of the TC products', async () => {
      const [record] = await feeReviewDb.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM fee_correction WHERE product_id LIKE ?', [`${s.prefix}%`]);
      stored = Number(record.n);
    });

    await step('Assert: Expected 5 — Count = 0, no resolved rate is written to storage', async () => {
      expect(stored, '[Expected 5] No fee_correction row for the TC products').toBe(0);
    });
  });

  test('TC_US079_39 — The scope buckets add up to the total with no product counted twice', async ({ page, feeReviewPage: list, seedData, feeReviewApi }) => {
    const step = makeStep(page);
    const b = new FeeReviewListBPage(page, list);
    await tcMeta('TC_US079_39', 'High', TAGS, `On a cycle with five products (P01 clean, P03 mismatch, P06 no row, P21 bracket, P14 with a draft) the five scope chips 확인 필요 2 + 구간형 요율 — 산정 전 1 + 잠정 적용 0 + 이번 기 수정됨 1 + 정상 1 add up to 기간 내 판매 상품 5 and each product sits under exactly one chip. ${NAV} ${PRIVATE}`);
    let s!: Seeded;
    let cy!: Seeded['cycles'][string];
    const counts: Record<string, string> = {};
    const under: Partial<Record<ChipKey, string[]>> = {};
    const id = (code: string) => s.products[code];

    await step('Arrange: Pre-condition 1–14 — Contracts ROOT / ANNEX1 / CT3, cycle CY_MAIN, products P01 P03 P06 P14 P21, draft COR1 on P14', async () => {
      s = await seedData({ tc: 39, contracts: F_AB_B9_CT3, cycles: ['CY_MAIN'], private: true, products: (['P01', 'P03', 'P06', 'P14', 'P21'] as ProductCode[]).map((c) => product(c, MAIN)) });
      cy = s.cycles.CY_MAIN;
      await saveCorrection(feeReviewApi, cy.id, id('P14'), tier1(s, 'B', reasonOf('TC_US079_39', 'Wrong category mapped in commerce')));
      expect((await feeReviewApi.products(cy.id, { keyword: s.prefix })).totalElements, 'Pre-condition 12 — 5 rows seeded').toBe(5);
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN and click 검색 (Search)', async () => {
      await b.show(cy.id);
    });

    await step('Assert: Expected 1 — The list loads for CY_MAIN', async () => {
      await expect(list.cycleSelect.locator('option:checked'), `[Expected 1] 정산 주기 shows ${cy.label}`).toHaveText(cy.label);
      await expect(list.table, '[Expected 1] The list table is shown').toBeVisible();
    });

    await step('Act: Step 2 — Read the counts of the group 범위 — 합계가 전체와 일치 (Scope — these add up to the total)', async () => {
      await list.partitionGroup.scrollIntoViewIfNeeded();
      for (const key of ['bucket.ALL', ...SCOPE] as ChipKey[]) counts[key] = ((await b.chipNumber(key).textContent()) ?? '').trim();
    });

    await step('Assert: Expected 2 — 기간 내 판매 상품 5 = 확인 필요 2 + 구간형 요율 — 산정 전 1 + 잠정 적용 0 + 이번 기 수정됨 1 + 정상 1', async () => {
      const expected: Record<string, string> = { 'bucket.ALL': '5', 'bucket.EXC': '2', 'bucket.NC': '1', 'bucket.PROV': '0', 'bucket.FIXED': '1', 'bucket.OK': '1' };
      for (const [key, value] of Object.entries(expected)) expect(counts[key], `[Expected 2] ${FR_KO[key as ChipKey]} reads ${value}`).toBe(value);
      expect(SCOPE.reduce((sum, key) => sum + Number(counts[key]), 0), '[Expected 2] The five scope chips add up to 기간 내 판매 상품').toBe(Number(counts['bucket.ALL']));
    });

    await step('Act: Step 3 — Click each chip of the scope group in turn and note the product rows listed', async () => {
      for (const key of SCOPE) under[key] = await b.idsUnder(key);
    });

    await step('Assert: Expected 3 — Needs review P03 P06 · Not computable P21 · Provisional none · Corrected P14 · Resolved cleanly P01', async () => {
      expect(under['bucket.EXC'], '[Expected 3] Needs review lists P03 and P06').toEqual(sorted([id('P03'), id('P06')]));
      expect(under['bucket.NC'], '[Expected 3] Not computable yet lists P21').toEqual([id('P21')]);
      expect(under['bucket.PROV'], '[Expected 3] Provisional lists no row').toEqual([]);
      expect(under['bucket.FIXED'], '[Expected 3] Corrected this period lists P14').toEqual([id('P14')]);
      expect(under['bucket.OK'], '[Expected 3] Resolved cleanly lists P01').toEqual([id('P01')]);
    });

    let all: string[] = [];
    await step('Act: Step 4 — Compare the product rows across the five chips against the total', async () => {
      all = SCOPE.flatMap((key) => under[key] ?? []);
    });

    await step('Assert: Expected 4 — No product appears under two chips and every one of the 5 rows appears under one of them', async () => {
      expect(all.length, '[Expected 4] No product row appears under two of the five chips').toBe(new Set(all).size);
      expect(sorted(all), '[Expected 4] Every one of the 5 rows appears under one chip').toEqual(sorted(['P01', 'P03', 'P06', 'P14', 'P21'].map(id)));
    });
  });

  test('TC_US079_40 — The ordered bucket test puts each product in the first bucket whose condition it meets', async ({ page, feeReviewPage: list, seedData, feeReviewApi }) => {
    const step = makeStep(page);
    const b = new FeeReviewListBPage(page, list);
    await tcMeta('TC_US079_40', 'High', TAGS, `Each product lands in the first bucket whose condition it meets: P21 (bracket, also unassigned) → 구간형 요율 — 산정 전; P03 (mismatch, no correction) → 확인 필요; P10 and P14 (drafts) → 이번 기 수정됨; P02 → 정상. ${NAV} Not automated: Step 5 / Expected 5 (잠정 적용 — Provisional) — a fee row with a provisional fee cannot be produced on this build (DEV-30). ${PRIVATE}`);
    let s!: Seeded;
    let cy!: Seeded['cycles'][string];
    const under: Partial<Record<ChipKey, string[]>> = {};
    let api: Record<string, string> = {};
    const id = (code: string) => s.products[code];

    await step('Arrange: Pre-condition 1–16 — Contracts ROOT / ANNEX1 / CT3, cycle CY_MAIN, products P02 P03 P10 P14 P21, drafts COR1 (P14) and COR2 (P10)', async () => {
      s = await seedData({ tc: 40, contracts: F_AB_B9_CT3, cycles: ['CY_MAIN'], private: true, products: (['P02', 'P03', 'P10', 'P14', 'P21'] as ProductCode[]).map((c) => product(c, MAIN)) });
      cy = s.cycles.CY_MAIN;
      await saveCorrection(feeReviewApi, cy.id, id('P14'), tier1(s, 'B', reasonOf('TC_US079_40', 'Wrong category mapped in commerce')));
      await saveCorrection(feeReviewApi, cy.id, id('P10'), { tier: 'RATE_OVERRIDE', overrideRate: '6.75', reason: reasonOf('TC_US079_40', '유사 계약 요율 적용') });
      expect((await feeReviewApi.products(cy.id, { keyword: s.prefix })).totalElements, 'Pre-condition 13 — 5 rows seeded').toBe(5);
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN, click 검색 (Search), then chip 구간형 요율 — 산정 전 (Not computable yet)', async () => {
      await b.show(cy.id);
      under['bucket.NC'] = await b.idsUnder('bucket.NC');
    });

    await step('Assert: Expected 1 — P21 is listed with 구간형 요율 — 산정 전 and 지정 없음', async () => {
      const row = list.row(id('P21'));
      await expect(row, '[Expected 1] P21 is listed').toBeVisible();
      await expect(list.statusPills(row).first(), '[Expected 1] P21 shows 구간형 요율 — 산정 전 (Not computable)').toHaveText(FR_KO['status.NOT_COMPUTABLE']);
      await expect(list.cell(row, 'compare'), '[Expected 1] P21 shows 지정 없음 (Not assigned)').toHaveText(FR_KO['compare.NOT_ASSIGNED']);
    });

    await step('Act: Step 2 — Click chip 확인 필요 (Needs review)', async () => {
      under['bucket.EXC'] = await b.idsUnder('bucket.EXC');
    });

    await step('Assert: Expected 2 — Only P03 (산정 완료, 불일치, no correction) is listed; P21, P10, P14 are not', async () => {
      const row = list.row(id('P03'));
      expect(under['bucket.EXC'], '[Expected 2] Only P03 is listed').toEqual([id('P03')]);
      await expect(list.statusPills(row).first(), '[Expected 2] P03 shows 산정 완료 (Resolved)').toHaveText(FR_KO['status.RESOLVED']);
      await expect(list.cell(row, 'compare'), '[Expected 2] P03 shows 불일치 (Mismatch)').toHaveText(FR_KO['compare.MISMATCH']);
      await expect(list.statusPills(row), '[Expected 2] P03 carries no correction pill').toHaveCount(1);
      for (const code of ['P21', 'P10', 'P14']) await expect(list.row(id(code)), `[Expected 2] ${code} is not listed`).toHaveCount(0);
    });

    await step('Act: Step 3 — Click chip 이번 기 수정됨 (Corrected this period)', async () => {
      under['bucket.FIXED'] = await b.idsUnder('bucket.FIXED');
    });

    await step('Assert: Expected 3 — P10 (No row applies, with a draft) and P14 (clean, with a draft) are listed', async () => {
      const p10 = list.row(id('P10'));
      const p14 = list.row(id('P14'));
      await expect(p10, '[Expected 3] P10 is listed').toBeVisible();
      await expect(list.statusPills(p10).first(), '[Expected 3] P10 shows 적용 행 없음 (No row applies)').toHaveText(FR_KO['status.NO_ROW']);
      await expect(list.statusPills(p10).nth(1), '[Expected 3] P10 carries a draft').toHaveText(FR_KO['state.DRAFT']);
      await expect(p14, '[Expected 3] P14 is listed').toBeVisible();
      await expect(list.cell(p14, 'compare'), '[Expected 3] P14 is clean (일치)').toHaveText(FR_KO['compare.MATCHES']);
      await expect(list.statusPills(p14).nth(1), '[Expected 3] P14 carries a draft').toHaveText(FR_KO['state.DRAFT']);
    });

    await step('Act: Step 4 — Click chip 정상 (Resolved cleanly)', async () => {
      under['bucket.OK'] = await b.idsUnder('bucket.OK');
    });

    await step('Assert: Expected 4 — P02 is listed; P14 is not listed', async () => {
      await expect(list.row(id('P02')), '[Expected 4] P02 is listed').toBeVisible();
      await expect(list.row(id('P14')), '[Expected 4] P14 is not listed').toHaveCount(0);
    });

    await step('Act: Step 5 — Click chip 잠정 적용 (Provisional) on a cycle holding a provisional product with no correction', async () => {
      notAutomated('Step 5 — no provisional fee row can be produced on this build (DEV-30)');
    });

    await step('Assert: Expected 5 — The provisional product is listed under Provisional, not under Needs review or Resolved cleanly', async () => {
      notAutomated('Expected 5 — needs a provisional product (DEV-30)');
    });

    await step('Act: Step 6 — Call GET /fee-review/cycles/CY_MAIN/products?size=100 and read bucket of P21 P03 P10 P14 P02', async () => {
      api = Object.fromEntries((await feeReviewApi.products(cy.id, { size: 100 })).content.map((r) => [r.productId, r.bucket]));
    });

    await step('Assert: Expected 6 — P21 NOT_COMPUTABLE · P03 NEEDS_REVIEW · P10 CORRECTED_THIS_PERIOD · P14 CORRECTED_THIS_PERIOD · P02 RESOLVED_CLEANLY', async () => {
      const expected = { P21: 'NOT_COMPUTABLE', P03: 'NEEDS_REVIEW', P10: 'CORRECTED_THIS_PERIOD', P14: 'CORRECTED_THIS_PERIOD', P02: 'RESOLVED_CLEANLY' };
      for (const [code, bucket] of Object.entries(expected)) expect(api[id(code)], `[Expected 6] ${code} bucket = ${bucket}`).toBe(bucket);
    });
  });

  test('TC_US079_41 — A product commerce has not assigned lands in Needs review', async ({ page, feeReviewPage: list, seedData, feeReviewApi }) => {
    const step = makeStep(page);
    const b = new FeeReviewListBPage(page, list);
    await tcMeta('TC_US079_41', 'Medium', TAGS, `P05 resolves cleanly to 12.50% but commerce assigns no fee row (지정 없음) → it counts in 확인 필요, not 정상; assigning R_A by SQL moves it to 정상 (일치) and clearing it again returns it. ${NAV} Deviation: after Step 5 the 확인 필요 chip is clicked inside the step to read where P05 is listed. ${PRIVATE}`);
    let s!: Seeded;
    let cy!: Seeded['cycles'][string];
    let okIds: string[] = [];
    let p05!: FeeReviewRow;
    const id = (code: string) => s.products[code];

    await step('Arrange: Pre-condition 1–11 — Contract ROOT (R_A), cycle CY_MAIN, products P05 (no slot) and P14, no correction', async () => {
      s = await seedData({ tc: 41, contracts: F_A, cycles: ['CY_MAIN'], private: true, products: [product('P05', MAIN), product('P14', MAIN)] });
      cy = s.cycles.CY_MAIN;
      expect((await feeReviewApi.products(cy.id, { keyword: s.prefix })).totalElements, 'Pre-condition 9 — 2 rows seeded').toBe(2);
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN, click 검색 (Search) and stay on chip 확인 필요 (Needs review)', async () => {
      await b.show(cy.id);
    });

    await step('Assert: Expected 1 — Needs review reads 1; P05 is listed with 산정 완료, 12.50%, 지정 없음', async () => {
      const row = list.row(id('P05'));
      await expect(b.chipNumber('bucket.EXC'), '[Expected 1] 확인 필요 (Needs review) reads 1').toHaveText('1');
      await expect(row, '[Expected 1] P05 is listed').toBeVisible();
      await expect(list.statusPills(row).first(), '[Expected 1] P05 shows 산정 완료 (Resolved)').toHaveText(FR_KO['status.RESOLVED']);
      await expect(list.cell(row, 'rate'), '[Expected 1] P05 shows 12.50%').toHaveText('12.50%');
      await expect(list.cell(row, 'compare'), '[Expected 1] P05 shows 지정 없음 (Not assigned)').toHaveText(FR_KO['compare.NOT_ASSIGNED']);
    });

    await step('Act: Step 2 — Click chip 정상 (Resolved cleanly)', async () => {
      okIds = await b.idsUnder('bucket.OK');
    });

    await step('Assert: Expected 2 — P05 is not listed (only P14)', async () => {
      expect(okIds, '[Expected 2] Only P14 is listed under 정상').toEqual([id('P14')]);
    });

    await step('Act: Step 3 — Call GET /fee-review/cycles/CY_MAIN/products?keyword=<P05>', async () => {
      p05 = await feeReviewApi.row(cy.id, id('P05'));
    });

    await step('Assert: Expected 3 — verdict = NOT_ASSIGNED, bucket = NEEDS_REVIEW, problems = [ASSIGNED_NE_RESOLVED]', async () => {
      expect(p05.verdict, '[Expected 3] verdict = NOT_ASSIGNED').toBe('NOT_ASSIGNED');
      expect(p05.bucket, '[Expected 3] bucket = NEEDS_REVIEW').toBe('NEEDS_REVIEW');
      expect(p05.problems, '[Expected 3] problems = [ASSIGNED_NE_RESOLVED]').toEqual(['ASSIGNED_NE_RESOLVED']);
    });

    await step('Act: Step 4 — SQL: set P05 default slot = R_A, then click Search', async () => {
      await feeReviewDb.updateProduct(id('P05'), { defaultSlotFeeRowId: s.family.rows.R_A });
      await b.searchAgain();
    });

    await step('Assert: Expected 4 — P05 shows 일치 and moves to Resolved cleanly; Needs review reads 0', async () => {
      const row = list.row(id('P05'));
      await expect(row, '[Expected 4] P05 is listed under 정상 (Resolved cleanly)').toBeVisible();
      await expect(list.cell(row, 'compare'), '[Expected 4] P05 shows 일치 (Matches)').toHaveText(FR_KO['compare.MATCHES']);
      await expect(b.chipNumber('bucket.EXC'), '[Expected 4] 확인 필요 (Needs review) reads 0').toHaveText('0');
    });

    await step('Act: Step 5 — SQL: set P05 default slot back to NULL, then click Search', async () => {
      await feeReviewDb.updateProduct(id('P05'), { defaultSlotFeeRowId: null });
      await b.searchAgain();
      await list.clickChip(list.chip('bucket.EXC'));
    });

    await step('Assert: Expected 5 — P05 returns to Needs review; Needs review reads 1', async () => {
      await expect(list.row(id('P05')), '[Expected 5] P05 is listed under 확인 필요 (Needs review)').toBeVisible();
      await expect(b.chipNumber('bucket.EXC'), '[Expected 5] 확인 필요 (Needs review) reads 1').toHaveText('1');
    });
  });

  test('TC_US079_42 — A rejected correction returns the product to Needs review and not Corrected this period', async ({ page, feeReviewPage: list, seedData, feeReviewApi, approverFeeReviewApi }) => {
    const step = makeStep(page);
    const b = new FeeReviewListBPage(page, list);
    await tcMeta('TC_US079_42', 'High', TAGS, `P03 (mismatch) is corrected to 음반 12.50% in the UI, submitted, and rejected by TOKEN_B; after Search it shows 반려됨 — 수정 후 재상신 and counts in 확인 필요 again, not in 이번 기 수정됨. ${NAV} Deviation: after Steps 2 and 5 the chip that holds P03 is clicked inside the step so its row can be read. ${PRIVATE}`);
    let s!: Seeded;
    let cy!: Seeded['cycles'][string];
    let correctionId = '';
    let rejected = 0;
    let record: RowDataPacket | undefined;
    let fixedIds: string[] = [];
    let api!: FeeReviewRow;
    const rejectReason = reasonOf('TC_US079_42', '카테고리 판단 오류');
    const id = (code: string) => s.products[code];

    await step('Arrange: Pre-condition 1–12 — Contracts ROOT / ANNEX1, cycle CY_MAIN, product P03 (mismatch, Needs review), no correction', async () => {
      s = await seedData({ tc: 42, contracts: F_AB_B9, cycles: ['CY_MAIN'], private: true, products: [product('P03', MAIN)] });
      cy = s.cycles.CY_MAIN;
      expect((await feeReviewApi.row(cy.id, id('P03'))).bucket, 'Pre-condition 10 — P03 is in NEEDS_REVIEW').toBe('NEEDS_REVIEW');
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN and click 검색 (Search)', async () => {
      await b.show(cy.id);
    });

    await step('Assert: Expected 1 — 확인 필요 (Needs review) reads 1 and lists P03', async () => {
      await expect(b.chipNumber('bucket.EXC'), '[Expected 1] 확인 필요 reads 1').toHaveText('1');
      await expect(list.row(id('P03')), '[Expected 1] P03 is listed').toBeVisible();
    });

    await step('Act: Step 2 — Correct P03 to 음반 (ALBUM) — 12.50% in 1단계 with a reason and click 저장 (Save)', async () => {
      await correctInUi(list, list.row(id('P03')), s.master.categoryName.A, reasonOf('TC_US079_42', 'Wrong category mapped in commerce'));
      await list.clickChip(list.chip('bucket.FIXED'));
    });

    await step('Assert: Expected 2 — Draft toast; P03 shows 수정됨 — 미상신, leaves Needs review (0) and counts in Corrected this period (1)', async () => {
      await expect(list.toast(FR_KO['fix.savedDraft']), '[Expected 2] Toast 승인 요청으로 상신되었습니다. 요율이 변경됩니다.').toBeVisible();
      await expect(list.statusPills(list.row(id('P03'))).nth(1), '[Expected 2] P03 shows 수정됨 — 미상신 (Corrected — not submitted)').toHaveText(FR_KO['state.DRAFT']);
      await expect(b.chipNumber('bucket.EXC'), '[Expected 2] 확인 필요 reads 0').toHaveText('0');
      await expect(b.chipNumber('bucket.FIXED'), '[Expected 2] 이번 기 수정됨 reads 1').toHaveText('1');
    });

    await step('Act: Step 3 — Tick P03 and click 선택 일괄 상신 (Submit selected)', async () => {
      await submitInUi(list, list.row(id('P03')));
    });

    await step('Assert: Expected 3 — Submit toast; P03 shows 승인 대기 and stays in Corrected this period', async () => {
      await expect(list.toast(frFormat(FR_KO['msg.submitted'], { n: 1 })), '[Expected 3] Toast 수정 1건을 승인 요청으로 상신했습니다.').toBeVisible();
      await expect(list.statusPills(list.row(id('P03'))).nth(1), '[Expected 3] P03 shows 승인 대기 (Awaiting approval)').toHaveText(FR_KO['state.PENDING']);
      await expect(list.row(id('P03')), '[Expected 3] P03 stays under 이번 기 수정됨').toBeVisible();
    });

    await step('Act: Step 4 — Read the change approval CA1 of the P03 correction and reject it with TOKEN_B', async () => {
      correctionId = await correctionIdOn(feeReviewApi, cy.id, id('P03'));
      rejected = (await approverFeeReviewApi.reject(await approvalIdOf(feeReviewApi, correctionId), rejectReason)).status;
      record = await correctionRecord(correctionId);
    });

    await step('Assert: Expected 4 — HTTP 200; fee_correction state = REJECTED with the rejection reason', async () => {
      expect(rejected, '[Expected 4] Reject returns HTTP 200').toBe(200);
      expect(record?.state, '[Expected 4] fee_correction.state = REJECTED').toBe('REJECTED');
      expect(record?.rejection_reason, '[Expected 4] fee_correction.rejection_reason is the reject reason').toBe(rejectReason);
    });

    await step('Act: Step 5 — As user A click 검색 (Search)', async () => {
      await b.searchAgain();
      await list.clickChip(list.chip('bucket.EXC'));
    });

    await step('Assert: Expected 5 — P03 shows 반려됨 — 수정 후 재상신; Needs review reads 1 and lists P03; Corrected this period reads 0', async () => {
      await expect(list.statusPills(list.row(id('P03'))).nth(1), '[Expected 5] P03 shows 반려됨 — 수정 후 재상신 (Rejected — fix and resubmit)').toHaveText(FR_KO['state.REJECTED']);
      await expect(b.chipNumber('bucket.EXC'), '[Expected 5] 확인 필요 reads 1').toHaveText('1');
      await expect(list.row(id('P03')), '[Expected 5] 확인 필요 lists P03').toBeVisible();
      await expect(b.chipNumber('bucket.FIXED'), '[Expected 5] 이번 기 수정됨 reads 0').toHaveText('0');
    });

    await step('Act: Step 6 — Click chip 이번 기 수정됨 (Corrected this period) and call the products API for P03', async () => {
      fixedIds = await b.idsUnder('bucket.FIXED');
      api = await feeReviewApi.row(cy.id, id('P03'));
    });

    await step('Assert: Expected 6 — Corrected this period lists no row; API bucket = NEEDS_REVIEW, correction.state = REJECTED', async () => {
      expect(fixedIds, '[Expected 6] 이번 기 수정됨 lists no row').toEqual([]);
      expect(api.bucket, '[Expected 6] bucket = NEEDS_REVIEW').toBe('NEEDS_REVIEW');
      expect(api.correction?.state, '[Expected 6] correction.state = REJECTED').toBe('REJECTED');
    });
  });

  test('TC_US079_43 — Provisional and corrected products are not counted in Needs review', async ({ page, feeReviewPage: list, seedData, feeReviewApi, approverFeeReviewApi }) => {
    const step = makeStep(page);
    const b = new FeeReviewListBPage(page, list);
    await tcMeta('TC_US079_43', 'Medium', TAGS, `P06 (no row applies) leaves 확인 필요 as soon as a correction is saved and stays out of it while pending and after approval (승인됨 — 적용, 12.50%), listed under 이번 기 수정됨. ${NAV} Deviation: after Step 2 the 이번 기 수정됨 chip is clicked inside the step so the P06 row can be read. Not automated: Step 5 / Expected 5 (잠정 적용 — Provisional) — no provisional fee row can be produced on this build (DEV-30). ${PRIVATE}`);
    let s!: Seeded;
    let cy!: Seeded['cycles'][string];
    const id = (code: string) => s.products[code];

    await step('Arrange: Pre-condition 1–12 — Contract ROOT (R_A), cycle CY_MAIN, product P06 (CAT_D, no row), no correction', async () => {
      s = await seedData({ tc: 43, contracts: F_A, cycles: ['CY_MAIN'], private: true, products: [product('P06', MAIN)] });
      cy = s.cycles.CY_MAIN;
      expect((await feeReviewApi.row(cy.id, id('P06'))).bucket, 'Pre-condition 9 — P06 is in NEEDS_REVIEW').toBe('NEEDS_REVIEW');
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN and click 검색 (Search)', async () => {
      await b.show(cy.id);
    });

    await step('Assert: Expected 1 — Needs review reads 1 and lists P06 (적용 행 없음)', async () => {
      await expect(b.chipNumber('bucket.EXC'), '[Expected 1] 확인 필요 reads 1').toHaveText('1');
      await expect(list.statusPills(list.row(id('P06'))).first(), '[Expected 1] P06 is listed with 적용 행 없음 (No row applies)').toHaveText(FR_KO['status.NO_ROW']);
    });

    await step('Act: Step 2 — Correct P06 to 음반 (ALBUM) — 12.50% with reason and click 저장 (Save)', async () => {
      await correctInUi(list, list.row(id('P06')), s.master.categoryName.A, reasonOf('TC_US079_43', '상품군 오매핑 교정'));
      await list.clickChip(list.chip('bucket.FIXED'));
    });

    await step('Assert: Expected 2 — P06 shows 수정됨 — 미상신; Needs review reads 0; Corrected this period lists P06', async () => {
      await expect(list.statusPills(list.row(id('P06'))).nth(1), '[Expected 2] P06 shows 수정됨 — 미상신').toHaveText(FR_KO['state.DRAFT']);
      await expect(b.chipNumber('bucket.EXC'), '[Expected 2] 확인 필요 reads 0 (without P06)').toHaveText('0');
      await expect(list.row(id('P06')), '[Expected 2] 이번 기 수정됨 lists P06').toBeVisible();
    });

    await step('Act: Step 3 — Tick P06 and click 선택 일괄 상신 (Submit selected)', async () => {
      await submitInUi(list, list.row(id('P06')));
    });

    await step('Assert: Expected 3 — P06 shows 승인 대기; Needs review still reads 0', async () => {
      await expect(list.statusPills(list.row(id('P06'))).nth(1), '[Expected 3] P06 shows 승인 대기 (Awaiting approval)').toHaveText(FR_KO['state.PENDING']);
      await expect(b.chipNumber('bucket.EXC'), '[Expected 3] 확인 필요 still reads 0').toHaveText('0');
    });

    await step('Act: Step 4 — Approve the P06 correction (CA1) with TOKEN_B, then click Search as user A', async () => {
      const approved = await approverFeeReviewApi.approve(await approvalIdOf(feeReviewApi, await correctionIdOn(feeReviewApi, cy.id, id('P06'))));
      expect(approved.status, 'TOKEN_B approves CA1').toBe(200);
      await b.searchAgain();
    });

    await step('Assert: Expected 4 — P06 shows 승인됨 — 적용 with 12.50%; Needs review still reads 0; Corrected this period lists P06', async () => {
      const row = list.row(id('P06'));
      await expect(list.statusPills(row).nth(1), '[Expected 4] P06 shows 승인됨 — 적용 (Approved — applied)').toHaveText(FR_KO['state.APPROVED']);
      await expect(list.cell(row, 'rate'), '[Expected 4] P06 shows 12.50%').toHaveText('12.50%');
      await expect(b.chipNumber('bucket.EXC'), '[Expected 4] 확인 필요 still reads 0').toHaveText('0');
      await expect(row, '[Expected 4] 이번 기 수정됨 lists P06').toBeVisible();
    });

    await step('Act: Step 5 — On a cycle holding a provisional product, click chip 확인 필요 then chip 잠정 적용', async () => {
      notAutomated('Step 5 — no provisional fee row can be produced on this build (DEV-30)');
    });

    await step('Assert: Expected 5 — The provisional product is not under Needs review; it is under Provisional', async () => {
      notAutomated('Expected 5 — needs a provisional product (DEV-30)');
    });
  });

  test('TC_US079_44 — A not-computable product stays out of Needs review so the review count can reach zero', async ({ page, feeReviewPage: list, seedData, feeReviewApi }) => {
    const step = makeStep(page);
    const b = new FeeReviewListBPage(page, list);
    await tcMeta('TC_US079_44', 'Medium', TAGS, `The bracket product P21 counts in 구간형 요율 — 산정 전 and never in 확인 필요, its 수정 is disabled with the bracket tooltip (title attribute), and on CY_NEXT (P14 clean + P21) 확인 필요 reaches 0. ${NAV} ${PRIVATE}`);
    let s!: Seeded;
    let excIds: string[] = [];
    const id = (code: string) => s.products[code];

    await step('Arrange: Pre-condition 1–13 — Contracts ROOT / ANNEX1 / CT3, cycles CY_MAIN (P03, P21) and CY_NEXT (P14, P21)', async () => {
      s = await seedData({
        tc: 44,
        contracts: F_AB_B9_CT3,
        cycles: ['CY_MAIN', 'CY_NEXT'],
        private: true,
        products: [product('P03', MAIN), product('P14', [{ cycle: 'CY_NEXT', saleLines: 1 }]), product('P21', [...MAIN, { cycle: 'CY_NEXT', saleLines: 1 }])],
      });
      expect((await feeReviewApi.products(s.cycles.CY_MAIN.id, { keyword: s.prefix })).totalElements, 'Pre-condition 11 — 2 rows on CY_MAIN').toBe(2);
      expect((await feeReviewApi.products(s.cycles.CY_NEXT.id, { keyword: s.prefix })).totalElements, 'Pre-condition 11 — 2 rows on CY_NEXT').toBe(2);
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN, click 검색 (Search) and stay on chip 확인 필요 (Needs review)', async () => {
      await b.show(s.cycles.CY_MAIN.id);
      excIds = await list.productIds();
    });

    await step('Assert: Expected 1 — Needs review reads 1 (P03); P21 is not listed', async () => {
      await expect(b.chipNumber('bucket.EXC'), '[Expected 1] 확인 필요 reads 1').toHaveText('1');
      expect(sorted([...new Set(excIds)]), '[Expected 1] Only P03 is listed').toEqual([id('P03')]);
      await expect(list.row(id('P21')), '[Expected 1] P21 is not listed').toHaveCount(0);
    });

    await step('Act: Step 2 — Click chip 구간형 요율 — 산정 전 (Not computable yet)', async () => {
      await list.clickChip(list.chip('bucket.NC'));
    });

    await step('Assert: Expected 2 — Not computable yet reads 1 and lists P21 with 구간형 요율 — 산정 전 and an empty rate', async () => {
      const row = list.row(id('P21'));
      await expect(b.chipNumber('bucket.NC'), '[Expected 2] 구간형 요율 — 산정 전 reads 1').toHaveText('1');
      await expect(list.statusPills(row).first(), '[Expected 2] P21 shows 구간형 요율 — 산정 전').toHaveText(FR_KO['status.NOT_COMPUTABLE']);
      await expect(list.cell(row, 'rate'), '[Expected 2] P21 shows no rate').not.toHaveText(/\d/);
    });

    await step('Act: Step 3 — Hover 수정 (Correct) on the P21 row', async () => {
      await list.correctWrapper(list.row(id('P21'))).hover();
    });

    await step('Assert: Expected 3 — Correct is disabled with the bracket tooltip', async () => {
      const row = list.row(id('P21'));
      await expect(list.rowButton(row, 'btn.correct'), '[Expected 3] 수정 (Correct) is disabled').toBeDisabled();
      await expect(list.correctWrapper(row), '[Expected 3] Tooltip 구간형 요율이라 이 화면에서는 산정할 수 없습니다 — …').toHaveAttribute('title', FR_KO['msg.correctDisabledBracket']);
    });

    await step('Act: Step 4 — Select CY_NEXT and click Search', async () => {
      await b.show(s.cycles.CY_NEXT.id);
    });

    await step('Assert: Expected 4 — Needs review 0, Not computable yet 1, 정상 1, 기간 내 판매 상품 2', async () => {
      await expect(b.chipNumber('bucket.EXC'), '[Expected 4] 확인 필요 reads 0').toHaveText('0');
      await expect(b.chipNumber('bucket.NC'), '[Expected 4] 구간형 요율 — 산정 전 reads 1').toHaveText('1');
      await expect(b.chipNumber('bucket.OK'), '[Expected 4] 정상 reads 1').toHaveText('1');
      await expect(b.chipNumber('bucket.ALL'), '[Expected 4] 기간 내 판매 상품 reads 2').toHaveText('2');
    });
  });

  test('TC_US079_45 — A product with a new problem after its correction retired counts in Needs review', async ({ page, feeReviewPage: list, seedData, feeReviewApi, approverFeeReviewApi }) => {
    const step = makeStep(page);
    const b = new FeeReviewListBPage(page, list);
    await tcMeta('TC_US079_45', 'Critical', TAGS, `An approved tier-1 correction on P14 (음반 → 팬클럽 키트 9.00%) retires once commerce assigns the corrected category; when commerce then moves the product back to 음반 the product resolves from the contract again (12.50%, 불일치), the retired correction is not re-applied and the product counts in 확인 필요, not 이번 기 수정됨. Build: develop still counts a RETIRED correction as in play — Steps 5 and 6 are expected to FAIL. ${NAV} ${SHARED} Deviation: after Step 4 chip 기간 내 판매 상품 is clicked inside the step so the P14 row can be read wherever it is bucketed. ${SHARED_DATA}`);
    let s!: Seeded;
    let cy!: Seeded['cycles'][string];
    let cor1 = '';
    let record: RowDataPacket | undefined;
    let excIds: string[] = [];
    let fixedIds: string[] = [];
    let api!: FeeReviewRow & Record<string, unknown>;
    const id = (code: string) => s.products[code];

    await step('Arrange: Pre-condition 1–15 — Contracts ROOT / ANNEX1, product P14 on CY_MAIN, COR1 (→ 팬클럽 키트) submitted and approved by TOKEN_B', async () => {
      s = await seedData({ tc: 45, contracts: F_A_B9, cycles: ['CY_MAIN'], products: [product('P14', MAIN)] });
      cy = s.cycles.CY_MAIN;
      cor1 = await saveCorrection(feeReviewApi, cy.id, id('P14'), tier1(s, 'B', reasonOf('TC_US079_45', 'Wrong category mapped in commerce')));
      await submitAndApprove(feeReviewApi, approverFeeReviewApi, [cor1]);
      const row = await feeReviewApi.row(cy.id, id('P14'));
      expect(row.inForceRate, 'Pre-condition 13 — P14 inForceRate 9.00').toBe('9.00');
      expect(row.bucket, 'Pre-condition 13 — P14 bucket CORRECTED_THIS_PERIOD').toBe('CORRECTED_THIS_PERIOD');
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN, click 검색 (Search), then chip 이번 기 수정됨 (Corrected this period)', async () => {
      await b.show(cy.id, s.prefix);
      await list.clickChip(list.chip('bucket.FIXED'));
    });

    await step('Assert: Expected 1 — P14 shows 승인됨 — 적용, category B, 9.00%', async () => {
      const row = list.row(id('P14'));
      await expect(list.statusPills(row).nth(1), '[Expected 1] P14 shows 승인됨 — 적용 (Approved — applied)').toHaveText(FR_KO['state.APPROVED']);
      await expect(list.cell(row, 'category'), `[Expected 1] P14 shows category B (${s.master.categoryName.B})`).toHaveText(s.master.categoryName.B);
      await expect(list.cell(row, 'rate'), '[Expected 1] P14 shows 9.00%').toHaveText('9.00%');
    });

    await step('Act: Step 2 — SQL: commerce now assigns category B with slot R_B9 to P14; click Search', async () => {
      await feeReviewDb.updateProduct(id('P14'), { categoryId: s.master.category.B, defaultSlotFeeRowId: s.family.rows.R_B9 });
      await b.searchAgain();
    });

    await step('Assert: Expected 2 — P14 shows 자동 해제 — 더 이상 불필요, 9.00% on one line, 일치, and stays under Corrected this period', async () => {
      const row = list.row(id('P14'));
      await expect(row, '[Expected 2] P14 stays under 이번 기 수정됨').toBeVisible();
      await expect(list.statusPills(row).nth(1), '[Expected 2] P14 shows 자동 해제 — 더 이상 불필요 (Retired — no longer needed)').toHaveText(FR_KO['state.RETIRED']);
      await expect(list.cell(row, 'rate'), '[Expected 2] P14 shows 9.00%').toHaveText('9.00%');
      await expect(list.secondLine(list.cell(row, 'rate')), '[Expected 2] The rate sits on one line').toHaveCount(0);
      await expect(list.cell(row, 'compare'), '[Expected 2] P14 shows 일치 (Matches)').toHaveText(FR_KO['compare.MATCHES']);
    });

    await step('Act: Step 3 — SQL: read state and retired_at of COR1', async () => {
      record = await correctionRecord(cor1);
    });

    await step('Assert: Expected 3 — state = RETIRED, retired_at is set', async () => {
      expect(record?.state, '[Expected 3] state = RETIRED').toBe('RETIRED');
      expect(record?.retired_at, '[Expected 3] retired_at is set').toBeTruthy();
    });

    await step('Act: Step 4 — SQL: commerce moves P14 back to category A (slot stays R_B9); click Search', async () => {
      await feeReviewDb.updateProduct(id('P14'), { categoryId: s.master.category.A });
      await b.searchAgain();
      await list.clickChip(list.chip('bucket.ALL'));
    });

    await step('Assert: Expected 4 — P14 resolves from category A: 12.50%, 불일치; the correction stays Retired and category B is not applied again', async () => {
      const row = list.row(id('P14'));
      await expect(list.cell(row, 'rate'), '[Expected 4] P14 shows 12.50%').toHaveText('12.50%');
      await expect(list.cell(row, 'compare'), '[Expected 4] P14 shows 불일치 (Mismatch)').toHaveText(FR_KO['compare.MISMATCH']);
      await expect(list.statusPills(row).nth(1), '[Expected 4] The correction stays 자동 해제 — 더 이상 불필요').toHaveText(FR_KO['state.RETIRED']);
      await expect(list.cell(row, 'category'), `[Expected 4] Category A (${s.master.categoryName.A}) is shown — B is not applied again`).toHaveText(s.master.categoryName.A);
    });

    await step('Act: Step 5 — Click chip 확인 필요 (Needs review), then chip 이번 기 수정됨 (Corrected this period)', async () => {
      excIds = await b.idsUnder('bucket.EXC');
      fixedIds = await b.idsUnder('bucket.FIXED');
    });

    await step('Assert: Expected 5 — Needs review lists P14; Corrected this period does not list it', async () => {
      expect(excIds, '[Expected 5] 확인 필요 lists P14').toContain(id('P14'));
      expect(fixedIds, '[Expected 5] 이번 기 수정됨 does not list P14').not.toContain(id('P14'));
    });

    await step('Act: Step 6 — Call GET /fee-review/cycles/CY_MAIN/products?keyword=<P14>', async () => {
      api = (await feeReviewApi.row(cy.id, id('P14'))) as FeeReviewRow & Record<string, unknown>;
    });

    await step('Assert: Expected 6 — bucket = NEEDS_REVIEW, correction.state = RETIRED, problems ∋ ASSIGNED_NE_RESOLVED, rateFromCorrection = false', async () => {
      expect(api.bucket, '[Expected 6] bucket = NEEDS_REVIEW').toBe('NEEDS_REVIEW');
      expect(api.correction?.state, '[Expected 6] correction.state = RETIRED').toBe('RETIRED');
      expect(api.problems, '[Expected 6] problems contains ASSIGNED_NE_RESOLVED').toContain('ASSIGNED_NE_RESOLVED');
      expect(api.rateFromCorrection, '[Expected 6] rateFromCorrection = false').toBe(false);
    });
  });

  test('TC_US079_46 — A correction retired this period with no new problem keeps the product in Corrected this period', async ({ page, feeReviewPage: list, seedData, feeReviewApi, approverFeeReviewApi }) => {
    const step = makeStep(page);
    const b = new FeeReviewListBPage(page, list);
    await tcMeta('TC_US079_46', 'Medium', TAGS, `A tier-1 correction raised and approved on CY_MAIN carries over to CY_NEXT; once commerce assigns the corrected category it retires — CY_MAIN keeps P14 under 이번 기 수정됨 (자동 해제, 9.00%, 일치), while on CY_NEXT P14 re-buckets by the contract answer into 정상 (DEV-44). ${NAV} ${SHARED} Deviation: Expected 2 "1 row updated" is checked as exactly one fixture row now carrying CAT_B / R_B9 (the shared DB helper does not return the affected-row count). ${SHARED_DATA}`);
    let s!: Seeded;
    let cor1 = '';
    let updated = -1;
    let record: RowDataPacket | undefined;
    let okIds: string[] = [];
    let fixedIds: string[] = [];
    let main!: FeeReviewRow;
    let next!: FeeReviewRow;
    const id = (code: string) => s.products[code];

    await step('Arrange: Pre-condition 1–15 — Contracts ROOT / ANNEX1, P14 on CY_MAIN and CY_NEXT, COR1 (→ 팬클럽 키트) raised on CY_MAIN, submitted and approved', async () => {
      s = await seedData({ tc: 46, contracts: F_A_B9, cycles: ['CY_MAIN', 'CY_NEXT'], products: [product('P14', [...MAIN, { cycle: 'CY_NEXT', saleLines: 5 }])] });
      cor1 = await saveCorrection(feeReviewApi, s.cycles.CY_MAIN.id, id('P14'), tier1(s, 'B', reasonOf('TC_US079_46', 'Wrong category mapped in commerce')));
      await submitAndApprove(feeReviewApi, approverFeeReviewApi, [cor1]);
      expect((await feeReviewApi.row(s.cycles.CY_NEXT.id, id('P14'))).correction?.state, 'Pre-condition 13 — COR1 is APPROVED on CY_NEXT').toBe('APPROVED');
    });

    await step('Act: Step 1 — Open the screen on CY_NEXT, click 검색 (Search) and chip 이번 기 수정됨 (Corrected this period)', async () => {
      await b.show(s.cycles.CY_NEXT.id, s.prefix);
      await list.clickChip(list.chip('bucket.FIXED'));
    });

    await step('Assert: Expected 1 — P14 is listed with 승인됨 — 적용, category B, 9.00%', async () => {
      const row = list.row(id('P14'));
      await expect(row, '[Expected 1] P14 is listed under 이번 기 수정됨').toBeVisible();
      await expect(list.statusPills(row).nth(1), '[Expected 1] P14 shows 승인됨 — 적용').toHaveText(FR_KO['state.APPROVED']);
      await expect(list.cell(row, 'category'), `[Expected 1] P14 shows category B (${s.master.categoryName.B})`).toHaveText(s.master.categoryName.B);
      await expect(list.cell(row, 'rate'), '[Expected 1] P14 shows 9.00%').toHaveText('9.00%');
    });

    await step('Act: Step 2 — SQL: commerce now assigns category B with slot R_B9 to P14', async () => {
      await feeReviewDb.updateProduct(id('P14'), { categoryId: s.master.category.B, defaultSlotFeeRowId: s.family.rows.R_B9 });
      const [record2] = await feeReviewDb.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM fee_review_fixture_product WHERE product_id = ? AND category_id = ? AND default_slot_fee_row_id = ?', [id('P14'), s.master.category.B, s.family.rows.R_B9]);
      updated = Number(record2.n);
    });

    await step('Assert: Expected 2 — 1 row updated', async () => {
      expect(updated, '[Expected 2] Exactly one fixture row now carries CAT_B / R_B9').toBe(1);
    });

    await step('Act: Step 3 — Select CY_MAIN, click Search and click chip 이번 기 수정됨', async () => {
      await b.show(s.cycles.CY_MAIN.id, s.prefix);
      await list.clickChip(list.chip('bucket.FIXED'));
    });

    await step('Assert: Expected 3 — P14 shows 자동 해제 — 더 이상 불필요, 9.00% on one line, 일치, and stays under Corrected this period', async () => {
      const row = list.row(id('P14'));
      await expect(row, '[Expected 3] P14 stays under 이번 기 수정됨').toBeVisible();
      await expect(list.statusPills(row).nth(1), '[Expected 3] P14 shows 자동 해제 — 더 이상 불필요').toHaveText(FR_KO['state.RETIRED']);
      await expect(list.cell(row, 'rate'), '[Expected 3] P14 shows 9.00%').toHaveText('9.00%');
      await expect(list.secondLine(list.cell(row, 'rate')), '[Expected 3] The rate sits on one line').toHaveCount(0);
      await expect(list.cell(row, 'compare'), '[Expected 3] P14 shows 일치 (Matches)').toHaveText(FR_KO['compare.MATCHES']);
    });

    await step('Act: Step 4 — SQL: read state and retired_at of COR1', async () => {
      record = await correctionRecord(cor1);
    });

    await step('Assert: Expected 4 — state = RETIRED, retired_at is set', async () => {
      expect(record?.state, '[Expected 4] state = RETIRED').toBe('RETIRED');
      expect(record?.retired_at, '[Expected 4] retired_at is set').toBeTruthy();
    });

    await step('Act: Step 5 — Select CY_NEXT, click Search, then click chip 정상 (Resolved cleanly)', async () => {
      await b.show(s.cycles.CY_NEXT.id, s.prefix);
      fixedIds = await b.idsUnder('bucket.FIXED');
      okIds = await b.idsUnder('bucket.OK');
    });

    await step('Assert: Expected 5 — On CY_NEXT P14 is listed under Resolved cleanly and not under Corrected this period', async () => {
      expect(okIds, '[Expected 5] 정상 lists P14').toContain(id('P14'));
      expect(fixedIds, '[Expected 5] 이번 기 수정됨 does not list P14').not.toContain(id('P14'));
    });

    await step('Act: Step 6 — Call the products API for P14 on CY_MAIN and on CY_NEXT', async () => {
      main = await feeReviewApi.row(s.cycles.CY_MAIN.id, id('P14'));
      next = await feeReviewApi.row(s.cycles.CY_NEXT.id, id('P14'));
    });

    await step('Assert: Expected 6 — CY_MAIN bucket = CORRECTED_THIS_PERIOD; CY_NEXT bucket = RESOLVED_CLEANLY; both correction.state = RETIRED', async () => {
      expect(main.bucket, '[Expected 6] CY_MAIN bucket = CORRECTED_THIS_PERIOD').toBe('CORRECTED_THIS_PERIOD');
      expect(next.bucket, '[Expected 6] CY_NEXT bucket = RESOLVED_CLEANLY').toBe('RESOLVED_CLEANLY');
      expect(main.correction?.state, '[Expected 6] CY_MAIN correction.state = RETIRED').toBe('RETIRED');
      expect(next.correction?.state, '[Expected 6] CY_NEXT correction.state = RETIRED').toBe('RETIRED');
    });
  });

  test('TC_US079_47 — The problem-type buckets overlap and Assigned ≠ resolved holds both Mismatch and Not assigned', async ({ page, feeReviewPage: list, seedData, feeReviewApi }) => {
    const step = makeStep(page);
    const b = new FeeReviewListBPage(page, list);
    await tcMeta('TC_US079_47', 'Medium', TAGS, `The second chip group (유형별 — 위 항목과 중복됨 (합계 아님)) overlaps: 지정 ↔ 산정 불일치 4 (P03 mismatch + P04 / P05 / P06 not assigned), 적용 행 없음 1 (P06), 중복 적용 1 (P04), 원천 수정 필요 0 — 6 against a total of 5. ${NAV} ${PRIVATE}`);
    let s!: Seeded;
    const counts: Record<string, string> = {};
    const under: Partial<Record<ChipKey, string[]>> = {};
    const id = (code: string) => s.products[code];

    await step('Arrange: Pre-condition 1–13 — Contracts ROOT / ANNEX1 / ANNEX2, cycle CY_MAIN, products P03 P04 P05 P06 P14, no correction', async () => {
      s = await seedData({ tc: 47, contracts: F_ABC, cycles: ['CY_MAIN'], private: true, products: (['P03', 'P04', 'P05', 'P06', 'P14'] as ProductCode[]).map((c) => product(c, MAIN)) });
      expect((await feeReviewApi.products(s.cycles.CY_MAIN.id, { keyword: s.prefix })).totalElements, 'Pre-condition 11 — 5 rows seeded').toBe(5);
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN and click 검색 (Search)', async () => {
      await b.show(s.cycles.CY_MAIN.id);
    });

    await step('Assert: Expected 1 — The list loads for CY_MAIN', async () => {
      await expect(list.cycleSelect.locator('option:checked'), `[Expected 1] 정산 주기 shows ${s.cycles.CY_MAIN.label}`).toHaveText(s.cycles.CY_MAIN.label);
      await expect(list.table, '[Expected 1] The list table is shown').toBeVisible();
    });

    await step('Act: Step 2 — Read the caption and counts of the second chip group', async () => {
      await list.sliceGroup.scrollIntoViewIfNeeded();
      for (const key of ['bucket.ALL', 'bucket.DIFF', 'bucket.NF', 'bucket.AMB', 'bucket.SRCDIFF'] as ChipKey[]) counts[key] = ((await b.chipNumber(key).textContent()) ?? '').trim();
    });

    await step('Assert: Expected 2 — Caption 유형별 — 위 항목과 중복됨 (합계 아님); Assigned ≠ resolved 4, No row applies 1, Ambiguous 1, Source needs fixing 0 — 6, more than the total 5', async () => {
      await expect(list.sliceCaption, '[Expected 2] Caption 유형별 — 위 항목과 중복됨 (합계 아님)').toHaveText(FR_KO['strip.slice']);
      expect(counts['bucket.DIFF'], '[Expected 2] 지정 ↔ 산정 불일치 reads 4').toBe('4');
      expect(counts['bucket.NF'], '[Expected 2] 적용 행 없음 reads 1').toBe('1');
      expect(counts['bucket.AMB'], '[Expected 2] 중복 적용 reads 1').toBe('1');
      expect(counts['bucket.SRCDIFF'], '[Expected 2] 원천 수정 필요 reads 0').toBe('0');
      const sum = ['bucket.DIFF', 'bucket.NF', 'bucket.AMB', 'bucket.SRCDIFF'].reduce((acc, key) => acc + Number(counts[key]), 0);
      expect(sum, '[Expected 2] The four counts add up to 6').toBe(6);
      expect(counts['bucket.ALL'], '[Expected 2] The total (기간 내 판매 상품) is 5 — less than the sum').toBe('5');
    });

    await step('Act: Step 3 — Click chip 지정 ↔ 산정 불일치 (Assigned ≠ resolved)', async () => {
      under['bucket.DIFF'] = await b.idsUnder('bucket.DIFF');
    });

    await step('Assert: Expected 3 — 4 rows: P03 with 불일치, and P04, P05, P06 with 지정 없음', async () => {
      expect(under['bucket.DIFF'], '[Expected 3] P03, P04, P05, P06 are listed').toEqual(sorted(['P03', 'P04', 'P05', 'P06'].map(id)));
      await expect(list.cell(list.row(id('P03')), 'compare'), '[Expected 3] P03 shows 불일치 (Mismatch)').toHaveText(FR_KO['compare.MISMATCH']);
      for (const code of ['P04', 'P05', 'P06']) await expect(list.cell(list.row(id(code)), 'compare'), `[Expected 3] ${code} shows 지정 없음 (Not assigned)`).toHaveText(FR_KO['compare.NOT_ASSIGNED']);
    });

    await step('Act: Step 4 — Click chip 적용 행 없음 (No row applies)', async () => {
      under['bucket.NF'] = await b.idsUnder('bucket.NF');
    });

    await step('Assert: Expected 4 — 1 row: P06 — also listed in step 3', async () => {
      expect(under['bucket.NF'], '[Expected 4] Only P06 is listed').toEqual([id('P06')]);
      expect(under['bucket.DIFF'], '[Expected 4] P06 is also listed under 지정 ↔ 산정 불일치').toContain(id('P06'));
    });

    await step('Act: Step 5 — Click chip 중복 적용 (Ambiguous)', async () => {
      under['bucket.AMB'] = await b.idsUnder('bucket.AMB');
    });

    await step('Assert: Expected 5 — 1 row P04 — also listed in step 3', async () => {
      expect(under['bucket.AMB'], '[Expected 5] Only P04 is listed').toEqual([id('P04')]);
      expect(under['bucket.DIFF'], '[Expected 5] P04 is also listed under 지정 ↔ 산정 불일치').toContain(id('P04'));
    });
  });

  test('TC_US079_48 — Source needs fixing lists only tier-1 corrections in force that commerce still disagrees with', async ({ page, feeReviewPage: list, seedData, feeReviewApi, approverFeeReviewApi, contractsApi, approverContractsApi }) => {
    const step = makeStep(page);
    const b = new FeeReviewListBPage(page, list);
    await tcMeta('TC_US079_48', 'Medium', TAGS, `원천 수정 필요 lists only tier-1 corrections in force that commerce still disagrees with: P14 (APPROVED A→B) and P05 (APPLIED A→D), not P10 (tier 2) or P03 (draft); once commerce assigns B to P14 its correction retires and only P05 remains. ${NAV} Deviation: in Step 3 chip 기간 내 판매 상품 is clicked inside the step to read the P14 pill before chip 원천 수정 필요. ${PRIVATE}`);
    let s!: Seeded;
    let cy!: Seeded['cycles'][string];
    const under: Partial<Record<ChipKey, string[]>> = {};
    let p14Pill = '';
    let api!: FeeReviewPage;
    const id = (code: string) => s.products[code];

    await step('Arrange: Pre-condition 1–21 — Contracts ROOT / ANNEX1 / ANNEX2 + approved row R_D, CY_MAIN, P03 P04 P05 P10 P14; COR1 P14 APPROVED, COR2 P05 APPLIED, COR3 P10 APPROVED, COR4 P03 DRAFT', async () => {
      s = await seedData({ tc: 48, contracts: F_ABC, cycles: ['CY_MAIN'], private: true, products: (['P03', 'P04', 'P05', 'P10', 'P14'] as ProductCode[]).map((c) => product(c, MAIN)) });
      cy = s.cycles.CY_MAIN;
      await addApprovedRow(contractsApi, approverContractsApi, s.family.contracts.ROOT, feeRowBody(s, 'D', 12.5, '2020-01-01', 'R_D'));
      const cor1 = await saveCorrection(feeReviewApi, cy.id, id('P14'), tier1(s, 'B', reasonOf('TC_US079_48', 'Wrong category mapped in commerce')));
      await saveCorrection(feeReviewApi, cy.id, id('P05'), tier1(s, 'D', reasonOf('TC_US079_48', 'Mapped to the MD category by contract')));
      const cor3 = await saveCorrection(feeReviewApi, cy.id, id('P10'), { tier: 'RATE_OVERRIDE', overrideRate: '6.75', reason: reasonOf('TC_US079_48', '유사 계약 요율 적용') });
      await submitAndApprove(feeReviewApi, approverFeeReviewApi, [cor1, cor3]);
      await saveCorrection(feeReviewApi, cy.id, id('P03'), tier1(s, 'A', reasonOf('TC_US079_48', '카테고리 오매핑 정정')));
      const rows = Object.fromEntries((await feeReviewApi.products(cy.id, { keyword: s.prefix })).content.map((r) => [r.productId, r.correction?.state]));
      expect(rows, 'Pre-condition 19 — correction states seeded').toEqual({ [id('P14')]: 'APPROVED', [id('P05')]: 'APPLIED', [id('P10')]: 'APPROVED', [id('P03')]: 'DRAFT', [id('P04')]: undefined });
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN, click 검색 (Search), then chip 원천 수정 필요 (Source needs fixing)', async () => {
      await b.show(cy.id);
      under['bucket.SRCDIFF'] = await b.idsUnder('bucket.SRCDIFF');
    });

    await step('Assert: Expected 1 — Source needs fixing reads 2 and lists P05, P14; P10 (tier 2) and P03 (draft) are not listed', async () => {
      await expect(b.chipNumber('bucket.SRCDIFF'), '[Expected 1] 원천 수정 필요 reads 2').toHaveText('2');
      expect(under['bucket.SRCDIFF'], '[Expected 1] P05 and P14 are listed').toEqual(sorted([id('P05'), id('P14')]));
      await expect(list.row(id('P10')), '[Expected 1] P10 (tier 2) is not listed').toHaveCount(0);
      await expect(list.row(id('P03')), '[Expected 1] P03 (draft) is not listed').toHaveCount(0);
    });

    await step('Act: Step 2 — Click chip 지정 ↔ 산정 불일치 (Assigned ≠ resolved)', async () => {
      under['bucket.DIFF'] = await b.idsUnder('bucket.DIFF');
    });

    await step('Assert: Expected 2 — A different set: it includes P14 (불일치) and P04, which has no correction', async () => {
      expect(under['bucket.DIFF'], '[Expected 2] The set differs from 원천 수정 필요').not.toEqual(under['bucket.SRCDIFF']);
      expect(under['bucket.DIFF'], '[Expected 2] P14 is listed').toContain(id('P14'));
      await expect(list.cell(list.row(id('P14')), 'compare'), '[Expected 2] P14 shows 불일치 (Mismatch)').toHaveText(FR_KO['compare.MISMATCH']);
      expect(under['bucket.DIFF'], '[Expected 2] P04 is listed').toContain(id('P04'));
      await expect(list.statusPills(list.row(id('P04'))), '[Expected 2] P04 carries no correction').toHaveCount(1);
    });

    await step('Act: Step 3 — SQL: commerce now assigns category B with slot R_B9 to P14; click Search and chip 원천 수정 필요', async () => {
      await feeReviewDb.updateProduct(id('P14'), { categoryId: s.master.category.B, defaultSlotFeeRowId: s.family.rows.R_B9 });
      await b.searchAgain();
      await list.clickChip(list.chip('bucket.ALL'));
      p14Pill = ((await list.statusPills(list.row(id('P14'))).nth(1).textContent()) ?? '').trim();
      under['bucket.SRCDIFF'] = await b.idsUnder('bucket.SRCDIFF');
    });

    await step('Assert: Expected 3 — P14 shows 자동 해제 — 더 이상 불필요; Source needs fixing reads 1 and lists P05 only', async () => {
      expect(p14Pill, '[Expected 3] P14 shows 자동 해제 — 더 이상 불필요 (Retired — no longer needed)').toBe(FR_KO['state.RETIRED']);
      await expect(b.chipNumber('bucket.SRCDIFF'), '[Expected 3] 원천 수정 필요 reads 1').toHaveText('1');
      expect(under['bucket.SRCDIFF'], '[Expected 3] Only P05 is listed').toEqual([id('P05')]);
    });

    await step('Act: Step 4 — Call GET /fee-review/cycles/CY_MAIN/products?problem=SOURCE_NEEDS_FIXING', async () => {
      api = await feeReviewApi.products(cy.id, { problem: 'SOURCE_NEEDS_FIXING' });
    });

    await step('Assert: Expected 4 — totalElements = 1, the item is P05', async () => {
      expect(api.totalElements, '[Expected 4] totalElements = 1').toBe(1);
      expect(api.content[0]?.productId, '[Expected 4] The item is P05').toBe(id('P05'));
    });
  });

  test('TC_US079_49 — Selecting each bucket filters the list to exactly the products counted in it', async ({ page, feeReviewPage: list, seedData, feeReviewApi, approverFeeReviewApi }) => {
    const step = makeStep(page);
    const b = new FeeReviewListBPage(page, list);
    await tcMeta('TC_US079_49', 'Medium', TAGS, `Each of the ten chips filters the list to exactly the products it counts (8 products covering clean, mismatch, ambiguous, no row, out-of-date, bracket, fixed-unit without a rate and an approved correction). ${NAV} Deviation: CT4's FIXED_UNIT row is created through the shared seed helper, which sends pgCommissionRate 3 + feeBase (the TC body has pgCommissionRate 0, no feeBase). Deviation: in Step 9 chip 기간 내 판매 상품 is clicked inside the step to read the P21 verdict before chip 지정 ↔ 산정 불일치. ${PRIVATE}`);
    let s!: Seeded;
    let cy!: Seeded['cycles'][string];
    const under: Partial<Record<ChipKey, string[]>> = {};
    let rowsOnAll = 0;
    let p21Verdict = '';
    const id = (code: string) => s.products[code];
    const fixedUnit = rowDef('R_FIXED', { category: 'B', type: 'FIXED_UNIT' as unknown as RowDef['type'], rate: 500 });
    const contracts = family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9', 'R_C20'], ANNEX2: ['R_C22'], CT2: { rows: [rowDef('R_A_CT2', { category: 'A', rate: 12.5 })], endAt: '2030-12-31T00:00:00Z' }, CT3: ['R_MARGIN'], CT4: [fixedUnit] });

    await step('Arrange: Pre-condition 1–20 — Contracts ROOT / ANNEX1 / ANNEX2 / CT2 / CT3 / CT4, CY_MAIN, 8 products, COR1 on P14 approved; 페이지당 20', async () => {
      s = await seedData({ tc: 49, contracts, cycles: ['CY_MAIN'], private: true, products: (['P01', 'P03', 'P04', 'P06', 'P14', 'P20', 'P21', 'P22'] as ProductCode[]).map((c) => product(c, MAIN)) });
      cy = s.cycles.CY_MAIN;
      const cor1 = await saveCorrection(feeReviewApi, cy.id, id('P14'), tier1(s, 'B', reasonOf('TC_US079_49', 'Wrong category mapped in commerce')));
      await submitAndApprove(feeReviewApi, approverFeeReviewApi, [cor1]);
      expect((await feeReviewApi.products(cy.id, { keyword: s.prefix })).totalElements, 'Pre-condition 17 — 8 rows seeded').toBe(8);
    });

    const chipSteps: Array<{ n: number; key: ChipKey; label: string; count: string; codes: string[] }> = [
      { n: 2, key: 'bucket.EXC', label: '확인 필요 (Needs review)', count: '5', codes: ['P03', 'P04', 'P06', 'P20', 'P22'] },
      { n: 3, key: 'bucket.NC', label: '구간형 요율 — 산정 전 (Not computable yet)', count: '1', codes: ['P21'] },
      { n: 4, key: 'bucket.PROV', label: '잠정 적용 (Provisional)', count: '0', codes: [] },
      { n: 5, key: 'bucket.FIXED', label: '이번 기 수정됨 (Corrected this period)', count: '1', codes: ['P14'] },
      { n: 6, key: 'bucket.OK', label: '정상 (Resolved cleanly)', count: '1', codes: ['P01'] },
      { n: 7, key: 'bucket.NF', label: '적용 행 없음 (No row applies)', count: '2', codes: ['P06', 'P20'] },
      { n: 8, key: 'bucket.AMB', label: '중복 적용 (Ambiguous)', count: '1', codes: ['P04'] },
      { n: 9, key: 'bucket.DIFF', label: '지정 ↔ 산정 불일치 (Assigned ≠ resolved)', count: '6', codes: ['P03', 'P04', 'P06', 'P14', 'P20', 'P22'] },
      { n: 10, key: 'bucket.SRCDIFF', label: '원천 수정 필요 (Source needs fixing)', count: '1', codes: ['P14'] },
    ];

    await step('Act: Step 1 — Open the screen on CY_MAIN, click 검색 (Search), then chip 기간 내 판매 상품 (Products sold in period)', async () => {
      await b.show(cy.id, undefined, '20');
      under['bucket.ALL'] = await b.idsUnder('bucket.ALL');
      rowsOnAll = await list.rows.count();
    });

    await step('Assert: Expected 1 — Chip reads 8 and the list holds 8 rows', async () => {
      await expect(b.chipNumber('bucket.ALL'), '[Expected 1] 기간 내 판매 상품 reads 8').toHaveText('8');
      expect(rowsOnAll, '[Expected 1] The list holds 8 rows').toBe(8);
    });

    for (const c of chipSteps) {
      await step(`Act: Step ${c.n} — Click chip ${c.label}`, async () => {
        if (c.key === 'bucket.DIFF') {
          await list.clickChip(list.chip('bucket.ALL'));
          p21Verdict = ((await list.cell(list.row(id('P21')), 'compare').textContent()) ?? '').trim();
        }
        under[c.key] = await b.idsUnder(c.key);
      });

      await step(`Assert: Expected ${c.n} — Chip reads ${c.count}; ${c.codes.length ? `rows: ${c.codes.join(', ')}` : 'no row'}`, async () => {
        await expect(b.chipNumber(c.key), `[Expected ${c.n}] ${c.label} reads ${c.count}`).toHaveText(c.count);
        expect(under[c.key], `[Expected ${c.n}] Rows: ${c.codes.join(', ') || 'none'}`).toEqual(sorted(c.codes.map(id)));
        if (c.key === 'bucket.DIFF') {
          expect(p21Verdict, '[Expected 9] P21 shows verdict —').toBe('—');
          expect(under[c.key], '[Expected 9] P21 is not counted').not.toContain(id('P21'));
        }
      });
    }
  });

  test('TC_US079_50 — A draft, pending or rejected correction shows two lines and an applied, approved or retired one shows one', async ({ page, feeReviewPage: list, seedData, feeReviewApi, approverFeeReviewApi, contractsApi, approverContractsApi }) => {
    const step = makeStep(page);
    const b = new FeeReviewListBPage(page, list);
    await tcMeta('TC_US079_50', 'High', TAGS, `The category and rate cells show the in-force value with the proposed value dimmed below while a correction is DRAFT / PENDING / REJECTED, and a single line once it is APPROVED / RETIRED / APPLIED. ${NAV} Deviation: chip 기간 내 판매 상품 is clicked in Step 1 before 수정 so every row stays listed as it changes bucket. "Dimmed" is measured as the second line having a different text colour or an opacity below 1. ${PRIVATE}`);
    let s!: Seeded;
    let cy!: Seeded['cycles'][string];
    const id = (code: string) => s.products[code];
    const two = async (n: number, code: string, cell: 'category' | 'rate', main: string, below: string) => {
      const target = list.cell(list.row(id(code)), cell);
      expect(await b.mainLine(target), `[Expected ${n}] ${code} ${cell} cell main line ${main}`).toBe(main);
      await expect(list.secondLine(target), `[Expected ${n}] ${code} ${cell} cell shows ${below} below`).toContainText(below);
      expect(await b.isDimmed(target), `[Expected ${n}] ${code} ${cell} cell second line is dimmed`).toBe(true);
    };
    const one = async (n: number, code: string, category: string, rate: string) => {
      const row = list.row(id(code));
      await expect(list.cell(row, 'category'), `[Expected ${n}] ${code} category on one line: ${category}`).toHaveText(category);
      await expect(list.secondLine(list.cell(row, 'category')), `[Expected ${n}] ${code} category cell has no second line`).toHaveCount(0);
      await expect(list.cell(row, 'rate'), `[Expected ${n}] ${code} rate on one line: ${rate}`).toHaveText(rate);
      await expect(list.secondLine(list.cell(row, 'rate')), `[Expected ${n}] ${code} rate cell has no second line`).toHaveCount(0);
    };

    await step('Arrange: Pre-condition 1–14 — Contracts ROOT / ANNEX1 + approved row R_D, cycle CY_MAIN, products P03 P05 P14, no correction', async () => {
      s = await seedData({ tc: 50, contracts: F_AB_B9, cycles: ['CY_MAIN'], private: true, products: [product('P03', MAIN), product('P05', MAIN), product('P14', MAIN)] });
      cy = s.cycles.CY_MAIN;
      await addApprovedRow(contractsApi, approverContractsApi, s.family.contracts.ROOT, feeRowBody(s, 'D', 12.5, '2020-01-01', 'R_D'));
      expect((await feeReviewApi.products(cy.id, { keyword: s.prefix })).totalElements, 'Pre-condition 12 — 3 rows seeded').toBe(3);
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN; correct P14 to category B — 9.00% with reason and click 저장 (Save)', async () => {
      await b.show(cy.id);
      await list.clickChip(list.chip('bucket.ALL'));
      await correctInUi(list, list.row(id('P14')), s.master.categoryName.B, reasonOf('TC_US079_50', 'Wrong category mapped in commerce'));
    });

    await step('Assert: Expected 1 — P14 shows 수정됨 — 미상신; category 음반 with 팬클럽 키트 dimmed below; rate 12.50% with → 9.00% dimmed', async () => {
      await expect(list.statusPills(list.row(id('P14'))).nth(1), '[Expected 1] P14 shows 수정됨 — 미상신').toHaveText(FR_KO['state.DRAFT']);
      await two(1, 'P14', 'category', s.master.categoryName.A, s.master.categoryName.B);
      await two(1, 'P14', 'rate', '12.50%', '→ 9.00%');
    });

    await step('Act: Step 2 — Tick P14 and click 선택 일괄 상신 (Submit selected)', async () => {
      await submitInUi(list, list.row(id('P14')));
    });

    await step('Assert: Expected 2 — P14 shows 승인 대기; both cells keep the two lines', async () => {
      await expect(list.statusPills(list.row(id('P14'))).nth(1), '[Expected 2] P14 shows 승인 대기').toHaveText(FR_KO['state.PENDING']);
      await two(2, 'P14', 'category', s.master.categoryName.A, s.master.categoryName.B);
      await two(2, 'P14', 'rate', '12.50%', '→ 9.00%');
    });

    await step('Act: Step 3 — Approve the P14 correction (CA1) with TOKEN_B; as user A click Search', async () => {
      const approved = await approverFeeReviewApi.approve(await approvalIdOf(feeReviewApi, await correctionIdOn(feeReviewApi, cy.id, id('P14'))));
      expect(approved.status, 'TOKEN_B approves CA1').toBe(200);
      await b.searchAgain();
    });

    await step('Assert: Expected 3 — P14 shows 승인됨 — 적용; one line only: 팬클럽 키트, 9.00%', async () => {
      await expect(list.statusPills(list.row(id('P14'))).nth(1), '[Expected 3] P14 shows 승인됨 — 적용').toHaveText(FR_KO['state.APPROVED']);
      await one(3, 'P14', s.master.categoryName.B, '9.00%');
    });

    await step('Act: Step 4 — SQL: commerce now assigns category B with slot R_B9 to P14; click Search', async () => {
      await feeReviewDb.updateProduct(id('P14'), { categoryId: s.master.category.B, defaultSlotFeeRowId: s.family.rows.R_B9 });
      await b.searchAgain();
    });

    await step('Assert: Expected 4 — P14 shows 자동 해제 — 더 이상 불필요; one line only: 팬클럽 키트, 9.00%', async () => {
      await expect(list.statusPills(list.row(id('P14'))).nth(1), '[Expected 4] P14 shows 자동 해제 — 더 이상 불필요').toHaveText(FR_KO['state.RETIRED']);
      await one(4, 'P14', s.master.categoryName.B, '9.00%');
    });

    await step('Act: Step 5 — Correct P03 to category A — 12.50%, submit it, reject its approval (CA2) with TOKEN_B, then click Search', async () => {
      await correctInUi(list, list.row(id('P03')), s.master.categoryName.A, reasonOf('TC_US079_50', '카테고리 오매핑 정정'));
      await submitInUi(list, list.row(id('P03')));
      const rejected = await approverFeeReviewApi.reject(await approvalIdOf(feeReviewApi, await correctionIdOn(feeReviewApi, cy.id, id('P03'))), reasonOf('TC_US079_50', '근거 계약 확인 필요'));
      expect(rejected.status, 'TOKEN_B rejects CA2').toBe(200);
      await b.searchAgain();
    });

    await step('Assert: Expected 5 — P03 shows 반려됨 — 수정 후 재상신; category 팬클럽 키트 with 음반 dimmed below; rate 9.00% with → 12.50% dimmed', async () => {
      await expect(list.statusPills(list.row(id('P03'))).nth(1), '[Expected 5] P03 shows 반려됨 — 수정 후 재상신').toHaveText(FR_KO['state.REJECTED']);
      await two(5, 'P03', 'category', s.master.categoryName.B, s.master.categoryName.A);
      await two(5, 'P03', 'rate', '9.00%', '→ 12.50%');
    });

    await step('Act: Step 6 — Correct P05 to category D (MD) — 12.50% with reason and click Save', async () => {
      await correctInUi(list, list.row(id('P05')), s.master.categoryName.D, reasonOf('TC_US079_50', 'Mapped to the MD category by contract'));
    });

    await step('Assert: Expected 6 — Applied toast; P05 shows 적용됨 (요율 변동 없음); one line only: category D, 12.50%', async () => {
      await expect(list.toast(FR_KO['fix.savedApplied']), '[Expected 6] Toast 수정이 적용되었습니다. 요율이 변하지 않아 승인이 필요하지 않습니다.').toBeVisible();
      await expect(list.statusPills(list.row(id('P05'))).nth(1), '[Expected 6] P05 shows 적용됨 (요율 변동 없음)').toHaveText(FR_KO['state.APPLIED']);
      await one(6, 'P05', s.master.categoryName.D, '12.50%');
    });
  });

  test('TC_US079_51 — A hand-keyed rate carries the Hand-keyed badge with its basis in the tooltip', async ({ page, feeReviewPage: list, seedData, feeReviewApi, approverFeeReviewApi }) => {
    const step = makeStep(page);
    const b = new FeeReviewListBPage(page, list);
    const basis = reasonOf('TC_US079_51', 'Side letter rate agreed with the partner');
    await tcMeta('TC_US079_51', 'Medium', TAGS, `A tier-2 rate typed on P10 (no contract row for ST2) is saved, submitted and approved; the rate cell then reads 6.75% with badge 직접 입력 whose tooltip shows the basis, and the API reports rateHandKeyed = true with no basis contract. Build: the FE list badge has no tooltip — Step 5 is expected to FAIL. ${NAV} ${SHARED} Deviation: chip 기간 내 판매 상품 is clicked after the save in Step 2 so P10 stays listed when it leaves 확인 필요. ${SHARED_DATA}`);
    let s!: Seeded;
    let cy!: Seeded['cycles'][string];
    let api!: FeeReviewRow & Record<string, unknown>;
    const id = (code: string) => s.products[code];

    await step('Arrange: Pre-condition 1–11 — Contract ROOT (R_A), CY_MAIN, product P10 (ST2, no row), no correction', async () => {
      s = await seedData({ tc: 51, contracts: F_A, cycles: ['CY_MAIN'], products: [product('P10', MAIN)] });
      cy = s.cycles.CY_MAIN;
      expect((await feeReviewApi.row(cy.id, id('P10'))).status, 'Pre-condition 9 — P10 has no row for its key (status NO_ROW)').toBe('NO_ROW');
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN and click 검색 (Search)', async () => {
      await b.show(cy.id, s.prefix);
    });

    await step('Assert: Expected 1 — The list loads for CY_MAIN', async () => {
      await expect(list.cycleSelect.locator('option:checked'), `[Expected 1] 정산 주기 shows ${cy.label}`).toHaveText(cy.label);
      await expect(list.row(id('P10')), '[Expected 1] P10 is listed').toBeVisible();
    });

    await step('Act: Step 2 — Correct P10: type 6.75 in 2단계 — 요율 직접 입력, enter the basis and click 저장 (Save)', async () => {
      await list.openCorrect(list.row(id('P10')));
      await list.correct.tier2Input.fill('6.75');
      await list.correct.reasonInput.fill(basis);
      await list.correct.save();
      await expect(list.correct.root, 'The Correct dialog closes after 저장 (Save)').toHaveCount(0);
      await list.clickChip(list.chip('bucket.ALL'));
    });

    await step('Assert: Expected 2 — Typed-rate toast; P10 shows 수정됨 — 미상신', async () => {
      await expect(list.toast(FR_KO['fix.savedDraftTyped']), '[Expected 2] Toast 승인 요청으로 상신되었습니다. 직접 입력한 요율은 항상 승인이 필요합니다.').toBeVisible();
      await expect(list.statusPills(list.row(id('P10'))).nth(1), '[Expected 2] P10 shows 수정됨 — 미상신').toHaveText(FR_KO['state.DRAFT']);
    });

    await step('Act: Step 3 — Tick P10 and click 선택 일괄 상신 (Submit selected)', async () => {
      await submitInUi(list, list.row(id('P10')));
    });

    await step('Assert: Expected 3 — P10 shows 승인 대기', async () => {
      await expect(list.statusPills(list.row(id('P10'))).nth(1), '[Expected 3] P10 shows 승인 대기').toHaveText(FR_KO['state.PENDING']);
    });

    await step('Act: Step 4 — Approve the P10 correction (CA1) with TOKEN_B; as user A click Search', async () => {
      const approved = await approverFeeReviewApi.approve(await approvalIdOf(feeReviewApi, await correctionIdOn(feeReviewApi, cy.id, id('P10'))));
      expect(approved.status, 'TOKEN_B approves CA1').toBe(200);
      await b.searchAgain();
    });

    await step('Assert: Expected 4 — P10 shows 승인됨 — 적용; rate cell 6.75% carries badge 직접 입력', async () => {
      const row = list.row(id('P10'));
      await expect(list.statusPills(row).nth(1), '[Expected 4] P10 shows 승인됨 — 적용').toHaveText(FR_KO['state.APPROVED']);
      await expect(list.cell(row, 'rate'), '[Expected 4] The rate cell reads 6.75%').toContainText('6.75%');
      await expect(b.handKeyedBadge(row), '[Expected 4] The rate cell carries badge 직접 입력 (Hand-keyed)').toBeVisible();
    });

    await step('Act: Step 5 — Hover the badge in the rate cell of P10', async () => {
      await b.handKeyedBadge(list.row(id('P10'))).hover();
    });

    await step('Assert: Expected 5 — The tooltip shows the basis', async () => {
      await expect(list.tooltip, '[Expected 5] The tooltip shows the basis typed in Step 2').toContainText(basis);
    });

    await step('Act: Step 6 — Call GET /fee-review/cycles/CY_MAIN/products?keyword=<P10>', async () => {
      api = (await feeReviewApi.row(cy.id, id('P10'))) as FeeReviewRow & Record<string, unknown>;
    });

    await step('Assert: Expected 6 — inForceRate = "6.75", rateHandKeyed = true, basisContractId = null', async () => {
      expect(api.inForceRate, '[Expected 6] inForceRate = "6.75"').toBe('6.75');
      expect(api.rateHandKeyed, '[Expected 6] rateHandKeyed = true').toBe(true);
      expect(api.basisContractId, '[Expected 6] basisContractId = null').toBeNull();
    });
  });

  test('TC_US079_52 — The status column stacks the resolution pill and the correction pill with the rejection reason in its tooltip', async ({ page, feeReviewPage: list, seedData, feeReviewApi, approverFeeReviewApi, contractsApi, approverContractsApi }) => {
    const step = makeStep(page);
    const b = new FeeReviewListBPage(page, list);
    const rejectReason = reasonOf('TC_US079_52', 'Wrong annex — check ANNEX1 first');
    await tcMeta('TC_US079_52', 'Medium', TAGS, `The 산정 상태 cell shows the resolution pill alone without a correction and stacks a second pill for the correction state (DRAFT → PENDING → APPROVED → RETIRED, REJECTED, APPLIED); the rejection reason is not written in the cell but shows in the second pill's tooltip. Build: the rejection reason is not passed to the pill tooltip — Step 7 is expected to FAIL. ${NAV} Deviation: chip 기간 내 판매 상품 is clicked in Step 1 so every row stays listed as it changes bucket. ${PRIVATE}`);
    let s!: Seeded;
    let cy!: Seeded['cycles'][string];
    const id = (code: string) => s.products[code];
    const pills = (code: string) => list.statusPills(list.row(id(code)));

    await step('Arrange: Pre-condition 1–14 — Contracts ROOT / ANNEX1 + approved row R_D, CY_MAIN, products P01 P03 P05 P14, no correction', async () => {
      s = await seedData({ tc: 52, contracts: F_AB_B9, cycles: ['CY_MAIN'], private: true, products: (['P01', 'P03', 'P05', 'P14'] as ProductCode[]).map((c) => product(c, MAIN)) });
      cy = s.cycles.CY_MAIN;
      await addApprovedRow(contractsApi, approverContractsApi, s.family.contracts.ROOT, feeRowBody(s, 'D', 12.5, '2020-01-01', 'R_D'));
      expect((await feeReviewApi.products(cy.id, { keyword: s.prefix })).totalElements, 'Pre-condition 12 — 4 rows seeded').toBe(4);
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN and look at the status cell of P01 NORMAL', async () => {
      await b.show(cy.id);
      await list.clickChip(list.chip('bucket.ALL'));
    });

    await step('Assert: Expected 1 — One pill only: 산정 완료 (Resolved)', async () => {
      await expect(pills('P01'), '[Expected 1] P01 carries one pill only').toHaveCount(1);
      await expect(pills('P01').first(), '[Expected 1] The pill reads 산정 완료 (Resolved)').toHaveText(FR_KO['status.RESOLVED']);
    });

    await step('Act: Step 2 — Correct P14 to category B — 9.00% with reason and click 저장 (Save)', async () => {
      await correctInUi(list, list.row(id('P14')), s.master.categoryName.B, reasonOf('TC_US079_52', '카테고리 오매핑 정정'));
    });

    await step('Assert: Expected 2 — P14 shows Resolved on top and 수정됨 — 미상신 below', async () => {
      await expect(pills('P14').first(), '[Expected 2] Top pill reads 산정 완료 (Resolved)').toHaveText(FR_KO['status.RESOLVED']);
      await expect(pills('P14').nth(1), '[Expected 2] Second pill reads 수정됨 — 미상신').toHaveText(FR_KO['state.DRAFT']);
    });

    await step('Act: Step 3 — Submit P14 with 선택 일괄 상신 (Submit selected)', async () => {
      await submitInUi(list, list.row(id('P14')));
    });

    await step('Assert: Expected 3 — Second pill reads 승인 대기', async () => {
      await expect(pills('P14').nth(1), '[Expected 3] Second pill reads 승인 대기 (Awaiting approval)').toHaveText(FR_KO['state.PENDING']);
    });

    await step('Act: Step 4 — Approve the P14 correction (CA1) with TOKEN_B; as user A click Search', async () => {
      const approved = await approverFeeReviewApi.approve(await approvalIdOf(feeReviewApi, await correctionIdOn(feeReviewApi, cy.id, id('P14'))));
      expect(approved.status, 'TOKEN_B approves CA1').toBe(200);
      await b.searchAgain();
    });

    await step('Assert: Expected 4 — Second pill reads 승인됨 — 적용', async () => {
      await expect(pills('P14').nth(1), '[Expected 4] Second pill reads 승인됨 — 적용 (Approved — applied)').toHaveText(FR_KO['state.APPROVED']);
    });

    await step('Act: Step 5 — SQL: commerce now assigns category B with slot R_B9 to P14; click Search', async () => {
      await feeReviewDb.updateProduct(id('P14'), { categoryId: s.master.category.B, defaultSlotFeeRowId: s.family.rows.R_B9 });
      await b.searchAgain();
    });

    await step('Assert: Expected 5 — Second pill reads 자동 해제 — 더 이상 불필요', async () => {
      await expect(pills('P14').nth(1), '[Expected 5] Second pill reads 자동 해제 — 더 이상 불필요 (Retired — no longer needed)').toHaveText(FR_KO['state.RETIRED']);
    });

    await step('Act: Step 6 — Correct P03 to category A — 12.50%, submit it, reject its approval (CA2) with TOKEN_B, then click Search', async () => {
      await correctInUi(list, list.row(id('P03')), s.master.categoryName.A, reasonOf('TC_US079_52', '카테고리 오매핑 정정'));
      await submitInUi(list, list.row(id('P03')));
      const rejected = await approverFeeReviewApi.reject(await approvalIdOf(feeReviewApi, await correctionIdOn(feeReviewApi, cy.id, id('P03'))), rejectReason);
      expect(rejected.status, 'TOKEN_B rejects CA2').toBe(200);
      await b.searchAgain();
    });

    await step('Assert: Expected 6 — P03 shows Resolved on top and 반려됨 — 수정 후 재상신 below; the rejection reason is not written in the cell', async () => {
      await expect(pills('P03').first(), '[Expected 6] Top pill reads 산정 완료 (Resolved)').toHaveText(FR_KO['status.RESOLVED']);
      await expect(pills('P03').nth(1), '[Expected 6] Second pill reads 반려됨 — 수정 후 재상신').toHaveText(FR_KO['state.REJECTED']);
      await expect(list.cell(list.row(id('P03')), 'status'), '[Expected 6] The rejection reason is not written in the cell').not.toContainText(rejectReason);
    });

    await step('Act: Step 7 — Hover the second pill of P03', async () => {
      await pills('P03').nth(1).hover();
    });

    await step('Assert: Expected 7 — The tooltip shows the rejection reason', async () => {
      await expect(list.tooltip, '[Expected 7] The tooltip shows the rejection reason').toContainText(rejectReason);
    });

    await step('Act: Step 8 — Correct P05 to category D (MD) — 12.50% with reason and click Save', async () => {
      await correctInUi(list, list.row(id('P05')), s.master.categoryName.D, reasonOf('TC_US079_52', 'Mapped by contract'));
    });

    await step('Assert: Expected 8 — Second pill reads 적용됨 (요율 변동 없음)', async () => {
      await expect(pills('P05').nth(1), '[Expected 8] Second pill reads 적용됨 (요율 변동 없음) (Applied (no rate change))').toHaveText(FR_KO['state.APPLIED']);
    });
  });

  test('TC_US079_53 — Correct is disabled with its own reason for a closed cycle, a pending correction and a not-computable product', async ({ page, feeReviewPage: list, seedData, feeReviewApi }) => {
    const step = makeStep(page);
    const b = new FeeReviewListBPage(page, list);
    await tcMeta('TC_US079_53', 'Medium', TAGS, `수정 is enabled on a clean row of an open cycle and disabled — reduced opacity, not-allowed cursor — with its own tooltip on a pending correction (P14), a bracket product (P21) and a closed cycle (P03 on CY_CLOSE); correction-options reports the matching notCorrectableReason. The tooltip is the title attribute of the wrapper around the disabled button (DOM 01/10). ${NAV} ${PRIVATE} CY_CLOSE is closed for good (no reopen API).`);
    let s!: Seeded;
    let cy!: Seeded['cycles'][string];
    const look: Record<string, { disabled: boolean; dimmed: boolean; notAllowed: boolean }> = {};
    const options: Record<string, CorrectionOptions & { notCorrectableReason?: string }> = {};
    const id = (code: string) => s.products[code];
    const expectDisabled = async (n: number, code: string, tooltip: string) => {
      expect(look[code].disabled, `[Expected ${n}] ${code} 수정 (Correct) is disabled`).toBe(true);
      expect(look[code].dimmed, `[Expected ${n}] ${code} 수정 shows reduced opacity`).toBe(true);
      expect(look[code].notAllowed, `[Expected ${n}] ${code} 수정 shows the not-allowed cursor`).toBe(true);
      await expect(list.correctWrapper(list.row(id(code))), `[Expected ${n}] ${code} tooltip reads "${tooltip}"`).toHaveAttribute('title', tooltip);
    };

    await step('Arrange: Pre-condition 1–16 — Contracts ROOT / ANNEX1 / CT3, CY_MAIN (P01 P14 P21) and closed CY_CLOSE (P03); COR1 on P14 submitted and PENDING', async () => {
      s = await seedData({
        tc: 53,
        contracts: F_AB_B9_CT3,
        cycles: ['CY_MAIN', 'CY_CLOSE'],
        close: ['CY_CLOSE'],
        private: true,
        products: [product('P01', MAIN), product('P14', MAIN), product('P21', MAIN), product('P03', [{ cycle: 'CY_CLOSE', saleLines: 10 }])],
      });
      cy = s.cycles.CY_MAIN;
      const cor1 = await saveCorrection(feeReviewApi, cy.id, id('P14'), tier1(s, 'B', reasonOf('TC_US079_53', 'Wrong category mapped in commerce')));
      const submitted = await feeReviewApi.submit([cor1]);
      expect(submitted.status, 'Pre-condition 13 — COR1 is submitted').toBeLessThan(300);
      expect((await feeReviewApi.row(cy.id, id('P14'))).correction?.state, 'Pre-condition 14 — COR1 is PENDING').toBe('PENDING');
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN, click chip 기간 내 판매 상품 and hover 수정 (Correct) on P01 NORMAL', async () => {
      await b.show(cy.id);
      await list.clickChip(list.chip('bucket.ALL'));
      await list.rowButton(list.row(id('P01')), 'btn.correct').hover();
    });

    await step('Assert: Expected 1 — Correct is enabled (open cycle, no pending correction, Resolved)', async () => {
      await expect(list.rowButton(list.row(id('P01')), 'btn.correct'), '[Expected 1] P01 수정 (Correct) is enabled').toBeEnabled();
    });

    await step('Act: Step 2 — Hover Correct on P14', async () => {
      await list.correctWrapper(list.row(id('P14'))).hover();
      look.P14 = await b.looksDisabled(list.row(id('P14')));
    });

    await step('Assert: Expected 2 — Correct looks disabled; tooltip 승인 대기 중입니다 — 먼저 회수한 뒤에 수정하세요.', async () => {
      await expectDisabled(2, 'P14', FR_KO['msg.correctDisabledPending']);
    });

    await step('Act: Step 3 — Hover Correct on P21', async () => {
      await list.correctWrapper(list.row(id('P21'))).hover();
      look.P21 = await b.looksDisabled(list.row(id('P21')));
    });

    await step('Assert: Expected 3 — Correct looks disabled; tooltip 구간형 요율이라 이 화면에서는 산정할 수 없습니다 — …', async () => {
      await expectDisabled(3, 'P21', FR_KO['msg.correctDisabledBracket']);
    });

    await step('Act: Step 4 — Select CY_CLOSE, click Search and hover Correct on P03', async () => {
      await b.show(s.cycles.CY_CLOSE.id);
      await list.clickChip(list.chip('bucket.ALL'));
      await list.correctWrapper(list.row(id('P03'))).hover();
      look.P03 = await b.looksDisabled(list.row(id('P03')));
    });

    await step('Assert: Expected 4 — Correct looks disabled; tooltip 마감된 기간은 수정할 수 없습니다', async () => {
      await expectDisabled(4, 'P03', FR_KO['msg.correctDisabledClosed']);
    });

    await step('Act: Step 5 — Call correction-options for P14 and P21 on CY_MAIN and for P03 on CY_CLOSE', async () => {
      options.P14 = await feeReviewApi.options(cy.id, id('P14'));
      options.P21 = await feeReviewApi.options(cy.id, id('P21'));
      options.P03 = await feeReviewApi.options(s.cycles.CY_CLOSE.id, id('P03'));
    });

    await step('Assert: Expected 5 — notCorrectableReason PENDING_CORRECTION / NOT_COMPUTABLE / CYCLE_CLOSED; correctable = false for all three', async () => {
      const expected = { P14: 'PENDING_CORRECTION', P21: 'NOT_COMPUTABLE', P03: 'CYCLE_CLOSED' };
      for (const [code, reason] of Object.entries(expected)) {
        expect(options[code].notCorrectableReason, `[Expected 5] ${code} notCorrectableReason = ${reason}`).toBe(reason);
        expect(options[code].correctable, `[Expected 5] ${code} correctable = false`).toBe(false);
      }
    });
  });

  test('TC_US079_54 — The row actions appear in the order Basis, Correct, Withdraw, History', async ({ page, feeReviewPage: list, seedData, feeReviewApi }) => {
    const step = makeStep(page);
    const b = new FeeReviewListBPage(page, list);
    await tcMeta('TC_US079_54', 'Low', TAGS, `The 작업 cell reads 근거, 수정, 이력 on a row with no correction (no 회수) and 근거, 수정 (disabled), 회수, 이력 on a row with a pending correction submitted by user A. ${NAV} ${SHARED} Deviation: chip 기간 내 판매 상품 is clicked in Step 1 (as the TC says) after the keyword search. ${SHARED_DATA}`);
    let s!: Seeded;
    let cy!: Seeded['cycles'][string];
    const id = (code: string) => s.products[code];

    await step('Arrange: Pre-condition 1–14 — Contracts ROOT / ANNEX1, CY_MAIN, P01 (no correction) and P14 with COR1 submitted (PENDING) by user A', async () => {
      s = await seedData({ tc: 54, contracts: F_A_B9, cycles: ['CY_MAIN'], products: [product('P01', MAIN), product('P14', MAIN)] });
      cy = s.cycles.CY_MAIN;
      const cor1 = await saveCorrection(feeReviewApi, cy.id, id('P14'), tier1(s, 'B', reasonOf('TC_US079_54', 'Wrong category mapped in commerce')));
      expect((await feeReviewApi.submit([cor1])).status, 'Pre-condition 11 — COR1 is submitted').toBeLessThan(300);
      expect((await feeReviewApi.row(cy.id, id('P14'))).correction?.state, 'Pre-condition 12 — COR1 is PENDING').toBe('PENDING');
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN, click 검색 (Search), then chip 기간 내 판매 상품', async () => {
      await b.show(cy.id, s.prefix);
      await list.clickChip(list.chip('bucket.ALL'));
    });

    await step('Assert: Expected 1 — The list loads with column 작업 (Actions)', async () => {
      await expect(list.headers.filter({ hasText: FR_KO['col.actions'] }), '[Expected 1] Column 작업 (Actions) is shown').toBeVisible();
      await expect(list.row(id('P01')), '[Expected 1] The list loads with the TC rows').toBeVisible();
    });

    await step('Act: Step 2 — Read the 작업 (Actions) cell of P01 NORMAL from left to right', async () => {
      await list.cell(list.row(id('P01')), 'actions').scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — 근거, 수정, 이력 — no 회수', async () => {
      await expect(b.actionButtons(list.row(id('P01'))), '[Expected 2] P01 actions read 근거, 수정, 이력 in that order').toHaveText([FR_KO['btn.basis'], FR_KO['btn.correct'], FR_KO['btn.history']]);
      await expect(list.rowButton(list.row(id('P01')), 'btn.withdraw'), '[Expected 2] P01 has no 회수 (Withdraw)').toHaveCount(0);
    });

    await step('Act: Step 3 — Read the Actions cell of P14 from left to right', async () => {
      await list.cell(list.row(id('P14')), 'actions').scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — 근거, 수정 (disabled), 회수, 이력', async () => {
      await expect(b.actionButtons(list.row(id('P14'))), '[Expected 3] P14 actions read 근거, 수정, 회수, 이력 in that order').toHaveText([FR_KO['btn.basis'], FR_KO['btn.correct'], FR_KO['btn.withdraw'], FR_KO['btn.history']]);
      await expect(list.rowButton(list.row(id('P14')), 'btn.correct'), '[Expected 3] P14 수정 (Correct) is disabled').toBeDisabled();
    });
  });

  test('TC_US079_55 — Rates show two decimals with a per-cent sign', async ({ page, feeReviewPage: list, seedData, feeReviewApi }) => {
    const step = makeStep(page);
    const b = new FeeReviewListBPage(page, list);
    await tcMeta('TC_US079_55', 'Low', TAGS, `The 산정 요율 cell reads 12.50% / 9.00% / 9.50% (two decimals + %), an empty rate for the no-row product P06, no rate is clipped, and the figures equal inForceRate of the API. ${NAV} ${SHARED} Deviation: Step 3 calls the products API with the TC prefix as keyword (the shared cycle holds other TCs' rows). Deviation: "empty" is checked as a cell with no digit (the UI shows the placeholder —). ${SHARED_DATA}`);
    let s!: Seeded;
    let cy!: Seeded['cycles'][string];
    const ui: Record<string, string[]> = {};
    let api: FeeReviewRow[] = [];
    const id = (code: string) => s.products[code];
    const rateRows: Array<{ code: string; index: number; rate: string | null }> = [
      { code: 'P01', index: 0, rate: '12.50%' },
      { code: 'P01', index: 1, rate: '12.50%' },
      { code: 'P14', index: 0, rate: '12.50%' },
      { code: 'P03', index: 0, rate: '9.00%' },
      { code: 'P09', index: 0, rate: '9.50%' },
      { code: 'P06', index: 0, rate: null },
    ];

    await step('Arrange: Pre-condition 1–12 — Contracts ROOT (R_A, R_B10, R_PROMO) / ANNEX1, CY_MAIN, products P01 (NORMAL + PROMOTION) P03 P06 P09 P14, no correction', async () => {
      s = await seedData({
        tc: 55,
        contracts: family({ ROOT: ['R_A', 'R_B10', 'R_PROMO'], ANNEX1: ['R_B9'] }),
        cycles: ['CY_MAIN'],
        products: [product('P01', MAIN_BOTH), product('P03', MAIN), product('P06', MAIN), product('P09', [{ cycle: 'CY_MAIN', saleLines: 1 }]), product('P14', MAIN)],
      });
      cy = s.cycles.CY_MAIN;
      expect((await feeReviewApi.products(cy.id, { keyword: s.prefix })).totalElements, 'Pre-condition 10 — 6 rows seeded').toBe(6);
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN, click 검색 (Search), then chip 기간 내 판매 상품', async () => {
      await b.show(cy.id, s.prefix);
      await list.clickChip(list.chip('bucket.ALL'));
    });

    await step('Assert: Expected 1 — The list loads with 6 rows', async () => {
      await expect(list.rows, '[Expected 1] The list holds 6 rows').toHaveCount(6);
    });

    await step('Act: Step 2 — Read the 산정 요율 (Resolved rate) cell of each row', async () => {
      for (const code of ['P01', 'P03', 'P06', 'P09', 'P14']) {
        ui[code] = await b.rateTexts(id(code));
      }
    });

    await step('Assert: Expected 2 — P01 (both rows) and P14 12.50%, P03 9.00%, P09 9.50%, P06 empty; no rate is clipped', async () => {
      for (const r of rateRows) {
        const cell = list.cell(list.row(id(r.code), r.index), 'rate');
        if (r.rate) await expect(cell, `[Expected 2] ${r.code} row ${r.index + 1} reads ${r.rate}`).toHaveText(r.rate);
        else await expect(cell, `[Expected 2] ${r.code} shows no rate`).not.toHaveText(/\d/);
        expect(await isClipped(cell), `[Expected 2] ${r.code} row ${r.index + 1} rate is not clipped`).toBe(false);
      }
    });

    await step('Act: Step 3 — Call GET /fee-review/cycles/CY_MAIN/products?size=100 (TC prefix as keyword)', async () => {
      api = (await feeReviewApi.products(cy.id, { keyword: s.prefix, size: 100 })).content;
    });

    await step('Assert: Expected 3 — inForceRate values are "12.50", "9.00", "9.50" or null — the same figures the screen shows', async () => {
      for (const r of api) {
        expect([null, undefined, '12.50', '9.00', '9.50'], `[Expected 3] ${r.productId} / ${r.policy} inForceRate is 12.50, 9.00, 9.50 or null`).toContain(r.inForceRate);
      }
      for (const code of ['P01', 'P03', 'P06', 'P09', 'P14']) {
        const fromApi = api.filter((r) => r.productId === id(code)).map((r) => (r.inForceRate ? `${r.inForceRate}%` : '')).sort();
        const onScreen = (ui[code] ?? []).map((t) => (/\d/.test(t) ? t : '')).sort();
        expect(onScreen, `[Expected 3] ${code} shows the same figures as inForceRate`).toEqual(fromApi);
      }
    });
  });

  test('TC_US079_56 — The list returns within 3 seconds for a cycle of 3,000 products', async ({ page, feeReviewPage: list, seedData, feeReviewApi }) => {
    test.setTimeout(600_000);
    const step = makeStep(page);
    const b = new FeeReviewListBPage(page, list);
    await tcMeta('TC_US079_56', 'Medium', TAGS, `On a cycle with 3,000 products (2,998 clean bulk products + P03 mismatch + P05 not assigned) the list opens with 기간 내 판매 상품 3,000 / 확인 필요 2 and every GET products request — from the browser and from the API — returns in under 3 seconds. ${NAV} Deviation: the DevTools Network duration is read from Playwright's request timing (responseEnd), and the curl calls are replaced by timed Playwright API requests with TOKEN_A. Deviation: the 3,000 count is accepted with or without a thousands separator. ${PRIVATE}`);
    let s!: Seeded;
    let cy!: Seeded['cycles'][string];
    const durations: { ui: number[]; api: number[] } = { ui: [], api: [] };
    const isProducts = (r: Response) => r.request().method() === 'GET' && /\/api\/v1\/fee-review\/cycles\/\d+\/products\?/.test(r.url());
    const timing = async (r: Response) => {
      await r.finished();
      return r.request().timing().responseEnd;
    };
    let first!: Response;
    const bulk: ProductDef[] = Array.from({ length: 2998 }, (_, i) => {
      const code = `N${String(i + 1).padStart(4, '0')}`;
      return { code, name: `[T079] ${code}`, contract: 'ROOT', category: 'A', saleType: 'ST1', defaultSlot: 'R_A', promotionSlot: null, targets: [{ cycle: 'CY_MAIN', policy: 'NORMAL', saleLines: 1 }] };
    });

    await step('Arrange: Pre-condition 1–16 — Contracts ROOT / ANNEX1, CY_MAIN with P03, P05 and 2,998 bulk products (3,000 targets), no correction', async () => {
      s = await seedData({ tc: 56, contracts: F_AB_B9, cycles: ['CY_MAIN'], private: true, products: [product('P03', MAIN), product('P05', MAIN), ...bulk] });
      cy = s.cycles.CY_MAIN;
      const [record] = await feeReviewDb.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM fee_review_fixture_target WHERE settlement_cycle_id = ?', [cy.id]);
      expect(Number(record.n), 'Pre-condition 13 — 3,000 targets on CY_MAIN').toBe(3000);
      expect((await feeReviewApi.products(cy.id, { bucket: 'NEEDS_REVIEW' })).totalElements, 'Pre-condition 13 — NEEDS_REVIEW holds P03 and P05').toBe(2);
    });

    await step('Act: Step 1 — Open the screen on CY_MAIN and click 검색 (Search), keeping the default chip 확인 필요', async () => {
      const listed = page.waitForResponse(isProducts, { timeout: 60_000 });
      await b.show(cy.id);
      first = await listed;
    });

    await step('Assert: Expected 1 — The list loads; 기간 내 판매 상품 reads 3,000 and Needs review reads 2', async () => {
      await expect(b.chipNumber('bucket.ALL'), '[Expected 1] 기간 내 판매 상품 reads 3,000').toHaveText(/^3,?000$/);
      await expect(b.chipNumber('bucket.EXC'), '[Expected 1] 확인 필요 reads 2').toHaveText('2');
    });

    await step('Act: Step 2 — Read the duration of the GET products request', async () => {
      durations.ui.push(await timing(first));
    });

    await step('Assert: Expected 2 — Duration is under 3 seconds', async () => {
      expect(durations.ui[0], '[Expected 2] The request timing is available').toBeGreaterThanOrEqual(0);
      expect(durations.ui[0], '[Expected 2] GET products returns in under 3 s').toBeLessThan(3000);
    });

    await step('Act: Step 3 — Click Search two more times and read each duration', async () => {
      for (let i = 0; i < 2; i++) durations.ui.push(await timing(await b.list.untilListed(() => b.list.click(b.list.searchButton, '검색 (Search) button'))));
    });

    await step('Assert: Expected 3 — Each duration is under 3 seconds', async () => {
      for (const [i, ms] of durations.ui.slice(1).entries()) {
        expect(ms, `[Expected 3] Search ${i + 1} timing is available`).toBeGreaterThanOrEqual(0);
        expect(ms, `[Expected 3] Search ${i + 1} returns in under 3 s`).toBeLessThan(3000);
      }
    });

    await step('Act: Step 4 — Call GET products?bucket=NEEDS_REVIEW with TOKEN_A three times and time each call', async () => {
      for (let i = 0; i < 3; i++) {
        const started = Date.now();
        await feeReviewApi.products(cy.id, { bucket: 'NEEDS_REVIEW' });
        durations.api.push(Date.now() - started);
      }
      await test.info().attach('durations_ms', { body: JSON.stringify(durations, null, 2), contentType: 'application/json' });
    });

    await step('Assert: Expected 4 — Each time_total is under 3.0 s', async () => {
      for (const [i, ms] of durations.api.entries()) expect(ms, `[Expected 4] API call ${i + 1} returns in under 3.0 s`).toBeLessThan(3000);
    });
  });
});
