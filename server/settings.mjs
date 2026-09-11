import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { APP_ROOT, LOCAL, ensureDir, readJSON, writeJSON, LoopError, inside, portablePath } from './util.mjs';

const role = z.object({ name:z.string().min(1).max(80), count:z.number().int().min(0).max(20), instructions:z.string().max(12000) });
const model = z.object({ model:z.string().min(1), api:z.enum(['openai-responses','openai-completions']), thinking:z.enum(['off','minimal','low','medium','high','xhigh','max']), maxOutputTokens:z.number().int().min(256).max(262144), contextWindow:z.number().int().min(4096).max(4000000), concurrency:z.number().int().min(1).max(20), baseUrl:z.string().refine(v=>{try{const u=new URL(v);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash;}catch{return false;}},'需要 HTTP(S) API 地址'), requestTimeoutSeconds:z.number().int().min(10).max(3600) });
export const settingsSchema = z.object({
  version:z.literal(2), port:z.number().int().min(1024).max(65535), budgetTokens:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  models:z.object({principal:model,executor:model,auxiliary:model}), roots:z.array(z.object({alias:z.string().regex(/^[\w-]+$/),path:z.string().min(1)})).min(1), defaultWorkspace:z.string().min(1),
  presets:z.array(z.object({id:z.string().min(1),name:z.string().min(1),executor:z.number().int().min(10).max(20),auxiliary:z.number().int().min(1).max(8),roles:z.array(role).min(1)})), activePreset:z.string(),roles:z.array(role).min(1),
  maxRepairRounds:z.number().int().min(0).max(8), maxAgentTurns:z.number().int().min(1).max(1000),commandTimeoutSeconds:z.number().int().min(5).max(3600),pythonStartupSeconds:z.number().int().min(10).max(300),pythonCellTimeoutSeconds:z.number().int().min(5).max(3600),
  snapshotMaxMiB:z.number().int().min(16).max(16384),snapshotMaxFiles:z.number().int().min(100).max(500000),excludeDirectories:z.array(z.string().min(1)),verificationCommands:z.array(z.string().min(1)),
  generatedDirectories:z.array(z.string().refine(v=>{try{return Boolean(portablePath(v));}catch{return false;}},'构建输出须为非空相对目录，不能是通配符或上级目录')).default(['dist','build','coverage','.pytest_cache','.mypy_cache','.ruff_cache']),
  research:z.object({enabled:z.boolean(),searchUrl:z.string().min(1),mcpUrl:z.string().url().default('https://mcp.exa.ai/mcp'),maxSourceBytes:z.number().int().min(65536).max(20000000).default(5242880),fetchTimeoutSeconds:z.number().int().min(5).max(180)}),theme:z.enum(['dark','light','system']),autoResume:z.boolean(),
  context:z.object({enabled:z.boolean().default(true),triggerRatio:z.number().min(0.25).max(0.9).default(0.7),keepRecentTokens:z.number().int().min(1024).max(65536).default(16000),summaryMaxTokens:z.number().int().min(1024).max(16384).default(4096)}).default({enabled:true,triggerRatio:0.7,keepRecentTokens:16000,summaryMaxTokens:4096})
}).superRefine((s,ctx)=>{
  const add=message=>ctx.addIssue({code:'custom',message});
  if(s.models.principal.concurrency!==1)add('GLM-5.3 主席位必须为 1');
  if(s.models.executor.concurrency<10||s.models.executor.concurrency>20)add('Gemini 执行席位必须在 10–20');
  if(s.models.auxiliary.concurrency>8)add('GLM Flash 辅助席位必须在 1–8');
  if(s.roles.reduce((n,r)=>n+r.count,0)!==s.models.executor.concurrency)add('岗位数量之和必须等于执行席位数');
  for(const p of s.presets)if(p.roles.reduce((n,r)=>n+r.count,0)!==p.executor)add(`预设「${p.name}」的岗位数量与执行席位不一致`);
  if(new Set(s.roots.map(r=>r.alias)).size!==s.roots.length)add('工作根目录别名不能重复');
  if(new Set(s.roles.map(r=>r.name.trim().toLowerCase())).size!==s.roles.length)add('岗位名称不能重复');
  if(s.roles.some(r=>!r.name.trim()))add('岗位名称不能为空白');
  if(new Set(s.presets.map(p=>p.id)).size!==s.presets.length)add('预设 ID 不能重复');
  for(const p of s.presets)if(new Set(p.roles.map(r=>r.name.trim().toLowerCase())).size!==p.roles.length)add(`预设「${p.name}」含重复岗位名称`);
});
const file=path.join(LOCAL,'settings.json'), secretFile=path.join(LOCAL,'credentials.json');
export function loadSettings(){ const raw=readJSON(file,readJSON(path.join(APP_ROOT,'config.example.json'),null)); if(!raw)throw new LoopError('NOT_CONFIGURED','请运行 Install.cmd 或提供 config.example.json'); return settingsSchema.parse(raw); }
export function credentials(){return readJSON(secretFile,{});}
export function publicSettings(){const c=credentials();return {...loadSettings(),credentialStatus:Object.fromEntries(['principal','executor','auxiliary','research'].map(r=>[r,Boolean(c[r])]))};}
export function saveSettings(input){const s=settingsSchema.parse(input);ensureDir(LOCAL);writeJSON(file,s);return publicSettings();}
export function saveCredentials(input){const c=credentials();for(const r of ['principal','executor','auxiliary','research'])if(typeof input[r]==='string'&&input[r].trim()){if(/[\r\n\0]/.test(input[r])||input[r].length>8192)throw new LoopError('INVALID_KEY','凭据格式无效');c[r]=input[r].trim();}writeJSON(secretFile,c);return Object.fromEntries(Object.entries(c).map(([r,v])=>[r,Boolean(v)]));}
export function scrub(value){let text=typeof value==='string'?value:JSON.stringify(value);for(const key of Object.values(credentials()))if(typeof key==='string'&&key.length>4)text=text.split(key).join('[REDACTED]');return text.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi,'Bearer [REDACTED]');}
export function resolveWorkspace(value, settings=loadSettings()){
  let resolved=value;
  for(const r of settings.roots)if(value===r.alias||value.startsWith(r.alias+'/')||value.startsWith(r.alias+'\\')){resolved=path.join(r.path,value.slice(r.alias.length));break;}
  resolved=path.resolve(resolved);
  if(!settings.roots.some(r=>inside(r.path,resolved))&&!inside(path.join(APP_ROOT,'workspace'),resolved))throw new LoopError('WORKSPACE_NOT_CONFIGURED','在设置中添加该磁盘根目录后再选择工作区');
  if(inside(LOCAL,resolved)||inside(resolved,APP_ROOT))throw new LoopError('PRIVATE_WORKSPACE','请选择具体项目目录，不能把包含运行中应用的上级目录或内部状态目录作为任务工作区');
  return resolved;
}
