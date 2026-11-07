import React,{useEffect,useRef,useState} from 'react';
import type {PromptRequest} from '../PromptTemplateWorkspace';
type Doc={project_id:string;title:string;content:string;revision:number;updated_at:number|null};
type Entry={doc:Doc;title:string;content:string;loaded:boolean;reading:boolean;saving:boolean;error:string;edits:number;read:number};
const fresh=(id:string):Entry=>({doc:{project_id:id,title:'',content:'',revision:0,updated_at:null},title:'',content:'',loaded:false,reading:false,saving:false,error:'',edits:0,read:0});
const dirty=(e:Entry)=>e.title!==e.doc.title||e.content!==e.doc.content;
function checked(doc:Doc,id:string){if(doc?.project_id!==id||typeof doc.title!=='string'||typeof doc.content!=='string'||doc.title.length>200||doc.content.length>200000||!Number.isSafeInteger(doc.revision)||doc.revision<0||doc.updated_at!==null&&(!Number.isSafeInteger(doc.updated_at)||doc.updated_at<0))throw Error('剧本返回格式无效，本地输入已保留');return doc;}
export function ProjectScript({projectId,visible,request,onDirtyChange}:{projectId:string;visible:boolean;request:PromptRequest;onDirtyChange:(dirty:boolean)=>void}){
 const cache=useRef(new Map<string,Entry>()),alive=useRef(true),[,render]=useState(0);const update=()=>{if(alive.current)render(n=>n+1);};
 function entry(id:string){let e=cache.current.get(id);if(!e){if(cache.current.size>=20){const removable=[...cache.current].find(([,v])=>!dirty(v)&&!v.reading&&!v.saving);if(removable)cache.current.delete(removable[0]);else return{...fresh(id),error:'已保留20份未保存或处理中剧本，请先返回原项目保存'};}e=fresh(id);cache.current.set(id,e);}return e;}
 const current=entry(projectId),unsaved=dirty(current);
 useEffect(()=>{alive.current=true;const before=(e:BeforeUnloadEvent)=>{if([...cache.current.values()].some(dirty)){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',before);return()=>{alive.current=false;window.removeEventListener('beforeunload',before);};},[]);
 useEffect(()=>{onDirtyChange(unsaved);},[projectId,unsaved,onDirtyChange]);
 useEffect(()=>()=>onDirtyChange(false),[onDirtyChange]);
 async function read(replace=false){
  const id=projectId,e=entry(id);if(e.reading||e.saving||!cache.current.has(id))return;
  if(replace&&dirty(e)&&!window.confirm('载入已保存剧本会替换当前输入，确定继续吗？'))return;
  e.reading=true;e.error='';const sequence=++e.read,edits=e.edits;update();
  try{const doc=checked(await request<Doc>('/project-assets/projects/'+encodeURIComponent(id)+'/script',undefined,undefined,{signal:AbortSignal.timeout(15000)}),id);if(sequence!==e.read)return;
   if(e.edits!==edits){e.error='读取期间已有新输入，本地内容保留，请核对后重新读取';return;}
   e.doc=doc;e.title=doc.title;e.content=doc.content;e.loaded=true;
  }catch(error:any){e.error=error.message||'读取失败，本地内容已保留';}
  finally{if(sequence===e.read)e.reading=false;update();}
 }
 useEffect(()=>{if(visible&&projectId&&!current.loaded&&!current.reading&&!current.error)void read();},[visible,projectId]);
 async function save(){
  const id=projectId,e=entry(id);if(!e.loaded||e.reading||e.saving)return;
  const sent={title:e.title,content:e.content,expected_revision:e.doc.revision},edits=e.edits;e.saving=true;e.error='';update();
  try{const doc=checked(await request<Doc>('/project-assets/projects/'+encodeURIComponent(id)+'/script',sent,'PUT',{signal:AbortSignal.timeout(15000)}),id);if(doc.revision<=sent.expected_revision||doc.title!==sent.title||doc.content!==sent.content)throw Error('保存回执不一致，本地输入仍保留，请核对已保存内容');
   e.doc=doc;if(e.edits===edits){e.title=doc.title;e.content=doc.content;}
  }catch(error:any){e.error=(error.message||'保存失败')+'；本地输入仍保留'+(!error.status?'，保存结果尚未确认，请核对后再操作':'');}
  finally{e.saving=false;update();}
 }
 return <section className="ca-project-script" aria-label="项目剧本" aria-busy={current.reading||current.saving}>
  <header><div><h2>剧本</h2><p>保存在当前项目，不会自动生成或修改分镜。</p></div><div className="ca-actions"><button disabled={current.reading||current.saving} onClick={()=>void read(true)}>重新读取剧本</button><button className="ca-primary" disabled={!current.loaded||current.reading||current.saving||!unsaved} onClick={()=>void save()}>保存剧本</button></div></header>
  <p role="status">{current.saving?'保存中…':current.reading?'读取中…':current.error?'操作失败，输入保留':!current.loaded?'尚未读取':unsaved?'有未保存修改':current.doc.revision?'已保存 · V'+current.doc.revision:'尚未保存'}{current.doc.updated_at!==null&&<> · 最后保存 {new Date(current.doc.updated_at).toLocaleString('zh-CN')}</>}</p>
  {current.error&&<p className="ca-alert" role="alert">{current.error}</p>}
  <label className="ca-field"><span>剧本标题</span><input aria-label="剧本标题" maxLength={200} disabled={!current.loaded||current.reading} value={current.title} onChange={e=>{current.title=e.target.value;current.edits++;update();}}/></label>
  <label className="ca-field"><span>剧本正文</span><textarea aria-label="剧本正文" maxLength={200000} rows={22} disabled={!current.loaded||current.reading} value={current.content} onChange={e=>{current.content=e.target.value;current.edits++;update();}}/></label><small>{current.content.length.toLocaleString()} / 200,000 字</small>
 </section>;
}
