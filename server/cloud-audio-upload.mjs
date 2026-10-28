// Manual, account-bound upload intents. Never schedules uploads or imports at startup.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { CLOUD_AUDIO_MESSAGES } from './cloud-audio-service.mjs';
import { isPreviewReadBudget } from './cloud-upload-preview.mjs';
import { CloudUploadBatchStore, UPLOAD_TABLES, sqlName } from './cloud-upload-batch-store.mjs';
import { rootIdentity } from './fs-identity.mjs';
import { validateCategories, validateFileName } from './cloud-audio-install.mjs';
import { sourceVersion as batchSourceVersion, fingerprint as batchFingerprint, canonical as batchCanonical, id as batchId, identity as batchIdentity, terminationEvidence as batchTerminationEvidence } from './cloud-upload-protocol.mjs';
const MAX = 256000000, BUDGET = 512000000;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const message = {
    PREVIEW_BUDGET_EXCEEDED: '本次预览读取预算已用尽，请缩小范围后重新核对',
    PREVIEW_CANCELLED: '本次预览已停止，未提交预览或上传意图',
    SOURCE_CHANGED: '源素材已变化，请核对本次意图，不能沿用旧摘要上传',
    UPLOAD_UNKNOWN: '上传结果未知，请核对原申请；不会自动创建新的共享',
    RECOVERY_UNAVAILABLE: '云端尚未提供可用的提交结果，请保留原申请并手动核对',
    UPLOAD_STATE: '申请当前不能上传，请刷新审批状态',
    UPLOAD_STORAGE: '本地上传记录或快照不可用，请检查后重试',
    UPLOAD_LIMIT: '上传暂存空间或记录已满，请先处理已有意图',
    UPLOAD_ALREADY_COMMITTED: '内容已提交；取消申请不会撤回分享，请使用独立撤回操作',
};
export class CloudUploadError extends Error {
    constructor(code, status = 409) { super(message[code] || CLOUD_AUDIO_MESSAGES[code] || '云端上传操作未完成'); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new CloudUploadError(code, status); };
const identity = auth => { const s = auth.getState(); if (!s.configured || s.state !== 'logged-in' || !s.accountId || !s.deviceId)
    fail('NOT_LOGGED_IN', 401); return { owner: `${s.originHost}|${s.accountId}|${s.deviceId}`, epoch: auth.epoch }; };
const statKey = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
async function hashHandle(f,inspection) {
 if(inspection){const hash=crypto.createHash('sha256'),buffer=Buffer.alloc(65536);let at=0;const deadline=Date.now()+120000;
  while(at<inspection.size){inspection.check();if(!inspection.budget&&Date.now()>deadline)fail('SOURCE_CHANGED');const requested=Math.min(buffer.length,inspection.size-at);let result;
   if(inspection.budget)result=await inspection.budget.read(requested,length=>f.read(buffer,0,length,at));
   else result=await f.read(buffer,0,requested,at);
   inspection.check();const n=result?.bytesRead;if(!Number.isSafeInteger(n)||n<1||n>requested)fail('SOURCE_CHANGED');at+=n;hash.update(buffer.subarray(0,n));
  }inspection.check();return hash.digest('hex');
 }
 const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(65536); let at = 0; const deadline = Date.now() + 120000; for (;;) {
    if (Date.now() > deadline)
        fail('SOURCE_CHANGED');
    const { bytesRead: n } = await f.read(buffer, 0, buffer.length, at);
    if (!n)
        break;
    at += n;
    if (at > MAX)
        fail('SOURCE_CHANGED');
    hash.update(buffer.subarray(0, n));
} return hash.digest('hex'); }
const plain = v => v && typeof v === 'object' && !Array.isArray(v);
const segment = (s, max, empty = false) => typeof s === 'string' && s.length <= max && (empty || s.trim().length > 0) && s === s.trim() && !/[\u0000-\u001f\u007f-\u009f/\\:]/.test(s) && s !== '.' && s !== '..';
const cloneBatch=value=>JSON.parse(batchCanonical(value));
const fileIdentity=s=>({dev:s.dev,ino:s.ino,size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs,birthtimeMs:s.birthtimeMs,nlink:s.nlink,mode:s.mode&0o777});
async function closeUploadStream(stream){if(!stream||stream.closed)return;const closed=new Promise(resolve=>stream.once('close',resolve));stream.destroy();await closed;}
const exactKeys=(value,keys)=>plain(value)&&!Object.keys(value).some(k=>!keys.includes(k));
export class CloudAudioUpload {
    constructor(lib, { dataDir = lib.dataDir, cloudAuth, enabled = false } = {}) { this.lib = lib; this.dataDir = dataDir; this.auth = cloudAuth; this.enabled = enabled; this.jobs = []; this.controllers = new Map(); this.operations = new Set(); this.busy = false; this.chain = Promise.resolve(); this.settledTasks=new Set();this.inspections=new Map();this.disposing=false; }
    async init() {
        if (!this.enabled)
            return this;
        const base = await fs.realpath(this.dataDir);
        this.dir = path.join(base, 'cloud-upload-intents');
        try {
            await fs.mkdir(this.dir, { mode: 0o700 });
        }
        catch (e) {
            if (e.code !== 'EEXIST')
                throw e;
        }
        const s = await fs.lstat(this.dir);
        if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077))
            fail('UPLOAD_STORAGE', 503);
        this.dirKey = `${s.dev}:${s.ino}`;
        try {
            const f = await fs.open(path.join(this.dir, 'intents.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                if ((await f.stat()).size > 262144)
                    fail('UPLOAD_STORAGE', 503);
                const v = JSON.parse(await f.readFile('utf8'));
                if (!Array.isArray(v) || v.length > 50)
                    fail('UPLOAD_STORAGE', 503);
                for (const j of v) {
                    if (!UUID.test(j.id) || !plain(j) || typeof j.owner !== 'string' || j.owner.length > 300 || !HASH.test(j.sha256 || '') || !Number.isSafeInteger(j.bytes) || j.bytes < 1 || j.bytes > MAX || typeof j.assetId !== 'string')
                        fail('UPLOAD_STORAGE', 503);
                    if (!['prepared', 'requesting', 'ready', 'uploading', 'unknown', 'completed', 'cancelled', 'failed'].includes(j.state) || !['MUSIC', 'SFX'].includes(j.mediaKind) || !segment(j.fileName, 180) || !segment(j.category, 60, true) || !segment(j.subcategory, 60, true) || (j.serverId && !UUID.test(j.serverId)))
                        fail('UPLOAD_STORAGE', 503);
                    try { validateCategories(j.category, j.subcategory); validateFileName(j.fileName); } catch { fail('UPLOAD_STORAGE', 503); }
                    if(j.clientRequestId!==undefined&&!UUID.test(j.clientRequestId))fail('UPLOAD_STORAGE',503);
                    if(j.batchBinding!==undefined&&(!HASH.test(j.batchBinding)||typeof j.payloadReleased!=='boolean'))fail('UPLOAD_STORAGE',503);
                    if(j.settledBinding!==undefined)this._scopeForSettled(j.settledBinding);
                    if(j.privateRootKey!==undefined&&(typeof j.privateRootKey!=='string'||!/^\d+:\d+$/.test(j.privateRootKey)))fail('UPLOAD_STORAGE',503);
                    if(j.payloadOwnership!==undefined){const o=j.payloadOwnership;if(!plain(o)||o.version!==1||!['ABSENT','INTENDING','CREATING','OWNED'].includes(o.state)||!UUID.test(o.generationId||'')||o.rootKey!==j.privateRootKey||(['CREATING','OWNED'].includes(o.state)&&!plain(o.fileIdentity)))fail('UPLOAD_STORAGE',503);}
                    if(j.settledCleanup!==undefined){const c=j.settledCleanup;if(!plain(c)||c.version!==1||!HASH.test(c.evidenceFingerprint||'')||c.heldBytes!==(j.payloadOwnership?.state==='ABSENT'?0:j.bytes))fail('UPLOAD_STORAGE',503);}
                    if (j.receipt)
                        j.receipt = this.receipt(j, j.receipt);
                    if (['uploading', 'requesting'].includes(j.state))
                        j.state = 'unknown';
                }
                this.jobs = v;
            }
            finally {
                await f.close();
            }
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw new CloudUploadError('UPLOAD_STORAGE', 503);
        }
        this.repairInitialized=true;
        return this;
    }
    guard() { if (!this.enabled)
        fail('CLOUD_AUDIO_DISABLED', 503); return identity(this.auth); }
    async dirGuard() { const s = await fs.lstat(this.dir); if (s.isSymbolicLink() || !s.isDirectory() || `${s.dev}:${s.ino}` !== this.dirKey || (s.mode & 0o077))
        fail('UPLOAD_STORAGE', 503); }
    async syncIntentDirectory() {
        const h=await fs.open(this.dir,constants.O_RDONLY|constants.O_NOFOLLOW);
        try{const stat=await h.stat();if(!stat.isDirectory()||`${stat.dev}:${stat.ino}`!==this.dirKey)fail('UPLOAD_STORAGE',503);await h.sync();}finally{await h.close();}
    }
    async save({omitIntentId=null,validate=null}={}) {
        if(omitIntentId!==null)batchId(omitIntentId);
        if(validate!==null&&typeof validate!=='function')fail('UPLOAD_STATE');
        const check=()=>{if(validate)validate();};
        const write=async()=>{
            await this.dirGuard();check();
            const tmp=path.join(this.dir,`.intent-${crypto.randomUUID()}`);let f,tmpKey;
            try{
                f=await fs.open(tmp,'wx',0o600);tmpKey=fileIdentity(await f.stat());check();
                const encoded=JSON.stringify(omitIntentId===null?this.jobs:this.jobs.filter(j=>j.id!==omitIntentId));
                if(Buffer.byteLength(encoded)>262144)fail('UPLOAD_LIMIT',429);
                await f.writeFile(encoded);check();await f.sync();check();await f.close();f=null;
                await this.dirGuard();check();await fs.rename(tmp,path.join(this.dir,'intents.json'));check();
                await this.syncIntentDirectory();check();await this.dirGuard();check();
                // Omitted records remain in RAM/counts until rename+directory fsync are confirmed.
                if(omitIntentId!==null)this.jobs=this.jobs.filter(j=>j.id!==omitIntentId);
            }finally{
                await f?.close();
                // A failed write cannot authorize unlink through a replaced root or tmp inode.
                if(tmpKey)try{await this.dirGuard();const st=await fs.lstat(tmp);if(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.dev===tmpKey.dev&&st.ino===tmpKey.ino){await this.dirGuard();await fs.unlink(tmp);}}catch{/* retain unknown temporary bytes */}
            }
        };
        const next=this.chain.then(write);this.chain=next.catch(()=>{});await next.catch(()=>fail('UPLOAD_STORAGE',503));
    }
    view(j) { return { id: j.id, assetId: j.assetId, fileName: j.fileName, bytes: j.bytes, sha256: j.sha256, mediaKind: j.mediaKind, visibility: j.visibility, groupId: j.groupId, category: j.category, subcategory: j.subcategory, state: j.state, status: j.status || null, version: j.version ?? null, requestId: j.serverId || null, receipt: j.receipt ? this.receipt(j, j.receipt) : null, error: j.error ? message[j.error] || '操作未完成，请刷新状态后核对' : null }; }
    list() { const who = this.guard(); return this.jobs.filter(j => j.owner === who.owner).map(j => this.view(j)); }
    owned(id) { const who = this.guard(); const j = this.jobs.find(j => j.id === id && j.owner === who.owner); if (!j)
        fail('NOT_FOUND', 404); return { j, who }; }
    check(who) { const now = this.guard(); if (now.owner !== who.owner || now.epoch !== who.epoch)
        fail('AUTH_CHANGED', 409); }
    repairMemoryState(assetIds) {
        if(!Array.isArray(assetIds)||!assetIds.length||assetIds.length>50||assetIds.some(id=>!UUID.test(id||''))||!this.repairInitialized||!this.dir||!this.dirKey||this.disposing)return {known:false,state:'unknown'};
        if(this.jobs.length>50)return {known:false,state:'unknown'};
        const relevant=this.jobs.filter(j=>assetIds.includes(j.assetId));
        const busy=this.busy||this.controllers.size>0||this.operations.size>0||this.settledTasks.size>0||relevant.length>0;
        return {known:true,state:busy?'blocked':'idle',version:crypto.createHash('sha256').update(batchCanonical(this.jobs)).digest('hex')};
    }
    async repairState(assetIds) {
        const before=this.repairMemoryState(assetIds);if(!before.known||before.state!=='idle')return before;
        let handle;
        try{
            await this.dirGuard();
            let disk=[];
            try{handle=await fs.open(path.join(this.dir,'intents.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
            catch(e){if(e.code!=='ENOENT')throw e;}
            let identity=null;
            if(handle){const st=await handle.stat();if(!st.isFile()||st.nlink!==1||st.size>262144)throw Error('bounded');identity=fileIdentity(st);
                const bytes=Buffer.alloc(st.size);let offset=0;while(offset<bytes.length){const read=await handle.read(bytes,offset,Math.min(65536,bytes.length-offset),offset);if(!read.bytesRead)throw Error('changed');offset+=read.bytesRead;}
                if(batchCanonical(fileIdentity(await handle.stat()))!==batchCanonical(identity)||batchCanonical(fileIdentity(await fs.lstat(path.join(this.dir,'intents.json'))))!==batchCanonical(identity))throw Error('changed');
                disk=JSON.parse(bytes.toString('utf8'));if(!Array.isArray(disk)||disk.length>50||disk.some(j=>!plain(j)||!UUID.test(j.assetId||'')))throw Error('invalid');
            }
            await this.dirGuard();const after=this.repairMemoryState(assetIds);
            if(!after.known||batchCanonical(before)!==batchCanonical(after)||batchCanonical(disk)!==batchCanonical(this.jobs))return {known:false,state:'unknown'};
            if(disk.some(j=>assetIds.includes(j.assetId)))return {known:true,state:'blocked'};
            const version=crypto.createHash('sha256').update(batchCanonical([disk,identity])).digest('hex');
            this.repairDiskProof={identity,ramVersion:after.version,version};
            return {known:true,state:'idle',version};
        }catch{return {known:false,state:'unknown'};}finally{await handle?.close();}
    }
    repairDiskState(assetIds) {
        const ram=this.repairMemoryState(assetIds),proof=this.repairDiskProof;
        if(!ram.known||ram.state!=='idle'||!proof||ram.version!==proof.ramVersion)return {known:false,state:'unknown'};
        try{const dir=lstatSync(this.dir);if(!dir.isDirectory()||dir.isSymbolicLink()||`${dir.dev}:${dir.ino}`!==this.dirKey||realpathSync(this.dir)!==this.dir)return {known:false,state:'unknown'};
            let identity=null;try{identity=fileIdentity(lstatSync(path.join(this.dir,'intents.json')));}catch(e){if(e.code!=='ENOENT')throw e;}
            if(batchCanonical(identity)!==batchCanonical(proof.identity))return {known:false,state:'unknown'};
            return {known:true,state:'idle',version:proof.version};
        }catch{return {known:false,state:'unknown'};}
    }
    // A persisted truthy batchBinding is not a capability. Reconstruct the
    // existing namespace/item/attempt/claim and immutable payload from the same
    // actual store before choosing the batch-only read path. No queue/domain is
    // created, repaired or updated by these bounded reads.
    _batchSourceBinding(j) {
        try {
            if(this.disposing||!this.jobs.includes(j)||!HASH.test(j.batchBinding||'')||this.lib.db.kind==='mysql'||this.lib.db.inTransaction)fail('BATCH_SOURCE_BINDING_UNKNOWN');
            const {j:owned,who}=this.owned(j.id);if(owned!==j||!this.auth.config?.origin)fail('BATCH_SOURCE_BINDING_UNKNOWN');
            const state=this.auth.getState(),service=crypto.createHash('sha256').update(new URL(this.auth.config.origin).origin).digest('hex'),store=new CloudUploadBatchStore(this.lib.db);
            const read=(table,where)=>{
                const def=UPLOAD_TABLES[table],columns=Object.keys(def.columns),keys=Object.keys(where);if(keys.some(k=>!Object.hasOwn(def.columns,k)))fail('BATCH_SOURCE_BINDING_UNKNOWN');
                const condition=keys.map(k=>sqlName(k)+'=?').join(' AND '),values=Object.values(where),sizing=columns.map(k=>`COALESCE(LENGTH(CAST(${sqlName(k)} AS BLOB)),0)`).join('+');
                const sizes=this.lib.db.prepare(`SELECT (${sizing}) bytes FROM ${table} WHERE ${condition} LIMIT 2`).all(...values);
                if(sizes.length!==1||!Number.isSafeInteger(sizes[0].bytes)||sizes[0].bytes>65536)fail('BATCH_SOURCE_BINDING_UNKNOWN');
                const row=this.lib.db.prepare(`SELECT * FROM ${table} WHERE ${condition} LIMIT 2`).all(...values);if(row.length!==1)fail('BATCH_SOURCE_BINDING_UNKNOWN');
                const record=store.decode(row[0]),expected=store.values(table,record);if(columns.some((key,i)=>row[0][sqlName(key)]!==expected[i]))fail('BATCH_SOURCE_BINDING_UNKNOWN');return record;
            };
            return this.lib.db.transaction(()=>{
                const attempt=read('cloud_upload_item_attempts',{intentId:j.id}),item=read('cloud_upload_batch_items',{itemId:attempt.itemId}),batch=read('cloud_upload_batches',{batchId:item.batchId}),claim=read('cloud_upload_active_claims',{itemId:item.itemId});
                const identity=batchIdentity({cloudServiceKey:service,accountId:state.accountId,deviceId:state.deviceId,librarySourceId:batch.librarySourceId,epoch:who.epoch}),proof=this.lib.scanProof;
                if(!proof||proof.lib!==this.lib||proof.db!==this.lib.db||proof.closed||!UUID.test(proof.epoch||'')||proof.capability?.sourceId!==identity.librarySourceId||batch.cloudServiceKey!==service||batch.accountId!==identity.accountId||batch.deviceId!==identity.deviceId||batch.epoch!==identity.epoch||attempt.cloudServiceKey!==service||attempt.accountId!==identity.accountId||claim.cloudServiceKey!==service||claim.accountId!==identity.accountId)fail('BATCH_SOURCE_BINDING_UNKNOWN');
                if(item.currentAttemptId!==attempt.attemptId||item.intentId!==j.id||item.clientRequestId!==j.clientRequestId||attempt.intentId!==j.id||attempt.clientRequestId!==j.clientRequestId||claim.attemptId!==attempt.attemptId||claim.itemId!==item.itemId||claim.assetId!==j.assetId||item.representativeAssetId!==j.assetId)fail('BATCH_SOURCE_BINDING_UNKNOWN');
                const confirmed={mediaKind:j.mediaKind,fileName:j.fileName,category:j.category,subcategory:j.subcategory,visibility:j.visibility,groupId:j.groupId,bytes:j.bytes};
                batchSourceVersion(item.sourceVersion);const metadataFingerprint=batchFingerprint(confirmed);
                if(item.sha256!==j.sha256||item.declaredBytes!==j.bytes||batchCanonical(item.metadata)!==batchCanonical(confirmed)||item.metadataFingerprint!==metadataFingerprint||attempt.metadataFingerprint!==metadataFingerprint||claim.metadataFingerprint!==metadataFingerprint||batchCanonical(attempt.sourceVersion)!==batchCanonical(item.sourceVersion)||batchCanonical(claim.sourceVersion)!==batchCanonical(item.sourceVersion)||batchCanonical(claim.target)!==batchCanonical(item.target))fail('BATCH_SOURCE_BINDING_UNKNOWN');
                const v=item.sourceVersion;if(j.rootKey!==v.rootIdentity||j.sourceKey!==`${v.dev}:${v.ino}:${v.size}:${v.mtimeMs}:${v.ctimeMs}`||j.batchBinding!==batchFingerprint({ids:{intentId:j.id,clientRequestId:j.clientRequestId},sourceVersion:v,metadata:{assetId:j.assetId,sha256:j.sha256,...confirmed}}))fail('BATCH_SOURCE_BINDING_UNKNOWN');
                if(claim.claimKey!==batchFingerprint({cloudServiceKey:service,accountId:identity.accountId,assetId:j.assetId,sourceVersion:v,target:item.target,metadataFingerprint}))fail('BATCH_SOURCE_BINDING_UNKNOWN');
                const scope=this._scopeForSettled({identity,batchId:batch.batchId,itemId:item.itemId,localAttemptId:attempt.attemptId,intentId:j.id,clientRequestId:j.clientRequestId,metadataFingerprint});
                if(j.settledBinding&&batchCanonical(this._scopeForSettled(j.settledBinding))!==batchCanonical(scope))fail('BATCH_SOURCE_BINDING_UNKNOWN');
                const asset=this.lib.asset(j.assetId),root=this.lib.rootById(asset.root_id),preview=read('cloud_upload_preview_items',{previewId:batch.previewId,assetId:j.assetId});
                if(preview.rootId!==root.id||batchCanonical(preview.sourceVersion)!==batchCanonical(v)||preview.sha256!==j.sha256||preview.groupVersion!==item.groupVersion||preview.confirmationVersion!==item.groupVersion||preview.representativeAssetId!==j.assetId)fail('BATCH_SOURCE_BINDING_UNKNOWN');
                const certificate=proof.readBoundCertificate({rootVector:[{rootId:root.id,revision:root.revision,reconciledMs:root.reconciled_ms}],scopes:[{rootId:root.id}]});if(certificate.known!==true||certificate.complete!==true)fail('BATCH_SOURCE_BINDING_UNKNOWN');
                return batchFingerprint({scope,batchVersion:batch.version,itemVersion:item.version,attemptVersion:attempt.version,claimVersion:claim.version,sourceVersion:v,binding:j.batchBinding,certificate});
            })();
        } catch(error) { if(error instanceof CloudUploadError)throw error;fail('BATCH_SOURCE_BINDING_UNKNOWN'); }
    }
    async source(j,check=()=>{},{readOnly=false}={}) {
        const batch=Object.hasOwn(j,'batchBinding')?this._batchSourceBinding(j):null;
        const current=()=>{check();if(batch!==null&&this._batchSourceBinding(j)!==batch)fail('BATCH_SOURCE_BINDING_UNKNOWN');};
        current();if(this.lib.locks?.has(j.assetId))fail('SOURCE_CHANGED');const a=this.lib.asset(j.assetId),root=this.lib.rootById(a.root_id);if(root.retired||a.trashed||!['music','sfx'].includes(a.kind))fail('SOURCE_CHANGED');
        const src=await this.lib.source(j.assetId,readOnly||batch!==null?{readOnly:true}:undefined);current();if(this.lib.locks?.has(j.assetId))fail('SOURCE_CHANGED');const rootKey=await rootIdentity(root);current();if(this.lib.locks?.has(j.assetId))fail('SOURCE_CHANGED');return{...src,root,rootKey};
    }
    async verifySource(j) { const src = await this.source(j); if (src.rootKey !== j.rootKey || statKey(src.stat) !== j.sourceKey)
        fail('SOURCE_CHANGED'); const f = await fs.open(src.p, constants.O_RDONLY | constants.O_NOFOLLOW); try {
        if (statKey(await f.stat()) !== j.sourceKey)
            fail('SOURCE_CHANGED');
        const digest = await hashHandle(f);
        if (digest !== j.sha256 || statKey(await f.stat()) !== j.sourceKey)
            fail('SOURCE_CHANGED');
    }
    finally {
        await f.close();
    } }
    async prepare(input) {
        if(this.disposing)fail('UPLOAD_STATE');
        const who = this.guard();
        if (!plain(input) || Object.keys(input).some(k => !['assetId', 'mediaKind', 'visibility', 'groupId', 'category', 'subcategory'].includes(k)) || !['MUSIC', 'SFX'].includes(input.mediaKind) || !['PRIVATE', 'GROUP'].includes(input.visibility) || !segment(input.category, 60, true) || !segment(input.subcategory, 60, true) || (!input.category && input.subcategory) || (input.visibility === 'GROUP' && !UUID.test(input.groupId || '')) || (input.visibility === 'PRIVATE' && input.groupId))
            fail('INVALID_REQUEST', 400);
        try { validateCategories(input.category, input.subcategory); } catch { fail('INVALID_REQUEST', 400); }
        if (this.jobs.some(j => j.owner === who.owner && j.assetId === input.assetId && !['completed', 'cancelled', 'failed'].includes(j.state)))
            fail('UPLOAD_STATE');
        if (this.busy || this.jobs.length >= 50)
            fail('UPLOAD_LIMIT', 429);
        this.busy = true;
        let file = null, f = null, out = null, j;
        try {
            await this.dirGuard();
            let usage = 0;
            for (const entry of await fs.readdir(this.dir)) {
                const s = await fs.lstat(path.join(this.dir, entry));
                usage += s.isFile() && !s.isSymbolicLink() ? s.size : BUDGET;
            }
            const src = await this.source(input);
            if (src.a.kind !== (input.mediaKind === 'MUSIC' ? 'music' : 'sfx') || src.stat.size < 1 || src.stat.size > MAX || usage + src.stat.size > BUDGET)
                fail('UPLOAD_LIMIT', 413);
            const fileName = path.basename(src.p);
            try { validateFileName(fileName); } catch { fail('INVALID_REQUEST', 400); }
            if (!segment(fileName, 180) || !/^.+\.(wav|mp3|flac|ogg|m4a|aif|aiff|opus)$/i.test(fileName))
                fail('INVALID_REQUEST', 400);
            const id = crypto.randomUUID();
            file = path.join(this.dir, `payload-${id}`);
            f = await fs.open(src.p, constants.O_RDONLY | constants.O_NOFOLLOW);
            if (statKey(await f.stat()) !== statKey(src.stat))
                fail('SOURCE_CHANGED');
            out = await fs.open(file, 'wx', 0o600);
            let bytes = 0;
            const hash = crypto.createHash('sha256');
            const deadline = Date.now() + 120000;
            const buffer = Buffer.alloc(65536);
            let position = 0;
            for (;;) {
                const { bytesRead: n } = await f.read(buffer, 0, buffer.length, position);
                if (!n)
                    break;
                this.check(who);
                bytes += n;
                if (bytes > src.stat.size || Date.now() > deadline)
                    fail('SOURCE_CHANGED');
                hash.update(buffer.subarray(0, n));
                let written = 0;
                while (written < n) {
                    const r = await out.write(buffer, written, n - written, position + written);
                    if (r.bytesWritten < 1)
                        fail('UPLOAD_STORAGE');
                    written += r.bytesWritten;
                }
                position += n;
            }
            await out.sync();
            const current = await this.source(input);
            if (bytes !== src.stat.size || statKey(await f.stat()) !== statKey(src.stat) || current.rootKey !== src.rootKey || statKey(current.stat) !== statKey(src.stat))
                fail('SOURCE_CHANGED');
            this.check(who);
            j = { id, createdAt: Date.now(), owner: who.owner, assetId: input.assetId, mediaKind: input.mediaKind, visibility: input.visibility, groupId: input.groupId || null, category: input.category, subcategory: input.subcategory, fileName, bytes, sha256: hash.digest('hex'), rootKey: src.rootKey, sourceKey: statKey(src.stat), state: 'prepared', serverId: null, status: null, version: null, receipt: null, error: null };
            this.jobs.push(j);
            await this.save();
            file = null;
            this.check(who);
            return this.view(j);
        }
        finally {
            await f?.close();
            await out?.close();
            if (file)
                await fs.unlink(file).catch(() => { });
            this.busy = false;
        }
    }
    async proxy(j, who, method, url, body = null) { this.check(who); let result; try {
        result = await this.auth.proxy(method, url, { body, epoch: who.epoch });
    }
    catch (e) {
        if (e?.status === 401)
            await this.auth.forgetSession?.(e.toPublic?.(), { epoch: who.epoch });
        throw e;
    } this.check(who); return result; }
    applyRequest(j, row) { if (!plain(row) || !UUID.test(row.id || '') || row.requestId !== (j.clientRequestId || j.id) || row.declaredSha256 !== j.sha256 || row.declaredBytes !== j.bytes || !['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(row.status) || !Number.isSafeInteger(row.version))
        fail('UPLOAD_UNKNOWN'); j.serverId = row.id; j.status = row.status; j.version = row.version; }
    async _request(id) { const { j, who } = this.owned(id); if (!['prepared', 'unknown'].includes(j.state) || j.serverId)
        fail('UPLOAD_STATE'); j.state = 'requesting'; await this.save(); try {
        const r = await this.proxy(j, who, 'POST', '/media/upload-requests', { requestId: j.clientRequestId || j.id, mediaKind: j.mediaKind, fileName: j.fileName, bytes: j.bytes, sha256: j.sha256, visibility: j.visibility, groupId: j.groupId, category: j.category, subcategory: j.subcategory });
        this.applyRequest(j, r);
        j.state = 'ready';
        j.error = null;
    }
    catch {
        j.state = 'unknown';
        j.error = 'UPLOAD_UNKNOWN';
    } await this.save(); return this.view(j); }
    async _refresh(id) { const { j, who } = this.owned(id); if (this.controllers.has(id))
        fail('BUSY', 429); if (!j.serverId)
        return this._request(id); const r = await this.proxy(j, who, 'GET', `/media/upload-requests/${j.serverId}`); this.applyRequest(j, r); if (j.state !== 'unknown' && j.state !== 'completed')
        j.state = r.status === 'CANCELLED' ? 'cancelled' : 'ready'; await this.save(); return this.view(j); }
    receipt(j, r) { if (!plain(r) || !UUID.test(r.audioId || '') || !UUID.test(r.shareId || '') || r.sha256 !== j.sha256 || r.bytes !== j.bytes)
        fail('UPLOAD_UNKNOWN'); return { audioId: r.audioId, shareId: r.shareId, sha256: r.sha256, bytes: r.bytes }; }
    async _reconcile(id) { const { j, who } = this.owned(id); if (!j.serverId || this.controllers.has(id))
        fail('UPLOAD_STATE'); try {
        const r = await this.proxy(j, who, 'GET', `/media/upload-requests/${j.serverId}?includeTransfer=true`);
        if (!plain(r.transfer) || !['COMMITTED', 'NOT_COMMITTED'].includes(r.transfer.commitState))
            fail('RECOVERY_UNAVAILABLE');
        this.applyRequest(j, r.request);
        if (r.transfer.commitState === 'COMMITTED') {
            j.receipt = this.receipt(j, r.transfer.receipt);
            j.state = 'completed';
        }
        else {
            j.state = j.status === 'CANCELLED' ? 'cancelled' : 'ready';
        }
        j.error = null;
        await this.save();
        if (['completed', 'cancelled'].includes(j.state) && (!j.batchBinding || j.batchReceiptRecorded))
            await this.removeSnapshot(j);
        return this.view(j);
    }
    catch {
        j.state = 'unknown';
        j.error = 'RECOVERY_UNAVAILABLE';
        await this.save();
        return this.view(j);
    } }
    async _upload(id) {
        const { j, who } = this.owned(id);
        if (j.settledCleanup || (j.privateRootKey&&j.privateRootKey!==this.dirKey))fail('UPLOAD_STATE');
        if (j.state !== 'ready' || j.status !== 'APPROVED' || this.busy || this.controllers.size)
            fail('UPLOAD_STATE');
        this.busy = true;
        const controller = new AbortController();
        this.controllers.set(id, controller);
        const deadlineTimer = setTimeout(() => controller.abort(), 300000);
        let f;
        try {
            if (!Number.isSafeInteger(j.createdAt) || Date.now() - j.createdAt > 86400000)
                fail('SOURCE_CHANGED');
            await this.verifySource(j);
            this.check(who);
            if (j.payloadReleased === true) await this._rebuildBatchPayload(j, who);
            await this.dirGuard();
            f = await fs.open(path.join(this.dir, `payload-${j.id}`), constants.O_RDONLY | constants.O_NOFOLLOW);
            if ((await f.stat()).size !== j.bytes)
                fail('SOURCE_CHANGED');
            const digest = await hashHandle(f);
            if (digest !== j.sha256)
                fail('SOURCE_CHANGED');
            j.state = 'uploading';
            j.error = null;
            await this.save();
            let sent = 0;
            const validate = new Transform({ transform: (chunk, encoding, cb) => { sent += chunk.length; try {
                    this.check(who);
                }
                catch (e) {
                    cb(e);
                    return;
                } if (sent === j.bytes)
                    this.verifySource(j).then(() => cb(null, chunk), cb);
                else
                    cb(null, chunk); } });
            const source = f.createReadStream({ autoClose: true, start: 0 });
            source.on('error', e => validate.destroy(e));
            source.pipe(validate);
            try {
                const r = await this.auth.uploadAudioContent(j.serverId, { source: validate, bytes: j.bytes, epoch: who.epoch, signal: controller.signal });
                this.check(who);
                j.receipt = this.receipt(j, r);
                j.state = 'completed';
                await this.save();
                if (!j.batchBinding || j.batchReceiptRecorded) await this.removeSnapshot(j);
            }
            finally {
                await Promise.all([closeUploadStream(source),closeUploadStream(validate)]);
            }
        }
        catch (e) {
            if (e?.status === 401)
                await this.auth.forgetSession?.(e.toPublic?.(), { epoch: who.epoch });
            j.state = j.state === 'uploading' ? 'unknown' : 'failed';
            j.error = e?.code === 'SOURCE_CHANGED' ? 'SOURCE_CHANGED' : 'UPLOAD_UNKNOWN';
            await this.save();
        }
        finally {
            clearTimeout(deadlineTimer);
            await f?.close();
            this.controllers.delete(id);
            this.busy = false;
        }
        return this.view(j);
    }
    async _cancel(id) {
        const { j, who } = this.owned(id);
        const control = this.controllers.get(id);
        control?.abort();
        if (control)
            return this.view(j);
        if (j.state === 'unknown' && j.serverId) {
            await this._reconcile(id);
            if (j.state === 'unknown')
                fail('RECOVERY_UNAVAILABLE');
        }
        if (j.receipt || j.state === 'completed')
            fail('UPLOAD_ALREADY_COMMITTED');
        if (!j.serverId) {
            if (j.state === 'unknown')
                fail('UPLOAD_UNKNOWN');
            j.state = 'cancelled';
            await this.save();
            await this.removeSnapshot(j);
            return this.view(j);
        }
        try {
            const r = await this.proxy(j, who, 'POST', `/media/upload-requests/${j.serverId}/cancel`, { expectedVersion: j.version });
            this.applyRequest(j, r);
            j.state = 'cancelled';
            j.error = null;
            await this.save();
            await this.removeSnapshot(j);
        }
        catch (e) {
            if (e?.code === 'UPLOAD_ALREADY_COMMITTED')
                fail('UPLOAD_ALREADY_COMMITTED');
            j.state = 'unknown';
            j.error = 'UPLOAD_UNKNOWN';
            await this.save();
        }
        return this.view(j);
    }
    async _forget(id) { const { j } = this.owned(id); if ((j.batchBinding && !j.batchReceiptRecorded) || !['completed', 'cancelled'].includes(j.state))
        fail('UPLOAD_STATE'); await this.removeSnapshot(j); this.jobs = this.jobs.filter(v => v !== j); await this.save(); return { removed: true }; }
    async action(id, method) {
        if(this.disposing)fail('UPLOAD_STATE');
        if (!['request', 'refresh', 'reconcile', 'upload', 'cancel', 'forget'].includes(method))
            fail('INVALID_REQUEST', 400);
        const { who, j } = this.owned(id);
        if(j.settledCleanup&&['request','upload','cancel','forget'].includes(method))fail('UPLOAD_STATE');
        if (this.operations.has(id)) {
            if (method === 'cancel' && this.controllers.has(id)) {
                this.controllers.get(id).abort();
                return this.view(j);
            }
            fail('BUSY', 429);
        }
        this.operations.add(id);
        try {
            const result = await this['_' + method](id);
            this.check(who);
            return result;
        }
        finally {
            this.operations.delete(id);
        }
    }
    // Internal UQ-01 adaptation: never registered as a browser route and never creates an HTTP request.
    lookupByClientRequestId(clientRequestId) {
        batchId(clientRequestId);
        const who=this.guard();
        const j=this.jobs.find(row=>(row.clientRequestId||row.id)===clientRequestId&&row.owner===who.owner);
        return j?this.view(j):null;
    }
    async inspectForBatch(assetId,{budget,signal}={}) {
        if(budget!==undefined&&!isPreviewReadBudget(budget)||signal!==undefined&&!(signal instanceof AbortSignal))fail('INVALID_REQUEST',400);
        if(this.disposing)fail('UPLOAD_STATE');batchId(assetId);const who=this.guard(),operationId=`inspection:${crypto.randomUUID()}`,controller=new AbortController(),record={handle:null,unknown:false};
        const abort=()=>controller.abort();if(signal?.aborted)controller.abort();signal?.addEventListener('abort',abort,{once:true});
        this.operations.add(operationId);this.controllers.set(operationId,controller);this.inspections.set(operationId,record);
        const check=()=>{if(controller.signal.aborted||this.disposing)fail('PREVIEW_CANCELLED',409);this.check(who);budget?.check();};
        try{
            check();const src=await this.source({assetId},check,{readOnly:true});check();
            const sourceVersion={rootIdentity:src.rootKey,dev:src.stat.dev,ino:src.stat.ino,size:src.stat.size,mtimeMs:src.stat.mtimeMs,ctimeMs:src.stat.ctimeMs};batchSourceVersion(sourceVersion);
            if(src.stat.size<1||src.stat.size>MAX||!/^.+\.(wav|mp3|flac|ogg|m4a|aif|aiff|opus)$/i.test(path.basename(src.p)))fail('INVALID_REQUEST',400);
            record.handle=await fs.open(src.p,constants.O_RDONLY|constants.O_NOFOLLOW);let sha256;
            try{check();const before=await record.handle.stat();check();if(statKey(before)!==statKey(src.stat))fail('SOURCE_CHANGED');sha256=await hashHandle(record.handle,{check,budget,size:src.stat.size});check();const after=await record.handle.stat();check();if(statKey(after)!==statKey(src.stat))fail('SOURCE_CHANGED');}
            finally{try{await record.handle.close();record.handle=null;}catch{record.unknown=true;fail('SOURCE_CHANGED');}check();}
            const current=await this.source({assetId},check,{readOnly:true});check();
            if(current.rootKey!==src.rootKey||statKey(current.stat)!==statKey(src.stat))fail('SOURCE_CHANGED');
            return {assetId,rootId:src.a.root_id,sourceVersion,sha256,declaredBytes:src.stat.size,mediaKind:src.a.kind==='music'?'MUSIC':'SFX',fileName:path.basename(src.p),category:src.a.category||'',subcategory:src.a.sub||''};
        }catch(error){if(error instanceof CloudUploadError)throw error;if(['PREVIEW_BUDGET_EXCEEDED','PREVIEW_CANCELLED','INVALID_REQUEST'].includes(error?.code))throw new CloudUploadError(error.code,error.status??409);throw new CloudUploadError('SOURCE_CHANGED',409);}
        finally{signal?.removeEventListener('abort',abort);if(!record.unknown){this.inspections.delete(operationId);this.controllers.delete(operationId);this.operations.delete(operationId);}}
    }
    async prepareWithIdentity(ids, sourceVersion, confirmedMetadata) {
        if(this.disposing)fail('UPLOAD_STATE');
        if(!plain(ids)||Object.keys(ids).some(k=>!['intentId','clientRequestId'].includes(k)))fail('INVALID_REQUEST');
        batchId(ids.intentId);batchId(ids.clientRequestId);batchSourceVersion(sourceVersion);
        const who=this.guard(),meta=confirmedMetadata;
        if(!plain(meta)||Object.keys(meta).some(k=>!['assetId','mediaKind','fileName','category','subcategory','visibility','groupId','bytes','sha256'].includes(k)))fail('INVALID_REQUEST');
        if(!['MUSIC','SFX'].includes(meta.mediaKind)||!['PRIVATE','GROUP'].includes(meta.visibility)||!segment(meta.category,60,true)||!segment(meta.subcategory,60,true)||(!meta.category&&meta.subcategory)||(meta.visibility==='GROUP'&&!UUID.test(meta.groupId||''))||(meta.visibility==='PRIVATE'&&meta.groupId!==null))fail('INVALID_REQUEST');
        validateCategories(meta.category,meta.subcategory);validateFileName(meta.fileName);
        if(!HASH.test(meta.sha256||''))fail('INVALID_REQUEST');
        const binding=batchFingerprint({ids,sourceVersion,metadata:meta});
        const old=this.jobs.find(j=>j.id===ids.intentId||(j.clientRequestId||j.id)===ids.clientRequestId);
        if(old){if(old.owner!==who.owner)fail('NOT_FOUND',404);if(old.id!==ids.intentId||old.clientRequestId!==ids.clientRequestId||old.batchBinding!==binding||old.settledCleanup||this.busy||this.operations.has(old.id)||this.controllers.has(old.id)||(old.privateRootKey&&old.privateRootKey!==this.dirKey))fail('UPLOAD_STATE');this.operations.add(old.id);try{await this.verifySource(old);this.check(who);await this.save();this.check(who);return this.view(old);}finally{this.operations.delete(old.id);}}
        if(this.busy||this.jobs.length>=50)fail('UPLOAD_LIMIT',429);
        this.busy=true;
        try {
            const inspected=await this.inspectForBatch(meta.assetId);this.check(who);
            if(batchCanonical(inspected.sourceVersion)!==batchCanonical(sourceVersion)||inspected.fileName!==meta.fileName||inspected.mediaKind!==meta.mediaKind||inspected.declaredBytes!==meta.bytes||inspected.sha256!==meta.sha256)fail('SOURCE_CHANGED');
            const j={id:ids.intentId,clientRequestId:ids.clientRequestId,createdAt:Date.now(),owner:who.owner,assetId:meta.assetId,mediaKind:meta.mediaKind,visibility:meta.visibility,groupId:meta.groupId,category:meta.category,subcategory:meta.subcategory,fileName:meta.fileName,bytes:inspected.declaredBytes,sha256:inspected.sha256,rootKey:sourceVersion.rootIdentity,sourceKey:`${sourceVersion.dev}:${sourceVersion.ino}:${sourceVersion.size}:${sourceVersion.mtimeMs}:${sourceVersion.ctimeMs}`,state:'prepared',serverId:null,status:null,version:null,receipt:null,error:null,batchBinding:binding,payloadReleased:true};
            await this.dirGuard();this.check(who);
            try{await fs.lstat(path.join(this.dir,`payload-${j.id}`));fail('PAYLOAD_OWNERSHIP_UNKNOWN');}catch(e){if(e.code!=='ENOENT')throw e;}
            await this.dirGuard();this.check(who);
            j.privateRootKey=this.dirKey;j.payloadOwnership={version:1,state:'ABSENT',rootKey:this.dirKey,generationId:crypto.randomUUID()};
            this.jobs.push(j);await this.save();this.check(who);return this.view(j);
        } finally {this.busy=false;}
    }
    async releasePayloadForApproval(intentId) {
        if(this.disposing)fail('UPLOAD_STATE');
        const {j,who}=this.owned(intentId);
        if(!j.batchBinding||j.status!=='PENDING'||this.controllers.has(intentId)||this.operations.has(intentId)||this.busy)fail('UPLOAD_STATE');
        this.operations.add(intentId);
        try {await this.removeSnapshot(j);this.check(who);j.payloadReleased=true;await this.save();return this.view(j);}
        finally {this.operations.delete(intentId);}
    }
    async _rebuildBatchPayload(j,who) {
        if(!j.batchBinding||j.settledCleanup||(j.privateRootKey&&j.privateRootKey!==this.dirKey)||j.state!=='ready'||j.status!=='APPROVED')fail('UPLOAD_STATE');
        await this.verifySource(j);this.check(who);await this.dirGuard();
        const deadline=Date.now()+120000;
        const destination=path.join(this.dir,`payload-${j.id}`),src=await this.source(j);let input,out,created=false;
        // A crash after snapshot fsync but before JSON commit leaves a reusable private file.
        let existing;
        try{existing=await fs.open(destination,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(e){if(e.code!=='ENOENT')fail('UPLOAD_STORAGE',503);}
        if(existing){try{const before=await existing.stat();if(j.payloadOwnership)this._registeredPayload(j.payloadOwnership,before,j.bytes);if(!before.isFile()||(before.mode&0o077)||before.nlink!==1||before.size!==j.bytes||await hashHandle(existing)!==j.sha256||statKey(await existing.stat())!==statKey(before))fail('UPLOAD_STORAGE',503);await this.verifySource(j);this.check(who);if(j.payloadOwnership)j.payloadOwnership={...j.payloadOwnership,state:'OWNED',fileIdentity:fileIdentity(before)};j.payloadReleased=false;await this.save();return;}finally{await existing.close();}}
        let usage=0;
        let entries=0;const present=new Map();for(const name of await fs.readdir(this.dir)){if(++entries>256)fail('UPLOAD_LIMIT',429);const s=await fs.lstat(path.join(this.dir,name));const bytes=s.isFile()&&!s.isSymbolicLink()?s.size:BUDGET;usage+=bytes;present.set(name,bytes);}for(const held of this.jobs)if(held.settledCleanup)usage+=Math.max(0,(held.settledCleanup.heldBytes||0)-(present.get(`payload-${held.id}`)||0));
        if(usage+j.bytes>BUDGET)fail('UPLOAD_LIMIT',429);
        try {
            input=await fs.open(src.p,constants.O_RDONLY|constants.O_NOFOLLOW);
            if(statKey(await input.stat())!==j.sourceKey||src.rootKey!==j.rootKey)fail('SOURCE_CHANGED');
            j.privateRootKey??=this.dirKey;
            j.payloadOwnership={version:1,state:'INTENDING',rootKey:this.dirKey,generationId:crypto.randomUUID()};await this.save();this.check(who);await this.dirGuard();
            out=await fs.open(destination,'wx',0o600);created=true;
            j.payloadOwnership={...j.payloadOwnership,state:'CREATING',fileIdentity:fileIdentity(await out.stat())};await this.save();this.check(who);await this.dirGuard();
            const buffer=Buffer.alloc(65536),hash=crypto.createHash('sha256');let position=0;
            for(;;){if(Date.now()>deadline)fail('UPLOAD_TIMEOUT',408);const {bytesRead:n}=await input.read(buffer,0,buffer.length,position);if(!n)break;this.check(who);position+=n;if(position>j.bytes)fail('SOURCE_CHANGED');hash.update(buffer.subarray(0,n));let at=0;while(at<n){const r=await out.write(buffer,at,n-at);if(!Number.isInteger(r.bytesWritten)||r.bytesWritten<1||r.bytesWritten>n-at)fail('UPLOAD_STORAGE');at+=r.bytesWritten;}}
            if(position!==j.bytes||hash.digest('hex')!==j.sha256||statKey(await input.stat())!==j.sourceKey)fail('SOURCE_CHANGED');
            await out.sync();await this.verifySource(j);this.check(who);j.payloadOwnership={...j.payloadOwnership,state:'OWNED',fileIdentity:fileIdentity(await out.stat())};j.payloadReleased=false;await this.save();created=false;
        } finally {await input?.close();await out?.close();/* Failed/ambiguous creations are retained for registered recovery, never path-cleaned here. */}
    }
    async rebuildPayload(intentId) {
        if(this.disposing)fail('UPLOAD_STATE');
        const {j,who}=this.owned(intentId);if(this.busy||this.controllers.has(intentId)||this.operations.has(intentId))fail('UPLOAD_STATE');
        this.busy=true;try{if(j.payloadReleased===true)await this._rebuildBatchPayload(j,who);else await this.verifySource(j);return this.view(j);}finally{this.busy=false;}
    }
    _scopeForSettled(value) {
        if(!exactKeys(value,['identity','batchId','itemId','localAttemptId','intentId','clientRequestId','metadataFingerprint']))fail('SETTLED_BINDING_INVALID');
        batchIdentity(value.identity);for(const k of ['batchId','itemId','localAttemptId','intentId','clientRequestId'])batchId(value[k]);
        if(!HASH.test(value.metadataFingerprint||''))fail('SETTLED_BINDING_INVALID');
        return cloneBatch(value);
    }
    async acceptBatchRequest(intentId,row) {
        if(this.disposing)fail('UPLOAD_STATE');
        const {j,who}=this.owned(intentId);
        if(!j.batchBinding||j.settledCleanup||j.receipt||this.busy||this.controllers.size||this.operations.size)fail('UPLOAD_STATE');
        this.operations.add(intentId);
        try{await this.dirGuard();this.check(who);this.applyRequest(j,row);j.state=row.status==='CANCELLED'?'cancelled':'ready';await this.save();this.check(who);return this.view(j);}finally{this.operations.delete(intentId);}
    }
    async registeredResources() {
        this.guard();await this.dirGuard();
        const ids=new Set(this.jobs.map(j=>j.id)),present=new Map(),held=new Map(),encoded=new Map();
        const include=j=>{batchId(j.id);encoded.set(j.id,Math.max(encoded.get(j.id)||0,Buffer.byteLength(JSON.stringify(j))));if(j.settledCleanup){if(j.settledCleanup.version!==1||!Number.isSafeInteger(j.settledCleanup.heldBytes)||j.settledCleanup.heldBytes<0||j.settledCleanup.heldBytes>MAX)fail('RESOURCE_STATE_UNKNOWN');held.set(j.id,Math.max(held.get(j.id)||0,j.settledCleanup.heldBytes));}};
        for(const j of this.jobs)include(j);let intentBytes=Buffer.byteLength(JSON.stringify(this.jobs)),snapshotBytes=0,count=0;
        const entries=await fs.opendir(this.dir);
        for await(const entry of entries){
            if(++count>256)fail('RESOURCE_STATE_UNKNOWN');
            if(entry.name!=='intents.json'&&!/^payload-[a-f0-9-]{36}$/.test(entry.name)&&!/^\.intent-[a-f0-9-]{36}$/.test(entry.name))fail('RESOURCE_STATE_UNKNOWN');
            const file=path.join(this.dir,entry.name),stat=await fs.lstat(file);await this.dirGuard();
            if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o077)||!Number.isSafeInteger(stat.size))fail('RESOURCE_STATE_UNKNOWN');
            if(entry.name==='intents.json'){
                if(stat.size>262144)fail('RESOURCE_STATE_UNKNOWN');
                const h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
                try{const before=await h.stat();if(batchCanonical(fileIdentity(before))!==batchCanonical(fileIdentity(stat)))fail('RESOURCE_STATE_UNKNOWN');const rows=JSON.parse(await h.readFile('utf8'));if(!Array.isArray(rows)||rows.length>50)fail('RESOURCE_STATE_UNKNOWN');for(const row of rows){include(row);ids.add(row.id);}if(batchCanonical(fileIdentity(await h.stat()))!==batchCanonical(fileIdentity(before))||batchCanonical(fileIdentity(await fs.lstat(file)))!==batchCanonical(fileIdentity(before)))fail('RESOURCE_STATE_UNKNOWN');intentBytes=Math.max(intentBytes,stat.size);}finally{await h.close();}
            }else{snapshotBytes+=stat.size;present.set(entry.name,stat.size);}
        }
        for(const [id,bytes] of held)snapshotBytes+=Math.max(0,bytes-(present.get(`payload-${id}`)||0));
        intentBytes=Math.max(intentBytes,2+Math.max(0,encoded.size-1)+[...encoded.values()].reduce((n,b)=>n+b,0));
        await this.dirGuard();return{known:true,activeIntents:ids.size,intentBytes,snapshotBytes};
    }
    async proofForReuse(intentId,challenge,attemptId) {
        if(this.disposing)fail('UPLOAD_STATE');batchId(attemptId);
        const {j,who}=this.owned(intentId);
        if(this.busy||this.controllers.size||this.operations.size||j.settledCleanup||j.state!=='ready'||j.status!=='APPROVED')fail('UPLOAD_STATE');
        if(!plain(challenge)||challenge.state!=='CHALLENGE'||!UUID.test(challenge.challengeId||'')||!HASH.test(challenge.nonce||'')||!Array.isArray(challenge.ranges)||challenge.ranges.length<1||challenge.ranges.length>4||challenge.requestVersion!==j.version)fail('REUSE_PROOF_INVALID');
        const expires=Date.parse(challenge.expiresAt);if(!Number.isSafeInteger(expires)||expires<=Date.now())fail('REUSE_PROOF_INVALID');
        for(const key of ['requestVersion','qualificationVersion','admissionEpoch','storageGeneration'])if(!Number.isSafeInteger(challenge[key])||challenge[key]<0)fail('REUSE_PROOF_INVALID');
        let end=-1;for(const range of challenge.ranges){if(!Number.isSafeInteger(range.offset)||range.offset<0||range.offset<end||!Number.isSafeInteger(range.length)||range.length<1||range.length>65536||range.offset>j.bytes-range.length)fail('REUSE_PROOF_INVALID');end=range.offset+range.length;}
        this.busy=true;this.operations.add(intentId);let file;
        try{
            await this.verifySource(j);this.check(who);if(j.payloadReleased)await this._rebuildBatchPayload(j,who);await this.dirGuard();this.check(who);
            file=await fs.open(path.join(this.dir,`payload-${j.id}`),constants.O_RDONLY|constants.O_NOFOLLOW);const before=await file.stat();this._registeredPayload(j.payloadOwnership,before,j.bytes);
            if(await hashHandle(file)!==j.sha256)fail('SOURCE_CHANGED');this.check(who);
            const parts=[],u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;},i64=n=>{const b=Buffer.alloc(8);b.writeBigInt64BE(BigInt(n));return b;},state=this.auth.getState();
            for(const value of ['sg-reuse-v2',challenge.challengeId,state.accountId,state.deviceId,j.serverId,attemptId,challenge.nonce]){const b=Buffer.from(value,'utf8');parts.push(u32(b.length),b);}
            for(const n of [challenge.requestVersion,challenge.qualificationVersion,challenge.admissionEpoch,challenge.storageGeneration,expires])parts.push(i64(n));parts.push(u32(challenge.ranges.length));
            for(const range of challenge.ranges){const b=Buffer.alloc(range.length);let n=0;while(n<b.length){const read=await file.read(b,n,b.length-n,range.offset+n);this.check(who);if(!read.bytesRead)fail('SOURCE_CHANGED');n+=read.bytesRead;}parts.push(i64(range.offset),u32(range.length),b);}
            await this.verifySource(j);this.check(who);await this.dirGuard();this._registeredPayload(j.payloadOwnership,await file.stat(),j.bytes);if(batchCanonical(fileIdentity(await file.stat()))!==batchCanonical(fileIdentity(before)))fail('SOURCE_CHANGED');
            return crypto.createHash('sha256').update(Buffer.concat(parts)).digest('hex');
        }finally{try{await file?.close();}finally{this.operations.delete(intentId);this.busy=false;}}
    }
    async bindSettledContext(ids,context) {
        if(this.disposing)fail('UPLOAD_STATE');batchId(ids.intentId);batchId(ids.clientRequestId);
        const {j,who}=this.owned(ids.intentId),scope=this._scopeForSettled({...context,intentId:ids.intentId,clientRequestId:ids.clientRequestId});
        const auth=this.auth.getState();
        const confirmed={mediaKind:j.mediaKind,fileName:j.fileName,category:j.category,subcategory:j.subcategory,visibility:j.visibility,groupId:j.groupId,bytes:j.bytes};
        if(scope.metadataFingerprint!==batchFingerprint(confirmed))fail('SETTLED_BINDING_INVALID');
        if(scope.identity.accountId!==auth.accountId||scope.identity.deviceId!==auth.deviceId||scope.identity.epoch!==who.epoch||j.clientRequestId!==ids.clientRequestId||!j.batchBinding||j.settledCleanup||j.receipt||j.batchReceiptRecorded)fail('SETTLED_BINDING_INVALID');
        if(j.settledBinding&&batchCanonical(j.settledBinding)!==batchCanonical(scope))fail('SETTLED_BINDING_INVALID');
        if(this.busy||this.controllers.has(j.id)||this.operations.has(j.id))fail('UPLOAD_STATE');
        if(j.settledBinding)return this.view(j);
        this.operations.add(j.id);
        try{await this.dirGuard();this.check(who);j.settledBinding=scope;await this.save();this.check(who);return this.view(j);}finally{this.operations.delete(j.id);}
    }
    _registeredPayload(record,stat,bytes) {
        if(!record||record.version!==1||!['OWNED','CREATING'].includes(record.state)||!record.fileIdentity)fail('PAYLOAD_OWNERSHIP_UNKNOWN');
        const expected=record.fileIdentity;
        if(!stat.isFile()||stat.isSymbolicLink?.()||stat.nlink!==1||(stat.mode&0o077)||stat.size!==bytes||stat.dev!==expected.dev||stat.ino!==expected.ino||stat.birthtimeMs!==expected.birthtimeMs)fail('PAYLOAD_CHANGED');
        if(record.state==='OWNED'&&batchCanonical(fileIdentity(stat))!==batchCanonical(expected))fail('PAYLOAD_CHANGED');
    }
    _settledEnvelope(value) {
        const keys=['version','identity','batchId','itemId','localAttemptId','intentId','clientRequestId','serverRequestId','serverAttemptId','stateVersion','admissionEpoch','sha256','bytes','metadataFingerprint','sourceVersion','intentBinding','terminalEvidence','localExit','ownership'];
        if(!exactKeys(value,keys)||value.version!==1)fail('SETTLED_BINDING_INVALID');
        const scope=this._scopeForSettled({identity:value.identity,batchId:value.batchId,itemId:value.itemId,localAttemptId:value.localAttemptId,intentId:value.intentId,clientRequestId:value.clientRequestId,metadataFingerprint:value.metadataFingerprint});
        batchId(value.serverRequestId);batchId(value.serverAttemptId);batchSourceVersion(value.sourceVersion);
        if(!Number.isSafeInteger(value.stateVersion)||value.stateVersion<0||!Number.isSafeInteger(value.admissionEpoch)||value.admissionEpoch<0)fail('SETTLED_BINDING_INVALID');
        if(!HASH.test(value.sha256||'')||!HASH.test(value.intentBinding||'')||!Number.isSafeInteger(value.bytes)||value.bytes<1||value.bytes>MAX)fail('SETTLED_BINDING_INVALID');
        const context={item:{clientRequestId:value.clientRequestId},attempt:{serverRequestId:value.serverRequestId,serverAttemptId:value.serverAttemptId,remoteStateVersion:value.stateVersion,admissionEpoch:value.admissionEpoch}};
        batchTerminationEvidence(value.terminalEvidence,value.identity,context);
        const exit=value.localExit;
        if(!exactKeys(exit,['operationId','kind','settledAt','itemId','localAttemptId','clientRequestId','identityFingerprint'])||!['resolve','cancel'].includes(exit.kind)||exit.itemId!==value.itemId||exit.localAttemptId!==value.localAttemptId||exit.clientRequestId!==value.clientRequestId||exit.identityFingerprint!==batchFingerprint(value.identity)||!Number.isSafeInteger(exit.settledAt)||exit.settledAt<0)fail('SETTLED_BINDING_INVALID');
        batchId(exit.operationId);
        return {evidence:cloneBatch(value),scope};
    }
    _settledDescriptor(j) {
        if(!j.settledBinding||!j.privateRootKey)fail('SETTLED_BINDING_UNKNOWN');
        const payload=j.payloadOwnership;
        if(!payload||payload.version!==1||!['ABSENT','OWNED','CREATING'].includes(payload.state)||payload.rootKey!==j.privateRootKey||(payload.state!=='ABSENT'&&!payload.fileIdentity))fail('PAYLOAD_OWNERSHIP_UNKNOWN');
        return{version:1,intentId:j.id,clientRequestId:j.clientRequestId,intentBinding:j.batchBinding,scope:cloneBatch(j.settledBinding),rootKey:j.privateRootKey,payload:cloneBatch(payload),sha256:j.sha256,bytes:j.bytes};
    }
    async _settledJsonAbsent(intentId,check) {
        const h=await fs.open(path.join(this.dir,'intents.json'),constants.O_RDONLY|constants.O_NOFOLLOW);
        try{check();const st=await h.stat();check();if(!st.isFile()||st.nlink!==1||st.size>262144)fail('UPLOAD_STORAGE',503);const raw=await h.readFile('utf8');check();const rows=JSON.parse(raw);if(!Array.isArray(rows)||rows.length>50||rows.some(j=>j.id===intentId))fail('SETTLED_JSON_NOT_REMOVED');}finally{await h.close();}
        check();
    }
    async _unlinkSettledPayload(destination,expected,check) {
        await this.dirGuard();check();const current=await fs.lstat(destination);check();
        if(!current.isFile()||current.isSymbolicLink()||current.nlink!==1||batchCanonical(fileIdentity(current))!==batchCanonical(fileIdentity(expected)))fail('PAYLOAD_CHANGED');
        await this.dirGuard();check();await fs.unlink(destination);check();
    }
    forgetSettled(ids,evidence,readCommitted,persistOwnership) {
        const task=this._forgetSettled(ids,evidence,readCommitted,persistOwnership);
        this.settledTasks.add(task);task.then(()=>this.settledTasks.delete(task),()=>this.settledTasks.delete(task));return task;
    }
    async _forgetSettled(ids,input,readCommitted,persistOwnership) {
        if(this.disposing)fail('UPLOAD_STATE');
        batchId(ids.intentId);batchId(ids.clientRequestId);
        if(typeof readCommitted!=='function')fail('SETTLED_LEDGER_REQUIRED');
        let {evidence,scope}=this._settledEnvelope(input);
        if(evidence.intentId!==ids.intentId||evidence.clientRequestId!==ids.clientRequestId)fail('SETTLED_BINDING_INVALID');
        const who=this.guard(),auth=this.auth.getState();
        if(auth.accountId!==scope.identity.accountId||auth.deviceId!==scope.identity.deviceId||who.epoch!==scope.identity.epoch)fail('AUTH_CHANGED');
        if(this.busy||this.controllers.size||this.operations.size)fail('UPLOAD_STATE');
        let j=this.jobs.find(row=>row.id===ids.intentId);
        if(j&&(j.owner!==who.owner||j.receipt||j.batchReceiptRecorded||j.state==='completed'))fail('SETTLED_BINDING_INVALID');
        this.operations.add(ids.intentId);
        const check=()=>{
            this.check(who);if(this.disposing||this.busy||this.controllers.size||this.operations.size!==1||!this.operations.has(ids.intentId))fail('UPLOAD_STATE');
            const saved=readCommitted();if(!saved||batchCanonical(saved)!==batchCanonical(evidence))fail('SETTLED_LEDGER_CHANGED');
            const same=this.jobs.find(row=>row.id===ids.intentId);if(same&&same!==j)fail('SETTLED_BINDING_INVALID');
            const state=this.auth.getState();if(state.accountId!==scope.identity.accountId||state.deviceId!==scope.identity.deviceId||this.auth.epoch!==scope.identity.epoch)fail('AUTH_CHANGED');
            if(j&&(j.owner!==who.owner||j.receipt||j.batchReceiptRecorded||j.state==='completed'||j.clientRequestId!==ids.clientRequestId||j.batchBinding!==evidence.intentBinding||batchCanonical(j.settledBinding)!==batchCanonical(scope)||(j.serverId&&j.serverId!==evidence.serverRequestId)))fail('SETTLED_BINDING_INVALID');
        };
        const rootCheck=async()=>{await this.dirGuard();check();const root=evidence.ownership?.rootKey??j?.privateRootKey;if(!root||root!==this.dirKey)fail('SETTLED_ROOT_CHANGED');};
        let file,unlinked=false;
        try{
            check();await rootCheck();
            if(j){
                const descriptor=this._settledDescriptor(j);
                if(j.sha256!==evidence.sha256||j.bytes!==evidence.bytes||j.rootKey!==evidence.sourceVersion.rootIdentity||j.sourceKey!==`${evidence.sourceVersion.dev}:${evidence.sourceVersion.ino}:${evidence.sourceVersion.size}:${evidence.sourceVersion.mtimeMs}:${evidence.sourceVersion.ctimeMs}`)fail('SETTLED_BINDING_INVALID');
                if(evidence.ownership===null){
                    if(typeof persistOwnership!=='function')fail('SETTLED_OWNERSHIP_REQUIRED');
                    const changed=persistOwnership(cloneBatch(descriptor));
                    if(changed?.then)fail('SETTLED_OWNERSHIP_REQUIRED');
                    const next=this._settledEnvelope(readCommitted()).evidence;
                    if(batchCanonical({...next,ownership:null})!==batchCanonical({...evidence,ownership:null})||batchCanonical(next.ownership)!==batchCanonical(descriptor))fail('SETTLED_LEDGER_CHANGED');
                    evidence=next;
                }
                if(batchCanonical(evidence.ownership)!==batchCanonical(descriptor))fail('SETTLED_BINDING_INVALID');
                const seal=batchFingerprint(evidence);
                if(j.settledCleanup&&j.settledCleanup.evidenceFingerprint!==seal)fail('SETTLED_BINDING_INVALID');
                j.settledCleanup={version:1,evidenceFingerprint:seal,heldBytes:descriptor.payload.state==='ABSENT'?0:j.bytes};
                await this.save({validate:check});check();await rootCheck();
            }else{
                const d=evidence.ownership;
                if(!d||!d.payload||d.payload.version!==1||!['ABSENT','OWNED','CREATING'].includes(d.payload.state)||d.payload.rootKey!==d.rootKey||d.version!==1||d.rootKey!==this.dirKey||d.intentId!==ids.intentId||d.clientRequestId!==ids.clientRequestId||d.intentBinding!==evidence.intentBinding||d.sha256!==evidence.sha256||d.bytes!==evidence.bytes||batchCanonical(d.scope)!==batchCanonical(scope))fail('SETTLED_OWNERSHIP_REQUIRED');
            }
            const destination=path.join(this.dir,`payload-${ids.intentId}`),owned=evidence.ownership.payload;
            let stat;
            try{stat=await fs.lstat(destination);check();}catch(error){if(error.code!=='ENOENT')throw error;check();}
            if(stat){
                if(!j)fail('PAYLOAD_REAPPEARED');
                this._registeredPayload(owned,stat,evidence.bytes);await rootCheck();
                file=await fs.open(destination,constants.O_RDONLY|constants.O_NOFOLLOW);check();
                const before=await file.stat();check();this._registeredPayload(owned,before,evidence.bytes);
                const hash=crypto.createHash('sha256'),buffer=Buffer.alloc(65536),deadline=Date.now()+120000;let position=0;
                for(;;){if(Date.now()>deadline)fail('UPLOAD_STORAGE',503);const {bytesRead}=await file.read(buffer,0,buffer.length,position);check();if(!bytesRead)break;position+=bytesRead;if(position>evidence.bytes)fail('PAYLOAD_CHANGED');hash.update(buffer.subarray(0,bytesRead));}
                const after=await file.stat();check();if(position!==evidence.bytes||hash.digest('hex')!==evidence.sha256||batchCanonical(fileIdentity(after))!==batchCanonical(fileIdentity(before)))fail('PAYLOAD_CHANGED');
                await rootCheck();await this._unlinkSettledPayload(destination,after,check);unlinked=true;
                await file.close();file=null;check();await this.syncIntentDirectory();check();await rootCheck();
            }
            if(j){await this.save({omitIntentId:ids.intentId,validate:check});check();await rootCheck();}
            await this._settledJsonAbsent(ids.intentId,check);await rootCheck();
            try{await fs.lstat(destination);fail('PAYLOAD_REAPPEARED');}catch(error){if(error.code!=='ENOENT')throw error;check();}
            return{cleanupComplete:true,durable:true,evidenceFingerprint:batchFingerprint(evidence),intentRemoved:!!j,payloadRemoved:unlinked,payloadBytesReleased:unlinked?evidence.bytes:0};
        }finally{await file?.close();this.operations.delete(ids.intentId);}
    }
    async forgetVerified(ids,receipt,readCommitted) {
        if(this.disposing)fail('UPLOAD_STATE');
        batchId(ids.intentId);batchId(ids.clientRequestId);
        if(typeof readCommitted!=='function')fail('UPLOAD_STATE');
        const stored=readCommitted();if(!plain(stored)||batchCanonical(stored)!==batchCanonical(receipt)||stored.clientRequestId!==ids.clientRequestId||!UUID.test(stored.receiptId||'')||!UUID.test(stored.canonicalRequestId||'')||!['uploaded','reused','already_present','legacy_unrecorded'].includes(stored.mode))fail('UPLOAD_STATE');
        const who=this.guard(),j=this.jobs.find(row=>row.id===ids.intentId);
        if(!j){
            // A prior _forget may have removed RAM state before its final JSON save failed.
            // Persist absence again; empty RAM alone is never durable cleanup confirmation.
            if(this.operations.has(ids.intentId)||this.controllers.has(ids.intentId)||this.busy)fail('UPLOAD_STATE');
            this.operations.add(ids.intentId);
            try{await this.save();this.check(who);return {removed:false};}finally{this.operations.delete(ids.intentId);}
        }
        if(j.owner!==who.owner)fail('NOT_FOUND',404);
        if(!j.batchBinding||j.clientRequestId!==ids.clientRequestId||j.sha256!==stored.sha256||j.bytes!==stored.verifiedBytes||(j.serverId&&j.serverId!==stored.canonicalRequestId))fail('UPLOAD_STATE');
        if(this.operations.has(j.id)||this.controllers.has(j.id)||this.busy)fail('UPLOAD_STATE');
        this.operations.add(j.id);
        try{j.receipt=this.receipt(j,stored);j.state='completed';j.batchReceiptRecorded=true;await this.save();return await this._forget(j.id);}finally{this.operations.delete(j.id);}
    }
    async dispose({timeoutMs=5000}={}) {
        if(!Number.isSafeInteger(timeoutMs)||timeoutMs<0||timeoutMs>30000)fail('INVALID_REQUEST');
        this.disposing=true;for(const controller of this.controllers.values())controller.abort();
        const end=Date.now()+timeoutMs;
        while(this.busy||this.operations.size||this.controllers.size||this.settledTasks.size){if(Date.now()>=end)return{closed:false,unknown:true};await new Promise(r=>setTimeout(r,Math.min(10,end-Date.now())));}
        let timer;const settled=await Promise.race([this.chain.then(()=>true,()=>true),new Promise(r=>{timer=setTimeout(()=>r(false),Math.max(0,end-Date.now()));})]);clearTimeout(timer);
        return{closed:settled,unknown:!settled};
    }
    async removeSnapshot(j) { await this.dirGuard(); await fs.unlink(path.join(this.dir, `payload-${j.id}`)).catch(e => { if (e.code !== 'ENOENT')
        throw new CloudUploadError('UPLOAD_STORAGE', 503); }); }
}

// Admission only, not a queue: preserve the existing two-download bound by making
// one manual upload exclusive with active/queued/starting downloads.
export function manualAudioAdmission(readDownloadStatus) {
    let uploading = false, startingDownloads = 0;
    return {
        async download(work) {
            if (uploading) fail('BUSY', 429);
            startingDownloads++;
            try { return await work(); }
            finally { startingDownloads--; }
        },
        async upload(work) {
            if (uploading || startingDownloads) fail('BUSY', 429);
            uploading = true;
            try {
                const status = await readDownloadStatus();
                if (status.active || status.queued) fail('BUSY', 429);
                return await work();
            } finally { uploading = false; }
        },
    };
}
