import { useCallback, useEffect, useRef, useState } from 'react';

/*
 * 项目资产图片的桌面操作客户端：把原图文件放进系统剪贴板、批量在访达中显示。
 * 与生成视频页（#46）同一套规则：
 * - 每次点击生成固定 requestId；项目、模式与所选绑定（含版本）在提交时固定。
 * - 慢核验时后台返回进行中回执，前端按原 requestId 只读查询，直到终态。
 * - 回应丢失（没有 HTTP 状态）记为“结果待核对”，只能查询原请求，绝不自动重发。
 */

export type ImageRequest = <T = any>(url: string, body?: unknown, method?: string) => Promise<T>;
export type ImageDesktopKind = 'clipboard' | 'reveal-preview' | 'reveal';
export type ImageCopyMode = 'defaults' | 'references';
export type ImageSelectionItem = { bindingId: string; bindingRevision?: number };
export type ImageDesktopStatus = 'queued' | 'checking' | 'dispatching' | 'running' | 'ready' | 'completed' | 'partial' | 'failed' | 'unknown';
export type ImageDesktopItem = { bindingId?: string; id?: string; name?: string };
export type ImageDesktopSkipped = ImageDesktopItem & { code?: string; reason?: string };
export type ImageDesktopReceipt = {
  requestId: string; projectId?: string; action?: string; status: ImageDesktopStatus;
  processed?: number; total?: number; code?: string; error?: string; reason?: string; ack?: string;
  requestedCount?: number; count?: number;
  copied?: ImageDesktopItem[]; requested?: ImageDesktopItem[]; eligible?: ImageDesktopItem[]; skipped?: ImageDesktopSkipped[];
  previewToken?: string; expiresAt?: string | number; folderCount?: number; folders?: { key: string; label: string; count: number }[];
};
export type ImageDesktopAction = {
  kind: ImageDesktopKind; requestId: string; projectId: string; mode: ImageCopyMode; items: ImageSelectionItem[];
  receipt: ImageDesktopReceipt | null; busy: boolean; unknown: boolean; error: string; code: string;
};
export type ImageCapability = { available?: boolean; code?: string; reason?: string };
export type ImageCapabilities = { version?: number; maxSelection?: number; clipboard?: ImageCapability; revealMany?: ImageCapability };

const pendingStatuses: ImageDesktopStatus[] = ['queued', 'checking', 'dispatching', 'running'];
export const isPending = (r: ImageDesktopReceipt | null) => !!r && pendingStatuses.includes(r.status);
export const actionPending = (a: ImageDesktopAction | null) => !!a && (a.busy || isPending(a.receipt) && !a.unknown && !a.error);
const errorStatus = (e: unknown) => (e as { status?: number }).status;
const errorCode = (e: unknown) => String((e as { code?: string }).code || '');
const message = (e: unknown) => e instanceof Error ? e.message : String(e || '请求失败');

export const NO_CAPABILITY = '后台尚未提供图片文件复制，或正在检查本机桌面能力。';
export function capability(caps: ImageCapabilities | null | undefined, key: 'clipboard' | 'revealMany') {
  const item = caps?.[key];
  return item ? { available: !!item.available, reason: item.available ? '' : item.reason || '当前环境不可用。' } : { available: false, reason: NO_CAPABILITY };
}
export const itemKey = (i: ImageDesktopItem) => i.bindingId || i.id || '';
export function failureText(code?: string) {
  return code === 'PREVIEW_STALE' ? '所选图片在核对之后发生了变化，请重新核对。'
    : code === 'CLIPBOARD_CHANGED' ? '剪贴板在核验期间被其他内容改变，没有覆盖。需要时请再点一次复制。'
    : code === 'NO_VALID_FILES' ? '所选图片都不能使用。'
    : code ? `操作没有完成（${code}）。` : '操作没有完成。';
}
export const skippedText = (items: ImageDesktopSkipped[] = []) => items.map(item => `${item.name || itemKey(item)}：${item.reason || item.code || '不可用'}`);
export const revealDispatched = (r: ImageDesktopReceipt | null) => !!r && r.status !== 'failed' && r.status !== 'unknown' && r.ack === 'dispatched' && (r.count ?? r.requested?.length ?? 0) > 0;

