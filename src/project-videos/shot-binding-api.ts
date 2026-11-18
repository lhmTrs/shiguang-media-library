import * as domain from '../../server/storyboard/shared/model.mjs';
import {v2ErrorText} from '../storyboard/shot-video-model.mjs';
import {bindingFromResponse, previewFromResponse, type BindingIntent, type BindingPreview, type BindingRead, type EpisodeShot, type UnbindShotRef} from './shot-binding-model.mjs';
import type {ProjectVideoRequest} from './types';

const M: any = domain;
export type EpisodeStoryboard = { revision: number; assetStamp: string | null; shots: EpisodeShot[] };
export type BindingWrite = { videoId: string; intent: BindingIntent; requestId: string; previewHash: string; confirmedUnbindShotRefs: UnbindShotRef[] | null };
export interface ShotBindingApi {
  read(videoId: string): Promise<BindingRead>;
  episode(projectId: string): Promise<EpisodeStoryboard | null>;
  preview(videoId: string, intent: BindingIntent): Promise<BindingPreview>;
  write(write: BindingWrite): Promise<void>;
}

export function episodeFromRecord(record: any): EpisodeStoryboard {
  const shots = M.timeline(record.project).map((row: any) => ({
    id: row.shot.id, number: String(row.number), sceneIndex: row.sceneIndex,
    sceneName: row.scene.location || row.scene.name || '未命名场次', durationMs: row.shot.duration_ms,
    summary: row.shot.action || row.shot.framing || '',
  }));
  return {revision: record.revision, assetStamp: record.asset_stamp ?? null, shots};
}

export function createShotBindingApi(request: ProjectVideoRequest, sourceProjectId: string): ShotBindingApi {
  const path = (videoId: string) => `/storyboard-video/v2/source-projects/${encodeURIComponent(sourceProjectId)}/videos/${encodeURIComponent(videoId)}/binding`;
  // 后端会同时给 error 和 message；旧服务或网络异常时按错误码兜底。
  const call = async <T,>(url: string, body?: unknown, method?: string): Promise<T> => {
    try { return await request<T>(url, body, method); }
    catch (e) { const failure = e as Error & {code?: string}; failure.message = v2ErrorText(failure.code, failure.message); throw failure; }
  };
  return {
    read: async videoId => bindingFromResponse(await call<any>(path(videoId))),
    async episode(projectId) {
      try { return episodeFromRecord(await request<any>('/storyboard/projects/' + encodeURIComponent(projectId))); }
      catch (e) { if ((e as {status?: number}).status === 404) return null; throw e; }
    },
    preview: async (videoId, intent) => previewFromResponse(await call<any>(path(videoId) + '/preview', intent)),
    async write({videoId, intent, requestId, previewHash, confirmedUnbindShotRefs}) {
      await call(path(videoId), {...intent, requestId, previewHash, ...(confirmedUnbindShotRefs ? {confirmUnbind: true, confirmedUnbindShotRefs} : {})}, 'PUT');
    },
  };
}
