// A new task exercises the final loaded engine. Never re-submit on --run.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {APP_ROOT,ensureDir,uid,writeJSON,now} from '../server/util.mjs';
import {loadSettings} from '../server/settings.mjs';

const settings=loadSettings(),base=`http://127.0.0.1:${settings.port}`;
const i=process.argv.indexOf('--run');let runId=i>=0?process.argv[i+1]:undefined;
if(!runId){
  const id=uid(),workspace=ensureDir(path.join(APP_ROOT,'workspace',`text-contracts-${id}`));
  const content=`为本地文本导入流程实现零依赖 Node ESM 字符串标准化库。规格已经完整，不需要联网检索语言基础事实。只读取本地 TASK.md 并按契约实现，不添加其他功能。十个模块完全独立，可同一批并行实现，每个岗位拥有一个模块和其测试。隔离、独立审核与发布由宿主提供，不再搭建工作树或编排器。
每个 src/<name>.mjs 只命名导出同名函数，所有函数首先检查输入是否 typeof === 'string'，否则抛 TypeError。不得静默转换输入。十个函数如下：
stripBom(s)：只删除开头一个 U+FEFF；normalizeNewlines(s)：将 CRLF 和单独 CR 全部转换为 LF；trimAscii(s)：只删除两端的 ASCII 空格和 tab，保留换行；collapseSpaces(s)：每段一个或多个 ASCII 空格变成单个空格，保留 tab 和换行；removeNul(s)：删除所有 U+0000；ensureFinalLf(s)：结尾已有 LF 则不变，否则加一个 LF（空字符串变成 LF）；escapeHtml(s)：依次把 & < > 双引号 单引号 转为 &amp; &lt; &gt; &quot; &#39;；countLines(s)：空串为0，其他字符串为 LF 数量加1（尾 LF 也新增一行）；headLine(s)：返回第一个 LF 之前的文本，没有 LF 返回原文；toAsciiLower(s)：只把 ASCII A-Z 变为 a-z，其他 Unicode 不变。
每个函数有 test/<name>.test.mjs，使用 node:test 与 node:assert/strict，至少6个测试，涵盖空串、典型情况、中文或边界、非法类型。共至少60个测试，绝不可跳过测试。使用 Unicode 转义明确 BOM/CR/LF/NUL。提供 package.json（type=module，scripts.test=node --test）及中文 README.md，必须与实现契约一致。最终运行 node --test 与 npm test，记录真实输出。
报告仅陈述有证据的结论、实际路径和未验证项；规格是全部验收要求。不要展开无关调研、重复验证普通语言规范、创建额外抽象或超过任务需要的文档。`;
  fs.writeFileSync(path.join(workspace,'TASK.md'),content,'utf8');
  async function post(url,body){const r=await fetch(base+'/api'+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});const d=await r.json();if(!r.ok)throw new Error(JSON.stringify(d));return d;}
  const s=await post('/sessions',{workspace,title:'最终源码 · 文本契约真实回归'});
  const d=await post(`/sessions/${s.id}/messages`,{content,mode:'task',budget:5000000,requestId:id});runId=d.run.id;
  writeJSON(path.join(APP_ROOT,'validation','final-live-identity.json'),{runId,sessionId:s.id,workspace,requestId:id,created:now(),kind:'REAL_FINAL_ENGINE_REGRESSION'});
  console.log(JSON.stringify({runId,sessionId:s.id,workspace}));
}
const child=spawn(process.execPath,[path.join(APP_ROOT,'scripts/live-acceptance.mjs'),'--run',runId,'--watch-seconds','480'],{cwd:APP_ROOT,stdio:'inherit',windowsHide:true});
child.on('error',e=>{console.error(e.message);process.exitCode=1;});
child.on('close',code=>{process.exitCode=code??1;});
