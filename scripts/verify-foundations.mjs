// Real native processes, persistent Python, worktrees and cross-drive writes.
// There are no model substitutes in this test and no model success claim.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {APP_ROOT,LOCAL,uid,now,ensureDir,writeJSON,sha} from '../server/util.mjs';
import {loadSettings,resolveWorkspace} from '../server/settings.mjs';
import {Store} from '../server/store.mjs';
import {Workspaces,fileManifest} from '../server/workspace.mjs';
import {executeProcess} from '../server/commands.mjs';
import {PythonKernel} from '../server/python.mjs';

const id=uid(),dir=ensureDir(path.join(APP_ROOT,'validation',`foundations-${id}`));
const report={started:now(),command:process.argv,cwd:APP_ROOT,environment:{node:process.version,platform:process.platform,arch:process.arch,os:os.release()},kind:'REAL_NATIVE_OPERATIONS_NO_MODELS',checks:[],commands:[],exitCode:null};
const settings=loadSettings(),store=new Store(path.join(dir,'state.sqlite'));
let kernel;
try{
  const cwd=ensureDir(path.join(dir,'中文 路径')),session=store.createSession(cwd),run=store.createRun(session.id,'Native foundation verification',settings);
  const python=path.join(APP_ROOT,'.python/Scripts/python.exe');
  const version=await executeProcess(python,['-X','utf8','-c','import sys; print(sys.version); print("中文标准输出"); print("中文错误输出",file=sys.stderr)'],{cwd,timeout:30});
  report.commands.push(version);assert.equal(version.exitCode,0);assert.match(version.stdout,/中文标准输出/);assert.match(version.stderr,/中文错误输出/);
  kernel=new PythonKernel(store,run.id,'unicode-kernel',cwd,settings);
  const start=Date.now();
  const first=await kernel.exec('from pathlib import Path\n计数 = 40\nPath("中文 文件.txt").write_text("持久内核证据", encoding="utf-8")\nprint("首次启动：", 计数)');
  report.pythonStartupMs=Date.now()-start;assert.equal(first.status,'ok');
  const second=await kernel.exec('计数 += 2\nprint("跨单元变量：", 计数)\nassert Path("中文 文件.txt").read_text(encoding="utf-8") == "持久内核证据"');
  assert.equal(second.status,'ok');assert.match(second.stdout,/42/);report.pythonCells=[first,second];await kernel.close();kernel=null;
  report.checks.push({name:'Python UTF-8, Chinese cwd, persistent namespace',ok:true});
  for(const alias of ['code','quant-foundry','quant-g']){
    const root=settings.roots.find(r=>r.alias===alias);assert(root,`Missing configured root ${alias}`);
    const leaf=`pi-loop-validation-${id}`,original=alias==='code'?path.join(APP_ROOT,'workspace',leaf):resolveWorkspace(`${alias}/${leaf}`,settings);
    ensureDir(original);fs.writeFileSync(path.join(original,'原始文件.txt'),'用户未提交状态','utf8');
    const session=store.createSession(original),run=store.createRun(session.id,`Cross-drive ${alias}`,settings),ws=new Workspaces(store,run);
    try{
      const snapshot=await ws.prepare();assert.equal(snapshot.baseline['原始文件.txt'].hash,sha('用户未提交状态'));
      const work=await ws.branch('worker'),baseline=await ws.baseline(work);
      fs.writeFileSync(path.join(work,'产物.txt'),`native-${alias}-${id}`,'utf8');
      const proposal=await ws.capture(work,baseline,['产物.txt']);
      const job={id:uid(),runId:run.id,taskId:'crossdrive',status:'auditing',ownedPaths:['产物.txt'],proposal};store.putJob(job);
      await assert.rejects(()=>ws.integrate(job),e=>e.code==='UNREVIEWED_PROPOSAL');
      await ws.integrate({...job,audit:{pass:true,reason:'Deterministic fixture review; NOT an LLM audit'}});
      const approved=fileManifest(ws.repo,settings).files;
      const publication=await ws.publish(undefined,approved);
      assert.equal(publication.status,'completed');assert.equal(fs.readFileSync(path.join(original,'产物.txt'),'utf8'),`native-${alias}-${id}`);
      assert.equal(fs.readFileSync(path.join(original,'原始文件.txt'),'utf8'),'用户未提交状态');
      report.checks.push({name:`${alias} snapshot, isolation, unreviewed rejection, publication`,ok:true,path:original,manifest:fileManifest(original,settings).files,publication,cleanup:'Only this generated test directory removed after verification'});
    }finally{fs.rmSync(original,{recursive:true,force:true});}
  }
  report.exitCode=0;report.status='VERIFIED_NATIVE_FOUNDATIONS';
}catch(e){report.status='FAILED';report.exitCode=1;report.error=e.stack;}
finally{await kernel?.close();store.close();report.finished=now();writeJSON(path.join(dir,'receipt.json'),report);}
console.log(JSON.stringify({status:report.status,receipt:path.join(dir,'receipt.json'),checks:report.checks.map(c=>({name:c.name,ok:c.ok})),pythonStartupMs:report.pythonStartupMs,error:report.error,exitCode:report.exitCode},null,2));process.exitCode=report.exitCode;
