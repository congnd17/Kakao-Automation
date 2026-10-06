import { test, expect } from '@fixtures/fee-rate.fixture';
import { makeStep } from '@utils/step';
import { skipTc, tcMeta } from '@utils/tc-meta';
import { getAccountDisplayName } from '@utils/auth-token';
import { FEE_TEXT, KEY, FeeKey, addDays, inDays } from '@utils/fee-rate.data';

/**
 * US078 — nhóm [Detail] / [Create] và các TC ngoài nhóm chính: kết thúc contract sớm, contract đã kết thúc, cảnh báo khoảng
 * trống promotion, ngày "까지" bỏ qua dòng inactive, qualifier tiếng Hàn. Nguồn TC: input/TESTCASE_US078_v2.md
 * (Steps N / Expected N → `Act: Step N` / `Assert: Expected N`). Dữ liệu: contract automation tạo qua API (không xoá được).
 */
const TAGS = ['ui', 'fee-rate', 'fee-rate-detail'];
const DATA = 'Data: automation-owned contract(s) created through the API (contracts cannot be deleted); pending requests are withdrawn in teardown.';
const APPLIED_INSTEAD = 'the approved changes are built on a not-yet-started contract, where changes apply at once (approval needs a second approver — decision 28/09)';
const FANCLUB_KIT_PROMO: FeeKey = { category: 'FANCLUB_KIT', saleType: 'CONSIGNMENT', policy: 'PROMOTION' };

