import { Page } from '@playwright/test';
import { test as base } from '@fixtures/base.fixture';
import { TerritoryApi, openTerritoryApi } from '@api/territory.api';
import { TerritoryEditPage, TerritoryListPage } from '@pages/territory.page';
import { getValidSession, hasCredentials, toSessionCookies, UI_SESSION_BUFFER_MS } from '@utils/auth-token';
import { env } from '@utils/env.config';
import { TerritoryState } from '@utils/territory.data';

/**
 * Fixture suite US089. Browser chạy bằng account gốc (congnd17.fpt). Từ 29/09 (sau lần chạy đầu) cả congnd17 và
 * dungbd.fpt đều CÓ quyền ghi Territory (verify: PATCH JP 200 + khôi phục; list không còn thông báo chỉ đọc).
 * `territoryState` khôi phục mọi quốc gia test đã đụng tới trong teardown. `secondAdmin` = browser thứ hai đăng nhập
 * dungbd.fpt cho TC hai admin (TC_US089_22 / 61 / 62 / 72).
 */
type SecondAdmin = { page: Page; list: TerritoryListPage; edit: TerritoryEditPage };

type TerritoryFixtures = {
  territoryApi: TerritoryApi;
  approverTerritoryApi: TerritoryApi;
  territoryListPage: TerritoryListPage;
  territoryEditPage: TerritoryEditPage;
  territoryState: TerritoryState;
  secondAdmin: SecondAdmin;
};

export const test = base.extend<TerritoryFixtures>({
  territoryApi: async ({ playwright }, use) => {
    const { api, dispose } = await openTerritoryApi(playwright.request, 'submitter');
    await use(api);
    await dispose();
  },

  approverTerritoryApi: async ({ playwright }, use, testInfo) => {
    testInfo.skip(!hasCredentials('approver'), 'The APPROVER account (APPROVER_*) is not configured in .env');
    const { api, dispose } = await openTerritoryApi(playwright.request, 'approver');
    await use(api);
    await dispose();
  },

  territoryListPage: async ({ page }, use) => {
    await use(new TerritoryListPage(page));
  },

  territoryEditPage: async ({ page }, use) => {
    await use(new TerritoryEditPage(page));
  },

  territoryState: async ({ territoryApi }, use, testInfo) => {
    const tcId = /TC_US089_\d+/.exec(testInfo.title)?.[0] ?? testInfo.title;
    const state = new TerritoryState(territoryApi, tcId);
    await use(state);
    await state.dispose();
  },

  secondAdmin: async ({ browser }, use, testInfo) => {
    testInfo.skip(!hasCredentials('approver'), 'The second ADMIN account (APPROVER_*) is not configured in .env');
    const context = await browser.newContext({ baseURL: env.baseURL, viewport: { width: 1920, height: 1080 } });
    await context.addCookies(toSessionCookies(await getValidSession('approver', UI_SESSION_BUFFER_MS), env.baseURL));
    const page = await context.newPage();
    await use({ page, list: new TerritoryListPage(page), edit: new TerritoryEditPage(page) });
    const body = await page.screenshot({ fullPage: true }).catch(() => undefined);
    if (body) await testInfo.attach('second_admin_final_state', { body, contentType: 'image/png' });
    await context.close();
  },
});

export { expect } from '@playwright/test';
