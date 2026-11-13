import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { blankAsset, canonical, digest, fault, idOK, nameKey, text } from './model.mjs';
import { lockSeriesDirectory } from '../project-series/schema.mjs';
import { DEFAULT_DIMENSIONS, dimensionDTO, dimensionsInput, distinctIds, isRecord, isRevision, scoreChanges } from '../project-attributes/model.mjs';

const conflict = (code, message, details) => fault(message, 409, { code, details });
const readOnly = () => fault('请在允许编辑的作用域操作', 403, { code: 'ASSET_SCOPE_READ_ONLY' });
const stale = () => conflict('ASSET_STALE', '资料已更新，请重新读取后再保存');
const invalid = message => fault(message, 422);
const active = row => row.archived_at === null;

function nameInput(input) {
  if (!['character', 'scene', 'prop'].includes(input?.kind)) throw invalid('资产类型无效');
  if (input.exclude_asset_id != null && !idOK(input.exclude_asset_id)) throw invalid('排除资产编号无效');
  return { kind: input.kind, name: text(input.name, '名称', 120, true), exclude: input.exclude_asset_id };
}

export class ScopedAssetWrites {
  #configKey = randomBytes(32);
  constructor(assets) {
    this.assets = assets;
  }

  get db() { return this.assets.db; }
  get reads() { return this.assets.scoped; }

  // Membership is read only after taking the same directory lock as a move.
  scope(type, id) {
    return this.reads.scope(type, id);
  }

  projects(scope) {
    if (scope.type === 'episode') return [scope.id];
    if (scope.type === 'season') {
      return this.db.prepare('SELECT id FROM project_series_members WHERE series_id=? AND season_id=? ORDER BY id')
        .all(scope.series_id, scope.season_id).map(row => row.id);
    }
    return this.db.prepare('SELECT id FROM project_series_members WHERE series_id=? ORDER BY id')
      .all(scope.series_id).map(row => row.id);
  }

  lockProjects(scope) {
    const locked = [];
    for (const id of this.projects(scope)) {
      const project = this.assets.project(id, true);
      try { this.assets.generationLocks?.assertWritable(id); }
      catch (error) {
        if (error.status !== 423) throw error;
        locked.push({ id, name: project.name });
      }
    }
    if (locked.length) throw fault('受影响的项目正在生成分镜', 423, {
      code: 'STORYBOARD_GENERATION_LOCKED', details: { episodes: locked },
    });
  }

  assertNoOverrides(type, id) {
    if (this.db.prepare('SELECT id FROM creative_asset_overrides WHERE scope_type=? AND scope_id=? LIMIT 1').get(type, id)) {
      throw conflict('ASSET_SCOPE_CHANGED', '该目录还有共享资产设置，请先恢复上层设置');
    }
  }

  assertSeriesRemovable(id) {
    const shared = this.db.prepare("SELECT id FROM creative_assets WHERE owner_type='series' AND owner_id=? LIMIT 1").get(id);
    const configured = this.db.prepare('SELECT id FROM series_attribute_configs WHERE id=?').get(id);
    if (shared || configured) throw conflict('ASSET_IN_USE', '该剧仍有共享资产或属性配置，无法移除');
  }

  assertMembershipChange({ project_id, before, after }) {
    if (before.series_id === after.series_id) return;
    if (before.series_id !== null) {
      const storyboard = this.assets.storyboards?.head(project_id);
      const links = storyboard ? this.assets.storyboards.linked(storyboard)
        .filter(row => row.owner_type === 'series' && row.owner_id === before.series_id) : [];
      if (links.length) throw conflict('ASSET_IN_USE', '该集分镜仍引用原剧共享资产，请先处理分镜素材清单', {
        assets: links.map(row => ({ id: row.id, kind: row.kind, name: row.name })),
        shots: links.flatMap(row => this.assets.storyboards.assetShots(row.id, project_id).items.map(shot => ({
          asset_id: row.id, shot_id: shot.shotId, number: shot.number, scene_id: shot.sceneId,
        }))),
      });
      this.assertNoOverrides('episode', project_id);
    }
    if (after.series_id === null) return;
    const names = this.db.prepare(`SELECT a.id asset_id,s.id shared_asset_id,a.kind,a.name
      FROM creative_assets a JOIN creative_assets s ON s.kind=a.kind AND s.name_key=a.name_key
      WHERE a.owner_type='project' AND a.owner_id=? AND a.archived_at=0
        AND s.owner_type='series' AND s.owner_id=? AND s.archived_at=0`).all(project_id, after.series_id);
    if (names.length) throw conflict('ASSET_NAME_CONFLICT', '项目内已有与全剧同名的资产，请先处理重名', { conflicts: names });
  }

