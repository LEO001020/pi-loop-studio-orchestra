import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { APP_ROOT,ensureDir,uid,LoopError,checkAbort } from './util.mjs';
import { childEnvironment,taskEnvironment,killTree } from './commands.mjs';
import { scrub } from './settings.mjs';

export class PythonKernel {
  pending=new Map();child=null;ready=null;
  constructor(store,runId,jobId,cwd,settings){Object.assign(this,{store,runId,jobId,cwd,settings});}
  async boot(signal){
    if(this.ready)return this.ready;checkAbort(signal);
    this.ready=new Promise((resolve,reject)=>{
      const runtime=ensureDir(path.join(this.cwd,'.pi-kernel'));
      this.store.event('python.starting',{jobId:this.jobId},this.runId);
      this.child=spawn(path.join(APP_ROOT,'.python/Scripts/python.exe'),['-X','utf8','-u',path.join(APP_ROOT,'vendor/pi-repl-py/bridge.py')],{cwd:this.cwd,env:childEnvironment({...taskEnvironment(this.cwd),JUPYTER_RUNTIME_DIR:runtime,IPYTHONDIR:runtime,PI_KERNEL_READY_SECONDS:String(this.settings.pythonStartupSeconds)}),windowsHide:true,stdio:['pipe','pipe','pipe']});
      let stderr='';let settled=false;
      const timer=setTimeout(()=>{killTree(this.child);reject(new LoopError('PYTHON_STARTUP_TIMEOUT',`Python 内核在 ${this.settings.pythonStartupSeconds} 秒内未就绪；其他会话与 UI 不受阻塞。`));},this.settings.pythonStartupSeconds*1000);
      const abort=()=>{killTree(this.child);reject(new LoopError('CANCELLED'));};signal?.addEventListener('abort',abort,{once:true});
      const clean=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
      this.child.stderr.on('data',b=>{stderr=(stderr+b.toString('utf8')).slice(-12000);});
      createInterface({input:this.child.stdout}).on('line',line=>{
        let m;try{m=JSON.parse(line);}catch{return;}
        if(m.type==='ready'){settled=true;clean();this.store.event('python.ready',{jobId:this.jobId},this.runId);resolve();return;}
        const p=this.pending.get(m.id);
        if(p){if(m.type==='stream'){p[m.name==='stderr'?'stderr':'stdout']+=m.text;}
          else if(['result','reply','error'].includes(m.type)){this.pending.delete(m.id);p.clean();p.resolve({...m,stdout:scrub(p.stdout),stderr:scrub(p.stderr)});}}
      });
      this.child.on('error',e=>{clean();reject(e);});
      this.child.on('exit',()=>{clean();this.ready=null;const e=new LoopError('PYTHON_EXIT',scrub(stderr||'Python 内核已退出'));if(!settled)reject(e);for(const p of this.pending.values()){p.clean();p.reject(Object.assign(new LoopError('PYTHON_EXIT',e.message),{effectUnknown:true,stdout:scrub(p.stdout),stderr:scrub(p.stderr)}));}this.pending.clear();});
      this.child.stdin.on('error',()=>{});
      this.child.stdin.write(JSON.stringify({op:'boot',helpers:[]})+'\n');
    });
    try{return await this.ready;}catch(e){this.ready=null;throw e;}
  }
  async exec(code,signal){await this.boot(signal);checkAbort(signal);const id=uid();
    return new Promise((resolve,reject)=>{
      const stop=error=>{const pending=this.pending.get(id);killTree(this.child);this.pending.delete(id);clean();reject(Object.assign(error,{effectUnknown:true,stdout:scrub(pending?.stdout||''),stderr:scrub(pending?.stderr||'')}));};
      const abort=()=>stop(new LoopError('CANCELLED','已停止 Python 单元；中断前副作用结果未知。'));
      const timer=setTimeout(()=>stop(new LoopError('PYTHON_CELL_TIMEOUT','Python 执行超时；结果未知，不自动重放该代码。')),this.settings.pythonCellTimeoutSeconds*1000);
      const clean=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
      this.pending.set(id,{resolve,reject,stdout:'',stderr:'',clean});signal?.addEventListener('abort',abort,{once:true});
      this.child.stdin.write(JSON.stringify({op:'exec',id,code})+'\n');
    });
  }
  async close(){if(!this.child||this.child.exitCode!==null)return;const child=this.child;await new Promise(resolve=>{const timer=setTimeout(()=>{killTree(child);resolve();},3000);child.once('exit',()=>{clearTimeout(timer);resolve();});try{child.stdin.end(JSON.stringify({op:'shutdown',id:uid()})+'\n');}catch{killTree(child);resolve();}});}
}
