import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Store} from '../server/store.mjs';
import {LoopController} from '../server/workflow.mjs';
import {Workspaces,fileManifest} from '../server/workspace.mjs';
import {loadSettings} from '../server/settings.mjs';
import {APP_ROOT,LOCAL,uid,ensureDir,LoopError,sleep} from '../server/util.mjs';

// Deliberately deterministic model substitution. These tests prove host
// semantics, not the quality, concurrency or usage of any model endpoint.
class ScriptedPi {
  constructor({count=12,rejectFirst=false,rejectAlways=false,rejectRoundZero=false,verificationFails=false,pausePlanning=false}={}){Object.assign(this,{count,rejectFirst,rejectAlways,rejectRoundZero,verificationFails,pausePlanning});this.seen=[];}
  abort(){}
  async idle(){}
  async structured(o){
    this.seen.push(o.node);
    const read=async p=>o.tools.find(t=>t.name==='read').execute(uid(),{path:p},o.signal);
    const write=async(p,content)=>o.tools.find(t=>t.name==='write').execute(uid(),{path:p,content},o.signal);
    let value;
    if(o.node==='scoping'){
      await read('TASK.md');value={summary:'Read the supplied task',scouts:Array.from({length:12},(_,i)=>({focus:`contract-${i}`,instructions:`Check requirement ${i}`}))};
    }else if(/^scout-\d+$/.test(o.node)){
      await read('TASK.md');value={summary:'TASK.md observed',evidence:[{source:'TASK.md',finding:'fixture contract'}],risks:[],recommendations:[]};
    }else if(/^scout-audit-/.test(o.node)){
      await read('TASK.md');value={pass:true,reason:'Deterministic evidence check',checkedEvidence:['TASK.md'],findings:[],remainingRisks:[]};
    }else if(o.node.startsWith('planning-')){
      if(this.pausePlanning){this.pausePlanning=false;throw new LoopError('BUDGET_PAUSED','Injected pause at a node boundary; not model billing');}
      await read('TASK.md');value={summary:'Independent business modules, no nested harness',successCriteria:['Every module exports its own integer and passes native tests'],verificationCommands:[this.verificationFails?'node -e "process.exit(7)"':'node --test'],tasks:Array.from({length:this.count},(_,i)=>({id:`p${i}`,title:`Module ${i}`,role:'Implement',instructions:`Create module ${i}`,dependsOn:[],ownedPaths:[`src/p${i}.mjs`,`test/p${i}.test.mjs`],acceptance:[`exported value === ${i}`]}))};
    }else if(o.node.includes('-work-')){
      const match=o.node.match(/-p(\d+)-work-(\d+)$/);assert(match);
      const i=Number(match[1]),attempt=Number(match[2]);await read('TASK.md');
      const n=this.rejectFirst&&i===0&&attempt===1?-1:i;
      await write(`src/p${i}.mjs`,`export const value = ${n};\n`);
      await write(`test/p${i}.test.mjs`,`import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../src/p${i}.mjs';\ntest('module ${i}',()=>assert.equal(value,${i}));\n`);
      value={summary:`Implemented ${i}`,evidence:[`src/p${i}.mjs`],checks:[],limitations:['Scripted test model']};
    }else if(o.node.includes('-audit-')){
      const match=o.node.match(/-p(\d+)-audit-(\d+)$/);assert(match);const i=Number(match[1]);
      const observed=await read(`src/p${i}.mjs`),actual=observed.content.filter(p=>p.type==='text').map(p=>p.text).join('\n');
      const pass=!this.rejectAlways&&!(this.rejectRoundZero&&/-r0-/.test(o.node))&&actual.includes(`value = ${i};`);
      value={pass,reason:pass?'Fixed proposal content checked':'Exported value violates the contract',checkedEvidence:[`src/p${i}.mjs`],findings:pass?[]:['Correct the exported integer'],remainingRisks:[]};
    }else if(o.node.startsWith('judging-')){
      await read('src/p0.mjs');value={pass:true,summary:'Scripted judge result, subordinated to real command exit codes',criteria:[{criterion:'Every module exports its own integer and passes native tests',passed:true,evidence:'Native test receipts'}],remainingRisks:['Deterministic host test only'],repairInstructions:'Fix the failing native checks'};
    }else throw new Error(`Unexpected scripted node ${o.node}`);
    if(o.validate)value=o.validate(value);return {value,evidenceCalls:1,trace:'SCRIPTED_TEST_NOT_MODEL_EVIDENCE'};
  }
}
function setup(options={}){
  const id=uid(),original=ensureDir(path.join(APP_ROOT,'validation',`workflow-fixture-${id}`)),store=new Store(':memory:');
  fs.writeFileSync(path.join(original,'TASK.md'),'Create independent modules with exact integer exports.\n');
  const settings=structuredClone(loadSettings());settings.roles=[{name:'Implement',count:12,instructions:'Implement assigned module'}];settings.models.executor.concurrency=12;settings.maxRepairRounds=options.maxRepairRounds??1;settings.research.enabled=false;
  const session=store.createSession(original),run=store.createRun(session.id,'Fixture business objective',settings,1000000);store.patchRun(run.id,{mode:'task'});
  const pi=new ScriptedPi(options),controller=new LoopController(store,store.run(run.id),{pi,transportProbe:async()=>[]});
  return {store,original,run,pi,controller,async close(){controller.actor?.stop();await pi.idle();store.close();fs.rmSync(original,{recursive:true,force:true});fs.rmSync(path.join(LOCAL,'runs',run.id),{recursive:true,force:true});}};
}
test('failed scout is explicit and excluded; independent successful evidence can still advance the original task',{timeout:60000},async()=>{
  const f=setup({count:1}),original=f.pi.structured.bind(f.pi);
  f.pi.structured=async o=>{if(o.node==='scout-11')throw new LoopError('TURN_LIMIT','fixture scout exhausted');if(o.node==='planning-0')assert(o.prompt.includes('fixture scout exhausted'));return original(o);};
  try{await f.controller.start();const result=await f.controller.completion;assert.equal(result.status,'completed',JSON.stringify(result.error));assert(f.store.events(0,10000,f.run.id).some(e=>e.type==='reconnaissance.partial'));assert.equal(f.controller.cached('recon_audit').filter(r=>r.audit.pass).length,11);assert(f.store.messages(f.run.sessionId).some(m=>m.content.includes('失败报告不会当作事实')));}finally{await f.close();}
});
test('no successful scout evidence cannot advance to planning',{timeout:60000},async()=>{
  const f=setup({count:1}),original=f.pi.structured.bind(f.pi);
  f.pi.structured=async o=>{if(/^scout-\d+$/.test(o.node))throw new LoopError('TURN_LIMIT','all scouts failed');return original(o);};
  try{await f.controller.start();assert.equal((await f.controller.completion).status,'blocked');assert(!f.pi.seen.some(n=>n.startsWith('planning-')));assert.equal(f.store.jobs(f.run.id).length,0);}finally{await f.close();}
});
test('transient read-only failure follows a bounded graph retry without replaying successful scouts',{timeout:60000},async()=>{
  const f=setup({count:1,maxRepairRounds:1}),original=f.pi.structured.bind(f.pi);let failed=false;
  f.pi.structured=async o=>{if(o.node==='scout-audit-3'&&!failed){failed=true;throw new LoopError('MODEL_ERROR','terminated');}return original(o);};
  try{await f.controller.start();const r=await f.controller.completion;assert.equal(r.status,'completed',JSON.stringify(r.error));assert(f.store.events(0,10000,f.run.id).some(e=>e.type==='node.retry'));assert.equal(f.pi.seen.filter(n=>n==='scout-0').length,1);assert.equal(f.pi.seen.filter(n=>n==='scout-audit-0').length,1);}finally{await f.close();}
});
test('reviewer transport failure retries a frozen proposal without re-executing the worker',{timeout:60000},async()=>{
  const f=setup({count:1,maxRepairRounds:1}),original=f.pi.structured.bind(f.pi);let failed=false;
  f.pi.structured=async o=>{if(o.node.includes('-p0-audit-')&&!failed){failed=true;throw new LoopError('MODEL_ERROR','Connection error.');}return original(o);};
  try{await f.controller.start();const r=await f.controller.completion;assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(f.pi.seen.filter(n=>n.includes('-p0-work-')).length,1);const j=f.store.jobs(f.run.id)[0];assert.equal(j.attempt,2);assert(j.audit.pass&&j.integratedCommit);}finally{await f.close();}
});
test('full graph: twelve real isolated module writes, independent review, repair, native tests, then publication',{timeout:120000},async()=>{
  const f=setup({rejectFirst:true});try{
    await f.controller.start();const result=await f.controller.completion;
    assert.equal(result.status,'completed',JSON.stringify(result.error));
    const jobs=f.store.jobs(f.run.id);assert.equal(jobs.length,12);assert(jobs.every(j=>j.audit.pass&&j.integratedCommit));
    assert.equal(jobs.find(j=>j.taskId==='p0').attempt,2);assert.equal(jobs.filter(j=>j.attempt>1).length,1);
    assert.equal(new Set(jobs.map(j=>j.workDir)).size,12);
    const verification=f.controller.cached('verifying',0);assert(verification.pass);assert.equal(verification.commands[0].exitCode,0);assert.match(verification.commands[0].stdout,/pass 12/);
    const stages=f.store.events(0,10000,f.run.id).filter(e=>e.type==='run.updated').map(e=>e.data.stage);
    for(const stage of ['scoping','reconnaissance','recon_audit','planning','executing','verifying','judging','publishing','finishing','done'])assert(stages.includes(stage),stage);
    assert.equal(fs.readFileSync(path.join(f.original,'src/p0.mjs'),'utf8'),'export const value = 0;\n');
    assert.equal(f.store.calls(f.run.id).length,0,'This is not a live model/fanout test');
  }finally{await f.close();}
});
test('audit rejection blocks integration and publication instead of accepting worker completion',{timeout:60000},async()=>{
  const f=setup({count:1,rejectAlways:true,maxRepairRounds:0});try{
    await f.controller.start();const r=await f.controller.completion;assert.equal(r.status,'blocked');assert.equal(r.error.code,'AUDIT_REJECTED');
    assert.equal(f.store.jobs(f.run.id)[0].integratedCommit,undefined);assert.equal(fs.existsSync(path.join(f.original,'src')),false);
  }finally{await f.close();}
});
test('a model saying pass cannot override a nonzero native verification exit code',{timeout:60000},async()=>{
  const f=setup({count:1,verificationFails:true,maxRepairRounds:0});try{
    await f.controller.start();const r=await f.controller.completion;assert.equal(r.status,'blocked');assert.equal(r.error.code,'VERIFICATION_REJECTED');
    assert.equal(f.controller.cached('verifying').commands[0].exitCode,7);assert.equal(fs.existsSync(path.join(f.original,'src')),false);
  }finally{await f.close();}
});
test('restored XState snapshot resumes the failed node without repeating completed reconnaissance',{timeout:60000},async()=>{
  const f=setup({count:1,pausePlanning:true});let second;
  try{
    await f.controller.start();const first=await f.controller.completion;assert.equal(first.status,'paused');f.controller.actor.stop();
    second=new LoopController(f.store,f.store.run(f.run.id),{pi:f.pi,transportProbe:async()=>[]});await second.start({resume:true});
    const result=await second.completion;assert.equal(result.status,'completed',JSON.stringify(result.error));
    assert.equal(f.pi.seen.filter(n=>n==='scoping').length,1);assert.equal(f.pi.seen.filter(n=>/^scout-\d+$/.test(n)).length,12);assert.equal(f.pi.seen.filter(n=>n==='planning-0').length,2);
  }finally{second?.actor.stop();await f.close();}
});
test('publication refuses user edits and refuses candidate mutation after final verification',{timeout:60000},async()=>{
  const f=setup({count:1});try{
    const ws=new Workspaces(f.store,f.store.run(f.run.id));await ws.prepare();
    fs.writeFileSync(path.join(ws.repo,'TASK.md'),'reviewed version');const expected=fileManifest(ws.repo,f.controller.settings).files;
    fs.writeFileSync(path.join(f.original,'TASK.md'),'new user edit');await assert.rejects(()=>ws.publish(undefined,expected),e=>e.code==='PUBLISH_CONFLICT');
    assert.equal(fs.readFileSync(path.join(f.original,'TASK.md'),'utf8'),'new user edit');
    fs.writeFileSync(path.join(ws.repo,'TASK.md'),'tampered version');await assert.rejects(()=>ws.publish(undefined,expected),e=>e.code==='ARTIFACT_CORRUPTION');
  }finally{await f.close();}
});
test('exhausted worker review returns to principal planning without lowering original acceptance',{timeout:60000},async()=>{
  const f=setup({count:1,rejectRoundZero:true,maxRepairRounds:1});try{
    await f.controller.start();const result=await f.controller.completion;
    assert.equal(result.status,'completed',JSON.stringify(result.error));
    assert.equal(result.round,1);assert(f.pi.seen.includes('planning-1'));
    const jobs=f.store.jobs(f.run.id),old=jobs.find(j=>j.round===0),replacement=jobs.find(j=>j.round===1);
    assert.equal(old.supersededByRound,1);assert.equal(old.integratedCommit,undefined);assert.equal(old.audit.pass,false);
    assert(replacement.audit.pass&&replacement.integratedCommit);assert.equal(f.controller.cached('verifying',1).commands[0].exitCode,0);
    assert.deepEqual(f.controller.cached('planning',0).successCriteria,f.controller.cached('planning',1).successCriteria);
  }finally{await f.close();}
});
test('restored auditor transport failure keeps the fixed worker proposal without rerunning implementation',{timeout:60000},async()=>{
  const f=setup({count:1,maxRepairRounds:0}),original=f.pi.structured.bind(f.pi);let resumed;
  f.pi.structured=async o=>{if(/-p0-audit-/.test(o.node))throw new LoopError('MODEL_ERROR','Connection error.');return original(o);};
  try{
    await f.controller.start();const stopped=await f.controller.completion;assert.equal(stopped.status,'blocked');
    const job=f.store.jobs(f.run.id)[0];assert(job.work&&job.proposal&&!job.audit);assert.equal(job.error.code,'MODEL_ERROR');
    f.controller.actor.stop();f.store.patchJob(job.id,{attempt:job.attempt+1,status:'queued'});
    const freshPi=new ScriptedPi({count:1});resumed=new LoopController(f.store,f.store.run(f.run.id),{pi:freshPi,transportProbe:async()=>[]});
    await resumed.start({resume:true});const result=await resumed.completion;assert.equal(result.status,'completed',JSON.stringify(result.error));
    assert.equal(freshPi.seen.filter(n=>n.includes('-work-')).length,0,'Transport recovery must not repeat an already frozen implementation');
    assert(freshPi.seen.some(n=>n.includes('-audit-')));assert.equal(f.store.job(job.id).proposal.commit,job.proposal.commit);
  }finally{resumed?.actor.stop();await f.close();}
});
test('unchanged dependencies edited by the user invalidate prior verification before publication',{timeout:60000},async()=>{
  const f=setup({count:1});try{
    fs.writeFileSync(path.join(f.original,'dependency.mjs'),'export const dependency = 1;\n');
    const ws=new Workspaces(f.store,f.store.run(f.run.id));await ws.prepare();
    fs.writeFileSync(path.join(ws.repo,'result.mjs'),'import {dependency} from "./dependency.mjs"; export const result = dependency + 1;\n');
    const expected=fileManifest(ws.repo,f.controller.settings).files;
    fs.writeFileSync(path.join(f.original,'dependency.mjs'),'export const dependency = 999;\n');
    await assert.rejects(()=>ws.publish(undefined,expected),e=>e.code==='PUBLISH_CONFLICT');
    assert.equal(fs.existsSync(path.join(f.original,'result.mjs')),false);
    assert.match(fs.readFileSync(path.join(f.original,'dependency.mjs'),'utf8'),/999/);
  }finally{await f.close();}
});
