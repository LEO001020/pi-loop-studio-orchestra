import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Type,AssistantMessageEventStream} from '@earendil-works/pi-ai';
import {Store} from '../server/store.mjs';
import {PiRuntime} from '../server/pi.mjs';
import {makeTools} from '../server/tools.mjs';
import {Workspaces,fileManifest} from '../server/workspace.mjs';
import {LoopController} from '../server/workflow.mjs';
import {executeProcess,taskEnvironment,shellCommand} from '../server/commands.mjs';
import {loadSettings} from '../server/settings.mjs';
import {APP_ROOT,LOCAL,uid,ensureDir} from '../server/util.mjs';

function fixture(){
  const cwd=ensureDir(path.join(APP_ROOT,'validation',`runtime-boundary-${uid()}`));
  const store=new Store(':memory:'),settings=loadSettings();settings.research.enabled=false;
  settings.pythonCellTimeoutSeconds=.25;
  const session=store.createSession(cwd),run=store.createRun(session.id,'Native runtime boundary regression; scripted provider, not model evidence',settings,100000);
  return {cwd,store,settings,run,close(){store.close();fs.rmSync(cwd,{recursive:true,force:true});fs.rmSync(path.join(LOCAL,'runs',run.id),{recursive:true,force:true});}};
}

test('Python timeout retains unknown side effects and partial stdout, not a replayable failure',{timeout:20000},async()=>{
  const f=fixture(),b=makeTools({store:f.store,runId:f.run.id,jobId:'python-timeout',cwd:f.cwd,settings:f.settings,mode:'worker',ownedPaths:['marker.txt']});
  try{
    await assert.rejects(()=>b.tools.find(t=>t.name==='python').execute('cell-1',{code:'from pathlib import Path\nimport time\nPath("marker.txt").write_text("first write", encoding="utf8")\nprint("before-timeout", flush=True)\ntime.sleep(30)'},new AbortController().signal));
    assert.equal(fs.readFileSync(path.join(f.cwd,'marker.txt'),'utf8'),'first write');
    const effect=f.store.effects(f.run.id)[0];
    assert.equal(effect.status,'unknown','An interrupted dispatched cell is not a known failed operation');
    assert.match(effect.stdout||'',/before-timeout/);
    assert(f.store.hasUnknownEffects(f.run.id));
    assert.throws(()=>f.store.beginCall(f.run.id,'executor','unresolved-next'),e=>e.code==='EFFECT_UNKNOWN');
  }finally{await b.close();f.close();}
});

test('Pi stops within a mixed tool batch after an unknown effect and cannot silently submit success',{timeout:20000},async()=>{
  const f=fixture(),b=makeTools({store:f.store,runId:f.run.id,jobId:'mixed-tools',cwd:f.cwd,settings:f.settings,mode:'worker',ownedPaths:['marker.txt','should-not-exist.txt']});
  const pi=new PiRuntime(f.store,f.run);let dispatches=0;
  const model={id:'scripted',provider:'scripted',api:'openai-completions',contextWindow:100000,maxTokens:1000};
  pi.models={getModel:()=>model,streamSimple(){
    const stream=new AssistantMessageEventStream();dispatches++;
    const calls=dispatches===1?[
      {type:'toolCall',id:'slow-cell',name:'python',arguments:{code:'from pathlib import Path\nimport time\nPath("marker.txt").write_text("done", encoding="utf8")\ntime.sleep(30)'}},
      {type:'toolCall',id:'later-write',name:'write',arguments:{path:'should-not-exist.txt',content:'must not execute'}},
      {type:'toolCall',id:'later-submit',name:'submit_result',arguments:{ok:true}}
    ]:[{type:'toolCall',id:'next-submit',name:'submit_result',arguments:{ok:true}}];
    const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:calls,stopReason:'toolUse',usage:{input:10,output:10,totalTokens:20},timestamp:Date.now()};
    stream.push({type:'done',reason:'toolUse',message});stream.end(message);return stream;
  }};
  try{
    await assert.rejects(()=>pi.structured({role:'executor',node:'mixed-tools',schema:Type.Object({ok:Type.Boolean()}),system:'Fixture',prompt:'Run the fixture',tools:b.tools}),e=>e.code==='EFFECT_UNKNOWN');
    assert.equal(dispatches,1,'No follow-up model request after a known-unknown effect');
    assert.equal(fs.existsSync(path.join(f.cwd,'should-not-exist.txt')),false,'A later tool in the same model response must not run');
  }finally{pi.abort();await pi.idle();await b.close();f.close();}
});

