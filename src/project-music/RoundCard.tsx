import React, {useState} from 'react';
import {Archive, ChevronDown, ChevronRight, Download, GitCompare, Pause, Pencil, Play, Plus, RotateCcw, Star, Trash2, Undo2, Upload} from 'lucide-react';
import {Waveform} from './Waveform';
import {clock, type PlayerState} from './Player';
import type {Author, Request, Round, Song, Version} from './types';
import {beijingTime} from './time';
import {CHECK_LABEL, DECISION_LABEL, PROMPT_FIELD_LABEL, TIER_LABEL} from './types';
import {usePlatformWords} from '../platform-words';

const message = (e: unknown) => e instanceof Error ? e.message : String(e || '请求失败');
export function AuthorLine({author, prefix = ''}: {author: Author | null | undefined; prefix?: string}) {
  if (!author) return null;
  return <span className="sgm-author">{prefix}{author.kind === 'agent' ? `AI · ${author.session}` : '你'} · {beijingTime(author.at)}</span>;
}

export type VersionActions = {
  setBest: (v: Version) => void;
  reject: (v: Version) => void;
  restore: (v: Version) => void;
  compareWithBest: (v: Version) => void;
  /** 改回 AI 按你原话做的改动；undoable 为 false 时不显示按钮。 */
  undoDecision: (v: Version) => void;
  undoable: (v: Version) => boolean;
};

