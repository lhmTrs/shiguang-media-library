import type {Folder, FolderView, AdoptedShot} from './types';

export const VIDEO_DRAG_TYPE = 'application/x-shiguang-project-video';
// “全部视频”与“废片”都是聚合视图，不是具体目录：新建、导入都落到项目根目录。
export const folderTarget = (view: FolderView) => view === 'all' || view === 'reject' ? 'root' : view;
export function folderTrail(folders: Folder[], id: FolderView): Folder[] {
  const trail: Folder[] = [], seen = new Set<string>();
  let current = folders.find(f => f.id === id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id); trail.unshift(current); current = folders.find(f => f.id === current!.parentId);
  }
  return trail;
}
export function folderContains(folders: Folder[], ancestor: string, child: string): boolean {
  return ancestor === child || ancestor === 'root' || folderTrail(folders, child).some(f => f.id === ancestor);
}
export function uniqueShots(shots: AdoptedShot[]): AdoptedShot[] {
  return [...new Map(shots.map(s => [s.id, s])).values()];
}
export function readVideoDrag(data: Pick<DataTransfer, 'types' | 'getData'>, projectId: string): string | null {
  if (!data.types.includes(VIDEO_DRAG_TYPE) || data.types.includes('Files')) return null;
  try { const value = JSON.parse(data.getData(VIDEO_DRAG_TYPE)); return value.projectId === projectId && typeof value.videoId === 'string' ? value.videoId : null; }
  catch { return null; }
}
