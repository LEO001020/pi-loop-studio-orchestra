import {useState,useEffect,useRef,useCallback,useMemo} from 'react';
import {AssistantRuntimeProvider,useExternalStoreRuntime,ThreadPrimitive,ComposerPrimitive,MessagePrimitive,ActionBarPrimitive,type TextMessagePartProps} from '@assistant-ui/react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {Plus,Search,Settings as SettingsIcon,FolderOpen,ChevronDown,ArrowUp,Square,Copy,PanelRightClose,PanelRightOpen,GitBranch,Users,FileDiff,ScrollText,Check,AlertCircle,ArrowRight,Terminal,RefreshCw,Download,Play,Archive,Activity,Sparkles,BookOpen,Code2,ShieldCheck,ChevronRight,Menu,WifiOff,X} from 'lucide-react';
import {api,format,stageLabel,type Session,type Message,type Run,type RunDetails,type RecordData} from './api';
import {Settings,WorkspacePicker,Modal,Field} from './Settings';
import {WorkflowGraph} from './Graph';
import './task-setup.css';

function MarkdownText({text}:{text:string}){return <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} components={{a:props=><a {...props} target="_blank" rel="noopener noreferrer"/>,pre:props=><pre {...props}/>}}>{text}</Markdown></div>;}
const TextPart=({text}:TextMessagePartProps)=><MarkdownText text={text}/>;
function AssistantMessage(){return <MessagePrimitive.Root className="message assistant-message"><div className="avatar pi-avatar">π</div><div className="message-body"><div className="message-author">Pi Loop <span>本地工作室</span></div><MessagePrimitive.Content components={{Text:TextPart}}/><ActionBarPrimitive.Root className="message-actions"><ActionBarPrimitive.Copy className="icon-button" aria-label="复制回复"><Copy size={15}/></ActionBarPrimitive.Copy></ActionBarPrimitive.Root></div></MessagePrimitive.Root>;}
function UserMessage(){return <MessagePrimitive.Root className="message user-message"><div className="message-body"><div className="message-author">你</div><MessagePrimitive.Content components={{Text:TextPart}}/></div></MessagePrimitive.Root>;}
const starterCards=[{icon:Code2,title:'构建与实现',text:'把想法变成可运行的工程',prompt:'请先侦查当前工作区，给出可验证的任务拆分，然后并行实现：'}, {icon:ShieldCheck,title:'检查与修复',text:'让错误在整合前被发现',prompt:'请独立检查当前项目的实现与测试，定位真实缺陷并修复，保留执行和审核回执。'}, {icon:BookOpen,title:'研究与比较',text:'从原始资料出发作出判断',prompt:'请基于原始论文、官方文档和实际源码，研究并比较：'}];

