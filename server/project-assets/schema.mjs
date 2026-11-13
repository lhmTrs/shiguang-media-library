import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canonical, fault } from './model.mjs';

const LEGACY_CREATIVE_TABLES = {
  creative_schema: { id: 'key', version: 'integer', created_at: 'integer', updated_at: 'integer' },
  creative_assets: { id: 'id', project_id: 'ref', kind: 'key', name: 'name', name_key: 'key', data_json: 'text', default_look_id: 'optional_ref', default_image_id: 'optional_ref', revision: 'integer', archived_at: 'integer', source_json: 'text', created_at: 'integer', updated_at: 'integer' },
  creative_looks: { id: 'id', asset_id: 'ref', data_json: 'text', default_image_id: 'optional_ref', sort_order: 'integer', revision: 'integer', archived_at: 'nullable', source_json: 'text', created_at: 'integer', updated_at: 'integer' },
  creative_image_bindings: { id: 'id', asset_id: 'ref', look_id: 'optional_ref', media_asset_id: 'ref', expected_sha256: 'key', data_json: 'text', sort_order: 'integer', revision: 'integer', archived_at: 'nullable', source_json: 'text', created_at: 'integer', updated_at: 'integer' },
  creative_asset_versions: { id: 'id', asset_id: 'ref', version: 'integer', snapshot: 'text', summary: 'text', created_at: 'integer', updated_at: 'integer' },
  creative_asset_copy_records: { id: 'id', source_id: 'ref', target_id: 'ref', request_hash: 'key', source_json: 'text', created_at: 'integer', updated_at: 'integer' },
};
export const CREATIVE_TABLES = {
  ...LEGACY_CREATIVE_TABLES,
  creative_assets: { ...LEGACY_CREATIVE_TABLES.creative_assets, project_id: 'optional_ref', owner_type: 'key', owner_id: 'ref' },
  creative_asset_overrides: { id: 'hash_id', scope_type: 'key', scope_id: 'ref', asset_id: 'ref', field_key: 'key', value_json: 'text', revision: 'integer', created_at: 'integer', updated_at: 'integer' },
  creative_asset_scope_requests: { id: 'id', scope_type: 'key', scope_id: 'ref', request_hash: 'key', result_json: 'text', created_at: 'integer', updated_at: 'integer' },
  series_attribute_configs: { id: 'id', revision: 'integer', data_json: 'text', created_at: 'integer', updated_at: 'integer' },
  series_character_attributes: { id: 'id', series_id: 'ref', revision: 'integer', data_json: 'text', created_at: 'integer', updated_at: 'integer' },
};

export const creativeSchemaVersion = 3;

export function creativeColumnType(table, column, tables = CREATIVE_TABLES) {
  const type = tables[table]?.[column.name];
  if (!type) throw Error('未知资产库字段，未迁移');
  return { id: 'VARCHAR(36) PRIMARY KEY', ref: 'VARCHAR(36)', optional_ref: 'VARCHAR(36)', key: 'VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin', hash_id: 'CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY', name: 'VARCHAR(120)', integer: 'BIGINT', nullable: 'BIGINT', text: 'LONGTEXT' }[type];
}
export function creativeConstraints(table, tables = CREATIVE_TABLES) {
  if (table === 'creative_assets') return tables === LEGACY_CREATIVE_TABLES
    ? ['UNIQUE(project_id,kind,name_key,archived_at)']
    : ['CONSTRAINT creative_assets_name_owner UNIQUE(owner_type,owner_id,kind,name_key,archived_at)'];
  if (table === 'creative_asset_overrides') return ['UNIQUE(scope_type,scope_id,asset_id,field_key)'];
  if (table === 'creative_asset_versions') return ['UNIQUE(asset_id,version)'];
  return [];
}
export const creativeIndexes = {
  creative_looks_asset: ['creative_looks', 'asset_id'],
  creative_images_asset: ['creative_image_bindings', 'asset_id'],
  creative_images_media: ['creative_image_bindings', 'media_asset_id'],
  creative_scope_override_asset: ['creative_asset_overrides', 'asset_id'],
};

export function creativeSchema(mysql, tables = CREATIVE_TABLES) {
  return Object.entries(tables).map(([table, columns]) => {
    const defs = Object.entries(columns).map(([name, type]) => {
      const base = mysql ? creativeColumnType(table, { name }, tables) : ['integer', 'nullable'].includes(type) ? 'INTEGER' : 'TEXT';
      const primary = name === 'id' && (!mysql || type === 'key') ? ' PRIMARY KEY' : '';
      const nullability = ['nullable', 'optional_ref'].includes(type) ? '' : ' NOT NULL';
      const defaultValue = table === 'creative_assets' && name === 'archived_at' ? ' DEFAULT 0' : '';
      return `\`${name}\` ${base}${primary}${nullability}${defaultValue}`;
    });
    defs.push(...creativeConstraints(table, tables));
    return `CREATE TABLE IF NOT EXISTS ${table} (${defs.join(',')})${mysql ? ' ENGINE=InnoDB' : ''}`;
  });
}

