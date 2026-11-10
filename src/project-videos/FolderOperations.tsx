import React, {useEffect, useRef, useState} from 'react';
import {Folder as FolderIcon, FolderPlus, Film, ArrowRight, AlertTriangle} from 'lucide-react';
import {notifyFeedback} from '../global-feedback';
import {Modal, ModalActions} from './Modal';
import {folderContains, folderTrail, uniqueShots} from './folders';
import type {ConflictChoice, Folder, FolderOperation, OperationPlan, OperationReceipt, ProjectVideoRequest} from './types';

export type FolderAction = {kind: 'create'; parentId: string} | (FolderOperation & {label: string});
export function FolderOperations({action, active, folders, projectId, request, canTrash, readOnly, folderBlocked, onClose, onComplete, onPending, excludeTargets}: {
  action: FolderAction | null; active: boolean; folders: Folder[]; projectId: string; request: ProjectVideoRequest;
  canTrash: boolean; readOnly: boolean; folderBlocked: (id: string) => boolean;
  onClose: () => void; onComplete: (receipt?: OperationReceipt) => void; onPending: (pending: boolean) => void;
  /** 不能作为普通移动目标的目录（废片收纳处子树：移入废片要走“标记为废片”的解除采用确认）。 */
  excludeTargets?: Set<string>;
}) {
  const [name, setName] = useState(''), [destination, setDestination] = useState('root');
  const [mode, setMode] = useState<'trash' | 'contents-to-root'>('contents-to-root');
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>({}), [plan, setPlan] = useState<OperationPlan | null>(null);
  const [receipt, setReceipt] = useState<OperationReceipt | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirmed, setConfirmed] = useState(false);
  const inFlight = useRef(false), mutation = useRef<{requestId: string; api: ProjectVideoRequest; recoverable: boolean} | null>(null), seen = useRef(new Set<string>());
  const base = `/project-videos/projects/${encodeURIComponent(projectId)}`;
  const unresolved = !!mutation.current && (!receipt || ['running', 'unknown'].includes(receipt.status));
  const report = (message: string, kind: 'success' | 'error' = 'error') => { setError(kind === 'error' ? message : ''); notifyFeedback({source: '生成视频', message, kind}); };
  useEffect(() => {
    if (!action || mutation.current && (!receipt || ['running', 'unknown'].includes(receipt.status))) return;
    setName(action.kind === 'rename-folder' ? folders.find(f => f.id === action.folderId)?.name || '' : '');
    setDestination('destinationFolderId' in action ? action.destinationFolderId || 'root' : 'root');
    setMode('contents-to-root'); setPlan(null); setReceipt(null); mutation.current = null; setChoices({}); setConfirmed(false); setError('');
  }, [action]);
  useEffect(() => { onPending(busy || unresolved); }, [busy, unresolved, onPending]);
  function receive(next: OperationReceipt) {
    if (next.requestId !== mutation.current?.requestId) throw Error('操作回执编号不匹配，请查询原请求。');
    setReceipt(next);
    if (next.status === 'unknown' && !seen.current.has(next.requestId + 'unknown')) { seen.current.add(next.requestId + 'unknown'); report(next.error || '原文件夹操作结果待核对，请查询原请求；不会重新提交。'); }
    if (['ready', 'failed'].includes(next.status) && !seen.current.has(next.requestId + next.status)) {
      seen.current.add(next.requestId + next.status);
      report(next.status === 'ready' ? next.description || '文件夹操作已完成。' : next.error || '操作失败，请核对原请求。', next.status === 'ready' ? 'success' : 'error');
      onComplete(next);
    }
  }
  async function query(recover = false) {
    const original = mutation.current;
    if (!original || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try { receive(await original.api<OperationReceipt>(base + `/operations/${encodeURIComponent(original.requestId)}${recover ? '/recover' : ''}`, recover ? {action: 'rollback'} : undefined, recover ? 'POST' : 'GET')); }
    catch (e) { report(`结果尚未确认：${(e as Error).message}。请查询原请求，不会重新提交操作。`); }
    finally { inFlight.current = false; setBusy(false); }
  }
  useEffect(() => {
    if (receipt?.status !== 'running' || busy || error) return;
    const timer = setTimeout(() => void query(), 1600); return () => clearTimeout(timer);
  }, [receipt, busy, error]);
  function invalidate() { setPlan(null); setConfirmed(false); }
  async function preview() {
    if (!action || inFlight.current || unresolved || readOnly) return;
    if ('folderId' in action && action.folderId && folderBlocked(action.folderId)) { report('该文件夹或其子目录正在接收视频，请等待原任务结束。'); return; }
    inFlight.current = true; setBusy(true); setError('');
    try {
      if (action.kind === 'create') {
        const requestId = crypto.randomUUID(); mutation.current = {requestId, api: request, recoverable: false};
        try {
          await request(base + '/folders', {requestId, parentId: action.parentId, name: name.trim()}, 'POST');
          setReceipt({requestId, status: 'ready', description: '文件夹已创建。'});
          report('文件夹已创建。', 'success'); onComplete(); onClose();
        } catch (e) {
          const status = (e as {status?: number}).status;
          if (status && status < 500) mutation.current = null;
          else setReceipt({requestId, status: 'unknown', description: '新建文件夹结果待核对，请查询原编号。'});
          throw e;
        }
      } else {
        const next = await request<OperationPlan>(base + '/operations/preview', {
          requestId: crypto.randomUUID(), kind: action.kind, sourceId: action.sourceId, folderId: action.folderId,
          ...(action.kind === 'rename-folder' ? {name: name.trim()} : {}),
          ...(['move-video', 'move-folder'].includes(action.kind) ? {destinationFolderId: destination} : {}),
          ...(action.kind === 'delete-folder' ? {mode} : {}), choices,
        }, 'POST');
        setPlan(next); setConfirmed(false);
      }
    } catch (e) { report((e as {code?: string}).code === 'SOURCE_CHANGED' ? '文件状态与登记时不一致，暂不能继续此操作；这不一定代表视频内容改变。请先核验文件，原采用关系保留。' : (e as Error).message); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function commit() {
    if (!plan?.ready || inFlight.current || unresolved || readOnly || affected.length && !confirmed) return;
    inFlight.current = true; setBusy(true); setError('');
    const original = {requestId: plan.requestId, api: request, recoverable: true}; mutation.current = original;
    try { receive(await original.api<OperationReceipt>(base + '/operations', {requestId: plan.requestId, previewHash: plan.previewHash, confirmUnbind: confirmed}, 'POST')); }
    catch (e) { setReceipt({requestId: plan.requestId, status: 'unknown', description: plan.description}); report(`结果尚未确认：${(e as Error).message}。保留原编号，请查询或恢复原操作。`); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const affected = uniqueShots(plan?.affectedShots || []);
  const title = !action ? '' : {create: '新建文件夹', 'move-video': '移动视频', 'rename-folder': '重命名文件夹', 'move-folder': '移动文件夹', 'delete-folder': '删除文件夹'}[action.kind];
  return <>
    {!action && unresolved && <div className="pv-task"><p>文件夹操作结果待核对 · {mutation.current?.requestId}</p><button type="button" disabled={busy} onClick={() => void query()}>查询原文件夹操作</button>{receipt?.status === 'unknown' && mutation.current?.recoverable && <button type="button" disabled={busy} onClick={() => void query(true)}>恢复原操作（回滚）</button>}</div>}
    {active && action && <Modal title={title} className={action.kind === 'create' ? 'pv-folder-create-modal' : 'pv-folder-operation-modal'} locked={busy && !mutation.current} onClose={onClose}>
      {'label' in action && <div className="pv-operation-object">{action.kind === 'move-video' ? <Film size={20} aria-hidden="true"/> : <FolderIcon size={20} aria-hidden="true"/>}<div><span>操作对象</span><strong title={action.label}>{action.label}</strong></div></div>}
      {error && <p className="pv-error" role="alert">{error}</p>}
      {receipt ? <div className="pv-task"><p>{receipt.description} · {receipt.status === 'ready' ? '已完成' : receipt.status === 'failed' ? '失败' : '结果待核对'}</p><code>{receipt.requestId}</code>
      </div> : action.kind === 'create' ? <>
        <div className="pv-folder-create-fields">
          <p className="pv-folder-create-location"><FolderIcon size={15} aria-hidden="true"/><span>创建位置：<strong>{action.parentId === 'root' ? '项目根目录' : folders.find(f => f.id === action.parentId)?.path || folders.find(f => f.id === action.parentId)?.name || '所选文件夹'}</strong></span></p>
          <label className="pv-field">文件夹名称<input placeholder="输入文件夹名称" disabled={busy || readOnly} value={name} onChange={e => {setName(e.target.value); invalidate();}}/></label>
        </div>
        <div className="pv-folder-create-actions">
          <button type="button" onClick={onClose}>取消</button>
          <button type="button" className="pv-primary" disabled={busy || readOnly || !name.trim()} onClick={() => void preview()}><FolderPlus size={15} aria-hidden="true"/>{busy ? '正在创建…' : '创建文件夹'}</button>
        </div>
      </> : <>
        <fieldset className="pv-operation-fields" disabled={busy || readOnly}>
          {action.kind === 'rename-folder' && <label className="pv-field">文件夹名称<input value={name} onChange={e => {setName(e.target.value); invalidate();}}/></label>}
          {(action.kind === 'move-video' || action.kind === 'move-folder') && <label className="pv-field">目标文件夹<select value={destination} onChange={e => {setDestination(e.target.value); invalidate();}}>
            <option value="root">项目根目录</option>{folders.filter(f => f.available && !excludeTargets?.has(f.id) && !(action.kind === 'move-folder' && action.folderId && folderContains(folders, action.folderId, f.id))).map(f => <option key={f.id} value={f.id}>{folderTrail(folders, f.id).map(part => part.name).join(' / ') || f.name}</option>)}
          </select><small>选择项目内的目标目录，下一步核对移动影响。{excludeTargets?.size ? '要收纳为废片，请用“标记为废片…”。' : ''}</small></label>}
          {action.kind === 'delete-folder' && <label className="pv-field">删除方式<select value={mode} onChange={e => {setMode(e.target.value as typeof mode); invalidate();}}><option value="contents-to-root">内容移到项目根目录，再删除空文件夹</option><option value="trash" disabled={!canTrash}>整个文件夹与全部内容移到废纸篓{!canTrash ? '（当前环境不可用）' : ''}</option></select></label>}
        </fieldset>
        {plan && <div className="pv-operation-plan"><h3>{plan.description}</h3><p>{plan.files} 个文件 · {plan.folders} 个文件夹</p>
          {!!plan.conflicts.length && <><h3>同名冲突</h3><p>同名文件夹请选择改名或取消，不直接覆盖或合并目录。</p>{plan.conflicts.map(c => <label className="pv-field" key={c.key}>{c.sourceName || c.name} → {c.targetName}<small>覆盖会解除目标视频的采用：{c.adoptedShots.map(s => `镜 ${s.number}`).join('、') || '无'}</small><select aria-label={`冲突处理 ${c.name}`} value={choices[c.key] || ''} disabled={busy} onChange={e => {const value = e.target.value; setChoices(old => {const next = {...old}; if (value) next[c.key] = value as ConflictChoice; else delete next[c.key]; return next;}); setPlan(old => old ? {...old, ready: false} : old); setConfirmed(false);}}><option value="">请选择</option><option value="rename">保留双方，递增 _0 重命名</option><option value="overwrite" disabled={action.kind === 'move-folder' || action.kind === 'rename-folder'}>覆盖目标同名视频</option></select></label>)}<button type="button" disabled={busy || plan.conflicts.some(c => !choices[c.key])} onClick={() => void preview()}>按所选冲突方式重新预览</button></>}
          <p className="pv-muted">如果这些视频已用在外部剪辑工程里，移动、重命名或删除可能使那边失去链接；取消不会改动原文件。</p>
          <h3>本次将解除采用的精确镜号</h3><p>{affected.map(s => `镜 ${s.number}`).join('、') || '没有受影响的采用镜号'}</p>
          {!!affected.length && <label className="pv-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)}/>我已核对上述镜号，确认解除这些采用关系</label>}
        </div>}
      </>}
      {(action.kind !== 'create' || receipt) && <ModalActions>
        <button type="button" onClick={onClose}>{receipt ? '返回列表' : '取消'}</button>
        {receipt ? <><button type="button" disabled={busy} onClick={() => void query()}>查询原文件夹操作</button>{receipt.status === 'unknown' && mutation.current?.recoverable && <button type="button" disabled={busy} onClick={() => void query(true)}>恢复原操作（回滚）</button>}</> : <>
          <button type="button" className={plan ? undefined : 'pv-primary'} disabled={busy || readOnly || action.kind === 'rename-folder' && !name.trim()} onClick={() => void preview()}>{busy ? '正在核对…' : plan ? '重新核对影响' : '核对操作影响'}{!busy && <ArrowRight size={15} aria-hidden="true"/>}</button>
          {plan && <button type="button" className={action.kind === 'delete-folder' || affected.length ? 'pv-danger' : 'pv-primary'} disabled={busy || !plan.ready || !!affected.length && !confirmed || readOnly} onClick={() => void commit()}>{(action.kind === 'delete-folder' || !!affected.length) && <AlertTriangle size={15} aria-hidden="true"/>}确认执行{action.kind === 'delete-folder' && mode === 'trash' ? '并移到废纸篓' : ''}</button>}
        </>}
      </ModalActions>}
    </Modal>}
  </>;
}
