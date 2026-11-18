// 分镜视频绑定 v2 界面测试的装配页：真实组件 + 真实接口层 + 页面内按合同 v1 回应的合成后端。
import React, {useMemo, useState} from 'react';
import {createRoot} from 'react-dom/client';
import '../../src/themes.css';
import '../../src/style.css';
import '../../src/storyboard/storyboard.css';
import '../../src/project-videos/project-videos.css';
import {ShotVideoDialog} from '../../src/storyboard/ShotVideoDialog';
import {createShotVideoApi, useShotSummaries} from '../../src/storyboard/shot-video-api';
import {ShotBindingDialog} from '../../src/project-videos/ShotBindingDialog';
import {createShotBindingApi} from '../../src/project-videos/shot-binding-api';

const w = window as any;
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
const refuse = (code: string, status = 409) => json({code, message: '合成错误 ' + code}, status);

/** 取出测试注入的一次失败。network 表示写入结果未知（没有收到 HTTP 状态）。 */
function injected() {
  const failure = w.fake.fail; if (!failure) return null;
  w.fake.fail = null; failure.mutate && new Function('fake', failure.mutate)(w.fake);
  if (failure.network) throw TypeError(failure.message);
  return failure;
}

const videoOf = (id?: string) => w.fake.videos.find((video: any) => video.videoId === id);
const shotOf = (id?: string) => w.fake.shots.find((shot: any) => shot.shotId === id);
const viewOf = (selection: any) => selection && {...selection, name: videoOf(selection.videoId)?.name ?? '已移除的片子'};
const boundTo = (shotId: string) => w.fake.videos.filter((video: any) => video.binding.shots.some((shot: any) => shot.shotId === shotId));

function selectionChanges(intent: any) {
  const video = videoOf(intent.videoId);
  const live = () => video.binding.shots.filter((shot: any) => shot.existsInCurrent).map((shot: any) => shot.shotId);
  const ids = intent.action === 'adopt-video' ? live() : intent.action === 'clear-video' ? w.fake.shots.filter((shot: any) => shot.adopted?.videoId === intent.videoId).map((shot: any) => shot.shotId) : [intent.shotId];
  const adopting = intent.action.startsWith('adopt');
  const after = adopting ? {videoId: video.videoId, sourceProjectId: video.sourceProjectId, bindingId: video.binding.bindingId, kind: intent.action === 'adopt-shot' ? 'shot' : 'whole', selectedAt: 1700000000000} : null;
  return ids.map((shotId: string) => {
    const shot = shotOf(shotId);
    return {projectId: 'p1', shotId, number: shot.number, before: viewOf(shot.adopted), after: viewOf(after), stored: after};
  }).filter((row: any) => row.before?.videoId !== row.after?.videoId || row.before?.kind !== row.after?.kind);
}
const replaces = (rows: any[]) => rows.some(row => row.before);
const previewHash = (intent: any) => 'preview-' + w.fake.context.selectionRevision + '-' + intent.action + '-' + (intent.videoId ?? intent.shotId);
const staleSelection = (intent: any) => intent.expectedSelectionRevision !== w.fake.context.selectionRevision || intent.expectedStoryboardRevision !== w.fake.context.storyboardRevision;

async function videoV2(path: string, options: RequestInit = {}) {
  const response = await serveVideoV2(path, options);
  // 写入已生效但回应丢失：前端只能当作结果未知。
  if (options.method === 'POST' && !path.endsWith('/preview') && w.fake.dropResponse) { w.fake.dropResponse = false; throw TypeError('网络中断'); }
  return response;
}