test.describe('[Detail] Contract end, ended contracts, gaps and qualifiers', () => {
  test.describe.configure({ timeout: 150_000 });

  test('TC_US078_81 — Moving a contract end date in on save closes every active fee row at that date with no change request', async ({ page, feeRateApi, feeRateContracts, contractFeePage: fee, contractHistoryPage: history }) => {
    const step = makeStep(page);
    const newEnd = inDays(10);
    await tcMeta('TC_US078_81', 'High', TAGS, `Moving the running contract's end date to today + 10 days saves; the MD row's Effective from then reads "${'{today+10}'}까지 (계약 종료)"; no Fee Rate request exists for the MD row; the contract's fee-rate trail records the contract end (계약 종료) as the cause. ${DATA}`);
    let contract = { id: 0, name: '' };

    await step('Arrange: Pre-condition 1–3 — Logged in as ADMIN; a running contract with MD · 10 % 적용됨 and no row starting after the new end date', async () => {
      contract = await feeRateContracts.create('TC_US078_81', 'RUNNING');
    });

    await step('Act: Step 1 — Open the contract, tab 계약 기간, change the end date to today + 10 days, click Save', async () => {
      await fee.openEdit(contract.id);
      await fee.periodTab.click();
      await fee.periodEndInput.fill(newEnd);
      await fee.periodEndInput.press('Enter');
      await fee.save();
    });

    await step('Assert: Expected 1 — Save succeeds', async () => {
      await expect(page, '[Expected 1] Save succeeds — the app returns to 계약 목록').toHaveURL(/\/commerce\/contracts(\?view=view.*)?$/);
    });

    await step("Act: Step 2 — Click tab Fee Information and read the MD row's Effective from cell", async () => {
      await fee.open(contract.id);
    });

    await step('Assert: Expected 2 — Under the start date the row shows "until {date}" with the new end date, then "(contract end)"', async () => {
      const cell = fee.cell(fee.row(KEY.MD), 'effectiveFrom');
      await expect(cell, `[Expected 2] The row reads "${newEnd}까지"`).toContainText(FEE_TEXT.until(newEnd));
      await expect(cell, '[Expected 2] Followed by "(계약 종료)"').toContainText(FEE_TEXT.contractEnd);
    });

    await step('Act: Step 3 — Open 변경 승인 filtered to Fee Rate (requests of the MD row)', async () => {
      await page.goto('/commerce/change-approvals');
    });

    await step('Assert: Expected 3 — No request exists for the MD row', async () => {
      const changes = await feeRateApi.history(contract.id, await feeRateContracts.rowId(contract.id, KEY.MD));
      expect(changes.filter((c) => c.status === 'PENDING'), '[Expected 3] No pending request was created for the MD row').toHaveLength(0);
    });

    await step("Act: Step 4 — Open the contract's Change history screen and read the fee-rate change trail", async () => {
      await history.openFromList(contract.name);
    });

    await step("Assert: Expected 4 — The trail records the contract's end as the cause", async () => {
      await expect(history.trailRows.filter({ hasText: '계약 종료' }), '[Expected 4] A trail entry names the contract end (계약 종료)').not.toHaveCount(0);
    });
  });

  test('TC_US078_93 — A change on a contract that has already ended applies immediately with a notice and is written to history', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    const reason = 'Contract already closed, correcting a keying error before archival';
    await tcMeta('TC_US078_93', 'Critical', TAGS, `On a contract that ended in 2020 the Change rate dialog shows the no-approval notice and an "적용" button; a correction MD 15 % → 12 % applies at once and the history lists actor, 15 % → 12 % and reason. ⚠ Open question A-10 / OQ-194: the BA may narrow the no-approval exemption to CANCELED contracts — this asserts today's behaviour (Component 84). ${DATA}`);
    let contract = { id: 0 };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; an ended contract (2020-01-01 → 2020-12-31) has MD · 15 %', async () => {
      contract = await feeRateContracts.create('TC_US078_93', 'ENDED', [{ ...KEY.MD, commission: 15 }]);
    });

    await step('Act: Step 1 — Open the contract, tab Fee Information, click Change rate on the MD row', async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD));
    });

    await step('Assert: Expected 1 — The dialog opens', async () => {
      await expect(fee.changeDialog.root, '[Expected 1] The Change rate dialog is open').toBeVisible();
    });

    await step('Act: Step 2 — The dialog shows the notice; pick 정정, rate 12, the reason, click 적용 (Apply)', async () => {
      await expect(fee.changeDialog.message(FEE_TEXT.dialog.gateTitle), 'The no-approval notice is shown').toBeVisible();
      await expect(fee.changeDialog.submitButton, 'The button reads 적용').toHaveText(FEE_TEXT.dialog.apply);
      await fee.changeDialog.fill({ kind: 'correction', rate: '12', reason });
      await fee.changeDialog.submit();
    });

    await step('Assert: Expected 2 — No approval needed, the button read 적용; applying succeeds and the row shows 12 %', async () => {
      await expect(fee.cell(fee.row(KEY.MD), 'fee').locator('input'), '[Expected 2] The row now shows 12').toHaveValue('12');
      await expect(fee.approvalBadge(fee.row(KEY.MD)), '[Expected 2] The row reads 적용됨 — no approval was needed').toHaveText(FEE_TEXT.approval.APPLIED);
    });

    await step('Act: Step 3 — Click History on the MD row', async () => {
      await fee.openHistory(fee.row(KEY.MD));
    });

    await step('Assert: Expected 3 — The history lists the change with actor, 15 % → 12 % and reason', async () => {
      await expect(fee.historyDialog.cell(0, 'who'), '[Expected 3] The actor is shown').toHaveText(getAccountDisplayName('approver'));
      await expect(fee.historyDialog.cell(0, 'change'), '[Expected 3] Before/after 15 % → 12 %').toContainText('15 % → 12 %');
      await expect(fee.historyDialog.cell(0, 'reason'), '[Expected 3] The reason is shown').toHaveText(reason);
    });
  });

  test('TC_US078_94 — The dialog shows the no-approval notice and the button reads Apply when the contract has already ended', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_94', 'Medium', TAGS, `On a contract that ended in 2020 the Change rate dialog shows "${FEE_TEXT.dialog.gateTitle}" and the button reads "적용" instead of "승인 요청". ⚠ Same A-10 / OQ-194 open question as TC_US078_93. ${DATA}`);
    let contract = { id: 0 };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; an ended contract (2020) has an Active MD row', async () => {
      contract = await feeRateContracts.create('TC_US078_94', 'ENDED', [{ ...KEY.MD, commission: 15 }]);
    });

    await step("Act: Step 1 — Click Change rate on the MD row and read the notice and the submit button's label", async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD));
    });

    await step('Assert: Expected 1 — A notice says no approval is needed; the button reads 적용', async () => {
      await expect(fee.changeDialog.message(FEE_TEXT.dialog.gateTitle), '[Expected 1] The no-approval notice is shown').toBeVisible();
      await expect(fee.changeDialog.submitButton, '[Expected 1] The button reads 적용 (Apply)').toHaveText(FEE_TEXT.dialog.apply);
      await fee.changeDialog.cancelButton.click();
    });
  });

  test('TC_US078_95 — A migrated row shows "assigned at migration" with the go-live date as its start', async () => {
    await skipTc('TC_US078_95', 'Medium', TAGS, 'A row with source = MIGRATED shows the go-live date read-only with the qualifier "이관 시 부여" (assigned at migration).', 'the migration has not run and no screen or API creates a row with source = MIGRATED — the TC says the fixture is prepared by Dev, and none exists on dev');
  });

  test('TC_US078_96 — A promotion row whose opening days no row covers warns the orders are held back and still saves', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    const promo = { from: inDays(15), to: inDays(45) };
    const rowStart = inDays(20);
    const warning = FEE_TEXT.check.gapNone(promo.from, addDays(rowStart, -1));
    await tcMeta('TC_US078_96', 'Medium', TAGS, `Adding 팬클럽 키트 · 부분 위탁 · 프로모션 · 18 % from today + 20 with promotion today + 15 → today + 45 (no row at any tier on this key) warns "${warning}" — no rule code — and the save is still allowed. Deviation from TC: "Fan Club + Kit" maps to 팬클럽 키트 on dev. ${DATA}`);
    let contract = { id: 0 };
    let warned = false;
    let saved = 0;

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the contract never had any row on 팬클럽 키트 · 부분 위탁', async () => {
      contract = await feeRateContracts.create('TC_US078_96', 'RUNNING');
    });

    await step('Act: Step 1 — Click Add, fill the promotion row (18 %, start today + 20, promotion today + 15 → today + 45), submit', async () => {
      await fee.openEdit(contract.id);
      await fee.addButton.click();
      await fee.fillNewRow({ ...FANCLUB_KIT_PROMO, rate: 18, startDate: rowStart, promotion: promo });
      await fee.save();
      await expect(fee.reasonDialog.root, 'The reason dialog opens').toBeVisible();
      await fee.reasonDialog.reasonInput.fill('Promotion row with uncovered opening days');
      saved = (await fee.collectFeeRowPosts(() => fee.reasonDialog.submitButton.click(), 1))[0].status;
      // Cảnh báo do server trả về sau khi gửi dòng → hiện dạng toast (verify 29/09).
      warned = await page.getByText(warning).first().waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false);
    });

    await step('Assert: Expected 1 — The warning names the uncovered days as held back, no rule code; the save still goes through', async () => {
      expect(warned, `[Expected 1] Warning "${warning}" is shown`).toBe(true);
      await expect(page.getByText(/\b(CNT|BR|W-CNT)-?\d+/), '[Expected 1] No rule code is shown').toHaveCount(0);
      expect(saved, '[Expected 1] The save is still allowed').toBeLessThan(300);
    });
  });

  test('TC_US078_97 — The until-date of a row skips an inactive later row and runs to the next active row', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    let contract = { id: 0, start: '' };
    let [second, third] = ['', ''];
    await tcMeta('TC_US078_97', 'Medium', TAGS, `With MD rows from S, S + 10 and S + 20 and the middle one switched to inactive, the first row's Effective from reads "until {S+19}" — the day before the third row — skipping the inactive middle row, which shows no until line. Deviation from TC: ${APPLIED_INSTEAD}; S = contract start (TC 2026-01-01), later rows S + 10 / S + 20 (TC today + 10 / + 20). ${DATA}`);

    await step('Arrange: Pre-condition 1–3 — Logged in as ADMIN; MD rows from S, S + 10, S + 20; the middle row switched to Inactive', async () => {
      contract = await feeRateContracts.create('TC_US078_97', 'NOT_STARTED');
      [second, third] = [addDays(contract.start, 10), addDays(contract.start, 20)];
      await feeRateContracts.submit(contract.id, KEY.MD, { changeKind: 'RATE_CHANGE', commission: '11', effectiveFrom: second, changeReason: 'Second MD row' }, contract.start);
      await feeRateContracts.submit(contract.id, KEY.MD, { changeKind: 'RATE_CHANGE', commission: '12', effectiveFrom: third, changeReason: 'Third MD row' }, second);
      await feeRateContracts.deactivate(contract.id, KEY.MD, 'Middle row switched off', second);
    });

    await step("Act: Step 1 — Open the Fee Information tab and read the first row's Effective from cell, below the date", async () => {
      await fee.open(contract.id);
    });

    await step('Assert: Expected 1 — The first row reads "until {S+19}", skipping the inactive middle row, which shows no until line', async () => {
      const until = addDays(third, -1);
      await expect(fee.cell(fee.row(KEY.MD, contract.start), 'effectiveFrom'), `[Expected 1] The first row reads "${until}까지"`).toContainText(FEE_TEXT.until(until));
      await expect(fee.cell(fee.row(KEY.MD, second), 'effectiveFrom'), '[Expected 1] The inactive middle row shows no until line').not.toContainText('까지');
    });
  });

  test('TC_US078_98 — The Impact box reads computed with a real order-line count once US006 ships', async () => {
    await skipTc('TC_US078_98', 'Medium', TAGS, 'After US006 ships the impact box reads "computed" with a real order-line count.', 'BLOCKED by the TC itself until US006 ships — before then the impact can only read not computable (asserted by TC_58 / TC_69 / TC_71)');
  });

  test('TC_US078_100 — Korean display mode shows every date qualifier in Korean only, never mixed with English', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_100', 'Low', TAGS, `In the Korean UI the qualifier under the superseded Album row's Effective from reads entirely in Korean (e.g. "변경") — no English word mixed in. Deviation from TC: ${APPLIED_INSTEAD}. ${DATA}`);
    let contract = { id: 0, start: '' };
    let text = '';

    await step('Arrange: Pre-condition 1–3 — Korean display; logged in as ADMIN; Album has an applied rate change (a superseded row exists)', async () => {
      contract = await feeRateContracts.create('TC_US078_100', 'NOT_STARTED');
      await feeRateContracts.submit(contract.id, KEY.ALBUM, { changeKind: 'RATE_CHANGE', commission: '9', effectiveFrom: addDays(contract.start, 15), changeReason: 'Album rate raised' });
    });

    await step("Act: Step 1 — Open the Fee Information tab and read the qualifier under the superseded row's Effective from cell", async () => {
      await fee.open(contract.id);
      text = ((await fee.cell(fee.row(KEY.ALBUM, contract.start), 'effectiveFrom').innerText()) ?? '').trim();
    });

    await step('Assert: Expected 1 — The qualifier reads entirely in Korean (e.g. 변경); no English word mixed in', async () => {
      expect(text, '[Expected 1] The qualifier 변경 is shown').toContain('변경');
      expect(text.match(/[A-Za-z]{2,}/), '[Expected 1] No English word appears in the qualifier').toBeNull();
    });
  });
});
