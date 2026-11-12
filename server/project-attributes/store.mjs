import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { digest, fault, idOK, nameKey } from '../project-assets/model.mjs';
import { DEFAULT_DIMENSIONS, dimensionDTO, dimensionsInput, distinctIds, isRecord, isRevision, scoreChanges } from './model.mjs';
import { attributeSchema } from './schema.mjs';

const conflict = (code, message, fields) => fault(message, 409, { code, ...fields });

function expectConfig(config, revision, current) {
  if (!isRevision(revision)) throw fault('配置修订号无效');
  if (config.revision !== revision) throw conflict('CONFIG_STALE', '维度配置已更新，请重新读取', {
    current_revision: config.revision, ...(current && { current }),
  });
}

export class ProjectAttributes {
  #previewKey = randomBytes(32);

  constructor(assets) {
    this.assets = assets;
  }

  get db() { return this.assets.db; }

  init() {
    for (const sql of attributeSchema(this.db.kind === 'mysql')) this.db.exec(sql);
    return this;
  }

  project(id, lock = false) {
    const project = this.assets.project(id, lock);
    if (project.project_kind !== 'normal') throw fault('请先选择一个具体项目', 400);
    return project.id;
  }

  write(projectId, fn) {
    if (this.assets.lib.migrating) throw fault('数据库正在迁移，请稍后保存人物属性', 423);
    return this.assets.tx(() => fn(this.project(projectId, true)));
  }

  config(projectId) {
    const row = this.db.prepare('SELECT * FROM project_attribute_configs WHERE id=?').get(projectId);
    return row
      ? { project_id: projectId, revision: row.revision, ...JSON.parse(row.data_json) }
      : { project_id: projectId, revision: 0, source: 'default', updated_at: null, dimensions: DEFAULT_DIMENSIONS };
  }

  configDTO(config) {
    return { ...config, dimensions: config.dimensions.map(dimensionDTO) };
  }

  getConfig(id) { return this.configDTO(this.config(this.project(id))); }

  asset(id, projectId, allowArchived = false) {
    if (!idOK(id)) throw fault('人物编号无效');
    const asset = this.db.prepare('SELECT id,project_id,kind,archived_at FROM creative_assets WHERE id=?').get(id);
    if (asset?.project_id === projectId && asset.kind === 'character' && (allowArchived || asset.archived_at === 0)) return asset;
    return null;
  }

  requireAsset(id, projectId, allowArchived = false) {
    const asset = this.asset(id, projectId, allowArchived);
    if (!asset) throw fault('此项目中没有可用的对应人物', 404);
    return asset;
  }

  record(assetId) {
    const row = this.db.prepare('SELECT revision,data_json FROM project_character_attributes WHERE id=?').get(assetId);
    return row ? { revision: row.revision, scores: JSON.parse(row.data_json) } : { revision: 0, scores: {} };
  }

  scoresDTO(assetId, config, record) {
    return {
      asset_id: assetId, project_id: config.project_id, config_revision: config.revision,
      attribute_revision: record.revision, scores: record.scores,
    };
  }

  getScores(id) {
    return this.db.transaction(() => {
      const head = this.assets.head(id);
      const projectId = this.project(head.project_id);
      const asset = this.requireAsset(id, projectId, true);
      return this.scoresDTO(asset.id, this.config(projectId), this.record(asset.id));
    })();
  }

  compare(id, assetIds) {
    const ids = distinctIds(typeof assetIds === 'string' ? assetIds.split(',') : null, 3, '对比人物');
    return this.db.transaction(() => {
      const projectId = this.project(id);
      const config = this.config(projectId);
      const items = ids.map(id => {
        const asset = this.requireAsset(id, projectId);
        const record = this.record(asset.id);
        return { asset_id: asset.id, attribute_revision: record.revision, scores: record.scores };
      });
      return { config_revision: config.revision, items };
    })();
  }

  saveScores(projectId, assetId, record) {
    const json = JSON.stringify(record.scores);
    if (record.revision === 0) {
      this.db.prepare('INSERT INTO project_character_attributes(id,project_id,revision,data_json) VALUES(?,?,1,?)')
        .run(assetId, projectId, json);
    } else {
      this.db.prepare('UPDATE project_character_attributes SET revision=?,data_json=? WHERE id=? AND project_id=?')
        .run(record.revision + 1, json, assetId, projectId);
    }
    record.revision++;
  }

