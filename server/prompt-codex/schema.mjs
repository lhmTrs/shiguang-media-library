export const CODEX_TABLES = {
  codex_conversations: {
    id: 'id', template_id: 'ref', title: 'text', context_json: 'text', revision: 'integer',
    deleted_at: 'nullable', created_at: 'integer', updated_at: 'integer',
  },
  codex_turns: {
    id: 'id', conversation_id: 'ref', sequence_no: 'integer', request_json: 'text',
    actual_json: 'text', blocks_json: 'text', usage_json: 'text', status: 'short',
    error_code: 'short', created_at: 'integer', updated_at: 'integer',
  },
  codex_attachments: {
    id: 'id', turn_id: 'ref', file_name: 'short', sha256: 'hash', mime: 'short', bytes: 'integer',
    created_at: 'integer', updated_at: 'integer',
  },
};
export function codexColumnType(table, {name}) {
  const kind = CODEX_TABLES[table]?.[name];
  if (!kind) throw Error('未知 Codex 存储列');
  return {id:'VARCHAR(36) PRIMARY KEY',ref:'VARCHAR(36)',text:'LONGTEXT',integer:'BIGINT',nullable:'BIGINT',short:'VARCHAR(100)',hash:'CHAR(64)'}[kind];
}
export function codexConstraints(table, mysql = true) {
  if (table === 'codex_turns') return ['UNIQUE(conversation_id,sequence_no)'];
  if (mysql && table === 'codex_attachments') return ['INDEX codex_attachment_turn(turn_id)'];
  return [];
}
export function codexSchema(mysql) {
  return Object.entries(CODEX_TABLES).map(([table, columns]) => {
    const defs = Object.entries(columns).map(([name,kind]) => `\`${name}\` ${mysql ? codexColumnType(table,{name}) : kind==='id'?'TEXT PRIMARY KEY':['integer','nullable'].includes(kind)?'INTEGER':'TEXT'}${kind==='nullable'?'':' NOT NULL'}`);
    return `CREATE TABLE IF NOT EXISTS ${table} (${[...defs,...codexConstraints(table,mysql)].join(',')})${mysql?' ENGINE=InnoDB':''}`;
  });
}
