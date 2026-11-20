import React, {useState} from 'react';
import {Archive, ChevronDown, ChevronRight, Download, Pause, Pencil, Play, Plus, RotateCcw, Star, Trash2, Upload} from 'lucide-react';
import {Waveform} from './Waveform';
import {clock, type PlayerState} from './Player';
import type {Author, IssueItem, PromptDraft, Request, Round, Song, Version} from './types';
import {CHECK_LABEL, PROMPT_FIELD_LABEL, TIER_LABEL} from './types';

const message = (e: unknown) => e instanceof Error ? e.message : String(e || '请求失败');
const when = (ms: number) => new Date(ms).toLocaleString('zh-CN', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'});
export function AuthorLine({author, prefix = ''}: {author: Author | null | undefined; prefix?: string}) {
  if (!author) return null;
  return <span className="sgm-author">{prefix}{author.kind === 'agent' ? `AI · ${author.session}` : '你'} · {when(author.at)}</span>;
}

export type VersionActions = {
  setBest: (v: Version) => void;
  reject: (v: Version) => void;
  restore: (v: Version) => void;
};

export function VersionRow({version, player, actions, busy, compact = false}: {version: Version; player: PlayerState; actions: VersionActions; busy: boolean; compact?: boolean}) {
  const current = player.current?.id === version.id;
  const length = current ? (player.duration || (version.durationMs ?? 0) / 1000) : 0;
  const progress = current && length ? player.position / length : null;
  const rejected = version.status === 'rejected';
  return <div className={`sgm-version ${current ? 'is-current' : ''} ${rejected ? 'is-rejected' : ''}`}>
    <button type="button" className="sgm-play" aria-label={`${current && player.playing ? '暂停' : '播放'} 第 ${version.roundNo} 轮 ${version.label}`}
      onClick={() => current && player.playing ? player.pause() : player.play(version)}>
      {current && player.playing ? <Pause size={16}/> : <Play size={16}/>}
    </button>
    <span className="sgm-version-label">{version.label}</span>
    <Waveform peaks={version.peaks} bars={compact ? 60 : 110} progress={progress} active={current}
      onSeek={f => current ? player.seek(f) : player.play(version, f)} label={`第 ${version.roundNo} 轮 ${version.label} 波形`}/>
    <span className="sgm-version-time">{clock(version.durationMs)}</span>
    <span className="sgm-version-badges">
      {version.isFinal && <span className="sgm-pill accent">定稿</span>}
      {version.isBest && <span className="sgm-pill accent"><Star size={12} fill="currentColor"/>当前最好</span>}
      {version.uploadedBy.kind === 'agent' && <span className="sgm-pill" title={`由 ${version.uploadedBy.session} 上传`}>AI 上传</span>}
    </span>
    <span className="sgm-version-actions">
      {!rejected && !version.isBest && <button type="button" className="sgm-icon" title="设为当前最好" aria-label={`把第 ${version.roundNo} 轮 ${version.label} 设为当前最好`} disabled={busy} onClick={() => actions.setBest(version)}><Star size={16}/></button>}
      <a className="sgm-icon" href={version.downloadUrl} download={version.downloadName} title="下载" aria-label={`下载第 ${version.roundNo} 轮 ${version.label}`}><Download size={16}/></a>
      {rejected
        ? <button type="button" className="sgm-icon" title="从淘汰区恢复" aria-label={`恢复第 ${version.roundNo} 轮 ${version.label}`} disabled={busy} onClick={() => actions.restore(version)}><RotateCcw size={16}/></button>
        : !version.isFinal && <button type="button" className="sgm-icon" title="淘汰（不删文件）" aria-label={`淘汰第 ${version.roundNo} 轮 ${version.label}`} disabled={busy} onClick={() => actions.reject(version)}><Archive size={16}/></button>}
    </span>
  </div>;
}

function Block({title, author, tag, children, empty}: {title: string; author?: Author | null; tag?: string; children?: React.ReactNode; empty?: string}) {
  return <section className="sgm-block">
    <header><h4>{title}{tag && <span className="sgm-pill">{tag}</span>}</h4><AuthorLine author={author}/></header>
    {children ?? <p className="sgm-empty">{empty}</p>}
  </section>;
}

export function RoundCard({song, round, previous, latest, open, onToggle, player, actions, busy, projectId, request, onChanged, onUpload}: {
  song: Song; round: Round; previous?: Round; latest: boolean; open: boolean; onToggle: () => void;
  player: PlayerState; actions: VersionActions; busy: boolean; projectId: string; request: Request;
  onChanged: (s: Song) => void; onUpload: (r: Round) => void;
}) {
  const [editing, setEditing] = useState<'' | 'prompt' | 'listening' | 'issues' | 'direction'>('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const versions = round.versions.filter(v => v.status !== 'rejected');
  const p = round.prompt;
  const patch = async (body: Record<string, unknown>) => {
    setSaving(true); setError('');
    try {
      onChanged(await request<Song>(`/project-music/projects/${projectId}/rounds/${round.id}`, {expectedRevision: round.revision, ...body}, 'PATCH'));
      setEditing('');
    } catch (e) { setError(message(e)); } finally { setSaving(false); }
  };
  const diff = round.promptDiffFromPrevious;
  const canUpload = song.status === 'active';

  return <article className={`sgm-round ${latest ? 'is-latest' : ''}`} aria-label={`第 ${round.roundNo} 轮`}>
    <header className="sgm-round-head">
      <button type="button" className="sgm-round-toggle" aria-expanded={open} onClick={onToggle}>
        {open ? <ChevronDown size={18}/> : <ChevronRight size={18}/>}
        <h3>第 {round.roundNo} 轮</h3>
      </button>
      <span className="sgm-pill">{p.tool || '未填工具'}</span>
      {p.sunoTier && <span className="sgm-pill">{TIER_LABEL[p.sunoTier]}</span>}
      {!round.promptConfirmed && <span className="sgm-pill warn">提示词待你确认</span>}
      {diff && <span className="sgm-round-diff">{diff.length ? `和上一轮比：改了${diff.map(k => PROMPT_FIELD_LABEL[k]).join('、')}` : '提示词和上一轮相同'}</span>}
      {!open && <span className="sgm-round-summary">{p.style || '（未填风格）'} · {versions.length} 个版本</span>}
      {open && canUpload && <button type="button" className="sgm-btn small ghost" onClick={() => onUpload(round)}><Upload size={14}/>上传到这一轮</button>}
    </header>
    {!open && versions.length > 0 && <div className="sgm-versions is-compact">{versions.map(v => <VersionRow key={v.id} version={v} player={player} actions={actions} busy={busy} compact/>)}</div>}
    {open && <>
      <div className="sgm-versions">
        {versions.length ? versions.map(v => <VersionRow key={v.id} version={v} player={player} actions={actions} busy={busy}/>)
          : <p className="sgm-empty">这一轮还没有版本。{canUpload && '点「上传到这一轮」添加。'}</p>}
      </div>

      {latest && !round.complete && song.status === 'active' && <p className="sgm-gate">开新一轮前，先补上这一轮的「{round.missing.map(k => k === 'issues' ? '问题整理' : '下一轮方向').join('」「')}」。</p>}

      <div className="sgm-record">
        <Block title="提示词" author={round.promptConfirmed ?? round.promptDraftedBy} tag={round.promptConfirmed ? undefined : 'AI 起草'}>
          {editing === 'prompt' ? <PromptEditor round={round} saving={saving} onCancel={() => setEditing('')} onSave={prompt => patch({prompt})}/> : <>
            <dl className="sgm-prompt">
              <dt>风格</dt><dd>{p.style || <em>未填</em>}</dd>
              <dt>歌词</dt><dd className="sgm-lyrics">{p.lyrics || <em>未填</em>}</dd>
              {p.params && <><dt>其他参数</dt><dd>{p.params}</dd></>}
              {p.sunoLink && <><dt>Suno</dt><dd>{p.sunoLink}</dd></>}
            </dl>
            <div className="sgm-block-actions">
              {!round.promptConfirmed && <button type="button" className="sgm-btn small primary" disabled={saving} onClick={() => patch({confirmPrompt: true})}>确认这份提示词</button>}
              <button type="button" className="sgm-btn small ghost" onClick={() => setEditing('prompt')}><Pencil size={13}/>改提示词</button>
            </div>
          </>}
        </Block>

        <Block title="你的听感" tag="你的原话">
          {editing === 'listening' ? <ListeningEditor round={round} saving={saving} onCancel={() => setEditing('')} onSave={listening => patch({listening})}/> : <>
            {round.listening.length ? <ul className="sgm-quotes">{round.listening.map(e => <li key={e.id}>
              <q>{e.text}</q>
              {e.kind === 'transcript' && <span className="sgm-author">转录自对话{e.saidAt ? `（原话时间 ${e.saidAt}）` : ''} · <AuthorLine author={e.author}/></span>}
            </li>)}</ul> : <p className="sgm-empty">还没有记录。听完说一句就行，AI 可以逐字转录进来。</p>}
            <div className="sgm-block-actions"><button type="button" className="sgm-btn small ghost" onClick={() => setEditing('listening')}><Plus size={13}/>写听感</button></div>
          </>}
        </Block>

        <Block title="改了什么" author={round.changes?.author} empty={previous ? '还没有记录（由 AI 比对后写）' : '第一轮，没有上一轮可比'}>
          {round.changes && <p>{round.changes.text}{round.changes.count != null && round.changes.count > 1 && <span className="sgm-pill warn">改了 {round.changes.count} 处</span>}</p>}
        </Block>

        <Block title="问题整理" author={round.issues?.author}>
          {editing === 'issues' ? <IssuesEditor round={round} saving={saving} onCancel={() => setEditing('')} onSave={issues => patch({issues})}/> : <>
            {round.issues?.items.length ? <ol className="sgm-issues">{round.issues.items.map((it, i) => <li key={i}>
              <span>{it.text}</span>
              <span className="sgm-pill">{it.source === 'user_words' ? '来自你的原话' : '来自客观检查'}</span>
              {it.causeGuess && <span className="sgm-guess">猜测：{it.causeGuess}</span>}
            </li>)}</ol> : <p className="sgm-empty">还没有整理。</p>}
            <div className="sgm-block-actions"><button type="button" className="sgm-btn small ghost" onClick={() => setEditing('issues')}><Pencil size={13}/>{round.issues ? '改' : '自己填写'}</button></div>
          </>}
        </Block>

        <Block title="客观检查" author={round.checks?.author}>
          <ul className="sgm-checks">{(['lyrics', 'tempo', 'duration', 'loudness'] as const).map(k => {
            const items = round.checks?.items.filter(c => c.item === k) ?? [];
            return <li key={k}><strong>{CHECK_LABEL[k]}</strong>{items.length ? items.map((c, i) => <span key={i}>{c.versionId && `${round.versions.find(v => v.id === c.versionId)?.label ?? ''} `}{c.result}<small>方法：{c.method}</small></span>) : <span className="sgm-empty">未检查</span>}</li>;
          })}
          {round.checks?.items.filter(c => c.item === 'other').map((c, i) => <li key={'o' + i}><strong>其他</strong><span>{c.result}<small>方法：{c.method}</small></span></li>)}
          </ul>
        </Block>

        <Block title="下一轮方向" tag="建议" author={round.nextDirection?.author}>
          {editing === 'direction' ? <DirectionEditor round={round} saving={saving} onCancel={() => setEditing('')} onSave={nextDirection => patch({nextDirection})}/> : <>
            {round.nextDirection ? <>
              <p>{round.nextDirection.text}</p>
              {round.nextDirection.promptDraft && (round.nextDirection.promptDraft.style || round.nextDirection.promptDraft.lyrics || round.nextDirection.promptDraft.params) && <dl className="sgm-prompt is-draft">
                {round.nextDirection.promptDraft.style && <><dt>风格草稿</dt><dd>{round.nextDirection.promptDraft.style}</dd></>}
                {round.nextDirection.promptDraft.lyrics && <><dt>歌词草稿</dt><dd className="sgm-lyrics">{round.nextDirection.promptDraft.lyrics}</dd></>}
                {round.nextDirection.promptDraft.params && <><dt>参数草稿</dt><dd>{round.nextDirection.promptDraft.params}</dd></>}
              </dl>}
            </> : <p className="sgm-empty">还没有方向。</p>}
            <div className="sgm-block-actions"><button type="button" className="sgm-btn small ghost" onClick={() => setEditing('direction')}><Pencil size={13}/>{round.nextDirection ? '改' : '自己填写'}</button></div>
          </>}
        </Block>
      </div>
      {error && <p className="sgm-error" role="alert">{error}</p>}
    </>}
  </article>;
}

function PromptEditor({round, saving, onSave, onCancel}: {round: Round; saving: boolean; onSave: (p: Round['prompt']) => void; onCancel: () => void}) {
  const [p, setP] = useState(round.prompt);
  const set = (k: keyof Round['prompt']) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setP({...p, [k]: e.target.value});
  return <div className="sgm-editor">
    <div className="sgm-row2">
      <label className="sgm-field">生成工具<input value={p.tool} onChange={set('tool')}/></label>
      <label className="sgm-field">Suno 会员档位<select value={p.sunoTier} onChange={set('sunoTier')}>{(Object.keys(TIER_LABEL) as Round['prompt']['sunoTier'][]).map(k => <option key={k} value={k}>{TIER_LABEL[k]}</option>)}</select></label>
    </div>
    <label className="sgm-field">风格<textarea rows={2} value={p.style} onChange={set('style')}/></label>
    <label className="sgm-field">歌词<textarea rows={6} value={p.lyrics} onChange={set('lyrics')}/></label>
    <div className="sgm-row2">
      <label className="sgm-field">其他参数<input value={p.params} onChange={set('params')}/></label>
      <label className="sgm-field">Suno 链接或编号<input value={p.sunoLink} onChange={set('sunoLink')}/></label>
    </div>
    <EditorButtons saving={saving} onCancel={onCancel} onSave={() => onSave(p)}/>
  </div>;
}

function ListeningEditor({round, saving, onSave, onCancel}: {round: Round; saving: boolean; onSave: (l: {id?: string; text: string}[]) => void; onCancel: () => void}) {
  const [list, setList] = useState<{id?: string; text: string; transcript: boolean}[]>(round.listening.map(e => ({id: e.id, text: e.text, transcript: e.kind === 'transcript'})));
  return <div className="sgm-editor">
    {list.map((e, i) => <div key={e.id ?? i} className="sgm-inline">
      {e.transcript ? <q className="sgm-quote-fixed">{e.text}</q>
        : <textarea rows={2} aria-label={`第 ${i + 1} 句听感`} value={e.text} onChange={ev => setList(l => l.map((x, j) => j === i ? {...x, text: ev.target.value} : x))}/>}
      <button type="button" className="sgm-icon" aria-label={`删除第 ${i + 1} 句`} onClick={() => setList(l => l.filter((_, j) => j !== i))}><Trash2 size={15}/></button>
    </div>)}
    <button type="button" className="sgm-btn small ghost" onClick={() => setList(l => [...l, {text: '', transcript: false}])}><Plus size={13}/>加一句</button>
    <p className="sgm-hint">这里只写你自己的原话。AI 转录的句子保留原样，只能删除。</p>
    <EditorButtons saving={saving} onCancel={onCancel} onSave={() => onSave(list.filter(e => e.text.trim()).map(e => e.id ? {id: e.id, text: e.text} : {text: e.text}))}/>
  </div>;
}

function IssuesEditor({round, saving, onSave, onCancel}: {round: Round; saving: boolean; onSave: (v: {items: IssueItem[]} | null) => void; onCancel: () => void}) {
  const [items, setItems] = useState<IssueItem[]>(round.issues?.items ?? [{text: '', source: 'user_words', causeGuess: ''}]);
  const set = (i: number, patch: Partial<IssueItem>) => setItems(l => l.map((x, j) => j === i ? {...x, ...patch} : x));
  return <div className="sgm-editor">
    {items.map((it, i) => <div key={i} className="sgm-issue-edit">
      <input aria-label={`第 ${i + 1} 个问题`} value={it.text} placeholder="问题" onChange={e => set(i, {text: e.target.value})}/>
      <select aria-label={`第 ${i + 1} 个问题的来源`} value={it.source} onChange={e => set(i, {source: e.target.value as IssueItem['source']})}>
        <option value="user_words">来自你的原话</option><option value="objective_check">来自客观检查</option>
      </select>
      <input aria-label={`第 ${i + 1} 个问题的原因猜测`} value={it.causeGuess} placeholder="原因（猜测，选填）" onChange={e => set(i, {causeGuess: e.target.value})}/>
      <button type="button" className="sgm-icon" aria-label={`删除第 ${i + 1} 个问题`} onClick={() => setItems(l => l.filter((_, j) => j !== i))}><Trash2 size={15}/></button>
    </div>)}
    <button type="button" className="sgm-btn small ghost" onClick={() => setItems(l => [...l, {text: '', source: 'user_words', causeGuess: ''}])}><Plus size={13}/>加一条</button>
    <EditorButtons saving={saving} onCancel={onCancel} onSave={() => { const kept = items.filter(x => x.text.trim()); onSave(kept.length ? {items: kept} : null); }}/>
  </div>;
}

function DirectionEditor({round, saving, onSave, onCancel}: {round: Round; saving: boolean; onSave: (v: {text: string; promptDraft: PromptDraft | null} | null) => void; onCancel: () => void}) {
  const [text, setText] = useState(round.nextDirection?.text ?? '');
  return <div className="sgm-editor">
    <label className="sgm-field">下一轮打算怎么改<textarea rows={3} value={text} onChange={e => setText(e.target.value)} placeholder="尽量一次只改一处"/></label>
    <EditorButtons saving={saving} onCancel={onCancel} onSave={() => onSave(text.trim() ? {text, promptDraft: round.nextDirection?.promptDraft ?? null} : null)}/>
  </div>;
}

function EditorButtons({saving, onSave, onCancel}: {saving: boolean; onSave: () => void; onCancel: () => void}) {
  return <div className="sgm-block-actions">
    <button type="button" className="sgm-btn small ghost" disabled={saving} onClick={onCancel}>取消</button>
    <button type="button" className="sgm-btn small primary" disabled={saving} onClick={onSave}>{saving ? '保存中…' : '保存'}</button>
  </div>;
}
