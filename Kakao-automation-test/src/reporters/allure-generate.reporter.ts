import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { ALLURE_RESULTS_DIR } from '../setup/constants';

const REPORT_TARGETS = [
  { rootDir: 'reports/allure-report', args: [] as string[] },
  { rootDir: 'reports/allure-report-single', args: ['--single-file'] },
];
/** Bản nhiều file giữ thư mục `history/` — nguồn nối biểu đồ Trend sang lần chạy sau. */
const HISTORY_SOURCE_ROOT = REPORT_TARGETS[0].rootDir;
const RUN_FOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;

/** `2026-09-28_14-05-12` theo giờ máy — tên thư mục report, sắp xếp theo chữ cái cũng là theo thời gian. */
function formatRunId(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

/**
 * Sinh Allure report ngay khi suite chạy xong — MỖI lần chạy 1 thư mục riêng theo thời điểm bắt đầu chạy
 * (`reports/allure-report/<runId>/`, `reports/allure-report-single/<runId>/`), report cũ giữ nguyên để truy vết.
 * `history/` của report gần nhất được chép vào results trước khi generate → tab Trend nối qua các lần chạy.
 * Phải đứng SAU `allure-playwright` trong mảng reporter để results đã ghi xong khi onEnd chạy.
 * Chỉ sinh khi có test thực sự chạy — `--list` vẫn gọi onEnd, không được tạo report rỗng.
 */
export default class AllureGenerateReporter implements Reporter {
  private executedTests = 0;
  private runId = formatRunId(new Date());

  printsToStdio(): boolean {
    return false;
  }

  onBegin(): void {
    this.runId = formatRunId(new Date());
  }

  onTestEnd(_test: TestCase, _result: TestResult): void {
    this.executedTests++;
  }

  onEnd(): void {
    if (this.executedTests === 0) return;

    const hasResults =
      fs.existsSync(ALLURE_RESULTS_DIR) && fs.readdirSync(ALLURE_RESULTS_DIR).some((file) => file.endsWith('-result.json'));
    if (!hasResults) return;

    this.carryOverHistory();
    this.writeRunInfo();

    // allure.cmd trên Windows chỉ chạy được qua shell — truyền 1 chuỗi lệnh (mọi phần đều là hằng số/runId sinh trong file này)
    const allureBin = path.resolve('node_modules', '.bin', process.platform === 'win32' ? 'allure.cmd' : 'allure');
    for (const target of REPORT_TARGETS) {
      const outputDir = path.join(target.rootDir, this.runId);
      const command = [`"${allureBin}"`, 'generate', ALLURE_RESULTS_DIR, '-o', `"${outputDir}"`, '--clean', ...target.args].join(' ');
      const result = spawnSync(command, { stdio: ['ignore', 'ignore', 'pipe'], shell: true });
      const outcome =
        result.status === 0
          ? `Allure report: ${path.resolve(outputDir, 'index.html')}`
          : `Sinh Allure report thất bại (${outputDir}): ${result.stderr?.toString().trim() || result.error?.message}`;
      process.stderr.write(`${outcome}\n`);
    }
  }

  /** Chép `history/` của lần chạy gần nhất vào results — Allure đọc nó để vẽ Trend/Retries/Duration qua các lần chạy. */
  private carryOverHistory(): void {
    if (!fs.existsSync(HISTORY_SOURCE_ROOT)) return;
    const previousRun = fs
      .readdirSync(HISTORY_SOURCE_ROOT)
      .filter((name) => RUN_FOLDER_PATTERN.test(name) && name !== this.runId)
      .sort()
      .reverse()
      .find((name) => fs.existsSync(path.join(HISTORY_SOURCE_ROOT, name, 'history')));
    if (!previousRun) return;
    fs.cpSync(path.join(HISTORY_SOURCE_ROOT, previousRun, 'history'), path.join(ALLURE_RESULTS_DIR, 'history'), {
      recursive: true,
    });
  }

  /** Nhãn lần chạy trong report: tab Executors (tên + thứ tự lần chạy) và widget Environment. */
  private writeRunInfo(): void {
    const executor = {
      name: process.env.CI ? 'CI' : 'Local',
      type: process.env.CI ? 'github' : 'local',
      buildName: `Run ${this.runId}`,
      buildOrder: Date.now(),
      reportName: `Kakao automation — ${this.runId}`,
    };
    fs.writeFileSync(path.join(ALLURE_RESULTS_DIR, 'executor.json'), JSON.stringify(executor, null, 2), 'utf-8');

    const environment = {
      Run_ID: this.runId,
      Browser: process.env.BROWSER === 'chromium' ? 'chromium' : 'msedge',
      Base_URL: process.env.BASE_URL ?? '',
      Headless: process.env.HEADLESS ?? (process.env.CI ? 'true' : 'false'),
    };
    const lines = Object.entries(environment).map(([key, value]) => `${key}=${value}`);
    fs.writeFileSync(path.join(ALLURE_RESULTS_DIR, 'environment.properties'), `${lines.join('\n')}\n`, 'utf-8');
  }
}
