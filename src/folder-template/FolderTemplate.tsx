// 共用的「文件夹浏览」模板（SPEC 第十三节）：新画风，一开始就按两种内容设计——
// 音乐用 layout="rows"，每行一个圆形播放键加真实波形；视频用 layout="grid"，每张卡片一张缩略图。
// 这次只有项目音乐的「文件」区在用；生成视频等新画风试用几天后再换过来（灰度）。
// 只用 --sg-* 变量（由宿主页面提供，项目音乐在 .sg-music 上定义），不改现有的 --c-* 变量。
// 模板只管布局和导航：数据、上传、复制、在访达中显示这些动作都由宿主传进来，模板不发请求。
import React from 'react';
import {ChevronRight, Folder, FolderOpen, ImageOff} from 'lucide-react';
import './folder-template.css';

export type TemplateFolder = {id: string; name: string; parentId: string; count?: number};
/** 树顶上的特殊入口，比如项目音乐的「♪ 歌曲」：点了交给宿主处理（跳到别的标签）。 */
export type TemplateNode = {id: string; label: string; icon?: React.ReactNode; hint?: string; onSelect: () => void};
export type TemplateItem = {
  id: string; name: string;
  /** rows：波形（或其他横条）；grid：缩略图。 */
  visual: React.ReactNode;
  /** rows 里放在最左边的东西，比如播放键。 */
  leading?: React.ReactNode;
  meta?: React.ReactNode; badges?: React.ReactNode; actions?: React.ReactNode; details?: React.ReactNode;
  current?: boolean; selectable?: boolean;
};

const ROOT = '';

export function folderTrail(folders: TemplateFolder[], id: string): TemplateFolder[] {
  const out: TemplateFolder[] = [], seen = new Set<string>();
  let at = folders.find(f => f.id === id);
  while (at && !seen.has(at.id)) { seen.add(at.id); out.unshift(at); at = folders.find(f => f.id === at!.parentId); }
  return out;
}

export function Thumbnail({src, alt = ''}: {src: string | null | undefined; alt?: string}) {
  const [broken, setBroken] = React.useState(false);
  return src && !broken ? <img className="sgf-thumb" src={src} alt={alt} loading="lazy" draggable={false} onError={() => setBroken(true)}/>
    : <span className="sgf-thumb is-empty" aria-hidden="true"><ImageOff size={20}/></span>;
}

