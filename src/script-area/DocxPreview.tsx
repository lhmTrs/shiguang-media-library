// DOCX 预览：docx-preview（Apache-2.0）在本机把原件画成网页，尽量照 Word 的排版（用户 11-25 批准下载，和 mammoth 比过后选的）。
// 甲方文件是别人给的：不渲染内嵌网页（altChunk），文档里的链接只显示不跳转，不加载外部资源。打不开就给下载。
import React, { useEffect, useRef, useState } from 'react';

export const docxPreviewAvailable = true;

export function DocxPreview({ url, downloadUrl, name }: { url: string; downloadUrl: string; name: string }) {
  const body = useRef<HTMLDivElement>(null), styles = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading'), [error, setError] = useState('');
  useEffect(() => {
    let live = true; const c = new AbortController();
    setState('loading'); setError('');
    (async () => {
      const [{ renderAsync }, response] = await Promise.all([import('docx-preview'), fetch(url, { credentials: 'same-origin', signal: c.signal })]);
      if (!response.ok) throw Error('原件没有读到（' + response.status + '）');
      const data = await response.arrayBuffer(); if (!live || !body.current || !styles.current) return;
      body.current.replaceChildren(); styles.current.replaceChildren();
      await renderAsync(data, body.current, styles.current, { className: 'sa-docx', inWrapper: true, ignoreLastRenderedPageBreak: true, renderAltChunks: false, renderComments: false, useBase64URL: false });
      if (!live) return;
      body.current.querySelectorAll('a[href]').forEach(a => { a.setAttribute('title', a.getAttribute('href') ?? ''); a.removeAttribute('href'); });
      setState('ok');
    })().catch(e => { if (live && !c.signal.aborted) { setState('error'); setError(e instanceof Error ? e.message : String(e)); } });
    return () => { live = false; c.abort(); };
  }, [url]);
  return <div className="sa-docx-host" aria-busy={state === 'loading'}>
    {state === 'loading' && <p className="ca-muted">正在打开 DOCX…</p>}
    {state === 'error' && <p className="ca-alert" role="alert">这份 DOCX 在页面里打不开：{error}。<a href={downloadUrl} download={name}>下载原件</a>后用 Word 或 WPS 打开。</p>}
    <div ref={styles} hidden/>
    <div ref={body} className="sa-docx-body" role="document" aria-label={'DOCX 预览：' + name}/>
  </div>;
}