export function convertCreativeBackupV2(input) {
  const legacyNames = Object.keys(LEGACY_CREATIVE_TABLES);
  if (Object.keys(input.tables).length !== legacyNames.length || legacyNames.some(name => !Array.isArray(input.tables[name]))) {
    throw fault('旧资产备份表不完整');
  }
  for (const row of input.tables.creative_assets) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw fault('旧资产备份记录无效');
    if (Object.hasOwn(row, 'owner_type') || Object.hasOwn(row, 'owner_id')) throw fault('旧备份包含非预期归属字段');
    row.owner_type = 'project';
    row.owner_id = row.project_id;
  }
  for (const table of Object.keys(CREATIVE_TABLES)) input.tables[table] ??= [];
  input.tables.creative_schema[0].version = creativeSchemaVersion;
  input.schema_version = creativeSchemaVersion;
}

// DDL on MySQL commits independently. The marker is advanced last; every step
// can safely resume after interruption. Never drop the old index before adding
// its replacement. Back up all asset data before the first change.
export function migrateCreativeArchive(lib) {
  const db = lib.db, mysql = db.kind === 'mysql';
  const state = db.prepare('SELECT * FROM creative_schema WHERE id=?').get('asset-library');
  if (state && ![1, 2, creativeSchemaVersion].includes(state.version)) throw Error('不支持的资产库版本');
  if (!state || state.version !== 1) return;
  const dir = path.join(lib.dataDir, 'backups'); mkdirSync(dir, { recursive: true });
  const tables = Object.fromEntries(Object.keys(LEGACY_CREATIVE_TABLES).map(t => [t, db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()]));
  writeFileSync(path.join(dir, `creative-before-v2-${Date.now()}-${randomUUID()}.json`), JSON.stringify({ schema_version: 1, tables }), { flag: 'wx', mode: 0o600 });
  const migrate = () => {
    if (mysql) {
      db.exec('UPDATE creative_assets SET archived_at=0 WHERE archived_at IS NULL');
      db.exec('ALTER TABLE creative_assets MODIFY archived_at BIGINT NOT NULL DEFAULT 0');
      const rows = db.prepare("SELECT INDEX_NAME name,COLUMN_NAME col,SEQ_IN_INDEX seq,NON_UNIQUE non_unique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='creative_assets' ORDER BY INDEX_NAME,SEQ_IN_INDEX").all();
      const indexes = new Map(); for (const r of rows) { if (!indexes.has(r.name)) indexes.set(r.name, []); indexes.get(r.name).push(r); }
      const signature = r => r.map(v => v.col).join(',');
      if (![...indexes.values()].some(r => !r[0].non_unique && signature(r) === 'project_id,kind,name_key,archived_at')) db.exec('CREATE UNIQUE INDEX creative_assets_name_archive ON creative_assets(project_id,kind,name_key,archived_at)');
      for (const [name, rows] of indexes) if (!rows[0].non_unique && signature(rows) === 'project_id,kind,name_key') db.exec('ALTER TABLE creative_assets DROP INDEX `' + name.replaceAll('`', '``') + '`');
    } else {
      const sql = creativeSchema(false, LEGACY_CREATIVE_TABLES).find(s => s.startsWith('CREATE TABLE IF NOT EXISTS creative_assets ')).replace('IF NOT EXISTS creative_assets ', 'creative_assets_v2 ');
      db.exec(sql);
      const cols = Object.keys(LEGACY_CREATIVE_TABLES.creative_assets);
      db.exec(`INSERT INTO creative_assets_v2(${cols.join(',')}) SELECT ${cols.map(k => k === 'archived_at' ? 'COALESCE(archived_at,0)' : k).join(',')} FROM creative_assets`);
      db.exec('DROP TABLE creative_assets'); db.exec('ALTER TABLE creative_assets_v2 RENAME TO creative_assets');
    }
    db.prepare('UPDATE creative_schema SET version=2,updated_at=? WHERE id=?').run(Date.now(), 'asset-library');
  };
  if (mysql) migrate(); else { const tx = db.transaction(migrate); (tx.immediate ?? tx)(); }
}
export function migrateCreativeOwners(lib) {
  const db = lib.db, mysql = db.kind === 'mysql';
  const state = db.prepare('SELECT version FROM creative_schema WHERE id=?').get('asset-library');
  if (state?.version !== 2) return;
  const dir = path.join(lib.dataDir, 'backups');
  mkdirSync(dir, { recursive: true });
  const tables = Object.fromEntries(Object.keys(LEGACY_CREATIVE_TABLES).map(table => [
    table, db.prepare(`SELECT ${Object.keys(LEGACY_CREATIVE_TABLES[table]).join(',')} FROM ${table} ORDER BY id`).all(),
  ]));
  writeFileSync(path.join(dir, `creative-before-v3-${Date.now()}-${randomUUID()}.json`),
    JSON.stringify({ schema_version: 2, tables }), { flag: 'wx', mode: 0o600 });

  const migrate = () => {
    const expected = tables.creative_assets;
    if (mysql) {
      const cols = db.prepare("SELECT COLUMN_NAME name,IS_NULLABLE nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='creative_assets'").all();
      if (!cols.some(col => col.name === 'owner_type')) db.exec('ALTER TABLE creative_assets ADD COLUMN owner_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL');
      if (!cols.some(col => col.name === 'owner_id')) db.exec('ALTER TABLE creative_assets ADD COLUMN owner_id VARCHAR(36) NULL');
      db.exec("UPDATE creative_assets SET owner_type='project',owner_id=project_id WHERE owner_type IS NULL AND owner_id IS NULL");
      if (db.prepare("SELECT id FROM creative_assets WHERE owner_type IS NULL OR owner_id IS NULL OR owner_type<>'project' OR project_id IS NULL OR owner_id<>project_id LIMIT 1").get()) {
        throw Error('资产归属回填校验失败');
      }
      const columns = [
        "MODIFY owner_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL",
        "MODIFY owner_id VARCHAR(36) NOT NULL",
        "MODIFY project_id VARCHAR(36) NULL",
      ];
      db.exec('ALTER TABLE creative_assets ' + columns.join(','));
      const index = db.prepare("SELECT INDEX_NAME name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='creative_assets' AND INDEX_NAME='creative_assets_name_owner'").get();
      if (!index) db.exec('CREATE UNIQUE INDEX creative_assets_name_owner ON creative_assets(owner_type,owner_id,kind,name_key,archived_at)');
    } else {
      const sql = creativeSchema(false).find(statement => statement.startsWith('CREATE TABLE IF NOT EXISTS creative_assets '));
      db.exec(sql.replace('IF NOT EXISTS creative_assets ', 'creative_assets_v3 '));
      const cols = Object.keys(LEGACY_CREATIVE_TABLES.creative_assets).join(',');
      db.exec(`INSERT INTO creative_assets_v3(${cols},owner_type,owner_id) SELECT ${cols},'project',project_id FROM creative_assets`);
      db.exec('DROP TABLE creative_assets');
      db.exec('ALTER TABLE creative_assets_v3 RENAME TO creative_assets');
    }
    const legacyColumns = Object.keys(LEGACY_CREATIVE_TABLES.creative_assets).join(',');
    const after = db.prepare(`SELECT ${legacyColumns} FROM creative_assets WHERE owner_type=? AND owner_id=project_id ORDER BY id`).all('project');
    const missingOwner = db.prepare('SELECT a.id FROM creative_assets a LEFT JOIN media_projects p ON p.id=a.owner_id WHERE p.id IS NULL LIMIT 1').get();
    if (canonical(expected) !== canonical(after) || missingOwner) throw Error('资产归属升级校验失败');
    db.prepare('UPDATE creative_schema SET version=?,updated_at=? WHERE id=?').run(creativeSchemaVersion, Date.now(), 'asset-library');
  };
  if (mysql) migrate(); else { const tx = db.transaction(migrate); (tx.immediate ?? tx)(); }
}

