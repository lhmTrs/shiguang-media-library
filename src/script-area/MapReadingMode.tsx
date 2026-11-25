// 泳道图「阅读模式」：照分镜的阅读模式（src/storyboard/ReadingMode.tsx）做。盖满浏览器窗口（不调系统全屏），
// 顶部一条细栏：退出、图的标题、依据、「Esc 退出」。图按窗口宽度缩放、上下滚动，点框照样弹原文小卡片。
// 打开时焦点交给「退出阅读」，退出后回到原处。小卡片开着时 Esc 先关卡片，再按一次才退出。
import React, { useEffect, useRef } from 'react';
import { ArrowLeft } from 'lucide-react';
import { CausalMap, mapHeading } from './CausalMap';
import type { RenderData } from './types';

export function MapReadingMode({ data, onClose }: { data: RenderData; onClose: () => void }) {
  const exit = useRef<HTMLButtonElement>(null), body = useRef<HTMLDivElement>(null);
  const { title, basis } = mapHeading(data);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null; exit.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (body.current?.querySelector('.sm-pop')) return; // 让图自己先把小卡片关掉
      e.preventDefault(); e.stopPropagation(); onClose();
    };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); if (before && document.contains(before)) before.focus(); };
  }, [onClose]);
  return <div className="sa-reading" role="dialog" aria-modal="true" aria-label="泳道图阅读模式">
    <div className="sa-reading-bar">
      <button ref={exit} type="button" onClick={onClose}><ArrowLeft size={15}/>退出阅读</button>
      <strong className="sa-reading-title">{title}</strong>
      {basis && <span className="sa-reading-muted">{basis}</span>}
      <span className="sa-reading-spacer"/>
      <span className="sa-reading-muted">Esc 退出</span>
    </div>
    <div className="sa-reading-body" ref={body}><CausalMap data={data} fit={2} bare/></div>
  </div>;
}
