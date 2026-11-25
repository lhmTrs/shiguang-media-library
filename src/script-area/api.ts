// 剧本区接口路径（合同 v1.1「P = /api/project-scripts/projects/:projectId」；宿主 api 自己补 /api 前缀和库请求头）。
import type { Binding, MapGraph, ObjectRef, RequestError } from './types';

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
