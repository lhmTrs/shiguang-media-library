export type CodexTaskTarget={templateId:string;conversationId:string;turnId:string;request:number};
export type CodexTask={taskId:string;type?:'storyboard';projectId?:string;storyboardStatus?:string;resourceState?:string;errors?:{path:string;message:string}[];conversationId:string|null;templateId:string|null;title:string;templateName:string;templateDeleted:boolean;conversationDeleted:boolean;sequence:number;status:string;errorCode:string;createdAt:number;updatedAt:number;project:{id:string;name:string;available:boolean}|null;model:string|null;effort:string|null;phase:string;attention:{required:boolean;reasons:string[]};terminalRevision:string|null;summaryUnavailable?:boolean;imageCount:number;preview:string;images:{attachmentId:string|null;url:string|null;status:string;saved:boolean;libraryStatus:string;errorCode:string|null}[]};
export type CodexTaskOverview={observedAt:number;instanceId?:string;connection:{connected:boolean;authenticated:boolean;active:number;unsettled?:boolean;instanceId?:string};activeCount:number;items:CodexTask[];nextCursor:string|null;historyScope:unknown};
export type CodexTaskImpact={type?:'storyboard';taskId:string;requiresConfirmation:boolean;otherTasks:{taskId:string;title?:string;conversationId?:string|null}[];impactToken:string;expiresAt:number};
export type CheckedCodexTask=CodexTask&{stateUnconfirmed?:boolean;verificationError?:string;historyChecked?:boolean};
export const isActiveTask=(t:CheckedCodexTask)=>!t.stateUnconfirmed&&['queued','running','stopping'].includes(t.status);
export const needsTaskAttention=(t:CheckedCodexTask)=>!!t.stateUnconfirmed||t.attention.required||t.status==='failed'||t.status==='interrupted'&&t.errorCode!=='USER_STOPPED'||t.images.some(i=>i.status==='failed'||i.libraryStatus==='failed');
export const taskTerminalKey=(instance:string,t:CodexTask)=>[instance,t.taskId,t.terminalRevision??[t.status,t.errorCode,t.updatedAt].join(':')].join(':');
export const taskStateLabel=(t:CheckedCodexTask)=>t.stateUnconfirmed?'状态待确认':({queued:'准备中',running:'生成中',stopping:'正在停止',completed:'生成完成',failed:'生成失败',interrupted:t.errorCode==='USER_STOPPED'?'用户已停止':'生成中断'}[t.status]||t.status);
export const canHandleTask=(t:CheckedCodexTask)=>!t.stateUnconfirmed&&!isActiveTask(t)&&['completed','failed','interrupted'].includes(t.status)&&needsTaskAttention(t);
const issueCode=(v:unknown)=>typeof v==='string'&&/^[A-Z0-9_:-]{0,160}$/.test(v);
const issueId=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
export function isTaskIssueKey(key:unknown):key is string{
 if(typeof key!=='string'||key.length>4096)return false;
 try{const v=JSON.parse(key);return Array.isArray(v)&&v.length===7&&issueId(v[0])&&typeof v[1]==='string'&&/^[a-zA-Z0-9_:.\-]{1,240}$/.test(v[1])&&['completed','failed','interrupted'].includes(v[2])&&issueCode(v[3])&&Array.isArray(v[4])&&v[4].length<=32&&v[4].every(issueCode)&&Array.isArray(v[5])&&v[5].length<=16&&v[5].every((i:unknown)=>Array.isArray(i)&&i.length===4&&(i[0]===null||issueId(i[0]))&&['ready','failed','processing'].includes(i[1])&&['saved','failed','notRequested'].includes(i[2])&&(i[3]===null||issueCode(i[3])))&&Number.isSafeInteger(v[6])&&v[6]>=0;}catch{return false;}
}
// Stable problem identity deliberately excludes observedAt, names, text, paths and URLs.
export function taskIssueKey(t:CodexTask):string|null{
 const images=t.images.filter(i=>i.status==='failed'||i.libraryStatus==='failed').map(i=>[i.attachmentId,i.status,i.libraryStatus,i.errorCode]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 const key=JSON.stringify([t.taskId,t.terminalRevision??`${t.status}:${t.errorCode}:${t.updatedAt}`,t.status,t.errorCode,[...new Set(t.attention.reasons)].sort(),images,t.imageCount]);return isTaskIssueKey(key)?key:null;
}
export const taskObservationKey=(instance:string,t:CodexTask)=>JSON.stringify([instance,taskIssueKey(t)??taskTerminalKey(instance,t)]);
