import {useCallback, useEffect, useRef, useState} from 'react';
import type {SelectionAction, ShotClip, ShotVideoSummary} from './shot-video-model.mjs';
import type {StoryboardTransport} from './transport';

export type ShotSummaries = { selectionRevision: number; shots: Record<string, ShotVideoSummary> };
export type ShotClips = { selectionRevision: number; storyboardRevision: number; clips: ShotClip[] };
export type SelectionWrite = { action: SelectionAction; videoId: string; shotId: string; expectedRevision: number; requestId: string };
export type ReviewWrite = { action: 'mark' | 'undo'; videoId: string; expectedBindingRevision: number; storyboardRevision: number; requestId: string };
export interface ShotVideoApi {
  summaries(signal?: AbortSignal): Promise<ShotSummaries>;
  clips(shotId: string, signal?: AbortSignal): Promise<ShotClips>;
  writeSelection(write: SelectionWrite): Promise<void>;
  writeReview(write: ReviewWrite): Promise<void>;
}

/** 接口合同冻结前的占位：界面只依赖 ShotVideoApi，合同到后只替换这里。 */
export function createShotVideoApi(_transport: StoryboardTransport, _projectId: string): ShotVideoApi {
  const pending = () => Promise.reject(Object.assign(Error('片子绑定接口尚未接入'), {code: 'BINDING_API_PENDING'}));
  return {summaries: pending, clips: pending, writeSelection: pending, writeReview: pending};
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
