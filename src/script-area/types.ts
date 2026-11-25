// 剧本区前端类型：字段名一律照《剧本区接口合同 v1.1》和《数据格式 v1 草案》v1.4。合同改版时这里跟着改。

export type Paged<T> = { items: T[]; total: number; offset: number; limit: number };

export type Draft = { projectId: string; title: string; content: string; revision: number; updatedAt: number | null; contentDigest: string };

export type VersionSummary = {
  id: string; projectId: string; kind: 'version' | 'legacy'; versionNo: number | null; title: string; sourceId: string;
  draftRevision: number; createdAt: number; finalizedAt: number | null;
};
export type VersionDetail = VersionSummary & { content: string };
export type SnapshotSummary = { id: string; projectId: string; kind: 'snapshot'; title: string; sourceId: string; draftRevision: number; createdAt: number };
export type SnapshotDetail = SnapshotSummary & { content: string };

export type MaterialSummary = {
  id: string; projectId: string; ownerType: 'project' | 'series'; ownerId: string; originalFilename: string; contentType: string;
  byteSize: number; sha256: string; createdAt: number; updatedAt: number; revision: number; sourceId: string | null;
  downloadUrl: string; previewUrl: string | null;
};

export type ObjectKind = 'version' | 'legacy' | 'snapshot';
export type ObjectRef = { kind: ObjectKind; id: string };
export type Binding = { target: ObjectRef; before?: ObjectRef };

// ---- 泳道图数据（上传前的原始 graph；renderData.graph 是去掉 quote 的同一结构）----
export type MapRef = { source: string; start: number; end?: number; quote?: string };
export type MapNode = {
  id: string; lane: string; row: number; kind?: 'self' | 'seen' | 'away'; label: string | string[];
  refs?: MapRef[]; old?: MapRef[]; new?: MapRef[];
  ai?: { what?: string; why?: string; unsure?: string };
  change?: 'chg' | 'new' | 'del' | 'minor'; what?: string; why?: string;
};
export type MapEdge = { from: string; to: string; route?: 'auto' | 'v' | 'h' | 'd' | 'hv' | 'vh' | 'leader'; offset?: number };
export type MapGraph = {
  schemaVersion: 1; kind: 'single' | 'diff'; title?: string; subtitle?: string; gist?: string; madeBy?: string;
  sources: { key: string; sourceId: string; label?: string }[];
  versions?: { v1?: { label: string; source: string; short?: string }; v2?: { label: string; source: string; short?: string } };
  lanes: { id: string; name: string; hero?: boolean }[];
  bands?: { row: number; label: string }[];
  nodes: MapNode[];
  edges?: MapEdge[];
};

export type BoundObject = ObjectRef & { versionNo: number | null; title: string; displayLabel: string; at: number | null };
export type MapRenderSource = { key: string; sourceId: string; label: string; kind: 'version' | 'legacy' | 'snapshot' | 'material'; at: number | null; sourceState: 'available' | 'deleted' };
export type MapExcerpt = { source: string; start: number; end: number; lines: { number: number; text: string }[] };
export type RenderData = { graph: MapGraph; binding: { target: BoundObject; before?: BoundObject }; sources: MapRenderSource[]; excerpts: MapExcerpt[] };

export type Issue = { code: string; path: string; message: string; severity: 'error' | 'warning'; candidateLines?: number[] };

export type MapSummary = { id: string; projectId: string; kind: 'single' | 'diff'; title: string; schemaVersion: number; createdAt: number; binding: Binding; isDraftStale: boolean };
export type MapDetail = { map: MapSummary; renderData: RenderData; issues: Issue[] };

/** 宿主请求工具（main.tsx 的 api）：GET 不带 body；FormData 原样交给浏览器。 */
export type ScriptRequest = <T = unknown>(url: string, body?: unknown, method?: string, options?: { signal?: AbortSignal }) => Promise<T>;

/** 宿主请求工具抛出的错误：合同错误形状 {code,message,error,details?,issues?} 加 HTTP 状态。 */
export type RequestError = Error & { code?: string; status?: number; details?: Record<string, unknown>; issues?: Issue[] };
