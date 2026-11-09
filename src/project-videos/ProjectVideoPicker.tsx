import React, {useEffect, useRef, useState} from 'react';
import {hostReads} from '../host-read';
import {FolderBrowser} from './FolderBrowser';
import type {FolderView, ProjectVideoCollection, ProjectVideo} from './types';

/** Catalogue status is descriptive; /inspect always checks the actual source before binding. */
export function ProjectVideoPicker({projectId, libraryId, registered, disabled, sources, onSelect, onInspect, onError}: {
  projectId: string; libraryId: string; registered: string; disabled: boolean;
  sources?: (Pick<ProjectVideo, 'id' | 'name' | 'managed' | 'status'> & {folderId?: string | null; folderName?: string})[];
  onSelect: (id: string) => void; onInspect: () => void; onError: (message: string) => void;
}) {
  const [folder, setFolder] = useState<FolderView>('all'), [search, setSearch] = useState('');
  const [collection, setCollection] = useState<ProjectVideoCollection | null>(null), [loading, setLoading] = useState(false), [version, setVersion] = useState(0);
  const serial = useRef(0);
  useEffect(() => {
    const ticket = ++serial.current, abort = new AbortController(); setLoading(true); setCollection(null);
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]);
    async function assertIdentity() {
      const response = await hostReads.fetch('/api/session', {credentials: 'same-origin', signal});
      const session = await response.json();
      if (!response.ok || session.app !== 'shiguang-local-media' || session.instanceId !== libraryId) {
        window.dispatchEvent(new Event('shiguang-library-identity-changed'));
        throw Error('素材库实例已变化，请关闭并重新核对项目；没有选择任何新视频。');
      }
    }
    void (async () => {
      try {
        await assertIdentity();
        const response = await hostReads.fetch(`/api/project-videos/projects/${encodeURIComponent(projectId)}?folderId=all`, {credentials: 'same-origin', signal}, assertIdentity);
        const data = await response.json();
        if (!response.ok) throw Error(data.error || '项目视频目录读取失败');
        if (data.project?.id !== projectId || !Array.isArray(data.videos) || data.videos.some((v: {projectId: string}) => v.projectId !== projectId)) throw Error('项目视频目录响应不匹配');
        await assertIdentity();
        if (ticket === serial.current) setCollection(data);
      } catch (e) { if (!abort.signal.aborted && ticket === serial.current) onError((e as Error).message); }
      finally { if (ticket === serial.current) setLoading(false); }
    })();
    return () => { serial.current += 1; abort.abort(); };
  }, [projectId, libraryId, version]);
  const catalogue = sources || collection?.videos || [];
  const query = search.trim().toLocaleLowerCase();
  const videos = catalogue.filter(v => v.managed && (query || folder === 'all' || v.folderId === folder) && (!query || `${v.name}\n${'fileName' in v ? v.fileName : ''}\n${v.folderName || ''}`.toLocaleLowerCase().includes(query)));
  const selectedFolder = (collection?.folders || []).find(f => f.id === folder);
  const selected = videos.find(v => v.id === registered);
  const selectable = (status: string) => status === 'available' || status === 'unchecked';
  return <div className="pv-binding-picker">
    <FolderBrowser folders={collection?.folders || []} current={folder} breadcrumbs={undefined} projectId={projectId} onNavigate={id => {setFolder(id); onSelect('');}}/>
    <div className="sbv-existing"><label>搜索项目视频（全部文件夹）<input type="search" aria-label="搜索项目视频" value={search} onChange={e => setSearch(e.target.value)} placeholder="视频名称或文件夹名称"/></label><button type="button" disabled={loading} onClick={() => setVersion(v => v + 1)}>刷新目录</button></div>
    <div className="sbv-existing"><select aria-label="选择项目视频" disabled={disabled || loading} value={selected?.id || ''} onChange={e => onSelect(e.target.value)}><option value="">{loading ? '正在读取目录…' : '请选择已导入的项目视频'}</option>{videos.map(v => <option key={v.id} value={v.id} disabled={!selectable(v.status)}>{v.name} · {v.folderName || (v.folderId === 'root' ? '项目根目录' : '当前目录')} · {v.status === 'available' ? '已核验，绑定前再检查' : v.status === 'unchecked' ? '待核验，选择后检查' : v.status === 'missing' ? '文件缺失' : v.status === 'changed' ? '文件已改变' : v.status === 'untrusted' ? '需重新定位' : '编码不支持'}</option>)}</select><button type="button" disabled={disabled || loading || !selected || !selectable(selected.status)} onClick={onInspect}>选择并核验此视频</button></div>
    {!!query && <p className="sbv-hint">搜索范围：全部文件夹 · {videos.length} 个结果</p>}
    {folder !== 'all' && folder !== 'root' && selectedFolder && !selectedFolder.available && <p className="sbv-warning">当前目录不可用；绑定前仍会核验原文件。</p>}
    {!loading && !videos.length && <p className="sbv-warning">当前目录或搜索没有可选的已导入视频。可切换到“全部视频”或前往生成视频导入；旧采用保持。</p>}
  </div>;
}
