// 分镜视频绑定 v2 界面测试的装配页：真实组件 + 页面内的合成数据，不连任何服务接口。
import React, {useMemo, useState} from 'react';
import {createRoot} from 'react-dom/client';
import '../../src/themes.css';
import '../../src/style.css';
import '../../src/storyboard/storyboard.css';
import '../../src/project-videos/project-videos.css';
import {ShotVideoDialog} from '../../src/storyboard/ShotVideoDialog';
import {useShotSummaries, type ShotVideoApi} from '../../src/storyboard/shot-video-api';
import {ShotBindingDialog} from '../../src/project-videos/ShotBindingDialog';
import type {ShotBindingApi} from '../../src/project-videos/shot-binding-api';

const w = window as any;
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const failIfAsked = () => {
  const failure = w.fake.fail; if (!failure) return;
  w.fake.fail = null; failure.mutate && new Function('fake', failure.mutate)(w.fake);
  throw Object.assign(Error(failure.message), {code: failure.code, status: failure.status ?? 409});
};

function applySelection(write: any) {
  const {summaries, clips} = w.fake, clip = clips.clips.find((c: any) => c.id === write.videoId);
  const adopted = {videoId: clip.id, videoName: clip.name, kind: write.action === 'adopt-shot' ? 'shot' : 'video'};
  const covered = clip.shots.filter((s: any) => s.currentNumber !== null).map((s: any) => s.shotId);
  const set = (id: string, value: any) => { summaries.shots[id] = {...summaries.shots[id], adopted: value, playVideoId: value?.videoId ?? null, newCount: 0}; };
  if (write.action === 'adopt-video') covered.forEach((id: string) => set(id, adopted));
  if (write.action === 'adopt-shot') set(write.shotId, adopted);
  if (write.action === 'clear-shot') set(write.shotId, null);
  if (write.action === 'clear-video') covered.filter((id: string) => summaries.shots[id]?.adopted?.videoId === clip.id).forEach((id: string) => set(id, null));
  summaries.selectionRevision++; clips.selectionRevision = summaries.selectionRevision;
}

const shotApi: ShotVideoApi = {
  summaries: async () => copy(w.fake.summaries),
  clips: async () => { w.fake.clipReads = (w.fake.clipReads ?? 0) + 1; return copy(w.fake.clips); },
  async writeSelection(write) { w.fake.writes.push(write); failIfAsked(); applySelection(write); },
  async writeReview(write) {
    w.fake.writes.push(write); failIfAsked();
    const clip = w.fake.clips.clips.find((c: any) => c.id === write.videoId);
    clip.bindingRevision++;
    if (write.action === 'mark') { clip.review = {revision: write.storyboardRevision, at: 1700000000000}; clip.needsReview = false; }
    else { clip.review = null; clip.needsReview = true; }
  },
};

function ShotHarness({shotId, shotNumber}: {shotId: string; shotNumber: string}) {
  const {data, refresh} = useShotSummaries(shotApi, true);
  const [open, setOpen] = useState(true);
  return <div className="sb-app">{open && data && <ShotVideoDialog api={shotApi} shotId={shotId} shotNumber={shotNumber} summaries={data.shots} onChanged={refresh} onClose={() => setOpen(false)}/>}{!open && <p>已关闭</p>}</div>;
}

function BindingHarness({video, projectId}: {video: any; projectId: string}) {
  const [open, setOpen] = useState(true);
  const api = useMemo<ShotBindingApi>(() => ({
    binding: async () => copy(w.fake.binding),
    episode: async id => copy(w.fake.episodes[id] ?? null),
    async save(write) { w.fake.writes.push(write); failIfAsked(); },
    async clear(write) { w.fake.writes.push(write); failIfAsked(); },
  }), []);
  return <div className="pv-workspace">{open ? <ShotBindingDialog video={video} projectId={projectId} projects={w.fake.projects} api={api} onSaved={() => { w.fake.saved = (w.fake.saved ?? 0) + 1; }} onClose={() => setOpen(false)}/> : <p>已关闭</p>}</div>;
}

let root: ReturnType<typeof createRoot> | null = null;
const mount = (node: React.ReactNode) => { root?.unmount(); root = createRoot(document.getElementById('root')!); root.render(node); };
w.mountShot = (fake: any, shotId: string, shotNumber: string) => { w.fake = {writes: [], ...fake}; mount(<ShotHarness shotId={shotId} shotNumber={shotNumber}/>); };
w.mountBinding = (fake: any, video: any, projectId: string) => { w.fake = {writes: [], ...fake}; mount(<BindingHarness video={video} projectId={projectId}/>); };
