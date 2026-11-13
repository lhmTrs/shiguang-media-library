import { canonical, digest, fault, idOK } from '../project-assets/model.mjs';
import { DEFAULT_DIMENSIONS, dimensionsInput, isRecord, isRevision, isScore, textField } from './model.mjs';
import { ATTRIBUTE_TABLES } from './schema.mjs';

const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const invalid = () => fault('人物属性备份记录无效');
const hasFields = (value, fields) => isRecord(value) &&
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));

export function snapshotAttributes(db) {
  const entries = Object.keys(ATTRIBUTE_TABLES).map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]);
  return entries.some(([, rows]) => rows.length) ? Object.fromEntries(entries) : undefined;
}

const newTables = ['series_attribute_alignment', 'project_attribute_history'];
const allTables = Object.keys(ATTRIBUTE_TABLES);
const oldTables = allTables.filter(table => !newTables.includes(table));

export function validateAttributes(input, projects, assets, directory, sharedConfigs = [], versions = []) {
  if (!hasFields(input, allTables) && !hasFields(input, oldTables)) throw invalid();
  const series = new Set((directory?.project_series ?? []).map(row => row.id));
  const members = new Map((directory?.project_series_members ?? []).map(row => [row.id, row.series_id]));
  const shared = new Map(sharedConfigs.map(row => [row.id, JSON.parse(row.data_json).dimensions]));
  const markers = input.series_attribute_alignment ?? [];
  if (!Array.isArray(markers) || markers.length > 100000 || markers.some(row =>
    !hasFields(row, ['id', 'revision']) || !series.has(row.id) || !isRevision(row.revision) || row.revision < 1)) throw invalid();
  const aligned = new Set(markers.map(row => row.id));
  const normalProjects = new Set(projects.filter(p => p.project_kind === 'normal').map(p => p.id));
  const owners = new Map();
  for (const row of versions) {
    const old = JSON.parse(row.snapshot);
    if (old.kind === 'character' && idOK(old.project_id) && (old.owner_type ?? 'project') === 'project') {
      if (!owners.has(row.asset_id)) owners.set(row.asset_id, new Set());
      owners.get(row.asset_id).add(old.project_id);
    }
  }
  const history = new Map(), configs = new Map();
  for (const [table, fields] of Object.entries(ATTRIBUTE_TABLES)) {
    const rows = input[table] ?? [], seen = new Set();
    if (!Array.isArray(rows) || rows.length > 100000) throw invalid();
    for (const row of rows) {
      if (!hasFields(row, Object.keys(fields)) || seen.has(row.id)) throw invalid();
      seen.add(row.id);
      if (table === 'series_attribute_alignment') continue;
      if (table === 'project_attribute_history') {
        const data = validateHistory(row, assets, owners);
        const group = history.get(row.history_id) ?? {requestId: row.request_id, kind: row.kind, seriesId: row.series_id, rows: new Map()};
        if (group.requestId !== row.request_id || group.kind !== row.kind || group.seriesId !== row.series_id ||
            group.rows.has(row.project_id)) throw invalid();
        group.rows.set(row.project_id, data);
        history.set(row.history_id, group);
        continue;
      }
      const projectId = row.project_id ?? row.id;
      if (!normalProjects.has(projectId) || Object.hasOwn(row, 'revision') && (!isRevision(row.revision) || row.revision < 1) ||
          typeof row.data_json !== 'string' || row.data_json.length > 100000) throw invalid();
      let data;
      try { data = JSON.parse(row.data_json); } catch { throw invalid(); }
      if (table === 'project_attribute_configs') {
        if (!hasFields(data, ['source', 'updated_at', 'dimensions']) || !['user', 'agent'].includes(data.source) ||
            !isRevision(data.updated_at) || canonical(dimensionsInput(data.dimensions)) !== canonical(data.dimensions) ||
            data.dimensions.some(dimension => dimension.id === null)) throw invalid();
        configs.set(projectId, data.dimensions);
      } else if (table === 'project_character_attributes') {
        const asset = assets.get(row.id);
        if (!idOK(row.id) || asset?.kind !== 'character' || asset.project_id !== projectId || !isRecord(data)) throw invalid();
        const seriesId = members.get(projectId);
        const config = aligned.has(seriesId) ? shared.get(seriesId) : configs.get(projectId);
        const active = new Set((config ?? DEFAULT_DIMENSIONS).map(dimension => dimension.id));
        for (const [dimensionId, score] of Object.entries(data)) {
          if (!active.has(dimensionId) || !validScore(score)) throw invalid();
        }
      } else {
        validateReceipt(row, data);
      }
    }
  }
  validateAlignmentLinks(directory, new Map(markers.map(row => [row.id, row.revision])), series, history);
}

