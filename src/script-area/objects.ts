// 一集里的稿件对象：正式版本、迁移基线、草稿快照。版本条、泳道图挂载、试画页的下拉框共用。
import { dateTime, scriptBase, timeout } from './api';
import type { ObjectRef, Paged, ScriptRequest, SnapshotSummary, VersionSummary } from './types';

export type ScriptObjects = { versions: VersionSummary[]; snapshots: SnapshotSummary[] };

/** 版本按正式编号逆序、迁移基线在最后（服务器排好）；快照按冻结时间新到旧。首版各取 100 条。 */
export async function loadObjects(request: ScriptRequest, projectId: string, signal?: AbortSignal): Promise<ScriptObjects> {
  const opts = signal ? { signal } : timeout();
  const [versions, snapshots] = await Promise.all([
    request<Paged<VersionSummary>>(scriptBase(projectId) + '/versions?limit=100', undefined, undefined, opts),
    request<Paged<SnapshotSummary>>(scriptBase(projectId) + '/draft/snapshots?limit=100', undefined, undefined, opts),
  ]);
  return { versions: versions.items, snapshots: snapshots.items };
}

export const versionLabel = (v: VersionSummary) => v.kind === 'legacy' ? '迁移时的稿子' : 'V' + v.versionNo;
export const objectLabel = (o: VersionSummary | SnapshotSummary) =>
  o.kind === 'snapshot' ? `草稿快照（${dateTime(o.createdAt)} · 第 ${o.draftRevision} 次保存的草稿）` : o.kind === 'legacy' ? '迁移时的稿子' : `V${o.versionNo} · ${dateTime(o.finalizedAt)} 定稿`;

export const findObject = (objs: ScriptObjects | null, ref: ObjectRef | null | undefined) =>
  !objs || !ref ? null : ref.kind === 'snapshot' ? objs.snapshots.find(s => s.id === ref.id) ?? null : objs.versions.find(v => v.id === ref.id && v.kind === ref.kind) ?? null;

export const allObjects = (objs: ScriptObjects | null) => objs ? [...objs.versions, ...objs.snapshots] : [];
