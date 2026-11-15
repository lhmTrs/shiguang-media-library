import {createHash} from 'node:crypto';

function lockError(reason, state='failed', cause) {
 const error=Object.assign(Error('成片资料升级暂时不可用'),{
  code:'RENDER_SCHEMA_UPGRADE_LOCK_FAILED',status:503,reason,state,
  details:{renderSchemaUpgrade:{state,reason}},
 });
 if(cause)error.cause=cause;
 return error;
}
function classify(error) {
 if(['ER_LOCK_WAIT_TIMEOUT','ER_LOCK_DEADLOCK','ER_USER_LOCK_DEADLOCK'].includes(error?.code))return lockError('busy','failed',error);
 if(['ER_TABLEACCESS_DENIED_ERROR','ER_DBACCESS_DENIED_ERROR','ER_SPECIFIC_ACCESS_DENIED_ERROR'].includes(error?.code))return lockError('permission_denied','failed',error);
 return lockError('unknown_outcome','needs_review',error);
}
function sameIdentity(a,b){return a.database===b.database&&a.serverUuid===b.serverUuid&&a.connectionId===b.connectionId;}

// GET_LOCK serializes upgrading instances. The explicit WRITE table lock also
// excludes older/non-cooperating writers through this one ADD COLUMN operation.
// Never START TRANSACTION here: it would release LOCK TABLES. Never reconnect.
export async function withRenderMysqlLock(connection, callback, {timeoutMs=3000,windowMs=15000}={}) {
 if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>5000||!Number.isInteger(windowMs)||windowMs<1000||windowMs>30000||typeof callback!=='function')throw lockError('unsupported_schema');
 const identity=()=>connection.get('SELECT DATABASE() AS `database`, @@server_uuid AS serverUuid, CONNECTION_ID() AS connectionId, VERSION() AS serverVersion');
 const original=connection.get('SELECT @@session.autocommit AS autocommit, @@session.lock_wait_timeout AS lockWaitTimeout');
 if(original.autocommit!==1)throw lockError('busy');
 const frozen=Object.freeze(identity());
 if(typeof frozen.database!=='string'||!frozen.database||typeof frozen.serverUuid!=='string'||!Number.isSafeInteger(frozen.connectionId))throw lockError('unsupported_schema');
 // This exact ADD-column lock window has only been qualified on Oracle MySQL
 // 8.2.0. Do not infer identical ALTER lock retention on another server version.
 if(!/^8\.2\.0(?:$|[-+])/.test(frozen.serverVersion))throw lockError('unsupported_schema');
 const name='render-revision:'+createHash('sha256').update(frozen.serverUuid+'\0'+frozen.database).digest('hex').slice(0,48);
 let named=false,tables=false,sessionChanged=false,bodyError,result;
 const assertIdentity=()=>{
  if(!sameIdentity(frozen,identity()))throw lockError('unknown_outcome','needs_review');
  const owner=connection.get('SELECT IS_USED_LOCK(?) AS owner',[name]);
  if(Number(owner.owner)!==frozen.connectionId)throw lockError('unknown_outcome','needs_review');
 };
 let altered=false,windowEnd=Infinity;
 const checkSql=(sql,write)=>{
  // A capability limited to startup inspection and this precise schema change.
  if(Date.now()>windowEnd)throw lockError(altered?'unknown_outcome':'busy',altered?'needs_review':'failed');
  const normalized=String(sql).trim();
  if(write){
   if(altered||!/^ALTER\s+TABLE\s+`?project_renders`?\s+ADD\s+COLUMN\s+`?revision`?\s+BIGINT\s+NOT\s+NULL\s+DEFAULT\s+1(?:\s+COMMENT\s+'render-schema-startup-v2:[0-9a-f]{64}')?\s*;?$/i.test(normalized))throw lockError('unsupported_schema');
   altered=true;
  }else if(!/^(SELECT\s|SHOW\s+CREATE\s+TABLE\s+`?project_renders`?\s*;?$)/i.test(normalized)||/;\s*\S|\b(GET_LOCK|RELEASE_LOCK|RELEASE_ALL_LOCKS|SLEEP|INTO|FOR\s+UPDATE)\b/i.test(normalized))throw lockError('unsupported_schema');
  assertIdentity();
 };
 // Escape requires a closed flag as well as the original connection identity.
 let active=true;
 const scoped=Object.freeze({kind:'mysql',identity:frozen,
  prepare(sql){return Object.freeze({all(...args){if(!active)throw lockError('unknown_outcome','needs_review');checkSql(sql,false);return connection.all(sql,args);},get(...args){if(!active)throw lockError('unknown_outcome','needs_review');checkSql(sql,false);return connection.get(sql,args);},run(){throw lockError('unsupported_schema');}});},
  exec(sql){if(!active)throw lockError('unknown_outcome','needs_review');checkSql(sql,true);connection.exec(sql);return scoped;},
  transaction(){throw lockError('unsupported_schema');},
 });
 try {
  const row=connection.get('SELECT GET_LOCK(?, ?) AS acquired',[name,timeoutMs/1000]);
  if(row.acquired!==1)throw lockError(row.acquired===0?'busy':'unknown_outcome',row.acquired===0?'failed':'needs_review');
  named=true;
  sessionChanged=true;
  connection.exec('SET SESSION lock_wait_timeout='+Math.ceil(timeoutMs/1000));
  connection.exec('SET autocommit=0');
  connection.exec('LOCK TABLES project_renders WRITE');tables=true;
  assertIdentity();windowEnd=Date.now()+windowMs;
  result=await callback(scoped);
  assertIdentity();
 }catch(error){bodyError=error.code==='RENDER_SCHEMA_UPGRADE_LOCK_FAILED'?error:(tables?error:classify(error));}
 finally {
  active=false;
  try {
   // No blind retry after any connection/DDL error. Revalidate on the original
   // connection before releasing its own locks. Pending evidence is caller-owned.
   if(named){assertIdentity();}
   if(tables){connection.exec('COMMIT');connection.exec('UNLOCK TABLES');}
   if(sessionChanged){connection.exec('SET autocommit='+original.autocommit);connection.exec('SET SESSION lock_wait_timeout='+original.lockWaitTimeout);}
   if(named){const row=connection.get('SELECT RELEASE_LOCK(?) AS released',[name]);if(row.released!==1)throw lockError('unknown_outcome','needs_review');}
  }catch(error){
   const cleanup=lockError('unknown_outcome','needs_review',error);
   cleanup.renderUpgradeCleanupUnknown=true;
   cleanup.originalError=bodyError;
   bodyError=cleanup;
  }
 }
 if(bodyError)throw bodyError;
 return result;
}
