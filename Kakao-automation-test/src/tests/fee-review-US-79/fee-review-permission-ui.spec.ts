import type { Locator, Page } from '@playwright/test';
import type { RowDataPacket } from 'mysql2/promise';
import { test, expect } from '@fixtures/fee-review-v1.fixture';
import { makeStep } from '@utils/step';
import { skipTc, tcMeta } from '@utils/tc-meta';
import { Observations } from '@utils/observations';
import { hasHorizontalPageScroll, isClipped, isInsideContainerWidth, isWithinViewport, isWithinViewportWidth, scrollsInside } from '@utils/layout';
import { getAccountDisplayName, hasCredentials, AccountRole } from '@utils/auth-token';
import { FR_EN, FR_KO, FrKey } from '@utils/fee-review.i18n';
import { family, product, reasonOf } from '@utils/fee-review-v1.data';
import { feeReviewDb } from '@utils/fee-review-db';
import type { CategoryKey, Seeded } from '@utils/fee-review-seed';
import type { FeeReviewApi } from '@api/fee-review.api';
import type { FeeReviewListPage } from '@pages/fee-review.page';
import { AppShell, ChangeApprovalExtras, FeeReviewUiExtras } from '@pages/fee-review-v1/permission-ui.page';

/**
 * US079 v1 — nhóm g1: [Permission] TC_01–06, [UI] TC_07–17, [Responsive] TC_173–174 (`input/TESTCASE_US079_v1.md`).
 * Dữ liệu: SeedSpec dựng đúng pre-condition của từng TC qua `seedData` (API + MySQL, tự dọn theo tiền tố sản phẩm).
 * Correction / submit / reject của pre-condition làm qua API trong bước Arrange. Tiếng Anh: màn không có nút đổi ngôn ngữ →
 * mở phiên thứ 2 cùng account với `?lang=en` (như archive v4) và kiểm lại từng phần tử ở mỗi bước.
 */
const TAGS = {
  permission: ['permission', 'fee-review'],
  ui: ['ui', 'fee-review'],
  responsive: ['responsive', 'fee-review'],
};
const DATA_NOTE =
  'Deviation: the pre-condition data is seeded through seedData (API + MySQL) — the cycle is the next free month ≥ 2100 (its label is read at run time) instead of <Y>-03/<Y>-06, contract families and CY_MAIN may be shared with other TCs of the same run unless the TC reads cycle-wide state, and correction reasons carry the traceable [AUTO-US079] prefix. Data: products, corrections, change approvals and targets are deleted in teardown; contracts and cycles stay (no delete API).';
const LANG_NOTE =
  'Deviation: the screen has no language toggle — the EN pass runs on a second session of the same account opened with ?lang=en.';
const NO_READ_ACCOUNT =
  'Both configured test accounts (TOKEN_A = submitter, TOKEN_B = approver) hold the write grant; no read-grant-only account (TOKEN_R) is available on dev, and the build hard-wires the FE permission to write until SETTLEMENT_FEE_REVIEW is issued (DEV-02).';

type Dict = Record<FrKey, string>;
interface View {
  lang: 'KO' | 'EN';
  page: Page;
  list: FeeReviewListPage;
  t: Dict;
  x: FeeReviewUiExtras;
}
type OpenSession = (role: AccountRole) => Promise<{ page: Page; list: FeeReviewListPage }>;

function viewOf(lang: 'KO' | 'EN', page: Page, list: FeeReviewListPage): View {
  return { lang, page, list, t: lang === 'KO' ? FR_KO : FR_EN, x: new FeeReviewUiExtras(page) };
}

/** Phiên thứ 2 của account submitter ở tiếng Anh (`?lang=en`). */
async function englishView(open: OpenSession, options: { cycleId: number; bucket?: 'ALL' | 'EXC' | 'FIXED'; pageSize?: '10' | '20' | '100' }): Promise<View> {
  const session = await open('submitter');
  await session.list.open({ ...options, lang: 'en' });
  return viewOf('EN', session.page, session.list);
}

const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** "산정 시각 {time} — …" → regex khớp mọi giá trị thời gian. */
const resolvedAtPattern = (t: Dict) => {
  const [head, tail] = t['lbl.resolvedAtOpen'].split('{time}');
  return new RegExp(`^${esc(head)}\\S.*${esc(tail)}$`);
};
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};

/** Lưu nháp correction của pre-condition qua API (Tier 1 theo category, hoặc Tier 2 theo rate) — trả correctionId. */
async function saveDraft(api: FeeReviewApi, seeded: Seeded, code: string, body: { category?: CategoryKey; rate?: string; reason: string }): Promise<string> {
  const cycleId = seeded.cycles.CY_MAIN.id;
  const productId = seeded.products[code];
  let request: Parameters<FeeReviewApi['save']>[2];
  if (body.category) {
    const categoryId = seeded.master.category[body.category];
    const route = (await api.options(cycleId, productId)).categories.find((c) => c.categoryId === categoryId)?.route;
    request = { policy: 'NORMAL', tier: 'ASSIGNMENT', commissionCategoryId: categoryId, reason: body.reason, previewRoute: route };
  } else {
    request = { policy: 'NORMAL', tier: 'RATE_OVERRIDE', overrideRate: body.rate, reason: body.reason };
  }
  const { status, body: saved } = await api.save(cycleId, productId, request);
  const correctionId = saved?.correctionId ?? (await api.row(cycleId, productId)).correction?.correctionId;
  if (status >= 300 || !correctionId) throw new Error(`Pre-condition: saving the draft on ${productId} → HTTP ${status}`);
  return correctionId;
}

/** Trình duyệt correction → PENDING; trả id bản ghi 변경 승인 (target_ref = <cycle>/<product>/NORMAL). */
async function submitDraft(api: FeeReviewApi, seeded: Seeded, code: string, correctionId: string): Promise<number> {
  const { status } = await api.submit([correctionId]);
  if (status >= 300) throw new Error(`Pre-condition: submitting ${correctionId} → HTTP ${status}`);
  const targetRef = targetRefOf(seeded, code);
  const rows = await feeReviewDb.query<RowDataPacket[]>("SELECT id FROM change_approval WHERE target_type = 'FEE_RULE' AND target_ref = ? ORDER BY id DESC LIMIT 1", [targetRef]);
  const id = Number(rows[0]?.id);
  if (!id) throw new Error(`Pre-condition: no FEE_RULE change approval for ${targetRef}`);
  return id;
}

function targetRefOf(seeded: Seeded, code: string): string {
  return `${seeded.cycles.CY_MAIN.id}/${seeded.products[code]}/NORMAL`;
}

type RowExpect = { status?: string; rate?: string | null; verdict?: string; state?: string | null };

/** Bước "Verify" của pre-condition: số dòng theo tiền tố TC + trạng thái từng sản phẩm. */
async function verifySeed(api: FeeReviewApi, seeded: Seeded, pre: number, total: number, expected: Record<string, RowExpect>): Promise<void> {
  const page = await api.products(seeded.cycles.CY_MAIN.id, { keyword: seeded.prefix, size: 100 });
  expect(page.totalElements, `Pre-condition ${pre}: ${total} rows carry the prefix ${seeded.prefix}`).toBe(total);
  for (const [code, e] of Object.entries(expected)) {
    const row = page.content.find((r) => r.productId === seeded.products[code] && r.policy === 'NORMAL');
    expect(row, `Pre-condition ${pre}: row ${code} is listed`).toBeTruthy();
    if (e.status) expect(row?.status, `Pre-condition ${pre}: ${code} status`).toContain(e.status);
    if (e.rate !== undefined) expect(row?.inForceRate ?? null, `Pre-condition ${pre}: ${code} in-force rate`).toBe(e.rate);
    if (e.verdict) expect(row?.verdict, `Pre-condition ${pre}: ${code} verdict`).toBe(e.verdict);
    if (e.state !== undefined) expect(row?.correction?.state ?? null, `Pre-condition ${pre}: ${code} correction state`).toBe(e.state);
  }
}

/** Mở màn qua sidebar: bấm mục 정산 수수료 확인·수정 nếu có; build chưa có mục này → mở theo URL để các bước sau vẫn chạy. */
async function openFromMenu(list: FeeReviewListPage, cycleId: number, pageSize: '10' | '100' = '100'): Promise<void> {
  if (await list.menuItem.isVisible()) {
    await list.untilListed(() => list.menuItem.click());
    if (pageSize !== '10') await list.setPageSize(pageSize);
  } else {
    await list.open({ cycleId, pageSize });
  }
}

/** Chữ hiển thị của màn (bỏ khung app — header, sidebar, footer — và dialog đang mở). */
async function screenText(page: Page): Promise<string> {
  return page.evaluate(() => {
    let text = document.body.innerText;
    for (const node of Array.from(document.querySelectorAll<HTMLElement>('aside, header, footer, [role="banner"], [role="contentinfo"], [role="complementary"], .modal'))) {
      if (node.innerText) text = text.replace(node.innerText, ' ');
    }
    return text;
  });
}

/**
 * Mã nội bộ cấm hiện trên màn (BR-UI-4.V1): mã rule / câu hỏi (tiền tố HOA-số), mã story (US + số), tên bảng / cột
 * (snake_case), giá trị enum thô. Cho phép giá trị master hiển thị đúng như TC_08 kỳ vọng (FULL_CONSIGNMENT / PURCHASE
 * ở 판매유형, NORMAL / PROMOTION ở 정책) và "UTF-8" (tên chuẩn mã hoá trong ghi chú CSV).
 */
const CODE_PATTERNS: Array<[string, RegExp]> = [
  ['rule or question code', /\b[A-Z]{1,5}(?:-[A-Z]{1,5})*-\d+(?:\.[A-Z]*\d+)*\b/g],
  ['story code', /\bUS-?\d{2,}\b/g],
  ['table or column name', /\b[a-z]+(?:_[a-z0-9]+)+\b/g],
  ['raw enum value', /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g],
  ['raw state value', /\b(?:PENDING|DRAFT|APPLIED|APPROVED|REJECTED|RETIRED|WITHDRAWN|RESOLVED|AMBIGUOUS|MISMATCH|MATCHES)\b/g],
];
const ALLOWED_TOKENS = new Set(['FULL_CONSIGNMENT', 'UTF-8']);

function codesIn(text: string): string[] {
  return CODE_PATTERNS.flatMap(([kind, re]) => (text.match(re) ?? []).filter((token) => !ALLOWED_TOKENS.has(token)).map((token) => `${kind}: ${token}`));
}

/** Đo "chữ thuần": không phải ô nhập, không khung viền, không nền xám, không nhận focus / con trỏ soạn thảo. */
async function plainText(locator: Locator): Promise<{ input: boolean; framed: boolean; filled: boolean; focusable: boolean; editable: boolean }> {
  return locator.evaluate((el) => {
    const s = getComputedStyle(el);
    const framed = ['top', 'right', 'bottom', 'left'].some((side) => parseFloat(s.getPropertyValue(`border-${side}-width`)) > 0 && s.getPropertyValue(`border-${side}-style`) !== 'none');
    const bg = s.backgroundColor.replace(/\s/g, '');
    const filled = !['rgba(0,0,0,0)', 'transparent', 'rgb(255,255,255)'].includes(bg);
    return {
      input: el.matches('input, textarea, select') || !!el.querySelector('input, textarea, select'),
      framed,
      filled,
      focusable: (el as HTMLElement).tabIndex >= 0,
      editable: (el as HTMLElement).isContentEditable,
    };
  });
}

/** Phần tử đang giữ focus có nằm trong `locator` không. */
async function holdsFocus(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => !!document.activeElement && el.contains(document.activeElement) && document.activeElement !== document.body);
}

/** Bấm vào phần tử rồi Tab — trả về phần tử có nhận focus trong quá trình đó không. */
async function takesFocus(locator: Locator, page: Page): Promise<boolean> {
  await locator.click();
  const afterClick = await holdsFocus(locator);
  await page.keyboard.press('Tab');
  return afterClick || (await holdsFocus(locator));
}

/** Đưa phần tử vào tầm nhìn rồi kiểm hiển thị + nằm trọn bề ngang viewport ("reachable"). */
async function reachable(locator: Locator, page: Page): Promise<boolean> {
  await locator.scrollIntoViewIfNeeded({ timeout: 5_000 });
  return (await locator.isVisible()) && (await isWithinViewportWidth(locator, page));
}

/** Màu nền tối (backdrop) tại 1 điểm của viewport, ngoài sidebar. */
async function darkAt(page: Page, x: number, y: number): Promise<boolean> {
  return page.evaluate(
    ([px, py]) => {
      const el = document.elementFromPoint(px, py);
      if (!el || el.closest('aside')) return false;
      const m = getComputedStyle(el).backgroundColor.match(/rgba?\(([^)]+)\)/);
      if (!m) return false;
      const [r, g, b, a = 1] = m[1].split(',').map((v) => parseFloat(v));
      return a > 0 && (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.4;
    },
    [x, y] as const,
  );
}

async function fontSize(locator: Locator): Promise<number> {
  return locator.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
}

async function horizontalPadding(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const s = getComputedStyle(el);
    const first = el.firstElementChild ? getComputedStyle(el.firstElementChild) : undefined;
    return parseFloat(s.paddingLeft) + parseFloat(s.paddingRight) + (first ? parseFloat(first.paddingLeft) + parseFloat(first.paddingRight) : 0);
  });
}

