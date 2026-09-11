import path from 'node:path';
import {APP_ROOT,now,writeJSON,sleep} from '../server/util.mjs';
import {loadSettings} from '../server/settings.mjs';

const [action,id,value]=process.argv.slice(2),base=`http://127.0.0.1:${loadSettings().port}`;
const report={started:now(),command:process.argv,cwd:APP_ROOT,environment:{node:process.version,platform:process.platform},action,runId:id,exitCode:null};
async function request(url,method='GET',body){const r=await fetch(base+'/api'+url,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});const data=await r.json();if(!r.ok)throw new Error(JSON.stringify(data.error));return data;}
const brief=d=>({run:{id:d.run.id,status:d.run.status,stage:d.run.stage,spent:d.run.spent,budget:d.run.budget,pauseRequested:d.run.pauseRequested,error:d.run.error},metrics:d.metrics,jobs:d.jobs.map(j=>({id:j.taskId,role:j.role,status:j.status,attempt:j.attempt,auditPass:j.audit?.pass,integrated:Boolean(j.integratedCommit)}))});
try{
  if(!['status','pause','resume','budget','cancel'].includes(action)||!/^[a-f\d-]{36}$/i.test(id||''))throw new Error('Usage: node scripts/control.mjs status|pause|resume|budget|cancel RUN_ID [new-budget]');
  const health=await request('/health');if(health.app!=='pi-loop-studio'||health.root!==APP_ROOT)throw new Error('The listening host belongs to another installation');
  const initial=await request(`/runs/${id}`);report.before=brief(initial);
  let data=initial;
  if(action==='budget'){
    const budget=Number(value);if(!Number.isSafeInteger(budget)||budget<1)throw new Error('Budget must be a positive integer');data=await request(`/runs/${id}/budget`,'PATCH',{budget});
  }else if(action!=='status'){
    if(['completed','cancelled'].includes(initial.run.status))report.noop='Run is already terminal; no state-changing request was sent';
    else data=await request(`/runs/${id}/${action}`,'POST',{});
  }
  if(action==='pause'){
    const deadline=Date.now()+240000;
    while(['running','queued'].includes(data.run.status)&&Date.now()<deadline){console.log(JSON.stringify({at:now(),status:data.run.status,stage:data.run.stage,active:data.metrics.active,spent:data.run.spent}));await sleep(2000);data=await request(`/runs/${id}`);}
  }
  report.after=brief(data);report.exitCode=0;
}catch(e){report.error=e.stack;report.exitCode=1;}
report.finished=now();const file=path.join(APP_ROOT,'validation',`control-${Date.now()}-${action}.json`);writeJSON(file,report);console.log(JSON.stringify({...report,receipt:file},null,2));process.exitCode=report.exitCode;
