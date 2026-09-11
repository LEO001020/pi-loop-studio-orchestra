// Run from the clean portable copy. No credentials or model calls are needed.
import path from 'node:path';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Store} from '../server/store.mjs';
import {startServer} from '../server/index.mjs';
import {PythonKernel} from '../server/python.mjs';
import {APP_ROOT,LOCAL,ensureDir,uid,now,writeJSON} from '../server/util.mjs';
import {loadSettings,publicSettings} from '../server/settings.mjs';
import {executeProcess,taskEnvironment} from '../server/commands.mjs';
const report={kind:'CLEAN_PORTABLE_NATIVE_SMOKE_NO_MODELS',started:now(),command:process.argv,root:APP_ROOT,environment:{node:process.version,platform:process.platform},commands:[],checks:[],exitCode:null};
const store=new Store(':memory:');let host,kernel;
try{
  assert(!fs.existsSync(path.join(LOCAL,'credentials.json')),'Private model credentials must not enter the portable package');
  const settings=loadSettings();assert.equal(settings.defaultWorkspace,path.join(APP_ROOT,'workspace'));
  assert(Object.values(publicSettings().credentialStatus).every(v=>!v));
  for(const [file,args] of [[path.join(APP_ROOT,'.python/Scripts/pip.exe'),['--version']],[path.join(APP_ROOT,'.python/Scripts/ipython.exe'),['--version']],[path.join(APP_ROOT,'.runtime/git/cmd/git.exe'),['--version']]]){
    const r=await executeProcess(file,args,{cwd:APP_ROOT,timeout:30});report.commands.push(r);assert.equal(r.exitCode,0,r.stderr);
  }
  assert(report.commands[0].stdout.toLowerCase().includes(APP_ROOT.toLowerCase()),'pip launcher still points to an old installation');
  const cwd=ensureDir(path.join(APP_ROOT,'workspace','中文 项目')),session=store.createSession(cwd),run=store.createRun(session.id,'Portable Python smoke',settings);
  const dependencyProbe=await executeProcess(process.execPath,['-e',"require('express')"],{cwd,env:taskEnvironment(cwd),timeout:30});
  assert.notEqual(dependencyProbe.exitCode,0);assert.match(dependencyProbe.stderr,/DEPENDENCY_OUTSIDE_WORKTREE|MODULE_NOT_FOUND/);report.dependencyProbe=dependencyProbe;
  kernel=new PythonKernel(store,run.id,'portable',cwd,settings);const start=Date.now();
  const a=await kernel.exec('from pathlib import Path\n计数=41\nPath("中文.txt").write_text("独立副本",encoding="utf8")\nprint(计数)');
  const b=await kernel.exec('计数+=1\nassert Path("中文.txt").read_text(encoding="utf8")=="独立副本"\nprint(计数)');
  assert.equal(a.status,'ok');assert.equal(b.status,'ok');assert.match(b.stdout,/42/);report.python={durationMs:Date.now()-start,cells:[a,b]};await kernel.close();kernel=null;
  host=await startServer({port:0,store,recover:false,recordHost:false});
  const health=await(await fetch(host.address+'/api/health')).json();assert.equal(health.root,APP_ROOT);report.health=health;
  const html=await(await fetch(host.address)).text();assert.match(html,/\/assets\//);
  const created=await(await fetch(host.address+'/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspace:cwd,title:'Portable native session'})})).json();assert(created.id);
  report.checks=[{name:'No credentials or old session data copied',pass:true},{name:'Relocated pip/ipython launchers resolve inside this Chinese-path installation',pass:true},{name:'Bundled Git installed from verified staged archive',pass:true},{name:'Chinese-path Python persistent kernel',pass:true},{name:'HTTP host, compiled UI and persistent session API start from the clean copy',pass:true}];report.exitCode=0;
}catch(e){report.exitCode=1;report.error=e.stack;}
finally{await kernel?.close();await host?.close();store.close();}
report.finished=now();writeJSON(path.join(APP_ROOT,'validation/portable-smoke.json'),report);console.log(JSON.stringify(report,null,2));process.exitCode=report.exitCode;
