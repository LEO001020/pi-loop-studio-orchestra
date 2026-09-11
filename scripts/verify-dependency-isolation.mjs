import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {APP_ROOT,uid,now,ensureDir,writeJSON,sha} from '../server/util.mjs';
import {Store} from '../server/store.mjs';
import {loadSettings} from '../server/settings.mjs';
import {shellCommand,executeProcess,taskEnvironment} from '../server/commands.mjs';
import {PythonKernel} from '../server/python.mjs';

const directory=ensureDir(path.join(APP_ROOT,'validation',`dependency-isolation-${uid()}`));
const report={started:now(),command:process.argv,cwd:APP_ROOT,environment:{node:process.version,platform:process.platform},kind:'REAL_NATIVE_DEPENDENCY_ISOLATION_NO_MODELS',downloads:[],workers:[],exitCode:null};
const store=new Store(':memory:'),settings=loadSettings(),python=path.join(APP_ROOT,'.python/Scripts/python.exe');
const sharedFile=path.join(APP_ROOT,'.python/Lib/site-packages/colorama/__init__.py'),baseline=sha(fs.readFileSync(sharedFile));
const kernels=[];
const {redact}=createRequire(import.meta.url)(path.join(APP_ROOT,'.runtime/node-home/node_modules/npm/node_modules/@npmcli/redact/lib/index.js'));
try{
  for(const [version,expected] of [['0.4.5','854bf444933e37f5824ae7bfc1e98d5bce2ebe4160d46b5edf346a89358e99da'],['0.4.6','4f1d9991f5acc0ca119f9d443620b77f9d6b33703e51011c16baf57afb285fc6']]){
    const metadataUrl=`https://pypi.org/pypi/colorama/${version}/json`,filename=`colorama-${version}-py2.py3-none-any.whl`;
    const cachedFile=path.join(APP_ROOT,'tests/fixtures/wheels',filename);let bytes,url,cached=fs.existsSync(cachedFile);
    if(cached)bytes=fs.readFileSync(cachedFile);
    else{
      const response=await fetch(metadataUrl,{signal:AbortSignal.timeout(30000)});assert(response.ok);const metadata=await response.json();
      const wheel=metadata.urls.find(f=>f.filename===filename);assert(wheel);assert.equal(wheel.digests.sha256,expected);url=wheel.url;
      const responseWheel=await fetch(url,{signal:AbortSignal.timeout(30000)});assert(responseWheel.ok);bytes=Buffer.from(await responseWheel.arrayBuffer());
    }
    assert.equal(sha(bytes),expected,'The test fixture must match the previously audited PyPI digest');
    const file=path.join(directory,filename);fs.writeFileSync(file,bytes);report.downloads.push({version,metadataUrl,url:url||null,cached,cachedFile:cached?cachedFile:null,file,sha256:sha(bytes),bytes:bytes.length});
  }
  const results=await Promise.allSettled(report.downloads.map(async wheel=>{
    const cwd=ensureDir(path.join(directory,`岗位-${wheel.version}`)),s=store.createSession(cwd),run=store.createRun(s.id,'Dependency isolation fixture',settings);
    const quote=s=>"'"+s.replaceAll("'","''")+"'";
    // No --target is supplied here. The production command adapter must set
    // its safe default even for an ordinary model-issued pip install.
    const installed=await shellCommand(store,run.id,'dependency-install',`python -m pip install --no-deps --no-index ${quote(wheel.file)}`,cwd,{timeout:120});assert.equal(installed.exitCode,0,installed.stderr);
    const checked=await executeProcess(python,['-X','utf8','-c',`import colorama; assert colorama.__version__ == '${wheel.version}'; print(colorama.__version__); print(colorama.__file__)`],{cwd,env:taskEnvironment(cwd),timeout:30});assert.equal(checked.exitCode,0,checked.stderr);assert(checked.stdout.includes(path.join(cwd,'.pi-deps')));
    const kernel=new PythonKernel(store,run.id,'dependency-kernel',cwd,settings);kernels.push(kernel);
    const cell=await kernel.exec(`import colorama\nassert colorama.__version__ == '${wheel.version}'\nprint(colorama.__version__)\nprint(colorama.__file__)`);assert.equal(cell.status,'ok',JSON.stringify(cell));assert(cell.stdout.includes(path.join(cwd,'.pi-deps')));
    const npm=await shellCommand(store,run.id,'npm-prefix','npm prefix -g',cwd,{timeout:30});assert.equal(npm.exitCode,0,npm.stderr);
    // The installed npm CLI deliberately masks UUIDs in stdout. Compare its
    // documented implementation's display format, then verify a real install
    // at the unredacted location rather than inferring location from display.
    assert.equal(npm.stdout.trim(),redact(path.join(cwd,'.pi-npm-prefix')));
    const fixture=ensureDir(path.join(cwd,'.pi-npm-fixture')),name='pi-loop-dependency-isolation-fixture';
    writeJSON(path.join(fixture,'package.json'),{name,version:wheel.version,private:true});
    const npmInstall=await shellCommand(store,run.id,'npm-global-install','npm install --global --offline --ignore-scripts --no-audit --no-fund ./.pi-npm-fixture',cwd,{timeout:90});assert.equal(npmInstall.exitCode,0,npmInstall.stderr);
    const installedPackage=JSON.parse(fs.readFileSync(path.join(cwd,'.pi-npm-prefix/node_modules',name,'package.json'),'utf8'));assert.equal(installedPackage.version,wheel.version);
    assert(!fs.existsSync(path.join(APP_ROOT,'.runtime/node-home/node_modules',name)),'A task modified the shared Node runtime');
    return {version:wheel.version,cwd,installed,checked,cell,npm,npmInstall};
  }));
  report.workers=results.map(r=>r.status==='fulfilled'?{ok:true,...r.value}:{ok:false,error:r.reason?.stack||String(r.reason)});
  assert(report.workers.every(w=>w.ok),JSON.stringify(report.workers.filter(w=>!w.ok)));
  report.sharedRuntime={file:sharedFile,before:baseline,after:sha(fs.readFileSync(sharedFile))};assert.equal(report.sharedRuntime.after,baseline);
  report.exitCode=0;report.status='VERIFIED_SEPARATE_DEPENDENCY_TARGETS';
}catch(e){report.exitCode=1;report.status='FAILED';report.error=e.stack;}
finally{await Promise.allSettled(kernels.map(k=>k.close()));store.close();}
report.finished=now();writeJSON(path.join(directory,'receipt.json'),report);console.log(JSON.stringify({status:report.status,workers:report.workers.map(w=>({ok:w.ok,version:w.version,cwd:w.cwd,error:w.error})),sharedRuntime:report.sharedRuntime,error:report.error,exitCode:report.exitCode,receipt:path.join(directory,'receipt.json')},null,2));process.exitCode=report.exitCode;
