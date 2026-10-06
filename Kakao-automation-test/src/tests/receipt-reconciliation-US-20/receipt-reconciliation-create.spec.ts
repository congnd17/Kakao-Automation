import { test, expect } from '@fixtures/receipt-reconciliation.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { RR_TEXT, currentPeriod, findReceipt, recentPeriods } from '@utils/receipt-reconciliation.data';
import type { BuildReceipt } from '@api/receipt-reconciliation.api';

/**
 * US020 — nhóm [Create] chạy được trên dev (30/09): màn Build group với phiếu nhập thật của dev.
 * Không TC nào ở đây tạo được nhóm (dev chưa có chứng từ US003); TC bấm 대사 묶음 생성 kiểm số nhóm không đổi.
 * Phiếu seed của TC (`GRN-0830`, `INC-9001`, `BP-0001`) không có trên dev → tìm phiếu thật cùng kịch bản qua
 * `GET /build-candidates/receipts` (không có thì skip kèm lý do).
 */
const TAGS = ['create', 'receipt-reconciliation'];
const DATA = 'Data: no group is created — the create attempt is refused client-side.';
const DATA_READ = 'Data: read-only — nothing is selected or saved.';
const SUITE_PRE = 'Arrange: Pre-condition 1–3 — Logged in (every role is the same on the system), inventory period open, period rule seeded';

/** Phiếu "không chọn được" đầu tiên của tháng hiện tại hoặc tháng trước (theo lý do). */
async function findUnselectable(api: Parameters<typeof findReceipt>[0], reason: string): Promise<{ period: string; receipt?: BuildReceipt }> {
  for (const period of recentPeriods(2)) {
    const receipt = await findReceipt(api, period, (candidate) => !candidate.selectable && candidate.notSelectableReason === reason);
    if (receipt) return { period, receipt };
  }
  return { period: currentPeriod() };
}

