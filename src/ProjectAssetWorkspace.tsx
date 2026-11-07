import React, { lazy, Suspense, useEffect, useState } from 'react';
import type { PromptRequest } from './PromptTemplateWorkspace';
import type { ShotTarget } from './storyboard/shot-navigation';
const Editor = lazy(() => import('./project-assets/AssetLibrary').then(m => ({ default: m.AssetLibrary })));
export type ProjectAssetProps = { focusProject?: {id:string;request:number}; active: boolean; projectSelectorHost: HTMLElement | null; request: PromptRequest; activeProject: string; selectProject: (id: string) => void; refreshSeconds: number; onSettings: () => void; onOpenShot?: (target:ShotTarget)=>void };
export function ProjectAssetWorkspace(props: ProjectAssetProps) {
  const [started, setStarted] = useState(false); useEffect(() => { if (props.active) setStarted(true); }, [props.active]);
  return started ? <div hidden={!props.active}><Suspense fallback={<p style={{ padding: 24 }}>正在打开项目资产库…</p>}><Editor {...props}/></Suspense></div> : null;
}
