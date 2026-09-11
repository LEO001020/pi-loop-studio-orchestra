import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {APP_ROOT,uid,now,ensureDir,writeJSON,sha} from '../server/util.mjs';
import {executeProcess} from '../server/commands.mjs';

const directory=ensureDir(path.join(APP_ROOT,'validation',`portable-${uid()}`)),destination=path.join(directory,'中文 空格','Pi Loop Studio');
const report={started:now(),command:process.argv,cwd:APP_ROOT,destination,kind:'CLEAN_RELOCATION_INSTALLATION_NOT_MODEL_VERIFICATION',environment:{node:process.version,platform:process.platform},copied:[],steps:[],exitCode:null};
try{
  ensureDir(destination);
  const roots=['server','ui','public','desktop','scripts','tests','vendor','node_modules','dist','.runtime/node-home','.runtime/python-home','.python'];
  const rootFiles=['package.json','package-lock.json','config.example.json','credentials.example.json','tsconfig.json','vite.config.ts','index.html','requirements.lock','AGENTS.md','README.md','LICENSE','Install Pi Loop Studio.cmd','Open Pi Loop Studio.cmd','Stop Pi Loop Studio.cmd'];
  for(const rel of [...roots,...rootFiles]){
    const src=path.join(APP_ROOT,rel),dst=path.join(destination,rel);
    if(fs.existsSync(src)){fs.cpSync(src,dst,{recursive:true,filter:p=>!p.split(path.sep).some(s=>['__pycache__','.cache','.vite'].includes(s))});report.copied.push(rel);}
  }
  // Exercise MinGit's fresh staged installation from the pinned local archive.
  const archive='.runtime/downloads/MinGit-2.55.0.5-64-bit.zip';assert(fs.existsSync(path.join(APP_ROOT,archive)));
  ensureDir(path.dirname(path.join(destination,archive)));fs.copyFileSync(path.join(APP_ROOT,archive),path.join(destination,archive));
  assert(!fs.existsSync(path.join(destination,'.local')));
  const node=path.join(destination,'.runtime/node-home/node.exe');assert.equal(sha(fs.readFileSync(node)),sha(fs.readFileSync(process.execPath)));
  console.log('Clean copy complete: '+destination);writeJSON(path.join(directory,'progress.json'),report);
  for(const script of ['install.mjs','portable-smoke.mjs']){
    const result=await executeProcess(node,[path.join(destination,'scripts',script)],{cwd:destination,timeout:420});report.steps.push(result);console.log(script+': exit '+result.exitCode);assert.equal(result.exitCode,0,result.stderr||result.stdout);
  }
  report.smoke=JSON.parse(fs.readFileSync(path.join(destination,'validation/portable-smoke.json'),'utf8'));assert.equal(report.smoke.exitCode,0);
  report.exitCode=0;report.status='VERIFIED_CLEAN_CHINESE_PATH_INSTALLATION';
}catch(e){report.exitCode=1;report.status='FAILED';report.error=e.stack;}
report.finished=now();writeJSON(path.join(directory,'receipt.json'),report);console.log(JSON.stringify({receipt:path.join(directory,'receipt.json'),status:report.status,exitCode:report.exitCode,error:report.error},null,2));process.exitCode=report.exitCode;
