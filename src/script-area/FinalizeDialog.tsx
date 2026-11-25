// 定稿对话框（约定 A：只有用户在页面上点「确认定稿」才存新版本；防误操作，不做系统验证）。
// 打开时读一次已保存的草稿，锁定那一刻的 revision 和摘要；确认时带上它们和 requestId。
// 超时后再点用同一个 requestId（服务器回原回执）；409 说明草稿又改过，重读草稿、换新的 requestId，让用户再看一眼。
import React, { useEffect, useRef, useState } from 'react';
import { asRequestError, dateTime, errorText, scriptBase, timeout, uuid } from './api';
import type { Draft, ScriptRequest, VersionSummary } from './types';

type Props = { projectId: string; nextNo: number; request: ScriptRequest; onClose: () => void; onDone: (v: VersionSummary) => void };

export function FinalizeDialog({ projectId, nextNo, request, onClose, onDone }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const requestId = useRef(uuid()), alive = useRef(true), box = useRef<HTMLDivElement>(null);
  useEffect(() => () => { alive.current = false; }, []);

  async function read(note = '') {
    setLoading(true); setError(''); setNotice(note);
    try { const d = await request<Draft>(scriptBase(projectId) + '/draft', undefined, undefined, timeout()); if (!alive.current) return; if (d.projectId !== projectId) throw Error('草稿回执不属于当前项目'); setDraft(d); }
    catch (e) { if (alive.current) setError('草稿没有读到：' + errorText(e)); }
    finally { if (alive.current) setLoading(false); }
  }
  useEffect(() => { void read(); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { box.current?.focus(); }, []);

  async function confirm() {
    if (!draft || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await request<{ version: VersionSummary }>(scriptBase(projectId) + '/versions', { expected_revision: draft.revision, contentDigest: draft.contentDigest, requestId: requestId.current }, 'POST', timeout(20000));
      if (!alive.current) return;
      onDone(r.version);
    } catch (e) {
      if (!alive.current) return;
      const err = asRequestError(e);
      if (err.code === 'SCRIPT_DRAFT_CHANGED') { requestId.current = uuid(); await read('草稿在你确认前又改过了，请重新看一眼再定。下面已经换成最新保存的草稿。'); }
      else if (err.code === 'SCRIPT_DRAFT_EMPTY') { requestId.current = uuid(); setError('草稿是空的，不能定稿。'); }
      else if (err.code === 'SCRIPT_REQUEST_CONFLICT') { requestId.current = uuid(); await read('这次确认和之前的一次请求对不上，已重新读取草稿，请再看一眼。'); }
      else setError(errorText(err) + (err.status ? '' : '。结果还没确认：可以再点一次「确认定稿」，不会重复存版本。'));
    } finally { if (alive.current) setBusy(false); }
  }

  const empty = !!draft && !draft.content.trim();
  const head = draft ? draft.content.split('\n').filter(l => l.trim()).slice(0, 5) : [];
  return <div className="ca-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }} onKeyDown={e => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose(); } }}>
    <div className="ca-modal sa-finalize" role="dialog" aria-modal="true" aria-label="定稿" tabIndex={-1} ref={box}>
      <header><h2>定稿成 V{nextNo}</h2></header>
      <div className="ca-modal-content">
        {notice && <p className="sa-warn" role="status">{notice}</p>}
        {error && <p className="ca-alert" role="alert">{error}</p>}
        {loading ? <p className="ca-muted">正在读取已保存的草稿…</p> : draft && (empty ? <p className="sa-warn">草稿是空的，不能定稿。先在「剧本」里写好并保存。</p> : <>
          <p>会把<b>已经保存</b>的草稿存成 <b>V{nextNo}</b>。存好以后 V{nextNo} 不能再改；草稿照旧留着，可以接着改。</p>
          <dl className="sa-facts">
            <dt>标题</dt><dd>{draft.title || '未命名剧本'}</dd>
            <dt>字数</dt><dd>{draft.content.length.toLocaleString()} 字</dd>
            <dt>最后保存</dt><dd>{dateTime(draft.updatedAt) || '—'}</dd>
          </dl>
          <div className="sa-head-lines" aria-label="开头几行">{head.map((l, i) => <p key={i}>{l}</p>)}{draft.content.split('\n').filter(l => l.trim()).length > head.length && <p className="ca-muted">……</p>}</div>
        </>)}
      </div>
      <footer><button onClick={onClose} disabled={busy}>取消</button><button className="ca-primary" disabled={loading || busy || !draft || empty} onClick={() => void confirm()}>{busy ? '正在定稿…' : '确认定稿'}</button></footer>
    </div>
  </div>;
}
