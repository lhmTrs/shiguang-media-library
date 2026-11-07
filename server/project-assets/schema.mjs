import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const CREATIVE_TABLES = {
  creative_schema: { id: 'key', version: 'integer', created_at: 'integer', updated_at: 'integer' },
  creative_assets: { id: 'id', project_id: 'ref', kind: 'key', name: 'name', name_key: 'key', data_json: 'text', default_look_id: 'optional_ref', default_image_id: 'optional_ref', revision: 'integer', archived_at: 'integer', source_json: 'text', created_at: 'integer', updated_at: 'integer' },
  creative_looks: { id: 'id', asset_id: 'ref', data_json: 'text', default_image_id: 'optional_ref', sort_order: 'integer', revision: 'integer', archived_at: 'nullable', source_json: 'text', created_at: 'integer', updated_at: 'integer' },
  creative_image_bindings: { id: 'id', asset_id: 'ref', look_id: 'optional_ref', media_asset_id: 'ref', expected_sha256: 'key', data_json: 'text', sort_order: 'integer', revision: 'integer', archived_at: 'nullable', source_json: 'text', created_at: 'integer', updated_at: 'integer' },
  creative_asset_versions: { id: 'id', asset_id: 'ref', version: 'integer', snapshot: 'text', summary: 'text', created_at: 'integer', updated_at: 'integer' },
  creative_asset_copy_records: { id: 'id', source_id: 'ref', target_id: 'ref', request_hash: 'key', source_json: 'text', created_at: 'integer', updated_at: 'integer' },
};
export function creativeColumnType(table, column) {
  const type = CREATIVE_TABLES[table]?.[column.name];
  if (!type) throw Error('未知资产库字段，未迁移');
  return { id: 'VARCHAR(36) PRIMARY KEY', ref: 'VARCHAR(36)', optional_ref: 'VARCHAR(36)', key: 'VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin', name: 'VARCHAR(120)', integer: 'BIGINT', nullable: 'BIGINT', text: 'LONGTEXT' }[type];
}
export function creativeConstraints(table) {
  if (table === 'creative_assets') return ['UNIQUE(project_id,kind,name_key,archived_at)'];
  if (table === 'creative_asset_versions') return ['UNIQUE(asset_id,version)'];
  return [];
}
export const creativeIndexes = { creative_looks_asset: ['creative_looks', 'asset_id'], creative_images_asset: ['creative_image_bindings', 'asset_id'], creative_images_media: ['creative_image_bindings', 'media_asset_id'] };
export function creativeSchema(mysql) {
  return Object.entries(CREATIVE_TABLES).map(([table, columns]) => {
    const defs = Object.entries(columns).map(([name, type]) => `\`${name}\` ${mysql ? creativeColumnType(table, { name }) : type === 'id' || type === 'key' && table === 'creative_schema' ? 'TEXT' + (name === 'id' ? ' PRIMARY KEY' : '') : ['integer', 'nullable'].includes(type) ? 'INTEGER' : 'TEXT'}${['nullable', 'optional_ref'].includes(type) ? '' : ' NOT NULL'}${table === 'creative_assets' && name === 'archived_at' ? ' DEFAULT 0' : ''}`);
    // The module singleton uses a textual key, while other table IDs are UUIDs.
    if (mysql && table === 'creative_schema') defs[0] += ' PRIMARY KEY';
    defs.push(...creativeConstraints(table));
    return `CREATE TABLE IF NOT EXISTS ${table} (${defs.join(',')})${mysql ? ' ENGINE=InnoDB' : ''}`;
  });
}

// DDL on MySQL commits independently. The marker is advanced last; every step
// can safely resume after interruption. Never drop the old index before adding
// its replacement. Back up all asset data before the first change.
export function migrateCreativeArchive(lib) {
  const db = lib.db, mysql = db.kind === 'mysql';
  const state = db.prepare('SELECT * FROM creative_schema WHERE id=?').get('asset-library');
  if (state && ![1, 2].includes(state.version)) throw Error('不支持的资产库版本');
  if (!state || state.version === 2) return;
  const dir = path.join(lib.dataDir, 'backups'); mkdirSync(dir, { recursive: true });
  const tables = Object.fromEntries(Object.keys(CREATIVE_TABLES).map(t => [t, db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()]));
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
      const sql = creativeSchema(false).find(s => s.startsWith('CREATE TABLE IF NOT EXISTS creative_assets ')).replace('IF NOT EXISTS creative_assets ', 'creative_assets_v2 ');
      db.exec(sql);
      const cols = Object.keys(CREATIVE_TABLES.creative_assets);
      db.exec(`INSERT INTO creative_assets_v2(${cols.join(',')}) SELECT ${cols.map(k => k === 'archived_at' ? 'COALESCE(archived_at,0)' : k).join(',')} FROM creative_assets`);
      db.exec('DROP TABLE creative_assets'); db.exec('ALTER TABLE creative_assets_v2 RENAME TO creative_assets');
    }
    db.prepare('UPDATE creative_schema SET version=2,updated_at=? WHERE id=?').run(Date.now(), 'asset-library');
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
