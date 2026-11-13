import './project-folders.css';
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, FileUp, Folder, FolderKanban, MoreHorizontal, Plus, X } from "lucide-react";
import { useFeedbackToast } from '../global-feedback';
import { ProjectEditor, type ProjectRequest } from '../ProjectManager';
import { TimelineImportDialog } from '../TimelineImportDialog';
import { softwareNames } from '../ProjectUsage';
import { AgentShare } from '../AgentShare';
import { Modal } from './Modal';
import { OrganizeDialog } from './OrganizeDialog';
import { buildTree, errorText, seasonName, seriesApi, type AttributeGroupChoice, type AttributePlan, type Container, type GroupedProject, type MoveConflict, type MoveItem, type MoveReceipt, type MoveTarget, type Season, type Series, type SeriesNode } from './model'
import { AttributePlanEditor, needsAttributeReview } from './AttributePlanEditor';;

// 目录式项目页（SERIES-P1，原型 ⑤⑥⑦⑨；改版 R1/R2/R4）：根目录 = 剧文件夹 + 未分组项目；剧里先季后散放集；季里是集。
// 卡片一律矮卡片；剧 / 季单击进入；集单击选中、双击打开素材使用、右键打开其他页面与整理操作。
export type FolderPage = 'usage' | 'assets' | 'videos' | 'storyboard';
export type ProjectFoldersProps = {
  projects: GroupedProject[]; series: Series[]; seriesChanged: () => void;
  activeId: string; select: (id: string) => boolean | void; request: ProjectRequest; changed: (id?: string) => void;
  openPage: (page: FolderPage, projectId: string) => void;
  /** 当前素材库的稳定 ID。目录位置与「刚新建的剧」按库分开存；未知时只放内存、不读不写。 */
  libraryId?: string;
  /** 第二期 P2a：季的「本季设定…」。宿主核对归组、走切项目保护后打开资产页的本季设定；不传则不显示。 */
  onOpenSeasonSettings?: (seasonId: string, projectId: string, signal: AbortSignal) => void;
};
type Loc = { level: 'root' } | { level: 'series'; seriesId: string } | { level: 'season'; seriesId: string; seasonId: string };
type Sort = 'updated' | 'name' | 'created';
type MenuBody = { kind: 'episode'; project: GroupedProject; container: Container | null } | { kind: 'season'; season: Season; node: SeriesNode } | { kind: 'series'; node: SeriesNode } | { kind: 'new' };
type Menu = { x: number; y: number } & MenuBody;
type NumberRow = { project: GroupedProject; episode_no: number };
type Dialog =
  | { type: 'series'; series?: Series }
  | { type: 'season'; season: Season }
  | { type: 'numbers'; target: MoveTarget; targetName: string; rows: NumberRow[]; conflicts: MoveConflict[] }
  | { type: 'moveTo'; ids: string[] }
  | { type: 'episodeName'; node: SeriesNode; container: Container; expected: number }
  | { type: 'project'; project: GroupedProject | null }
  | { type: 'xml' }
  | { type: 'organize' }
  | { type: 'share'; project: GroupedProject }
  | { type: 'attrMap'; target: MoveTarget; targetName: string; rows: { project: GroupedProject; episode_no?: number }[]; items: MoveItem[]; plan: AttributePlan; ready: boolean; note?: string };
type Toast = { text: string; undo?: string };

const LOC_KEY = 'shiguang.projectFolders.loc', SORT_KEY = 'shiguang.projectFolders.sort', PENDING_KEY = 'shiguang.projectFolders.pendingSeries', DRAG_TYPE = 'text/x-shiguang-projects';
/** 刚新建、还没出现在剧列表快照里的剧最多临时保留这么久；过期仍不在就当作已删除。 */
const PENDING_MS = 30000;
type PendingSeries = { series: Series; until: number };
const readSession = <T,>(key: string, fallback: T): T => { try { const v = sessionStorage.getItem(key); return v ? JSON.parse(v) as T : fallback; } catch { return fallback; } };
const writeSession = (key: string, v: unknown) => { try { sessionStorage.setItem(key, JSON.stringify(v)); } catch { /* 隐私模式等：只在内存里 */ } };
const pages: { page: FolderPage; name: string }[] = [{ page: 'usage', name: '素材使用' }, { page: 'assets', name: '项目资产' }, { page: 'videos', name: '生成视频' }, { page: 'storyboard', name: '分镜' }];
const nextNo = (c: Container) => c.season ? c.season.next_episode_no : c.series.next_episode_no;
/** 新建时系统起的名字；不一样就在卡片上用小字显示项目原名。 */
const autoName = (c: Container, p: GroupedProject) => c.season ? `${c.series.name} 第${c.season.season_no}季 第${p.episode_no}集` : `${c.series.name} 第${p.episode_no}集`;
const targetOf = (c: Container): MoveTarget => ({ series_id: c.series.id, season_id: c.season?.id ?? null });
/** 双击习惯：进入文件夹后紧跟的第二下点击 / 双击不应落到新页面的卡片上。 */
const NAV_GUARD_MS = 600;
const FLASH_MS = 1200;
const FolderIcon = () => <svg className="pf-folder-icon" width="22" height="18" viewBox="0 0 34 28" aria-hidden="true"><path d="M2 5a3 3 0 0 1 3-3h8l3 3h13a3 3 0 0 1 3 3v15a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3z"/></svg>;

