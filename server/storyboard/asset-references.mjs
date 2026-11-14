import { timeline } from './shared/model.mjs';

export const bindingImageFields = ['image_id', 'image_binding_id', 'binding_id'];

export function shotReferenceRows(project, shot, scene) {
  const bindings = [...(project.reference_bindings ?? []), ...(shot.reference_bindings ?? [])].filter(row =>
    (!row.scene_ids?.length || row.scene_ids.includes(scene.id)) &&
    (!row.shot_ids?.length || row.shot_ids.includes(shot.id)));
  return [scene, shot, ...(shot.character_presence ?? []), ...bindings];
}

export function explicitAssetShots(project, { assetIds = new Set(), lookIds = new Set(), imageIds = new Set() }) {
  const fileIds = new Set((project.assets ?? []).map(asset => asset.id));
  const matches = row => assetIds.has(row.subject_id) || assetIds.has(row.creative_asset_id) ||
    lookIds.has(row.look_id) || bindingImageFields.some(field => imageIds.has(row[field])) ||
    (!fileIds.has(row.asset_id) && imageIds.has(row.asset_id));
  return timeline(project).flatMap(({ shot, scene, number }) =>
    shotReferenceRows(project, shot, scene).some(matches) ? [{ shotId: shot.id, sceneId: scene.id, number }] : []);
}

// Slot identity follows permanent IDs, so moving a shot or editing dialogue text
// keeps its historical reference. Adding a reference in a different slot does not.
export function creativeReferenceSlots(project) {
  const result = [];
  const add = (slot, type, id, row = null) => {
    if (id !== undefined && id !== null && id !== '') result.push({ slot: JSON.stringify(slot), type, id, row });
  };
  const explicit = (slot, row) => {
    add([...slot, 'subject_id'], 'character', row.subject_id, row);
    add([...slot, 'creative_asset_id'], 'asset', row.creative_asset_id, row);
    add([...slot, 'look_id'], 'look', row.look_id, row);
    for (const field of bindingImageFields) add([...slot, field], 'image', row[field], row);
    // A reference's asset_id normally identifies the file in project.assets.
    // Older bindings can also use it for a creative image binding ID.
    add([...slot, 'asset_id'], 'legacy-image', row.asset_id, row);
  };
  const bindings = (slot, rows = []) => {
    for (const row of rows) {
      const key = [...slot, 'binding', row.id ?? row.asset_id, [...new Set(row.scene_ids ?? [])].sort(), [...new Set(row.shot_ids ?? [])].sort()];
      explicit(key, row);
    }
  };
  for (const [kind, entries] of Object.entries(project.asset_manifest)) {
    for (const { id } of entries) add(['manifest', kind], kind, id);
  }
  bindings(['project'], project.reference_bindings);
  for (const scene of project.scenes) {
    explicit(['scene', scene.id], scene);
    for (const shot of scene.shots) {
      const slot = ['shot', shot.id];
      explicit(slot, shot);
      for (const id of shot.character_ids ?? []) add([...slot, 'character_ids'], 'character', id);
      for (const row of shot.character_presence ?? []) {
        add([...slot, 'presence'], 'character', row.character_id);
        explicit([...slot, 'presence', row.character_id], row);
      }
      for (const row of shot.dialogue ?? []) add([...slot, 'dialogue', row.id], 'character', row.character_id);
      bindings(slot, shot.reference_bindings);
    }
  }
  return result;
}
