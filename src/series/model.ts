// 剧 → 季 → 集（SERIES-P1）前端数据层：类型、接口调用、由平铺列表组装的目录树。
// 接口合同见 Codex 20261112-1745-SERIES-P1-接口合同（GET /api/projects 附加归组字段，GET /api/project-series 给剧与季）。
import type { Project, ProjectRequest } from "../ProjectManager";

export type GroupedProject = Project & {
  series_id?: string | null; season_id?: string | null; episode_no?: number | null; membership_revision?: number;
};
export type Season = { id: string; series_id: string; season_no: number; label: string | null; revision: number; created_at: number; updated_at: number; next_episode_no: number };
export type Series = { id: string; name: string; software: string; revision: number; created_at: number; updated_at: number; next_season_no: number; next_episode_no: number; seasons: Season[] };
export type Place = { series_id: string | null; season_id: string | null; episode_no: number | null; revision: number };
export type MoveChange = { project_id: string; before: Place; after: Place };
export type MoveConflict = { project_id: string; code: string; series_id?: string; season_id?: string; episode_no?: number; conflicting_project_id?: string };
export type MoveItem = { project_id: string; expected_revision: number; episode_no?: number };
export type MoveTarget = { series_id: string | null; season_id: string | null };
export type MoveReceipt = { request_id: string; changes: MoveChange[]; can_undo: boolean; undo_of?: string };

/** 一个装集的容器：某一季，或剧根（season 为 null）。 */
export type Container = { key: string; series: Series; season: Season | null; episodes: GroupedProject[] };
export type SeriesNode = { series: Series; seasons: Container[]; root: Container; episodeCount: number };
export type Tree = { series: SeriesNode[]; ungrouped: GroupedProject[]; byProject: Map<string, { node: SeriesNode; container: Container } | null> };

/** 季的显示名：有 label 用 label，否则「第 N 季」。 */
export const seasonName = (s: Season) => s.label?.trim() || `第 ${s.season_no} 季`;
export const episodeName = (p: GroupedProject) => p.episode_no == null ? p.name : `第 ${p.episode_no} 集`;
export const containerName = (c: Container) => c.season ? seasonName(c.season) : c.series.name;

export function buildTree(projects: GroupedProject[], seriesList: Series[]): Tree {
  const byProject: Tree["byProject"] = new Map();
  const nodes = seriesList.map(series => {
    const seasons = [...series.seasons].sort((a, b) => a.season_no - b.season_no).map<Container>(season => ({ key: season.id, series, season, episodes: [] }));
    const node: SeriesNode = { series, seasons, root: { key: "root:" + series.id, series, season: null, episodes: [] }, episodeCount: 0 };
    return node;
  });
  const nodeOf = new Map(nodes.map(n => [n.series.id, n]));
  const ungrouped: GroupedProject[] = [];
  for (const p of projects) {
    const node = p.series_id ? nodeOf.get(p.series_id) : undefined;
    if (!node) { ungrouped.push(p); byProject.set(p.id, null); continue; }
    const container = p.season_id ? node.seasons.find(c => c.season?.id === p.season_id) ?? node.root : node.root;
    container.episodes.push(p); node.episodeCount++; byProject.set(p.id, { node, container });
  }
  for (const n of nodes) for (const c of [...n.seasons, n.root]) c.episodes.sort((a, b) => (a.episode_no ?? 0) - (b.episode_no ?? 0) || a.name.localeCompare(b.name, "zh-CN"));
  return { series: nodes, ungrouped, byProject };
}

/** 层级栏/卡片用的显示路径，例如「穿越计 · 第二季 第3集」；独立项目直接用项目名。 */
export function displayPath(tree: Tree, projectId: string, fallback = "") {
  const hit = tree.byProject.get(projectId);
  const p = hit?.container.episodes.find(e => e.id === projectId);
  if (!hit || !p) return fallback;
  return hit.container.season ? `${hit.node.series.name} · ${seasonName(hit.container.season)} 第${p.episode_no}集` : `${hit.node.series.name} · 第${p.episode_no}集`;
}

/** 同一容器内按显示顺序的上一集 / 下一集；到头为 null（不跨季）。 */
export function neighbors(tree: Tree, projectId: string): { previous: GroupedProject | null; next: GroupedProject | null } {
  const hit = tree.byProject.get(projectId);
  if (!hit) return { previous: null, next: null };
  const list = hit.container.episodes, i = list.findIndex(e => e.id === projectId);
  return { previous: i > 0 ? list[i - 1] : null, next: i >= 0 && i < list.length - 1 ? list[i + 1] : null };
}

