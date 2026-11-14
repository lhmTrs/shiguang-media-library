import { randomUUID } from 'node:crypto';
import { canonical, digest, idOK, nameKey } from './model.mjs';
import { isRecord } from '../project-attributes/model.mjs';
import { creativeReferenceSlots, explicitAssetShots, shotReferenceRows } from '../storyboard/asset-references.mjs';
import { timeline } from '../storyboard/shared/model.mjs';
import { activeChild, lookPlan, mergeError, planScores, validLookChoices } from './character-merge-plan.mjs';
import { applyCharacterMerge, planCharacterUndo, applyCharacterUndo, snapshotRows } from './character-merge-write.mjs';

import { rejectedMergeId, rejectionReceipt, rejectedResponse } from './character-merge-receipts.mjs';

const tokenFormat = /^[a-f0-9]{64}$/;
const isToken = value => typeof value === 'string' && tokenFormat.test(value);
const stale = () => mergeError('CHARACTER_MERGE_STALE', '人物资料、评分、引用或归组已变化，请重新预览');
const undoStale = () => mergeError('CHARACTER_MERGE_UNDO_STALE', '撤销预览已变化，请重新核对');
const invalid = () => mergeError('CHARACTER_MERGE_INVALID_INPUT', '合并人物请求格式无效', 422);
const absent = () => mergeError('CHARACTER_MERGE_NOT_FOUND', '当前剧内没有该合并记录', 404);
const shape = (input, required, optional = []) => isRecord(input) && required.every(key => Object.hasOwn(input, key)) &&
  Object.keys(input).every(key => required.includes(key) || optional.includes(key));
const groupKey = (seriesId, key) => digest(['character-merge-group', seriesId, 'character', key]);
const excerpt = value => value.length > 160 ? value.slice(0, 159) + '…' : value;

export class CharacterMerges {
  constructor(store) { this.store = store; }
  get db() { return this.store.db; }
  get directory() { return this.store.lib.projectSeries; }
  get alignment() { return this.store.attributes.alignment; }

  resolveAsset(projectId, assetId) {
    if (!idOK(assetId) || !this.directory || !projectId) return assetId;
    const row = this.db.prepare(`SELECT a.target_id FROM creative_character_aliases a
      JOIN project_series_members m ON m.series_id=a.series_id AND m.id=?
      JOIN creative_assets t ON t.id=a.target_id AND t.owner_type='series' AND t.owner_id=a.series_id
        AND t.kind='character' AND t.archived_at=0
      JOIN creative_assets s ON s.id=a.id AND s.kind='character' AND s.archived_at>0
      WHERE a.id=?`).get(projectId, assetId);
    return row?.target_id ?? assetId;
  }

  resolveLook(projectId, lookId) {
    if (!idOK(lookId) || !this.directory || !projectId) return lookId;
    const row = this.db.prepare(`SELECT a.target_id FROM creative_character_look_aliases a
      JOIN project_series_members m ON m.series_id=a.series_id AND m.id=?
      JOIN creative_looks l ON l.id=a.target_id AND l.archived_at IS NULL
      JOIN creative_assets t ON t.id=l.asset_id AND t.owner_type='series' AND t.owner_id=a.series_id AND t.archived_at=0
      WHERE a.id=?`).get(projectId, lookId);
    return row?.target_id ?? lookId;
  }

  family(assetId) {
    const assetIds = new Set([assetId, ...this.db.prepare('SELECT id FROM creative_character_aliases WHERE target_id=?').all(assetId).map(row => row.id)]);
    const lookIds = new Set(), imageIds = new Set();
    for (const id of assetIds) {
      for (const row of this.db.prepare('SELECT id FROM creative_looks WHERE asset_id=?').all(id)) lookIds.add(row.id);
      for (const row of this.db.prepare('SELECT id FROM creative_image_bindings WHERE asset_id=?').all(id)) imageIds.add(row.id);
    }
    for (const id of [...lookIds]) {
      for (const row of this.db.prepare('SELECT id FROM creative_character_look_aliases WHERE target_id=?').all(id)) lookIds.add(row.id);
    }
    return { assetIds, lookIds, imageIds };
  }

