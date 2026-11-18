import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Modal, ModalActions} from './Modal';
import {boundText, episodeChoices, episodeLabel, initialShotIds, nextText, orderedShotIds, sameBinding, type BindingProject, type VideoBinding} from './shot-binding-model.mjs';
import type {EpisodeStoryboard, ShotBindingApi} from './shot-binding-api';
import type {ProjectVideo} from './types';

type Props = { video: ProjectVideo; projectId: string; projects: BindingProject[]; api: ShotBindingApi; onSaved: () => void; onClose: () => void };
const CONFLICT = new Set(['BINDING_CONFLICT', 'STORYBOARD_REVISION_CHANGED']);

export function ShotBindingDialog({video, projectId, projects, api, onSaved, onClose}: Props) {
  const [binding, setBinding] = useState<VideoBinding | null>(null), [ready, setReady] = useState(false);
  const [episodeId, setEpisodeId] = useState(projectId), [episode, setEpisode] = useState<EpisodeStoryboard | null | undefined>(undefined);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirmClear, setConfirmClear] = useState(false);
  const live = useRef(true), episodeTicket = useRef(0), bindingRef = useRef<VideoBinding | null>(null);
  const retry = useRef<{key: string; requestId: string} | null>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const openEpisode = async (id: string, current: VideoBinding | null) => {
    const ticket = ++episodeTicket.current;
    setEpisodeId(id); setEpisode(undefined); setSelected(new Set());
    try {
      const next = await api.episode(id);
      if (!live.current || ticket !== episodeTicket.current) return;
      setEpisode(next); setSelected(new Set(next ? initialShotIds(current, id, next.shots) : []));
    } catch (e) { if (live.current && ticket === episodeTicket.current) { setEpisode(null); setError((e as Error).message || '分镜读取失败'); } }
  };
  const load = async () => {
    setReady(false); setError('');
    let current: VideoBinding | null = null;
    try { current = await api.binding(video.id); }
    catch (e) { if (live.current) setError((e as Error).message || '绑定信息读取失败'); if (!live.current) return; setReady(false); await openEpisode(projectId, null); return; }
    if (!live.current) return;
    bindingRef.current = current; setBinding(current); setReady(true);
    await openEpisode(current?.projectId ?? projectId, current);
  };
  useEffect(() => { void load(); }, [video.id]);

  const choices = useMemo(() => episodeChoices(projects, projectId, binding?.projectId), [projects, projectId, binding?.projectId]);
  const project = choices.find(item => item.id === episodeId);
  const rows = episode?.shots ?? [];
  const shotIds = orderedShotIds(rows, selected);
  const unchanged = !!episode && sameBinding(binding, episodeId, episode.revision, shotIds);
  const canSave = ready && !!episode && !busy && shotIds.length > 0 && !unchanged;
  const scenes = useMemo(() => {
    const groups: {index: number; name: string; shots: typeof rows}[] = [];
    for (const row of rows) { const last = groups[groups.length - 1]; if (last?.index === row.sceneIndex) last.shots.push(row); else groups.push({index: row.sceneIndex, name: row.sceneName, shots: [row]}); }
    return groups;
  }, [episode]);
  const toggle = (id: string, on: boolean) => setSelected(old => { const next = new Set(old); if (on) next.add(id); else next.delete(id); return next; });

  const submit = async (key: string, send: (requestId: string) => Promise<void>) => {
    const requestId = retry.current?.key === key ? retry.current.requestId : crypto.randomUUID();
    retry.current = {key, requestId}; setBusy(true); setError('');
    try { await send(requestId); retry.current = null; if (live.current) { onSaved(); onClose(); } }
    catch (e) {
      const failure = e as Error & {code?: string; status?: number};
      if (failure.status) retry.current = null;
      if (!live.current) return;
      setConfirmClear(false);
      if (CONFLICT.has(failure.code ?? '')) { await load(); setError('绑定或分镜刚被改过，这次没有保存。已读取最新内容，请重新核对。'); }
      else setError(failure.message || '保存失败，请重试');
    } finally { if (live.current) setBusy(false); }
  };
  const save = () => { if (!episode) return; const expected = bindingRef.current?.bindingRevision ?? null; void submit(['save', episodeId, episode.revision, shotIds.join(','), expected].join(':'), requestId => api.save({videoId: video.id, projectId: episodeId, revision: episode.revision, shotIds, expectedBindingRevision: expected, requestId})); };
  const clear = () => { const expected = bindingRef.current?.bindingRevision; if (expected == null) return; void submit(['clear', expected].join(':'), requestId => api.clear({videoId: video.id, expectedBindingRevision: expected, requestId})); };

  return <Modal title="对应到分镜镜头" locked={busy} onClose={onClose} className="pv-binding-modal">
    <p className="pv-binding-video">片子：<strong>{video.name}</strong></p>
    {error && <p className="pv-error" role="alert">{error}</p>}
    <section className="pv-binding-now" aria-label="当前绑定">
      <h3>现在对应</h3>
      <p>{ready ? boundText(binding, projects) : '正在读取…'}</p>
      {binding && <small>{binding.origin === 'manual' ? '手动对应' : '生成时记录'} · {new Date(binding.boundAt).toLocaleString('zh-CN', {hour12: false})}</small>}
      {binding?.needsReview && <span className="pv-binding-review">需复核：绑定后分镜内容改过，片子仍可播放</span>}
    </section>
    <label className="pv-field">选集
      <select aria-label="选集" value={episodeId} disabled={busy} onChange={e => void openEpisode(e.target.value, bindingRef.current)}>
        {choices.map(item => <option key={item.id} value={item.id}>{episodeLabel(item)}</option>)}
      </select>
    </label>
    {episode === undefined && <p role="status">正在读取分镜…</p>}
    {episode === null && !error && <p className="pv-notice">这一集还没有分镜。</p>}
    {episode && <fieldset className="pv-binding-shots" disabled={busy}>
      <legend>勾选这条片子对应的镜头（第 {episode.revision} 版）</legend>
      {scenes.map(scene => <div key={scene.index}>
        <h4>场 {String(scene.index + 1).padStart(2, '0')} · {scene.name}</h4>
        {scene.shots.map(shot => <label key={shot.id} className="pv-binding-shot">
          <input type="checkbox" aria-label={'镜 ' + shot.number} checked={selected.has(shot.id)} onChange={e => toggle(shot.id, e.target.checked)}/>
          <strong>镜 {shot.number}</strong><small>{(shot.durationMs / 1000).toFixed(1)} 秒</small><span>{shot.summary}</span>
        </label>)}
      </div>)}
    </fieldset>}
    {episode && project && !unchanged && shotIds.length > 0 && <dl className="pv-binding-diff" aria-label="保存前后">
      <div><dt>现在</dt><dd>{boundText(binding, projects)}</dd></div>
      <div><dt>保存后</dt><dd>{nextText(project, episode.revision, rows, selected)}</dd></div>
    </dl>}
    {confirmClear && <div className="pv-callout" role="alertdialog" aria-label="确认解除对应">
      <strong>解除这条片子的镜头对应？</strong><span>现在：{boundText(binding, projects)}</span><span>解除后：还没有对应镜头。片子文件和视频记录不动。</span>
      <div className="pv-actions"><button type="button" disabled={busy} onClick={() => setConfirmClear(false)}>取消</button><button type="button" className="pv-danger" disabled={busy} onClick={clear}>确认解除</button></div>
    </div>}
    <ModalActions>
      {binding ? <button type="button" className="pv-danger" disabled={busy || confirmClear} onClick={() => setConfirmClear(true)}>解除对应</button> : <span/>}
      <button type="button" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="pv-primary" disabled={!canSave} onClick={save}>保存对应</button>
    </ModalActions>
  </Modal>;
}
