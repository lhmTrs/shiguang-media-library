// 分镜页界面偏好：只存在这台电脑的浏览器里，不进数据库。
/** 编辑表格可以选择显示的列（镜号和勾选列始终显示）。顺序即表格从左到右的顺序。 */
export const STORYBOARD_COLUMNS = [
  {key: 'framing', label: '景别与角度'},
  {key: 'action', label: '画面与人物动作'},
  {key: 'camera', label: '摄影机设计'},
  {key: 'sound', label: '声音与对白'},
  {key: 'duration', label: '时长'},
  {key: 'transition', label: '剪辑衔接'},
  {key: 'first_frame', label: '第一帧状态'},
  {key: 'continuity', label: '连续性要求'},
  {key: 'design_note', label: '设计备注'},
] as const;
export type StoryboardColumn = typeof STORYBOARD_COLUMNS[number]['key'];
/** 用户认可的设计稿：默认只显示景别、画面与动作、时长，其余在界面设置里勾选。 */
export const DEFAULT_COLUMNS: StoryboardColumn[] = ['framing', 'action', 'duration'];
export type StoryboardAppearance = { density: 'comfortable' | 'compact'; showScenes: boolean; showDetails: boolean; columns: StoryboardColumn[] };
export const storyboardAppearanceKey = 'shiguang.storyboardAppearance.v1';
const KNOWN = new Set<string>(STORYBOARD_COLUMNS.map(c => c.key));
/** 只保留认识的列，并按固定顺序排好；一列都没选时回到默认，避免表格只剩镜号。 */
export const normalizeColumns = (value: unknown): StoryboardColumn[] => {
  const picked = Array.isArray(value) ? new Set(value.filter((v): v is StoryboardColumn => typeof v === 'string' && KNOWN.has(v))) : null;
  const ordered = STORYBOARD_COLUMNS.map(c => c.key).filter(k => picked?.has(k));
  return ordered.length ? ordered : [...DEFAULT_COLUMNS];
};
export function readStoryboardAppearance(): StoryboardAppearance {
  const defaults: StoryboardAppearance = { density: 'comfortable', showScenes: innerWidth > 1050, showDetails: innerWidth > 760, columns: [...DEFAULT_COLUMNS] };
  try {
    const saved = JSON.parse(localStorage.getItem(storyboardAppearanceKey) || 'null');
    return { density: saved?.density === 'compact' ? 'compact' : 'comfortable', showScenes: typeof saved?.showScenes === 'boolean' ? saved.showScenes : defaults.showScenes, showDetails: typeof saved?.showDetails === 'boolean' ? saved.showDetails : defaults.showDetails, columns: saved?.columns === undefined ? defaults.columns : normalizeColumns(saved.columns) };
  } catch { return defaults; }
}
