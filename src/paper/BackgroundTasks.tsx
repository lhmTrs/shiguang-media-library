// 顶栏 ③ 合并分区里的「后台任务」入口（只在「新样子（试用）」打开时出现）。
// 视频任务、Codex 任务、文件任务三个原有入口原样放进这个弹出框：它们一直挂着（面板状态、轮询、提醒都在各自组件里），
// 弹出框收起时只是看不见。点其中一个，打开的还是原来的面板；面板一打开，这个弹出框就让开。
import React, {useEffect, useRef, useState} from 'react';
import {ChevronDown} from 'lucide-react';

export type TaskSummary = {active: number; attention: number; shown?: boolean};

export function BackgroundTasks({active, attention, busyLabel, children, footer}: {
  /** 正在跑的任务数（三类任务加上正在进行的文件检查）。 */
  active: number;
  /** 需要看一眼的数（失败、待处理、新结果）。 */
  attention: number;
  /** 文件检查等进行中的说明，出现在入口上。 */
  busyLabel?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);

  // 原有入口的 aria-expanded 变成 true：它的面板打开了，弹出框收起让位。
  // 变回 false 而焦点落空（入口藏在收起的弹出框里，原组件把焦点还给它会失败）：把焦点交给「后台任务」按钮。
  useEffect(() => {
    const box = menu.current;
    if (!box) return;
    const observer = new MutationObserver(records => {
      for (const r of records) {
        const el = r.target as HTMLElement;
        if (r.attributeName !== 'aria-expanded' || !el.matches('button[aria-controls]')) continue;
        if (el.getAttribute('aria-expanded') === 'true') setOpen(false);
        else setTimeout(() => { const a = document.activeElement; if (!a || a === document.body || box.contains(a)) button.current?.focus(); }, 0);
      }
    });
    observer.observe(box, {subtree: true, attributes: true, attributeFilter: ['aria-expanded']});
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || !root.current?.contains(document.activeElement)) return;
      e.preventDefault(); setOpen(false); button.current?.focus();
    };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [open]);
  useEffect(() => { if (open) menu.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus(); }, [open]);

  const state = attention ? 'attention' : active || busyLabel ? 'active' : 'idle';
  const status = busyLabel ?? (active ? `${active} 个在跑` : '');
  return <div ref={root} className="sgp-tasks">
    <button ref={button} type="button" className="sgp-pill sgp-tasks-button" data-state={state}
      aria-expanded={open} aria-controls="sgp-tasks-menu" onClick={() => setOpen(v => !v)}>
      <span className="sgp-dot" aria-hidden="true"/>
      <span>后台任务{status && <span className="sgp-tasks-status"> · {status}</span>}</span>
      {attention > 0 && <span className="sgp-tasks-attention" aria-label={`${attention} 项要看`}>{attention}</span>}
      <ChevronDown size={13} aria-hidden="true"/>
    </button>
    <div ref={menu} id="sgp-tasks-menu" className="sgp-tasks-menu" role="group" aria-label="后台任务" hidden={!open}>
      <div className="sgp-tasks-entries">{children}</div>
      {footer && <div className="sgp-tasks-footer">{footer}</div>}
    </div>
  </div>;
}