// 音乐库里的情况：一行小字。系统标签（AI生成、项目、歌名、轮次）不重复列出，只列按提示词和测量的。
function LibraryLine({version}: {version: Version}) {
  const words = usePlatformWords();
  const l = version.library;
  const prompt = version.tags.filter(t => t.source === 'prompt').map(t => t.tag);
  const measured = version.tags.filter(t => t.source === 'measured');
  if (!l.inLibrary && !('migrating' in l)) return null;
  return <p className="sgm-version-meta">
    {'migrating' in l
      ? (l.migrationError ? <span className="sgm-meta-warn">没搬进音乐库：{l.migrationError}</span> : <span>正在从旧位置搬进音乐库…</span>)
      : <>
        <span title={l.name ?? undefined}>音乐库：{l.reused ? `复用已有的「${l.name}」` : [l.category, l.sub].filter(Boolean).join(' / ') || '待确认'}</span>
        {l.missing && <span className="sgm-meta-warn">音乐库里的记录已删除，文件读不到</span>}
        {l.offline && !l.missing && <span className="sgm-meta-warn">文件不在原位置（离线）{l.place ? `：原来在「${l.place}」` : ''}。{words.editOutside}把它放回原处（同一个文件夹、同一个名字）就能恢复；如果已经清空了{words.trash}，这个版本就听不了了</span>}
        {l.moved && !l.missing && !l.offline && <span className="sgm-meta-warn">位置变了，需要核对</span>}
        {l.tagSync === 'failed' && <span className="sgm-meta-warn">标签没写进音乐库：{l.tagError}</span>}
        {prompt.length > 0 && <span>按提示词：{prompt.join('、')}</span>}
        {measured.length > 0 && <span title={measured[0].method}>测量：{measured.map(t => t.tag).join('、')}</span>}
      </>}
  </p>;
}

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
      {version.uploadedBy.kind === 'user' && version.uploadedBy.via === 'finder' && <span className="sgm-pill" title="从访达右键收纳进来">访达收纳</span>}
      {version.status === 'rejected' && 'unusedTagged' in version.library && version.library.unusedTagged && <span className="sgm-pill" title="音乐库里打了「未选用」标签，不隐藏">音乐库：未选用</span>}
    </span>
    <span className="sgm-version-actions">
      {!rejected && !version.isBest && <button type="button" className="sgm-icon" title="设为当前最好" aria-label={`把第 ${version.roundNo} 轮 ${version.label} 设为当前最好`} disabled={busy} onClick={() => actions.setBest(version)}><Star size={16}/></button>}
      {!rejected && !version.isBest && <button type="button" className="sgm-icon" title="和当前最好对比" aria-label={`第 ${version.roundNo} 轮 ${version.label} 和当前最好对比`} onClick={() => actions.compareWithBest(version)}><GitCompare size={16}/></button>}
      <a className="sgm-icon" href={version.downloadUrl} download={version.downloadName} title="下载" aria-label={`下载第 ${version.roundNo} 轮 ${version.label}`}><Download size={16}/></a>
      {rejected
        ? <button type="button" className="sgm-icon" title="从淘汰区恢复" aria-label={`恢复第 ${version.roundNo} 轮 ${version.label}`} disabled={busy} onClick={() => actions.restore(version)}><RotateCcw size={16}/></button>
        : !version.isFinal && <button type="button" className="sgm-icon" title="淘汰（不删文件）" aria-label={`淘汰第 ${version.roundNo} 轮 ${version.label}`} disabled={busy} onClick={() => actions.reject(version)}><Archive size={16}/></button>}
    </span>
    {version.decidedBy && actions.undoable(version) && <p className="sgm-version-decision">
      <span className="sgm-pill warn">AI 改的</span>
      <span>{DECISION_LABEL[version.decidedBy.action]}，依据你说的「{version.decidedBy.userWords}」{version.decidedBy.saidAt ? `（${version.decidedBy.saidAt}）` : ''}</span>
      <AuthorLine author={version.decidedBy.author}/>
      <button type="button" className="sgm-btn small ghost" disabled={busy} aria-label={`改回第 ${version.roundNo} 轮 ${version.label} 的 AI 改动`} onClick={() => actions.undoDecision(version)}><Undo2 size={14}/>改回</button>
    </p>}
    <LibraryLine version={version}/>
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
      {p.sunoTier ? <span className="sgm-pill">{TIER_LABEL[p.sunoTier]}</span> : /suno/i.test(p.tool) && <span className="sgm-pill warn" title="Suno 会员档位只能由你填：在「改提示词」里选，拿不准就选「不确定」">档位未填</span>}
      {!round.promptConfirmed && <span className="sgm-pill warn">{round.prompt.style || round.prompt.lyrics ? '提示词待你确认' : '还没有提示词'}</span>}
      {round.pendingAgentNotes && <span className="sgm-pill warn" title={`${round.pendingAgentNotes.reason}；记录由 AI 补写，你不用管`}>待 AI 补写</span>}
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
              {p.sunoLink && <><dt>Suno</dt><dd>{p.sunoLink}{round.sunoLinkBy && <span className="sgm-pill" title={`由 ${round.sunoLinkBy.kind === 'agent' ? round.sunoLinkBy.session : '你'} 填写`}>AI 填</span>}</dd></>}
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

        <Block title="问题整理">
          {round.issues?.items.length ? <div className="sgm-part">
            <AuthorLine author={round.issues.author}/>
            <ol className="sgm-issues">{round.issues.items.map((it, i) => <li key={i}>
              <span>{it.text}</span>
              <span className="sgm-pill">{it.source === 'user_words' ? '来自你的原话' : '来自客观检查'}</span>
              {it.causeGuess && <span className="sgm-guess">猜测：{it.causeGuess}</span>}
            </li>)}</ol>
          </div> : null}
          {editing === 'issues' ? <NoteEditor label="你写的问题整理（一句话也行）" initial={round.userIssues?.text ?? ''} saving={saving} onCancel={() => setEditing('')} onSave={userIssues => patch({userIssues})}/>
            : round.userIssues ? <div className="sgm-part is-user"><AuthorLine author={round.userIssues.author}/><p>{round.userIssues.text}</p></div> : null}
          {!round.issues?.items.length && !round.userIssues && editing !== 'issues' && <p className="sgm-empty">还没有整理。</p>}
          {editing !== 'issues' && <div className="sgm-block-actions"><button type="button" className="sgm-btn small ghost" onClick={() => setEditing('issues')}><Pencil size={13}/>{round.userIssues ? '改我写的' : '自己写一句'}</button></div>}
        </Block>

        <Block title="客观检查" author={round.checks?.author}>
          <ul className="sgm-checks">{(['lyrics', 'tempo', 'duration', 'loudness'] as const).map(k => {
            const items = round.checks?.items.filter(c => c.item === k) ?? [];
            return <li key={k}><strong>{CHECK_LABEL[k]}</strong>{items.length ? items.map((c, i) => <span key={i}>{c.versionId && `${round.versions.find(v => v.id === c.versionId)?.label ?? ''} `}{c.result}<small>方法：{c.method}</small></span>) : <span className="sgm-empty">未检查</span>}</li>;
          })}
          {round.checks?.items.filter(c => c.item === 'other').map((c, i) => <li key={'o' + i}><strong>其他</strong><span>{c.result}<small>方法：{c.method}</small></span></li>)}
          </ul>
        </Block>

        <Block title="下一轮方向">
          {round.nextDirection ? <div className="sgm-part">
            <span className="sgm-part-head"><span className="sgm-pill">建议</span><AuthorLine author={round.nextDirection.author}/></span>
            <p>{round.nextDirection.text}</p>
            {round.nextDirection.promptDraft && (round.nextDirection.promptDraft.style || round.nextDirection.promptDraft.lyrics || round.nextDirection.promptDraft.params) && <dl className="sgm-prompt is-draft">
              {round.nextDirection.promptDraft.style && <><dt>风格草稿</dt><dd>{round.nextDirection.promptDraft.style}</dd></>}
              {round.nextDirection.promptDraft.lyrics && <><dt>歌词草稿</dt><dd className="sgm-lyrics">{round.nextDirection.promptDraft.lyrics}</dd></>}
              {round.nextDirection.promptDraft.params && <><dt>参数草稿</dt><dd>{round.nextDirection.promptDraft.params}</dd></>}
            </dl>}
          </div> : null}
          {editing === 'direction' ? <NoteEditor label="你写的下一轮方向（一句话也行）" placeholder="尽量一次只改一处" initial={round.userDirection?.text ?? ''} saving={saving} onCancel={() => setEditing('')} onSave={userDirection => patch({userDirection})}/>
            : round.userDirection ? <div className="sgm-part is-user"><AuthorLine author={round.userDirection.author}/><p>{round.userDirection.text}</p></div> : null}
          {!round.nextDirection && !round.userDirection && editing !== 'direction' && <p className="sgm-empty">还没有方向。</p>}
          {editing !== 'direction' && <div className="sgm-block-actions"><button type="button" className="sgm-btn small ghost" onClick={() => setEditing('direction')}><Pencil size={13}/>{round.userDirection ? '改我写的' : '自己写一句'}</button></div>}
        </Block>
        {round.comparisons.length > 0 && <Block title="对比结果">
          <ul className="sgm-comparisons">{round.comparisons.map(c => {
            const nm = (side: 'left' | 'right') => `第 ${c[side].roundNo} 轮 ${c[side].label}`;
            const verdict = (w: string | null) => w === 'same' ? '差不多' : w === 'left' ? `${nm('left')} 更好` : w === 'right' ? `${nm('right')} 更好` : '';
            return <li key={c.id}>
              <span className="sgm-part-head"><strong>{nm('left')} ↔ {nm('right')}</strong>{c.blind && <span className="sgm-pill">盲听</span>}{c.loudness?.matched && <span className="sgm-pill">音量已对齐</span>}<AuthorLine author={c.author}/></span>
              {c.winner && <p>整体：{verdict(c.winner)}</p>}
              {c.segments.length > 0 && <p>{c.segments.map(sg => `${sg.label} ${verdict(sg.winner)}`).join('；')}</p>}
              {c.summary && <p>{c.summary}</p>}
            </li>;
          })}</ul>
        </Block>}
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

function NoteEditor({label, initial, placeholder, saving, onSave, onCancel}: {label: string; initial: string; placeholder?: string; saving: boolean; onSave: (v: string | null) => void; onCancel: () => void}) {
  const [text, setText] = useState(initial);
  return <div className="sgm-editor">
    <label className="sgm-field">{label}<textarea rows={3} value={text} placeholder={placeholder} onChange={e => setText(e.target.value)}/></label>
    <EditorButtons saving={saving} onCancel={onCancel} onSave={() => onSave(text.trim() ? text : null)}/>
  </div>;
}

function EditorButtons({saving, onSave, onCancel}: {saving: boolean; onSave: () => void; onCancel: () => void}) {
  return <div className="sgm-block-actions">
    <button type="button" className="sgm-btn small ghost" disabled={saving} onClick={onCancel}>取消</button>
    <button type="button" className="sgm-btn small primary" disabled={saving} onClick={onSave}>{saving ? '保存中…' : '保存'}</button>
  </div>;
}
