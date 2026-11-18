import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {VIDEO_TABLES} from '../storyboard-video/schema.mjs';
import {idOK} from '../project-assets/model.mjs';
import {hash,canonical,fail} from './model.mjs';
export const LEGACY_BINDING_TABLES=['storyboard_video_takes','storyboard_video_plans','storyboard_video_requests'];
const decode=JSON.parse;
export const videoV2Migration={
 legacyRows(){return Object.fromEntries(LEGACY_BINDING_TABLES.map(table=>[table,this.db.prepare('SELECT * FROM '+table+' ORDER BY id').all()]));},
 migrationPreview(){const tables=this.legacyRows(),counts=Object.fromEntries(Object.entries(tables).map(([k,v])=>[k,v.length]));return {instanceId:this.instanceId,migration:this.schemaState(),counts,rowsHash:hash(tables),deletes:[...LEGACY_BINDING_TABLES],preserves:['storyboard_video_sources','storyboard_video_approvals','project_video_records','project_video_imports','all-original-files']};},
 validateLegacyExport(input){
  if(!input||input.format!=='shiguang-legacy-video-binding-export'||input.schemaVersion!==1||input.instanceId!==this.instanceId||canonical(Object.keys(input.tables??{}).sort())!==canonical([...LEGACY_BINDING_TABLES].sort()))fail('VIDEO_V2_INVALID_INPUT','旧绑定导出身份或格式无效');
  const {checksum,...body}=input;if(checksum!==hash(body))fail('VIDEO_V2_INVALID_INPUT','旧绑定导出摘要无效');
  const maps={};for(const table of LEGACY_BINDING_TABLES){const data=input.tables[table];if(!Array.isArray(data)||data.length!==input.counts?.[table])fail('VIDEO_V2_INVALID_INPUT','旧绑定导出计数无效');const entries=new Map();maps[table]=entries;
   for(const row of data){if(!row||!idOK(row.id)||entries.has(row.id)||canonical(Object.keys(row).sort())!==canonical(Object.keys(VIDEO_TABLES[table]).sort()))fail('VIDEO_V2_INVALID_INPUT','旧绑定导出行结构无效');for(const [key,type]of Object.entries(VIDEO_TABLES[table]))if(type==='integer'?(!Number.isSafeInteger(row[key])||row[key]<0):typeof row[key]!=='string')fail('VIDEO_V2_INVALID_INPUT','旧绑定导出字段类型无效');
    const projectId=table==='storyboard_video_plans'?row.id:row.project_id,head=this.board.head(projectId);if(!head||head.id!==row.document_id||row.initialized_at>head.initialized_at)fail('VIDEO_V2_INVALID_INPUT','旧绑定导出文档引用无效');
    try{decode(row.data_json);}catch{fail('VIDEO_V2_INVALID_INPUT','旧绑定导出JSON损坏');}entries.set(row.id,row);
   }
  }
  for(const row of maps.storyboard_video_takes.values()){const value=decode(row.data_json);if(!Array.isArray(value.segments))fail('VIDEO_V2_INVALID_INPUT','旧片段结构无效');for(const segment of value.segments){const source=this.videos.source(row.project_id,segment.sourceId);if(!Number.isSafeInteger(segment.inMs)||segment.inMs<0||!Number.isSafeInteger(segment.outMs)||segment.outMs<=segment.inMs||segment.outMs>source.durationMs)fail('VIDEO_V2_INVALID_INPUT','旧片段来源或时间引用无效');}}
  const take=(id,projectId,documentId,initializedAt,shotId=null)=>{const row=maps.storyboard_video_takes.get(id);if(!row||row.project_id!==projectId||row.document_id!==documentId||row.initialized_at!==initializedAt||shotId!==null&&row.shot_id!==shotId)fail('VIDEO_V2_INVALID_INPUT','旧采用/回执跨来源引用无效');};
  for(const row of maps.storyboard_video_plans.values())for(const [shotId,id]of Object.entries(decode(row.data_json).adopted??{}))take(id,row.id,row.document_id,row.initialized_at,shotId);
  for(const row of maps.storyboard_video_requests.values()){const data=decode(row.data_json);if(data.receipt?.requestId!==row.id||!Array.isArray(data.receipt.takeIds)||!Array.isArray(data.receipt.adoptedShotIds)||data.receipt.takeIds.length!==data.receipt.adoptedShotIds.length)fail('VIDEO_V2_INVALID_INPUT','旧回执身份无效');for(const [i,id]of data.receipt.takeIds.entries())take(id,row.project_id,row.document_id,row.initialized_at,data.receipt.adoptedShotIds[i]);for(const [shotId,id]of Object.entries(data.before??{}))take(id,row.project_id,row.document_id,row.initialized_at,shotId);for(const id of data.receipt.sourceIds??[])this.videos.source(row.project_id,id);}
  return input;
 },
 async exportLegacy(directory){
  const body=this.assets.tx(()=>{this.assets.lockDirectory();const tables=this.legacyRows();return {format:'shiguang-legacy-video-binding-export',schemaVersion:1,instanceId:this.instanceId,createdAt:Date.now(),tables,counts:Object.fromEntries(Object.entries(tables).map(([k,v])=>[k,v.length]))};});
  const output={...body,checksum:hash(body)};this.validateLegacyExport(output);
  directory=path.resolve(directory);await fs.mkdir(directory,{recursive:true,mode:0o700});const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||(process.getuid&&stat.uid!==process.getuid())||(stat.mode&0o077))fail('VIDEO_V2_INVALID_INPUT','导出目录须为当前用户私有的真实目录');if(await fs.realpath(directory)!==directory)fail('VIDEO_V2_INVALID_INPUT','导出目录不能经过符号链接');
  const file=path.join(directory,'legacy-video-binding-'+randomUUID()+'.json'),handle=await fs.open(file,'wx',0o600);try{await handle.writeFile(canonical(output));await handle.sync();}finally{await handle.close();}
  const readback=decode(await fs.readFile(file,'utf8'));this.validateLegacyExport(readback);if(readback.checksum!==output.checksum)fail('VIDEO_V2_UNSETTLED','旧绑定私有导出读回未通过',503);
  return {file,checksum:output.checksum,counts:output.counts};
 },
 checkMigration(input){this.validateLegacyExport(input);const preview=this.migrationPreview();return {...preview,exportHash:input.checksum,exportMatches:preview.rowsHash===hash(input.tables)};},
 migrationMutation(action,input,{requestId}){
  const db=this.db,instanceId=this.instanceId;this.assertUpgradeActive(db,instanceId);this.requireSchema();this.validateLegacyExport(input);if(!idOK(requestId))fail('VIDEO_V2_INVALID_INPUT','迁移操作须保留有效requestId');
  return this.assets.tx(()=>{
   this.assets.lockDirectory();this.assertUpgradeActive(db,instanceId);this.stateRow('global',true);this.validateLegacyExport(input);const request={requestId,exportHash:input.checksum},operation='migration-'+action,scope='library';const repeated=this.replay(operation,scope,request);if(repeated)return repeated;
   const marker=this.stateRow('migration',true),state=decode(marker.data_json),current=this.legacyRows();
   if(action==='execute'){
    if(state.status==='complete'&&state.exportHash===input.checksum)return this.commitMigrationReceipt(operation,request,{status:'complete',counts:input.counts,exportHash:input.checksum,repeated:true});
    if(state.status!=='pending'||canonical(current)!==canonical(input.tables))fail('VIDEO_BINDING_CONFLICT','旧行或迁移阶段已变化，未删除',409);
    for(const table of LEGACY_BINDING_TABLES)for(const row of input.tables[table]){const result=this.db.prepare('DELETE FROM '+table+' WHERE id=?').run(row.id);if(result.changes!==1)fail('VIDEO_BINDING_CONFLICT','旧行删除数量变化，事务已回滚',409);}
   }else if(action==='restore'){
    if(state.status==='pending'&&state.restoredExportHash===input.checksum&&canonical(current)===canonical(input.tables))return this.commitMigrationReceipt(operation,request,{status:'pending',restored:true,exportHash:input.checksum,repeated:true});
    if(state.status!=='complete'||state.exportHash!==input.checksum||Object.values(current).some(rows=>rows.length))fail('VIDEO_BINDING_CONFLICT','旧表或迁移状态不满足精确恢复条件',409);
    for(const table of LEGACY_BINDING_TABLES){const fields=Object.keys(VIDEO_TABLES[table]);for(const row of input.tables[table])this.db.prepare(`INSERT INTO ${table}(${fields.join(',')}) VALUES(${fields.map(()=>'?')})`).run(...fields.map(k=>row[k]));}
   }else fail('VIDEO_V2_INVALID_INPUT','迁移操作无效');
   const data={schemaVersion:1,status:action==='execute'?'complete':'pending',instanceId:this.instanceId,exportHash:input.checksum,counts:input.counts,...(action==='restore'?{restoredExportHash:input.checksum}:{})};
   this.db.prepare('UPDATE storyboard_video_v2_state SET data_json=?,revision=?,updated_at=? WHERE id=?').run(canonical(data),marker.revision+1,Date.now(),'migration');
   return this.commitMigrationReceipt(operation,request,{status:data.status,counts:input.counts,exportHash:input.checksum,...(action==='restore'?{restored:true}:{})});
  });
 },
 commitMigrationReceipt(operation,request,result){const output={...result,requestId:request.requestId,repeated:result.repeated??false},now=Date.now();this.insert('storyboard_video_v2_requests',{id:request.requestId,operation,scope:'library',request_hash:hash(request),status:'committed',result_json:canonical(output),created_at:now,updated_at:now});return output;},
 executeMigration(input,options){return this.migrationMutation('execute',input,options);},
 restoreLegacy(input,options){return this.migrationMutation('restore',input,options);}
};
