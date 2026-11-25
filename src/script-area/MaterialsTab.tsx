// 「甲方资料」标签：只看不改。两组：本集、全局（这部剧所有集共用）。单独项目只有本集。不做覆盖：同名上传是新的一份。
import React, { useEffect, useRef, useState } from 'react';
import { asRequestError, dateTime, errorText, fileSize, scriptBase, timeout, uuid } from './api';
import { DocxPreview, docxPreviewAvailable } from './DocxPreview';
import type { MaterialSummary, Paged, ScriptRequest } from './types';

export function useMaterialList(request: ScriptRequest, projectId: string, active: boolean, reload: number) {
  const [state, setState] = useState<{ projectId: string; items: MaterialSummary[]; total: number; error: string; loading: boolean }>({ projectId, items: [], total: 0, error: '', loading: false });
  useEffect(() => {
    if (!active || !projectId) return;
    const c = new AbortController();
    setState(s => ({ ...s, projectId, loading: true, error: '', ...(s.projectId !== projectId ? { items: [], total: 0 } : {}) }));
    request<Paged<MaterialSummary>>(scriptBase(projectId) + '/materials?scope=all&limit=100', undefined, undefined, { signal: c.signal })
      .then(r => setState({ projectId, items: r.items, total: r.total, error: '', loading: false }))
      .catch(e => { if (!c.signal.aborted) setState(s => ({ ...s, loading: false, error: errorText(e) })); });
    return () => c.abort();
  }, [request, projectId, active, reload]);
  return state.projectId === projectId ? state : { projectId, items: [], total: 0, error: '', loading: true };
}

