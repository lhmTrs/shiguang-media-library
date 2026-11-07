export const PROMPT_TABLES={
 prompt_templates:{id:'id',name:'name',description:'text',category:'category',current_version:'integer',revision:'integer',deleted_at:'nullable',created_at:'integer',updated_at:'integer',sort_order:'nullable'},
 prompt_template_versions:{id:'id',template_id:'ref',version:'integer',definition:'text',rollback_of:'nullable',created_at:'integer',updated_at:'integer'},
 prompt_template_drafts:{id:'id',template_id:'ref',version:'integer',revision:'integer',input_values:'text',created_at:'integer',updated_at:'integer'},
 prompt_generations:{id:'id',template_id:'ref',version:'integer',template_snapshot:'text',input_values:'text',prompt:'text',created_at:'integer',updated_at:'integer'},
};
export function promptMysqlColumnType(table,col){const type=PROMPT_TABLES[table]?.[col.name];if(!type)throw Error('未知提示词字段，未迁移');return {id:'VARCHAR(36) PRIMARY KEY',ref:'VARCHAR(36)',name:'VARCHAR(120)',category:'VARCHAR(80)',integer:'BIGINT',nullable:'BIGINT',text:'LONGTEXT'}[type];}
export function promptConstraints(table){if(table==='prompt_template_versions')return ['UNIQUE(template_id,version)'];if(table==='prompt_template_drafts')return ['UNIQUE(template_id)'];if(table==='prompt_generations')return ['INDEX prompt_generations_template(template_id,created_at)'];return [];}
export function promptSchema(mysql){return Object.entries(PROMPT_TABLES).map(([table,columns])=>{
 const defs=Object.entries(columns).map(([name,type])=>`\`${name}\` ${mysql?promptMysqlColumnType(table,{name}):type==='id'?'TEXT PRIMARY KEY':['integer','nullable'].includes(type)?'INTEGER':'TEXT'}${type==='nullable'?'':' NOT NULL'}`);
 const constraints=promptConstraints(table);defs.push(...(mysql?constraints:constraints.filter(c=>!c.startsWith('INDEX'))));
 return `CREATE TABLE IF NOT EXISTS ${table} (${defs.join(',')})${mysql?' ENGINE=InnoDB':''}`;
 });}
