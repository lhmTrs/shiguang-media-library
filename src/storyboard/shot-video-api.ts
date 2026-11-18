import {useCallback, useEffect, useRef, useState} from 'react';
import {clipFromItem, rowsFromChanges, summariesFromState, v2ErrorText, type SelectionChange, type SelectionIntent, type ShotClip, type ShotSummaries} from './shot-video-model.mjs';
import type {StoryboardTransport} from './transport';
import type {ReviewWrite as V2ReviewWrite, SelectionPreview as V2SelectionPreview, SelectionWrite as V2SelectionWrite, ShotVideoPage, VideoV2State} from './video-binding-v2-types';

export type ShotClips = { selectionRevision: number; storyboardRevision: number; clips: ShotClip[] };
export type SelectionPreview = { previewHash: string; requiresConfirmation: boolean; rows: SelectionChange[] };
export type SelectionWrite = { intent: SelectionIntent; requestId: string; previewHash: string; confirmReplace: boolean };
export type ReviewWrite = { action: 'confirm' | 'undo'; clip: ShotClip; seenStoryboardRevision: number; requestId: string };
export interface ShotVideoApi {
  summaries(signal?: AbortSignal): Promise<ShotSummaries>;
  clips(shotId: string, signal?: AbortSignal): Promise<ShotClips>;
  previewSelection(intent: SelectionIntent): Promise<SelectionPreview>;
  writeSelection(write: SelectionWrite): Promise<void>;
  writeReview(write: ReviewWrite): Promise<void>;
}

const part = encodeURIComponent;
const PAGE_SIZE = 100;

export function createShotVideoApi(transport: Pick<StoryboardTransport, 'videoV2'>, projectId: string, token: () => string): ShotVideoApi {
  const project = '/projects/' + part(projectId);
  async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = {};
    if (body) {
      if (!token()) throw Object.assign(Error('素材库会话还没准备好，请稍后再试'), {code: 'LOCAL_SESSION_PENDING', status: 0});
      headers['Content-Type'] = 'application/json'; headers['X-Local-Token'] = token();
    }
    const response = await transport.videoV2(path, {method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal});
    const data = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(Error(v2ErrorText(data?.code, data?.message, '片子接口请求失败')), {code: data?.code, status: response.status, details: data?.details});
    return data as T;
  }
  return {
    summaries: async signal => summariesFromState(await call<VideoV2State>(project + '/state', undefined, signal)),
    async clips(shotId, signal) {
      const items: ShotVideoPage['items'] = [];
      let page: ShotVideoPage;
      do {
        page = await call<ShotVideoPage>(`${project}/shots/${part(shotId)}/videos?offset=${items.length}&limit=${PAGE_SIZE}`, undefined, signal);
        items.push(...page.items);
      } while (page.items.length && items.length < page.total);
      return {selectionRevision: page.context?.selectionRevision ?? 0, storyboardRevision: page.context?.storyboardRevision ?? 0, clips: items.map(clipFromItem)};
    },
    async previewSelection(intent) {
      const preview = await call<V2SelectionPreview>(project + '/selections/preview', intent);
      return {previewHash: preview.previewHash, requiresConfirmation: !!preview.requiresConfirmation, rows: rowsFromChanges(preview.changes)};
    },
    async writeSelection({intent, requestId, previewHash, confirmReplace}) {
      const body: V2SelectionWrite = {...intent, requestId, previewHash, ...(confirmReplace ? {confirmReplace: true as const} : {})};
      await call(project + '/selections', body);
    },
    async writeReview({action, clip, seenStoryboardRevision, requestId}) {
      if (!clip.comparisonHash) throw Object.assign(Error('这条片子现在无法核对，暂时不能复核'), {code: 'VIDEO_REVIEW_CONFLICT', status: 409});
      const body: V2ReviewWrite = {requestId, action, expectedBindingRevision: clip.bindingRevision, seenStoryboardRevision, expectedComparisonHash: clip.comparisonHash};
      await call(`/ui/source-projects/${part(clip.sourceProjectId)}/videos/${part(clip.id)}/review`, body);
    },
  };
}

/** 被动读取每镜摘要：不打断播放，读取失败时保留上一次结果。 */
export function useShotSummaries(api: ShotVideoApi, active: boolean) {
  const [data, setData] = useState<ShotSummaries | null>(null);
  const serial = useRef(0);
  const refresh = useCallback(async () => {
    const ticket = ++serial.current;
    try {
      const next = await api.summaries();
      if (ticket === serial.current) setData(next);
    } catch { /* 角标是辅助信息，读取失败不打断分镜编辑 */ }
  }, [api]);
  useEffect(() => { setData(null); }, [api]);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const again = () => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(again, 30000);
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    return () => { serial.current++; window.clearInterval(timer); window.removeEventListener('focus', again); document.removeEventListener('visibilitychange', again); };
  }, [active, refresh]);
  return {data, refresh};
}
