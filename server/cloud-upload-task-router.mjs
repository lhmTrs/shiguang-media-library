import express from 'express';
import { LIMITS, identity, sameIdentity, namespace, clone, exact, id, hash, integer, text, segment, target, availabilityProjection, fail } from './cloud-upload-protocol.mjs';
import { normalizeScopeVector } from './cloud-upload-scope-binding.mjs';

export const CLOUD_UPLOAD_TASK_BASE = '/api/cloud-upload-tasks';
const BATCH_STATES = new Set(['DRAFT','PREPARING_PREVIEW','READY','QUEUED','RUNNING','WAITING_APPROVAL','PAUSED','STOPPING','NEEDS_ATTENTION','COMPLETED','COMPLETED_WITH_ISSUES','STOPPED']);
const ITEM_STATES = new Set(['QUEUED','HASHING','HASHED','REQUESTING','WAITING_APPROVAL','READY','CHECKING_REUSE','PROVING_POSSESSION','REUSE_COMMITTING','PREPARING','UPLOADING','RECONCILING','RETRY_WAIT','NEEDS_CONFIRMATION','COMMITTED','SKIPPED','FAILED','CANCELLED']);
const U = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', H = '[a-f0-9]{64}';
const ROUTES = [
    ['GET', /^\/scope-roots$/, 'scope-roots', ['cursor','limit','maxBytes']],
    ['GET', /^\/scope-categories$/, 'scope-categories', ['rootIds','cursor','limit','maxBytes']],
    ['POST', /^\/scope-bindings$/, 'scope-binding', []],
    ['POST', /^\/previews$/, 'preview-create', []],
    ['GET', new RegExp(`^/previews/by-command/(${U})$`), 'preview-resolve', []],
    ['GET', new RegExp(`^/previews/(${U})$`), 'preview', []],
    ['GET', new RegExp(`^/previews/(${U})/items$`), 'preview-items', ['cursor','limit','scanBudget','filter']],
    ['GET', new RegExp(`^/previews/(${U})/groups/(${H})$`), 'preview-group', ['representativeAssetId']],
    ['POST', new RegExp(`^/previews/(${U})/selection$`), 'selection', []],
    ['POST', /^\/batches$/, 'batch-create', []],
    ['GET', /^\/batches$/, 'batches', ['after','limit','state']],
    ['GET', new RegExp(`^/batches/(${U})$`), 'batch', []],
    ['GET', new RegExp(`^/batches/(${U})/items$`), 'items', ['after','limit']],
    ['GET', new RegExp(`^/batches/(${U})/summary$`), 'summary', []],
    ['POST', new RegExp(`^/batches/(${U})/commands$`), 'command', []],
    ['POST', new RegExp(`^/batches/(${U})/items/(${U})/retry$`), 'retry', []],
    ['GET', new RegExp(`^/batches/(${U})/items/(${U})/retry-qualification$`), 'retry-qualification', ['itemVersion']],
];
const required = (v, keys) => { exact(v, keys); if (Object.keys(v).length !== keys.length) fail('INVALID_REQUEST',400); return v; };
const bool = v => { if (typeof v !== 'boolean') fail('INVALID_REQUEST',400); return v; };
const array = (v, max=100) => { if (!Array.isArray(v) || v.length>max) fail('INVALID_REQUEST',400); return v; };
const code = v => typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(v) ? v : 'OPERATION_ERROR';
const nullableId = v => v === null ? null : id(v);
const mode = v => { if (!['uploaded','reused','already_present','legacy_unrecorded'].includes(v)) fail('DTO_INVALID',503); return v; };

