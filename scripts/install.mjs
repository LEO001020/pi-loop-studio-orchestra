import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {APP_ROOT,LOCAL,ensureDir,readJSON,writeJSON,now} from '../server/util.mjs';

const node=path.join(APP_ROOT,'.runtime/node-home/node.exe');
const npm=path.join(APP_ROOT,'.runtime/node-home/node_modules/npm/bin/npm-cli.js');
const env={...process.env,PATH:[path.dirname(node),path.join(APP_ROOT,'.runtime/git/cmd'),path.join(APP_ROOT,'.python/Scripts'),process.env.PATH||''].join(path.delimiter)};
const record={started:now(),command:process.argv,cwd:APP_ROOT,environment:{node:process.version,platform:process.platform,arch:process.arch},steps:[],exitCode:null};
function run(file,args){
  const result=spawnSync(file,args,{cwd:APP_ROOT,env,encoding:'utf8',windowsHide:true,timeout:540000,maxBuffer:12*1048576});
  const step={command:[file,...args],stdout:result.stdout||'',stderr:result.stderr||'',exitCode:result.status,error:result.error?.message};record.steps.push(step);
  if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);
  if(result.status!==0)throw new Error(`${path.basename(file)} exited ${result.status}: ${result.error?.message||'see installation receipt'}`);
}
try{
  if(process.platform!=='win32')throw new Error('This package targets native Windows x64.');
  for(const file of [node,npm,path.join(APP_ROOT,'.runtime/python-home/python.exe'),path.join(APP_ROOT,'.python/Scripts/python.exe')])if(!fs.existsSync(file))throw new Error(`Required bundled runtime missing: ${file}`);
  ensureDir(LOCAL);ensureDir(path.join(APP_ROOT,'workspace'));
  const settingsFile=path.join(LOCAL,'settings.json');
  if(!fs.existsSync(settingsFile)){
    const config=readJSON(path.join(APP_ROOT,'config.example.json'));
    config.defaultWorkspace=path.join(APP_ROOT,'workspace');
    config.roots=config.roots.map(r=>r.alias==='code'?{...r,path:path.dirname(APP_ROOT)}:r);
    writeJSON(settingsFile,config);
  }
  const venv=path.join(APP_ROOT,'.python/pyvenv.cfg'),home=path.join(APP_ROOT,'.runtime/python-home');
  fs.writeFileSync(venv,fs.readFileSync(venv,'utf8').replace(/^home\s*=.*$/m,`home = ${home}`).replace(/^executable\s*=.*$/m,`executable = ${path.join(home,'python.exe')}`));
  run(node,[path.join(APP_ROOT,'scripts/bundle-git.mjs')]);
  run(path.join(APP_ROOT,'.python/Scripts/python.exe'),['-X','utf8',path.join(APP_ROOT,'scripts/relocate-python.py')]);
  if(process.argv.includes('--reinstall')||!fs.existsSync(path.join(APP_ROOT,'node_modules/xstate/package.json')))run(node,[npm,'ci','--no-audit','--no-fund']);
  run(node,[path.join(APP_ROOT,'node_modules/typescript/bin/tsc'),'--noEmit']);
  run(node,[path.join(APP_ROOT,'node_modules/vite/bin/vite.js'),'build']);
  run(path.join(APP_ROOT,'.python/Scripts/python.exe'),['-X','utf8','-c','import sys,ipykernel,zmq,cloudpickle; print(sys.version); print("Python bridge dependencies available")']);
  if(process.argv.includes('--desktop'))run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(APP_ROOT,'desktop/install-shortcut.ps1'),'-ApplicationRoot',APP_ROOT]);
  record.exitCode=0;console.log('Installation completed. Open Pi Loop Studio.cmd starts the desktop window; no environment variables need to be configured.');
}catch(error){record.exitCode=1;record.error=error.stack;console.error(error.message);process.exitCode=1;}
record.finished=now();writeJSON(path.join(APP_ROOT,'validation',`install-${Date.now()}.json`),record);

