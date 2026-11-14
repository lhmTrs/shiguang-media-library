import { randomUUID } from 'node:crypto';
import { canonical, digest, nameKey, normalize } from './model.mjs';
import { activeChild, changedFields } from './character-merge-plan.mjs';

export const mergeEntities = {
  creative_assets: ['人物', 'id'],
  creative_looks: ['造型', 'asset_id'],
  creative_image_bindings: ['图片', 'asset_id'],
  project_character_attributes: ['本集评分', 'id'],
  series_character_attributes: ['全剧评分', 'id'],
  creative_asset_overrides: ['集或季覆盖', 'asset_id'],
  creative_asset_override_clocks: ['覆盖版本', 'asset_id'],
};

export function snapshotRows(db, assets) {
  return Object.fromEntries(Object.entries(mergeEntities).map(([table, [, owner]]) => {
    const query = db.prepare(`SELECT * FROM ${table} WHERE ${owner}=? ORDER BY id`);
    return [table, [...new Set(assets)].sort().flatMap(id => query.all(id)).sort((a, b) => a.id.localeCompare(b.id))];
  }));
}

function insert(db, table, row) {
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
}

function update(db, table, id, values) {
  const keys = Object.keys(values);
  if (keys.length) db.prepare(`UPDATE ${table} SET ${keys.map(key => key + '=?').join(',')} WHERE id=?`).run(...Object.values(values), id);
}

function snapshotVersion(service, assetId, summary, at) {
  const asset = service.store.get(assetId);
  insert(service.db, 'creative_asset_versions', { id: randomUUID(), asset_id: assetId, version: asset.revision,
    snapshot: canonical(asset), summary, created_at: at, updated_at: at });
}

function revision(row) { return Number(row.revision) + 1; }

function nextTimestamp(snapshot) {
  return Object.values(snapshot).flat().reduce((time, row) => Math.max(time, Number(row.updated_at ?? 0) + 1), Date.now());
}

function upsertOverride(db, assetId, projectId, field, value, now) {
  const id = digest(['episode', projectId, assetId, field]);
  const row = db.prepare('SELECT * FROM creative_asset_overrides WHERE id=?').get(id);
  const value_json = canonical(value);
  if (row) update(db, 'creative_asset_overrides', id, { value_json, revision: revision(row), updated_at: now });
  else insert(db, 'creative_asset_overrides', {
    id, scope_type: 'episode', scope_id: projectId, asset_id: assetId, field_key: field,
    value_json, revision: 1, created_at: now, updated_at: now,
  });
  const clock = db.prepare('SELECT * FROM creative_asset_override_clocks WHERE id=?').get(id);
  if (clock) update(db, 'creative_asset_override_clocks', id, { updated_at: now });
  else insert(db, 'creative_asset_override_clocks', {
    id, scope_type: 'episode', scope_id: projectId, asset_id: assetId, field_key: field, created_at: now, updated_at: now,
  });
}

function moveLooks(db, seriesId, mergeId, plan, now) {
  const { before, primary, moves } = plan;
  const baseLooks = new Map(before.creative_looks.map(row => [row.id, row]));
  let lookOrder = Math.max(-1, ...primary.looks.map(row => row.sort_order));
  let imageOrder = Math.max(-1, ...primary.images.map(row => row.sort_order));
  for (const move of moves.values()) {
    if (move.source_asset_id === primary.id) continue;
    const row = baseLooks.get(move.source_look_id);
    if (move.action === 'merge_into') {
      update(db, 'creative_looks', row.id, { archived_at: now, default_image_id: null, revision: revision(row), updated_at: now });
      insert(db, 'creative_character_look_aliases', { id: row.id, series_id: seriesId, source_asset_id: row.asset_id,
        target_id: move.result_look_id, merge_id: mergeId });
    } else {
      update(db, 'creative_looks', row.id, { asset_id: primary.id, sort_order: ++lookOrder, revision: revision(row), updated_at: now,
        data_json: canonical({ ...JSON.parse(row.data_json), name: move.result_name }) });
    }
    const images = before.creative_image_bindings.filter(image => image.look_id === row.id);
    for (const image of images) {
      update(db, 'creative_image_bindings', image.id, { asset_id: primary.id, look_id: move.result_look_id,
        sort_order: ++imageOrder, revision: revision(image), updated_at: now });
    }
    // A pre-existing representative is always kept. A previously empty
    // target adopts the source representative if one moved with this look.
    if (move.action === 'merge_into' && row.default_image_id) {
      const target = db.prepare('SELECT * FROM creative_looks WHERE id=?').get(move.result_look_id);
      if (!target.default_image_id) update(db, 'creative_looks', target.id, {
        default_image_id: row.default_image_id, revision: revision(target), updated_at: now,
      });
    }
  }
}

