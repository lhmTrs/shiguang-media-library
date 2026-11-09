import React,{useEffect,useRef,useState} from 'react';
import {useFeedbackToast} from '../global-feedback';
import type {PromptRequest} from '../PromptTemplateWorkspace';
type Doc={project_id:string;title:string;content:string;revision:number;updated_at:number|null};
type Entry={doc:Doc;title:string;content:string;loaded:boolean;reading:boolean;saving:boolean;error:string;edits:number;read:number};
const fresh=(id:string):Entry=>({doc:{project_id:id,title:'',content:'',revision:0,updated_at:null},title:'',content:'',loaded:false,reading:false,saving:false,error:'',edits:0,read:0});
const dirty=(e:Entry)=>e.title!==e.doc.title||e.content!==e.doc.content;
function checked(doc:Doc,id:string){if(doc?.project_id!==id||typeof doc.title!=='string'||typeof doc.content!=='string'||doc.title.length>200||doc.content.length>200000||!Number.isSafeInteger(doc.revision)||doc.revision<0||doc.updated_at!==null&&(!Number.isSafeInteger(doc.updated_at)||doc.updated_at<0))throw Error('剧本返回格式无效，本地输入已保留');return doc;}
type Name={kind:'character'|'scene'|'prop';name:string};
const kindLabel={character:'人物',scene:'场景',prop:'道具'} as const;
function outlineOf(text:string){const out:{line:number;offset:number;text:string}[]=[];let offset=0;text.split('\n').forEach((l,i)=>{if(/^\s*\d+[.．、]\s*\S/.test(l))out.push({line:i,offset,text:l.trim()});offset+=l.length+1;});return out.slice(0,300);}
function countOf(text:string,name:string){if(!name)return 0;let n=0,i=text.indexOf(name);while(i>=0&&n<9999){n++;i=text.indexOf(name,i+name.length);}return n;}
export function ProjectScript({projectId,visible,request,onDirtyChange,names=[]}:{projectId:string;visible:boolean;request:PromptRequest;onDirtyChange:(dirty:boolean)=>void;names?:Name[]}){
 const editor=useRef<HTMLTextAreaElement>(null);
 const cache=useRef(new Map<string,Entry>()),alive=useRef(true),[,render]=useState(0);const update=()=>{if(alive.current)render(n=>n+1);};
 function entry(id:string){let e=cache.current.get(id);if(!e){if(cache.current.size>=20){const removable=[...cache.current].find(([,v])=>!dirty(v)&&!v.reading&&!v.saving);if(removable)cache.current.delete(removable[0]);else return{...fresh(id),error:'已保留20份未保存或处理中剧本，请先返回原项目保存'};}e=fresh(id);cache.current.set(id,e);}return e;}
 const current=entry(projectId),unsaved=dirty(current);
 useFeedbackToast(current.error,{source:'项目剧本',active:visible});
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
 const outline=outlineOf(current.content),mentions=names.map(n=>({...n,count:countOf(current.content,n.name)}));
 function jumpTo(offset:number,line:number){const t=editor.current;if(!t)return;t.focus();t.setSelectionRange(offset,offset);const lh=parseFloat(getComputedStyle(t).lineHeight)||22;t.scrollTop=Math.max(0,line*lh-lh*2);}
 return <section className="ca-project-script" aria-label="项目剧本" aria-busy={current.reading||current.saving}>
  <header><div><h2>剧本</h2><p role="status">{current.saving?'保存中…':current.reading?'读取中…':current.error?'操作失败，输入保留':!current.loaded?'尚未读取':unsaved?'有未保存修改':current.doc.revision?'已保存 · V'+current.doc.revision:'尚未保存'}{current.doc.updated_at!==null&&<> · 最后保存 {new Date(current.doc.updated_at).toLocaleString('zh-CN')}</>} · 保存在当前项目，不会自动生成或修改分镜</p></div><div className="ca-actions"><button disabled={current.reading||current.saving} onClick={()=>void read(true)}>重新读取剧本</button><button className="ca-primary" disabled={!current.loaded||current.reading||current.saving||!unsaved} onClick={()=>void save()}>保存剧本</button></div></header>
  {current.error&&<p className="ca-alert" role="alert">{current.error}</p>}
  <div className="ca-script-cols">
   <nav className="ca-script-outline" aria-label="场次大纲"><h3>场次大纲</h3>{outline.length?<ol>{outline.map(o=><li key={o.line+':'+o.offset}><button type="button" title={o.text} onClick={()=>jumpTo(o.offset,o.line)}>{o.text}</button></li>)}</ol>:<p className="ca-muted">以“1. ”这样的数字编号开头的行会显示为场次。</p>}</nav>
   <div className="ca-script-editor">
    <label className="ca-field"><span>剧本标题</span><input aria-label="剧本标题" maxLength={200} disabled={!current.loaded||current.reading} value={current.title} onChange={e=>{current.title=e.target.value;current.edits++;update();}}/></label>
    <label className="ca-field ca-script-body"><span>剧本正文</span><textarea ref={editor} aria-label="剧本正文" maxLength={200000} rows={22} disabled={!current.loaded||current.reading} value={current.content} onChange={e=>{current.content=e.target.value;current.edits++;update();}}/></label><small>{current.content.length.toLocaleString()} / 200,000 字</small>
   </div>
   <aside className="ca-script-mentions" aria-label="剧本中出现的资产"><h3>剧本中出现</h3>{(['character','scene','prop'] as const).map(k=>{const list=mentions.filter(m=>m.kind===k).sort((x,y)=>y.count-x.count);return <div key={k}><h4>{kindLabel[k]}</h4>{list.length?<ul>{list.map(m=><li key={m.name} className={m.count?'':'is-absent'}><span>{m.name}</span><small>{m.count?m.count+' 次':'未出现'}</small></li>)}</ul>:<p className="ca-muted">本项目还没有{kindLabel[k]}</p>}</div>;})}</aside>
  </div>
 </section>;
}
