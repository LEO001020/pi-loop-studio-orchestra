// Finite, restartable delivery closeout. Never resubmits a user's agent task.
// A failed network probe remains a failed attempt, even when a later one passes.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { APP_ROOT, ensureDir, readJSON, writeJSON, sha, now } from '../server/util.mjs';
import { executeProcess } from '../server/commands.mjs';
import { loadSettings, scrub } from '../server/settings.mjs';

const root = ensureDir(path.join(APP_ROOT, 'release'));
const finalFile = path.join(root, 'CLOSEOUT.json');
const previous = readJSON(finalFile, null);
// A previous success is evidence, not permission to skip checking today's
// payload. Editing a release script itself changes the manifest as well.
const directory = ensureDir(path.join(root, `closeout-${Date.now()}`));
const node = path.join(APP_ROOT, '.runtime/node-home/node.exe');
const record = { started: now(), command: process.argv, cwd: APP_ROOT,
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  directory, steps: [], status: 'RUNNING', exitCode: null };
const save = () => {
  writeJSON(path.join(directory, 'receipt.json'), JSON.parse(scrub(record)));
  writeJSON(finalFile, JSON.parse(scrub(record)));
};
async function command(name, args, timeout = 240) {
  const folder = ensureDir(path.join(directory, name));
  const receipt = await executeProcess(node, args, { cwd: APP_ROOT, timeout });
  fs.writeFileSync(path.join(folder, 'stdout.log'), receipt.stdout || '');
  fs.writeFileSync(path.join(folder, 'stderr.log'), receipt.stderr || '');
  writeJSON(path.join(folder, 'command.json'), receipt);
  record.steps.push({ name, exitCode: receipt.exitCode, durationMs: receipt.durationMs,
    receipt: path.relative(APP_ROOT, path.join(folder, 'command.json')).replaceAll('\\', '/') });
  save();
  console.log(`${name}: exit ${receipt.exitCode}`);
  return receipt;
}
function hashes() {
  const result = {};
  for (const folder of ['server', 'ui', 'tests']) {
    for (const entry of fs.readdirSync(path.join(APP_ROOT, folder), { withFileTypes: true })) {
      if (entry.isFile()) result[folder + '/' + entry.name] = sha(fs.readFileSync(path.join(APP_ROOT, folder, entry.name)));
    }
  }
  return result;
}
async function get(relative) {
  const response = await fetch(`http://127.0.0.1:${loadSettings().port}/api${relative}`,
    { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${relative}`);
  return response.json();
}
function locateReceipt(stdout) {
  for (const match of String(stdout).matchAll(/"receipt"\s*:\s*"([^"\r\n]+)"/g)) {
    const file = JSON.parse('"' + match[1] + '"');
    if (path.resolve(file).startsWith(path.join(APP_ROOT, 'validation') + path.sep) && fs.existsSync(file)) return file;
  }
  return null;
}
save();
try {
  assert.equal(process.platform, 'win32');
  const launch = await command('ensure-host', ['scripts/launch.mjs', '--no-browser'], 90);
  assert.equal(launch.exitCode, 0, launch.stderr);
  const health = await get('/health');
  assert.equal(health.app, 'pi-loop-studio');
  assert.equal(health.root.toLowerCase(), APP_ROOT.toLowerCase());
  record.health = health;
  const sessions = (await get('/sessions')).sessions;
  for (const session of sessions) {
    const state = await get(`/sessions/${session.id}`);
    assert(!state.runs.some(r => ['queued', 'running'].includes(r.status)),
      'ACTIVE_TASK_PRESENT: closeout does not interrupt or resubmit tasks');
  }
  let acceptance = readJSON(path.join(APP_ROOT, 'docs/verification/acceptance.json'), null);
  assert(acceptance, 'Run the finite acceptance harness before delivery closeout');
  assert.deepEqual(hashes(), acceptance.sourceFilesAtEnd,
    'SOURCE_CHANGED_SINCE_ACCEPTANCE: rerun the affected source checks, not a stale signature');
  const unresolvedChecks=acceptance.checks.filter(c=>!c.pass);
  const failed = acceptance.steps.filter(step => !step.pass);
  if(!process.argv.includes('--allow-blocked')){
    assert(!unresolvedChecks.length, 'An acceptance correctness check remains unresolved');
    assert(failed.every(step => step.name === 'budget-live'), 'A non-budget acceptance step remains unresolved');
  }
  record.unresolvedFunctionalChecks=unresolvedChecks;
  record.acceptanceBefore = { status: acceptance.status, directory: acceptance.directory,
    failed: failed.map(step => step.name) };

  // One optional, bounded retry. Do not loop the whole suite until an outage
  // happens to disappear, and never change concurrency or threshold to pass.
  const evidenceIndex = process.argv.indexOf('--budget-evidence');
  if (failed.length && (process.argv.includes('--retry-budget') || evidenceIndex >= 0)) {
    let result;
    if (evidenceIndex >= 0) {
      const input = path.resolve(APP_ROOT, process.argv[evidenceIndex + 1] || '');
      assert(input.startsWith(path.join(APP_ROOT, 'validation') + path.sep), 'Budget evidence must be a local validation receipt');
      const source = readJSON(path.join(input, 'command.json'), null);
      assert(source?.exitCode === 0, 'The supplied probe command did not succeed');
      assert.deepEqual(source.sourceFilesAtStart, hashes(), 'The supplied live proof tested different production sources');
      assert(source.command.some(value => /scripts[\\/]live-probe\.mjs$/.test(value)), 'Not a live-probe command');
      const output = fs.readFileSync(path.join(input, 'stdout.log'), 'utf8');
      const error = fs.readFileSync(path.join(input, 'stderr.log'), 'utf8');
      const folder = ensureDir(path.join(directory, 'budget-live-retry'));
      for (const name of ['command.json', 'stdout.log', 'stderr.log']) fs.copyFileSync(path.join(input, name), path.join(folder, name));
      result = { ...source, stdout: output, stderr: error };
      record.steps.push({ name: 'budget-live-evidence', exitCode: 0, source: path.relative(APP_ROOT, input), receipt: path.join(folder, 'command.json') });
    } else {
    const probeProcesses = await executeProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$p = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'pi-loop-studio' -and $_.CommandLine -match '(live-probe|accept-release-20260911)\\.mjs' }); Write-Output $p.Count"],
      { cwd: APP_ROOT, timeout: 20 });
    assert.equal(probeProcesses.exitCode, 0, probeProcesses.stderr);
    assert.equal(Number(probeProcesses.stdout.trim()), 0,
      'OTHER_LIVE_PROBE_RUNNING: do not compete with another acceptance request batch');
    result = await command('budget-live-retry', ['scripts/live-probe.mjs'], 180);
    }
    const receiptFile = locateReceipt(result.stdout);
    const proof = receiptFile ? readJSON(receiptFile, null) : null;
    record.budgetRetry = { exitCode: result.exitCode, receipt: receiptFile,
      status: proof?.status, peak: proof?.executorPeak, spent: proof?.settled };
    if (!unresolvedChecks.length && failed.every(step=>step.name==='budget-live') && result.exitCode === 0 && proof?.exitCode === 0 && proof.executorPeak >= 10 &&
        proof.budgetBlocked && proof.responses?.every(response => response.ok)) {
      const evidence = ensureDir(path.join(APP_ROOT, 'docs/verification/budget-closeout'));
      fs.copyFileSync(receiptFile, path.join(evidence, 'receipt.json'));
      fs.copyFileSync(path.join(directory, 'budget-live-retry/command.json'), path.join(evidence, 'command.json'));
      fs.writeFileSync(path.join(evidence, 'stdout.log'), result.stdout || '');
      fs.writeFileSync(path.join(evidence, 'stderr.log'), result.stderr || '');
      writeJSON(path.join(APP_ROOT, 'docs/verification/acceptance-before-closeout.json'), acceptance);
      acceptance = { ...acceptance, previousAcceptance: {
        status: acceptance.status, directory: acceptance.directory,
        steps: acceptance.steps, finished: acceptance.finished },
        steps: acceptance.steps.map(step => step.name === 'budget-live'
          ? { ...step, pass: true, exitCode: 0, receipt: 'docs/verification/budget-closeout/command.json',
              priorAttempt: step, completedOnRetry: true } : step),
        status: 'VERIFIED_CANDIDATE_IN_TESTED_SCOPE', exitCode: 0,
        closeoutAt: now(), closeoutBudget: record.budgetRetry };
      writeJSON(path.join(APP_ROOT, 'docs/verification/acceptance.json'), acceptance);
      const verification = path.join(APP_ROOT, 'VERIFICATION.md');
      const rows = acceptance.steps.map(step => `| ${step.name} | ${step.pass ? (step.completedOnRetry ? 'PASS（有限复测）' : 'PASS') : 'FAIL'} | ${step.exitCode} | ${step.completedOnRetry ? 'docs/verification/budget-closeout/command.json' : 'docs/verification/final-harness/' + step.name + '/command.json'} |`).join('\n');
      const metrics = [acceptance.primaryLive, acceptance.currentLive].filter(Boolean).map(value => `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``).join('\n\n');
      fs.writeFileSync(verification, `# 最终验收\n\n状态：**${acceptance.status}**\n\n分阶段收口时间：${now()}。这不是一次无失败的连续测试，也不是长期可靠性证明。\n\n| 项目 | 当前结果 | 退出码 | 包内证据 |\n|---|---|---:|---|\n${rows}\n\n## 预算实测\n\n${proof.finished}：同一源码、同一并发配置和同一预算语义。12 个执行席位、1 个主席席位、1 个辅助席位全部返回各自的唯一标记；执行请求重叠峰值 ${proof.executorPeak}，实际报告用量 ${proof.settled} token，阈值 ${proof.budget} token。达到阈值后测试的新增请求未进入传输层；没有请求预留。\n\n此前 503、连接中断及取 token 超时的尝试仍然失败，原始回执保留在 validation/ 和 docs/verification/acceptance-before-closeout.json 对应证据中；成功复测不能抹除它们。\n\n## 真实闭环任务\n\n${metrics}\n\n这两条任务跨过开发期间的暂停、恢复和宿主更新，不是同一最终源码从头无中断运行。最终源码的具体变化另经回归测试、预算与 UI 实测覆盖。第二条任务含未知 usage，spent 仅为已报告 token 小计。\n\n## 包与安装\n\n便携路径安装证据见 docs/verification/portable/receipt.json。实际最终压缩包的 SHA256 与解压安装结果分别以交付目录 release/DELIVERY.json、release/ARCHIVE-VERIFICATION.json 为准；封包成功本身不升级功能结论。\n\n完整源码哈希与验收结果见 docs/verification/acceptance.json；范围边界见 BLOCKED-UNVERIFIED.md 与 docs/PERFORMANCE-BOUNDARIES.md。\n`, 'utf8');
      const blocked = path.join(APP_ROOT, 'BLOCKED-UNVERIFIED.md');
      const older = fs.readFileSync(blocked, 'utf8');
      fs.writeFileSync(path.join(APP_ROOT, 'docs/verification/BLOCKED-before-closeout.md'), older);
      fs.writeFileSync(blocked, older.replace(/## 本轮阻塞[\s\S]*?(?=## 未验证)/, `## 本轮阻塞\n\n在本次有限功能验收范围内，没有尚未通过的检查。此前 budget-live 失败以同源码、同配置的有限复测闭合，未改写原失败。外部提供方稳定性仍是实测风险；实际压缩包安装以 release/ARCHIVE-VERIFICATION.json 为准。\n\n`) +
        `\n## ${now()} 预算探针复测\n\n证据：docs/verification/budget-closeout/receipt.json。此前提供方 503、连接失败没有被当作零费用或成功；它们不能归咎于并发资源规格，也不能因后来成功而删掉。\n`, 'utf8');
    }
  }
  record.functionalStatus = acceptance.status;
  // Always keep the status truthful in a complete, installable payload.
  // Packaging success never upgrades a failed functional acceptance result.
  for (const file of ['README.md', 'VERIFICATION.md', 'BLOCKED-UNVERIFIED.md',
      'docs/ARCHITECTURE.md', 'LICENSE', 'THIRD-PARTY.md', 'credentials.example.json']) {
    assert(fs.existsSync(path.join(APP_ROOT, file)), `Required delivery file missing: ${file}`);
  }
  // Regenerate after all documentation is finalized. release.mjs chooses a
  // content-addressed archive, preserving older packages rather than silently
  // treating their existence as proof they contain this revision.
  const packaged = await command('package', ['scripts/release.mjs', '--package'], 540);
  assert.equal(packaged.exitCode, 0, packaged.stderr || packaged.stdout);
  const checksums = await command('payload-checksums', ['scripts/release.mjs', '--verify'], 240);
  assert.equal(checksums.exitCode, 0, checksums.stderr || checksums.stdout);
  const archiveCheck = await command('actual-archive-install', ['scripts/verify-release-archive.mjs'], 540);
  assert.equal(archiveCheck.exitCode, 0, archiveCheck.stderr || archiveCheck.stdout);
  record.delivery = readJSON(path.join(root, 'DELIVERY.json'));
  record.archiveVerification = readJSON(path.join(root, 'ARCHIVE-VERIFICATION.json'));
  assert.equal(record.archiveVerification.exitCode, 0);
  record.status = acceptance.exitCode===0?'DELIVERED_WITH_VERIFIED_ARCHIVE':'PACKAGED_WITH_FUNCTIONAL_BLOCKERS';
  record.exitCode = acceptance.exitCode === 0 ? 0 : 2;
} catch (error) {
  record.status = 'CLOSEOUT_BLOCKED'; record.exitCode = 1;
  record.error = scrub(error.stack || String(error));
}
record.finished = now(); save();
console.log(JSON.stringify(record, null, 2));
process.exitCode = record.exitCode;