  destination(scope, assetId) {
    if (!scope.series_id || !idOK(assetId)) return null;
    const row = this.db.prepare(`SELECT t.id,t.name,t.revision FROM creative_character_aliases a
      JOIN creative_assets t ON t.id=a.target_id AND t.owner_type='series' AND t.owner_id=a.series_id
        AND t.kind='character' AND t.archived_at=0 WHERE a.id=? AND a.series_id=?`).get(assetId, scope.series_id);
    return row ? {
      requested_asset_id: assetId, canonical_asset_id: row.id, series_id: scope.series_id,
      canonical_asset: { id: row.id, name: row.name, revision: Number(row.revision) },
      canonical_path: '/api/project-assets/scopes/series/' + scope.series_id + '/assets/' + row.id,
    } : null;
  }

  assertCurrent(scope, assetId) {
    const target = this.destination(scope, assetId);
    if (target) throw mergeError('ASSET_MERGED', '此人物已合并，请打开全剧主体后操作', 409, target);
  }

  episodes(seriesId) {
    return this.db.prepare(`SELECT p.id project_id,p.name project_name,m.episode_no,m.season_id,s.season_no,s.label season_label
      FROM project_series_members m JOIN media_projects p ON p.id=m.id
      LEFT JOIN project_series_seasons s ON s.id=m.season_id AND s.series_id=m.series_id
      WHERE m.series_id=? AND p.project_kind='normal' ORDER BY COALESCE(s.season_no,0),m.episode_no,p.id`).all(seriesId)
      .map(row => ({ ...row, episode_no: Number(row.episode_no), season_no: row.season_no === null ? null : Number(row.season_no) }));
  }

  candidates(seriesId, episodes, key) {
    const query = `SELECT id FROM creative_assets WHERE owner_type=? AND owner_id=?
      AND kind='character' AND archived_at=0` + (key ? ' AND name_key=?' : '') + ' ORDER BY id';
    const read = (type, id, episode) => this.db.prepare(query).all(type, id, ...(key ? [key] : []))
      .map(row => ({ ...this.store.get(row.id), episode }));
    return [...read('series', seriesId, null), ...episodes.flatMap(episode => read('project', episode.project_id, episode))];
  }

  documents(episodes) {
    return episodes.flatMap(({ project_id }) => {
      const row = this.store.storyboards?.head(project_id);
      return row ? [{ ...row, project: JSON.parse(row.document_json) }] : [];
    });
  }

  references(people, documents, includeAliases = true) {
    const families = people.map(person => includeAliases ? this.family(person.id) : {
      assetIds: new Set([person.id]), lookIds: new Set(person.looks.map(look => look.id)),
      imageIds: new Set(person.images.map(image => image.id)),
    });
    const union = field => new Set(families.flatMap(family => [...family[field]]));
    const assetIds = union('assetIds'), lookIds = union('lookIds'), imageIds = union('imageIds');
    const shots = [], manifests = [], slots = [];
    for (const doc of documents) {
      const entries = (doc.project.asset_manifest?.character ?? []).filter(entry => assetIds.has(entry.id)).map(entry => entry.id).sort();
      if (entries.length) manifests.push({ project_id: doc.project_id, document_id: doc.id, entries });
      for (const { slot, type, id } of creativeReferenceSlots(doc.project)) {
        const ids = type === 'look' ? lookIds : type === 'image' || type === 'legacy-image' ? imageIds : assetIds;
        if (ids.has(id) && !(type === 'legacy-image' && doc.project.assets?.some(asset => asset.id === id)))
          slots.push([doc.id, slot, id]);
      }
      const explicit = new Set(explicitAssetShots(doc.project, { assetIds, lookIds, imageIds }).map(row => row.shotId));
      const rows = timeline(doc.project);
      const dialogue = new Map(rows.flatMap(({shot}) => (shot.dialogue ?? []).map(line => [shot.id + '/' + line.id, line])));
      for (const { shot, scene } of rows) {
        const ids = new Set([...shot.character_ids ?? [], ...(shot.character_presence ?? []).map(row => row.character_id),
          ...(shot.dialogue ?? []).map(row => row.character_id),
          ...(shot.audio_continuations ?? []).map(row => dialogue.get(row.source_shot_id + '/' + row.dialogue_id)?.character_id)].filter(id => assetIds.has(id)));
        const applicable = shotReferenceRows(doc.project, shot, scene);
        for (const row of applicable) for (const id of [row.subject_id, row.creative_asset_id]) if (assetIds.has(id)) ids.add(id);
        const looks = [...new Set(applicable.map(row => row.look_id).filter(id => lookIds.has(id)))].sort();
        const images = [...new Set(applicable.flatMap(row => [row.asset_id, row.image_id, row.image_binding_id, row.binding_id])
          .filter(id => imageIds.has(id)))].sort();
        if (explicit.has(shot.id) || ids.size) shots.push({
          project_id: doc.project_id, document_id: doc.id, shot_id: shot.id, assets: [...ids].sort(), looks, images,
        });
      }
    }
    return { shots, manifests, slots };
  }

