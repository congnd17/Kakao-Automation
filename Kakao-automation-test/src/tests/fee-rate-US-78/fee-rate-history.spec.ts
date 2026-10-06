import { test, expect } from '@fixtures/fee-rate.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { getAccountDisplayName } from '@utils/auth-token';
import { FEE_TEXT, KEY, addDays, inDays } from '@utils/fee-rate.data';

/**
 * US078 — nhóm [History]: dialog 수수료율 변경 이력 của fee row và màn 계약 변경 이력 (trail).
 * Nguồn TC: input/TESTCASE_US078_v2.md (Steps N / Expected N → `Act: Step N` / `Assert: Expected N`).
 * Dữ liệu: contract automation tạo qua API (không xoá được); đơn chờ rút lại ở teardown. "Đã duyệt" được dựng trên contract
 * chưa bắt đầu (áp dụng ngay) khi TC cần — chỉ có 1 account có quyền contract (quyết định 28/09).
 */
const TAGS = ['ui', 'fee-rate', 'fee-rate-history'];
const DATA = 'Data: automation-owned contract(s) created through the API (contracts cannot be deleted); pending requests are withdrawn in teardown.';
const APPLIED_INSTEAD = 'the approved changes are built on a not-yet-started contract, where changes apply at once (approval needs a second approver — decision 28/09)';
const INTERNAL_CODE = /\b[A-Z]+_[A-Z_]+\b/;