export function validateAlignmentLinks(directory, markers = new Map(), series = new Set(), history = new Map()) {
  const requests = new Map((directory?.project_series_requests ?? []).map(row => [row.id, row]));
  for (const [id, row] of requests) {
    const result = JSON.parse(row.result_json);
    if (row.kind === 'attribute-alignment') {
      const event = history.get(result.history_id);
      const summary = event?.rows.get(null);
      if (!summary || event.kind !== 'attribute_alignment' || event.requestId !== id ||
          event.seriesId !== result.series_id || summary.after_config.revision !== result.config_revision ||
          event.rows.size - 1 !== result.episodes_updated ||
          series.has(result.series_id) && markers.get(result.series_id) !== result.alignment_revision) throw invalid();
    }
    for (const historyId of result.attribute_history_ids ?? []) {
      const event = history.get(historyId);
      if (!event || !['series_move','series_exit'].includes(event.kind) || event.requestId !== id ||
          !['move','organize'].includes(row.kind)) throw invalid();
    }
  }
  for (const [historyId, event] of history) {
    const row = requests.get(event.requestId);
    if (!row) throw invalid();
    const result = JSON.parse(row.result_json);
    if (event.kind === 'attribute_alignment') {
      if (row.kind !== 'attribute-alignment' || result.history_id !== historyId) throw invalid();
      continue;
    }
    if (!result.attribute_history_ids?.includes(historyId)) throw invalid();
    const exit = event.kind === 'series_exit', summary = event.rows.has(null);
    if (exit ? summary || event.rows.size !== 1 : !summary || event.rows.size < 2) throw invalid();
    for (const projectId of event.rows.keys()) {
      if (projectId !== null && !result.changes.some(change => change.project_id === projectId &&
        (exit ? change.before.series_id === event.seriesId && change.after.series_id === null : change.after.series_id === event.seriesId))) throw invalid();
    }
  }
}

function validScore(score) {
  if (!hasFields(score, ['value', 'source', 'reason', 'updated_at']) || !isRevision(score.updated_at)) return false;
  return score.source === 'manual'
    ? score.reason === null && (score.value === null || isScore(score.value))
    : score.source === 'ai' && isScore(score.value) && textField(score.reason, 200, '评分依据') === score.reason;
}

function validateHistory(row, assets, owners) {
  if (!idOK(row.id) || !idOK(row.series_id) || row.project_id !== null && !idOK(row.project_id) ||
      !isRevision(row.created_at) || typeof row.data_json !== 'string') throw invalid();
  let data;
  try { data = JSON.parse(row.data_json); } catch { throw invalid(); }
  if (!hasFields(data, ['history_id','request_id','kind','created_at','before_configs','after_config','mappings','legacy_scores','impact']) ||
      !idOK(data.history_id) || !idOK(data.request_id) || !['attribute_alignment','series_move','series_exit'].includes(data.kind) ||
      data.history_id !== row.history_id || data.request_id !== row.request_id || data.kind !== row.kind ||
      data.created_at !== row.created_at || !Array.isArray(data.before_configs) || data.before_configs.length !== 1 ||
      !Array.isArray(data.mappings) || !Array.isArray(data.legacy_scores) ||
      !hasFields(data.impact, ['project_count','people','archived_people','scored_cells','manual_clear_cells']) ||
      !Object.values(data.impact).every(isRevision) || data.impact.archived_people > data.impact.people) throw invalid();
  for (const config of [...data.before_configs, data.after_config]) {
    if (!isRecord(config) || Object.keys(config).some(key => ![
      'project_id','series_id','revision','source','updated_at','dimensions','config_scope','config_owner_id','alignment_status','config_editable',
    ].includes(key)) || !isRevision(config.revision) || !['default','user','agent'].includes(config.source) ||
      config.updated_at !== null && !isRevision(config.updated_at) || !Array.isArray(config.dimensions) ||
      canonical(dimensionsInput(config.dimensions)) !== canonical(config.dimensions) ||
      config.dimensions.some(axis => axis.id === null)) throw invalid();
    for (const key of ['project_id','series_id','config_owner_id']) {
      if (Object.hasOwn(config, key) && config[key] !== null && !idOK(config[key])) throw invalid();
    }
  }
  const [before] = data.before_configs, after = data.after_config;
  if (row.project_id === null) {
    if (before.project_id != null || before.series_id !== row.series_id || after.series_id !== row.series_id ||
        after.project_id != null || row.kind === 'series_exit') throw invalid();
  } else if (before.project_id !== row.project_id ||
      (row.kind === 'series_exit' ? before.series_id !== row.series_id || after.project_id !== row.project_id || after.series_id != null
        : after.series_id !== row.series_id || after.project_id != null ||
          row.kind === 'attribute_alignment' && before.series_id !== row.series_id)) throw invalid();
  const targetIds = new Set(after.dimensions.map(axis => axis.id));
  const mapping = new Map();
  for (const item of data.mappings) {
    if (!hasFields(item, ['source_dimension_id','target_dimension_id']) || typeof item.source_dimension_id !== 'string' ||
        item.target_dimension_id !== null && !targetIds.has(item.target_dimension_id) || mapping.has(item.source_dimension_id)) throw invalid();
    mapping.set(item.source_dimension_id, item.target_dimension_id);
  }
  const seen = new Set();
  for (const item of data.legacy_scores) {
    const asset = assets.get(item?.asset_id);
    if (!hasFields(item, ['asset_id','scores']) || !idOK(item.asset_id) || seen.has(item.asset_id) ||
        asset?.kind !== 'character' || (asset.project_id !== row.project_id && !owners.get(item.asset_id)?.has(row.project_id)) ||
        !isRecord(item.scores) || Object.entries(item.scores).some(([id, score]) => mapping.get(id) !== null || !validScore(score))) throw invalid();
    seen.add(item.asset_id);
  }
  if (row.project_id === null && (data.mappings.length || data.legacy_scores.length)) throw invalid();
  return data;
}

