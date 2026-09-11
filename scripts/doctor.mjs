import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {APP_ROOT,LOCAL,now,writeJSON,sha} from '../server/util.mjs';
import {loadSettings,publicSettings} from '../server/settings.mjs';
import {executeProcess} from '../server/commands.mjs';
import {probeConnections} from '../server/pi.mjs';

const report={started:now(),command:process.argv,cwd:APP_ROOT,environment:{node:process.version,platform:process.platform,arch:process.arch,os:os.release()},checks:[],status:'RUNNING',exitCode:null};
const check=(name,ok,details)=>report.checks.push({name,ok,details});
try{
  const s=loadSettings(),p=publicSettings();
  check('native-runtime',process.platform==='win32'&&process.arch==='x64',{version:process.version,executable:process.execPath,sha256:sha(fs.readFileSync(process.execPath))});
  for(const [name,file] of Object.entries({UI:'dist/index.html',Git:'.runtime/git/cmd/git.exe',Python:'.python/Scripts/python.exe',Bridge:'vendor/pi-repl-py/bridge.py',DependencyLock:'package-lock.json'}))check(name,fs.existsSync(path.join(APP_ROOT,file)),{file});
  for(const role of ['principal','executor','auxiliary'])check(`${role}-credential-present`,p.credentialStatus[role],{model:s.models[role].model,concurrency:s.models[role].concurrency});
  report.commands=[];
  for(const [file,args] of [[process.execPath,['--version']],[path.join(APP_ROOT,'.python/Scripts/python.exe'),['-X','utf8','-c','import sys,ipykernel,zmq,cloudpickle; print(sys.version); print("bridge imports OK")']],[path.join(APP_ROOT,'.runtime/git/cmd/git.exe'),['--version']]]){
    const result=await executeProcess(file,args,{cwd:APP_ROOT,timeout:30});report.commands.push(result);check(path.basename(file),result.exitCode===0,{exitCode:result.exitCode});
  }
  report.connections=await probeConnections(s);report.transportOnly=true;
  report.status=report.checks.some(c=>!c.ok)?'INSTALLATION_FAILED':report.connections.some(c=>!c.ok)?'DEPENDENCY_BLOCKED':'READY_FOR_LIVE_VERIFICATION';
  report.exitCode=report.status==='INSTALLATION_FAILED'?1:report.status==='DEPENDENCY_BLOCKED'?2:0;
}catch(e){report.status='FAILED';report.error=e.stack;report.exitCode=1;}
report.finished=now();const file=path.join(APP_ROOT,'validation',`doctor-${Date.now()}.json`);writeJSON(file,report);
console.log(JSON.stringify({...report,receipt:file},null,2));process.exitCode=report.exitCode;
