// Real-model regression on an existing dependency-using, built Node project.
// All tests/build/lockfiles are prepared and hashed before the agents run.
// No existing user task is resubmitted. A saved identity is reused on rerun.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {APP_ROOT,uid,now,ensureDir,readJSON,writeJSON,sha} from '../server/util.mjs';
import {loadSettings} from '../server/settings.mjs';
import {executeProcess,taskEnvironment} from '../server/commands.mjs';

const identityFile=path.join(APP_ROOT,'validation/c3-live-project-identity.json');
const previous=readJSON(identityFile,null);
if(previous){console.log(JSON.stringify({reused:true,...previous},null,2));process.exit(0);}
const id=uid(),workspace=ensureDir(path.join(APP_ROOT,'workspace',`validator-project-${id}`));
const record={kind:'REAL_MODEL_EXISTING_PROJECT_WITH_DEPENDENCY_AND_BUILD',created:now(),workspace,steps:[],protectedFiles:{},status:'PREPARING'};
const spec=[
  ['port','整数 1..65535，不接受字符串或非有限数', '[1,65535,8080]', '[0,65536,1.5,"80",null,NaN]'],
  ['retryCount','整数 0..10，不接受字符串', '[0,1,10]', '[-1,11,0.5,"1",null,Infinity]'],
  ['timeoutMs','整数 1..300000，不接受字符串', '[1,300000,5000]', '[0,300001,1.5,"100",null,NaN]'],
  ['serviceName','ASCII 小写字母开头，其后小写字母、数字或连字符，总长1..32，不自动 trim', '["a","api-v2","worker"]', '["","1api","Api","api_2"," a", "a".repeat(33)]'],
  ['hexColor','字符串必须为 # 加六个十六进制字符，大小写均允许，原样返回', '["#000000","#aBcDeF","#123456"]', '["000000","#fff","#12345g"," #abcdef",123456,null]'],
  ['slug','1..40 字符，形如小写字母/数字单词用单个连字符连接，不接受首尾/连续连字符', '["abc","a-1","123"]', '["","-abc","abc-","a--b","A","x".repeat(41)]'],
  ['ratio','有限数 0..1，允许小数，不接受字符串', '[0,1,0.25]', '[-0.1,1.1,NaN,Infinity,"0.5",null]'],
  ['status','仅允许 queued、running、done 三个字符串', '["queued","running","done"]', '["","failed","Done",0,null,undefined]'],
  ['nonEmptyText','字符串经 trim 后长度1..100，返回 trim 后的字符串', '["a","中文","x".repeat(100)]', '["","   ","x".repeat(101),1,null,undefined]'],
  ['labels','长度1..5的字符串数组，每项1..12个ASCII小写字母，不允许重复项，不修改输入', '[["a"],["a","b"],["hello"]]', '[[],["a","a"],["A"],["a1"],Array(6).fill("a"),["x".repeat(13)]]']
];
async function command(exe,args,cwd=workspace){const r=await executeProcess(exe,args,{cwd,env:taskEnvironment(cwd),timeout:120});record.steps.push(r);return r;}
try{
  ensureDir(path.join(workspace,'src'));ensureDir(path.join(workspace,'test'));ensureDir(path.join(workspace,'vendor'));
  const zod=readJSON(path.join(APP_ROOT,'node_modules/zod/package.json'));
  const tar=await executeProcess('tar.exe',['-czf',path.join(workspace,'vendor/zod.tgz'),'-C',path.join(APP_ROOT,'node_modules'),'zod'],{cwd:APP_ROOT,timeout:60});record.steps.push(tar);assert.equal(tar.exitCode,0,tar.stderr);
  writeJSON(path.join(workspace,'package.json'),{name:'pi-validator-project',version:'1.0.0',type:'module',private:true,engines:{node:'>=24.13.1'},dependencies:{zod:'file:vendor/zod.tgz'},scripts:{build:'node build.mjs',test:'npm run build && node --test test/*.test.mjs'}});
  fs.writeFileSync(path.join(workspace,'build.mjs'),`import fs from 'node:fs';import path from 'node:path';import {stripTypeScriptTypes} from 'node:module';\nfs.mkdirSync('dist',{recursive:true});for(const file of fs.readdirSync('src').filter(f=>f.endsWith('.ts'))){const source=fs.readFileSync(path.join('src',file),'utf8');fs.writeFileSync(path.join('dist',file.replace(/\\.ts$/,'.mjs')),stripTypeScriptTypes(source));}\nconsole.log('Built 10 TypeScript modules with Node native type erasure (not a type-checker)');\n`);
  for(const [name,requirement,valid,invalid]of spec){
    fs.writeFileSync(path.join(workspace,'src',name+'.ts'),`// BUG: this validator currently returns every input without checking it.\nexport function parseValue(input: unknown): unknown { return input; }\n`);
    fs.writeFileSync(path.join(workspace,'test',name+'.test.mjs'),`import test from 'node:test';import assert from 'node:assert/strict';import {parseValue} from '../dist/${name}.mjs';\nconst valid=${valid};const invalid=${invalid};\nfor(const [i,v]of valid.entries())test('${name}: valid '+i,()=>{const copy=structuredClone(v);assert.deepEqual(parseValue(v),v);assert.deepEqual(v,copy)});\nfor(const [i,v]of invalid.entries())test('${name}: invalid '+i,()=>assert.throws(()=>parseValue(v)));\n${name==='nonEmptyText'?"test('trimmed output',()=>assert.equal(parseValue('  example  '),'example'));":''}\n`);
  }
  const instructions=`修复本项目已有的十个验证模块，仅修改 src/ 下对应 .ts 文件。每个文件导出 parseValue(input: unknown)。必须 import { z } from 'zod' 并使用 Zod schema.parse 实施验证，不手写替代框架。\n${spec.map(([n,r])=>`${n}.ts：${r}`).join('\n')}\n无效输入必须抛出错误，合法输入保持原值（nonEmptyText 返回 trim 后值）。不得修改输入数组。\npackage.json、package-lock.json、build.mjs、test/、vendor/ 和 TASK.md 均为既有验收基线，不得修改。原始测试已经存在，用它们定位问题，不需要重写测试。十个源码模块无相互依赖，必须至少十个执行岗位独立分工，避免串行实现。不得创建工作树或宿主调度器，它们已经提供。\n安装依赖使用 npm ci --offline --ignore-scripts --no-audit --no-fund（Zod ${zod.version} 的实际已安装包原文被归档为本项目 vendor/zod.tgz）。每个新工作树均需独立安装。测试使用 npm test；它会调用 Node 的原生 TypeScript 类型擦除 API 构建 dist，再运行固定测试，不是 tsc 类型检查。\n最终成功条件：原始 test/ 全部通过；全部源码真实使用 Zod；十个验证器满足契约；固定基线哈希不变；dist 为可再生产物而非手改源码，未分配产物不发布。`;
  fs.writeFileSync(path.join(workspace,'TASK.md'),instructions);
  fs.writeFileSync(path.join(workspace,'ZOD-API.md'),`项目锁定 Zod ${zod.version}，源码来源为随附 npm 安装包，许可证 MIT（在 vendor/zod.tgz 中）。入口：import { z } from 'zod'。数值 z.number().int().min(n).max(n)；字符串 z.string().min(n).max(n).regex(re)；trim 使用 z.string().trim()；枚举 z.enum([...])；数组 z.array(schema).min(n).max(n)；约束 schema.refine(value => ...)。使用 schema.parse(input)，无效时抛异常。此文档是接口线索，不是运行证明；请读源码或执行测试核对。\n`);
  const lock=await command(process.execPath,[path.join(APP_ROOT,'.runtime/node-home/node_modules/npm/bin/npm-cli.js'),'install','--package-lock-only','--offline','--ignore-scripts','--no-audit','--no-fund']);assert.equal(lock.exitCode,0,lock.stderr);
  const install=await command(process.execPath,[path.join(APP_ROOT,'.runtime/node-home/node_modules/npm/bin/npm-cli.js'),'ci','--offline','--ignore-scripts','--no-audit','--no-fund']);assert.equal(install.exitCode,0,install.stderr);
  const baseline=await command(process.execPath,[path.join(APP_ROOT,'.runtime/node-home/node_modules/npm/bin/npm-cli.js'),'test']);assert.notEqual(baseline.exitCode,0,'Seed must actually fail before agents repair it');
  // Do not snapshot failed build output as immutable source.
  fs.rmSync(path.join(workspace,'dist'),{recursive:true,force:true});
  for(const file of ['package.json','package-lock.json','build.mjs','TASK.md','ZOD-API.md','vendor/zod.tgz',...spec.map(([n])=>'test/'+n+'.test.mjs')])record.protectedFiles[file]=sha(fs.readFileSync(path.join(workspace,file)));
  const base=`http://127.0.0.1:${loadSettings().port}`;
  const request=async(url,body)=>{const r=await fetch(base+'/api'+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});const d=await r.json();if(!r.ok)throw new Error(JSON.stringify(d));return d;};
  const session=await request('/sessions',{workspace,title:'candidate.3 · 依赖与构建真实项目回归'});record.sessionId=session.id;
  const response=await request(`/sessions/${session.id}/messages`,{content:instructions,mode:'task',budget:loadSettings().budgetTokens,requestId:id});record.runId=response.run.id;record.status='SUBMITTED';
}catch(error){record.status='FAILED_TO_PREPARE_OR_SUBMIT';record.error=error.stack;process.exitCode=1;}
record.updated=now();writeJSON(identityFile,record);console.log(JSON.stringify({status:record.status,runId:record.runId,workspace,receipt:identityFile,error:record.error},null,2));
