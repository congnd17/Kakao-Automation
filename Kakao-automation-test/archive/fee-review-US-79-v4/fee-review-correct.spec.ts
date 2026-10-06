import { test, expect } from '@fixtures/fee-review.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { FR_KO, FR_TC } from '@utils/fee-review.i18n';
import { CYCLE, FIXTURE, RATE_MOVING, autoReason, baseline } from '@utils/fee-review.data';

/**
 * US079 — nhóm [Correct]: dialog 수수료 산정 수정 (Tier 1 đổi category, Tier 2 nhập tay), đường duyệt, validate, khoá trạng
 * thái và đua 2 phiên. Fixture ghi: P14 (dev đặt tên "for save / submit") cho Tier 1, P10 (Tier 2 mở) cho nhập tay. Mọi
 * correction test tạo được `feeReviewState` dọn ở teardown (nháp / bị trả → xoá, chờ duyệt → rút rồi xoá).
 */
const TAGS = ['correct', 'fee-review'];
const DEV = `Deviation: the TC's prototype seed does not exist on dev — the T079 fixture with the same scenario in cycle ${CYCLE.label} is used (${FIXTURE.forSave} for Tier 1 writes, ${FIXTURE.tier2Open} for Tier 2).`;
const CLEAN = 'Data: every correction the test creates is withdrawn / discarded in teardown (shared fixtures).';
const esc = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test.describe('[Correct] Correct fee resolution dialog', () => {
  // Baseline P14 đọc lúc chạy — fixture dùng chung bị lệch (30/09), không viết cứng danh mục.
  const P14 = { original: undefined as string | undefined, moving: '', other: '' };
  test.beforeEach(async ({ feeReviewApi }) => {
    Object.assign(P14, await baseline(feeReviewApi, FIXTURE.forSave));
  });

  test.describe.configure({ timeout: 150_000 });

  test('TC_US079_55 — A tier-1 correction whose rate moves is not in force on save and waits as a draft until submitted', async ({ page, feeReviewApi, feeReviewState, feeReviewPage: list }) => {
    const step = makeStep(page);
    const reason = autoReason('TC_US079_55', '테스트 사유 — 요율 변동 확인');
    await tcMeta('TC_US079_55', 'Critical', TAGS, `Picking the rate-moving ${P14.moving} on ${FIXTURE.forSave} shows 요율이 바뀝니다 — 승인 필요 naming the old and new rate (both read at run time from correction-options); Save shows "승인 요청으로 상신되었습니다. 요율이 변경됩니다." and the row reads 수정됨 — 미상신 with the in-force figure unchanged, no approval record, no history entry and nothing on the period report yet (SPEC-GAP-21 resolved: Save alone returns DRAFT; only a separate Submit creates the approval record). ${DEV} ${CLEAN}`);
    let rate = '';
    let target = '';
    let approvalsBefore = 0;
    let panel = '';

    await step('Arrange: Pre-condition 1–2 — A resolved product whose family also prices a rate-moving category', async () => {
      rate = `${(await feeReviewApi.row(CYCLE.id, FIXTURE.forSave)).inForceRate}%`;
      const option = (await feeReviewApi.options(CYCLE.id, FIXTURE.forSave)).categories.find((c) => c.categoryName === P14.moving);
      expect(option?.rate, `${P14.moving} carries a rate in correction-options`).toBeDefined();
      target = `${String(option?.rate).replace(/%$/, '')}%`;
      approvalsBefore = (await feeReviewApi.feeRuleApprovals()).length;
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step(`Act: Step 1 — Open 수정 (Correct) and pick ${P14.moving} from the Tier 1 dropdown`, async () => {
      await list.openCorrect(list.row(FIXTURE.forSave));
      await list.correct.pickCategory(P14.moving);
    });

    await step('Act: Step 2 — Read the delta panel before saving', async () => {
      panel = await list.correct.deltaPanel.innerText();
    });

    await step('Assert: Expected 1 — 요율이 바뀝니다 — 승인 필요 naming both rates and the need for approval', async () => {
      await expect(list.correct.deltaHead, '[Expected 1] Rate changes — needs approval').toHaveText(FR_KO['fix.deltaChgHead']);
      expect(panel, `[Expected 1] Names the rate moving from ${rate} to ${target}`).toMatch(new RegExp(`${esc(rate)}[\\s\\S]*${esc(target)}`));
      expect(panel, '[Expected 1] States it needs approval before it counts').toContain(FR_KO['fix.deltaChgTail'].trim());
    });

    await step('Act: Step 3 — Type the reason and click 저장 (Save)', async () => {
      await list.correct.reasonInput.fill(reason);
      expect((await list.correct.save()).status(), 'The save succeeds').toBeLessThan(300);
      await feeReviewState.trackRow(feeReviewApi, FIXTURE.forSave, 'NORMAL', P14.original);
    });

    await step('Assert: Expected 2 — The toast reads exactly "승인 요청으로 상신되었습니다. 요율이 변경됩니다."', async () => {
      await expect(list.toast(FR_KO['fix.savedDraft']), '[Expected 2] Draft toast').toBeVisible();
    });

    await step('Assert: Expected 3 — 수정됨 — 미상신; figure unchanged; no approval record; not on the report yet', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await expect(list.statusPills(list.row(FIXTURE.forSave)).nth(1), '[Expected 3] 수정됨 — 미상신').toHaveText(FR_KO['state.DRAFT']);
      await expect(list.cell(list.row(FIXTURE.forSave), 'rate'), '[Expected 3] In-force figure first, unchanged').toHaveText(new RegExp(`^${esc(rate)}`));
      expect((await feeReviewApi.row(CYCLE.id, FIXTURE.forSave)).correction?.state, '[Expected 3] Save alone leaves a DRAFT (SPEC-GAP-21)').toBe('DRAFT');
      expect((await feeReviewApi.feeRuleApprovals()).length, '[Expected 3] No approval record created').toBe(approvalsBefore);
      expect((await feeReviewApi.history(CYCLE.id, FIXTURE.forSave)).some((h) => String(h.reason ?? '') === reason), '[Expected 3] No history entry written yet').toBe(false);
      expect((await feeReviewApi.periodCorrections(CYCLE.id)).some((c) => c.reason === reason), '[Expected 3] Not on the period report yet').toBe(false);
    });
  });

  test('TC_US079_56 — The category list offers only categories the product family prices, each annotated with its rate', async ({ page, feeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_56', 'High', TAGS, `${FIXTURE.forSave}'s dropdown lists exactly the categories its family prices (register correction-options, read at run time), each one asserted by name and annotated with the rate it would produce; ${FIXTURE.tier2Open}'s family prices none, so its dropdown carries no category — the list is scoped per family, not a global catalogue. Deviation: no second family pricing a single category (880007) exists on dev — the Tier-2 fixture shows the scoping instead. Deviation: dev writes the annotation as "<category> (5.60%)" where the TC example reads "BM제작MD · 5.60%" — the rate itself is asserted. ${DEV} Data: nothing is saved.`);
    let expected: Array<{ categoryName: string; rate?: string; tied: boolean }> = [];

    await step('Arrange: Pre-condition 1–2 — Two correctable products of different families', async () => {
      expected = (await feeReviewApi.options(CYCLE.id, FIXTURE.forSave)).categories;
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Open 수정 and read every Tier 1 option', async () => {
      await list.openCorrect(list.row(FIXTURE.forSave));
    });

    await step("Assert: Expected 1 — Exactly the family's categories, each annotated with its rate", async () => {
      const options = (await list.correct.optionTexts()).slice(1);
      expect(options.map((o) => o.replace(/ \(.*\)$/, '')), '[Expected 1] Exactly the family categories').toEqual(expected.map((c) => c.categoryName));
      for (const c of expected) {
        const text = options.find((o) => o === c.categoryName || o.startsWith(`${c.categoryName} (`)) ?? '';
        expect(text, `[Expected 1] ${c.categoryName} is offered`).not.toBe('');
        if (c.rate !== undefined && !c.tied) expect(text, `[Expected 1] ${c.categoryName} is annotated with ${c.rate}%`).toContain(`${String(c.rate).replace(/%$/, '')}%`);
        else expect(text, `[Expected 1] ${c.categoryName} is annotated (tied / no row)`).toMatch(/\((⚠ 동순위.*|해당 행 없음)\)$/);
      }
      await list.correct.cancel();
    });

    await step('Act: Step 2 — Open 수정 on a product of another family and read its dropdown', async () => {
      await list.openCorrect(list.row(FIXTURE.tier2Open));
    });

    await step("Assert: Expected 2 — Only that family's categories (here none) — the list is scoped per family", async () => {
      await expect(list.correct.root, '[Expected 2] The family prices no category').toContainText(FR_KO['fix.familyEmpty']);
      await list.correct.cancel();
    });
  });

  test('TC_US079_57 — A category priced by more than one row is offered but marked tied and produces an ambiguous result rather than a rate', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_57', 'Medium', TAGS, `On ${FIXTURE.forSave} the tied category "MD - 입점사 제작" is offered annotated as tied ((⚠ 동순위 2건) per the TC; dev reads (⚠ 동순위)), and choosing it neither previews a specific rate nor routes as if one row were picked (no 요율이 바뀝니다 / 요율 그대로 head). Not automated: the positive wording of the ambiguous preview — no DOM recon / i18n string exists for it yet. ${DEV} Data: nothing is saved.`);
    let label = '';

    await step('Arrange: Pre-condition 1–2 — The family prices a category with two tied rows', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await list.openCorrect(list.row(FIXTURE.forSave));
    });

    await step('Act: Step 1 — Read the tied option in the dropdown', async () => {
      label = (await list.correct.optionTexts()).find((o) => o.startsWith('MD - 입점사 제작')) ?? '';
    });

    await step('Assert: Expected 1 — Offered and annotated (⚠ 동순위 2건)', async () => {
      expect(label, '[Expected 1] The tied option is offered').not.toBe('');
      expect.soft(label, '[Expected 1] Annotated "(⚠ 동순위 2건)"').toBe('MD - 입점사 제작 (⚠ 동순위 2건)');
    });

    await step('Act: Step 2 — Select it and read the delta panel', async () => {
      await list.correct.tier1Select.selectOption({ label });
    });

    await step('Assert: Expected 2 — No specific rate is picked; the preview is ambiguous', async () => {
      await expect(list.correct.deltaPanel, '[Expected 2] No new rate figure').not.toContainText(/→\s*\d+\.\d+%|\d+\.\d+% 로 바뀝니다/);
      await expect(list.correct.message(FR_KO['fix.deltaChgHead']), '[Expected 2] Does not silently pick a rate-moving row').toHaveCount(0);
      await expect(list.correct.message(FR_KO['fix.deltaZeroHead']), '[Expected 2] Does not silently pick a same-rate row').toHaveCount(0);
      test.info().annotations.push({ type: 'Not automated', description: 'Expected 2: the positive wording of the ambiguous preview (no recon / i18n string)' });
      await list.correct.cancel();
    });
  });

  test('TC_US079_58 — The delta panel states before saving which of the three paths the correction will take', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_58', 'Medium', TAGS, `A rate-moving category reads 요율이 바뀝니다 — 승인 필요 and a typed rate on ${FIXTURE.tier2Open} reads 직접 입력 — 승인 필요; none names a rule code. Not automated: path 1 (요율 그대로 — 승인 불필요) — no same-rate category exists on dev (see TC_US079_54). ${DEV} Data: nothing is saved.`);
    const texts: string[] = [];

    await step('Arrange: Pre-condition 1–2 — Correctable products with a rate-moving category and a typed-rate path', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await list.openCorrect(list.row(FIXTURE.forSave));
    });

    await step('Act: Step 1 — Pick the same-rate category (Not automated — none exists)', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Step 1: no same-rate category on dev' });
    });

    await step('Assert: Expected 1 — Path 1 reads 요율 그대로 — 승인 불필요 (Not automated)', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Expected 1: see Step 1' });
    });

    await step('Act: Step 2 — Change to a different-rate category and read the panel', async () => {
      await list.correct.pickCategory(P14.moving);
      texts.push(await list.correct.deltaPanel.innerText());
    });

    await step('Assert: Expected 2 — Path 2 reads 요율이 바뀝니다 — 승인 필요', async () => {
      await expect(list.correct.deltaHead, '[Expected 2] Rate changes — needs approval').toHaveText(FR_KO['fix.deltaChgHead']);
      await list.correct.cancel();
    });

    await step('Act: Step 3 — On a no-row product open the typed-rate field, enter a value and read the panel', async () => {
      await list.openCorrect(list.row(FIXTURE.tier2Open));
      await list.correct.tier2Input.fill('4.50');
      texts.push(await list.correct.deltaPanel.innerText());
    });

    await step('Assert: Expected 3 — Path 3 reads 직접 입력 — 승인 필요', async () => {
      await expect(list.correct.deltaHead, '[Expected 3] Typed by hand — needs approval').toHaveText(FR_KO['fix.deltaT2Head']);
    });

    await step('Assert: Expected 4 — None of the sentences names a rule code', async () => {
      for (const t of texts) expect(t, '[Expected 4] No rule code').not.toMatch(/BR-|STL-|OQ-|CNT-/);
      await list.correct.cancel();
    });
  });

  test('TC_US079_59 — The correction writes nothing back to the contract', async ({ page, feeReviewApi, feeReviewState, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_59', 'Medium', TAGS, `After a tier-1 correction on ${FIXTURE.forSave}, Why this rate still shows the contract's own row for the original category (read at run time) at its original rate, and the contract resolution (contract id + rate) is unchanged — the correction only overlays the category. Not automated: the "contract still resolves to" line of TC_US079_51 — it only renders while a correction is in force, and the rate-moving correction saved here stays a draft. ${DEV} ${CLEAN}`);
    let before: Record<string, unknown> = {};

    await step('Arrange: Pre-condition 1–2 — The contract prices the product category at its rate', async () => {
      before = (await feeReviewApi.trace(CYCLE.id, FIXTURE.forSave)).body;
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Save a tier-1 correction changing the category', async () => {
      await list.openCorrect(list.row(FIXTURE.forSave));
      await list.correct.pickCategory(P14.moving);
      await list.correct.reasonInput.fill(autoReason('TC_US079_59', 'contract stays untouched'));
      await list.correct.save();
      await feeReviewState.trackRow(feeReviewApi, FIXTURE.forSave, 'NORMAL', P14.original);
    });

    await step('Act: Step 2 — Reopen 근거 and check what the contract itself still resolves to', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await list.openBasis(list.row(FIXTURE.forSave));
      await list.basis.expandEvidence();
    });

    await step("Assert: Expected 1 — The contract's own fee row still reads the original rate", async () => {
      expect(P14.original, '[Expected 1] The original category is known').toBeTruthy();
      await expect(list.basis.root, `[Expected 1] The contract row for ${P14.original} is still shown`).toContainText(String(P14.original));
      await expect(list.basis.root, `[Expected 1] Contract ${before.basisContractId} still at ${before.inForceRate}%`).toContainText(`${before.inForceRate}%`);
      const after = (await feeReviewApi.trace(CYCLE.id, FIXTURE.forSave)).body;
      expect({ contract: after.basisContractId, rate: after.inForceRate }, '[Expected 1] The contract resolution is unchanged').toEqual({ contract: before.basisContractId, rate: before.inForceRate });
      await list.basis.close();
    });
  });

  test('TC_US079_60 — Saving with an empty reason and with 201 characters is refused while exactly 200 characters saves', async ({ page, feeReviewApi, feeReviewState, feeReviewPage: list }) => {
    const step = makeStep(page);
    const r200 = autoReason('TC_US079_60', '').padEnd(200, '가').slice(0, 200);
    await tcMeta('TC_US079_60', 'Medium', TAGS, `With a rate-moving category picked on ${FIXTURE.forSave}: an empty reason blocks Save with "수정 사유를 입력해 주세요." and a highlighted field; 201 characters block Save with "사유는 200자까지 입력할 수 있습니다." and a red counter; exactly 200 characters saves. ${DEV} ${CLEAN}`);
    let posts = 0;
    let saved = 0;

    await step('Arrange: Pre-condition 1–2 — The dialog is open with a rate-moving category picked', async () => {
      page.on('request', (r) => {
        if (r.method() === 'POST' && /\/corrections$/.test(r.url())) posts += 1;
      });
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await list.openCorrect(list.row(FIXTURE.forSave));
      await list.correct.pickCategory(P14.moving);
    });

    await step('Act: Step 1 — Leave the reason empty and attempt 저장 (Save)', async () => {
      await list.correct.reasonInput.fill('');
      await list.correct.saveButton.click({ force: true });
    });

    await step('Assert: Expected 1 — Blocked with "수정 사유를 입력해 주세요." and the field highlighted', async () => {
      expect(posts, '[Expected 1] Nothing is sent').toBe(0);
      await expect.soft(list.correct.message(FR_KO['fix.reasonRequired']), '[Expected 1] Reason-required message').toBeVisible();
      await expect.soft(list.correct.reasonInput, '[Expected 1] The field is highlighted').toHaveClass(/is-invalid/);
    });

    await step('Act: Step 2 — Type 201 characters and attempt Save', async () => {
      await list.correct.reasonInput.fill(`${r200}X`);
      await list.correct.saveButton.click({ force: true });
    });

    await step('Assert: Expected 2 — Blocked with "사유는 200자까지 입력할 수 있습니다." and a red counter', async () => {
      expect(posts, '[Expected 2] Nothing is sent').toBe(0);
      await expect.soft(list.correct.message(FR_KO['fix.reasonTooLong']), '[Expected 2] Too-long message').toBeVisible();
      await expect.soft(list.correct.counter, '[Expected 2] The counter turns red').toHaveClass(/text-danger/);
    });

    await step('Act: Step 3 — Remove the last character (exactly 200) and attempt Save', async () => {
      await list.correct.reasonInput.fill(r200);
      saved = (await list.correct.save()).status();
      await feeReviewState.trackRow(feeReviewApi, FIXTURE.forSave, 'NORMAL', P14.original);
    });

    await step('Assert: Expected 3 — Save succeeds at exactly 200 characters', async () => {
      expect(saved, '[Expected 3] The save succeeds').toBeLessThan(300);
    });
  });

  test('TC_US079_61 — Save stays disabled while neither the category nor the rate differs from the value in force', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_61', 'Medium', TAGS, `On ${FIXTURE.approvedTwoPolicies} (a correction already in force — replaces 900190) the dropdown opens at — 변경 없음 —; with only a reason typed 저장 stays disabled ("변경된 내용이 없습니다." if forced) and the delta panel reads 아직 고른 것이 없습니다, inviting another category or a discard of the existing correction ("또는 수정 버리기를 누르면 … 로 되돌아갑니다."). Deviation: the TC itself conflicts with TC_US079_72 (Discard is absent on an applied correction) — the TC's discard offer is asserted as written (soft) pending BA confirmation. ${DEV} Data: nothing is saved.`);

    await step('Arrange: Pre-condition 1–2 — A product that already carries a correction in force', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Open 수정 — the dropdown returns to — 변경 없음 — by default', async () => {
      await list.openCorrect(list.row(FIXTURE.approvedTwoPolicies));
      await expect(list.correct.tier1Select.locator('option:checked'), '— 변경 없음 — by default').toHaveText(FR_KO['fix.noChange']);
    });

    await step('Act: Step 2 — Without picking anything, type a reason and attempt Save', async () => {
      await list.correct.reasonInput.fill(autoReason('TC_US079_61', 'nothing changed'));
      await list.correct.saveButton.click({ force: true });
    });

    await step('Assert: Expected 1 — 저장 stays disabled; forcing it shows "변경된 내용이 없습니다."', async () => {
      await expect(list.correct.saveButton, '[Expected 1] 저장 (Save) disabled').toBeDisabled();
      await expect.soft(list.correct.message(FR_KO['fix.nothingChanged']), '[Expected 1] Nothing-changed message').toBeVisible();
    });

    await step('Assert: Expected 2 — 아직 고른 것이 없습니다, inviting another category or a discard', async () => {
      const discardOffer = new RegExp(FR_KO['fix.deltaNoneDiscard'].trim().split('{cat}').map(esc).join('.+'));
      await expect(list.correct.deltaHead, '[Expected 2] Nothing picked yet').toHaveText(FR_KO['fix.deltaNoneHead']);
      await expect(list.correct.deltaPanel, '[Expected 2] Invites picking another category').toContainText(FR_KO['fix.deltaNoneBody']);
      await expect.soft(list.correct.deltaPanel, '[Expected 2] Offers to discard the existing correction').toContainText(discardOffer);
      await list.correct.cancel();
    });
  });

  test('TC_US079_62 — The typed-rate field opens only when the family prices none of the candidate keys and states why when closed', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_62', 'High', TAGS, `On ${FIXTURE.forSave} (family prices several categories) Tier 2 is closed with "계약에 요율이 있어 직접 입력할 수 없습니다. 위에서 카테고리를 선택하세요."; on ${FIXTURE.tier2Open} (family prices nothing — replaces the TEST-C-900 product) Tier 2 is open with the placeholder 예: 4.50%. ${DEV} Data: nothing is saved.`);

    await step('Arrange: Pre-condition 1–2 — A product whose family prices categories and one whose family prices none', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Open 수정 on the priced product and check Tier 2', async () => {
      await list.openCorrect(list.row(FIXTURE.forSave));
    });

    await step('Assert: Expected 1 — Tier 2 is closed with the lock message', async () => {
      await expect(list.correct.tier2Lock, '[Expected 1] Lock message').toHaveText(FR_KO['fix.tier2Lock']);
      await expect(list.correct.tier2Input, '[Expected 1] No typed-rate input').toHaveCount(0);
      await list.correct.cancel();
    });

    await step('Act: Step 2 — Open 수정 on the zero-fee-row product and check Tier 2', async () => {
      await list.openCorrect(list.row(FIXTURE.tier2Open));
    });

    await step('Assert: Expected 2 — Tier 2 is open and editable with placeholder 예: 4.50%', async () => {
      await expect(list.correct.tier2Input, '[Expected 2] Editable typed-rate field').toBeEditable();
      await expect(list.correct.tier2Input, '[Expected 2] Placeholder 예: 4.50%').toHaveAttribute('placeholder', FR_KO['fix.tier2Placeholder']);
      await list.correct.cancel();
    });
  });

  test('TC_US079_63 — The Tier 2 reason field asks for the basis of the rate, not a change reason', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_63', 'Medium', TAGS, `On ${FIXTURE.tier2Open} with Tier 2 open, the reason label reads 수수료 산정 근거 (필수) (not the Tier 1 wording) and the placeholder names something usable (a comparable contract, an agreed rate or a written approval). Expected to fail: TC v4 marks this TC as failing against the current build (prototype behind spec) — dev's placeholder reads "이 요율을 어떻게 정했는지 입력하세요". ${DEV} Data: nothing is saved.`);

    await step('Arrange: Pre-condition 1–2 — The zero-fee-row product is open in 수정 with Tier 2 available', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await list.openCorrect(list.row(FIXTURE.tier2Open));
    });

    await step("Act: Step 1 — Read the reason field's label and placeholder", async () => {
      await list.correct.reasonInput.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — 수수료 산정 근거 (필수); the placeholder names a usable basis', async () => {
      await expect(list.correct.reasonLabel, '[Expected 1] Tier 2 reason label').toHaveText(FR_KO['fix.reasonLabelT2']);
      await expect(list.correct.reasonLabel, '[Expected 1] Not the Tier 1 wording').not.toHaveText(FR_KO['fix.reasonLabel']);
      await expect.soft(list.correct.reasonInput, '[Expected 1] Placeholder names a comparable contract / agreed rate / written approval').toHaveAttribute('placeholder', /계약|합의|승인|contract|agreed|approval/i);
      await list.correct.cancel();
    });
  });

  test('TC_US079_64 — A typed rate is never in force on save and waits as a draft until submitted', async ({ page, feeReviewApi, feeReviewState, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_64', 'Critical', TAGS, `Typing 2.00% with a basis on ${FIXTURE.tier2Open} and saving shows "승인 요청으로 상신되었습니다. 직접 입력한 요율은 항상 승인이 필요합니다."; the row reads 수정됨 — 미상신, not in force, with no approval record — a typed rate always waits for a separate Submit selected (SPEC-GAP-21 resolved). ${DEV} ${CLEAN}`);
    let approvalsBefore = 0;

    await step('Arrange: Pre-condition 1–2 — The zero-fee-row product is open in 수정, Tier 2 available', async () => {
      approvalsBefore = (await feeReviewApi.feeRuleApprovals()).length;
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await list.openCorrect(list.row(FIXTURE.tier2Open));
    });

    await step('Act: Step 1 — Type rate 2.00%, a basis reason, click 저장 (Save)', async () => {
      await list.correct.tier2Input.fill('2.00');
      await list.correct.reasonInput.fill(autoReason('TC_US079_64', '유사 계약 요율 참고 — 비교 계약 기준'));
      expect((await list.correct.save()).status(), 'The save succeeds').toBeLessThan(300);
      await feeReviewState.trackRow(feeReviewApi, FIXTURE.tier2Open);
    });

    await step('Assert: Expected 1 — The toast reads exactly the hand-keyed draft message', async () => {
      await expect(list.toast(FR_KO['fix.savedDraftTyped']), '[Expected 1] Typed-rate draft toast').toBeVisible();
    });

    await step('Assert: Expected 2 — 수정됨 — 미상신, not in force, no approval record', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await expect(list.statusPills(list.row(FIXTURE.tier2Open)).nth(1), '[Expected 2] 수정됨 — 미상신').toHaveText(FR_KO['state.DRAFT']);
      expect((await feeReviewApi.row(CYCLE.id, FIXTURE.tier2Open)).inForceRate, '[Expected 2] Not in force').toBeUndefined();
      expect((await feeReviewApi.feeRuleApprovals()).length, '[Expected 2] No approval record').toBe(approvalsBefore);
    });
  });

  test('TC_US079_67 — A typed rate that is not a positive number with at most two decimals is refused', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_67', 'Medium', TAGS, `On ${FIXTURE.tier2Open}: -1.00, 0, 4.505 and abc are each refused with "요율을 예시와 같이 입력해 주세요 — 4.50%" (field highlighted, 저장 disabled); 4.50 is accepted. ${DEV} Data: nothing is saved.`);
    const reason = autoReason('TC_US079_67', 'typed-rate validation');

    await step('Arrange: Pre-condition 1–2 — Tier 2 is open on a no-row-applies product', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await list.openCorrect(list.row(FIXTURE.tier2Open));
      await list.correct.reasonInput.fill(reason);
    });

    for (const [n, value, valid] of [[1, '-1.00', false], [2, '0', false], [3, '4.505', false], [4, '4.50', true], [5, 'abc', false]] as const) {
      await step(`Act: Step ${n} — Type ${value} and attempt Save`, async () => {
        await list.correct.tier2Input.fill(value);
      });
      await step(`Assert: Expected ${n} — ${valid ? '4.50 is accepted as a valid rate' : `${value} is refused with the rate message`}`, async () => {
        if (valid) {
          await expect(list.correct.rateError, `[Expected ${n}] No rate error`).toBeHidden();
          await expect(list.correct.saveButton, `[Expected ${n}] 저장 enabled`).toBeEnabled();
        } else {
          await expect(list.correct.saveButton, `[Expected ${n}] Save is blocked`).toBeDisabled();
          await expect(list.correct.rateError, `[Expected ${n}] "요율을 예시와 같이 입력해 주세요 — 4.50%"`).toBeVisible();
          await expect(list.correct.tier2Input, `[Expected ${n}] The field is highlighted`).toHaveClass(/is-invalid/);
        }
        if (n === 5) await list.correct.cancel();
      });
    }
  });

  test('TC_US079_69 — A Not computable product cannot be corrected and the disabled control states the rate is a bracket', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_69', 'Medium', TAGS, `On ${FIXTURE.notComputable} (replaces 26010) 수정 is disabled with the tooltip "구간형 요율이라 이 화면에서는 산정할 수 없습니다 — 카테고리를 바꿔도 같은 행이 적용됩니다.". ${DEV} Data: read-only.`);

    await step('Arrange: Pre-condition 1–2 — A Not computable product is present', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Look at the 수정 (Correct) button', async () => {
      await list.row(FIXTURE.notComputable).scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — Disabled with the bracket tooltip', async () => {
      await expect(list.rowButton(list.row(FIXTURE.notComputable), 'btn.correct'), '[Expected 1] 수정 disabled').toBeDisabled();
      await expect(list.correctWrapper(list.row(FIXTURE.notComputable)), '[Expected 1] Bracket tooltip').toHaveAttribute('title', FR_KO['msg.correctDisabledBracket']);
    });
  });

  test('TC_US079_70 — Correct on a pending row is refused by the disabled control and by the server when a save races ahead', async ({ page, feeReviewApi, feeReviewState, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_70', 'High', TAGS, `Session A opens 수정 on ${FIXTURE.forSave} and picks a category; session B (API) saves and submits a correction; A's Save is refused with STL-1011 "이 상품에는 승인 대기 중인 수정 건이 있습니다. 먼저 회수한 뒤 다시 수정해 주세요."; after a refresh 수정 is disabled with "승인 대기 중입니다 — 먼저 회수한 뒤에 수정하세요.". ${DEV} Deviation: session B is an API call. ${CLEAN}`);
    let refused = { status: 0, body: '' };

    await step('Arrange: Pre-condition 1–2 — Session A has 수정 open on the product with a category picked', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await list.openCorrect(list.row(FIXTURE.forSave));
      await list.correct.pickCategory(P14.moving);
      await list.correct.reasonInput.fill(autoReason('TC_US079_70', 'session A'));
    });

    await step('Act: Step 1 — In session B save and submit a correction on the product', async () => {
      await feeReviewState.pending(feeReviewApi, FIXTURE.forSave, RATE_MOVING, autoReason('TC_US079_70', 'session B'));
    });

    await step("Assert: Expected 1 — Session B's submission succeeds", async () => {
      expect((await feeReviewApi.row(CYCLE.id, FIXTURE.forSave)).correction?.state, '[Expected 1] Awaiting approval').toBe('PENDING');
    });

    await step('Act: Step 2 — In session A click 저장 (Save)', async () => {
      const response = await list.correct.save();
      refused = { status: response.status(), body: await response.text() };
    });

    await step('Assert: Expected 2 — Refused with STL-1011', async () => {
      expect(refused.status, '[Expected 2] Refused (4xx)').toBeGreaterThanOrEqual(400);
      expect(refused.body, '[Expected 2] STL-1011').toContain('STL-1011');
      await expect(list.correct.message(FR_KO['errCode.pendingExists']), '[Expected 2] The STL-1011 message').toBeVisible();
      await list.correct.cancel();
    });

    await step('Act: Step 3 — Refresh the list and look at the 수정 button', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Assert: Expected 3 — 수정 is disabled with the pending tooltip', async () => {
      await expect(list.rowButton(list.row(FIXTURE.forSave), 'btn.correct'), '[Expected 3] 수정 disabled').toBeDisabled();
      await expect(list.correctWrapper(list.row(FIXTURE.forSave)), '[Expected 3] Pending tooltip').toHaveAttribute('title', FR_KO['msg.correctDisabledPending']);
    });
  });

  test('TC_US079_71 — A second draft on the same product and policy is refused while the first is unsubmitted', async ({ page, feeReviewApi, feeReviewState, feeReviewPage: list, secondSession }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_71', 'High', TAGS, `Two sessions open 수정 on ${FIXTURE.forSave}; session A saves a draft; session A's row reads 수정됨 — 미상신; session B's save is refused with STL-1019 and the TC sentence "화면을 불러온 뒤 상품 또는 수정 건의 상태가 바뀌어 이 작업을 할 수 없습니다. 화면을 새로 고쳤습니다." (BR-15.V8, SRS v1.8); reopening in session B shows A's existing draft instead of creating a second one. Deviation: dev maps STL-1019 (STATE_FORBIDS) to "이 수정 건은 지금 상태에서는 처리할 수 없습니다. 화면을 새로 고쳐 현재 상태를 확인해 주세요." — the TC sentence is asserted and is expected to fail on dev. ${DEV} ${CLEAN}`);
    let b: Awaited<ReturnType<typeof secondSession>>;
    let refused = { status: 0, body: '' };

    await step('Arrange: Pre-condition 1–2 — Both sessions have 수정 open on the product before either saves', async () => {
      b = await secondSession('submitter');
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await b.list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await list.openCorrect(list.row(FIXTURE.forSave));
      await b.list.openCorrect(b.list.row(FIXTURE.forSave));
    });

    await step('Act: Step 1 — In session A pick a category and click 저장', async () => {
      await list.correct.pickCategory(P14.moving);
      await list.correct.reasonInput.fill(autoReason('TC_US079_71', 'session A draft'));
      await list.correct.save();
      await feeReviewState.trackRow(feeReviewApi, FIXTURE.forSave, 'NORMAL', P14.original);
    });

    await step('Assert: Expected 1 — A draft exists: 수정됨 — 미상신', async () => {
      expect((await feeReviewApi.row(CYCLE.id, FIXTURE.forSave)).correction?.state, '[Expected 1] Draft saved').toBe('DRAFT');
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await expect(list.statusPills(list.row(FIXTURE.forSave)).nth(1), '[Expected 1] The row reads 수정됨 — 미상신').toHaveText(FR_KO['state.DRAFT']);
    });

    await step('Act: Step 2 — In session B pick another category and click 저장', async () => {
      await b.list.correct.pickCategory(P14.other);
      await b.list.correct.reasonInput.fill(autoReason('TC_US079_71', 'session B draft'));
      const response = await b.list.correct.save();
      refused = { status: response.status(), body: await response.text() };
      test.info().annotations.push({ type: 'Observed (Expected 2)', description: `status ${refused.status} · ${refused.body.slice(0, 200)}` });
    });

    await step('Assert: Expected 2 — Session B is refused with STL-1019 and the screen-changed message', async () => {
      expect(refused.status, '[Expected 2] Refused (4xx)').toBeGreaterThanOrEqual(400);
      expect(refused.body, '[Expected 2] STL-1019').toContain('STL-1019');
      await expect.soft(b.page.getByText(FR_TC.staleStateKo).or(b.page.getByText(FR_TC.staleStateEn)), '[Expected 2] "화면을 불러온 뒤 상품 또는 수정 건의 상태가 바뀌어 이 작업을 할 수 없습니다. 화면을 새로 고쳤습니다."').toBeVisible();
    });

    await step("Assert: Expected 3 — Refreshing session B reloads A's draft, not a second one", async () => {
      // Theo TC, màn phiên B có thể đã tự làm mới (dialog đóng) — chỉ huỷ khi dialog còn mở.
      if (await b.list.correct.root.isVisible()) await b.list.correct.cancel();
      await b.list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await b.list.openCorrect(b.list.row(FIXTURE.forSave));
      await expect(b.list.correct.root, "[Expected 3] Session B shows A's existing draft").toContainText(FR_KO['fix.ctxPendingHead'].trim());
      expect((await feeReviewApi.row(CYCLE.id, FIXTURE.forSave)).correction?.state, '[Expected 3] Still one draft').toBe('DRAFT');
      await b.list.correct.cancel();
    });
  });

  test('TC_US079_72 — Discard is offered for a draft or rejected correction and returns the row to the engine result, and is absent for pending or applied', async ({ page, feeReviewApi, approverFeeReviewApi, feeReviewState, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_72', 'Medium', TAGS, `수정 버리기 is offered on a draft (${FIXTURE.forSave}) and a rejected correction (${FIXTURE.promotionWins}), not on a pending one (${FIXTURE.resolvedAnnex}) nor an applied one (${FIXTURE.approvedTwoPolicies}); discarding the draft returns the row to the engine result. ${DEV} The draft, pending and rejected corrections are created through the API. ${CLEAN}`);
    const offered: Record<string, boolean> = {};

    await step('Arrange: Pre-condition 1–2 — A draft, a pending, an applied and a rejected correction', async () => {
      await feeReviewState.draft(feeReviewApi, FIXTURE.forSave, RATE_MOVING, autoReason('TC_US079_72', 'draft'));
      await feeReviewState.pending(feeReviewApi, FIXTURE.resolvedAnnex, RATE_MOVING, autoReason('TC_US079_72', 'pending'));
      const { approval } = await feeReviewState.pending(feeReviewApi, FIXTURE.promotionWins, RATE_MOVING, autoReason('TC_US079_72', 'to be rejected'), 'PROMOTION');
      await approverFeeReviewApi.reject(approval.id, autoReason('TC_US079_72', 'rejected'));
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Open 수정 on each of the four products and check for 수정 버리기', async () => {
      for (const id of [FIXTURE.forSave, FIXTURE.promotionWins, FIXTURE.approvedTwoPolicies]) {
        await list.openCorrect(list.row(id));
        offered[id] = (await list.correct.discardButton.count()) > 0;
        await list.correct.cancel();
      }
      offered[FIXTURE.resolvedAnnex] = await list.rowButton(list.row(FIXTURE.resolvedAnnex), 'btn.correct').isEnabled();
    });

    await step('Assert: Expected 1 — Offered only on the draft and the rejected one', async () => {
      expect(offered, '[Expected 1] Discard on draft + rejected only (pending cannot even be opened)').toEqual({
        [FIXTURE.forSave]: true,
        [FIXTURE.promotionWins]: true,
        [FIXTURE.approvedTwoPolicies]: false,
        [FIXTURE.resolvedAnnex]: false,
      });
    });

    await step('Act: Step 2 — On the draft click 수정 버리기', async () => {
      await list.openCorrect(list.row(FIXTURE.forSave));
      await list.correct.discardButton.click();
    });

    await step("Assert: Expected 2 — The correction is removed and the row returns to the engine's plain result", async () => {
      await expect(list.toast(FR_KO['fix.discarded']), '[Expected 2] Discarded toast').toBeVisible();
      // Fixture dùng chung có thể đã mang 1 correction ĐÃ ÁP DỤNG từ trước (run 01/10: APPLIED ASSIGNMENT trên P14) — bỏ bản
      // nháp đưa row về trạng thái trước test, nên chỉ assert bản nháp đã biến mất chứ không đòi correction = null.
      await expect.poll(async () => (await feeReviewApi.row(CYCLE.id, FIXTURE.forSave)).correction?.state ?? 'NONE', { message: '[Expected 2] The draft correction is gone' }).not.toBe('DRAFT');
      expect((await feeReviewApi.row(CYCLE.id, FIXTURE.forSave)).inForceCategory, "[Expected 2] The engine's own category is in force").toBe(P14.original);
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await expect(list.cell(list.row(FIXTURE.forSave), 'status'), '[Expected 2] The row no longer carries a correction state').not.toContainText(FR_KO['state.DRAFT']);
    });
  });

  test('TC_US079_75 — A double-click on Save and two operators saving at once do not create two corrections', async ({ page, feeReviewApi, feeReviewState, feeReviewPage: list, secondSession }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_75', 'High', TAGS, `A double-click on 저장 for ${FIXTURE.forSave} sends one request (the button disables while in flight) and creates one correction; two sessions saving ${FIXTURE.resolvedAnnex} at nearly the same moment may leave one or two drafts (SRS v1.8 BR-15.V8 note — the draft count is recorded, ⚠ TBC), and submitting every draft the race left lets exactly one reach Awaiting approval while any other is refused (pending_key, most likely STL-1019). ${DEV} ${CLEAN}`);
    let posts = 0;
    const outcomes: number[] = [];
    const drafts: string[] = [];
    const submits: Array<{ status: number; body: string }> = [];

    await step('Arrange: Pre-condition 1–2 — Two write sessions; no correction in play', async () => {
      page.on('request', (r) => {
        if (r.method() === 'POST' && /\/corrections$/.test(r.url())) posts += 1;
      });
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Pick a category, type a reason and double-click 저장 as fast as possible', async () => {
      await list.openCorrect(list.row(FIXTURE.forSave));
      await list.correct.pickCategory(P14.moving);
      await list.correct.reasonInput.fill(autoReason('TC_US079_75', 'double click'));
      const saved = page.waitForResponse((r) => r.request().method() === 'POST' && /\/corrections$/.test(r.url()));
      await list.correct.saveButton.dblclick();
      await saved;
      await feeReviewState.trackRow(feeReviewApi, FIXTURE.forSave, 'NORMAL', P14.original);
    });

    await step('Assert: Expected 1 — Only one correction is created from the double-click', async () => {
      expect(posts, '[Expected 1] One save request').toBe(1);
      expect((await feeReviewApi.row(CYCLE.id, FIXTURE.forSave)).correction?.state, '[Expected 1] One draft').toBe('DRAFT');
    });

    await step('Act: Step 2 — Two sessions save different categories on the same product at nearly the same moment', async () => {
      const b = await secondSession('submitter');
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await b.list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      const p02 = await baseline(feeReviewApi, FIXTURE.resolvedAnnex);
      for (const [s, cat] of [[list, p02.moving], [b.list, p02.other]] as const) {
        await s.openCorrect(s.row(FIXTURE.resolvedAnnex));
        await s.correct.pickCategory(cat);
        await s.correct.reasonInput.fill(autoReason('TC_US079_75', `race ${cat}`));
      }
      const results = await Promise.all([list.correct.save(), b.list.correct.save()]);
      for (const r of results) {
        outcomes.push(r.status());
        const id = r.status() < 300 ? ((await r.json().catch(() => ({}))) as { correctionId?: string }).correctionId : undefined;
        // Mọi nháp cuộc đua để lại đều được ghi nhận để teardown dọn (dispose đọc lại correction hiện tại của dòng mỗi vòng).
        if (id) {
          drafts.push(id);
          feeReviewState.track(feeReviewApi, id, FIXTURE.resolvedAnnex, 'NORMAL', p02.original);
        }
      }
      await feeReviewState.trackRow(feeReviewApi, FIXTURE.resolvedAnnex, 'NORMAL', p02.original);
      test.info().annotations.push({ type: 'Observed (Expected 1–2, ⚠ TBC)', description: `save statuses ${outcomes.join(' / ')} · drafts left by the race: ${drafts.length}` });
      // TC: nộp TẤT CẢ nháp cuộc đua để lại — pending_key chỉ cho 1 bản lên hàng đợi.
      for (const id of drafts) {
        const submitted = await feeReviewApi.submit([id]);
        submits.push({ status: submitted.status, body: JSON.stringify(submitted.body ?? '') });
      }
      test.info().annotations.push({ type: 'Observed (Expected 2)', description: `submit statuses ${submits.map((s) => `${s.status} ${s.body.slice(0, 120)}`).join(' / ')}` });
    });

    await step('Assert: Expected 2 — At most one draft can be submitted; it reaches Awaiting approval and any other is refused', async () => {
      expect(drafts.length, '[Expected 2] The race left at least one draft').toBeGreaterThanOrEqual(1);
      expect(submits.filter((s) => s.status < 300).length, '[Expected 2] Exactly one draft reaches Awaiting approval').toBe(1);
      expect((await feeReviewApi.row(CYCLE.id, FIXTURE.resolvedAnnex)).correction?.state, '[Expected 2] The product is Awaiting approval').toBe('PENDING');
      for (const refused of submits.filter((s) => s.status >= 300)) expect.soft(refused.body, '[Expected 2] The other draft is refused with STL-1019').toContain('STL-1019');
    });
  });

  test('TC_US079_78 — A reason with Korean, an HTML tag, line breaks and surrounding spaces is stored and displayed correctly', async ({ page, feeReviewApi, feeReviewState, feeReviewPage: list }) => {
    const step = makeStep(page);
    const reason = ` [AUTO-US079] TC_US079_78 ${Date.now()} <b>테스트</b> 사유\n두 번째 줄 `;
    await tcMeta('TC_US079_78', 'Medium', TAGS, `A reason with a leading space, "<b>테스트</b> 사유", a line break, "두 번째 줄" and a trailing space saves on ${FIXTURE.forSave}; History shows the tag as literal text (not bold) and keeps the line break; per STL-1018 / FeeCorrection.reason (SRS v1.8) the leading and trailing spaces are trimmed and the trimmed text is what is stored (history API) and displayed. Not automated: that the trim happens before the 200-character limit is counted — no TC step exercises a 200-character reason with surrounding spaces. Deviation: the draft is submitted through the API so a History entry exists (a draft writes none). ${DEV} ${CLEAN}`);
    let status = 0;
    let shown = '';
    let stored = '';

    await step('Arrange: Pre-condition 1–2 — The dialog is open with a category picked', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await list.openCorrect(list.row(FIXTURE.forSave));
      await list.correct.pickCategory(P14.moving);
    });

    await step('Act: Step 1 — Type the reason with the tag, a line break and surrounding spaces, click Save', async () => {
      await list.correct.reasonInput.fill(reason);
      status = (await list.correct.save()).status();
      const id = await feeReviewState.trackRow(feeReviewApi, FIXTURE.forSave, 'NORMAL', P14.original);
      if (id) await feeReviewApi.submit([id]);
    });

    await step('Assert: Expected 1 — The reason saves without error', async () => {
      expect(status, '[Expected 1] Saved').toBeLessThan(300);
    });

    await step('Act: Step 2 — Reopen 이력 (History) and read the stored reason', async () => {
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      await list.openHistory(list.row(FIXTURE.forSave));
      const cell = list.history.rows.filter({ hasText: 'TC_US079_78' }).first().locator('td').last();
      shown = await cell.innerText();
      stored = String((await feeReviewApi.history(CYCLE.id, FIXTURE.forSave)).find((h) => String(h.reason ?? '').includes('TC_US079_78'))?.reason ?? '');
      test.info().annotations.push({ type: 'Observed', description: `displayed reason = ${JSON.stringify(shown)} · stored reason = ${JSON.stringify(stored)}` });
    });

    await step('Assert: Expected 2 — The <b> tag shows as literal text, not bold; the line break is preserved', async () => {
      const row = list.history.rows.filter({ hasText: 'TC_US079_78' }).first();
      await expect(row, '[Expected 2] Literal <b>테스트</b>').toContainText('<b>테스트</b>');
      await expect(row.locator('b', { hasText: '테스트' }), '[Expected 2] Not rendered as bold').toHaveCount(0);
      expect(shown, '[Expected 2] The line break is preserved and readable').toMatch(/사유\s*\n\s*두 번째 줄/);
    });

    await step('Assert: Expected 3 — Leading and trailing spaces are trimmed in what is stored and displayed (STL-1018)', async () => {
      expect(stored, '[Expected 3] The stored reason is the trimmed text').toBe(reason.trim());
      expect(shown, '[Expected 3] The displayed reason has no leading or trailing space').toBe(shown.trim());
      expect(shown, '[Expected 3] The displayed reason keeps the inner content').toContain('두 번째 줄');
      await list.history.close();
    });
  });
});
