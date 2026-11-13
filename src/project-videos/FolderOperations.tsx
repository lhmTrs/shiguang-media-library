import React, {useEffect, useRef, useState} from 'react';
import {Folder as FolderIcon, FolderPlus, Film, ArrowRight, AlertTriangle} from 'lucide-react';
import {notifyFeedback} from '../global-feedback';
import {Modal, ModalActions} from './Modal';
import {folderContains, folderTrail, uniqueShots} from './folders';
import type {ConflictChoice, Folder, FolderOperation, OperationPlan, OperationReceipt, ProjectVideoRequest} from './types';

const POLL_RETRIES = 6;
export type FolderAction = {kind: 'create'; parentId: string} | (FolderOperation & {label: string});
export function FolderOperations({action, active, folders, projectId, request, canTrash, readOnly, folderBlocked, onClose, onComplete, onPending, excludeTargets, rolesRevision, onOpenFolder}: {
  action: FolderAction | null; active: boolean; folders: Folder[]; projectId: string; request: ProjectVideoRequest;
  canTrash: boolean; readOnly: boolean; folderBlocked: (id: string) => boolean;
  onClose: () => void; onComplete: (receipt?: OperationReceipt) => void; onPending: (pending: boolean) => void;
  /** 不能作为普通移动目标的目录（废片收纳处子树：移入废片要走“标记为废片”的解除采用确认）。 */
  excludeTargets?: Set<string>;
  /** move-videos 预览必带的收纳处版本（同一项目列表的 folderRoles.revision）。 */
  rolesRevision?: number;
  /** 批量移动完成后「打开目标文件夹」。 */
  onOpenFolder?: (folderId: string) => void;
}) {
  const [name, setName] = useState(''), [destination, setDestination] = useState('root');
  const [mode, setMode] = useState<'trash' | 'contents-to-root'>('contents-to-root');
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>({}), [plan, setPlan] = useState<OperationPlan | null>(null);
  const [receipt, setReceipt] = useState<OperationReceipt | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirmed, setConfirmed] = useState(false);
  const inFlight = useRef(false), mutation = useRef<{requestId: string; api: ProjectVideoRequest} | null>(null), seen = useRef(new Set<string>());
  const base = `/project-videos/projects/${encodeURIComponent(projectId)}`;
  // 收起弹窗后操作仍在后台：底部条可以「查看进度」重新打开同一个操作（不是新操作）
  const lastAction = useRef<FolderAction | null>(null); if (action) lastAction.current = action;
  const [reopened, setReopened] = useState(false);
  useEffect(() => { if (action) setReopened(false); }, [action]);
  const shown = action ?? (reopened ? lastAction.current : null);
  const close = () => { if (action) onClose(); else setReopened(false); };
  // 多选移动：已在所选目标目录的项不提交（后端会整批拒绝 SAME_LOCATION），按目标即时算出
  const batch = shown?.kind === 'move-videos';
  const batchItems = batch && shown && 'items' in shown ? shown.items || [] : [];
  const sameHere = batchItems.filter(i => i.folderId === destination), movable = batchItems.filter(i => i.folderId !== destination);
  const destName = destination === 'root' ? '项目根目录' : folders.find(f => f.id === destination)?.name || '所选文件夹';
  /** 服务端明确只有预览、执行没有登记：这笔已结束（文件没动），可以重新核对，不再锁住后续移动、不给回滚。 */
  const notStarted = (r: OperationReceipt | null) => !!r && r.status === 'unknown' && (r.phase === 'preview' || r.errorCode === 'OPERATION_NOT_STARTED');
  const pending = (r: OperationReceipt | null) => !r || r.status === 'running' || r.status === 'unknown' && !notStarted(r);
  const unresolved = !!mutation.current && pending(receipt);
  // 执行中某次进度查询失败（网络中断）：保留最后已知状态，按退避自动再查原编号，也可以手动「重新查询」；不重发执行
  const [pollFail, setPollFail] = useState(0);
  const report = (message: string, kind: 'success' | 'error' = 'error') => { setError(kind === 'error' ? message : ''); notifyFeedback({source: '生成视频', message, kind}); };
  useEffect(() => {
    if (!action || mutation.current && pending(receipt)) return;
    setName(action.kind === 'rename-folder' ? folders.find(f => f.id === action.folderId)?.name || '' : '');
    setDestination('destinationFolderId' in action && action.destinationFolderId ? action.destinationFolderId : action.kind === 'move-videos' ? '' : 'root');
    setMode('contents-to-root'); setPlan(null); setReceipt(null); mutation.current = null; setChoices({}); setConfirmed(false); setError(''); setPollFail(0);
  }, [action]);
  useEffect(() => { onPending(busy || unresolved); }, [busy, unresolved, onPending]);
  function receive(next: OperationReceipt) {
    if (next.requestId !== mutation.current?.requestId) throw Error('操作回执编号不匹配，请查询原请求。');
    setReceipt(next);
    if (next.status === 'unknown' && !notStarted(next) && !seen.current.has(next.requestId + 'unknown')) { seen.current.add(next.requestId + 'unknown'); report(next.error || '原文件夹操作结果待核对，请查询原请求；不会重新提交。'); }
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
    try { receive(await original.api<OperationReceipt>(base + `/operations/${encodeURIComponent(original.requestId)}${recover ? '/recover' : ''}`, recover ? {action: 'rollback'} : undefined, recover ? 'POST' : 'GET')); setPollFail(0); }
    catch (e) {
      // 执行中读进度失败：不当成结果，保留「正在移动」，自动再试；其他状态照旧提示查询原请求
      if (!recover && receipt?.status === 'running') setPollFail(f => f + 1);
      else report(`结果尚未确认：${(e as Error).message}。请查询原请求，不会重新提交操作。`);
    }
    finally { inFlight.current = false; setBusy(false); }
  }
  useEffect(() => {
    if (receipt?.status !== 'running' || busy || error || pollFail >= POLL_RETRIES) return;
    const timer = setTimeout(() => void query(), pollFail ? Math.min(1600 * 2 ** pollFail, 20000) : 1600); return () => clearTimeout(timer);
  }, [receipt, busy, error, pollFail]);
  /** 只核对过、没有执行：回到核对前，保留所选视频和目标，重新核对。 */
  function restart() { mutation.current = null; setReceipt(null); setPlan(null); setConfirmed(false); setError(''); setPollFail(0); }
  const pollNote = receipt?.status === 'running' && pollFail > 0 ? `暂时没读到最新进度（已重试 ${pollFail} 次），${pollFail >= POLL_RETRIES ? '请检查连接后点「重新查询」' : '会自动再试，也可以点「重新查询」'}；不会重新提交移动。` : '';
  function invalidate() { setPlan(null); setConfirmed(false); }
  async function preview() {
    if (!action || inFlight.current || unresolved || readOnly) return;
    if ('folderId' in action && action.folderId && folderBlocked(action.folderId)) { report('该文件夹或其子目录正在接收视频，请等待原任务结束。'); return; }
    inFlight.current = true; setBusy(true); setError('');
    try {
      if (action.kind === 'create') {
        const requestId = crypto.randomUUID(); mutation.current = {requestId, api: request};
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
        if (action.kind === 'move-videos' && (!destination || !movable.length)) return;
        const next = await request<OperationPlan>(base + '/operations/preview', action.kind === 'move-videos' ? {
          requestId: crypto.randomUUID(), kind: 'move-videos', sourceIds: movable.map(i => i.id), destinationFolderId: destination,
          expectedRolesRevision: rolesRevision ?? 0, choices,
        } : {
          requestId: crypto.randomUUID(), kind: action.kind, sourceId: action.sourceId, folderId: action.folderId,
          ...(action.kind === 'rename-folder' ? {name: name.trim()} : {}),
          ...(['move-video', 'move-folder'].includes(action.kind) ? {destinationFolderId: destination} : {}),
          ...(action.kind === 'delete-folder' ? {mode} : {}), choices,
        }, 'POST');
        setPlan(next); setConfirmed(false);
      }
    } catch (e) {
      if ((e as {code?: string}).code === 'REJECT_AREA_CHANGED') { report('废片收纳处刚变了，已重新读取，请再核对一次。'); onComplete(); return; }
      report((e as {code?: string}).code === 'SOURCE_CHANGED' ? '文件状态与登记时不一致，暂不能继续此操作；这不一定代表视频内容改变。请先核验文件，原采用关系保留。' : (e as Error).message); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function commit() {
    if (!plan?.ready || inFlight.current || unresolved || readOnly || affected.length && !confirmed) return;
    inFlight.current = true; setBusy(true); setError('');
    const original = {requestId: plan.requestId, api: request}; mutation.current = original;
    // 批量移动执行严格校验：即使没有受影响镜号也要带 confirmUnbind:true 与 []；有影响时按最终预览的镜号、经用户勾选后提交
    const body = batch ? {requestId: plan.requestId, previewHash: plan.previewHash, confirmUnbind: true, confirmedUnbindShotIds: affected.map(s => s.id)} : {requestId: plan.requestId, previewHash: plan.previewHash, confirmUnbind: confirmed};
    try { receive(await original.api<OperationReceipt>(base + '/operations', body, 'POST')); }
    catch (e) { setReceipt({requestId: plan.requestId, status: 'unknown', description: plan.description}); report(`结果尚未确认：${(e as Error).message}。保留原编号，请查询或恢复原操作。`); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const affected = uniqueShots(plan?.affectedShots || []);
  const skippedUp = batch && shown && 'skipped' in shown ? shown.skipped || [] : [];
  const titles: Record<string, string> = {create: '新建文件夹', 'move-video': '移动视频', 'rename-folder': '重命名文件夹', 'move-folder': '移动文件夹', 'delete-folder': '删除文件夹'};
  const title = !shown ? '' : batch ? `移动 ${batchItems.length + skippedUp.length} 个视频` : titles[shown.kind];
  const lastKind = (shown ?? lastAction.current)?.kind; // 收起弹窗后底部条仍按这笔操作的类型说话
  const moving = lastKind === 'move-videos' || lastKind === 'move-video';
  /** 状态文字：执行中就是执行中；只有真的确认不了才说「结果待核对」，只有预览没执行说「尚未开始」。 */
  const statusText = (r: OperationReceipt) => r.status === 'ready' ? '已完成' : r.status === 'failed' ? '失败' : r.status === 'running' ? (moving ? '正在移动…' : '正在处理…')
    : r.phase === 'preview' || r.errorCode === 'OPERATION_NOT_STARTED' ? '尚未开始' : '结果待核对';
  const itemText: Record<string, string> = {ready: '已移动', 'not-run': receipt?.status === 'running' ? '等待完成' : '没有执行', 'rolled-back': '已退回原处', failed: '失败', unknown: '待核对'};
  const nameOf = (id: string) => batchItems.find(i => i.id === id)?.name || id;
  return <>
    {!shown && unresolved && <div className="pv-task pv-op-background" role="status"><p>{receipt?.status === 'running' ? <>{receipt.description || '文件夹操作'} · {statusText(receipt)}完成前不能开始新的移动。{pollNote && <> {pollNote}</>}</> : <>文件夹操作结果待核对 · {mutation.current?.requestId}</>}</p>
      <button type="button" onClick={() => setReopened(true)}>查看进度</button>{(receipt?.status !== 'running' || !!pollNote) && <button type="button" disabled={busy} onClick={() => void query()}>{receipt?.status === 'running' ? '重新查询' : '查询原文件夹操作'}</button>}{receipt?.status === 'unknown' && receipt.canRecover === true && <button type="button" disabled={busy} onClick={() => void query(true)}>恢复原操作（回滚）</button>}</div>}
    {active && shown && <Modal title={title} className={shown.kind === 'create' ? 'pv-folder-create-modal' : 'pv-folder-operation-modal'} locked={busy && !mutation.current} onClose={close}>
      {batch && !receipt && <div className="pv-operation-object pv-batch-object"><Film size={20} aria-hidden="true"/><div><span>操作对象 · {batchItems.length + skippedUp.length} 个{destination ? `，其中 ${movable.length} 个会移动` : ''}</span>
        <ul className="pv-batch-items">{movable.map(i => <li key={i.id}><span>{i.name}</span><small>{destination ? `→ ${destName}` : ''}</small></li>)}
          {sameHere.map(i => <li key={i.id} className="pv-batch-skip"><s>{i.name}</s><small>已在「{destName}」，不移动</small></li>)}
          {skippedUp.map((i, k) => <li key={'s' + k} className="pv-batch-skip pv-batch-warn"><s>{i.name}</s><small>{i.reason}</small></li>)}</ul>
        {!!destination && !movable.length && <p className="pv-muted">所选视频都已在「{destName}」，不需要移动。</p>}</div></div>}
      {'label' in shown && !batch && <div className="pv-operation-object">{shown.kind === 'move-video' ? <Film size={20} aria-hidden="true"/> : <FolderIcon size={20} aria-hidden="true"/>}<div><span>操作对象</span><strong title={shown.label}>{shown.label}</strong></div></div>}
      {error && <p className="pv-error" role="alert">{error}</p>}
      {receipt ? <div className="pv-task" role="status"><p><strong>{batch && receipt.status === 'ready' ? `已移动 ${(receipt.items || []).filter(x => x.status === 'ready').length || movable.length} 个到「${destName}」` : `${receipt.description} · ${statusText(receipt)}`}</strong></p>
        {receipt.status === 'running' && <><progress aria-label="正在移动"/><small>可以先关掉，移动会在后台完成；完成前不能开始新的移动。</small>{pollNote && <small className="pv-op-poll-note" role="alert">{pollNote}</small>}</>}
        {notStarted(receipt) && <small>这笔只核对过影响，没有执行，文件没有改动。可以重新核对后再确认。</small>}
        {batch && !!receipt.items?.length && <ul className="pv-batch-items">{receipt.items.map(x => <li key={x.sourceId} data-state={x.status}><span>{x.name || nameOf(x.sourceId)}</span><small>{itemText[x.status] || x.status}{x.error ? `：${x.error}` : ''}</small></li>)}</ul>}
        {receipt.status === 'ready' && batch && <small>采用关系没有变化{affected.length ? '（覆盖的同名视频已按确认解除采用）' : ''}。</small>}
        {receipt.status !== 'ready' && receipt.status !== 'running' && <code>{receipt.requestId}</code>}
      </div> : shown.kind === 'create' ? <>
        <div className="pv-folder-create-fields">
          <p className="pv-folder-create-location"><FolderIcon size={15} aria-hidden="true"/><span>创建位置：<strong>{shown.parentId === 'root' ? '项目根目录' : folders.find(f => f.id === shown.parentId)?.path || folders.find(f => f.id === shown.parentId)?.name || '所选文件夹'}</strong></span></p>
          <label className="pv-field">文件夹名称<input placeholder="输入文件夹名称" disabled={busy || readOnly} value={name} onChange={e => {setName(e.target.value); invalidate();}}/></label>
        </div>
        <div className="pv-folder-create-actions">
          <button type="button" onClick={close}>取消</button>
          <button type="button" className="pv-primary" disabled={busy || readOnly || !name.trim()} onClick={() => void preview()}><FolderPlus size={15} aria-hidden="true"/>{busy ? '正在创建…' : '创建文件夹'}</button>
        </div>
      </> : <>
        <fieldset className="pv-operation-fields" disabled={busy || readOnly}>
          {shown.kind === 'rename-folder' && <label className="pv-field">文件夹名称<input value={name} onChange={e => {setName(e.target.value); invalidate();}}/></label>}
          {(shown.kind === 'move-video' || shown.kind === 'move-videos' || shown.kind === 'move-folder') && <label className="pv-field">目标文件夹<select value={destination} onChange={e => {setDestination(e.target.value); invalidate();}}>
            {batch && <option value="" disabled>请选择目标文件夹</option>}<option value="root">项目根目录</option>{folders.filter(f => f.available && !excludeTargets?.has(f.id) && !(shown.kind === 'move-folder' && shown.folderId && folderContains(folders, shown.folderId, f.id))).map(f => <option key={f.id} value={f.id}>{folderTrail(folders, f.id).map(part => part.name).join(' / ') || f.name}</option>)}
          </select><small>选择项目内的目标目录，下一步核对移动影响。{excludeTargets?.size ? '要收纳为废片，请用“标记为废片…”。' : ''}</small></label>}
          {shown.kind === 'delete-folder' && <label className="pv-field">删除方式<select value={mode} onChange={e => {setMode(e.target.value as typeof mode); invalidate();}}><option value="contents-to-root">内容移到项目根目录，再删除空文件夹</option><option value="trash" disabled={!canTrash}>整个文件夹与全部内容移到废纸篓{!canTrash ? '（当前环境不可用）' : ''}</option></select></label>}
        </fieldset>
        {plan && <div className="pv-operation-plan"><h3>{plan.description}</h3><p>{plan.files} 个文件 · {plan.folders} 个文件夹</p>
          {!!plan.conflicts.length && <><h3>同名冲突</h3><p>同名文件夹请选择改名或取消，不直接覆盖或合并目录。</p>{plan.conflicts.map(c => <label className="pv-field" key={c.key}>{c.sourceName || c.name} → {c.targetName}<small>覆盖会解除目标视频的采用：{c.adoptedShots.map(s => `镜 ${s.number}`).join('、') || '无'}</small><select aria-label={`冲突处理 ${c.name}`} value={choices[c.key] || ''} disabled={busy} onChange={e => {const value = e.target.value; setChoices(old => {const next = {...old}; if (value) next[c.key] = value as ConflictChoice; else delete next[c.key]; return next;}); setPlan(old => old ? {...old, ready: false} : old); setConfirmed(false);}}><option value="">请选择</option><option value="rename">保留双方，递增 _0 重命名</option><option value="overwrite" disabled={shown.kind === 'move-folder' || shown.kind === 'rename-folder'}>覆盖目标同名视频</option></select></label>)}<button type="button" disabled={busy || plan.conflicts.some(c => !choices[c.key])} onClick={() => void preview()}>按所选冲突方式重新预览</button></>}
          <p className="pv-muted">如果这些视频已用在外部剪辑工程里，移动、重命名或删除可能使那边失去链接；取消不会改动原文件。</p>
          <h3>本次将解除采用的精确镜号</h3><p>{affected.map(s => `镜 ${s.number}`).join('、') || '没有受影响的采用镜号'}</p>
          {!!affected.length && <label className="pv-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)}/>我已核对上述镜号，确认解除这些采用关系</label>}
        </div>}
      </>}
      {(shown.kind !== 'create' || receipt) && <ModalActions>
        {receipt?.status === 'running' ? <button type="button" onClick={close}>在后台继续</button>
        : receipt?.status === 'ready' && batch && onOpenFolder && destination ? <><button type="button" onClick={close}>留在这里</button><button type="button" className="pv-primary" onClick={() => { close(); onOpenFolder(destination); }}>打开「{destName}」</button></>
        : <button type="button" onClick={close}>{receipt ? '返回列表' : '取消'}</button>}
        {receipt?.status === 'running' ? (pollNote ? <button type="button" disabled={busy} onClick={() => void query()}>重新查询</button> : null)
        : receipt?.status === 'ready' && batch && onOpenFolder && destination ? null
        : receipt && notStarted(receipt) ? (action ? <button type="button" className="pv-primary" disabled={busy} onClick={restart}>重新核对</button> : null)
        : receipt ? <><button type="button" disabled={busy} onClick={() => void query()}>查询原文件夹操作</button>{receipt.status === 'unknown' && receipt.canRecover === true && <button type="button" disabled={busy} onClick={() => void query(true)}>恢复原操作（回滚）</button>}</> : <>
          <button type="button" className={plan ? undefined : 'pv-primary'} disabled={busy || readOnly || shown.kind === 'rename-folder' && !name.trim() || batch && (!destination || !movable.length)} onClick={() => void preview()}>{busy ? '正在核对…' : plan ? '重新核对影响' : batch ? `核对 ${movable.length} 个视频的移动影响` : '核对操作影响'}{!busy && <ArrowRight size={15} aria-hidden="true"/>}</button>
          {plan && <button type="button" className={shown.kind === 'delete-folder' || affected.length ? 'pv-danger' : 'pv-primary'} disabled={busy || !plan.ready || !!affected.length && !confirmed || readOnly} onClick={() => void commit()}>{(shown.kind === 'delete-folder' || !!affected.length) && <AlertTriangle size={15} aria-hidden="true"/>}{batch ? `确认移动 ${movable.length} 个` : '确认执行'}{shown.kind === 'delete-folder' && mode === 'trash' ? '并移到废纸篓' : ''}</button>}
        </>}
      </ModalActions>}
    </Modal>}
  </>;
}
