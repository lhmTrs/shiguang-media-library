import React, {useEffect, useState} from 'react';
import {ChevronRight, FolderOpen, Folder, Layers} from 'lucide-react';
import type {Folder as VideoFolder, FolderView} from './types';
import {folderTrail, readVideoDrag, VIDEO_DRAG_TYPE} from './folders';
import {notifyFeedback} from '../global-feedback';
import './project-videos.css';

type FolderBrowserProps = {
  folders: VideoFolder[]; current: FolderView; breadcrumbs?: VideoFolder[]; projectId: string;
  onNavigate: (id: FolderView) => void; onMoveVideo?: (videoIds: string[], folderId: string) => void;
  /** 暂时不能移动的原因（例如上一笔移动还没完成）：仍接受拖放，卡片上说明原因，放下时由宿主提示。 */
  moveBlockedReason?: string;
};

export function FolderBrowser({folders, current, breadcrumbs, projectId, onNavigate, onMoveVideo, moveBlockedReason, part = 'all'}: FolderBrowserProps & {part?: 'all' | 'tree' | 'breadcrumbs' | 'subfolders' | 'cards'}) {
  const trail = breadcrumbs || folderTrail(folders, current);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [fileDropTarget, setFileDropTarget] = useState<string | null>(null);
  useEffect(() => { setDropTarget(null); setFileDropTarget(null); }, [current, projectId]);
  const drop = (id: string) => ({
    onDragOver: (e: React.DragEvent) => { if (onMoveVideo && e.dataTransfer.types.includes(VIDEO_DRAG_TYPE) && !e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropTarget(id); } },
    onDragLeave: (e: React.DragEvent) => { if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setDropTarget(old => old === id ? null : old); },
    onDrop: (e: React.DragEvent) => { setDropTarget(null); const videoIds = readVideoDrag(e.dataTransfer, projectId); if (videoIds && onMoveVideo) { e.preventDefault(); e.stopPropagation(); onMoveVideo(videoIds, id); } },
  });
  function blockCardFiles(e: React.DragEvent, id: string) {
    if (!e.dataTransfer.types.includes('Files')) return false;
    e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'none';
    setDropTarget(null); setFileDropTarget(id);
    if (e.type === 'drop') notifyFeedback({source: '生成视频', kind: 'info', message: '请用“导入视频”入口导入外部文件。'});
    return true;
  }
  const cardDrop = (f: VideoFolder) => ({
    onDragOver: (e: React.DragEvent) => { if (blockCardFiles(e, f.id)) return; setFileDropTarget(null); if (f.available) drop(f.id).onDragOver(e); },
    onDragLeave: (e: React.DragEvent) => { drop(f.id).onDragLeave(e); if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setFileDropTarget(old => old === f.id ? null : old); },
    onDrop: (e: React.DragEvent) => { if (blockCardFiles(e, f.id)) return; setFileDropTarget(null); if (f.available) drop(f.id).onDrop(e); },
  });
  function branch(parentId: string, seen = new Set<string>()): React.ReactNode {
    return folders.filter(f => f.parentId === parentId && !seen.has(f.id)).map(f => <li key={f.id}>
      <button type="button" aria-current={current === f.id ? 'page' : undefined} onClick={() => onNavigate(f.id)} {...(f.available ? drop(f.id) : {})}>
        <Folder size={15}/><span title={f.path || f.name}>{f.name}</span>{!f.available && <small>不可用</small>}
      </button>
      <ul>{branch(f.id, new Set([...seen, f.id]))}</ul>
    </li>);
  }
  const children = folders.filter(f => f.parentId === (current === 'all' ? 'root' : current));
  const tree = <nav aria-label="视频文件夹树" className="pv-folder-tree">
      <button type="button" aria-current={current === 'all' ? 'page' : undefined} onClick={() => onNavigate('all')}><Layers size={15}/>全部视频</button>
      <button type="button" aria-current={current === 'root' ? 'page' : undefined} onClick={() => onNavigate('root')} {...drop('root')}><FolderOpen size={15}/>项目根目录</button>
      <ul>{branch('root')}</ul>
    </nav>;
  const crumbs = <nav aria-label="视频文件夹面包屑" className="pv-breadcrumbs"><button type="button" onClick={() => onNavigate('all')}>全部</button><ChevronRight size={14}/><button type="button" onClick={() => onNavigate('root')} {...drop('root')}>项目根目录</button>
        {current !== 'all' && trail.map(f => <React.Fragment key={f.id}><ChevronRight size={14}/><button type="button" onClick={() => onNavigate(f.id)} {...(f.available ? drop(f.id) : {})}>{f.name}</button></React.Fragment>)}
        {current === 'all' && <span>（聚合所有文件夹）</span>}
      </nav>;
  const subfolders = <div className="pv-subfolders" aria-label="当前层子文件夹">{children.map(f => <button type="button" key={f.id} onClick={() => onNavigate(f.id)} {...(f.available ? drop(f.id) : {})}><Folder size={18}/><span title={f.path || f.name}>{f.name}</span>{!f.available && <small>目录不可用</small>}</button>)}</div>;
  if (part === 'cards') return <>{children.map(f => <div className="pv-card-entry pv-folder-entry" key={f.id}>
    <button type="button" className={`pv-card pv-folder-card${!f.available ? ' pv-folder-unavailable' : ''}${f.available && onMoveVideo && dropTarget === f.id ? ' pv-folder-drop-target' : ''}`}
      aria-label={`打开文件夹：${f.name}`} title={`项目根目录 / ${f.path || f.name}`} onClick={() => onNavigate(f.id)} {...cardDrop(f)}>
      <span className="pv-thumbnail pv-folder-visual" aria-hidden="true"><Folder size={76} strokeWidth={1.3}/><ChevronRight size={18} className="pv-folder-enter"/></span>
      <span className="pv-card-body"><strong title={f.name}>{f.name}</strong><small title={f.path || f.name}>{current === 'all' || current === 'root' ? '位于项目根目录' : `位于 ${folders.find(parent => parent.id === current)?.path || trail.map(parent => parent.name).join(' / ') || '当前目录'}`}</small>
        <span className="pv-folder-card-hint">{fileDropTarget === f.id ? '请用“导入视频”入口' : !f.available ? '目录不可用 · 查看目录' : onMoveVideo && dropTarget === f.id ? (moveBlockedReason || '松开，预览移动到此文件夹') : onMoveVideo ? '单击进入 · 可拖入视频' : '单击进入文件夹'}</span>
      </span>
    </button>
  </div>)}</>;
  if (part === 'tree') return tree;
  if (part === 'breadcrumbs') return crumbs;
  if (part === 'subfolders') return subfolders;
  return <div className="pv-folder-browser">{tree}<div className="pv-folder-main">{crumbs}{subfolders}</div></div>;
}

export const FolderTree = (props: FolderBrowserProps) => <FolderBrowser {...props} part="tree"/>;
export const FolderBreadcrumbs = (props: FolderBrowserProps) => <FolderBrowser {...props} part="breadcrumbs"/>;
export const FolderSubfolders = (props: FolderBrowserProps) => <FolderBrowser {...props} part="subfolders"/>;

export const FolderCards = (props: FolderBrowserProps) => <FolderBrowser {...props} part="cards"/>;
