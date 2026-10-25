import { useCallback, useEffect, useRef, useState } from 'react';
import type { LocalRequest } from './OpenAISettings';
import './cloud-audio-manual.css';
type Asset={id:string;name:string;kind:string;category:string;sub:string};
type Intent={id:string;fileName:string;state:string;status:string|null;error:string|null;requestId:string|null;receipt:{shareId:string}|null};
type Group={groupId:string;name:string;state:string;canReadShared:boolean};
const statusLabels:Record<string,string>={PENDING:'待审批',APPROVED:'审批通过',REJECTED:'审批拒绝',CANCELLED:'申请取消',EXPIRED:'申请过期'};
const labels:Record<string,string>={prepared:'快照已准备',requesting:'正在申请',ready:'待操作',pending:'等待审批',uploading:'上传中',unknown:'结果未知，需核对',completed:'已提交云端',cancelled:'申请已取消',failed:'未开始上传，需检查源文件'};
export function CloudAudioUpload({request}:{request:LocalRequest}){
 const [items,setItems]=useState<Asset[]>([]),[jobs,setJobs]=useState<Intent[]>([]),[groups,setGroups]=useState<Group[]>([]);
 const [q,setQ]=useState(''),[page,setPage]=useState(1),[more,setMore]=useState(false),[assetId,setAssetId]=useState('');
 const [category,setCategory]=useState(''),[sub,setSub]=useState(''),[groupId,setGroupId]=useState(''),[busy,setBusy]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(true);
 const activeActions=useRef(0);const hasInFlight=jobs.some(j=>['uploading','requesting'].includes(j.state));
 const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const refresh=useCallback(async()=>{const rows=await request<Intent[]>('/cloud-audio/uploads');if(alive.current)setJobs(rows);},[request]);
 useEffect(()=>{if((!busy||busy==='prepare')&&!hasInFlight)return;let pending=false;const timer=setInterval(()=>{if(pending)return;pending=true;void refresh().catch(()=>{}).finally(()=>{pending=false;});},500);return()=>clearInterval(timer);},[busy,refresh,hasInFlight]);
 const load=async(next=1)=>{setLoading(true);setError('');try{const r=await request<{items:Asset[];hasMore:boolean}>(`/cloud-audio/upload-assets?q=${encodeURIComponent(q)}&page=${next}`);setItems(r.items);setPage(next);setMore(r.hasMore);}catch{setError('无法读取本地音频，请重试。');}finally{setLoading(false);}};
 useEffect(()=>{let alive=true;void Promise.all([request<{items:Asset[];hasMore:boolean}>('/cloud-audio/upload-assets'),request<Intent[]>('/cloud-audio/uploads'),request<{capabilities:{groups:Group[]}}>('/cloud-management/profile')]).then(([a,j,p])=>{if(alive){setItems(a.items);setMore(a.hasMore);setJobs(j);setGroups(p.capabilities.groups.filter(g=>g.state==='ACTIVE'&&g.canReadShared));}}).catch(()=>{if(alive)setError('无法读取上传材料或当前权限，请刷新重试。');}).finally(()=>{if(alive)setLoading(false);});return()=>{alive=false;};},[request]);
 const run=async(id:string,action:string)=>{activeActions.current++;setBusy(id);setError('');try{await request(`/cloud-audio/uploads/${id}/${action}`,{},'POST');}catch{setError('操作未确认，请刷新或核对原申请；不要重复创建上传。');}finally{await refresh().catch(()=>setError('本地记录读取失败，请刷新核对。'));activeActions.current--;if(activeActions.current===0)setBusy('');}};
 const prepare=async()=>{const a=items.find(x=>x.id===assetId);if(!a)return;setBusy('prepare');setError('');try{const j=await request<Intent>('/cloud-audio/uploads',{assetId:a.id,mediaKind:a.kind==='music'?'MUSIC':'SFX',visibility:groupId?'GROUP':'PRIVATE',groupId:groupId||null,category,subcategory:sub},'POST');await request(`/cloud-audio/uploads/${j.id}/request`,{},'POST');}catch{setError('申请结果未确认，请先查看已有意图，不要再次新建。');}finally{await refresh().catch(()=>{});setBusy('');}};
 return <section className="manual-audio" aria-label="手动上传音频">
  <h3>手动上传音乐 / 音效</h3><p className="muted">只发送所选音频与两级云端分类，不发送本地目录。审批通过后，点击“上传音频”完成共享。</p>
  {error&&<p role="alert">{error}</p>}
  <form className="manual-audio-fields" onSubmit={e=>{e.preventDefault();void load(1);}}>
   <input aria-label="查找本地音频" placeholder="按名称选择本地音频" value={q} maxLength={128} onChange={e=>setQ(e.target.value)}/><button className="plain" disabled={loading}>查找本地素材</button>
   <select aria-label="选择上传素材" value={assetId} onChange={e=>{setAssetId(e.target.value);const a=items.find(x=>x.id===e.target.value);setCategory(a?.category||'');setSub(a?.sub||'');}}><option value="">请选择已登记的音乐或音效</option>{items.map(a=><option key={a.id} value={a.id}>{a.name}（{a.kind==='music'?'音乐':'音效'}）</option>)}</select>
  </form>
  {loading?<p role="status">正在读取本地音频…</p>:!error&&items.length===0?<p>没有可选音频，请先在素材库登记音频目录。</p>:null}
  <div className="manual-audio-fields"><button className="plain" disabled={page===1||loading} onClick={()=>void load(page-1)}>上一页本地素材</button><span>第 {page} 页</span><button className="plain" disabled={!more||loading} onClick={()=>void load(page+1)}>下一页本地素材</button></div>
  <div className="manual-audio-fields"><select aria-label="上传可见范围" value={groupId} onChange={e=>setGroupId(e.target.value)}><option value="">仅自己</option>{groups.map(g=><option key={g.groupId} value={g.groupId}>{g.name}</option>)}</select>
   <input aria-label="云端主分类" placeholder="云端主分类（可留空）" maxLength={60} value={category} onChange={e=>setCategory(e.target.value)}/><input aria-label="云端子分类" placeholder="云端子分类（可留空）" maxLength={60} value={sub} onChange={e=>setSub(e.target.value)}/>
   <button className="plain" disabled={!!busy||!assetId||loading} onClick={()=>void prepare()}>{busy==='prepare'?'正在校验快照并申请…':'提交上传申请'}</button><button className="plain" onClick={()=>void refresh().catch(()=>setError('无法刷新上传记录。'))}>刷新上传记录</button>
  </div>
  {jobs.length===0?(!error&&<p className="muted">尚无手动上传意图，不会自动上传。</p>):<ul className="manual-audio-intents">{jobs.map(j=><li key={j.id}><strong>{j.fileName}</strong><span role="status">{labels[j.state]||'待核对'} · {statusLabels[j.status||'']||'未申请'}</span>{j.error&&<span role="alert">{j.error}</span>}
   <div className="manual-audio-fields">
    {j.state==='prepared'&&<button className="plain" disabled={!!busy} onClick={()=>void run(j.id,'request')}>重试原申请</button>}
    {j.requestId&&<button className="plain" disabled={!!busy} onClick={()=>void run(j.id,'refresh')}>刷新审批状态</button>}
    {j.state==='unknown'&&j.requestId&&<button className="plain" disabled={!!busy} onClick={()=>void run(j.id,'reconcile')}>核对原提交结果</button>}
    {j.state==='unknown'&&!j.requestId&&<button className="plain" disabled={!!busy} onClick={()=>void run(j.id,'request')}>同一 key 重试申请</button>}
    {j.state==='ready'&&j.status==='APPROVED'&&<button className="plain" disabled={!!busy} onClick={()=>void run(j.id,'upload')}>{busy===j.id?'正在上传音频…':'上传音频'}</button>}
    {!['completed','cancelled'].includes(j.state)&&<button className="plain" disabled={!!busy&&j.state!=='uploading'} onClick={()=>void run(j.id,'cancel')}>{j.state==='uploading'?'停止传输并核对':'取消申请'}</button>}
    {['completed','cancelled'].includes(j.state)&&<button className="plain" disabled={!!busy} onClick={()=>void run(j.id,'forget')}>移除本地完成记录</button>}
   </div>{j.state==='completed'&&<small>提交回执已保存。撤回共享与放弃本人保留是不同操作，本页不会自动执行。</small>}
   {j.status==='REJECTED'&&<small>申请已拒绝，不会上传。</small>}{j.status==='EXPIRED'&&<small>申请已过期，不会自动创建新的共享意图。</small>}
  </li>)}</ul>}
 </section>;
}