test('project Node resolution cannot borrow a harness-only dependency in CJS or ESM',{timeout:15000},async()=>{
  const f=fixture();try{
    fs.writeFileSync(path.join(f.cwd,'package.json'),JSON.stringify({name:'dependency-boundary-fixture',type:'module',version:'1.0.0'}));
    for(const [filename,source] of [['cjs.cjs',"require('express'); console.log('borrowed harness express')"],['esm.mjs',"import 'express'; console.log('borrowed harness express')"]]){
      fs.writeFileSync(path.join(f.cwd,filename),source);
      const result=await executeProcess(process.execPath,[filename],{cwd:f.cwd,env:taskEnvironment(f.cwd),timeout:10});
      assert.notEqual(result.exitCode,0,`${filename} unexpectedly passed using an undeclared dependency outside this project`);
      assert.match(result.stderr,/DEPENDENCY_OUTSIDE_WORKTREE|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/);
    }
  }finally{f.close();}
});

test('native build output is not a source mutation, but modifying existing source still fails',{timeout:30000},async()=>{
  const f=fixture();try{
    fs.writeFileSync(path.join(f.cwd,'source.mjs'),'export const value=42;\n');
    fs.writeFileSync(path.join(f.cwd,'build.mjs'),"import fs from 'node:fs';fs.mkdirSync('dist',{recursive:true});fs.copyFileSync('source.mjs','dist/source.mjs');\n");
    fs.writeFileSync(path.join(f.cwd,'test.mjs'),"import assert from 'node:assert/strict';import {value} from './dist/source.mjs';assert.equal(value,42);console.log('real compiled output verified');\n");
    // This setting is a declaration of generated outputs, not permission to
    // ignore source that existed in the accepted input manifest.
    f.settings.generatedDirectories=['dist'];f.store.patchRun(f.run.id,{settings:f.settings});
    f.store.checkpoint(f.run.id,'planning:0',{successCriteria:['compiled value is 42'],verificationCommands:['node build.mjs','node test.mjs'],tasks:[]});
    const controller=new LoopController(f.store,f.store.run(f.run.id));await controller.workspace.prepare();
    const verified=await controller.perform('verifying',0,new AbortController().signal);
    assert.equal(verified.pass,true,JSON.stringify(verified.sourceMutations));
    assert(verified.generatedArtifacts?.some(c=>c.path==='dist/source.mjs'));
    f.store.checkpoint(f.run.id,'planning:0',{successCriteria:['do not rewrite source'],verificationCommands:["node -e \"require('node:fs').writeFileSync('source.mjs','changed')\""],tasks:[]});
    const rejected=await controller.perform('verifying',0,new AbortController().signal);
    assert.equal(rejected.pass,false);assert(rejected.sourceMutations.some(c=>c.path==='source.mjs'));
  }finally{f.close();}
});

test('native read refuses binary noise; archive reader returns paged real source without extraction',{timeout:20000},async()=>{
  const f=fixture(),b=makeTools({store:f.store,runId:f.run.id,jobId:'archives',cwd:f.cwd,settings:f.settings,mode:'scout'});try{
    fs.writeFileSync(path.join(f.cwd,'中文.txt'),'证据原文'.repeat(100));fs.writeFileSync(path.join(f.cwd,'binary.bin'),Buffer.from([0,255,1,5]));
    const archive=path.join(f.cwd,'source.tgz');const made=await executeProcess('tar.exe',['-czf',archive,'-C',f.cwd,'中文.txt','binary.bin'],{cwd:f.cwd,timeout:10});assert.equal(made.exitCode,0);
    const read=b.tools.find(t=>t.name==='read'),reader=b.tools.find(t=>t.name==='read_archive');
    await assert.rejects(()=>read.execute(uid(),{path:'source.tgz'}),e=>e.code==='ARCHIVE_NOT_TEXT');
    await assert.rejects(()=>read.execute(uid(),{path:'binary.bin'}),e=>e.code==='NOT_UTF8_TEXT');
    const list=JSON.parse((await reader.execute(uid(),{path:'source.tgz'})).content[0].text);assert(list.entries.some(e=>e.name==='中文.txt'));
    let combined='',offset=0;do{const part=JSON.parse((await reader.execute(uid(),{path:'source.tgz',member:'中文.txt',offset,limit:57})).content[0].text);combined+=part.text;offset=part.nextOffset;}while(offset!==null);
    assert.equal(combined,'证据原文'.repeat(100));await assert.rejects(()=>reader.execute(uid(),{path:'source.tgz',member:'binary.bin'}));
    assert.deepEqual(fs.readdirSync(f.cwd).sort(),['binary.bin','source.tgz','中文.txt'].sort());
  }finally{await b.close();f.close();}
});

