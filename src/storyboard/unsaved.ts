// 未保存修改：拿「上次保存的分镜」和「当前页面里的分镜」按镜头永久 ID 比较，只用于界面高亮和计数，不写库。
// 镜号会随增删变化，所以只认 shot.id；新增或删除的镜头整镜算一处。
import * as domain from '../../server/storyboard/shared/model.mjs';
type Any = any; // 分镜文档沿用后端共享模型，这里只读几个字段
const canonical = (domain as Any).canonical as (v: unknown) => string;
export const TRACKED_FIELDS = ['framing', 'action', 'camera', 'sound', 'dialogue', 'duration_ms', 'transition', 'first_frame', 'continuity', 'design_note',
  'physical_feedback', 'environment_feedback', 'result', 'character_ids', 'character_presence', 'reference_bindings', 'audio_continuations'] as const;
export type Unsaved = {shots: Map<string, Set<string>>; places: number};
export const NONE: Unsaved = {shots: new Map(), places: 0};
const shotsOf = (p: Any): Map<string, Any> => new Map((p?.scenes ?? []).flatMap((s: Any) => (s.shots ?? []).map((q: Any) => [q.id, {...q, $scene: s.id}])));
const same = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);   // 与保存比较同一口径，键顺序不影响

export function unsavedChanges(savedCanonical: string, current: Any): Unsaved {
  if (!current || !savedCanonical) return NONE;
  let saved: Any; try { saved = JSON.parse(savedCanonical); } catch { return NONE; }
  const before = shotsOf(saved), after = shotsOf(current), shots = new Map<string, Set<string>>();
  let places = 0;
  for (const [id, q] of after) {
    const old = before.get(id);
    if (!old) { shots.set(id, new Set(['$new'])); places++; continue; }
    const fields = new Set<string>();
    for (const f of TRACKED_FIELDS) if (!same(old[f], q[f])) fields.add(f);
    if (old.$scene !== q.$scene) fields.add('$scene');
    if (fields.size) { shots.set(id, fields); places += fields.size; }
  }
  for (const id of before.keys()) if (!after.has(id)) places++;   // 删除的镜头：没有格子可标，但要计入
  // 场景、人物、设置等非镜头内容改了也算未保存，计一处
  const strip = (p: Any) => ({...p, revision: undefined, scenes: (p?.scenes ?? []).map((s: Any) => ({...s, shots: (s.shots ?? []).map((q: Any) => q.id)}))});
  if (!same(strip(saved), strip(current))) places++;
  return {shots, places};
}
export const summary = (u: Unsaved) => u.shots.size ? `${u.shots.size} 个镜头、${u.places} 处未保存` : u.places ? `${u.places} 处未保存` : '';
