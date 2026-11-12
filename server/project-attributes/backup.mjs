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

export function validateAttributes(input, projects, assets) {
  if (!hasFields(input, Object.keys(ATTRIBUTE_TABLES))) throw invalid();
  const normalProjects = new Set(projects.filter(p => p.project_kind === 'normal').map(p => p.id));
  const configs = new Map();
  for (const [table, fields] of Object.entries(ATTRIBUTE_TABLES)) {
    const rows = input[table], seen = new Set();
    if (!Array.isArray(rows) || rows.length > 100000) throw invalid();
    for (const row of rows) {
      if (!hasFields(row, Object.keys(fields)) || seen.has(row.id)) throw invalid();
      seen.add(row.id);
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
        const active = new Set((configs.get(projectId) ?? DEFAULT_DIMENSIONS).map(dimension => dimension.id));
        for (const [dimensionId, score] of Object.entries(data)) {
          if (!active.has(dimensionId) || !hasFields(score, ['value', 'source', 'reason', 'updated_at']) ||
              !isRevision(score.updated_at) || !['ai', 'manual'].includes(score.source)) throw invalid();
          if (score.source === 'manual') {
            if (score.reason !== null || score.value !== null && !isScore(score.value)) throw invalid();
          } else if (!isScore(score.value) || textField(score.reason, 200, '评分依据') !== score.reason) throw invalid();
        }
      } else {
        validateReceipt(row, data);
      }
    }
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
    for (const row of input[table]) {
      const old = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(row.id);
      if (!old) db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?')})`).run(...keys.map(key => row[key]));
      else if (canonical(old) !== canonical(row)) throw fault('目标项目已有不同的人物属性记录，未覆盖', 409);
    }
  }
}
