import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { dimensionDTO, isRecord, isRevision, isScore } from '../project-attributes/model.mjs';
import { timeline } from '../storyboard/shared/model.mjs';
import { cardBinding } from './crop-state.mjs';
import { canonical, digest, fault, idOK, nameKey } from './model.mjs';

const PREVIEW_TTL = 5 * 60 * 1000;
const invalid = message => fault(message, 422);
const readOnly = () => fault('请在资产所属的可编辑作用域操作', 403, { code: 'ASSET_SCOPE_READ_ONLY' });
const missing = () => fault('当前作用域中没有该对象', 404, { code: 'ASSET_SCOPE_NOT_FOUND' });
const changed = () => fault('操作影响已变化或预览已过期，请重新预览', 409, { code: 'ASSET_IMPACT_CHANGED' });
const active = row => row.archived_at === null;
const named = ({ id, name }) => ({ id, name });
const allowedFields = (input, keys) => isRecord(input) && Object.keys(input).every(key => keys.includes(key));
const valueOf = row => JSON.parse(row.value_json);
const keyOf = (type, id) => type + ':' + id;
const manualScore = score => isRecord(score) && Object.keys(score).length === 4 && score.source === 'manual' &&
  score.reason === null && isRevision(score.updated_at) && (score.value === null || isScore(score.value));

function archiveInput(input) {
  const target = input?.target;
  if (!allowedFields(input, ['context_token', 'target', 'replacement_id']) ||
      !allowedFields(target, ['type', 'id']) || !['asset', 'look', 'image'].includes(target.type) ||
      !idOK(target.id) || (input.replacement_id != null && !idOK(input.replacement_id))) {
    throw invalid('归档对象或替代项无效');
  }
  return { target: { type: target.type, id: target.id.toLowerCase() },
    replacement_id: input.replacement_id?.toLowerCase() ?? null };
}

function dimensionConflict(id, score, local, series) {
  const dimension = local.get(id), shared = series.get(id);
  let reason;
  if (!dimension) reason = 'SOURCE_DIMENSION_MISSING';
  else if (!shared) reason = 'SERIES_DIMENSION_MISSING';
  else if (canonical(dimensionDTO(dimension)) !== canonical(dimensionDTO(shared))) reason = 'DIMENSION_DEFINITION_CHANGED';
  else if (score?.source === 'ai') reason = 'AI_SCORE_NOT_SUPPORTED_BY_OVERRIDE';
  else if (!manualScore(score)) reason = 'SCORE_NOT_LOSSLESS';
  return reason ? { dimension_id: id, name: dimension?.name ?? shared?.name ?? id, reason } : null;
}

function archiveDefaults(asset, { target, replacement_id }) {
  const whole = target.type === 'asset';
  const look = target.type === 'look' ? asset.looks.find(row => row.id === target.id && active(row)) : null;
  const image = target.type === 'image' ? asset.images.find(row => row.id === target.id && active(row)) : null;
  if (whole ? target.id !== asset.id : !(look || image)) throw missing();
  const parent = image?.look_id ? asset.looks.find(row => row.id === image.look_id) : null;
  if (parent && !active(parent)) throw missing();

  let key = null, lookId = null, candidates = [];
  if (look && look.id === asset.default_look_id) {
    key = 'default_look';
    candidates = asset.looks.filter(row => active(row) && row.id !== look.id)
      .map(({ id, name }) => ({ id, name }));
  }
  if (image && image.id === (parent ? parent.default_image_id : asset.default_image_id)) {
    lookId = image.look_id;
    key = lookId === null ? 'default_image' : 'default_image:' + lookId;
    candidates = asset.images.filter(row => active(row) && row.look_id === lookId && row.id !== image.id)
      .map(({ id, last_known_name, media_asset_id }) => ({ id, name: last_known_name || id, media_asset_id }));
  }
  if (replacement_id !== null && !candidates.some(row => row.id === replacement_id)) throw invalid('请选择同一资产或造型中的有效替代项');
  return { key, lookId, candidates, look, image, whole };
}

