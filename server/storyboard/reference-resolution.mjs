import { fault } from '../project-assets/model.mjs';
import { bindingImageFields, creativeReferenceSlots, shotReferenceRows } from './asset-references.mjs';
import { timeline } from './shared/model.mjs';

export function canUseStoryboardAsset(projectId, seriesId, asset) {
  return asset.owner_type === 'project' && asset.project_id === projectId ||
    asset.owner_type === 'series' && asset.owner_id === seriesId;
}

export function createReferenceResolver(projectId, {
  seriesId, asset, look, image, resolveAsset, resolveLook, assetAlias, lookAlias,
}) {
  const assets = new Map(), looks = new Map(), images = new Map();
  const readAsset = id => {
    if (!assets.has(id)) {
      const canonicalId = resolveAsset(projectId, id);
      const row = asset(canonicalId);
      assets.set(id, row && row.archived_at === 0 && canUseStoryboardAsset(projectId, seriesId, row) ? row : null);
    }
    return assets.get(id);
  };
  const readLook = id => {
    if (!looks.has(id)) {
      const row = look(resolveLook(projectId, id));
      looks.set(id, row?.archived_at === null && readAsset(row.asset_id)?.id === row.asset_id ? row : null);
    }
    return looks.get(id);
  };
  const readImage = id => {
    if (!images.has(id)) {
      const row = image(id);
      images.set(id, row?.archived_at === null && readAsset(row.asset_id)?.id === row.asset_id &&
        (!row.look_id || readLook(row.look_id)?.asset_id === row.asset_id) ? row : null);
    }
    return images.get(id);
  };
  return { asset: readAsset, look: readLook, image: readImage, assetAlias, lookAlias };
}

export function backupReferenceResolver(projectId, seriesId, rows) {
  const { assets, looks, images, assetAliases, lookAliases, merges } = rows;
  const active = alias => alias && alias.series_id === seriesId && merges.get(alias.merge_id)?.status === 'merged';
  return createReferenceResolver(projectId, {
    seriesId, asset: id => assets.get(id), look: id => looks.get(id), image: id => images.get(id),
    assetAlias: id => assetAliases.has(id), lookAlias: id => lookAliases.has(id),
    resolveAsset: (_projectId, id) => {
      const alias = assetAliases.get(id);
      return active(alias) ? alias.target_id : id;
    },
    resolveLook: (_projectId, id) => {
      const alias = lookAliases.get(id);
      return active(alias) ? alias.target_id : id;
    },
  });
}

export function validateReferences(project, resolver, { previous, writing = false, failure }) {
  const counts = new Map();
  for (const { slot, id } of previous ? creativeReferenceSlots(previous) : []) {
    const key = JSON.stringify([slot, id]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sceneIds = new Set(project.scenes.map(scene => scene.id));
  const fileIds = new Set(project.assets.map(asset => asset.id));
  const assetResolution = new Map(), lookResolution = new Map();
  for (const { slot, type, id, row } of creativeReferenceSlots(project)) {
    if (type === 'character' && row && sceneIds.has(id)) continue;
    if (type === 'legacy-image' && fileIds.has(id)) continue;
    const isImage = type === 'image' || type === 'legacy-image';
    const read = type === 'look' ? resolver.look : isImage ? resolver.image : resolver.asset;
    const resolved = read(id);
    if (!resolved && row && (isImage || !(type === 'look' ? resolver.lookAlias(id) : resolver.assetAlias(id)))) continue;
    if (!resolved || (['character', 'scene', 'prop'].includes(type) && resolved.kind !== type)) throw failure(type);
    const canonicalAssetId = type === 'look' || isImage ? resolved.asset_id : resolved.id;
    if (row) {
      const subjectId = row.character_id ?? (sceneIds.has(row.subject_id) ? null : row.subject_id) ?? row.creative_asset_id;
      const subject = subjectId ? resolver.asset(subjectId) : null;
      const explicitLook = row.look_id ? resolver.look(row.look_id) : null;
      const usesAlias = resolved.id !== id || (subject && subject.id !== subjectId) ||
        (explicitLook && explicitLook.id !== row.look_id);
      if (usesAlias && subject && subject.id !== canonicalAssetId) throw failure(type);
      if (usesAlias && isImage && explicitLook && explicitLook.id !== resolved.look_id) {
        throw failure(type);
      }
    }
    if (writing && resolved.id !== id) {
      const key = JSON.stringify([slot, id]);
      const remaining = counts.get(key) ?? 0;
      if (!remaining) {
        const target = resolver.asset(canonicalAssetId);
        throw fault('该人物或造型已合并，请选用当前主体或造型', 409, {
          code: 'ASSET_MERGED', details: {
            ...(type === 'look' ? { requested_look_id: id, canonical_look_id: resolved.id } : { requested_asset_id: id }),
            canonical_asset_id: canonicalAssetId,
            canonical_asset: { id: target.id, name: target.name, revision: target.revision },
          },
        });
      }
      counts.set(key, remaining - 1);
    }
    if (type === 'look') lookResolution.set(id, {
      requested_look_id: id, canonical_look_id: resolved.id, canonical_asset_id: canonicalAssetId,
    });
    else if (type !== 'image' && type !== 'legacy-image') assetResolution.set(id, {
      requested_asset_id: id, canonical_asset_id: canonicalAssetId,
    });
  }
  return { assetResolution, lookResolution };
}

export function shotCharacterLooks(project, resolver, characters) {
  const fileIds = new Set(project.assets.map(asset => asset.id));
  return Object.fromEntries(timeline(project).flatMap(({ shot, scene }) => {
    const explicit = new Map(), ids = new Set([
      ...(shot.character_ids ?? []), ...(shot.character_presence ?? []).map(row => row.character_id),
      ...(shot.dialogue ?? []).map(row => row.character_id),
    ].map(id => resolver.asset(id)?.id));
    for (const row of shotReferenceRows(project, shot, scene)) {
      const look = row.look_id ? resolver.look(row.look_id) : null;
      const imageIds = bindingImageFields.map(field => row[field]);
      if (!fileIds.has(row.asset_id)) imageIds.push(row.asset_id);
      const images = [...new Set(imageIds.filter(Boolean))]
        .map(id => resolver.image(id)).filter(Boolean);
      const subject = row.subject_id ?? row.creative_asset_id;
      if (subject) ids.add(resolver.asset(subject)?.id);
      const looks = [...(look ? [look] : []), ...images.map(image => resolver.look(image.look_id)).filter(Boolean)];
      for (const item of looks) {
        ids.add(item.asset_id);
        if (!explicit.has(item.asset_id)) explicit.set(item.asset_id, new Map());
        const imageIds = images.filter(image => image.look_id === item.id).map(image => image.id);
        const existing = explicit.get(item.asset_id).get(item.id) ?? [];
        explicit.get(item.asset_id).set(item.id, [...new Set([...existing, ...imageIds])]);
      }
    }
    const entries = [...ids].flatMap(id => {
      const character = characters.get(id);
      if (!character) return [];
      const selected = explicit.get(id) ?? new Map([[character.default_look_id, []]]);
      return [...selected].map(([lookId, imageIds]) => ({
        canonical_asset_id: id, canonical_look_id: lookId,
        image_binding_ids: imageIds.length ? imageIds : [character.default_image_ids[lookId]].filter(Boolean),
        source: explicit.has(id) ? 'explicit' : 'default',
      }));
    });
    return entries.length ? [[shot.id, entries]] : [];
  }));
}
