import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {APP_ROOT,LOCAL,uid,now,ensureDir,writeJSON,sleep} from '../server/util.mjs';
import {loadSettings} from '../server/settings.mjs';
import {executeProcess} from '../server/commands.mjs';

const base=`http://127.0.0.1:${loadSettings().port}`,dir=ensureDir(path.join(APP_ROOT,'validation',`restart-${Date.now()}`));
const report={started:now(),command:process.argv,cwd:APP_ROOT,environment:{node:process.version,platform:process.platform},checks:[],exitCode:null};
async function request(url,method='GET',body){const r=await fetch(base+'/api'+url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(3000)});const result=await r.json();if(!r.ok)throw new Error(JSON.stringify(result));return result;}
try{
  const before=await request('/health');assert.equal(before.app,'pi-loop-studio');assert.equal(before.root,APP_ROOT);
  const sessions=(await request('/sessions')).sessions;const saved=[];
  for(const session of sessions){const data=await request(`/sessions/${session.id}`);if(data.runs.some(r=>['running','queued'].includes(r.status)))throw new Error('ACTIVE_TASK_PRESENT: restart acceptance will not interrupt a user task');saved.push(data);}
  const marker=await request('/sessions','POST',{title:`重启验收 ${uid().slice(0,8)}`});
  await request('/shutdown','POST',{});
  let gone=false;for(let i=0;i<60;i++){try{await request('/health');}catch{gone=true;break;}await sleep(250);}assert(gone,'Server did not close');
  report.launch=await executeProcess(process.execPath,[path.join(APP_ROOT,'scripts/launch.mjs'),'--no-browser'],{cwd:APP_ROOT,timeout:60});assert.equal(report.launch.exitCode,0);
  const after=await request('/health');assert.notEqual(after.bootId,before.bootId);report.boots={before:before.bootId,after:after.bootId};
  assert.equal((await request(`/sessions/${marker.id}`)).session.id,marker.id);report.checks.push({name:'Persistent session ID after real host process restart',pass:true,sessionId:marker.id});
  for(const old of saved){const current=await request(`/sessions/${old.session.id}`);assert.deepEqual(current.messages,old.messages);assert.deepEqual(current.runs.map(r=>[r.id,r.spent,r.status]),old.runs.map(r=>[r.id,r.spent,r.status]));}
  report.checks.push({name:'Existing messages, run identities and settled usage retained without replay',pass:true,sessions:saved.length});
  const firstLaunch=JSON.parse(fs.readFileSync(path.join(LOCAL,'last-launch.json'),'utf8'));
  report.duplicateLaunch=await executeProcess(process.execPath,[path.join(APP_ROOT,'scripts/launch.mjs'),'--no-browser'],{cwd:APP_ROOT,timeout:30});assert.equal(report.duplicateLaunch.exitCode,0);
  const second=await request('/health');assert.equal(second.bootId,after.bootId);assert.equal(JSON.parse(fs.readFileSync(path.join(LOCAL,'last-launch.json'),'utf8')).startedPid,undefined);
  report.checks.push({name:'Repeated launch reuses the listening host without a watchdog or lockfile',pass:true,bootId:second.bootId});report.exitCode=0;report.status='VERIFIED_RESTART_SCOPE';
}catch(e){report.exitCode=1;report.status='FAILED_OR_BLOCKED';report.error=e.stack;}
report.finished=now();writeJSON(path.join(dir,'receipt.json'),report);console.log(JSON.stringify({...report,receipt:path.join(dir,'receipt.json')},null,2));process.exitCode=report.exitCode;
