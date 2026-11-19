import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Modal, ModalActions} from './Modal';
import {
  bindIntent, bindingOriginText, boundText, episodeLabel, initialShotIds, nextText, orderedShotIds, releasedShotRefs, sameBinding, targetChoices, unbindIntent,
  type BindingIntent, type BindingPreview, type BindingProject, type BindingRead,
} from './shot-binding-model.mjs';
import {migrationText} from '../storyboard/shot-video-model.mjs';
import type {EpisodeStoryboard, ShotBindingApi} from './shot-binding-api';
import type {ProjectVideo} from './types';

type Props = { video: ProjectVideo; projectId: string; projects: BindingProject[]; api: ShotBindingApi; onSaved: () => void; onClose: () => void };
type Plan = { intent: BindingIntent; preview: BindingPreview };
const CONFLICT = new Set(['VIDEO_BINDING_CONFLICT', 'VIDEO_SELECTION_CONFLICT', 'STORYBOARD_CONFLICT', 'ASSET_CONTEXT_CHANGED', 'VIDEO_TARGET_SCOPE_CHANGED', 'VIDEO_REPLACEMENT_CONFIRMATION_REQUIRED', 'UNBIND_CONFIRMATION_REQUIRED', 'VIDEO_UNBIND_SCOPE_REQUIRED']);