export const newRequestId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/** 接口调用；路径与请求体按合同。错误由宿主 request 抛出，带 code / status / details。 */
export function seriesApi(request: ProjectRequest) {
  return {
    list: () => request<Series[]>("/project-series"),
    createSeries: (name: string, software?: string) => request<Series>("/project-series", { name, software, request_id: newRequestId() }),
    updateSeries: (s: Series, change: { name?: string; software?: string }) => request<Series>(`/project-series/${s.id}`, { expected_revision: s.revision, ...change }, "PATCH"),
    deleteSeries: (s: Series) => request<{ removed: true }>(`/project-series/${s.id}`, { expected_revision: s.revision }, "DELETE"),
    createSeason: (s: Series, input: { label?: string; season_no?: number } = {}) => request<Season>(`/project-series/${s.id}/seasons`, { request_id: newRequestId(), ...input }),
    updateSeason: (season: Season, change: { label?: string | null; season_no?: number }) => request<Season>(`/project-series/${season.series_id}/seasons/${season.id}`, { expected_revision: season.revision, ...change }, "PATCH"),
    deleteSeason: (season: Season) => request<{ removed: true }>(`/project-series/${season.series_id}/seasons/${season.id}`, { expected_revision: season.revision }, "DELETE"),
    createEpisode: (s: Series, season: Season | null, expectedEpisodeNo: number, requestId = newRequestId(), name?: string) =>
      request<{ request_id: string; project: GroupedProject }>(`/project-series/${s.id}/episodes`, { season_id: season?.id ?? null, expected_episode_no: expectedEpisodeNo, request_id: requestId, ...(name ? { name } : {}) }),
    previewMove: (target: MoveTarget, items: MoveItem[]) => request<{ ready: boolean; changes: MoveChange[]; conflicts: MoveConflict[] }>("/project-series/moves/preview", { target, items }),
    move: (target: MoveTarget, items: MoveItem[], requestId = newRequestId()) => request<MoveReceipt>("/project-series/moves", { target, items, request_id: requestId }),
    undoMove: (originalRequestId: string) => request<MoveReceipt>(`/project-series/moves/${originalRequestId}/undo`, { request_id: newRequestId() }),
    reorderEpisode: (p: GroupedProject, direction: "previous" | "next", neighbor: GroupedProject) => request<MoveReceipt>(`/projects/${p.id}/series/reorder`, { direction, expected_revision: p.membership_revision ?? 0, expected_neighbor_id: neighbor.id, expected_neighbor_revision: neighbor.membership_revision ?? 0, request_id: newRequestId() }),
    reorderSeason: (season: Season, direction: "previous" | "next", neighbor: Season) => request<{ request_id: string; seasons: Season[] }>(`/project-series/${season.series_id}/seasons/${season.id}/reorder`, { direction, expected_revision: season.revision, expected_neighbor_id: neighbor.id, expected_neighbor_revision: neighbor.revision, request_id: newRequestId() }),
    requestStatus: (requestId: string) => request<{ found: boolean; result?: unknown }>(`/project-series/requests/${requestId}`),
  };
}

/** 合同错误码 → 给用户看的话；没有对应就用服务端原文。 */
export const seriesErrorText: Record<string, string> = {
  SERIES_NAME_CONFLICT: "已有同名的剧，换个名字再试",
  PROJECT_NAME_CONFLICT: "项目名已被占用，请改个名字",
  SERIES_STALE: "这部剧或这一季刚被改过，已刷新，请再试一次",
  NEXT_EPISODE_CHANGED: "集号刚被占用（可能在另一个窗口新建了），已刷新为新的下一集",
  EPISODE_NUMBER_CONFLICT: "目标里已有同号的集",
  SEASON_NUMBER_CONFLICT: "这部剧里已有这个季号",
  SERIES_NOT_EMPTY: "剧里还有集，不能删除",
  SEASON_NOT_EMPTY: "这一季还有集，不能删除",
  SERIES_REORDER_CHANGED: "相邻的集刚被改过，已刷新，请再试一次",
  SERIES_UNDO_CONFLICT: "这些集在移动后又被改过，不能整批撤销",
};
export const errorText = (e: unknown) => {
  const err = e as { code?: string; message?: string };
  return (err?.code && seriesErrorText[err.code]) || err?.message || "操作失败";
};
