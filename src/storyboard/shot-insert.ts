// 分镜「段」第二批：镜头只能在某个镜头的上方或下方插入，新镜头归所点镜头的场景（和段）。
// 页面上不再有拖动、上移/下移、移动到场景、场景上移/下移等改变镜头顺序的入口。
import * as domain from '../../server/storyboard/shared/model.mjs';

type Any = any;
const M = domain as Any;

export type InsertWhere = 'above' | 'below';

/** 在 anchorId 镜头的上方或下方插入一个空镜头，返回新镜头 id；找不到所点镜头时返回 ''。 */
export function insertShotNear(p: Any, anchorId: string, where: InsertWhere): string {
  for (const scene of p.scenes ?? []) {
    const i = scene.shots.findIndex((q: Any) => q.id === anchorId);
    if (i < 0) continue;
    const shot = M.emptyShot();
    scene.shots.splice(where === 'above' ? i : i + 1, 0, shot);
    return shot.id;
  }
  return '';
}

/** 只有空场景能直接「新增镜头」；返回 null 表示允许，否则返回给用户看的原因。 */
export function addShotBlocked(p: Any, sceneId: string | undefined): string | null {
  if (!sceneId) return '请先新增场景';
  const scene = (p?.scenes ?? []).find((s: Any) => s.id === sceneId);
  if (!scene) return '请先新增场景';
  return scene.shots.length ? '请在镜头上右键，选择「在上方插入」或「在下方插入」' : null;
}
