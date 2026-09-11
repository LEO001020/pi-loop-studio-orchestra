// A persisted HTTP-driven end-to-end task. --run <id> watches an existing task
// without resubmitting it; --resume is explicit and reuses the same identity.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {APP_ROOT,uid,now,ensureDir,writeJSON,sleep} from '../server/util.mjs';
import {loadSettings} from '../server/settings.mjs';
import {executeProcess,taskEnvironment} from '../server/commands.mjs';

const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const settings=loadSettings(),base=`http://127.0.0.1:${settings.port}`,sessionKey=uid();let runId=arg('--run');
const dir=ensureDir(path.join(APP_ROOT,'validation',`live-task-${Date.now()}`));
const report={started:now(),command:process.argv,cwd:APP_ROOT,environment:{node:process.version,platform:process.platform,arch:process.arch},kind:'REAL_PI_MODEL_TASK',status:'RUNNING',exitCode:null};
const request=async(url,method='GET',body)=>{const r=await fetch(base+'/api'+url,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});const data=await r.json();if(!r.ok)throw new Error(JSON.stringify(data));return data;};
function peak(calls){const points=calls.flatMap(c=>[[Date.parse(c.started),1],[Date.parse(c.ended),-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);let active=0,max=0;for(const [,delta]of points){active+=delta;max=Math.max(max,active);}return max;}
try{
  report.health=await request('/health');assert.equal(report.health.app,'pi-loop-studio');
  if(!runId){
    const workspace=ensureDir(path.join(APP_ROOT,'workspace',`live-acceptance-${sessionKey}`));report.workspace=workspace;
    const specification=`实现一个零第三方依赖的 Node.js ESM 工具库。不要创建 worktrees/，隔离与审核已经由宿主提供。\n每个函数放在独立 src/<name>.mjs 中，使用命名导出；对应 test/<name>.test.mjs 用 node:test 和 node:assert/strict。不得修改输入。\n1 sum(values): 有限数数组求和，空数组为0。\n2 mean(values): 非空有限数数组均值。\n3 median(values): 非空有限数数组中位数。\n4 clamp(value,min,max): 有限数，min>max 抛 RangeError。\n5 chunk(values,size): 数组分块，size 为正安全整数。\n6 unique(values): 数组按 SameValueZero 去重且保留首次顺序。\n7 range(start,stop,step=1): 半开序列，正负步长、方向不匹配空数组、0步长或超过100000项抛 RangeError。\n8 normalizeWeights(values): 非空非负有限数组，总和须大于0，返回归一化结果。\n9 variance(values): 非空有限数数组的总体方差。\n10 quantile(values,p): 非空有限数数组，p在[0,1]，排序后 R-7 线性插值。\n数值数组中非数值、NaN、Infinity、稀疏空洞均抛 TypeError；要求非空却为空时抛 RangeError。至少50个真实测试，覆盖通常值、边界、错误输入和不可变性。提供 README.md 和 package.json（type=module，test=node --test）。node --test 必须成功。\n十个模块之间没有文件依赖，可同时实现各自模块与测试。原始目标不能降低。此任务验收真实模型并发、固定产物的独立审核和宿主发布；不得把这些要求再实现成业务工作树或机械搬运任务。`;
    fs.writeFileSync(path.join(workspace,'TASK.md'),specification,'utf8');const session=await request('/sessions','POST',{workspace,title:'十模块真实闭环验收'});report.sessionId=session.id;
    const budget=Number(arg('--budget')||Math.min(settings.budgetTokens,2000000));assert(Number.isSafeInteger(budget)&&budget>0);
    const response=await request(`/sessions/${session.id}/messages`,'POST',{content:specification,mode:'task',budget,requestId:sessionKey});runId=response.run.id;report.budget=budget;
  }else if(process.argv.includes('--resume'))await request(`/runs/${runId}/resume`,'POST',{});
  report.runId=runId;writeJSON(path.join(dir,'progress.json'),report);
  const deadline=Date.now()+Number(arg('--watch-seconds')||480)*1000;let data,last='';
  while(Date.now()<deadline){data=await request(`/runs/${runId}`);const state=`${data.run.stage} ${data.run.status} | ${data.run.spent} tokens | ${data.jobs.filter(j=>j.integratedCommit).length}/${data.jobs.length} integrated`;
    if(state!==last){console.log(state);last=state;writeJSON(path.join(dir,'progress.json'),{...report,lastState:state,at:now()});}
    if(!['queued','running'].includes(data.run.status))break;await sleep(1500);
  }
  const full=await request(`/runs/${runId}/export`);writeJSON(path.join(dir,'run.json'),full);report.workspace=full.run.workspace;report.runStatus=full.run.status;
  report.executorSucceeded=full.calls.filter(c=>c.role==='executor'&&c.status==='completed'&&c.tokens>0).length;
  report.successfulExecutorPeak=peak(full.calls.filter(c=>c.role==='executor'&&c.status==='completed'&&c.tokens>0));
  report.executionOnlyPeak=peak(full.calls.filter(c=>c.role==='executor'&&/-work-\d+$/.test(c.node)&&c.status==='completed'&&c.tokens>0));
  report.spent=full.run.spent;report.usageUnknown=full.metrics.unknown;report.jobs=full.jobs.map(j=>({id:j.id,title:j.title,attempt:j.attempt,auditPass:j.audit?.pass,integrated:Boolean(j.integratedCommit)}));
  if(full.run.status==='blocked'&&full.run.error?.code==='MODEL_ENDPOINT_OFFLINE'){report.status='BLOCKED_MODEL_ENDPOINT';report.error=full.run.error;report.exitCode=2;}
  else if(['running','queued'].includes(full.run.status)){report.status='IN_PROGRESS_NOT_VERIFIED';report.exitCode=3;}
  else{
    assert.equal(full.run.status,'completed',JSON.stringify(full.run.error));assert(report.executionOnlyPeak>=10,`Only ${report.executionOnlyPeak} successful overlapping execution requests`);assert(full.jobs.length>=10&&full.jobs.every(j=>j.supersededByRound!==undefined||(j.audit?.pass&&j.integratedCommit)));
    const cwd=full.run.workspace,env=taskEnvironment(cwd),npm=path.join(APP_ROOT,'.runtime/node-home/node_modules/npm/bin/npm-cli.js');
    const pkg=fs.existsSync(path.join(cwd,'package.json'))?JSON.parse(fs.readFileSync(path.join(cwd,'package.json'),'utf8')):{};
    if(fs.existsSync(path.join(cwd,'package-lock.json'))){report.independentInstall=await executeProcess(process.execPath,[npm,'ci','--ignore-scripts','--no-audit','--no-fund'],{cwd,env,timeout:180});assert.equal(report.independentInstall.exitCode,0,report.independentInstall.stderr);}
    report.independentCommand=await executeProcess(process.execPath,pkg.scripts?.test?[npm,'test']:['--test'],{cwd,env,timeout:180});assert.equal(report.independentCommand.exitCode,0);assert.match(report.independentCommand.stdout,/pass (?:[5-9]\d|[1-9]\d{2,})/);
    assert.equal(report.usageUnknown,full.calls.filter(c=>c.unknown).length);
    report.status=report.usageUnknown?'VERIFIED_TASK_WITH_UNKNOWN_BILLING':'VERIFIED_REAL_TASK_WITH_SCOPE';report.exitCode=0;
  }
}catch(e){report.status='FAILED';report.error=e.stack;report.exitCode=1;}
report.finished=now();writeJSON(path.join(dir,'receipt.json'),report);console.log(JSON.stringify({...report,receipt:path.join(dir,'receipt.json')},null,2));process.exitCode=report.exitCode;
