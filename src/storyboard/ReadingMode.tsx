// 分镜「阅读模式」（用户认可的设计稿）：整屏只留阅读内容，顶部一条细栏；Esc 退出。
// 左边是画面和台词，右边一窄栏放镜头和声音（可收起）；两个镜头之间显示上一镜的「剪辑衔接」。只读，不改分镜。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import * as domain from '../../server/storyboard/shared/model.mjs';
import { segmentSummary } from './segments';

type Any = any; // 与 StoryboardEditor 一致：分镜文档是后端共享模型，前端不重复声明完整类型
const M = domain as Any;
/** 阅读用的短时间码：分:秒.一位小数 */
const tc = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${(ms % 60000 / 1000).toFixed(1).padStart(4, '0')}`;
type Row = {shot: Any; scene: Any; sceneIndex: number; number: string; start_ms: number; end_ms: number};
/** 左侧目录栏（用户认可的设计稿）：宽屏默认展开、可收起并记住；窄屏默认收起，点「目录」滑出，点一镜后收回。 */
const NAV_KEY = 'shiguang.storyboard.readingNav';
const narrowScreen = () => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 760px)').matches;
const readNav = () => { if (narrowScreen()) return false; try { return localStorage.getItem(NAV_KEY) !== 'closed'; } catch { return true; } };
type NavItem = {kind: 'segment'; key: string; seg: Any} | {kind: 'scene'; key: string; label: string} | {kind: 'shot'; key: string; row: Row};

type DiffChange = {field: string; before: unknown; after: unknown; deleted: boolean};
const FIELD: Record<string, string> = {framing: '景别与角度', action: '画面与人物动作', camera: '摄影机设计', sound: '环境与动作声', dialogue: '对白', duration_ms: '时长', transition: '剪辑衔接', order: '镜头顺序', scene_id: '所属场景', $entity: '整镜', $number: '全片镜号'};
const text = (v: unknown) => v === null || v === undefined || v === '' ? '（空）' : typeof v === 'string' ? v : JSON.stringify(v);
/** banner/diff 用于「查看旧版本」：只读，diff 来自「这一版 → 当前版本」，删除线是当前版，绿色是这一版。 */
export function ReadingMode({project, title, onClose, onJump, exitLabel = '退出阅读', banner, diff}: {project: Any; title: string; onClose: () => void; onJump?: (shotId: string) => void; exitLabel?: string; banner?: React.ReactNode; diff?: Map<string, DiffChange[]>}) {
  const rows: Row[] = useMemo(() => M.timeline(project), [project]);
  const [side, setSide] = useState(true), [nav, setNav] = useState(readNav), [current, setCurrent] = useState('');
  const navBox = useRef<HTMLElement>(null);
  const segStart = useMemo(() => new Map<string, Any>(segmentSummary(project).segments.map((g: Any) => [g.start_shot_id, g])), [project]);
  const exit = useRef<HTMLButtonElement>(null), body = useRef<HTMLDivElement>(null);
  const names = useMemo(() => new Map<string, string>((project.characters ?? []).map((c: Any) => [c.id, c.name])), [project]);
  const scenes = useMemo(() => {
    const out: {scene: Any; index: number; rows: Row[]}[] = [];
    for (const r of rows) { const last = out.at(-1); if (last && last.scene.id === r.scene.id) last.rows.push(r); else out.push({scene: r.scene, index: r.sceneIndex, rows: [r]}); }
    return out;
  }, [rows]);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null; exit.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); if (before && document.contains(before)) before.focus(); };
  }, [onClose]);
  const total = rows.at(-1)?.end_ms ?? 0;
  const sceneLabel = (s: Any, i: number) => `场 ${String(i + 1).padStart(2, '0')} · ${s.location || s.name || '未命名场景'}`;
  // 目录顺序与编辑表格一致：段分界在上、场次在下；一个段跨场景时在段下面分别列出场次。
  const navItems = useMemo(() => { const out: NavItem[] = []; let scene = ''; for (const r of rows) { const seg = segStart.get(r.shot.id); if (seg) { out.push({kind: 'segment', key: 'g' + seg.id, seg}); scene = ''; } if (r.scene.id !== scene) { scene = r.scene.id; out.push({kind: 'scene', key: 's' + r.scene.id + r.shot.id, label: sceneLabel(r.scene, r.sceneIndex)}); } out.push({kind: 'shot', key: r.shot.id, row: r}); } return out; }, [rows, segStart]);
  const toggleNav = () => setNav(open => { const next = !open; if (!narrowScreen()) { try { localStorage.setItem(NAV_KEY, next ? 'open' : 'closed'); } catch { /* 记不住只影响下次默认 */ } } return next; });
  const jump = (id: string) => { body.current?.querySelector<HTMLElement>(`[data-shot="${CSS.escape(id)}"]`)?.scrollIntoView({block: 'start'}); setCurrent(id); if (narrowScreen()) setNav(false); };
  // 跟着滚动高亮：取正文可见区里最靠上的一镜
  useEffect(() => {
    const root = body.current; if (!root || typeof IntersectionObserver === 'undefined') return;
    const seen = new Map<string, number>();
    const io = new IntersectionObserver(entries => { for (const e of entries) { const id = (e.target as HTMLElement).dataset.shot!; if (e.isIntersecting) seen.set(id, e.boundingClientRect.top); else seen.delete(id); } const top = [...seen.entries()].sort((a, b) => a[1] - b[1])[0]?.[0]; if (top) setCurrent(top); }, {root, rootMargin: '-48px 0px -55% 0px'});
    root.querySelectorAll<HTMLElement>('article[data-shot]').forEach(a => io.observe(a));
    return () => io.disconnect();
  }, [rows, side]);
  useEffect(() => { if (nav && current) navBox.current?.querySelector<HTMLElement>(`[data-nav-shot="${CSS.escape(current)}"]`)?.scrollIntoView({block: 'nearest'}); }, [nav, current]);
  return <div className="sb-reading" role="dialog" aria-modal="true" aria-label="分镜阅读模式">
    <div className="sb-reading-bar">
      <button ref={exit} type="button" onClick={onClose}><ArrowLeft size={15}/>{exitLabel}</button>
      <strong className="sb-reading-title">{title}</strong>
      <span className="sb-reading-muted">{rows.length} 镜 · {M.sec(total)} 秒</span>
      <button type="button" aria-pressed={nav} aria-controls="sb-reading-nav" onClick={toggleNav}>{nav ? <PanelLeftClose size={15}/> : <PanelLeftOpen size={15}/>}目录</button>
      <span className="sb-reading-spacer"/>
      <label className="sb-reading-toggle"><input type="checkbox" checked={side} onChange={e => setSide(e.target.checked)}/>显示镜头与声音</label>
      <span className="sb-reading-muted">Esc 退出</span>
    </div>
    {banner}
    <div className="sb-reading-layout" data-nav={nav}>
    {nav && <nav id="sb-reading-nav" ref={navBox} className="sb-reading-nav" aria-label="目录">
      {navItems.map(it => it.kind === 'segment' ? <div key={it.key} className={'sb-reading-nav-seg' + (it.seg.overlong ? ' is-over' : '')}>{it.seg.name} 段<span>{it.seg.shot_count} 镜 · {M.sec(it.seg.duration_ms)} 秒{it.seg.overlong ? ' · 超长' : ''}</span></div>
        : it.kind === 'scene' ? <div key={it.key} className="sb-reading-nav-scene">{it.label}</div>
        : <button key={it.key} type="button" data-nav-shot={it.row.shot.id} aria-current={current === it.row.shot.id ? 'location' : undefined} className={'sb-reading-nav-shot' + (current === it.row.shot.id ? ' is-now' : '')} onClick={() => jump(it.row.shot.id)}><b>{it.row.number}</b><em>{it.row.shot.framing || it.row.shot.action || '新镜头'}</em><small>{M.sec(it.row.shot.duration_ms)}s</small></button>)}
    </nav>}
    <div className="sb-reading-body" ref={body}>
      {!rows.length && <p className="sb-reading-empty">这一集还没有镜头。</p>}
      {scenes.map(g => <section key={g.scene.id} data-scene={g.scene.id} aria-label={sceneLabel(g.scene, g.index)}>
        <h2 className="sb-reading-scene">{sceneLabel(g.scene, g.index)}<small>{[g.scene.story_time, g.scene.interior_exterior].filter(Boolean).join(' · ')}{g.scene.story_time || g.scene.interior_exterior ? ' · ' : ''}{g.rows.length} 镜 · {M.sec(g.rows.reduce((n, r) => n + r.shot.duration_ms, 0))} 秒</small></h2>
        {g.rows.map(r => {
          const index = rows.indexOf(r), next = rows[index + 1];
          const seg = segStart.get(r.shot.id);
          return <React.Fragment key={r.shot.id}>
            {seg && <div className={'sb-reading-segment' + (seg.overlong ? ' is-over' : '')} data-testid={'reading-segment-' + seg.name}><b>{seg.name} 段</b><span>{seg.shot_count} 镜 · {M.sec(seg.duration_ms)} 秒{seg.overlong ? ' · 超长' : ''}</span></div>}
            <article className={'sb-reading-shot' + (side ? '' : ' is-narrow') + (diff?.has(r.shot.id) ? ' is-diff' : '')} data-shot={r.shot.id}>
              <button type="button" className="sb-reading-num" title={onJump ? '回到编辑并定位到这一镜' : undefined} disabled={!onJump} onClick={() => onJump?.(r.shot.id)}>{r.number}<small>{M.sec(r.shot.duration_ms)} 秒<br/>{tc(r.start_ms)}–{tc(r.end_ms)}</small></button>
              <div className="sb-reading-main">
                {r.shot.framing && <div className="sb-reading-frame">{r.shot.framing}</div>}
                <p className="sb-reading-act">{r.shot.action || <span className="sb-reading-muted">画面与人物动作待补充</span>}</p>
                {(r.shot.dialogue ?? []).filter((d: Any) => d.text).map((d: Any) => <p key={d.id} className="sb-reading-dia"><b>{names.get(d.character_id) || '未指定人物'}</b>{d.text}</p>)}
                {diff?.get(r.shot.id)?.map((c, i) => <p key={i} className="sb-reading-diff"><span>{FIELD[c.field] ?? c.field}：</span>{c.deleted ? '当前版本已删除这一镜' : <><del>{text(c.after)}</del> → <ins>{text(c.before)}</ins></>}</p>)}
              </div>
              {side && <div className="sb-reading-side">
                {r.shot.camera && <p><b>镜头</b>{r.shot.camera}</p>}
                {r.shot.sound && <p><b>声音</b>{r.shot.sound}</p>}
              </div>}
            </article>
            {next && r.shot.transition && <div className="sb-reading-cut"><span><b>{r.number} → {next.number}</b>{r.shot.transition}</span></div>}
          </React.Fragment>;
        })}
      </section>)}
    </div>
    </div>
  </div>;
}
