import test from 'node:test';
import assert from 'node:assert/strict';
import {AssistantMessageEventStream} from '@earendil-works/pi-ai';
import {Store} from '../server/store.mjs';
import {PiRuntime} from '../server/pi.mjs';
import {loadSettings} from '../server/settings.mjs';

// A deterministic provider fixture, not a real-model capability claim.
function fixture(){
  const store=new Store(':memory:'),settings=loadSettings();settings.models.executor.requestTimeoutSeconds=.02;
  const session=store.createSession(process.cwd()),run=store.createRun(session.id,'Transport state regression',settings,100000);
  const model={api:'openai-completions',provider:'fixture',id:'fixture'};
  const pi=new PiRuntime(store,run);
  pi.models={streamSimple(_model,_context,{signal}){const s=new AssistantMessageEventStream();const end=()=>{const m={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],stopReason:'aborted',errorMessage:'provider aborted',usage:{input:0,output:0,totalTokens:0},timestamp:Date.now()};s.push({type:'error',reason:'aborted',error:m});s.end(m);};if(signal.aborted)end();else signal.addEventListener('abort',end,{once:true});return s;}};
  return {store,run,pi,model};
}
test('provider deadline is MODEL_TIMEOUT, not terminal user cancellation; unknown usage stays visible',async()=>{
  const f=fixture();try{const s=f.pi.stream('executor','deadline')(f.model,{});const events=[];for await(const e of s)events.push(e);const m=await s.result();assert.equal(m.stopReason,'error');assert.match(m.errorMessage,/MODEL_TIMEOUT/);assert.equal(events.at(-1).reason,'error');const c=f.store.calls(f.run.id)[0];assert.equal(c.status,'error');assert.equal(c.unknown,1);assert.equal(c.tokens,null);}finally{f.store.close();}
});
test('explicit caller cancellation remains cancellation, not mislabeled timeout',async()=>{
  const f=fixture(),controller=new AbortController();try{const s=f.pi.stream('executor','cancel',controller.signal)(f.model,{});setTimeout(()=>controller.abort(),5);for await(const _ of s){}const m=await s.result();assert.doesNotMatch(m.errorMessage,/MODEL_TIMEOUT/);assert.equal(m.stopReason,'aborted');}finally{f.store.close();}
});