export function applyCharacterMerge(service, seriesId, requestId, plan) {
  const { db } = service;
  const { before, people, primary, view, episodes } = plan;
  const source = people.filter(person => person.id !== primary.id), ids = people.map(person => person.id).sort();
  const now = nextTimestamp(before);
  const mergeId = randomUUID(), historyId = randomUUID();
  moveLooks(db, seriesId, mergeId, plan, now);
  const firstLook = view.look_plan.items.find(item => item.action !== 'merge_into')?.result_look_id ?? null;
  const defaultLook = primary.default_look_id ?? firstLook;
  for (const person of source) {
    const { latest } = db.prepare('SELECT MAX(archived_at) latest FROM creative_assets WHERE owner_type=? AND owner_id=? AND kind=? AND name_key=?')
      .get(person.owner_type, person.owner_id, 'character', nameKey(person.name));
    update(db, 'creative_assets', person.id, { archived_at: Math.max(now, Number(latest) + 1),
      default_look_id: null, revision: revision(person), updated_at: now });
    insert(db, 'creative_character_aliases', { id: person.id, series_id: seriesId, project_id: person.project_id,
      target_id: primary.id, merge_id: mergeId });
  }
  update(db, 'creative_assets', primary.id, { project_id: null, owner_type: 'series', owner_id: seriesId,
    default_look_id: defaultLook, revision: revision(primary), updated_at: now });
  const ownScore = before.project_character_attributes.find(row => row.id === primary.id);
  if (ownScore) {
    insert(db, 'series_character_attributes', { id: primary.id, series_id: seriesId, revision: revision(ownScore),
      data_json: ownScore.data_json, created_at: now, updated_at: now });
    db.prepare('DELETE FROM project_character_attributes WHERE id=?').run(primary.id);
  }
  for (const row of view.score_plan.episode_overrides) {
    for (const { dimension_id, ...value } of row.entries) upsertOverride(db, primary.id, row.project_id, 'attribute_score:' + dimension_id,
      { ...value, source_asset_id: row.source_asset_id, merge_id: mergeId }, now);
  }
  for (const row of view.default_look_plan) {
    upsertOverride(db, primary.id, row.project_id, 'default_look', row.result_look_id, now);
    for (const { look_id, image_id } of row.image_overrides) upsertOverride(db, primary.id, row.project_id, 'default_image:' + look_id, image_id, now);
  }
  for (const id of ids) {
    normalize(service.store.get(id));
    snapshotVersion(service, id, '合并同名人物 ' + mergeId, now);
  }
  const after = snapshotRows(db, ids);
  const affectedEpisodes = new Set([
    ...view.default_look_plan.map(row => row.project_id),
    ...view.reference_plan.by_episode.map(row => row.project_id),
    ...before.creative_asset_overrides.filter(row => row.scope_type === 'episode').map(row => row.scope_id),
  ]);
  const data = {
    request_id: requestId, history_id: historyId, asset_ids: ids, source_asset_ids: source.map(person => person.id),
    episode_ids: [...affectedEpisodes].sort(), before, after,
    membership: episodes.map(episode => [episode.project_id, episode.season_id]),
    config: service.store.attributes.seriesConfig(seriesId), alignment: service.alignment.state(seriesId),
    references: service.references(people, service.documents(episodes)),
    aliases: db.prepare('SELECT * FROM creative_character_aliases WHERE target_id=? ORDER BY id').all(primary.id),
    lookAliases: db.prepare(`SELECT l.* FROM creative_character_look_aliases l
      JOIN creative_looks t ON t.id=l.target_id WHERE t.asset_id=? ORDER BY l.id`).all(primary.id),
  };
  insert(db, 'creative_character_merges', { id: mergeId, series_id: seriesId, canonical_asset_id: primary.id,
    status: 'merged', created_at: now, updated_at: now, data_json: canonical(data) });
  const remaining = service.listGroups(seriesId, episodes);
  return { request_id: requestId, merge_id: mergeId, status: 'merged', series_id: seriesId, group_id: view.group_id,
    canonical_asset_id: primary.id, alias_count: source.length,
    merged_look_count: view.look_plan.items.filter(row => row.action === 'merge_into').length,
    references: service.counts(data.references), history_id: historyId, can_undo: true,
    remaining_group_count: remaining.length, next_group_id: remaining[0]?.id ?? null };
}

