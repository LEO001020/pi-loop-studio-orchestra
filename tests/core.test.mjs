import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Store} from '../server/store.mjs';
import {loadSettings,settingsSchema} from '../server/settings.mjs';
import {APP_ROOT,uid,sha,Slots,sleep,portablePath,LoopError} from '../server/util.mjs';
import {validatePlan,owns,checkedPath,fileManifest,manifestDiff} from '../server/workspace.mjs';
import {Research} from '../server/research.mjs';
import {makeContextTransform,contextTailIndex} from '../server/context.mjs';
import {ROOT_GRAPH,JOB_GRAPH} from '../server/workflow.mjs';

const settings=()=>structuredClone(loadSettings());
function fixture(){
  const store=new Store(':memory:'),s=settings(),session=store.createSession(path.join(APP_ROOT,'workspace'),'unit fixture');
  const run=store.createRun(session.id,'Deterministic test; not a live model claim',s,1);
  return {store,s,session,run};
}
function plan(s){const role=s.roles.find(r=>r.count>0).name;return {summary:'fixture',successCriteria:['actual output matches specification'],verificationCommands:['node --test'],tasks:[
  {id:'a',title:'a',role,instructions:'a',acceptance:['a'],ownedPaths:['src/a.mjs'],dependsOn:[]},
  {id:'b',title:'b',role,instructions:'b',acceptance:['b'],ownedPaths:['src/b.mjs'],dependsOn:[]}
]};}

