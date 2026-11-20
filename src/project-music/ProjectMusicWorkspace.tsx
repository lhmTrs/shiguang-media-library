// 项目音乐页：新画风试点。只用 --sg-* 变量，不改现有 --c-* 和其他页面。
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Check, Ellipsis, GitCompare, Music2, Plus, Star, Upload} from 'lucide-react';
import './project-music.css';
import {usePalette, PALETTES} from './palette';
import {PlayerBar, usePlayer} from './Player';
import {Waveform} from './Waveform';
import {FinalizeDialog, Modal, RoundDialog, SongDialog} from './dialogs';
import {RoundCard, VersionRow, type VersionActions} from './RoundCard';
import {ComparePanel, defaultPair} from './Compare';
import type {MusicCollection, ProjectMusicWorkspaceProps, Round, Song, Version} from './types';
import {STATUS_LABEL} from './types';

const message = (e: unknown) => e instanceof Error ? e.message : String(e || '请求失败');
const uuid = (): string => crypto.randomUUID();
type DialogState = null | {kind: 'new-song'} | {kind: 'edit-song'} | {kind: 'round'; round?: Round} | {kind: 'finalize'}
  | {kind: 'confirm'; title: string; text: string; action: () => Promise<void>};

export function ProjectMusicWorkspace({active, projectId, projects, request}: ProjectMusicWorkspaceProps) {
  const [palette, setPalette] = usePalette();
  const [data, setData] = useState<MusicCollection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [openRounds, setOpenRounds] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [compare, setCompare] = useState<[string, string] | null>(null);
  const player = usePlayer(active);
  const ticket = useRef(0);
  const root = useRef<HTMLElement>(null);
  const base = `/project-music/projects/${projectId}`;

  const load = useCallback(async () => {
    if (!projectId) { setData(null); return; }
    const mine = ++ticket.current;
    setLoading(true);
    try {
      const next = await request<MusicCollection>(base);
      if (mine === ticket.current) { setData(next); setError(''); }
    } catch (e) {
      if (mine === ticket.current) setError(message(e));
    } finally {
      if (mine === ticket.current) setLoading(false);
    }
  }, [base, projectId, request]);

  useEffect(() => { if (active) void load(); }, [active, load]);
  useEffect(() => { player.close(); setMenu(false); setCompare(null); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const openCompare = (pair: [string, string] | null) => { if (!pair) return; player.pause(); setMenu(false); setCompare(pair); };

  // 进行中的排前面，其次定稿，放弃的放最后；同一状态里新建的在前。
  const songs = useMemo(() => {
    const order = {active: 0, final: 1, abandoned: 2} as const;
    return data?.projectId === projectId ? [...data.songs].sort((a, b) => order[a.status] - order[b.status] || b.createdAt - a.createdAt) : [];
  }, [data, projectId]);
  const songId = selected[projectId] && songs.some(s => s.id === selected[projectId]) ? selected[projectId] : songs[0]?.id;
  const song = songs.find(s => s.id === songId) ?? null;

  // 新拿到一首歌时默认展开最新一轮。
  const latestId = song?.rounds.at(-1)?.id;
  useEffect(() => { if (latestId) setOpenRounds(set => set.has(latestId) ? set : new Set([...set, latestId])); }, [latestId]);

  const replaceSong = useCallback((s: Song) => {
    setData(d => d && d.projectId === s.projectId ? {...d, songs: d.songs.some(x => x.id === s.id) ? d.songs.map(x => x.id === s.id ? s : x) : [s, ...d.songs]} : d);
  }, []);
  const changed = useCallback((s?: Song) => { if (s) replaceSong(s); else void load(); }, [load, replaceSong]);

  const act = async (fn: () => Promise<Song | void>) => {
    setBusy(true); setError('');
    try { const s = await fn(); if (s) replaceSong(s); }
    catch (e) { setError(message(e)); if ((e as {code?: string}).code === 'REVISION_CONFLICT') void load(); }
    finally { setBusy(false); }
  };

  const actions: VersionActions = useMemo(() => ({
    setBest: v => song && act(() => request<Song>(`${base}/songs/${song.id}`, {expectedRevision: song.revision, bestVersionId: v.id}, 'PATCH')),
    restore: v => act(() => request<Song>(`${base}/versions/${v.id}`, {expectedRevision: v.revision, status: 'candidate'}, 'PATCH')),
    compareWithBest: v => song?.bestVersionId && song.bestVersionId !== v.id ? openCompare([song.bestVersionId, v.id]) : openCompare(song ? defaultPair(song) : null),
    reject: v => {
      const go = (clearBest = false) => act(() => request<Song>(`${base}/versions/${v.id}`, {expectedRevision: v.revision, status: 'rejected', ...(clearBest ? {clearBest} : {})}, 'PATCH'));
      if (v.isBest) setDialog({kind: 'confirm', title: '淘汰当前最好？', text: `第 ${v.roundNo} 轮 ${v.label} 是当前最好。淘汰后「当前最好」会空出来；文件不删，可以从淘汰区恢复。`, action: () => go(true)});
      else void go();
    },
  }), [song, base, request]); // eslint-disable-line react-hooks/exhaustive-deps

  // 播放条的上一个/下一个：当前歌曲里未淘汰的版本，按轮次顺序。
  const queue = useMemo(() => song ? song.rounds.flatMap(r => r.versions.filter(v => v.status !== 'rejected')) : [], [song]);
  const at = queue.findIndex(v => v.id === player.current?.id);
  const playingSong = songs.find(s => s.id === player.current?.songId);

  useEffect(() => {
    if (!active) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== ' ' || !player.current || dialog || compare) return;
      const t = e.target as HTMLElement;
      if (t.closest('input,textarea,select,button,a,[contenteditable="true"],[role="slider"]')) return;
      e.preventDefault(); player.toggle();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [active, player, dialog, compare]);

  const latest = song?.rounds.at(-1);
  const blocked = latest && !latest.complete ? {roundNo: latest.roundNo, missing: latest.missing.map(k => k === 'issues' ? '问题整理' : '下一轮方向')} : null;
  const best = song?.rounds.flatMap(r => r.versions).find(v => v.id === song.bestVersionId);
  const finalVersion = song?.rounds.flatMap(r => r.versions).find(v => v.id === song.finalVersionId);
  const rejected = song ? song.rounds.flatMap(r => r.versions).filter(v => v.status === 'rejected') : [];
  const projectName = projects.find(p => p.id === projectId)?.name ?? data?.projectName ?? '';

  return <section ref={root} className="sg-music" data-sg-palette={palette} hidden={!active} aria-label="项目音乐">
    <header className="sgm-head">
      <div>
        <p className="sgm-eyebrow">{projectName || '未选择项目'}</p>
        <h1>项目音乐</h1>
      </div>
      <div className="sgm-head-actions">
        <div className="sgm-palette" role="radiogroup" aria-label="新画风试用：配色">
          <span>新画风试用：配色</span>
          {PALETTES.map(p => <button key={p.id} type="button" role="radio" aria-checked={palette === p.id} className={palette === p.id ? 'is-on' : ''} onClick={() => setPalette(p.id)}>{p.name}</button>)}
        </div>
        {projectId && <button type="button" className="sgm-btn primary" onClick={() => setDialog({kind: 'new-song'})}><Plus size={16}/>新建歌曲</button>}
      </div>
    </header>

    {error && <p className="sgm-banner error" role="alert">{error}<button type="button" className="sgm-btn small ghost" onClick={() => { setError(''); void load(); }}>重新读取</button></p>}

    {!projectId ? <div className="sgm-hero"><Music2 size={28}/><h2>先选一个项目</h2><p>项目音乐跟着项目走。在顶部选好项目后，这里会列出为它做的歌。</p></div>
      : !songs.length ? <div className="sgm-hero">
        <Music2 size={28}/>
        <h2>{loading ? '正在读取…' : '还没有歌曲'}</h2>
        {!loading && <><p>一首歌会经历很多轮：每轮记下提示词、听感、问题和下一步方向，版本放在一起比。只有定稿的那一版进音乐库。</p>
          <button type="button" className="sgm-btn primary" onClick={() => setDialog({kind: 'new-song'})}><Plus size={16}/>新建第一首歌</button></>}
      </div>
      : <div className="sgm-body">
        <nav className="sgm-songs" aria-label="歌曲列表">
          {songs.map(s => {
            const show = s.rounds.flatMap(r => r.versions).find(v => v.id === s.bestVersionId) ?? s.rounds.at(-1)?.versions.find(v => v.status !== 'rejected');
            return <button key={s.id} type="button" className={`sgm-song-card ${s.id === songId ? 'is-on' : ''}`} aria-current={s.id === songId ? 'true' : undefined}
              onClick={() => setSelected(m => ({...m, [projectId]: s.id}))}>
              <span className="sgm-song-card-title"><strong>{s.title}</strong><span className={`sgm-pill ${s.status === 'final' ? 'accent' : s.status === 'abandoned' ? 'muted' : ''}`}>{STATUS_LABEL[s.status]}</span></span>
              <span className="sgm-song-card-meta">{s.rounds.length ? `${s.rounds.length} 轮 · ${s.rounds.reduce((n, r) => n + r.versions.length, 0)} 个版本` : '还没有轮次'}</span>
              {show && <Waveform peaks={show.peaks} bars={48} label={`${s.title} 的波形`} className="is-mini"/>}
            </button>;
          })}
        </nav>

        {song && <main className="sgm-song" aria-label={song.title}>
          <header className="sgm-song-head">
            <div className="sgm-song-title">
              <h2>{song.title}</h2>
              <span className={`sgm-pill ${song.status === 'final' ? 'accent' : song.status === 'abandoned' ? 'muted' : ''}`}>{STATUS_LABEL[song.status]}</span>
            </div>
            <p className="sgm-song-meta">
              {best ? <><Star size={13} fill="currentColor"/>当前最好：第 {best.roundNo} 轮 {best.label}</> : '还没有选「当前最好」'}
              <span>共 {song.rounds.length} 轮</span>
              {song.notes && <span title={song.notes}>{song.notes}</span>}
            </p>
            <div className="sgm-song-actions">
              {song.status === 'active' && <button type="button" className="sgm-btn primary" onClick={() => setDialog({kind: 'round'})}><Upload size={16}/>上传新一轮</button>}
              {defaultPair(song) && !compare && <button type="button" className="sgm-btn" onClick={() => openCompare(defaultPair(song))}><GitCompare size={16}/>对比</button>}
              {song.status === 'active' && song.rounds.some(r => r.versions.some(v => v.status !== 'rejected')) && <button type="button" className="sgm-btn" onClick={() => setDialog({kind: 'finalize'})}><Check size={16}/>定稿</button>}
              <div className="sgm-menu-wrap">
                <button type="button" className="sgm-icon" aria-label="更多操作" aria-expanded={menu} onClick={() => setMenu(m => !m)}><Ellipsis size={18}/></button>
                {menu && <div className="sgm-menu" role="menu" onClick={() => setMenu(false)}>
                  <button type="button" role="menuitem" onClick={() => setDialog({kind: 'edit-song'})}>修改歌名和备注</button>
                  {song.status === 'active' && <button type="button" role="menuitem" onClick={() => act(() => request<Song>(`${base}/songs/${song.id}`, {expectedRevision: song.revision, status: 'abandoned'}, 'PATCH'))}>放弃这首歌</button>}
                  {song.status === 'abandoned' && <button type="button" role="menuitem" onClick={() => act(() => request<Song>(`${base}/songs/${song.id}`, {expectedRevision: song.revision, status: 'active'}, 'PATCH'))}>恢复为进行中</button>}
                  {song.status === 'final' && <button type="button" role="menuitem" onClick={() => setDialog({kind: 'confirm', title: '撤回定稿？', text: '这首歌会回到进行中。已经进音乐库的文件和项目候选都保留，不会自动删除。', action: async () => { await act(() => request<Song>(`${base}/songs/${song.id}/unfinalize`, {expectedRevision: song.revision})); }})}>撤回定稿</button>}
                </div>}
              </div>
            </div>
          </header>

          {song.final && <p className="sgm-banner accent">已定稿：第 {finalVersion?.roundNo} 轮 {finalVersion?.label}，已复制进音乐库「{song.final.directory || '待确认'}」，文件名 {song.final.fileName}，并加入本项目候选。</p>}
          {song.finalization?.status === 'duplicate' && <p className="sgm-banner">上一次定稿遇到重名，还没处理完。<button type="button" className="sgm-btn small" onClick={() => setDialog({kind: 'finalize'})}>继续处理</button></p>}
          {song.finalization?.status === 'failed' && song.status === 'active' && <p className="sgm-banner error">上一次定稿没有完成：{song.finalization.error}。原版本保留，可以重新定稿。</p>}

          {!song.rounds.length && <div className="sgm-hero is-inline"><p>还没有轮次。上传第一轮：贴上提示词，选好 Suno 或本地模型生成的文件。</p>
            {song.status === 'active' && <button type="button" className="sgm-btn primary" onClick={() => setDialog({kind: 'round'})}><Upload size={16}/>上传第一轮</button>}</div>}

          {compare && <ComparePanel key={compare.join(':')} song={song} projectId={projectId} request={request} initial={compare} onChanged={replaceSong} onClose={() => setCompare(null)}/>}
          {!compare && <><div className="sgm-rounds">
            {[...song.rounds].reverse().map((r, i, list) => <RoundCard key={r.id} song={song} round={r} previous={list[i + 1]} latest={i === 0}
              open={openRounds.has(r.id)} onToggle={() => setOpenRounds(set => { const n = new Set(set); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })}
              player={player} actions={actions} busy={busy} projectId={projectId} request={request} onChanged={replaceSong} onUpload={round => setDialog({kind: 'round', round})}/>)}
          </div>

          {rejected.length > 0 && <details className="sgm-rejected">
            <summary>淘汰区 · {rejected.length} 个版本</summary>
            <p className="sgm-hint">淘汰的版本不删文件，随时可以恢复。</p>
            <div className="sgm-versions">{rejected.map(v => <VersionRow key={v.id} version={v} player={player} actions={actions} busy={busy} compact/>)}</div>
          </details>}
          </>}
        </main>}
      </div>}

    <PlayerBar player={player} title={playingSong?.title ?? ''} subtitle={player.current ? `第 ${player.current.roundNo} 轮 · ${player.current.label}` : ''}
      hasPrevious={at > 0} hasNext={at >= 0 && at < queue.length - 1}
      onPrevious={() => at > 0 && player.play(queue[at - 1])} onNext={() => at >= 0 && at < queue.length - 1 && player.play(queue[at + 1])}/>

    {dialog?.kind === 'new-song' && <SongDialog onClose={() => setDialog(null)} onSubmit={async (title, notes) => {
      const s = await request<Song>(`${base}/songs`, {requestId: uuid(), title, notes});
      replaceSong(s); setSelected(m => ({...m, [projectId]: s.id}));
    }}/>}
    {dialog?.kind === 'edit-song' && song && <SongDialog song={song} onClose={() => setDialog(null)} onSubmit={async (title, notes) => {
      replaceSong(await request<Song>(`${base}/songs/${song.id}`, {expectedRevision: song.revision, title, notes}, 'PATCH'));
    }}/>}
    {dialog?.kind === 'round' && song && <RoundDialog projectId={projectId} song={song} round={dialog.round} request={request} blocked={dialog.round ? null : blocked}
      onChanged={s => changed(s)} onClose={() => { setDialog(null); void load(); }}/>}
    {dialog?.kind === 'finalize' && song && <FinalizeDialog projectId={projectId} song={song} request={request} onChanged={replaceSong} onClose={() => { setDialog(null); void load(); }}/>}
    {dialog?.kind === 'confirm' && <Modal title={dialog.title} onClose={() => setDialog(null)}>
      <div className="sgm-form"><p>{dialog.text}</p>
        <footer><button type="button" className="sgm-btn" onClick={() => setDialog(null)}>取消</button>
          <button type="button" className="sgm-btn primary" onClick={async () => { const a = dialog.action; setDialog(null); await a(); }}>确定</button></footer>
      </div>
    </Modal>}
  </section>;
}
