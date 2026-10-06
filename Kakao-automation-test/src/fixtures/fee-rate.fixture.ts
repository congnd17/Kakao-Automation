import { Page } from '@playwright/test';
import { test as base } from '@fixtures/base.fixture';
import { FeeRateApi, openFeeRateApi } from '@api/fee-rate.api';
import { ChangeApprovalQueuePage } from '@pages/change-approval-queue.page';
import { FeeRateContracts } from '@utils/fee-rate.data';
import { getAccountDisplayName, getValidSession, hasCredentials, toSessionCookies, UI_SESSION_BUFFER_MS } from '@utils/auth-token';
import { env } from '@utils/env.config';

/**
 * Fixture của suite US078. auto `makerSession`: trước MỌI test gắn cookie phiên của account `approver` (dungbd.fpt — có
 * COMMERCE_CONTRACTS + APPROVER) thay cho account gốc. Browser và API (`feeRateApi`) dùng CÙNG token đã lưu — tránh phiên
 * browser bị đá ra ("다른 기기에서 로그인") khi token bị xoay giữa chừng.
 *
 * TC maker ≠ checker (từ 30/09): người GỬI là account `submitter` (anhdtv2.fpt — có COMMERCE_CONTRACTS ghi) qua
 * `submitterFeeRateApi` / `submitterContracts`; người DUYỆT là `approver` (dungbd.fpt) — browser mặc định + `feeRateApi`.
 * `approverBrowser` = browser thứ hai của người duyệt (TC_US078_79 cần 2 phiên song song).
 */
type ApproverBrowser = { page: Page; queue: ChangeApprovalQueuePage };

type FeeRateFixtures = {
  makerSession: void;
  submitterFeeRateApi: FeeRateApi;
  submitterContracts: FeeRateContracts;
  approverBrowser: ApproverBrowser;
};

const SAME_ACCOUNT = 'needs a submitter account different from the approver — set OKTA_REFRESH_TOKEN (submitter) to an account other than APPROVER_* holding COMMERCE_CONTRACTS write';

export const test = base.extend<FeeRateFixtures>({
  makerSession: [
    async ({ context }, use, testInfo) => {
      testInfo.skip(!hasCredentials('approver'), 'The contract-capable account (APPROVER_*) is not configured in .env');
      const tokens = await getValidSession('approver', UI_SESSION_BUFFER_MS);
      await context.clearCookies();
      await context.addCookies(toSessionCookies(tokens, env.baseURL));
      await use();
    },
    { auto: true },
  ],

  submitterFeeRateApi: async ({ playwright }, use, testInfo) => {
    testInfo.skip(!hasCredentials('submitter') || getAccountDisplayName('submitter') === getAccountDisplayName('approver'), SAME_ACCOUNT);
    const { api, dispose } = await openFeeRateApi(playwright.request, 'submitter');
    await use(api);
    await dispose();
  },

  /** Contract do người gửi tạo — teardown rút lại mọi đơn còn 승인 대기 (chỉ người gửi rút được đơn của mình). */
  submitterContracts: async ({ submitterFeeRateApi }, use) => {
    const contracts = new FeeRateContracts(submitterFeeRateApi);
    await use(contracts);
    await contracts.dispose();
  },

  approverBrowser: async ({ browser }, use) => {
    const context = await browser.newContext({ baseURL: env.baseURL, viewport: { width: 1920, height: 1080 } });
    await context.addCookies(toSessionCookies(await getValidSession('approver', UI_SESSION_BUFFER_MS), env.baseURL));
    const page = await context.newPage();
    await use({ page, queue: new ChangeApprovalQueuePage(page) });
    await context.close();
  },
});

export { expect } from '@playwright/test';