function defaultFields(asset) {
  const fields = new Map();
  if (asset.kind === 'character') {
    const looks = asset.looks.filter(active);
    fields.set('default_look', { key: 'default_look', value: looks.some(row => row.id === asset.default_look_id)
      ? asset.default_look_id : null });
    for (const look of looks) {
      const value = asset.images.some(row => active(row) && row.look_id === look.id && row.id === look.default_image_id)
        ? look.default_image_id : null;
      fields.set('default_image:' + look.id, { key: 'default_image', look_id: look.id, value });
    }
  } else {
    const value = asset.images.some(row => active(row) && row.look_id === null && row.id === asset.default_image_id)
      ? asset.default_image_id : null;
    fields.set('default_image', { key: 'default_image', look_id: null, value });
  }
  return fields;
}

function resolvedDefaults(asset, fields, overrides, layers) {
  const resolved = new Map([...fields].map(([key, field]) => [key, field.value]));
  for (const layer of layers) for (const override of overrides.get(layer) ?? []) {
    const field = fields.get(override.field_key);
    if (!field) continue;
    const value = valueOf(override);
    const valid = field.key === 'default_look'
      ? asset.looks.some(row => row.id === value && active(row))
      : asset.images.some(row => row.id === value && row.look_id === field.look_id && active(row));
    if (valid) resolved.set(override.field_key, value);
  }
  return resolved;
}

function referencesTarget(row, target, lookIds, imageIds) {
  if (target.type === 'asset' && (row.subject_id === target.id || row.creative_asset_id === target.id)) return true;
  if (lookIds.has(row.look_id)) return true;
  return [row.asset_id, row.image_id, row.image_binding_id, row.binding_id].some(id => imageIds.has(id));
}

export class ScopedAssetImpact {
  #key = randomBytes(32);

  constructor(store, { now = Date.now } = {}) {
    this.store = store;
    this.now = now;
  }

  get db() { return this.store.db; }
  get reads() { return this.store.scoped; }
  get writes() { return this.store.scopedWrites; }

  previewPromotion(type, id, assetId, input) {
    if (!allowedFields(input, ['context_token'])) throw invalid('提升预览请求格式无效');
    return this.#preview(type, id, assetId, 'promotion', input.context_token, null);
  }

  commitPromotion(type, id, assetId, input) {
    return this.#commit(type, id, assetId, 'promotion', input);
  }

  previewArchive(type, id, assetId, input) {
    return this.#preview(type, id, assetId, 'archive', input?.context_token, archiveInput(input));
  }

  commitArchive(type, id, assetId, input) {
    return this.#commit(type, id, assetId, 'archive', input);
  }

  #sign(encoded) {
    return createHmac('sha256', this.#key).update('scoped-asset-impact/v1/' + encoded).digest();
  }