export function FolderTemplate({label, rootLabel, rootCount, folders, current, onNavigate, specialNodes = [], toolbar, notice, layout = 'rows',
  items, selected, onToggleSelect, emptyText = '这个文件夹还是空的', loading = false, itemLabel = '个文件'}: {
  label: string; rootLabel: string; rootCount?: number; folders: TemplateFolder[]; current: string; onNavigate: (id: string) => void;
  specialNodes?: TemplateNode[]; toolbar?: React.ReactNode; notice?: React.ReactNode; layout?: 'rows' | 'grid';
  items: TemplateItem[]; selected?: Set<string>; onToggleSelect?: (id: string) => void; emptyText?: string; loading?: boolean; itemLabel?: string;
}) {
  const trail = folderTrail(folders, current);
  const children = folders.filter(f => f.parentId === (current || 'root'));
  const count = (n?: number) => typeof n === 'number' ? (n ? `${n} ${itemLabel}` : '空') : '';
  function branch(parentId: string, seen: Set<string>): React.ReactNode {
    const list = folders.filter(f => f.parentId === parentId && !seen.has(f.id));
    if (!list.length) return null;
    return <ul>{list.map(f => <li key={f.id}>
      <button type="button" aria-current={current === f.id ? 'page' : undefined} onClick={() => onNavigate(f.id)} title={f.id}>
        <Folder size={15} aria-hidden="true"/><span>{f.name}</span>{typeof f.count === 'number' && f.count > 0 && <small>{f.count}</small>}
      </button>
      {branch(f.id, new Set([...seen, f.id]))}
    </li>)}</ul>;
  }
  return <div className="sgf" data-layout={layout}>
    <nav className="sgf-tree" aria-label={`${label}文件夹树`}>
      {specialNodes.map(n => <button key={n.id} type="button" className="sgf-special" title={n.hint} onClick={n.onSelect}>{n.icon}<span>{n.label}</span>{n.hint && <small>{n.hint}</small>}</button>)}
      <button type="button" aria-current={current === ROOT ? 'page' : undefined} onClick={() => onNavigate(ROOT)}>
        <FolderOpen size={15} aria-hidden="true"/><span>{rootLabel}</span>{!!rootCount && <small>{rootCount}</small>}
      </button>
      {branch('root', new Set())}
    </nav>
    <section className="sgf-main" aria-label={label} aria-busy={loading || undefined}>
      <header className="sgf-head">
        <nav className="sgf-crumbs" aria-label={`${label}位置`}>
          <button type="button" onClick={() => onNavigate(ROOT)} aria-current={current === ROOT ? 'page' : undefined}>{rootLabel}</button>
          {trail.map(f => <React.Fragment key={f.id}><ChevronRight size={14} aria-hidden="true"/><button type="button" onClick={() => onNavigate(f.id)} aria-current={current === f.id ? 'page' : undefined}>{f.name}</button></React.Fragment>)}
        </nav>
        {toolbar && <div className="sgf-toolbar">{toolbar}</div>}
      </header>
      {notice}
      {children.length > 0 && <div className="sgf-subfolders" aria-label="子文件夹">
        {children.map(f => <button key={f.id} type="button" className="sgf-folder-card" onClick={() => onNavigate(f.id)} aria-label={`打开文件夹：${f.name}`}>
          <Folder size={22} strokeWidth={1.6} aria-hidden="true"/><span className="sgf-folder-name">{f.name}</span><small>{count(f.count)}</small>
        </button>)}
      </div>}
      {!items.length ? (!children.length && <p className="sgf-empty">{loading ? '正在读取…' : emptyText}</p>)
        : layout === 'rows'
          ? <div className="sgf-rows" role="list">{items.map(it => <div key={it.id} role="listitem" className={`sgf-row${it.current ? ' is-current' : ''}${selected?.has(it.id) ? ' is-selected' : ''}`}>
            {onToggleSelect && <input type="checkbox" className="sgf-check" aria-label={`选择 ${it.name}`} disabled={it.selectable === false} checked={!!selected?.has(it.id)} onChange={() => onToggleSelect(it.id)}/>}
            {it.leading}
            <span className="sgf-row-text"><strong title={it.name}>{it.name}</strong>{it.meta && <small>{it.meta}</small>}</span>
            <span className="sgf-row-visual">{it.visual}</span>
            {it.badges && <span className="sgf-badges">{it.badges}</span>}
            {it.actions && <span className="sgf-actions">{it.actions}</span>}
            {it.details && <div className="sgf-row-details">{it.details}</div>}
          </div>)}</div>
          : <div className="sgf-grid" role="list">{items.map(it => <article key={it.id} role="listitem" className={`sgf-card${it.current ? ' is-current' : ''}${selected?.has(it.id) ? ' is-selected' : ''}`}>
            <div className="sgf-card-visual">{it.visual}{onToggleSelect && <input type="checkbox" className="sgf-check" aria-label={`选择 ${it.name}`} disabled={it.selectable === false} checked={!!selected?.has(it.id)} onChange={() => onToggleSelect(it.id)}/>}</div>
            <strong title={it.name}>{it.name}</strong>{it.meta && <small>{it.meta}</small>}
            {it.badges && <span className="sgf-badges">{it.badges}</span>}
            {it.actions && <span className="sgf-actions">{it.actions}</span>}
            {it.details && <div className="sgf-row-details">{it.details}</div>}
          </article>)}</div>}
    </section>
  </div>;
}
