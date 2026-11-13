// 已有的剧一键统一人物属性维度（合同 v1 · A2）：全剧视图里的提示条 + 浮窗。
// 待统一（pending）才显示；预览 → 按需逐项决定 → 确认。确认结果不明时按原请求号查询，不换新编号重发。
import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { PromptRequest } from '../PromptTemplateWorkspace';
import { AlignmentDecisions } from '../series/AlignmentDecisions';
import { alignmentApi, alignmentErrorText, mergeChoices, type AlignmentChoice, type AlignmentPreview, type AlignmentStatus } from '../series/alignment';
import { outcomeUnknown } from './scoped';
import '../series/alignment.css';

export function SeriesAlignment({ request, seriesId, seriesName, active, onAligned }: {
  request: PromptRequest; seriesId: string; seriesName: string; active: boolean; onAligned: () => void;
}) {
  const api = alignmentApi(request);
  const [status, setStatus] = useState<AlignmentStatus | null>(null), [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<AlignmentPreview | null>(null), [changed, setChanged] = useState<Record<string, AlignmentChoice>>({});
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [done, setDone] = useState('');
  // 已发出、结果不明的确认：绑定原剧和原请求内容，只能原样查询或重发；期间会改变决定的控件全部锁住
  type Pending = { seriesId: string; body: { request_id: string; preview_token: string; choices: AlignmentChoice[] } };
  const seq = useRef(0), pendingRef = useRef<Pending | null>(null), [pending, setPendingState] = useState<Pending | null>(null);
  const setPending = (p: Pending | null) => { pendingRef.current = p; setPendingState(p); };
  const read = async () => {
    const s = ++seq.current;
    try { const r = await api.status(seriesId); if (s === seq.current) setStatus(r); }
    catch { if (s === seq.current) setStatus(null); } // 旧后端没有这个接口：不显示提示条
  };
  useEffect(() => { setStatus(null); setOpen(false); setPreview(null); setChanged({}); setDone(''); if (pendingRef.current && pendingRef.current.seriesId !== seriesId) setPending(null); if (active) void read(); return () => { seq.current++; }; }, [seriesId, active]); // eslint-disable-line react-hooks/exhaustive-deps
  // 屏幕上显示的选择：结果待核对时是原请求的选择；否则是最后一次成功核对的回显，加上还没核对成功的改选
  const choices = pending ? pending.body.choices : preview ? mergeChoices(preview, changed) : [];
  /** 有改选还没被服务端核对成功：屏幕上的选择和凭证对应的不是同一套，不能确认。 */
  const unchecked = !pending && Object.keys(changed).length > 0;
  /** checkingChange：这次是在核对用户的改选（失败时改选仍在屏幕上、但没被核对，不能确认）。 */
  async function loadPreview(withChoices?: AlignmentChoice[], note = '', checkingChange = false) {
    if (!status) return; setBusy('正在核对各集的维度…'); setError(note);
    try { const p = await api.preview(seriesId, status.alignment_revision, withChoices); setPreview(p); setChanged({}); }
    catch (e: any) { setError((alignmentErrorText[e.code] || e.message || '核对失败') + (checkingChange ? '。你的改选还没核对成功，不能确认；请点「重新核对」' : '，请稍后再试')); }
    finally { setBusy(''); }
  }
  const recheckChoices = () => void loadPreview(preview ? mergeChoices(preview, changed) : undefined, '', true);
  async function start() { setOpen(true); setPreview(null); setChanged({}); setError(''); await loadPreview(); }
  async function choose(c: AlignmentChoice) {
    if (!preview || pendingRef.current) return; const next = { ...changed, [c.item_id]: c }; setChanged(next);
    await loadPreview(mergeChoices(preview, next), '', true); // 每次改选都重新预览，以服务端回显和新凭证为准
  }
  const lost = () => Object.assign(Error('网络中断，暂时确认不了是否已统一。原请求已保留：稍后点「核对上次结果」会按原请求号查询，不会重复执行。'), { code: 'OUTCOME_UNKNOWN' });
  /** 结果不明的原请求：按原请求号查回执；查到就用原结果，确定没有才用原编号、原内容重发。
   *  查询失败、或重发的回应又丢了，都仍是「结果不明」——保留原剧、原请求号和原选项，绝不换新编号。 */
  async function settle(target: string, body: Pending['body']) {
    const r = await api.requestStatus(body.request_id).catch(() => null);
    if (r?.found && r.result) return r.result;
    if (!r) throw lost();
    try { return await api.confirm(target, body); }
    catch (e) { if (outcomeUnknown(e)) throw lost(); throw e; }
  }
  async function confirm() {
    const held = pendingRef.current;
    if (busy || (!held && (unchecked || !preview?.ready || !preview.preview_token))) return;
    const target = held?.seriesId ?? seriesId, body = held?.body ?? { request_id: api.newRequestId(), preview_token: preview!.preview_token!, choices: preview!.choices };
    setPending({ seriesId: target, body }); setBusy('正在统一…'); setError('');
    try {
      let receipt;
      if (held) receipt = await settle(target, body); // 已发出过：先按原号查，查不到才原样重发
      else {
        try { receipt = await api.confirm(target, body); }
        catch (e) { if (!outcomeUnknown(e)) throw e; receipt = await settle(target, body); }
      }
      setPending(null);
      setDone(`已统一：${receipt.episodes_updated} 集改用全剧的维度，${receipt.scores_remapped} 格分数已对应过去${receipt.scores_retained_in_history ? `，${receipt.scores_retained_in_history} 格保留在历史里` : ''}。`);
      setStatus(s => s && { ...s, status: 'aligned', alignment_revision: receipt.alignment_revision }); onAligned();
    } catch (e: any) {
      if (e.code !== 'OUTCOME_UNKNOWN') setPending(null);
      if (e.code === 'ATTRIBUTE_ALIGNMENT_STALE') { await read(); await loadPreview(undefined, alignmentErrorText.ATTRIBUTE_ALIGNMENT_STALE); return; }
      setError(alignmentErrorText[e.code] || e.message || '统一失败，请稍后再试');
    } finally { setBusy(''); }
  }
  const close = () => { if (busy) return; setOpen(false); setPreview(null); setChanged({}); setError(''); };
  if (!status || status.status !== 'pending') return done ? <p className="ca-public-note" role="status">{done}</p> : null;
  return <>
    <div className="aa-banner" role="note"><span>「{seriesName}」的人物属性维度还没统一：各集目前各用各的。统一后由全剧设置，各集共用。</span>
      <button type="button" disabled={!!busy} onClick={() => void start()}>查看并统一</button></div>
    {open && <div className="ca-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
      <div className="ca-modal ca-align" role="dialog" aria-modal="true" aria-label={`统一「${seriesName}」的人物属性维度`}>
        <header><h2>统一「{seriesName}」的人物属性维度</h2><button type="button" className="ca-icon-button" aria-label="关闭" disabled={!!busy} onClick={close}><X size={17}/></button></header>
        <div className="ca-modal-content">
          {error && <div className="ca-alert" role="alert">{error}</div>}
          {!preview && busy && <p className="ca-muted" role="status">{busy}</p>}
          {preview && <>
            {pending && !busy && <p className="pf-unknown" role="status">上次「确认统一」的结果还没核对到。下面是那次提交的选择，已锁定；再点「核对上次结果」会按原请求查询或原样重发，不会重复统一。</p>}
            <AlignmentDecisions preview={preview} choices={choices} disabled={!!busy || !!pending} onChoose={c => void choose(c)}/>
            <p className="aa-after">统一以后：
              <br/>· 维度只在全剧改，各集共用；集里的人物照常在集里打分。
              <br/>· 已有的 {preview.total_impact.scored_cells} 格分数{preview.episodes.some(ep => ep.decisions.length) ? '按上面的对应搬过去，选「保留为旧评分」的留在历史里' : '原样保留，改记到全剧的维度上'}。
              <br/>· 原来各集的维度设置存档保留，可以在历史里查看。这一步不能一键撤销。</p>
          </>}
        </div>
        <footer><button type="button" disabled={!!busy} onClick={close}>以后再说</button>
          {unchecked && <button type="button" disabled={!!busy} onClick={recheckChoices}>重新核对</button>}
          <button type="button" className="ca-primary" disabled={!!busy || (!pending && (unchecked || !preview?.ready || !preview.preview_token))} onClick={() => void confirm()}>{busy === '正在统一…' ? busy : pending ? '核对上次结果' : '确认统一'}</button></footer>
      </div>
    </div>}
  </>;
}
