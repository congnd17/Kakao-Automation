/**
 * Gộp kết quả Allure của nhiều lần chạy thành 1 report — mỗi TC (label `testId`, không có thì `historyId`) giữ kết quả
 * có thời điểm kết thúc (`stop`) MUỘN NHẤT. Dùng khi suite chạy theo đợt / chạy lại riêng case fail.
 *
 *   node scripts/merge-allure-latest.js archive <tên>   → chép reports/allure-results vào reports/run-archive/<tên>/
 *   node scripts/merge-allure-latest.js merge <prefix>  → gộp mọi reports/run-archive/<prefix>*  → reports/allure-merged/<prefix>/
 *                                                         rồi sinh reports/allure-report/<prefix>-merged + allure-report-single/<prefix>-merged
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RESULTS = path.join(ROOT, 'reports', 'allure-results');
const ARCHIVE = path.join(ROOT, 'reports', 'run-archive');

function archive(name) {
  if (!fs.existsSync(RESULTS)) throw new Error('reports/allure-results does not exist');
  const target = path.join(ARCHIVE, name);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(RESULTS, target, { recursive: true });
  const count = fs.readdirSync(target).filter((file) => file.endsWith('-result.json')).length;
  console.log(`Archived ${count} results to ${path.relative(ROOT, target)}`);
}

function attachmentSources(node, out = []) {
  for (const attachment of node.attachments ?? []) out.push(attachment.source);
  for (const step of node.steps ?? []) attachmentSources(step, out);
  return out;
}

/** Kết quả mới nhất của mỗi TC qua mọi lần chạy có tên bắt đầu `prefix`. */
function latestResults(prefix) {
  const runs = fs.readdirSync(ARCHIVE).filter((dir) => dir.startsWith(prefix)).sort();
  const latest = new Map();
  for (const run of runs) {
    const dir = path.join(ARCHIVE, run);
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('-result.json'))) {
      const result = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      // Bản 'skipped' không có testId = test không kịp chạy (lần chạy bị ngắt) — không được đè kết quả thật.
      if (result.status === 'skipped' && !result.labels?.some((label) => label.name === 'testId')) continue;
      const key = result.labels?.find((label) => label.name === 'testId')?.value ?? result.name?.split(' ')[0] ?? result.historyId;
      const current = latest.get(key);
      if (!current || (result.stop ?? 0) > (current.stop ?? 0)) latest.set(key, result);
    }
  }
  return latest;
}

/** In danh sách TC đang FAIL/BROKEN (kết quả mới nhất) + chuỗi --grep để chạy lại đúng các case đó. */
function failed(prefix) {
  const ids = [...latestResults(prefix)].filter(([, r]) => r.status === 'failed' || r.status === 'broken').map(([id]) => id).filter((id) => /^TC_/.test(id)).sort();
  console.log(`${ids.length} failing: ${ids.join(' ')}`);
  console.log(`GREP=${ids.map((id) => `${id} `).join('|')}`);
}

function merge(prefix) {
  const runs = fs.readdirSync(ARCHIVE).filter((dir) => dir.startsWith(prefix)).sort();
  if (runs.length === 0) throw new Error(`No archived run starts with "${prefix}"`);
  const latest = new Map();
  for (const run of runs) {
    const dir = path.join(ARCHIVE, run);
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('-result.json'))) {
      const result = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      // Bản 'skipped' không có testId = test không kịp chạy (lần chạy bị ngắt) — không được đè kết quả thật.
      if (result.status === 'skipped' && !result.labels?.some((label) => label.name === 'testId')) continue;
      // Khoá = TC ID (label testId; test lỗi trước khi khai metadata thì lấy từ đầu tiêu đề) — chỉ giữ test TC_*.
      const key = result.labels?.find((label) => label.name === 'testId')?.value ?? result.name?.split(' ')[0] ?? '';
      if (!/^TC_/.test(key)) continue;
      const current = latest.get(key);
      if (!current || (result.stop ?? 0) > (current.result.stop ?? 0)) latest.set(key, { dir, file, result, run });
    }
  }
  const output = path.join(ROOT, 'reports', 'allure-merged', prefix);
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  const statuses = {};
  for (const { dir, file, result } of latest.values()) {
    fs.copyFileSync(path.join(dir, file), path.join(output, file));
    for (const source of attachmentSources(result)) {
      const from = path.join(dir, source);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(output, source));
    }
    statuses[result.status] = (statuses[result.status] ?? 0) + 1;
  }
  for (const extra of ['environment.properties', 'categories.json', 'executor.json']) {
    const from = path.join(ARCHIVE, runs[runs.length - 1], extra);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(output, extra));
  }
  console.log(`Merged ${latest.size} tests from ${runs.length} runs: ${JSON.stringify(statuses)}`);
  const allure = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'allure.cmd' : 'allure');
  for (const [root, extraArgs] of [['allure-report', []], ['allure-report-single', ['--single-file']]]) {
    const target = path.join('reports', root, `${prefix}-merged`);
    const run = spawnSync(`"${allure}" generate "${path.relative(ROOT, output)}" -o "${target}" --clean ${extraArgs.join(' ')}`, { cwd: ROOT, shell: true, encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`allure generate failed for ${target}: ${run.stderr}`);
    console.log(`Allure report: ${path.join(ROOT, target, 'index.html')}`);
  }
}

const [command, name] = process.argv.slice(2);
if (command === 'archive' && name) archive(name);
else if (command === 'merge' && name) merge(name);
else if (command === 'failed' && name) failed(name);
else {
  console.error('Usage: node scripts/merge-allure-latest.js archive <name> | merge <prefix>');
  process.exit(1);
}
