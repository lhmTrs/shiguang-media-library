import {useState} from 'react';
import {AlertTriangle, Check, ExternalLink, Film, FolderOpen} from 'lucide-react';
import {batchLabel, bytes, itemLabel, type IntakeBatch, type IntakeItem, type IntakeView, type ResolveInput} from './types';

export function Destination({batch}: {batch: IntakeBatch}) {
  return <div className="fi-destination"><FolderOpen size={16}/><div><strong>{batch.projectName}</strong><span>{batch.folderName || '根目录'} · {batch.mode === 'copy' ? '复制并保留原文件' : '校验并登记成功后移入废纸篓'}</span></div><small>固定目标</small></div>;
}

function previewUrl(value: string) {
  try {const url = new URL(value, location.href); return url.origin === location.origin && ['http:', 'https:'].includes(url.protocol) ? value : '';} catch {return '';}
}
function Conflict({item, disabled, resolve, prompt}: {item: IntakeItem; disabled: boolean; resolve: (input: ResolveInput) => void; prompt?: boolean}) {
  const [candidateId, setCandidateId] = useState(item.candidates?.[0]?.id || ''), [apply, setApply] = useState(false), [overwrite, setOverwrite] = useState(false), [confirmed, setConfirmed] = useState(false);
  const candidate = item.candidates?.find(c => c.id === candidateId), shots = candidate?.adoptedShots || [], media = previewUrl(candidate?.mediaUrl || '');
  return <div className="fi-conflict">
    {!!item.candidates?.length && <label>已有文件<select aria-label={'重名候选 ' + item.name} disabled={disabled} value={candidateId} onChange={e => {setCandidateId(e.target.value); setOverwrite(false); setConfirmed(false);}}>{item.candidates.map(c => <option key={c.id} value={c.id}>{c.name} · {c.reason}</option>)}</select></label>}
    {candidate && <p className="fi-muted">{shots.length ? `已采用：${shots.map(s => '镜 ' + s.number).join('、')}` : '该候选尚未被分镜采用'} {media && <a href={media} target="_blank" rel="noopener noreferrer">预览原文件 <ExternalLink size={12}/></a>}</p>}
    <label className="fi-check"><input type="checkbox" checked={apply} disabled={disabled || overwrite} onChange={e => setApply(e.target.checked)}/>将改名导入或复用的选择应用到后续重名项</label>
    <div className="fi-actions">
      <button className="fi-primary" disabled={disabled} onClick={() => resolve({choice: 'import', ...(apply ? {applyRemaining: true} : {})})}>改名导入</button>
      <button disabled={disabled || !candidate} onClick={() => resolve({choice: 'reuse', candidateId, ...(apply ? {applyRemaining: true} : {})})}>复用已有文件</button>
      {(!item.destination||item.destination.scope==='project'&&item.destination.kind==='video')&&<button className="fi-danger-link" disabled={disabled || !candidate} aria-expanded={overwrite} onClick={() => {setOverwrite(v => !v); setConfirmed(false);}}>覆盖…</button>}
      <button disabled={disabled} onClick={() => resolve({choice: 'cancel'})}>取消此项</button>
    </div>
    {prompt && <p className="fi-muted">选「复用已有文件」时，这次附的提示词不会替换那个视频原来的提示词。</p>}
    {overwrite && candidate && <section className="fi-warning" aria-label={'覆盖影响确认 ' + item.name}>
      <strong><AlertTriangle size={15}/>覆盖「{candidate.name}」</strong>
      <p>{shots.length ? '将解除以下镜号对目标视频的采用：' + shots.map(s => '镜 ' + s.number).join('、') : '没有受影响镜号。'} 覆盖不应用到后续项。</p>
      {shots.length > 0 && !item.adoptionStamp && <p role="alert">缺少采用核验回执，请刷新原任务后再确认。</p>}
      <label className="fi-check"><input type="checkbox" checked={confirmed} disabled={disabled} onChange={e => setConfirmed(e.target.checked)}/>我已核对上述视频和受影响镜号，确认覆盖</label>
      <div className="fi-actions"><button className="fi-danger" disabled={disabled || !confirmed || shots.length > 0 && !item.adoptionStamp} onClick={() => resolve({choice: 'overwrite', candidateId, confirmUnbind: true, ...(item.adoptionStamp ? {adoptionStamp: item.adoptionStamp} : {})})}>确认覆盖</button><button disabled={disabled} onClick={() => {setOverwrite(false); setConfirmed(false);}}>返回选择</button></div>
    </section>}
  </div>;
}

