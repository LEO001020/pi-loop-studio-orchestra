// Persist the exit code, stdout and stderr even after an MCP session expires.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
const [name,...argv]=process.argv.slice(2);
if(!name||!argv.length||!/^[\w-]+$/.test(name))throw new Error('Usage: node check-command.mjs <receipt-name> <executable> [arguments...]');
const root=path.resolve(import.meta.dirname,'..'),parent=path.join(root,'validation',name);
const dir=fs.existsSync(path.join(parent,'command.json'))?`${parent}-${Date.now()}`:parent;fs.mkdirSync(dir,{recursive:true});
const stdout=fs.openSync(path.join(dir,'stdout.log'),'w'),stderr=fs.openSync(path.join(dir,'stderr.log'),'w');
const record={command:argv,cwd:process.cwd(),started:new Date().toISOString(),environment:{node:process.version,platform:process.platform,arch:process.arch,release:os.release()},exitCode:null};
const hashes={};for(const folder of ['server','ui','tests'])for(const entry of fs.readdirSync(path.join(root,folder),{withFileTypes:true}).filter(e=>e.isFile()).sort((a,b)=>a.name.localeCompare(b.name))){const rel=folder+'/'+entry.name;hashes[rel]=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,rel))).digest('hex');}
record.sourceFilesAtStart=hashes;record.receiptDirectory=dir;
const output=path.join(dir,'command.json');fs.writeFileSync(output,JSON.stringify(record,null,2));
const child=spawn(argv[0],argv.slice(1),{stdio:['ignore',stdout,stderr],windowsHide:true,env:{...process.env,PATH:[path.join(root,'.runtime/node-home'),path.join(root,'.runtime/git/cmd'),process.env.PATH||''].join(path.delimiter)}});
child.once('error',error=>{record.spawnError=error.message;});
child.once('close',(code,signal)=>{fs.closeSync(stdout);fs.closeSync(stderr);Object.assign(record,{exitCode:code,signal,finished:new Date().toISOString()});fs.writeFileSync(output,JSON.stringify(record,null,2));console.log(JSON.stringify(record));process.exitCode=code??1;});
