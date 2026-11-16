// 「待看的修改」「改动记录」两个视图，以及「查看旧版本」（用户认可的设计稿②③④）。
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Crosshair, Eye, RotateCcw } from 'lucide-react';
import { ReadingMode } from './ReadingMode';
import { AUTHOR_LABEL, CATEGORY_LABEL, HistoryError, MIGRATION_REQUIRED, kb, show, when, type Change, type HistoryApi, type PendingList, type ReasonCategory, type VersionList, type VersionMeta } from './history';

const FIELD_LABEL: Record<string, string> = {framing: '景别与角度', action: '画面与人物动作', camera: '摄影机设计', sound: '环境与动作声', dialogue: '对白', duration_ms: '时长', transition: '剪辑衔接', first_frame: '第一帧状态', continuity: '连续性要求', design_note: '设计备注', physical_feedback: '物理反馈', environment_feedback: '环境反馈', result: '段落结果', character_ids: '关联人物', character_presence: '人物在场方式', reference_bindings: '参考图', audio_continuations: '语音承接', order: '镜头顺序', scene_id: '所属场景', $entity: '整镜增删', $number: '全片镜号', characters: '人物', assets: '素材清单', settings: '项目设置', title: '标题', synopsis: '故事核心', name: '场景名', location: '地点', story_time: '时间', interior_exterior: '内外景', spatial_setup: '空间设定', global_rules: '全片规则'};
const fieldName = (f: string) => FIELD_LABEL[f] ?? f;
const value = (field: string, v: unknown) => field === 'duration_ms' && typeof v === 'number' ? `${(v / 1000).toString()} 秒` : show(v);
const Problem = ({error}: {error: unknown}) => <p className="sb-history-alert" role="alert"><AlertTriangle size={15}/>{error instanceof HistoryError && error.code === MIGRATION_REQUIRED ? '改动记录还没有启用：这个素材库需要先做一次数据库迁移（由维护人员执行），分镜照常可以编辑和保存。' : (error as Error).message}</p>;
const Reason = ({author, category, text}: {author: string; category: ReasonCategory | null; text: string}) => <>
  <span className="sb-history-tag is-who">{AUTHOR_LABEL[author] ?? author}</span>
  {category && <span className="sb-history-tag is-why">{CATEGORY_LABEL[category]}</span>}
  {author === 'user' && <span className="sb-history-tag is-why">用户手动保存</span>}
  {text && (author === 'agent' || author === 'generation') && <q className="sb-history-quote">{text}</q>}
  {text && !['user', 'agent', 'generation'].includes(author) && <span className="sb-history-muted">{text}</span>}
</>;

/** 把一组「字段改前改后」显示成一行行。后端可能给整体 before/after 对象（按字段）或单值。 */
function Fields({fields, before, after}: {fields: string[]; before: unknown; after: unknown}) {
  const pick = (o: unknown, f: string) => o && typeof o === 'object' && !Array.isArray(o) && f in (o as object) ? (o as Record<string, unknown>)[f] : fields.length === 1 ? o : undefined;
  return <ul className="sb-history-fields">{fields.map(f => { const a = pick(before, f), b = pick(after, f); return <li key={f}><span className="sb-history-field">{fieldName(f)}：</span>{a === undefined && b === undefined ? <span className="sb-history-muted">已修改</span> : <><del>{value(f, a)}</del> → <ins>{value(f, b)}</ins></>}</li>; })}</ul>;
}