const rowMap = rows => new Map(rows.map(row => [row.id, row]));
const same = (a, b) => canonical(a) === canonical(b);
const impact = data => ({ asset_ids: data.asset_ids, episode_ids: data.episode_ids });
const entityChange = (table, id, row, kind, action, fields) => ({
  entity: table, entity_id: id, ...(row?.project_id || row?.scope_type === 'episode' ? { project_id: row.project_id ?? row.scope_id } : {}),
  kind, action, fields,
});

const mergeFieldKeys = {
  creative_assets: 'data_json',
  creative_looks: 'data_json',
  creative_image_bindings: 'data_json',
  project_character_attributes: 'data_json',
  series_character_attributes: 'data_json',
};

function mergeFields(table, before, after) {
  const column = mergeFieldKeys[table];
  const changes = changedFields(before, after);
  if (!column || !changes.includes(column)) return changes;
  const left = JSON.parse(before[column]), right = JSON.parse(after[column]);
  return [...changes.filter(field => field !== column), ...[...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter(key => Object.hasOwn(left, key) !== Object.hasOwn(right, key) || !same(left[key], right[key]))
    .map(key => column + '.' + key)];
}

function restoreValues(table, original, applied, live) {
  const column = mergeFieldKeys[table];
  const fields = {};
  for (const key of mergeFields(table, original, applied)) {
    if (column && key.startsWith(column + '.')) {
      const before = JSON.parse(original[column]), current = JSON.parse(fields[column] ?? live[column]);
      const field = key.slice(column.length + 1);
      if (Object.hasOwn(before, field)) current[field] = before[field];
      else delete current[field];
      fields[column] = canonical(current);
    } else fields[key] = original[key];
  }
  return fields;
}

export function planCharacterUndo(service, record) {
  const { data, series_id: seriesId, id: mergeId, canonical_asset_id: primary } = record;
  if (record.status === 'undone') return { record, current: null, ready: false, undo_token: null, merge_id: mergeId,
    status: 'undone', changes: [], blockers: [], impact: impact(data) };
  const current = snapshotRows(service.db, data.asset_ids);
  const episodes = service.episodes(seriesId), docs = service.documents(episodes);
  const refs = service.references(data.asset_ids.map(id => ({ id })), docs);
  const blockers = [], changes = [];
  const block = (code, detail = {}) => blockers.push({ code, ...detail });
  const aliases = service.db.prepare('SELECT * FROM creative_character_aliases WHERE target_id=? ORDER BY id').all(primary);
  const lookAliases = service.db.prepare(`SELECT l.* FROM creative_character_look_aliases l JOIN creative_looks t
    ON t.id=l.target_id WHERE t.asset_id=? ORDER BY l.id`).all(primary);
  if (!same(data.aliases, aliases) || !same(data.lookAliases, lookAliases)) block('CHARACTER_MERGE_DEPENDENCY');
  const affected = new Set(data.episode_ids);
  if (!same(episodes.filter(row => affected.has(row.project_id)).map(row => [row.project_id, row.season_id]).sort(),
      data.membership.filter(([id]) => affected.has(id)).sort()) ||
      !same(service.alignment.state(seriesId), data.alignment) ||
      !same(service.store.attributes.seriesConfig(seriesId), data.config)) block('CHARACTER_MERGE_SCOPE_CHANGED');
  const referenceKeys = references => [
    ...references.shots.flatMap(row => ['assets', 'looks', 'images'].flatMap(field =>
      row[field].map(id => canonical([row.document_id, row.shot_id, field, id])))),
    ...references.manifests.flatMap(row => row.entries.map(id => canonical([row.document_id, 'manifest', id]))),
    ...references.slots.map(canonical),
  ];
  const baseline = new Map();
  for (const key of referenceKeys(data.references)) baseline.set(key, (baseline.get(key) ?? 0) + 1);
  for (const key of referenceKeys(refs)) {
    const old = baseline.get(key) ?? 0;
    if (!old) {
      block('CHARACTER_MERGE_NEW_REFERENCE');
      break;
    }
    baseline.set(key, old - 1);
  }
  // Restoring a source must not displace a newer asset with that name.
  for (const row of data.before.creative_assets) {
    const clash = service.db.prepare('SELECT id FROM creative_assets WHERE owner_type=? AND owner_id=? AND kind=? AND name_key=? AND archived_at=0')
      .get(row.owner_type, row.owner_id, row.kind, row.name_key);
    if (clash && !data.asset_ids.includes(clash.id)) block('CHARACTER_MERGE_NAME_CONFLICT', { asset_id: row.id });
  }
  const savedLooks = rowMap(data.before.creative_looks);
  const savedBindings = rowMap(data.before.creative_image_bindings);
  const currentLooks = rowMap(current.creative_looks);
  // A new child following a moved look cannot remain on the shared identity
  // while that look returns to its original episode.
  for (const binding of current.creative_image_bindings) {
    if (!savedBindings.has(binding.id) && savedLooks.get(binding.look_id)?.asset_id &&
        savedLooks.get(binding.look_id).asset_id !== currentLooks.get(binding.look_id)?.asset_id)
      block('CHARACTER_MERGE_NEW_LOOK_DEPENDENCY', { entity_id: binding.id });
  }
  const restoringLocal = data.before.creative_assets.some(row => row.id === primary && row.owner_type === 'project');
  if (restoringLocal && [...current.creative_asset_overrides, ...current.creative_asset_override_clocks].some(row =>
    !data.after.creative_asset_override_clocks.some(old => old.id === row.id))) block('CHARACTER_MERGE_NEW_OVERRIDE');
  if (restoringLocal && current.series_character_attributes.length && !data.after.series_character_attributes.length) {
    block('CHARACTER_MERGE_NEW_SCORES');
  }
  for (const row of current.creative_asset_overrides) {
    if (row.field_key === 'default_look' || row.field_key.startsWith('default_image:')) {
      const previous = data.after.creative_asset_overrides.find(item => item.id === row.id);
      if (same(row, previous)) continue;
      const value = JSON.parse(row.value_json), lookId = row.field_key.split(':')[1] ?? value;
      if (value && (savedLooks.has(lookId) && savedLooks.get(lookId).asset_id !== primary ||
          savedBindings.has(value) && savedBindings.get(value).asset_id !== primary))
        block('CHARACTER_MERGE_NEW_OVERRIDE', { entity_id: row.id });
    }
  }
  for (const [table] of Object.entries(mergeEntities)) {
    if (table === 'creative_asset_override_clocks') continue;
    const after = rowMap(data.after[table]), before = rowMap(data.before[table]), live = rowMap(current[table]);
    for (const id of new Set([...after.keys(), ...before.keys(), ...live.keys()])) {
      const expected = after.get(id), original = before.get(id), actual = live.get(id);
      const drift = mergeFields(table, actual, expected), touched = mergeFields(table, original, expected);
      if (!drift.length) continue;
      const overlap = drift.filter(field => touched.includes(field) || field === 'identity' && touched.length || touched.includes('identity'));
      const unrelated = drift.filter(field => !overlap.includes(field));
      const sample = actual ?? expected ?? original;
      if (table === 'creative_assets' && drift.some(field => ['owner_id', 'owner_type', 'project_id', 'archived_at', 'identity'].includes(field))) {
        block('CHARACTER_MERGE_IDENTITY_CHANGED', { entity_id: id });
        changes.push(entityChange(table, id, sample, 'edited', 'block', drift));
        continue;
      }
      if (overlap.length) changes.push(entityChange(table, id, sample, 'edited', 'restore_with_confirmation', overlap));
      if (unrelated.length) changes.push(entityChange(table, id, sample, expected ? 'edited' : 'added', 'preserve', unrelated));
    }
  }
  const projectAsset = id => {
    const before = data.before.creative_assets.find(row => row.id === id);
    const restored = table => {
      const original = rowMap(data.before[table]), applied = rowMap(data.after[table]), live = rowMap(current[table]);
      return [...new Set([...original.keys(), ...live.keys()])].flatMap(key => {
        const old = original.get(key), after = applied.get(key), row = live.get(key);
        if (!old) return after || !row ? [] : [row];
        if (!row) return changedFields(old, after).length ? [old] : [];
        return [{ ...row, ...(after ? restoreValues(table, old, after, row) : {}) }];
      }).filter(row => row.asset_id === id).map(row => ({ ...row, ...JSON.parse(row.data_json) }));
    };
    const looks = restored('creative_looks'), images = restored('creative_image_bindings');
    const expected = data.after.creative_assets.find(row => row.id === id);
    const live = current.creative_assets.find(row => row.id === id);
    const target = { ...live, ...restoreValues('creative_assets', before, expected, live) };
    if (before.owner_type === 'project' && expected.owner_type === 'series' && !before.default_look_id && !target.default_look_id) {
      target.default_look_id = looks.find(activeChild)?.id ?? null;
    }
    normalize({ ...target, ...JSON.parse(target.data_json), looks, images });
  };
  if (!blockers.length) {
    for (const id of data.asset_ids) {
      try { projectAsset(id); }
      catch { block('CHARACTER_MERGE_DEFAULT_OR_BINDING_CONFLICT', { asset_id: id }); }
    }
  }
  const ready = blockers.length === 0;
  const status = !ready ? 'blocked' : changes.some(row => row.action === 'restore_with_confirmation') ? 'review_required' : 'clean';
  const undo_token = ready ? service.alignment.token('character-merge-undo', [record.id, record.updated_at, current, episodes, refs, changes]) : null;
  return { record, current, ready, undo_token, merge_id: mergeId, status, changes, blockers, impact: impact(data) };
}

function restoreTable(db, table, original, expected, live, now) {
  const before = rowMap(original), after = rowMap(expected), current = rowMap(live);
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const prior = before.get(id), applied = after.get(id), actual = current.get(id);
    const touched = mergeFields(table, prior, applied);
    if (!touched.length && table !== 'creative_assets') continue;
    if (!prior) {
      if (actual) db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
      continue;
    }
    if (!actual) {
      const restored = { ...prior };
      if ('revision' in prior) restored.revision = Math.max(Number(prior.revision), Number(applied?.revision ?? 0)) + 1;
      if ('updated_at' in prior) restored.updated_at = now;
      insert(db, table, restored);
      continue;
    }
    const fields = restoreValues(table, prior, applied, actual);

    if ('revision' in actual) fields.revision = Math.max(Number(actual.revision), Number(applied?.revision ?? 0)) + 1;
    if ('updated_at' in actual) fields.updated_at = now;
    update(db, table, id, fields);
  }
}