/** 一个项目里同一时间只跑一笔图片桌面操作；新操作只能在上一笔结束或已核对后开始。 */
export function useImageDesktopAction(projectId: string, request: ImageRequest) {
  const [action, setActionState] = useState<ImageDesktopAction | null>(null);
  const ref = useRef<ImageDesktopAction | null>(null);
  const put = useCallback((next: ImageDesktopAction | null) => { ref.current = next; setActionState(next); }, []);
  const requestRef = useRef(request); requestRef.current = request;
  const base = `/project-assets/projects/${encodeURIComponent(projectId)}`;
  useEffect(() => { if (ref.current && ref.current.projectId !== projectId && !actionPending(ref.current) && !ref.current.unknown) put(null); }, [projectId]);

  const update = (requestId: string, patch: Partial<ImageDesktopAction>) => {
    const current = ref.current; if (!current || current.requestId !== requestId) return;
    put({ ...current, ...patch });
  };
  const accept = (requestId: string, receipt: ImageDesktopReceipt) => {
    if (receipt.requestId && receipt.requestId !== requestId) throw Object.assign(Error('回执编号与原请求不一致，请查询原请求。'), { code: 'RECEIPT_MISMATCH' });
    if (receipt.projectId && receipt.projectId !== projectId) throw Object.assign(Error('回执不属于当前项目，请查询原请求。'), { code: 'RECEIPT_MISMATCH' });
    // 按回执 status 判断，不按 HTTP 200：进行中之后查到的终态也可能是 failed / unknown。
    if (receipt.status === 'failed') { update(requestId, { receipt, busy: false, unknown: false, error: receipt.error || receipt.reason || failureText(receipt.code), code: receipt.code || '' }); return; }
    update(requestId, { receipt, busy: false, unknown: receipt.status === 'unknown', error: receipt.status === 'unknown' ? receipt.error || receipt.reason || '' : '', code: receipt.code || '' });
  };
  const fail = (requestId: string, e: unknown) => {
    if (!errorStatus(e)) update(requestId, { busy: false, unknown: true, error: `结果尚未确认：${message(e)}。请查询原请求，不会自动重发。`, code: errorCode(e) });
    else update(requestId, { busy: false, unknown: false, error: message(e), code: errorCode(e) });
  };

  async function start(kind: ImageDesktopKind, mode: ImageCopyMode, items: ImageSelectionItem[], extra: Record<string, unknown> = {}) {
    if (ref.current && (actionPending(ref.current) || ref.current.unknown)) return null;
    const requestId = crypto.randomUUID(), frozen = requestRef.current, fixed = items.map(i => ({ ...i }));
    put({ kind, requestId, projectId, mode, items: fixed, receipt: null, busy: true, unknown: false, error: '', code: '' });
    const path = { clipboard: '/images/clipboard', 'reveal-preview': '/images/reveal/preview', reveal: '/images/reveal' }[kind];
    try { accept(requestId, await frozen<ImageDesktopReceipt>(base + path, { requestId, mode, items: fixed, ...extra }, 'POST')); }
    catch (e) { fail(requestId, e); }
    return requestId;
  }

  /** 只读查询原请求；任何情况下都不重新提交。查询失败只说明“读不到结果”，一律记为待核对。 */
  async function query() {
    const current = ref.current; if (!current || current.busy) return;
    update(current.requestId, { busy: true });
    try { accept(current.requestId, await requestRef.current<ImageDesktopReceipt>(base + `/desktop-actions/${encodeURIComponent(current.requestId)}`)); }
    catch (e) {
      const status = errorStatus(e);
      const text = status === 404 ? '后台暂时没有找到这笔请求的回执。原操作可能还没登记，也可能已经执行，请稍后再查询原请求；不会自动重发。'
        : status ? `查询原请求失败（${status}）：${message(e)}。原操作可能仍在进行或已经完成，请再次查询；不会自动重发。`
        : `查询原请求时连接中断：${message(e)}。原操作可能仍在进行或已经完成，请再次查询；不会自动重发。`;
      update(current.requestId, { busy: false, unknown: true, error: text, code: errorCode(e) });
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
  const clear = (force = false) => { const c = ref.current; if (!c || actionPending(c) || c.unknown && !force) return; put(null); };
  return { action, start, query, clear };
}
