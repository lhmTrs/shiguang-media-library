import React, { useEffect, useRef } from "react";
import { X, RotateCcw } from "lucide-react";

export function NavigationSettings({ items, hidden, toggle, reset, close }: {
  items: [string, string][];
  hidden: string[];
  toggle: (id: string) => void;
  reset: () => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.querySelector<HTMLButtonElement>("button")?.focus();
    function keydown(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      if (e.key !== "Tab") return;
      const controls = [...element.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')];
      const first = controls[0], last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [close]);
  return <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) close(); }}>
    <div ref={dialog} className="modal navigation-settings" role="dialog" aria-modal="true" aria-labelledby="navigation-settings-title">
      <div className="modal-head"><h2 id="navigation-settings-title">导航栏目</h2><button className="icon-button" title="关闭导航设置" aria-label="关闭导航设置" onClick={close}><X size={18}/></button></div>
      <div className="navigation-options">{items.map(([id, label]) => <label key={id}>
        <input type="checkbox" checked={!hidden.includes(id)} disabled={id === "all"} onChange={() => toggle(id)}/>
        <span>{label}</span>{id === "all" && <small>始终显示</small>}
      </label>)}</div>
      <div className="navigation-settings-footer"><button className="plain" onClick={reset}><RotateCcw size={15}/>恢复全部</button><button className="primary" onClick={close}>完成</button></div>
    </div>
  </div>;
}
