import { test, expect } from '@fixtures/fee-review-v1.fixture';
import { tcMeta } from '@utils/tc-meta';
import { getAccountDisplayName } from '@utils/auth-token';
import { family, product } from '@utils/fee-review-v1.data';
import {
  DbRow,
  apiStep,
  approvalIdOf,
  approvalRow,
  correctionRow,
  decide,
  expectRefused,
  identity,
  saveCorrection,
  select,
  submitCorrections,
} from '@utils/fee-review-submit-history';
import type { FeeReviewApi, SavedCorrection } from '@api/fee-review.api';
import type { ApiResult } from '@api/payment-method-policy.api';

/**
 * US079 v1 — nhóm [API] (`input/TESTCASE_US079_v1.md`): gọi thẳng API màn 정산 수수료 확인·수정 (TOKEN_A = maker) và
 * 변경 승인 (TOKEN_B = approver), đối chiếu DB bằng SELECT. Mỗi step đính kèm request/response làm bằng chứng.
 * Dữ liệu: seedData() dựng contract / cycle / sản phẩm T079 theo pre-condition và dọn sản phẩm + correction ở teardown.
 */
const TAGS = ['fee-review', 'api'];
const SEED =
  'Data: the T079 contract family and CY_MAIN are shared within the run (no delete API); products are private to the test and every correction / approval / history row of them is removed by SQL in teardown. Deviation: the cycle is the next free month from 2100 instead of Y = 2100 + 200 × RUN + N.';
const UNKNOWN_ID = '999999999999';

/** HTTP status của lượt gọi gần nhất (các hàm GET trả body, không trả status). */
const lastStatus = (api: FeeReviewApi): number => api.exchanges.at(-1)?.status ?? 0;

