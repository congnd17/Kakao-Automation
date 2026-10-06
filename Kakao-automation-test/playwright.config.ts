import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';
import { AUTH_STORAGE_STATE, ALLURE_RESULTS_DIR } from '@setup/constants';

dotenv.config();

const isCI = !!process.env.CI;
// Local mặc định headed (debug); CI mặc định headless. HEADLESS override cả hai khi được set.
const headless = process.env.HEADLESS ? process.env.HEADLESS === 'true' : isCI;
// Mặc định chạy trên Microsoft Edge đã cài trên máy (channel msedge). BROWSER=chromium → Chromium đi kèm Playwright.
const channel = process.env.BROWSER === 'chromium' ? undefined : 'msedge';

export default defineConfig({
  testDir: './src/tests',
  timeout: 30_000,
  expect: {
    timeout: Number(process.env.DEFAULT_TIMEOUT) || 15_000,
  },
  // Mặc định chạy tuần tự (không yêu cầu parallel execution) — tránh nhiễu report khi nhiều worker khởi động song song.
  fullyParallel: false,
  workers: 1,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,

  // Mỗi lần chạy xoá allure-results cũ trước — report chỉ chứa lần chạy mới nhất
  globalSetup: './src/setup/global-setup.ts',
  outputDir: 'reports/test-artifacts',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'reports/html', open: 'never' }],
    ['allure-playwright', { resultsDir: ALLURE_RESULTS_DIR }],
    // Tự sinh reports/allure-report + reports/allure-report-single khi suite chạy xong — giữ SAU allure-playwright
    ['./src/reporters/allure-generate.reporter.ts'],
  ],

  use: {
    baseURL: process.env.BASE_URL,
    headless,
    channel,
    viewport: { width: 1920, height: 1080 },
    screenshot: 'off', // Screenshot cuối test attach thủ công qua base.fixture.ts — tránh đính kèm trùng lặp
    video: 'off',
    trace: 'retain-on-failure',
    actionTimeout: Number(process.env.DEFAULT_TIMEOUT) || 15_000,
  },

  projects: [
    {
      // Chạy trước các test cần phiên đăng nhập — set cookie access_token, lưu storageState.
      // Tự skip nếu AUTH_TOKEN chưa cấu hình trong .env, không làm fail suite mặc định.
      name: 'setup-auth',
      testDir: './src/setup',
      testMatch: /.*\.setup\.ts/,
    },
    {
      // Test chưa cần đăng nhập (VD: /login) — KHÔNG áp storageState để giữ đúng trạng thái "chưa xác thực".
      name: 'chromium',
      testDir: './src/tests',
      testIgnore: ['**/contract/**', '**/unit-of-measure*/**', '**/payment-method-policy*/**', '**/warehouse*/**', '**/fee-rate*/**', '**/territory*/**', '**/fee-review*/**', '**/receipt-reconciliation*/**', '**/purchase-order*/**', '**/stock-US-134/**'],
      use: { ...devices['Desktop Edge'], channel, viewport: { width: 1920, height: 1080 } },
    },
    {
      // Test cần đăng nhập sẵn — đặt file trong src/tests/contract/, unit-of-measure*/, payment-method-policy*/, warehouse*/, fee-rate*/, territory*/, fee-review*/ hoặc receipt-reconciliation*/
      name: 'chromium-authenticated',
      testDir: './src/tests',
      testMatch: ['**/contract/**', '**/unit-of-measure*/**', '**/payment-method-policy*/**', '**/warehouse*/**', '**/fee-rate*/**', '**/territory*/**', '**/fee-review*/**', '**/receipt-reconciliation*/**', '**/purchase-order*/**', '**/stock-US-134/**'],
      dependencies: ['setup-auth'],
      use: {
        ...devices['Desktop Edge'],
        channel,
        viewport: { width: 1920, height: 1080 },
        storageState: AUTH_STORAGE_STATE,
      },
    },
  ],
});
