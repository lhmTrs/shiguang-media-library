// 素材使用页的右键菜单：右侧「此刻 / 接下来」条目和下方轨道片段共用。
// 只有两项：复制文件名、在访达中显示（没对上素材库的引用不知道文件在哪，置灰并写原因）。
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Copy, FolderSearch } from "lucide-react";
import type { ProjectRequest } from "../ProjectManager";
import { notifyFeedback } from "../global-feedback";

export type MenuTarget = { x: number; y: number; name: string; assetId: string | null; returnFocus?: HTMLElement | null };

const NO_ASSET = "这条没对上素材库，不知道文件在哪";

export function UsageMenu({ target, request, close }: { target: MenuTarget; request: ProjectRequest; close: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const done = () => { close(); target.returnFocus?.focus(); };
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) close(); };
    const scroll = () => close();
    document.addEventListener("mousedown", away, true);
    window.addEventListener("resize", scroll);
    return () => { document.removeEventListener("mousedown", away, true); window.removeEventListener("resize", scroll); };
  }, [close]);

  async function copy() {
    done();
    try { await navigator.clipboard.writeText(target.name); notifyFeedback({ message: `已复制「${target.name}」`, kind: "success", source: "素材使用" }); }
    catch { notifyFeedback({ message: "没能写入剪贴板，请稍后再试", kind: "error", source: "素材使用" }); }
  }
  async function reveal() {
    if (!target.assetId) return;
    done();
    try { await request(`/assets/${target.assetId}/reveal`, {}); }
    catch (e) { notifyFeedback({ message: (e as Error).message || "没能在访达中显示", kind: "error", source: "素材使用" }); }
  }
  const keys = (e: React.KeyboardEvent) => {
    const items = [...(box.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); done(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  };
  const left = Math.max(8, Math.min(target.x, window.innerWidth - 248)), top = Math.max(8, Math.min(target.y, window.innerHeight - 120));
  return createPortal(<div ref={box} className="usage-menu" role="menu" aria-label={`操作：${target.name}`} style={{ left, top }} onKeyDown={keys} onContextMenu={e => e.preventDefault()}>
    <button type="button" role="menuitem" onClick={() => void copy()}><Copy size={14} aria-hidden="true" />复制文件名</button>
    <button type="button" role="menuitem" disabled={!target.assetId} title={target.assetId ? undefined : NO_ASSET} onClick={() => void reveal()}><FolderSearch size={14} aria-hidden="true" />在访达中显示</button>
    {!target.assetId && <small>{NO_ASSET}</small>}
  </div>, document.body);
}
