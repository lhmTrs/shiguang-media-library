import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ExternalLink, FolderPlus, FolderInput, Trash2, Tag, FilePenLine, ListPlus, Star, MoreHorizontal } from "lucide-react";
import type { Asset } from "./main";

export function AssetActions({ asset, busy, canTrash, reveal, trash, tags, category, extraCategory, move, favorite, project, inProject = false, grid = false, compact = false }: {
  asset: Asset; busy: boolean; canTrash: boolean; grid?: boolean;
  reveal: () => void; trash: () => void; tags: () => void;
  category?: () => void; extraCategory?: () => void; move?: () => void; favorite: () => void;
  compact?: boolean;
  project?: () => void; inProject?: boolean;
}) {
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (e: PointerEvent) => { if (!panel.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setMenu(null); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setMenu(null); trigger.current?.focus(); } };
    const scroll = (e: Event) => { if (!panel.current?.contains(e.target as Node)) setMenu(null); };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    window.addEventListener("scroll", scroll, true); window.addEventListener("resize", scroll);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); window.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", scroll); };
  }, [!!menu]);
  if (compact) return <div className={"asset-quick-actions" + (grid ? " asset-card-actions" : "")} onClick={e => e.stopPropagation()}>
    <button className="icon-button" title="在访达中显示" aria-label={"定位素材：" + asset.name} disabled={busy} onClick={reveal}><ExternalLink size={16}/></button>
    <button className={"icon-button favorite " + (asset.favorite ? "saved" : "")} title={asset.favorite ? "取消收藏" : "收藏"} aria-label={asset.favorite ? "取消收藏" : "收藏"} disabled={busy} onClick={favorite}><Star size={16} fill={asset.favorite ? "currentColor" : "none"}/></button>
    <button ref={trigger} className="icon-button" title="更多素材操作" aria-label={"更多素材操作：" + asset.name} aria-haspopup="menu" aria-expanded={!!menu} disabled={busy} onClick={() => { const r = trigger.current!.getBoundingClientRect(); setMenu(menu ? null : { left: Math.max(8, Math.min(r.right - 180, innerWidth - 188)), top: Math.max(8, Math.min(r.bottom + 4, innerHeight - (project ? 276 : 236))) }); }}><MoreHorizontal size={18}/></button>
    {menu && createPortal(<div ref={panel} className="asset-action-menu" role="menu" aria-label={"素材操作：" + asset.name} style={menu} onClick={e => { e.stopPropagation(); trigger.current?.focus(); setMenu(null); }} onKeyDown={e => {
      if (["ArrowDown", "ArrowUp"].includes(e.key)) { e.preventDefault(); e.stopPropagation(); const nodes = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || []), index = nodes.indexOf(document.activeElement as HTMLButtonElement); nodes[(index + (e.key === "ArrowDown" ? 1 : -1) + nodes.length) % nodes.length]?.focus(); }
    }}>
      {project && <button role="menuitem" aria-label={"加入当前项目：" + asset.name} disabled={inProject} onClick={project}>{inProject ? <Check size={16}/> : <FolderPlus size={16}/>}{inProject ? "已加入当前项目" : "加入当前项目"}</button>}
      <button role="menuitem" aria-label={"添加素材标签：" + asset.name} onClick={tags}><Tag size={16}/>添加标签</button>
      {move && <button role="menuitem" aria-label={"移动素材：" + asset.name} disabled={!asset.online} onClick={move}><FolderInput size={16}/>移动到文件夹</button>}
      {category && <button role="menuitem" aria-label={"修改分类：" + asset.name} onClick={category}><FilePenLine size={16}/>设置分类</button>}
      {extraCategory && <button role="menuitem" aria-label={"添加素材分类：" + asset.name} onClick={extraCategory}><ListPlus size={16}/>添加到其他分类</button>}
      <button role="menuitem" aria-label={"删除素材：" + asset.name} disabled={!asset.online || !canTrash} onClick={trash}><Trash2 size={16}/>移入废纸篓</button>
    </div>, document.body)}
  </div>;
  return <div className={"asset-quick-actions" + (grid ? " asset-card-actions" : "")} onClick={e => e.stopPropagation()}>
    <button className="icon-button" title="在访达中显示" aria-label={"定位素材：" + asset.name} disabled={busy} onClick={reveal}><ExternalLink size={16}/></button>
    {project && <button className="icon-button" title={inProject ? "已加入当前项目" : "加入当前项目"} aria-label={"加入当前项目：" + asset.name} disabled={busy || inProject} onClick={project}>{inProject ? <Check size={16}/> : <FolderPlus size={16}/>}</button>}
    <button className="icon-button" title="添加标签" aria-label={"添加素材标签：" + asset.name} disabled={busy} onClick={tags}><Tag size={16}/></button>
    {move && <button className="icon-button" title="移动到文件夹" aria-label={"移动素材：" + asset.name} disabled={busy || !asset.online} onClick={move}><FolderInput size={16}/></button>}
    {category && <button className="icon-button" title="设置分类" aria-label={"修改分类：" + asset.name} disabled={busy} onClick={category}><FilePenLine size={16}/></button>}
    {extraCategory && <button className="icon-button" title="添加到其他分类" aria-label={"添加素材分类：" + asset.name} disabled={busy} onClick={extraCategory}><ListPlus size={16}/></button>}
    <button className={"icon-button favorite " + (asset.favorite ? "saved" : "")} title={asset.favorite ? "取消收藏" : "收藏"} aria-label={asset.favorite ? "取消收藏" : "收藏"} disabled={busy} onClick={favorite}><Star size={16} fill={asset.favorite ? "currentColor" : "none"}/></button>
    <button className="icon-button" title="删除素材（移入废纸篓）" aria-label={"删除素材：" + asset.name} disabled={busy || !asset.online || !canTrash} onClick={trash}><Trash2 size={16}/></button>
  </div>;
}
