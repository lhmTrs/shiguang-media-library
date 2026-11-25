// 剧本区接口路径（合同 v1.1「P = /api/project-scripts/projects/:projectId」；宿主 api 自己补 /api 前缀和库请求头）。
import type { Binding, MapGraph, ObjectRef, Paged, RequestError, ScriptRequest } from './types';

export const scriptBase = (projectId: string) => '/project-scripts/projects/' + encodeURIComponent(projectId);
export const qs = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams(); for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString(); return s ? '?' + s : '';
};
export const uuid = () => crypto.randomUUID();
export const errorText = (e: unknown) => e instanceof Error ? e.message : String(e || '请求失败');
export const asRequestError = (e: unknown) => (e instanceof Error ? e : Error(String(e))) as RequestError;

export const timeout = (ms = 15000) => ({ signal: AbortSignal.timeout(ms) });

/** 对象引用 ↔ 地址栏参数「version:ID」。 */
export const refParam = (r?: ObjectRef | null) => r ? r.kind + ':' + r.id : '';
export function parseRef(text: string | null | undefined): ObjectRef | null {
  const m = /^(version|legacy|snapshot):(.+)$/.exec(text ?? '');
  return m ? { kind: m[1] as ObjectRef['kind'], id: m[2] } : null;
}

export const mapRequestBody = (binding: Binding, graph: MapGraph, requestId?: string) => ({ binding, graph, ...(requestId ? { requestId } : {}) });

/** 文件大小：1.2 MB / 34 KB。 */
export function fileSize(bytes: number) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}
export const dateTime = (ms: number | null | undefined) => ms == null ? '' : new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
export const dateOnly = (ms: number | null | undefined) => ms == null ? '' : new Date(ms).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });

/**
 * 稿子的摘要，和后端 GET …/draft 的 contentDigest 同一个算法（合同 v1.1：UTF-8 SHA-256，输入 JSON.stringify([title, content])，十六进制小写）。
 * 版本和快照的摘要后端不给，用它们的标题和正文在这里算；浏览器算不了就返回 null，界面上不写「相同 / 改过」。
 */
export async function contentDigestOf(title: string, content: string): Promise<string | null> {
  try {
    if (!globalThis.crypto?.subtle) return null;
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([title, content])));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

/**
 * 按合同的 offset/limit 分页读，直到拿够 want 条或读完（limit 上限 100）。want 不传就读完全部（最多 50 页，防止接口异常时死循环）。
 * 返回的是同一时刻的一致列表（PR156 独验 P2-1、P2-3）：翻页时如果有新的入库或删除，后面的页会错位，拼出来会重复、漏掉。
 * 所以每页都核对总数没变、id 没重复，读了不止一页时再回头看一眼第一条有没有变；对不上就整份丢掉重读，
 * 最多 3 次，还对不上就报错，让界面保留上次正确的列表、给出重试。
 */
export async function readPages<T extends { id: string }>(request: ScriptRequest, url: string, opts: { want?: number; signal?: AbortSignal } = {}): Promise<{ items: T[]; total: number }> {
  const join = url.includes('?') ? '&' : '?';
  const get = (offset: number, limit: number) => request<Paged<T>>(`${url}${join}offset=${offset}&limit=${limit}`, undefined, undefined, opts.signal ? { signal: opts.signal } : timeout());
  for (let attempt = 0; attempt < 3; attempt++) {
    const items: T[] = [], seen = new Set<string>(); let total: number | null = null, pages = 0, steady = true;
    while (pages < 50) {
      const left = opts.want === undefined ? 100 : Math.min(100, opts.want - items.length);
      if (left <= 0) break;
      const r = await get(items.length, left); pages++;
      if (total !== null && r.total !== total) { steady = false; break; }
      total = r.total;
      for (const it of r.items) { if (seen.has(it.id)) { steady = false; break; } seen.add(it.id); items.push(it); }
      if (!steady || !r.items.length || items.length >= total) break;
    }
    if (steady && pages > 1) { const head = await get(0, 1); steady = head.total === total && (head.items[0]?.id ?? null) === (items[0]?.id ?? null); }
    if (steady) return { items, total: total ?? 0 };
  }
  throw Object.assign(Error('列表在读取的时候又有变化，没能读到一致的结果，请稍后重试'), { code: 'LIST_CHANGED' });
}