// Bounded recursive JSON parser: decoded duplicate keys are rejected before any object is bound.
export function strictJson(raw) {
    let i=0, nodes=0;
    const bad=()=>fail('INVALID_JSON',400), ws=()=>{ while (/[ \t\r\n]/.test(raw[i] || '\0')) i++; };
    const string=()=>{ const start=i++; while (i<raw.length) { const ch=raw[i++]; if (ch==='\\') { i++; continue; } if (ch==='"') { try { return JSON.parse(raw.slice(start,i)); } catch { bad(); } } } bad(); };
    const value=depth=>{
        if (depth>16 || ++nodes>20000) bad(); ws(); const ch=raw[i];
        if (ch==='"') return string();
        if (ch==='{' || ch==='[') {
            const object=ch==='{', out=object?Object.create(null):[], seen=new Set(), end=object?'}':']'; i++; ws(); if(raw[i]===end){i++;return out;}
            for (;;) { ws(); let key; if(object){if(raw[i]!=='"')bad();key=string();if(seen.has(key))bad();seen.add(key);ws();if(raw[i++]!==':')bad();} const next=value(depth+1);if(object)out[key]=next;else out.push(next);ws();if(raw[i]===end){i++;return out;}if(raw[i++]!==',')bad(); }
        }
        const token=/^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(raw.slice(i));if(!token)bad();i+=token[0].length;return JSON.parse(token[0]);
    };
    let result;try{result=value(0);ws();if(i!==raw.length)bad();}catch(e){if(e?.code)throw e;bad();}return result;
}
function inputFor(action, v) {
    if(action==='preview-create') {
        if(!Object.hasOwn(v,'scopeBinding'))fail('SCOPE_BINDING_REQUIRED');
        required(v,['clientCommandId','scopes','target','categoryOverride','scopeBinding']);required(v.scopeBinding,['schema','token']);
        if(v.scopeBinding.schema!=='scope-binding-v1'||typeof v.scopeBinding.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(v.scopeBinding.token))fail('INVALID_REQUEST',400);
        id(v.clientCommandId);array(v.scopes,32);if(!v.scopes.length)fail('INVALID_REQUEST',400);
        for(const scope of v.scopes){required(scope,['rootId','category','subcategory']);id(scope.rootId);for(const k of ['category','subcategory'])if(scope[k]!==null)segment(scope[k]);if(scope.category===null && scope.subcategory!==null)fail('INVALID_REQUEST',400);}
        target(v.target);if(v.categoryOverride!==null){required(v.categoryOverride,['category','subcategory']);segment(v.categoryOverride.category);segment(v.categoryOverride.subcategory);if(!v.categoryOverride.category && v.categoryOverride.subcategory)fail('INVALID_REQUEST',400);}
    } else if(action==='scope-binding') {
        required(v,['clientCommandId','scopeSchema','providerBinding','scopes','target','categoryOverride']);
        id(v.clientCommandId);id(v.providerBinding);normalizeScopeVector(v.scopes,v.scopeSchema);target(v.target);
        if(v.categoryOverride!==null){required(v.categoryOverride,['category','subcategory']);segment(v.categoryOverride.category);segment(v.categoryOverride.subcategory);if(!v.categoryOverride.category&&v.categoryOverride.subcategory)fail('INVALID_REQUEST',400);}
    } else if(action==='selection') {
        required(v,['clientCommandId','expectedVersion','changes','representatives']);id(v.clientCommandId);integer(v.expectedVersion);array(v.changes);array(v.representatives);
        for(const c of v.changes){required(c,['assetId','included']);id(c.assetId);bool(c.included);}
        for(const r of v.representatives){required(r,['sha256','representativeAssetId','expectedGroupVersion','confirmedFingerprint']);hash(r.sha256);id(r.representativeAssetId);integer(r.expectedGroupVersion);hash(r.confirmedFingerprint);}
    } else if(action==='batch-create') {
        required(v,['clientCommandId','previewId','expectedPreviewVersion','manifestFingerprint','startPaused','representativeConfirmations']);id(v.clientCommandId);id(v.previewId);integer(v.expectedPreviewVersion);hash(v.manifestFingerprint);bool(v.startPaused);if(Array.isArray(v.representativeConfirmations)&&v.representativeConfirmations.length>100)fail('BODY_LIMIT',413);array(v.representativeConfirmations);
        for(const r of v.representativeConfirmations){required(r,['sha256','groupVersion','fingerprint']);hash(r.sha256);integer(r.groupVersion);hash(r.fingerprint);}
    } else if(action==='command') {
        required(v,['clientCommandId','expectedVersion','action']);id(v.clientCommandId);integer(v.expectedVersion);
        // Real failed attempts need the durable 02R retry-claim path, not the older local requeue flag.
        if(v.action==='retry-failed')fail('RETRY_CLAIM_REQUIRED',409);if(!['pause','resume','stop'].includes(v.action))fail('INVALID_REQUEST',400);
    } else if(action==='retry') {
        required(v,['clientCommandId','expectedVersion','qualificationVersion','confirmed']);id(v.clientCommandId);integer(v.expectedVersion);integer(v.qualificationVersion);if(v.confirmed!==true)fail('RETRY_CLAIM_REQUIRED',409);
    } else fail('INVALID_REQUEST',400);
    return v;
}
export const batchDto = b => { if(!BATCH_STATES.has(b.state))fail('DTO_INVALID',503);return {batchId:id(b.batchId),version:integer(b.version),state:b.state,totalItems:integer(b.totalItems,0,LIMITS.items),stopRequested:bool(b.stopRequested)}; };
const previewDto = p => { if(!['PREPARING','READY','STALE','CANCELLED'].includes(p.state))fail('DTO_INVALID',503);return {previewId:id(p.previewId),version:integer(p.version),manifestFingerprint:hash(p.manifestFingerprint),state:p.state,totalFrozen:integer(p.totalFrozen,0,LIMITS.items),scanCompletedAt:integer(p.scanCompletedAt,1)}; };
function scopePageDto(p, kind) {
    array(p.rows,100);
    return { rows:p.rows.map(r=>kind==='roots'?{rootId:id(r.rootId),name:segment(r.name,180),kind:['music','sfx','mixed'].includes(r.kind)?r.kind:fail('DTO_INVALID',503),online:bool(r.online)}:{rootId:id(r.rootId),category:segment(r.category),...(r.subcategory===undefined?{}:{subcategory:segment(r.subcategory)})}),binding:id(p.binding),nextCursor:nullableId(p.nextCursor),hasMore:bool(p.hasMore) };
}
function receiptDto(r) {
    if(!r)return null;
    return {receiptId:id(r.receiptId),clientRequestId:id(r.clientRequestId),canonicalRequestId:id(r.canonicalRequestId),attemptId:nullableId(r.attemptId),audioId:id(r.audioId),blobId:id(r.blobId),shareId:id(r.shareId),sha256:hash(r.sha256),bytes:integer(r.bytes,1,LIMITS.bytes),verifiedBytes:integer(r.verifiedBytes,1,LIMITS.bytes),storageGeneration:integer(r.storageGeneration,1),admissionEpoch:integer(r.admissionEpoch),mode:mode(r.mode),targetMatched:bool(r.targetMatched),committedAt:text(r.committedAt,64)};
}
function itemDto(r) {
    if(!ITEM_STATES.has(r.state))fail('DTO_INVALID',503);
    return {itemId:id(r.itemId),ordinal:integer(r.ordinal,0,LIMITS.items-1),assetId:nullableId(r.assetId??r.representativeAssetId??null),state:r.state,resultMode:r.resultMode===null?null:mode(r.resultMode),receipt:receiptDto(r.receipt),currentAvailability:r.currentAvailability===null||r.currentAvailability===undefined?null:availabilityProjection(r.currentAvailability.state),lastCode:r.lastCode===null?null:code(r.lastCode),resourcesRetained:r.resourcesRetained===true?true:null,retainedReason:r.retainedReason?code(r.retainedReason):null,version:integer(r.version)};
}
function previewItemDto(r) {
    if(!['NEW','IN_PROGRESS','UPLOADED','HISTORICAL','NEEDS_RECONCILIATION','UNKNOWN'].includes(r.classification))fail('DTO_INVALID',503);
    return {assetId:id(r.assetId),ordinal:integer(r.ordinal,0,LIMITS.items-1),fileName:segment(r.fileName,180),mediaKind:['MUSIC','SFX'].includes(r.mediaKind)?r.mediaKind:fail('DTO_INVALID',503),category:segment(r.category),subcategory:segment(r.subcategory),sha256:r.sha256===null?null:hash(r.sha256),classification:r.classification,selectable:bool(r.selectable),included:bool(r.included),groupVersion:integer(r.groupVersion),confirmationVersion:r.confirmationVersion===null?null:integer(r.confirmationVersion),representativeAssetId:nullableId(r.representativeAssetId),representativeFingerprint:r.representativeFingerprint===null?null:hash(r.representativeFingerprint)};
}
function queryFor(url, allowed) {
    const out=Object.create(null);for(const [k,v] of url.searchParams){if(!allowed.includes(k)||Object.hasOwn(out,k))fail('INVALID_REQUEST',400);text(v,2048);out[k]=v;}return out;
}
function numberQuery(v, fallback, min, max) { if(v===undefined)return fallback;if(!/^(?:0|[1-9][0-9]*|-1)$/.test(v))fail('INVALID_REQUEST',400);return integer(Number(v),min,max); }

