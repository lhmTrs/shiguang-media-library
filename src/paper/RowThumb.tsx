// 「新样子（试用）」列表行里照片和视频的小缩略图（样稿里视觉素材一行是缩略图，声音素材是试听键）。
// 用服务端已有的 /api/media/:id/thumb（最长边 800，生成一次后缓存，网格视图也用它）；懒加载，看不到的行不请求。
// 读不到就退回原来的类型图标。
import React, {useEffect, useState} from 'react';

export function RowThumb({id, version, fallback}: {id: string; version: number; fallback: React.ReactNode}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [id, version]);
  if (failed) return <>{fallback}</>;
  return <img className="sgp-row-thumb" src={`/api/media/${encodeURIComponent(id)}/thumb`} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)}/>;
}
