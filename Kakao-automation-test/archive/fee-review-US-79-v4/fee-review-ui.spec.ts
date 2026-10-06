import { test, expect } from '@fixtures/fee-review.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { isClipped } from '@utils/layout';
import { getAccountDisplayName } from '@utils/auth-token';
import { FR_EN, FR_KO, FR_TC } from '@utils/fee-review.i18n';
import { CYCLE, FIXTURE, RATE_MOVING, autoReason } from '@utils/fee-review.data';
import type { FeeReviewListPage } from '@pages/fee-review.page';

/**
 * US079 — nhóm [UI]: nhãn, cột, nút, banner và các dialog ở cả tiếng Hàn và tiếng Anh (`?lang=en`, không có nút đổi ngôn
 * ngữ trên màn). Assert theo TC (quyết định 29/09); chữ TC ghi = chữ bundle ở phần lớn chỗ. Dữ liệu: fixture T079 trong cycle
 * 2026-10 thay cho seed prototype của TC (Deviation chung — `@utils/fee-review.data`).
 */
const TAGS = ['ui', 'fee-review'];
const DEV = `Deviation: the TC's prototype seed does not exist on dev — the T079 fixture with the same scenario in cycle ${CYCLE.label} is used (see fee-review.data.ts).`;
/** Value của option 원장 cho Fee Rule — nhãn hiển thị 수수료 규칙 (KO) / Fee Rule (EN), verify DOM 01/10. */
const REGISTER = 'FEE_RULE';
/** Nhãn register hợp lệ duy nhất theo TC v4 (BR-19) — cùng 1 nhãn ở 2 ngôn ngữ; KHÔNG chấp nhận 수수료 산정 / Fee resolution. */
const FEE_RULE_TAG = /^\s*(수수료 규칙|Fee Rule)\s*$/;

const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Đọc toàn bộ chữ hiển thị của màn / dialog ở tiếng Anh để đối chiếu song ngữ. */
async function englishText(list: FeeReviewListPage, open: () => Promise<void>): Promise<string> {
  await list.open({ cycleId: CYCLE.id, bucket: 'ALL', lang: 'en' });
  await open();
  const text = await list.bodyText();
  await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
  return text;
}