type FileKind = 'txt' | 'docx' | 'pdf' | 'other';
export function fileKind(m: Pick<MaterialSummary, 'contentType' | 'originalFilename'>): FileKind {
  const ext = m.originalFilename.toLowerCase().split('.').pop() ?? '', t = m.contentType.toLowerCase();
  if (t.startsWith('text/plain') || ext === 'txt') return 'txt';
  if (t === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (t.includes('wordprocessingml') || ext === 'docx') return 'docx';
  return 'other';
}
const kindName: Record<FileKind, string> = { txt: 'TXT', docx: 'DOCX', pdf: 'PDF', other: '文件' };

type Confirm = { title: string; text: string[]; action: string; danger?: boolean; run: () => Promise<void> };
type Preview = { material: MaterialSummary; lines?: { number: number; text: string }[]; error?: string; loading: boolean };

export function MaterialsTab({ projectId, seriesId, seriesName, request, list, onChanged }: {
  projectId: string; seriesId: string | null; seriesName: string; request: ScriptRequest; list: ReturnType<typeof useMaterialList>; onChanged: () => void;
}) {
  const [file, setFile] = useState<File | null>(null), [toSeries, setToSeries] = useState(false), [uploading, setUploading] = useState(false);
  const uploadId = useRef(uuid()), fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<Confirm | null>(null), [confirmBusy, setConfirmBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => { setFile(null); setToSeries(false); setError(''); setNotice(''); setPreview(null); setConfirm(null); uploadId.current = uuid(); }, [projectId]);

  const episode = list.items.filter(m => m.ownerType === 'project'), global = list.items.filter(m => m.ownerType === 'series');

  async function upload() {
    if (!file || uploading) return;
    setUploading(true); setError(''); setNotice('');
    // 文字字段放在文件前面：流式解析时后端先拿到归属和 requestId。
    const form = new FormData(); form.append('ownerType', toSeries && seriesId ? 'series' : 'project'); form.append('requestId', uploadId.current); form.append('file', file);
    try {
      const r = await request<{ material: MaterialSummary }>(scriptBase(projectId) + '/materials', form, 'POST', timeout(120000));
      setNotice(`已上传「${r.material.originalFilename}」` + (r.material.ownerType === 'series' ? '，放在全局资料里，这部剧所有集都能看到。' : '，挂在本集。'));
      setFile(null); setToSeries(false); uploadId.current = uuid(); if (fileInput.current) fileInput.current.value = ''; onChanged();
    } catch (e) {
      const err = asRequestError(e);
      setError((err.code === 'SCRIPT_PAYLOAD_TOO_LARGE' ? '文件太大（首版上限 25 MB）' : err.code === 'SCRIPT_UNSUPPORTED_MEDIA' ? '这种文件不能上传：支持 TXT、DOCX、PDF' : errorText(err)) + (err.status ? '' : '。结果还没确认：再点一次「上传」不会重复上传。'));
      if (err.status) uploadId.current = uuid();
    } finally { setUploading(false); }
  }

  function askMove(m: MaterialSummary) {
    const toGlobal = m.ownerType === 'project';
    if (toGlobal && !seriesId) return;
    setConfirm({
      title: toGlobal ? '移到全局资料' : '移回本集',
      text: toGlobal ? [`「${m.originalFilename}」会放进全局资料，《${seriesName}》所有集都能看到。`] : [`「${m.originalFilename}」会只挂在本集，这部剧的其他集就看不到了。`],
      action: toGlobal ? '移到全局' : '移回本集',
      run: async () => {
        try {
          await request(scriptBase(projectId) + '/materials/' + encodeURIComponent(m.id) + '/move', { expected_revision: m.revision, ownerType: toGlobal ? 'series' : 'project', ownerId: toGlobal ? seriesId : projectId, requestId: uuid() }, 'POST', timeout());
          setNotice(toGlobal ? `「${m.originalFilename}」已移到全局资料。` : `「${m.originalFilename}」已移回本集。`);
        } catch (e) {
          const err = asRequestError(e);
          setError(err.code === 'SCRIPT_MATERIAL_CHANGED' ? '这份资料刚被别处改过（移动或删除），列表已刷新，请再看一眼。' : errorText(err));
        } finally { onChanged(); }
      },
    });
  }
  function askDelete(m: MaterialSummary) {
    setConfirm({
      title: '删除甲方资料', danger: true, action: '删除',
      text: [
        `删除「${m.originalFilename}」以后，这里不能再预览或下载它。`,
        ...(m.ownerType === 'series' ? ['这是全局资料：删了以后所有集都看不到。'] : []),
        '如果泳道图引用过它：原件删掉，泳道图里引用的那几句会留着。',
      ],
      run: async () => {
        try {
          const r = await request<{ retainedExcerptCount: number }>(scriptBase(projectId) + '/materials/' + encodeURIComponent(m.id) + '/delete', { expected_revision: m.revision, requestId: uuid() }, 'POST', timeout());
          setNotice(`已删除「${m.originalFilename}」` + (r.retainedExcerptCount ? `；泳道图里引用的 ${r.retainedExcerptCount} 段摘录留着。` : '。'));
          if (preview?.material.id === m.id) setPreview(null);
        } catch (e) {
          const err = asRequestError(e);
          setError(err.code === 'SCRIPT_MATERIAL_CHANGED' ? '这份资料刚被别处改过（移动或删除），列表已刷新，请再看一眼。' : errorText(err));
        } finally { onChanged(); }
      },
    });
  }

  async function openPreview(m: MaterialSummary) {
    const k = fileKind(m);
    if (k === 'pdf' && m.previewUrl) { window.open(m.previewUrl, '_blank', 'noopener'); return; }
    if (k === 'docx') { setPreview({ material: m, loading: false }); return; }
    if (k !== 'txt' || !m.sourceId) return;
    setPreview({ material: m, loading: true });
    try {
      const lines: { number: number; text: string }[] = [];
      for (let offset = 0, total = 1; offset < total && offset < 20000;) {
        const r = await request<{ lines: { number: number; text: string }[]; total: number }>(scriptBase(projectId) + '/sources/' + encodeURIComponent(m.sourceId) + '?offset=' + offset + '&limit=500', undefined, undefined, timeout());
        lines.push(...r.lines); total = r.total; offset += r.lines.length; if (!r.lines.length) break;
      }
      setPreview(p => p?.material.id === m.id ? { material: m, lines, loading: false } : p);
    } catch (e) { setPreview(p => p?.material.id === m.id ? { material: m, loading: false, error: errorText(e) } : p); }
  }

  const row = (m: MaterialSummary) => {
    const k = fileKind(m), canPreview = k === 'txt' ? !!m.sourceId : k === 'pdf' ? !!m.previewUrl : k === 'docx' ? docxPreviewAvailable : false;
    return <li key={m.id} className="sa-material">
      <div className="sa-material-name"><strong title={m.originalFilename}>{m.originalFilename}</strong>{m.ownerType === 'series' && <span className="sa-chip">全局</span>}</div>
      <small>{kindName[k]} · {fileSize(m.byteSize)} · {dateTime(m.createdAt)} 上传</small>
      <div className="ca-actions">
        {canPreview && <button type="button" onClick={() => void openPreview(m)}>{k === 'pdf' ? '在新标签页打开' : '预览'}</button>}
        <a className="sa-link-button" href={m.downloadUrl} download={m.originalFilename}>下载</a>
        {seriesId && <button type="button" onClick={() => askMove(m)}>{m.ownerType === 'project' ? '移到全局' : '移回本集'}</button>}
        <button type="button" className="sa-danger" onClick={() => askDelete(m)}>删除</button>
      </div>
    </li>;
  };

  return <section className="sa-materials" aria-label="甲方资料">
    <form className="sa-upload" onSubmit={e => { e.preventDefault(); void upload(); }}>
      <label className="sa-field"><span>上传甲方资料（TXT、DOCX、PDF，25 MB 以内）</span><input ref={fileInput} type="file" aria-label="选择要上传的甲方资料" accept=".txt,.docx,.pdf,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={e => { setFile(e.target.files?.[0] ?? null); uploadId.current = uuid(); }}/></label>
      {seriesId && <label className="ca-check"><input type="checkbox" checked={toSeries} onChange={e => setToSeries(e.target.checked)}/>放到全局资料（《{seriesName}》所有集共用）</label>}
      <button className="ca-primary" type="submit" disabled={!file || uploading}>{uploading ? '正在上传…' : '上传'}</button>
      <small className="ca-muted">要让泳道图引用 DOCX、PDF 里的文字，另传一份核对过的 TXT。</small>
    </form>
    {error && <p className="ca-alert" role="alert">{error}</p>}
    {notice && <p className="ca-notice" role="status">{notice}</p>}
    {list.error && <p className="ca-alert" role="alert">资料列表没有读到：{list.error}</p>}
    <h3>本集<small>{episode.length} 份</small></h3>
    {episode.length ? <ul className="sa-material-list">{episode.map(row)}</ul> : <p className="ca-muted">{list.loading ? '正在读取…' : '本集还没有甲方资料。'}</p>}
    {seriesId && <>
      <h3>全局<small>这部剧所有集共用 · {global.length} 份</small></h3>
      {global.length ? <ul className="sa-material-list">{global.map(row)}</ul> : <p className="ca-muted">{list.loading ? '正在读取…' : '还没有全局资料。'}</p>}
    </>}
    {list.total > list.items.length && <p className="ca-muted">只列出了最近 {list.items.length} 份（共 {list.total} 份）。</p>}

    {preview && <div className="ca-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setPreview(null); }} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setPreview(null); } }}>
      <div className="ca-modal sa-preview" role="dialog" aria-modal="true" aria-label={'预览：' + preview.material.originalFilename}>
        <header><h2>{preview.material.originalFilename}</h2><button type="button" onClick={() => setPreview(null)} autoFocus>关闭</button></header>
        <div className="ca-modal-content">
          {preview.loading ? <p className="ca-muted">正在读取…</p> : preview.error ? <p className="ca-alert" role="alert">{preview.error}　<a href={preview.material.downloadUrl} download={preview.material.originalFilename}>下载原件</a></p>
            : fileKind(preview.material) === 'docx' ? <DocxPreview url={preview.material.previewUrl ?? preview.material.downloadUrl} downloadUrl={preview.material.downloadUrl} name={preview.material.originalFilename}/>
            : <ol className="sa-lines">{preview.lines?.map(l => <li key={l.number} value={l.number}><span className="sa-line-no">L{l.number}</span><span>{l.text || ' '}</span></li>)}</ol>}
        </div>
      </div>
    </div>}
    {confirm && <div className="ca-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !confirmBusy) setConfirm(null); }}>
      <div className="ca-modal sa-confirm" role="alertdialog" aria-modal="true" aria-label={confirm.title}>
        <header><h2>{confirm.title}</h2></header>
        <div className="ca-modal-content">{confirm.text.map((t, i) => <p key={i}>{t}</p>)}</div>
        <footer><button type="button" disabled={confirmBusy} onClick={() => setConfirm(null)}>取消</button>
          <button type="button" className={confirm.danger ? 'sa-danger-primary' : 'ca-primary'} disabled={confirmBusy} autoFocus onClick={() => { setConfirmBusy(true); setError(''); setNotice(''); void confirm.run().finally(() => { setConfirmBusy(false); setConfirm(null); }); }}>{confirmBusy ? '正在处理…' : confirm.action}</button></footer>
      </div>
    </div>}
  </section>;
}
