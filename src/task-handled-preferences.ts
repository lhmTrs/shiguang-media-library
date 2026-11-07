import {isTaskIssueKey} from './codex-task-types';
export const MAX_HANDLED_TASKS=500;
const MAX_BYTES=750000;
export type HandledStorage=Pick<Storage,'getItem'|'setItem'>;
export function handledStorageKey(libraryId:string){if(!/^[a-zA-Z0-9_-]{1,128}$/.test(libraryId))throw Error('素材库身份无法确认，未移动任务');return 'shiguang.codex.handled.v1.'+libraryId;}
export function readHandledTasks(libraryId:string,storage:HandledStorage=localStorage):Set<string>{
 let raw:string|null;try{raw=storage.getItem(handledStorageKey(libraryId));}catch{throw Error('无法读取已处理记录，未改变任务分类，请检查浏览器存储后重新读取');}
 if(raw===null)return new Set();
 try{if(raw.length>MAX_BYTES)throw Error();const value=JSON.parse(raw);if(!value||value.version!==1||!Array.isArray(value.keys)||value.keys.length>MAX_HANDLED_TASKS||!value.keys.every(isTaskIssueKey)||new Set(value.keys).size!==value.keys.length)throw Error();return new Set(value.keys);}catch{throw Error('已处理记录损坏，未自动覆盖；请检查浏览器存储后重新读取');}
}
export function writeHandledTask(libraryId:string,key:string,storage:HandledStorage=localStorage):Set<string>{
 if(!isTaskIssueKey(key))throw Error('本轮问题标识无法确认，未移动任务');const keys=readHandledTasks(libraryId,storage);keys.delete(key);keys.add(key);let recent=[...keys].slice(-MAX_HANDLED_TASKS),encoded=JSON.stringify({version:1,keys:recent});
 while(encoded.length>MAX_BYTES&&recent.length>1){recent.shift();encoded=JSON.stringify({version:1,keys:recent});}
 try{storage.setItem(handledStorageKey(libraryId),encoded);}catch{throw Error('无法保存处理记录，未移至已结束；请检查浏览器存储空间或权限');}
 const saved=readHandledTasks(libraryId,storage);if(!saved.has(key))throw Error('处理记录保存未确认，任务仍待处理，请重新读取后核对');return saved;
}
