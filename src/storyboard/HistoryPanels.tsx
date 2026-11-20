// 「待看的修改」「改动记录」两个视图，以及「查看旧版本」（用户认可的设计稿②③④）。
import { Fragment, createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronLeft, ChevronRight, Crosshair, Eye, RotateCcw } from 'lucide-react';
import { ReadingMode } from './ReadingMode';
import { segmentDiffText, segmentEventText } from './segments';
import { AUTHOR_LABEL, CATEGORY_LABEL, HistoryError, MIGRATION_REQUIRED, PENDING_REVISION_CHANGED, kb, pendingBadge, show, when, type Change, type HistoryApi, type NoiseChange, type PendingItem, type PendingList, type PendingTarget, type ReasonCategory, type VersionChanges, type VersionList, type VersionMeta } from './history';

const FIELD_LABEL: Record<string, string> = {$segment: '分段', $segment_settings: '分割模式', framing: '景别与角度', action: '画面与人物动作', camera: '摄影机设计', sound: '环境与动作声', dialogue: '对白', duration_ms: '时长', transition: '剪辑衔接', first_frame: '第一帧状态', continuity: '连续性要求', design_note: '设计备注', physical_feedback: '物理反馈', environment_feedback: '环境反馈', result: '段落结果', character_ids: '关联人物', character_presence: '人物在场方式', reference_bindings: '参考图', audio_continuations: '语音承接', order: '镜头顺序', scene_id: '所属场景', $entity: '整镜增删', $move: '位置', $number: '全片镜号', $order: '场内序号', $scene_id: '所属场景', $scene_order: '场次顺序', source: '原始数据', import_source: '原始导入数据', extensions: '扩展数据', prop_ids: '道具', scene_asset_id: '场景素材', asset_manifest: '素材清单', metadata: '项目信息', generation_batches: '生成批次', generation_runs: '生成记录', characters: '人物', assets: '素材清单', settings: '项目设置', title: '标题', synopsis: '故事核心', name: '场景名', location: '地点', story_time: '时间', interior_exterior: '内外景', spatial_setup: '空间设定', global_rules: '全片规则'};
const fieldName = (f: string) => FIELD_LABEL[f] ?? '其它内容';
const FIELD_RANK = new Map(Object.keys(FIELD_LABEL).map((f, i) => [f, i]));
const byFieldOrder = (fields: string[]) => [...fields].sort((a, b) => (FIELD_RANK.get(a) ?? 999) - (FIELD_RANK.get(b) ?? 999));
const pad = (n: number | null | undefined) => n == null ? '?' : String(n).padStart(2, '0');
const clip = (text: string, max = 36) => text.length > max ? text.slice(0, max) + '…' : text;
const own = (o: unknown, f: string) => o && typeof o === 'object' && !Array.isArray(o) && Object.hasOwn(o, f) ? (o as Record<string, unknown>)[f] : undefined;
const value = (field: string, v: unknown) => field === 'duration_ms' && typeof v === 'number' ? `${(v / 1000).toString()} 秒` : show(v);
const Problem = ({error}: {error: unknown}) => <p className="sb-history-alert" role="alert"><AlertTriangle size={15}/>{error instanceof HistoryError && error.code === MIGRATION_REQUIRED ? '改动记录还没有启用：这个素材库需要先做一次数据库迁移（由维护人员执行）。迁移前可以继续改草稿，但保存会被拒绝，草稿会留在这台电脑上。' : (error as Error).message}</p>;
const Reason = ({author, category, text}: {author: string; category: ReasonCategory | null; text: string}) => <>
  <span className="sb-history-tag is-who">{AUTHOR_LABEL[author] ?? author}</span>
  {category && <span className="sb-history-tag is-why">{CATEGORY_LABEL[category]}</span>}
  {author === 'user' && <span className="sb-history-tag is-why">用户手动保存</span>}
  {text && (author === 'agent' || author === 'generation') && <q className="sb-history-quote">{text}</q>}
  {text && !['user', 'agent', 'generation'].includes(author) && <span className="sb-history-muted">{text}</span>}
</>;