  counts(refs) {
    return { shots: refs.shots.length, manifests: refs.manifests.length,
      manifest_entries: refs.manifests.reduce((total, row) => total + row.entries.length, 0) };
  }

  member(person, docs, primaryLocked = person.owner_type === 'series') {
    const record = this.db.prepare('SELECT data_json FROM ' +
      (person.owner_type === 'series' ? 'series_character_attributes' : 'project_character_attributes') + ' WHERE id=?').get(person.id);
    let scores;
    try { scores = record ? JSON.parse(record.data_json) : {}; } catch { scores = {}; }
    return { asset_id: person.id, asset_revision: person.revision, owner_type: person.owner_type, owner_id: person.owner_id,
      episode: person.episode, primary_locked: primaryLocked,
      look_count: person.looks.filter(activeChild).length, image_count: person.images.filter(activeChild).length,
      scored_dimensions: Object.values(scores ?? {}).filter(score => score?.value != null).length,
      default_look_id: person.default_look_id, references: this.counts(this.references([person], docs, false)),
      base_info_excerpt: excerpt(person.base_info), performance_info_excerpt: excerpt(person.performance_info) };
  }

  related(seriesId, name) {
    const empty = { group_id: null, items: [], action: 'none' };
    if (!seriesId || !this.directory) return empty;
    const episodes = this.episodes(seriesId);
    const key = nameKey(name), people = this.candidates(seriesId, episodes, key);
    if (!people.length) return empty;
    const docs = this.documents(episodes);
    const items = people.map(person => this.member(person, docs, people.length > 1 && person.owner_type === 'series'));
    if (items.length > 1) return { group_id: groupKey(seriesId, key), items, action: 'merge' };
    if (people[0].owner_type === 'project') return { ...empty, items, action: 'promote', promotion_project_id: people[0].project_id };
    return { ...empty, items };
  }

  listGroups(seriesId, episodes, onlyGroup) {
    const rows = this.db.prepare(`SELECT a.id,a.name_key,a.owner_type,a.owner_id FROM creative_assets a
      LEFT JOIN project_series_members m ON a.owner_type='project' AND m.id=a.owner_id
      WHERE a.kind='character' AND a.archived_at=0 AND
        ((a.owner_type='series' AND a.owner_id=?) OR (a.owner_type='project' AND m.series_id=?))
      ORDER BY a.name_key,a.id`).all(seriesId, seriesId);
    const order = new Map(episodes.map((row, index) => [row.project_id, { row, index }]));
    return [...Map.groupBy(rows.filter(row => row.owner_type === 'series' || order.has(row.owner_id)), row => row.name_key)]
      .filter(([key, members]) => members.length > 1 && (!onlyGroup || groupKey(seriesId, key) === onlyGroup))
      .map(([key, members]) => ({ id: groupKey(seriesId, key),
        people: members.sort((a, b) => (order.get(a.owner_id)?.index ?? -1) - (order.get(b.owner_id)?.index ?? -1))
          .map(row => ({ ...this.store.get(row.id), episode: order.get(row.owner_id)?.row ?? null })) }));
  }

  groups(seriesId, { cursor, limit } = {}) {
    const size = limit === undefined ? 30 : Number(limit);
    if (Array.isArray(limit) || !Number.isSafeInteger(size) || size < 1 || size > 100 ||
        cursor !== undefined && (typeof cursor !== 'string' || !/^[a-f0-9]{64}$/.test(cursor))) throw invalid();
    return this.alignment.read(() => {
      const scope = this.store.scoped.scope('series', seriesId);
      const episodes = this.episodes(seriesId), docs = this.documents(episodes), groups = this.listGroups(seriesId, episodes);
      const offset = cursor === undefined ? 0 : groups.findIndex(group => group.id === cursor) + 1;
      if (cursor !== undefined && offset === 0) throw stale();
      const refs = this.references(groups.flatMap(group => group.people), docs);
      const items = groups.slice(offset, offset + size).map(({ id, people }) => ({
        group_id: id, name: people[0].name, members: people.map(person => this.member(person, docs)),
        references: this.counts(this.references(people, docs)),
      }));
      return { series_id: seriesId, alignment_status: this.alignment.state(seriesId).status, context_token: scope.context_token,
        summary: { group_count: groups.length, referenced_shot_count: refs.shots.length, manifest_count: refs.manifests.length },
        items, next_cursor: groups.length > offset + size ? items.at(-1).group_id : null };
    });
  }

