import {useEffect,useRef,useState} from 'react';
import {Image,Film,Music,RefreshCw} from 'lucide-react';
import {imageNamePreset} from '../import-presets.mjs';
import {INTAKE_API,kindLabel,encoded,errorMessage,type IntakeDestination,type IntakeFile,type IntakeFolder,type IntakeRequest,type MediaKind,type ImageProposal} from './types';

type Proposal=ImageProposal;
export type DestinationDraft=IntakeDestination;
export function initialDestination(file:IntakeFile,preferences:Partial<Record<MediaKind,IntakeDestination>>):DestinationDraft|null{
  if(file.mediaKind==='audio')return null;
  const kind=file.mediaKind==='photo'?'photo':'video',pref=preferences[kind];
  const suggestion=imageNamePreset(file.name);
  // Ambiguous camera names stay in general photos; a structured actor/look name
  // may use the explicitly remembered project. Suggestions never create assets.
  const target=kind==='photo'&&!suggestion.structured?{kind,scope:'library' as const,directory:''}:pref||{kind,scope:'library' as const,directory:''};
  return {...target,kind,...(kind==='photo'?{characterName:suggestion.name,lookName:suggestion.lookName}:{})};
}
export function TargetEditor({file,handoffId,api,projects,value,locked,onChange,onReady}:{file:IntakeFile;handoffId:string;api:IntakeRequest;projects:{id:string;name:string}[];value:DestinationDraft|null;locked:boolean;onChange:(v:DestinationDraft,manual?:boolean)=>void;onReady:(v:boolean)=>void}){
  const [folders,setFolders]=useState<IntakeFolder[]>([]),[reading,setReading]=useState(false),[error,setError]=useState(''),[refresh,setRefresh]=useState(0),[newFolder,setNewFolder]=useState(''),[creating,setCreating]=useState(false),[proposal,setProposal]=useState<Proposal|null>(null),[checking,setChecking]=useState(false);
  const valueRef=useRef(value);valueRef.current=value;
  const kind=value?.kind,scope=value?.scope,project=value?.projectId||'';
  const name=value?.characterName||'',look=value?.lookName||'',proposalKey=JSON.stringify([scope,project,name,look]);
  const proposalRef=useRef('');
  const patch=(fields:Partial<DestinationDraft>)=>{if(value)onChange({...value,...fields});};
  useEffect(()=>{
    if(!value||scope==='project'&&kind==='photo'){setFolders([]);setReading(false);setError('');return;}
    const c=new AbortController();let current=true;setReading(true);setError('');
    const url=scope==='project'?INTAKE_API+'/projects/'+encoded(project)+'/folders':INTAKE_API+'/categories/'+kind;
    if(scope==='project'&&!project){setReading(false);setFolders([]);return;}
    void api<{folders:IntakeFolder[]}>(url,undefined,undefined,{signal:c.signal}).then(r=>{if(!current)return;setFolders(r.folders);const v=valueRef.current;if(!v)return;const selected=v.scope==='project'?v.folderId||'root':v.directory||'';if(!r.folders.some(f=>f.id===selected)){const fallback=v.scope==='project'?'root':'';onChange({...v,...(v.scope==='project'?{folderId:fallback}:{directory:fallback})},false);}}).catch(e=>{if(current&&!c.signal.aborted)setError(errorMessage(e));}).finally(()=>{if(current)setReading(false);});
    return()=>{current=false;c.abort();};
  },[api,kind,scope,project,refresh]);
  useEffect(()=>{
    if(scope!=='project'||kind!=='photo'){setProposal(null);setChecking(false);proposalRef.current='';return;}
    setProposal(null);proposalRef.current='';
    if(!project||!name.trim()||!look.trim()){setChecking(false);return;}
    const c=new AbortController();let current=true;setChecking(true);setError('');
    const timer=setTimeout(()=>{void api<{destination:Proposal;message:string}>(INTAKE_API+'/image-proposal?projectId='+encoded(project)+'&name='+encoded(name)+'&lookName='+encoded(look),undefined,undefined,{signal:c.signal}).then(result=>{if(!current)return;const p=result.destination;proposalRef.current=proposalKey;setProposal(p);const v=valueRef.current;if(v)onChange({...v,imageProposal:p},false);}).catch(e=>{if(current&&!c.signal.aborted)setError(errorMessage(e));}).finally(()=>{if(current)setChecking(false);});},250);
    return()=>{current=false;clearTimeout(timer);c.abort();};
  },[api,kind,proposalKey,refresh]);
  const selected=value?.scope==='project'?value.folderId||'root':value?.directory||'';
  const ready=!!value&&!reading&&!checking&&!creating&&!error&&(scope==='project'?!!project&&(kind==='photo'?proposalRef.current===proposalKey&&!!proposal:folders.some(f=>f.id===selected)):folders.some(f=>f.id===selected));
  useEffect(()=>{onReady(ready);return()=>onReady(false);},[ready]);
  async function createFolder(){if(!value||!newFolder.trim()||creating)return;setCreating(true);setError('');try{const r=await api<{relativePath:string}>(INTAKE_API+'/categories/'+value.kind,{directory:value.directory||'',name:newFolder});onChange({...value,directory:r.relativePath});setNewFolder('');setRefresh(n=>n+1);}catch(e){setError(errorMessage(e));}finally{setCreating(false);}}
  const updateFilename=(text:string)=>{if(!value)return;const old=imageNamePreset(value.fileName||file.name),next=imageNamePreset(text),change:Partial<DestinationDraft>={fileName:text};if(!value.characterName||value.characterName===old.name)change.characterName=next.name;if(!value.lookName||value.lookName===old.lookName)change.lookName=next.lookName;onChange({...value,...change});};
  return <section className="fi-item" aria-label={'收纳设置 '+file.name}>
    {file.mediaKind==='photo'&&<img src={'/api'+INTAKE_API+'/handoffs/'+encoded(handoffId)+'/files/'+encoded(file.id)+'/preview'} width="160" height="100" alt={file.name}/>}
    <strong>{file.mediaKind==='photo'?<Image size={15}/>:file.mediaKind==='audio'?<Music size={15}/>:<Film size={15}/>} {file.name}</strong>
    {file.mediaKind==='audio'&&<label>素材类型<select aria-label={'素材类型 '+file.id} value={value?.kind||''} disabled={locked} onChange={e=>onChange({kind:e.target.value as MediaKind,scope:'library',directory:''})}><option value="" disabled>请选择音乐或音效</option><option value="music">音乐</option><option value="sfx">音效</option></select></label>}
    {value&&<>
      {['photo','video'].includes(value.kind)&&<label>收纳到<select aria-label={'收纳范围 '+file.id} disabled={locked} value={value.scope} onChange={e=>patch({scope:e.target.value as 'library'|'project',imageProposal:undefined})}><option value="library">{kindLabel[value.kind]} · 不属于任何项目</option><option value="project">添加到项目 · 保留原记录与引用</option></select></label>}
      {value.scope==='project'&&<label>项目<select aria-label={'目标项目 '+file.id} value={project} disabled={locked} onChange={e=>patch({projectId:e.target.value,folderId:'root',imageProposal:undefined})}><option value="">请选择项目</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
      {value.scope==='project'&&value.kind==='photo'?<>
        <div className="fi-target-fields"><label>人物名<input className="fi-button" aria-label={'人物名 '+file.id} value={name} disabled={locked} onChange={e=>patch({characterName:e.target.value,imageProposal:undefined})}/></label><label>造型名<input className="fi-button" aria-label={'造型名 '+file.id} value={look} disabled={locked} onChange={e=>patch({lookName:e.target.value,imageProposal:undefined})}/></label></div>
        {checking?<p role="status">正在核对人物和造型…</p>:proposal&&proposalRef.current===proposalKey?<p className="fi-muted">{proposal.newCharacter?'将新建人物：':'添加到现有人物：'}{proposal.characterName} · {proposal.newLook?'将新建造型：':'现有造型：'}{proposal.lookName}</p>:<p className="fi-muted">请填写人物和造型。缺少信息时也可改为收纳到摄影照片。</p>}
        <p className="fi-muted">确认收纳后正式保存关联；已有代表图保持不变。</p>
      </>:<>
        <label>{value.scope==='project'?'项目内文件夹':'分类'}<select aria-label={'目标分类 '+file.id} value={selected} disabled={locked||reading} onChange={e=>patch(value.scope==='project'?{folderId:e.target.value}:{directory:e.target.value})}>{reading?<option>正在读取…</option>:folders.map(f=><option key={f.id} value={f.id}>{f.relativePath||f.name}</option>)}</select></label>
        {value.scope==='library'&&<details><summary>新建分类文件夹</summary><div className="fi-actions"><input className="fi-button" aria-label={'新分类名称 '+file.id} value={newFolder} disabled={locked||creating} onChange={e=>setNewFolder(e.target.value)}/><button disabled={locked||creating||!newFolder.trim()} onClick={()=>void createFolder()}>{creating?'正在创建…':'创建分类'}</button></div><small>在当前分类下创建真实文件夹，最多两级；根目录表示待确认。</small></details>}
      </>}
      <details><summary>修改导入后的文件名</summary><label>副本名称（保留扩展名）<input className="fi-button" aria-label={'副本名称 '+file.id} value={value.fileName||file.name} disabled={locked} onChange={e=>updateFilename(e.target.value)}/></label><small>只影响导入副本；修改名称会更新尚未手动修改的人物、造型建议。</small></details>
    </>}
    {error&&<p className="fi-error" role="alert">{error}<button disabled={locked} onClick={()=>setRefresh(n=>n+1)}><RefreshCw size={13}/>重新读取</button></p>}
  </section>;
}

export function submittedDestination(v:DestinationDraft):IntakeDestination {
  if(v.scope==='library')return {kind:v.kind,scope:'library',directory:v.directory||'',...(v.fileName?{fileName:v.fileName}:{})};
  if(v.kind==='video')return {kind:'video',scope:'project',projectId:v.projectId,folderId:v.folderId||'root',...(v.fileName?{fileName:v.fileName}:{})};
  return {kind:'photo',scope:'project',projectId:v.projectId,...(v.fileName?{fileName:v.fileName}:{}),imageProposal:v.imageProposal};
}
