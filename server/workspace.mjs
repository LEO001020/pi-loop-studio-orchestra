import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { APP_ROOT,LOCAL,ensureDir,sha,writeJSON,readJSON,portablePath,inside,LoopError,Slots,now,checkAbort,atomicWrite } from './util.mjs';
import { git } from './commands.mjs';
import { credentials } from './settings.mjs';

const SECRET_NAME=/^(?:\.env(?:\..*)?|credentials(?:\..*)?\.json|auth\.json|astra\.config\.json|.*\.(?:pem|pfx|p12|key))$/i;
const internal=name=>name==='.git'||name.startsWith('.pi-')||SECRET_NAME.test(name);
export function fileManifest(root,settings,{copyTo,checkSecrets=false,reference,ownedPaths=[]}={}) {
  const files={},skipped=[],limits={bytes:0,files:0};
  const excluded=new Set(settings.excludeDirectories);
  const keys=checkSecrets?Object.values(credentials()).filter(v=>typeof v==='string'&&v.length>8):[];
  function visit(dir,prefix=''){
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const rel=prefix?`${prefix}/${entry.name}`:entry.name,full=path.join(dir,entry.name);
      if(internal(entry.name)||entry.isDirectory()&&excluded.has(entry.name)){skipped.push({path:rel,reason:'excluded'});continue;}
      if(reference&&!Object.hasOwn(reference,rel)&&isGeneratedPath(rel,settings)&&!owns(ownedPaths,rel)&&entry.isFile()){skipped.push({path:rel,reason:'new generated output, not accepted source'});continue;}
      const stat=fs.lstatSync(full);
      if(entry.isSymbolicLink()||stat.isSymbolicLink()){skipped.push({path:rel,reason:'link not copied'});continue;}
      if(stat.isDirectory()){visit(full,rel);continue;}
      if(!stat.isFile()){skipped.push({path:rel,reason:'not regular file'});continue;}
      const normal=portablePath(rel);limits.bytes+=stat.size;limits.files++;
      if(limits.bytes>settings.snapshotMaxMiB*1048576||limits.files>settings.snapshotMaxFiles)throw new LoopError('SNAPSHOT_LIMIT','工作区超过用户设置的快照大小/文件数；请选择更具体的项目目录或在 UI 调整限制。');
      const bytes=fs.readFileSync(full);
      if(keys.some(k=>bytes.includes(Buffer.from(k))))throw new LoopError('CREDENTIAL_IN_ARTIFACT',`文件 ${normal} 含模型凭据；不会发送或发布该文件。`);
      files[normal]={hash:sha(bytes),bytes:bytes.length};
      if(copyTo){const target=path.join(copyTo,normal);ensureDir(path.dirname(target));fs.writeFileSync(target,bytes);}
    }
  }
  if(fs.existsSync(root))visit(root);
  return {files,skipped,bytes:limits.bytes,fileCount:limits.files,at:now()};
}
export function manifestDiff(base,current){return [...new Set([...Object.keys(base),...Object.keys(current)])].sort().filter(p=>base[p]?.hash!==current[p]?.hash).map(p=>({path:p,before:base[p]?.hash??null,after:current[p]?.hash??null,bytes:current[p]?.bytes??0,kind:!base[p]?'added':!current[p]?'deleted':'modified'}));}
export function isGeneratedPath(file,settings){return (settings.generatedDirectories||[]).some(dir=>{const normalized=portablePath(dir).toLowerCase(),candidate=portablePath(file).toLowerCase();return candidate.startsWith(normalized+'/');});}
export function classifyChanges(changes,settings,{ownedPaths=[]}={}){
  const generatedArtifacts=[],sourceMutations=[];
  for(const change of changes){
    // Existing accepted bytes never become exempt merely because their path
    // now matches an output directory. Explicitly owned deliverables also stay.
    (change.before===null&&isGeneratedPath(change.path,settings)&&!owns(ownedPaths,change.path)?generatedArtifacts:sourceMutations).push(change);
  }
  return {sourceMutations,generatedArtifacts};
}
export function owns(ownedPaths,rel){const p=portablePath(rel).toLowerCase();return ownedPaths.some(v=>{const q=portablePath(v).toLowerCase();return q!==''&&(p===q||p.startsWith(q+'/'));});}
export function checkedPath(root,value,{write=false,ownedPaths=[]}={}){
  const rel=portablePath(value),full=path.join(root,rel);
  if(!inside(root,full))throw new LoopError('OUTSIDE_WORKTREE');
  if(rel.split('/').some(internal))throw new LoopError('PRIVATE_FILE','不能通过模型工具访问凭据或内部运行文件');
  if(write&&!owns(ownedPaths,rel))throw new LoopError('OWNERSHIP_CONFLICT',`此岗位不拥有 ${rel}；只能提交声明范围内的改动。`);
  let ancestor=full;
  while(inside(root,ancestor)){
    if(fs.existsSync(ancestor)&&fs.lstatSync(ancestor).isSymbolicLink())throw new LoopError('LINK_PATH','工作树工具不能通过符号链接修改共享文件');
    if(ancestor===root)break;ancestor=path.dirname(ancestor);
  }
  return {full,rel};
}
export function validatePlan(value,settings){
  if(!Array.isArray(value.tasks)||!value.tasks.length)throw new LoopError('EMPTY_PLAN','任务计划不能为空');
  if(value.tasks.length>200)throw new LoopError('PLAN_TOO_LARGE','每轮计划最多 200 个有边界的任务');
  const ids=new Set(value.tasks.map(t=>t.id));
  if(new Set(value.tasks.map(t=>t.id.toLowerCase())).size!==value.tasks.length||value.tasks.some(t=>!/^[-\w]{1,60}$/.test(t.id)))throw new LoopError('INVALID_TASK_ID','Windows 任务 ID 必须忽略大小写后仍唯一，且只含字母、数字、横线、下划线');
  const names=new Set(settings.roles.filter(r=>r.count>0).map(r=>r.name));
  const byId=new Map(value.tasks.map(t=>[t.id,t]));
  const visiting=new Set(),done=new Set();
  function walk(id){if(visiting.has(id))throw new LoopError('PLAN_CYCLE','任务依赖形成环');if(done.has(id))return;visiting.add(id);const t=byId.get(id);for(const dep of t.dependsOn){if(!ids.has(dep))throw new LoopError('UNKNOWN_DEPENDENCY',`${id} 引用了不存在的 ${dep}`);walk(dep);}visiting.delete(id);done.add(id);}
  for(const t of value.tasks){
    if(!names.has(t.role))throw new LoopError('UNKNOWN_ROLE',`计划岗位 ${t.role} 不在当前 UI 配置中`);
    t.ownedPaths=t.ownedPaths.map(p=>portablePath(p));
    if(t.ownedPaths.some(p=>!p||p.split('/').some(internal)))throw new LoopError('INVALID_OWNERSHIP','不能独占整个工作区或内部私有文件');
    if(!t.acceptance.length)throw new LoopError('MISSING_ACCEPTANCE',`${t.id} 缺少验收标准`);
    walk(t.id);
  }
  function depends(a,b,seen=new Set()){if(seen.has(a))return false;seen.add(a);const ds=byId.get(a).dependsOn;return ds.includes(b)||ds.some(d=>depends(d,b,seen));}
  for(let i=0;i<value.tasks.length;i++)for(let j=i+1;j<value.tasks.length;j++){
    const a=value.tasks[i],b=value.tasks[j];
    if(a.ownedPaths.some(p=>owns(b.ownedPaths,p)||b.ownedPaths.some(q=>owns([p],q)))&&!depends(a.id,b.id)&&!depends(b.id,a.id))throw new LoopError('PLAN_OWNERSHIP_OVERLAP',`${a.id} 与 ${b.id} 写入范围冲突；必须拆分文件所有权或声明有向依赖。`);
  }
  if(!value.successCriteria?.length)throw new LoopError('MISSING_SUCCESS_CRITERIA');
  return value;
}
export class Workspaces {
  gate=new Slots(1);
  constructor(store,run){this.store=store;this.runId=run.id;this.settings=run.settings;this.root=path.join(LOCAL,'runs',run.id);this.repo=path.join(this.root,'candidate');this.original=run.workspace;}
  async prepare(signal){return this.gate.use(async()=>{
    const infoFile=path.join(this.root,'workspace.json'),previous=readJSON(infoFile,null);
    if(previous&&fs.existsSync(path.join(this.repo,'.git')))return previous;
    ensureDir(this.root);ensureDir(this.original);checkAbort(signal);
    // No completed snapshot exists, so an interrupted preparation has no
    // accepted artifacts. Recreate only this run's private staging directory.
    if(fs.existsSync(this.repo))fs.rmSync(this.repo,{recursive:true,force:true});
    ensureDir(this.repo);
    const snapshot=fileManifest(this.original,this.settings,{copyTo:this.repo,checkSecrets:true});
    await git(['init','--quiet','--object-format=sha1'],this.repo,signal);
    await git(['config','user.name','Pi Loop Local'],this.repo,signal);await git(['config','user.email','pi-loop@localhost'],this.repo,signal);
    await git(['config','core.autocrlf','false'],this.repo,signal);await git(['config','core.longpaths','true'],this.repo,signal);
    fs.writeFileSync(path.join(this.repo,'.git/info/exclude'),['.pi-*',...this.settings.excludeDirectories.map(d=>d+'/')].join('\n')+'\n');
    if(Object.keys(snapshot.files).length)await this.stage(this.repo,Object.keys(snapshot.files),signal);
    await git(['commit','--quiet','--allow-empty','-m','User workspace snapshot (including uncommitted source)'],this.repo,signal);
    const commit=await git(['rev-parse','HEAD'],this.repo,signal);
    const info={original:this.original,repo:this.repo,baseCommit:commit,baseline:snapshot.files,skipped:snapshot.skipped,files:snapshot.files?Object.keys(snapshot.files).length:0,bytes:snapshot.bytes,created:now()};
    writeJSON(infoFile,info);this.store.event('workspace.snapshot',{files:info.files,bytes:info.bytes,skipped:info.skipped,commit},this.runId);return info;
  },signal);}
  async stage(cwd,paths,signal){
    // Git's supported plumbing stores the actual bytes, not the output of a
    // repository's clean filter or end-of-line converter. NUL index records
    // and stdin paths also avoid Windows command-line length limits.
    const records=[];
    for(let i=0;i<paths.length;i+=80){
      const chunk=paths.slice(i,i+80),present=chunk.filter(p=>fs.existsSync(path.join(cwd,p)));
      const objects=present.length?(await git(['hash-object','--no-filters','-w','--stdin-paths'],cwd,signal,{input:present.join('\n')+'\n'})).split(/\r?\n/):[];
      if(objects.length!==present.length||objects.some(h=>!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(h)))throw new LoopError('GIT_OBJECT_PROTOCOL','Git 未返回每个文件对应的真实对象 ID');
      for(let n=0;n<present.length;n++)records.push(`100644 ${objects[n]}\t${present[n]}\0`);
      for(const p of chunk.filter(p=>!present.includes(p)))records.push(`0 ${'0'.repeat(40)}\t${p}\0`);
    }
    if(records.length)await git(['update-index','-z','--index-info'],cwd,signal,{input:records.join('')});
  }
  async branch(id,{ref='HEAD',signal,manifest,source=this.repo}={}){return this.gate.use(async()=>{
    if(!/^[-\w]+$/.test(id))throw new LoopError('INVALID_WORKTREE_ID');
    const expected=manifest||fileManifest(source,this.settings).files;
    // Only completed node outputs are reused. An interrupted materialization
    // never masquerades as a ready worktree merely because .git exists.
    // Workers persist this concrete path before their first model/tool call.
    const parent=ensureDir(path.join(this.root,'worktrees')),dir=fs.mkdtempSync(path.join(parent,id+'-'));
    await git(['worktree','add','--quiet','--no-checkout','--detach',dir,ref],this.repo,signal);
    await git(['read-tree',ref],dir,signal);
    const copied=fileManifest(source,this.settings,{copyTo:dir,checkSecrets:true,reference:expected});
    if(manifestDiff(expected,copied.files).length)throw new LoopError('ARTIFACT_CORRUPTION','源工作树与固定提案清单不同，未把变化后的文件交给下一岗位。');
    return dir;
  },signal);}
  async baseline(cwd,signal){return {commit:await git(['rev-parse','HEAD'],cwd,signal),files:fileManifest(cwd,this.settings).files};}
  async capture(cwd,baseline,ownedPaths,{signal}={}){
    const current=fileManifest(cwd,this.settings,{checkSecrets:true});
    const {sourceMutations:changes,generatedArtifacts}=classifyChanges(manifestDiff(baseline.files,current.files),this.settings,{ownedPaths});
    for(const artifact of generatedArtifacts)delete current.files[artifact.path];
    const unauthorized=changes.filter(c=>!owns(ownedPaths,c.path));
    if(unauthorized.length)throw new LoopError('OWNERSHIP_CONFLICT',`产物修改了未分配路径：${unauthorized.map(c=>c.path).join(', ')}`);
    const objectDir=ensureDir(path.join(this.root,'objects'));
    for(const c of changes)if(c.after){const bytes=fs.readFileSync(path.join(cwd,c.path));const object=path.join(objectDir,c.after);if(!fs.existsSync(object))fs.writeFileSync(object,bytes);}
    await git(['read-tree',baseline.commit],cwd,signal);
    if(changes.length)await this.stage(cwd,changes.map(c=>c.path),signal);
    await git(['commit','--quiet','--allow-empty','-m','Worker proposal; NOT independently accepted'],cwd,signal);
    const commit=await git(['rev-parse','HEAD'],cwd,signal);
    const diff=await git(['diff','--no-ext-diff','--no-textconv','--no-color',baseline.commit,commit,'--'],cwd,signal);
    if(manifestDiff(current.files,fileManifest(cwd,this.settings,{reference:baseline.files,ownedPaths}).files).length)throw new LoopError('ARTIFACT_CORRUPTION','固定提案提交期间文件又发生改变，不接受未绑定的候选。');
    return {commit,baselineCommit:baseline.commit,manifest:current.files,manifestSha256:sha(JSON.stringify(Object.keys(current.files).sort().map(p=>[p,current.files[p]]))),changes,generatedArtifacts,diff:diff.slice(0,500000),diffTruncated:diff.length>500000};
  }
  async integrate(job,signal){return this.gate.use(async()=>{
    if(job.status==='integrated')return;
    if(!job.audit?.pass||!job.proposal)throw new LoopError('UNREVIEWED_PROPOSAL','未经独立审核的候选不能合并');
    const current=fileManifest(this.repo,this.settings).files;
    for(const change of job.proposal.changes){const actual=current[change.path]?.hash??null;
      if(actual!==change.before&&actual!==change.after)throw new LoopError('INTEGRATION_CONFLICT',`候选整合冲突: ${change.path}`);
    }
    for(const change of job.proposal.changes){
      const target=checkedPath(this.repo,change.path,{write:true,ownedPaths:job.ownedPaths}).full;
      if(change.after){const bytes=fs.readFileSync(path.join(this.root,'objects',change.after));if(sha(bytes)!==change.after)throw new LoopError('ARTIFACT_CORRUPTION');atomicWrite(target,bytes);}
      else fs.rmSync(target,{force:true});
    }
    await git(['read-tree','HEAD'],this.repo,signal);
    if(job.proposal.changes.length)await this.stage(this.repo,job.proposal.changes.map(c=>c.path),signal);
    await git(['commit','--quiet','--allow-empty','-m',`Reviewed task ${job.taskId}`],this.repo,signal);
    this.store.patchJob(job.id,{status:'integrated',integratedCommit:await git(['rev-parse','HEAD'],this.repo,signal)});
  },signal);}
  candidateDiff(){const info=readJSON(path.join(this.root,'workspace.json'),null);if(!info)return [];return manifestDiff(info.baseline,fileManifest(this.repo,this.settings).files);}
  async publish(signal,expectedManifest){return this.gate.use(async()=>{
    const changes=this.candidateDiff(),journalFile=path.join(this.root,'publication.json');
    let journal=readJSON(journalFile,null);
    if(journal?.status==='completed')return journal;
    if(!expectedManifest)throw new LoopError('UNVERIFIED_PUBLICATION','发布必须绑定实际终验的候选清单');
    if(manifestDiff(expectedManifest,fileManifest(this.repo,this.settings).files).length)throw new LoopError('ARTIFACT_CORRUPTION','当前候选与通过终验的文件清单不同，禁止发布。');
    const baseline=readJSON(path.join(this.root,'workspace.json'),null)?.baseline;
    if(!baseline)throw new LoopError('MISSING_WORKSPACE_BASELINE','原始工作区基线缺失，不能确定发布是否覆盖用户变更。');
    const changeByPath=new Map(changes.map(c=>[c.path,c]));
    const originalFiles=fileManifest(this.original,this.settings).files;
    for(const p of new Set([...Object.keys(baseline),...Object.keys(originalFiles)])){
      const actual=originalFiles[p]?.hash??null,before=baseline[p]?.hash??null,c=changeByPath.get(p);
      // A resumed publication may already have written some approved files.
      // Testing A+B does not verify A+B' just because B was not edited here.
      if(actual!==before&&!(journal&&c&&actual===c.after))throw new LoopError('PUBLISH_CONFLICT',`终验所依据的用户工作区已改变 ${p}；候选保留，不能把旧基线测试当成新工作区的验证。`);
    }
    if(!journal){journal={status:'prepared',started:now(),original:this.original,changes,completed:[]};
      for(const c of changes){const p=checkedPath(this.original,c.path).full;const actual=fs.existsSync(p)?sha(fs.readFileSync(p)):null;
        if(actual!==c.before)throw new LoopError('PUBLISH_CONFLICT',`用户工作区在任务期间已改变 ${c.path}；候选保留，未覆盖用户改动。`);
      }
      const backup=ensureDir(path.join(this.root,'publication-backup'));
      for(const c of changes)if(c.before){const src=checkedPath(this.original,c.path).full,dst=path.join(backup,c.path);ensureDir(path.dirname(dst));fs.copyFileSync(src,dst);}
      writeJSON(journalFile,journal);
    }
    // Verify every approved source before the first write. Recheck the actual
    // bytes at each write as well; a path is not a frozen proposal.
    for(const c of journal.changes)if(c.after){
      const source=checkedPath(this.repo,c.path).full;
      if(!fs.existsSync(source)||sha(fs.readFileSync(source))!==c.after)throw new LoopError('ARTIFACT_CORRUPTION',`候选在审核后发生变化：${c.path}；不发布。`);
    }
    // A publication is a recoverable sequence, not a fictitious multi-file atomic transaction.
    for(const c of journal.changes){checkAbort(signal);const target=checkedPath(this.original,c.path).full;
      const actual=fs.existsSync(target)?sha(fs.readFileSync(target)):null;
      if(actual!==c.after&&actual!==c.before)throw new LoopError('PUBLISH_CONFLICT',`发布时检测到并发改写 ${c.path}；不覆盖，已完成项见发布回执。`);
      if(actual!==c.after){if(c.after){const bytes=fs.readFileSync(path.join(this.repo,c.path));if(sha(bytes)!==c.after)throw new LoopError('ARTIFACT_CORRUPTION',`发布源哈希不一致：${c.path}`);atomicWrite(target,bytes);}else fs.rmSync(target,{force:true});}
      if(!journal.completed.includes(c.path))journal.completed.push(c.path);writeJSON(journalFile,journal);
    }
    const finalDifferences=manifestDiff(expectedManifest,fileManifest(this.original,this.settings).files);
    if(finalDifferences.length)throw new LoopError('PUBLISH_CONFLICT',`发布期间工作区又发生变化：${finalDifferences.map(c=>c.path).join(', ')}；已写入项见 publication.json，未宣称完整发布成功。`);
    journal.status='completed';journal.finished=now();writeJSON(journalFile,journal);
    this.store.event('workspace.published',{changes:journal.changes,original:this.original},this.runId);return journal;
  },signal);}
}
