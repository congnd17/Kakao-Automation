import { Page } from '@playwright/test';
import { test as base } from '@fixtures/base.fixture';
import { FeeReviewApi, openFeeReviewApi } from '@api/fee-review.api';
import { FeeRateApi, openFeeRateApi } from '@api/fee-rate.api';
import { FeeReviewListPage } from '@pages/fee-review.page';
import { ChangeApprovalQueuePage } from '@pages/change-approval-queue.page';
import { AccountRole, getValidSession, hasCredentials, toSessionCookies, UI_SESSION_BUFFER_MS } from '@utils/auth-token';
import { env } from '@utils/env.config';
import { RUN, seed, Seeded, SeedSpec } from '@utils/fee-review-seed';
import { feeReviewDb } from '@utils/fee-review-db';

/**
 * Fixture suite US079 v1 (`input/TESTCASE_US079_v1.md`). TOKEN_A = account `submitter` (maker — quyền ghi màn + contract,
 * quyết định 01/10: anhdtv2.fpt); TOKEN_B = account `approver` (dungbd.fpt). Browser mặc định đăng nhập bằng TOKEN_A.
 * `seedData(spec)` dựng dữ liệu của TC qua API + MySQL và tự dọn (SQL DELETE theo tiền tố sản phẩm) ở teardown.
 */
type Session = { page: Page; list: FeeReviewListPage; queue: ChangeApprovalQueuePage };

type FeeReviewV1Fixtures = {
  /** Màn 정산 수수료 확인·수정 — TOKEN_A. */
  feeReviewApi: FeeReviewApi;
  /** Cùng register — TOKEN_B (approver). */
  approverFeeReviewApi: FeeReviewApi;
  /** Contract / fee row — TOKEN_A. */
  contractsApi: FeeRateApi;
  /** Contract / fee row — TOKEN_B (duyệt thay đổi fee row của TOKEN_A). */
  approverContractsApi: FeeRateApi;
  feeReviewPage: FeeReviewListPage;
  approvalQueuePage: ChangeApprovalQueuePage;
  seedData: (spec: SeedSpec) => Promise<Seeded>;
  secondSession: (role: AccountRole) => Promise<Session>;
};

type FeeReviewV1WorkerFixtures = {
  /** Lưới an toàn: hết worker thì dọn mọi dòng của RUN hiện tại (test bị cắt ngang có thể bỏ sót teardown — run 01/10 TC_10). */
  runCleanup: void;
};

export const test = base.extend<FeeReviewV1Fixtures, FeeReviewV1WorkerFixtures>({
  runCleanup: [
    async ({}, use) => {
      await use();
      await feeReviewDb.cleanupPrefix(`T079-${RUN}-`);
      await feeReviewDb.close();
    },
    { scope: 'worker', auto: true },
  ],

  feeReviewApi: async ({ playwright }, use) => {
    const { api, dispose } = await openFeeReviewApi(playwright.request, 'submitter');
    await use(api);
    await dispose();
  },

  approverFeeReviewApi: async ({ playwright }, use, testInfo) => {
    testInfo.skip(!hasCredentials('approver'), 'The approver account (TOKEN_B, APPROVER_*) is not configured in .env');
    const { api, dispose } = await openFeeReviewApi(playwright.request, 'approver');
    await use(api);
    await dispose();
  },

  contractsApi: async ({ playwright }, use) => {
    const { api, dispose } = await openFeeRateApi(playwright.request, 'submitter');
    await use(api);
    await dispose();
  },

  approverContractsApi: async ({ playwright }, use, testInfo) => {
    testInfo.skip(!hasCredentials('approver'), 'The approver account (TOKEN_B, APPROVER_*) is not configured in .env');
    const { api, dispose } = await openFeeRateApi(playwright.request, 'approver');
    await use(api);
    await dispose();
  },

  feeReviewPage: async ({ page }, use) => {
    await use(new FeeReviewListPage(page));
  },

  approvalQueuePage: async ({ page }, use) => {
    await use(new ChangeApprovalQueuePage(page));
  },

  seedData: async ({ contractsApi, feeReviewApi }, use, testInfo) => {
    const seeded: Seeded[] = [];
    await use(async (spec: SeedSpec) => {
      const data = await seed(contractsApi, feeReviewApi, spec);
      seeded.push(data);
      await testInfo.attach('seeded_data', {
        body: JSON.stringify({ run: data.run, prefix: data.prefix, contracts: data.family.contracts, feeRows: data.family.rows, cycles: data.cycles, products: data.products }, null, 2),
        contentType: 'application/json',
      });
      return data;
    });
    for (const data of seeded) await data.cleanup();
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
