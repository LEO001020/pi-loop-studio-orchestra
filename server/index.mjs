import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import express from 'express';
import { Store } from './store.mjs';
import { LoopHost,ROOT_GRAPH,JOB_GRAPH } from './workflow.mjs';
import { probeConnections } from './pi.mjs';
import { APP_ROOT,LOCAL,uid,now,LoopError,inside,portablePath,writeJSON } from './util.mjs';
import { loadSettings,publicSettings,saveSettings,saveCredentials,resolveWorkspace,scrub } from './settings.mjs';

const ACTIVE=new Set(['queued','running']);
process.env.PATH=[path.join(APP_ROOT,'.runtime','git','cmd'),path.join(APP_ROOT,'.runtime','node-home'),path.join(APP_ROOT,'.python','Scripts'),process.env.PATH].filter(Boolean).join(path.delimiter);
const integer=(v,min=1)=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<min)throw new LoopError('INVALID_NUMBER','请输入有效整数');return n;};
export async function startServer({port,store=new Store(),recover=true,recordHost=true}={}){
  const settings=loadSettings(),app=express(),host=new LoopHost(store),bootId=uid();
  let server,closing=false;const streams=new Set();
  app.disable('x-powered-by');
  app.use((req,res,next)=>{
    const hostname=req.hostname;
    if(!['127.0.0.1','localhost','[::1]','::1'].includes(hostname))return res.status(403).json({error:{code:'LOCAL_ONLY',message:'此应用仅接受本机地址'}});
    const origin=req.get('origin');
    if(origin&&origin!==`http://${req.get('host')}`)return res.status(403).json({error:{code:'ORIGIN_REJECTED',message:'拒绝跨源请求'}});
    if(['POST','PUT','PATCH','DELETE'].includes(req.method)&&!req.is('application/json'))return res.status(415).json({error:{code:'JSON_REQUIRED',message:'写入请求必须使用 JSON'}});
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
    next();
  });
  app.use(express.json({limit:'3mb'}));
  const run=id=>{const r=store.run(id);if(!r)throw new LoopError('NOT_FOUND','任务不存在');return r;};
  const session=id=>{const s=store.session(id);if(!s)throw new LoopError('NOT_FOUND','会话不存在；请新建会话');return s;};
  const summary=r=>({id:r.id,sessionId:r.sessionId,workspace:r.workspace,objective:r.objective.slice(0,400),status:r.status,stage:r.stage,budget:r.budget,spent:r.spent,created:r.created,error:r.error});
  const details=(id,{full=false}={})=>{
    const r=run(id),jobs=store.jobs(id),calls=store.calls(id),effects=store.effects(id);
    return {run:full?r:{...r,context:{...r.context,steps:Object.fromEntries(Object.entries(r.context.steps||{}).map(([key,value])=>[key,{status:value.status}]))}},
      jobs:full?jobs:jobs.map(j=>({...j,proposal:j.proposal?{...j.proposal,diff:j.proposal.diff?.slice(0,30000),diffTruncated:j.proposal.diffTruncated||j.proposal.diff?.length>30000}:null})),
      calls:full?calls:calls.slice(-500),effects:full?effects:effects.slice(-100).map(e=>({...e,stdout:e.stdout?.slice(-16000),stderr:e.stderr?.slice(-16000),previewTruncated:(e.stdout?.length||0)>16000||(e.stderr?.length||0)>16000})),
      metrics:store.metrics(id),graph:ROOT_GRAPH,jobGraph:JOB_GRAPH,cursor:store.cursor(),preview:!full};
  };
  app.get('/api/health',(_req,res)=>res.json({ok:true,app:'pi-loop-studio',version:'2.0.0-candidate.3',root:APP_ROOT,bootId,node:process.version,platform:process.platform,at:now(),port:server?.address()?.port}));
  app.get('/api/settings',(_req,res)=>res.json(publicSettings()));
  app.put('/api/settings',(req,res)=>{saveSettings(req.body);res.json(publicSettings());});
  app.put('/api/credentials',(req,res)=>res.json({credentialStatus:saveCredentials(req.body)}));
  app.post('/api/connections/check',async(_req,res)=>res.json({connections:await probeConnections(loadSettings()),at:now(),note:'只检查 TCP 可达性，不消耗模型 token，也不代表 API 认证或真实模型调用已验证。'}));
  app.get('/api/graph',(_req,res)=>res.json({root:ROOT_GRAPH,job:JOB_GRAPH}));
  app.get('/api/sessions',(_req,res)=>res.json({sessions:store.sessions(),cursor:store.cursor()}));
  app.post('/api/sessions',(req,res)=>{
    const s=loadSettings(),workspace=resolveWorkspace(req.body.workspace||s.defaultWorkspace,s);
    res.status(201).json(store.createSession(workspace,String(req.body.title||'新对话').slice(0,120)));
  });
  app.get('/api/sessions/:id',(req,res)=>res.json({session:session(req.params.id),messages:store.messages(req.params.id),runs:store.runs(req.params.id).map(summary),cursor:store.cursor()}));
  app.patch('/api/sessions/:id',(req,res)=>{
    const s=session(req.params.id),patch={};
    if(typeof req.body.title==='string')patch.title=req.body.title.trim().slice(0,120)||'新对话';
    if(req.body.workspace){if(store.runs(s.id).some(r=>ACTIVE.has(r.status)))throw new LoopError('TASK_RUNNING','任务执行中不能切换其工作区');patch.workspace=resolveWorkspace(req.body.workspace);}
    if(typeof req.body.archived==='boolean')patch.archived=req.body.archived;
    res.json(store.patchSession(s.id,patch));
  });
  app.post('/api/sessions/:id/messages',(req,res)=>{
    if(closing)throw new LoopError('SHUTTING_DOWN','服务正在关闭');
    const s=session(req.params.id),content=String(req.body.content||'').trim();
    if(!content||content.length>150000)throw new LoopError('INVALID_MESSAGE','消息不能为空，且不能超过 150000 字符');
    const settings=loadSettings(),budget=req.body.budget===undefined?settings.budgetTokens:integer(req.body.budget);
    if(!['auto','task','chat'].includes(req.body.mode||'auto'))throw new LoopError('INVALID_MODE');
    const requestId=req.body.requestId||uid();if(typeof requestId!=='string'||!/^[\w-]{8,128}$/.test(requestId))throw new LoopError('INVALID_REQUEST_ID','发送标识需要 8–128 个字母、数字、下划线或短横线');
    const presetId=String(req.body.presetId||'');
    const payload={content,mode:req.body.mode||'auto',budget,workspace:s.workspace,...(presetId?{presetId}:{})};
    const previous=store.submission(s.id,requestId,payload);
    if(previous)return res.status(200).json({run:previous,messageId:`${previous.id}:user`,replayed:true});
    if(presetId){
      const preset=settings.presets.find(p=>p.id===presetId);if(!preset)throw new LoopError('PRESET_NOT_FOUND','所选岗位预设不存在，请在设置中保存后再选用');
      settings.roles=structuredClone(preset.roles);settings.models.executor.concurrency=preset.executor;settings.models.auxiliary.concurrency=preset.auxiliary;settings.activePreset=presetId;
    }
    const active=store.runs().find(r=>ACTIVE.has(r.status)&&(inside(r.workspace,s.workspace)||inside(s.workspace,r.workspace)));
    if(active)throw new LoopError('WORKSPACE_BUSY','该工作区已有任务运行；请先完成或暂停它，或使用独立工作区。');
    const {run:r}=store.acceptSubmission(s.id,requestId,payload,settings);
    // Execution belongs to the durable host, never the HTTP connection lifetime.
    host.launch(r.id).catch(error=>{store.patchRun(r.id,{status:'blocked',error:{code:error.code||'START_FAILED',message:scrub(error.message)}});store.addMessage(s.id,'assistant',`任务未启动：${scrub(error.message)}`,r.id,`${r.id}:start-error`);});
    res.status(202).json({run:store.run(r.id),messageId:`${r.id}:user`});
  });
  app.get('/api/runs/:id',(req,res)=>res.json(details(req.params.id)));
  app.get('/api/runs/:id/events',(req,res)=>{run(req.params.id);const after=integer(req.query.after||0,0),limit=Math.min(integer(req.query.limit||2000),10000),events=store.events(after,limit+1,req.params.id);const hasMore=events.length>limit;if(hasMore)events.pop();res.json({events,nextCursor:events.at(-1)?.seq||after,hasMore});});
  app.get('/api/runs/:id/export',(req,res)=>{const data=details(req.params.id,{full:true}),events=[];let cursor=0;while(true){const page=store.events(cursor,5000,req.params.id);events.push(...page);if(page.length<5000)break;cursor=page.at(-1).seq;}res.attachment(`pi-loop-${req.params.id}.json`).json({...data,events,exportedAt:now()});});
  app.post('/api/runs/:id/cancel',(req,res)=>{run(req.params.id);host.cancel(req.params.id);res.json(details(req.params.id));});
  app.post('/api/runs/:id/pause',(req,res)=>{run(req.params.id);host.pause(req.params.id);res.json(details(req.params.id));});
  app.patch('/api/runs/:id/budget',(req,res)=>{run(req.params.id);store.patchRun(req.params.id,{budget:integer(req.body.budget)});res.json(details(req.params.id));});
  app.post('/api/runs/:id/resume',async(req,res)=>{
    const r=run(req.params.id);if(!['paused','blocked'].includes(r.status))throw new LoopError('NOT_PAUSED','该任务不处于可恢复状态');
    if(r.spent>=r.budget)throw new LoopError('BUDGET_PAUSED','请先把任务预算提高到已结算用量以上');
    if(store.hasUnknownEffects(r.id))throw new LoopError('EFFECT_UNKNOWN','请先检查并明确处理未知原生命令结果；恢复按钮不会盲目重放。');
    if(store.runs().some(other=>other.id!==r.id&&ACTIVE.has(other.status)&&(inside(other.workspace,r.workspace)||inside(r.workspace,other.workspace))))throw new LoopError('WORKSPACE_BUSY','同一工作区或其父子目录已有运行任务');
    await host.launch(r.id,{resume:true});res.json(details(r.id));
  });
  app.post('/api/runs/:id/effects/acknowledge',(req,res)=>{
    run(req.params.id);if(req.body.acknowledge!=='我已检查未知命令结果')throw new LoopError('ACK_REQUIRED','必须明确检查未知命令回执后才能处理');
    for(const e of store.effects(req.params.id).filter(e=>['running','unknown'].includes(e.status)))store.putEffect({...e,status:'unknown_acknowledged',ended:now(),resolution:'用户检查结果后明确允许从图节点重试；不表示此前命令成功。'});
    res.json(details(req.params.id));
  });
  app.get('/api/browse',(req,res)=>{
    const s=loadSettings();if(!req.query.path)return res.json({roots:s.roots,defaultWorkspace:s.defaultWorkspace});
    let candidate=String(req.query.path);for(const r of s.roots)if(candidate===r.alias||candidate.startsWith(r.alias+'/'))candidate=path.join(r.path,candidate.slice(r.alias.length));
    const dir=path.resolve(candidate);if(!s.roots.some(r=>inside(r.path,dir)))throw new LoopError('WORKSPACE_NOT_CONFIGURED','该路径未在根目录中配置');
    const entries=fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.isSymbolicLink()&&!['.git','.local','.runtime','.python','node_modules'].includes(e.name)).slice(0,500).map(e=>({name:e.name,path:path.join(dir,e.name)}));
    res.json({path:dir,parent:path.dirname(dir),entries});
  });
  app.get('/api/runs/:id/artifact',(req,res)=>{
    run(req.params.id);const relative=portablePath(String(req.query.path||'')),root=path.join(LOCAL,'runs',req.params.id),full=path.join(root,relative);
    if(!relative||!inside(root,full)||relative.split('/').some(p=>p==='.git'||/credential|auth\.json|\.env/i.test(p)))throw new LoopError('INVALID_ARTIFACT');
    const stat=fs.statSync(full);if(!stat.isFile()||stat.size>2*1048576)throw new LoopError('ARTIFACT_LIMIT','请在本地工作目录查看超过 2 MiB 的产物');
    res.json({path:relative,bytes:stat.size,text:scrub(fs.readFileSync(full,'utf8'))});
  });
  app.post('/api/runs/:id/open-workspace',(req,res)=>{const r=run(req.params.id);const child=spawn('explorer.exe',[r.workspace],{windowsHide:true,stdio:'ignore',detached:true});child.on('error',()=>{});child.unref();res.json({path:r.workspace});});
  app.get('/api/events',(req,res)=>{
    res.status(200).set({'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive'});res.flushHeaders();streams.add(res);
    let cursor=Number(req.get('last-event-id')||req.query.after||0);if(!Number.isSafeInteger(cursor)||cursor<0)cursor=0;
    const send=e=>{if(e.seq<=cursor||res.destroyed)return;cursor=e.seq;res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);};
    // A large backlog is explicitly replaced by a materialized-state refresh.
    // The complete replay remains available through the paginated event API.
    const latest=store.cursor(),backlog=store.events(cursor,5001);
    if(cursor>latest||backlog.length>5000){cursor=latest;res.write(`id: ${cursor}\nevent: resync\ndata: ${JSON.stringify({cursor,reason:'REFRESH_MATERIALIZED_STATE'})}\n\n`);}
    else for(const e of backlog)send(e);
    store.listeners.add(send);
    res.write(`event: ready\ndata: ${JSON.stringify({bootId,cursor})}\n\n`);
    const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),15000);
    req.on('close',()=>{clearInterval(heartbeat);store.listeners.delete(send);streams.delete(res);});
  });
  app.post('/api/shutdown',(_req,res)=>{res.json({ok:true});setTimeout(()=>close(),100);});
  app.use('/api',(_req,res)=>res.status(404).json({error:{code:'NOT_FOUND',message:'接口不存在'}}));
  app.use(express.static(path.join(APP_ROOT,'dist'),{etag:true}));
  app.get('/{*path}',(_req,res)=>res.sendFile(path.join(APP_ROOT,'dist','index.html')));
  app.use((error,_req,res,_next)=>{const code=error.code||error.name||'SERVER_ERROR',status=code==='NOT_FOUND'?404:code==='ENOENT'?404:['WORKSPACE_BUSY','IDEMPOTENCY_CONFLICT'].includes(code)?409:400;res.status(status).json({error:{code,message:scrub(error.issues?error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('\n'):error.message||String(error))}});});
  await new Promise((resolve,reject)=>{server=app.listen(port??settings.port,'127.0.0.1',resolve);server.once('error',reject);});
  const address=`http://127.0.0.1:${server.address().port}`;
  if(recordHost)writeJSON(path.join(LOCAL,'host.json'),{address,bootId,root:APP_ROOT,pid:process.pid,startedAt:now()});
  console.log(JSON.stringify({app:'pi-loop-studio',address,bootId,node:process.version,platform:process.platform,startedAt:now()}));
  if(recover)await host.recover();
  async function close(){if(closing)return;closing=true;await Promise.allSettled([...host.controllers.values()].filter(c=>!c.finished).map(c=>c.suspend()));for(const s of streams)s.end();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
  return {app,server,store,host,address,bootId,close};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  startServer({port:process.argv.includes('--port')?Number(process.argv[process.argv.indexOf('--port')+1]):undefined}).then(h=>{process.once('SIGINT',()=>h.close());process.once('SIGTERM',()=>h.close());}).catch(e=>{console.error(scrub(e.message));process.exitCode=1;});
}
