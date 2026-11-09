import React, {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {AlertCircle, X} from 'lucide-react';
import {bindPlaybackSpace} from './playback-shortcuts';
import {useFeedbackToast} from './global-feedback';
import './media-viewer.css';

export type MediaView = {key: string; name: string; kind: 'photo' | 'video'; src: string; poster?: string | null; reason?: string; compatibilitySrc?: string};
type VisualAsset = {id: string; name: string; kind: string; mtime: number; size?: number; online: number; file_status?: string; trashed?: number};
const unavailable: Record<string, string> = {
  offline: '素材目录已离线，请返回素材详情检查目录或重新定位。',
  missing: '原文件缺失，请返回素材详情尝试修复或重新定位。',
  changed: '原文件内容已变更，不能用当前文件替代原记录。请返回原位置核对或重新定位。',
  unavailable: '当前无法访问原文件，请检查目录和访问权限。',
  untrusted: '文件身份尚未核验，请返回原位置重新定位或确认来源。',
  unsupported: '浏览器不支持此视频格式，请返回原位置查看格式信息或兼容预览入口。',
};

export function assetMediaView(asset: VisualAsset, reason?: string): MediaView {
  return {key: [asset.id, asset.mtime, asset.size, asset.online, asset.file_status, asset.trashed].join(':'),
    name: asset.name, kind: asset.kind === 'photo' ? 'photo' : 'video',
    src: `/api/media/${encodeURIComponent(asset.id)}/original?v=${encodeURIComponent(String(asset.mtime))}`,
    compatibilitySrc: asset.kind === 'photo' ? `/api/media/${encodeURIComponent(asset.id)}/thumb?v=${encodeURIComponent(String(asset.mtime))}` : undefined,
    reason: reason || (asset.trashed ? '此素材已移入废纸篓，请先返回原位置核对。' : unavailable[asset.file_status || ''] || (!asset.online ? unavailable.offline : undefined))};
}

/** Card/row shortcuts must never consume editing, selection, dragging or native controls. */
export function mediaDoubleClick(event: React.MouseEvent<HTMLElement>) {
  return event.target instanceof Element && !event.target.closest('button,input,textarea,select,a,video,audio,[contenteditable="true"],[draggable="true"],[role="slider"]');
}

function protectedURL(value: string) {
  try { const url = new URL(value, location.origin); return url.origin === location.origin && url.pathname.startsWith('/api/') ? url.href : ''; }
  catch { return ''; }
}

function MediaContent({target, onPlay, compatibility, onCompatibility, initialTime, onPosition}: {target: MediaView; onPlay?: () => void; compatibility: boolean; onCompatibility?: () => void; initialTime?: number; onPosition?: (seconds: number) => void}) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [playbackNotice, setPlaybackNotice] = useState('');
  const video = useRef<HTMLVideoElement>(null), live = useRef(true);
  const positionCallback = useRef(onPosition); positionCallback.current = onPosition;
  const metadataReady = useRef(false), playAfterMetadata = useRef<() => void>();
  const reportPosition = (element = video.current) => { if (metadataReady.current && element && Number.isFinite(element.currentTime)) positionCallback.current?.(element.currentTime); };
  const restorePosition = () => {
    const element = video.current; if (!element || metadataReady.current) return;
    if (initialTime !== undefined && Number.isFinite(initialTime) && initialTime >= 0) {
      const end = Number.isFinite(element.duration) ? Math.max(0, element.duration - .001) : initialTime;
      try { element.currentTime = Math.min(initialTime, end); } catch { /* Retain native playback if a browser refuses seeking. */ }
    }
    metadataReady.current = true;
  };
  const src = protectedURL(target.src), poster = target.poster ? protectedURL(target.poster) : '';
  const reason = target.reason || (!src ? '没有可用的受保护预览地址，请返回原位置刷新资料。' : '');
  useFeedbackToast(reason || (phase === 'failed' ? (target.kind === 'photo' ? '图片无法显示' : '视频无法播放') + '，请核对文件是否可用，以及浏览器是否支持此格式。' : ''), {source: '素材预览'});
  useEffect(() => {
    live.current = true;
    const element = video.current;
    let intent = 0, frame = 0;
    const requestPlay = () => {
      if (!element || element.error || document.hidden || initialTime !== undefined && !metadataReady.current) return;
      const ticket = ++intent;
      setPlaybackNotice('');
      void element.play().catch((error: DOMException) => {
        if (live.current && ticket === intent && !element.error && error.name !== 'AbortError')
          setPlaybackNotice('浏览器未能自动播放，请点击播放或按空格继续。');
      });
    };
    playAfterMetadata.current = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { if (node?.open) requestPlay(); }); };
    const pause = () => { ++intent; element?.pause(); };
    const node = element?.closest('dialog');
    const unbind = node ? bindPlaybackSpace(node, () => {
      if (element!.paused) requestPlay(); else { pause(); setPlaybackNotice(''); }
    }, () => node.open && !document.hidden && !element?.error) : undefined;
    const hidden = () => { if (document.hidden) { cancelAnimationFrame(frame); pause(); } };
    if (element && !reason) {
      if (initialTime !== undefined && element.readyState >= 1) restorePosition();
      playAfterMetadata.current();
      document.addEventListener('visibilitychange', hidden);
    }
    return () => {
      live.current = false;
      cancelAnimationFrame(frame); unbind?.(); document.removeEventListener('visibilitychange', hidden); ++intent;
      if (element) { reportPosition(element); element.pause(); element.removeAttribute('src'); element.load(); }
    };
  }, []);
  const update = (next: typeof phase) => { if (live.current) setPhase(current => current === 'failed' ? current : next); };
  return <div className="media-viewer-stage" aria-busy={!reason && phase === 'loading'}>
    {reason ? <div className="media-viewer-message" role="alert"><AlertCircle size={28}/><p>{reason}</p></div>
      : phase === 'failed' ? <div className="media-viewer-message" role="alert"><AlertCircle size={28}/><p>{compatibility ? '兼容预览仍无法显示' : target.kind === 'photo' ? '原图无法显示' : '原视频无法播放'}：文件可能离线、缺失、已变更，或浏览器不支持此格式。请返回原位置核对文件或使用原有修复入口。</p>
        {onCompatibility && <button type="button" onClick={onCompatibility}>查看兼容预览（缩略图）</button>}</div>
      : <>
        {playbackNotice ? <p className="media-viewer-loading" role="status">{playbackNotice}</p> : phase === 'loading' && <p className="media-viewer-loading" role="status">正在读取{compatibility ? '兼容预览' : target.kind === 'photo' ? '原图' : '原视频'}…</p>}
        {target.kind === 'photo'
          ? <img src={src} alt={target.name} draggable={false} onLoad={() => update('ready')} onError={() => update('failed')}/>
          : <video ref={video} src={src} poster={poster || undefined} controls playsInline preload="metadata" aria-label={'原视频：' + target.name}
            onLoadedMetadata={() => { restorePosition(); update('ready'); if (initialTime !== undefined) playAfterMetadata.current?.(); }} onTimeUpdate={() => reportPosition()} onSeeked={() => reportPosition()} onError={() => { video.current?.pause(); update('failed'); }} onPlay={() => { setPlaybackNotice(''); onPlay?.(); }}/>} 
      </>}
  </div>;
}

