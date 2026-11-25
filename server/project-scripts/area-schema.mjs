export const AREA_TABLES={
 script_area_state:{id:'id',payload:'text'},
 script_sources:{id:'id',project_id:'key',kind:'key',version_no:'integer',payload:'text'},
 script_materials:{id:'id',owner_type:'key',owner_id:'key',payload:'text'},
 script_maps:{id:'id',project_id:'key',payload:'text'},
 script_requests:{id:'id',project_id:'key',payload:'text'}
};
export const areaType=t=>t==='id'?'VARCHAR(36) PRIMARY KEY':t==='key'?'VARCHAR(80)':t==='integer'?'BIGINT':'LONGTEXT';
export function ensureAreaSchema(db){for(const [t,cols] of Object.entries(AREA_TABLES))db.exec(`CREATE TABLE IF NOT EXISTS ${t}(${Object.entries(cols).map(([c,k])=>`${c} ${db.kind==='mysql'?areaType(k):k==='integer'?'INTEGER':k==='id'?'TEXT PRIMARY KEY':'TEXT'}${k!=='id'&&c!=='version_no'?' NOT NULL':''}`).join(',')})${db.kind==='mysql'?' ENGINE=InnoDB':''}`);
 const index=db.kind==='mysql'?db.prepare('SELECT INDEX_NAME name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?').get('script_sources','script_sources_version'):db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get('script_sources_version');
 if(!index)db.exec('CREATE UNIQUE INDEX script_sources_version ON script_sources(project_id,version_no)');
}
