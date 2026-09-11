import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const root=path.resolve(import.meta.dirname,'..');
const source=path.resolve(root,'../pi-loop-v2');
const db=new DatabaseSync(path.join(source,'.local/loop.sqlite'),{readOnly:true});
const runs=db.prepare('SELECT id,json FROM runs').all();
const result=[];
for(const row of runs){
  const r=JSON.parse(row.json);
  const jobs=db.prepare('SELECT json FROM jobs WHERE run_id=?').all(row.id).map(x=>JSON.parse(x.json)).map(j=>({id:j.taskId,status:j.status,round:j.round,attempt:j.attempt,title:j.title,ownedPaths:j.ownedPaths,
    error:j.error,audit:j.audit,changes:j.proposal?.changes?.length,integrated:Boolean(j.integratedCommit),trace:j.work?.trace}));
  const calls=db.prepare('SELECT node,COUNT(*) calls,SUM(tokens) tokens,MAX(tokens) maxCallTokens,SUM(unknown) unknown FROM calls WHERE run_id=? GROUP BY node ORDER BY tokens DESC').all(row.id);
  const errors=db.prepare("SELECT type,json FROM events WHERE run_id=? AND type='tool.completed'").all(row.id).map(x=>JSON.parse(x.json)).filter(x=>x.isError);
  result.push({runId:row.id,stage:r.stage,error:r.error,jobs,calls,toolErrors:errors});
}
db.close();
// Recorded task metadata only; not a read of credential files or browser data.
fs.writeFileSync(path.join(root,'validation/reconciliation/reference-failures.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result.map(r=>({...r,jobs:r.jobs.map(j=>({...j,audit:j.audit?{pass:j.audit.pass,reason:j.audit.reason}:undefined,trace:undefined})),calls:r.calls.slice(0,12),toolErrors:r.toolErrors.slice(0,16)})),null,2));
