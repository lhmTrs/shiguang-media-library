// 分镜表镜头行的右键菜单（在上方插入 / 在下方插入 等）。键盘：上下键移动，Esc/Tab 关闭。
import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export type ShotMenuItem = { key: string; label: string; icon?: React.ReactNode; onSelect: () => void; disabled?: boolean; hint?: string };
export type ShotMenuTarget = { x: number; y: number; title: string; returnFocus?: HTMLElement | null };

export function ShotMenu({ target, items, close }: { target: ShotMenuTarget; items: ShotMenuItem[]; close: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const done = () => { close(); target.returnFocus?.focus(); };
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) close(); };
    const resize = () => close();
    document.addEventListener('mousedown', away, true);
    window.addEventListener('resize', resize);
    return () => { document.removeEventListener('mousedown', away, true); window.removeEventListener('resize', resize); };
  }, [close]);
  const keys = (e: React.KeyboardEvent) => {
    const list = [...(box.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); done(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
  };
  const left = Math.max(8, Math.min(target.x, window.innerWidth - 248)), top = Math.max(8, Math.min(target.y, window.innerHeight - 40 - items.length * 36));
  return createPortal(<div ref={box} className="sb-shot-menu" role="menu" aria-label={target.title} style={{ left, top }} onKeyDown={keys} onContextMenu={e => e.preventDefault()}>
    {items.map(item => <React.Fragment key={item.key}>
      <button type="button" role="menuitem" disabled={item.disabled} title={item.hint} onClick={() => { done(); item.onSelect(); }}>{item.icon}{item.label}</button>
      {item.disabled && item.hint && <small>{item.hint}</small>}
    </React.Fragment>)}
  </div>, document.body);
}
