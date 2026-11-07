import React, {useEffect, useRef} from 'react';
import {createPortal} from 'react-dom';
import {X} from 'lucide-react';
import {ReferencePreview} from './ReferenceImageImport';

export function ReferenceImageViewer({src, name, onClose}: {src: string; name: string; onClose: () => void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current!;
    const opener = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    node.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      node.close();
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus({preventScroll: true});
    };
  }, []);
  return createPortal(<dialog ref={dialog} className="ca-image-viewer" aria-label="参考图片大图预览"
    onCancel={event => {event.preventDefault(); onClose();}}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
    }}>
    <header><strong title={name}>{name}</strong><button type="button" autoFocus aria-label="关闭大图预览" onClick={onClose}><X size={22}/></button></header>
    <div className="ca-image-viewer-content"><ReferencePreview src={src} alt={name}/></div>
    <footer>按 Esc 或点击图片外侧关闭</footer>
  </dialog>, document.body);
}
