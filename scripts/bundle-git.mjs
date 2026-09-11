import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {APP_ROOT,ensureDir,sha,now,uid,writeJSON,atomicWrite} from '../server/util.mjs';

const version='2.55.0.5',tag='v2.55.0.windows.5';
const archiveName=`MinGit-${version}-64-bit.zip`;
const expectedSha256='56d7b226b7693196cfc71fef26568f536c4a021ab6c37ff2db4287bed908e96e';
const url=`https://github.com/git-for-windows/git/releases/download/${tag}/${archiveName}`;
function verify(directory){
  const executable=path.join(directory,'cmd/git.exe');
  const r=spawnSync(executable,['--version'],{encoding:'utf8',windowsHide:true,timeout:15000});
  return {command:[executable,'--version'],stdout:r.stdout||'',stderr:r.stderr||'',exitCode:r.status,error:r.error?.message,ok:r.status===0&&r.stdout.includes('2.55.0.windows.5')};
}
export async function ensureGitRuntime(directory=path.join(APP_ROOT,'.runtime/git')){
  const record={started:now(),command:process.argv,cwd:APP_ROOT,source:url,release:tag,expectedSha256,environment:{node:process.version,platform:process.platform},directory,exitCode:null};
  let staging;
  try{
    if(fs.existsSync(directory)){
      record.verification=verify(directory);
      if(!record.verification.ok)throw new Error('Existing bundled Git is incomplete or invalid. It has not been overwritten; stop the application before repairing its runtime.');
    }else{
      const archive=path.join(ensureDir(path.join(APP_ROOT,'.runtime/downloads')),archiveName);
      if(!fs.existsSync(archive)){
        const response=await fetch(url,{signal:AbortSignal.timeout(180000),headers:{'User-Agent':'pi-loop-studio-runtime-installer'}});
        if(!response.ok)throw new Error(`Official MinGit download HTTP ${response.status}`);
        const bytes=Buffer.from(await response.arrayBuffer());
        if(sha(bytes)!==expectedSha256)throw new Error('Downloaded MinGit archive failed SHA256 verification');
        atomicWrite(archive,bytes);
      }
      record.archiveSha256=sha(fs.readFileSync(archive));
      if(record.archiveSha256!==expectedSha256)throw new Error('Cached MinGit archive failed SHA256 verification');
      staging=ensureDir(directory+`.staging-${uid()}`);
      const quote=s=>"'"+s.replaceAll("'","''")+"'";
      const command=`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(staging)} -Force`;
      const result=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',windowsHide:true,timeout:180000});
      record.extraction={command,stdout:result.stdout||'',stderr:result.stderr||'',exitCode:result.status,error:result.error?.message};
      if(result.status!==0)throw new Error(result.error?.message||result.stderr||'MinGit extraction failed');
      record.stagedVerification=verify(staging);if(!record.stagedVerification.ok)throw new Error('Staged MinGit verification failed; no runtime was published');
      writeJSON(path.join(staging,'RUNTIME-PROVENANCE.json'),{package:'MinGit',version:tag,source:url,archiveSha256:expectedSha256,gitExeSha256:sha(fs.readFileSync(path.join(staging,'cmd/git.exe')))});
      // A verified complete directory wins concurrent installation. The git
      // wrapper is never exposed before its supporting DLLs are in place.
      try{fs.renameSync(staging,directory);staging=null;}
      catch(error){const winner=verify(directory);if(!winner.ok)throw error;record.concurrentWinner=winner;fs.rmSync(staging,{recursive:true,force:true});staging=null;}
      record.verification=verify(directory);if(!record.verification.ok)throw new Error('Published Git runtime verification failed');
    }
    record.gitExeSha256=sha(fs.readFileSync(path.join(directory,'cmd/git.exe')));record.exitCode=0;
  }catch(error){record.exitCode=1;record.error=error.stack;if(staging)record.unpublishedStaging=staging;}
  record.finished=now();const file=path.join(APP_ROOT,'validation',`git-runtime-${Date.now()}-${uid().slice(0,8)}.json`);writeJSON(file,record);
  return {...record,receipt:file};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const record=await ensureGitRuntime();console.log(JSON.stringify(record,null,2));process.exitCode=record.exitCode;}

