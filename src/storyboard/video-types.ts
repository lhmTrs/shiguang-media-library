import type {PreviewRun} from './video-player';
import type {PreviewShot} from './video-stage';
export type VideoSegment={sourceId:string;inMs:number;outMs:number};
export type VideoTake={takeId:string;shotId:string;documentId:string;initializedAt:number;importOrder:number;segments:VideoSegment[];alignment:'estimated'|'manual';timingHash:string;createdAt:number};
export type VideoSource={managed?:boolean;removed?:boolean;id:string;name:string;durationMs:number;codec:string;mediaUrl:string;status:'available'|'untrusted'|'missing'|'changed'|'unsupported';errorCode:string|null};
export type VideoState={projectId:string;documentId:string;initializedAt:number;storyboardRevision:number;timingHash:string;shots:(PreviewShot&{endMs:number})[];sources:VideoSource[];takes:VideoTake[];plan:{revision:number;adopted:Record<string,string>;timingHash:string};playback:{durationMs:number;runs:PreviewRun[];blocked:null|'TIMING_CHANGED'};summary:{full:number;partial:number;missing:number;durationMs:number};requiresRecalibration:boolean};
export const videoGuards=(s:VideoState)=>({documentId:s.documentId,initializedAt:s.initializedAt,expectedStoryboardRevision:s.storyboardRevision,expectedPlanRevision:s.plan.revision,timingHash:s.timingHash});
export type VideoInspection={token:string;name:string;durationMs:number;codec:string;status:'available'|'unsupported';expiresAt:number};
export type VideoAllocation={selectedShotIds:string[];requiredMs:number;providedMs:number;shortageMs:number;unused:{videoIndex:number;sourceInMs:number;sourceOutMs:number}[];allocations:{shotId:string;segments:{videoIndex:number;inMs:number;outMs:number}[];blackMs:number}[];alignment:'estimated'};
export function videoMs(value:string){if(!/^\d+(?:\.\d{1,3})?$/.test(value.trim()))throw Error('时间请填写非负秒数，最多三位小数');const n=Math.round(Number(value)*1000);if(!Number.isSafeInteger(n))throw Error('时间超出范围');return n;}
export const videoSeconds=(ms:number)=>String(ms/1000);