export function ProjectFolders({ projects, series, seriesChanged, activeId, select, request, changed, openPage, libraryId = '', onOpenSeasonSettings }: ProjectFoldersProps) {
  const locKey = libraryId ? `${LOC_KEY}:${libraryId}` : '', pendingKey = libraryId ? `${PENDING_KEY}:${libraryId}` : '';
  const api = useMemo(() => seriesApi(request), [request]);
  // 新建剧成功后、列表刷新前：用 POST 返回的剧临时并入目录，并存到 sessionStorage，离开目录页再回来也还在。
  const [pending, setPendingState] = useState<PendingSeries | null>(() => pendingKey ? readSession<PendingSeries | null>(pendingKey, null) : null);
  const setPending = (p: PendingSeries | null) => { setPendingState(p); if (!pendingKey) return; if (p) writeSession(pendingKey, p); else { try { sessionStorage.removeItem(pendingKey); } catch { /* 忽略 */ } } };
  const pendingLive = pending && Date.now() < pending.until && !series.some(s => s.id === pending.series.id) ? pending : null;
  useEffect(() => {
    if (!pending) return;
    if (series.some(s => s.id === pending.series.id) || Date.now() >= pending.until) { setPending(null); return; }
    const t = setTimeout(() => setPendingState(p => p && { ...p }), pending.until - Date.now() + 10); return () => clearTimeout(t);
  }, [pending, series]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const reset = () => { setPendingState(null); setLocState({ level: 'root' }); }; window.addEventListener('shiguang-library-identity-changed', reset); return () => window.removeEventListener('shiguang-library-identity-changed', reset); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const loadedFor = useRef(libraryId);
  useEffect(() => {
    try { sessionStorage.removeItem(LOC_KEY); sessionStorage.removeItem(PENDING_KEY); } catch { /* 旧版本未分库的记录，丢弃 */ }
    if (loadedFor.current === libraryId) return;
    loadedFor.current = libraryId; locatedFor.current = ''; selfSelect.current = ''; // 换库：按新库的当前项目重新定位，旧标记作废
    setLocState(locKey ? readSession<Loc>(locKey, { level: 'root' }) : { level: 'root' });
    setPendingState(pendingKey ? readSession<PendingSeries | null>(pendingKey, null) : null);
    setSelected([]); setMenu(null);
  }, [libraryId]); // eslint-disable-line react-hooks/exhaustive-deps
  const tree = useMemo(() => buildTree(projects, pendingLive ? [...series, pendingLive.series] : series), [projects, series, pendingLive]);
  const [loc, setLocState] = useState<Loc>(() => locKey ? readSession<Loc>(locKey, { level: 'root' }) : { level: 'root' });
  const [sort, setSortState] = useState<Sort>(() => readSession<Sort>(SORT_KEY, 'updated'));
  const [selected, setSelected] = useState<string[]>([]), anchor = useRef<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null), [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [toast, setToast] = useState<Toast | null>(null);
  const [dropKey, setDropKey] = useState(''), [dragCount, setDragCount] = useState(0);
  const [flash, setFlash] = useState<string[]>([]), navAt = useRef(0);
  const flashCards = (ids: string[]) => setFlash(ids);
  useEffect(() => { if (!flash.length) return; document.querySelector('.pf [data-flash]')?.scrollIntoView?.({ block: 'nearest' }); const t = setTimeout(() => setFlash([]), FLASH_MS); return () => clearTimeout(t); }, [flash]);
  useFeedbackToast(error, { source: '项目管理' });
  const setLoc = (next: Loc) => { navAt.current = Date.now(); setLocState(next); if (locKey) writeSession(locKey, next); setSelected([]); anchor.current = null; setMenu(null); };
  const justNavigated = () => Date.now() - navAt.current < NAV_GUARD_MS;
  const setSort = (s: Sort) => { setSortState(s); writeSession(SORT_KEY, s); };

  const node = loc.level === 'root' ? undefined : tree.series.find(n => n.series.id === loc.seriesId);
  // 季菜单跳转在宿主核对归组期间可被取消：再发一次、换目录（面包屑 / 进子目录）、换库或离开本页都作废旧跳转，迟到的响应不再切集
  const seasonJump = useRef<AbortController | null>(null);
  const cancelSeasonJump = () => { seasonJump.current?.abort(); seasonJump.current = null; };
  useEffect(() => cancelSeasonJump, []);
  useEffect(() => { cancelSeasonJump(); }, [JSON.stringify(loc), libraryId]); // eslint-disable-line react-hooks/exhaustive-deps
  const openSeasonSettings = (seasonId: string, projectId: string) => {
    if (!onOpenSeasonSettings) return; cancelSeasonJump();
    const jump = new AbortController(); seasonJump.current = jump; onOpenSeasonSettings(seasonId, projectId, jump.signal);
  };
  const seasonContainer = loc.level === 'season' ? node?.seasons.find(c => c.season?.id === loc.seasonId) : undefined;
  // 当前位置失效（剧或季被删、换了库）就回到上一层。刚新建的剧已并入 tree，不会被误判。
  useEffect(() => {
    if (loc.level !== 'root' && !node) setLoc({ level: 'root' });
    else if (loc.level === 'season' && node && !seasonContainer) setLoc({ level: 'series', seriesId: node.series.id });
  }, [loc, node, seasonContainer]); // eslint-disable-line react-hooks/exhaustive-deps
  // 项目页跟着顶栏走（方案 A）：进入项目页、或顶栏换了当前项目时，打开当前项目所在的那一层（季 / 剧 / 最外层），
  // 并高亮、滚到它的卡片。在页里手动换目录不会被拉回；在当前层里点卡片换当前项目不跳也不闪；把当前集拖到别处也不跟。
  const locatedFor = useRef('');
  // 本页里点卡片 / 新建集换的当前项目：卡片就在眼前，不跳不闪。顶栏或别处换的：同层也要闪一下并滚到它（可能在屏外）
  const selfSelect = useRef('');
  // 只为宿主接受了的切换留标记：取消未保存提示（返回 false）时清掉，否则下一次顶栏切到同一项目会被误当成页内点选
  const selectHere = (id: string) => { selfSelect.current = id; if (select(id) === false) selfSelect.current = ''; };
  useEffect(() => {
    if (!activeId || locatedFor.current === activeId) return;
    const p = projects.find(x => x.id === activeId); if (!p) return; // 列表还没到：等数据到了再定位
    const sNode = p.series_id ? tree.series.find(n => n.series.id === p.series_id) : undefined;
    if (p.series_id && !sNode) return; // 剧的数据还没到
    const entry = !locatedFor.current; locatedFor.current = activeId;
    const target: Loc = !sNode ? { level: 'root' }
      : p.season_id && sNode.seasons.some(c => c.season?.id === p.season_id) ? { level: 'season', seriesId: sNode.series.id, seasonId: p.season_id }
      : { level: 'series', seriesId: sNode.series.id };
    const same = JSON.stringify(target) === JSON.stringify(loc), fromHere = selfSelect.current === activeId;
    selfSelect.current = '';
    if (!same) setLoc(target);
    if (!same || entry || !fromHere) flashCards([p.id]);
  }, [activeId, projects, tree]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 8000); return () => clearTimeout(t); }, [toast]);
  useEffect(() => { if (!menu) return; const close = () => setMenu(null); window.addEventListener('click', close); window.addEventListener('blur', close); return () => { window.removeEventListener('click', close); window.removeEventListener('blur', close); }; }, [menu]);

  async function run(action: () => Promise<void>) { setBusy(true); setError(''); setMenu(null); try { await action(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }
  const refresh = (id?: string) => { seriesChanged(); changed(id); };

  // 当前视图里可多选的卡片（集或未分组项目），按显示顺序。
  const sortedSeries = useMemo(() => [...tree.series].sort((a, b) => sort === 'name' ? a.series.name.localeCompare(b.series.name, 'zh-CN') : sort === 'created' ? b.series.created_at - a.series.created_at : b.series.updated_at - a.series.updated_at), [tree, sort]);
  const sortedUngrouped = useMemo(() => [...tree.ungrouped].sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : sort === 'created' ? (b.created_at ?? 0) - (a.created_at ?? 0) : (b.updated_at ?? 0) - (a.updated_at ?? 0)), [tree, sort]);
  const visible: GroupedProject[] = loc.level === 'root' ? sortedUngrouped : loc.level === 'series' ? node?.root.episodes ?? [] : seasonContainer?.episodes ?? [];

  function clickCard(e: MouseEvent, p: GroupedProject) {
    if (e.detail > 1 && justNavigated()) return;
    if (e.metaKey || e.ctrlKey) { setSelected(s => s.includes(p.id) ? s.filter(id => id !== p.id) : [...s, p.id]); anchor.current = p.id; return; }
    if (e.shiftKey && anchor.current) {
      const a = visible.findIndex(v => v.id === anchor.current), b = visible.findIndex(v => v.id === p.id);
      if (a >= 0 && b >= 0) { setSelected(visible.slice(Math.min(a, b), Math.max(a, b) + 1).map(v => v.id)); return; }
    }
    setSelected([p.id]); anchor.current = p.id; if (p.id !== activeId) selectHere(p.id);
  }
  function gridKeys(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && visible.length) { e.preventDefault(); setSelected(visible.map(v => v.id)); }
    else if (e.key === 'Escape') { setSelected([]); setMenu(null); }
  }

  // —— 移动：拖进文件夹、移到…、改集号 ——
  // 维度剧内统一（合同 v1 · A3）：跨剧（放进剧、移出剧、剧之间）先预览维度计划；有要你决定的项才弹「维度对应」，
  // 否则带凭证直接移动。同剧换季、改集号不涉及维度，照旧。改了维度归属的移动不能一键撤销。
  /** 预览或移动返回的冲突：剧级阻断（如目标剧还没统一维度，没有具体项目）关掉窗口、说明原因，归属不变；
   *  具体项目的集号冲突才进「集号冲突」窗口。 */
  function showConflicts(conflicts: MoveConflict[], target: MoveTarget, targetName: string, rows: { project: GroupedProject; episode_no?: number }[]) {
    const blocker = conflicts.find(c => !c.project_id);
    if (blocker) {
      setDialog(null);
      // 不带 code：errorText 会优先用通用文案，盖掉这里带剧名的说明
      throw Error(blocker.code === 'ATTRIBUTE_ALIGNMENT_REQUIRED'
        ? `「${targetName}」的人物属性维度还没统一，这次没有移动。请先在项目资产里切到这部剧的「全剧」视图，点「查看并统一」，再放进来。`
        : errorText({ code: blocker.code }) + '（这次没有移动）');
    }
    setDialog({ type: 'numbers', target, targetName, conflicts, rows: rows.map(r => ({ project: r.project, episode_no: r.episode_no ?? r.project.episode_no ?? 1 })) });
  }
  /** 维度对应窗口重新预览：成功就换上新计划和新凭证；回来的是冲突或已没有维度计划时，旧凭证作废、窗口关掉。 */
  async function rePreviewMove(d: Extract<Dialog, { type: 'attrMap' }>, choices: AttributeGroupChoice[] | undefined, note?: string) {
    let pv;
    try { pv = await api.previewMove(d.target, d.items, choices); }
    catch (e) { const bad = e as { status?: number; code?: string }; if (!choices || (bad.code !== 'ATTRIBUTE_CHOICES_INVALID' && bad.status !== 422)) throw e; pv = await api.previewMove(d.target, d.items); note = (note ? note + '；' : '') + '要决定的项也变了，已按默认重新列出'; }
    if (pv.conflicts?.length) { showConflicts(pv.conflicts, d.target, d.targetName, d.rows); return; }
    if (!pv.attribute_plan) { setDialog(null); throw Error('情况刚变了，这次移动已不涉及维度对应；没有移动，请再操作一次'); }
    setDialog({ ...d, plan: pv.attribute_plan, ready: pv.ready, note });
  }
  async function confirmAttrMove(d: Extract<Dialog, { type: 'attrMap' }>) {
    try { finishMove(await api.move(d.target, d.items, undefined, { token: d.plan.preview_token, choices: d.plan.choices }), d.target, d.targetName, d.rows.length, d.plan); }
    catch (e) {
      const err = e as { code?: string; details?: { conflicts?: MoveConflict[] } };
      if (err.details?.conflicts?.length) { showConflicts(err.details.conflicts, d.target, d.targetName, d.rows); return; }
      // 凭证过期：丢掉旧凭证，按屏幕上的选择重新预览，让用户看着新结果再确认一次；不自动提交
      if (['ATTRIBUTE_ALIGNMENT_STALE', 'ATTRIBUTE_PREVIEW_REQUIRED', 'ATTRIBUTE_CONTEXT_STALE'].includes(err.code ?? '')) {
        setDialog({ ...d, ready: false, note: '维度或分数刚有变化，正在按最新情况重新核对…' });
        try { await rePreviewMove(d, d.plan.choices, '维度或分数刚有变化，下面已按最新情况重新核对，这次没有移动；请看过后再确认'); }
        catch (e2) { setDialog(null); throw e2; }
        return;
      }
      throw e;
    }
  }
  async function move(target: MoveTarget, targetName: string, rows: { project: GroupedProject; episode_no?: number }[]) {
    const items: MoveItem[] = rows.map(r => ({ project_id: r.project.id, expected_revision: r.project.membership_revision ?? 0, ...(r.episode_no != null && target.series_id ? { episode_no: r.episode_no } : {}) }));
    let attribute: { token: string; choices: AttributeGroupChoice[] } | undefined, plan: AttributePlan | undefined;
    try {
      if (rows.some(r => (r.project.series_id ?? null) !== target.series_id)) {
        const pv = await api.previewMove(target, items);
        if (pv.conflicts?.length) { showConflicts(pv.conflicts, target, targetName, rows); return; }
        plan = pv.attribute_plan;
        if (plan && needsAttributeReview(plan, pv.ready)) { setDialog({ type: 'attrMap', target, targetName, rows, items, plan, ready: pv.ready }); return; }
        if (plan) attribute = { token: plan.preview_token, choices: plan.choices };
      }
      finishMove(await api.move(target, items, undefined, attribute), target, targetName, rows.length, plan);
    } catch (e) {
      const conflicts = (e as { details?: { conflicts?: MoveConflict[] } }).details?.conflicts;
      if (!conflicts?.length) throw e;
      showConflicts(conflicts, target, targetName, rows);
    }
  }
  function finishMove(receipt: MoveReceipt, target: MoveTarget, targetName: string, count: number, plan?: AttributePlan) {
    setDialog(null); setSelected([]); refresh(); flashCards(target.season_id ? [target.season_id] : target.series_id ? ['series:' + target.series_id] : receipt.changes.map(c => c.project_id));
    const modes = new Set((plan?.groups ?? []).map(g => g.mode));
    const attrNote = modes.has('map_to_series') ? '，人物属性维度已改用这部剧的' : modes.has('copy_to_standalone') ? '，已复制一份全剧维度给移出的集' : '';
    const noUndo = !receipt.can_undo && receipt.undo_disabled_reason === 'ATTRIBUTE_CONFIGURATION_CHANGED' ? '（改了维度，不能一键撤销，可以再挪回来）' : '';
    setToast({ text: (target.series_id ? `已把 ${count} 集移到「${targetName}」` : `已把 ${count} 个项目移出剧`) + attrNote + noUndo, undo: receipt.can_undo ? receipt.request_id : undefined });
  }
  function startMove(target: MoveTarget, targetName: string, container: Container | null, ids: string[]) {
    const rows = ids.map(id => projects.find(p => p.id === id)).filter((p): p is GroupedProject => !!p)
      .filter(p => p.series_id !== target.series_id || (p.season_id ?? null) !== target.season_id);
    if (!rows.length) return;
    // 第一次归入剧的项目没有集号，需要先填号；其余带原号直接移。
    if (target.series_id && rows.some(p => p.episode_no == null)) {
      let n = container ? nextNo(container) : 1;
      setDialog({ type: 'numbers', target, targetName, conflicts: [], rows: rows.map(p => ({ project: p, episode_no: p.episode_no ?? n++ })) });
      return;
    }
    void run(() => move(target, targetName, rows.map(p => ({ project: p }))));
  }
  const dragIds = (e: DragEvent): string[] => { try { return JSON.parse(e.dataTransfer.getData(DRAG_TYPE) || '[]'); } catch { return []; } };
  const dropProps = (key: string, target: MoveTarget, name: string, container: Container | null) => ({
    onDragOver: (e: DragEvent) => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropKey(key); } },
    onDragLeave: () => setDropKey(k => k === key ? '' : k),
    onDrop: (e: DragEvent) => { e.preventDefault(); setDropKey(''); setDragCount(0); startMove(target, name, container, dragIds(e)); },
    'data-drop': dropKey === key ? 'over' : undefined,
  });
  const dragProps = (p: GroupedProject) => ({
    draggable: !busy,
    onDragStart: (e: DragEvent) => { const ids = selected.includes(p.id) ? selected : [p.id]; if (!selected.includes(p.id)) setSelected([p.id]); setDragCount(ids.length); e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids)); e.dataTransfer.effectAllowed = 'move'; },
    onDragEnd: () => { setDropKey(''); setDragCount(0); },
  });

  // —— 新建 ——
  function createEpisode(n: SeriesNode, c: Container, name?: string) {
    const expected = nextNo(c);
    void run(async () => {
      try { const r = await api.createEpisode(n.series, c.season, expected, undefined, name); setDialog(null); refresh(r.project.id); selectHere(r.project.id); setSelected([r.project.id]); flashCards([r.project.id]); setToast({ text: `已新建「${r.project.name}」` }); }
      catch (e) {
        const code = (e as { code?: string }).code;
        if (code === 'PROJECT_NAME_CONFLICT') { setDialog({ type: 'episodeName', node: n, container: c, expected }); return; }
        if (code === 'NEXT_EPISODE_CHANGED') seriesChanged();
        throw e;
      }
    });
  }
  const createSeason = (n: SeriesNode) => void run(async () => { const s = await api.createSeason(n.series); seriesChanged(); flashCards([s.id]); setToast({ text: `已新建「${seasonName(s)}」` }); });

  // —— 菜单动作 ——
  function swapEpisode(p: GroupedProject, c: Container, direction: 'previous' | 'next') {
    const i = c.episodes.findIndex(e => e.id === p.id), neighbor = c.episodes[direction === 'previous' ? i - 1 : i + 1];
    if (!neighbor) return;
    void run(async () => { await api.reorderEpisode(p, direction, neighbor); refresh(); setToast({ text: `已交换第 ${Math.min(p.episode_no ?? 0, neighbor.episode_no ?? 0)}、${Math.max(p.episode_no ?? 0, neighbor.episode_no ?? 0)} 集` }); });
  }
  function swapSeason(s: Season, n: SeriesNode, direction: 'previous' | 'next') {
    const list = n.seasons.map(c => c.season!), i = list.findIndex(x => x.id === s.id), neighbor = list[direction === 'previous' ? i - 1 : i + 1];
    if (!neighbor) return;
    void run(async () => { await api.reorderSeason(s, direction, neighbor); seriesChanged(); });
  }
  const deleteProject = (p: GroupedProject) => { if (window.confirm(`删除项目“${p.name}”及其使用记录？不会删除原文件。`)) void run(async () => { await request(`/projects/${p.id}`, {}, 'DELETE'); refresh(''); }); };
  const deleteSeries = (n: SeriesNode) => { if (window.confirm(`删除剧“${n.series.name}”？只有没有任何集时才能删除。`)) void run(async () => { await api.deleteSeries(n.series); if (pending?.series.id === n.series.id) setPending(null); setLoc({ level: 'root' }); seriesChanged(); }); };
  const deleteSeason = (s: Season) => { if (window.confirm(`删除「${seasonName(s)}」？只有空季才能删除。`)) void run(async () => { await api.deleteSeason(s); seriesChanged(); }); };
  const undo = (id: string) => void run(async () => { await api.undoMove(id); setToast({ text: '已撤销这次移动' }); refresh(); });
  /** 菜单按实际大小放：放不下就往上挪，再不够就贴着窗口边、在菜单里滚动（max-height 由样式限制）。 */
  const placeMenu = (el: HTMLDivElement | null) => {
    if (!el || !menu) return;
    const margin = 8, w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.max(margin, Math.min(menu.x, window.innerWidth - w - margin)) + 'px';
    el.style.top = Math.max(margin, Math.min(menu.y, window.innerHeight - h - margin)) + 'px';
  };
  const openMenu = (e: MouseEvent, m: MenuBody) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, ...m }); };

  // —— 卡片（R1/R2/R4：矮卡片，状态各用一种手段） ——
  const containerLabel = (c: Container) => c.season ? `${c.series.name} ${seasonName(c.season)}` : c.series.name;
  const counts = (p: GroupedProject) => p.candidates || p.used ? [p.candidates ? `候选 ${p.candidates}` : '', p.used ? `已使用 ${p.used}` : ''].filter(Boolean).join(' · ') : '暂无素材';
  const episodeSub = (p: GroupedProject, c: Container | null) => [c && p.name !== autoName(c, p) ? p.name : '', !c && p.software ? softwareNames[p.software] : '', counts(p)].filter(Boolean).join(' · ');
  const episodeCard = (p: GroupedProject, c: Container | null) => {
    const current = p.id === activeId, picked = selected.includes(p.id), title = c ? `第 ${p.episode_no} 集` : p.name;
    // 只单击选中当前这一集时，绿框已经说明一切；多选（或选中的不是当前集）才显示浅绿底和小勾。
    const pickedMark = picked && (selected.length > 1 || !current);
    return <div key={p.id} className="pf-card pf-episode" data-selected={pickedMark || undefined} data-current={current || undefined} data-flash={flash.includes(p.id) || undefined} {...dragProps(p)}
      onContextMenu={e => openMenu(e, { kind: 'episode', project: p, container: c })}>
      <button type="button" className="pf-card-main" aria-pressed={picked} title="双击打开素材使用 · 右键更多"
        aria-label={(c ? `${containerLabel(c)} ${title}` : title) + (current ? '（当前项目）' : '')}
        onClick={e => clickCard(e, p)} onDoubleClick={e => { if (justNavigated() || e.metaKey || e.ctrlKey || e.shiftKey) return; openPage('usage', p.id); }}>
        <b>{title}</b><small>{episodeSub(p, c)}</small>
      </button>
      {pickedMark && <span className="pf-tick" aria-hidden="true"><Check size={11} strokeWidth={3}/></span>}
      <span className="pf-more" aria-hidden="true"><MoreHorizontal size={15}/></span>
    </div>;
  };
  const addCard = (label: ReactNode, onClick: () => void, aria: string, sub?: string) =>
    <button type="button" className="pf-card pf-add" aria-label={aria} title={sub} disabled={busy} onClick={e => { if (e.detail > 1 && justNavigated()) return; onClick(); }}><Plus size={16}/><span>{label}</span></button>;
  const folderCard = (key: string, flashKey: string, name: string, sub: string, aria: string, enter: () => void, drop: ReturnType<typeof dropProps>, menuBody: MenuBody) =>
    <div key={key} className="pf-card pf-folder" data-flash={flash.includes(flashKey) || undefined} {...drop} onContextMenu={e => openMenu(e, menuBody)}>
      <button type="button" className="pf-card-main" aria-label={aria} onClick={e => { if (e.detail > 1 && justNavigated()) return; enter(); }}>
        <FolderIcon/><span className="pf-text"><b>{name}</b><small>{drop['data-drop'] && dragCount ? `松手移入 ${dragCount} 集` : sub}</small></span>
        <ChevronRight className="pf-chev" size={18} aria-hidden="true"/>
      </button>
    </div>;
  const seriesCard = (n: SeriesNode) => folderCard(n.series.id, 'series:' + n.series.id, n.series.name,
    [n.seasons.length ? `${n.seasons.length} 季` : '', `${n.episodeCount} 集`, n.series.software ? softwareNames[n.series.software] : ''].filter(Boolean).join(' · '),
    `打开剧 ${n.series.name}`, () => setLoc({ level: 'series', seriesId: n.series.id }),
    dropProps('series:' + n.series.id, { series_id: n.series.id, season_id: null }, n.series.name, n.root), { kind: 'series', node: n });
  const seasonCard = (n: SeriesNode, c: Container) => folderCard(c.key, c.season!.id, seasonName(c.season!), `${c.episodes.length} 集`,
    `打开 ${seasonName(c.season!)}`, () => setLoc({ level: 'season', seriesId: n.series.id, seasonId: c.season!.id }),
    dropProps('season:' + c.season!.id, targetOf(c), containerLabel(c), c), { kind: 'season', season: c.season!, node: n });

  const crumbs = <nav className="pf-crumbs" aria-label="位置">
    <button type="button" onClick={() => setLoc({ level: 'root' })} {...(loc.level !== 'root' ? dropProps('crumb:root', { series_id: null, season_id: null }, '', null) : {})}>项目</button>
    {node && <><ChevronRight size={14} aria-hidden="true"/>{loc.level === 'season' ? <button type="button" onClick={() => setLoc({ level: 'series', seriesId: node.series.id })} {...dropProps('crumb:series', { series_id: node.series.id, season_id: null }, node.series.name, node.root)}>{node.series.name}</button> : <b aria-current="page">{node.series.name}</b>}</>}
    {seasonContainer && <><ChevronRight size={14} aria-hidden="true"/><b aria-current="page">{seasonName(seasonContainer.season!)}</b></>}
  </nav>;

  const empty = !projects.length && !series.length;
  let body: ReactNode;
  if (loc.level === 'root' || !node) {
    body = empty ? <section className="project-blank" aria-label="暂无项目"><div className="project-blank-symbol"><FolderKanban size={32} strokeWidth={1.5}/></div><h2>还没有项目</h2><div className="project-blank-actions"><button className="primary" onClick={() => setDialog({ type: 'series' })}><Plus size={16}/>新建剧</button><button className="plain" onClick={() => setDialog({ type: 'project', project: null })}><Plus size={16}/>新建项目</button><button className="plain" onClick={() => setDialog({ type: 'xml' })}><FileUp size={16}/>从达芬奇 XML 导入</button></div></section> : <>
      {sortedSeries.length > 0 && <section aria-label="剧"><h3 className="pf-section">剧</h3><div className="pf-grid">{sortedSeries.map(seriesCard)}</div></section>}
      {sortedUngrouped.length > 0 && <section aria-label="未分组的项目"><h3 className="pf-section">未分组的项目</h3><div className="pf-grid" tabIndex={-1} onKeyDown={gridKeys}>{sortedUngrouped.map(p => episodeCard(p, null))}</div></section>}
    </>;
  } else if (loc.level === 'series') {
    body = <>
      <section aria-label="季"><h3 className="pf-section">季</h3><div className="pf-grid">{node.seasons.map(c => seasonCard(node, c))}{addCard('新建季', () => createSeason(node), '新建季', `默认「第 ${node.series.next_season_no} 季」，可改名`)}</div></section>
      <section aria-label="直接放在剧里的集"><h3 className="pf-section">直接放在剧里的集{selected.length > 1 ? ` · 已选 ${selected.length} 集` : ''}</h3><div className="pf-grid" tabIndex={-1} onKeyDown={gridKeys}>{node.root.episodes.map(p => episodeCard(p, node.root))}{addCard(`新建第 ${node.series.next_episode_no} 集`, () => createEpisode(node, node.root), `新建第 ${node.series.next_episode_no} 集（剧里）`, '放在剧里，不进任何季')}</div></section>
    </>;
  } else if (seasonContainer) {
    body = <section aria-label={seasonName(seasonContainer.season!) + '的集'}><h3 className="pf-section">{seasonContainer.episodes.length} 集{selected.length > 1 ? ` · 已选 ${selected.length} 集` : ''}</h3><div className="pf-grid" tabIndex={-1} onKeyDown={gridKeys}>{seasonContainer.episodes.map(p => episodeCard(p, seasonContainer))}{addCard(`新建第 ${seasonContainer.season!.next_episode_no} 集`, () => createEpisode(node, seasonContainer), `新建第 ${seasonContainer.season!.next_episode_no} 集（${seasonName(seasonContainer.season!)}）`, `沿用${softwareNames[node.series.software] || '剧的设置'}`)}</div></section>;
  }

  const title = loc.level === 'root' || !node ? '项目' : seasonContainer ? seasonName(seasonContainer.season!) : node.series.name;
  return <div className="project-manager pf" aria-busy={busy}>
    <header className="project-heading"><div className="project-page-title"><h1>{title}</h1>{loc.level === 'root' && <span className="project-count">{projects.length}</span>}{node && loc.level === 'series' && <small className="pf-meta">{[node.seasons.length ? `${node.seasons.length} 季` : '', `${node.episodeCount} 集`, node.series.software ? softwareNames[node.series.software] : ''].filter(Boolean).join(' · ')}</small>}</div>
      <div className="project-heading-actions">
        {loc.level === 'root' && !empty && <><label className="pf-sort">排序<select aria-label="项目排序" value={sort} onChange={e => setSort(e.target.value as Sort)}><option value="updated">最近修改</option><option value="name">名称</option><option value="created">创建时间</option></select></label>
          {tree.ungrouped.length > 0 && <button className="plain" onClick={() => setDialog({ type: 'organize' })}>整理旧项目</button>}
          <button className="plain" aria-haspopup="menu" aria-expanded={menu?.kind === 'new'} onClick={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setMenu({ kind: 'new', x: r.left, y: r.bottom + 4 }); }}><Plus size={16}/>新建<ChevronDown size={14}/></button><button className="primary" onClick={() => setDialog({ type: 'series' })}><Plus size={16}/>新建剧</button></>}
        {node && loc.level === 'series' && <><button className="plain" disabled={busy} onClick={() => setDialog({ type: 'series', series: node.series })}>改剧名</button><button className="icon-button" aria-label={`${node.series.name}的更多操作`} title="更多操作" onClick={e => openMenu(e, { kind: 'series', node })}><MoreHorizontal size={17}/></button></>}
        {seasonContainer && <button className="icon-button" aria-label={`${seasonName(seasonContainer.season!)}的更多操作`} title="更多操作" onClick={e => openMenu(e, { kind: 'season', season: seasonContainer.season!, node: node! })}><MoreHorizontal size={17}/></button>}
      </div></header>
    {loc.level !== 'root' && crumbs}
    <div className="pf-body">{body}</div>
    {menu && <div className="pf-menu" role="menu" aria-label="操作" ref={placeMenu} style={{ left: menu.x, top: menu.y }} onClick={e => e.stopPropagation()} onKeyDown={e => { if (e.key === 'Escape') setMenu(null); }}>
      {menu.kind === 'new' && <>
        <button role="menuitem" onClick={() => { setMenu(null); setDialog({ type: 'project', project: null }); }}><Plus size={14}/> 新建项目</button>
        <button role="menuitem" onClick={() => { setMenu(null); setDialog({ type: 'xml' }); }}><FileUp size={14}/> 从达芬奇 XML 新建</button>
      </>}
      {menu.kind === 'episode' && (() => { const c = menu.container, list = c?.episodes ?? [], i = list.findIndex(e => e.id === menu.project.id); return <>
        {pages.map((x, k) => <button role="menuitem" key={x.page} disabled={busy} onClick={() => { setMenu(null); openPage(x.page, menu.project.id); }}>打开{x.name}{k === 0 && <small className="pf-kbd">双击</small>}</button>)}
        <hr/>
        <button role="menuitem" disabled={busy} onClick={() => { setMenu(null); setDialog({ type: 'share', project: menu.project }); }}>分享给 Agent…</button>
        <hr/>
        {c && <><button role="menuitem" disabled={busy || i <= 0} onClick={() => swapEpisode(menu.project, c, 'previous')}>往前移{i > 0 && <small>和第 {list[i - 1].episode_no} 集交换</small>}</button>
        <button role="menuitem" disabled={busy || i >= list.length - 1} onClick={() => swapEpisode(menu.project, c, 'next')}>往后移{i < list.length - 1 && <small>和第 {list[i + 1].episode_no} 集交换</small>}</button>
        <hr/></>}
        <button role="menuitem" disabled={busy} onClick={() => { setMenu(null); setDialog({ type: 'moveTo', ids: selected.includes(menu.project.id) ? selected : [menu.project.id] }); }}>{c ? '移到…' : '放进剧…'}</button>
        {c && <button role="menuitem" disabled={busy} onClick={() => { setMenu(null); setDialog({ type: 'numbers', target: targetOf(c), targetName: containerLabel(c), conflicts: [], rows: [{ project: menu.project, episode_no: menu.project.episode_no ?? 1 }] }); }}>改集号…</button>}
        <button role="menuitem" disabled={busy} onClick={() => { setMenu(null); setDialog({ type: 'project', project: menu.project }); }}>改名</button>
        <hr/>
        <button role="menuitem" className="pf-danger" disabled={busy} onClick={() => deleteProject(menu.project)}>删除</button>
      </>; })()}
      {menu.kind === 'season' && (() => { const list = menu.node.seasons, i = list.findIndex(c => c.season?.id === menu.season.id); return <>
        <button role="menuitem" disabled={busy || i <= 0} onClick={() => swapSeason(menu.season, menu.node, 'previous')}>往前移</button>
        <button role="menuitem" disabled={busy || i >= list.length - 1} onClick={() => swapSeason(menu.season, menu.node, 'next')}>往后移</button>
        <hr/>
        {onOpenSeasonSettings && (() => {
          // 本季设定从这一季的某一集打开：优先当前项目（若就在这一季），否则用这一季第一集；空季没有集可借，先禁用并说明
          const eps = list[i]?.episodes ?? [], via = eps.find(p => p.id === activeId) ?? [...eps].sort((a, b) => (a.episode_no ?? 0) - (b.episode_no ?? 0))[0];
          return <button role="menuitem" disabled={busy || !via} title={via ? undefined : '这一季还没有集：先新建一集，再设置本季'} onClick={() => { if (!via) return; setMenu(null); openSeasonSettings(menu.season.id, via.id); }}>本季设定…{!via && <small>需先有一集</small>}</button>;
        })()}
        <button role="menuitem" disabled={busy} onClick={() => { setMenu(null); setDialog({ type: 'season', season: menu.season }); }}>改名 / 改季号…</button>
        <button role="menuitem" className="pf-danger" disabled={busy || (list[i]?.episodes.length ?? 0) > 0} title={(list[i]?.episodes.length ?? 0) > 0 ? '只有空季可以删除' : undefined} onClick={() => deleteSeason(menu.season)}>删除空季</button>
      </>; })()}
      {menu.kind === 'series' && <>
        <button role="menuitem" disabled={busy} onClick={() => { setMenu(null); setDialog({ type: 'series', series: menu.node.series }); }}>改剧名…</button>
        <button role="menuitem" className="pf-danger" disabled={busy || menu.node.episodeCount > 0} title={menu.node.episodeCount > 0 ? '剧里还有集，不能删除' : undefined} onClick={() => deleteSeries(menu.node)}>删除剧</button>
      </>}
    </div>}
    {toast && <div className="pf-toast" role="status"><span>{toast.text}</span>{toast.undo && <button type="button" disabled={busy} onClick={() => undo(toast.undo!)}>撤销</button>}<button type="button" className="pf-toast-close" aria-label="关闭提示" onClick={() => setToast(null)}><X size={14}/></button></div>}
    {dialog?.type === 'series' && <SeriesDialog series={dialog.series} busy={busy} close={() => setDialog(null)} save={(name, software) => void run(async () => {
      if (dialog.series) { await api.updateSeries(dialog.series, { name, software }); seriesChanged(); setDialog(null); }
      else { const s = await api.createSeries(name, software); setPending({ series: { ...s, seasons: s.seasons ?? [] }, until: Date.now() + PENDING_MS }); setDialog(null); setLoc({ level: 'series', seriesId: s.id }); seriesChanged(); }
    })}/>}
    {dialog?.type === 'season' && <SeasonDialog season={dialog.season} busy={busy} close={() => setDialog(null)} save={(label, no) => void run(async () => { await api.updateSeason(dialog.season, { label, season_no: no }); seriesChanged(); setDialog(null); })}/>}
    {dialog?.type === 'attrMap' && <AttributeMapDialog dialog={dialog} busy={busy} close={() => setDialog(null)}
      rePreview={choices => void run(() => rePreviewMove(dialog, choices))}
      confirm={() => void run(() => confirmAttrMove(dialog))}/>}
    {dialog?.type === 'numbers' && <NumbersDialog dialog={dialog} busy={busy} close={() => setDialog(null)} submit={rows => void run(() => move(dialog.target, dialog.targetName, rows))}/>}
    {dialog?.type === 'moveTo' && <MoveToDialog tree={tree.series} busy={busy} close={() => setDialog(null)} pick={(target, name, container) => { const ids = dialog.ids; setDialog(null); startMove(target, name, container, ids); }}/>}
    {dialog?.type === 'episodeName' && <NameDialog expected={dialog.expected} busy={busy} close={() => setDialog(null)} save={name => createEpisode(dialog.node, dialog.container, name)}/>}
    {dialog?.type === 'project' && <ProjectEditor project={dialog.project} request={request} close={() => setDialog(null)} saved={id => { setDialog(null); refresh(id); }} importXml={dialog.project ? undefined : () => setDialog({ type: 'xml' })}/>}
    {dialog?.type === 'organize' && <OrganizeDialog ungrouped={tree.ungrouped} series={series} api={api} close={() => setDialog(null)} done={summary => { setDialog(null); refresh(); setToast({ text: summary }); }}/>}
    {dialog?.type === 'share' && <Modal label={`分享给 Agent · ${dialog.project.name}`} close={() => setDialog(null)} busy={false}><div className="modal-body pf-share"><p className="muted pf-hint">选择复制方式，把这一集的接入说明交给 Agent。</p><AgentShare projectId={dialog.project.id} projectName={dialog.project.name}/></div><div className="modal-footer"><button type="button" className="plain" onClick={() => setDialog(null)}>完成</button></div></Modal>}
    {dialog?.type === 'xml' && <TimelineImportDialog key="create-from-xml" request={request} close={() => setDialog(null)} changed={id => { setDialog(null); refresh(id); }}/>}
  </div>;
}

