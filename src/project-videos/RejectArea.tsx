import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, Archive, RefreshCw } from 'lucide-react';
import { Modal, ModalActions } from './Modal';
import { folderContains, folderTrail, uniqueShots } from './folders';
import type { BatchReceipt, ConflictChoice, Folder, FolderRoles, ProjectVideoCollection, ProjectVideoRequest, RejectMovePlan, RejectRolePlan, RejectShot } from './types';

/*
 * 废片收纳（#55，合同 v1）。
 * - 收纳处由后台 rejectFolderId 唯一决定；前端不按名称识别，“废片”只是新建时的默认名或预选项。
 * - 两个阶段可分别结清：先准备收纳处（/folders/reject/preview → /folders/reject），再移动视频
 *   （/operations/preview kind:'move-videos' unbindAdoptions:true → /operations）。
 * - 每次执行都用预览给出的固定 requestId；回应丢失或 202 之后读不到结果时只查询原请求（/operations/:requestId），不重发。
 * - 解除采用必须精确确认：confirmedUnbindShotIds 与预览的 affectedShots 完全一致（没有时传空数组）。
 * - 任务状态放在项目会话层：收起弹窗、切页、切项目都保留原请求；没看到的结果保留页面顶部入口。
 */
export const MAX_REJECT = 50;
type Stage = 'role' | 'move';
type Commit = { stage: Stage; requestId: string; receipt: BatchReceipt | null; busy: boolean; unknown: boolean; error: string };
type Setup = { kind: 'create' } | { kind: 'existing'; folderId: string } | { kind: 'clear' };
export type RejectTarget = { id: string; name: string };

const shotText = (list: { number: number | string }[] = []) => list.map(s => `镜 ${s.number}`).join('、');
const msg = (e: unknown) => e instanceof Error ? e.message : String(e || '请求失败');
const httpStatus = (e: unknown) => (e as { status?: number }).status;
const pendingStatus = (r: BatchReceipt | null) => !!r && r.status === 'running';
/** 收纳处子树（含收纳根）。指针失效（目录不在列表或不可用）时返回空集合。 */
export function rejectSubtree(folders: Folder[], roles?: FolderRoles | null) {
  const id = roles?.rejectFolderId; const out = new Set<string>();
  if (!id || !folders.some(f => f.id === id)) return out;
  for (const f of folders) if (folderContains(folders, id, f.id)) out.add(f.id);
  return out;
}
/** 指针存在但目标目录不在列表里或不可用：显示“收纳目录需核对”，不找同名目录顶替。 */
export const rejectNeedsCheck = (folders: Folder[], roles?: FolderRoles | null) => {
  const id = roles?.rejectFolderId; if (!id) return false;
  if (roles?.needsReview) return true;
  const f = folders.find(x => x.id === id); return !f || !f.available;
};
const folderPath = (folders: Folder[], id: string | null) => !id ? '' : id === 'root' ? '项目根目录' : folderTrail(folders, id).map(f => f.name).join(' / ') || '所选文件夹';

export type RejectController = ReturnType<typeof useRejectTask>;

