import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root=path.resolve(import.meta.dirname,'..');
const old=path.resolve(root,'../pi-agent-loop');
const candidate=path.resolve(root,'../pi-loop-v2');
const read=(p,fallback={})=>fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,'')):fallback;
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const receipts=[];
function copy(from,to){
  if(!fs.existsSync(from))throw new Error(`Required reuse source missing: ${from}`);
  if(fs.existsSync(to))return;
  fs.mkdirSync(path.dirname(to),{recursive:true});
  fs.cpSync(from,to,{recursive:true,filter:p=>!p.split(path.sep).includes('__pycache__')});
  receipts.push({source:from,target:to});
}
for(const dir of ['server','ui','public'])copy(path.join(candidate,dir),path.join(root,dir));
for(const file of ['package.json','package-lock.json','index.html','tsconfig.json','vite.config.ts','config.example.json','requirements.lock']){
  if(fs.existsSync(path.join(candidate,file)))copy(path.join(candidate,file),path.join(root,file));
}
for(const dir of ['.runtime/node-home','.runtime/python-home','.python'])copy(path.join(old,dir),path.join(root,dir));
copy(path.join(candidate,'vendor/pi-repl-py'),path.join(root,'vendor/pi-repl-py'));
for(const dir of ['.local','validation','workspace','docs','tests','desktop'])fs.mkdirSync(path.join(root,dir),{recursive:true});
// Relocate the preserved venv, without executing or altering the old installation.
const venv=path.join(root,'.python/pyvenv.cfg');
fs.writeFileSync(venv,fs.readFileSync(venv,'utf8').replace(/^home = .*$/m,`home = ${path.join(root,'.runtime/python-home')}`).replace(/^executable = .*$/m,`executable = ${path.join(root,'.runtime/python-home/python.exe')}`));
// Credentials are consumed locally for the user's existing providers only.
// No values are emitted, sent to research providers or copied into evidence.
const previous=read(path.join(old,'astra.config.json'));
const state=path.resolve(old,previous.stateDir||'.runtime/state');
const overlay=read(path.join(state,'connections.credentials.json'));
const external=read(path.resolve(old,previous.credentialsFile||'.runtime/state/credentials.json'));
const s=read(path.join(candidate,'config.example.json'));
s.port=3320;s.defaultWorkspace=path.join(root,'workspace');
s.budgetTokens=previous.budget?.usageTokens||3000000;
s.roots=[{alias:'code',path:path.dirname(root)},{alias:'quant-foundry',path:'E:\\quant_foundry'},{alias:'quant-g',path:'G:\\quant'}];
const keys={};
for(const role of ['principal','executor','auxiliary']){
  const m={...previous.roles?.[role],...overlay.roles?.[role]};
  const c=overlay.providers?.[m.credentialProvider]||external.providers?.[m.credentialProvider];
  if(!c?.api_key||!c?.base_url)throw new Error(`Configured ${role} connection is incomplete; no credential values printed.`);
  const model=s.models[role];
  for(const field of ['model','api','thinking','maxOutputTokens','contextWindow','requestTimeoutSeconds'])if(m[field]!==undefined)model[field]=m[field];
  model.baseUrl=c.base_url;model.concurrency=role==='principal'?1:role==='executor'?Math.max(10,Math.min(20,m.concurrency||12)):Math.max(1,Math.min(8,m.concurrency||4));
  keys[role]=c.api_key;
}
s.roles=[{name:'实现',count:s.models.executor.concurrency,instructions:'独立完成分配模块、必要的测试和原始资料调查，提交实际运行证据。文件所有权由任务 DAG 分配；不得修改其他岗位文件。'}];
s.presets=[{id:'parallel',name:'并行开发',executor:s.models.executor.concurrency,auxiliary:s.models.auxiliary.concurrency,roles:structuredClone(s.roles)},
  {id:'balanced',name:'均衡 · 开发 / 测试 / 研究',executor:12,auxiliary:4,roles:[{name:'开发',count:6,instructions:'实现独立模块及本模块验证。'},{name:'测试',count:3,instructions:'实现独立测试、接口契约与边界反例。'},{name:'研究',count:3,instructions:'调查原始资料、依赖与兼容性，提交带来源的真实证据。'}]},
  {id:'wide',name:'广泛并行 · 20 / 8',executor:20,auxiliary:8,roles:[{name:'实现',count:20,instructions:s.roles[0].instructions}]}];
s.activePreset='parallel';
for(const [name,data] of [['settings.json',s],['credentials.json',keys]]){
  const file=path.join(root,'.local',name);
  if(!fs.existsSync(file))fs.writeFileSync(file,JSON.stringify(data,null,2)+'\n');
}
const report={at:new Date().toISOString(),command:process.argv,cwd:process.cwd(),environment:{node:process.version,platform:process.platform,arch:process.arch},
  reused:receipts,node:{sha256:hash(path.join(root,'.runtime/node-home/node.exe')),matchesLegacy:hash(path.join(root,'.runtime/node-home/node.exe'))===hash(path.join(old,'.runtime/node-home/node.exe'))},
  models:Object.fromEntries(Object.entries(s.models).map(([role,m])=>[role,{model:m.model,api:m.api,concurrency:m.concurrency}])),
  credentialsPresent:Object.fromEntries(Object.keys(keys).map(k=>[k,Boolean(keys[k])])),status:'BOOTSTRAPPED_NOT_VERIFIED',exitCode:0};
fs.writeFileSync(path.join(root,'validation/bootstrap.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));

