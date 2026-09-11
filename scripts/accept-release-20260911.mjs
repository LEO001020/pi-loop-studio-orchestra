// Finite release harness: inspect existing task identities, never resubmit them.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {APP_ROOT,ensureDir,writeJSON,readJSON,sha,now} from '../server/util.mjs';
import {executeProcess,taskEnvironment} from '../server/commands.mjs';
import {loadSettings,scrub} from '../server/settings.mjs';

const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const runId=arg('--run')||'3230e182-be8d-4815-8e67-e3ab76742564';
const currentId=arg('--current-run')||readJSON(path.join(APP_ROOT,'validation/final-live-identity.json'),{})?.runId;
const dir=ensureDir(path.join(APP_ROOT,'validation',`acceptance-${Date.now()}`));
const evidence=ensureDir(path.join(APP_ROOT,'docs/verification'));
const base=`http://127.0.0.1:${loadSettings().port}`,node=path.join(APP_ROOT,'.runtime/node-home/node.exe');
const report={kind:'FINITE_RELEASE_HARNESS',started:now(),command:process.argv,cwd:APP_ROOT,environment:{node:process.version,platform:process.platform,arch:process.arch},directory:dir,runId,currentId,steps:[],checks:[],status:'IN_PROGRESS',exitCode:null};
function codeHashes(){const hashes={};for(const folder of ['server','ui','tests'])for(const e of fs.readdirSync(path.join(APP_ROOT,folder),{withFileTypes:true}))if(e.isFile())hashes[folder+'/'+e.name]=sha(fs.readFileSync(path.join(APP_ROOT,folder,e.name)));return hashes;}
report.sourceFilesAtStart=codeHashes();
const persist=()=>writeJSON(path.join(dir,'receipt.json'),JSON.parse(scrub(report)));
function check(name,pass,detail){report.checks.push({name,pass,detail});persist();}
async function step(name,args,{timeout=180,modelCalls=false}={}){
  const r=await executeProcess(node,args,{cwd:APP_ROOT,timeout});
  const folder=ensureDir(path.join(dir,name));
  fs.writeFileSync(path.join(folder,'stdout.log'),r.stdout||'');fs.writeFileSync(path.join(folder,'stderr.log'),r.stderr||'');writeJSON(path.join(folder,'command.json'),r);
  report.steps.push({name,pass:r.exitCode===0,exitCode:r.exitCode,modelCalls,durationMs:r.durationMs,receipt:path.relative(APP_ROOT,path.join(folder,'command.json')).replaceAll('\\','/')});
  console.log(`${r.exitCode===0?'PASS':'FAIL'} ${name} (exit ${r.exitCode}, ${r.durationMs}ms)`);persist();return r;
}
async function get(url){const r=await fetch(base+'/api'+url,{signal:AbortSignal.timeout(30000)});const d=await r.json();if(!r.ok)throw new Error(JSON.stringify(d));return d;}
function peak(calls,dispatch){let n=0,p=0;for(const [,delta]of calls.flatMap(c=>[[Date.parse(dispatch.get(c.id)),1],[Date.parse(c.ended),-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1])){n+=delta;p=Math.max(n,p);}return p;}
async function inspectLive(id,label){
  const full=await get(`/runs/${id}/export`);writeJSON(path.join(evidence,`${label}-run.json`),full);
  const dispatch=new Map(full.events.filter(e=>e.type==='call.dispatched').map(e=>[e.data.id,e.at]));
  const success=full.calls.filter(c=>c.role==='executor'&&c.status==='completed'&&c.tokens>0&&c.ended&&dispatch.has(c.id));
  const metrics={id,status:full.run.status,created:full.run.created,updated:full.run.updated,spent:full.run.spent,budget:full.run.budget,requests:full.calls.length,roles:full.metrics.roles,unknown:full.metrics.unknown,executorPeak:peak(success,dispatch),executionOnlyPeak:peak(success.filter(c=>/-work-\d+$/.test(c.node)),dispatch),jobs:full.jobs.length,integrated:full.jobs.filter(j=>j.integratedCommit).length,workspace:full.run.workspace,publication:full.run.context.steps['publishing:0']?.result?.status};
  check(`${label}: mandatory graph, independent audit and publication`,full.run.status==='completed'&&full.jobs.length>=10&&full.jobs.every(j=>j.supersededByRound!==undefined||(j.audit?.pass&&j.integratedCommit))&&Object.keys(full.run.context.steps).some(k=>k.startsWith('publishing:')),metrics);
  check(`${label}: >=10 successful execution dispatch intervals`,metrics.executionOnlyPeak>=10,metrics.executionOnlyPeak);
  check(`${label}: reported usage matches ledger and unknowns stay explicit`,full.run.spent===full.calls.reduce((n,c)=>n+(c.tokens||0),0)&&full.metrics.unknown===full.calls.filter(c=>c.unknown).length,{knownTokens:metrics.spent,unknownCalls:metrics.unknown});
  if(full.run.status!=='completed'){
    check(`${label}: independent native tests`,false,{status:'UNVERIFIED',reason:'任务未发布；不在未完成的原始工作区安装、构建或改变文件。'});
    return metrics;
  }
  const cwd=full.run.workspace,env=taskEnvironment(cwd),pkg=readJSON(path.join(cwd,'package.json'),{}),npm=path.join(APP_ROOT,'.runtime/node-home/node_modules/npm/bin/npm-cli.js');
  if(fs.existsSync(path.join(cwd,'package-lock.json'))){
    const setup=await executeProcess(node,[npm,'ci','--ignore-scripts','--no-audit','--no-fund'],{cwd,env,timeout:180});writeJSON(path.join(evidence,`${label}-independent-install.json`),setup);
    check(`${label}: independent lockfile installation`,setup.exitCode===0,{exitCode:setup.exitCode,stderr:setup.stderr.slice(-1200)});
  }
  const command=await executeProcess(node,pkg.scripts?.test?[npm,'test']:['--test'],{cwd,env,timeout:180});writeJSON(path.join(evidence,`${label}-independent-tests.json`),command);
  metrics.independentTestSummary=command.stdout.slice(-350);
  check(`${label}: independent native tests`,command.exitCode===0&&/pass (?:[5-9]\d|[1-9]\d{2,})/.test(command.stdout),{exitCode:command.exitCode,summary:metrics.independentTestSummary});
  const fixture=readJSON(path.join(APP_ROOT,'validation/c3-live-project-identity.json'),null);
  if(fixture?.runId===id){
    const changed=Object.entries(fixture.protectedFiles).filter(([file,hash])=>!fs.existsSync(path.join(cwd,file))||sha(fs.readFileSync(path.join(cwd,file)))!==hash).map(([file])=>file);
    metrics.originalAcceptanceFilesUnchanged=changed.length===0;check(`${label}: original build, dependency lock and tests unchanged`,!changed.length,changed);
    const sources=fs.readdirSync(path.join(cwd,'src')).filter(f=>f.endsWith('.ts'));
    check(`${label}: ten actual dependency-using modules`,sources.length===10&&sources.every(file=>/from\s+['"]zod['"]/.test(fs.readFileSync(path.join(cwd,'src',file),'utf8'))),sources);
    metrics.buildValidation='Native Node TypeScript erasure + runtime tests; NOT tsc type checking';
    metrics.generatedArtifacts=Object.values(full.run.context.steps).flatMap(step=>step.result?.generatedArtifacts||[]).map(f=>f.path);
  }
  return metrics;
}
persist();
try{
  await step('build',['.runtime/node-home/node_modules/npm/bin/npm-cli.js','run','build']);
  await step('regression',['--test','tests/core.test.mjs','tests/workflow.test.mjs','tests/http.test.mjs','tests/transport.test.mjs','tests/runtime-boundaries.test.mjs'],{timeout:240});
  await step('foundations',['scripts/verify-foundations.mjs'],{timeout:240});
  await step('dependency-isolation',['scripts/verify-dependency-isolation.mjs'],{timeout:240});
  await step('launch',['scripts/launch.mjs','--no-browser'],{timeout:90});
  report.health=await get('/health');assert.equal(report.health.root,APP_ROOT);assert.equal(report.health.app,'pi-loop-studio');
  const active=[];for(const s of (await get('/sessions')).sessions){const d=await get(`/sessions/${s.id}`);active.push(...d.runs.filter(r=>['running','queued'].includes(r.status)));}
  check('No active work interrupted by the release harness',active.length===0,active.map(r=>({id:r.id,status:r.status})));
  if(active.length)throw new Error('ACTIVE_TASK_PRESENT: final live probes and restart wait for the active task to finish.');
  report.primaryLive=await inspectLive(runId,'primary-live');
  if(currentId)report.currentLive=await inspectLive(currentId,'final-source-live');else check('Final source live task identity present',false,'No identity file; no invented task evidence.');
  await step('budget-live',['scripts/live-probe.mjs'],{timeout:180,modelCalls:true});
  await step('ui',['scripts/ui-acceptance.mjs','--inspect-run',runId],{timeout:300,modelCalls:true});
  await step('restart',['scripts/verify-restart.mjs'],{timeout:120});
  report.sourceFilesAtEnd=codeHashes();check('No production source changed during checks',JSON.stringify(report.sourceFilesAtStart)===JSON.stringify(report.sourceFilesAtEnd),report.sourceFilesAtEnd);
}catch(error){report.fatal=scrub(error.stack);check('Harness finished all requested checks',false,report.fatal);}
report.exitCode=report.steps.every(s=>s.pass)&&report.checks.every(c=>c.pass)&&!report.fatal?0:1;
report.status=report.exitCode===0?'VERIFIED_CANDIDATE_IN_TESTED_SCOPE':'BLOCKED_FINAL_ACCEPTANCE';report.finished=now();persist();
fs.cpSync(dir,path.join(evidence,'final-harness'),{recursive:true});
for(const s of report.steps){
  const command=readJSON(path.join(APP_ROOT,s.receipt));
  for(const m of String(command.stdout||'').matchAll(/"receipt"\s*:\s*"([^"\r\n]+)"/g)){
    let receipt;try{receipt=JSON.parse('"'+m[1]+'"');}catch{continue;}
    if(!fs.existsSync(receipt)||!path.resolve(receipt).startsWith(path.join(APP_ROOT,'validation')+path.sep))continue;
    const target=ensureDir(path.join(evidence,s.name));fs.copyFileSync(receipt,path.join(target,'receipt.json'));
    for(const file of fs.readdirSync(path.dirname(receipt)))if(file.endsWith('.png'))fs.copyFileSync(path.join(path.dirname(receipt),file),path.join(target,file));
  }
}
writeJSON(path.join(evidence,'acceptance.json'),report);
const known=['OS 安全沙箱未实现；当前用户权限下的恶意代码可绕过路径与依赖约定。','未完成 24 小时以上 soak、真实大型多语言仓库任务集和总体成功率评估。','少数真实任务不能证明全局最优或优于所有候选拓扑；用户视觉和使用满意度尚未确认。','跨文件发布不是原子事务；预检与写入之间不能保证抵御外部编辑器的所有竞态。','长上下文摘要的保真度、跨模型扩展兼容性、任意 Pi 第三方扩展没有完整实测。','未实现旧版全部会话状态的自动迁移；旧目录作为只读证据保存。'];
const failing=[...report.steps.filter(s=>!s.pass).map(s=>`${s.name}: exit ${s.exitCode}，${s.receipt}`),...report.checks.filter(c=>!c.pass).map(c=>`${c.name}: ${JSON.stringify(c.detail)}`)];
const rows=report.steps.map(s=>`| ${s.name} | ${s.pass?'PASS':'FAIL'} | ${s.exitCode} | ${s.modelCalls?'真实模型':'原生命令 / 确定性测试'} | ${s.receipt} |`).join('\n');
fs.writeFileSync(path.join(APP_ROOT,'VERIFICATION.md'),`# 最终验收\n\n状态：**${report.status}**\n\n完成时间：${report.finished}\n\n| 项目 | 结果 | 退出码 | 类型 | 回执 |\n|---|---|---:|---|---|\n${rows}\n\n## 真实任务\n\n主验收：\n\n\`\`\`json\n${JSON.stringify(report.primaryLive||{},null,2)}\n\`\`\`\n\n最终源码回归：\n\n\`\`\`json\n${JSON.stringify(report.currentLive||{},null,2)}\n\`\`\`\n\n完整命令、stdout、stderr、退出码、环境与源码 SHA256 见 docs/verification/acceptance.json 与 final-harness。确定性测试中的模拟模型不计入真实模型请求。历史失败仍保存在 validation。便携安装另见 docs/verification/portable/receipt.json。此状态不证明长期稳定性、总体成功率或用户满意度。\n`,'utf8');
fs.writeFileSync(path.join(APP_ROOT,'BLOCKED-UNVERIFIED.md'),`# 阻塞与未验证\n\n## 本轮阻塞\n\n${failing.length?failing.map(x=>'- '+x).join('\n'):'本次有限验收无未解决失败；不等于所有未来任务可靠。'}\n\n## 未验证 / 不支持的范围\n\n${known.map(x=>'- '+x).join('\n')}\n\n## 已知语义\n\n预算为停止新增请求的实际 token 阈值，在途可能超额，未知 usage 不当零。岗位隔离是协作工程边界，不是恶意代码隔离。UI 是本地 Web 工作台和 Edge 应用窗口，不是独立 Electron 安装器。\n`,'utf8');
console.log(JSON.stringify({status:report.status,exitCode:report.exitCode,receipt:path.join(dir,'receipt.json'),primaryLive:report.primaryLive,currentLive:report.currentLive,failing},null,2));process.exitCode=report.exitCode;
