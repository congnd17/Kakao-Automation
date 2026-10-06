import { Page } from '@playwright/test';
import { test as base } from '@fixtures/base.fixture';
import { FeeReviewApi, openFeeReviewApi } from '@api/fee-review.api';
import { FeeReviewListPage } from '@pages/fee-review.page';
import { ChangeApprovalQueuePage } from '@pages/change-approval-queue.page';
import { AccountRole, getValidSession, hasCredentials, toSessionCookies, UI_SESSION_BUFFER_MS } from '@utils/auth-token';
import { env } from '@utils/env.config';
import { FIXTURE, FeeReviewState } from '@utils/fee-review.data';

/**
 * Fixture suite US079. Browser chạy bằng account gốc congnd17.fpt (quyền ghi màn, KHÔNG phải approver server-side).
 * `approverFeeReviewApi` = dungbd.fpt (APPROVER) — duyệt / trả lại request Fee Rule qua API. `feeReviewState` dọn mọi
 * correction test tạo trên fixture T079 dùng chung. `secondSession(role)` mở phiên trình duyệt thứ 2 (2 tab / 2 admin).
 */
type Session = { page: Page; list: FeeReviewListPage; queue: ChangeApprovalQueuePage };

type FeeReviewFixtures = {
  feeReviewApi: FeeReviewApi;
  approverFeeReviewApi: FeeReviewApi;
  feeReviewPage: FeeReviewListPage;
  approvalQueuePage: ChangeApprovalQueuePage;
  feeReviewState: FeeReviewState;
  secondSession: (role: AccountRole) => Promise<Session>;
};

export const test = base.extend<FeeReviewFixtures>({
  feeReviewApi: async ({ playwright }, use) => {
    const { api, dispose } = await openFeeReviewApi(playwright.request, 'submitter');
    await use(api);
    await dispose();
  },

  approverFeeReviewApi: async ({ playwright }, use, testInfo) => {
    testInfo.skip(!hasCredentials('approver'), 'The APPROVER account (APPROVER_*) is not configured in .env');
    const { api, dispose } = await openFeeReviewApi(playwright.request, 'approver');
    await use(api);
    await dispose();
  },

  feeReviewPage: async ({ page }, use) => {
    await use(new FeeReviewListPage(page));
  },

  approvalQueuePage: async ({ page }, use) => {
    await use(new ChangeApprovalQueuePage(page));
  },

  feeReviewState: async ({ feeReviewApi, approverFeeReviewApi }, use, testInfo) => {
    const tcId = /TC_US079_\d+/.exec(testInfo.title)?.[0] ?? testInfo.title;
    await FeeReviewState.sweep(feeReviewApi, [FIXTURE.forSave, FIXTURE.resolvedAnnex, FIXTURE.promotionWins, FIXTURE.tier2Open], (id) => (id === FIXTURE.promotionWins ? 'PROMOTION' : 'NORMAL'));
    const state = new FeeReviewState(tcId);
    await use(state);
    await state.dispose(approverFeeReviewApi);
  },

  secondSession: async ({ browser }, use, testInfo) => {
    const opened: Array<{ close: () => Promise<void>; page: Page }> = [];
    await use(async (role: AccountRole) => {
      const context = await browser.newContext({ baseURL: env.baseURL, viewport: { width: 1920, height: 1080 } });
      await context.addCookies(toSessionCookies(await getValidSession(role, UI_SESSION_BUFFER_MS), env.baseURL));
      const page = await context.newPage();
      opened.push({ close: () => context.close(), page });
      return { page, list: new FeeReviewListPage(page), queue: new ChangeApprovalQueuePage(page) };
    });
    for (const [i, s] of opened.entries()) {
      const body = await s.page.screenshot({ fullPage: true }).catch(() => undefined);
      if (body) await testInfo.attach(`second_session_${i + 1}_final_state`, { body, contentType: 'image/png' });
      await s.close();
    }
  },
});

export { expect } from '@playwright/test';
