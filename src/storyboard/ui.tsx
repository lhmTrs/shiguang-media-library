import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

export function download(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
type FieldProps = { label: string; value: unknown; onCommit: (value: string) => void; multiline?: boolean; rows?: number; inline?: boolean; type?: string; testid?: string; placeholder?: string };
export function Field({ label, value, onCommit, multiline = false, rows = 3, inline = false, type = 'text', testid, placeholder = '待补充' }: FieldProps) {
  const [draft, setDraft] = useState(String(value ?? ''));
  const cancelled = useRef(false);
  useEffect(() => setDraft(String(value ?? '')), [value]);
  const props = {
    value: draft, 'aria-label': label, 'data-testid': testid, placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: () => { if (cancelled.current) { cancelled.current = false; return; } if (draft !== String(value ?? '')) onCommit(draft); },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === 'Escape') { e.stopPropagation(); cancelled.current = true; setDraft(String(value ?? '')); e.currentTarget.blur(); }
      if (!multiline && e.key === 'Enter') e.currentTarget.blur();
    },
  };
  return <label className={'sb-field' + (inline ? ' sb-inline' : '')}>{!inline && <span>{label}</span>}{multiline ? <textarea {...props} rows={rows}/> : <input {...props} type={type}/>}</label>;
}
export function Modal({ title, children, onClose, wide = false,disabled=false }: { disabled?:boolean;title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  const panel = useRef<HTMLElement>(null), close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current(); }
      if (e.key !== 'Tab') return;
      const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea, select, a[href], summary') ?? [])].filter(el => el.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    panel.current?.addEventListener('keydown', handler);
    const element = panel.current;
    return () => { element?.removeEventListener('keydown', handler); previous?.focus(); };
  }, []);
  return <div className="sb-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section ref={panel} className={'sb-modal' + (wide ? ' sb-wide' : '')} role="dialog" aria-modal="true" aria-label={title}><header><div><small>分镜设计</small><h2>{title}</h2></div><button aria-label="关闭面板" onClick={onClose}><X size={18}/></button></header><div className="sb-modal-body"><fieldset className="sb-modal-editing" disabled={disabled}>{children}</fieldset></div></section></div>;
}