  #open(token) {
    if (typeof token !== 'string' || token.length > 4096 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(token)) throw changed();
    const [encoded, signature] = token.split('.');
    if (!timingSafeEqual(this.#sign(encoded), Buffer.from(signature, 'hex'))) throw changed();
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    if (payload.expires_at <= this.now()) throw changed();
    return payload;
  }

  #preview(type, id, assetId, operation, contextToken, args) {
    if (this.db.kind === 'mysql') this.db.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    return this.db.transaction(() => {
      const scope = this.reads.scope(type, id);
      this.reads.assertContextToken(scope, contextToken);
      const { asset } = this.reads.detailInTransaction(scope, assetId);
      const plan = this.#plan(scope, asset, operation, args);
      const encoded = Buffer.from(canonical({
        operation, asset_id: asset.id, context_token: scope.context_token, revision: asset.revision,
        args, fingerprint: plan.fingerprint, expires_at: this.now() + PREVIEW_TTL,
      })).toString('base64url');
      return { preview_token: encoded + '.' + this.#sign(encoded).toString('hex'), impact: plan.impact };
    })();
  }

  #commit(type, id, assetId, operation, input) {
    if (!allowedFields(input, ['request_id', 'context_token', 'preview_token']) || !idOK(input.request_id)) {
      throw invalid('确认请求格式无效');
    }
    if (!idOK(assetId)) throw missing();
    // Local attribute writers lock the project without taking the directory lock.
    // Read their committed values after taking that same project lock.
    if (this.db.kind === 'mysql' && !this.store.lib.migrating) this.db.exec('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    return this.writes.mutation(type, id, operation + ':' + assetId.toLowerCase(), input, scope => {
      const payload = this.#open(input.preview_token);
      if (payload.operation !== operation || payload.asset_id !== assetId.toLowerCase() ||
          payload.context_token !== scope.context_token) throw changed();
      const item = this.reads.detailInTransaction(scope, assetId);
      if (item.asset.revision !== payload.revision) throw changed();
      this.#authorize(scope, item.asset, operation);
      this.writes.lockProjects(this.#audienceScope(scope, operation));
      const locked = this.store.head(item.asset.id, true);
      if (locked.revision !== payload.revision || locked.owner_type !== item.asset.owner_type ||
          locked.owner_id !== item.asset.owner_id || locked.archived_at) throw changed();
      const asset = this.store.get(locked.id);
      const current = this.reads.scope(type, id);
      const plan = this.#plan(current, asset, operation, payload.args);
      if (payload.fingerprint !== plan.fingerprint || payload.expires_at <= this.now()) throw changed();
      this.#assertUnblocked(plan.impact);
      const now = Math.max(this.now(), Number(asset.updated_at) + 1);
      const revision = Number(asset.revision) + 1;
      const audit = operation === 'promotion'
        ? this.#promote(current, asset, plan, revision, now)
        : this.#archive(asset, payload.args, plan, revision, now);
      const summary = operation === 'promotion' ? '从本集提升为全剧资产' : '归档' + { asset: '资产', look: '造型', image: '图片绑定' }[payload.args.target.type];
      this.db.prepare(`INSERT INTO creative_asset_versions (id,asset_id,version,snapshot,summary,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?)`).run(randomUUID(), asset.id, revision,
        canonical({ ...this.store.get(asset.id), scope_change: { operation, ...audit, impact: plan.impact } }), summary, now, now);
      return { ...this.reads.detailInTransaction(current, asset.id), impact: plan.impact };
    });
  }