  buildPreview(seriesId, input) {
    const scope = this.store.scoped.scope('series', seriesId);
    this.store.scoped.assertContextToken(scope, input.context_token);
    const episodes = this.episodes(seriesId);
    const group = this.listGroups(seriesId, episodes, input.group_id)[0];
    if (!group) throw stale();
    const people = group.people, locked = people.find(person => person.owner_type === 'series');
    if (locked && locked.id !== input.primary_asset_id) throw mergeError('CHARACTER_MERGE_PRIMARY_REQUIRED',
      '此组必须以全剧共享人物为主体', 422, { primary_asset_id: locked.id });
    const primary = people.find(person => person.id === input.primary_asset_id);
    if (!primary) throw stale();
    const docs = this.documents(episodes), refs = this.references(people, docs), state = this.alignment.state(seriesId);
    const before = snapshotRows(this.db, people.map(person => person.id));
    const targetConfig = this.store.attributes.seriesConfig(seriesId);
    const looks = lookPlan(people, primary, input.choices, refs.shots);
    const score = planScores({ people, primary, rows: [...before.project_character_attributes, ...before.series_character_attributes],
      dimensions: targetConfig.dimensions, overrides: before.creative_asset_overrides });
    const blockers = [...score.blockers];
    if (state.status !== 'aligned') blockers.push({ code: 'ATTRIBUTE_ALIGNMENT_REQUIRED', series_id: seriesId });
    for (const person of people.filter(person => person.id !== primary.id)) {
      if (this.family(person.id).assetIds.size > 1) blockers.push({ code: 'CHARACTER_MERGE_DEPENDENCY', asset_id: person.id });
    }
    const moves = new Map(looks.items.map(item => [item.source_look_id, item]));
    const defaults = people.filter(person => person.project_id).map(person => {
      const old = person.default_look_id, target = moves.get(old);
      const coverChoices = new Map();
      const orderedLooks = person.looks.filter(activeChild).sort((a, b) => Number(b.id === old) - Number(a.id === old));
      const conflicts = [];
      for (const look of orderedLooks) {
        const destination = moves.get(look.id);
        if (!destination || destination.action !== 'merge_into' || !look.default_image_id) continue;
        const look_id = destination.result_look_id, image_id = look.default_image_id;
        if (coverChoices.has(look_id)) {
          conflicts.push({ field: 'default_image', look_id, previous: image_id, next: coverChoices.get(look_id).image_id });
          continue;
        }
        coverChoices.set(look_id, { look_id, image_id });
      }
      const oldSettings = before.creative_asset_overrides.filter(row => row.scope_type === 'episode' && row.scope_id === person.project_id);
      for (const row of oldSettings) {
        const image = coverChoices.get(row.field_key.split(':')[1]);
        const previous = JSON.parse(row.value_json);
        if (row.field_key === 'default_look' && previous !== (target?.result_look_id ?? null)) {
          conflicts.push({ field: 'default_look', previous, next: target?.result_look_id ?? null });
        } else if (row.field_key.startsWith('default_image:') && image && previous !== image.image_id) {
          conflicts.push({ field: 'default_image', look_id: image.look_id, previous, next: image.image_id });
        }
      }
      return { project_id: person.project_id, source_asset_id: person.id, old_look_id: old,
        result_look_id: target?.result_look_id ?? null, mode: old === null ? 'explicit_empty' : 'set',
        image_overrides: [...coverChoices.values()], conflicts };
    });
    if (looks.items.filter(item => item.action !== 'merge_into').length + primary.looks.filter(look => !activeChild(look)).length > 200 ||
        people.reduce((count, person) => count + person.images.length, 0) > 1000) blockers.push({ code: 'CHARACTER_MERGE_ASSET_LIMIT' });
    const reference_plan = { ...this.counts(refs), writes_storyboards: false, by_episode: episodes.map(({project_id}) => ({
      project_id, ...this.counts({ shots: refs.shots.filter(row => row.project_id === project_id),
        manifests: refs.manifests.filter(row => row.project_id === project_id) }),
      look_resolutions: looks.items.filter(item => item.action === 'merge_into' &&
        refs.shots.some(row => row.project_id === project_id && row.looks.includes(item.source_look_id)))
        .map(item => ({ requested_look_id: item.source_look_id, canonical_look_id: item.result_look_id })),
    })).filter(row => row.shots || row.manifests) };
    const text_plan = { base_source_asset_id: primary.id, other_sources: people.filter(person => person.id !== primary.id)
      .map(({id: source_asset_id, project_id, base_info, performance_info}) => ({source_asset_id, project_id, base_info, performance_info})) };
    const ready = blockers.length === 0;
    const view = { ready, preview_token: null, group_id: group.id, primary_asset_id: primary.id,
      members: people.map(person => this.member(person, docs)), choices: looks.choices,
      look_plan: { items: looks.items, conflicts: looks.conflicts }, score_plan: score.view,
      default_look_plan: defaults, reference_plan, text_plan, blockers };
    if (ready) {
      const hash = this.alignment.token('character-merge', [scope.context_token, state, targetConfig, before, episodes,
        docs.map(row => [row.id, row.revision, digest(row.document_json)]), view]);
      view.preview_token = [hash, group.id, primary.id].join('.');
    }
    return { view, before, episodes, people, primary, moves };
  }