test('twelve calls can start against budget=1 without reservation; settlement is idempotent',()=>{
  const {store,run}=fixture();try{
    const ids=Array.from({length:12},()=>store.beginCall(run.id,'executor','unit-overlap'));
    assert(ids.every(id=>typeof id==='string'));assert.equal(store.run(run.id).spent,0);
    for(const id of ids){const message={usage:{input:2,output:3,cacheRead:0,cacheWrite:0,totalTokens:5},stopReason:'stop'};store.settleCall(id,message);store.settleCall(id,message);}
    assert.equal(store.run(run.id).spent,60);assert.equal(store.calls(run.id).length,12);
    for(const role of ['principal','executor','auxiliary'])assert.throws(()=>store.beginCall(run.id,role,'after-threshold'),e=>e.code==='BUDGET_PAUSED');
  }finally{store.close();}
});
test('unknown usage stays null, visible, and is not fabricated as zero consumption',()=>{
  const {store,run}=fixture();try{
    const id=store.beginCall(run.id,'executor','interrupted');store.recoverCalls();
    const call=store.calls(run.id).find(c=>c.id===id);assert.equal(call.tokens,null);assert.equal(call.unknown,1);assert.equal(store.metrics(run.id).unknown,1);
    assert.match(call.details.error,/未知/);assert.equal(store.run(run.id).spent,0);
  }finally{store.close();}
});
test('atomic HTTP submission identity survives a lost response without duplicate run/message',()=>{
  const {store,session,s}=fixture();try{
    const payload={content:'你好，世界',mode:'chat',budget:50000,workspace:session.workspace},key=uid();
    const a=store.acceptSubmission(session.id,key,payload,s),b=store.acceptSubmission(session.id,key,payload,s);
    assert.equal(a.run.id,b.run.id);assert.equal(a.replayed,false);assert.equal(b.replayed,true);
    assert.equal(store.messages(session.id).length,1);assert.equal(new Date(store.messages(session.id)[0].created).toString().includes('Invalid'),false);
    assert.throws(()=>store.submission(session.id,key,{...payload,content:'different'}),e=>e.code==='IDEMPOTENCY_CONFLICT');
    assert.equal(store.runs(session.id).length,2); // includes this test's setup run
  }finally{store.close();}
});
test('pause blocks new calls without invalidating completed work or its session',()=>{
  const {store,run,session}=fixture();try{
    store.checkpoint(run.id,'scoping:0',{scouts:['retained']});store.patchRun(run.id,{pauseRequested:true});
    assert.throws(()=>store.beginCall(run.id,'principal','paused'),e=>e.code==='USER_PAUSED');
    store.patchRun(run.id,{pauseRequested:false});const id=store.beginCall(run.id,'principal','resumed');store.settleCall(id,{usage:{totalTokens:3},stopReason:'stop'});
    assert.equal(store.session(session.id).id,session.id);assert.equal(store.run(run.id).context.steps['scoping:0'].result.scouts[0],'retained');
    store.patchRun(run.id,{status:'completed'});assert.throws(()=>store.beginCall(run.id,'principal','terminal'),e=>e.code==='CANCELLED');
  }finally{store.close();}
});
test('SQLite sessions, messages, graph snapshots and checkpoints survive actual reopen',()=>{
  const dir=fs.mkdtempSync(path.join(APP_ROOT,'validation','store-')),file=path.join(dir,'state.sqlite');let store=new Store(file);
  try{
    const session=store.createSession(dir),run=store.createRun(session.id,'restart fixture',settings());
    store.addMessage(session.id,'user','中文跨重启',run.id,'stable-message');store.checkpoint(run.id,'planning:0',{proof:'retained'});
    store.patchRun(run.id,{status:'paused',snapshot:{status:'active',value:'paused',context:{round:0,failedStage:'executing'}}});store.close();store=new Store(file);
    assert.equal(store.session(session.id).id,session.id);assert.equal(store.messages(session.id)[0].content,'中文跨重启');
    assert.equal(store.run(run.id).snapshot.value,'paused');assert.equal(store.run(run.id).context.steps['planning:0'].result.proof,'retained');
  }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('slot ownership transfers once; cancelled waiters never steal a released slot',async()=>{
  const slots=new Slots(1),release=await slots.acquire(),abort=new AbortController();
  const waiting=slots.acquire(abort.signal);abort.abort();await assert.rejects(waiting,e=>e.code==='CANCELLED');
  release();release();assert.equal(slots.active,0);
  await assert.rejects(()=>slots.use(async()=>{throw new LoopError('TEST');}));
  assert.equal(await slots.use(async()=>42),42);assert.equal(slots.active,0);assert.equal(slots.peak,1);
});
test('fixed matrix and role/preset allocations are validated, not silently resized',()=>{
  const s=settings();assert(settingsSchema.safeParse(s).success);
  s.models.principal.concurrency=2;assert.equal(settingsSchema.safeParse(s).success,false);s.models.principal.concurrency=1;
  s.models.executor.concurrency=9;assert.equal(settingsSchema.safeParse(s).success,false);s.models.executor.concurrency=12;
  s.roles=[{name:'Same',count:6,instructions:''},{name:'same',count:6,instructions:''}];assert.equal(settingsSchema.safeParse(s).success,false);
});
test('DAG accepts independent ownership and serial overlap, rejects overlap, cycles and nonexistent dependencies',()=>{
  const s=settings(),p=plan(s);assert(validatePlan(p,s));p.tasks[1].ownedPaths=['src'];
  assert.throws(()=>validatePlan(p,s),e=>e.code==='PLAN_OWNERSHIP_OVERLAP');p.tasks[1].dependsOn=['a'];assert(validatePlan(p,s));
  p.tasks[0].dependsOn=['b'];assert.throws(()=>validatePlan(p,s),e=>e.code==='PLAN_CYCLE');
  p.tasks[0].dependsOn=['missing'];assert.throws(()=>validatePlan(p,s),e=>e.code==='UNKNOWN_DEPENDENCY');
});
test('Windows case-insensitive task IDs cannot alias one worktree',()=>{
  const s=settings(),p=plan(s);p.tasks[0].id='Case';p.tasks[1].id='case';
  assert.throws(()=>validatePlan(p,s),e=>e.code==='INVALID_TASK_ID');
});
test('relative path ownership rejects sibling prefixes, traversal, private files and Windows device names',()=>{
  assert.equal(owns(['src'],'src/a.mjs'),true);assert.equal(owns(['src'],'src-other/a.mjs'),false);assert.equal(owns(['SRC'],'src/a.mjs'),true);
  for(const p of ['../outside','D:/outside','con.txt','nul','a:stream','a.','a/b '])assert.throws(()=>portablePath(p));
  assert.throws(()=>checkedPath(APP_ROOT,'.env'));assert.throws(()=>checkedPath(APP_ROOT,'outside.mjs',{write:true,ownedPaths:['owned.mjs']}));
});
test('manifest difference includes new files; a test that writes missing source cannot pass as a read-only check',()=>{
  const before={'src/a.mjs':{hash:sha('a'),bytes:1}},after={...before,'src/missing.mjs':{hash:sha('created by test'),bytes:15}};
  assert.deepEqual(manifestDiff(before,after).map(c=>[c.path,c.kind,c.before]),[['src/missing.mjs','added',null]]);
});
test('source previews are paged back to the exact archived bytes and retain all retrieval origins',()=>{
  const {store,run,s}=fixture();const r=new Research(store,run.id,s);
  try{
    const text='原始证据ABC\n'.repeat(3000),a=r.archive(text,{url:'https://example.invalid/one',kind:'fixture'});
    assert.equal(a.truncated,true);let combined=a.text,next=a.nextOffset;
    while(next!==null){const part=r.readSource(a.hash,{offset:next});combined+=part.text;next=part.nextOffset;}
    assert.equal(combined,text);assert.equal(sha(combined),a.hash);
    r.archive(text,{url:'https://example.invalid/two',kind:'fixture'});
    assert.equal(r.readSource(a.hash).metadata.receipts.length,2);
    assert.throws(()=>r.readSource('../credentials'));assert.equal(r.findSources('example.invalid').length,1);
  }finally{store.close();fs.rmSync(r.directory,{recursive:true,force:true});}
});
test('native Pi compaction preserves the original transcript and never orphans a tool result',async()=>{
  const messages=[{role:'user',content:'ORIGINAL USER GOAL',timestamp:1}];
  for(let i=0;i<8;i++){
    messages.push({role:'assistant',content:[{type:'toolCall',id:`t${i}`,name:'read',arguments:{path:'file'}}],api:'openai-completions',provider:'fixture',model:'fixture',usage:{input:100,output:100,totalTokens:200,cacheRead:0,cacheWrite:0},stopReason:'toolUse',timestamp:i+2});
    messages.push({role:'toolResult',toolCallId:`t${i}`,toolName:'read',content:[{type:'text',text:`SOURCE_${i} `+'evidence '.repeat(2000)}],isError:false,timestamp:i+3});
    messages.push({role:'assistant',content:[{type:'text',text:`Observed source ${i}`}],api:'openai-completions',provider:'fixture',model:'fixture',usage:{totalTokens:20},stopReason:'stop',timestamp:i+4});
  }
  const original=structuredClone(messages);let calls=0,receipt;
  const transform=makeContextTransform({model:{contextWindow:12000},settings:{enabled:true,triggerRatio:0.5,keepRecentTokens:2000,summaryMaxTokens:1024},summarize:async items=>{calls++;assert(items.length>0);return {text:'A deterministic test summary, not live model evidence.',usage:{totalTokens:321}};},onCompact:r=>{receipt=r;}});
  const cut=contextTailIndex(messages,1,2000);assert.notEqual(messages[cut]?.role,'toolResult');
  const visible=await transform(messages);assert(calls===1);assert(visible.length<messages.length);assert.deepEqual(messages,original);
  assert.equal(visible[0].content,'ORIGINAL USER GOAL');assert.equal(receipt.usage.totalTokens,321);
  const ids=new Set();for(const m of visible){if(m.role==='assistant')for(const c of m.content)if(c.type==='toolCall')ids.add(c.id);if(m.role==='toolResult')assert(ids.has(m.toolCallId));}
  await transform(messages);assert.equal(calls,1);
});
test('graph definitions expose mandatory dispatch, independent audit, repair and recovery',()=>{
  assert(ROOT_GRAPH.scoping.next.includes('reconnaissance'));assert(ROOT_GRAPH.reconnaissance.next.includes('recon_audit'));assert(ROOT_GRAPH.recon_audit.next.includes('planning'));
  assert(JOB_GRAPH.executing.next.includes('auditing'));assert(JOB_GRAPH.auditing.next.includes('integrating'));assert(JOB_GRAPH.auditing.next.includes('retrying'));assert(ROOT_GRAPH.judging.next.includes('repairing'));
});