/** Host-owned components only: does not construct a DB/domain, mount index, start work or own scheduler lifetime. */
export function createCloudUploadTaskRouter({preview,batches,scheduler,retryRemote,currentIdentity,guardLocalRequest,authorize,assertMaintenance,scopeBindings}={}) {
    if(preview?.scopeBindingPolicy==='legacy-controlled'||scopeBindings&&preview?.scopeBindings!==scopeBindings)fail('INVALID_ADAPTER',503);
    if(!preview || !batches || !scheduler || typeof currentIdentity!=='function' || [guardLocalRequest,authorize,assertMaintenance].some(x=>typeof x!=='function') || !retryRemote || typeof retryRemote.retryClaim!=='function' || batches.preview!==preview || scheduler.batches!==batches || !batches.store || typeof batches.store.list!=='function' || ['create','owned','view','page','group','selection'].some(k=>typeof preview[k]!=='function') || ['create','owned','view','page','item','rows','summary','retryHttp','guard'].some(k=>typeof batches[k]!=='function') || typeof scheduler.command!=='function')fail('INVALID_ADAPTER',503);
    const router=express.Router({caseSensitive:true,strict:true}), readers=new Set(), handlers=new Set(), waiters=new Set();let disposed=false;
    const state=()=>({active:handlers.size,closing:disposed,settled:handlers.size===0});
    const dispose=()=>{disposed=true;for(const cancel of [...readers])cancel();return {disposed:true,activeBodyReaders:readers.size,sharedComponentsClosed:false};};
    const completed=work=>{handlers.delete(work);for(const notify of [...waiters])notify();};
    const readIdentity=()=>{try{return identity(currentIdentity());}catch{fail('AUTH_CHANGED',401);}};
    const assertLive=who=>{if(!sameIdentity(who,readIdentity()))fail('AUTH_CHANGED',409);batches.guard(who);};
    const checked=async(who,fn)=>{assertLive(who);const result=await fn();assertLive(who);return result;};
    function readBody(req) {
        if(req.aborted)fail('REQUEST_ABORTED',400);
        if(req.headers['content-encoding'] && req.headers['content-encoding']!=='identity')fail('INVALID_REQUEST',400);
        if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))fail('INVALID_REQUEST',400);
        const size=req.headers['content-length'];if(size!==undefined && (!/^(?:0|[1-9][0-9]*)$/.test(size)||!Number.isSafeInteger(Number(size))))fail('INVALID_REQUEST',400);if(Number(size)>LIMITS.body){req.resume();fail('BODY_LIMIT',413);}
        if(Buffer.isBuffer(req.cloudUploadRawBody)){if(req.cloudUploadRawBody.length>LIMITS.body)fail('BODY_LIMIT',413);return Promise.resolve(req.cloudUploadRawBody);}
        if(req.body!==undefined || req.readableEnded)fail('RAW_BODY_REQUIRED',503);if(req.destroyed)fail('REQUEST_ABORTED',400);
        return new Promise((resolve,reject)=>{
            let chunks=[],length=0,done=false;
            const finish=(error,value)=>{if(done)return;done=true;req.off('data',data);req.off('end',end);req.off('aborted',aborted);req.off('error',broken);readers.delete(cancel);chunks=[];if(error){req.resume();reject(error);}else resolve(value);};
            const data=chunk=>{length+=chunk.length;if(length>LIMITS.body)finish(Object.assign(new Error(),{code:'BODY_LIMIT',status:413}));else chunks.push(chunk);};
            const end=()=>finish(null,Buffer.concat(chunks,length)), aborted=()=>finish(Object.assign(new Error(),{code:'REQUEST_ABORTED',status:400})), broken=()=>finish(Object.assign(new Error(),{code:'REQUEST_ABORTED',status:400})), cancel=()=>finish(Object.assign(new Error(),{code:'ROUTER_CLOSED',status:503}));
            readers.add(cancel);req.on('data',data);req.once('end',end);req.once('aborted',aborted);req.once('error',broken);
        });
    }
    const handle=async(req,res)=>{
        res.setHeader('Cache-Control','no-store');let clientCommandId,finalReadGuard=()=>{};
        try {
            if(req.baseUrl!==CLOUD_UPLOAD_TASK_BASE)fail('INVALID_MOUNT',503);
            if(req.url.length>8192 || !req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('#'))fail('INVALID_REQUEST',400);
            const url=new URL(req.url,'http://local.invalid'), rawPath=req.url.split('?')[0], matches=ROUTES.map(r=>({r,m:rawPath.match(r[1])})).filter(x=>x.m), selected=matches.find(x=>x.r[0]===req.method);
            const who=readIdentity(), write=req.method!=='GET', baseContext={write,method:req.method};
            const local=async()=>{const verdict=await checked(who,()=>guardLocalRequest(req,baseContext));if(verdict?.allowed!==true || typeof verdict.sessionId!=='string' || !verdict.sessionId || verdict.sessionId.length>128)fail('LOCAL_SESSION_REQUIRED',401);return verdict.sessionId;};
            const session=await local();
            const maintenance=async context=>{const result=await checked(who,()=>assertMaintenance(clone(who),context));if(result?.allowed!==true)fail('MAINTENANCE_BUSY',423);};
            await maintenance(baseContext);if(!selected){if(matches.length)res.setHeader('Allow',[...new Set(matches.map(x=>x.r[0]))].join(', '));fail(matches.length?'METHOD_NOT_ALLOWED':'NOT_FOUND',matches.length?405:404);}
            const {r,m}=selected, action=r[2], q=queryFor(url,r[3]);let input=null;
            if(write){const raw=await checked(who,()=>readBody(req));let decoded;try{decoded=new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch{fail('INVALID_JSON',400);}input=inputFor(action,strictJson(decoded));clientCommandId=input.clientCommandId;}
            else if(Number(req.headers['content-length']||0)>0 || req.headers['transfer-encoding'])fail('INVALID_REQUEST',400);
            const context={...baseContext,action,ids:m.slice(1),input};
            const permission=async()=>{const decision=await checked(who,()=>authorize(clone(who),clone(context)));if(decision?.allowed!==true)fail('FORBIDDEN',403);};
            await permission();if(await local()!==session)fail('LOCAL_SESSION_CHANGED',401);await maintenance(context);
            const result=await checked(who,async()=>{
                const first=m[1];
                if(action==='scope-roots'||action==='scope-categories'){
                    if(!scopeBindings)fail('SCOPE_NOT_READY');
                    const request={limit:numberQuery(q.limit,100,1,100),maxBytes:numberQuery(q.maxBytes,65536,1,65536),...(q.cursor===undefined?{}:{cursor:id(q.cursor)})};
                    if(action==='scope-categories'){if(typeof q.rootIds!=='string')fail('INVALID_REQUEST',400);request.rootIds=q.rootIds.split(',').map(id);array(request.rootIds,32);if(!request.rootIds.length)fail('INVALID_REQUEST',400);}
                    return scopePageDto(action==='scope-roots'?scopeBindings.listRoots(who,request,{localSession:session}):scopeBindings.listCategories(who,request,{localSession:session}),action==='scope-roots'?'roots':'categories');
                }
                if(action==='scope-binding'){
                    if(!scopeBindings)fail('SCOPE_NOT_READY');
                    const issued=await checked(who,()=>scopeBindings.issue(who,input,{localSession:session}));
                    return{scopeBinding:{schema:'scope-binding-v1',token:text(issued.scopeBinding.token,43)},expiresInMs:integer(issued.expiresInMs,0,60000)};
                }
                if(action==='preview-resolve'){
                    const fact=preview.resolveCreate(who,first);
                    return{state:fact.state==='FOUND'?'FOUND':fact.state==='UNKNOWN'?'UNKNOWN':fail('DTO_INVALID',503),historicalFact:true,currentScopePermission:false,preview:fact.preview===null?null:previewDto(fact.preview)};
                }
                if(action==='preview-create')return previewDto(await checked(who,()=>preview.create(who,input,{localSession:session})));
                if(action==='preview')return previewDto(preview.view(preview.owned(who,first)));
                if(action==='preview-items'){
                    if(q.filter!==undefined&&!['all','pending'].includes(q.filter))fail('INVALID_REQUEST',400);
                    const page=preview.page(who,first,{cursor:q.cursor??null,limit:numberQuery(q.limit,50,1,100),scanBudget:numberQuery(q.scanBudget,500,1,500),filter:q.filter??'pending'});
                    return {previewId:id(page.previewId),version:integer(page.version),filterFingerprint:hash(page.filterFingerprint),items:page.items.map(previewItemDto),lastScannedOrdinal:integer(page.lastScannedOrdinal,-1,LIMITS.items-1),nextCursor:page.nextCursor===null?null:text(page.nextCursor,2048),scanComplete:bool(page.scanComplete),scanned:integer(page.scanned,0,500),totalFrozen:integer(page.totalFrozen,0,LIMITS.items),excludedCounts:{uploaded:integer(page.excludedCounts.uploaded),excluded:integer(page.excludedCounts.excluded)}};
                }
                if(action==='preview-group'){if(q.representativeAssetId!==undefined)id(q.representativeAssetId);const g=preview.group(who,first,m[2],q.representativeAssetId??null);return {sha256:hash(g.sha256),groupVersion:integer(g.groupVersion),confirmationVersion:g.confirmationVersion===null?null:integer(g.confirmationVersion),representativeAssetId:nullableId(g.representativeAssetId),fingerprint:g.fingerprint===null?null:hash(g.fingerprint)};}
                if(action==='selection')return previewDto(preview.selection(who,first,input));
                if(action==='batch-create')return batchDto(batches.create(who,input));
                if(action==='batches'){
                    if(q.after!==undefined)id(q.after);if(q.state!==undefined&&!BATCH_STATES.has(q.state))fail('INVALID_REQUEST',400);const limit=numberQuery(q.limit,50,1,100);
                    const where={...namespace(who),deviceId:who.deviceId,librarySourceId:who.librarySourceId,...(q.state?{state:q.state}:{})};
                    const rows=batches.store.list('cloud_upload_batches',where,{after:q.after??null,limit:limit+1,order:'batchId'}), page=rows.slice(0,limit);return {items:page.map(row=>batchDto(batches.view(row))),nextAfter:rows.length>limit?id(page.at(-1).batchId):null,complete:rows.length<=limit};
                }
                if(action==='batch')return batchDto(batches.view(batches.owned(who,first)));
                if(action==='items'){const page=batches.page(who,first,{after:numberQuery(q.after,-1,-1,LIMITS.items-1),limit:numberQuery(q.limit,100,1,100)});return {batch:batchDto(page.batch),items:page.items.map(itemDto),nextOrdinal:integer(page.nextOrdinal,-1,LIMITS.items-1),complete:bool(page.complete)};}
                if(action==='summary'){
                    const summary=batches.summary(who,first), counts=Object.fromEntries(['uploaded','reused','already_present','legacy_unrecorded','committed','pending'].map(k=>[k,integer(summary.counts[k],0,LIMITS.items)])), availability={AVAILABLE:0,PRIVATE:0,UNAVAILABLE:0,HISTORICAL:0,NEEDS_RECONCILIATION:0,UNOBSERVED:0};
                    for(const row of batches.rows(first)){if(!row.receipt)continue;const classification=row.currentAvailability?availabilityProjection(row.currentAvailability.state).classification:'UNOBSERVED';availability[classification]++;}return {...batchDto(summary),counts,availability};
                }
                if(action==='command')return batchDto(scheduler.command(first,input));
                if(action==='retry-qualification'){
                    if(typeof retryRemote.readRetryQualification!=='function')fail('RETRY_CONTEXT_UNAVAILABLE',503);
                    if(q.itemVersion===undefined)fail('INVALID_REQUEST',400);const expected=numberQuery(q.itemVersion,0,0,Number.MAX_SAFE_INTEGER), captured=batches.schedulerContext(who,m[2]);
                    if(captured.batch.batchId!==first)fail('NOT_FOUND',404);
                    const eligible=c=>c.batch.epoch===who.epoch&&!c.batch.stopRequested&&c.item.version===expected&&c.item.state==='FAILED'&&c.item.safeTerminal===true&&!c.item.receipt&&!c.item.cleanupPending&&!c.item.resourcesRetained&&c.attempt?.state==='FAILED_FENCED'&&c.attempt.terminalEvidence?.versionKind==='attempt'&&c.attempt.terminalEvidence?.budgetState==='SETTLED';
                    if(!eligible(captured))fail('RETRY_CLAIM_REQUIRED');
                    const binding=clone(captured),same=()=>{assertLive(who);const now=batches.schedulerContext(who,m[2]);if(!eligible(now)||JSON.stringify(clone(now))!==JSON.stringify(binding))fail('VERSION_CONFLICT');};
                    finalReadGuard=same;same();const value=await checked(who,()=>retryRemote.readRetryQualification(clone(who),clone(binding)));same();
                    // Adapter verifies remote mappings; this projection owns local IDs/version and its clock only.
                    for(const k of ['requestVersion','qualificationVersion','admissionEpoch'])integer(value?.[k]);
                    for(const k of ['clientRequestId','originalRequestId','remoteAttemptId'])id(value?.[k]);
                    if(value.clientRequestId!==binding.item.clientRequestId||value.originalRequestId!==binding.attempt.serverRequestId||value.remoteAttemptId!==binding.attempt.serverAttemptId||value.admissionEpoch!==binding.attempt.admissionEpoch)fail('REMOTE_MAPPING_CONFLICT');
                    const start=Date.parse(value.cloudReadStartedAt),end=Date.parse(value.cloudReadCompletedAt);if(typeof value.cloudReadStartedAt!=='string'||typeof value.cloudReadCompletedAt!=='string'||!Number.isFinite(start)||!Number.isFinite(end)||end<start)fail('RETRY_CONTEXT_UNAVAILABLE',503);
                    return{state:'OBSERVED',batchId:id(first),itemId:id(m[2]),itemVersion:expected,...Object.fromEntries(['requestVersion','qualificationVersion','clientRequestId','originalRequestId','remoteAttemptId','admissionEpoch','cloudReadStartedAt','cloudReadCompletedAt'].map(k=>[k,value[k]])),localReadCompletedAt:new Date().toISOString()};
                }
                if(action==='retry'){const owned=batches.item(who,m[2]);if(owned.b.batchId!==first)fail('NOT_FOUND',404);await checked(who,()=>batches.retryHttp(who,m[2],input,retryRemote));return {batch:batchDto(batches.view(batches.owned(who,first))),item:itemDto(batches.item(who,m[2]).r)};}
                fail('NOT_FOUND',404);
            });
            await permission();if(await local()!==session)fail('LOCAL_SESSION_CHANGED',401);await maintenance(context);assertLive(who);finalReadGuard();
            if(!res.destroyed)res.json({data:result});
        } catch(error) {
            const safeCode=code(error?.code), status=Number.isInteger(error?.status)&&error.status>=400&&error.status<=599?error.status:safeCode==='OPERATION_ERROR'?500:409;
            const recovery=['AUTH_CHANGED','LOCAL_SESSION_REQUIRED','LOCAL_SESSION_CHANGED','FORBIDDEN'].includes(safeCode)?'REAUTHENTICATE':['VERSION_CONFLICT','PREVIEW_STALE','REPRESENTATIVE_STALE'].includes(safeCode)?'REFRESH_CURRENT_STATE':safeCode==='RETRY_CLAIM_REQUIRED'?'USE_CONFIRMED_ITEM_RETRY':clientCommandId?'RETRY_SAME_COMMAND':'REVIEW_REQUEST';
            if(!res.destroyed&&!res.headersSent)res.status(status).json({error:{code:safeCode,recovery,...(clientCommandId?{clientCommandId}:{})}});
        }
    };
    router.use((req,res)=>{
        if(disposed){res.setHeader('Cache-Control','no-store');if(!res.destroyed)res.status(503).json({error:{code:'ROUTER_CLOSED',recovery:'REVIEW_REQUEST'}});return;}
        // Register before invoking any callback. Transport close/finish never removes this actual work.
        const work=Promise.resolve().then(()=>handle(req,res));handlers.add(work);work.then(()=>completed(work),()=>completed(work));return work;
    });
    return Object.freeze({router,basePath:CLOUD_UPLOAD_TASK_BASE,state,dispose,
        async drain({timeoutMs=5000}={}){
            integer(timeoutMs,0,30000);dispose();
            const snapshot=()=>({closed:handlers.size===0,unknown:handlers.size!==0,...state(),sharedComponentsClosed:false});
            if(handlers.size===0||timeoutMs===0)return snapshot();
            return new Promise(resolve=>{let timer;const finish=()=>{waiters.delete(settled);if(timer!==undefined)clearTimeout(timer);resolve(snapshot());},settled=()=>{if(handlers.size===0)finish();};waiters.add(settled);timer=setTimeout(finish,timeoutMs);settled();});
        }
    });
}