  preview(seriesId, input) {
    if (!shape(input, ['group_id', 'primary_asset_id', 'context_token'], ['choices']) ||
        !/^[a-f0-9]{64}$/.test(input.group_id) || !idOK(input.primary_asset_id)) throw invalid();
    return this.alignment.read(() => this.buildPreview(seriesId, input).view);
  }

  run(seriesId, input, operation, prepare, apply) {
    if (!idOK(input?.request_id)) throw invalid();
    if (this.store.lib.migrating) throw mergeError('CHARACTER_MERGE_BUSY', '数据库正在迁移，请稍后合并人物', 423);
    const id = input.request_id.toLowerCase(), hash = digest([seriesId, operation, input]);
    if (this.db.kind === 'mysql') this.db.exec('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    const result = this.directory.transaction(() => {
      this.directory.series(seriesId);
      const old = this.db.prepare('SELECT * FROM creative_character_merge_requests WHERE id=?').get(id);
      if (old) {
        if (old.request_hash !== hash) throw mergeError('REQUEST_ID_CONFLICT', '请求编号已用于不同操作');
        const saved = JSON.parse(old.result_json);
        return saved.status === 'rejected' ? saved : this.result(seriesId, saved);
      }
      this.alignment.lock(this.episodes(seriesId).map(row => row.project_id));
      let plan, receipt;
      // Only read-only preconditions can settle a business rejection. A write,
      // receipt insertion, or commit failure must leave the transaction by throwing.
      try { plan = prepare(); }
      catch (error) {
        receipt = rejectionReceipt(id, error);
        if (!receipt) throw error;
      }
      if (!receipt) receipt = apply(plan, id);
      const now = Date.now();
      this.db.prepare('INSERT INTO creative_character_merge_requests (id,series_id,merge_id,request_hash,result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, seriesId, receipt.merge_id ?? rejectedMergeId, hash, canonical(receipt), now, now);
      return receipt;
    });
    // Throw only after the receipt has committed, including on replay.
    if (result.status === 'rejected') throw rejectedResponse(result);
    return result;
  }

  confirm(seriesId, input) {
    return this.run(seriesId, input, 'confirm', () => {
      if (!shape(input, ['request_id', 'preview_token', 'context_token', 'choices']) ||
          typeof input.preview_token !== 'string' || !isToken(input.context_token) ||
          !validLookChoices(input.choices)) throw invalid();
      const [hash, group, primary, extra] = input.preview_token.split('.');
      if (!isToken(hash) || !isToken(group) || !idOK(primary) || extra !== undefined) throw invalid();
      if (this.alignment.state(seriesId).status !== 'aligned') throw mergeError('ATTRIBUTE_ALIGNMENT_REQUIRED', '请先统一目标剧的人物属性维度');
      let plan;
      try {
        plan = this.buildPreview(seriesId, { context_token: input.context_token, choices: input.choices,
          group_id: group, primary_asset_id: primary });
      } catch (error) {
        if (['ASSET_SCOPE_CHANGED', 'CHARACTER_MERGE_PRIMARY_REQUIRED', 'CHARACTER_MERGE_NOT_FOUND'].includes(error.code)) throw stale();
        throw error;
      }
      if (!plan.view.ready || !this.alignment.matchesToken(plan.view.preview_token.split('.')[0], hash) || plan.view.preview_token !== input.preview_token ||
          canonical(plan.view.choices) !== canonical(input.choices)) throw stale();
      return plan;
    }, (plan, requestId) => applyCharacterMerge(this, seriesId, requestId, plan));
  }

