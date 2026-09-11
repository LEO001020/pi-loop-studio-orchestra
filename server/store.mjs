import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { LOCAL,ensureDir,uid,now,sha,LoopError } from './util.mjs';
import { scrub } from './settings.mjs';

const decode = r => r ? JSON.parse(r.json) : null;
export class Store {
  listeners=new Set();
  constructor(file=path.join(LOCAL,'loop.sqlite')){
    if(file!==':memory:')ensureDir(path.dirname(file));this.db=new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,created TEXT NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id,created);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,status TEXT NOT NULL,spent INTEGER NOT NULL DEFAULT 0,budget INTEGER NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,role TEXT NOT NULL,node TEXT NOT NULL,started TEXT NOT NULL,ended TEXT,status TEXT NOT NULL,tokens INTEGER,unknown INTEGER NOT NULL DEFAULT 0,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS calls_run ON calls(run_id);
      CREATE TABLE IF NOT EXISTS effects(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,job_id TEXT NOT NULL,status TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT,session_id TEXT,type TEXT NOT NULL,at TEXT NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id,seq);
      CREATE TABLE IF NOT EXISTS submissions(session_id TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,run_id TEXT NOT NULL,PRIMARY KEY(session_id,request_id));
      PRAGMA user_version=2;`);
  }
  close(){this.db.close();}
  event(type,data={},runId=null,sessionId=null){
    const at=now(),clean=JSON.parse(scrub(data));const result=this.db.prepare('INSERT INTO events(run_id,session_id,type,at,json) VALUES(?,?,?,?,?)').run(runId,sessionId,type,at,JSON.stringify(clean));
    const e={seq:Number(result.lastInsertRowid),runId,sessionId,type,at,data:clean};
    for(const listener of this.listeners)try{listener(e);}catch{/* Presentation never owns a durable commit. */}
    return e;
  }
  events(after=0,limit=1000,runId){const rows=runId?this.db.prepare('SELECT * FROM events WHERE seq>? AND run_id=? ORDER BY seq LIMIT ?').all(after,runId,limit):this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(after,limit);return rows.map(r=>({seq:r.seq,runId:r.run_id,sessionId:r.session_id,type:r.type,at:r.at,data:JSON.parse(r.json)}));}
  cursor(){return this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get().seq;}
  session(id){return decode(this.db.prepare('SELECT json FROM sessions WHERE id=?').get(id));}
  sessions(){return this.db.prepare('SELECT json FROM sessions').all().map(decode).sort((a,b)=>b.updated.localeCompare(a.updated));}
  createSession(workspace,title='新对话'){const s={id:uid(),title,workspace,created:now(),updated:now(),memory:''};this.db.prepare('INSERT INTO sessions VALUES(?,?)').run(s.id,JSON.stringify(s));this.event('session.created',s,null,s.id);return s;}
  patchSession(id,patch){const s={...this.session(id),...patch,updated:now()};if(!s.id)throw new LoopError('NOT_FOUND');this.db.prepare('UPDATE sessions SET json=? WHERE id=?').run(JSON.stringify(s),id);this.event('session.updated',s,null,id);return s;}
  messages(id){return this.db.prepare('SELECT json FROM messages WHERE session_id=? ORDER BY created,rowid').all(id).map(decode).map(m=>({...m,created:m.created||m.createdAt}));}
  addMessage(sessionId,role,content,runId=null,id=uid()){
    const m={id,sessionId,role,content:scrub(content),created:now(),runId};const r=this.db.prepare('INSERT OR IGNORE INTO messages VALUES(?,?,?,?)').run(id,sessionId,m.created,JSON.stringify(m));if(r.changes){this.patchSession(sessionId,{});this.event('message',m,runId,sessionId);}return m;
  }
  createRun(sessionId,objective,settings,budget=settings.budgetTokens){
    const s=this.session(sessionId);if(!s)throw new LoopError('NOT_FOUND','会话不存在');
    const r={id:uid(),sessionId,objective,workspace:s.workspace,status:'queued',stage:'routing',created:now(),updated:now(),settings:structuredClone(settings),context:{steps:{},round:0},snapshot:null,error:null};
    this.db.prepare('INSERT INTO runs VALUES(?,?,?,0,?,?)').run(r.id,sessionId,r.status,budget,JSON.stringify(r));this.event('run.created',{id:r.id,objective},r.id,sessionId);return this.run(r.id);
  }
  submission(sessionId,requestId,payload){
    const row=this.db.prepare('SELECT * FROM submissions WHERE session_id=? AND request_id=?').get(sessionId,requestId);
    if(!row)return null;
    if(row.fingerprint!==sha(JSON.stringify(payload)))throw new LoopError('IDEMPOTENCY_CONFLICT','同一发送标识不能用于不同消息；请重新发送新的内容。');
    return this.run(row.run_id);
  }
  acceptSubmission(sessionId,requestId,payload,settings){
    const existing=this.submission(sessionId,requestId,payload);if(existing)return {run:existing,replayed:true};
    const session=this.session(sessionId);if(!session)throw new LoopError('NOT_FOUND','会话不存在');
    const at=now(),id=uid(),run={id,sessionId,objective:payload.content,workspace:session.workspace,mode:payload.mode,status:'queued',stage:'routing',created:at,updated:at,settings:structuredClone(settings),context:{steps:{},round:0},snapshot:null,error:null};
    const message={id:`${id}:user`,sessionId,role:'user',content:scrub(payload.content),created:at,runId:id};
    const changedSession={...session,updated:at,title:session.title==='新对话'?payload.content.replace(/\s+/g,' ').slice(0,48):session.title};
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.db.prepare('INSERT INTO runs VALUES(?,?,?,0,?,?)').run(id,sessionId,'queued',payload.budget,JSON.stringify(run));
      this.db.prepare('INSERT INTO messages VALUES(?,?,?,?)').run(message.id,sessionId,at,JSON.stringify(message));
      this.db.prepare('INSERT INTO submissions VALUES(?,?,?,?)').run(sessionId,requestId,sha(JSON.stringify(payload)),id);
      this.db.prepare('UPDATE sessions SET json=? WHERE id=?').run(JSON.stringify(changedSession),sessionId);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    // Presentation notifications happen only after all durable rows commit.
    this.event('run.created',{id,objective:payload.content},id,sessionId);this.event('message',message,id,sessionId);this.event('session.updated',changedSession,null,sessionId);
    return {run:this.run(id),replayed:false};
  }
  hasUnknownEffects(runId){return this.effects(runId).some(e=>['running','unknown'].includes(e.status));}
  // Running peer commands are not unknown and must not serialize fan-out.
  hasUnresolvedEffects(runId){return Boolean(this.db.prepare("SELECT 1 FROM effects WHERE run_id=? AND status='unknown' LIMIT 1").get(runId));}
  run(id){const r=this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);return r?{...JSON.parse(r.json),spent:r.spent,budget:r.budget}:null;}
  runs(sessionId){const rs=sessionId?this.db.prepare('SELECT id FROM runs WHERE session_id=? ORDER BY rowid DESC').all(sessionId):this.db.prepare('SELECT id FROM runs ORDER BY rowid DESC').all();return rs.map(r=>this.run(r.id));}
  patchRun(id,patch,{emit=true}={}){const old=this.run(id);if(!old)throw new LoopError('NOT_FOUND');const r={...old,...patch,updated:now()};const {spent,budget,...json}=r;this.db.prepare('UPDATE runs SET status=?,budget=?,json=? WHERE id=?').run(r.status,budget,JSON.stringify(json),id);if(emit)this.event('run.updated',{id,status:r.status,stage:r.stage,error:r.error},id,r.sessionId);return this.run(id);}
  checkpoint(id,key,result){const r=this.run(id);r.context.steps[key]={status:'done',result,at:now()};return this.patchRun(id,{context:r.context},{emit:false});}
  job(id){return decode(this.db.prepare('SELECT json FROM jobs WHERE id=?').get(id));}
  jobs(runId){return this.db.prepare('SELECT json FROM jobs WHERE run_id=? ORDER BY rowid').all(runId).map(decode);}
  putJob(j){this.db.prepare('INSERT INTO jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(j.id,j.runId,JSON.stringify(j));this.event('job.updated',{id:j.id,status:j.status,title:j.title,attempt:j.attempt},j.runId);return j;}
  patchJob(id,p){const j=this.job(id);if(!j)throw new LoopError('NOT_FOUND');return this.putJob({...j,...p,updated:now()});}
  beginCall(runId,role,node){
    const r=this.run(runId);if(!r)throw new LoopError('NOT_FOUND');
    if(['completed','cancelled'].includes(r.status))throw new LoopError('CANCELLED','已结束的任务不能继续发出模型请求');
    if(this.hasUnresolvedEffects(runId))throw new LoopError('EFFECT_UNKNOWN','已发出的原生命令结果未知；请在回执中处理，未继续派发模型或重放操作。');
    if(r.pauseRequested)throw new LoopError('USER_PAUSED','用户请求暂停；已发出请求照常结算，不再发出新请求。');
    if(r.spent>=r.budget)throw new LoopError('BUDGET_PAUSED',`实际已结算 ${r.spent} token，预算 ${r.budget}；没有冻结额度。增加本任务预算后可继续。`);
    const id=uid(),started=now();this.db.prepare('INSERT INTO calls VALUES(?,?,?,?,?,NULL,?,NULL,0,?)').run(id,runId,role,node,started,'running',JSON.stringify({}));this.event('call.started',{id,role,node,spent:r.spent,budget:r.budget},runId);return id;
  }
  settleCall(id,message,error){
    const call=this.db.prepare('SELECT * FROM calls WHERE id=?').get(id);if(!call||call.ended)return;
    const u=message?.usage;const total=u?Number(u.totalTokens??((u.input||0)+(u.output||0)+(u.cacheRead||0)+(u.cacheWrite||0))):0;
    const known=Number.isSafeInteger(total)&&total>0;const tokens=known?total:null;
    const status=error?'error':message?.stopReason==='aborted'?'aborted':message?.stopReason==='error'?'error':'completed';
    const details={usage:u||null,stopReason:message?.stopReason||null,error:error?scrub(String(error)):message?.errorMessage?scrub(message.errorMessage):null};
    this.db.exec('BEGIN IMMEDIATE');
    try{this.db.prepare('UPDATE calls SET ended=?,status=?,tokens=?,unknown=?,json=? WHERE id=? AND ended IS NULL').run(now(),status,tokens,known?0:1,JSON.stringify(details),id);if(known)this.db.prepare('UPDATE runs SET spent=spent+? WHERE id=?').run(tokens,call.run_id);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
    const r=this.run(call.run_id);this.event('call.settled',{id,role:call.role,node:call.node,tokens,usageKnown:known,status,spent:r.spent,budget:r.budget,overshoot:Math.max(0,r.spent-r.budget)},call.run_id);
  }
  calls(runId){return this.db.prepare('SELECT * FROM calls WHERE run_id=? ORDER BY started').all(runId).map(r=>({...r,details:JSON.parse(r.json),json:undefined}));}
  effect(id){return decode(this.db.prepare('SELECT json FROM effects WHERE id=?').get(id));}
  effects(runId){return this.db.prepare('SELECT json FROM effects WHERE run_id=? ORDER BY rowid').all(runId).map(decode);}
  putEffect(e){this.db.prepare('INSERT INTO effects VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,json=excluded.json').run(e.id,e.runId,e.jobId,e.status,JSON.stringify(e));this.event('command.updated',{id:e.id,jobId:e.jobId,status:e.status,command:e.command,exitCode:e.exitCode},e.runId);return e;}
  recoverCalls(){for(const c of this.db.prepare("SELECT id FROM calls WHERE ended IS NULL").all())this.settleCall(c.id,null,'进程重启：远端请求结果及用量未知，未记为零消耗');}
  metrics(runId){const rows=this.calls(runId),role={};for(const c of rows){role[c.role]??={calls:0,tokens:0,unknown:0};role[c.role].calls++;role[c.role].tokens+=c.tokens||0;role[c.role].unknown+=c.unknown;}return {roles:role,unknown:rows.filter(c=>c.unknown).length,active:rows.filter(c=>!c.ended).length,totalCalls:rows.length};}
}
