// 项目音乐 ·「文件」标签（SPEC 第十三节）：存储和传递用的文件夹。用共用的文件夹模板，行里是播放键 + 真实波形。
// 你可以建文件夹、改名、上传；AI 也能通过接口放文件、取文件。要比较或定稿的，点「加入歌曲」放进某首歌的某一轮。
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Clipboard, Download, FolderPlus, FolderSearch, ListPlus, Music2, Pause, Pencil, Play, Upload} from 'lucide-react';
import {FolderTemplate, type TemplateItem} from '../folder-template/FolderTemplate';
import {Waveform} from './Waveform';
import {clock, type PlayerState} from './Player';
import {Modal} from './dialogs';
import type {Request, Song} from './types';

const message = (e: unknown) => e instanceof Error ? e.message : String(e || '请求失败');
const uuid = (): string => crypto.randomUUID();
const MAX_BYTES = 200 * 1024 * 1024;
const FILE_EXT = ['mp3', 'wav', 'm4a', 'aac', 'aif', 'aiff', 'flac', 'ogg', 'opus'];
const ADDABLE = ['mp3', 'wav', 'm4a', 'flac'];

export type MusicFileItem = {
  id: string; name: string; folder: string; ext: string; bytes: number; modifiedAt: number; audio: boolean; addable: boolean;
  inLibrary: boolean; assetId: string | null; tags: string[]; durationMs: number | null;
  inSongs: {versionId: string; songId: string; songTitle: string; roundNo: number | null; label: string; status: string}[];
  mediaUrl: string | null; downloadUrl: string; peaksUrl: string | null;
};
export type MusicFilesView = {
  projectId: string; projectName: string; folder: string; exists: boolean; rootCount: number; truncated: boolean; itemsTruncated?: boolean;
  folders: {id: string; name: string; parentId: string; path: string; count: number}[];
  items: MusicFileItem[]; songs: {id: string; name: string; songCount: number; present: boolean; needsReview?: boolean};
};
type FileReceipt = {id: string; status: 'waiting' | 'uploading' | 'duplicate' | 'ready' | 'failed' | 'cancelled'; path: string | null; name: string | null; duplicates: string[]; error: string | null};
type Upload = {key: string; file: File; state: 'pending' | 'uploading' | 'duplicate' | 'ready' | 'failed' | 'cancelled'; requestId?: string; receipt?: FileReceipt; error?: string};
type Caps = {clipboard: {available: boolean; reason?: string}; revealMany: {available: boolean; reason?: string}};
type Dialog = null | {kind: 'new-folder'} | {kind: 'rename'} | {kind: 'upload'} | {kind: 'add'; item: MusicFileItem};

const FOLDER_KEY = 'shiguang.projectMusic.filesFolder.v1';
const readFolder = (projectId: string) => { try { return (JSON.parse(localStorage.getItem(FOLDER_KEY) || '{}') as Record<string, string>)[projectId] ?? ''; } catch { return ''; } };
const saveFolder = (projectId: string, folder: string) => { try { const m = JSON.parse(localStorage.getItem(FOLDER_KEY) || '{}'); m[projectId] = folder; localStorage.setItem(FOLDER_KEY, JSON.stringify(m)); } catch { /* 只在本页记住 */ } };

