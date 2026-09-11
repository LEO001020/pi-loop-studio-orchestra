import path from 'node:path';
import net from 'node:net';
import { Agent } from '@earendil-works/pi-agent-core';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { AssistantMessageEventStream, Type } from '@earendil-works/pi-ai';
import { Slots,LOCAL,ensureDir,uid,now,writeJSON,LoopError,checkAbort } from './util.mjs';
import { credentials,scrub } from './settings.mjs';
import { makeContextTransform } from './context.mjs';

const globalSlots={principal:new Slots(1),executor:new Slots(20),auxiliary:new Slots(8)};
const emptyUsage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
/** Socket availability is not model verification and spends no model tokens. */
export async function probeConnections(settings,{timeout=3000}={}){
  return Promise.all(Object.entries(settings.models).map(async([role,config])=>{
    const url=new URL(config.baseUrl),started=Date.now();
    return new Promise(resolve=>{
      const socket=net.createConnection({host:url.hostname,port:Number(url.port||(url.protocol==='https:'?443:80))});let settled=false;
      const finish=(ok,code)=>{if(settled)return;settled=true;socket.destroy();resolve({role,model:config.model,endpoint:config.baseUrl,ok,code,latencyMs:Date.now()-started,kind:'TCP_AVAILABILITY_ONLY',modelVerified:false});};
      socket.setTimeout(timeout,()=>finish(false,'CONNECT_TIMEOUT'));socket.once('connect',()=>finish(true,null));socket.once('error',error=>finish(false,error.code||'CONNECT_FAILED'));
    });
  }));
}
function failure(model,error){return {role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],stopReason:'error',errorMessage:scrub(`${error.code||'MODEL_ERROR'}: ${error.message||error}`),usage:emptyUsage,timestamp:Date.now()};}

