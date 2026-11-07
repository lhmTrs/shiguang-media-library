import React, { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {ProjectSelector} from './ProjectSelector';
import { createStoryboardTransport } from './storyboard/transport';
import './storyboard/storyboard.css';
import type { StoryboardAppearance } from './storyboard/preferences';
import type {PromptRequest} from './PromptTemplateWorkspace';
import type {GenerationFocus} from './storyboard/generation-types';
import {GenerationDialog} from './storyboard/GenerationDialog';
import type {ShotFocus} from './storyboard/shot-navigation';
const Editor = lazy(() => import('./storyboard/StoryboardEditor').then(module => ({ default: module.StoryboardEditor })));
type Props = {projectsKnown:boolean;projectsError:string;request:PromptRequest;generationFocus?:GenerationFocus|null;onTaskViewing?:(ids:string[])=>void;active: boolean; projects: {id:string;name:string}[]; activeProject:string; selectProject:(id:string)=>void; projectSelectorHost:HTMLElement|null; onAssets:()=>void; onProjects:()=>void; refreshSeconds:number; appearance:StoryboardAppearance; onAppearanceChange:(v:StoryboardAppearance)=>void; onSettings:()=>void; shotFocus?:ShotFocus|null; onDirtyChange?:(dirty:boolean)=>void };
export function StoryboardWorkspace({projectsKnown,projectsError,request,generationFocus,onTaskViewing,active, projects, activeProject, selectProject, projectSelectorHost, onAssets, onProjects, refreshSeconds, appearance, onAppearanceChange, onSettings, shotFocus, onDirtyChange }:Props) {
  const [started,setStarted]=useState(false), [dirty,setDirty]=useState(false),[handledFocus,setHandledFocus]=useState(0),[dismissedGeneration,setDismissedGeneration]=useState(0);
  useEffect(()=>{onDirtyChange?.(dirty);},[dirty,onDirtyChange]);
  const transport=useMemo(()=>createStoryboardTransport(),[]);
  useEffect(()=>{if(active)setStarted(true);},[active]);
  if(!started)return null;
  const project=projects.find(p=>p.id===activeProject);
  const selector=<ProjectSelector projects={projects} value={activeProject} label="分镜所属项目" caption="分镜所属" onChange={id=>{if(dirty&&!confirm('当前分镜有未保存草稿，切换后可在原项目恢复。继续切换？'))return;selectProject(id);}}/>;
  return <div className="sb-native-host" hidden={!active}>{active&&projectSelectorHost?createPortal(selector,projectSelectorHost):selector}{project?<Suspense fallback={<div className="sb-app"><div className="sb-connection">正在读取项目分镜…</div></div>}><Editor generationRequest={request} generationFocus={generationFocus?.projectId===project.id&&generationFocus.request>dismissedGeneration?generationFocus:undefined} onGenerationFocusHandled={setDismissedGeneration} onTaskViewing={onTaskViewing} key={project.id} projectId={project.id} projectName={project.name} onAssets={onAssets} onDirtyChange={setDirty} transport={transport} visible={active} refreshSeconds={refreshSeconds} appearance={appearance} onAppearanceChange={onAppearanceChange} onSettings={onSettings} shotFocus={shotFocus?.projectId===project.id&&shotFocus.request>handledFocus?shotFocus:undefined} onShotFocusHandled={setHandledFocus}/></Suspense>:!projectsKnown?<div className="sb-app"><div className="sb-connection" role="status">{projectsError?'项目列表未能读取，请在上方重试':'正在读取项目…'}</div></div>:<div className="sb-app"><div className="sb-welcome"><h2>请先选择一个项目</h2><p>每个项目拥有一份当前分镜，人物、场景和道具保存在该项目的资产库。</p><button className="sb-primary" onClick={onProjects}>前往项目管理</button></div></div>}{active&&!project&&generationFocus&&generationFocus.request>dismissedGeneration&&<GenerationDialog projectId={generationFocus.projectId} projectName="项目不可用 · 历史任务" libraryId={generationFocus.libraryId} taskId={generationFocus.taskId} request={request} onViewing={onTaskViewing} onClose={()=>setDismissedGeneration(generationFocus.request)}/>}</div>;
}