export function applyCharacterUndo(service, plan, requestId) {
  const { db } = service;
  const { record, current } = plan, { data } = record;
  const now = Math.max(record.updated_at + 1, nextTimestamp(current));
  const historyId = randomUUID();
  for (const table of Object.keys(mergeEntities)) {
    if (table === 'creative_asset_override_clocks') continue;
    restoreTable(db, table, data.before[table], data.after[table], current[table], now);
  }
  // Retain the clocks of pre-existing fields; any removed row still needs a
  // new field token while its shared owner exists.
  const priorClocks = rowMap(data.before.creative_asset_override_clocks);
  const primaryBefore = data.before.creative_assets.find(row => row.id === record.canonical_asset_id);
  if (primaryBefore.owner_type === 'project') {
    const local = data.before.project_character_attributes.find(row => row.id === primaryBefore.id);
    const shared = current.series_character_attributes.find(row => row.id === primaryBefore.id);
    if (local && shared) update(db, 'project_character_attributes', primaryBefore.id, {
      revision: Math.max(revision(local), revision(shared)),
    });
  }
  for (const row of data.after.creative_asset_override_clocks) {
    const prior = priorClocks.get(row.id);
    if (same(prior, row)) continue;
    const clock = current.creative_asset_override_clocks.find(item => item.id === row.id);
    if (primaryBefore.owner_type === 'project') {
      if (clock) db.prepare('DELETE FROM creative_asset_override_clocks WHERE id=?').run(row.id);
    } else if (clock) update(db, 'creative_asset_override_clocks', row.id, { updated_at: now });
    else insert(db, 'creative_asset_override_clocks', { ...row, updated_at: now });
  }
  for (const table of ['creative_character_aliases', 'creative_character_look_aliases'])
    db.prepare(`DELETE FROM ${table} WHERE merge_id=?`).run(record.id);
  for (const id of data.asset_ids) {
    const restored = service.store.get(id);
    if (id === primaryBefore.id && primaryBefore.owner_type === 'project' && !primaryBefore.default_look_id && !restored.default_look_id) {
      const fallback = restored.looks.find(activeChild)?.id ?? null;
      if (fallback) update(db, 'creative_assets', id, { default_look_id: fallback });
    }
    normalize(service.store.get(id));
    snapshotVersion(service, id, '撤销同名人物合并 ' + record.id, now);
  }
  update(db, 'creative_character_merges', record.id, { status: 'undone', updated_at: now,
    data_json: canonical({ ...data, undo: { request_id: requestId, history_id: historyId, at: now, before: current, changes: plan.changes } }) });
  return { request_id: requestId, merge_id: record.id, status: 'undone', restored_asset_ids: data.asset_ids, history_id: historyId };
}
