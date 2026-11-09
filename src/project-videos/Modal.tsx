import React, {useEffect, useId, useRef} from 'react';
import {X} from 'lucide-react';

export function ModalActions({children}: {children: React.ReactNode}) {
  return <div className="pv-dialog-actions" role="group" aria-label="弹窗操作">{children}</div>;
}

export function Modal({ title, locked, onClose, children, className = '' }: {
  title: string; locked: boolean; onClose: () => void; children: React.ReactNode; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const heading = useId();
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const lockRef = useRef(locked); lockRef.current = locked;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (!lockRef.current) closeRef.current();
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(ref.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), video[controls], [tabindex="0"]',
      ) || []).filter(el => !el.hidden && el.getClientRects().length > 0);
      const first = controls[0]; const last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); ref.current?.focus(); }
      else if (!ref.current?.contains(document.activeElement)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) {
        event.preventDefault(); first.focus();
      }
    };
    const focusin = (event: FocusEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) ref.current?.focus();
    };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', focusin);
    return () => { document.removeEventListener('keydown', keydown, true); document.removeEventListener('focusin', focusin); previous?.focus(); };
  }, []);
  useEffect(() => {
    const focused = document.activeElement;
    if (!ref.current?.contains(focused) || focused?.matches(':disabled')) ref.current?.focus();
  }, [locked, title]);
  return <div className="pv-modal-backdrop">
    <div className={'pv-modal' + (className ? ' ' + className : '')} ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={heading} aria-busy={locked}>
      <header><h2 id={heading}>{title}</h2><button type="button" aria-label="关闭" disabled={locked} onClick={onClose}><X size={18}/></button></header>
      <div className="pv-modal-content">{children}</div>
    </div>
  </div>;
}

