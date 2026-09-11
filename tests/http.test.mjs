import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.mjs';
import {startServer} from '../server/index.mjs';
import {uid} from '../server/util.mjs';

test('HTTP lifecycle: durable idempotent send, visible 404, origin checks, event pagination and backlog resync',{timeout:45000},async()=>{
  const store=new Store(':memory:'),h=await startServer({port:0,store,recover:false,recordHost:false});
  // Explicit test double; no production model request is sent in this test.
  let launches=0;h.host.launch=async id=>{launches++;store.patchRun(id,{status:'completed',stage:'done'});};
  const request=async(url,method='GET',body,headers={})=>{const r=await fetch(h.address+'/api'+url,{method,headers:{'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
  try{
    const s=(await request('/sessions','POST',{title:'HTTP fixture'})).data;
    const payload={content:'Test-only message; not sent to a model',mode:'chat',budget:1234,requestId:uid()};
    const first=await request(`/sessions/${s.id}/messages`,'POST',payload),again=await request(`/sessions/${s.id}/messages`,'POST',payload);
    assert.equal(first.status,202);assert.equal(again.status,200);assert.equal(first.data.run.id,again.data.run.id);assert.equal(launches,1);assert.equal(store.messages(s.id).length,1);
    assert.equal((await request(`/sessions/${s.id}/messages`,'POST',{...payload,content:'different'})).status,409);
    assert.equal((await request('/sessions/does-not-exist')).status,404);
    assert.equal((await request('/sessions','POST',{}, {Origin:'https://external.invalid'})).status,403);
    const r=first.data.run.id;for(let i=0;i<5100;i++)store.event('test.fixture',{i},r,s.id);
    const page=await request(`/runs/${r}/events?after=0&limit=7`);assert.equal(page.data.events.length,7);assert.equal(page.data.hasMore,true);
    const next=await request(`/runs/${r}/events?after=${page.data.nextCursor}&limit=7`);assert(next.data.events[0].seq>page.data.nextCursor);
    const response=await fetch(h.address+'/api/events?after=0');const reader=response.body.getReader();let text='';
    while(!text.includes('event: ready')){const part=await reader.read();if(part.done)break;text+=new TextDecoder().decode(part.value);}
    assert.match(text,/event: resync/);assert.match(text,/REFRESH_MATERIALIZED_STATE/);await reader.cancel();
    const exported=(await request(`/runs/${r}/export`)).data;assert(exported.events.length>5100);assert.equal(exported.run.budget,1234);
    assert.equal(store.calls(r).length,0);
    store.patchRun(r,{status:'running',stage:'executing'});
    const nested=store.createSession(s.workspace+'/nested','Nested workspace');
    const collision=await request(`/sessions/${nested.id}/messages`,'POST',{...payload,requestId:uid()});
    assert.equal(collision.status,409,'Nested workspaces must not publish through independent concurrent runs');
    assert.equal(collision.data.error.code,'WORKSPACE_BUSY');assert.equal(launches,1);
    store.patchRun(r,{status:'completed',stage:'done'});
  }finally{await h.close();store.close();}
});