test('running peers do not block dispatch; only unresolved effects block until acknowledged',()=>{
  const f=fixture();try{
    f.store.putEffect({id:'peer',runId:f.run.id,jobId:'peer',status:'running'});
    const id=f.store.beginCall(f.run.id,'executor','another-peer');assert(id);
    f.store.settleCall(id,{usage:{totalTokens:5},stopReason:'stop'});
    f.store.putEffect({...f.store.effect('peer'),status:'unknown'});
    assert.throws(()=>f.store.beginCall(f.run.id,'executor','blocked'),e=>e.code==='EFFECT_UNKNOWN');
    f.store.putEffect({...f.store.effect('peer'),status:'unknown_acknowledged',resolution:'Test-only explicit acknowledgment'});
    assert(f.store.beginCall(f.run.id,'executor','continued'));
    assert.equal(f.store.effect('peer').resolution,'Test-only explicit acknowledgment');
  }finally{f.close();}
});

test('npm lockfile install works independently in two trees; no harness package is borrowed',{timeout:60000},async()=>{
  const f=fixture();try{
    const checks=await Promise.all(['1.0.0','2.0.0'].map(async version=>{
      const cwd=ensureDir(path.join(f.cwd,version)),vendor=ensureDir(path.join(cwd,'vendor/helper'));
      fs.writeFileSync(path.join(vendor,'package.json'),JSON.stringify({name:'loop-local-helper',version,main:'index.cjs'}));
      fs.writeFileSync(path.join(vendor,'index.cjs'),`module.exports=${JSON.stringify(version)};\n`);
      fs.writeFileSync(path.join(cwd,'package.json'),JSON.stringify({name:'fixture-'+version,type:'module',version:'1.0.0',dependencies:{'loop-local-helper':'file:vendor/helper'},scripts:{test:'node --test test.mjs'}}));
      fs.writeFileSync(path.join(cwd,'test.mjs'),`import test from 'node:test';import assert from 'node:assert/strict';import version from 'loop-local-helper';test('local dependency ${version}',()=>assert.equal(version,'${version}'));\n`);
      for(const command of ['npm install --package-lock-only --offline --ignore-scripts --no-audit --no-fund','npm ci --offline --ignore-scripts --no-audit --no-fund','npm test']){
        const result=await shellCommand(f.store,f.run.id,'npm-'+version,command,cwd,{timeout:30});assert.equal(result.exitCode,0,result.stderr||result.stdout);
      }
      const lock=JSON.parse(fs.readFileSync(path.join(cwd,'package-lock.json'),'utf8'));assert.equal(lock.packages['vendor/helper'].version,version);
      return cwd;
    }));
    assert.notEqual(checks[0],checks[1]);assert.equal(f.store.effects(f.run.id).length,6);
  }finally{f.close();}
});

test('worker scratch output is excluded from proposals; explicit output ownership and existing files stay protected',{timeout:30000},async()=>{
  const f=fixture();try{
    f.settings.generatedDirectories=['dist'];f.store.patchRun(f.run.id,{settings:f.settings});
    fs.writeFileSync(path.join(f.cwd,'source.mjs'),'export const value=1;\n');
    const ws=new Workspaces(f.store,f.store.run(f.run.id));await ws.prepare();
    const cwd=await ws.branch('worker'),baseline=await ws.baseline(cwd);
    fs.writeFileSync(path.join(cwd,'source.mjs'),'export const value=2;\n');
    ensureDir(path.join(cwd,'dist'));fs.writeFileSync(path.join(cwd,'dist/output.mjs'),'export const value=2;\n');
    const proposal=await ws.capture(cwd,baseline,['source.mjs']);
    assert.deepEqual(proposal.changes.map(c=>c.path),['source.mjs']);assert.equal(proposal.generatedArtifacts[0].path,'dist/output.mjs');
    const audit=await ws.branch('audit',{source:cwd,ref:proposal.commit,manifest:proposal.manifest});
    assert.equal(fs.existsSync(path.join(audit,'dist/output.mjs')),false);
    const explicit=await ws.capture(cwd,baseline,['source.mjs','dist']);assert(explicit.changes.some(c=>c.path==='dist/output.mjs'));
    const {classifyChanges}=await import('../server/workspace.mjs');
    assert.equal(classifyChanges([{path:'dist/existing.mjs',before:'original',after:'modified'}],f.settings).sourceMutations.length,1);
    assert.equal(classifyChanges([{path:'dist/existing.mjs',before:'original',after:null}],f.settings).sourceMutations.length,1);
  }finally{f.close();}
});