export function PendingPanel({api, refreshKey, onLocate, onCount}: {api: HistoryApi; refreshKey: unknown; onLocate: (shotId: string) => void; onCount: (n: number) => void}) {
  const [data, setData] = useState<PendingList | null>(null), [error, setError] = useState<unknown>(null), [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { const d = await api.pending(); setData(d); setError(null); onCount(d.pending_count); } catch (e) { setError(e); } }, [api, onCount]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  const clear = async (target: {shot_ids: string[]} | {all: true}) => { if (!data || busy) return; setBusy(true); try { const r = await api.clearPending(data.current_revision, target); onCount(r.pending_count); await load(); } catch (e) { setError(e); } finally { setBusy(false); } };
  const setCategory = async (v: number, next: ReasonCategory, prev: ReasonCategory | null) => { try { await api.setCategory(v, next, prev); await load(); } catch (e) { setError(e); } };
  return <div className="sb-history" aria-label="待看的修改">
    <div className="sb-history-head"><div><h3>待看的修改 · {data ? data.pending_count : '…'} 处</h3><p>保存后被改过、你还没看过的镜头。点「看过了」只清掉标记，不影响内容。</p></div>
      {!!data?.items.length && <button type="button" disabled={busy} onClick={() => void clear({all: true})}>全部看过</button>}</div>
    {error ? <Problem error={error}/> : null}
    {data && !data.items.length && <p className="sb-history-empty">没有待看的修改。</p>}
    {data?.items.map(item => { const v = Math.max(...item.versions); return <article key={item.target_kind + item.target_id} className="sb-history-card">
      <div className="sb-history-row">
        <strong>{item.target_kind === 'shot' ? (item.deleted ? `已删除镜头（当时镜 ${item.shot_number ?? '?'}）` : `镜 ${String(item.shot_number ?? '').padStart(2, '0')}`) : item.target_kind === 'scene' ? '场景设置' : '分镜整体设置'}</strong>
        <Reason author={item.author_kind} category={item.reason_category} text={item.reason_text}/>
        <span className="sb-history-muted">{item.versions.map(n => 'V' + n).join('、')}</span>
        <span className="sb-history-spacer"/>
        {item.author_kind === 'agent' && <select aria-label={'修改原因分类 V' + v} value={item.reason_category ?? ''} onChange={e => void setCategory(v, e.target.value as ReasonCategory, item.reason_category)}>{!item.reason_category && <option value="">未分类</option>}{(Object.keys(CATEGORY_LABEL) as ReasonCategory[]).map(k => <option key={k} value={k}>{CATEGORY_LABEL[k]}</option>)}</select>}
        {item.shot_id && !item.deleted && <button type="button" onClick={() => onLocate(item.shot_id!)}><Crosshair size={13}/>定位到镜头</button>}
        {item.shot_id && <button type="button" className="sb-primary" disabled={busy} onClick={() => void clear({shot_ids: [item.shot_id!]})}><Check size={13}/>看过了</button>}
      </div>
      {item.summary_only ? <p className="sb-history-muted">这次改动超过一半，只记了摘要；具体内容请在「改动记录」里查看那一版。</p> : item.target_kind === 'shot' ? <Fields fields={item.fields} before={item.before} after={item.after}/> : <p className="sb-history-muted">改了：{item.fields.map(fieldName).join('、')}（详细内容在「改动记录」里查看那一版）</p>}
    </article>; })}
  </div>;
}

export function LogPanel({api, refreshKey, onOpen}: {api: HistoryApi; refreshKey: unknown; onOpen: (meta: VersionMeta) => void}) {
  const [data, setData] = useState<VersionList | null>(null), [error, setError] = useState<unknown>(null), [more, setMore] = useState(false);
  const load = useCallback(async (offset = 0) => { try { const d = await api.versions(offset, 20); setData(old => offset && old ? {...d, items: [...old.items, ...d.items]} : d); setError(null); } catch (e) { setError(e); } finally { setMore(false); } }, [api]);
  useEffect(() => { void load(0); }, [load, refreshKey]);
  return <div className="sb-history" aria-label="改动记录">
    <div className="sb-history-head"><div><h3>改动记录</h3>{data && <p>本集历史占用 {kb(data.storage.bytes + data.storage.record_bytes)} · 保留最近 {data.storage.limit} 份完整版（现有 {data.storage.kept_full} 份）· 改动记录永久保留</p>}</div></div>
    {error ? <Problem error={error}/> : null}
    {data && <table className="sb-history-table"><colgroup><col style={{width:64}}/><col style={{width:100}}/><col/><col style={{width:120}}/><col style={{width:96}}/></colgroup><thead><tr><th>版本</th><th>时间</th><th>谁改的 · 原因</th><th>改了</th><th/></tr></thead><tbody>
      {data.items.map(m => <tr key={m.version}>
        <td><b>V{m.version}</b>{m.baseline && <small className="sb-history-muted"> 起点</small>}</td>
        <td className="sb-history-muted">{when(m.created_at)}</td>
        <td><div className="sb-history-row"><Reason author={m.author_kind} category={m.reason_category} text={m.reason_text}/>{m.restored_from != null && <span className="sb-history-muted">恢复到 V{m.restored_from}</span>}{m.reason_missing && m.author_kind === 'generation' && <span className="sb-history-muted">（没有记录指令）</span>}</div></td>
        <td>{m.summary_only ? <span className="sb-history-tag is-big">大改 · 只记摘要</span> : m.changed_shot_count ? `${m.changed_shot_count} 镜` : '—'}</td>
        <td>{m.full_available ? <button type="button" onClick={() => onOpen(m)}><Eye size={13}/>查看</button> : <span className="sb-history-muted" title="超过保留份数，完整版已清理；改动记录还在">完整版已清理</span>}</td>
      </tr>)}
    </tbody></table>}
    {data && data.items.length < data.total && <button type="button" className="sb-history-more" disabled={more} onClick={() => { setMore(true); void load(data.items.length); }}>{more ? '正在加载…' : '加载更早的记录'}</button>}
  </div>;
}

