export const SCRIPT_TABLES={project_scripts:{id:'id',title:'text',content:'text',revision:'integer',created_at:'integer',updated_at:'integer'}};
export function scriptColumnType(table,col){const type=SCRIPT_TABLES[table]?.[col.name];if(!type)throw Error('未知剧本字段');return type==='id'?'VARCHAR(36) PRIMARY KEY':type==='integer'?'BIGINT':'LONGTEXT';}
export const scriptConstraints=()=>[];
export function scriptSchema(mysql){return 'CREATE TABLE IF NOT EXISTS project_scripts(id '+(mysql?'VARCHAR(36)':'TEXT')+' PRIMARY KEY,title '+(mysql?'LONGTEXT':'TEXT')+' NOT NULL,content '+(mysql?'LONGTEXT':'TEXT')+' NOT NULL,revision '+(mysql?'BIGINT':'INTEGER')+' NOT NULL,created_at '+(mysql?'BIGINT':'INTEGER')+' NOT NULL,updated_at '+(mysql?'BIGINT':'INTEGER')+' NOT NULL)'+(mysql?' ENGINE=InnoDB':'');}
