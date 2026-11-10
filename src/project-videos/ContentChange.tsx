import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Play, RefreshCw } from 'lucide-react';
import { Modal, ModalActions } from './Modal';
import { actionPending, useDesktopAction, type DesktopReceipt } from './desktop-actions';
import type { ProjectVideo, ProjectVideoCollection, ProjectVideoRequest } from './types';

/*
 * 合同 D（#52）：视频内容确实变化时，由用户预览后决定“继续使用”或“不再使用”。
 * 任务状态（原请求编号、回执、确认勾选）保存在项目会话层的 useContentChange 里，弹窗只负责显示：
 * 关闭弹窗、切到别的页面或项目再回来，原请求仍可查询，不会另起核对或重发写操作。
 * - 打开即核对（changes/preview）；冻结的当前内容只在用户点击后播放；原内容未保留，不伪造对照。
 * - 继续使用：明确勾选接受；新时长导致越界的采用必须精确确认解除（镜号本身保留）。
 * - 不再使用：先取得移除影响（remove/preview），文件每次单选保留或移到废纸篓，再明确确认。
 * - 写操作成功的终态只通知父层一次（刷新列表），与用户用哪种方式退出无关。
 * - “重新核对”先读取这条视频的最新修订，再发只读的新核对；不重发原写请求。
 */
