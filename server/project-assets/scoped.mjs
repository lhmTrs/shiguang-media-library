import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DEFAULT_DIMENSIONS, dimensionDTO, isRecord, isRevision, isScore } from '../project-attributes/model.mjs';
import { canonical, fault, idOK } from './model.mjs';

const KINDS = ['character', 'scene', 'prop'];
const FLAGS = ['edit_base', 'create_override', 'append', 'promote', 'archive'];
const notFound = () => fault('当前作用域中没有该对象', 404, { code: 'ASSET_SCOPE_NOT_FOUND' });
const named = row => row ? { id: row.id, name: row.name } : null;
const source = (type, id, revision) => ({ type, id, revision: Number(revision) });
const activeChild = row => row.archived_at === null;
const positiveInt = (value, fallback, max) => {
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(n) ? Math.max(1, Math.min(n, max)) : fallback;
};

function parseOverride(raw) {
  try { return JSON.parse(raw); } catch { return undefined; }
}

const manualScore = score => isRecord(score) && score.source === 'manual' &&
  score.reason === null && isRevision(score.updated_at) && (score.value === null || isScore(score.value));

function matchesToken(expected, supplied) {
  return typeof expected === 'string' && typeof supplied === 'string' &&
    /^[a-f0-9]{64}$/.test(expected) && /^[a-f0-9]{64}$/.test(supplied) &&
    timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'));
}

export class ScopedProjectAssets {
  #key = randomBytes(32);
  #writes = {};

  constructor(store) {
    this.store = store;
  }

  get db() { return this.store.db; }

