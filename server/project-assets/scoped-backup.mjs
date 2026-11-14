import { scoreValue } from './character-merge-plan.mjs';
import { canonical, digest, fault, idOK } from './model.mjs';
import { DEFAULT_DIMENSIONS, dimensionsInput, isRecord, isRevision, isScore, textField } from '../project-attributes/model.mjs';

const invalid = () => fault('备份包含无效的共享资产覆盖、评分或回执');
const sameFields = (row, keys) => isRecord(row) && keys.length === Object.keys(row).length &&
  keys.every(key => Object.hasOwn(row, key));
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function validScore(value, manualOnly = false) {
  if (!sameFields(value, ['value', 'source', 'reason', 'updated_at']) || !isRevision(value.updated_at)) return false;
  if (value.source === 'manual') return value.reason === null && (value.value === null || isScore(value.value));
  return !manualOnly && value.source === 'ai' && isScore(value.value) &&
    textField(value.reason, 200, '评分依据') === value.reason;
}

export function validateScopedAssetBackup(tables, directory) {
  const series = new Set((directory?.project_series ?? []).map(row => row.id));
  const seasons = new Map((directory?.project_series_seasons ?? []).map(row => [row.id, row.series_id]));
  const episodes = new Map((directory?.project_series_members ?? []).map(row => [row.id, row.series_id]));
  const assets = new Map(tables.creative_assets.map(row => [row.id, row]));
  const looks = new Map(tables.creative_looks.map(row => [row.id, row]));
  const bindings = new Map(tables.creative_image_bindings.map(row => [row.id, row]));
  const dimensions = new Map();
  const defaultIds = new Set(DEFAULT_DIMENSIONS.map(dimension => dimension.id));
  for (const row of tables.series_attribute_configs) {
    const config = JSON.parse(row.data_json);
    if (!series.has(row.id) || !sameFields(config, ['source', 'updated_at', 'dimensions']) ||
        !['user', 'agent'].includes(config.source) || !isRevision(config.updated_at) ||
        canonical(dimensionsInput(config.dimensions)) !== canonical(config.dimensions) ||
        config.dimensions.some(dimension => dimension.id === null)) throw invalid();
    dimensions.set(row.id, new Set(config.dimensions.map(dimension => dimension.id)));
  }
  const axes = seriesId => dimensions.get(seriesId) ?? defaultIds;
  for (const row of tables.series_character_attributes) {
    const asset = assets.get(row.id);
    const scores = JSON.parse(row.data_json);
    if (asset?.owner_type !== 'series' || asset.owner_id !== row.series_id || asset.kind !== 'character' ||
        !isRecord(scores) || Object.entries(scores).some(([id, score]) => !axes(row.series_id).has(id) || !validScore(score))) {
      throw invalid();
    }
  }
  for (const row of tables.creative_asset_overrides) {
    const asset = assets.get(row.asset_id);
    const ownerId = row.scope_type === 'episode' ? episodes.get(row.scope_id) :
      row.scope_type === 'season' ? seasons.get(row.scope_id) : null;
    if (!ownerId || asset?.owner_type !== 'series' || asset.owner_id !== ownerId ||
        row.id !== digest([row.scope_type, row.scope_id, row.asset_id, row.field_key])) throw invalid();
    const value = JSON.parse(row.value_json);
    const [key, target, extra] = row.field_key.split(':');
    if (extra !== undefined) throw invalid();
    if (key === 'attribute_score') {
      if (row.scope_type !== 'episode' || asset.kind !== 'character' || !axes(ownerId).has(target) || !scoreValue(value, true)) throw invalid();
    } else if (key === 'default_look') {
      if (target !== undefined || asset.kind !== 'character' || value !== null && looks.get(value)?.asset_id !== asset.id) throw invalid();
    } else if (key === 'default_image') {
      const binding = bindings.get(value);
      const look = target === undefined ? null : looks.get(target);
      if (binding?.asset_id !== asset.id || binding.look_id !== (target ?? null) ||
          (asset.kind === 'character' ? look?.asset_id !== asset.id : target !== undefined)) throw invalid();
    } else {
      throw invalid();
    }
  }
  for (const row of tables.creative_asset_override_clocks) {
    if (!['season', 'episode'].includes(row.scope_type) || assets.get(row.asset_id)?.owner_type !== 'series' ||
        !/^(default_look|default_image(?::[a-f0-9-]{36})?|attribute_score:[a-f0-9-]{36})$/i.test(row.field_key) ||
        row.id !== digest([row.scope_type, row.scope_id, row.asset_id, row.field_key])) throw invalid();
  }
  for (const row of tables.creative_asset_scope_requests) {
    // Historic receipts can outlive a deleted scope; lookup rechecks visibility.
    if (!['episode', 'season', 'series'].includes(row.scope_type) ||
        !isHash(row.request_hash) || JSON.parse(row.result_json)?.request_id !== row.id) throw invalid();
  }
}
