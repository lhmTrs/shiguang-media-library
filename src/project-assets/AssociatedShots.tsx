import React, {useEffect,useState} from 'react';
import {Clapperboard,RefreshCw} from 'lucide-react';
import type {PromptRequest} from '../PromptTemplateWorkspace';
import type {ShotTarget} from '../storyboard/shot-navigation';
type Links={projectId:string;documentId:string|null;documentTitle:string;initialized:boolean;listed:boolean;items:{shotId:string;number:string;sceneName:string;action:string;reasons:string[]}[]};
export function AssociatedShots({assetId,active,request,onOpen}:{assetId:string;active:boolean;request:PromptRequest;onOpen?:(target:ShotTarget)=>void}){
 const [data,setData]=useState<Links|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[reload,setReload]=useState(0);
 useEffect(()=>{if(!active)return;let live=true;setData(null);setError('');setLoading(true);void request<Links>('/project-assets/assets/'+assetId+'/shots').then(value=>{if(live)setData(value);}).catch(e=>{if(live)setError(e.message||'关联镜号读取失败');}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[assetId,active,reload]);
 return <section className="ca-shot-links" aria-label="关联镜号" aria-busy={loading}>
  <div className="ca-shot-links-heading"><div><h3>关联镜号{data?' · '+data.items.length:''}</h3><p className="ca-muted">按已保存分镜的明确关联展示。点击镜号可前往分镜设计并高亮对应镜头。</p></div><button disabled={loading} onClick={()=>setReload(n=>n+1)}><RefreshCw size={14}/>刷新关联</button></div>
  {loading?<p role="status">正在读取关联镜号…</p>:error?<div role="alert" className="ca-alert">{error}</div>:!data?.items.length?<div className="ca-empty">{!data?.initialized?'该资产所属项目尚未初始化分镜。':!data.listed?'该资产尚未加入当前分镜素材清单。':'已加入分镜清单，但尚无镜头明确关联。'}</div>:<><p className="ca-muted">{data.documentTitle}</p><ul>{data.items.map(item=><li key={item.shotId}><button className="ca-shot-link" disabled={!onOpen||!data.documentId} aria-label={'查看镜 '+item.number} onClick={()=>{if(data.documentId)onOpen?.({projectId:data.projectId,documentId:data.documentId,shotId:item.shotId});}}><Clapperboard size={18}/><span><strong>镜 {item.number}</strong><small>{item.sceneName} · {item.reasons.join('、')}</small>{item.action&&<span className="ca-shot-excerpt">{item.action}</span>}</span><span className="ca-muted">查看分镜 →</span></button></li>)}</ul></>}
 </section>;
}