test.describe('[History] Fee row history and the contract change trail', () => {
  test.describe.configure({ timeout: 150_000 });

  test('TC_US078_84 — The history lists every request with when, who, which setting, what changed and why', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_84', 'Medium', TAGS, `With a correction and a rate change on record for Album, every History entry shows 시점, 수행자, 항목 (the field name, e.g. 수수료율 — never an internal code), 변경 내용 with before → after, and 사유. Deviation from TC: ${APPLIED_INSTEAD}. ${DATA}`);
    let contract = { id: 0, start: '' };
    let entries = 0;

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; Album has a correction and a rate change on record', async () => {
      contract = await feeRateContracts.create('TC_US078_84', 'NOT_STARTED');
      await feeRateContracts.submit(contract.id, KEY.ALBUM, { changeKind: 'CORRECTION', commission: '7.5', changeReason: 'Album rate corrected' });
      await feeRateContracts.submit(contract.id, KEY.ALBUM, { changeKind: 'RATE_CHANGE', commission: '9', effectiveFrom: addDays(contract.start, 15), changeReason: 'Album rate raised by annex' }, contract.start);
    });

    await step('Act: Step 1 — Click History on the Album row and read each entry', async () => {
      await fee.open(contract.id);
      await fee.openHistory(fee.row(KEY.ALBUM, contract.start));
      entries = await fee.historyDialog.rows.count();
    });

    await step('Assert: Expected 1 — Each entry shows When, Who, Setting (field name), Change (before → after) and Reason', async () => {
      expect(entries, '[Expected 1] Both changes are listed').toBeGreaterThanOrEqual(2);
      for (let i = 0; i < entries; i++) {
        const h = fee.historyDialog;
        await expect(h.cell(i, 'when'), `[Expected 1] Entry ${i + 1}: When is a date-time`).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
        await expect(h.cell(i, 'who'), `[Expected 1] Entry ${i + 1}: Who names the actor`).toHaveText(getAccountDisplayName('approver'));
        await expect(h.cell(i, 'setting'), `[Expected 1] Entry ${i + 1}: Setting shows the field name`).toContainText(FEE_TEXT.history.fieldRate);
        await expect(h.cell(i, 'setting'), `[Expected 1] Entry ${i + 1}: Setting shows no internal code`).not.toHaveText(INTERNAL_CODE);
        await expect(h.cell(i, 'change'), `[Expected 1] Entry ${i + 1}: Change shows before → after`).toContainText('→');
        await expect(h.cell(i, 'reason'), `[Expected 1] Entry ${i + 1}: Reason is shown`).toHaveText(/^Album rate/);
      }
    });
  });

  test('TC_US078_85 — A waiting request appears in the history with nothing changed on the row, and the note explains it', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_85', 'Medium', TAGS, `The pending Fan Club request appears in History marked 승인 대기 while the row still shows 7 %, and the note reads "${FEE_TEXT.history.footer}". Deviation from TC: the rate-change date is run-relative (today + 3 days instead of 2026-10-01). ${DATA}`);
    let contract = { id: 0 };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; Fan Club has a pending request (6.5 %)', async () => {
      contract = await feeRateContracts.create('TC_US078_85', 'RUNNING');
      await feeRateContracts.submit(contract.id, KEY.FANCLUB, { changeKind: 'RATE_CHANGE', commission: '6.5', effectiveFrom: inDays(3), changeReason: 'Pending request for the history note' });
    });

    await step('Act: Step 1 — Click History on the Fan Club row, select the pending entry, read the note', async () => {
      await fee.open(contract.id);
      await fee.openHistory(fee.row(KEY.FANCLUB));
      await fee.historyDialog.rows.first().click();
    });

    await step('Assert: Expected 1 — The pending entry shows nothing changed yet; the note explains only approved requests change the row', async () => {
      await expect(fee.historyDialog.cell(0, 'change'), '[Expected 1] The entry is marked 승인 대기').toContainText(FEE_TEXT.history.pending);
      await expect(fee.historyDialog.footer, '[Expected 1] The note reads verbatim').toHaveText(FEE_TEXT.history.footer);
      await fee.historyDialog.close();
      await expect(fee.cell(fee.row(KEY.FANCLUB), 'fee').locator('input'), '[Expected 1] Nothing has changed on the row (still 7)').toHaveValue('7');
    });
  });

  test('TC_US078_86 — A fee row that has never been changed shows the custom empty message', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_86', 'Low', TAGS, `History on a never-changed row shows "${FEE_TEXT.history.emptyTitle}" with "${FEE_TEXT.history.emptySub}" — not the generic empty-table message. ${DATA}`);
    let contract = { id: 0 };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the contract has a fee row never changed since registration', async () => {
      contract = await feeRateContracts.create('TC_US078_86', 'RUNNING');
    });

    await step('Act: Step 1 — Click History on that row', async () => {
      await fee.open(contract.id);
      await fee.openHistory(fee.row(KEY.MD));
    });

    await step('Assert: Expected 1 — "No changes recorded yet" with its subtitle, not the generic empty message', async () => {
      await expect(fee.historyDialog.root.getByText(FEE_TEXT.history.emptyTitle, { exact: true }), '[Expected 1] The custom empty title is shown').toBeVisible();
      await expect(fee.historyDialog.root.getByText(FEE_TEXT.history.emptySub, { exact: true }), '[Expected 1] The custom empty subtitle is shown').toBeVisible();
      await expect(fee.historyDialog.root.getByText('변경 이력이 없습니다.', { exact: true }), '[Expected 1] Not the generic empty-table message').toHaveCount(0);
    });
  });

  test('TC_US078_87 — A correction on a row that is not last in the table is recorded against that same row', async ({ page, feeRateContracts, contractFeePage: fee }) => {
    const step = makeStep(page);
    const reason = 'Contract says 8%, corrected from a 10% keying error';
    await tcMeta('TC_US078_87', 'High', TAGS, `A correction on MD (not the last row) submits (승인 대기); the MD row's History shows 10 % → 8 % against itself while the last row (Fan Club) shows no such entry. Not automated: step 2 / Expected 2 (the approval) — it needs a second approver (decision 28/09); step 3 is checked on the request as recorded. ${DATA}`);
    let contract = { id: 0 };
    let submitted = 0;

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; rows in order MD, Album, Fan Club — MD is not the last row', async () => {
      contract = await feeRateContracts.create('TC_US078_87', 'RUNNING');
    });

    await step('Act: Step 1 — Click Change rate on the MD row, pick 정정, rate 8, the reason, submit', async () => {
      await fee.openEdit(contract.id);
      await fee.openChangeDialog(fee.row(KEY.MD));
      await fee.changeDialog.fill({ kind: 'correction', rate: '8', reason });
      submitted = (await fee.changeDialog.submit()).status;
    });

    await step('Assert: Expected 1 — Submit succeeds; MD shows 승인 대기', async () => {
      expect(submitted, '[Expected 1] Submit succeeds (201)').toBe(201);
      await expect(fee.approvalBadge(fee.row(KEY.MD)), '[Expected 1] MD reads 승인 대기').toHaveText(FEE_TEXT.approval.PENDING);
    });

    // Step 2 cần APPROVER khác người gửi (SoD) — không có account (quyết định 28/09).
    await step('Act: Step 2 — Approve the request (Not automated — needs a second approver)', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Step 2: approval needs an APPROVER different from the submitter' });
    });

    await step('Assert: Expected 2 — Approval succeeds (Not automated)', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Expected 2: see Step 2' });
    });

    await step('Act: Step 3 — Click History on the MD row, and separately on the Fan Club (last) row', async () => {
      await fee.openHistory(fee.row(KEY.MD));
    });

    await step('Assert: Expected 3 — MD history shows 10 % → 8 % against itself; Fan Club shows no such entry', async () => {
      await expect(fee.historyDialog.cell(0, 'change'), '[Expected 3] MD history shows 10 % → 8 %').toContainText('10 % → 8 %');
      await fee.historyDialog.close();
      await fee.openHistory(fee.row(KEY.FANCLUB));
      await expect(fee.historyDialog.root.getByText('10 % → 8 %'), '[Expected 3] The last row has no such entry').toHaveCount(0);
      await fee.historyDialog.close();
    });
  });

  test('TC_US078_88 — The contract Change history screen keeps its snapshot table and entry point after the fee trail is added', async ({ page, feeRateContracts, contractHistoryPage: history }) => {
    const step = makeStep(page);
    await tcMeta('TC_US078_88', 'High', TAGS, `Opened from 변경 히스토리 on 계약 목록, the screen "계약 #{code} 변경 이력" shows its snapshot table (unchanged columns) and, below it, the 수수료율 수정 이력 trail with no filters shared with the snapshot table. Not automated: the paging of the snapshot table — an automation contract has one snapshot entry, so no second page exists. Deviation from TC: the trail entry comes from a not-yet-started contract (applies at once). ${DATA}`);
    let contract = { id: 0, name: '', start: '' };
    let positions = { snapshot: 0, trail: 0 };

    await step('Arrange: Pre-condition 1–2 — Logged in as ADMIN; the contract has a snapshot history entry and a fee-rate trail entry', async () => {
      contract = await feeRateContracts.create('TC_US078_88', 'NOT_STARTED');
      await feeRateContracts.submit(contract.id, KEY.MD, { changeKind: 'CORRECTION', commission: '9', changeReason: 'Trail entry' });
    });

    await step('Act: Step 1 — Open the Change history (계약서 변경 이력) screen from the contract menu', async () => {
      await history.openFromList(contract.name);
    });

    await step('Assert: Expected 1 — The screen opens at the same entry point as before', async () => {
      await expect(page, '[Expected 1] The history view of this contract opens').toHaveURL(new RegExp(`view=history&contractId=${contract.id}`));
      await expect(history.title, '[Expected 1] Title "계약 #{code} 변경 이력"').toBeVisible();
    });

    await step('Act: Step 2 — Scroll through the existing snapshot table', async () => {
      await history.snapshotTable.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — The snapshot table behaves unchanged', async () => {
      await expect(history.snapshotHeaders, '[Expected 2] Snapshot columns are unchanged').toHaveText(['상태', '원계약 코드', '계약 코드', '계약서명', '비즈파트너명', '아티스트명', '계약 기간', '갱신 알림일', '생성일시', '생성자']);
      await expect(history.snapshotTable.locator('tbody tr').first(), '[Expected 2] The snapshot entry is listed (the table clips long names with …)').toContainText(contract.name.slice(0, 15));
    });

    await step('Act: Step 3 — Scroll further down to the fee-rate change trail', async () => {
      await history.trailTable.scrollIntoViewIfNeeded();
      positions = { snapshot: (await history.snapshotTable.boundingBox())?.y ?? 0, trail: (await history.trailTable.boundingBox())?.y ?? 0 };
    });

    await step('Assert: Expected 3 — The fee trail appears below the snapshot table, sharing no filters with it', async () => {
      expect(positions.trail, '[Expected 3] The trail sits below the snapshot table').toBeGreaterThan(positions.snapshot);
      await expect(history.trailRows.first(), '[Expected 3] The trail lists the fee-rate change').toBeVisible();
      await expect(page.getByRole('combobox'), '[Expected 3] No filter is shared between the two tables').toHaveCount(0);
    });
  });
});
