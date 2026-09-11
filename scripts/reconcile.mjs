import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parent = path.dirname(root);
const out = path.join(root, 'validation', 'reconciliation');
fs.mkdirSync(out, {recursive:true});
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fileInfo = p => {
  if (!fs.existsSync(p)) return {path:p, exists:false};
  const stat = fs.statSync(p);
  return {path:p, exists:true, bytes:stat.size, modified:stat.mtime.toISOString(),
    ...(stat.isFile() ? {sha256:hash(fs.readFileSync(p))} : {})};
};
const sourceNames = ['server','ui','public','desktop','tests','scripts'];
const code = [];
for (const name of sourceNames) {
  const dir = path.join(parent,'pi-loop-v2',name);
  if (!fs.existsSync(dir)) continue;
  function visit(dir) {
    for (const e of fs.readdirSync(dir,{withFileTypes:true})) {
      const p=path.join(dir,e.name);
      if (e.isDirectory()) visit(p);
      else if (e.isFile() && !/credential|\.env$|auth\.json$/i.test(e.name)) code.push(fileInfo(p));
    }
  }
  visit(dir);
}
let discoveredRuns = [], dbError = null;
const dbPath = path.join(parent,'pi-loop-v2','.local','loop.sqlite');
if (fs.existsSync(dbPath)) {
  const db = new DatabaseSync(dbPath,{readOnly:true});
  try {
    discoveredRuns=db.prepare('SELECT id,status,spent,budget,json FROM runs').all().map(row=> {
      const r=JSON.parse(row.json);
      const calls=db.prepare('SELECT role,status,COUNT(*) calls,SUM(tokens) tokens,SUM(unknown) unknown FROM calls WHERE run_id=? GROUP BY role,status').all(row.id);
      return {id:row.id,status:row.status,stage:r.stage,spent:row.spent,budget:row.budget,created:r.created,
        error:r.error, calls, jobCount:db.prepare('SELECT COUNT(*) n FROM jobs WHERE run_id=?').get(row.id).n};
    });
  } catch(error) { dbError=String(error); } finally { db.close(); }
}
const legacy=path.join(parent,'pi-agent-loop');
const oldVersion=JSON.parse(fs.readFileSync(path.join(legacy,'package.json'),'utf8')).version;
const assets=['.runtime/node-home/node.exe','.runtime/python-home/python.exe','.python/pyvenv.cfg','vendor/pi-repl-py/bridge.py','requirements.lock'];
const report={schema:1,at:new Date().toISOString(),command:process.argv,cwd:process.cwd(),
  environment:{node:process.version,platform:process.platform,arch:process.arch,executable:process.execPath},
  deliveryRoot:root,legacyVersion:oldVersion,legacyAssets:assets.map(p=>fileInfo(path.join(legacy,p))),
  historicalEvidence:{validationDirectory:path.join(legacy,'validation'),validationEntries:fs.readdirSync(path.join(legacy,'validation')).length,
    docsDirectory:path.join(legacy,'docs'),docEntries:fs.readdirSync(path.join(legacy,'docs')).length},
  discoveredCandidate:{path:path.join(parent,'pi-loop-v2'),version:JSON.parse(fs.readFileSync(path.join(parent,'pi-loop-v2','package.json'),'utf8')).version,
    sourceFiles:code, runs:discoveredRuns, dbError},
  disposition:'References remain unchanged. No prior acceptance or provenance is asserted for the new delivery.',exitCode:0};
fs.writeFileSync(path.join(out,'disk.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({at:report.at,legacyVersion:oldVersion,newDirectory:root,sourceFiles:code.length,
  privateNode:report.legacyAssets[0],candidateRuns:discoveredRuns.map(r=>({id:r.id,status:r.status,stage:r.stage,spent:r.spent,jobs:r.jobCount,error:r.error})),
  receipt:path.join(out,'disk.json')},null,2));