test.describe('[UI] Settlement fee review — labels, columns and dialogs', () => {
  test.describe.configure({ timeout: 150_000 });

  test('TC_US079_07 — The list renders every label, column, button and banner in English and Korean', async ({ page, feeReviewApi, feeReviewState, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_07', 'Medium', TAGS, `Menu item, title and breadcrumb read 정산 수수료 확인·수정 under 정산 관리; cycle selector; the search-condition dropdown defaulting to 상품명 with 상품ID / 수수료 카테고리 / 계약 and the keyword placeholder; reset / search; the provisional banner; both chip groups with each chip under its caption; eight headers; the row actions (회수 only on a pending row); Submit selected above the table + the freshness label with its computing time; Changes this period, Export list and the pager below the table — each also read in English. ${DEV} Cycle ${CYCLE.label} (open) stands in for 2026-08. Deviation: the list on dev has no search-condition dropdown (keyword box only) — the dropdown, its default and options are soft assertions expected to fail. Deviation: Expected 4 is asserted as written in the TC ("이 정산 주기은 …"); the UI shows "이 정산 주기는 …" — likely TC typo, reported to BA. Data: a pending correction is created on ${FIXTURE.forSave} for the 회수 (Withdraw) action and withdrawn + discarded in teardown.`);
    let en = '';

    await step('Arrange: Pre-condition 1–2 — Write grant; an open cycle is selected, list unfiltered; one row has a pending correction', async () => {
      await feeReviewState.pending(feeReviewApi, FIXTURE.forSave, RATE_MOVING, autoReason('TC_US079_07', 'pending for the Withdraw action'));
      en = await englishText(list, async () => undefined);
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL', pageSize: '10' });
    });

    await step('Act: Step 1 — Read the menu item, the page title and the breadcrumb', async () => {
      await list.menuGroup.click();
    });

    await step('Assert: Expected 1 — Menu item 정산 수수료 확인·수정 under 정산 관리; title and breadcrumb read the same', async () => {
      await expect.soft(list.menuGroup, '[Expected 1] Menu group 정산 관리 (Settlement management)').toHaveText(new RegExp(`${esc(FR_KO['nav.group'])}|${esc(FR_EN['nav.group'])}`));
      await expect.soft(list.menuItem, '[Expected 1] Menu item 정산 수수료 확인·수정 (Settlement fee review) under 정산 관리').toHaveCount(1);
      await expect.soft(list.pageHeading, '[Expected 1] Page title reads 정산 수수료 확인·수정').toHaveText(FR_KO['page.cardTitle']);
      await expect.soft(list.breadcrumb, '[Expected 1] Breadcrumb reads 정산 수수료 확인·수정').toContainText(FR_KO['page.cardTitle']);
      await expect(list.pageTitle, '[Expected 1] The screen title 정산 수수료 확인·수정 is shown').toBeVisible();
      expect(en, '[Expected 1] English title Settlement fee review').toMatch(/Settlement fee review/i);
    });

    await step('Act: Step 2 — Read the cycle selector and the search-condition dropdown with its keyword box', async () => {
      await list.cycleSelect.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Cycle selector labelled; condition dropdown defaults to 상품명 with 상품ID / 수수료 카테고리 / 계약; placeholder 검색어를 입력하세요', async () => {
      await expect(list.cycleLabel, '[Expected 2] Cycle selector label 정산 주기').toBeVisible();
      await expect(list.cycleSelect, `[Expected 2] Cycle selector shows ${CYCLE.label}`).toHaveValue(String(CYCLE.id));
      // Dev 01/10 không có dropdown điều kiện tìm kiếm → đọc 1 lần (không chờ) rồi soft-assert từng option theo chữ TC.
      await expect.soft(list.searchConditionSelect, '[Expected 2] Search-condition dropdown exists').toHaveCount(1);
      const present = (await list.searchConditionSelect.count()) > 0;
      const options = present ? (await list.searchConditionSelect.locator('option').allTextContents()).map((t) => t.trim()) : [];
      const selected = present ? ((await list.searchConditionSelect.locator('option:checked').textContent()) ?? '').trim() : '';
      expect.soft(selected, '[Expected 2] Search-condition dropdown defaults to 상품명 (Product name)').toBe('상품명');
      for (const option of ['상품명', '상품ID', '수수료 카테고리', '계약']) {
        expect.soft(options, `[Expected 2] Search-condition option ${option}`).toContain(option);
      }
      await expect(list.keywordInput, '[Expected 2] Keyword placeholder 검색어를 입력하세요').toHaveAttribute('placeholder', FR_KO['filter.keywordPlaceholder']);
      expect(en, '[Expected 2] English placeholder / label').toContain(FR_EN['filter.cycle'].toUpperCase());
    });

    await step('Act: Step 3 — Read the reset and search controls', async () => {
      await list.resetButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — 초기화 and 검색 controls, no Korean / English gap', async () => {
      await expect(list.resetButton, '[Expected 3] 초기화 (Reset)').toBeVisible();
      await expect(list.searchButton, '[Expected 3] 검색 (Search)').toBeVisible();
      expect(en, '[Expected 3] English Reset / Search').toMatch(/Reset[\s\S]*Search/);
    });

    await step('Act: Step 4 — Read the provisional banner', async () => {
      await list.provisionalBanner.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — 잠정치입니다. with the provisional body', async () => {
      await expect(list.provisionalBanner, '[Expected 4] Title 잠정치입니다.').toContainText(FR_KO['bnr.provisionalTitle']);
      // Chữ TC "주기은" (UI: "주기는") — giữ theo TC, đã báo BA (likely TC typo).
      await expect.soft(list.provisionalBanner, '[Expected 4] Body as written in the TC').toContainText('이 정산 주기은 아직 마감되지 않았습니다. 요율은 마감 시점에 확정·스탬프되며, 그 전까지는 계약 수정·정정에 따라 다시 계산될 수 있습니다.');
      expect(en, '[Expected 4] English banner').toContain(FR_EN['bnr.provisionalTitle']);
    });

    await step('Act: Step 5 — Read the summary card and both chip groups', async () => {
      await list.partitionCaption.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 5 — Both captions, the six scope chips under the first and the four problem-type chips under the second', async () => {
      await expect(list.partitionCaption, '[Expected 5] Caption 범위 — 합계가 전체와 일치').toHaveText(FR_KO['strip.partition']);
      await expect(list.sliceCaption, '[Expected 5] Caption 유형별 — 위 항목과 중복됨 (합계 아님)').toHaveText(FR_KO['strip.slice']);
      const groups = [
        { group: list.partitionGroup, caption: FR_KO['strip.partition'], keys: ['bucket.ALL', 'bucket.EXC', 'bucket.NC', 'bucket.PROV', 'bucket.FIXED', 'bucket.OK'] as const },
        { group: list.sliceGroup, caption: FR_KO['strip.slice'], keys: ['bucket.NF', 'bucket.AMB', 'bucket.DIFF', 'bucket.SRCDIFF'] as const },
      ];
      for (const { group, caption, keys } of groups) {
        for (const key of keys) {
          await expect(list.chip(key), `[Expected 5] Chip ${FR_KO[key]}`).toBeVisible();
          await expect(group, `[Expected 5] Chip ${FR_KO[key]} sits under the caption ${caption}`).toContainText(FR_KO[key]);
          expect(en, `[Expected 5] English chip ${FR_EN[key]}`).toContain(FR_EN[key]);
        }
      }
    });

    await step('Act: Step 6 — Read the table column headers', async () => {
      await list.table.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 6 — Checkbox, 상품ID, 상품명, 산정된 수수료 카테고리, 산정 요율, 산정 상태, 지정 대조, 작업', async () => {
      await expect(list.headerCheckbox, '[Expected 6] Header checkbox').toBeVisible();
      const names = ['col.productId', 'col.productName', 'col.category', 'col.rate', 'col.status', 'col.compare', 'col.actions'] as const;
      for (const [i, key] of names.entries()) {
        await expect(list.headers.nth(i + 1), `[Expected 6] Column ${i + 2} is ${FR_KO[key]}`).toHaveText(FR_KO[key]);
        expect(en, `[Expected 6] English column ${FR_EN[key]}`).toContain(FR_EN[key]);
      }
    });

    await step("Act: Step 7 — Read one row's Actions cell", async () => {
      await list.row(FIXTURE.resolvedAnnex).scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 7 — 근거, 수정, then 회수 only while pending, then 이력', async () => {
      const idle = list.cell(list.row(FIXTURE.resolvedAnnex), 'actions');
      await expect(idle.getByRole('button'), '[Expected 7] Row without a pending correction: 근거 · 수정 · 이력 in this order, no 회수').toHaveText([FR_KO['btn.basis'], FR_KO['btn.correct'], FR_KO['btn.history']]);
      const pending = list.cell(list.row(FIXTURE.forSave), 'actions');
      await expect(pending.getByRole('button'), '[Expected 7] Row awaiting approval: 근거 · 수정 · 회수 · 이력 in this order').toHaveText([FR_KO['btn.basis'], FR_KO['btn.correct'], FR_KO['btn.withdraw'], FR_KO['btn.history']]);
    });

    await step('Act: Step 8 — Read Submit selected and the freshness label', async () => {
      await list.submitButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 8 — Submit selected above the table, disabled while nothing is selected; the freshness label states the computing time', async () => {
      await expect(list.submitButton, '[Expected 8] 선택 일괄 상신 is disabled').toBeDisabled();
      const [head, tail] = FR_KO['lbl.resolvedAtOpen'].split('{time}');
      await expect(list.resolvedAtLabel, '[Expected 8] The freshness label states when the figures were computed (산정 시각 {time} — …)').toHaveText(new RegExp(`^${esc(head)}\\S.*${esc(tail)}$`));
      const [submit, table] = [await list.submitButton.boundingBox(), await list.table.boundingBox()];
      expect((submit?.y ?? 0) < (table?.y ?? 0), '[Expected 8] Submit selected sits above the table').toBe(true);
    });

    await step('Act: Step 9 — Read Changes this period, Export list and the pagination bar', async () => {
      await list.reportButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 9 — Both buttons; pager below the table with total, navigation and 페이지당 10개 / 20개 / 50개 / 100개', async () => {
      await expect(list.reportButton, '[Expected 9] 이번 기 수정 내역').toBeVisible();
      await expect(list.exportButton, '[Expected 9] 목록 내보내기').toBeVisible();
      await expect(list.counter, '[Expected 9] Total count').toBeVisible();
      await expect(list.pagination, '[Expected 9] Page navigation').toBeVisible();
      const [table, pager] = [await list.table.boundingBox(), await list.pagination.boundingBox()];
      expect((pager?.y ?? 0) >= (table?.y ?? 0) + (table?.height ?? 0) - 1, '[Expected 9] The pagination bar sits below the table').toBe(true);
      expect((await list.pageSizeSelect.locator('option').allTextContents()).map((t) => t.trim()), '[Expected 9] Rows-per-page options').toEqual(['10개', '20개', '50개', '100개']);
      await expect(list.pageSizeSelect, '[Expected 9] Defaults to 10개').toHaveValue(/10/);
    });
  });

  test('TC_US079_08 — The summary card renders ten chips in two captioned groups kept visually apart', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_08', 'Medium', TAGS, `The first group (범위 — 합계가 전체와 일치) holds exactly 6 chips and the second (유형별 — 위 항목과 중복됨 (합계 아님)) exactly 4; the groups sit on separate rows; both captions also read in English. ${DEV} Data: read-only.`);
    let en = '';
    const chipsIn = (group: typeof list.partitionGroup) => group.getByRole('button', { name: /^(\d+|—) / });

    await step('Arrange: Pre-condition 1–2 — Write grant; an open cycle is selected', async () => {
      en = await englishText(list, async () => undefined);
    });

    await step("Act: Step 1 — Read the first group's caption and count its chips", async () => {
      await list.partitionCaption.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — 범위 — 합계가 전체와 일치 with exactly 6 chips', async () => {
      await expect(list.partitionCaption, '[Expected 1] First caption').toHaveText(FR_KO['strip.partition']);
      await expect(chipsIn(list.partitionGroup), '[Expected 1] Exactly 6 chips').toHaveCount(6);
      expect(en.toLowerCase(), '[Expected 1] English caption').toContain(FR_EN['strip.partition'].toLowerCase());
    });

    await step("Act: Step 2 — Read the second group's caption and count its chips", async () => {
      await list.sliceCaption.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — 유형별 — 위 항목과 중복됨 (합계 아님) with exactly 4 chips', async () => {
      await expect(list.sliceCaption, '[Expected 2] Second caption').toHaveText(FR_KO['strip.slice']);
      await expect(chipsIn(list.sliceGroup), '[Expected 2] Exactly 4 chips').toHaveCount(4);
      expect(en.toLowerCase(), '[Expected 2] English caption').toContain(FR_EN['strip.slice'].toLowerCase());
    });

    await step("Act: Step 3 — Compare the two groups' visual placement", async () => {
      await list.sliceGroup.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — The two groups are visually separated (distinct rows)', async () => {
      const [a, b] = [await list.partitionGroup.boundingBox(), await list.sliceGroup.boundingBox()];
      expect(a && b && (b.y >= a.y + a.height - 1 || b.x >= a.x + a.width - 1), '[Expected 3] Separate row / section per group').toBe(true);
    });
  });

  test('TC_US079_09 — The Why this rate dialog renders its winner, assignment, empty-rate and reasoning panels', async ({ page, feeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_09', 'Medium', TAGS, `On a mismatch product the dialog is titled 요율 산정 근거 with the rate in force, its contract and effective date on top; the 현재 지정된 행 panel shows commerce's assigned row and reads 불일치; the reasoning shows 도출된 키 (수수료 카테고리 / 판매유형 / 정책 / 계약 all filled), 검토된 수수료 행 with the winner marked and 우선순위 적용 단계 naming the deciding step. ${DEV} Fixture ${FIXTURE.mismatchWithDraft} (Mismatch) replaces 900318; the TC's concrete figures (2.25%, C-001 · NORMAL · 15.00% [INACTIVE]) are replaced by the register values read through the API; the assigned row is checked for the TC's shape (contract · policy · rate) and the inactive marker as soft assertions, since the fixture's assigned row is not guaranteed to be retired. The reasoning panels must stay hidden until 어떻게 결정됐는지 보기 is expanded. Data: read-only.`);
    let trace: Record<string, unknown> = {};

    await step('Arrange: Pre-condition 1–2 — A mismatch product is present in the open cycle', async () => {
      trace = (await feeReviewApi.trace(CYCLE.id, FIXTURE.mismatchWithDraft)).body;
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Click 근거 (Basis) on the mismatch product', async () => {
      await list.openBasis(list.row(FIXTURE.mismatchWithDraft));
    });

    await step('Assert: Expected 1 — Title 요율 산정 근거; rate in force, contract and effective date on top before any reasoning panel', async () => {
      await expect(list.basis.title, '[Expected 1] Title 요율 산정 근거').toHaveText(FR_KO['trace.title']);
      await expect(list.basis.root, `[Expected 1] Rate in force ${trace.inForceRate}%`).toContainText(`${trace.inForceRate}%`);
      await expect(list.basis.root, '[Expected 1] Contract of the rate').toContainText(String(trace.basisContractId));
      await expect(list.basis.root, '[Expected 1] Effective date').toContainText(String(trace.basisEffectiveFrom));
      for (const key of ['trace.keyTitle', 'trace.candTitle', 'trace.ladderTitle'] as const) {
        await expect(list.basis.section(key), `[Expected 1] Reasoning panel ${FR_KO[key]} is not shown before expanding`).toHaveCount(0);
      }
    });

    await step('Act: Step 2 — Read the dialog top-down, then expand 어떻게 결정됐는지 보기', async () => {
      await list.basis.expandEvidence();
    });

    await step('Assert: Expected 2 — 현재 지정된 행 shows the assigned row (contract · policy · rate [INACTIVE]) and reads 불일치', async () => {
      const assigned = list.basis.section('trace.assignedTitle');
      const assignedRow = list.basis.value(list.basis.root, FR_KO['trace.kvAssignedRow']);
      await expect(assigned, '[Expected 2] Currently assigned panel reads 불일치 (Mismatch)').toContainText(FR_KO['trace.flagDiff']);
      await expect(assignedRow, '[Expected 2] The assigned row is shown').not.toHaveText(/^\s*—?\s*$/);
      // TC: "C-001 · NORMAL · 15.00% [INACTIVE]" — fixture có hàng chỉ định riêng → kiểm dạng (hợp đồng · chính sách · rate) + dấu inactive.
      await expect.soft(assignedRow, '[Expected 2] The assigned row reads contract · policy · rate').toHaveText(/\S+\s*·\s*(NORMAL|PROMOTION)\s*·\s*\d+(\.\d+)?%/);
      await expect.soft(assignedRow, '[Expected 2] The assigned row carries the [INACTIVE] marker').toContainText(/INACTIVE|비활성/);
    });

    await step('Assert: Expected 3 — 도출된 키 fully filled; 검토된 수수료 행 with the winner marked; 우선순위 적용 단계 names the deciding step', async () => {
      const key = list.basis.section('trace.keyTitle');
      for (const label of [FR_KO['trace.kvCategory'], FR_KO['trace.kvSale'], FR_KO['trace.kvPolicy'], FR_KO['trace.kvContract']]) {
        await expect(list.basis.value(key, label), `[Expected 3] Derived key ${label} is filled in`).not.toHaveText(/^—?$/);
      }
      await expect(list.basis.section('trace.candTitle'), '[Expected 3] Rows considered marks the winner (적용)').toContainText(FR_KO['trace.candWin']);
      await expect(list.basis.section('trace.ladderTitle'), '[Expected 3] The deciding step is named (여기서 결정됨)').toContainText(FR_KO['trace.decidedHere']);
    });
  });

  test('TC_US079_10 — The Correct dialog renders both tiers, the delta panel, the reason counter and both buttons', async ({ page, feeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_10', 'Medium', TAGS, `On a resolved product with no correction: title 수수료 산정 수정 and the read-only 계약에서 산정된 값 panel; Tier 1 dropdown defaulting to — 변경 없음 —; the delta panel reading 아직 고른 것이 없습니다 before anything is picked; Tier 2 closed with its lock message; since Tier 2 is closed, the reason field carries the Tier 1 label 수정 사유 (필수) (v1.7: the label is conditional on tier — the Tier 2 wording is asserted in TC_US079_63) with 0 / 200; 취소 and a disabled 저장. Not automated: Expected 4 "placeholder 예: 4.50% visible if opened" — Tier 2 cannot be opened on a product a contract row still prices; the placeholder is asserted in TC_US079_63 where Tier 2 is open. ${DEV} Fixture ${FIXTURE.forSave} replaces 900412; a retired / withdrawn earlier correction counts as "no correction in force". Data: nothing is saved (the dialog is cancelled).`);
    let en = '';
    let row: Awaited<ReturnType<typeof feeReviewApi.row>>;

    await step('Arrange: Pre-condition 1–2 — A resolved product with no correction in force', async () => {
      row = await feeReviewApi.row(CYCLE.id, FIXTURE.forSave);
      // Correction đã RETIRED / WITHDRAWN không còn hiệu lực — fixture dùng chung giữ lại dấu vết cũ (run 30/09).
      expect(row.correction?.state ?? 'NONE', 'Pre-condition: no correction in force on the product').toMatch(/^(NONE|RETIRED|WITHDRAWN)$/);
      en = await englishText(list, () => list.openCorrect(list.row(FIXTURE.forSave)));
    });

    await step('Act: Step 1 — Open 수정 (Correct); read the title and 계약에서 산정된 값', async () => {
      await list.openCorrect(list.row(FIXTURE.forSave));
    });

    await step('Assert: Expected 1 — Title 수수료 산정 수정; the contract panel shows category, rate and status as plain text', async () => {
      await expect(list.correct.title, '[Expected 1] Title 수수료 산정 수정').toHaveText(FR_KO['fix.title']);
      await expect(list.correct.contractValue('fix.kvCategory'), '[Expected 1] Fee category').toHaveText(row.inForceCategory ?? '');
      await expect(list.correct.contractValue('fix.kvRate'), '[Expected 1] Rate').toHaveText(`${row.inForceRate}%`);
      await expect(list.correct.contractValue('fix.kvStatus'), '[Expected 1] Status').toHaveText(FR_KO['status.RESOLVED']);
      await expect(list.correct.fromContract.locator('input, select, textarea'), '[Expected 1] Not editable fields').toHaveCount(0);
      expect(en, '[Expected 1] English title').toContain(FR_EN['fix.title']);
    });

    await step('Act: Step 2 — Read the 1단계 (Tier 1) dropdown', async () => {
      await list.correct.tier1Select.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — 1단계 — 수수료 카테고리 변경 defaulting to — 변경 없음 —', async () => {
      await expect(list.correct.tier1Label, '[Expected 2] Tier 1 label').toHaveText(FR_KO['fix.tier1Label']);
      await expect(list.correct.tier1Select.locator('option:checked'), '[Expected 2] Defaults to — 변경 없음 —').toHaveText(FR_KO['fix.noChange']);
      expect(en, '[Expected 2] English Tier 1 label').toContain(FR_EN['fix.tier1Label']);
    });

    await step('Act: Step 3 — Read the delta panel below it', async () => {
      await list.correct.deltaHead.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — The delta panel reads 아직 고른 것이 없습니다, no rule code', async () => {
      await expect(list.correct.deltaHead, '[Expected 3] 아직 고른 것이 없습니다 (Nothing picked yet)').toHaveText(FR_KO['fix.deltaNoneHead']);
      await expect(list.correct.deltaPanel, '[Expected 3] No rule code').not.toContainText(/BR-|STL-|OQ-/);
    });

    await step('Act: Step 4 — Read the 2단계 (Tier 2) field in its closed state', async () => {
      await list.correct.tier2Label.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — 2단계 — 요율 직접 입력 closed with the lock message (placeholder 예: 4.50% only when opened)', async () => {
      await expect(list.correct.tier2Label, '[Expected 4] Tier 2 label').toHaveText(FR_KO['fix.tier2Label']);
      await expect(list.correct.tier2Lock, '[Expected 4] Lock message').toHaveText(FR_KO['fix.tier2Lock']);
      await expect(list.correct.tier2Input, '[Expected 4] Tier 2 input stays closed').toHaveCount(0);
      // Not automated: placeholder 예: 4.50% chỉ hiện khi Tier 2 mở — không mở được trên sản phẩm này (xem TC_US079_63).
    });

    await step('Act: Step 5 — Read the reason field', async () => {
      await list.correct.reasonInput.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 5 — Tier 2 closed, so the Tier 1 reason label 수정 사유 (필수), empty textarea, counter 0 / 200', async () => {
      await expect(list.correct.reasonLabel, '[Expected 5] Reason label is the Tier 1 wording 수정 사유 (필수)').toHaveText(FR_KO['fix.reasonLabel']);
      await expect(list.correct.reasonLabel, '[Expected 5] Not the Tier 2 wording 수수료 산정 근거 (필수)').not.toHaveText(FR_KO['fix.reasonLabelT2']);
      await expect(list.correct.reasonInput, '[Expected 5] Empty textarea').toHaveValue('');
      await expect(list.correct.counter, '[Expected 5] Counter 0 / 200').toHaveText('0 / 200');
    });

    await step('Act: Step 6 — Read the footer buttons', async () => {
      await list.correct.saveButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 6 — 취소 and a disabled 저장', async () => {
      await expect(list.correct.cancelButton, '[Expected 6] 취소 (Cancel)').toBeVisible();
      await expect(list.correct.saveButton, '[Expected 6] 저장 (Save) disabled until something changes').toBeDisabled();
      await list.correct.cancel();
    });
  });

  test('TC_US079_11 — The change history dialog renders the five fixed columns and its footer', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_11', 'Medium', TAGS, `On a product with history the dialog reads 변경 이력 with the product name and ID, five columns 시점 / 수행자 / 항목 / 변경 내용 / 사유 and the footer "승인된 기안만…"; also in English. ${DEV} Fixture ${FIXTURE.approvedTwoPolicies} (two approved corrections) replaces 880021. Data: read-only.`);
    let en = '';

    await step('Arrange: Pre-condition 1–2 — A product with at least one history entry', async () => {
      en = await englishText(list, () => list.openHistory(list.row(FIXTURE.approvedTwoPolicies)));
    });

    await step('Act: Step 1 — Click 이력 (History) and read the dialog title', async () => {
      await list.openHistory(list.row(FIXTURE.approvedTwoPolicies));
    });

    await step('Assert: Expected 1 — 변경 이력 with the product name and ID', async () => {
      await expect(list.history.title, '[Expected 1] Title 변경 이력').toHaveText(FR_KO['hist.title']);
      await expect(list.history.productLine, '[Expected 1] Product name and ID').toContainText(FIXTURE.approvedTwoPolicies);
      expect(en, '[Expected 1] English title').toContain(FR_EN['hist.title']);
    });

    await step('Act: Step 2 — Read the column headers', async () => {
      await list.history.headers.first().scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — 시점, 수행자, 항목, 변경 내용, 사유 in order', async () => {
      const texts = (await list.history.headers.allTextContents()).map((t) => t.trim()).filter(Boolean);
      expect(texts, '[Expected 2] Five columns in order').toEqual([FR_KO['hist.colWhen'], FR_KO['hist.colWho'], FR_KO['hist.colSetting'], FR_KO['hist.colChange'], FR_KO['hist.colReason']]);
      for (const key of ['hist.colWhen', 'hist.colWho', 'hist.colSetting', 'hist.colChange', 'hist.colReason'] as const) expect(en, `[Expected 2] English ${FR_EN[key]}`).toContain(FR_EN[key]);
    });

    await step('Act: Step 3 — Read the footer note', async () => {
      await list.history.footer.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — The footer note about approved requests', async () => {
      await expect(list.history.footer, '[Expected 3] Footer note').toHaveText(FR_KO['hist.footer']);
      expect(en, '[Expected 3] English footer').toContain(FR_EN['hist.footer']);
      await list.history.close();
    });
  });

  test('TC_US079_12 — The withdraw confirmation states what withdrawing causes and carries no reason field', async ({ page, feeReviewApi, feeReviewState, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_12', 'Medium', TAGS, `As the submitter of a pending correction: 승인 요청 회수 with the product name (read from the API at run time), the body "승인 대기에서 내리고…", no reason field, 취소 and 회수. ${DEV} A pending correction is created on ${FIXTURE.forSave} (replaces 880021) through the API. Data: the pending correction is withdrawn and discarded in teardown; the dialog itself is cancelled.`);
    let productName = '';

    await step('Arrange: Pre-condition 1–2 — A correction awaiting approval, submitted by the logged-in account', async () => {
      await feeReviewState.pending(feeReviewApi, FIXTURE.forSave, RATE_MOVING, autoReason('TC_US079_12', 'pending for the withdraw dialog'));
      productName = (await feeReviewApi.row(CYCLE.id, FIXTURE.forSave)).productName ?? '';
      expect(productName, 'Pre-condition: the product carries a name').not.toBe('');
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
    });

    await step('Act: Step 1 — Click 회수 (Withdraw) and read the dialog title', async () => {
      await list.openWithdraw(list.row(FIXTURE.forSave));
    });

    await step('Assert: Expected 1 — 승인 요청 회수 with the product name', async () => {
      await expect(list.withdraw.title, '[Expected 1] Title 승인 요청 회수').toHaveText(FR_KO['withdraw.title']);
      await expect(list.withdraw.productLine, `[Expected 1] The product name ${productName} is shown`).toContainText(productName);
      await expect(list.withdraw.root, '[Expected 1] The product ID is shown').toContainText(FIXTURE.forSave);
    });

    await step('Act: Step 2 — Read the body text', async () => {
      await list.withdraw.body.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — The body explains what withdrawing causes', async () => {
      await expect(list.withdraw.body, '[Expected 2] Body text').toContainText(FR_KO['withdraw.body']);
    });

    await step('Act: Step 3 — Check for a reason field', async () => {
      await list.withdraw.root.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — No reason field anywhere in the dialog', async () => {
      await expect(list.withdraw.reasonField, '[Expected 3] No reason field').toHaveCount(0);
    });

    await step('Act: Step 4 — Read the footer buttons', async () => {
      await list.withdraw.confirmButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — 취소 and 회수', async () => {
      await expect(list.withdraw.cancelButton, '[Expected 4] 취소 (Cancel)').toBeVisible();
      await expect(list.withdraw.confirmButton, '[Expected 4] 회수 (Withdraw)').toBeVisible();
      await list.withdraw.cancelButton.click();
    });
  });

  test('TC_US079_13 — The Changes this period dialog renders its eight columns and a working pagination bar', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_13', 'Medium', TAGS, `The dialog reads 이번 기 수정 내역 with its intro line, eight columns 상품ID / 수정 내용 / 요율 변동 / 단계 / 승인 / 수행자 / 시점 / 사유 and a pager (total, page navigation, rows-per-page defaulting to 10개) whose changes apply immediately; also in English. ${DEV} The cycle's own corrections stand in for the three seeded ones; moving between pages is exercised only when the report spans more than one page at 20개. Data: read-only.`);
    let en = '';
    const pager = { defaultSize: '', total: 0, shown: 0, pageMoved: false, secondPageRange: '' };
    const pagination = () => list.report.root.locator('ul.pagination');
    const counterRange = async () => /중 (\d+-\d+)개/.exec((await list.report.counter.textContent()) ?? '')?.[1] ?? '';

    await step('Arrange: Pre-condition 1–2 — The cycle holds corrections', async () => {
      en = await englishText(list, () => list.openReport());
    });

    await step('Act: Step 1 — Click 이번 기 수정 내역 (Changes this period)', async () => {
      await list.openReport();
    });

    await step('Assert: Expected 1 — Title and intro line', async () => {
      await expect(list.report.title, '[Expected 1] Title 이번 기 수정 내역').toHaveText(FR_KO['report.title']);
      await expect(list.report.intro, '[Expected 1] Intro line').toHaveText(FR_KO['report.intro']);
      expect(en, '[Expected 1] English title').toContain(FR_EN['report.title']);
      expect(en, '[Expected 1] English intro').toContain(FR_EN['report.intro']);
    });

    await step('Act: Step 2 — Change the rows-per-page and move between pages if more than one exists', async () => {
      // Ghi nhận mặc định TRƯỚC khi đổi (Expected 3 assert sau bước này).
      pager.defaultSize = ((await list.report.pageSizeSelect.locator('option:checked').textContent()) ?? '').trim();
      pager.total = Number(/총 (\d+)개/.exec((await list.report.counter.textContent()) ?? '')?.[1] ?? 0);
      await list.report.pageSizeSelect.selectOption({ label: '20개' });
      pager.shown = Math.min(pager.total, 20);
      await expect(list.report.counter, 'The counter follows the new page size').toHaveText(new RegExp(`중 ${pager.total ? 1 : 0}-${pager.shown}개`));
      if (pager.total > 20) {
        await pagination().getByRole('button', { name: '2', exact: true }).click();
        pager.pageMoved = true;
        await expect(list.report.counter, 'The counter moves to page 2').toHaveText(new RegExp(`중 21-${Math.min(pager.total, 40)}개`));
        pager.secondPageRange = await counterRange();
      }
    });

    await step('Assert: Expected 2 — The table shows the eight columns in order', async () => {
      await expect(list.report.headers.filter({ hasText: FR_KO['report.colProductId'] }), 'The report table re-rendered').toBeVisible();
      const texts = (await list.report.headers.allTextContents()).map((t) => t.trim()).filter(Boolean);
      expect(texts, '[Expected 2] Eight columns in order').toEqual(['report.colProductId', 'report.colChange', 'report.colRate', 'report.colTier', 'report.colApproval', 'report.colWho', 'report.colWhen', 'report.colReason'].map((k) => FR_KO[k as keyof typeof FR_KO]));
    });

    await step('Assert: Expected 3 — The pager shows the total, navigation and 10개 by default; changes apply immediately', async () => {
      await expect(list.report.counter, '[Expected 3] Total count shown').toBeVisible();
      expect(pager.defaultSize, '[Expected 3] Rows-per-page defaults to 10개').toBe('10개');
      await expect(pagination(), '[Expected 3] Page navigation shown').toBeVisible();
      await expect(list.report.pageSizeSelect, '[Expected 3] The new page size is selected without a confirm step').toHaveValue(/20/);
      if (!pager.pageMoved) {
        await expect(list.report.rows, `[Expected 3] The table shows ${pager.shown} row(s) right after the page-size change`).toHaveCount(pager.shown);
        test.info().annotations.push({ type: 'Not exercised', description: `Expected 3: page navigation — the report has ${pager.total} correction(s), a single page at 20개` });
      } else {
        expect(pager.secondPageRange, '[Expected 3] Moving to page 2 applies immediately').toBe(`21-${Math.min(pager.total, 40)}`);
      }
      await expect(list.report.root.getByRole('button', { name: /^(확인|OK|적용|Apply)$/ }), '[Expected 3] No confirm step for the pager').toHaveCount(0);
      await list.report.close();
    });
  });

  test('TC_US079_14 — The export dialog renders the scope block, both format options and the file name', async ({ page, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_14', 'Medium', TAGS, `With the default 확인 필요 chip: 내보내기 with 내보낼 범위 (period, filter, row count); Excel (.xlsx) selected by default with its note and CSV (.csv) with its note; 파일명 carrying the cycle and a date stamp; 취소 and 내려받기; also in English. ${DEV} Data: nothing is downloaded (the dialog is cancelled).`);
    let en = '';

    await step('Arrange: Pre-condition 1–2 — The open cycle with the 확인 필요 (Needs review) chip active', async () => {
      await list.open({ cycleId: CYCLE.id, lang: 'en' });
      await list.openExport();
      en = await page.locator('body').innerText();
      await list.open({ cycleId: CYCLE.id });
    });

    await step('Act: Step 1 — Click 목록 내보내기 and read the title and the scope block', async () => {
      await list.openExport();
    });

    await step('Assert: Expected 1 — 내보내기; 내보낼 범위 with the period, the active filter and the row count', async () => {
      await expect(list.exporter.title, '[Expected 1] Title 내보내기').toHaveText(FR_KO['export.title']);
      await expect(list.exporter.scope, '[Expected 1] Scope block 내보낼 범위 (What will be exported)').toContainText(FR_KO['export.scopeTitle']);
      await expect(list.exporter.scopeValue('export.period'), '[Expected 1] Period').toHaveText(CYCLE.label);
      await expect(list.exporter.scopeValue('export.filter'), '[Expected 1] Active filter 확인 필요').toHaveText(FR_KO['bucket.EXC']);
      await expect(list.exporter.scopeValue('export.rows'), '[Expected 1] Row count').toHaveText(/^\d+$/);
    });

    await step('Act: Step 2 — Read both format options and their notes', async () => {
      await list.exporter.radios.first().scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — Excel (.xlsx) selected by default with its note; CSV (.csv) with its note', async () => {
      await expect(list.exporter.root.getByText('Excel (.xlsx)', { exact: true }), '[Expected 2] Excel option').toBeVisible();
      await expect(list.exporter.root.getByText(FR_KO['export.xlsxDesc']), '[Expected 2] Excel note').toBeVisible();
      await expect(list.exporter.radios.nth(0), '[Expected 2] Excel selected by default').toBeChecked();
      await expect(list.exporter.root.getByText('CSV (.csv)', { exact: true }), '[Expected 2] CSV option').toBeVisible();
      await expect(list.exporter.root.getByText(FR_KO['export.csvDesc']), '[Expected 2] CSV note').toBeVisible();
      expect(en, '[Expected 2] English Excel note').toContain(FR_EN['export.xlsxDesc']);
      expect(en, '[Expected 2] English CSV note').toContain(FR_EN['export.csvDesc']);
    });

    await step('Act: Step 3 — Read the file name', async () => {
      await list.exporter.fileName.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — 파일명 shows a name carrying the cycle and a date stamp', async () => {
      await expect(list.exporter.root.getByText(FR_KO['export.fileName'], { exact: true }), '[Expected 3] Label 파일명 (File name)').toBeVisible();
      await expect(list.exporter.fileName, '[Expected 3] Cycle and date stamp').toHaveText(new RegExp(`${CYCLE.label}_\\d{8}\\.xlsx$`));
      expect(en, '[Expected 3] English label File name').toContain(FR_EN['export.fileName']);
    });

    await step('Act: Step 4 — Read the footer buttons', async () => {
      await list.exporter.downloadButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — 취소 and 내려받기', async () => {
      await expect(list.exporter.cancelButton, '[Expected 4] 취소').toBeVisible();
      await expect(list.exporter.downloadButton, '[Expected 4] 내려받기').toHaveText(FR_KO['export.download']);
      expect(en, '[Expected 4] English Download').toContain(FR_EN['export.download']);
      await list.exporter.cancelButton.click();
    });
  });

  test('TC_US079_15 — The approval queue renders the owner banner, a Fee Rule record with live data, the Impact pair and the rejection reason field', async ({ page, feeReviewApi, feeReviewState, approvalQueuePage: queue }) => {
    const step = makeStep(page);
    const reason = autoReason('TC_US079_15', 'pending for the queue layout');
    await tcMeta('TC_US079_15', 'Medium', TAGS, `The 변경 승인 queue carries a banner at the top naming US120 as its owner and stating that Fee Rule records flow through it; the pending correction is listed tagged Fee Rule (수수료 규칙 in Korean) — the only valid register tag (BR-19), 수수료 산정 / Fee resolution is not accepted; the detail shows 대상 / 기안자 / 변경 전 / 변경 후 / 영향 범위 / 사유 (Target / Maker / Current value / Requested value / Impact / Reason); the Impact element says "${FR_TC.impactNotComputableEn}" in words while US008 cannot be read and never shows a bare number; the Reject reason field has the placeholder "기안자가 무엇을 고쳐야 하는지 적어주세요", is required and has a 200-character counter. The Reject dialog's own title is not asserted (not defined by the SRS). ${DEV} Deviation: dev 01/10 labels the detail 대상 레코드 / 직전 승인 값 / 제안 값 / 영향 미리보기 / 사유 (기안자) and shows the impact as "아직 산출할 수 없음" — the TC labels and the English wording are asserted as written, so those assertions are expected to fail until the build follows the TC; the US120 banner is also absent on dev. Pre-condition 1 ("the queue's own grant") is covered by the submitter account, which can open the queue. A pending correction is created on ${FIXTURE.forSave}. Data: withdrawn and discarded in teardown; the Reject dialog is cancelled.`);
    let approvalId = 0;
    const bareNumber = /^[\d,]+(건)?$/;

    await step('Arrange: Pre-condition 1–2 — A correction awaiting approval', async () => {
      approvalId = (await feeReviewState.pending(feeReviewApi, FIXTURE.forSave, RATE_MOVING, reason)).approval.id;
    });

    await step('Act: Step 1 — Open 변경 승인 (Change Approval)', async () => {
      await queue.open();
    });

    await step('Assert: Expected 1 — A banner at the top names US120 as the owner and states Fee Rule records flow through it', async () => {
      const banner = page.getByText(/US120/).first();
      await expect.soft(banner, '[Expected 1] The owner banner names US120').toBeVisible({ timeout: 5_000 });
      await expect.soft(banner, '[Expected 1] The banner states Fee Rule records now flow through this screen').toContainText(/Fee Rule|수수료 규칙/, { timeout: 5_000 });
      await expect.soft(banner, '[Expected 1] The banner sits at the top of the screen (in view on open)').toBeInViewport({ timeout: 5_000 });
      if (await banner.count()) {
        const [b, q] = [await banner.boundingBox(), await queue.queueItems.first().boundingBox()];
        expect.soft((b?.y ?? Infinity) < (q?.y ?? 0), '[Expected 1] The banner sits above the queue list').toBe(true);
      }
    });

    await step('Act: Step 2 — Locate the record in the queue and open its detail panel', async () => {
      await queue.openRequest({ register: REGISTER, requester: getAccountDisplayName('submitter'), changeApprovalId: approvalId, reason });
    });

    await step('Assert: Expected 2 — The queue lists the record tagged Fee Rule (the only valid register tag)', async () => {
      await expect(queue.queueItems.filter({ hasText: getAccountDisplayName('submitter') }).first(), '[Expected 2] The queue lists the record').toBeVisible();
      await expect(queue.panelValue('원장'), '[Expected 2] Tagged Fee Rule (수수료 규칙) — 수수료 산정 / Fee resolution not accepted').toHaveText(FEE_RULE_TAG);
      await expect.soft(queue.panelValue('대상 레코드').or(queue.panelValue('대상')).first(), `[Expected 2] The record is the product ${FIXTURE.forSave}`).toContainText(FIXTURE.forSave, { timeout: 5_000 });
    });

    await step('Assert: Expected 3 — The detail shows 대상 / 기안자 / 변경 전 / 변경 후 / 영향 범위 / 사유; Impact says "not yet computable" in words, never a bare number', async () => {
      const labels: Array<[string, string]> = [['대상', 'Target'], ['기안자', 'Maker'], [FR_TC.queueCurrentValue, 'Current value'], [FR_TC.queueRequestedValue, 'Requested value'], ['사유', 'Reason']];
      for (const [label, gloss] of labels) {
        await expect.soft(queue.panelValue(label), `[Expected 3] ${label} (${gloss}) is shown`).toBeVisible({ timeout: 5_000 });
      }
      await expect.soft(queue.impactRangeHeading, `[Expected 3] ${FR_TC.queueImpact} (Impact) is shown`).toBeVisible({ timeout: 5_000 });
      await expect(queue.impactAnySection, '[Expected 3] The Impact element is shown').toBeVisible();
      const impact = (await queue.impactAnySection.innerText()).replace(/영향 범위|영향 미리보기/, '').trim();
      const numbers = impact.split(/\s+/).filter((token) => bareNumber.test(token));
      expect.soft(numbers, `[Expected 3] Impact never shows a bare number (read: "${impact}")`).toEqual([]);
      expect.soft(impact.toLowerCase(), `[Expected 3] Impact says "${FR_TC.impactNotComputableEn}" in words`).toContain(FR_TC.impactNotComputableEn);
    });

    await step('Act: Step 3 — Click 반려 (Reject) to view the reason dialog without confirming', async () => {
      await queue.openRejectDialog();
    });

    await step('Assert: Expected 4 — Reject reason field: placeholder 기안자가 무엇을 고쳐야 하는지 적어주세요, required, 200-character counter', async () => {
      // Tiêu đề dialog không được SRS định nghĩa → TC v4: không assert chữ tiêu đề.
      await expect.soft(queue.rejectReasonInput, '[Expected 4] Placeholder 기안자가 무엇을 고쳐야 하는지 적어주세요').toHaveAttribute('placeholder', '기안자가 무엇을 고쳐야 하는지 적어주세요');
      const required = await queue.rejectReasonInput.evaluate((el) => (el as HTMLTextAreaElement).required || el.getAttribute('aria-required') === 'true');
      const blocked = await queue.rejectDialogConfirmButton.isDisabled();
      expect.soft(required || blocked, '[Expected 4] The reason is required (required attribute, or confirm blocked while empty)').toBe(true);
      await expect.soft(queue.rejectDialog.getByText(/\/ 200$/), '[Expected 4] 200-character counter').toBeVisible();
      await queue.rejectDialog.getByRole('button', { name: /취소|Cancel/ }).click();
    });
  });

  test('TC_US079_16 — A long category name clips with a tooltip, rate / ID / status never clip, and a 200-character reason is accepted', async ({ page, feeReviewApi, feeReviewPage: list }) => {
    const step = makeStep(page);
    const en200 = 'Reclassifying this product because the commerce assignment still points at a retired fee row and the review flagged the mismatch. '.repeat(3).slice(0, 200);
    const ko200 = '제품군 오매핑을 교정합니다. 커머스 지정이 이미 종료된 수수료 행을 계속 가리키고 있어 검토 과정에서 불일치가 확인되었습니다. '.repeat(4).slice(0, 200);
    await tcMeta('TC_US079_16', 'Medium', TAGS, `Rate, product ID and status cells never clip; English and Korean 200-character reasons are accepted with the counter reading 200 / 200 (Korean counts characters). Not automated: step 1 — no product on dev carries a category name long enough to clip, not even one reachable via 수정 (the longest is "MD - 입점사 제작"); the clip + tooltip behaviour is still checked on the product-name column, which does clip — the TC's "..." is the ellipsis character "…" the UI renders, and the full value is read from the API at run time. ${DEV} Data: nothing is saved (the dialog is cancelled).`);
    const clipped: string[] = [];
    let fullName = '';

    await step('Arrange: Pre-condition 1–2 — Products listed; 200-character reasons prepared', async () => {
      fullName = (await feeReviewApi.row(CYCLE.id, FIXTURE.resolvedAnnex)).productName ?? '';
      expect(fullName, 'Pre-condition: the product carries a name').not.toBe('');
      await list.open({ cycleId: CYCLE.id, bucket: 'ALL' });
      expect([en200.length, [...ko200].length], 'Both reasons are exactly 200 characters').toEqual([200, 200]);
    });

    await step('Act: Step 1 — Locate the long name and hover the clipped cell', async () => {
      await list.cell(list.row(FIXTURE.resolvedAnnex), 'productName').locator('span').hover();
      test.info().annotations.push({ type: 'Not automated', description: 'Step 1: no category name on dev is long enough to clip — checked on the product-name column instead' });
    });

    await step('Assert: Expected 1 — The long text is clipped with … and the tooltip shows the full value', async () => {
      await expect(list.cell(list.row(FIXTURE.resolvedAnnex), 'productName'), '[Expected 1] Clipped with …').toHaveText(/…$/);
      await expect(list.tooltip, `[Expected 1] Tooltip carries the full value ${fullName}`).toHaveText(fullName);
    });

    await step('Act: Step 2 — Read the rate, product ID and status cells', async () => {
      for (const id of await list.productIds()) {
        const row = list.row(id);
        for (const col of ['productId', 'rate', 'status'] as const) if (await isClipped(list.cell(row, col))) clipped.push(`${id}:${col}`);
      }
    });

    await step('Assert: Expected 2 — Rate, product ID and status are never clipped', async () => {
      expect(clipped, '[Expected 2] No rate / ID / status cell is clipped').toEqual([]);
    });

    await step('Act: Step 3 — Open 수정 and type a 200-character English reason', async () => {
      await list.openCorrect(list.row(FIXTURE.forSave));
      await list.correct.reasonInput.fill(en200);
    });

    await step('Assert: Expected 3 — Accepted; the counter reads 200 / 200', async () => {
      await expect(list.correct.reasonInput, '[Expected 3] All 200 characters kept').toHaveValue(en200);
      await expect(list.correct.counter, '[Expected 3] 200 / 200').toHaveText('200 / 200');
    });

    await step('Act: Step 4 — Clear it and type a 200-character Korean reason', async () => {
      await list.correct.reasonInput.fill(ko200);
    });

    await step('Assert: Expected 4 — Accepted; the counter reads 200 / 200 (characters, not bytes)', async () => {
      await expect(list.correct.reasonInput, '[Expected 4] All 200 characters kept').toHaveValue(ko200);
      await expect(list.correct.counter, '[Expected 4] 200 / 200').toHaveText('200 / 200');
      await list.correct.cancel();
    });
  });
});