const duration = (ms?: number) => !ms || !Number.isFinite(ms) ? '未知' : `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const size = (n?: number) => !n ? '未知' : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const shots = (list?: { number: number | string }[]) => (list || []).map(s => `镜 ${s.number}`).join('、');
// 按证据表述文件处理结果：kept 只说明本次没有移动文件，不断言文件仍在原位置
const fileText = (f?: DesktopReceipt['file']) => f?.status === 'kept' ? '本次没有移动或删除文件'
  : f?.status === 'trashed' ? '已移到系统废纸篓'
  : f?.status === 'failed' ? `没有移到废纸篓，本次没有移动文件${f.reason ? `（${f.reason}）` : ''}`
  : '处理结果待核对';

export type ContentChangeController = ReturnType<typeof useContentChange>;

export function useContentChange(projectId: string, request: ProjectVideoRequest, onChanged: (videoId: string, removed: boolean) => void) {
  const act = useDesktopAction(projectId, request);
  const [video, setVideo] = useState<ProjectVideo | null>(null), [visible, setVisible] = useState(false);
  const [revision, setRevision] = useState(0), [notice, setNotice] = useState('');
  const [view, setView] = useState<'review' | 'remove'>('review');
  const [playing, setPlaying] = useState(false), [acceptOk, setAcceptOk] = useState(false), [unbindOk, setUnbindOk] = useState(false);
  const [fileAction, setFileAction] = useState<'' | 'keep' | 'trash'>(''), [removeOk, setRemoveOk] = useState(false);
  const preview = useRef<DesktopReceipt | null>(null), removal = useRef<DesktopReceipt | null>(null), notified = useRef(new Set<string>());
  const changedRef = useRef(onChanged); changedRef.current = onChanged;
  const a = act.action, r = a?.receipt || null, pending = actionPending(a);
  if (a?.kind === 'change-preview' && r?.status === 'ready') preview.current = r;
  if (a?.kind === 'remove-preview' && r?.status === 'ready') removal.current = r;
  const fileUnknown = a?.kind === 'remove' && !!r?.record?.removed && r?.file?.status === 'unknown';
  // 未结清：请求进行中、结果待核对、或记录已移除但文件结果未知
  const unresolved = !!a && (pending || a.unknown || fileUnknown);

  // 写操作的成功终态只通知一次（刷新列表 / 取消选中），无论用户用哪种方式退出
  useEffect(() => {
    if (!a || !r || !video || notified.current.has(a.requestId) || pending || a.error) return;
    const accepted = a.kind === 'accept-change' && r.status === 'completed' && !a.unknown;
    const removed = a.kind === 'remove' && !!r.record?.removed && ['completed', 'partial', 'unknown'].includes(r.status);
    if (accepted || removed) { notified.current.add(a.requestId); changedRef.current(video.id, removed); }
  }, [a, r, pending]);

  function reset() { setPlaying(false); setAcceptOk(false); setUnbindOk(false); setFileAction(''); setRemoveOk(false); }
  function start(kind: 'change-preview' | 'remove-preview', target: ProjectVideo, rev: number) {
    act.clear(true); reset(); setNotice('');
    if (kind === 'change-preview') { preview.current = null; removal.current = null; setView('review'); } else { removal.current = null; setView('remove'); }
    void act.start(kind, [target.id], { expectedRevision: rev });
  }
  /** 打开：同一视频已有任务时只恢复显示，不另起核对；别的视频有未结清任务时不开始新任务。 */
  function open(target: ProjectVideo) {
    if (video?.id === target.id && a) { setVisible(true); return true; }
    if (video && unresolved) { setVisible(true); return false; }
    setVideo(target); setRevision(target.revision); setVisible(true); start('change-preview', target, target.revision); return true;
  }
  /** 重新核对：先读取这条视频的最新资料与修订（只读 GET），再发新的只读核对。 */
  async function recheck(kind: 'change-preview' | 'remove-preview') {
    if (!video) return;
    try {
      const list = await request<ProjectVideoCollection>(`/project-videos/projects/${encodeURIComponent(projectId)}?folderId=all`);
      const latest = list.videos.find(v => v.id === video.id);
      if (!latest) { act.clear(true); preview.current = null; removal.current = null; setNotice('这条视频记录已经不存在，无需再处理。'); return; }
      setVideo(latest); setRevision(latest.revision); start(kind, latest, latest.revision);
    } catch (e) { setNotice(`读取最新资料失败：${e instanceof Error ? e.message : String(e)}。稍后再试。`); }
  }
  /** 收起：已结清的任务一并清除；未结清的保留，可从页面顶部重新打开。 */
  function hide() {
    setVisible(false);
    if (!unresolved) { act.clear(true); setVideo(null); preview.current = null; removal.current = null; reset(); setNotice(''); }
  }
  function forget() { act.clear(true); setVisible(false); setVideo(null); preview.current = null; removal.current = null; reset(); setNotice(''); }
  function accept() {
    const p = preview.current; if (!video || !p) return;
    const invalid = (p.invalidAdoptedShots || []).map(s => s.id);
    act.clear(); void act.start('accept-change', [video.id], { expectedRevision: revision, adoptionStamp: p.adoptionStamp, contentToken: p.contentToken, confirmAcceptContent: true, confirmedUnbindShotIds: invalid });
  }
  function remove() {
    const rp = removal.current; if (!video || !rp || !fileAction) return;
    act.clear(); void act.start('remove', [video.id], { expectedRevision: revision, adoptionStamp: rp.adoptionStamp, removalToken: rp.removalToken, confirmUnbind: true, fileAction });
  }
  return {
    act, video, visible, setVisible, unresolved, fileUnknown, notice, view, setView, playing, setPlaying, acceptOk, setAcceptOk, unbindOk, setUnbindOk,
    fileAction, setFileAction, removeOk, setRemoveOk, preview: preview.current, removal: removal.current,
    open, recheck, hide, forget, accept, remove, startRemove: () => { if (video) start('remove-preview', video, revision); },
  };
}

/** 页面顶部的入口：弹窗收起后，未结清的任务仍可重新打开或查询原请求。 */
export function ContentChangeBanner({ ctl }: { ctl: ContentChangeController }) {
  if (!ctl.video || ctl.visible || !ctl.unresolved) return null;
  const a = ctl.act.action;
  return <div className="pv-banner" data-tone="warn" role="status">
    <AlertTriangle size={15}/><span className="pv-banner-text">内容变化处理：“{ctl.video.name || ctl.video.fileName}” {actionPending(a) ? '处理中' : ctl.fileUnknown ? '记录已移除，文件处理结果待核对' : '结果待核对'}{a ? <> <code>{a.requestId}</code></> : null}</span>
    {!actionPending(a) && <button type="button" onClick={() => void ctl.act.query()}><RefreshCw size={13}/>查询原请求</button>}
    <button type="button" onClick={() => ctl.setVisible(true)}>打开</button>
  </div>;
}

export function ContentChangeDialog({ ctl }: { ctl: ContentChangeController }) {
  const video = ctl.video; if (!video) return null;
  const a = ctl.act.action, r = a?.receipt || null, pending = actionPending(a), p = ctl.preview, rp = ctl.removal;
  const invalid = p?.invalidAdoptedShots || [], affected = p?.affectedAdoptedShots || [], removeShots = rp?.affectedAdoptedShots || [];
  const done = a && !pending && !a.unknown && !a.error && r && ['completed', 'partial'].includes(r.status) && (a.kind === 'accept-change' || a.kind === 'remove');

  let body: React.ReactNode = null, actions: React.ReactNode = null;
  if (ctl.notice && !a) {
    body = <p className="pv-muted" role="status">{ctl.notice}</p>;
    actions = <button type="button" className="pv-primary" onClick={ctl.forget}>关闭</button>;
  } else if (a && pending) {
    body = <div className="pv-task" role="status"><strong>{{ 'change-preview': '正在核对当前文件…', 'remove-preview': '正在核对移除影响…', 'accept-change': '正在接受当前内容…', remove: '正在移除记录…' }[a.kind as string] || '处理中…'}</strong>{!!r?.total && <progress value={r.processed || 0} max={r.total}/>}{!r?.total && <progress aria-label="处理中"/>}<p className="pv-muted">可以关闭窗口继续浏览，结果会保留在页面顶部。</p></div>;
  } else if (a?.unknown) {
    body = <div className="pv-task" role="status"><strong>结果待核对</strong><p>{a.error || r?.error || '没有取得最终结果。原操作可能仍在进行或已经完成。'}</p><p>请求编号：<code>{a.requestId}</code></p><p className="pv-muted">只会查询原请求，不会重新提交。</p></div>;
    actions = <><button type="button" onClick={ctl.forget}>已核对，收起</button><button type="button" className="pv-primary" onClick={() => void ctl.act.query()}><RefreshCw size={14}/>查询原请求</button></>;
  } else if (a?.error) {
    body = <p className="pv-error" role="alert">{a.code === 'VIDEO_IN_USE' ? '这个视频正在播放或被占用。请先关闭它的预览，再重新核对。' : a.error}</p>;
    actions = <><button type="button" onClick={ctl.hide}>关闭</button><button type="button" className="pv-primary" onClick={() => void ctl.recheck(a.kind === 'remove-preview' || a.kind === 'remove' ? 'remove-preview' : 'change-preview')}>重新核对</button></>;
  } else if (done && a?.kind === 'accept-change') {
    body = <div className="pv-callout" role="status"><strong>已接受当前内容</strong>
      <span>{r?.keptAdoptedShotIds?.length ? `保留 ${r.keptAdoptedShotIds.length} 个镜号的采用。` : '没有保留的采用。'}{r?.unboundShotIds?.length ? ` 解除 ${r.unboundShotIds.length} 个超出新时长的镜号采用（镜号本身保留）。` : ''}</span></div>;
    actions = <button type="button" className="pv-primary" onClick={ctl.hide}>完成</button>;
  } else if (done && a?.kind === 'remove') {
    const f = r?.file;
    body = <div className="pv-callout" data-tone={r?.status === 'partial' ? 'warn' : undefined} role="status"><strong>{r?.record?.removed ? '已移除视频记录' : '视频记录未移除'}</strong>
      <span>{r?.record?.unboundShotIds?.length ? `解除 ${r.record.unboundShotIds.length} 个镜号的采用（镜号本身保留）。` : '没有需要解除的采用。'}</span>
      <span>文件：{fileText(f)}</span>
      {ctl.fileUnknown && <span>请求编号：<code>{a.requestId}</code>。记录已经移除；文件是否已移到废纸篓还不确定，只会查询原请求，不会再次移动。</span>}</div>;
    actions = ctl.fileUnknown
      ? <><button type="button" onClick={() => ctl.setVisible(false)}>稍后处理</button><button type="button" onClick={ctl.forget}>已核对，收起</button><button type="button" className="pv-primary" onClick={() => void ctl.act.query()}><RefreshCw size={14}/>查询原请求</button></>
      : <button type="button" className="pv-primary" onClick={ctl.hide}>完成</button>;
  } else if (ctl.view === 'review' && p) {
    if (p.changeKind === 'metadata_only') {
      body = <div className="pv-callout" role="status"><strong>视频内容一致</strong><span>只改了元数据，不需要处理；原采用、提示词和备注都保留。</span></div>;
      actions = <button type="button" className="pv-primary" onClick={ctl.hide}>知道了</button>;
    } else {
      const c = p.candidate || {}, b = p.before || {};
      body = <>
        <div className="pv-callout" data-tone={p.changeKind === 'content_changed' ? 'bad' : 'warn'}>
          <strong>{p.changeKind === 'content_changed' ? '视频内容已发生变化' : '无法确认是否只改了元数据'}</strong>
          <span>{p.changeKind === 'content_changed' ? '文件位置和名称没变，但画面或声音与登记时不同。请预览当前内容后决定是否继续使用。' : '这条记录没有可比对的内容指纹，无法自动判断，请预览当前内容后由你决定。'}</span>
        </div>
        <dl className="pv-metadata pv-change-compare">
          <div><dt>登记时</dt><dd>{duration(b.durationMs)} · {b.codec || '未知编码'} · 原内容未保留，无法回放对照</dd></div>
          <div><dt>现在</dt><dd>{duration(c.durationMs)} · {c.codec || '未知编码'} · {size(c.bytes)}</dd></div>
        </dl>
        <div className="pv-change-player">
          {ctl.playing && c.mediaUrl && c.supported !== false ? <video src={c.mediaUrl} controls autoPlay playsInline preload="metadata" aria-label={`当前内容：${video.name}`}/>
            : c.supported === false ? <p className="pv-muted">浏览器无法播放此编码，请在访达中用本机播放器核对。</p>
            : <button type="button" onClick={() => ctl.setPlaying(true)}><Play size={14}/>播放当前内容</button>}
        </div>
        <p className="pv-muted">{affected.length ? `当前被采用：${shots(affected)}。` : '当前没有被分镜采用。'}核对结果 10 分钟内有效。</p>
        {!!invalid.length && <div className="pv-callout" data-tone="warn"><AlertTriangle size={14}/><span>当前内容比登记时短，{shots(invalid)} 的片段超出新时长。继续使用会解除这些镜号的采用，镜号本身保留。</span></div>}
        {p.canAccept !== false && <label className="pv-check"><input type="checkbox" checked={ctl.acceptOk} onChange={e => ctl.setAcceptOk(e.target.checked)}/>我已核对当前内容，接受它作为这个视频的新内容</label>}
        {p.canAccept !== false && !!invalid.length && <label className="pv-check"><input type="checkbox" checked={ctl.unbindOk} onChange={e => ctl.setUnbindOk(e.target.checked)}/>确认解除 {shots(invalid)} 的采用</label>}
      </>;
      actions = <>
        <button type="button" className="pv-danger" onClick={ctl.startRemove}>不再使用…</button>
        <button type="button" className="pv-primary" disabled={p.canAccept === false || !ctl.acceptOk || !!invalid.length && !ctl.unbindOk} onClick={ctl.accept}>继续使用当前内容</button>
      </>;
    }
  } else if (ctl.view === 'remove' && rp) {
    const others = (rp.otherActiveReferences || []).length;
    body = <>
      <p>不再使用“{video.name}”：移除这条视频记录{removeShots.length ? `，并解除 ${shots(removeShots)} 的采用（镜号本身保留，之后可以重新选择别的视频）` : ''}。</p>
      <fieldset className="pv-change-file"><legend>这个文件怎么处理？（每次都需要选择）</legend>
        <label className="pv-check"><input type="radio" name={`file-${video.id}`} checked={ctl.fileAction === 'keep'} onChange={() => ctl.setFileAction('keep')}/>只移除记录，不移动文件</label>
        <label className="pv-check"><input type="radio" name={`file-${video.id}`} disabled={!rp.canTrash} checked={ctl.fileAction === 'trash'} onChange={() => ctl.setFileAction('trash')}/>移到系统废纸篓（不是永久删除，可从废纸篓找回）</label>
        {!rp.canTrash && <small className="pv-muted">{others ? '其他视频记录仍在使用这个文件，不能移到废纸篓。' : rp.reasons?.length ? `不能移到废纸篓：${rp.reasons.join('、')}` : '当前环境不能移到废纸篓。'}</small>}
      </fieldset>
      {!!removeShots.length && <label className="pv-check"><input type="checkbox" checked={ctl.removeOk} onChange={e => ctl.setRemoveOk(e.target.checked)}/>确认解除 {shots(removeShots)} 的采用</label>}
    </>;
    actions = <>
      <button type="button" onClick={() => { ctl.act.clear(); ctl.setView('review'); }} disabled={!p}>返回</button>
      <button type="button" className="pv-danger" disabled={!ctl.fileAction || !!removeShots.length && !ctl.removeOk} onClick={ctl.remove}>{ctl.fileAction === 'trash' ? '移除记录并移到废纸篓' : '移除记录'}</button>
    </>;
  }
  // 关闭（✕ / Esc）= 收起：已结清的任务清除，未结清的保留在页面顶部
  return <Modal title="处理内容变化" locked={false} onClose={ctl.hide} className="pv-change-modal">
    <p className="pv-muted">视频：<strong>{video.name || video.fileName}</strong></p>
    {body}
    {actions && <ModalActions>{actions}</ModalActions>}
  </Modal>;
}
