import React, { useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";

export function ToolbarPopover({ label, icon: Icon, children }: {
  label: string;
  icon: LucideIcon;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return <div className="toolbar-popover" ref={root} onBlur={() => {
    // WebKit may omit relatedTarget during checkbox/button focus changes.
    requestAnimationFrame(() => { if (root.current && !root.current.contains(document.activeElement)) setOpen(false); });
  }} onKeyDown={e => {
    if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); close(); trigger.current?.focus(); }
  }}>
    <button ref={trigger} className="icon-button" title={label} aria-label={label} aria-expanded={open} onClick={() => { trigger.current?.focus(); setOpen(v => !v); }}><Icon size={18}/></button>
    {open && <div className="toolbar-popover-panel" role="group" aria-label={label}>{children(close)}</div>}
  </div>;
}