async function serveVideoV2(path: string, options: RequestInit = {}) {
  const method = options.method ?? 'GET', body = options.body ? JSON.parse(String(options.body)) : undefined;
  w.fake.requests.push({method, path, headers: options.headers, body});
  const url = new URL(path, 'http://x'), route = url.pathname, {fake} = w;
  if (method !== 'GET') {
    const failure = injected();
    if (failure) return refuse(failure.code, failure.status ?? 409);
  }
  if (route === '/projects/p1/state') return json({schemaVersion: 2, initialized: true, context: fake.context, migration: fake.migration ?? null, shots: fake.shots.map((shot: any) => {
    const first = boundTo(shot.shotId)[0], chosen = shot.adopted ? videoOf(shot.adopted.videoId) : first;
    return {...shot, defaultVideo: chosen ? {videoId: chosen.videoId, sourceProjectId: chosen.sourceProjectId, bindingId: chosen.binding.bindingId, name: chosen.name} : null};
  })});
  const list = route.match(/^\/projects\/p1\/shots\/([^/]+)\/videos$/);
  if (list) {
    fake.clipReads = (fake.clipReads ?? 0) + 1;
    if (fake.migration?.adoptionKnown === false) return json({migration: fake.migration, context: fake.context, shotId: decodeURIComponent(list[1]), total: null, offset: 0, limit: 100, items: []});
    const all = boundTo(decodeURIComponent(list[1])), offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
    return json({migration: fake.migration ?? null, context: fake.context, shotId: decodeURIComponent(list[1]), total: all.length, offset, limit, items: all.slice(offset, offset + limit)});
  }
  if (route === '/projects/p1/selections/preview') {
    if (staleSelection(body)) return refuse('VIDEO_SELECTION_CONFLICT');
    const rows = selectionChanges(body);
    return json({context: fake.context, previewHash: previewHash(body), requiresConfirmation: replaces(rows), changes: rows.map(({stored, ...row}: any) => row)});
  }
  if (route === '/projects/p1/selections') {
    if (fake.done[body.requestId]) return json({context: fake.context, changes: [], requestId: body.requestId, repeated: true});
    if (staleSelection(body) || body.previewHash !== previewHash(body)) return refuse('VIDEO_SELECTION_CONFLICT');
    const rows = selectionChanges(body);
    if (replaces(rows) && body.confirmReplace !== true) return refuse('VIDEO_REPLACEMENT_CONFIRMATION_REQUIRED');
    for (const row of rows) { const shot = shotOf(row.shotId); shot.adopted = row.stored; shot.newVideoCount = 0; }
    fake.context.selectionRevision++; fake.done[body.requestId] = true;
    return json({context: fake.context, changes: rows, requestId: body.requestId, repeated: false});
  }
  const review = route.match(/^\/ui\/source-projects\/([^/]+)\/videos\/([^/]+)\/review$/);
  if (review) {
    const video = videoOf(decodeURIComponent(review[2]));
    if (body.expectedBindingRevision !== video.binding.revision || body.expectedComparisonHash !== video.review.comparisonHash) return refuse('VIDEO_REVIEW_CONFLICT');
    video.binding.revision++;
    if (body.action === 'confirm') Object.assign(video.review, {needsReview: false, reasons: [], reviewedToRevision: body.seenStoryboardRevision, reviewedAt: 1700000000000});
    else Object.assign(video.review, {needsReview: true, reasons: fake.reasonsAfterUndo ?? [{category: 'action', shotIds: []}], reviewedToRevision: null, reviewedAt: null});
    return json({context: fake.context, binding: video.binding, review: video.review, requestId: body.requestId, repeated: false});
  }
  return refuse('VIDEO_V2_NOT_FOUND', 404);
}

/** 模仿宿主 api()：失败时只认 error 字段，所以合同的 message 到不了界面。 */
const bindingRequest = async (url: string, body?: any, method?: string): Promise<any> => {
  const verb = method ?? (body ? 'POST' : 'GET'), {fake} = w;
  fake.requests.push({method: verb, path: url, body});
  const fail = (code: string, status = 409) => { throw Object.assign(Error('请求失败'), {code, status}); };
  const storyboard = url.match(/^\/storyboard\/projects\/(.+)$/);
  if (storyboard) { const record = fake.episodes[storyboard[1]]; if (!record) fail('NOT_FOUND', 404); return copy(record); }
  if (verb !== 'GET') { const failure = injected(); if (failure) fail(failure.code, failure.status ?? 409); }
  if (!url.startsWith('/storyboard-video/v2/source-projects/e1/videos/v1/binding')) fail('VIDEO_V2_NOT_FOUND', 404);
  if (verb === 'GET') return copy(fake.binding);
  if (body.expectedBindingRevision !== fake.binding.bindingRevision) fail('VIDEO_BINDING_CONFLICT');
  const affected = fake.affected ?? [];
  if (url.endsWith('/preview')) return {previewHash: 'binding-' + fake.binding.bindingRevision, before: null, after: null, contexts: [], affectedShots: affected, requiresConfirmation: affected.length > 0};
  fake.binding.bindingRevision++; fake.saves = (fake.saves ?? 0) + 1;
  return {context: null, binding: null, review: null, changes: [], requestId: body.requestId, repeated: false};
};

function ShotHarness({shotId, shotNumber}: {shotId: string; shotNumber: string}) {
  const api = useMemo(() => createShotVideoApi({videoV2} as any, 'p1', () => 'test-token'), []);
  const {data, refresh} = useShotSummaries(api, true);
  const [open, setOpen] = useState(true);
  return <div className="sb-app">{open && data && <ShotVideoDialog api={api} shotId={shotId} shotNumber={shotNumber} summaries={data.shots} onChanged={refresh} onClose={() => setOpen(false)}/>}{!open && <p>已关闭</p>}</div>;
}

function BindingHarness({video, projectId}: {video: any; projectId: string}) {
  const [open, setOpen] = useState(true);
  const api = useMemo(() => createShotBindingApi(bindingRequest as any, projectId), [projectId]);
  return <div className="pv-workspace">{open ? <ShotBindingDialog video={video} projectId={projectId} projects={w.fake.projects} api={api} onSaved={() => { w.fake.saved = (w.fake.saved ?? 0) + 1; }} onClose={() => setOpen(false)}/> : <p>已关闭</p>}</div>;
}

let root: ReturnType<typeof createRoot> | null = null;
const mount = (node: React.ReactNode) => { root?.unmount(); root = createRoot(document.getElementById('root')!); root.render(node); };
w.mountShot = (fake: any, shotId: string, shotNumber: string) => { w.fake = {requests: [], done: {}, ...fake}; mount(<ShotHarness shotId={shotId} shotNumber={shotNumber}/>); };
w.mountBinding = (fake: any, video: any, projectId: string) => { w.fake = {requests: [], ...fake}; mount(<BindingHarness video={video} projectId={projectId}/>); };