export function useRejectTask(projectId: string, request: ProjectVideoRequest, onChanged: () => void) {
  const base = `/project-videos/projects/${encodeURIComponent(projectId)}`;
  const [visible, setVisible] = useState(false), [mode, setMode] = useState<'mark' | 'role' | null>(null);
  const [targets, setTargets] = useState<RejectTarget[]>([]);
  const [stage, setStage] = useState<Stage>('role');
  const [setup, setSetup] = useState<Setup>({ kind: 'create' });
  const [rolePlan, setRolePlan] = useState<RejectRolePlan | null>(null), [movePlan, setMovePlan] = useState<RejectMovePlan | null>(null);
  const [roleOk, setRoleOk] = useState(false), [unbindOk, setUnbindOk] = useState(false);
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>({});
  const [roles, setRoles] = useState<FolderRoles | null>(null), [folders, setFolders] = useState<Folder[]>([]);
  const [previewBusy, setPreviewBusy] = useState(false), [previewError, setPreviewError] = useState('');
  const [commit, setCommitState] = useState<Commit | null>(null), [roleDone, setRoleDone] = useState<BatchReceipt | null>(null);
  const commitRef = useRef<Commit | null>(null), ticket = useRef(0), notified = useRef(new Set<string>());
  const requestRef = useRef(request); requestRef.current = request;
  const changedRef = useRef(onChanged); changedRef.current = onChanged;
  const put = (next: Commit | null) => { commitRef.current = next; setCommitState(next); };
  const patch = (requestId: string, p: Partial<Commit>) => { const c = commitRef.current; if (c && c.requestId === requestId) put({ ...c, ...p }); };

  const r = commit?.receipt || null;
  const pending = !!commit && (commit.busy || pendingStatus(r) && !commit.unknown);
  const unresolved = !!commit && (pending || commit.unknown || r?.status === 'unknown' || !!r?.items?.some(i => i.status === 'unknown'));
  // 结果是否已在弹窗里真正显示过（切页/切项目时弹窗不渲染，不算看到）
  const resultKey = commit && !pending ? `${commit.requestId}:${r?.status || ''}:${commit.unknown ? 'u' : ''}:${commit.error ? 'e' : ''}` : '';
  const [seenKey, setSeenKey] = useState('');
  const markSeen = (key: string) => { if (key) setSeenKey(old => old === key ? old : key); };
  const unread = !!resultKey && seenKey !== resultKey;
  const attention = unresolved || unread;
  const active = !!mode;

  // 终态只通知父层一次（刷新列表与收纳处信息）
  useEffect(() => {
    if (!commit || !r || pending || notified.current.has(commit.requestId + r.status)) return;
    if (['ready', 'partial', 'failed', 'unknown'].includes(r.status)) { notified.current.add(commit.requestId + r.status); changedRef.current(); }
  }, [commit, r, pending]);
  // 进行中（202 running）时按原请求只读查询
  useEffect(() => {
    if (!commit || commit.busy || commit.unknown || commit.error || !pendingStatus(r)) return;
    const timer = window.setTimeout(() => { void query(); }, 1500); return () => window.clearTimeout(timer);
  }, [commit]); // eslint-disable-line react-hooks/exhaustive-deps

  function receive(requestId: string, next: BatchReceipt) {
    if (next.requestId && next.requestId !== requestId) throw Object.assign(Error('回执编号与原请求不一致，请查询原请求。'), { code: 'RECEIPT_MISMATCH' });
    patch(requestId, { receipt: next, busy: false, unknown: next.status === 'unknown', error: next.status === 'failed' ? next.error || '操作没有完成。' : '' });
    if (commitRef.current?.stage === 'role' && next.status === 'ready') setRoleDone(next);
  }
  async function query() {
    const c = commitRef.current; if (!c || c.busy) return;
    patch(c.requestId, { busy: true });
    try { receive(c.requestId, await requestRef.current<BatchReceipt>(`${base}/operations/${encodeURIComponent(c.requestId)}`)); }
    catch (e) {
      const status = httpStatus(e);
      patch(c.requestId, { busy: false, unknown: true, error: status === 404 ? '后台暂时没有找到这笔请求的回执。原操作可能还没登记，也可能已经执行，请稍后再查询原请求；不会自动重发。' : `查询原请求${status ? `失败（${status}）` : '时连接中断'}：${msg(e)}。原操作可能仍在进行或已经完成，请再次查询；不会自动重发。` });
    }
  }
  /** 读取最新的收纳处信息（只读）。 */
  async function loadRoles() {
    const list = await requestRef.current<ProjectVideoCollection>(`${base}?folderId=reject`);
    setRoles(list.folderRoles || null); setFolders(list.folders || []); return list;
  }
  function resetPlans() { setRolePlan(null); setMovePlan(null); setRoleOk(false); setUnbindOk(false); setChoices({}); setPreviewError(''); }

  /** 标记为废片：有收纳处时直接核对移动；没有（或需核对）时先设置收纳处。 */
  async function open(next: RejectTarget[], current: { roles?: FolderRoles | null; folders: Folder[] }) {
    if (active && (attention || mode)) { setVisible(true); return false; }
    if (!next.length) return false;
    if (next.length > MAX_REJECT) return false;
    ticket.current++; put(null); setRoleDone(null); resetPlans(); setMode('mark'); setTargets(next); setVisible(true);
    setRoles(current.roles || null); setFolders(current.folders);
    const ready = !!current.roles?.rejectFolderId && !rejectNeedsCheck(current.folders, current.roles);
    if (ready) { setStage('move'); void previewMove(next, current.roles!); }
    else { setStage('role'); setSetup(defaultSetup(current.folders)); }
    return true;
  }
  /** 设置 / 更改 / 取消收纳处（只改角色，不移动视频）。 */
  function openRole(current: { roles?: FolderRoles | null; folders: Folder[] }, initial?: Setup) {
    if (active && (attention || mode)) { setVisible(true); return false; }
    ticket.current++; put(null); setRoleDone(null); resetPlans(); setMode('role'); setTargets([]); setVisible(true); setStage('role');
    setRoles(current.roles || null); setFolders(current.folders); setSetup(initial || defaultSetup(current.folders, current.roles));
    return true;
  }
  function defaultSetup(list: Folder[], current?: FolderRoles | null): Setup {
    const named = list.find(f => f.parentId === 'root' && f.name === '废片' && f.available && f.id !== current?.rejectFolderId);
    return named ? { kind: 'existing', folderId: named.id } : { kind: 'create' };
  }

  async function previewRole() {
    if (previewBusy || attention) return;
    const t = ++ticket.current; setPreviewBusy(true); setPreviewError(''); setRolePlan(null); setRoleOk(false); setUnbindOk(false);
    try {
      const latest = await loadRoles(); if (t !== ticket.current) return;
      const body = { requestId: crypto.randomUUID(), expectedRolesRevision: latest.folderRoles?.revision ?? 0,
        ...(setup.kind === 'create' ? { create: { parentId: 'root', name: '废片' } } : { folderId: setup.kind === 'existing' ? setup.folderId : null }) };
      const plan = await requestRef.current<RejectRolePlan>(`${base}/folders/reject/preview`, body, 'POST');
      if (t === ticket.current) setRolePlan(plan);
    } catch (e) { if (t === ticket.current) setPreviewError(msg(e)); }
    finally { if (t === ticket.current) setPreviewBusy(false); }
  }
  async function previewMove(list = targets, knownRoles?: FolderRoles | null) {
    if (previewBusy || attention && commitRef.current?.stage === 'move') return;
    const t = ++ticket.current; setPreviewBusy(true); setPreviewError(''); setMovePlan(null); setUnbindOk(false);
    try {
      const latest = knownRoles ? { folderRoles: knownRoles } : await loadRoles(); if (t !== ticket.current) return;
      const target = latest.folderRoles?.rejectFolderId;
      if (!target) { setPreviewError('还没有可用的废片收纳处，请先设置。'); setStage('role'); return; }
      const plan = await requestRef.current<RejectMovePlan>(`${base}/operations/preview`, {
        requestId: crypto.randomUUID(), kind: 'move-videos', sourceIds: list.map(v => v.id), destinationFolderId: target,
        unbindAdoptions: true, expectedRolesRevision: latest.folderRoles?.revision ?? 0, choices,
      }, 'POST');
      if (t === ticket.current) setMovePlan(plan);
    } catch (e) { if (t === ticket.current) setPreviewError(msg(e)); }
    finally { if (t === ticket.current) setPreviewBusy(false); }
  }
  async function run(stageNow: Stage, url: string, body: Record<string, unknown>) {
    const requestId = String(body.requestId); ticket.current++;
    put({ stage: stageNow, requestId, receipt: null, busy: true, unknown: false, error: '' });
    try { receive(requestId, await requestRef.current<BatchReceipt>(url, body, 'POST')); }
    catch (e) {
      // 没有 HTTP 状态 = 回应丢失：可能已经执行，只能查询原请求
      if (!httpStatus(e)) patch(requestId, { busy: false, unknown: true, error: `结果尚未确认：${msg(e)}。请查询原请求，不会自动重发。` });
      else patch(requestId, { busy: false, unknown: false, error: msg(e) });
    }
  }
  function commitRole() {
    const p = rolePlan; if (!p?.ready || attention || !roleOk) return;
    const shots = uniqueShots(p.affectedShots || []); if (shots.length && !unbindOk) return;
    void run('role', `${base}/folders/reject`, { requestId: p.requestId, previewHash: p.previewHash, confirmRoleChange: true,
      ...(shots.length ? { confirmUnbind: true } : {}), confirmedUnbindShotIds: shots.map(s => s.id) });
  }
  function commitMove() {
    const p = movePlan; if (!p?.ready || attention) return;
    const shots = uniqueShots(p.affectedShots || []); if (shots.length && !unbindOk) return;
    void run('move', `${base}/operations`, { requestId: p.requestId, previewHash: p.previewHash, confirmUnbind: true, confirmedUnbindShotIds: shots.map(s => s.id) });
  }
  /** 收纳处已准备好：读取新的角色信息后继续核对移动。 */
  function continueToMove() { if (attention) return; put(null); resetPlans(); setStage('move'); void previewMove(targets); }
  function hide() {
    setVisible(false); ticket.current++;
    if (!unresolved && (!resultKey || seenKey === resultKey)) { put(null); setRoleDone(null); resetPlans(); setMode(null); setTargets([]); }
  }
  function forget() { ticket.current++; put(null); setRoleDone(null); resetPlans(); setMode(null); setTargets([]); setVisible(false); }
  function retry() { put(null); if (stage === 'role') void previewRole(); else void previewMove(); }

  return {
    visible, setVisible, mode, targets, stage, setup, setSetup, rolePlan, movePlan, roleOk, setRoleOk, unbindOk, setUnbindOk,
    choices, setChoices, roles, folders, previewBusy, previewError, commit, roleDone, pending, unresolved, unread, attention, resultKey, markSeen,
    open, openRole, previewRole, previewMove, commitRole, commitMove, continueToMove, query, hide, forget, retry,
    invalidateRole: () => { setRolePlan(null); setRoleOk(false); setUnbindOk(false); },
  };
}

