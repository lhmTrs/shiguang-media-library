import {useEffect, useRef, useState} from 'react';
import {AlertCircle, ArrowRight, CheckCircle2, Copy, Film, FolderInput, RefreshCw, Trash2, X} from 'lucide-react';
import {GlobalFeedback, notifyFeedback, useFeedbackToast} from '../global-feedback';
import {applyTheme, readTheme} from '../theme';
import '../themes.css';
import {BatchDetails} from './BatchDetails';
import {intakeSession} from './session';
import {TargetEditor,initialDestination,submittedDestination,type DestinationDraft} from './TargetEditor';
import {INTAKE_API, bytes, encoded, errorMessage, knownRefusal, sameTarget, type ConfirmInput, type Handoff, type IntakeBatch, type IntakeRequest} from './types';
import './file-intake.css';

function readAttempt(id: string): ConfirmInput | null {
  try {const v = JSON.parse(sessionStorage.getItem('shiguang.file-intake.' + id) || 'null'); return v && typeof v.requestId === 'string' && ['copy', 'move'].includes(v.mode) && Array.isArray(v.fileIds) && v.fileIds.every((f: unknown) => typeof f === 'string') && (v.version===2&&Array.isArray(v.targets)||typeof v.projectId==='string'&&typeof v.folderId==='string') ? v : null;} catch {return null;}
}