const CharacterNames = createContext<ReadonlyMap<string, string>>(new Map());
/** 人物名只用于显示；取不到时对白仍显示台词，其它人物字段显示「已修改」。 */
function useCharacterNames(api: HistoryApi, revision: number | undefined) {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    if (revision === undefined) return; let live = true;
    api.version(revision).then(d => { if (!live) return; const list = (d.project as {characters?: {id?: unknown; name?: unknown}[]} | null)?.characters ?? []; setNames(new Map(list.flatMap(c => typeof c.id === 'string' && typeof c.name === 'string' && c.name ? [[c.id, c.name] as [string, string]] : []))); }, () => { if (live) setNames(new Map()); });
    return () => { live = false; };
  }, [api, revision]);
  return names;
}

type Line = {label: string; body: ReactNode};
type Row = Record<string, unknown>;
const MODIFIED = <span className="sb-history-muted">已修改</span>;
const PRESENCE: Record<string, string> = {visible: '画内', offscreen: '画外', voice_only: '仅声音', unspecified: '未说明'};
const rowsOf = (v: unknown): Row[] => Array.isArray(v) ? v.filter(x => x && typeof x === 'object' && !Array.isArray(x)) as Row[] : [];
const textOf = (v: unknown) => typeof v === 'string' ? v : '';
const Swap = ({a, b}: {a: ReactNode; b: ReactNode}) => <><del>{a === '' ? '（空）' : a}</del> → <ins>{b === '' ? '（空）' : b}</ins></>;

/** 对白按内部 id 对齐，但只显示说话人和台词等可读内容。 */
function dialogueLines(before: unknown, after: unknown, names: ReadonlyMap<string, string>): Line[] {
  const keyed = (v: unknown) => new Map(rowsOf(v).map((d, i) => [textOf(d.id) || '#' + i, d])), a = keyed(before), b = keyed(after), lines: Line[] = [];
  const who = (d: Row) => { const name = names.get(textOf(d.character_id)); return name ? name + '：' : ''; };
  for (const [key, next] of b) {
    const old = a.get(key);
    if (!old) { lines.push({label: '新增对白', body: <>{who(next)}<ins>{textOf(next.text) || '（空）'}</ins></>}); continue; }
    if (textOf(old.text) !== textOf(next.text)) lines.push({label: '对白', body: <>{who(next)}<Swap a={textOf(old.text)} b={textOf(next.text)}/></>});
    if (textOf(old.character_id) !== textOf(next.character_id)) { const x = names.get(textOf(old.character_id)), y = names.get(textOf(next.character_id)); lines.push({label: '说话人', body: x && y ? <Swap a={x} b={y}/> : MODIFIED}); }
    if (textOf(old.performance) !== textOf(next.performance)) lines.push({label: '表演要求', body: <>{who(next)}<Swap a={textOf(old.performance)} b={textOf(next.performance)}/></>});
    if (textOf(old.source) !== textOf(next.source)) lines.push({label: '声源', body: <>{who(next)}<Swap a={textOf(old.source)} b={textOf(next.source)}/></>});
  }
  for (const [key, old] of a) if (!b.has(key)) lines.push({label: '删除对白', body: <>{who(old)}<del>{textOf(old.text) || '（空）'}</del></>});
  if (!lines.length && [...a.keys()].join('\n') !== [...b.keys()].join('\n')) lines.push({label: '对白', body: '顺序有调整'});
  return lines.length ? lines : [{label: '对白', body: MODIFIED}];
}

