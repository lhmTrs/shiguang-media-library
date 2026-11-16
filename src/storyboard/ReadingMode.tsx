// 分镜「阅读模式」（用户认可的设计稿）：整屏只留阅读内容，顶部一条细栏；Esc 退出。
// 左边是画面和台词，右边一窄栏放镜头和声音（可收起）；两个镜头之间显示上一镜的「剪辑衔接」。只读，不改分镜。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import * as domain from '../../server/storyboard/shared/model.mjs';

type Any = any; // 与 StoryboardEditor 一致：分镜文档是后端共享模型，前端不重复声明完整类型
const M = domain as Any;
/** 阅读用的短时间码：分:秒.一位小数 */
const tc = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${(ms % 60000 / 1000).toFixed(1).padStart(4, '0')}`;
type Row = {shot: Any; scene: Any; sceneIndex: number; number: string; start_ms: number; end_ms: number};

export function ReadingMode({project, title, onClose, onJump}: {project: Any; title: string; onClose: () => void; onJump: (shotId: string) => void}) {
  const rows: Row[] = useMemo(() => M.timeline(project), [project]);
  const [side, setSide] = useState(true);
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
  const jumpScene = (id: string) => body.current?.querySelector<HTMLElement>(`[data-scene="${CSS.escape(id)}"]`)?.scrollIntoView({block: 'start'});
  const sceneLabel = (s: Any, i: number) => `场 ${String(i + 1).padStart(2, '0')} · ${s.location || s.name || '未命名场景'}`;
  return <div className="sb-reading" role="dialog" aria-modal="true" aria-label="分镜阅读模式">
    <div className="sb-reading-bar">
      <button ref={exit} type="button" onClick={onClose}><ArrowLeft size={15}/>退出阅读</button>
      <strong className="sb-reading-title">{title}</strong>
      <span className="sb-reading-muted">{rows.length} 镜 · {M.sec(total)} 秒</span>
      {scenes.length > 1 && <select aria-label="跳到场次" onChange={e => jumpScene(e.target.value)} defaultValue="">
        <option value="" disabled>跳到场次…</option>
        {scenes.map(g => <option key={g.scene.id} value={g.scene.id}>{sceneLabel(g.scene, g.index)}</option>)}
      </select>}
      <span className="sb-reading-spacer"/>
      <label className="sb-reading-toggle"><input type="checkbox" checked={side} onChange={e => setSide(e.target.checked)}/>显示镜头与声音</label>
      <span className="sb-reading-muted">Esc 退出</span>
    </div>
    <div className="sb-reading-body" ref={body}>
      {!rows.length && <p className="sb-reading-empty">这一集还没有镜头。</p>}
      {scenes.map(g => <section key={g.scene.id} data-scene={g.scene.id} aria-label={sceneLabel(g.scene, g.index)}>
        <h2 className="sb-reading-scene">{sceneLabel(g.scene, g.index)}<small>{[g.scene.story_time, g.scene.interior_exterior].filter(Boolean).join(' · ')}{g.scene.story_time || g.scene.interior_exterior ? ' · ' : ''}{g.rows.length} 镜 · {M.sec(g.rows.reduce((n, r) => n + r.shot.duration_ms, 0))} 秒</small></h2>
        {g.rows.map(r => {
          const index = rows.indexOf(r), next = rows[index + 1];
          return <React.Fragment key={r.shot.id}>
            <article className={'sb-reading-shot' + (side ? '' : ' is-narrow')} data-shot={r.shot.id}>
              <button type="button" className="sb-reading-num" title="回到编辑并定位到这一镜" onClick={() => onJump(r.shot.id)}>{r.number}<small>{M.sec(r.shot.duration_ms)} 秒<br/>{tc(r.start_ms)}–{tc(r.end_ms)}</small></button>
              <div className="sb-reading-main">
                {r.shot.framing && <div className="sb-reading-frame">{r.shot.framing}</div>}
                <p className="sb-reading-act">{r.shot.action || <span className="sb-reading-muted">画面与人物动作待补充</span>}</p>
                {(r.shot.dialogue ?? []).filter((d: Any) => d.text).map((d: Any) => <p key={d.id} className="sb-reading-dia"><b>{names.get(d.character_id) || '未指定人物'}</b>{d.text}</p>)}
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
  </div>;
}