/** Standalone native/browser confirmation entry. It never boots the full App. */
export function FileIntakeWindow({handoffId}: {handoffId: string}) {
  const [api, setApi] = useState<IntakeRequest | null>(null), [handoff, setHandoff] = useState<Handoff | null>(null);
  const [selected, setSelected] = useState<string[]>([]), [mode, setMode] = useState<'copy' | 'move'>('copy');
  const [destinations,setDestinations]=useState<Record<string,DestinationDraft|null>>({}),[readyTargets,setReadyTargets]=useState<Record<string,boolean>>({}),[commonProject,setCommonProject]=useState(''),[replaceEdited,setReplaceEdited]=useState(false);
  const edited=useRef(new Set<string>());
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [unknown, setUnknown] = useState(false), [batch, setBatch] = useState<IntakeBatch | null>(null), [reload, setReload] = useState(0);
  const [receiptKind, setReceiptKind] = useState<'submitted' | 'existing' | 'other'>('existing');
  const alive = useRef(true), sending = useRef(false), initialized = useRef(''), attempt = useRef<ConfirmInput | null>(null), accepted = useRef('');
  useFeedbackToast(error, {source: '素材收纳'});
  useEffect(() => {applyTheme(readTheme()); alive.current = true; return () => {alive.current = false;};}, []);
  const remember = (value: ConfirmInput | null) => {attempt.current = value; try {if (value) sessionStorage.setItem('shiguang.file-intake.' + handoffId, JSON.stringify(value)); else sessionStorage.removeItem('shiguang.file-intake.' + handoffId);} catch { /* Handoff binding remains authoritative if browser storage is unavailable. */ }};
  function accept(value: IntakeBatch) {
    if (!value?.id || !Array.isArray(value.items)) throw Error('收纳回执格式不符，请核对原请求');
    const submitted = attempt.current;
    if (submitted && !sameTarget(value, submitted)) {
      setBatch(value); setReceiptKind('other'); setUnknown(false);
      setError('该选择已由另一窗口接收。以下为原批次，本窗口请求未获匹配回执；没有重复提交。');
      return;
    }
    setReceiptKind(submitted ? 'submitted' : 'existing');
    setBatch(value); setUnknown(false); remember(null);
    if (submitted && accepted.current !== value.id) {
      accepted.current = value.id; notifyFeedback({kind: 'success', source: '素材收纳', message: '收纳任务已接收，可在拾光顶栏“文件任务”查看真实进度。'});
      const bridge = (window as Window & {webkit?: {messageHandlers?: {intake?: {postMessage: (message: string) => void}}}}).webkit?.messageHandlers?.intake;
      try {bridge?.postMessage('accepted');} catch { /* Accepted receipt stays visible in ordinary browsers. */ }
    }
  }
  useEffect(() => {
    let current = true; const controller = new AbortController(); setLoading(true); setError('');
    void (async () => {
      if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(handoffId)) throw Error('收纳确认编号无效，请从访达重新打开本次选择');
      const request = await intakeSession(controller.signal), value = await request<Handoff>(INTAKE_API + '/handoffs/' + encoded(handoffId), undefined, undefined, {signal: controller.signal});
      if (!current) return;
      if (value.id !== handoffId) throw Error('收纳选择身份不符，请核对原窗口');
      setApi(() => request); setHandoff(value);
      const saved = readAttempt(handoffId); attempt.current = saved;
      // Freeze the original attempt before awaiting a possibly lost batch read.
      setUnknown(!!saved || !!value.batchId);
      if (initialized.current !== handoffId) {
        initialized.current = handoffId; setSelected(saved?.fileIds || value.files.map(f => f.id)); setMode(saved?.mode || 'copy');
        setDestinations(Object.fromEntries(value.files.map(f=>[f.id,saved?(saved.version===2?saved.targets.find(t=>t.fileId===f.id)?.destination||null:{kind:'video' as const,scope:'project' as const,projectId:saved.projectId,folderId:saved.folderId}):initialDestination(f,value.preferences||{})])));
      }
      if (value.batchId) {const receipt = await request<IntakeBatch>(INTAKE_API + '/batches/' + encoded(value.batchId), undefined, undefined, {signal: controller.signal}); if (current) accept(receipt);}
      else if (saved) {setUnknown(true); setError('原提交结果尚未确认。请核对原请求，不会再次发送。');}
    })().catch(e => {if (current && !controller.signal.aborted) setError(errorMessage(e));}).finally(() => {if (current) setLoading(false);});
    return () => {current = false; controller.abort();};
  }, [handoffId, reload]);
  useEffect(() => {
    if(!api||handoff?.preparation!=='checking'||batch)return;
    let current=true,timer:ReturnType<typeof setTimeout>;const controller=new AbortController();
    const tick=async()=>{
      try {
        const value=await api<Handoff>(INTAKE_API+'/handoffs/'+encoded(handoffId),undefined,undefined,{signal:controller.signal});
        if(!current)return;
        if(value.id!==handoffId)throw Error('返回了其他收纳选择，请重新打开原窗口');
        setHandoff(value);
        if(value.preparation==='checking')timer=setTimeout(tick,1000);
      }catch(e){if(current&&!controller.signal.aborted){setError(errorMessage(e));timer=setTimeout(tick,2000);}}
    };
    timer=setTimeout(tick,1000);
    return()=>{current=false;clearTimeout(timer);controller.abort();};
  }, [api,handoff?.preparation,handoffId,batch?.id]);

  async function reconcile() {
    if (!api || sending.current) return; sending.current = true; setBusy(true); setError('');
    try {
      const value = await api<Handoff>(INTAKE_API + '/handoffs/' + encoded(handoffId));
      if (value.id !== handoffId) throw Error('返回了其他收纳选择，原请求保留');
      if (value.batchId) {const receipt = await api<IntakeBatch>(INTAKE_API + '/batches/' + encoded(value.batchId)); if (alive.current) accept(receipt);}
      else if (alive.current) {setUnknown(true); setError('尚未取得权威批次回执，原请求仍待核对；没有重新提交。');}
    } catch (e) {if (alive.current) {setUnknown(true); setError(errorMessage(e));}}
    finally {sending.current = false; if (alive.current) setBusy(false);}
  }
  async function confirm() {
    if (!api || !handoff || handoff.preparation!=='ready'||sending.current || attempt.current || unknown || handoff.batchId || batch || !selected.length || selected.some(id=>!destinations[id]||!readyTargets[id]) || mode === 'move' && !handoff.canTrash) return;
    const input: ConfirmInput = {version:2,requestId:crypto.randomUUID(),mode,fileIds:[...selected],targets:selected.map(fileId=>({fileId,destination:submittedDestination(destinations[fileId]!)}))};
    sending.current = true; remember(input); setBusy(true); setError('');
    try {const value = await api<IntakeBatch>(INTAKE_API + '/handoffs/' + encoded(handoffId) + '/confirm', input); if (alive.current) accept(value);}
    catch (e) {if (alive.current) {if (knownRefusal(e, input.requestId)) remember(null); else setUnknown(true); setError(errorMessage(e) + (knownRefusal(e, input.requestId) ? '。选择已保留。' : '。原结果未确认，请只读核对，不会自动重发。'));}}
    finally {sending.current = false; if (alive.current) setBusy(false);}
  }
  const files = handoff?.files.filter(f => selected.includes(f.id)) || [], locked = loading || busy || unknown || !!batch || !!attempt.current || !!handoff?.batchId;
  return <main className="fi-root fi-window"><section className="fi-confirm" aria-label="收纳素材到拾光" aria-busy={loading || busy}>
    <header className="fi-heading"><FolderInput size={23}/><div><h1>收纳素材到拾光</h1><p>{batch ? receiptKind === 'submitted' ? '任务已接收，后台继续处理' : receiptKind === 'other' ? '另一窗口已接收此选择' : '查看既有任务，没有新建任务' : '选择目标，一次确认，后台收纳'}</p></div></header>
    {loading && <p role="status" className="fi-muted">正在读取本次访达选择…</p>}
    {!loading && !handoff && <div className="fi-empty"><AlertCircle size={24}/><p>尚未读取到本次收纳选择。请先启动拾光，再重试读取。</p><button onClick={() => setReload(n => n + 1)}><RefreshCw size={14}/>启动拾光后重新读取</button></div>}
    {handoff?.batchId&&!batch&&!attempt.current&&<p className="fi-muted" role="status">正在核对既有收纳任务，原目标以任务回执为准；不会重新提交。</p>}
    {handoff && !batch && !(handoff.batchId&&!attempt.current) && <>
      <div className="fi-selection-summary"><strong>{files.length} 个文件</strong><span>{bytes(files.reduce((sum, f) => sum + f.bytes, 0))}</span></div>
      {handoff.preparation==='checking'&&<p className="fi-muted" role="status">正在后台核验原文件，可先选择项目和文件夹；完成后即可确认收纳。</p>}
      {handoff.preparation==='failed'&&<p className="fi-error" role="alert">{handoff.preparationError}</p>}
      <ul className="fi-selection">{handoff.files.map(file => <li key={file.id} className={!selected.includes(file.id) ? 'fi-removed' : ''}><Film size={17}/><div><strong title={file.name}>{file.name}</strong><small title={file.path}>{file.path}</small></div><span>{bytes(file.bytes)}</span><button disabled={locked} aria-label={(selected.includes(file.id) ? '移除 ' : '恢复 ') + file.name} onClick={() => setSelected(old => old.includes(file.id) ? old.filter(id => id !== file.id) : [...old, file.id])}>{selected.includes(file.id) ? <X size={14}/> : '恢复'}</button></li>)}</ul>
      {!files.length && <p className="fi-muted">请选择至少一个文件；可恢复上方已移除项。</p>}
      {api&&<>
        {handoff.files.filter(f=>selected.includes(f.id)&&f.mediaKind!=='audio').length>1&&<details><summary>批量设置项目（默认保留逐项修改）</summary><div className="fi-target-fields"><label>项目<select aria-label="批量目标项目" value={commonProject} disabled={locked} onChange={e=>setCommonProject(e.target.value)}><option value="">请选择项目</option>{handoff.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><button disabled={locked||!commonProject} onClick={()=>setDestinations(old=>Object.fromEntries(Object.entries(old).map(([id,d])=>[id,d&&selected.includes(id)&&['photo','video'].includes(d.kind)&&(replaceEdited||!edited.current.has(id))?{...d,scope:'project',projectId:commonProject,folderId:'root',imageProposal:undefined}:d])))}>应用到未单独修改项</button></div><label className="fi-check"><input type="checkbox" disabled={locked} checked={replaceEdited} onChange={e=>setReplaceEdited(e.target.checked)}/>同时覆盖已单独修改的目标</label></details>}
        {handoff.files.filter(f=>selected.includes(f.id)).map(file=><TargetEditor key={file.id} file={file} handoffId={handoffId} api={api} projects={handoff.projects} value={destinations[file.id]||null} locked={locked} previewReady={handoff.preparation!=='checking'&&handoff.preparation!=='failed'} onChange={(v,manual=true)=>{if(manual)edited.current.add(file.id);setDestinations(old=>({...old,[file.id]:!old[file.id]&&file.mediaKind==='audio'?{...v,...handoff.preferences?.[v.kind],kind:v.kind}:v}));}} onReady={v=>setReadyTargets(old=>old[file.id]===v?old:{...old,[file.id]:v})}/>)}
      </>}
      <fieldset className="fi-modes" disabled={locked}><legend>原文件处理方式</legend><label><input type="radio" name="intake-mode" checked={mode === 'copy'} onChange={() => setMode('copy')}/><Copy size={16}/><span><strong>复制并保留原文件</strong><small>默认方式，原位置不变</small></span></label><label><input type="radio" name="intake-mode" checked={mode === 'move'} disabled={!handoff.canTrash} onChange={() => setMode('move')}/><Trash2 size={16}/><span><strong>移动到素材库</strong><small>{handoff.canTrash ? '完整核验并登记成功后，原件移入废纸篓' : '当前系统不支持安全移入废纸篓'}</small></span></label></fieldset>
      <p className="fi-muted">确认后逐项固定收纳目标和处理方式；关闭窗口或切换项目不影响后台任务。</p>
    </>}
    {batch && <><p className={receiptKind === 'submitted' ? 'fi-accepted' : receiptKind === 'other' ? 'fi-warning-copy' : 'fi-muted'} role="status">{receiptKind === 'submitted' && <CheckCircle2 size={18}/>} {receiptKind === 'submitted' ? '任务已接收，请在网页顶栏“文件任务”查看后续进度。' : receiptKind === 'other' ? '此选择已由另一窗口接收，以下为原批次；本窗口未确认成功。' : '这是此选择的既有回执，没有新建任务。'}</p><BatchDetails batch={batch}/></>}
    {error && <p className="fi-error" role="alert">{error}</p>}
    {unknown && <p className="fi-muted">原请求编号：<code>{attempt.current?.requestId || '由本次访达选择核对'}</code></p>}
    {receiptKind === 'other' && attempt.current && <p className="fi-muted">本窗口原请求编号：<code>{attempt.current.requestId}</code></p>}
    <footer className="fi-actions fi-footer"><a className="fi-button" href="/#/project-videos" target="_blank" rel="noopener noreferrer">打开拾光 · 文件任务<ArrowRight size={14}/></a>{unknown ? <button className="fi-primary" disabled={busy || !api} onClick={() => void reconcile()}>{busy ? '正在核对…' : '核对原提交结果'}</button> : !batch && <button className="fi-primary" disabled={loading || busy || handoff?.preparation==='checking'||handoff?.preparation==='failed'||!api || !files.length || selected.some(id=>!destinations[id]||!readyTargets[id]) || mode === 'move' && !handoff?.canTrash} onClick={() => void confirm()}>{busy ? '正在提交，请勿重复点击…' : '确认收纳'}</button>}</footer>
  </section><GlobalFeedback/></main>;
}