  request(id) {
    if (!idOK(id)) throw invalid('请求编号无效');
    const row = this.db.prepare('SELECT * FROM creative_asset_scope_requests WHERE id=?').get(id.toLowerCase());
    if (!row) return { found: false };
    try {
      const scope = this.scope(row.scope_type, row.scope_id);
      return { found: true, result: this.visibleReceipt(scope, row) };
    } catch (error) {
      if (error.status === 404) return { found: false };
      throw error;
    }
  }

  visibleReceipt(scope, row) {
    const result = JSON.parse(row.result_json);
    if (result.asset?.id) this.reads.detailInTransaction(scope, result.asset.id);
    return result;
  }

  receipt(type, id, operation, input) {
    if (!isRecord(input) || !idOK(input.request_id)) throw invalid('请求编号无效');
    const requestId = input.request_id.toLowerCase();
    const hash = digest({ type, id, operation, input });
    const prior = this.db.prepare('SELECT * FROM creative_asset_scope_requests WHERE id=?').get(requestId);
    if (prior && prior.request_hash !== hash) throw conflict('REQUEST_ID_CONFLICT', '请求编号已用于其他操作');
    return { requestId, hash, prior };
  }

  mutation(type, id, operation, input, apply, { beforeCommit } = {}) {
    if (this.assets.lib.migrating) throw fault('数据库正在迁移，请稍后保存', 423);
    return this.assets.tx(() => {
      lockSeriesDirectory(this.db);
      const scope = this.scope(type, id);
      const { requestId, hash, prior } = this.receipt(type, id, operation, input);
      if (prior) return this.visibleReceipt(scope, prior);
      this.reads.assertContextToken(scope, input.context_token);
      const last = this.db.prepare('SELECT MAX(updated_at) latest FROM creative_asset_scope_requests').get().latest;
      const now = Math.max(Date.now(), Number(last ?? 0) + 1);
      const result = { ...apply({ ...scope, operation_at: now }), request_id: requestId };
      this.db.prepare(`INSERT INTO creative_asset_scope_requests
        (id,scope_type,scope_id,request_hash,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
        .run(requestId, type, id, hash, canonical(result), now, now);
      beforeCommit?.();
      return result;
    });
  }

  findNames(scope, { kind, name, exclude }) {
    const key = nameKey(name);
    const select = 'SELECT id,name,kind,owner_type,owner_id FROM creative_assets WHERE kind=? AND name_key=? AND archived_at=0';
    const shared = scope.series_id ? this.db.prepare(select + " AND owner_type='series' AND owner_id=?")
      .all(kind, key, scope.series_id).filter(row => row.id !== exclude) : [];
    const local = scope.type === 'episode' ? this.db.prepare(select + " AND owner_type='project' AND owner_id=?")
      .all(kind, key, scope.id).filter(row => row.id !== exclude) : [];
    const memberConflicts = scope.type === 'series' ? this.db.prepare(`SELECT a.id,a.name,a.kind,a.owner_type,a.owner_id
      FROM creative_assets a JOIN project_series_members m ON m.id=a.owner_id
      WHERE m.series_id=? AND a.owner_type='project' AND a.kind=? AND a.name_key=? AND a.archived_at=0 ORDER BY a.id`)
      .all(scope.series_id, kind, key).filter(row => row.id !== exclude) : [];
    if (memberConflicts.length || shared.length + local.length > 1) {
      return { status: 'conflict', conflicts: [...shared, ...local, ...memberConflicts] };
    }
    if (local.length) return { status: 'existing_local', match: local[0] };
    if (shared.length) return { status: scope.type === 'series' ? 'existing_local' : 'inherit_shared', match: shared[0] };
    return { status: 'available' };
  }

  checkNames(type, id, input) {
    const scope = this.scope(type, id);
    return { ...this.findNames(scope, nameInput(input)), context_token: scope.context_token };
  }

  assertAvailable(names) {
    if (names.status === 'available') return;
    if (names.status === 'inherit_shared') {
      throw conflict('SHARED_ASSET_EXISTS', '全剧已有同名资产，请选择沿用或改名', { match: names.match });
    }
    throw conflict('ASSET_NAME_CONFLICT', '资产名称已存在，请核对后改名', {
      conflicts: names.conflicts ?? [names.match],
    });
  }

  create(type, id, input) {
    const names = nameInput(input);
    if (!['reject', 'reuse'].includes(input.on_shared) || names.exclude != null) throw invalid('请选择同名共享资产的处理方式');
    return this.mutation(type, id, 'create', input, scope => {
      if (type === 'season') throw readOnly();
      const matches = this.findNames(scope, names);
      if (matches.status === 'inherit_shared' && input.on_shared === 'reuse') {
        return { ...this.reads.detailInTransaction(scope, matches.match.id), reused: true };
      }
      this.assertAvailable(matches);
      this.lockProjects(scope);
      const asset = blankAsset(type === 'series' ? null : id, names.kind, names.name);
      if (type === 'series') Object.assign(asset, { owner_type: 'series', owner_id: id });
      const saved = this.assets.write(asset, null, '创建资产', null, type === 'series' ? id : null);
      return { ...this.reads.detailInTransaction(scope, saved.id), reused: false };
    });
  }

  writableBase(scope, assetId, input) {
    const { type } = scope;
    const item = this.reads.detailInTransaction(scope, assetId);
    const before = item.asset;
    if (type === 'season' || before.archived_at || (type === 'series' ? item.owner.type !== 'series' : item.owner.type !== 'project')) {
      throw readOnly();
    }
    if (!isRevision(input.expected_revision)) throw invalid('资料修订号无效');
    if (before.revision !== input.expected_revision) throw stale();
    return before;
  }

  async save(type, id, assetId, input) {
    const operation = 'save:' + assetId;
    const scope = this.scope(type, id);
    const { prior } = this.receipt(type, id, operation, input);
    if (prior) return this.visibleReceipt(scope, prior);
    this.reads.assertContextToken(scope, input.context_token);
    const old = this.writableBase(scope, assetId, input);
    const next = input.asset;
    if (!isRecord(next) || next.id !== old.id || next.kind !== old.kind || next.project_id !== old.project_id ||
        next.owner_type !== old.owner_type || next.owner_id !== old.owner_id || next.archived_at !== old.archived_at) {
      throw invalid('不能修改资产编号、归属、类型或归档状态');
    }
    const prepared = await this.assets.prepare(next, old);
    if (type === 'series') {
      for (const key of ['looks', 'images']) {
        const incoming = new Map(prepared[key].map(row => [row.id, row]));
        for (const before of old[key]) {
          const after = incoming.get(before.id);
          if (after.archived_at !== before.archived_at || after.media_asset_id !== before.media_asset_id ||
              after.expected_sha256 !== before.expected_sha256) throw readOnly();
        }
      }
    }
    return this.mutation(type, id, operation, input, current => {
      this.lockProjects(current);
      const before = this.writableBase(current, assetId, input);
      if (nameKey(prepared.name) !== nameKey(before.name)) {
        this.assertAvailable(this.findNames(current, { kind: before.kind, name: prepared.name, exclude: before.id }));
      }
      this.assets.write(prepared, before, '保存资料', before.source, type === 'series' ? id : null);
      return this.reads.detailInTransaction(current, assetId);
    });
  }

  seriesConfig(seriesId) {
    const row = this.db.prepare('SELECT revision,data_json FROM series_attribute_configs WHERE id=?').get(seriesId);
    return row
      ? { series_id: seriesId, revision: row.revision, ...JSON.parse(row.data_json) }
      : { series_id: seriesId, revision: 0, source: 'default', updated_at: null, dimensions: DEFAULT_DIMENSIONS };
  }

  seriesScores(seriesId, assetId) {
    const row = this.db.prepare('SELECT revision,data_json FROM series_character_attributes WHERE id=? AND series_id=?')
      .get(assetId, seriesId);
    return { asset_id: assetId, series_id: seriesId, config_revision: this.seriesConfig(seriesId).revision,
      attribute_revision: row?.revision ?? 0, scores: row ? JSON.parse(row.data_json) : {} };
  }

  patchScores(type, id, assetId, input) {
    if (type !== 'series') throw readOnly();
    if (!isRevision(input?.expected_config_revision) || !isRevision(input?.expected_attribute_revision)) {
      throw invalid('配置或评分修订号无效');
    }
    const changes = scoreChanges(input.changes);
    return this.mutation(type, id, 'scores:' + assetId, input, scope => {
      this.lockProjects(scope);
      const item = this.reads.detailInTransaction(scope, assetId);
      if (item.asset.kind !== 'character') throw fault('人物不存在', 404);
      if (item.asset.archived_at || item.owner.type !== 'series') throw readOnly();
      const current = this.seriesScores(id, assetId);
      if (current.config_revision !== input.expected_config_revision ||
          current.attribute_revision !== input.expected_attribute_revision) throw stale();
      const valid = new Set(this.seriesConfig(id).dimensions.map(dimension => dimension.id));
      const now = Date.now();
      for (const change of changes) {
        if (!valid.has(change.dimension_id)) throw invalid('评分维度已不存在');
        current.scores[change.dimension_id] = { value: change.value, source: 'manual', reason: null, updated_at: now };
      }
      this.writeScores(id, assetId, current, now);
      current.attribute_revision++;
      return current;
    });
  }

  writeScores(seriesId, assetId, current, now) {
    if (current.attribute_revision === 0) {
      this.db.prepare('INSERT INTO series_character_attributes (id,series_id,revision,data_json,created_at,updated_at) VALUES(?,?,1,?,?,?)')
        .run(assetId, seriesId, canonical(current.scores), now, now);
    } else {
      this.db.prepare('UPDATE series_character_attributes SET revision=?,data_json=?,updated_at=? WHERE id=? AND series_id=?')
        .run(current.attribute_revision + 1, canonical(current.scores), now, assetId, seriesId);
    }
  }

  configImpact(config, remove) {
    const dimensions = new Map(config.dimensions.map(dimension => [dimension.id, dimension]));
    const affected = new Map(remove.map(id => {
      if (!dimensions.has(id)) throw invalid('要删除的维度已不存在');
      return [id, { dimension_id: id, name: dimensions.get(id).name, scored_assets: 0, archived_scored_assets: 0, episode_overrides: 0 }];
    }));
    const rows = this.db.prepare(`SELECT s.id,s.revision,s.data_json,a.archived_at FROM series_character_attributes s
      JOIN creative_assets a ON a.id=s.id WHERE s.series_id=? ORDER BY s.id`).all(config.series_id)
      .map(row => ({ ...row, scores: JSON.parse(row.data_json) }));
    const overlays = this.db.prepare(`SELECT o.id,o.field_key,o.value_json,o.revision,o.updated_at FROM creative_asset_overrides o
      JOIN creative_assets a ON a.id=o.asset_id
      WHERE a.owner_type='series' AND a.owner_id=? AND o.scope_type='episode' AND o.field_key LIKE 'attribute_score:%'
      ORDER BY o.id`).all(config.series_id);
    const records = rows.filter(row => remove.some(id => {
      // Count every removed axis, including explicit unscored values.
      return Object.hasOwn(row.scores, id);
    }));
    for (const row of records) for (const id of remove) if (Object.hasOwn(row.scores, id)) {
      affected.get(id)[row.archived_at ? 'archived_scored_assets' : 'scored_assets']++;
    }
    const overrides = overlays.filter(row => affected.has(row.field_key.slice('attribute_score:'.length)));
    for (const row of overrides) affected.get(row.field_key.slice('attribute_score:'.length)).episode_overrides++;
    const token = createHmac('sha256', this.#configKey)
      .update(canonical([config.series_id, config.revision, remove, records, overrides])).digest('hex');
    const scored = new Set([...rows.flatMap(row => Object.keys(row.scores)),
      ...overlays.map(row => row.field_key.slice('attribute_score:'.length))]);
    return { token, records, overrides, scored, affected: [...affected.values()] };
  }

  configRemovalPreview(type, id, input) {
    if (type !== 'series') throw readOnly();
    const remove = distinctIds(input?.remove, 8, '待删除维度').sort();
    return this.assets.tx(() => {
      this.assets.lockDirectory();
      const scope = this.scope(type, id);
      this.reads.assertContextToken(scope, input.context_token);
      const config = this.seriesConfig(id);
      if (config.revision !== input.expected_revision) throw stale();
      const { token, affected } = this.configImpact(config, remove);
      return { token, config_revision: config.revision, affected };
    });
  }

  patchConfig(type, id, input) {
    if (type !== 'series') throw readOnly();
    const proposed = dimensionsInput(input?.dimensions);
    if (!isRevision(input.expected_revision)) throw invalid('配置修订号无效');
    const keep = input.preserve_scored_axes ?? [];
    const preserve = new Set(Array.isArray(keep) && keep.length === 0 ? [] : distinctIds(keep, 8, '确认保持评分含义的维度'));
    const confirmation = input.removal_confirmation;
    if (confirmation !== undefined && (!isRecord(confirmation) || !/^[a-f0-9]{64}$/.test(confirmation.token))) {
      throw invalid('删除确认凭证无效');
    }
    return this.mutation(type, id, 'attribute-config', input, scope => {
      this.lockProjects(scope);
      const config = this.seriesConfig(id);
      if (config.revision !== input.expected_revision) throw stale();
      const previous = new Map(config.dimensions.map(dimension => [dimension.id, dimension]));
      const retained = new Set(proposed.map(dimension => dimension.id));
      const remove = [...previous.keys()].filter(axis => !retained.has(axis)).sort();
      const impact = this.configImpact(config, remove);
      if (confirmation && (!remove.length || !timingSafeEqual(Buffer.from(confirmation.token, 'hex'), Buffer.from(impact.token, 'hex')))) {
        throw conflict('REMOVAL_PREVIEW_STALE', '删除影响已变化，请重新核对');
      }
      if (!confirmation && (impact.records.length || impact.overrides.length)) {
        throw conflict('DIMENSION_REMOVAL_CONFIRM', '请先核对删除维度的影响');
      }
      const dimensions = proposed.map(dimension => {
        if (dimension.id === null) return { ...dimension, id: randomUUID() };
        const old = previous.get(dimension.id);
        if (!old) throw invalid('维度编号已退役或不属于当前配置，新维度请使用 null');
        if (nameKey(dimension.positive_label) === nameKey(old.negative_label) &&
            nameKey(dimension.negative_label) === nameKey(old.positive_label)) {
          throw invalid('对调维度两端时，请以新维度替换，避免旧分数含义反转');
        }
        const next = dimension.tier_labels === undefined && old.tier_labels ? { ...dimension, tier_labels: old.tier_labels } : dimension;
        if (impact.scored.has(next.id) && !preserve.has(next.id) && canonical(dimensionDTO(old)) !== canonical(dimensionDTO(next))) {
          throw conflict('AXIS_MEANING_CONFIRM', '请确认已有评分的含义和正负方向不变，或换用新维度');
        }
        return next;
      });
      const now = Date.now();
      for (const row of impact.records) {
        for (const axis of remove) delete row.scores[axis];
        this.writeScores(id, row.id, { attribute_revision: row.revision, scores: row.scores }, now);
      }
      for (const row of impact.overrides) this.db.prepare('DELETE FROM creative_asset_overrides WHERE id=?').run(row.id);
      const data = { source: 'user', updated_at: now, dimensions }, revision = config.revision + 1;
      if (config.revision === 0) {
        this.db.prepare('INSERT INTO series_attribute_configs (id,revision,data_json,created_at,updated_at) VALUES(?,?,?,?,?)')
          .run(id, revision, canonical(data), now, now);
      } else {
        this.db.prepare('UPDATE series_attribute_configs SET revision=?,data_json=?,updated_at=? WHERE id=?')
          .run(revision, canonical(data), now, id);
      }
      return this.assets.attributes.configDTO({ series_id: id, revision, ...data });
    });
  }

  scoreBatch(type, id, input) {
    if (type !== 'series') throw readOnly();
    const scores = scoreChanges(input?.scores, true);
    if (!isRevision(input.config_revision)) throw invalid('评分配置修订号无效');
    return this.mutation(type, id, 'attribute-scores', input, scope => {
      this.lockProjects(scope);
      const config = this.seriesConfig(id);
      if (config.revision !== input.config_revision) throw stale();
      const valid = new Set(config.dimensions.map(dimension => dimension.id));
      const records = new Map(), dirty = new Set();
      const result = { config_revision: config.revision, applied: 0, skipped: [] };
      const now = Date.now();
      for (const { asset_id, dimension_id, value, reason } of scores) {
        if (!records.has(asset_id)) {
          const asset = this.db.prepare(`SELECT id FROM creative_assets WHERE id=? AND owner_type='series'
            AND owner_id=? AND kind='character' AND archived_at=0`).get(asset_id, id);
          records.set(asset_id, asset ? this.seriesScores(id, asset.id) : null);
        }
        const record = records.get(asset_id);
        let code;
        if (!record) code = 'ASSET_UNAVAILABLE';
        else if (!valid.has(dimension_id)) code = 'DIMENSION_UNAVAILABLE';
        else if (record.scores[dimension_id]?.source === 'manual') code = 'MANUAL_PRESERVED';
        if (code) result.skipped.push({ asset_id, dimension_id, code });
        else {
          record.scores[dimension_id] = { value, source: 'ai', reason, updated_at: now };
          dirty.add(asset_id);
          result.applied++;
        }
      }
      for (const assetId of dirty) this.writeScores(id, assetId, records.get(assetId), now);
      return result;
    });
  }

  setOverride(type, id, assetId, input) {
    return this.mutation(type, id, 'override:' + assetId, input, scope => {
      const item = this.reads.detailInTransaction(scope, assetId);
      if (!['season', 'episode'].includes(type) || item.owner.type !== 'series' || item.asset.archived_at) throw readOnly();
      const { field, action } = input;
      if (!isRecord(field) || !['set', 'inherit'].includes(action) || (action === 'set') !== Object.hasOwn(input, 'value')) {
        throw invalid('覆盖操作无效');
      }
      const { key, look_id, dimension_id } = field;
      const asset = item.asset;
      let fieldKey, effective, value = input.value;
      if (key === 'default_look' && asset.kind === 'character' && look_id === undefined && dimension_id === undefined) {
        fieldKey = key;
        effective = item.effective.default_look;
        if (action === 'set' && !asset.looks.some(look => look.id === value && active(look))) throw invalid('请选择有效造型');
      } else if (key === 'default_image' && dimension_id === undefined &&
          (asset.kind === 'character' ? asset.looks.some(look => look.id === look_id && active(look)) : look_id == null)) {
        fieldKey = asset.kind === 'character' ? key + ':' + look_id : key;
        effective = item.effective.default_images?.[String(look_id ?? null)];
        if (action === 'set' && !asset.images.some(image => image.id === value && image.look_id === (look_id ?? null) && active(image))) {
          throw invalid('请选择当前造型或资产中的有效图片');
        }
      } else if (key === 'attribute_score' && asset.kind === 'character' && type === 'episode' && look_id === undefined && idOK(dimension_id)) {
        fieldKey = key + ':' + dimension_id;
        effective = item.effective.attribute_scores?.[dimension_id];
        if (action === 'set') {
          if (!isRecord(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'value')) throw invalid('评分格式无效');
          const [change] = scoreChanges([{ dimension_id, value: value.value }]);
          value = { value: change.value, source: 'manual', reason: null, updated_at: Date.now() };
        }
      } else throw invalid('该作用域不能覆盖此字段');
      if (!effective) throw invalid('覆盖字段已不存在');
      this.reads.assertWriteToken(effective, input.write_token);
      this.lockProjects(scope);
      const rowId = digest([type, id, assetId, fieldKey]);
      const row = this.db.prepare('SELECT revision,updated_at FROM creative_asset_overrides WHERE id=?').get(rowId);
      if (action === 'inherit') this.db.prepare('DELETE FROM creative_asset_overrides WHERE id=?').run(rowId);
      else if (row) this.db.prepare('UPDATE creative_asset_overrides SET value_json=?,revision=?,updated_at=? WHERE id=?')
        .run(canonical(value), row.revision + 1, Math.max(scope.operation_at, row.updated_at + 1), rowId);
      else {
        const now = scope.operation_at;
        this.db.prepare(`INSERT INTO creative_asset_overrides
          (id,scope_type,scope_id,asset_id,field_key,value_json,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)`)
          .run(rowId, type, id, assetId, fieldKey, canonical(value), now, now);
      }
      const clock = this.db.prepare('SELECT updated_at FROM creative_asset_override_clocks WHERE id=?').get(rowId);
      if (clock) this.db.prepare('UPDATE creative_asset_override_clocks SET updated_at=? WHERE id=?')
        .run(Math.max(scope.operation_at, clock.updated_at + 1), rowId);
      else this.db.prepare(`INSERT INTO creative_asset_override_clocks
        (id,scope_type,scope_id,asset_id,field_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
        .run(rowId, type, id, assetId, fieldKey, scope.operation_at, scope.operation_at);
      return this.reads.detailInTransaction(scope, assetId);
    });
  }
}