function SeriesDialog({ series, busy, close, save }: { series?: Series; busy: boolean; close: () => void; save: (name: string, software: string) => void }) {
  const [name, setName] = useState(series?.name ?? ''), [software, setSoftware] = useState(series?.software ?? '');
  return <Modal label={series ? '改剧名' : '新建剧'} close={close} busy={busy}>
    <form onSubmit={e => { e.preventDefault(); if (name.trim()) save(name.trim(), software); }}>
      <fieldset className="modal-body" disabled={busy}>
        <label className="field">剧名<input aria-label="剧名" required maxLength={120} value={name} onChange={e => setName(e.target.value)}/></label>
        <label className="field">剪辑软件<select aria-label="剧的剪辑软件" value={software} onChange={e => setSoftware(e.target.value)}>{Object.entries(softwareNames).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        {!series && <p className="muted pf-hint">新建的集沿用这里的剪辑软件。建好后在剧里新建集或季。</p>}
      </fieldset>
      <div className="modal-footer"><button type="button" className="plain" disabled={busy} onClick={close}>取消</button><button className="primary" type="submit" disabled={busy || !name.trim()}><Check size={15}/>{series ? '保存' : '新建剧'}</button></div>
    </form>
  </Modal>;
}

function SeasonDialog({ season, busy, close, save }: { season: Season; busy: boolean; close: () => void; save: (label: string | null, seasonNo: number) => void }) {
  const [label, setLabel] = useState(season.label ?? ''), [no, setNo] = useState(String(season.season_no));
  const n = Number(no), valid = Number.isInteger(n) && n > 0;
  return <Modal label="改名 / 改季号" close={close} busy={busy}>
    <form onSubmit={e => { e.preventDefault(); if (valid) save(label.trim() || null, n); }}>
      <fieldset className="modal-body" disabled={busy}>
        <label className="field">显示名<input aria-label="季的显示名" maxLength={40} placeholder={`第 ${season.season_no} 季`} value={label} onChange={e => setLabel(e.target.value)}/></label>
        <label className="field">季号（决定排序）<input aria-label="季号" type="number" min={1} step={1} value={no} onChange={e => setNo(e.target.value)}/></label>
        <p className="muted pf-hint">显示名留空就用「第 N 季」。季号决定季的先后顺序。</p>
      </fieldset>
      <div className="modal-footer"><button type="button" className="plain" disabled={busy} onClick={close}>取消</button><button className="primary" type="submit" disabled={busy || !valid}><Check size={15}/>保存</button></div>
    </form>
  </Modal>;
}

function NumbersDialog({ dialog, busy, close, submit }: { dialog: Extract<Dialog, { type: 'numbers' }>; busy: boolean; close: () => void; submit: (rows: NumberRow[]) => void }) {
  const [nos, setNos] = useState<Record<string, string>>(() => Object.fromEntries(dialog.rows.map(r => [r.project.id, String(r.episode_no)])));
  useEffect(() => { setNos(Object.fromEntries(dialog.rows.map(r => [r.project.id, String(r.episode_no)]))); }, [dialog]);
  const parsed = dialog.rows.map(r => ({ project: r.project, episode_no: Number(nos[r.project.id]) }));
  const counts = new Map<number, number>(); parsed.forEach(r => counts.set(r.episode_no, (counts.get(r.episode_no) ?? 0) + 1));
  const invalid = parsed.some(r => !Number.isInteger(r.episode_no) || r.episode_no < 1 || (counts.get(r.episode_no) ?? 0) > 1);
  const conflictOf = (id: string) => dialog.conflicts.filter(c => c.project_id === id);
  return <Modal label={dialog.conflicts.length ? '集号冲突，改号后再提交' : '确认集号'} close={close} busy={busy}>
    <form onSubmit={e => { e.preventDefault(); if (!invalid) submit(parsed); }}>
      <div className="modal-body pf-numbers">
        <p className="muted pf-hint">移到「{dialog.targetName}」。{dialog.conflicts.length ? '下面标红的集号已被占用，整批都还没移动。' : '集号在这一季（或剧里）内不能重复。'}</p>
        <table><thead><tr><th>项目</th><th>集号</th></tr></thead><tbody>{dialog.rows.map(r => { const c = conflictOf(r.project.id), n = Number(nos[r.project.id]), dup = (counts.get(n) ?? 0) > 1; return <tr key={r.project.id} data-conflict={c.length || dup ? 'yes' : undefined}>
          <td>{r.project.name}{c.length > 0 && <small className="pf-conflict">{c.map(x => x.code === 'EPISODE_NUMBER_CONFLICT' ? `第 ${x.episode_no ?? n} 集已被占用` : x.code).join('；')}</small>}{dup && <small className="pf-conflict">和本次另一项重号</small>}</td>
          <td><input aria-label={`${r.project.name}的集号`} type="number" min={1} step={1} disabled={busy} value={nos[r.project.id]} onChange={e => setNos(v => ({ ...v, [r.project.id]: e.target.value }))}/></td></tr>; })}</tbody></table>
      </div>
      <div className="modal-footer"><button type="button" className="plain" disabled={busy} onClick={close}>取消</button><button className="primary" type="submit" disabled={busy || invalid}><Check size={15}/>{dialog.rows.length > 1 ? `移动 ${dialog.rows.length} 集` : '保存'}</button></div>
    </form>
  </Modal>;
}

function MoveToDialog({ tree, busy, close, pick }: { tree: SeriesNode[]; busy: boolean; close: () => void; pick: (target: MoveTarget, name: string, container: Container | null) => void }) {
  const options = [{ key: 'out', name: '移出剧（变成未分组项目）', target: { series_id: null, season_id: null } as MoveTarget, container: null as Container | null },
    ...tree.flatMap(n => [{ key: n.root.key, name: `${n.series.name}（剧里，不进季）`, target: targetOf(n.root), container: n.root }, ...n.seasons.map(c => ({ key: c.key, name: `${n.series.name} › ${seasonName(c.season!)}`, target: targetOf(c), container: c }))])];
  const [key, setKey] = useState(options[1]?.key ?? 'out'), chosen = options.find(o => o.key === key);
  return <Modal label="移到…" close={close} busy={busy}>
    <form onSubmit={e => { e.preventDefault(); if (chosen) pick(chosen.target, chosen.container ? (chosen.container.season ? `${chosen.container.series.name} ${seasonName(chosen.container.season)}` : chosen.container.series.name) : '', chosen.container); }}>
      <fieldset className="modal-body" disabled={busy}><label className="field">移到<select aria-label="目标位置" value={key} onChange={e => setKey(e.target.value)}>{options.map(o => <option key={o.key} value={o.key}>{o.name}</option>)}</select></label><p className="muted pf-hint">集号默认沿用原号；目标里撞号时会让你改号，整批要么都移，要么都不移。</p></fieldset>
      <div className="modal-footer"><button type="button" className="plain" disabled={busy} onClick={close}>取消</button><button className="primary" type="submit" disabled={busy || !chosen}><Folder size={15}/>移动</button></div>
    </form>
  </Modal>;
}

function NameDialog({ expected, busy, close, save }: { expected: number; busy: boolean; close: () => void; save: (name: string) => void }) {
  const [name, setName] = useState('');
  return <Modal label={`第 ${expected} 集的项目名已被占用`} close={close} busy={busy}>
    <form onSubmit={e => { e.preventDefault(); if (name.trim()) save(name.trim()); }}>
      <fieldset className="modal-body" disabled={busy}><label className="field">换一个项目名<input aria-label="新项目名" required maxLength={120} value={name} onChange={e => setName(e.target.value)}/></label><p className="muted pf-hint">项目名全库不能重复；集的位置不受影响。</p></fieldset>
      <div className="modal-footer"><button type="button" className="plain" disabled={busy} onClick={close}>取消</button><button className="primary" type="submit" disabled={busy || !name.trim()}><Check size={15}/>新建</button></div>
    </form>
  </Modal>;
}

/** 归组 / 挪集时的维度对应（设计稿 A3）。改选项就带着完整选择重新预览，以服务端回显和新凭证为准。 */
function AttributeMapDialog({ dialog, busy, close, rePreview, confirm }: {
  dialog: Extract<Dialog, { type: 'attrMap' }>; busy: boolean; close: () => void; rePreview: (choices: AttributeGroupChoice[]) => void; confirm: () => void;
}) {
  const label = dialog.target.series_id ? `把 ${dialog.rows.length} 集放进「${dialog.targetName}」` : `把 ${dialog.rows.length} 集移出剧`;
  return <Modal label={label} close={close} busy={busy}>
    <div className="modal-body">
      {dialog.note && <p className="pf-unknown" role="alert">{dialog.note}</p>}
      <p className="muted">{dialog.target.series_id ? '放进剧后，这些集改用这部剧的人物属性维度。下面是它们原来的维度怎么对应过去：' : '移出后，这些集会有自己独立的一套维度。'}</p>
      <AttributePlanEditor plan={dialog.plan} busy={busy} nameOf={id => dialog.rows.find(r => r.project.id === id)?.project.name ?? '某一集'} onChoices={rePreview}/>
    </div>
    <div className="modal-footer"><button type="button" className="plain" disabled={busy} onClick={close}>取消</button>
      <button type="button" className="primary" disabled={busy || !dialog.ready} onClick={confirm}>{dialog.target.series_id ? '确认放进剧' : '确认移出'}</button></div>
  </Modal>;
}
