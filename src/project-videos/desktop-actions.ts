import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectVideoCapabilities, ProjectVideoRequest } from './types';

/*
 * 生成视频页的桌面操作客户端（合同 v1，#46）：复制到系统剪贴板、批量在访达中显示。
 * - 每次点击生成固定 requestId；项目、ids 顺序与动作在提交时固定。
 * - 慢核验时后台返回 202 与进度，前端按原 requestId 只读查询，直到终态。
 * - 回应丢失（没有 HTTP 状态）记为“结果待核对”，只能查询原请求，绝不自动重发。
 */

export type DesktopActionKind = 'clipboard' | 'reveal-preview' | 'reveal';
export type DesktopStatus = 'queued' | 'checking' | 'dispatching' | 'completed' | 'partial' | 'failed' | 'unknown';
export type DesktopItem = { id: string; name?: string; managed?: boolean };
export type DesktopSkipped = { id: string; name?: string; code: string; reason: string };
export type DesktopReceipt = {
  requestId: string; projectId?: string; action?: string; status: DesktopStatus;
  processed?: number; total?: number; statusUrl?: string; code?: string; error?: string;
  requestedCount?: number; count?: number;
  copied?: DesktopItem[]; requested?: DesktopItem[]; eligible?: DesktopItem[]; skipped?: DesktopSkipped[];
  previewToken?: string; expiresAt?: string | number; folderCount?: number; folders?: { key: string; label: string; count: number }[];
};
export type DesktopAction = {
  kind: DesktopActionKind; requestId: string; projectId: string; ids: string[];
  receipt: DesktopReceipt | null; busy: boolean; unknown: boolean; error: string; code: string;
};

const pendingStatuses: DesktopStatus[] = ['queued', 'checking', 'dispatching'];
export const isPending = (r: DesktopReceipt | null) => !!r && pendingStatuses.includes(r.status);
const terminalReceipt = (r: DesktopReceipt | null) => !!r && !pendingStatuses.includes(r.status);
const errorStatus = (e: unknown) => (e as { status?: number }).status;
const errorCode = (e: unknown) => String((e as { code?: string }).code || '');
const message = (e: unknown) => e instanceof Error ? e.message : String(e || '请求失败');

export const NO_CAPABILITY = '后台尚未提供此功能，或正在检查本机桌面能力。';
export function capability(caps: ProjectVideoCapabilities | undefined, key: 'clipboard' | 'revealMany') {
  const item = caps?.[key];
  return item ? { available: !!item.available, reason: item.available ? '' : item.reason || '当前环境不可用。' } : { available: false, reason: NO_CAPABILITY };
}

/** 一个页面会话（一个项目）里同一时间只跑一笔桌面操作；新操作只能在上一笔结束或已核对后开始。 */
export function useDesktopAction(projectId: string, request: ProjectVideoRequest) {
  const [action, setActionState] = useState<DesktopAction | null>(null);
  const ref = useRef<DesktopAction | null>(null);
  const put = useCallback((next: DesktopAction | null) => { ref.current = next; setActionState(next); }, []);
  const requestRef = useRef(request); requestRef.current = request;
  const base = `/project-videos/projects/${encodeURIComponent(projectId)}`;

  const update = (requestId: string, patch: Partial<DesktopAction>) => {
    const current = ref.current; if (!current || current.requestId !== requestId) return;
    put({ ...current, ...patch });
  };
  const accept = (requestId: string, receipt: DesktopReceipt) => {
    if (receipt.requestId && receipt.requestId !== requestId) throw Object.assign(Error('回执编号与原请求不一致，请查询原请求。'), { code: 'RECEIPT_MISMATCH' });
    if (receipt.projectId && receipt.projectId !== projectId) throw Object.assign(Error('回执不属于当前项目，请查询原请求。'), { code: 'RECEIPT_MISMATCH' });
    update(requestId, { receipt, busy: false, unknown: receipt.status === 'unknown', error: '', code: receipt.code || '' });
  };
  const fail = (requestId: string, e: unknown) => {
    // 没有 HTTP 状态 = 回应丢失：动作可能已在桌面生效，只能查询，不能重发。
    if (!errorStatus(e)) update(requestId, { busy: false, unknown: true, error: `结果尚未确认：${message(e)}。请查询原请求，不会自动重发。`, code: errorCode(e) });
    else update(requestId, { busy: false, unknown: false, error: message(e), code: errorCode(e) });
  };

  async function start(kind: DesktopActionKind, ids: string[], extra: Record<string, unknown> = {}) {
    if (ref.current && (ref.current.busy || isPending(ref.current.receipt) || ref.current.unknown)) return null;
    const requestId = crypto.randomUUID(), frozen = requestRef.current;
    put({ kind, requestId, projectId, ids, receipt: null, busy: true, unknown: false, error: '', code: '' });
    const path = kind === 'clipboard' ? '/videos/clipboard' : kind === 'reveal-preview' ? '/videos/reveal/preview' : '/videos/reveal';
    try { accept(requestId, await frozen<DesktopReceipt>(base + path, { requestId, ids, ...extra }, 'POST')); }
    catch (e) { fail(requestId, e); }
    return requestId;
  }

  /** 只读查询原请求；任何情况下都不重新提交。 */
  async function query() {
    const current = ref.current; if (!current || current.busy) return;
    update(current.requestId, { busy: true });
    try { accept(current.requestId, await requestRef.current<DesktopReceipt>(base + `/desktop-actions/${encodeURIComponent(current.requestId)}`)); }
    catch (e) {
      if (errorStatus(e) === 404) update(current.requestId, { busy: false, unknown: true, error: '后台没有找到这笔请求的回执；它可能没有被接收。请核对结果后再决定是否重新操作，不会自动重发。', code: errorCode(e) });
      else fail(current.requestId, e);
    }
  }

  const receipt = action?.receipt || null;
  useEffect(() => {
    if (!action || action.busy || action.unknown || action.error || !isPending(receipt)) return;
    const timer = window.setTimeout(() => { void query(); }, 1200);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action]);

  /** 收起结果。结果待核对时只有用户明确表示“已核对”（force）才收起；进行中的请求不能收起。 */
  const clear = (force = false) => { const c = ref.current; if (!c || c.busy || isPending(c.receipt) || c.unknown && !force) return; put(null); };
  const settled = !action || (!action.busy && !action.unknown && (terminalReceipt(action.receipt) || !!action.error));
  return { action, start, query, clear, settled };
}

export const skippedText = (items: DesktopSkipped[] = []) => items.map(item => `${item.name || item.id}：${item.reason || item.code}`);