  #snapshot(read) {
    const db = this.db;
    // The adapter uses one synchronous connection. Set isolation for this
    // transaction even if the MySQL server's session default is READ COMMITTED.
    if (db.kind === 'mysql') db.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    return db.transaction(read)();
  }

  #token(domain, data) {
    return createHmac('sha256', this.#key).update(canonical(['project-assets/v1', domain, data])).digest('hex');
  }

  assertContextToken(scope, token) {
    if (!matchesToken(scope?.context_token, token)) {
      throw fault('资产作用域已变化，请重新读取', 409, { code: 'ASSET_SCOPE_CHANGED' });
    }
  }

  assertWriteToken(field, token) {
    if (!matchesToken(field?.write_token, token)) {
      throw fault('资产字段已变化，请重新读取', 409, { code: 'ASSET_STALE' });
    }
  }

  // Route availability only. Write handlers must still authorize each action.
  setWriteCapabilities(flags = {}) {
    this.#writes = Object.fromEntries(FLAGS.map(key => [key, flags[key] === true]));
  }

  #capabilities(scope, row) {
    const owns = scope.type === 'series' || scope.type === 'episode' && row.owner_type === 'project';
    const shared = row.owner_type === 'series';
    const available = {
      edit_base: owns,
      create_override: shared && (scope.type === 'season' || scope.type === 'episode'),
      append: shared && scope.type === 'episode',
      promote: !shared && scope.type === 'episode' && scope.series_id !== null,
      archive: owns,
    };
    return Object.fromEntries(FLAGS.map(key => [key, !Number(row.archived_at) && this.#writes[key] === true && available[key]]));
  }

  // For write handlers: call after taking the directory lock in the caller's
  // transaction. It deliberately does not start or commit a transaction.
  scope(type, id) {
    if (!['series', 'season', 'episode'].includes(type) || !idOK(id)) throw notFound();
    let project = null, series = null, season = null, membership = null;
    if (type === 'episode') {
      project = this.db.prepare("SELECT id,name FROM media_projects WHERE id=? AND project_kind='normal'").get(id);
      if (!project) throw notFound();
      membership = this.db.prepare('SELECT series_id,season_id,revision FROM project_series_members WHERE id=?').get(project.id);
      if (membership?.season_id) {
        season = this.db.prepare('SELECT id,series_id,season_no,label,revision FROM project_series_seasons WHERE id=? AND series_id=?')
          .get(membership.season_id, membership.series_id);
        if (!season) throw notFound();
      }
    } else if (type === 'season') {
      season = this.db.prepare('SELECT id,series_id,season_no,label,revision FROM project_series_seasons WHERE id=?').get(id);
      if (!season) throw notFound();
    }
    const seriesId = type === 'series' ? id : season?.series_id ?? membership?.series_id ?? null;
    if (seriesId !== null) {
      series = this.db.prepare('SELECT id,name,revision FROM project_series WHERE id=?').get(seriesId);
      if (!series) throw notFound();
    }
    const scopeId = (project ?? season ?? series).id;
    const membershipRevision = Number(membership?.revision ?? 0);
    const context_token = this.#token('context', [
      type, scopeId, series?.id ?? null, season?.id ?? null, membershipRevision,
      Number(series?.revision ?? 0), Number(season?.revision ?? 0),
    ]);
    return {
      type, id: scopeId, project: named(project), series: named(series),
      season: season ? { id: season.id, name: season.label?.trim() || `第 ${season.season_no} 季` } : null,
      series_id: series?.id ?? null, season_id: season?.id ?? null,
      membership_revision: membershipRevision, context_token,
    };
  }

  assetContext(projectId) {
    return this.#snapshot(() => {
      const { project, series, season, membership_revision, context_token } = this.scope('episode', projectId);
      return { project, series, season, membership_revision, context_token };
    });
  }

  generationSnapshot(projectId, stamp) {
    return this.#snapshot(() => {
      const scope = this.scope('episode', projectId);
      const assetStamp = stamp();
      if (scope.series_id === null) return { assetStamp };
      const { sql, params } = this.#owners(scope);
      const rows = this.db.prepare(`SELECT id,project_id,owner_type,owner_id,kind,revision,archived_at
        FROM creative_assets WHERE ${sql} AND archived_at=0 ORDER BY id`).all(...params);
      const configs = new Map();
      const assets = rows.map(row => {
        const { asset, owner, effective } = this.#item(scope, row, configs);
        return {
          id: asset.id, kind: asset.kind, name: asset.name, revision: asset.revision, owner,
          base_info: asset.base_info, performance_info: asset.performance_info,
          looks: asset.looks.filter(activeChild).map(({ id, name, description, tags }) => ({ id, name, description, tags })),
          default_look_id: effective.default_look?.value ?? null,
          default_image_ids: Object.fromEntries(Object.entries(effective.default_images).map(([key, field]) => [key, field.value])),
          attribute_scores: Object.fromEntries(Object.entries(effective.attribute_scores).map(([key, field]) => [key, field.value])),
        };
      });
      return {
        assetStamp, scopedAssets: {
          series: scope.series, season: scope.season, membership_revision: scope.membership_revision, assets,
        },
      };
    });
  }

  #owners(scope) {
    const clauses = [], params = [];
    if (scope.type === 'episode') {
      clauses.push("(owner_type='project' AND owner_id=? AND project_id=?)");
      params.push(scope.id, scope.id);
    }
    if (scope.series_id !== null) {
      clauses.push("(owner_type='series' AND owner_id=? AND project_id IS NULL)");
      params.push(scope.series_id);
    }
    return { sql: '(' + clauses.join(' OR ') + ')', params };
  }

  #visibleRow(scope, assetId) {
    if (!idOK(assetId)) throw notFound();
    const { sql, params } = this.#owners(scope);
    const row = this.db.prepare(`SELECT id,project_id,owner_type,owner_id,kind,revision,archived_at
      FROM creative_assets WHERE id=? AND ${sql}`).get(assetId, ...params);
    if (!row) throw notFound();
    return row;
  }

  list(type, id, query = {}) {
    return this.#snapshot(() => {
      const scope = this.scope(type, id);
      const kind = query.kind ?? 'character';
      if (!KINDS.includes(kind)) throw fault('资产类型无效', 422, { code: 'INVALID_ASSET_KIND' });
      const page = positiveInt(query.page, 1, 100000), size = positiveInt(query.size, 40, 100);
      const q = typeof query.q === 'string' ? query.q.toLowerCase() : '';
      const archived = query.archived === 'true' || query.archived === true;
      const { sql, params } = this.#owners(scope);
      const fields = 'id,project_id,owner_type,owner_id,kind,revision,archived_at';
      const where = `FROM creative_assets WHERE ${sql} AND kind=? AND archived_at${archived ? '>0' : '=0'}`;
      const args = [...params, kind];
      let total, rows;
      const offset = (page - 1) * size;
      if (q) {
        // Preserve the old list's literal, case-insensitive name and base text
        // search across both databases; page only after the scoped filter.
        const matching = this.db.prepare(`SELECT ${fields},name,data_json ${where} ORDER BY updated_at DESC,id`).all(...args)
          .filter(row => (row.name + (JSON.parse(row.data_json).base_info ?? '')).toLowerCase().includes(q));
        total = matching.length;
        rows = matching.slice(offset, offset + size);
      } else {
        total = Number(this.db.prepare(`SELECT COUNT(*) n ${where}`).get(...args).n);
        rows = this.db.prepare(`SELECT ${fields} ${where} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(...args, size, offset);
      }
      const configs = new Map();
      return {
        scope: { type: scope.type, id: scope.id }, context_token: scope.context_token, total, page,
        items: rows.map(row => {
          const item = this.#item(scope, row, configs);
          return { ...item, cover: item.effective.cover, look_count: item.asset.looks.filter(activeChild).length };
        }),
      };
    });
  }

  seasonOverrides(type, id, query = {}) {
    return this.#snapshot(() => {
      const scope = this.scope(type, id);
      if (scope.type !== 'season') throw notFound();
      const kind = query.kind;
      if (kind !== undefined && !KINDS.includes(kind)) throw fault('资产类型无效', 422, { code: 'INVALID_ASSET_KIND' });
      const page = positiveInt(query.page, 1, 100000), size = positiveInt(query.size, 40, 100);
      const rows = this.db.prepare(`SELECT o.asset_id,o.field_key FROM creative_asset_overrides o
        JOIN creative_assets a ON a.id=o.asset_id
        WHERE o.scope_type='season' AND o.scope_id=? AND a.owner_type='series'
          AND a.owner_id=? AND a.archived_at=0${kind ? ' AND a.kind=?' : ''}
        ORDER BY a.name,a.id,o.field_key`).all(scope.id, scope.series_id, ...(kind ? [kind] : []));
      const byAsset = new Map(), items = [];
      for (const row of rows) {
        if (!byAsset.has(row.asset_id)) byAsset.set(row.asset_id, this.detailInTransaction(scope, row.asset_id));
        const { asset, effective } = byAsset.get(row.asset_id);
        const [key, lookId] = row.field_key.split(':');
        const resolved = key === 'default_look' ? effective.default_look :
          key === 'default_image' ? effective.default_images[lookId ?? 'null'] : null;
        if (resolved?.override) {
          const field = key === 'default_image' ? { key, look_id: lookId ?? null } : { key };
          items.push({ asset: { id: asset.id, name: asset.name, kind: asset.kind }, field, ...resolved });
        }
      }
      const offset = (page - 1) * size;
      return {
        scope: { type: scope.type, id: scope.id }, context_token: scope.context_token,
        total: items.length, page, items: items.slice(offset, offset + size),
      };
    });
  }

  detail(type, id, assetId) {
    return this.#snapshot(() => this.detailInTransaction(this.scope(type, id), assetId));
  }

  detailInTransaction(scope, assetId) {
    return this.#item(scope, this.#visibleRow(scope, assetId), new Map());
  }

  async health(type, id, assetId) {
    const before = this.#snapshot(() => {
      const scope = this.scope(type, id);
      return { scope, row: this.#visibleRow(scope, assetId) };
    });
    const result = await this.store.health(before.row.id);
    this.#snapshot(() => {
      const scope = this.scope(type, id);
      this.assertContextToken(scope, before.scope.context_token);
      const row = this.#visibleRow(scope, assetId);
      if (row.revision !== before.row.revision || row.revision !== result.revision) {
        throw fault('资产已更新，请重新读取图片状态', 409, { code: 'ASSET_STALE' });
      }
    });
    return result;
  }

  episodeShots(type, id, assetId) {
    return this.#snapshot(() => {
      const scope = this.scope(type, id);
      if (type !== 'episode') throw notFound();
      const row = this.#visibleRow(scope, assetId);
      const board = this.store.storyboards;
      if (!board) throw fault('分镜模块尚未就绪，请稍后重试', 503);
      return board.assetShots(row.id, scope.id);
    });
  }

  versions(type, id, assetId, version) {
    return this.#snapshot(() => {
      const scope = this.scope(type, id);
      const row = this.#visibleRow(scope, assetId);
      const owns = type === 'series' || type === 'episode' && row.owner_type === 'project';
      if (!owns) throw notFound();
      // Keep earlier local snapshots in backups without granting a new owner
      // access to the originating episode's drafts or images.
      if (type === 'series') {
        const belongs = snapshot => snapshot.owner_type === 'series' && snapshot.owner_id === scope.id && snapshot.project_id === null;
        if (version !== undefined) {
          const snapshot = this.store.version(row.id, version);
          if (!belongs(snapshot)) throw notFound();
          return snapshot;
        }
        return this.db.prepare(`SELECT id,version,summary,created_at,snapshot FROM creative_asset_versions
          WHERE asset_id=? ORDER BY version DESC`).all(row.id)
          .filter(entry => belongs(JSON.parse(entry.snapshot))).map(({ snapshot, ...entry }) => entry);
      }
      return version === undefined ? this.store.versions(row.id) : this.store.version(row.id, version);
    });
  }

  #attributeConfig(type, id) {
    if (type === 'project') return this.store.attributes.configDTO(this.store.attributes.config(id));
    const row = this.db.prepare('SELECT revision,data_json FROM series_attribute_configs WHERE id=?').get(id);
    const config = row ? JSON.parse(row.data_json) : { source: 'default', updated_at: null, dimensions: DEFAULT_DIMENSIONS };
    return {
      series_id: id, revision: Number(row?.revision ?? 0), source: config.source, updated_at: config.updated_at,
      dimensions: config.dimensions.map(dimensionDTO),
    };
  }

  #attributeRecord(row) {
    const table = row.owner_type === 'series' ? 'series_character_attributes' : 'project_character_attributes';
    const ownerColumn = row.owner_type === 'series' ? 'series_id' : 'project_id';
    const record = this.db.prepare(`SELECT revision,data_json FROM ${table} WHERE id=? AND ${ownerColumn}=?`).get(row.id, row.owner_id);
    return record ? { revision: Number(record.revision), scores: JSON.parse(record.data_json) } : { revision: 0, scores: {} };
  }

  attributeConfig(type, id, assetId) {
    return this.#snapshot(() => {
      const scope = this.scope(type, id);
      if (assetId !== undefined) {
        const row = this.#visibleRow(scope, assetId);
        if (row.kind !== 'character') throw notFound();
        return this.#attributeConfig(row.owner_type, row.owner_id);
      }
      return scope.type === 'episode' ? this.#attributeConfig('project', scope.id) : this.#attributeConfig('series', scope.series_id);
    });
  }

  attributeScores(type, id, assetId) {
    return this.#snapshot(() => {
      const scope = this.scope(type, id);
      if (scope.type !== 'series') throw notFound();
      const row = this.#visibleRow(scope, assetId);
      if (row.kind !== 'character') throw notFound();
      const config = this.#attributeConfig('series', scope.id), record = this.#attributeRecord(row);
      return {
        asset_id: row.id, series_id: scope.id, config_revision: config.revision,
        attribute_revision: record.revision, scores: record.scores,
      };
    });
  }

  #overrideLayers(scope, row) {
    if (row.owner_type !== 'series') return [];
    const layers = [];
    if (scope.season_id) layers.push({ type: 'season', id: scope.season_id, fields: new Map(), clocks: new Map() });
    if (scope.type === 'episode') layers.push({ type: 'episode', id: scope.id, fields: new Map(), clocks: new Map() });
    if (!layers.length) return layers;
    const terms = layers.map(() => '(scope_type=? AND scope_id=?)').join(' OR ');
    const rows = this.db.prepare(`SELECT scope_type,scope_id,field_key,value_json,revision,created_at,updated_at
      FROM creative_asset_overrides WHERE asset_id=? AND (${terms})`).all(row.id, ...layers.flatMap(layer => [layer.type, layer.id]));
    const byType = new Map(layers.map(layer => [layer.type, layer]));
    for (const override of rows) byType.get(override.scope_type).fields.set(override.field_key, override);
    const clocks = this.db.prepare(`SELECT scope_type,field_key,updated_at FROM creative_asset_override_clocks
      WHERE asset_id=? AND (${terms})`).all(row.id, ...layers.flatMap(layer => [layer.type, layer.id]));
    for (const clock of clocks) byType.get(clock.scope_type).clocks.set(clock.field_key, clock.updated_at);
    return layers;
  }

  #cover(binding) {
    if (!binding) return null;
    // Indexed status only: a GET never opens an original or hashes a file.
    const media = this.db.prepare(`SELECT a.kind,a.trashed,r.id root_id,r.retired,r.online
      FROM assets a LEFT JOIN roots r ON r.id=a.root_id WHERE a.id=?`).get(binding.media_asset_id);
    const [state, label] = !media ? ['missing', '素材记录不存在']
      : media.kind !== 'photo' ? ['invalid', '仅支持图片素材']
        : Number(media.trashed) ? ['trashed', '素材已移入废纸篓']
          : !media.root_id || Number(media.retired) ? ['retired', '素材目录已注销']
            : Number(media.online) === 0 && media.online !== null ? ['offline', '素材目录离线']
              : ['unchecked', '尚未检查文件'];
    return { ...binding, health: { state, label } };
  }

  #item(scope, row, configs) {
    const asset = this.store.get(row.id);
    const owner = { type: row.owner_type, id: row.owner_id, name: (row.owner_type === 'series' ? scope.series : scope.project).name };
    const layers = this.#overrideLayers(scope, row);
    const looks = new Map(asset.looks.filter(activeChild).map(look => [look.id, look]));
    const images = new Map(asset.images.filter(activeChild).map(image => [image.id, image]));

    const field = (key, baseValue, baseRevision, applicable, valid, targetRevision, extraVersion = null) => {
      let current = { value: baseValue, source: source(owner.type, owner.id, baseRevision) };
      const base = current;
      let parent = null, override = null;
      const versions = applicable.map(layer => {
        parent = current;
        const stored = layer.fields.get(key), value = stored ? parseOverride(stored.value_json) : undefined;
        override = stored && valid(value) ? { value, revision: Number(stored.revision) } : null;
        if (override) current = { value, source: source(layer.type, layer.id, override.revision) };
        return [layer.type, layer.id, layer.clocks.get(key) ?? null,
          stored ? [stored.revision, stored.created_at, stored.updated_at, stored.value_json, targetRevision(value)] : null];
      });
      return {
        ...current, override, parent,
        write_token: this.#token('field', [
          scope.context_token, owner.type, owner.id, row.id, row.revision, key,
          base, targetRevision(baseValue), versions, extraVersion,
        ]),
      };
    };

    const imageField = (lookId, value, revision) => {
      const valid = id => images.has(id) && images.get(id).look_id === lookId;
      return field(lookId === null ? 'default_image' : 'default_image:' + lookId,
        valid(value) ? value : null, revision, layers, valid,
        id => valid(id) ? images.get(id).revision : null);
    };
    const effective = { default_images: {}, attribute_scores: {}, cover: null };
    let coverId;
    if (row.kind === 'character') {
      const validLook = id => looks.has(id);
      effective.default_look = field('default_look', validLook(asset.default_look_id) ? asset.default_look_id : null,
        row.revision, layers, validLook, id => looks.get(id)?.revision ?? null);
      effective.default_images = Object.fromEntries([...looks.values()].map(look => [look.id, imageField(look.id, look.default_image_id, look.revision)]));
      coverId = effective.default_images[effective.default_look.value]?.value;
      const configKey = owner.type + ':' + owner.id;
      if (!configs.has(configKey)) configs.set(configKey, this.#attributeConfig(owner.type, owner.id));
      const config = configs.get(configKey), record = this.#attributeRecord(row);
      const scoreLayers = layers.filter(layer => layer.type === 'episode');
      effective.attribute_config_revision = config.revision;
      effective.attribute_scores = Object.fromEntries(config.dimensions.map(dim => [
        dim.id, field('attribute_score:' + dim.id, Object.hasOwn(record.scores, dim.id) ? record.scores[dim.id] : null,
          record.revision, scoreLayers, manualScore, () => null, config.revision),
      ]));
    } else {
      effective.default_images.null = imageField(null, asset.default_image_id, row.revision);
      coverId = effective.default_images.null.value;
    }
    effective.cover = this.#cover(images.get(coverId));
    return { asset, owner, capabilities: this.#capabilities(scope, row), effective, context_token: scope.context_token };
  }
}
