import fs from 'node:fs';
import path from 'node:path';
import {APP_ROOT,uid,now,sha,ensureDir,writeJSON} from '../server/util.mjs';
const directory=ensureDir(path.join(APP_ROOT,'docs/evidence',`audit-${Date.now()}`));
const repositories=['earendil-works/pi','nicobailon/pi-subagents','assistant-ui/assistant-ui','open-webui/open-webui','danny-avila/LibreChat','lobehub/lobe-chat','statelyai/xstate','langchain-ai/langgraphjs','temporalio/sdk-typescript','xyflow/xyflow','OpenAutoCoder/Agentless','SWE-agent/SWE-agent'];
const pages=[
 ['xstate-persistence','https://stately.ai/docs/persistence','Official persistence semantics; installed v5 source is the API authority'],
 ['assistant-ui-external-store','https://www.assistant-ui.com/docs/runtimes/custom/external-store','Official custom-backend UI integration'],
 ['pi-subagents-readme','https://raw.githubusercontent.com/nicobailon/pi-subagents/main/README.md','Upstream explicitly leaves delegation and automatic review to parent instructions'],
 ['pi-sdk','https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/sdk.md','SDK reference; not a substitute for installed-version types'],
 ['git-worktree','https://git-scm.com/docs/git-worktree','Official isolated working-tree mechanism'],
 ['MAST','https://arxiv.org/html/2503.13657v1','Why Do Multi-Agent LLM Systems Fail?'],
 ['scaling-agents','https://arxiv.org/html/2512.08296v1','Towards a Science of Scaling Agent Systems'],
 ['Agentless','https://arxiv.org/html/2407.01489v1','Agentless: Demystifying LLM-based Software Engineering Agents'],
 ['SWE-agent','https://arxiv.org/html/2405.15793v1','SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering'],
 ['ReAct','https://arxiv.org/abs/2210.03629','Abstract only: reasoning/acting with observations'],
 ['Reflexion','https://arxiv.org/abs/2303.11366','Abstract only: feedback and retry'],
 ['Self-Refine','https://arxiv.org/abs/2303.17651','Abstract only: iterative refinement, not independent verification'],
 ['Agent-Workflow-Memory','https://arxiv.org/abs/2409.07429','Abstract only: workflow reuse, not an exactly-once persistence guarantee']
];
const sources=[...repositories.map(r=>[r.replaceAll('/','--'),`https://api.github.com/repos/${r}`,'Repository metadata, not a benchmark']),...pages];
const report={started:now(),command:process.argv,cwd:APP_ROOT,environment:{node:process.version,platform:process.platform},scope:'Primary repository metadata, official docs, full HTML papers where available, and explicitly labelled abstract-only sources. No replication or exhaustive/global-optimum claim.',sources:[],installedAPI:[]};
for(let offset=0;offset<sources.length;offset+=4)await Promise.all(sources.slice(offset,offset+4).map(async([name,url,scope])=>{
  const start=Date.now();try{const r=await fetch(url,{headers:{'User-Agent':'PiLoopStudio-Evidence-Audit'},signal:AbortSignal.timeout(40000)});const raw=Buffer.from(await r.arrayBuffer());const file=name+'.txt';fs.writeFileSync(path.join(directory,file),raw);let metadata;
    if(url.includes('api.github.com')&&r.ok){const data=JSON.parse(raw.toString('utf8'));metadata={name:data.full_name,license:data.license?.spdx_id,defaultBranch:data.default_branch,archived:data.archived,pushedAt:data.pushed_at};}
    report.sources.push({name,url,finalUrl:r.url,scope,status:r.status,ok:r.ok,bytes:raw.length,sha256:sha(raw),file,metadata,retrievedAt:now(),durationMs:Date.now()-start});console.log(`${r.status} ${name}`);
  }catch(e){report.sources.push({name,url,scope,ok:false,error:e.message,at:now()});console.log(`UNVERIFIED ${name}: ${e.message}`);}
}));
for(const rel of ['@earendil-works/pi-agent-core/dist/agent.d.ts','@earendil-works/pi-agent-core/dist/agent-loop.js','@earendil-works/pi-coding-agent/dist/core/compaction/compaction.d.ts','@earendil-works/pi-coding-agent/dist/core/tools/powershell.d.ts','@assistant-ui/react/package.json','xstate/package.json']){
  const file=path.join(APP_ROOT,'node_modules',rel);if(fs.existsSync(file)){const bytes=fs.readFileSync(file);const name='installed-'+rel.replaceAll('/','--');fs.writeFileSync(path.join(directory,name),bytes);report.installedAPI.push({path:rel,file:name,bytes:bytes.length,sha256:sha(bytes)});}
}
report.finished=now();report.exitCode=report.sources.some(s=>!s.ok)?2:0;writeJSON(path.join(directory,'sources.json'),report);console.log(JSON.stringify({directory,sources:report.sources.length,failed:report.sources.filter(s=>!s.ok).map(s=>s.name),exitCode:report.exitCode}));process.exitCode=report.exitCode;
