// Mở Allure report (bản nhiều file, cần server) của 1 lần chạy: mặc định lần gần nhất, hoặc runId truyền vào.
//   npm run report:allure:open                          → lần chạy gần nhất
//   npm run report:allure:open -- 2026-09-28_14-05-12   → đúng lần chạy đó
//   npm run report:allure:list                          → liệt kê mọi lần chạy đã lưu
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPORT_ROOT = path.resolve(__dirname, '..', 'reports', 'allure-report');
const RUN_FOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;

const runs = fs.existsSync(REPORT_ROOT)
  ? fs.readdirSync(REPORT_ROOT).filter((name) => RUN_FOLDER_PATTERN.test(name)).sort()
  : [];

if (process.argv[2] === '--list') {
  if (runs.length === 0) console.log('No saved Allure report yet.');
  for (const run of runs) console.log(`${run}  reports/allure-report-single/${run}/index.html`);
  process.exit(0);
}

const runId = process.argv[2] ?? runs.at(-1);
if (!runId || !runs.includes(runId)) {
  console.error(`Allure report "${runId ?? ''}" not found. Saved runs:\n${runs.join('\n') || '(none)'}`);
  process.exit(1);
}

const allureBin = path.resolve(__dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'allure.cmd' : 'allure');
const result = spawnSync(`"${allureBin}" open "${path.join(REPORT_ROOT, runId)}"`, { stdio: 'inherit', shell: true });
process.exit(result.status ?? 1);