export function FilesPanel({active, projectId, request, player, songs, onJumpSongs, onSongChanged}: {
  active: boolean; projectId: string; request: Request; player: PlayerState; songs: Song[];
  onJumpSongs: () => void; onSongChanged: (s: Song) => void;
}) {
  const [folder, setFolderState] = useState(() => readFolder(projectId));
  const [view, setView] = useState<MusicFilesView | null>(null);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [peaks, setPeaks] = useState<Record<string, {peaks: number[] | null; durationMs: number | null}>>({});
  const [caps, setCaps] = useState<Caps | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const ticket = useRef(0);
  const base = `/project-music/projects/${projectId}/files`;
  const setFolder = (f: string) => { setFolderState(f); saveFolder(projectId, f); setSelected(new Set()); };

  const load = useCallback(async (at = folder) => {
    if (!projectId) return;
    const mine = ++ticket.current;
    setLoading(true);
    try {
      const next = await request<MusicFilesView>(`${base}?folder=${encodeURIComponent(at)}`);
      if (mine === ticket.current) { setView(next); setError(''); }
    } catch (e) {
      if (mine !== ticket.current) return;
      // 记住的文件夹被改名或挪走了：回到项目文件夹，不卡在报错上。
      if ((e as {code?: string}).code === 'FOLDER_NOT_FOUND' && at) { setFolder(''); return; }
      setError(message(e));
    } finally { if (mine === ticket.current) setLoading(false); }
  }, [base, folder, projectId, request]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setFolderState(readFolder(projectId)); setView(null); setPeaks({}); setSelected(new Set()); }, [projectId]);
  useEffect(() => { if (active) void load(folder); }, [active, folder, load]);
  useEffect(() => {
    if (!active || !projectId) return;
    request<Caps>(`${base}/desktop`).then(setCaps).catch(() => setCaps(null));
  }, [active, base, projectId, request]);

  // 波形按需取：只取当前文件夹里还没有的。
  useEffect(() => {
    if (!view) return;
    let stop = false;
    (async () => {
      for (const it of view.items) {
        if (stop) return;
        if (!it.peaksUrl || peaks[it.id]) continue;
        try {
          const p = await request<{peaks: number[] | null; durationMs: number | null}>(it.peaksUrl.replace(/^\/api/, ''));
          if (!stop) setPeaks(m => ({...m, [it.id]: p}));
        } catch { if (!stop) setPeaks(m => ({...m, [it.id]: {peaks: null, durationMs: null}})); }
      }
    })();
    return () => { stop = true; };
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); if (done) setNotice(done); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };

  const playable = (it: MusicFileItem) => ({id: 'file:' + it.id, mediaUrl: it.mediaUrl!, peaks: peaks[it.id]?.peaks ?? null, durationMs: peaks[it.id]?.durationMs ?? it.durationMs, label: it.folder || '项目文件夹', title: it.name});
  const toggle = (id: string) => setSelected(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else if (n.size < 50) n.add(id); return n; });
  const chosen = [...selected].filter(id => view?.items.some(i => i.id === id));

  const items: TemplateItem[] = useMemo(() => (view?.items ?? []).map(it => {
    const key = 'file:' + it.id, current = player.current?.id === key;
    const length = current ? (player.duration || (peaks[it.id]?.durationMs ?? 0) / 1000) : 0;
    const p = peaks[it.id];
    const meta = [clock(p?.durationMs ?? it.durationMs), `${(it.bytes / 1024 / 1024).toFixed(1)} MB`, it.inLibrary ? '' : '音乐库还没登记'].filter(Boolean).join(' · ');
    return {
      id: it.id, name: it.name, current, selectable: true, meta,
      leading: it.audio ? <button type="button" className="sgm-play" aria-label={`${current && player.playing ? '暂停' : '播放'} ${it.name}`}
        onClick={() => current && player.playing ? player.pause() : player.play(playable(it))}>{current && player.playing ? <Pause size={16}/> : <Play size={16}/>}</button>
        : <span className="sgm-play is-static" aria-hidden="true"><Music2 size={16}/></span>,
      visual: it.audio ? <Waveform peaks={p?.peaks ?? null} bars={140} progress={current && length ? player.position / length : null} active={current}
        onSeek={f => current ? player.seek(f) : player.play(playable(it), f)} label={`${it.name} 的波形`}/> : null,

      actions: <>
        {it.addable && <button type="button" className="sgm-icon" title="加入歌曲" aria-label={`把 ${it.name} 加入歌曲`} disabled={busy} onClick={() => setDialog({kind: 'add', item: it})}><ListPlus size={16}/></button>}
        <a className="sgm-icon" href={it.downloadUrl} download={it.name} title="下载" aria-label={`下载 ${it.name}`}><Download size={16}/></a>
      </>,
      // 「已加入」和标签放在下面一行小字里，各行的波形保持一样宽、对齐。
      details: it.inSongs.length || it.tags.length ? <>
        {it.inSongs.length > 0 && <span className="sgm-pill accent" title={it.inSongs.map(s => `「${s.songTitle}」第 ${s.roundNo} 轮 ${s.label}`).join('、')}>已加入：{it.inSongs[0].songTitle} 第 {it.inSongs[0].roundNo} 轮 {it.inSongs[0].label}{it.inSongs.length > 1 ? ` 等 ${it.inSongs.length} 处` : ''}</span>}
        {it.tags.length > 0 && <span>标签：{it.tags.join('、')}</span>}
      </> : undefined,
    };
  }), [view, peaks, player, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  const copy = () => act(async () => {
    const r = await request<{count: number}>(`${base}/clipboard`, {requestId: uuid(), paths: chosen});
    setSelected(new Set());
    setNotice(`已复制 ${r.count} 个文件，可以直接粘贴到剪辑软件里`);
  });
  const reveal = (body: {paths: string[]} | {folder: string}) => act(() => request(`${base}/reveal`, {requestId: uuid(), ...body}), '已在访达中打开');

  if (!projectId) return null;
  const songsHint = view?.songs.songCount ? `${view.songs.songCount} 首` : '';
  return <div className="sgm-files" aria-label="项目音乐文件">
    {error && <p className="sgm-banner error" role="alert">{error}<button type="button" className="sgm-btn small ghost" onClick={() => { setError(''); void load(); }}>重新读取</button></p>}
    {notice && <p className="sgm-banner accent" role="status">{notice}</p>}
    {view?.songs.needsReview && <p className="sgm-banner error">找不到「歌曲」文件夹：可能在访达里挪动或改了名。歌曲版本仍按音乐库记录播放，请把它挪回项目音乐文件夹里，名字改回「歌曲」。</p>}
    <FolderTemplate label="项目音乐文件" rootLabel="项目音乐文件夹" rootCount={view?.rootCount} folders={view?.folders ?? []} current={view?.folder ?? folder}
      onNavigate={setFolder} loading={loading} itemLabel="个音频"
      specialNodes={[{id: 'songs', label: '♪ 歌曲', hint: songsHint, icon: null, onSelect: onJumpSongs}]}
      emptyText={view && !view.exists ? '还没有文件夹。建一个，比如「Suno下载」或「AI剪辑」，把要存的、要传的音乐放进来。' : '这个文件夹还是空的。可以上传，也可以在访达里直接放进来。'}
      toolbar={<>
        <button type="button" className="sgm-btn small" disabled={busy} onClick={() => setDialog({kind: 'new-folder'})}><FolderPlus size={15}/>新建文件夹</button>
        {!!view?.folder && <button type="button" className="sgm-btn small" disabled={busy} onClick={() => setDialog({kind: 'rename'})}><Pencil size={15}/>改名</button>}
        <button type="button" className="sgm-btn small" disabled={busy} onClick={() => setDialog({kind: 'upload'})}><Upload size={15}/>上传</button>
        <button type="button" className="sgm-btn small ghost" disabled={busy || !caps?.revealMany.available} title={caps?.revealMany.available ? undefined : caps?.revealMany.reason}
          onClick={() => reveal({folder: view?.folder ?? ''})}><FolderSearch size={15}/>在访达中显示</button>
        {chosen.length > 0 && <>
          <span className="sgm-hint">已选 {chosen.length} 个</span>
          <button type="button" className="sgm-btn small primary" disabled={busy || !caps?.clipboard.available} title={caps?.clipboard.available ? '复制后可以直接粘贴到剪辑软件' : caps?.clipboard.reason} onClick={copy}><Clipboard size={15}/>复制给剪辑软件</button>
          <button type="button" className="sgm-btn small" disabled={busy || !caps?.revealMany.available} title={caps?.revealMany.available ? undefined : caps?.revealMany.reason} onClick={() => reveal({paths: chosen})}><FolderSearch size={15}/>在访达中显示所选</button>
          <button type="button" className="sgm-btn small ghost" onClick={() => setSelected(new Set())}>取消选择</button>
        </>}
      </>}
      notice={caps && !caps.clipboard.available ? <p className="sgm-hint">复制给剪辑软件、在访达中显示要在运行拾光的这台 Mac 上用：{caps.clipboard.reason}</p> : undefined}
      items={items} selected={selected} onToggleSelect={toggle}/>

    {dialog?.kind === 'new-folder' && <NameDialog title="新建文件夹" label="文件夹名" initial="" submit="新建" onClose={() => setDialog(null)}
      onSubmit={async name => { const next = await request<MusicFilesView>(`${base}/folders`, {parent: view?.folder ?? '', name}); setView(next); setFolder(next.folder); }}/>}
    {dialog?.kind === 'rename' && view && <NameDialog title="改名" label="新名字" initial={view.folders.find(f => f.id === view.folder)?.name ?? ''} submit="改名"
      hint="访达里的文件夹也会一起改名；里面的文件在音乐库里的记录、标签和加入过的歌曲都保留。" onClose={() => setDialog(null)}
      onSubmit={async name => { const next = await request<MusicFilesView>(`${base}/folders/rename`, {path: view.folder, name}); setView(next); setFolder(next.folder); }}/>}
    {dialog?.kind === 'upload' && <UploadDialog base={base} folder={view?.folder ?? ''} request={request} onClose={() => { setDialog(null); void load(); }}/>}
    {dialog?.kind === 'add' && <AddToSongDialog projectId={projectId} item={dialog.item} songs={songs} request={request}
      onDone={s => { onSongChanged(s); void load(); setNotice(`已加入「${s.title}」。文件留在原处，没有复制。`); }} onClose={() => setDialog(null)}/>}
  </div>;
}

function NameDialog({title, label, initial, submit, hint, onSubmit, onClose}: {title: string; label: string; initial: string; submit: string; hint?: string; onSubmit: (name: string) => Promise<void>; onClose: () => void}) {
  const [name, setName] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const go = async () => {
    setBusy(true); setError('');
    try { await onSubmit(name.trim()); onClose(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  return <Modal title={title} onClose={onClose} busy={busy}>
    <form className="sgm-form" onSubmit={e => { e.preventDefault(); void go(); }}>
      <label className="sgm-field">{label}<input autoFocus value={name} maxLength={80} onChange={e => setName(e.target.value)}/></label>
      {hint && <p className="sgm-hint">{hint}</p>}
      {error && <p className="sgm-error" role="alert">{error}</p>}
      <footer><button type="button" className="sgm-btn" onClick={onClose} disabled={busy}>取消</button>
        <button type="submit" className="sgm-btn primary" disabled={busy || !name.trim()}>{submit}</button></footer>
    </form>
  </Modal>;
}

function UploadDialog({base, folder, request, onClose}: {base: string; folder: string; request: Request; onClose: () => void}) {
  const [tasks, setTasks] = useState<Upload[]>([]), [busy, setBusy] = useState(false);
  const update = (key: string, patch: Partial<Upload>) => setTasks(list => list.map(t => t.key === key ? {...t, ...patch} : t));
  const pick = (files: FileList | null) => {
    if (!files) return;
    setTasks(list => [...list, ...Array.from(files).map(file => {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      const bad = !FILE_EXT.includes(ext) ? `只放音频：${FILE_EXT.join('、')}` : file.size > MAX_BYTES ? '超过 200MB' : file.size < 1 ? '空文件' : '';
      return {key: uuid(), file, state: bad ? 'failed' as const : 'pending' as const, error: bad || undefined};
    })]);
  };
  const run = async () => {
    setBusy(true);
    for (const t of tasks) {
      if (t.state !== 'pending') continue;
      const requestId = t.requestId ?? uuid();
      update(t.key, {state: 'uploading', requestId, error: undefined});
      try {
        let r = await request<FileReceipt>(`${base}/imports`, {requestId, folder, fileName: t.file.name, bytes: t.file.size});
        if (r.status === 'waiting') {
          try { r = await request<FileReceipt>(`${base}/imports/${requestId}/content`, t.file, 'PUT'); }
          catch (e) { r = await request<FileReceipt>(`${base}/imports/${requestId}`).catch(() => { throw e; }); if (r.status === 'waiting' || r.status === 'uploading') throw e; }
        }
        update(t.key, {receipt: r, state: r.status === 'ready' ? 'ready' : r.status === 'duplicate' ? 'duplicate' : 'failed', error: r.error ?? undefined});
      } catch (e) { update(t.key, {state: 'failed', error: message(e)}); }
    }
    setBusy(false);
  };
  const resolve = async (t: Upload, choice: 'keep' | 'cancel') => {
    setBusy(true);
    try {
      const r = await request<FileReceipt>(`${base}/imports/${t.requestId}/resolve`, {choice});
      update(t.key, {receipt: r, state: r.status === 'ready' ? 'ready' : r.status === 'cancelled' ? 'cancelled' : 'failed', error: r.error ?? undefined});
    } catch (e) { update(t.key, {error: message(e)}); } finally { setBusy(false); }
  };
  const pending = tasks.some(t => t.state === 'pending');
  return <Modal title={`上传到「${folder || '项目音乐文件夹'}」`} onClose={onClose} busy={busy} wide>
    <div className="sgm-form">
      <div className="sgm-drop">
        <label className="sgm-btn"><Upload size={16}/>选择音频文件<input type="file" multiple accept={FILE_EXT.map(e => '.' + e).join(',')} hidden disabled={busy} onChange={e => { pick(e.target.files); e.target.value = ''; }}/></label>
        <span className="sgm-hint">只放音频，单个不超过 200MB。放进来就登记进音乐库「AI生成」。重名不覆盖，会自动加编号。</span>
      </div>
      {tasks.length > 0 && <ul className="sgm-files-list">
        {tasks.map(t => <li key={t.key} className={`is-${t.state}`}>
          <span className="sgm-file-name" title={t.file.name}>{t.file.name}</span>
          <span className="sgm-file-state">{{pending: '待上传', uploading: '正在上传…', ready: `已保存${t.receipt?.name && t.receipt.name !== t.file.name ? ` · 另存为 ${t.receipt.name}` : ''}`, duplicate: '这个文件夹里已有同样内容', failed: '没有保存', cancelled: '已跳过'}[t.state]}</span>
          {t.state === 'duplicate' && <span className="sgm-dup">
            <span>已有：{t.receipt?.duplicates.join('、')}</span>
            <button type="button" className="sgm-btn small" disabled={busy} onClick={() => resolve(t, 'keep')}>仍然保留</button>
            <button type="button" className="sgm-btn small ghost" disabled={busy} onClick={() => resolve(t, 'cancel')}>跳过</button>
          </span>}
          {t.error && <span className="sgm-error">{t.error}</span>}
        </li>)}
      </ul>}
      <footer>
        <button type="button" className="sgm-btn" onClick={onClose} disabled={busy}>{tasks.length && !pending ? '完成' : '关闭'}</button>
        {pending && <button type="button" className="sgm-btn primary" disabled={busy} onClick={run}>{busy ? '正在上传…' : '上传'}</button>}
      </footer>
    </div>
  </Modal>;
}

function AddToSongDialog({projectId, item, songs, request, onDone, onClose}: {projectId: string; item: MusicFileItem; songs: Song[]; request: Request; onDone: (s: Song) => void; onClose: () => void}) {
  const activeSongs = songs.filter(s => s.status === 'active' && s.rounds.length);
  const [songId, setSongId] = useState(activeSongs[0]?.id ?? '');
  const song = activeSongs.find(s => s.id === songId);
  const [roundId, setRoundId] = useState(song?.rounds.at(-1)?.id ?? '');
  useEffect(() => { setRoundId(song?.rounds.at(-1)?.id ?? ''); }, [songId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [dup, setDup] = useState('');
  const requestId = useRef(uuid());
  const go = async (keep = false) => {
    setBusy(true); setError('');
    try {
      const s = await request<Song>(`/project-music/projects/${projectId}/files/add-to-song`, {requestId: requestId.current, path: item.id, roundId, ...(label.trim() ? {label: label.trim()} : {}), ...(keep ? {keep: true} : {})});
      onDone(s); onClose();
    } catch (e) {
      if ((e as {code?: string}).code === 'DUPLICATE_IN_PROJECT') setDup(message(e)); else setError(message(e));
    } finally { setBusy(false); }
  };
  return <Modal title="加入歌曲" onClose={onClose} busy={busy}>
    <div className="sgm-form">
      <p className="sgm-hint">把「{item.name}」作为某首歌某一轮的一个版本，就能和别的版本对比、选当前最好、定稿。文件留在「文件」里，不会复制一份。</p>
      {!activeSongs.length ? <p className="sgm-gate">还没有进行中、开过轮次的歌。先到「歌曲」里新建一首歌，开一轮，再回来加入。</p> : <>
        <label className="sgm-field">歌曲<select value={songId} onChange={e => setSongId(e.target.value)}>{activeSongs.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
        <label className="sgm-field">轮次<select value={roundId} onChange={e => setRoundId(e.target.value)}>{[...(song?.rounds ?? [])].reverse().map(r => <option key={r.id} value={r.id}>第 {r.roundNo} 轮{r.versions.length ? `（已有 ${r.versions.length} 个版本）` : '（还没有版本）'}</option>)}</select></label>
        <label className="sgm-field">版本名<input value={label} maxLength={40} placeholder={ADDABLE.includes(item.ext) ? '选填，留空自动起名' : ''} onChange={e => setLabel(e.target.value)}/></label>
      </>}
      {dup && <p className="sgm-gate">{dup.replace(/；仍要加入请带 keep:true$/, '')}。仍然要加吗？</p>}
      {error && <p className="sgm-error" role="alert">{error}</p>}
      <footer><button type="button" className="sgm-btn" onClick={onClose} disabled={busy}>取消</button>
        {dup ? <button type="button" className="sgm-btn primary" disabled={busy} onClick={() => go(true)}>仍然加入</button>
          : <button type="button" className="sgm-btn primary" disabled={busy || !roundId} onClick={() => go()}>加入</button>}</footer>
    </div>
  </Modal>;
}