function Conversation({messages,running,connected,initializing,onSend,onCancel,mode,setMode,workspace,stage,live,onError,settings,budget,setBudget,preset,setPreset}:{messages:Message[];running:boolean;connected:boolean;initializing:boolean;onSend:(text:string)=>Promise<void>;onCancel:()=>Promise<void>;mode:string;setMode:(s:string)=>void;workspace:string;stage:string;live:string;onError:(s:string)=>void;settings:RecordData|null;budget:string;setBudget:(s:string)=>void;preset:string;setPreset:(s:string)=>void}){
  const [sending,setSending]=useState(false);
  const runtime=useExternalStoreRuntime<Message>({messages,isRunning:running,isSendDisabled:!connected||sending||initializing,
    convertMessage:m=>({id:m.id,role:m.role,content:[{type:'text',text:m.content}],createdAt:new Date(m.created)}),
    onNew:async message=>{const text=message.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');setSending(true);try{await onSend(text);}catch(e){onError((e as Error).message);throw e;}finally{setSending(false);}},
    onCancel:async()=>{try{await onCancel();}catch(e){onError((e as Error).message);}}
  });
  return <AssistantRuntimeProvider runtime={runtime}>
    <ThreadPrimitive.Root className="thread">
      <ThreadPrimitive.Viewport className="thread-viewport"><div className="thread-inner">
        {!messages.length&&<div className="welcome"><div className="welcome-mark">π<span/></div><div className="eyebrow">PI LOOP STUDIO · 原生 WINDOWS</div><h1>让推理并行，<br/><em>让成果可信。</em></h1><p>你定义目标。主席位侦查与派发，执行者独立工作，<br className="desktop-break"/>审核通过的产物才会进入你的项目。</p><div className="starter-grid">{starterCards.map(({icon:Icon,title,text,prompt})=><button className="starter-card" key={title} disabled={initializing} onClick={()=>runtime.thread.composer.setText(prompt)}><Icon size={22}/><strong>{title}</strong><span>{text}</span><ArrowRight size={17}/></button>)}</div><div className="welcome-foot"><span className="dot mint"/> 会话保存在本机 <span>·</span> 没有预算冻结 <span>·</span> 审核后发布</div></div>}
        <ThreadPrimitive.Messages components={{UserMessage,AssistantMessage}}/>
        {running&&<div className="live-card"><div><Activity size={16} className="pulse"/><strong>{stageLabel[stage]||stage}</strong><span>执行在本地服务中持续，不依赖标签页</span></div>{live&&<pre>{live.slice(-1800)}</pre>}</div>}
      </div></ThreadPrimitive.Viewport>
      <div className="composer-wrap">
        <div className="task-setup"><label>下次任务预算<input aria-label="下次任务预算" type="number" min={1} value={budget} placeholder={String(settings?.budgetTokens||'')} onChange={e=>setBudget(e.target.value)}/><small>token</small></label><label>岗位预设<select aria-label="下次任务岗位预设" value={preset} onChange={e=>setPreset(e.target.value)}><option value="">当前岗位配置</option>{settings?.presets.map((p:RecordData)=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label></div>
        <ComposerPrimitive.Root className="composer"><ComposerPrimitive.Input className="composer-input" aria-label="消息输入" placeholder={initializing?'正在载入会话…':'描述目标、约束与验收标准…'} disabled={initializing} rows={3} autoFocus/>
          <div className="composer-toolbar"><div className="composer-options"><select aria-label="工作模式" value={mode} onChange={e=>setMode(e.target.value)}><option value="auto">自动识别</option><option value="task">强制任务流程</option><option value="chat">纯对话</option></select><span title={workspace}><FolderOpen size={14}/>{workspace.split(/[\\/]/).filter(Boolean).pop()||'工作区'}</span></div>{running?<ComposerPrimitive.Cancel className="send-button stop" aria-label="停止任务"><Square size={16}/></ComposerPrimitive.Cancel>:<ComposerPrimitive.Send className="send-button" aria-label="发送消息"><ArrowUp size={20}/></ComposerPrimitive.Send>}</div>
        </ComposerPrimitive.Root><div className="composer-hint">{connected?'Enter 发送 · Shift + Enter 换行':'连接暂时中断，草稿仍可编辑；服务恢复后会自动重连。'}<span>Pi 引擎 · assistant-ui</span></div>
      </div>
    </ThreadPrimitive.Root>
  </AssistantRuntimeProvider>;
}

function Workbench({details,onAction,onError}:{details:RunDetails|null;onAction:(action:string,value?:number)=>Promise<void>;onError:(s:string)=>void}){
  const [tab,setTab]=useState('graph'),[selectedJob,setSelectedJob]=useState(''),[budget,setBudget]=useState(''),[events,setEvents]=useState<RecordData[]>([]),[replay,setReplay]=useState(-1);
  const run=details?.run,jobs=details?.jobs||[],selected=jobs.find(j=>j.id===selectedJob)||jobs[0];
  useEffect(()=>{setBudget(String(run?.budget||''));},[run?.id,run?.budget]);
  useEffect(()=>{setSelectedJob('');setReplay(-1);setEvents([]);},[run?.id]);
  async function act(action:string,value?:number){try{await onAction(action,value);}catch(e){onError((e as Error).message);}}
  async function loadReplay(){const all:RecordData[]=[];let after=0;try{while(true){const result=await api(`/runs/${run!.id}/events?limit=5000&after=${after}`);all.push(...result.events);if(!result.hasMore)break;after=result.nextCursor;}setEvents(all);setReplay(0);}catch(e){onError((e as Error).message);}}
  const graphEvents=events.filter(e=>e.type==='run.updated'&&e.data?.stage);
  return <aside className="workbench"><div className="workbench-head"><div><span className="eyebrow">任务工作台</span><h3>{run?stageLabel[run.stage]||run.stage:'等待一个好问题'}</h3></div><span className={`status-chip ${run?.status||''}`}><i className="dot"/>{run?stageLabel[run.status]||run.status:'就绪'}</span></div>{run&&<><div className="budget-card"><div className="budget-heading"><span>实际结算</span><strong>{format(run.spent)} <small>/ {format(run.budget)} token</small></strong></div><div className="budget-track"><i style={{width:`${Math.min(100,run.spent/run.budget*100)}%`}}/></div><div className="budget-sub"><span>{details?.metrics.totalCalls||0} 次调用 · {details?.metrics.active||0} 正在返回</span><button className="text-button" onClick={()=>setTab('receipts')}>查看账单 <ChevronRight size={12}/></button></div>{run.spent>run.budget&&<div className="budget-warning">并发在途结算超出 {format(run.spent-run.budget)} token；未冻结或撤销已完成请求。</div>}{Boolean(details?.metrics.unknown)&&<div className="budget-warning">{details?.metrics.unknown} 次请求用量未知，未按零费用处理。</div>}<div className="budget-edit"><input aria-label="本任务预算" type="number" value={budget} onChange={e=>setBudget(e.target.value)}/><button onClick={()=>act('budget',Number(budget))}>调整预算</button>{['paused','blocked'].includes(run.status)&&<button className="primary" onClick={()=>act('resume')}><Play size={14}/>继续</button>}{run.status==='running'&&<button aria-label="取消当前运行" onClick={()=>act('cancel')}><Square size={13}/></button>}</div></div>{run.error&&<div className="run-error" role="alert"><AlertCircle size={17}/><div><strong>{run.error.code}</strong><p>{run.error.message}</p></div></div>}</>}
    {run?.status==='running'&&<div className="receipts-actions"><button disabled={Boolean(run.pauseRequested)} onClick={()=>act('pause')}>{run.pauseRequested?'正在结算在途请求…':'暂停派发，保留进度'}</button></div>}
    {run?.status==='blocked'&&details?.effects.some(e=>['running','unknown'].includes(e.status))&&<div className="run-error"><div><strong>有结果未知的原生命令</strong><p>先在回执页查看命令、标准输出与错误，再明确处理。继续不表示此前命令成功。</p><button onClick={()=>setTab('receipts')}>查看回执</button><button onClick={()=>act('acknowledge')}>我已检查未知命令结果，允许重试</button></div></div>}
    {run&&<div className="receipts-actions"><button className="text-button" onClick={loadReplay}>加载完整图事件回放</button></div>}
    <div className="workbench-tabs">{[['graph','流程图',GitBranch],['jobs','岗位',Users],['changes','变更',FileDiff],['receipts','回执',ScrollText]].map(([id,label,Icon])=>{const I=Icon as typeof GitBranch;return <button key={String(id)} className={tab===id?'selected':''} onClick={()=>setTab(String(id))}><I size={16}/>{String(label)}{id==='jobs'&&jobs.length>0&&<small>{jobs.length}</small>}</button>;})}</div>
    <div className="workbench-content">{tab==='graph'&&<><WorkflowGraph details={details} replayStage={replay>=0?graphEvents[replay]?.data.stage:undefined}/>{run&&<div className="replay"><button className="text-button" onClick={async()=>{try{const r=await api(`/runs/${run.id}/events?limit=10000`);setEvents(r.events);setReplay(0);}catch(e){onError((e as Error).message);}}}><RefreshCw size={13}/>载入图回放</button>{graphEvents.length>0&&<><input aria-label="回放位置" type="range" min={0} max={graphEvents.length-1} value={Math.max(0,replay)} onChange={e=>setReplay(Number(e.target.value))}/><small>{graphEvents[replay]?.at?.slice(11,19)} · {stageLabel[graphEvents[replay]?.data.stage]||'选择节点'}</small><button className="text-button" onClick={()=>setReplay(-1)}>返回实时</button></>}</div>}</>}
    {tab==='jobs'&&<>{!jobs.length?<div className="empty-panel"><Users size={32}/><h4>岗位尚未派发</h4><p>侦查和证据审核完成后，主席位会生成依赖与所有权明确的岗位任务。</p></div>:<><div className="job-list">{jobs.map(j=><button className={`job-row ${selected?.id===j.id?'selected':''}`} key={j.id} onClick={()=>setSelectedJob(j.id)}><span className={`job-status ${j.integratedCommit?'passed':j.status}`}>{j.integratedCommit?<Check size={14}/>:<Activity size={14}/>}</span><span><strong>{j.title}</strong><small>{j.role} · {stageLabel[j.status]||j.status} · 第 {j.attempt} 次</small></span><ChevronRight size={15}/></button>)}</div>{selected&&<div className="job-detail"><h4>{selected.title}</h4><p>{selected.instructions}</p><div className="detail-label">文件所有权</div><div className="tags">{selected.ownedPaths.map((p:string)=><code key={p}>{p}</code>)}</div><div className="detail-label">独立审核</div>{selected.audit?<div className={`audit-result ${selected.audit.pass?'passed':'failed'}`}><strong>{selected.audit.pass?'审核通过':'未通过审核'}</strong><p>{selected.audit.reason}</p>{selected.audit.findings?.map((f:string,i:number)=><p key={i}>{f}</p>)}</div>:<p className="muted">尚未产生独立审核回执。</p>}{selected.work?.value&&<><div className="detail-label">执行者报告（不等于验收）</div><MarkdownText text={selected.work.value.summary}/></>}</div>}</>}</>}
    {tab==='changes'&&<>{!jobs.some(j=>j.proposal)?<div className="empty-panel"><FileDiff size={32}/><h4>还没有文件变更</h4><p>所有提案保存在独立工作树，只有审核通过后才进入候选。</p></div>:jobs.filter(j=>j.proposal).map(j=><details className="diff-card" key={j.id}><summary><span className={`dot ${j.audit?.pass?'mint':'amber'}`}/><strong>{j.title}</strong><small>{j.proposal.changes.length} 个文件 · {j.integratedCommit?'已整合':'未整合'}</small></summary><div className="diff-files">{j.proposal.changes.map((c:RecordData)=><div key={c.path}><span className={c.kind}>{c.kind==='added'?'+':c.kind==='deleted'?'−':'~'}</span><code>{c.path}</code></div>)}</div><pre className="diff-text">{j.proposal.diff||'无文本差异；详情见回执。'}</pre>{j.proposal.diffTruncated&&<p className="muted">差异预览已截断，完整文件保存在本地工作树。</p>}</details>)}</>}
    {tab==='receipts'&&<>{!run?<div className="empty-panel"><ScrollText size={32}/><h4>让结果有据可查</h4><p>实际用量、命令、标准输出、错误输出与退出码都会保存在这里。</p></div>:<><div className="receipts-actions"><a className="button" href={`/api/runs/${run.id}/export`} download><Download size={15}/>导出完整回执</a><button onClick={()=>act('open-workspace')}><FolderOpen size={15}/>打开工作区</button></div><div className="metrics-grid">{Object.entries(details?.metrics.roles||{}).map(([role,m])=><div key={role}><span>{({principal:'主席',executor:'执行',auxiliary:'辅助'} as Record<string,string>)[role]||role}</span><strong>{format((m as RecordData).tokens)}</strong><small>{(m as RecordData).calls} 次调用</small></div>)}</div><h4 className="detail-label">模型调用 · 无请求预留</h4><div className="call-list">{details?.calls.map(c=><div key={c.id}><span className={`dot ${c.status==='completed'?'mint':c.status==='running'?'blue':'amber'}`}/><span><strong>{c.role} · {c.node}</strong><small>{c.started?.slice(11,19)} → {c.ended?.slice(11,19)||'在途'}{c.details?.error&&' · '+c.details.error}</small></span><code>{c.unknown?'未知':format(c.tokens||0)}</code></div>)}</div><h4 className="detail-label">原生命令与 Python</h4>{!details?.effects.length&&<p className="muted">此任务尚无原生命令。</p>}{details?.effects.map(e=><details key={e.id} className="command-card"><summary><Terminal size={15}/><code>{e.command?.slice(0,90)}</code><span className={`exit-code ${e.exitCode===0?'passed':'failed'}`}>{e.status==='running'?'结果待定':`exit ${e.exitCode??'?'}`}</span></summary><div className="command-meta">{e.cwd}<br/>{e.started} · {e.durationMs??'?'} ms · {e.encoding||'UTF-8'}</div><div className="detail-label">command</div><pre>{e.command}</pre><div className="detail-label">stdout</div><pre>{e.stdout||e.result?.stdout||'（空）'}</pre><div className="detail-label">stderr</div><pre>{e.stderr||e.error||'（空）'}</pre>{e.status==='running'&&run.status==='blocked'&&<button onClick={()=>act('acknowledge')}>我已检查未知命令结果，允许从节点重试</button>}</details>)}</>}</>}
    </div>
  </aside>;
}

export function App(){
  const [settings,setSettings]=useState<RecordData|null>(null),[sessions,setSessions]=useState<Session[]>([]),[selected,setSelected]=useState(localStorage.getItem('pi-loop-session')||''),[current,setCurrent]=useState<Session|null>(null),[messages,setMessages]=useState<Message[]>([]),[runs,setRuns]=useState<Run[]>([]),[selectedRun,setSelectedRun]=useState(''),[details,setDetails]=useState<RunDetails|null>(null),[error,setError]=useState(''),[connected,setConnected]=useState(false),[settingsOpen,setSettingsOpen]=useState(false),[workspaceOpen,setWorkspaceOpen]=useState(false),[mode,setMode]=useState('auto'),[showWorkbench,setShowWorkbench]=useState(true),[search,setSearch]=useState(''),[live,setLive]=useState(''),[sidebarOpen,setSidebarOpen]=useState(false),[rename,setRename]=useState(false),[title,setTitle]=useState('');
  const selectedRef=useRef(selected),runRef=useRef(selectedRun),cursor=useRef(0),refreshing=useRef(false),again=useRef(false);
  const [creating,setCreating]=useState(false),[loadingSession,setLoadingSession]=useState(Boolean(selected)),[taskBudget,setTaskBudget]=useState(''),[taskPreset,setTaskPreset]=useState('');
  useEffect(()=>{
    const narrow=matchMedia('(max-width:1060px)');
    const adapt=()=>{if(narrow.matches){setShowWorkbench(false);setSidebarOpen(false);}};
    adapt();narrow.addEventListener('change',adapt);return()=>narrow.removeEventListener('change',adapt);
  },[]);
  selectedRef.current=selected;runRef.current=selectedRun;
  const report=useCallback((message:string)=>setError(message),[]);
  useEffect(()=>{if(!settings)return;const apply=()=>{const theme=settings.theme==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):settings.theme;document.documentElement.dataset.theme=theme;};apply();const media=matchMedia('(prefers-color-scheme: dark)');media.addEventListener('change',apply);return()=>media.removeEventListener('change',apply);},[settings?.theme]);
  const refresh=useCallback(async()=>{
    if(refreshing.current){again.current=true;return;}refreshing.current=true;
    try{
      const list=await api<{sessions:Session[];cursor:number}>('/sessions');setSessions(list.sessions);
      const id=selectedRef.current;if(id){const data=await api<{session:Session;messages:Message[];runs:Run[];cursor:number}>(`/sessions/${id}`);if(selectedRef.current!==id)return;setCurrent(data.session);setMessages(data.messages);setRuns(data.runs);setLoadingSession(false);const rid=data.runs.some(r=>r.id===runRef.current)?runRef.current:data.runs[0]?.id||'';setSelectedRun(rid);if(rid){const d=await api<RunDetails>(`/runs/${rid}`);if(selectedRef.current===id)setDetails(d);}else setDetails(null);}
    }catch(e){setLoadingSession(false);if((e as {code?:string}).code==='NOT_FOUND'){selectedRef.current='';setSelected('');setCurrent(null);setMessages([]);setRuns([]);setDetails(null);setError('之前选择的会话在此数据库中不存在。已返回新对话，其他会话仍可从左侧打开。');}else setError((e as Error).message);}finally{refreshing.current=false;if(again.current){again.current=false;setTimeout(refresh,100);}}
  },[]);
  useEffect(()=>{
    let disposed=false;api('/settings').then(s=>{if(!disposed)setSettings(s);}).catch(e=>report(e.message));
    refresh();let timer:ReturnType<typeof setTimeout>|undefined;
    const source=new EventSource(`/api/events?after=${cursor.current}`);
    source.addEventListener('ready',event=>{setConnected(true);try{cursor.current=JSON.parse((event as MessageEvent).data).cursor;}catch{}api('/settings').then(setSettings).catch(e=>report(e.message));refresh();});source.onopen=()=>setConnected(true);
    source.addEventListener('resync',()=>refresh());
    source.onerror=()=>setConnected(false);
    source.onmessage=e=>{let event:RecordData;try{event=JSON.parse(e.data);}catch{return;}cursor.current=event.seq;if(event.type==='agent.text'){if(event.runId===runRef.current)setLive(event.data.text||event.data.delta||'');return;}if(!timer)timer=setTimeout(()=>{timer=undefined;refresh();},750);};
    const reconnect=()=>refresh();window.addEventListener('focus',reconnect);
    return()=>{disposed=true;source.close();if(timer)clearTimeout(timer);window.removeEventListener('focus',reconnect);};
  },[refresh,report]);
  useEffect(()=>{selectedRef.current=selected;localStorage.setItem('pi-loop-session',selected);setSelectedRun('');runRef.current='';setDetails(null);setLive('');if(selected)refresh();else{setCurrent(null);setMessages([]);setRuns([]);}},[selected,refresh]);
  useEffect(()=>{if(selectedRun)api<RunDetails>(`/runs/${selectedRun}`).then(d=>{if(runRef.current===d.run.id)setDetails(d);}).catch(e=>report(e.message));setLive('');},[selectedRun]);
  const active=runs.find(r=>['queued','running'].includes(r.status)),workspace=current?.workspace||settings?.defaultWorkspace||'';
  async function create(workspaceOverride?:string){
    setCreating(true);
    try{const session=await api<Session>('/sessions','POST',{workspace:workspaceOverride||workspace});selectedRef.current=session.id;setSelected(session.id);setCurrent(session);setMessages([]);setRuns([]);setLoadingSession(false);setSidebarOpen(false);return session;}
    finally{setCreating(false);}
  }
  function selectSession(id:string){setLoadingSession(true);selectedRef.current=id;setSelected(id);setCurrent(null);setMessages([]);setRuns([]);setSidebarOpen(false);}
  async function send(text:string){
    setError('');let session=current;
    if(selectedRef.current&&session?.id!==selectedRef.current)session=(await api(`/sessions/${selectedRef.current}`)).session;
    if(!session)session=await create();
    const budget=Number(taskBudget||settings?.budgetTokens);if(!Number.isSafeInteger(budget)||budget<1)throw new Error('任务预算必须是正整数');
    const identity=JSON.stringify({sessionId:session.id,text,mode,budget,presetId:taskPreset});
    let pending:RecordData|null=null;try{pending=JSON.parse(localStorage.getItem('pi-loop-pending-send')||'null');}catch{}
    const requestId=pending?.identity===identity?pending.requestId:crypto.randomUUID();
    localStorage.setItem('pi-loop-pending-send',JSON.stringify({identity,requestId}));
    const response=await api(`/sessions/${session.id}/messages`,'POST',{content:text,mode,budget,presetId:taskPreset,requestId});
    localStorage.removeItem('pi-loop-pending-send');runRef.current=response.run.id;setSelectedRun(response.run.id);await refresh();
  }
  async function action(action:string,value?:number){if(!details)return;const id=details.run.id;if(action==='budget')await api(`/runs/${id}/budget`,'PATCH',{budget:value});else if(action==='acknowledge')await api(`/runs/${id}/effects/acknowledge`,'POST',{acknowledge:'我已检查未知命令结果'});else await api(`/runs/${id}/${action}`,'POST',{});await refresh();}
  const [includeArchived,setIncludeArchived]=useState(false);
  const filtered=useMemo(()=>sessions.filter(s=>(includeArchived||!s.archived)&&`${s.title} ${s.workspace}`.toLowerCase().includes(search.toLowerCase())),[sessions,search,includeArchived]);
  return <div className={`app-shell ${showWorkbench?'':'no-workbench'} ${sidebarOpen?'mobile-sidebar-open':''}`}>
    <aside className="sidebar">
      <a className="brand" href="#" onClick={e=>e.preventDefault()}><span className="brand-icon">π</span><span>Pi Loop<strong>STUDIO</strong></span><span className="local-badge">LOCAL</span></a>
      <button className="new-thread" disabled={creating} onClick={()=>create().catch(e=>report(e.message))}><Plus size={18}/>{creating?'正在新建…':'新建对话'} <kbd>＋</kbd></button>
      <div className="session-search"><Search size={16}/><input aria-label="搜索会话" placeholder="搜索会话…" value={search} onChange={e=>setSearch(e.target.value)}/></div>
      <div className="sidebar-section-label">工作记录 <span>{filtered.length}</span></div>
      <label className="archive-toggle"><input type="checkbox" checked={includeArchived} onChange={e=>setIncludeArchived(e.target.checked)}/>显示归档会话</label>
      <nav className="session-list">{filtered.map(s=><button key={s.id} data-session-id={s.id} className={`session-item ${selected===s.id?'selected':''}`} onClick={()=>selectSession(s.id)}><span className="session-symbol"><GitBranch size={15}/></span><span><strong>{s.title}</strong><small>{s.archived?'已归档 · ':''}{s.updated?.slice(5,10)} · {s.workspace.split(/[\\/]/).filter(Boolean).pop()}</small></span>{selected===s.id&&<span className="selected-dot"/>}</button>)}{!filtered.length&&<div className="session-empty">新的想法，从一段对话开始。</div>}</nav>
      <div className="sidebar-footer"><div className="cluster-status"><span className={`dot ${connected?'mint':'amber'}`}/><strong>{connected?'本地引擎已连接':'正在重新连接'}</strong><small>Windows 原生 · Pi SDK</small></div><button className="settings-trigger" onClick={()=>setSettingsOpen(true)} disabled={!settings}><SettingsIcon size={18}/>设置与模型 <ChevronRight size={15}/></button><div className="sidebar-bottom"><span>v2 · candidate.3</span><button className="text-button" aria-label="刷新" onClick={()=>refresh()}><RefreshCw size={13}/></button></div></div>
    </aside>
    <main className="main-area">
      <header className="topbar"><button className="icon-button mobile-menu" aria-label="打开菜单" onClick={()=>setSidebarOpen(!sidebarOpen)}><Menu size={20}/></button><div className="thread-title"><button onClick={()=>{if(current){setTitle(current.title);setRename(true);}}}>{current?.title||'新的工作空间'}</button><button className="workspace-button" onClick={()=>setWorkspaceOpen(true)} title={workspace}><FolderOpen size={13}/><span>{workspace||'正在读取配置'}</span><ChevronDown size={13}/></button></div><div className="topbar-actions">{runs.length>0&&<select aria-label="选择任务回执" value={selectedRun} onChange={e=>{runRef.current=e.target.value;setSelectedRun(e.target.value);}}>{runs.map((r,i)=><option key={r.id} value={r.id}>任务 {runs.length-i} · {stageLabel[r.status]||r.status}</option>)}</select>}{current&&<button className="icon-button" title={current.archived?'恢复会话':'归档会话'} aria-label={current.archived?'恢复会话':'归档会话'} onClick={()=>api(`/sessions/${current.id}`,'PATCH',{archived:!current.archived}).then(()=>{if(!current.archived)setSelected('');refresh();}).catch(e=>report(e.message))}><Archive size={17}/></button>}<button className="icon-button" aria-label="切换任务工作台" onClick={()=>setShowWorkbench(!showWorkbench)}>{showWorkbench?<PanelRightClose size={19}/>:<PanelRightOpen size={19}/>}</button></div></header>
      <div className="seat-strip"><span><i className="dot mint"/><strong>{settings?.models.principal.model||'GLM-5.3'}</strong>主席 ×1</span><span><i className="dot blue"/><strong>Gemini Flash</strong>执行 ×{settings?.presets.find((p:RecordData)=>p.id===taskPreset)?.executor||settings?.models.executor.concurrency||12}</span><span><i className="dot amber"/><strong>GLM Flash</strong>辅助 ×{settings?.presets.find((p:RecordData)=>p.id===taskPreset)?.auxiliary||settings?.models.auxiliary.concurrency||4}</span></div>
      {!connected&&<div className="connection-banner"><WifiOff size={16}/>与本地服务的连接中断。会话仍保留，界面会自动重连；可重新运行启动器。</div>}
      {error&&<div className="app-error" role="alert"><AlertCircle size={18}/><span>{error}</span><button className="icon-button" aria-label="关闭错误提示" onClick={()=>setError('')}><X size={16}/></button></div>}
      <Conversation key={selected||'new'} messages={messages} running={Boolean(active)} connected={connected&&Boolean(settings)} initializing={creating||loadingSession}
        settings={settings} budget={taskBudget} setBudget={setTaskBudget} preset={taskPreset} setPreset={setTaskPreset}
        onSend={send} onCancel={async()=>{if(active){await api(`/runs/${active.id}/cancel`,'POST',{});await refresh();}}} mode={mode} setMode={setMode} workspace={workspace} stage={active?.stage||''} live={live} onError={report}/>
    </main>
    {showWorkbench&&<Workbench details={details} onAction={action} onError={report}/>}
    <button className="mobile-backdrop" aria-label="关闭侧栏" onClick={()=>setSidebarOpen(false)}/>
    {settingsOpen&&settings&&<Settings initial={settings} onSave={s=>{setSettings(s);if(taskPreset&&!s.presets.some((p:RecordData)=>p.id===taskPreset))setTaskPreset('');}} onClose={()=>setSettingsOpen(false)}/>}
    {workspaceOpen&&<WorkspacePicker value={workspace} onClose={()=>setWorkspaceOpen(false)} onSelect={async p=>{try{if(current){await api(`/sessions/${current.id}`,'PATCH',{workspace:p});await refresh();}else await create(p);setWorkspaceOpen(false);}catch(e){report((e as Error).message);}}}/>}
    {rename&&current&&<Modal title="重命名会话" onClose={()=>setRename(false)}><div className="modal-body"><Field label="名称"><input autoFocus value={title} onChange={e=>setTitle(e.target.value)}/></Field></div><div className="modal-foot"><button className="primary" onClick={()=>api(`/sessions/${current.id}`,'PATCH',{title}).then(()=>{setRename(false);refresh();}).catch(e=>report(e.message))}>保存</button></div></Modal>}
  </div>;
}