test.describe('[API] Fee review corrections — server-side guards', () => {
  test.describe.configure({ timeout: 180_000 });

  test('TC_US079_96 — The server refuses an invalid reason or rate with STL-1018 when the screen check is bypassed', async ({ feeReviewApi, contractsApi, seedData }) => {
    const step = apiStep(feeReviewApi, contractsApi);
    await tcMeta(
      'TC_US079_96',
      'Medium',
      TAGS,
      `Saves sent straight to the API with an empty, blank-only or 201-character reason, or a typed rate of 0.00, -1.00, 4.505 or abc, are refused with HTTP 400 STL-1018 and the TC message, nothing is stored, and a 200-character reason wrapped in spaces is accepted and stored trimmed. Build note (remark): dev answers CMN-4000 for blank / over-length / regex cases, counts the reason length before trimming and keeps the pre-v1.8 STL-1018 text — those Expected items are asserted per TC and expected to fail. KO wording is BA-proposed. ${SEED}`,
    );
    const d = { cy: 0, P14: '', P10: '', catB: 0 };
    const res: Record<string, ApiResult<SavedCorrection>> = {};
    let rows: DbRow[] = [];
    let discardStatus = 0;
    const tier1 = (reason: string) => feeReviewApi.save(d.cy, d.P14, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: d.catB, reason });
    const tier2 = (overrideRate: string) => feeReviewApi.save(d.cy, d.P10, { policy: 'NORMAL', tier: 'RATE_OVERRIDE', overrideRate, reason: 'Basis check' });

    await step('Arrange: Pre-condition 1–11 — ROOT (R_A, R_B10), CY_MAIN, P14 resolved and P10 with no row, neither carries a correction', async () => {
      const s = await seedData({
        tc: 96,
        contracts: family({ ROOT: ['R_A', 'R_B10'] }),
        cycles: ['CY_MAIN'],
        products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }]), product('P10', [{ cycle: 'CY_MAIN', saleLines: 86 }])],
      });
      Object.assign(d, { cy: s.cycles.CY_MAIN.id, P14: s.products.P14, P10: s.products.P10, catB: s.master.category.B });
      expect((await feeReviewApi.row(d.cy, d.P14)).correction ?? null, 'Pre-condition 9: P14 carries no correction').toBeNull();
      expect((await feeReviewApi.row(d.cy, d.P10)).correction ?? null, 'Pre-condition 9: P10 carries no correction').toBeNull();
    });

    await step('Act: Step 1 — POST a tier-1 correction on P14 with an empty reason', async () => {
      res.s1 = await tier1('');
    });
    await step('Assert: Expected 1 — HTTP 400, STL-1018 and the TC message', async () => {
      expectRefused(res.s1, '[Expected 1]', 400, 1018);
    });

    await step('Act: Step 2 — Same call with a reason of 5 spaces', async () => {
      res.s2 = await tier1('     ');
    });
    await step('Assert: Expected 2 — HTTP 400, STL-1018 (blank after trimming), same message', async () => {
      expectRefused(res.s2, '[Expected 2]', 400, 1018);
    });

    await step('Act: Step 3 — Same call with a 201-character reason', async () => {
      res.s3 = await tier1('A'.repeat(201));
    });
    await step('Assert: Expected 3 — HTTP 400, STL-1018, same message', async () => {
      expectRefused(res.s3, '[Expected 3]', 400, 1018);
    });

    await step('Act: Step 4 — POST a typed rate 0.00 on P10', async () => {
      res.s4 = await tier2('0.00');
    });
    await step('Assert: Expected 4 — HTTP 400, STL-1018, same message', async () => {
      expectRefused(res.s4, '[Expected 4]', 400, 1018);
    });

    await step('Act: Step 5 — Same call with -1.00, then 4.505, then abc', async () => {
      res.s5a = await tier2('-1.00');
      res.s5b = await tier2('4.505');
      res.s5c = await tier2('abc');
    });
    await step('Assert: Expected 5 — Each call returns HTTP 400, STL-1018, same message', async () => {
      expectRefused(res.s5a, '[Expected 5] -1.00:', 400, 1018);
      expectRefused(res.s5b, '[Expected 5] 4.505:', 400, 1018);
      expectRefused(res.s5c, '[Expected 5] abc:', 400, 1018);
    });

    await step('Act: Step 6 — Count the live corrections of P14 and P10', async () => {
      rows = await select('live corrections', 'SELECT COUNT(*) AS n FROM fee_correction WHERE product_id IN (?, ?) AND discarded_at IS NULL', [d.P14, d.P10]);
    });
    await step('Assert: Expected 6 — Count = 0, nothing was saved by a refused call', async () => {
      expect(Number(rows[0]?.n), '[Expected 6] No correction stored').toBe(0);
    });

    await step('Act: Step 7 — POST on P14 with 3 spaces + 200 characters + 3 spaces as the reason', async () => {
      res.s7 = await tier1(`   ${'A'.repeat(200)}   `);
    });
    await step('Assert: Expected 7 — HTTP 201, state DRAFT (200 characters after trimming is valid)', async () => {
      expect.soft(res.s7.status, '[Expected 7] HTTP 201').toBe(201);
      expect.soft(res.s7.body?.state, '[Expected 7] state DRAFT').toBe('DRAFT');
    });

    await step('Act: Step 8 — Read the stored reason length, then DELETE the correction', async () => {
      rows = await select('stored reason length', 'SELECT CHAR_LENGTH(reason) AS len FROM fee_correction WHERE product_id = ? AND discarded_at IS NULL', [d.P14]);
      if (res.s7.body?.correctionId) discardStatus = (await feeReviewApi.discard(String(res.s7.body.correctionId))).status;
    });
    await step('Assert: Expected 8 — CHAR_LENGTH(reason) = 200 (trimmed text stored); DELETE returns 204', async () => {
      expect.soft(Number(rows[0]?.len), '[Expected 8] The stored reason is the trimmed 200 characters').toBe(200);
      expect.soft(discardStatus, '[Expected 8] DELETE returns 204').toBe(204);
    });
  });

  test('TC_US079_98 — A hand-keyed rate is refused while a contract row still applies', async ({ feeReviewApi, contractsApi, seedData }) => {
    const step = apiStep(feeReviewApi, contractsApi);
    await tcMeta(
      'TC_US079_98',
      'Medium',
      TAGS,
      `For P01 (resolved by R_A) and P06 (category D unpriced, but the family still prices ST1) the correction options report tier2Open = false, a typed rate is refused with HTTP 409 STL-1012 and the TC message, and no correction is created. ${SEED}`,
    );
    const d = { cy: 0, P01: '', P06: '' };
    const opt: Array<{ status: number; tier2Open: boolean }> = [];
    const res: Record<string, ApiResult<SavedCorrection>> = {};
    let count = -1;
    const typed = (productId: string) => feeReviewApi.save(d.cy, productId, { policy: 'NORMAL', tier: 'RATE_OVERRIDE', overrideRate: '5.00', reason: 'Typed rate while contract applies' });

    await step('Arrange: Pre-condition 1–10 — ROOT (R_A), CY_MAIN, P01 resolved and P06 with no row, no correction', async () => {
      const s = await seedData({
        tc: 98,
        contracts: family({ ROOT: ['R_A'] }),
        cycles: ['CY_MAIN'],
        products: [product('P01', [{ cycle: 'CY_MAIN', saleLines: 120 }]), product('P06', [{ cycle: 'CY_MAIN', saleLines: 188 }])],
      });
      Object.assign(d, { cy: s.cycles.CY_MAIN.id, P01: s.products.P01, P06: s.products.P06 });
    });

    await step('Act: Step 1 — GET correction-options for P01 and P06', async () => {
      for (const id of [d.P01, d.P06]) {
        const body = await feeReviewApi.options(d.cy, id);
        opt.push({ status: lastStatus(feeReviewApi), tier2Open: body.tier2Open });
      }
    });
    await step('Assert: Expected 1 — Both return 200 with tier2Open = false', async () => {
      for (const [i, name] of ['P01', 'P06'].entries()) {
        expect.soft(opt[i].status, `[Expected 1] ${name}: HTTP 200`).toBe(200);
        expect.soft(opt[i].tier2Open, `[Expected 1] ${name}: tier2Open = false`).toBe(false);
      }
    });

    await step('Act: Step 2 — POST a typed rate 5.00 on P01', async () => {
      res.s2 = await typed(d.P01);
    });
    await step('Assert: Expected 2 — HTTP 409, STL-1012 and the TC message', async () => {
      expectRefused(res.s2, '[Expected 2]', 409, 1012);
    });

    await step('Act: Step 3 — Same call for P06', async () => {
      res.s3 = await typed(d.P06);
    });
    await step('Assert: Expected 3 — HTTP 409, STL-1012, same message', async () => {
      expectRefused(res.s3, '[Expected 3]', 409, 1012);
    });

    await step('Act: Step 4 — Count the corrections of P01 and P06', async () => {
      count = Number((await select('corrections of P01 / P06', 'SELECT COUNT(*) AS n FROM fee_correction WHERE product_id IN (?, ?)', [d.P01, d.P06]))[0]?.n);
    });
    await step('Assert: Expected 4 — Count = 0, no correction was created', async () => {
      expect(count, '[Expected 4] No correction created').toBe(0);
    });
  });

  test('TC_US079_103 — A second open correction from an out-of-date screen is refused', async ({ feeReviewApi, contractsApi, seedData }) => {
    const step = apiStep(feeReviewApi, contractsApi);
    await tcMeta(
      'TC_US079_103',
      'Medium',
      TAGS,
      `With draft X (P14 → category B) already saved, a second save without correctionId (a stale second tab, category E) is refused with HTTP 409 STL-1019 and the TC message; X stays the only live correction with category B and the same version, and no cycle / product / policy holds two open corrections anywhere. Build note: the STL-1019 text is the pre-v1.8 wording (expected to fail on the message). Deviation: the invariant query of Step 3 runs over the whole shared table as the TC writes it. ${SEED}`,
    );
    const d = { cy: 0, P14: '', catB: 0, catE: 0, X: '', version: undefined as unknown };
    let res: ApiResult<SavedCorrection> | undefined;
    let live: DbRow[] = [];
    let dup: DbRow[] = [];

    await step('Arrange: Pre-condition 1–12 — ROOT (R_A, R_B10, R_E11), CY_MAIN, P14 with draft X (category B)', async () => {
      const s = await seedData({ tc: 103, contracts: family({ ROOT: ['R_A', 'R_B10', 'R_E11'] }), cycles: ['CY_MAIN'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      Object.assign(d, { cy: s.cycles.CY_MAIN.id, P14: s.products.P14, catB: s.master.category.B, catE: s.master.category.E });
      d.X = await saveCorrection(feeReviewApi, d.cy, d.P14, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: d.catB, reason: 'Wrong category mapped in commerce' });
      d.version = (await correctionRow(d.X))?.version;
      expect((await feeReviewApi.row(d.cy, d.P14)).correction?.state, 'Pre-condition 10: P14 carries a DRAFT').toBe('DRAFT');
    });

    await step('Act: Step 1 — POST a second correction (category E) on P14 without correctionId', async () => {
      res = await feeReviewApi.save(d.cy, d.P14, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: d.catE, reason: 'Second tab save' });
    });
    await step('Assert: Expected 1 — HTTP 409, STL-1019 and the TC message', async () => {
      expectRefused(res!, '[Expected 1]', 409, 1019);
    });

    await step('Act: Step 2 — Read the live corrections of P14', async () => {
      live = await select('live corrections of P14', 'SELECT id, category_id, version FROM fee_correction WHERE product_id = ? AND discarded_at IS NULL', [d.P14]);
    });
    await step('Assert: Expected 2 — Only X is returned, category still B, version unchanged', async () => {
      expect.soft(live.map((r) => String(r.id)), '[Expected 2] Only X is live').toEqual([d.X]);
      expect.soft(Number(live[0]?.category_id), '[Expected 2] category_id still CAT_B').toBe(d.catB);
      expect.soft(live[0]?.version, '[Expected 2] version unchanged').toEqual(d.version);
    });

    await step('Act: Step 3 — Run the open-correction invariant over fee_correction', async () => {
      dup = await select(
        'two open corrections per key',
        "SELECT settlement_cycle_id, product_id, policy, COUNT(*) AS n FROM fee_correction WHERE state IN ('DRAFT','REJECTED') AND discarded_at IS NULL GROUP BY 1,2,3 HAVING COUNT(*) > 1",
      );
    });
    await step('Assert: Expected 3 — 0 rows', async () => {
      expect(dup, '[Expected 3] No key holds two open corrections').toEqual([]);
    });
  });

  test("TC_US079_105 — A save for a product outside the cycle's target set is refused", async ({ feeReviewApi, contractsApi, seedData }) => {
    const step = apiStep(feeReviewApi, contractsApi);
    await tcMeta(
      'TC_US079_105',
      'Medium',
      TAGS,
      `X99 (no target row in CY_MAIN) and P03 under PROMOTION (only NORMAL is targeted) are refused with HTTP 409 STL-1019 and nothing is stored; a cycle with no target set at all (CY_EMPTY) accepts a save as built (DEV-25), lists no product with emptyStateCode STL-1014, and the draft is discarded with 204. ${SEED} CY_EMPTY is a fresh cycle of its own.`,
    );
    const d = { cy: 0, empty: 0, X99: '', P03: '', P06: '', catA: 0 };
    const res: Record<string, ApiResult<SavedCorrection>> = {};
    let count = -1;
    let emptyRows: DbRow[] = [];
    let listed = { status: 0, content: [] as unknown[], emptyStateCode: undefined as string | undefined };
    let discardStatus = 0;

    await step('Arrange: Pre-condition 1–11 — ROOT (R_A, R_B10), CY_MAIN with only P03 / NORMAL targeted, CY_EMPTY with no target', async () => {
      const s = await seedData({
        tc: 105,
        contracts: family({ ROOT: ['R_A', 'R_B10'] }),
        cycles: ['CY_MAIN', 'CY_EMPTY'],
        products: [product('X99', []), product('P03', [{ cycle: 'CY_MAIN', saleLines: 97 }]), product('P06', [])],
      });
      Object.assign(d, { cy: s.cycles.CY_MAIN.id, empty: s.cycles.CY_EMPTY.id, X99: s.products.X99, P03: s.products.P03, P06: s.products.P06, catA: s.master.category.A });
      const targets = await select('targets of CY_EMPTY', 'SELECT COUNT(*) AS n FROM fee_review_fixture_target WHERE settlement_cycle_id = ?', [d.empty]);
      expect(Number(targets[0]?.n), 'Pre-condition 9: CY_EMPTY has no target row').toBe(0);
    });

    await step('Act: Step 1 — POST a typed rate on X99 in CY_MAIN', async () => {
      res.s1 = await feeReviewApi.save(d.cy, d.X99, { policy: 'NORMAL', tier: 'RATE_OVERRIDE', overrideRate: '5.00', reason: 'Outside target set' });
    });
    await step('Assert: Expected 1 — HTTP 409, STL-1019 and the TC message', async () => {
      expectRefused(res.s1, '[Expected 1]', 409, 1019);
    });

    await step('Act: Step 2 — POST a PROMOTION tier-1 correction on P03 in CY_MAIN', async () => {
      res.s2 = await feeReviewApi.save(d.cy, d.P03, { policy: 'PROMOTION', tier: 'ASSIGNMENT', commissionCategoryId: d.catA, reason: 'Outside target set' });
    });
    await step('Assert: Expected 2 — HTTP 409, STL-1019, same message (P03 is in the set only under NORMAL)', async () => {
      expectRefused(res.s2, '[Expected 2]', 409, 1019);
    });

    await step('Act: Step 3 — Count corrections of X99 and of P03 / PROMOTION', async () => {
      count = Number(
        (await select('refused keys', "SELECT COUNT(*) AS n FROM fee_correction WHERE (product_id = ?) OR (product_id = ? AND policy = 'PROMOTION')", [d.X99, d.P03]))[0]?.n,
      );
    });
    await step('Assert: Expected 3 — Count = 0', async () => {
      expect(count, '[Expected 3] Nothing stored').toBe(0);
    });

    await step('Act: Step 4 — POST a tier-1 correction on P06 in CY_EMPTY', async () => {
      res.s4 = await feeReviewApi.save(d.empty, d.P06, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: d.catA, reason: 'No target set cycle' });
      emptyRows = await select('corrections of P06', 'SELECT id, settlement_cycle_id, state FROM fee_correction WHERE product_id = ?', [d.P06]);
    });
    await step('Assert: Expected 4 — HTTP 201, state DRAFT; fee_correction has a row in CY_EMPTY', async () => {
      expect.soft(res.s4.status, '[Expected 4] HTTP 201').toBe(201);
      expect.soft(res.s4.body?.state, '[Expected 4] state DRAFT').toBe('DRAFT');
      expect.soft(emptyRows.filter((r) => Number(r.settlement_cycle_id) === d.empty), '[Expected 4] A fee_correction row with settlement_cycle_id = CY_EMPTY').toHaveLength(1);
    });

    await step('Act: Step 5 — GET the product list of CY_EMPTY', async () => {
      const body = await feeReviewApi.products(d.empty);
      listed = { status: lastStatus(feeReviewApi), content: body?.content ?? [], emptyStateCode: body?.emptyStateCode };
    });
    await step('Assert: Expected 5 — 200, content = [], emptyStateCode = STL-1014', async () => {
      expect.soft(listed.status, '[Expected 5] HTTP 200').toBe(200);
      expect.soft(listed.content, '[Expected 5] content = []').toEqual([]);
      expect.soft(listed.emptyStateCode, '[Expected 5] emptyStateCode STL-1014').toBe('STL-1014');
    });

    await step('Act: Step 6 — DELETE the correction saved in Step 4', async () => {
      if (res.s4.body?.correctionId) discardStatus = (await feeReviewApi.discard(String(res.s4.body.correctionId))).status;
    });
    await step('Assert: Expected 6 — HTTP 204 (test data cleaned)', async () => {
      expect(discardStatus, '[Expected 6] DELETE returns 204').toBe(204);
    });
  });

  test('TC_US079_106 — Re-saving a correction under a different product, policy or tier is refused', async ({ feeReviewApi, contractsApi, seedData }) => {
    const step = apiStep(feeReviewApi, contractsApi);
    await tcMeta(
      'TC_US079_106',
      'Medium',
      TAGS,
      `Re-saving draft X (P14 / NORMAL / ASSIGNMENT) under product P03 or tier RATE_OVERRIDE, and draft W (P01 / NORMAL) under policy PROMOTION, is refused with HTTP 409 STL-1019 and the TC message; X and W are unchanged and nothing is created under P03 or P01 / PROMOTION. ${SEED}`,
    );
    const d = { cy: 0, P14: '', P01: '', P03: '', catA: 0, catB: 0, catE: 0, X: '', W: '' };
    const before: Record<string, DbRow | undefined> = {};
    const res: Record<string, ApiResult<SavedCorrection>> = {};
    let after: DbRow[] = [];
    let count = -1;

    await step('Arrange: Pre-condition 1–13 — ROOT (R_A, R_B10, R_PROMO), CY_MAIN, draft X on P14 and draft W on P01 / NORMAL', async () => {
      const s = await seedData({
        tc: 106,
        contracts: family({ ROOT: ['R_A', 'R_B10', 'R_PROMO'] }),
        cycles: ['CY_MAIN'],
        products: [
          product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }]),
          product('P01', [{ cycle: 'CY_MAIN', saleLines: 120 }, { cycle: 'CY_MAIN', policy: 'PROMOTION', saleLines: 2 }]),
          product('P03', [{ cycle: 'CY_MAIN', saleLines: 97 }]),
        ],
      });
      Object.assign(d, { cy: s.cycles.CY_MAIN.id, P14: s.products.P14, P01: s.products.P01, P03: s.products.P03, catA: s.master.category.A, catB: s.master.category.B, catE: s.master.category.E });
      d.X = await saveCorrection(feeReviewApi, d.cy, d.P14, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: d.catB, reason: 'Wrong category mapped in commerce' });
      d.W = await saveCorrection(feeReviewApi, d.cy, d.P01, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: d.catB, reason: 'Policy key check' });
      before.X = await correctionRow(d.X);
      before.W = await correctionRow(d.W);
    });

    await step('Act: Step 1 — Re-save X under product P03', async () => {
      res.s1 = await feeReviewApi.save(d.cy, d.P03, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: d.catA, reason: 'Key check', correctionId: d.X });
    });
    await step('Assert: Expected 1 — HTTP 409, STL-1019 and the TC message', async () => {
      expectRefused(res.s1, '[Expected 1]', 409, 1019);
    });

    await step('Act: Step 2 — Re-save X under tier RATE_OVERRIDE', async () => {
      res.s2 = await feeReviewApi.save(d.cy, d.P14, { policy: 'NORMAL', tier: 'RATE_OVERRIDE', overrideRate: '5.00', reason: 'Key check', correctionId: d.X });
    });
    await step('Assert: Expected 2 — HTTP 409, STL-1019, same message', async () => {
      expectRefused(res.s2, '[Expected 2]', 409, 1019);
    });

    await step('Act: Step 3 — Re-save W under policy PROMOTION', async () => {
      res.s3 = await feeReviewApi.save(d.cy, d.P01, { policy: 'PROMOTION', tier: 'ASSIGNMENT', commissionCategoryId: d.catE, reason: 'Key check', correctionId: d.W });
    });
    await step('Assert: Expected 3 — HTTP 409, STL-1019, same message', async () => {
      expectRefused(res.s3, '[Expected 3]', 409, 1019);
    });

    await step('Act: Step 4 — Read X and W, and count corrections under P03 and P01 / PROMOTION', async () => {
      after = await select('X and W', 'SELECT id, product_id, policy, tier, category_id, version FROM fee_correction WHERE id IN (?, ?)', [d.X, d.W]);
      count = Number(
        (await select('re-keyed corrections', "SELECT COUNT(*) AS n FROM fee_correction WHERE (product_id = ?) OR (product_id = ? AND policy = 'PROMOTION')", [d.P03, d.P01]))[0]?.n,
      );
    });
    await step('Assert: Expected 4 — X and W unchanged (product, NORMAL, ASSIGNMENT, category B, version); the count is 0', async () => {
      for (const [name, id, productId] of [['X', d.X, d.P14], ['W', d.W, d.P01]] as const) {
        const row = after.find((r) => String(r.id) === id);
        expect.soft(row?.product_id, `[Expected 4] ${name}: same product`).toBe(productId);
        expect.soft(row?.policy, `[Expected 4] ${name}: policy NORMAL`).toBe('NORMAL');
        expect.soft(row?.tier, `[Expected 4] ${name}: tier ASSIGNMENT`).toBe('ASSIGNMENT');
        expect.soft(Number(row?.category_id), `[Expected 4] ${name}: category B`).toBe(d.catB);
        expect.soft(row?.version, `[Expected 4] ${name}: version unchanged`).toEqual(before[name]?.version);
      }
      expect.soft(count, '[Expected 4] Nothing created under P03 or P01 / PROMOTION').toBe(0);
    });
  });

  test('TC_US079_112 — Acting on a correction discarded from another screen is refused', async ({ feeReviewApi, contractsApi, seedData }) => {
    const step = apiStep(feeReviewApi, contractsApi);
    await tcMeta(
      'TC_US079_112',
      'Medium',
      TAGS,
      `After draft Y (P10, typed 6.75) is discarded from another screen, re-saving, submitting or discarding Y, and re-saving with an id that never existed, each return HTTP 404 STL-1020 with the TC message, and Y is left unchanged. Build note (remark): discard is soft, so a discarded correction answers STL-1019 and only an unknown id gets STL-1020 — Expected 1–3 are expected to fail on dev. ${SEED}`,
    );
    const d = { cy: 0, P10: '', Y: '' };
    let before: DbRow | undefined;
    let after: DbRow | undefined;
    const res: Record<string, ApiResult<unknown>> = {};
    const resave = (correctionId: string) => feeReviewApi.save(d.cy, d.P10, { policy: 'NORMAL', tier: 'RATE_OVERRIDE', overrideRate: '6.75', reason: 'Stale screen resave', correctionId });

    await step('Arrange: Pre-condition 1–13 — ROOT (R_A), CY_MAIN, P10 with draft Y (6.75) discarded from another screen', async () => {
      const s = await seedData({ tc: 112, contracts: family({ ROOT: ['R_A'] }), cycles: ['CY_MAIN'], products: [product('P10', [{ cycle: 'CY_MAIN', saleLines: 86 }])] });
      Object.assign(d, { cy: s.cycles.CY_MAIN.id, P10: s.products.P10 });
      d.Y = await saveCorrection(feeReviewApi, d.cy, d.P10, { policy: 'NORMAL', tier: 'RATE_OVERRIDE', overrideRate: '6.75', reason: '유사 계약 요율 적용' });
      expect((await feeReviewApi.discard(d.Y)).status, 'Pre-condition 10: Y discarded (204)').toBe(204);
      before = await correctionRow(d.Y);
      expect(before?.discarded_at, 'Pre-condition 11: Y has discarded_at set').toBeTruthy();
    });

    await step('Act: Step 1 — Re-save Y', async () => {
      res.s1 = await resave(d.Y);
    });
    await step('Assert: Expected 1 — HTTP 404, STL-1020 and the TC message', async () => {
      expectRefused(res.s1, '[Expected 1]', 404, 1020);
    });

    await step('Act: Step 2 — Submit Y', async () => {
      res.s2 = await feeReviewApi.submit([d.Y]);
    });
    await step('Assert: Expected 2 — HTTP 404, STL-1020, same message', async () => {
      expectRefused(res.s2, '[Expected 2]', 404, 1020);
    });

    await step('Act: Step 3 — Discard Y again', async () => {
      res.s3 = await feeReviewApi.discard(d.Y);
    });
    await step('Assert: Expected 3 — HTTP 404, STL-1020, same message', async () => {
      expectRefused(res.s3, '[Expected 3]', 404, 1020);
    });

    await step('Act: Step 4 — Re-save with a correctionId that never existed', async () => {
      res.s4 = await resave(UNKNOWN_ID);
    });
    await step('Assert: Expected 4 — HTTP 404, STL-1020, same message', async () => {
      expectRefused(res.s4, '[Expected 4]', 404, 1020);
    });

    await step('Act: Step 5 — Read Y', async () => {
      after = await correctionRow(d.Y);
    });
    await step('Assert: Expected 5 — Y unchanged: DRAFT, 6.75, discarded_at unchanged, change_approval_id NULL', async () => {
      expect.soft(after?.state, '[Expected 5] state DRAFT').toBe('DRAFT');
      expect.soft(Number(after?.override_rate), '[Expected 5] override_rate 6.75').toBe(6.75);
      expect.soft(String(after?.discarded_at), '[Expected 5] discarded_at unchanged').toBe(String(before?.discarded_at));
      expect.soft(after?.change_approval_id ?? null, '[Expected 5] change_approval_id NULL').toBeNull();
    });
  });

  test('TC_US079_118 — A submit list holding an invalid id rolls back every correction in it', async ({ feeReviewApi, contractsApi, seedData }) => {
    const step = apiStep(feeReviewApi, contractsApi);
    await tcMeta(
      'TC_US079_118',
      'Medium',
      TAGS,
      `A submit of [Y_ok, unknown id] fails with HTTP 404 STL-1020 and leaves Y_ok a DRAFT with no approval record or PENDING history; a submit of [Z_ok, X (already pending)] fails with HTTP 409 STL-1019 and leaves Z_ok untouched; a clean submit of [Y_ok, Z_ok] then succeeds with 2 submitted, each with its own new FEE_RULE record. ${SEED}`,
    );
    const d = { cy: 0, P03: '', P06: '', P14: '', Yok: '', Zok: '', X: '', ca1: 0 };
    const res: Record<string, ApiResult<{ submitted?: number }>> = {};
    let y: DbRow | undefined;
    let z: DbRow | undefined;
    let yHistory: DbRow[] = [];
    let approvalsP03 = -1;
    let finalRows: DbRow[] = [];
    let finalApprovals: Array<DbRow | undefined> = [];

    await step('Arrange: Pre-condition 1–15 — ROOT + ANNEX1, CY_MAIN, drafts Y_ok (P03), Z_ok (P06) and X (P14) with X submitted', async () => {
      const s = await seedData({
        tc: 118,
        contracts: family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9'] }),
        cycles: ['CY_MAIN'],
        products: [product('P03', [{ cycle: 'CY_MAIN', saleLines: 10 }]), product('P06', [{ cycle: 'CY_MAIN', saleLines: 5 }]), product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])],
      });
      Object.assign(d, { cy: s.cycles.CY_MAIN.id, P03: s.products.P03, P06: s.products.P06, P14: s.products.P14 });
      const catA = s.master.category.A;
      d.Yok = await saveCorrection(feeReviewApi, d.cy, d.P03, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: catA, reason: 'Wrong category mapped in commerce' });
      d.Zok = await saveCorrection(feeReviewApi, d.cy, d.P06, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: catA, reason: 'Category D has no contract row — map to A' });
      d.X = await saveCorrection(feeReviewApi, d.cy, d.P14, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.B, reason: 'Wrong category mapped in commerce' });
      await submitCorrections(feeReviewApi, [d.X]);
      d.ca1 = await approvalIdOf(d.X);
    });

    await step('Act: Step 1 — Submit [Y_ok, 999999999999]', async () => {
      res.s1 = await feeReviewApi.submit([d.Yok, UNKNOWN_ID]);
    });
    await step('Assert: Expected 1 — HTTP 404, STL-1020 and the TC message', async () => {
      expectRefused(res.s1, '[Expected 1]', 404, 1020);
    });

    await step('Act: Step 2 — Read Y_ok and its history rows', async () => {
      y = await correctionRow(d.Yok);
      yHistory = await select('history of Y_ok', 'SELECT * FROM fee_correction_history WHERE correction_id = ?', [d.Yok]);
    });
    await step('Assert: Expected 2 — Y_ok untouched: DRAFT, pending_key NULL, change_approval_id NULL; no PENDING history row', async () => {
      expect.soft(y?.state, '[Expected 2] state DRAFT').toBe('DRAFT');
      expect.soft(y?.pending_key ?? null, '[Expected 2] pending_key NULL').toBeNull();
      expect.soft(y?.change_approval_id ?? null, '[Expected 2] change_approval_id NULL').toBeNull();
      expect.soft(yHistory.filter((h) => h.outcome === 'PENDING'), '[Expected 2] No history row with outcome PENDING').toEqual([]);
    });

    await step('Act: Step 3 — Count FEE_RULE approval records for P03 / NORMAL', async () => {
      approvalsP03 = Number(
        (await select('approvals of P03', "SELECT COUNT(*) AS n FROM change_approval WHERE target_type = 'FEE_RULE' AND target_ref LIKE ?", [`%/${d.P03}/NORMAL`]))[0]?.n,
      );
    });
    await step('Assert: Expected 3 — 0, no approval record was created for Y_ok', async () => {
      expect(approvalsP03, '[Expected 3] No approval record for Y_ok').toBe(0);
    });

    await step('Act: Step 4 — Submit [Z_ok, X]', async () => {
      res.s4 = await feeReviewApi.submit([d.Zok, d.X]);
    });
    await step('Assert: Expected 4 — HTTP 409, STL-1019 and the TC message', async () => {
      expectRefused(res.s4, '[Expected 4]', 409, 1019);
    });

    await step('Act: Step 5 — Read Z_ok', async () => {
      z = await correctionRow(d.Zok);
    });
    await step('Assert: Expected 5 — Z_ok untouched: DRAFT, pending_key NULL, change_approval_id NULL', async () => {
      expect.soft(z?.state, '[Expected 5] state DRAFT').toBe('DRAFT');
      expect.soft(z?.pending_key ?? null, '[Expected 5] pending_key NULL').toBeNull();
      expect.soft(z?.change_approval_id ?? null, '[Expected 5] change_approval_id NULL').toBeNull();
    });

    await step('Act: Step 6 — Submit [Y_ok, Z_ok]', async () => {
      res.s6 = await feeReviewApi.submit([d.Yok, d.Zok]);
      finalRows = await select('Y_ok and Z_ok', 'SELECT id, state, change_approval_id FROM fee_correction WHERE id IN (?, ?)', [d.Yok, d.Zok]);
      finalApprovals = await Promise.all(finalRows.map((r) => (r.change_approval_id ? approvalRow(Number(r.change_approval_id)) : Promise.resolve(undefined))));
    });
    await step('Assert: Expected 6 — HTTP 200, 2 submitted; Y_ok and Z_ok PENDING, each with its own new FEE_RULE record', async () => {
      expect.soft(res.s6.status, '[Expected 6] HTTP 200').toBe(200);
      expect.soft(res.s6.body?.submitted, '[Expected 6] 2 submitted').toBe(2);
      for (const [name, id] of [['Y_ok', d.Yok], ['Z_ok', d.Zok]] as const) {
        expect.soft(finalRows.find((r) => String(r.id) === id)?.state, `[Expected 6] ${name}: state PENDING`).toBe('PENDING');
      }
      const ids = finalRows.map((r) => Number(r.change_approval_id));
      expect.soft(new Set(ids.filter(Boolean)).size, '[Expected 6] Two distinct approval records').toBe(2);
      expect.soft(ids, '[Expected 6] New records — not the record of X').not.toContain(d.ca1);
      for (const a of finalApprovals) expect.soft(a?.target_type, '[Expected 6] Each record is a FEE_RULE record').toBe('FEE_RULE');
    });
  });

  test('TC_US079_119 — Submitting a correction that is not a draft is refused', async ({ feeReviewApi, contractsApi, seedData }) => {
    const step = apiStep(feeReviewApi, contractsApi);
    await tcMeta(
      'TC_US079_119',
      'Medium',
      TAGS,
      `Re-submitting X (already PENDING) is refused with HTTP 409 STL-1019 and the TC message and leaves X and its single FEE_RULE record unchanged; submitting W (discarded) is refused with HTTP 409 STL-1019 and leaves W unchanged; the P14 row still carries correction.state PENDING. ${SEED}`,
    );
    const d = { cy: 0, P14: '', P06: '', X: '', W: '', ca1: 0 };
    let wBefore: DbRow | undefined;
    let x: DbRow | undefined;
    let w: DbRow | undefined;
    let records = -1;
    const res: Record<string, ApiResult<unknown>> = {};
    let rowState: { status: number; state?: string } = { status: 0 };

    await step('Arrange: Pre-condition 1–14 — ROOT + ANNEX1, CY_MAIN, X (P14) submitted, W (P06) saved then discarded', async () => {
      const s = await seedData({
        tc: 119,
        contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }),
        cycles: ['CY_MAIN'],
        products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }]), product('P06', [{ cycle: 'CY_MAIN', saleLines: 5 }])],
      });
      Object.assign(d, { cy: s.cycles.CY_MAIN.id, P14: s.products.P14, P06: s.products.P06 });
      d.X = await saveCorrection(feeReviewApi, d.cy, d.P14, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.B, reason: 'Wrong category mapped in commerce' });
      await submitCorrections(feeReviewApi, [d.X]);
      d.ca1 = await approvalIdOf(d.X);
      d.W = await saveCorrection(feeReviewApi, d.cy, d.P06, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.A, reason: 'Category D has no contract row — map to A' });
      expect((await feeReviewApi.discard(d.W)).status, 'Pre-condition 13: W discarded (204)').toBe(204);
      wBefore = await correctionRow(d.W);
    });

    await step('Act: Step 1 — Submit [X]', async () => {
      res.s1 = await feeReviewApi.submit([d.X]);
    });
    await step('Assert: Expected 1 — HTTP 409, STL-1019 and the TC message', async () => {
      expectRefused(res.s1, '[Expected 1]', 409, 1019);
    });

    await step('Act: Step 2 — Read X and count the FEE_RULE records of its key', async () => {
      x = await correctionRow(d.X);
      records = Number((await select('records of P14', "SELECT COUNT(*) AS n FROM change_approval WHERE target_type = 'FEE_RULE' AND target_ref LIKE ?", [`%/${d.P14}/NORMAL`]))[0]?.n);
    });
    await step('Assert: Expected 2 — X unchanged: PENDING, CA1, submission_no 1; still 1 FEE_RULE record', async () => {
      expect.soft(x?.state, '[Expected 2] state PENDING').toBe('PENDING');
      expect.soft(Number(x?.change_approval_id), '[Expected 2] change_approval_id = CA1').toBe(d.ca1);
      expect.soft(Number(x?.submission_no), '[Expected 2] submission_no 1').toBe(1);
      expect.soft(records, '[Expected 2] Still one FEE_RULE record for the key').toBe(1);
    });

    await step('Act: Step 3 — Submit [W]', async () => {
      res.s3 = await feeReviewApi.submit([d.W]);
    });
    await step('Assert: Expected 3 — HTTP 409, STL-1019', async () => {
      expectRefused(res.s3, '[Expected 3]', 409, 1019, false);
    });

    await step('Act: Step 4 — Read W', async () => {
      w = await correctionRow(d.W);
    });
    await step('Assert: Expected 4 — W unchanged: DRAFT, discarded_at as before, change_approval_id NULL', async () => {
      expect.soft(w?.state, '[Expected 4] state DRAFT').toBe('DRAFT');
      expect.soft(String(w?.discarded_at), '[Expected 4] discarded_at unchanged').toBe(String(wBefore?.discarded_at));
      expect.soft(w?.change_approval_id ?? null, '[Expected 4] change_approval_id NULL').toBeNull();
    });

    await step('Act: Step 5 — GET the product list with keyword P14', async () => {
      const row = await feeReviewApi.row(d.cy, d.P14);
      rowState = { status: lastStatus(feeReviewApi), state: row.correction?.state };
    });
    await step('Assert: Expected 5 — HTTP 200; the P14 row carries correction.state PENDING', async () => {
      expect.soft(rowState.status, '[Expected 5] HTTP 200').toBe(200);
      expect.soft(rowState.state, '[Expected 5] correction.state PENDING').toBe('PENDING');
    });
  });

  test('TC_US079_123 — Withdrawing after the approver decided is refused and the row reloads', async ({ feeReviewApi, approverFeeReviewApi, contractsApi, seedData }) => {
    const step = apiStep(feeReviewApi, approverFeeReviewApi, contractsApi);
    await tcMeta(
      'TC_US079_123',
      'Medium',
      TAGS,
      `Once user B (TOKEN_B) approves CA1 or rejects CA2, user A's withdraw of X or Y is refused with HTTP 409 STL-1015 and the TC message; the decision stands (X APPROVED decided by B, Y REJECTED with B's reason and last_return_cause REJECTED) and the reloaded P14 row carries APPROVED. ${SEED}`,
    );
    const d = { cy: 0, P14: '', P03: '', X: '', Y: '', ca1: 0, ca2: 0 };
    const REJECT = 'Wrong category — re-check the annex';
    const res: Record<string, ApiResult<unknown>> = {};
    let ca1Row: DbRow | undefined;
    let ca2Row: DbRow | undefined;
    let x: DbRow | undefined;
    let y: DbRow | undefined;
    let reloaded: string | undefined;

    await step('Arrange: Pre-condition 1–13 — ROOT + ANNEX1, CY_MAIN, X (P14) and Y (P03) submitted, CA1 / CA2 pending', async () => {
      const s = await seedData({
        tc: 123,
        contracts: family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9'] }),
        cycles: ['CY_MAIN'],
        products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }]), product('P03', [{ cycle: 'CY_MAIN', saleLines: 10 }])],
      });
      Object.assign(d, { cy: s.cycles.CY_MAIN.id, P14: s.products.P14, P03: s.products.P03 });
      d.X = await saveCorrection(feeReviewApi, d.cy, d.P14, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.B, reason: 'Wrong category mapped in commerce' });
      d.Y = await saveCorrection(feeReviewApi, d.cy, d.P03, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.A, reason: 'Wrong category mapped in commerce' });
      await submitCorrections(feeReviewApi, [d.X, d.Y]);
      d.ca1 = await approvalIdOf(d.X);
      d.ca2 = await approvalIdOf(d.Y);
    });

    await step('Act: Step 1 — As user B approve CA1', async () => {
      res.s1 = await approverFeeReviewApi.approve(d.ca1);
      ca1Row = await approvalRow(d.ca1);
    });
    await step('Assert: Expected 1 — HTTP 200; CA1 approval_status = APPROVED', async () => {
      expect.soft(res.s1.status, '[Expected 1] HTTP 200').toBe(200);
      expect.soft(ca1Row?.approval_status, '[Expected 1] CA1 APPROVED').toBe('APPROVED');
    });

    await step('Act: Step 2 — As user A withdraw X', async () => {
      res.s2 = await feeReviewApi.withdraw(d.X);
    });
    await step('Assert: Expected 2 — HTTP 409, STL-1015 and the TC message', async () => {
      expectRefused(res.s2, '[Expected 2]', 409, 1015);
    });

    await step('Act: Step 3 — Read X and reload the P14 row', async () => {
      x = await correctionRow(d.X);
      reloaded = (await feeReviewApi.row(d.cy, d.P14)).correction?.state;
    });
    await step('Assert: Expected 3 — X APPROVED, decided_by user B, pending_key NULL; the P14 row carries APPROVED', async () => {
      expect.soft(x?.state, '[Expected 3] X state APPROVED').toBe('APPROVED');
      expect.soft(String(x?.decided_by ?? ''), '[Expected 3] decided_by = user B').toMatch(identity(getAccountDisplayName('approver')));
      expect.soft(x?.pending_key ?? null, '[Expected 3] pending_key NULL').toBeNull();
      expect.soft(reloaded, '[Expected 3] Reloaded row correction.state APPROVED').toBe('APPROVED');
    });

    await step('Act: Step 4 — As user B reject CA2', async () => {
      res.s4 = await approverFeeReviewApi.reject(d.ca2, REJECT);
      ca2Row = await approvalRow(d.ca2);
    });
    await step('Assert: Expected 4 — HTTP 200; CA2 is rejected', async () => {
      expect.soft(res.s4.status, '[Expected 4] HTTP 200').toBe(200);
      expect.soft(ca2Row?.approval_status, '[Expected 4] CA2 REJECTED').toBe('REJECTED');
    });

    await step('Act: Step 5 — As user A withdraw Y', async () => {
      res.s5 = await feeReviewApi.withdraw(d.Y);
    });
    await step('Assert: Expected 5 — HTTP 409, STL-1015, same message as step 2', async () => {
      expectRefused(res.s5, '[Expected 5]', 409, 1015);
    });

    await step('Act: Step 6 — Read Y', async () => {
      y = await correctionRow(d.Y);
    });
    await step("Assert: Expected 6 — Y REJECTED with B's reason and last_return_cause REJECTED", async () => {
      expect.soft(y?.state, '[Expected 6] state REJECTED').toBe('REJECTED');
      expect.soft(y?.rejection_reason, '[Expected 6] rejection_reason').toBe(REJECT);
      expect.soft(y?.last_return_cause, '[Expected 6] last_return_cause REJECTED').toBe('REJECTED');
    });
  });

  test('TC_US079_124 — Withdrawing a correction that is not pending is refused', async ({ feeReviewApi, contractsApi, seedData }) => {
    const step = apiStep(feeReviewApi, contractsApi);
    await tcMeta(
      'TC_US079_124',
      'Medium',
      TAGS,
      `Withdrawing X (already withdrawn, DRAFT) or W (never submitted) is refused with HTTP 409 STL-1019 (TC message checked on the first call) and both rows stay unchanged. ${SEED}`,
    );
    const d = { cy: 0, X: '', W: '', ca1: 0 };
    const res: Record<string, ApiResult<unknown>> = {};
    let rows: DbRow[] = [];

    await step('Arrange: Pre-condition 1–14 — ROOT + ANNEX1, CY_MAIN, X (P14) submitted then withdrawn, W (P06) a fresh draft', async () => {
      const s = await seedData({
        tc: 124,
        contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }),
        cycles: ['CY_MAIN'],
        products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }]), product('P06', [{ cycle: 'CY_MAIN', saleLines: 5 }])],
      });
      d.cy = s.cycles.CY_MAIN.id;
      d.X = await saveCorrection(feeReviewApi, d.cy, s.products.P14, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.B, reason: 'Wrong category mapped in commerce' });
      await submitCorrections(feeReviewApi, [d.X]);
      d.ca1 = await approvalIdOf(d.X);
      await decide(feeReviewApi.withdraw(d.X), 'withdraw X', [200, 204]);
      d.W = await saveCorrection(feeReviewApi, d.cy, s.products.P06, { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: s.master.category.A, reason: 'Category D has no contract row — map to A' });
    });

    await step('Act: Step 1 — Withdraw X', async () => {
      res.s1 = await feeReviewApi.withdraw(d.X);
    });
    await step('Assert: Expected 1 — HTTP 409, STL-1019 and the TC message', async () => {
      expectRefused(res.s1, '[Expected 1]', 409, 1019);
    });

    await step('Act: Step 2 — Withdraw W', async () => {
      res.s2 = await feeReviewApi.withdraw(d.W);
    });
    await step('Assert: Expected 2 — HTTP 409, STL-1019', async () => {
      expectRefused(res.s2, '[Expected 2]', 409, 1019, false);
    });

    await step('Act: Step 3 — Read X and W', async () => {
      rows = await select('X and W', 'SELECT * FROM fee_correction WHERE id IN (?, ?)', [d.X, d.W]);
    });
    await step('Assert: Expected 3 — Both unchanged: X DRAFT / WITHDRAWN / CA1; W DRAFT with no approval record', async () => {
      const x = rows.find((r) => String(r.id) === d.X);
      const w = rows.find((r) => String(r.id) === d.W);
      expect.soft(x?.state, '[Expected 3] X state DRAFT').toBe('DRAFT');
      expect.soft(x?.last_return_cause, '[Expected 3] X last_return_cause WITHDRAWN').toBe('WITHDRAWN');
      expect.soft(Number(x?.change_approval_id), '[Expected 3] X change_approval_id = CA1').toBe(d.ca1);
      expect.soft(w?.state, '[Expected 3] W state DRAFT').toBe('DRAFT');
      expect.soft(w?.change_approval_id ?? null, '[Expected 3] W change_approval_id NULL').toBeNull();
    });
  });
});
