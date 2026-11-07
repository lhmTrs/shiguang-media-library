import {useEffect,useState,useSyncExternalStore} from 'react';
import {HardDrive,LoaderCircle} from 'lucide-react';
import {hostReads} from './host-read';

export function BackgroundReadStatus(){
  const recovering=useSyncExternalStore(hostReads.subscribe,hostReads.recovering);
  const [delayed,setDelayed]=useState(false);
  useEffect(()=>{
    if(!recovering){setDelayed(false);return;}
    const timer=setTimeout(()=>setDelayed(true),800);
    return()=>clearTimeout(timer);
  },[recovering]);
  const updating=recovering&&delayed;
  return <span className="library-read-indicator" data-updating={updating} role="status" aria-live="polite" aria-label={updating?'后台更新中':'本地素材库'} title={updating?'正在后台更新数量或状态，当前内容保留，无需重复点击。':'本地素材库'}>
    {updating?<LoaderCircle size={14} className="spin" aria-hidden="true"/>:<HardDrive size={14} aria-hidden="true"/>}
    <span>{updating?'后台更新中':'LOCAL LIBRARY'}</span>
  </span>;
}