function ViewerContent({target, onPlay, initialTime, onPosition}: {target: MediaView; onPlay?: () => void; initialTime?: number; onPosition?: (seconds: number) => void}) {
  const [compatibility, setCompatibility] = useState(false);
  const retry = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (compatibility) retry.current?.focus({preventScroll: true}); }, [compatibility]);
  return <>
    {compatibility && <div className="media-viewer-compatibility" role="status"><span>兼容预览（缩略图），不是原图。</span><button type="button" ref={retry} onClick={() => setCompatibility(false)}>重试原图</button></div>}
    <MediaContent key={compatibility ? 'compatibility' : 'original'} target={compatibility ? {...target, src: target.compatibilitySrc!} : target}
      compatibility={compatibility} onPlay={onPlay} initialTime={initialTime} onPosition={onPosition}
      onCompatibility={!compatibility && target.kind === 'photo' && protectedURL(target.compatibilitySrc || '') ? () => setCompatibility(true) : undefined}/>
  </>;
}

export function MediaViewer({target, onClose, onPlay, label = '原图或视频预览', onRepair, repairLabel = '返回原位置核对', initialTime, onPosition}: {
  target: MediaView; onClose: () => void; onPlay?: () => void; label?: string; onRepair?: () => void; repairLabel?: string; initialTime?: number; onPosition?: (seconds: number) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), backdropDown = useRef(false);
  useEffect(() => {
    const node = dialog.current!, opener = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow, scrollX = window.scrollX, scrollY = window.scrollY;
    node.showModal(); document.body.style.overflow = 'hidden';
    return () => {
      node.close(); document.body.style.overflow = overflow;
      window.scrollTo(scrollX, scrollY);
      if (opener?.isConnected) opener.focus({preventScroll: true});
    };
  }, []);
  const outside = (event: React.MouseEvent<HTMLDialogElement> | React.PointerEvent<HTMLDialogElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.target === event.currentTarget && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
  };
  return createPortal(<dialog ref={dialog} className="media-viewer" aria-label={label} onClose={() => { if (!dialog.current?.open) onClose(); }}
    onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onPointerDown={event => { backdropDown.current = outside(event); }}
    onClick={event => { if (backdropDown.current && outside(event)) onClose(); backdropDown.current = false; }}>
    <header><strong title={target.name}>{target.name}</strong><button type="button" autoFocus aria-label="关闭媒体预览" onClick={onClose}><X size={22}/></button></header>
    <ViewerContent key={target.key + ':' + target.src + ':' + target.reason} target={target} onPlay={onPlay} initialTime={initialTime} onPosition={onPosition}/>
    <footer><span>{target.kind === 'video' ? '空格播放 / 暂停；' : ''}按 Esc、关闭按钮或点击窗口外侧关闭</span>{onRepair && <button type="button" onClick={() => { onClose(); onRepair(); }}>{repairLabel}</button>}</footer>
  </dialog>, document.body);
}