test.describe('[Permission] Settlement fee review — grants and decision controls', () => {
  test.describe.configure({ timeout: 300_000 });

  test('TC_US079_01 — A write-grant user opens the screen and sees every correction control', async ({ page, feeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_01', 'High', TAGS.permission, `User A (write grant) reaches 정산 수수료 확인·수정 from 정산 관리, sees the 2 rows of the cycle on one page, 근거 · 수정 · 이력 on a clean row (수정 enabled), 근거 · 수정 · 회수 · 이력 on the pending row with 수정 disabled and the pending tooltip, the selection checkbox column + select-all and a disabled 선택 일괄 상신, and an editable Correct dialog. ${DATA_NOTE} Private cycle (Expected 3 counts every row of the cycle). Deviation: when the sidebar has no 정산 수수료 확인·수정 entry (Expected 1 fails) the screen is opened by URL so the remaining steps still run.`);
    let seeded!: Seeded;
    let cycle!: Seeded['cycles'][string];

    await step('Arrange: Pre-condition 1–16 — ROOT (R_A, R_B10) + ANNEX1 (R_B9), cycle CY_MAIN with P03 and P14; COR_X on P14 submitted (PENDING); screen open on CY_MAIN', async () => {
      seeded = await seedData({
        tc: 1,
        private: true,
        contracts: family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9'] }),
        cycles: ['CY_MAIN'],
        products: [product('P03', [{ cycle: 'CY_MAIN', saleLines: 77 }]), product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])],
      });
      cycle = seeded.cycles.CY_MAIN;
      const corX = await saveDraft(feeReviewApi, seeded, 'P14', { category: 'B', reason: reasonOf('TC_US079_01', 'Wrong category mapped in commerce') });
      await submitDraft(feeReviewApi, seeded, 'P14', corX);
      await verifySeed(feeReviewApi, seeded, 13, 2, { P03: { status: 'RESOLVED', rate: '9.00', verdict: 'MISMATCH', state: null }, P14: { status: 'RESOLVED', rate: '12.50', verdict: 'MATCHES', state: 'PENDING' } });
      await list.open({ cycleId: cycle.id });
    });

    await step('Act: Step 1 — In the sidebar click 정산 관리 (Settlement management)', async () => {
      await list.menuGroup.click();
    });

    await step('Assert: Expected 1 — The menu group expands and shows the entry 정산 수수료 확인·수정 (Settlement fee review)', async () => {
      await expect.soft(list.menuItem, '[Expected 1] The 정산 관리 group shows the entry 정산 수수료 확인·수정 (Settlement fee review)').toBeVisible();
    });

    await step('Act: Step 2 — Click 정산 수수료 확인·수정 (Settlement fee review)', async () => {
      await openFromMenu(list, cycle.id);
    });

    await step('Assert: Expected 2 — The screen 정산 수수료 확인·수정 (Settlement fee review) opens', async () => {
      await expect(list.pageTitle, '[Expected 2] The screen 정산 수수료 확인·수정 (Settlement fee review) is open').toHaveText(FR_KO['page.cardTitle']);
    });

    await step(`Act: Step 3 — Select 정산 주기 = ${cycle.label} (CY_MAIN), click bucket 기간 내 판매 상품 and set 페이지당 = 20`, async () => {
      await list.selectCycle(cycle.label);
      await list.clickChip(list.chip('bucket.ALL'));
      await list.setPageSize('20');
    });

    await step('Assert: Expected 3 — The list shows the 2 rows of the cycle on one page: P03 and P14', async () => {
      await expect(list.cycleSelect.locator('option:checked'), `[Expected 3] Cycle ${cycle.label} is selected`).toHaveText(cycle.label);
      await expect(list.rows, '[Expected 3] Exactly 2 rows are listed on the page').toHaveCount(2);
      await expect(list.row(seeded.products.P03), '[Expected 3] Row P03 is listed').toBeVisible();
      await expect(list.row(seeded.products.P14), '[Expected 3] Row P14 is listed').toBeVisible();
      await expect(list.pagination.getByRole('button', { name: '2', exact: true }), '[Expected 3] There is no second page').toHaveCount(0);
    });

    await step('Act: Step 4 — Look at the 작업 (Actions) cell of row P03', async () => {
      await list.cell(list.row(seeded.products.P03), 'actions').scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — 근거 (Basis) · 수정 (Correct) · 이력 (History) in this order; 수정 (Correct) is enabled', async () => {
      const row = list.row(seeded.products.P03);
      const x = new FeeReviewUiExtras(page);
      await expect(x.actionButtons(list.cell(row, 'actions')), '[Expected 4] Buttons 근거 · 수정 · 이력 in this order').toHaveText([FR_KO['btn.basis'], FR_KO['btn.correct'], FR_KO['btn.history']]);
      await expect(list.rowButton(row, 'btn.correct'), '[Expected 4] 수정 (Correct) is enabled').toBeEnabled();
    });

    await step('Act: Step 5 — Look at the 작업 (Actions) cell of row P14', async () => {
      await list.cell(list.row(seeded.products.P14), 'actions').scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 5 — 근거 · 수정 · 회수 · 이력 in this order; 수정 disabled with the awaiting-approval tooltip', async () => {
      const row = list.row(seeded.products.P14);
      const x = new FeeReviewUiExtras(page);
      await expect(x.actionButtons(list.cell(row, 'actions')), '[Expected 5] Buttons 근거 · 수정 · 회수 · 이력 in this order').toHaveText([FR_KO['btn.basis'], FR_KO['btn.correct'], FR_KO['btn.withdraw'], FR_KO['btn.history']]);
      await expect(list.rowButton(row, 'btn.correct'), '[Expected 5] 수정 (Correct) is disabled').toBeDisabled();
      await expect(list.correctWrapper(row), '[Expected 5] Tooltip 승인 대기 중입니다 — 먼저 회수한 뒤에 수정하세요.').toHaveAttribute('title', FR_KO['msg.correctDisabledPending']);
    });

    await step('Act: Step 6 — Look at the table header and the toolbar above the table', async () => {
      await list.submitButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 6 — Selection checkbox column with a select-all checkbox; 선택 일괄 상신 rendered and disabled', async () => {
      await expect(list.headerCheckbox, '[Expected 6] The header carries the select-all checkbox').toBeVisible();
      for (const code of ['P03', 'P14']) {
        await expect(list.rowCheckbox(list.row(seeded.products[code])), `[Expected 6] Row ${code} has a selection checkbox`).toBeVisible();
      }
      await expect(list.submitButton, '[Expected 6] 선택 일괄 상신 (Submit selected) is rendered').toBeVisible();
      await expect(list.submitButton, '[Expected 6] 선택 일괄 상신 is disabled while no row is selected').toBeDisabled();
    });

    await step('Act: Step 7 — Click 수정 (Correct) on row P03', async () => {
      await list.openCorrect(list.row(seeded.products.P03));
    });

    await step('Assert: Expected 7 — 수수료 산정 수정 opens with an editable Tier 1 select and a 저장 (Save) button', async () => {
      await expect(list.correct.title, '[Expected 7] Dialog 수수료 산정 수정 (Correct fee resolution)').toHaveText(FR_KO['fix.title']);
      await expect(list.correct.tier1Label, '[Expected 7] Label 1단계 — 수수료 카테고리 변경').toBeVisible();
      await expect(list.correct.tier1Select, '[Expected 7] The Tier 1 select is editable').toBeEnabled();
      await expect(list.correct.saveButton, '[Expected 7] 저장 (Save) button is rendered').toBeVisible();
      await list.correct.cancel();
    });
  });

  test('TC_US079_02 — A read-grant user sees the list, reason panel, history and change report without correction controls', async () => {
    await skipTc('TC_US079_02', 'High', TAGS.permission, 'A read-grant user sees the list, the Why this rate panel, the change history, the period report and the export dialog, with no selection column, no 선택 일괄 상신 and no 수정 / 회수 on any row.', NO_READ_ACCOUNT);
  });

  test('TC_US079_03 — A read-grant user is refused when saving, submitting or withdrawing through the API', async () => {
    await skipTc('TC_US079_03', 'High', TAGS.permission, 'With TOKEN_R the save, submit and withdraw calls return HTTP 403 and leave COR_Y (DRAFT) and COR_X (PENDING) untouched in fee_correction.', `${NO_READ_ACCOUNT} The build's write gate is a stub that always allows, so the 403 is not producible until the code is issued.`);
  });

  test('TC_US079_04 — A user without the screen permission sees no menu entry and cannot open the screen by URL', async () => {
    await skipTc('TC_US079_04', 'High', TAGS.permission, 'User N (no SETTLEMENT_FEE_REVIEW) sees no 정산 수수료 확인·수정 entry, cannot open the screen by URL, and gets HTTP 403 on the products and trace endpoints.', 'No account without the SETTLEMENT_FEE_REVIEW permission (TOKEN_N) is available on dev — both configured accounts can open the screen (DEV-02 interim: any authenticated admin).');
  });

  test('TC_US079_05 — Only the submitter sees Withdraw and another writer is refused', async ({ page, feeReviewApi, approverFeeReviewApi, seedData, secondSession, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_05', 'High', TAGS.permission, `User A sees 회수 between 수정 and 이력 on the pending P14 row; user B (approver, another writer) sees the row 승인 대기 with 근거, a disabled 수정 and 이력 but no 회수; B's withdraw call is refused with HTTP 403 STL-1013 and the correction stays PENDING, submitted by A, linked to CA1. ${DATA_NOTE} Deviation: "log out / log in as user B" is a second browser session of user B (logging out revokes the Okta refresh token). Deviation: submitted_by is compared with the value stored at submission (Arrange) — its format (login / id) is not given by the TC. Expected FAIL (build note): the FE renders 회수 on every pending row, so user B sees it.`);
    test.skip(!hasCredentials('approver'), 'The approver account (TOKEN_B, APPROVER_*) is not configured in .env');
    let seeded!: Seeded;
    let corX = '';
    let ca1 = 0;
    let submittedBy = '';
    let b!: { page: Page; list: FeeReviewListPage };
    let withdrawCall: { status: number; body: unknown } = { status: 0, body: null };
    let dbAfter: RowDataPacket | undefined;

    await step('Arrange: Pre-condition 1–15 — ROOT (R_A) + ANNEX1 (R_B9), P14 in CY_MAIN; COR_X submitted by user A (PENDING, CA1)', async () => {
      seeded = await seedData({ tc: 5, contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      corX = await saveDraft(feeReviewApi, seeded, 'P14', { category: 'B', reason: reasonOf('TC_US079_05', 'Wrong category mapped in commerce') });
      ca1 = await submitDraft(feeReviewApi, seeded, 'P14', corX);
      await verifySeed(feeReviewApi, seeded, 13, 1, { P14: { state: 'PENDING' } });
      const [row] = await feeReviewDb.query<RowDataPacket[]>('SELECT state, submitted_by, change_approval_id FROM fee_correction WHERE id = ?', [corX]);
      expect(row?.state, 'Pre-condition 13: COR_X is PENDING').toBe('PENDING');
      expect(Number(row?.change_approval_id), 'Pre-condition 13: COR_X links to CA1').toBe(ca1);
      submittedBy = String(row?.submitted_by ?? '');
    });

    await step('Act: Step 1 — As user A open the screen, select CY_MAIN and click bucket 이번 기 수정됨 (Corrected this period)', async () => {
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id });
      await list.clickChip(list.chip('bucket.FIXED'));
    });

    await step('Assert: Expected 1 — Row P14 is listed with the second pill 승인 대기 (Awaiting approval)', async () => {
      const row = list.row(seeded.products.P14);
      await expect(row, '[Expected 1] Row P14 is listed under 이번 기 수정됨').toBeVisible();
      await expect(list.statusPills(row).nth(1), '[Expected 1] Second pill 승인 대기 (Awaiting approval)').toHaveText(FR_KO['state.PENDING']);
    });

    await step('Act: Step 2 — Look at the 작업 (Actions) cell of row P14', async () => {
      await list.cell(list.row(seeded.products.P14), 'actions').scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — 회수 (Withdraw) is shown between 수정 (Correct) and 이력 (History)', async () => {
      const x = new FeeReviewUiExtras(page);
      await expect(x.actionButtons(list.cell(list.row(seeded.products.P14), 'actions')), '[Expected 2] 근거 · 수정 · 회수 · 이력 — 회수 sits between 수정 and 이력').toHaveText([FR_KO['btn.basis'], FR_KO['btn.correct'], FR_KO['btn.withdraw'], FR_KO['btn.history']]);
    });

    await step('Act: Step 3 — Log in as user B and open the same screen, cycle CY_MAIN and bucket 이번 기 수정됨', async () => {
      b = await secondSession('approver');
      await b.list.open({ cycleId: seeded.cycles.CY_MAIN.id });
      await b.list.clickChip(b.list.chip('bucket.FIXED'));
    });

    await step('Assert: Expected 3 — Row P14 is listed with 승인 대기 (Awaiting approval)', async () => {
      const row = b.list.row(seeded.products.P14);
      await expect(row, '[Expected 3] User B sees row P14').toBeVisible();
      await expect(b.list.statusPills(row).nth(1), '[Expected 3] 승인 대기 (Awaiting approval)').toHaveText(FR_KO['state.PENDING']);
    });

    await step('Act: Step 4 — As user B look at the 작업 (Actions) cell of row P14', async () => {
      await b.list.cell(b.list.row(seeded.products.P14), 'actions').scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — 회수 is not rendered; 근거, 수정 (disabled) and 이력 are shown', async () => {
      const row = b.list.row(seeded.products.P14);
      await expect.soft(b.list.rowButton(row, 'btn.withdraw'), '[Expected 4] 회수 (Withdraw) is not rendered for user B').toHaveCount(0);
      await expect(b.list.rowButton(row, 'btn.basis'), '[Expected 4] 근거 (Basis) is shown').toBeVisible();
      await expect(b.list.rowButton(row, 'btn.correct'), '[Expected 4] 수정 (Correct) is shown').toBeVisible();
      await expect(b.list.rowButton(row, 'btn.correct'), '[Expected 4] 수정 (Correct) is disabled').toBeDisabled();
      await expect(b.list.rowButton(row, 'btn.history'), '[Expected 4] 이력 (History) is shown').toBeVisible();
    });

    await step('Act: Step 5 — With the token of user B call POST /fee-review/corrections/COR_X/withdraw', async () => {
      withdrawCall = await approverFeeReviewApi.withdraw(corX);
    });

    await step('Assert: Expected 5 — HTTP 403 with STL-1013: 이 수정 건은 상신한 담당자만 회수할 수 있습니다.', async () => {
      const body = JSON.stringify(withdrawCall.body);
      expect(withdrawCall.status, '[Expected 5] The withdraw call by user B is refused with HTTP 403').toBe(403);
      expect(body, '[Expected 5] The error code is STL-1013').toContain('STL-1013');
      expect.soft(body, '[Expected 5] The message reads 이 수정 건은 상신한 담당자만 회수할 수 있습니다. (Only the person who submitted this correction can withdraw it.)').toMatch(new RegExp(`${esc(FR_KO['errCode.notSubmitter'])}|${esc(FR_EN['errCode.notSubmitter'])}`));
    });

    await step('Act: Step 6 — As user B reload the screen and look at row P14; read COR_X from fee_correction', async () => {
      await b.list.untilListed(() => b.page.reload().then(() => undefined));
      [dbAfter] = await feeReviewDb.query<RowDataPacket[]>('SELECT state, submitted_by, change_approval_id FROM fee_correction WHERE id = ?', [corX]);
    });

    await step('Assert: Expected 6 — The row still shows 승인 대기; DB: PENDING, submitted by user A, change_approval_id = CA1', async () => {
      await expect(b.list.statusPills(b.list.row(seeded.products.P14)).nth(1), '[Expected 6] The row still shows 승인 대기 (Awaiting approval)').toHaveText(FR_KO['state.PENDING']);
      expect(dbAfter?.state, '[Expected 6] DB state = PENDING').toBe('PENDING');
      expect(String(dbAfter?.submitted_by ?? ''), '[Expected 6] DB submitted_by is still user A').toBe(submittedBy);
      expect(Number(dbAfter?.change_approval_id), '[Expected 6] DB change_approval_id = CA1').toBe(ca1);
    });
  });

  test('TC_US079_06 — Approve and reject exist only on Change Approval; submit and withdraw only on the fee review screen', async ({ page, feeReviewApi, seedData, secondSession, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_06', 'High', TAGS.permission, `On the fee review screen no row, toolbar, Why this rate or Change history dialog carries 승인 / 반려; 회수 and 선택 일괄 상신 are there. On 변경 승인 user B opens the 수수료 규칙 (Fee Rule) record of P14 and sees 승인 and 반려… but no 상신, 선택 일괄 상신 or 회수. ${DATA_NOTE} Private cycle (Expected 1 counts the rows). Deviation: 변경 승인 is opened by URL — on dev the entry sits under (NEW)FPT › 계약 / 프로젝트 / 수수료, not under 정산 관리 (recon 01/10); the queue is filtered to 원장 = 수수료 규칙 to find the record.`);
    test.skip(!hasCredentials('approver'), 'The approver account (TOKEN_B, APPROVER_*) is not configured in .env');
    const x = new FeeReviewUiExtras(page);
    const obs = new Observations(page);
    let seeded!: Seeded;
    let ca1 = 0;
    let reason = '';
    let b!: { page: Page; queue: import('@pages/change-approval-queue.page').ChangeApprovalQueuePage };
    let cax!: ChangeApprovalExtras;

    await step('Arrange: Pre-condition 1–15 — ROOT (R_A) + ANNEX1 (R_B9), P14 in CY_MAIN; COR_X submitted by user A (PENDING, CA1)', async () => {
      seeded = await seedData({ tc: 6, private: true, contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      reason = reasonOf('TC_US079_06', 'Wrong category mapped in commerce');
      ca1 = await submitDraft(feeReviewApi, seeded, 'P14', await saveDraft(feeReviewApi, seeded, 'P14', { category: 'B', reason }));
      const [record] = await feeReviewDb.query<RowDataPacket[]>('SELECT target_type, target_ref, approval_status FROM change_approval WHERE id = ?', [ca1]);
      expect([record?.target_type, record?.target_ref, record?.approval_status], 'Pre-condition 13: CA1 = FEE_RULE / <cycle>/P14/NORMAL / PENDING').toEqual(['FEE_RULE', targetRefOf(seeded, 'P14'), 'PENDING']);
      await verifySeed(feeReviewApi, seeded, 13, 1, { P14: { state: 'PENDING' } });
    });

    await step('Act: Step 1 — As user A open the screen, select CY_MAIN, click 기간 내 판매 상품 and set 페이지당 = 20', async () => {
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id });
      await list.clickChip(list.chip('bucket.ALL'));
      await list.setPageSize('20');
    });

    await step('Assert: Expected 1 — The fee review list opens with 1 row (P14)', async () => {
      await expect(list.rows, '[Expected 1] Exactly 1 row is listed').toHaveCount(1);
      await expect(list.row(seeded.products.P14), '[Expected 1] The row is P14').toBeVisible();
    });

    await step('Act: Step 2 — Look at the 작업 (Actions) cell of every row and at the toolbar', async () => {
      await list.submitButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — No 승인 / 반려 on any row or the toolbar; 회수 on P14 and 선택 일괄 상신 in the toolbar', async () => {
      await expect(x.decisionButtons(list.table), '[Expected 2] No 승인 (Approve) or 반려 (Reject) control on any row').toHaveCount(0);
      await expect(x.decisionButtons(page.locator('body')), '[Expected 2] No 승인 (Approve) or 반려 (Reject) control in the toolbar').toHaveCount(0);
      await expect(list.rowButton(list.row(seeded.products.P14), 'btn.withdraw'), '[Expected 2] 회수 (Withdraw) is shown on P14').toBeVisible();
      await expect(list.submitButton, '[Expected 2] 선택 일괄 상신 (Submit selected) is shown in the toolbar').toBeVisible();
    });

    await step('Act: Step 3 — Open 근거 (Basis) on P14 and close it, then open 이력 (History) and close it', async () => {
      await list.openBasis(list.row(seeded.products.P14));
      await obs.record('Why this rate has no Approve / Reject control', async () => (await x.decisionButtons(list.basis.root).count()) === 0);
      await obs.screenshot('Why this rate dialog of P14');
      await list.basis.close();
      await list.openHistory(list.row(seeded.products.P14));
      await obs.record('Change history has no Approve / Reject control', async () => (await x.decisionButtons(list.history.root).count()) === 0);
      await list.history.close();
    });

    await step('Assert: Expected 3 — Neither 요율 산정 근거 nor 변경 이력 has an Approve or Reject control', async () => {
      obs.assertAll();
    });

    await step('Act: Step 4 — Log in as user B and open 변경 승인 (Change Approval)', async () => {
      const session = await secondSession('approver');
      b = { page: session.page, queue: session.queue };
      cax = new ChangeApprovalExtras(b.page);
      await b.queue.open();
      await b.queue.showRegister('FEE_RULE');
    });

    await step('Assert: Expected 4 — 변경 승인 opens with the record in 승인 대기 목록 (Approval Queue)', async () => {
      await expect(cax.heading, '[Expected 4] The screen 변경 승인 (Change Approval) opens').toBeVisible();
      await expect(cax.queueCaption, '[Expected 4] 승인 대기 목록 (Approval Queue) is shown').toBeVisible();
      await expect(cax.entry(b.queue.queueItems, targetRefOf(seeded, 'P14')), '[Expected 4] The P14 record is in the queue').toBeVisible();
    });

    await step('Act: Step 5 — Select the 수수료 규칙 (Fee Rule) record of P14', async () => {
      await b.queue.openRequest({ register: 'FEE_RULE', requester: getAccountDisplayName('submitter'), changeApprovalId: ca1, reason });
    });

    await step('Assert: Expected 5 — The record detail opens with 원장 (Register) = 수수료 규칙 (Fee Rule)', async () => {
      await expect(b.queue.panelValue('원장'), '[Expected 5] 원장 (Register) = 수수료 규칙 (Fee Rule)').toHaveText('수수료 규칙');
    });

    await step('Act: Step 6 — Look at the decision area and the whole screen', async () => {
      await b.queue.rejectButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 6 — 승인 and 반려… are shown; no 상신, 선택 일괄 상신 or 회수 control on the screen', async () => {
      await expect(b.queue.approveButton, '[Expected 6] 승인 (Approve) is shown').toBeVisible();
      await expect(b.queue.rejectButton, '[Expected 6] 반려… (Reject…) is shown').toBeVisible();
      await expect(x.submitControls(b.page.locator('body')), '[Expected 6] No 상신 / 선택 일괄 상신 / 회수 control on 변경 승인').toHaveCount(0);
    });
  });
});

test.describe('[UI] Settlement fee review — labels, columns and dialogs in KO and EN', () => {
  test.describe.configure({ timeout: 600_000 });

  test('TC_US079_07 — The fee review list renders every label, column and button in EN and KO', async ({ page, feeReviewApi, seedData, secondSession, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_07', 'Medium', TAGS.ui, `Menu, title, search area, provisional banner, both chip groups with their counts (13 · 8 selected · 0 · 0 · 0 · 5 / 5 · 1 · 8 · 0), the eight columns, the P03 / P04 / P06 cells, the P03 actions, the toolbar, the pager (total 8, 10 per page) and the Export list tooltip — each checked in KO and again in EN. ${DATA_NOTE} ${LANG_NOTE} Private cycle (bucket counts). Expected FAIL (build notes): no 검색 조건 (Search condition) select on the list; the sidebar group 정산 관리 has no 정산 수수료 확인·수정 entry on dev (the screen is then opened by URL). UNVERIFIED: the Export list tooltip source (react-bootstrap tooltip or title attribute).`);
    const shell = new AppShell(page);
    let seeded!: Seeded;
    let cycle!: Seeded['cycles'][string];
    let views: View[] = [];
    const tips: Record<'KO' | 'EN', string> = { KO: '', EN: '' };

    await step('Arrange: Pre-condition 1–15 — Full family (ROOT R_A/R_B10/R_PROMO/R_E11, ANNEX1 R_B9/R_C20, ANNEX2 R_C22), 13 targets in CY_MAIN (P99 target only), no correction; screen open in KO', async () => {
      seeded = await seedData({
        tc: 7,
        private: true,
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
      cycle = seeded.cycles.CY_MAIN;
      // P99: chỉ có dòng target, không có dòng sản phẩm (pre-condition 9–10) — dọn cùng tiền tố ở teardown.
      await feeReviewDb.insertTargets([{ cycleId: cycle.id, productId: `${seeded.prefix}P99`, policy: 'NORMAL', saleLineCount: 5 }]);
      const all = await feeReviewApi.products(cycle.id, { keyword: seeded.prefix });
      expect(all.totalElements, 'Pre-condition 11: 13 rows').toBe(13);
      expect([all.buckets.needsReview, all.buckets.resolvedCleanly, all.buckets.notComputable, all.buckets.provisional, all.buckets.correctedThisPeriod], 'Pre-condition 11: NEEDS_REVIEW 8 · RESOLVED_CLEANLY 5 · NOT_COMPUTABLE 0 · PROVISIONAL 0 · CORRECTED 0').toEqual([8, 5, 0, 0, 0]);
      await list.open({ cycleId: cycle.id, pageSize: '10' });
      views = [viewOf('KO', page, list)];
    });

    await step('Act: Step 1 — Open 정산 관리 › 정산 수수료 확인·수정 in KO (sidebar), then the same screen in EN', async () => {
      await list.menuGroup.click();
      await openFromMenu(list, cycle.id, '10');
      views.push(await englishView(secondSession, { cycleId: cycle.id, pageSize: '10' }));
    });

    await step('Assert: Expected 1 — The menu reads 정산 관리 › 정산 수수료 확인·수정 and the screen opens (KO and EN)', async () => {
      await expect.soft(shell.sidebarEntry('nav.group').first(), '[Expected 1] (KO) Menu group 정산 관리').toBeVisible();
      await expect.soft(list.menuItem, '[Expected 1] (KO) Menu entry 정산 수수료 확인·수정 under 정산 관리').toBeVisible();
      const en = views[1];
      await expect.soft(new AppShell(en.page).sidebar, '[Expected 1] (EN) Menu group Settlement management').toContainText(FR_EN['nav.group']);
      await expect.soft(en.list.menuItem, '[Expected 1] (EN) Menu entry Settlement fee review').toBeVisible();
      for (const v of views) await expect.soft(v.list.pageTitle, `[Expected 1] (${v.lang}) The screen opens`).toHaveText(v.t['page.cardTitle']);
    });

    await step(`Act: Step 2 — Select 정산 주기 = ${cycle.label} (CY_MAIN) in KO and in EN`, async () => {
      for (const v of views) await v.list.selectCycle(cycle.label);
    });

    await step('Assert: Expected 2 — The select shows the cycle as YYYY-MM and the list reloads', async () => {
      for (const v of views) {
        await expect.soft(v.list.cycleSelect.locator('option:checked'), `[Expected 2] (${v.lang}) The select shows ${cycle.label}`).toHaveText(cycle.label);
        expect.soft(cycle.label, `[Expected 2] (${v.lang}) The period reads YYYY-MM`).toMatch(/^\d{4}-\d{2}$/);
        await expect.soft(v.list.row(seeded.products.P03), `[Expected 2] (${v.lang}) The list shows the cycle rows`).toBeVisible();
      }
    });

    await step('Act: Step 3 — Check the page title and the search area', async () => {
      await list.keywordInput.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Title; 정산 주기 select; 검색 조건 select (default 상품명, 4 options); 검색어 placeholder; 초기화 / 검색', async () => {
      for (const v of views) {
        const ko = v.lang === 'KO';
        await expect.soft(v.list.pageTitle, `[Expected 3] (${v.lang}) Page title ${v.t['page.cardTitle']}`).toHaveText(v.t['page.cardTitle']);
        await expect.soft(v.list.cycleLabel, `[Expected 3] (${v.lang}) Label ${v.t['filter.cycle']}`).toBeVisible();
        await expect.soft(v.list.cycleSelect.locator('option:checked'), `[Expected 3] (${v.lang}) 정산 주기 value ${cycle.label}`).toHaveText(cycle.label);
        // Build chưa có select 검색 조건 → đọc 1 lần (không chờ) rồi kiểm từng option theo TC.
        await expect.soft(v.list.searchConditionSelect, `[Expected 3] (${v.lang}) 검색 조건 (Search condition) select is rendered`).toHaveCount(1);
        const present = (await v.list.searchConditionSelect.count()) > 0;
        const options = present ? (await v.list.searchConditionSelect.locator('option').allTextContents()).map((t) => t.trim()) : [];
        const selected = present ? ((await v.list.searchConditionSelect.locator('option:checked').textContent()) ?? '').trim() : '';
        const names = ko ? ['상품명', '상품ID', '수수료 카테고리', '계약'] : ['Product name', 'Product ID', 'Fee category', 'Contract'];
        expect.soft(selected, `[Expected 3] (${v.lang}) 검색 조건 defaults to ${names[0]}`).toBe(names[0]);
        for (const name of names) expect.soft(options, `[Expected 3] (${v.lang}) 검색 조건 option ${name}`).toContain(name);
        await expect.soft(v.list.keywordLabel, `[Expected 3] (${v.lang}) Label ${v.t['filter.keyword']}`).toBeVisible();
        await expect.soft(v.list.keywordInput, `[Expected 3] (${v.lang}) Placeholder ${v.t['filter.keywordPlaceholder']}`).toHaveAttribute('placeholder', v.t['filter.keywordPlaceholder']);
        await expect.soft(v.list.resetButton, `[Expected 3] (${v.lang}) Button ${ko ? '초기화' : 'Reset'}`).toHaveText(ko ? '초기화' : 'Reset');
        await expect.soft(v.list.searchButton, `[Expected 3] (${v.lang}) Button ${ko ? '검색' : 'Search'}`).toHaveText(ko ? '검색' : 'Search');
      }
    });

    await step('Act: Step 4 — Check the banner above the bucket strip', async () => {
      await list.provisionalBanner.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — Title 잠정치입니다. and the provisional body', async () => {
      for (const v of views) {
        await expect.soft(v.list.provisionalBanner, `[Expected 4] (${v.lang}) Title ${v.t['bnr.provisionalTitle']}`).toContainText(v.t['bnr.provisionalTitle']);
        await expect.soft(v.list.provisionalBanner, `[Expected 4] (${v.lang}) Body`).toContainText(v.t['bnr.provisionalBody']);
      }
    });

    await step('Act: Step 5 — Check the bucket strip', async () => {
      await list.partitionCaption.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 5 — Both captions; first group 13 · 8 (selected) · 0 · 0 · 0 · 5; second group 5 · 1 · 8 · 0', async () => {
      const groups = [
        { caption: 'strip.partition' as const, chips: [['bucket.ALL', 13], ['bucket.EXC', 8], ['bucket.NC', 0], ['bucket.PROV', 0], ['bucket.FIXED', 0], ['bucket.OK', 5]] as const },
        { caption: 'strip.slice' as const, chips: [['bucket.NF', 5], ['bucket.AMB', 1], ['bucket.DIFF', 8], ['bucket.SRCDIFF', 0]] as const },
      ];
      for (const v of views) {
        for (const { caption, chips } of groups) {
          const captionLocator = caption === 'strip.partition' ? v.list.partitionCaption : v.list.sliceCaption;
          const group = caption === 'strip.partition' ? v.list.partitionGroup : v.list.sliceGroup;
          await expect.soft(captionLocator, `[Expected 5] (${v.lang}) Caption ${v.t[caption]}`).toHaveText(v.t[caption]);
          for (const [key, count] of chips) {
            await expect.soft(group.getByRole('button', { name: new RegExp(`${esc(v.t[key])}$`) }), `[Expected 5] (${v.lang}) Chip ${v.t[key]} sits under ${v.t[caption]}`).toBeVisible();
            await expect.soft(v.list.chip(key).locator('span').first(), `[Expected 5] (${v.lang}) Chip ${v.t[key]} = ${count}`).toHaveText(String(count));
          }
        }
        await expect.soft(v.list.chip('bucket.EXC'), `[Expected 5] (${v.lang}) ${v.t['bucket.EXC']} is the selected chip`).toHaveAttribute('aria-pressed', 'true');
      }
    });

    await step('Act: Step 6 — Check the table header', async () => {
      await list.table.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 6 — select-all · 상품ID · 상품명 · 산정된 수수료 카테고리 · 산정 요율 · 산정 상태 · 지정 대조 · 작업', async () => {
      const keys = ['col.productId', 'col.productName', 'col.category', 'col.rate', 'col.status', 'col.compare', 'col.actions'] as const;
      for (const v of views) {
        await expect.soft(v.list.headers.nth(0).getByRole('checkbox'), `[Expected 6] (${v.lang}) Column 1 is the select-all checkbox`).toBeVisible();
        for (const [i, key] of keys.entries()) {
          await expect.soft(v.list.headers.nth(i + 1), `[Expected 6] (${v.lang}) Column ${i + 2} is ${v.t[key]}`).toHaveText(v.t[key]);
        }
      }
    });

    await step('Act: Step 7 — Check the cells of rows P03, P04 and P06', async () => {
      await list.row(seeded.products.P06).scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 7 — P03 category B · 9.00% · 산정 완료 · 불일치; P04 no rate · 중복 적용 · 지정 없음; P06 no rate · 적용 행 없음 · 지정 없음', async () => {
      for (const v of views) {
        const p03 = v.list.row(seeded.products.P03);
        await expect.soft(v.list.cell(p03, 'category'), `[Expected 7] (${v.lang}) P03 category ${seeded.master.categoryName.B}`).toHaveText(seeded.master.categoryName.B);
        await expect.soft(v.list.cell(p03, 'rate'), `[Expected 7] (${v.lang}) P03 rate 9.00%`).toHaveText('9.00%');
        await expect.soft(v.list.cell(p03, 'status'), `[Expected 7] (${v.lang}) P03 ${v.t['status.RESOLVED']}`).toHaveText(v.t['status.RESOLVED']);
        await expect.soft(v.list.cell(p03, 'compare'), `[Expected 7] (${v.lang}) P03 ${v.t['compare.MISMATCH']}`).toHaveText(v.t['compare.MISMATCH']);
        for (const [code, status] of [['P04', 'status.AMBIGUOUS'], ['P06', 'status.NO_ROW']] as const) {
          const row = v.list.row(seeded.products[code]);
          await expect.soft(v.list.cell(row, 'rate'), `[Expected 7] (${v.lang}) ${code} shows no rate`).toHaveText(/^[^\d]*$/);
          await expect.soft(v.list.cell(row, 'status'), `[Expected 7] (${v.lang}) ${code} ${v.t[status]}`).toHaveText(v.t[status]);
          await expect.soft(v.list.cell(row, 'compare'), `[Expected 7] (${v.lang}) ${code} ${v.t['compare.NOT_ASSIGNED']}`).toHaveText(v.t['compare.NOT_ASSIGNED']);
        }
      }
    });

    await step('Act: Step 8 — Check the 작업 (Actions) cell of row P03', async () => {
      await list.cell(list.row(seeded.products.P03), 'actions').scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 8 — 근거 · 수정 · 이력 in this order; no 회수 (nothing awaits approval)', async () => {
      for (const v of views) {
        const row = v.list.row(seeded.products.P03);
        await expect.soft(v.x.actionButtons(v.list.cell(row, 'actions')), `[Expected 8] (${v.lang}) ${v.t['btn.basis']} · ${v.t['btn.correct']} · ${v.t['btn.history']} in this order`).toHaveText([v.t['btn.basis'], v.t['btn.correct'], v.t['btn.history']]);
        await expect.soft(v.list.rowButton(row, 'btn.withdraw'), `[Expected 8] (${v.lang}) No ${v.t['btn.withdraw']}`).toHaveCount(0);
      }
    });

    await step('Act: Step 9 — Check the toolbar above the table and the buttons below it', async () => {
      await list.reportButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 9 — 선택 일괄 상신 disabled; 산정 시각 <time> — 열 때마다 새로 산정됩니다; 이번 기 수정 내역 and 목록 내보내기', async () => {
      for (const v of views) {
        await expect.soft(v.list.submitButton, `[Expected 9] (${v.lang}) ${v.t['btn.submitSelected']} is disabled`).toBeDisabled();
        await expect.soft(v.list.resolvedAtLabel, `[Expected 9] (${v.lang}) Text ${v.t['lbl.resolvedAtOpen']}`).toHaveText(resolvedAtPattern(v.t));
        await expect.soft(v.list.reportButton, `[Expected 9] (${v.lang}) Button ${v.t['btn.report']}`).toHaveText(v.t['btn.report']);
        await expect.soft(v.list.exportButton, `[Expected 9] (${v.lang}) Button ${v.t['btn.exportList']}`).toHaveText(v.t['btn.exportList']);
      }
    });

    await step('Act: Step 10 — Check the pagination bar', async () => {
      await list.pagination.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 10 — Total 8 상품; 페이지당 = 10 with 10 · 20 · 50 · 100; first, previous, page 1, next, last', async () => {
      for (const v of views) {
        await expect.soft(v.list.counter, `[Expected 10] (${v.lang}) Total 8 with the item name ${v.t['pager.itemName']}`).toContainText(new RegExp(`8\\D+${esc(v.t['pager.itemName'])}`));
        await expect.soft(v.list.pageSizeSelect.locator('option:checked'), `[Expected 10] (${v.lang}) 페이지당 = 10`).toHaveText(/^10\D*$/);
        const options = (await v.list.pageSizeSelect.locator('option').allTextContents()).map((t) => t.trim());
        for (const [i, size] of ['10', '20', '50', '100'].entries()) expect.soft(options[i] ?? '', `[Expected 10] (${v.lang}) Rows-per-page option ${size}`).toMatch(new RegExp(`^${size}\\D*$`));
        for (const control of ['First', 'Previous', '1', 'Next', 'Last']) {
          await expect.soft(v.list.pagination, `[Expected 10] (${v.lang}) Page navigation ${control}`).toContainText(control);
        }
      }
    });

    await step('Act: Step 11 — Hover over 목록 내보내기 (Export list)', async () => {
      for (const v of views) tips[v.lang] = await v.x.tooltipText(v.list.exportButton);
    });

    await step('Assert: Expected 11 — Tooltip 현재 필터에 해당하는 전체 상품을 내보냅니다 — …', async () => {
      for (const v of views) expect.soft(tips[v.lang], `[Expected 11] (${v.lang}) Export list tooltip ${v.t['msg.exportListTitle']}`).toBe(v.t['msg.exportListTitle']);
    });
  });

  test('TC_US079_08 — The Why this rate panel renders its sections in EN and KO', async ({ page, feeReviewApi, seedData, secondSession, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_08', 'Medium', TAGS.ui, `On P03 (R_B9 of ANNEX1 wins by hierarchy over the slot R_B10) the Why this rate dialog shows 9.00% from a contract row with contract ANNEX1, policy NORMAL and 2020-01-01; the 현재 지정된 행 panel with the default slot R_B10 and the empty promotion slot and the 불일치 note; the collapsed 어떻게 결정됐는지 보기; the three reasoning panels; P06 opens with an empty rate and the reasoning already expanded — in KO and EN. ${DATA_NOTE} ${LANG_NOTE} Deviation: the shared family is named [T079-<RUN>-sharedN] instead of [T079-<RUN>-8] — the contract name is matched on [T079-<RUN>-…] ROOT / ANNEX1. Not automated: "with the reason it was set aside" on the R_B10 candidate — the TC gives no wording. Expected FAIL (recon 01/10): the panel shows the contract id, not its name; the assigned panel shows one assigned row, not the default and promotion slots.`);
    let seeded!: Seeded;
    let views: View[] = [];
    const contractName = (key: 'ROOT' | 'ANNEX1') => new RegExp(`\\[T079-${esc(seeded.run)}-[^\\]]+\\] ${key}`);

    await step('Arrange: Pre-condition 1–14 — ROOT (R_B10) + ANNEX1 (R_B9), P03 (slot R_B10) and P06 (category D) in CY_MAIN; screen open in KO', async () => {
      seeded = await seedData({
        tc: 8,
        contracts: family({ ROOT: ['R_B10'], ANNEX1: ['R_B9'] }),
        cycles: ['CY_MAIN'],
        products: [product('P03', [{ cycle: 'CY_MAIN', saleLines: 77 }]), product('P06', [{ cycle: 'CY_MAIN', saleLines: 188 }])],
      });
      await verifySeed(feeReviewApi, seeded, 10, 2, { P03: { status: 'RESOLVED', rate: '9.00', verdict: 'MISMATCH' }, P06: { status: 'NO_ROW', rate: null } });
      views = [viewOf('KO', page, list)];
    });

    await step('Act: Step 1 — Open the screen in KO and in EN and select CY_MAIN', async () => {
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id });
      views.push(await englishView(secondSession, { cycleId: seeded.cycles.CY_MAIN.id }));
    });

    await step('Assert: Expected 1 — The list of the cycle is shown', async () => {
      for (const v of views) {
        await expect.soft(v.list.cycleSelect.locator('option:checked'), `[Expected 1] (${v.lang}) Cycle ${seeded.cycles.CY_MAIN.label} is selected`).toHaveText(seeded.cycles.CY_MAIN.label);
        await expect(v.list.row(seeded.products.P03), `[Expected 1] (${v.lang}) Row P03 is listed`).toBeVisible();
      }
    });

    await step('Act: Step 2 — Click 근거 (Basis) on row P03', async () => {
      for (const v of views) await v.list.openBasis(v.list.row(seeded.products.P03));
    });

    await step('Assert: Expected 2 — The dialog 요율 산정 근거 (Why this rate) opens', async () => {
      for (const v of views) await expect.soft(v.list.basis.title, `[Expected 2] (${v.lang}) Title ${v.t['trace.title']}`).toHaveText(v.t['trace.title']);
    });

    await step('Act: Step 3 — Check the top answer panel', async () => {
      await list.basis.headlineRate.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — 9.00% marked 계약 행; 계약 = ANNEX1 · 정책 = NORMAL · 적용 시작일 = 2020-01-01; the why-contract sentence', async () => {
      for (const v of views) {
        const b = v.list.basis;
        await expect.soft(b.headlineRate, `[Expected 3] (${v.lang}) Rate 9.00%`).toHaveText('9.00%');
        await expect.soft(b.root.getByText(v.t['trace.fromContract'], { exact: true }), `[Expected 3] (${v.lang}) Marked ${v.t['trace.fromContract']}`).toBeVisible();
        await expect.soft(b.value(b.root, v.t['trace.kvContract']).first(), `[Expected 3] (${v.lang}) ${v.t['trace.kvContract']} = [T079-<RUN>-…] ANNEX1`).toHaveText(contractName('ANNEX1'));
        await expect.soft(b.value(b.root, v.t['trace.kvPolicy']).first(), `[Expected 3] (${v.lang}) ${v.t['trace.kvPolicy']} = NORMAL`).toHaveText('NORMAL');
        await expect.soft(b.value(b.root, v.t['trace.kvEffective']).first(), `[Expected 3] (${v.lang}) ${v.t['trace.kvEffective']} = 2020-01-01`).toHaveText('2020-01-01');
        await expect.soft(b.root.getByText(v.t['trace.whyContract'], { exact: true }), `[Expected 3] (${v.lang}) Sentence ${v.t['trace.whyContract']}`).toBeVisible();
      }
    });

    await step('Act: Step 4 — Check the assigned-row panel', async () => {
      await list.basis.section('trace.assignedTitle').scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — 현재 지정된 행; default slot R_B10 and empty promotion slot, default marked as compared; 불일치 with the note', async () => {
      for (const v of views) {
        const assigned = v.list.basis.section('trace.assignedTitle');
        await expect.soft(v.list.basis.root.getByText(v.t['trace.assignedTitle'], { exact: true }), `[Expected 4] (${v.lang}) Heading ${v.t['trace.assignedTitle']}`).toBeVisible();
        await expect.soft(assigned, `[Expected 4] (${v.lang}) The default slot R_B10 is shown`).toContainText(String(seeded.family.rows.R_B10));
        await expect.soft(assigned, `[Expected 4] (${v.lang}) The promotion slot is shown (empty)`).toContainText(/프로모션|PROMOTION|Promotion/);
        await expect.soft(assigned, `[Expected 4] (${v.lang}) The default slot is marked as the one compared`).toContainText(/기본|비교|[Dd]efault|compared/);
        await expect.soft(assigned, `[Expected 4] (${v.lang}) Verdict ${v.t['trace.flagDiff']}`).toContainText(v.t['trace.flagDiff']);
        await expect.soft(v.list.basis.root, `[Expected 4] (${v.lang}) Note ${v.t['trace.noteDiff']}`).toContainText(v.t['trace.noteDiff']);
      }
    });

    await step('Act: Step 5 — Check the disclosure button below it', async () => {
      await list.basis.evidenceToggle.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 5 — 어떻게 결정됐는지 보기 is shown collapsed', async () => {
      for (const v of views) {
        await expect.soft(v.list.basis.evidenceToggle, `[Expected 5] (${v.lang}) ${v.t['trace.evidence']} is shown`).toBeVisible();
        await expect.soft(v.list.basis.evidenceToggle, `[Expected 5] (${v.lang}) ${v.t['trace.evidence']} is collapsed`).toHaveAttribute('aria-expanded', 'false');
      }
    });

    await step('Act: Step 6 — Click 어떻게 결정됐는지 보기 (How this was decided)', async () => {
      for (const v of views) await v.list.basis.expandEvidence();
    });

    await step('Assert: Expected 6 — The reasoning block expands', async () => {
      for (const v of views) await expect.soft(v.list.basis.evidenceToggle, `[Expected 6] (${v.lang}) The reasoning block is expanded`).toHaveAttribute('aria-expanded', 'true');
    });

    await step('Act: Step 7 — Check the three reasoning panels', async () => {
      await list.basis.section('trace.ladderTitle').scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 7 — 도출된 키 B · FULL_CONSIGNMENT · NORMAL · ROOT family; R_B9 부속계약 적용, R_B10 미적용; 계층 step marked 여기서 결정됨', async () => {
      for (const v of views) {
        const b = v.list.basis;
        const key = b.section('trace.keyTitle');
        await expect.soft(b.value(key, v.t['trace.kvCategory']), `[Expected 7] (${v.lang}) ${v.t['trace.keyTitle']}: ${v.t['trace.kvCategory']} = category B`).toHaveText(seeded.master.categoryName.B);
        await expect.soft(b.value(key, v.t['trace.kvSale']), `[Expected 7] (${v.lang}) ${v.t['trace.kvSale']} = FULL_CONSIGNMENT`).toHaveText('FULL_CONSIGNMENT');
        await expect.soft(b.value(key, v.t['trace.kvPolicy']), `[Expected 7] (${v.lang}) ${v.t['trace.kvPolicy']} = NORMAL`).toHaveText('NORMAL');
        await expect.soft(b.value(key, v.t['trace.kvContract']), `[Expected 7] (${v.lang}) ${v.t['trace.kvContract']} family = [T079-<RUN>-…] ROOT`).toHaveText(contractName('ROOT'));
        const winner = b.candidateRows.filter({ hasText: '9.00%' });
        await expect.soft(winner, `[Expected 7] (${v.lang}) R_B9 9.00% is marked ${v.t['trace.annex']}`).toContainText(v.t['trace.annex']);
        await expect.soft(winner, `[Expected 7] (${v.lang}) R_B9 is marked ${v.t['trace.candWin']}`).toContainText(new RegExp(`^\\s*${esc(v.t['trace.candWin'])}`));
        await expect.soft(b.candidateRows.filter({ hasText: '10.00%' }), `[Expected 7] (${v.lang}) R_B10 10.00% is marked ${v.t['trace.candOut']}`).toContainText(v.t['trace.candOut']);
        await expect.soft(b.ladderSteps.filter({ hasText: v.t['trace.tierHIERARCHY'] }), `[Expected 7] (${v.lang}) Step ${v.t['trace.tierHIERARCHY']} is marked ${v.t['trace.decidedHere']}`).toContainText(v.t['trace.decidedHere']);
      }
    });

    await step('Act: Step 8 — Close the dialog and click 근거 (Basis) on row P06', async () => {
      for (const v of views) {
        await v.list.basis.close();
        await v.list.openBasis(v.list.row(seeded.products.P06));
      }
    });

    await step('Assert: Expected 8 — P06 opens with the rate box empty and the reasoning block already expanded', async () => {
      for (const v of views) {
        await expect.soft(v.list.basis.productLine, `[Expected 8] (${v.lang}) The dialog is for P06`).toContainText(seeded.products.P06);
        await expect.soft(v.list.basis.headlineRate, `[Expected 8] (${v.lang}) The rate box is empty`).toHaveText(/^[^\d]*$/);
        await expect.soft(v.list.basis.evidenceToggle, `[Expected 8] (${v.lang}) The reasoning block is expanded without a click`).toHaveAttribute('aria-expanded', 'true');
        await expect.soft(v.list.basis.section('trace.keyTitle'), `[Expected 8] (${v.lang}) ${v.t['trace.keyTitle']} is visible`).toBeVisible();
      }
    });
  });

  test('TC_US079_09 — The Correct fee resolution dialog renders the tier 1 and tier 2 fields in EN and KO', async ({ page, feeReviewApi, seedData, secondSession, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_09', 'Medium', TAGS.ui, `On P03 the dialog shows the 계약에서 산정된 값 panel (B · 9.00% · 산정 완료) as plain text, Tier 1 at — 변경 없음 — listing only the family categories with their rates (A 12.50%, C (⚠ 동순위) without a rate, D absent), the nothing-picked panel, Tier 2 locked, the reason field (0 / 200), 취소 and a disabled 저장 without 수정 버리기; on P10 Tier 1 reads the family-prices-nothing text, Tier 2 is open with 예: 4.50% and the Tier 2 reason label; on P14 the draft fills category B and its reason with 수정 버리기 (원래대로) · 취소 · 저장 — in KO and EN. ${DATA_NOTE} ${LANG_NOTE} Private cycle (Expected 1 counts 3 rows). Deviation: the TC's counter "0/200" is matched with or without spaces.`);
    let seeded!: Seeded;
    let views: View[] = [];
    let reasonY = '';
    const names = () => seeded.master.categoryName;

    await step('Arrange: Pre-condition 1–15 — ROOT (R_A, R_B10, R_E11), ANNEX1 (R_B9, R_C20), ANNEX2 (R_C22); P03, P10, P14 in CY_MAIN; COR_Y draft on P14 (A → B)', async () => {
      seeded = await seedData({
        tc: 9,
        private: true,
        contracts: family({ ROOT: ['R_A', 'R_B10', 'R_E11'], ANNEX1: ['R_B9', 'R_C20'], ANNEX2: ['R_C22'] }),
        cycles: ['CY_MAIN'],
        products: [product('P03', [{ cycle: 'CY_MAIN', saleLines: 77 }]), product('P10', [{ cycle: 'CY_MAIN', saleLines: 86 }]), product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])],
      });
      reasonY = reasonOf('TC_US079_09', '카테고리 오매핑 정정');
      await saveDraft(feeReviewApi, seeded, 'P14', { category: 'B', reason: reasonY });
      await verifySeed(feeReviewApi, seeded, 12, 3, { P03: { status: 'RESOLVED', rate: '9.00' }, P10: { status: 'NO_ROW' }, P14: { state: 'DRAFT' } });
      views = [viewOf('KO', page, list)];
    });

    await step('Act: Step 1 — Open the screen in KO and EN, select CY_MAIN, click 기간 내 판매 상품 and set 페이지당 = 20', async () => {
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id });
      views.push(await englishView(secondSession, { cycleId: seeded.cycles.CY_MAIN.id }));
      for (const v of views) {
        await v.list.clickChip(v.list.chip('bucket.ALL'));
        await v.list.setPageSize('20');
      }
    });

    await step('Assert: Expected 1 — The list of the cycle is shown with 3 rows', async () => {
      for (const v of views) await expect(v.list.rows, `[Expected 1] (${v.lang}) 3 rows are listed`).toHaveCount(3);
    });

    await step('Act: Step 2 — Click 수정 (Correct) on row P03', async () => {
      for (const v of views) await v.list.openCorrect(v.list.row(seeded.products.P03));
    });

    await step('Assert: Expected 2 — The dialog 수수료 산정 수정 (Correct fee resolution) opens', async () => {
      for (const v of views) await expect.soft(v.list.correct.title, `[Expected 2] (${v.lang}) Title ${v.t['fix.title']}`).toHaveText(v.t['fix.title']);
    });

    await step('Act: Step 3 — Check the contract panel at the top', async () => {
      await list.correct.fromContract.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — 계약에서 산정된 값: 수수료 카테고리 = B · 산정 요율 = 9.00% · 산정 상태 = 산정 완료, as plain text', async () => {
      for (const v of views) {
        const c = v.list.correct;
        await expect.soft(c.root.getByText(v.t['fix.fromContractTitle'], { exact: true }), `[Expected 3] (${v.lang}) Heading ${v.t['fix.fromContractTitle']}`).toBeVisible();
        const values: Array<[Parameters<typeof c.contractValue>[0], string]> = [['fix.kvCategory', names().B], ['fix.kvRate', '9.00%'], ['fix.kvStatus', v.t['status.RESOLVED']]];
        for (const [key, value] of values) {
          await expect.soft(c.contractValue(key), `[Expected 3] (${v.lang}) ${v.t[key]} = ${value}`).toHaveText(value);
          const plain = await plainText(c.contractValue(key));
          expect.soft(plain.input || plain.framed, `[Expected 3] (${v.lang}) ${v.t[key]} is plain text (no input frame)`).toBe(false);
        }
      }
    });

    await step('Act: Step 4 — Check the tier 1 field', async () => {
      await list.correct.tier1Label.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — Label 1단계 — 수수료 카테고리 변경; the select shows — 변경 없음 —', async () => {
      for (const v of views) {
        await expect.soft(v.list.correct.tier1Label, `[Expected 4] (${v.lang}) Label ${v.t['fix.tier1Label']}`).toHaveText(v.t['fix.tier1Label']);
        await expect.soft(v.list.correct.tier1Select.locator('option:checked'), `[Expected 4] (${v.lang}) The select shows ${v.t['fix.noChange']}`).toHaveText(v.t['fix.noChange']);
      }
    });

    const options: Record<'KO' | 'EN', string[]> = { KO: [], EN: [] };
    await step('Act: Step 5 — Open the tier 1 dropdown', async () => {
      for (const v of views) {
        await v.list.correct.tier1Select.click();
        options[v.lang] = (await v.list.correct.optionTexts()).filter((o) => o !== v.t['fix.noChange']);
      }
    });

    await step('Assert: Expected 5 — Only the family categories with their rate (A 12.50%); C annotated (⚠ 동순위) without rate; D not listed', async () => {
      for (const v of views) {
        const listed = options[v.lang];
        const family = [names().A, names().B, names().C, names().E];
        for (const option of listed) expect.soft(family.some((n) => option === n || option.startsWith(`${n} (`)), `[Expected 5] (${v.lang}) "${option}" is a category the family prices`).toBe(true);
        expect.soft(listed, `[Expected 5] (${v.lang}) Category A is listed with 12.50%`).toContain(`${names().A} (12.50%)`);
        expect.soft(listed, `[Expected 5] (${v.lang}) Category C is annotated ${v.t['fix.tied'].trim()} with no rate`).toContain(`${names().C}${v.t['fix.tied']}`);
        expect.soft(listed.some((o) => o === names().D || o.startsWith(`${names().D} (`)), `[Expected 5] (${v.lang}) Category D is not listed`).toBe(false);
      }
    });

    await step('Act: Step 6 — Close the dropdown and check the message panel, the tier 2 area, the reason field and the footer buttons', async () => {
      for (const v of views) await v.list.correct.title.click();
    });

    await step('Assert: Expected 6 — 아직 고른 것이 없습니다; Tier 2 locked; 수정 사유 (필수) with 0/200; 취소 and disabled 저장; no 수정 버리기', async () => {
      for (const v of views) {
        const c = v.list.correct;
        await expect.soft(c.deltaHead, `[Expected 6] (${v.lang}) Message ${v.t['fix.deltaNoneHead']}`).toHaveText(v.t['fix.deltaNoneHead']);
        await expect.soft(c.deltaPanel, `[Expected 6] (${v.lang}) Message body ${v.t['fix.deltaNoneBody']}`).toContainText(v.t['fix.deltaNoneBody']);
        await expect.soft(c.tier2Label, `[Expected 6] (${v.lang}) Label ${v.t['fix.tier2Label']}`).toHaveText(v.t['fix.tier2Label']);
        await expect.soft(c.tier2Input, `[Expected 6] (${v.lang}) Tier 2 has no input box`).toHaveCount(0);
        await expect.soft(c.tier2Lock, `[Expected 6] (${v.lang}) Lock text ${v.t['fix.tier2Lock']}`).toHaveText(v.t['fix.tier2Lock']);
        await expect.soft(c.reasonLabel, `[Expected 6] (${v.lang}) Label ${v.t['fix.reasonLabel']}`).toHaveText(v.t['fix.reasonLabel']);
        await expect.soft(c.reasonInput, `[Expected 6] (${v.lang}) Placeholder ${v.t['fix.reasonPlaceholder']}`).toHaveAttribute('placeholder', v.t['fix.reasonPlaceholder']);
        await expect.soft(c.root.getByText(/^\s*0\s*\/\s*200\s*$/), `[Expected 6] (${v.lang}) Counter 0/200`).toBeVisible();
        await expect.soft(c.cancelButton, `[Expected 6] (${v.lang}) Button ${v.lang === 'KO' ? '취소' : 'Cancel'}`).toBeVisible();
        await expect.soft(c.saveButton, `[Expected 6] (${v.lang}) Button ${v.t['fix.save']} is disabled`).toBeDisabled();
        await expect.soft(c.discardButton, `[Expected 6] (${v.lang}) No ${v.t['fix.discard']} button`).toHaveCount(0);
      }
    });

    await step('Act: Step 7 — Click 취소 (Cancel) and click 수정 (Correct) on row P10', async () => {
      for (const v of views) {
        await v.list.correct.cancel();
        await v.list.openCorrect(v.list.row(seeded.products.P10));
      }
    });

    await step('Assert: Expected 7 — The dialog opens for P10', async () => {
      for (const v of views) await expect.soft(v.list.correct.productLine, `[Expected 7] (${v.lang}) The dialog is for P10`).toContainText(seeded.products.P10);
    });

    await step('Act: Step 8 — Check the tier 1 field, the tier 2 field and the reason field', async () => {
      await list.correct.reasonInput.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 8 — Tier 1 reads the family-prices-nothing text; Tier 2 input with 예: 4.50%; reason label 수수료 산정 근거 (필수)', async () => {
      for (const v of views) {
        const c = v.list.correct;
        await expect.soft(c.tier1Select.locator('option:checked'), `[Expected 8] (${v.lang}) Tier 1 reads ${v.t['fix.familyEmpty']}`).toHaveText(v.t['fix.familyEmpty']);
        await expect.soft(c.tier2Input, `[Expected 8] (${v.lang}) Tier 2 input is rendered`).toBeVisible();
        await expect.soft(c.tier2Input, `[Expected 8] (${v.lang}) Placeholder ${v.t['fix.tier2Placeholder']}`).toHaveAttribute('placeholder', v.t['fix.tier2Placeholder']);
        await expect.soft(c.reasonLabel, `[Expected 8] (${v.lang}) Reason label ${v.t['fix.reasonLabelT2']}`).toHaveText(v.t['fix.reasonLabelT2']);
        await expect.soft(c.reasonInput, `[Expected 8] (${v.lang}) Placeholder ${v.t['fix.reasonPlaceholderT2']}`).toHaveAttribute('placeholder', v.t['fix.reasonPlaceholderT2']);
      }
    });

    await step('Act: Step 9 — Click 취소 (Cancel) and click 수정 (Correct) on row P14', async () => {
      for (const v of views) {
        await v.list.correct.cancel();
        await v.list.openCorrect(v.list.row(seeded.products.P14));
      }
    });

    await step('Assert: Expected 9 — The dialog opens for P14', async () => {
      for (const v of views) await expect.soft(v.list.correct.productLine, `[Expected 9] (${v.lang}) The dialog is for P14`).toContainText(seeded.products.P14);
    });

    await step('Act: Step 10 — Check the filled values and the footer buttons', async () => {
      await list.correct.saveButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 10 — Tier 1 shows category B and the reason 카테고리 오매핑 정정; 수정 버리기 (원래대로) · 취소 · 저장', async () => {
      for (const v of views) {
        const c = v.list.correct;
        await expect.soft(c.tier1Select.locator('option:checked'), `[Expected 10] (${v.lang}) Tier 1 shows category B`).toHaveText(new RegExp(`^${esc(names().B)}( \\(.*\\))?$`));
        await expect.soft(c.reasonInput, `[Expected 10] (${v.lang}) The reason shows 카테고리 오매핑 정정`).toHaveValue(reasonY);
        await expect.soft(v.x.modalFooter(c.root).getByRole('button'), `[Expected 10] (${v.lang}) Buttons ${v.t['fix.discard']} · ${v.lang === 'KO' ? '취소' : 'Cancel'} · ${v.t['fix.save']}`).toHaveText([v.t['fix.discard'], v.lang === 'KO' ? '취소' : 'Cancel', v.t['fix.save']]);
      }
    });
  });

  test('TC_US079_10 — The Change history dialog renders its five columns and footer', async ({ page, feeReviewApi, approverFeeReviewApi, seedData, secondSession, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_10', 'Medium', TAGS.ui, `The history of P14 (submitted by user A, rejected by user B) names the product, has the five columns 시점 · 수행자 · 항목 · 변경 내용 · 사유, one submission row by user A with category A → B and 12.50% → 9.00% struck through, the reason and a separate 반려 사유 block naming user B; the footer note; P03 shows the no-change text — in KO and EN. ${DATA_NOTE} ${LANG_NOTE} Expected FAIL (recon 01/10): the rate line reads "12.50 → 9.00" without the per-cent sign.`);
    let seeded!: Seeded;
    let views: View[] = [];
    let reasonX = '';
    let rejectReason = '';

    await step('Arrange: Pre-condition 1–16 — ROOT (R_A, R_B10) + ANNEX1 (R_B9); P03 and P14 in CY_MAIN; COR_X on P14 submitted by A and rejected by B', async () => {
      seeded = await seedData({ tc: 10, contracts: family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P03', [{ cycle: 'CY_MAIN', saleLines: 77 }]), product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      reasonX = reasonOf('TC_US079_10', 'Wrong category mapped in commerce');
      rejectReason = reasonOf('TC_US079_10', '근거 계약 확인 필요');
      const ca1 = await submitDraft(feeReviewApi, seeded, 'P14', await saveDraft(feeReviewApi, seeded, 'P14', { category: 'B', reason: reasonX }));
      const { status } = await approverFeeReviewApi.reject(ca1, rejectReason);
      expect(status, 'Pre-condition 12: user B rejects CA1').toBeLessThan(300);
      await verifySeed(feeReviewApi, seeded, 13, 2, { P03: { state: null }, P14: { rate: '12.50', state: 'REJECTED' } });
      views = [viewOf('KO', page, list)];
    });

    await step('Act: Step 1 — Open the screen in KO and EN, select CY_MAIN and click 기간 내 판매 상품', async () => {
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id });
      views.push(await englishView(secondSession, { cycleId: seeded.cycles.CY_MAIN.id }));
      for (const v of views) await v.list.clickChip(v.list.chip('bucket.ALL'));
    });

    await step('Assert: Expected 1 — The list of the cycle is shown', async () => {
      for (const v of views) await expect(v.list.row(seeded.products.P14), `[Expected 1] (${v.lang}) Row P14 of the cycle is listed`).toBeVisible();
    });

    await step('Act: Step 2 — Click 이력 (History) on row P14', async () => {
      for (const v of views) await v.list.openHistory(v.list.row(seeded.products.P14));
    });

    await step('Assert: Expected 2 — The dialog 변경 이력 (Change history) opens', async () => {
      for (const v of views) await expect.soft(v.list.history.title, `[Expected 2] (${v.lang}) Title ${v.t['hist.title']}`).toHaveText(v.t['hist.title']);
    });

    await step('Act: Step 3 — Check the product line under the title', async () => {
      await list.history.productLine.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — 상품 (Product) names [T079] P14 (P14)', async () => {
      for (const v of views) await expect.soft(v.list.history.productLine, `[Expected 3] (${v.lang}) ${v.t['hist.product']}: [T079] P14 (${seeded.products.P14})`).toHaveText(`${v.t['hist.product']}: [T079] P14 (${seeded.products.P14})`);
    });

    await step('Act: Step 4 — Check the table header', async () => {
      await list.history.headers.first().scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — 시점 · 수행자 · 항목 · 변경 내용 · 사유 in this order', async () => {
      for (const v of views) await expect.soft(v.list.history.headers, `[Expected 4] (${v.lang}) Five columns in order`).toHaveText([v.t['hist.colWhen'], v.t['hist.colWho'], v.t['hist.colSetting'], v.t['hist.colChange'], v.t['hist.colReason']]);
    });

    await step('Act: Step 5 — Check the row content', async () => {
      await list.history.rows.first().scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 5 — One submission row by user A; category A → B and 12.50% → 9.00% struck through; the reason; 반려 사유 by user B', async () => {
      const userA = getAccountDisplayName('submitter');
      const userB = getAccountDisplayName('approver');
      for (const v of views) {
        const h = v.list.history;
        const row = h.rows.first();
        await expect.soft(h.rows, `[Expected 5] (${v.lang}) One row for the submission`).toHaveCount(1);
        await expect.soft(h.cell(row, 'who'), `[Expected 5] (${v.lang}) ${v.t['hist.colWho']} = user A`).toHaveText(userA);
        await expect.soft(h.cell(row, 'setting'), `[Expected 5] (${v.lang}) Line ${v.t['hist.fieldCategory']}`).toContainText(v.t['hist.fieldCategory']);
        await expect.soft(h.cell(row, 'setting'), `[Expected 5] (${v.lang}) Line ${v.t['hist.fieldRate']}`).toContainText(v.t['hist.fieldRate']);
        await expect.soft(h.cell(row, 'change'), `[Expected 5] (${v.lang}) Category A → category B`).toContainText(`${seeded.master.categoryName.A} → ${seeded.master.categoryName.B}`);
        await expect.soft(h.cell(row, 'change'), `[Expected 5] (${v.lang}) Fee rate 12.50% → 9.00%`).toContainText('12.50% → 9.00%');
        const struck = await h.cell(row, 'change').evaluate((cell) =>
          Array.from(cell.querySelectorAll<HTMLElement>('*'))
            .filter((n) => n.children.length === 0 && (n.textContent ?? '').includes('→'))
            .map((n) => getComputedStyle(n).textDecorationLine.includes('line-through') || !!n.closest('del, s')),
        );
        expect.soft(struck.length > 0 && struck.every(Boolean), `[Expected 5] (${v.lang}) The target values are struck through`).toBe(true);
        await expect.soft(h.cell(row, 'reason'), `[Expected 5] (${v.lang}) ${v.t['hist.colReason']} = Wrong category mapped in commerce`).toContainText(reasonX);
        await expect.soft(h.cell(row, 'reason'), `[Expected 5] (${v.lang}) A separate block ${v.t['hist.rejectReason']}`).toContainText(v.t['hist.rejectReason']);
        await expect.soft(h.cell(row, 'reason'), `[Expected 5] (${v.lang}) The reject block names user B`).toContainText(userB);
        await expect.soft(h.cell(row, 'reason'), `[Expected 5] (${v.lang}) The reject block reads 근거 계약 확인 필요`).toContainText(rejectReason);
      }
    });

    await step('Act: Step 6 — Check the footer', async () => {
      await list.history.footer.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 6 — Footer 승인된 기안만 산정 결과를 바꿉니다. …', async () => {
      for (const v of views) await expect.soft(v.list.history.footer, `[Expected 6] (${v.lang}) Footer ${v.t['hist.footer']}`).toHaveText(v.t['hist.footer']);
    });

    await step('Act: Step 7 — Close the dialog and click 이력 (History) on row P03', async () => {
      for (const v of views) {
        await v.list.history.close();
        await v.list.openHistory(v.list.row(seeded.products.P03));
      }
    });

    await step('Assert: Expected 7 — 이 상품은 이번 기에 변경된 적이 없습니다.', async () => {
      for (const v of views) await expect.soft(v.list.history.empty, `[Expected 7] (${v.lang}) ${v.t['hist.empty']}`).toHaveText(v.t['hist.empty']);
    });
  });

  test('TC_US079_11 — The withdraw confirmation dialog states its consequence and has no reason field', async ({ page, feeReviewApi, seedData, secondSession, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_11', 'Medium', TAGS.ui, `The 승인 요청 회수 dialog of the pending P14 names the product, states that it leaves the approver's queue and is recorded in the history, has no reason field and offers 취소 / 회수; cancelling leaves P14 승인 대기 — in KO and EN. ${DATA_NOTE} ${LANG_NOTE}`);
    let seeded!: Seeded;
    let views: View[] = [];

    await step('Arrange: Pre-condition 1–15 — ROOT (R_A) + ANNEX1 (R_B9); P14 in CY_MAIN; COR_X submitted (PENDING)', async () => {
      seeded = await seedData({ tc: 11, contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      await submitDraft(feeReviewApi, seeded, 'P14', await saveDraft(feeReviewApi, seeded, 'P14', { category: 'B', reason: reasonOf('TC_US079_11', 'Wrong category mapped in commerce') }));
      await verifySeed(feeReviewApi, seeded, 12, 1, { P14: { state: 'PENDING' } });
      views = [viewOf('KO', page, list)];
    });

    await step('Act: Step 1 — Open the screen in KO and EN, select CY_MAIN and click 이번 기 수정됨 (Corrected this period)', async () => {
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id });
      views.push(await englishView(secondSession, { cycleId: seeded.cycles.CY_MAIN.id }));
      for (const v of views) await v.list.clickChip(v.list.chip('bucket.FIXED'));
    });

    await step('Assert: Expected 1 — Row P14 is listed with 승인 대기 (Awaiting approval)', async () => {
      for (const v of views) await expect(v.list.statusPills(v.list.row(seeded.products.P14)).nth(1), `[Expected 1] (${v.lang}) P14 shows ${v.t['state.PENDING']}`).toHaveText(v.t['state.PENDING']);
    });

    await step('Act: Step 2 — Click 회수 (Withdraw) on row P14', async () => {
      for (const v of views) await v.list.openWithdraw(v.list.row(seeded.products.P14));
    });

    await step('Assert: Expected 2 — The dialog 승인 요청 회수 (Withdraw approval request) opens', async () => {
      for (const v of views) await expect.soft(v.list.withdraw.title, `[Expected 2] (${v.lang}) Title ${v.t['withdraw.title']}`).toHaveText(v.t['withdraw.title']);
    });

    await step('Act: Step 3 — Check the dialog body', async () => {
      await list.withdraw.body.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Product line [T079] P14 (P14) and the body sentence', async () => {
      for (const v of views) {
        await expect.soft(v.list.withdraw.productLine, `[Expected 3] (${v.lang}) Product line [T079] P14 (${seeded.products.P14})`).toHaveText(`[T079] P14 (${seeded.products.P14})`);
        await expect.soft(v.list.withdraw.body, `[Expected 3] (${v.lang}) Body ${v.t['withdraw.body']}`).toContainText(v.t['withdraw.body']);
      }
    });

    await step('Act: Step 4 — Check the input fields and the footer buttons', async () => {
      await list.withdraw.confirmButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — No reason input or textarea; buttons 취소 and 회수', async () => {
      for (const v of views) {
        await expect.soft(v.list.withdraw.reasonField, `[Expected 4] (${v.lang}) No reason input or textarea`).toHaveCount(0);
        await expect.soft(v.list.withdraw.cancelButton, `[Expected 4] (${v.lang}) Button ${v.lang === 'KO' ? '취소' : 'Cancel'}`).toBeVisible();
        await expect.soft(v.list.withdraw.confirmButton, `[Expected 4] (${v.lang}) Button ${v.t['withdraw.confirm']}`).toHaveText(v.t['withdraw.confirm']);
      }
    });

    await step('Act: Step 5 — Click 취소 (Cancel)', async () => {
      for (const v of views) await v.list.withdraw.cancelButton.click();
    });

    await step('Assert: Expected 5 — The dialog closes; row P14 still shows 승인 대기', async () => {
      for (const v of views) {
        await expect.soft(v.list.withdraw.root, `[Expected 5] (${v.lang}) The dialog closes`).toHaveCount(0);
        await expect.soft(v.list.statusPills(v.list.row(seeded.products.P14)).nth(1), `[Expected 5] (${v.lang}) P14 still shows ${v.t['state.PENDING']}`).toHaveText(v.t['state.PENDING']);
      }
    });
  });

  test('TC_US079_12 — The Changes this period dialog renders its columns, pagination and export button', async ({ page, feeReviewApi, seedData, secondSession, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_12', 'Medium', TAGS.ui, `The period report shows the intro, the eight columns, P10 (6.75% 직접 입력 · 2단계 · 승인 대기 · user A) before P14 (A → B · 12.50% → 9.00% · 1단계 · 승인 대기 · user A), total 2 건 with 10 per page and the first / previous / 1 / next / last navigation, and the Export tooltip — in KO and EN. ${DATA_NOTE} ${LANG_NOTE} Private cycle (Expected 5 counts every correction). Expected FAIL (recon 01/10): with a single page the report shows no page navigation; the archive run saw the report ordered oldest first. UNVERIFIED: the report page navigation locator (ul.pagination) and the Export tooltip source.`);
    let seeded!: Seeded;
    let views: View[] = [];
    let reasonX = '';
    let reasonY2 = '';
    const tips: Record<'KO' | 'EN', string> = { KO: '', EN: '' };

    await step('Arrange: Pre-condition 1–17 — ROOT (R_A) + ANNEX1 (R_B9); P10 and P14 in CY_MAIN; COR_X (P14, Tier 1) then COR_Y2 (P10, Tier 2 6.75) submitted', async () => {
      seeded = await seedData({ tc: 12, private: true, contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P10', [{ cycle: 'CY_MAIN', saleLines: 86 }]), product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      reasonX = reasonOf('TC_US079_12', 'Wrong category mapped in commerce');
      reasonY2 = reasonOf('TC_US079_12', '유사 계약 요율 적용');
      await submitDraft(feeReviewApi, seeded, 'P14', await saveDraft(feeReviewApi, seeded, 'P14', { category: 'B', reason: reasonX }));
      await submitDraft(feeReviewApi, seeded, 'P10', await saveDraft(feeReviewApi, seeded, 'P10', { rate: '6.75', reason: reasonY2 }));
      await verifySeed(feeReviewApi, seeded, 14, 2, { P10: { state: 'PENDING' }, P14: { state: 'PENDING' } });
      views = [viewOf('KO', page, list)];
    });

    await step('Act: Step 1 — Open the screen in KO and EN and select CY_MAIN', async () => {
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id });
      views.push(await englishView(secondSession, { cycleId: seeded.cycles.CY_MAIN.id }));
    });

    await step('Assert: Expected 1 — The list of the cycle is shown', async () => {
      for (const v of views) await expect.soft(v.list.cycleSelect.locator('option:checked'), `[Expected 1] (${v.lang}) Cycle ${seeded.cycles.CY_MAIN.label} is shown`).toHaveText(seeded.cycles.CY_MAIN.label);
    });

    await step('Act: Step 2 — Click 이번 기 수정 내역 (Changes this period)', async () => {
      for (const v of views) await v.list.openReport();
    });

    await step('Assert: Expected 2 — The dialog 이번 기 수정 내역 (Changes this period) opens', async () => {
      for (const v of views) await expect.soft(v.list.report.title, `[Expected 2] (${v.lang}) Title ${v.t['report.title']}`).toHaveText(v.t['report.title']);
    });

    await step('Act: Step 3 — Check the intro text and the table header', async () => {
      await list.report.intro.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — Intro text; 상품ID · 수정 내용 · 요율 변동 · 단계 · 승인 · 수행자 · 시점 · 사유', async () => {
      const keys = ['report.colProductId', 'report.colChange', 'report.colRate', 'report.colTier', 'report.colApproval', 'report.colWho', 'report.colWhen', 'report.colReason'] as const;
      for (const v of views) {
        await expect.soft(v.list.report.intro, `[Expected 3] (${v.lang}) Intro ${v.t['report.intro']}`).toHaveText(v.t['report.intro']);
        await expect.soft(v.list.report.headers, `[Expected 3] (${v.lang}) Eight columns in order`).toHaveText(keys.map((k) => v.t[k]));
      }
    });

    await step('Act: Step 4 — Check the rows', async () => {
      await list.report.rows.first().scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — Newest first: P10 (6.75% 직접 입력 · 2단계 · 승인 대기 · A) then P14 (A → B · 12.50% → 9.00% · 1단계 · 승인 대기 · A)', async () => {
      const userA = getAccountDisplayName('submitter');
      for (const v of views) {
        const r = v.list.report;
        await expect.soft(r.cell(r.rows.nth(0), 'productId'), `[Expected 4] (${v.lang}) Newest first: row 1 is P10`).toHaveText(seeded.products.P10);
        await expect.soft(r.cell(r.rows.nth(1), 'productId'), `[Expected 4] (${v.lang}) Row 2 is P14`).toHaveText(seeded.products.P14);
        const p10 = r.rows.filter({ hasText: seeded.products.P10 });
        await expect.soft(r.cell(p10, 'rate'), `[Expected 4] (${v.lang}) P10 rate 6.75%`).toContainText('6.75%');
        await expect.soft(r.cell(p10, 'rate'), `[Expected 4] (${v.lang}) P10 badge ${v.t['lbl.handKeyed']}`).toContainText(v.t['lbl.handKeyed']);
        await expect.soft(r.cell(p10, 'tier'), `[Expected 4] (${v.lang}) P10 ${v.t['report.tier2']}`).toHaveText(v.t['report.tier2']);
        await expect.soft(r.cell(p10, 'approval'), `[Expected 4] (${v.lang}) P10 ${v.t['state.PENDING']}`).toHaveText(v.t['state.PENDING']);
        await expect.soft(r.cell(p10, 'who'), `[Expected 4] (${v.lang}) P10 by user A`).toHaveText(userA);
        await expect.soft(r.cell(p10, 'reason'), `[Expected 4] (${v.lang}) P10 reason 유사 계약 요율 적용`).toHaveText(reasonY2);
        const p14 = r.rows.filter({ hasText: seeded.products.P14 });
        await expect.soft(r.cell(p14, 'change'), `[Expected 4] (${v.lang}) P14 category A → category B`).toHaveText(`${seeded.master.categoryName.A} → ${seeded.master.categoryName.B}`);
        await expect.soft(r.cell(p14, 'rate'), `[Expected 4] (${v.lang}) P14 12.50% → 9.00%`).toHaveText('12.50% → 9.00%');
        await expect.soft(r.cell(p14, 'tier'), `[Expected 4] (${v.lang}) P14 ${v.t['report.tier1']}`).toHaveText(v.t['report.tier1']);
        await expect.soft(r.cell(p14, 'approval'), `[Expected 4] (${v.lang}) P14 ${v.t['state.PENDING']}`).toHaveText(v.t['state.PENDING']);
        await expect.soft(r.cell(p14, 'who'), `[Expected 4] (${v.lang}) P14 by user A`).toHaveText(userA);
        await expect.soft(r.cell(p14, 'reason'), `[Expected 4] (${v.lang}) P14 reason Wrong category mapped in commerce`).toHaveText(reasonX);
      }
    });

    await step('Act: Step 5 — Check the pagination bar', async () => {
      await list.report.counter.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 5 — Total 2 with the item name 건; 페이지당 = 10; first, previous, page 1, next, last', async () => {
      for (const v of views) {
        await expect.soft(v.list.report.counter, `[Expected 5] (${v.lang}) Total 2 with the item name ${v.t['report.pagerItemName']}`).toContainText(new RegExp(`2\\D+${esc(v.t['report.pagerItemName'])}`));
        await expect.soft(v.list.report.pageSizeSelect.locator('option:checked'), `[Expected 5] (${v.lang}) 페이지당 = 10`).toHaveText(/^10\D*$/);
        for (const control of ['First', 'Previous', '1', 'Next', 'Last']) {
          await expect.soft(v.x.reportPagination, `[Expected 5] (${v.lang}) Page navigation ${control}`).toContainText(control);
        }
      }
    });

    await step('Act: Step 6 — Hover over the 내보내기 (Export) button', async () => {
      for (const v of views) tips[v.lang] = await v.x.tooltipText(v.list.report.exportButton);
    });

    await step('Assert: Expected 6 — Tooltip 이번 기의 모든 수정 내역을 내보냅니다 — 반려·회수된 건도 포함됩니다', async () => {
      for (const v of views) expect.soft(tips[v.lang], `[Expected 6] (${v.lang}) Export tooltip ${v.t['report.exportTitle']}`).toBe(v.t['report.exportTitle']);
    });
  });

  test('TC_US079_13 — The Export dialog renders scope, format and file name in list mode and period mode', async ({ page, feeReviewApi, seedData, secondSession, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_13', 'Medium', TAGS.ui, `From 확인 필요 (P03, P05) the list-mode Export dialog shows 내보낼 범위 with period, filter 확인 필요 and 2 rows plus the list note, the format block (Excel default + CSV with their descriptions and the xlsx note → csv note on CSV), the 정산수수료_확인_<cycle>_<today> file name and 취소 / 내려받기; the period-mode dialog (from 이번 기 수정 내역) shows period and 1 row without a filter line, the report note and 정산수수료_수정내역_<cycle>_<today> — in KO and EN. ${DATA_NOTE} ${LANG_NOTE} Private cycle (row counts). Deviation: "today's date stamp" is matched as YYYYMMDD of the machine's local date.`);
    let seeded!: Seeded;
    let views: View[] = [];

    await step('Arrange: Pre-condition 1–15 — ROOT (R_A, R_B10) + ANNEX1 (R_B9); P03, P05, P14 in CY_MAIN; COR_X on P14 submitted (the only correction)', async () => {
      seeded = await seedData({ tc: 13, private: true, contracts: family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P03', [{ cycle: 'CY_MAIN', saleLines: 77 }]), product('P05', [{ cycle: 'CY_MAIN', saleLines: 151 }]), product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      await submitDraft(feeReviewApi, seeded, 'P14', await saveDraft(feeReviewApi, seeded, 'P14', { category: 'B', reason: reasonOf('TC_US079_13', 'Wrong category mapped in commerce') }));
      await verifySeed(feeReviewApi, seeded, 12, 3, { P03: { verdict: 'MISMATCH' }, P05: { verdict: 'NOT_ASSIGNED' }, P14: { state: 'PENDING' } });
      views = [viewOf('KO', page, list)];
    });

    await step('Act: Step 1 — Open the screen in KO and EN, select CY_MAIN and keep bucket 확인 필요 (Needs review)', async () => {
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id, bucket: 'EXC' });
      views.push(await englishView(secondSession, { cycleId: seeded.cycles.CY_MAIN.id, bucket: 'EXC' }));
    });

    await step('Assert: Expected 1 — Bucket 확인 필요 shows 2 rows (P03 and P05)', async () => {
      for (const v of views) {
        await expect(v.list.rows, `[Expected 1] (${v.lang}) 2 rows under ${v.t['bucket.EXC']}`).toHaveCount(2);
        for (const code of ['P03', 'P05']) await expect.soft(v.list.row(seeded.products[code]), `[Expected 1] (${v.lang}) Row ${code}`).toBeVisible();
      }
    });

    await step('Act: Step 2 — Click 목록 내보내기 (Export list)', async () => {
      for (const v of views) await v.list.openExport();
    });

    await step('Assert: Expected 2 — The dialog 내보내기 (Export) opens', async () => {
      for (const v of views) await expect.soft(v.list.exporter.title, `[Expected 2] (${v.lang}) Title ${v.t['export.title']}`).toHaveText(v.t['export.title']);
    });

    await step('Act: Step 3 — Check the scope block', async () => {
      await list.exporter.scope.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — 내보낼 범위: 정산 주기 = cycle · 필터 = 확인 필요 · 행 수 = 2; the list note', async () => {
      for (const v of views) {
        const e = v.list.exporter;
        await expect.soft(e.root.getByText(v.t['export.scopeTitle'], { exact: true }), `[Expected 3] (${v.lang}) Heading ${v.t['export.scopeTitle']}`).toBeVisible();
        await expect.soft(e.scopeValue('export.period'), `[Expected 3] (${v.lang}) ${v.t['export.period']} = ${seeded.cycles.CY_MAIN.label}`).toHaveText(seeded.cycles.CY_MAIN.label);
        await expect.soft(e.scopeValue('export.filter'), `[Expected 3] (${v.lang}) ${v.t['export.filter']} = ${v.t['bucket.EXC']}`).toHaveText(v.t['bucket.EXC']);
        await expect.soft(e.scopeValue('export.rows'), `[Expected 3] (${v.lang}) ${v.t['export.rows']} = 2`).toHaveText('2');
        await expect.soft(e.scope, `[Expected 3] (${v.lang}) Note ${v.t['export.scopeList']}`).toContainText(v.t['export.scopeList']);
      }
    });

    await step('Act: Step 4 — Check the format block', async () => {
      await new FeeReviewUiExtras(page).exportFormatLabel.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 4 — 파일 형식: Excel (.xlsx) selected by default with its description; CSV (.csv) with its description; the xlsx note', async () => {
      for (const v of views) {
        await expect.soft(v.x.exportFormatLabel, `[Expected 4] (${v.lang}) Label ${v.t['export.formatLabel']}`).toBeVisible();
        await expect.soft(v.x.exportFormatOption('xlsx'), `[Expected 4] (${v.lang}) Excel (.xlsx) is selected by default`).toBeChecked();
        await expect.soft(v.list.exporter.root, `[Expected 4] (${v.lang}) Excel (.xlsx) — ${v.t['export.xlsxDesc']}`).toContainText(`Excel (.xlsx)${v.t['export.xlsxDesc']}`);
        await expect.soft(v.x.exportFormatOption('csv'), `[Expected 4] (${v.lang}) CSV (.csv) is offered`).toBeVisible();
        await expect.soft(v.list.exporter.root, `[Expected 4] (${v.lang}) CSV (.csv) — ${v.t['export.csvDesc']}`).toContainText(`CSV (.csv)${v.t['export.csvDesc']}`);
        await expect.soft(v.x.exportNote('export.xlsxNote'), `[Expected 4] (${v.lang}) Note ${v.t['export.xlsxNote']}`).toBeVisible();
      }
    });

    await step('Act: Step 5 — Click CSV (.csv)', async () => {
      for (const v of views) await v.list.exporter.chooseFormat('csv');
    });

    await step('Assert: Expected 5 — The note changes to the UTF-8 (BOM) CSV note', async () => {
      for (const v of views) {
        await expect.soft(v.x.exportNote('export.csvNote'), `[Expected 5] (${v.lang}) Note ${v.t['export.csvNote']}`).toBeVisible();
        await expect.soft(v.x.exportNote('export.xlsxNote'), `[Expected 5] (${v.lang}) The xlsx note is replaced`).toHaveCount(0);
      }
    });

    await step('Act: Step 6 — Check the file name and the footer buttons', async () => {
      await list.exporter.downloadButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 6 — 파일명 starts with 정산수수료_확인 and carries the cycle and today; buttons 취소 and 내려받기', async () => {
      for (const v of views) {
        await expect.soft(v.x.exportFileNameLabel, `[Expected 6] (${v.lang}) Label ${v.t['export.fileName']}`).toBeVisible();
        await expect.soft(v.list.exporter.fileName, `[Expected 6] (${v.lang}) File name starts with ${v.t['export.fileList']}`).toHaveText(new RegExp(`^${esc(v.t['export.fileList'])}`));
        await expect.soft(v.list.exporter.fileName, `[Expected 6] (${v.lang}) File name carries the cycle ${seeded.cycles.CY_MAIN.label}`).toContainText(seeded.cycles.CY_MAIN.label);
        await expect.soft(v.list.exporter.fileName, `[Expected 6] (${v.lang}) File name carries today's date ${today()}`).toContainText(today());
        await expect.soft(v.list.exporter.cancelButton, `[Expected 6] (${v.lang}) Button ${v.lang === 'KO' ? '취소' : 'Cancel'}`).toBeVisible();
        await expect.soft(v.list.exporter.downloadButton, `[Expected 6] (${v.lang}) Button ${v.t['export.download']}`).toHaveText(v.t['export.download']);
      }
    });

    await step('Act: Step 7 — Click 취소, click 이번 기 수정 내역, then click 내보내기 (Export)', async () => {
      for (const v of views) {
        await v.list.exporter.cancelButton.click();
        await expect(v.list.exporter.root, 'The list-mode Export dialog closes').toHaveCount(0);
        await v.list.openReport();
        await v.list.report.exportButton.click();
      }
    });

    await step('Assert: Expected 7 — The dialog 내보내기 (Export) opens in period mode', async () => {
      for (const v of views) {
        await expect.soft(v.list.exporter.root, `[Expected 7] (${v.lang}) The Export dialog opens`).toBeVisible();
        await expect.soft(v.list.exporter.scopeReportNote, `[Expected 7] (${v.lang}) It is in period mode`).toBeVisible();
      }
    });

    await step('Act: Step 8 — Check the scope block', async () => {
      await list.exporter.scope.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 8 — 정산 주기 = cycle · 행 수 = 1; no 필터 line; the period note', async () => {
      for (const v of views) {
        const e = v.list.exporter;
        await expect.soft(e.scopeValue('export.period'), `[Expected 8] (${v.lang}) ${v.t['export.period']} = ${seeded.cycles.CY_MAIN.label}`).toHaveText(seeded.cycles.CY_MAIN.label);
        await expect.soft(e.scopeValue('export.rows'), `[Expected 8] (${v.lang}) ${v.t['export.rows']} = 1`).toHaveText('1');
        await expect.soft(e.scope.getByText(v.t['export.filter'], { exact: true }), `[Expected 8] (${v.lang}) No ${v.t['export.filter']} line`).toHaveCount(0);
        await expect.soft(e.scopeReportNote, `[Expected 8] (${v.lang}) Note ${v.t['export.scopeReport']}`).toHaveText(v.t['export.scopeReport']);
      }
    });

    await step('Act: Step 9 — Check the file name', async () => {
      await list.exporter.fileName.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 9 — 파일명 starts with 정산수수료_수정내역 and carries the cycle and today', async () => {
      for (const v of views) {
        await expect.soft(v.list.exporter.fileName, `[Expected 9] (${v.lang}) File name starts with ${v.t['export.fileReport']}`).toHaveText(new RegExp(`^${esc(v.t['export.fileReport'])}`));
        await expect.soft(v.list.exporter.fileName, `[Expected 9] (${v.lang}) File name carries the cycle ${seeded.cycles.CY_MAIN.label}`).toContainText(seeded.cycles.CY_MAIN.label);
        await expect.soft(v.list.exporter.fileName, `[Expected 9] (${v.lang}) File name carries today's date ${today()}`).toContainText(today());
      }
    });
  });

  test('TC_US079_14 — Change Approval shows the owner banner and the Fee rule impact field', async ({ page, feeReviewApi, seedData, secondSession }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_14', 'Medium', TAGS.ui, `As user B the 변경 승인 screen shows the US120 owner banner naming 수수료 규칙 records from US079; the P14 queue entry is a real 수수료 규칙 record (cycle, product, NORMAL, tier 1, submitter A); the detail shows 원장 수수료 규칙, 기안자 A and the maker reason; 영향 미리보기 shows 영향 건수 with 아직 산출할 수 없음 (no bare 0, not 234); 승인 / 반려…; the reject dialog has its own 반려 사유 (필수) field, placeholder 기안자가 무엇을 고쳐야 하는지 적어주세요 and a 0/200 counter; cancelling keeps the record pending. ${DATA_NOTE} Deviation: user B is a second browser session; 변경 승인 is opened by URL and filtered to 원장 = 수수료 규칙. Not automated: the EN pass — the Change Approval screen (US120) has no verified language switch (?lang=en is only verified on the fee review screen). Expected FAIL (recon 01/10 / build notes): no US120 owner banner; the entry shows the cycle id, not <Y>-03, and no tier; the reject label and placeholder differ from the SRS. UNVERIFIED: owner banner, reject counter and reject 취소 locators.`);
    test.skip(!hasCredentials('approver'), 'The approver account (TOKEN_B, APPROVER_*) is not configured in .env');
    let seeded!: Seeded;
    let ca1 = 0;
    let reason = '';
    let b!: { page: Page; queue: import('@pages/change-approval-queue.page').ChangeApprovalQueuePage };
    let cax!: ChangeApprovalExtras;
    const entry = () => cax.entry(b.queue.queueItems, targetRefOf(seeded, 'P14'));

    await step('Arrange: Pre-condition 1–15 — ROOT (R_A) + ANNEX1 (R_B9); P14 in CY_MAIN (234 sale lines); COR_X submitted (CA1); user B logged in', async () => {
      seeded = await seedData({ tc: 14, contracts: family({ ROOT: ['R_A'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }])] });
      reason = reasonOf('TC_US079_14', 'Wrong category mapped in commerce');
      ca1 = await submitDraft(feeReviewApi, seeded, 'P14', await saveDraft(feeReviewApi, seeded, 'P14', { category: 'B', reason }));
      const [record] = await feeReviewDb.query<RowDataPacket[]>('SELECT target_type, approval_status, impact_count, impact_status FROM change_approval WHERE id = ?', [ca1]);
      expect([record?.target_type, record?.approval_status, Number(record?.impact_count), record?.impact_status], 'Pre-condition 12: FEE_RULE, PENDING, 0, NOT_COMPUTABLE').toEqual(['FEE_RULE', 'PENDING', 0, 'NOT_COMPUTABLE']);
      const session = await secondSession('approver');
      b = { page: session.page, queue: session.queue };
      cax = new ChangeApprovalExtras(b.page);
    });

    await step('Act: Step 1 — Open 정산 관리 › 변경 승인 (Change Approval) in KO', async () => {
      await b.queue.open();
    });

    await step('Assert: Expected 1 — The screen 변경 승인 (Change Approval) opens', async () => {
      await expect(cax.heading, '[Expected 1] 변경 승인 (Change Approval) opens').toBeVisible();
    });

    await step('Act: Step 2 — Check the banner at the top of the screen', async () => {
      await cax.heading.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — The banner names US120 as the owner and says 수수료 규칙 records come from US079', async () => {
      await expect.soft(cax.ownerBanner, '[Expected 2] Banner US120의 화면입니다 (This screen belongs to US120)').toBeVisible();
      await expect.soft(cax.ownerBanner, '[Expected 2] The banner says 수수료 규칙 (Fee Rule) records come from the settlement fee review screen (US079)').toContainText(/수수료 규칙[\s\S]*US079|US079[\s\S]*수수료 규칙/);
    });

    await step('Act: Step 3 — Check the queue entry of P14', async () => {
      await b.queue.showRegister('FEE_RULE');
      await entry().scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — A real 수수료 규칙 record: cycle, product P14, NORMAL, tier 1 (category change), submitter A', async () => {
      await expect(entry(), '[Expected 3] The P14 entry is listed').toBeVisible();
      await expect.soft(entry(), '[Expected 3] Register 수수료 규칙 (Fee Rule)').toContainText('수수료 규칙');
      await expect.soft(entry(), `[Expected 3] Cycle CY_MAIN (${seeded.cycles.CY_MAIN.label})`).toContainText(seeded.cycles.CY_MAIN.label);
      await expect.soft(entry(), '[Expected 3] Product P14').toContainText(seeded.products.P14);
      await expect.soft(entry(), '[Expected 3] Policy NORMAL').toContainText('NORMAL');
      await expect.soft(entry(), '[Expected 3] Tier 1 (category change)').toContainText(/1단계|Tier 1|카테고리 변경|category change/);
      await expect.soft(entry(), '[Expected 3] Submitter user A').toContainText(getAccountDisplayName('submitter'));
    });

    await step('Act: Step 4 — Click the entry and check the detail panel', async () => {
      await b.queue.openRequest({ register: 'FEE_RULE', requester: getAccountDisplayName('submitter'), changeApprovalId: ca1, reason });
    });

    await step('Assert: Expected 4 — 원장 = 수수료 규칙 · 기안자 = user A · 사유 (기안자) = the maker reason', async () => {
      await expect.soft(b.queue.panelValue('원장'), '[Expected 4] 원장 (Register) = 수수료 규칙 (Fee Rule)').toHaveText('수수료 규칙');
      await expect.soft(b.queue.panelValue('기안자'), '[Expected 4] 기안자 (Maker) = user A').toHaveText(getAccountDisplayName('submitter'));
      await expect.soft(b.queue.reasonBlock, '[Expected 4] 사유 (기안자) = Wrong category mapped in commerce').toHaveText(reason);
    });

    await step('Act: Step 5 — Check the impact field', async () => {
      await b.queue.impactAnySection.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 5 — 영향 미리보기: 영향 건수 with 아직 산출할 수 없음; no bare 0 and not 234', async () => {
      await expect.soft(b.queue.impactPreviewHeading, '[Expected 5] Heading 영향 미리보기 (Impact preview)').toBeVisible();
      await expect.soft(cax.impactCountLabel, '[Expected 5] 영향 건수 (Records affected) is shown').toBeVisible();
      await expect.soft(cax.impactCountValue, '[Expected 5] 영향 건수 reads 아직 산출할 수 없음 (Not yet computable)').toHaveText('아직 산출할 수 없음');
      await expect.soft(cax.impactCountValue, '[Expected 5] No bare 0 is shown').not.toHaveText(/^\s*0\s*$/);
      await expect.soft(b.queue.impactAnySection, '[Expected 5] The value is not the sale line count 234').not.toContainText('234');
    });

    await step('Act: Step 6 — Check the decision buttons', async () => {
      await b.queue.rejectButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 6 — Buttons 승인 (Approve) and 반려… (Reject…) are shown', async () => {
      await expect.soft(b.queue.approveButton, '[Expected 6] 승인 (Approve)').toBeVisible();
      await expect.soft(b.queue.rejectButton, '[Expected 6] 반려… (Reject…)').toBeVisible();
    });

    await step('Act: Step 7 — Click 반려… (Reject…)', async () => {
      await b.queue.openRejectDialog();
    });

    await step('Assert: Expected 7 — The reject dialog opens', async () => {
      await expect(cax.rejectDialog, '[Expected 7] The reject dialog opens').toBeVisible();
    });

    await step('Act: Step 8 — Check the reject reason field', async () => {
      await b.queue.rejectReasonInput.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 8 — Label 반려 사유 (필수) on its own field; placeholder 기안자가 무엇을 고쳐야 하는지 적어주세요; counter 0/200', async () => {
      await expect.soft(cax.rejectDialog, '[Expected 8] Label 반려 사유 (필수) (Reason (required))').toContainText('반려 사유 (필수)');
      await expect.soft(b.queue.rejectReasonInput, '[Expected 8] Its own empty field, separate from the maker reason').toHaveValue('');
      await expect.soft(b.queue.rejectReasonInput, '[Expected 8] Placeholder 기안자가 무엇을 고쳐야 하는지 적어주세요 (What must the maker fix?)').toHaveAttribute('placeholder', '기안자가 무엇을 고쳐야 하는지 적어주세요');
      await expect.soft(cax.rejectCounter, '[Expected 8] Live counter 0/200').toBeVisible();
    });

    await step('Act: Step 9 — Click 취소 (Cancel)', async () => {
      await cax.closeRejectDialog();
    });

    await step('Assert: Expected 9 — The dialog closes; the record stays 승인 대기 (Pending)', async () => {
      await expect(cax.rejectDialog, '[Expected 9] The reject dialog is closed').toHaveCount(0);
      await expect.soft(entry(), '[Expected 9] The record stays 승인 대기 (Pending)').toContainText('승인 대기');
      const [record] = await feeReviewDb.query<RowDataPacket[]>('SELECT approval_status FROM change_approval WHERE id = ?', [ca1]);
      expect.soft(record?.approval_status, '[Expected 9] CA1 is still PENDING').toBe('PENDING');
    });
  });

  test('TC_US079_15 — Long text is clipped with a tooltip while rates, product IDs and statuses are never clipped', async ({ page, feeReviewApi, seedData, secondSession, feeReviewPage: list }) => {
    const step = makeStep(page);
    const longEn = '[T079] Limited Edition Photobook Set with Exclusive Fanclub Kit and Signed Poster Bundle for World Tour 2041 Seoul Encore';
    const longKo = '[T079] 월드투어 2041 서울 앙코르 한정판 포토북 세트 및 팬클럽 전용 키트와 친필 사인 포스터 묶음 상품';
    await tcMeta('TC_US079_15', 'Medium', TAGS.ui, `The long EN and KO product names (P03 / P04) are clipped with … on one line without growing the row or overlapping the next column, with the full name in the tooltip; P14's category cell shows A in force and B beneath it, dimmed and smaller with an arrow (a line that does not fit is clipped with a tooltip); product IDs, rates (9.00%; 12.50% with 9.00% proposed) and status pills (구간형 요율 — 산정 전; 산정 완료 + 수정됨 — 미상신) are never clipped — and the same in EN. ${DATA_NOTE} ${LANG_NOTE} Private cycle (Expected 1 counts 4 rows). "Clipped" is read as the text ending with … (the build truncates by character count) or overflowing its cell; "no broken characters" as the visible part being an exact prefix of the full name.`);
    let seeded!: Seeded;
    let en!: View;
    const ko = () => viewOf('KO', page, list);
    type NameCheck = { text: string; clipped: boolean; sameHeight: boolean; inside: boolean; prefix: boolean; tooltip: string };
    const names: Record<string, NameCheck> = {};
    let category = { first: '', second: '', smaller: false, dimmed: false, lines: [] as Array<{ text: string; ok: boolean }> };
    let full = { ids: [] as Array<[string, string, boolean]>, rates: [] as Array<[string, string, boolean]> };
    let statuses: Array<[string, string, boolean]> = [];
    const obs = new Observations(page);

    const nameCheck = async (v: View, code: 'P03' | 'P04', fullName: string): Promise<NameCheck> => {
      const cell = v.list.cell(v.list.row(seeded.products[code]), 'productName');
      const text = (await cell.innerText()).trim();
      const [h, ref] = [(await v.list.row(seeded.products[code]).boundingBox())?.height ?? 0, (await v.list.row(seeded.products.P21).boundingBox())?.height ?? 0];
      const span = cell.locator('span').first();
      const target = (await span.count()) ? span : cell;
      return {
        text,
        clipped: text.endsWith('…') || (await isClipped(cell)),
        sameHeight: Math.abs(h - ref) <= 1,
        inside: await isInsideContainerWidth(target, cell),
        prefix: fullName.startsWith(text.replace(/…$/, '').trimEnd()),
        tooltip: await v.x.tooltipText(target),
      };
    };
    const categoryCheck = async (v: View) => {
      const cell = v.list.cell(v.list.row(seeded.products.P14), 'category');
      const second = v.list.secondLine(cell);
      const style = await cell.evaluate((td) => {
        const line = td.querySelector<HTMLElement>('div.small');
        const [a, b] = [getComputedStyle(td), line ? getComputedStyle(line) : undefined];
        return { smaller: !!b && parseFloat(b.fontSize) < parseFloat(a.fontSize), dimmed: !!b && (parseFloat(b.opacity) < 1 || b.color !== a.color) };
      });
      const lines: Array<{ text: string; ok: boolean }> = [];
      for (const line of [cell, second]) {
        const text = (await line.innerText()).split('\n')[0].trim();
        if (text.endsWith('…') || (await isClipped(line))) {
          const tip = await v.x.tooltipText(line);
          lines.push({ text, ok: [seeded.master.categoryName.A, seeded.master.categoryName.B].some((n) => tip.includes(n)) });
        } else lines.push({ text, ok: true });
      }
      return { first: (await cell.innerText()).split('\n')[0].trim(), second: (await second.innerText()).trim(), ...style, lines };
    };
    const fullChecks = async (v: View) => {
      const ids: Array<[string, string, boolean]> = [];
      const rates: Array<[string, string, boolean]> = [];
      for (const code of ['P03', 'P14']) {
        const row = v.list.row(seeded.products[code]);
        ids.push([code, (await v.list.cell(row, 'productId').innerText()).trim(), await isClipped(v.list.cell(row, 'productId'))]);
        rates.push([code, (await v.list.cell(row, 'rate').innerText()).replace(/\s+/g, ' ').trim(), await isClipped(v.list.cell(row, 'rate'))]);
      }
      return { ids, rates };
    };
    const statusChecks = async (v: View): Promise<Array<[string, string, boolean]>> => {
      const out: Array<[string, string, boolean]> = [];
      for (const code of ['P21', 'P14']) {
        const pills = v.list.statusPills(v.list.row(seeded.products[code]));
        for (let i = 0; i < (await pills.count()); i++) out.push([code, (await pills.nth(i).innerText()).trim(), await isClipped(pills.nth(i))]);
      }
      return out;
    };

    await step('Arrange: Pre-condition 1–16 — ROOT (R_A, R_B10), ANNEX1 (R_B9, R_C20), ANNEX2 (R_C22), CT3 (margin 30); P03 / P04 with long names, P14, P21; COR_Y draft on P14 (A → B)', async () => {
      seeded = await seedData({
        tc: 15,
        private: true,
        contracts: family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9', 'R_C20'], ANNEX2: ['R_C22'], CT3: ['R_MARGIN'] }),
        cycles: ['CY_MAIN'],
        products: [
          product('P03', [{ cycle: 'CY_MAIN', saleLines: 77 }], { name: longEn }),
          product('P04', [{ cycle: 'CY_MAIN', saleLines: 114 }], { name: longKo }),
          product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }]),
          product('P21', [{ cycle: 'CY_MAIN', saleLines: 1 }]),
        ],
      });
      await saveDraft(feeReviewApi, seeded, 'P14', { category: 'B', reason: reasonOf('TC_US079_15', 'Wrong category mapped in commerce') });
      await verifySeed(feeReviewApi, seeded, 13, 4, { P03: { rate: '9.00' }, P04: { status: 'AMBIGUOUS' }, P14: { rate: '12.50', state: 'DRAFT' }, P21: { status: 'NOT_COMPUTABLE' } });
    });

    await step('Act: Step 1 — Open the screen in KO, select CY_MAIN, click 기간 내 판매 상품 and set 페이지당 = 20', async () => {
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id });
      await list.clickChip(list.chip('bucket.ALL'));
      await list.setPageSize('20');
    });

    await step('Assert: Expected 1 — The list shows the 4 rows of the cycle on one page', async () => {
      await expect(list.rows, '[Expected 1] 4 rows on one page').toHaveCount(4);
    });

    await step('Act: Step 2 — Look at the 상품명 cell of row P03, then hover over it', async () => {
      names.P03 = await nameCheck(ko(), 'P03', longEn);
    });

    await step('Assert: Expected 2 — Clipped with … on one line, row height unchanged, no overlap; the tooltip shows the full name', async () => {
      const c = names.P03;
      expect.soft(c.clipped, `[Expected 2] The name is clipped with … ("${c.text}")`).toBe(true);
      expect.soft(c.sameHeight, '[Expected 2] The row height does not grow (same as a short-name row)').toBe(true);
      expect.soft(c.inside, '[Expected 2] No text overlaps the next column').toBe(true);
      expect.soft(c.tooltip, '[Expected 2] The tooltip shows the full name').toBe(longEn);
    });

    await step('Act: Step 3 — Look at the 상품명 cell of row P04, then hover over it', async () => {
      names.P04 = await nameCheck(ko(), 'P04', longKo);
    });

    await step('Assert: Expected 3 — The Korean name is clipped with … on one line, no broken characters; the tooltip shows the full name', async () => {
      const c = names.P04;
      expect.soft(c.clipped, `[Expected 3] The Korean name is clipped with … ("${c.text}")`).toBe(true);
      expect.soft(c.sameHeight, '[Expected 3] One line — the row height does not grow').toBe(true);
      expect.soft(c.prefix, '[Expected 3] No broken characters — the visible part is an exact prefix of the full name').toBe(true);
      expect.soft(c.tooltip, '[Expected 3] The tooltip shows the full name').toBe(longKo);
    });

    await step('Act: Step 4 — Look at the 산정된 수수료 카테고리 cell of row P14 and hover over each line', async () => {
      category = await categoryCheck(ko());
    });

    await step('Assert: Expected 4 — Category A in force and category B beneath it, dimmed, smaller, with an arrow; a line that does not fit is clipped with a tooltip', async () => {
      expect.soft(category.first, '[Expected 4] Line 1: category A in force').toBe(seeded.master.categoryName.A);
      expect.soft(category.second, '[Expected 4] Line 2: → category B').toBe(`→ ${seeded.master.categoryName.B}`);
      expect.soft(category.smaller, '[Expected 4] Line 2 is smaller').toBe(true);
      expect.soft(category.dimmed, '[Expected 4] Line 2 is dimmed').toBe(true);
      for (const line of category.lines) expect.soft(line.ok, `[Expected 4] Line "${line.text}" fits, or is clipped with … and its tooltip shows the full category name`).toBe(true);
    });

    await step('Act: Step 5 — Look at the 상품ID and 산정 요율 cells of rows P03 and P14', async () => {
      full = await fullChecks(ko());
    });

    await step('Assert: Expected 5 — Product IDs in full; rates in full with % (P03 9.00%; P14 12.50% with 9.00% proposed)', async () => {
      for (const [code, text, clipped] of full.ids) {
        expect.soft(text, `[Expected 5] Product ID ${code} is shown in full`).toBe(seeded.products[code]);
        expect.soft(clipped, `[Expected 5] Product ID ${code} is not clipped`).toBe(false);
      }
      const rate = Object.fromEntries(full.rates.map(([code, text, clipped]) => [code, { text, clipped }]));
      expect.soft(rate.P03?.text, '[Expected 5] P03 rate 9.00%').toBe('9.00%');
      expect.soft(rate.P14?.text, '[Expected 5] P14 12.50% in force with 9.00% proposed beside it').toBe('12.50% → 9.00%');
      for (const [code, , clipped] of full.rates) expect.soft(clipped, `[Expected 5] Rate of ${code} is not clipped`).toBe(false);
    });

    await step('Act: Step 6 — Look at the 산정 상태 cells of rows P21 and P14', async () => {
      statuses = await statusChecks(ko());
    });

    await step('Assert: Expected 6 — P21 구간형 요율 — 산정 전 in full; P14 산정 완료 and 수정됨 — 미상신 in full', async () => {
      const texts = statuses.map(([code, text]) => `${code}:${text}`);
      for (const expected of [`P21:${FR_KO['status.NOT_COMPUTABLE']}`, `P14:${FR_KO['status.RESOLVED']}`, `P14:${FR_KO['state.DRAFT']}`]) expect.soft(texts, `[Expected 6] Pill ${expected} is shown in full`).toContain(expected);
      for (const [code, text, clipped] of statuses) expect.soft(clipped, `[Expected 6] Pill ${code} "${text}" is not clipped`).toBe(false);
    });

    await step('Act: Step 7 — Switch the language to EN and repeat steps 2 to 6', async () => {
      en = await englishView(secondSession, { cycleId: seeded.cycles.CY_MAIN.id, bucket: 'ALL' });
      for (const [code, fullName] of [['P03', longEn], ['P04', longKo]] as const) {
        const c = await nameCheck(en, code, fullName);
        await obs.record(`[Expected 7] (EN) ${code} name is clipped with …`, async () => c.clipped);
        await obs.record(`[Expected 7] (EN) ${code} row height does not grow`, async () => c.sameHeight);
        await obs.record(`[Expected 7] (EN) ${code} tooltip shows the full name`, async () => c.tooltip === fullName);
      }
      const cat = await categoryCheck(en);
      await obs.record('[Expected 7] (EN) P14 category: A in force, → B beneath, smaller and dimmed', async () => cat.first === seeded.master.categoryName.A && cat.second === `→ ${seeded.master.categoryName.B}` && cat.smaller && cat.dimmed);
      const f = await fullChecks(en);
      for (const [code, text, clipped] of f.ids) await obs.record(`[Expected 7] (EN) Product ID ${code} in full`, async () => text === seeded.products[code] && !clipped);
      for (const [code, text, clipped] of f.rates) await obs.record(`[Expected 7] (EN) Rate of ${code} in full with % (${text})`, async () => /%/.test(text) && !clipped);
      const s = await statusChecks(en);
      for (const expected of [`P21:${FR_EN['status.NOT_COMPUTABLE']}`, `P14:${FR_EN['status.RESOLVED']}`, `P14:${FR_EN['state.DRAFT']}`]) await obs.record(`[Expected 7] (EN) Pill ${expected} shown`, async () => s.some(([code, text]) => `${code}:${text}` === expected));
      for (const [code, text, clipped] of s) await obs.record(`[Expected 7] (EN) Pill ${code} "${text}" is not clipped`, async () => !clipped);
      await obs.screenshot('EN list — clipping checks');
    });

    await step('Assert: Expected 7 — In EN the same cells behave the same way', async () => {
      obs.assertAll();
    });
  });

  test('TC_US079_16 — No rule code, question code or table name appears in any on-screen text', async ({ page, feeReviewApi, seedData, secondSession, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_16', 'Medium', TAGS.ui, `Every text of the list (incl. banner, captions and the disabled-수정 tooltips of P14 / P21), the Why this rate dialogs of P21, P06 and P04 (reasoning expanded), the Correct dialogs of P03 (category A picked) and P10, and the History / Changes this period / Export dialogs carries no rule or question code (uppercase prefix-dash-number), no story code (US + digits), no table or column name (snake_case) and no raw enum value — in KO and EN; the P14 / P21 tooltips and the bracket explanation read as the TC states. ${DATA_NOTE} ${LANG_NOTE} Private cycle (only this TC's rows are read). Deviation: the app shell (header, sidebar, footer) is not part of the screen text; the master values the TC_08 expects on screen (판매유형 FULL_CONSIGNMENT, 정책 NORMAL / PROMOTION) and "UTF-8" in the CSV note are allowed; the correction reason carries no [AUTO-US079] tag here (it would itself read as a story code) — it is traced by the T079-<RUN>-16 product prefix.`);
    let seeded!: Seeded;
    const texts: Record<string, string> = {};
    const tips: Record<string, string> = {};
    const en: { texts: Record<string, string> } = { texts: {} };

    const readDialogs = async (v: View, into: Record<string, string>, steps: number[]) => {
      const L = v.list;
      if (steps.includes(1)) {
        into[`${v.lang} list`] = await screenText(v.page);
        into[`${v.lang} 수정 tooltips`] = `${await L.correctWrapper(L.row(seeded.products.P14)).getAttribute('title')} ${await L.correctWrapper(L.row(seeded.products.P21)).getAttribute('title')}`;
      }
      if (steps.includes(2)) {
        await L.openBasis(L.row(seeded.products.P21));
        into[`${v.lang} Why this rate P21`] = await L.basis.root.innerText();
        await L.basis.close();
      }
      if (steps.includes(3)) {
        for (const code of ['P06', 'P04']) {
          await L.openBasis(L.row(seeded.products[code]));
          await L.basis.expandEvidence();
          into[`${v.lang} Why this rate ${code}`] = await L.basis.root.innerText();
          await L.basis.close();
        }
      }
      if (steps.includes(4)) {
        await L.openCorrect(L.row(seeded.products.P03));
        await L.correct.pickCategory(seeded.master.categoryName.A);
        into[`${v.lang} Correct P03`] = await L.correct.root.innerText();
        await L.correct.cancel();
        await L.openCorrect(L.row(seeded.products.P10));
        into[`${v.lang} Correct P10`] = await L.correct.root.innerText();
        await L.correct.cancel();
      }
      if (steps.includes(5)) {
        await L.openHistory(L.row(seeded.products.P14));
        into[`${v.lang} History P14`] = await L.history.root.innerText();
        await L.history.close();
        await L.openReport();
        into[`${v.lang} Changes this period`] = await L.report.root.innerText();
        await L.report.close();
        await L.openExport();
        into[`${v.lang} Export`] = await L.exporter.root.innerText();
        await L.exporter.cancelButton.click();
        await expect(L.exporter.root, 'The Export dialog closes').toHaveCount(0);
      }
    };
    const assertClean = (into: Record<string, string>, n: number, keys: string[]) => {
      for (const key of keys) expect.soft(codesIn(into[key] ?? ''), `[Expected ${n}] "${key}" carries no rule / question / story code, table name or raw enum`).toEqual([]);
    };

    await step('Arrange: Pre-condition 1–17 — ROOT (R_A, R_B10), ANNEX1 (R_B9, R_C20), ANNEX2 (R_C22), CT3 (margin 30); P03, P04, P06, P10, P14, P21; COR_X on P14 submitted', async () => {
      seeded = await seedData({
        tc: 16,
        private: true,
        contracts: family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9', 'R_C20'], ANNEX2: ['R_C22'], CT3: ['R_MARGIN'] }),
        cycles: ['CY_MAIN'],
        products: [
          product('P03', [{ cycle: 'CY_MAIN', saleLines: 77 }]),
          product('P04', [{ cycle: 'CY_MAIN', saleLines: 114 }]),
          product('P06', [{ cycle: 'CY_MAIN', saleLines: 188 }]),
          product('P10', [{ cycle: 'CY_MAIN', saleLines: 86 }]),
          product('P14', [{ cycle: 'CY_MAIN', saleLines: 234 }]),
          product('P21', [{ cycle: 'CY_MAIN', saleLines: 1 }]),
        ],
      });
      await submitDraft(feeReviewApi, seeded, 'P14', await saveDraft(feeReviewApi, seeded, 'P14', { category: 'B', reason: `Wrong category mapped in commerce — auto ${Date.now()}` }));
      await verifySeed(feeReviewApi, seeded, 14, 6, { P04: { status: 'AMBIGUOUS' }, P06: { status: 'NO_ROW' }, P21: { status: 'NOT_COMPUTABLE' }, P14: { state: 'PENDING' } });
    });

    await step('Act: Step 1 — Open the screen in KO, select CY_MAIN, click 기간 내 판매 상품, set 페이지당 = 20; read every text and the 수정 tooltips of P14 and P21', async () => {
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id });
      await list.clickChip(list.chip('bucket.ALL'));
      await list.setPageSize('20');
      await readDialogs(viewOf('KO', page, list), texts, [1]);
      tips.P14 = (await list.correctWrapper(list.row(seeded.products.P14)).getAttribute('title')) ?? '';
      tips.P21 = (await list.correctWrapper(list.row(seeded.products.P21)).getAttribute('title')) ?? '';
    });

    await step('Assert: Expected 1 — No rule / question / story code, table / column name or raw enum; the P14 and P21 tooltips', async () => {
      assertClean(texts, 1, ['KO list', 'KO 수정 tooltips']);
      expect.soft(tips.P14, '[Expected 1] Tooltip on P14: 승인 대기 중입니다 — 먼저 회수한 뒤에 수정하세요.').toBe(FR_KO['msg.correctDisabledPending']);
      expect.soft(tips.P21, '[Expected 1] Tooltip on P21: 구간형 요율이라 이 화면에서는 산정할 수 없습니다 — …').toBe(FR_KO['msg.correctDisabledBracket']);
    });

    await step('Act: Step 2 — Click 근거 (Basis) on row P21 and read the whole dialog', async () => {
      await list.openBasis(list.row(seeded.products.P21));
      texts['KO Why this rate P21'] = await list.basis.root.innerText();
    });

    await step('Assert: Expected 2 — Heading 구간형 요율 — 아직 산정 전; the bracket body; no story name or code', async () => {
      await expect.soft(list.basis.section('trace.bracketTitle'), '[Expected 2] Heading 구간형 요율 — 아직 산정 전 (Bracket rate — not worked out yet)').toBeVisible();
      await expect.soft(list.basis.root, '[Expected 2] The body: a contract row applies, its rate moves with sales, the system works it out later, nothing to do here').toContainText(FR_KO['trace.bracketBody']);
      assertClean(texts, 2, ['KO Why this rate P21']);
      await list.basis.close();
    });

    await step('Act: Step 3 — Click 근거 (Basis) on rows P06 and P04 and read each dialog with the reasoning expanded', async () => {
      await readDialogs(viewOf('KO', page, list), texts, [3]);
    });

    await step('Assert: Expected 3 — Both dialogs explain the missing or tied rate in plain words without codes', async () => {
      for (const code of ['P06', 'P04']) expect.soft(texts[`KO Why this rate ${code}`], `[Expected 3] ${code} explains the rate in plain words (${FR_KO['trace.noRowTitle']})`).toContain(FR_KO['trace.noRowTitle']);
      assertClean(texts, 3, ['KO Why this rate P06', 'KO Why this rate P04']);
    });

    await step('Act: Step 4 — Open 수정 on P03, pick category A and read the message panel; then open 수정 on P10 and read it', async () => {
      await readDialogs(viewOf('KO', page, list), texts, [4]);
    });

    await step('Assert: Expected 4 — The message panel and all labels of both dialogs carry no rule code, story code or table name', async () => {
      assertClean(texts, 4, ['KO Correct P03', 'KO Correct P10']);
    });

    await step('Act: Step 5 — Open 이력 on P14, then 이번 기 수정 내역, then 목록 내보내기, and read each dialog', async () => {
      await readDialogs(viewOf('KO', page, list), texts, [5]);
    });

    await step('Assert: Expected 5 — The history, report and export dialogs carry no code or table name', async () => {
      assertClean(texts, 5, ['KO History P14', 'KO Changes this period', 'KO Export']);
    });

    await step('Act: Step 6 — Switch the language to EN and repeat steps 1 to 5', async () => {
      const v = await englishView(secondSession, { cycleId: seeded.cycles.CY_MAIN.id, bucket: 'ALL', pageSize: '20' });
      await readDialogs(v, en.texts, [1, 2, 3, 4, 5]);
    });

    await step('Assert: Expected 6 — The EN texts carry no such code either', async () => {
      assertClean(en.texts, 6, Object.keys(en.texts));
      expect.soft(Object.keys(en.texts).length, '[Expected 6] Every EN screen and dialog was read').toBe(10);
    });
  });

  test('TC_US079_17 — Read-only values render as plain text without an input frame', async ({ page, feeReviewApi, seedData, secondSession, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_17', 'Medium', TAGS.ui, `The computed-at text (open period) and the 마감된 기간 text (closed period) and the three values of 계약에서 산정된 값 (B · 9.00% · 산정 완료) render as plain text — no input, no border frame, no grey filled box, no focus or caret on click / Tab — in KO and EN. ${DATA_NOTE} ${LANG_NOTE} Private family and cycles (CY_CLOSE is closed and cannot be reopened). "Grey disabled box" is measured as a non-transparent, non-white background on the element itself.`);
    let seeded!: Seeded;
    const measure: Record<string, { plain: Awaited<ReturnType<typeof plainText>>; focus: boolean }> = {};
    const obs = new Observations(page);
    const ok = (m: { plain: Awaited<ReturnType<typeof plainText>>; focus: boolean }) => !m.plain.input && !m.plain.framed && !m.plain.filled && !m.plain.focusable && !m.plain.editable && !m.focus;

    const measureAt = async (locator: Locator, p: Page) => ({ plain: await plainText(locator), focus: await takesFocus(locator, p) });
    const steps2to4 = async (v: View, into: (name: string, m: { plain: Awaited<ReturnType<typeof plainText>>; focus: boolean }, text: string) => Promise<void>) => {
      await into('computed-at text', await measureAt(v.list.resolvedAtLabel, v.page), await v.list.resolvedAtLabel.innerText());
      await v.list.openCorrect(v.list.row(seeded.products.P03));
      for (const key of ['fix.kvCategory', 'fix.kvRate', 'fix.kvStatus'] as const) await into(v.t[key], await measureAt(v.list.correct.contractValue(key), v.page), await v.list.correct.contractValue(key).innerText());
      await v.list.correct.cancel();
      await v.list.selectCycle(seeded.cycles.CY_CLOSE.label);
      await into('closed-period text', await measureAt(v.list.resolvedAtLabel, v.page), await v.list.resolvedAtLabel.innerText());
    };

    await step('Arrange: Pre-condition 1–15 — ROOT (R_B10) + ANNEX1 (R_B9); P03 in CY_MAIN and CY_CLOSE; CY_CLOSE closed', async () => {
      seeded = await seedData({
        tc: 17,
        private: true,
        contracts: family({ ROOT: ['R_B10'], ANNEX1: ['R_B9'] }),
        cycles: ['CY_MAIN', 'CY_CLOSE'],
        products: [product('P03', [{ cycle: 'CY_MAIN', saleLines: 77 }, { cycle: 'CY_CLOSE', saleLines: 10 }])],
        close: ['CY_CLOSE'],
      });
      await verifySeed(feeReviewApi, seeded, 12, 1, { P03: { status: 'RESOLVED', rate: '9.00' } });
      expect((await feeReviewApi.products(seeded.cycles.CY_CLOSE.id)).provisional, 'Pre-condition 12: CY_CLOSE is not provisional').toBe(false);
    });

    await step('Act: Step 1 — Open the screen in KO and select CY_MAIN', async () => {
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id });
    });

    await step('Assert: Expected 1 — The list of the cycle is shown', async () => {
      await expect(list.row(seeded.products.P03), '[Expected 1] Row P03 of the cycle is listed').toBeVisible();
    });

    await step('Act: Step 2 — Look at the computed-at text, click on it and press Tab', async () => {
      measure.computedAt = await measureAt(list.resolvedAtLabel, page);
    });

    await step('Assert: Expected 2 — 산정 시각 <time> — 열 때마다 새로 산정됩니다 is plain text: no border, frame or grey box; no cursor, no focus', async () => {
      const m = measure.computedAt;
      await expect.soft(list.resolvedAtLabel, '[Expected 2] Text 산정 시각 <time> — 열 때마다 새로 산정됩니다').toHaveText(resolvedAtPattern(FR_KO));
      expect.soft(m.plain.input, '[Expected 2] It is not an input').toBe(false);
      expect.soft(m.plain.framed, '[Expected 2] No border or input frame').toBe(false);
      expect.soft(m.plain.filled, '[Expected 2] No grey disabled box').toBe(false);
      expect.soft(m.plain.editable || m.plain.focusable, '[Expected 2] No cursor appears (not editable / not focusable)').toBe(false);
      expect.soft(m.focus, '[Expected 2] It takes no focus on click or Tab').toBe(false);
    });

    await step('Act: Step 3 — Click 수정 (Correct) on row P03, look at 계약에서 산정된 값 and click on its values', async () => {
      await list.openCorrect(list.row(seeded.products.P03));
      for (const key of ['fix.kvCategory', 'fix.kvRate', 'fix.kvStatus'] as const) measure[key] = await measureAt(list.correct.contractValue(key), page);
    });

    await step('Assert: Expected 3 — 수수료 카테고리 = B · 산정 요율 = 9.00% · 산정 상태 = 산정 완료, all plain text; clicking places no cursor', async () => {
      const values: Array<['fix.kvCategory' | 'fix.kvRate' | 'fix.kvStatus', string]> = [['fix.kvCategory', seeded.master.categoryName.B], ['fix.kvRate', '9.00%'], ['fix.kvStatus', FR_KO['status.RESOLVED']]];
      for (const [key, value] of values) {
        await expect.soft(list.correct.contractValue(key), `[Expected 3] ${FR_KO[key]} = ${value}`).toHaveText(value);
        expect.soft(ok(measure[key]), `[Expected 3] ${FR_KO[key]} is plain text — no input frame, no disabled styling, no cursor (${JSON.stringify(measure[key])})`).toBe(true);
      }
    });

    await step(`Act: Step 4 — Click 취소, select 정산 주기 = CY_CLOSE and look at the computed-at text`, async () => {
      await list.correct.cancel();
      await list.selectCycle(seeded.cycles.CY_CLOSE.label);
      measure.closed = await measureAt(list.resolvedAtLabel, page);
    });

    await step('Assert: Expected 4 — 마감된 기간 — 요율이 확정·스탬프되었습니다 is plain text with no input frame', async () => {
      await expect.soft(list.resolvedAtLabel, '[Expected 4] Text 마감된 기간 — 요율이 확정·스탬프되었습니다').toHaveText(FR_KO['lbl.resolvedAtClosed']);
      expect.soft(ok(measure.closed), `[Expected 4] Plain text without an input frame (${JSON.stringify(measure.closed)})`).toBe(true);
    });

    await step('Act: Step 5 — Switch the language to EN and repeat steps 2 to 4', async () => {
      const v = await englishView(secondSession, { cycleId: seeded.cycles.CY_MAIN.id });
      await steps2to4(v, async (name, m, text) => obs.record(`[Expected 5] (EN) ${name} "${text}" renders as plain text without an input frame`, async () => ok(m)));
      await obs.record('[Expected 5] (EN) The closed-period text reads Closed period — rates are fixed and stamped', async () => (await v.list.resolvedAtLabel.innerText()).trim() === FR_EN['lbl.resolvedAtClosed']);
      await obs.screenshot('EN closed period');
    });

    await step('Assert: Expected 5 — The EN texts render the same way, as plain text without an input frame', async () => {
      obs.assertAll();
    });
  });
});

test.describe('[Responsive] Settlement fee review below the desktop breakpoints', () => {
  test.describe.configure({ timeout: 300_000 });

  test('TC_US079_173 — The fee review list reflows at the 1699, 1499, 1279 and 767 px breakpoints', async ({ page, feeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_173', 'Medium', TAGS.responsive, `At 1366 px the header hides the build / login-expiry and user blocks with tighter nav links while the sidebar stays and everything is visible without sideways scroll; at 1279 px the sidebar becomes a drawer opened by ☰ over a dark backdrop (closing on a backdrop click), the nav links hide and the content takes the full width; at 767 px the header padding and title shrink, the filters sit two per row with full-width action buttons and long cells clip at 150 px; at 390 px everything stays reachable without page scroll and the table scrolls inside its own container with rates and statuses never clipped. ${DATA_NOTE} Deviation: the screen is opened by URL with the cycleId parameter. Not automated: the build block (not present in the 1920 px recon, no locator), the header pill at 767 px (not identified in any recon), the 150 px tooltip (the seeded product names are short). Expected FAIL (build note): the FE has no media queries — the table scrolls sideways. UNVERIFIED: the ☰ toggle (first header icon link) and the table scroll container (parent of the table).`);
    const shell = new AppShell(page);
    const x = new FeeReviewUiExtras(page);
    const obs: Record<number, Observations> = { 1: new Observations(page), 5: new Observations(page), 6: new Observations(page), 7: new Observations(page) };
    let seeded!: Seeded;
    const base = { navGap: 0, padding: 0, titleSize: 0 };
    const at1279 = { sidebarIn: true, navVisible: true, toggle: false, contentX: 999 };
    const drawer = { open: false, backdrop: false, entry: false, closed: false };
    const navGap = async () => {
      const [a, b] = [await shell.topNavLinks.nth(0).boundingBox(), await shell.topNavLinks.nth(1).boundingBox()];
      return a && b ? b.x - (a.x + a.width) : 0;
    };
    const resize = async (width: number, height: number) => {
      await page.setViewportSize({ width, height });
      await list.untilListed(() => page.reload().then(() => undefined));
    };

    await step('Arrange: Pre-condition 1–14 — ROOT (R_A, R_B10, R_PROMO), ANNEX1 (R_B9, R_C20), ANNEX2 (R_C22); the 13 targets in CY_MAIN (P99 target only); no correction', async () => {
      seeded = await seedData({
        tc: 173,
        contracts: family({ ROOT: ['R_A', 'R_B10', 'R_PROMO'], ANNEX1: ['R_B9', 'R_C20'], ANNEX2: ['R_C22'] }),
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
      await feeReviewDb.insertTargets([{ cycleId: seeded.cycles.CY_MAIN.id, productId: `${seeded.prefix}P99`, policy: 'NORMAL', saleLineCount: 5 }]);
      expect((await feeReviewApi.products(seeded.cycles.CY_MAIN.id, { keyword: seeded.prefix })).totalElements, 'Pre-condition 12: 13 rows').toBe(13);
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id, bucket: 'ALL' });
      base.navGap = await navGap();
    });

    await step('Act: Step 1 — Set the viewport to 1366 × 768, open the screen on CY_MAIN and click 기간 내 판매 상품', async () => {
      await page.setViewportSize({ width: 1366, height: 768 });
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id });
      await list.clickChip(list.chip('bucket.ALL'));
      base.padding = await horizontalPadding(shell.banner);
      base.titleSize = await fontSize(list.pageTitle);
      const o = obs[1];
      await o.record('1366px: the login-expiry block is hidden', async () => !(await shell.loginExpiry.isVisible()));
      await o.record('1366px: the user block is hidden', async () => !(await shell.userBlock(getAccountDisplayName('submitter')).isVisible()));
      await o.record(`1366px: nav links sit closer together than at 1920px (gap ${base.navGap}px)`, async () => (await navGap()) < base.navGap);
      await o.record('1366px: the sidebar stays fixed on the left', async () => (await shell.sidebar.isVisible()) && ((await shell.sidebar.boundingBox())?.x ?? 99) <= 1);
      for (const [name, locator] of [['filters (정산 주기)', list.cycleSelect], ['filters (검색어)', list.keywordInput], ['bucket strip', list.partitionGroup], ['table', list.table], ['pager', list.counter]] as const) {
        await o.record(`1366px: ${name} is visible`, () => reachable(locator, page));
      }
      await o.record('1366px: the page has no horizontal scroll', async () => !(await hasHorizontalPageScroll(page)));
    });

    await step('Assert: Expected 1 — At 1366 px the header hides the build / login-expiry and user blocks, nav links tighten; the sidebar stays; everything visible, no horizontal scroll', async () => {
      obs[1].assertAll();
    });

    await step('Act: Step 2 — Set the viewport to 1279 × 800 and reload the screen', async () => {
      await resize(1279, 800);
      at1279.sidebarIn = (await shell.sidebar.isVisible()) && (await isWithinViewportWidth(shell.sidebar, page));
      at1279.navVisible = await shell.topNavLinks.first().isVisible();
      at1279.toggle = await shell.menuToggle.isVisible();
      at1279.contentX = (await list.pageTitle.boundingBox())?.x ?? 999;
    });

    await step('Assert: Expected 2 — At 1279 px the sidebar is an off-screen drawer, the top nav links hide, ☰ shows and the content uses the full width', async () => {
      expect.soft(at1279.sidebarIn, '[Expected 2] The sidebar is hidden off-screen').toBe(false);
      expect.soft(at1279.navVisible, '[Expected 2] The top nav links are hidden').toBe(false);
      expect.soft(at1279.toggle, '[Expected 2] The ☰ button shows').toBe(true);
      expect.soft(at1279.contentX, '[Expected 2] The content starts at the left edge (full width)').toBeLessThanOrEqual(40);
    });

    await step('Act: Step 3 — Click the ☰ menu button in the top bar', async () => {
      await shell.menuToggle.click();
      drawer.open = await expect(shell.sidebar).toBeInViewport({ timeout: 5_000 }).then(() => true, () => false);
      const vp = page.viewportSize() ?? { width: 1279, height: 800 };
      drawer.backdrop = await darkAt(page, vp.width - 20, Math.round(vp.height / 2));
      drawer.entry = await shell.sidebarEntry('nav.feeReview').isVisible();
    });

    await step('Assert: Expected 3 — The drawer slides in over a dark backdrop and lists 정산 수수료 확인·수정', async () => {
      expect.soft(drawer.open, '[Expected 3] The drawer slides in from the left').toBe(true);
      expect.soft(drawer.backdrop, '[Expected 3] A dark backdrop covers the page outside the drawer').toBe(true);
      expect.soft(drawer.entry, '[Expected 3] The drawer lists 정산 수수료 확인·수정 (Settlement fee review)').toBe(true);
    });

    await step('Act: Step 4 — Click the dark backdrop outside the drawer', async () => {
      const vp = page.viewportSize() ?? { width: 1279, height: 800 };
      await page.mouse.click(vp.width - 20, Math.round(vp.height / 2));
      drawer.closed = await expect(shell.sidebar).not.toBeInViewport({ timeout: 5_000 }).then(() => true, () => false);
    });

    await step('Assert: Expected 4 — The drawer closes', async () => {
      expect(drawer.closed, '[Expected 4] The drawer closes').toBe(true);
    });

    await step('Act: Step 5 — Set the viewport to 767 × 1024 and reload the screen', async () => {
      await resize(767, 1024);
      const o = obs[5];
      await o.record('767px: the top-bar padding is smaller than at 1366px', async () => (await horizontalPadding(shell.banner)) < base.padding);
      await o.record('767px: the page title is smaller than at 1366px', async () => (await fontSize(list.pageTitle)) < base.titleSize);
      const [cycleBox, keywordBox] = [await list.cycleLabel.locator('xpath=..').boundingBox(), await list.keywordLabel.locator('xpath=..').boundingBox()];
      await o.record('767px: the filter fields wrap two per row (same row)', async () => !!cycleBox && !!keywordBox && Math.abs(cycleBox.y - keywordBox.y) <= 2);
      for (const [name, box] of [['정산 주기', cycleBox], ['검색어', keywordBox]] as const) await o.record(`767px: the ${name} field takes about half the width`, async () => !!box && box.width / 767 >= 0.35 && box.width / 767 <= 0.6);
      const [reset, search, bar] = [await list.resetButton.boundingBox(), await list.searchButton.boundingBox(), await list.resetButton.locator('xpath=..').boundingBox()];
      await o.record('767px: the filter action buttons stretch across the width', async () => !!reset && !!search && !!bar && search.x + search.width - reset.x >= 0.9 * bar.width && bar.width >= 0.8 * 767);
      await o.record('767px: long text cells are clipped at 150 px', async () => list.cell(list.rows.first(), 'productName').evaluate((td) => {
        const el = (td.querySelector('span') ?? td) as HTMLElement;
        const max = parseFloat(getComputedStyle(el).maxWidth);
        return !Number.isNaN(max) && max <= 150;
      }));
    });

    await step('Assert: Expected 5 — At 767 px smaller padding and title; filters two per row with full-width buttons; long cells clipped at 150 px', async () => {
      obs[5].assertAll();
    });

    await step('Act: Step 6 — Set the viewport to 390 × 844 and reload the screen', async () => {
      await resize(390, 844);
      const o = obs[6];
      for (const [name, locator] of [['filter 정산 주기', list.cycleSelect], ['filter 검색어', list.keywordInput], ['search button', list.searchButton], ['bucket strip', list.chip('bucket.ALL')], ['table', list.table], ['pager', list.counter]] as const) {
        await o.record(`390px: ${name} is reachable`, () => reachable(locator, page));
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await o.record('390px: the page has no horizontal scroll', async () => !(await hasHorizontalPageScroll(page)));
      await o.record('390px: the same compact layout holds (title not larger than at 767 px)', async () => (await fontSize(list.pageTitle)) < base.titleSize);
    });

    await step('Assert: Expected 6 — At 390 px the compact layout holds; filters, bucket strip, table and pager reachable; no horizontal scroll', async () => {
      obs[6].assertAll();
    });

    await step('Act: Step 7 — At 390 px scroll the table sideways', async () => {
      const o = obs[7];
      await o.record('390px: the table scrolls inside its own container', () => scrollsInside(x.tableScroller, 'x'));
      await x.tableScroller.evaluate((el) => el.scrollBy({ left: 300 }));
      await o.record('390px: the container moved sideways', async () => (await x.tableScroller.evaluate((el) => el.scrollLeft)) > 0);
      await o.record('390px: the page stays still', async () => (await page.evaluate(() => window.scrollX)) === 0);
      for (const code of ['P01', 'P03', 'P14']) {
        const row = list.row(seeded.products[code]);
        await o.record(`390px: rate of ${code} is not clipped`, async () => !(await isClipped(list.cell(row, 'rate'))));
        await o.record(`390px: status of ${code} is not clipped`, async () => !(await isClipped(list.cell(row, 'status'))));
      }
    });

    await step('Assert: Expected 7 — The table scrolls inside its own container while the page stays still; rates and statuses never clipped', async () => {
      obs[7].assertAll();
      await page.setViewportSize({ width: 1920, height: 1080 });
    });
  });

  test('TC_US079_174 — The Correct and Why this rate dialogs stay usable below 768 px', async ({ page, feeReviewApi, seedData, feeReviewPage: list }) => {
    const step = makeStep(page);
    await tcMeta('TC_US079_174', 'Medium', TAGS.responsive, `At 767 × 1024 and 390 × 844 the Why this rate dialog of P03 fits the viewport with a 16 px side margin and no page sideways scroll, expands its three reasoning panels and scrolls only its body (title with X and footer stay in view); the Correct dialog of P10 opens inside the viewport with the contract panel, Tier 1, Tier 2 and a full-width reason box, accepts 6.75 and the reason with the counter, keeps 저장 reachable without sideways scroll, closes with X leaving P10 unchanged, and at 390 px wraps its footer buttons instead of overflowing. ${DATA_NOTE} Deviation: the screen is opened by URL with the cycleId parameter; "full dialog width" is read as ≥ 85 % of the dialog body width.`);
    const x = new FeeReviewUiExtras(page);
    const obs: Record<number, Observations> = { 1: new Observations(page), 3: new Observations(page), 4: new Observations(page), 5: new Observations(page), 6: new Observations(page), 7: new Observations(page) };
    let seeded!: Seeded;

    const openList = async (width: number, height: number) => {
      await page.setViewportSize({ width, height });
      await list.open({ cycleId: seeded.cycles.CY_MAIN.id });
      await list.clickChip(list.chip('bucket.ALL'));
    };
    const basisFits = async (o: Observations, width: number) => {
      const content = x.modalContent(list.basis.root);
      await o.record(`${width}px: Why this rate fits inside the viewport with a 16 px margin on each side`, async () => {
        const box = await content.boundingBox();
        return !!box && box.x >= 15 && box.x + box.width <= width - 15;
      });
      await o.record(`${width}px: the page has no horizontal scroll`, async () => !(await hasHorizontalPageScroll(page)));
    };
    const basisScroll = async (o: Observations, width: number) => {
      const body = x.modalBody(list.basis.root);
      await body.hover();
      await page.mouse.wheel(0, 2_000);
      await o.record(`${width}px: only the dialog body scrolls (the page stays at the top)`, async () => (await page.evaluate(() => window.scrollY)) === 0);
      await o.record(`${width}px: the title stays in view`, () => isWithinViewport(list.basis.title, page));
      await o.record(`${width}px: the X stays in view`, () => isWithinViewport(x.dialogX(list.basis.root), page));
      await o.record(`${width}px: the footer stays in view`, () => isWithinViewport(x.modalFooter(list.basis.root), page));
    };
    const correctOpens = async (o: Observations, width: number) => {
      await x.dialogX(list.basis.root).click();
      await o.record(`${width}px: Why this rate closes with X`, async () => (await list.basis.root.count()) === 0);
      await list.openCorrect(list.row(seeded.products.P10));
      await o.record(`${width}px: Correct fee resolution opens inside the viewport`, () => isWithinViewportWidth(x.modalContent(list.correct.root), page));
      for (const [name, locator] of [['계약에서 산정된 값', list.correct.fromContract], ['1단계 — 수수료 카테고리 변경', list.correct.tier1Label], ['2단계 — 요율 직접 입력', list.correct.tier2Label], ['reason box', list.correct.reasonInput]] as const) {
        await o.record(`${width}px: ${name} is shown`, () => locator.isVisible());
      }
      await o.record(`${width}px: the reason box spans the full dialog width`, async () => {
        const [input, body] = [await list.correct.reasonInput.boundingBox(), await x.modalBody(list.correct.root).boundingBox()];
        return !!input && !!body && input.width >= 0.85 * body.width;
      });
    };
    const correctTypes = async (o: Observations, width: number, reason: string) => {
      await list.correct.tier2Input.fill('6.75');
      await list.correct.reasonInput.fill(reason);
      await o.record(`${width}px: Tier 2 accepts 6.75`, async () => (await list.correct.tier2Input.inputValue()) === '6.75');
      await o.record(`${width}px: the reason box accepts the reason`, async () => (await list.correct.reasonInput.inputValue()) === reason);
      await o.record(`${width}px: the character counter shows ${[...reason].length} / 200`, async () => ((await list.correct.counter.innerText()).replace(/\s/g, '')) === `${[...reason].length}/200`);
      await o.record(`${width}px: 저장 (Save) is reachable without horizontal scroll`, () => reachable(list.correct.saveButton, page));
      for (const [i, button] of (await x.modalFooter(list.correct.root).getByRole('button').all()).entries()) {
        await o.record(`${width}px: footer button ${i + 1} stays inside the dialog (wraps instead of overflowing)`, () => isInsideContainerWidth(button, x.modalContent(list.correct.root)));
      }
      await o.screenshot(`${width}px Correct dialog filled`);
      await x.dialogX(list.correct.root).click();
      await o.record(`${width}px: X closes the Correct dialog`, async () => (await list.correct.root.count()) === 0);
      await o.record(`${width}px: P10 is unchanged (no correction saved)`, async () => !(await feeReviewApi.row(seeded.cycles.CY_MAIN.id, seeded.products.P10)).correction);
    };

    await step('Arrange: Pre-condition 1–13 — ROOT (R_A, R_B10) + ANNEX1 (R_B9); P03 and P10 in CY_MAIN; no correction', async () => {
      seeded = await seedData({ tc: 174, contracts: family({ ROOT: ['R_A', 'R_B10'], ANNEX1: ['R_B9'] }), cycles: ['CY_MAIN'], products: [product('P03', [{ cycle: 'CY_MAIN', saleLines: 77 }]), product('P10', [{ cycle: 'CY_MAIN', saleLines: 86 }])] });
      await verifySeed(feeReviewApi, seeded, 11, 2, { P03: { status: 'RESOLVED', rate: '9.00', verdict: 'MISMATCH' }, P10: { status: 'NO_ROW' } });
      expect((await feeReviewApi.options(seeded.cycles.CY_MAIN.id, seeded.products.P10)).tier2Open, 'Pre-condition 11: P10 tier2Open = true').toBe(true);
    });

    await step('Act: Step 1 — At 767 × 1024 open the screen on CY_MAIN, bucket 기간 내 판매 상품, and click 근거 (Basis) on P03', async () => {
      await openList(767, 1024);
      await list.openBasis(list.row(seeded.products.P03));
      await basisFits(obs[1], 767);
    });

    await step('Assert: Expected 1 — Why this rate fits inside the viewport with a 16 px margin; no horizontal page scroll', async () => {
      obs[1].assertAll();
    });

    await step('Act: Step 2 — Click 어떻게 결정됐는지 보기 (How this was decided)', async () => {
      await list.basis.expandEvidence();
    });

    await step('Assert: Expected 2 — Three panels open: 도출된 키, 검토된 수수료 행, 우선순위 적용 단계', async () => {
      for (const key of ['trace.keyTitle', 'trace.candTitle', 'trace.ladderTitle'] as const) {
        await expect.soft(list.basis.section(key), `[Expected 2] Panel ${FR_KO[key]} is open`).toBeVisible();
      }
    });

    await step('Act: Step 3 — Scroll inside the dialog', async () => {
      await basisScroll(obs[3], 767);
    });

    await step('Assert: Expected 3 — Only the dialog body scrolls; the title with X and the footer stay in view', async () => {
      obs[3].assertAll();
    });

    await step('Act: Step 4 — Close the dialog with X and click 수정 (Correct) on P10', async () => {
      await correctOpens(obs[4], 767);
    });

    await step('Assert: Expected 4 — The dialog closes; Correct opens inside the viewport with the contract panel, Tier 1, Tier 2 and the reason box at full width', async () => {
      obs[4].assertAll();
    });

    await step('Act: Step 5 — Type 6.75 in Tier 2 and 라벨과 합의한 별도 약정 요율 in the reason box, then close with X without saving', async () => {
      await correctTypes(obs[5], 767, '라벨과 합의한 별도 약정 요율');
    });

    await step('Assert: Expected 5 — Both fields accept the input with the counter; 저장 reachable without sideways scroll; X closes and P10 is unchanged', async () => {
      obs[5].assertAll();
    });

    await step('Act: Step 6 — Set the viewport to 390 × 844, reload, and repeat steps 1–3 on P03', async () => {
      await openList(390, 844);
      await list.openBasis(list.row(seeded.products.P03));
      await basisFits(obs[6], 390);
      await list.basis.expandEvidence();
      for (const key of ['trace.keyTitle', 'trace.candTitle', 'trace.ladderTitle'] as const) await obs[6].record(`390px: panel ${FR_KO[key]} is open`, () => list.basis.section(key).isVisible());
      await basisScroll(obs[6], 390);
    });

    await step('Assert: Expected 6 — At 390 px the Why this rate dialog behaves as in steps 1–3', async () => {
      obs[6].assertAll();
    });

    await step('Act: Step 7 — At 390 px repeat steps 4–5 on P10 with the reason "Side letter rate agreed with the label"', async () => {
      await correctOpens(obs[7], 390);
      await correctTypes(obs[7], 390, 'Side letter rate agreed with the label');
    });

    await step('Assert: Expected 7 — At 390 px the Correct dialog behaves as in steps 4–5; footer buttons wrap instead of overflowing', async () => {
      obs[7].assertAll();
      await page.setViewportSize({ width: 1920, height: 1080 });
    });
  });
});
