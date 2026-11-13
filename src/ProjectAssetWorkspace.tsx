import React, { lazy, Suspense, useEffect, useState } from 'react';
import type { PromptRequest } from './PromptTemplateWorkspace';
import type { ShotTarget } from './storyboard/shot-navigation';
const Editor = lazy(() => import('./project-assets/AssetLibrary').then(m => ({ default: m.AssetLibrary })));
export type ProjectAssetProps = { focusProject?: {id:string;request:number}; active: boolean; /** 已不使用：顶栏统一后资产页不再往顶栏放选择器；宿主移除传参前保留为可选。 */ projectSelectorHost?: HTMLElement | null; request: PromptRequest; activeProject: string; selectProject: (id: string) => void; refreshSeconds: number; onSettings: () => void; onOpenShot?: (target:ShotTarget)=>void;
  /** 宿主切换当前项目前调用登记的保护；返回 false 表示不切换（未保存修改被保留、或正在处理）。卸载时登记 null。 */
  registerProjectSwitchGuard?: (guard: (() => boolean) | null) => void };
export function ProjectAssetWorkspace(props: ProjectAssetProps) {
  const [started, setStarted] = useState(false); useEffect(() => { if (props.active) setStarted(true); }, [props.active]);
  return started ? <div hidden={!props.active}><Suspense fallback={<p style={{ padding: 24 }}>正在打开项目资产库…</p>}><Editor {...props}/></Suspense></div> : null;
}
