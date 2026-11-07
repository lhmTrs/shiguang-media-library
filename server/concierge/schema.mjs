// Operational bindings and request receipts only. Codex owns the conversation history.
export const CONCIERGE_TABLES = {
  concierge_scopes: {scope:'key',thread_id:'short',phase:'short',error:'text',created_at:'integer',updated_at:'integer'},
  concierge_rules: {scope:'key',content:'text',revision:'integer',created_at:'integer',updated_at:'integer'},
  concierge_tasks: {id:'id',scope:'ref',thread_id:'short',turn_id:'short',request_hash:'hash',status:'short',model:'short',effort:'short',attachment_ids:'text',allow_writes:'integer',rule_hash:'hash',error:'text',created_at:'integer',updated_at:'integer'},
};
export function conciergeColumnType(table,{name}) {
  const type=CONCIERGE_TABLES[table]?.[name];
  if(!type)throw Error('未知管家存储列');
  return {key:'VARCHAR(64) PRIMARY KEY',id:'VARCHAR(36) PRIMARY KEY',ref:'VARCHAR(64)',short:'VARCHAR(200)',text:'LONGTEXT',integer:'BIGINT',hash:'CHAR(64)'}[type];
}
export function conciergeSchema(mysql){return Object.entries(CONCIERGE_TABLES).map(([table,cols])=>`CREATE TABLE IF NOT EXISTS ${table} (${Object.entries(cols).map(([name,type])=>`\`${name}\` ${mysql?conciergeColumnType(table,{name}):['key','id'].includes(type)?'TEXT PRIMARY KEY':type==='integer'?'INTEGER':'TEXT'} NOT NULL`).join(',')})${mysql?' ENGINE=InnoDB':''}`);}
