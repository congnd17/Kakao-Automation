import type { Locator } from '@playwright/test';
import { test, expect } from '@fixtures/fee-review.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { FR_KO, FR_TC } from '@utils/fee-review.i18n';
import { getAccountDisplayName } from '@utils/auth-token';
import { CYCLE, FIXTURE, autoReason, baseline } from '@utils/fee-review.data';

/**
 * US079 — nhóm [Basis]: dialog 요율 산정 근거 (nguồn TC: input/US079_TestCase_EN_v4.md). Giá trị cụ thể của TC (1.95%,
 * C-001-A, 2026-09-01…) thay bằng giá trị trace / row API của fixture T079 cùng kịch bản (Deviation chung —
 * `@utils/fee-review.data`). Assert theo TC; chỗ TC ≠ UI ghi "Deviation:" trong description.
 */
const TAGS = ['basis', 'fee-review'];
const DEV = `Deviation: the TC's prototype seed does not exist on dev — the T079 fixture with the same scenario in cycle ${CYCLE.label} is used, and the TC's concrete figures are replaced by the register values read through the trace / row API at run time (the shared fixtures drift).`;
const READ = 'Data: read-only.';
type Trace = Record<string, unknown> & { candidates?: Array<Record<string, unknown>>; derivedKey?: Record<string, unknown> };

/** Toạ độ Y của cạnh trên phần tử (để kiểm thứ tự hiển thị trên → dưới). */
async function topOf(locator: Locator): Promise<number> {
  return (await locator.boundingBox())?.y ?? Number.POSITIVE_INFINITY;
}

/** Dòng đầu của ô (ô category / rate có thể có dòng 2 "→ …" khi correction chưa có hiệu lực). */
async function firstLine(locator: Locator): Promise<string> {
  return ((await locator.innerText()) ?? '').split('\n')[0].trim();
}

