import path from 'node:path';
import {APP_ROOT,LOCAL,readJSON,now,writeJSON} from '../server/util.mjs';
const record={started:now(),command:process.argv,exitCode:null};
try{
  const previous=readJSON(path.join(LOCAL,'host.json'),null);
  if(!previous||previous.root!==APP_ROOT||!/^http:\/\/127\.0\.0\.1:\d+$/.test(previous.address))throw new Error('No matching local host record. No process was stopped.');
  let status;try{status=await(await fetch(previous.address+'/api/health',{signal:AbortSignal.timeout(2000)})).json();}catch{record.alreadyStopped=true;}
  if(status){
    if(status.app!=='pi-loop-studio'||status.bootId!==previous.bootId||status.root!==APP_ROOT)throw new Error('Host identity changed. No unrelated process was stopped.');
    const response=await fetch(previous.address+'/api/shutdown',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`Shutdown HTTP ${response.status}`);
    let stopped=false;
    for(let i=0;i<150;i++){
      await new Promise(resolve=>setTimeout(resolve,200));
      try{await fetch(previous.address+'/api/health',{signal:AbortSignal.timeout(600)});}catch{stopped=true;break;}
    }
    if(!stopped)throw new Error('Graceful shutdown has not completed. No forced process kill was attempted.');
  }
  record.exitCode=0;console.log('Pi Loop Studio host is stopped. Sessions and checkpoints are retained.');
}catch(error){record.exitCode=1;record.error=error.message;console.error(error.message);process.exitCode=1;}
record.finished=now();writeJSON(path.join(LOCAL,'last-stop.json'),record);