  #authorize(scope, asset, operation) {
    if (asset.archived_at || (operation === 'promotion'
      ? scope.type !== 'episode' || scope.series_id === null || asset.owner_type !== 'project'
      : scope.type !== (asset.owner_type === 'series' ? 'series' : 'episode'))) throw readOnly();
  }

  #audienceScope(scope, operation) {
    return operation === 'promotion' ? this.reads.scope('series', scope.series_id) : scope;
  }

  #audience(scope) {
    if (scope.type === 'episode') return { seasons: [], episodes: [{ ...scope.project, season_id: null }] };
    const seasons = this.db.prepare(`SELECT id,label,season_no,revision FROM project_series_seasons
      WHERE series_id=? ORDER BY season_no,id`).all(scope.id)
      .map(row => ({ ...row, name: row.label?.trim() || `第 ${row.season_no} 季` }));
    const episodes = this.db.prepare(`SELECT m.id,m.season_id,m.episode_no,m.revision,p.name
      FROM project_series_members m JOIN media_projects p ON p.id=m.id WHERE m.series_id=? ORDER BY m.id`).all(scope.id);
    return { seasons, episodes };
  }

  #plan(scope, asset, operation, args) {
    this.#authorize(scope, asset, operation);
    const audienceScope = this.#audienceScope(scope, operation);
    const audience = this.#audience(audienceScope);
    const plan = operation === 'promotion'
      ? this.#promotionPlan(scope, audienceScope, asset, audience)
      : this.#archivePlan(asset, args, audience);
    const { impact, dependencies } = plan;
    return { ...plan, fingerprint: digest({ audience, impact, dependencies, revision: asset.revision }) };
  }

  #promotionPlan(scope, series, asset, audience) {
    const matches = this.writes.findNames(series, { kind: asset.kind, name: asset.name, exclude: asset.id });
    const conflicts = (matches.conflicts ?? (matches.match ? [matches.match] : [])).sort((a, b) => a.id.localeCompare(b.id));
    const blockers = [];
    if (conflicts.length) blockers.push({ code: 'ASSET_NAME_CONFLICT', asset_id: asset.id, conflicts });
    const record = asset.kind === 'character' ? this.db.prepare('SELECT * FROM project_character_attributes WHERE id=?').get(asset.id) : null;
    const scores = record ? JSON.parse(record.data_json) : {};
    const entries = Object.entries(scores).sort(([a], [b]) => a.localeCompare(b));
    const local = entries.length ? this.store.attributes.config(scope.id) : null;
    const shared = entries.length ? this.writes.seriesConfig(series.id) : null;
    if (entries.length) {
      const dimensions = config => new Map(config.dimensions.map(dimension => [dimension.id, dimension]));
      const localById = dimensions(local), sharedById = dimensions(shared);
      const incompatible = entries.map(([id, score]) => dimensionConflict(id, score, localById, sharedById)).filter(Boolean);
      if (record.project_id !== scope.id) incompatible.push(...entries.map(([dimension_id]) => ({
        dimension_id, name: localById.get(dimension_id)?.name ?? dimension_id, reason: 'SOURCE_SCORE_OWNER_MISMATCH',
      })));
      if (incompatible.length) blockers.push({ code: 'ASSET_PROMOTION_ATTRIBUTES_CONFLICT', dimensions: incompatible });
    }

    // Existing destination state must never be merged or overwritten.
    const destinationScore = this.db.prepare('SELECT id FROM series_character_attributes WHERE id=?').get(asset.id);
    const destinationOverride = this.db.prepare('SELECT id FROM creative_asset_overrides WHERE asset_id=? LIMIT 1').get(asset.id);
    if (destinationScore || destinationOverride || (record && record.project_id !== scope.id && !entries.length)) {
      blockers.push({ code: 'ASSET_PROMOTION_ATTRIBUTES_CONFLICT', dimensions: [], reason: 'EXISTING_DESTINATION_STATE' });
    }
    const references = this.#references(asset, { type: 'asset', id: asset.id }, audience.episodes.filter(row => row.id === scope.id));
    if (references.outside) blockers.push({ code: 'ASSET_IN_USE' });
    const visibility = { key: 'visible', before: false, after: true };
    const defaults = [...defaultFields(asset).values()].map(({ value, ...field }) => ({ ...field, before: null, after: value }));
    const newFields = [visibility, ...defaults];
    const originFields = [{ key: 'owner', before: { type: 'project', id: scope.id }, after: { type: 'series', id: series.id } },
      ...entries.map(([dimension_id, value]) => ({ key: 'attribute_score', dimension_id, before: value, after: value,
        before_source: { type: 'project', id: scope.id }, after_source: { type: 'episode', id: scope.id } }))];
    const impact = {
      seasons: audience.seasons.map(row => ({ ...named(row), fields: newFields })),
      episodes: audience.episodes.map(row => ({ ...named(row), fields: row.id === scope.id ? originFields : newFields })),
      explicit_shots: references.shots, blockers,
    };
    return { impact, dependencies: { record, local, shared, documents: references.documents }, record, entries };
  }

  #archivePlan(asset, args, audience) {
    const defaults = archiveDefaults(asset, args);
    const { key, look, image, whole, candidates } = defaults;
    const { target, replacement_id } = args;
    const scores = whole && asset.kind === 'character' ? this.#archiveScores(asset) : null;
    const rows = this.db.prepare('SELECT * FROM creative_asset_overrides WHERE asset_id=? ORDER BY id').all(asset.id);
    const invalidated = rows.filter(row => whole ||
      (look && (row.field_key === 'default_image:' + look.id || row.field_key === 'default_look' && valueOf(row) === look.id)) ||
      (image && row.field_key.split(':')[0] === 'default_image' && valueOf(row) === image.id));
    const invalidIds = new Set(invalidated.map(row => row.id));
    const byScope = records => Map.groupBy(records, row => keyOf(row.scope_type, row.scope_id));
    const priorOverrides = byScope(rows), nextOverrides = byScope(rows.filter(row => !invalidIds.has(row.id)));
    const beforeFields = defaultFields(asset), afterFields = whole ? new Map() : new Map(beforeFields);
    if (look) afterFields.delete('default_image:' + look.id);
    if (key) afterFields.set(key, { ...afterFields.get(key), value: replacement_id });

    const impactFields = (layers, ownLayer) => {
      const before = resolvedDefaults(asset, beforeFields, priorOverrides, layers);
      const after = resolvedDefaults(asset, afterFields, nextOverrides, layers);
      const fields = whole ? [{ key: 'visible', before: true, after: false }] : [];
      for (const [key, { value, ...field }] of beforeFields) {
        const afterValue = after.get(key) ?? null;
        const cleared = (priorOverrides.get(ownLayer) ?? []).find(row => row.field_key === key && invalidIds.has(row.id));
        if (!afterFields.has(key) || before.get(key) !== afterValue || cleared) {
          fields.push({ ...field, before: before.get(key), after: afterValue, ...(cleared && { invalidates_override: true }) });
        }
      }
      if (scores) {
        const ownOverrides = new Map((priorOverrides.get(ownLayer) ?? []).map(row => [row.field_key, row]));
        for (const dimension_id of scores.dimensionIds) {
          const override = ownOverrides.get('attribute_score:' + dimension_id);
          const overrideValue = override ? valueOf(override) : null;
          const value = manualScore(overrideValue) ? overrideValue : scores.values[dimension_id];
          if (value !== undefined || override) fields.push({ key: 'attribute_score', dimension_id, before: value ?? null,
            after: null, ...(override && { invalidates_override: true }) });
        }
      }
      const cover = map => asset.kind === 'character' ? map.get('default_image:' + map.get('default_look')) ?? null
        : map.get('default_image') ?? null;
      if (cover(before) !== cover(after)) fields.push({ key: 'cover', before: cover(before), after: cover(after) });
      return fields;
    };
    const references = this.#references(asset, target, audience.episodes);
    const blockers = [];
    if (references.shots.length || references.manifests.length || references.outside) {
      blockers.push({ code: 'ASSET_IN_USE', manifests: references.manifests });
    }
    if (candidates.length && replacement_id === null) blockers.push({ code: 'ASSET_REPLACEMENT_REQUIRED', candidates });
    const impact = {
      seasons: audience.seasons.map(row => {
        const layer = keyOf('season', row.id);
        return { ...named(row), fields: impactFields([layer], layer) };
      }),
      episodes: audience.episodes.map(row => {
        const layer = keyOf('episode', row.id);
        return { ...named(row), fields: impactFields(row.season_id ? [keyOf('season', row.season_id), layer] : [layer], layer) };
      }),
      explicit_shots: references.shots, blockers,
    };
    return { impact, dependencies: { rows, scores, documents: references.documents }, defaults, invalidated,
      base_fields: impactFields([], null) };
  }

  #archiveScores(asset) {
    const shared = asset.owner_type === 'series';
    const config = shared ? this.writes.seriesConfig(asset.owner_id) : this.store.attributes.config(asset.owner_id);
    const record = shared ? this.writes.seriesScores(asset.owner_id, asset.id) : this.store.attributes.record(asset.id);
    return { configRevision: config.revision, scoreRevision: record.attribute_revision ?? record.revision,
      dimensionIds: config.dimensions.map(row => row.id), values: record.scores };
  }

  #references(asset, target, episodes) {
    const result = { shots: [], manifests: [], documents: [], outside: false };
    const board = this.store.storyboards;
    if (!board) {
      const tables = this.db.kind === 'mysql' ? 'information_schema.TABLES' : 'sqlite_master';
      const filter = this.db.kind === 'mysql' ? 'TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?' : "type='table' AND name=?";
      if (this.db.prepare(`SELECT 1 FROM ${tables} WHERE ${filter}`).get('storyboard_documents') &&
          this.db.prepare('SELECT 1 FROM storyboard_documents LIMIT 1').get()) throw fault('分镜模块尚未就绪', 503);
      return result;
    }
    const episodeIds = new Set(episodes.map(row => row.id));
    const links = target.type === 'asset' ? this.db.prepare(`SELECT d.project_id FROM storyboard_asset_links l
      LEFT JOIN storyboard_documents d ON d.id=l.document_id WHERE l.asset_id=?`).all(asset.id) : [];
    result.outside = links.some(link => !episodeIds.has(link.project_id));
    const linked = new Set(links.map(link => link.project_id));
    const lookIds = new Set(asset.looks.filter(row => target.type === 'asset' ||
      (target.type === 'look' && row.id === target.id)).map(row => row.id));
    const imageIds = new Set(asset.images.filter(image => target.type === 'asset' ||
      (target.type === 'look' ? image.look_id === target.id : image.id === target.id)).map(row => row.id));
    for (const episode of episodes) {
      const document = board.head(episode.id);
      if (!document) continue;
      const project = JSON.parse(document.document_json);
      const associations = target.type === 'asset' ? board.assetShots(asset.id, episode.id) : null;
      const byShot = new Map((associations?.items ?? []).map(row => [row.shotId, row.reasons]));
      const listed = linked.has(episode.id) || associations?.listed;
      if (listed) result.manifests.push({ episode_id: episode.id, episode_name: episode.name, document_id: document.id });
      const previousCount = result.shots.length;
      const globals = project.reference_bindings ?? [];
      for (const { shot, scene, number } of timeline(project)) {
        const reasons = [...(byShot.get(shot.id) ?? [])];
        const references = [...globals, ...(shot.reference_bindings ?? [])].filter(row =>
          (!row.scene_ids?.length || row.scene_ids.includes(scene.id)) &&
          (!row.shot_ids?.length || row.shot_ids.includes(shot.id)));
        const explicit = [scene, shot, ...references, ...(shot.character_presence ?? [])]
          .some(row => referencesTarget(row, target, lookIds, imageIds));
        if (explicit) reasons.push('明确参考绑定');
        if (reasons.length) result.shots.push({ id: shot.id, name: '镜 ' + number, episode_id: episode.id,
          episode_name: episode.name, number, scene_id: scene.id, reasons });
      }
      if (listed || result.shots.length !== previousCount) result.documents.push([document.id, document.revision]);
    }
    return result;
  }

  #assertUnblocked(impact) {
    const blocker = impact.blockers[0];
    if (!blocker) return;
    const messages = {
      ASSET_NAME_CONFLICT: '全剧或成员集有同名资产，请先处理重名',
      ASSET_PROMOTION_ATTRIBUTES_CONFLICT: '部分本集评分无法完整保留，请先处理评分冲突',
      ASSET_IN_USE: '请先处理分镜中的明确引用和素材清单',
      ASSET_REPLACEMENT_REQUIRED: '请选择新的基础默认项并重新预览',
    };
    throw fault(messages[blocker.code], blocker.code === 'ASSET_REPLACEMENT_REQUIRED' ? 422 : 409,
      { code: blocker.code, details: { ...blocker, impact } });
  }

  #promote(scope, asset, plan, revision, now) {
    try {
      this.db.prepare(`UPDATE creative_assets SET owner_type='series',owner_id=?,project_id=NULL,revision=?,updated_at=?
        WHERE id=?`).run(scope.series_id, revision, now, asset.id);
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY' || error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw changed();
      throw error;
    }
    const insert = this.db.prepare(`INSERT INTO creative_asset_overrides
      (id,scope_type,scope_id,asset_id,field_key,value_json,revision,created_at,updated_at)
      VALUES(?,'episode',?,?,?,?,1,?,?)`);
    for (const [dimensionId, value] of plan.entries) {
      const field = 'attribute_score:' + dimensionId;
      insert.run(digest(['episode', scope.id, asset.id, field]), scope.id, asset.id, field, canonical(value), now, now);
    }
    if (plan.record) this.db.prepare('DELETE FROM project_character_attributes WHERE id=? AND project_id=?').run(asset.id, scope.id);
    return {
      source_episode: named(scope.project),
      previous_owner: { type: 'project', id: scope.id }, owner: { type: 'series', id: scope.series_id },
      source_attribute_revision: plan.record?.revision ?? 0,
    };
  }

  #archive(asset, args, plan, revision, now) {
    const { target, replacement_id } = args;
    const { key, lookId, look, image, whole } = plan.defaults;
    let archivedAt = 0, defaultLook = asset.default_look_id, defaultImage = asset.default_image_id;
    if (whole) {
      const { latest } = this.db.prepare(`SELECT MAX(archived_at) latest FROM creative_assets
        WHERE owner_type=? AND owner_id=? AND kind=? AND name_key=?`).get(asset.owner_type, asset.owner_id, asset.kind, nameKey(asset.name));
      archivedAt = Math.max(now, Number(latest ?? 0) + 1);
    }
    if (key === 'default_look') defaultLook = replacement_id;
    if (key === 'default_image') defaultImage = replacement_id;
    if (look) this.db.prepare('UPDATE creative_looks SET archived_at=?,revision=revision+1,updated_at=? WHERE id=? AND asset_id=?')
      .run(now, now, look.id, asset.id);
    if (image) this.db.prepare('UPDATE creative_image_bindings SET archived_at=?,revision=revision+1,updated_at=? WHERE id=? AND asset_id=?')
      .run(now, now, image.id, asset.id);
    if (key && lookId !== null) {
      this.db.prepare('UPDATE creative_looks SET default_image_id=?,revision=revision+1,updated_at=? WHERE id=? AND asset_id=?')
        .run(replacement_id, now, lookId, asset.id);
    }
    this.db.prepare(`UPDATE creative_assets SET archived_at=?,default_look_id=?,default_image_id=?,revision=?,updated_at=?
      WHERE id=?`).run(archivedAt, defaultLook, defaultImage, revision, now, asset.id);
    const newCard = cardBinding(this.store.get(asset.id));
    if (newCard && newCard !== cardBinding(asset)) {
      const row = this.db.prepare('SELECT data_json FROM creative_image_bindings WHERE id=? AND asset_id=?').get(newCard, asset.id);
      const data = JSON.parse(row.data_json);
      if (data.was_card_default !== true) this.db.prepare(`UPDATE creative_image_bindings SET data_json=?,revision=revision+1,updated_at=?
        WHERE id=? AND asset_id=?`).run(canonical({ ...data, was_card_default: true }), now, newCard, asset.id);
    }
    const clear = this.db.prepare('DELETE FROM creative_asset_overrides WHERE id=? AND asset_id=?');
    for (const row of plan.invalidated) clear.run(row.id, asset.id);
    return {
      target, replacement_id, base_fields: plan.base_fields,
      invalidated_overrides: plan.invalidated.map(row => ({
        scope_type: row.scope_type, scope_id: row.scope_id, field_key: row.field_key,
        before: valueOf(row), after: null, revision: row.revision,
      })),
    };
  }
}