export function assertRestoreAlignment(current, incoming) {
  const alignment = state => new Set((state.project_attributes?.series_attribute_alignment ?? []).map(row => row.id));
  const before = alignment(current), after = alignment(incoming);
  const currentSeries = new Set((current.project_series?.project_series ?? []).map(row => row.id));
  const configs = state => new Map(state.tables.series_attribute_configs.map(row => [row.id, row]));
  const currentConfigs = configs(current), incomingConfigs = configs(incoming);
  for (const {id} of incoming.project_series?.project_series ?? []) {
    if (currentSeries.has(id) && (before.has(id) !== after.has(id) ||
        before.has(id) && canonical(currentConfigs.get(id)) !== canonical(incomingConfigs.get(id))))
      throw fault('目标剧已有不同的维度统一状态或剧配置，未覆盖', 409);
  }
  const members = new Map((current.project_series?.project_series_members ?? []).map(row => [row.id, row]));
  const incomingMembers = new Map((incoming.project_series?.project_series_members ?? []).map(row => [row.id, row]));
  const existing = new Set(current.projects.map(project => project.id));
  const scoreProjects = new Set((incoming.project_attributes?.project_character_attributes ?? []).map(row => row.project_id));
  for (const {id} of incoming.projects) {
    if (existing.has(id) && (incoming.project_series || scoreProjects.has(id) && before.has(members.get(id)?.series_id)) &&
        canonical(members.get(id)) !== canonical(incomingMembers.get(id)))
      throw fault('目标项目已有不同的归组或维度归属，未覆盖', 409);
  }
}

function validateReceipt(row, data) {
  if (!hasFields(data, ['request_hash', 'result']) || !validHash(data.request_hash)) throw invalid();
  const { result } = data;
  if (!hasFields(result, ['request_id', 'config_revision', 'applied', 'skipped']) || !idOK(result.request_id) ||
      result.request_id !== result.request_id.toLowerCase() || row.id !== digest([row.project_id, result.request_id]) ||
      !isRevision(result.config_revision) || !isRevision(result.applied) || !Array.isArray(result.skipped) ||
      result.applied + result.skipped.length < 1 || result.applied + result.skipped.length > 200) throw invalid();
  for (const item of result.skipped) {
    if (!hasFields(item, ['asset_id', 'dimension_id', 'code']) || !idOK(item.asset_id) || !idOK(item.dimension_id) ||
        !['ASSET_UNAVAILABLE', 'DIMENSION_UNAVAILABLE', 'MANUAL_PRESERVED'].includes(item.code)) throw invalid();
  }
}

export function restoreAttributes(db, input) {
  if (!input) return;
  const configs = new Map(input.project_attribute_configs.map(row => [row.id, row]));
  const withScores = new Set([...input.project_character_attributes, ...input.project_attribute_requests].map(row => row.project_id));
  const projects = new Set([...configs.keys(), ...withScores]);
  for (const projectId of projects) {
    const current = db.prepare('SELECT * FROM project_attribute_configs WHERE id=?').get(projectId);
    const incoming = configs.get(projectId);
    if (current && canonical(current) !== canonical(incoming) ||
        incoming && !current && (
          db.prepare('SELECT id FROM project_character_attributes WHERE project_id=? LIMIT 1').get(projectId) ||
          db.prepare('SELECT id FROM project_attribute_requests WHERE project_id=? LIMIT 1').get(projectId)
        )) throw fault('目标项目已有不同的人物属性配置或评分，未覆盖', 409);
  }
  for (const [table, fields] of Object.entries(ATTRIBUTE_TABLES)) {
    const keys = Object.keys(fields);
    for (const row of input[table] ?? []) {
      const old = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(row.id);
      if (!old) db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?')})`).run(...keys.map(key => row[key]));
      else if (canonical(old) !== canonical(row)) throw fault('目标项目已有不同的人物属性记录，未覆盖', 409);
    }
  }
}
