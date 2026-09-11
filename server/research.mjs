import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { LOCAL,ensureDir,sha,now,writeJSON,LoopError,checkAbort } from './util.mjs';
import { credentials,scrub } from './settings.mjs';

export class Research {
  constructor(store,runId,settings){Object.assign(this,{store,runId,settings});this.directory=ensureDir(path.join(LOCAL,'runs',runId,'sources'));}
  archive(content,metadata){
    const text=scrub(content),hash=sha(text),file=path.join(this.directory,hash+'.txt'),meta=path.join(this.directory,hash+'.json');
    if(!fs.existsSync(file))fs.writeFileSync(file,text,'utf8');
    const receipt={...metadata,hash,bytes:Buffer.byteLength(text),characters:text.length,retrievedAt:now()};
    const previous=fs.existsSync(meta)?JSON.parse(fs.readFileSync(meta,'utf8')):null;
    writeJSON(meta,{...receipt,receipts:[...(previous?.receipts||(previous?[previous]:[])),receipt]});
    this.store.event('research.source',receipt,this.runId);
    return {...receipt,text:text.slice(0,12000),truncated:text.length>12000,nextOffset:text.length>12000?12000:null};
  }
  readSource(hash,{offset=0,limit=12000}={}){
    if(!/^[a-f0-9]{64}$/.test(hash))throw new LoopError('INVALID_SOURCE','需要来源的完整 SHA256');
    if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>24000)throw new LoopError('INVALID_SOURCE_RANGE');
    const file=path.join(this.directory,hash+'.txt');if(!fs.existsSync(file))throw new LoopError('SOURCE_NOT_FOUND');
    const text=fs.readFileSync(file,'utf8');if(sha(text)!==hash)throw new LoopError('SOURCE_CORRUPTION','原始来源哈希不一致');
    const metadata=JSON.parse(fs.readFileSync(path.join(this.directory,hash+'.json'),'utf8')),end=Math.min(text.length,offset+limit);
    this.store.event('research.read',{hash,offset,end},this.runId);
    return {hash,metadata,offset,characters:text.length,text:text.slice(offset,end),nextOffset:end<text.length?end:null};
  }
  findSources(query=''){
    const needle=query.toLowerCase();return fs.readdirSync(this.directory).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(this.directory,f),'utf8')))
      .filter(r=>JSON.stringify(r).toLowerCase().includes(needle)).slice(-100).map(({receipts,...record})=>({...record,retrievals:receipts?.length||1}));
  }
  async search(query,{signal,numResults=5}={}){
    if(scrub(query)!==query)throw new LoopError('PRIVATE_QUERY','公开检索不得包含连接凭据');
    if(!this.settings.research.enabled)throw new LoopError('RESEARCH_DISABLED','在线研究已在设置中关闭');
    checkAbort(signal);const config=this.settings.research;
    const client=new Client({name:'pi-loop-studio',version:'2.0.0'},{capabilities:{}});
    const key=credentials().research;
    const transport=new StreamableHTTPClientTransport(new URL(config.mcpUrl),{requestInit:{headers:key?{'x-api-key':key}:{}},fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.any([...(signal?[signal]:[]),...(init?.signal?[init.signal]:[]),AbortSignal.timeout(config.fetchTimeoutSeconds*1000)])})});
    try{
      await client.connect(transport);
      const available=await client.listTools();const tool=available.tools.find(t=>t.name==='web_search_exa');
      if(!tool)throw new LoopError('SEARCH_TOOL_UNAVAILABLE','已连接的研究 MCP 不提供 web_search_exa');
      const result=await client.callTool({name:tool.name,arguments:{query,numResults:Math.min(10,Math.max(1,numResults))}},undefined,{signal,timeout:config.fetchTimeoutSeconds*1000});
      if(result.isError)throw new LoopError('SEARCH_ERROR',scrub(result.content?.map(c=>c.text||'').join('\n')||'检索提供方返回错误'));
      return this.archive(result.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')||JSON.stringify(result),{kind:'search',query,provider:config.mcpUrl});
    }finally{await client.close().catch(()=>{});}
  }
  async fetchUrl(value,{signal}={}){
    if(scrub(value)!==value)throw new LoopError('PRIVATE_QUERY','公开来源地址不得包含连接凭据');
    if(!this.settings.research.enabled)throw new LoopError('RESEARCH_DISABLED');
    const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new LoopError('INVALID_URL');
    const config=this.settings.research;
    const response=await fetch(url,{signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(config.fetchTimeoutSeconds*1000)]),headers:{'User-Agent':'PiLoop/2.0 (local research client)','Accept':'text/html,text/plain,application/json,application/xml'}});
    if(!response.ok)throw new LoopError('FETCH_ERROR',`HTTP ${response.status}: ${url}`);
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>config.maxSourceBytes)throw new LoopError('SOURCE_TOO_LARGE',`来源超过 ${config.maxSourceBytes} bytes，未静默截断为完整证据`);chunks.push(chunk);}
    const bytes=Buffer.concat(chunks),type=response.headers.get('content-type')||'';let text=bytes.toString('utf8'),title='';
    if(type.includes('text/html')){
      const {document}=parseHTML(text);for(const el of document.querySelectorAll('script,style,nav,footer'))el.remove();
      const article=new Readability(document).parse();title=article?.title||document.title||'';text=article?.textContent||document.body?.textContent||document.textContent||'';
    }else if(!/text\/|json|xml|javascript/.test(type))throw new LoopError('SOURCE_FORMAT_UNSUPPORTED',`此工具尚不解码 ${type}；不能声称已阅读该 PDF/二进制来源。可通过 Python 工具显式解析。`);
    return this.archive(text,{kind:'page',url:response.url,title,contentType:type,httpStatus:response.status,rawSha256:sha(bytes)});
  }
}
