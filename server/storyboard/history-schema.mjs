export const HISTORY_TABLES={
 storyboard_versions:{id:'id',document_id:'ref',version:'integer',created_at:'integer',updated_at:'integer',author_kind:'short',reason_category:'nullableShort',reason_text:'text',summary_only:'integer',restored_from:'nullableInteger',changed_shot_count:'integer',byte_size:'integer',document_json:'nullableText',baseline:'integer',request_id:'nullableRef',request_hash:'nullableShort'},
 storyboard_changes:{id:'id',document_id:'ref',version:'integer',target_kind:'short',target_id:'longKey',shot_id:'nullableKey',shot_number_at_time:'nullableInteger',field:'longKey',change_json:'text',created_at:'integer',updated_at:'integer'},
 storyboard_pending:{id:'id',document_id:'ref',version:'integer',target_kind:'short',target_id:'longKey',shot_id:'nullableKey',shot_number_at_time:'nullableInteger',fields_json:'text',deleted:'integer',created_at:'integer',updated_at:'integer',cleared_at:'nullableInteger'},
};
export const historyConstraints=t=>t==='storyboard_versions'?['UNIQUE(document_id,version)','UNIQUE(request_id)']:t==='storyboard_pending'?['UNIQUE(document_id,target_id,version)']:[];
export function historyColumnType(table,col){return {id:'VARCHAR(36) PRIMARY KEY',ref:'VARCHAR(36)',nullableRef:'VARCHAR(36)',integer:'BIGINT',nullableInteger:'BIGINT',short:'VARCHAR(64)',nullableShort:'VARCHAR(64)',longKey:'VARCHAR(320)',nullableKey:'VARCHAR(160)',text:'LONGTEXT',nullableText:'LONGTEXT'}[HISTORY_TABLES[table]?.[col.name]];}
export function historySchema(mysql){return Object.entries(HISTORY_TABLES).map(([t,cols])=>`CREATE TABLE IF NOT EXISTS ${t} (${[...Object.entries(cols).map(([name,type])=>`\`${name}\` ${mysql?historyColumnType(t,{name}):type.includes('Integer')||type==='integer'?'INTEGER':'TEXT'+(name==='id'?' PRIMARY KEY':'')}${type.startsWith('nullable')?'':' NOT NULL'}`),...historyConstraints(t)].join(',')})${mysql?' ENGINE=InnoDB':''}`);}
export function tablePresent(db,table){return !!(db.kind==='mysql'?db.prepare('SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?').get(table):db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));}
export function installHistory(db){
 const counts=Object.keys(HISTORY_TABLES).filter(t=>tablePresent(db,t)).length;
 if(counts&&counts!==3)throw Object.assign(Error('分镜历史表结构不完整，请保留现场'),{code:'STORYBOARD_HISTORY_SCHEMA_UNSUPPORTED',status:503});
 if(!counts)for(const sql of historySchema(db.kind==='mysql'))db.exec(sql);
 for(const [t,cols]of Object.entries(HISTORY_TABLES)){
  const actual=db.kind==='mysql'?db.prepare('SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?').all(t):db.prepare('PRAGMA table_info('+t+')').all();
  if(JSON.stringify(actual.map(c=>c.name).sort())!==JSON.stringify(Object.keys(cols).sort()))throw Object.assign(Error('分镜历史表字段不匹配，未修改已有表'),{code:'STORYBOARD_HISTORY_SCHEMA_UNSUPPORTED',status:503});
  db.prepare(`SELECT ${Object.keys(cols).join(',')} FROM ${t} LIMIT 0`).all();
 }
 return {schema_version:1,tables:3};
}