test.describe('[Create] Receipt reconciliation — build screen', () => {
  test('TC_US020_120 — Create group with no document selected is refused with LED-1105', async ({ page, reconApi, reconListPage: list, reconBuildPage: build }) => {
    const step = makeStep(page);
    await tcMeta('TC_US020_120', 'Medium', TAGS, `With one receipt ticked and no document, 대사 묶음 생성 shows ${RR_TEXT.buildRequired} and creates no group. Deviation from TC: pre-condition 4's collected document does not exist on dev — it is not needed, the case selects no document. ${DATA}`);
    const period = currentPeriod();
    let receipt: BuildReceipt | undefined;
    let before = 0;

    await step(`${SUITE_PRE}; pre-condition 4 — an ungrouped COMPLETE receipt in ${period}`, async () => {
      receipt = await findReceipt(reconApi, period, (candidate) => candidate.selectable && !!candidate.grnNo);
      test.skip(!receipt, `No ungrouped COMPLETE receipt in ${period} on dev`);
      before = (await reconApi.counts(period)).groupCount;
    });

    await step('Act: Step 1 — Open 입고 대사 (Receipt reconciliation)', async () => {
      await list.open();
    });

    await step('Assert: Expected 1 — The list opens', async () => {
      await expect(list.buildGroupButton, '[Expected 1] The list opens with the Build group button').toBeVisible();
    });

    await step('Act: Step 2 — Click 대사 묶음 만들기 (Build group)', async () => {
      await list.openBuildGroup();
    });

    await step('Assert: Expected 2 — The build screen opens', async () => {
      await build.waitLoaded();
      await expect(build.createButton, '[Expected 2] 대사 묶음 생성 (Create group) is shown').toBeVisible();
    });

    await step(`Act: Step 3 — Select receipt ${receipt?.grnNo} in 미대사 입고 전표 and no document at all`, async () => {
      await build.pick(receipt!.bizPartnerId, period);
      await build.tickReceipt(receipt!.grnNo!);
    });

    await step('Assert: Expected 3 — The receipt is selected', async () => {
      await expect.soft(build.receiptRow(receipt!.grnNo!).getByRole('checkbox'), `[Expected 3] ${receipt!.grnNo} is ticked`).toBeChecked();
      await expect(build.documentTable.getByRole('checkbox', { checked: true }), '[Expected 3] No document is ticked').toHaveCount(0);
    });

    await step('Act: Step 4 — Click 대사 묶음 생성 (Create group)', async () => {
      await build.create();
    });

    await step(`Assert: Expected 4 — ${RR_TEXT.buildRequired} renders and no group is created`, async () => {
      await expect.soft(build.requiredMessage, `[Expected 4] "${RR_TEXT.buildRequired}" renders`).toHaveText(RR_TEXT.buildRequired);
      await expect.soft(page, '[Expected 4] The build screen stays open').toHaveURL(/\/build-group/);
      expect((await reconApi.counts(period)).groupCount, '[Expected 4] No group is created').toBe(before);
    });
  });

  test('TC_US020_133 — A receipt held in EXCEPTION at US105 is listed with the awaiting-completion reason and cannot be selected', async ({ page, reconApi, reconListPage: list, reconBuildPage: build }) => {
    const step = makeStep(page);
    await tcMeta('TC_US020_133', 'Medium', TAGS, `A receipt awaiting completion at US105 is listed in 미대사 입고 전표 with its received date, its checkbox replaced by ${RR_TEXT.awaitingCompletion} (cannot be ticked), and the table carries a 창고 column. Deviation from TC: GRN-0830 / BP-0001 / period 2026-08 do not exist on dev — the test uses a real AWAITING_COMPLETION receipt of the current or previous month. ${DATA_READ}`);
    let found: { period: string; receipt?: BuildReceipt } = { period: '' };
    let receivedCell = '';
    let headers: string[] = [];

    await step(`${SUITE_PRE}; pre-condition 4 — a receipt held in EXCEPTION at US105 (awaiting completion)`, async () => {
      found = await findUnselectable(reconApi, 'AWAITING_COMPLETION');
      test.skip(!found.receipt?.grnNo, 'No receipt awaiting completion (held in EXCEPTION at US105) in the current or previous month on dev');
    });

    await step('Act: Step 1 — Open 입고 대사 (Receipt reconciliation)', async () => {
      await list.open();
    });

    await step('Assert: Expected 1 — The list opens', async () => {
      await expect(list.buildGroupButton, '[Expected 1] The list opens with the Build group button').toBeVisible();
    });

    await step(`Act: Step 2 — Click 대사 묶음 만들기 (Build group), pick partner ${found.receipt?.bizPartnerId}, period ${found.period}`, async () => {
      await list.openBuildGroup();
      await build.waitLoaded();
      await build.pick(found.receipt!.bizPartnerId, found.period);
      headers = (await build.receiptHeaders.allTextContents()).map((text) => text.trim());
      receivedCell = await build.receiptCell(build.receiptRow(found.receipt!.grnNo!), '입고일');
    });

    await step(`Assert: Expected 2 — ${found.receipt?.grnNo} is listed with 입고일 ${found.receipt?.receivedOn}, the awaiting reason replaces its checkbox; 창고 column present`, async () => {
      const row = build.receiptRow(found.receipt!.grnNo!);
      await expect.soft(row, `[Expected 2] ${found.receipt!.grnNo} is listed in 미대사 입고 전표`).toBeVisible();
      expect.soft(receivedCell, `[Expected 2] 입고일 (Received) = ${found.receipt!.receivedOn}`).toBe(found.receipt!.receivedOn);
      await expect.soft(build.checkCell(row), `[Expected 2] The checkbox is replaced by ${RR_TEXT.awaitingCompletion}`).toHaveText(RR_TEXT.awaitingCompletion);
      await expect.soft(row.getByRole('checkbox'), '[Expected 2] The receipt cannot be ticked — no checkbox').toHaveCount(0);
      expect(headers, '[Expected 2] 미대사 입고 전표 carries a 창고 (Warehouse) column').toContain('창고');
    });
  });

  test('TC_US020_134 — An Incoming with no goods receipt is listed as out of scope and its Receipt no. cell shows —', async ({ page, reconApi, reconListPage: list, reconBuildPage: build }) => {
    const step = makeStep(page);
    await tcMeta('TC_US020_134', 'Medium', TAGS, `After picking the partner and period, the Incoming with no goods receipt is listed with 입고 번호 "—", its checkbox replaced by ${RR_TEXT.noGoodsReceipt}, no error raised, and the table carries a 창고 column. Deviation from TC: INC-9001 / BP-0001 do not exist on dev — the test uses a real NO_GOODS_RECEIPT Incoming (API build-candidates without partner) and picks its partner. ${DATA_READ}`);
    let found: { period: string; receipt?: BuildReceipt } = { period: '' };
    const dialogs: string[] = [];
    let headers: string[] = [];

    await step(`${SUITE_PRE}; pre-condition 4 — a PURCHASE_ORDER Incoming with no goods receipt`, async () => {
      found = await findUnselectable(reconApi, 'NO_GOODS_RECEIPT');
      test.skip(!found.receipt, 'No Incoming without a goods receipt in the current or previous month on dev');
    });

    await step('Act: Step 1 — Open 입고 대사 (Receipt reconciliation)', async () => {
      await list.open();
    });

    await step('Assert: Expected 1 — The list opens', async () => {
      await expect(list.buildGroupButton, '[Expected 1] The list opens with the Build group button').toBeVisible();
    });

    await step(`Act: Step 2 — Click 대사 묶음 만들기 (Build group), pick partner ${found.receipt?.bizPartnerId}, period ${found.period}`, async () => {
      page.on('dialog', (dialog) => {
        dialogs.push(dialog.message());
        void dialog.dismiss();
      });
      await list.openBuildGroup();
      await build.waitLoaded();
      await build.pick(found.receipt!.bizPartnerId, found.period);
      headers = (await build.receiptHeaders.allTextContents()).map((text) => text.trim());
    });

    await step('Assert: Expected 2 — The Incoming is listed, 입고 번호 shows —, the out-of-scope reason replaces its checkbox, no error; 창고 column present', async () => {
      const row = build.receiptRowByReason(RR_TEXT.noGoodsReceipt).filter({ hasText: found.receipt!.receivedOn }).first();
      await expect.soft(row, `[Expected 2] The Incoming received ${found.receipt!.receivedOn} is listed`).toBeVisible();
      // Dòng không có thì 2 ý phụ thuộc dòng đã fail theo ý trên — không chờ thêm 15 s mỗi ý (vượt timeout test).
      if (await row.count()) {
        await expect.soft(build.checkCell(row), `[Expected 2] The checkbox is replaced by ${RR_TEXT.noGoodsReceipt}`).toHaveText(RR_TEXT.noGoodsReceipt);
        expect.soft(await build.receiptCell(row, '입고 번호'), '[Expected 2] 입고 번호 (Receipt no.) shows —').toBe('—');
      }
      expect.soft(dialogs, '[Expected 2] The screen raises NO error (no alert; the candidate request succeeded in pick())').toEqual([]);
      expect(headers, '[Expected 2] 미대사 입고 전표 carries a 창고 (Warehouse) column').toContain('창고');
    });
  });
});
