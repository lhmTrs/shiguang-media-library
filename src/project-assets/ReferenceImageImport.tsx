import {useFeedbackToast} from '../global-feedback';
import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {ImagePlus,LoaderCircle,X,UploadCloud,FolderOpen,ChevronRight} from 'lucide-react';

export type ImageImportTarget={assetId:string;projectId:string;lookId:string|null};
type Receipt={id:string;status:string;target:ImageImportTarget;fileName:string;mediaAssetId?:string;error?:string;candidates:{id:string;name:string;reason:string;previewUrl:string}[]};
type ImportContext={projectName:string;assetName:string;lookName:string;revision:number;kind:'character'|'scene'|'prop';available:boolean};
type PendingDrop={file:File;preview:string;target:ImageImportTarget;context:ImportContext;key:string};
type Props={target:ImageImportTarget;context:ImportContext;disabled:boolean;libraryAction?:React.ReactNode;request:<T=any>(path:string,body?:unknown,method?:string)=>Promise<T>;onReady:(r:Receipt)=>void;onBusy:(busy:boolean,owner:string)=>void};
export function ReferencePreview({src,alt='',className,style}:{src:string;alt?:string;className?:string;style?:React.CSSProperties}){
  const [failed,setFailed]=useState(false);useEffect(()=>setFailed(false),[src]);
  return failed?<span className="ca-preview-unavailable">此格式暂不能预览<br/>可在访达中打开原图</span>:<img src={src} alt={alt} className={className} style={style} onError={()=>setFailed(true)}/>;
}
export function ReferenceImageImport({target,context,disabled,libraryAction,request,onReady,onBusy}:Props){
  const input=useRef<HTMLInputElement>(null),alive=useRef(true),running=useRef(false),savedFile=useRef<File|null>(null),owner=useRef(crypto.randomUUID());
  const busyCallback=useRef(onBusy);busyCallback.current=onBusy;
  const dialog=useRef<HTMLDialogElement>(null),dragDepth=useRef(0);
  const [pending,setPendingState]=useState<PendingDrop|null>(null),[hover,setHover]=useState(false),pendingRef=useRef<PendingDrop|null>(null);
  const setPending=(value:PendingDrop|null)=>{pendingRef.current=value;setPendingState(value);};
  const contextKey=JSON.stringify({target,context}),latest=useRef({key:contextKey,available:context.available});latest.current={key:contextKey,available:context.available};
  const [receipt,setReceipt]=useState<Receipt|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[candidate,setCandidate]=useState('');
  useFeedbackToast(error, {source: '项目资产'});
  const readyRef=useRef(onReady);readyRef.current=onReady;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;busyCallback.current(false,owner.current);};},[]);
  const consume=(r:Receipt)=>{if(!alive.current)return;setReceipt(r);if(r.status==='ready'){readyRef.current(r);savedFile.current=null;setReceipt(null);}else if(r.status==='cancelled'){setReceipt(null);savedFile.current=null;}else if(r.status==='failed')setError(r.error||'导入未完成，请重新选择原图');else if(r.status==='duplicate')setCandidate(r.candidates[0]?.id||'');};
  async function run(fn:()=>Promise<void>){if(running.current)return;if(disabled){setError('当前资料正在处理，请完成后再继续');return;}running.current=true;setBusy(true);busyCallback.current(true,owner.current);setError('');try{await fn();}catch(e:any){if(alive.current)setError(e.message||'图片导入未完成；请核对结果，文件不会自动重发');}finally{running.current=false;busyCallback.current(false,owner.current);if(alive.current)setBusy(false);}}
  async function upload(file:File,frozen:ImageImportTarget){const id=crypto.randomUUID();
    const r=await request<Receipt>('/project-assets/image-imports',{requestId:id,...frozen,fileName:file.name,bytes:file.size});
    if(alive.current)setReceipt(r);
    consume(await request<Receipt>('/project-assets/image-imports/'+id+'/content',file,'PUT'));
  }
  async function select(file:File){if(disabled||running.current||receipt||pending||!context.available){setError('请等当前操作完成后重新选择图片');return;}savedFile.current=file;const frozen={...target};await run(()=>upload(file,frozen));}
  const fileDrag=(e:DragEvent|React.DragEvent)=>Array.from(e.dataTransfer?.types||[]).includes('Files');
  // Only prevent the browser's file-navigation default. Other components retain their own handlers.
  useEffect(()=>{
    if(!context.available)return;
    const prevent=(e:DragEvent)=>{if(fileDrag(e)){e.preventDefault();if(e.type==='drop'){dragDepth.current=0;setHover(false);}}};
    const reset=()=>{dragDepth.current=0;setHover(false);};
    window.addEventListener('dragover',prevent);window.addEventListener('drop',prevent);window.addEventListener('dragend',reset);
    return()=>{window.removeEventListener('dragover',prevent);window.removeEventListener('drop',prevent);window.removeEventListener('dragend',reset);};
  },[context.available]);
  useEffect(()=>{if(disabled||!context.available){dragDepth.current=0;setHover(false);}},[disabled,context.available]);
  useEffect(()=>{if(pending&&pending.key!==contextKey){setPending(null);setError('目标资料已变化，请核对后重新拖入图片');}},[contextKey,pending]);
  useEffect(()=>{if(!pending)return;return()=>URL.revokeObjectURL(pending.preview);},[pending]);
  useEffect(()=>{
    if(!pending||!dialog.current)return;
    const panel=dialog.current,previous=document.activeElement as HTMLElement|null;
    panel.showModal();
    return()=>{panel.close();if(previous?.isConnected)previous.focus({preventScroll:true});};
  },[!!pending]);
  function drop(e:React.DragEvent){
    e.preventDefault();e.stopPropagation();dragDepth.current=0;setHover(false);
    if(disabled||running.current||receipt||pending||!context.available){setError('请先完成当前操作，再拖入图片');return;}
    const files=Array.from(e.dataTransfer.files);
    if(files.length!==1){setError(files.length?'一次只能导入一张图片，请重新拖入':'请拖入本地图片文件；网页链接暂不支持');return;}
    if(Array.from(e.dataTransfer.items).some(item=>item.webkitGetAsEntry?.()?.isDirectory)){setError('请拖入一张图片文件，暂不支持文件夹');return;}
    if(typeof HTMLDialogElement==='undefined'||typeof HTMLDialogElement.prototype.showModal!=='function'){setError('当前浏览器不支持拖放确认窗口，请使用“导入参考图片”按钮');return;}
    const file=files[0];setError('');setPending({file,preview:URL.createObjectURL(file),target:{...target},context:{...context},key:contextKey});
  }
  async function confirmDrop(){
    const selected=pending;if(!selected)return;
    await run(async()=>{
      const check=()=>{if(!alive.current||pendingRef.current!==selected||!latest.current.available||latest.current.key!==selected.key)throw Error('目标资料已变化，请取消后重新拖入图片');};check();
      const a=await request<{id:string;project_id:string;revision:number;kind:string;archived_at:number;looks:{id:string;archived_at:number|null}[]}>('/project-assets/assets/'+selected.target.assetId);
      check();const look=a.looks.find(l=>l.id===selected.target.lookId);
      if(a.id!==selected.target.assetId||a.project_id!==selected.target.projectId||a.revision!==selected.context.revision||a.kind!==selected.context.kind||a.archived_at||look?.archived_at)throw Error('原资料已更新或归档，请取消后重新读取再导入');
      setPending(null);savedFile.current=selected.file;await upload(selected.file,selected.target);
    });
  }
  const duplicate=receipt?.status==='duplicate';
  const blocked=disabled||busy||!!receipt||!!pending||!context.available;
  return <div className="ca-reference-import">
    <input hidden disabled={blocked} ref={input} type="file" aria-label="选择一张参考图片" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void select(file);}}/>
    <div className={'ca-reference-drop'+(hover?' is-dragging':'')+(blocked?' is-disabled':'')} role="region" aria-label="参考图片拖放区" aria-disabled={blocked}
      onDragEnter={e=>{if(fileDrag(e)){e.preventDefault();dragDepth.current++;if(!blocked)setHover(true);}}}
      onDragOver={e=>{e.preventDefault();e.dataTransfer.dropEffect=blocked?'none':'copy';}}
      onDragLeave={()=>{dragDepth.current=Math.max(0,dragDepth.current-1);if(!dragDepth.current)setHover(false);}} onDrop={drop}>
      <span className="ca-reference-drop-icon" aria-hidden="true"><ImagePlus size={23}/></span>
      <div className="ca-reference-drop-label"><strong>{hover?'松手后预览并确认':'拖入一张参考图片'}</strong><span>三视图、独立视图或照片，松手后先预览确认。</span></div>
      <div className="ca-reference-drop-actions"><button type="button" className="ca-primary" disabled={blocked} onClick={()=>input.current?.click()}><UploadCloud size={16}/>{busy?'正在导入图片…':'导入参考图片'}</button>{libraryAction}</div>
      <div className="ca-reference-destination"><FolderOpen size={14} aria-hidden="true"/><span className="ca-reference-destination-label">导入到</span><span className="ca-reference-destination-path" title={context.projectName+' / '+context.assetName+(context.lookName?' / '+context.lookName:'')}><span>{context.projectName}</span><ChevronRight size={12} aria-hidden="true"/><span>{context.assetName}</span>{context.lookName&&<><ChevronRight size={12} aria-hidden="true"/><span>{context.lookName}</span></>}</span><small>关联需点击“保存”</small></div>
    </div>
    {busy&&<span className="ca-import-progress" role="status"><LoaderCircle size={15} className="ca-import-spinner"/>正在接收并检查原图，请稍候</span>}
    {error&&<div className="ca-import-error" role="alert">{error}{receipt&&<button type="button" disabled={busy} onClick={()=>void run(async()=>consume(await request<Receipt>('/project-assets/image-imports/'+receipt.id)))}>核对导入结果</button>}<button type="button" disabled={busy} onClick={()=>{setReceipt(null);setError('');savedFile.current=null;}}>关闭提示</button></div>}
    {pending&&createPortal(<dialog ref={dialog} className="ca-modal ca-reference-dialog" aria-label="确认导入参考图片" onKeyDown={e=>{if(e.key!=='Tab')return;const nodes=Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')).filter(n=>n.getClientRects().length);const first=nodes[0],last=nodes.at(-1);if(!first){e.preventDefault();return;}if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}} onCancel={e=>{e.preventDefault();if(!busy)setPending(null);}} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();e.stopPropagation();setError('请先处理当前图片，再拖入其他图片');}}>
      <header><h2>确认导入参考图片</h2><button type="button" aria-label="取消导入确认" disabled={busy} autoFocus onClick={()=>setPending(null)}><X size={18}/></button></header>
      <div className="ca-reference-confirm-body"><div className="ca-reference-confirm-preview"><ReferencePreview src={pending.preview} alt={pending.file.name}/></div><dl><dt>图片文件</dt><dd>{pending.file.name}</dd><dt>项目</dt><dd>{pending.context.projectName}</dd><dt>{pending.context.kind==='character'?'人物':'资产'}</dt><dd>{pending.context.assetName}</dd>{pending.context.lookName&&<><dt>造型</dt><dd>{pending.context.lookName}</dd></>}</dl><p>确认后复制到该项目的 picture 文件夹，关联仍需点击下方“保存”。</p>{error&&<div role="alert">{error}</div>}</div>
      <footer><button type="button" disabled={busy} onClick={()=>setPending(null)}>取消</button><button type="button" className="primary" disabled={busy||!context.available||contextKey!==pending.key} onClick={()=>void confirmDrop()}>{busy?'正在检查目标…':'确认导入'}</button></footer>
    </dialog>,document.body)}
    {duplicate&&createPortal(<div className="ca-modal-backdrop"><div className="ca-modal ca-reference-duplicate" role="dialog" aria-modal="true" aria-label="图片已存在"><header><h2>该图片已存在</h2><button disabled={busy} aria-label="取消本次导入" onClick={()=>void run(async()=>consume(await request<Receipt>('/project-assets/image-imports/'+receipt.id+'/cancel',{})))}><X size={18}/></button></header><p>发现同名或相同内容的图片。选择已有原图，或保留另一份重命名副本。</p><div className="ca-duplicate-options">{receipt.candidates.map(c=><label key={c.id}><input type="radio" name="reference-duplicate" disabled={busy} checked={candidate===c.id} onChange={()=>setCandidate(c.id)}/><div className="ca-duplicate-preview"><ReferencePreview src={c.previewUrl} alt={c.name}/></div><strong>{c.name}</strong><small>{c.reason}</small></label>)}</div>{error&&<p role="alert">{error}</p>}<footer><button disabled={busy||!candidate} onClick={()=>void run(async()=>consume(await request<Receipt>('/project-assets/image-imports/'+receipt.id+'/resolve',{choice:'reuse',candidateId:candidate})))}>使用原图</button><button className="primary" disabled={busy} onClick={()=>void run(async()=>consume(await request<Receipt>('/project-assets/image-imports/'+receipt.id+'/resolve',{choice:'import'})))}>继续导入（重命名）</button></footer></div></div>,document.body)}
  </div>;
}
