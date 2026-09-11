import {useMemo,useState} from 'react';
import {ReactFlow,Background,Controls,MarkerType,Position,type Node,type Edge} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {type RunDetails,type RecordData,stageLabel} from './api';

export function WorkflowGraph({details,replayStage}:{details:RunDetails|null;replayStage?:string}){
  const [view,setView]=useState<'root'|'jobs'>('root');
  const {nodes,edges}=useMemo(()=>{
    if(!details)return {nodes:[],edges:[]};
    const nodes:Node[]=[],edges:Edge[]=[];
    if(view==='root'){
      const order=['routing','preparing','scoping','reconnaissance','recon_audit','planning','executing','verifying','judging','publishing','finishing','done'];
      const other=['chat','repairing','recovering','paused','blocked','cancelled'];
      [...order,...other].forEach((id,i)=>{
        const secondary=i>=order.length,index=secondary?i-order.length:i;
        const active=(replayStage||details.run.stage)===id;
        const done=Object.keys(details.run.context?.steps||{}).some(k=>k.startsWith(id+':'));
        nodes.push({id,position:{x:secondary?270:10,y:secondary?index*112+60:index*84},data:{label:details.graph[id]?.label||stageLabel[id]||id},className:`flow-node ${active?'active':done?'passed':''}`,sourcePosition:Position.Bottom,targetPosition:Position.Top,style:{width:210}});
      });
      for(const [id,definition] of Object.entries(details.graph) as [string,RecordData][])for(const target of definition.next){if(!nodes.some(n=>n.id===target))continue;edges.push({id:`${id}-${target}`,source:id,target,animated:id===details.run.stage&&details.run.status==='running',type:'smoothstep',markerEnd:{type:MarkerType.ArrowClosed},label:id==='judging'?target==='publishing'?'通过':'未通过':undefined});}
      for(const source of order.filter(x=>x!=='done'))for(const target of ['paused','blocked'])edges.push({id:`err-${source}-${target}`,source,target,type:'smoothstep',style:{opacity:.16,strokeDasharray:'3 5'}});
    }else{
      const depth=new Map<string,number>();const jobs=details.jobs;
      function level(j:RecordData):number{if(depth.has(j.id))return depth.get(j.id)!;depth.set(j.id,0);const n=j.dependsOn?.length?1+Math.max(...j.dependsOn.map((id:string)=>{const parent=jobs.find(p=>p.id===id);return parent?level(parent):0;})):0;depth.set(j.id,n);return n;}
      const columns=new Map<number,number>();
      jobs.forEach(j=>{const d=level(j),row=columns.get(d)||0;columns.set(d,row+1);nodes.push({id:j.id,position:{x:d*280,y:row*112},data:{label:`${j.title}\n${j.role} · ${stageLabel[j.status]||j.status}`},className:`flow-node ${j.integratedCommit?'passed':['executing','auditing','integrating'].includes(j.status)?'active':['blocked','paused'].includes(j.status)?'failed':''}`,style:{width:245},sourcePosition:Position.Right,targetPosition:Position.Left});for(const dep of j.dependsOn||[])edges.push({id:`${dep}-${j.id}`,source:dep,target:j.id,markerEnd:{type:MarkerType.ArrowClosed},type:'smoothstep'});});
    }return {nodes,edges};
  },[details,view,replayStage]);
  return <div className="graph-shell"><div className="segmented"><button className={view==='root'?'selected':''} onClick={()=>setView('root')}>根流程</button><button className={view==='jobs'?'selected':''} onClick={()=>setView('jobs')}>岗位依赖</button></div><div className="graph-canvas">{details?<ReactFlow key={view} nodes={nodes} edges={edges} fitView minZoom={.2} maxZoom={1.8} nodesDraggable={false} nodesConnectable={false} colorMode="system" proOptions={{hideAttribution:false}}><Background gap={20} size={1}/><Controls showInteractive={false}/></ReactFlow>:<div className="empty-panel">开始任务后，这里会显示实际运行图。</div>}</div><div className="graph-legend"><span><i className="dot mint"/>已完成节点</span><span><i className="dot blue"/>当前节点</span><span>虚线为失败路径</span></div></div>;
}
