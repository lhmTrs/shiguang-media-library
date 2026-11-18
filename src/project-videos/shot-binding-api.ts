import * as domain from '../../server/storyboard/shared/model.mjs';
import type {EpisodeShot, VideoBinding} from './shot-binding-model.mjs';
import type {ProjectVideoRequest} from './types';

const M: any = domain;
export type EpisodeStoryboard = { revision: number; shots: EpisodeShot[] };
export type BindingWrite = { videoId: string; projectId: string; revision: number; shotIds: string[]; expectedBindingRevision: number | null; requestId: string };
export type BindingClear = { videoId: string; expectedBindingRevision: number; requestId: string };
export interface ShotBindingApi {
  binding(videoId: string): Promise<VideoBinding | null>;
  episode(projectId: string): Promise<EpisodeStoryboard | null>;
  save(write: BindingWrite): Promise<void>;
  clear(write: BindingClear): Promise<void>;
}

export function episodeFromRecord(record: any): EpisodeStoryboard {
  const shots = M.timeline(record.project).map((row: any) => ({
    id: row.shot.id, number: String(row.number), sceneIndex: row.sceneIndex,
    sceneName: row.scene.location || row.scene.name || '未命名场次', durationMs: row.shot.duration_ms,
    summary: row.shot.action || row.shot.framing || '',
  }));
  return {revision: record.revision, shots};
}

/** 接口合同冻结前的占位：读镜头走现有分镜接口，绑定读写等合同后接入。 */
export function createShotBindingApi(request: ProjectVideoRequest, _projectId: string): ShotBindingApi {
  const pending = () => Promise.reject(Object.assign(Error('片子绑定接口尚未接入'), {code: 'BINDING_API_PENDING'}));
  return {
    binding: pending, save: pending, clear: pending,
    async episode(projectId) {
      try { return episodeFromRecord(await request<any>('/storyboard/projects/' + encodeURIComponent(projectId))); }
      catch (e) { if ((e as {status?: number}).status === 404) return null; throw e; }
    },
  };
}
