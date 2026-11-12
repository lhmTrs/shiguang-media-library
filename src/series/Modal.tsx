import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

/** 剧集目录里的小对话框外壳：打开时把焦点放进去，Esc 关闭（忙时不关），关闭后焦点回到原处。 */
export function Modal({ label, children, close, busy }: { label: string; children: ReactNode; close: () => void; busy: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; root.current?.querySelector<HTMLElement>('input,select,button')?.focus(); return () => previous?.focus(); }, []);
  return <div className="modal-backdrop"><div className="modal pf-modal" ref={root} role="dialog" aria-modal="true" aria-label={label} onKeyDown={e => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); close(); } }}>
    <div className="modal-head"><h2>{label}</h2><button className="icon-button" type="button" aria-label={'关闭' + label} disabled={busy} onClick={close}><X size={18}/></button></div>
    {children}
  </div></div>;
}
