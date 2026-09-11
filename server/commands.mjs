import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { APP_ROOT,LOCAL,uid,now,ensureDir,LoopError,checkAbort } from './util.mjs';
import { scrub } from './settings.mjs';

export function childEnvironment(extra={}) {
  const replaced=new Set(Object.keys(extra).map(k=>k.toUpperCase()));
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/TOKEN|SECRET|API.?KEY|PASSWORD|BEARER/i.test(k)&&!replaced.has(k.toUpperCase())));
  env.PATH=[...(extra.PIP_TARGET?[path.join(extra.PIP_TARGET,'Scripts'),path.join(extra.PIP_TARGET,'bin')]:[]),...(extra.npm_config_prefix?[extra.npm_config_prefix]:[]),path.join(APP_ROOT,'.runtime/git/cmd'),path.join(APP_ROOT,'.runtime/node-home'),path.join(APP_ROOT,'.python/Scripts'),path.join(APP_ROOT,'.runtime/python-home'),env.PATH||env.Path||''].join(path.delimiter);
  delete env.Path;delete env.PYTHONHOME;delete env.NODE_TEST_CONTEXT;
  return {...env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',GIT_TERMINAL_PROMPT:'0',PIP_DISABLE_PIP_VERSION_CHECK:'1',...extra};
}
/** Cooperative default dependency isolation, not an OS security sandbox. */
export function taskEnvironment(cwd){
  const dependencies=ensureDir(path.join(cwd,'.pi-deps'));
  return {PIP_TARGET:dependencies,PYTHONPATH:dependencies,PYTHONNOUSERSITE:'1',npm_config_prefix:ensureDir(path.join(cwd,'.pi-npm-prefix')),
    PI_LOOP_WORKTREE:path.resolve(cwd),NODE_PATH:'',NODE_OPTIONS:`--import=${pathToFileURL(path.join(APP_ROOT,'server/node-task-hooks.mjs')).href}`,
    GIT_CONFIG_COUNT:'2',GIT_CONFIG_KEY_0:'core.hooksPath',GIT_CONFIG_VALUE_0:path.join(APP_ROOT,'.runtime/git/disabled-hooks'),GIT_CONFIG_KEY_1:'commit.gpgSign',GIT_CONFIG_VALUE_1:'false'};
}
export function killTree(child) {
  if(!child?.pid||child.exitCode!==null)return;
  if(process.platform==='win32'){const p=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});p.on('error',()=>child.kill());}
  else{try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
}
export function executeProcess(executable,args,{cwd,signal,timeout=180,env,onData,input}={}) {
  checkAbort(signal);const started=now(),start=Date.now();
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{cwd,env:childEnvironment(env),windowsHide:true,detached:process.platform!=='win32',stdio:[input===undefined?'ignore':'pipe','pipe','pipe']});
    if(child.stdin){child.stdin.on('error',()=>{});child.stdin.end(input);}
    let stdout='',stderr='',stdoutBytes=0,stderrBytes=0,timedOut=false,aborted=false;const out=new StringDecoder('utf8'),err=new StringDecoder('utf8');
    const cap=2*1024*1024;
    child.stdout.on('data',b=>{stdoutBytes+=b.length;const s=out.write(b);stdout=(stdout+s).slice(-cap);onData?.(b,'stdout');});
    child.stderr.on('data',b=>{stderrBytes+=b.length;const s=err.write(b);stderr=(stderr+s).slice(-cap);onData?.(b,'stderr');});
    const abort=()=>{aborted=true;killTree(child);};signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{timedOut=true;killTree(child);},timeout*1000);
    const clean=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    child.once('error',e=>{clean();reject(e);});
    child.once('close',(exitCode,exitSignal)=>{clean();resolve({command:[executable,...args],cwd,started,ended:now(),durationMs:Date.now()-start,exitCode,signal:exitSignal,stdout:scrub(stdout+out.end()),stderr:scrub(stderr+err.end()),stdoutBytes,stderrBytes,truncated:stdoutBytes>cap||stderrBytes>cap,timedOut,aborted,encoding:'utf-8',environment:{platform:process.platform,arch:process.arch,node:process.version,pythonPackageTarget:env?.PIP_TARGET||null,npmGlobalPrefix:env?.npm_config_prefix||null}});});
  });
}
export async function shellCommand(store,runId,jobId,command,cwd,{signal,timeout=180,onData,id=uid(),allowReplay=false}={}) {
  if(store.hasUnresolvedEffects(runId))throw new LoopError('EFFECT_UNKNOWN','原生命令的结果仍未知，未再执行命令；请先处理回执。');
  const effectId=`${jobId}:${id}`,prior=store.effect(effectId);
  if(prior?.status==='completed'){
    if(prior.aborted)throw new LoopError('CANCELLED','此前执行已停止，不能把未知结果视为成功');
    if(prior.timedOut)throw new LoopError('COMMAND_TIMEOUT','此前执行超时，不能自动把该回执视为成功');
    return prior;
  }
  if(['running','unknown'].includes(prior?.status)&&!allowReplay)throw new LoopError('EFFECT_UNKNOWN','上一次原生命令的结束状态未知；不会静默重放有副作用的命令。请在任务回执中处理后继续。');
  store.putEffect({id:effectId,runId,jobId,command,cwd,started:now(),status:'running'});
  const exe=process.platform==='win32'?path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'):'/bin/sh';
  const script=process.platform==='win32'?`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; ${command}\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`:command;
  try{
    const r=await executeProcess(exe,process.platform==='win32'?['-NoLogo','-NoProfile','-NonInteractive','-Command',script]:['-c',script],{cwd,signal,timeout,onData,env:taskEnvironment(cwd)});
    const effect={...r,id:effectId,runId,jobId,command,argv:r.command,status:r.aborted||r.timedOut?'unknown':'completed'};store.putEffect(effect);
    if(r.aborted)throw new LoopError('CANCELLED','命令已停止');
    if(r.timedOut)throw new LoopError('EFFECT_UNKNOWN',`命令超过 ${timeout} 秒，已终止其进程树；副作用结果未知，回执保留。`);
    return effect;
  }catch(e){if(store.effect(effectId)?.status==='running')store.putEffect({...store.effect(effectId),status:'failed',ended:now(),error:scrub(e.message),exitCode:null});throw e;}
}
export async function git(args,cwd,signal,{input}={}){
  const fixed=['-c',`core.hooksPath=${path.join(APP_ROOT,'.runtime/git/disabled-hooks')}`,'-c','commit.gpgSign=false','-c','core.autocrlf=false'];
  const r=await executeProcess('git',[...fixed,...args],{cwd,signal,input,timeout:180});
  if(r.exitCode!==0)throw new LoopError('GIT_ERROR',r.stderr||r.stdout);return r.stdout.trim();
}
