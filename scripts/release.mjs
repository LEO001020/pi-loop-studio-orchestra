// Self-contained Windows payload, reproducible file inventory, no credentials.
import fs from 'node:fs';
import path from 'node:path';
import {APP_ROOT,ensureDir,readJSON,writeJSON,sha,now,inside} from '../server/util.mjs';
import {credentials} from '../server/settings.mjs';
import {executeProcess} from '../server/commands.mjs';

const roots=['server','ui','public','desktop','scripts','tests','vendor','dist','node_modules','.runtime/node-home','.runtime/python-home','.runtime/git','.python','docs'];
const files=['package.json','package-lock.json','config.example.json','credentials.example.json','requirements.lock','tsconfig.json','vite.config.ts','index.html','AGENTS.md','README.md','LICENSE','THIRD-PARTY.md','VERIFICATION.md','BLOCKED-UNVERIFIED.md','.gitignore','Install Pi Loop Studio.cmd','Open Pi Loop Studio.cmd','Stop Pi Loop Studio.cmd','MANIFEST-SCOPE.json','.runtime/downloads/MinGit-2.55.0.5-64-bit.zip'];
const excluded=new Set(['__pycache__','.cache','.vite','.git']);
// Headless acceptance does not need the optional Playwright recorder fonts.
// The desktop UI uses fonts already installed by Windows, never bundled fonts.
const fontFile=rel=>/\.(?:ttf|otf|woff2?|eot)$/i.test(rel);
function inventory(){
  const list=[];
  function walk(rel){const full=path.join(APP_ROOT,rel);if(!fs.existsSync(full))return;const st=fs.lstatSync(full);if(st.isSymbolicLink())throw new Error(`Release payload has an unexpected link: ${rel}`);
    if(st.isDirectory()){for(const name of fs.readdirSync(full))if(!excluded.has(name))walk(rel+'/'+name);}else if(st.isFile()&&!rel.endsWith('.pyc')&&!fontFile(rel))list.push(rel.replaceAll('\\','/'));}
  for(const rel of [...roots,...files])walk(rel);return [...new Set(list)].sort();
}
function relocatable(rel){return rel==='.python/pyvenv.cfg'||/^\.python\/Scripts\/(?!python(?:w)?\.exe$)/i.test(rel)||rel==='.python/share/jupyter/kernels/python3/kernel.json';}
const target=path.join(APP_ROOT,'MANIFEST.sha256');
if(process.argv.includes('--verify')){
  const entries=fs.readFileSync(target,'utf8').trim().split('\n').map(line=>{const m=/^([a-f0-9]{64})  (.+)$/.exec(line);if(!m)throw new Error('Malformed MANIFEST.sha256');return {hash:m[1],file:m[2]};});
  const mismatches=[],relocated=[];
  for(const entry of entries){const full=path.resolve(APP_ROOT,entry.file);if(!inside(APP_ROOT,full))throw new Error('Manifest path escaped application root');
    const actual=fs.existsSync(full)?sha(fs.readFileSync(full)):null;
    if(actual!==entry.hash){if(process.argv.includes('--installed')&&relocatable(entry.file)&&actual)relocated.push(entry.file);else mismatches.push({file:entry.file,expected:entry.hash,actual});}}
  const known=new Set(entries.map(e=>e.file)),unexpected=inventory().filter(f=>!known.has(f));
  const result={at:now(),status:mismatches.length||unexpected.length?'FAILED':'VERIFIED_PAYLOAD_CHECKSUMS',entries:entries.length,checkedBytes:entries.reduce((n,e)=>n+(fs.existsSync(path.join(APP_ROOT,e.file))?fs.statSync(path.join(APP_ROOT,e.file)).size:0),0),mismatches,unexpected,relocatedFilesNotCompared:relocated};
  console.log(JSON.stringify(result,null,2));process.exitCode=mismatches.length||unexpected.length?1:0;
}else{
  for(const rel of ['README.md','VERIFICATION.md','BLOCKED-UNVERIFIED.md','LICENSE','credentials.example.json'])if(!fs.existsSync(path.join(APP_ROOT,rel)))throw new Error(`Required release file missing: ${rel}`);
  const dependencies={};const pkg=readJSON(path.join(APP_ROOT,'package.json'));
  for(const name of Object.keys({...pkg.dependencies,...pkg.devDependencies})){const p=readJSON(path.join(APP_ROOT,'node_modules',name,'package.json'),{});dependencies[name]={version:p.version,license:p.license??null,repository:p.repository??null};}
  writeJSON(path.join(APP_ROOT,'docs/verification/dependencies.json'),{directDependencies:dependencies,lockFileSha256:sha(fs.readFileSync(path.join(APP_ROOT,'package-lock.json')))});
  writeJSON(path.join(APP_ROOT,'MANIFEST-SCOPE.json'),{format:1,roots,rootFiles:files,excludedDirectories:[...excluded],excludedSuffixes:['.pyc','.ttf','.otf','.woff','.woff2','.eot'],excludedPrivateRoots:['.local','workspace','validation','release'],meaning:'SHA256 integrity is not a digital signature or a proof of functional correctness. The local private configured directory may contain .local; distributable archives never do.',optionalAssets:'Playwright recorder/trace-viewer icon fonts are omitted. Headless browser automation and the application UI do not need them.',relocation:'Before installation use --verify. Installation regenerates Python entrypoints and paths; afterward --verify --installed reports those exceptions explicitly and checks the remainder.'});
  const list=inventory(),keys=Object.values(credentials()).filter(v=>typeof v==='string'&&v.length>8);let payloadBytes=0;
  const lines=[];for(const rel of list){const data=fs.readFileSync(path.join(APP_ROOT,rel));if(keys.some(key=>data.includes(Buffer.from(key))))throw new Error(`Credential found in payload file ${rel}; no archive produced`);payloadBytes+=data.length;lines.push(`${sha(data)}  ${rel}`);}
  fs.writeFileSync(target,lines.join('\n')+'\n','utf8');
  const releaseDir=ensureDir(path.join(APP_ROOT,'release')),summary={at:now(),version:pkg.version,entries:list.length,payloadBytes,manifestSha256:sha(fs.readFileSync(target)),credentialsIncluded:false,archives:[]};
  if(process.argv.includes('--package')){
    for(const [kind,selected]of [['win-x64',list]]){
      const included=[...selected,'MANIFEST.sha256'];const fileList=path.join(releaseDir,`${kind}-files.txt`);fs.writeFileSync(fileList,included.join('\n')+'\n','utf8');
      // A payload revision is identified by its complete manifest, not merely
      // package.json's version. Old archives and their failure evidence stay.
      const zip=path.join(releaseDir,`Pi-Loop-Studio-${pkg.version}-${summary.manifestSha256.slice(0,12)}-${kind}.zip`);
      if(fs.existsSync(zip)){
        const previous=readJSON(path.join(releaseDir,'DELIVERY.json'),null);
        const cached=previous?.manifestSha256===summary.manifestSha256&&previous.archives?.find(a=>a.path===zip);
        if(!cached||cached.sha256!==sha(fs.readFileSync(zip)))throw new Error(`Existing content-addressed archive cannot be verified; preserved: ${zip}`);
        summary.archives.push(cached);continue;
      }
      const staging=zip+`.partial-${Date.now()}.zip`;
      const r=await executeProcess('tar.exe',['-a','-c','-f',staging,'-T',fileList],{cwd:APP_ROOT,timeout:420});writeJSON(path.join(releaseDir,`${summary.manifestSha256.slice(0,12)}-${kind}-archive-command.json`),r);
      if(r.exitCode!==0)throw new Error(`Archive creation failed; unpublished staging retained: ${r.stderr}`);
      fs.renameSync(staging,zip);
      summary.archives.push({kind,path:zip,bytes:fs.statSync(zip).size,sha256:sha(fs.readFileSync(zip))});
    }
  }
  writeJSON(path.join(releaseDir,'DELIVERY.json'),summary);console.log(JSON.stringify(summary,null,2));
}
