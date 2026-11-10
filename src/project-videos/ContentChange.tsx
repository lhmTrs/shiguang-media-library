import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Play, RefreshCw } from 'lucide-react';
import { Modal, ModalActions } from './Modal';
import { actionPending, useDesktopAction, type DesktopReceipt } from './desktop-actions';
import type { ProjectVideo, ProjectVideoRequest } from './types';

/*
 * 合同 D（#52）：视频内容确实变化时，由用户预览后决定“继续使用”或“不再使用”。
 * - 打开即核对（changes/preview）；冻结的当前内容只在用户点击后播放；原内容未保留，不伪造对照。
 * - 继续使用：明确勾选接受；新时长导致越界的采用必须精确确认解除（镜号本身保留）。
 * - 不再使用：先取得移除影响（remove/preview），文件每次单选保留或移到废纸篓，再明确确认。
 * - 所有请求固定 requestId；202 轮询；回应丢失只查询原请求；写操作进行中不能关闭窗口。
 */
const duration = (ms?: number) => !ms || !Number.isFinite(ms) ? '未知' : `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const size = (n?: number) => !n ? '未知' : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const shots = (list?: { number: number | string }[]) => (list || []).map(s => `镜 ${s.number}`).join('、');

export function ContentChangeDialog({ video, projectId, request, onClose, onChanged }: {
  video: ProjectVideo; projectId: string; request: ProjectVideoRequest;
  onClose: () => void; onChanged: (removed: boolean) => void;
}) {
  const act = useDesktopAction(projectId, request);
  const [view, setView] = useState<'review' | 'remove'>('review');
  const [playing, setPlaying] = useState(false), [acceptOk, setAcceptOk] = useState(false), [unbindOk, setUnbindOk] = useState(false);
  const [fileAction, setFileAction] = useState<'' | 'keep' | 'trash'>(''), [removeOk, setRemoveOk] = useState(false);
  const preview = useRef<DesktopReceipt | null>(null), removal = useRef<DesktopReceipt | null>(null), started = useRef(false);
  const a = act.action, r = a?.receipt || null, pending = actionPending(a);
  if (a?.kind === 'change-preview' && r?.status === 'ready') preview.current = r;
  if (a?.kind === 'remove-preview' && r?.status === 'ready') removal.current = r;
  const p = preview.current, rp = removal.current;

  function begin(kind: 'change-preview' | 'remove-preview') {
    act.clear(true); setPlaying(false); setAcceptOk(false); setUnbindOk(false); setFileAction(''); setRemoveOk(false);
    if (kind === 'change-preview') { preview.current = null; removal.current = null; setView('review'); } else { removal.current = null; setView('remove'); }
    void act.start(kind, [video.id], { expectedRevision: video.revision });
  }
  useEffect(() => { if (!started.current) { started.current = true; begin('change-preview'); } }, []);

  const writing = !!a && (a.kind === 'accept-change' || a.kind === 'remove') && (pending || a.unknown);
  const close = () => { if (writing) return; onClose(); };
  const invalid = p?.invalidAdoptedShots || [], affected = p?.affectedAdoptedShots || [];
  const removeShots = rp?.affectedAdoptedShots || [];
  const done = a && !pending && !a.unknown && !a.error && r && ['completed', 'partial'].includes(r.status) && (a.kind === 'accept-change' || a.kind === 'remove');

  let body: React.ReactNode = null, actions: React.ReactNode = null;
  if (a && pending) {
    body = <div className="pv-task" role="status"><strong>{{ 'change-preview': '正在核对当前文件…', 'remove-preview': '正在核对移除影响…', 'accept-change': '正在接受当前内容…', remove: '正在移除记录…' }[a.kind as string] || '处理中…'}</strong>{!!r?.total && <progress value={r.processed || 0} max={r.total}/>}{!r?.total && <progress aria-label="处理中"/>}</div>;
  } else if (a?.unknown) {
    body = <div className="pv-task" role="status"><strong>结果待核对</strong><p>{a.error || r?.error || '没有取得最终结果。原操作可能仍在进行或已经完成。'}</p><p>请求编号：<code>{a.requestId}</code></p><p className="pv-muted">只会查询原请求，不会重新提交。</p></div>;
    actions = <><button type="button" onClick={() => { act.clear(true); onChanged(false); onClose(); }}>已核对，关闭</button><button type="button" className="pv-primary" onClick={() => void act.query()}><RefreshCw size={14}/>查询原请求</button></>;
  } else if (a?.error) {
    // 后台明确拒绝（失败回执或准入拒绝）：本次没有完成。重新核对是只读的新请求，由用户点击发起，不会重发原写操作。
    body = <p className="pv-error" role="alert">{a.code === 'VIDEO_IN_USE' ? '这个视频正在播放或被占用。请先关闭它的预览，再重新核对。' : a.error}</p>;
    actions = <><button type="button" onClick={close}>关闭</button><button type="button" className="pv-primary" onClick={() => begin(a.kind === 'remove-preview' || a.kind === 'remove' ? 'remove-preview' : 'change-preview')}>重新核对</button></>;
  } else if (done && a?.kind === 'accept-change') {
    body = <div className="pv-callout" role="status"><strong>已接受当前内容</strong>
      <span>{r?.keptAdoptedShotIds?.length ? `保留 ${r.keptAdoptedShotIds.length} 个镜号的采用。` : '没有保留的采用。'}{r?.unboundShotIds?.length ? ` 解除 ${r.unboundShotIds.length} 个超出新时长的镜号采用（镜号本身保留）。` : ''}</span></div>;
    actions = <button type="button" className="pv-primary" onClick={() => { onChanged(false); onClose(); }}>完成</button>;
  } else if (done && a?.kind === 'remove') {
    const f = r?.file;
    const fileText = f?.status === 'kept' ? '已保留在原位置' : f?.status === 'trashed' ? '已移到系统废纸篓' : f?.status === 'failed' ? `没有移到废纸篓，文件仍在原位置${f.reason ? `：${f.reason}` : ''}` : '结果待核对，请查询原请求';
    body = <div className="pv-callout" data-tone={r?.status === 'partial' ? 'warn' : undefined} role="status"><strong>{r?.record?.removed ? '已移除视频记录' : '视频记录未移除'}</strong>
      <span>{r?.record?.unboundShotIds?.length ? `解除 ${r.record.unboundShotIds.length} 个镜号的采用（镜号本身保留）。` : '没有需要解除的采用。'}</span>
      <span>文件：{fileText}</span></div>;
    actions = <>{f?.status === 'unknown' && <button type="button" onClick={() => void act.query()}><RefreshCw size={14}/>查询原请求</button>}<button type="button" className="pv-primary" onClick={() => { onChanged(!!r?.record?.removed); onClose(); }}>完成</button></>;
  } else if (view === 'review' && p) {
    if (p.changeKind === 'metadata_only') {
      body = <div className="pv-callout" role="status"><strong>视频内容一致</strong><span>只改了元数据，不需要处理；原采用、提示词和备注都保留。</span></div>;
      actions = <button type="button" className="pv-primary" onClick={() => { onChanged(false); onClose(); }}>知道了</button>;
    } else {
      const c = p.candidate || {}, b = p.before || {};
      body = <>
        <div className="pv-callout" data-tone={p.changeKind === 'content_changed' ? 'bad' : 'warn'}>
          <strong>{p.changeKind === 'content_changed' ? '视频内容已发生变化' : '无法确认是否只改了元数据'}</strong>{/* not_comparable 不宣称已证实替换 */}
          <span>{p.changeKind === 'content_changed' ? '文件位置和名称没变，但画面或声音与登记时不同。请预览当前内容后决定是否继续使用。' : '这条记录没有可比对的内容指纹，无法自动判断，请预览当前内容后由你决定。'}</span>
        </div>
        <dl className="pv-metadata pv-change-compare">
          <div><dt>登记时</dt><dd>{duration(b.durationMs)} · {b.codec || '未知编码'} · 原内容未保留，无法回放对照</dd></div>
          <div><dt>现在</dt><dd>{duration(c.durationMs)} · {c.codec || '未知编码'} · {size(c.bytes)}</dd></div>
        </dl>
        <div className="pv-change-player">
          {playing && c.mediaUrl && c.supported !== false ? <video src={c.mediaUrl} controls autoPlay playsInline preload="metadata" aria-label={`当前内容：${video.name}`}/>
            : c.supported === false ? <p className="pv-muted">浏览器无法播放此编码，请在访达中用本机播放器核对。</p>
            : <button type="button" onClick={() => setPlaying(true)}><Play size={14}/>播放当前内容</button>}
        </div>
        <p className="pv-muted">{affected.length ? `当前被采用：${shots(affected)}。` : '当前没有被分镜采用。'}核对结果 10 分钟内有效。</p>
        {!!invalid.length && <div className="pv-callout" data-tone="warn"><AlertTriangle size={14}/><span>当前内容比登记时短，{shots(invalid)} 的片段超出新时长。继续使用会解除这些镜号的采用，镜号本身保留。</span></div>}
        {p.canAccept !== false && <label className="pv-check"><input type="checkbox" checked={acceptOk} onChange={e => setAcceptOk(e.target.checked)}/>我已核对当前内容，接受它作为这个视频的新内容</label>}
        {p.canAccept !== false && !!invalid.length && <label className="pv-check"><input type="checkbox" checked={unbindOk} onChange={e => setUnbindOk(e.target.checked)}/>确认解除 {shots(invalid)} 的采用</label>}
      </>;
      actions = <>
        <button type="button" className="pv-danger" onClick={() => begin('remove-preview')}>不再使用…</button>
        <button type="button" className="pv-primary" disabled={p.canAccept === false || !acceptOk || !!invalid.length && !unbindOk}
          onClick={() => { const token = p.contentToken, stamp = p.adoptionStamp; act.clear(); void act.start('accept-change', [video.id], { expectedRevision: video.revision, adoptionStamp: stamp, contentToken: token, confirmAcceptContent: true, confirmedUnbindShotIds: invalid.map(s => s.id) }); }}>继续使用当前内容</button>
      </>;
    }
  } else if (view === 'remove' && rp) {
    const others = (rp.otherActiveReferences || []).length;
    body = <>
      <p>不再使用“{video.name}”：移除这条视频记录{removeShots.length ? `，并解除 ${shots(removeShots)} 的采用（镜号本身保留，之后可以重新选择别的视频）` : ''}。</p>
      <fieldset className="pv-change-file"><legend>这个文件怎么处理？（每次都需要选择）</legend>
        <label className="pv-check"><input type="radio" name={`file-${video.id}`} checked={fileAction === 'keep'} onChange={() => setFileAction('keep')}/>只移除记录，文件保留在原位置</label>
        <label className="pv-check"><input type="radio" name={`file-${video.id}`} disabled={!rp.canTrash} checked={fileAction === 'trash'} onChange={() => setFileAction('trash')}/>移到系统废纸篓（不是永久删除，可从废纸篓找回）</label>
        {!rp.canTrash && <small className="pv-muted">{others ? '其他视频记录仍在使用这个文件，不能移到废纸篓。' : rp.reasons?.length ? `不能移到废纸篓：${rp.reasons.join('、')}` : '当前环境不能移到废纸篓。'}</small>}
      </fieldset>
      {!!removeShots.length && <label className="pv-check"><input type="checkbox" checked={removeOk} onChange={e => setRemoveOk(e.target.checked)}/>确认解除 {shots(removeShots)} 的采用</label>}
    </>;
    actions = <>
      <button type="button" onClick={() => { act.clear(); setView('review'); }} disabled={!p}>返回</button>
      <button type="button" className="pv-danger" disabled={!fileAction || !!removeShots.length && !removeOk}
        onClick={() => { const token = rp.removalToken, stamp = rp.adoptionStamp, action = fileAction; act.clear(); void act.start('remove', [video.id], { expectedRevision: video.revision, adoptionStamp: stamp, removalToken: token, confirmUnbind: true, fileAction: action }); }}>{fileAction === 'trash' ? '移除记录并移到废纸篓' : '移除记录'}</button>
    </>;
  }
  return <Modal title="处理内容变化" locked={writing} onClose={close} className="pv-change-modal">
    <p className="pv-muted">视频：<strong>{video.name || video.fileName}</strong></p>
    {body}
    {actions && <ModalActions>{actions}</ModalActions>}
  </Modal>;
}
