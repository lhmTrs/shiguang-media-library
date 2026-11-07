export const TABLES={
 sb_rule_categories:{id:'id',name:'short',parent_id:'refNull',created_at:'integer',updated_at:'integer'},
 sb_rules:{id:'id',name:'short',use_kind:'short',source:'short',category_id:'refNull',favorite:'integer',current_version:'integer',deleted_at:'nullable',last_used:'nullable',created_at:'integer',updated_at:'integer'},
 sb_rule_versions:{id:'id',rule_id:'ref',version:'integer',revision:'short',package_json:'text',content_hash:'short',created_at:'integer',updated_at:'integer',source:'short'},
 sb_generation_presets:{id:'id',name:'short',project_id:'refNull',config_json:'text',created_at:'integer',updated_at:'integer'},
 sb_generation_tasks:{id:'id',project_id:'ref',input_hash:'short',snapshot_json:'text',status:'short',phase:'short',error_code:'short',error_json:'text',result_json:'text',output_text:'text',expected_revision:'nullable',lock_generation:'integer',deadline_at:'integer',resource_state:'short',created_at:'integer',updated_at:'integer',model:'short',effort:'short',project_name:'short'},
 sb_generation_locks:{id:'id',owner_task_id:'refNull',generation:'integer',created_at:'integer',updated_at:'integer'}
};
export function generationSchema(mysql){return Object.entries(TABLES).map(([table,fields])=>{const columns=Object.entries(fields).map(([name,t])=>`\`${name}\` ${mysql?({id:'VARCHAR(36) PRIMARY KEY',ref:'VARCHAR(36)',refNull:'VARCHAR(36)',short:'VARCHAR(200)',text:'LONGTEXT',integer:'BIGINT',nullable:'BIGINT'})[t]:['integer','nullable'].includes(t)?'INTEGER':t==='id'?'TEXT PRIMARY KEY':'TEXT'}${['nullable','refNull'].includes(t)?'':' NOT NULL'}`);if(table==='sb_rule_versions')columns.push('UNIQUE(rule_id,version)');return `CREATE TABLE IF NOT EXISTS ${table} (${columns.join(',')})${mysql?' ENGINE=InnoDB':''}`;});}
export function generationColumnType(table,col){const kind=TABLES[table]?.[col.name];if(!kind)throw Error('未知分镜生成字段');return({id:'VARCHAR(36) PRIMARY KEY',ref:'VARCHAR(36)',refNull:'VARCHAR(36)',short:'VARCHAR(200)',text:'LONGTEXT',integer:'BIGINT',nullable:'BIGINT'})[kind];}
export const generationConstraints=table=>table==='sb_rule_versions'?['UNIQUE(rule_id,version)']:[];
