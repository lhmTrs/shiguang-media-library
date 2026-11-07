import type {VideoState,VideoInspection,VideoAllocation} from './video-types';
export type VideoMode='add'|'preview';
export type RangeImport={requestId:string;guards:{documentId:string;initializedAt:number;expectedStoryboardRevision:number;expectedPlanRevision:number;timingHash:string};shotIds:string[];videos:{token:string;inMs:number;outMs:number}[]};
export type PendingRange={requestId:string;body?:RangeImport;fileName?:string;from?:string;to?:string};
export type RangeDraft={path:string;registered:string;file:VideoInspection|null;from:string;to:string};
export type CoverageUndo={id:string;revision:number};
const idOK=(v:unknown)=>typeof v==='string'&&/^[a-f0-9-]{36}$/i.test(v);
export const rangeScope=(library:string,project:string,document:string,initializedAt:number)=>[library,project,document,initializedAt].join(':');
const prefix=(scope:string)=>'shiguang.storyboard.video.pending.v1.'+scope;
export function readRangePending(scope:string):PendingRange|null{try{const raw=localStorage.getItem(prefix(scope));if(!raw)return null;if(idOK(raw))return{requestId:raw};const p=JSON.parse(raw);return p&&idOK(p.requestId)?p:null;}catch{return null;}}
export function persistRangePending(scope:string,p:PendingRange|null){const key=prefix(scope);if(p){localStorage.setItem(key,JSON.stringify(p));if(localStorage.getItem(key)!==JSON.stringify(p))throw Error('未能可靠保存覆盖请求编号，尚未发送');}else{localStorage.removeItem(key);if(localStorage.getItem(key)!==null)throw Error('无法清除已核对请求，请保留窗口并重试核对');}}
export function readRangeDraft(scope:string):RangeDraft|null{try{const p=JSON.parse(localStorage.getItem(prefix(scope)+'.range-draft')||'null');return p&&typeof p.path==='string'&&typeof p.from==='string'&&typeof p.to==='string'?p:null;}catch{return null;}}
export function persistRangeDraft(scope:string,p:RangeDraft){localStorage.setItem(prefix(scope)+'.range-draft',JSON.stringify(p));}
export function readCoverageUndo(scope:string):CoverageUndo|null{try{const p=JSON.parse(localStorage.getItem(prefix(scope)+'.last-import')||'null');return p&&idOK(p.id)&&Number.isSafeInteger(p.revision)?p:null;}catch{return null;}}
export function persistCoverageUndo(scope:string,p:CoverageUndo){localStorage.setItem(prefix(scope)+'.last-import',JSON.stringify(p));}
export function rangeShots(s:VideoState,from:string,to:string){const start=s.shots.findIndex(q=>q.id===from),end=s.shots.findIndex(q=>q.id===to);if(start<0||end<0)throw Error('请选择起始镜号和结束镜号');if(end<start)throw Error('结束镜号不能早于起始镜号');return s.shots.slice(start,end+1);}
export function rangeSummary(s:VideoState,from:string,to:string,allocation?:VideoAllocation){const shots=rangeShots(s,from,to);return{shots,covered:shots.filter(q=>s.plan.adopted[q.id]).length,durationMs:shots.reduce((n,q)=>n+q.durationMs,0),shortageMs:allocation?.shortageMs??0,unusedMs:allocation?.unused.reduce((n,u)=>n+u.sourceOutMs-u.sourceInMs,0)??0};}
export function withoutAdoption(s:VideoState,scope:{shotId?:string;sourceId?:string;all?:boolean}){const adopted={...s.plan.adopted};for(const [shotId,takeId]of Object.entries(adopted)){const take=s.takes.find(t=>t.takeId===takeId);if(scope.all||scope.shotId===shotId||scope.sourceId&&take?.segments.some(v=>v.sourceId===scope.sourceId))delete adopted[shotId];}return adopted;}
