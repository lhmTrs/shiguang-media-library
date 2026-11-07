export const STORYBOARD_TABLES = {
  storyboard_schema: { id: 'key', version: 'integer', created_at: 'integer', updated_at: 'integer' },
  storyboard_documents: { id: 'id', project_id: 'ref', title: 'name', document_json: 'text', revision: 'integer', initialized_at: 'integer', source_filename: 'text', source_hash: 'key', created_at: 'integer', updated_at: 'integer' },
  storyboard_asset_links: { id: 'id', document_id: 'ref', asset_id: 'ref', created_at: 'integer', updated_at: 'integer' },
  storyboard_import_requests: { id: 'id', project_id: 'ref', document_id: 'ref', request_hash: 'key', source_hash: 'key', expected_revision: 'nullable', result_json: 'text', created_at: 'integer', updated_at: 'integer' },
};
export const storyboardConstraints = table => table === 'storyboard_documents' ? ['UNIQUE(project_id)'] : table === 'storyboard_asset_links' ? ['UNIQUE(document_id,asset_id)', 'INDEX storyboard_link_asset(asset_id,document_id)'] : [];
export function storyboardColumnType(table, col) {
  const type = STORYBOARD_TABLES[table]?.[col.name];
  if (!type) throw Error('未知分镜数据库字段');
  return {id:'VARCHAR(36) PRIMARY KEY',ref:'VARCHAR(36)',key:'VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin',integer:'BIGINT',nullable:'BIGINT',text:'LONGTEXT',name:'VARCHAR(1000)'}[type] + (table === 'storyboard_schema' && col.name === 'id' ? ' PRIMARY KEY' : '');
}
export function storyboardSchema(mysql) {
  return Object.entries(STORYBOARD_TABLES).map(([table, columns]) => {
    const defs = Object.entries(columns).map(([name,type]) => `\`${name}\` ${mysql ? storyboardColumnType(table,{name}) : ['integer','nullable'].includes(type) ? 'INTEGER' : 'TEXT' + (name === 'id' ? ' PRIMARY KEY' : '')}${type === 'nullable' ? '' : ' NOT NULL'}`);
    defs.push(...storyboardConstraints(table).filter(s => mysql || !s.startsWith('INDEX')));
    return `CREATE TABLE IF NOT EXISTS ${table} (${defs.join(',')})${mysql ? ' ENGINE=InnoDB' : ''}`;
  });
}