/** 只读查看某一版：整屏阅读样式；可和当前版本对比、恢复这一版（另存为新版本）。 */
export function OldVersion({api, meta, title, currentRevision, onClose, onRestored}: {api: HistoryApi; meta: VersionMeta; title: string; currentRevision: number; onClose: () => void; onRestored: () => void}) {
  const [project, setProject] = useState<unknown>(null), [diff, setDiff] = useState<Map<string, Change[]> | null>(null), [compare, setCompare] = useState(false), [error, setError] = useState<unknown>(null), [busy, setBusy] = useState(false), [invalid, setInvalid] = useState<unknown[] | null>(null);
  useEffect(() => { void api.version(meta.version).then(d => setProject(d.project), setError); }, [api, meta.version]);
  useEffect(() => { if (!compare || diff) return; void api.diff(meta.version, 'current').then(d => { const m = new Map<string, Change[]>(); for (const c of d.changes) if (c.shot_id) m.set(c.shot_id, [...(m.get(c.shot_id) ?? []), c]); setDiff(m); }, setError); }, [api, compare, diff, meta.version]);
  const restore = async () => { if (busy || !window.confirm(`把 V${meta.version} 的内容恢复成一个新版本？现在的版本和之后的历史都会保留，可以再恢复回来。`)) return; setBusy(true); try { await api.restore(meta.version, currentRevision); onRestored(); } catch (e) { if (e instanceof HistoryError && e.code === 'RESTORE_ASSETS_INVALID') setInvalid(((e.data as {invalid_assets?: unknown[]})?.invalid_assets) ?? []); else setError(e); } finally { setBusy(false); } };
  const banner = <div className="sb-history-banner">
    <strong>正在查看 V{meta.version}（只读）</strong><span className="sb-history-muted">{when(meta.created_at)} · {AUTHOR_LABEL[meta.author_kind] ?? meta.author_kind}{meta.reason_category ? ' · ' + CATEGORY_LABEL[meta.reason_category] : ''}</span>
    <span className="sb-history-spacer"/>
    <button type="button" aria-pressed={compare} onClick={() => setCompare(v => !v)}>{compare ? '✓ ' : ''}和当前版本对比</button>
    <button type="button" disabled={busy || meta.version === currentRevision} onClick={() => void restore()}><RotateCcw size={13}/>恢复这一版</button>
    {error ? <Problem error={error}/> : null}
    {invalid && <p className="sb-history-alert" role="alert"><AlertTriangle size={15}/>不能恢复：这一版引用的 {invalid.length} 个资产现在已不可用，请先在素材清单里处理。</p>}
  </div>;
  if (!project) return <div className="sb-reading" role="dialog" aria-modal="true" aria-label={`查看 V${meta.version}`}><div className="sb-reading-bar"><button type="button" onClick={onClose}>返回当前版本</button></div>{error ? <Problem error={error}/> : <p className="sb-reading-empty">正在读取 V{meta.version}…</p>}</div>;
  return <ReadingMode project={project} title={title} exitLabel="返回当前版本" banner={banner} diff={compare ? diff ?? new Map() : undefined} onClose={onClose}/>;
}