export function ensureCreativeProjects(lib) {
  const db = lib.db, mysql = db.kind === 'mysql';
  const columns = mysql ? db.prepare("SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='media_projects'").all() : db.prepare('PRAGMA table_info(media_projects)').all();
  if (!columns.some(c => c.name === 'project_kind') || !columns.some(c => c.name === 'system_key')) {
    const rows = db.prepare('SELECT * FROM media_projects ORDER BY id').all();
    if (rows.length) {
      if (!lib.dataDir) throw Error('项目升级缺少备份目录，未修改数据库');
      const dir = path.join(lib.dataDir, 'backups'); mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `projects-before-creative-${Date.now()}-${randomUUID()}.json`), JSON.stringify({ schema: columns, rows }), { flag: 'wx', mode: 0o600 });
    }
    if (!columns.some(c => c.name === 'project_kind')) db.exec(`ALTER TABLE media_projects ADD COLUMN project_kind ${mysql ? 'VARCHAR(16)' : 'TEXT'} NOT NULL DEFAULT 'normal'`);
    if (!columns.some(c => c.name === 'system_key')) db.exec(`ALTER TABLE media_projects ADD COLUMN system_key ${mysql ? 'VARCHAR(40)' : 'TEXT'} NULL`);
  }
  const indexed = mysql ? db.prepare("SELECT INDEX_NAME name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='media_projects' AND INDEX_NAME='media_projects_system_key'").get() : db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='media_projects_system_key'").get();
  if (!indexed) db.exec('CREATE UNIQUE INDEX media_projects_system_key ON media_projects(system_key)');
}