export function ShotBindingDialog({video, projectId, projects, api, onSaved, onClose}: Props) {
  const [state, setState] = useState<BindingRead | null>(null);
  const [episodeId, setEpisodeId] = useState(''), [episode, setEpisode] = useState<EpisodeStoryboard | null | undefined>(undefined);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [plan, setPlan] = useState<Plan | null>(null);
  const live = useRef(true), episodeTicket = useRef(0), planRef = useRef<HTMLDivElement>(null);
  // 结果未知的写入：同一操作再点时原样重发同一请求，不重新预览。
  const retry = useRef<{key: string; requestId: string; again: () => Promise<void>} | null>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const binding = state?.binding ?? null, migration = state?.migration ?? null, writesOff = !!migration?.blocked || state?.bindingRevision === null, relationUnknown = migration?.adoptionKnown === false || state?.bindingRevision === null;
  // 确认内容在弹窗底部，打开时滚到能看见确认按钮的位置。
  useEffect(() => { if (plan) planRef.current?.scrollIntoView?.({block: 'nearest'}); }, [plan]);

  const openEpisode = async (id: string, current: BindingRead) => {
    const ticket = ++episodeTicket.current;
    setEpisodeId(id); setEpisode(undefined); setSelected(new Set());
    try {
      const next = await api.episode(id);
      if (!live.current || ticket !== episodeTicket.current) return;
      setEpisode(next); setSelected(new Set(next ? initialShotIds(current.binding, id, next.shots) : []));
    } catch (e) { if (live.current && ticket === episodeTicket.current) { setEpisode(null); setError((e as Error).message || '分镜读取失败'); } }
  };
  const load = async () => {
    setError(''); setPlan(null);
    let current: BindingRead;
    try { current = await api.read(video.id); }
    catch (e) { if (live.current) { setState(null); setEpisode(null); setError((e as Error).message || '绑定信息读取失败'); } return; }
    if (!live.current) return;
    setState(current);
    if (current.migration?.blocked || current.bindingRevision === null) { setEpisode(null); return; }
    const allowed = current.targets.map(target => target.projectId);
    const first = current.binding?.projectId ?? (allowed.includes(projectId) ? projectId : allowed[0]);
    if (first) await openEpisode(first, current); else setEpisode(null);
  };
  useEffect(() => { void load(); }, [video.id]);

  const choices = useMemo(() => targetChoices(state?.targets ?? [], projects, binding?.projectId, binding?.projectName), [state, projects, binding?.projectId, binding?.projectName]);
  const project = choices.find(item => item.id === episodeId);
  const rows = episode?.shots ?? [];
  const shotIds = orderedShotIds(rows, selected);
  const unchanged = !!episode && sameBinding(binding, episodeId, episode.revision, shotIds);
  const canSave = !writesOff && !!state && !!episode && !!project?.selectable && !busy && shotIds.length > 0 && !unchanged;
  const scenes = useMemo(() => {
    const groups: {index: number; name: string; shots: typeof rows}[] = [];
    for (const row of rows) { const last = groups[groups.length - 1]; if (last?.index === row.sceneIndex) last.shots.push(row); else groups.push({index: row.sceneIndex, name: row.sceneName, shots: [row]}); }
    return groups;
  }, [episode]);
  const toggle = (id: string, on: boolean) => setSelected(old => { const next = new Set(old); if (on) next.add(id); else next.delete(id); return next; });

  const failed = async (e: unknown) => {
    const failure = e as Error & {code?: string};
    if (!live.current) return;
    setPlan(null);
    if (CONFLICT.has(failure.code ?? '')) { await load(); if (live.current) setError('绑定或分镜刚被改过，这次没有保存。已读取最新内容，请重新核对。'); }
    else setError(failure.message || '保存失败，请重试');
  };
  const commit = async (key: string, next: Plan) => {
    const requestId = retry.current?.key === key ? retry.current.requestId : crypto.randomUUID();
    retry.current = {key, requestId, again: () => commit(key, next)};
    setBusy(true); setError('');
    try {
      await api.write({videoId: video.id, intent: next.intent, requestId, previewHash: next.preview.previewHash, confirmedUnbindShotRefs: next.preview.requiresConfirmation ? releasedShotRefs(next.preview.rows) : null});
      retry.current = null;
      if (live.current) { onSaved(); onClose(); }
    } catch (e) {
      if ((e as {status?: number}).status) retry.current = null;
      await failed(e);
    } finally { if (live.current) setBusy(false); }
  };
  const begin = async (intent: BindingIntent) => {
    const key = JSON.stringify(intent);
    if (retry.current?.key === key) return retry.current.again();
    setBusy(true); setError('');
    try {
      const preview = await api.preview(video.id, intent);
      if (!live.current) return;
      if (preview.requiresConfirmation || intent.action === 'unbind') setPlan({intent, preview});
      else await commit(key, {intent, preview});
    } catch (e) { await failed(e); }
    finally { if (live.current) setBusy(false); }
  };
  const save = () => { if (state?.bindingRevision != null && !writesOff && episode) void begin(bindIntent(state.bindingRevision, episodeId, episode, shotIds)); };
  const clear = () => { if (state?.bindingRevision != null && !writesOff) void begin(unbindIntent(state.bindingRevision)); };
  const unbinding = plan?.intent.action === 'unbind';

  return <Modal title="对应到分镜镜头" locked={busy} onClose={onClose} className="pv-binding-modal">
    <p className="pv-binding-video">片子：<strong>{video.name}</strong></p>
    {error && <p className="pv-error" role="alert">{error}</p>}
    {migration && <p className="pv-notice" role="status">{migrationText(migration)}</p>}
    <section className="pv-binding-now" aria-label="当前绑定">
      <h3>现在对应</h3>
      <p>{state ? (relationUnknown ? '绑定关系暂时无法确认' : boundText(binding, choices)) : error ? '没有读到' : '正在读取…'}</p>
      {binding && <small>{bindingOriginText(binding)} · {new Date(binding.boundAt).toLocaleString('zh-CN', {hour12: false})}</small>}
      {binding?.needsReview && <span className="pv-binding-review">需复核：绑定后内容有变化，片子仍可播放</span>}
    </section>
    {state && !writesOff && !choices.length && <p className="pv-notice">这个项目没有可对应的分镜集。</p>}
    {!writesOff && !!choices.length && <label className="pv-field">选集
      <select aria-label="选集" value={episodeId} disabled={busy} onChange={e => { if (state) void openEpisode(e.target.value, state); }}>
        {choices.map(item => <option key={item.id} value={item.id} disabled={!item.selectable}>{episodeLabel(item)}{item.selectable ? '' : '（已不在可选范围）'}</option>)}
      </select>
    </label>}
    {state && episode === undefined && <p role="status">正在读取分镜…</p>}
    {state && !writesOff && episode === null && !error && !!choices.length && <p className="pv-notice">这一集还没有分镜。</p>}
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
      <div><dt>现在</dt><dd>{boundText(binding, choices)}</dd></div>
      <div><dt>保存后</dt><dd>{nextText(project, episode.revision, rows, selected)}</dd></div>
    </dl>}
    {plan && <div ref={planRef} className="pv-callout pv-binding-confirm" role="alertdialog" aria-label={unbinding ? '确认解除对应' : '确认修改对应'}>
      <strong>{unbinding ? '解除这条片子的镜头对应？' : '修改对应会解除下面的采用'}</strong>
      <span>现在：{boundText(binding, choices)}</span>
      <span>{unbinding ? '解除后：还没有对应镜头。' : '保存后：' + (project && episode ? nextText(project, episode.revision, rows, selected) : '') + '。'}片子文件和视频记录不动。</span>
      {!!plan.preview.rows.length && <table className="pv-binding-affected"><thead><tr><th>集</th><th>镜头</th><th>现在</th><th>确认后</th></tr></thead>
        <tbody>{plan.preview.rows.map(row => <tr key={row.projectId + ':' + row.shotId}><td>{row.projectName}</td><td>镜 {row.number}</td><td>{row.beforeText}</td><td>{row.afterText}</td></tr>)}</tbody></table>}
      <div className="pv-actions"><button type="button" disabled={busy} onClick={() => setPlan(null)}>取消</button><button type="button" className="pv-danger" disabled={busy} onClick={() => void commit(JSON.stringify(plan.intent), plan)}>{unbinding ? '确认解除' : '确认修改'}</button></div>
    </div>}
    <ModalActions>
      {binding ? <button type="button" className="pv-danger" disabled={busy || writesOff || !!plan} onClick={clear}>解除对应</button> : <span/>}
      <button type="button" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="pv-primary" disabled={!canSave || !!plan} onClick={save}>保存对应</button>
    </ModalActions>
  </Modal>;
}