/** 全部写成人话：名字齐全才列人物，其它结构只说数量变化或「已修改」，不显示内部 id 和原始 JSON。 */
function fieldLines(field: string, before: unknown, after: unknown, names: ReadonlyMap<string, string>): Line[] {
  if (field === 'dialogue') return dialogueLines(before, after, names);
  const label = fieldName(field), people = (ids: string[], tail: (i: number) => string = () => '') => ids.every(id => names.has(id)) ? ids.map((id, i) => names.get(id)! + tail(i)).join('、') : null;
  if (field === 'character_ids' && [before, after].every(v => v == null || Array.isArray(v))) { const x = people((before as string[] | null) ?? []), y = people((after as string[] | null) ?? []); return [{label, body: x === null || y === null || x === y ? MODIFIED : <Swap a={x} b={y}/>}]; }
  if (field === 'character_presence') { const text = (v: unknown) => { const list = rowsOf(v); return people(list.map(r => textOf(r.character_id)), i => `（${PRESENCE[textOf(list[i].mode)] ?? '未说明'}）`); }, x = text(before), y = text(after); return [{label, body: x === null || y === null || x === y ? MODIFIED : <Swap a={x} b={y}/>}]; }
  const structured = (v: unknown) => !!v && typeof v === 'object';
  if (structured(before) || structured(after)) { const size = (v: unknown) => Array.isArray(v) ? v.length : v == null ? 0 : null, x = size(before), y = size(after); return [{label, body: x !== null && y !== null && x !== y ? <Swap a={`${x} 项`} b={`${y} 项`}/> : MODIFIED}]; }
  if (/(^|_)ids?$/.test(field) || before === undefined && after === undefined) return [{label, body: MODIFIED}];
  return [{label, body: <Swap a={value(field, before)} b={value(field, after)}/>}];
}

/** 把一组「字段改前改后」显示成一行行。 */
function Fields({fields, before, after}: {fields: string[]; before: unknown; after: unknown}) {
  const names = useContext(CharacterNames);
  return <ul className="sb-history-fields">{byFieldOrder(fields).flatMap(f => fieldLines(f, own(before, f), own(after, f), names).map((line, i) => <li key={f + i}><span className="sb-history-field">{line.label}：</span>{line.body}</li>))}</ul>;
}

/** 整镜或整场增删：一句话，不显示原始数据。 */
function entityText(item: PendingItem) {
  const before = own(item.before, '$entity') as Record<string, string> | null | undefined, after = own(item.after, '$entity') as Record<string, string> | null | undefined;
  const removed = item.deleted || !!before && !after, verb = removed ? '删除了' : '新增了', v = before ?? after;
  if (item.target_kind === 'shot') { const detail = [v?.framing, v?.action && clip(v.action)].filter(Boolean).join(' · '); return `${verb}镜 ${item.shot_number ?? '?'}${detail ? '：' + detail : ''}`; }
  if (item.target_kind === 'scene') return `${verb}场景${v?.name ? '：' + v.name : ''}`;
  return verb + '整体设置';
}
type MovePoint = {number: number | null; scene_id: string | null; scene_name: string | null};
function moveText(item: PendingItem) {
  const a = own(item.before, '$move') as MovePoint | undefined, b = own(item.after, '$move') as MovePoint | undefined; if (!a || !b) return '位置有调整';
  const scene = a.scene_id !== b.scene_id ? (a.scene_name && b.scene_name ? `，从「${a.scene_name}」换到「${b.scene_name}」` : '，换了场景') : '';
  return (a.number === b.number ? `仍是镜 ${b.number ?? '?'}` : `从镜 ${a.number ?? '?'} 移到镜 ${b.number ?? '?'}`) + scene;
}
const targetLabel = (item: PendingItem, number: number | null) => item.target_kind === 'shot' ? `镜 ${pad(number)}` : item.target_kind === 'scene' ? '场景设置' : item.target_kind === 'segment' ? '分段' : '分镜整体设置';

function ChangeBody({item, shotNumber}: {item: PendingItem; shotNumber?: (shotId: string) => string | undefined}) {
  if (item.summary_only) return <p className="sb-history-muted">改了：{byFieldOrder(item.fields).map(fieldName).join('、') || '多处内容'}</p>;
  if (item.target_kind === 'segment') return <p className="sb-change-line">{segmentDiffText(item.before, item.after, shotNumber)}</p>;
  const rest = item.fields.filter(f => f !== '$entity' && f !== '$move');
  return <>
    {item.fields.includes('$entity') && <p className="sb-change-line">{entityText(item)}</p>}
    {item.fields.includes('$move') && <p className="sb-change-line">{moveText(item)}</p>}
    {rest.length > 0 && <Fields fields={rest} before={item.before} after={item.after}/>}
  </>;
}

/** 待看（按版本）和改动记录展开共用的一条改动。 */
function ChangeRow({item, shotNumber}: {item: PendingItem; shotNumber?: (shotId: string) => string | undefined}) {
  return <article className="sb-change">
    <strong>{targetLabel(item, item.shot_number)}{item.target_kind === 'shot' && !item.deleted && item.current_number != null && item.current_number !== item.shot_number && <small className="sb-history-muted">现为镜 {pad(item.current_number)}</small>}</strong>
    <div><ChangeBody item={item} shotNumber={shotNumber}/></div>
  </article>;
}

