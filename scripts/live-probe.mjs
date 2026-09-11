import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Store} from '../server/store.mjs';
import {PiRuntime} from '../server/pi.mjs';
import {loadSettings,scrub} from '../server/settings.mjs';
import {APP_ROOT,LOCAL,writeJSON,now,uid} from '../server/util.mjs';

const settings=loadSettings(),stamp=Date.now(),directory=path.join(APP_ROOT,'validation',`live-probe-${stamp}`);
fs.mkdirSync(directory,{recursive:true});
const store=new Store(path.join(LOCAL,`live-probe-${stamp}.sqlite`));
const session=store.createSession(settings.defaultWorkspace,'真实异构席位并发诊断');
const run=store.createRun(session.id,'Real transport fan-out; one-token threshold, no reservations',settings,1);
const report={kind:'LIVE_MODEL_DIAGNOSTIC_NOT_END_TO_END_ACCEPTANCE',started:now(),command:[process.execPath,...process.argv.slice(1)],cwd:process.cwd(),environment:{node:process.version,platform:process.platform,release:os.release(),arch:process.arch},runId:run.id,budget:1,exitCode:null};
const save=()=>writeJSON(path.join(directory,'receipt.json'),JSON.parse(scrub(report)));
save();
const pi=await new PiRuntime(store,run).init();
try{
  const labels=Array.from({length:settings.models.executor.concurrency},(_,i)=>({role:'executor',node:`fanout-${i+1}`,label:`PI_SLOT_${i+1}_${uid().slice(0,8)}`}));
  labels.push({role:'principal',node:'principal-overlap',label:`PI_PRINCIPAL_${uid().slice(0,8)}`},{role:'auxiliary',node:'auxiliary-overlap',label:`PI_AUXILIARY_${uid().slice(0,8)}`});
  const responses=await Promise.allSettled(labels.map(x=>pi.run({role:x.role,node:x.node,system:'This is a real local runtime transport diagnostic, not a coding task. Use no tools. Return only the exact label requested.',prompt:`Return exactly: ${x.label}`,thinking:'off',maxTokens:1024})));
  report.responses=responses.map((r,i)=>({...labels[i],status:r.status,text:r.status==='fulfilled'?r.value.text:null,error:r.status==='rejected'?String(r.reason):null,ok:r.status==='fulfilled'&&r.value.text.includes(labels[i].label)}));
  report.calls=store.calls(run.id);report.events=store.events(0,10000,run.id);
  // Use actual Pi transport-dispatch callbacks, not Promise creation times.
  const dispatched=new Map(report.events.filter(e=>e.type==='call.dispatched').map(e=>[e.data.id,e.at]));
  const execution=report.calls.filter(c=>c.role==='executor');
  const timeline=execution.flatMap(c=>[{id:c.id,at:dispatched.get(c.id),delta:1},{id:c.id,at:c.ended,delta:-1}]);
  assert(timeline.every(e=>e.at),'Every executor needs a dispatch and settlement timestamp');
  timeline.sort((a,b)=>a.at.localeCompare(b.at)||a.delta-b.delta);
  let active=0,peak=0;for(const e of timeline){active+=e.delta;peak=Math.max(peak,active);e.active=active;}
  report.executorPeak=peak;report.timeline=timeline;
  report.settled=store.run(run.id).spent;report.sumUsage=report.calls.reduce((n,c)=>n+(c.tokens||0),0);
  const before=report.calls.length;
  try{await pi.run({role:'principal',node:'must-not-dispatch',system:'Budget threshold diagnostic',prompt:'This request must be rejected before transport.',thinking:'off',maxTokens:512});report.budgetBlocked=false;}
  catch(error){report.budgetBlocked=error.code==='BUDGET_PAUSED';report.blockedCode=error.code;}
  report.afterBlockedCallCount=store.calls(run.id).length;
  report.reservationMechanism='ABSENT';
  assert(peak>=10,`Actual overlapping executor calls: ${peak}`);
  assert.equal(execution.length,settings.models.executor.concurrency);
  assert(report.responses.every(r=>r.ok),'All real providers must return their unique label');
  assert(report.calls.every(c=>c.status==='completed'&&c.tokens>0&&!c.unknown),'All returned usage must be known');
  assert.equal(report.settled,report.sumUsage);assert(report.settled>report.budget);
  assert(report.budgetBlocked);assert.equal(report.afterBlockedCallCount,before);
  report.exitCode=0;report.status='VERIFIED_WITHIN_DIAGNOSTIC_SCOPE';
}catch(error){report.exitCode=1;report.status='FAILED';report.error=scrub(error.stack||String(error));process.exitCode=1;}
finally{pi.abort();await pi.idle();report.finished=now();report.calls=store.calls(run.id);report.settled=store.run(run.id).spent;save();store.close();}
console.log(JSON.stringify({receipt:path.join(directory,'receipt.json'),status:report.status,executorPeak:report.executorPeak,budget:1,settled:report.settled,budgetBlocked:report.budgetBlocked,responses:report.responses,error:report.error,exitCode:report.exitCode},null,2));

