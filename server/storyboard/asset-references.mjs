import { timeline } from './shared/model.mjs';

export function explicitAssetShots(project, { assetIds = new Set(), lookIds = new Set(), imageIds = new Set() }) {
  const matches = row => assetIds.has(row.subject_id) || assetIds.has(row.creative_asset_id) ||
    lookIds.has(row.look_id) || [row.asset_id, row.image_id, row.image_binding_id, row.binding_id].some(id => imageIds.has(id));
  const globals = project.reference_bindings ?? [];
  return timeline(project).flatMap(({ shot, scene, number }) => {
    const applicable = [...globals, ...(shot.reference_bindings ?? [])].filter(row =>
      (!row.scene_ids?.length || row.scene_ids.includes(scene.id)) &&
      (!row.shot_ids?.length || row.shot_ids.includes(shot.id)));
    return [scene, shot, ...applicable, ...(shot.character_presence ?? [])].some(matches)
      ? [{ shotId: shot.id, sceneId: scene.id, number }]
      : [];
  });
}