const noiseLine = (n: NoiseChange) => `${n.target_kind === 'shot' ? `镜 ${pad(n.shot_number)}` : n.target_kind === 'scene' ? '场景设置' : '分镜整体设置'} · ${fieldName(n.field)}${typeof n.before === 'number' && typeof n.after === 'number' ? `：${n.before} → ${n.after}` : '有变化'}`;

/** 只读展开一版的改动；不碰待看标记。 */
function VersionDetail({api, version, refreshKey, shotNumber}: {api: HistoryApi; version: number; refreshKey?: unknown; shotNumber?: (shotId: string) => string | undefined}) {
  const [data, setData] = useState<VersionChanges | null>(null), [error, setError] = useState<unknown>(null);
  useEffect(() => { let live = true; api.versionChanges(version).then(d => { if (live) { setData(d); setError(null); } }, e => { if (live) setError(e); }); return () => { live = false; }; }, [api, version, refreshKey]);
  if (error) return <Problem error={error}/>;
  if (!data) return <p className="sb-history-muted">正在读取 V{version} 的改动…</p>;
  const shifted = data.noise.filter(n => n.field === '$number' || n.field === '$order').length;
  return <div className="sb-version-detail">
    {data.detail === 'rebuilt' && <p className="sb-history-muted">这一版只记了摘要，下面是用前后两份完整版重新比对出来的。</p>}
    {data.detail === 'summary' && <p className="sb-history-muted">这一版改动超过一半，只记了摘要；对应的完整版已清理，无法再还原逐项内容。</p>}
    {data.items.map(item => <ChangeRow key={item.target_id} item={item} shotNumber={shotNumber}/>)}
    {!data.items.length && data.detail !== 'summary' && <p className="sb-history-muted">这一版没有内容上的修改。</p>}
    {data.noise.length > 0 && <details className="sb-history-noise"><summary>另有 {data.noise.length} 处不算修改（镜号顺延 {shifted} 处，原始数据 {data.noise.length - shifted} 处）</summary><ul>{data.noise.map((n, i) => <li key={i}>{noiseLine(n)}</li>)}</ul></details>}
  </div>;
}

function CategorySelect({version, category, onChange}: {version: number; category: ReasonCategory | null; onChange: (next: ReasonCategory) => void}) {
  return <select aria-label={'修改原因分类 V' + version} value={category ?? ''} onChange={e => onChange(e.target.value as ReasonCategory)}>{!category && <option value="">未分类</option>}{(Object.keys(CATEGORY_LABEL) as ReasonCategory[]).map(k => <option key={k} value={k}>{CATEGORY_LABEL[k]}</option>)}</select>;
}

/** 看的版本没了（看过或被清）：先找更早的未看版本，没有再找最近的更新版本。list 从新到旧。 */
const nextVersion = (list: number[], previous: number | null) => previous === null ? list[0] ?? null : list.includes(previous) ? previous : list.find(v => v < previous) ?? list.filter(v => v > previous).at(-1) ?? null;