export class PiRuntime {
  constructor(store,run){this.store=store;this.runId=run.id;this.settings=run.settings;this.pools={principal:new Slots(1),executor:new Slots(run.settings.models.executor.concurrency),auxiliary:new Slots(run.settings.models.auxiliary.concurrency)};this.agents=new Set();}
  async init(){
    this.models=await ModelRuntime.create({authPath:path.join(LOCAL,'pi-auth.json'),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
    const keys=credentials();
    for(const role of ['principal','executor','auxiliary']){
      const d=this.settings.models[role];
      if(!keys[role])continue;
      this.models.registerProvider(`loop-${role}`,{api:d.api,baseUrl:d.baseUrl,apiKey:keys[role],models:[{id:d.model,name:`${d.model} · ${role}`,reasoning:d.thinking!=='off',input:['text','image'],contextWindow:d.contextWindow,maxTokens:d.maxOutputTokens,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{supportsDeveloperRole:false,supportsStore:false,supportsUsageInStreaming:true,maxTokensField:'max_tokens'}}]});
    }
    return this;
  }
  stream(role,node,parentSignal,overrides={}){
    return (model,context,options={})=>{
      const out=new AssistantMessageEventStream();
      // Stream failures are protocol messages, as required by Pi's StreamFn contract.
      void (async()=>{
        let callId,releaseLocal,releaseGlobal,timer;const controller=new AbortController();
        const timedOut=()=>controller.signal.aborted&&!parentSignal?.aborted&&!options.signal?.aborted;
        const signals=[parentSignal,options.signal,controller.signal].filter(Boolean);const signal=AbortSignal.any(signals);
        try{
          releaseLocal=await this.pools[role].acquire(signal);checkAbort(signal);
          releaseGlobal=await globalSlots[role].acquire(signal);checkAbort(signal);
          callId=this.store.beginCall(this.runId,role,node);
          timer=setTimeout(()=>controller.abort(new Error('MODEL_TIMEOUT')),this.settings.models[role].requestTimeoutSeconds*1000);
          const inner=this.models.streamSimple(model,context,{...options,...overrides,signal,transport:'sse',maxTokens:overrides.maxTokens??this.settings.models[role].maxOutputTokens,
            onPayload:()=>{this.store.event('call.dispatched',{id:callId,role,node},this.runId);},
            onResponse:meta=>{this.store.event('call.response',{id:callId,role,node,status:meta?.status??meta?.response?.status??null},this.runId);}});
          let ended=false;
          for await(const event of inner){
            if(event.type==='done'||event.type==='error'){
              let message=event.type==='done'?event.message:event.error;
              if(timedOut())message={...message,stopReason:'error',errorMessage:'MODEL_TIMEOUT: 提供方请求超时；保留回执，可从图节点重试，不是用户取消。'};
              this.store.settleCall(callId,message);ended=true;
              // Accounting completes before the next Pi turn can start.
              out.push(timedOut()?{type:'error',reason:'error',error:message}:event);out.end(message);
            }else out.push(event);
          }
          if(!ended){let m=await inner.result();if(timedOut())m={...m,stopReason:'error',errorMessage:'MODEL_TIMEOUT: 提供方请求超时；可从图节点重试。'};this.store.settleCall(callId,m);out.push({type:m.stopReason==='error'?'error':'done',reason:m.stopReason,...(m.stopReason==='error'?{error:m}:{message:m})});out.end(m);}
        }catch(error){
          const cause=timedOut()?new LoopError('MODEL_TIMEOUT','提供方请求超时；不是用户取消，可从图节点重试。'):error;
          const m=failure(model,cause);if(callId)this.store.settleCall(callId,null,cause.message||String(cause));out.push({type:'error',reason:'error',error:m});out.end(m);
        }finally{clearTimeout(timer);releaseGlobal?.();releaseLocal?.();}
      })();
      return out;
    };
  }
  async run({role,node,system,prompt,tools=[],signal,thinking,maxTokens,submitted,onEvidence,evidenceTools=['read','ls','grep','find','powershell','python','fetch_url','web_search','read_source','read_archive']}){
    checkAbort(signal);const model=this.models.getModel(`loop-${role}`,this.settings.models[role].model);
    if(!model)throw new LoopError('MISSING_CREDENTIAL',`${role} 尚未配置 API 凭据；打开设置连接页即可修复`);
    const trace=path.join(ensureDir(path.join(LOCAL,'runs',this.runId,'traces')),`${node.replace(/[^\w-]/g,'_')}-${uid()}.json`);
    let turns=0,lastDelta=0,live='',evidenceCalls=0;const started=now();
    let agent;
    const historyTool={name:'read_context',label:'读取未压缩的原始轨迹',description:'按消息序号读取本岗位完整历史。压缩仅改变传给模型的视图，原始消息不会丢失。返回 nextOffset 时可继续读取同一条消息。',parameters:Type.Object({index:Type.Integer({minimum:0}),offset:Type.Optional(Type.Integer({minimum:0})),limit:Type.Optional(Type.Integer({minimum:256,maximum:24000}))}),execute:async(_id,{index,offset=0,limit=12000})=>{
      const messages=agent.state.messages;if(index>=messages.length)throw new LoopError('NOT_FOUND',`历史共有 ${messages.length} 条消息，序号从 0 开始。`);
      const raw=scrub(messages[index]),end=Math.min(raw.length,offset+limit);
      return {content:[{type:'text',text:JSON.stringify({index,count:messages.length,offset,totalCharacters:raw.length,text:raw.slice(offset,end),nextOffset:end<raw.length?end:null})}],details:{kind:'context',index}};
    }};
    const transformContext=makeContextTransform({model,settings:this.settings.context,streamFn:this.stream(role,`${node}-compaction`,signal,{maxTokens:this.settings.context.summaryMaxTokens}),onCompact:record=>{
      const file=trace.replace(/\.json$/,`-context-${record.firstKept}.json`);writeJSON(file,JSON.parse(scrub(record)));this.store.event('context.compacted',{node,role,firstKept:record.firstKept,estimatedBefore:record.estimatedBefore,estimatedAfter:record.estimatedAfter,trace:path.relative(LOCAL,file)},this.runId);
    }});
    agent=new Agent({initialState:{model,systemPrompt:system,tools:[...tools,historyTool],thinkingLevel:thinking??this.settings.models[role].thinking},transformContext,streamFn:this.stream(role,node,signal,{...(maxTokens?{maxTokens}: {})}),transport:'sse',toolExecution:'sequential',sessionId:`${this.runId}:${node}`,
      beforeToolCall:async()=>this.store.hasUnresolvedEffects(this.runId)?{block:true,terminate:true,reason:'EFFECT_UNKNOWN: 前一个原生操作结果未知，后续工具与提交均未执行。'}:undefined,
      shouldStopAfterTurn:()=>this.store.hasUnresolvedEffects(this.runId)||Boolean(submitted?.())||++turns>=this.settings.maxAgentTurns});
    this.agents.add(agent);const abort=()=>agent.abort();signal?.addEventListener('abort',abort,{once:true});
    agent.subscribe(event=>{
      if(event.type==='message_end'){
        writeJSON(trace,JSON.parse(scrub({role,node,started,messages:agent.state.messages})));
      }
      if(event.type==='tool_execution_end'){
        if(!event.isError&&!event.result?.isError&&evidenceTools.includes(event.toolName)){evidenceCalls++;onEvidence?.(evidenceCalls);}
        this.store.event('tool.completed',{node,role,tool:event.toolName,isError:event.isError||event.result?.isError||false,preview:scrub(event.result?.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')||'').slice(0,2000)},this.runId);
      }
      if(event.type==='message_update'&&event.assistantMessageEvent.type==='text_delta'){
        live+=event.assistantMessageEvent.delta;
        if(Date.now()-lastDelta>180){lastDelta=Date.now();this.store.event('agent.text',{node,role,text:scrub(live).slice(-20000)},this.runId);}
      }
    });
    try{
      await agent.prompt(prompt);checkAbort(signal);
      if(this.store.hasUnresolvedEffects(this.runId))throw new LoopError('EFFECT_UNKNOWN','原生命令或 Python 结果未知，已停止后续工具和模型调用；回执保留，不能视为完成。');
      const last=[...agent.state.messages].reverse().find(m=>m.role==='assistant');
      if(last?.stopReason==='error'||last?.stopReason==='aborted'){
        const error=last.errorMessage||'模型请求中断';const code=['EFFECT_UNKNOWN','BUDGET_PAUSED','USER_PAUSED','HOST_SHUTDOWN','CONTEXT_TOO_LARGE','MODEL_TIMEOUT'].find(c=>error.includes(c))||(last.stopReason==='aborted'?'CANCELLED':'MODEL_ERROR');throw new LoopError(code,error);
      }
      if(turns>=this.settings.maxAgentTurns&&!submitted?.()&&last?.content?.some(c=>c.type==='toolCall'))throw new LoopError('TURN_LIMIT','到达工具循环上限；保留回执，未宣称完成');
      const text=(last?.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
      this.store.event('agent.completed',{node,role,trace:path.relative(LOCAL,trace),evidenceCalls},this.runId);
      return {text,trace,evidenceCalls,messages:agent.state.messages};
    }finally{signal?.removeEventListener('abort',abort);this.agents.delete(agent);}
  }
  async structured({schema,validate=x=>x,minEvidence=0,...options}){
    let value,hasValue=false,observed=0;
    const submit={name:'submit_result',label:'提交结构化结果',description:'提交最终结果。risks、recommendations、findings、checks 等字符串数组中必须放文字，不能放 JSON Schema 对象。成功后结束当前工作。',parameters:schema,execute:async(_id,args)=>{
      if(observed<minEvidence)throw new LoopError('MISSING_INDEPENDENT_EVIDENCE','提交前先独立读取相关文件或来源，或运行适用检查；现在仍可使用工具补齐，不必重做整个任务。');
      value=validate(args);hasValue=true;return {content:[{type:'text',text:'结构化结果已接收；宿主仍将独立核验。'}],details:{submitted:true},terminate:true};}};
    const result=await this.run({...options,tools:[...(options.tools||[]),submit],system:options.system+'\n完成后必须调用 submit_result；不要以普通文本代替提交。只报告新事实、来源与边界，避免复述整份输入。',submitted:()=>hasValue,onEvidence:n=>{observed=n;options.onEvidence?.(n);}});
    if(!hasValue)throw new LoopError('MISSING_STRUCTURED_RESULT','模型没有提交结构化结果，不能作为完成处理');
    if(result.evidenceCalls<minEvidence)throw new LoopError('MISSING_INDEPENDENT_EVIDENCE','没有独立读取或运行证据，不能通过审核');
    return {value,trace:result.trace,evidenceCalls:result.evidenceCalls};
  }
  abort(){for(const a of this.agents)a.abort();}
  async idle(){await Promise.allSettled([...this.agents].map(a=>a.waitForIdle()));}
}

export const schemas={
  routing:Type.Object({kind:Type.Union([Type.Literal('chat'),Type.Literal('task')]),reason:Type.String()}),
  scout:Type.Object({summary:Type.String(),evidence:Type.Array(Type.Object({source:Type.String(),finding:Type.String()})),risks:Type.Array(Type.String()),recommendations:Type.Array(Type.String())}),
  audit:Type.Object({pass:Type.Boolean(),reason:Type.String(),checkedEvidence:Type.Array(Type.String({minLength:1}),{minItems:1}),findings:Type.Array(Type.String()),remainingRisks:Type.Array(Type.String())}),
  plan:Type.Object({summary:Type.String(),successCriteria:Type.Array(Type.String()),verificationCommands:Type.Array(Type.String()),tasks:Type.Array(Type.Object({id:Type.String(),title:Type.String(),role:Type.String(),instructions:Type.String(),dependsOn:Type.Array(Type.String()),ownedPaths:Type.Array(Type.String()),acceptance:Type.Array(Type.String())}))}),
  work:Type.Object({summary:Type.String(),evidence:Type.Array(Type.String()),checks:Type.Array(Type.String()),limitations:Type.Array(Type.String())}),
  decision:Type.Object({pass:Type.Boolean(),summary:Type.String(),criteria:Type.Array(Type.Object({criterion:Type.String(),passed:Type.Boolean(),evidence:Type.String()})),remainingRisks:Type.Array(Type.String()),repairInstructions:Type.String()})
};
