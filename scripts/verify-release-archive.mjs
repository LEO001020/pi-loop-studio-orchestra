// Extract the actual distributable, not a hand-selected substitute directory.
// Evidence stays in release/ so it cannot invalidate the checksummed payload.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {APP_ROOT,ensureDir,readJSON,writeJSON,uid,sha,now} from '../server/util.mjs';
import {executeProcess} from '../server/commands.mjs';

const delivery=readJSON(path.join(APP_ROOT,'release/DELIVERY.json'));
const archive=delivery.archives.find(a=>a.kind==='win-x64');assert(archive,'No packaged Windows archive');
const dir=ensureDir(path.join(APP_ROOT,'release',`archive-check-${uid()}`));
const destination=ensureDir(path.join(dir,'中文 解压安装','Pi Loop Studio'));
const report={kind:'ACTUAL_DISTRIBUTABLE_EXTRACTION_AND_INSTALLATION',started:now(),command:process.argv,environment:{node:process.version,platform:process.platform,arch:process.arch},archive,destination,checks:[],exitCode:null};
async function command(name,executable,args,cwd,timeout=420){const r=await executeProcess(executable,args,{cwd,timeout});const folder=ensureDir(path.join(dir,name));writeJSON(path.join(folder,'command.json'),r);fs.writeFileSync(path.join(folder,'stdout.log'),r.stdout||'');fs.writeFileSync(path.join(folder,'stderr.log'),r.stderr||'');report.checks.push({name,exitCode:r.exitCode,pass:r.exitCode===0,receipt:path.join(folder,'command.json'),durationMs:r.durationMs});writeJSON(path.join(dir,'receipt.json'),report);assert.equal(r.exitCode,0,`${name}: ${r.stderr||r.stdout}`);return r;}
try{
  assert.equal(sha(fs.readFileSync(archive.path)),archive.sha256,'Distributable bytes changed after packaging');
  await command('extract','tar.exe',['-x','-f',archive.path,'-C',destination],APP_ROOT);
  assert(!fs.existsSync(path.join(destination,'.local')),'Archive contains private local state');
  assert(!fs.existsSync(path.join(destination,'workspace')),'Archive contains user workspace');
  const node=path.join(destination,'.runtime/node-home/node.exe');
  assert.equal(sha(fs.readFileSync(node)),'af1f433c29c1515b083b736a05d22d6f999aa0bb139452d8d5ca63db1f0a4b01');
  await command('verify-before-install',node,['scripts/release.mjs','--verify'],destination);
  await command('install',node,['scripts/install.mjs'],destination);
  await command('native-smoke',node,['scripts/portable-smoke.mjs'],destination);
  await command('verify-after-install',node,['scripts/release.mjs','--verify','--installed'],destination);
  report.smoke=readJSON(path.join(destination,'validation/portable-smoke.json'));assert.equal(report.smoke.exitCode,0);
  report.exitCode=0;report.status='VERIFIED_ACTUAL_ARCHIVE_INSTALLATION';
}catch(error){report.exitCode=1;report.status='FAILED';report.error=error.stack;}
report.finished=now();writeJSON(path.join(dir,'receipt.json'),report);writeJSON(path.join(APP_ROOT,'release/ARCHIVE-VERIFICATION.json'),report);
console.log(JSON.stringify({status:report.status,exitCode:report.exitCode,receipt:path.join(dir,'receipt.json'),checks:report.checks,error:report.error},null,2));process.exitCode=report.exitCode;