test.describe('[Basis] Why this rate', () => {
  // Baseline P14 đọc lúc chạy — fixture dùng chung bị lệch (30/09), không viết cứng danh mục.
  const P14 = { original: undefined as string | undefined, moving: '', other: '' };
  test.beforeEach(async ({ feeReviewApi }) => {
    Object.assign(P14, await baseline(feeReviewApi, FIXTURE.forSave));
  });

  test.describe.configure({ timeout: 150_000 });

  test('TC_US079_41 — The reason panel opens with the rate in force, its contract and its effective date before any reasoning is shown', async ({ page, feeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_41', 'Medium', TAGS, `On the resolved ${FIXTURE.resolvedAnnex} (replaces 900412) the panel shows the rate, the contract and the effective date first — above the reasoning block, which stays collapsed because the product resolved. ${DEV} ${READ}`);
    let trace: Trace = {};

    await step('Arrange: Pre-condition 1–2 — A resolved product with its contract and effective date', async () => {
      trace = (await feeReviewApi.trace(CYCLE.id, FIXTURE.resolvedAnnex)).body as Trace;
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Click 근거 (Basis)', async () => {
      await list.openBasis(list.row(FIXTURE.resolvedAnnex));
    });

    await step('Assert: Expected 1 — Rate, contract and effective date shown first, before the collapsed reasoning block', async () => {
      const contract = list.basis.root.getByText(String(trace.basisContractId)).first();
      const effective = list.basis.root.getByText(String(trace.basisEffectiveFrom)).first();
      await expect(list.basis.headlineRate, `[Expected 1] Rate ${trace.inForceRate}%`).toHaveText(`${trace.inForceRate}%`);
      await expect.soft(contract, `[Expected 1] Contract ${trace.basisContractId}`).toBeVisible();
      await expect.soft(effective, `[Expected 1] Effective date ${trace.basisEffectiveFrom}`).toBeVisible();
      const toggleTop = await topOf(list.basis.evidenceToggle);
      expect.soft(await topOf(list.basis.headlineRate), '[Expected 1] The rate is shown before the reasoning block').toBeLessThan(toggleTop);
      expect.soft(await topOf(contract), '[Expected 1] The contract is shown before the reasoning block').toBeLessThan(toggleTop);
      expect.soft(await topOf(effective), '[Expected 1] The effective date is shown before the reasoning block').toBeLessThan(toggleTop);
      await expect(list.basis.evidenceToggle, '[Expected 1] The reasoning block is collapsed (the product resolved)').toHaveAttribute('aria-expanded', 'false');
      await expect(list.basis.section('trace.keyTitle'), '[Expected 1] No reasoning panel shown yet').toHaveCount(0);
      await list.basis.close();
    });
  });

  test('TC_US079_42 — The panel lists every row considered, marks the one that won and names the step that decided it', async ({ page, feeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_42', 'Medium', TAGS, `On ${FIXTURE.resolvedAnnex} (annex beats parent) 검토된 수수료 행 lists both candidate rows, each marked 적용 / 미적용 and the not-applied one with its reason; 우선순위 적용 단계 names 계층 — 부속계약이 본계약보다 우선 as the deciding step. Deviation: dev renders no not-applied reason on a candidate row (verified 01/10) — the reason assertion is expected to fail. Not automated: "scoped to the product's own contract family" — the panel does not show the family of each candidate row (annex rows carry their own contract id). ${DEV} ${READ}`);
    let trace: Trace = {};

    await step('Arrange: Pre-condition 1–2 — The product has two candidates (annex and parent)', async () => {
      trace = (await feeReviewApi.trace(CYCLE.id, FIXTURE.resolvedAnnex)).body as Trace;
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Open 근거 (Basis) and expand 어떻게 결정됐는지 보기 (How this was decided)', async () => {
      await list.openBasis(list.row(FIXTURE.resolvedAnnex));
      await list.basis.expandEvidence();
    });

    await step('Assert: Expected 1 — 검토된 수수료 행 lists both rows, each marked applied or not applied with a reason', async () => {
      const rows = list.basis.candidateRows;
      const candidates = trace.candidates ?? [];
      expect.soft(candidates.length, '[Expected 1] Both rows (annex and parent) were considered').toBeGreaterThanOrEqual(2);
      await expect(rows, '[Expected 1] Every row considered is listed').toHaveCount(candidates.length);
      for (const c of candidates) {
        await expect.soft(rows.filter({ hasText: `${c.rate}%` }), `[Expected 1] Candidate ${c.contractId} · ${c.rate}% is listed`).not.toHaveCount(0);
      }
      await expect(rows.filter({ hasText: new RegExp(`^\\s*${FR_KO['trace.candWin']}`) }), '[Expected 1] One row marked 적용 (applied)').toHaveCount(1);
      const notApplied = rows.filter({ hasText: new RegExp(`^\\s*${FR_KO['trace.candOut']}`) });
      await expect(notApplied, '[Expected 1] Every other row marked 미적용 (not applied)').toHaveCount(Math.max(candidates.length - 1, 0));
      for (let i = 0; i < (await notApplied.count()); i++) {
        // Phần còn lại sau badge + "계약 … · policy · rate · 적용 시작일 yyyy-mm-dd" = lý do không áp dụng.
        const reasonText = (await notApplied.nth(i).innerText()).replace(new RegExp(`^\\s*${FR_KO['trace.candOut']}`), '').replace(/계약[\s\S]*?적용 시작일\s*\d{4}-\d{2}-\d{2}/, '').trim();
        expect.soft(reasonText, `[Expected 1] Not-applied row ${i + 1} states why (e.g. closed by a later row on the same key)`).not.toBe('');
      }
    });

    await step('Assert: Expected 2 — 우선순위 적용 단계 names 계층 — 부속계약이 본계약보다 우선 as the deciding step', async () => {
      const deciding = list.basis.ladderSteps.filter({ hasText: FR_KO['trace.decidedHere'] });
      await expect(deciding, '[Expected 2] Exactly one step is marked 여기서 결정됨 (decided here)').toHaveCount(1);
      await expect(deciding, '[Expected 2] The deciding step is 계층 — 부속계약이 본계약보다 우선 (annex beats parent)').toContainText(FR_KO['trace.tierHIERARCHY']);
      await list.basis.close();
    });
  });

  test('TC_US079_43 — The panel shows the derived key as fee category, sales type, policy and contract family', async ({ page, feeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_43', 'Medium', TAGS, `On ${FIXTURE.resolvedAnnex}, 도출된 키 shows all four parts filled in: 수수료 카테고리, 판매유형 as the readable label 전체위탁 (Full consignment), 정책 and 계약 = the contract family (the parent contract, not the annex row). Deviation: dev shows the raw code FULL_CONSIGNMENT for 판매유형 (01/10) — that assertion is expected to fail. ${DEV} ${READ}`);
    let key: Record<string, unknown> = {};

    await step('Arrange: Pre-condition 1–2 — The product has a complete derived key', async () => {
      key = ((await feeReviewApi.trace(CYCLE.id, FIXTURE.resolvedAnnex)).body as Trace).derivedKey ?? {};
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Open 근거 (Basis) and expand the reasoning', async () => {
      await list.openBasis(list.row(FIXTURE.resolvedAnnex));
      await list.basis.expandEvidence();
    });

    await step('Assert: Expected 1 — 도출된 키 shows all four parts: category, 전체위탁, policy, contract family', async () => {
      const panel = list.basis.section('trace.keyTitle');
      // Ô category có thể kèm marker "수정됨" phía sau khi có correction (fixture P02 drift 01/10) → toContainText.
      await expect(list.basis.value(panel, FR_KO['trace.kvCategory']), `[Expected 1] 수수료 카테고리 = ${key.category}`).toContainText(String(key.category));
      await expect.soft(list.basis.value(panel, FR_KO['trace.kvSale']), '[Expected 1] 판매유형 = 전체위탁 (Full consignment)').toHaveText('전체위탁');
      await expect(list.basis.value(panel, FR_KO['trace.kvPolicy']), `[Expected 1] 정책 = ${key.policy}`).toHaveText(String(key.policy));
      const contract = list.basis.value(panel, FR_KO['trace.kvContract']);
      await expect(contract, '[Expected 1] 계약 is filled in').not.toHaveText(/^\s*—?\s*$/);
      await expect(contract, '[Expected 1] 계약 names the contract family, not the annex row').not.toContainText(FR_KO['trace.annex']);
      await list.basis.close();
    });
  });

  test('TC_US079_44 — The list, the reason panel, the correction preview, the change report and the value sent to the approver all show the same in-force figure for the same product at the same moment', async ({ page, feeReviewApi, feeReviewState, feeReviewPage: list, approvalQueuePage: queue }) => {
    const step = makeStep(page);
    const reason = autoReason('TC_US079_44', 'one figure on five surfaces');
    await tcMeta('TC_US079_44', 'Critical', TAGS, `For ${FIXTURE.forSave} (replaces 900318) the in-force rate is the same on the list, in Why this rate, in the Correct dialog's contract panel, as the approval queue's 변경 전 (Current value) after a rate-moving correction is submitted, and as the report's "before" rate. Deviation: the dev queue labels the current value 직전 승인 값, not 변경 전 (01/10) — the Expected 4 assertion is expected to fail. ${DEV} Data: the submitted correction is withdrawn and discarded in teardown.`);
    let rate = '';
    let approvalId = 0;

    await step('Arrange: Pre-condition 1–2 — A resolved product, no correction yet', async () => {
      rate = `${(await feeReviewApi.row(CYCLE.id, FIXTURE.forSave)).inForceRate}%`;
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Read the rate on the list', async () => {
      await list.row(FIXTURE.forSave).scrollIntoViewIfNeeded();
    });

    await step(`Assert: Expected 1 — The list shows ${rate || 'the rate'}`, async () => {
      await expect(list.cell(list.row(FIXTURE.forSave), 'rate'), '[Expected 1] List rate').toHaveText(rate);
    });

    await step('Act: Step 2 — Open 근거 (Basis) and read the rate there', async () => {
      await list.openBasis(list.row(FIXTURE.forSave));
    });

    await step('Assert: Expected 2 — The reason panel shows the same rate', async () => {
      await expect(list.basis.headlineRate, '[Expected 2] Basis rate').toHaveText(rate);
      await list.basis.close();
    });

    await step('Act: Step 3 — Open 수정 (Correct) and read the "resolved from the contract" rate', async () => {
      await list.openCorrect(list.row(FIXTURE.forSave));
    });

    await step('Assert: Expected 3 — The correction dialog\'s "resolved from the contract" line shows the same rate', async () => {
      await expect(list.correct.contractValue('fix.kvRate'), '[Expected 3] Correct dialog rate').toHaveText(rate);
    });

    await step('Act: Step 4 — Save a rate-moving correction, submit it and read 변경 전 (Current value) in the approval queue', async () => {
      await list.correct.pickCategory(P14.moving);
      await list.correct.reasonInput.fill(reason);
      await list.correct.save();
      const id = await feeReviewState.trackRow(feeReviewApi, FIXTURE.forSave, 'NORMAL', P14.original);
      await feeReviewApi.submit([id ?? '']);
      approvalId = (await feeReviewState.approvalOf(feeReviewApi, FIXTURE.forSave, reason)).id;
      await queue.open();
      await queue.openRequest({ register: 'FEE_RULE', requester: getAccountDisplayName('submitter'), changeApprovalId: approvalId, reason });
    });

    await step('Assert: Expected 4 — The approval queue\'s 변경 전 (Current value) shows the same rate', async () => {
      await expect(queue.panelValue(FR_TC.queueCurrentValue), `[Expected 4] 변경 전 (Current value) carries ${rate}`).toContainText(rate.replace('%', ''));
    });

    await step('Act: Step 5 — Open 이번 기 수정 내역 (Changes this period) and read the "before" rate', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await list.openReport();
      await list.report.showLatest();
    });

    await step('Assert: Expected 5 — The change report\'s "before" rate is the same; all five places agree', async () => {
      const row = list.report.rows.filter({ hasText: reason.slice(0, 40) });
      await expect(list.report.cell(row, 'rate'), '[Expected 5] Before rate').toContainText(`${rate} →`);
      await list.report.close();
    });
  });

  test('TC_US079_45 — A promotion row valid on the order date wins over a normal row and the panel names policy as the deciding step', async ({ page, feeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_45', 'High', TAGS, `On ${FIXTURE.promotionWins} (replaces 900277) the panel shows the PROMOTION rate in force, the applied candidate row is the PROMOTION row, and 정책 — PROMOTION이 NORMAL보다 우선 is the step marked 여기서 결정됨. Not automated: "because the order date falls inside the promotion window" — the panel shows neither the order date nor the promotion window. ${DEV} ${READ}`);
    let trace: Trace = {};

    await step('Arrange: Pre-condition 1–2 — A PROMOTION row and a NORMAL row for the product', async () => {
      trace = (await feeReviewApi.trace(CYCLE.id, FIXTURE.promotionWins, 'PROMOTION')).body as Trace;
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Open 근거 (Basis) on the product', async () => {
      await list.openBasis(list.row(FIXTURE.promotionWins));
      await list.basis.expandEvidence();
    });

    await step('Assert: Expected 1 — The rate in force comes from the PROMOTION row', async () => {
      await expect(list.basis.headlineRate, `[Expected 1] Rate ${trace.inForceRate}% in force`).toHaveText(`${trace.inForceRate}%`);
      const winner = list.basis.candidateRows.filter({ hasText: new RegExp(`^\\s*${FR_KO['trace.candWin']}`) });
      await expect(winner, '[Expected 1] The applied row is the PROMOTION row').toContainText('PROMOTION');
      await expect(winner, `[Expected 1] The applied row carries ${trace.inForceRate}%`).toContainText(`${trace.inForceRate}%`);
    });

    await step('Assert: Expected 2 — The ranking panel names 정책 — PROMOTION이 NORMAL보다 우선 as the deciding step', async () => {
      const deciding = list.basis.ladderSteps.filter({ hasText: FR_KO['trace.decidedHere'] });
      await expect(deciding, '[Expected 2] Exactly one step is marked 여기서 결정됨 (decided here)').toHaveCount(1);
      await expect(deciding, '[Expected 2] 정책 — PROMOTION이 NORMAL보다 우선 (Policy — PROMOTION beats NORMAL)').toContainText(FR_KO['trace.tierPOLICY']);
      await list.basis.close();
    });
  });

  test('TC_US079_46 — Two rows tied all the way down the ranking report the product as ambiguous with no rate shown and the panel saying the ranking tied', async ({ page, feeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_46', 'High', TAGS, `On ${FIXTURE.ambiguous} (replaces 880021) the pill reads 중복 적용 and no rate is shown on the list or in the panel; the ranking panel shows every tier (정책 / 계층 / 유효 시작일) as not deciding and ends with 여전히 동순위, stating it stopped instead of guessing. Deviation: dev renders only the single 여전히 동순위 step for a tie, not every tier (01/10) — the per-tier assertions are expected to fail. ${DEV} ${READ}`);
    let apiRate: string | undefined;

    await step('Arrange: Pre-condition 1–2 — A product with two tied candidates', async () => {
      apiRate = (await feeReviewApi.row(CYCLE.id, FIXTURE.ambiguous)).inForceRate;
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step("Act: Step 1 — Read the product's status pill", async () => {
      await list.row(FIXTURE.ambiguous).scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — 중복 적용 (Ambiguous) and no rate shown for the product', async () => {
      const row = list.row(FIXTURE.ambiguous);
      await expect(list.statusPills(row).first(), '[Expected 1] 중복 적용 (Ambiguous)').toHaveText(FR_KO['status.AMBIGUOUS']);
      await expect(list.cell(row, 'rate'), '[Expected 1] No rate in the rate cell').toHaveText('—');
      await expect(row, '[Expected 1] No rate anywhere on the row').not.toContainText(/\d+(\.\d+)?\s*%/);
      expect(apiRate ?? '', '[Expected 1] No rate is resolved for the product').toBe('');
    });

    await step('Act: Step 2 — Open 근거 (Basis) and read the ranking panel', async () => {
      await list.openBasis(list.row(FIXTURE.ambiguous));
      await list.basis.expandEvidence();
    });

    await step('Assert: Expected 2 — Every tier marked out/tie, ending with 여전히 동순위; the system stopped rather than guessing', async () => {
      const steps = list.basis.ladderSteps;
      for (const tier of [FR_KO['trace.tierPOLICY'], FR_KO['trace.tierHIERARCHY'], FR_KO['trace.tierEFFECTIVE_FROM']]) {
        const tierRow = steps.filter({ hasText: tier });
        await expect.soft(tierRow, `[Expected 2] Tier "${tier}" is shown`).toHaveCount(1);
        await expect.soft(tierRow, `[Expected 2] Tier "${tier}" is marked out/tie, not 여기서 결정됨`).not.toContainText(FR_KO['trace.decidedHere']);
      }
      await expect(steps.last(), '[Expected 2] The ranking ends with 여전히 동순위 (Still tied)').toContainText(FR_KO['trace.stillTied']);
      await expect(steps.last(), '[Expected 2] It states it stopped and quarantined the line instead of guessing').toContainText(FR_KO['trace.stillTiedDetail']);
      await expect(list.basis.headlineRate, '[Expected 2] No rate is guessed in the panel (—)').toHaveText('—');
      await list.basis.close();
    });
  });

  test('TC_US079_47 — A product carrying no fee category reports No row applies without guessing a category, and the panel names the fee category as the part of the key that found nothing', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_47', 'Medium', TAGS, `On ${FIXTURE.noCategory} (no fee category — replaces 900154) the pill reads 적용 행 없음 without a guessed category; per BR-8.V5 (missingKeyPart = NO_CATEGORY) the 적용 가능한 행 없음 panel reads exactly "${FR_TC.noRowNoCategoryKo}" and not the old shared "no row or a tie" sentence. Deviation (build-behind, stated by the TC itself): dev still shows the old shared sentence and has no NO_CATEGORY sentence (01/10) — Expected 2 is expected to fail until the screen is built. Deviation: the TC product belongs to contract family C-001; the dev fixture with no category is bound to no family. ${DEV} ${READ}`);

    await step('Arrange: Pre-condition 1–2 — A product carrying no fee category', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await list.setPageSize('100');
    });

    await step("Act: Step 1 — Read the product's status pill", async () => {
      await list.row(FIXTURE.noCategory).scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — 적용 행 없음 (No row applies), no category guessed', async () => {
      await expect(list.statusPills(list.row(FIXTURE.noCategory)).first(), '[Expected 1] 적용 행 없음 (No row applies)').toHaveText(FR_KO['status.NO_ROW']);
      await expect(list.cell(list.row(FIXTURE.noCategory), 'category'), '[Expected 1] No category is guessed').toHaveText('—');
    });

    await step('Act: Step 2 — Open 근거 (Basis) and read the empty-rate panel 적용 가능한 행 없음', async () => {
      await list.openBasis(list.row(FIXTURE.noCategory));
    });

    await step('Assert: Expected 2 — The panel body reads the NO_CATEGORY sentence (BR-8.V5), not the old shared sentence', async () => {
      const panel = list.basis.section('trace.noRowTitle');
      await expect(panel, '[Expected 2] 적용 가능한 행 없음 (No row applies) panel').toBeVisible();
      await expect.soft(panel, `[Expected 2] Body reads "${FR_TC.noRowNoCategoryEn}"`).toContainText(FR_TC.noRowNoCategoryKo);
      await expect.soft(panel, '[Expected 2] Not the old shared "no row or a tie" sentence').not.toContainText(FR_KO['trace.noRowBody']);
      await list.basis.close();
    });
  });

  test('TC_US079_50 — A winning row priced by bracket marks the product Not computable, shows no rate, and the empty-rate block says which of the two cases it is with the reasoning already open', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_50', 'High', TAGS, `On ${FIXTURE.notComputable} (replaces 26010) the pill reads 구간형 요율 — 산정 전 with no rate; Why this rate shows the bracket block in plain words (the rate moves with sales under the contract, the settlement system works it out later, nothing to correct here) with the reasoning already expanded, distinct from the no-row block. ${DEV} ${READ}`);
    const body = FR_KO['trace.bracketBody'];

    await step('Arrange: Pre-condition 1–2 — A product resolving against a bracket row', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step("Act: Step 1 — Read the product's status pill and rate", async () => {
      await list.row(FIXTURE.notComputable).scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — 구간형 요율 — 산정 전 (Not computable yet) and no rate shown', async () => {
      await expect(list.statusPills(list.row(FIXTURE.notComputable)).first(), '[Expected 1] 구간형 요율 — 산정 전 (Not computable yet)').toHaveText(FR_KO['status.NOT_COMPUTABLE']);
      await expect(list.cell(list.row(FIXTURE.notComputable), 'rate'), '[Expected 1] No rate in force (dash)').toHaveText(/^—/);
    });

    await step('Act: Step 2 — Open 근거 (Basis)', async () => {
      await list.openBasis(list.row(FIXTURE.notComputable));
    });

    await step('Assert: Expected 2 — The bracket block in plain words (rate moves with sales, worked out later) with the reasoning already expanded', async () => {
      const block = list.basis.section('trace.bracketTitle');
      await expect(block, '[Expected 2] 구간형 요율 — 아직 산정 전 (Bracket rate — not worked out yet) block').toBeVisible();
      await expect(block, '[Expected 2] The rate depends on how much has been sold under the contract').toContainText(body.slice(0, body.indexOf('구간형이라') + '구간형이라'.length));
      await expect(block, '[Expected 2] The settlement system will work it out later').toContainText(body.slice(body.indexOf('구간 요율 계산이'), body.indexOf('산정합니다.') + '산정합니다.'.length));
      await expect(list.basis.evidenceToggle, '[Expected 2] The reasoning block is already expanded').toHaveAttribute('aria-expanded', 'true');
      await expect(list.basis.root, '[Expected 2] No story name is mentioned').not.toContainText(/US\d{3}/);
    });

    await step('Assert: Expected 3 — Visibly the bracket case, distinct from No row applies: a contract row applies, nothing to correct', async () => {
      await expect(list.basis.section('trace.noRowTitle'), '[Expected 3] Not the 적용 가능한 행 없음 (No row applies) block').toHaveCount(0);
      await expect(list.basis.candidateRows.filter({ hasText: new RegExp(`^\\s*${FR_KO['trace.candWin']}`) }), '[Expected 3] A contract row does apply (marked 적용)').toHaveCount(1);
      await expect(list.basis.section('trace.bracketTitle'), '[Expected 3] There is nothing to correct here').toContainText(body.slice(body.indexOf('이 화면에서 하실 일은 없습니다')));
      await list.basis.close();
    });
  });

  test('TC_US079_51 — When a correction is in force the panel shows the corrected key with a marker, separately shows what the contract still resolves to, and never reports Matches on the pre-correction key', async ({ page, feeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_51', 'Medium', TAGS, `On ${FIXTURE.approvedTwoPolicies} (correction in force — replaces 900190) the derived key shows the corrected category with the 수정됨 marker; the 수정본이 적용 중입니다 block separately names the category the contract still resolves to (commerce's assigned category, as in the TC: commerce = contract = BM매입_앨범MD); the 현재 지정된 행 verdict is evaluated against the corrected key — never 일치 while commerce's category differs from the corrected one. ${DEV} ${READ}`);
    let corrected = '';
    let contractCategory = '';

    await step('Arrange: Pre-condition 1–2 — A product carrying an applied tier-1 correction', async () => {
      corrected = (await feeReviewApi.row(CYCLE.id, FIXTURE.approvedTwoPolicies)).inForceCategory ?? '';
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step("Act: Step 1 — Open 근거 (Basis) and read the winner panel's category marker", async () => {
      await list.openBasis(list.row(FIXTURE.approvedTwoPolicies));
      await list.basis.expandEvidence();
    });

    await step('Assert: Expected 1 — The corrected category is shown with a marker distinguishing it as a correction', async () => {
      const category = list.basis.value(list.basis.section('trace.keyTitle'), FR_KO['trace.kvCategory']);
      await expect(category, `[Expected 1] The corrected category ${corrected} is shown`).toContainText(corrected);
      await expect(category, '[Expected 1] It carries the 수정됨 (corrected) marker').toContainText(FR_KO['trace.corrected']);
    });

    await step('Act: Step 2 — Read the "contract still resolves to" line', async () => {
      await list.basis.section('trace.overrideTitle').scrollIntoViewIfNeeded();
      // Dòng override "수정본이 적용 중입니다 — {gốc} → {đã sửa} · …": vế trước mũi tên là category hợp đồng tự ra (verify run 01/10).
      const overrideText = (await list.basis.section('trace.overrideTitle').innerText()).replace(/s+/g, ' ');
      contractCategory = (/—s*(.+?)s*→/.exec(overrideText)?.[1] ?? '').trim();
    });

    await step('Assert: Expected 2 — Separately, the panel states what the contract still resolves to', async () => {
      const override = list.basis.section('trace.overrideTitle');
      await expect(override, '[Expected 2] 수정본이 적용 중입니다 (A correction is in force) block').toBeVisible();
      await expect(override, '[Expected 2] "계약 자체는 그대로…" (the contract itself is untouched)').toContainText(/계약 자체는 그대로/);
      expect(contractCategory, '[Expected 2] The category the contract still resolves to is readable').not.toBe('');
      await expect(override, `[Expected 2] Names the category the contract still resolves to (${contractCategory})`).toContainText(contractCategory);
    });

    await step('Act: Step 3 — Read the assignment comparison verdict', async () => {
      await list.basis.section('trace.assignedTitle').scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — The verdict is evaluated against the corrected key, never 일치 on the pre-correction key alone', async () => {
      const assigned = list.basis.section('trace.assignedTitle');
      // Nhánh theo dữ liệu lúc chạy: commerce (khoá trước correction) khác khoá đã sửa → không được 일치.
      if (contractCategory && contractCategory !== corrected) {
        await expect(assigned, `[Expected 3] Commerce (${contractCategory}) differs from the corrected key (${corrected}) — not 일치 (Matches)`).not.toContainText(FR_KO['trace.flagOk']);
      }
      const verdict = ((await list.cell(list.row(FIXTURE.approvedTwoPolicies), 'compare').textContent()) ?? '').trim();
      await expect(assigned, '[Expected 3] The panel verdict agrees with the list verdict on the corrected key').toContainText(verdict);
      await list.basis.close();
    });
  });

  test('TC_US079_52 — The reason panel opens within one second', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_52', 'Medium', TAGS, `Clicking 근거 on ${FIXTURE.resolvedAnnex} (replaces 900412) renders the panel content within 1 second. ${DEV} ${READ}`);
    let elapsed = 0;

    await step('Arrange: Pre-condition 1–2 — The product is present', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Click 근거 (Basis) and time how long the content takes to render', async () => {
      const started = Date.now();
      await list.openBasis(list.row(FIXTURE.resolvedAnnex));
      await expect(list.basis.headlineRate, 'The rate is rendered').toBeVisible();
      elapsed = Date.now() - started;
      test.info().annotations.push({ type: 'Observed', description: `Why this rate rendered in ${elapsed} ms` });
    });

    await step('Assert: Expected 1 — The panel shows its content within 1 second', async () => {
      expect(elapsed, '[Expected 1] Within 1000 ms').toBeLessThanOrEqual(1000);
      await list.basis.close();
    });
  });

  test('TC_US079_53 — Resolving a page of products in one batched call and resolving each product on its own produce identical results for every product on the page', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_53', 'High', TAGS, `For every product on the first page, the category, rate and status the list shows (batched call) match what its own 근거 panel shows (single-product call): same in-force category, same headline rate, and the panel block matching the status (중복 적용 / 적용 행 없음 → 적용 가능한 행 없음, 구간형 요율 — 산정 전 → the bracket block, otherwise the list rate). ${DEV} ${READ}`);
    const drift: string[] = [];
    let ids: string[] = [];

    await step('Arrange: Pre-condition 1–2 — The first page holds the fixtures', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Load the list page normally (one batched resolution call)', async () => {
      ids = [...new Set(await list.productIds())];
      expect(ids.length, 'Products on the page').toBeGreaterThan(0);
    });

    await step('Act: Step 2 — Open 근거 (Basis) for each product and compare category, rate and status with the list', async () => {
      for (const id of ids) {
        const row = list.row(id);
        const category = await firstLine(list.cell(row, 'category'));
        const rate = await firstLine(list.cell(row, 'rate'));
        const status = ((await list.statusPills(row).first().textContent()) ?? '').trim();
        await list.openBasis(row);
        const headline = ((await list.basis.headlineRate.textContent()) ?? '').trim();
        const panelCategory = ((await list.basis.value(list.basis.root, FR_KO['trace.kvCategory']).first().textContent()) ?? '').trim();
        if (rate !== headline) drift.push(`${id}: rate list "${rate}" vs panel "${headline}"`);
        // List ghi "—" khi không có category được giải; panel khi đó chỉ hiện category của khoá dẫn xuất → không so.
        if (category !== '—' && !panelCategory.startsWith(category)) drift.push(`${id}: category list "${category}" vs panel "${panelCategory}"`);
        if (status === FR_KO['status.AMBIGUOUS'] || status === FR_KO['status.NO_ROW']) {
          if (!(await list.basis.section('trace.noRowTitle').count())) drift.push(`${id}: status ${status} but the panel has no 적용 가능한 행 없음 block`);
        } else if (status === FR_KO['status.NOT_COMPUTABLE']) {
          if (!(await list.basis.section('trace.bracketTitle').count())) drift.push(`${id}: status ${status} but the panel has no bracket block`);
        } else if (!headline.endsWith('%')) {
          drift.push(`${id}: status ${status} but the panel shows no rate`);
        }
        await list.basis.close();
      }
    });

    await step('Assert: Expected 1 — Category, rate and status agree between the list and every product\'s own 근거 panel', async () => {
      expect(drift, '[Expected 1] No drift between the batched list and the single-product resolution for any product').toEqual([]);
    });
  });
});
