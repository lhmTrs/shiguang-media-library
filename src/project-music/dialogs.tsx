import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Check, FileAudio, Upload, X} from 'lucide-react';
import type {ImportReceipt, Prompt, Request, Round, Song, Version} from './types';
import {TIER_LABEL} from './types';

const message = (e: unknown) => e instanceof Error ? e.message : String(e || '请求失败');
const uuid = (): string => crypto.randomUUID();
export const AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.flac'];
export const MAX_BYTES = 200 * 1024 * 1024;
const extOf = (name: string) => (name.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
const isSuno = (tool: string) => /suno/i.test(tool);

export function Modal({title, onClose, children, wide = false, busy = false}: {title: string; onClose: () => void; children: React.ReactNode; wide?: boolean; busy?: boolean}) {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    card.current?.querySelector<HTMLElement>('input,textarea,select,button')?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [busy, onClose]);
  return <div className="sgm-modal-backdrop" onPointerDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <div ref={card} className={`sgm-modal ${wide ? 'is-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
      <header><h2>{title}</h2><button type="button" className="sgm-icon" aria-label="关闭" disabled={busy} onClick={onClose}><X size={18}/></button></header>
      {children}
    </div>
  </div>;
}

export function SongDialog({song, onSubmit, onClose}: {song?: Song; onSubmit: (title: string, notes: string) => Promise<void>; onClose: () => void}) {
  const [title, setTitle] = useState(song?.title ?? ''), [notes, setNotes] = useState(song?.notes ?? '');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return setError('请填写歌名');
    setBusy(true); setError('');
    try { await onSubmit(title.trim(), notes); onClose(); } catch (err) { setError(message(err)); } finally { setBusy(false); }
  };
  return <Modal title={song ? '修改歌曲' : '新建歌曲'} onClose={onClose} busy={busy}>
    <form className="sgm-form" onSubmit={submit}>
      <label className="sgm-field">歌名<input value={title} maxLength={80} onChange={e => setTitle(e.target.value)} placeholder="例如：片尾曲"/></label>
      <label className="sgm-field">备注（选填）<textarea rows={3} value={notes} maxLength={4000} onChange={e => setNotes(e.target.value)} placeholder="用在哪里、想要什么感觉"/></label>
      {error && <p className="sgm-error" role="alert">{error}</p>}
      <footer><button type="button" className="sgm-btn" onClick={onClose} disabled={busy}>取消</button><button className="sgm-btn primary" disabled={busy}>{song ? '保存' : '新建'}</button></footer>
    </form>
  </Modal>;
}

type FileTask = {key: string; file: File; label: string; state: 'pending' | 'uploading' | 'ready' | 'duplicate' | 'failed' | 'cancelled'; receipt?: ImportReceipt; requestId?: string; error?: string};

function PromptFields({value, onChange, disabled}: {value: Prompt; onChange: (p: Prompt) => void; disabled?: boolean}) {
  const set = (k: keyof Prompt) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onChange({...value, [k]: e.target.value});
  return <fieldset className="sgm-prompt-fields" disabled={disabled}>
    <div className="sgm-row2">
      <label className="sgm-field">生成工具<input value={value.tool} maxLength={80} onChange={set('tool')} placeholder="Suno，或本地模型名"/></label>
      <label className="sgm-field">Suno 会员档位<select value={value.sunoTier} onChange={set('sunoTier')}>
        {(Object.keys(TIER_LABEL) as Prompt['sunoTier'][]).map(k => <option key={k} value={k}>{TIER_LABEL[k]}</option>)}
      </select></label>
    </div>
    <p className="sgm-hint">档位决定这首歌能不能商用，生成以后补不回来；拿不准就选「不确定」。在 Suno 上自己改过提示词的，请贴回改后的。</p>
    <label className="sgm-field">风格<textarea rows={2} value={value.style} maxLength={4000} onChange={set('style')} placeholder="例如：中国风流行 女声 慢板"/></label>
    <label className="sgm-field">歌词<textarea rows={6} value={value.lyrics} maxLength={20000} onChange={set('lyrics')} placeholder="每句一行，方便逐句对比"/></label>
    <div className="sgm-row2">
      <label className="sgm-field">其他参数<input value={value.params} maxLength={4000} onChange={set('params')} placeholder="选填"/></label>
      <label className="sgm-field">Suno 链接或编号<input value={value.sunoLink} maxLength={500} onChange={set('sunoLink')} placeholder="选填"/></label>
    </div>
  </fieldset>;
}

export const emptyPrompt = (): Prompt => ({tool: 'Suno', style: '', lyrics: '', params: '', sunoLink: '', sunoTier: ''});

export async function uploadFile(request: Request, projectId: string, roundId: string, file: File, label: string, requestId: string = uuid()) {
  const base = `/project-music/projects/${projectId}/imports`;
  let receipt = await request<ImportReceipt>(base, {requestId, roundId, fileName: file.name, bytes: file.size, ...(label.trim() ? {label: label.trim()} : {})});
  if (receipt.status === 'waiting') {
    try { receipt = await request<ImportReceipt>(`${base}/${requestId}/content`, file, 'PUT'); }
    catch (e) {
      // 响应丢了也先查原回执，不重发字节。
      try { receipt = await request<ImportReceipt>(`${base}/${requestId}`); } catch { throw e; }
      if (receipt.status === 'waiting' || receipt.status === 'uploading') throw e;
    }
  }
  return {requestId, receipt};
}

// 「上传新一轮」与「上传到这一轮」共用：先建轮（如需要），再逐个上传文件。
export function RoundDialog({projectId, song, round, request, blocked, onChanged, onClose}: {
  projectId: string; song: Song; round?: Round; request: Request;
  blocked?: {roundNo: number; missing: string[]} | null; onChanged: (song?: Song) => void; onClose: () => void;
}) {
  // 打开时的状态为准：本对话框自己建出新一轮后，不能因为「新一轮还没补完」又把自己换成拦截提示。
  const [last] = useState(() => song.rounds.at(-1));
  const [gate] = useState(() => blocked ?? null);
  const draft = !round && last?.nextDirection?.promptDraft;
  const initial = useMemo<Prompt>(() => {
    if (round) return round.prompt;
    const prev = last?.prompt ?? emptyPrompt();
    return draft ? {...prev, style: draft.style || prev.style, lyrics: draft.lyrics || prev.lyrics, params: draft.params || prev.params} : {...prev};
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [prompt, setPrompt] = useState<Prompt>(initial);
  const [tasks, setTasks] = useState<FileTask[]>([]);
  const [roundId, setRoundId] = useState(round?.id ?? '');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const roundRequest = useRef(uuid());
  const suno = isSuno(round?.prompt.tool ?? prompt.tool);
  const update = (key: string, patch: Partial<FileTask>) => setTasks(list => list.map(t => t.key === key ? {...t, ...patch} : t));

  const pick = (files: FileList | null) => {
    if (!files) return;
    const next: FileTask[] = [];
    for (const file of Array.from(files)) {
      const ext = extOf(file.name);
      const bad = !AUDIO_EXT.includes(ext) ? '只支持 mp3、wav、m4a、flac' : file.size > MAX_BYTES ? '超过 200MB' : file.size < 1 ? '空文件' : '';
      next.push({key: uuid(), file, label: suno ? '' : file.name.slice(0, -ext.length).slice(0, 40), state: bad ? 'failed' : 'pending', error: bad || undefined});
    }
    setTasks(list => [...list, ...next]);
  };

  const run = async () => {
    setBusy(true); setError('');
    let id = roundId;
    try {
      if (!id) {
        const updated = await request<Song>(`/project-music/projects/${projectId}/songs/${song.id}/rounds`, {requestId: roundRequest.current, prompt});
        id = updated.rounds.find(r => r.id === roundRequest.current)?.id ?? updated.rounds.at(-1)!.id;
        setRoundId(id);
        onChanged(updated);
      }
      for (const t of tasks) {
        if (t.state !== 'pending') continue;
        update(t.key, {state: 'uploading', error: undefined});
        try {
          const {requestId, receipt} = await uploadFile(request, projectId, id, t.file, t.label, t.requestId);
          update(t.key, {requestId, receipt, state: receipt.status === 'ready' ? 'ready' : receipt.status === 'duplicate' ? 'duplicate' : 'failed', error: receipt.error ?? undefined});
        } catch (e) {
          update(t.key, {state: 'failed', error: message(e)});
        }
      }
      onChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (t: FileTask, choice: 'keep' | 'cancel') => {
    if (!t.requestId) return;
    setBusy(true);
    try {
      const r = await request<ImportReceipt>(`/project-music/projects/${projectId}/imports/${t.requestId}/resolve`, {choice});
      update(t.key, {receipt: r, state: r.status === 'ready' ? 'ready' : r.status === 'cancelled' ? 'cancelled' : 'failed', error: r.error ?? undefined});
      onChanged();
    } catch (e) { update(t.key, {error: message(e)}); } finally { setBusy(false); }
  };

  const pending = tasks.some(t => t.state === 'pending');
  const done = tasks.length > 0 && tasks.every(t => ['ready', 'cancelled'].includes(t.state));
  const title = round ? `上传到第 ${round.roundNo} 轮` : `上传新一轮 · 第 ${(last?.roundNo ?? 0) + 1} 轮`;

  if (gate && !round) return <Modal title="先补上一轮" onClose={onClose}>
    <div className="sgm-form">
      <p className="sgm-gate">第 {gate.roundNo} 轮还缺「{gate.missing.join('」「')}」。补完再开新一轮，这样每一轮改了什么、为什么改都有记录。</p>
      <p className="sgm-hint">可以让 AI 根据你的听感整理，也可以在那一轮的记录里自己填写。</p>
      <footer><button type="button" className="sgm-btn primary" onClick={onClose}>知道了</button></footer>
    </div>
  </Modal>;

  return <Modal title={title} onClose={onClose} busy={busy} wide>
    <div className="sgm-form">
      {!round && <>
        {draft && <p className="sgm-note">已用上一轮 AI 给的提示词草稿预填，请核对后再开新一轮。</p>}
        <PromptFields value={prompt} onChange={setPrompt} disabled={busy || !!roundId}/>
      </>}
      <div className="sgm-drop">
        <label className="sgm-btn"><Upload size={16}/>选择音频文件<input type="file" multiple accept=".mp3,.wav,.m4a,.flac" hidden disabled={busy} onChange={e => { pick(e.target.files); e.target.value = ''; }}/></label>
        <span className="sgm-hint">mp3、wav、m4a、flac，单个不超过 200MB。{suno ? 'Suno 的版本按 A、B… 自动编号。' : '版本名默认取文件名。'}</span>
      </div>
      {tasks.length > 0 && <ul className="sgm-files">
        {tasks.map(t => <li key={t.key} className={`is-${t.state}`}>
          <FileAudio size={16} aria-hidden="true"/>
          <span className="sgm-file-name" title={t.file.name}>{t.file.name}</span>
          {t.state === 'pending' ? <input className="sgm-file-label" aria-label={`${t.file.name} 的版本名`} value={t.label} maxLength={40} placeholder={suno ? '自动 A/B' : '版本名'} onChange={e => update(t.key, {label: e.target.value})}/>
            : <span className="sgm-file-state">{{uploading: '正在上传…', ready: `已保存 · ${t.receipt?.label ?? ''}`, duplicate: '内容重复', failed: '没有保存', cancelled: '已跳过', pending: ''}[t.state]}</span>}
          {t.state === 'pending' && <button type="button" className="sgm-icon" aria-label={`移除 ${t.file.name}`} onClick={() => setTasks(list => list.filter(x => x.key !== t.key))}><X size={15}/></button>}
          {t.state === 'duplicate' && <div className="sgm-dup">
            <span>项目里已有同样内容：{t.receipt?.duplicates.map(d => `「${d.songTitle}」第 ${d.roundNo} 轮 ${d.label}${d.status === 'rejected' ? '（淘汰区）' : ''}`).join('、')}</span>
            <button type="button" className="sgm-btn small" disabled={busy} onClick={() => resolve(t, 'keep')}>仍然保存一份</button>
            <button type="button" className="sgm-btn small ghost" disabled={busy} onClick={() => resolve(t, 'cancel')}>跳过</button>
          </div>}
          {t.error && <span className="sgm-error">{t.error}</span>}
        </li>)}
      </ul>}
      {error && <p className="sgm-error" role="alert">{error}</p>}
      <footer>
        <button type="button" className="sgm-btn" onClick={onClose} disabled={busy}>{done ? '完成' : '关闭'}</button>
        {!done && <button type="button" className="sgm-btn primary" disabled={busy || (!pending && !!roundId) || (!pending && !!round)} onClick={run}>
          {busy ? '处理中…' : roundId ? '上传所选文件' : pending ? '开新一轮并上传' : '只开新一轮'}
        </button>}
      </footer>
    </div>
  </Modal>;
}

type Folder = {id: string; name: string; relativePath: string};

export function FinalizeDialog({projectId, song, request, onChanged, onClose}: {projectId: string; song: Song; request: Request; onChanged: (s: Song) => void; onClose: () => void}) {
  const versions = song.rounds.flatMap(r => r.versions).filter(v => v.status !== 'rejected');
  const fallback = versions.find(v => v.isBest) ?? versions.at(-1);
  const [versionId, setVersionId] = useState(fallback?.id ?? '');
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [directory, setDirectory] = useState('');
  const [newFolder, setNewFolder] = useState('');
  const [fileName, setFileName] = useState(song.title);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [current, setCurrent] = useState<Song>(song);
  const [renameTo, setRenameTo] = useState(`${song.title} 2`);
  // 上次停在「重名待选择」时，接着处理原来的那次定稿，不另起一次。
  const requestId = useRef(song.finalization?.status === 'duplicate' ? song.finalization.requestId : uuid());
  const f = current.finalization?.requestId === requestId.current ? current.finalization : null;

  useEffect(() => {
    request<{folders: Folder[]}>('/file-intake/categories/music').then(r => setFolders(r.folders)).catch(e => { setFolders([]); setError('读不到音乐分类：' + message(e)); });
  }, [request]);

  const createFolder = async () => {
    if (!newFolder.trim()) return;
    setBusy(true); setError('');
    try {
      const made = await request<Folder>('/file-intake/categories/music', {directory: '', name: newFolder.trim()});
      setFolders(list => [...(list ?? []), made].sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN')));
      setDirectory(made.id); setNewFolder('');
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const submit = async () => {
    setBusy(true); setError('');
    try {
      const s = await request<Song>(`/project-music/projects/${projectId}/songs/${song.id}/finalize`, {requestId: requestId.current, expectedRevision: song.revision, versionId, directory, fileName});
      setCurrent(s); onChanged(s);
      if (s.status === 'final') onClose();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const resolve = async (choice: 'rename' | 'reuse' | 'cancel', candidateId?: string) => {
    setBusy(true); setError('');
    try {
      const ext = (versions.find(v => v.id === versionId)?.format) ?? '';
      const s = await request<Song>(`/project-music/projects/${projectId}/songs/${song.id}/finalize/${requestId.current}/resolve`,
        {choice, ...(choice === 'rename' ? {fileName: `${renameTo.trim()}.${ext}`} : {}), ...(candidateId ? {candidateId} : {})});
      setCurrent(s); onChanged(s);
      if (s.status === 'final' || s.finalization?.status === 'cancelled') onClose();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const label = (v: Version) => `第 ${v.roundNo} 轮 ${v.label}${v.isBest ? '（当前最好）' : ''}`;

  return <Modal title="定稿" onClose={onClose} busy={busy}>
    <div className="sgm-form">
      <p className="sgm-hint">定稿会把所选版本复制一份进音乐库，并加入本项目的候选素材。候选版本不进音乐库。以后可以撤回定稿，已进音乐库的文件不会自动删。</p>
      {!f || f.status === 'failed' ? <>
        <label className="sgm-field">定稿版本<select value={versionId} onChange={e => setVersionId(e.target.value)}>
          {versions.map(v => <option key={v.id} value={v.id}>{label(v)}</option>)}
        </select></label>
        <label className="sgm-field">放进音乐分类<select value={directory} disabled={!folders} onChange={e => setDirectory(e.target.value)}>
          {(folders ?? [{id: '', name: '待确认', relativePath: ''}]).map(x => <option key={x.id} value={x.id}>{x.id ? x.name : '待确认（稍后再分类）'}</option>)}
        </select></label>
        <div className="sgm-inline">
          <input aria-label="新分类名" placeholder="或新建一个分类" value={newFolder} maxLength={60} onChange={e => setNewFolder(e.target.value)}/>
          <button type="button" className="sgm-btn small" disabled={busy || !newFolder.trim()} onClick={createFolder}>新建分类</button>
        </div>
        <label className="sgm-field">音乐库里的文件名<input value={fileName} maxLength={200} onChange={e => setFileName(e.target.value)}/></label>
        {f?.status === 'failed' && <p className="sgm-error">{f.error}</p>}
        <footer><button type="button" className="sgm-btn" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className="sgm-btn primary" disabled={busy || !versionId || !fileName.trim() || !folders} onClick={submit}><Check size={16}/>{busy ? '正在复制…' : '定稿'}</button></footer>
      </> : f.status === 'duplicate' ? <>
        <p className="sgm-gate">这个分类里已有同名或同内容的文件：{f.candidates.map(c => `「${c.name}」（${c.reason}）`).join('、')}。请选择怎么处理。</p>
        <label className="sgm-field">另存为新文件名<input value={renameTo} maxLength={180} onChange={e => setRenameTo(e.target.value)}/></label>
        <footer>
          <button type="button" className="sgm-btn ghost" disabled={busy} onClick={() => resolve('cancel')}>取消定稿</button>
          {f.candidates.map(c => <button key={c.id} type="button" className="sgm-btn" disabled={busy} onClick={() => resolve('reuse', c.id)}>沿用「{c.name}」</button>)}
          <button type="button" className="sgm-btn primary" disabled={busy || !renameTo.trim()} onClick={() => resolve('rename')}>另存</button>
        </footer>
      </> : <p className="sgm-hint">定稿进行中…</p>}
      {error && <p className="sgm-error" role="alert">{error}</p>}
    </div>
  </Modal>;
}