/** 页面顶部入口：弹窗收起后，未结清或没看过的结果仍可打开或查询原请求。 */
export function RejectBanner({ ctl }: { ctl: RejectController }) {
  if (!ctl.mode || ctl.visible || !ctl.attention) return null;
  const c = ctl.commit, r = c?.receipt;
  const what = c?.stage === 'role' ? '设置废片收纳处' : `标记 ${ctl.targets.length} 个视频为废片`;
  const state = ctl.pending ? '处理中' : ctl.unresolved ? '结果待核对' : r?.status === 'partial' ? '部分完成，请查看结果' : c?.error ? '没有完成，请查看原因' : '已有结果，请查看';
  return <div className="pv-banner" data-tone="warn" role="status">
    <Archive size={15}/><span className="pv-banner-text">废片收纳：{what} {state}{c ? <> <code>{c.requestId}</code></> : null}</span>
    {ctl.unresolved && !ctl.pending && <button type="button" onClick={() => void ctl.query()}><RefreshCw size={13}/>查询原请求</button>}
    <button type="button" onClick={() => ctl.setVisible(true)}>打开</button>
  </div>;
}

const itemText: Record<string, string> = { ready: '已移入废片', 'rolled-back': '没有移动（已回退）', failed: '没有移动', unknown: '结果待核对', 'not-run': '没有执行' };

