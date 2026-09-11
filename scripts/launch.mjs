import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {APP_ROOT,LOCAL,ensureDir,readJSON,now,writeJSON} from '../server/util.mjs';

const node=path.join(APP_ROOT,'.runtime/node-home/node.exe');
async function health(address){
  try{const response=await fetch(address+'/api/health',{signal:AbortSignal.timeout(1200)});return await response.json().catch(()=>({app:'UNKNOWN_PORT_OWNER'}));}catch{return null;}
}
const record={started:now(),command:process.argv,cwd:APP_ROOT,exitCode:null};
try{
  if(!fs.existsSync(path.join(APP_ROOT,'node_modules/xstate/package.json'))||!fs.existsSync(path.join(APP_ROOT,'dist/index.html'))){
    const installation=spawnSync(node,[path.join(APP_ROOT,'scripts/install.mjs')],{cwd:APP_ROOT,stdio:'inherit',windowsHide:true});
    if(installation.status!==0)throw new Error('Installation did not complete; see validation/install-*.json.');
  }
  const {loadSettings}=await import('../server/settings.mjs');
  const settings=loadSettings();let address=`http://127.0.0.1:${settings.port}`;
  const previous=readJSON(path.join(LOCAL,'host.json'),null);
  if(previous?.root===APP_ROOT&&/^http:\/\/127\.0\.0\.1:\d+$/.test(previous.address)){
    const old=await health(previous.address);if(old?.app==='pi-loop-studio'&&old.root===APP_ROOT&&old.bootId===previous.bootId)address=previous.address;
  }
  let state=await health(address);
  if(state&&(state.app!=='pi-loop-studio'||state.root!==APP_ROOT))throw new Error('The configured port belongs to another application or another installation. It was not stopped or modified.');
  if(!state){
    ensureDir(LOCAL);const stdout=fs.openSync(path.join(LOCAL,'server.stdout.log'),'a'),stderr=fs.openSync(path.join(LOCAL,'server.stderr.log'),'a');
    const child=spawn(node,[path.join(APP_ROOT,'server/index.mjs')],{cwd:APP_ROOT,windowsHide:true,detached:true,stdio:['ignore',stdout,stderr]});
    let spawnError;child.once('error',error=>{spawnError=error;});child.unref();fs.closeSync(stdout);fs.closeSync(stderr);
    for(let i=0;i<100;i++){if(spawnError)throw spawnError;state=await health(address);if(state)break;await new Promise(resolve=>setTimeout(resolve,200));}
    if(!state)throw new Error(`Host did not become ready. Read ${path.join(LOCAL,'server.stderr.log')}. Existing sessions were not deleted.`);
    record.startedPid=child.pid;
  }
  if(state.app!=='pi-loop-studio'||state.root!==APP_ROOT)throw new Error('Unexpected HTTP host; no browser opened.');
  record.address=address;record.bootId=state.bootId;
  if(!process.argv.includes('--no-browser')){
    const candidates=[path.join(process.env['ProgramFiles(x86)']||'C:\\Program Files (x86)','Microsoft/Edge/Application/msedge.exe'),path.join(process.env.ProgramFiles||'C:\\Program Files','Microsoft/Edge/Application/msedge.exe')];
    const edge=candidates.find(fs.existsSync);
    const child=edge?spawn(edge,[`--app=${address}`,'--new-window'],{windowsHide:true,detached:true,stdio:'ignore'}):spawn('explorer.exe',[address],{windowsHide:true,detached:true,stdio:'ignore'});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();record.desktop=edge?'Edge application window':'default browser';
  }
  record.exitCode=0;console.log(`Pi Loop Studio: ${address}`);
}catch(error){record.exitCode=1;record.error=error.message;console.error(error.message);process.exitCode=1;}
record.finished=now();writeJSON(path.join(LOCAL,'last-launch.json'),record);