  request(seriesId, requestId) {
    if (!idOK(requestId)) throw invalid();
    return this.alignment.read(() => {
      this.directory.series(seriesId);
      const row = this.db.prepare('SELECT result_json FROM creative_character_merge_requests WHERE id=? AND series_id=?')
        .get(requestId.toLowerCase(), seriesId);
      return row ? { found: true, result: this.result(seriesId, JSON.parse(row.result_json)) } : { found: false };
    });
  }

  result(seriesId, result) {
    if (result.status === 'rejected') {
      const { http_status, ...receipt } = result;
      return receipt;
    }
    if (result.status !== 'merged') return result;
    return { ...result, can_undo: this.undoPlan(seriesId, result.merge_id).ready };
  }

  record(seriesId, mergeId) {
    if (!idOK(mergeId)) throw absent();
    this.directory.series(seriesId);
    const row = this.db.prepare('SELECT * FROM creative_character_merges WHERE id=? AND series_id=?').get(mergeId, seriesId);
    if (!row) throw absent();
    return { ...row, data: JSON.parse(row.data_json) };
  }

  undoPlan(seriesId, mergeId) {
    const record = this.record(seriesId, mergeId);
    return planCharacterUndo(this, record);
  }

  assetHistory(seriesId, assetId) {
    if (!seriesId) return [];
    const history = [];
    for (const row of this.db.prepare(`SELECT * FROM creative_character_merges WHERE series_id=? AND canonical_asset_id=?
      ORDER BY created_at DESC,id`).all(seriesId, assetId)) {
      const data = JSON.parse(row.data_json);
      if (data.undo) history.push({ kind: 'character_merge_undo', merge_id: row.id, request_id: data.undo.request_id,
        at: data.undo.at, can_undo: false });
      history.push({ kind: 'character_merge', merge_id: row.id, request_id: data.request_id, at: row.created_at,
        can_undo: row.status === 'merged' && this.undoPlan(seriesId, row.id).ready });
    }
    return history.sort((a, b) => b.at - a.at);
  }

  history(seriesId, mergeId) {
    return this.alignment.read(() => {
      const record = this.record(seriesId, mergeId);
      const { source_asset_ids, episode_ids } = record.data;
      return { merge_id: mergeId, series_id: seriesId, status: record.status, canonical_asset_id: record.canonical_asset_id,
        source_asset_ids, episode_ids, at: record.created_at, can_undo: this.undoPlan(seriesId, mergeId).ready };
    });
  }

  undoPreview(seriesId, mergeId, input) {
    if (!shape(input, ['context_token'])) throw invalid();
    return this.alignment.read(() => {
      this.store.scoped.assertContextToken(this.store.scoped.scope('series', seriesId), input.context_token);
      const { current, record, ...view } = this.undoPlan(seriesId, mergeId);
      return view;
    });
  }

  undo(seriesId, mergeId, input) {
    return this.run(seriesId, input, ['undo', mergeId], () => {
      if (!shape(input, ['request_id', 'context_token', 'undo_token', 'accept_restore_changes']) ||
          typeof input.accept_restore_changes !== 'boolean' ||
          !isToken(input.context_token) || !isToken(input.undo_token)) throw invalid();
      const record = this.record(seriesId, mergeId);
      try { this.store.scoped.assertContextToken(this.store.scoped.scope('series', seriesId), input.context_token); }
      catch (error) { if (error.code === 'ASSET_SCOPE_CHANGED') throw undoStale(); throw error; }
      const plan = planCharacterUndo(this, record);
      if (!plan.ready) throw mergeError('CHARACTER_MERGE_UNDO_BLOCKED', '存在不能安全恢复的引用或后续操作', 409, { blockers: plan.blockers });
      if (!this.alignment.matchesToken(plan.undo_token, input.undo_token)) throw undoStale();
      if (plan.status === 'review_required' && !input.accept_restore_changes) throw mergeError('CHARACTER_MERGE_UNDO_BLOCKED', '请确认将被恢复的更改');
      return plan;
    }, (plan, requestId) => applyCharacterUndo(this, plan, requestId));
  }
}
