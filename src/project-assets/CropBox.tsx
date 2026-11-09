import React, { useEffect, useRef, useState } from 'react';

export type Crop = { x: number; y: number; zoom: number };
type Rect = { left: number; top: number; w: number; h: number; base: number };
type Handle = 'nw' | 'ne' | 'sw' | 'se';
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/*
 * 裁切数据与框的换算（图片像素坐标）。
 * 显示时（CroppedImage）图片按容器比例 aspect 铺满后放大 zoom 倍，x / y 是剩余空间里的位置百分比。
 * 等价于：在原图上取一个比例为 aspect 的框，
 *   最大框宽 base = min(图宽, 图高 × aspect)，框宽 = base / zoom，
 *   框左 = (图宽 − 框宽) × x%，框顶 = (图高 − 框高) × y%。
 * 数据格式不变，服务器仍校验 zoom 1–3、x / y 0–100。
 */
export function cropRect(iw: number, ih: number, aspect: number, c: Crop): Rect {
  const base = Math.min(iw, ih * aspect), w = base / c.zoom, h = w / aspect;
  return { left: (iw - w) * c.x / 100, top: (ih - h) * c.y / 100, w, h, base };
}
function toCrop(iw: number, ih: number, aspect: number, left: number, top: number, width: number, prev: Crop): Crop {
  const base = Math.min(iw, ih * aspect), zoom = clamp(base / width, 1, 3), w = base / zoom, h = w / aspect;
  const sx = iw - w, sy = ih - h, l = clamp(left, 0, Math.max(0, sx)), t = clamp(top, 0, Math.max(0, sy));
  return {
    zoom: Math.round(zoom * 100) / 100,
    x: sx > 0.5 ? Math.round(l / sx * 1000) / 10 : prev.x,
    y: sy > 0.5 ? Math.round(t / sy * 1000) / 10 : prev.y,
  };
}

export function CropBox({ src, alt, crop, aspect, disabled, onChange }: { src: string; alt: string; crop: Crop; aspect: number; disabled?: boolean; onChange: (c: Crop) => void }) {
  const host = useRef<HTMLDivElement>(null), drag = useRef<{ mode: 'move' | Handle; px: number; py: number; rect: Rect } | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null), [size, setSize] = useState({ w: 0, h: 0 }), [failed, setFailed] = useState(false), [dragging, setDragging] = useState(false);
  useEffect(() => { const el = host.current; if (!el) return; const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height })); ro.observe(el); return () => ro.disconnect(); }, []);
  useEffect(() => { setNatural(null); setFailed(false); }, [src]);
  const scale = natural && size.w && size.h ? Math.min(size.w / natural.w, size.h / natural.h) : 0;
  const r = natural ? cropRect(natural.w, natural.h, aspect, crop) : null;
  function down(e: React.PointerEvent, mode: 'move' | Handle) {
    if (disabled || !r || !scale) return;
    e.preventDefault(); e.stopPropagation(); (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = { mode, px: e.clientX, py: e.clientY, rect: r }; setDragging(true);
  }
  function move(e: React.PointerEvent) {
    const d = drag.current; if (!d || !natural) return;
    const { w: iw, h: ih } = natural, dx = (e.clientX - d.px) / scale, dy = (e.clientY - d.py) / scale, s = d.rect;
    if (d.mode === 'move') { onChange(toCrop(iw, ih, aspect, s.left + dx, s.top + dy, s.w, crop)); return; }
    // 拖角缩放：对角固定，比例锁定
    const east = d.mode.includes('e'), south = d.mode.includes('s');
    const ax = east ? s.left : s.left + s.w, ay = south ? s.top : s.top + s.h;
    const px = (east ? s.left + s.w : s.left) + dx, py = (south ? s.top + s.h : s.top) + dy;
    const room = Math.min(s.base, east ? iw - ax : ax, (south ? ih - ay : ay) * aspect);
    const want = Math.max(east ? px - ax : ax - px, (south ? py - ay : ay - py) * aspect); // 越过对角时取最小框
    const w = Math.max(s.base / 3, Math.min(room, want));
    onChange(toCrop(iw, ih, aspect, east ? ax : ax - w, south ? ay : ay - w / aspect, w, crop));
  }
  function up() { drag.current = null; setDragging(false); }
  function key(e: React.KeyboardEvent) {
    if (disabled) return;
    const step = e.shiftKey ? 10 : 2, moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) { e.preventDefault(); onChange({ ...crop, x: clamp(crop.x + moves[e.key][0], 0, 100), y: clamp(crop.y + moves[e.key][1], 0, 100) }); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); onChange({ ...crop, zoom: clamp(Math.round((crop.zoom + .1) * 100) / 100, 1, 3) }); }
    else if (e.key === '-') { e.preventDefault(); onChange({ ...crop, zoom: clamp(Math.round((crop.zoom - .1) * 100) / 100, 1, 3) }); }
  }
  return <div className="ca-cropper" ref={host}>
    {failed ? <span className="ca-preview-unavailable">此格式暂不能预览<br/>可在访达中打开原图</span>
      : <div className={'ca-cropper-stage' + (dragging ? ' is-dragging' : '')} style={natural && scale ? { width: natural.w * scale, height: natural.h * scale } : undefined}>
        <img src={src} alt={alt} draggable={false} className={natural ? '' : 'is-loading'} onLoad={e => setNatural({ w: e.currentTarget.naturalWidth || 1, h: e.currentTarget.naturalHeight || 1 })} onError={() => setFailed(true)}/>
        {r && natural && <div className={'ca-crop-box' + (disabled ? ' is-disabled' : '')} role="group" tabIndex={disabled ? -1 : 0}
          aria-label={disabled ? '裁切框（只读）' : '裁切框：拖动移动，拖四角缩放；方向键移动，加号和减号缩放'}
          style={{ left: r.left / natural.w * 100 + '%', top: r.top / natural.h * 100 + '%', width: r.w / natural.w * 100 + '%', height: r.h / natural.h * 100 + '%' }}
          onPointerDown={e => down(e, 'move')} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key}>
          <i className="ca-crop-thirds" aria-hidden="true"/>
          {!disabled && (['nw', 'ne', 'sw', 'se'] as Handle[]).map(m => <span key={m} className={'ca-crop-handle ' + m} data-handle={m} aria-hidden="true" onPointerDown={e => down(e, m)} onPointerMove={move} onPointerUp={up} onPointerCancel={up}/>)}
        </div>}
      </div>}
  </div>;
}
