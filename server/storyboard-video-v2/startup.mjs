import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {hash,fail} from './model.mjs';
import {SCHEMA_VERSION} from './schema.mjs';
import {privateDirectory,readPrivateJson,writePrivateJson,validateUpgradePolicy,acquireUpgradeFileLock,syncDirectory} from './upgrade-files.mjs';
const safeCode=e=>/^VIDEO_V2_UPGRADE_[A-Z_]+$/.test(e?.code??'')?e.code:'VIDEO_V2_UPGRADE_FAILED';
export const videoV2Startup={
 migrationStatus(){
  let stored;try{stored=this.schemaState();}catch{stored={schemaVersion:SCHEMA_VERSION,status:'unknown'};}
  let status=stored.schemaVersion===SCHEMA_VERSION?stored.status:'unknown',phase=status==='complete'?'complete':'not-started',reasonCode=status==='complete'?null:'VIDEO_V2_MIGRATION_REQUIRED';
  try{if(status==='complete'&&(!this.stateRow('global')||JSON.parse(this.stateRow('global').data_json).schemaVersion!==SCHEMA_VERSION)){status='unknown';reasonCode='VIDEO_V2_UNSETTLED';phase='not-started';}if(status==='complete'&&JSON.parse(this.stateRow('migration').data_json).instanceId!==this.instanceId){status='pending';reasonCode='VIDEO_V2_UPGRADE_INSTANCE_CHANGED';phase='not-started';}}catch{status='unknown';reasonCode='VIDEO_V2_UNSETTLED';}
  const runtime=this.upgradeRuntime;if(runtime?.db===this.db&&runtime.instanceId===this.instanceId&&runtime.status!=='complete'&&!(status==='complete'&&runtime.reasonCode==='VIDEO_V2_UPGRADE_BUSY'))({status,phase,reasonCode}=runtime);
  const known=status==='complete'&&stored.schemaVersion===SCHEMA_VERSION;
  return {...stored,status,phase,reasonCode,writeAllowed:known,adoptionKnown:known,historyPrune:known?'active':'paused'};
 },
 assertUpgradeActive(db=this.db,instanceId=this.instanceId){
  if(this.closing||this.videos.media.closing)fail('VIDEO_V2_UPGRADE_STOPPED','升级正常停止，保留阶段回执',503);
  if(this.db!==db||this.instanceId!==instanceId||this.lib.migrating)fail('VIDEO_V2_UPGRADE_INSTANCE_CHANGED','升级期间库实例或提供方变化，未执行迁移',503);
 },
 upgradeCheckpoint(){this.assertUpgradeActive();},
 async startup(){
  if(this.upgradeWork)return this.upgradeWork;
  this.upgradeWork=this.videos.media.track(()=>this.runStartupUpgrade()).then(()=>this.migrationStatus());
  try{await this.upgradeWork;return this.migrationStatus();}finally{this.upgradeWork=null;}
 },
 beginClose(){this.closing=true;},
 async closeStartup(){this.beginClose();await this.upgradeWork;},
 async runStartupUpgrade(){
  const instanceId=this.instanceId,db=this.db;let directory,journalFile,journal,release,advisory=false,commitAttempted=false;
  const runtime=(status,phase,reasonCode=null)=>{this.upgradeRuntime={db,instanceId,status,phase,reasonCode};};
  runtime('pending','not-started');
  try{
   if(typeof instanceId!=='string'||!instanceId.trim()||instanceId.length>160||instanceId.includes('\0'))fail('VIDEO_V2_UPGRADE_INSTANCE_INVALID','库实例无法核验',503);
   const root=await fs.realpath(this.lib.dataDir),candidate=path.join(root,'video-binding-v2');
   // Policy is read before schema installation or export. No port/host heuristic.
   let policy=null;try{await fs.lstat(candidate);await privateDirectory(candidate);policy=await readPrivateJson(path.join(candidate,'upgrade-policy.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
   if(policy)validateUpgradePolicy(policy,instanceId);
   if(policy?.mode==='defer'){runtime('deferred','deferred','VIDEO_V2_UPGRADE_DEFERRED');return this.migrationStatus();}
   directory=await privateDirectory(candidate);release=await acquireUpgradeFileLock(directory,instanceId);
   if(!release){runtime('pending','not-started','VIDEO_V2_UPGRADE_BUSY');return this.migrationStatus();}
   if(db.kind==='mysql'){
    const row=db.prepare('SELECT GET_LOCK(?,0) acquired').get('video-v2-upgrade:'+hash(instanceId).slice(0,40));
    if(Number(row?.acquired)!==1){runtime('pending','not-started','VIDEO_V2_UPGRADE_BUSY');return this.migrationStatus();}advisory=true;
   }
   journalFile=path.join(directory,'startup-'+hash(instanceId)+'.json');journal=await readPrivateJson(journalFile);
   if(journal&&(journal.format!=='shiguang-video-v2-upgrade-journal'||journal.schemaVersion!==SCHEMA_VERSION||journal.instanceId!==instanceId||typeof journal.requestId!=='string'||!['pending','failed','deferred','complete'].includes(journal.status)||!['schema','export','check','delete','complete'].includes(journal.phase)||journal.exportFile!==null&&(!/^legacy-video-binding-[a-f0-9-]+\.json$/.test(journal.exportFile))))fail('VIDEO_V2_UPGRADE_JOURNAL_INVALID','升级阶段回执无法核验',503);
   if(this.schemaState().status==='complete'&&JSON.parse(this.stateRow('migration').data_json).instanceId===instanceId){
    this.checkedDb=null;this.requireSchema();if(this.schemaState().schemaVersion!==SCHEMA_VERSION)fail('VIDEO_V2_UPGRADE_JOURNAL_INVALID','迁移版本无法核验',503);
    if(Object.values(this.legacyRows()).some(rows=>rows.length))fail('VIDEO_V2_UPGRADE_MARKER_CONFLICT','已完成标记与旧行不一致，未静默删除',503);
    const marker=JSON.parse(this.stateRow('migration').data_json),receipt=journal?this.db.prepare('SELECT * FROM storyboard_video_v2_requests WHERE id=?').get(journal.requestId):null;
    if(journal&&journal.status!=='complete'&&receipt?.status==='committed'&&receipt.operation==='migration-execute'&&marker.exportHash===journal.exportHash)await writePrivateJson(journalFile,{...journal,status:'complete',phase:'complete',reasonCode:null});
    runtime('complete','complete');return this.migrationStatus();
   }
   if(journal&&this.schemaState().status!=='schema-required'&&this.db.prepare('SELECT status FROM storyboard_video_v2_requests WHERE id=?').get(journal.requestId)?.status==='committed')fail('VIDEO_V2_UPGRADE_RESTORED','旧行在已完成升级后重新恢复，保留现场等待明确维护',503);
   journal??={format:'shiguang-video-v2-upgrade-journal',schemaVersion:SCHEMA_VERSION,instanceId,requestId:randomUUID(),status:'pending',phase:'schema',exportFile:null,exportHash:null};
   const stage=async phase=>{journal={...journal,status:'pending',phase,reasonCode:null};runtime('pending',phase);await writePrivateJson(journalFile,journal);await this.upgradeCheckpoint(phase);const currentPolicy=await readPrivateJson(path.join(directory,'upgrade-policy.json'));this.assertUpgradeActive(db,instanceId);if(currentPolicy)validateUpgradePolicy(currentPolicy,instanceId);if(currentPolicy?.mode==='defer')fail('VIDEO_V2_UPGRADE_DEFERRED','升级已按实例策略暂缓，旧行保留',503);};
   await stage('schema');this.installSchema();this.requireSchema();
   this.assets.tx(()=>{this.assets.lockDirectory();const marker=this.stateRow('migration',true),data=JSON.parse(marker.data_json);if(data.schemaVersion!==SCHEMA_VERSION||!['pending','complete'].includes(data.status))fail('VIDEO_V2_UPGRADE_JOURNAL_INVALID','迁移标记无法核验',503);if(data.instanceId!==instanceId){this.db.prepare('UPDATE storyboard_video_v2_state SET data_json=?,revision=?,updated_at=? WHERE id=?').run(JSON.stringify({...data,status:'pending',instanceId}),marker.revision+1,Date.now(),'migration');}});
   if(!journal.exportFile){await stage('export');const exported=await this.exportLegacy(directory);await syncDirectory(directory);journal={...journal,exportFile:path.basename(exported.file),exportHash:exported.checksum};await writePrivateJson(journalFile,journal);}
   await stage('check');const exported=await readPrivateJson(path.join(directory,journal.exportFile));if(!exported||exported.checksum!==journal.exportHash)fail('VIDEO_V2_UPGRADE_EXPORT_INVALID','原私有导出无法读回核验',503);const checked=this.checkMigration(exported);if(!checked.exportMatches)fail('VIDEO_V2_UPGRADE_EXPORT_STALE','旧行在导出后变化，未删除，请保留现场核对',503);
   await stage('delete');this.assertUpgradeActive(db,instanceId);commitAttempted=true;this.executeMigration(exported,{requestId:journal.requestId});
   journal={...journal,status:'complete',phase:'complete',reasonCode:null};await writePrivateJson(journalFile,journal);runtime('complete','complete');return this.migrationStatus();
  }catch(error){
   // A lost journal/commit ACK cannot turn a durable complete transaction into failure.
   try{if(commitAttempted&&this.schemaState().status==='complete'&&JSON.parse(this.stateRow('migration').data_json).instanceId===instanceId){if(journal&&journalFile)try{await writePrivateJson(journalFile,{...journal,status:'complete',phase:'complete',reasonCode:null});}catch{}runtime('complete','complete');return this.migrationStatus();}}catch{}
   const code=safeCode(error),phase=this.upgradeRuntime?.phase??'not-started',status=code==='VIDEO_V2_UPGRADE_DEFERRED'?'deferred':'failed';runtime(status,status==='deferred'?'deferred':phase,code);
   if(journal&&journalFile)try{await writePrivateJson(journalFile,{...journal,status,reasonCode:code});}catch{}
   return this.migrationStatus();
  }finally{
   try{if(advisory)db.prepare('SELECT RELEASE_LOCK(?) released').get('video-v2-upgrade:'+hash(instanceId).slice(0,40));await release?.();}catch{runtime('failed',this.upgradeRuntime?.phase??'not-started','VIDEO_V2_UPGRADE_LOCK_UNKNOWN');}
  }
 }
};