export function BatchDetails({batch, busy = false, uncertain = false, resolve, retry, reconcile, onView}: {
  batch: IntakeBatch; busy?: boolean; uncertain?: boolean; resolve?: (item: IntakeItem, input: ResolveInput) => void;
  retry?: (item: IntakeItem) => void; reconcile?: () => void; onView?: IntakeView;
}) {
  const needsSelection = (item: IntakeItem) => item.status === 'failed' && ['INTAKE_SOURCE_CHANGED', 'INTAKE_SOURCE_UNBOUND'].includes(item.code || '');
  return <section className={'fi-batch' + (batch.acknowledged ? ' fi-batch-acknowledged' : '')} aria-label={'收纳批次 ' + batch.projectName}>
    <div className="fi-batch-title"><strong>{batch.acknowledged ? '已处理 · 原结果：' : ''}{batchLabel[batch.status]}</strong><span>{batch.items.length} 个文件</span></div>
    <Destination batch={batch}/>
    {!batch.acknowledged && batch.items.some(needsSelection) && <p className="fi-warning-copy">部分文件需要从访达重新选择，不能直接重试。请右键“收纳素材到拾光”重新收纳；旧失败记录保留，原件不会自动移除。</p>}
    {uncertain && <p className="fi-error" role="alert">操作响应未确认，已保留原任务。请核对原回执；不会重复复制或删除。</p>}
    {(uncertain || batch.status === 'interrupted' || batch.items.some(i => i.status === 'unknown')) && reconcile && <button disabled={busy} onClick={reconcile}>核对原回执</button>}
    <ul className="fi-items">{batch.items.map(item => {
      const complete = ['ready', 'source_retained', 'managed'].includes(item.status), viewProject = item.status === 'managed' ? item.managedProjectId || '' : item.destination ? item.destination.scope==='project'&&item.destination.kind==='video'?item.destination.projectId||'':'' : batch.projectId, viewId = item.status === 'managed' && !item.managedProjectId ? item.assetId : item.videoId||item.assetId, viewable = !!viewProject || !!viewId;
      const conflictKey = item.id + ':' + (item.adoptionStamp || '') + ':' + JSON.stringify(item.candidates?.map(c => [c.id, c.adoptedShots]));
      return <li key={item.id} className={'fi-item fi-item-' + item.status}>
        <div className="fi-item-heading">{complete ? <Check size={17}/> : <Film size={17}/>}<strong title={item.name}>{item.name}</strong><span className="fi-status">{needsSelection(item) ? '需要重新选择' : itemLabel[item.status]}</span></div>
        {item.status === 'copying' ? <div className="fi-progress"><progress aria-label={'复制进度 ' + item.name} max={Math.max(1, item.bytes)} value={Math.max(0, Math.min(item.bytes, item.copiedBytes))}/><small>已读入 {bytes(item.copiedBytes)} / {bytes(item.bytes)} · 完整核验与登记后才完成</small></div> : <small>{bytes(item.bytes)}{item.status === 'ready' && batch.mode === 'move' ? ' · 原件已入废纸篓' : item.status === 'ready' && batch.mode === 'copy' ? ' · 原文件已保留' : ''}</small>}
        {item.destinationLabel&&<p className="fi-muted">固定目标：{item.destinationLabel}</p>}
        {item.status === 'source_retained' && <p className="fi-warning-copy">目标已登记，原文件未移除。不会重复复制。</p>}
        {item.status === 'managed' && <p className="fi-muted">保留原标签与关联 · {item.managedProjectName || (item.managedProjectId ? '原所属项目' : '全局素材库')}{item.managedProjectId ? '，可进入项目视频使用原移动入口。' : '，可进入素材查找查看。'}</p>}
        {(item.error || item.code) && <p className={batch.acknowledged ? 'fi-muted' : 'fi-error'} role={batch.acknowledged ? undefined : 'alert'}>{item.code && item.code + ' · '}{item.error}</p>}
        {item.status === 'duplicate' && resolve && <Conflict key={conflictKey} item={item} disabled={busy || uncertain} prompt={!!batch.prompt?.text} resolve={input => resolve(item, input)}/>}
        <div className="fi-actions">{item.status === 'failed' && !needsSelection(item) && !batch.acknowledged && retry && <button disabled={busy || uncertain} onClick={() => retry(item)}>重试此失败项</button>}{complete && onView && <button disabled={!viewable} title={!viewable ? '原所属项目尚未返回，请刷新核对' : ''} onClick={() => viewable && void onView(viewProject, viewId)}><FolderOpen size={14}/>{item.status === 'managed' ? item.managedProjectId ? '查看 / 移动已有文件' : '查看已有素材' : item.destination?.kind==='photo'&&item.destination.scope==='project'?'查看已绑定图片':viewProject?'查看项目视频':'查看素材'}</button>}</div>
      </li>;
    })}</ul>
    <details className="fi-receipt"><summary>原批次编号</summary><code>{batch.id}</code></details>
  </section>;
}
