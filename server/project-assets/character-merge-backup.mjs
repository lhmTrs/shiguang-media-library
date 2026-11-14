import { canonical, fault, idOK } from './model.mjs';
import { isRecord } from '../project-attributes/model.mjs';
import { mergeEntities } from './character-merge-write.mjs';
import { rejectedMergeId, validRejectionReceipt } from './character-merge-receipts.mjs';
import { CREATIVE_TABLES } from './schema.mjs';
import { ATTRIBUTE_TABLES } from '../project-attributes/schema.mjs';

export function validateCharacterMergeBackup(tables, directory) {
  const invalid = () => fault('备份中包含无效的合并人物、造型映射或回执');
  const byId = rows => new Map(rows.map(row => [row.id, row]));
  const assets = byId(tables.creative_assets), looks = byId(tables.creative_looks), bindings = byId(tables.creative_image_bindings);
  const merges = byId(tables.creative_character_merges), aliases = byId(tables.creative_character_aliases);
  const requests = byId(tables.creative_character_merge_requests);
  const memberships = new Map((directory?.project_series_members ?? []).map(row => [row.id, row.series_id]));
  const series = byId(directory?.project_series ?? []);
  const checkSnapshot = (snapshot, ids, seriesId, allowedEpisodes) => {
    if (!isRecord(snapshot) || canonical(Object.keys(snapshot).sort()) !== canonical(Object.keys(mergeEntities).sort())) throw invalid();
    for (const [table, [, owner]] of Object.entries(mergeEntities)) {
      const rows = snapshot[table];
      const columns = CREATIVE_TABLES[table] ?? ATTRIBUTE_TABLES[table];
      if (!Array.isArray(rows) || rows.length > 100000 || new Set(rows.map(row => row?.id)).size !== rows.length) throw invalid();
      for (const row of rows) {
        if (!isRecord(row) || !ids.has(row[owner]) || canonical(Object.keys(row).sort()) !== canonical(Object.keys(columns).sort()))
          throw invalid();
        for (const [field, kind] of Object.entries(columns)) {
          const value = row[field];
          if (kind === 'hash_id' ? !/^[a-f0-9]{64}$/.test(value) :
            ['id', 'ref', 'project', 'optional_ref'].includes(kind) ? (value !== null || kind !== 'optional_ref') && !idOK(value) :
            ['integer', 'nullable'].includes(kind) ? (value !== null || kind !== 'nullable') && (!Number.isSafeInteger(value) || value < 0) :
            typeof value !== 'string') throw invalid();
          if (field.endsWith('_json')) { try { JSON.parse(value); } catch { throw invalid(); } }
        }
        if (table === 'creative_looks' || table === 'creative_image_bindings') {
          const child = (table === 'creative_looks' ? looks : bindings).get(row.id);
          if (!child || !ids.has(child.asset_id)) throw invalid();
        }
        if (table === 'creative_assets' && (row.kind !== 'character' || row.owner_type === 'series' && row.owner_id !== seriesId ||
            row.owner_type === 'project' && (!allowedEpisodes.has(row.project_id) || row.project_id !== row.owner_id) ||
            !['series', 'project'].includes(row.owner_type))) throw invalid();
      }
    }
  };
  for (const row of merges.values()) {
    const data = JSON.parse(row.data_json);
    if (!series.has(row.series_id) || !['merged', 'undone'].includes(row.status) || !isRecord(data) ||
        !Array.isArray(data.asset_ids) || !Array.isArray(data.source_asset_ids) || !Array.isArray(data.episode_ids) ||
        !Array.isArray(data.membership) || !Array.isArray(data.aliases) || !Array.isArray(data.lookAliases) ||
        !Array.isArray(data.references?.shots) || !Array.isArray(data.references?.manifests) ||
        !Array.isArray(data.references?.slots) ||
        !idOK(data.request_id) || !idOK(data.history_id)) throw invalid();
    const ids = new Set(data.asset_ids);
    if (ids.size !== data.asset_ids.length || ids.size < 2 || !ids.has(row.canonical_asset_id) ||
        canonical(data.source_asset_ids.slice().sort()) !== canonical([...ids].filter(id => id !== row.canonical_asset_id).sort()) ||
        [...ids].some(id => assets.get(id)?.kind !== 'character') || data.episode_ids.some(id => !idOK(id))) throw invalid();
    if (data.membership.some(pair => !Array.isArray(pair) || pair.length !== 2 || !idOK(pair[0]) ||
        pair[1] !== null && !idOK(pair[1]))) throw invalid();
    const episodes = new Set(data.membership.map(pair => pair[0]));
    checkSnapshot(data.before, ids, row.series_id, episodes);
    checkSnapshot(data.after, ids, row.series_id, episodes);
    if (data.before.creative_assets.length !== ids.size || data.after.creative_assets.length !== ids.size ||
        data.after.creative_assets.find(asset => asset.id === row.canonical_asset_id)?.owner_id !== row.series_id) throw invalid();
    const request = requests.get(data.request_id);
    const mergeResult = request && JSON.parse(request.result_json);
    if (request?.merge_id !== row.id || mergeResult?.status !== 'merged' ||
        mergeResult.history_id !== data.history_id) throw invalid();
    if (row.status === 'merged') {
      if (data.source_asset_ids.some(id => aliases.get(id)?.merge_id !== row.id)) throw invalid();
    } else {
      const undo = requests.get(data.undo?.request_id);
      const undoResult = undo && JSON.parse(undo.result_json);
      if (undo?.merge_id !== row.id || undoResult?.status !== 'undone' ||
          undoResult.history_id !== data.undo.history_id) throw invalid();
      checkSnapshot(data.undo.before, ids, row.series_id, episodes);
    }
  }
  for (const alias of aliases.values()) {
    const origin = assets.get(alias.id), target = assets.get(alias.target_id), merge = merges.get(alias.merge_id);
    if (alias.id === alias.target_id || aliases.has(alias.target_id) || origin?.kind !== 'character' ||
        origin.owner_type !== 'project' || origin.project_id !== alias.project_id || origin.archived_at === 0 ||
        memberships.get(alias.project_id) !== alias.series_id || target?.kind !== 'character' ||
        target.owner_type !== 'series' || target.owner_id !== alias.series_id || target.archived_at !== 0 ||
        merge?.status !== 'merged' || merge.canonical_asset_id !== alias.target_id || merge.series_id !== alias.series_id ||
        !JSON.parse(merge.data_json).source_asset_ids.includes(alias.id)) throw invalid();
  }
  const lookAliases = byId(tables.creative_character_look_aliases);
  for (const alias of lookAliases.values()) {
    const origin = looks.get(alias.id), target = looks.get(alias.target_id), person = aliases.get(alias.source_asset_id);
    if (alias.id === alias.target_id || lookAliases.has(alias.target_id) || origin?.asset_id !== alias.source_asset_id ||
        origin.archived_at === null || !target || target.archived_at !== null || target.asset_id !== person?.target_id ||
        person.merge_id !== alias.merge_id || person.series_id !== alias.series_id) throw invalid();
  }
  for (const row of requests.values()) {
    const result = JSON.parse(row.result_json), merge = merges.get(row.merge_id);
    if (!isRecord(result) || result.request_id !== row.id || !/^[a-f0-9]{64}$/.test(row.request_hash)) throw invalid();
    if (result.status === 'rejected') {
      // A series without assets or successful merges can be removed. Retain
      // its historical rejection to keep the request ID reserved.
      if (row.merge_id !== rejectedMergeId || !validRejectionReceipt(result)) throw invalid();
      continue;
    }
    if (result.merge_id !== row.merge_id || !['merged', 'undone'].includes(result.status) ||
        merge?.series_id !== row.series_id || !idOK(result.history_id)) throw invalid();
    const data = JSON.parse(merge.data_json);
    if (row.id !== (result.status === 'merged' ? data.request_id : data.undo?.request_id)) throw invalid();
  }
  for (const row of tables.creative_asset_overrides) {
    const score = JSON.parse(row.value_json);
    if (!row.field_key.startsWith('attribute_score:') || !score?.merge_id) continue;
    const merge = merges.get(score.merge_id);
    const source = assets.get(score.source_asset_id);
    if (merge?.status !== 'merged' || merge.canonical_asset_id !== row.asset_id || source?.project_id !== row.scope_id ||
        aliases.get(source.id)?.merge_id !== merge.id) throw invalid();
  }
}
