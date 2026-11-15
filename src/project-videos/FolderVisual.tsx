// 文件夹卡片上半部（合同 PV-FOLDER-COVERS）：
// - 不知道视频数（旧后端）或有视频但没有可用封面：普通文件夹图标；
// - 0 个视频：虚线空文件夹；
// - 有封面：最多 3 张错开叠放，还有没摆出来的写「+N」（N = 视频数 − 已摆张数）。
// 封面加载失败：那一张原位换成占位块，槽位、次序、数量和 +N 都不变，也不退回成普通图标。
import {useState} from 'react';
import {ChevronRight, Film, Folder} from 'lucide-react';
import type {Folder as VideoFolder} from './types';

export function FolderVisual({folder}: {folder: VideoFolder}) {
  const [broken, setBroken] = useState<string[]>([]);
  const count = typeof folder.videoCount === 'number' ? folder.videoCount : null;
  const covers = (folder.covers || []).slice(0, 3);
  const more = count !== null ? count - covers.length : 0;
  const empty = count === 0;
  return <span className="pv-thumbnail pv-folder-visual" data-covers={covers.length} data-empty={empty || undefined} aria-hidden="true">
    {empty ? <Folder size={64} strokeWidth={1.3} className="pv-folder-empty-icon"/>
      : covers.length ? <span className="pv-folder-covers">{covers.map((c, i) => !c.thumbnailUrl || broken.includes(c.videoId)
          ? <span key={c.videoId} className="pv-folder-cover pv-folder-cover-missing" data-i={i} data-n={covers.length} title="封面暂时读不到"><Film size={18}/></span>
          : <img key={c.videoId} src={c.thumbnailUrl} alt="" loading="eager" draggable={false}
          className="pv-folder-cover" data-i={i} data-n={covers.length} onError={() => setBroken(old => [...old, c.videoId])}/>)}</span>
      : <Folder size={76} strokeWidth={1.3}/>}
    {more > 0 && covers.length > 0 && <span className="pv-folder-more">+{more}</span>}
    <ChevronRight size={18} className="pv-folder-enter"/>
  </span>;
}
