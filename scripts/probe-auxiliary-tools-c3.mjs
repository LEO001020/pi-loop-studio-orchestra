// Two real, bounded diagnostic calls. Does not modify saved model settings.
import path from 'node:path';
import {Store} from '../server/store.mjs';
import {PiRuntime,schemas} from '../server/pi.mjs';
import {makeTools} from '../server/tools.mjs';
import {APP_ROOT,LOCAL,uid,ensureDir,writeJSON,now} from '../server/util.mjs';
import {loadSettings} from '../server/settings.mjs';
const settings=loadSettings();settings.maxAgentTurns=8;settings.models.auxiliary.requestTimeoutSeconds=60;
const directory=ensureDir(path.join(APP_ROOT,'validation',`aux-tool-diagnostic-${uid()}`));
const store=new Store(path.join(directory,'state.sqlite')),cwd=path.join(LOCAL,'runs','808f88b6-9f9c-4425-bdd1-c727a39c25f1','candidate');
const report={started:now(),command:process.argv,environment:{node:process.version,platform:process.platform},results:[]};
for(const mode of (process.argv.includes('--single-tools')?['ls','grep','find']:process.argv.includes('--bisect-tools')?['files-only','archive-only','research-only']:process.argv.includes('--full-tools')?['full-tools']:['configured','bounded-off'])){
  const session=store.createSession(cwd),run=store.createRun(session.id,'Diagnostic independent file read, not project completion',settings,100000);
  const pi=await new PiRuntime(store,run).init(),bundle=makeTools({store,runId:run.id,jobId:mode,cwd,settings,mode:'scout'});
  const names=['ls','grep','find'].includes(mode)?['read',mode]:mode==='files-only'?['read','ls','grep','find']:mode==='archive-only'?['read','read_archive']:mode==='research-only'?['read','find_sources','read_source','web_search','fetch_url']:['read'];
  try{const value=await pi.structured({role:'auxiliary',node:mode,tools:mode==='full-tools'?bundle.tools:bundle.tools.filter(t=>names.includes(t.name)),schema:schemas.audit,minEvidence:1,
    ...(mode==='bounded-off'?{thinking:'off',maxTokens:8192}:{}),system:'独立读取 ZOD-API.md，确认文档声明的 Zod 版本。只核验这一个事实，read 后立即 submit_result，不研究其他文件。',prompt:'审核说法：ZOD-API.md 声明项目使用 Zod 4.6.1。'});
    report.results.push({mode,ok:true,value,metrics:store.metrics(run.id)});
  }catch(error){report.results.push({mode,ok:false,error:error.message,code:error.code,metrics:store.metrics(run.id)});}
  finally{await bundle.close();await pi.idle();}
}
report.finished=now();writeJSON(path.join(directory,'receipt.json'),report);store.close();console.log(JSON.stringify({...report,receipt:path.join(directory,'receipt.json')},null,2));
