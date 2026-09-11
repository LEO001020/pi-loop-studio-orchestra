export type RecordData=Record<string,any>;
export interface Session {id:string;title:string;workspace:string;created:string;updated:string;memory:string;archived?:boolean}
export interface Message {id:string;role:'user'|'assistant';content:string;created:string;runId?:string}
export interface Run extends RecordData {id:string;sessionId:string;objective:string;workspace:string;status:string;stage:string;budget:number;spent:number;created:string;settings:RecordData}
export interface RunDetails {run:Run;jobs:RecordData[];calls:RecordData[];effects:RecordData[];metrics:RecordData;graph:RecordData;jobGraph:RecordData;cursor:number}
export class ApiError extends Error {status:number;code:string;constructor(status:number,code:string,message:string){super(message);this.name='ApiError';this.status=status;this.code=code;}}
export async function api<T=RecordData>(url:string,method='GET',body?:unknown):Promise<T>{
  const response=await fetch('/api'+url,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
  const text=await response.text();let data:RecordData;try{data=JSON.parse(text);}catch{throw new Error(`服务响应不是 JSON (${response.status})；会话不会因此被删除。`);}
  if(!response.ok)throw new ApiError(response.status,data.error?.code||'HTTP_ERROR',data.error?.message||`请求失败 (${response.status})`);return data as T;
}
export const format=(n:number=0)=>n.toLocaleString('zh-CN');
export const stageLabel:Record<string,string>={routing:'识别意图',chat:'对话中',preparing:'创建独立快照',scoping:'主席位侦查与派发',reconnaissance:'并行侦查',recon_audit:'独立证据审核',planning:'建立任务依赖图',executing:'并行执行与审核',auditing:'独立审核',integrating:'整合已审产物',verifying:'实际运行验证',judging:'主席位仲裁',repairing:'依据证据返工',publishing:'发布到工作区',finishing:'整理交付回执',done:'已完成',completed:'已完成',integrated:'已审核并整合',queued:'排队中',paused:'预算暂停',blocked:'需要处理',cancelled:'已取消',running:'运行中',retrying:'返工中'};