export function PendingPanel({api, refreshKey, onLocate, onCount, shotNumber}: {api: HistoryApi; refreshKey: unknown; onLocate: (shotId: string) => void; onCount: (n: number) => void; shotNumber?: (shotId: string) => string | undefined}) {
  const [data, setData] = useState<PendingList | null>(null), [error, setError] = useState<unknown>(null), [busy, setBusy] = useState(false), [mode, setMode] = useState<'version' | 'all'>('version'), [selected, setSelected] = useState<number | null>(null), [notice, setNotice] = useState(''), [detail, setDetail] = useState<number | null>(null), [foldOpen, setFoldOpen] = useState(false);
  const latest = useRef(0);
  // onCount 放进 ref：父组件每次渲染传进来的新函数不应让面板重新读待看。
  const onCountRef = useRef(onCount); onCountRef.current = onCount;
  const load = useCallback(async () => { const ticket = ++latest.current; try { const d = await api.pending(); if (ticket !== latest.current) return; setData(d); setError(null); setSelected(old => nextVersion(d.pending_versions.map(v => v.version), old)); onCountRef.current(pendingBadge(d)); } catch (e) { if (ticket === latest.current) setError(e); } }, [api]);
  useEffect(() => { setData(null); setSelected(null); setMode('version'); setNotice(''); setDetail(null); setFoldOpen(false); }, [api]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  const clear = async (target: PendingTarget, version?: number, guarded = true) => {
    if (!data || busy) return; setBusy(true); setNotice('');
    try { const r = await api.clearPending(data.current_revision, target, {...(version === undefined ? {} : {version}), ...(guarded ? {expected_revision: data.current_revision} : {})}); onCount(pendingBadge(r)); await load(); }
    catch (e) { if (e instanceof HistoryError && e.code === PENDING_REVISION_CHANGED) { setNotice('Codex 刚保存了新版本，列表已刷新。这次没有清除，请确认后再点一次。'); await load(); } else setError(e); }
    finally { setBusy(false); }
  };
  const setCategory = async (v: number, next: ReasonCategory, prev: ReasonCategory | null) => { try { await api.setCategory(v, next, prev); await load(); } catch (e) { setError(e); } };
  const names = useCharacterNames(api, data?.current_revision);
  const versions = data?.pending_versions ?? [], index = versions.findIndex(v => v.version === selected), page = index >= 0 ? versions[index] : null, older = index >= 0 ? versions.length - index - 1 : 0;
  const changed = data?.items.filter(i => !i.net_unchanged) ?? [], folded = data?.items.filter(i => i.net_unchanged) ?? [];
  const card = (item: PendingItem) => { const current = item.target_kind === 'shot' ? item.current_number ?? item.shot_number : null, inVersion = (v: number) => versions.find(p => p.version === v)?.items.find(i => i.target_id === item.target_id); return <article key={item.target_id} className="sb-history-card">
    <div className="sb-history-row">
      <strong>{targetLabel(item, current)}</strong>
      <span className="sb-history-muted">{item.versions.map(n => 'V' + n).join('、')}</span>
      <span className="sb-history-spacer"/>
      {item.shot_id && !item.deleted && item.current_number != null && <button type="button" onClick={() => onLocate(item.shot_id!)}><Crosshair size={13}/>定位到镜头</button>}
      <button type="button" className="sb-primary" disabled={busy} onClick={() => void clear({target_ids: [item.target_id]})}><Check size={13}/>看过了</button>
    </div>
    <ul className="sb-pending-reasons">{item.events.map(e => { const step = item.net_unchanged ? inVersion(e.version) : undefined; return <li key={e.version}><div className="sb-history-row"><span className="sb-history-muted">V{e.version}</span><Reason author={e.author_kind} category={e.reason_category} text={e.reason_text}/>{e.author_kind === 'agent' && <CategorySelect version={e.version} category={e.reason_category} onChange={next => void setCategory(e.version, next, e.reason_category)}/>}</div>{step && <ChangeBody item={step} shotNumber={shotNumber}/>}</li>; })}</ul>
    {item.net_unchanged ? <p className="sb-history-muted">合起来看，最后和改之前一样。</p> : <>{item.summary_only && <p className="sb-history-muted">这次改动超过一半，只记了摘要；具体内容请在「改动记录」里查看那一版。</p>}<ChangeBody item={item} shotNumber={shotNumber}/></>}
  </article>; };
  return <CharacterNames.Provider value={names}><div className="sb-history" aria-label="待看的修改">
    <div className="sb-history-head"><div><h3>待看的修改</h3><p>Codex 保存后改过、你还没看过的内容。点「看过了」只清掉标记，不影响内容。</p></div>
      {!!data?.items.length && <button type="button" disabled={busy} onClick={() => void clear({all: true}, undefined, false)}>全部看过</button>}</div>
    <div className="sb-pending-switch" role="group" aria-label="待看查看方式">
      <button type="button" aria-pressed={mode === 'version'} onClick={() => setMode('version')}>当前版本</button>
      <button type="button" aria-pressed={mode === 'all'} onClick={() => setMode('all')}>全部未看 · {data ? pendingBadge(data) : '…'} 处</button>
    </div>
    {error ? <Problem error={error}/> : null}
    {notice && <p className="sb-history-alert" role="status"><AlertTriangle size={15}/>{notice}</p>}
    {data && !data.items.length && <p className="sb-history-empty">没有待看的修改。</p>}
    {mode === 'version' && page && <section aria-label={'V' + page.version + ' 的修改'}>
      <div className="sb-pending-pager">
        <button type="button" disabled={!older} onClick={() => { setSelected(versions[index + 1].version); setDetail(null); }}><ChevronLeft size={14}/>上一版</button>
        <strong>V{page.version}{page.is_current ? '（当前）' : ''}</strong>
        <button type="button" disabled={index === 0} onClick={() => { setSelected(versions[index - 1].version); setDetail(null); }}>下一版<ChevronRight size={14}/></button>
        <span className="sb-history-muted">{older ? `前面还有 ${older} 版没看` : '前面没有没看的版本了'}{index > 0 ? ` · 后面还有 ${index} 版没看` : ''}</span>
      </div>
      {index === 0 && !page.is_current && <p className="sb-pending-note" role="status">当前版本 V{data!.current_revision} 没有待看内容，这是最近一版还没看的。</p>}
      <div className="sb-history-card sb-pending-version">
        <div className="sb-history-row">
          <Reason author={page.author_kind} category={page.reason_category} text={page.reason_text}/>
          <span className="sb-history-muted">{when(page.created_at)}</span>
          <span className="sb-history-spacer"/>
          {page.author_kind === 'agent' && <CategorySelect version={page.version} category={page.reason_category} onChange={next => void setCategory(page.version, next, page.reason_category)}/>}
          <button type="button" className="sb-primary" disabled={busy} onClick={() => void clear({all: true}, page.version)}><Check size={13}/>这一版看过了</button>
        </div>
        {page.summary_only && <p className="sb-pending-note">这次改动超过一半，只记了摘要。<button type="button" className="sb-history-link" aria-expanded={detail === page.version} onClick={() => setDetail(v => v === page.version ? null : page.version)}>{detail === page.version ? '收起详细改动' : '查看这一版的详细改动'}</button>（「改动记录」里也能查到）</p>}
        {page.summary_only && detail === page.version ? <VersionDetail api={api} version={page.version} shotNumber={shotNumber}/> : page.items.map(item => <ChangeRow key={item.target_id} item={item} shotNumber={shotNumber}/>)}
      </div>
    </section>}
    {mode === 'all' && !!data?.items.length && !changed.length && <p className="sb-history-empty">没有最终变化。</p>}
    {mode === 'all' && changed.map(card)}
    {mode === 'all' && folded.length > 0 && <section className="sb-pending-fold" aria-label="最后没有变化的内容">
      <div className="sb-history-row">
        <button type="button" className="sb-history-link" aria-expanded={foldOpen} onClick={() => setFoldOpen(v => !v)}>{foldOpen ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}还有 {folded.length} 处中途改过，最后没有变化</button>
        <span className="sb-history-spacer"/>
        <button type="button" disabled={busy} onClick={() => void clear({target_ids: folded.map(i => i.target_id)})}><Check size={13}/>这些都看过了</button>
      </div>
      {foldOpen && folded.map(card)}
    </section>}
  </div></CharacterNames.Provider>;
}

export function LogPanel({api, refreshKey, onOpen}: {api: HistoryApi; refreshKey: unknown; onOpen: (meta: VersionMeta) => void}) {
  const [data, setData] = useState<VersionList | null>(null), [error, setError] = useState<unknown>(null), [more, setMore] = useState(false), [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const names = useCharacterNames(api, data?.current_revision);
  const toggle = (v: number) => setOpen(old => { const next = new Set(old); if (!next.delete(v)) next.add(v); return next; });
  const load = useCallback(async (offset = 0) => { try { const d = await api.versions(offset, 20); setData(old => offset && old ? {...d, items: [...old.items, ...d.items]} : d); setError(null); } catch (e) { setError(e); } finally { setMore(false); } }, [api]);
  useEffect(() => { void load(0); }, [load, refreshKey]);
  return <CharacterNames.Provider value={names}><div className="sb-history" aria-label="改动记录">
    <div className="sb-history-head"><div><h3>改动记录</h3>{data && <p>本集历史占用 {kb(data.storage.bytes + data.storage.record_bytes)} · 保留最近 {data.storage.limit} 份完整版（现有 {data.storage.kept_full} 份）· 改动记录永久保留</p>}</div></div>
    {error ? <Problem error={error}/> : null}
    {data && <table className="sb-history-table"><colgroup><col style={{width:64}}/><col style={{width:100}}/><col/><col style={{width:150}}/><col style={{width:96}}/></colgroup><thead><tr><th>版本</th><th>时间</th><th>谁改的 · 原因</th><th>改了</th><th/></tr></thead><tbody>
      {data.items.map(m => { const shots = m.content_shot_count ?? m.changed_shot_count, expanded = open.has(m.version); return <Fragment key={m.version}><tr>
        <td><b>V{m.version}</b>{m.baseline && <small className="sb-history-muted"> 起点</small>}</td>
        <td className="sb-history-muted">{when(m.created_at)}</td>
        <td><div className="sb-history-row"><Reason author={m.author_kind} category={m.reason_category} text={m.reason_text}/>{m.restored_from != null && <span className="sb-history-muted">恢复到 V{m.restored_from}</span>}{m.reason_missing && m.author_kind === 'generation' && <span className="sb-history-muted">（没有记录指令）</span>}</div></td>
        <td>{m.summary_only ? <span className="sb-history-tag is-big">大改 · 只记摘要</span> : shots ? `${shots} 镜` : '—'} <button type="button" className="sb-history-link" aria-expanded={expanded} aria-label={`${expanded ? '收起' : '展开'} V${m.version} 的改动`} onClick={() => toggle(m.version)}>{expanded ? '收起' : '展开'}</button></td>
        <td>{m.full_available ? <button type="button" onClick={() => onOpen(m)}><Eye size={13}/>查看</button> : <span className="sb-history-muted" title="超过保留份数，完整版已清理；改动记录还在">完整版已清理</span>}</td>
      </tr>{expanded && <tr className="sb-history-expanded"><td colSpan={5}><VersionDetail api={api} version={m.version} refreshKey={refreshKey}/></td></tr>}</Fragment>; })}
    </tbody></table>}
    {data && data.items.length < data.total && <button type="button" className="sb-history-more" disabled={more} onClick={() => { setMore(true); void load(data.items.length); }}>{more ? '正在加载…' : '加载更早的记录'}</button>}
  </div></CharacterNames.Provider>;
}

/** 只读查看某一版：整屏阅读样式；可和当前版本对比、恢复这一版（另存为新版本）。 */
export function OldVersion({api, meta, title, currentRevision, onClose, onRestored}: {api: HistoryApi; meta: VersionMeta; title: string; currentRevision: number; onClose: () => void; onRestored: () => void}) {
  const [project, setProject] = useState<unknown>(null), [diff, setDiff] = useState<Change[] | null>(null), [compare, setCompare] = useState(false), [error, setError] = useState<unknown>(null), [busy, setBusy] = useState(false), [invalid, setInvalid] = useState<unknown[] | null>(null);
  useEffect(() => { void api.version(meta.version).then(d => setProject(d.project), setError); }, [api, meta.version]);
  useEffect(() => { if (!compare || diff) return; void api.diff(meta.version, 'current').then(d => setDiff(d.changes), setError); }, [api, compare, diff, meta.version]);
  // 后端 diff 方向：before = 这一版（V{n}），after = 当前版本。按这一版是否有该镜头分三类，不静默丢弃任何一条。
  const oldShots = new Set<string>(((project as {scenes?: {shots?: {id: string}[]}[]} | null)?.scenes ?? []).flatMap(sc => (sc.shots ?? []).map(q => q.id)));
  const byShot = new Map<string, Change[]>(), added = new Map<string, Change[]>(), others: Change[] = [];
  for (const c of diff ?? []) { if (c.target_kind === 'shot' && c.shot_id) { const m = oldShots.has(c.shot_id) ? byShot : added; m.set(c.shot_id, [...(m.get(c.shot_id) ?? []), c]); } else others.push(c); }
  const brief = (v: unknown) => { if (v && typeof v === 'object' && !Array.isArray(v)) { const o = v as Record<string, unknown>; const t = [o.framing, o.action].filter(x => typeof x === 'string' && x).join(' · '); if (t) return t; } return show(v); };
  const extra = compare && diff ? <div className="sb-history-compare">
    <p className="sb-history-muted">对比方向：<del>删除线</del> 是当前版本，<ins>绿色</ins> 是这一版（V{meta.version}）。{!diff.length && '两版内容相同。'}</p>
    {others.length > 0 && <section><h4>分镜和场景设置的差异</h4><ul className="sb-history-fields">{others.map((c, i) => c.target_kind === 'segment' || c.segment_event ? <li key={i}><span className="sb-history-field">分段（这一版 → 当前）：</span>{segmentEventText(c.segment_event)}</li> : <li key={i}><span className="sb-history-field">{c.target_kind === 'scene' ? '场景' : '整体'} · {fieldName(c.field)}：</span><del>{value(c.field, c.after)}</del> → <ins>{value(c.field, c.before)}</ins></li>)}</ul></section>}
    {added.size > 0 && <section><h4>当前版本有、这一版没有的镜头（{added.size}）</h4><ul className="sb-history-fields">{[...added.values()].map(cs => { const c = cs.find(x => x.field === '$entity') ?? cs[0]; return <li key={c.target_id}><span className="sb-history-field">镜 {c.shot_number_at_time ?? '?'}（当前版本新增）：</span><del>{brief(c.after)}</del></li>; })}</ul></section>}
  </div> : null;
  const restore = async () => { if (busy || !window.confirm(`把 V${meta.version} 的内容恢复成一个新版本？现在的版本和之后的历史都会保留，可以再恢复回来。`)) return; setBusy(true); try { await api.restore(meta.version, currentRevision); onRestored(); } catch (e) { if (e instanceof HistoryError && e.code === 'RESTORE_ASSETS_INVALID') setInvalid(((e.data as {invalid_assets?: unknown[]})?.invalid_assets) ?? []); else setError(e); } finally { setBusy(false); } };
  const banner = <div className="sb-history-banner">
    <strong>正在查看 V{meta.version}（只读）</strong><span className="sb-history-muted">{when(meta.created_at)} · {AUTHOR_LABEL[meta.author_kind] ?? meta.author_kind}{meta.reason_category ? ' · ' + CATEGORY_LABEL[meta.reason_category] : ''}</span>
    <span className="sb-history-spacer"/>
    <button type="button" aria-pressed={compare} onClick={() => setCompare(v => !v)}>{compare ? '✓ ' : ''}和当前版本对比</button>
    <button type="button" disabled={busy || meta.version === currentRevision} onClick={() => void restore()}><RotateCcw size={13}/>恢复这一版</button>
    {error ? <Problem error={error}/> : null}
    {invalid && <div className="sb-history-alert" role="alert"><AlertTriangle size={15}/><div>不能恢复：这一版引用的 {invalid.length} 项资产现在不可用，请先在素材清单里处理：<ul className="sb-history-fields">{invalid.map((a, i) => { const o = (a ?? {}) as Record<string, unknown>; const name = [o.name, o.label, o.title].find(x => typeof x === 'string' && x); const kind = [o.kind, o.type, o.asset_kind].find(x => typeof x === 'string' && x); const id = [o.id, o.asset_id].find(x => typeof x === 'string' && x); const why = [o.reason, o.message, o.code].find(x => typeof x === 'string' && x); return <li key={i}>{String(name ?? '未命名资产')}{kind ? `（${kind}）` : ''}{id ? <code> {String(id)}</code> : null}{why ? ` · ${why}` : ''}</li>; })}</ul></div></div>}
  </div>;
  if (!project) return <div className="sb-reading" role="dialog" aria-modal="true" aria-label={`查看 V${meta.version}`}><div className="sb-reading-bar"><button type="button" onClick={onClose}>返回当前版本</button></div>{error ? <Problem error={error}/> : <p className="sb-reading-empty">正在读取 V{meta.version}…</p>}</div>;
  return <ReadingMode project={project} title={title} exitLabel="返回当前版本" banner={<>{banner}{extra}</>} diff={compare ? byShot : undefined} onClose={onClose}/>;
}