  patchScores(id, input) {
    const changes = scoreChanges(input?.changes);
    if (!isRevision(input.expected_attribute_revision)) throw fault('评分修订号无效');
    return this.write(input.project_id, projectId => {
      const asset = this.requireAsset(id, projectId);
      this.assets.generationLocks?.assertWritable(projectId);
      const config = this.config(projectId), record = this.record(asset.id);
      const current = this.scoresDTO(asset.id, config, record);
      expectConfig(config, input.expected_config_revision, current);
      if (record.revision !== input.expected_attribute_revision) {
        throw conflict('ATTRIBUTE_STALE', '人物属性已更新，请重新读取', { current, current_revision: record.revision });
      }
      const active = new Set(config.dimensions.map(dimension => dimension.id));
      const now = Date.now();
      for (const { dimension_id, value } of changes) {
        if (!active.has(dimension_id)) throw fault('评分维度已不存在');
        record.scores[dimension_id] = { value, source: 'manual', reason: null, updated_at: now };
      }
      this.saveScores(projectId, asset.id, record);
      return this.scoresDTO(asset.id, config, record);
    });
  }

  removal(config, ids) {
    const dimensions = new Map(config.dimensions.map(dimension => [dimension.id, dimension]));
    const affected = ids.map(id => {
      const dimension = dimensions.get(id);
      if (!dimension) throw fault('要删除的维度已不存在');
      return { dimension_id: id, name: dimension.name, scored_assets: 0, archived_scored_assets: 0 };
    });
    const records = [];
    if (ids.length) {
      const rows = this.db.prepare(`SELECT s.id, s.revision, s.data_json, a.archived_at, a.revision AS asset_revision
        FROM project_character_attributes s JOIN creative_assets a ON a.id=s.id WHERE s.project_id=? ORDER BY s.id`).all(config.project_id);
      for (const row of rows) {
        const scores = JSON.parse(row.data_json);
        const removed = affected.filter(item => Object.hasOwn(scores, item.dimension_id));
        if (!removed.length) continue;
        for (const item of removed) {
          item.scored_assets++;
          if (row.archived_at !== 0) item.archived_scored_assets++;
        }
        records.push({ ...row, removed: removed.map(item => item.dimension_id), scores });
      }
    }
    const fingerprint = [config.project_id, config.revision, affected,
      records.map(row => [row.id, row.revision, row.asset_revision, row.removed])];
    const token = createHmac('sha256', this.#previewKey).update(JSON.stringify(fingerprint)).digest('hex');
    return { token, affected, records };
  }

  removalPreview(id, input) {
    const remove = distinctIds(input?.remove, 8, '待删除维度').sort();
    return this.write(id, projectId => {
      const config = this.config(projectId);
      expectConfig(config, input.expected_revision);
      const { token, affected } = this.removal(config, remove);
      return { token, config_revision: config.revision, affected };
    });
  }

  putConfig(id, input, source = 'user') {
    const proposed = dimensionsInput(input?.dimensions);
    const confirmation = input.removal_confirmation;
    if (confirmation !== undefined && (!isRecord(confirmation) || typeof confirmation.token !== 'string' ||
        !/^[a-f0-9]{64}$/.test(confirmation.token))) throw fault('删除确认凭证无效');
    return this.write(id, projectId => {
      this.assets.generationLocks?.assertWritable(projectId);
      const current = this.config(projectId);
      expectConfig(current, input.expected_revision);
      if (source === 'agent') {
        const scores = this.db.prepare('SELECT data_json FROM project_character_attributes WHERE project_id=?').all(projectId);
        if (scores.some(row => Object.keys(JSON.parse(row.data_json)).length)) {
          throw conflict('ATTRIBUTES_ALREADY_SCORED', '项目已有评分，请在项目资产中调整维度');
        }
      }

      const old = new Map(current.dimensions.map(dimension => [dimension.id, dimension]));
      const retained = new Set(proposed.map(dimension => dimension.id));
      const removed = [...old.keys()].filter(id => !retained.has(id)).sort();
      const impact = this.removal(current, removed);
      if (confirmation && (!removed.length || !timingSafeEqual(Buffer.from(confirmation.token, 'hex'), Buffer.from(impact.token, 'hex')))) {
        throw conflict('REMOVAL_PREVIEW_STALE', '删除影响已变化，请重新核对');
      }
      if (!confirmation && impact.records.length) {
        throw conflict('DIMENSION_REMOVAL_CONFIRM', '请先核对删除维度的影响');
      }

      const dimensions = proposed.map(dimension => {
        if (dimension.id === null) return { ...dimension, id: randomUUID() };
        const previous = old.get(dimension.id);
        if (!previous) throw fault('维度编号已退役或不属于当前配置，新维度请使用 null');
        if (nameKey(dimension.positive_label) === nameKey(previous.negative_label) &&
            nameKey(dimension.negative_label) === nameKey(previous.positive_label)) {
          throw fault('对调维度两端时，请以新维度替换，避免旧分数含义反转');
        }
        if (dimension.tier_labels === undefined && previous.tier_labels) return { ...dimension, tier_labels: previous.tier_labels };
        return dimension;
      });
      for (const row of impact.records) {
        for (const dimId of row.removed) delete row.scores[dimId];
        this.saveScores(projectId, row.id, { revision: row.revision, scores: row.scores });
      }
      const revision = current.revision + 1;
      const data = { source, updated_at: Date.now(), dimensions };
      const json = JSON.stringify(data);
      if (current.revision === 0) {
        this.db.prepare('INSERT INTO project_attribute_configs(id,revision,data_json) VALUES(?,?,?)').run(projectId, revision, json);
      } else {
        this.db.prepare('UPDATE project_attribute_configs SET revision=?,data_json=? WHERE id=?').run(revision, json, projectId);
      }
      return this.configDTO({ project_id: projectId, revision, ...data });
    });
  }

  scoreBatch(id, input) {
    const scores = scoreChanges(input?.scores, true);
    if (!idOK(input.request_id) || !isRevision(input.config_revision)) throw fault('评分请求编号或配置修订号无效');
    const request_id = input.request_id.toLowerCase();
    const requestHash = digest({ config_revision: input.config_revision, scores });
    return this.write(id, projectId => {
      const key = digest([projectId, request_id]);
      const prior = this.db.prepare('SELECT data_json FROM project_attribute_requests WHERE id=? AND project_id=?').get(key, projectId);
      if (prior) {
        const saved = JSON.parse(prior.data_json);
        if (saved.request_hash !== requestHash) throw conflict('REQUEST_CONFLICT', '评分请求编号已用于不同内容');
        return saved.result;
      }

      this.assets.generationLocks?.assertWritable(projectId);
      const config = this.config(projectId);
      expectConfig(config, input.config_revision);
      const active = new Set(config.dimensions.map(dimension => dimension.id));
      const records = new Map();
      const dirty = new Set();
      const result = { request_id, config_revision: config.revision, applied: 0, skipped: [] };
      const now = Date.now();
      for (const { asset_id, dimension_id, value, reason } of scores) {
        if (!records.has(asset_id)) {
          const asset = this.asset(asset_id, projectId);
          records.set(asset_id, asset ? this.record(asset.id) : null);
        }
        const record = records.get(asset_id);
        let code;
        if (!record) code = 'ASSET_UNAVAILABLE';
        else if (!active.has(dimension_id)) code = 'DIMENSION_UNAVAILABLE';
        else if (record.scores[dimension_id]?.source === 'manual') code = 'MANUAL_PRESERVED';
        if (code) {
          result.skipped.push({ asset_id, dimension_id, code });
          continue;
        }
        record.scores[dimension_id] = { value, source: 'ai', reason, updated_at: now };
        dirty.add(asset_id);
        result.applied++;
      }
      for (const assetId of dirty) this.saveScores(projectId, assetId, records.get(assetId));
      this.db.prepare('INSERT INTO project_attribute_requests(id,project_id,data_json) VALUES(?,?,?)')
        .run(key, projectId, JSON.stringify({ request_hash: requestHash, result }));
      return result;
    });
  }

  removeProject(projectId) {
    this.db.prepare('DELETE FROM project_attribute_requests WHERE project_id=?').run(projectId);
    this.db.prepare('DELETE FROM project_character_attributes WHERE project_id=?').run(projectId);
    this.db.prepare('DELETE FROM project_attribute_configs WHERE id=?').run(projectId);
  }
}
