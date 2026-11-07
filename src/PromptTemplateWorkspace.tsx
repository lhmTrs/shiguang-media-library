import React, { forwardRef,lazy, Suspense, useEffect,useImperativeHandle,useRef,useState } from 'react';
import {createPortal} from 'react-dom';
import {ProjectSelector} from './ProjectSelector';
import type {CodexTaskTarget} from './codex-task-types';
const Editor=lazy(()=>import('./prompts/PromptEditor').then(m=>({default:m.PromptEditor})));
export type PromptRequest=<T=any>(path:string,body?:unknown,method?:string,options?:{signal?:AbortSignal})=>Promise<T>;
export type TaskNavigator=(target:CodexTaskTarget,isCurrent:()=>boolean)=>Promise<void>;
export type PromptWorkspaceHandle={openTask:TaskNavigator;prepareLeave:(isCurrent:()=>boolean)=>Promise<void>};
export type PromptWorkspaceProps={active:boolean;request:PromptRequest;refreshSeconds:number;onSettings:()=>void;projects?:{id:string;name:string}[];activeProject?:string;selectProject?:(id:string)=>void;projectSelectorHost?:HTMLElement|null;registerTaskNavigator?:(fn:TaskNavigator|null)=>void;registerTaskLeaveGuard?:(fn:((isCurrent:()=>boolean)=>Promise<void>)|null)=>void;onTaskViewing?:(ids:string[])=>void};
export const PromptTemplateWorkspace=forwardRef<PromptWorkspaceHandle,PromptWorkspaceProps>(function PromptTemplateWorkspace(props,ref){
 const leave=useRef<((isCurrent:()=>boolean)=>Promise<void>)|null>(null),navigator=useRef<TaskNavigator|null>(null),waiters=useRef<((fn:TaskNavigator)=>void)[]>([]);
 const [started,setStarted]=useState(false);useEffect(()=>{if(props.active)setStarted(true)},[props.active]);
 useImperativeHandle(ref,()=>({async prepareLeave(isCurrent){if(leave.current)await leave.current(isCurrent);},async openTask(target,isCurrent){setStarted(true);const fn=navigator.current??await new Promise<TaskNavigator>((resolve,reject)=>{const complete=(fn:TaskNavigator)=>{clearTimeout(timer);resolve(fn);};const timer=setTimeout(()=>{waiters.current=waiters.current.filter(w=>w!==complete);reject(Error('提示词工作台加载超时，请重试；未改变原选择'));},15000);waiters.current.push(complete);});if(isCurrent())await fn(target,isCurrent);}}),[]);
 const registerTaskNavigator=(fn:TaskNavigator|null)=>{navigator.current=fn;if(fn){for(const resolve of waiters.current)resolve(fn);waiters.current=[];}};
 const selector=<ProjectSelector projects={props.projects??[]} value={props.activeProject??''} onChange={id=>props.selectProject?.(id)} label="图片所属项目" caption="图片所属"/>;
 return started?<div hidden={!props.active}>{props.active&&props.projectSelectorHost?createPortal(selector,props.projectSelectorHost):null}<Suspense fallback={<p style={{padding:24}}>正在打开提示词工作台…</p>}><Editor {...props} registerTaskLeaveGuard={fn=>{leave.current=fn;}} registerTaskNavigator={registerTaskNavigator}/></Suspense></div>:null;
});