export function RejectDialog({ ctl, allFolders }: { ctl: RejectController; allFolders: Folder[] }) {
  const { resultKey, markSeen } = ctl;
  useEffect(() => { markSeen(resultKey); }, [resultKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ctl.mode) return null;
  const folders = ctl.folders.length ? ctl.folders : allFolders;
  const c = ctl.commit, r = c?.receipt || null, busy = ctl.previewBusy || ctl.pending;
  const current = ctl.roles?.rejectFolderId || null, currentName = folderPath(folders, current);
  const title = ctl.mode === 'role' ? '废片收纳处' : `标记为废片（${ctl.targets.length} 个）`;
  let body: React.ReactNode = null, actions: React.ReactNode = null;

  const head = ctl.mode === 'mark' && <div className="pv-operation-object"><Archive size={20} aria-hidden="true"/><div><span>操作对象</span>
    <strong title={ctl.targets.map(t => t.name).join('、')}>{ctl.targets.length === 1 ? ctl.targets[0].name : `${ctl.targets[0]?.name} 等 ${ctl.targets.length} 个视频`}</strong></div></div>;
  const steps = ctl.mode === 'mark' && <ol className="pv-reject-steps" aria-label="步骤">
    <li data-state={ctl.stage === 'role' ? 'current' : 'done'}>准备收纳处{ctl.stage === 'move' && (ctl.roleDone ? '（本次已准备）' : '（已设置）')}</li>
    <li data-state={ctl.stage === 'move' ? 'current' : 'todo'}>移入视频</li></ol>;

  if (c && ctl.pending) {
    body = <div className="pv-task" role="status"><strong>{c.stage === 'role' ? '正在设置收纳处…' : '正在移入废片…'}</strong><progress aria-label="处理中"/><p className="pv-muted">可以关闭窗口继续浏览，结果会保留在页面顶部。</p><p>请求编号：<code>{c.requestId}</code></p></div>;
  } else if (c && ctl.unresolved) {
    body = <div className="pv-task" role="status"><strong>结果待核对</strong><p>{c.error || r?.error || '没有取得最终结果。原操作可能仍在进行或已经完成。'}</p>
      {!!r?.items?.length && <ItemList items={r.items} targets={ctl.targets}/>}
      <p>请求编号：<code>{c.requestId}</code></p><p className="pv-muted">只会查询原请求，不会重新提交。</p></div>;
    actions = <><button type="button" onClick={() => ctl.setVisible(false)}>稍后处理</button><button type="button" onClick={ctl.forget}>已核对，收起</button><button type="button" className="pv-primary" onClick={() => void ctl.query()}><RefreshCw size={14}/>查询原请求</button></>;
  } else if (c && c.error) {
    body = <p className="pv-error" role="alert">{c.error}</p>;
    actions = <><button type="button" onClick={ctl.hide}>关闭</button><button type="button" className="pv-primary" onClick={ctl.retry}>重新核对</button></>;
  } else if (c && r && c.stage === 'role') {
    const after = r.folderId ?? ctl.rolePlan?.roleChange.afterFolderId ?? null;
    body = <div className="pv-callout" role="status"><strong>{after ? '收纳处已准备' : '已取消废片收纳处'}</strong>
      <span>{after ? `废片收纳处：${folderPath(folders, after) || '新建的“废片”文件夹'}。` : '原目录回到普通文件夹，里面的视频没有移动。'}</span>
      {ctl.mode === 'mark' && <span>视频还没有移动。</span>}</div>;
    actions = ctl.mode === 'mark'
      ? <><button type="button" onClick={ctl.hide}>稍后再移</button><button type="button" className="pv-primary" onClick={ctl.continueToMove}>继续：核对移入影响<ArrowRight size={15}/></button></>
      : <button type="button" className="pv-primary" onClick={ctl.hide}>完成</button>;
  } else if (c && r && c.stage === 'move') {
    const moved = r.items?.filter(i => i.status === 'ready').length ?? (r.status === 'ready' ? ctl.targets.length : 0);
    const unbound = uniqueShots((r.items || []).flatMap(i => (i.unboundShotIds || []).map(id => ({ id, number: id }))));
    body = <div className="pv-callout" data-tone={r.status === 'ready' ? undefined : 'warn'} role="status">
      <strong>{r.status === 'ready' ? `已移入废片：${moved} 个视频` : `部分完成：已移入 ${moved} 个，其余没有移动`}</strong>
      <span>{r.items ? `解除 ${unbound.length} 个镜号的采用（镜号本身保留）。` : ''}{ctl.roleDone ? ' 本次也准备了收纳处。' : ''}</span>
      {!!r.items?.length && <ItemList items={r.items} targets={ctl.targets}/>}</div>;
    actions = <button type="button" className="pv-primary" onClick={ctl.hide}>完成</button>;
  } else if (ctl.stage === 'role') {
    const p = ctl.rolePlan, shots = uniqueShots(p?.affectedShots || []);
    const candidates = folders.filter(f => f.available && f.id !== current);
    body = <>
      {ctl.mode === 'mark' && <p>{current ? `原收纳处“${currentName}”需要核对（目录找不到或不可用），` : '项目还没有废片收纳处，'}先指定一个文件夹作为收纳处，再移入视频。</p>}
      {ctl.mode === 'role' && <p>{current ? <>当前收纳处：<strong>{currentName}</strong>{rejectNeedsCheck(folders, ctl.roles) ? '（需核对）' : ''}</> : '项目还没有废片收纳处。'}</p>}
      <fieldset className="pv-change-file" disabled={busy}><legend>收纳处</legend>
        <label className="pv-check"><input type="radio" name="reject-setup" checked={ctl.setup.kind === 'create'} onChange={() => { ctl.setSetup({ kind: 'create' }); ctl.invalidateRole(); }}/>在项目根目录新建“废片”文件夹</label>
        <label className="pv-check"><input type="radio" name="reject-setup" disabled={!candidates.length} checked={ctl.setup.kind === 'existing'} onChange={() => { ctl.setSetup({ kind: 'existing', folderId: candidates[0]?.id || '' }); ctl.invalidateRole(); }}/>把现有文件夹设为收纳处（文件不搬动）</label>
        {ctl.setup.kind === 'existing' && <label className="pv-field">文件夹<select aria-label="选择收纳处文件夹" value={ctl.setup.folderId} onChange={e => { ctl.setSetup({ kind: 'existing', folderId: e.target.value }); ctl.invalidateRole(); }}>
          {candidates.map(f => <option key={f.id} value={f.id}>{folderPath(folders, f.id)}</option>)}</select></label>}
        {ctl.mode === 'role' && current && <label className="pv-check"><input type="radio" name="reject-setup" checked={ctl.setup.kind === 'clear'} onChange={() => { ctl.setSetup({ kind: 'clear' }); ctl.invalidateRole(); }}/>取消收纳处（不移动、不删除任何文件）</label>}
      </fieldset>
      {ctl.previewError && <p className="pv-error" role="alert">{ctl.previewError}</p>}
      {p && <div className="pv-operation-plan"><h3>核对结果</h3>
        <p>{p.roleChange.afterFolderId || p.roleChange.willCreate
          ? <>{p.roleChange.willCreate ? `将在项目根目录新建“${p.roleChange.name || '废片'}”文件夹，并设为废片收纳处。` : `将把“${folderPath(folders, p.roleChange.afterFolderId)}”设为废片收纳处，里面的文件不搬动。`}
            {p.roleChange.beforeFolderId ? ` 原收纳处“${folderPath(folders, p.roleChange.beforeFolderId)}”不再隐藏，内容保持不变。` : ''}</>
          : `将取消废片收纳处：“${folderPath(folders, p.roleChange.beforeFolderId)}”回到普通文件夹，内容保持不变。`}</p>
        {typeof p.videoCount === 'number' && <p>该文件夹（含子文件夹）现有 {p.videoCount} 个视频，设为收纳处后它们会归入“废片”，不在“全部视频”中显示。</p>}
        <h3>本次将解除采用的精确镜号</h3><p>{shotText(shots) || '没有受影响的采用镜号'}</p>
        {!p.ready && <p className="pv-error" role="alert">后台认为暂时不能执行，请重新核对。</p>}
        <label className="pv-check"><input type="checkbox" checked={ctl.roleOk} disabled={busy || !p.ready} onChange={e => ctl.setRoleOk(e.target.checked)}/>{p.roleChange.afterFolderId || p.roleChange.willCreate ? '确认设置废片收纳处' : '确认取消废片收纳处'}</label>
        {!!shots.length && <label className="pv-check"><input type="checkbox" checked={ctl.unbindOk} disabled={busy} onChange={e => ctl.setUnbindOk(e.target.checked)}/>确认解除 {shotText(shots)} 的采用（镜号本身保留）</label>}
      </div>}
    </>;
    actions = <>
      <button type="button" onClick={ctl.hide}>取消</button>
      <button type="button" className={p ? undefined : 'pv-primary'} disabled={busy || ctl.setup.kind === 'existing' && !ctl.setup.folderId} onClick={() => void ctl.previewRole()}>{ctl.previewBusy ? '正在核对…' : p ? '重新核对' : '核对影响'}</button>
      {p && <button type="button" className={shots.length ? 'pv-danger' : 'pv-primary'} disabled={busy || !p.ready || !ctl.roleOk || !!shots.length && !ctl.unbindOk} onClick={ctl.commitRole}>{p.roleChange.afterFolderId || p.roleChange.willCreate ? '设为收纳处' : '取消收纳处'}</button>}
    </>;
  } else {
    const p = ctl.movePlan, shots = uniqueShots(p?.affectedShots || []);
    const fromSource = uniqueShots(p?.sourceUnbindShots || []), fromOverwrite = uniqueShots(p?.overwriteTargetUnbindShots || []);
    const missingChoice = !!p?.conflicts.some(x => !ctl.choices[x.key]);
    body = <>
      <p>移入废片收纳处“<strong>{currentName}</strong>”。文件会在硬盘上真的移动；如果这些视频已用在外部剪辑工程里，那边可能失去链接。</p>
      {ctl.previewBusy && !p && <p className="pv-muted" role="status">正在核对移入影响…</p>}
      {ctl.previewError && <p className="pv-error" role="alert">{ctl.previewError}</p>}
      {p && <div className="pv-operation-plan"><h3>{p.description || `将移入 ${ctl.targets.length} 个视频`}</h3>
        {!!p.conflicts.length && <><h3>同名冲突</h3>{p.conflicts.map(x => <label className="pv-field" key={x.key}>{x.sourceName || x.name} → {x.targetName}
          <small>覆盖会解除目标视频的采用：{shotText(x.adoptedShots) || '无'}</small>
          <select aria-label={`冲突处理 ${x.name}`} value={ctl.choices[x.key] || ''} disabled={busy} onChange={e => { const v = e.target.value; ctl.setChoices(old => { const n = { ...old }; if (v) n[x.key] = v as ConflictChoice; else delete n[x.key]; return n; }); }}>
            <option value="">请选择</option><option value="rename">保留双方，递增 _0 重命名</option><option value="overwrite">覆盖收纳处里的同名视频</option></select></label>)}
          <button type="button" disabled={busy || missingChoice} onClick={() => void ctl.previewMove()}>按所选冲突方式重新核对</button></>}
        <h3>本次将解除采用的精确镜号</h3>
        <p>{shotText(shots) || '没有受影响的采用镜号'}</p>
        {!!fromSource.length && !!fromOverwrite.length && <p className="pv-muted">其中移入的视频：{shotText(fromSource)}；被覆盖的同名视频：{shotText(fromOverwrite)}。</p>}
        {!!shots.length && <><p className="pv-muted">只解除采用关系，镜号本身保留；之后移回也不会自动恢复，需要到分镜里重新选择。</p>
          <label className="pv-check"><input type="checkbox" checked={ctl.unbindOk} disabled={busy} onChange={e => ctl.setUnbindOk(e.target.checked)}/>我已核对上述镜号，确认解除这些采用关系</label></>}
        {!p.ready && !missingChoice && <p className="pv-error" role="alert">后台认为暂时不能执行，请重新核对。</p>}
      </div>}
    </>;
    actions = <>
      <button type="button" onClick={ctl.hide}>取消</button>
      <button type="button" disabled={busy} onClick={() => void ctl.previewMove()}>{ctl.previewBusy ? '正在核对…' : '重新核对'}</button>
      {p && <button type="button" className={shots.length ? 'pv-danger' : 'pv-primary'} disabled={busy || !p.ready || missingChoice || !!shots.length && !ctl.unbindOk} onClick={ctl.commitMove}>{!!shots.length && <AlertTriangle size={15}/>}移入废片</button>}
    </>;
  }
  return <Modal title={title} locked={false} onClose={ctl.hide} className="pv-folder-operation-modal pv-reject-modal">
    {head}{steps}{body}
    {actions && <ModalActions>{actions}</ModalActions>}
  </Modal>;
}

function ItemList({ items, targets }: { items: NonNullable<BatchReceipt['items']>; targets: RejectTarget[] }) {
  const name = (id: string, fallback?: string) => fallback || targets.find(t => t.id === id)?.name || id;
  return <ul className="pv-reject-items">{items.map(i => <li key={i.sourceId} data-status={i.status}>
    <span>{name(i.sourceId, i.name)}</span><small>{itemText[i.status] || i.status}{i.unboundShotIds?.length ? ` · 解除 ${i.unboundShotIds.length} 个镜号采用` : ''}{i.error ? ` · ${i.error}` : ''}</small></li>)}</ul>;
}
